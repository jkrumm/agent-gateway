// Only a `check` JOB hands its OpenCode session back (executor.ts passes the ledger key). A check
// run on behalf of another job — dispatch's pre-push check, `update_pr`'s rebase check — has no
// way to re-attach it, so its session carries no key and a drain waits for it instead.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "../server/jobs/handlers/check.ts";
import * as sessionRunner from "../server/mcp/session-runner.ts";

let dir: string;
let spy: ReturnType<typeof spyOn>;
let keys: Array<string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agw-check-key-"));
  keys = [];
  spy = spyOn(sessionRunner, "runSession").mockImplementation((async (
    opts: sessionRunner.SessionOptions<unknown>,
  ) => {
    keys.push(opts.reattachKey);
    return {
      ok: true,
      data: { passed: true, steps: [], summary: "stub" },
      backend: "iu",
      model: "m",
    };
  }) as unknown as typeof sessionRunner.runSession);
});

afterEach(() => {
  spy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

describe("runCheck — ledger key", () => {
  test("a check job passes the key it was given", async () => {
    await runCheck({ cwd: dir, commands: ["true"] }, undefined, "job-1", undefined, "check");
    expect(keys).toEqual(["check"]);
  });

  test("a check run for another job passes none: its session is not detachable", async () => {
    await runCheck({ cwd: dir, commands: ["true"] }, undefined, "job-1", undefined);
    expect(keys).toEqual([undefined]);
  });
});
