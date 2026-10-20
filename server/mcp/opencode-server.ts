// ── The shared OpenCode v2 server — the one long-lived `opencode serve` agw's episodes attach to ──
//
// Episodes used to spawn a private `opencode run --standalone` each. Wave 2 (docs/opencode-v2.md)
// moved them onto ONE server under its own LaunchAgent (`com.jkrumm.agent-gateway-opencode`,
// scripts/agent-gateway-opencode-start.sh) that outlives an agw `make reload`; Wave 3 drives an
// episode as a session over HTTP (opencode-client.ts / opencode-runner.ts). This module is the
// single owner of everything about that server that is not a session: where it lives, how a client
// authenticates, the config it boots with, the env it carries, and whether it is up.
//
// What a session can vary against the shared server (measured on 2.0.25):
//   - the working directory (`location.directory` on session create);
//   - the shell tool's environment: a sanitized base plus whatever `PUT /api/session/{id}/environment`
//     sets — per-job env (git credential deny, research-gateway) is delivered per session, and
//     the credentials the server needs (`OPENCODE_SESSION_BLANKED_ENV`) are blanked there too;
//   - the permission profile: two AGENTS defined in the server config (`agent: agw-readonly|
//     agw-implement` on session create).
//
// Permission model (v2, https://opencode.ai/v2/docs/permissions): an ORDERED array of
// `{action, resource, effect}`, LAST matching rule wins, effects allow|deny|ask. An unmatched
// action defaults to `ask`, which blocks an unattended session forever — so the read-only agent
// opens with a catch-all deny and the writable one with a catch-all allow, and neither ever
// emits `ask`. Agent rules are appended AFTER the built-in base policy (which allows everything
// but asks for `external_directory` and `.env` reads), so that first catch-all also cancels
// those asks. v2 action names differ from v1: `shell` (was `bash`), `subagent` (was `task`),
// `permissions` (was `permission`); `list`, `lsp`, `todowrite` and `doom_loop` are not v2 actions.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { listModels, type ModelEntry, type ModelWire } from "../lib/models.ts";

// ── Constants ───────────────────────────────────────────────────────────────────

/** The only opencode build agw drives. The wrapper runs the npm install under `~/.local/share/agent-gateway/opencode-bin/<version>`; it refuses to start
 *  a different binary and `getOpencodeServerStatus` marks a different running version not-ok
 *  (docs/opencode-v2.md § Version pin and upgrade gate). */
export const OPENCODE_PINNED_VERSION = "2.0.32";

/** Fixed loopback port. Override: `AGENT_GATEWAY_OPENCODE_PORT` (read per call). */
export const DEFAULT_OPENCODE_PORT = 49375;

/** Hang guard for the status probe — a plain local HTTP call, not an agent run. The two requests
 *  run in parallel, so `GET /api/jobs/health` (whose callers curl it with `--max-time 3` and fail
 *  open) answers within roughly this budget even when the server hangs. */
const STATUS_TIMEOUT_MS = 1_500;

/** opencode provider ids the server config emits — one per IU OpenAI-route wire. */
export const OPENCODE_PROVIDER_CHAT = "iu-chat";
export const OPENCODE_PROVIDER_RESPONSES = "iu-responses";
/** The IU native `/anthropic` leg through `@ai-sdk/anthropic`, so OpenCode injects `cache_control`. */
export const OPENCODE_PROVIDER_ANTHROPIC = "iu-anthropic";

/** The permission profiles an episode can select with `agent` on session create. */
export const OPENCODE_AGENT_READONLY = "agw-readonly";
export const OPENCODE_AGENT_IMPLEMENT = "agw-implement";
export const OPENCODE_AGENT_CHECK = "agw-check";
export const OPENCODE_AGENT_TOOLLESS = "agw-toolless";

// ── Permission rules ────────────────────────────────────────────────────────────

export interface OpencodePermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny";
}

const shell = (resource: string, effect: "allow" | "deny"): OpencodePermissionRule => ({
  action: "shell",
  resource,
  effect,
});

/** Trailing `shell` denies (they must come AFTER every allow — last match wins) for any command
 *  text that names the server's own credentials or API: `curl` is allowlisted and the permission
 *  pattern matches the command TEXT, so `curl -u opencode:$OPENCODE_SERVER_PASSWORD
 *  http://127.0.0.1:<port>/api/session …` would otherwise expand the password in the shell and let
 *  a read-only worker create a permissive session on this very server, or echo `$IU_KEY`.
 *
 *  This is a COST-RAISING deny list on command text, NOT a security boundary: an obfuscated
 *  expansion (a built-up name, a different spelling of the port) can evade it. Wave 3 closed the env
 *  route (the worker shell does not inherit the server's credentials, and each session blanks them
 *  anyway — `OPENCODE_SESSION_BLANKED_ENV`), so this list is defense in depth against a worker that
 *  reads the password FILE or guesses the port (docs/opencode-v2.md § Measured in Wave 3). */
function serverSelfAccessDenyRules(): OpencodePermissionRule[] {
  // The default port bare (any spelling), a configured one as `:<port>` (a short override must
  // not turn into a glob that matches half of all commands).
  const ports = [`*${DEFAULT_OPENCODE_PORT}*`];
  if (opencodeServerPort() !== DEFAULT_OPENCODE_PORT) ports.push(`*:${opencodeServerPort()}*`);
  return [
    "*OPENCODE_SERVER_PASSWORD*",
    "*IU_KEY*",
    "*IU_OPENAI_BASE*",
    "*IU_ANTHROPIC_BASE*",
    ...ports,
    "*/api/session*",
  ].map((resource) => shell(resource, "deny"));
}

/** The read-only shell allowlist, as ORDERED v2 `shell` rules (last match wins). The leading
 *  `*` denies everything; the read commands below are allowed by name; every re-deny sits AFTER
 *  the allows, because a `cat *` allow would otherwise permit `cat x > file` (the scanner folds
 *  a redirect into the matched command text). A pattern ending in ` *` also matches the bare
 *  command, so `"git log *"` covers both `git log` and `git log --oneline`; `*` is any run of
 *  characters and `?` exactly one (none is used here).
 *
 *  Several allowed readers take write/exec flags that would otherwise bypass the profile, so
 *  their dangerous flag forms are re-denied after the allows: `curl`'s `-o`/`-O`/`--output`/
 *  `--remote-name`/`-T`/`--upload-file`/`-K`/`--config`, `rg`'s `--pre`/`--pre=`, and any
 *  `git ... --output`. The deny globs are deliberately flag-position forms (attached or
 *  space-delimited) rather than a bare `curl *-o*` — the latter would match an `-o` anywhere,
 *  including in a URL, header or JSON body. `find` is not allowed at all: workers have
 *  `rg`/`git ls-files`/the glob tool, and `find -exec`/`-delete` are another exec/write
 *  surface. Writes named in the gap — `rm`/`mv`/`cp`/`tee`/`sed -i`/`git commit`/`push`/
 *  `checkout`/`reset`/`apply` — need no explicit rule: none matches an allow pattern, so the
 *  leading `*` denies them. (`edit: deny` alone does NOT stop a shell redirect — measured on
 *  2.0.25 — which is why shell is allow-listed rather than left open.)
 *
 *  Residual: `curl` POSTing a body is still allowed on purpose (the research-gateway recipe
 *  submits a job that way), so a read-only worker can still make outbound network writes with
 *  it — only the file-writing/uploading/config-reading flags are removed. */
export const READ_ONLY_SHELL_RULES: readonly OpencodePermissionRule[] = [
  shell("*", "deny"),
  shell("git log *", "allow"),
  shell("git diff *", "allow"),
  shell("git show *", "allow"),
  shell("git status *", "allow"),
  shell("git grep *", "allow"),
  shell("git ls-files *", "allow"),
  shell("git rev-parse *", "allow"),
  shell("rg *", "allow"),
  shell("cat *", "allow"),
  shell("ls *", "allow"),
  shell("head *", "allow"),
  shell("tail *", "allow"),
  shell("wc *", "allow"),
  shell("jq *", "allow"),
  shell("curl *", "allow"),
  // curl: output / upload / config flags — attached, space-delimited and trailing forms.
  shell("curl -o*", "deny"),
  shell("curl * -o *", "deny"),
  shell("curl * -o", "deny"),
  shell("curl -O*", "deny"),
  shell("curl * -O *", "deny"),
  shell("curl * -O", "deny"),
  shell("curl --output*", "deny"),
  shell("curl * --output*", "deny"),
  shell("curl --remote-name*", "deny"),
  shell("curl * --remote-name*", "deny"),
  shell("curl -T*", "deny"),
  shell("curl * -T *", "deny"),
  shell("curl * -T", "deny"),
  shell("curl --upload-file*", "deny"),
  shell("curl * --upload-file*", "deny"),
  shell("curl -K*", "deny"),
  shell("curl * -K *", "deny"),
  shell("curl * -K", "deny"),
  shell("curl --config*", "deny"),
  shell("curl * --config*", "deny"),
  // rg --pre runs an arbitrary command per file.
  shell("rg *--pre *", "deny"),
  shell("rg *--pre=*", "deny"),
  // git diff/log/show --output=<file> writes to a file.
  shell("git * --output*", "deny"),
  shell("*>*", "deny"),
  ...serverSelfAccessDenyRules(),
];

/** `agw-readonly`: investigate / author / check / review workers. Catch-all deny first, so
 *  anything not named below (including Code Mode's `execute`, MCP tools and every future
 *  action) is refused rather than defaulting to `ask`. `webfetch`/`websearch` stay denied —
 *  workers shell out via `curl` (AGENTS.md Worker routing). `subagent` is denied because a
 *  subagent runs under ITS OWN permissions (the built-in `general` allows shell and edit), so
 *  allowing it would be a read-only escape hatch — v1's `task: allow` had no such hole. */
export const OPENCODE_READONLY_PERMISSIONS: readonly OpencodePermissionRule[] = [
  { action: "*", resource: "*", effect: "deny" },
  ...READ_ONLY_SHELL_RULES,
  { action: "edit", resource: "*", effect: "deny" },
  { action: "webfetch", resource: "*", effect: "deny" },
  { action: "websearch", resource: "*", effect: "deny" },
  { action: "question", resource: "*", effect: "deny" },
  { action: "external_directory", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "skill", resource: "*", effect: "allow" },
];

/** `agw-toolless`: the worker answers from the prompt alone — every action denied, so a model that
 *  tries a tool gets a refusal instead of a blocked `ask`. overview / narrative: the prompt already
 *  carries everything the worker may reason over, and a repo read would be ungated by their caps. */
export const OPENCODE_TOOLLESS_PERMISSIONS: readonly OpencodePermissionRule[] = [
  { action: "*", resource: "*", effect: "deny" },
];

/** Build/test runners `agw-check` may execute on top of the read-only allowlist. Edits stay denied
 *  at the tool level, but this is NOT a write boundary: `bun -e`, `uv run python -c` or a test suite
 *  can write anywhere the worker's user can — exactly as under the claude harness, where Bash is
 *  open (the same trust: the repo is the owner's, the commands are the caller's). The profile
 *  bounds WHICH programs the model may start; bare interpreters/shells (`sh`, `bash`, `python3`,
 *  `node`) are deliberately absent. */
const CHECK_RUNNER_PREFIXES = [
  "make",
  "bun",
  "bunx",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "uv",
  "uvx",
  "pytest",
  "ruff",
  "pyrefly",
  "tsc",
  "oxlint",
  "oxfmt",
  "fallow",
  "cargo",
  "go",
  "gofmt",
  "mypy",
  "ty",
  "vitest",
  "jest",
  "eslint",
  "prettier",
  "biome",
  "deno",
] as const;

/** Read-only probes the check skill's discovery path runs (`server/skills/check.md`: Makefile
 *  targets, `which fallow`, `git remote -v`). */
const CHECK_DISCOVERY_PREFIXES = ["grep", "which", "command -v", "git remote"] as const;

/** `agw-check`: the check worker. The read-only profile plus the runners above. Redirect and
 *  pipe forms the runners are normally invoked with (`2>&1`, `| tail`) must pass, so the runner
 *  allows come after the read-only `*>*` deny and the server-self-access denies are re-applied
 *  last (last match wins). */
export const OPENCODE_CHECK_PERMISSIONS: readonly OpencodePermissionRule[] = [
  ...OPENCODE_READONLY_PERMISSIONS,
  ...[...CHECK_DISCOVERY_PREFIXES, ...CHECK_RUNNER_PREFIXES].map((cmd) =>
    shell(`${cmd} *`, "allow"),
  ),
  // The repo's own toolchain by path (a venv's python/pytest, a local node_modules binary).
  ...[".venv/bin", "./.venv/bin", "node_modules/.bin", "./node_modules/.bin"].map((dir) =>
    shell(`${dir}/*`, "allow"),
  ),
  ...serverSelfAccessDenyRules(),
];

/** `agw-implement`: dispatch implement. Everything allowed (the leading catch-all also cancels
 *  the base policy's `.env` read ask), `question` and `external_directory` denied — both would
 *  otherwise `ask` and block an unattended session. */
export const OPENCODE_IMPLEMENT_PERMISSIONS: readonly OpencodePermissionRule[] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "question", resource: "*", effect: "deny" },
  { action: "external_directory", resource: "*", effect: "deny" },
];

// ── Paths, port, password ───────────────────────────────────────────────────────

/** `~/.local/share/agent-gateway/opencode/` — never `/tmp` (same sweep reason as the logs).
 *  Override: `AGENT_GATEWAY_OPENCODE_STATE_DIR` (read per call; tests). */
export function opencodeStateRoot(): string {
  return (
    process.env.AGENT_GATEWAY_OPENCODE_STATE_DIR ??
    join(homedir(), ".local", "share", "agent-gateway", "opencode")
  );
}

export function opencodeServerPort(): number {
  const raw = Number(process.env.AGENT_GATEWAY_OPENCODE_PORT);
  return Number.isInteger(raw) && raw > 0 && raw < 65_536 ? raw : DEFAULT_OPENCODE_PORT;
}

export function opencodeServerUrl(): string {
  return `http://127.0.0.1:${opencodeServerPort()}`;
}

function passwordFile(): string {
  return join(opencodeStateRoot(), "password");
}

/** The server's HTTP Basic password. Throws when the file is missing or empty — the server was
 *  never installed (`make install-opencode-agent` creates it via the env script). */
export function readServerPassword(): string {
  const file = passwordFile();
  if (!existsSync(file)) throw new Error(`opencode server password file missing (${file})`);
  const value = readFileSync(file, "utf8").trim();
  if (!value) throw new Error(`opencode server password file is empty (${file})`);
  return value;
}

/** Create the state tree and a random `0600` password file if absent; returns the password.
 *  `cfg/` is deliberately left EMPTY — it is the server's `XDG_CONFIG_HOME`, and an empty global
 *  config root is what keeps the operator's global MCP servers out of every worker. */
export function ensureServerState(): { password: string } {
  const root = opencodeStateRoot();
  for (const dir of ["cfg", "data", "state", "cache"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  const file = passwordFile();
  if (!existsSync(file)) {
    try {
      writeFileSync(file, `${randomBytes(24).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
    } catch (err) {
      // A concurrent first start created it between the check and the write.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  chmodSync(file, 0o600);
  return { password: readServerPassword() };
}

// ── Config ──────────────────────────────────────────────────────────────────────

/** Registry models the server must list: `verified` and drivable by the opencode harness. */
function opencodeServerModels(): ModelEntry[] {
  return listModels().filter((m) => m.verified !== null && m.harnesses.includes("opencode"));
}

/** `iu-chat`, `iu-responses` or `iu-anthropic` — the only place a registry `wire` is mapped to a provider id. */
export function opencodeProviderForWire(wire: ModelWire): string {
  if (wire === "responses") return OPENCODE_PROVIDER_RESPONSES;
  return wire === "anthropic" ? OPENCODE_PROVIDER_ANTHROPIC : OPENCODE_PROVIDER_CHAT;
}

/** One v2 model entry (`providers.<id>.models.<id>`), generated from the registry. Shared with
 *  scripts/sync-opencode-config.ts so the interactive config and the server's cannot drift. */
export function opencodeV2ModelRow(entry: ModelEntry) {
  return {
    // Without `supportsThinkingBlockBinding: false` OpenCode sends `thinking.block_binding` plus
    // the `thinking-binding-controls` beta, which IU's gateway answers with a 503
    // `not_found_error` for `claude-haiku-5-5-eu` (it falls through to an upstream that has no
    // `-eu` id). Measured 2026-10-14; `thinking` is then omitted from the request (Haiku 5.5
    // default). Only the v2 `providers` form carries `compatibility`.
    ...(entry.wire === "anthropic"
      ? { compatibility: { supportsThinkingBlockBinding: false } }
      : {}),
    name: entry.name,
    limit: { context: entry.limit.context, output: entry.limit.output },
    cost: {
      input: entry.rate.in,
      output: entry.rate.out,
      ...(entry.rate.cacheRead !== undefined
        ? {
            cache: {
              read: entry.rate.cacheRead,
              ...(entry.rate.cacheWrite !== undefined ? { write: entry.rate.cacheWrite } : {}),
            },
          }
        : {}),
    },
    // A model that exposes effort levels runs at "high" by default; `#<variant>` on the model
    // ref (the runner's session create `variant`) picks another.
    ...(entry.effort.length > 0
      ? {
          settings: { reasoningEffort: "high" },
          variants: entry.effort.map((e) => ({ id: e, settings: { reasoningEffort: e } })),
        }
      : {}),
  };
}

/** The config the server boots with (`OPENCODE_CONFIG_CONTENT` — it overrides a repo-local
 *  `opencode.json`, which a file-path config does not). Generated from the model registry, so a
 *  new verified model needs only a server restart. v2-native throughout (`providers`, `agents`
 *  with `permissions`) — the v1 `provider` form drops `compatibility` and is gone. The key/base
 *  are `{env:…}` placeholders resolved from the server's own env (`opencodeServerEnv`) — never
 *  a literal here. */
export function buildOpencodeServerConfig(): Record<string, unknown> {
  const models = opencodeServerModels();
  const provider = (pkg: string, name: string, baseEnv: string, wire: ModelWire) => ({
    package: `aisdk:${pkg}`,
    name,
    settings: { baseURL: `{env:${baseEnv}}`, apiKey: "{env:IU_KEY}" },
    models: Object.fromEntries(
      models.filter((m) => m.wire === wire).map((m) => [m.id, opencodeV2ModelRow(m)]),
    ),
  });
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    providers: {
      [OPENCODE_PROVIDER_CHAT]: provider(
        "@ai-sdk/openai-compatible",
        "IU unified endpoint (OpenAI route, Chat Completions)",
        "IU_OPENAI_BASE",
        "chat",
      ),
      [OPENCODE_PROVIDER_RESPONSES]: provider(
        "@ai-sdk/openai",
        "IU unified endpoint (OpenAI route, Responses)",
        "IU_OPENAI_BASE",
        "responses",
      ),
      [OPENCODE_PROVIDER_ANTHROPIC]: provider(
        "@ai-sdk/anthropic",
        "IU unified endpoint (native Anthropic route)",
        "IU_ANTHROPIC_BASE",
        "anthropic",
      ),
    },
    agents: {
      [OPENCODE_AGENT_READONLY]: {
        description: "agent-gateway read-only worker (allow-listed shell, no edits)",
        mode: "primary",
        permissions: OPENCODE_READONLY_PERMISSIONS,
      },
      [OPENCODE_AGENT_TOOLLESS]: {
        description: "agent-gateway tool-less worker (answers from the prompt, every tool denied)",
        mode: "primary",
        permissions: OPENCODE_TOOLLESS_PERMISSIONS,
      },
      [OPENCODE_AGENT_CHECK]: {
        description: "agent-gateway check worker (read-only plus build/test runners, no edits)",
        mode: "primary",
        permissions: OPENCODE_CHECK_PERMISSIONS,
      },
      [OPENCODE_AGENT_IMPLEMENT]: {
        description: "agent-gateway implement worker (full tools, no questions)",
        mode: "primary",
        permissions: OPENCODE_IMPLEMENT_PERMISSIONS,
      },
    },
  };
}

// ── The env the server carries ──────────────────────────────────────────────────

/** Server-process variables a worker shell must NOT see. Measured on 2.0.25 the shell tool starts
 *  from a sanitized env (HOME, LOGNAME, PATH, PWD, TERM, OPENCODE_* markers) and the server's own
 *  env never reaches it, so this is defense in depth: the runner still blanks each of these per
 *  session (`PUT /api/session/{id}/environment`; a blank value overrides an inherited one), so a
 *  build that starts inheriting the server env cannot leak the credentials. The server itself
 *  still reads them (provider auth, its own Basic password). */
export const OPENCODE_SESSION_BLANKED_ENV = [
  "OPENCODE_SERVER_PASSWORD",
  "IU_KEY",
  "IU_OPENAI_BASE",
  "IU_ANTHROPIC_BASE",
] as const;

/** The server process's complete env, beyond the `PATH`/`HOME`/`TMPDIR`/`LANG` the wrapper adds.
 *  Nothing else from agw's environment (CLAUDE_*, GITHUB_TOKEN, …) reaches a worker shell.
 *  Everything under the state root, so a re-pointed `XDG_*` can never find another data dir. */
export function opencodeServerEnv(input: {
  iuKey: string;
  iuOpenaiBase: string;
  /** The IU Anthropic leg's API root (`…/anthropic/v1`) — `@ai-sdk/anthropic` appends `/messages`. */
  iuAnthropicBase: string;
  password: string;
}): Record<string, string> {
  const root = opencodeStateRoot();
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(buildOpencodeServerConfig()),
    IU_KEY: input.iuKey,
    IU_OPENAI_BASE: input.iuOpenaiBase,
    IU_ANTHROPIC_BASE: input.iuAnthropicBase,
    XDG_CONFIG_HOME: join(root, "cfg"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_DB: join(root, "opencode.db"),
    OPENCODE_SERVER_PASSWORD: input.password,
  };
}

// ── Status ──────────────────────────────────────────────────────────────────────

export interface OpencodeServerStatus {
  /** `up && versionOk` — the server may take episodes. */
  ok: boolean;
  /** The server answered HTTP at all. */
  up: boolean;
  version: string | null;
  pinned: string;
  versionOk: boolean;
  error?: string;
}

const InfoSchema = z.object({ version: z.string().min(1) });

/** `"opencode v2.0.25"` / `"v2.0.25"` / `"2.0.25"` → `"2.0.25"`. */
export function normalizeOpencodeVersion(raw: string): string {
  return (raw.trim().split(/\s+/).at(-1) ?? "").replace(/^v/, "");
}

/** The installed binary's version — the fallback when `/api/info` carries none. */
async function binaryVersion(): Promise<string | null> {
  const bin = process.env.OPENCODE_BIN ?? Bun.which("opencode") ?? "opencode";
  try {
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return normalizeOpencodeVersion(out) || null;
  } catch {
    return null;
  }
}

/** Connection-class reason text for a rejected `fetch` — carries `ECONNREFUSED`/`ETIMEDOUT`/
 *  `fetch failed` so the runner's retry ladder and the circuit breaker classify it as transport. */
export function unreachableReason(err: unknown): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return "ETIMEDOUT (no answer within the request budget)";
  }
  // fetch rejects with `TypeError: fetch failed`; the errno lives on `cause`.
  const code = (err as { cause?: { code?: string } }).cause?.code;
  return code === "ECONNREFUSED" ? code : "fetch failed (connect error)";
}

/** HTTP Basic header for the shared server: the username must be `opencode` (any other gets 401,
 *  measured 2.0.25), the password is the `0600` file's content. */
export function basicAuthHeader(password: string): string {
  return `Basic ${btoa(`opencode:${password}`)}`;
}

/** Fresh requests every call (a cached "up" is exactly what a crash would outlive). Never throws
 *  and never logs a response body. The `error` of a connect-level problem carries
 *  `ECONNREFUSED`/`ETIMEDOUT`/`fetch failed` so the runner's retry ladder and circuit breaker
 *  classify it as transport.
 *
 *  Two requests: `GET /api/info` (unauthenticated — it only proves the server answers and carries
 *  the version) and `GET /api/session/active` with Basic auth, which must be 200: it is the cheap
 *  authenticated route, and the only thing here that proves the password file still matches the
 *  running server (401 without or with a wrong password, measured 2.0.25). */
export async function getOpencodeServerStatus(
  fetchImpl: typeof fetch = fetch,
): Promise<OpencodeServerStatus> {
  const base = { pinned: OPENCODE_PINNED_VERSION, version: null, versionOk: false };
  let password: string;
  try {
    password = readServerPassword();
  } catch (err) {
    return {
      ...base,
      ok: false,
      up: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const get = (path: string) =>
    fetchImpl(`${opencodeServerUrl()}${path}`, {
      headers: { authorization: basicAuthHeader(password) },
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });

  // In parallel: one hung server must cost one timeout, not three. The model list rides along
  // (its failure proves nothing and is judged only after the version/password checks pass).
  const [infoResult, activeResult, modelsResult, agentsResult] = await Promise.allSettled([
    get("/api/info"),
    get("/api/session/active"),
    get("/api/model"),
    get("/api/agent"),
  ]);
  for (const result of [infoResult, activeResult]) {
    if (result.status === "fulfilled") continue;
    // The other responses (if any) are not read — release them.
    for (const other of [infoResult, activeResult, modelsResult, agentsResult]) {
      if (other.status === "fulfilled") await other.value.body?.cancel();
    }
    return {
      ...base,
      ok: false,
      up: false,
      error: `opencode server unreachable: ${unreachableReason(result.reason)}`,
    };
  }
  const info = (infoResult as PromiseFulfilledResult<Response>).value;
  const active = (activeResult as PromiseFulfilledResult<Response>).value;
  await active.body?.cancel();

  if (!info.ok) {
    await info.body?.cancel();
    return {
      ...base,
      ok: false,
      up: true,
      error: `opencode server answered HTTP ${info.status} on /api/info`,
    };
  }

  let infoVersion: string | null = null;
  try {
    const parsed = InfoSchema.safeParse(await info.json());
    if (parsed.success) infoVersion = normalizeOpencodeVersion(parsed.data.version);
  } catch {
    // unparseable body — fall through to the binary's version
  }
  const version = infoVersion ?? (await binaryVersion());
  const versionOk = version === OPENCODE_PINNED_VERSION;
  const found = { ...base, up: true, version, versionOk };

  if (active.status === 401) {
    return { ...found, ok: false, error: "opencode server password rejected (HTTP 401)" };
  }
  if (active.status !== 200) {
    return {
      ...found,
      ok: false,
      error: `opencode server answered HTTP ${active.status} on /api/session/active`,
    };
  }
  if (!versionOk) {
    return {
      ...found,
      ok: false,
      error: `opencode server version ${version ?? "unknown"} != pinned ${OPENCODE_PINNED_VERSION}`,
    };
  }
  const missingAgents = await missingServerAgents(agentsResult);
  const missing = [...(await missingServerModels(modelsResult)), ...missingAgents];
  if (missing.length > 0) {
    return {
      ...found,
      ok: false,
      error:
        `opencode server config is stale: it does not list ${missing.join(", ")} ` +
        "(the registry or the permission profiles changed since it started) — `make install-opencode-agent` loads the current config",
    };
  }
  return { ...found, ok: true };
}

const ModelListSchema = z.object({
  data: z.array(z.object({ providerID: z.string(), id: z.string() })),
});

const AgentListSchema = z.object({
  data: z.array(z.object({ name: z.string(), permissions: z.array(z.unknown()) })),
});

/** `agent:<name>` for every profile the current config defines that the running server lacks (or
 *  carries with fewer rules — the server prepends its own base rules, so a longer list is normal).
 *  Fails open like the model check: an unreadable answer proves nothing. */
async function missingServerAgents(result: PromiseSettledResult<Response>): Promise<string[]> {
  if (result.status !== "fulfilled") return [];
  const res = result.value;
  if (res.status !== 200) {
    await res.body?.cancel();
    return [];
  }
  const parsed = AgentListSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) return [];
  const live = new Map(parsed.data.data.map((a) => [a.name, a.permissions.length]));
  const expected = buildOpencodeServerConfig().agents as Record<
    string,
    { permissions: readonly unknown[] }
  >;
  return Object.entries(expected)
    .filter(([name, def]) => (live.get(name) ?? -1) < def.permissions.length)
    .map(([name]) => `agent:${name}`);
}

/** Registry models the running server does not list as `<provider>/<id>`. A server started
 *  before a registry change keeps its old `OPENCODE_CONFIG_CONTENT` (`make reload` never restarts
 *  it), so a new route model would fail every session while the version check stays green. A
 *  failed request or a body that is not a model list proves nothing and reports no drift. */
async function missingServerModels(result: PromiseSettledResult<Response>): Promise<string[]> {
  if (result.status !== "fulfilled") return [];
  const res = result.value;
  if (res.status !== 200) {
    await res.body?.cancel();
    return [];
  }
  const parsed = ModelListSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) return [];
  const listed = new Set(parsed.data.data.map((m) => `${m.providerID}/${m.id}`));
  return opencodeServerModels()
    .map((m) => `${opencodeProviderForWire(m.wire)}/${m.id}`)
    .filter((ref) => !listed.has(ref));
}

// ── Interrupt ───────────────────────────────────────────────────────────────────

const INTERRUPT_TIMEOUT_MS = 5_000;
const InterruptSchema = z.object({ interrupted: z.boolean() });

export interface OpencodeInterruptResult {
  /** The request got a well-formed answer. */
  ok: boolean;
  /** The server stopped a running turn (false on an idle session — a harmless no-op). */
  interrupted: boolean;
  error?: string;
}

/** `POST /api/session/{id}/interrupt` — the only reliable stop for a server-side session:
 *  a session keeps executing tools until it is interrupted, whatever happened to whoever
 *  started it (measured 2.0.25 with a killed CLI client: a file was written 40 s later). Best-effort:
 *  it never throws, never logs a body, and answers `{interrupted:false}` on an idle session, so
 *  calling it after every non-clean exit is safe. `fetchImpl` is a test seam. */
export async function interruptOpencodeSession(
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OpencodeInterruptResult> {
  let password: string;
  try {
    password = readServerPassword();
  } catch (err) {
    return {
      ok: false,
      interrupted: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    const res = await fetchImpl(
      `${opencodeServerUrl()}/api/session/${encodeURIComponent(sessionId)}/interrupt`,
      {
        method: "POST",
        headers: { authorization: basicAuthHeader(password) },
        signal: AbortSignal.timeout(INTERRUPT_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, interrupted: false, error: `HTTP ${res.status}` };
    }
    const parsed = InterruptSchema.safeParse(await res.json());
    if (!parsed.success) return { ok: false, interrupted: false, error: "unexpected response" };
    return { ok: true, interrupted: parsed.data.interrupted };
  } catch (err) {
    return { ok: false, interrupted: false, error: unreachableReason(err) };
  }
}
