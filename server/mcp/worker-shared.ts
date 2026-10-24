// ── Shared worker plumbing — what both harnesses (and the IU SSE reader) do identically ──
//
// `session-runner.ts` (claude -p) dispatches into `opencode-runner.ts` (OpenCode sessions), and
// both build on `session-core.ts`; anything BOTH need verbatim lives here instead: this module
// imports nothing from any of them. `session-runner.ts` re-exports `scrubSensitiveEnv`
// and `usageLane` so existing importers keep resolving.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
 *  `dir` = a second account's config dir, `iu` = no Max account has headroom (exit 3; stdout `spill` or `iu`),
 *  `unavailable` = the picker failed, timed out or printed something unrecognised. */
export type AccountPick =
  | { kind: "default" }
  | { kind: "dir"; dir: string }
  | { kind: "iu" }
  | { kind: "unavailable" };

/** Pure: parse the picker's stdout + exit code. Never throws. */
export function parseAccountPick(stdout: string, exitCode: number): AccountPick {
  const out = stdout.trim();
  // Exit 3 is the spill signal; stdout is `spill` (current) or `iu` (older picker), not keyed on.
  if (exitCode === 3) return { kind: "iu" };
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
  /** The account was inherited from the session being resumed, not freshly picked. */
  reused?: true;
}

const ACCOUNT_CLI_TIMEOUT_MS = 5000;

const accountBin = (): string =>
  process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN ??
  join(homedir(), ".local", "bin", "claude-account");

/** The picker CLI's env: the four vars it needs to find bun, the keychain and a temp dir —
 *  never the worker/parent credentials — plus the config dir when the call is about one. */
export function accountCliEnv(configDir?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG"]) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  if (configDir !== undefined) env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

/** Run the picker CLI with a hard 5 s cap (a CLI helper, not an agent run). `null` on any
 *  failure — spawn error, timeout, non-zero exit other than 3. */
async function runAccountCli(
  args: string[],
  env: Record<string, string>,
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
      // Exit 3 is the picker's spill signal; for any other subcommand it is just a failure.
      return exitCode === 0 || (exitCode === 3 && args[0] === "pick") ? { stdout, exitCode } : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** Ask the picker for an account for `lane` and resolve its registry id. Never throws. */
async function pickAccountViaCli(lane: string): Promise<AccountSelection> {
  const picked = await runAccountCli(["pick", "--lane", lane], accountCliEnv());
  if (!picked) return { pick: { kind: "unavailable" } };
  const pick = parseAccountPick(picked.stdout, picked.exitCode);
  if (pick.kind === "iu" || pick.kind === "unavailable") return { pick };
  const id = await runAccountCli(
    ["account"],
    accountCliEnv(pick.kind === "dir" ? pick.dir : undefined),
  );
  const account = id?.stdout.trim();
  return { pick, ...(account ? { account } : {}) };
}

/** Registry id of the default account (`CLAUDE_CONFIG_DIR` unset); undefined when unknown. */
async function defaultAccountViaCli(): Promise<string | undefined> {
  const out = await runAccountCli(["account"], accountCliEnv());
  return out?.stdout.trim() || undefined;
}

let defaultAccountLookup: () => Promise<string | undefined> = defaultAccountViaCli;

export function defaultAccountId(): Promise<string | undefined> {
  return defaultAccountLookup();
}

export function __setDefaultAccountForTests(fn?: () => Promise<string | undefined>): void {
  defaultAccountLookup = fn ?? defaultAccountViaCli;
}

let accountPicker: (lane: string) => Promise<AccountSelection> = pickAccountViaCli;

export function pickClaudeAccount(lane: string): Promise<AccountSelection> {
  return accountPicker(lane);
}

/** Test seam: replace the picker; call with no argument to restore the real one. */
export function __setAccountPickerForTests(fn?: (lane: string) => Promise<AccountSelection>): void {
  accountPicker = fn ?? pickAccountViaCli;
}

async function markExhaustedViaCli(account: string, untilEpochS: number): Promise<boolean> {
  const out = await runAccountCli(
    ["exhausted", "--account", account, "--until", String(untilEpochS)],
    accountCliEnv(),
  );
  return out?.exitCode === 0;
}

let exhaustedMarker: (account: string, untilEpochS: number) => Promise<boolean> =
  markExhaustedViaCli;

/** Mark `account` as out of quota until `untilEpochS` so the next pick routes around it.
 *  Resolves `false` when the CLI failed (the caller logs it). */
export function markAccountExhausted(account: string, untilEpochS: number): Promise<boolean> {
  return exhaustedMarker(account, untilEpochS);
}

export function __setExhaustedMarkerForTests(
  fn?: (account: string, untilEpochS: number) => Promise<boolean>,
): void {
  exhaustedMarker = fn ?? markExhaustedViaCli;
}

const QUOTA_RESET_MAX_S = 7 * 24 * 3600;

/** Epoch seconds a quota wall lifts: the CLI's `limit reached|<epoch>` suffix when present,
 *  else `nowMs` + 1 h. */
export function quotaResetEpochS(text: string | undefined, nowMs: number): number {
  const m = /limit reached\s*\|\s*(\d{10})\b/i.exec(text ?? "");
  const fallback = Math.floor(nowMs / 1000) + 3600;
  const epoch = m ? Number(m[1]) : fallback;
  if (epoch <= nowMs / 1000) return fallback;
  return Math.min(epoch, Math.floor(nowMs / 1000) + QUOTA_RESET_MAX_S); // a bogus far-future epoch must not park an account
}

// ── Session → account pin ────────────────────────────────────────────────────────────────
//
// The prompt cache is per organisation, so a resumed session (`--resume`, a crash re-run of a
// dispatch episode) must run on the account it started on. The claude session id is recorded
// next to the account the moment it is known; a later attempt resuming that id reuses the
// account unless it has since hit a wall. A sidecar file per session (not a job column): the
// session id is all a resume carries, and the picker's id → dir mapping lives outside the job
// store.

interface SessionAccountPin {
  account: string;
  /** Config dir the session ran under; `null` = the default account (env unset). */
  dir: string | null;
}

const SESSION_ACCOUNT_RETENTION_MS = 30 * 24 * 3600 * 1000;

const sessionAccountDir = (): string =>
  process.env.AGENT_GATEWAY_SESSION_ACCOUNTS_DIR ??
  join(homedir(), ".local", "state", "agent-gateway", "session-accounts");

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

const SESSION_PIN_FILE_RE = /^[A-Za-z0-9_-]+\.json$/;

/** Delete pins older than 30 days: regular `<sessionId>.json` files only, each entry on its own
 *  try so one unreadable entry never stops the sweep. Runs once per process, lazily, before the
 *  first pin is written. */
export function pruneSessionAccounts(): void {
  const dir = sessionAccountDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - SESSION_ACCOUNT_RETENTION_MS;
  for (const name of entries) {
    if (!SESSION_PIN_FILE_RE.test(name)) continue;
    try {
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isFile() && st.mtimeMs < cutoff) unlinkSync(path);
    } catch {
      /* skip this entry */
    }
  }
}

let pinsPruned = false;

/** Record which account a claude session runs under. Best-effort, never throws. */
export function recordSessionAccount(sessionId: string, pin: SessionAccountPin): void {
  if (!SESSION_ID_RE.test(sessionId)) return;
  try {
    if (!pinsPruned) {
      pinsPruned = true;
      pruneSessionAccounts();
    }
    const dir = sessionAccountDir();
    mkdirSync(dir, { recursive: true });
    // tmp + rename: a reader never sees a half-written pin
    const tmp = join(dir, `.${sessionId}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(pin));
    renameSync(tmp, join(dir, `${sessionId}.json`));
  } catch {
    /* a missing pin only costs a re-pick */
  }
}

/** The pin for a session, or null when absent or unusable: it needs a non-empty account, an
 *  empty dir reads as the default account, and a pinned dir must still exist. */
export function readSessionAccount(sessionId: string): SessionAccountPin | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  try {
    const path = join(sessionAccountDir(), `${sessionId}.json`);
    if (!lstatSync(path).isFile()) return null; // never follow a symlink or read a directory
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw?.account !== "string" || raw.account === "") return null;
    const dir = typeof raw.dir === "string" && raw.dir !== "" ? raw.dir : null;
    if (dir !== null && !existsSync(dir)) return null;
    return { account: raw.account, dir };
  } catch {
    return null;
  }
}

/** Is `account` currently marked exhausted (`claude-account usage --json`)? A CLI failure reads
 *  as "not exhausted": keeping the pin (warm cache) beats re-picking blind. */
async function accountExhaustedViaCli(account: string): Promise<boolean> {
  const out = await runAccountCli(["usage", "--json"], accountCliEnv());
  if (!out) return false;
  try {
    const rows: unknown = JSON.parse(out.stdout)?.accounts;
    if (!Array.isArray(rows)) return false;
    const nowS = Date.now() / 1000;
    return rows.some(
      (r) =>
        r !== null &&
        typeof r === "object" &&
        r.id === account &&
        typeof r.exhausted_until === "number" &&
        r.exhausted_until > nowS,
    );
  } catch {
    return false;
  }
}

let exhaustionCheck: (account: string) => Promise<boolean> = accountExhaustedViaCli;

export function __setExhaustionCheckForTests(fn?: (account: string) => Promise<boolean>): void {
  exhaustionCheck = fn ?? accountExhaustedViaCli;
}

/** The account for one `claude -p` attempt. A resumed session reuses its pinned account unless
 *  that is exhausted; otherwise a fresh pick. `excludeAccount` (the account that just hit a
 *  wall) must not come back: when the picker returns it anyway, answer `iu` instead. */
export async function selectAccount(input: {
  lane: string;
  resumeSessionId?: string;
  excludeAccount?: string;
}): Promise<AccountSelection> {
  const { lane, resumeSessionId, excludeAccount } = input;
  const pinned = resumeSessionId ? readSessionAccount(resumeSessionId) : null;
  if (pinned && pinned.account !== excludeAccount && !(await exhaustionCheck(pinned.account))) {
    return {
      pick: pinned.dir === null ? { kind: "default" } : { kind: "dir", dir: pinned.dir },
      account: pinned.account,
      reused: true,
    };
  }
  const selected = await pickClaudeAccount(lane);
  if (excludeAccount !== undefined && selected.pick.kind !== "unavailable") {
    // The picked account must be provably not the walled one: an unresolved id fails closed too.
    if (selected.account === undefined || selected.account === excludeAccount) {
      return { pick: { kind: "iu" } };
    }
  }
  return selected;
}
