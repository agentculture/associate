/**
 * The hand-back checker (issue #20, t10): is each fact tied to the walk entry
 * it cites, does each action fact name a call that really happened, does each
 * verdict rest on what it says, and what are the counts?
 *
 * A pure library. Its inputs are the parsed hand-back payload
 * (`facts.schema.json`), the walk entries and the saved result texts keyed by
 * walk id; callers load files (`lib/results.ts`), this module opens none and
 * calls no model. The quote check is `lib/matcher.ts`'s `checkQuote`, the same
 * function the model's quote-check tool uses. Every setting comes from
 * `accuracy.json` through the `ContractAccuracy` argument: the minimum quote
 * length, the source-kind table, and the mapping from the reasons below to the
 * contract's check ids. No check id is written in this file.
 *
 * Facts, one at a time (a refused fact never changes another fact's verdict):
 *   1. The source reference is parsed by pattern: an optional run label, then a
 *      walk id. One containing `/` or `\` is refused (`source_path`) and any
 *      other non-matching one (`source_malformed`) before any saved result is
 *      looked up. A labelled reference resolves only inside that run (a prior
 *      run from --continue-from, or a child run); it never falls back to the
 *      current run. An unlabelled reference resolves in the current run and is
 *      flagged (`ambiguous_reference`) when a prior run has the same id.
 *   2. An action fact (`action: true`) must name its `tool`, cite an entry of
 *      that tool, and that entry must not have ended in an error or refusal:
 *      no `error` on the entry and a saved result that is not a JSON object
 *      with `ok: false` (owned tools report their own failures that way).
 *   3. The quote is matched against the cited entry's saved text. No saved
 *      text: unchecked. An entry marked `partial` holds only part of the
 *      result, so a fact citing it is unchecked unless it fails for a reason
 *      the text cannot change (a short quote, a literal outside the quote).
 *      A fact value that is a literal must occur inside the quote: a string with
 *      no whitespace once trimmed (an identifier, a path), a JSON number or a
 *      JSON boolean. A number is written as `String(n)` writes it (ECMAScript
 *      Number::toString, the same text JSON.stringify gives): the shortest
 *      decimal that reads back as the same double, no `.0` on an
 *      integer-valued number (7.0 is "7"), "0" for -0, exponent form below
 *      1e-6 and from 1e21 ("1e-7", "1e+21"). A boolean is "true" or "false".
 *      Null, objects, arrays and non-finite numbers are not literals.
 *      `check.py` `literal_of` writes the same text (shared `literal_cases`).
 *
 * A broken contract fails closed: a `min_quote_length` that is not a positive
 * integer (missing, null, zero, negative, a fraction, a string, a boolean, an
 * array or object; 8.0 counts as 8) refuses every fact as a short quote before
 * its source is looked up, with the contract value named in the flag detail
 * and the fix, so no fact can pass on it. Verdicts then follow the usual rules
 * (a verdict resting on a refused fact is refused).
 *
 * Children: a child that is not an object, or whose label is not a run label
 * (a string matching the label pattern), is skipped, never thrown on. No check
 * id fits a malformed child, so it is skipped without a flag; it is simply not
 * listed under `children`, and a fact citing its label is refused as an
 * unknown or malformed source like any other.
 *
 * Source kind and first-hand: the kind is the contract table's entry for the
 * cited entry's tool (else the entry's harness-written `source_kind`). Agent
 * and memory kinds are second-hand: they are another model's words or a
 * remembered claim. One exception, `delegate_status`: its result is the
 * harness's own JSON, where `final_reply` is the delegated model's account and
 * every other field (outcome, merge, merge_reason, tests) was measured by the
 * harness. A fact quoting it is first-hand when its quote is still found in the
 * saved text with the `final_reply` string emptied; a quote reaching into
 * `final_reply`, or a result that is not such JSON, is second-hand.
 *
 * Verdicts (first failing rule wins): a basis id naming no fact of the payload
 * (`unknown_fact`); a basis fact that was refused (`basis_refused`); supported
 * or refuted with an empty basis (`no_basis`) or with unread items
 * (`verdict_with_unread`); open or cannot_tell with no deciding check
 * (`open_without_check`); and for the closing verdict (the one marked
 * `closing`, else the last), supported or refuted with no first-hand basis
 * fact (`closing_second_hand`). An open item without a check is refused
 * (`open_without_check`). "cannot_tell" with a named check is accepted.
 *
 * Counts (`report.schema.json`): facts made, checked (passed + refused),
 * passed, refused, unchecked, the same per source kind (a fact whose source did
 * not resolve has no kind and is counted only in the totals); conclusions made,
 * supported, refuted and open (open and cannot_tell); statements (verdicts and
 * open items) made and those whose basis names no fact of the payload; a flag
 * per refusal and per flag-only finding; `python_recheck_ran` false (this is
 * the extension side). Child runs are checked as their own hand-backs and
 * listed under `children`, never added into this run's counts.
 */

import { checkQuote, type NearestSpan } from "./matcher.ts";
import type { ContractAccuracy, SourceKind } from "./contract.ts";

/** One run's walk entries and saved result texts (walk id -> text). */
export interface RunData {
  readonly entries: readonly unknown[];
  readonly results: Readonly<Record<string, string>>;
}

/** Everything one hand-back check reads. */
export interface HandbackInput extends RunData {
  /** The parsed hand-back (`facts.schema.json`). */
  readonly payload: unknown;
  /** Prior runs loaded with --continue-from, by run label. */
  readonly prior_runs?: Readonly<Record<string, RunData>>;
  /** Child and delegated runs: citable by label, reported on their own. */
  readonly children?: readonly ChildRun[];
}

export interface ChildRun extends HandbackInput {
  readonly label: string;
}

export type FactVerdict = "passed" | "refused" | "unchecked";

/** Every reason this checker can give; each maps to a check id in `accuracy.json`. */
export const CHECKER_REASONS = [
  "source_unknown",
  "source_malformed",
  "source_path",
  "quote_absent",
  "quote_short",
  "literal_not_in_quote",
  "action_tool_missing",
  "action_wrong_tool",
  "action_failed",
  "unknown_fact",
  "basis_refused",
  "no_basis",
  "verdict_with_unread",
  "open_without_check",
  "closing_second_hand",
  "ambiguous_reference",
] as const;

export type CheckerReason = (typeof CHECKER_REASONS)[number];
export type UncheckedReason = "no_saved_text" | "partial_result";

export interface FactCheck {
  readonly id: string;
  readonly source: string;
  /** The run label the reference named, or null for the current run. */
  readonly run: string | null;
  readonly verdict: FactVerdict;
  readonly reason: CheckerReason | UncheckedReason | null;
  /** The contract check id of a refusal, else null. */
  readonly check: string | null;
  /** How to fix a refusal, else null. */
  readonly fix: string | null;
  readonly nearest: NearestSpan | null;
  readonly source_kind: SourceKind | null;
  readonly first_hand: boolean | null;
}

export interface ItemCheck {
  readonly id: string;
  readonly outcome: "accepted" | "refused";
  readonly reason: CheckerReason | null;
  readonly check: string | null;
  readonly fix: string | null;
}

export interface FactCounts {
  made: number;
  checked: number;
  passed: number;
  refused: number;
  unchecked: number;
}

export interface ReportFlag {
  readonly check: string;
  readonly detail: string;
  readonly ref?: string;
}

export interface HandbackReport {
  readonly facts: FactCounts;
  readonly conclusions: { made: number; supported: number; refuted: number; open: number };
  readonly statements: { made: number; without_fact: number };
  readonly by_source_kind: Record<SourceKind, FactCounts>;
  readonly flags: ReportFlag[];
  readonly python_recheck_ran: boolean;
  readonly children: Array<{ label: string; report: HandbackReport }>;
}

export interface HandbackCheck {
  /** True when no fact, verdict or open item was refused. Flags alone do not refuse. */
  readonly accepted: boolean;
  readonly facts: FactCheck[];
  readonly verdicts: ItemCheck[];
  readonly open_items: ItemCheck[];
  readonly report: HandbackReport;
}

const SOURCE_KINDS: readonly SourceKind[] = ["file", "tool", "web", "memory", "agent", "harness"];
/** Kinds that are another model's words or a remembered claim, not a measurement. */
const SECOND_HAND_KINDS: ReadonlySet<SourceKind> = new Set<SourceKind>(["agent", "memory"]);
/** The tool whose result mixes harness-measured fields with the child's own words. */
const DELEGATE_STATUS_TOOL = "delegate_status";
/**
 * The result fields that hold the child's own words: its final message, and the
 * rendered answer (which carries its finish summary and that message).
 */
const CHILD_ACCOUNT_KEYS: readonly string[] = ["final_reply", "answer"];

const REFERENCE = /^(?:([A-Za-z0-9_-]+):)?(w[1-9][0-9]*)$/;
const LABEL = /^[A-Za-z0-9_-]+$/;

interface FixContext {
  tool?: string;
  entryTool?: string;
  /** The contract's minimum quote length, as text, when the contract is broken. */
  contract?: string;
}

const FIXES: Record<CheckerReason, (ctx: FixContext) => string> = {
  source_unknown: () =>
    "cite a walk id that the walk recorded, exactly as the harness line on that tool result showed it; " +
    "for a prior or child run, prefix the run label that run was given (label:wN)",
  source_malformed: () => "write the source as a walk id (wN) or a run label and a walk id (label:wN)",
  source_path: () =>
    "name the source by walk id (wN or label:wN), never by a file path; the harness maps the id to its saved result",
  quote_absent: () =>
    "copy the quote word for word from the saved result of the entry you cite (the nearest match is shown), " +
    "or cite the entry that holds it",
  quote_short: ({ contract }) =>
    contract !== undefined
      ? `no quote can be checked: the harness contract is broken (accuracy.json min_quote_length is ${contract}, ` +
        "not a positive integer); report this to the operator rather than retrying"
      : "quote more of the saved result: a quote this short matches almost anything",
  literal_not_in_quote: () => "choose a quote that contains the fact's value exactly as written",
  action_tool_missing: () => "an action fact must name the tool whose call it says happened (tool)",
  action_wrong_tool: ({ tool, entryTool }) =>
    `cite the entry of the ${tool ?? "named"} call that did it; the cited entry is a ${entryTool ?? "different"} call` +
    " — if no such call happened, do not report the action",
  action_failed: ({ tool }) =>
    `the cited ${tool ?? "tool"} call ended in an error or refusal; report that it failed, not that it happened`,
  unknown_fact: () => "list in basis only the ids of facts given in this hand-back",
  basis_refused: () => "fix or drop the refused facts this verdict rests on, then restate the verdict",
  no_basis: () => "list the facts a supported or refuted verdict rests on, or mark it open or cannot_tell with a check",
  verdict_with_unread: () =>
    "read what is listed as unread before deciding, or mark the verdict open or cannot_tell with the check that would decide it",
  open_without_check: () => "name the check that would decide it (what to read or run, and what result would settle it)",
  closing_second_hand: () =>
    "back the closing verdict with at least one first-hand fact (a file read, a tool or command result, or a " +
    "delegate_status harness field) — a child's reply or a memory record alone does not close it",
  ambiguous_reference: () => "prefix the run label when citing a prior run's entry (label:wN)",
};

type Parsed = { ok: true; label: string | null; id: string } | { ok: false; reason: "source_path" | "source_malformed" };

/** Parse a source reference: an optional run label and a walk id, never a path. */
export function parseSourceRef(ref: unknown): Parsed {
  if (typeof ref !== "string") return { ok: false, reason: "source_malformed" };
  if (ref.includes("/") || ref.includes("\\")) return { ok: false, reason: "source_path" };
  const m = REFERENCE.exec(ref);
  if (!m) return { ok: false, reason: "source_malformed" };
  return { ok: true, label: m[1] ?? null, id: m[2] };
}

interface Entry {
  readonly id: string;
  readonly tool: string;
  readonly source_kind?: unknown;
  readonly partial?: unknown;
  readonly error?: unknown;
}

function isEntry(line: unknown): line is Entry {
  if (!line || typeof line !== "object") return false;
  const e = line as Record<string, unknown>;
  return typeof e.id === "string" && /^w[1-9][0-9]*$/.test(e.id) && typeof e.tool === "string";
}

function indexEntries(entries: unknown): Map<string, Entry> {
  const map = new Map<string, Entry>();
  if (!Array.isArray(entries)) return map;
  for (const line of entries) if (isEntry(line)) map.set(line.id, line);
  return map;
}

function savedText(results: Readonly<Record<string, string>>, id: string): string | null {
  if (!results || typeof results !== "object" || !Object.hasOwn(results, id)) return null;
  const text = results[id];
  return typeof text === "string" ? text : null;
}

function kindOf(entry: Entry, accuracy: ContractAccuracy): SourceKind | null {
  const table = accuracy.source_kinds ?? {};
  if (Object.hasOwn(table, entry.tool)) return table[entry.tool];
  const own = entry.source_kind;
  return typeof own === "string" && (SOURCE_KINDS as readonly string[]).includes(own) ? (own as SourceKind) : null;
}

/** True when the saved result is a JSON object reporting `ok: false`. */
function reportsFailure(text: string | null): boolean {
  if (text === null) return false;
  try {
    const parsed = JSON.parse(text) as unknown;
    return !!parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).ok === false;
  } catch {
    return false;
  }
}

/** Collect every child-account field (key and text) anywhere in a parsed result. */
function findChildAccounts(value: unknown, out: Map<string, [string, string]>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) findChildAccounts(item, out);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (CHILD_ACCOUNT_KEYS.includes(key) && typeof item === "string") {
      const encoded = `${JSON.stringify(key)}:${JSON.stringify(item)}`;
      out.set(encoded, [key, item]);
    } else {
      findChildAccounts(item, out);
    }
  }
}

/**
 * The delegate_status saved text with the child's own words emptied, or null
 * when the text is not JSON carrying them in the encoding it was written.
 */
function harnessPart(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const accounts = new Map<string, [string, string]>();
  findChildAccounts(parsed, accounts);
  let out = text;
  for (const [encoded, [key]] of accounts) {
    if (!text.includes(encoded)) return null;
    out = out.split(encoded).join(`${JSON.stringify(key)}:""`);
  }
  return out;
}

function isFirstHand(
  kind: SourceKind | null,
  entry: Entry,
  quote: string,
  text: string | null,
  minQuoteLength: number,
): boolean | null {
  if (kind === null) return null;
  if (entry.tool === DELEGATE_STATUS_TOOL) {
    if (text === null) return false;
    const part = harnessPart(text);
    return part !== null && checkQuote(quote, null, part, minQuoteLength).verdict === "passed";
  }
  return !SECOND_HAND_KINDS.has(kind);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The literal a fact value must show inside its quote, or null when it is not a literal. */
export function literalOf(value: unknown): string | null {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed !== "" && !/[ \t\n\r\f\v]/.test(trimmed) ? trimmed : null;
}

/** True for a usable minimum quote length: a positive integer (8.0 is 8). */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** How a contract value is named in a refusal: the same text `check.py` writes. */
function contractValueText(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return literalOf(value) ?? "not a finite number";
  if (typeof value === "string") return JSON.stringify(value);
  return Array.isArray(value) ? "an array" : "an object";
}

/** A child run the checker can read: an object whose label is a run label. */
function isCheckableChild(child: unknown): child is ChildRun {
  if (!child || typeof child !== "object" || Array.isArray(child)) return false;
  const label = (child as { label?: unknown }).label;
  return typeof label === "string" && LABEL.test(label);
}

function emptyCounts(): FactCounts {
  return { made: 0, checked: 0, passed: 0, refused: 0, unchecked: 0 };
}

function countFact(counts: FactCounts, verdict: FactVerdict): void {
  counts.made += 1;
  if (verdict === "passed") counts.passed += 1;
  if (verdict === "refused") counts.refused += 1;
  if (verdict === "unchecked") counts.unchecked += 1;
  if (verdict !== "unchecked") counts.checked += 1;
}

/** Check one hand-back against its walk and saved results. */
export function checkHandback(input: HandbackInput, accuracy: ContractAccuracy): HandbackCheck {
  const mapping = accuracy.refusal_checks ?? {};
  const checkFor = (reason: CheckerReason): string | null =>
    Object.hasOwn(mapping, reason) ? mapping[reason] : null;
  const rawMinimum: unknown = accuracy.min_quote_length;
  const contractBroken = !isPositiveInteger(rawMinimum);
  const minQuoteLength = isPositiveInteger(rawMinimum) ? rawMinimum : 0;
  const contractText = contractBroken ? contractValueText(rawMinimum) : undefined;

  const current: RunData = { entries: input.entries, results: input.results };
  const currentIndex = indexEntries(current.entries);

  // Other runs a reference may name, by label. A label used by both a prior
  // run and a child is ambiguous and resolves to neither.
  const priorRuns = input.prior_runs ?? {};
  // A child that is not an object or has no run label is skipped (no check id fits, so no flag).
  const children = (Array.isArray(input.children) ? input.children : []).filter(isCheckableChild);
  const others = new Map<string, { run: RunData; index: Map<string, Entry> } | null>();
  for (const label of Object.keys(priorRuns)) {
    const run = priorRuns[label];
    others.set(label, { run, index: indexEntries(run.entries) });
  }
  for (const child of children) {
    others.set(child.label, others.has(child.label) ? null : { run: child, index: indexEntries(child.entries) });
  }
  const priorIndexes = Object.keys(priorRuns).map((label) => others.get(label)?.index ?? new Map<string, Entry>());

  const payload = asRecord(input.payload);
  const flags: ReportFlag[] = [];
  const flag = (reason: CheckerReason, itemId: string, ref?: string, note?: string) => {
    const check = checkFor(reason);
    if (check === null) return;
    const detail = note === undefined ? `${itemId}: ${reason}` : `${itemId}: ${reason} (${note})`;
    const out: { check: string; detail: string; ref?: string } = { check, detail };
    if (ref !== undefined && parseSourceRef(ref).ok) out.ref = ref;
    flags.push(out);
  };

  // --- facts ---------------------------------------------------------------
  const facts: FactCheck[] = [];
  for (const raw of asArray(payload.facts)) {
    const fact = asRecord(raw);
    const id = str(fact.id);
    const source = str(fact.source);
    const quote = str(fact.quote);
    const base = { id, source, run: null as string | null, nearest: null, source_kind: null, first_hand: null };
    const refuse = (
      reason: CheckerReason,
      extra: Partial<FactCheck> = {},
      ctx: FixContext = {},
      note?: string,
    ): FactCheck => {
      flag(reason, id, source, note);
      return { ...base, verdict: "refused", reason, check: checkFor(reason), fix: FIXES[reason](ctx), ...extra };
    };

    if (contractText !== undefined) {
      const note = `accuracy.json min_quote_length is ${contractText}, not a positive integer`;
      facts.push(refuse("quote_short", {}, { contract: contractText }, note));
      continue;
    }

    const parsed = parseSourceRef(fact.source);
    if (!parsed.ok) {
      facts.push(refuse(parsed.reason));
      continue;
    }
    let run: RunData;
    let index: Map<string, Entry>;
    if (parsed.label === null) {
      run = current;
      index = currentIndex;
      if (priorIndexes.some((prior) => prior.has(parsed.id))) flag("ambiguous_reference", id, source);
    } else {
      const other = others.get(parsed.label);
      if (!other) {
        facts.push(refuse("source_unknown", { run: parsed.label }));
        continue;
      }
      run = other.run;
      index = other.index;
    }
    const entry = index.get(parsed.id);
    if (!entry) {
      facts.push(refuse("source_unknown", { run: parsed.label }));
      continue;
    }

    const text = savedText(run.results, entry.id);
    const kind = kindOf(entry, accuracy);
    const located = {
      run: parsed.label,
      source_kind: kind,
      first_hand: isFirstHand(kind, entry, quote, text, minQuoteLength),
    };

    if (fact.action === true) {
      const tool = typeof fact.tool === "string" && fact.tool !== "" ? fact.tool : undefined;
      if (tool === undefined) {
        facts.push(refuse("action_tool_missing", located));
        continue;
      }
      if (entry.tool !== tool) {
        facts.push(refuse("action_wrong_tool", located, { tool, entryTool: entry.tool }));
        continue;
      }
      if (entry.error !== undefined || reportsFailure(text)) {
        facts.push(refuse("action_failed", located, { tool }));
        continue;
      }
    }

    const match = checkQuote(quote, literalOf(fact.value), text, minQuoteLength);
    const textIndependent = match.reason === "quote_short" || match.reason === "literal_not_in_quote";
    if (match.verdict === "unchecked") {
      facts.push({ ...base, ...located, verdict: "unchecked", reason: "no_saved_text", check: null, fix: null });
    } else if (entry.partial === true && !textIndependent) {
      facts.push({ ...base, ...located, verdict: "unchecked", reason: "partial_result", check: null, fix: null });
    } else if (match.verdict === "refused") {
      facts.push(refuse(match.reason as CheckerReason, { ...located, nearest: match.nearest }));
    } else {
      facts.push({ ...base, ...located, verdict: "passed", reason: null, check: null, fix: null });
    }
  }

  // --- verdicts and open items ---------------------------------------------
  const factById = new Map<string, FactCheck>();
  for (const f of facts) if (!factById.has(f.id)) factById.set(f.id, f);

  const verdictItems = asArray(payload.verdicts).map(asRecord);
  const markedClosing = verdictItems.findIndex((v) => v.closing === true);
  const closingIndex = markedClosing >= 0 ? markedClosing : verdictItems.length - 1;

  const itemRefuse = (id: string, reason: CheckerReason): ItemCheck => {
    flag(reason, id);
    return { id, outcome: "refused", reason, check: checkFor(reason), fix: FIXES[reason]({}) };
  };
  const accept = (id: string): ItemCheck => ({ id, outcome: "accepted", reason: null, check: null, fix: null });
  const hasCheck = (item: Record<string, unknown>) => typeof item.check === "string" && item.check.trim() !== "";

  let withoutFact = 0;
  const conclusions = { made: 0, supported: 0, refuted: 0, open: 0 };
  const verdicts: ItemCheck[] = verdictItems.map((item, position) => {
    const id = str(item.id);
    const verdict = str(item.verdict);
    const basis = asArray(item.basis).map(str);
    const decided = verdict === "supported" || verdict === "refuted";
    conclusions.made += 1;
    if (verdict === "supported") conclusions.supported += 1;
    else if (verdict === "refuted") conclusions.refuted += 1;
    else conclusions.open += 1;
    const known = basis.map((ref) => factById.get(ref)).filter((f): f is FactCheck => f !== undefined);
    if (known.length === 0) withoutFact += 1;

    if (known.length < basis.length) return itemRefuse(id, "unknown_fact");
    if (known.some((f) => f.verdict === "refused")) return itemRefuse(id, "basis_refused");
    if (decided && basis.length === 0) return itemRefuse(id, "no_basis");
    if (decided && asArray(item.unread).length > 0) return itemRefuse(id, "verdict_with_unread");
    if (!decided && !hasCheck(item)) return itemRefuse(id, "open_without_check");
    if (decided && position === closingIndex && !known.some((f) => f.first_hand === true)) {
      return itemRefuse(id, "closing_second_hand");
    }
    return accept(id);
  });

  const open_items: ItemCheck[] = asArray(payload.open_items).map((raw) => {
    const item = asRecord(raw);
    const id = str(item.id);
    if (!asArray(item.basis).some((ref) => factById.has(str(ref)))) withoutFact += 1;
    return hasCheck(item) ? accept(id) : itemRefuse(id, "open_without_check");
  });

  // --- counts ----------------------------------------------------------------
  const totals = emptyCounts();
  const bySourceKind = Object.fromEntries(SOURCE_KINDS.map((k) => [k, emptyCounts()])) as Record<
    SourceKind,
    FactCounts
  >;
  for (const f of facts) {
    countFact(totals, f.verdict);
    if (f.source_kind !== null) countFact(bySourceKind[f.source_kind], f.verdict);
  }

  const report: HandbackReport = {
    facts: totals,
    conclusions,
    statements: { made: verdicts.length + open_items.length, without_fact: withoutFact },
    by_source_kind: bySourceKind,
    flags,
    python_recheck_ran: false,
    children: children.map((child) => ({ label: child.label, report: checkHandback(child, accuracy).report })),
  };

  const accepted =
    facts.every((f) => f.verdict !== "refused") &&
    verdicts.every((v) => v.outcome !== "refused") &&
    open_items.every((v) => v.outcome !== "refused");

  return { accepted, facts, verdicts, open_items, report };
}
