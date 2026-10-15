// The production adapter of the `OpencodeClient` port (server/mcp/opencode-client.ts), over a stub
// `fetch`: request shapes, auth, the `wait` long-poll contract, message pagination and the
// guarantee that no error message ever carries a response body (`GET /api/config` returns the IU
// key in plaintext and a message can echo anything a worker printed).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOpencodeClient,
  getRetryDelayMs,
  OpencodeHttpError,
} from "../server/mcp/opencode-client.ts";
import {
  ensureServerState,
  opencodeServerUrl,
  readServerPassword,
} from "../server/mcp/opencode-server.ts";
import { isRetryableSessionError } from "../server/mcp/session-runner.ts";

const savedDir = process.env.AGENT_GATEWAY_OPENCODE_STATE_DIR;
beforeEach(() => {
  process.env.AGENT_GATEWAY_OPENCODE_STATE_DIR = mkdtempSync(join(tmpdir(), "oc-client-"));
  ensureServerState();
});
afterEach(() => {
  process.env.AGENT_GATEWAY_OPENCODE_STATE_DIR = savedDir;
});

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

function stub(responder: (seen: Seen, index: number) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const entry: Seen = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      signal: init?.signal ?? undefined,
    };
    seen.push(entry);
    return responder(entry, seen.length - 1);
  }) as unknown as typeof fetch;
  // The retry pause is recorded, never slept: no test waits on a real backoff.
  const delays: number[] = [];
  const sleep = async (ms: number) => {
    delays.push(ms);
  };
  return { seen, delays, client: createOpencodeClient(fetchImpl, { sleep, random: () => 0.5 }) };
}

const ok = (body: unknown = {}) => Response.json(body);
const path = (seen: Seen) => seen.url.slice(opencodeServerUrl().length);
const msg = (id: string, type = "assistant") => ({ id, type });

describe("auth and routing", () => {
  test("every request carries Basic opencode:<password> against the shared server's URL", async () => {
    const { seen, client } = stub(() => ok({ data: { id: "ses_1" } }));
    await client.createSession({
      directory: "/repo",
      model: { providerID: "iu-chat", id: "m" },
      agent: "agw-readonly",
    });
    expect(seen[0]?.url).toBe(`${opencodeServerUrl()}/api/session`);
    expect(seen[0]?.headers.authorization).toBe(
      `Basic ${btoa(`opencode:${readServerPassword()}`)}`,
    );
  });
});

describe("createSession", () => {
  test("POSTs location, model (with variant), agent, title and metadata; returns the id", async () => {
    const { seen, client } = stub(() => ok({ data: { id: "ses_new" } }));
    const id = await client.createSession({
      directory: "/repo",
      model: { providerID: "iu-chat", id: "deepseek-v4.1-flash", variant: "high" },
      agent: "agw-implement",
      title: "agw dispatch",
      metadata: { agw: { jobId: "job-1", tool: "dispatch" } },
    });
    expect(id).toBe("ses_new");
    expect(seen[0]).toMatchObject({ method: "POST" });
    expect(seen[0]?.headers["content-type"]).toBe("application/json");
    expect(seen[0]?.body).toEqual({
      location: { directory: "/repo" },
      model: { providerID: "iu-chat", id: "deepseek-v4.1-flash", variant: "high" },
      agent: "agw-implement",
      title: "agw dispatch",
      metadata: { agw: { jobId: "job-1", tool: "dispatch" } },
    });
  });

  test("title and metadata are omitted when not given", async () => {
    const { seen, client } = stub(() => ok({ data: { id: "ses_new" } }));
    await client.createSession({
      directory: "/repo",
      model: { providerID: "iu-chat", id: "m" },
      agent: "agw-readonly",
    });
    expect(Object.keys(seen[0]?.body as object).toSorted()).toEqual(["agent", "location", "model"]);
  });

  test("an empty session id is an unexpected body, not a session", async () => {
    const { client } = stub(() => ok({ data: { id: "" } }));
    await expect(
      client.createSession({ directory: "/r", model: { providerID: "p", id: "m" }, agent: "a" }),
    ).rejects.toThrow(/unexpected body/);
  });
});

describe("setEnvironment and prompt", () => {
  test("PUT …/environment with {variables}; the session id is URL-encoded", async () => {
    const { seen, client } = stub(() => new Response(null, { status: 204 }));
    await client.setEnvironment("ses_a/b", { IU_KEY: "", GIT_ASKPASS: "/usr/bin/false" });
    expect(seen[0]?.method).toBe("PUT");
    expect(path(seen[0] as Seen)).toBe("/api/session/ses_a%2Fb/environment");
    expect(seen[0]?.body).toEqual({ variables: { IU_KEY: "", GIT_ASKPASS: "/usr/bin/false" } });
  });

  test("prompt sends only the text by default; resume and delivery only when set", async () => {
    const { seen, client } = stub(() => new Response(null, { status: 204 }));
    await client.prompt("ses_1", { text: "go" });
    await client.prompt("ses_1", { text: "go", resume: true });
    await client.prompt("ses_1", { text: "go", resume: false, delivery: "queue" });
    expect(seen.map((s) => [s.method, path(s)])).toEqual([
      ["POST", "/api/session/ses_1/prompt"],
      ["POST", "/api/session/ses_1/prompt"],
      ["POST", "/api/session/ses_1/prompt"],
    ]);
    expect(seen.map((s) => s.body)).toEqual([
      { text: "go" },
      { text: "go", resume: true },
      { text: "go", delivery: "queue" },
    ]);
  });
});

describe("wait", () => {
  const waitWith = async (status: number) => {
    const { seen, client } = stub(() => new Response(null, { status }));
    const result = client.wait("ses_1", new AbortController().signal);
    return { seen, result };
  };

  test("204 and 200 mean idle", async () => {
    for (const status of [204, 200]) expect(await (await waitWith(status)).result).toBe(true);
  });

  test("503, 5xx, 408, 425 and 429 mean 'not idle, poll again'", async () => {
    for (const status of [503, 500, 408, 425, 429])
      expect(await (await waitWith(status)).result).toBe(false);
  });

  test("404 (lost session), 400, 401 and 403 (rejected password) surface as OpencodeHttpError", async () => {
    for (const status of [404, 400, 401, 403]) {
      const rejection = (await waitWith(status)).result;
      await expect(rejection).rejects.toBeInstanceOf(OpencodeHttpError);
      await expect(rejection).rejects.toMatchObject({ status });
    }
  });

  test("POSTs the experimental wait route and carries the caller's signal without a request timeout", async () => {
    const controller = new AbortController();
    const { seen, client } = stub(() => new Response(null, { status: 204 }));
    await client.wait("ses_1", controller.signal);
    expect(seen[0]?.method).toBe("POST");
    expect(path(seen[0] as Seen)).toBe("/api/experimental/session/ses_1/wait");
    // Only the caller's signal: aborting it aborts the request, nothing else does.
    expect(seen[0]?.signal?.aborted).toBe(false);
    controller.abort();
    expect(seen[0]?.signal?.aborted).toBe(true);
  });

  test("aborting the signal rejects the in-flight wait with the AbortError (not a transport error)", async () => {
    const controller = new AbortController();
    const { client } = stub(
      (seen) =>
        new Promise<Response>((_resolve, reject) => {
          seen.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );
    const pending = client.wait("ses_1", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("messages", () => {
  test("recentMessages asks for the newest N with order=desc", async () => {
    const { seen, client } = stub(() => ok({ data: [msg("m2"), msg("m1")] }));
    const out = await client.recentMessages("ses_1", 5);
    expect(path(seen[0] as Seen)).toBe("/api/session/ses_1/message?order=desc&limit=5");
    expect(seen[0]?.method).toBe("GET");
    expect(out.map((m) => m.id)).toEqual(["m2", "m1"]);
  });

  test("allMessages: asc first page, then cursor=<next>&limit=200 with NO order, until an empty page", async () => {
    // cursor.next is present even on the last page, so only the empty page ends the walk.
    const pages = [
      { data: [msg("m1"), msg("m2")], cursor: { next: "c1" } },
      { data: [msg("m3")], cursor: { next: "c 2/x" } },
      { data: [], cursor: { next: "c3" } },
    ];
    const { seen, client } = stub((_s, i) => ok(pages[i]));
    const out = await client.allMessages("ses_1");
    expect(out.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(seen.map(path)).toEqual([
      "/api/session/ses_1/message?order=asc&limit=200",
      "/api/session/ses_1/message?cursor=c1&limit=200",
      `/api/session/ses_1/message?cursor=${encodeURIComponent("c 2/x")}&limit=200`,
    ]);
    for (const request of seen.slice(1)) expect(request.url).not.toContain("order=");
  });

  test("allMessages stops when cursor.next is absent", async () => {
    const { seen, client } = stub(() => ok({ data: [msg("m1")] }));
    expect((await client.allMessages("ses_1")).map((m) => m.id)).toEqual(["m1"]);
    expect(seen).toHaveLength(1);
  });

  test("allMessages of an empty session is one request and []", async () => {
    const { seen, client } = stub(() => ok({ data: [], cursor: { next: "c0" } }));
    expect(await client.allMessages("ses_1")).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  test("wire fields survive: tokens, cost, content blocks, error and idle outcome", async () => {
    const wire = [
      {
        id: "m1",
        type: "assistant",
        content: [{ type: "text", text: "hi" }],
        finish: "stop",
        cost: 0.5,
        tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
        error: { type: "provider.auth", message: "no", status: 401 },
        retry: { attempt: 1 },
      },
      { id: "m2", type: "idle", outcome: "failed" },
    ];
    const { client } = stub(() => ok({ data: wire }));
    const [assistant, idle] = await client.allMessages("ses_1");
    expect(assistant).toMatchObject({
      cost: 0.5,
      tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
      error: { message: "no", status: 401 },
      retry: { attempt: 1 },
    });
    expect(idle).toMatchObject({ type: "idle", outcome: "failed" });
  });
});

describe("session, active, interrupt", () => {
  test("session() reads the settled cost and outcome", async () => {
    const { seen, client } = stub(() => ok({ data: { cost: 1.5, outcome: "succeeded" } }));
    expect(await client.session("ses_1")).toEqual({ costUsd: 1.5, outcome: "succeeded" });
    expect(path(seen[0] as Seen)).toBe("/api/session/ses_1");
  });

  test("active() lists the session ids with a running turn", async () => {
    const { seen, client } = stub(() => ok({ data: { ses_a: {}, ses_b: {} } }));
    expect(await client.active()).toEqual(["ses_a", "ses_b"]);
    expect(path(seen[0] as Seen)).toBe("/api/session/active");
  });

  test("interrupt() goes through the shared server helper on the same fetch and never throws", async () => {
    const { seen, client } = stub(() => ok({ interrupted: true }));
    expect(await client.interrupt("ses_1")).toEqual({ ok: true, interrupted: true });
    expect(seen[0]?.method).toBe("POST");
    expect(path(seen[0] as Seen)).toBe("/api/session/ses_1/interrupt");
    const down = stub(() => {
      throw new TypeError("fetch failed");
    });
    expect(await down.client.interrupt("ses_1")).toMatchObject({ ok: false, interrupted: false });
  });
});

describe("failures", () => {
  const connectionFailures: Array<[string, Error, string]> = [
    [
      "connection refused",
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
      "ECONNREFUSED",
    ],
    ["other connect error", new TypeError("fetch failed"), "fetch failed"],
    ["request timeout", Object.assign(new Error("t"), { name: "TimeoutError" }), "ETIMEDOUT"],
  ];

  for (const [label, error, token] of connectionFailures) {
    test(`${label}: a plain Error naming ${token}, classified as transport`, async () => {
      const { client } = stub(() => Promise.reject(error));
      const rejection = client.recentMessages("ses_1", 1);
      await expect(rejection).rejects.toThrow(token);
      await expect(rejection).rejects.not.toBeInstanceOf(OpencodeHttpError);
      const thrown = await rejection.catch((e: Error) => e);
      expect(isRetryableSessionError((thrown as Error).message)).toBe(true);
    });
  }

  test("a connection failure on wait (not aborted by the caller) is a transport error too", async () => {
    const { client } = stub(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    await expect(client.wait("ses_1", new AbortController().signal)).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });

  test("an HTTP error names status and route only — never the response body", async () => {
    const secret = "sk-secret-iu-key-in-a-body";
    const { client } = stub(() => new Response(`{"error":"${secret}"}`, { status: 500 }));
    const calls: Array<() => Promise<unknown>> = [
      () =>
        client.createSession({ directory: "/r", model: { providerID: "p", id: "m" }, agent: "a" }),
      () => client.setEnvironment("ses_1", { A: "b" }),
      () => client.prompt("ses_1", { text: "t" }),
      () => client.recentMessages("ses_1", 1),
      () => client.allMessages("ses_1"),
      () => client.session("ses_1"),
      () => client.active(),
    ];
    for (const call of calls) {
      const error = await call().then(
        () => new Error("expected a rejection"),
        (e: Error) => e,
      );
      expect(error).toBeInstanceOf(OpencodeHttpError);
      expect(error.message).not.toContain(secret);
    }
    const http = await client.session("ses_1").catch((e: unknown) => e);
    expect(http).toBeInstanceOf(OpencodeHttpError);
    expect((http as OpencodeHttpError).status).toBe(500);
    expect((http as OpencodeHttpError).message).toBe(
      "opencode server answered HTTP 500 on GET /api/session/{id}",
    );
  });

  test("a 404 on wait carries no body either", async () => {
    const secret = "sk-secret-in-404";
    const { client } = stub(() => new Response(secret, { status: 404 }));
    const error = await client.wait("ses_1", new AbortController().signal).catch((e: Error) => e);
    expect((error as Error).message).not.toContain(secret);
  });

  test("a 200 whose body fails the schema reports 'unexpected body' without echoing it", async () => {
    const secret = "sk-secret-in-a-malformed-body";
    const { client } = stub(() => ok({ data: "not-an-array", leak: secret }));
    const error = await client.recentMessages("ses_1", 1).catch((e: Error) => e);
    expect((error as Error).message).toBe(
      "opencode server answered an unexpected body on GET /api/session/{id}/message",
    );
    expect((error as Error).message).not.toContain(secret);
  });
});

describe("timed-out requests", () => {
  const timeout = () => Object.assign(new Error("timed out"), { name: "TimeoutError" });

  test("a GET that times out is retried and the retry's answer is served", async () => {
    const { seen, delays, client } = stub((_s, i) => {
      if (i === 0) throw timeout();
      return ok({ data: {} });
    });
    expect(await client.active()).toEqual([]);
    expect(seen).toHaveLength(2);
    expect(delays).toEqual([187.5]);
  });

  test("a GET that keeps timing out names the route and elapsed time, after 3 tries", async () => {
    const { seen, delays, client } = stub(() => {
      throw timeout();
    });
    const error = await client.active().catch((e: Error) => e);
    expect(seen).toHaveLength(3);
    // One pause between each pair of tries, none after the last: 250 ms then 1 s ceilings.
    expect(delays).toEqual([187.5, 750]);
    expect((error as Error).message).toMatch(
      /^opencode server unreachable: ETIMEDOUT .* \[GET \/api\/session\/active after \d+ms\]$/,
    );
    expect(isRetryableSessionError((error as Error).message)).toBe(true);
  });

  test("a POST is never repeated", async () => {
    const { seen, delays, client } = stub(() => {
      throw timeout();
    });
    await client.prompt("ses_1", { text: "x" }).catch(() => undefined);
    expect(seen).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  test("a GET failing for another reason is not retried and does not pause", async () => {
    const { seen, delays, client } = stub(() => {
      throw new Error("ECONNREFUSED");
    });
    await client.active().catch(() => undefined);
    expect(seen).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  test("backoff is 250 ms then 1 s ceilings with equal jitter: half fixed, half random", () => {
    expect(getRetryDelayMs(1, () => 0)).toBe(125);
    expect(getRetryDelayMs(1, () => 1)).toBe(250);
    expect(getRetryDelayMs(2, () => 0)).toBe(500);
    expect(getRetryDelayMs(2, () => 1)).toBe(1000);
  });
});
