// A Max-only route (no IU fallback) must never take the iu transport when the account picker
// reports no headroom (exit 3 / spill) — owner rule 2026-10-24: no code written on IU tokens.

import { afterEach, describe, expect, test } from "bun:test";
import { resolveAttemptAccount } from "../server/mcp/session-runner.ts";
import {
  __setAccountPickerForTests,
  __setDefaultAccountForTests,
} from "../server/mcp/worker-shared.ts";

afterEach(() => {
  __setAccountPickerForTests();
  __setDefaultAccountForTests();
});

describe("resolveAttemptAccount without an IU fallback", () => {
  test("a spill pick runs on the default Max account, never iu", async () => {
    __setAccountPickerForTests(async () => ({ pick: { kind: "iu" } }));
    __setDefaultAccountForTests(async () => "a");
    const chosen = await resolveAttemptAccount({
      tool: "dispatch",
      hasIuFallback: false,
    });
    expect(chosen).toEqual({ kind: "spawn", claudeConfigDir: null, account: "a" });
  });

  test("a spill pick after the default account hit its wall fails closed (walled), never iu", async () => {
    __setAccountPickerForTests(async () => ({ pick: { kind: "iu" } }));
    __setDefaultAccountForTests(async () => "a");
    const chosen = await resolveAttemptAccount({
      tool: "dispatch",
      hasIuFallback: false,
      excludeAccount: "a",
    });
    expect(chosen).toEqual({ kind: "walled", account: "a" });
  });

  test("a failed picker with a walled account and no iu fallback runs inherited, not iu", async () => {
    __setAccountPickerForTests(async () => ({ pick: { kind: "unavailable" } }));
    const chosen = await resolveAttemptAccount({
      tool: "dispatch",
      hasIuFallback: false,
      excludeAccount: "a",
    });
    expect(chosen.kind).toBe("spawn");
  });
});
