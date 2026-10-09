// job_cancel over an in-memory MCP client with the HTTP job API stubbed at `fetch`. Pins that
// each answer of POST /api/jobs/:id/cancel (pending → cancelled, running → request recorded,
// terminal → 409, unknown → 404) reaches the caller as its own distinguishable outcome.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerJobCancelTool } from "../server/mcp/tools/jobs.ts";

const realFetch = globalThis.fetch;

function view(overrides: Record<string, unknown>) {
  return {
    id: "job-1",
    tool: "dispatch",
    status: "running",
    elapsedMs: 1234,
    idleMs: 10,
    progress: null,
    result: null,
    error: null,
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Stub the HTTP server: /health ok, then `routes` keyed by "METHOD path". */
function stubHttp(routes: Record<string, () => Response>): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const key = `${init?.method ?? "GET"} ${path}`;
    calls.push(key);
    if (path === "/health") return new Response("ok");
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected request ${key}`);
    return handler();
  }) as unknown as typeof fetch;
  return calls;
}

let server: McpServer;
let client: Client;

beforeEach(async () => {
  server = new McpServer({ name: "test", version: "0.0.0" });
  registerJobCancelTool(server);
  client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await client.close();
  await server.close();
});

async function cancel(jobId: string) {
  return client.callTool({ name: "job_cancel", arguments: { jobId } });
}

describe("job_cancel", () => {
  test("pending job: outcome cancelled, terminal, no longer running", async () => {
    stubHttp({
      "POST /api/jobs/job-1/cancel": () =>
        json({
          ok: true,
          job: view({ status: "cancelled", error: "cancelled by request", idleMs: null }),
        }),
    });
    const res = await cancel("job-1");
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      jobId: "job-1",
      status: "cancelled",
      stillRunning: false,
      outcome: "cancelled",
      cancelRequested: false,
      error: "cancelled by request",
    });
  });

  test("running job: outcome cancel_requested, still running", async () => {
    stubHttp({
      "POST /api/jobs/job-1/cancel": () =>
        json({ ok: true, job: view({ status: "running", cancelRequested: true }) }),
    });
    const res = await cancel("job-1");
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      status: "running",
      stillRunning: true,
      outcome: "cancel_requested",
      cancelRequested: true,
    });
  });

  test("already finished (409): outcome already_terminal with the job's real final state", async () => {
    const calls = stubHttp({
      "POST /api/jobs/job-1/cancel": () => json({ ok: false, error: "job already done" }, 409),
      "GET /api/jobs/job-1": () =>
        json({ ok: true, job: view({ status: "done", result: { x: 1 }, idleMs: null }) }),
    });
    const res = await cancel("job-1");
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      status: "done",
      stillRunning: false,
      outcome: "already_terminal",
      cancelRequested: false,
    });
    expect(calls).toContain("GET /api/jobs/job-1");
  });

  test("unknown id (404): isError with a not-found message", async () => {
    stubHttp({
      "POST /api/jobs/nope/cancel": () => json({ ok: false, error: "job not found" }, 404),
    });
    const res = await cancel("nope");
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("Job not found: nope");
  });

  test("HTTP server down: isError with the unreachable message", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const res = await cancel("job-1");
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("unreachable");
  });
});
