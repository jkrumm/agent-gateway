// Claude Max account pick: picker output parsing, worker env scrub, the one other-account
// retry before the IU fallback, and the `account` field of the session_env line.

import { afterEach, describe, expect, test } from "bun:test";
import type { ToolRoute } from "../lib/routing.ts";
import { sessionEnvRecord } from "./session-core.ts";
import {
  __resetAttemptRunnerForTests,
  __resetBreakersForTests,
  __setAttemptRunnerForTests,
  buildWorkerEnv,
  planNextAttempt,
  runSession,
  type AttemptRef,
  type NextAttemptInput,
  type SessionOptions,
  type SessionResult,
} from "./session-runner.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setAccountPickerForTests,
  __setExhaustedMarkerForTests,
  __setExhaustionCheckForTests,
  parseAccountPick,
  quotaResetEpochS,
  readSessionAccount,
  recordSessionAccount,
  selectAccount,
  type AccountSelection,
} from "./worker-shared.ts";

describe("parseAccountPick", () => {
  test("unset → default account", () => {
    expect(parseAccountPick("unset CLAUDE_CONFIG_DIR\n", 0)).toEqual({ kind: "default" });
  });
  test("export → config dir, quoted or bare", () => {
    expect(parseAccountPick("export CLAUDE_CONFIG_DIR='/Users/x/.claude-b'\n", 0)).toEqual({
      kind: "dir",
      dir: "/Users/x/.claude-b",
    });
    expect(parseAccountPick("export CLAUDE_CONFIG_DIR=/Users/x/.claude-b", 0)).toEqual({
      kind: "dir",
      dir: "/Users/x/.claude-b",
    });
  });
  test("exit 3 is the spill signal whatever stdout says (spill, iu, empty)", () => {
    expect(parseAccountPick("spill\n", 3)).toEqual({ kind: "iu" });
    expect(parseAccountPick("iu\n", 3)).toEqual({ kind: "iu" });
    expect(parseAccountPick("", 3)).toEqual({ kind: "iu" });
  });
  test("a spill string at exit 0 is not a spill", () => {
    expect(parseAccountPick("spill\n", 0)).toEqual({ kind: "unavailable" });
  });
  test("failure shapes → unavailable", () => {
    expect(parseAccountPick("", 0)).toEqual({ kind: "unavailable" });
    expect(parseAccountPick("garbage", 0)).toEqual({ kind: "unavailable" });
    expect(parseAccountPick("unset CLAUDE_CONFIG_DIR", 2)).toEqual({ kind: "unavailable" });
  });
});

describe("quotaResetEpochS", () => {
  const now = Date.UTC(2026, 9, 24, 12, 0, 0);
  test("reads the CLI's epoch suffix, else now + 1 h", () => {
    const future = Math.floor(now / 1000) + 7200;
    expect(quotaResetEpochS(`Claude AI usage limit reached|${future}`, now)).toBe(future);
    expect(quotaResetEpochS("429 rate limit", now)).toBe(Math.floor(now / 1000) + 3600);
    expect(quotaResetEpochS(`usage limit reached|${Math.floor(now / 1000) - 5}`, now)).toBe(
      Math.floor(now / 1000) + 3600,
    );
  });
});

describe("buildWorkerEnv — account", () => {
  const base = {
    tool: "check",
    backend: "max" as const,
    model: "claude-sonnet-5-5",
    anthropicBase: "",
    iuKey: "",
  };
  test("a picked dir is set and the inherited OAuth token is removed", () => {
    const env = buildWorkerEnv({
      ...base,
      claudeConfigDir: "/h/.claude-b",
      baseEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok", PATH: "/bin" },
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/h/.claude-b");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
  test("an extraEnv token cannot sneak back in next to a config dir", () => {
    const env = buildWorkerEnv({
      ...base,
      claudeConfigDir: "/h/.claude-b",
      extraEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
  test("null unsets an inherited dir and keeps today's token behaviour", () => {
    const env = buildWorkerEnv({
      ...base,
      claudeConfigDir: null,
      baseEnv: { CLAUDE_CONFIG_DIR: "/h/.claude-b", CLAUDE_CODE_OAUTH_TOKEN: "tok" },
    });
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
  });
  test("undefined (picker failed) leaves the inherited env untouched", () => {
    const env = buildWorkerEnv({ ...base, baseEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok" } });
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
  });
});

describe("sessionEnvRecord — account", () => {
  test("carries the account only when known", () => {
    expect(sessionEnvRecord("s", null, "m", "max", "check", "claude", "b").account).toBe("b");
    expect("account" in sessionEnvRecord("s", null, "m", "max", "check", "claude")).toBe(false);
  });
});

const quotaFail = (account?: string): SessionResult<unknown> => ({
  ok: false,
  error: "Claude AI usage limit reached|1",
  classificationText: "Claude AI usage limit reached",
  backend: "max",
  model: "claude-sonnet-5-5",
  ...(account ? {} : {}),
});

describe("planNextAttempt — account retry", () => {
  const input: NextAttemptInput = {
    result: quotaFail(),
    attempt: 1,
    noOutputYet: true,
    usedFallback: false,
    fallback: { backend: "iu" },
    routeModel: "claude-sonnet-5-5",
    account: "a",
  };
  test("first quota wall on a picked account → account-retry", () => {
    expect(planNextAttempt(input).kind).toBe("account-retry");
  });
  test("second wall → the existing IU fallback", () => {
    const plan = planNextAttempt({ ...input, accountRetried: true });
    expect(plan.kind).toBe("fallback");
    if (plan.kind === "fallback") expect(plan.forced.backend).toBe("iu");
  });
  test("no known account (picker failed) → today's IU fallback directly", () => {
    expect(planNextAttempt({ ...input, account: undefined }).kind).toBe("fallback");
  });
  test("output already produced → no account retry", () => {
    expect(planNextAttempt({ ...input, noOutputYet: false }).kind).toBe("return");
  });
});

describe("runSession — retry on the other account", () => {
  const route: ToolRoute = {
    model: "claude-sonnet-5-5",
    backend: "max",
    fallback: { backend: "iu" },
    transport: "session",
    harness: "claude",
  };
  const opts: SessionOptions<unknown> = { cwd: "/tmp", prompt: "x", route, tool: "check" };

  afterEach(() => {
    __resetAttemptRunnerForTests();
    __setExhaustedMarkerForTests();
    __resetBreakersForTests();
  });

  test("marks the account exhausted, re-picks once, then falls back to iu", async () => {
    const marks: [string, number][] = [];
    __setExhaustedMarkerForTests(async (a, u) => void marks.push([a, u]));
    const seen: string[] = [];
    __setAttemptRunnerForTests(
      async <T>(
        _o: SessionOptions<T>,
        ref: AttemptRef,
        forced?: { backend: "max" | "iu"; model: string },
      ) => {
        if (forced) {
          seen.push(`forced:${forced.backend}`);
          return {
            ok: true,
            data: "done",
            backend: forced.backend,
            model: forced.model,
          } as SessionResult<T>;
        }
        const account = seen.length === 0 ? "a" : "b";
        seen.push(account);
        ref.account = account;
        return quotaFail() as SessionResult<T>;
      },
    );
    const r = await runSession(opts);
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["a", "b", "forced:iu"]);
    expect(marks.map(([a]) => a)).toEqual(["a"]);
    expect(marks[0]![1]).toBeGreaterThan(Date.now() / 1000);
  });

  test("a success on the other account ends the loop", async () => {
    __setExhaustedMarkerForTests(async () => {});
    let n = 0;
    __setAttemptRunnerForTests(async <T>(_o: SessionOptions<T>, ref: AttemptRef) => {
      n++;
      ref.account = n === 1 ? "a" : "b";
      return (
        n === 1 ? quotaFail() : { ok: true, data: "done", backend: "max", model: route.model }
      ) as SessionResult<T>;
    });
    const r = await runSession(opts);
    expect(r.ok).toBe(true);
    expect(n).toBe(2);
  });
});

describe("selectAccount — resume pin and exclusion", () => {
  const picks: string[] = [];
  const picker = (sel: AccountSelection) => async (lane: string) => {
    picks.push(lane);
    return sel;
  };
  const prevDir = process.env.AGENT_GATEWAY_SESSION_ACCOUNTS_DIR;

  afterEach(() => {
    picks.length = 0;
    __setAccountPickerForTests();
    __setExhaustionCheckForTests();
    if (prevDir === undefined) delete process.env.AGENT_GATEWAY_SESSION_ACCOUNTS_DIR;
    else process.env.AGENT_GATEWAY_SESSION_ACCOUNTS_DIR = prevDir;
  });
  const freshDir = () =>
    (process.env.AGENT_GATEWAY_SESSION_ACCOUNTS_DIR = mkdtempSync(join(tmpdir(), "acct-pin-")));

  test("pin round-trips; a bad session id is ignored", () => {
    freshDir();
    recordSessionAccount("sess-1", { account: "b", dir: "/h/.claude-b" });
    expect(readSessionAccount("sess-1")).toEqual({ account: "b", dir: "/h/.claude-b" });
    recordSessionAccount("../evil", { account: "b", dir: null });
    expect(readSessionAccount("../evil")).toBeNull();
    expect(readSessionAccount("missing")).toBeNull();
  });

  test("resume reuses the pinned account without picking", async () => {
    freshDir();
    recordSessionAccount("sess-1", { account: "b", dir: "/h/.claude-b" });
    __setExhaustionCheckForTests(async () => false);
    __setAccountPickerForTests(picker({ pick: { kind: "default" }, account: "a" }));
    const sel = await selectAccount({ lane: "agent-gateway:check", resumeSessionId: "sess-1" });
    expect(sel).toEqual({ pick: { kind: "dir", dir: "/h/.claude-b" }, account: "b", reused: true });
    expect(picks).toEqual([]);
  });

  test("a pinned default account resumes as default", async () => {
    freshDir();
    recordSessionAccount("sess-a", { account: "a", dir: null });
    __setExhaustionCheckForTests(async () => false);
    const sel = await selectAccount({ lane: "l", resumeSessionId: "sess-a" });
    expect(sel.pick).toEqual({ kind: "default" });
    expect(sel.reused).toBe(true);
  });

  test("an exhausted pinned account is re-picked", async () => {
    freshDir();
    recordSessionAccount("sess-1", { account: "b", dir: "/h/.claude-b" });
    __setExhaustionCheckForTests(async (a) => a === "b");
    __setAccountPickerForTests(picker({ pick: { kind: "default" }, account: "a" }));
    const sel = await selectAccount({ lane: "agent-gateway:check", resumeSessionId: "sess-1" });
    expect(sel.account).toBe("a");
    expect(sel.reused).toBeUndefined();
    expect(picks).toEqual(["agent-gateway:check"]);
  });

  test("no pin (or no resume) → fresh pick", async () => {
    freshDir();
    __setAccountPickerForTests(picker({ pick: { kind: "default" }, account: "a" }));
    expect((await selectAccount({ lane: "l", resumeSessionId: "unknown" })).account).toBe("a");
    expect((await selectAccount({ lane: "l" })).account).toBe("a");
    expect(picks.length).toBe(2);
  });

  test("the excluded account coming back from the picker → straight to iu", async () => {
    freshDir();
    __setAccountPickerForTests(picker({ pick: { kind: "default" }, account: "a" }));
    expect(await selectAccount({ lane: "l", excludeAccount: "a" })).toEqual({
      pick: { kind: "iu" },
    });
  });

  test("a different account than the excluded one is accepted", async () => {
    freshDir();
    __setAccountPickerForTests(
      picker({ pick: { kind: "dir", dir: "/h/.claude-b" }, account: "b" }),
    );
    expect((await selectAccount({ lane: "l", excludeAccount: "a" })).account).toBe("b");
  });

  test("the pin of the excluded account is not reused on resume", async () => {
    freshDir();
    recordSessionAccount("sess-1", { account: "a", dir: null });
    __setExhaustionCheckForTests(async () => false);
    __setAccountPickerForTests(
      picker({ pick: { kind: "dir", dir: "/h/.claude-b" }, account: "b" }),
    );
    const sel = await selectAccount({ lane: "l", resumeSessionId: "sess-1", excludeAccount: "a" });
    expect(sel.account).toBe("b");
  });
});
