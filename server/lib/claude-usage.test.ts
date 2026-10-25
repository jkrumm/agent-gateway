import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __expireClaudeUsageForTests,
  __resetClaudeUsageForTests,
  __resetLanePicksForTests,
  __settleClaudeUsageForTests,
  accountColumnWidth,
  __resetPostedUsageForTests,
  buildAccountQuotas,
  buildLanePicks,
  LANE_PICKS,
  mergeAccountQuota,
  parseClaudeUsage,
  readClaudeUsage,
  recordPostedUsage,
  renderQuotaHeader,
  type AccountQuota,
} from "./claude-usage.ts";

const CLI_JSON = JSON.stringify({
  default_account: "iu",
  extra: true,
  accounts: [
    {
      id: "iu",
      plan: "max20x",
      enabled: true,
      five_hour: 10,
      seven_day: 88,
      five_hour_resets_at: 1_800_000_000,
      seven_day_resets_at: 1_800_400_000,
      age_s: 100,
      five_hour_age_s: 100,
      seven_day_age_s: 100,
      source: "statusline",
      auth_ok: true,
      exhausted_until: null,
      future_field: 1,
    },
    { id: "me", plan: "max5x", enabled: false, five_hour: null, seven_day: null },
    { id: "BAD ID" },
  ],
});

describe("parseClaudeUsage", () => {
  test("good: ignores unknown fields, drops invalid rows", () => {
    const u = parseClaudeUsage(CLI_JSON, 1000);
    expect(u?.accounts.map((a) => a.id)).toEqual(["iu", "me"]);
    expect(u?.fetchedAt).toBe(1000);
    expect(u?.accounts[0]).not.toHaveProperty("future_field");
  });

  test("garbage → null", () => {
    expect(parseClaudeUsage("not json", 0)).toBeNull();
    expect(parseClaudeUsage('{"accounts": 3}', 0)).toBeNull();
    expect(parseClaudeUsage("[]", 0)).toBeNull();
  });
});

describe("readClaudeUsage (fake CLI)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-usage-"));
    __resetClaudeUsageForTests();
    __resetPostedUsageForTests();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN;
    delete process.env.AGENT_GATEWAY_CLAUDE_USAGE_TIMEOUT_MS;
  });

  function fakeCli(body: string): void {
    const bin = join(dir, "claude-account");
    writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    chmodSync(bin, 0o755);
    process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN = bin;
  }

  test("good output is parsed and memoized", async () => {
    const counter = join(dir, "n");
    fakeCli(`echo x >> ${counter}\ncat <<'EOF'\n${CLI_JSON}\nEOF`);
    expect((await readClaudeUsage())?.accounts).toHaveLength(2);
    await readClaudeUsage();
    expect(await Bun.file(counter).text()).toBe("x\n");
  });

  test("garbage output → null, never throws", async () => {
    fakeCli("echo garbage");
    expect(await readClaudeUsage()).toBeNull();
  });

  test("non-zero exit → null", async () => {
    fakeCli("exit 1");
    expect(await readClaudeUsage()).toBeNull();
  });

  test("timeout → null", async () => {
    process.env.AGENT_GATEWAY_CLAUDE_USAGE_TIMEOUT_MS = "200";
    fakeCli("sleep 5");
    expect(await readClaudeUsage()).toBeNull();
  });

  test("missing binary → null", async () => {
    process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN = join(dir, "nope");
    expect(await readClaudeUsage()).toBeNull();
  });

  test("stale-while-revalidate: serves the last good at once, refreshes in the background", async () => {
    const state = join(dir, "state");
    writeFileSync(state, "10");
    fakeCli(
      `P=$(cat ${state})\necho '{"accounts":[{"id":"iu","five_hour":'$P',"five_hour_age_s":0,"age_s":0}]}'`,
    );
    expect((await readClaudeUsage())?.accounts[0]?.five_hour).toBe(10);

    writeFileSync(state, "20");
    __expireClaudeUsageForTests();
    expect((await readClaudeUsage())?.accounts[0]?.five_hour).toBe(10); // stale, immediate
    await __settleClaudeUsageForTests();
    expect((await readClaudeUsage())?.accounts[0]?.five_hour).toBe(20);

    // a failing refresh keeps serving the last good
    fakeCli("exit 1");
    __expireClaudeUsageForTests();
    await readClaudeUsage();
    await __settleClaudeUsageForTests();
    expect((await readClaudeUsage())?.accounts[0]?.five_hour).toBe(20);
  });

  test("CLI down: POSTed values still produce an account", async () => {
    fakeCli("exit 1");
    recordPostedUsage("me", { five_hour_pct: 4, five_hour_mins_left: 30, seven_day_pct: 9 });
    const q = await buildAccountQuotas();
    expect(q.me?.five_hour_pct).toBe(4);
    expect(q.me?.source).toBe("post");
  });
});

describe("buildLanePicks (fake CLI)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lane-picks-"));
    __resetLanePicksForTests();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN;
    __resetLanePicksForTests();
  });

  function fakeCli(body: string): void {
    const bin = join(dir, "claude-account");
    writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    chmodSync(bin, 0o755);
    process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN = bin;
  }

  test("all 6 lanes come back from one batch; a second call within the memo window spawns nothing more", async () => {
    const counter = join(dir, "n");
    fakeCli(
      `echo x >> ${counter}\necho "export CLAUDE_CONFIG_DIR='/tmp/x'"\necho "# picked=me reason=home stale=false"`,
    );
    const picks = await buildLanePicks();
    expect(Object.keys(picks).toSorted()).toEqual([...LANE_PICKS].toSorted());
    expect(picks.wave).toEqual({ picked: "me", reason: "home", stale: false });
    expect((await Bun.file(counter).text()).trim().split("\n")).toHaveLength(LANE_PICKS.length);

    await buildLanePicks();
    expect((await Bun.file(counter).text()).trim().split("\n")).toHaveLength(LANE_PICKS.length);
  });

  test("failing or missing CLI → {}, never throws", async () => {
    fakeCli("exit 1");
    expect(await buildLanePicks()).toEqual({});

    __resetLanePicksForTests();
    process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN = join(dir, "nope");
    expect(await buildLanePicks()).toEqual({});
  });
});

describe("mergeAccountQuota — POST precedence per window", () => {
  const NOW = 1_800_000_000_000;
  const cli = parseClaudeUsage(CLI_JSON, NOW)!.accounts[0]!; // sample 100 s old
  const post = (ageMs: number, extra: Partial<Parameters<typeof recordPostedUsage>[1]> = {}) => ({
    five_hour_pct: 50,
    five_hour_mins_left: 60,
    seven_day_pct: 91,
    updated_at: NOW - ageMs,
    ...extra,
  });

  test("newer POST wins both windows", () => {
    const q = mergeAccountQuota(cli, NOW, post(10_000), NOW);
    expect(q.five_hour_pct).toBe(50);
    expect(q.seven_day_pct).toBe(91);
    expect(q.five_hour_mins_left).toBe(60);
    expect(q.source).toBe("post");
  });

  test("older POST loses", () => {
    const q = mergeAccountQuota(cli, NOW, post(500_000), NOW);
    expect(q.five_hour_pct).toBe(10);
    expect(q.seven_day_pct).toBe(88);
    expect(q.source).toBe("statusline");
  });

  test("window-wise: newer on 5h only", () => {
    const c = { ...cli, five_hour_age_s: 1000, seven_day_age_s: 5 };
    const q = mergeAccountQuota(c, NOW, post(60_000), NOW);
    expect(q.five_hour_pct).toBe(50);
    expect(q.seven_day_pct).toBe(88);
  });

  test("newer POST with null mins_left keeps the CLI 5h reset", () => {
    const q = mergeAccountQuota(cli, NOW, post(10_000, { five_hour_mins_left: null }), NOW);
    expect(q.five_hour_pct).toBe(50);
    expect(q.five_hour_resets_at).toBe(1_800_000_000);
    expect(q.five_hour_mins_left).toBe(Math.ceil((1_800_000_000 * 1000 - NOW) / 60_000));
  });

  test("POST with null seven_day keeps the CLI value", () => {
    const q = mergeAccountQuota(cli, NOW, post(1000, { seven_day_pct: null }), NOW);
    expect(q.seven_day_pct).toBe(88);
  });

  test("no CLI row: POST only, enabled defaults true", () => {
    const q = mergeAccountQuota(undefined, NOW, post(1000), NOW);
    expect(q.enabled).toBe(true);
    expect(q.plan).toBeNull();
  });
});

describe("renderQuotaHeader", () => {
  const NOW = new Date(2026, 9, 24, 12, 0, 0).getTime();
  const base: AccountQuota = {
    five_hour_pct: 8,
    seven_day_pct: 88,
    five_hour_resets_at: Math.floor(NOW / 1000) + 2 * 3600 + 31 * 60,
    seven_day_resets_at: Math.floor(new Date(2026, 9, 27, 17, 0, 0).getTime() / 1000),
    five_hour_mins_left: 151,
    auth_ok: true,
    exhausted_until: null,
    enabled: true,
    plan: "max20x",
    updated_at: NOW - 60_000,
    source: "statusline",
  };

  test("plain line, disabled accounts skipped", () => {
    const lines = renderQuotaHeader({ iu: base, me: { ...base, enabled: false } }, NOW);
    expect(lines).toEqual(["iu  5h 8% ↺2h31m · 7d 88% ↺Tue 17:00"]);
  });

  test("exhausted / auth! / stale markers", () => {
    const until = Math.floor(new Date(2026, 9, 24, 14, 5, 0).getTime() / 1000);
    const [line] = renderQuotaHeader(
      {
        me: {
          ...base,
          exhausted_until: until,
          auth_ok: false,
          updated_at: NOW - 7 * 3600 * 1000,
        },
      },
      NOW,
    );
    expect(line).toContain("· exhausted until 14:05");
    expect(line).toContain("· auth!");
    expect(line).toEndWith("· stale");
  });

  test("past exhausted_until is not shown; unknown pct is ?", () => {
    const [line] = renderQuotaHeader(
      {
        iu: {
          ...base,
          five_hour_pct: null,
          five_hour_resets_at: null,
          exhausted_until: Math.floor(NOW / 1000) - 10,
        },
      },
      NOW,
    );
    expect(line).not.toContain("exhausted");
    expect(line).toContain("5h ? · 7d");
  });

  test("ids are aligned", () => {
    const lines = renderQuotaHeader({ iu: base, work: base }, NOW);
    expect(lines[0]!.startsWith("iu    5h")).toBe(true);
  });
});

describe("accountColumnWidth", () => {
  const q = (enabled = true) => ({ enabled }) as AccountQuota;
  test("min 2, longest enabled id or row account", () => {
    expect(accountColumnWidth({ a: q() }, [])).toBe(2);
    expect(accountColumnWidth({ work: q(), longname: q(false) }, ["?"])).toBe(4);
    expect(accountColumnWidth({ iu: q() }, ["research"])).toBe(8);
  });
});
