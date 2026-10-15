#!/usr/bin/env bun
// Times the `check` job's LLM path (explicit `commands`, a worker runs them and reports JSON) on
// whatever route `check` currently resolves to — the repo-contract `make check` path has no model
// in the loop. Run once per candidate, the route chosen by env (read at module load):
//   bun scripts/bench-check.ts [--reps 2] [--repos agent-gateway,warden,email-gateway]
//   AGENT_GATEWAY_MODEL_CHECK=claude-haiku-5-5-eu AGENT_GATEWAY_HARNESS_CHECK=opencode bun scripts/bench-check.ts
//
// Per repo two cells: `clean` (the live checkout — must pass) and `broken` (an APFS clone in
// $TMPDIR with one injected defect — must fail, naming a step). A cell is `correct` when the
// verdict matches that ground truth. The attribution row `runSession` writes carries cost.
// Output: one JSON line per cell on stdout, a summary on stderr.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCheck } from "../server/jobs/handlers/check.ts";
import { routeFor } from "../server/lib/routing.ts";

interface RepoSpec {
  name: string;
  commands: string[];
  /** File (relative) the broken variant appends `defect` to. */
  breakFile: string;
  defect: string;
}

const SRC = resolve(import.meta.dir, "..", "..");
const REPOS: RepoSpec[] = [
  {
    name: "agent-gateway",
    commands: ["bun run format:check", "bun run lint", "bun run typecheck"],
    breakFile: "server/lib/health.ts",
    defect: '\nexport const __benchBroken: number = "not a number";\n',
  },
  {
    name: "warden",
    commands: ["make compile", ".venv/bin/python tests/test_shadow.py"],
    breakFile: "scripts/lifecycle/shadow.py",
    defect: "\ndef __bench_broken(:\n    pass\n",
  },
  {
    name: "email-gateway",
    commands: ["bun run typecheck", "bun test src/llm"],
    breakFile: "src/llm/jev.ts",
    defect: '\nexport const __benchBroken: number = "not a number";\n',
  },
];

const args = Bun.argv.slice(2);
const flag = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? dflt) : dflt;
};
const reps = Number.parseInt(flag("reps", "2"), 10);
const only = new Set(flag("repos", REPOS.map((r) => r.name).join(",")).split(","));

const ATTR_LOG = join(homedir(), ".local/share/usage-tracker/agent-gateway-sessions.jsonl");
function lastUsage(): { costUsd?: number; turns?: number; model?: string } {
  if (!existsSync(ATTR_LOG)) return {};
  const lines = readFileSync(ATTR_LOG, "utf8").trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const r = JSON.parse(lines[i] ?? "") as { tool?: string; costUsd?: number; turns?: number };
      if (r.tool === "check") return r;
    } catch {
      /* skip */
    }
  }
  return {};
}

const route = routeFor("check");
console.error(`route: ${route.model} ${route.harness} ${route.backend}`);
const scratch = mkdtempSync(join(tmpdir(), "bench-check-"));
const results: Array<{ wall: number; correct: boolean; cost: number }> = [];

try {
  for (const repo of REPOS.filter((r) => only.has(r.name))) {
    const live = join(SRC, repo.name);
    if (!existsSync(live)) continue;
    const broken = join(scratch, repo.name);
    // APFS clone (instant, no space) with a plain-copy fallback for other filesystems.
    try {
      execFileSync("cp", ["-cR", live, broken]);
    } catch {
      execFileSync("cp", ["-R", live, broken]);
    }
    appendFileSync(join(broken, repo.breakFile), repo.defect);
    for (const [variant, cwd, expectPass] of [
      ["clean", live, true],
      ["broken", broken, false],
    ] as const) {
      for (let rep = 1; rep <= reps; rep++) {
        const t = performance.now();
        let passed: boolean | undefined;
        let note = "";
        try {
          const out = await runCheck({ cwd, commands: repo.commands });
          passed = out.passed;
          note = out.steps.map((s) => `${s.name}:${s.passed ? "ok" : "FAIL"}`).join(" ");
        } catch (err) {
          note = `threw ${String(err).slice(0, 160)}`;
        }
        const wall = (performance.now() - t) / 1000;
        const u = lastUsage();
        const correct = passed === expectPass;
        results.push({ wall, correct, cost: u.costUsd ?? 0 });
        console.log(
          JSON.stringify({
            route: `${route.model}/${route.harness}`,
            repo: repo.name,
            variant,
            rep,
            wall: Number(wall.toFixed(1)),
            passed,
            correct,
            turns: u.turns,
            costUsd: u.costUsd,
            note,
          }),
        );
      }
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const walls = results.map((r) => r.wall).toSorted((a, b) => a - b);
console.error(
  `summary ${route.model}/${route.harness}: correct ${results.filter((r) => r.correct).length}/${results.length}, ` +
    `median ${walls[Math.floor((walls.length - 1) / 2)]?.toFixed(1)}s, ` +
    `cost $${results.reduce((s, r) => s + r.cost, 0).toFixed(4)}`,
);
