// `kind: "editorial"` routes a dispatch episode to the Claude harness via the
// `dispatch_editorial` route key (server/lib/routing.ts), and the claude harness stays an
// explicit opt-in for every other dispatch route. Table-level checks use buildRoutingTable({})
// so a local .env override cannot leak into the expectation.

import { describe, expect, test } from "bun:test";
import {
  buildRoutingTable,
  DEEPSEEK_V41_FLASH,
  describeRoute,
  HAIKU,
  ROUTED_TOOLS,
  SONNET,
  withModel,
} from "../server/lib/routing.ts";
import {
  assertDispatchRequestAllowed,
  DISPATCH_INPUT,
  dispatchRouteKey,
} from "../server/jobs/handlers/dispatch.ts";
import { dispatchSchemaRoutes } from "../server/routes/dispatch-schema.ts";
import { routingRoutes } from "../server/routes/routing.ts";
import { makeFixture } from "./git-fixture.ts";

const { routes } = buildRoutingTable({});

describe("dispatch_editorial route", () => {
  test("is a routed tool, Sonnet on Max with the IU reverse fallback on the claude harness", () => {
    expect(ROUTED_TOOLS).toContain("dispatch_editorial");
    expect(routes.dispatch_editorial).toEqual({
      model: SONNET,
      backend: "max",
      fallback: { backend: "iu" },
      transport: "session",
      harness: "claude",
      variant: undefined,
    });
    expect(describeRoute(routes.dispatch_editorial)).toBe(
      `${SONNET} on max (fallback ${SONNET} on iu)`,
    );
  });

  test("is overridable with the usual env keys", () => {
    const overridden = buildRoutingTable({
      AGENT_GATEWAY_MODEL_DISPATCH_EDITORIAL: HAIKU,
      AGENT_GATEWAY_BACKEND_DISPATCH_EDITORIAL: "iu",
    });
    expect(overridden.routes.dispatch_editorial.model).toBe(HAIKU);
    expect(overridden.routes.dispatch_editorial.backend).toBe("iu");
    expect(overridden.overrides.filter((o) => o.tool === "dispatch_editorial")).toEqual([
      { tool: "dispatch_editorial", field: "model", value: HAIKU },
      { tool: "dispatch_editorial", field: "backend", value: "iu" },
    ]);
  });

  test("a non-Claude model override on it is normalized off Max and cannot strand an opencode id on claude", () => {
    const { routes: r, overrides } = buildRoutingTable({
      AGENT_GATEWAY_MODEL_DISPATCH_EDITORIAL: DEEPSEEK_V41_FLASH,
    });
    // deepseek-v4.1-flash is opencode-only: refused back to the editorial default.
    expect(r.dispatch_editorial.model).toBe(SONNET);
    expect(r.dispatch_editorial.harness).toBe("claude");
    expect(overrides.some((o) => o.tool === "dispatch_editorial" && o.refused)).toBe(true);
  });

  test("GET /api/routing lists it", async () => {
    const res = await routingRoutes.handle(new Request("http://localhost/api/routing"));
    const body = (await res.json()) as { routes: Record<string, { harness: string }> };
    expect(body.routes.dispatch_editorial?.harness).toBeDefined();
  });
});

describe("the claude harness is an explicit opt-in for dispatch", () => {
  test("the default dispatch routes are all opencode", () => {
    for (const key of [
      "dispatch",
      "dispatch_implement",
      "dispatch_implement_escalation",
    ] as const) {
      expect(routes[key].harness).toBe("opencode");
      expect(routes[key].model).not.toMatch(/^claude/);
    }
  });

  test("a code episode never resolves to the editorial route, at any tier", () => {
    expect(dispatchRouteKey("investigate", "code")).toBe("dispatch");
    expect(dispatchRouteKey("author", "code")).toBe("dispatch");
    expect(dispatchRouteKey("implement", "code")).toBe("dispatch_implement");
  });

  test("an editorial episode resolves to dispatch_editorial at every tier", () => {
    for (const tier of ["investigate", "author", "implement"] as const) {
      expect(dispatchRouteKey(tier, "editorial")).toBe("dispatch_editorial");
    }
  });
});

describe("`kind` param", () => {
  const base = { cwd: "/x", brief: "b" };

  test("defaults to code and accepts editorial; anything else is refused by the schema", () => {
    expect(DISPATCH_INPUT.parse(base).kind).toBe("code");
    expect(DISPATCH_INPUT.parse({ ...base, kind: "editorial" }).kind).toBe("editorial");
    expect(DISPATCH_INPUT.safeParse({ ...base, kind: "prose" }).success).toBe(false);
  });

  test("a per-job Claude model on a code route still forces the claude harness (withModel)", () => {
    expect(withModel(routes.dispatch_implement, SONNET).harness).toBe("claude");
  });

  test("an editorial in-place episode is allowed in a repo with its own opencode config; a code one is not", async () => {
    const fx = await makeFixture();
    try {
      fx.write(".opencode/plugin.js", "module.exports = () => {}\n");
      const input = (kind: "code" | "editorial") =>
        DISPATCH_INPUT.parse({
          cwd: fx.repo,
          brief: "b",
          tier: "implement",
          workspace: "in-place",
          kind,
        });
      expect(() => assertDispatchRequestAllowed(input("editorial"), false)).not.toThrow();
      expect(() => assertDispatchRequestAllowed(input("code"), false)).toThrow(
        /dispatch refused:.*\.opencode/,
      );
    } finally {
      fx.cleanup();
    }
  });
});

describe("GET /api/dispatch-schema", () => {
  test("publishes the submit-side params, including the caller-controlled naming and kind", async () => {
    const res = await dispatchSchemaRoutes.handle(
      new Request("http://localhost/api/dispatch-schema"),
    );
    const body = (await res.json()) as {
      input: { properties: Record<string, unknown>; required?: string[] };
    };
    for (const field of ["branch", "prTitle", "kind", "workspace", "revisionOf"]) {
      expect(Object.keys(body.input.properties)).toContain(field);
    }
    expect(body.input.required ?? []).not.toContain("kind");
  });
});
