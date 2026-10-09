// server/lib/single-shot.ts — the tool-less JSON completion behind `triage` and review's router.
// Stubs `globalThis.fetch` (iuFetch calls the global directly), same shape as
// tests/iu-openai.test.ts. IU_* env is set before the first import so getIuConfig never
// reaches the Keychain and recordIuUsage never touches the real usage sink.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

process.env.AGENT_GATEWAY_IU_USAGE_LOG = join(
  tmpdir(),
  `agent-gateway-single-shot-test-${Date.now()}.jsonl`,
);
process.env.IU_API_KEY = "test-key";
process.env.IU_BASE_URL = "https://iu.example.com/anthropic";

const { singleShotJson, parseJsonLoose, SingleShotCancelledError } =
  await import("../server/lib/single-shot.ts");
const { routeFor } = await import("../server/lib/routing.ts");

const originalFetch = globalThis.fetch;
let bodies: Record<string, unknown>[] = [];
let queue: (() => Response)[] = [];

function sse(text: string, usage?: Record<string, unknown>): () => Response {
  return () => {
    const content = { id: "c1", model: "m", choices: [{ delta: { content: text } }] };
    let body = `data: ${JSON.stringify(content)}\n\n`;
    if (usage) body += `data: ${JSON.stringify({ id: "c1", model: "m", choices: [], usage })}\n\n`;
    body += "data: [DONE]\n\n";
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

function sentPrompt(index: number): string {
  const messages = (bodies[index]?.messages ?? []) as { content: string }[];
  return messages[0]?.content ?? "";
}

beforeEach(() => {
  bodies = [];
  queue = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(init?.body as string));
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra fetch");
    return next();
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const SCHEMA = z.object({
  action: z.enum(["attach", "new", "ignore"]),
  item: z.number().optional(),
});
const route = () => routeFor("triage");
const call = (prompt = "decide") =>
  singleShotJson({ tool: "triage", prompt, schema: SCHEMA, route: route() });

describe("singleShotJson", () => {
  test("happy path: JSON mode + token floor on the wire, validated data, one attempt", async () => {
    queue = [
      sse('{"action":"attach","item":7}', {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      }),
    ];
    const out = await call();
    expect(out.data).toEqual({ action: "attach", item: 7 });
    expect(out.attempts).toBe(1);
    expect(out.model).toBe("deepseek-v4.1-flash");
    expect(out.usage?.inputTokens).toBe(10);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.response_format).toEqual({ type: "json_object" });
    expect(bodies[0]?.max_completion_tokens).toBe(16_000);
    expect(bodies[0]?.model).toBe("deepseek-v4.1-flash");
  });

  test("tolerates a ```json fence and surrounding prose", async () => {
    queue = [sse('```json\n{"action":"ignore"}\n```')];
    expect((await call()).data).toEqual({ action: "ignore" });
    queue = [sse('Sure! Here you go: {"action":"new"} hope that helps')];
    expect((await call()).data).toEqual({ action: "new" });
  });

  test("a model without registry jsonObject gets no response_format", async () => {
    queue = [sse('{"action":"ignore"}')];
    await singleShotJson({
      tool: "triage",
      prompt: "p",
      schema: SCHEMA,
      route: { ...route(), model: "claude-haiku-4-5" },
    });
    expect(bodies[0]).not.toHaveProperty("response_format");
    expect(bodies[0]?.max_completion_tokens).toBe(16_000);
  });

  test("unparseable first answer: ONE retry carrying the reason, then success; usage and latency summed", async () => {
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    queue = [sse("I cannot decide", usage), sse('{"action":"new"}', usage)];
    const out = await call("the task");
    expect(out.data).toEqual({ action: "new" });
    expect(out.attempts).toBe(2);
    expect(out.usage?.inputTokens).toBe(20);
    expect(bodies).toHaveLength(2);
    const retry = sentPrompt(1);
    expect(retry.startsWith("the task")).toBe(true);
    expect(retry).toContain("REJECTED");
    expect(retry).toContain("not a valid JSON object");
    expect(retry).toContain("I cannot decide");
  });

  test("a cancel requested during attempt 1 stops before the retry: one textComplete call", async () => {
    queue = [sse("not json"), sse('{"action":"new"}')];
    let polls = 0;
    const run = singleShotJson({
      tool: "triage",
      prompt: "p",
      schema: SCHEMA,
      route: route(),
      isCancelled: () => ++polls > 0,
    });
    await expect(run).rejects.toBeInstanceOf(SingleShotCancelledError);
    expect(bodies).toHaveLength(1);
    expect(polls).toBe(1);
  });

  test("isCancelled is not polled before the first attempt and a false result retries as usual", async () => {
    queue = [sse("not json"), sse('{"action":"new"}')];
    const out = await singleShotJson({
      tool: "triage",
      prompt: "p",
      schema: SCHEMA,
      route: route(),
      isCancelled: () => false,
    });
    expect(out.attempts).toBe(2);
    expect(bodies).toHaveLength(2);
  });

  test("schema-nonconforming answer is retried with the zod path in the reason", async () => {
    queue = [sse('{"action":"explode"}'), sse('{"action":"attach"}')];
    const out = await call();
    expect(out.attempts).toBe(2);
    const retry = sentPrompt(1);
    expect(retry).toContain("did not conform to the schema");
    expect(retry).toContain("action");
  });

  test("retry exhausted: throws after exactly two calls, with the last reason", async () => {
    queue = [sse('{"action":"explode"}'), sse('{"action":"still-wrong"}')];
    await expect(call()).rejects.toThrow(/triage: model output rejected after 2 attempts.*action/);
    expect(bodies).toHaveLength(2);
    expect(queue).toHaveLength(0);
  });
});

describe("parseJsonLoose", () => {
  test("null on garbage, object on clean JSON", () => {
    expect(parseJsonLoose("nope")).toBeNull();
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });
});

describe("parseJsonLoose trailing prose", () => {
  test("object at index 0 followed by commentary still parses", () => {
    expect(parseJsonLoose('{"a":1}\n\nHope that helps!')).toEqual({ a: 1 });
  });
});
