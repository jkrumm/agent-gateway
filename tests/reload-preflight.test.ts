// scripts/reload-preflight.sh's running-jobs refusal (the plist-drift checks are skipped here:
// HOME points at an empty dir, so there is no installed plist, and a stub `launchctl` reports no
// live ExitTimeOut). `curl` is a stub that answers GET /api/jobs/health with STUB_HEALTH. Only
// jobs a reload cannot detach count: `drainBlockers` — an OpenCode session never refuses.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reload-preflight-"));
  for (const [name, body] of [
    ["curl", `#!/usr/bin/env bash\nprintf '%s\\n' "$STUB_HEALTH"\n`],
    ["launchctl", "#!/usr/bin/env bash\nexit 0\n"],
  ] as const) {
    writeFileSync(join(tmp, name), body);
    chmodSync(join(tmp, name), 0o755);
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function preflight(health: object | null, env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bash", join(ROOT, "scripts", "reload-preflight.sh")], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: tmp,
      PATH: `${tmp}:${process.env.PATH}`,
      STUB_HEALTH: health === null ? "" : JSON.stringify(health),
      FORCE: "",
      ...env,
    },
  });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

describe("reload-preflight.sh — running jobs", () => {
  test("idle server: clear to reload", () => {
    expect(preflight({ running: 0, drainBlockers: 0, singleShot: { running: 0 } }).code).toBe(0);
  });

  test("OpenCode-only runs (running > 0, no blockers) no longer refuse", () => {
    expect(preflight({ running: 3, drainBlockers: 0, singleShot: { running: 0 } }).code).toBe(0);
  });

  test("a job a reload cannot detach refuses with exit 3 and says so", () => {
    const r = preflight({ running: 3, drainBlockers: 1, singleShot: { running: 0 } });
    expect(r.code).toBe(3);
    expect(r.out).toContain("1 job(s) running that a reload cannot detach");
    expect(r.out).toContain("FORCE=1");
  });

  test("a single-shot job alone does not refuse (as before: it was never counted)", () => {
    expect(preflight({ running: 0, drainBlockers: 2, singleShot: { running: 2 } }).code).toBe(0);
  });

  test("FORCE=1 skips the refusal", () => {
    const r = preflight(
      { running: 3, drainBlockers: 3, singleShot: { running: 0 } },
      { FORCE: "1" },
    );
    expect(r.code).toBe(0);
  });

  test("an older server without the field falls back to every running job", () => {
    expect(preflight({ running: 2 }).code).toBe(3);
    expect(preflight({ running: 0 }).code).toBe(0);
  });

  test("an unreachable server (empty answer) is not a refusal", () => {
    expect(preflight(null).code).toBe(0);
  });
});
