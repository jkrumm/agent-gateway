// Live measurement of the OpenCode v2 SERVER mode against the REAL installed binary. Starts a
// DEDICATED `opencode serve` (own port, own XDG roots, own OPENCODE_DB, IU credentials from agw's
// env) so it never touches the shared per-user service. Needs the IU key (IU_API_KEY/IU_BASE_URL
// or the Keychain). Costs a few cents of IU tokens; never run from CI.
//   bun scripts/opencode-v2-probe.ts            # every section
//   bun scripts/opencode-v2-probe.ts durability # only sections with exactly that name
//
// Sections: session · pagination · concurrency · interrupt · steer · events · permissions ·
// permission-order · permission-order-reversed · durability.
// Findings and the design they produced: docs/opencode-v2.md. Exits non-zero on a failed check.
// Re-run after any opencode upgrade — it is the upgrade gate.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getIuConfig } from "../server/lib/iu-openai.ts";
import { DEEPSEEK_V41_FLASH } from "../server/lib/routing.ts";
import { buildOpencodeServerConfig, OPENCODE_PROVIDER_CHAT } from "../server/mcp/opencode-server.ts";

// Wire JSON of an API labelled experimental (0.0.1): deliberately untyped here. Wave 3's typed client
// (zod over the routes in docs/opencode-v2.md) is where these shapes get real types.
// oxlint-disable-next-line typescript-eslint/no-explicit-any
type Json = any;
const BIN = process.env.OPENCODE_BIN ?? Bun.which("opencode") ?? "opencode";
const MODEL = DEEPSEEK_V41_FLASH;
const ONLY = process.argv[2];
const PASSWORD = `probe-${crypto.randomUUID()}`;
const auth = { authorization: `Basic ${btoa(`opencode:${PASSWORD}`)}` };

let failures = 0;
const facts: Record<string, unknown> = {};
// Every line the probe prints or persists goes through `redact`: the spawned server's env holds
// the IU key and a model can be talked into echoing it (the server's own `/api/config` returns it).
function check(name: string, ok: boolean, detail = ""): void {
  console.log(redact(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`));
  if (!ok) failures++;
}
function note(key: string, value: unknown): void {
  const text = redact(JSON.stringify(value) ?? "null");
  facts[key] = JSON.parse(text);
  console.log(`FACT  ${key} = ${text}`);
}

const iu = await getIuConfig();
function redact(s: string): string {
  return iu.key ? s.split(iu.key).join("<iu-key>") : s;
}
if (!iu.key || !iu.openaiBase) {
  console.log(
    "FAIL  IU credentials unresolvable (Keychain claude-sdk-* or IU_API_KEY/IU_BASE_URL)",
  );
  process.exit(1);
}

// ── scratch space ───────────────────────────────────────────────────────────────────────────
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "oc-v2-probe-")));
function sh(cwd: string, ...args: string[]): string {
  return execFileSync(args[0], args.slice(1), { cwd, encoding: "utf8" });
}
const origin = join(scratch, "origin");
mkdirSync(origin);
sh(origin, "git", "init", "-q", "-b", "main");
sh(origin, "git", "config", "user.email", "probe@example.com");
sh(origin, "git", "config", "user.name", "probe");
await Bun.write(join(origin, "README.md"), "probe repo\n");
sh(origin, "git", "add", "-A");
sh(origin, "git", "commit", "-qm", "init");
function worktree(name: string): string {
  const dir = join(scratch, `wt-${name}`);
  sh(origin, "git", "worktree", "add", "-q", "-b", `probe/${name}`, dir);
  return realpathSync(dir);
}

// ── server handle ───────────────────────────────────────────────────────────────────────────
interface Server {
  base: string;
  proc: ReturnType<typeof Bun.spawn>;
  output: () => string;
  api: (method: string, path: string, body?: unknown, signal?: AbortSignal) => Promise<ApiResult>;
  kill: (signal?: NodeJS.Signals) => Promise<void>;
}
interface ApiResult {
  status: number;
  body: Json;
}

let lastBootMs = 0;
/** Every server this run started, so one top-level `finally` reaps them even when a section throws. */
const spawned = new Set<Server>();
async function freePort(): Promise<number> {
  const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = l.port;
  l.stop(true);
  return port;
}

/** `root` holds config/data/state/cache/db, so a second `startServer` with the same root is a
 *  restart against the same durable state (the durability section). */
async function startServer(root: string): Promise<Server> {
  const port = await freePort();
  const config = buildOpencodeServerConfig();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    XDG_CONFIG_HOME: join(root, "cfg"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_DB: join(root, "opencode.db"),
    OPENCODE_SERVER_PASSWORD: PASSWORD,
    IU_KEY: iu.key,
    IU_OPENAI_BASE: iu.openaiBase,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  };
  const proc = Bun.spawn([BIN, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  let err = "";
  void (async () => {
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      err += new TextDecoder().decode(chunk);
    }
  })();
  void (async () => {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      err += new TextDecoder().decode(chunk);
    }
  })();
  const base = `http://127.0.0.1:${port}`;
  const api: Server["api"] = async (method, path, body, signal) => {
    const res = await fetch(base + path, {
      method,
      signal,
      headers: { ...auth, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: Json = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, body: parsed };
  };
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await api("GET", "/api/session/active");
      if (r.status === 200) break;
    } catch {}
    if (Date.now() - t0 > 20_000) {
      proc.kill("SIGKILL");
      throw new Error(`opencode serve did not come up:\n${redact(err)}`);
    }
    await Bun.sleep(150);
  }
  lastBootMs = Date.now() - t0;
  const server: Server = {
    base,
    proc,
    output: () => redact(err),
    api,
    kill: async (signal = "SIGTERM") => {
      proc.kill(signal);
      await proc.exited;
      spawned.delete(server);
    },
  };
  spawned.add(server);
  return server;
}

// ── session helpers ─────────────────────────────────────────────────────────────────────────
const MODEL_REF = { providerID: OPENCODE_PROVIDER_CHAT, id: MODEL };
type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask" };

async function createSession(
  s: Server,
  directory: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const r = await s.api("POST", "/api/session", {
    location: { directory },
    model: MODEL_REF,
    ...extra,
  });
  if (r.status !== 200)
    throw new Error(`create session ${r.status}: ${redact(JSON.stringify(r.body))}`);
  return r.body.data.id as string;
}
async function prompt(
  s: Server,
  id: string,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<ApiResult> {
  return s.api("POST", `/api/session/${id}/prompt`, { text, ...extra });
}
async function wait(s: Server, id: string, timeoutMs = 240_000): Promise<"idle" | "timeout"> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await s.api("POST", `/api/experimental/session/${id}/wait`, undefined, ac.signal);
    return r.status === 204 || r.status === 200 ? "idle" : "timeout";
  } catch {
    return "timeout";
  } finally {
    clearTimeout(timer);
  }
}
async function messages(s: Server, id: string): Promise<Json[]> {
  const r = await s.api("GET", `/api/session/${id}/message`);
  return r.status === 200 ? (r.body.data as Json[]) : [];
}
const assistants = (msgs: Json[]): Json[] => msgs.filter((m) => m.type === "assistant");
const idleOf = (msgs: Json[]): Json | undefined => msgs.find((m) => m.type === "idle");
function textOf(msgs: Json[]): string {
  return assistants(msgs)
    .toReversed()
    .flatMap((m) => m.content ?? [])
    .filter((c: Json) => c.type === "text")
    .map((c: Json) => c.text)
    .join("\n");
}
/** Text of the newest assistant message only (messages are newest-first). */
function finalText(msgs: Json[]): string {
  return (assistants(msgs)[0]?.content ?? [])
    .filter((c: Json) => c.type === "text")
    .map((c: Json) => c.text)
    .join("\n");
}
function toolParts(msgs: Json[]): Json[] {
  return assistants(msgs).flatMap((m) => (m.content ?? []).filter((c: Json) => c.type === "tool"));
}
function sumUsage(msgs: Json[]): {
  input: number;
  output: number;
  cacheRead: number;
  cost: number;
} {
  return assistants(msgs).reduce(
    (a, m) => ({
      input: a.input + (m.tokens?.input ?? 0),
      output: a.output + (m.tokens?.output ?? 0),
      cacheRead: a.cacheRead + (m.tokens?.cache?.read ?? 0),
      cost: a.cost + (m.cost ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0, cost: 0 },
  );
}
/** Poll until `pred` holds over the session's messages, or give up. */
async function until(
  s: Server,
  id: string,
  pred: (msgs: Json[]) => boolean,
  timeoutMs = 90_000,
): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred(await messages(s, id))) return true;
    await Bun.sleep(700);
  }
  return false;
}
const shellRunning = (msgs: Json[]): boolean =>
  toolParts(msgs).some((t) => t.state?.status === "running" || t.state?.status === "streaming");

const SLEEP_TASK = (secs: number, then: string): string =>
  `Use your shell tool to run exactly: sleep ${secs}\nAfter it finishes, ${then}`;

// ── sections ────────────────────────────────────────────────────────────────────────────────
const sections: Array<[string, () => Promise<void>]> = [];
function section(name: string, fn: () => Promise<void>): void {
  sections.push([name, fn]);
}

const root = join(scratch, "main-server");
mkdirSync(root);
let main: Server;

section("session", async () => {
  const dir = worktree("session");
  const t0 = Date.now();
  const id = await createSession(main, dir, {
    metadata: { probe: "session" },
    permissions: [{ action: "edit", resource: "*", effect: "allow" } satisfies Rule],
  });
  check("session created (id shape)", id.startsWith("ses_"), id);
  const got = await main.api("GET", `/api/session/${id}`);
  check(
    "session round-trips model, metadata and permissions",
    got.body.data?.model?.providerID === MODEL_REF.providerID &&
      got.body.data?.metadata?.probe === "session" &&
      got.body.data?.permissions?.length === 1,
  );
  note("session.fields", Object.keys(got.body.data ?? {}));
  check(
    "session location honoured",
    got.body.data?.location?.directory === dir,
    got.body.data?.location?.directory,
  );

  // Auth is the only protection of a server whose /api/config returns the provider key in plaintext.
  const noAuth = await fetch(`${main.base}/api/config`);
  const badAuth = await fetch(`${main.base}/api/config`, {
    headers: { authorization: `Basic ${btoa("opencode:wrong")}` },
  });
  check("no Authorization header -> 401", noAuth.status === 401, `${noAuth.status}`);
  check("wrong password -> 401", badAuth.status === 401, `${badAuth.status}`);
  // Config-defined providers are usable by sessions but invisible to the listing endpoints.
  const provs = await main.api("GET", "/api/provider");
  const models = await main.api("GET", "/api/model");
  check(
    "config-defined iu-chat is not listed by /api/provider or /api/model",
    !JSON.stringify(provs.body).includes(MODEL_REF.providerID) &&
      !JSON.stringify(models.body).includes(MODEL_REF.providerID),
  );

  const p = await prompt(main, id, "Reply with exactly the word PONG and nothing else.");
  check("prompt admitted", p.status === 200, `${p.status}`);
  const state = await wait(main, id);
  check("wait returned idle", state === "idle");
  const msgs = await messages(main, id);
  const idle = idleOf(msgs);
  check("idle message outcome=succeeded", idle?.outcome === "succeeded", idle?.outcome);
  check("final text is PONG", /PONG/.test(textOf(msgs)), textOf(msgs).slice(0, 80));
  const u = sumUsage(msgs);
  check(
    "per-turn tokens + cost present",
    u.input + u.cacheRead > 0 && u.cost > 0,
    JSON.stringify(u),
  );
  note("session.pingWallMs", Date.now() - t0);
  note("session.usage", u);
  note(
    "session.messageOrder",
    msgs.map((m) => m.type),
  ); // newest first?
  const done = await main.api("GET", `/api/session/${id}`);
  note("session.rollupAfterRun", { cost: done.body.data?.cost, tokens: done.body.data?.tokens });

  // The tool-use turn: usage must be exact across several turns, not just the last one.
  const id2 = await createSession(main, dir);
  await prompt(main, id2, "Use your shell tool to run `echo hello-probe`, then reply DONE.");
  await wait(main, id2);
  const m2 = await messages(main, id2);
  check(
    "multi-turn: >=2 assistant messages, each with tokens and cost",
    assistants(m2).length >= 2 &&
      assistants(m2).every(
        (m) =>
          (m.tokens?.input ?? 0) + (m.tokens?.cache?.read ?? 0) > 0 && typeof m.cost === "number",
      ),
    `${assistants(m2).length}`,
  );
  // The session rollup is NOT the sum of the assistant messages: it also carries a background
  // call billed to the session without a message (~600 tokens, lands after `wait` returns —
  // measured 2026-10-14; presumably title generation). Per-turn attribution sums the messages;
  // total spend reads the rollup once settled.
  await Bun.sleep(2_000);
  const rollup = await main.api("GET", `/api/session/${id2}`);
  const sum = sumUsage(m2);
  check(
    "session rollup cost >= sum of per-message cost",
    (rollup.body.data?.cost ?? -1) >= sum.cost - 1e-9,
    `rollup=${rollup.body.data?.cost} sum=${sum.cost}`,
  );
  note("session.rollupMinusMessages", (rollup.body.data?.cost ?? 0) - sum.cost);
  note("session.toolPartShape", toolParts(m2)[0] ?? null);
  note("session.diff", (await main.api("GET", `/api/session/${id2}/diff`)).status);
});

section("pagination", async () => {
  // No LLM: `shell` messages are injected directly. A long episode has hundreds of messages, and
  // the default page is only 50 (newest first), so a runner that reads one page loses usage.
  const dir = worktree("pagination");
  const id = await createSession(main, dir);
  const N = 130;
  for (let i = 0; i < N; i++)
    await main.api("POST", `/api/session/${id}/shell`, { command: `echo ${i}` });
  const first = await main.api("GET", `/api/session/${id}/message`);
  note("pagination.defaultPage", first.body.data.length);
  check(
    "default page is smaller than the session (must paginate)",
    first.body.data.length < N,
    `${first.body.data.length}`,
  );
  const over = await main.api("GET", `/api/session/${id}/message?limit=201`);
  note("pagination.limitCap", { status: over.status, tag: over.body?._tag });
  check("limit above 200 is rejected (cap is 200)", over.status === 400, `${over.status}`);
  let got = 0;
  let page = await main.api("GET", `/api/session/${id}/message?order=asc&limit=50`);
  let pages = 0;
  while (page.status === 200 && page.body.data.length > 0 && pages < 20) {
    got += page.body.data.length;
    pages++;
    if (!page.body.cursor?.next) break;
    page = await main.api(
      "GET",
      `/api/session/${id}/message?cursor=${page.body.cursor.next}&limit=50`,
    );
  }
  check(
    "walking cursor.next (order=asc) returns every message",
    got === N,
    `${got}/${N} in ${pages} pages`,
  );
});

section("concurrency", async () => {
  const N = 5;
  const t0 = Date.now();
  const runs = await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      const dir = worktree(`conc${i}`);
      const id = await createSession(main, dir);
      await prompt(
        main,
        id,
        `Use your shell tool to run: echo worker-${i} > out-${i}.txt\nThen reply DONE.`,
      );
      const state = await wait(main, id);
      return { i, dir, id, state, msgs: await messages(main, id) };
    }),
  );
  const wall = Date.now() - t0;
  note("concurrency.wallMs", wall);
  for (const r of runs) {
    const file = join(r.dir, `out-${r.i}.txt`);
    check(
      `session ${r.i}: idle, file written in its own worktree`,
      r.state === "idle" && existsSync(file),
      r.dir,
    );
    const crossed = runs.some((o) => o.i !== r.i && existsSync(join(o.dir, `out-${r.i}.txt`)));
    check(`session ${r.i}: no cross-worktree leak`, !crossed);
  }
  note(
    "concurrency.totalCost",
    runs.reduce((a, r) => a + sumUsage(r.msgs).cost, 0),
  );
});

section("interrupt", async () => {
  const dir = worktree("interrupt");
  const id = await createSession(main, dir);
  await prompt(main, id, SLEEP_TASK(60, "reply DONE."));
  const running = await until(main, id, shellRunning);
  check("shell tool running before interrupt", running);
  const t0 = Date.now();
  const r = await main.api("POST", `/api/session/${id}/interrupt`);
  note("interrupt.response", { status: r.status, body: r.body });
  const state = await wait(main, id, 30_000);
  const took = Date.now() - t0;
  note("interrupt.toIdleMs", took);
  check(
    "session idle within 30s of interrupt (not 60s sleep)",
    state === "idle" && took < 30_000,
    `${took}ms`,
  );
  const msgs = await messages(main, id);
  note("interrupt.idleMessage", idleOf(msgs) ?? null);
  const active = await main.api("GET", "/api/session/active");
  check("session no longer active", !JSON.stringify(active.body).includes(id));
  // The session is reusable afterwards.
  await prompt(main, id, "Reply with exactly the word AGAIN.");
  await wait(main, id, 60_000);
  check("session accepts a prompt after interrupt", /AGAIN/.test(textOf(await messages(main, id))));
  const idle = await main.api("POST", `/api/session/${id}/interrupt`);
  note("interrupt.onIdle", idle.body);
  check("interrupt on an idle session is a no-op", idle.body?.interrupted === false);
});

section("steer", async () => {
  const dir = worktree("steer");
  const id = await createSession(main, dir);
  await prompt(main, id, SLEEP_TASK(25, "reply with exactly the word ALPHA."));
  check("shell tool running before steer", await until(main, id, shellRunning));
  const s = await prompt(
    main,
    id,
    "Change of plan: after the sleep, reply with exactly the word BRAVO instead of ALPHA.",
    {
      delivery: "steer",
    },
  );
  note("steer.admit", { status: s.status, delivery: s.body?.data?.delivery });
  await wait(main, id, 180_000);
  const text = finalText(await messages(main, id));
  note("steer.finalText", text.slice(0, 200));
  check(
    "steer changed the running episode's outcome (final answer BRAVO, not ALPHA)",
    /^\W*BRAVO\W*$/.test(text),
    text.slice(0, 80),
  );

  const dirQ = worktree("queue");
  const idQ = await createSession(main, dirQ);
  await prompt(main, idQ, SLEEP_TASK(20, "reply with exactly the word ALPHA."));
  await until(main, idQ, shellRunning);
  await prompt(main, idQ, "After that, reply with exactly the word BRAVO.", { delivery: "queue" });
  await wait(main, idQ, 180_000);
  const mq = await messages(main, idQ);
  note("queue.finalText", textOf(mq).slice(0, 200));
  note("queue.assistantCount", assistants(mq).length);
});

section("events", async () => {
  const dir = worktree("events");
  const id = await createSession(main, dir);
  const seen = new Map<string, Json>();
  const order: string[] = [];
  const ac = new AbortController();
  const res = await fetch(`${main.base}/api/event`, {
    headers: { ...auth, accept: "text/event-stream" },
    signal: ac.signal,
  });
  note("events.contentType", res.headers.get("content-type"));
  if (!res.ok || !res.body) {
    check("SSE endpoint opens", false, `${res.status}`);
    return;
  }
  const reader = res.body.getReader();
  let buf = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += new TextDecoder().decode(value);
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = raw
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("");
          if (!data) continue;
          try {
            const ev = JSON.parse(data);
            const type = String(ev.type ?? ev.event ?? "?");
            order.push(type);
            if (!seen.has(type)) seen.set(type, ev);
          } catch {}
        }
      }
    } catch {}
  })();
  await Bun.sleep(300);
  await prompt(main, id, "Use your shell tool to run `echo ev`, then reply DONE.");
  await wait(main, id, 120_000);
  await Bun.sleep(500);
  ac.abort();
  await pump;
  note("events.types", [...seen.keys()]);
  note(
    "events.samples",
    Object.fromEntries([...seen].map(([k, v]) => [k, redact(JSON.stringify(v)).slice(0, 300)])),
  );
  check("SSE delivered events for the run", order.length > 0, `${order.length} events`);
});

section("permissions", async () => {
  const deny = worktree("perm-deny");
  const idD = await createSession(main, deny, {
    permissions: [
      { action: "shell", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
    ] satisfies Rule[],
  });
  // `edit` deny also removes the `write` tool, and code mode's `execute` proxies through the same
  // gates (measured 2026-10-14): shell+edit denied means no tool in the box can write the file.
  await prompt(
    main,
    idD,
    "Create forbidden.txt containing X with any tool or any means you have, then reply REPORTED and say whether it worked.",
  );
  const stateD = await wait(main, idD, 120_000);
  const mD = await messages(main, idD);
  check("deny shell+edit: session still reaches idle (does not hang)", stateD === "idle");
  check(
    "deny shell+edit: write refused (file not created)",
    !existsSync(join(deny, "forbidden.txt")),
  );
  note(
    "permissions.denyToolStates",
    toolParts(mD).map((t) => `${t.name}:${t.state?.status}`),
  );
  note(
    "permissions.denyErrorSample",
    redact(
      JSON.stringify(toolParts(mD).find((t) => t.state?.status === "error")?.state ?? null),
    ).slice(0, 300),
  );
  note("permissions.denyIdle", idleOf(mD)?.outcome);
  note(
    "permissions.denyStateSample",
    redact(JSON.stringify(toolParts(mD)[0]?.state ?? null)).slice(0, 400),
  );

  // `edit: deny` alone does not gate a shell redirection — the read-only profile must deny shell
  // writes itself (opencode-server.ts's READ_ONLY_SHELL_RULES), exactly as on the CLI path.
  const editOnly = worktree("perm-edit-only");
  const idE = await createSession(main, editOnly, {
    permissions: [{ action: "edit", resource: "*", effect: "deny" } satisfies Rule],
  });
  await prompt(
    main,
    idE,
    "Create a file named viashell.txt containing X. Use whatever tool works, then reply DONE.",
  );
  await wait(main, idE, 120_000);
  check(
    "edit:deny alone does NOT stop a shell redirect (profile must deny shell too)",
    existsSync(join(editOnly, "viashell.txt")),
  );

  // `ask`: what does a headless run do when nobody answers?
  const ask = worktree("perm-ask");
  const idA = await createSession(main, ask, {
    permissions: [{ action: "edit", resource: "*", effect: "ask" } satisfies Rule],
  });
  await prompt(main, idA, "Create a file named asked.txt containing X, then reply DONE.");
  const pendingSeen = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000) {
      const r = await main.api("GET", `/api/session/${idA}/permission`);
      const list = Array.isArray(r.body?.data) ? r.body.data : [];
      if (list.length > 0) return list;
      await Bun.sleep(700);
    }
    return [];
  })();
  note("permissions.askPending", redact(JSON.stringify(pendingSeen)).slice(0, 400));
  check(
    "ask: a pending permission request surfaces (session blocks, does not auto-reject)",
    pendingSeen.length > 0,
  );
  const stillRunning = await wait(main, idA, 4_000);
  check("ask: wait does not return while the request is pending", stillRunning === "timeout");
  if (pendingSeen[0]) {
    const reply = await main.api(
      "POST",
      `/api/session/${idA}/permission/${pendingSeen[0].id}/reply`,
      { decision: "once" },
    );
    note("permissions.askReply", { status: reply.status, body: reply.body });
    await wait(main, idA, 120_000);
    check("ask: replying once lets the edit through", existsSync(join(ask, "asked.txt")));
  } else {
    await main.api("POST", `/api/session/${idA}/interrupt`);
  }
});

/** Stop the server mid-tool with `signal`, restart it on the same durable state, and record what
 *  the session is left as and whether `prompt {resume:true}` finishes the work. */
async function durabilityRound(signal: NodeJS.Signals): Promise<void> {
  const tag = `durability.${signal}`;
  const dRoot = join(scratch, `durable-${signal}`);
  mkdirSync(dRoot);
  const a = await startServer(dRoot);
  const dir = worktree(`durable-${signal}`);
  const id = await createSession(a, dir);
  await prompt(
    a,
    id,
    SLEEP_TASK(
      25,
      "write the file after.txt containing 'finished' in the current directory using your shell tool, then reply DONE.",
    ),
  );
  check(`${signal}: shell tool running before the stop`, await until(a, id, shellRunning));
  const t0 = Date.now();
  await a.kill(signal);
  note(`${tag}.exitMs`, Date.now() - t0);

  const b = await startServer(dRoot);
  const got = await b.api("GET", `/api/session/${id}`);
  check(`${signal}: session survives the restart`, got.status === 200, `${got.status}`);
  const msgsB = await messages(b, id);
  note(
    `${tag}.messageTypesAfterRestart`,
    msgsB.map((m) => m.type),
  );
  note(
    `${tag}.toolStatesAfterRestart`,
    toolParts(msgsB).map((t) => t.state?.status),
  );
  note(`${tag}.idleAfterRestart`, idleOf(msgsB) ?? null);
  note(`${tag}.activeAfterRestart`, (await b.api("GET", "/api/session/active")).body);

  // Does the new server pick the session back up by itself?
  await Bun.sleep(8_000);
  const autoResumed = JSON.stringify((await b.api("GET", "/api/session/active")).body).includes(id);
  note(`${tag}.autoResumes`, autoResumed);

  // Explicit re-attach: a `resume:true` prompt continues what the dead process left behind.
  if (!autoResumed) {
    const r = await prompt(b, id, "Continue where you left off and finish the task.", {
      resume: true,
    });
    check(`${signal}: resume prompt admitted`, r.status === 200, `${r.status}`);
  }
  const state = await wait(b, id, 180_000);
  const final = await messages(b, id);
  check(`${signal}: resumed session reaches idle`, state === "idle");
  check(
    `${signal}: resumed session finished the work (after.txt written)`,
    existsSync(join(dir, "after.txt")),
  );
  note(`${tag}.finalIdle`, idleOf(final)?.outcome ?? null);
  await b.kill();
}
section("permission-order", async () => {
  // The read-only profile is a shell allowlist. Session rules are LAST-MATCH-WINS (measured
  // 2026-10-14): a catch-all deny FIRST, specific allows after it. Reversed, the deny wins.
  const dir = worktree("perm-order");
  const id = await createSession(main, dir, {
    permissions: [
      { action: "shell", resource: "*", effect: "deny" },
      { action: "shell", resource: "git status*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
    ] satisfies Rule[],
  });
  await prompt(
    main,
    id,
    "Using your shell tool, run these two commands as two separate calls and report each outcome: (1) `git status --short` (2) `echo X > f.txt`. Do not use any other tool to write files.",
  );
  await wait(main, id, 120_000);
  const tools = toolParts(await messages(main, id)).map(
    (t) => `${t.state?.input?.command}=>${t.state?.status}`,
  );
  note("permission-order.tools", tools);
  check(
    "allowlisted `git status` ran",
    tools.some((t) => t.startsWith("git status") && t.endsWith("completed")),
    tools.join(" | "),
  );
  check("non-allowlisted redirect did not write", !existsSync(join(dir, "f.txt")));
  check(
    "non-allowlisted command surfaces as a tool error",
    tools.some((t) => t.startsWith("echo") && t.endsWith("error")),
    tools.join(" | "),
  );
});

section("permission-order-reversed", async () => {
  // Reversed, the catch-all deny comes last and wins: the allow-listed command is refused too.
  const dir = worktree("perm-order-rev");
  const id = await createSession(main, dir, {
    permissions: [
      { action: "shell", resource: "git status*", effect: "allow" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
    ] satisfies Rule[],
  });
  await prompt(main, id, "Using your shell tool, run `git status --short` and report the outcome.");
  await wait(main, id, 120_000);
  const ran = toolParts(await messages(main, id)).filter(
    (t) =>
      String(t.state?.input?.command).startsWith("git status") && t.state?.status === "completed",
  );
  check("reversed order: catch-all deny wins, `git status` never ran", ran.length === 0);
});

section("durability", async () => {
  await durabilityRound("SIGKILL");
  await durabilityRound("SIGTERM");
});

// ── run ─────────────────────────────────────────────────────────────────────────────────────
const version = (await Bun.$`${BIN} --version`.text()).trim();
console.log(`binary: ${BIN}  version: ${version}  model: ${MODEL}`);
check("binary is opencode 2.x", /^(opencode )?v?2\.\d+\.\d+/.test(version), version);
note("version", version);

try {
  main = await startServer(root);
  note("serve.bootMs", lastBootMs);
  for (const [name, fn] of sections) {
    if (ONLY && name !== ONLY) continue;
    console.log(`\n── ${name} ──`);
    const t0 = Date.now();
    try {
      await fn();
    } catch (err) {
      check(
        `${name} section completed`,
        false,
        redact(String(err instanceof Error ? err.message : err)),
      );
    }
    console.log(`(${name}: ${Date.now() - t0}ms)`);
  }
  check(
    "no server-side 'database is locked' in main server log",
    !/database is locked/i.test(main.output()),
  );
} finally {
  for (const server of spawned) await server.kill("SIGKILL").catch(() => {});
  if (!process.env.OC_PROBE_KEEP) rmSync(scratch, { recursive: true, force: true });
  else console.log(`scratch kept: ${scratch}`);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
if (process.env.OC_PROBE_FACTS)
  await Bun.write(process.env.OC_PROBE_FACTS, JSON.stringify(facts, null, 2));
process.exit(failures === 0 ? 0 : 1);
