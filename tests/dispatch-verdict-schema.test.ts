/**
 * Dispatch verdict schema — `rootCause`, `decisionQuestion` and the terse caps.
 *
 * The new fields are additive and optional (warden pins the schemaVersion and consumes results
 * persisted before they existed), and overlong worker text is truncated by
 * `normalizeWorkerOutput` before validation rather than failing the episode.
 */
import {
  applySensitiveScan,
  DISPATCH_OUTPUT,
  DISPATCH_SCHEMA_VERSION,
  normalizeWorkerOutput,
  workerValidator,
  WORKER_OUTPUT,
} from "../server/jobs/handlers/dispatch.ts";
import type { DispatchOutput, DispatchTier } from "../server/jobs/handlers/dispatch.ts";
import { describe, expect, test } from "bun:test";
import { z } from "zod";

const TIERS: DispatchTier[] = ["investigate", "author", "implement"];

// The pre-rootCause shape, exactly as workers and persisted results had it.
const OLD_SHAPE = {
  verdict: "The monitor is red because the container exited.",
  confidence: "high",
  evidence: [{ file: "compose.yml", detail: "restart policy is 'no'" }],
  recommendation: "Set restart: unless-stopped.",
  nextAction: "implement",
  summary: "container exited, no restart policy",
};

const TIER_EXTRA: Record<DispatchTier, object> = {
  investigate: {},
  author: { issueTitle: "t", issueBody: "b" },
  implement: { prTitle: "t", prBody: "b" },
};

const base = (tier: DispatchTier, over: object = {}) => ({
  ...OLD_SHAPE,
  ...TIER_EXTRA[tier],
  ...over,
});

describe("worker schema — old shape and new fields", () => {
  test("a result without rootCause/decisionQuestion still validates on every tier", () => {
    for (const tier of TIERS) {
      expect(WORKER_OUTPUT[tier].safeParse(base(tier)).success).toBe(true);
      expect(workerValidator(tier)(base(tier)).ok).toBe(true);
    }
  });

  test("the handler's output schema accepts an old-shape result and the new fields", () => {
    const out = {
      ...OLD_SHAPE,
      outcome: "verdict_only",
      schemaVersion: DISPATCH_SCHEMA_VERSION,
    };
    expect(DISPATCH_OUTPUT.safeParse(out).success).toBe(true);
    expect(
      DISPATCH_OUTPUT.safeParse({
        ...out,
        rootCause: "stale-lockfile-after-rename",
        nextAction: "human",
        decisionQuestion: "Drop /v1 now, or keep it?",
        owningRepo: "warden",
      }).success,
    ).toBe(true);
  });

  test("the schema version stays at the value warden pins", () => {
    expect(DISPATCH_SCHEMA_VERSION).toBe(5);
  });

  test("rootCause must be kebab-case and at most 80 chars", () => {
    const s = WORKER_OUTPUT.investigate;
    for (const ok of ["stale-lockfile-after-rename", "a", "oom-9", "x".repeat(80)]) {
      expect(s.safeParse(base("investigate", { rootCause: ok })).success).toBe(true);
    }
    for (const bad of [
      "Stale-Lockfile",
      "has space",
      "double--hyphen",
      "-lead",
      "trail-",
      "snake_case",
      "",
      "x".repeat(81),
    ]) {
      expect(s.safeParse(base("investigate", { rootCause: bad })).success).toBe(false);
    }
  });

  test("the worker-facing JSON schema advertises the caps and the key pattern", () => {
    const js = z.toJSONSchema(WORKER_OUTPUT.investigate) as {
      properties: Record<string, { maxLength?: number; pattern?: string }>;
    };
    expect(js.properties.verdict?.maxLength).toBe(600);
    expect(js.properties.recommendation?.maxLength).toBe(400);
    expect(js.properties.summary?.maxLength).toBe(200);
    expect(js.properties.rootCause?.maxLength).toBe(80);
    expect(js.properties.rootCause?.pattern).toBe("^[a-z0-9]+(-[a-z0-9]+)*$");
    expect(js.properties.decisionQuestion?.maxLength).toBe(200);
    expect(js.properties.owningRepo?.maxLength).toBe(100);
    expect(js.properties.owningRepo?.pattern).toBe("^[A-Za-z0-9._-]+$");
  });
});

describe("worker schema — caps", () => {
  test("verdict > 600, recommendation > 400 and summary > 200 fail strict validation", () => {
    const s = WORKER_OUTPUT.investigate;
    expect(s.safeParse(base("investigate", { verdict: "v".repeat(600) })).success).toBe(true);
    expect(s.safeParse(base("investigate", { verdict: "v".repeat(601) })).success).toBe(false);
    expect(s.safeParse(base("investigate", { recommendation: "r".repeat(400) })).success).toBe(
      true,
    );
    expect(s.safeParse(base("investigate", { recommendation: "r".repeat(401) })).success).toBe(
      false,
    );
    expect(s.safeParse(base("investigate", { summary: "s".repeat(201) })).success).toBe(false);
  });

  test("the handler's output keeps the loose caps so salvage/artifact notes still validate", () => {
    const out = {
      ...OLD_SHAPE,
      verdict: "v".repeat(3500),
      recommendation: "r".repeat(1500),
      outcome: "salvaged",
      schemaVersion: DISPATCH_SCHEMA_VERSION,
    };
    expect(DISPATCH_OUTPUT.safeParse(out).success).toBe(true);
  });

  test("overlong worker text is truncated with an ellipsis, not rejected", () => {
    for (const tier of TIERS) {
      const r = workerValidator(tier)(
        base(tier, {
          verdict: "v".repeat(900),
          recommendation: "r".repeat(700),
          summary: "s".repeat(350),
        }),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const v = r.value as DispatchOutput;
      expect(v.verdict.length).toBe(600);
      expect(v.verdict.endsWith("…")).toBe(true);
      expect(v.recommendation.length).toBe(400);
      expect(v.summary.length).toBe(200);
      expect(v.summary.endsWith("…")).toBe(true);
    }
  });

  test("text within the caps is left byte-identical", () => {
    const r = workerValidator("investigate")(base("investigate"));
    expect(r.ok && r.value).toMatchObject(OLD_SHAPE);
  });

  test("structural problems are still rejected after normalizing", () => {
    const v = workerValidator("investigate");
    expect(v(base("investigate", { confidence: "certain" })).ok).toBe(false);
    expect(v(base("investigate", { summary: "" })).ok).toBe(false);
    expect(v(base("investigate", { degraded: true })).ok).toBe(false);
    expect(v("not an object").ok).toBe(false);
  });
});

describe("rootCause normalization", () => {
  const norm = (rootCause: unknown) =>
    (
      normalizeWorkerOutput(base("investigate", { rootCause })) as {
        rootCause?: string;
      }
    ).rootCause;

  test("a near-miss key is coerced to kebab-case", () => {
    expect(norm("Stale Lockfile After_Rename")).toBe("stale-lockfile-after-rename");
    expect(norm("  --oom--killed--  ")).toBe("oom-killed");
  });

  test("an overlong key is cut to 80 chars without a trailing hyphen", () => {
    const key = norm(`${"a".repeat(79)}-bbbb`) as string;
    expect(key.length).toBeLessThanOrEqual(80);
    expect(key.endsWith("-")).toBe(false);
    expect(
      WORKER_OUTPUT.investigate.safeParse(base("investigate", { rootCause: key })).success,
    ).toBe(true);
  });

  test("a key with nothing usable left is dropped instead of failing the episode", () => {
    expect(norm("???")).toBeUndefined();
    expect(workerValidator("investigate")(base("investigate", { rootCause: "???" })).ok).toBe(true);
  });
});

describe("owningRepo", () => {
  const repo = (owningRepo: unknown) =>
    (
      normalizeWorkerOutput(base("investigate", { owningRepo })) as {
        owningRepo?: string;
      }
    ).owningRepo;

  test("a valid bare repo name is kept verbatim on every tier", () => {
    for (const ok of ["agent-gateway", "homelab-private", "weather.orb", "repo_1"]) {
      for (const tier of TIERS) {
        const r = workerValidator(tier)(base(tier, { owningRepo: ok }));
        expect(r.ok).toBe(true);
        expect(r.ok && (r.value as DispatchOutput).owningRepo).toBe(ok);
      }
    }
  });

  test("the two unambiguous near-misses are rescued", () => {
    expect(repo("  warden  ")).toBe("warden");
    expect(repo("warden.git")).toBe("warden");
  });

  test("a reference-shaped or malformed value is dropped, never mangled into a wrong name", () => {
    for (const bad of ["", "   ", "has space", "owner/warden", "a/b/c", "café"]) {
      expect(repo(bad)).toBeUndefined();
    }
  });

  test("an overlong name is dropped too", () => {
    expect(repo("x".repeat(100))).toBe("x".repeat(100));
    expect(repo("x".repeat(101))).toBeUndefined();
  });

  test("the strict schema still rejects a malformed name that skips normalization", () => {
    const s = WORKER_OUTPUT.investigate;
    for (const bad of ["has space", "owner/warden", "x".repeat(101), ""]) {
      expect(s.safeParse(base("investigate", { owningRepo: bad })).success).toBe(false);
    }
  });

  test("a dropped name never fails the episode", () => {
    const r = workerValidator("investigate")(base("investigate", { owningRepo: "has space" }));
    expect(r.ok).toBe(true);
    expect(r.ok && "owningRepo" in (r.value as object)).toBe(false);
  });
});

describe("decisionQuestion gating", () => {
  test("allowed with nextAction human", () => {
    for (const tier of TIERS) {
      const r = workerValidator(tier)(
        base(tier, {
          nextAction: "human",
          decisionQuestion: "Drop /v1 now, or keep it until the app ships?",
        }),
      );
      expect(r.ok).toBe(true);
      expect(r.ok && (r.value as DispatchOutput).decisionQuestion).toBe(
        "Drop /v1 now, or keep it until the app ships?",
      );
    }
  });

  test("human without a question is still a valid finished episode", () => {
    expect(workerValidator("investigate")(base("investigate", { nextAction: "human" })).ok).toBe(
      true,
    );
  });

  test("the strict schema rejects it on any other nextAction", () => {
    for (const nextAction of ["none", "issue", "implement"]) {
      expect(
        WORKER_OUTPUT.investigate.safeParse(
          base("investigate", { nextAction, decisionQuestion: "q?" }),
        ).success,
      ).toBe(false);
    }
  });

  test("the normalizer strips it on a non-human action so the episode survives", () => {
    const r = workerValidator("investigate")(
      base("investigate", { nextAction: "issue", decisionQuestion: "q?" }),
    );
    expect(r.ok).toBe(true);
    expect(r.ok && "decisionQuestion" in (r.value as object)).toBe(false);
  });

  test("an empty question is dropped and an overlong one truncated to 200", () => {
    const empty = workerValidator("investigate")(
      base("investigate", { nextAction: "human", decisionQuestion: "  " }),
    );
    expect(empty.ok && "decisionQuestion" in (empty.value as object)).toBe(false);
    const long = workerValidator("investigate")(
      base("investigate", {
        nextAction: "human",
        decisionQuestion: "q".repeat(500),
      }),
    );
    expect(long.ok && (long.value as DispatchOutput).decisionQuestion?.length).toBe(200);
  });
});

describe("applySensitiveScan with the new fields", () => {
  const secret = ["gh", "p_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7"].join("");
  const verdict = {
    ...OLD_SHAPE,
    nextAction: "human",
    rootCause: "token-rotation-missed",
    decisionQuestion: `Rotate ${secret} now, or wait?`,
    outcome: "verdict_only",
    schemaVersion: DISPATCH_SCHEMA_VERSION,
  } as DispatchOutput;

  test("a secret in decisionQuestion is withheld and the field is not carried through", () => {
    const out = applySensitiveScan(verdict, {
      sensitive: true,
      jobId: "verdict-schema-test",
      project: "x",
    });
    expect(out.outcome).toBe("withheld");
    expect(out.decisionQuestion).toBeUndefined();
    expect(out.rootCause).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  test("a secret in owningRepo is withheld and the field is not carried through", () => {
    const out = applySensitiveScan(
      { ...verdict, decisionQuestion: undefined, owningRepo: secret } as DispatchOutput,
      { sensitive: true, jobId: "verdict-schema-test", project: "x" },
    );
    expect(out.outcome).toBe("withheld");
    expect(out.owningRepo).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain(secret);
  });
});
