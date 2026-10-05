import Elysia, { t } from "elysia";
import { findChrome } from "../lib/chrome.ts";

const ALLOWED_ORIGINS = ["http://sideclaw.local", "http://localhost"];

export const kioskRoute = new Elysia().get(
  "/api/open-kiosk",
  async ({ query, set }) => {
    const { url } = query;
    if (!ALLOWED_ORIGINS.some((o) => url.startsWith(o))) {
      set.status = 400;
      return { ok: false, error: "URL must be a local sideclaw URL" };
    }

    const chrome = await findChrome();
    if (!chrome) {
      set.status = 503;
      return { ok: false, error: "No Chrome binary found" };
    }

    // Isolated profile so kiosk doesn't interfere with existing Chrome sessions
    // Exit kiosk: Cmd+Q (Esc does NOT work in Chrome kiosk)
    Bun.spawn([chrome, "--kiosk", "--user-data-dir=/tmp/sideclaw-kiosk", url], {
      stdio: ["ignore", "ignore", "ignore"],
    });

    return { ok: true };
  },
  {
    query: t.Object({ url: t.String() }),
  },
);
