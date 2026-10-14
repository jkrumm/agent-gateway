import { existsSync } from "fs";
import { join } from "path";
import { z } from "zod";
import {
  runSession,
  scrubSensitiveEnv,
  SessionCancelledError,
  trackExternalProc,
  zodValidator,
} from "../../mcp/session-runner.ts";
import { routeFor } from "../../lib/routing.ts";
import { IDLE_TIMEOUT_MS } from "../../lib/idle-timeout.ts";
import { appLogger as logger } from "../../logger.ts";
import type { ProgressSink } from "../store.ts";
import { parseParams } from "./util.ts";
import { JSON_ONLY_RETRY, loadSkillFile, unwrap } from "../../lib/worker-io.ts";

// ── Input schema (single source for MCP inputSchema + execution validation) ───

export const CHECK_INPUT = z.object({
  cwd: z
    .string()
    .describe(
      "Absolute path to the git repo root to validate. Must be an existing git repository. Supports git worktrees.",
    ),
  commands: z
    .array(z.string())
    .optional()
    .describe(
      "Optional explicit validation commands to run verbatim, in order, e.g. " +
        "['.venv/bin/ruff check', '.venv/bin/pyrefly check', '.venv/bin/pytest -q']. " +
        "When provided, the worker runs ONLY these and skips ecosystem auto-discovery — " +
        "this avoids burning wall-clock hunting for the test runner (the #1 time-sink on " +
        "non-Node repos). Each command becomes one step named after its first token. " +
        "Omit on Node/Bun repos where package.json scripts are auto-detected reliably.",
    ),
  stepTimeoutSeconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Override the per-step idle-timeout window: seconds of no NEW output before a step " +
        "is judged stuck and killed. It is an idle watchdog, not a wall clock — a step that " +
        "keeps producing output past this many seconds is never killed on elapsed time " +
        "alone. Applies to every step, including test. Default when omitted: 180s for " +
        "ordinary steps, 600s for the test step specifically (e2e suites legitimately go " +
        "quiet for minutes between assertions). Raise this per call for a repo whose suite " +
        "needs more headroom than the default.",
    ),
});

export type CheckParams = z.infer<typeof CHECK_INPUT>;

// ── Output schema — single source of truth ────────────────────────────────────

export const CHECK_OUTPUT = z.object({
  passed: z.boolean().describe("True only if every step passed."),
  steps: z
    .array(
      z.object({
        name: z
          .string()
          .describe(
            "Step name: format | lint | typecheck | test | fallow, or check for the " +
              "deterministic repo contract's `make check` path.",
          ),
        passed: z.boolean(),
        errors: z
          .array(z.string())
          .optional()
          .describe("Error lines. Only present when passed is false."),
      }),
    )
    .describe("Only steps that were actually run (skipped if script absent)."),
  summary: z
    .string()
    .describe("One-line result, e.g. 'All 3 steps passed' or '1/3 failed: lint (5 errors)'."),
});

const CHECK_JSON_SCHEMA = z.toJSONSchema(CHECK_OUTPUT);

export type CheckOutput = z.infer<typeof CHECK_OUTPUT>;

// ── Deterministic `make check` path ────────────────────────────────────────────
//
// The repo contract (dotfiles/docs/agent-platform.md) is that `make check` is a repo's single
// validation entrypoint — it encodes the right flags/env and, for a repo whose `check` installs
// dependencies first, is the ONLY thing that works in a dependency-less dispatch worktree
// (`node_modules` is excluded from the worktree copy — dispatch-git.ts's
// EXCLUDED_COPY_SEGMENTS). The skill-driven discovery path below only *prefers* `make <target>`
// among the per-tool targets, so a worker hand-picks raw `bun run typecheck`/`lint` and fails on
// the missing deps rather than on the diff — a correct PR goes red. When the caller passed no
// explicit `commands` and the repo root Makefile declares a real `check:` target, run it
// verbatim instead, followed by the same `fallow audit` the skill path runs: deterministic steps,
// no LLM, no ecosystem sniffing, so the verdict is the repo's own contract rather than the
// model's guess at a step list.

/** Wall-clock budget for the `make -p` probe below. The probe only ever dumps Make's database
 *  (it never runs a recipe), but a `$(shell ...)` or `include` in the Makefile can still block,
 *  so the gate itself is bounded where the steps it gates are idle-watchdogged. Overrunning the
 *  budget is a false negative — fall through to the skill path, never a red. */
const MAKE_CHECK_PROBE_TIMEOUT_MS = 5_000;
/** Sentinel the probe's `Promise.race` uses to tell a budget overrun apart from a normal exit. */
const MAKE_CHECK_PROBE_TIMEOUT = Symbol("make-check-probe-timeout");

/** Whether a `make -p` database dump registers `check` as a target. The dump lists every file
 *  Make knows in its `# Files` section, one header line per entry (`check:`, `check::`,
 *  `check: lint test`); an entry Make only knows as a prerequisite or an existing file is
 *  prefixed by a `# Not a target:` line. So a `check` header inside `# Files` that is not marked
 *  "not a target" is a real rule when it has prerequisites (`check: lint test`) or a recipe of
 *  its own — both of which `make check` runs. Everything else stays out by construction: a
 *  catch-all `%:` pattern rule is listed under `# Implicit Rules`, a `define … endef` body under
 *  `# Variables`, and a file or dir literally named `check` carries the `# Not a target:` mark. */
export function makeDatabaseHasCheckTarget(db: string): boolean {
  const lines = db.split("\n");
  const from = lines.indexOf("# Files");
  if (from < 0) return false;
  for (let i = from + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("# files hash-table stats") || line.startsWith("# VPATH Search Paths"))
      break;
    const header = /^check::?(.*)$/.exec(line);
    if (!header || lines[i - 1] === "# Not a target:") continue;
    if (header[1].trim() !== "") return true;
    // A bare `check:` only counts with a recipe: `make check` on an empty rule prints "Nothing
    // to be done" and exits 0 — a green with zero validation. The recipe marker sits in the
    // header's own block (comment and tab-indented lines up to the next column-0 entry).
    for (let j = i + 1; j < lines.length && !/^[^ \t#]/.test(lines[j]); j++) {
      if (/(commands|recipe) to execute \(from/.test(lines[j])) return true;
    }
  }
  return false;
}

/** Whether the repo root Makefile declares a `check` target — the gate for the deterministic
 *  `make check` path. Detected by parsing `make -p`'s database, not by
 *  sniffing `make -q check`'s exit code: exit 0 also fires for a file/dir named `check` (or a
 *  recipe-less `check:` target), exit 1 for a catch-all `%:` pattern rule, and exit 2 both for
 *  "no rule to make target" AND for a genuine `check:` target whose prerequisite has no rule —
 *  so no exit code cleanly separates a real target from the rest. That is exactly
 *  the distinction the old column-0 source regex got wrong too: a `define UNUSED\ncheck:\nendef`
 *  block or a disabled conditional contains the line but registers no rule, so the regex matched
 *  and produced the false red this path exists to avoid. A missing Makefile, a missing `make`,
 *  or a probe that overruns its budget all fall through to the skill path. */
export async function hasMakeCheckTarget(cwd: string): Promise<boolean> {
  // GNU make's own lookup order; any of the three is the repo's Makefile.
  if (!["GNUmakefile", "makefile", "Makefile"].some((f) => existsSync(join(cwd, f)))) return false;
  if (!Bun.which("make")) return false;

  // Same env hygiene as `runStep`: the probe spawns `make` in the server process, so a
  // `$(shell ...)` in an untrusted dispatch Makefile must not be able to read the LaunchAgent's
  // tokens, and `PWD` must point at the probe's cwd, not the server's stale value.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  scrubSensitiveEnv(env);
  // `scrubSensitiveEnv` deliberately keeps `CLAUDE_CODE_OAUTH_TOKEN` so the `claude` CLI can
  // authenticate on Max; this probe runs `make` directly, never `claude`, so the token has no
  // reason to be present and a `$(shell ...)` in the Makefile must not be able to exfiltrate it
  // (same reasoning as `runStep`).
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  env.PWD = cwd;

  // `-q` (question mode) is load-bearing: bare `make -p` still BUILDS the default goal after
  // dumping the database, so it would run the very recipe the probe is only meant to *detect*
  // (and a recipe that backgrounds a child would orphan it, or `kill -TERM $$PPID` would kill
  // the probe). With `-q` the database is dumped and nothing is remade — the same no-recipe
  // guarantee the old `make -q` probe had.
  const proc = Bun.spawn(["make", "-p", "-q"], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env,
    // A `$(shell ...)` child must not outlive the probe on a timeout; a group kill reaches it.
    detached: true,
  });

  // Drain stdout concurrently so a large database dump can't block the child (and a spurious
  // timeout) while we wait for it to exit.
  // A read that fails (the timeout branch kills the group mid-dump) resolves empty, so the probe
  // can only ever produce a false negative — never an unhandled rejection.
  const stdoutText = new Response(proc.stdout).text().catch(() => "");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    proc.exited,
    new Promise<typeof MAKE_CHECK_PROBE_TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(MAKE_CHECK_PROBE_TIMEOUT), MAKE_CHECK_PROBE_TIMEOUT_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (outcome === MAKE_CHECK_PROBE_TIMEOUT) {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      /* the process group is already gone */
    }
    return false;
  }
  return makeDatabaseHasCheckTarget(await stdoutText);
}

const MAKE_CHECK_IDLE_CHECK_INTERVAL_MS = 5_000;
const MAKE_CHECK_SIGKILL_GRACE_MS = 5_000;
/** Backstop on the drains once the step's leader is gone: after the process group is killed
 *  the pipes close, but a writer that somehow survives must still not wedge the step forever. */
const MAKE_CHECK_DRAIN_GRACE_MS = 5_000;
const MAKE_CHECK_MAX_ERROR_LINES = 50;
const MAKE_CHECK_LINE_MAX_CHARS = 500;
const MAKE_CHECK_OUTPUT_TAIL_CHARS = 20_000;

/** The last few non-empty output lines, bounded per line — the check output contract wants
 *  error lines, not a second log. */
function makeCheckErrorLines(output: string): string[] {
  return output
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l !== "")
    .slice(-MAKE_CHECK_MAX_ERROR_LINES)
    .map((l) =>
      l.length > MAKE_CHECK_LINE_MAX_CHARS ? `${l.slice(0, MAKE_CHECK_LINE_MAX_CHARS)}…` : l,
    );
}

type CheckStep = CheckOutput["steps"][number];

/** One deterministic step's verdict and its one-line summary fragment. */
interface StepResult {
  step: CheckStep;
  summary: string;
}

/** Run one command (`make check`, `fallow audit`) as a deterministic step. No worker session and
 *  no model call — the exit code is the verdict and the output tail is the error detail, exactly
 *  the shape the skill path produces, minus the model's judgement. Idle-watchdogged (never a
 *  wall-clock ceiling) and registered for `POST /api/jobs/:id/cancel`, like every other child. */
async function runStep(
  argv: string[],
  name: string,
  cwd: string,
  idleSeconds: number,
  jobId: string | undefined,
  isCancelled: ((jobId: string) => boolean) | undefined,
  onProgress: ProgressSink | undefined,
): Promise<StepResult> {
  const label = argv.join(" ");
  const idleMs = idleSeconds * 1000;
  // A worker session scrubs credential-shaped env before its `claude -p` spawn; this path
  // spawns the command directly in the server process, so it needs the same scrub — a `check`
  // target in an untrusted dispatch worktree must not be able to read the LaunchAgent's tokens.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  scrubSensitiveEnv(env);
  // `scrubSensitiveEnv` deliberately keeps `CLAUDE_CODE_OAUTH_TOKEN` so the `claude` CLI can
  // authenticate on Max; this path runs `make`/`fallow` directly, never `claude`, so the token
  // has no legitimate reason to be present — dropping it closes an exfiltration hole for an
  // untrusted dispatch Makefile (`check:; curl -d "t=$$CLAUDE_CODE_OAUTH_TOKEN" …`).
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  // `Bun.spawn`'s `cwd` does not update the child's `PWD` env var, and `process.env` carries the
  // LaunchAgent's stale `PWD` — pinned to the main checkout, not this command's `cwd`. A `make
  // check` recipe that reads `$(PWD)`/`$PWD` would then validate the WRONG tree (a false green
  // against the dispatch worktree). Same pin, for the same measured reason, as
  // what the pre-Wave-3 opencode runner did for its client process.
  env.PWD = cwd;

  const proc = Bun.spawn(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
    // New session/process group (`setsid`), so `killGroup` below reaches a recipe's backgrounded
    // child — see the note on `killGroup`.
    detached: true,
  });
  // `detached: true` (flag passed through) so `terminateSessionsForJob`/`terminateActiveSessions`
  // group-kill this process rather than signalling only the leader — see `trackExternalProc`.
  const untrack = trackExternalProc(proc, jobId, true);

  let lastActivityAt = Date.now();
  let idleKilled = false;
  let cancelled = false;
  let tail = "";
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

  // The child leads its own process group (`detached: true` → `setsid`), so a negative PID
  // signals the whole group. That reach matters: a recipe that backgrounds a child
  // (`check:; @sleep 999999 &`) has it reparented away from `make` by the shell, so `proc.kill`
  // can only ever hit `make` itself — and that orphan is exactly what keeps the stdout/stderr
  // pipes open after `make` has exited (the step then hangs forever, holding a global
  // concurrency slot and blocking `make reload`). Signalling an already-reaped group throws
  // ESRCH, which is not an error here.
  const killGroup = (signal: "SIGTERM" | "SIGKILL"): void => {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      /* the process group is already gone */
    }
  };

  const terminate = (): void => {
    // No `proc.exitCode !== null` early return: `make` exiting does not mean its group is gone,
    // and skipping the signal on that assumption is what let an orphaned recipe child wedge the
    // step.
    killGroup("SIGTERM");
    if (sigkillTimer) return; // a second terminate() must not arm a second escalation
    sigkillTimer = setTimeout(() => killGroup("SIGKILL"), MAKE_CHECK_SIGKILL_GRACE_MS);
  };

  const watchdog = setInterval(() => {
    if (jobId && isCancelled?.(jobId)) {
      cancelled = true;
      terminate();
      return;
    }
    if (!idleKilled && Date.now() - lastActivityAt >= idleMs) {
      idleKilled = true;
      terminate();
    }
  }, MAKE_CHECK_IDLE_CHECK_INTERVAL_MS);

  // Each stream is drained after every chunk, so an output-heavy step keeps resetting the idle
  // clock and is never killed on elapsed time. Both pipes must be drained or the child blocks.
  const drain = async (stream: ReadableStream<Uint8Array> | undefined): Promise<void> => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lastActivityAt = Date.now();
        tail += decoder.decode(value, { stream: true });
        if (tail.length > MAKE_CHECK_OUTPUT_TAIL_CHARS) {
          tail = tail.slice(-MAKE_CHECK_OUTPUT_TAIL_CHARS);
        }
      }
    } finally {
      reader.releaseLock();
    }
  };

  try {
    onProgress?.({ turns: 0, lastAction: label, lastActivityAt: Date.now() });
    let drainsDone = false;
    const drains = Promise.all([drain(proc.stdout), drain(proc.stderr)]).then(() => {
      drainsDone = true;
    });
    drains.catch(() => {}); // a late rejection after the deadline below must not go unhandled

    const exitCode = await proc.exited;

    // `make` has exited, but a recipe can leave an orphan holding the write end, so the drains
    // above may still be waiting on an EOF that never comes. Signal the whole group so every
    // writer dies; buffered output is not lost — a closed pipe still yields its buffered bytes
    // before EOF — and the deadline on top means even a writer that somehow survives cannot wedge
    // the step forever.
    if (!drainsDone) killGroup("SIGKILL");
    let drainGraceTimer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      drains.then(() => true),
      new Promise<boolean>((resolve) => {
        drainGraceTimer = setTimeout(() => resolve(false), MAKE_CHECK_DRAIN_GRACE_MS);
      }),
    ]);
    if (drainGraceTimer) clearTimeout(drainGraceTimer);
    if (!drained) killGroup("SIGKILL");

    // An external kill — `job_cancel`'s `terminateSessionsForJob`, or a drain's
    // `terminateActiveSessions` — can land faster than this watchdog's 5s `isCancelled` poll, so
    // `cancelled` is still false when `proc.exited` resolves and the step would otherwise look
    // like an ordinary failing exit. `runCheck` would then RETURN that result and store.ts's
    // `execute()` would persist the job `done` with a bogus verdict instead of landing it
    // `cancelled` (or leaving it `running` for drain recovery). Re-check the cancel flag, and
    // treat a leader killed by a signal this step never sent as a cancellation too (`idleKilled`
    // covers the one signal we DID send ourselves).
    const signalled = proc.signalCode === "SIGTERM" || proc.signalCode === "SIGKILL";
    if (cancelled || (jobId !== undefined && isCancelled?.(jobId)) || (signalled && !idleKilled)) {
      throw new SessionCancelledError(jobId ?? "check");
    }

    if (!idleKilled && exitCode === 0) {
      return { step: { name, passed: true }, summary: `${label} passed` };
    }
    const errors = idleKilled
      ? [
          `no output for ${idleSeconds}s — likely a watch-mode runner or a hung process`,
          ...makeCheckErrorLines(tail),
        ]
      : makeCheckErrorLines(tail);
    return {
      step: {
        name,
        passed: false,
        errors: errors.length > 0 ? errors : [`${label} failed (exit ${exitCode}) with no output`],
      },
      summary: idleKilled
        ? `${label} failed: no output for ${idleSeconds}s`
        : `${label} failed (exit ${exitCode})`,
    };
  } finally {
    clearInterval(watchdog);
    // A no-op on the normal path (the group is already gone, so `killGroup`'s ESRCH is
    // swallowed); this only bites if the try block threw before it could stop the step itself.
    terminate();
    if (proc.exitCode === null && proc.signalCode === null) await proc.exited;
    // Cleared only once the child has exited — `terminate()` above may have just re-armed it.
    if (sigkillTimer) clearTimeout(sigkillTimer);
    untrack();
  }
}

/** Whether the skill path's `fallow audit` rule applies here: fallow is installed and the repo
 *  has at least one git remote (its changed-file base is the remote default branch). */
async function fallowApplies(cwd: string): Promise<boolean> {
  if (!Bun.which("fallow")) return false;
  const proc = Bun.spawn(["git", "remote"], { cwd, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 && out.trim() !== "";
}

/** The repo contract's check: `make check`, then the same `fallow audit` the skill path runs
 *  after its language steps (fallow exits 1 on a `fail` verdict, so the exit code is the
 *  verdict). */
async function runRepoContractCheck(
  cwd: string,
  idleSeconds: number,
  jobId: string | undefined,
  isCancelled: ((jobId: string) => boolean) | undefined,
  onProgress: ProgressSink | undefined,
): Promise<CheckOutput> {
  const results = [
    await runStep(["make", "check"], "check", cwd, idleSeconds, jobId, isCancelled, onProgress),
  ];
  if (await fallowApplies(cwd)) {
    results.push(
      await runStep(
        ["fallow", "audit", "--quiet"],
        "fallow",
        cwd,
        idleSeconds,
        jobId,
        isCancelled,
        onProgress,
      ),
    );
  }
  return {
    passed: results.every((r) => r.step.passed),
    steps: results.map((r) => r.step),
    summary: results.map((r) => r.summary).join("; "),
  };
}

// ── Skill prompt loader ────────────────────────────────────────────────────────

// JSON output contract — shared by both prompt paths so they never drift.
const OUTPUT_CONTRACT = `## Output

Return ONLY a JSON object with this exact structure (no explanation, no markdown, just JSON):

{
"passed": <boolean>,
"steps": [
{ "name": "<step-name>", "passed": <boolean>, "errors": ["<error line>", ...] }
],
"summary": "<one-line summary, e.g. 'All 3 steps passed' or '1/3 steps failed: lint (5 errors)'>"
}

Only include \`errors\` when the step failed. \`passed\` at root is true only if ALL steps that ran passed.`;

// ── Command safety — idle watchdog ──────────────────────────────────────────────
//
// A hung command must never stall the job, but a fixed wall-clock cap (the old `timeout
// 180 <cmd>`) kills legitimate long-running steps too — an e2e suite that runs minutes but
// keeps producing output is indistinguishable, on elapsed time alone, from one that is
// actually wedged (rollhook had to rename its e2e `test` script to dodge exactly this — see
// rollhook#26). The owner's standing rule is "no wall-clock ceilings on agent work, only
// idle watchdogs" — so this caps IDLE time (no new output) instead of total time.

/** Ordinary-step idle window when the caller does not override it. */
const DEFAULT_STEP_IDLE_SECONDS = 180;
/** The test step specifically defaults higher — e2e suites legitimately go quiet between
 *  assertions for longer than a lint or typecheck step ever should. */
const DEFAULT_TEST_IDLE_SECONDS = 600;

/** Margin (seconds) the session-level idle watchdog keeps above the worker's largest per-step
 *  idle window. During a single Bash step `claude -p` emits no stdout at all — `run_step`
 *  buffers the command's output into a temp file and `cat`s it only once the step ends (see
 *  `idleWatchdogBlock`) — so the session watchdog must outlast the step's own idle window or
 *  it kills the session first and the step window never applies. The margin covers the
 *  tool-use turn that launches the step and the tool-result turn that reports it. */
const SESSION_IDLE_MARGIN_SECONDS = 120;

/** The session-level idle-watchdog budget for a check run, in ms: the larger of the two
 *  per-step idle windows the worker was told to use, plus a safety margin. Never below the
 *  shared `IDLE_TIMEOUT_MS` default, so a caller passing a small `stepTimeoutSeconds` cannot
 *  make the session watchdog stricter than every other tool's. Pure and exported so the
 *  derivation is unit-testable without spawning a worker. */
export function checkSessionIdleTimeoutMs(stepSeconds: number, testSeconds: number): number {
  const stepBoundMs = (Math.max(stepSeconds, testSeconds) + SESSION_IDLE_MARGIN_SECONDS) * 1000;
  return Math.max(IDLE_TIMEOUT_MS, stepBoundMs);
}

/** The idle-watchdog instructions, parameterized by the effective idle windows. Shared by
 *  both prompt paths (explicit-commands and discovery) so they can never drift — the
 *  watchdog shell function itself is worker-authored bash embedded in the prompt (there is
 *  no handler-side subprocess to attach a real idle timer to; the worker's own Bash tool is
 *  the only thing actually running the command), so keeping one copy of the recipe matters. */
function idleWatchdogBlock(stepSeconds: number, testSeconds: number): string {
  return (
    `## Command safety — idle watchdog, not a wall clock\n\n` +
    `A hung command must never stall the job. But many legitimate steps (e2e suites, slow ` +
    `integration tests) run for minutes while still producing output — do NOT cap on ` +
    `elapsed time. Cap on IDLE time instead: kill a step only once it has produced no NEW ` +
    `output for its idle window.\n\n` +
    `Before running any command, define this helper once in your Bash session:\n\n` +
    "    run_step() {\n" +
    '      local cmd="$1" idle="$2" out; out=$(mktemp)\n' +
    '      eval "$cmd" >"$out" 2>&1 &\n' +
    "      local pid=$! last=0 stalled=0\n" +
    '      while kill -0 "$pid" 2>/dev/null; do\n' +
    "        sleep 5\n" +
    '        local size; size=$(wc -c <"$out")\n' +
    '        if [ "$size" != "$last" ]; then last=$size; stalled=0; else stalled=$((stalled + 5)); fi\n' +
    '        if [ "$stalled" -ge "$idle" ]; then\n' +
    '          kill -9 "$pid" 2>/dev/null\n' +
    '          echo "IDLE_TIMEOUT: no output for ${idle}s" >>"$out"\n' +
    "          break\n" +
    "        fi\n" +
    "      done\n" +
    '      wait "$pid" 2>/dev/null; local code=$?\n' +
    '      cat "$out"; rm -f "$out"\n' +
    "      return $code\n" +
    "    }\n\n" +
    `Run every command through it: \`run_step '<cmd>' <idle-seconds>\` — use ${stepSeconds} ` +
    `for ordinary steps and ${testSeconds} for the test step specifically (both are ` +
    `caller-configured; use these exact numbers, do not substitute your own). If \`run_step\` ` +
    `cannot be defined (no bash, restricted shell), fall back to \`timeout ${stepSeconds} ` +
    `<cmd>\` (or \`gtimeout\`) as a wall-clock approximation. "IDLE_TIMEOUT" appearing in the ` +
    `captured output (or exit code 124 from the timeout fallback) means the watchdog killed ` +
    `it — mark that step failed with "no output for <idle-seconds>s — likely a watch-mode ` +
    `runner or a hung process" and move on, never retry. If a test command reports no tests ` +
    `("0 test files", "No test files found", pytest exit 5), mark the step passed — an ` +
    `empty suite is not a failure.`
  );
}

/** Minimal, self-contained prompt for the explicit-commands fast path. Loads NO
 *  discovery skill — the worker runs exactly the given commands and nothing else
 *  (no ecosystem sniffing, no fallow, no `git remote -v`/`which`). This is what
 *  keeps the fast path fast: discovery is the dominant turn-sink otherwise. */
function explicitCommandsPrompt(
  commands: string[],
  stepSeconds: number,
  testSeconds: number,
): string {
  return (
    `You are a code quality checker. The caller supplied the EXACT validation commands. ` +
    `Run ONLY these, in order, via Bash — capture stdout+stderr for each. A step passes if ` +
    `its exit code is 0, fails otherwise (collect the error lines into \`errors\`). Name each ` +
    `step after the command's tool (e.g. "ruff", "pytest", "pyrefly", "lint", "test").\n\n` +
    `Run EXACTLY these and nothing else. Do NOT explore the repo, read package.json/` +
    `pyproject.toml, sniff the ecosystem, run \`which\`/\`git remote -v\`, or run \`fallow\`. ` +
    `As soon as every command has run once, emit the JSON — do not re-run or re-read.\n\n` +
    `${idleWatchdogBlock(stepSeconds, testSeconds)}\n\n` +
    commands.map((c, i) => `${i + 1}. \`${c}\``).join("\n") +
    `\n\n` +
    OUTPUT_CONTRACT
  );
}

async function loadSkillPrompt(
  commands: string[] | undefined,
  stepSeconds: number,
  testSeconds: number,
): Promise<string> {
  if (commands && commands.length > 0)
    return explicitCommandsPrompt(commands, stepSeconds, testSeconds);
  const skillPath = join(import.meta.dir, "../../skills/check.md");
  // Discovery path: drop the (now-unused) explicit-commands placeholder, and splice in the
  // caller-configured idle-watchdog block so both prompt paths run the same recipe.
  const template = await loadSkillFile(skillPath, "check");
  return template
    .replace("{{COMMANDS}}\n", "")
    .replace("{{COMMANDS}}", "")
    .replace("{{TIMEOUT_BLOCK}}", idleWatchdogBlock(stepSeconds, testSeconds));
}

// ── Core ───────────────────────────────────────────────────────────────────────

/** Run all available validation steps and return structured pass/fail. Throws on failure. */
export async function runCheck(
  rawParams: Record<string, unknown>,
  onProgress?: ProgressSink,
  jobId?: string,
  isCancelled?: (jobId: string) => boolean,
): Promise<CheckOutput> {
  const { cwd, commands, stepTimeoutSeconds } = parseParams(CHECK_INPUT, rawParams);
  if (!existsSync(cwd)) throw new Error(`Directory not found: ${cwd}`);

  // A caller-supplied override applies uniformly to every step, including test — it is an
  // explicit "this repo's suite needs more (or less) headroom than the default" statement,
  // not a per-step distinction the caller is expected to make.
  const stepSeconds = stepTimeoutSeconds ?? DEFAULT_STEP_IDLE_SECONDS;
  const testSeconds = stepTimeoutSeconds ?? DEFAULT_TEST_IDLE_SECONDS;

  // The repo contract's `make check` wins over LLM discovery whenever the caller supplied no
  // explicit commands — deterministic, dependency-aware, no model in the loop (see the section
  // above). A caller-supplied `commands` always overrides it.
  if ((!commands || commands.length === 0) && (await hasMakeCheckTarget(cwd))) {
    // `make check` bundles the test step, so it gets the test step's (higher) idle window.
    return runRepoContractCheck(cwd, testSeconds, jobId, isCancelled, onProgress);
  }

  const prompt = await loadSkillPrompt(commands, stepSeconds, testSeconds);
  const runWorker = (p: string) =>
    runSession<CheckOutput>({
      cwd,
      prompt: p,
      tool: "check",
      jobId,
      isCancelled,
      jsonSchema: CHECK_JSON_SCHEMA,
      route: routeFor("check"),
      readOnly: true,
      // The session watchdog must outlast the worker's own per-step idle windows: within a
      // single Bash step no stdout is emitted, so the shared 5-minute default would kill the
      // session before a long test step's window could apply.
      idleTimeoutMs: checkSessionIdleTimeoutMs(stepSeconds, testSeconds),
      // No `retryAfterOutput`: glm-5.3-flash thinking is capped at 2048 tokens here
      // (`ToolRoute.thinkingTokens`, MAX_THINKING_TOKENS), but it can still run genuinely
      // slow on hard validation runs, not stuck — a timeout after it has already produced
      // turns used to re-lane onto Haiku mid-job instead of just letting it finish. The
      // idle watchdog in session-runner.ts is the real stuck-detector now; only a
      // zero-output timeout still moves lanes.
      validate: zodValidator(CHECK_OUTPUT),
      onActivity: onProgress,
    });

  let result = await runWorker(prompt);
  // Only the prose-instead-of-JSON case is retried (`noOutput`): a timeout, non-zero exit
  // or transport failure has already been through the runner's own retry policy and a
  // second full validator run would just double the cost of a real outage.
  if (!result.ok && result.noOutput) {
    logger.warn(
      { event: "check.retry", tool: "check", project: cwd, error: result.error },
      "check output was not schema JSON — retrying once with JSON-only directive",
    );
    result = await runWorker(prompt + JSON_ONLY_RETRY);
  }

  return unwrap(result, "check");
}
