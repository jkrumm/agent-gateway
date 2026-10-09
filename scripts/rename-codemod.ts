#!/usr/bin/env bun
// sideclaw → agent-gateway rename codemod. Re-runnable: once applied, no pattern matches.
//
//   bun scripts/rename-codemod.ts [--dry]
//
// Rewrites tracked files in place and `git mv`s the three files whose name carried the old
// name. Strings that are a contract with ANOTHER repo (usage-tracker's `sideclaw-iu` sink, the
// Caddy host, a dotfiles heading) are protected until that repo's own rename lands.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DRY = process.argv.includes("--dry");

/** Never rewritten: this script, the plan, the lockfile hashes, the deprecation shim, and the
 *  env alias module whose whole job is to name the old prefix. */
const SKIP = new Set([
  "scripts/rename-codemod.ts",
  "scripts/migrate-runtime.sh",
  "server/lib/env-compat.ts",
  "tests/env-compat.test.ts",
  "bin/sideclaw",
]);
const SKIP_PREFIX = ["docs/waves/", "node_modules/"];

const CLI_VERBS =
  "check|review|dispatch|jobs|status|wait|cancel|routing|policy|health|triage|update-pr|overview|narrative";

/** Cross-repo contracts and historical identifiers: swapped for a placeholder, restored last. */
const PROTECT: RegExp[] = [
  /sideclaw-iu/g, // usage-tracker collector + its NDJSON sink (renamed with usage-tracker)
  /sideclaw\.test/g, // Caddy host (dotfiles)
  /sideclaw\.local/g, // dead localias-proxy stamp
  /sideclaw\.mini\.jkrumm\.com/g,
  /clients\/sideclaw\.py/g, // warden client (renamed with warden)
  /exclude sideclaw/g, // ~/.config/caddy-tailnet.ports line (dotfiles)
  /§Sideclaw/g, // heading in dotfiles docs
  /com\.jkrumm\.sideclaw(?!-server)/g, // the historic, BTM-denied identifier — history, not a name
];

/** Ordered; first match of a more specific rule wins by running earlier. */
const RULES: [RegExp, string][] = [
  [/X-Sideclaw-Shutdown/g, "X-Agent-Gateway-Shutdown"],
  [/x-sideclaw-shutdown/g, "x-agent-gateway-shutdown"],
  [/SIDECLAW_/g, "AGENT_GATEWAY_"],
  [/com\.jkrumm\.sideclaw-server/g, "com.jkrumm.agent-gateway"],
  [/scripts\/sideclaw-start\.sh/g, "scripts/agent-gateway-start.sh"],
  [/bin\/sideclaw\.ts/g, "bin/agw.ts"],
  [/\.local\/bin\/sideclaw/g, ".local/bin/agw"],
  [new RegExp(`\\bsideclaw (\\$\\{|--|(?:${CLI_VERBS})\\b)`, "g"), "agw $1"],
  [/(rules|policy\.rules)\.sideclaw\b/g, "$1[\"agent-gateway\"]"], // property access on a repo-keyed map
  [/sideclaw([A-Z])/g, "agentGateway$1"],
  [/SideClaw|Sideclaw/g, "Agent-Gateway"],
  [/sideclaw/g, "agent-gateway"],
];

const FILE_RENAMES: [string, string][] = [
  ["bin/sideclaw.ts", "bin/agw.ts"],
  ["com.jkrumm.sideclaw-server.plist", "com.jkrumm.agent-gateway.plist"],
  ["scripts/sideclaw-start.sh", "scripts/agent-gateway-start.sh"],
];

export function transform(text: string): string {
  const stash: string[] = [];
  let out = text;
  for (const re of PROTECT) {
    out = out.replace(re, (m) => `\u0000${stash.push(m) - 1}\u0000`);
  }
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => stash[Number(i)]!);
}

if (import.meta.main) {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: ROOT, encoding: "utf-8" }).trimEnd();

  for (const [from, to] of FILE_RENAMES) {
    const tracked = git("ls-files", from) !== "";
    if (!tracked) continue;
    console.log(`mv ${from} -> ${to}`);
    if (!DRY) git("mv", from, to);
  }

  let changed = 0;
  for (const file of git("ls-files").split("\n")) {
    if (SKIP.has(file) || SKIP_PREFIX.some((p) => file.startsWith(p))) continue;
    let before: string;
    try {
      before = readFileSync(join(ROOT, file), "utf-8");
    } catch {
      continue; // deleted in the index but present in ls-files, or unreadable
    }
    if (before.includes("\u0000")) continue; // binary
    const after = transform(before);
    if (after === before) continue;
    changed++;
    console.log(`rewrite ${file}`);
    if (!DRY) writeFileSync(join(ROOT, file), after);
  }
  console.log(`${changed} file(s) ${DRY ? "would change" : "rewritten"}`);
}
