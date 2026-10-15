// `decide`: handler validation, job wiring, and the decision-model call with the IU decision
// endpoint stubbed at `globalThis.fetch` (wire shape captured from the live endpoint 2026-10-15).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sink = join(tmpdir(), `agent-gateway-decide-test-${Date.now()}.jsonl`);
process.env.AGENT_GATEWAY_IU_USAGE_LOG = sink;
process.env.IU_API_KEY = "test-key";
process.env.IU_BASE_URL = "https://iu.example.com/anthropic";

const { runDecide, DECIDE_INPUT } = await import("../server/jobs/handlers/decide.ts");
const { executeJob } = await import("../server/jobs/executor.ts");
const { recoveryStatusFor } = await import("../server/jobs/store.ts");
const { isJobTool } = await import("../server/jobs/types.ts");
const { DECISION_MODELS } = await import("../server/lib/decision.ts");

const originalFetch = globalThis.fetch;
let requests: {
  url: string;
  body: { state?: string; questions: Record<string, { type: string; criteria?: unknown }> };
}[] = [];

const WIRE = {
  model: "pplx-decider-v1-27b",
  answers: {
    action: {
      type: "choice",
      choice: "attach",
      confidence: 0.9,
      probabilities: { attach: 0.8, new: 0.2 },
    },
    dup: { type: "noul", noul: 0.3 },
  },
  usage: { total_tokens: 110, input_tokens: 100, output_tokens: 10 },
};

beforeEach(() => {
  requests = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(init?.body as string) });
    return Response.json(WIRE);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const questions = {
  action: { type: "choice", instructions: "what?", options: { attach: "dup", new: "fresh" } },
  dup: { type: "boolean", instructions: "dup?" },
};

describe("decide", () => {
  test("is a job tool, requeued once on recovery", () => {
    expect(isJobTool("decide")).toBe(true);
    expect(recoveryStatusFor("decide", 1)).toBe("pending");
  });

  test("returns typed answers with confidence, cost and a usage row", async () => {
    const out = await runDecide({ state: "s", questions });
    expect(requests[0].url).toBe("https://iu.example.com/decisions/v1/systemone");
    expect(requests[0].body.questions.action.criteria).toEqual({ attach: "dup", new: "fresh" });
    expect(requests[0].body.questions.dup.type).toBe("noul");
    expect(out.answers.action).toMatchObject({ type: "choice", choice: "attach" });
    expect(out.answers.dup).toMatchObject({ type: "boolean", value: false, probability: 0.3 });
    expect(out.usage.costUsd).toBeCloseTo((100 * 0.04 + 10 * 0.04) / 1e6, 10);
    const row = JSON.parse(readFileSync(sink, "utf8").trim().split("\n").at(-1) ?? "{}");
    expect(row).toMatchObject({ tool: "decide", model: "pplx-decider-v1-27b", input_tokens: 100 });
  });

  test("caps the state at the model's limit and reports what was cut", async () => {
    const cap = DECISION_MODELS.clef.maxStateChars;
    const out = await runDecide({ state: "x".repeat(cap + 50), questions, model: "clef" });
    expect(out.truncatedChars).toBe(50);
    expect(requests[0].body.state).toHaveLength(cap);
  });

  test("refuses an unknown model and a malformed question", async () => {
    await expect(runDecide({ state: "s", questions, model: "gpt-x" })).rejects.toThrow(
      /not a known decision model/,
    );
    expect(
      DECIDE_INPUT.safeParse({
        state: "s",
        questions: { q: { type: "choice", instructions: "i", options: { a: "x" } } },
      }).success,
    ).toBe(false);
  });

  test("executeJob dispatches to the handler", async () => {
    const out = (await executeJob(
      {
        id: "j",
        tool: "decide",
        params: { state: "s", questions },
      } as never,
      () => {},
    )) as { model: string };
    expect(out.model).toBe("pplx-decider-v1-27b");
  });

  test("an Object.prototype name is not a decision model", async () => {
    for (const model of ["constructor", "__proto__", "toString"]) {
      await expect(runDecide({ state: "s", questions, model })).rejects.toThrow(
        /not a known decision model/,
      );
    }
  });

  test("a failed request rethrows and writes an error usage row", async () => {
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    await expect(runDecide({ state: "s", questions })).rejects.toThrow();
    const row = JSON.parse(readFileSync(sink, "utf8").trim().split("\n").at(-1) ?? "{}");
    expect(row).toMatchObject({ tool: "decide", outcome: "error" });
  });

  test("a choice without a reported confidence falls back to the option's probability", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        model: "pplx-decider-v1-27b",
        answers: {
          action: { type: "choice", choice: "attach", probabilities: { attach: 0.7, new: 0.3 } },
        },
        usage: { input_tokens: 7, output_tokens: 1 },
      })) as unknown as typeof fetch;
    const out = await runDecide({ state: "s", questions: { action: questions.action } });
    expect(out.answers.action).toMatchObject({ choice: "attach", confidence: 0.7 });
  });
});
