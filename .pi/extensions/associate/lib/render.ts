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

import { parseSourceRef } from "./facts.ts";
import type { FactCheck, HandbackCheck, ItemCheck } from "./facts.ts";
import type { StrictDecision, StrictFact } from "./strict.ts";
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

/**
 * The conclusion lines of the verdicts `idAt` names (it returns the id of a
 * verdict that is shown, undefined for one that is not). Shared by both
 * renderings so the style stays one.
 */
function conclusionLines(
  rawVerdicts: readonly Record<string, unknown>[],
  alternatives: Map<string, Record<string, unknown>>,
  idAt: (position: number) => string | undefined,
): string[] {
  const conclusions: string[] = [];
  rawVerdicts.forEach((raw, position) => {
    const id = idAt(position);
    if (id === undefined) return;
    const basis = asArray(raw.basis).map(str).filter(Boolean);
    const verdict = str(raw.verdict);
    const tail = [
      basis.length ? `rests on ${basis.join(", ")}` : "",
      verdict === "open" || verdict === "cannot_tell" ? `deciding check: ${oneLine(str(raw.check))}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    conclusions.push(`- ${id} [${verdict}] ${oneLine(str(raw.text))}${tail ? ` (${tail})` : ""}`);
    const alt = str(raw.alternative);
    if (alt) conclusions.push(...alternativeLines(alt, alternatives));
  });
  return conclusions;
}

/** The open-item lines of the items `idAt` names. */
function openLines(rawOpen: readonly Record<string, unknown>[], idAt: (position: number) => string | undefined): string[] {
  const open: string[] = [];
  rawOpen.forEach((raw, position) => {
    const id = idAt(position);
    if (id === undefined) return;
    open.push(`- ${id}: ${oneLine(str(raw.text))} (deciding check: ${oneLine(str(raw.check))})`);
  });
  return open;
}

function alternativesOf(payload: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const alternatives = new Map<string, Record<string, unknown>>();
  for (const alt of asArray(payload.alternatives).map(asRecord)) {
    const id = str(alt.id);
    if (id && !alternatives.has(id)) alternatives.set(id, alt);
  }
  return alternatives;
}

/** The unchecked section: the model's own words under one label, with sentence counts. */
function uncheckedLines(rawSummary: unknown, rawFinal: unknown): string[] {
  const lines: string[] = [];
  const summary = str(rawSummary).trim();
  const finalMessage = str(rawFinal).trim();
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
  return lines;
}

/** The answer, as markdown, from accepted items only. */
export function renderAnswer(input: RenderInput): string {
  const payload = asRecord(input.payload);
  const { check } = input;
  const rawFacts = asArray(payload.facts).map(asRecord);
  const rawVerdicts = asArray(payload.verdicts).map(asRecord);
  const rawOpen = asArray(payload.open_items).map(asRecord);
  const alternatives = alternativesOf(payload);

  // The checker gives one verdict per payload item, in payload order.
  const conclusions = conclusionLines(rawVerdicts, alternatives, (position) =>
    accepted(check.verdicts, position) ? check.verdicts[position].id : undefined,
  );
  const open = openLines(rawOpen, (position) => (accepted(check.open_items, position) ? check.open_items[position].id : undefined));

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

  lines.push(...uncheckedLines(input.summary, input.finalMessage));
  return lines.join("\n");
}

// ============================================================ the strict answer

/**
 * The answer under strict facts (plan t6; spec c1, c6, c7, c35, h11), from the
 * strict check result directly. The answer section holds one entry per fact
 * whose outcome is `pass` or `keep_marked`, in the model's order, each with how
 * to check it again: its kind, the command, the result file and lines, and the
 * evidence as copied by the harness, byte for byte. Dropped, returned and
 * not-judged items are counted, never shown as items. The model's summary and
 * final message appear only under the unchecked heading, after the answer
 * section. "Checked" means the evidence was found where the pointer said, and
 * "judged" means the decider answered how much of the value the evidence shows;
 * neither says the value is correct.
 */
export const STRICT_LEGEND =
  "Each item below was checked by the harness: its evidence was copied from a saved result, or its quote was found in one. " +
  "An item the decider judged shows the decider's option. Run the command in \"how to check\" to see the evidence again; " +
  "none of this makes a value correct.";

export interface StrictRenderInput {
  /** The parsed hand-back, as given. */
  readonly payload: unknown;
  /** What `runStrict` decided (lib/strict.ts). */
  readonly decision: StrictDecision;
  /** accuracy.json `strict.mark_text`: written beside a kept-marked item. */
  readonly markText: string;
  /** The finish summary, unchecked. */
  readonly summary?: string;
  /** The model's final message after finish, unchecked. */
  readonly finalMessage?: string;
  /**
   * For an old-shape fact (a quote, no pointer) that passed: the command and
   * result file of the call it cites in this run (`renderCommand`), or
   * undefined when none is known.
   */
  readonly legacy?: (source: string) => { command: string; result_file?: string } | undefined;
}

/** The shortest backtick fence that cannot be closed by anything in `text` (at least three). */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** `text` as a markdown code span that cannot be closed by anything in it. */
export function codeSpan(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(longest + 1);
  const pad = /^[` ]|[` ]$/.test(text) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

const COPIED_TEXT_CAP = 200;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function strictFactLines(
  raw: Record<string, unknown>,
  fact: StrictFact,
  markText: string,
  legacy: StrictRenderInput["legacy"],
): string[] {
  const evidence = fact.evidence;
  const given = typeof raw.value === "string" && raw.value !== "" ? oneLine(raw.value) : null;
  let value = given;
  if (value === null) {
    const copied = oneLine(evidence?.quote ?? str(raw.quote));
    value = copied.length > COPIED_TEXT_CAP ? `${copied.slice(0, COPIED_TEXT_CAP)}... (the whole copied text is under result)` : copied;
  }
  const source = str(raw.source);
  const parsed = parseSourceRef(source);
  const label = parsed.ok ? parsed.label : null;
  const out: string[] = [`**${fact.id}:** ${value}`, ""];

  // kind
  const stated = fact.kind_stated;
  const option = fact.judge?.judged ? fact.judge.option : null;
  const based = fact.based_on.length > 0 ? fact.based_on.join(", ") : "";
  let kind: string;
  if (label !== null && !evidence) {
    kind = `not checked directly: it rests on a labelled run (${label}) whose result was not read here`;
  } else if (fact.judge === null || option === null) {
    kind = fact.kind_checked === "direct" && stated !== "direct" ? `direct (stated ${stated}; the copied text shows the value)` : "direct";
  } else if (stated === "derived") {
    kind = `derived (from ${based || "no listed fact"}; the decider answered ${option})`;
  } else {
    kind = `llm (judged by the decider: ${option})`;
  }
  out.push(`- kind: ${kind}`);

  // how to check
  let command: string | undefined;
  let resultFile: string | undefined;
  if (evidence) {
    command = evidence.command;
    resultFile = evidence.result_file;
  } else if (label === null && legacy) {
    const found = legacy(source);
    command = found?.command;
    resultFile = found?.result_file;
  }
  if (command !== undefined) out.push(`- how to check: ${codeSpan(command)}`);
  if (label !== null && evidence) {
    out.push(`- run: it rests on the labelled run ${label}; its saved result was read here`);
  }
  if (evidence) {
    const [first, last] = evidence.lines;
    out.push(`- result: ${codeSpan(evidence.result_file)}, ${first === last ? `line ${first}` : `lines ${first} to ${last}`}`);
  } else if (resultFile !== undefined) {
    out.push(`- result: ${codeSpan(resultFile)}, the quote as the model gave it, found in it`);
  } else if (label === null) {
    out.push(`- result: the saved result of ${source}, the quote as the model gave it, found in it`);
  }
  if (fact.strict_outcome === "keep_marked") {
    out.push(`- marked: ${markText} (the decider answered ${fact.judge?.option ?? "an option that keeps it marked"})`);
  }
  const copied = evidence?.quote ?? (typeof raw.quote === "string" ? raw.quote : "");
  if (copied !== "") {
    const fence = fenceFor(copied);
    out.push("", `${fence}text`, copied, fence);
  }
  out.push("");
  return out;
}

/** The answer under strict facts, as markdown. */
export function renderStrictAnswer(input: StrictRenderInput): string {
  const payload = asRecord(input.payload);
  const { decision } = input;
  const rawFacts = asArray(payload.facts).map(asRecord);
  const rawVerdicts = asArray(payload.verdicts).map(asRecord);
  const rawOpen = asArray(payload.open_items).map(asRecord);
  const alternatives = alternativesOf(payload);
  const shown = (o: string) => o === "pass" || o === "keep_marked";

  const conclusions = conclusionLines(rawVerdicts, alternatives, (position) => {
    const item = decision.items.verdicts[position];
    return item && item.strict_outcome === "pass" ? item.id : undefined;
  });
  const open = openLines(rawOpen, (position) => {
    const item = decision.items.open_items[position];
    return item && item.strict_outcome === "pass" ? item.id : undefined;
  });
  const facts: string[] = [];
  let shownFacts = 0;
  rawFacts.forEach((raw, position) => {
    const fact = decision.facts[position];
    if (!fact || !shown(fact.strict_outcome)) return;
    shownFacts += 1;
    facts.push(...strictFactLines(raw, fact, input.markText, input.legacy));
  });

  const lines: string[] = [ANSWER_HEADING, ""];
  if (conclusions.length + open.length + shownFacts === 0) {
    lines.push("No fact or conclusion is in the answer.", "");
  }
  if (conclusions.length) lines.push("## Conclusions", "", ...conclusions, "");
  if (open.length) lines.push("## Open items", "", ...open, "");
  if (shownFacts > 0) lines.push("## Facts", "", STRICT_LEGEND, "", ...facts);

  // What is not in the answer, each only when non-zero.
  const reasons = Object.entries(decision.drop_reasons).map(([reason, n]) => `${n} ${reason}`);
  if (decision.dropped.length > 0) {
    lines.push(
      `${plural(decision.dropped.length, "item was", "items were")} dropped (${reasons.join(", ")}); ` +
        "dropped.json in the export lists each with its reason and fix.",
      "",
    );
  }
  if (decision.returned.length > 0) {
    const n = decision.returned.length;
    lines.push(`${plural(n, "item was", "items were")} returned and not answered again; ${n === 1 ? "it is" : "they are"} not in this answer.`, "");
  }
  const notJudged = [
    ...decision.facts.filter((f) => f.strict_outcome === "not_judged").map((f) => f.judge?.reason ?? "not_judged"),
    ...[...decision.items.verdicts, ...decision.items.open_items].filter((i) => i.strict_outcome === "not_judged").map(() => "basis_not_judged"),
  ];
  if (notJudged.length > 0) {
    const counted = new Map<string, number>();
    for (const reason of notJudged) counted.set(reason, (counted.get(reason) ?? 0) + 1);
    const why = [...counted].map(([reason, n]) => `${n} ${reason}`).join(", ");
    lines.push(`${plural(notJudged.length, "item was", "items were")} not judged (${why}); ${notJudged.length === 1 ? "it is" : "they are"} not in this answer.`, "");
  }

  lines.push(...uncheckedLines(input.summary, input.finalMessage));
  return lines.join("\n");
}
