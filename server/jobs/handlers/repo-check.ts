import { SessionCancelledError } from "../../mcp/session-runner.ts";
import { runCheck, type CheckOutput } from "./check.ts";

// The repo's own `check` as a push gate, shared by the dispatch implement tier (depositBranch,
// finishInPlace) and update-pr — neither may import the other.

/** What a caller hands `runRepoCheck`: the job identity for cancellation, plus the test seam. */
export type RepoCheckContext = {
  jobId?: string;
  isCancelled?: (jobId: string) => boolean;
  runCheckFn?: typeof runCheck;
};

/** A `CheckOutput` plus a handler-only marker the push-gate callers read to report the truth:
 *  `toolFailure` is present only on the synthesized failure `runRepoCheck` builds when the
 *  check tool itself THREW (an infrastructure failure — a re-run is the fix), and absent on a
 *  real red suite (the repo's checks ran and failed). It is deliberately NOT part of
 *  `CheckOutput`/the check tool's own output schema — the check tool never emits it. */
export type RepoCheckOutput = CheckOutput & { toolFailure?: string };

/** Run the repo's own `check` tool, handling the two failure shapes `depositBranch` and
 *  `finishInPlace` both need identically: a cancellation must propagate as exactly that
 *  (never as a failed check, which would push or report as if the episode ran to
 *  completion), and any OTHER throw becomes a synthetic failed check step rather than an
 *  unhandled rejection — a broken check tool may only make an episode MORE cautious, never
 *  silently wave a red run through. That synthetic failure carries `toolFailure` so a caller
 *  can report an infrastructure failure instead of misreading it as a red suite. Re-checked
 *  for cancellation after the check returns too: the race a cancel arriving while the check
 *  itself was still running, which the try/catch above can't observe. */
export async function runRepoCheck(
  cwd: string,
  note: (s: string) => void,
  checkCtx: RepoCheckContext,
): Promise<RepoCheckOutput> {
  const { jobId, isCancelled, runCheckFn = runCheck } = checkCtx;
  let checkOutput: RepoCheckOutput;
  try {
    checkOutput = await runCheckFn(
      { cwd },
      (p) => note(`check: ${p.lastAction}`),
      jobId,
      isCancelled,
    );
  } catch (err) {
    if (err instanceof SessionCancelledError) throw err;
    // Never empty: callers branch on `toolFailure` being truthy, and `new Error("")` or
    // `throw ""` must still read as a tool failure, not a red suite.
    const message =
      (err instanceof Error ? err.message : String(err)) || "check tool threw with no message";
    checkOutput = {
      passed: false,
      steps: [
        {
          name: "check",
          passed: false,
          errors: [message],
        },
      ],
      summary: "check tool failed to run",
      toolFailure: message,
    };
  }
  if (jobId && isCancelled?.(jobId)) {
    throw new SessionCancelledError(jobId);
  }
  return checkOutput;
}

/** Failing check steps rendered into `artifactNote`-sized text: step name + its first few
 *  error lines, bounded to ~1500 chars so a chatty test runner's dump stays a note rather than
 *  a second log. */
export function renderFailedChecks(steps: CheckOutput["steps"]): string {
  const rendered = steps
    .filter((s) => !s.passed)
    .map((s) => `${s.name}: ${(s.errors ?? []).slice(0, 3).join(" | ") || "(no error detail)"}`)
    .join("; ");
  if (rendered === "") return "(no step detail recorded)";
  return rendered.length > 1500 ? `${rendered.slice(0, 1500)}…` : rendered;
}

/** Whether a failed check should block the push. fallow findings are advisory (see the
 *  comment at its call site) — a `passed: false` result whose only failing steps are fallow
 *  does not block. Every other shape does, INCLUDING a `passed: false` with no failing step
 *  recorded at all: that shape means the check tool itself is confused, not that it found
 *  nothing wrong, and treating it as passing would be the one silent failure mode this
 *  function exists to rule out — fail-safe, not fail-open. */
export function checksBlockPush(check: CheckOutput): boolean {
  const failedSteps = check.steps.filter((s) => !s.passed);
  const advisorySteps = failedSteps.filter((s) => s.name === "fallow");
  return !check.passed && (failedSteps.length === 0 || advisorySteps.length < failedSteps.length);
}
