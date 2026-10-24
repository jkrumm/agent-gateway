import { execFile } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";
import { appLogger as logger } from "../logger.ts";

// Multi-account Claude Max quota (dotfiles docs/claude-accounts.md §Displays). The quota cache
// is owned by the dotfiles CLI `claude-account`; `claude-account usage --json` reads only its
// local cache files (no network, ~100 ms). This module runs it, merges in the numbers a
// statusline POSTs to `/api/usage`, and renders the two-line quota header of the overview pane.
// Shared by routes/usage.ts, lib/overview-payload.ts and lib/agents.ts so every surface shows
// the same per-account object.

const CLI_TIMEOUT_MS = 5_000;
const MEMO_MS = 15_000;
/** A sample older than this is `stale` — the picker's eligibility cutoff (spec §Rule v1). */
export const STALE_AFTER_MS = 6 * 3600 * 1000;
const ACCOUNT_ID_RE = /^[a-z][a-z0-9-]{0,15}$/;
const DEFAULT_ACCOUNT = "iu";

const nullableNum = z.number().nullable().optional();

const CLI_ACCOUNT = z.object({
  id: z.string().regex(ACCOUNT_ID_RE),
  plan: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  five_hour: nullableNum,
  seven_day: nullableNum,
  five_hour_resets_at: nullableNum,
  seven_day_resets_at: nullableNum,
  age_s: nullableNum,
  five_hour_age_s: nullableNum,
  seven_day_age_s: nullableNum,
  source: z.string().nullable().optional(),
  auth_ok: z.boolean().nullable().optional(),
  exhausted_until: nullableNum,
});
// Unknown fields are ignored (zod strips them). One malformed account row never hides the
// others — rows are validated individually.
const CLI_OUTPUT = z.object({ accounts: z.array(z.unknown()) });

export type CliAccount = z.infer<typeof CLI_ACCOUNT>;

export interface CliUsage {
  /** Epoch ms the CLI was run — the base for every `*_age_s`. */
  fetchedAt: number;
  accounts: CliAccount[];
}

/** Pure: parse `claude-account usage --json` stdout. Null on garbage; invalid rows are dropped. */
export function parseClaudeUsage(stdout: string, fetchedAt: number): CliUsage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  const top = CLI_OUTPUT.safeParse(raw);
  if (!top.success) return null;
  const accounts: CliAccount[] = [];
  for (const row of top.data.accounts) {
    const parsed = CLI_ACCOUNT.safeParse(row);
    if (parsed.success) accounts.push(parsed.data);
  }
  return { fetchedAt, accounts };
}

const accountBin = (): string =>
  process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN ??
  join(homedir(), ".local", "bin", "claude-account");

const SCRUBBED_ENV = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];

function cliEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of SCRUBBED_ENV) delete env[key];
  return env;
}

function runCli(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      accountBin(),
      ["usage", "--json"],
      {
        timeout: Number(process.env.AGENT_GATEWAY_CLAUDE_USAGE_TIMEOUT_MS) || CLI_TIMEOUT_MS,
        env: cliEnv(),
        maxBuffer: 1024 * 1024,
      },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

let memo: { at: number; promise: Promise<CliUsage | null> } | null = null;
let failing = false;

/** `claude-account usage --json`, memoized 15 s (the promise, so concurrent callers share one
 *  run). Never throws; null on any failure, logged once per failure streak. */
export function readClaudeUsage(): Promise<CliUsage | null> {
  const now = Date.now();
  if (memo && now - memo.at < MEMO_MS) return memo.promise;
  const promise = (async (): Promise<CliUsage | null> => {
    const stdout = await runCli();
    const usage = stdout == null ? null : parseClaudeUsage(stdout, Date.now());
    if (usage) {
      failing = false;
    } else if (!failing) {
      failing = true;
      logger.warn(
        { event: "usage.cli_failed", tool: "usage" },
        "claude-account usage --json failed or returned garbage — serving POSTed values only",
      );
    }
    return usage;
  })();
  memo = { at: now, promise };
  return promise;
}

/** Test-only — drops the memo and the failure-streak flag. */
export function __resetClaudeUsageForTests(): void {
  memo = null;
  failing = false;
}

// ── POSTed statusline values ─────────────────────────────────────────────────────────────────

export interface PostedUsage {
  five_hour_pct: number;
  five_hour_mins_left: number | null;
  seven_day_pct: number | null;
  updated_at: number;
}

const posted = new Map<string, PostedUsage>();

export function isAccountId(id: string): boolean {
  return ACCOUNT_ID_RE.test(id);
}

export { DEFAULT_ACCOUNT };

/** Store a POST for `account` and return the stored entry (`updated_at` = now). */
export function recordPostedUsage(
  account: string,
  body: Omit<PostedUsage, "updated_at">,
): PostedUsage {
  const entry = { ...body, updated_at: Date.now() };
  posted.set(account, entry);
  return entry;
}

/** The last POST for `account`, in exactly the shape `GET /api/usage` has always returned as `data`. */
export function postedUsage(account: string): PostedUsage | null {
  return posted.get(account) ?? null;
}

/** Test-only. */
export function __resetPostedUsageForTests(): void {
  posted.clear();
}

// ── Per-account object ───────────────────────────────────────────────────────────────────────

export interface AccountQuota {
  five_hour_pct: number | null;
  seven_day_pct: number | null;
  /** Epoch seconds. */
  five_hour_resets_at: number | null;
  /** Epoch seconds. */
  seven_day_resets_at: number | null;
  five_hour_mins_left: number | null;
  auth_ok: boolean | null;
  /** Epoch seconds; null when the account is not marked exhausted. */
  exhausted_until: number | null;
  enabled: boolean;
  plan: string | null;
  /** Epoch ms of the freshest window value. Null when nothing is known. */
  updated_at: number | null;
  source: string | null;
}

const minsLeft = (resetsAtS: number | null, now: number): number | null =>
  resetsAtS == null ? null : Math.max(0, Math.ceil((resetsAtS * 1000 - now) / 60_000));

/** Pure: one account's object from the CLI row (either may be absent) and its last POST. Per
 *  window, a POST strictly newer than the CLI's sample for that window wins. */
export function mergeAccountQuota(
  cli: CliAccount | undefined,
  cliFetchedAt: number,
  post: PostedUsage | null,
  now: number,
): AccountQuota {
  const winTs = (ageS: number | null | undefined, fallbackAgeS: number | null | undefined) => {
    const age = ageS ?? fallbackAgeS;
    return age == null ? null : cliFetchedAt - age * 1000;
  };
  const fiveTs = winTs(cli?.five_hour_age_s, cli?.age_s);
  const sevenTs = winTs(cli?.seven_day_age_s, cli?.age_s);

  let fiveHourPct = cli?.five_hour ?? null;
  let fiveResets = cli?.five_hour_resets_at ?? null;
  let sevenPct = cli?.seven_day ?? null;
  let updatedAt =
    fiveTs != null && sevenTs != null ? Math.max(fiveTs, sevenTs) : (fiveTs ?? sevenTs);
  let source = cli?.source ?? null;

  if (post && (fiveTs == null || post.updated_at > fiveTs)) {
    fiveHourPct = post.five_hour_pct;
    fiveResets =
      post.five_hour_mins_left == null
        ? null
        : Math.round(post.updated_at / 1000 + post.five_hour_mins_left * 60);
    updatedAt = Math.max(updatedAt ?? 0, post.updated_at);
    source = "post";
  }
  if (post && post.seven_day_pct != null && (sevenTs == null || post.updated_at > sevenTs)) {
    sevenPct = post.seven_day_pct;
    updatedAt = Math.max(updatedAt ?? 0, post.updated_at);
    source = "post";
  }

  return {
    five_hour_pct: fiveHourPct,
    seven_day_pct: sevenPct,
    five_hour_resets_at: fiveResets,
    seven_day_resets_at: cli?.seven_day_resets_at ?? null,
    five_hour_mins_left: minsLeft(fiveResets, now),
    auth_ok: cli?.auth_ok ?? null,
    exhausted_until: cli?.exhausted_until ?? null,
    enabled: cli?.enabled ?? true,
    plan: cli?.plan ?? null,
    updated_at: updatedAt,
    source,
  };
}

/** Every known account (CLI registry ∪ POSTed ids), keyed by id. Disabled accounts included. */
export async function buildAccountQuotas(): Promise<Record<string, AccountQuota>> {
  const cli = await readClaudeUsage();
  const now = Date.now();
  const ids = new Set<string>([...(cli?.accounts.map((a) => a.id) ?? []), ...posted.keys()]);
  const out: Record<string, AccountQuota> = {};
  for (const id of ids) {
    out[id] = mergeAccountQuota(
      cli?.accounts.find((a) => a.id === id),
      cli?.fetchedAt ?? now,
      posted.get(id) ?? null,
      now,
    );
  }
  return out;
}

// ── Overview pane header ─────────────────────────────────────────────────────────────────────

const pad2 = (n: number): string => String(n).padStart(2, "0");
const hhmm = (d: Date): string => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function untilLabel(resetsAtS: number | null, now: number): string {
  if (resetsAtS == null) return "";
  const mins = Math.max(0, Math.ceil((resetsAtS * 1000 - now) / 60_000));
  return mins >= 60 ? `↺${Math.floor(mins / 60)}h${pad2(mins % 60)}m` : `↺${mins}m`;
}

function weeklyLabel(resetsAtS: number | null): string {
  if (resetsAtS == null) return "";
  const d = new Date(resetsAtS * 1000);
  return `↺${WEEKDAYS[d.getDay()]} ${hhmm(d)}`;
}

const pct = (v: number | null): string => (v == null ? "?" : `${Math.round(v)}%`);

/** One line per enabled account: `iu  5h 8% ↺2h31m · 7d 88% ↺Tue 17:00`, plus `exhausted until
 *  HH:MM` / `auth!` / `stale` (sample older than 6 h) markers. Empty array when no account is
 *  enabled. Times are local (the mini's zone). */
export function renderQuotaHeader(accounts: Record<string, AccountQuota>, now: number): string[] {
  const enabled = Object.entries(accounts).filter(([, q]) => q.enabled);
  const idWidth = Math.max(0, ...enabled.map(([id]) => id.length));
  return enabled.map(([id, q]) => {
    const five = `5h ${pct(q.five_hour_pct)} ${untilLabel(q.five_hour_resets_at, now)}`.trimEnd();
    const seven = `7d ${pct(q.seven_day_pct)} ${weeklyLabel(q.seven_day_resets_at)}`.trimEnd();
    let line = `${id.padEnd(idWidth)}  ${five} · ${seven}`;
    if (q.exhausted_until != null && q.exhausted_until * 1000 > now) {
      line += ` · exhausted until ${hhmm(new Date(q.exhausted_until * 1000))}`;
    }
    if (q.auth_ok === false) line += " · auth!";
    if (q.updated_at == null || now - q.updated_at > STALE_AFTER_MS) line += " · stale";
    return line;
  });
}
