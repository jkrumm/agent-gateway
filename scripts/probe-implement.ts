#!/usr/bin/env bun
// Probe candidate `implement` workers on real, replayed briefs. Standalone: runs OUTSIDE the
// sideclaw server (`bun scripts/probe-implement.ts ...`) and drives `runSession` directly.
//
// Each (model, brief) gets a throwaway tree cut from the brief's `parent` commit with NO git
// history — the model under test can `git status`/`git diff` its own edits but `git log`
// cannot reveal the fix commit. One writable OpenCode session runs the brief. Acceptance then
// copies the brief's test file(s) from its `fix` commit over whatever the worker wrote and runs
// them, plus `oxfmt --check` on the changed files.
//
// The worker is shown ONLY the brief text — never the test file, never the fix. `opencodeModel`
// does not require a model to be `verified`, so unverified registry ids (e.g. DeepSeek-V4-Pro)
// run here on purpose.
//
// Usage:
//   bun scripts/probe-implement.ts \
//     [--models DeepSeek-V4-Pro,gpt-6.1-sol,deepseek-v4.1-flash] \
//     [--out ~/.local/share/sideclaw/probe/<timestamp>/]
//
// `--out` holds one tree per (model, brief) plus results.json / summary.md. No server, no jobs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { runSession } from "../server/mcp/session-runner.ts";
import { getModel } from "../server/lib/models.ts";
import { type ToolRoute } from "../server/lib/routing.ts";

// ── Briefs — the exact text a human would hand an implement worker ──────────────

interface Brief {
  label: string;
  /** The commit whose tree the worker starts from (its parent), and the commit that carries
   *  the reference fix + the acceptance test. */
  parent: string;
  fix: string;
  testFiles: string[];
  text: string;
}

const BRIEFS: Brief[] = [
  {
    label: "warden-board-null-repo",
    parent: "9831772~1",
    fix: "9831772",
    testFiles: ["tests/warden-board.test.ts"],
    text:
      "server/lib/warden-board.ts: board items whose `repo` is null make the whole board fail " +
      "schema validation and log warden.board_unavailable on every poll. Accept `repo: null` in " +
      "the item schema and render it as an em dash ('—') where the repo name is shown. Keep " +
      "existing behaviour for non-null repos. Add/adjust tests in tests/warden-board.test.ts. " +
      "Run `bun test tests/warden-board.test.ts` before finishing.",
  },
  {
    label: "routing-per-angle-fallback",
    parent: "68ae512~1",
    fix: "68ae512",
    testFiles: ["tests/routing.test.ts"],
    text:
      "server/lib/routing.ts buildRoutingTable: a per-angle review route (keys review_angle_*) " +
      "overridden via SIDECLAW_MODEL_/SIDECLAW_HARNESS_ onto a non-Claude opencode model ends up " +
      "with fallback null. It must instead fall back to backend `max` on the angle's own default " +
      "Claude model (a fallback attempt always runs claude -p). Only per-angle review routes get " +
      "this; every other route is unchanged. Add a test in tests/routing.test.ts. Run " +
      "`bun test tests/routing.test.ts` before finishing.",
  },
];

// ── CLI ─────────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out.set(arg.slice(2), next);
      i++;
    } else {
      out.set(arg.slice(2), "true");
    }
  }
  return out;
}

function expandHome(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const USAGE = `Usage: bun scripts/probe-implement.ts [options]

  --models <list>   Comma-separated model ids (default: DeepSeek-V4-Pro,gpt-6.1-sol,deepseek-v4.1-flash)
  --out <dir>       Output dir (default: ~/.local/share/sideclaw/probe/<timestamp>)
`;

// ── Shell helpers ───────────────────────────────────────────────────────────────

interface ShResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

/** Run an argv, capturing stdout/stderr UNTRIMMED (source files must survive byte-for-byte). */
async function capture(argv: string[], cwd: string): Promise<ShResult> {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, stdout, stderr, code };
}

async function git(cwd: string, args: string[]): Promise<ShResult> {
  return capture(["git", ...args], cwd);
}

// ── Usage attribution (cost / turns / duration) ─────────────────────────────────

const ATTR_LOG = join(homedir(), ".local", "share", "usage-tracker", "sideclaw-sessions.jsonl");

function readUsage(tool: string): { costUsd?: number; turns?: number; durationMs?: number } {
  try {
    if (!existsSync(ATTR_LOG)) return {};
    const lines = readFileSync(ATTR_LOG, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      try {
        const rec = JSON.parse(line) as {
          tool?: string;
          costUsd?: number;
          turns?: number;
          durationMs?: number;
        };
        if (rec.tool === tool) return rec;
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* best-effort */
  }
  return {};
}

// ── Route ───────────────────────────────────────────────────────────────────────

const VARIANT_PREFERENCE = ["max", "high", "low", "none"];

/** "max" when the registry lists it, else the highest it does list. */
function pickVariant(model: string): string | undefined {
  const effort = getModel(model)?.effort ?? [];
  for (const v of VARIANT_PREFERENCE) if (effort.includes(v)) return v;
  return undefined;
}

/** Built literally (not via `routeFor`) so an unverified id still runs. `fallback: null`
 *  deliberately: routing a failed candidate onto Max's Sonnet would measure a different model,
 *  confounding the probe — a candidate failure should read as a failure. */
function probeRoute(model: string): ToolRoute {
  return {
    model,
    backend: "iu",
    fallback: null,
    transport: "session",
    harness: "opencode",
    variant: pickVariant(model),
  };
}

// ── Tree / acceptance ───────────────────────────────────────────────────────────

const REPO_ROOT = resolve(import.meta.dir, "..");
const BUN_BIN = process.execPath;

/** Materialize a tree at `parent` with no history: `git archive` the commit, `git init` it, and
 *  make one base commit so the worker can `git diff`/`git status` its own edits. `git log`
 *  shows only that base commit — the fix is unreachable from the tree. */
async function materializeTree(parent: string, treePath: string): Promise<void> {
  mkdirSync(treePath, { recursive: true });
  const archive = await capture(
    [
      "bash",
      "-c",
      `git -C ${shQuote(REPO_ROOT)} archive ${shQuote(parent)} | tar -x -C ${shQuote(treePath)}`,
    ],
    REPO_ROOT,
  );
  if (!archive.ok) throw new Error(`git archive ${parent} failed: ${archive.stderr}`);
  const init = await git(treePath, ["init", "-q"]);
  if (!init.ok) throw new Error(`git init failed: ${init.stderr}`);
  await git(treePath, ["add", "-A"]);
  const commit = await capture(
    [
      "git",
      "-c",
      "user.email=probe@sideclaw.local",
      "-c",
      "user.name=probe",
      "commit",
      "-q",
      "-m",
      "base",
    ],
    treePath,
  );
  if (!commit.ok) throw new Error(`base commit failed: ${commit.stderr}`);
  // node_modules is gitignored/untracked, so it is never in the archive — symlink the live
  // one so `bun test` resolves without an install inside the throwaway tree.
  const liveModules = join(REPO_ROOT, "node_modules");
  if (existsSync(liveModules)) {
    await capture(["ln", "-s", liveModules, join(treePath, "node_modules")], treePath);
  }
}

async function changedFiles(treePath: string): Promise<string[]> {
  const tracked = await git(treePath, ["diff", "--name-only", "HEAD"]);
  const untracked = await git(treePath, ["ls-files", "--others", "--exclude-standard"]);
  const all = [...tracked.stdout.split("\n"), ...untracked.stdout.split("\n")]
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(all)];
}

async function diffLineCount(treePath: string): Promise<number> {
  const numstat = await git(treePath, ["diff", "--numstat", "HEAD"]);
  let total = 0;
  for (const line of numstat.stdout.split("\n")) {
    const [added, deleted] = line.split("\t");
    const a = Number.parseInt(added ?? "0", 10);
    const d = Number.parseInt(deleted ?? "0", 10);
    if (Number.isFinite(a)) total += a;
    if (Number.isFinite(d)) total += d;
  }
  return total;
}

interface ProbeResult {
  model: string;
  brief: string;
  variant: string | undefined;
  treePath: string;
  sessionOk: boolean;
  sessionError?: string;
  turns: number;
  durationMs: number;
  costUsd: number | null;
  changedFiles: string[];
  diffLines: number;
  testsPass: boolean;
  testsOutputTail: string;
  oxfmtClean: boolean | null;
  permissionFailures: string[];
}

async function runProbe(model: string, brief: Brief, outRoot: string): Promise<ProbeResult> {
  const treePath = join(outRoot, "runs", `${sanitize(model)}-${brief.label}`);
  await materializeTree(brief.parent, treePath);
  const route = probeRoute(model);
  const tool = `probe:${sanitize(model)}:${brief.label}:${randomUUID().slice(0, 8)}`;

  let turns = 0;
  const startedAt = performance.now();
  const result = await runSession({
    cwd: treePath,
    prompt: brief.text,
    tool,
    route,
    readOnly: false,
    settingSources: "user,project",
    onActivity: (p) => {
      turns = Math.max(turns, p.turns);
    },
  });
  const wallMs = Math.round(performance.now() - startedAt);
  const usage = readUsage(tool);

  const permissionFailures = [result.error, result.rawText]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n")
    .split("\n")
    .filter((line) => /permission|rejected|not allowed|denied/i.test(line))
    .slice(0, 3);

  // Acceptance: overwrite the worker's tests with the fix commit's reference tests, then run
  // them. The fix is read from the LIVE sideclaw repo (`git show <fix>:<path>`) — the worker's
  // tree has no history that could reach it.
  const files = await changedFiles(treePath);
  for (const testFile of brief.testFiles) {
    const show = await git(REPO_ROOT, ["show", `${brief.fix}:${testFile}`]);
    if (show.ok) {
      writeFileSync(join(treePath, testFile), show.stdout);
    }
  }
  const tests = await capture([BUN_BIN, "test", ...brief.testFiles], treePath);
  const testsOutputTail = [tests.stdout, tests.stderr].join("\n").trim().slice(-4000);

  const oxfmtBin = join(REPO_ROOT, "node_modules", ".bin", "oxfmt");
  let oxfmtClean: boolean | null = null;
  if (files.length > 0 && existsSync(oxfmtBin)) {
    const fmt = await capture([oxfmtBin, "--check", ...files], treePath);
    oxfmtClean = fmt.ok;
  }

  return {
    model,
    brief: brief.label,
    variant: route.variant,
    treePath,
    sessionOk: result.ok,
    sessionError: result.ok ? undefined : (result.error ?? "unknown error"),
    turns: usage.turns ?? turns,
    durationMs: usage.durationMs ?? wallMs,
    costUsd: typeof usage.costUsd === "number" ? usage.costUsd : null,
    changedFiles: files,
    diffLines: await diffLineCount(treePath),
    testsPass: tests.ok,
    testsOutputTail,
    oxfmtClean,
    permissionFailures,
  };
}

// ── Report ──────────────────────────────────────────────────────────────────────

function renderSummary(results: ProbeResult[]): string {
  const lines: string[] = [
    "# Probe implement workers — replayed briefs",
    "",
    "Acceptance: the brief's reference test file(s) are copied over the worker's tree and " +
      "`bun test` runs; `oxfmt --check` runs on the changed files.",
    "",
    "| model | brief | tests | files_changed | turns | seconds | cost_usd |",
    "|-|-|-|-|-|-|-|",
  ];
  for (const r of results) {
    lines.push(
      `| ${r.model} | ${r.brief} | ${r.testsPass ? "pass" : "FAIL"} | ${r.changedFiles.length} | ` +
        `${r.turns} | ${(r.durationMs / 1000).toFixed(1)} | ` +
        `${r.costUsd === null ? "n/a" : `$${r.costUsd.toFixed(4)}`} |`,
    );
  }
  lines.push("");
  for (const r of results) {
    lines.push(`### ${r.model} — ${r.brief}`, "");
    lines.push(`- session: ${r.sessionOk ? "ok" : `FAIL (${r.sessionError ?? "unknown"})`}`);
    lines.push(`- oxfmt: ${r.oxfmtClean === null ? "n/a" : r.oxfmtClean ? "clean" : "dirty"}`);
    lines.push(`- changed files: ${r.changedFiles.join(", ") || "(none)"}`);
    lines.push(`- tree: ${r.treePath}`);
    if (r.permissionFailures.length > 0) {
      lines.push(`- permission failures: ${r.permissionFailures.join(" | ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(Bun.argv.slice(2));
  if (args.has("help") || args.has("h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const models = (args.get("models") ?? "DeepSeek-V4-Pro,gpt-6.1-sol,deepseek-v4.1-flash")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const outRoot = expandHome(
    args.get("out") ??
      join(
        homedir(),
        ".local",
        "share",
        "sideclaw",
        "probe",
        new Date().toISOString().replace(/[:.]/g, "-"),
      ),
  );
  mkdirSync(outRoot, { recursive: true });

  const results: ProbeResult[] = [];
  for (const model of models) {
    for (const brief of BRIEFS) {
      process.stderr.write(`\n[probe] ${model} · ${brief.label}\n`);
      try {
        const r = await runProbe(model, brief, outRoot);
        results.push(r);
        process.stderr.write(
          `  session=${r.sessionOk ? "ok" : "FAIL"} tests=${r.testsPass ? "pass" : "FAIL"} ` +
            `files=${r.changedFiles.length} turns=${r.turns} ${(r.durationMs / 1000).toFixed(1)}s\n`,
        );
      } catch (err) {
        process.stderr.write(`  setup failed: ${String(err)}\n`);
        results.push({
          model,
          brief: brief.label,
          variant: pickVariant(model),
          treePath: join(outRoot, "runs", `${sanitize(model)}-${brief.label}`),
          sessionOk: false,
          sessionError: `setup failed: ${String(err)}`,
          turns: 0,
          durationMs: 0,
          costUsd: null,
          changedFiles: [],
          diffLines: 0,
          testsPass: false,
          testsOutputTail: "",
          oxfmtClean: null,
          permissionFailures: [],
        });
      }
    }
  }

  const summary = renderSummary(results);
  writeFileSync(join(outRoot, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(outRoot, "summary.md"), `${summary}\n`);
  process.stdout.write(`\n${summary}\n\nWrote ${outRoot}/results.json and ${outRoot}/summary.md\n`);
  return 0;
}

process.exit(await main());
