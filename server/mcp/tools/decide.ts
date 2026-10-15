import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DECIDE_INPUT } from "../../jobs/handlers/decide.ts";
import { DEFAULT_DECISION_MODEL } from "../../lib/decision.ts";
import { registerJobSubmitTool } from "./_job-tool.ts";

export function registerDecideTool(server: McpServer): void {
  registerJobSubmitTool(server, {
    name: "decide",
    title: "Decision Model",
    tool: "decide",
    inputSchema: DECIDE_INPUT.shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    description: `Answer 1-16 typed questions (choice among options, or boolean) about a block of text with ONE call to an IU decision model, which returns a calibrated confidence per answer instead of generated text. No agent, no repo access, no worktree — seconds and fractions of a cent. Runs as a BACKGROUND JOB: this call returns a jobId immediately — it does NOT return the answers.

WHEN TO CALL: a bounded classification/routing decision where you want a calibrated confidence to threshold on (act above it, escalate below it). Use triage instead when the answer is free-form JSON; use dispatch for anything that must read files or run commands.
INPUT: \`state\` is plain text and the model's ENTIRE world — it cannot look anything up, so put all context in it (it is cut to the model's cap; \`truncatedChars\` reports how much). \`questions\` maps a question id to { type: "choice", instructions, options: { optionId: description } } (≥ 2 options) or { type: "boolean", instructions }. \`model\` is optional and must be a known decision model.
ASYNC: returns { jobId }. Then call job_wait({ jobId }) to block until it finishes and read the result, or job_status for a one-shot poll.
READ-ONLY: no side effects of any kind.
CWD: not used — no repo is touched.
OUTPUT: \`answers\` keyed by question id — choice: { choice, confidence, probabilities? }; boolean: { value, confidence, probability }; or { type: "refusal" } when the model declines. \`confidence\` is the provider's calibrated per-question value, not the option probability. Also \`model\`, \`latencyMs\`, \`usage\`, \`truncatedChars\`.
MODEL: a decision model (default ${DEFAULT_DECISION_MODEL}, server override AGENT_GATEWAY_DECISION_MODEL, per-call \`model\`) — not in GET /api/routing.`,
  });
}
