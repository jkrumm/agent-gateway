// `job_status`/`job_wait`/`job_cancel` share one view → state mapping (server/mcp/tools/jobs.ts
// `toState`). Pins the lease-queue field: `queuedBehind` is surfaced only for a pending job that
// is queued behind a repo's running implement episode, and omitted otherwise.

import { describe, expect, test } from "bun:test";
import type { JobView } from "../server/jobs/types.ts";
import { toState } from "../server/mcp/tools/jobs.ts";

const view = (over: Partial<JobView>): JobView => ({
  id: "job-1",
  tool: "dispatch",
  status: "pending",
  result: null,
  error: null,
  progress: null,
  createdAt: 0,
  startedAt: null,
  finishedAt: null,
  elapsedMs: 5,
  idleMs: null,
  ...over,
});

describe("toState queuedBehind mapping", () => {
  test("a lease-queued pending job carries the holder's id and is still running-ish", () => {
    const state = toState(view({ queuedBehind: "holder-9" }));
    expect(state.queuedBehind).toBe("holder-9");
    expect(state.status).toBe("pending");
    expect(state.stillRunning).toBe(true);
  });

  test("absent (key omitted, not undefined) when the job is not lease-queued", () => {
    expect("queuedBehind" in toState(view({}))).toBe(false);
    expect("queuedBehind" in toState(view({ status: "running" }))).toBe(false);
  });

  test("progress and terminal state map through", () => {
    const state = toState(
      view({
        status: "done",
        result: { ok: 1 },
        progress: { turns: 4, lastAction: "Edit a.ts", lastActivityAt: 1 },
      }),
    );
    expect(state).toMatchObject({
      jobId: "job-1",
      stillRunning: false,
      turns: 4,
      result: { ok: 1 },
    });
  });
});
