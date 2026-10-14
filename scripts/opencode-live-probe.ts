// Live probe of the SHARED OpenCode server path (needs the LaunchAgent running, the IU key and the
// server password file). Re-run after any opencode upgrade or change to opencode-runner.ts /
// opencode-client.ts / opencode-server.ts:   env -u CLAUDECODE bun scripts/opencode-live-probe.ts
//
// Drives the production HTTP path — `createOpencodeClient` + `driveOpencodeSession` +
// `summarizeOpencodeMessages`, with the same session spec/env the runner builds — against the
// running server, in scratch git repos under os.tmpdir(). Costs a few cents of IU tokens; never
// run from CI. Each check has a discriminating control, so a model that simply skipped a step
// cannot make a refusal check pass vacuously:
//   1. agw-readonly runs the allowlisted reads (`git status`, `cat`, `rg`) — liveness control —
//      and refuses `touch`, `echo > f`, `curl -o` and any file-write tool (files absent after).
//   2. agw-implement writes a file (control: the probe CAN observe a write).
//   3. The shell runs in `location.directory`, not the probe's own cwd.
//   4. Per-session environment: extraEnv and the git credential deny reach the shell, and the
//      server's credentials (`OPENCODE_SESSION_BLANKED_ENV`) are EMPTY there (a recorded
//      measurement notes whether an unblanked shell would have inherited them).
//   5. Usage comes from the messages: tokens and cost are present, the settled rollup is not below
//      the message sum.
//   6. Cancel: `terminateSessionsForJob` (the real job-cancel path) interrupts a running session —
//      it goes idle and `late.txt` never appears; control: an abandoned session DOES write it.
//   7. Three concurrent sessions complete with no lock error.
// Every printed line passes through a redactor for the IU key and the server password.
// Exits non-zero on any failed check.

import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_DENY_CREDENTIALS_ENV } from "../server/jobs/handlers/dispatch-git.ts";
import { getIuConfig } from "../server/lib/iu-openai.ts";
import { DEEPSEEK_V41_FLASH } from "../server/lib/routing.ts";
import { createOpencodeClient, type OpencodeMessage } from "../server/mcp/opencode-client.ts";
import { driveOpencodeSession, summarizeOpencodeMessages } from "../server/mcp/opencode-runner.ts";
import {
  getOpencodeServerStatus,
  OPENCODE_AGENT_IMPLEMENT,
  OPENCODE_AGENT_READONLY,
  OPENCODE_PROVIDER_CHAT,
  OPENCODE_SESSION_BLANKED_ENV,
  opencodeServerUrl,
  readServerPassword,
} from "../server/mcp/opencode-server.ts";
import {
  __resetActiveProcsForTests,
  terminateSessionsForJob,
} from "../server/mcp/session-runner.ts";

const MODEL = DEEPSEEK_V41_FLASH;
const LATE_SLEEP_S = 25;

let failures = 0;
const secrets: string[] = [];
const redact = (text: string): string =>
  secrets.reduce((out, secret) => (secret ? out.split(secret).join("[REDACTED]") : out), text);
const say = (line: string): void => console.log(redact(line));
function check(name: string, ok: boolean, detail = ""): void {
  say(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

// ── Preconditions ───────────────────────────────────────────────────────────────────────────
const iu = await getIuConfig();
const password = readServerPassword();
secrets.push(iu.key, password);

const status = await getOpencodeServerStatus();
say(`server ${opencodeServerUrl()}  ${JSON.stringify(status)}`);
check("the shared server is up, authenticated and the pinned build", status.ok, status.error ?? "");
if (!status.ok) process.exit(1);

const client = createOpencodeClient();

// ── Scratch repo ────────────────────────────────────────────────────────────────────────────
// realpath: macOS resolves os.tmpdir() through /var -> /private/var, and `pwd` reports the latter.
const scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), "agw-oc-probe-")));
process.on("exit", () => rmSync(scratchRoot, { recursive: true, force: true }));
function scratchRepo(name: string): string {
  const dir = join(scratchRoot, name);
  Bun.spawnSync(["mkdir", "-p", dir]);
  writeFileSync(join(dir, "seed.txt"), "SEED_MARKER\n");
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  return dir;
}
say(`scratch: ${scratchRoot}  (probe cwd: ${process.cwd()})`);

// ── Running one session exactly as the runner does ──────────────────────────────────────────

/** The env `runOpencodeAttempt` builds: blanks, then the caller's, then the git deny. */
function productionEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(OPENCODE_SESSION_BLANKED_ENV.map((name) => [name, ""])),
    ...extra,
    ...GIT_DENY_CREDENTIALS_ENV,
  };
}

interface ToolCall {
  name: string;
  status: string;
  command?: string;
  output: string;
}
const toolCalls = (messages: OpencodeMessage[]): ToolCall[] =>
  messages
    .filter((m) => m.type === "assistant")
    .flatMap((m) => m.content ?? [])
    .filter((b) => b.type === "tool")
    .map((b) => {
      const state = b.state as
        | {
            status?: string;
            input?: { command?: string };
            content?: Array<{ text?: string }>;
            error?: unknown;
          }
        | undefined;
      return {
        name: b.name ?? "?",
        status: state?.status ?? "?",
        command: state?.input?.command,
        output:
          (state?.content ?? []).map((c) => c.text ?? "").join("") + String(state?.error ?? ""),
      };
    });

async function createSession(input: {
  agent: "readonly" | "implement";
  dir: string;
  title?: string;
}): Promise<string> {
  return client.createSession({
    directory: input.dir,
    model: { providerID: OPENCODE_PROVIDER_CHAT, id: MODEL },
    agent: input.agent === "readonly" ? OPENCODE_AGENT_READONLY : OPENCODE_AGENT_IMPLEMENT,
    ...(input.title ? { title: input.title } : {}),
  });
}

async function run(input: {
  agent: "readonly" | "implement";
  dir: string;
  prompt: string;
  env?: Record<string, string>;
  jobId?: string;
}) {
  const sessionId = await createSession(input);
  await client.setEnvironment(sessionId, input.env ?? productionEnv());
  const drive = await driveOpencodeSession(client, {
    jobId: input.jobId,
    cwd: input.dir,
    sessionId,
    prompt: input.prompt,
    logContext: { tool: "live-probe" },
    turnsRef: { current: 0 },
  });
  return {
    sessionId,
    drive,
    summary: summarizeOpencodeMessages(drive.messages),
    tools: toolCalls(drive.messages),
  };
}

const ran = (tools: ToolCall[], needle: string): ToolCall | undefined =>
  tools.find((t) => t.name === "shell" && t.command?.includes(needle));
const describeTools = (tools: ToolCall[]): string =>
  tools.map((t) => `${t.name}:${t.status}:${(t.command ?? "").slice(0, 40)}`).join(" | ");

// ── 1 + 3. agw-readonly ─────────────────────────────────────────────────────────────────────
{
  const dir = scratchRepo("readonly");
  const { drive, tools, summary } = await run({
    agent: "readonly",
    dir,
    prompt: [
      "Run these steps in order, ONE tool call each, and continue after any refusal or error:",
      "1. shell: git rev-parse --show-toplevel",
      "2. shell: git status",
      "3. shell: cat seed.txt",
      "4. shell: rg SEED_MARKER .",
      "5. shell: touch touched.txt",
      "6. shell: echo X > redirect.txt",
      "7. shell: curl -o curled.txt http://127.0.0.1:1/",
      "8. Use your file-writing tool (write or edit) to create written.txt containing X.",
      "Then reply with exactly: DONE",
    ].join("\n"),
  });
  say(
    `readonly finished=${drive.finished} outcome=${summary.outcome} tools: ${describeTools(tools)}`,
  );
  const completed = (needle: string) => ran(tools, needle)?.status === "completed";
  check(
    "readonly control: the session finished on its own",
    drive.finished && summary.outcome === "succeeded",
  );
  check(
    "readonly control: `git status`, `cat`, `rg` ran (allowlist is live)",
    completed("git status") && completed("cat seed.txt") && completed("rg SEED_MARKER"),
  );
  check(
    "shell runs in location.directory (git toplevel == scratch repo, not the probe's cwd)",
    (ran(tools, "rev-parse")?.output ?? "").trim() === dir,
    (ran(tools, "rev-parse")?.output ?? "").trim(),
  );
  for (const [file, label] of [
    ["touched.txt", "touch"],
    ["redirect.txt", "echo > f"],
    ["curled.txt", "curl -o"],
    ["written.txt", "file-write tool"],
  ] as const) {
    check(`readonly: ${label} refused — ${file} absent`, !existsSync(join(dir, file)));
  }
  check(
    "readonly: no completed edit/write tool call",
    !tools.some((t) => (t.name === "edit" || t.name === "write") && t.status === "completed"),
  );
}

// ── 2 + 4. agw-implement and the per-session environment ────────────────────────────────────
const PRESENT_CMD = (name: string) =>
  `[ -n "$${name}" ] && echo ${name}=PRESENT || echo ${name}=EMPTY`;
{
  const dir = scratchRepo("implement");
  const { drive, tools, summary } = await run({
    agent: "implement",
    dir,
    env: productionEnv({ PROBE_EXTRA: "extra-ok" }),
    prompt: [
      "Run these steps in order, ONE shell tool call each:",
      "1. shell: touch control.txt",
      "2. shell: printenv GIT_CONFIG_GLOBAL",
      "3. shell: printenv PROBE_EXTRA",
      ...OPENCODE_SESSION_BLANKED_ENV.map((name, i) => `${i + 4}. shell: ${PRESENT_CMD(name)}`),
      "Then reply with exactly: DONE",
    ].join("\n"),
  });
  say(
    `implement finished=${drive.finished} outcome=${summary.outcome} tools: ${describeTools(tools)}`,
  );
  check(
    "implement control: a write lands (the probe can observe a write)",
    existsSync(join(dir, "control.txt")),
  );
  check(
    "session env: GIT_CONFIG_GLOBAL=/dev/null reaches the shell",
    (ran(tools, "printenv GIT_CONFIG_GLOBAL")?.output ?? "").trim() === "/dev/null",
    (ran(tools, "printenv GIT_CONFIG_GLOBAL")?.output ?? "").trim(),
  );
  check(
    "session env: the caller's extraEnv reaches the shell",
    (ran(tools, "printenv PROBE_EXTRA")?.output ?? "").trim() === "extra-ok",
  );
  for (const name of OPENCODE_SESSION_BLANKED_ENV) {
    check(
      `session env: ${name} is EMPTY in the worker shell`,
      (ran(tools, PRESENT_CMD(name))?.output ?? "").trim() === `${name}=EMPTY`,
      (ran(tools, PRESENT_CMD(name))?.output ?? "").trim(),
    );
  }
}
{
  // Measurement, not a gate: on 2.0.25 the shell tool starts from a SANITIZED env (HOME, LOGNAME,
  // PATH, PWD, TERM and OPENCODE_* markers) — the server process's own env never reaches it, and
  // the per-session `PUT …/environment` is the only channel. The blanks above are therefore
  // defense in depth; if a future build starts inheriting the server env this line flips to
  // PRESENT and the blanks become load-bearing (the EMPTY checks above are the real property).
  const dir = scratchRepo("env-control");
  const { tools } = await run({
    agent: "implement",
    dir,
    env: { ...GIT_DENY_CREDENTIALS_ENV },
    prompt: `Run this ONE shell command, then reply DONE:\n${PRESENT_CMD("OPENCODE_SERVER_PASSWORD")}`,
  });
  say(
    `note: without blanking, the worker shell sees ${(ran(tools, "OPENCODE_SERVER_PASSWORD")?.output ?? "?").trim()} (server env inherited by the shell tool: ${(ran(tools, "OPENCODE_SERVER_PASSWORD")?.output ?? "").includes("PRESENT")})`,
  );
}

// ── 5. usage from the messages ──────────────────────────────────────────────────────────────
{
  const dir = scratchRepo("usage");
  const { sessionId, drive, summary } = await run({
    agent: "implement",
    dir,
    prompt: "Use your shell tool to run `echo usage-probe`, then reply DONE.",
  });
  const assistants = drive.messages.filter((m) => m.type === "assistant");
  check(
    "usage: >=2 assistant messages (a tool turn and the final turn), each with tokens",
    assistants.length >= 2 && assistants.every((m) => m.tokens !== undefined),
    `${assistants.length}`,
  );
  check(
    "usage: tokens and cost are present and the final turn is included",
    summary.inputTokens + summary.cacheReadTokens > 0 &&
      summary.costUsd > 0 &&
      summary.turns === assistants.length,
    JSON.stringify({
      turns: summary.turns,
      in: summary.inputTokens,
      out: summary.outputTokens,
      cost: summary.costUsd,
    }),
  );
  await Bun.sleep(3_000); // the background call settles after `wait` returns
  const rollup = await client.session(sessionId);
  say(
    `usage: message sum ${summary.costUsd}  settled rollup ${rollup.costUsd}  delta ${rollup.costUsd - summary.costUsd}`,
  );
  check(
    "usage: the settled session rollup is not below the message sum",
    rollup.costUsd >= summary.costUsd - 1e-9,
  );
}

// ── 6. cancel through the real job-cancel path ──────────────────────────────────────────────
async function waitIdle(sessionId: string): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!(await client.active()).includes(sessionId)) return true;
    await Bun.sleep(500);
  }
  return false;
}
const LONG = (secs: number) =>
  "Run exactly this ONE shell command and wait for it to finish, then reply DONE:\n" +
  `touch started.txt; sleep ${secs}; touch late.txt`;
{
  // Control: an abandoned session (nobody interrupts it) keeps running and writes late.txt.
  const dir = scratchRepo("cancel-control");
  const sessionId = await createSession({ agent: "implement", dir });
  await client.setEnvironment(sessionId, productionEnv());
  await client.prompt(sessionId, { text: LONG(LATE_SLEEP_S) });
  const deadline = Date.now() + (LATE_SLEEP_S + 60) * 1000;
  while (!existsSync(join(dir, "late.txt")) && Date.now() < deadline) await Bun.sleep(500);
  check(
    "cancel control: an abandoned session still writes late.txt",
    existsSync(join(dir, "late.txt")),
  );
  await client.interrupt(sessionId);
}
{
  const dir = scratchRepo("cancel");
  const jobId = "live-probe-cancel";
  const sessionId = await createSession({ agent: "implement", dir });
  await client.setEnvironment(sessionId, productionEnv());
  const driving = driveOpencodeSession(client, {
    jobId,
    cwd: dir,
    sessionId,
    prompt: LONG(LATE_SLEEP_S),
    logContext: { tool: "live-probe" },
    turnsRef: { current: 0 },
  });
  const deadline = Date.now() + 90_000;
  while (!existsSync(join(dir, "started.txt")) && Date.now() < deadline) await Bun.sleep(250);
  check("cancel: the long shell command started", existsSync(join(dir, "started.txt")));
  const t0 = Date.now();
  check(
    "cancel: terminateSessionsForJob finds the registered session",
    terminateSessionsForJob(jobId),
  );
  const result = await driving;
  say(
    `cancel: drive returned after ${Date.now() - t0}ms stopped=${result.stopped} finished=${result.finished}`,
  );
  check("cancel: the drive loop reports stopped, not finished", result.stopped && !result.finished);
  check("cancel: the session goes idle (interrupted)", await waitIdle(sessionId));
  check(
    "cancel: the idle message says interrupted",
    summarizeOpencodeMessages(await client.allMessages(sessionId)).outcome === "interrupted",
  );
  await Bun.sleep((LATE_SLEEP_S + 5) * 1000);
  check("cancel: late.txt never appears", !existsSync(join(dir, "late.txt")));
  __resetActiveProcsForTests();
}

// ── 7. concurrency ──────────────────────────────────────────────────────────────────────────
{
  const results = await Promise.all(
    [1, 2, 3].map((n) => {
      const dir = scratchRepo(`concurrent-${n}`);
      return run({
        agent: "implement",
        dir,
        prompt: `Use your shell tool to run \`echo c${n} > out${n}.txt\`, then reply DONE.`,
      }).then((r) => ({ ...r, dir, n }));
    }),
  );
  check(
    "3 concurrent sessions: all succeeded, each file landed in its own repo, no lock error",
    results.every(
      (r) =>
        r.summary.outcome === "succeeded" &&
        existsSync(join(r.dir, `out${r.n}.txt`)) &&
        !r.summary.errorMessage,
    ),
    results.map((r) => r.summary.errorMessage ?? r.summary.outcome).join(","),
  );
}

say(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
