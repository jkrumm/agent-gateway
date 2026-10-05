// The `update_pr` MCP tool is registered with the schema the handler validates against, and
// server/mcp.ts actually wires it in. mcp.ts itself connects a stdio transport at import, so
// it cannot be imported here: the registration function is exercised over an in-memory
// transport and the wiring is pinned against mcp.ts's source.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerUpdatePrTool } from "../server/mcp/tools/update-pr.ts";

describe("update_pr MCP tool", () => {
  test("registerUpdatePrTool lists `update_pr` with cwd + pr as required inputs", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerUpdatePrTool(server);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "update_pr");
      expect(tool).toBeDefined();
      expect(tool?.inputSchema.required).toEqual(expect.arrayContaining(["cwd", "pr"]));
      expect(Object.keys(tool?.inputSchema.properties ?? {}).toSorted()).toEqual(["cwd", "pr"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("server/mcp.ts registers it", () => {
    const source = readFileSync(join(import.meta.dir, "../server/mcp.ts"), "utf8");
    expect(source).toContain('import { registerUpdatePrTool } from "./mcp/tools/update-pr.ts"');
    expect(source).toMatch(/^registerUpdatePrTool\(server\);$/m);
  });
});
