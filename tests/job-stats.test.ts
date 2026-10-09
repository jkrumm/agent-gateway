// job_stats: the slim history written on every terminal transition and kept 90 days, long after
// the full `jobs` row is pruned (24h / 200 rows). Runs against the temp DB from tests/setup.ts.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetForTests,
  cancelJob,
  createJob,
  initJobStore,
  jobStatsSummary,
} from "../server/jobs/store.ts";

afterEach(() => {
  __resetForTests();
});

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function withDb<T>(fn: (db: Database) => T): T {
  const p = process.env.AGENT_GATEWAY_JOBS_DB;
  if (!p) throw new Error("AGENT_GATEWAY_JOBS_DB not set — tests/setup.ts should have set it");
  const db = new Database(p);
  db.run("PRAGMA busy_timeout = 5000");
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

interface StatsRow {
  id: string;
  tool: string;
  status: string;
  attempts: number;
  backend: string | null;
  model: string | null;
  error_head: string | null;
  repo: string | null;
  finished_at: number | null;
}

function statsRow(id: string): StatsRow | null {
  return withDb((db) =>
    db.query<StatsRow, [string]>("SELECT * FROM job_stats WHERE id = ?").get(id),
  );
}

describe("job_stats recording", () => {
  test("a done job records backend/model from the result and the cwd basename, no blobs", async () => {
    initJobStore({
      executor: async () => ({ backend: "iu", model: "some-model", secret: "x".repeat(50) }),
    });
    const created = createJob("check", { cwd: "/a/b/my-repo", prompt: "do not store" });
    await flush();

    const row = statsRow(created.id);
    expect(row).toMatchObject({
      tool: "check",
      status: "done",
      attempts: 1,
      backend: "iu",
      model: "some-model",
      error_head: null,
      repo: "my-repo",
    });
    expect(row?.finished_at).not.toBeNull();
    expect(
      withDb((db) =>
        db
          .query("PRAGMA table_info(job_stats)")
          .all()
          .map((c) => (c as { name: string }).name),
      ),
    ).not.toContain("params");
  });

  test("a failed job records the first 300 chars of the error; backend/model/repo are null", async () => {
    initJobStore({
      executor: async () => {
        throw new Error("x".repeat(500));
      },
    });
    const created = createJob("review", {});
    await flush();

    const row = statsRow(created.id);
    expect(row?.status).toBe("failed");
    expect(row?.error_head).toHaveLength(300);
    expect(row?.backend).toBeNull();
    expect(row?.model).toBeNull();
    expect(row?.repo).toBeNull();
  });

  test("a pending job cancelled via cancelJob is recorded as cancelled", () => {
    // No executor wired → the job stays pending.
    const created = createJob("check", { cwd: "/r/repo-x" });
    expect(cancelJob(created.id).ok).toBe(true);

    expect(statsRow(created.id)).toMatchObject({
      status: "cancelled",
      repo: "repo-x",
      error_head: "cancelled by request",
    });
  });

  test("boot recovery landing a running row interrupted records it", () => {
    const created = createJob("excalidraw_diagram", {});
    withDb((db) =>
      db.run("UPDATE jobs SET status = 'running', started_at = ?, attempts = 1 WHERE id = ?", [
        Date.now(),
        created.id,
      ]),
    );
    initJobStore({ executor: () => new Promise<unknown>(() => {}) });

    expect(statsRow(created.id)).toMatchObject({ status: "interrupted", attempts: 1 });
  });
});

describe("prune()", () => {
  test("drops job_stats rows older than 90 days, keeps recent ones, and leaves jobs retention alone", async () => {
    const old = Date.now() - 91 * 24 * 60 * 60 * 1000;
    withDb((db) => {
      db.run(
        "INSERT INTO job_stats (id, tool, status, created_at, finished_at) VALUES ('old', 'check', 'done', ?, ?)",
        [old, old],
      );
      db.run(
        "INSERT INTO job_stats (id, tool, status, created_at, finished_at) VALUES ('recent', 'check', 'done', ?, ?)",
        [Date.now(), Date.now()],
      );
    });
    initJobStore({ executor: async () => ({}) }); // boot prune
    const created = createJob("check", {});
    await flush();

    expect(statsRow("old")).toBeNull();
    expect(statsRow("recent")).not.toBeNull();
    // The 24h jobs row for the fresh job is untouched.
    expect(statsRow(created.id)?.status).toBe("done");
  });
});

describe("jobStatsSummary", () => {
  function seed(
    id: string,
    tool: string,
    status: string,
    finishedAt: number,
    errorHead: string | null = null,
  ): void {
    withDb((db) =>
      db.run(
        "INSERT INTO job_stats (id, tool, status, created_at, finished_at, error_head) VALUES (?, ?, ?, ?, ?, ?)",
        [id, tool, status, finishedAt - 1000, finishedAt, errorHead],
      ),
    );
  }

  test("counts per tool/status inside the window and groups failed errors by head", () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    seed("a", "check", "done", now - 1000);
    seed("b", "check", "done", now - 2000);
    seed("c", "check", "failed", now - 3000, "Session exited with code 1");
    seed("d", "review", "failed", now - 4000, "Session exited with code 1");
    seed("e", "check", "failed", now - 5000, "Session exited with code 1");
    seed("f", "check", "failed", now - 6000, "timeout");
    seed("g", "check", "done", now - 10 * day); // outside the 7 day window
    seed("h", "check", "interrupted", now - 7000, "restarted"); // not a failed group

    const summary = jobStatsSummary(7, now);

    expect(summary.days).toBe(7);
    expect(summary.byToolStatus).toEqual([
      { tool: "check", status: "done", count: 2 },
      { tool: "check", status: "failed", count: 3 },
      { tool: "check", status: "interrupted", count: 1 },
      { tool: "review", status: "failed", count: 1 },
    ]);
    expect(summary.topErrors).toEqual([
      { tool: "check", errorHead: "Session exited with code 1", count: 2 },
      { tool: "check", errorHead: "timeout", count: 1 },
      { tool: "review", errorHead: "Session exited with code 1", count: 1 },
    ]);
  });

  test("empty store yields empty aggregates", () => {
    expect(jobStatsSummary()).toEqual({ days: 7, byToolStatus: [], topErrors: [] });
  });
});
