import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NARRATIVE_INPUT } from "../../jobs/handlers/narrative.ts";
import { registerJobSubmitTool } from "./_job-tool.ts";
import { describeRoute, routeFor } from "../../lib/routing.ts";

export function registerNarrativeTool(server: McpServer): void {
  registerJobSubmitTool(server, {
    name: "narrative",
    title: "Project Narrative Page",
    tool: "narrative",
    inputSchema: NARRATIVE_INPUT.shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    description: `Write or revise ONE project's narrative page for the Obsidian vault: what it is, where it stands, how it got here — business terms, never a changelog. Runs as a BACKGROUND JOB: this call returns a jobId immediately — it does NOT return the page.

WHEN TO CALL: Hermes' daily cron pass over tracked projects, or an explicit "update this project's narrative" request. Spends tokens on the worker model plus, unless \`polish\` is false, a prose pass (a reviewer and a writer call, 20-90 s extra) — don't call it speculatively.
ASYNC: returns { jobId }. Then call job_wait({ jobId }) to block until it finishes and read the result, or job_status for a one-shot poll.
POLISH: \`polish\` (default true) runs the rendered page through the \`prose\` pipeline (medium vault; lint → cross-lab review → rewrite → keep gate) with the frontmatter kept verbatim. A prose failure or a declined rewrite returns the unpolished page and never fails the job; \`prose\` in the result says what happened. \`polish: false\` skips it.
READ-ONLY: gathers git log + session transcripts deterministically in the handler, then reasons over a prompt only — no file writes, no repo tools in the worker session itself.
CWD: absolute path of the repo to summarize (\`cwd\`) — separate from \`project\`, the vault page name.
OUTPUT: check \`changed\` first — \`false\` means nothing substantive happened since \`previousPage\` and no page was written; treat that as success, not a no-op error. When \`changed\` is true, \`page\` is the full markdown (frontmatter + sections) ready to write to the vault, and \`summary\` is a one-line delta for a briefing. \`inputs\` reports how much history/session data was actually gathered.
MODEL: ${describeRoute(routeFor("narrative"))}; per-job model param overrides it — see GET /api/routing.`,
  });
}
