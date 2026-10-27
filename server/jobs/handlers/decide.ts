import { z } from "zod";
import {
  DECISION_QUESTION,
  isDecisionModel,
  runDecision,
  type DecisionOutput,
} from "../../lib/decision.ts";
import type { ProgressSink } from "../store.ts";
import { parseParams } from "./util.ts";

// `decide` — one decision-model call (typed answers + calibrated confidence, no text). The caller
// supplies the whole state and the questions; the model cannot look anything up. Execution and
// the wire facts live in server/lib/decision.ts.

const MAX_STATE_CHARS = 400_000;
const MAX_QUESTIONS = 16;

export const DECIDE_INPUT = z.object({
  state: z.string().min(1).max(MAX_STATE_CHARS),
  questions: z
    .record(z.string().min(1).max(64), DECISION_QUESTION)
    .refine((q) => Object.keys(q).length >= 1 && Object.keys(q).length <= MAX_QUESTIONS, {
      message: `1–${MAX_QUESTIONS} questions`,
    }),
  model: z.string().optional(),
});

export async function runDecide(
  rawParams: Record<string, unknown>,
  onProgress?: ProgressSink,
  jobId?: string,
  isCancelled?: (jobId: string) => boolean,
): Promise<DecisionOutput> {
  const params = parseParams(DECIDE_INPUT, rawParams);
  if (params.model !== undefined && !isDecisionModel(params.model)) {
    throw new Error(`invalid params: model: "${params.model}" is not a known decision model`);
  }
  onProgress?.({ turns: 1, lastAction: "decide: requesting", lastActivityAt: Date.now() });
  // Cancel / drain reach the request through an abort signal, polled like `triage`'s retry gate.
  const abort = new AbortController();
  const watcher =
    jobId !== undefined && isCancelled
      ? setInterval(() => {
          if (isCancelled(jobId)) abort.abort();
        }, 2000)
      : undefined;
  try {
    return await runDecision({ ...params, signal: abort.signal, jobId });
  } finally {
    clearInterval(watcher);
  }
}
