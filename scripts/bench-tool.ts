#!/usr/bin/env bun
// One fixed real input per claude-harness tool, run through the production handler on whatever
// route the env selects (routes are read at module load, so one process = one candidate):
//   AGENT_GATEWAY_MODEL_OVERVIEW=claude-haiku-5-5-eu AGENT_GATEWAY_HARNESS_OVERVIEW=opencode \
//     bun scripts/bench-tool.ts overview [--reps 2] [--out dir]
// Tools: overview, narrative, excalidraw, editorial (dispatch kind=editorial, in-place on
// dispatch-scratch), review (the synthesis route; angles keep their own routes).
// Each rep prints one JSON line (wall, ok, cost from the attribution rows written during the rep,
// a tool-specific quality probe) and saves the full output under <out>/ for a blind read.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { routeFor, type RoutedTool } from "../server/lib/routing.ts";

const args = Bun.argv.slice(2);
const tool = args[0] ?? "";
const flag = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? dflt) : dflt;
};
const reps = Number.parseInt(flag("reps", "2"), 10);
const outDir = flag("out", join(homedir(), ".local/share/agent-gateway/bench/wave10"));
mkdirSync(outDir, { recursive: true });

const SRC = resolve(import.meta.dir, "..", "..");
const ATTR_LOG = join(homedir(), ".local/share/usage-tracker/agent-gateway-sessions.jsonl");

interface AttrRow {
  tool?: string;
  costUsd?: number;
  turns?: number;
  tsStart?: string;
}
/** Attribution rows whose session started at or after `sinceMs`, optionally for one tool name. */
function rowsSince(sinceMs: number, toolName?: string): AttrRow[] {
  if (!existsSync(ATTR_LOG)) return [];
  const rows: AttrRow[] = [];
  for (const line of readFileSync(ATTR_LOG, "utf8").trimEnd().split("\n").slice(-400)) {
    try {
      const r = JSON.parse(line) as AttrRow;
      if (r.tsStart && Date.parse(r.tsStart) >= sinceMs && (!toolName || r.tool === toolName))
        rows.push(r);
    } catch {
      /* skip */
    }
  }
  return rows;
}

interface Rep {
  output: unknown;
  /** Attribution tool name whose rows carry this tool's cost. */
  attrTool: string;
  probe: Record<string, unknown>;
}

const TOOLS: Record<string, { route: RoutedTool; run: (rep: number) => Promise<Rep> }> = {
  overview: {
    route: "overview",
    run: async () => {
      const { runOverview } = await import("../server/jobs/handlers/overview.ts");
      const out = await runOverview({});
      const agents = out.agents;
      const recs = agents.filter((a) => !a.synthesized);
      return {
        output: out,
        attrTool: "overview",
        probe: {
          agents: agents.length,
          answeredByWorker: recs.length,
          recommendations: Object.fromEntries(recs.map((a) => [a.id, a.recommendation])),
        },
      };
    },
  },
  narrative: {
    route: "narrative",
    run: async () => {
      const { runNarrative } = await import("../server/jobs/handlers/narrative.ts");
      const out = await runNarrative({
        cwd: join(SRC, "agent-gateway"),
        project: "agent-gateway",
        previousPage: null,
        since: null,
      });
      const page = (out as { page?: string | null }).page ?? "";
      return {
        output: out,
        attrTool: "narrative",
        probe: { changed: (out as { changed?: boolean }).changed, pageChars: page?.length ?? 0 },
      };
    },
  },
  excalidraw: {
    route: "excalidraw",
    run: async (rep) => {
      const { runExcalidrawDiagram } =
        await import("../server/jobs/handlers/excalidraw-diagram.ts");
      const outputPath = join(tmpdir(), `bench-excalidraw-${process.pid}-${rep}.excalidraw`);
      const out = await runExcalidrawDiagram({
        prompt:
          "Flow diagram: a dispatch request enters the agw HTTP server, is queued in the job " +
          "store (sqlite), a worker session runs on the shared OpenCode server, the handler " +
          "pushes a branch and opens a draft PR. Show a drain/detach arrow from the HTTP server " +
          "to the OpenCode server labelled 're-attach on boot'. 7-9 boxes, left to right.",
        outputPath,
      });
      const file = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
      const elements = file ? ((JSON.parse(file) as { elements?: unknown[] }).elements ?? []) : [];
      return {
        output: { out, file },
        attrTool: "excalidraw-diagram",
        probe: { elements: elements.length, bytes: file.length },
      };
    },
  },
  editorial: {
    route: "dispatch_editorial",
    run: async () => {
      const scratch = join(SRC, "dispatch-scratch");
      const { runDispatch } = await import("../server/jobs/handlers/dispatch.ts");
      const out = await runDispatch({
        cwd: scratch,
        tier: "implement",
        workspace: "in-place",
        kind: "editorial",
        brief:
          "Rewrite the paragraph in README.md that starts 'Disposable scratch repo' and the " +
          "paragraph after the bold line so the file opens with ONE tight paragraph (max 60 words) " +
          "that says what this repo is, who deletes what and when, and where the reset steps live " +
          "(NOTES.md). Keep the 'Session settings fixture' section untouched. Plain prose, no " +
          "emoji, no marketing words.",
      });
      const diff = execFileSync("git", ["-C", scratch, "diff"], { encoding: "utf8" });
      execFileSync("git", ["-C", scratch, "checkout", "--", "."]);
      execFileSync("git", ["-C", scratch, "clean", "-fdq"]);
      return {
        output: { out, diff },
        attrTool: "dispatch",
        probe: { outcome: (out as { outcome?: string }).outcome, diffChars: diff.length },
      };
    },
  },
  // A second editorial brief with a mechanical grade (numbered steps, word cap, one removed
  // sentence) — editorial #1 is graded by reading the diff.
  editorial2: {
    route: "dispatch_editorial",
    run: async () => {
      const scratch = join(SRC, "dispatch-scratch");
      const { runDispatch } = await import("../server/jobs/handlers/dispatch.ts");
      const out = await runDispatch({
        cwd: scratch,
        tier: "implement",
        workspace: "in-place",
        kind: "editorial",
        brief:
          "Rewrite NOTES.md as: the existing one-sentence purpose, then under '## Resetting this " +
          "repo' a numbered list of exactly 4 steps — delete leftover dispatch/* branches locally, " +
          "delete them on the remote, close stale draft PRs, confirm `git status` is clean — each " +
          "step ONE imperative sentence of at most 12 words. Remove the sentence starting " +
          "'Periodic housekeeping'. Change nothing else.",
      });
      const notes = readFileSync(join(scratch, "NOTES.md"), "utf8");
      const steps = notes.split("\n").filter((l) => /^\d+\.\s/.test(l));
      const graded = {
        fourSteps: steps.length === 4,
        wordCap: steps.every((l) => l.replace(/^\d+\.\s*/, "").split(/\s+/).length <= 12),
        removed: !/Periodic housekeeping/.test(notes),
      };
      const diff = execFileSync("git", ["-C", scratch, "diff"], { encoding: "utf8" });
      execFileSync("git", ["-C", scratch, "checkout", "--", "."]);
      execFileSync("git", ["-C", scratch, "clean", "-fdq"]);
      return {
        output: { out, diff },
        attrTool: "dispatch",
        probe: {
          outcome: (out as { outcome?: string }).outcome,
          ...graded,
          pass: Object.values(graded).every(Boolean),
        },
      };
    },
  },
  review: {
    route: "review",
    run: async () => {
      const { runReview } = await import("../server/jobs/handlers/review.ts");
      const out = (await runReview({
        cwd: join(SRC, "agent-gateway"),
        scope: flag("scope", "HEAD~2"),
      })) as {
        outcome?: string;
        blocking?: unknown[];
        improvements?: unknown[];
        discussions?: unknown[];
        testGaps?: unknown[];
      };
      return {
        output: out,
        attrTool: "review:synthesis",
        probe: {
          outcome: out.outcome,
          blocking: out.blocking?.length,
          improvements: out.improvements?.length,
          discussions: out.discussions?.length,
          testGaps: out.testGaps?.length,
        },
      };
    },
  },
};

const spec = TOOLS[tool];
if (!spec) {
  console.error(`usage: bench-tool.ts <${Object.keys(TOOLS).join("|")}> [--reps N] [--out dir]`);
  process.exit(2);
}
const route = routeFor(spec.route);
const label = `${tool}-${route.model.replace(/[^a-z0-9.-]/gi, "_")}-${route.harness}${args.includes("--scope") ? `-${flag("scope", "").replace(/[^a-z0-9]/gi, "")}` : ""}`;
console.error(`route: ${route.model} ${route.harness} ${route.backend}`);

for (let rep = 1; rep <= reps; rep++) {
  const t = performance.now();
  const startMs = Date.now() - 1000;
  try {
    const r = await spec.run(rep);
    const wall = Number(((performance.now() - t) / 1000).toFixed(1));
    const rows = rowsSince(startMs, r.attrTool);
    writeFileSync(join(outDir, `${label}-${rep}.json`), JSON.stringify(r.output, null, 2));
    console.log(
      JSON.stringify({
        label,
        rep,
        ok: true,
        wall,
        costUsd: Number(rows.reduce((s, x) => s + (x.costUsd ?? 0), 0).toFixed(5)),
        turns: rows.reduce((s, x) => s + (x.turns ?? 0), 0),
        ...r.probe,
      }),
    );
  } catch (err) {
    console.log(
      JSON.stringify({
        label,
        rep,
        ok: false,
        wall: Number(((performance.now() - t) / 1000).toFixed(1)),
        error: String(err).slice(0, 300),
      }),
    );
  }
}
