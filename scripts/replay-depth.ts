#!/usr/bin/env bun
// Depth-gating replay: what would the review router's `depth` have skipped on the done reviews
// already in jobs.db? Measurement only — reads jobs.db read-only, rebuilds each diff with git
// from the stored params, calls ONLY the router (`routeReview`, route `review_router`), and never
// submits a job. Stops at a hard IU budget.
//
//   bun scripts/replay-depth.ts                  # run, $1 budget
//   bun scripts/replay-depth.ts --budget 0.5 --limit 10
//   bun scripts/replay-depth.ts --dry-run        # rebuild diffs only, no IU calls
//
// Diffs are work content: the output table names repos and job ids, so do not commit it unless
// it is reviewed. Under-approximation caveat: `standard` assumes the floor and router angles all
// run (only OCR is off there), so a finding is "lost" at standard only when its catcher is OCR.

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { gitDiffCommand, routeReview, type ReviewDepth } from "../server/jobs/handlers/review.ts";
import { countChangedLines } from "../server/lib/ocr.ts";
import { routeFor } from "../server/lib/routing.ts";
import { usageCostUsd } from "../server/lib/models.ts";

const DB_PATH = join(homedir(), ".local/share/agent-gateway/jobs.db");
// Jobs the brief names as the two basalt-ui reviews that must come out `deep`.
const MUST_BE_DEEP = ["39014880", "f9047473"];
// Per-review projection (USD), from the brief: OCR, Haiku angles total, adversary, router.
const OCR_COST = 0.15;
const HAIKU_ANGLES_COST = 0.05;
const ADVERSARY_COST = 0.013;
const ROUTER_COST = 0.004;
// Rough per-depth projections: light runs one Haiku angle, standard the full angle set, deep all.
const PROJECTED: Record<ReviewDepth, number> = {
  light: HAIKU_ANGLES_COST / 3 + ADVERSARY_COST + ROUTER_COST,
  standard: HAIKU_ANGLES_COST + ADVERSARY_COST + ROUTER_COST,
  deep: HAIKU_ANGLES_COST + ADVERSARY_COST + ROUTER_COST + OCR_COST,
};

interface Args {
  budget: number;
  limit: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const value = (flag: string, fallback: number): number => {
    const i = argv.indexOf(flag);
    if (i === -1) return fallback;
    const n = Number(argv[i + 1]);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} needs a non-negative number`);
    return n;
  };
  return {
    budget: value("--budget", 1),
    limit: value("--limit", Number.POSITIVE_INFINITY),
    dryRun: argv.includes("--dry-run"),
  };
}

interface DoneReview {
  id: string;
  params: Record<string, unknown>;
  result: { outcome?: string; blocking?: { angle?: string; file?: string }[] } | null;
}

function loadDoneReviews(): DoneReview[] {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const rows = db
      .query(
        "SELECT id, params, result FROM jobs WHERE tool = 'review' AND status = 'done' ORDER BY created_at DESC",
      )
      .all() as { id: string; params: string; result: string | null }[];
    return rows.map((r) => ({
      id: r.id,
      params: JSON.parse(r.params) as Record<string, unknown>,
      result: r.result ? (JSON.parse(r.result) as DoneReview["result"]) : null,
    }));
  } finally {
    db.close();
  }
}

/** The diff a review saw, rebuilt from git. Null with a reason when it cannot be rebuilt here
 *  (uncommitted working changes are gone; a PR head that is no local ref cannot be fetched — this
 *  script never runs a remote operation). */
function rebuildDiff(params: Record<string, unknown>): { diff: string } | { skip: string } {
  const cwd = String(params.cwd ?? "");
  let command: string;
  if (typeof params.pr === "number") {
    const head = `refs/pull/${params.pr}/head`;
    if (!gitOk(cwd, ["rev-parse", "--verify", "-q", head])) return { skip: `no local ${head}` };
    const base = gitOut(cwd, ["merge-base", "master", head]);
    if (!base) return { skip: "no merge-base with master" };
    command = `git diff ${base} ${head}`;
  } else if (typeof params.branch === "string") {
    return { skip: "branch scope needs an origin fetch; not run here" };
  } else {
    const scope = typeof params.scope === "string" ? params.scope : "uncommitted";
    if (scope === "uncommitted") return { skip: "uncommitted working changes are not stored" };
    command = gitDiffCommand(scope);
  }
  const run = Bun.spawnSync(["bash", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) return { skip: `git exited ${run.exitCode}` };
  const diff = run.stdout.toString();
  return diff.trim() ? { diff } : { skip: "empty diff now" };
}

function gitOk(cwd: string, args: string[]): boolean {
  return (
    Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" }).exitCode === 0
  );
}

function gitOut(cwd: string, args: string[]): string | null {
  const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  return run.exitCode === 0 ? run.stdout.toString().trim() : null;
}

/** Whether a finding's catcher runs at this depth under gating. */
function catcherRuns(depth: ReviewDepth, angle: string): boolean {
  if (angle === "adversary" || angle === "fallow" || angle === "react-doctor") return true;
  if (depth === "deep") return true;
  if (depth === "light") return angle === "senior-dev";
  return angle !== "ocr";
}

interface Row {
  id: string;
  repo: string;
  changedLines: number;
  depth: ReviewDepth | "-";
  source: string;
  blocking: number;
  catchers: string;
  lost: number;
  note: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const reviews = loadDoneReviews();
  const ordered = [
    ...reviews.filter((r) => MUST_BE_DEEP.some((id) => r.id.startsWith(id))),
    ...reviews.filter((r) => !MUST_BE_DEEP.some((id) => r.id.startsWith(id))),
  ].slice(0, args.limit);

  const routerModel = routeFor("review_router").model;
  let spent = 0;
  const rows: Row[] = [];
  let skipped = 0;

  for (const review of ordered) {
    const repo =
      String(review.params.cwd ?? "")
        .split("/")
        .pop() ?? "?";
    const built = rebuildDiff(review.params);
    if ("skip" in built) {
      skipped++;
      rows.push({
        id: review.id.slice(0, 8),
        repo,
        changedLines: 0,
        depth: "-",
        source: "-",
        blocking: review.result?.blocking?.length ?? 0,
        catchers: "-",
        lost: 0,
        note: `skipped: ${built.skip}`,
      });
      continue;
    }
    const changedLines = countChangedLines(built.diff);
    const blocking = review.result?.blocking ?? [];
    if (args.dryRun) {
      rows.push({
        id: review.id.slice(0, 8),
        repo,
        changedLines,
        depth: "-",
        source: "dry-run",
        blocking: blocking.length,
        catchers: "-",
        lost: 0,
        note: "",
      });
      continue;
    }
    if (spent >= args.budget) {
      rows.push({
        id: review.id.slice(0, 8),
        repo,
        changedLines,
        depth: "-",
        source: "-",
        blocking: blocking.length,
        catchers: "-",
        lost: 0,
        note: "budget reached",
      });
      continue;
    }
    const routed = await routeReview(built.diff);
    const usd = routed.usage
      ? (usageCostUsd(routerModel, {
          inputTokens: routed.usage.inputTokens,
          outputTokens: routed.usage.outputTokens,
          reasoningTokens: routed.usage.reasoningTokens,
          cacheReadTokens: routed.usage.cacheReadTokens,
        }) ?? ROUTER_COST)
      : 0;
    spent += usd;
    const depth: ReviewDepth = routed.depth ?? "deep";
    const catchers = [...new Set(blocking.map((f) => f.angle ?? "?"))];
    const lostFindings = blocking.filter((f) => !catcherRuns(depth, f.angle ?? "?"));
    rows.push({
      id: review.id.slice(0, 8),
      repo,
      changedLines,
      depth: routed.depth ?? "-",
      source: routed.depth ? "router" : "fallback",
      blocking: blocking.length,
      catchers: catchers.join(",") || "-",
      lost: lostFindings.length,
      note: routed.depthReason ?? "",
    });
  }

  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  console.log(
    `${pad("job", 10)}${pad("repo", 14)}${pad("lines", 7)}${pad("depth", 10)}${pad("blk", 5)}${pad("lost", 6)}${pad("catchers", 34)}note`,
  );
  for (const r of rows) {
    console.log(
      `${pad(r.id, 10)}${pad(r.repo, 14)}${pad(r.changedLines, 7)}${pad(r.depth, 10)}${pad(r.blocking, 5)}${pad(r.lost, 6)}${pad(r.catchers, 34)}${r.note}`,
    );
  }

  const routedRows = rows.filter((r) => r.depth !== "-");
  const totalLost = rows.reduce((n, r) => n + r.lost, 0);
  const mustBeDeep = routedRows.filter((r) => MUST_BE_DEEP.some((id) => r.id === id.slice(0, 8)));
  const mustDeepOk = mustBeDeep.length > 0 && mustBeDeep.every((r) => r.depth === "deep");
  const projected = routedRows.length
    ? routedRows.reduce((n, r) => n + PROJECTED[r.depth as ReviewDepth], 0) / routedRows.length
    : 0;
  console.log("");
  console.log(
    `reviews: ${ordered.length} · routed: ${routedRows.length} · skipped: ${skipped} · blocking findings lost under gating: ${totalLost} (target 0)`,
  );
  console.log(
    `must-be-deep (basalt-ui 510, 530): ${mustBeDeep.length ? (mustDeepOk ? "ok" : "NOT deep") : "not routed"}`,
  );
  console.log(
    `projected per-review cost: $${projected.toFixed(3)} (deep $${PROJECTED.deep.toFixed(3)} incl. OCR ~$${OCR_COST}; Haiku angles ~$${HAIKU_ANGLES_COST}, adversary ~$${ADVERSARY_COST}, router ~$${ROUTER_COST})`,
  );
  console.log(`router IU spend: $${spent.toFixed(4)} of $${args.budget.toFixed(2)} budget`);
}

await main();
