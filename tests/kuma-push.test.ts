import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetKumaPushForTests,
  KUMA_FAILURE_LOG_INTERVAL_MS,
  pushKumaHeartbeat,
  resolveKumaPushUrl,
  startKumaPush,
  stopKumaPush,
  type KumaPushDeps,
} from "../server/lib/kuma-push.ts";

const URL_ = "https://kuma.example.com/api/push/SECRET-TOKEN";
const healthy = { pageable: false, pageReason: null, running: 2, pending: 1 };

function deps(over: Partial<KumaPushDeps> & { calls?: string[] } = {}): Partial<KumaPushDeps> {
  const { calls, ...rest } = over;
  return {
    resolveUrl: () => URL_,
    health: () => healthy,
    now: () => 0,
    fetch: async (url) => {
      calls?.push(url);
      return { ok: true, status: 200 };
    },
    ...rest,
  };
}

afterEach(() => __resetKumaPushForTests());

describe("resolveKumaPushUrl", () => {
  test("env wins; empty env falls through to the file, whitespace stripped", () => {
    const dir = mkdtempSync(join(tmpdir(), "kuma-url-"));
    const file = join(dir, "url");
    writeFileSync(file, " https://kuma.example.com/api/push/abc \n");
    expect(resolveKumaPushUrl("https://env.example.com/p", file)).toBe("https://env.example.com/p");
    expect(resolveKumaPushUrl("", file)).toBe("https://kuma.example.com/api/push/abc");
    expect(resolveKumaPushUrl(undefined, join(dir, "missing"))).toBeNull();
  });
});

describe("pushKumaHeartbeat", () => {
  test("healthy pushes status=up with a running/pending message", async () => {
    const calls: string[] = [];
    expect(await pushKumaHeartbeat(deps({ calls }))).toBe("pushed");
    const u = new URL(calls[0] ?? "");
    expect(u.origin + u.pathname).toBe(URL_);
    expect(u.searchParams.get("status")).toBe("up");
    expect(u.searchParams.get("msg")).toBe("ok running=2 pending=1");
  });

  test("pageable pushes status=down with the reason, url-encoded", async () => {
    const calls: string[] = [];
    const reason = "degraded routes: a@iu/x & b=c";
    await pushKumaHeartbeat(
      deps({ calls, health: () => ({ ...healthy, pageable: true, pageReason: reason }) }),
    );
    const u = new URL(calls[0] ?? "");
    expect(u.searchParams.get("status")).toBe("down");
    expect(u.searchParams.get("msg")).toBe(reason);
    expect(calls[0]).not.toContain(" ");
  });

  test("a health computation that throws pushes down, never up", async () => {
    const calls: string[] = [];
    await pushKumaHeartbeat(
      deps({
        calls,
        health: () => {
          throw new Error("boom");
        },
      }),
    );
    expect(new URL(calls[0] ?? "").searchParams.get("status")).toBe("down");
  });

  test("no resolvable URL: nothing is fetched", async () => {
    const calls: string[] = [];
    expect(await pushKumaHeartbeat(deps({ calls, resolveUrl: () => null }))).toBe("no-url");
    expect(await pushKumaHeartbeat(deps({ calls, resolveUrl: () => null }))).toBe("no-url");
    expect(calls).toEqual([]);
  });

  test("fetch rejection and non-2xx resolve to failed without throwing", async () => {
    expect(
      await pushKumaHeartbeat(
        deps({
          fetch: async () => {
            throw new Error(`connect failed ${URL_}`);
          },
        }),
      ),
    ).toBe("failed");
    expect(await pushKumaHeartbeat(deps({ fetch: async () => ({ ok: false, status: 502 }) }))).toBe(
      "failed",
    );
  });

  test("failure logging is rate limited to one per 10 minutes", async () => {
    const { appLogger } = await import("../server/logger.ts");
    const seen: unknown[] = [];
    const orig = appLogger.warn.bind(appLogger);
    (appLogger as { warn: unknown }).warn = (obj: unknown) => {
      seen.push(obj);
    };
    try {
      let t = 1_000;
      const failing = deps({ now: () => t, fetch: async () => ({ ok: false, status: 500 }) });
      await pushKumaHeartbeat(failing);
      t += 60_000;
      await pushKumaHeartbeat(failing);
      t += KUMA_FAILURE_LOG_INTERVAL_MS;
      await pushKumaHeartbeat(failing);
      const failed = seen.filter((o) => (o as { event?: string }).event === "kuma.push_failed");
      expect(failed).toHaveLength(2);
      expect(JSON.stringify(seen)).not.toContain("SECRET-TOKEN");
    } finally {
      (appLogger as { warn: unknown }).warn = orig;
    }
  });
});

describe("startKumaPush / stopKumaPush", () => {
  test("pushes immediately and on the interval, and stops pushing after stop", async () => {
    const calls: string[] = [];
    startKumaPush(deps({ calls }), 10);
    startKumaPush(deps({ calls }), 10); // idempotent
    await Bun.sleep(55);
    stopKumaPush();
    const n = calls.length;
    expect(n).toBeGreaterThanOrEqual(2);
    await Bun.sleep(40);
    expect(calls.length).toBe(n);
  });
});
