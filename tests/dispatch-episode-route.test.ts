// runDispatch end to end with `runSession` stubbed (the one mocked boundary, as in
// tests/review-opencode-config.test.ts): which route an episode is handed (`kind`), and how a
// withheld Max fallback (`SessionResult.fallbackWithheld`) is surfaced in the result.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DISPATCH_SCHEMA_VERSION, runDispatch } from "../server/jobs/handlers/dispatch.ts";
import { routeFor } from "../server/lib/routing.ts";
import * as sessionRunner from "../server/mcp/session-runner.ts";
import { type Fixture, makeFixture } from "./git-fixture.ts";

const VERDICT = {
  verdict: "found it",
  confidence: "high",
  evidence: [],
  recommendation: "do the thing",
  nextAction: "none",
  summary: "one line",
};

let fx: Fixture;
let routes: sessionRunner.SessionOptions<unknown>["route"][];
let extra: Record<string, unknown>;
let spy: ReturnType<typeof spyOn> | undefined;

beforeEach(async () => {
  fx = await makeFixture();
  routes = [];
  extra = {};
  spy = spyOn(sessionRunner, "runSession").mockImplementation((async (
    opts: sessionRunner.SessionOptions<unknown>,
  ) => {
    routes.push(opts.route);
    return { ok: true, data: VERDICT, ...extra };
  }) as unknown as typeof sessionRunner.runSession);
});

afterEach(() => {
  spy?.mockRestore();
  fx.cleanup();
});

describe("runDispatch route selection", () => {
  test("a code episode runs on the tier's own route", async () => {
    await runDispatch({ cwd: fx.repo, brief: "why", tier: "investigate" });
    expect(routes).toEqual([routeFor("dispatch")]);
  });

  test("an editorial episode runs on dispatch_editorial, at the read tiers too", async () => {
    await runDispatch({ cwd: fx.repo, brief: "reword", tier: "investigate", kind: "editorial" });
    expect(routes).toEqual([routeFor("dispatch_editorial")]);
    expect(routes[0]?.harness).toBe("claude");
  });
});

describe("runDispatch surfaces a withheld Max fallback", () => {
  test("a field plus a line in the verdict, and the current schema version", async () => {
    extra = { fallbackWithheld: "write-tier-after-output" };
    const out = await runDispatch({ cwd: fx.repo, brief: "why", tier: "investigate" });
    expect(out.fallbackWithheld).toBe("write-tier-after-output");
    expect(out.verdict).toContain("The reactive Max fallback was withheld");
    expect(out.schemaVersion).toBe(DISPATCH_SCHEMA_VERSION);
  });

  test("absent when the runner did not withhold anything", async () => {
    const out = await runDispatch({ cwd: fx.repo, brief: "why", tier: "investigate" });
    expect("fallbackWithheld" in out).toBe(false);
    expect(out.verdict).toBe("found it");
  });

  test("a failed episode that had its fallback withheld says so in the error", async () => {
    spy?.mockImplementation((async () => ({
      ok: false,
      error: "iu transport died",
      fallbackWithheld: "write-tier-after-output",
    })) as unknown as typeof sessionRunner.runSession);
    await expect(runDispatch({ cwd: fx.repo, brief: "why", tier: "investigate" })).rejects.toThrow(
      /iu transport died.*fallback was withheld/,
    );
  });
});

describe("runDispatch never re-runs a write tier whose fallback was withheld", () => {
  const failed = {
    ok: false,
    error: "IU 503: overloaded",
    noOutput: true,
    fallbackWithheld: "write-tier-after-output",
  };

  test("an implement episode fails with the withheld note instead of the JSON-only retry", async () => {
    let calls = 0;
    spy?.mockImplementation((async () => {
      calls++;
      return failed;
    }) as unknown as typeof sessionRunner.runSession);
    await expect(
      runDispatch({ cwd: fx.repo, brief: "do it", tier: "implement", workspace: "in-place" }),
    ).rejects.toThrow(/IU 503.*fallback was withheld/);
    expect(calls).toBe(1);
  });

  test("a read tier with the same salvageable failure still gets its one retry", async () => {
    let calls = 0;
    spy?.mockImplementation((async () => {
      calls++;
      return calls === 1 ? failed : { ok: true, data: VERDICT };
    }) as unknown as typeof sessionRunner.runSession);
    const out = await runDispatch({ cwd: fx.repo, brief: "why", tier: "investigate" });
    expect(calls).toBe(2);
    expect(out.verdict).toContain("found it");
  });
});
