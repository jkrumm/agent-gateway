import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appLogger as logger } from "../logger.ts";
import { computeHealth } from "./health.ts";

// Uptime Kuma push-monitor heartbeat, modelled on dotfiles' scripts/lib/kuma-push.sh. Every
// tick pushes `up` (healthy) or `down` (computeHealth().pageable, msg = pageReason) to
// <base>/api/push/<token>?status=…&msg=…, so a failing route pages instead of only logging.
//
// The same two rules as the shell helper:
//   - The push URL (its path carries the token) lives in env or a chmod-600 file, never in a
//     secret cache — a monitor must not depend on the thing it monitors. It is never logged.
//   - Fail loud, never silent: an unresolvable URL means we do not push at all, so Kuma's own
//     missed-heartbeat alert fires. One warn, once.
//
// Never fatal: push errors are logged (`kuma.push_failed`, at most one per 10 min) and swallowed.
// A drain is not a failure — `draining: true` never makes computeHealth() pageable, so a drain
// keeps pushing `up`; the timer is stopped only when the process is about to exit (index.ts).

export const DEFAULT_KUMA_PUSH_INTERVAL_MS = 60_000;
export const KUMA_FAILURE_LOG_INTERVAL_MS = 10 * 60 * 1000;
const PUSH_TIMEOUT_MS = 15_000;
const URL_FILE = join(homedir(), ".config", "uptime-kuma", "agent-gateway-push-url");

export type KumaStatus = "up" | "down";
export type KumaPushResult = "pushed" | "no-url" | "failed";

export type KumaPushDeps = {
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;
  now: () => number;
  health: () => { pageable: boolean; pageReason: string | null; running: number; pending: number };
  /** The full push URL, or null when none is configured. */
  resolveUrl: () => string | null;
};

/** Env first (an empty value counts as unset), else the chmod-600 file, whitespace stripped. */
export function resolveKumaPushUrl(
  env: string | undefined = process.env.AGENT_GATEWAY_KUMA_PUSH_URL,
  urlFile: string = URL_FILE,
): string | null {
  if (env?.trim()) return env.trim();
  if (!existsSync(urlFile)) return null;
  try {
    return readFileSync(urlFile, "utf8").replace(/\s+/g, "") || null;
  } catch {
    return null;
  }
}

const defaultDeps: KumaPushDeps = {
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  health: computeHealth,
  resolveUrl: () => resolveKumaPushUrl(),
};

let noUrlWarned = false;
let lastFailureLogAt: number | null = null;
let inFlight = false;
let timer: ReturnType<typeof setInterval> | null = null;

/** Test hook: clears the once-only warn, the failure rate limit, the in-flight guard and the timer. */
export function __resetKumaPushForTests(): void {
  noUrlWarned = false;
  lastFailureLogAt = null;
  inFlight = false;
  stopKumaPush();
}

// A fetch error message can embed the request URL, whose path is the push token.
function redact(text: string, url: string): string {
  let out = text.split(url).join("<push-url>");
  try {
    const { pathname } = new URL(url);
    if (pathname.length > 1) out = out.split(pathname).join("/<redacted>");
  } catch {
    // not parseable — nothing more to redact than the whole-URL replacement above
  }
  return out;
}

function logPushFailure(now: number, error: string): void {
  if (lastFailureLogAt !== null && now - lastFailureLogAt < KUMA_FAILURE_LOG_INTERVAL_MS) return;
  lastFailureLogAt = now;
  logger.warn({ event: "kuma.push_failed", error }, "kuma heartbeat push failed");
}

/** One heartbeat. Resolves to the outcome, never rejects. */
export async function pushKumaHeartbeat(
  overrides: Partial<KumaPushDeps> = {},
): Promise<KumaPushResult> {
  const deps = { ...defaultDeps, ...overrides };

  const baseUrl = deps.resolveUrl();
  if (!baseUrl) {
    if (!noUrlWarned) {
      noUrlWarned = true;
      logger.warn(
        { event: "kuma.push_no_url" },
        "no kuma push URL (set AGENT_GATEWAY_KUMA_PUSH_URL or write it to ~/.config/uptime-kuma/agent-gateway-push-url) — not pushing; Kuma will alert on the missed heartbeat",
      );
    }
    return "no-url";
  }

  let status: KumaStatus;
  let msg: string;
  try {
    const health = deps.health();
    status = health.pageable ? "down" : "up";
    msg = health.pageable
      ? (health.pageReason ?? "unhealthy")
      : `ok running=${health.running} pending=${health.pending}`;
  } catch (err) {
    // A health check that cannot run is itself the page — never report `up` blind.
    status = "down";
    msg = `health check failed: ${String(err)}`;
  }

  try {
    const url = new URL(baseUrl);
    url.searchParams.set("status", status);
    url.searchParams.set("msg", msg);
    const res = await deps.fetch(url.toString(), { signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
    if (res.ok) return "pushed";
    logPushFailure(deps.now(), `http ${res.status}`);
    return "failed";
  } catch (err) {
    logPushFailure(deps.now(), redact(String(err), baseUrl));
    return "failed";
  }
}

function intervalMs(): number {
  const parsed = Number(process.env.AGENT_GATEWAY_KUMA_PUSH_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_KUMA_PUSH_INTERVAL_MS;
}

async function tick(overrides: Partial<KumaPushDeps>): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await pushKumaHeartbeat(overrides);
  } finally {
    inFlight = false;
  }
}

/** Pushes once now, then every AGENT_GATEWAY_KUMA_PUSH_INTERVAL_MS (default 60 s). Idempotent. */
export function startKumaPush(overrides: Partial<KumaPushDeps> = {}, everyMs = intervalMs()): void {
  if (timer !== null) return;
  void tick(overrides);
  timer = setInterval(() => void tick(overrides), everyMs);
  timer.unref();
}

export function stopKumaPush(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
