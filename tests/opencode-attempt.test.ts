// `runOpencodeAttempt` end to end over the in-memory `FakeOpencodeClient`: the session it creates,
// the environment it applies, and the verdict it derives from the message records. The seams keep
// the existing style — fake `preflight`, `serverStatus` and `password`; the HTTP client is the
// port's test adapter, so no network and no real server. Attribution rows are read back from
// `AGENT_GATEWAY_SESSIONS_LOG`, pointed at a fresh file per test.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_DENY_CREDENTIALS_ENV } from "../server/jobs/handlers/dispatch-git.ts";
import { getIuConfig } from "../server/lib/iu-openai.ts";
import { routeFor } from "../server/lib/routing.ts";
import { runOpencodeAttempt, type OpencodeAttemptDeps } from "../server/mcp/opencode-runner.ts";
import {
  OPENCODE_SESSION_BLANKED_ENV,
  type OpencodeServerStatus,
} from "../server/mcp/opencode-server.ts";
import {
  __resetActiveProcsForTests,
  activeSessionCount,
  classifyBreakerOutcome,
  isRetryableSessionError,
  SessionCancelledError,
  SessionDetachedError,
  terminateActiveSessions,
  terminateSessionsForJob,
  type SessionOptions,
  type SessionResult,
} from "../server/mcp/session-runner.ts";
import {
  assistantMessage,
  FakeOpencodeClient,
  idleMessage,
  shellTool,
  text,
  type AssistantSpec,
  type FakeTurn,
} from "./helpers/fake-opencode-client.ts";

const PASSWORD = "test-password";
const MODEL = "deepseek-v4.1-flash";
const savedEnv = {
  key: process.env.IU_API_KEY,
  base: process.env.IU_BASE_URL,
  log: process.env.AGENT_GATEWAY_SESSIONS_LOG,
};

beforeEach(() => {
  process.env.IU_API_KEY = "test-key";
  process.env.IU_BASE_URL = "https://iu.example.invalid/anthropic";
  process.env.AGENT_GATEWAY_SESSIONS_LOG = join(
    mkdtempSync(join(tmpdir(), "agw-attempt-")),
    "sessions.jsonl",
  );
});

afterEach(() => {
  const leaked = activeSessionCount();
  __resetActiveProcsForTests();
  for (const [name, value] of [
    ["IU_API_KEY", savedEnv.key],
    ["IU_BASE_URL", savedEnv.base],
    ["AGENT_GATEWAY_SESSIONS_LOG", savedEnv.log],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  expect(leaked).toBe(0);
});

const serverOk = async (): Promise<OpencodeServerStatus> => ({
  ok: true,
  up: true,
  version: "2.0.25",
  pinned: "2.0.25",
  versionOk: true,
});

const okDeps = {
  preflight: async () => ({ ok: true as const }),
  serverStatus: serverOk,
  password: () => PASSWORD,
  pollMs: 5,
  idleTimeoutMs: 40,
};

const attemptRows = (): Array<Record<string, unknown>> => {
  try {
    return readFileSync(process.env.AGENT_GATEWAY_SESSIONS_LOG ?? "", "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
};
const lastRow = (): Record<string, unknown> => attemptRows().at(-1) ?? {};

type Opts = Partial<SessionOptions<unknown>>;

interface Setup {
  client: FakeOpencodeClient;
  turnsRef: { current: number };
  run: (
    opts?: Opts,
    ctx?: { model?: string; variant?: string },
    deps?: OpencodeAttemptDeps,
  ) => Promise<SessionResult<unknown>>;
}

function setup(turn?: FakeTurn): Setup {
  const client = new FakeOpencodeClient();
  if (turn) client.script(turn);
  const turnsRef = { current: 0 };
  return {
    client,
    turnsRef,
    run: (opts = {}, ctx = {}, deps = {}) =>
      runOpencodeAttempt(
        { cwd: "/tmp", prompt: "p", route: routeFor("dispatch"), ...opts },
        turnsRef,
        { model: ctx.model ?? MODEL, backend: "iu", variant: ctx.variant },
        { ...okDeps, client, ...deps },
      ),
  };
}

const finalText = (value: string): FakeTurn => ({ assistant: [{ content: [text(value)] }] });

describe("runOpencodeAttempt — the session it creates", () => {
  test("read-only: iu-chat provider, model, variant, agw-readonly, directory, title and job metadata", async () => {
    const { client, run } = setup(finalText('{"answer":1}'));
    const result = await run(
      { cwd: "/work/repo", readOnly: true, tool: "dispatch", jobId: "job-9" },
      { variant: "high" },
    );
    expect(result.ok).toBe(true);
    expect(client.created).toEqual([
      {
        directory: "/work/repo",
        model: { providerID: "iu-chat", id: MODEL, variant: "high" },
        agent: "agw-readonly",
        title: "agw dispatch",
        metadata: { agw: { jobId: "job-9", tool: "dispatch" } },
      },
    ]);
  });

  test("a sensitive read-only session uses agw-readonly-sensitive; sensitive is ignored when writable", async () => {
    const ro = setup(finalText('{"answer":1}'));
    await ro.run({ readOnly: true, sensitive: true });
    expect(ro.client.created[0]).toMatchObject({ agent: "agw-readonly-sensitive" });
    const rw = setup(finalText('{"answer":1}'));
    await rw.run({ sensitive: true });
    expect(rw.client.created[0]).toMatchObject({ agent: "agw-implement" });
  });

  test("a writable session uses agw-implement; a responses-wire model rides iu-responses", async () => {
    const { client, run } = setup(finalText('{"answer":1}'));
    await run({}, { model: "gpt-6.1-sol", variant: "high" });
    expect(client.created[0]).toMatchObject({
      agent: "agw-implement",
      model: { providerID: "iu-responses", id: "gpt-6.1-sol", variant: "high" },
      title: "agw episode",
    });
  });

  test("create → environment → prompt → wait, and onSessionId fires with the new id", async () => {
    const { client, run } = setup(finalText('{"answer":1}'));
    const ids: string[] = [];
    await run({ onSessionId: (id) => ids.push(id) });
    expect(client.callLog.slice(0, 4)).toEqual([
      "createSession",
      "setEnvironment",
      "prompt",
      "wait",
    ]);
    expect(ids).toEqual(["ses_fake_1"]);
  });

  test("a jsonSchema is appended to the prompt in-band", async () => {
    const { client, run } = setup(finalText('{"answer":1}'));
    await run({
      prompt: "investigate",
      jsonSchema: { type: "object", properties: { answer: {} } },
    });
    const sent = client.prompts[0]?.input.text ?? "";
    expect(sent.startsWith("investigate")).toBe(true);
    expect(sent).toContain("FINAL message must be ONLY a single JSON object");
    expect(sent).toContain('"answer"');
    expect(client.prompts[0]?.input.resume).toBeUndefined();
  });

  test("resumeSessionId re-attaches: no create, the prompt resumes, the old idle message is ignored", async () => {
    const { client, run } = setup({
      prematureIdleWaits: 1,
      assistant: [{ content: [text('{"answer":2}')] }],
    });
    client.seed("ses_old", [
      assistantMessage({ content: [text('{"answer":"stale"}')] }),
      idleMessage("interrupted"),
    ]);
    const ids: string[] = [];
    const result = await run({ resumeSessionId: "ses_old", onSessionId: (id) => ids.push(id) });
    expect(client.created).toEqual([]);
    expect(client.environments.map((e) => e.sessionId)).toEqual(["ses_old"]);
    expect(client.prompts[0]).toMatchObject({ sessionId: "ses_old", input: { resume: true } });
    expect(ids).toEqual(["ses_old"]);
    expect(result).toMatchObject({ ok: true, data: { answer: 2 } });
  });
});

describe("runOpencodeAttempt — session environment", () => {
  test("blanks every server credential, delivers extraEnv (research creds included), git deny last", async () => {
    const { client, run } = setup(finalText('{"answer":1}'));
    await run({
      extraEnv: {
        RESEARCH_GATEWAY_URL: "https://r.example",
        RESEARCH_GATEWAY_TOKEN: "rs-secret",
        ...GIT_DENY_CREDENTIALS_ENV,
      },
    });
    const variables = client.environments[0]?.variables ?? {};
    for (const name of OPENCODE_SESSION_BLANKED_ENV) expect(variables[name], name).toBe("");
    expect(variables.RESEARCH_GATEWAY_URL).toBe("https://r.example");
    expect(variables.RESEARCH_GATEWAY_TOKEN).toBe("rs-secret");
    expect(variables).toMatchObject(GIT_DENY_CREDENTIALS_ENV);
    expect(Object.keys(variables)).toEqual(
      expect.arrayContaining([
        ...OPENCODE_SESSION_BLANKED_ENV,
        ...Object.keys(GIT_DENY_CREDENTIALS_ENV),
      ]),
    );
  });

  test("no extraEnv still blanks the credentials and applies the git deny", async () => {
    const { client, run } = setup(finalText('{"answer":1}'));
    await run();
    expect(client.environments[0]?.variables).toEqual({
      OPENCODE_SERVER_PASSWORD: "",
      IU_KEY: "",
      IU_OPENAI_BASE: "",
      IU_ANTHROPIC_BASE: "",
      ...GIT_DENY_CREDENTIALS_ENV,
    });
  });

  test("a caller extraEnv key colliding with a blanked credential still ends up blank", async () => {
    const { client, run } = setup(finalText('{"answer":1}'));
    await run({ extraEnv: { IU_KEY: "attacker-supplied", OPENCODE_SERVER_PASSWORD: "x" } });
    const variables = client.environments[0]?.variables ?? {};
    expect(variables.IU_KEY).toBe("");
    expect(variables.OPENCODE_SERVER_PASSWORD).toBe("");
  });

  test("a caller extraEnv key colliding with a git deny key loses", async () => {
    const { client, run } = setup(finalText('{"answer":1}'));
    await run({ extraEnv: { GIT_ASKPASS: "/bin/true", GIT_TERMINAL_PROMPT: "1" } });
    const variables = client.environments[0]?.variables ?? {};
    expect(variables.GIT_ASKPASS).toBe(GIT_DENY_CREDENTIALS_ENV.GIT_ASKPASS);
    expect(variables.GIT_TERMINAL_PROMPT).toBe(GIT_DENY_CREDENTIALS_ENV.GIT_TERMINAL_PROMPT);
  });
});

describe("runOpencodeAttempt — resume attribution", () => {
  test("a re-attached session attributes only the new turn's tokens and cost", async () => {
    const { client, run, turnsRef } = setup({
      assistant: [{ content: [text('{"answer":2}')], tokens: { input: 10, output: 4 }, cost: 0.5 }],
    });
    client.seed("ses_old", [
      assistantMessage({
        content: [text("earlier")],
        tokens: { input: 1000, output: 400 },
        cost: 9,
      }),
      idleMessage("interrupted"),
    ]);
    const result = await run({ resumeSessionId: "ses_old" });
    expect(result).toMatchObject({ ok: true, data: { answer: 2 } });
    expect(turnsRef.current).toBe(1);
    expect(lastRow()).toMatchObject({
      opencodeSessionId: "ses_old",
      turns: 1,
      costUsd: 0.5,
      inputTokens: 10,
      outputTokens: 4,
    });
  });
});

describe("runOpencodeAttempt — success", () => {
  const twoTurns: FakeTurn = {
    assistant: [
      {
        content: [text("looking"), shellTool("ls")],
        tokens: { input: 100, output: 20, reasoning: 5, cacheRead: 1000, cacheWrite: 7 },
        cost: 0.25,
        finish: "tool-calls",
      },
      {
        content: [text('{"answer":1}')],
        tokens: { input: 50, output: 10, reasoning: 2, cacheRead: 500, cacheWrite: 3 },
        cost: 0.125,
      },
    ],
  };

  test("data comes from the final text; tokens and cost are the exact message sums", async () => {
    const { run, turnsRef } = setup(twoTurns);
    const result = await run({ tool: "dispatch", jobId: "job-9", cwd: "/work/repo" });
    expect(result).toMatchObject({ ok: true, data: { answer: 1 }, backend: "iu", model: MODEL });
    expect(turnsRef.current).toBe(2);
    expect(attemptRows()).toHaveLength(1);
    expect(lastRow()).toMatchObject({
      outcome: "ok",
      harness: "opencode",
      tool: "dispatch",
      project: "/work/repo",
      model: MODEL,
      backend: "iu",
      opencodeSessionId: "ses_fake_1",
      turns: 2,
      costUsd: 0.375,
      inputTokens: 150,
      outputTokens: 30,
      thinkingTokens: 7,
      cacheReadTokens: 1500,
      cacheWriteTokens: 10,
    });
  });

  test("the retired usageIncomplete flag is gone from the attribution row", async () => {
    const { run } = setup(twoTurns);
    await run();
    expect(lastRow()).not.toHaveProperty("usageIncomplete");
  });

  test("validate runs on the parsed data and its value is returned", async () => {
    const { run } = setup(finalText('{"answer":1}'));
    const result = await run({ validate: (d) => ({ ok: true, value: { wrapped: d } }) });
    expect(result).toMatchObject({ ok: true, data: { wrapped: { answer: 1 } } });
  });

  test("a ```json fence around the final message is tolerated", async () => {
    const { run } = setup(finalText('```json\n{"answer":1}\n```'));
    expect(await run()).toMatchObject({ ok: true, data: { answer: 1 } });
  });
});

describe("runOpencodeAttempt — refusals before a session exists", () => {
  test("IU preflight failure: connection-class text, no session, no server check", async () => {
    const { client, run } = setup();
    let statusCalls = 0;
    const result = await run(
      {},
      {},
      {
        preflight: async () => ({ ok: false, reason: "ECONNREFUSED" }),
        serverStatus: async () => {
          statusCalls++;
          return serverOk();
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("IU endpoint unreachable before opencode session: ECONNREFUSED");
    expect(result.classificationText).toBe(result.error);
    expect(result.iuConfigError).toBeUndefined();
    expect(isRetryableSessionError(result.error ?? "")).toBe(true);
    expect(classifyBreakerOutcome(result)).toBe("transport");
    expect(client.callLog).toEqual([]);
    expect(statusCalls).toBe(0);
    expect(lastRow()).toMatchObject({ outcome: "error", reason: "opencode_preflight_failed" });
  });

  test("server not ok: connection-class text carrying the cause, no session", async () => {
    const { client, run } = setup();
    const result = await run(
      {},
      {},
      {
        serverStatus: async () => ({
          ok: false,
          up: true,
          version: "2.0.30",
          pinned: "2.0.25",
          versionOk: false,
          error: "opencode server version 2.0.30 != pinned 2.0.25",
        }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("opencode server unavailable before session");
    expect(result.error).toContain("2.0.30");
    expect(isRetryableSessionError(result.error ?? "")).toBe(true);
    expect(classifyBreakerOutcome(result)).toBe("transport");
    expect(client.callLog).toEqual([]);
    expect(lastRow()).toMatchObject({ reason: "opencode_server_unavailable" });
  });

  test("a job already cancelled throws before probing anything", async () => {
    const { client, run } = setup();
    let probed = 0;
    await expect(
      run(
        { jobId: "job-9", isCancelled: () => true },
        {},
        {
          preflight: async () => {
            probed++;
            return { ok: true };
          },
        },
      ),
    ).rejects.toBeInstanceOf(SessionCancelledError);
    expect(probed).toBe(0);
    expect(client.callLog).toEqual([]);
  });

  test("extraDisallowedTools throws; so do an unknown variant and an unusable model", async () => {
    const { client, run } = setup();
    await expect(run({ extraDisallowedTools: ["Bash"] })).rejects.toThrow(
      /extraDisallowedTools is not supported/,
    );
    await expect(run({}, { variant: "ultra-mega" })).rejects.toThrow(
      /unknown opencode variant "ultra-mega"/,
    );
    await expect(run({}, { model: "DeepSeek-V4-Flash" })).rejects.toThrow(
      /not usable on the opencode harness/,
    );
    await expect(run({}, { model: "not-a-model" })).rejects.toThrow(/unknown model/);
    expect(client.callLog).toEqual([]);
  });
});

describe("runOpencodeAttempt — failures after a session exists", () => {
  test("an idle kill is timeout_idle, interrupts the session and still attributes the usage", async () => {
    const { client, run } = setup({
      hang: true,
      visibleNow: [
        { content: [shellTool("sleep 999", "running")], tokens: { input: 7 }, cost: 0.5 },
      ],
    });
    const result = await run({ tool: "dispatch" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Session timed out — idle");
    expect(result.error).toContain("no new messages");
    expect(classifyBreakerOutcome(result)).toBe("neutral");
    expect(client.interrupts).toEqual(["ses_fake_1"]);
    expect(lastRow()).toMatchObject({
      outcome: "timeout_idle",
      killReason: "idle",
      costUsd: 0.5,
      inputTokens: 7,
    });
  });

  test("a job cancel / drain mid-run is 'interrupted by request' with the partial text salvaged", async () => {
    const { client, run } = setup({
      hang: true,
      visibleNow: [{ content: [text("halfway there")] }],
    });
    const running = run({ jobId: "job-9" }, {}, { idleTimeoutMs: 60_000 });
    const deadline = Date.now() + 5_000;
    while (activeSessionCount() === 0 && Date.now() < deadline) await Bun.sleep(2);
    // The stop lands once the session is being driven (tracked only inside the drive loop).
    await Bun.sleep(10);
    expect(terminateSessionsForJob("job-9")).toBe(true);
    const result = await running;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("interrupted by request");
    expect(result.noOutput).toBe(true);
    expect(result.rawText).toBe("halfway there");
    expect(client.interrupts).toEqual(["ses_fake_1"]);
    expect(lastRow()).toMatchObject({ outcome: "error", reason: "interrupted" });
  });

  test("an unreadable message list after a finished run is a transport failure, not 'no output'", async () => {
    const { client, run } = setup(finalText('{"answer":1}'));
    client.allMessagesError = new Error("opencode server unreachable: ECONNREFUSED");
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("fetch failed");
    expect(result.error).toContain("ECONNREFUSED");
    expect(result.error).not.toContain("no output");
    expect(result.noOutput).toBeUndefined();
    expect(isRetryableSessionError(result.error ?? "")).toBe(true);
    expect(classifyBreakerOutcome(result)).toBe("transport");
    expect(lastRow()).toMatchObject({ outcome: "error", reason: "messages_unreadable" });
    expect(attemptRows()).toHaveLength(1);
  });

  test("opts.idleTimeoutMs is honoured when no dep overrides it", async () => {
    const { client, run } = setup({
      hang: true,
      visibleNow: [{ content: [shellTool("sleep 999", "running")], tokens: null }],
    });
    const result = await run({ idleTimeoutMs: 30 }, {}, { idleTimeoutMs: undefined });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Session timed out — idle");
    expect(client.interrupts).toEqual(["ses_fake_1"]);
    expect(lastRow()).toMatchObject({ outcome: "timeout_idle" });
  });

  test("an assistant error is 'opencode error: …', no output, with earlier text kept as rawText", async () => {
    const { run } = setup({
      assistant: [
        { content: [text("partial")] },
        {
          content: [],
          error: { type: "provider.auth", message: "Provider request failed with HTTP 401" },
        },
      ],
      outcome: "failed",
    });
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("opencode error: Provider request failed with HTTP 401");
    expect(result.noOutput).toBe(true);
    expect(result.rawText).toBe("partial");
    expect(lastRow()).toMatchObject({ outcome: "error", reason: "error_event" });
  });

  test("an error with no message falls back to its type", async () => {
    const { run } = setup({ assistant: [{ error: { type: "provider.no-route" } }] });
    expect((await run()).error).toBe("opencode error: provider.no-route");
  });

  for (const outcome of ["failed", "interrupted"] as const) {
    test(`an idle outcome '${outcome}' without an error is a failure, text kept as rawText`, async () => {
      const { run } = setup({ assistant: [{ content: [text('{"answer":1}')] }], outcome });
      const result = await run();
      expect(result.ok).toBe(false);
      expect(result.error).toBe(`opencode error: session ended ${outcome}`);
      expect(result.noOutput).toBe(true);
      expect(result.rawText).toBe('{"answer":1}');
      expect(lastRow()).toMatchObject({ reason: "idle_outcome" });
    });
  }

  test("no assistant text at all is a no-output failure", async () => {
    const { run } = setup({ assistant: [{ content: [shellTool("ls")] }] });
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.noOutput).toBe(true);
    expect(result.error).toContain("no output");
    expect(lastRow()).toMatchObject({ reason: "no_output" });
  });

  test("a run that ends on a tool call is truncated: narration valid as JSON is NOT a verdict", async () => {
    const { run } = setup({
      assistant: [{ content: [text('{"answer":"narration"}'), shellTool("ls")] }],
    });
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.noOutput).toBe(true);
    expect(result.error).toContain("ended on a tool call");
    expect(result.rawText).toBe('{"answer":"narration"}');
    expect(lastRow()).toMatchObject({ reason: "truncated_stream" });
  });

  test("a final message that is not JSON is an unclassified output failure with the raw text", async () => {
    const { run } = setup(finalText("I think the answer is one."));
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.noOutput).toBe(true);
    expect(result.error).toContain("final message is not valid JSON");
    expect(result.rawText).toBe("I think the answer is one.");
    expect(lastRow()).toMatchObject({ reason: "json_parse" });
  });

  test("a validate rejection returns its reason and the parsed JSON as rawText", async () => {
    const { run } = setup(finalText('{"answer":1}'));
    const result = await run({ validate: () => ({ ok: false, error: "missing field x" }) });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("missing field x");
    expect(result.noOutput).toBe(true);
    expect(JSON.parse(result.rawText ?? "")).toEqual({ answer: 1 });
    expect(lastRow()).toMatchObject({ reason: "invalid_output" });
  });
});

describe("runOpencodeAttempt — transport failures and secret redaction", () => {
  test("a transport error mid-run is ok:false with connection-class text, the session interrupted, no leak", async () => {
    const { key } = await getIuConfig();
    const { client, run } = setup({
      waitError: new Error(`opencode server unreachable: ECONNREFUSED (pw=${PASSWORD} key=${key})`),
      visibleNow: [{ content: [text("partial")] }],
    });
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
    expect(result.error).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(result.classificationText).toBe(result.error);
    expect(isRetryableSessionError(result.error ?? "")).toBe(true);
    expect(classifyBreakerOutcome(result)).toBe("transport");
    expect(client.interrupts).toEqual(["ses_fake_1"]);
    expect(lastRow()).toMatchObject({ outcome: "error", reason: "opencode_session_error" });
  });

  test("fails closed when the server lacks the agent: no session, no prompt, a retryable transport-class error", async () => {
    const { client, run } = setup(finalText('{"answer":1}'));
    client.agents = ["agw-readonly", "agw-implement"];
    const result = await run({ readOnly: true, sensitive: true });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("lacks agent agw-readonly-sensitive");
    expect(result.error).toContain("make install-opencode-agent");
    expect(isRetryableSessionError(result.error ?? "")).toBe(true);
    expect(classifyBreakerOutcome(result)).toBe("transport");
    expect(client.created).toEqual([]);
    expect(client.prompts).toEqual([]);
    expect(lastRow()).toMatchObject({ outcome: "error", reason: "opencode_session_error" });
  });

  test("a server that lists the requested agent proceeds (extra agents are fine)", async () => {
    const { client, run } = setup(finalText('{"answer":1}'));
    client.agents = ["build", "agw-implement"];
    expect((await run()).ok).toBe(true);
    expect(client.created.map((c) => c.agent)).toEqual(["agw-implement"]);
  });

  test("a failing session create is the same transport-class failure", async () => {
    const { client, run } = setup();
    client.createError = new Error("opencode server unreachable: ECONNREFUSED");
    const result = await run();
    expect(result.ok).toBe(false);
    expect(classifyBreakerOutcome(result)).toBe("transport");
    expect(client.prompts).toEqual([]);
  });

  test("a failing environment PUT never lets the prompt run un-blanked", async () => {
    const { client, run } = setup(finalText('{"answer":1}'));
    client.environmentError = new Error("opencode server answered HTTP 500 on PUT environment");
    const result = await run();
    expect(result.ok).toBe(false);
    expect(client.prompts).toEqual([]);
  });

  test("the server password and the IU key are redacted from returned data", async () => {
    const { key } = await getIuConfig();
    const { run } = setup(finalText(JSON.stringify({ leak: `pw=${PASSWORD} key=${key}` })));
    const result = await run();
    expect(result.ok).toBe(true);
    const out = JSON.stringify(result);
    expect(out).not.toContain(PASSWORD);
    expect(out).not.toContain(key);
    expect(out).toContain("[REDACTED]");
  });

  test("redacted from an assistant error's message and from salvaged rawText", async () => {
    const { key } = await getIuConfig();
    const turn: AssistantSpec[] = [
      { content: [text(`earlier ${PASSWORD}`)] },
      { error: { type: "provider.auth", message: `bad creds ${PASSWORD} ${key}` } },
    ];
    const { run } = setup({ assistant: turn, outcome: "failed" });
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(JSON.stringify(result)).not.toContain(key);
  });
});

describe("runOpencodeAttempt — durable episodes (Wave 4)", () => {
  const hangingRun = async (opts: Opts) => {
    const { client, run } = setup({
      hang: true,
      visibleNow: [{ content: [text("halfway there")] }],
    });
    const running = run({ jobId: "job-7", ...opts }, {}, { idleTimeoutMs: 60_000 });
    const settled = running.then(
      (value) => ({ value, error: undefined as unknown }),
      (error: unknown) => ({ value: undefined, error }),
    );
    const deadline = Date.now() + 5_000;
    while (activeSessionCount() === 0 && Date.now() < deadline) await Bun.sleep(2);
    await Bun.sleep(10);
    return { client, settled };
  };

  test("a drain DETACHES a reattachable session: no interrupt, SessionDetachedError, no usage row", async () => {
    const { client, settled } = await hangingRun({ reattachable: true });
    expect(terminateActiveSessions()).toEqual(["job-7"]);
    const { error } = await settled;
    expect(error).toBeInstanceOf(SessionDetachedError);
    expect(client.interrupts).toEqual([]);
    expect(client.only.turn).toBeDefined(); // still running server-side
    expect(attemptRows()).toEqual([]);
  });

  test("a drain still INTERRUPTS a session nobody will re-attach", async () => {
    const { client, settled } = await hangingRun({});
    terminateActiveSessions();
    const { value, error } = await settled;
    expect(error).toBeUndefined();
    expect(value?.error).toContain("interrupted by request");
    expect(client.interrupts).toEqual(["ses_fake_1"]);
  });

  test("a job cancel interrupts even a reattachable session", async () => {
    const { client, settled } = await hangingRun({ reattachable: true });
    expect(terminateSessionsForJob("job-7")).toBe(true);
    const { value } = await settled;
    expect(value?.error).toContain("interrupted by request");
    expect(client.interrupts).toEqual(["ses_fake_1"]);
  });

  test("re-attach to a LIVE session waits on it: no prompt, no environment, no new session", async () => {
    const { client, run } = setup();
    const session = client.seed("ses_live", [assistantMessage({ content: [text("working")] })]);
    session.turn = { assistant: [{ content: [text('{"answer":3}')] }] };
    const result = await run({ resumeSessionId: "ses_live", reattachable: true });
    expect(result).toMatchObject({ ok: true, data: { answer: 3 } });
    expect(client.created).toEqual([]);
    expect(client.prompts).toEqual([]);
    expect(client.environments).toEqual([]);
    expect(client.callLog).toContain("wait");
  });

  test("an idle with no outcome counts as finished; a failed idle is resumed with a prompt", async () => {
    const noOutcome = setup();
    noOutcome.client.seed("ses_a", [
      assistantMessage({ content: [text('{"answer":5}')] }),
      { ...idleMessage("succeeded"), outcome: undefined },
    ]);
    expect(await noOutcome.run({ resumeSessionId: "ses_a" })).toMatchObject({
      ok: true,
      data: { answer: 5 },
    });
    expect(noOutcome.client.prompts).toEqual([]);

    const failed = setup({ assistant: [{ content: [text('{"answer":6}')] }] });
    failed.client.seed("ses_b", [
      assistantMessage({ content: [text("x")] }),
      idleMessage("failed"),
    ]);
    expect(await failed.run({ resumeSessionId: "ses_b" })).toMatchObject({ ok: true });
    expect(failed.client.prompts[0]?.input.resume).toBe(true);
  });

  test("re-attach to a session that FINISHED while agw was down reads its result without prompting", async () => {
    const { client, run } = setup();
    client.seed("ses_done", [
      assistantMessage({
        content: [text('{"answer":4}')],
        tokens: { input: 7, output: 3 },
        cost: 0.2,
      }),
      idleMessage("succeeded"),
    ]);
    const result = await run({ resumeSessionId: "ses_done" });
    expect(result).toMatchObject({ ok: true, data: { answer: 4 } });
    expect(client.prompts).toEqual([]);
    expect(lastRow()).toMatchObject({ outcome: "ok", costUsd: 0.2, inputTokens: 7 });
  });
});
