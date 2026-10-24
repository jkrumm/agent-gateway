// Claude Max account pick: picker output parsing, worker env scrub, the one other-account
// retry before the IU fallback, and the `account` field of the session_env line.

import { afterEach, describe, expect, test } from "bun:test";
import type { ToolRoute } from "../lib/routing.ts";
import { sessionEnvRecord } from "./session-core.ts";
import {
  __resetAttemptRunnerForTests,
  __resetBreakersForTests,
  __resetFallbackLogForTests,
  __setAttemptRunnerForTests,
  backendFallbacksLastHour,
  buildSessionArgs,
  buildWorkerEnv,
  isDefinitiveQuotaError,
  resolveAttemptAccount,
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
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import {
  __setAccountPickerForTests,
  __setDefaultAccountForTests,
  pickClaudeAccount,
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
    expect(parseAccountPick("export CLAUDE_CONFIG_DIR='/Users/x/.claude-me'\n", 0)).toEqual({
      kind: "dir",
      dir: "/Users/x/.claude-me",
    });
    expect(parseAccountPick("export CLAUDE_CONFIG_DIR=/Users/x/.claude-me", 0)).toEqual({
      kind: "dir",
      dir: "/Users/x/.claude-me",
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
      claudeConfigDir: "/h/.claude-me",
      baseEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok", PATH: "/bin" },
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/h/.claude-me");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
  test("an extraEnv token cannot sneak back in next to a config dir", () => {
    const env = buildWorkerEnv({
      ...base,
      claudeConfigDir: "/h/.claude-me",
      extraEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
  test("null unsets an inherited dir and keeps today's token behaviour", () => {
    const env = buildWorkerEnv({
      ...base,
      claudeConfigDir: null,
      baseEnv: { CLAUDE_CONFIG_DIR: "/h/.claude-me", CLAUDE_CODE_OAUTH_TOKEN: "tok" },
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
    expect(sessionEnvRecord("s", null, "m", "max", "check", "claude", "me").account).toBe("me");
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
    account: "iu",
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
    __setExhaustedMarkerForTests(async (a, u) => {
      marks.push([a, u]);
      return true;
    });
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
        const account = seen.length === 0 ? "iu" : "me";
        seen.push(account);
        ref.account = account;
        return quotaFail() as SessionResult<T>;
      },
    );
    const r = await runSession(opts);
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["iu", "me", "forced:iu"]);
    expect(marks.map(([a]) => a)).toEqual(["iu"]);
    expect(marks[0]![1]).toBeGreaterThan(Date.now() / 1000);
  });

  test("a success on the other account ends the loop", async () => {
    __setExhaustedMarkerForTests(async () => true);
    let n = 0;
    __setAttemptRunnerForTests(async <T>(_o: SessionOptions<T>, ref: AttemptRef) => {
      n++;
      ref.account = n === 1 ? "iu" : "me";
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
    recordSessionAccount("sess-1", { account: "me", dir: "/h/.claude-me" });
    expect(readSessionAccount("sess-1")).toEqual({ account: "me", dir: "/h/.claude-me" });
    recordSessionAccount("../evil", { account: "me", dir: null });
    expect(readSessionAccount("../evil")).toBeNull();
    expect(readSessionAccount("missing")).toBeNull();
  });

  test("resume reuses the pinned account without picking", async () => {
    freshDir();
    recordSessionAccount("sess-1", { account: "me", dir: "/h/.claude-me" });
    __setExhaustionCheckForTests(async () => false);
    __setAccountPickerForTests(picker({ pick: { kind: "default" }, account: "iu" }));
    const sel = await selectAccount({ lane: "agent-gateway:check", resumeSessionId: "sess-1" });
    expect(sel).toEqual({
      pick: { kind: "dir", dir: "/h/.claude-me" },
      account: "me",
      reused: true,
    });
    expect(picks).toEqual([]);
  });

  test("a pinned default account resumes as default", async () => {
    freshDir();
    recordSessionAccount("sess-a", { account: "iu", dir: null });
    __setExhaustionCheckForTests(async () => false);
    const sel = await selectAccount({ lane: "l", resumeSessionId: "sess-a" });
    expect(sel.pick).toEqual({ kind: "default" });
    expect(sel.reused).toBe(true);
  });

  test("an exhausted pinned account is re-picked", async () => {
    freshDir();
    recordSessionAccount("sess-1", { account: "me", dir: "/h/.claude-me" });
    __setExhaustionCheckForTests(async (a) => a === "me");
    __setAccountPickerForTests(picker({ pick: { kind: "default" }, account: "iu" }));
    const sel = await selectAccount({ lane: "agent-gateway:check", resumeSessionId: "sess-1" });
    expect(sel.account).toBe("iu");
    expect(sel.reused).toBeUndefined();
    expect(picks).toEqual(["agent-gateway:check"]);
  });

  test("no pin (or no resume) → fresh pick", async () => {
    freshDir();
    __setAccountPickerForTests(picker({ pick: { kind: "default" }, account: "iu" }));
    expect((await selectAccount({ lane: "l", resumeSessionId: "unknown" })).account).toBe("iu");
    expect((await selectAccount({ lane: "l" })).account).toBe("iu");
    expect(picks.length).toBe(2);
  });

  test("the excluded account coming back from the picker → straight to iu", async () => {
    freshDir();
    __setAccountPickerForTests(picker({ pick: { kind: "default" }, account: "iu" }));
    expect(await selectAccount({ lane: "l", excludeAccount: "iu" })).toEqual({
      pick: { kind: "iu" },
    });
  });

  test("a different account than the excluded one is accepted", async () => {
    freshDir();
    __setAccountPickerForTests(
      picker({ pick: { kind: "dir", dir: "/h/.claude-me" }, account: "me" }),
    );
    expect((await selectAccount({ lane: "l", excludeAccount: "iu" })).account).toBe("me");
  });

  test("the pin of the excluded account is not reused on resume", async () => {
    freshDir();
    recordSessionAccount("sess-1", { account: "iu", dir: null });
    __setExhaustionCheckForTests(async () => false);
    __setAccountPickerForTests(
      picker({ pick: { kind: "dir", dir: "/h/.claude-me" }, account: "me" }),
    );
    const sel = await selectAccount({ lane: "l", resumeSessionId: "sess-1", excludeAccount: "iu" });
    expect(sel.account).toBe("me");
  });
});

describe("resolveAttemptAccount — spill", () => {
  const spill = async (): Promise<AccountSelection> => ({ pick: { kind: "iu" } });
  afterEach(() => {
    __setAccountPickerForTests();
    __setDefaultAccountForTests();
    __resetFallbackLogForTests();
  });
  const base = { tool: "check", hasIuFallback: false };

  test("with an iu fallback → iu, counted as a no-account-headroom fallback", async () => {
    __setAccountPickerForTests(spill);
    const r = await resolveAttemptAccount({ ...base, hasIuFallback: true });
    expect(r).toEqual({ kind: "iu" });
    expect(backendFallbacksLastHour().reasons["no-account-headroom"]).toBe(1);
  });

  test("without a fallback → the default account, set explicitly (never the inherited env)", async () => {
    __setAccountPickerForTests(spill);
    __setDefaultAccountForTests(async () => "iu");
    expect(await resolveAttemptAccount(base)).toEqual({
      kind: "spawn",
      claudeConfigDir: null,
      account: "iu",
    });
  });

  test("without a fallback and the walled account is the default → walled, no spawn", async () => {
    __setAccountPickerForTests(spill);
    __setDefaultAccountForTests(async () => "iu");
    expect(await resolveAttemptAccount({ ...base, excludeAccount: "iu" })).toEqual({
      kind: "walled",
      account: "iu",
    });
  });

  test("without a fallback and the walled account is the other one → default account", async () => {
    __setAccountPickerForTests(spill);
    __setDefaultAccountForTests(async () => "iu");
    const r = await resolveAttemptAccount({ ...base, excludeAccount: "me" });
    expect(r).toEqual({ kind: "spawn", claudeConfigDir: null, account: "iu" });
  });

  test("picker unavailable → inherited env (today's behaviour)", async () => {
    __setAccountPickerForTests(async () => ({ pick: { kind: "unavailable" } }));
    expect(await resolveAttemptAccount(base)).toEqual({
      kind: "spawn",
      claudeConfigDir: undefined,
    });
  });
});

describe("definitive quota only", () => {
  test("classifier: usage-limit walls yes, transient 429/529/overloaded no", () => {
    expect(isDefinitiveQuotaError("Claude AI usage limit reached|1792000000")).toBe(true);
    expect(isDefinitiveQuotaError("You've hit your limit")).toBe(true);
    expect(isDefinitiveQuotaError("429 Too Many Requests")).toBe(false);
    expect(isDefinitiveQuotaError("529 overloaded_error")).toBe(false);
    expect(isDefinitiveQuotaError("rate limit exceeded, retry shortly")).toBe(false);
  });

  const input: NextAttemptInput = {
    result: {
      ok: false,
      backend: "max",
      classificationText: "429 Too Many Requests",
      hadApiRetry: true,
    },
    attempt: 1,
    noOutputYet: true,
    usedFallback: false,
    fallback: { backend: "iu" },
    routeModel: "claude-sonnet-5-5",
    account: "iu",
  };
  test("a transient 429 (even with api_retry) skips the account retry and goes to the iu fallback", () => {
    expect(planNextAttempt(input).kind).toBe("fallback");
  });

  test("runSession never marks an account exhausted on a transient 429", async () => {
    const marks: string[] = [];
    __setExhaustedMarkerForTests(async (a) => {
      marks.push(a);
      return true;
    });
    __setAttemptRunnerForTests(
      async <T>(
        _o: SessionOptions<T>,
        ref: AttemptRef,
        forced?: { backend: "max" | "iu"; model: string },
      ) => {
        ref.account = "iu";
        if (forced)
          return { ok: true, backend: forced.backend, model: forced.model } as SessionResult<T>;
        return { ...input.result, error: "429", model: "claude-sonnet-5-5" } as SessionResult<T>;
      },
    );
    const route: ToolRoute = {
      model: "claude-sonnet-5-5",
      backend: "max",
      fallback: { backend: "iu" },
      transport: "session",
      harness: "claude",
    };
    try {
      const r = await runSession({ cwd: "/tmp", prompt: "x", route, tool: "check" });
      expect(r.ok).toBe(true);
      expect(marks).toEqual([]);
    } finally {
      __resetAttemptRunnerForTests();
      __setExhaustedMarkerForTests();
      __resetBreakersForTests();
    }
  });
});

describe("resume after a re-pick", () => {
  const route: ToolRoute = {
    model: "claude-sonnet-5-5",
    backend: "max",
    fallback: { backend: "iu" },
    transport: "session",
    harness: "claude",
  };
  afterEach(() => {
    __resetAttemptRunnerForTests();
    __setExhaustedMarkerForTests();
    __setAccountPickerForTests();
    __setExhaustionCheckForTests();
    __resetBreakersForTests();
  });

  test("the account retry keeps passing resumeSessionId; the claude args carry --resume", async () => {
    __setExhaustedMarkerForTests(async () => true);
    const resumeIds: (string | undefined)[] = [];
    __setAttemptRunnerForTests(async <T>(o: SessionOptions<T>, ref: AttemptRef) => {
      resumeIds.push(o.resumeSessionId);
      ref.account = resumeIds.length === 1 ? "iu" : "me";
      return (
        resumeIds.length === 1 ? quotaFail() : { ok: true, backend: "max", model: route.model }
      ) as SessionResult<T>;
    });
    const r = await runSession({
      cwd: "/tmp",
      prompt: "x",
      route,
      tool: "check",
      resumeSessionId: "sess-9",
    });
    expect(r.ok).toBe(true);
    expect(resumeIds).toEqual(["sess-9", "sess-9"]);
    const args = buildSessionArgs({
      prompt: "x",
      settingSources: "project",
      model: route.model,
      readOnly: false,
      resumeSessionId: "sess-9",
    });
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("sess-9");
  });

  test("a walled pin is re-picked and the rewritten pin names the new account", async () => {
    process.env.AGENT_GATEWAY_SESSION_ACCOUNTS_DIR = mkdtempSync(join(tmpdir(), "acct-pin-"));
    recordSessionAccount("sess-9", { account: "iu", dir: null });
    __setExhaustionCheckForTests(async (a) => a === "iu");
    __setAccountPickerForTests(async () => ({
      pick: { kind: "dir", dir: "/h/.claude-me" },
      account: "me",
    }));
    const sel = await selectAccount({
      lane: "agent-gateway:check",
      resumeSessionId: "sess-9",
      excludeAccount: "iu",
    });
    expect(sel.account).toBe("me");
    // what maybeWriteSessionEnv does once the resumed session reports its id
    recordSessionAccount("sess-9", { account: "me", dir: "/h/.claude-me" });
    expect(readSessionAccount("sess-9")).toEqual({ account: "me", dir: "/h/.claude-me" });
    delete process.env.AGENT_GATEWAY_SESSION_ACCOUNTS_DIR;
  });
});

describe("account CLI calls", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-cli-"));
  const bin = join(dir, "claude-account");
  const envDump = join(dir, "env.txt");
  const usage = (v: unknown) => JSON.stringify({ accounts: v });
  let usageJson = usage([]);
  const prevBin = process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN;
  const writeBin = () => {
    writeFileSync(
      bin,
      `#!/bin/sh
env > '${envDump}'
case "$1" in
  pick) echo "export CLAUDE_CONFIG_DIR='/h/.claude-me'" ;;
  account) echo me ;;
  usage) cat <<'JSON'
${usageJson}
JSON
  ;;
esac
`,
    );
    chmodSync(bin, 0o755);
  };
  afterEach(() => {
    if (prevBin === undefined) delete process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN;
    else process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN = prevBin;
    delete process.env.AGENT_GATEWAY_TEST_SECRET_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    __setExhaustionCheckForTests();
  });

  test("the CLI gets a minimal env — no tokens — plus CLAUDE_CONFIG_DIR where needed", async () => {
    writeBin();
    process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN = bin;
    process.env.AGENT_GATEWAY_TEST_SECRET_TOKEN = "s3cret";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok";
    const sel = await pickClaudeAccount("agent-gateway:check");
    expect(sel).toEqual({ pick: { kind: "dir", dir: "/h/.claude-me" }, account: "me" });
    // the last call was `account`, which needs the picked dir
    const keys = readFileSync(envDump, "utf8")
      .split("\n")
      .map((l) => l.split("=")[0])
      .filter((k) => k && !["PWD", "SHLVL", "_", "OLDPWD"].includes(k))
      .sort();
    expect(keys).toEqual(
      ["CLAUDE_CONFIG_DIR", "HOME", "LANG", "PATH", "TMPDIR"].filter((k) => keys.includes(k)),
    );
    expect(keys).toContain("CLAUDE_CONFIG_DIR");
    expect(keys).not.toContain("AGENT_GATEWAY_TEST_SECRET_TOKEN");
    expect(keys).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  describe("exhausted check validates the usage shape", () => {
    const check = async (rows: unknown, raw?: string): Promise<boolean> => {
      process.env.AGENT_GATEWAY_SESSION_ACCOUNTS_DIR = mkdtempSync(join(tmpdir(), "acct-pin-"));
      recordSessionAccount("s", { account: "me", dir: "/h/.claude-me" });
      usageJson = raw ?? usage(rows);
      writeBin();
      process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN = bin;
      __setAccountPickerForTests(async () => ({ pick: { kind: "default" }, account: "iu" }));
      const sel = await selectAccount({ lane: "l", resumeSessionId: "s" });
      __setAccountPickerForTests();
      delete process.env.AGENT_GATEWAY_SESSION_ACCOUNTS_DIR;
      return sel.reused !== true; // re-picked ⇔ exhausted
    };
    const future = Math.floor(Date.now() / 1000) + 3600;

    test("a future numeric exhausted_until → exhausted", async () => {
      expect(await check([{ id: "me", exhausted_until: future }])).toBe(true);
    });
    test("past, null, string, other account, non-array, bad JSON → not exhausted", async () => {
      expect(await check([{ id: "me", exhausted_until: 1 }])).toBe(false);
      expect(await check([{ id: "me", exhausted_until: null }])).toBe(false);
      expect(await check([{ id: "me", exhausted_until: String(future) }])).toBe(false);
      expect(await check([{ id: "iu", exhausted_until: future }])).toBe(false);
      expect(await check({ id: "me" })).toBe(false);
      expect(await check(null, "not json")).toBe(false);
    });
  });
});
