# Backlog — improvements pending

Owner-approved items waiting for a structured improvement wave. Each row says what, why, and who
consumes it. A wave that takes one moves it into `docs/waves/PLAN.md` and deletes it here.

## Authored `question` on `needs_you` agents and human-queue asks

Approved 2026-10-18. An agent row in `needs_you` and every human-queue ask carry an optional
`question`: one authored sentence ending in `?`, at most 80 characters, naming what the human must
decide ("Merge the basalt 2.22 bump into argo?"), not the task title.

- **Why:** argo's Agents page and Home inbox derive the card title today
  (`apps/dashboard/src/lib/question-copy.ts`: the ask's first sentence if it is a question, else
  `{stem}: {subject}?`). Design reviews across argo Waves 26–29 read the derived form as an
  instruction with a question mark; the derivation has hit its ceiling and only the asking agent
  knows the real question.
- **Consumer:** argo reads it already, `authoredQuestion(a['question'])` / `item.question` in
  `apps/dashboard/src/features/agents/model.ts`; absent or blank falls back to the derived rule,
  so shipping it is additive.
- **Shape:** the agent sets it when it enters `needs_you` or files an ask (the ask CLI / MCP gets a
  `question` argument), the agents overview API passes it through, and the long ask stays as the
  evidence. Pair with warden's `question` on `needs_decision` (its `docs/BACKLOG.md`) so both
  producers follow one contract.
- **Bigger frame:** the owner wants this folded into a real structure-and-maturity pass on
  agent-gateway, not a one-field patch.
