/**
 * Normalizing the `finish` payload into the contract's statements artifact.
 *
 * Spec c40/c41 (issue #4): a run exports the walk (artifact A) and the
 * statements (artifact B), where each claim carries evidence references into
 * the walk and a claim with no reference is flagged UNREFERENCED. Two fields
 * are explicitly *not* the model's to set, and this module enforces that:
 *
 * - `status` is derived from whether the claim actually carries evidence ids;
 * - `check` on a citation starts as `unverifiable` and is upgraded to
 *   `encountered` only by the harness-side verifier that compares the citation
 *   against the read ranges recorded in the walk;
 * - `not_fully_read` is set by the tool that truncated, so it is taken from
 *   the run rather than from the payload.
 *
 * The shape checked here is `associate/contract/schemas/statements.schema.json`.
 * This module does not restate the schema's *values* — it only maps the tool's
 * input onto the fields the schema names.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccuracyMode, ContractAccuracy } from "./contract.ts";
import type { ChildRun, FactCheck, HandbackCheck, HandbackInput, HandbackReport, RunData } from "./facts.ts";
import { loadSavedResult } from "./results.ts";
import { scoreSupportBatch, type SupportOptions, type SupportPair, type SupportResult } from "./support.ts";
import { readWalkEntries } from "./statements.ts";
import { PRIOR_RUN_LABEL, resolveRunLabel } from "./torch.ts";
import { WALK_FILENAME, redactValue, type RedactionFilter } from "./walk.ts";

/** Evidence ids are walk entry ids: `w1`, `w2`, … (statements schema `$defs`). */
const EVIDENCE_ID = /^w[1-9][0-9]*$/;

export interface RawStatement {
  text?: unknown;
  evidence?: unknown;
}

export interface RawCitation {
  path?: unknown;
  line?: unknown;
}

export interface FinishInput {
  summary?: unknown;
  statements?: unknown;
  citations?: unknown;
}

export interface Handback {
  summary: string;
  statements: Array<{ text: string; evidence: string[]; status: "referenced" | "unreferenced" }>;
  citations: Array<{ path: string; line: number; check: "encountered" | "unverifiable" }>;
  not_fully_read: boolean;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Walk ids the run actually produced, as a membership test.
 *
 * `index.ts` passes the recorder's own ids (`WalkRecorder.entryIds()`); a
 * caller with no walk to check against passes nothing and no id is dropped.
 */
export type KnownEvidenceIds = ReadonlySet<string> | readonly string[];

function membership(known: KnownEvidenceIds | undefined): ((id: string) => boolean) | undefined {
  if (known === undefined) return undefined;
  const set = known instanceof Set ? known : new Set(known as readonly string[]);
  return (id) => set.has(id);
}

/**
 * Build the hand-back artifact from what the model passed to `finish`.
 *
 * `notFullyRead` comes from the run, not the payload.
 *
 * `knownIds` closes the "claims can cite nonexistent evidence" hole: the
 * `wN` SHAPE being right said nothing about the entry EXISTING, so a model
 * could mark a claim `referenced` by citing `w999` from a three-entry walk —
 * exactly the unverifiable citation the artifact exists to prevent. When the
 * run's ids are supplied, an id that is not among them is dropped, and a
 * statement left with no surviving id falls back to `unreferenced`. Omitting
 * `knownIds` keeps the old, shape-only behaviour for callers (tests, the
 * Python adapter's replay) that have no walk in hand.
 */
export function normalizeHandback(
  input: FinishInput,
  notFullyRead = false,
  knownIds?: KnownEvidenceIds,
): Handback {
  const isKnown = membership(knownIds);
  const rawStatements = Array.isArray(input.statements) ? input.statements : [];
  const statements = rawStatements
    .map((entry) => {
      const item = (entry ?? {}) as RawStatement;
      const text = asString(item.text).trim();
      const evidence = (Array.isArray(item.evidence) ? item.evidence : [])
        .filter((id): id is string => typeof id === "string" && EVIDENCE_ID.test(id.trim()))
        .map((id) => id.trim())
        .filter((id) => isKnown === undefined || isKnown(id));
      return {
        text,
        evidence,
        status: (evidence.length > 0 ? "referenced" : "unreferenced") as
          | "referenced"
          | "unreferenced",
      };
    })
    .filter((item) => item.text.length > 0);

  const rawCitations = Array.isArray(input.citations) ? input.citations : [];
  const citations = rawCitations
    .map((entry) => {
      const item = (entry ?? {}) as RawCitation;
      const line = typeof item.line === "number" ? Math.trunc(item.line) : Number.NaN;
      return {
        path: asString(item.path).trim(),
        line,
        // Upgraded to "encountered" only by the walk verifier, never here.
        check: "unverifiable" as const,
      };
    })
    .filter((item) => item.path.length > 0 && Number.isFinite(item.line));

  return {
    summary: asString(input.summary).trim(),
    statements,
    citations,
    not_fully_read: notFullyRead,
  };
}

/** How many claims carry no evidence reference at all. */
export function unreferencedCount(handback: Handback): number {
  return handback.statements.filter((statement) => statement.status === "unreferenced").length;
}

// ----------------------------------------------------- the checked hand-back
//
// Issue #20, plan t11: `finish` runs the hand-back checker (`lib/facts.ts`)
// over the facts payload. What follows is the plumbing around that pure
// checker: the export file names, the check mode, loading the runs a fact may
// cite, and turning the checker's refusals into text a model can act on. The
// settings (modes, rounds, cap, check ids) are all read from accuracy.json.

/** The payload as received, after redaction (`facts.schema.json`); the Python harness reads it by this name. */
export const FACTS_FILENAME = "facts.json";
/** The checker's per-item verdicts, plus the mode and how the hand-back ended. */
export const CHECK_FILENAME = "check.json";
/** The counts (`report.schema.json`); `python_recheck_ran` is false here, the Python harness sets it. */
export const REPORT_FILENAME = "report.json";
/** The harness-rendered answer (`lib/render.ts`). */
export const ANSWER_FILENAME = "answer.md";

// ------------------------------------------------- a quoted list (plan t3, c38)
//
// Measured 2026-11-18 (worker run t9-worker-review): the model called finish
// twice with `facts` given as a STRING holding a JSON list. pi 1.5.2 coerces a
// lone value into a one-item array before it validates, so both calls failed
// with "facts.0: expected object, got string", the tool never ran, and the
// hand-back survived only inside the walk's error text. pi calls a tool's
// `prepareArguments` before validation (agent-loop.js prepareToolCall), so
// finish unquotes such a list there; a string that holds no JSON list is
// refused there with a fix that names the field. A throw from the shim
// becomes the call's error result, which the model sees.

/** finish's fields that are lists, in schema order. */
export const FINISH_LIST_FIELDS = [
  "facts",
  "alternatives",
  "verdicts",
  "open_items",
  "statements",
  "citations",
] as const;

/** The first words of every quoted-list refusal; the rejected-file writer keys its stage on it. */
export const QUOTED_LIST_REFUSAL = "finish refused before the check:";

/** Where a JSON.parse error says it stopped, as a character offset, when it says so. */
function parsePosition(error: unknown): number | undefined {
  const match = /position (\d+)/.exec(error instanceof Error ? error.message : String(error));
  return match ? Number(match[1]) : undefined;
}

function quotedListProblem(value: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    const at = parsePosition(error);
    const where =
      at === undefined
        ? ""
        : ` (the parse stopped at character ${at}, near ${JSON.stringify(value.slice(Math.max(0, at - 30), at + 30))})`;
    return `it is not valid JSON${where}`;
  }
  return Array.isArray(parsed) ? undefined : `it holds JSON that is not a list (${parsed === null ? "null" : typeof parsed})`;
}

/**
 * finish's `prepareArguments`: every list field given as a string holding a
 * JSON list is replaced by that list. Arguments with no such string are
 * returned as the very same object, which tells pi nothing changed. A list
 * field given as any other string throws, naming the field, why, and the fix.
 */
export function prepareFinishArguments(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const input = args as Record<string, unknown>;
  let out: Record<string, unknown> | undefined;
  for (const field of FINISH_LIST_FIELDS) {
    const value = input[field];
    if (typeof value !== "string") continue;
    const problem = quotedListProblem(value);
    if (problem !== undefined) {
      throw new Error(
        `${QUOTED_LIST_REFUSAL} \`${field}\` is a string holding a quoted list, and ${problem}. ` +
          `Nothing was handed back. Fix: pass \`${field}\` as a list (a JSON array of objects, ` +
          `e.g. "${field}": [{"id": ...}, ...]), not as a string holding one, and call finish again with the whole hand-back.`,
      );
    }
    out ??= { ...input };
    out[field] = JSON.parse(value) as unknown;
  }
  return out ?? args;
}

/** The list fields of `raw` that arrived as strings holding a JSON list (and were unquoted). */
export function quotedListFields(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const input = raw as Record<string, unknown>;
  return FINISH_LIST_FIELDS.filter((field) => typeof input[field] === "string" && quotedListProblem(input[field] as string) === undefined);
}

// ------------------------------------------- the rejected hand-back (plan t3, h27)
//
// Every finish payload that is rejected — by pi's argument validation, by the
// quoted-list refusal above, or by the check in enforce mode — is written to
// the export under this name, the latest one replacing any earlier one. It is
// labelled rejected and never rendered into answer.md; the Python harness
// carries it in a timed-out run's result under the same label.

/** The export file holding the latest rejected finish payload. */
export const REJECTED_HANDBACK_FILENAME = "rejected_handback.json";
/** The `label` of that file, and of the result field the Python harness builds from it. */
export const REJECTED_LABEL = "rejected";

/** How a finish payload came to be rejected. */
export type RejectionStage = "schema" | "quoted_list" | "check" | "tool_error";

/** The stage of a finish call pi ended with an error result, from the error text. */
export function rejectionStage(errorText: string): RejectionStage {
  if (errorText.startsWith(QUOTED_LIST_REFUSAL)) return "quoted_list";
  if (/^(Validation failed|Invalid arguments) for tool /.test(errorText)) return "schema";
  return "tool_error";
}

const RECEIVED_ARGUMENTS = "\n\nReceived arguments:\n";

/** The arguments pi quoted in a validation error, when the text carries parseable ones. */
export function argumentsFromErrorText(errorText: string): Record<string, unknown> | undefined {
  const at = errorText.indexOf(RECEIVED_ARGUMENTS);
  if (at < 0) return undefined;
  try {
    const parsed = JSON.parse(errorText.slice(at + RECEIVED_ARGUMENTS.length)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The rejected-hand-back record, payload redacted. */
export function rejectedHandbackRecord(options: {
  stage: RejectionStage;
  error: string;
  toolCallId: string | undefined;
  rejections: number;
  payload: unknown;
  payloadSource: "tool_execution_start" | "error_text" | "tool_arguments" | "none";
  refusals?: readonly HandbackRefusal[];
  filter?: RedactionFilter;
}): Record<string, unknown> {
  const { filter } = options;
  const record: Record<string, unknown> = {
    label: REJECTED_LABEL,
    checked: false,
    note: "A finish payload that was rejected: not a hand-back, not checked as an answer, and never rendered into answer.md.",
    stage: options.stage,
    error: filter ? filter.apply(options.error) : options.error,
    tool_call_id: options.toolCallId ?? null,
    rejections: options.rejections,
    payload_source: options.payloadSource,
    payload: filter ? redactValue(options.payload ?? {}, filter) : (options.payload ?? {}),
  };
  if (options.refusals) record.refusals = options.refusals;
  return record;
}

/** The per-run override of accuracy.json `mode`: `report` or `enforce`. */
export const CHECK_MODE_ENV = "ASSOCIATE_CHECK_MODE";

/** The facts-schema fields `finish` accepts; everything else stays on the statements route. */
const FACTS_FIELDS = ["summary", "facts", "alternatives", "verdicts", "open_items"] as const;

const MODES: readonly AccuracyMode[] = ["report", "enforce"];

/**
 * The override named by `ASSOCIATE_CHECK_MODE`, if any. A value that is not
 * `report` or `enforce` (after trimming) is not an override; `problem` then
 * says so, for the one stderr line the caller prints.
 */
export function checkModeOverride(env: Record<string, string | undefined>): {
  mode?: AccuracyMode;
  problem?: string;
} {
  const raw = env[CHECK_MODE_ENV];
  if (raw === undefined || raw.trim() === "") return {};
  const value = raw.trim();
  if ((MODES as readonly string[]).includes(value)) return { mode: value as AccuracyMode };
  return {
    problem:
      `associate: ${CHECK_MODE_ENV}=${JSON.stringify(raw.slice(0, 40))} is not 'report' or 'enforce'; ` +
      "it is ignored and accuracy.json's mode for the model applies",
  };
}

/**
 * The check mode for one model: the per-run override when there is one, else
 * accuracy.json's `mode` for that registry key. A key the contract gives no
 * valid mode is read as `report` — nothing refused — and says so in `source`.
 */
export function resolveCheckMode(
  accuracy: ContractAccuracy | undefined,
  modelKey: string | undefined,
  override: AccuracyMode | undefined,
): { mode: AccuracyMode; source: "env" | "contract" | "no_contract_mode" } {
  if (override) return { mode: override, source: "env" };
  const table = accuracy?.mode ?? {};
  const value = modelKey !== undefined && Object.hasOwn(table, modelKey) ? table[modelKey] : undefined;
  if (value !== undefined && (MODES as readonly string[]).includes(value)) return { mode: value, source: "contract" };
  return { mode: "report", source: "no_contract_mode" };
}

/** The facts-schema part of `finish`'s arguments, redacted; `facts` is always present. */
export function factsPayload(input: Record<string, unknown>, filter?: RedactionFilter): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of FACTS_FIELDS) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  if (!Array.isArray(out.facts)) out.facts = [];
  return filter ? redactValue(out, filter) : out;
}

/** One run's walk entries and saved results, read from its export directory. */
export function loadRunData(exportDir: string): RunData {
  const entries = readWalkEntries(join(exportDir, WALK_FILENAME));
  const results: Record<string, string> = {};
  for (const entry of entries) {
    if (Object.hasOwn(results, entry.id)) continue;
    try {
      const text = loadSavedResult(exportDir, entry.id);
      if (text !== undefined) results[entry.id] = text;
    } catch {
      // An id that is not a walk id names no saved result.
    }
  }
  return { entries, results };
}

/** A child run's own hand-back, from its facts.json; an export without one reads as an empty payload. */
function loadChildPayload(exportDir: string): unknown {
  const path = join(exportDir, FACTS_FILENAME);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return {};
  }
}

/** A child id as the harness writes it (`c1`, `c2`, …), the pattern `check.py` keeps. */
const CHILD_ID = /^c[1-9][0-9]*$/;

/** The child ids (`c1`, `c2`, …) the walk at `walkPath` records, in order; any other id is skipped. */
export function childLabels(walkPath: string): string[] {
  if (!existsSync(walkPath)) return [];
  const labels: string[] = [];
  for (const line of readFileSync(walkPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const child = (JSON.parse(line) as { child?: { id?: unknown } } | null)?.child;
      if (child && typeof child.id === "string" && CHILD_ID.test(child.id) && !labels.includes(child.id)) {
        labels.push(child.id);
      }
    } catch {
      continue;
    }
  }
  return labels;
}

/**
 * Everything the checker reads for one hand-back: this run, the prior run
 * when the session continues one and a fact cites it, and every child run of
 * this session's walk. Labels are resolved by `resolveRunLabel`, which looks
 * a label up and never opens a path the model wrote.
 */
export function buildHandbackInput(options: {
  payload: unknown;
  exportDir: string;
  walkPath: string;
  continueFrom?: string;
}): HandbackInput {
  const { payload, exportDir, walkPath, continueFrom } = options;
  const current = loadRunData(exportDir);
  const prior_runs: Record<string, RunData> = {};
  // The prior run is loaded whether or not a fact names it: an unlabelled
  // reference that also exists there is flagged ambiguous by the checker.
  if (continueFrom) {
    const prior = resolveRunLabel(PRIOR_RUN_LABEL, { continueFrom, walkPath });
    if (prior.ok) prior_runs[PRIOR_RUN_LABEL] = loadRunData(prior.dir);
  }
  const children: ChildRun[] = [];
  for (const label of childLabels(walkPath)) {
    const child = resolveRunLabel(label, { continueFrom, walkPath });
    if (!child.ok) continue;
    children.push({ label, payload: loadChildPayload(child.dir), ...loadRunData(child.dir) });
  }
  return { payload, ...current, prior_runs, children };
}

/** One refusal the checker made (or, in report mode, would have made). */
export interface HandbackRefusal {
  readonly id: string;
  readonly item: "fact" | "verdict" | "open_item";
  readonly reason: string;
  readonly check: string | null;
  readonly fix: string;
  /** Walk ids (or label:wN references) the refused item cites, directly or through its basis. */
  readonly walk_ids: string[];
  readonly nearest?: string;
}

/** Every refused fact, verdict and open item of `check`, in payload order. */
export function refusalsOf(check: HandbackCheck, payload: unknown): HandbackRefusal[] {
  const sourceOf = new Map<string, string>();
  for (const f of check.facts) if (f.source && !sourceOf.has(f.id)) sourceOf.set(f.id, f.source);
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const items = (key: string): Record<string, unknown>[] => {
    const raw = record(payload)[key];
    return Array.isArray(raw) ? raw.map(record) : [];
  };
  const basisIds = (raw: Record<string, unknown>): string[] => {
    const ids: string[] = [];
    for (const ref of Array.isArray(raw.basis) ? raw.basis : []) {
      const source = typeof ref === "string" ? sourceOf.get(ref) : undefined;
      if (source && !ids.includes(source)) ids.push(source);
    }
    return ids;
  };
  const out: HandbackRefusal[] = [];
  for (const f of check.facts) {
    if (f.verdict !== "refused") continue;
    out.push({
      id: f.id,
      item: "fact",
      reason: String(f.reason),
      check: f.check,
      fix: f.fix ?? "",
      walk_ids: f.source ? [f.source] : [],
      ...(f.nearest ? { nearest: f.nearest.text } : {}),
    });
  }
  const verdicts = items("verdicts");
  check.verdicts.forEach((v, position) => {
    if (v.outcome !== "refused") return;
    out.push({ id: v.id, item: "verdict", reason: String(v.reason), check: v.check, fix: v.fix ?? "", walk_ids: basisIds(verdicts[position] ?? {}) });
  });
  const open = items("open_items");
  check.open_items.forEach((v, position) => {
    if (v.outcome !== "refused") return;
    out.push({ id: v.id, item: "open_item", reason: String(v.reason), check: v.check, fix: v.fix ?? "", walk_ids: basisIds(open[position] ?? {}) });
  });
  return out;
}

/** The refusals as one list item each: what failed, which check, the walk ids, and the fix. */
export function formatRefusals(refusals: readonly HandbackRefusal[]): string {
  return refusals
    .map((r) => {
      const where = r.walk_ids.length ? ` (cites ${r.walk_ids.join(", ")})` : "";
      const nearest = r.nearest !== undefined ? ` Nearest text in the saved result: ${JSON.stringify(r.nearest)}.` : "";
      return `- ${r.id}${where}: ${r.check ?? r.reason} (${r.reason}).${nearest} Fix: ${r.fix}`;
    })
    .join("\n");
}

/** Sentences of model text the harness did not check, by where they came from. */
export interface UncheckedCounts {
  readonly summary_sentences: number;
  readonly final_message_sentences: number;
}

/**
 * The report with unchecked sentences counted as statements that rest on no
 * fact. They are reported in the report's own `unchecked_text` field
 * (report.schema.json) and never folded into the statements counts, which the
 * Python re-check recomputes from the facts file alone.
 */
export function withUncheckedCounts(
  report: HandbackReport,
  counts: UncheckedCounts,
): HandbackReport & { unchecked_text: { summary_sentences: number; final_message_sentences: number } } {
  return {
    ...report,
    unchecked_text: {
      summary_sentences: counts.summary_sentences,
      final_message_sentences: counts.final_message_sentences,
    },
  };
}


// ------------------------------------------- the support score (decider-score t3)
//
// Spec c1/c2, h11/h19: after the quote check, finish asks the decider whether
// each passed fact's quote, on its own, states or directly shows its value
// (lib/support.ts). The answer is stored beside the quote check and decides
// nothing: it never enters `accepted`, a refusal, `would_refuse` or the
// passed/refused/unchecked counts, which are computed before it is asked.
// lib/facts.ts stays pure and offline; the score is asked here, by finish.

/**
 * One fact's support result, aligned by position with `HandbackCheck.facts`
 * (and with the payload's `facts`): a `SupportResult` for a fact that passed
 * the quote check, `undefined` for every other fact (refused or unchecked,
 * which are never sent).
 */
export type FactSupport = ReadonlyArray<SupportResult | undefined>;

/** A checked fact as check.json writes it: the checker's verdict, plus `support` when the fact was scored. */
export type SupportedFactCheck = FactCheck & { readonly support?: SupportResult };

function factPair(raw: unknown): SupportPair {
  const fact = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    value: typeof fact.value === "string" ? fact.value : "",
    quote: typeof fact.quote === "string" ? fact.quote : "",
  };
}

/**
 * Score every fact of `check` that passed the quote check, in payload order,
 * through `scoreSupportBatch` (its cap, total time and the session cache
 * apply). `payload` is the redacted facts payload the check ran on; the value
 * and quote of each passed fact are read from it by position. Never throws:
 * should the batch itself throw, every passed fact is marked not scored.
 */
export async function scoreCheckedFacts(
  check: HandbackCheck,
  payload: unknown,
  options: SupportOptions,
): Promise<FactSupport> {
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const rawFacts = Array.isArray(record.facts) ? record.facts : [];
  const positions: number[] = [];
  const pairs: SupportPair[] = [];
  check.facts.forEach((fact, position) => {
    if (fact.verdict !== "passed") return;
    positions.push(position);
    pairs.push(factPair(rawFacts[position]));
  });
  const out: Array<SupportResult | undefined> = check.facts.map(() => undefined);
  if (pairs.length === 0) return out;
  let results: SupportResult[];
  try {
    results = await scoreSupportBatch(pairs, options);
  } catch (error) {
    const detail = `scoring failed: ${error instanceof Error ? error.message : String(error)}`;
    results = pairs.map(() => ({ status: "not_scored", reason: "unreachable", detail }));
  }
  positions.forEach((position, i) => {
    out[position] = results[i] ?? { status: "not_scored", reason: "unreachable", detail: "no result returned" };
  });
  return out;
}

/**
 * The checked facts with each one's support result in a `support` field of its
 * own; a fact with no result gets no field. With no scores at all (the score
 * switched off) the very same list is returned, so check.json is unchanged.
 */
export function withSupport(facts: readonly FactCheck[], support: FactSupport | undefined): readonly SupportedFactCheck[] {
  if (support === undefined) return facts;
  return facts.map((fact, position) => {
    const result = support[position];
    return result === undefined ? fact : { ...fact, support: result };
  });
}

/** How many facts the decider gave an answer (status `scored`), whatever the answer: report.json `support_scored`. */
export function supportScoredCount(support: FactSupport): number {
  return support.filter((result) => result?.status === "scored").length;
}

/**
 * How many facts got each answer: report.json `support_answers` (deviation
 * d4). One count per key of the contract's options, in contract order, zeros
 * included; an answer that is not one of them (none is ever stored) is left
 * out rather than given a key the contract does not have.
 */
export function supportAnswerCounts(
  support: FactSupport,
  options: Readonly<Record<string, string>>,
): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(Object.keys(options).map((key) => [key, 0]));
  for (const result of support) {
    if (result?.status === "scored" && Object.hasOwn(counts, result.answer)) counts[result.answer] += 1;
  }
  return counts;
}
