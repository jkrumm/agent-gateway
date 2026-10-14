// Completion decision of runOpencodeAttempt, end to end over a FAKE subprocess that streams
// opencode 2.x NDJSON (the captured fixture plus truncated/errored variants). No real binary,
// no network: preflight, server status, password and spawn are injected.

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

const okDeps = {
  preflight: async () => ({ ok: true as const }),
  serverStatus: async () => ({
    ok: true,
    up: true,
    version: "2.0.25",
    pinned: "2.0.25",
    versionOk: true,
  }),
  password: () => "test-password",
  interrupt: async () => ({ ok: true, interrupted: false }),
};

const run = (lines: string[], exitCode = 0) =>
  runOpencodeAttempt(
    { cwd: "/tmp", prompt: "p", route: routeFor("dispatch") },
    { current: 0 },
    { model: "deepseek-v4.1-flash", backend: "iu" },
    { ...okDeps, spawn: () => fakeProc(lines, exitCode) },
  );

const text = (t: string) =>
  JSON.stringify({ type: "text", sessionID: "ses_x", part: { type: "text", text: t } });
const toolUse = JSON.stringify({
  type: "tool_use",
  sessionID: "ses_x",
  part: { type: "tool", tool: "shell", state: { status: "completed", input: { command: "ls" } } },
});

describe("runOpencodeAttempt — spawn", () => {
  test("attaches to the shared server: --server <url> --agent, the password in the client env, cwd as PWD", async () => {
    const calls: Array<{ argv: string[]; env: Record<string, string>; cwd?: string }> = [];
    await runOpencodeAttempt(
      { cwd: "/tmp", prompt: "p", readOnly: true, route: routeFor("dispatch") },
      { current: 0 },
      { model: "deepseek-v4.1-flash", backend: "iu" },
      {
        ...okDeps,
        spawn: (argv, options) => {
          calls.push({
            argv,
            env: (options?.env ?? {}) as Record<string, string>,
            cwd: options?.cwd as string | undefined,
          });
          return fakeProc([text('{"answer":1}')]);
        },
      },
    );
    expect(calls).toHaveLength(1);
    const { argv, env, cwd } = calls[0] ?? { argv: [], env: {} };
    expect(argv[argv.indexOf("--server") + 1]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(argv[argv.indexOf("--agent") + 1]).toBe("agw-readonly");
    expect(argv).not.toContain("--standalone");
    expect(env.OPENCODE_SERVER_PASSWORD).toBe("test-password");
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(env.PWD).toBe("/tmp");
    expect(cwd).toBe("/tmp");
  });

  test("a non-zero exit is a single attempt — a 'database is locked' stderr is not retried here", async () => {
    let spawns = 0;
    const result = await runOpencodeAttempt(
      { cwd: "/tmp", prompt: "p", route: routeFor("dispatch") },
      { current: 0 },
      { model: "deepseek-v4.1-flash", backend: "iu" },
      {
        ...okDeps,
        spawn: () => {
          spawns++;
          return fakeProc([], 1);
        },
      },
    );
    expect(spawns).toBe(1);
    expect(result.ok).toBe(false);
  });
});

describe("runOpencodeAttempt — extraEnv", () => {
  test("a variable the server does not carry is refused loudly, before any spawn", async () => {
    await expect(
      runOpencodeAttempt(
        { cwd: "/tmp", prompt: "p", extraEnv: { SOME_NEW_VAR: "x" }, route: routeFor("dispatch") },
        { current: 0 },
        { model: "deepseek-v4.1-flash", backend: "iu" },
        {
          ...okDeps,
          spawn: () => {
            throw new Error("must not spawn");
          },
        },
      ),
    ).rejects.toThrow(/extraEnv SOME_NEW_VAR cannot reach a worker/);
  });

  test("research-gateway credentials are dropped: the attempt runs, the worker never sees them", async () => {
    let spawnedEnv: Record<string, string> = {};
    const result = await runOpencodeAttempt(
      {
        cwd: "/tmp",
        prompt: "p",
        extraEnv: {
          RESEARCH_GATEWAY_URL: "https://r.example",
          RESEARCH_GATEWAY_TOKEN: "rs-secret",
        },
        route: routeFor("dispatch"),
      },
      { current: 0 },
      { model: "deepseek-v4.1-flash", backend: "iu" },
      {
        ...okDeps,
        spawn: (_argv, options) => {
          spawnedEnv = (options?.env ?? {}) as Record<string, string>;
          return fakeProc([text('{"answer":1}')]);
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(Object.keys(spawnedEnv)).not.toContain("RESEARCH_GATEWAY_TOKEN");
    expect(Object.values(spawnedEnv)).not.toContain("rs-secret");
  });

  test("dispatch's GIT_DENY_CREDENTIALS_ENV is accepted", async () => {
    const { GIT_DENY_CREDENTIALS_ENV } = await import("../server/jobs/handlers/dispatch-git.ts");
    const result = await runOpencodeAttempt(
      { cwd: "/tmp", prompt: "p", extraEnv: GIT_DENY_CREDENTIALS_ENV, route: routeFor("dispatch") },
      { current: 0 },
      { model: "deepseek-v4.1-flash", backend: "iu" },
      { ...okDeps, spawn: () => fakeProc([text('{"answer":1}')]) },
    );
    expect(result.ok).toBe(true);
  });
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
