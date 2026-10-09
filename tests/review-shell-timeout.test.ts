import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __shellForTests } from "../server/jobs/handlers/review.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("shell() timeout kills the wrapper's children, not just the wrapper", async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), "shell-timeout-")), "pid");
  const started = Date.now();
  await __shellForTests(`sleep 300 & echo $! > ${pidFile}; wait`, process.cwd(), 500);
  const pid = Number(readFileSync(pidFile, "utf-8").trim());
  expect(Number.isInteger(pid)).toBe(true);
  expect(Date.now() - started).toBeLessThan(8_000);
  await Bun.sleep(200);
  expect(alive(pid)).toBe(false);
}, 20_000);

test("shell() keeps its return contract", async () => {
  expect(await __shellForTests("echo out; echo err >&2", process.cwd())).toEqual({
    stdout: "out\nerr",
    ok: true,
  });
  expect((await __shellForTests("echo boom; exit 3", process.cwd())).ok).toBe(false);
});
