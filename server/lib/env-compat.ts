import "./load-env.ts";

// Deprecation window for the sideclaw → agent-gateway rename: every `SIDECLAW_<X>` the
// environment (or .env) still carries is aliased to `AGENT_GATEWAY_<X>` unless that is already
// set. Import this FIRST in every entry point (after nothing else): routing, logger and the
// store read their flags at module load. Prefix-computed lookups (`SIDECLAW_MODEL_${tool}`)
// are covered too, since the alias is applied to the whole environment, not a key list.
//
// Logging is the caller's job (`legacyEnvKeys`): this module must run before the logger exists,
// because the logger itself reads `AGENT_GATEWAY_LOG_FILE`.

const LEGACY_PREFIX = "SIDECLAW_";
const PREFIX = "AGENT_GATEWAY_";

/** Mutates `env`: copies `SIDECLAW_*` → `AGENT_GATEWAY_*` where the new name is unset. Returns the legacy
 *  names it saw (aliased or shadowed), sorted — the list to warn about once at boot. */
export function aliasLegacyEnv(env: Record<string, string | undefined>): string[] {
  const seen: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(LEGACY_PREFIX) || value === undefined) continue;
    seen.push(key);
    const next = PREFIX + key.slice(LEGACY_PREFIX.length);
    if (env[next] === undefined) env[next] = value;
  }
  return seen.toSorted();
}

export const legacyEnvKeys: string[] = aliasLegacyEnv(process.env);

/** One warn line per process, once the logger exists. No-op when nothing legacy is set. */
export function warnLegacyEnv(log: { warn: (obj: object, msg: string) => void }): void {
  if (legacyEnvKeys.length === 0) return;
  log.warn(
    { event: "env.legacy_prefix", keys: legacyEnvKeys },
    "SIDECLAW_* env vars are deprecated — rename to AGENT_GATEWAY_*",
  );
}
