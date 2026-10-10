// `readTrimmedLines` (server/mcp/worker-shared.ts): the line splitter both worker harnesses and
// the IU SSE reader share. Pins chunk-boundary handling, the trailing partial line, and the
// final decoder flush.

import { describe, expect, test } from "bun:test";
import { readTrimmedLines } from "../server/mcp/worker-shared.ts";

function streamOf(...chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const lines: string[] = [];
  let chunks = 0;
  const trailing = await readTrimmedLines(stream, {
    onChunk: () => chunks++,
    onLine: (l) => lines.push(l),
  });
  return { lines, chunks, trailing };
}

describe("readTrimmedLines", () => {
  test("reassembles a line split across chunks, trims, and skips blank lines", async () => {
    const { lines, chunks, trailing } = await collect(streamOf('{"a":', '1}\n  \n  {"b":2} \n'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(chunks).toBe(2);
    expect(trailing).toBe("");
  });

  test("returns the trailing partial line untouched, without emitting it", async () => {
    const { lines, trailing } = await collect(streamOf("one\ntwo", " three"));
    expect(lines).toEqual(["one"]);
    expect(trailing).toBe("two three");
  });

  test("a multi-byte character split across chunks decodes intact", async () => {
    const bytes = new TextEncoder().encode("é\nü");
    const { lines, trailing } = await collect(streamOf(bytes.slice(0, 1), bytes.slice(1)));
    expect(lines).toEqual(["é"]);
    expect(trailing).toBe("ü");
  });

  test("a multi-byte sequence left half-open at EOF is flushed, not silently dropped", async () => {
    const bytes = new TextEncoder().encode("okü");
    const { trailing } = await collect(streamOf(bytes.slice(0, bytes.length - 1)));
    // the dangling lead byte flushes as U+FFFD instead of vanishing
    expect(trailing).toBe("ok�");
  });

  test("releases the reader lock even when onLine throws", async () => {
    const stream = streamOf("x\n");
    await expect(
      readTrimmedLines(stream, {
        onLine: () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
    expect(stream.locked).toBe(false);
  });
});
