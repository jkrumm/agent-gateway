// defaultProseDeps (server/jobs/handlers/prose.ts) — the real adapters, driven through a stubbed
// `globalThis.fetch` (same shape as tests/single-shot.test.ts and anthropic-single-shot.test.ts):
// the writer POSTs the resolved model and system prompt, a cancel stops a retry, and the reviewer
// runs on the per-job model. IU env is set before the first import.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __resetIuConfigForTests } from "../server/lib/iu-openai.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_GATEWAY_IU_USAGE_LOG = join(
  tmpdir(),
  `agent-gateway-prose-deps-test-${Date.now()}.jsonl`,
);
process.env.IU_API_KEY = "test-key";
process.env.IU_BASE_URL = "https://iu.example.com/anthropic";

const { defaultProseDeps, resolveProseModels } = await import("../server/jobs/handlers/prose.ts");
const { SingleShotCancelledError } = await import("../server/lib/single-shot.ts");

const originalFetch = globalThis.fetch;
let calls: { url: string; body: Record<string, unknown> }[] = [];
let queue: (() => Response)[] = [];

beforeEach(() => {
  process.env.IU_API_KEY = "test-key";
  process.env.IU_BASE_URL = "https://iu.example.com/anthropic";
  __resetIuConfigForTests();
  calls = [];
  queue = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(init?.body as string) });
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra fetch");
    return next();
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const messages = (text: string) => () =>
  new Response(
    JSON.stringify({
      id: "msg_1",
      model: "claude-opus-4-6",
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const sse = (text: string) => () =>
  new Response(
    `data: ${JSON.stringify({ id: "c1", model: "m", choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

const REVIEW_JSON = JSON.stringify({
  scores: {
    verdict_first: 3,
    structure: 3,
    no_repetition: 3,
    concision: 3,
    precision: 3,
    clarity: 3,
    visual_fit: 3,
    naturalness: 3,
    engagement: 3,
  },
  notes: [],
  visualSuggestions: [],
});

describe("defaultProseDeps().write", () => {
  test("POSTs the resolved writer model and the system prompt to the Messages route", async () => {
    queue.push(messages("Rewritten."));
    const { writer } = resolveProseModels({});
    const out = await defaultProseDeps("prose").write({
      model: writer,
      system: "VOICE GUIDE",
      prompt: "the draft",
    });

    expect(out.text).toBe("Rewritten.");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://iu.example.com/anthropic/v1/messages");
    expect(calls[0]?.body.model).toBe(writer);
    expect(calls[0]?.body.system).toBe("VOICE GUIDE");
  });

  test("isCancelled stops the retry after a retryable failure", async () => {
    queue.push(() => new Response("overloaded", { status: 503 }));
    const { writer } = resolveProseModels({});
    const run = defaultProseDeps("prose", () => true).write({
      model: writer,
      system: "s",
      prompt: "p",
    });
    await expect(run).rejects.toBeInstanceOf(SingleShotCancelledError);
    expect(calls).toHaveLength(1);
  });
});

describe("defaultProseDeps().review", () => {
  test("runs on the per-job reviewer model, not the route default", async () => {
    queue.push(sse(REVIEW_JSON));
    const perJob = "gemini-3.8-flash";
    expect(resolveProseModels({ reviewModel: perJob }).reviewer).toBe(perJob);

    const out = await defaultProseDeps("prose").review({
      model: perJob,
      prompt: "review it",
      verdictFirst: true,
    });

    expect(out.data.scores.verdict_first).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.model).toBe(perJob);
  });

  test("a review without verdict_first is valid only when the draft opts out of it", async () => {
    const { verdict_first: _omitted, ...scores } = JSON.parse(REVIEW_JSON).scores;
    const withoutVerdict = JSON.stringify({ ...JSON.parse(REVIEW_JSON), scores });
    const model = "gemini-3.8-flash";

    queue.push(sse(withoutVerdict));
    const out = await defaultProseDeps("prose").review({
      model,
      prompt: "review it",
      verdictFirst: false,
    });
    expect(out.data.scores.verdict_first).toBeUndefined();

    queue.push(sse(withoutVerdict), sse(withoutVerdict));
    await expect(
      defaultProseDeps("prose").review({ model, prompt: "review it", verdictFirst: true }),
    ).rejects.toThrow();
  });

  test("a note about invented_content is a valid reviewer note", async () => {
    const review = {
      ...JSON.parse(REVIEW_JSON),
      notes: [{ criterion: "invented_content", note: "x" }],
    };
    queue.push(sse(JSON.stringify(review)));
    const out = await defaultProseDeps("prose").review({
      model: "gemini-3.8-flash",
      prompt: "review it",
      verdictFirst: true,
    });
    expect(out.data.notes[0]?.criterion).toBe("invented_content");
  });
});
