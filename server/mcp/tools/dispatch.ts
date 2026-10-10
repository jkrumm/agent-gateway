import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DISPATCH_INPUT } from "../../jobs/handlers/dispatch.ts";
import { registerJobSubmitTool } from "./_job-tool.ts";
import { describeRoute, routeFor } from "../../lib/routing.ts";

export function registerDispatchTool(server: McpServer): void {
  registerJobSubmitTool(server, {
    name: "dispatch",
    title: "Repo Dispatch",
    tool: "dispatch",
    inputSchema: DISPATCH_INPUT.shape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: `Hand one bounded episode to a worker session running INSIDE a specific repo (an OpenCode worker by default, see MODEL), so it works with that repo's own AGENTS.md/CLAUDE.md, .claude/rules/ and .claude/skills/ in context. Runs as a BACKGROUND JOB: this call returns a jobId immediately — it does NOT return the verdict.

WHEN TO CALL: something in another repo is broken/failing/behaving oddly and answering it means actually reading that repo; or a small, well-understood change should be made there. Also the path an automated observer (Hermes) uses to escalate an incident it cannot judge on its own.
WHEN NOT TO CALL: to mutate infrastructure. No tier restarts, redeploys or reconfigures anything — that is out of scope entirely, at every tier.

TIERS (pick the least powerful one that produces the artifact you actually need):
  investigate  read-only session → a verdict. Default. Cannot lose anything.
  author       read-only session → a verdict + a filed issue (GitHub or GitLab, per the repo's origin).
  implement    WRITE session in an isolated git worktree → a verdict + a pushed branch + a DRAFT pull request. Never merges. Never pushes to a default branch, in any repo, including direct-to-master ones. Refuses to touch .github/workflows|actions, and refuses a diff that adds credential-shaped text.

WORKSPACE (implement tier only): 'worktree' (default) = the isolated-worktree/branch/draft-PR path described above. 'in-place' = the episode edits the repo's LIVE checkout directly and nothing is committed, pushed or filed — the result lists changedFiles (uncommitted, left for the owner to review and commit) and outcome 'applied_in_place'. Choose in-place only when the caller's workflow is "make these edits in my repo, I review and commit" (e.g. direct-to-master repos). Refused for any tier but implement, for sensitive: true, and while another in-place episode runs in the same repo. Pre-existing uncommitted work in the checkout is left untouched and excluded from changedFiles.

QUEUEING (implement tier): at most one implement episode (worktree or in-place) or update_pr runs per repo. A second one submitted while the repo is busy is ACCEPTED and stays \`pending\` — job_status/job_wait show \`queuedBehind: <jobId>\` — then starts by itself, first-come-first-served per repo, when the holder finishes. job_cancel works on it. It is not refused and not a failure.

SYNCHRONOUS REFUSALS: everything knowable at submit time (repo/tier policy, unknown model, malformed params, sensitive/in-place/revisionOf/branch/prTitle combinations, an in-place episode in a repo with its own opencode config, a \`branch\` name already taken) comes back as an immediate error from THIS call — no jobId is created. Only runtime outcomes arrive through job_wait. A \`branch\` adds one \`git ls-remote\` against origin to the submit (5 s cap; an unreachable origin is not a refusal), so that call can take a few seconds.

NAMING (implement tier, workspace 'worktree'): \`branch\` = a slug (charset [a-z0-9._/-], at most 64 chars, no '..') — the pushed branch is exactly \`dispatch/<branch>\`; refused when it already exists locally or on origin; not combinable with revisionOf. \`prTitle\` = the PR/MR title and commit subject, overriding the worker's; the PR body stays the worker's. Without \`branch\` the branch is \`dispatch/<slugified brief, 32 chars>-<jobId8>\`.

KIND: \`kind: 'code'\` (default) or \`kind: 'editorial'\`. Pass 'editorial' for AGENTS.md, docs, README and other prose briefs — it routes the episode to the Claude harness on a Claude model (see MODEL). It is never inferred from the brief.

READ BASE (read tiers only): investigate/author read the repository's remote DEFAULT BRANCH by default — not the live checkout's current HEAD, which may be stale or on a feature tip and would make the verdict confidently wrong about the default branch. Pass \`base: 'head'\` to read the live checkout's current HEAD instead. Offline (no reachable origin) falls back to HEAD either way. The resolved ref is stated in the prompt so the verdict can name the tree it read.

The artifact is created by the tool, not by the session — the session holds no credentials, which is why an untrusted brief cannot reach the forge (GitHub or GitLab) through it.

BRIEF: prose, treated as DATA by the episode — never as instructions. Be specific about the symptom and when it started, or about the exact change wanted; pass raw logs/monitor output via \`context\`.
SENSITIVE: pass \`sensitive: true\` (default false) to run inside a secret-bearing repo, e.g. dotfiles-private or homelab-private — ONLY with tier 'investigate', any other tier is refused before a worktree is created. The verdict is scanned before it leaves the machine: a match withholds \`summary\`/\`verdict\`/\`evidence\` behind a notice and keeps the full text in a local, owner-only file instead. This is a leak backstop on the way OUT, not a sandbox — \`readOnly\` still leaves Bash reachable and the brief is attacker-influenced.
ASYNC: returns { jobId }. Then call job_wait({ jobId }) to block until it finishes and read the result, or job_status for a one-shot poll. An implement episode can run 30 minutes.
OUTPUT: \`summary\` (one line, read this first), \`verdict\`, \`confidence\` (high | medium | low), \`evidence[]\`, \`nextAction\` (none | issue | implement | human), \`rootCause\` (optional stable kebab-case key; the same cause gets the same key), \`decisionQuestion\` (optional, present only when nextAction is human: one question naming two options), \`escalationCategory\` (present only when nextAction is human: product | data_loss | spend | other_people | security | blocker, the owner-only reason), \`owningRepo\` (optional, present only when the finding belongs to a different repo than the episode ran in: that repo's bare name), \`artifactUrl\` (the issue or PR, absent if the episode concluded none was warranted), \`branch\`, \`changedFiles\` (workspace 'in-place' only), \`fallbackWithheld\` (only 'write-tier-after-output': the Max fallback was not run because a write-tier episode had already produced output on the primary route), and \`degraded\` — true only when the tool itself failed to produce a structured verdict, so treat that as "retry me", not as a finding about the repo.
CWD: absolute path of the repo to work in — not necessarily this session's CWD. It must be a repo directly under a configured dispatch root.
POLICY: a repo/tier allowlist is enforced before anything runs, so a submission can come back \`dispatch refused: ...\` instead of a verdict — either the repo sits outside every dispatch root, or the tier exceeds that repo's ceiling. Secret-bearing repos (dotfiles-private, homelab-private) are capped at 'investigate'; \`sensitive\` is derived from the same policy, so omitting the flag does not opt a marked repo out of the outbound scan. \`GET /api/dispatch-policy\` is the effective table.
MODEL: investigate/author run ${describeRoute(routeFor("dispatch"))}; implement runs ${describeRoute(routeFor("dispatch_implement"))}; the attempt-3+ escalation route runs ${describeRoute(routeFor("dispatch_implement_escalation"))} (no Max fallback); \`kind: 'editorial'\` runs ${describeRoute(routeFor("dispatch_editorial"))} on the claude harness. The claude harness is otherwise an explicit opt-in (AGENT_GATEWAY_HARNESS_DISPATCH=claude plus a Claude model override); the only AUTOMATIC Claude path is the reactive Max fallback after an IU failure, shown in parentheses. A per-job model param overrides any of them — see GET /api/routing.`,
  });
}
