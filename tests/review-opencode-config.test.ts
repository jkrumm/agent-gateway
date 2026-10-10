// Bounds of review's opencode-config handling (Wave 4 open test gaps):
//
//   - `opencodeRepoConfigPresent` (dispatch-git.ts): which of opencode.json / opencode.jsonc /
//     .opencode exist directly under a repo root. Read-only; the caller decides what it means.
//   - scope mode (runReview in the caller's LIVE checkout): never stripped — an opencode-harness
//     angle is instead refused and falls back to the claude `review` route when the repo carries
//     its own opencode config.
//   - ref mode (runReview with `branch`): the angle runs inside a throwaway read worktree, from
//     which `stripProjectSettings` has already removed opencode.json / opencode.jsonc /
//     .opencode before any session starts; the `finally` restores them from the pinned base.
//
// `runSession` is the only stubbed boundary (spyOn on the session-runner namespace — the tool
// route and the on-disk worktree are inspected at call time). Git is real, against the local
// bare-origin fixture; OCR and the adversary critic are switched off via their documented env
// flags, and an explicit `angles` list keeps the router (a network completion) out of the run.
// The fixture's origin is declared as a gitlab.com URL and rewritten to the local bare repo via
// `insteadOf`, so `resolveRepoIdentity`'s GitLab path (ls-remote, no network, no API) resolves.

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { opencodeRepoConfigPresent } from "../server/jobs/handlers/dispatch-git.ts";
import { runReview } from "../server/jobs/handlers/review.ts";
import * as sessionRunner from "../server/mcp/session-runner.ts";
import { routeFor } from "../server/lib/routing.ts";
import { Fixture, git, makeFixture } from "./git-fixture.ts";

// ── opencodeRepoConfigPresent ────────────────────────────────────────────────

describe("opencodeRepoConfigPresent", () => {
  const dirs: string[] = [];
  function tempRoot(): string {
    const d = mkdtempSync(join(tmpdir(), "agent-gateway-ocfg-"));
    dirs.push(d);
    return d;
  }
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("an empty root reports nothing", () => {
    expect(opencodeRepoConfigPresent(tempRoot())).toEqual([]);
  });

  test("reports each of the three paths individually", () => {
    const json = tempRoot();
    writeFileSync(join(json, "opencode.json"), "{}\n");
    expect(opencodeRepoConfigPresent(json)).toEqual(["opencode.json"]);

    const jsonc = tempRoot();
    writeFileSync(join(jsonc, "opencode.jsonc"), "{}\n");
    expect(opencodeRepoConfigPresent(jsonc)).toEqual(["opencode.jsonc"]);

    const dir = tempRoot();
    mkdirSync(join(dir, ".opencode"));
    expect(opencodeRepoConfigPresent(dir)).toEqual([".opencode"]);
  });

  test("reports all present paths in declaration order", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".opencode"));
    writeFileSync(join(root, "opencode.jsonc"), "{}\n");
    writeFileSync(join(root, "opencode.json"), "{}\n");
    expect(opencodeRepoConfigPresent(root)).toEqual([
      "opencode.json",
      "opencode.jsonc",
      ".opencode",
    ]);
  });

  test("only looks directly under the root, not in subdirectories", () => {
    const root = tempRoot();
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "opencode.json"), "{}\n");
    mkdirSync(join(root, "sub", ".opencode"));
    expect(opencodeRepoConfigPresent(root)).toEqual([]);
  });
});

// ── runReview wiring ─────────────────────────────────────────────────────────

interface SeenSession {
  tool: string;
  cwd: string;
  harness: string;
  /** Which opencode config paths existed under the session's cwd at call time. */
  configAtCall: string[];
}

const SYNTHESIS = {
  outcome: "clean",
  blocking: [],
  improvements: [],
  discussions: [],
  testGaps: [],
  summary: "stub",
};

let fx: Fixture;
let seen: SeenSession[];
let sessionSpy: ReturnType<typeof spyOn> | undefined;
// Per-angle-session scripted responses, consumed in call order. Empty = every angle
// session succeeds. Lets a test drive the pipeline's one-shot angle retry without
// reaching into runSession's internals.
let angleResponses: Array<{ ok: boolean; error?: string }> = [];
const savedEnv: Record<string, string | undefined> = {};

function installSessionStub(): void {
  sessionSpy = spyOn(sessionRunner, "runSession").mockImplementation((async (
    opts: sessionRunner.SessionOptions<unknown>,
  ) => {
    seen.push({
      tool: opts.tool ?? "",
      cwd: opts.cwd,
      harness: opts.route.harness ?? "claude",
      configAtCall: opencodeRepoConfigPresent(opts.cwd),
    });
    if (opts.tool === "review:synthesis") return { ok: true, data: structuredClone(SYNTHESIS) };
    // The floor always includes architect (claude route); script only the opencode-route
    // angle (senior-dev), so the response queue cannot be consumed by architect.
    if (opts.tool === "review:angle" && (opts.route.harness ?? "claude") === "opencode") {
      const scripted = angleResponses.shift();
      if (scripted && !scripted.ok) return { ok: false, error: scripted.error };
    }
    return { ok: true, data: { findings: [] } };
  }) as unknown as typeof sessionRunner.runSession);
}

beforeEach(async () => {
  for (const k of [
    "AGENT_GATEWAY_REVIEW_OCR",
    "AGENT_GATEWAY_REVIEW_ADVERSARY",
    "AGENT_GATEWAY_REVIEW_CODERABBIT",
  ])
    savedEnv[k] = process.env[k];
  process.env.AGENT_GATEWAY_REVIEW_OCR = "0";
  process.env.AGENT_GATEWAY_REVIEW_CODERABBIT = "0";
  process.env.AGENT_GATEWAY_REVIEW_ADVERSARY = "false";
  seen = [];
  angleResponses = [];
  fx = await makeFixture();
  installSessionStub();
});

afterEach(() => {
  sessionSpy?.mockRestore();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fx.cleanup();
});

function angleSessions(): SeenSession[] {
  return seen.filter((s) => s.tool === "review:angle");
}

/** The opencode-route angle (senior-dev) — the one the retry tests script. The floor's
 *  architect angle always runs too, on the claude route. */
function opencodeAngleSessions(): SeenSession[] {
  return angleSessions().filter((s) => s.harness === "opencode");
}

describe("runReview scope mode — live checkout is never stripped", () => {
  test("senior-dev stays on the opencode route when the repo carries no opencode config", async () => {
    fx.write("src/app.ts", "export const changed = 1;\n");

    await runReview({ cwd: fx.repo, scope: "uncommitted", angles: ["senior-dev"] });

    // Guards the premise of the tests below: this angle's default route IS opencode.
    expect(routeFor("review").harness ?? "claude").toBe("claude");
    const harnesses = angleSessions().map((s) => s.harness);
    expect(harnesses).toContain("opencode");
  });

  test.each([
    ["opencode.json", () => fx.write("opencode.json", "{}\n")],
    ["opencode.jsonc", () => fx.write("opencode.jsonc", "{}\n")],
    [".opencode/", () => fx.write(".opencode/plugin.js", "export default {};\n")],
  ])(
    "%s in the live root forces every angle onto the claude route and is left in place",
    async (_name, plant) => {
      plant();
      fx.write("src/app.ts", "export const changed = 1;\n");

      await runReview({ cwd: fx.repo, scope: "uncommitted", angles: ["senior-dev"] });

      const angles = angleSessions();
      expect(angles.length).toBeGreaterThan(0);
      expect(angles.every((s) => s.harness === "claude")).toBe(true);
      // Sessions still run in the caller's own checkout, and nothing was deleted from it.
      expect(angles.every((s) => s.cwd === fx.repo)).toBe(true);
      expect(opencodeRepoConfigPresent(fx.repo)).not.toEqual([]);
    },
  );
});

describe("runReview ref mode — opencode config stripped from the throwaway worktree", () => {
  async function pushFeatureBranch(): Promise<void> {
    // GitLab-shaped declared url, rewritten to the local bare origin for transport.
    const declared = "https://gitlab.com/test/fixture.git";
    await git(["config", "remote.origin.url", declared], fx.repo);
    await git(["config", `url.${fx.origin}.insteadOf`, declared], fx.repo);

    await git(["checkout", "-q", "-b", "feature-oc"], fx.repo);
    fx.write("opencode.json", "{}\n");
    fx.write("opencode.jsonc", "{}\n");
    fx.write(".opencode/plugin.js", "export default {};\n");
    fx.write("src/feature.ts", "export const feature = true;\n");
    await fx.commit("feature with opencode config");
    await git(["push", "-q", "origin", "feature-oc"], fx.repo);
    await git(["checkout", "-q", "master"], fx.repo);
  }

  test("no opencode.json / .opencode in the cwd of any session; the opencode route is kept", async () => {
    await pushFeatureBranch();

    await runReview({ cwd: fx.repo, branch: "feature-oc", angles: ["senior-dev"] });

    const angles = angleSessions();
    expect(angles.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.cwd).not.toBe(fx.repo);
      expect(s.configAtCall).toEqual([]);
    }
    // Stripped worktree, so the opencode route is safe and is NOT downgraded to claude.
    expect(angles.some((s) => s.harness === "opencode")).toBe(true);
  });

  test("the live checkout is untouched and the worktree and fetch ref are torn down", async () => {
    await pushFeatureBranch();

    await runReview({ cwd: fx.repo, branch: "feature-oc", angles: ["senior-dev"] });

    expect(await fx.linkedWorktrees()).toEqual([]);
    const refs = await git(
      ["for-each-ref", "--format=%(refname)", "refs/agent-gateway-review"],
      fx.repo,
    );
    expect(refs.trim()).toBe("");
    // master never had the config; ref mode must not have created any in the live root.
    expect(existsSync(join(fx.repo, "opencode.json"))).toBe(false);
    expect(existsSync(join(fx.repo, ".opencode"))).toBe(false);
  });
});

// ── one-shot angle retry ─────────────────────────────────────────────────────
//
// A single angle failure must not escalate the whole review: the pipeline re-runs a
// failed angle once (the failure session-runner itself won't retry — e.g. an
// idle-watchdog kill on the claude/Max route), and only a second failure stands.

describe("runReview angle retry", () => {
  test("a failed angle session is retried once", async () => {
    fx.write("src/app.ts", "export const changed = 1;\n");
    angleResponses = [{ ok: false, error: "Session timed out after 300000ms of inactivity" }];

    const result = await runReview({ cwd: fx.repo, scope: "uncommitted", angles: ["senior-dev"] });

    expect(opencodeAngleSessions().length).toBe(2);
    expect(result.outcome).toBe("clean");
  });

  test("an angle that fails twice stays failed and forces needs-human/blocker", async () => {
    fx.write("src/app.ts", "export const changed = 1;\n");
    angleResponses = [
      { ok: false, error: "Session timed out after 300000ms of inactivity" },
      { ok: false, error: "Session timed out after 300000ms of inactivity" },
    ];

    const result = await runReview({ cwd: fx.repo, scope: "uncommitted", angles: ["senior-dev"] });

    expect(opencodeAngleSessions().length).toBe(2);
    expect(result.outcome).toBe("needs-human");
    expect(result.escalationCategory).toBe("blocker");
  });

  test("a successful angle session is never re-run", async () => {
    fx.write("src/app.ts", "export const changed = 1;\n");

    const result = await runReview({ cwd: fx.repo, scope: "uncommitted", angles: ["senior-dev"] });

    expect(opencodeAngleSessions().length).toBe(1);
    expect(result.outcome).toBe("clean");
  });
});
