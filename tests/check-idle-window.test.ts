// The check handler's session-level idle window. During a single Bash step `claude -p`
// emits no stdout — the worker buffers the command's output (`run_step`) and cats it only
// once the step ends — so the session watchdog must outlast the worker's own per-step idle
// windows. Without this the fixed 5-minute session budget killed a check run before its
// 600s test-step window could ever apply.

import { describe, expect, test } from "bun:test";
import { checkSessionIdleTimeoutMs } from "../server/jobs/handlers/check.ts";
import { IDLE_TIMEOUT_MS } from "../server/lib/idle-timeout.ts";

describe("checkSessionIdleTimeoutMs", () => {
  test("outlasts the largest per-step idle window (the test step's default 600s)", () => {
    expect(checkSessionIdleTimeoutMs(180, 600)).toBe((600 + 120) * 1000);
  });

  test("a caller stepTimeoutSeconds override raises both windows, so the session window follows", () => {
    expect(checkSessionIdleTimeoutMs(900, 900)).toBe((900 + 120) * 1000);
  });

  test("never drops below the shared session default, even for a tiny step override", () => {
    expect(checkSessionIdleTimeoutMs(1, 1)).toBe(IDLE_TIMEOUT_MS);
  });
});
