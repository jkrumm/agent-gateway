// Drain-detach for EVERY OpenCode session run under a job, and the session ledger that lets a
// multi-session job's re-run re-attach them (server/mcp/session-runner.ts `detachRemoteSessions`,
// `SessionOptions.reattachKey`; server/jobs/store.ts `job_sessions`). `runOpencodeAttempt` runs
// over the in-memory `FakeOpencodeClient`; the ledger is the real sqlite-backed one the store
// wires in at import (tests/setup.ts points it at a temp file).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetForTests } from "../server/jobs/store.ts";
import { routeFor } from "../server/lib/routing.ts";
import { runOpencodeAttempt, type OpencodeAttemptDeps } from "../server/mcp/opencode-runner.ts";
import {
  __resetActiveProcsForTests,
  __resetAttemptRunnerForTests,
  __setAttemptRunnerForTests,
  activeSessionCount,
  detachableJobIds,
  detachRemoteSessions,
  getSessionLedger,
  runSession,
  SessionDetachedError,
  terminateActiveSessions,
  type SessionOptions,
  type SessionResult,
} from "../server/mcp/session-runner.ts";
import {
  assistantMessage,
  FakeOpencodeClient,
  idleMessage,
  text,
  type FakeTurn,
} from "./helpers/fake-opencode-client.ts";

const MODEL = "deepseek-v4.1-flash";
const JOB = "ledger-job-1";
const KEY = "angle:senior-dev:1.1";
const savedEnv = {
  key: process.env.IU_API_KEY,
  base: process.env.IU_BASE_URL,
  log: process.env.AGENT_GATEWAY_SESSIONS_LOG,
};

beforeEach(() => {
  process.env.IU_API_KEY = "test-key";
  process.env.IU_BASE_URL = "https://iu.example.invalid/anthropic";
  process.env.AGENT_GATEWAY_SESSIONS_LOG = join(
    mkdtempSync(join(tmpdir(), "agw-ledger-")),
    "sessions.jsonl",
  );
});

afterEach(() => {
  __resetActiveProcsForTests();
  __resetAttemptRunnerForTests();
  __resetForTests();
  for (const [name, value] of [
    ["IU_API_KEY", savedEnv.key],
    ["IU_BASE_URL", savedEnv.base],
    ["AGENT_GATEWAY_SESSIONS_LOG", savedEnv.log],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const okDeps = {
  preflight: async () => ({ ok: true as const }),
  serverStatus: async () => ({
    ok: true,
    up: true,
    version: "2.0.25",
    pinned: "2.0.25",
    versionOk: true,
  }),
  password: () => "pw",
  pollMs: 5,
  idleTimeoutMs: 60_000,
};

const usageRows = (): Array<Record<string, unknown>> => {
  try {
    return readFileSync(process.env.AGENT_GATEWAY_SESSIONS_LOG ?? "", "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
};

type Opts = Partial<SessionOptions<unknown>>;

function runOn(
  client: FakeOpencodeClient,
  opts: Opts = {},
  deps: OpencodeAttemptDeps = {},
): Promise<SessionResult<unknown>> {
  return runOpencodeAttempt(
    {
      cwd: "/tmp",
      prompt: "p",
      route: routeFor("dispatch"),
      jobId: JOB,
      reattachKey: KEY,
      ...opts,
    },
    { current: 0 },
    { model: MODEL, backend: "iu" },
    { ...okDeps, client, ...deps },
  );
}

/** Start a run that hangs in its first turn and wait until its session is registered. */
async function startHanging(client: FakeOpencodeClient, opts: Opts = {}) {
  client.script({ hang: true, visibleNow: [{ content: [text("halfway")] }] } satisfies FakeTurn);
  const running = runOn(client, opts);
  const settled = running.then(
    (value) => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined, error }),
  );
  const deadline = Date.now() + 5_000;
  while (activeSessionCount() === 0 && Date.now() < deadline) await Bun.sleep(2);
  await Bun.sleep(10);
  return settled;
}

/** What the server did with the session while agw was down: the turn finished. */
function finishWhileDown(client: FakeOpencodeClient, answer: number): void {
  const session = client.only;
  session.turn = undefined;
  session.messages.push(
    assistantMessage({
      content: [text(JSON.stringify({ answer }))],
      tokens: { input: 7, output: 3 },
      cost: 0.2,
    }),
    idleMessage("succeeded"),
  );
}

describe("drain detach — every OpenCode session under a job", () => {
  test("detachRemoteSessions detaches without interrupting, reports the job, and is idempotent", async () => {
    const client = new FakeOpencodeClient();
    const settled = startHanging(client);
    await Bun.sleep(30);

    expect([...detachableJobIds()]).toEqual([JOB]);
    expect(detachRemoteSessions()).toEqual([JOB]);
    const { error } = await settled;
    expect(error).toBeInstanceOf(SessionDetachedError);
    expect(client.interrupts).toEqual([]);
    expect(client.only.turn).toBeDefined(); // still running server-side
    expect(usageRows()).toEqual([]); // nothing billed by the process that let go

    // The drain later kills only what cannot be detached: the detached session is not touched
    // again and its job stays out of the blocker set even though its drive loop is gone.
    expect(terminateActiveSessions()).toEqual([]);
    expect(detachRemoteSessions()).toEqual([JOB]);
    expect([...detachableJobIds()]).toEqual([JOB]);
  });

  test("a session that starts after the drain began detaches before creating anything", async () => {
    detachRemoteSessions();
    const client = new FakeOpencodeClient();
    await expect(runOn(client, { reattachKey: undefined })).rejects.toBeInstanceOf(
      SessionDetachedError,
    );
    expect(client.created).toEqual([]);
    expect(client.prompts).toEqual([]);
  });

  test("a session with no job is not detachable: the drain interrupts it", async () => {
    const client = new FakeOpencodeClient();
    const settled = startHanging(client, { jobId: undefined, reattachKey: undefined });
    await Bun.sleep(30);
    expect(detachRemoteSessions()).toEqual([]);
    expect(terminateActiveSessions()).toEqual([]);
    const { value, error } = await settled;
    expect(error).toBeUndefined();
    expect(value?.error).toContain("interrupted by request");
    expect(client.interrupts).toEqual(["ses_fake_1"]);
  });

  test("a session detached between its creation and its prompt sends no prompt; the next boot prompts it first-time", async () => {
    const client = new FakeOpencodeClient();
    // The drain lands while the session is being set up (environment PUT in flight).
    const setEnvironment = client.setEnvironment.bind(client);
    client.setEnvironment = async (sessionId, variables) => {
      await setEnvironment(sessionId, variables);
      detachRemoteSessions();
    };
    await expect(runOn(client)).rejects.toBeInstanceOf(SessionDetachedError);
    expect(client.created).toHaveLength(1);
    expect(client.prompts).toEqual([]);

    // The re-run after the restart: the ledger names the empty session; it is prompted as a
    // FIRST prompt (resume: false), not as the resume of a turn that never started.
    __resetActiveProcsForTests();
    client.setEnvironment = setEnvironment;
    client.script({ assistant: [{ content: [text('{"answer":9}')] }] });
    const result = await runOn(client);
    expect(result).toMatchObject({ ok: true, data: { answer: 9 } });
    expect(client.created).toHaveLength(1);
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0]?.input.resume).toBeUndefined();
  });
});

describe("session ledger — re-attach without double billing", () => {
  test("detach → boot: the finished session is read through the ledger, billed once, no new session", async () => {
    const client = new FakeOpencodeClient();
    const settled = startHanging(client);
    await Bun.sleep(30);
    detachRemoteSessions();
    expect((await settled).error).toBeInstanceOf(SessionDetachedError);
    expect(getSessionLedger()?.get(JOB, KEY)).toMatchObject({ settled: false });

    // Restart: no in-memory state survives; the ledger row does.
    __resetActiveProcsForTests();
    finishWhileDown(client, 4);
    const result = await runOn(client);

    expect(result).toMatchObject({ ok: true, data: { answer: 4 } });
    expect(client.created).toHaveLength(1);
    expect(client.prompts).toHaveLength(1); // the original prompt only — no resume nudge
    expect(usageRows()).toHaveLength(1);
    // The whole session — the partial turn the detaching process saw included — in one row.
    expect(usageRows()[0]).toMatchObject({ outcome: "ok", costUsd: 0.2, turns: 2 });
    expect(getSessionLedger()?.get(JOB, KEY)).toMatchObject({ settled: true });
  });

  test("re-attach to a still-live session waits on it: no prompt, no environment, one usage row", async () => {
    const client = new FakeOpencodeClient();
    const settled = startHanging(client);
    await Bun.sleep(30);
    detachRemoteSessions();
    await settled;

    __resetActiveProcsForTests();
    // The detached turn is still running; it completes when waited on.
    client.only.turn = { assistant: [{ content: [text('{"answer":5}')] }] };
    const promptsBefore = client.prompts.length;
    const envsBefore = client.environments.length;
    const result = await runOn(client);

    expect(result).toMatchObject({ ok: true, data: { answer: 5 } });
    expect(client.created).toHaveLength(1);
    expect(client.prompts).toHaveLength(promptsBefore);
    expect(client.environments).toHaveLength(envsBefore);
    expect(usageRows()).toHaveLength(1);
  });

  test("a settled row re-attaches without writing a second usage row", async () => {
    const client = new FakeOpencodeClient();
    client.script({ assistant: [{ content: [text('{"answer":1}')] }] });
    expect(await runOn(client)).toMatchObject({ ok: true });
    expect(usageRows()).toHaveLength(1);

    // The whole job re-runs after a sibling session detached: this call's session is finished and
    // already attributed.
    const again = await runOn(client);
    expect(again).toMatchObject({ ok: true, data: { answer: 1 } });
    expect(client.created).toHaveLength(1);
    expect(client.prompts).toHaveLength(1);
    expect(usageRows()).toHaveLength(1);
  });

  test("a failed attempt drops its row so the re-run starts that call over", async () => {
    const client = new FakeOpencodeClient();
    client.script({ assistant: [{ content: [text("not json")] }] });
    const failed = await runOn(client);
    expect(failed.ok).toBe(false);
    expect(getSessionLedger()?.get(JOB, KEY)).toBeUndefined();

    client.script({ assistant: [{ content: [text('{"answer":2}')] }] });
    expect(await runOn(client)).toMatchObject({ ok: true, data: { answer: 2 } });
    expect(client.created).toHaveLength(2);
  });

  test("a ledger session gone from the server is replaced, not an error", async () => {
    getSessionLedger()?.put(JOB, KEY, "ses_gone");
    const client = new FakeOpencodeClient(); // knows no such session
    client.script({ assistant: [{ content: [text('{"answer":3}')] }] });
    const result = await runOn(client);
    expect(result).toMatchObject({ ok: true, data: { answer: 3 } });
    expect(client.created).toHaveLength(1);
    expect(getSessionLedger()?.get(JOB, KEY)?.sessionId).toBe("ses_fake_1");
  });

  test("a caller-supplied resumeSessionId wins over the ledger", async () => {
    getSessionLedger()?.put(JOB, KEY, "ses_ledger");
    const client = new FakeOpencodeClient();
    client.seed("ses_given", [
      assistantMessage({ content: [text('{"answer":6}')] }),
      idleMessage("succeeded"),
    ]);
    const result = await runOn(client, { resumeSessionId: "ses_given" });
    expect(result).toMatchObject({ ok: true, data: { answer: 6 } });
    expect(client.created).toEqual([]);
  });

  test("without a reattachKey nothing is recorded", async () => {
    const client = new FakeOpencodeClient();
    client.script({ assistant: [{ content: [text('{"answer":1}')] }] });
    await runOn(client, { reattachKey: undefined });
    expect(getSessionLedger()?.get(JOB, KEY)).toBeUndefined();
  });
});

describe("runSession — ledger keys", () => {
  test("each call under a key gets its own ordinal and each attempt its number", async () => {
    const seen: Array<string | undefined> = [];
    let failFirst = true;
    __setAttemptRunnerForTests((async (opts: SessionOptions<unknown>) => {
      seen.push(opts.reattachKey);
      if (failFirst) {
        failFirst = false;
        return {
          ok: false,
          error: "connect ECONNREFUSED",
          classificationText: "connect ECONNREFUSED",
          backend: "iu",
          model: MODEL,
        };
      }
      return { ok: true, data: {}, backend: "iu", model: MODEL };
    }) as never);
    const base = { cwd: "/tmp", prompt: "p", route: routeFor("dispatch"), tool: "review:angle" };

    await runSession({ ...base, jobId: "key-job", reattachKey: "angle:qa" });
    await runSession({ ...base, jobId: "key-job", reattachKey: "angle:qa" });
    await runSession({ ...base, jobId: "key-job", reattachKey: "synthesis" });
    // No key → no ledger.
    await runSession({ ...base, jobId: "key-job" });

    expect(seen).toEqual([
      "angle:qa:1.1", // first attempt failed with a transport error …
      "angle:qa:1.2", // … the retry is a different session
      "angle:qa:2.1", // a second call under the same key is a second session
      "synthesis:1.1",
      undefined,
    ]);
  });
});
