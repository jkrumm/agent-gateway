import { Elysia } from "elysia";
import { routingModels, routingTable } from "../lib/routing.ts";

// The effective per-tool `{ model, backend, fallback }` table (server/lib/routing.ts) plus
// every AGENT_GATEWAY_MODEL_*/AGENT_GATEWAY_BACKEND_*/AGENT_GATEWAY_THINKING_TOKENS_* override that was
// applied or refused, and the model registry (`models` — additive; server/lib/models.ts).
// Read-only; what an operator checks after flipping an env var and
// running `make reload`.

export const routingRoutes = new Elysia({ prefix: "/api" }).get("/routing", () => {
  const { routes, overrides } = routingTable();
  return { ok: true as const, routes, overrides, models: routingModels() };
});
