import { describe, expect, test } from "bun:test";
import { aliasLegacyEnv } from "../server/lib/env-compat.ts";

describe("aliasLegacyEnv", () => {
  test("aliases a legacy key to the new prefix and reports it", () => {
    const env: Record<string, string | undefined> = { SIDECLAW_MODEL_CHECK: "m" };
    expect(aliasLegacyEnv(env)).toEqual(["SIDECLAW_MODEL_CHECK"]);
    expect(env.AGENT_GATEWAY_MODEL_CHECK).toBe("m");
  });

  test("an already-set new key wins over the legacy one", () => {
    const env: Record<string, string | undefined> = {
      SIDECLAW_JOBS_DB: "old",
      AGENT_GATEWAY_JOBS_DB: "new",
    };
    expect(aliasLegacyEnv(env)).toEqual(["SIDECLAW_JOBS_DB"]);
    expect(env.AGENT_GATEWAY_JOBS_DB).toBe("new");
  });

  test("no legacy keys → nothing reported, nothing added", () => {
    const env: Record<string, string | undefined> = { AGENT_GATEWAY_URL: "u", PATH: "/bin" };
    expect(aliasLegacyEnv(env)).toEqual([]);
    expect(Object.keys(env).sort()).toEqual(["AGENT_GATEWAY_URL", "PATH"]);
  });
});
