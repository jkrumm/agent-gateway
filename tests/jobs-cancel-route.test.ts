// POST /api/jobs/:id/cancel (server/routes/jobs.ts → server/jobs/store.ts's cancelJob) against
// the real route via `.handle()`, same pattern tests/jobs-health.test.ts and
// tests/shutdown-route.test.ts use. Covers the HTTP-visible contract: 404/409/200 and that a
// cancel never inflates `failedLastHour`. The running-job transition itself (cancelRequested →
// cancelled, not failed) is tests/jobs-cancel-running.test.ts — that needs store.ts's
// lower-level API to inject a controllable executor.

import { afterEach, describe, expect, test } from "bun:test";
import { __resetForTests, createJob, initJobStore } from "../server/jobs/store.ts";
import { jobsRoutes } from "../server/routes/jobs.ts";

afterEach(() => {
  __resetForTests();
});

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

// `res.json()` is typed `unknown` under Bun's globals; the fields below are the ones this
// file reads. `job`/`error` are optional because the 404/409 bodies carry only one of them.
type CancelBody = {
  ok: boolean;
  error?: string;
  job?: { status: string; error: string | null };
};

async function postCancel(id: string): Promise<{ status: number; body: CancelBody }> {
  const res = await jobsRoutes.handle(
    new Request(`http://localhost/api/jobs/${id}/cancel`, { method: "POST" }),
  );
  return { status: res.status, body: (await res.json()) as CancelBody };
}

describe("POST /api/jobs/:id/cancel", () => {
  test("unknown id → 404", async () => {
    const { status, body } = await postCancel("no-such-job");
    expect(status).toBe(404);
    expect(body).toEqual({ ok: false, error: "job not found" });
  });

  test("already-terminal (done) job → 409", async () => {
    initJobStore({ executor: async () => ({ fine: true }) });
    const created = createJob("check", {});
    await flush();

    const { status, body } = await postCancel(created.id);
    expect(status).toBe(409);
    expect(body).toEqual({ ok: false, error: "job already done" });
  });

  test("pending job → 200, and the job reads cancelled and terminal", async () => {
    // No initJobStore: promote() bails out with no executor registered, so the job stays
    // `pending` forever instead of racing to `running`.
    const created = createJob("check", {});

    const { status, body } = await postCancel(created.id);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.job?.status).toBe("cancelled");
    expect(body.job?.error).toBe("cancelled by request");

    const res = await jobsRoutes.handle(new Request(`http://localhost/api/jobs/${created.id}`));
    const polled = (await res.json()) as { job: { status: string } };
    expect(polled.job.status).toBe("cancelled");
  });

  test("a cancelled pending job never counts toward failedLastHour", async () => {
    const created = createJob("check", {});
    const { status } = await postCancel(created.id);
    expect(status).toBe(200);

    const res = await jobsRoutes.handle(new Request("http://localhost/api/jobs/health"));
    const body = (await res.json()) as { failedLastHour: number };
    expect(body.failedLastHour).toBe(0);
  });
});
