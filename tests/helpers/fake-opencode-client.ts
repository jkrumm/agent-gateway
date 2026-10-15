// In-memory test adapter for the `OpencodeClient` port (server/mcp/opencode-client.ts): sessions
// hold message arrays in the real wire shape, calls are recorded, and a test scripts what each
// prompt produces. No network, no timers of its own — a hanging `wait` ends only through
// `interrupt()` or its abort signal, so tests drive time through the runner's `pollMs` /
// `idleTimeoutMs` seams.

import type {
  OpencodeClient,
  OpencodeContentBlock,
  OpencodeMessage,
  OpencodePromptInput,
  OpencodeSessionInfo,
  OpencodeSessionSpec,
} from "../../server/mcp/opencode-client.ts";
import {
  OPENCODE_AGENT_IMPLEMENT,
  OPENCODE_AGENT_READONLY,
  OPENCODE_AGENT_READONLY_SENSITIVE,
  type OpencodeInterruptResult,
} from "../../server/mcp/opencode-server.ts";

export type Outcome = "succeeded" | "failed" | "interrupted";

export interface TokenSpec {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface AssistantSpec {
  content?: OpencodeContentBlock[];
  /** Per-message usage; `null` = an unfinished message that carries no `tokens` yet. */
  tokens?: TokenSpec | null;
  cost?: number;
  error?: { type?: string; message?: string; status?: number };
  finish?: string;
}

/** What one prompt produces. */
export interface FakeTurn {
  /** Appended when the turn completes (i.e. right before the idle message). */
  assistant?: AssistantSpec[];
  /** Appended the moment the prompt is admitted — what a still-running turn has already shown. */
  visibleNow?: AssistantSpec[];
  /** The final `idle` message's outcome. Default `succeeded`. */
  outcome?: Outcome;
  /** Never completes by itself: `wait` stays open until `interrupt()` (→ idle `interrupted`) or abort. */
  hang?: boolean;
  /** The first N `wait` calls answer "idle" before the turn's messages/idle exist (the race). */
  prematureIdleWaits?: number;
  /** The first N `wait` calls answer "not idle" (`false`, like a 503); `Infinity` = always. */
  nonIdleWaits?: number;
  /** `wait` rejects with this (a transport failure mid-run); the turn never completes. */
  waitError?: Error;
}

// ── Wire-shape builders ──────────────────────────────────────────────────────────────────────

export const text = (value: string): OpencodeContentBlock => ({ type: "text", text: value });
export const reasoning = (): OpencodeContentBlock => ({ type: "reasoning", text: "thinking" });
export const shellTool = (command: string, status = "completed"): OpencodeContentBlock => ({
  type: "tool",
  name: "shell",
  state: { status, input: { command } },
});

let messageSeq = 0;
const nextId = (prefix: string): string => `${prefix}_${String(++messageSeq).padStart(6, "0")}`;

export function assistantMessage(spec: AssistantSpec = {}): OpencodeMessage {
  const tokens =
    spec.tokens === null
      ? undefined
      : {
          input: spec.tokens?.input ?? 10,
          output: spec.tokens?.output ?? 5,
          reasoning: spec.tokens?.reasoning ?? 0,
          cache: { read: spec.tokens?.cacheRead ?? 0, write: spec.tokens?.cacheWrite ?? 0 },
        };
  return {
    id: nextId("msg"),
    type: "assistant",
    content: spec.content ?? [],
    finish: spec.finish ?? "stop",
    cost: spec.cost ?? 0,
    ...(tokens ? { tokens } : {}),
    ...(spec.error ? { error: spec.error } : {}),
  };
}

export const idleMessage = (outcome: Outcome = "succeeded"): OpencodeMessage => ({
  id: nextId("idle"),
  type: "idle",
  outcome,
});

export const userMessage = (value: string): OpencodeMessage => ({
  id: nextId("msg"),
  type: "user",
  content: [text(value)],
});

const abortError = (): Error => new DOMException("The operation was aborted.", "AbortError");

// ── The fake ─────────────────────────────────────────────────────────────────────────────────

export interface FakeSession {
  id: string;
  spec?: OpencodeSessionSpec;
  messages: OpencodeMessage[];
  turn?: FakeTurn;
  prematureLeft: number;
  nonIdleLeft: number;
  /** Resolves the hanging `wait` (idle) — set while one is open. */
  releaseHang?: () => void;
}

export class FakeOpencodeClient implements OpencodeClient {
  readonly sessions = new Map<string, FakeSession>();

  // Recorded calls, in arrival order.
  readonly created: OpencodeSessionSpec[] = [];
  readonly environments: Array<{ sessionId: string; variables: Record<string, string> }> = [];
  readonly prompts: Array<{ sessionId: string; input: OpencodePromptInput }> = [];
  readonly interrupts: string[] = [];
  /** Every call, in order, for ordering assertions (`createSession` … `interrupt`). */
  readonly callLog: string[] = [];
  waitCalls = 0;
  /** Count of `recentMessages` calls with limit > 1 — the activity polls (the finish check asks for 1). */
  activityPolls = 0;

  // Failure injection.
  createError?: Error;
  environmentError?: Error;
  promptError?: Error;
  /** `allMessages` rejects (the post-run usage read). */
  allMessagesError?: Error;
  interruptResult: OpencodeInterruptResult | undefined;
  /** Called on every activity poll with the session — lets a test mutate messages deterministically. */
  onActivityPoll?: (session: FakeSession, pollIndex: number) => void;

  private readonly turns: FakeTurn[] = [];
  private seq = 0;

  /** Queue the turn the next prompt will produce (FIFO). */
  script(turn: FakeTurn): this {
    this.turns.push(turn);
    return this;
  }

  /** An existing session (resume): its messages are oldest first. */
  seed(sessionId: string, messages: OpencodeMessage[]): FakeSession {
    const session: FakeSession = {
      id: sessionId,
      messages: [...messages],
      prematureLeft: 0,
      nonIdleLeft: 0,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  /** The only session, for the common single-session test. */
  get only(): FakeSession {
    const [session, ...rest] = this.sessions.values();
    if (!session || rest.length > 0) throw new Error("expected exactly one fake session");
    return session;
  }

  private get(sessionId: string): FakeSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`fake opencode: unknown session ${sessionId}`);
    return session;
  }

  private complete(session: FakeSession): void {
    const turn = session.turn;
    if (!turn) return;
    session.turn = undefined;
    session.messages.push(...(turn.assistant ?? []).map(assistantMessage));
    session.messages.push(idleMessage(turn.outcome));
  }

  async createSession(spec: OpencodeSessionSpec): Promise<string> {
    this.callLog.push("createSession");
    if (this.createError) throw this.createError;
    this.created.push(spec);
    const id = `ses_fake_${++this.seq}`;
    this.sessions.set(id, { id, spec, messages: [], prematureLeft: 0, nonIdleLeft: 0 });
    return id;
  }

  async setEnvironment(sessionId: string, variables: Record<string, string>): Promise<void> {
    this.callLog.push("setEnvironment");
    if (this.environmentError) throw this.environmentError;
    this.get(sessionId);
    this.environments.push({ sessionId, variables });
  }

  async prompt(sessionId: string, input: OpencodePromptInput): Promise<void> {
    this.callLog.push("prompt");
    if (this.promptError) throw this.promptError;
    const session = this.get(sessionId);
    this.prompts.push({ sessionId, input });
    const turn = this.turns.shift() ?? {};
    session.turn = turn;
    session.prematureLeft = turn.prematureIdleWaits ?? 0;
    session.nonIdleLeft = turn.nonIdleWaits ?? 0;
    session.messages.push(userMessage(input.text));
    session.messages.push(...(turn.visibleNow ?? []).map(assistantMessage));
  }

  wait(sessionId: string, signal: AbortSignal): Promise<boolean> {
    this.callLog.push("wait");
    this.waitCalls++;
    const session = this.get(sessionId);
    if (signal.aborted) return Promise.reject(abortError());
    const turn = session.turn;
    if (turn?.waitError) return Promise.reject(turn.waitError);
    if (session.nonIdleLeft > 0) {
      session.nonIdleLeft--;
      return Promise.resolve(false);
    }
    if (turn?.hang) {
      return new Promise<boolean>((resolve, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener("abort", onAbort, { once: true });
        session.releaseHang = () => {
          signal.removeEventListener("abort", onAbort);
          resolve(true);
        };
      });
    }
    if (session.prematureLeft > 0) {
      session.prematureLeft--;
      return Promise.resolve(true);
    }
    this.complete(session);
    return Promise.resolve(true);
  }

  async recentMessages(sessionId: string, limit: number): Promise<OpencodeMessage[]> {
    this.callLog.push("recentMessages");
    const session = this.get(sessionId);
    if (limit > 1) this.onActivityPoll?.(session, this.activityPolls++);
    return session.messages.slice(-limit).toReversed();
  }

  async allMessages(sessionId: string): Promise<OpencodeMessage[]> {
    this.callLog.push("allMessages");
    if (this.allMessagesError) throw this.allMessagesError;
    return [...this.get(sessionId).messages];
  }

  async session(sessionId: string): Promise<OpencodeSessionInfo> {
    const messages = this.get(sessionId).messages;
    return {
      costUsd: messages.reduce((sum, m) => sum + (m.cost ?? 0), 0),
      outcome: messages.findLast((m) => m.type === "idle")?.outcome,
    };
  }

  async interrupt(sessionId: string): Promise<OpencodeInterruptResult> {
    this.callLog.push("interrupt");
    this.interrupts.push(sessionId);
    if (this.interruptResult) return this.interruptResult;
    const session = this.sessions.get(sessionId);
    if (!session?.turn) return { ok: true, interrupted: false };
    // The server stops the running turn and the session goes idle with outcome `interrupted`.
    session.turn = undefined;
    session.messages.push(idleMessage("interrupted"));
    session.releaseHang?.();
    session.releaseHang = undefined;
    return { ok: true, interrupted: true };
  }

  /** Agent ids the fake server "was booted with"; a test sets a subset to model a stale config. */
  agents: string[] = [
    OPENCODE_AGENT_READONLY,
    OPENCODE_AGENT_READONLY_SENSITIVE,
    OPENCODE_AGENT_IMPLEMENT,
  ];

  async listAgents(): Promise<string[]> {
    return [...this.agents];
  }

  async active(): Promise<string[]> {
    return [...this.sessions.values()].filter((s) => s.turn).map((s) => s.id);
  }
}
