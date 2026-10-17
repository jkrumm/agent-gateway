// ── Prose lint — pure, deterministic findings over a draft ────────────────────────────────
//
// The `prose` job runs this before the reviewer and again on the rewrite (prose-pipeline in
// server/jobs/handlers/prose.ts). It is a code check, not a model: it names the patterns the
// writer must not leave behind, and a rewrite that comes back with MORE findings than the
// original is discarded.
//
// Language decides the rule set. English text gets the banned-lexicon and English
// negative-parallelism rules. German text gets the Nominalstil and Passivketten rules and NO
// English lexicon — English technical terms are the desired register inside German text
// (deployment, cache, PR, commit, pipeline, endpoint …), so no English-word rule ever runs on a
// German draft. A draft whose language cannot be told (no signal, or a tie) is `neutral`: only the
// language-agnostic rules run, so short code-switched copy is never read as English by default.
// Fenced code is skipped entirely (one fence parser, shared with the content-integrity gate below);
// inline code spans are reduced to one word.

export type ProseLanguage = "en" | "de" | "neutral";

export interface LintFinding {
  rule: string;
  /** 1-based line in the original text. */
  line: number;
  excerpt: string;
}

const EN_BANNED: readonly [rule: string, pattern: RegExp][] = [
  ["banned-delve", /\bdelv(e|es|ed|ing)\b/i],
  ["banned-tapestry", /\btapestry\b/i],
  ["banned-testament", /\btestament\b/i],
  ["banned-leverage", /\bleverag(e|es|ed|ing)\b/i],
  ["banned-unlock", /\bunlock(s|ed|ing)?\b/i],
  ["banned-crucial", /\bcrucial\b/i],
  ["banned-robust", /\brobust\b/i],
  ["banned-seamless", /\bseamless(ly)?\b/i],
  ["banned-ever-evolving", /\bever-evolving\b/i],
  ["banned-transformative", /\btransformative\b/i],
  ["banned-realm", /\brealms?\b/i],
  ["banned-myriad", /\bmyriad\b/i],
  ["banned-foster", /\bfoster(s|ed|ing)?\b/i],
  ["banned-pivotal", /\bpivotal\b/i],
  ["banned-vibrant", /\bvibrant\b/i],
  ["banned-meticulous", /\bmeticulous(ly)?\b/i],
  ["banned-holistic", /\bholistic\b/i],
  ["banned-game-changer", /\bgame[- ]changer\b/i],
  ["banned-utilize", /\butiliz(e|es|ed|ing)\b/i],
  ["banned-worth-noting", /\bit'?s worth noting\b/i],
  ["banned-serves-as", /\bserves as\b/i],
  ["banned-in-conclusion", /\bin conclusion\b/i],
  [
    "metaphor-landscape",
    /\b(evolving|changing|competitive|modern|current|ever-changing|rapidly changing)\s+landscape\b/i,
  ],
];

const EN_NEGATIVE_PARALLELISM: RegExp[] = [
  /\bit'?s not\b[^.!?]{1,80}?[,;—–]\s*(it'?s|but|rather)\b/i,
  /\bnot (just|only|merely|simply)\b[^.!?]{1,80}?\bbut\b/i,
];

const DE_NEGATIVE_PARALLELISM: RegExp[] = [
  /\bnicht nur\b[^.!?]{1,80}?\bsondern\b/i,
  /\bnicht\b[^.!?,]{1,60},\s*sondern\b/i,
];

const EN_SIGNIFICANCE_PARTICIPLE =
  /[,—–]\s*(highlighting|underscoring|emphasizing|emphasising|showcasing|reflecting|demonstrating|illustrating)\b/i;

const DE_PASSIVE_AUX = /\b(wird|werden|wurde|wurden|worden)\b/gi;
const DE_NOMINAL_SUFFIX = /\b\p{L}+(ung|heit|keit)(en|e|er|es|n|s)?\b/giu;
/** Per 100 words over which the -ung/-heit/-keit density is flagged. */
const NOMINAL_DENSITY_PER_100 = 8;
const NOMINAL_MIN_WORDS = 60;
const MAX_SENTENCE_WORDS = 30;
const REPEAT_JACCARD = 0.8;
const REPEAT_MIN_CONTENT_WORDS = 5;
const UNIFORM_MIN_PARAGRAPHS = 4;
const UNIFORM_MIN_MEAN_WORDS = 20;
const UNIFORM_MAX_CV = 0.15;

const EN_STOPWORDS = new Set(
  (
    "the and is of to that this with for are it be on as a we you our your not but was were " +
    "have has can from by at into more than which what how"
  ).split(" "),
);
/** Common German function words — none of them is also a frequent English word (so no "die",
 *  "hat" or "den"). */
const DE_STOPWORDS = new Set(
  (
    "der das und ist nicht mit für von ein eine auf zu dem wird sich auch im zum zur " +
    "oder aber wir ihr sie wenn dass wie bei nach aus als noch nur sind haben kann können " +
    "dann durch über vor einen einer eines des diese dieser werden wurde"
  ).split(" "),
);
const GERMAN_LETTERS = /[äöüß]/i;

const EXCERPT_CHARS = 120;

function excerpt(text: string): string {
  const t = text.trim();
  return t.length > EXCERPT_CHARS ? `${t.slice(0, EXCERPT_CHARS - 1)}…` : t;
}

function wordsOf(text: string): string[] {
  return text.match(/[\p{L}\p{N}'-]+/gu) ?? [];
}

/** Which language a draft is written in, by stopword count plus umlauts/ß (each word carrying
 *  one is a German signal). Fenced and inline code do not count. No signal or a tie is
 *  `neutral`, never English. */
export function detectLanguage(text: string): ProseLanguage {
  let en = 0;
  let de = 0;
  const prose = proseLines(text)
    .map((l) => l.text)
    .join("\n");
  for (const w of wordsOf(prose)) {
    const lower = w.toLowerCase();
    if (EN_STOPWORDS.has(lower)) en++;
    if (DE_STOPWORDS.has(lower) || GERMAN_LETTERS.test(lower)) de++;
  }
  if (de === en) return "neutral";
  return de > en ? "de" : "en";
}

interface ProseLine {
  line: number;
  text: string;
}

/** Non-code lines with their 1-based numbers. Fenced blocks are dropped (by the same parser the
 *  content gate uses); inline code spans become the word "code" so a `robust` inside backticks
 *  never fires a lexicon rule. */
function proseLines(text: string): ProseLine[] {
  const fenced = new Set<number>();
  for (const block of parseFences(text)) {
    for (let i = block.start; i <= block.end; i++) fenced.add(i);
  }
  const out: ProseLine[] = [];
  text.split("\n").forEach((raw, i) => {
    if (fenced.has(i)) return;
    out.push({ line: i + 1, text: raw.replace(/`[^`]*`/g, "code").replace(/’/g, "'") });
  });
  return out;
}

interface Sentence {
  line: number;
  text: string;
  words: string[];
}

function sentencesOf(lines: ProseLine[]): Sentence[] {
  const out: Sentence[] = [];
  for (const { line, text } of lines) {
    for (const s of text.match(/[^.!?]+[.!?]*/g) ?? []) {
      const trimmed = s.trim();
      if (!trimmed) continue;
      out.push({ line, text: trimmed, words: wordsOf(trimmed) });
    }
  }
  return out;
}

function contentWords(words: string[]): Set<string> {
  return new Set(words.map((w) => w.toLowerCase()).filter((w) => w.length >= 4));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function enSentenceFindings(s: Sentence): LintFinding[] {
  const rules: string[] = [];
  for (const [rule, pattern] of EN_BANNED) if (pattern.test(s.text)) rules.push(rule);
  if (EN_SIGNIFICANCE_PARTICIPLE.test(s.text)) rules.push("significance-participle");
  if (EN_NEGATIVE_PARALLELISM.some((p) => p.test(s.text))) rules.push("negative-parallelism");
  return rules.map((rule) => ({ rule, line: s.line, excerpt: excerpt(s.text) }));
}

function deSentenceFindings(s: Sentence): LintFinding[] {
  const rules: string[] = [];
  if (DE_NEGATIVE_PARALLELISM.some((p) => p.test(s.text))) rules.push("negative-parallelism");
  if ((s.text.match(DE_PASSIVE_AUX)?.length ?? 0) >= 2) rules.push("passive-chain");
  return rules.map((rule) => ({ rule, line: s.line, excerpt: excerpt(s.text) }));
}

const SENTENCE_RULES: Record<ProseLanguage, (s: Sentence) => LintFinding[]> = {
  en: enSentenceFindings,
  de: deSentenceFindings,
  neutral: () => [],
};

function lexiconFindings(sentences: Sentence[], language: ProseLanguage): LintFinding[] {
  return sentences.flatMap(SENTENCE_RULES[language]);
}

function nominalFinding(lines: ProseLine[]): LintFinding[] {
  const text = lines.map((l) => l.text).join(" ");
  const total = wordsOf(text).length;
  if (total < NOMINAL_MIN_WORDS) return [];
  const hits = text.match(DE_NOMINAL_SUFFIX)?.length ?? 0;
  const per100 = (hits / total) * 100;
  if (per100 <= NOMINAL_DENSITY_PER_100) return [];
  return [
    {
      rule: "nominalstil",
      line: lines[0]?.line ?? 1,
      excerpt: `${hits} of ${total} words end in -ung/-heit/-keit (${per100.toFixed(1)} per 100)`,
    },
  ];
}

function repetitionFindings(sentences: Sentence[]): LintFinding[] {
  const sets = sentences.map((s) => contentWords(s.words));
  const out: LintFinding[] = [];
  for (let j = 0; j < sentences.length; j++) {
    if (sets[j].size < REPEAT_MIN_CONTENT_WORDS) continue;
    for (let i = 0; i < j; i++) {
      if (sets[i].size < REPEAT_MIN_CONTENT_WORDS) continue;
      if (jaccard(sets[i], sets[j]) >= REPEAT_JACCARD) {
        out.push({
          rule: "repeated-sentence",
          line: sentences[j].line,
          excerpt: excerpt(sentences[j].text),
        });
        break;
      }
    }
  }
  return out;
}

const NON_PARAGRAPH = /^(#|[-*+]\s|\d+[.)]\s|\||>)/;

/** A blank line, heading, list item, table row or quote line. */
function isStructural(text: string): boolean {
  const t = text.trim();
  return !t || NON_PARAGRAPH.test(t);
}

function paragraphsOf(lines: ProseLine[]): { line: number; words: number }[] {
  const paragraphs: { line: number; words: number }[] = [];
  let current: { line: number; words: number } | null = null;
  for (const { line, text } of lines) {
    if (isStructural(text)) {
      if (current) paragraphs.push(current);
      current = null;
      continue;
    }
    if (!current) current = { line, words: 0 };
    current.words += wordsOf(text).length;
  }
  if (current) paragraphs.push(current);
  return paragraphs;
}

function uniformFinding(lines: ProseLine[]): LintFinding[] {
  const paragraphs = paragraphsOf(lines);
  if (paragraphs.length < UNIFORM_MIN_PARAGRAPHS) return [];
  const counts = paragraphs.map((p) => p.words);
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  if (mean < UNIFORM_MIN_MEAN_WORDS) return [];
  const variance = counts.reduce((a, c) => a + (c - mean) ** 2, 0) / counts.length;
  const cv = Math.sqrt(variance) / mean;
  if (cv >= UNIFORM_MAX_CV) return [];
  return [
    {
      rule: "uniform-paragraphs",
      line: paragraphs[0].line,
      excerpt: `${paragraphs.length} paragraphs of near-identical length (mean ${Math.round(mean)} words)`,
    },
  ];
}

/** Every finding for `text`, read in `language`, ordered by line. Pure and deterministic. */
export function lintProse(text: string, language: ProseLanguage): LintFinding[] {
  const lines = proseLines(text);
  // Headings, list items, table rows and quotes are fragments, not sentences: the lexicon rules
  // read them, the sentence-shape rules (length, repetition) do not.
  const sentences = sentencesOf(lines);
  const bodySentences = sentencesOf(lines.filter((l) => !isStructural(l.text)));
  const findings: LintFinding[] = [
    ...lexiconFindings(sentences, language),
    ...bodySentences
      .filter((s) => s.words.length > MAX_SENTENCE_WORDS)
      .map((s) => ({ rule: "long-sentence", line: s.line, excerpt: excerpt(s.text) })),
    ...repetitionFindings(bodySentences),
    ...uniformFinding(lines),
  ];
  if (language === "de") findings.push(...nominalFinding(lines));
  return findings.toSorted((a, b) => a.line - b.line);
}

// ── Content integrity — what a rewrite must carry over, and must not invent ───────────────
//
// The lint gate only compares findings, and lint skips fenced code, so a rewrite could drop a code
// block or a link and still pass it. A rewrite must keep every fenced block and URL of the draft
// and add none (the draft is the only source of either; a new one is injected, not written). Both
// are compared as multisets: dropping one of two identical blocks is a loss, adding a duplicate is
// an addition. There is no exemption — a visual suggestion is a one-line blockquote, not a fence.

const FENCE_OPEN = /^\s*(?:>\s*)*(`{3,}|~{3,})/;
/** Blockquote markers (`>`, `> >`) at the start of a line, with the whitespace before and between
 *  them. Needs at least one `>`, so an unquoted line keeps its indentation. */
const QUOTE_PREFIX = /^\s*(?:>[ \t]?)+/;
/** A candidate URL run: an http(s) scheme or a `www.` host (any case) up to whitespace or a
 *  quote/angle/backtick. {@link trimUrl} then decides where the URL really ends. */
// A lookbehind instead of `\b`: `_` is a word character, so `_https://…_` would never match, but a
// scheme glued to a word (`abchttps://`) is not a URL. An apostrophe is a
// valid path character (`owner's-guide`); a quote closing the span is stripped as trailing punctuation.
const URL_RUN = /(?<![A-Za-z0-9])(?:https?:\/\/|www\.)[^\s<>"`]+/gi;
/** Sentence punctuation, quotes and the emphasis markers (`*`, `_`, `~`) that can wrap a URL. */
const URL_TRAILING_PUNCTUATION = /[.,;:!?'"*_~]+$/;
const URL_PARTS = /^((?:https?:\/\/|www\.)[^/?#]*)(.*)$/is;
const LOST_EXCERPT_CHARS = 60;

interface FenceBlock {
  /** 0-based first and last line (inclusive) in the text. */
  start: number;
  end: number;
  lines: string[];
  /** False when the text ended before the closing fence. */
  closed: boolean;
}

/** The line without its blockquote markers. */
function unquote(line: string): string {
  return line.replace(QUOTE_PREFIX, "");
}

/** The fenced blocks of `text`, fence lines included. The one fence parser: a fence may sit inside
 *  a blockquote (`> ```ts`); it closes only on its opener's marker character repeated at least as
 *  many times; an unclosed fence runs to the end
 *  of the text and is reported with `closed: false`. The lint exclusion and the integrity gate both
 *  read this. */
function parseFences(text: string): FenceBlock[] {
  const blocks: FenceBlock[] = [];
  let open: { marker: string; start: number; lines: string[] } | null = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!open) {
      const marker = FENCE_OPEN.exec(raw)?.[1];
      if (marker) open = { marker, start: i, lines: [raw] };
      continue;
    }
    open.lines.push(raw);
    const t = unquote(raw).trim();
    if (!t.startsWith(open.marker) || t !== t[0].repeat(t.length)) continue;
    blocks.push({ start: open.start, end: i, lines: open.lines, closed: true });
    open = null;
  }
  if (open) {
    blocks.push({ start: open.start, end: lines.length - 1, lines: open.lines, closed: false });
  }
  return blocks;
}

/** True when `candidate` ends inside a fence that `original` did not leave open: the rest of the
 *  text would render (and be skipped by lint) as code. */
export function leftFenceOpen(original: string, candidate: string): boolean {
  const unclosed = (text: string) => parseFences(text).some((b) => !b.closed);
  return unclosed(candidate) && !unclosed(original);
}

/** A block's comparison key: blockquote markers removed, the info string dropped from the opener, trailing whitespace dropped,
 *  and the indentation common to every line removed — so the same block re-indented under a list
 *  item or relabelled ```ts → ```typescript is unchanged, while code that changes its own relative
 *  indentation is not. */
function blockKey(block: FenceBlock): string {
  const [opener, ...rest] = block.lines.map(unquote);
  const bareOpener = opener.replace(/^(\s*(?:`{3,}|~{3,})).*$/, "$1");
  const lines = [bareOpener, ...rest].map((l) => l.trimEnd());
  const indents = lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length);
  const common = indents.length > 0 ? Math.min(...indents) : 0;
  return lines
    .map((l) => l.slice(Math.min(common, l.length)))
    .join("\n")
    .trimEnd();
}

/** Where a URL run really ends: a closing bracket is kept only when it closes one opened inside the
 *  run (nested to any depth, and `[::1]` IPv6 hosts); the first unbalanced closer ends the URL, and
 *  trailing sentence punctuation is stripped. */
function trimUrl(run: string): string {
  const open = { "(": 0, "[": 0 };
  const opener: Record<string, "(" | "["> = { ")": "(", "]": "[" };
  for (let i = 0; i < run.length; i++) {
    const c = run[i];
    if (c === "(" || c === "[") open[c]++;
    const kind = opener[c];
    if (!kind) continue;
    if (open[kind] === 0) return stripTrailing(run.slice(0, i));
    open[kind]--;
  }
  return stripTrailing(run);
}

function stripTrailing(url: string): string {
  return url.replace(URL_TRAILING_PUNCTUATION, "");
}

/** The URL's comparison token: scheme and host lower-cased (they are case-insensitive), path, query
 *  and fragment exact. */
function urlToken(url: string): string {
  const parts = URL_PARTS.exec(url);
  return parts ? parts[1].toLowerCase() + parts[2] : url;
}

/** Every http(s) / `www.` URL in `text`, in order and with repeats, as comparison tokens. */
function urlsOf(text: string): string[] {
  return (text.match(URL_RUN) ?? []).map(trimUrl).filter(Boolean).map(urlToken);
}

function counts(keys: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const k of keys) out.set(k, (out.get(k) ?? 0) + 1);
  return out;
}

/** The first of `from` (in order) that `against` has fewer of than `from` does. */
function firstExcess<T>(from: T[], keyOf: (item: T) => string, against: T[]): T | undefined {
  const have = counts(against.map(keyOf));
  const seen = new Map<string, number>();
  return from.find((item) => {
    const key = keyOf(item);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n > (have.get(key) ?? 0);
  });
}

function describeBlock(block: FenceBlock): string {
  return `a fenced code block (starting "${unquote(block.lines[0]).trim().slice(0, LOST_EXCERPT_CHARS)}")`;
}

const identity = (s: string) => s;

/** What `candidate` lost from `original`: a fenced block or a URL it has fewer of than the original
 *  (one of two identical blocks gone is a loss). A URL counts as kept only as the same whole token
 *  (an extended URL is a different link). Null when everything survived. Names the first loss of
 *  each kind. */
export function lostContent(original: string, candidate: string): string | null {
  const lost: string[] = [];
  const block = firstExcess(parseFences(original), blockKey, parseFences(candidate));
  if (block) lost.push(describeBlock(block));
  const url = firstExcess(urlsOf(original), identity, urlsOf(candidate));
  if (url) lost.push(`the URL ${url}`);
  return lost.length > 0 ? lost.join(" and ") : null;
}

/** What `candidate` added that `original` does not have: a fenced block or a URL it has more of
 *  than the original (a duplicate counts). Null when nothing was added. Names the first addition of
 *  each kind. */
export function addedContent(original: string, candidate: string): string | null {
  const added: string[] = [];
  const block = firstExcess(parseFences(candidate), blockKey, parseFences(original));
  if (block) added.push(describeBlock(block));
  const url = firstExcess(urlsOf(candidate), identity, urlsOf(original));
  if (url) added.push(`the URL ${url}`);
  return added.length > 0 ? added.join(" and ") : null;
}
