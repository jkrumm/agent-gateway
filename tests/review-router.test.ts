// review's angle router runs as ONE tool-less completion (`singleShotJson`, route
// `review_router`) — no worker session. The diff has to be inline in the prompt, the answer is
// reduced to the router-only angle keys, and any failure degrades to "no extra angles".
// The model call is stubbed at `globalThis.fetch` (tests/single-shot.test.ts's seam).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SIDECLAW_IU_USAGE_LOG = join(
  tmpdir(),
  `sideclaw-review-router-test-${Date.now()}.jsonl`,
);
process.env.IU_API_KEY = "test-key";
process.env.IU_BASE_URL = "https://iu.example.com/anthropic";

const { routeExtraAngles } = await import("../server/jobs/handlers/review.ts");

const originalFetch = globalThis.fetch;
let bodies: Record<string, unknown>[] = [];
let queue: string[] = [];

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
});

describe("routeExtraAngles (single-shot router)", () => {
  test("sends the diff inline, fenced, in one JSON-mode call; keeps only router-only angle keys", async () => {
    queue = ['{"angles":["security","architect","made-up"],"rationale":"auth change"}'];
    const angles = await routeExtraAngles("diff --git a/x b/x\n+token = leak()");
    expect(angles).toEqual([{ angle: "security", label: "Security Reviewer" }]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.response_format).toEqual({ type: "json_object" });
    expect(bodies[0]?.model).toBe("deepseek-v4.1-flash");
    const sent = sentPrompt(0);
    expect(sent).toContain("+token = leak()");
    expect(sent).toMatch(/<<<DIFF_[0-9a-f]{12}_BEGIN>>>/);
    expect(sent).not.toContain("[GIT_DIFF_COMMAND]");
  });

  test("an empty answer list is a valid result", async () => {
    queue = ['{"angles":[]}'];
    expect(await routeExtraAngles("diff")).toEqual([]);
  });

  test("fail-soft: an unusable answer twice (and so a thrown single-shot) yields no extra angles", async () => {
    queue = ["not json", '{"nope":true}'];
    expect(await routeExtraAngles("diff")).toEqual([]);
    expect(bodies).toHaveLength(2);
  });

  test("a very large diff is truncated, not sent whole", async () => {
    queue = ['{"angles":[]}'];
    await routeExtraAngles("a".repeat(250_000));
    const sent = sentPrompt(0);
    expect(sent).toContain("[diff truncated at 200000 chars]");
    expect(sent.length).toBeLessThan(230_000);
  });
});
