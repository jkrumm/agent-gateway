import { z } from "zod";
import { zodValidator } from "../../mcp/session-runner.ts";
import type { DispatchTier } from "../../lib/dispatch-policy.ts";

// The dispatch verdict contract: the output schema consumers pin, the per-tier schemas the
// worker is graded against, and the lenient normalization applied before validation. Split out
// of dispatch.ts so the schema + version can be read (and imported by the schema route) without
// the whole episode pipeline.

// ── Output schema — single source of truth ────────────────────────────────────
//
// Deliberately strict. A dispatch feeds an automated return path (a Slack post, a watchdog
// projection) with no human between the worker and the reader, so a prose answer that
// merely *looks* like a verdict must fail validation here rather than arrive downstream as
// a `summary` nobody can render. `z.strictObject` rejects extra keys; the enums reject
// invented confidence/routing values; the length caps reject an essay in `summary`.

const SUMMARY_MAX = 200;
const VERDICT_MAX = 600;
const RECOMMENDATION_MAX = 400;
const ROOT_CAUSE_MAX = 80;
const DECISION_QUESTION_MAX = 200;
const OWNING_REPO_MAX = 100;
const ROOT_CAUSE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const OWNING_REPO_RE = /^[A-Za-z0-9._-]+$/;

const ROOT_CAUSE_FIELD = z
  .string()
  .max(ROOT_CAUSE_MAX)
  .regex(ROOT_CAUSE_RE)
  .optional()
  .describe(
    `Stable kebab-case key (lowercase a-z, 0-9, single hyphens, at most ${ROOT_CAUSE_MAX} chars) ` +
      "naming the underlying cause, e.g. stale-lockfile-after-rename. The same cause must " +
      "always get the same key — name the mechanism, not the symptom, and never include " +
      "ids, dates, paths or numbers.",
  );

const DECISION_QUESTION_FIELD = z
  .string()
  .min(1)
  .max(DECISION_QUESTION_MAX)
  .optional()
  .describe(
    `ONLY when nextAction is "human": one concrete question naming two options, at most ` +
      `${DECISION_QUESTION_MAX} chars. Omit it for every other nextAction.`,
  );

/** Why a `human` verdict needs the owner. The only reasons an unattended loop may stop for a
 *  person; `blocker` is a reported obstacle (injection attempt, unreadable repo), not a choice. */
const ESCALATION_CATEGORIES = [
  "product",
  "data_loss",
  "spend",
  "other_people",
  "security",
  "blocker",
] as const;

const ESCALATION_CATEGORY_FIELD = z
  .enum(ESCALATION_CATEGORIES)
  .optional()
  .describe(
    `ONLY when nextAction is "human": why only the owner can decide. product = product direction ` +
      `or user-visible product semantics | data_loss = irreversible data loss | spend = money | ` +
      `other_people = sends something to / affects another person | security = security policy | ` +
      `blocker = a reported obstacle, not a choice. A reversible A-or-B question is none of ` +
      `these: pick the recommended option and set nextAction to implement or none instead.`,
  );

const OWNING_REPO_FIELD = z
  .string()
  .max(OWNING_REPO_MAX)
  .regex(OWNING_REPO_RE)
  .optional()
  .describe(
    `Optional: the bare name of the repo that OWNS the finding when it is not the repo this ` +
      `episode runs in (e.g. a shared config or library the other repo depends on). Letters, ` +
      `digits, dots, underscores and hyphens only, at most ${OWNING_REPO_MAX} chars. Omit it ` +
      `when the finding belongs to the repo you are reading.`,
  );

const VERDICT_FIELDS = {
  verdict: z
    .string()
    .min(1)
    .max(4000)
    .describe("What is actually going on and why the episode believes it. 2-5 sentences."),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe(
      "high = read the code that causes it; medium = evidence points there; low = reasoned from outside.",
    ),
  evidence: z
    .array(
      z.strictObject({
        file: z.string().min(1).max(500).describe("Repo-relative path, or the command run."),
        detail: z.string().min(1).max(1000).describe("What it showed, one sentence."),
      }),
    )
    .max(30)
    .describe("What the episode actually inspected. Empty only if it inspected nothing."),
  recommendation: z
    .string()
    .min(1)
    .max(2000)
    .describe("The single most useful next step, concrete and actionable."),
  nextAction: z
    .enum(["none", "issue", "implement", "human"])
    .describe("Routing hint for the caller: nothing needed | track it | fix it | needs a human."),
  summary: z
    .string()
    .min(1)
    .max(SUMMARY_MAX)
    .describe("One line for Slack. Hard-capped — this is a notification, not a report."),
  // Additive and OPTIONAL at the schema level: results persisted before these fields existed,
  // the handler's own salvage/withheld wrappers and any consumer pinned to an older schemaVersion
  // must keep validating. Optional-ness is the compat decision; the prompt demands them.
  rootCause: ROOT_CAUSE_FIELD,
  decisionQuestion: DECISION_QUESTION_FIELD,
  escalationCategory: ESCALATION_CATEGORY_FIELD,
  owningRepo: OWNING_REPO_FIELD,
};

// What the WORKER is held to is tighter than what the handler may RETURN: the handler folds
// `artifactNote` into `verdict`, and the salvage wrapper carries up to 3000 chars of raw
// worker text, so the output-side `verdict`/`recommendation` caps (4000/2000) stay loose while
// the worker's own are the terse ones below. Overlong `summary`/`verdict`/`recommendation`/`rootCause`/`decisionQuestion`/`owningRepo` is
// normalized by `normalizeWorkerOutput` BEFORE validation (evidence and artifact fields stay strict).
const WORKER_VERDICT_FIELDS = {
  ...VERDICT_FIELDS,
  verdict: z
    .string()
    .min(1)
    .max(VERDICT_MAX)
    .describe(
      `What is going on and why the episode believes it. At most ${VERDICT_MAX} characters, 2-4 terse sentences.`,
    ),
  recommendation: z
    .string()
    .min(1)
    .max(RECOMMENDATION_MAX)
    .describe(
      `The single most useful next step, concrete and actionable. At most ${RECOMMENDATION_MAX} characters.`,
    ),
};

// Artifact text the WORKER authors but does NOT publish. Empty strings are legitimate and
// mean "nothing worth filing / nothing was changed" — a tier that finds no work is a
// successful run, so the minimum length is 0 and the coherence check lives in the handler
// (a schema rejection here would trigger the salvage retry for what is a valid outcome).
const ISSUE_FIELDS = {
  issueTitle: z.string().max(120).describe('GitHub issue title, or "" to file nothing.'),
  issueBody: z.string().max(60000).describe('GitHub issue body (markdown), or "" to file nothing.'),
};

const PR_FIELDS = {
  prTitle: z
    .string()
    .max(200)
    .describe('Conventional-commit PR subject, or "" if nothing was changed.'),
  prBody: z.string().max(60000).describe('PR body (markdown), or "" if nothing was changed.'),
};

// A consumer (today: warden, in another repo) pins this number and treats a mismatch as a
// loud refusal rather than a best-effort parse — the failure this exists to design out is a
// consumer silently ignoring a verdict whose shape moved under it. Bump it in this file
// whenever a field's meaning or presence on DISPATCH_OUTPUT changes.
//
// Bumped 1 → 2: added the "checks_failed" outcome (see DISPATCH_OUTCOMES below) — the
// implement tier now runs the repo's own `check` before any push, and a consumer that only
// knew the old ten outcomes would otherwise silently misclassify this one.
// Bumped 2 → 3: added the "applied_in_place" outcome and the `changedFiles` field — the
// implement tier gained a workspace mode that edits the live checkout and publishes
// nothing. `changedFiles` is absent on every other outcome, so a consumer that ignores it
// degrades gracefully, but the new outcome must not be silently misclassified.
//
// Also true as of this version, with no field-shape change to warrant its own bump: a
// fallow-only check failure on the implement tier's push path no longer yields
// "checks_failed" — fallow audits whole touched files and its findings are advisory, so they
// ride along in the opened PR instead of withholding it (see `checksBlockPush` in repo-check.ts).
// Bumped 3 → 4: added the "pr_updated" (a `revisionOf` episode updated its existing PR) and
// "conflict" (rebase onto the latest base failed; nothing pushed) outcomes. Shipped together
// with warden's pin, which handles both.
// Bumped 4 → 5: added the "checks_tool_failed" outcome — the repo's own `check` tool THREW
// (an infrastructure failure a re-run fixes), as distinct from a real red suite. A consumer
// that must re-dispatch rather than send a human at phantom failures reads this instead of
// substring-matching the verdict prose.
// Bumped 5 → 6: added the optional `fallbackWithheld` field (the session runner declined the
// reactive Max fallback for a write-tier episode that had already produced output). Shipped with
// the new dispatch INPUT params `branch`, `prTitle` and `kind` — inputs, not output shape, but a
// consumer pinned to 5 should re-read the contract before it starts sending them. Also true as of
// this version, with no output-shape change: a busy repo QUEUES an implement job (`pending`,
// `queuedBehind`) instead of failing it, and every statically knowable refusal is a synchronous
// HTTP 400 from `POST /api/jobs` with no job row.
// Bumped 6 → 7: added the optional `escalationCategory` field (present only with
// `nextAction: "human"`: why only the owner can decide). Additive, so a consumer that ignores it
// degrades gracefully, but one that acts on it must know the field can exist.
export const DISPATCH_SCHEMA_VERSION = 7;

/** Machine-readable classification of how this episode ended — the sixteen ways `runDispatch`
 *  can return, so a consumer never has to substring-match `artifactNote`'s prose to tell them
 *  apart. Two ordering rules a consumer should know: `withheld` overwrites whatever this would
 *  otherwise have been (the real verdict was scanned out, so no tier-specific outcome is
 *  trustworthy either), and `salvaged` never coexists with a tier outcome — a salvaged run
 *  never reached the tier-specific logic that would have set one.
 *
 *  - verdict_only   investigate: always — no artifact tier exists for it.
 *  - issue_declined author: the episode concluded nothing was worth tracking, no issue filed.
 *  - issue_failed   author: `openIssue` threw (secret-scan refusal, missing token scope).
 *  - issue_filed    author: filed OK, `artifactUrl` set.
 *  - no_changes     implement: the episode changed nothing (0 commits).
 *  - diff_refused   implement: branch discarded — too large, a workflow diff, or a secret match.
 *  - checks_failed  implement: pushed, but the repo's own `check` failed — no PR was opened.
 *  - checks_tool_failed  implement: pushed, but the repo's `check` TOOL threw before it could
 *                   grade the diff — an infrastructure failure (re-run the dispatch), not a
 *                   red suite. No PR was opened. Unlike `checks_failed`, `nextAction` is not
 *                   forced to `human`: a re-run is the fix.
 *  - branch_no_pr   implement: pushed, but the worker authored no PR text.
 *  - pr_failed      implement: pushed, but opening the pull request threw.
 *  - pr_opened      implement: full success — `artifactUrl` + `branch` both set.
 *  - pr_updated     implement + `revisionOf`: pushed to the prior branch (force-with-lease)
 *                   and the EXISTING open PR now carries it — `artifactUrl` is that PR.
 *  - conflict       implement: the rebase onto the latest default branch failed. Nothing was
 *                   pushed and the worktree is gone; the caller re-dispatches from the new
 *                   base (a worker never hand-resolves a conflict).
 *  - applied_in_place  implement, workspace in-place: edits are UNCOMMITTED in the live
 *                      checkout, `changedFiles` lists them; nothing was pushed. The owner
 *                      reviews and commits. A check failure still lands here (reported in
 *                      the verdict) because nothing was published that a red check could
 *                      gate — unlike `checks_failed`, `nextAction` is the worker's own.
 *  - salvaged       any tier: a serialization failure retried into a degraded verdict.
 *  - withheld       any tier: the secret scanner matched and replaced the verdict text.
 */
export const DISPATCH_OUTCOMES = [
  "verdict_only",
  "issue_declined",
  "issue_failed",
  "issue_filed",
  "no_changes",
  "diff_refused",
  "checks_failed",
  "checks_tool_failed",
  "branch_no_pr",
  "pr_failed",
  "pr_opened",
  "pr_updated",
  "conflict",
  "applied_in_place",
  "salvaged",
  "withheld",
] as const;

export type DispatchOutcome = (typeof DISPATCH_OUTCOMES)[number];

export const DISPATCH_OUTPUT = z.strictObject({
  ...VERDICT_FIELDS,
  ...ISSUE_FIELDS,
  ...PR_FIELDS,
  // Set by the HANDLER, never by the worker — required on every return path, including
  // salvage and withheld. See the DISPATCH_OUTCOMES doc comment above for the values and the
  // two ordering rules.
  outcome: z
    .enum(DISPATCH_OUTCOMES)
    .describe(
      "Typed classification of how the episode ended — see the DISPATCH_OUTCOMES doc comment " +
        "in dispatch-verdict.ts for what each value means. withheld and salvaged both override " +
        "whatever a tier-specific outcome would otherwise have been.",
    ),
  schemaVersion: z
    .literal(DISPATCH_SCHEMA_VERSION)
    .describe(
      "Version of this output shape. Pin this number; a mismatch means the shape moved under " +
        "you and should be a loud refusal, not a best-effort parse.",
    ),
  issueTitle: ISSUE_FIELDS.issueTitle.optional(),
  issueBody: ISSUE_FIELDS.issueBody.optional(),
  prTitle: PR_FIELDS.prTitle.optional(),
  prBody: PR_FIELDS.prBody.optional(),
  // Set by the HANDLER, never by the worker (which is why they are optional — the schema is
  // also what the worker is validated against).
  //
  // `degraded`: without it, a salvaged verdict and a real needs-human verdict are the
  // identical {confidence:"low", nextAction:"human"} tuple, and an automated Slack post or
  // watchdog projection could only tell them apart by substring-matching English prose.
  // They need opposite handling: one is "agent-gateway itself failed, retry or alert", the other
  // is a genuine finding to track.
  degraded: z
    .boolean()
    .optional()
    .describe(
      "True only when the tool failed to obtain a structured verdict and this object is a " +
        "salvage wrapper around raw worker text. Absent/false on a real verdict.",
    ),
  artifactUrl: z
    .string()
    .optional()
    .describe(
      "URL of the artifact the episode deposited — a GitHub issue (author) or a draft pull " +
        "request (implement). Absent when the tier produces none, or when the episode " +
        "concluded that nothing should be filed or changed.",
    ),
  branch: z
    .string()
    .optional()
    .describe(
      "Branch the implement tier pushed. Present without `artifactUrl` only when the branch " +
        "landed but no PR was opened — read the verdict for why.",
    ),
  // Set by the HANDLER, never by the worker. Present only on outcome `applied_in_place`:
  // the files the episode changed in the live checkout, still uncommitted there.
  changedFiles: z
    .array(z.string())
    .optional()
    .describe(
      "workspace 'in-place' only: repo-relative paths the episode changed in the live " +
        "checkout, uncommitted. Absent on every other outcome.",
    ),
  // Set by the HANDLER, never by the worker.
  fallbackWithheld: z
    .enum(["write-tier-after-output"])
    .optional()
    .describe(
      "Present only when the reactive Max fallback was withheld: a write-tier episode's IU " +
        "attempt had already produced output when it failed, so it was NOT re-run on another " +
        "backend (a second writer could clobber the first's edits). The verdict says so too.",
    ),
});

export type DispatchOutput = z.infer<typeof DISPATCH_OUTPUT>;

// What the WORKER is shown and graded against, per tier. The handler-only fields are
// omitted from all three, so a worker cannot set them: they are the handler's markers, and
// a field the worker can write is not a marker — it is a suggestion. Leaving `degraded` in
// the --json-schema also advertised its meaning, which is an invitation to a thin answer to
// flag itself as a tool failure (or an injected brief to disguise a real one).
//
// `decisionQuestion` and `escalationCategory` are gated on `nextAction`: the contract says they exist ONLY for `human`,
// so a worker schema rejects it on any other action (the normalizer below strips it first, so
// a stray one never costs an episode). "Required when human" is deliberately NOT a validation
// failure — a human verdict without a question (an injection finding, an unreadable repo) is
// still a finished episode, and failing it would burn a retry and end in a degraded salvage;
// the prompt demands the question and the category, and `runDispatch` logs their absence instead.
const gateHumanOnlyFields = <
  T extends { nextAction: string; decisionQuestion?: string; escalationCategory?: string },
>(
  v: T,
  ctx: z.RefinementCtx,
): void => {
  if (v.nextAction === "human") return;
  for (const key of ["decisionQuestion", "escalationCategory"] as const) {
    if (v[key] === undefined) continue;
    ctx.addIssue({
      code: "custom",
      path: [key],
      message: `${key} is only allowed when nextAction is "human"`,
    });
  }
};

export const WORKER_OUTPUT = {
  investigate: z.strictObject(WORKER_VERDICT_FIELDS).superRefine(gateHumanOnlyFields),
  author: z
    .strictObject({ ...WORKER_VERDICT_FIELDS, ...ISSUE_FIELDS })
    .superRefine(gateHumanOnlyFields),
  implement: z
    .strictObject({ ...WORKER_VERDICT_FIELDS, ...PR_FIELDS })
    .superRefine(gateHumanOnlyFields),
} as const satisfies Record<DispatchTier, z.ZodType>;

/** What a worker session actually returns: the full dispatch output MINUS the two fields the
 *  handler adds afterwards (`outcome`, `schemaVersion`). The per-tier `WORKER_OUTPUT` schemas
 *  are assignable to this — each is a strict subset (investigate omits the issue/PR fields,
 *  author omits the PR fields) — so `runSession<WorkerOutput>` can validate the worker without
 *  claiming it already carries handler-only fields. */
export type WorkerOutput = Omit<DispatchOutput, "outcome" | "schemaVersion">;

/** Truncate to `max` characters total, ending in an ellipsis. */
function clampText(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Coerce an arbitrary string into the `rootCause` key shape; "" when nothing usable is left. */
function normalizeRootCause(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ROOT_CAUSE_MAX)
    .replace(/-+$/g, "");
}

/** Coerce an arbitrary string toward the bare `owningRepo` name; "" when nothing usable is
 *  left. Unlike `rootCause` this must NOT invent a key: a repo name names something real, so
 *  rewriting `owner/repo` into `owner-repo` — or slicing a secret-store reference down to its
 *  last segment — would fabricate a name that is not the one meant. It rescues only the two
 *  unambiguous
 *  slips (surrounding whitespace, a trailing `.git`) and drops every reference-shaped or
 *  otherwise malformed value rather than guessing at it. */
function normalizeOwningRepo(text: string): string {
  const name = text.trim().replace(/\.git$/i, "");
  return name.length > 0 && name.length <= OWNING_REPO_MAX && OWNING_REPO_RE.test(name) ? name : "";
}

/** Clamp a text field in place when it is present; a no-op otherwise. Split out of
 *  `normalizeWorkerOutput` so its per-field handling does not accumulate one branch per field
 *  and drift over fallow's cognitive-complexity gate. */
function clampField(out: Record<string, unknown>, key: string, max: number): void {
  const raw = out[key];
  if (typeof raw === "string") out[key] = clampText(raw, max);
}

/** Apply `fix` to a string field in place, deleting the key when `fix` leaves nothing usable.
 *  A missing or non-string field is left untouched. */
function normalizeField(
  out: Record<string, unknown>,
  key: string,
  fix: (text: string) => string,
): void {
  const raw = out[key];
  if (typeof raw !== "string") return;
  const value = fix(raw);
  if (value) out[key] = value;
  else delete out[key];
}

/**
 * Lenient pre-validation pass over the worker's raw object. The caps live in WORKER_OUTPUT
 * (that is what the worker is shown via --json-schema), but a finished episode must never be
 * thrown away for being wordy: overlong text is truncated with an ellipsis, a `rootCause`
 * that is not quite kebab-case is coerced (or dropped when nothing usable remains), a
 * `decisionQuestion` that is empty or accompanies a non-human `nextAction` is dropped, and an
 * `owningRepo` that is not a plausible bare repo name is dropped. Anything that is not a plain
 * object, and every field it does not own, passes through untouched so the strict schema still
 * judges the shape.
 */
export function normalizeWorkerOutput(data: unknown): unknown {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return data;
  const out: Record<string, unknown> = { ...data };
  clampField(out, "summary", SUMMARY_MAX);
  clampField(out, "verdict", VERDICT_MAX);
  clampField(out, "recommendation", RECOMMENDATION_MAX);
  normalizeField(out, "rootCause", normalizeRootCause);
  normalizeField(out, "decisionQuestion", (q) =>
    out.nextAction === "human" ? clampText(q, DECISION_QUESTION_MAX) : "",
  );
  normalizeField(out, "escalationCategory", (c) => {
    const category = c
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    return out.nextAction === "human" &&
      (ESCALATION_CATEGORIES as readonly string[]).includes(category)
      ? category
      : "";
  });
  normalizeField(out, "owningRepo", normalizeOwningRepo);
  return out;
}

/** `SessionOptions.validate` for a tier: normalize leniently, then hold the result to the
 *  strict worker schema. */
export function workerValidator(tier: DispatchTier) {
  const validate = zodValidator(WORKER_OUTPUT[tier]);
  return (data: unknown) => validate(normalizeWorkerOutput(data));
}
