// The routing table is the one place a worker's model and auth backend are decided
// (server/lib/routing.ts). These pin the owner's tiering decision and the override rules
// that keep an operator from routing a gateway id onto Max, where it cannot run.

import { describe, expect, test } from "bun:test";
import {
  buildRoutingTable,
  DEEPSEEK_FLASH,
  DEEPSEEK_PRO,
  DEEPSEEK_V41_FLASH,
  describeRoute,
  GLM_FLASH,
  HAIKU,
  logRoutingOverrides,
  logStaleQuotaEnvVars,
  ROUTED_TOOLS,
  routeFor,
  routeForReviewAngle,
  reviewAngleRouteKey,
  SONNET,
  validateModel,
  withModel,
} from "../server/lib/routing.ts";
import { parseDotEnv } from "../server/lib/load-env.ts";

/** Records calls instead of writing anywhere — matches the `{ info, warn }` shape both
 *  functions under test expect. */
function fakeLogger() {
  const info: { obj: Record<string, unknown>; msg: string }[] = [];
  const warn: { obj: Record<string, unknown>; msg: string }[] = [];
  return {
    info: (obj: Record<string, unknown>, msg: string) => info.push({ obj, msg }),
    warn: (obj: Record<string, unknown>, msg: string) => warn.push({ obj, msg }),
    calls: { info, warn },
  };
}

describe("buildRoutingTable defaults", () => {
  const { routes, overrides } = buildRoutingTable({});

  test("no overrides from an empty env", () => {
    expect(overrides).toEqual([]);
  });

  test("check, overview: Haiku on iu, Haiku on max as the reverse lane (the CLASSIFY tier), thinking capped at 2048", () => {
    for (const tool of ["check", "overview"] as const) {
      expect(routes[tool]).toEqual({
        model: HAIKU,
        backend: "iu",
        fallback: { backend: "max", model: HAIKU },
        transport: "session",
        thinkingTokens: 2048,
        harness: "claude",
        variant: undefined,
      });
    }
  });

  test("narrative, excalidraw: Sonnet on max, same model on iu as the reverse lane (the PROSE tier)", () => {
    for (const tool of ["narrative", "excalidraw"] as const) {
      expect(routes[tool]).toEqual({
        model: SONNET,
        backend: "max",
        fallback: { backend: "iu" },
        transport: "session",
        harness: "claude",
        variant: undefined,
      });
    }
  });

  test("dispatch: deepseek-v4.1-flash via opencode on iu with the Sonnet-on-max fallback (the AGENT_OC tier), variant high", () => {
    expect(routes.dispatch).toEqual({
      model: DEEPSEEK_V41_FLASH,
      backend: "iu",
      fallback: { backend: "max", model: SONNET },
      transport: "session",
      harness: "opencode",
      variant: "high",
    });
  });

  test("dispatch_implement: deepseek-v4.1-flash via opencode on iu with the Sonnet-on-max fallback (implement-tier only), variant max", () => {
    expect(routes.dispatch_implement).toEqual({
      model: DEEPSEEK_V41_FLASH,
      backend: "iu",
      fallback: { backend: "max", model: SONNET },
      transport: "session",
      harness: "opencode",
      variant: "max",
    });
  });

  test("dispatch_implement_escalation: DeepSeek-V4-Pro via opencode on iu, no Max fallback, variant max (attempt-3+ implement escalation)", () => {
    expect(routes.dispatch_implement_escalation).toEqual({
      model: DEEPSEEK_PRO,
      backend: "iu",
      fallback: null,
      transport: "session",
      harness: "opencode",
      variant: "max",
    });
  });

  test("the escalation route's model is a verified registry id, exposed at routes.dispatch_implement_escalation.model (warden's GET /api/routing path)", () => {
    const route = buildRoutingTable({}).routes.dispatch_implement_escalation;
    expect(validateModel(route.model)).toMatchObject({ ok: true, model: { id: DEEPSEEK_PRO } });
  });

  test("review (synthesis/router), otel: Sonnet on max with the quota fallback to iu (the JUDGE tier — deliberately NOT on glm, see routing.ts)", () => {
    for (const tool of ["review", "otel"] as const) {
      expect(routes[tool]).toEqual({
        model: SONNET,
        backend: "max",
        fallback: { backend: "iu" },
        transport: "session",
        harness: "claude",
        variant: undefined,
      });
    }
  });

  test("review_ocr: deepseek-v4.1-flash on iu, no fallback, over the fixed external-iu transport", () => {
    expect(routes.review_ocr).toEqual({
      model: DEEPSEEK_V41_FLASH,
      backend: "iu",
      fallback: null,
      transport: "external-iu",
      harness: "claude",
      variant: undefined,
    });
  });

  test("triage, review_router: deepseek-v4.1-flash on iu, no fallback, over the fixed iu-openai transport (the SINGLE_SHOT tier, no worker session)", () => {
    for (const tool of ["triage", "review_router"] as const) {
      expect(routes[tool]).toEqual({
        model: DEEPSEEK_V41_FLASH,
        backend: "iu",
        fallback: null,
        transport: "iu-openai",
        harness: "claude",
        variant: undefined,
      });
    }
  });

  test("adversary stays gpt-5.6-terra on iu, no fallback, over the fixed iu-openai transport", () => {
    expect(routes.adversary).toEqual({
      model: "gpt-5.6-terra",
      backend: "iu",
      fallback: null,
      transport: "iu-openai",
      harness: "claude",
      variant: undefined,
    });
  });

  test("read_image, read_drawing: gemini-3.5-flash on iu, no fallback, over the fixed iu-openai transport (the VISION tier)", () => {
    for (const tool of ["read_image", "read_drawing"] as const) {
      expect(routes[tool]).toEqual({
        model: "gemini-3.5-flash",
        backend: "iu",
        fallback: null,
        transport: "iu-openai",
        harness: "claude",
        variant: undefined,
      });
    }
  });

  test("every routed tool has a route and a gateway id never sits on max", () => {
    for (const tool of ROUTED_TOOLS) {
      const r = routes[tool];
      expect(r.model.length).toBeGreaterThan(0);
      if (r.backend === "max") expect(r.model.startsWith("claude")).toBe(true);
      if (r.fallback?.backend === "max") {
        expect((r.fallback.model ?? r.model).startsWith("claude")).toBe(true);
      }
    }
  });
});

describe("buildRoutingTable env overrides", () => {
  test("SIDECLAW_MODEL_<TOOL> replaces the model and is reported", () => {
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_MODEL_CHECK: HAIKU });
    expect(routes.check.model).toBe(HAIKU);
    expect(routes.check.backend).toBe("iu");
    expect(overrides).toEqual([{ tool: "check", field: "model", value: HAIKU }]);
  });

  test("SIDECLAW_BACKEND_<TOOL> moves a Claude route and flips the fallback direction", () => {
    const { routes } = buildRoutingTable({ SIDECLAW_BACKEND_REVIEW: "iu" });
    expect(routes.review.backend).toBe("iu");
    // The declared fallback pointed at iu — now the primary — so it is dropped, not kept
    // as a no-op hop onto the same backend.
    expect(routes.review.fallback).toBeNull();
  });

  test("a max backend on a gateway id is refused, default stays", () => {
    const { routes, overrides } = buildRoutingTable({
      SIDECLAW_MODEL_CHECK: DEEPSEEK_FLASH,
      SIDECLAW_BACKEND_CHECK: "max",
    });
    expect(routes.check.backend).toBe("iu");
    expect(overrides.find((o) => o.field === "backend")?.refused).toContain(
      "max only serves Claude ids",
    );
  });

  test("an unknown backend name is refused", () => {
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_BACKEND_OTEL: "bedrock" });
    expect(routes.otel.backend).toBe("max");
    expect(overrides[0]?.refused).toContain("unknown backend");
  });

  test("a backend override on a fixed iu-openai transport tool is refused, whatever the value", () => {
    for (const [envKey, tool] of [
      ["SIDECLAW_BACKEND_ADVERSARY", "adversary"],
      ["SIDECLAW_BACKEND_TRIAGE", "triage"],
      ["SIDECLAW_BACKEND_REVIEW_ROUTER", "review_router"],
      ["SIDECLAW_BACKEND_READ_IMAGE", "read_image"],
      ["SIDECLAW_BACKEND_READ_DRAWING", "read_drawing"],
    ] as const) {
      const { routes, overrides } = buildRoutingTable({ [envKey]: "max" });
      expect(routes[tool].backend).toBe("iu");
      expect(overrides).toEqual([
        {
          tool,
          field: "backend",
          value: "max",
          refused: expect.stringContaining("iu-openai transport"),
        },
      ]);
    }
  });

  test("a backend override on review_ocr (fixed external-iu transport) is refused, whatever the value", () => {
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_BACKEND_REVIEW_OCR: "max" });
    expect(routes.review_ocr.backend).toBe("iu");
    expect(overrides).toEqual([
      {
        tool: "review_ocr",
        field: "backend",
        value: "max",
        refused: expect.stringContaining("external-iu transport"),
      },
    ]);
  });

  test("SIDECLAW_MODEL_REVIEW_OCR replaces the model and is reported", () => {
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_MODEL_REVIEW_OCR: HAIKU });
    expect(routes.review_ocr.model).toBe(HAIKU);
    expect(overrides).toEqual([{ tool: "review_ocr", field: "model", value: HAIKU }]);
  });

  test("SIDECLAW_MODEL_TRIAGE: a verified id replaces the model, an unverified registry id is refused", () => {
    const ok = buildRoutingTable({ SIDECLAW_MODEL_TRIAGE: HAIKU });
    expect(ok.routes.triage.model).toBe(HAIKU);
    expect(ok.overrides).toEqual([{ tool: "triage", field: "model", value: HAIKU }]);

    const refused = buildRoutingTable({ SIDECLAW_MODEL_TRIAGE: "gpt-6-sol" });
    expect(refused.routes.triage.model).toBe(DEEPSEEK_V41_FLASH);
    expect(refused.overrides[0]?.refused).toContain("unverified");
  });

  test("a thinking-token override on review_ocr (fixed external-iu transport) is refused, whatever the value", () => {
    const { routes, overrides } = buildRoutingTable({
      SIDECLAW_THINKING_TOKENS_REVIEW_OCR: "4096",
    });
    expect(routes.review_ocr.thinkingTokens).toBeUndefined();
    expect(overrides).toEqual([
      {
        tool: "review_ocr",
        field: "thinkingTokens",
        value: "4096",
        refused: expect.stringContaining("session transport"),
      },
    ]);
  });

  test("a gateway model override on a max route forces iu and keeps a fixed-model fallback only", () => {
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_MODEL_REVIEW: DEEPSEEK_FLASH });
    expect(routes.review.backend).toBe("iu");
    // The backend flip is the override's most consequential side effect (metered IU instead
    // of Max), so /api/routing lists it next to the model override that caused it.
    expect(overrides).toEqual([
      { tool: "review", field: "model", value: DEEPSEEK_FLASH },
      {
        tool: "review",
        field: "backend",
        value: "iu",
        implied: expect.stringContaining(`forced by the ${DEEPSEEK_FLASH} model override`),
      },
    ]);
    // review's declared fallback is same-model onto iu; with iu now primary there is
    // nowhere Max-servable to go.
    expect(routes.review.fallback).toBeNull();
    const narrative = buildRoutingTable({ SIDECLAW_MODEL_NARRATIVE: DEEPSEEK_FLASH }).routes
      .narrative;
    expect(narrative.fallback).toBeNull();
  });

  test("whitespace-only overrides are ignored", () => {
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_MODEL_CHECK: "  " });
    expect(routes.check.model).toBe(HAIKU);
    expect(overrides).toEqual([]);
  });

  test("an unregistered model override is refused, default stays", () => {
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_MODEL_CHECK: "not-a-model" });
    expect(routes.check.model).toBe(HAIKU);
    expect(overrides).toEqual([
      {
        tool: "check",
        field: "model",
        value: "not-a-model",
        refused: expect.stringContaining("unknown model"),
      },
    ]);
  });

  test("a registered but UNVERIFIED model override is refused, default stays", () => {
    for (const id of [GLM_FLASH, "gpt-6-sol", "kimi-k2.7-code"]) {
      const { routes, overrides } = buildRoutingTable({ SIDECLAW_MODEL_DISPATCH: id });
      expect(routes.dispatch.model).toBe(DEEPSEEK_V41_FLASH);
      expect(routes.dispatch.harness).toBe("opencode");
      expect(overrides).toEqual([
        {
          tool: "dispatch",
          field: "model",
          value: id,
          refused: expect.stringContaining("unverified"),
        },
      ]);
    }
  });

  test("a verified Responses-wire (GPT) id is accepted on dispatch and keeps the opencode harness", () => {
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_MODEL_DISPATCH: "gpt-6.1-sol" });
    expect(routes.dispatch.model).toBe("gpt-6.1-sol");
    expect(routes.dispatch.harness).toBe("opencode");
    expect(routes.dispatch.variant).toBe("high");
    expect(overrides).toEqual([{ tool: "dispatch", field: "model", value: "gpt-6.1-sol" }]);
  });

  test("a GPT id on a claude-harness tool is refused — Responses-only ids have no claude -p path", () => {
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_MODEL_CHECK: "gpt-6.1-sol" });
    expect(routes.check.model).toBe(HAIKU);
    expect(routes.check.harness).toBe("claude");
    expect(overrides).toEqual([
      {
        tool: "check",
        field: "model",
        value: "gpt-6.1-sol",
        refused: expect.stringContaining("reachable only via the opencode harness"),
      },
    ]);
  });

  test("a model override without the route's variant drops it, reported as implied", () => {
    const { routes, overrides } = buildRoutingTable({
      SIDECLAW_MODEL_DISPATCH: "gemini-3.5-flash",
    });
    expect(routes.dispatch.model).toBe("gemini-3.5-flash");
    expect(routes.dispatch.variant).toBeUndefined();
    expect(overrides).toContainEqual({
      tool: "dispatch",
      field: "variant",
      value: "high",
      implied: expect.stringContaining("exposes no"),
    });
  });

  test("a variant the model does not expose is refused", () => {
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_VARIANT_DISPATCH: "ultra" });
    expect(routes.dispatch.variant).toBe("high");
    expect(overrides[0]?.refused).toContain("exposes no");
  });

  test("no route runs on GLM any more — retired 2026-09-23, the id stays only as an (unverified, hence refused) registry entry", () => {
    const { routes } = buildRoutingTable({});
    for (const route of Object.values(routes)) {
      expect(route.model).not.toBe(GLM_FLASH);
      expect(route.fallback?.model ?? "").not.toBe(GLM_FLASH);
    }
  });

  test("SIDECLAW_THINKING_TOKENS_<TOOL> replaces the tier's default and is reported", () => {
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_THINKING_TOKENS_CHECK: "4096" });
    expect(routes.check.thinkingTokens).toBe(4096);
    expect(overrides).toEqual([{ tool: "check", field: "thinkingTokens", value: "4096" }]);
  });

  test("a non-positive-integer thinking-token override is refused, default stays", () => {
    // Not `dispatch` — AGENT_OC/AGENT_OC_IMPLEMENT (2026-09-24, the opencode harness) carry
    // no `thinkingTokens` default at all (opencode's reasoning-effort knob is `variant`, not
    // this claude/gateway-only env control), so `overview` (still CLASSIFY, 2048) is the
    // still-8192-analogous session-transport tool this refusal case needs.
    for (const bad of ["0", "-8", "3.5", "not-a-number"]) {
      const { routes, overrides } = buildRoutingTable({ SIDECLAW_THINKING_TOKENS_OVERVIEW: bad });
      expect(routes.overview.thinkingTokens).toBe(2048);
      expect(overrides[0]?.refused).toContain("positive integer");
    }
  });

  test("a thinking-token override on a Claude (JUDGE/PROSE) route is applied but harmless", () => {
    // Nothing refuses it here — buildWorkerEnv is the gate that only ever exports
    // MAX_THINKING_TOKENS for a non-Claude model, so setting this on a Claude route is a
    // no-op at spawn time rather than a build-time error.
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_THINKING_TOKENS_REVIEW: "4096" });
    expect(routes.review.thinkingTokens).toBe(4096);
    expect(overrides).toEqual([{ tool: "review", field: "thinkingTokens", value: "4096" }]);
  });

  test("a thinking-token override on a fixed iu-openai transport tool is refused, whatever the value", () => {
    for (const [envKey, tool] of [
      ["SIDECLAW_THINKING_TOKENS_ADVERSARY", "adversary"],
      ["SIDECLAW_THINKING_TOKENS_TRIAGE", "triage"],
      ["SIDECLAW_THINKING_TOKENS_REVIEW_ROUTER", "review_router"],
      ["SIDECLAW_THINKING_TOKENS_READ_IMAGE", "read_image"],
      ["SIDECLAW_THINKING_TOKENS_READ_DRAWING", "read_drawing"],
    ] as const) {
      const { routes, overrides } = buildRoutingTable({ [envKey]: "4096" });
      expect(routes[tool].thinkingTokens).toBeUndefined();
      expect(overrides).toEqual([
        {
          tool,
          field: "thinkingTokens",
          value: "4096",
          refused: expect.stringContaining("session transport"),
        },
      ]);
    }
  });

  test("SIDECLAW_HARNESS_<TOOL>=claude PAIRED with a Claude model override moves dispatch onto claude and reports both", () => {
    const { routes, overrides } = buildRoutingTable({
      SIDECLAW_HARNESS_DISPATCH: "claude",
      SIDECLAW_MODEL_DISPATCH: SONNET,
    });
    expect(routes.dispatch.harness).toBe("claude");
    expect(routes.dispatch.model).toBe(SONNET);
    expect(overrides).toEqual([
      { tool: "dispatch", field: "model", value: SONNET },
      { tool: "dispatch", field: "harness", value: "claude" },
    ]);
  });

  test("SIDECLAW_HARNESS_<TOOL>=claude ALONE (default model stays deepseek-v4.1-flash) is refused — that model has no path through claude -p", () => {
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_HARNESS_DISPATCH: "claude" });
    expect(routes.dispatch.harness).toBe("opencode");
    expect(routes.dispatch.model).toBe(DEEPSEEK_V41_FLASH);
    expect(overrides).toEqual([
      {
        tool: "dispatch",
        field: "harness",
        value: "claude",
        refused: expect.stringContaining("reachable only via the opencode harness"),
      },
    ]);
  });

  test("SIDECLAW_MODEL_<TOOL>=deepseek-v4.1-flash on a claude-harness tool is refused the same way, blaming the model override instead", () => {
    const { routes, overrides } = buildRoutingTable({
      SIDECLAW_MODEL_CHECK: DEEPSEEK_V41_FLASH,
    });
    expect(routes.check.harness).toBe("claude");
    expect(routes.check.model).toBe(HAIKU); // reverted to CLASSIFY's own default
    expect(overrides).toEqual([
      {
        tool: "check",
        field: "model",
        value: DEEPSEEK_V41_FLASH,
        refused: expect.stringContaining("reachable only via the opencode harness"),
      },
    ]);
  });

  test("a Claude model override on an opencode-harness route normalizes harness back to claude — implied, not refused", () => {
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_MODEL_DISPATCH: SONNET });
    expect(routes.dispatch.model).toBe(SONNET);
    expect(routes.dispatch.harness).toBe("claude");
    expect(routes.dispatch.variant).toBeUndefined();
    expect(overrides).toEqual([
      { tool: "dispatch", field: "model", value: SONNET },
      {
        tool: "dispatch",
        field: "harness",
        value: "claude",
        implied: expect.stringContaining("it can only run on the claude harness"),
      },
    ]);
  });

  test("an unknown harness name is refused, default stays", () => {
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_HARNESS_DISPATCH: "codex" });
    expect(routes.dispatch.harness).toBe("opencode");
    expect(overrides[0]?.refused).toContain("unknown harness");
  });

  test("a harness override on a fixed iu-openai/external-iu transport tool is refused, whatever the value", () => {
    for (const [envKey, tool] of [
      ["SIDECLAW_HARNESS_ADVERSARY", "adversary"],
      ["SIDECLAW_HARNESS_TRIAGE", "triage"],
      ["SIDECLAW_HARNESS_REVIEW_OCR", "review_ocr"],
    ] as const) {
      const { routes, overrides } = buildRoutingTable({ [envKey]: "opencode" });
      expect(routes[tool].harness).toBe("claude");
      expect(overrides).toEqual([
        {
          tool,
          field: "harness",
          value: "opencode",
          refused: expect.stringContaining("transport"),
        },
      ]);
    }
  });

  test("SIDECLAW_VARIANT_<TOOL> replaces the tier's variant and is reported", () => {
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_VARIANT_DISPATCH: "none" });
    expect(routes.dispatch.variant).toBe("none");
    expect(overrides).toEqual([{ tool: "dispatch", field: "variant", value: "none" }]);
  });

  test("a variant override on a fixed iu-openai transport tool is refused, whatever the value", () => {
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_VARIANT_READ_IMAGE: "max" });
    expect(routes.read_image.variant).toBeUndefined();
    expect(overrides).toEqual([
      {
        tool: "read_image",
        field: "variant",
        value: "max",
        refused: expect.stringContaining("iu-openai transport"),
      },
    ]);
  });

  test("a variant override on a claude-harness route (review) is refused", () => {
    const { routes, overrides } = buildRoutingTable({ SIDECLAW_VARIANT_REVIEW: "max" });
    expect(routes.review.variant).toBeUndefined();
    expect(overrides).toEqual([
      {
        tool: "review",
        field: "variant",
        value: "max",
        refused: expect.stringContaining("opencode-only reasoning-effort knob"),
      },
    ]);
  });

  test("a thinking-tokens override on an opencode-harness route (dispatch) is refused", () => {
    const { routes, overrides } = buildRoutingTable({
      SIDECLAW_THINKING_TOKENS_DISPATCH: "4096",
    });
    expect(routes.dispatch.thinkingTokens).toBeUndefined();
    expect(overrides).toEqual([
      {
        tool: "dispatch",
        field: "thinkingTokens",
        value: "4096",
        refused: expect.stringContaining(
          "reasoning depth is controlled by SIDECLAW_VARIANT_DISPATCH",
        ),
      },
    ]);
  });
});

describe("per-angle review routes", () => {
  const ANGLE_KEYS = {
    "senior-dev": "review_angle_senior_dev",
    typescript: "review_angle_typescript",
    frontend: "review_angle_frontend",
    qa: "review_angle_qa",
  } as const;

  test("senior-dev, typescript and qa default to the cheap OpenCode route; frontend stays on the review route", () => {
    const { routes, overrides } = buildRoutingTable({});
    expect(overrides).toEqual([]);
    for (const key of [
      "review_angle_senior_dev",
      "review_angle_typescript",
      "review_angle_qa",
    ] as const) {
      expect(routes[key], key).toEqual({
        model: DEEPSEEK_V41_FLASH,
        backend: "iu",
        fallback: { backend: "max", model: SONNET },
        transport: "session",
        harness: "opencode",
        variant: "high",
      });
    }
    expect(routes.review_angle_frontend).toEqual(routes.review);
  });

  test("angle ids map to their key; angles without a key (and unknown ids) fall back to review", () => {
    for (const [angle, key] of Object.entries(ANGLE_KEYS)) {
      expect(reviewAngleRouteKey(angle)).toBe(key);
    }
    for (const angle of ["architect", "security", "backend", "performance", "synthesis", "nope"]) {
      expect(reviewAngleRouteKey(angle)).toBe("review");
      expect(routeForReviewAngle(angle)).toEqual(routeFor("review"));
    }
  });

  test("a model override on one angle key applies to that angle only", () => {
    const { routes, overrides } = buildRoutingTable({
      SIDECLAW_MODEL_REVIEW_ANGLE_QA: DEEPSEEK_FLASH,
    });
    expect(routes.review_angle_qa.model).toBe(DEEPSEEK_FLASH);
    expect(routes.review_angle_qa.backend).toBe("iu"); // Max cannot serve a gateway id
    expect(overrides.every((o) => o.tool === "review_angle_qa")).toBe(true);
    const defaults = buildRoutingTable({}).routes;
    expect(routes.review).toEqual(defaults.review);
    expect(routes.review_angle_frontend).toEqual(defaults.review);
    expect(routes.review_angle_senior_dev).toEqual(defaults.review_angle_senior_dev);
    expect(routes.review_angle_typescript).toEqual(defaults.review_angle_typescript);
  });

  test("an opencode-harness override on a claude angle (model + harness paired) validates and applies to that angle only", () => {
    const { routes, overrides } = buildRoutingTable({
      SIDECLAW_MODEL_REVIEW_ANGLE_FRONTEND: DEEPSEEK_V41_FLASH,
      SIDECLAW_HARNESS_REVIEW_ANGLE_FRONTEND: "opencode",
    });
    expect(routes.review_angle_frontend).toMatchObject({
      model: DEEPSEEK_V41_FLASH,
      backend: "iu",
      transport: "session",
      harness: "opencode",
    });
    expect(overrides.some((o) => o.refused)).toBe(false);
    const defaults = buildRoutingTable({}).routes;
    expect(routes.review).toEqual(defaults.review);
    expect(routes.review_angle_senior_dev).toEqual(defaults.review_angle_senior_dev);
  });

  test("an opencode-harness angle override keeps an iu->max fallback to the angle's default Claude model", () => {
    const { routes } = buildRoutingTable({
      SIDECLAW_MODEL_REVIEW_ANGLE_FRONTEND: DEEPSEEK_V41_FLASH,
      SIDECLAW_HARNESS_REVIEW_ANGLE_FRONTEND: "opencode",
    });
    expect(routes.review_angle_frontend.fallback).toEqual({ backend: "max", model: SONNET });
    // The override is scoped: the shared review route keeps the JUDGE shape.
    expect(routes.review.fallback).toEqual({ backend: "iu" });
  });

  test("the opencode-only model without its harness override is refused back to the angle's Claude default", () => {
    const { routes, overrides } = buildRoutingTable({
      SIDECLAW_MODEL_REVIEW_ANGLE_FRONTEND: DEEPSEEK_V41_FLASH,
    });
    expect(routes.review_angle_frontend).toEqual(buildRoutingTable({}).routes.review);
    expect(overrides).toEqual([
      {
        tool: "review_angle_frontend",
        field: "model",
        value: DEEPSEEK_V41_FLASH,
        refused: expect.stringContaining("SIDECLAW_HARNESS_REVIEW_ANGLE_FRONTEND=claude"),
      },
    ]);
  });

  test("an operator can pin an ANGLE_OC angle back onto the review route (Sonnet on Max) via MODEL+BACKEND+HARNESS overrides", () => {
    const { routes, overrides } = buildRoutingTable({
      SIDECLAW_MODEL_REVIEW_ANGLE_QA: SONNET,
      SIDECLAW_BACKEND_REVIEW_ANGLE_QA: "max",
      SIDECLAW_HARNESS_REVIEW_ANGLE_QA: "claude",
    });
    expect(routes.review_angle_qa).toMatchObject({
      model: SONNET,
      backend: "max",
      harness: "claude",
      variant: undefined,
    });
    expect(overrides.some((o) => o.refused)).toBe(false);
  });

  test("a variant override on an opencode angle applies; on a claude-harness angle it is refused", () => {
    const ok = buildRoutingTable({ SIDECLAW_VARIANT_REVIEW_ANGLE_QA: "none" });
    expect(ok.routes.review_angle_qa.variant).toBe("none");
    const refused = buildRoutingTable({ SIDECLAW_VARIANT_REVIEW_ANGLE_FRONTEND: "high" });
    expect(refused.routes.review_angle_frontend.variant).toBeUndefined();
    expect(refused.overrides[0]?.refused).toContain("opencode-only");
  });
});

describe("withModel", () => {
  test("no override returns the route unchanged", () => {
    const r = routeFor("dispatch");
    expect(withModel(r, undefined)).toBe(r);
    expect(withModel(r, r.model)).toBe(r);
  });

  test("a Claude override on a max route keeps max and the iu fallback", () => {
    const r = withModel(routeFor("review"), "claude-sonnet-5");
    expect(r).toEqual({
      model: "claude-sonnet-5",
      backend: "max",
      fallback: { backend: "iu" },
      transport: "session",
      thinkingTokens: undefined,
      harness: "claude",
      variant: undefined,
    });
  });

  test("a Claude override on check drops the fixed Haiku fallback — same model on max instead, thinkingTokens carries over harmlessly", () => {
    const r = withModel(routeFor("overview"), "claude-sonnet-5[1m]");
    expect(r).toEqual({
      model: "claude-sonnet-5[1m]",
      backend: "iu",
      fallback: { backend: "max" },
      transport: "session",
      thinkingTokens: 2048,
      harness: "claude",
      variant: undefined,
    });
  });

  test("withModel(claude id) forces harness claude even on an opencode-harness route", () => {
    const r = withModel(routeFor("dispatch"), "claude-sonnet-5[1m]");
    expect(r.harness).toBe("claude");
    expect(r.variant).toBeUndefined();
  });

  test("withModel(opencode-capable verified id) keeps the route's own harness and a variant the model exposes", () => {
    const r = withModel(routeFor("dispatch"), "gpt-6.1-sol");
    expect(r.harness).toBe("opencode");
    expect(r.variant).toBe("high");
  });

  test("withModel drops a variant the new model does not expose", () => {
    const r = withModel(routeFor("dispatch"), "gemini-3.5-flash");
    expect(r.harness).toBe("opencode");
    expect(r.variant).toBeUndefined();
  });

  test("withModel(claude-capable gateway id) on an opencode route forces harness claude", () => {
    const r = withModel(routeFor("dispatch"), DEEPSEEK_FLASH);
    expect(r.harness).toBe("claude");
    expect(r.variant).toBeUndefined();
  });

  test("withModel refuses (returns the route unchanged) an unknown, unverified or harness-incompatible id", () => {
    const check = routeFor("check");
    const dispatch = routeFor("dispatch");
    expect(withModel(check, "not-a-model")).toBe(check);
    expect(withModel(check, "gpt-6-sol")).toBe(check); // registered, unverified
    expect(withModel(check, "DeepSeek-V4-Pro")).toBe(check); // verified but opencode-only, check is claude
    expect(withModel(check, "gpt-6.1-sol")).toBe(check); // verified but opencode-only, check is claude
    expect(withModel(dispatch, GLM_FLASH)).toBe(dispatch);
  });

  test("a gateway override on a max route is forced onto iu with no Max-servable fallback", () => {
    const r = withModel(routeFor("review"), DEEPSEEK_FLASH);
    expect(r.backend).toBe("iu");
    expect(r.fallback).toBeNull();
  });

  test("a gateway override keeps a fixed Haiku fallback as declared", () => {
    const r = withModel({ ...routeFor("check"), model: SONNET }, DEEPSEEK_FLASH);
    expect(r).toEqual({
      model: DEEPSEEK_FLASH,
      backend: "iu",
      fallback: { backend: "max", model: HAIKU },
      transport: "session",
      thinkingTokens: 2048,
      harness: "claude",
      variant: undefined,
    });
  });

  test("transport is preserved across a model override", () => {
    const r = withModel(routeFor("adversary"), "gemini-3.5-flash");
    expect(r.transport).toBe("iu-openai");
  });
});

describe("routeFor / describeRoute", () => {
  test("routeFor hands out a copy — mutating it cannot poison the table", () => {
    const a = routeFor("check");
    a.model = "mutated";
    if (a.fallback) a.fallback.model = "mutated";
    expect(routeFor("check").model).toBe(HAIKU);
    expect(routeFor("check").fallback?.model).toBe(HAIKU);
  });

  test("describeRoute renders an opencode-harness route's harness and variant", () => {
    expect(describeRoute(routeFor("dispatch"))).toBe(
      `${DEEPSEEK_V41_FLASH} on iu via opencode (variant high) (fallback ${SONNET} on max)`,
    );
    expect(describeRoute(routeFor("dispatch_implement"))).toBe(
      `${DEEPSEEK_V41_FLASH} on iu via opencode (variant max) (fallback ${SONNET} on max)`,
    );
    expect(describeRoute(routeFor("dispatch_implement_escalation"))).toBe(
      `${DEEPSEEK_PRO} on iu via opencode (variant max)`,
    );
  });

  test("describeRoute renders the fallback model or the primary when none is fixed", () => {
    expect(describeRoute(routeFor("check"))).toBe(`${HAIKU} on iu (fallback ${HAIKU} on max)`);
    expect(describeRoute(routeFor("review"))).toBe(`${SONNET} on max (fallback ${SONNET} on iu)`);
    expect(describeRoute(routeFor("adversary"))).toBe("gpt-5.6-terra on iu");
  });
});

describe("parseDotEnv (the MCP process's .env loader)", () => {
  test("parses KEY=value, quotes, comments and blank lines the way the real file uses them", () => {
    const text = [
      "# comment",
      "",
      "PLAIN=abc",
      'DQ="with spaces"',
      "SQ='single'",
      "TRAIL=value # trailing comment",
      "export EXPORTED=1",
      "EMPTY=",
      "not a pair",
      "=nokey",
    ].join("\n");
    expect(parseDotEnv(text)).toEqual({
      PLAIN: "abc",
      DQ: "with spaces",
      SQ: "single",
      TRAIL: "value",
      EXPORTED: "1",
      EMPTY: "",
    });
  });
});

describe("logRoutingOverrides", () => {
  test("no overrides at all → logs nothing", () => {
    const log = fakeLogger();
    logRoutingOverrides(log, []);
    expect(log.calls.info).toEqual([]);
    expect(log.calls.warn).toEqual([]);
  });

  test("an applied-only override list logs info, not warn", () => {
    const log = fakeLogger();
    const overrides = [{ tool: "check", field: "model", value: HAIKU } as const];
    logRoutingOverrides(log, overrides);
    expect(log.calls.warn).toEqual([]);
    expect(log.calls.info).toEqual([
      {
        obj: { event: "routing.overrides", overrides },
        msg: "routing overrides applied at startup",
      },
    ]);
  });

  test("any refused override in the list logs warn, even alongside applied ones", () => {
    const log = fakeLogger();
    const overrides = [
      { tool: "check", field: "model", value: HAIKU } as const,
      {
        tool: "otel",
        field: "backend",
        value: "bedrock",
        refused: 'unknown backend — expected "iu" or "max"',
      } as const,
    ];
    logRoutingOverrides(log, overrides);
    expect(log.calls.info).toEqual([]);
    expect(log.calls.warn).toEqual([
      {
        obj: { event: "routing.overrides", overrides },
        msg: "routing overrides applied at startup (one or more refused)",
      },
    ]);
  });
});

describe("logStaleQuotaEnvVars", () => {
  test("none of the three set → logs nothing", () => {
    const log = fakeLogger();
    logStaleQuotaEnvVars(log, {});
    expect(log.calls.warn).toEqual([]);
  });

  test("unrelated env vars set → still logs nothing", () => {
    const log = fakeLogger();
    logStaleQuotaEnvVars(log, { SIDECLAW_MODEL_CHECK: HAIKU, GITHUB_TOKEN: "x" });
    expect(log.calls.warn).toEqual([]);
  });

  test("one stale var set → warns once, naming only what's set", () => {
    const log = fakeLogger();
    logStaleQuotaEnvVars(log, { SIDECLAW_MAX_QUOTA_CEILING: "90" });
    expect(log.calls.warn).toHaveLength(1);
    expect(log.calls.warn[0]?.obj).toEqual({
      event: "routing.stale_env",
      vars: ["SIDECLAW_MAX_QUOTA_CEILING"],
    });
  });

  test("all three stale vars set → one warn listing all three", () => {
    const log = fakeLogger();
    logStaleQuotaEnvVars(log, {
      SIDECLAW_MAX_QUOTA_CEILING: "90",
      SIDECLAW_MAX_WEEKLY_CEILING: "95",
      SIDECLAW_QUOTA_FILE_MAX_AGE_S: "600",
    });
    expect(log.calls.warn).toHaveLength(1);
    expect(log.calls.warn[0]?.obj.vars).toEqual([
      "SIDECLAW_MAX_QUOTA_CEILING",
      "SIDECLAW_MAX_WEEKLY_CEILING",
      "SIDECLAW_QUOTA_FILE_MAX_AGE_S",
    ]);
  });
});
