#!/usr/bin/env bun
// Frontend-angle bench (Wave 11): the review `frontend` angle over real weatherorb commits, two
// arms — Haiku 5.5 EU on OpenCode vs the Sonnet-on-Max route the angle ships on today. Drives
// `runSession` directly with the pipeline's own angle prompt and schema, like bench-routes'
// review path. Costs IU tokens and Max quota; never run from CI.
//
//   bun scripts/bench-frontend.ts [--arms a,b] [--reps 2] [--concurrency 3] [--out dir]
//
// No regex hints: judging is done by a human afterwards. Per cell the run writes `findings.json`
// (the validated findings) and `meta.json`; per commit `pooled-<commit>.md` lists every finding
// of both arms numbered and tagged arm+rep for side-by-side reading; `summary.md` is the table.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ANGLE_JSON_SCHEMA,
  ANGLE_OUTPUT,
  loadAnglePrompt,
} from "../server/jobs/handlers/review.ts";
import { HAIKU_5_5, SONNET, type ToolRoute } from "../server/lib/routing.ts";
import { runSession } from "../server/mcp/session-runner.ts";

// ── Fixed inputs ────────────────────────────────────────────────────────────────

const SOURCE_REPO = join(homedir(), "SourceRoot", "weatherorb");
const COMMITS = ["5de4e2d", "6264775", "4ea52bf"];
const ANGLE = "frontend";

/** Built literally (not via `routeFor`) so every arm runs exactly the route named.
 *  A: Haiku 5.5 EU on OpenCode, no fallback (a fallback would measure a different model).
 *  B: `review_angle_frontend`'s default route (routing.ts JUDGE) verbatim — Sonnet on Max over
 *  `claude -p`, with its IU fallback. */
const ARMS = {
  a: {
    model: HAIKU_5_5,
    backend: "iu",
    fallback: null,
    transport: "session",
    harness: "opencode",
  },
  b: {
    model: SONNET,
    backend: "max",
    fallback: { backend: "iu" },
    transport: "session",
    harness: "claude",
  },
} as const satisfies Record<string, ToolRoute>;

type ArmId = keyof typeof ARMS;

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

// ── Trees ───────────────────────────────────────────────────────────────────────

/** `git archive <rev>` of the source repo into a fresh history-less repo with one base commit,
 *  so the worker can `git diff` its own edits but cannot `git log` its way to later fixes. */
async function materializeTree(rev: string, treePath: string): Promise<void> {
  mkdirSync(treePath, { recursive: true });
  const archive = await capture(
    [
      "bash",
      "-c",
      `git -C ${shQuote(SOURCE_REPO)} archive ${shQuote(rev)} | tar -x -C ${shQuote(treePath)}`,
    ],
    SOURCE_REPO,
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
  const modules = join(SOURCE_REPO, "node_modules");
  if (existsSync(modules))
    await capture(["ln", "-s", modules, join(treePath, "node_modules")], treePath);
}

// ── One cell ────────────────────────────────────────────────────────────────────

interface Finding {
  severity: "blocking" | "improvement" | "discussion";
  file: string;
  line?: number;
  message: string;
}

interface Cell {
  arm: ArmId;
  model: string;
  commit: string;
  rep: number;
  sessionOk: boolean;
  error: string | null;
  findings: Finding[];
  wallS: number;
  turns: number;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** cache read / (input + cache read) — how much of the prompt side was served from cache. */
  cacheHit: number | null;
}

async function runCell(arm: ArmId, commit: string, rep: number, outRoot: string): Promise<Cell> {
  const route: ToolRoute = ARMS[arm];
  const tool = `bench:frontend:${arm}:${commit}:${rep}:${randomUUID().slice(0, 8)}`;
  const cellDir = join(outRoot, `${arm}-${commit}-${rep}`);
  const treePath = join(cellDir, "tree");
  await materializeTree(commit, treePath);
  const diff = await git(SOURCE_REPO, ["diff", `${commit}~1`, commit]);
  if (!diff.ok) throw new Error(`git diff ${commit} failed: ${diff.stderr}`);
  writeFileSync(join(treePath, "REVIEW.diff"), diff.stdout);

  const prompt = (await loadAnglePrompt(ANGLE)).replace(
    "[GIT_DIFF_COMMAND]",
    "Run: `cat REVIEW.diff`",
  );
  const started = performance.now();
  const result = await runSession<unknown>({
    cwd: treePath,
    prompt,
    tool,
    route,
    readOnly: true,
    settingSources: "user,project",
    jsonSchema: ANGLE_JSON_SCHEMA as Record<string, unknown>,
  });
  const wallS = (performance.now() - started) / 1000;
  const usage = readUsage(tool);

  const parsed = ANGLE_OUTPUT.safeParse(result.data);
  const findings: Finding[] = parsed.success ? parsed.data.findings : [];
  const error = result.ok
    ? parsed.success
      ? null
      : `output failed schema validation: ${parsed.error.message.slice(0, 200)}`
    : (result.error ?? "unknown");
  writeFileSync(join(cellDir, "findings.json"), `${JSON.stringify(findings, null, 2)}\n`);

  const input = usage.inputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cell: Cell = {
    arm,
    model: route.model,
    commit,
    rep,
    sessionOk: result.ok,
    error,
    findings,
    wallS,
    turns: usage.turns ?? 0,
    costUsd: typeof usage.costUsd === "number" ? usage.costUsd : null,
    inputTokens: input,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheHit: input + cacheRead > 0 ? cacheRead / (input + cacheRead) : null,
  };
  const { findings: _findings, ...meta } = cell;
  writeFileSync(join(cellDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return cell;
}

// ── Report ──────────────────────────────────────────────────────────────────────

const usd = (n: number | null) => (n === null ? "n/a" : `$${n.toFixed(4)}`);
const median = (xs: number[]) => {
  const s = xs.toSorted((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0;
};

function render(cells: Cell[], arms: ArmId[]): string {
  const out = [
    "# Frontend angle bench",
    "",
    "| arm | model | commit | runs ok | findings (per rep) | median s | total cost |",
    "|-|-|-|-|-|-|-|",
  ];
  for (const arm of arms) {
    for (const commit of COMMITS) {
      const rows = cells.filter((c) => c.arm === arm && c.commit === commit);
      if (!rows.length) continue;
      const costs = rows.map((c) => c.costUsd).filter((c): c is number => c !== null);
      out.push(
        `| ${arm.toUpperCase()} | ${ARMS[arm].model} | ${commit} | ${rows.filter((c) => c.sessionOk && !c.error).length}/${rows.length} | ` +
          `${rows.reduce((a, c) => a + c.findings.length, 0)} (${rows.map((c) => c.findings.length).join("/")}) | ` +
          `${median(rows.map((c) => c.wallS)).toFixed(0)} | ${usd(costs.length ? costs.reduce((a, b) => a + b, 0) : null)} |`,
      );
    }
  }
  const failed = cells.filter((c) => c.error);
  if (failed.length) {
    out.push("", "## Failed cells", "");
    for (const c of failed)
      out.push(
        `- ${c.arm.toUpperCase()} ${c.commit} #${c.rep}: ${c.error!.replace(/\n/g, " ").slice(0, 200)}`,
      );
  }
  return out.join("\n");
}

function renderPooled(cells: Cell[], commit: string): string {
  const out = [
    `# Pooled frontend findings — weatherorb ${commit}`,
    "",
    "Each finding is tagged arm+rep (A = Haiku 5.5 EU on OpenCode, B = Sonnet on Max).",
    "",
  ];
  let n = 0;
  for (const c of cells.filter((x) => x.commit === commit)) {
    for (const f of c.findings) {
      n++;
      const loc = f.line === undefined ? f.file : `${f.file}:${f.line}`;
      out.push(
        `## ${n}. [${c.arm.toUpperCase()}#${c.rep}] ${f.severity} — ${loc}`,
        "",
        f.message,
        "",
      );
    }
  }
  if (n === 0) out.push("_No findings from either arm._", "");
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
const arms = (args.get("arms") ?? "a,b")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)
  .map((s): ArmId => {
    if (s === "a" || s === "b") return s;
    throw new Error(`unknown arm "${s}" (expected a or b)`);
  });
const reps = Number.parseInt(args.get("reps") ?? "2", 10);
const concurrency = Number.parseInt(args.get("concurrency") ?? "3", 10);
const outRoot =
  args.get("out") ??
  join(homedir(), ".local", "share", "agent-gateway", "bench", "wave11", "frontend");
mkdirSync(outRoot, { recursive: true });

const jobs = arms.flatMap((arm) =>
  COMMITS.flatMap((commit) =>
    Array.from({ length: reps }, (_, rep) => ({ arm, commit, rep: rep + 1 })),
  ),
);
console.error(`[bench] ${jobs.length} cells, concurrency ${concurrency}, out ${outRoot}`);

const cells = await pool(jobs, concurrency, async ({ arm, commit, rep }) => {
  try {
    const cell = await runCell(arm, commit, rep, outRoot);
    console.error(
      `[bench] ${arm.toUpperCase()} · ${commit} #${rep}: ${cell.error ? `FAIL (${cell.error.slice(0, 80)})` : "ok"} ` +
        `${cell.findings.length} findings ${cell.wallS.toFixed(0)}s ${usd(cell.costUsd)}`,
    );
    return cell;
  } catch (err) {
    console.error(
      `[bench] ${arm.toUpperCase()} · ${commit} #${rep}: setup/run threw: ${String(err)}`,
    );
    return {
      arm,
      model: ARMS[arm].model,
      commit,
      rep,
      sessionOk: false,
      error: `threw: ${String(err)}`,
      findings: [],
      wallS: 0,
      turns: 0,
      costUsd: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheHit: null,
    } satisfies Cell;
  }
});

for (const commit of COMMITS)
  writeFileSync(join(outRoot, `pooled-${commit}.md`), `${renderPooled(cells, commit)}\n`);
const summary = render(cells, arms);
writeFileSync(join(outRoot, "summary.md"), `${summary}\n`);
console.log(`${summary}\n\nWrote ${outRoot}/summary.md and pooled-<commit>.md`);
