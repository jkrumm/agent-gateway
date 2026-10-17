import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PROSE_INPUT } from "../../jobs/handlers/prose.ts";
import { registerJobSubmitTool } from "./_job-tool.ts";
import { describeRoute, routeFor } from "../../lib/routing.ts";

export function registerProseTool(server: McpServer): void {
  registerJobSubmitTool(server, {
    name: "prose",
    title: "Improve Human-Facing Prose",
    tool: "prose",
    inputSchema: PROSE_INPUT.shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    description: `Rewrite a human-facing draft (article section, vault page, landing or UI copy, docs, briefing) so a reader understands it faster. Runs as a BACKGROUND JOB: this call returns a jobId immediately — it does NOT return the text.

WHEN TO CALL: a draft that is correct but hard to read — an article section, a vault page, landing or UI copy, a briefing — and the author wants a second pass. Not for code, commit messages or chat replies that are already short.
READ-ONLY: changes no file and never writes the draft back — it reads the local voice guide (AGENT_GATEWAY_VOICE_PATH, default ~/SourceRoot/brain/voice.md) and returns the improved text for you to apply. SIDE EFFECTS: spends two model calls per job (one reviewer, one writer with extended thinking), billed to the IU endpoint.
ASYNC: returns { jobId }. Then call job_wait({ jobId }) to block until it finishes and read the result, or job_status for a one-shot poll.
PIPELINE: lint (pure code: banned words, negative parallelism, German Nominalstil, long sentences, repetition) → review (a different lab, notes and per-criterion scores only) → rewrite (the voice guide plus the review) → re-lint. The rewrite is kept only if every fenced code block and every URL of the original survives unchanged, it adds no new URL or fenced block and leaves no fence open (a visual suggestion is a one-line \`> [visual: …]\` blockquote), and no lint rule's finding count rises; otherwise the original comes back with \`keptReason\` saying which check failed.
OUTPUT: check \`kept\` first — \`original\` means the rewrite was discarded and \`keptReason\` says why; the review notes still apply. \`text\` is the result, \`lint\` the findings on it, \`review\` the scores and notes, \`visualSuggestions\` what would be clearer as a table, diagram, chart, code block or image.
MODEL: writer ${describeRoute(routeFor("prose_write"))}; reviewer ${describeRoute(routeFor("prose_review"))}. Per-job \`model\` (anthropic-wire writer) and \`reviewModel\` (a chat-wire id from a different lab) override them — the job refuses a same-lab pair at submit. See GET /api/routing.`,
  });
}
