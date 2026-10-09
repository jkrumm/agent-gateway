import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UPDATE_PR_INPUT } from "../../jobs/handlers/update-pr.ts";
import { registerJobSubmitTool } from "./_job-tool.ts";

export function registerUpdatePrTool(server: McpServer): void {
  registerJobSubmitTool(server, {
    name: "update_pr",
    title: "Update Dispatch PR",
    tool: "update_pr",
    inputSchema: UPDATE_PR_INPUT.shape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    description: `Rebase one open \`dispatch/*\` pull request onto the latest default branch, re-run the repo's own checks on the result and force-with-lease push it. Mechanical — no model writes code. Runs as a BACKGROUND JOB: this call returns a jobId immediately — it does NOT return the result.

WHEN TO CALL: a dispatch PR's base moved and it must be brought up to date before merge (the merge-train step). NOT for conflict resolution — a conflict is reported, and the caller re-dispatches the work (implement with \`revisionOf\`, or fresh) from the new base.
ASYNC: returns { jobId }. Then call job_wait({ jobId }) to block until it finishes and read the result.
SIDE EFFECTS: force-with-lease push to the PR's own dispatch/* branch only (never the default branch, never a fork); refused for a closed PR, a non-dispatch/* head, a base other than the default branch, and sensitive repos. Serializes per repo with every other implement episode.
CWD: absolute path of the repo (directly under a dispatch root), same policy as dispatch implement.
OUTPUT: \`status\` (updated | up_to_date | conflict), \`headSha\` (the new PR head), \`previousHeadSha\`, \`baseSha\`, \`checks\` { passed, summary, failed? } from the rebased tree (pushed even when red — the train decides), \`prUrl\`.`,
  });
}
