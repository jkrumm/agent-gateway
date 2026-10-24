// ── Shared worker plumbing — what both harnesses (and the IU SSE reader) do identically ──
//
// `session-runner.ts` (claude -p) dispatches into `opencode-runner.ts` (OpenCode sessions), and
// both build on `session-core.ts`; anything BOTH need verbatim lives here instead: this module
// imports nothing from any of them. `session-runner.ts` re-exports `scrubSensitiveEnv`
// and `usageLane` so existing importers keep resolving.

import { homedir } from "node:os";
import { join } from "node:path";

/** Env var names that look like a credential. Matched case-insensitively against the
 *  inherited environment and deleted before the worker is spawned. Deliberately broad —
 *  a false positive costs a worker a variable it almost certainly did not need, while a
 *  false negative hands a live token to a session whose prompt may be attacker-written. */
const SENSITIVE_ENV_RE =
  /(TOKEN|SECRET|PASSWORD|PASSWD|_KEY|APIKEY|API_KEY|CREDENTIAL|BEARER|SESSION_ID)/i;

/** Exempt from the scrub: the CLI's own auth path. On the `max` backend the inherited
 *  OAuth profile is how the worker authenticates at all, so scrubbing it would break
 *  every session rather than harden it. The `iu` backend sets its own ANTHROPIC_*
 *  vars after this point regardless. */
const ALWAYS_KEEP_ENV = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);

/** Delete every credential-shaped key (`SENSITIVE_ENV_RE`, less `ALWAYS_KEEP_ENV`) from an
 *  env object IN PLACE. See `workerBaseEnv` and `buildWorkerEnv`'s inline comment for why this
 *  must run before either harness writes its own backend credentials. */
export function scrubSensitiveEnv(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    if (SENSITIVE_ENV_RE.test(key) && !ALWAYS_KEEP_ENV.has(key)) delete env[key];
  }
}

/**
 * The `USAGE_LANE` value for a routed tool — `agent-gateway:<tool>`, coarsened to the part
 * before the first `:` in `tool` itself. `review`'s sub-steps (`review:router`,
 * `review:angle`, `review:adversary`, `review:synthesis`) pass their own sub-tool label
 * through `SessionOptions.tool` for logging/attribution, but usage-tracker's `sub_tool`
 * column is a flat string with no sub-lane concept (`report.ts`'s grouping is a plain
 * `coalesce`, nothing wildcard-aware) — one lane per Max-lane worker keeps
 * `stats --by sub_tool` a single `agent-gateway:review` row instead of four fragments. Single
 * chokepoint so every spawn path (all of them already route through `workerBaseEnv`)
 * gets this for free rather than each call site coarsening its own `tool` string.
 */
export function usageLane(tool: string | undefined): string {
  const base = (tool ?? "unknown").split(":")[0];
  return `agent-gateway:${base}`;
}

/** The env prelude both harnesses share: copy the inherited env (defined entries only), strip
 *  the parent's own session identity, mark the process a worker, tag `USAGE_LANE` (read by
 *  usage-tracker's claude-code collector via hooks/notify.ts's session_env log line to
 *  attribute the worker's cost to its routed tool), THEN scrub every credential-shaped key.
 *  Order is load-bearing: the caller writes its own backend credentials AFTER this returns,
 *  so a scrub placed later would delete the just-written key. */
export function workerBaseEnv(
  baseEnv: Record<string, string | undefined>,
  tool: string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v !== undefined) env[k] = v;
  }
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_PARENT_SESSION_ID;
  env.CLAUDE_ENTRYPOINT = "worker";
  env.USAGE_LANE = usageLane(tool);
  scrubSensitiveEnv(env);
  return env;
}

/** Drain `stream` line by line. `onChunk` fires after every decoded chunk (an idle watchdog's
 *  liveness signal — it resets on each token, not just the first), `onLine` once per complete
 *  non-empty line, trimmed. Returns the trailing partial line (no terminating newline seen),
 *  untouched — a caller that cares parses it, one that does not drops it. The reader lock is
 *  released on every exit path, including a throwing `onLine`. */
export async function readTrimmedLines(
  stream: ReadableStream<Uint8Array>,
  handlers: { onChunk?: () => void; onLine: (line: string) => void },
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buf += decoder.decode(); // flush a multi-byte sequence the final chunk left half-open
        break;
      }
      handlers.onChunk?.();
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) handlers.onLine(trimmed);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return buf;
}

// ── Claude Max account pick (dotfiles docs/claude-accounts.md §Picker) ───────────────────
//
// Two Max subscriptions share the mini; the `claude-account` CLI chooses one per spawn. The
// account is fixed for a session's life (the prompt cache is per organisation), so the pick
// happens once per attempt, never mid-session. Every failure of the picker means "today's
// behaviour": the inherited env, i.e. the default account.

/** What `claude-account pick` answered. `default` = `unset CLAUDE_CONFIG_DIR` (account A),
 *  `dir` = a second account's config dir, `iu` = no Max account has headroom (exit 3),
 *  `unavailable` = the picker failed, timed out or printed something unrecognised. */
export type AccountPick =
  | { kind: "default" }
  | { kind: "dir"; dir: string }
  | { kind: "iu" }
  | { kind: "unavailable" };

/** Pure: parse the picker's stdout + exit code. Never throws. */
export function parseAccountPick(stdout: string, exitCode: number): AccountPick {
  const out = stdout.trim();
  if (exitCode === 3) return out === "iu" ? { kind: "iu" } : { kind: "unavailable" };
  if (exitCode !== 0) return { kind: "unavailable" };
  if (out === "unset CLAUDE_CONFIG_DIR") return { kind: "default" };
  const m = /^export CLAUDE_CONFIG_DIR=(?:'([^']+)'|"([^"]+)"|(\S+))$/.exec(out);
  const dir = m?.[1] ?? m?.[2] ?? m?.[3];
  return dir ? { kind: "dir", dir } : { kind: "unavailable" };
}

/** A pick plus the registry id of the chosen account (`claude-account account`), when known. */
export interface AccountSelection {
  pick: AccountPick;
  /** Registry id (`a`, `b`, …). Undefined when the picker failed or the id lookup did. */
  account?: string;
}

const ACCOUNT_CLI_TIMEOUT_MS = 5000;

const accountBin = (): string =>
  process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN ??
  join(homedir(), ".local", "bin", "claude-account");

/** Run the picker CLI with a hard 5 s cap (a CLI helper, not an agent run). `null` on any
 *  failure — spawn error, timeout, non-zero exit other than 3. */
async function runAccountCli(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ stdout: string; exitCode: number } | null> {
  try {
    const proc = Bun.spawn([accountBin(), ...args], {
      stdout: "pipe",
      stderr: "ignore",
      env,
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), ACCOUNT_CLI_TIMEOUT_MS);
    try {
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return exitCode === 0 || exitCode === 3 ? { stdout, exitCode } : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** Ask the picker for an account for `lane` and resolve its registry id. Never throws. */
async function pickAccountViaCli(lane: string): Promise<AccountSelection> {
  const picked = await runAccountCli(["pick", "--lane", lane], process.env);
  if (!picked) return { pick: { kind: "unavailable" } };
  const pick = parseAccountPick(picked.stdout, picked.exitCode);
  if (pick.kind === "iu" || pick.kind === "unavailable") return { pick };
  const env = { ...process.env };
  if (pick.kind === "dir") env.CLAUDE_CONFIG_DIR = pick.dir;
  else delete env.CLAUDE_CONFIG_DIR;
  const id = await runAccountCli(["account"], env);
  const account = id?.stdout.trim();
  return { pick, ...(account ? { account } : {}) };
}

let accountPicker: (lane: string) => Promise<AccountSelection> = pickAccountViaCli;

export function pickClaudeAccount(lane: string): Promise<AccountSelection> {
  return accountPicker(lane);
}

/** Test seam: replace the picker; call with no argument to restore the real one. */
export function __setAccountPickerForTests(fn?: (lane: string) => Promise<AccountSelection>): void {
  accountPicker = fn ?? pickAccountViaCli;
}

async function markExhaustedViaCli(account: string, untilEpochS: number): Promise<void> {
  await runAccountCli(
    ["exhausted", "--account", account, "--until", String(untilEpochS)],
    process.env,
  );
}

let exhaustedMarker: (account: string, untilEpochS: number) => Promise<void> = markExhaustedViaCli;

/** Mark `account` as out of quota until `untilEpochS` so the next pick routes around it. */
export function markAccountExhausted(account: string, untilEpochS: number): Promise<void> {
  return exhaustedMarker(account, untilEpochS);
}

export function __setExhaustedMarkerForTests(
  fn?: (account: string, untilEpochS: number) => Promise<void>,
): void {
  exhaustedMarker = fn ?? markExhaustedViaCli;
}

/** Epoch seconds a quota wall lifts: the CLI's `limit reached|<epoch>` suffix when present,
 *  else `nowMs` + 1 h. */
export function quotaResetEpochS(text: string | undefined, nowMs: number): number {
  const m = /limit reached\s*\|\s*(\d{10})\b/i.exec(text ?? "");
  const fallback = Math.floor(nowMs / 1000) + 3600;
  const epoch = m ? Number(m[1]) : fallback;
  return epoch > nowMs / 1000 ? epoch : fallback;
}
