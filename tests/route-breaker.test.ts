// Per-route circuit breaker in server/mcp/session-runner.ts: after ROUTE_STREAK_LIMIT consecutive
// IU transport failures a route with a Max fallback starts on the fallback lane for
// BREAKER_COOLDOWN_MS, then one half-open probe decides. No session is spawned — the attempt
// runner is faked, the clock is bun:test's setSystemTime (same style as session-retry.test.ts).

import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { ToolRoute } from "../server/lib/routing.ts";
import {
  BREAKER_COOLDOWN_MS,
  ROUTE_STREAK_LIMIT,
  __resetAttemptRunnerForTests,
  __resetBreakersForTests,
  __resetRouteStreaksForTests,
  __setAttemptRunnerForTests,
  breakerVerdict,
  classifyBreakerOutcome,
  nextBreakerState,
  openBreakers,
  runSession,
  type ForcedAttempt,
  type SessionOptions,
  type SessionResult,
} from "../server/mcp/session-runner.ts";

const NOW = 1_700_000_000_000;

describe("classifyBreakerOutcome", () => {
  const fail = (extra: Record<string, unknown>) => ({
    ok: false,
    backend: "iu" as const,
    ...extra,
  });

  test("success is ok", () => {
    expect(classifyBreakerOutcome({ ok: true })).toBe("ok");
  });

  test("429, 5xx and connection errors are transport failures", () => {
    for (const apiErrorStatus of [429, 500, 502, 503, 504, 529]) {
      expect(classifyBreakerOutcome(fail({ apiErrorStatus }))).toBe("transport");
    }
    expect(classifyBreakerOutcome(fail({ classificationText: "IU 503: overloaded" }))).toBe(
      "transport",
    );
    expect(classifyBreakerOutcome(fail({ classificationText: "fetch failed: ECONNRESET" }))).toBe(
      "transport",
    );
  });

  test("deterministic 4xx and gateway-wrapped client errors are not", () => {
    for (const apiErrorStatus of [400, 401, 403, 404]) {
      expect(classifyBreakerOutcome(fail({ apiErrorStatus }))).toBe("other");
    }
    expect(
      classifyBreakerOutcome(
        fail({
          apiErrorStatus: 503,
          classificationText: "503 [Requesty Global Anthropic API StatusCode: BadRequest]",
        }),
      ),
    ).toBe("other");
    expect(classifyBreakerOutcome(fail({ error: "schema mismatch" }))).toBe("other");
  });

  test("a watchdog timeout and missing credentials carry no verdict", () => {
    expect(
      classifyBreakerOutcome(
        fail({ classificationText: "Session timed out — idle 300000ms with no stdout" }),
      ),
    ).toBe("neutral");
    expect(classifyBreakerOutcome(fail({ iuConfigError: true }))).toBe("neutral");
  });

  test("model stdout in `error` is never classified — only classificationText", () => {
    expect(classifyBreakerOutcome(fail({ error: "the doc says 503 and ECONNRESET" }))).toBe(
      "other",
    );
  });
});

describe("breakerVerdict / nextBreakerState (pure)", () => {
  test("closed without state or while openedAt is null", () => {
    expect(breakerVerdict(undefined, NOW, 1000)).toBe("closed");
    expect(breakerVerdict({ failures: 2, openedAt: null }, NOW, 1000)).toBe("closed");
  });

  test("open inside the cooldown, probe once it has elapsed", () => {
    const state = { failures: 3, openedAt: NOW };
    expect(breakerVerdict(state, NOW + 999, 1000)).toBe("open");
    expect(breakerVerdict(state, NOW + 1000, 1000)).toBe("probe");
  });

  test("opens at the streak limit, not before", () => {
    let state = undefined as ReturnType<typeof nextBreakerState>;
    for (let i = 1; i < ROUTE_STREAK_LIMIT; i++) {
      state = nextBreakerState(state, "transport", NOW);
      expect(state?.openedAt).toBeNull();
    }
    state = nextBreakerState(state, "transport", NOW);
    expect(state?.openedAt).toBe(NOW);
  });

  test("success or a non-transport failure resets the streak; neutral leaves it", () => {
    const two = { failures: 2, openedAt: null };
    expect(nextBreakerState(two, "ok", NOW)).toBeUndefined();
    expect(nextBreakerState(two, "other", NOW)).toBeUndefined();
    expect(nextBreakerState(two, "neutral", NOW)).toBe(two);
  });

  test("a transport failure on an open breaker re-opens it from now", () => {
    expect(nextBreakerState({ failures: 3, openedAt: NOW }, "transport", NOW + 500)).toEqual({
      failures: 4,
      openedAt: NOW + 500,
    });
  });
});

describe("runSession — breaker", () => {
  const route: ToolRoute = {
    model: "DeepSeek-V4-Flash",
    backend: "iu",
    fallback: { backend: "max", model: "claude-haiku-4-5" },
    transport: "session",
    harness: "claude",
  };
  const opts: SessionOptions<unknown> = {
    cwd: "/tmp",
    prompt: "irrelevant — attempt runner is faked",
    route,
    tool: "check",
    readOnly: true,
  };
  const KEY = "check@iu/DeepSeek-V4-Flash";

  beforeEach(() => {
    __resetBreakersForTests();
    __resetRouteStreaksForTests();
    setSystemTime(new Date(NOW));
  });
  afterEach(() => __resetAttemptRunnerForTests());
  afterAll(() => {
    __resetBreakersForTests();
    __resetRouteStreaksForTests();
    setSystemTime();
  });

  const fail = (status: number, backend: "iu" | "max" = "iu"): SessionResult<unknown> => ({
    ok: false,
    error: `IU ${status}: boom`,
    classificationText: `IU ${status}: boom api_error_status=${status}`,
    apiErrorStatus: status,
    backend,
    model: route.model,
  });

  /** Primary returns `primary(...)`; a forced attempt succeeds on its lane. Output is
   *  "already produced" (turns 3) so a readOnly 5xx falls back at once instead of sleeping
   *  through a same-backend retry backoff. */
  function fake(primary: () => SessionResult<unknown> | Promise<SessionResult<unknown>>) {
    const calls: (ForcedAttempt | undefined)[] = [];
    __setAttemptRunnerForTests(
      async <T>(_o: SessionOptions<T>, turnsRef: { current: number }, forced?: ForcedAttempt) => {
        calls.push(forced);
        turnsRef.current = 3;
        if (forced) {
          return {
            ok: true,
            data: "done",
            backend: forced.backend,
            model: forced.model,
          } as SessionResult<T>;
        }
        return (await primary()) as SessionResult<T>;
      },
    );
    return calls;
  }

  async function openBreaker(): Promise<void> {
    for (let i = 0; i < ROUTE_STREAK_LIMIT; i++) await runSession(opts);
  }

  test("opens after ROUTE_STREAK_LIMIT consecutive transport failures; next session skips the primary", async () => {
    const calls = fake(() => fail(503));
    await openBreaker();
    expect(openBreakers()).toEqual([KEY]);
    expect(
      calls.every((c, i) => (i % 2 === 0 ? c === undefined : c?.reason === "iu-5xx-after-output")),
    ).toBe(true);

    calls.length = 0;
    const r = await runSession(opts);
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ backend: "max", model: "claude-haiku-4-5", reason: "breaker-open" }]);
  });

  test("stays closed below the limit and on deterministic failures", async () => {
    const calls = fake(() => fail(400));
    for (let i = 0; i < ROUTE_STREAK_LIMIT + 2; i++) await runSession(opts);
    expect(openBreakers()).toEqual([]);
    expect(calls.filter((c) => c?.reason === "breaker-open")).toHaveLength(0);
  });

  test("a success in between resets the streak", async () => {
    let n = 0;
    fake(() =>
      ++n === ROUTE_STREAK_LIMIT
        ? { ok: true, data: "ok", backend: "iu", model: route.model }
        : fail(503),
    );
    for (let i = 0; i < ROUTE_STREAK_LIMIT; i++) await runSession(opts);
    expect(openBreakers()).toEqual([]);
  });

  test("after the cooldown exactly one probe reaches the primary; success closes the breaker", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let primaryCalls = 0;
    const calls = fake(async () => {
      primaryCalls++;
      if (primaryCalls <= ROUTE_STREAK_LIMIT) return fail(503);
      await gate;
      return { ok: true, data: "ok", backend: "iu", model: route.model };
    });
    await openBreaker();
    expect(openBreakers()).toEqual([KEY]);

    setSystemTime(new Date(NOW + BREAKER_COOLDOWN_MS));
    calls.length = 0;
    const probe = runSession(opts);
    // Probe is in flight: a concurrent session is short-circuited, not a second probe.
    const concurrent = await runSession(opts);
    expect(concurrent.ok).toBe(true);
    expect(calls).toEqual([undefined, expect.objectContaining({ reason: "breaker-open" })]);

    release();
    await probe;
    expect(openBreakers()).toEqual([]);

    calls.length = 0;
    await runSession(opts);
    expect(calls).toEqual([undefined]);
  });

  test("a failed probe re-opens the breaker for a fresh cooldown", async () => {
    const calls = fake(() => fail(503));
    await openBreaker();

    setSystemTime(new Date(NOW + BREAKER_COOLDOWN_MS));
    calls.length = 0;
    await runSession(opts); // the probe, fails
    expect(calls[0]).toBeUndefined();
    expect(openBreakers()).toEqual([KEY]);

    calls.length = 0;
    setSystemTime(new Date(NOW + BREAKER_COOLDOWN_MS + BREAKER_COOLDOWN_MS - 1));
    await runSession(opts);
    expect(calls).toEqual([expect.objectContaining({ reason: "breaker-open" })]);

    calls.length = 0;
    setSystemTime(new Date(NOW + 2 * BREAKER_COOLDOWN_MS));
    await runSession(opts);
    expect(calls[0]).toBeUndefined(); // next probe
  });

  test("a route without a fallback is never short-circuited", async () => {
    const calls: (ForcedAttempt | undefined)[] = [];
    __setAttemptRunnerForTests(
      async <T>(_o: SessionOptions<T>, turnsRef: { current: number }, forced?: ForcedAttempt) => {
        calls.push(forced);
        turnsRef.current = 3;
        return fail(503) as SessionResult<T>;
      },
    );
    const bare = { ...opts, route: { ...route, fallback: null } };
    for (let i = 0; i < ROUTE_STREAK_LIMIT + 2; i++) await runSession(bare);
    expect(openBreakers()).toEqual([KEY]); // it counts failures...
    expect(calls).toHaveLength(ROUTE_STREAK_LIMIT + 2);
    expect(calls.every((c) => c === undefined)).toBe(true); // ...but always tries the primary
  });

  test("a forced attempt that lands on iu does not feed the iu breaker", async () => {
    // A max-primary route (narrative-style) whose quota-flavoured failure forces an iu attempt.
    const maxRoute: ToolRoute = {
      ...route,
      backend: "max",
      model: "claude-sonnet-5",
      fallback: { backend: "iu" },
    };
    __setAttemptRunnerForTests(
      async <T>(_o: SessionOptions<T>, turnsRef: { current: number }, forced?: ForcedAttempt) => {
        turnsRef.current = forced ? 3 : 0;
        if (forced) return { ...fail(503), model: forced.model } as SessionResult<T>;
        return {
          ok: false,
          error: "usage limit",
          classificationText: "usage limit",
          backend: "max",
          model: maxRoute.model,
        } as SessionResult<T>;
      },
    );
    for (let i = 0; i < ROUTE_STREAK_LIMIT + 1; i++) {
      await runSession({ ...opts, route: maxRoute });
    }
    expect(openBreakers()).toEqual([]);
  });
});

describe("runSession — breaker respects AGENT_GATEWAY_WORKER_FALLBACK=none", () => {
  test("never engages: the primary is always tried, no forced attempt", async () => {
    const prev = process.env.AGENT_GATEWAY_WORKER_FALLBACK;
    process.env.AGENT_GATEWAY_WORKER_FALLBACK = "none";
    // A fresh module instance — the switch is read once at module load.
    const specifier = "../server/mcp/session-runner.ts?worker-fallback-none";
    const fresh = (await import(specifier)) as typeof import("../server/mcp/session-runner.ts");
    if (prev === undefined) delete process.env.AGENT_GATEWAY_WORKER_FALLBACK;
    else process.env.AGENT_GATEWAY_WORKER_FALLBACK = prev;

    const route: ToolRoute = {
      model: "DeepSeek-V4-Flash",
      backend: "iu",
      fallback: { backend: "max", model: "claude-haiku-4-5" },
      transport: "session",
      harness: "claude",
    };
    const calls: (ForcedAttempt | undefined)[] = [];
    fresh.__setAttemptRunnerForTests(async (_o, turnsRef, forced) => {
      calls.push(forced);
      turnsRef.current = 3;
      return {
        ok: false,
        error: "IU 503: boom",
        classificationText: "IU 503: boom",
        apiErrorStatus: 503,
        backend: "iu",
        model: route.model,
      } as SessionResult<never>;
    });
    for (let i = 0; i < ROUTE_STREAK_LIMIT + 2; i++) {
      await fresh.runSession({ cwd: "/tmp", prompt: "x", route, tool: "check", readOnly: true });
    }
    fresh.__resetAttemptRunnerForTests();
    expect(calls).toHaveLength(ROUTE_STREAK_LIMIT + 2);
    expect(calls.every((c) => c === undefined)).toBe(true);
  });
});
