// Schema-tolerance bounds of server/lib/warden-board.ts, pinned as implemented:
//
//   - `counts` is `.catchall(z.number())`: the seven known chain states are required numbers, any
//     OTHER numeric key (a future `snoozed`) is kept and counted into `open`, and a non-numeric
//     extra key fails validation (-> ok:false) instead of being passed through as `unknown`.
//   - board items are a plain `z.object` (no catchall): unknown extra fields are TOLERATED but
//     STRIPPED, never passed through to the normalized `WardenItem`.
//   - `repo: null` is valid (nullable), and `repo` itself is required.
//
// No real network — `fetchImpl` is injected, same pattern as tests/warden-board.test.ts.

import { describe, expect, test } from "bun:test";
import { fetchWardenBoard } from "../server/lib/warden-board.ts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const KNOWN_COUNTS = {
  new: 1,
  triaged: 0,
  working: 2,
  merging: 0,
  verifying: 0,
  needs_decision: 3,
  failed: 0,
};

function rawItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: 7,
    origin: "alert",
    repo: "warden",
    state: "needs_decision",
    title: "something",
    updated_at: "2026-09-11T00:00:00+00:00",
    ...overrides,
  };
}

function rawBoard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generated_at: "2026-09-11T00:00:00+00:00",
    counts: KNOWN_COUNTS,
    items: [rawItem()],
    terminal_24h: 0,
    ...overrides,
  };
}

async function fetchBoard(body: unknown) {
  return fetchWardenBoard({ fetchImpl: async () => jsonResponse(body) });
}

describe("counts catchall", () => {
  test("an unrecognized numeric state is kept readable and counted into `open`", async () => {
    const board = await fetchBoard(rawBoard({ counts: { ...KNOWN_COUNTS, snoozed: 4 } }));
    expect(board.ok).toBe(true);
    if (!board.ok) throw new Error("unreachable");
    expect(board.counts.snoozed).toBe(4);
    expect(board.counts.needs_decision).toBe(3);
    // 1 + 2 + 3 known + 4 extra
    expect(board.open).toBe(10);
  });

  test("a non-numeric extra key in counts fails schema validation", async () => {
    const board = await fetchBoard(rawBoard({ counts: { ...KNOWN_COUNTS, snoozed: "four" } }));
    expect(board.ok).toBe(false);
    if (board.ok) throw new Error("unreachable");
    expect(board.error).toContain("schema validation");
  });

  test("a missing known state fails schema validation instead of defaulting to 0", async () => {
    const { failed: _failed, ...withoutFailed } = KNOWN_COUNTS;
    const board = await fetchBoard(rawBoard({ counts: withoutFailed }));
    expect(board.ok).toBe(false);
  });
});

describe("item extra fields", () => {
  test("unknown extra fields on an item are tolerated but not passed through", async () => {
    const board = await fetchBoard(
      rawBoard({
        items: [rawItem({ priority: "high", labels: ["a", "b"], nested: { deep: true } })],
      }),
    );
    expect(board.ok).toBe(true);
    if (!board.ok) throw new Error("unreachable");
    expect(board.items).toHaveLength(1);
    const item = board.items[0];
    expect(item).toEqual({
      eventId: 7,
      origin: "alert",
      repo: "warden",
      state: "needs_decision",
      title: "something",
      note: null,
      prUrl: null,
      updatedAt: "2026-09-11T00:00:00+00:00",
      inFlightJob: null,
    });
    expect(item).not.toHaveProperty("priority");
    expect(item).not.toHaveProperty("labels");
    expect(item).not.toHaveProperty("nested");
  });

  test("extra top-level board fields are tolerated and dropped", async () => {
    const board = await fetchBoard(rawBoard({ schema_version: 99, brand_new: { x: 1 } }));
    expect(board.ok).toBe(true);
    if (!board.ok) throw new Error("unreachable");
    expect(board).not.toHaveProperty("schema_version");
    expect(board).not.toHaveProperty("brand_new");
  });

  test("repo: null is carried through as null alongside extra fields", async () => {
    const board = await fetchBoard(
      rawBoard({ items: [rawItem({ repo: null, occurrences: 3, state_deadline: "x" })] }),
    );
    expect(board.ok).toBe(true);
    if (!board.ok) throw new Error("unreachable");
    expect(board.items[0]?.repo).toBeNull();
  });

  test("a missing `repo` key (not null) fails schema validation", async () => {
    const { repo: _repo, ...noRepo } = rawItem();
    const board = await fetchBoard(rawBoard({ items: [noRepo] }));
    expect(board.ok).toBe(false);
    if (board.ok) throw new Error("unreachable");
    expect(board.error).toContain("schema validation");
  });

  test("an extra item field never changes a required field's type check", async () => {
    const board = await fetchBoard(rawBoard({ items: [rawItem({ title: 42, extra: "ok" })] }));
    expect(board.ok).toBe(false);
  });
});
