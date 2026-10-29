// POST /api/jobs: a `cwd` that does not exist is refused with a 400 before a job row exists, so
// a caller's deleted worktree never counts as a job failure in `failedLastHour`.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetForTests, listJobs } from "../server/jobs/store.ts";
import { jobsRoutes } from "../server/routes/jobs.ts";

// No executor registered: accepted jobs stay `pending` instead of running.
__resetForTests();
const dir = mkdtempSync(join(tmpdir(), "agw-missing-cwd-"));
afterAll(() => {
  __resetForTests();
  rmSync(dir, { recursive: true, force: true });
});

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

describe("missing cwd refusal", () => {
  test("an overview of a deleted directory is a 400 and creates nothing", async () => {
    const missing = join(dir, "deleted-worktree");
    const before = listJobs().length;
    const { status, body } = await post({ tool: "overview", params: { cwd: missing } });
    expect(status).toBe(400);
    expect(body.error).toBe(`overview refused: directory not found: ${missing}`);
    expect(listJobs().length).toBe(before);
  });

  test("a regular file is not a directory and is refused too", async () => {
    const file = join(dir, "not-a-dir.txt");
    writeFileSync(file, "x");
    const { status, body } = await post({ tool: "check", params: { cwd: file } });
    expect(status).toBe(400);
    expect(body.error).toBe(`check refused: directory not found: ${file}`);
  });

  test("an existing directory is accepted", async () => {
    const { status, body } = await post({ tool: "check", params: { cwd: dir } });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });
});
