// Bounds of server/lib/warden-board.ts: fetchWardenBoard normalizes warden's `GET /board`
// (docs/api.md in ~/SourceRoot/warden) into the shape server/lib/overview-payload.ts and
// server/lib/agents.ts's renderText consume, and never throws — an unreachable, non-2xx,
// timed-out or malformed warden degrades to `{ ok: false, error, fetchedAt }`.
//
// No real network — `fetchImpl` is injected per FetchWardenBoardOptions, same pattern as the
// rest of the repo stubbing an impure boundary rather than mocking global fetch.

import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import { fetchWardenBoard, renderWardenBlock } from "../server/lib/warden-board.ts";
import {
  __resetWardenBoardCacheForTests,
  cachedFetchWardenBoard,
} from "../server/lib/overview-payload.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rawItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: 42,
    origin: "alert",
    repo: "warden",
    state: "needs_decision",
    state_deadline: "2026-09-18T00:00:00+00:00",
    max_tier: "implement",
    title: "watchdog: agent-gateway dispatch stuck",
    note: null,
    pr_url: null,
    dispatch_job: "j-abc",
    implement_job: null,
    validation_job: null,
    occurrences: 1,
    created_at: "2026-09-10T00:00:00+00:00",
    updated_at: "2026-09-11T00:00:00+00:00",
    ...overrides,
  };
}

// Trimmed live /board item shape (schema 15); titles and notes redacted.
function liveItem(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    event_id: 1,
    origin: "alert",
    repo: "warden",
    state: "failed",
    close_reason: null,
    strikes: 0,
    retry_at: null,
    max_tier: "implement",
    title: "redacted title",
    note: "redacted note",
    pr_url: null,
    dispatch_job: "00000000-0000-0000-0000-000000000001",
    implement_job: null,
    validation_job: null,
    occurrences: 1,
    revision_count: 0,
    train_stage: null,
    created_at: "2026-10-04T12:00:00.000000+00:00",
    updated_at: "2026-10-05T19:47:51.440353+00:00",
    origin_channel: null,
    origin_thread_ts: null,
    availableActions: ["implement", "dismiss", "reinvestigate", "note"],
    issue: null,
    ...overrides,
  };
}

function rawBoard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generated_at: "2026-09-11T00:00:00+00:00",
    schema_version: 15,
    counts: {
      new: 0,
      triaged: 0,
      working: 1,
      merging: 0,
      verifying: 0,
      needs_decision: 2,
      failed: 0,
    },
    items: [rawItem()],
    terminal_24h: 4,
    ...overrides,
  };
}

describe("fetchWardenBoard — ok", () => {
  test("normalizes a healthy /board response", async () => {
    const board = await fetchWardenBoard({
      fetchImpl: async () => jsonResponse(rawBoard()),
    });
    expect(board.ok).toBe(true);
    if (!board.ok) throw new Error("unreachable");
    expect(board.generatedAt).toBe("2026-09-11T00:00:00+00:00");
    expect(board.counts.needs_decision).toBe(2);
    expect(board.open).toBe(3); // 1 working + 2 needs_decision
    expect(board.terminal24h).toBe(4);
    expect(board.itemsTruncated).toBe(false);
    expect(board.items).toHaveLength(1);
    expect(board.items[0]).toEqual({
      eventId: 42,
      origin: "alert",
      repo: "warden",
      state: "needs_decision",
      title: "watchdog: agent-gateway dispatch stuck",
      note: null,
      prUrl: null,
      updatedAt: "2026-09-11T00:00:00+00:00",
      inFlightJob: "j-abc", // dispatch_job — validation_job and implement_job are both null
    });
  });

  test("parses a trimmed real-shaped schema-15 board (live /board shape, titles and notes redacted)", async () => {
    const board = await fetchWardenBoard({
      fetchImpl: async () =>
        jsonResponse({
          generated_at: "2026-10-05T19:56:26.329357+00:00",
          schema_version: 15,
          counts: {
            new: 0,
            triaged: 0,
            working: 0,
            merging: 0,
            verifying: 0,
            needs_decision: 1,
            failed: 2,
          },
          items: [
            liveItem({ event_id: 3, state: "needs_decision", repo: "research-gateway" }),
            liveItem({ event_id: 2, state: "failed", repo: null, origin: "manual" }),
            liveItem({ event_id: 1, state: "failed", pr_url: "https://example.com/pr/1" }),
          ],
          terminal_24h: 16,
          awaiting_owner: [{ kind: "item", event_id: 3, state: "needs_decision" }],
        }),
    });
    expect(board.ok).toBe(true);
    if (!board.ok) throw new Error("unreachable");
    expect(board.open).toBe(3); // failed is non-terminal in warden, so it counts as open
    expect(board.counts.failed).toBe(2);
    expect(board.items.map((i) => i.state)).toEqual(["needs_decision", "failed", "failed"]);
    expect(board.items[1]?.repo).toBeNull();
    expect(board.items[2]?.prUrl).toBe("https://example.com/pr/1");
    const lines = renderWardenBlock(board, {
      color: false,
      lineMax: 110,
      generatedAt: Date.parse("2026-10-05T19:56:26.329357+00:00"),
    });
    expect(lines[0]).toBe("warden · 3 open · needs_decision 1 · failed 2 · in flight 0");
  });

  test("an item with repo: null parses ok:true, carries null through and renders a placeholder", async () => {
    const board = await fetchWardenBoard({
      fetchImpl: async () => jsonResponse(rawBoard({ items: [rawItem({ repo: null })] })),
    });
    expect(board.ok).toBe(true);
    if (!board.ok) throw new Error("unreachable");
    expect(board.items[0]?.repo).toBeNull();
    const lines = renderWardenBlock(board, {
      color: false,
      lineMax: 110,
      generatedAt: Date.parse("2026-09-11T00:00:00+00:00"),
    });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("needs_decision —");
    expect(lines[1]).toContain("watchdog: agent-gateway dispatch stuck");
  });

  test("inFlightJob prefers validation_job, then implement_job, then dispatch_job", async () => {
    const board = await fetchWardenBoard({
      fetchImpl: async () =>
        jsonResponse(
          rawBoard({
            items: [
              rawItem({
                event_id: 1,
                dispatch_job: "d-1",
                implement_job: "i-1",
                validation_job: "v-1",
              }),
              rawItem({ event_id: 2, dispatch_job: "d-2", implement_job: "i-2" }),
              rawItem({ event_id: 3, dispatch_job: "d-3" }),
            ],
          }),
        ),
    });
    if (!board.ok) throw new Error("unreachable");
    expect(board.items.map((i) => i.inFlightJob)).toEqual(["v-1", "i-2", "d-3"]);
  });

  test("caps items at 20 and sets itemsTruncated", async () => {
    const items = Array.from({ length: 25 }, (_, i) => rawItem({ event_id: i }));
    const board = await fetchWardenBoard({
      fetchImpl: async () => jsonResponse(rawBoard({ items })),
    });
    if (!board.ok) throw new Error("unreachable");
    expect(board.items).toHaveLength(20);
    expect(board.itemsTruncated).toBe(true);
    // Cap keeps warden's own updated_at DESC order — first 20, not last.
    expect(board.items[0]?.eventId).toBe(0);
  });

  test("exactly 20 items — itemsTruncated stays false unless warden itself said truncated", async () => {
    const items = Array.from({ length: 20 }, (_, i) => rawItem({ event_id: i }));
    const board = await fetchWardenBoard({
      fetchImpl: async () => jsonResponse(rawBoard({ items })),
    });
    if (!board.ok) throw new Error("unreachable");
    expect(board.items).toHaveLength(20);
    expect(board.itemsTruncated).toBe(false);
  });

  test("exactly 20 items with warden's own `truncated: true` — itemsTruncated is true", async () => {
    const items = Array.from({ length: 20 }, (_, i) => rawItem({ event_id: i }));
    const board = await fetchWardenBoard({
      fetchImpl: async () => jsonResponse(rawBoard({ items, truncated: true })),
    });
    if (!board.ok) throw new Error("unreachable");
    expect(board.items).toHaveLength(20);
    expect(board.itemsTruncated).toBe(true);
  });

  test("0 items — empty board, itemsTruncated false", async () => {
    const board = await fetchWardenBoard({
      fetchImpl: async () => jsonResponse(rawBoard({ items: [] })),
    });
    if (!board.ok) throw new Error("unreachable");
    expect(board.items).toHaveLength(0);
    expect(board.itemsTruncated).toBe(false);
  });
});

describe("fetchWardenBoard — failure modes", () => {
  test("a non-2xx status resolves to ok:false with the status in the error", async () => {
    const board = await fetchWardenBoard({
      fetchImpl: async () => jsonResponse({ error: "schema mismatch" }, 503),
    });
    expect(board.ok).toBe(false);
    if (board.ok) throw new Error("unreachable");
    expect(board.error).toContain("503");
  });

  test("a network/timeout error (rejected fetch) resolves to ok:false, never throws", async () => {
    const board = await fetchWardenBoard({
      fetchImpl: async () => {
        throw new Error("The operation was aborted");
      },
    });
    expect(board.ok).toBe(false);
    if (board.ok) throw new Error("unreachable");
    expect(board.error).toContain("aborted");
  });

  test("malformed JSON resolves to ok:false, never throws", async () => {
    const board = await fetchWardenBoard({
      fetchImpl: async () => new Response("not json", { status: 200 }),
    });
    expect(board.ok).toBe(false);
    if (board.ok) throw new Error("unreachable");
    expect(board.error).toBeTruthy();
  });

  test("a response that parses but fails schema validation resolves to ok:false", async () => {
    const board = await fetchWardenBoard({
      fetchImpl: async () => jsonResponse({ nonsense: true }),
    });
    expect(board.ok).toBe(false);
    if (board.ok) throw new Error("unreachable");
    expect(board.error).toContain("schema validation");
  });
});

// ── the no-options default path — the URL drift that rotted to 7734 when warden moved ───────

describe("fetchWardenBoard — default baseUrl", () => {
  const savedEnv = process.env.WARDEN_API_URL;

  afterAll(() => {
    if (savedEnv === undefined) delete process.env.WARDEN_API_URL;
    else process.env.WARDEN_API_URL = savedEnv;
  });

  test("with only fetchImpl injected, requests warden's loopback default (7735)", async () => {
    delete process.env.WARDEN_API_URL;
    const urls: string[] = [];
    const board = await fetchWardenBoard({
      fetchImpl: async (input: string | URL) => {
        urls.push(String(input));
        return jsonResponse(rawBoard());
      },
    });
    expect(board.ok).toBe(true);
    expect(urls[0]?.startsWith("http://127.0.0.1:7735")).toBe(true);
  });
});

// ── cachedFetchWardenBoard (server/lib/overview-payload.ts) — the 45 s TTL ──────────────────

describe("cachedFetchWardenBoard", () => {
  afterAll(() => setSystemTime());

  test("reuses the same promise for calls within the TTL", async () => {
    __resetWardenBoardCacheForTests();
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse(rawBoard());
    };

    const first = await cachedFetchWardenBoard({ fetchImpl });
    setSystemTime(new Date("2026-01-01T00:00:44Z")); // 44s later — still within 45s TTL
    const second = await cachedFetchWardenBoard({ fetchImpl });

    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });

  test("refetches once the TTL has elapsed", async () => {
    __resetWardenBoardCacheForTests();
    setSystemTime(new Date("2026-01-02T00:00:00Z"));
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse(rawBoard());
    };

    await cachedFetchWardenBoard({ fetchImpl });
    setSystemTime(new Date("2026-01-02T00:00:46Z")); // 46s later — past the 45s TTL
    await cachedFetchWardenBoard({ fetchImpl });

    expect(calls).toBe(2);
  });
});
