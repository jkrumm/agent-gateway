// server/lib/voice.ts — the one voice-guide loader `narrative` and `prose` share: one path
// (AGENT_GATEWAY_VOICE_PATH), one cap, and the two missing-file policies.

import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appLogger } from "../server/logger.ts";
import { VOICE_MAX_BYTES, readVoiceGuide } from "../server/lib/voice.ts";

const dir = mkdtempSync(join(tmpdir(), "agw-voice-"));
const prev = process.env.AGENT_GATEWAY_VOICE_PATH;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  if (prev === undefined) delete process.env.AGENT_GATEWAY_VOICE_PATH;
  else process.env.AGENT_GATEWAY_VOICE_PATH = prev;
});

function voiceFile(content: string): string {
  const path = join(dir, `voice-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(path, content);
  process.env.AGENT_GATEWAY_VOICE_PATH = path;
  return path;
}

describe("readVoiceGuide", () => {
  test("the cap is 16 KB, above today's ~13 KB guide", () => {
    expect(VOICE_MAX_BYTES).toBe(16 * 1024);
  });

  test("a 13 KB guide is read whole", async () => {
    const guide = "x".repeat(13 * 1024);
    voiceFile(guide);
    expect(await readVoiceGuide({ required: false })).toBe(guide);
    expect(await readVoiceGuide({ required: true })).toBe(guide);
  });

  test("a guide over the cap is truncated to it and warned about", async () => {
    const path = voiceFile("é".repeat(VOICE_MAX_BYTES));
    const warn = spyOn(appLogger, "warn").mockImplementation((() => {}) as never);
    try {
      const text = await readVoiceGuide({ required: true });
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(VOICE_MAX_BYTES);
      expect(text.length).toBeGreaterThan(VOICE_MAX_BYTES / 2 - 2);
      const [fields] = warn.mock.calls[0] as unknown as [Record<string, unknown>];
      expect(fields).toMatchObject({ event: "voice.truncated", path, maxBytes: VOICE_MAX_BYTES });
    } finally {
      warn.mockRestore();
    }
  });

  test("a missing file is empty for narrative and a loud failure for prose", async () => {
    process.env.AGENT_GATEWAY_VOICE_PATH = join(dir, "missing.md");
    expect(await readVoiceGuide({ required: false })).toBe("");
    await expect(readVoiceGuide({ required: true })).rejects.toThrow("voice guide not readable at");
  });
});
