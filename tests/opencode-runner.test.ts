// Pure helpers of the OpenCode harness (server/mcp/opencode-runner.ts): the model guard, the
// in-band JSON-schema instruction, secret redaction, the message summarizer (everything an attempt
// reports — tokens, cost, final text, outcome — folds out of the server's message records) and the
// activity fingerprint behind the idle watchdog. The session lifecycle is in
// tests/opencode-lifecycle.test.ts, the attempt in tests/opencode-attempt.test.ts, the server in
// tests/opencode-server.test.ts and the HTTP adapter in tests/opencode-client.test.ts.

import { describe, expect, test } from "bun:test";
import { getModel } from "../server/lib/models.ts";
import {
  appendJsonSchemaInstruction,
  opencodeActivityFingerprint,
  opencodeModel,
  redactSecret,
  summarizeOpencodeMessages,
} from "../server/mcp/opencode-runner.ts";
import {
  assistantMessage,
  idleMessage,
  reasoning,
  shellTool,
  text,
  userMessage,
} from "./helpers/fake-opencode-client.ts";

describe("opencodeModel", () => {
  test("returns the registry entry of a chat-wire and a responses-wire opencode model", () => {
    expect(opencodeModel("deepseek-v4.1-flash").wire).toBe("chat");
    expect(opencodeModel("gpt-6.1-sol").wire).toBe("responses");
  });

  test("refuses a model that is unregistered or not usable on the opencode harness", () => {
    expect(() => opencodeModel("not-a-model")).toThrow(/unknown model/);
    expect(() => opencodeModel("DeepSeek-V4-Flash")).toThrow(/not usable on the opencode harness/);
  });
});

describe("appendJsonSchemaInstruction", () => {
  test("appends the prompt and the schema, final-message-only instruction present", () => {
    const out = appendJsonSchemaInstruction("do the thing", { type: "object", properties: {} });
    expect(out.startsWith("do the thing")).toBe(true);
    expect(out).toContain("FINAL message must be ONLY a single JSON object");
    expect(out).toContain('"type": "object"');
  });
});

describe("redactSecret", () => {
  test("replaces every occurrence with a fixed placeholder", () => {
    expect(redactSecret("key=sk-abc123 and again sk-abc123 done", "sk-abc123")).toBe(
      "key=[REDACTED] and again [REDACTED] done",
    );
  });

  test("an empty secret is a no-op — never redacts against an empty string", () => {
    expect(redactSecret("hello world", "")).toBe("hello world");
  });

  test("text with no occurrence is returned unchanged", () => {
    expect(redactSecret("nothing sensitive here", "sk-abc123")).toBe("nothing sensitive here");
  });
});

describe("summarizeOpencodeMessages", () => {
  test("an empty session summarizes to zeros and the 'starting' action", () => {
    expect(summarizeOpencodeMessages([])).toEqual({
      turns: 0,
      lastAction: "starting",
      lastAssistantText: "",
      endedOnText: false,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    });
  });

  test("a long-context tier reprices only the messages whose own prompt crosses the threshold", () => {
    const haiku = getModel("claude-haiku-5-5-eu");
    const small = assistantMessage({
      content: [text("a")],
      tokens: { input: 10, output: 1_000, reasoning: 0, cacheRead: 50_000, cacheWrite: 1_000 },
      cost: 0.0123,
    });
    const big = assistantMessage({
      content: [text("b")],
      tokens: { input: 10, output: 1_000, reasoning: 0, cacheRead: 150_000, cacheWrite: 0 },
      cost: 0.0045, // OpenCode's flat-rate price, which the tier replaces
    });
    const summary = summarizeOpencodeMessages([small, big], haiku);
    // big: 10*0.5 + 150000*0.05 + 1000*2.5 per MTok = 0.0000050 + 0.0075 + 0.0025
    expect(summary.costUsd).toBeCloseTo(
      0.0123 + (10 * 0.5 + 150_000 * 0.05 + 1_000 * 2.5) / 1e6,
      8,
    );
    // without the model the flat OpenCode cost is summed unchanged
    expect(summarizeOpencodeMessages([small, big]).costUsd).toBeCloseTo(0.0168, 8);
  });

  test("sums tokens, cost and turns over every assistant message", () => {
    const summary = summarizeOpencodeMessages([
      userMessage("go"),
      assistantMessage({
        content: [shellTool("ls")],
        tokens: { input: 100, output: 20, reasoning: 5, cacheRead: 1000, cacheWrite: 7 },
        cost: 0.25,
      }),
      assistantMessage({
        content: [text("done")],
        tokens: { input: 50, output: 10, reasoning: 2, cacheRead: 500, cacheWrite: 3 },
        cost: 0.125,
      }),
      idleMessage(),
    ]);
    expect(summary).toMatchObject({
      turns: 2,
      inputTokens: 150,
      outputTokens: 30,
      reasoningTokens: 7,
      cacheReadTokens: 1500,
      cacheWriteTokens: 10,
      costUsd: 0.375,
    });
  });

  test("a message without tokens is not a finished turn but its cost still counts", () => {
    const summary = summarizeOpencodeMessages([
      assistantMessage({ content: [shellTool("ls", "running")], tokens: null, cost: 0.1 }),
    ]);
    expect(summary.turns).toBe(0);
    expect(summary.costUsd).toBe(0.1);
  });

  test("missing token fields count as zero (partial wire objects)", () => {
    const partial = { ...assistantMessage(), tokens: { output: 4 } };
    const summary = summarizeOpencodeMessages([partial]);
    expect(summary).toMatchObject({
      turns: 1,
      inputTokens: 0,
      outputTokens: 4,
      cacheReadTokens: 0,
    });
  });

  test("the final text is the newest non-empty text block, across messages", () => {
    const summary = summarizeOpencodeMessages([
      assistantMessage({ content: [text("first"), text("second")] }),
      assistantMessage({ content: [shellTool("ls")] }),
      assistantMessage({ content: [text("  "), text("last")] }),
    ]);
    expect(summary.lastAssistantText).toBe("last");
  });

  test("multiple text blocks in one message are joined", () => {
    const summary = summarizeOpencodeMessages([
      assistantMessage({ content: [text("a"), text("b")] }),
    ]);
    expect(summary.lastAssistantText).toBe("a\nb");
    expect(summary.endedOnText).toBe(true);
  });

  test("endedOnText ignores trailing reasoning blocks but not a trailing tool block", () => {
    expect(
      summarizeOpencodeMessages([assistantMessage({ content: [text("answer"), reasoning()] })])
        .endedOnText,
    ).toBe(true);
    const narrated = summarizeOpencodeMessages([
      assistantMessage({ content: [text("narration"), shellTool("ls"), reasoning()] }),
    ]);
    expect(narrated.endedOnText).toBe(false);
    // The narration is still the last text — callers decide it is not a verdict.
    expect(narrated.lastAssistantText).toBe("narration");
  });

  test("endedOnText follows the NEWEST assistant message", () => {
    const summary = summarizeOpencodeMessages([
      assistantMessage({ content: [text("answer")] }),
      assistantMessage({ content: [shellTool("ls")] }),
    ]);
    expect(summary.endedOnText).toBe(false);
  });

  test("the newest assistant message's error is surfaced: message, then type, then 'unknown'", () => {
    const err = (error: { type?: string; message?: string }) =>
      summarizeOpencodeMessages([assistantMessage({ content: [], error })]).errorMessage;
    expect(err({ type: "provider.auth", message: "HTTP 401" })).toBe("HTTP 401");
    expect(err({ type: "provider.no-route" })).toBe("provider.no-route");
    expect(err({})).toBe("unknown");
  });

  test("an error on an older assistant message is not the session's error", () => {
    const summary = summarizeOpencodeMessages([
      assistantMessage({ error: { message: "transient" } }),
      assistantMessage({ content: [text("recovered")] }),
    ]);
    expect(summary.errorMessage).toBeUndefined();
  });

  test("outcome is the newest idle message's; absent while the session never went idle", () => {
    expect(summarizeOpencodeMessages([assistantMessage()]).outcome).toBeUndefined();
    expect(
      summarizeOpencodeMessages([
        idleMessage("interrupted"),
        assistantMessage(),
        idleMessage("failed"),
      ]).outcome,
    ).toBe("failed");
  });

  test("lastAction is the newest tool block, labelled per tool", () => {
    const action = (block: ReturnType<typeof shellTool>) =>
      summarizeOpencodeMessages([assistantMessage({ content: [block] })]).lastAction;
    expect(action(shellTool("git status"))).toBe("shell: git status");
    expect(action({ ...shellTool("x"), name: "bash" })).toBe("bash: x");
    expect(
      action({
        type: "tool",
        name: "edit",
        state: { status: "completed", input: { filePath: "/repo/src/evaluators.py" } },
      }),
    ).toBe("edit evaluators.py");
    expect(action({ type: "tool", name: "glob" })).toBe("glob");
    expect(action({ type: "tool" })).toBe("tool");
  });

  test("lastAction picks the last tool block of the newest assistant message that has one", () => {
    const summary = summarizeOpencodeMessages([
      assistantMessage({ content: [shellTool("old")] }),
      assistantMessage({ content: [shellTool("first"), text("hm"), shellTool("second")] }),
      assistantMessage({ content: [text("done")] }),
    ]);
    expect(summary.lastAction).toBe("shell: second");
  });

  test("a long shell command is cut to 50 characters", () => {
    const summary = summarizeOpencodeMessages([
      assistantMessage({ content: [shellTool("x".repeat(80))] }),
    ]);
    expect(summary.lastAction).toBe(`shell: ${"x".repeat(50)}`);
  });
});

describe("opencodeActivityFingerprint", () => {
  const window = () => [
    assistantMessage({ content: [text("hello"), shellTool("ls", "running")], tokens: null }),
    userMessage("go"),
  ];

  test("identical windows fingerprint identically", () => {
    const messages = window();
    expect(opencodeActivityFingerprint(messages)).toBe(opencodeActivityFingerprint([...messages]));
  });

  test("a new message, new text, a tool changing state or output tokens landing each change it", () => {
    const base = window();
    const fp = opencodeActivityFingerprint(base);
    const [newest = assistantMessage(), ...rest] = base;

    expect(opencodeActivityFingerprint([assistantMessage(), ...base])).not.toBe(fp);
    expect(
      opencodeActivityFingerprint([
        { ...newest, content: [text("hello world"), shellTool("ls", "running")] },
        ...rest,
      ]),
    ).not.toBe(fp);
    expect(
      opencodeActivityFingerprint([
        { ...newest, content: [text("hello"), shellTool("ls", "completed")] },
        ...rest,
      ]),
    ).not.toBe(fp);
    expect(opencodeActivityFingerprint([{ ...newest, tokens: { output: 12 } }, ...rest])).not.toBe(
      fp,
    );
    expect(opencodeActivityFingerprint([{ ...newest, finish: "tool-calls" }, ...rest])).not.toBe(
      fp,
    );
  });

  test("provider retry bookkeeping and other unknown fields do not change it", () => {
    const base = window();
    const fp = opencodeActivityFingerprint(base);
    const [newest = assistantMessage(), ...rest] = base;
    expect(
      opencodeActivityFingerprint([
        { ...newest, retry: { attempt: 3, delayMs: 8000 }, error: undefined, cost: 9 },
        ...rest,
      ]),
    ).toBe(fp);
  });

  test("an empty window is stable", () => {
    expect(opencodeActivityFingerprint([])).toBe("[]");
  });
});
