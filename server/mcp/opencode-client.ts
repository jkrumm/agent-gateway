// ── Typed HTTP client for the shared OpenCode v2 server ─────────────────────────────────
//
// Wave 3 (docs/opencode-v2.md): an episode is a SESSION on the agw-owned server — create →
// environment → prompt → wait → messages — driven over HTTP by `runOpencodeAttempt`
// (opencode-runner.ts), not an `opencode run` child process. This module is the port: the
// `OpencodeClient` interface is what the runner depends on, `createOpencodeClient` is the
// production adapter (thin zod-validated `fetch` over the OpenAPI document,
// `opencode api GET /openapi.json`, labelled experimental 0.0.1 — Wave 1 chose this over
// `@opencode/client`), and tests inject an in-memory fake of the same interface.
//
// Measured shapes (2.0.25, docs/opencode-v2.md): list responses are `{data, cursor}`; messages are
// newest-first by default, page 50, `limit` ≤ 200, walked with `order=asc` then `cursor=<next>`
// (never combined with `order`) until a page comes back empty; `cursor.next` is present even on
// the last page. A response body is never logged — `GET /api/config` returns the IU key in
// plaintext and a message can echo anything a worker printed.

import { z } from "zod";
import {
  basicAuthHeader,
  interruptOpencodeSession,
  opencodeServerUrl,
  readServerPassword,
  unreachableReason,
  type OpencodeInterruptResult,
} from "./opencode-server.ts";

/** Hang guard for the short request/response calls (create, env, prompt, list, get) — plain local
 *  HTTP, not an agent run. `wait` carries no timeout: it is the episode (agent-limits rule). */
const REQUEST_TIMEOUT_MS = 30_000;
/** Tries for a timed-out GET (idempotent); other verbs are never repeated. */
const GET_ATTEMPTS = 3;
/** Ceiling of the pause before a GET's 2nd try; each further try multiplies it (250 ms, 1 s). */
const GET_BACKOFF_BASE_MS = 250;
const GET_BACKOFF_FACTOR = 4;

/** Pause before retry number `retry` (1 = the 2nd try) of a timed-out GET: exponential with
 *  equal jitter — half the ceiling fixed, half random — so parallel episodes that stalled on the
 *  same slow server answer do not re-hit it in lockstep, and the pause is never ~0. Pure. */
export function getRetryDelayMs(retry: number, random: () => number = Math.random): number {
  const ceiling = GET_BACKOFF_BASE_MS * GET_BACKOFF_FACTOR ** (retry - 1);
  return ceiling / 2 + (random() * ceiling) / 2;
}

/** Test seams for the client's retry pause — production passes nothing. */
export interface OpencodeClientOptions {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}
/** v2 caps `limit` at 200 (400 above). */
const PAGE_LIMIT = 200;

// ── Wire schemas (lenient: unknown fields pass, optional where the spec marks them so) ──

const TokensSchema = z
  .object({
    input: z.number().default(0),
    output: z.number().default(0),
    reasoning: z.number().default(0),
    cache: z
      .object({ read: z.number().default(0), write: z.number().default(0) })
      .default({ read: 0, write: 0 }),
  })
  .partial();

const ContentBlockSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  name: z.string().optional(),
  state: z
    .looseObject({
      status: z.string().optional(),
      input: z.record(z.string(), z.unknown()).optional(),
      /** A shell tool part carries `{ shellID }` here (measured 2.0.29). */
      metadata: z.record(z.string(), z.unknown()).optional().catch(undefined),
    })
    .optional(),
});

const ErrorSchema = z.looseObject({
  type: z.string().optional(),
  message: z.string().optional(),
  status: z.number().optional(),
});

/** Lenient per field: a message type agw does not read (user, shell, compaction, …) may carry any
 *  `content`/`error` shape, and one unexpected field must not make the whole page unreadable. */
const MessageSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  content: z.array(ContentBlockSchema).optional().catch(undefined),
  finish: z.string().optional().catch(undefined),
  cost: z.number().optional().catch(undefined),
  tokens: TokensSchema.optional().catch(undefined),
  error: ErrorSchema.optional().catch(undefined),
  outcome: z.enum(["succeeded", "failed", "interrupted"]).optional().catch(undefined),
});

export type OpencodeMessage = z.infer<typeof MessageSchema>;
export type OpencodeContentBlock = z.infer<typeof ContentBlockSchema>;

const PageSchema = z.object({
  data: z.array(MessageSchema),
  cursor: z.object({ next: z.string().nullish() }).partial().optional(),
});
const SessionIdSchema = z.object({ data: z.object({ id: z.string().min(1) }) });
const SessionInfoSchema = z.object({
  data: z.object({
    cost: z.number().default(0),
    outcome: z.enum(["succeeded", "failed", "interrupted"]).optional(),
  }),
});
const ShellOutputSchema = z.object({ data: z.object({ size: z.number() }) });
const ActiveSchema = z.object({ data: z.record(z.string(), z.unknown()) });

// ── Port ────────────────────────────────────────────────────────────────────────────────

export interface OpencodeSessionSpec {
  directory: string;
  model: { providerID: string; id: string; variant?: string };
  /** `agw-readonly` | `agw-implement` — the permission profile defined in the server config. */
  agent: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface OpencodePromptInput {
  text: string;
  /** Re-attach a session whose turn was cut off (server restart) — Wave 4. */
  resume?: boolean;
  /** `steer` (default) injects into a running turn; `queue` runs after it. */
  delivery?: "steer" | "queue";
}

export interface OpencodeSessionInfo {
  /** The settled rollup — slightly above the message sum (a background call bills the session). */
  costUsd: number;
  outcome?: "succeeded" | "failed" | "interrupted";
}

export interface OpencodeClient {
  /** Returns the new session id. */
  createSession(spec: OpencodeSessionSpec): Promise<string>;
  /** `PUT …/environment`: the shell env for this session, applied over the server process's env —
   *  a blank value blanks the inherited variable (measured 2.0.25). Call before the first prompt. */
  setEnvironment(sessionId: string, variables: Record<string, string>): Promise<void>;
  /** Admits the input and schedules the agent loop; returns once admitted. */
  prompt(sessionId: string, input: OpencodePromptInput): Promise<void>;
  /** One long-poll: `true` once the session is idle, `false` when the server answered without it
   *  being idle (call again). Rejects with the AbortError when `signal` aborts. */
  wait(sessionId: string, signal: AbortSignal): Promise<boolean>;
  /** The newest `limit` messages, newest first (the liveness probe — one cheap request). */
  recentMessages(sessionId: string, limit: number): Promise<OpencodeMessage[]>;
  /** Every message, oldest first — paginates until a page is empty. */
  allMessages(sessionId: string): Promise<OpencodeMessage[]>;
  session(sessionId: string): Promise<OpencodeSessionInfo>;
  /** Total bytes a shell command has printed so far (`GET /api/shell/{id}/output`, `data.size`,
   *  grows live while it runs). The idle watchdog's liveness signal for a long-running shell tool
   *  part, which changes nothing in the message stream. `directory` is the session's. */
  shellOutputSize(shellId: string, directory: string): Promise<number>;
  /** Best-effort stop; never throws (`{interrupted:false}` on an idle session). */
  interrupt(sessionId: string): Promise<OpencodeInterruptResult>;
  /** Session ids with a running turn. */
  active(): Promise<string[]>;
}

// ── Adapter ─────────────────────────────────────────────────────────────────────────────

/** A request the server answered with a non-2xx, or a body that does not match the schema. The
 *  message carries the status/route only — never the body. A connection-level failure is a plain
 *  Error whose text names `ECONNREFUSED`/`ETIMEDOUT`/`fetch failed`, so the retry ladder and the
 *  circuit breaker classify it as transport. */
export class OpencodeHttpError extends Error {
  constructor(
    readonly status: number,
    route: string,
  ) {
    super(`opencode server answered HTTP ${status} on ${route}`);
    this.name = "OpencodeHttpError";
  }
}

export function createOpencodeClient(
  fetchImpl: typeof fetch = fetch,
  { sleep = Bun.sleep, random = Math.random }: OpencodeClientOptions = {},
): OpencodeClient {
  const attempt = async (
    method: string,
    path: string,
    options: { body?: unknown; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Response> => {
    const signals = [
      ...(options.signal ? [options.signal] : []),
      ...(options.timeoutMs === undefined ? [] : [AbortSignal.timeout(options.timeoutMs)]),
    ];
    const startedAt = Date.now();
    try {
      return await fetchImpl(`${opencodeServerUrl()}${path}`, {
        method,
        headers: {
          authorization: basicAuthHeader(readServerPassword()),
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
      });
    } catch (err) {
      // The caller's own abort stays an AbortError; everything else is a transport failure. The
      // route and elapsed time name which call stalled (a bare "ETIMEDOUT" never did).
      if (options.signal?.aborted) throw err;
      throw new Error(
        `opencode server unreachable: ${unreachableReason(err)} [${method} ${path.split("?")[0]} after ${Date.now() - startedAt}ms]`,
      );
    }
  };

  /** A timed-out GET is idempotent: retry it (after a short jittered backoff) before surfacing,
   *  so one slow server answer (the 2.0.25 stall) never fails a read that a second try would have
   *  served. */
  const call = async (
    method: string,
    path: string,
    options: { body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Response> => {
    const tries = method === "GET" ? GET_ATTEMPTS : 1;
    for (let n = 1; n < tries; n++) {
      try {
        return await attempt(method, path, options);
      } catch (err) {
        if (!(err instanceof Error && /ETIMEDOUT/.test(err.message))) throw err;
        await sleep(getRetryDelayMs(n, random));
      }
    }
    return attempt(method, path, options);
  };

  const json = async <S extends z.ZodType>(
    res: Response,
    route: string,
    schema: S,
  ): Promise<z.infer<S>> => {
    if (!res.ok) {
      await res.body?.cancel();
      throw new OpencodeHttpError(res.status, route);
    }
    const parsed = schema.safeParse(await res.json());
    if (!parsed.success) throw new Error(`opencode server answered an unexpected body on ${route}`);
    return parsed.data;
  };

  const ok = async (res: Response, route: string): Promise<void> => {
    await res.body?.cancel();
    if (!res.ok) throw new OpencodeHttpError(res.status, route);
  };

  const sessionPath = (id: string, tail = "") => `/api/session/${encodeURIComponent(id)}${tail}`;

  return {
    async createSession(spec) {
      const route = "POST /api/session";
      const res = await call("POST", "/api/session", {
        timeoutMs: REQUEST_TIMEOUT_MS,
        body: {
          location: { directory: spec.directory },
          model: spec.model,
          agent: spec.agent,
          ...(spec.title ? { title: spec.title } : {}),
          ...(spec.metadata ? { metadata: spec.metadata } : {}),
        },
      });
      return (await json(res, route, SessionIdSchema)).data.id;
    },

    async setEnvironment(sessionId, variables) {
      const res = await call("PUT", sessionPath(sessionId, "/environment"), {
        timeoutMs: REQUEST_TIMEOUT_MS,
        body: { variables },
      });
      await ok(res, "PUT /api/session/{id}/environment");
    },

    async prompt(sessionId, input) {
      const res = await call("POST", sessionPath(sessionId, "/prompt"), {
        timeoutMs: REQUEST_TIMEOUT_MS,
        body: {
          text: input.text,
          ...(input.resume ? { resume: true } : {}),
          ...(input.delivery ? { delivery: input.delivery } : {}),
        },
      });
      await ok(res, "POST /api/session/{id}/prompt");
    },

    async wait(sessionId, signal) {
      const res = await call(
        "POST",
        `/api/experimental/session/${encodeURIComponent(sessionId)}/wait`,
        { signal },
      );
      await res.body?.cancel();
      if (res.status === 204 || res.status === 200) return true;
      // 503 and friends: the server answered without the session being idle — poll again. A 404 is
      // a lost session and must surface.
      // Terminal client errors (a rejected password is 401/403) must fail the attempt, not poll on.
      if (res.status >= 400 && res.status < 500 && ![408, 425, 429].includes(res.status)) {
        throw new OpencodeHttpError(res.status, "POST /api/experimental/session/{id}/wait");
      }
      return false;
    },

    async recentMessages(sessionId, limit) {
      const res = await call("GET", sessionPath(sessionId, `/message?order=desc&limit=${limit}`), {
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      return (await json(res, "GET /api/session/{id}/message", PageSchema)).data;
    },

    async allMessages(sessionId) {
      const route = "GET /api/session/{id}/message";
      const out: OpencodeMessage[] = [];
      let path = sessionPath(sessionId, `/message?order=asc&limit=${PAGE_LIMIT}`);
      for (;;) {
        const page = await json(
          await call("GET", path, { timeoutMs: REQUEST_TIMEOUT_MS }),
          route,
          PageSchema,
        );
        if (page.data.length === 0) return out;
        out.push(...page.data);
        const next = page.cursor?.next;
        if (!next) return out;
        path = sessionPath(
          sessionId,
          `/message?cursor=${encodeURIComponent(next)}&limit=${PAGE_LIMIT}`,
        );
      }
    },

    async session(sessionId) {
      const res = await call("GET", sessionPath(sessionId), { timeoutMs: REQUEST_TIMEOUT_MS });
      const { data } = await json(res, "GET /api/session/{id}", SessionInfoSchema);
      return { costUsd: data.cost, outcome: data.outcome };
    },

    async shellOutputSize(shellId, directory) {
      const res = await call(
        "GET",
        `/api/shell/${encodeURIComponent(shellId)}/output?location%5Bdirectory%5D=${encodeURIComponent(directory)}&limit=1`,
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      return (await json(res, "GET /api/shell/{id}/output", ShellOutputSchema)).data.size;
    },

    interrupt: (sessionId) => interruptOpencodeSession(sessionId, fetchImpl),

    async active() {
      const res = await call("GET", "/api/session/active", { timeoutMs: REQUEST_TIMEOUT_MS });
      return Object.keys((await json(res, "GET /api/session/active", ActiveSchema)).data);
    },
  };
}
