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
  __setSpawnForTests,
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
import { __resetIuConfigForTests } from "../lib/iu-openai.ts";
import {
  chmodSync,
  existsSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import {
  __setAccountPickerForTests,
  __setDefaultAccountForTests,
  markAccountExhausted,
  pruneSessionAccounts,
  pickAccountDryWhy,
  pickClaudeAccount,
  __setExhaustedMarkerForTests,
  __setExhaustionCheckForTests,
  parseAccountPick,
  parseAccountPickWhy,
  quotaResetEpochS,
  readSessionAccount,
  recordSessionAccount,
  selectAccount,
  type AccountSelection,
} from "./worker-shared.ts";

// A real directory: pins whose dir has vanished are discarded on read.
const ME_DIR = mkdtempSync(join(tmpdir(), "claude-me-"));

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

describe("parseAccountPickWhy", () => {
  test("iu pick: the default account", () => {
    expect(
      parseAccountPickWhy("unset CLAUDE_CONFIG_DIR\n# picked=iu reason=home stale=false\n", 0),
    ).toEqual({ picked: "iu", reason: "home", stale: false });
  });
  test("me pick: a second account's config dir", () => {
    expect(
      parseAccountPickWhy(
        "export CLAUDE_CONFIG_DIR='/Users/x/.claude-me'\n# picked=me reason=pace stale=true\n",
        0,
      ),
    ).toEqual({ picked: "me", reason: "pace", stale: true });
  });
  test("spill: exit 3, picked is literally 'spill'", () => {
    expect(
      parseAccountPickWhy("spill\n# picked=spill reason=no-eligible-account stale=false\n", 3),
    ).toEqual({ picked: "spill", reason: "no-eligible-account", stale: false });
  });
  test("garbage output → null", () => {
    expect(parseAccountPickWhy("garbage\n", 0)).toBeNull();
    expect(parseAccountPickWhy("", 0)).toBeNull();
  });
  test("non-zero, non-spill exit → null even with a comment line present", () => {
    expect(
      parseAccountPickWhy(
        "unset CLAUDE_CONFIG_DIR\n# picked=iu reason=registry-error stale=false\n",
        4,
      ),
    ).toBeNull();
  });
  test("CRLF line endings are tolerated", () => {
    expect(
      parseAccountPickWhy("unset CLAUDE_CONFIG_DIR\r\n# picked=iu reason=home stale=false\r\n", 0),
    ).toEqual({ picked: "iu", reason: "home", stale: false });
  });
  test("two comment lines: the last one wins", () => {
    expect(
      parseAccountPickWhy(
        "# picked=iu reason=home stale=false\n# picked=me reason=pace stale=true\n",
        0,
      ),
    ).toEqual({ picked: "me", reason: "pace", stale: true });
  });
  test("exit 3 with no comment line → null", () => {
    expect(parseAccountPickWhy("spill\n", 3)).toBeNull();
  });
});

describe("pickAccountDryWhy", () => {
  const dir = mkdtempSync(join(tmpdir(), "acct-pickwhy-"));
  const bin = join(dir, "claude-account");
  const argsDump = join(dir, "args.txt");
  const prevBin = process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN;
  afterEach(() => {
    if (prevBin === undefined) delete process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN;
    else process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN = prevBin;
  });

  test("passes --lane, --dry, --why and parses the answer; one spawn, no account lookup", async () => {
    writeFileSync(
      bin,
      `#!/bin/sh\necho "$@" > '${argsDump}'\necho "export CLAUDE_CONFIG_DIR='${ME_DIR}'"\necho "# picked=me reason=home stale=false"\n`,
    );
    chmodSync(bin, 0o755);
    process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN = bin;
    expect(await pickAccountDryWhy("wave")).toEqual({
      picked: "me",
      reason: "home",
      stale: false,
    });
    expect(readFileSync(argsDump, "utf8").trim()).toBe("pick --lane wave --dry --why");
  });

  test("missing binary → null, never throws", async () => {
    process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN = join(dir, "nope");
    expect(await pickAccountDryWhy("wave")).toBeNull();
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
      claudeConfigDir: ME_DIR,
      baseEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok", PATH: "/bin" },
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe(ME_DIR);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
  test("an extraEnv token cannot sneak back in next to a config dir", () => {
    const env = buildWorkerEnv({
      ...base,
      claudeConfigDir: ME_DIR,
      extraEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
  test("null unsets an inherited dir and drops that dir's token with it", () => {
    const env = buildWorkerEnv({
      ...base,
      claudeConfigDir: null,
      baseEnv: { CLAUDE_CONFIG_DIR: "/h/.claude-me", CLAUDE_CODE_OAUTH_TOKEN: "tok" },
    });
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
  test("null with no inherited dir keeps today's token behaviour", () => {
    const env = buildWorkerEnv({
      ...base,
      claudeConfigDir: null,
      baseEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
    });
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
    expect(marks.map(([a]) => a)).toEqual(["iu", "me"]); // the second wall is marked before the iu fallback
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
    recordSessionAccount("sess-1", { account: "me", dir: ME_DIR });
    expect(readSessionAccount("sess-1")).toEqual({ account: "me", dir: ME_DIR });
    recordSessionAccount("../evil", { account: "me", dir: null });
    expect(readSessionAccount("../evil")).toBeNull();
    expect(readSessionAccount("missing")).toBeNull();
  });

  test("resume reuses the pinned account without picking", async () => {
    freshDir();
    recordSessionAccount("sess-1", { account: "me", dir: ME_DIR });
    __setExhaustionCheckForTests(async () => false);
    __setAccountPickerForTests(picker({ pick: { kind: "default" }, account: "iu" }));
    const sel = await selectAccount({ lane: "agent-gateway:check", resumeSessionId: "sess-1" });
    expect(sel).toEqual({
      pick: { kind: "dir", dir: ME_DIR },
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
    recordSessionAccount("sess-1", { account: "me", dir: ME_DIR });
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
    __setAccountPickerForTests(picker({ pick: { kind: "dir", dir: ME_DIR }, account: "me" }));
    expect((await selectAccount({ lane: "l", excludeAccount: "iu" })).account).toBe("me");
  });

  test("the pin of the excluded account is not reused on resume", async () => {
    freshDir();
    recordSessionAccount("sess-1", { account: "iu", dir: null });
    __setExhaustionCheckForTests(async () => false);
    __setAccountPickerForTests(picker({ pick: { kind: "dir", dir: ME_DIR }, account: "me" }));
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
      pick: { kind: "dir", dir: ME_DIR },
      account: "me",
    }));
    const sel = await selectAccount({
      lane: "agent-gateway:check",
      resumeSessionId: "sess-9",
      excludeAccount: "iu",
    });
    expect(sel.account).toBe("me");
    // what maybeWriteSessionEnv does once the resumed session reports its id
    recordSessionAccount("sess-9", { account: "me", dir: ME_DIR });
    expect(readSessionAccount("sess-9")).toEqual({ account: "me", dir: ME_DIR });
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
  pick) echo "export CLAUDE_CONFIG_DIR='${ME_DIR}'" ;;
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
    expect(sel).toEqual({ pick: { kind: "dir", dir: ME_DIR }, account: "me" });
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
      recordSessionAccount("s", { account: "me", dir: ME_DIR });
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

describe("round 3 — classifier, env, fail-closed, pins, clamp", () => {
  test("a bare 'limit reached' is not a wall; named windows and the epoch suffix are", () => {
    expect(isDefinitiveQuotaError("rate limit reached, retry shortly")).toBe(false);
    expect(isDefinitiveQuotaError("limit reached")).toBe(false);
    expect(isDefinitiveQuotaError("5-hour limit reached")).toBe(true);
    expect(isDefinitiveQuotaError("weekly limit reached")).toBe(true);
    expect(isDefinitiveQuotaError("Claude AI usage limit reached")).toBe(true);
    expect(isDefinitiveQuotaError("limit reached|1792000000")).toBe(true);
  });

  test("generic 'quota exceeded' wording is not a wall (billing / transient)", () => {
    expect(isDefinitiveQuotaError("You exceeded your current quota, please check your plan")).toBe(
      false,
    );
    expect(isDefinitiveQuotaError("quota exceeded, retry shortly")).toBe(false);
  });

  const base = {
    tool: "check",
    backend: "max" as const,
    model: "claude-sonnet-5-5",
    anthropicBase: "",
    iuKey: "",
  };
  test("an inherited dir + token with claudeConfigDir undefined keeps the token", () => {
    const env = buildWorkerEnv({
      ...base,
      baseEnv: { CLAUDE_CONFIG_DIR: ME_DIR, CLAUDE_CODE_OAUTH_TOKEN: "tok" },
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe(ME_DIR);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
  });
  test("a dir set through extraEnv drops the token", () => {
    const env = buildWorkerEnv({
      ...base,
      extraEnv: { CLAUDE_CONFIG_DIR: ME_DIR },
      baseEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  describe("exclude + unknown id fails closed", () => {
    afterEach(() => {
      __setAccountPickerForTests();
      __setDefaultAccountForTests();
    });
    test("selectAccount: a pick whose id is unresolved → iu; unavailable stays unavailable", async () => {
      __setAccountPickerForTests(async () => ({ pick: { kind: "default" } }));
      expect(await selectAccount({ lane: "l", excludeAccount: "iu" })).toEqual({
        pick: { kind: "iu" },
      });
      __setAccountPickerForTests(async () => ({ pick: { kind: "unavailable" } }));
      expect((await selectAccount({ lane: "l", excludeAccount: "iu" })).pick.kind).toBe(
        "unavailable",
      );
    });
    test("selectAccount: without an exclude an unresolved id is accepted", async () => {
      __setAccountPickerForTests(async () => ({ pick: { kind: "default" } }));
      expect((await selectAccount({ lane: "l" })).pick.kind).toBe("default");
    });
    test("resolveAttemptAccount: spill, no fallback, default id unknown, exclude set → walled", async () => {
      __setAccountPickerForTests(async () => ({ pick: { kind: "iu" } }));
      __setDefaultAccountForTests(async () => undefined);
      expect(
        await resolveAttemptAccount({ tool: "check", hasIuFallback: false, excludeAccount: "me" }),
      ).toEqual({ kind: "walled", account: "me" });
    });
    test("resolveAttemptAccount: picker unavailable + exclude: iu when a fallback exists, else inherited", async () => {
      __setAccountPickerForTests(async () => ({ pick: { kind: "unavailable" } }));
      expect(
        await resolveAttemptAccount({ tool: "check", hasIuFallback: true, excludeAccount: "me" }),
      ).toEqual({ kind: "iu" });
      expect(
        await resolveAttemptAccount({ tool: "check", hasIuFallback: false, excludeAccount: "me" }),
      ).toEqual({ kind: "spawn", claudeConfigDir: undefined });
      expect(await resolveAttemptAccount({ tool: "check", hasIuFallback: true })).toEqual({
        kind: "spawn",
        claudeConfigDir: undefined,
      });
    });
  });

  describe("pins", () => {
    const pinDir = () =>
      (process.env.AGENT_GATEWAY_SESSION_ACCOUNTS_DIR = mkdtempSync(join(tmpdir(), "acct-pin-")));
    afterEach(() => delete process.env.AGENT_GATEWAY_SESSION_ACCOUNTS_DIR);

    test("prune removes only old regular <id>.json files and survives odd entries", () => {
      const dir = pinDir();
      const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
      const mk = (name: string, aged = true) => {
        writeFileSync(join(dir, name), "{}");
        if (aged) utimesSync(join(dir, name), old, old);
      };
      mk("old-1.json");
      mk("fresh-1.json", false);
      mk("notes.txt");
      mk("bad name.json");
      mkdirSync(join(dir, "dir.json"));
      utimesSync(join(dir, "dir.json"), old, old);
      symlinkSync(join(dir, "fresh-1.json"), join(dir, "link.json"));
      pruneSessionAccounts();
      expect(existsSync(join(dir, "old-1.json"))).toBe(false);
      for (const kept of ["fresh-1.json", "notes.txt", "bad name.json", "dir.json", "link.json"]) {
        expect(existsSync(join(dir, kept))).toBe(true);
      }
      expect(() => pruneSessionAccounts()).not.toThrow();
    });

    test("a pin write leaves no tmp file; a symlinked or directory pin reads as null", () => {
      const dir = pinDir();
      recordSessionAccount("p5", { account: "iu", dir: null });
      expect(readdirSync(dir)).toEqual(["p5.json"]);
      symlinkSync(join(dir, "p5.json"), join(dir, "p6.json"));
      mkdirSync(join(dir, "p7.json"));
      expect(readSessionAccount("p5")).toEqual({ account: "iu", dir: null });
      expect(readSessionAccount("p6")).toBeNull();
      expect(readSessionAccount("p7")).toBeNull();
    });

    test("pin read validation: empty account, empty dir, missing dir", () => {
      const dir = pinDir();
      const put = (id: string, v: unknown) =>
        writeFileSync(join(dir, `${id}.json`), JSON.stringify(v));
      put("p1", { account: "", dir: null });
      put("p2", { account: "iu", dir: "" });
      put("p3", { account: "me", dir: join(dir, "gone") });
      put("p4", { account: "me", dir });
      expect(readSessionAccount("p1")).toBeNull();
      expect(readSessionAccount("p2")).toEqual({ account: "iu", dir: null });
      expect(readSessionAccount("p3")).toBeNull();
      expect(readSessionAccount("p4")).toEqual({ account: "me", dir });
    });
  });

  test("a far-future reset epoch is clamped to now + 7 d", () => {
    const now = Date.UTC(2026, 9, 24, 12, 0, 0);
    const far = Math.floor(now / 1000) + 90 * 24 * 3600;
    expect(quotaResetEpochS(`usage limit reached|${far}`, now)).toBe(
      Math.floor(now / 1000) + 7 * 24 * 3600,
    );
  });

  test("exit 3 counts as a result only for pick", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-cli3-"));
    const bin = join(dir, "claude-account");
    writeFileSync(bin, "#!/bin/sh\necho spill\nexit 3\n");
    chmodSync(bin, 0o755);
    const prev = process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN;
    process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN = bin;
    try {
      expect((await pickClaudeAccount("l")).pick.kind).toBe("iu");
      expect(await markAccountExhausted("me", 1)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN;
      else process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN = prev;
    }
  });
});

describe("runSessionAttempt — picked account end to end (stub spawn)", () => {
  const route: ToolRoute = {
    model: "claude-sonnet-5-5",
    backend: "max",
    fallback: null,
    transport: "session",
    harness: "claude",
  };
  const saved = { ...process.env };
  afterEach(() => {
    __setSpawnForTests();
    __setAccountPickerForTests();
    __resetBreakersForTests();
    for (const k of [
      "AGENT_GATEWAY_SESSION_ACCOUNTS_DIR",
      "AGENT_GATEWAY_CLAUDE_LOG_DIR",
      "AGENT_GATEWAY_SESSIONS_LOG",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("env carries the picked dir without the OAuth token; the pin and session_env name the account", async () => {
    const work = mkdtempSync(join(tmpdir(), "acct-run-"));
    const accountDir = join(work, "claude-me");
    mkdirSync(accountDir);
    const envDump = join(work, "env.txt");
    process.env.AGENT_GATEWAY_SESSION_ACCOUNTS_DIR = join(work, "pins");
    process.env.AGENT_GATEWAY_CLAUDE_LOG_DIR = join(work, "logs");
    process.env.AGENT_GATEWAY_SESSIONS_LOG = join(work, "sessions.jsonl");
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "inherited-token";
    __setAccountPickerForTests(async () => ({
      pick: { kind: "dir", dir: accountDir },
      account: "me",
    }));
    const events = [
      { type: "system", subtype: "init", session_id: "sess-run-1" },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "{}",
        session_id: "sess-run-1",
        num_turns: 1,
      },
    ];
    const script = `env > '${envDump}'\ncat <<'EOF'\n${events.map((e) => JSON.stringify(e)).join("\n")}\nEOF\n`;
    __setSpawnForTests((_cmd, opts) =>
      Bun.spawn(["sh", "-c", script], { ...opts, stdin: "ignore" }),
    );

    const r = await runSession({ cwd: work, prompt: "x", route, tool: "check" });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);

    const env = readFileSync(envDump, "utf8");
    expect(env).toContain(`CLAUDE_CONFIG_DIR=${accountDir}`);
    expect(env).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");

    expect(readSessionAccount("sess-run-1")).toEqual({ account: "me", dir: accountDir });

    const logFile = join(work, "logs", `${new Date().toISOString().slice(0, 10)}.jsonl`);
    const lines = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const line = lines.find((l) => l.event === "session_env" && l.data.session === "sess-run-1");
    expect(line.data.account).toBe("me");
    expect(line.data.backend).toBe("max");

    // The sessions log row has its own sessionId, so it must name the account itself.
    const sessions = readFileSync(join(work, "sessions.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(sessions.at(-1)).toMatchObject({ tool: "check", backend: "max", account: "me" });
  });
});

describe("runSession — wall on one account, retry on the other, second wall → iu (stub spawn)", () => {
  const route: ToolRoute = {
    model: "claude-sonnet-5-5",
    backend: "max",
    fallback: { backend: "iu" },
    transport: "session",
    harness: "claude",
  };
  const saved = { ...process.env };
  afterEach(() => {
    __setSpawnForTests();
    __setAccountPickerForTests();
    __setExhaustedMarkerForTests();
    __resetBreakersForTests();
    __resetFallbackLogForTests();
    for (const k of [
      "IU_API_KEY",
      "IU_BASE_URL",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "AGENT_GATEWAY_SESSION_ACCOUNTS_DIR",
      "AGENT_GATEWAY_CLAUDE_LOG_DIR",
    ]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    __resetIuConfigForTests();
  });

  const wall = (text: string) =>
    `cat <<'EOF'\n${JSON.stringify({ type: "result", subtype: "success", is_error: true, result: text, num_turns: 0 })}\nEOF\nexit 1\n`;
  const okRun = `cat <<'EOF'\n${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "{}", session_id: "sess-iu", num_turns: 1 })}\nEOF\n`;

  test("two Max spawns at most, the second on the other dir without the token; both accounts marked", async () => {
    const work = mkdtempSync(join(tmpdir(), "acct-wall-"));
    process.env.IU_API_KEY = "iu-key";
    process.env.IU_BASE_URL = "https://iu.example/anthropic";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "inherited-token";
    process.env.AGENT_GATEWAY_SESSION_ACCOUNTS_DIR = join(work, "pins");
    process.env.AGENT_GATEWAY_CLAUDE_LOG_DIR = join(work, "logs");
    __resetIuConfigForTests();

    const picks = [
      { pick: { kind: "default" as const }, account: "iu" },
      { pick: { kind: "dir" as const, dir: ME_DIR }, account: "me" },
    ];
    let pickCalls = 0;
    __setAccountPickerForTests(async () => picks[pickCalls++] ?? { pick: { kind: "iu" as const } });
    const marks: string[] = [];
    __setExhaustedMarkerForTests(async (a) => {
      marks.push(a);
      return true;
    });
    const scripts = [
      wall("Claude AI usage limit reached|1792000000"),
      wall("5-hour limit reached"),
      okRun,
    ];
    const envs: Record<string, string>[] = [];
    __setSpawnForTests((_cmd, opts) => {
      const script = scripts[envs.length] ?? wall("unexpected extra spawn");
      envs.push(opts.env);
      return Bun.spawn(["sh", "-c", script], { ...opts, stdin: "ignore" });
    });

    const r = await runSession({ cwd: work, prompt: "x", route, tool: "check" });

    expect(r.ok).toBe(true);
    expect(envs.length).toBe(3);
    // spawn 1: default account (dir unset); spawn 2: the other account, no token
    expect(envs[0]!.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(envs[1]!.CLAUDE_CONFIG_DIR).toBe(ME_DIR);
    expect(envs[1]!.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    // spawn 3 is the iu lane, not a third Max spawn
    expect(envs[2]!.ANTHROPIC_BASE_URL).toBe("https://iu.example/anthropic");
    expect(envs[2]!.ANTHROPIC_AUTH_TOKEN).toBe("iu-key");
    expect(pickCalls).toBe(2);
    // both walled accounts are marked, the second one before the iu fallback
    expect(marks).toEqual(["iu", "me"]);
  });
});
