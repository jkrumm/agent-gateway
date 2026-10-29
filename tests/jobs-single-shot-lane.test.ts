// The single-shot admission lane: `triage`/`decide` are one tool-less IU request each, so they
// neither count against AGENT_GATEWAY_JOB_CONCURRENCY (the session lane) nor wait behind a full
// session lane. They have their own cap, AGENT_GATEWAY_SINGLE_SHOT_CONCURRENCY (default 6).
//
// Drives real jobs through store.ts's promote()/execute() with a controllable fake executor, same
// technique as tests/jobs-repo-lease-queue.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetForTests,
  createJob,
  getJob,
  initJobStore,
  jobHealth,
  laneOf,
  queueStats,
} from "../server/jobs/store.ts";
import { jobsRoutes } from "../server/routes/jobs.ts";

/** Per-job gates: resolving one lets that job's fake worker finish. */
let gates: Map<string, () => void>;
let started: string[];

beforeEach(() => {
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

const triage = () => createJob("triage", { prompt: "p", schema: { type: "object" } });
const decide = () => createJob("decide", { state: "s", questions: {} });
const check = () => createJob("check", { cwd: "/nonexistent" });

describe("laneOf", () => {
  test("triage and decide are single-shot, every other tool is a session", () => {
    expect(laneOf("triage")).toBe("single_shot");
    expect(laneOf("decide")).toBe("single_shot");
    for (const tool of ["check", "review", "dispatch", "overview", "narrative", "update_pr"]) {
      expect(laneOf(tool)).toBe("session");
    }
  });
});

describe("single-shot lane admission", () => {
  test("a single-shot job is admitted while the session lane is full", async () => {
    const sessions = [check(), check(), check()];
    const queuedSession = check();
    const shot = triage();
    await flush();

    for (const job of sessions) expect(getJob(job.id)?.status).toBe("running");
    expect(getJob(queuedSession.id)?.status).toBe("pending");
    expect(getJob(shot.id)?.status).toBe("running");

    const stats = queueStats();
    expect(stats).toMatchObject({
      running: 3,
      pending: 1,
      max: 3,
      singleShot: { running: 1, pending: 0, max: 6 },
    });
  });

  test("single-shot jobs do not occupy session slots", async () => {
    const shots = [triage(), decide(), triage(), decide(), triage()];
    const session = check();
    await flush();

    for (const job of shots) expect(getJob(job.id)?.status).toBe("running");
    expect(getJob(session.id)?.status).toBe("running");
    expect(queueStats()).toMatchObject({ running: 1, singleShot: { running: 5 } });
  });

  test("the single-shot lane has its own cap; the overflow queues FIFO and promotes on finish", async () => {
    const shots = Array.from({ length: 7 }, () => triage());
    await flush();

    for (const job of shots.slice(0, 6)) expect(getJob(job.id)?.status).toBe("running");
    expect(getJob(shots[6]?.id as string)?.status).toBe("pending");
    expect(queueStats().singleShot).toMatchObject({ running: 6, pending: 1, max: 6 });

    await finishJob(shots[0]?.id as string);
    expect(getJob(shots[6]?.id as string)?.status).toBe("running");
    expect(queueStats().singleShot).toMatchObject({ running: 6, pending: 0 });
  });

  test("a full single-shot lane does not block a session job behind it, and vice versa", async () => {
    const shots = Array.from({ length: 6 }, () => decide());
    const overflowShot = decide(); // pending: lane full
    const session = check(); // younger than the pending single-shot
    await flush();
    expect(getJob(overflowShot.id)?.status).toBe("pending");
    expect(getJob(session.id)?.status).toBe("running");

    // And the reverse: fill the session lane, a younger single-shot is still blocked only by its
    // own lane (free a single-shot slot -> it runs although sessions are full).
    check();
    check();
    const blockedSession = check();
    await flush();
    expect(getJob(blockedSession.id)?.status).toBe("pending");
    await finishJob(shots[0]?.id as string);
    expect(getJob(overflowShot.id)?.status).toBe("running");
    expect(getJob(blockedSession.id)?.status).toBe("pending");
  });

  test("finishing a single-shot job frees no session slot, finishing a session job frees no single-shot slot", async () => {
    const sessions = [check(), check(), check()];
    const queued = check();
    const shot = triage();
    await flush();

    await finishJob(shot.id);
    expect(getJob(queued.id)?.status).toBe("pending");

    await finishJob(sessions[0]?.id as string);
    expect(getJob(queued.id)?.status).toBe("running");
    expect(queueStats().singleShot.running).toBe(0);
  });
});

describe("health payload", () => {
  const TWENTY_MIN = 20 * 60 * 1000;

  test("reports the session lane at the top level and the single-shot lane under singleShot", async () => {
    check();
    triage();
    await flush();
    const health = jobHealth();
    expect(health).toMatchObject({
      running: 1,
      pending: 0,
      max: 3,
      singleShot: { running: 1, pending: 0, max: 6, oldestPendingAgeMs: null },
    });
  });

  test("a single-shot waiting >15 min in a full single-shot lane trips health", async () => {
    for (let i = 0; i < 7; i++) triage();
    await flush();

    const health = jobHealth(Date.now() + TWENTY_MIN);
    expect(health.pending).toBe(0);
    expect(health.oldestPendingAgeMs).toBeNull();
    expect(health.singleShot.pending).toBe(1);
    expect(health.singleShot.oldestPendingAgeMs).toBeGreaterThan(15 * 60 * 1000);
    expect(health.ok).toBe(false);
  });

  test("a session job behind a full session lane ages in the session fields, not the single-shot ones", async () => {
    for (let i = 0; i < 4; i++) check();
    triage();
    await flush();

    const health = jobHealth(Date.now() + TWENTY_MIN);
    expect(health.pending).toBe(1);
    expect(health.oldestPendingAgeMs).toBeGreaterThan(15 * 60 * 1000);
    expect(health.singleShot.oldestPendingAgeMs).toBeNull();
    expect(health.ok).toBe(false);
  });

  test("GET /api/jobs/health serves the singleShot block", async () => {
    triage();
    await flush();
    const res = await jobsRoutes.handle(new Request("http://localhost/api/jobs/health"));
    const body = (await res.json()) as { singleShot: { running: number; max: number } };
    expect(body.singleShot).toMatchObject({ running: 1, max: 6 });
  });
});
