#!/usr/bin/env bun
// Rewrites the `providers` block of a v2-schema opencode.json from the model registry
// (server/lib/models.ts), so the interactive config (dotfiles config/opencode/opencode.json) never
// drifts from what agent-gateway routes. Everything else in the file is left untouched.
//
//   bun scripts/sync-opencode-config.ts <path to opencode.json>
//
// Every registered opencode-capable model is listed (verified or not — interactive use may try an
// unverified id; the agw server config lists only verified ones). Keys and base URLs are
// `{env:…}` placeholders, never literals. `iu-anthropic` appends `/v1` to IU_ANTHROPIC_BASE,
// which `oc` exports without it.

import { readFileSync, writeFileSync } from "node:fs";
import { listModels, type ModelWire } from "../server/lib/models.ts";
import { opencodeV2ModelRow } from "../server/mcp/opencode-server.ts";

const PROVIDERS: Record<ModelWire, { id: string; package: string; name: string; baseURL: string }> =
  {
    chat: {
      id: "iu",
      package: "aisdk:@ai-sdk/openai-compatible",
      name: "IU unified endpoint (OpenAI route, Chat Completions)",
      baseURL: "{env:IU_OPENAI_BASE}",
    },
    responses: {
      id: "iu-responses",
      package: "aisdk:@ai-sdk/openai",
      name: "IU unified endpoint (OpenAI route, Responses)",
      baseURL: "{env:IU_OPENAI_BASE}",
    },
    anthropic: {
      id: "iu-anthropic",
      package: "aisdk:@ai-sdk/anthropic",
      name: "IU unified endpoint (native Anthropic route)",
      baseURL: "{env:IU_ANTHROPIC_BASE}/v1",
    },
  };

const path = Bun.argv[2];
if (!path) {
  console.error("usage: bun scripts/sync-opencode-config.ts <opencode.json>");
  process.exit(2);
}

const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const models = listModels().filter((m) => m.harnesses.includes("opencode"));
config.providers = Object.fromEntries(
  (Object.keys(PROVIDERS) as ModelWire[]).map((wire) => {
    const p = PROVIDERS[wire];
    return [
      p.id,
      {
        package: p.package,
        name: p.name,
        settings: { baseURL: p.baseURL, apiKey: "{env:IU_KEY}" },
        models: Object.fromEntries(
          models.filter((m) => m.wire === wire).map((m) => [m.id, opencodeV2ModelRow(m)]),
        ),
      },
    ];
  }),
);
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
console.log(`wrote ${models.length} models to ${path}`);
