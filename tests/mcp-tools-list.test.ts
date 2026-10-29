// What `tools/list` advertises: every tool, in one deterministic order, with a title and all
// four annotation hints. server/mcp.ts connects a stdio transport at import and cannot be
// imported here, so the same registry it calls (`registerAllTools`) is wired to an in-memory
// client instead.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_TOOLS, registerAllTools } from "../server/mcp/tools/index.ts";

const EXPECTED_ORDER = [
  "decide",
  "dispatch",
  "job_cancel",
  "job_status",
  "job_steer",
  "job_wait",
  "narrative",
  "overview",
  "read_drawing",
  "read_image",
  "triage",
  "update_pr",
];

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

let server: McpServer;
let client: Client;

beforeEach(async () => {
  server = new McpServer({ name: "test", version: "0.0.0" });
  registerAllTools(server);
  client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
});

describe("tools/list", () => {
  test("lists exactly the registry, alphabetically by name", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(EXPECTED_ORDER);
    expect(names).toEqual([...names].toSorted());
    expect(MCP_TOOLS.map((t) => t.name)).toEqual(EXPECTED_ORDER);
  });

  test("every tool has a title and all four annotation hints as booleans", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.title, `${tool.name} title`).toBeTruthy();
      for (const hint of HINTS) {
        expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe("boolean");
      }
    }
  });

  test("hints match what each tool really does", async () => {
    const { tools } = await client.listTools();
    const hints = Object.fromEntries(
      tools.map((t) => [t.name, HINTS.map((h) => (t.annotations?.[h] ? h[0] : "-")).join("")]),
    );
    // Order of letters: readOnly, destructive, idempotent, openWorld.
    expect(hints).toEqual({
      decide: "r---",
      dispatch: "-d-o",
      job_cancel: "-di-",
      job_status: "r-i-",
      job_steer: "----",
      job_wait: "r---",
      narrative: "r---",
      overview: "r---",
      read_drawing: "r-i-",
      read_image: "r-i-",
      triage: "r---",
      update_pr: "-dio",
    });
  });
});
