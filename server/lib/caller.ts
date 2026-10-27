import { AsyncLocalStorage } from "node:async_hooks";

// The `caller` of a job: a short slug naming the consumer that submitted it (e.g. "iris"), so
// spend is attributable per consumer. Optional end to end — a job without one carries no field
// anywhere (job view, attribution rows, IU usage rows).
//
// The slug rides an AsyncLocalStorage context opened by `executeJob` instead of being threaded
// through every handler → `runSession` → attribution call: the two usage sinks
// (`writeAttribution` in session-core.ts, `recordIuUsage` in iu-openai.ts) read it where they
// write, so a new tool or sink cannot forget it.

export const CALLER_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const CALLER_RULE =
  "caller must match ^[a-z0-9][a-z0-9-]{0,31}$ (lowercase slug, ≤ 32 chars)";

export function isValidCaller(value: unknown): value is string {
  return typeof value === "string" && CALLER_PATTERN.test(value);
}

const store = new AsyncLocalStorage<string>();

/** Runs `fn` (and everything it awaits) with `caller` as the ambient caller. A null/undefined
 *  caller runs `fn` as-is, so no stale outer caller can leak in either. */
export function withCaller<T>(caller: string | null | undefined, fn: () => T): T {
  return caller ? store.run(caller, fn) : store.exit(fn);
}

/** The ambient caller, or undefined outside a job (or inside one submitted without a caller). */
export function currentCaller(): string | undefined {
  return store.getStore();
}

/** `{ caller }` when one is ambient, else `{}` — spread into a usage/attribution row. */
export function callerField(): { caller?: string } {
  const caller = currentCaller();
  return caller ? { caller } : {};
}
