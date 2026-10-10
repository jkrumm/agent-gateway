// scripts/opencode-safe: preflight curl + `exec timeout … opencode`. Exit 75 on an
// unreachable/unresolvable IU base; otherwise opencode's own behaviour. No real opencode:
// a stub on PATH records its argv.

import { beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "opencode-safe");
let stubDir: string;
let argvFile: string;

beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), "opencode-safe-test-"));
  argvFile = join(stubDir, "argv.txt");
  const stub = join(stubDir, "opencode");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\nexit 7\n`);
  chmodSync(stub, 0o755);
});

async function run(env: Record<string, string>) {
  const t0 = performance.now();
  const proc = Bun.spawn([SCRIPT, "run", "--format", "json", "hello"], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      HOME: stubDir,
      ...env,
    },
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, stderr, ms: performance.now() - t0 };
}

describe("scripts/opencode-safe", () => {
  test("closed localhost port: exits 75 in <10s with a one-line stderr, never runs opencode", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const port = server.port;
    await server.stop(true);
    const { code, stderr, ms } = await run({
      IU_OPENAI_BASE: `http://127.0.0.1:${port}/openai/v1`,
    });
    expect(code).toBe(75);
    expect(ms).toBeLessThan(10_000);
    expect(stderr.trim().split("\n")).toHaveLength(1);
    expect(stderr).toContain("opencode-safe: IU endpoint unreachable");
  });

  test("reachable (404 counts): execs opencode with the original argv and its exit code", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("nope", { status: 404 }),
    });
    try {
      const { code } = await run({ IU_OPENAI_BASE: `http://127.0.0.1:${server.port}/openai/v1` });
      expect(code).toBe(7);
      expect(readFileSync(argvFile, "utf-8").trim().split("\n")).toEqual([
        "run",
        "--format",
        "json",
        "hello",
      ]);
    } finally {
      await server.stop(true);
    }
  });

  test("IU_BASE_URL (…/anthropic) is rewritten to the OpenAI base", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    try {
      const { code } = await run({ IU_BASE_URL: `http://127.0.0.1:${server.port}/anthropic` });
      expect(code).toBe(7);
    } finally {
      await server.stop(true);
    }
  });
});
