import { z } from "zod";
import { appLogger as logger } from "../logger.ts";
import {
  RESET,
  BOLD,
  BOLD_RED,
  GREEN,
  MIN_TITLE_CHARS,
  clampLine,
  clampVisible,
  relativeAge,
  stripControlBytes,
  truncate,
} from "./render-text-utils.ts";

// One producer for warden's `GET /board` snapshot, consumed by
// server/lib/overview-payload.ts (folded into the same 45 s cache window as the agents
// snapshot) and rendered by server/lib/agents.ts's `renderText`. warden is the control plane
// on this box — a loopback-only, unauthenticated, read-only HTTP API at
// `http://127.0.0.1:7735` (`~/SourceRoot/warden`, docs/api.md's `### GET /board`). Never
// throws: an unreachable/misconfigured/schema-mismatched warden degrades to `{ ok: false }`,
// never a 500 or a delayed overview.

const WARDEN_BOARD_TIMEOUT_MS = 2_000;
const WARDEN_ITEMS_CAP = 20;

// warden's own `counts` (scripts/api.py `CHAIN_STATES`) always carries the seven non-terminal
// chain states with a guaranteed zero, but any *other* non-terminal state present in the
// ledger (e.g. a future `snoozed`) still appears without one — an index signature keeps an unrecognized key readable instead
// of dropped.
export interface WardenCounts {
  new: number;
  triaged: number;
  working: number;
  merging: number;
  verifying: number;
  needs_decision: number;
  failed: number;
  [state: string]: number;
}

export interface WardenItem {
  eventId: string | number;
  origin: string;
  /** `null` for an item not tied to a repo — warden's ledger allows it. */
  repo: string | null;
  state: string;
  title: string;
  note: string | null;
  prUrl: string | null;
  updatedAt: string;
  /** `validation_job ?? implement_job ?? dispatch_job ?? null` — the one job id, if any, an
   *  observer would poll to see this item's current in-flight work. */
  inFlightJob: string | null;
}

export type WardenBoard =
  | {
      ok: true;
      generatedAt: string;
      counts: WardenCounts;
      /** Sum of every `counts` value — warden counts only non-terminal states (terminal =
       *  fixed/quiet/closed), and `failed` is non-terminal (it waits on the owner), so this is
       *  the total open item count without re-deriving terminality here. */
      open: number;
      items: WardenItem[];
      /** True only when warden's own `items` exceeded our 20-item cap — omitted-vs-false is
       *  not meaningful here, always present on the ok branch. */
      itemsTruncated: boolean;
      terminal24h: number;
      fetchedAt: number;
    }
  | { ok: false; error: string; fetchedAt: number };

// The seven chain states warden's own `counts` always carries with a guaranteed zero (see
// `WardenCounts`'s doc comment) — required as numbers so a missing/renamed key fails schema
// validation loudly instead of silently degrading every consumer to a `?? 0` guess.
// `.catchall(z.number())` keeps any *other* non-terminal state (e.g. a future `snoozed`)
// readable rather than dropped, and — unlike `.passthrough()`, whose inferred index
// signature is `unknown` — types that extra state as the number `WardenCounts` declares.
const WARDEN_COUNTS_RAW = z
  .object({
    new: z.number(),
    triaged: z.number(),
    working: z.number(),
    merging: z.number(),
    verifying: z.number(),
    needs_decision: z.number(),
    failed: z.number(),
  })
  .catchall(z.number());

const WARDEN_ITEM_RAW = z.object({
  event_id: z.union([z.string(), z.number()]),
  origin: z.string(),
  repo: z.string().nullable(),
  state: z.string(),
  title: z.string(),
  note: z.string().nullable().optional(),
  pr_url: z.string().nullable().optional(),
  dispatch_job: z.string().nullable().optional(),
  implement_job: z.string().nullable().optional(),
  validation_job: z.string().nullable().optional(),
  updated_at: z.string(),
});

const WARDEN_BOARD_RAW = z.object({
  generated_at: z.string(),
  counts: WARDEN_COUNTS_RAW,
  items: z.array(WARDEN_ITEM_RAW),
  terminal_24h: z.number(),
  truncated: z.boolean().optional(),
});

/** One distinct `error` string is logged at most once per window. An unreachable warden made
 *  this fire on every overview/agents poll — 18.9k identical lines — so the first occurrence
 *  warns, repeats inside the window are counted, and the next line after the window carries
 *  that count as `suppressed`. Process-local; bounded because a schema-validation error
 *  string embeds zod's message and is not a closed set. */
const UNAVAILABLE_LOG_WINDOW_MS = 5 * 60 * 1000;
const UNAVAILABLE_LOG_MAX_KEYS = 32;
const unavailableLog = new Map<string, { loggedAt: number; suppressed: number }>();

/** Test-only: the gate is process-global module state. */
export function __resetUnavailableLogForTests(): void {
  unavailableLog.clear();
}

/** One `logger.warn` per `ok: false` branch below (rate-limited per distinct error, see above),
 *  so an unreachable/misconfigured warden shows up in the log stream even though the failure
 *  never surfaces as an error to a caller (every branch degrades silently to `{ ok: false }` —
 *  see the module comment). `fetchedAt` is the call's injectable clock reading. */
function unavailable(error: string, fetchedAt: number): WardenBoard {
  const entry = unavailableLog.get(error);
  if (entry && fetchedAt - entry.loggedAt < UNAVAILABLE_LOG_WINDOW_MS) {
    entry.suppressed += 1;
  } else {
    if (!entry && unavailableLog.size >= UNAVAILABLE_LOG_MAX_KEYS) {
      const oldest = unavailableLog.keys().next().value;
      if (oldest !== undefined) unavailableLog.delete(oldest);
    }
    unavailableLog.delete(error); // re-insert at the end: Map order is the eviction recency
    unavailableLog.set(error, { loggedAt: fetchedAt, suppressed: 0 });
    logger.warn(
      {
        event: "warden.board_unavailable",
        error,
        ...(entry && entry.suppressed > 0 ? { suppressed: entry.suppressed } : {}),
      },
      "warden board unavailable",
    );
  }
  return { ok: false, error, fetchedAt };
}

function toWardenItem(raw: z.infer<typeof WARDEN_ITEM_RAW>): WardenItem {
  return {
    eventId: raw.event_id,
    origin: raw.origin,
    repo: raw.repo,
    state: raw.state,
    title: raw.title,
    note: raw.note ?? null,
    prUrl: raw.pr_url ?? null,
    updatedAt: raw.updated_at,
    inFlightJob: raw.validation_job ?? raw.implement_job ?? raw.dispatch_job ?? null,
  };
}

export interface FetchWardenBoardOptions {
  /** Override for tests — a stubbed `fetch`-shaped function. Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Override for tests. Defaults to `WARDEN_API_URL` env, then the loopback default. */
  baseUrl?: string;
  /** Override for tests — the clock behind `fetchedAt` and the unavailable-log window.
   *  Defaults to `Date.now`. */
  now?: () => number;
}

/** The subset of the global `fetch` this module actually calls. Typing the injection point to
 *  that subset (rather than `typeof fetch`, whose Bun-flavored type also carries a
 *  `preconnect` property) lets a plain async test stub be assigned directly, without a cast. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Fetches and normalizes warden's `GET /board`. Never throws — any failure (network, non-2xx,
 *  timeout, malformed JSON/schema) resolves to `{ ok: false, error, fetchedAt }` so a warden
 *  outage never delays or fails the overview it's folded into. `items` is already
 *  `updated_at DESC` from warden, so capping to the first `WARDEN_ITEMS_CAP` keeps that order. */
export async function fetchWardenBoard(opts?: FetchWardenBoardOptions): Promise<WardenBoard> {
  const fetchedAt = (opts?.now ?? Date.now)();
  const baseUrl = (opts?.baseUrl ?? process.env.WARDEN_API_URL ?? "http://127.0.0.1:7735").replace(
    /\/+$/,
    "",
  );
  const doFetch: FetchLike = opts?.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(`${baseUrl}/board`, {
      signal: AbortSignal.timeout(WARDEN_BOARD_TIMEOUT_MS),
    });
  } catch (err) {
    return unavailable(String(err), fetchedAt);
  }

  if (!res.ok) {
    return unavailable(`warden /board returned ${res.status}`, fetchedAt);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    return unavailable(`warden /board returned invalid JSON: ${String(err)}`, fetchedAt);
  }

  const parsed = WARDEN_BOARD_RAW.safeParse(json);
  if (!parsed.success) {
    return unavailable(
      `warden /board failed schema validation: ${parsed.error.message}`,
      fetchedAt,
    );
  }

  const items = parsed.data.items.map(toWardenItem);
  const open = Object.values(parsed.data.counts).reduce((sum, n) => sum + n, 0);

  return {
    ok: true,
    generatedAt: parsed.data.generated_at,
    counts: parsed.data.counts,
    open,
    items: items.slice(0, WARDEN_ITEMS_CAP),
    itemsTruncated: parsed.data.truncated === true || items.length > WARDEN_ITEMS_CAP,
    terminal24h: parsed.data.terminal_24h,
    fetchedAt,
  };
}

// ── warden block (opt-in via server/lib/agents.ts's renderText `opts.warden`) ────────────────
//
// warden's ledger states are strings, not agents.ts's own AgentState/Recommendation enums —
// its "needs attention" bucket is a fixed pair named directly rather than routed through
// agents.ts's categoryColor/effectiveCategory, which only know about agent states.
const WARDEN_IN_FLIGHT_STATES = new Set(["working", "merging", "verifying"]);
const WARDEN_MAX_ITEM_LINES = 8;
const NO_REPO_PLACEHOLDER = "—";

/** `needs_decision` and `failed` share bucket 0 — both wait on the owner (warden's
 *  `AWAITING_OWNER_STATES`), so neither is more urgent than the other — then any in-flight
 *  state, then everything else.
 *  Items arrive `updated_at DESC` from warden, and a stable sort by (priority, original index)
 *  keeps that order within each bucket. */
function wardenItemPriority(state: string): number {
  if (state === "needs_decision" || state === "failed") return 0;
  if (WARDEN_IN_FLIGHT_STATES.has(state)) return 1;
  return 2;
}

export interface RenderWardenBlockOptions {
  /** `opts.color` from renderText — SGR spans on/off. */
  color: boolean;
  /** `lineMax` already resolved from `opts.cols` (or the legacy fixed default) by renderText. */
  lineMax: number;
  /** The snapshot's `generatedAt`, so item ages read relative to the same instant as the rest
   *  of the render rather than `Date.now()` at render time. */
  generatedAt: number;
}

/** The warden block appended after the agent roster by server/lib/agents.ts's `renderText`,
 *  which only calls this and pushes the returned lines — extracted here so the block's own
 *  priority/colour rules live next to the type they render. Every warden-sourced string that
 *  reaches this block (`state`, `repo`, `title`, and the unreachable-board `error`) is
 *  attacker-influenced — an alert or a GitHub issue title reaches warden's ledger — so each is
 *  passed through `stripControlBytes` before it touches a coloured terminal pane. */
function columnWidth(values: string[], min: number, max: number): number {
  const longest = values.reduce((acc, v) => Math.max(acc, v.length), 0);
  return Math.min(max, Math.max(min, longest));
}

export function renderWardenBlock(warden: WardenBoard, opts: RenderWardenBlockOptions): string[] {
  const { color, lineMax, generatedAt } = opts;

  if (!warden.ok) {
    const line = `warden · unreachable (${stripControlBytes(warden.error)})`;
    return [clampLine(line, lineMax)];
  }

  const lines: string[] = [];
  const inFlightCount = warden.counts.working + warden.counts.merging + warden.counts.verifying;
  const header =
    `warden · ${warden.open} open · needs_decision ${warden.counts.needs_decision} · ` +
    `failed ${warden.counts.failed} · in flight ${inFlightCount}`;
  lines.push(
    color ? clampVisible(`${BOLD}${header}${RESET}`, lineMax) : clampLine(header, lineMax),
  );

  const ordered = warden.items
    .map((item, index) => ({ item, index }))
    .toSorted((a, b) => {
      const pa = wardenItemPriority(a.item.state);
      const pb = wardenItemPriority(b.item.state);
      return pa !== pb ? pa - pb : a.index - b.index;
    })
    .map((entry) => entry.item);
  const shown = ordered.slice(0, WARDEN_MAX_ITEM_LINES).map((raw) => ({
    state: stripControlBytes(raw.state),
    repo: raw.repo === null ? NO_REPO_PLACEHOLDER : stripControlBytes(raw.repo),
    title: stripControlBytes(raw.title),
    rawState: raw.state,
    updatedAt: raw.updatedAt,
  }));
  // Column widths fit the longest value actually shown (bounded), so a
  // `needs_decision` is never clipped to a stub the way a
  // fixed 12-char column clipped it — measured on the live pane.
  const stateWidth = columnWidth(
    shown.map((s) => s.state),
    8,
    16,
  );
  const repoWidth = columnWidth(
    shown.map((s) => s.repo),
    8,
    20,
  );

  for (const raw of shown) {
    const { state, repo, title } = raw;
    const updatedMs = Date.parse(raw.updatedAt);
    const age = relativeAge(Number.isNaN(updatedMs) ? null : updatedMs, generatedAt);
    const statePadded = state.slice(0, stateWidth).padEnd(stateWidth);
    const repoPadded = repo.slice(0, repoWidth).padEnd(repoWidth);
    const suffix = ` [${age}]`;
    const fixedWidth = 2 + statePadded.length + 1 + repoPadded.length + 1 + suffix.length;
    const truncatedTitle = truncate(title, Math.max(MIN_TITLE_CHARS, lineMax - fixedWidth));
    const base = `  ${statePadded} ${repoPadded} ${truncatedTitle}${suffix}`;

    if (color) {
      const needsAttention = raw.rawState === "needs_decision" || raw.rawState === "failed";
      const spanColor = needsAttention
        ? BOLD_RED
        : WARDEN_IN_FLIGHT_STATES.has(raw.rawState)
          ? GREEN
          : "";
      lines.push(clampVisible(spanColor ? `${spanColor}${base}${RESET}` : base, lineMax));
    } else {
      lines.push(clampLine(base, lineMax));
    }
  }

  if (ordered.length > WARDEN_MAX_ITEM_LINES) {
    lines.push(clampLine(`  … ${ordered.length - WARDEN_MAX_ITEM_LINES} more`, lineMax));
  }

  return lines;
}
