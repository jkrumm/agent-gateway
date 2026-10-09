import {
  backendFallbacksLastHour,
  openBreakers,
  ROUTE_STREAK_LIMIT,
  routeFailureStreaks,
} from "../mcp/session-runner.ts";
import { jobHealth } from "../jobs/store.ts";

// The payload behind GET /api/jobs/health, plus the derived "should this page" verdict the
// Kuma heartbeat (kuma-push.ts) branches on.
//
// `ok` stays exactly jobHealth()'s verdict — the HTTP contract devhost-health and `make verify`
// read. `backendFallbacks`/`routeStreaks`/`degradedRoutes`/`warnings` are reported alongside it;
// a degraded route (e.g. the IU gateway refusing every attempt of one route) leaves `ok` alone
// but is `pageable`, so a failing route pages instead of only logging.
export function computeHealth() {
  const health = jobHealth();
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

  const pageable = !health.ok || degradedRoutes.length > 0;
  const reasons: string[] = [];
  if (!health.ok) {
    reasons.push(
      `queue unhealthy (failedLastHour=${health.failedLastHour}, oldestPendingAgeMs=${health.oldestPendingAgeMs})`,
    );
  }
  if (degradedRoutes.length > 0) reasons.push(`degraded routes: ${degradedRoutes.join(", ")}`);

  return {
    ...health,
    backendFallbacks,
    routeStreaks: streaks,
    degradedRoutes,
    openBreakers: open,
    warnings,
    pageable,
    pageReason: pageable ? reasons.join("; ") : null,
  };
}
