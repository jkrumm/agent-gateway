#!/usr/bin/env bun
// Times the `check` job's LLM path (explicit `commands`, a worker runs them and reports JSON) on
// whatever model `check` currently routes to — the repo-contract `make check` path has no model in
// the loop. Run once per candidate:
//   AGENT_GATEWAY_MODEL_CHECK=claude-haiku-5-5-eu bun scripts/bench-check.ts [reps]
// Prints one line per run (wall seconds, ok, step verdicts) and a median; the attribution row
// `runSession` writes carries cost and tokens (tool "check").

import { resolve } from "node:path";
import { runCheck } from "../server/jobs/handlers/check.ts";
import { routeFor } from "../server/lib/routing.ts";

const reps = Number.parseInt(Bun.argv[2] ?? "3", 10);
if (!Number.isInteger(reps) || reps < 1)
  throw new Error(`reps must be a positive integer, got "${Bun.argv[2]}"`);
const cwd = resolve(import.meta.dir, "..");
const commands = ["bun run format:check", "bun run lint", "bun run typecheck"];
console.error(`route: ${JSON.stringify(routeFor("check"))}`);

const secs: number[] = [];
for (let i = 1; i <= reps; i++) {
  const t = performance.now();
  try {
    const out = await runCheck({ cwd, commands });
    const s = (performance.now() - t) / 1000;
    secs.push(s);
    console.log(
      `run ${i}: ${s.toFixed(1)}s passed=${out.passed} ${out.steps.map((x) => `${x.name}:${x.passed ? "ok" : "FAIL"}`).join(" ")}`,
    );
  } catch (err) {
    console.log(`run ${i}: threw ${String(err).slice(0, 200)}`);
  }
}
const sorted = secs.toSorted((a, b) => a - b);
console.log(
  `median ${sorted[Math.floor((sorted.length - 1) / 2)]?.toFixed(1) ?? "n/a"}s over ${secs.length}`,
);
