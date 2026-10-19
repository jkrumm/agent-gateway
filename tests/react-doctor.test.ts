// `server/lib/react-doctor.ts` — the advisory react-doctor phase-1 input: command builder per
// base kind and the pure report → synthesis-block rendering. No network, no bunx.

import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import {
  REACT_DOCTOR_DROPPED_RULES,
  REACT_DOCTOR_FAILED_PREFIX,
  REACT_DOCTOR_MAX_LINES,
  REACT_DOCTOR_VERSION,
  parseReactDoctorResult,
  reactDoctorBinPath,
  reactDoctorCommand,
  reactDoctorFailureReason,
  renderReactDoctorBlock,
} from "../server/lib/react-doctor.ts";
import { fallowBaseFor } from "../server/jobs/handlers/review.ts";

type Diag = {
  filePath: string;
  rule: string;
  severity: "error" | "warning";
  title: string;
  line: number;
  category: string;
  id?: string;
};

const diag = (over: Partial<Diag> = {}): Diag => ({
  filePath: "src/a.tsx",
  rule: "no-ref-current-in-render",
  severity: "error",
  title: "Ref mutated during render",
  line: 10,
  category: "Bugs",
  ...over,
});

const report = (diagnostics: Diag[], extra: Record<string, unknown> = {}) => ({
  stdout: JSON.stringify({ mode: "baseline", error: null, diagnostics, ...extra }),
  ok: true,
});

describe("reactDoctorCommand", () => {
  test("skip runs nothing", () => {
    expect(reactDoctorCommand({ kind: "skip" })).toBe("true");
  });

  test("always pins the version and keeps telemetry and the remote supply-chain lookup off", () => {
    for (const base of [{ kind: "base", ref: "main" }, { kind: "auto" }] as const) {
      const cmd = reactDoctorCommand(base);
      expect(cmd).toContain(`'${reactDoctorBinPath()}' --no-telemetry`);
      expect(cmd).toContain(`[ -x '${reactDoctorBinPath()}' ] || exit 0`);
      expect(cmd).toContain("--no-telemetry");
      expect(cmd).toContain("--no-supply-chain");
      expect(cmd).toContain("--blocking none");
      expect(cmd).toContain('--json-out "$out"');
      expect(cmd).not.toContain("bunx");
    }
  });

  test("execs the pinned install by absolute path, never bunx", () => {
    const bin = reactDoctorBinPath();
    expect(bin).toBe(
      `${homedir()}/.local/share/agent-gateway/react-doctor/${REACT_DOCTOR_VERSION}/node_modules/.bin/react-doctor`,
    );
    for (const base of [{ kind: "base", ref: "HEAD~5" }, { kind: "auto" }] as const) {
      const cmd = reactDoctorCommand(base);
      expect(cmd).not.toContain("bunx");
      expect(cmd).not.toContain("$HOME");
      expect(cmd).toContain(`'${homedir()}/`);
    }
  });

  test("base resolves the ref to an OID (react-doctor refuses `~`/`^`) and scopes to changed", () => {
    const cmd = reactDoctorCommand({ kind: "base", ref: "HEAD~5" });
    expect(cmd).toContain('git rev-parse --verify --quiet "HEAD~5^{commit}"');
    expect(cmd).toContain('--scope changed --base "$b"');
    expect(cmd).not.toContain("--include-untracked");
  });

  test("a HEAD base is the working tree: untracked files included", () => {
    expect(reactDoctorCommand({ kind: "base", ref: "HEAD" })).toContain("--include-untracked");
  });

  test("auto scopes to changed without a base", () => {
    const cmd = reactDoctorCommand({ kind: "auto" });
    expect(cmd).toContain("--scope changed");
    expect(cmd).not.toContain("--base");
    expect(cmd).not.toContain("rev-parse");
  });

  test("shares fallow's base derivation", () => {
    expect(reactDoctorCommand(fallowBaseFor("HEAD~3"))).toContain('"HEAD~3^{commit}"');
    expect(reactDoctorCommand(fallowBaseFor("HEAD~4..HEAD~2"))).toBe("true");
    expect(reactDoctorCommand(fallowBaseFor("src/foo.ts"))).not.toContain("--base");
  });
});

describe("renderReactDoctorBlock", () => {
  test("not applicable and failures are explicit, never read as clean", () => {
    expect(renderReactDoctorBlock({ stdout: "", ok: true })).toBe(
      "react-doctor: not run (no React in the repo, no pinned install under ~/.local/share/agent-gateway/react-doctor (make install-react-doctor), or no diff-shaped base for this scope).",
    );
    expect(
      renderReactDoctorBlock({ stdout: `${REACT_DOCTOR_FAILED_PREFIX} (exit 2): boom`, ok: true }),
    ).toContain("react-doctor failed: (exit 2): boom");
    expect(renderReactDoctorBlock({ stdout: "", ok: false })).toContain("react-doctor failed:");
    expect(renderReactDoctorBlock({ stdout: "not json", ok: true })).toContain(
      "react-doctor failed: unparseable",
    );
    expect(renderReactDoctorBlock(report([], { error: { message: "bad base" } }))).toContain(
      "react-doctor failed: bad base",
    );
  });

  test("zero findings says so", () => {
    expect(renderReactDoctorBlock(report([]))).toContain("no findings in the changed code");
  });

  test("errors first, then Bugs/Security/Performance before Maintainability", () => {
    const block = renderReactDoctorBlock(
      report([
        diag({ rule: "m-warn", severity: "warning", category: "Maintainability", line: 1 }),
        diag({ rule: "p-warn", severity: "warning", category: "Performance", line: 2 }),
        diag({ rule: "b-warn", severity: "warning", category: "Bugs", line: 3 }),
        diag({ rule: "m-err", severity: "error", category: "Maintainability", line: 4 }),
        diag({ rule: "s-err", severity: "error", category: "Security", line: 5 }),
      ]),
    );
    const order = ["s-err", "m-err", "b-warn", "p-warn", "m-warn"].map((r) => block.indexOf(r));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(block).toContain("error s-err src/a.tsx:5 — Ref mutated during render");
  });

  test("denylisted rules and env-template secret hits are dropped", () => {
    const block = renderReactDoctorBlock(
      report([
        ...REACT_DOCTOR_DROPPED_RULES.map((rule) => diag({ rule })),
        diag({ rule: "repository-secret-file", filePath: ".env.local.tpl" }),
        diag({ rule: "repository-secret-file", filePath: "config/.env.prod.tpl" }),
        diag({ rule: "repository-secret-file", filePath: ".env" }),
        diag({ rule: "keep-me" }),
      ]),
    );
    for (const rule of REACT_DOCTOR_DROPPED_RULES) expect(block).not.toContain(rule);
    expect(block).not.toContain(".env.local.tpl");
    expect(block).not.toContain(".env.prod.tpl");
    expect(block).toContain("repository-secret-file .env:");
    expect(block).toContain("keep-me");
    expect(block).toContain("2 finding(s)");
  });

  test("caps the list with a +N more tail", () => {
    const many = Array.from({ length: REACT_DOCTOR_MAX_LINES + 7 }, (_, i) =>
      diag({ rule: `r${i}`, line: i + 1 }),
    );
    const block = renderReactDoctorBlock(report(many));
    expect(block).toContain("+7 more");
    expect(block).toContain(`r${REACT_DOCTOR_MAX_LINES - 1} `);
    expect(block).not.toContain(`r${REACT_DOCTOR_MAX_LINES} `);
  });

  test("monorepo paths come from the id, not the project-relative filePath", () => {
    const block = renderReactDoctorBlock(
      report([diag({ filePath: "src/a.tsx", id: "apps/web/src/a.tsx::10:3::react-doctor/x::h" })]),
    );
    expect(block).toContain("apps/web/src/a.tsx:10");
  });

  test("a report that ignored the diff scope is flagged", () => {
    const block = renderReactDoctorBlock(report([diag()], { mode: "full" }));
    expect(block).toContain("ignored the diff scope");
  });
});

describe("reactDoctorFailureReason", () => {
  test("leads with the error line, keeps the rest, header first", () => {
    const stderr = [
      "Scanning…",
      "installing deps",
      "error: Failed to link chalk: EEXIST",
      "Node.js v26.11.1",
    ].join("\n");
    expect(reactDoctorFailureReason(`(exit 1): ${stderr}`)).toBe(
      "(exit 1): error: Failed to link chalk: EEXIST | Scanning… | installing deps | Node.js v26.11.1",
    );
  });

  test("without an error-looking line the order is kept", () => {
    expect(reactDoctorFailureReason("(exit 2): one\ntwo")).toBe("(exit 2): one | two");
  });

  test("caps the length", () => {
    const reason = reactDoctorFailureReason(`(exit 1): ${"x".repeat(2000)}`);
    expect(reason.length).toBeLessThanOrEqual(601);
    expect(reason.endsWith("…")).toBe(true);
  });

  test("flows through the failed marker into the render", () => {
    const stdout = `${REACT_DOCTOR_FAILED_PREFIX} (exit 1): a\nTypeError: boom\n}`;
    expect(parseReactDoctorResult({ stdout, ok: true })).toEqual({
      kind: "failed",
      reason: "(exit 1): TypeError: boom | a | }",
    });
  });
});

describe("parseReactDoctorResult", () => {
  test("counts what the denylist dropped and carries the elapsed time", () => {
    const outcome = parseReactDoctorResult(
      report([diag(), diag({ rule: "only-export-components" })], { elapsedMilliseconds: 1234.6 }),
    );
    expect(outcome).toMatchObject({ kind: "report", dropped: 1, errorCount: 1, elapsedMs: 1235 });
  });
});
