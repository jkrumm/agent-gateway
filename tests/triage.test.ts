// `triage`: handler (server/jobs/handlers/triage.ts), job wiring (types / executor / store
// recovery) and the MCP registration. The model call is stubbed at `globalThis.fetch`, as in
// tests/single-shot.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_GATEWAY_IU_USAGE_LOG = join(
  tmpdir(),
  `agent-gateway-triage-test-${Date.now()}.jsonl`,
);
process.env.IU_API_KEY = "test-key";
process.env.IU_BASE_URL = "https://iu.example.com/anthropic";

const { runTriage, TRIAGE_INPUT } = await import("../server/jobs/handlers/triage.ts");
const { executeJob } = await import("../server/jobs/executor.ts");
const { recoveryStatusFor } = await import("../server/jobs/store.ts");
const { isJobTool } = await import("../server/jobs/types.ts");
const { registerTriageTool } = await import("../server/mcp/tools/triage.ts");
const { describeRoute, routeFor } = await import("../server/lib/routing.ts");

const originalFetch = globalThis.fetch;
let bodies: Record<string, unknown>[] = [];
let queue: string[] = [];

function sse(text: string): Response {
  const content = { id: "c1", model: "m", choices: [{ delta: { content: text } }] };
  const body = `data: ${JSON.stringify(content)}\n\ndata: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
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
    if (next === undefined) throw new Error("unexpected extra fetch");
    return sse(next);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["attach", "new", "ignore"] },
    item: { type: "integer" },
  },
  required: ["action"],
};

describe("runTriage", () => {
  test("returns the validated answer with model, latency and attempts", async () => {
    queue = ['{"action":"attach","item":3}'];
    const out = await runTriage({ prompt: "event: disk full", schema: SCHEMA });
    expect(out.result).toEqual({ action: "attach", item: 3 });
    expect(out.attempts).toBe(1);
    expect(out.model).toBe("deepseek-v4.1-flash");
    expect(typeof out.latencyMs).toBe("number");
  });

  test("the prompt carries the caller's text first and the schema in the output contract after", async () => {
    queue = ['{"action":"ignore"}'];
    await runTriage({ prompt: "CALLER TEXT", schema: SCHEMA });
    const sent = sentPrompt(0);
    expect(sent.startsWith("CALLER TEXT")).toBe(true);
    expect(sent.indexOf("Output contract")).toBeGreaterThan(sent.indexOf("CALLER TEXT"));
    expect(sent).toContain('"enum": [');
    expect(sent).toContain('"attach"');
  });

  test("a non-conforming answer is re-asked once (attempts 2); two bad answers fail the job", async () => {
    queue = ['{"action":"explode"}', '{"action":"new"}'];
    expect((await runTriage({ prompt: "p", schema: SCHEMA })).attempts).toBe(2);

    queue = ['{"item":1}', '{"action":"nope"}'];
    await expect(runTriage({ prompt: "p", schema: SCHEMA })).rejects.toThrow(/rejected after 2/);
  });

  test("type mismatches against the caller's schema are rejected", async () => {
    queue = ['{"action":"new","item":"seven"}', '{"action":"new","item":2.5}'];
    await expect(runTriage({ prompt: "p", schema: SCHEMA })).rejects.toThrow(/item/);
  });

  test("invalid params fail before any model call", async () => {
    await expect(runTriage({ schema: SCHEMA })).rejects.toThrow(/invalid params: prompt/);
    await expect(runTriage({ prompt: "p", schema: { type: "array" } })).rejects.toThrow(
      /invalid params: schema/,
    );
    await expect(
      runTriage({ prompt: "p", schema: { type: "object", properties: { a: { type: "bogus" } } } }),
    ).rejects.toThrow(/invalid params: schema/);
    expect(bodies).toHaveLength(0);
  });
});

describe("triage job wiring", () => {
  test("isJobTool accepts triage", () => {
    expect(isJobTool("triage")).toBe(true);
  });

  test("an interrupted triage is re-queued once, like check/review", () => {
    expect(recoveryStatusFor("triage", 1)).toBe("pending");
    expect(recoveryStatusFor("triage", 2)).toBe("interrupted");
  });

  test("executeJob routes a triage job to the handler", async () => {
    queue = ['{"action":"new"}'];
    const result = (await executeJob(
      {
        id: "j1",
        tool: "triage",
        params: { prompt: "p", schema: SCHEMA },
        status: "running",
        result: null,
        error: null,
        progress: null,
        attempts: 1,
        createdAt: Date.now(),
        startedAt: Date.now(),
        finishedAt: null,
        cancelRequestedAt: null,
        sessionId: null,
        worktreeMeta: null,
      },
      () => {},
    )) as { result: unknown; attempts: number };
    expect(result.result).toEqual({ action: "new" });
    expect(result.attempts).toBe(1);
  });
});

describe("triage MCP tool", () => {
  test("registers through registerJobSubmitTool with the handler's input shape and the route in its description", () => {
    const registered: { name: string; config: { description: string; inputSchema: object } }[] = [];
    const server = {
      registerTool: (name: string, config: { description: string; inputSchema: object }) => {
        registered.push({ name, config });
      },
    };
    registerTriageTool(server as never);
    expect(registered).toHaveLength(1);
    expect(registered[0]?.name).toBe("triage");
    expect(Object.keys(registered[0]?.config.inputSchema ?? {})).toEqual(
      Object.keys(TRIAGE_INPUT.shape),
    );
    expect(registered[0]?.config.description).toContain(
      `MODEL: ${describeRoute(routeFor("triage"))}`,
    );
  });
});
