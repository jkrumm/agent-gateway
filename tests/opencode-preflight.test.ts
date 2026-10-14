// Endpoint preflight for the opencode harness (server/mcp/opencode-runner.ts): a dead IU
// endpoint must fail the attempt in seconds with a transport-class error and NEVER create a
// session (the server retries a dead endpoint forever). The probe is injected, so no test
// here touches the network except the explicit real-socket cases against loopback; the session
// client is the in-memory fake.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  preflightIuEndpoint,
  runOpencodeAttempt,
  type IuPreflight,
} from "../server/mcp/opencode-runner.ts";
import {
  classifyBreakerOutcome,
  isRetryableSessionError,
  planNextAttempt,
} from "../server/mcp/session-runner.ts";
import { routeFor } from "../server/lib/routing.ts";
import type { OpencodeServerStatus } from "../server/mcp/opencode-server.ts";
import { FakeOpencodeClient, text } from "./helpers/fake-opencode-client.ts";

const savedEnv = { key: process.env.IU_API_KEY, base: process.env.IU_BASE_URL };

beforeEach(() => {
  // getIuConfig() caches after first read; either way no keychain access happens here.
  process.env.IU_API_KEY = "test-key";
  process.env.IU_BASE_URL = "https://iu.example.invalid/anthropic";
});

afterEach(() => {
  for (const [name, value] of [
    ["IU_API_KEY", savedEnv.key],
    ["IU_BASE_URL", savedEnv.base],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const serverOk = async (): Promise<OpencodeServerStatus> => ({
  ok: true,
  up: true,
  version: "2.0.25",
  pinned: "2.0.25",
  versionOk: true,
});
const refusedPreflight: IuPreflight = async () => ({ ok: false, reason: "ECONNREFUSED" });
const attemptOpts = () => ({ cwd: "/tmp", prompt: "p", route: routeFor("dispatch") });
const attemptCtx = { model: "deepseek-v4.1-flash", backend: "iu" as const };

describe("runOpencodeAttempt — endpoint preflight", () => {
  test("unreachable endpoint: no session, classified transport failure, returns fast", async () => {
    const client = new FakeOpencodeClient();
    const t0 = performance.now();
    const result = await runOpencodeAttempt(attemptOpts(), { current: 0 }, attemptCtx, {
      preflight: refusedPreflight,
      client,
    });
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(client.callLog).toEqual([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("IU endpoint unreachable before opencode session");
    expect(result.classificationText).toBe(result.error);
    // Not a credentials problem — the breaker must count it.
    expect(result.iuConfigError).toBeUndefined();
    expect(result.backend).toBe("iu");
    expect(isRetryableSessionError(result.error ?? "")).toBe(true);
    expect(classifyBreakerOutcome(result)).toBe("transport");
  });

  test("a preflight failure falls back to Max on the second attempt (existing ladder)", async () => {
    const failed = await runOpencodeAttempt(attemptOpts(), { current: 0 }, attemptCtx, {
      preflight: async () => ({ ok: false, reason: "ETIMEDOUT after 5000ms" }),
      client: new FakeOpencodeClient(),
    });
    const input = {
      result: failed,
      noOutputYet: true,
      usedFallback: false,
      fallback: { backend: "max" as const, model: "claude-haiku-4-5" },
      routeModel: "deepseek-v4.1-flash",
    };
    expect(planNextAttempt({ ...input, attempt: 1 }).kind).toBe("retry");
    expect(planNextAttempt({ ...input, attempt: 2 }).kind).toBe("fallback");
  });

  test("reachable endpoint: a session is created, with the IU base handed to the probe", async () => {
    let probedBase = "";
    let probedTimeout = 0;
    const client = new FakeOpencodeClient().script({
      assistant: [{ content: [text('{"answer":1}')] }],
    });
    const result = await runOpencodeAttempt(attemptOpts(), { current: 0 }, attemptCtx, {
      serverStatus: serverOk,
      password: () => "pw",
      client,
      pollMs: 5,
      preflight: async (base, timeoutMs) => {
        probedBase = base;
        probedTimeout = timeoutMs;
        return { ok: true };
      },
    });
    expect(result.ok).toBe(true);
    expect(client.created).toHaveLength(1);
    expect(probedBase).toEndWith("/openai/v1");
    expect(probedTimeout).toBe(5_000);
  });

  test("AGENT_GATEWAY_OPENCODE_PREFLIGHT_MS overrides the probe budget", async () => {
    process.env.AGENT_GATEWAY_OPENCODE_PREFLIGHT_MS = "1500";
    try {
      let probedTimeout = 0;
      await runOpencodeAttempt(attemptOpts(), { current: 0 }, attemptCtx, {
        preflight: async (_base, timeoutMs) => {
          probedTimeout = timeoutMs;
          return { ok: false, reason: "ECONNREFUSED" };
        },
        client: new FakeOpencodeClient(),
      });
      expect(probedTimeout).toBe(1_500);
    } finally {
      delete process.env.AGENT_GATEWAY_OPENCODE_PREFLIGHT_MS;
    }
  });
});

const down =
  (error: string, over: Partial<OpencodeServerStatus> = {}) =>
  async () => ({
    ok: false,
    up: false,
    version: null,
    pinned: "2.0.25",
    versionOk: false,
    error,
    ...over,
  });

describe("runOpencodeAttempt — shared server check", () => {
  async function attemptAgainst(serverStatus: () => Promise<OpencodeServerStatus>) {
    const client = new FakeOpencodeClient();
    const result = await runOpencodeAttempt(attemptOpts(), { current: 0 }, attemptCtx, {
      preflight: async () => ({ ok: true }),
      serverStatus,
      client,
    });
    return { result, sessions: client.callLog.length };
  }

  test("server down: no session, classified transport failure the breaker counts", async () => {
    const { result, sessions } = await attemptAgainst(
      down("opencode server unreachable: ECONNREFUSED"),
    );
    expect(sessions).toBe(0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("opencode server unavailable before session");
    expect(result.error).toContain("ECONNREFUSED");
    expect(result.classificationText).toBe(result.error);
    expect(result.iuConfigError).toBeUndefined();
    expect(isRetryableSessionError(result.error ?? "")).toBe(true);
    expect(classifyBreakerOutcome(result)).toBe("transport");
  });

  test("version mismatch: no session, and still connection-class so the ladder falls back", async () => {
    const { result, sessions } = await attemptAgainst(
      down("opencode server version 2.0.30 != pinned 2.0.25", {
        up: true,
        version: "2.0.30",
      }),
    );
    expect(sessions).toBe(0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("2.0.30");
    expect(isRetryableSessionError(result.error ?? "")).toBe(true);
  });

  test("the IU preflight runs first: a dead IU endpoint never reaches the server check", async () => {
    let statusCalls = 0;
    const result = await runOpencodeAttempt(attemptOpts(), { current: 0 }, attemptCtx, {
      preflight: refusedPreflight,
      serverStatus: async () => {
        statusCalls++;
        return serverOk();
      },
      client: new FakeOpencodeClient(),
    });
    expect(result.ok).toBe(false);
    expect(statusCalls).toBe(0);
  });
});

describe("preflightIuEndpoint — real loopback sockets", () => {
  test("a 5xx answer counts as unreachable (opencode would retry it forever)", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("down", { status: 503 }),
    });
    try {
      expect(await preflightIuEndpoint(`http://127.0.0.1:${server.port}/openai/v1`, 2_000)).toEqual(
        {
          ok: false,
          reason: "HTTP 503",
        },
      );
    } finally {
      await server.stop(true);
    }
  });

  test("any non-5xx HTTP response (even 404) counts as reachable", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("nope", { status: 404 }),
    });
    try {
      expect(await preflightIuEndpoint(`http://127.0.0.1:${server.port}/openai/v1`, 2_000)).toEqual(
        {
          ok: true,
        },
      );
    } finally {
      await server.stop(true);
    }
  });

  test("a closed port is unreachable within the budget, reason is connection-class", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const port = server.port;
    await server.stop(true);
    const t0 = performance.now();
    const probe = await preflightIuEndpoint(`http://127.0.0.1:${port}/openai/v1`, 2_000);
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(isRetryableSessionError(probe.reason)).toBe(true);
  });

  test("a server that never answers is aborted at the timeout", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      const t0 = performance.now();
      const probe = await preflightIuEndpoint(`http://127.0.0.1:${server.port}/`, 300);
      expect(performance.now() - t0).toBeLessThan(3_000);
      expect(probe.ok).toBe(false);
      if (!probe.ok) expect(probe.reason).toContain("ETIMEDOUT");
    } finally {
      await server.stop(true);
    }
  });
});
