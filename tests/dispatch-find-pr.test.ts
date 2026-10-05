// findOpenPullRequest's GitLab branch: an MR from a fork that shares the branch name must never
// be picked as "the" MR to update. Same stubbed-`glab` pattern as tests/dispatch-revision.test.ts,
// except the stub answers the LIST endpoint with whatever $GLAB_LIST_JSON holds.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findOpenPullRequest, type RepoIdentity } from "../server/jobs/handlers/dispatch-git.ts";

const ID: RepoIdentity = {
  owner: "jkrumm",
  repo: "fixture",
  defaultBranch: "master",
  kind: "gitlab",
};
const BRANCH = "dispatch/mr-eeee5555";

const mr = (iid: number, over: Record<string, unknown> = {}) => ({
  web_url: `https://gitlab.com/jkrumm/fixture/-/merge_requests/${iid}`,
  iid,
  state: "opened",
  source_branch: BRANCH,
  target_branch: "master",
  sha: "0".repeat(40),
  source_project_id: 1,
  target_project_id: 1,
  ...over,
});

describe("findOpenPullRequest (GitLab)", () => {
  let binDir: string;
  let argvLog: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "sideclaw-glab-"));
    argvLog = join(binDir, "argv.log");
    writeFileSync(
      join(binDir, "glab"),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$GLAB_ARGV_LOG"\nprintf \'%s\' "$GLAB_LIST_JSON"\n',
    );
    process.env.GLAB_ARGV_LOG = argvLog;
    chmodSync(join(binDir, "glab"), 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = `${binDir}:${savedPath ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    delete process.env.GLAB_LIST_JSON;
    delete process.env.GLAB_ARGV_LOG;
    rmSync(binDir, { recursive: true, force: true });
  });

  test("skips a fork MR with the same branch name and returns the same-repo one", async () => {
    process.env.GLAB_LIST_JSON = JSON.stringify([mr(7, { source_project_id: 2 }), mr(8)]);
    const found = await findOpenPullRequest(ID, BRANCH);
    expect(found?.number).toBe(8);
    expect(found?.sameRepo).toBe(true);
  });

  test("only a fork MR shares the branch name: null", async () => {
    process.env.GLAB_LIST_JSON = JSON.stringify([mr(7, { source_project_id: 2 })]);
    expect(await findOpenPullRequest(ID, BRANCH)).toBeNull();
  });

  test("an empty list: null", async () => {
    process.env.GLAB_LIST_JSON = "[]";
    expect(await findOpenPullRequest(ID, BRANCH)).toBeNull();
  });

  test("a non-array payload: null", async () => {
    process.env.GLAB_LIST_JSON = JSON.stringify({ message: "404 Not Found" });
    expect(await findOpenPullRequest(ID, BRANCH)).toBeNull();
  });

  test("a malformed entry AFTER the first same-repo match does not hide the match", async () => {
    process.env.GLAB_LIST_JSON = JSON.stringify([mr(8), { not: "an mr" }]);
    const found = await findOpenPullRequest(ID, BRANCH);
    expect(found?.number).toBe(8);
  });

  test("a malformed entry reached before any match still throws", async () => {
    process.env.GLAB_LIST_JSON = JSON.stringify([{ not: "an mr" }, mr(8)]);
    await expect(findOpenPullRequest(ID, BRANCH)).rejects.toThrow();
  });

  test("asks glab for opened MRs of exactly this source branch", async () => {
    process.env.GLAB_LIST_JSON = "[]";
    await findOpenPullRequest(ID, BRANCH);
    const argv = readFileSync(argvLog, "utf-8");
    expect(argv).toContain("state=opened");
    expect(argv).toContain(`source_branch=${encodeURIComponent(BRANCH)}`);
  });
});
