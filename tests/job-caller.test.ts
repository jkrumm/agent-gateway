// A job's `caller` (the submitting consumer's slug): validated at POST /api/jobs, persisted on
// the row, exposed on the job view, and stamped onto every usage/attribution record the job
// produces. Absent caller → the field is omitted everywhere.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { __resetForTests } from "../server/jobs/store.ts";
import { toJobView, type JobRecord } from "../server/jobs/types.ts";
import { callerField, currentCaller, isValidCaller, withCaller } from "../server/lib/caller.ts";
import { recordIuUsage } from "../server/lib/iu-openai.ts";
import { writeAttribution } from "../server/mcp/session-core.ts";
import { jobsRoutes } from "../server/routes/jobs.ts";

// No executor registered: accepted jobs stay `pending`.
__resetForTests();
afterAll(() => __resetForTests());

type JobBody = { ok: boolean; error?: string; job?: { id: string; caller?: string } };

async function post(body: unknown): Promise<{ status: number; body: JobBody }> {
  const res = await jobsRoutes.handle(
    new Request("http://localhost/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as JobBody };
}

async function getJob(id: string): Promise<JobBody> {
  const res = await jobsRoutes.handle(new Request(`http://localhost/api/jobs/${id}`));
  return (await res.json()) as JobBody;
}

const decideParams = { state: "s", questions: {} };

describe("caller validation", () => {
  test.each(["iris", "a", "my-service-2", "0abc", "x".repeat(32)])("accepts %s", (slug) => {
    expect(isValidCaller(slug)).toBe(true);
  });

  test.each(["", "Iris", "-iris", "iris_x", "iris x", "x".repeat(33), 5, null])(
    "rejects %p",
    (slug) => {
      expect(isValidCaller(slug)).toBe(false);
    },
  );
});

describe("POST /api/jobs caller", () => {
  test("is persisted and exposed on the create response and GET /:id", async () => {
    const { status, body } = await post({ tool: "decide", params: decideParams, caller: "iris" });
    expect(status).toBe(200);
    expect(body.job?.caller).toBe("iris");
    expect((await getJob(body.job?.id ?? "")).job?.caller).toBe("iris");
  });

  test("absent caller omits the field", async () => {
    const { body } = await post({ tool: "triage", params: {} });
    expect(body.ok).toBe(true);
    const fetched = await getJob(body.job?.id ?? "");
    expect(fetched.job).toBeDefined();
    expect("caller" in (fetched.job ?? {})).toBe(false);
  });

  test("an invalid slug is a 400 naming the rule, whatever the tool or JSON type", async () => {
    for (const tool of ["decide", "triage", "check"]) {
      const { status, body } = await post({ tool, params: {}, caller: "Not A Slug" });
      expect(status).toBe(400);
      expect(body.error).toContain("caller must match");
    }
    for (const caller of [null, 5, "", {}, ["iris"]]) {
      const { status, body } = await post({ tool: "decide", params: {}, caller });
      expect(status).toBe(400);
      expect(body.error).toContain("caller must match");
    }
  });
});

describe("job view", () => {
  test("carries the caller key only when one was sent", () => {
    const record = (caller: string | null): JobRecord => ({
      id: "j1",
      tool: "triage",
      params: {},
      caller,
      status: "pending",
      result: null,
      error: null,
      progress: null,
      attempts: 0,
      createdAt: 1,
      startedAt: null,
      finishedAt: null,
      cancelRequestedAt: null,
      sessionId: null,
      worktreeMeta: null,
    });
    expect(toJobView(record("iris")).caller).toBe("iris");
    expect("caller" in toJobView(record(null))).toBe(false);
  });
});

describe("ambient caller", () => {
  test("survives awaits, and an uncalled job does not inherit an outer caller", async () => {
    await withCaller("iris", async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(currentCaller()).toBe("iris");
      await withCaller(null, async () => {
        await Promise.resolve();
        expect(callerField()).toEqual({});
      });
      expect(currentCaller()).toBe("iris");
    });
    expect(currentCaller()).toBeUndefined();
  });
});

describe("usage records", () => {
  const sessionsLog = process.env.AGENT_GATEWAY_SESSIONS_LOG ?? "";
  const iuLog = process.env.AGENT_GATEWAY_IU_USAGE_LOG ?? "";
  const lastRow = (path: string): Record<string, unknown> => {
    const lines = readFileSync(path, "utf8").trim().split("\n");
    return JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, unknown>;
  };

  beforeEach(() => {
    for (const p of [sessionsLog, iuLog]) if (p && existsSync(p)) rmSync(p);
  });

  test("session attribution rows carry the caller inside a job, and omit it outside", async () => {
    await withCaller("iris", async () => {
      await Promise.resolve();
      writeAttribution({ tool: "decide", jobId: "j1" });
    });
    expect(lastRow(sessionsLog)).toMatchObject({ tool: "decide", jobId: "j1", caller: "iris" });

    writeAttribution({ tool: "decide", jobId: "j2" });
    expect("caller" in lastRow(sessionsLog)).toBe(false);
  });

  test("IU usage rows (single-shot / decide spend) carry the caller too", async () => {
    await withCaller("iris", () => recordIuUsage({ tool: "triage", model: "m", latencyMs: 1 }));
    expect(lastRow(iuLog)).toMatchObject({ tool: "triage", caller: "iris" });

    await recordIuUsage({ tool: "triage", model: "m", latencyMs: 1 });
    expect("caller" in lastRow(iuLog)).toBe(false);
  });
});
