/**
 * The harness-rendered answer (issue #20, plan t11; spec c47/h39).
 *
 * No free text reaches the caller as a checked answer. What this module
 * renders is built from the items the hand-back checker (`lib/facts.ts`)
 * accepted, and nothing else:
 *
 * - conclusions: verdicts the checker accepted, each with the fact ids it
 *   rests on, its deciding check when it is open or cannot_tell, and the
 *   alternative it names (its prediction and refuter) when there is one;
 * - open items the checker accepted, each with its deciding check;
 * - facts that were not refused: a passed fact (its quote was found in the
 *   saved result it cites, nothing more) and an unchecked fact, labelled as
 *   not checked with the reason. A passed fact that was also asked whether its
 *   quote supports its value carries a second, separate marker: the support
 *   answer in words (how much of the value the quote shows, never a number),
 *   or that it was not scored and why (decider-score plan t5, deviation d4).
 *   Neither marker says the value is true.
 *
 * Everything else the model wrote — the finish summary and the final message —
 * goes under one unchecked label ({@link UNCHECKED_HEADING}), with its
 * sentence count. A refused item is never rendered; the answer says how many
 * were left out and that check.json lists them.
 *
 * Pure: it opens no file and calls no model. `index.ts` loads the inputs and
 * writes the result.
 */

import type { FactCheck, HandbackCheck, ItemCheck } from "./facts.ts";
import type { SupportResult } from "./support.ts";

/** The heading every piece of unchecked model text sits under. */
export const UNCHECKED_HEADING = "## Unchecked: the model's own words, not checked by the harness";

/**
 * The legend line for the support marker (decider-score plan t5), written
 * under the quote-found legend when at least one shown fact carries one.
 */
export const SUPPORT_LEGEND =
  'The support mark is a second, separate check: how much of the value the quote, read on its own, shows, ' +
  'or "support not scored" when that check did not run. Neither mark means the value is true.';

const ANSWER_HEADING = "# Answer (rendered by the harness from checked items)";

export interface RenderInput {
  /** The parsed hand-back (`facts.schema.json`), as checked. */
  readonly payload: unknown;
  /** The checker's verdicts for that payload. */
  readonly check: HandbackCheck;
  /** The finish summary, unchecked. */
  readonly summary?: string;
  /** The model's final message after finish, unchecked. */
  readonly finalMessage?: string;
  /**
   * The support result per fact, aligned by position with `check.facts`
   * (`FactSupport` in lib/handback.ts); absent, or undefined at a position,
   * when the fact was not scored at all: that fact renders with the
   * quote-found marker alone.
   */
  readonly support?: ReadonlyArray<SupportResult | undefined>;
}

/**
 * Sentences in a piece of prose: a sentence ends at `.`, `!` or `?` followed
 * by whitespace, or at a line break; a piece with no letter or digit is not a
 * sentence. A dot inside a token (`1.5.2`, `walk.ts`) does not end one.
 */
export function countSentences(text: string): number {
  if (typeof text !== "string") return 0;
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((piece) => /[\p{L}\p{N}]/u.test(piece)).length;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** One line of model text, kept on one line in a markdown list item. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function quoted(text: string): string {
  return `"${oneLine(text)}"`;
}

function blockQuote(text: string): string[] {
  return text
    .trim()
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"));
}

/** Why a fact has no support score, in words for a reader who does not know how the score is made. */
const CHECK_UNAVAILABLE = "the check was unavailable";
const NOT_SCORED_PHRASES: Readonly<Record<string, string>> = {
  empty_value: "no value to check",
  empty_quote: "no quote to check",
  too_long: "value and quote too long to check",
  over_cap: "more facts than are checked per answer",
  out_of_time: "no time left for the check",
  timeout: "the check timed out",
  aborted: "the run was stopped before the check",
};

/**
 * The words for each support answer, keyed by the shipped contract's option
 * keys (deviation d4). An answer with no words here (a contract with other
 * options) is shown by its key.
 */
const ANSWER_WORDS: Readonly<Record<string, string>> = {
  all: "quote supports the value",
  mostly: "quote supports the main claim; a detail of the value is not in the quote",
  part: "quote shows only part of the value",
  little: "quote shows little of the value",
  none: "quote does not show the value",
};

/**
 * The support marker of one fact, or "" when it has none. It is a piece of
 * text of its own beside the quote-found marker, and only a fact whose quote
 * was found gets one. A scored fact shows its answer in words, never the
 * decider's probability. A result's `detail` is for check.json and is not
 * shown.
 */
function supportMark(verdict: FactCheck, support: SupportResult | undefined): string {
  if (!support || verdict.verdict !== "passed") return "";
  if (support.status === "scored" && typeof support.answer === "string" && support.answer.trim() !== "") {
    const { answer } = support;
    return Object.hasOwn(ANSWER_WORDS, answer) ? ANSWER_WORDS[answer]! : `support answer: ${answer}`;
  }
  const reason = support.status === "not_scored" ? support.reason : "";
  const phrase = Object.hasOwn(NOT_SCORED_PHRASES, reason) ? NOT_SCORED_PHRASES[reason] : CHECK_UNAVAILABLE;
  return `support not scored: ${phrase}`;
}

function factLine(raw: Record<string, unknown>, verdict: FactCheck, support?: SupportResult): string {
  const value = oneLine(str(raw.value));
  const where = verdict.source || str(raw.source);
  const state =
    verdict.verdict === "passed"
      ? "quote found in the saved result"
      : `not checked: ${verdict.reason === "partial_result" ? "the saved result is partial" : "no saved result"}`;
  const kind = verdict.source_kind ? `, ${verdict.source_kind}` : "";
  const action = raw.action === true && typeof raw.tool === "string" ? ` (action: ${raw.tool})` : "";
  const mark = supportMark(verdict, support);
  return `- ${verdict.id}: ${value}${action} — ${quoted(str(raw.quote))} (${where}${kind}; ${state}${mark ? `; ${mark}` : ""})`;
}

function alternativeLines(id: string, alternatives: Map<string, Record<string, unknown>>): string[] {
  const alt = alternatives.get(id);
  if (!alt) return [];
  return [
    `  - alternative ${id}: ${oneLine(str(alt.text))}`,
    `    - predicts: ${oneLine(str(alt.predicts))}`,
    `    - refuted by: ${oneLine(str(alt.refuted_by))}`,
  ];
}

function accepted<T extends ItemCheck>(items: readonly T[], position: number): boolean {
  return items[position]?.outcome === "accepted";
}

/** The answer, as markdown, from accepted items only. */
export function renderAnswer(input: RenderInput): string {
  const payload = asRecord(input.payload);
  const { check } = input;
  const rawFacts = asArray(payload.facts).map(asRecord);
  const rawVerdicts = asArray(payload.verdicts).map(asRecord);
  const rawOpen = asArray(payload.open_items).map(asRecord);
  const alternatives = new Map<string, Record<string, unknown>>();
  for (const alt of asArray(payload.alternatives).map(asRecord)) {
    const id = str(alt.id);
    if (id && !alternatives.has(id)) alternatives.set(id, alt);
  }

  // The checker gives one verdict per payload item, in payload order.
  const conclusions: string[] = [];
  rawVerdicts.forEach((raw, position) => {
    if (!accepted(check.verdicts, position)) return;
    const basis = asArray(raw.basis).map(str).filter(Boolean);
    const verdict = str(raw.verdict);
    const tail = [
      basis.length ? `rests on ${basis.join(", ")}` : "",
      verdict === "open" || verdict === "cannot_tell" ? `deciding check: ${oneLine(str(raw.check))}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    conclusions.push(`- ${check.verdicts[position].id} [${verdict}] ${oneLine(str(raw.text))}${tail ? ` (${tail})` : ""}`);
    const alt = str(raw.alternative);
    if (alt) conclusions.push(...alternativeLines(alt, alternatives));
  });

  const open: string[] = [];
  rawOpen.forEach((raw, position) => {
    if (!accepted(check.open_items, position)) return;
    open.push(`- ${check.open_items[position].id}: ${oneLine(str(raw.text))} (deciding check: ${oneLine(str(raw.check))})`);
  });

  const facts: string[] = [];
  let supportShown = false;
  rawFacts.forEach((raw, position) => {
    const verdict = check.facts[position];
    if (!verdict || verdict.verdict === "refused") return;
    const support = input.support?.[position];
    if (supportMark(verdict, support)) supportShown = true;
    facts.push(factLine(raw, verdict, support));
  });

  const refused =
    check.facts.filter((f) => f.verdict === "refused").length +
    check.verdicts.filter((v) => v.outcome === "refused").length +
    check.open_items.filter((v) => v.outcome === "refused").length;

  const lines: string[] = [ANSWER_HEADING, ""];
  if (conclusions.length + open.length + facts.length === 0) {
    lines.push("No fact or conclusion passed the check.", "");
  }
  if (conclusions.length) lines.push("## Conclusions", "", ...conclusions, "");
  if (open.length) lines.push("## Open items", "", ...open, "");
  if (facts.length) {
    lines.push(
      "## Facts",
      "",
      "A fact marked \"quote found\" means its quote is in the saved result it cites; it does not mean the value is true.",
      "",
      ...(supportShown ? [SUPPORT_LEGEND, ""] : []),
      ...facts,
      "",
    );
  }
  if (refused > 0) {
    lines.push(
      `${refused} item${refused === 1 ? " was" : "s were"} refused by the check and ${refused === 1 ? "is" : "are"} ` +
        "not part of this answer (check.json lists each with its fix).",
      "",
    );
  }

  const summary = str(input.summary).trim();
  const finalMessage = str(input.finalMessage).trim();
  lines.push(UNCHECKED_HEADING, "");
  if (!summary && !finalMessage) lines.push("- none", "");
  if (summary) {
    const n = countSentences(summary);
    lines.push(`Finish summary (${n} sentence${n === 1 ? "" : "s"}):`, "", ...blockQuote(summary), "");
  }
  if (finalMessage) {
    const n = countSentences(finalMessage);
    lines.push(`Final message (${n} sentence${n === 1 ? "" : "s"}):`, "", ...blockQuote(finalMessage), "");
  }
  return lines.join("\n");
}
