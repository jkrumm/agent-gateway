// runNarrativeWorker (server/jobs/handlers/narrative.ts): ONE retry on any worker failure with no
// data — the JSON-only directive for rejected output, the same prompt after a backoff for a
// session failure. The worker call and the sleep are injected; no session is spawned.

import { describe, expect, test } from "bun:test";
import {
  runNarrativeWorker,
  type NarrativeWorkerOutput,
} from "../server/jobs/handlers/narrative.ts";
import type { SessionResult } from "../server/mcp/session-runner.ts";
import { JSON_ONLY_RETRY } from "../server/lib/worker-io.ts";

// ── runNarrativeWorker — the single retry ───────────────────────────────────────

describe("runNarrativeWorker", () => {
  const data = { changed: false, reason: "nothing to say" } as NarrativeWorkerOutput;
  const okResult: SessionResult<NarrativeWorkerOutput> = { ok: true, data };
  const exitFail: SessionResult<NarrativeWorkerOutput> = {
    ok: false,
    error: "Session exited with code 1",
    backend: "max",
  };
  const noSleep = async () => undefined;

  function scripted(results: SessionResult<NarrativeWorkerOutput>[]) {
    const prompts: string[] = [];
    const run = async (p: string) => {
      prompts.push(p);
      return results[Math.min(prompts.length - 1, results.length - 1)]!;
    };
    return { run, prompts };
  }

  test("a first success is returned without a retry", async () => {
    const { run, prompts } = scripted([okResult]);
    const r = await runNarrativeWorker(run, "P", "proj", noSleep);
    expect(r.ok).toBe(true);
    expect(prompts).toEqual(["P"]);
  });

  test("a session failure is retried once with the SAME prompt after a backoff", async () => {
    const { run, prompts } = scripted([exitFail, okResult]);
    const sleeps: number[] = [];
    const r = await runNarrativeWorker(run, "P", "proj", async (ms) => void sleeps.push(ms));
    expect(r.ok).toBe(true);
    expect(prompts).toEqual(["P", "P"]);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeLessThanOrEqual(2000);
  });

  test("rejected output is retried once with the JSON-only directive, no backoff", async () => {
    const rejected: SessionResult<NarrativeWorkerOutput> = {
      ok: false,
      error: "output did not match schema",
      noOutput: true,
    };
    const { run, prompts } = scripted([rejected, okResult]);
    let slept = false;
    const r = await runNarrativeWorker(run, "P", "proj", async () => void (slept = true));
    expect(r.ok).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBe("P" + JSON_ONLY_RETRY);
    expect(slept).toBe(false);
  });

  test("never a second retry: two failures return the retry's result, carrying the first cause", async () => {
    const second: SessionResult<NarrativeWorkerOutput> = {
      ...exitFail,
      error: "IU 503: overloaded",
    };
    const { run, prompts } = scripted([exitFail, second]);
    const r = await runNarrativeWorker(run, "P", "proj", noSleep);
    expect(prompts).toHaveLength(2);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("IU 503: overloaded (first attempt: Session exited with code 1)");
  });

  test("an identical second error is not duplicated", async () => {
    const { run } = scripted([exitFail, exitFail]);
    const r = await runNarrativeWorker(run, "P", "proj", noSleep);
    expect(r.error).toBe("Session exited with code 1");
  });
});
