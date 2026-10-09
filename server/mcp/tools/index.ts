import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCheckTool } from "./check.ts";
import { registerDispatchTool } from "./dispatch.ts";
import { registerExcalidrawDiagramTool } from "./excalidraw-diagram.ts";
import { registerJobCancelTool, registerJobStatusTool, registerJobWaitTool } from "./jobs.ts";
import { registerNarrativeTool } from "./narrative.ts";
import { registerOtelTool } from "./otel.ts";
import { registerOverviewTool } from "./overview.ts";
import { registerReadDrawingTool } from "./read-drawing.ts";
import { registerReadImageTool } from "./read-image.ts";
import { registerReviewTool } from "./review.ts";
import { registerTriageTool } from "./triage.ts";
import { registerUpdatePrTool } from "./update-pr.ts";

// The one list of MCP tools, in the order `tools/list` returns them. The SDK lists tools in
// registration order, so the order lives here — alphabetical by tool name — instead of in
// whatever sequence `mcp.ts` happened to call the register functions. Add a tool: one line here,
// in its sorted position (tests/mcp-tools-list.test.ts fails on a wrong order or a missing hint).
export const MCP_TOOLS: ReadonlyArray<{ name: string; register: (server: McpServer) => void }> = [
  { name: "check", register: registerCheckTool },
  { name: "dispatch", register: registerDispatchTool },
  { name: "excalidraw_diagram", register: registerExcalidrawDiagramTool },
  { name: "job_cancel", register: registerJobCancelTool },
  { name: "job_status", register: registerJobStatusTool },
  { name: "job_wait", register: registerJobWaitTool },
  { name: "narrative", register: registerNarrativeTool },
  { name: "otel", register: registerOtelTool },
  { name: "overview", register: registerOverviewTool },
  { name: "read_drawing", register: registerReadDrawingTool },
  { name: "read_image", register: registerReadImageTool },
  { name: "review", register: registerReviewTool },
  { name: "triage", register: registerTriageTool },
  { name: "update_pr", register: registerUpdatePrTool },
];

export function registerAllTools(server: McpServer): void {
  for (const tool of MCP_TOOLS) tool.register(server);
}
