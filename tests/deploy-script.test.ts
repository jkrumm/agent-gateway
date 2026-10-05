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
