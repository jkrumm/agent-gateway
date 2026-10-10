// ── Shared worker plumbing — what both harnesses (and the IU SSE reader) do identically ──
//
// `session-runner.ts` (claude -p) and `opencode-runner.ts` (opencode run) import each other
// (the runner dispatches into the harness; the harness reuses the runner's chassis), so
// anything BOTH need verbatim lives here instead: this module imports nothing from either,
// which keeps the extraction cycle-free. `session-runner.ts` re-exports `scrubSensitiveEnv`
// and `usageLane` so existing importers keep resolving.

/** Env var names that look like a credential. Matched case-insensitively against the
 *  inherited environment and deleted before the worker is spawned. Deliberately broad —
 *  a false positive costs a worker a variable it almost certainly did not need, while a
 *  false negative hands a live token to a session whose prompt may be attacker-written. */
const SENSITIVE_ENV_RE =
  /(TOKEN|SECRET|PASSWORD|PASSWD|_KEY|APIKEY|API_KEY|CREDENTIAL|BEARER|SESSION_ID)/i;

/** Exempt from the scrub: the CLI's own auth path. On the `max` backend the inherited
 *  OAuth profile is how the worker authenticates at all, so scrubbing it would break
 *  every session rather than harden it. The `iu` backend sets its own ANTHROPIC_*
 *  vars after this point regardless. */
const ALWAYS_KEEP_ENV = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);

/** Delete every credential-shaped key (`SENSITIVE_ENV_RE`, less `ALWAYS_KEEP_ENV`) from an
 *  env object IN PLACE. See `workerBaseEnv` and `buildWorkerEnv`'s inline comment for why this
 *  must run before either harness writes its own backend credentials. */
export function scrubSensitiveEnv(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    if (SENSITIVE_ENV_RE.test(key) && !ALWAYS_KEEP_ENV.has(key)) delete env[key];
  }
}

/**
 * The `USAGE_LANE` value for a routed tool — `sideclaw:<tool>`, coarsened to the part
 * before the first `:` in `tool` itself. `review`'s sub-steps (`review:router`,
 * `review:angle`, `review:adversary`, `review:synthesis`) pass their own sub-tool label
 * through `SessionOptions.tool` for logging/attribution, but usage-tracker's `sub_tool`
 * column is a flat string with no sub-lane concept (`report.ts`'s grouping is a plain
 * `coalesce`, nothing wildcard-aware) — one lane per Max-lane worker keeps
 * `stats --by sub_tool` a single `sideclaw:review` row instead of four fragments. Single
 * chokepoint so every spawn path (all of them already route through `workerBaseEnv`)
 * gets this for free rather than each call site coarsening its own `tool` string.
 */
export function usageLane(tool: string | undefined): string {
  const base = (tool ?? "unknown").split(":")[0];
  return `sideclaw:${base}`;
}

/** The env prelude both harnesses share: copy the inherited env (defined entries only), strip
 *  the parent's own session identity, mark the process a worker, tag `USAGE_LANE` (read by
 *  usage-tracker's claude-code collector via hooks/notify.ts's session_env log line to
 *  attribute the worker's cost to its routed tool), THEN scrub every credential-shaped key.
 *  Order is load-bearing: the caller writes its own backend credentials AFTER this returns,
 *  so a scrub placed later would delete the just-written key. */
export function workerBaseEnv(
  baseEnv: Record<string, string | undefined>,
  tool: string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v !== undefined) env[k] = v;
  }
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_PARENT_SESSION_ID;
  env.CLAUDE_ENTRYPOINT = "worker";
  env.USAGE_LANE = usageLane(tool);
  scrubSensitiveEnv(env);
  return env;
}

/** Drain `stream` line by line. `onChunk` fires after every decoded chunk (an idle watchdog's
 *  liveness signal — it resets on each token, not just the first), `onLine` once per complete
 *  non-empty line, trimmed. Returns the trailing partial line (no terminating newline seen),
 *  untouched — a caller that cares parses it, one that does not drops it. The reader lock is
 *  released on every exit path, including a throwing `onLine`. */
export async function readTrimmedLines(
  stream: ReadableStream<Uint8Array>,
  handlers: { onChunk?: () => void; onLine: (line: string) => void },
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buf += decoder.decode(); // flush a multi-byte sequence the final chunk left half-open
        break;
      }
      handlers.onChunk?.();
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) handlers.onLine(trimmed);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return buf;
}
