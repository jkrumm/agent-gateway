// Completion decision of runOpencodeAttempt, end to end over a FAKE subprocess that streams
// opencode 2.x NDJSON (the captured fixture plus truncated/errored variants). No real binary,
// no network: preflight and spawn are injected.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runOpencodeAttempt, type OpencodeSubprocess } from "../server/mcp/opencode-runner.ts";
import { __resetActiveProcsForTests } from "../server/mcp/session-runner.ts";
import { routeFor } from "../server/lib/routing.ts";

const savedEnv = { key: process.env.IU_API_KEY, base: process.env.IU_BASE_URL };
beforeEach(() => {
  process.env.IU_API_KEY = "test-key";
  process.env.IU_BASE_URL = "https://iu.example.invalid/anthropic";
});
afterEach(() => {
  __resetActiveProcsForTests();
  for (const [name, value] of [
    ["IU_API_KEY", savedEnv.key],
    ["IU_BASE_URL", savedEnv.base],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const fixtureLines = readFileSync(
  new URL("./fixtures/opencode-events.jsonl", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter(Boolean);

function fakeProc(lines: string[], exitCode = 0): OpencodeSubprocess {
  const enc = new TextEncoder();
  const stream = (chunk: string) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        if (chunk) c.enqueue(enc.encode(chunk));
        c.close();
      },
    });
  return {
    pid: 4242,
    exitCode,
    stdout: stream(lines.map((l) => `${l}\n`).join("")),
    stderr: stream(""),
    exited: Promise.resolve(exitCode),
    kill() {},
  } as unknown as OpencodeSubprocess;
}

const run = (lines: string[], exitCode = 0) =>
  runOpencodeAttempt(
    { cwd: "/tmp", prompt: "p", route: routeFor("dispatch") },
    { current: 0 },
    { model: "deepseek-v4.1-flash", backend: "iu" },
    { preflight: async () => ({ ok: true }), spawn: () => fakeProc(lines, exitCode) },
  );

const text = (t: string) =>
  JSON.stringify({ type: "text", sessionID: "ses_x", part: { type: "text", text: t } });
const toolUse = JSON.stringify({
  type: "tool_use",
  sessionID: "ses_x",
  part: { type: "tool", tool: "shell", state: { status: "completed", input: { command: "ls" } } },
});

describe("runOpencodeAttempt — completion", () => {
  test("a captured 2.x success stream (final text, no terminal step_finish, exit 0) is ok", async () => {
    const result = await run([...fixtureLines.slice(0, -1), text('{"answer":1}')]);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ answer: 1 });
  });

  test("a stream cut off after mid-loop narration, ending on a tool call, is NOT a completion", async () => {
    // Narration that happens to be valid JSON must not be returned as the verdict.
    const result = await run([text('{"answer":"narration"}'), toolUse]);
    expect(result.ok).toBe(false);
    expect(result.noOutput).toBe(true);
    expect(result.error).toContain("ended on a tool call");
  });

  test("an error event at exit 0 fails the attempt", async () => {
    const result = await run([
      text('{"answer":1}'),
      JSON.stringify({ type: "error", error: { type: "provider.auth", message: "boom" } }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
  });

  test("no text at all is a no-output failure", async () => {
    const result = await run([toolUse]);
    expect(result.ok).toBe(false);
    expect(result.noOutput).toBe(true);
  });
});
