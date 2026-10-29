// Zero-downtime reload, store half (server/jobs/store.ts): a job whose OpenCode session a drain
// detached is left `running` with a durable marker, and the next boot's recover() requeues it
// WITHOUT spending the requeue-once budget — for review (ledger re-attach), a worktree dispatch
// (recorded session) and an in-place dispatch (recorded session + persisted snapshot). A genuine
// crash (no marker) keeps today's rules. Also the drain-blocker count and the pending-age clock.
// Rows are seeded through a second sqlite connection, same as tests/jobs-recover-dispatch.test.ts.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetForTests,
  createJob,
  dispatchRecoveryDecision,
  drainBlockerCount,
  getJob,
  initJobStore,
  jobHealth,
  markJobsDetached,
  protectedWorktreePaths,
  queueStats,
  setDraining,
} from "../server/jobs/store.ts";
import * as opencodeServer from "../server/mcp/opencode-server.ts";
import {
  __registerProcForTests,
  __resetActiveProcsForTests,
  detachRemoteSessions,
  getSessionLedger,
  SessionDetachedError,
  trackExternalSession,
} from "../server/mcp/session-runner.ts";

afterEach(() => {
  __resetActiveProcsForTests();
  __resetForTests();
});

const NEVER_EXECUTE = () => new Promise<unknown>(() => {});

function dbPath(): string {
  const p = process.env.AGENT_GATEWAY_JOBS_DB;
  if (!p) throw new Error("AGENT_GATEWAY_JOBS_DB not set — tests/setup.ts should have set it");
  return p;
}

interface Seed {
  attempts?: number;
  sessionId?: string | null;
  worktreeMeta?: object | null;
  detachedAt?: number | null;
  createdAt?: number;
}

/** Make a created job look like a `running` row a dead process left behind. */
function seedRunning(id: string, opts: Seed = {}): void {
  const seed = new Database(dbPath());
  seed.run("PRAGMA busy_timeout = 5000");
  seed.run(
    `UPDATE jobs SET status = 'running', started_at = ?, attempts = ?, session_id = ?,
       worktree_meta = ?, detached_at = ?, created_at = COALESCE(?, created_at) WHERE id = ?`,
    [
      Date.now(),
      opts.attempts ?? 1,
      opts.sessionId ?? null,
      opts.worktreeMeta ? JSON.stringify(opts.worktreeMeta) : null,
      opts.detachedAt ?? null,
      opts.createdAt ?? null,
      id,
    ],
  );
  seed.close();
}

function column<T>(id: string, name: string): T {
  const read = new Database(dbPath(), { readonly: true });
  const row = read
    .query<Record<string, T>, [string]>(`SELECT ${name} FROM jobs WHERE id = ?`)
    .get(id);
  read.close();
  return row?.[name] as T;
}

const worktree = (path: string) => ({
  path,
  branch: "b",
  base: "a",
  baseRef: "HEAD",
  pushable: false,
});

const SNAPSHOT = { headOid: "abc", branch: "master", stashOid: "", untracked: ["notes.txt"] };

describe("execute() — a detached job", () => {
  test("SessionDetachedError leaves the row running with the marker, never failed", async () => {
    initJobStore({
      executor: async () => {
        throw new SessionDetachedError("any");
      },
    });
    const view = createJob("review", {});
    await Bun.sleep(20);

    expect(getJob(view.id)?.status).toBe("running");
    expect(getJob(view.id)?.error).toBeNull();
    expect(column<number | null>(view.id, "detached_at")).not.toBeNull();
    expect(jobHealth().failedLastHour).toBe(0);
  });

  test("markJobsDetached marks only running rows, once", () => {
    const pending = createJob("review", {});
    markJobsDetached([pending.id]);
    expect(column<number | null>(pending.id, "detached_at")).toBeNull();

    const running = createJob("review", {});
    seedRunning(running.id);
    markJobsDetached([running.id]);
    const first = column<number>(running.id, "detached_at");
    markJobsDetached([running.id]);
    expect(column<number>(running.id, "detached_at")).toBe(first);
  });
});

describe("recover() — a drain-detached row spends no requeue budget", () => {
  test("review: attempts already at the cap, still requeued; the attempt is given back and the marker cleared", () => {
    const job = createJob("review", {});
    seedRunning(job.id, { attempts: 2, detachedAt: Date.now() - 5_000 });
    getSessionLedger()?.put(job.id, "angle:qa:1.1", "ses_qa");

    initJobStore({ executor: NEVER_EXECUTE });

    // Requeued, then promoted by initJobStore against the never-resolving executor (+1 attempt).
    expect(["pending", "running"]).toContain(getJob(job.id)?.status ?? "");
    expect(column<number>(job.id, "attempts")).toBe(2); // 2 → 1 given back → 2 on promotion
    expect(column<number | null>(job.id, "detached_at")).toBeNull();
    expect(column<number | null>(job.id, "requeued_at")).not.toBeNull();
    expect(getSessionLedger()?.get(job.id, "angle:qa:1.1")?.sessionId).toBe("ses_qa");
  });

  test("a genuine crash (no marker) at the cap is still interrupted, and its ledger sessions are released", () => {
    const job = createJob("review", {});
    seedRunning(job.id, { attempts: 2 });
    getSessionLedger()?.put(job.id, "angle:qa:1.1", "ses_qa");

    initJobStore({ executor: NEVER_EXECUTE });

    expect(getJob(job.id)?.status).toBe("interrupted");
    expect(getSessionLedger()?.get(job.id, "angle:qa:1.1")).toBeUndefined();
  });

  test("a genuine crash on the first attempt is requeued once, as before", () => {
    const job = createJob("check", {});
    seedRunning(job.id, { attempts: 1 });
    initJobStore({ executor: NEVER_EXECUTE });
    expect(["pending", "running"]).toContain(getJob(job.id)?.status ?? "");
    expect(column<number>(job.id, "attempts")).toBe(2); // not given back: 1 → 2 on promotion
  });

  test("dispatch with a recorded session and its worktree: resumed past the cap", () => {
    const tmp = mkdtempSync(join(tmpdir(), "agw-detach-wt-"));
    try {
      const job = createJob("dispatch", {});
      seedRunning(job.id, {
        attempts: 3,
        sessionId: "ses_wt",
        worktreeMeta: { path: tmp, branch: "b", base: "a", baseRef: "HEAD", pushable: false },
        detachedAt: Date.now(),
      });
      initJobStore({ executor: NEVER_EXECUTE });
      expect(["pending", "running"]).toContain(getJob(job.id)?.status ?? "");
      expect(column<string>(job.id, "session_id")).toBe("ses_wt");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("in-place dispatch: detached + persisted snapshot → resumed; the snapshot stays on the row", () => {
    const tmp = mkdtempSync(join(tmpdir(), "agw-detach-ip-"));
    try {
      const job = createJob("dispatch", {});
      const meta = { path: tmp, workspace: "in-place", snapshot: SNAPSHOT };
      seedRunning(job.id, {
        attempts: 1,
        sessionId: "ses_ip",
        worktreeMeta: meta,
        detachedAt: Date.now(),
      });
      initJobStore({ executor: NEVER_EXECUTE });
      expect(["pending", "running"]).toContain(getJob(job.id)?.status ?? "");
      expect(JSON.parse(column<string>(job.id, "worktree_meta"))).toEqual(meta);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("in-place dispatch: detached but no persisted snapshot → interrupted (nothing to attribute against)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "agw-detach-ip-"));
    try {
      const job = createJob("dispatch", {});
      seedRunning(job.id, {
        sessionId: "ses_ip",
        worktreeMeta: { path: tmp, workspace: "in-place" },
        detachedAt: Date.now(),
      });
      initJobStore({ executor: NEVER_EXECUTE });
      expect(getJob(job.id)?.status).toBe("interrupted");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("in-place dispatch: a crash (no detach marker) is interrupted even with a snapshot", () => {
    const tmp = mkdtempSync(join(tmpdir(), "agw-detach-ip-"));
    try {
      const job = createJob("dispatch", {});
      seedRunning(job.id, {
        sessionId: "ses_ip",
        worktreeMeta: { path: tmp, workspace: "in-place", snapshot: SNAPSHOT },
      });
      initJobStore({ executor: NEVER_EXECUTE });
      expect(getJob(job.id)?.status).toBe("interrupted");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a cancel requested before the restart still wins over the detach marker", () => {
    const job = createJob("review", {});
    seedRunning(job.id, { detachedAt: Date.now() });
    const seed = new Database(dbPath());
    seed.run("UPDATE jobs SET cancel_requested_at = ? WHERE id = ?", [Date.now(), job.id]);
    seed.close();
    initJobStore({ executor: NEVER_EXECUTE });
    expect(getJob(job.id)?.status).toBe("cancelled");
  });

  test("a detached review's worktree is protected from the boot sweep; a crashed one's is not", () => {
    const detached = createJob("review", {});
    seedRunning(detached.id, {
      detachedAt: Date.now(),
      worktreeMeta: {
        path: "/wt/detached",
        branch: "b",
        base: "a",
        baseRef: "HEAD",
        pushable: false,
      },
    });
    const crashed = createJob("review", {});
    seedRunning(crashed.id, {
      worktreeMeta: {
        path: "/wt/crashed",
        branch: "b",
        base: "a",
        baseRef: "HEAD",
        pushable: false,
      },
    });
    expect(protectedWorktreePaths()).toEqual(["/wt/detached"]);
  });
});

describe("drain blockers", () => {
  const untilRunning = async (ids: string[]) => {
    const deadline = Date.now() + 2_000;
    while (ids.some((id) => getJob(id)?.status !== "running") && Date.now() < deadline) {
      await Bun.sleep(2);
    }
  };
  const liveProc = { exitCode: null, kill() {}, pid: 1 } as never;

  test("OC-only is exempt; claude-only blocks; OC MIXED with a live claude proc of the same job blocks", async () => {
    initJobStore({ executor: NEVER_EXECUTE });
    const ocOnly = createJob("review", {});
    const claudeOnly = createJob("check", {});
    const mixed = createJob("overview", {});
    await untilRunning([ocOnly.id, claudeOnly.id, mixed.id]);

    trackExternalSession(ocOnly.id, () => {}, true);
    __registerProcForTests(liveProc, claudeOnly.id);
    trackExternalSession(mixed.id, () => {}, true);
    __registerProcForTests(liveProc, mixed.id);

    expect(queueStats().running).toBe(3);
    expect(drainBlockerCount()).toBe(2); // claude-only and mixed
    expect(queueStats().drainBlockers).toBe(2);
    expect(jobHealth().drainBlockers).toBe(2);
  });

  test("a job between sessions (no live work at all) blocks", async () => {
    initJobStore({ executor: NEVER_EXECUTE });
    const job = createJob("narrative", {});
    await untilRunning([job.id]);
    expect(drainBlockerCount()).toBe(1);
  });

  test("a finished claude proc no longer blocks its job", async () => {
    initJobStore({ executor: NEVER_EXECUTE });
    const job = createJob("review", {});
    await untilRunning([job.id]);
    trackExternalSession(job.id, () => {}, true);
    const proc = { exitCode: null, kill() {}, pid: 2 };
    __registerProcForTests(proc as never, job.id);
    expect(drainBlockerCount()).toBe(1);
    proc.exitCode = 0 as never;
    expect(drainBlockerCount()).toBe(0);
  });

  test("a non-detachable session (a check run FOR another job) blocks", async () => {
    initJobStore({ executor: NEVER_EXECUTE });
    const job = createJob("dispatch", {});
    await untilRunning([job.id]);
    trackExternalSession(job.id, () => {}, false);
    expect(drainBlockerCount()).toBe(1);
  });

  test("a job detached by the drain stays out of the count after its drive loop is gone", async () => {
    initJobStore({ executor: NEVER_EXECUTE });
    const oc = createJob("review", {});
    await untilRunning([oc.id]);
    const untrack = trackExternalSession(oc.id, () => {}, true);

    expect(drainBlockerCount()).toBe(0);
    expect(detachRemoteSessions()).toEqual([oc.id]);
    untrack();
    expect(drainBlockerCount()).toBe(0);
  });

  test("detaching marks the job durably, also for a session that registers after the drain began", async () => {
    initJobStore({ executor: NEVER_EXECUTE });
    const early = createJob("review", {});
    const late = createJob("review", {});
    await untilRunning([early.id, late.id]);
    trackExternalSession(early.id, () => {}, true);

    detachRemoteSessions();
    expect(column<number | null>(early.id, "detached_at")).not.toBeNull();
    expect(column<number | null>(late.id, "detached_at")).toBeNull();

    // The drain's start-of-drain pass never saw this one; registering after it detaches on the spot.
    const stops: string[] = [];
    trackExternalSession(late.id, (reason) => stops.push(reason), true);
    expect(stops).toEqual(["drain"]);
    expect(column<number | null>(late.id, "detached_at")).not.toBeNull();
  });

  test("a single-shot job blocks the drain but is not a reload refusal", async () => {
    initJobStore({ executor: NEVER_EXECUTE });
    const triage = createJob("triage", {});
    const claude = createJob("check", {});
    await untilRunning([triage.id, claude.id]);
    expect(drainBlockerCount()).toBe(2);
    expect(queueStats().reloadRefusals).toBe(1);
    expect(jobHealth().reloadRefusals).toBe(1);
  });
});

describe("pending age after a recovery", () => {
  test("a requeued job is as old as the restart, not as its submission", () => {
    const old = Date.now() - 40 * 60 * 1000;
    const job = createJob("review", {});
    seedRunning(job.id, { attempts: 1, detachedAt: Date.now(), createdAt: old });
    // No executor wired: recover() only, nothing is promoted away from `pending`.
    const seed = new Database(dbPath());
    seed.run("UPDATE jobs SET status = 'pending', requeued_at = ? WHERE id = ?", [
      Date.now(),
      job.id,
    ]);
    seed.close();

    const health = jobHealth();
    expect(health.oldestPendingAgeMs).not.toBeNull();
    expect(health.oldestPendingAgeMs ?? Infinity).toBeLessThan(5_000);
    expect(health.ok).toBe(true);
  });

  test("a job that was never requeued still ages from its submission", () => {
    const job = createJob("review", {});
    const seed = new Database(dbPath());
    seed.run("UPDATE jobs SET created_at = ? WHERE id = ?", [Date.now() - 20 * 60 * 1000, job.id]);
    seed.close();
    expect(jobHealth().oldestPendingAgeMs ?? 0).toBeGreaterThan(19 * 60 * 1000);
    expect(jobHealth().ok).toBe(false);
  });

  test("draining and the recovered-from-drain grace keep working alongside it", () => {
    setDraining();
    const job = createJob("review", {});
    const seed = new Database(dbPath());
    seed.run("UPDATE jobs SET created_at = ? WHERE id = ?", [Date.now() - 20 * 60 * 1000, job.id]);
    seed.close();
    expect(jobHealth().draining).toBe(true);
    expect(jobHealth().ok).toBe(true);
  });
});

describe("recover() — detached rows with nothing to resume", () => {
  test("detached dispatch whose worktree is gone: re-run from scratch, no budget spent, markers cleared", () => {
    const job = createJob("dispatch", {});
    seedRunning(job.id, {
      attempts: 3,
      sessionId: "ses_gone_wt",
      worktreeMeta: worktree("/nonexistent/agw-wt"),
      detachedAt: Date.now(),
    });
    initJobStore({ executor: NEVER_EXECUTE });
    expect(["pending", "running"]).toContain(getJob(job.id)?.status ?? "");
    expect(column<string | null>(job.id, "session_id")).toBeNull();
    expect(column<string | null>(job.id, "worktree_meta")).toBeNull();
    expect(column<number>(job.id, "attempts")).toBe(3); // 3 → 2 given back → 3 on promotion
  });

  test("detached dispatch with a worktree but no recorded session: re-run from scratch", () => {
    const tmp = mkdtempSync(join(tmpdir(), "agw-detach-nosess-"));
    try {
      const job = createJob("dispatch", {});
      seedRunning(job.id, { attempts: 2, worktreeMeta: worktree(tmp), detachedAt: Date.now() });
      initJobStore({ executor: NEVER_EXECUTE });
      expect(["pending", "running"]).toContain(getJob(job.id)?.status ?? "");
      expect(column<string | null>(job.id, "worktree_meta")).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("detached in-place dispatch whose live path is gone: interrupted", () => {
    const job = createJob("dispatch", {});
    seedRunning(job.id, {
      sessionId: "ses_ip",
      worktreeMeta: { path: "/nonexistent/agw-live", workspace: "in-place", snapshot: SNAPSHOT },
      detachedAt: Date.now(),
    });
    initJobStore({ executor: NEVER_EXECUTE });
    expect(getJob(job.id)?.status).toBe("interrupted");
  });

  test("detached review: the throwaway worktree is kept while it exists, cleared once it is gone", () => {
    const tmp = mkdtempSync(join(tmpdir(), "agw-detach-review-"));
    try {
      const kept = createJob("review", {});
      seedRunning(kept.id, { detachedAt: Date.now(), worktreeMeta: worktree(tmp) });
      const gone = createJob("review", {});
      seedRunning(gone.id, {
        detachedAt: Date.now(),
        worktreeMeta: worktree("/nonexistent/agw-review-wt"),
      });
      initJobStore({ executor: NEVER_EXECUTE });
      expect(JSON.parse(column<string>(kept.id, "worktree_meta")).path).toBe(tmp);
      expect(column<string | null>(gone.id, "worktree_meta")).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a crashed (not detached) review requeue clears its worktree reference — the boot sweep removed it", () => {
    const tmp = mkdtempSync(join(tmpdir(), "agw-crash-review-"));
    try {
      const job = createJob("review", {});
      seedRunning(job.id, { attempts: 1, worktreeMeta: worktree(tmp) });
      initJobStore({ executor: NEVER_EXECUTE });
      expect(column<string | null>(job.id, "worktree_meta")).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("recover() — tools without a detachable session ignore the marker", () => {
  test("update_pr is recovered by the ordinary rules, never given a free re-run", () => {
    const updatePr = createJob("update_pr", {});
    seedRunning(updatePr.id, { attempts: 1, detachedAt: Date.now() });
    initJobStore({ executor: NEVER_EXECUTE });
    // It is not requeued on recovery today; the marker changes nothing.
    expect(getJob(updatePr.id)?.status).toBe("interrupted");
  });
});

describe("recover() — a detached session that will not be re-attached is interrupted on boot", () => {
  test("in-place without a snapshot, a worktree-less dispatch, and a cancelled review's ledger sessions", () => {
    const interrupt = spyOn(opencodeServer, "interruptOpencodeSession").mockResolvedValue(
      undefined as never,
    );
    try {
      const tmp = mkdtempSync(join(tmpdir(), "agw-detach-int-"));
      const noSnapshot = createJob("dispatch", {});
      seedRunning(noSnapshot.id, {
        sessionId: "ses_in_place",
        worktreeMeta: { path: tmp, workspace: "in-place" },
        detachedAt: Date.now(),
      });
      const fresh = createJob("dispatch", {});
      seedRunning(fresh.id, {
        sessionId: "ses_fresh",
        worktreeMeta: worktree("/nonexistent/agw-int"),
        detachedAt: Date.now(),
      });
      const cancelled = createJob("review", {});
      seedRunning(cancelled.id, { detachedAt: Date.now() });
      getSessionLedger()?.put(cancelled.id, "angle:qa", "ses_angle_qa");
      const seed = new Database(dbPath());
      seed.run("UPDATE jobs SET cancel_requested_at = ? WHERE id = ?", [Date.now(), cancelled.id]);
      seed.close();

      initJobStore({ executor: NEVER_EXECUTE });
      rmSync(tmp, { recursive: true, force: true });

      expect(getJob(noSnapshot.id)?.status).toBe("interrupted");
      expect(getJob(cancelled.id)?.status).toBe("cancelled");
      const stopped = interrupt.mock.calls.map((c) => c[0]).toSorted();
      expect(stopped).toEqual(["ses_angle_qa", "ses_fresh", "ses_in_place"]);
      expect(getSessionLedger()?.get(cancelled.id, "angle:qa")).toBeUndefined();
    } finally {
      interrupt.mockRestore();
    }
  });

  test("a review interrupted at the cap releases its ledger sessions", () => {
    const interrupt = spyOn(opencodeServer, "interruptOpencodeSession").mockResolvedValue(
      undefined as never,
    );
    try {
      const job = createJob("review", {});
      seedRunning(job.id, { attempts: 2 }); // crash, budget spent
      getSessionLedger()?.put(job.id, "angle:qa", "ses_capped");
      initJobStore({ executor: NEVER_EXECUTE });
      expect(getJob(job.id)?.status).toBe("interrupted");
      expect(interrupt.mock.calls.map((c) => c[0])).toEqual(["ses_capped"]);
    } finally {
      interrupt.mockRestore();
    }
  });
});

describe("dispatchRecoveryDecision", () => {
  const row = { attempts: 3, session_id: "ses_x" };
  test("a detached worktree row spends no attempt; an undetached one at the cap is interrupted", () => {
    expect(dispatchRecoveryDecision(row, null, true, true)).toBe("resume");
    expect(dispatchRecoveryDecision(row, null, false, true)).toBe("interrupted");
    expect(dispatchRecoveryDecision({ attempts: 3, session_id: null }, null, true, true)).toBe(
      "fresh",
    );
  });

  test("in-place needs the detach marker, a snapshot, a session and an existing path", () => {
    const meta = { path: "/p", workspace: "in-place", snapshot: SNAPSHOT };
    expect(dispatchRecoveryDecision(row, meta, true, true)).toBe("resume");
    expect(dispatchRecoveryDecision(row, meta, false, true)).toBe("interrupted");
    expect(dispatchRecoveryDecision(row, meta, true, false)).toBe("interrupted");
    expect(dispatchRecoveryDecision(row, { path: "/p", workspace: "in-place" }, true, true)).toBe(
      "interrupted",
    );
    expect(dispatchRecoveryDecision({ attempts: 1, session_id: null }, meta, true, true)).toBe(
      "interrupted",
    );
  });
});
