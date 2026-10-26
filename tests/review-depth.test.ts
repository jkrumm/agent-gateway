// Review depth: the router's `depth` answer parses (and a bad one is tolerated), the effective
// depth follows caller > router > fallback, and with AGENT_GATEWAY_REVIEW_DEPTH_GATING=1 the
// angle set and OCR run are gated by it. Flag off changes nothing but the log line.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_GATEWAY_IU_USAGE_LOG = join(
  tmpdir(),
  `agent-gateway-review-depth-test-${Date.now()}.jsonl`,
);
process.env.IU_API_KEY = "test-key";
process.env.IU_BASE_URL = "https://iu.example.com/anthropic";

const { routeReview, resolveReviewDepth, gatedAngles, ocrRunsAtDepth, reviewDepthGating } =
  await import("../server/jobs/handlers/review.ts");

const originalFetch = globalThis.fetch;
const originalGating = process.env.AGENT_GATEWAY_REVIEW_DEPTH_GATING;
let queue: string[] = [];

beforeEach(() => {
  queue = [];
  globalThis.fetch = (async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("unexpected extra fetch");
    const chunk = { id: "c1", model: "m", choices: [{ delta: { content: next } }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalGating === undefined) delete process.env.AGENT_GATEWAY_REVIEW_DEPTH_GATING;
  else process.env.AGENT_GATEWAY_REVIEW_DEPTH_GATING = originalGating;
});

const senior = { angle: "senior-dev", label: "Senior Dev" };
const architect = { angle: "architect", label: "Architect" };
const frontend = { angle: "frontend", label: "Frontend Expert" };
const security = { angle: "security", label: "Security Reviewer" };

describe("router depth answer", () => {
  test("a valid depth and reason parse through", async () => {
    queue = ['{"angles":[],"depth":"light","depthReason":"docs only"}'];
    const routed = await routeReview("diff");
    expect(routed.depth).toBe("light");
    expect(routed.depthReason).toBe("docs only");
    expect(routed.angles).toEqual([]);
  });

  test("an unknown depth parses as undefined and keeps the angles", async () => {
    queue = ['{"angles":["security"],"depth":"extreme","depthReason":"big"}'];
    const routed = await routeReview("diff");
    expect(routed.depth).toBeUndefined();
    expect(routed.depthReason).toBe("big");
    expect(routed.angles).toEqual([security]);
  });

  test("a missing depth is valid (old router answers)", async () => {
    queue = ['{"angles":["security"],"rationale":"auth"}'];
    const routed = await routeReview("diff");
    expect(routed.depth).toBeUndefined();
    expect(routed.angles).toEqual([security]);
  });
});

describe("resolveReviewDepth precedence", () => {
  test("caller wins over the router", () => {
    expect(resolveReviewDepth("light", { depth: "deep", depthReason: "x" })).toEqual({
      depth: "light",
      source: "caller",
      reason: "caller-specified",
    });
  });

  test("router wins over the fallback", () => {
    expect(resolveReviewDepth(undefined, { depth: "standard", depthReason: "logic" })).toEqual({
      depth: "standard",
      source: "router",
      reason: "logic",
    });
  });

  test("no caller and no router depth (router failed or explicit angles) falls back to standard", () => {
    expect(resolveReviewDepth(undefined, undefined).depth).toBe("standard");
    expect(resolveReviewDepth(undefined, { angles: [] } as never).source).toBe("fallback");
    expect(resolveReviewDepth(undefined, {}).source).toBe("fallback");
  });
});

describe("depth gating (default on, AGENT_GATEWAY_REVIEW_DEPTH_GATING=0 opts out)", () => {
  const floor = [architect, senior, frontend];
  const routed = [security];

  test("gating is on by default; only the exact value 0 turns it off", () => {
    delete process.env.AGENT_GATEWAY_REVIEW_DEPTH_GATING;
    expect(reviewDepthGating()).toBe(true);
    process.env.AGENT_GATEWAY_REVIEW_DEPTH_GATING = "0";
    expect(reviewDepthGating()).toBe(false);
    for (const depth of ["light", "standard", "deep"] as const) {
      expect(ocrRunsAtDepth(depth)).toBe(true);
    }
  });

  test("light is senior-dev plus whatever the router individually picked", () => {
    process.env.AGENT_GATEWAY_REVIEW_DEPTH_GATING = "1";
    expect(gatedAngles("light", floor, routed)).toEqual([senior, security]);
    expect(gatedAngles("light", floor, [])).toEqual([senior]);
  });

  test("flag on: standard keeps the floor and the router angles", () => {
    process.env.AGENT_GATEWAY_REVIEW_DEPTH_GATING = "1";
    expect(gatedAngles("standard", floor, routed)).toEqual([architect, senior, frontend, security]);
  });

  test("flag on: deep keeps everything", () => {
    process.env.AGENT_GATEWAY_REVIEW_DEPTH_GATING = "1";
    expect(gatedAngles("deep", floor, routed)).toEqual([architect, senior, frontend, security]);
  });

  test("flag on: OCR runs only at deep", () => {
    process.env.AGENT_GATEWAY_REVIEW_DEPTH_GATING = "1";
    expect(ocrRunsAtDepth("light")).toBe(false);
    expect(ocrRunsAtDepth("standard")).toBe(false);
    expect(ocrRunsAtDepth("deep")).toBe(true);
  });

  test("default: OCR runs only at deep", () => {
    delete process.env.AGENT_GATEWAY_REVIEW_DEPTH_GATING;
    expect(ocrRunsAtDepth("standard")).toBe(false);
    expect(ocrRunsAtDepth("deep")).toBe(true);
  });
});
