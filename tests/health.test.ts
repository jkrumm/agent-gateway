import { describe, expect, test } from "bun:test";
import { computeHealth } from "../server/lib/health.ts";
import { jobsRoutes } from "../server/routes/jobs.ts";
import type { OpencodeServerStatus } from "../server/mcp/opencode-server.ts";
import { recordRouteOutcome } from "../server/mcp/session-runner.ts";

const serverOk = async (): Promise<OpencodeServerStatus> => ({
  ok: true,
  up: true,
  version: "2.0.25",
  pinned: "2.0.25",
  versionOk: true,
});
const withServerOk = { opencodeStatus: serverOk };

describe("computeHealth", () => {
  test("a degraded route is pageable with the route in the reason, while ok stays true", async () => {
    const tool = "health-lib-degraded";
    const key = `${tool}@iu/glm-5.3-flash`;
    for (let i = 0; i < 3; i++) recordRouteOutcome(tool, "iu", "glm-5.3-flash", false);
    try {
      const h = await computeHealth(withServerOk);
      expect(h.ok).toBe(true);
      expect(h.degradedRoutes).toContain(key);
      expect(h.pageable).toBe(true);
      expect(h.pageReason).toContain(key);
    } finally {
      recordRouteOutcome(tool, "iu", "glm-5.3-flash", true);
    }
  });

  test("a sub-limit streak does not page", async () => {
    const tool = "health-lib-below-limit";
    recordRouteOutcome(tool, "iu", "glm-5.3-flash", false);
    try {
      const h = await computeHealth(withServerOk);
      expect(h.degradedRoutes.some((r) => r.startsWith(tool))).toBe(false);
    } finally {
      recordRouteOutcome(tool, "iu", "glm-5.3-flash", true);
    }
  });

  test("healthy store with no degraded route: not pageable, pageReason null", async () => {
    const h = await computeHealth(withServerOk);
    if (h.degradedRoutes.length > 0) return; // process-global streaks from other files
    expect(h.pageable).toBe(false);
    expect(h.pageReason).toBeNull();
  });

  test("carries the opencode server status verbatim and a healthy one adds no warning", async () => {
    const h = await computeHealth(withServerOk);
    expect(h.opencodeServer).toEqual(await serverOk());
    expect(h.warnings.some((w) => w.includes("opencode server"))).toBe(false);
  });

  test("a down opencode server is pageable with a reason and a warning, while the queue ok stays true", async () => {
    const h = await computeHealth({
      opencodeStatus: async () => ({
        ok: false,
        up: false,
        version: null,
        pinned: "2.0.25",
        versionOk: false,
        error: "opencode server unreachable: ECONNREFUSED",
      }),
    });
    expect(h.ok).toBe(true);
    expect(h.opencodeServer.ok).toBe(false);
    expect(h.pageable).toBe(true);
    expect(h.pageReason).toContain("opencode server not ok");
    expect(h.pageReason).toContain("ECONNREFUSED");
    expect(h.warnings).toContain(
      "opencode server not ok: opencode server unreachable: ECONNREFUSED",
    );
  });

  test("a wrong-version opencode server pages the same way", async () => {
    const h = await computeHealth({
      opencodeStatus: async () => ({
        ok: false,
        up: true,
        version: "2.0.30",
        pinned: "2.0.25",
        versionOk: false,
        error: "opencode server version 2.0.30 != pinned 2.0.25",
      }),
    });
    expect(h.ok).toBe(true);
    expect(h.pageable).toBe(true);
    expect(h.pageReason).toContain("2.0.30");
  });

  test("GET /api/jobs/health carries pageable/pageReason additively", async () => {
    const res = await jobsRoutes.handle(new Request("http://localhost/api/jobs/health"));
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.pageable).toBe("boolean");
    expect("pageReason" in body).toBe(true);
    expect(typeof body.ok).toBe("boolean");
    expect(Array.isArray(body.degradedRoutes)).toBe(true);
  });

  test("GET /api/jobs/health answers within ~1.6 s even when the opencode server hangs", async () => {
    const saved = process.env.AGENT_GATEWAY_OPENCODE_PORT;
    const hang = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Promise<Response>(() => {}),
    });
    process.env.AGENT_GATEWAY_OPENCODE_PORT = String(hang.port);
    try {
      const t0 = performance.now();
      const res = await jobsRoutes.handle(new Request("http://localhost/api/jobs/health"));
      const body = (await res.json()) as { opencodeServer: { ok: boolean }; pageable: boolean };
      expect(performance.now() - t0).toBeLessThan(2_000);
      expect(body.opencodeServer.ok).toBe(false);
      expect(body.pageable).toBe(true);
    } finally {
      process.env.AGENT_GATEWAY_OPENCODE_PORT = saved;
      await hang.stop(true);
    }
  });

  test("GET /api/jobs/health reports opencodeServer; with no server (test port) it is not ok and pages", async () => {
    const res = await jobsRoutes.handle(new Request("http://localhost/api/jobs/health"));
    const body = (await res.json()) as {
      opencodeServer: { ok: boolean; up: boolean; pinned: string; versionOk: boolean };
      pageable: boolean;
    };
    expect(body.opencodeServer).toMatchObject({ ok: false, up: false, versionOk: false });
    expect(typeof body.opencodeServer.pinned).toBe("string");
    expect(body.pageable).toBe(true);
  });
});
