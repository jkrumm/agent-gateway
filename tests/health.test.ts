import { describe, expect, test } from "bun:test";
import { computeHealth } from "../server/lib/health.ts";
import { jobsRoutes } from "../server/routes/jobs.ts";
import { recordRouteOutcome } from "../server/mcp/session-runner.ts";

describe("computeHealth", () => {
  test("a degraded route is pageable with the route in the reason, while ok stays true", () => {
    const tool = "health-lib-degraded";
    const key = `${tool}@iu/glm-5.3-flash`;
    for (let i = 0; i < 3; i++) recordRouteOutcome(tool, "iu", "glm-5.3-flash", false);
    try {
      const h = computeHealth();
      expect(h.ok).toBe(true);
      expect(h.degradedRoutes).toContain(key);
      expect(h.pageable).toBe(true);
      expect(h.pageReason).toContain(key);
    } finally {
      recordRouteOutcome(tool, "iu", "glm-5.3-flash", true);
    }
  });

  test("a sub-limit streak does not page", () => {
    const tool = "health-lib-below-limit";
    recordRouteOutcome(tool, "iu", "glm-5.3-flash", false);
    try {
      const h = computeHealth();
      expect(h.degradedRoutes.some((r) => r.startsWith(tool))).toBe(false);
    } finally {
      recordRouteOutcome(tool, "iu", "glm-5.3-flash", true);
    }
  });

  test("healthy store with no degraded route: not pageable, pageReason null", () => {
    const h = computeHealth();
    if (h.degradedRoutes.length > 0) return; // process-global streaks from other files
    expect(h.pageable).toBe(false);
    expect(h.pageReason).toBeNull();
  });

  test("GET /api/jobs/health carries pageable/pageReason additively", async () => {
    const res = await jobsRoutes.handle(new Request("http://localhost/api/jobs/health"));
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.pageable).toBe("boolean");
    expect("pageReason" in body).toBe(true);
    expect(typeof body.ok).toBe("boolean");
    expect(Array.isArray(body.degradedRoutes)).toBe(true);
  });
});
