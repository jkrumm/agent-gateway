// The pure parts of scripts/replay-review-corpus.ts: argument parsing, corpus parsing, the
// stratified sample, finding overlap, per-arm aggregation and the blinded pooled rendering. The
// network half (job submit and poll) is exercised by running the script, not here.

import { describe, expect, test } from "bun:test";
import {
  armModel,
  assignLetters,
  cellFileName,
  type CellRecord,
  mean,
  overlap,
  parseArgs,
  parseCorpus,
  percentile,
  renderPooled,
  reviewParams,
  sameFinding,
  sampleStratified,
  summarizeArm,
  type Finding,
} from "../scripts/replay-review-corpus.ts";

const finding = (file: string, line: number | undefined, message: string): Finding =>
  line === undefined ? { file, message } : { file, line, message };

describe("parseArgs", () => {
  test("requires --arms unless resuming", () => {
    expect(() => parseArgs([])).toThrow("--arms is required");
    expect(parseArgs(["--resume", "/tmp/x"]).arms).toEqual([]);
  });

  test("splits arms and applies defaults", () => {
    const opts = parseArgs(["--arms", "baseline,deepseek-v4.1-flash"]);
    expect(opts.arms).toEqual(["baseline", "deepseek-v4.1-flash"]);
    expect(opts.concurrency).toBe(2);
    expect(opts.dryRun).toBe(false);
    expect(opts.sample).toBeUndefined();
  });

  test("rejects a non-positive sample and concurrency", () => {
    expect(() => parseArgs(["--arms", "baseline", "--sample", "0"])).toThrow("--sample");
    expect(() => parseArgs(["--arms", "baseline", "--concurrency", "x"])).toThrow("--concurrency");
  });

  test("reads --dry-run", () => {
    expect(parseArgs(["--arms", "baseline", "--dry-run"]).dryRun).toBe(true);
  });
});

describe("parseCorpus", () => {
  test("reads JSONL and defaults a missing result to null", () => {
    const text = [
      JSON.stringify({
        jobId: "a1",
        createdAt: "t",
        repo: "r",
        kind: "pr",
        params: { cwd: "/x" },
        baseSha: "b",
        headSha: "h",
        diff: "",
        result: null,
      }),
      JSON.stringify({
        jobId: "a2",
        createdAt: "t",
        repo: "r",
        kind: "scope:head",
        params: { cwd: "/x" },
        baseSha: "b",
        headSha: "h",
        diff: "",
      }),
      "",
    ].join("\n");
    const items = parseCorpus(text);
    expect(items.map((i) => i.jobId)).toEqual(["a1", "a2"]);
    expect(items[1]?.result).toBeNull();
  });

  test("refuses a line without the identifying fields", () => {
    expect(() => parseCorpus(JSON.stringify({ jobId: "a1", repo: "r" }))).toThrow("line 1");
  });
});

describe("sampleStratified", () => {
  const items = [
    ...Array.from({ length: 6 }, (_, i) => ({ jobId: `p${i}`, repo: "big", kind: "pr" })),
    ...Array.from({ length: 4 }, (_, i) => ({ jobId: `s${i}`, repo: "big", kind: "scope:head" })),
    { jobId: "x0", repo: "small", kind: "pr" },
    { jobId: "x1", repo: "small", kind: "pr" },
  ];

  test("returns everything when n covers the corpus", () => {
    expect(sampleStratified(items, 99, "seed")).toHaveLength(items.length);
  });

  test("is deterministic for a seed", () => {
    const a = sampleStratified(items, 5, "seed").map((i) => i.jobId);
    const b = sampleStratified(items, 5, "seed").map((i) => i.jobId);
    expect(a).toEqual(b);
    expect(a).toHaveLength(5);
  });

  test("spreads picks across strata before doubling up", () => {
    const picked = sampleStratified(items, 3, "seed");
    const strata = new Set(picked.map((i) => `${i.repo}|${i.kind}`));
    expect(strata.size).toBe(3);
  });

  test("returns chosen items in corpus order", () => {
    const picked = sampleStratified(items, 4, "seed").map((i) => i.jobId);
    const order = items.map((i) => i.jobId);
    const positions = picked.map((id) => order.indexOf(id));
    expect(positions.toSorted((x, y) => x - y)).toEqual(positions);
  });
});

describe("overlap", () => {
  test("matches the same file within five lines", () => {
    expect(sameFinding(finding("a.ts", 10, "x"), finding("a.ts", 14, "y"))).toBe(true);
    expect(sameFinding(finding("a.ts", 10, "x"), finding("a.ts", 16, "y"))).toBe(false);
  });

  test("matches identical normalized text regardless of line", () => {
    expect(
      sameFinding(
        finding("a.ts", undefined, "Null check missing!"),
        finding("b.ts", 3, "null check missing"),
      ),
    ).toBe(true);
  });

  test("counts one-to-one and reports approximate agreement", () => {
    const a = [finding("a.ts", 10, "one"), finding("a.ts", 10, "two")];
    const b = [finding("a.ts", 11, "other")];
    expect(overlap(a, b)).toEqual({ matched: 1, countA: 2, countB: 1, agreement: 0.5 });
  });

  test("agreement is null when both sides are empty", () => {
    expect(overlap([], []).agreement).toBeNull();
  });
});

const cell = (
  status: CellRecord["status"],
  wallMs: number | null,
  review: { outcome: string; blocking: Finding[]; improvements: Finding[] } | null,
): CellRecord => ({
  itemJobId: "i",
  arm: "baseline",
  model: null,
  submittedAt: "t",
  status,
  gatewayJobId: "g",
  error: null,
  wallMs,
  job: review === null ? null : { result: review },
});

describe("summarizeArm", () => {
  test("aggregates done and failed cells", () => {
    const summary = summarizeArm("baseline", [
      cell("done", 60_000, {
        outcome: "actionable",
        blocking: [finding("a", 1, "x")],
        improvements: [],
      }),
      cell("done", 120_000, {
        outcome: "clean",
        blocking: [],
        improvements: [finding("b", 2, "y"), finding("c", 3, "z")],
      }),
      cell("failed", 30_000, null),
    ]);
    expect(summary.done).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.outcomes).toEqual({ actionable: 1, clean: 1 });
    expect(summary.blockingPerReview).toBe(0.5);
    expect(summary.improvementsPerReview).toBe(1);
    expect(summary.wallMsMedian).toBe(60_000);
    expect(summary.costUsd).toBeNull();
  });

  test("percentile uses nearest rank", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([], 50)).toBeNull();
    expect(mean([])).toBeNull();
  });
});

describe("reviewParams and armModel", () => {
  test("baseline carries no model override, a model arm sets it", () => {
    expect(armModel("baseline")).toBeNull();
    expect(armModel("deepseek-v4.1-flash")).toBe("deepseek-v4.1-flash");
    const recorded = { cwd: "/r", pr: 4, model: "stale", angles: ["qa"], kind: "pr" };
    expect(reviewParams(recorded, null)).toEqual({ cwd: "/r", pr: 4, angles: ["qa"] });
    expect(reviewParams(recorded, "m")).toEqual({ cwd: "/r", pr: 4, angles: ["qa"], model: "m" });
    const pin = { baseSha: "aaa1111", headSha: "bbb2222" };
    expect(reviewParams({ cwd: "/r", scope: "HEAD~3" }, null, pin)).toEqual({
      cwd: "/r",
      scope: "aaa1111..bbb2222",
    });
    expect(reviewParams(recorded, null, pin)).toEqual({ cwd: "/r", pr: 4, angles: ["qa"] });
  });
});

describe("pooled rendering", () => {
  test("assigns each label a letter and renders without arm names", () => {
    const letters = assignLetters(["original", "baseline", "deepseek"], () => 0.5);
    expect([...letters.values()].toSorted()).toEqual(["A", "B", "C"]);
    const text = renderPooled("item1", [
      { letter: "A", review: { outcome: "clean", blocking: [], improvements: [] }, status: "done" },
      { letter: "B", review: null, status: "failed" },
    ]);
    expect(text).toContain("## Candidate A");
    expect(text).toContain("status: failed");
    expect(text).not.toContain("baseline");
  });

  test("cell file names are filesystem-safe", () => {
    expect(cellFileName("abc", "deepseek/v4 flash")).toBe("abc__deepseek_v4_flash.json");
  });
});
