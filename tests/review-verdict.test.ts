import { describe, expect, test } from "bun:test";
import {
  MAX_IMPROVEMENTS,
  REVIEW_SCHEMA_VERSION,
  applyVerdictRules,
  capImprovements,
  deriveOutcome,
} from "../server/jobs/handlers/review.ts";

const finding = (angle = "senior-dev") => ({ file: "a.ts", message: "m", angle });

function verdict(over: Partial<Parameters<typeof applyVerdictRules>[0]> = {}) {
  return {
    outcome: "actionable" as "clean" | "actionable" | "needs-human",
    blocking: [] as unknown[],
    improvements: [] as unknown[],
    discussions: [] as { file: string; message: string; angle: string }[],
    summary: "s",
    ...over,
  };
}

describe("deriveOutcome", () => {
  test("no findings at all is clean", () => {
    expect(deriveOutcome(verdict(), 0)).toBe("clean");
  });

  test("a blocking finding is actionable", () => {
    expect(deriveOutcome(verdict({ blocking: [finding()] }), 0)).toBe("actionable");
  });

  test("improvements and test gaps alone never stop a review being clean", () => {
    const v = { ...verdict({ improvements: [finding(), finding()] }), testGaps: ["x"] };
    expect(deriveOutcome(v, 0)).toBe("clean");
  });

  test("a discussion is needs-human, even beside blocking findings", () => {
    expect(deriveOutcome(verdict({ discussions: [finding()] }), 0)).toBe("needs-human");
    expect(deriveOutcome(verdict({ blocking: [finding()], discussions: [finding()] }), 0)).toBe(
      "needs-human",
    );
  });

  test("a failed reviewer is needs-human whatever the lists say", () => {
    expect(deriveOutcome(verdict(), 1)).toBe("needs-human");
    expect(deriveOutcome(verdict({ blocking: [finding()] }), 2)).toBe("needs-human");
  });

  test("the schema version is unchanged: only the meaning of clean widened", () => {
    expect(REVIEW_SCHEMA_VERSION).toBe(2);
  });
});

describe("capImprovements", () => {
  test("at or under the cap nothing changes", () => {
    const v = verdict({ improvements: Array.from({ length: MAX_IMPROVEMENTS }, () => finding()) });
    expect(capImprovements(v)).toBe(0);
    expect(v.improvements).toHaveLength(MAX_IMPROVEMENTS);
    expect(v.summary).toBe("s");
  });

  test("keeps the first five in order and reports the rest in the summary", () => {
    const all = Array.from({ length: 8 }, (_, i) => ({ ...finding(), message: `m${i}` }));
    const v = verdict({ improvements: [...all] });
    expect(capImprovements(v)).toBe(3);
    expect((v.improvements as typeof all).map((f) => f.message)).toEqual([
      "m0",
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
    expect(v.summary).toBe("s +3 lower-value improvements omitted");
  });

  test("a single dropped improvement reads in the singular", () => {
    const v = verdict({ improvements: Array.from({ length: 6 }, () => finding()) });
    capImprovements(v);
    expect(v.summary).toBe("s +1 lower-value improvement omitted");
  });
});

describe("applyVerdictRules", () => {
  test("the model's actionable with no blocking is overridden to clean", () => {
    const v = verdict({ outcome: "actionable", improvements: [finding()] });
    expect(applyVerdictRules(v, [], 4)).toEqual({ from: "actionable", to: "clean" });
    expect(v.outcome).toBe("clean");
  });

  test("an agreeing outcome is no override", () => {
    const v = verdict({ outcome: "actionable", blocking: [finding()] });
    expect(applyVerdictRules(v, [], 4)).toBeNull();
    expect(v.outcome).toBe("actionable");
  });

  test("a model clean with a blocking finding is raised to actionable", () => {
    const v = verdict({ outcome: "clean", blocking: [finding()] });
    expect(applyVerdictRules(v, [], 4)).toEqual({ from: "clean", to: "actionable" });
  });

  test("a model needs-human with no discussion and no failed reviewer is lowered", () => {
    const v = verdict({ outcome: "needs-human", blocking: [finding()] });
    expect(applyVerdictRules(v, [], 4)).toEqual({ from: "needs-human", to: "actionable" });
  });

  test("a failed reviewer forces needs-human, adds its pipeline discussion and a summary lead", () => {
    const v = verdict({ outcome: "clean", summary: "Approved." });
    const failed = [{ angle: "qa", failureReason: "idle watchdog" }];
    expect(applyVerdictRules(v, failed, 5)).toEqual({ from: "clean", to: "needs-human" });
    expect(v.discussions).toEqual([
      {
        file: "(review pipeline)",
        message: "qa session failed: idle watchdog — this angle did not actually review the diff.",
        angle: "qa",
      },
    ]);
    expect(v.summary).toBe("Partial review: 1/5 reviewers failed (qa). Approved.");
  });

  test("a failed reviewer the model already recorded is not duplicated", () => {
    const v = verdict({
      outcome: "needs-human",
      discussions: [{ file: "(review pipeline)", message: "qa failed", angle: "qa" }],
      summary: "Partial review: 1/5 reviewers failed (qa). Rest ok.",
    });
    expect(applyVerdictRules(v, [{ angle: "qa", failureReason: "x" }], 5)).toBeNull();
    expect(v.discussions).toHaveLength(1);
    expect(v.summary).toBe("Partial review: 1/5 reviewers failed (qa). Rest ok.");
  });

  test("the cap is applied before the outcome and improvements never change it", () => {
    const v = verdict({
      outcome: "actionable",
      improvements: Array.from({ length: 11 }, () => finding()),
    });
    expect(applyVerdictRules(v, [], 4)).toEqual({ from: "actionable", to: "clean" });
    expect(v.improvements).toHaveLength(MAX_IMPROVEMENTS);
    expect(v.summary).toBe("s +6 lower-value improvements omitted");
  });
});
