// The live-feedback round of the `prose` job (server/jobs/handlers/prose.ts): verdictFirst, the
// no-invented-content rule, the fenced CONTEXT block, format mirroring, per-call cost and the
// per-medium note. Same adapter-injection shape as tests/prose.test.ts — no IU call.

import { describe, expect, test } from "bun:test";
import {
  PROSE_INPUT,
  runProsePipeline,
  type ProseDeps,
  type ProseReview,
} from "../server/jobs/handlers/prose.ts";
import { usageCostUsd } from "../server/lib/models.ts";

const REVIEW: ProseReview = {
  scores: {
    verdict_first: 2,
    structure: 3,
    no_repetition: 4,
    concision: 3,
    precision: 4,
    clarity: 3,
    visual_fit: 2,
    naturalness: 3,
    engagement: 3,
  },
  notes: [
    { criterion: "verdict_first", note: "The outcome arrives late." },
    { criterion: "precision", note: "Name the number." },
  ],
  visualSuggestions: [],
};

const DRAFT = "The pipeline runs nightly. It takes eight minutes.";
const MODELS = { writer: "claude-opus-5-5", reviewer: "deepseek-v4.1-flash" };

interface Capture {
  reviewPrompt: string;
  reviewVerdictFirst: boolean | undefined;
  system: string;
  writerPrompt: string;
}

function harness(over: Partial<ProseDeps> = {}) {
  const seen: Capture = {
    reviewPrompt: "",
    reviewVerdictFirst: undefined,
    system: "",
    writerPrompt: "",
  };
  const base: ProseDeps = {
    loadVoice: async () => "## Voice\n\nVerdict first.",
    review: async ({ model }) => ({ data: REVIEW, model }),
    write: async () => ({ text: "The pipeline runs nightly and takes eight minutes." }),
    ...over,
  };
  // Capture what each call was given, on top of whatever behaviour the test overrides.
  const deps: ProseDeps = {
    ...base,
    review: async (args) => {
      seen.reviewPrompt = args.prompt;
      seen.reviewVerdictFirst = args.verdictFirst;
      return base.review(args);
    },
    write: async (args) => {
      seen.system = args.system;
      seen.writerPrompt = args.prompt;
      return base.write(args);
    },
  };
  return { deps, seen };
}

const params = (over: Record<string, unknown> = {}) =>
  PROSE_INPUT.parse({ text: DRAFT, medium: "article", ...over });

describe("verdictFirst", () => {
  test("defaults to true: the writer leads with the verdict and the reviewer scores it", async () => {
    const { deps, seen } = harness();
    const out = await runProsePipeline(params(), MODELS, deps);
    expect(seen.reviewVerdictFirst).toBe(true);
    expect(seen.system).toContain("Verdict first");
    expect(seen.system).toContain("- verdict_first:");
    expect(seen.reviewPrompt).toContain("- verdict_first:");
    expect(out.review.scores.verdict_first).toBe(2);
  });

  test("false: the writer keeps the author's order and the reviewer skips verdict_first", async () => {
    const { deps, seen } = harness();
    await runProsePipeline(params({ verdictFirst: false }), MODELS, deps);
    expect(seen.reviewVerdictFirst).toBe(false);
    expect(seen.system).toContain("Keep the author's section order");
    expect(seen.system).toContain("Do not hoist a recommendation");
    expect(seen.system).not.toContain("- verdict_first:");
    expect(seen.reviewPrompt).toContain("criteria → candidates → verdict");
    expect(seen.reviewPrompt).not.toContain("- verdict_first:");
  });

  test("false: a verdict_first score or note the reviewer returns anyway is stripped", async () => {
    const { deps } = harness();
    const out = await runProsePipeline(params({ verdictFirst: false }), MODELS, deps);
    expect("verdict_first" in out.review.scores).toBe(false);
    expect(out.review.notes).toEqual([{ criterion: "precision", note: "Name the number." }]);
  });

  test("false: the writer is not shown a verdict_first reviewer note", async () => {
    const { deps, seen } = harness();
    await runProsePipeline(params({ verdictFirst: false }), MODELS, deps);
    expect(seen.writerPrompt).toContain("Name the number.");
    expect(seen.writerPrompt).not.toContain("The outcome arrives late.");
  });
});

describe("the writer's hard rules", () => {
  test("no invented content, whatever the parameters", async () => {
    for (const over of [{}, { verdictFirst: false }]) {
      const { deps, seen } = harness();
      await runProsePipeline(params(over), MODELS, deps);
      expect(seen.system).toContain("add nothing that is not in the source");
      expect(seen.system).toContain(
        "recommendation, verdict, call to action, next step, claim or fact",
      );
      expect(seen.system).toContain('"observed twice" must not become "tried twice"');
      expect(seen.system).toContain("names no single pick, the rewrite names none");
    }
  });

  test("explicit brief instructions override the voice guide's defaults", async () => {
    const { deps, seen } = harness();
    await runProsePipeline(params({ brief: "Keep it formal." }), MODELS, deps);
    expect(seen.system).toContain(
      "Explicit instructions in the BRIEF override this voice guide's defaults",
    );
  });

  test("the system prompt never carries the brief, the context or the draft", async () => {
    const { deps, seen } = harness();
    await runProsePipeline(params({ brief: "BRIEF-MARK", context: "CONTEXT-MARK" }), MODELS, deps);
    for (const mark of ["BRIEF-MARK", "CONTEXT-MARK", DRAFT]) {
      expect(seen.system).not.toContain(mark);
    }
  });

  test("the reviewer is told to flag invented content and never to suggest adding it", async () => {
    const { deps, seen } = harness();
    await runProsePipeline(params(), MODELS, deps);
    expect(seen.reviewPrompt).toContain("invented_content");
    expect(seen.reviewPrompt).toContain("Never suggest adding a recommendation");
  });
});

describe("context", () => {
  test("reaches reviewer and writer in its own nonce-fenced, read-only block", async () => {
    const { deps, seen } = harness();
    await runProsePipeline(
      params({ context: "Section 3 of 5: the TLDR says Postgres." }),
      MODELS,
      deps,
    );
    for (const prompt of [seen.reviewPrompt, seen.writerPrompt]) {
      const begin =
        /<<<CONTEXT_([0-9a-f]{12})_BEGIN>>>\nSection 3 of 5: the TLDR says Postgres\.\n<<<CONTEXT_\1_END>>>/;
      const nonce = begin.exec(prompt)?.[1];
      expect(nonce).toBeDefined();
      expect(prompt).toContain(`<<<DRAFT_${nonce}_BEGIN>>>`);
      expect(prompt).toContain("read-only");
      expect(prompt).toContain("never quote it into your output");
      expect(prompt.indexOf("<<<CONTEXT_")).toBeLessThan(prompt.lastIndexOf("<<<DRAFT_"));
      expect(prompt.lastIndexOf("END OF DATA")).toBeGreaterThan(prompt.indexOf("_END>>>"));
    }
  });

  test("no block and no label when there is no context", async () => {
    const { deps, seen } = harness();
    await runProsePipeline(params(), MODELS, deps);
    expect(seen.reviewPrompt).not.toContain("<<<CONTEXT_");
    expect(seen.writerPrompt).not.toContain("<<<CONTEXT_");
    expect(seen.writerPrompt).not.toContain("CONTEXT block below");
  });

  test("is capped at 8000 characters", () => {
    expect(() => params({ context: "x".repeat(8000) })).not.toThrow();
    expect(() => params({ context: "x".repeat(8001) })).toThrow();
  });

  test("a URL the writer copies from the context is an addition and the rewrite is discarded", async () => {
    const { deps } = harness({
      write: async () => ({ text: "Runs nightly, see https://context.example/doc for more." }),
    });
    const out = await runProsePipeline(
      params({ context: "Docs: https://context.example/doc" }),
      MODELS,
      deps,
    );
    expect(out.kept).toBe("original");
    expect(out.keptReason).toContain("https://context.example/doc");
  });
});

describe("format mirroring", () => {
  const HTML = "<h2>Pipeline</h2><p>The pipeline runs nightly. It takes eight minutes.</p>";

  test("a markdown draft is a markdown job", async () => {
    const { deps, seen } = harness();
    const out = await runProsePipeline(params(), MODELS, deps);
    expect(out.format).toBe("markdown");
    expect(seen.system).toContain("The draft is Markdown");
    expect(seen.system).toContain("> [visual: <kind>");
    expect(seen.writerPrompt).toContain("Format: markdown.");
  });

  test("an html draft is an html job with comment placeholders and no markdown", async () => {
    const { deps, seen } = harness({
      write: async () => ({
        text: "<h2>Pipeline</h2><p>It runs nightly and takes eight minutes.</p>",
      }),
    });
    const out = await runProsePipeline(params({ text: HTML }), MODELS, deps);
    expect(out.format).toBe("html");
    expect(out.kept).toBe("rewrite");
    expect(seen.system).toContain("The draft is HTML");
    expect(seen.system).toContain("<!-- visual: <kind> — <what it shows> -->");
    expect(seen.system).toContain("never a markdown blockquote");
    expect(seen.system).not.toContain("The draft is Markdown");
    expect(seen.writerPrompt).toContain("Format: html.");
    expect(seen.reviewPrompt).toContain("Format: html.");
  });

  test("an html rewrite with a markdown visual blockquote is discarded", async () => {
    const { deps } = harness({
      write: async () => ({
        text: "<p>It runs nightly.</p>\n> [visual: diagram — the nightly flow]",
      }),
    });
    const out = await runProsePipeline(params({ text: HTML }), MODELS, deps);
    expect(out.kept).toBe("original");
    expect(out.text).toBe(HTML);
    expect(out.keptReason).toContain("markdown `> [visual:` line");
  });

  test("an html rewrite with a markdown table or heading is discarded", async () => {
    for (const bad of ["<p>x</p>\n\n| a | b |\n|---|---|\n| 1 | 2 |", "<p>x</p>\n\n## Heading"]) {
      const { deps } = harness({ write: async () => ({ text: bad }) });
      const out = await runProsePipeline(params({ text: HTML }), MODELS, deps);
      expect(out.kept).toBe("original");
      expect(out.keptReason).toContain("markdown");
    }
  });

  test("an html draft rewritten as markdown is discarded", async () => {
    const { deps } = harness({
      write: async () => ({ text: "## Pipeline\n\nIt runs nightly and takes eight minutes." }),
    });
    const out = await runProsePipeline(params({ text: HTML }), MODELS, deps);
    expect(out.kept).toBe("original");
    expect(out.keptReason).toMatch(/from html to markdown|markdown heading|markdown table/);
  });

  test("an html rewrite that drops an href URL is discarded", async () => {
    const draft = '<p>See <a href="https://example.com/docs">the docs</a>. It runs nightly.</p>';
    const { deps } = harness({ write: async () => ({ text: "<p>It runs nightly.</p>" }) });
    const out = await runProsePipeline(params({ text: draft }), MODELS, deps);
    expect(out.kept).toBe("original");
    expect(out.keptReason).toContain("https://example.com/docs");
  });
});

describe("mediumNote", () => {
  const NOTES: Record<string, string> = {
    docs: "Options as lists, reference tone, headings for scanning.",
    article: "Narrative paragraphs; the h-level sections are kept.",
    landing: "Short, benefit-first lines.",
    ui: "Labels and actions, nothing more.",
    vault: "Telegraphic bullets are allowed.",
    briefing: "Bold-lead bullets.",
    chat: "Short answer first.",
  };

  test.each(Object.entries(NOTES))(
    "%s: the note is in the output and in the writer prompt",
    async (medium, note) => {
      const { deps, seen } = harness();
      const out = await runProsePipeline(params({ medium }), MODELS, deps);
      expect(out.mediumNote).toBe(note);
      expect(seen.system).toContain(`Medium (${medium}): ${note}`);
    },
  );
});

describe("usage and cost", () => {
  const usage = (over: Record<string, number | null> = {}) => ({
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    reasoningTokens: 0,
    totalTokens: 1_100_000,
    cacheReadTokens: 0,
    costUsd: null,
    ...over,
  });

  test("both calls are priced from the registry rates and summed", async () => {
    const { deps } = harness({
      review: async ({ model }) => ({ data: REVIEW, model, usage: usage() }),
      write: async () => ({ text: "Runs nightly.", usage: usage() }),
    });
    const out = await runProsePipeline(params(), MODELS, deps);
    // claude-opus-5-5: $4 in / $20 out per MTok. deepseek-v4.1-flash is priced from its rate too.
    expect(out.usageByCall.writer?.costUsd).toBeCloseTo(4 + 2, 6);
    expect(out.usageByCall.reviewer?.costUsd).not.toBeNull();
    expect(out.usage.costUsd).toBeCloseTo(
      (out.usageByCall.writer?.costUsd ?? 0) + (out.usageByCall.reviewer?.costUsd ?? 0),
      6,
    );
    expect(out.usage.inputTokens).toBe(2_000_000);
    expect(out.usage.totalTokens).toBe(2_200_000);
  });

  test("a cost the gateway reported wins over the computed one", async () => {
    const { deps } = harness({
      review: async ({ model }) => ({ data: REVIEW, model, usage: usage({ costUsd: 0.0123 }) }),
    });
    const out = await runProsePipeline(params(), MODELS, deps);
    expect(out.usageByCall.reviewer?.costUsd).toBe(0.0123);
  });

  test("a call without usage is null and the total covers the other", async () => {
    const { deps } = harness({
      write: async () => ({ text: "Runs nightly.", usage: usage() }),
    });
    const out = await runProsePipeline(params(), MODELS, deps);
    expect(out.usageByCall.reviewer).toBeNull();
    expect(out.usage.costUsd).toBe(out.usageByCall.writer?.costUsd ?? -1);
  });

  test("no usage at all: null calls and a zero total with no cost", async () => {
    const { deps } = harness();
    const out = await runProsePipeline(params(), MODELS, deps);
    expect(out.usageByCall.writer).toBeNull();
    expect(out.usageByCall.reviewer).toBeNull();
    expect(out.usage).toMatchObject({ totalTokens: 0, costUsd: null });
  });

  test("the writer's usage is priced even when the rewrite is discarded", async () => {
    const { deps } = harness({
      write: async () => ({ text: "We delve into a crucial robust topic.", usage: usage() }),
    });
    const out = await runProsePipeline(params(), MODELS, deps);
    expect(out.kept).toBe("original");
    expect(out.usageByCall.writer?.costUsd).toBeCloseTo(6, 6);
  });
});

describe("usageCostUsd", () => {
  test("uncached input at the input rate, output and thinking at the output rate", () => {
    // claude-opus-5-5: in 4, out 20.
    expect(
      usageCostUsd("claude-opus-5-5", {
        inputTokens: 500_000,
        outputTokens: 50_000,
        reasoningTokens: 50_000,
      }),
    ).toBeCloseTo(2 + 2, 6);
  });

  test("cache reads bill at the registry cache rate when it has one", () => {
    // deepseek-v4.1-flash carries an explicit cacheRead rate in the registry.
    const full = usageCostUsd("deepseek-v4.1-flash", { inputTokens: 1_000_000, outputTokens: 0 });
    const cached = usageCostUsd("deepseek-v4.1-flash", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    });
    expect(full).not.toBeNull();
    expect(cached).not.toBeNull();
    expect(cached as number).toBeLessThan(full as number);
  });

  test("a registry entry with no cache rate bills cache reads at 0.1x the input rate", () => {
    // claude-opus-5-5 has none: 1M fully cached = 0.1 * $4.
    expect(
      usageCostUsd("claude-opus-5-5", {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
      }),
    ).toBeCloseTo(0.4, 6);
  });

  test("an unregistered model has no computed cost", () => {
    expect(usageCostUsd("not-a-model", { inputTokens: 10, outputTokens: 10 })).toBeNull();
  });
});
