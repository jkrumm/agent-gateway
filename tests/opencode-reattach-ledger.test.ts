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
import { OpencodeHttpError } from "../server/mcp/opencode-client.ts";
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
    await expect(runOn(client)).rejects.toBeInstanceOf(SessionDetachedError);
    expect(client.created).toEqual([]);
    expect(client.prompts).toEqual([]);
  });

  test("a drain that begins while the attempt awaits its preflight creates nothing", async () => {
    const client = new FakeOpencodeClient();
    await expect(
      runOn(
        client,
        {},
        {
          // The IU reachability probe is the slow await before `createSession`.
          preflight: async () => {
            detachRemoteSessions();
            return { ok: true as const };
          },
        },
      ),
    ).rejects.toBeInstanceOf(SessionDetachedError);
    expect(client.created).toEqual([]);
  });

  test("a drain that begins during the server-status read also creates nothing", async () => {
    const client = new FakeOpencodeClient();
    const status = okDeps.serverStatus;
    await expect(
      runOn(
        client,
        {},
        {
          serverStatus: async () => {
            const result = await status();
            detachRemoteSessions();
            return result;
          },
        },
      ),
    ).rejects.toBeInstanceOf(SessionDetachedError);
    expect(client.created).toEqual([]);
  });

  test("a session nothing can hand back (a job id but no reattachKey / onSessionId) is interrupted, not detached", async () => {
    const client = new FakeOpencodeClient();
    const settled = startHanging(client, { reattachKey: undefined });
    await Bun.sleep(30);
    expect(detachableJobIds().size).toBe(0);
    expect(detachRemoteSessions()).toEqual([]);
    expect(terminateActiveSessions()).toEqual([JOB]);
    const { value, error } = await settled;
    expect(error).toBeUndefined();
    expect(value?.error).toContain("interrupted by request");
    expect(client.interrupts).toEqual(["ses_fake_1"]);
  });

  test("a non-detachable session does not throw Detached once a drain began (the drain waits for it)", async () => {
    detachRemoteSessions();
    const client = new FakeOpencodeClient();
    client.script({ assistant: [{ content: [text('{"answer":1}')] }] });
    const result = await runOn(client, { reattachKey: undefined });
    expect(result).toMatchObject({ ok: true });
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
    // FIRST prompt (resume: false) with the FULL prompt — the continuation nudge assumes history
    // the session does not have.
    __resetActiveProcsForTests();
    client.setEnvironment = setEnvironment;
    client.script({ assistant: [{ content: [text('{"answer":9}')] }] });
    const result = await runOn(client, { prompt: "the full brief", resumePrompt: "NUDGE" });
    expect(result).toMatchObject({ ok: true, data: { answer: 9 } });
    expect(client.created).toHaveLength(1);
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0]?.input.resume).toBeUndefined();
    expect(client.prompts[0]?.input.text).toStartWith("the full brief");
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

describe("session ledger — errors and unreadable results", () => {
  test("a cut-off ledger session with history is resumed with the continuation nudge", async () => {
    getSessionLedger()?.put(JOB, KEY, "ses_cut");
    const client = new FakeOpencodeClient();
    client.seed("ses_cut", [assistantMessage({ content: [text("half")] }), idleMessage("failed")]);
    client.script({ assistant: [{ content: [text('{"answer":8}')] }] });
    const result = await runOn(client, { prompt: "the full brief", resumePrompt: "NUDGE" });
    expect(result).toMatchObject({ ok: true, data: { answer: 8 } });
    expect(client.prompts[0]?.input).toMatchObject({ resume: true });
    expect(client.prompts[0]?.input.text).toStartWith("NUDGE");
  });

  test("only a definite 404 replaces a ledger session; a transport error rethrows and keeps the row", async () => {
    getSessionLedger()?.put(JOB, KEY, "ses_live");
    const client = new FakeOpencodeClient();
    client.seed("ses_live", [assistantMessage({ content: [text("x")] })]);
    client.recentMessagesFault = () => new Error("fetch failed (connect error)");

    const result = await runOn(client);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("fetch failed");
    expect(client.created).toEqual([]); // no second session while the first may be alive
    expect(getSessionLedger()?.get(JOB, KEY)?.sessionId).toBe("ses_live");
  });

  test("a 5xx from the server is not a not-found either", async () => {
    getSessionLedger()?.put(JOB, KEY, "ses_live");
    const client = new FakeOpencodeClient();
    client.seed("ses_live", []);
    client.recentMessagesFault = () => new OpencodeHttpError(503, "GET /api/session/{id}/message");
    const result = await runOn(client);
    expect(result.ok).toBe(false);
    expect(client.created).toEqual([]);
    expect(getSessionLedger()?.get(JOB, KEY)?.sessionId).toBe("ses_live");
  });

  test("a settled session whose messages cannot be read: error without a second usage row, row kept, and the retry reads it", async () => {
    const client = new FakeOpencodeClient();
    client.script({ assistant: [{ content: [text('{"answer":1}')] }] });
    expect(await runOn(client)).toMatchObject({ ok: true });
    expect(usageRows()).toHaveLength(1);

    client.allMessagesError = new Error("fetch failed");
    const failed = await runOn(client);
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("unreachable reading messages");
    expect(usageRows()).toHaveLength(1);
    expect(getSessionLedger()?.get(JOB, KEY)).toMatchObject({ settled: true });

    client.allMessagesError = undefined;
    expect(await runOn(client)).toMatchObject({ ok: true, data: { answer: 1 } });
    expect(usageRows()).toHaveLength(1);
    expect(client.created).toHaveLength(1);
  });

  test("an UNsettled session whose messages cannot be read keeps its row and is attributed once the read works", async () => {
    getSessionLedger()?.put(JOB, KEY, "ses_fin");
    const client = new FakeOpencodeClient();
    client.seed("ses_fin", [
      assistantMessage({ content: [text('{"answer":2}')], cost: 0.1 }),
      idleMessage("succeeded"),
    ]);
    client.allMessagesError = new Error("fetch failed");
    expect((await runOn(client)).ok).toBe(false);
    expect(usageRows()).toHaveLength(1); // the error row of the failed read
    expect(getSessionLedger()?.get(JOB, KEY)).toMatchObject({ settled: false });

    client.allMessagesError = undefined;
    expect(await runOn(client)).toMatchObject({ ok: true, data: { answer: 2 } });
    expect(usageRows()).toHaveLength(2);
    expect(getSessionLedger()?.get(JOB, KEY)).toMatchObject({ settled: true });
  });
});

describe("runSession — ledger keys", () => {
  const base = { cwd: "/tmp", prompt: "p", route: routeFor("dispatch"), tool: "review:angle" };
  const okResult = { ok: true, data: {}, backend: "iu", model: MODEL };

  test("the key is used as is — no ordinal, no attempt number — so a restart cannot shift it", async () => {
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
      return okResult;
    }) as never);

    await runSession({ ...base, jobId: "key-job", reattachKey: "angle:qa" });
    await runSession({ ...base, jobId: "key-job" });

    // The transport-retried attempt reuses the key: the row decides whether it re-attaches.
    expect(seen).toEqual(["angle:qa", "angle:qa", undefined]);
  });

  test("the first call of a (re-)run keeps the surviving row; a repeat call in the same process starts fresh", async () => {
    const ledger = getSessionLedger();
    ledger?.put("rerun-job", "angle:qa", "ses_survivor");
    const rowAtCall: Array<string | undefined> = [];
    __setAttemptRunnerForTests((async (opts: SessionOptions<unknown>) => {
      rowAtCall.push(ledger?.get("rerun-job", opts.reattachKey ?? "")?.sessionId);
      return okResult;
    }) as never);

    await runSession({ ...base, jobId: "rerun-job", reattachKey: "angle:qa" });
    await runSession({ ...base, jobId: "rerun-job", reattachKey: "angle:qa" });

    expect(rowAtCall).toEqual(["ses_survivor", undefined]);
  });

  test("after a retry-then-detach the re-run re-attaches the SECOND attempt's session: the row, not a counter, decides", async () => {
    // Process 1: attempt 1 failed (its row was dropped and its session is idle), attempt 2 created
    // session B and was detached. Only B's row survives.
    getSessionLedger()?.put(JOB, "angle:senior-dev", "ses_B");
    // Process 2: the review's attempt 1 is the first runSession call — it re-attaches B instead of
    // starting a third session next to a live one.
    const client = new FakeOpencodeClient();
    client.seed("ses_B", [
      assistantMessage({ content: [text('{"answer":7}')] }),
      idleMessage("succeeded"),
    ]);
    __setAttemptRunnerForTests(((opts: SessionOptions<unknown>, turnsRef: { current: number }) =>
      runOpencodeAttempt(
        opts,
        turnsRef,
        { model: MODEL, backend: "iu" },
        {
          ...okDeps,
          client,
        },
      )) as never);

    const result = await runSession({
      ...base,
      jobId: JOB,
      reattachKey: "angle:senior-dev",
    });

    expect(result).toMatchObject({ ok: true, data: { answer: 7 } });
    expect(client.created).toEqual([]);
    expect(client.prompts).toEqual([]);
  });
});
