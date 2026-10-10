import { describe, expect, test } from "bun:test";
import {
  coerceEscalationCategory,
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

  test("the six values are exactly the published contract", () => {
    const published = (
      REVIEW_OUTPUT.shape.escalationCategory.unwrap() as unknown as { options: string[] }
    ).options;
    expect(published).toEqual([
      "product",
      "data_loss",
      "spend",
      "other_people",
      "security",
      "blocker",
    ]);
  });

  test("the normalizer keeps it on needs-human and drops it elsewhere", () => {
    const keep = { outcome: "needs-human", escalationCategory: "spend" };
    normalizeEscalationCategory(keep);
    expect(keep.escalationCategory).toBe("spend");
    const drop: { outcome: string; escalationCategory?: string } = {
      outcome: "actionable",
      escalationCategory: "spend",
    };
    normalizeEscalationCategory(drop);
    expect(drop.escalationCategory).toBeUndefined();
    const none: { outcome: string; escalationCategory?: string } = { outcome: "clean" };
    normalizeEscalationCategory(none);
    expect("escalationCategory" in none).toBe(false);
  });

  test("coercion runs before validation: near-misses are fixed, unknowns dropped", () => {
    const fixed = coerceEscalationCategory({
      ...base,
      outcome: "needs-human",
      escalationCategory: " Data Loss",
    });
    expect(REVIEW_OUTPUT.safeParse(fixed).success).toBe(true);
    expect((fixed as { escalationCategory: string }).escalationCategory).toBe("data_loss");
    const hyphen = coerceEscalationCategory({ escalationCategory: "other-people" });
    expect((hyphen as { escalationCategory: string }).escalationCategory).toBe("other_people");
    const dropped = coerceEscalationCategory({
      ...base,
      outcome: "needs-human",
      escalationCategory: "descope",
    });
    expect("escalationCategory" in (dropped as object)).toBe(false);
    expect(coerceEscalationCategory("not an object")).toBe("not an object");
    expect(coerceEscalationCategory({ outcome: "clean" })).toEqual({ outcome: "clean" });
  });

  test("the synthesis prompt documents all six categories", async () => {
    const prompt = await Bun.file(
      new URL("../server/skills/review/synthesis.md", import.meta.url),
    ).text();
    expect(prompt).toContain("escalationCategory");
    for (const c of ["product", "data_loss", "spend", "other_people", "security", "blocker"]) {
      expect(prompt).toContain(`\`${c}\``);
    }
  });
});
