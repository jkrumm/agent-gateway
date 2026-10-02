// The model registry (server/lib/models.ts) is the allow-list every route is validated
// against. These pin its invariants and the registry <-> routing contract.

import { describe, expect, test } from "bun:test";
import { getModel, isVerified, listModels } from "../server/lib/models.ts";
import {
  buildRoutingTable,
  isClaudeModel,
  ROUTED_TOOLS,
  routingModels,
  validateModel,
} from "../server/lib/routing.ts";

describe("registry shape", () => {
  test("ids are unique and every entry carries limits, a dated rate with a source, and a wire/harness pairing", () => {
    const ids = listModels().map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of listModels()) {
      expect(m.limit.context, m.id).toBeGreaterThan(0);
      expect(m.limit.output, m.id).toBeGreaterThan(0);
      expect(m.limit.minOutput, m.id).toBeGreaterThan(0);
      expect(m.rate.source.length, m.id).toBeGreaterThan(0);
      expect(m.rate.date, m.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(m.verified === null || /^\d{4}-\d{2}-\d{2}$/.test(m.verified), m.id).toBe(true);
      // The anthropic wire is `claude -p`'s; opencode only speaks chat/responses.
      if (m.wire === "anthropic") expect(m.harnesses, m.id).toEqual(["claude"]);
      else expect(m.harnesses, m.id).toEqual(["opencode"]);
    }
  });

  test("GPT ids are Responses-wire and opencode-only — never chat, never claude", () => {
    const gpt = listModels().filter((m) => m.id.startsWith("gpt-"));
    expect(gpt.length).toBeGreaterThan(0);
    for (const m of gpt) {
      expect(m.wire, m.id).toBe("responses");
      expect(m.harnesses, m.id).toEqual(["opencode"]);
    }
  });

  test("only Claude ids are Max-servable", () => {
    for (const m of listModels()) {
      expect(m.backends.includes("max"), m.id).toBe(m.id.startsWith("claude"));
    }
    expect(isClaudeModel("claude-sonnet-5[1m]")).toBe(true);
    expect(isClaudeModel("DeepSeek-V4-Flash")).toBe(false);
  });

  test("the open deepseek-v4.1-flash rate conflict is recorded in its source string", () => {
    const m = getModel("deepseek-v4.1-flash");
    expect(m?.rate).toMatchObject({ in: 0.15, out: 0.6, cacheRead: 0.003 });
    expect(m?.rate.source).toContain("CONFLICTS with modelpick");
  });
});

describe("verified", () => {
  test("exactly the ids with probe evidence are verified", () => {
    const verified = listModels()
      .filter((m) => isVerified(m.id))
      .map((m) => m.id)
      .toSorted();
    expect(verified).toEqual(
      [
        "claude-haiku-4-5",
        "claude-sonnet-5",
        "claude-sonnet-5[1m]",
        "DeepSeek-V4-Flash",
        "deepseek-v4.1-flash",
        "gemini-3.5-flash",
        "gpt-5.6-terra",
        "gpt-6.1-sol", // probed 2026-10-02 over the Responses wire, one function_call
      ].toSorted(),
    );
  });

  test("an unknown id is not verified", () => {
    expect(isVerified("not-a-model")).toBe(false);
    expect(getModel("not-a-model")).toBeUndefined();
  });

  test("validateModel refuses unknown and unverified ids, accepts verified ones", () => {
    expect(validateModel("not-a-model")).toMatchObject({ ok: false });
    expect(validateModel("DeepSeek-V4-Pro")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("unverified"),
    });
    expect(validateModel("gpt-6.1-sol")).toMatchObject({ ok: true });
  });
});

describe("registry <-> routing consistency", () => {
  const { routes } = buildRoutingTable({});

  test("every default route model and fixed fallback model is registered and verified", () => {
    for (const tool of ROUTED_TOOLS) {
      const r = routes[tool];
      expect(isVerified(r.model), `${tool}: ${r.model}`).toBe(true);
      if (r.fallback?.model) {
        expect(isVerified(r.fallback.model), `${tool} fallback: ${r.fallback.model}`).toBe(true);
      }
    }
  });

  test("every session route's (model, harness) is a combination the registry allows, and max only serves Max-servable ids", () => {
    for (const tool of ROUTED_TOOLS) {
      const r = routes[tool];
      const entry = getModel(r.model);
      if (r.transport === "session") expect(entry?.harnesses, tool).toContain(r.harness);
      if (r.backend === "max") expect(entry?.backends, tool).toContain("max");
      if (r.harness === "opencode" && r.variant) expect(entry?.effort, tool).toContain(r.variant);
    }
  });

  test("routingModels exposes the whole registry (served additively by GET /api/routing)", () => {
    expect(routingModels()).toEqual(listModels());
  });
});
