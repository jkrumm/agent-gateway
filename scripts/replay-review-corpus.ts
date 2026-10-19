#!/usr/bin/env bun
// Model A/B replay of the review pipeline over a frozen corpus. Measurement only: nothing here
// touches server code. Each corpus item × arm is submitted as a real `review` job through the
// gateway's HTTP API (the route `agw review` uses) with the item's original params plus the arm's
// `model` override; only angles + synthesis vary, the router/OCR/adversary keep their routes.
//
//   bun scripts/replay-review-corpus.ts --dry-run --arms baseline,deepseek-v4.1-flash --sample 20
//   bun scripts/replay-review-corpus.ts --arms baseline,deepseek-v4.1-flash --sample 20
//   bun scripts/replay-review-corpus.ts --resume <dir>
//
// The corpus and every output hold work diffs: keep them local, never commit them.
// Outputs: <out>/cells/<item>__<arm>.json (full job JSON, persisted per job), <out>/summary.{md,json},
// <out>/pooled/<item>.md (blinded side-by-side) and <out>/key.json (letter → arm, never pooled).
// Agreement numbers are approximate agreement between arms, not accuracy: corpus PR heads drift.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isTerminal, type JobStatus } from "../server/jobs/types.ts";

const DEFAULT_URL = "http://127.0.0.1:7705";
const CORPUS_DEFAULT = join(
  homedir(),
  ".local/share/agent-gateway/bench/review-corpus-2026-10-19/corpus.jsonl",
);
const BENCH_ROOT = join(homedir(), ".local/share/agent-gateway/bench");
export const BASELINE = "baseline";
const SAMPLE_SEED = "review-replay-v1";
const LINE_TOLERANCE = 5;
const POLL_MS = 5_000;
const POLL_FAILURE_LIMIT = 60;
// The review job's own input keys (server/jobs/handlers/review.ts REVIEW_INPUT). Anything else in a
// recorded params object is dropped rather than submitted into a schema that would reject it.
const REVIEW_PARAM_KEYS = ["cwd", "scope", "pr", "branch", "context", "angles", "model"] as const;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Finding {
  file: string;
  line?: number;
  message: string;
  angle?: string;
}

export interface ReviewLike {
  outcome?: string;
  blocking?: Finding[];
  improvements?: Finding[];
}

export interface CorpusItem {
  jobId: string;
  createdAt: string;
  repo: string;
  kind: string;
  params: Record<string, unknown>;
  baseSha: string;
  headSha: string;
  result: ReviewLike | null;
}

export interface CellRecord {
  itemJobId: string;
  arm: string;
  model: string | null;
  submittedAt: string;
  /** Terminal job status, or `refused` when the gateway refused the submit. */
  status: JobStatus | "refused";
  gatewayJobId: string | null;
  error: string | null;
  wallMs: number | null;
  /** The full gateway job JSON (`GET /api/jobs/:id`), null when it was never created. */
  job: unknown;
}

export interface Overlap {
  matched: number;
  countA: number;
  countB: number;
  /** matched / max(countA, countB): approximate agreement, null when both sides are empty. */
  agreement: number | null;
}

export interface ArmSummary {
  arm: string;
  cells: number;
  done: number;
  failed: number;
  outcomes: Record<string, number>;
  blockingPerReview: number | null;
  improvementsPerReview: number | null;
  wallMsMedian: number | null;
  wallMsP90: number | null;
  /** Not available: the review job result carries no cost, and the usage sink is keyed by
   *  session time window, not by job id, so per-job cost cannot be joined reliably. */
  costUsd: null;
  totalCostUsd: null;
}

export interface Options {
  corpus: string;
  arms: string[];
  sample?: number;
  concurrency: number;
  out?: string;
  resume?: string;
  dryRun: boolean;
}

// ── Argument parsing (pure) ────────────────────────────────────────────────────

export function parseArgs(argv: string[]): Options {
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`--${name} requires a value`);
    return v;
  };
  const positiveInt = (
    name: string,
    raw: string | undefined,
    dflt?: number,
  ): number | undefined => {
    if (raw === undefined) return dflt;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer`);
    return n;
  };
  const arms = value("arms")
    ?.split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  const resume = value("resume");
  if (arms === undefined && resume === undefined) {
    throw new Error("--arms is required (e.g. --arms baseline,deepseek-v4.1-flash)");
  }
  return {
    corpus: resolve(value("corpus") ?? CORPUS_DEFAULT),
    arms: arms ?? [],
    sample: positiveInt("sample", value("sample")),
    concurrency: positiveInt("concurrency", value("concurrency"), 2) ?? 2,
    out: value("out"),
    resume,
    dryRun: argv.includes("--dry-run"),
  };
}

// ── Corpus + sampling (pure) ───────────────────────────────────────────────────

export function parseCorpus(text: string): CorpusItem[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, i) => {
      const o = JSON.parse(line) as Partial<CorpusItem>;
      if (
        typeof o.jobId !== "string" ||
        typeof o.repo !== "string" ||
        typeof o.kind !== "string" ||
        typeof o.params !== "object" ||
        o.params === null
      ) {
        throw new Error(`corpus line ${i + 1}: missing jobId/repo/kind/params`);
      }
      return { ...o, result: o.result ?? null } as CorpusItem;
    });
}

function seededRandom(seed: string): () => number {
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic stratified sample by (repo, kind): round-robin over the strata, each stratum
 *  shuffled with a seeded PRNG. Returns the chosen items in their original corpus order. */
export function sampleStratified<T extends { jobId: string; repo: string; kind: string }>(
  items: T[],
  n: number,
  seed: string,
): T[] {
  if (n >= items.length) return [...items];
  const rand = seededRandom(seed);
  const strata = new Map<string, T[]>();
  for (const item of items) {
    const key = `${item.repo}\u0000${item.kind}`;
    const group = strata.get(key) ?? [];
    group.push(item);
    strata.set(key, group);
  }
  const keys = [...strata.keys()].sort();
  for (const key of keys) {
    const group = (strata.get(key) ?? []).sort((a, b) => a.jobId.localeCompare(b.jobId));
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [group[i], group[j]] = [group[j] as T, group[i] as T];
    }
  }
  const picked = new Set<T>();
  for (let round = 0; picked.size < n; round++) {
    let took = false;
    for (const key of keys) {
      const group = strata.get(key) ?? [];
      if (round < group.length && picked.size < n) {
        picked.add(group[round] as T);
        took = true;
      }
    }
    if (!took) break;
  }
  return items.filter((item) => picked.has(item));
}

// ── Finding overlap (pure) ─────────────────────────────────────────────────────

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeFile(file: string): string {
  return file.trim().replace(/^\.\//, "");
}

/** Two findings agree when they name the same file within ±LINE_TOLERANCE lines, or when their
 *  normalized text is identical. The review schema has no title field, so the message stands in. */
export function sameFinding(a: Finding, b: Finding): boolean {
  const ta = normalizeText(a.message);
  if (ta.length > 0 && ta === normalizeText(b.message)) return true;
  return (
    normalizeFile(a.file) === normalizeFile(b.file) &&
    a.line !== undefined &&
    b.line !== undefined &&
    Math.abs(a.line - b.line) <= LINE_TOLERANCE
  );
}

/** Greedy one-to-one matching of `a` against `b`. */
export function overlap(a: Finding[], b: Finding[]): Overlap {
  const used = new Set<number>();
  let matched = 0;
  for (const finding of a) {
    const idx = b.findIndex((other, j) => !used.has(j) && sameFinding(finding, other));
    if (idx !== -1) {
      used.add(idx);
      matched++;
    }
  }
  const denom = Math.max(a.length, b.length);
  return {
    matched,
    countA: a.length,
    countB: b.length,
    agreement: denom === 0 ? null : matched / denom,
  };
}

// ── Aggregation (pure) ─────────────────────────────────────────────────────────

export function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

export function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

/** The review result a done cell carries, or null for anything else. */
export function reviewOf(cell: CellRecord): ReviewLike | null {
  if (cell.status !== "done") return null;
  const job = cell.job as { result?: ReviewLike | null } | null;
  return job?.result ?? null;
}

export function summarizeArm(arm: string, cells: CellRecord[]): ArmSummary {
  const done = cells.filter((c) => c.status === "done");
  const outcomes: Record<string, number> = {};
  const blocking: number[] = [];
  const improvements: number[] = [];
  for (const cell of done) {
    const review = reviewOf(cell);
    if (review === null) continue;
    const outcome = review.outcome ?? "unknown";
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    blocking.push((review.blocking ?? []).length);
    improvements.push((review.improvements ?? []).length);
  }
  const walls = cells.flatMap((c) => (c.wallMs === null ? [] : [c.wallMs]));
  return {
    arm,
    cells: cells.length,
    done: done.length,
    failed: cells.length - done.length,
    outcomes,
    blockingPerReview: mean(blocking),
    improvementsPerReview: mean(improvements),
    wallMsMedian: percentile(walls, 50),
    wallMsP90: percentile(walls, 90),
    costUsd: null,
    totalCostUsd: null,
  };
}

// ── Gateway client ─────────────────────────────────────────────────────────────

/** Review params for one arm: the item's recorded inputs, with `model` set for a model arm and
 *  removed for baseline so the route default applies. */
export function reviewParams(
  recorded: Record<string, unknown>,
  model: string | null,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const key of REVIEW_PARAM_KEYS) {
    if (key !== "model" && recorded[key] !== undefined) params[key] = recorded[key];
  }
  if (model !== null) params.model = model;
  return params;
}

export function armModel(arm: string): string | null {
  return arm === BASELINE ? null : arm;
}

interface JobView {
  id: string;
  status: JobStatus;
  error: string | null;
  elapsedMs?: number;
}

async function submitReview(
  base: string,
  params: Record<string, unknown>,
): Promise<{ ok: true; jobId: string } | { ok: false; refused: string }> {
  const res = await fetch(`${base}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "review", params }),
  });
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean;
    job?: { id?: string };
    error?: string;
  } | null;
  if (res.status === 200 && data?.ok === true && typeof data.job?.id === "string") {
    return { ok: true, jobId: data.job.id };
  }
  if (res.status >= 400 && res.status < 500) {
    return { ok: false, refused: data?.error ?? `submit refused (${res.status})` };
  }
  throw new Error(`submit failed (${res.status})`);
}

/** Polls until the job is terminal. No timeout beyond the gateway's own idle watchdog; transient
 *  poll failures are retried, and only a long unbroken run of them gives up. */
async function awaitJob(base: string, jobId: string): Promise<JobView> {
  let failures = 0;
  for (;;) {
    try {
      const res = await fetch(`${base}/api/jobs/${encodeURIComponent(jobId)}`);
      if (res.status === 404) throw new Error(`job not found: ${jobId}`);
      if (res.ok) {
        const body = (await res.json()) as { job?: JobView };
        failures = 0;
        if (body.job && isTerminal(body.job.status)) return body.job;
      } else {
        throw new Error(`job poll failed (${res.status})`);
      }
    } catch (err) {
      failures++;
      if (failures >= POLL_FAILURE_LIMIT) throw err;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// ── Persistence ────────────────────────────────────────────────────────────────

export function cellFileName(itemJobId: string, arm: string): string {
  return `${itemJobId}__${arm.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

function loadCells(cellsDir: string): CellRecord[] {
  if (!existsSync(cellsDir)) return [];
  return readdirSync(cellsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(cellsDir, f), "utf8")) as CellRecord);
}

// ── Pooled, blinded output ─────────────────────────────────────────────────────

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Stable random letters for one item's candidates (the original review plus each arm). */
export function assignLetters(
  labels: string[],
  rand: () => number = Math.random,
): Map<string, string> {
  if (labels.length > LETTERS.length) throw new Error("too many candidates to letter");
  const order = [...labels];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j] as string, order[i] as string];
  }
  return new Map(order.map((label, i) => [label, LETTERS[i] as string]));
}

function renderFindings(title: string, findings: Finding[]): string[] {
  if (findings.length === 0) return [`${title}: none`];
  return [
    `${title}:`,
    ...findings.map((f) => `- ${f.file}${f.line === undefined ? "" : `:${f.line}`} — ${f.message}`),
  ];
}

export function renderPooled(
  itemJobId: string,
  candidates: { letter: string; review: ReviewLike | null; status: string }[],
): string {
  const lines = [`# Review candidates ${itemJobId}`, ""];
  for (const c of [...candidates].sort((a, b) => a.letter.localeCompare(b.letter))) {
    lines.push(`## Candidate ${c.letter}`, "");
    if (c.review === null) {
      lines.push(`status: ${c.status}`, "");
      continue;
    }
    lines.push(`outcome: ${c.review.outcome ?? "unknown"}`, "");
    lines.push(...renderFindings("Blocking", c.review.blocking ?? []), "");
    lines.push(...renderFindings("Improvements", c.review.improvements ?? []), "");
  }
  return lines.join("\n");
}

// ── Summary ────────────────────────────────────────────────────────────────────

function fmtNum(n: number | null, digits = 2): string {
  return n === null ? "n/a" : n.toFixed(digits);
}

function fmtMs(n: number | null): string {
  return n === null ? "n/a" : `${(n / 60_000).toFixed(1)} min`;
}

export interface ItemComparison {
  itemJobId: string;
  vsOriginal: Record<string, Overlap>;
  between: { a: string; b: string; overlap: Overlap }[];
}

export function compareItem(
  item: CorpusItem,
  cellsByArm: Map<string, CellRecord>,
  arms: string[],
): ItemComparison {
  const originalBlocking = item.result?.blocking ?? [];
  const blockingOf = (arm: string): Finding[] | null => {
    const cell = cellsByArm.get(arm);
    const review = cell ? reviewOf(cell) : null;
    return review === null ? null : (review.blocking ?? []);
  };
  const vsOriginal: Record<string, Overlap> = {};
  const between: ItemComparison["between"] = [];
  for (const arm of arms) {
    const blocking = blockingOf(arm);
    if (blocking !== null) vsOriginal[arm] = overlap(blocking, originalBlocking);
  }
  for (let i = 0; i < arms.length; i++) {
    for (let j = i + 1; j < arms.length; j++) {
      const a = blockingOf(arms[i] as string);
      const b = blockingOf(arms[j] as string);
      if (a !== null && b !== null) {
        between.push({ a: arms[i] as string, b: arms[j] as string, overlap: overlap(a, b) });
      }
    }
  }
  return { itemJobId: item.jobId, vsOriginal, between };
}

function meanAgreement(comparisons: ItemComparison[], arm: string): number | null {
  const values = comparisons.flatMap((c) => {
    const o = c.vsOriginal[arm];
    return o?.agreement === null || o === undefined ? [] : [o.agreement];
  });
  return mean(values);
}

export function renderSummaryMd(input: {
  generatedAt: string;
  items: number;
  arms: ArmSummary[];
  comparisons: ItemComparison[];
}): string {
  const lines = [
    "# Review model replay",
    "",
    `Generated ${input.generatedAt}. Corpus items: ${input.items}. Corpus is local-only; do not commit this output.`,
    "",
    "## Per arm",
    "",
    "| arm | cells | done | failed | outcomes | blocking/review | improvements/review | wall median | wall p90 | cost |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const a of input.arms) {
    const outcomes =
      Object.entries(a.outcomes)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ") || "none";
    lines.push(
      `| ${a.arm} | ${a.cells} | ${a.done} | ${a.failed} | ${outcomes} | ${fmtNum(a.blockingPerReview)} | ${fmtNum(a.improvementsPerReview)} | ${fmtMs(a.wallMsMedian)} | ${fmtMs(a.wallMsP90)} | not available |`,
    );
  }
  lines.push(
    "",
    "## Blocking agreement with the original review",
    "",
    "Approximate agreement, not accuracy: matched / max(count). The corpus PR heads may have drifted since the original review.",
    "",
    "| arm | mean agreement |",
    "| --- | --- |",
  );
  for (const a of input.arms) {
    lines.push(`| ${a.arm} | ${fmtNum(meanAgreement(input.comparisons, a.arm))} |`);
  }
  return `${lines.join("\n")}\n`;
}

// ── Run ────────────────────────────────────────────────────────────────────────

interface RunState {
  corpus: string;
  arms: string[];
  sample?: number;
  seed: string;
  startedAt: string;
}

async function runCell(
  base: string,
  cellsDir: string,
  item: CorpusItem,
  arm: string,
): Promise<void> {
  const model = armModel(arm);
  const submittedAt = new Date().toISOString();
  const started = Date.now();
  let record: CellRecord;
  try {
    const submitted = await submitReview(base, reviewParams(item.params, model));
    if (!submitted.ok) {
      record = {
        itemJobId: item.jobId,
        arm,
        model,
        submittedAt,
        status: "refused",
        gatewayJobId: null,
        error: submitted.refused,
        wallMs: null,
        job: null,
      };
    } else {
      const view = await awaitJob(base, submitted.jobId);
      record = {
        itemJobId: item.jobId,
        arm,
        model,
        submittedAt,
        status: view.status,
        gatewayJobId: view.id,
        error: view.error,
        wallMs: typeof view.elapsedMs === "number" ? view.elapsedMs : Date.now() - started,
        job: view,
      };
    }
  } catch (err) {
    // Not persisted: a resume submits this cell again.
    console.error(
      `cell ${item.jobId} ${arm} not saved: ${err instanceof Error ? err.message : err}`,
    );
    return;
  }
  writeFileSync(
    join(cellsDir, cellFileName(item.jobId, arm)),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  console.error(`${record.status} ${item.jobId} ${arm} ${fmtMs(record.wallMs)}`);
}

async function runPool<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await work(item);
    }
  });
  await Promise.all(runners);
}

function writeSummary(
  outDir: string,
  items: CorpusItem[],
  arms: string[],
  corpus: string,
  cells: CellRecord[],
): void {
  const byItem = new Map<string, Map<string, CellRecord>>();
  for (const cell of cells) {
    const m = byItem.get(cell.itemJobId) ?? new Map<string, CellRecord>();
    m.set(cell.arm, cell);
    byItem.set(cell.itemJobId, m);
  }

  const keyPath = join(outDir, "key.json");
  const key: Record<string, Record<string, string>> = existsSync(keyPath)
    ? (JSON.parse(readFileSync(keyPath, "utf8")) as Record<string, Record<string, string>>)
    : {};
  const pooledDir = join(outDir, "pooled");
  mkdirSync(pooledDir, { recursive: true });

  const comparisons: ItemComparison[] = [];
  for (const item of items) {
    const cellsByArm = byItem.get(item.jobId) ?? new Map<string, CellRecord>();
    comparisons.push(compareItem(item, cellsByArm, arms));

    const labels = ["original", ...arms];
    const existing = key[item.jobId];
    const letters = new Map<string, string>(
      existing
        ? Object.entries(existing).map(([letter, label]) => [label, letter])
        : assignLetters(labels),
    );
    key[item.jobId] = Object.fromEntries([...letters].map(([label, letter]) => [letter, label]));

    const candidates = labels.map((label) => {
      const letter = letters.get(label) as string;
      if (label === "original") {
        return { letter, review: item.result, status: "done" };
      }
      const cell = cellsByArm.get(label);
      return {
        letter,
        review: cell ? reviewOf(cell) : null,
        status: cell ? cell.status : "not run",
      };
    });
    writeFileSync(join(pooledDir, `${item.jobId}.md`), `${renderPooled(item.jobId, candidates)}\n`);
  }
  writeFileSync(keyPath, `${JSON.stringify(key, null, 2)}\n`);

  const armSummaries = arms.map((arm) => {
    const armCells = cells.filter(
      (c) => c.arm === arm && items.some((i) => i.jobId === c.itemJobId),
    );
    return summarizeArm(arm, armCells);
  });
  const generatedAt = new Date().toISOString();
  writeFileSync(
    join(outDir, "summary.json"),
    `${JSON.stringify({ generatedAt, corpus, items: items.length, arms: armSummaries, comparisons }, null, 2)}\n`,
  );
  writeFileSync(
    join(outDir, "summary.md"),
    renderSummaryMd({ generatedAt, items: items.length, arms: armSummaries, comparisons }),
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(Bun.argv.slice(2));
  const base = (process.env.AGENT_GATEWAY_URL ?? DEFAULT_URL).replace(/\/+$/, "");

  let outDir =
    opts.out ?? join(BENCH_ROOT, `review-replay-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  let state: RunState = {
    corpus: opts.corpus,
    arms: opts.arms,
    sample: opts.sample,
    seed: SAMPLE_SEED,
    startedAt: new Date().toISOString(),
  };
  if (opts.resume !== undefined) {
    outDir = resolve(opts.resume);
    const runPath = join(outDir, "run.json");
    // A resume replays the run's own arms, corpus and sample, so cells from different plans never mix.
    if (existsSync(runPath)) state = JSON.parse(readFileSync(runPath, "utf8")) as RunState;
  }

  const items = sampleStratified(
    parseCorpus(readFileSync(state.corpus, "utf8")),
    state.sample ?? Number.POSITIVE_INFINITY,
    state.seed,
  );
  const plan = items.flatMap((item) => state.arms.map((arm) => ({ item, arm })));

  if (opts.dryRun) {
    console.log(
      `plan: ${items.length} items × ${state.arms.length} arms = ${plan.length} review jobs`,
    );
    for (const { item, arm } of plan) {
      console.log(
        `${item.jobId}  ${item.repo}  ${item.kind}  arm=${arm}  model=${armModel(arm) ?? "(route default)"}`,
      );
    }
    console.log("dry run: nothing submitted");
    return;
  }

  const cellsDir = join(outDir, "cells");
  mkdirSync(cellsDir, { recursive: true });
  if (!existsSync(join(outDir, "run.json"))) {
    writeFileSync(join(outDir, "run.json"), `${JSON.stringify(state, null, 2)}\n`);
  }

  const doneKeys = new Set(loadCells(cellsDir).map((c) => `${c.itemJobId}\u0001${c.arm}`));
  const todo = plan.filter(({ item, arm }) => !doneKeys.has(`${item.jobId}\u0001${arm}`));
  console.error(`${todo.length} of ${plan.length} cells to run → ${outDir}`);

  await runPool(todo, opts.concurrency, ({ item, arm }) => runCell(base, cellsDir, item, arm));

  const itemIds = new Set(items.map((i) => i.jobId));
  const cells = loadCells(cellsDir).filter(
    (c) => itemIds.has(c.itemJobId) && state.arms.includes(c.arm),
  );
  writeSummary(outDir, items, state.arms, state.corpus, cells);
  console.error(`summary → ${join(outDir, "summary.md")}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
