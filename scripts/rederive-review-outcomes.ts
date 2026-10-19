// Re-derives review outcomes from stored `result` objects with the code-side verdict rules
// (deriveOutcome + capImprovements, server/jobs/handlers/review.ts) and prints the outcome
// distribution before vs after. Offline: no server, no model. It only re-applies the rules to the
// OLD findings — prompt changes (blocking bar, adversary verification) cannot be replayed here.
//   bun scripts/rederive-review-outcomes.ts <corpus.jsonl>
// Each line is a JSON object with a `result` (the review verdict). A failed reviewer is recognised
// by its `(review pipeline)` discussion, the marker the handler writes.
import { applyVerdictRules } from "../server/jobs/handlers/review.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun scripts/rederive-review-outcomes.ts <corpus.jsonl>");
  process.exit(2);
}

type Finding = { file: string; message: string; angle: string };
type Verdict = Parameters<typeof applyVerdictRules>[0];

const lines = (await Bun.file(path).text()).split("\n").filter((l) => l.trim());
const before: Record<string, number> = {};
const after: Record<string, number> = {};
const transitions: Record<string, number> = {};
let improvementsBefore = 0;
let improvementsAfter = 0;
let reviews = 0;
let adversaryOnly = 0;

for (const line of lines) {
  const result = (JSON.parse(line) as { result?: Verdict }).result;
  if (!result) continue;
  reviews++;
  const verdict = structuredClone(result);
  const failed = (verdict.discussions as Finding[])
    .filter((d) => d.file === "(review pipeline)")
    .map((d) => ({ angle: d.angle, failureReason: "n/a" }));
  improvementsBefore += verdict.improvements.length;
  applyVerdictRules(verdict, failed, failed.length);
  improvementsAfter += verdict.improvements.length;
  const blocking = verdict.blocking as Finding[];
  if (verdict.outcome === "actionable" && blocking.every((f) => f.angle === "adversary"))
    adversaryOnly++;
  before[result.outcome] = (before[result.outcome] ?? 0) + 1;
  after[verdict.outcome] = (after[verdict.outcome] ?? 0) + 1;
  const key = `${result.outcome} -> ${verdict.outcome}`;
  transitions[key] = (transitions[key] ?? 0) + 1;
}

console.log(`reviews: ${reviews}`);
console.log("outcome before:", before);
console.log("outcome after: ", after);
console.log("transitions:   ", transitions);
console.log(
  `actionable only because of adversary blocking (would flip if all were dropped as unconfirmed): ${adversaryOnly}`,
);
console.log(
  `improvements per review: ${(improvementsBefore / reviews).toFixed(1)} before, ${(improvementsAfter / reviews).toFixed(1)} after`,
);
