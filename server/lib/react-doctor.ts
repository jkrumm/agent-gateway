import { homedir } from "node:os";
import { join } from "node:path";

// ── react-doctor (npm `react-doctor`, a pinned install run by absolute path) ──────────────
//
// One more phase-1 review INPUT next to fallow and OCR — advisory, never a gate. Central
// toolbelt: no reviewed repo installs it; `scripts/install-react-doctor.sh` (`make
// install-react-doctor`, also run by `make deploy`/`install-cli`) installs the pinned version
// under `~/.local/share/agent-gateway/react-doctor/<version>` and the command execs that binary
// directly. Never `bunx`: its shared install cache races under concurrent reviews (`Failed to
// link <pkg>: EEXIST`, 73 of 520 runs failed, measured 2026-10-19). Diff-scoped (`--scope changed`), so it reports only issues new against the base.
//
// Measured on 0.9.18 (2026-10-16, argo/apps/dashboard):
// - `--no-telemetry` (alias of `--no-score`) is MANDATORY: it skips their remote score API and
//   crash reporting, so no repo data leaves the machine. `--no-supply-chain` likewise skips the
//   Socket.dev dependency lookups (also a remote call, on by default).
// - `--base` accepts only `[A-Za-z0-9_./-]` — no `~`/`^`/`@{` — so the command resolves the
//   (already validated) ref to a commit OID first. `HEAD~5` is refused outright otherwise.
// - Without `--json-out` stdout carries a human "Agent guidance" block, not JSON: the report is
//   written to a temp file and printed by the wrapper. `--blocking none` keeps exit 0.
// - `--no-cache`: a stale scan cache on a dirty working tree is a correctness risk for a
//   reviewer; it costs ~2 s.
// - Working-tree scope: `--scope changed --base HEAD --include-untracked` reports uncommitted
//   edits and new untracked files (verified in a scratch clone).
// - Diagnostic `filePath` is relative to the scanned PROJECT dir; the repo-relative path is the
//   prefix of `id` (`<path>::<line>:<col>::<rule>::<hash>`) — monorepos differ.

/** Pinned in one place: an upgrade is a deliberate act (report shape, rule names, flags). */
export const REACT_DOCTOR_VERSION = "0.9.18";

/** Absolute path of the pinned install's binary (`scripts/install-react-doctor.sh` puts it here). */
export function reactDoctorBinPath(): string {
  return join(
    homedir(),
    ".local/share/agent-gateway/react-doctor",
    REACT_DOCTOR_VERSION,
    "node_modules/.bin/react-doctor",
  );
}

/** CLI helper timeout (not an agent run — `.claude/rules/agent-limits.md` does not apply). */
export const REACT_DOCTOR_TIMEOUT_MS = 120_000;

/** Marker prefix the wrapper prints when react-doctor itself fails, so a crash is never read
 *  as "found nothing". */
export const REACT_DOCTOR_FAILED_PREFIX = "react-doctor failed";

/** Rules dropped from the synthesis block: `only-export-components` is style noise (37 of 93 on
 *  argo), the complexity pair duplicates fallow's health analysis. */
export const REACT_DOCTOR_DROPPED_RULES: readonly string[] = [
  "only-export-components",
  "no-giant-component",
  "no-high-complexity-react-function",
];

/** `repository-secret-file` false-positives on `.env.*.tpl` files holding only op:// refs. */
const REACT_DOCTOR_TEMPLATE_SECRET_RULE = "repository-secret-file";
const REACT_DOCTOR_ENV_TEMPLATE_PATH = /\.env.*\.tpl$/;

/** Rendered lines before the "+N more" tail. */
export const REACT_DOCTOR_MAX_LINES = 40;

/** Same shape as review.ts's `FallowBase` (structural — pass `fallowBaseFor`'s result as is). */
export type ReactDoctorBase = { kind: "base"; ref: string } | { kind: "auto" } | { kind: "skip" };

/** Stderr lines the wrapper hands back on a failure; the reason leads with the error line. */
const REACT_DOCTOR_STDERR_LINES = 15;
const REACT_DOCTOR_REASON_MAX_CHARS = 600;
const REACT_DOCTOR_ERROR_LINE = /error|Error|EEXIST|ENOENT|throw/;

/** Turns the wrapper's failure text (`(exit N): <stderr tail>`, multi-line) into one diagnostic
 *  reason: the exit header, then the first error-looking line, then the rest, capped. */
export function reactDoctorFailureReason(raw: string): string {
  const [, header = "", body = ""] = raw.match(/^\s*(\(exit \d+\):)?\s*([\s\S]*)$/) ?? [];
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const errorLine = lines.find((l) => REACT_DOCTOR_ERROR_LINE.test(l));
  const ordered = errorLine ? [errorLine, ...lines.filter((l) => l !== errorLine)] : lines;
  const reason = [header, ordered.join(" | ")].filter(Boolean).join(" ");
  return reason.length > REACT_DOCTOR_REASON_MAX_CHARS
    ? `${reason.slice(0, REACT_DOCTOR_REASON_MAX_CHARS)}…`
    : reason;
}

/** Shell command for the react-doctor report. Empty output = not applicable (no pinned install, no
 *  React in any tracked package.json, or a scope with no diff-shaped base); otherwise the JSON
 *  report, or `REACT_DOCTOR_FAILED_PREFIX` + the stderr tail. stderr never reaches stdout
 *  (`shell` merges the two). The ref is already `validateScope`-checked (or a resolved OID in
 *  ref mode), so it is safe to splice. A base of `HEAD` means the working tree, which needs
 *  `--include-untracked` to see new files. */
export function reactDoctorCommand(base: ReactDoctorBase): string {
  if (base.kind === "skip") return "true";
  const bin = `'${reactDoctorBinPath().replaceAll("'", "'\\''")}'`;
  const guards =
    `[ -x ${bin} ] || exit 0; ` +
    `git ls-files -z -- '*package.json' 2>/dev/null | xargs -0 grep -lE '"react"[[:space:]]*:' 2>/dev/null | grep -q . || exit 0`;
  const resolve =
    base.kind === "base"
      ? `b=$(git rev-parse --verify --quiet "${base.ref}^{commit}") || { echo "${REACT_DOCTOR_FAILED_PREFIX}: cannot resolve base ${base.ref}"; exit 0; }; `
      : "";
  const scopeArgs =
    base.kind === "base"
      ? ` --scope changed --base "$b"${base.ref === "HEAD" ? " --include-untracked" : ""}`
      : " --scope changed";
  return (
    `${guards}; ${resolve}out=$(mktemp); err=$(mktemp); ` +
    `${bin} --no-telemetry --no-supply-chain --no-cache ` +
    `--json --json-compact --json-out "$out" -y --blocking none${scopeArgs} >/dev/null 2>"$err"; rc=$?; ` +
    `if [ -s "$out" ]; then cat "$out"; ` +
    `else [ "$rc" -eq 0 ] || echo "${REACT_DOCTOR_FAILED_PREFIX} (exit $rc): $(tail -n ${REACT_DOCTOR_STDERR_LINES} "$err")"; fi; rm -f "$out" "$err"`
  );
}

interface ReactDoctorDiagnostic {
  filePath: string;
  rule: string;
  severity: string;
  title: string;
  line?: number;
  category?: string;
  id?: string;
}

export interface ReactDoctorFinding {
  severity: "error" | "warning";
  rule: string;
  file: string;
  line?: number;
  title: string;
  category: string;
}

export type ReactDoctorOutcome =
  | {
      kind: "report";
      findings: ReactDoctorFinding[];
      /** Diagnostics removed by the denylist. */
      dropped: number;
      errorCount: number;
      elapsedMs?: number;
      /** True when react-doctor ignored the diff scope and scanned everything. */
      unscoped: boolean;
    }
  | { kind: "failed"; reason: string }
  | { kind: "not-applicable" };

const CATEGORY_RANK: Record<string, number> = {
  Bugs: 0,
  Security: 1,
  Performance: 2,
  Maintainability: 4,
};

/** The diagnostic's repo-relative path: `id` carries it as its first `::` segment when the
 *  project dir is a subdirectory (monorepo); `filePath` alone is project-relative. */
function repoRelativePath(d: ReactDoctorDiagnostic): string {
  const head = d.id?.split("::")[0];
  return head && head.endsWith(d.filePath) ? head : d.filePath;
}

function isDropped(d: ReactDoctorDiagnostic): boolean {
  if (REACT_DOCTOR_DROPPED_RULES.includes(d.rule)) return true;
  return (
    d.rule === REACT_DOCTOR_TEMPLATE_SECRET_RULE && REACT_DOCTOR_ENV_TEMPLATE_PATH.test(d.filePath)
  );
}

/** Classifies the wrapper's `shell` result. Pure, never throws. A non-ok result with no output
 *  is the timeout/kill path in `shell`; an empty ok result is "not applicable". */
export function parseReactDoctorResult(result: {
  stdout: string;
  ok: boolean;
}): ReactDoctorOutcome {
  const stdout = result.stdout.trim();
  if (!stdout) {
    return result.ok
      ? { kind: "not-applicable" }
      : {
          kind: "failed",
          reason: `timed out after ${REACT_DOCTOR_TIMEOUT_MS / 1000}s or could not start`,
        };
  }
  if (stdout.startsWith(REACT_DOCTOR_FAILED_PREFIX)) {
    return {
      kind: "failed",
      reason: reactDoctorFailureReason(
        stdout.slice(REACT_DOCTOR_FAILED_PREFIX.length).replace(/^:/, ""),
      ),
    };
  }

  let report: {
    diagnostics?: ReactDoctorDiagnostic[];
    error?: { message?: string } | null;
    mode?: string;
    elapsedMilliseconds?: number;
  };
  try {
    report = JSON.parse(stdout);
  } catch {
    return { kind: "failed", reason: "unparseable report output" };
  }
  if (report.error) {
    return { kind: "failed", reason: report.error.message ?? "react-doctor reported an error" };
  }

  const kept = (report.diagnostics ?? []).filter((d) => !isDropped(d));
  const findings = kept
    .map((d): ReactDoctorFinding => ({
      severity: d.severity === "error" ? "error" : "warning",
      rule: d.rule,
      file: repoRelativePath(d),
      line: d.line,
      title: d.title,
      category: d.category ?? "",
    }))
    .toSorted(
      (a, b) =>
        Number(a.severity === "warning") - Number(b.severity === "warning") ||
        (CATEGORY_RANK[a.category] ?? 3) - (CATEGORY_RANK[b.category] ?? 3) ||
        a.file.localeCompare(b.file) ||
        (a.line ?? 0) - (b.line ?? 0),
    );
  return {
    kind: "report",
    findings,
    dropped: (report.diagnostics?.length ?? 0) - kept.length,
    errorCount: findings.filter((f) => f.severity === "error").length,
    elapsedMs:
      typeof report.elapsedMilliseconds === "number"
        ? Math.round(report.elapsedMilliseconds)
        : undefined,
    unscoped: report.mode !== "baseline",
  };
}

/** Synthesis-prompt block for the react-doctor output: a crash is named as one, never rendered
 *  as a clean brief or as "not applicable". Pure, never throws. */
export function renderReactDoctorBlock(result: { stdout: string; ok: boolean }): string {
  const outcome = parseReactDoctorResult(result);
  if (outcome.kind === "not-applicable")
    return "react-doctor: not run (no React in the repo, no pinned install under ~/.local/share/agent-gateway/react-doctor (make install-react-doctor), or no diff-shaped base for this scope).";
  if (outcome.kind === "failed") {
    return `${REACT_DOCTOR_FAILED_PREFIX}: ${outcome.reason} — no React-specific static-analysis input for this review.`;
  }

  const note = outcome.unscoped
    ? "\nNote: react-doctor ignored the diff scope and scanned everything — findings may predate this change; check them against the diff before using any."
    : "";
  if (outcome.findings.length === 0) {
    return `react-doctor: no findings in the changed code.${note}`;
  }

  const shown = outcome.findings.slice(0, REACT_DOCTOR_MAX_LINES);
  const lines = shown.map(
    (f) => `${f.severity} ${f.rule} ${f.file}${f.line ? `:${f.line}` : ""} — ${f.title}`,
  );
  const more = outcome.findings.length - shown.length;
  if (more > 0) lines.push(`+${more} more`);
  return (
    `react-doctor: ${outcome.findings.length} finding(s), ${outcome.errorCount} error(s)${note}\n` +
    `\`\`\`\n${lines.join("\n")}\n\`\`\``
  );
}
