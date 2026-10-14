import {
  backendFallbacksLastHour,
  openBreakers,
  ROUTE_STREAK_LIMIT,
  routeFailureStreaks,
} from "../mcp/session-runner.ts";
import { jobHealth } from "../jobs/store.ts";
import { getOpencodeServerStatus, type OpencodeServerStatus } from "../mcp/opencode-server.ts";

// The payload behind GET /api/jobs/health, plus the derived "should this page" verdict the
// Kuma heartbeat (kuma-push.ts) branches on.
//
// `ok` stays exactly jobHealth()'s verdict — the HTTP contract devhost-health and `make verify`
// read. `backendFallbacks`/`routeStreaks`/`degradedRoutes`/`warnings` are reported alongside it;
// a degraded route (e.g. the IU gateway refusing every attempt of one route) leaves `ok` alone
// but is `pageable`, so a failing route pages instead of only logging.
//
// `opencodeServer` is the shared OpenCode server's live status (opencode-server.ts): a server
// that is down, rejects our password or runs a different build than the pinned one is `pageable`
// with a warning — every opencode-harness episode fails fast without it — but, like a degraded
// route, leaves the queue's `ok` alone.
export async function computeHealth(
  deps: { opencodeStatus?: () => Promise<OpencodeServerStatus> } = {},
) {
  const health = jobHealth();
  const opencodeServer = await (deps.opencodeStatus ?? getOpencodeServerStatus)();
  const backendFallbacks = backendFallbacksLastHour();
  const streaks = routeFailureStreaks();
  const degradedRoutes = Object.entries(streaks)
    .filter(([, count]) => count >= ROUTE_STREAK_LIMIT)
    .map(([route]) => route);
  const warnings: string[] = degradedRoutes.map(
    (route) => `route ${route} failed ${streaks[route]} in a row`,
  );
  if (backendFallbacks.count > 0) {
    const reasons = Object.entries(backendFallbacks.reasons)
      .map(([reason, count]) => `${reason}×${count}`)
      .join(", ");
    warnings.push(`${backendFallbacks.count} backend fallback(s) in the last hour: ${reasons}`);
  }

  const open = openBreakers();
  if (open.length > 0) warnings.push(`circuit breaker open: ${open.join(", ")}`);

  if (!opencodeServer.ok) {
    warnings.push(`opencode server not ok: ${opencodeServer.error ?? "unknown"}`);
  }

  const pageable = !health.ok || degradedRoutes.length > 0 || !opencodeServer.ok;
  const reasons: string[] = [];
  if (!health.ok) {
    reasons.push(
      `queue unhealthy (failedLastHour=${health.failedLastHour}, oldestPendingAgeMs=${health.oldestPendingAgeMs})`,
    );
  }
  if (degradedRoutes.length > 0) reasons.push(`degraded routes: ${degradedRoutes.join(", ")}`);
  if (!opencodeServer.ok) {
    reasons.push(`opencode server not ok (${opencodeServer.error ?? "unknown"})`);
  }

  return {
    ...health,
    backendFallbacks,
    routeStreaks: streaks,
    degradedRoutes,
    openBreakers: open,
    opencodeServer,
    warnings,
    pageable,
    pageReason: pageable ? reasons.join("; ") : null,
  };
}
