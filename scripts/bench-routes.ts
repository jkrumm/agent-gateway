#!/usr/bin/env bun
// Route bench: the same fixed real task set across candidate models on the OpenCode harness.
// Drives `runSession` directly against the shared OpenCode server (LaunchAgent must be up), so
// it measures the production path — provider, cache_control injection, usage records — not a
// stand-in. Costs a few dollars of IU tokens; never run from CI.
//
//   bun scripts/bench-routes.ts [--models a,b,c] [--reps 2] [--tasks implement,investigate] [--out dir]
//
// Tasks (--tasks implement,investigate,review; a worker only ever sees the brief text, never the reference test or the fix):
//   implement    — three briefs replayed from this repo's history. A throwaway history-less tree is
//                  cut from the fix commit's parent; acceptance copies the fix commit's test file
//                  over the worker's and runs it, plus `oxfmt --check` on the changed files.
//   investigate  — three read-only questions about the tree at HEAD, graded by required substrings.
//   review       — the pipeline's own senior-dev / typescript / qa angle prompts over two real
//                  commits' diffs; scored by how many of the defects the repo's later fix commits
//                  corrected the findings name (hint regexes — a proxy, read findings.json).
//
// Reported per cell: pass, turns, wall seconds, cost, input/output/cache-read tokens and the
// cache-hit ratio, from the attribution row `runSession` writes (one row per tool name).
// Cost is the runner's own number; Haiku 5.5 bills 5x above 100K prompt tokens, so the report
// also prints the largest prompt (input + cache read) seen — a cell above 100K is flagged.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ANGLE_JSON_SCHEMA, loadAnglePrompt } from "../server/jobs/handlers/review.ts";
import { getModel } from "../server/lib/models.ts";
import { type ToolRoute } from "../server/lib/routing.ts";
import { runSession } from "../server/mcp/session-runner.ts";

// ── Task set ────────────────────────────────────────────────────────────────────

interface ImplementTask {
  kind: "implement";
  label: string;
  /** Tree to start from, and the commit carrying the reference fix + acceptance test. */
  parent: string;
  fix: string;
  testFiles: string[];
  text: string;
}

interface InvestigateTask {
  kind: "investigate";
  label: string;
  text: string;
  /** Every one must appear (case-insensitive) in the final answer. */
  expect: string[];
}

/** One reviewer angle over a real commit's diff. Ground truth is what the repo's own later fix
 *  commits corrected: each hint group is satisfied when any finding's text matches its regex. */
interface ReviewTask {
  kind: "review";
  label: string;
  /** Commit under review; the tree is cut from it and its diff is handed over as `REVIEW.diff`. */
  commit: string;
  angle: string;
  hints: Array<{ name: string; re: RegExp }>;
}

const REVIEW_COMMITS: Array<{ label: string; commit: string; hints: ReviewTask["hints"] }> = [
  {
    // Fixed later by 87a9172 / ca5bb60 / 15123c1 (target detection) and a616c37 (group kill).
    label: "make-check-target",
    commit: "28d33d4",
    hints: [
      {
        name: "text-vs-rule",
        re: /define|endef|conditional|ifeq|ifdef|comment|regex|column.?0|false (red|positive)/i,
      },
      {
        name: "file-or-pattern",
        re: /file (named|called)|named `?check|%:|catch-all|pattern rule|directory/i,
      },
      {
        name: "orphaned-children",
        re: /orphan|detach|process.?group|background|child|SIGKILL|kill/i,
      },
      { name: "env-credentials", re: /oauth|credential|token|secret|env(ironment)? (scrub|leak)/i },
    ],
  },
  {
    // Fixed later by d055a20, 8285c11, be69bb4, 11ed8d9.
    label: "opencode-2x-stream",
    commit: "7abe598",
    hints: [
      {
        name: "final-text",
        re: /final text|ends? (on|with)|incomplete|truncat|empty (result|output)|no (final )?text/i,
      },
      {
        name: "mid-loop-step-finish",
        re: /step_finish|mid.?loop|multiple|premature|early|completion/i,
      },
      { name: "env-precedence", re: /extraEnv|precedence|override|env.*order/i },
      { name: "pwd-or-usage", re: /PWD|cwd|unbilled|final turn|usage|cost|token/i },
    ],
  },
];

const REVIEW: ReviewTask[] = REVIEW_COMMITS.flatMap((c) =>
  ["senior-dev", "typescript", "qa"].map((angle): ReviewTask => ({
    kind: "review",
    label: `${c.label}/${angle}`,
    commit: c.commit,
    angle,
    hints: c.hints,
  })),
);

const IMPLEMENT: ImplementTask[] = [
  {
    kind: "implement",
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
    kind: "implement",
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
  {
    kind: "implement",
    label: "check-make-target-prereq",
    parent: "15123c1~1",
    fix: "15123c1",
    testFiles: ["tests/check-makefile.test.ts"],
    text:
      "server/jobs/handlers/check.ts: the check job decides whether a repo has a `make check` " +
      "target by scanning a `make -p` database dump, and today only counts a `check:` rule that " +
      "has its own recipe. A prerequisite-only rule (`check: lint test`, no recipe) is a real " +
      "target — `make check` runs its prerequisites — and must be detected. Export the detector " +
      "as `makeDatabaseHasCheckTarget(db: string): boolean` (rename the current function). Read " +
      "targets only from the dump's `# Files` section, skip entries preceded by a `# Not a " +
      "target:` line, and keep rejecting: a catch-all `%:` pattern rule, a `define … endef` body " +
      "mentioning `check:`, a file named `check`, and a bare `check:` with no prerequisites and " +
      "no recipe (that one prints 'Nothing to be done' and is a false green). Update " +
      "tests/check-makefile.test.ts accordingly and run `bun test tests/check-makefile.test.ts`.",
  },
];

const INVESTIGATE: InvestigateTask[] = [
  {
    kind: "investigate",
    label: "wire-to-provider",
    text:
      "In this repo, which function maps a model-registry `wire` value to an OpenCode provider " +
      "id, and in which file is it defined? Also name the constant for the provider that serves " +
      "the `responses` wire. Answer in two sentences, citing file and symbol names.",
    expect: ["opencodeProviderForWire", "opencode-server.ts", "OPENCODE_PROVIDER_RESPONSES"],
  },
  {
    kind: "investigate",
    label: "idle-watchdog",
    text:
      "Where is the OpenCode idle watchdog's timeout constant defined, what is its default value, " +
      "and which function computes the activity fingerprint it compares? Answer in two sentences, " +
      "citing file and symbol names.",
    expect: ["IDLE_TIMEOUT_MS", "opencodeActivityFingerprint", "5"],
  },
  {
    kind: "investigate",
    label: "repo-lease",
    text:
      "Which dispatch workspaces and which other job tool take the per-repo implement lease, and " +
      "in which file is the lease implemented? What happens to a second submission for the same " +
      "repo? Answer in three sentences, citing file and symbol names.",
    expect: ["repo-lease", "update_pr", "queue"],
  },
];

// ── CLI ─────────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out.set(arg.slice(2), next);
      i++;
    } else out.set(arg.slice(2), "true");
  }
  return out;
}

const sanitize = (name: string): string => name.replace(/[^a-zA-Z0-9._-]+/g, "_");
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

// ── Shell helpers ───────────────────────────────────────────────────────────────

async function capture(argv: string[], cwd: string) {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, stdout, stderr, code };
}

const git = (cwd: string, args: string[]) => capture(["git", ...args], cwd);

const ANSWER_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
} as const;

// ── Usage (attribution row written by runSession) ───────────────────────────────

const ATTR_LOG = join(
  homedir(),
  ".local",
  "share",
  "usage-tracker",
  "agent-gateway-sessions.jsonl",
);

interface Usage {
  costUsd?: number;
  turns?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

function readUsage(tool: string): Usage {
  if (!existsSync(ATTR_LOG)) return {};
  const lines = readFileSync(ATTR_LOG, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as Usage & { tool?: string };
      if (rec.tool === tool) return rec;
    } catch {
      /* skip malformed line */
    }
  }
  return {};
}

// ── Route ───────────────────────────────────────────────────────────────────────

/** Built literally (not via `routeFor`) so every arm runs exactly the model named.
 *  `fallback: null`: routing a failed arm onto Max's Sonnet would measure a different model. */
function benchRoute(model: string, kind: "implement" | "investigate" | "review"): ToolRoute {
  const effort = getModel(model)?.effort ?? [];
  const preferred = kind === "implement" ? ["max", "high"] : ["high", "max"];
  return {
    model,
    backend: "iu",
    fallback: null,
    transport: "session",
    harness: "opencode",
    variant: preferred.find((v) => effort.includes(v)),
  };
}

// ── Trees ───────────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(import.meta.dir, "..");

/** `git archive <rev>` into a fresh history-less repo with one base commit, so the worker can
 *  `git diff` its own edits but cannot `git log` its way to the fix. */
async function materializeTree(rev: string, treePath: string): Promise<void> {
  mkdirSync(treePath, { recursive: true });
  const archive = await capture(
    [
      "bash",
      "-c",
      `git -C ${shQuote(REPO_ROOT)} archive ${shQuote(rev)} | tar -x -C ${shQuote(treePath)}`,
    ],
    REPO_ROOT,
  );
  if (!archive.ok) throw new Error(`git archive ${rev} failed: ${archive.stderr}`);
  await git(treePath, ["init", "-q"]);
  await git(treePath, ["add", "-A"]);
  const commit = await capture(
    [
      "git",
      "-c",
      "user.email=bench@example.com",
      "-c",
      "user.name=bench",
      "commit",
      "-q",
      "-m",
      "base",
    ],
    treePath,
  );
  if (!commit.ok) throw new Error(`base commit failed: ${commit.stderr}`);
  const modules = join(REPO_ROOT, "node_modules");
  if (existsSync(modules))
    await capture(["ln", "-s", modules, join(treePath, "node_modules")], treePath);
}

async function changedFiles(treePath: string): Promise<string[]> {
  const tracked = await git(treePath, ["diff", "--name-only", "HEAD"]);
  const untracked = await git(treePath, ["ls-files", "--others", "--exclude-standard"]);
  const names = [...tracked.stdout.split("\n"), ...untracked.stdout.split("\n")]
    .map((s) => s.trim())
    .filter((s) => s && s !== "node_modules");
  return [...new Set(names)];
}

// ── One cell ────────────────────────────────────────────────────────────────────

interface Cell {
  model: string;
  task: string;
  kind: "implement" | "investigate" | "review";
  rep: number;
  variant: string | undefined;
  pass: boolean;
  detail: string;
  sessionOk: boolean;
  wallS: number;
  turns: number;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** cache read / (input + cache read) — how much of the prompt side was served from cache. */
  cacheHit: number | null;
  /** input + cache read + cache write on the largest-prompt measure we have (the row's totals). */
  promptTokens: number;
  tree?: string;
}

async function runCell(
  model: string,
  task: ImplementTask | InvestigateTask | ReviewTask,
  rep: number,
  outRoot: string,
): Promise<Cell> {
  const route = benchRoute(model, task.kind);
  const tool = `bench:${sanitize(model)}:${task.label}:${rep}:${randomUUID().slice(0, 8)}`;
  const treePath = join(outRoot, "runs", `${sanitize(model)}-${task.label}-${rep}`);
  await materializeTree(
    task.kind === "implement" ? task.parent : task.kind === "review" ? task.commit : "HEAD",
    treePath,
  );
  if (task.kind === "review") {
    const diff = await git(REPO_ROOT, ["show", "--format=", task.commit]);
    writeFileSync(join(treePath, "REVIEW.diff"), diff.stdout);
  }

  const sessionPrompt =
    task.kind === "review"
      ? (await loadAnglePrompt(task.angle)).replace("[GIT_DIFF_COMMAND]", "Run: `cat REVIEW.diff`")
      : task.kind === "investigate"
        ? `${task.text}\n\nReturn {"answer": "<your answer>"}.`
        : task.text;
  const started = performance.now();
  const result = await runSession<unknown>({
    cwd: treePath,
    prompt: sessionPrompt,
    tool,
    route,
    readOnly: task.kind !== "implement",
    settingSources: "user,project",
    // Investigate asks for a structured answer like production does; implement ends in a diff;
    // review uses the pipeline's own angle schema.
    ...(task.kind === "investigate"
      ? { jsonSchema: ANSWER_SCHEMA }
      : task.kind === "review"
        ? { jsonSchema: ANGLE_JSON_SCHEMA as Record<string, unknown> }
        : {}),
  });
  const wallS = (performance.now() - started) / 1000;
  const usage = readUsage(tool);

  let pass = false;
  let detail = "";
  if (task.kind === "review") {
    const data = result.data as
      | { findings?: Array<{ message?: string; file?: string }> }
      | undefined;
    const findings = data?.findings ?? [];
    const text = findings.map((f) => `${f.file ?? ""} ${f.message ?? ""}`).join("\n");
    const hit = task.hints.filter((h) => h.re.test(text)).map((h) => h.name);
    pass = result.ok && hit.length > 0;
    detail =
      `${findings.length} findings; hints ${hit.length}/${task.hints.length} (${hit.join(", ") || "none"})` +
      (result.ok ? "" : ` | session failed: ${result.error ?? "unknown"}`);
    writeFileSync(join(treePath, "findings.json"), JSON.stringify(findings, null, 2));
  } else if (task.kind === "investigate") {
    const data = result.data as { answer?: unknown } | undefined;
    const answer = `${result.rawText ?? ""}\n${typeof data?.answer === "string" ? data.answer : ""}`;
    const text = answer.trim() || (result.error ?? "");
    const missing = task.expect.filter((s) => !text.toLowerCase().includes(s.toLowerCase()));
    pass = result.ok && missing.length === 0;
    detail = missing.length ? `missing: ${missing.join(", ")}` : "all expected terms present";
    if (!result.ok) detail = `session failed: ${result.error ?? "unknown"} | ${detail}`;
  } else {
    let referenceMissing = false;
    for (const testFile of task.testFiles) {
      const show = await git(REPO_ROOT, ["show", `${task.fix}:${testFile}`]);
      if (!show.ok) referenceMissing = true;
      else writeFileSync(join(treePath, testFile), show.stdout);
    }
    if (referenceMissing) detail = "reference test unavailable";
    else {
      const tests = await capture([process.execPath, "test", ...task.testFiles], treePath);
      const files = await changedFiles(treePath);
      const fmtBin = join(REPO_ROOT, "node_modules", ".bin", "oxfmt");
      const fmt =
        files.length && existsSync(fmtBin)
          ? await capture([fmtBin, "--check", ...files], treePath)
          : null;
      pass = tests.ok && (fmt?.ok ?? true);
      detail = tests.ok
        ? `tests pass${fmt && !fmt.ok ? ", oxfmt dirty" : ""}, ${files.length} files`
        : `tests fail: ${[tests.stdout, tests.stderr].join("\n").trim().slice(-300)}`;
    }
  }

  const input = usage.inputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const promptTokens = input + cacheRead + cacheWrite;
  return {
    model,
    task: task.label,
    kind: task.kind,
    rep,
    variant: route.variant,
    pass,
    detail,
    sessionOk: result.ok,
    wallS,
    turns: usage.turns ?? 0,
    costUsd: typeof usage.costUsd === "number" ? usage.costUsd : null,
    inputTokens: input,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheHit: input + cacheRead > 0 ? cacheRead / (input + cacheRead) : null,
    promptTokens,
    tree: treePath,
  };
}

// ── Report ──────────────────────────────────────────────────────────────────────

const usd = (n: number | null) => (n === null ? "n/a" : `$${n.toFixed(4)}`);
const pct = (n: number | null) => (n === null ? "n/a" : `${Math.round(n * 100)}%`);
const median = (xs: number[]) => {
  const s = xs.toSorted((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0;
};

function render(cells: Cell[], models: string[]): string {
  const out = [
    "# Route bench",
    "",
    "| model | kind | pass | median s | mean turns | total cost | mean cost | cache-hit | max mean prompt/turn |",
    "|-|-|-|-|-|-|-|-|-|",
  ];
  for (const model of models) {
    for (const kind of ["implement", "investigate", "review"] as const) {
      const rows = cells.filter((c) => c.model === model && c.kind === kind);
      if (!rows.length) continue;
      const costs = rows.map((c) => c.costUsd).filter((c): c is number => c !== null);
      const total = costs.reduce((a, b) => a + b, 0);
      const hits = rows.map((c) => c.cacheHit).filter((c): c is number => c !== null);
      // Per-request prompt size (cumulative prompt tokens / turns): the 100K surcharge is per request.
      const maxPrompt = Math.round(
        Math.max(...rows.map((c) => (c.turns ? c.promptTokens / c.turns : 0))),
      );
      out.push(
        `| ${model} | ${kind} | ${rows.filter((c) => c.pass).length}/${rows.length} | ` +
          `${median(rows.map((c) => c.wallS)).toFixed(0)} | ` +
          `${(rows.reduce((a, c) => a + c.turns, 0) / rows.length).toFixed(1)} | ${usd(costs.length ? total : null)} | ` +
          `${usd(costs.length ? total / costs.length : null)} | ${pct(hits.length ? hits.reduce((a, b) => a + b, 0) / hits.length : null)} | ` +
          `${maxPrompt}${maxPrompt > 100_000 ? " (>100K: Haiku 5x tier)" : ""} |`,
      );
    }
  }
  out.push(
    "",
    "## Cells",
    "",
    "| model | task | rep | pass | s | turns | cost | cache-hit | detail |",
    "|-|-|-|-|-|-|-|-|-|",
  );
  for (const c of cells) {
    out.push(
      `| ${c.model} | ${c.task} | ${c.rep} | ${c.pass ? "yes" : "NO"} | ${c.wallS.toFixed(0)} | ${c.turns} | ` +
        `${usd(c.costUsd)} | ${pct(c.cacheHit)} | ${c.detail.replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 160)} |`,
    );
  }
  return out.join("\n");
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

const args = parseArgs(Bun.argv.slice(2));
const models = (args.get("models") ?? "deepseek-v4.1-flash,claude-haiku-5-5-eu,DeepSeek-V4-Pro")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const reps = Number.parseInt(args.get("reps") ?? "2", 10);
const kinds = (args.get("tasks") ?? "implement,investigate").split(",");
const concurrency = Number.parseInt(args.get("concurrency") ?? "3", 10);
const outRoot =
  args.get("out") ??
  join(
    homedir(),
    ".local",
    "share",
    "agent-gateway",
    "bench",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
mkdirSync(outRoot, { recursive: true });

const tasks = [
  ...(kinds.includes("implement") ? IMPLEMENT : []),
  ...(kinds.includes("investigate") ? INVESTIGATE : []),
  ...(kinds.includes("review") ? REVIEW : []),
];
const jobs = models.flatMap((model) =>
  tasks.flatMap((task) =>
    Array.from({ length: reps }, (_, rep) => ({ model, task, rep: rep + 1 })),
  ),
);
console.error(`[bench] ${jobs.length} cells, concurrency ${concurrency}, out ${outRoot}`);

const cells = await pool(jobs, concurrency, async ({ model, task, rep }) => {
  try {
    const cell = await runCell(model, task, rep, outRoot);
    console.error(
      `[bench] ${model} · ${task.label} #${rep}: ${cell.pass ? "pass" : "FAIL"} ${cell.wallS.toFixed(0)}s ${usd(cell.costUsd)} cache ${pct(cell.cacheHit)}`,
    );
    return cell;
  } catch (err) {
    console.error(`[bench] ${model} · ${task.label} #${rep}: setup/run threw: ${String(err)}`);
    return {
      model,
      task: task.label,
      kind: task.kind,
      rep,
      variant: undefined,
      pass: false,
      detail: `threw: ${String(err)}`,
      sessionOk: false,
      wallS: 0,
      turns: 0,
      costUsd: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheHit: null,
      promptTokens: 0,
    } satisfies Cell;
  }
});

const summary = render(cells, models);
writeFileSync(join(outRoot, "results.json"), `${JSON.stringify(cells, null, 2)}\n`);
writeFileSync(join(outRoot, "summary.md"), `${summary}\n`);
console.log(`${summary}\n\nWrote ${outRoot}/results.json and summary.md`);
