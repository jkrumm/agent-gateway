import { describe, expect, test } from "bun:test";
import {
  REVIEW_OUTPUT,
  REVIEW_SCHEMA_VERSION,
  normalizeEscalationCategory,
} from "../server/jobs/handlers/review.ts";

const base = {
  blocking: [],
  improvements: [],
  discussions: [],
  testGaps: [],
  summary: "s",
  schemaVersion: REVIEW_SCHEMA_VERSION,
};

describe("review escalationCategory", () => {
  test("schema version is 2", () => {
    expect(REVIEW_SCHEMA_VERSION).toBe(2);
  });

  test("optional: a verdict without it still validates", () => {
    expect(REVIEW_OUTPUT.safeParse({ ...base, outcome: "needs-human" }).success).toBe(true);
    expect(REVIEW_OUTPUT.safeParse({ ...base, outcome: "clean" }).success).toBe(true);
  });

  test("accepts only the six owner-only categories", () => {
    for (const c of ["product", "data_loss", "spend", "other_people", "security", "blocker"]) {
      expect(
        REVIEW_OUTPUT.safeParse({ ...base, outcome: "needs-human", escalationCategory: c }).success,
      ).toBe(true);
    }
    expect(
      REVIEW_OUTPUT.safeParse({ ...base, outcome: "needs-human", escalationCategory: "descope" })
        .success,
    ).toBe(false);
  });

  test("the normalizer keeps it on needs-human and drops it elsewhere", () => {
    expect(
      normalizeEscalationCategory({ outcome: "needs-human", escalationCategory: "spend" })
        .escalationCategory,
    ).toBe("spend");
    expect(
      normalizeEscalationCategory({ outcome: "actionable", escalationCategory: "spend" })
        .escalationCategory,
    ).toBeUndefined();
  });
});
