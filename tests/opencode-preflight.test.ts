// Endpoint preflight for the opencode harness (server/mcp/opencode-runner.ts): a dead IU
// endpoint must fail the attempt in seconds with a transport-class error and NEVER spawn
// `opencode run` (which retries a dead endpoint forever). The probe is injected, so no test
// here touches the network except the explicit real-socket cases against loopback.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  preflightIuEndpoint,
  runOpencodeAttempt,
  type IuPreflight,
} from "../server/mcp/opencode-runner.ts";
import {
  classifyBreakerOutcome,
  isRetryableSessionError,
  planNextAttempt,
} from "../server/mcp/session-runner.ts";
import { routeFor } from "../server/lib/routing.ts";

const savedEnv = { key: process.env.IU_API_KEY, base: process.env.IU_BASE_URL };

beforeEach(() => {
  // getIuConfig() caches after first read; either way no keychain access happens here.
  process.env.IU_API_KEY = "test-key";
  process.env.IU_BASE_URL = "https://iu.example.invalid/anthropic";
});

afterEach(() => {
  for (const [name, value] of [
    ["IU_API_KEY", savedEnv.key],
    ["IU_BASE_URL", savedEnv.base],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const refusedPreflight: IuPreflight = async () => ({ ok: false, reason: "ECONNREFUSED" });
const attemptOpts = () => ({ cwd: "/tmp", prompt: "p", route: routeFor("dispatch") });
const attemptCtx = { model: "deepseek-v4.1-flash", backend: "iu" as const };

describe("runOpencodeAttempt — endpoint preflight", () => {
  test("unreachable endpoint: no spawn, classified transport failure, returns fast", async () => {
    let spawned = 0;
    const t0 = performance.now();
    const result = await runOpencodeAttempt(attemptOpts(), { current: 0 }, attemptCtx, {
      preflight: refusedPreflight,
      spawn: () => {
        spawned++;
        throw new Error("must not spawn");
      },
    });
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(spawned).toBe(0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("IU endpoint unreachable before opencode spawn");
    expect(result.classificationText).toBe(result.error);
    // Not a credentials problem — the breaker must count it.
    expect(result.iuConfigError).toBeUndefined();
    expect(result.backend).toBe("iu");
    expect(isRetryableSessionError(result.error ?? "")).toBe(true);
    expect(classifyBreakerOutcome(result)).toBe("transport");
  });

  test("a preflight failure falls back to Max on the second attempt (existing ladder)", async () => {
    const failed = await runOpencodeAttempt(attemptOpts(), { current: 0 }, attemptCtx, {
      preflight: async () => ({ ok: false, reason: "ETIMEDOUT after 5000ms" }),
    });
    const input = {
      result: failed,
      noOutputYet: true,
      usedFallback: false,
      fallback: { backend: "max" as const, model: "claude-haiku-4-5" },
      routeModel: "deepseek-v4.1-flash",
    };
    expect(planNextAttempt({ ...input, attempt: 1 }).kind).toBe("retry");
    expect(planNextAttempt({ ...input, attempt: 2 }).kind).toBe("fallback");
  });

  test("reachable endpoint: spawns opencode, with the IU base handed to the probe", async () => {
    let probedBase = "";
    let probedTimeout = 0;
    const spawnArgs: string[][] = [];
    const sentinel = new Error("spawn reached");
    await expect(
      runOpencodeAttempt(attemptOpts(), { current: 0 }, attemptCtx, {
        preflight: async (base, timeoutMs) => {
          probedBase = base;
          probedTimeout = timeoutMs;
          return { ok: true };
        },
        spawn: (argv) => {
          spawnArgs.push(argv);
          throw sentinel;
        },
      }),
    ).rejects.toBe(sentinel);
    expect(spawnArgs).toHaveLength(1);
    expect(spawnArgs[0]).toContain("run");
    expect(probedBase).toEndWith("/openai/v1");
    expect(probedTimeout).toBe(5_000);
  });

  test("AGENT_GATEWAY_OPENCODE_PREFLIGHT_MS overrides the probe budget", async () => {
    process.env.AGENT_GATEWAY_OPENCODE_PREFLIGHT_MS = "1500";
    try {
      let probedTimeout = 0;
      await runOpencodeAttempt(attemptOpts(), { current: 0 }, attemptCtx, {
        preflight: async (_base, timeoutMs) => {
          probedTimeout = timeoutMs;
          return { ok: false, reason: "ECONNREFUSED" };
        },
      });
      expect(probedTimeout).toBe(1_500);
    } finally {
      delete process.env.AGENT_GATEWAY_OPENCODE_PREFLIGHT_MS;
    }
  });
});

describe("preflightIuEndpoint — real loopback sockets", () => {
  test("a 5xx answer counts as unreachable (opencode would retry it forever)", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("down", { status: 503 }),
    });
    try {
      expect(await preflightIuEndpoint(`http://127.0.0.1:${server.port}/openai/v1`, 2_000)).toEqual(
        {
          ok: false,
          reason: "HTTP 503",
        },
      );
    } finally {
      await server.stop(true);
    }
  });

  test("any non-5xx HTTP response (even 404) counts as reachable", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("nope", { status: 404 }),
    });
    try {
      expect(await preflightIuEndpoint(`http://127.0.0.1:${server.port}/openai/v1`, 2_000)).toEqual(
        {
          ok: true,
        },
      );
    } finally {
      await server.stop(true);
    }
  });

  test("a closed port is unreachable within the budget, reason is connection-class", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const port = server.port;
    await server.stop(true);
    const t0 = performance.now();
    const probe = await preflightIuEndpoint(`http://127.0.0.1:${port}/openai/v1`, 2_000);
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(probe.ok).toBe(false);
    if (probe.ok) return;
    expect(isRetryableSessionError(probe.reason)).toBe(true);
  });

  test("a server that never answers is aborted at the timeout", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      const t0 = performance.now();
      const probe = await preflightIuEndpoint(`http://127.0.0.1:${server.port}/`, 300);
      expect(performance.now() - t0).toBeLessThan(3_000);
      expect(probe.ok).toBe(false);
      if (!probe.ok) expect(probe.reason).toContain("ETIMEDOUT");
    } finally {
      await server.stop(true);
    }
  });
});
