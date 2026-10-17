// server/lib/single-shot.ts — anthropicComplete, the native Messages sibling of textComplete.
// Stubs `globalThis.fetch`, same shape as tests/single-shot.test.ts. The IU env is set before
// the first import so getIuConfig never reaches the Keychain, and the usage sink is a temp file.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __resetIuConfigForTests } from "../server/lib/iu-openai.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_GATEWAY_IU_USAGE_LOG = join(
  tmpdir(),
  `agent-gateway-anthropic-test-${Date.now()}.jsonl`,
);
process.env.IU_API_KEY = "test-key";
process.env.IU_BASE_URL = "https://iu.example.com/anthropic";

const {
  anthropicComplete,
  AnthropicStarvedError,
  AnthropicTruncatedError,
  AnthropicContentError,
  SingleShotCancelledError,
} = await import("../server/lib/single-shot.ts");

const originalFetch = globalThis.fetch;
let calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
let queue: (() => Response)[] = [];

function message(content: unknown[], stop_reason: string): () => Response {
  return () =>
    new Response(
      JSON.stringify({
        id: "msg_1",
        model: "claude-opus-4-6",
        stop_reason,
        content,
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
}

beforeEach(() => {
  process.env.IU_API_KEY = "test-key";
  process.env.IU_BASE_URL = "https://iu.example.com/anthropic";
  __resetIuConfigForTests();
  calls = [];
  queue = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(init?.body as string),
    });
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra fetch");
    return next();
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("anthropicComplete", () => {
  test("posts one Messages call to the IU native route with bearer auth and adaptive thinking", async () => {
    queue.push(
      message(
        [
          { type: "thinking", thinking: "…" },
          { type: "text", text: "Hallo Welt." },
        ],
        "end_turn",
      ),
    );
    const out = await anthropicComplete({
      tool: "prose",
      model: "claude-opus-4-6",
      system: "Be brief.",
      prompt: "Say hello.",
    });

    expect(out.text).toBe("Hallo Welt.");
    expect(out.model).toBe("claude-opus-4-6");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://iu.example.com/anthropic/v1/messages");
    expect(calls[0]?.headers.authorization).toBe("Bearer test-key");
    expect(calls[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0]?.body.model).toBe("claude-opus-4-6");
    expect(calls[0]?.body.system).toBe("Be brief.");
    expect(calls[0]?.body.thinking).toEqual({ type: "adaptive" });
    expect(calls[0]?.body.output_config).toEqual({ effort: "high" });
    expect(calls[0]?.body.max_tokens).toBe(32000);
    expect(out.usage).toMatchObject({ inputTokens: 120, outputTokens: 50, cacheReadTokens: 20 });
  });

  test("empty text with stop_reason max_tokens is STARVED — an error, never a success", async () => {
    queue.push(message([{ type: "thinking", thinking: "…" }], "max_tokens"));
    await expect(
      anthropicComplete({ tool: "prose", model: "claude-opus-4-6", prompt: "x" }),
    ).rejects.toBeInstanceOf(AnthropicStarvedError);
  });

  test("empty text without max_tokens is an error, but not the starved one", async () => {
    queue.push(message([], "end_turn"));
    const err = await anthropicComplete({
      tool: "prose",
      model: "claude-opus-4-6",
      prompt: "x",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AnthropicStarvedError);
    expect((err as Error).message).toContain("returned no text");
  });

  test("non-empty text with stop_reason max_tokens is TRUNCATED — an error, never a success", async () => {
    queue.push(message([{ type: "text", text: "The answer stops mid-sen" }], "max_tokens"));
    const err = await anthropicComplete({
      tool: "prose",
      model: "claude-opus-4-6",
      prompt: "x",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnthropicTruncatedError);
    expect(err).toBeInstanceOf(AnthropicContentError);
    expect((err as Error).message).toContain("truncated");
  });

  test("a refusal that carries text is an error with the stop reason and usage", async () => {
    queue.push(message([{ type: "text", text: "I can't help with that." }], "refusal"));
    const err = (await anthropicComplete({
      tool: "prose",
      model: "claude-opus-4-6",
      prompt: "x",
    }).catch((e: unknown) => e)) as InstanceType<typeof AnthropicContentError>;
    expect(err).toBeInstanceOf(AnthropicContentError);
    expect(err.message).toContain("refusal");
    expect(err.stopReason).toBe("refusal");
    expect(err.usage).toMatchObject({ inputTokens: 120, outputTokens: 50 });
  });

  test("stop_sequence is a complete answer", async () => {
    queue.push(message([{ type: "text", text: "done" }], "stop_sequence"));
    const out = await anthropicComplete({ tool: "prose", model: "claude-opus-4-6", prompt: "x" });
    expect(out.text).toBe("done");
  });

  test("a hang-guard timeout is rethrown at once, never retried", async () => {
    globalThis.fetch = (async () => {
      calls.push({ url: "", headers: {}, body: {} });
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch;
    const err = await anthropicComplete({
      tool: "prose",
      model: "claude-opus-4-6",
      prompt: "x",
    }).catch((e: unknown) => e);
    expect((err as Error).name).toBe("TimeoutError");
    expect(calls).toHaveLength(1);
  });

  test("a 200 body that fails the schema is an error, not a crash on undefined", async () => {
    queue.push(
      () =>
        new Response(JSON.stringify({ id: "msg_x", usage: { input_tokens: 7 }, content: "nope" }), {
          status: 200,
        }),
    );
    await expect(
      anthropicComplete({ tool: "prose", model: "claude-opus-4-6", prompt: "x" }),
    ).rejects.toThrow("unreadable Messages body");
    expect(calls).toHaveLength(1);
  });

  test("a non-anthropic-wire model is refused before any request", async () => {
    await expect(
      anthropicComplete({ tool: "prose", model: "deepseek-v4.1-flash", prompt: "x" }),
    ).rejects.toThrow("not an anthropic-wire model");
    expect(calls).toHaveLength(0);
  });

  test("a client error fails fast, with no retry", async () => {
    queue.push(() => new Response("bad request", { status: 400 }));
    await expect(
      anthropicComplete({ tool: "prose", model: "claude-opus-4-6", prompt: "x" }),
    ).rejects.toThrow("IU anthropic request failed (400)");
    expect(calls).toHaveLength(1);
  });

  test("a 503 wrapping invalid_request_error fails fast, with no retry", async () => {
    queue.push(
      () =>
        new Response(
          '{"error":{"type":"invalid_request_error","message":"thinking.type.enabled"}}',
          {
            status: 503,
          },
        ),
    );
    await expect(
      anthropicComplete({ tool: "prose", model: "claude-opus-4-6", prompt: "x" }),
    ).rejects.toThrow("IU anthropic request failed (503)");
    expect(calls).toHaveLength(1);
  });

  test("a 503 is retried, then succeeds", async () => {
    queue.push(() => new Response("busy", { status: 503 }));
    queue.push(message([{ type: "text", text: "ok" }], "end_turn"));
    const out = await anthropicComplete({ tool: "prose", model: "claude-opus-4-6", prompt: "x" });
    expect(out.text).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  test("a cancel seen before a retry stops it: no second billed call", async () => {
    queue.push(() => new Response("busy", { status: 503 }));
    let polls = 0;
    const err = await anthropicComplete({
      tool: "prose",
      model: "claude-opus-4-6",
      prompt: "x",
      isCancelled: () => ++polls > 0,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SingleShotCancelledError);
    expect(calls).toHaveLength(1);
  });

  test("isCancelled is never polled before the first attempt", async () => {
    queue.push(message([{ type: "text", text: "ok" }], "end_turn"));
    const out = await anthropicComplete({
      tool: "prose",
      model: "claude-opus-4-6",
      prompt: "x",
      isCancelled: () => true,
    });
    expect(out.text).toBe("ok");
  });

  test("a content error carries the billed usage and the stop reason", async () => {
    queue.push(message([{ type: "text", text: "cut off mid-sen" }], "max_tokens"));
    const err = (await anthropicComplete({
      tool: "prose",
      model: "claude-opus-4-6",
      prompt: "x",
    }).catch((e: unknown) => e)) as InstanceType<typeof AnthropicContentError>;
    expect(err.stopReason).toBe("max_tokens");
    expect(err.usage).toMatchObject({ inputTokens: 120, outputTokens: 50 });
  });

  test("a 200 whose body is not JSON is an unreadable-body error, not a SyntaxError", async () => {
    queue.push(() => new Response("<html>gateway hiccup</html>", { status: 200 }));
    await expect(
      anthropicComplete({ tool: "prose", model: "claude-opus-4-6", prompt: "x" }),
    ).rejects.toThrow("unreadable Messages body");
    expect(calls).toHaveLength(1);
  });
});
