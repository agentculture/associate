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
 * harness's own JSON, where `unchecked_final_reply` (`final_reply` in a result
 * saved before the rename) is the delegated model's account and every other
 * field (outcome, merge, merge_reason, tests) was measured by the harness. A
 * fact quoting it is first-hand when its quote is still found in the saved text
 * with that string emptied; a quote reaching into it, or a result that is not
 * such JSON, is second-hand.
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
 * Strict facts (plan t3; spec claims c22, c23, c36, c40, h10, h26). Every fact
 * gets, beside the verdict above, the fields below; an old-shape fact (a quote
 * and no kind) is a `direct` fact with no `based_on`, and its verdict, the
 * counts and `accepted` are exactly what they were before.
 *   - `kind_stated`: the fact's `kind`, `direct` when absent (any other string
 *     is read as `direct`, the strictest).
 *   - The direct check: the quote matcher for a fact with a quote; for a fact
 *     with a pointer (`at`), the injected `resolveEvidence`, then the fact's
 *     literal value must be inside the quote the resolver copied. With no
 *     resolver a pointer-only fact is unchecked (`pointer_unresolved`); a
 *     resolver answering not ok refuses it (`pointer_unresolved`, the
 *     resolver's own reason as `drop_reason` and its fix).
 *   - The kind floor (c40): a fact whose direct check passes is `passed` and
 *     `kind_checked: direct`, whatever kind it stated. An llm or derived fact
 *     whose matcher check does not pass is not refused: it is unchecked
 *     (`to_judge`), `kind_checked` its stated kind, `status: to_judge`, for the
 *     decider to judge. A source, action or contract failure fails any kind.
 *   - `status`: passed, failed (verdict refused, or a graph refusal), to_judge,
 *     unchecked, or dropped (an input failed).
 *   - The graph (c23): `based_on` names facts of this hand-back. An id naming
 *     none fails the fact (`based_on_unknown`, with the fix); a cycle fails
 *     every fact in it (`based_on_cycle`, the fix lists the ids). Both are also
 *     listed in `graph.refusals`. These reasons have no contract check id yet
 *     (`check` stays as the verdict left it), are never report flags, and leave
 *     `verdict` and `accepted` alone: whether a failure is removed from the
 *     answer or refused is the hand-back flow's decision, by mode.
 *   - Order and cascade (c36, h10): facts are taken in a topological order of
 *     `based_on` (`graph.order`), stable by the model's order; a cycle's facts
 *     sit together in the model's order. When a fact failed, every fact
 *     reachable from it through `based_on` is `dropped`, `drop_reason:
 *     based_on_failed`, `dropped_by` the root failed fact's id (never an
 *     intermediate), and `drop_message` naming it. Any kind cascades; a fact
 *     left to judge does not (it has not failed). `cascadeDrops` redoes the
 *     cascade after a later step changes a status.
 *   `facts` stays in the model's order.
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
export type UncheckedReason = "no_saved_text" | "partial_result" | "pointer_unresolved" | "to_judge";

/** The kinds of check a fact may state (`facts.schema.json` `kind`); absent is `direct`. */
export const FACT_KINDS = ["direct", "llm", "derived"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/** A fact's strict outcome: its own check, a graph refusal, or a drop because an input failed. */
export type FactStatus = "passed" | "failed" | "to_judge" | "unchecked" | "dropped";

/** Graph refusals. No contract check id maps them yet, so they are never report flags. */
export type GraphReason = "based_on_unknown" | "based_on_cycle";
/** `drop_reason` of a fact dropped because a fact it is based on failed. */
export const BASED_ON_FAILED = "based_on_failed";

export interface GraphRefusal {
  readonly reason: GraphReason;
  /** The fact naming unknown ids, or null for a cycle. */
  readonly fact: string | null;
  /** The unknown ids, or the ids in the cycle (model order). */
  readonly ids: string[];
  readonly fix: string;
}

/** What the evidence resolver copied for a pointer (`at`). */
export interface ResolvedEvidence {
  readonly ok: true;
  readonly quote: string;
  readonly command: string;
  readonly result_file: string;
  readonly value: unknown;
  readonly source_kind: unknown;
}

export interface UnresolvedEvidence {
  readonly ok: false;
  readonly reason: string;
  readonly fix: string;
}

/** The walk entry a fact's source resolved to, and that entry's saved text. */
export interface LocatedSource {
  readonly entry: { readonly id: string; readonly tool: string };
  readonly text: string | null;
  /** The run label of the reference, or null for the current run. */
  readonly run: string | null;
}

/** Resolves a fact's pointer to copied evidence (wired by a later task to `lib/evidence.ts`). */
export type EvidenceResolver = (
  fact: Readonly<Record<string, unknown>>,
  located: LocatedSource,
) => ResolvedEvidence | UnresolvedEvidence;

export interface CheckOptions {
  readonly resolveEvidence?: EvidenceResolver;
}

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
  /** The kind the fact stated (`direct` when absent). */
  readonly kind_stated: FactKind;
  /** `direct` when the direct check found the evidence (the kind floor), else the stated kind. */
  readonly kind_checked: FactKind;
  /** The fact ids it names in `based_on`, as given. */
  readonly based_on: string[];
  readonly status: FactStatus;
  /** Why the fact is out of the answer (its own reason, a graph reason, or `based_on_failed`), else null. */
  readonly drop_reason: string | null;
  /** For a cascade drop: the root failed fact's id, else null. */
  readonly dropped_by: string | null;
  /** For a cascade drop: the message to the model, naming the root failed fact, else null. */
  readonly drop_message: string | null;
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
  /** The `based_on` graph: the check order (fact ids) and its refusals. */
  readonly graph: { readonly order: string[]; readonly refusals: GraphRefusal[] };
}

const SOURCE_KINDS: readonly SourceKind[] = ["file", "tool", "web", "memory", "agent", "harness"];
/** Kinds that are another model's words or a remembered claim, not a measurement. */
const SECOND_HAND_KINDS: ReadonlySet<SourceKind> = new Set<SourceKind>(["agent", "memory"]);
/** The tool whose result mixes harness-measured fields with the child's own words. */
const DELEGATE_STATUS_TOOL = "delegate_status";
/**
 * The result fields that hold the child's own words: its final message, and the
 * rendered answer (which carries its finish summary and that message). The
 * final message is `unchecked_final_reply` since the rename; `final_reply`
 * stays listed so a result saved before it still has that field emptied.
 */
const CHILD_ACCOUNT_KEYS: readonly string[] = ["unchecked_final_reply", "final_reply", "answer"];

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

// --- strict facts: kinds, the based_on graph, the cascade --------------------

type StrictField = "kind_stated" | "kind_checked" | "based_on" | "status" | "drop_reason" | "dropped_by" | "drop_message";
/** A fact as its own check leaves it, before kinds and the graph are applied. */
type CoreFact = Omit<FactCheck, StrictField>;

/** The kind a fact states: `direct` when absent or not one of the kinds. */
function kindOfFact(fact: Record<string, unknown>): FactKind {
  const kind = fact.kind;
  return typeof kind === "string" && (FACT_KINDS as readonly string[]).includes(kind) ? (kind as FactKind) : "direct";
}

interface Graph {
  /** Positions in check order. */
  readonly order: number[];
  /** By position: the based_on ids that name no fact. */
  readonly unknown: string[][];
  /** Each cycle as positions in model order. */
  readonly cycles: number[][];
  /** By position: the positions its based_on ids name (first occurrence of each id), in based_on order. */
  readonly deps: number[][];
}

/**
 * The based_on graph over facts by position. An id resolves to the first fact
 * with that id. Strongly connected components (Tarjan) give the cycles: a
 * component of two or more facts, or one fact naming itself. The order is a
 * topological order of the components, each time taking the ready component
 * whose first fact comes earliest in the model's order.
 */
function buildGraph(ids: readonly string[], basedOn: readonly (readonly string[])[]): Graph {
  const n = ids.length;
  const first = new Map<string, number>();
  ids.forEach((id, i) => {
    if (!first.has(id)) first.set(id, i);
  });
  const deps: number[][] = [];
  const unknown: string[][] = [];
  for (let i = 0; i < n; i++) {
    const own: number[] = [];
    const missing: string[] = [];
    for (const ref of basedOn[i]) {
      const at = first.get(ref);
      if (at === undefined) {
        if (!missing.includes(ref)) missing.push(ref);
      } else if (!own.includes(at)) {
        own.push(at);
      }
    }
    deps.push(own);
    unknown.push(missing);
  }

  // Tarjan, iterative so a long chain cannot overflow the stack.
  const indexOf = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const comp = new Array<number>(n).fill(-1);
  const stack: number[] = [];
  const components: number[][] = [];
  let counter = 0;
  for (let root = 0; root < n; root++) {
    if (indexOf[root] !== -1) continue;
    const work: Array<[number, number]> = [[root, 0]];
    indexOf[root] = counter;
    low[root] = counter;
    counter += 1;
    stack.push(root);
    onStack[root] = true;
    while (work.length > 0) {
      const top = work[work.length - 1];
      const [v, next] = top;
      if (next < deps[v].length) {
        top[1] += 1;
        const w = deps[v][next];
        if (indexOf[w] === -1) {
          indexOf[w] = counter;
          low[w] = counter;
          counter += 1;
          stack.push(w);
          onStack[w] = true;
          work.push([w, 0]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], indexOf[w]);
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1][0];
        low[parent] = Math.min(low[parent], low[v]);
      }
      if (low[v] === indexOf[v]) {
        const members: number[] = [];
        let w: number;
        do {
          w = stack.pop() as number;
          onStack[w] = false;
          comp[w] = components.length;
          members.push(w);
        } while (w !== v);
        components.push(members.sort((a, b) => a - b));
      }
    }
  }

  const cycles = components.filter((members) => members.length > 1 || deps[members[0]].includes(members[0]));

  // Kahn over components, stable by each component's first position.
  const needs = components.map((members, c) => {
    const out = new Set<number>();
    for (const v of members) for (const w of deps[v]) if (comp[w] !== c) out.add(comp[w]);
    return out;
  });
  const done = new Set<number>();
  const order: number[] = [];
  while (done.size < components.length) {
    let pick = -1;
    for (let c = 0; c < components.length; c++) {
      if (done.has(c) || [...needs[c]].some((d) => !done.has(d))) continue;
      if (pick === -1 || components[c][0] < components[pick][0]) pick = c;
    }
    done.add(pick);
    order.push(...components[pick]);
  }
  cycles.sort((a, b) => a[0] - b[0]);
  return { order, unknown, cycles, deps };
}

function cascadeMessage(id: string, root: string, rootReason: string | null): string {
  const why = rootReason === null ? "" : ` (${rootReason})`;
  return (
    `${id} is dropped because it is based on ${root}, which failed${why}; ` +
    `fix ${root} or remove it from ${id}'s based_on, then restate ${id}`
  );
}

/** Mark every fact reachable from a failed fact as dropped, naming the root failed fact. */
function cascade(facts: FactCheck[], graph: Graph): FactCheck[] {
  const out = facts.slice();
  for (const i of graph.order) {
    const fact = out[i];
    if (fact.status === "failed") continue;
    let root: FactCheck | null = null;
    for (const d of graph.deps[i]) {
      const dep = out[d];
      if (dep.status === "failed") root = dep;
      else if (dep.status === "dropped" && dep.dropped_by !== null) {
        root = out.find((f) => f.id === dep.dropped_by) ?? null;
      }
      if (root !== null) break;
    }
    if (root === null) continue;
    out[i] = {
      ...fact,
      status: "dropped",
      drop_reason: BASED_ON_FAILED,
      dropped_by: root.id,
      drop_message: cascadeMessage(fact.id, root.id, root.drop_reason),
    };
  }
  return out;
}

/**
 * Redo the cascade over checked facts after a later step changed a status (the
 * decider failing an llm fact): every fact reachable from a failed fact through
 * `based_on` is dropped with the root failed fact's id. A failed fact keeps its
 * own reason. Facts stay in their order; the input is not changed.
 */
export function cascadeDrops(facts: readonly FactCheck[]): FactCheck[] {
  const graph = buildGraph(
    facts.map((f) => f.id),
    facts.map((f) => (Array.isArray(f.based_on) ? f.based_on : [])),
  );
  return cascade(facts.slice(), graph);
}

/** Apply kinds, the graph refusals and the cascade to the facts as their own checks left them. */
function strictPass(
  rawFacts: readonly Record<string, unknown>[],
  core: readonly CoreFact[],
  ownDropReason: ReadonlyArray<string | undefined>,
): { facts: FactCheck[]; graph: { order: string[]; refusals: GraphRefusal[] } } {
  const basedOn = rawFacts.map((raw) => asArray(raw.based_on).map(str));
  const graph = buildGraph(
    core.map((f) => f.id),
    basedOn,
  );

  const facts: FactCheck[] = core.map((fact, i): FactCheck => {
    const kindStated = kindOfFact(rawFacts[i]);
    const common = { kind_stated: kindStated, based_on: basedOn[i], dropped_by: null, drop_message: null };
    if (fact.verdict === "passed") {
      return { ...fact, ...common, kind_checked: "direct", status: "passed", drop_reason: null };
    }
    if (fact.verdict === "refused") {
      const reason = ownDropReason[i] ?? fact.reason;
      return { ...fact, ...common, kind_checked: kindStated, status: "failed", drop_reason: reason };
    }
    const status: FactStatus = kindStated === "direct" ? "unchecked" : "to_judge";
    return { ...fact, ...common, kind_checked: kindStated, status, drop_reason: null };
  });

  const refusals: GraphRefusal[] = [];
  const failGraph = (i: number, reason: GraphReason, fix: string) => {
    const fact = facts[i];
    if (fact.status === "failed") return;
    facts[i] = { ...fact, status: "failed", drop_reason: reason, fix: fact.fix ?? fix };
  };
  graph.unknown.forEach((missing, i) => {
    if (missing.length === 0) return;
    const id = facts[i].id;
    const fix =
      `${id}'s based_on names ${missing.join(", ")}, which no fact of this hand-back has; ` +
      "list only ids of facts given in this hand-back, or add the fact it rests on";
    refusals.push({ reason: "based_on_unknown", fact: id, ids: missing, fix });
    failGraph(i, "based_on_unknown", fix);
  });
  for (const cycle of graph.cycles) {
    const ids = cycle.map((i) => facts[i].id);
    const loop = [...ids, ids[0]].join(" -> ");
    const fix =
      `the based_on lists form a cycle (${loop}); a fact cannot rest on itself, even through other facts: ` +
      "remove one of these ids from a based_on list so the facts can be checked in order";
    refusals.push({ reason: "based_on_cycle", fact: null, ids, fix });
    for (const i of cycle) failGraph(i, "based_on_cycle", fix);
  }

  const cascaded = cascade(facts, graph);
  return { facts: cascaded, graph: { order: graph.order.map((i) => cascaded[i].id), refusals } };
}

/** Check one hand-back against its walk and saved results. */
export function checkHandback(
  input: HandbackInput,
  accuracy: ContractAccuracy,
  options: CheckOptions = {},
): HandbackCheck {
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
  const rawFacts = asArray(payload.facts).map(asRecord);
  const facts: CoreFact[] = [];
  // A drop reason other than the verdict's reason (a resolver's own reason), by position.
  const ownDropReason: Array<string | undefined> = [];
  for (const fact of rawFacts) {
    const id = str(fact.id);
    const source = str(fact.source);
    const quote = str(fact.quote);
    const kindStated = kindOfFact(fact);
    const base = { id, source, run: null as string | null, nearest: null, source_kind: null, first_hand: null };
    const refuse = (
      reason: CheckerReason,
      extra: Partial<CoreFact> = {},
      ctx: FixContext = {},
      note?: string,
    ): CoreFact => {
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

    const unchecked = (reason: UncheckedReason, extra: Partial<CoreFact> = {}): CoreFact => ({
      ...base,
      ...located,
      verdict: "unchecked",
      reason,
      check: null,
      fix: null,
      ...extra,
    });
    // An llm or derived fact the direct check does not find is left to judge, never refused (the kind floor).
    const matcherRefused = (reason: CheckerReason, nearest: NearestSpan | null): CoreFact =>
      kindStated === "direct" ? refuse(reason, { ...located, nearest }) : unchecked("to_judge", { nearest });

    const pointer = fact.at !== null && typeof fact.at === "object" && !Array.isArray(fact.at);
    const resolver = options.resolveEvidence;
    if (pointer && (resolver !== undefined || quote === "")) {
      if (resolver === undefined) {
        facts.push(unchecked("pointer_unresolved"));
        continue;
      }
      let resolved: ResolvedEvidence | UnresolvedEvidence | null;
      try {
        resolved = resolver(fact, { entry: { id: entry.id, tool: entry.tool }, text, run: parsed.label });
      } catch {
        resolved = null;
      }
      if (resolved === null || typeof resolved !== "object") {
        facts.push(unchecked("pointer_unresolved"));
        continue;
      }
      if (!resolved.ok) {
        ownDropReason[facts.length] = str(resolved.reason) || "pointer_unresolved";
        facts.push({ ...base, ...located, verdict: "refused", reason: "pointer_unresolved", check: null, fix: str(resolved.fix) });
        continue;
      }
      // The harness copied the quote, so it is in the result by construction: only the literal is checked.
      const copied = str(resolved.quote);
      const onCopy = checkQuote(copied, literalOf(fact.value), copied, 1);
      const firstHand = isFirstHand(kind, entry, copied, text, 1);
      if (onCopy.verdict === "passed") {
        facts.push({ ...base, ...located, first_hand: firstHand, verdict: "passed", reason: null, check: null, fix: null });
      } else {
        facts.push(matcherRefused(onCopy.reason as CheckerReason, null));
      }
      continue;
    }

    const match = checkQuote(quote, literalOf(fact.value), text, minQuoteLength);
    const textIndependent = match.reason === "quote_short" || match.reason === "literal_not_in_quote";
    if (match.verdict === "unchecked") {
      facts.push(unchecked("no_saved_text"));
    } else if (entry.partial === true && !textIndependent) {
      facts.push(unchecked("partial_result"));
    } else if (match.verdict === "refused") {
      facts.push(matcherRefused(match.reason as CheckerReason, match.nearest));
    } else {
      facts.push({ ...base, ...located, verdict: "passed", reason: null, check: null, fix: null });
    }
  }

  const strict = strictPass(rawFacts, facts, ownDropReason);
  const checkedFacts = strict.facts;

  // --- verdicts and open items ---------------------------------------------
  const factById = new Map<string, FactCheck>();
  for (const f of checkedFacts) if (!factById.has(f.id)) factById.set(f.id, f);

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
  for (const f of checkedFacts) {
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
    children: children.map((child) => ({ label: child.label, report: checkHandback(child, accuracy, options).report })),
  };

  const accepted =
    checkedFacts.every((f) => f.verdict !== "refused") &&
    verdicts.every((v) => v.outcome !== "refused") &&
    open_items.every((v) => v.outcome !== "refused");

  return { accepted, facts: checkedFacts, verdicts, open_items, report, graph: strict.graph };
}
