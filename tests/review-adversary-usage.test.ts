// `runAdversaryAngle` (server/jobs/handlers/review.ts) tags its `textComplete` call
// "review:adversary" — one of the recordIuUsage sub-tools the brief found with no job_id/cwd
// (Argo's usage page: $91 of 30-day IU spend unattributed under this tag). This exercises the
// job_id/cwd threading end-to-end through textComplete → recordIuUsage, the model call stubbed
// at `globalThis.fetch` (tests/review-router.test.ts's seam).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sink = join(tmpdir(), `agent-gateway-adversary-usage-test-${Date.now()}.jsonl`);
process.env.AGENT_GATEWAY_IU_USAGE_LOG = sink;
process.env.IU_API_KEY = "test-key";
process.env.IU_BASE_URL = "https://iu.example.com/anthropic";

const { runAdversaryAngle } = await import("../server/jobs/handlers/review.ts");

const originalFetch = globalThis.fetch;

function stubAdversaryAnswer(text: string): void {
  globalThis.fetch = (async () => {
    const chunk = { id: "c1", model: "m", choices: [{ delta: { content: text } }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function readLastRow(): Promise<Record<string, unknown>> {
  const text = await Bun.file(sink).text();
  return JSON.parse(text.trim().split("\n").at(-1) ?? "{}");
}

describe("runAdversaryAngle — usage attribution", () => {
  test("tags the usage row with the caller's job id and cwd", async () => {
    stubAdversaryAnswer('{"findings":[]}');
    const tmpDir = await mkdtemp(join(tmpdir(), "adversary-prompt-"));
    const promptPath = join(tmpDir, "adversary.md");
    await writeFile(promptPath, "diff:\n[DIFF]\ncontext:\n[CONTEXT_BLOCK]");

    try {
      const result = await runAdversaryAngle({
        diff: "diff --git a/x b/x\n+token = leak()",
        contextBlock: "",
        promptPath,
        jobId: "job-123",
        cwd: "/repo/path",
      });
      expect(result.findings).toEqual([]);

      const row = await readLastRow();
      expect(row.tool).toBe("review:adversary");
      expect(row.job_id).toBe("job-123");
      expect(row.cwd).toBe("/repo/path");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("writes null job_id/cwd when the caller passes neither", async () => {
    stubAdversaryAnswer('{"findings":[]}');
    const tmpDir = await mkdtemp(join(tmpdir(), "adversary-prompt-"));
    const promptPath = join(tmpDir, "adversary.md");
    await writeFile(promptPath, "diff:\n[DIFF]\ncontext:\n[CONTEXT_BLOCK]");

    try {
      await runAdversaryAngle({ diff: "diff", contextBlock: "", promptPath });
      const row = await readLastRow();
      expect(row.job_id).toBeNull();
      expect(row.cwd).toBeNull();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
