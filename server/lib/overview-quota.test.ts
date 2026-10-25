import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderText, stripAnsi, type Agent, type AgentsSnapshot } from "./agents.ts";
import {
  __resetClaudeUsageForTests,
  __resetLanePicksForTests,
  LANE_PICKS,
  type AccountQuota,
} from "./claude-usage.ts";
import { buildOverviewPayload } from "./overview-payload.ts";

const NOW = new Date(2026, 9, 24, 12, 0, 0).getTime();

const quota = (over: Partial<AccountQuota> = {}): AccountQuota => ({
  five_hour_pct: 8,
  seven_day_pct: 88,
  five_hour_resets_at: Math.floor(NOW / 1000) + 3600,
  seven_day_resets_at: Math.floor(new Date(2026, 9, 27, 17, 0, 0).getTime() / 1000),
  five_hour_mins_left: 60,
  auth_ok: true,
  exhausted_until: null,
  enabled: true,
  plan: "max20x",
  updated_at: NOW - 1000,
  source: "statusline",
  ...over,
});

const agent = (id: string, account: string | null): Agent => ({
  id,
  source: "claude",
  sessionId: id,
  paneId: null,
  workspaceId: null,
  title: `task ${id}`,
  state: "working",
  herdrStatus: null,
  claudeStatus: "busy",
  waitingFor: null,
  tier: null,
  lastPrompt: null,
  lastReply: null,
  lastActivityAt: NOW - 60_000,
  account,
  startedAt: null,
});

const snapshot = (agents: Agent[]): AgentsSnapshot => ({
  generatedAt: NOW,
  staleAfterHours: 24,
  summary: { needsYou: 0, working: agents.length, idle: 0, stale: 0, done: 0, dispatch: 0 },
  projects: [{ name: "p", cwd: "/x/p", git: null, agents }],
  humanQueue: [],
  warnings: [],
});

describe("renderText with quota", () => {
  test("quota header on top, account column per row, ? when unknown", () => {
    const text = renderText(snapshot([agent("a", "me"), agent("b", null)]), {
      quota: { iu: quota(), me: quota({ enabled: false }) },
      cols: 110,
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("iu  5h 8% ↺1h00m · 7d 88% ↺Tue 17:00");
    expect(lines[1]).toStartWith("agents:");
    expect(text).toContain("  ● working   me task a");
    expect(text).toContain("  ● working   ?  task b");
    expect(text).not.toContain("\nme  5h"); // disabled account has no header line
  });

  test("column width follows the longest id in header and rows", () => {
    const text = renderText(snapshot([agent("a", "research")]), {
      quota: { iu: quota() },
      cols: 110,
    });
    expect(text.split("\n")[0]).toStartWith("iu        5h"); // padded to 8 + 2 spaces
    expect(text).toContain("  ● working   research task a");
  });

  test("without quota the output has no header and no account column", () => {
    const text = renderText(snapshot([agent("a", "me")]));
    expect(text.split("\n")[0]).toStartWith("agents:");
    expect(text).toContain("  ● working   task a");
  });

  test("colour render strips to the plain render", () => {
    const opts = { quota: { iu: quota() }, cols: 110 };
    const snap = snapshot([agent("a", "iu")]);
    expect(stripAnsi(renderText(snap, { ...opts, color: true }))).toContain(
      renderText(snap, opts).split("\n")[0]!,
    );
  });
});

describe("buildOverviewPayload", () => {
  let dir: string;
  let bin: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "overview-quota-"));
    bin = join(dir, "claude-account");
    writeFileSync(
      bin,
      `#!/bin/sh
case "$1" in
  pick) echo "export CLAUDE_CONFIG_DIR='/tmp/x'"; echo "# picked=me reason=home stale=false" ;;
  usage) echo '{"accounts":[{"id":"iu","enabled":true,"five_hour":5,"seven_day":6,"age_s":1},{"id":"me","enabled":false}]}' ;;
esac
`,
    );
    chmodSync(bin, 0o755);
    process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN = bin;
    __resetClaudeUsageForTests();
    __resetLanePicksForTests();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN;
    __resetClaudeUsageForTests();
    __resetLanePicksForTests();
  });

  test("payload carries quota.accounts (disabled included), same object as /api/usage", async () => {
    const { payload, quota: q } = await buildOverviewPayload();
    expect(payload.quota.accounts).toBe(q);
    expect(payload.quota.accounts.iu).toMatchObject({ five_hour_pct: 5, seven_day_pct: 6 });
    expect(payload.quota.accounts.me?.enabled).toBe(false);
  });

  test("payload carries quota.picks for all 6 lanes, same object as buildLanePicks", async () => {
    const { payload, picks } = await buildOverviewPayload();
    expect(payload.quota.picks).toBe(picks);
    expect(Object.keys(payload.quota.picks).toSorted()).toEqual([...LANE_PICKS].toSorted());
    expect(payload.quota.picks.wave).toEqual({ picked: "me", reason: "home", stale: false });
  });

  test("a claude-account that doesn't understand 'pick' yields picks: {}, never throws", async () => {
    writeFileSync(bin, `#!/bin/sh\necho '{"accounts":[]}'\n`);
    chmodSync(bin, 0o755);
    __resetLanePicksForTests();
    const { payload } = await buildOverviewPayload();
    expect(payload.quota.picks).toEqual({});
  });
});
