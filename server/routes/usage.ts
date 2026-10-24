import { Elysia, t } from "elysia";
import {
  ACCOUNT_ID_PATTERN,
  buildAccountQuotas,
  DEFAULT_ACCOUNT,
  postedUsage,
  recordPostedUsage,
} from "../lib/claude-usage.ts";

// POST: a statusline report for one account (`account` defaults to `iu`, the pre-multi-account
// behaviour). GET: `data` is the last `iu` POST exactly as before (heartbeat / old readers);
// `accounts` is keyed by id with the CLI's numbers overridden per window by a newer POST.
export const usageRoutes = new Elysia({ prefix: "/api" })
  .post(
    "/usage",
    ({ body }) => {
      const { account = DEFAULT_ACCOUNT, ...usage } = body;
      recordPostedUsage(account, usage);
      return { ok: true } as const;
    },
    {
      body: t.Object({
        five_hour_pct: t.Number(),
        five_hour_mins_left: t.Nullable(t.Number()),
        seven_day_pct: t.Nullable(t.Number()),
        account: t.Optional(t.String({ pattern: ACCOUNT_ID_PATTERN })),
      }),
    },
  )
  .get("/usage", async () => {
    const accounts = await buildAccountQuotas();
    return { ok: true, data: postedUsage(DEFAULT_ACCOUNT), accounts } as const;
  });
