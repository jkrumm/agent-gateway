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
PIPELINE: lint (pure code: banned words, negative parallelism, German Nominalstil, long sentences, repetition) → review (a different lab, notes and per-criterion scores only) → rewrite (the voice guide plus the review) → re-lint. The rewrite is kept only if it stays in the input's format, every fenced code block and every URL of the original (html: every href/src value) survives unchanged, every Obsidian wikilink target (\`[[t]]\`, \`[[t|alias]]\`, \`![[embed]]\`; the alias may change) survives, it adds no new URL, wikilink or fenced block, leaves no fence open, and no lint rule's finding count rises; otherwise the original comes back with \`keptReason\` saying which check failed.
FORMAT: the rewrite returns the input's format. Block-level HTML tags (<p>, <h1>-<h6>, <table>, <ul>, <ol>, <div>, <section>) make the input \`html\`, anything else is \`markdown\`; html comes back as html (a visual placeholder is \`<!-- visual: <kind> — <what it shows> -->\`), markdown as markdown (\`> [visual: …]\`). A rewrite that switches format or mixes markdown syntax into html is discarded. Custom components and callouts (MDX, shortcodes, framework tags) are NOT preserved: re-apply them yourself after applying the result.
NO INVENTED CONTENT: the writer adds no recommendation, verdict, call to action, next step, claim or fact that is not in the source and never changes a fact's meaning; a source with no single pick gets a rewrite with none. The reviewer flags unsupported content as a note with criterion \`invented_content\`. Explicit instructions in \`brief\` override the voice guide's defaults.
INPUTS: \`verdictFirst\` (default true) — false when the author deliberately builds criteria → candidates → verdict: the writer keeps the section order, hoists no recommendation, and the review carries no verdict_first score. \`context\` (≤8000 chars) — the surrounding document's outline or TLDR, shown to reviewer and writer as read-only data for consistency, never rewritten or quoted into the output.
OUTPUT: check \`kept\` first — \`original\` means the rewrite was discarded and \`keptReason\` says why; the review notes still apply. \`text\` is the result, \`format\` its format (markdown | html, same as the input), \`mediumNote\` one line on what the chosen medium changed (docs: lists/reference tone/headings; article: narrative paragraphs; landing: short benefit-first lines; ui: labels/actions; vault: telegraphic bullets; briefing: bold-lead bullets; chat: short answer first), \`lint\` the findings on it, \`review\` the scores and notes (no verdict_first when verdictFirst is false), \`visualSuggestions\` what would be clearer as a table, diagram, chart, code block or image, \`usage\` the writer + reviewer total { inputTokens, outputTokens, reasoningTokens, totalTokens, cacheReadTokens, costUsd }, and \`usageByCall\` = { writer, reviewer } in the same shape (null when a call reported none). costUsd is the gateway's reported cost, else computed from the model registry rates.
MODEL: writer ${describeRoute(routeFor("prose_write"))}; reviewer ${describeRoute(routeFor("prose_review"))}. Per-job \`model\` (anthropic-wire writer) and \`reviewModel\` (a chat-wire id from a different lab) override them — the job refuses a same-lab pair at submit. See GET /api/routing.`,
  });
}
