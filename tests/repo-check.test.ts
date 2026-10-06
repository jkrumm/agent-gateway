import { describe, expect, test } from "bun:test";
import { renderFailedChecks, runRepoCheck } from "../server/jobs/handlers/repo-check.ts";

describe("renderFailedChecks", () => {
  test("renders each failing step with its first three error lines", () => {
    const out = renderFailedChecks([
      { name: "lint", passed: false, errors: ["a", "b", "c", "d"] },
      { name: "format", passed: true },
      { name: "test", passed: false },
    ]);
    expect(out).toBe("lint: a | b | c; test: (no error detail)");
  });

  test("no failing step recorded: a placeholder, never an empty string", () => {
    expect(renderFailedChecks([])).toBe("(no step detail recorded)");
    expect(renderFailedChecks([{ name: "lint", passed: true }])).toBe("(no step detail recorded)");
  });

  test("bounds a chatty dump to ~1500 chars", () => {
    const out = renderFailedChecks([{ name: "test", passed: false, errors: ["x".repeat(5000)] }]);
    expect(out.length).toBe(1501);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("runRepoCheck", () => {
  test("a thrown check is marked toolFailure — infrastructure, not a red suite", async () => {
    const out = await runRepoCheck("/tmp/x", () => {}, {
      runCheckFn: async () => {
        throw new Error("check tool exploded");
      },
    });
    expect(out.passed).toBe(false);
    expect(out.toolFailure).toBe("check tool exploded");
    expect(out.summary).toBe("check tool failed to run");
  });

  test("a real failed check carries no toolFailure marker", async () => {
    const out = await runRepoCheck("/tmp/x", () => {}, {
      runCheckFn: async () => ({
        passed: false,
        steps: [{ name: "lint", passed: false, errors: ["unexpected any at foo.ts:12"] }],
        summary: "1/1 steps failed: lint",
      }),
    });
    expect(out.toolFailure).toBeUndefined();
    expect(out.summary).toBe("1/1 steps failed: lint");
  });
});
