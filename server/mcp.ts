// FIRST: the MCP process is spawned with the calling session's cwd, so Bun never auto-loaded
// agent-gateway/.env here — otel and the routing/backend flags ran unconfigured. Order matters.
import { warnLegacyEnv } from "./lib/env-compat.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./mcp/tools/index.ts";
import { logger } from "./mcp/logger.ts";
import { setProcessKind } from "./lib/process-context.ts";
import { logRoutingOverrides, logStaleQuotaEnvVars } from "./lib/routing.ts";

// "mcp" is already process-context.ts's default (preserved for callers that predate it), but
// set it explicitly here anyway — this is the one process that default exists to describe, and
// an explicit call survives a future change to that default.
setProcessKind("mcp");
warnLegacyEnv(logger);
logRoutingOverrides(logger);
logStaleQuotaEnvVars(logger);

const server = new McpServer({
  name: "agent-gateway",
  version: "0.1.0",
});

registerAllTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

logger.info({ event: "mcp.startup" }, "agent-gateway mcp server ready");
