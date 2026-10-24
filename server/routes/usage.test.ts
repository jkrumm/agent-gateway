import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __resetClaudeUsageForTests, __resetPostedUsageForTests } from "../lib/claude-usage.ts";
import { usageRoutes } from "./usage.ts";

const post = (body: unknown) =>
  usageRoutes.handle(
    new Request("http://localhost/api/usage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
const get = async () =>
  (await usageRoutes.handle(new Request("http://localhost/api/usage")).then((r) => r.json())) as {
    ok: boolean;
    data: Record<string, unknown> | null;
    accounts: Record<string, Record<string, unknown>>;
  };

describe("/api/usage", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-route-"));
    const nowS = Math.floor(Date.now() / 1000);
    const bin = join(dir, "claude-account");
    writeFileSync(
      bin,
      `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify({
        accounts: [
          {
            id: "iu",
            plan: "max20x",
            enabled: true,
            five_hour: 10,
            seven_day: 88,
            five_hour_resets_at: nowS + 3600,
            seven_day_resets_at: nowS + 86400,
            age_s: 3600,
            five_hour_age_s: 3600,
            seven_day_age_s: 3600,
            source: "statusline",
            auth_ok: true,
            exhausted_until: null,
          },
          { id: "me", plan: "max5x", enabled: false, five_hour: 1, seven_day: 2, age_s: 60 },
        ],
      })}\nEOF\n`,
    );
    chmodSync(bin, 0o755);
    process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN = bin;
    __resetClaudeUsageForTests();
    __resetPostedUsageForTests();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN;
  });

  test("no POST: data null, accounts from the CLI incl. disabled", async () => {
    const r = await get();
    expect(r.data).toBeNull();
    expect(r.accounts.iu?.five_hour_pct).toBe(10);
    expect(r.accounts.iu?.plan).toBe("max20x");
    expect(r.accounts.me?.enabled).toBe(false);
  });

  test("POST without account → iu; data equals the iu POST; newer POST overrides CLI", async () => {
    expect(
      (await post({ five_hour_pct: 42, five_hour_mins_left: 30, seven_day_pct: 90 })).status,
    ).toBe(200);
    const r = await get();
    expect(r.data).toMatchObject({ five_hour_pct: 42, five_hour_mins_left: 30, seven_day_pct: 90 });
    expect(r.accounts.iu).toMatchObject({ five_hour_pct: 42, seven_day_pct: 90, source: "post" });
  });

  test("a `me` POST never touches data (the iu entry)", async () => {
    await post({ five_hour_pct: 42, five_hour_mins_left: 30, seven_day_pct: 90 });
    await post({ account: "me", five_hour_pct: 5, five_hour_mins_left: 10, seven_day_pct: 6 });
    const r = await get();
    expect(r.data?.five_hour_pct).toBe(42);
    expect(r.accounts.me?.five_hour_pct).toBe(5);
    expect(r.accounts.iu?.five_hour_pct).toBe(42);
  });

  test("invalid account id is rejected", async () => {
    const res = await post({
      account: "Bad Id",
      five_hour_pct: 1,
      five_hour_mins_left: null,
      seven_day_pct: null,
    });
    expect(res.status).toBe(422);
  });
});
