// The deterministic `make check` path: when the repo root Makefile declares a real `check:`
// target and the caller passed no `commands`, `runCheck` runs it verbatim as one step (no model
// session) instead of loading the discovery skill. Detection is pure; the run is exercised
// against throwaway Makefiles in a tmp dir with `runSession` spied on, so "no model call" is
// asserted rather than assumed.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makefileDeclaresCheck, runCheck } from "../server/jobs/handlers/check.ts";
import * as sessionRunner from "../server/mcp/session-runner.ts";
import { SessionCancelledError } from "../server/mcp/session-runner.ts";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

  test("an immediate-assignment `check :=` is not a target", () => {
    expect(makefileDeclaresCheck("check := 1\n")).toBe(false);
  });

  test("a POSIX-assignment `check ::=` is not a target", () => {
    expect(makefileDeclaresCheck("check ::= foo\n")).toBe(false);
  });

  test("`check::=` with no spaces is not a target", () => {
    expect(makefileDeclaresCheck("check::=foo\n")).toBe(false);
  });

  test("the `check :::=` assignment operator is not a target", () => {
    expect(makefileDeclaresCheck("check :::= foo\n")).toBe(false);
  });

  test("a `check :=` line inside a define…endef block is not a target", () => {
    expect(makefileDeclaresCheck("define rules\ncheck := 1\nendef\n")).toBe(false);
  });

  test("a `define check:` block declares no target `check`", () => {
    expect(makefileDeclaresCheck("define check:\n\t@echo hi\nendef\n")).toBe(false);
  });

  test("a double-colon `check::` rule IS a real target", () => {
    expect(makefileDeclaresCheck("check::\n\t@echo hi\n")).toBe(true);
  });

  test("a target-specific variable after the colon is still a target", () => {
    expect(makefileDeclaresCheck("check: CFLAGS += -g\n\t@echo hi\n")).toBe(true);
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

describe("runStep — child environment", () => {
  test("a recipe's $(PWD) is the step's cwd, not the server's stale PWD", async () => {
    // `Bun.spawn`'s cwd does not update `PWD`; without the pin a recipe reading `$(PWD)` would
    // validate the server's own checkout instead of the worktree (a false green).
    const outFile = join(cwd, "pwd.txt");
    await writeFile(join(cwd, "Makefile"), `check:\n\t@echo $(PWD) > ${outFile}\n`);
    spyOnSession();

    const out = await runCheck({ cwd });

    expect(out.passed).toBe(true);
    expect(readFileSync(outFile, "utf8").trim()).toBe(cwd);
  });
});

describe("runStep — process-group cleanup and cancellation", () => {
  test("a check: target that backgrounds a stdout-inheriting process cannot hang the step", async () => {
    // `sleep 300 &` is reparented away from `make`, and it inherits the stdout pipe — so the
    // step used to hang forever once `make` itself exited. The whole process group must be
    // killed, and the step must still report `make`'s own (successful) exit.
    const pidFile = join(cwd, "child.pid");
    await writeFile(
      join(cwd, "Makefile"),
      `check:\n\t@sleep 300 & echo $$! > ${pidFile}\n\t@echo done\n`,
    );
    spyOnSession();

    const started = Date.now();
    const out = await runCheck({ cwd });

    expect(out.passed).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(Number.isInteger(pid)).toBe(true);
    expect(pidAlive(pid)).toBe(false);
  }, 30_000);

  test("a check killed by a signal this step never sent rejects, not reports a failed step", async () => {
    // Stands in for an external kill (`job_cancel`'s `terminateSessionsForJob` / a drain's
    // `terminateActiveSessions`), which lands faster than the watchdog's 5s poll.
    await writeFile(join(cwd, "Makefile"), "check:\n\t@kill -TERM $$PPID\n");
    spyOnSession();

    await expect(runCheck({ cwd })).rejects.toBeInstanceOf(SessionCancelledError);
  }, 20_000);

  test("a cancel observed only after the process exits still rejects", async () => {
    // The process exits 0 before the watchdog's first 5s tick can set `cancelled`, so only the
    // post-exit re-check sees the cancel; without it the job would be persisted `done`.
    await writeFile(join(cwd, "Makefile"), "check:\n\t@echo ok\n");
    spyOnSession();

    await expect(runCheck({ cwd }, undefined, "job-1", () => true)).rejects.toBeInstanceOf(
      SessionCancelledError,
    );
  }, 20_000);
});
