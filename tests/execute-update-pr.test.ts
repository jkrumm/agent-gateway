// executeJob (server/jobs/executor.ts) routes the `update_pr` tool to runUpdatePr. Driven
// through the real store with the real executor and no module mock (a bun `mock.module` would
// leak into every other test file's runUpdatePr). The params are chosen so runUpdatePr fails
// at its own policy gate, before any git/forge call: the "update_pr refused" message is
// produced by that handler alone, so seeing it on the job proves the dispatch arm is wired.

import { afterEach, describe, expect, test } from "bun:test";
import { executeJob } from "../server/jobs/executor.ts";
import { __resetForTests, createJob, getJob, initJobStore } from "../server/jobs/store.ts";

afterEach(() => {
  __resetForTests();
});

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("executeJob → update_pr", () => {
  test("runs runUpdatePr: a cwd outside every dispatch root fails with its policy refusal", async () => {
    initJobStore({ executor: executeJob });
    const view = createJob("update_pr", { cwd: "/etc", pr: 1 });
    await flush();

    const after = getJob(view.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/^update_pr refused: /);
  });

  test("runUpdatePr validates its own params (not another handler's)", async () => {
    initJobStore({ executor: executeJob });
    const view = createJob("update_pr", { cwd: "/etc" });
    await flush();

    const after = getJob(view.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toContain("invalid params");
    expect(after?.error).toContain("pr:");
  });
});
