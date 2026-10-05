// POST /api/jobs for `update_pr`: the repo policy is enforced at submit (an implement-tier
// check), so a cwd outside every configured dispatch root is a 400 that creates no job row.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { __resetForTests, listJobs } from "../server/jobs/store.ts";
import { jobsRoutes } from "../server/routes/jobs.ts";

// No executor registered (and a clean queue): accepted jobs stay `pending` instead of running.
__resetForTests();
afterAll(() => __resetForTests());

const root = (process.env.SIDECLAW_DISPATCH_ROOTS ?? "").split(",")[0]?.trim() ?? "";

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

describe("update_pr submit policy", () => {
  const repo = join(root, "update-pr-submit-repo");

  beforeAll(() => {
    expect(root).not.toBe("");
    mkdirSync(repo, { recursive: true });
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("a cwd outside every configured root is a 400 and creates nothing", async () => {
    const before = listJobs().length;
    const { status, body } = await post({ tool: "update_pr", params: { cwd: "/etc", pr: 1 } });
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/^update_pr refused: /);
    expect(listJobs().length).toBe(before);
  });

  test("a repo under a configured root is accepted", async () => {
    const { status, body } = await post({ tool: "update_pr", params: { cwd: repo, pr: 1 } });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });
});
