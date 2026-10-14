// Pure builders + the NDJSON event mapper for the OpenCode harness (server/mcp/opencode-runner.ts).
// The server it attaches to (config, permission agents, env, status) is tested in
// tests/opencode-server.test.ts.
// `tests/fixtures/opencode-events.jsonl` is a trimmed excerpt of a REAL successful
// `opencode run --standalone --format json` stream, captured 2026-10-11 against opencode 2.0.25
// (`iu-chat/deepseek-v4.1-flash#high`). Note it ends on a `text` event with NO terminal
// `step_finish(reason: "stop")` — 2.x drops that event under `--standalone`, the behaviour the
// completion path must tolerate. (`run --server` shares the NDJSON shape; the parser is unchanged.)
// `tests/fixtures/opencode-events-error.jsonl` is two REAL failing runs (an unknown model id, a
// rejected apiKey), captured the same day with the same binary — the flat `{type, message}`
// `error` shape 2.x emits (1.x nested it under `error.data`).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendJsonSchemaInstruction,
  assertExtraEnvCarriedByServer,
  buildOpencodeArgs,
  buildOpencodeEnv,
  computeOpencodeCostUsd,
  INITIAL_OPENCODE_ACCUM,
  redactSecret,
  reduceOpencodeEvent,
  runOpencodeAttempt,
} from "../server/mcp/opencode-runner.ts";
import { opencodeServerCarriedEnv } from "../server/mcp/opencode-server.ts";
import { routeFor } from "../server/lib/routing.ts";

function readFixture(name: string): unknown[] {
  return readFileSync(join(import.meta.dir, "fixtures", name), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

const URL_ = "http://127.0.0.1:49375";

describe("buildOpencodeArgs", () => {
  test("bare invocation — --server <url> --agent, model-as-iu-chat/<model>, format json, -- before the prompt", () => {
    const argv = buildOpencodeArgs({
      bin: "/opt/homebrew/bin/opencode",
      url: URL_,
      readOnly: false,
      model: "deepseek-v4.1-flash",
      prompt: "investigate the thing",
    });
    expect(argv).toEqual([
      "/opt/homebrew/bin/opencode",
      "run",
      "--server",
      URL_,
      "--agent",
      "agw-implement",
      "-m",
      "iu-chat/deepseek-v4.1-flash",
      "--format",
      "json",
      "--",
      "investigate the thing",
    ]);
  });

  test("readOnly selects the agw-readonly agent, writable the agw-implement agent", () => {
    const base = { bin: "opencode", url: URL_, model: "deepseek-v4.1-flash", prompt: "p" };
    const agentOf = (readOnly: boolean) => {
      const argv = buildOpencodeArgs({ ...base, readOnly });
      return argv[argv.indexOf("--agent") + 1];
    };
    expect(agentOf(true)).toBe("agw-readonly");
    expect(agentOf(false)).toBe("agw-implement");
  });

  test("no --standalone, and no permission/env/config flag the CLI does not have", () => {
    const argv = buildOpencodeArgs({
      bin: "opencode",
      url: URL_,
      readOnly: true,
      model: "deepseek-v4.1-flash",
      prompt: "p",
    });
    for (const flag of ["--standalone", "--auto", "--pure", "--dir", "--variant"]) {
      expect(argv).not.toContain(flag);
    }
  });

  test("a responses-wire (GPT) model is prefixed with the iu-responses provider", () => {
    const argv = buildOpencodeArgs({
      bin: "opencode",
      url: URL_,
      readOnly: false,
      model: "gpt-6.1-sol",
      prompt: "p",
    });
    expect(argv[argv.indexOf("-m") + 1]).toBe("iu-responses/gpt-6.1-sol");
  });

  test("a prompt that starts with a dash is still the message, not a flag — the -- guard", () => {
    // Measured live 2026-09-24: without `--`, opencode's own yargs CLI parses a leading-dash
    // message as an unknown flag, prints --help and exits 0 with no session ever starting.
    const argv = buildOpencodeArgs({
      bin: "opencode",
      url: URL_,
      readOnly: false,
      model: "deepseek-v4.1-flash",
      prompt: "-foo, do the thing",
    });
    const dashDashIndex = argv.indexOf("--");
    expect(dashDashIndex).toBeGreaterThan(-1);
    expect(argv[dashDashIndex + 1]).toBe("-foo, do the thing");
    expect(argv.at(-1)).toBe("-foo, do the thing");
  });

  test("variant is folded into the model ref as provider/model#variant (2.x; no --variant flag)", () => {
    const argv = buildOpencodeArgs({
      bin: "opencode",
      url: URL_,
      readOnly: false,
      model: "deepseek-v4.1-flash",
      variant: "max",
      prompt: "p",
    });
    expect(argv[argv.indexOf("-m") + 1]).toBe("iu-chat/deepseek-v4.1-flash#max");
    expect(argv).not.toContain("--variant");
    expect(argv.indexOf("--")).toBeGreaterThan(argv.indexOf("-m"));
  });

  test("resumeSessionId emits --session <id>", () => {
    const argv = buildOpencodeArgs({
      bin: "opencode",
      url: URL_,
      readOnly: false,
      model: "deepseek-v4.1-flash",
      resumeSessionId: "ses_abc123",
      prompt: "continue",
    });
    const i = argv.indexOf("--session");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe("ses_abc123");
  });
});

describe("buildOpencodeEnv (the CLIENT process env)", () => {
  test("PWD is pinned to cwd (overriding an inherited PWD) and the server password is set", () => {
    const env = buildOpencodeEnv({
      tool: "dispatch",
      cwd: "/worktree/abc",
      password: "pw-123",
      baseEnv: { PWD: "/stale/server/cwd", PATH: "/usr/bin" },
    });
    expect(env.PWD).toBe("/worktree/abc");
    expect(env.OPENCODE_SERVER_PASSWORD).toBe("pw-123");
    expect(env.PATH).toBe("/usr/bin");
  });

  test("an inherited server password is replaced, not scrubbed away or kept", () => {
    const env = buildOpencodeEnv({
      cwd: "/tmp",
      password: "fresh",
      baseEnv: { OPENCODE_SERVER_PASSWORD: "stale" },
    });
    expect(env.OPENCODE_SERVER_PASSWORD).toBe("fresh");
  });

  test("every inherited opencode config source is deleted — the server's config is the only one", () => {
    const env = buildOpencodeEnv({
      cwd: "/tmp",
      password: "p",
      baseEnv: {
        OPENCODE_CONFIG: "/some/inherited/path.json",
        OPENCODE_CONFIG_DIR: "/some/dir",
        OPENCODE_CONFIG_CONTENT: "{}",
        OPENCODE_CLI_CONFIG_CONTENT: "{}",
      },
    });
    for (const name of [
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_DIR",
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_CLI_CONFIG_CONTENT",
    ]) {
      expect(env[name], name).toBeUndefined();
    }
  });

  test("no IU credential is handed to the client — the server holds it", () => {
    const env = buildOpencodeEnv({
      cwd: "/tmp",
      password: "p",
      baseEnv: { IU_KEY: "sk-secret-123", IU_API_KEY: "sk-secret-123", PATH: "/usr/bin" },
    });
    expect(Object.values(env)).not.toContain("sk-secret-123");
  });

  test("scrub removes credential-shaped inherited env vars", () => {
    const env = buildOpencodeEnv({
      tool: "dispatch",
      cwd: "/tmp",
      password: "p",
      baseEnv: { GITHUB_TOKEN: "ghp_leaked", SOME_API_KEY: "leaked2", PATH: "/usr/bin" },
    });
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SOME_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  test("USAGE_LANE tags the tool, CLAUDE_SESSION_ID/CLAUDE_PARENT_SESSION_ID are stripped", () => {
    const env = buildOpencodeEnv({
      tool: "dispatch",
      cwd: "/tmp",
      password: "p",
      baseEnv: { CLAUDE_SESSION_ID: "leftover", CLAUDE_PARENT_SESSION_ID: "leftover2" },
    });
    expect(env.USAGE_LANE).toBe("agent-gateway:dispatch");
    expect(env.CLAUDE_ENTRYPOINT).toBe("worker");
    expect(env.CLAUDE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_PARENT_SESSION_ID).toBeUndefined();
  });
});

describe("assertExtraEnvCarriedByServer", () => {
  const carried = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false" };

  test("no extraEnv and an empty extraEnv pass, dropping nothing", () => {
    expect(assertExtraEnvCarriedByServer(undefined, carried)).toEqual({ dropped: [] });
    expect(assertExtraEnvCarriedByServer({}, carried)).toEqual({ dropped: [] });
  });

  test("keys the server carries, with the server's own values, pass", () => {
    expect(assertExtraEnvCarriedByServer({ ...carried }, carried)).toEqual({ dropped: [] });
  });

  test("an unknown key throws loudly and names it", () => {
    expect(() => assertExtraEnvCarriedByServer({ SOME_NEW_VAR: "x" }, carried)).toThrow(
      /extraEnv SOME_NEW_VAR cannot reach a worker/,
    );
  });

  test("a carried key with a different value throws (a stale server would silently win)", () => {
    expect(() => assertExtraEnvCarriedByServer({ GIT_TERMINAL_PROMPT: "1" }, carried)).toThrow(
      /GIT_TERMINAL_PROMPT/,
    );
  });

  test("the research-gateway credentials are DROPPED (reported by key), not thrown on", () => {
    const result = assertExtraEnvCarriedByServer(
      {
        ...carried,
        RESEARCH_GATEWAY_URL: "https://r.example",
        RESEARCH_GATEWAY_TOKEN: "research-secret",
      },
      carried,
    );
    expect(result.dropped.toSorted()).toEqual(["RESEARCH_GATEWAY_TOKEN", "RESEARCH_GATEWAY_URL"]);
    expect(JSON.stringify(result)).not.toContain("research-secret");
  });

  test("a droppable key does not excuse an unknown one next to it", () => {
    expect(() =>
      assertExtraEnvCarriedByServer({ RESEARCH_GATEWAY_URL: "u", OTHER_TOKEN: "t" }, carried),
    ).toThrow(/extraEnv OTHER_TOKEN/);
  });

  test("dispatch's real extraEnv (GIT_DENY_CREDENTIALS_ENV) is accepted against the real carried list", async () => {
    const { GIT_DENY_CREDENTIALS_ENV } = await import("../server/jobs/handlers/dispatch-git.ts");
    expect(
      assertExtraEnvCarriedByServer(GIT_DENY_CREDENTIALS_ENV, opencodeServerCarriedEnv()),
    ).toEqual({
      dropped: [],
    });
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

describe("computeOpencodeCostUsd", () => {
  test("input/output/reasoning/cache-read at the deepseek-v4.1-flash rates, reasoning billed as output", () => {
    const cost = computeOpencodeCostUsd(
      {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        reasoningTokens: 500_000,
        cacheReadTokens: 1_000_000,
      },
      "deepseek-v4.1-flash",
    );
    // 1M input @ $0.15 + 1M (output+reasoning) @ $0.60 + 1M cache-read @ $0.003
    expect(cost).toBeCloseTo(0.15 + 0.6 + 0.003, 6);
  });

  test("uses the rates of the model in use; no registry cache rate bills cache reads at 0.1x input", () => {
    const cost = computeOpencodeCostUsd(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        reasoningTokens: 0,
        cacheReadTokens: 1_000_000,
      },
      "gpt-6.1-sol",
    );
    // $2 input + $10 output + 1M cache-read @ 0.1 x $2
    expect(cost).toBeCloseTo(2 + 10 + 0.2, 6);
  });

  test("zero tokens cost zero", () => {
    expect(
      computeOpencodeCostUsd(
        {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
        },
        "deepseek-v4.1-flash",
      ),
    ).toBe(0);
  });
});

describe("reduceOpencodeEvent over a real captured successful 2.x stream", () => {
  const fixtureLines = readFixture("opencode-events.jsonl");

  test("accumulates turns, tokens, lastAction, lastAssistantText and the session id", () => {
    let accum = INITIAL_OPENCODE_ACCUM;
    for (const ev of fixtureLines) accum = reduceOpencodeEvent(accum, ev as never);

    expect(accum.sessionId).toBe("ses_ed4817882ffeolsUu5rLTg5npK");
    // One step_finish event in the fixture (reason "tool-calls").
    expect(accum.turns).toBe(1);
    // Tokens from that single step_finish.
    expect(accum.inputTokens).toBe(251);
    expect(accum.outputTokens).toBe(37);
    expect(accum.reasoningTokens).toBe(21);
    expect(accum.cacheReadTokens).toBe(18688);
    expect(accum.cacheWriteTokens).toBe(0);
    // The tool_use is a 2.x `shell` call, labelled with the command.
    expect(accum.lastAction).toBe("shell: ls");
    expect(accum.lastAssistantText).toBe("done");
    // No top-level `error` event — a completed session.
    expect(accum.sawErrorEvent).toBe(false);
    // The final `text` ("done") has no following step_finish, so the final turn's usage is
    // unaccounted — exactly the 2.x standalone shape the accounting must flag.
    expect(accum.usageIncomplete).toBe(true);
  });

  test("endedOnText: true after a text, cleared by a following tool_use", () => {
    let accum = reduceOpencodeEvent(INITIAL_OPENCODE_ACCUM, {
      type: "text",
      part: { type: "text", text: "let me apply the change" },
    } as never);
    expect(accum.endedOnText).toBe(true);
    accum = reduceOpencodeEvent(accum, {
      type: "tool_use",
      part: { type: "tool", tool: "shell", state: { input: { command: "ls" } } },
    } as never);
    expect(accum.endedOnText).toBe(false);
    expect(accum.lastAssistantText).toBe("let me apply the change");
  });

  test("a mid-loop step_finish (tool-calls) after a text clears endedOnText; a stop keeps it", () => {
    const text = { type: "text", part: { type: "text", text: "narration" } };
    const finish = (reason: string) => ({ type: "step_finish", part: { reason } });
    let accum = reduceOpencodeEvent(INITIAL_OPENCODE_ACCUM, text as never);
    const midLoop = reduceOpencodeEvent(accum, finish("tool-calls") as never);
    expect(midLoop.endedOnText).toBe(false);
    accum = reduceOpencodeEvent(accum, finish("stop") as never);
    expect(accum.endedOnText).toBe(true);
  });

  test("a terminal step_finish closes the final text turn: usageIncomplete is false", () => {
    let accum = INITIAL_OPENCODE_ACCUM;
    for (const ev of fixtureLines) accum = reduceOpencodeEvent(accum, ev as never);
    accum = reduceOpencodeEvent(accum, {
      type: "step_finish",
      sessionID: "ses_ed4817882ffeolsUu5rLTg5npK",
      part: {
        type: "step-finish",
        reason: "stop",
        tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 0, write: 0 } },
      },
    } as never);
    expect(accum.usageIncomplete).toBe(false);
    // And the terminal turn's tokens are now tallied too.
    expect(accum.inputTokens).toBe(351);
    expect(accum.outputTokens).toBe(87);
  });

  test("a text with no step_finish yet flags usageIncomplete, cleared by the next step_finish", () => {
    let accum = reduceOpencodeEvent(INITIAL_OPENCODE_ACCUM, {
      type: "text",
      sessionID: "s",
      part: { type: "text", text: "answer" },
    } as never);
    expect(accum.usageIncomplete).toBe(true);
    accum = reduceOpencodeEvent(accum, {
      type: "step_finish",
      sessionID: "s",
      part: { type: "step-finish", reason: "stop", tokens: { input: 1, output: 1 } },
    } as never);
    expect(accum.usageIncomplete).toBe(false);
  });

  test("a 2.x success stream carries NO terminal step_finish(reason: stop) — completion must not require it", () => {
    const reasons = fixtureLines.map((ev) => (ev as { part?: { reason?: string } }).part?.reason);
    expect(reasons).not.toContain("stop");
    // The stream ends on the model's final `text`, which is the whole point: a clean exit with a
    // final assistant message is the completion signal on 2.x, not a terminal step_finish.
    expect((fixtureLines.at(-1) as { type?: string }).type).toBe("text");
  });

  test("tallies cache.write across step_finish events, not just cache.read", () => {
    let accum = INITIAL_OPENCODE_ACCUM;
    accum = reduceOpencodeEvent(accum, {
      type: "step_finish",
      sessionID: "s",
      part: {
        type: "step-finish",
        reason: "tool-calls",
        tokens: { cache: { read: 10, write: 4 } },
      },
    } as never);
    accum = reduceOpencodeEvent(accum, {
      type: "step_finish",
      sessionID: "s",
      part: { type: "step-finish", reason: "stop", tokens: { cache: { read: 20, write: 6 } } },
    } as never);
    expect(accum.cacheReadTokens).toBe(30);
    expect(accum.cacheWriteTokens).toBe(10);
  });

  test("sessionId is captured on the FIRST event that carries it, not overwritten later", () => {
    let accum = INITIAL_OPENCODE_ACCUM;
    accum = reduceOpencodeEvent(accum, fixtureLines[0] as never);
    expect(accum.sessionId).toBe("ses_ed4817882ffeolsUu5rLTg5npK");
    accum = reduceOpencodeEvent(accum, {
      ...(fixtureLines[1] as object),
      sessionID: "different-session",
    } as never);
    expect(accum.sessionId).toBe("ses_ed4817882ffeolsUu5rLTg5npK");
  });

  test("a bash tool_use describes as bash: <command>", () => {
    const accum = reduceOpencodeEvent(INITIAL_OPENCODE_ACCUM, {
      type: "tool_use",
      sessionID: "s",
      part: {
        type: "tool",
        tool: "bash",
        state: { status: "completed", input: { command: "git status" } },
      },
    } as never);
    expect(accum.lastAction).toBe("bash: git status");
  });

  test("a 2.x shell tool_use describes as shell: <command>", () => {
    const accum = reduceOpencodeEvent(INITIAL_OPENCODE_ACCUM, {
      type: "tool_use",
      sessionID: "s",
      part: {
        type: "tool",
        tool: "shell",
        state: { status: "completed", input: { command: "git status" } },
      },
    } as never);
    expect(accum.lastAction).toBe("shell: git status");
  });

  test("an edit tool_use describes as <tool> <basename>", () => {
    const accum = reduceOpencodeEvent(INITIAL_OPENCODE_ACCUM, {
      type: "tool_use",
      sessionID: "s",
      part: {
        type: "tool",
        tool: "edit",
        state: { status: "completed", input: { filePath: "/repo/src/evaluators.py" } },
      },
    } as never);
    expect(accum.lastAction).toBe("edit evaluators.py");
  });
});

describe("reduceOpencodeEvent over real captured FAILING 2.x streams", () => {
  test("an unknown model's flat {type, message} error: the message is surfaced", () => {
    const [ev] = readFixture("opencode-events-error.jsonl");
    const accum = reduceOpencodeEvent(INITIAL_OPENCODE_ACCUM, ev as never);
    expect(accum.sawErrorEvent).toBe(true);
    expect(accum.errorMessage).toBe("Model unavailable: iu-chat/does-not-exist");
  });

  test("a rejected apiKey's flat {type, message, status} error: the message is surfaced", () => {
    const [, ev] = readFixture("opencode-events-error.jsonl");
    const accum = reduceOpencodeEvent(INITIAL_OPENCODE_ACCUM, ev as never);
    expect(accum.sawErrorEvent).toBe(true);
    expect(accum.errorMessage).toBe(
      "Provider request failed with HTTP 401: Unauthorized: Authorization parsing failed",
    );
  });

  test("error.type is the fallback when a 2.x error carries no message", () => {
    const accum = reduceOpencodeEvent(INITIAL_OPENCODE_ACCUM, {
      type: "error",
      sessionID: "s",
      error: { type: "provider.no-route" },
    } as never);
    expect(accum.errorMessage).toBe("provider.no-route");
  });

  test("the legacy 1.x nested {name, data:{message}} shape is still read", () => {
    const accum = reduceOpencodeEvent(INITIAL_OPENCODE_ACCUM, {
      type: "error",
      sessionID: "s",
      error: { name: "APIError", data: { message: "legacy message" } },
    } as never);
    expect(accum.errorMessage).toBe("legacy message");
  });

  test("error.name is the last fallback when no message or type is present", () => {
    const accum = reduceOpencodeEvent(INITIAL_OPENCODE_ACCUM, {
      type: "error",
      sessionID: "s",
      error: { name: "SomeBareError" },
    } as never);
    expect(accum.errorMessage).toBe("SomeBareError");
  });

  test("a missing error field does not crash the reducer", () => {
    expect(() =>
      reduceOpencodeEvent(INITIAL_OPENCODE_ACCUM, {
        type: "error",
        sessionID: "s",
        error: undefined,
      } as never),
    ).not.toThrow();
  });
});

describe("runOpencodeAttempt — model/variant guards (I3, before any spawn or IU config call)", () => {
  test("refuses a model the registry does not list for the opencode harness", async () => {
    for (const [model, message] of [
      ["DeepSeek-V4-Flash", /not usable on the opencode harness/],
      ["not-a-model", /unknown model/],
    ] as const) {
      await expect(
        runOpencodeAttempt(
          { cwd: "/tmp", prompt: "p", route: routeFor("dispatch") },
          { current: 0 },
          { model, backend: "iu" },
        ),
      ).rejects.toThrow(message);
    }
  });

  test("refuses an undeclared variant", async () => {
    await expect(
      runOpencodeAttempt(
        { cwd: "/tmp", prompt: "p", route: routeFor("dispatch") },
        { current: 0 },
        { model: "deepseek-v4.1-flash", backend: "iu", variant: "ultra-mega" },
      ),
    ).rejects.toThrow(/unknown opencode variant "ultra-mega"/);
  });

  test("refuses extraDisallowedTools — no caller passes this for a dispatch route", async () => {
    await expect(
      runOpencodeAttempt(
        { cwd: "/tmp", prompt: "p", extraDisallowedTools: ["Bash"], route: routeFor("dispatch") },
        { current: 0 },
        { model: "deepseek-v4.1-flash", backend: "iu" },
      ),
    ).rejects.toThrow(/extraDisallowedTools is not supported/);
  });
});
