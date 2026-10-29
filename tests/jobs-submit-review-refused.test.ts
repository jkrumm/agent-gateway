// POST /api/jobs: `review` moved to agent-workflows (owner direction 2026-10-29) — every submit is a
// typed 400 before a job row exists; other tools are unaffected.

import { afterAll, describe, expect, test } from "bun:test";
import { __resetForTests, listJobs } from "../server/jobs/store.ts";
import { jobsRoutes, REVIEW_MOVED_REFUSAL } from "../server/routes/jobs.ts";
import * as sessionRunner from "../server/mcp/session-runner.ts";
import { spyOn } from "bun:test";

// No executor registered (and a clean queue): accepted jobs stay `pending` instead of running.
__resetForTests();
afterAll(() => __resetForTests());

async function post(body: unknown) {
  const res = await jobsRoutes.handle(
    new Request("http://localhost/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string } };
}

describe("review submit refusal", () => {
  test("the message names agw review", () => {
    expect(REVIEW_MOVED_REFUSAL).toBe(
      "review moved to agent-workflows: run `agw review --cwd <repo> --pr N` (or --scope/--branch); agent-gateway no longer reviews",
    );
  });

  test.each([
    ["a pr review", { cwd: "/tmp", pr: 1 }],
    ["a scope review", { cwd: "/tmp", scope: "HEAD~1" }],
    ["a missing directory", { cwd: "/nonexistent/path" }],
    ["an unknown model", { cwd: "/tmp", model: "no-such-model" }],
    ["no params", undefined],
  ])("%s is a typed 400, creates no job and opens no session", async (_name, params) => {
    const runSession = spyOn(sessionRunner, "runSession");
    const before = listJobs().length;
    const { status, body } = await post({ tool: "review", params, caller: "iris" });
    expect(status).toBe(400);
    expect(body).toEqual({ ok: false, error: REVIEW_MOVED_REFUSAL });
    expect(listJobs().length).toBe(before);
    expect(runSession).not.toHaveBeenCalled();
    runSession.mockRestore();
  });

  test("other tools are unaffected", async () => {
    const before = listJobs().length;
    const { status, body } = await post({
      tool: "triage",
      params: { prompt: "p", schema: { type: "object" } },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(listJobs().length).toBe(before + 1);
  });
});
