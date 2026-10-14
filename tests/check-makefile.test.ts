// The deterministic `make check` path: when the repo root Makefile declares a `check:` target
// that Make itself registers, and the caller passed no `commands`, `runCheck` runs it verbatim as
// one step (no model session) instead of loading the discovery skill. Detection parses
// `make -p -q`'s database; the run is exercised against throwaway Makefiles in a tmp dir with `runSession`
// spied on, so "no model call" is asserted rather than assumed.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasMakeCheckTarget, runCheck } from "../server/jobs/handlers/check.ts";
import * as sessionRunner from "../server/mcp/session-runner.ts";
import {
  SessionCancelledError,
  terminateSessionsForJob,
  trackExternalProc,
} from "../server/mcp/session-runner.ts";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("hasMakeCheckTarget — parses `make -p` for a registered check target", () => {
  // Detection delegates to `make -p`'s database dump rather than `make -q check`'s exit code:
  // exit 0 also fires for a file/dir named `check` (or a recipe-less `check:` target), exit 1
  // for a catch-all `%:` pattern rule, and exit 2 both for "No rule to make target 'check'" and
  // for a genuine `check:` target whose prerequisite has no rule — so no exit code cleanly means
  // "real target". The dump lists registered rules in its `# Files` section (non-targets marked
  // `# Not a target:`), so a `check:`-shaped line inside a `define … endef` block or a disabled
  // conditional — text, not a rule — is correctly rejected where the old regex matched it and
  // produced a false red.
  async function declares(makefile: string): Promise<boolean> {
    await writeFile(join(cwd, "Makefile"), makefile);
    return hasMakeCheckTarget(cwd);
  }

  test("a real check: target is detected", async () => {
    expect(await declares("check:\n\t@echo hi\n")).toBe(true);
  });

  test("spaces before the colon still count", async () => {
    expect(await declares("check :\n\t@echo hi\n")).toBe(true);
  });

  test("a different target is not a match", async () => {
    expect(await declares("test:\n\tpytest -q\n")).toBe(false);
  });

  test("a precheck: substring is not a match", async () => {
    expect(await declares("precheck:\n\t./pre.sh\n")).toBe(false);
  });

  test("check-all: is a different target, not a match", async () => {
    expect(await declares("check-all:\n\tbun test\n")).toBe(false);
  });

  test("an empty Makefile is not a match", async () => {
    expect(await declares("")).toBe(false);
  });

  test("a double-colon `check::` rule IS a real target", async () => {
    expect(await declares("check::\n\t@echo hi\n")).toBe(true);
  });

  test("a `check:` line inside a define…endef block registers no target", async () => {
    // Regression for the reviewed false red: the value text matches a column-0 `check:`, but
    // Make reads it as a variable value, not a rule, so `make check` fails with "No rule to
    // make target 'check'".
    expect(await declares("define UNUSED\ncheck:\n\t@echo hi\nendef\nall:\n\t@echo x\n")).toBe(
      false,
    );
  });

  test("a `check:` line inside a disabled conditional registers no target", async () => {
    // Same regression through the conditional path: `check:` is only a rule when $(FOO) is "1".
    expect(await declares("ifeq ($(FOO),1)\ncheck:\n\t@echo hi\nendif\nall:\n\t@echo x\n")).toBe(
      false,
    );
  });

  test("a `check:` line inside an enabled conditional IS a real target", async () => {
    expect(await declares("ifeq (a,a)\ncheck:\n\t@echo hi\nendif\n")).toBe(true);
  });

  test("a .PHONY check target with a recipe is detected", async () => {
    expect(await declares(".PHONY: check\ncheck:\n\t@echo hi\n")).toBe(true);
  });

  test("a file literally named `check` (no rule) is not a match", async () => {
    // `make -q check` exits 0 here ("'check' is up to date") even though nothing is registered —
    // the exact false positive the exit-code sniffing had. A `check` file with no rule registers
    // no `check:` header in the database.
    await writeFile(join(cwd, "Makefile"), "all:\n\t@echo x\n");
    await writeFile(join(cwd, "check"), "not a rule\n");
    expect(await hasMakeCheckTarget(cwd)).toBe(false);
  });

  test("a catch-all `%:` pattern rule is not a match", async () => {
    // `make -q check` exits 1 here (the `%:` rule "needs remaking"), matching a real target —
    // the other false positive. The pattern rule registers no explicit `check:` header.
    expect(await declares("%:\n\t@echo catchall\n")).toBe(false);
  });

  test("a recipe-less `check:` target is not a match", async () => {
    // `make check` prints "Nothing to be done" and exits 0 — zero real validation. A `check:`
    // header with no recipe has no `commands/recipe to execute` marker in the database.
    expect(await declares("check:\n")).toBe(false);
  });

  test("`check` only as another target's prerequisite is not a match", async () => {
    expect(await declares("all: check\n\t@true\n")).toBe(false);
  });

  test("a lowercase `makefile` with a check target is detected", async () => {
    await writeFile(join(cwd, "makefile"), "check:\n\t@echo hi\n");
    expect(await hasMakeCheckTarget(cwd)).toBe(true);
  });

  test("a prerequisite-only `check: lint test` target is detected", async () => {
    expect(await declares("lint:\n\t@true\ntest:\n\t@true\ncheck: lint test\n")).toBe(true);
  });

  test("a `check:` target with an unavailable prerequisite is still detected", async () => {
    // `make -q check` exits 2 here (no rule to make `generated/config`), which must NOT mean
    // "no check target" — the recipe is real and `make check` should run (and fail) rather than
    // fall through to the skill path.
    expect(await declares("check: generated/config\n\t@echo real-check\n")).toBe(true);
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

describe("terminateSessionsForJob — external kill of a detached make check", () => {
  // runStep's OWN watchdog/`finally` already group-kills its detached `make check`; this is the
  // OTHER kill path — `job_cancel`'s `terminateSessionsForJob` (and, through the same
  // `killRegisteredProc` helper, a drain's `terminateActiveSessions`). It must reach the whole
  // process group, not just `make`, or a recipe that backgrounds a child (`sleep 300 &`) leaks
  // that child as an untracked orphan.
  test("group-kills a backgrounded recipe child, not only the make leader", async () => {
    const pidFile = join(cwd, "child.pid");
    // `wait` keeps `make` (and its recipe shell) alive long enough for the external kill to land
    // while `proc.exitCode === null` — the precondition `terminateSessionsForJob` acts on.
    await writeFile(join(cwd, "Makefile"), `check:\n\t@sleep 300 & echo $$! > ${pidFile}; wait\n`);

    const proc = Bun.spawn(["make", "check"], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    const untrack = trackExternalProc(proc, "job-ext-kill", true);
    const drained = new Response(proc.stdout).text();
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(25);
      expect(existsSync(pidFile)).toBe(true);
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(pidAlive(pid)).toBe(true);

      expect(terminateSessionsForJob("job-ext-kill")).toBe(true);

      const killDeadline = Date.now() + 5_000;
      while (pidAlive(pid) && Date.now() < killDeadline) await Bun.sleep(25);
      expect(pidAlive(pid)).toBe(false);
    } finally {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        /* the process group is already gone */
      }
      untrack();
      await drained;
    }
  }, 30_000);
});
