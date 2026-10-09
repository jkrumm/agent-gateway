// The unavailable-log gate in server/lib/warden-board.ts: an unreachable warden used to warn on
// every poll (18.9k identical lines). One line per distinct error per 5 min, the next one
// carrying how many were swallowed. Clock injected via FetchWardenBoardOptions.now.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appLogger } from "../server/logger.ts";
import { __resetUnavailableLogForTests, fetchWardenBoard } from "../server/lib/warden-board.ts";

const WINDOW_MS = 5 * 60 * 1000;
const fixedNow = () => 1_000_000;

function failing(message: string) {
  return async () => {
    throw new Error(message);
  };
}

let warn: ReturnType<typeof spyOn<typeof appLogger, "warn">>;

beforeEach(() => {
  __resetUnavailableLogForTests();
  warn = spyOn(appLogger, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe("warden.board_unavailable rate limit", () => {
  test("logs once per distinct error inside the window and still returns ok:false each time", async () => {
    let t = 1_000_000;
    const now = () => t;
    for (let i = 0; i < 5; i++) {
      const board = await fetchWardenBoard({ fetchImpl: failing("connect refused"), now });
      expect(board.ok).toBe(false);
      t += 1000;
    }
    expect(warn).toHaveBeenCalledTimes(1);
    const fields = warn.mock.calls[0]![0] as Record<string, unknown>;
    expect(fields.event).toBe("warden.board_unavailable");
    expect(fields.suppressed).toBeUndefined();
  });

  test("a different error string is logged on its own", async () => {
    await fetchWardenBoard({ fetchImpl: failing("connect refused"), now: fixedNow });
    await fetchWardenBoard({ fetchImpl: failing("timed out"), now: fixedNow });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("the first line after the window carries the suppressed count", async () => {
    let t = 1_000_000;
    const now = () => t;
    for (let i = 0; i < 4; i++) {
      await fetchWardenBoard({ fetchImpl: failing("connect refused"), now });
      t += 1000;
    }
    expect(warn).toHaveBeenCalledTimes(1);

    t = 1_000_000 + WINDOW_MS;
    await fetchWardenBoard({ fetchImpl: failing("connect refused"), now });
    expect(warn).toHaveBeenCalledTimes(2);
    expect((warn.mock.calls[1]![0] as Record<string, unknown>).suppressed).toBe(3);

    // The count is consumed: the following emission after another window carries none.
    t += WINDOW_MS;
    await fetchWardenBoard({ fetchImpl: failing("connect refused"), now });
    expect(warn).toHaveBeenCalledTimes(3);
    expect((warn.mock.calls[2]![0] as Record<string, unknown>).suppressed).toBeUndefined();
  });
});
