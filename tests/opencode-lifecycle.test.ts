// `driveOpencodeSession` (server/mcp/opencode-runner.ts): the teardown and liveness guarantees of
// one HTTP-driven OpenCode session, exercised against the in-memory `FakeOpencodeClient` (the test
// adapter of the `OpencodeClient` port). Time is driven through the `pollMs`/`idleTimeoutMs`
// seams (a few ms), never real seconds.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  driveOpencodeSession,
  type OpencodeDriveInput,
  type OpencodeDriveResult,
} from "../server/mcp/opencode-runner.ts";
import { OpencodeHttpError } from "../server/mcp/opencode-client.ts";
import { appLogger } from "../server/logger.ts";
import { logger as mcpLogger } from "../server/mcp/logger.ts";
import {
  __resetActiveProcsForTests,
  activeSessionCount,
  terminateActiveSessions,
  terminateSessionsForJob,
  type SessionProgress,
} from "../server/mcp/session-runner.ts";
import {
  assistantMessage,
  FakeOpencodeClient,
  idleMessage,
  shellTool,
  text,
  type FakeTurn,
} from "./helpers/fake-opencode-client.ts";

const SESSION = "ses_1";

afterEach(() => {
  // Every exit path must leave nothing registered for cancel/drain.
  const leaked = activeSessionCount();
  __resetActiveProcsForTests();
  expect(leaked).toBe(0);
});

function setup() {
  const client = new FakeOpencodeClient();
  client.seed(SESSION, []);
  const turnsRef = { current: 0 };
  const activity: SessionProgress[] = [];
  const drive = (over: Partial<OpencodeDriveInput> = {}): Promise<OpencodeDriveResult> =>
    driveOpencodeSession(client, {
      jobId: "job-1",
      cwd: "/tmp",
      sessionId: SESSION,
      prompt: "do it",
      logContext: {},
      turnsRef,
      pollMs: 5,
      idleTimeoutMs: 40,
      onActivity: (p) => activity.push(p),
      ...over,
    });
  return { client, turnsRef, activity, drive };
}

/** A turn that shows one running tool call and then never changes again. */
const wedgedTurn: FakeTurn = {
  hang: true,
  visibleNow: [{ content: [shellTool("sleep 999", "running")], tokens: null }],
};

describe("driveOpencodeSession — finishing", () => {
  test("a normal turn finishes: idle outcome read, nothing interrupted, prompt sent without resume", async () => {
    const { client, drive } = setup();
    client.script({ assistant: [{ content: [text("done")] }] });
    const result = await drive();
    expect(result).toMatchObject({
      finished: true,
      stopped: false,
      killReason: null,
      idleMsAtKill: null,
    });
    expect(result.messages.at(-1)).toMatchObject({ type: "idle", outcome: "succeeded" });
    expect(client.interrupts).toEqual([]);
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0]?.input).toEqual({ text: "do it" });
  });

  test("a wait that returns idle before the new idle message exists is re-awaited", async () => {
    const { client, drive } = setup();
    client.script({ prematureIdleWaits: 1, assistant: [{ content: [text("done")] }] });
    const result = await drive();
    expect(result.finished).toBe(true);
    expect(client.waitCalls).toBe(2);
    expect(result.messages.map((m) => m.type)).toEqual(["user", "assistant", "idle"]);
  });

  test("resume: the prompt carries resume and the pre-existing idle message does not count as done", async () => {
    const { client, drive } = setup();
    const old = idleMessage("interrupted");
    client.seed(SESSION, [assistantMessage({ content: [text("earlier")] }), old]);
    client.script({ prematureIdleWaits: 1, assistant: [{ content: [text("continued")] }] });
    const result = await drive({ resume: true, baselineIdleId: old.id });
    expect(result.finished).toBe(true);
    expect(client.prompts[0]?.input).toEqual({ text: "do it", resume: true });
    expect(client.waitCalls).toBe(2);
    expect(result.messages.at(-1)?.id).not.toBe(old.id);
  });

  test("with a baseline, only the messages AFTER it are returned (a resumed session is not double-attributed)", async () => {
    const { client, drive } = setup();
    const old = idleMessage("interrupted");
    client.seed(SESSION, [
      assistantMessage({ content: [text("earlier")], tokens: { input: 1000 }, cost: 9 }),
      old,
    ]);
    client.script({ assistant: [{ content: [text("continued")], tokens: { input: 10 } }] });
    const result = await drive({ resume: true, baselineIdleId: old.id });
    expect(result.messages.map((m) => m.type)).toEqual(["user", "assistant", "idle"]);
    expect(JSON.stringify(result.messages)).not.toContain("earlier");
  });

  test("a baseline id missing from the list leaves the messages untouched", async () => {
    const { client, drive } = setup();
    client.script({ assistant: [{ content: [text("done")] }] });
    const result = await drive({ resume: true, baselineIdleId: "idle_gone" });
    expect(result.messages.map((m) => m.type)).toEqual(["user", "assistant", "idle"]);
  });

  test("a failed interrupt result is logged, never thrown", async () => {
    const { client, drive } = setup();
    client.interruptResult = { ok: false, interrupted: false, error: "ECONNREFUSED" };
    client.script(wedgedTurn);
    const result = await drive();
    expect(result.killReason).toBe("idle");
  });
});

describe("driveOpencodeSession — idle watchdog", () => {
  test("no message activity for idleTimeoutMs kills the run and interrupts the session", async () => {
    const { client, drive } = setup();
    client.script(wedgedTurn);
    const result = await drive();
    expect(result).toMatchObject({ finished: false, stopped: false, killReason: "idle" });
    expect(result.idleMsAtKill).toBeGreaterThanOrEqual(40);
    expect(client.interrupts).toEqual([SESSION]);
  });

  test("usage is still read after an idle kill, after the interrupt", async () => {
    const { client, drive } = setup();
    client.script({
      hang: true,
      visibleNow: [{ content: [text("narration")], tokens: { input: 100, output: 20 }, cost: 0.5 }],
    });
    const result = await drive();
    expect(result.killReason).toBe("idle");
    const withUsage = result.messages.find((m) => m.type === "assistant");
    expect(withUsage).toMatchObject({ cost: 0.5, tokens: { input: 100, output: 20 } });
    expect(client.callLog.indexOf("interrupt")).toBeLessThan(
      client.callLog.lastIndexOf("allMessages"),
    );
    // The server's own interrupt landed an idle message the read picked up.
    expect(result.messages.at(-1)).toMatchObject({ type: "idle", outcome: "interrupted" });
  });

  test("an unreadable final message list does not throw: empty messages, kill reason intact", async () => {
    const { client, drive } = setup();
    client.allMessagesError = new Error("opencode server unreachable: ECONNREFUSED");
    client.script(wedgedTurn);
    const result = await drive();
    expect(result.messages).toEqual([]);
    expect(result.killReason).toBe("idle");
  });

  test("real message activity resets the watchdog: it fires only after the last change", async () => {
    const { client, drive, activity } = setup();
    client.script(wedgedTurn);
    client.onActivityPoll = (session, poll) => {
      // A new message on each of the first 15 polls (>> idleTimeoutMs of 40 ms at 5 ms/poll).
      if (poll < 15) session.messages.push(assistantMessage({ content: [text(`step ${poll}`)] }));
    };
    const result = await drive();
    expect(result.killReason).toBe("idle");
    expect(client.activityPolls).toBeGreaterThan(15);
    expect(activity.length).toBeGreaterThanOrEqual(15);
  });

  test("a provider retry-only change does NOT reset the watchdog", async () => {
    const { client, drive, activity } = setup();
    client.script(wedgedTurn);
    client.onActivityPoll = (session, poll) => {
      // The server's retry bookkeeping rewrites the newest message on every poll; id, type, finish,
      // output tokens and content shape are untouched.
      const last = session.messages.at(-1);
      if (last) {
        session.messages[session.messages.length - 1] = { ...last, retry: { attempt: poll } };
      }
    };
    const result = await drive();
    expect(result.killReason).toBe("idle");
    // Only the first poll (empty fingerprint -> real one) counted as activity.
    expect(activity).toHaveLength(1);
  });
});

describe("driveOpencodeSession — a running shell tool part", () => {
  const shellTurn: FakeTurn = {
    hang: true,
    visibleNow: [{ content: [shellTool("pytest", "running", 29)], tokens: null }],
  };

  test("growing shell output is activity: a session quiet in the message stream is not killed", async () => {
    const { client, drive } = setup();
    client.script(shellTurn);
    client.onActivityPoll = (session, poll) => {
      // 30 polls x 5 ms >> the 40 ms budget, all of it with the message stream frozen.
      client.shellSizes.set("29", (poll + 1) * 6);
      if (poll === 30) {
        session.messages.push(idleMessage("succeeded"));
        session.releaseHang?.();
      }
    };
    const result = await drive();
    expect(result).toMatchObject({ finished: true, killReason: null });
    expect(client.interrupts).toEqual([]);
    expect(client.shellReads[0]).toEqual({ shellId: "29", directory: "/tmp" });
  });

  test("a running shell whose output size does not change is killed with the usual idle error", async () => {
    const { client, drive } = setup();
    client.script(shellTurn);
    client.shellSizes.set("29", 12);
    const result = await drive();
    expect(result).toMatchObject({ finished: false, killReason: "idle" });
    expect(result.idleMsAtKill).toBeGreaterThanOrEqual(40);
    expect(client.shellReads.length).toBeGreaterThan(1);
    expect(client.interrupts).toEqual([SESSION]);
  });

  test("a shell-output read that throws neither ends the session nor counts as activity", async () => {
    const { client, drive, activity } = setup();
    client.script(shellTurn);
    client.shellSizes.set("29", 12);
    client.onActivityPoll = (_session, poll) => {
      // The first poll reads fine; every later read fails while the session stays quiet.
      if (poll === 1) client.shellOutputError = new Error("opencode server answered HTTP 500");
    };
    const result = await drive();
    expect(result).toMatchObject({ finished: false, killReason: "idle" });
    expect(result.idleMsAtKill).toBeGreaterThanOrEqual(40);
    // Only the first poll (empty fingerprint -> real one) counted as activity.
    expect(activity).toHaveLength(1);
  });

  test("a shell tool part without a shellID is not read", async () => {
    const { client, drive } = setup();
    client.script({
      hang: true,
      visibleNow: [{ content: [shellTool("sleep 999", "running")], tokens: null }],
    });
    const result = await drive();
    expect(result.killReason).toBe("idle");
    expect(client.shellReads).toEqual([]);
  });
});

describe("driveOpencodeSession — a wait that keeps answering 'not idle'", () => {
  test("the loop backs off (no busy loop), the watchdog still fires and the session is interrupted", async () => {
    const { client, drive } = setup();
    client.script({ ...wedgedTurn, hang: false, nonIdleWaits: Infinity });
    const result = await drive();
    expect(result).toMatchObject({ finished: false, killReason: "idle" });
    expect(client.interrupts).toEqual([SESSION]);
    // ~40 ms of budget at a 5 ms back-off is a dozen re-arms; a tight loop would be thousands.
    expect(client.waitCalls).toBeGreaterThan(1);
    expect(client.waitCalls).toBeLessThan(60);
  });

  test("a few non-idle answers followed by a real one still finish normally", async () => {
    const { client, drive } = setup();
    client.script({ nonIdleWaits: 3, assistant: [{ content: [text("done")] }] });
    const result = await drive();
    expect(result.finished).toBe(true);
    expect(client.waitCalls).toBe(4);
    expect(client.interrupts).toEqual([]);
  });
});

describe("driveOpencodeSession — cancel and drain", () => {
  test("terminateSessionsForJob aborts the wait, interrupts once and reports stopped", async () => {
    const { client, drive } = setup();
    client.script(wedgedTurn);
    const running = drive();
    expect(activeSessionCount()).toBe(1);
    await Bun.sleep(15);
    expect(terminateSessionsForJob("job-1")).toBe(true);
    const result = await running;
    expect(result).toMatchObject({ stopped: true, finished: false, killReason: null });
    expect(client.interrupts).toEqual([SESSION]);
  });

  test("terminateActiveSessions (drain) reaches it too and names the job", async () => {
    const { client, drive } = setup();
    client.script(wedgedTurn);
    const running = drive();
    await Bun.sleep(15);
    expect(terminateActiveSessions()).toEqual(["job-1"]);
    const result = await running;
    expect(result.stopped).toBe(true);
    expect(client.interrupts).toEqual([SESSION]);
  });

  test("a stop fired before the first await (still admitting the prompt) is honoured", async () => {
    const { client, drive } = setup();
    client.script(wedgedTurn);
    const running = drive();
    terminateSessionsForJob("job-1");
    const result = await running;
    expect(result.stopped).toBe(true);
    expect(client.interrupts).toEqual([SESSION]);
  });

  test("a stop for another job leaves the session alone", async () => {
    const { client, drive } = setup();
    client.script({ assistant: [{ content: [text("done")] }] });
    const running = drive();
    expect(terminateSessionsForJob("some-other-job")).toBe(false);
    expect((await running).finished).toBe(true);
  });
});

describe("driveOpencodeSession — transport failure mid-run", () => {
  test("the error propagates, the session is still interrupted and untracked", async () => {
    const { client, drive } = setup();
    const boom = new Error("opencode server unreachable: ECONNREFUSED");
    client.script({ waitError: boom, visibleNow: [{ content: [text("partial")] }] });
    await expect(drive()).rejects.toBe(boom);
    expect(client.interrupts).toEqual([SESSION]);
    expect(activeSessionCount()).toBe(0);
  });

  test("a prompt that is never admitted still untracks and interrupts", async () => {
    const { client, drive } = setup();
    client.promptError = new Error("opencode server answered HTTP 500 on POST /prompt");
    await expect(drive()).rejects.toThrow("HTTP 500");
    expect(client.interrupts).toEqual([SESSION]);
    expect(activeSessionCount()).toBe(0);
  });
});

describe("driveOpencodeSession — a slow request in the loop does not end the episode", () => {
  const timeout = (): Error => new DOMException("The operation timed out.", "TimeoutError");
  // What the real adapter throws for a timed-out request (opencode-client.ts `call`).
  const budgetExceeded = (): Error =>
    new Error("opencode server unreachable: ETIMEDOUT (no answer within the request budget)");

  /** runnerLogger() picks the app or the mcp logger by process kind: watch both. */
  function watchWarnings() {
    const calls: Array<Record<string, unknown>> = [];
    const spies = [appLogger, mcpLogger].map((l) =>
      spyOn(l, "warn").mockImplementation(((obj: Record<string, unknown>) => {
        calls.push(obj);
      }) as never),
    );
    return {
      slow: () => calls.filter((c) => c.event === "session.opencode_poll_slow"),
      restore: () => spies.forEach((s) => s.mockRestore()),
    };
  }

  test("activity polls that time out twice are logged, then the episode carries on and finishes", async () => {
    const { client, drive } = setup();
    const warnings = watchWarnings();
    try {
      client.script({
        hang: true,
        visibleNow: [{ content: [shellTool("make check", "running")] }],
      });
      client.recentMessagesFault = (limit, call) =>
        limit > 1 && call < 2 ? (call === 0 ? timeout() : budgetExceeded()) : undefined;
      client.onActivityPoll = (session, poll) => {
        // The poll after the two timeouts sees new activity, then the turn completes.
        if (poll === 0) session.messages.push(assistantMessage({ content: [text("tests green")] }));
        if (poll === 1) {
          session.messages.push(idleMessage("succeeded"));
          session.releaseHang?.();
        }
      };
      const result = await drive();
      expect(result).toMatchObject({ finished: true, killReason: null, stopped: false });
      expect(client.interrupts).toEqual([]);
      expect(warnings.slow()).toHaveLength(2);
      expect(warnings.slow().map((w) => w.consecutive)).toEqual([1, 2]);
      expect(warnings.slow()[0]).toMatchObject({ request: "activity_poll", sessionId: SESSION });
    } finally {
      warnings.restore();
    }
  });

  test("polls that never answer are ended by the idle watchdog, not by an ETIMEDOUT throw", async () => {
    const { client, drive } = setup();
    const warnings = watchWarnings();
    try {
      client.script(wedgedTurn);
      client.recentMessagesFault = (limit) => (limit > 1 ? budgetExceeded() : undefined);
      const result = await drive();
      expect(result).toMatchObject({ finished: false, stopped: false, killReason: "idle" });
      expect(result.idleMsAtKill).toBeGreaterThanOrEqual(40);
      expect(client.interrupts).toEqual([SESSION]);
      expect(warnings.slow().length).toBeGreaterThan(1);
    } finally {
      warnings.restore();
    }
  });

  test.each([401, 404])("an HTTP %i from the activity poll still throws", async (status) => {
    const { client, drive } = setup();
    client.script(wedgedTurn);
    const denied = new OpencodeHttpError(status, "GET /api/session/ses_1/message");
    client.recentMessagesFault = (limit) => (limit > 1 ? denied : undefined);
    await expect(drive()).rejects.toBe(denied);
    expect(client.interrupts).toEqual([SESSION]);
  });

  test("a refused connection from the activity poll still throws (a dead server fails fast)", async () => {
    const { client, drive } = setup();
    client.script(wedgedTurn);
    const refused = new Error("opencode server unreachable: ECONNREFUSED");
    client.recentMessagesFault = (limit) => (limit > 1 ? refused : undefined);
    await expect(drive()).rejects.toBe(refused);
  });

  test("a finish check that times out once after an idle wait is retried, the next round finishes", async () => {
    const { client, drive } = setup();
    const warnings = watchWarnings();
    try {
      client.script({ assistant: [{ content: [text("done")] }] });
      client.recentMessagesFault = (limit, call) =>
        limit === 1 && call === 0 ? timeout() : undefined;
      const result = await drive();
      expect(result).toMatchObject({ finished: true, killReason: null });
      expect(client.waitCalls).toBe(2);
      expect(client.interrupts).toEqual([]);
      expect(warnings.slow()).toHaveLength(1);
      expect(warnings.slow()[0]).toMatchObject({ request: "finish_check", consecutive: 1 });
    } finally {
      warnings.restore();
    }
  });

  test("a wait that rejects with a timeout is re-armed after the back-off", async () => {
    const { client, drive } = setup();
    client.script({ assistant: [{ content: [text("done")] }] });
    const realWait = client.wait.bind(client);
    let calls = 0;
    client.wait = (sessionId, signal) =>
      ++calls === 1 ? Promise.reject(budgetExceeded()) : realWait(sessionId, signal);
    const result = await drive();
    expect(result.finished).toBe(true);
    expect(calls).toBe(2);
  });

  test("a stop during a pending wait while polls are timing out still breaks out promptly", async () => {
    const { client, drive } = setup();
    client.script(wedgedTurn);
    client.recentMessagesFault = (limit) => (limit > 1 ? timeout() : undefined);
    const running = drive({ idleTimeoutMs: 60_000 });
    await Bun.sleep(15);
    expect(terminateSessionsForJob("job-1")).toBe(true);
    const result = await running;
    expect(result).toMatchObject({ stopped: true, finished: false, killReason: null });
    expect(client.interrupts).toEqual([SESSION]);
  });
});

describe("driveOpencodeSession — progress plumbing", () => {
  test("turnsRef and onActivity follow the message stream (finished turns only, lastAction from tool blocks)", async () => {
    const { client, drive, turnsRef, activity } = setup();
    client.script({
      hang: true,
      visibleNow: [
        { content: [shellTool("ls -la")] },
        { content: [text("looking")] },
        { content: [shellTool("sleep 999", "running")], tokens: null },
      ],
    });
    await drive();
    expect(turnsRef.current).toBe(2);
    expect(activity[0]).toMatchObject({ turns: 2, lastAction: "shell: sleep 999" });
  });

  test("the heartbeat reports progress on its interval and its timer is cleared on every exit", async () => {
    const { client, drive } = setup();
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const heartbeats: Array<() => void> = [];
    const cleared: unknown[] = [];
    const handle = { heartbeat: true };
    // Capture the 15 s heartbeat instead of waiting for it; every other interval stays real.
    globalThis.setInterval = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms !== 15_000) return realSet(fn, ms, ...rest);
      heartbeats.push(fn);
      return handle;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = ((id?: unknown) => {
      if (id !== handle) return realClear(id as never);
      cleared.push(id);
    }) as typeof clearInterval;
    const ticks: Array<[number, number, string]> = [];
    try {
      client.script(wedgedTurn);
      client.onActivityPoll = () => {
        for (const beat of heartbeats) beat();
      };
      await drive({ onProgress: (a, b, c) => ticks.push([a, b, c]) });
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    }
    expect(heartbeats).toHaveLength(1);
    expect(ticks[0]).toEqual([1, 0, "Session running (15s elapsed)"]);
    expect(cleared).toEqual([handle]);
  });
});
