// A busy repo QUEUES implement-class jobs instead of refusing them: the job store takes the
// per-repo lease (server/lib/repo-lease.ts) at promotion, so a second implement dispatch or
// update_pr for the same repo stays `pending` (`queuedBehind`), starts FIFO when the holder
// finishes, can be cancelled while queued, and never pages the queue-health rule.
//
// Drives real jobs through store.ts's promote()/execute() with a controllable fake executor
// standing in for a worker session (same technique as tests/jobs-cancel-running.test.ts). The
// repos are plain temp directories — the store only needs a path that resolves.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetForTests,
  cancelJob,
  createJob,
  getJob,
  initJobStore,
  jobHealth,
  listJobs,
  markDrainKilled,
  setDraining,
} from "../server/jobs/store.ts";
import {
  releaseRepoLease,
  repoLeaseCwdFor,
  repoLeaseHolder,
  tryAcquireRepoLease,
} from "../server/lib/repo-lease.ts";
import { jobsRoutes } from "../server/routes/jobs.ts";

let base: string;
let repoA: string;
let repoB: string;
/** Per-job gates: resolving one lets that job's fake worker finish. */
let gates: Map<string, () => void>;
let started: string[];

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "agent-gateway-lease-queue-")));
  repoA = join(base, "repo-a");
  repoB = join(base, "repo-b");
  mkdirSync(repoA);
  mkdirSync(repoB);
  gates = new Map();
  started = [];
  initJobStore({
    executor: (job) =>
      new Promise((resolve) => {
        started.push(job.id);
        gates.set(job.id, () => resolve({ done: job.id }));
      }),
  });
});

afterEach(() => {
  __resetForTests();
  rmSync(base, { recursive: true, force: true });
});

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function finishJob(id: string): Promise<void> {
  const gate = gates.get(id);
  if (!gate) throw new Error(`job ${id} never started`);
  gate();
  await flush();
}

const implement = (cwd: string) => ({ cwd, tier: "implement", brief: "b" });

describe("repoLeaseCwdFor", () => {
  test("only implement dispatches and update_pr contend", () => {
    expect(repoLeaseCwdFor("dispatch", implement("/x"))).toBe("/x");
    expect(repoLeaseCwdFor("update_pr", { cwd: "/x", pr: 1 })).toBe("/x");
    expect(repoLeaseCwdFor("dispatch", { cwd: "/x", tier: "investigate" })).toBeNull();
    expect(repoLeaseCwdFor("dispatch", { cwd: "/x" })).toBeNull();
    expect(repoLeaseCwdFor("check", { cwd: "/x" })).toBeNull();
    expect(repoLeaseCwdFor("dispatch", { cwd: 42, tier: "implement" })).toBeNull();
  });
});

describe("a busy repo queues implement jobs", () => {
  test("the second implement in the same repo stays pending, then runs when the first finishes", async () => {
    const first = createJob("dispatch", implement(repoA));
    const second = createJob("dispatch", implement(repoA));
    await flush();

    expect(getJob(first.id)?.status).toBe("running");
    const queued = getJob(second.id);
    expect(queued?.status).toBe("pending");
    expect(queued?.queuedBehind).toBe(first.id);
    expect(started).toEqual([first.id]);

    await finishJob(first.id);
    expect(getJob(first.id)?.status).toBe("done");
    expect(getJob(second.id)?.status).toBe("running");
    expect(getJob(second.id)?.queuedBehind).toBeUndefined();
    expect(started).toEqual([first.id, second.id]);

    await finishJob(second.id);
    expect(getJob(second.id)?.status).toBe("done");
    expect(repoLeaseHolder(repoA)).toBeUndefined();
  });

  test("the submit response itself already says pending/queuedBehind (no running ack that fails later)", async () => {
    const first = createJob("dispatch", implement(repoA));
    const second = createJob("dispatch", implement(repoA));
    expect(first.status).toBe("running");
    expect(second.status).toBe("pending");
    expect(second.queuedBehind).toBe(first.id);
  });

  test("waiters start FIFO per repo", async () => {
    const a1 = createJob("dispatch", implement(repoA));
    const a2 = createJob("dispatch", implement(repoA));
    const a3 = createJob("dispatch", implement(repoA));
    await flush();
    expect(started).toEqual([a1.id]);

    await finishJob(a1.id);
    expect(started).toEqual([a1.id, a2.id]);
    expect(getJob(a3.id)?.queuedBehind).toBe(a2.id);

    await finishJob(a2.id);
    expect(started).toEqual([a1.id, a2.id, a3.id]);
  });

  test("a different repo and a read tier are not held back by the busy repo", async () => {
    const holder = createJob("dispatch", implement(repoA));
    const otherRepo = createJob("dispatch", implement(repoB));
    const readTier = createJob("dispatch", { cwd: repoA, tier: "investigate", brief: "b" });
    await flush();

    for (const job of [holder, otherRepo, readTier]) {
      expect(getJob(job.id)?.status).toBe("running");
    }
  });

  test("update_pr shares the lease with implement dispatches, in both directions", async () => {
    const impl = createJob("dispatch", implement(repoA));
    const update = createJob("update_pr", { cwd: repoA, pr: 7 });
    await flush();
    expect(getJob(update.id)?.status).toBe("pending");
    expect(getJob(update.id)?.queuedBehind).toBe(impl.id);

    await finishJob(impl.id);
    expect(getJob(update.id)?.status).toBe("running");

    const second = createJob("dispatch", implement(repoA));
    await flush();
    expect(getJob(second.id)?.queuedBehind).toBe(update.id);
  });

  test("a queued job does not block a younger job for another repo (no head-of-line blocking)", async () => {
    const a1 = createJob("dispatch", implement(repoA));
    const a2 = createJob("dispatch", implement(repoA));
    const b1 = createJob("dispatch", implement(repoB));
    await flush();
    expect(getJob(a2.id)?.status).toBe("pending");
    expect(getJob(b1.id)?.status).toBe("running");
    expect(getJob(a1.id)?.status).toBe("running");
  });

  test("a failing holder still releases the lease to the next waiter", async () => {
    initJobStore({
      executor: (job) =>
        job.params.brief === "boom"
          ? Promise.reject(new Error("worker exploded"))
          : new Promise((resolve) => {
              started.push(job.id);
              gates.set(job.id, () => resolve({ done: job.id }));
            }),
    });
    const failing = createJob("dispatch", { ...implement(repoA), brief: "boom" });
    const next = createJob("dispatch", implement(repoA));
    await flush();
    expect(getJob(failing.id)?.status).toBe("failed");
    expect(getJob(next.id)?.status).toBe("running");
  });

  test("the lease is not stranded by a full concurrency cap: a capped job holds nothing", async () => {
    // Fill the three slots with non-leased jobs, then queue an implement job behind the cap.
    const blockers = [1, 2, 3].map(() => createJob("check", { cwd: repoB }));
    const capped = createJob("dispatch", implement(repoA));
    await flush();
    expect(getJob(capped.id)?.status).toBe("pending");
    expect(getJob(capped.id)?.queuedBehind).toBeUndefined();
    expect(repoLeaseHolder(repoA)).toBeUndefined();

    await finishJob((blockers[0] as { id: string }).id);
    expect(getJob(capped.id)?.status).toBe("running");
    expect(repoLeaseHolder(repoA)).toBe(capped.id);
  });
});

describe("cancel on a lease-queued job", () => {
  test("cancels immediately, never ran, and does not disturb the holder or the next waiter", async () => {
    const holder = createJob("dispatch", implement(repoA));
    const queuedA = createJob("dispatch", implement(repoA));
    const queuedB = createJob("dispatch", implement(repoA));
    await flush();

    const cancelled = cancelJob(queuedA.id);
    expect(cancelled.ok).toBe(true);
    expect(getJob(queuedA.id)?.status).toBe("cancelled");
    expect(getJob(holder.id)?.status).toBe("running");
    expect(started).toEqual([holder.id]);

    await finishJob(holder.id);
    expect(getJob(queuedB.id)?.status).toBe("running");
    expect(started).toEqual([holder.id, queuedB.id]);
  });

  test("the HTTP cancel route works on it", async () => {
    createJob("dispatch", implement(repoA));
    const queued = createJob("dispatch", implement(repoA));
    const res = await jobsRoutes.handle(
      new Request(`http://localhost/api/jobs/${queued.id}/cancel`, { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(getJob(queued.id)?.status).toBe("cancelled");
  });

  test("the queued state is visible through GET /api/jobs/:id and the job list", async () => {
    const holder = createJob("dispatch", implement(repoA));
    const queued = createJob("dispatch", implement(repoA));
    await flush();
    const res = await jobsRoutes.handle(new Request(`http://localhost/api/jobs/${queued.id}`));
    const body = (await res.json()) as { job: { status: string; queuedBehind?: string } };
    expect(body.job.status).toBe("pending");
    expect(body.job.queuedBehind).toBe(holder.id);
    expect(listJobs().find((j) => j.id === queued.id)?.queuedBehind).toBe(holder.id);
  });
});

describe("queue health ignores lease-queued jobs", () => {
  const TWENTY_MIN = 20 * 60 * 1000;

  test("a job queued behind a long episode does not trip the oldest-pending page", async () => {
    createJob("dispatch", implement(repoA));
    createJob("dispatch", implement(repoA));
    await flush();

    const health = jobHealth(Date.now() + TWENTY_MIN);
    expect(health.pending).toBe(1);
    expect(health.leaseQueued).toBe(1);
    expect(health.oldestPendingAgeMs).toBeNull();
    expect(health.ok).toBe(true);
  });

  test("a pending job waiting for a concurrency slot still trips it (the rule is intact)", async () => {
    for (let i = 0; i < 3; i++) createJob("check", { cwd: repoB });
    createJob("check", { cwd: repoB });
    await flush();

    const health = jobHealth(Date.now() + TWENTY_MIN);
    expect(health.leaseQueued).toBe(0);
    expect(health.oldestPendingAgeMs).toBeGreaterThan(15 * 60 * 1000);
    expect(health.ok).toBe(false);
  });

  test("mixed: the slot-waiting job is what ages, the lease-queued older one is skipped", async () => {
    for (let i = 0; i < 2; i++) createJob("check", { cwd: repoB });
    createJob("dispatch", implement(repoA)); // runs: third slot
    const queuedBehindLease = createJob("dispatch", implement(repoA));
    const slotWaiting = createJob("check", { cwd: repoB });
    await flush();
    expect(getJob(queuedBehindLease.id)?.queuedBehind).toBeDefined();
    expect(getJob(slotWaiting.id)?.status).toBe("pending");

    const health = jobHealth(Date.now() + TWENTY_MIN);
    expect(health.pending).toBe(2);
    expect(health.leaseQueued).toBe(1);
    expect(health.ok).toBe(false);
  });
});

describe("a drain-abandoned holder", () => {
  test("releases the repo lease, so the next waiter is not stranded behind a dead job", async () => {
    // The holder's worker is killed by a drain: execute() leaves its row `running` for next
    // boot's recovery and must still free the lease it took at promotion.
    initJobStore({
      executor: async (job) => {
        setDraining();
        markDrainKilled([job.id]);
        throw new Error("Session exited with code 143");
      },
    });
    const holder = createJob("dispatch", implement(repoA));
    const waiter = createJob("dispatch", implement(repoA));
    await flush();

    expect(getJob(holder.id)?.status).toBe("running"); // abandoned, not failed
    expect(getJob(waiter.id)?.status).toBe("pending"); // a drain admits nothing new
    expect(repoLeaseHolder(repoA)).toBeUndefined();
    // ...so the waiter's promotion (on the restarted process, or any later promote) can take it.
    expect(tryAcquireRepoLease(repoA, waiter.id)).toEqual({ ok: true, reentrant: false });
    releaseRepoLease(repoA, waiter.id);
  });
});

describe("repo lease primitives", () => {
  test("re-entry by the holder is a no-op that must not release; another job's release is ignored", () => {
    const first = tryAcquireRepoLease(repoA, "job-1");
    expect(first).toEqual({ ok: true, reentrant: false });
    expect(tryAcquireRepoLease(repoA, "job-1")).toEqual({ ok: true, reentrant: true });
    expect(tryAcquireRepoLease(repoA, "job-2")).toEqual({ ok: false, holder: "job-1" });

    releaseRepoLease(repoA, "job-2");
    expect(repoLeaseHolder(repoA)).toBe("job-1");
    releaseRepoLease(repoA, "job-1");
    expect(repoLeaseHolder(repoA)).toBeUndefined();
  });
});
