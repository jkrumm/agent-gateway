import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { appLogger as logger } from "../logger.ts";

// The voice guide (brain/voice.md): the one style contract `narrative` and `prose` both write to.
// One loader, one cap, one path. `narrative` treats a missing file as "no voice" (a page can still
// be written); `prose` is the voice owner's rewrite and has nothing honest to do without it, so it
// fails loudly (`required`).

/** Cap on the voice guide read into a prompt. The guide is ~13 KB today; the cap leaves headroom
 *  and a file past it is cut (and warned about) rather than silently losing its tail. */
export const VOICE_MAX_BYTES = 16 * 1024;

const VOICE_PATH_ENV = "AGENT_GATEWAY_VOICE_PATH";

function voicePath(): string {
  return process.env[VOICE_PATH_ENV] ?? join(homedir(), "SourceRoot", "brain", "voice.md");
}

/** Cut `text` to `VOICE_MAX_BYTES` UTF-8 bytes, dropping a character split by the cut. */
function capVoice(text: string, path: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= VOICE_MAX_BYTES) return text;
  logger.warn(
    { event: "voice.truncated", path, bytes, maxBytes: VOICE_MAX_BYTES },
    "voice guide exceeds the cap and is truncated",
  );
  return Buffer.from(text, "utf8").subarray(0, VOICE_MAX_BYTES).toString("utf8").replace(/�$/, "");
}

/** Read the voice guide. `required: true` throws when it is not readable; `required: false`
 *  returns "" for a missing or unreadable file. */
export async function readVoiceGuide({ required }: { required: boolean }): Promise<string> {
  const path = voicePath();
  try {
    return capVoice(await readFile(path, "utf8"), path);
  } catch (err) {
    if (!required) return "";
    throw new Error(
      `voice guide not readable at ${path} (set ${VOICE_PATH_ENV}): ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
