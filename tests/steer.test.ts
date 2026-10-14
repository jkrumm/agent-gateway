// `steerJob` over the in-memory OpenCode client and the real job store (executor held open so
// the job stays `running`): only a running dispatch with a live OpenCode session can be steered,
// and the text goes in as a `steer` prompt.

import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetForTests,
  createJob,
  initJobStore,
  updateJobSessionId,
} from "../server/jobs/store.ts";
import { steerJob, STEER_MAX_CHARS } from "../server/lib/steer.ts";
import { FakeOpencodeClient, text } from "./helpers/fake-opencode-client.ts";

afterEach(() => {
  __resetForTests();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

/** A running job whose executor never settles. */
async function runningJob(tool: "dispatch" | "check"): Promise<string> {
  initJobStore({ executor: () => new Promise(() => {}) });
  const job = createJob(tool, {});
  await flush();
  return job.id;
}

describe("steerJob", () => {
  test("rejects empty and oversized text before touching anything", async () => {
    const client = new FakeOpencodeClient();
    expect(await steerJob("x", "   ", client)).toMatchObject({ ok: false, status: 400 });
    expect(await steerJob("x", "a".repeat(STEER_MAX_CHARS + 1), client)).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  test("unknown job is 404", async () => {
    expect(await steerJob("nope", "hi", new FakeOpencodeClient())).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  test("only a dispatch can be steered", async () => {
    const id = await runningJob("check");
    expect(await steerJob(id, "hi", new FakeOpencodeClient())).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  test("a dispatch without an OpenCode session id (not started, or claude harness) is 409", async () => {
    const id = await runningJob("dispatch");
    expect(await steerJob(id, "hi", new FakeOpencodeClient())).toMatchObject({
      ok: false,
      status: 409,
    });
    updateJobSessionId(id, "8f2c1c1e-0000-4000-8000-000000000000");
    expect(await steerJob(id, "hi", new FakeOpencodeClient())).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  test("a session between turns is 409; a running one gets a steer prompt", async () => {
    const id = await runningJob("dispatch");
    updateJobSessionId(id, "ses_live");
    const client = new FakeOpencodeClient();
    const session = client.seed("ses_live", []);
    expect(await steerJob(id, "CI is red: fix lint", client)).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(client.prompts).toEqual([]);

    session.turn = { assistant: [{ content: [text("done")] }] };
    const result = await steerJob(id, "CI is red: fix lint", client);
    expect(result).toEqual({ ok: true, sessionId: "ses_live" });
    expect(client.prompts).toHaveLength(1);
    expect(client.prompts[0]).toMatchObject({
      sessionId: "ses_live",
      input: { delivery: "steer" },
    });
    expect(client.prompts[0]?.input.text).toContain("CI is red: fix lint");
  });

  test("a transport failure is a 502, not a throw", async () => {
    const id = await runningJob("dispatch");
    updateJobSessionId(id, "ses_live");
    const client = new FakeOpencodeClient();
    client.seed("ses_live", []).turn = {};
    client.promptError = new Error("opencode server unreachable: ECONNREFUSED");
    expect(await steerJob(id, "hi", client)).toMatchObject({ ok: false, status: 502 });
  });
});
