// POST /api/jobs: a per-job `model` on a dispatch that the registry would silently ignore
// (unknown / unverified) is a loud 400 instead — and nothing else about submission changes.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { __resetForTests, listJobs } from "../server/jobs/store.ts";
import { jobsRoutes } from "../server/routes/jobs.ts";

// No executor registered (and a clean queue): accepted jobs stay `pending` instead of running.
__resetForTests();
afterAll(() => __resetForTests());

const root = (process.env.AGENT_GATEWAY_DISPATCH_ROOTS ?? "").split(",")[0]?.trim() ?? "";

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

describe("dispatch `model` refusal", () => {
  const repo = join(root, "model-refusal-repo");

  test("setup: a repo directly under the dispatch root", () => {
    expect(root).not.toBe("");
    mkdirSync(repo, { recursive: true });
  });

  test("an unknown id is a 400 naming it, and creates nothing", async () => {
    const before = listJobs().length;
    const { status, body } = await post({
      tool: "dispatch",
      params: { cwd: repo, tier: "investigate", brief: "x", model: "no-such-model" },
    });
    expect(status).toBe(400);
    expect(body.error).toBe(
      "dispatch refused: model no-such-model is not a verified registry model",
    );
    expect(listJobs().length).toBe(before);
  });

  test("a registered but unverified id is refused too", async () => {
    const { status, body } = await post({
      tool: "dispatch",
      params: { cwd: repo, tier: "investigate", brief: "x", model: "gpt-6-sol" },
    });
    expect(status).toBe(400);
    expect(body.error).toContain("gpt-6-sol is not a verified registry model");
  });

  test("a verified id is accepted", async () => {
    const { status, body } = await post({
      tool: "dispatch",
      params: { cwd: repo, tier: "investigate", brief: "x", model: "deepseek-v4.1-flash" },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  test("the escalation model DeepSeek-V4-Pro is verified and accepted for dispatch", async () => {
    const { status, body } = await post({
      tool: "dispatch",
      params: { cwd: repo, tier: "investigate", brief: "x", model: "DeepSeek-V4-Pro" },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  test("a non-string model is refused as invalid params", async () => {
    const before = listJobs().length;
    const { status, body } = await post({
      tool: "dispatch",
      params: { cwd: repo, tier: "investigate", brief: "x", model: 7 },
    });
    expect(status).toBe(400);
    expect(body.error).toContain("dispatch refused: invalid params");
    expect(body.error).toContain("model");
    expect(listJobs().length).toBe(before);
  });

  test("other tools are untouched, and triage is a known tool", async () => {
    expect((await post({ tool: "check", params: { cwd: repo } })).status).toBe(200);
    const triage = await post({
      tool: "triage",
      params: { prompt: "p", schema: { type: "object" } },
    });
    expect(triage.status).toBe(200);
    expect(triage.body.ok).toBe(true);
  });

  test("cleanup", () => {
    rmSync(repo, { recursive: true, force: true });
  });
});

describe("`model` refusal beyond dispatch", () => {
  test("review with an unknown model is refused too", async () => {
    const { status, body } = await post({
      tool: "review",
      params: { cwd: "/tmp/x", model: "no-such-model" },
    });
    expect(status).toBe(400);
    expect(body.error).toBe("review refused: model no-such-model is not a verified registry model");
  });
});
