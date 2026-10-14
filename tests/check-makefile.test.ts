// The deterministic `make check` path: when the repo root Makefile declares a real `check:`
// target and the caller passed no `commands`, `runCheck` runs it verbatim as one step (no model
// session) instead of loading the discovery skill. Detection is pure; the run is exercised
// against throwaway Makefiles in a tmp dir with `runSession` spied on, so "no model call" is
// asserted rather than assumed.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makefileDeclaresCheck, runCheck } from "../server/jobs/handlers/check.ts";
import * as sessionRunner from "../server/mcp/session-runner.ts";

describe("makefileDeclaresCheck", () => {
  test("a real check: target is detected", () => {
    expect(makefileDeclaresCheck("check:\n\tbun test\n")).toBe(true);
  });

  test("spaces before the colon still count", () => {
    expect(makefileDeclaresCheck("check :\n\tbun test\n")).toBe(true);
  });

  test("a different target is not a match", () => {
    expect(makefileDeclaresCheck("test:\n\tpytest -q\n")).toBe(false);
  });

  test("a precheck: substring is not a match", () => {
    expect(makefileDeclaresCheck("precheck:\n\t./pre.sh\n")).toBe(false);
  });

  test("check-all: is a different target, not a match", () => {
    expect(makefileDeclaresCheck("check-all:\n\tbun test\n")).toBe(false);
  });

  test("a .PHONY declaration alone is not a target", () => {
    expect(makefileDeclaresCheck(".PHONY: check\n")).toBe(false);
  });

  test("a commented-out check: is not a match", () => {
    expect(makefileDeclaresCheck("# check:\n#\tbun test\n")).toBe(false);
  });

  test("an empty Makefile is not a match", () => {
    expect(makefileDeclaresCheck("")).toBe(false);
  });
});

const CANNED = { passed: true, steps: [], summary: "canned" };

let cwd: string;
let spy: ReturnType<typeof spyOn> | undefined;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "agw-check-"));
});

afterEach(async () => {
  spy?.mockRestore();
  await rm(cwd, { recursive: true, force: true });
});

function spyOnSession(): ReturnType<typeof spyOn> {
  spy = spyOn(sessionRunner, "runSession").mockImplementation((async () => ({
    ok: true,
    data: CANNED,
  })) as unknown as typeof sessionRunner.runSession);
  return spy;
}

describe("runCheck — deterministic make check path", () => {
  test("a repo Makefile with check: runs it with no model session", async () => {
    await writeFile(join(cwd, "Makefile"), "check:\n\t@echo ran-make-check\n");
    const runSessionSpy = spyOnSession();

    const out = await runCheck({ cwd });

    expect(runSessionSpy).not.toHaveBeenCalled();
    expect(out.passed).toBe(true);
    expect(out.steps).toEqual([{ name: "check", passed: true }]);
    expect(out.summary).toBe("make check passed");
  });

  test("a failing check: target reports the exit and the output tail", async () => {
    await writeFile(join(cwd, "Makefile"), "check:\n\t@echo boom-line >&2; exit 3\n");
    const runSessionSpy = spyOnSession();

    const out = await runCheck({ cwd });

    expect(runSessionSpy).not.toHaveBeenCalled();
    expect(out.passed).toBe(false);
    expect(out.summary).toContain("make check failed");
    expect(out.steps[0]?.name).toBe("check");
    expect(out.steps[0]?.errors?.some((e) => e.includes("boom-line"))).toBe(true);
  });

  test("no check: target falls through to the skill path (a model session)", async () => {
    await writeFile(join(cwd, "Makefile"), "test:\n\t@pytest -q\n");
    const runSessionSpy = spyOnSession();

    const out = await runCheck({ cwd });

    expect(runSessionSpy).toHaveBeenCalledTimes(1);
    expect(out.summary).toBe("canned");
  });

  test("with fallow installed and a git remote, fallow audit runs after make check", async () => {
    await writeFile(join(cwd, "Makefile"), "check:\n\t@echo ran-make-check\n");
    await Bun.$`git init -q && git remote add origin https://example.com/r.git`.cwd(cwd).quiet();
    const bin = join(cwd, "bin");
    await Bun.$`mkdir -p ${bin}`.quiet();
    await writeFile(join(bin, "fallow"), "#!/bin/sh\necho fail-verdict >&2\nexit 1\n", {
      mode: 0o755,
    });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    const runSessionSpy = spyOnSession();
    try {
      const out = await runCheck({ cwd });

      expect(runSessionSpy).not.toHaveBeenCalled();
      expect(out.passed).toBe(false);
      expect(out.steps.map((s) => s.name)).toEqual(["check", "fallow"]);
      expect(out.steps[0]?.passed).toBe(true);
      expect(out.steps[1]?.errors?.some((e) => e.includes("fail-verdict"))).toBe(true);
      expect(out.summary).toBe("make check passed; fallow audit --quiet failed (exit 1)");
    } finally {
      process.env.PATH = path;
    }
  });

  test("without a git remote, fallow is skipped even when installed", async () => {
    await writeFile(join(cwd, "Makefile"), "check:\n\t@echo ran-make-check\n");
    const bin = join(cwd, "bin");
    await Bun.$`mkdir -p ${bin}`.quiet();
    await writeFile(join(bin, "fallow"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    spyOnSession();
    try {
      const out = await runCheck({ cwd });

      expect(out.passed).toBe(true);
      expect(out.steps).toEqual([{ name: "check", passed: true }]);
    } finally {
      process.env.PATH = path;
    }
  });

  test("an explicit commands param beats the Makefile check target", async () => {
    await writeFile(join(cwd, "Makefile"), "check:\n\t@echo should-not-run\n");
    const runSessionSpy = spyOnSession();

    const out = await runCheck({ cwd, commands: ["true"] });

    expect(runSessionSpy).toHaveBeenCalledTimes(1);
    expect(out.summary).toBe("canned");
  });
});
