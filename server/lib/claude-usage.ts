import { execFile } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";
import { appLogger as logger } from "../logger.ts";
import { accountCliEnv, pickAccountDryWhy, type AccountLanePick } from "../mcp/worker-shared.ts";

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
/** Account id shape — the one definition, used by the CLI parser and the POST body. */
export const ACCOUNT_ID_PATTERN = "^[a-z][a-z0-9-]{0,15}$";
const ACCOUNT_ID_RE = new RegExp(ACCOUNT_ID_PATTERN);
export const DEFAULT_ACCOUNT = "iu";

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

function runCli(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      accountBin(),
      ["usage", "--json"],
      {
        timeout: Number(process.env.AGENT_GATEWAY_CLAUDE_USAGE_TIMEOUT_MS) || CLI_TIMEOUT_MS,
        env: accountCliEnv(),
        maxBuffer: 1024 * 1024,
      },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

// Stale-while-revalidate: the last good result is served immediately; a refresh (at most one in
// flight) starts in the background once it is older than MEMO_MS. Only a cold start (nothing good
// yet) waits, bounded by the CLI timeout. A failed refresh keeps serving the last good result —
// its ages keep growing, so the header turns `stale` on its own.
let lastGood: CliUsage | null = null;
let lastAttempt = 0;
let inflight: Promise<CliUsage | null> | null = null;
let generation = 0;
let failing = false;

function refresh(): Promise<CliUsage | null> {
  if (inflight) return inflight;
  const gen = generation;
  lastAttempt = Date.now();
  const run = (async (): Promise<CliUsage | null> => {
    const stdout = await runCli();
    const usage = stdout == null ? null : parseClaudeUsage(stdout, Date.now());
    if (gen !== generation) return usage; // reset mid-flight (tests): drop the result
    lastAttempt = Date.now();
    if (usage) {
      failing = false;
      lastGood = usage;
    } else if (!failing) {
      failing = true;
      logger.warn(
        { event: "usage.cli_failed", tool: "usage" },
        "claude-account usage --json failed or returned garbage — serving the last good or POSTed values",
      );
    }
    return usage;
  })().finally(() => {
    if (gen === generation) inflight = null;
  });
  inflight = run;
  return run;
}

/** `claude-account usage --json`, stale-while-revalidate (see above). Never throws; null only
 *  when no run has ever succeeded. */
export function readClaudeUsage(): Promise<CliUsage | null> {
  if (lastGood) {
    if (Date.now() - lastAttempt >= MEMO_MS) void refresh();
    return Promise.resolve(lastGood);
  }
  // cold failure inside the memo window: don't hammer the CLI
  if (!inflight && Date.now() - lastAttempt < MEMO_MS) return Promise.resolve(null);
  return refresh();
}

/** Test-only — drops all cached state. */
export function __resetClaudeUsageForTests(): void {
  generation += 1;
  lastGood = null;
  lastAttempt = 0;
  inflight = null;
  failing = false;
}

/** Test-only — makes the cached result look older than the memo window. */
export function __expireClaudeUsageForTests(): void {
  lastAttempt = 0;
}

/** Test-only — resolves when no refresh is in flight. */
export async function __settleClaudeUsageForTests(): Promise<void> {
  await inflight;
}

// ── POSTed statusline values ─────────────────────────────────────────────────────────────────

export interface PostedUsage {
  five_hour_pct: number;
  five_hour_mins_left: number | null;
  seven_day_pct: number | null;
  updated_at: number;
}

const posted = new Map<string, PostedUsage>();

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
    // Only a POST that carries minutes-left moves the reset; otherwise the CLI's stays.
    if (post.five_hour_mins_left != null) {
      fiveResets = Math.round(post.updated_at / 1000 + post.five_hour_mins_left * 60);
    }
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

// ── Per-lane account picks (overview payload only) ──────────────────────────────────────────

export type { AccountLanePick };

/** The lanes `GET /api/overview`'s `quota.picks` carries — every lane `routing.ts`/the dotfiles
 *  picker know about, not every usage lane ever logged. */
export const LANE_PICKS = [
  "interactive",
  "wave",
  "fan",
  "agent-gateway:review",
  "agent-gateway:dispatch",
  "headless",
] as const;

export type LanePicks = Partial<Record<(typeof LANE_PICKS)[number], AccountLanePick>>;

let lastGoodPicks: LanePicks | null = null;
let picksLastAttempt = 0;
let picksInflight: Promise<LanePicks> | null = null;
let picksGeneration = 0;

function refreshLanePicks(): Promise<LanePicks> {
  if (picksInflight) return picksInflight;
  const gen = picksGeneration;
  picksLastAttempt = Date.now();
  const run = (async (): Promise<LanePicks> => {
    const results = await Promise.all(LANE_PICKS.map((lane) => pickAccountDryWhy(lane)));
    // A lane whose fresh pick failed keeps its previous entry — one lane's hiccup must not blank
    // out the other five, and a total failure must not overwrite the last good batch with `{}`.
    const out: LanePicks = Object.fromEntries(
      LANE_PICKS.map((lane, i) => [lane, results[i] ?? lastGoodPicks?.[lane]]).filter(
        (entry): entry is [(typeof LANE_PICKS)[number], AccountLanePick] => entry[1] != null,
      ),
    );
    if (gen !== picksGeneration) return out; // reset mid-flight (tests): drop the result
    picksLastAttempt = Date.now();
    lastGoodPicks = out;
    return out;
  })().finally(() => {
    if (gen === picksGeneration) picksInflight = null;
  });
  picksInflight = run;
  return run;
}

/** Every lane's picked account, `--dry --why` (display only — no shell line sourced, no pick-log
 *  write), same `MEMO_MS` stale-while-revalidate window as `readClaudeUsage` so the overview
 *  never spawns 6 `claude-account` processes per request. A lane that fails to refresh keeps its
 *  last good pick; the whole result is `{}` only when no lane has ever resolved. Never throws. */
export function buildLanePicks(): Promise<LanePicks> {
  if (lastGoodPicks) {
    if (Date.now() - picksLastAttempt >= MEMO_MS) void refreshLanePicks();
    return Promise.resolve(lastGoodPicks);
  }
  if (!picksInflight && Date.now() - picksLastAttempt < MEMO_MS) return Promise.resolve({});
  return refreshLanePicks();
}

/** Test-only — drops all cached picks state; bumps the generation so a refresh already in
 *  flight cannot write `lastGoodPicks` after this returns. */
export function __resetLanePicksForTests(): void {
  picksGeneration += 1;
  lastGoodPicks = null;
  picksLastAttempt = 0;
  picksInflight = null;
}

/** Test-only — makes the cached picks look older than the memo window. */
export function __expireLanePicksForTests(): void {
  picksLastAttempt = 0;
}

/** Test-only — resolves when no lane-picks refresh is in flight. */
export async function __settleLanePicksForTests(): Promise<void> {
  await picksInflight;
}

/** Width of the account id column, shared by the quota header and the agent rows: the longest
 *  enabled id or row account, at least 2. */
export function accountColumnWidth(
  accounts: Record<string, AccountQuota>,
  rowAccounts: Iterable<string | null | undefined>,
): number {
  let width = 2;
  for (const [id, q] of Object.entries(accounts)) if (q.enabled) width = Math.max(width, id.length);
  for (const a of rowAccounts) width = Math.max(width, a?.length ?? 0);
  return width;
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
export function renderQuotaHeader(
  accounts: Record<string, AccountQuota>,
  now: number,
  idWidth: number = accountColumnWidth(accounts, []),
): string[] {
  const enabled = Object.entries(accounts).filter(([, q]) => q.enabled);
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
