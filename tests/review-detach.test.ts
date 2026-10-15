// `review` under a drain that detaches an angle's OpenCode session (server/jobs/handlers/review.ts):
// the detach is NOT an angle failure — it does not consume the one-shot angle retry, does not
// produce a needs-human verdict and does not reach synthesis; it unwinds the pipeline so the job
// is left for the next boot. A ref-mode review keeps the throwaway worktree its detached
// sessions are still reading and the re-run reopens it instead of cutting a new one. Every angle
// and the synthesis session carry a stable `reattachKey` so the re-run re-attaches through the
// session ledger (tests/opencode-reattach-ledger.test.ts covers the ledger itself).
//
// Same boundary as tests/review-opencode-config.test.ts: `runSession` is the only stub, git is real.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { runReview } from "../server/jobs/handlers/review.ts";
import type { DispatchWorktree } from "../server/jobs/handlers/dispatch-git.ts";
import * as sessionRunner from "../server/mcp/session-runner.ts";
import { Fixture, git, makeFixture } from "./git-fixture.ts";

const SYNTHESIS = {
  outcome: "clean",
  blocking: [],
  improvements: [],
  discussions: [],
  testGaps: [],
  summary: "stub",
};

interface Seen {
  tool: string;
  cwd: string;
  harness: string;
  reattachKey: string | undefined;
}

let fx: Fixture;
let seen: Seen[];
let detachNext: boolean;
let sessionSpy: ReturnType<typeof spyOn> | undefined;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ["AGENT_GATEWAY_REVIEW_OCR", "AGENT_GATEWAY_REVIEW_ADVERSARY"])
    savedEnv[k] = process.env[k];
  process.env.AGENT_GATEWAY_REVIEW_OCR = "0";
  process.env.AGENT_GATEWAY_REVIEW_ADVERSARY = "false";
  seen = [];
  detachNext = true;
  fx = await makeFixture();
  sessionSpy = spyOn(sessionRunner, "runSession").mockImplementation((async (
    opts: sessionRunner.SessionOptions<unknown>,
  ) => {
    const harness = opts.route.harness ?? "claude";
    seen.push({ tool: opts.tool ?? "", cwd: opts.cwd, harness, reattachKey: opts.reattachKey });
    if (opts.tool === "review:synthesis") return { ok: true, data: structuredClone(SYNTHESIS) };
    if (opts.tool === "review:angle" && harness === "opencode" && detachNext) {
      detachNext = false;
      throw new sessionRunner.SessionDetachedError(opts.jobId);
    }
    return { ok: true, data: { findings: [] } };
  }) as unknown as typeof sessionRunner.runSession);
});

afterEach(() => {
  sessionSpy?.mockRestore();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fx.cleanup();
});

const opencodeAngles = () =>
  seen.filter((s) => s.tool === "review:angle" && s.harness === "opencode");

describe("runReview — a drain detaches an angle session", () => {
  test("rejects with SessionDetachedError: no angle retry, no synthesis, no needs-human verdict", async () => {
    fx.write("src/app.ts", "export const changed = 1;\n");

    await expect(
      runReview({ cwd: fx.repo, scope: "uncommitted", angles: ["senior-dev"] }, undefined, "job-1"),
    ).rejects.toBeInstanceOf(sessionRunner.SessionDetachedError);

    // ANGLE_MAX_ATTEMPTS is 2: a detach must not look like a failed first attempt, so no
    // angle (senior-dev, plus the floor's architect on the same route) is started twice.
    const keys = opencodeAngles().map((s) => s.reattachKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("angle:senior-dev");
    expect(seen.some((s) => s.tool === "review:synthesis")).toBe(false);
  });

  test("sibling angle sessions in flight are awaited, not left running unobserved behind the rejection", async () => {
    fx.write("src/app.ts", "export const changed = 1;\n");
    const finished: string[] = [];
    sessionSpy?.mockImplementation((async (opts: sessionRunner.SessionOptions<unknown>) => {
      // Only senior-dev's session detaches; its sibling angles (frontend, the floor's
      // architect — all on opencode) keep working for a while.
      if (opts.tool === "review:angle" && opts.reattachKey === "angle:senior-dev") {
        throw new sessionRunner.SessionDetachedError(opts.jobId);
      }
      await Bun.sleep(150);
      finished.push(opts.reattachKey ?? opts.tool ?? "");
      return { ok: true, data: { findings: [] } };
    }) as unknown as typeof sessionRunner.runSession);

    await expect(
      runReview({ cwd: fx.repo, scope: "uncommitted", angles: ["senior-dev", "frontend"] }),
    ).rejects.toBeInstanceOf(sessionRunner.SessionDetachedError);

    // By the time the review rejects, the sibling has settled — nothing runs on unobserved.
    expect(finished).toContain("angle:frontend");
  });

  test("every angle session carries a stable ledger key", async () => {
    fx.write("src/app.ts", "export const changed = 1;\n");
    detachNext = false;

    await runReview({ cwd: fx.repo, scope: "uncommitted", angles: ["senior-dev"] });

    const angles = seen.filter((s) => s.tool === "review:angle");
    expect(angles.length).toBeGreaterThan(1); // the floor's architect plus senior-dev
    for (const s of angles) expect(s.reattachKey).toMatch(/^angle:[a-z-]+$/);
    expect(angles.some((s) => s.reattachKey === "angle:senior-dev")).toBe(true);
    expect(seen.find((s) => s.tool === "review:synthesis")?.reattachKey).toBe("synthesis");
  });

  test("a detach in scope mode touches no worktree (there is none) and leaves the live checkout alone", async () => {
    fx.write("src/app.ts", "export const changed = 1;\n");
    await expect(
      runReview({ cwd: fx.repo, scope: "uncommitted", angles: ["senior-dev"] }),
    ).rejects.toBeInstanceOf(sessionRunner.SessionDetachedError);
    expect(await fx.linkedWorktrees()).toEqual([]);
  });
});

describe("runReview ref mode — the worktree outlives a detach", () => {
  async function pushFeatureBranch(): Promise<void> {
    const declared = "https://gitlab.com/test/fixture.git";
    await git(["config", "remote.origin.url", declared], fx.repo);
    await git(["config", `url.${fx.origin}.insteadOf`, declared], fx.repo);
    await git(["checkout", "-q", "-b", "feature-detach"], fx.repo);
    fx.write("opencode.json", "{}\n");
    fx.write("src/feature.ts", "export const feature = true;\n");
    await fx.commit("feature");
    await git(["push", "-q", "origin", "feature-detach"], fx.repo);
    await git(["checkout", "-q", "master"], fx.repo);
  }

  test("detach keeps the worktree (config still stripped), reports it, and cleans the fetch ref; the re-run reopens it", async () => {
    await pushFeatureBranch();
    const persisted: DispatchWorktree[] = [];

    await expect(
      runReview(
        { cwd: fx.repo, branch: "feature-detach", angles: ["senior-dev"] },
        undefined,
        "job-ref-1",
        undefined,
        { onWorktreeReady: (meta) => persisted.push(meta) },
      ),
    ).rejects.toBeInstanceOf(sessionRunner.SessionDetachedError);

    // The detached session is still reading this directory: it must be exactly where it was.
    expect(persisted).toHaveLength(1);
    const kept = persisted[0] as DispatchWorktree;
    expect(existsSync(kept.path)).toBe(true);
    expect(await fx.linkedWorktrees()).toHaveLength(1);
    expect(existsSync(join(kept.path, "opencode.json"))).toBe(false); // restore waits for the re-run
    const refs = await git(
      ["for-each-ref", "--format=%(refname)", "refs/agent-gateway-review"],
      fx.repo,
    );
    expect(refs.trim()).toBe("");

    // Boot: the persisted meta (a JSON round trip, as through jobs.worktree_meta) is reopened —
    // no new worktree, the sessions run in the same directory, and at the end the worktree goes
    // and the stripped file is restored before teardown.
    seen = [];
    const result = await runReview(
      { cwd: fx.repo, branch: "feature-detach", angles: ["senior-dev"] },
      undefined,
      "job-ref-1",
      undefined,
      { worktreeMeta: JSON.parse(JSON.stringify(kept)), onWorktreeReady: () => {} },
    );

    expect(result.outcome).toBe("clean");
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.cwd).toBe(kept.path);
    expect(existsSync(kept.path)).toBe(false);
    expect(await fx.linkedWorktrees()).toEqual([]);
  });

  test("a persisted worktree that is gone from disk is not trusted: a fresh one is cut", async () => {
    await pushFeatureBranch();
    detachNext = false;
    const result = await runReview(
      { cwd: fx.repo, branch: "feature-detach", angles: ["senior-dev"] },
      undefined,
      "job-ref-2",
      undefined,
      {
        worktreeMeta: {
          path: join(fx.worktrees, "vanished"),
          branch: "dispatch/read-vanished",
          base: "abc",
          baseRef: "abc",
          pushable: false,
        },
      },
    );
    expect(result.outcome).toBe("clean");
    for (const s of seen) expect(s.cwd).not.toContain("vanished");
  });
});
