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
import {
  __setExhaustedMarkerForTests,
  parseAccountPick,
  quotaResetEpochS,
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
  test("exit 3 + iu → iu; exit 3 with anything else is a failure", () => {
    expect(parseAccountPick("iu\n", 3)).toEqual({ kind: "iu" });
    expect(parseAccountPick("nope", 3)).toEqual({ kind: "unavailable" });
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
