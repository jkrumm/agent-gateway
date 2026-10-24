import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetSessionAccountCacheForTests,
  mergeAgents,
  parseSessionAccounts,
  resolveSessionAccounts,
} from "./agents.ts";

const line = (session: string, account?: string, event = "session_env") =>
  JSON.stringify({ ts: "t", event, data: { session, ...(account ? { account } : {}) } });

describe("session → account join", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-logs-"));
    process.env.AGENT_GATEWAY_CLAUDE_LOG_DIR = dir;
    __resetSessionAccountCacheForTests();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENT_GATEWAY_CLAUDE_LOG_DIR;
  });

  test("parse: newest line wins, lines without account and other events are skipped", () => {
    const m = parseSessionAccounts(
      [
        line("a", "iu"),
        line("a", "me"),
        line("b"),
        line("c", "iu", "other"),
        "garbage",
        '{"event":"session_env"',
      ].join("\n"),
    );
    expect([...m]).toEqual([["a", "me"]]);
  });

  test("resolves across day files, caches hits, retries misses after the window", () => {
    writeFileSync(join(dir, "2026-10-23.jsonl"), `${line("old", "me")}\n`);
    writeFileSync(join(dir, "2026-10-24.jsonl"), `${line("new", "iu")}\n`);
    const r = resolveSessionAccounts(["old", "new", "ghost"], 1_000);
    expect(r.get("old")).toBe("me");
    expect(r.get("new")).toBe("iu");
    expect(r.has("ghost")).toBe(false);

    // the line appears later: not re-read inside the miss window, found after it
    writeFileSync(join(dir, "2026-10-24.jsonl"), `${line("ghost", "me")}\n`);
    expect(resolveSessionAccounts(["ghost"], 2_000).has("ghost")).toBe(false);
    expect(resolveSessionAccounts(["ghost"], 70_000).get("ghost")).toBe("me");

    // hits survive log removal (cache never changes for a session)
    rmSync(dir, { recursive: true, force: true });
    expect(resolveSessionAccounts(["old"], 80_000).get("old")).toBe("me");
  });

  test("missing log dir → unknown, no throw", () => {
    process.env.AGENT_GATEWAY_CLAUDE_LOG_DIR = join(dir, "nope");
    expect(resolveSessionAccounts(["x"]).size).toBe(0);
  });

  test("mergeAgents sets account per agent, null when unknown", () => {
    const projects = mergeAgents({
      herdrAgents: [
        {
          pane_id: "w:p1",
          workspace_id: "w",
          cwd: "/tmp/p",
          agent_status: "idle",
          agent_session: { value: "s1" },
        } as never,
      ],
      herdrWorkspaces: [],
      claudeAgents: [{ cwd: "/tmp/q", sessionId: "s2", startedAt: 1, status: "idle" }],
      dispatchJobs: [
        {
          id: "j1",
          status: "running",
          cwd: "/tmp/r",
          tier: "implement",
          createdAt: 1,
          startedAt: 1,
          finishedAt: null,
          account: "me",
        },
      ],
      transcripts: new Map(),
      accounts: new Map([["s1", "iu"]]),
      now: 10,
      staleAfterMs: 1000,
    });
    const byId = Object.fromEntries(
      projects.flatMap((p) => p.agents).map((a) => [a.id, a.account]),
    );
    expect(byId).toEqual({ s1: "iu", s2: null, j1: "me" });
  });
});
