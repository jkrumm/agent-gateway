// scripts/deploy.sh against a throwaway git repo, with `make`, `sleep` and the preflight script
// stubbed on PATH / in the copied tree. The script `cd`s to its own parent dir, so it is copied
// into the temp repo's scripts/ and the real checkout is never touched.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEPLOY_SH = join(import.meta.dir, "..", "scripts", "deploy.sh");

let root: string;
let binDir: string;
let callsLog: string;

function sh(cmd: string, cwd = root): string {
  const r = Bun.spawnSync(["bash", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" });
  return r.stdout.toString() + r.stderr.toString();
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deploy-script-"));
  binDir = join(root, ".stubbin");
  callsLog = join(root, ".calls.log");
  mkdirSync(binDir);
  mkdirSync(join(root, "scripts"));
  copyFileSync(DEPLOY_SH, join(root, "scripts", "deploy.sh"));
  chmodSync(join(root, "scripts", "deploy.sh"), 0o755);
  // Preflight stub: exit code from PREFLIGHT_RC (default 0).
  writeExecutable(
    join(root, "scripts", "reload-preflight.sh"),
    `#!/usr/bin/env bash\necho "preflight" >> "$CALLS_LOG"\nexit "\${PREFLIGHT_RC:-0}"\n`,
  );
  // make stub: records "make <target>". reload exits MAKE_RELOAD_RC; the first
  // MAKE_VERIFY_FAILS verify calls fail (default 0), later ones succeed.
  writeExecutable(
    join(binDir, "make"),
    `#!/usr/bin/env bash
target="\${@: -1}"
echo "make $target" >> "$CALLS_LOG"
case "$target" in
  reload) exit "\${MAKE_RELOAD_RC:-0}" ;;
  install-opencode-agent) exit "\${MAKE_INSTALL_OC_RC:-0}" ;;
  verify)
    n=$(cat "$STUB_STATE/verify-count" 2>/dev/null || echo 0)
    echo $((n + 1)) > "$STUB_STATE/verify-count"
    [ "$n" -lt "\${MAKE_VERIFY_FAILS:-0}" ] && exit 1
    exit 0 ;;
esac
exit 0
`,
  );
  writeExecutable(join(binDir, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  // launchctl stub: `print` (is the opencode agent loaded?) exits LAUNCHCTL_PRINT_RC, default 0 (loaded).
  writeExecutable(
    join(binDir, "launchctl"),
    `#!/usr/bin/env bash\nexit "\${LAUNCHCTL_PRINT_RC:-0}"\n`,
  );
  // bun stub: `scripts/opencode-server-env.ts --status` prints STUB_OC_STATUS (default ok).
  writeExecutable(
    join(binDir, "bun"),
    `#!/usr/bin/env bash\ndefault='{"ok":true}'\nprintf '%s\\n' "\${STUB_OC_STATUS:-$default}"\n`,
  );
  // curl stub: the new build's /api/jobs/health, STUB_HEALTH (default: everything ok).
  writeExecutable(
    join(binDir, "curl"),
    `#!/usr/bin/env bash\ndefault='{"ok":true,"degradedRoutes":[],"opencodeServer":{"ok":true}}'\nprintf '%s\\n' "\${STUB_HEALTH:-$default}"\n`,
  );
  mkdirSync(join(root, ".stubstate"));
  writeFileSync(join(root, ".gitignore"), ".stubbin\n.stubstate\n.calls.log\n");
  sh(
    "git init -q -b master && git config user.email t@example.com && git config user.name t && " +
      "git add -A && git commit -q -m one && echo x > x.txt && git add x.txt && git commit -q -m two",
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function deploy(env: Record<string, string> = {}): { code: number; out: string; calls: string[] } {
  const r = Bun.spawnSync(["bash", join(root, "scripts", "deploy.sh")], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      CALLS_LOG: callsLog,
      STUB_STATE: join(root, ".stubstate"),
      ...env,
    },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(callsLog, "utf-8").trim().split("\n");
  } catch {}
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString(), calls };
}

const isDetached = () => sh("git symbolic-ref -q HEAD || echo DETACHED").includes("DETACHED");

describe("scripts/deploy.sh", () => {
  test("happy path: preflight, reload, verify, exit 0, no rollback", () => {
    const r = deploy();
    expect(r.code).toBe(0);
    expect(r.calls).toEqual(["preflight", "make reload", "make verify"]);
    expect(isDetached()).toBe(false);
  });

  test("opencode agent not loaded: installed once before the reload", () => {
    const r = deploy({ LAUNCHCTL_PRINT_RC: "113" });
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([
      "preflight",
      "make install-opencode-agent",
      "make reload",
      "make verify",
    ]);
  });

  test("opencode agent install fails: exit 1 before any reload, no rollback", () => {
    const r = deploy({ LAUNCHCTL_PRINT_RC: "113", MAKE_INSTALL_OC_RC: "1" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("opencode LaunchAgent could not be installed");
    expect(r.calls).toEqual(["preflight", "make install-opencode-agent"]);
    expect(isDetached()).toBe(false);
  });

  test("opencode server not ok after the agent check: abort before any reload, no rollback", () => {
    const r = deploy({
      STUB_OC_STATUS: '{"ok":false,"error":"opencode server password rejected"}',
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("opencode server is not ok");
    expect(r.out).toContain("make install-opencode-agent");
    expect(r.out).toContain("password rejected");
    expect(r.calls).toEqual(["preflight"]);
    expect(isDetached()).toBe(false);
  });

  test("verify fails ONLY on the opencode server: reported as such, master is not rolled back", () => {
    const r = deploy({
      MAKE_VERIFY_FAILS: "999",
      STUB_HEALTH: '{"ok":true,"degradedRoutes":[],"opencodeServer":{"ok":false}}',
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("ONLY on the opencode server");
    expect(r.out).not.toContain("rolling back to");
    expect(r.calls.filter((c) => c === "make reload")).toHaveLength(1);
    expect(isDetached()).toBe(false);
    expect(sh("git log -1 --format=%s").trim()).toBe("two");
  });

  test("verify fails for another reason while the opencode server is also not ok: still rolls back", () => {
    const r = deploy({
      MAKE_VERIFY_FAILS: "999",
      STUB_HEALTH: '{"ok":false,"degradedRoutes":[],"opencodeServer":{"ok":false}}',
    });
    expect(r.out).toContain("rolling back");
    expect(isDetached()).toBe(true);
  });

  test("preflight refusal (exit 3): exit 1, never reloads, never switches", () => {
    const r = deploy({ PREFLIGHT_RC: "3" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("REFUSED");
    expect(r.calls).toEqual(["preflight"]);
    expect(isDetached()).toBe(false);
  });

  test("preflight erroring with another code: exit 1, no reload, no rollback", () => {
    const r = deploy({ PREFLIGHT_RC: "7" });
    expect(r.code).toBe(1);
    expect(r.calls).toEqual(["preflight"]);
    expect(isDetached()).toBe(false);
  });

  test("reload ok + verify fails throughout: rollback attempted, ends detached at HEAD~1, exit 1", () => {
    const r = deploy({ MAKE_VERIFY_FAILS: "999" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("rolling back");
    expect(r.out).toContain("ROLLBACK ALSO FAILED");
    expect(r.calls.filter((c) => c === "make reload")).toHaveLength(2);
    expect(isDetached()).toBe(true);
    expect(sh("git log -1 --format=%s").trim()).toBe("one");
  });

  test("verify fails once for the new build then passes after rollback: ROLLED BACK banner", () => {
    const r = deploy({ MAKE_VERIFY_FAILS: "5" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("ROLLED BACK");
    expect(isDetached()).toBe(true);
  });

  test("reload fails after preflight passed (old server may be gone): rollback path, not a bare exit", () => {
    const r = deploy({ MAKE_RELOAD_RC: "2" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("rolling back");
    expect(r.calls.filter((c) => c === "make reload").length).toBeGreaterThanOrEqual(2);
    expect(isDetached()).toBe(true);
  });

  test("dirty tree: refuses to roll back, no git switch", () => {
    writeFileSync(join(root, "dirty.txt"), "wip");
    const r = deploy({ MAKE_VERIFY_FAILS: "999" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("refusing to roll back");
    expect(r.calls.filter((c) => c === "make reload")).toHaveLength(1);
    expect(isDetached()).toBe(false);
    expect(sh("git log -1 --format=%s").trim()).toBe("two");
  });
});
