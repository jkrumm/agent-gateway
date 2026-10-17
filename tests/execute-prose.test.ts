// executeJob (server/jobs/executor.ts) routes the `prose` tool to runProse. Driven through the
// real store with the real executor and no module mock. The params fail runProse's own zod parse
// (no `medium`), before any model or voice-guide access: the "invalid params" message naming
// `medium` is produced by that handler alone, so seeing it on the job proves the dispatch arm.

import { afterEach, describe, expect, test } from "bun:test";
import { executeJob } from "../server/jobs/executor.ts";
import { __resetForTests, createJob, getJob, initJobStore } from "../server/jobs/store.ts";

afterEach(() => {
  __resetForTests();
});

const SETTLE_DEADLINE_MS = 2000;

/** Poll until the job leaves pending/running, or the deadline passes. */
async function settled(id: string): Promise<void> {
  const deadline = Date.now() + SETTLE_DEADLINE_MS;
  while (Date.now() < deadline) {
    const status = getJob(id)?.status;
    if (status !== "pending" && status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("executeJob → prose", () => {
  test("runs runProse: it validates its own params", async () => {
    initJobStore({ executor: executeJob });
    const view = createJob("prose", { text: "A draft." });
    await settled(view.id);

    const after = getJob(view.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toContain("invalid params");
    expect(after?.error).toContain("medium");
  });
});
