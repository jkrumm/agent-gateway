// Prints the shared OpenCode server's environment as shell `export` lines, for
// scripts/agent-gateway-opencode-start.sh to `eval`. Run with cwd = the repo root so Bun
// auto-loads `.env` (AGENT_GATEWAY_OPENCODE_PORT). Creates the state tree
// and the 0600 password file on first run. Never run by hand with the output on a shared
// terminal: it contains the IU key and the server password.
//
// Besides the server's own env it exports four wrapper-only values (not passed to the server):
//   AGW_OPENCODE_PINNED_VERSION, AGW_OPENCODE_PORT, AGW_OPENCODE_STATE_ROOT, and
//   AGW_OPENCODE_ENV_NAMES — the space-separated names the wrapper forwards through `env -i`.

import { getIuConfig } from "../server/lib/iu-openai.ts";
import {
  ensureServerState,
  getOpencodeServerStatus,
  OPENCODE_PINNED_VERSION,
  opencodeServerEnv,
  opencodeServerPort,
  opencodeStateRoot,
} from "../server/mcp/opencode-server.ts";

// `--port`: print only the resolved port (AGENT_GATEWAY_OPENCODE_PORT from env/.env, else the
// default) — no secrets, no state creation. The single source `make install-opencode-agent` uses.
if (process.argv.includes("--port")) {
  console.log(String(opencodeServerPort()));
  process.exit(0);
}

// `--status`: print `getOpencodeServerStatus()` as JSON (no secrets in it) — build-independent
// of the running agent-gateway, which is what scripts/deploy.sh needs before it reloads.
if (process.argv.includes("--status")) {
  console.log(JSON.stringify(await getOpencodeServerStatus()));
  process.exit(0);
}

/** POSIX single-quote escaping: safe for any value, including newlines and `'`. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const { password } = ensureServerState();
const iu = await getIuConfig();
const env = opencodeServerEnv({
  iuKey: iu.key,
  iuOpenaiBase: iu.openaiBase,
  iuAnthropicBase: `${iu.anthropicBase.replace(/\/$/, "")}/v1`,
  password,
});

const lines = Object.entries({
  ...env,
  AGW_OPENCODE_PINNED_VERSION: OPENCODE_PINNED_VERSION,
  AGW_OPENCODE_PORT: String(opencodeServerPort()),
  AGW_OPENCODE_STATE_ROOT: opencodeStateRoot(),
  AGW_OPENCODE_ENV_NAMES: Object.keys(env).join(" "),
}).map(([name, value]) => `export ${name}=${shellQuote(value)}`);

console.log(lines.join("\n"));
