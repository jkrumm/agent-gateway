import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TRIAGE_INPUT } from "../../jobs/handlers/triage.ts";
import { registerJobSubmitTool } from "./_job-tool.ts";
import { describeRoute, routeFor } from "../../lib/routing.ts";

export function registerTriageTool(server: McpServer): void {
  registerJobSubmitTool(server, {
    name: "triage",
    title: "Single-Shot Triage",
    tool: "triage",
    inputSchema: TRIAGE_INPUT.shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    description: `Answer ONE classification/extraction question with ONE tool-less model call and get back JSON that conforms to a JSON Schema you supply (e.g. "attach this event to an open item, file a new one, or ignore it"). No agent, no repo access, no worktree — seconds and cents, not minutes. Runs as a BACKGROUND JOB: this call returns a jobId immediately — it does NOT return the answer.

WHEN TO CALL: a bounded decision whose full input fits in one prompt (intake routing, duplicate detection, a fixed-by check). NOT for anything that must read files, run commands or edit code — use dispatch for that.
INPUT: \`prompt\` must contain everything the model needs — it cannot look anything up. \`schema\` is the JSON Schema of the answer (top level {"type": "object"}); do not also describe the output shape in the prompt.
ASYNC: returns { jobId }. Then call job_wait({ jobId }) to block until it finishes and read the result, or job_status for a one-shot poll.
READ-ONLY: no side effects of any kind.
CWD: not used — no repo is touched.
OUTPUT: \`result\` is the model's answer, already validated against your schema; \`attempts\` is 2 if the first answer was rejected and re-asked once. If the second answer also fails validation the job fails with the reason — treat that as "no decision", not as an empty result.
MODEL: ${describeRoute(routeFor("triage"))} — see GET /api/routing.`,
  });
}
