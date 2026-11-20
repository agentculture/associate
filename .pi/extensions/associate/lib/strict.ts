/**
 * The strict hand-back decision (strict-facts plan t5; spec claims c7, c10,
 * c25, c28, c31, c35, c36, c37, c40, c41).
 *
 * With strict on for a run (accuracy.json `strict.enabled[model]`, overridden
 * by `ASSOCIATE_STRICT`), `finish` does not refuse a hand-back: it drops what
 * fails, returns a fact the decider answered with a `keep_marked` option once,
 * and accepts the rest. This module is the decision, IO-free: it opens no
 * file and calls no model itself. The decider is reached through the injected
 * `judge` (index.ts wires it to `lib/judge.ts` `judgeFacts`), and every
 * setting is the contract's (`strict`, `support_score.passes`).
 *
 * The flow, per hand-back (`runStrict`):
 *   1. `checkHandback` (lib/facts.ts) with a resolver adapter over
 *      `resolveEvidence` (lib/evidence.ts): a fact with `at` has its evidence
 *      copied by code; the kind floor, the graph refusals (unknown id, cycle)
 *      and the first cascade are t3's.
 *   2. The shape rules (`shapeProblem`, the same cross-field rules as Python
 *      `validate_facts`): a fact that breaks one fails with that reason and
 *      its fix, before anything is asked about it; the cascade is redone.
 *   3. `judge` for the facts left `to_judge` (an llm or derived fact the
 *      direct check did not pass), with `material` built from the facts as
 *      given and the evidence copied for them.
 *   4. `policyFor` (lib/judge.ts) per judged fact: `drop` fails it
 *      (`decider_drop`); `keep_marked` returns it once, or keeps it with
 *      `strict.mark_text` when it was returned before in this task or no
 *      round is left; `pass` and `show_only` keep it (a derived fact's answer
 *      is shown and never drops it while `derived_decides_drops` is false).
 *   5. The cascade again after any new failure.
 *   6. One outcome per fact: `pass`, `keep_marked`, `returned`, `dropped`, or
 *      `not_judged` (an outage, or a fact that could not be sent: kept out of
 *      the answer under its own label, never called failed). A direct fact
 *      that could not be checked at all (no saved text, a partial result) is
 *      dropped: only items whose basis passed are in the answer (c7).
 *   7. Verdicts and open items: one the checker refused is dropped with its
 *      reason; one whose basis names a dropped fact is dropped
 *      (`basis_dropped`); one whose basis names a not-judged fact is not
 *      judged; the rest pass.
 *
 * Rounds and the message are the caller's (index.ts), with `formatStrictMessage`.
 */

import { cascadeDrops, checkHandback, CHECKER_REASONS } from "./facts.ts";
import type { ContractAccuracy } from "./contract.ts";
import type { EvidenceResolver, FactCheck, HandbackCheck, HandbackInput, ItemCheck, ReportFlag, RunData } from "./facts.ts";
import { resolveEvidence, runFromData, type EvidenceContext, type EvidenceOk, type EvidenceRun } from "./evidence.ts";
import { countJudged, notJudgedMessage, policyFor } from "./judge.ts";
import type { FactMaterial, JudgeCounts, JudgedFact, JudgeResult, StrictSettings } from "./judge.ts";

// ------------------------------------------------------------------ the switch

/** The per-run override of accuracy.json `strict.enabled`: `on` or `off`. */
export const STRICT_ENV = "ASSOCIATE_STRICT";

export type StrictSwitch = "on" | "off";
const SWITCHES: readonly StrictSwitch[] = ["on", "off"];

/** accuracy.json's `strict` block as this module reads it. */
export type StrictContract = StrictSettings & { readonly enabled: Readonly<Record<string, boolean>> };

/**
 * The override named by `ASSOCIATE_STRICT`, if any. A value that is not `on`
 * or `off` (after trimming) is no override; `problem` says so, for the one
 * stderr line the caller prints.
 */
export function strictOverride(env: Record<string, string | undefined>): { value?: StrictSwitch; problem?: string } {
  const raw = env[STRICT_ENV];
  if (raw === undefined || raw.trim() === "") return {};
  const value = raw.trim();
  if ((SWITCHES as readonly string[]).includes(value)) return { value: value as StrictSwitch };
  return {
    problem:
      `associate: ${STRICT_ENV}=${JSON.stringify(raw.slice(0, 40))} is not 'on' or 'off'; ` +
      "it is ignored and accuracy.json's strict switch for the model applies",
  };
}

function usableStrict(section: unknown): section is StrictContract {
  if (!section || typeof section !== "object" || Array.isArray(section)) return false;
  const s = section as Record<string, unknown>;
  return (
    Array.isArray(s.keep_marked) &&
    Array.isArray(s.drop) &&
    typeof s.mark_text === "string" &&
    s.mark_text.trim() !== "" &&
    !!s.enabled &&
    typeof s.enabled === "object"
  );
}

/**
 * Whether strict is on for one model in this run, and what decided. Only the
 * value true in `strict.enabled` switches it on from the contract. A file with
 * no usable strict block cannot run it: off, and with an `on` override a
 * `problem` line says why.
 */
export function resolveStrict(
  accuracy: ContractAccuracy | undefined,
  modelKey: string | undefined,
  override: StrictSwitch | undefined,
): { enabled: boolean; source: "environment" | "contract"; settings?: StrictContract; problem?: string } {
  const section = accuracy?.strict;
  if (override === "off") return { enabled: false, source: "environment" };
  if (!usableStrict(section)) {
    return override === "on"
      ? {
          enabled: false,
          source: "environment",
          problem: `associate: ${STRICT_ENV}=on, but accuracy.json has no strict block it can run with; strict stays off`,
        }
      : { enabled: false, source: "contract" };
  }
  if (override === "on") return { enabled: true, source: "environment", settings: section };
  const on = modelKey !== undefined && Object.hasOwn(section.enabled, modelKey) && section.enabled[modelKey] === true;
  return on ? { enabled: true, source: "contract", settings: section } : { enabled: false, source: "contract" };
}

// ------------------------------------------------------------- the shape rules

/** Reasons a fact breaks a cross-field rule (Python `validate_facts`). */
export const SHAPE_REASONS = ["kind_unknown", "pointer_missing", "pointer_malformed", "value_missing", "based_on_missing"] as const;
export type ShapeReason = (typeof SHAPE_REASONS)[number];

const KINDS = ["direct", "llm", "derived"];

const SHAPE_FIXES: Record<ShapeReason, string> = {
  kind_unknown: "give kind as one of direct, llm or derived (leave it out for direct)",
  pointer_missing: "say where the evidence is: at {lines: [first, last]} or at {search: \"term\"} in the cited result",
  pointer_malformed:
    "give at exactly one of lines, two whole line numbers [first, last] with 1 <= first <= last, or search, a non-empty term",
  value_missing: "write the claim in value: an llm or derived fact needs one, and a direct fact needs one unless it points with at",
  based_on_missing: "list in based_on the ids of the facts of this hand-back that the derived fact follows from",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function atProblem(at: unknown): boolean {
  if (!isRecord(at)) return true;
  const keys = Object.keys(at);
  if (keys.length !== 1 || !["lines", "search"].includes(keys[0]!)) return true;
  if (keys[0] === "search") return !(typeof at.search === "string" && at.search.trim() !== "");
  const lines = at.lines;
  if (!Array.isArray(lines) || lines.length !== 2 || !lines.every((n) => Number.isInteger(n))) return true;
  return lines[0] < 1 || lines[1] < lines[0];
}

/** The first cross-field rule a fact breaks, with its fix, or null. */
export function shapeProblem(fact: Readonly<Record<string, unknown>>): { reason: ShapeReason; fix: string } | null {
  const fail = (reason: ShapeReason) => ({ reason, fix: SHAPE_FIXES[reason] });
  const kind = Object.hasOwn(fact, "kind") ? fact.kind : "direct";
  if (typeof kind !== "string" || !KINDS.includes(kind)) return fail("kind_unknown");
  const hasAt = Object.hasOwn(fact, "at");
  if (hasAt && atProblem(fact.at)) return fail("pointer_malformed");
  if (!hasAt && !Object.hasOwn(fact, "quote")) return fail("pointer_missing");
  const hasValue = Object.hasOwn(fact, "value");
  if (kind === "direct" && !hasValue && !hasAt) return fail("value_missing");
  if (kind !== "direct" && !hasValue) return fail("value_missing");
  if (kind === "derived" && !(Array.isArray(fact.based_on) && fact.based_on.length > 0)) return fail("based_on_missing");
  return null;
}

/**
 * With strict off, the error pi's argument validation gave before the
 * finish schema made `value` and `quote` optional (t5): a fact without a
 * pointer (`at`) needs both as strings. Undefined when every fact has them.
 * The text has pi's validation form, so the rejected hand-back is filed at
 * the `schema` stage as before.
 */
export function strictOffShapeProblem(args: unknown): string | undefined {
  const facts = isRecord(args) && Array.isArray(args.facts) ? args.facts : [];
  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    if (!isRecord(fact) || Object.hasOwn(fact, "at")) continue;
    for (const field of ["value", "quote"]) {
      if (typeof fact[field] !== "string") {
        return (
          `Validation failed for tool "finish": facts.${i}.${field}: must be string ` +
          "(strict facts are off for this run: a fact without at needs value and quote)"
        );
      }
    }
  }
  return undefined;
}

// ------------------------------------------------------------- the evidence

/**
 * The evidence context for one hand-back, over the run data the checker
 * already loaded (`buildHandbackInput`): the current run, the prior run by its
 * label, each child by its label. The same reads `check_quote` makes.
 */
export function evidenceContextFor(
  input: HandbackInput,
  options: { checkoutRoot: string; redact: (text: string) => string; sourceKinds?: EvidenceContext["sourceKinds"] },
): EvidenceContext {
  const current = runFromData(input);
  const others = new Map<string, RunData>();
  for (const [label, run] of Object.entries(input.prior_runs ?? {})) others.set(label, run);
  for (const child of input.children ?? []) {
    if (child && typeof child.label === "string" && !others.has(child.label)) others.set(child.label, child);
  }
  return {
    entry: (id) => current.entry(id),
    savedResult: (name) => current.savedResult(name),
    checkoutRoot: options.checkoutRoot,
    redact: options.redact,
    labelled: (label): EvidenceRun | undefined => {
      const run = others.get(label);
      return run === undefined ? undefined : runFromData(run);
    },
    sourceKinds: options.sourceKinds,
  };
}

// ------------------------------------------------------------------- outcomes

export type StrictOutcome = "pass" | "keep_marked" | "returned" | "dropped" | "not_judged";

/** The `drop_reason` of a fact the decider answered with a `drop` option. */
export const DECIDER_DROP = "decider_drop";
/** The `reason` of a verdict or open item whose basis names a dropped fact. */
export const BASIS_DROPPED = "basis_dropped";
/** What a returned fact is told to do. */
export const STRICT_RETURN_FIX =
  "narrow the value to what the evidence shows, or point at a source that shows the rest";

/** One fact as check.json writes it under strict: the checker's record plus the strict fields. */
export type StrictFact = Omit<FactCheck, "status"> & {
  readonly status: JudgedFact["status"];
  readonly strict_outcome: StrictOutcome;
  readonly judge: JudgeResult | null;
  /** For a returned fact: the round it was returned in. */
  readonly round?: number;
  /** For a kept-marked fact: the contract's mark text. */
  readonly mark?: string;
  /** For a fact whose pointer resolved: what the harness copied. */
  readonly evidence?: Pick<EvidenceOk, "quote" | "command" | "command_from" | "result_file" | "lines" | "run">;
};

export type StrictItem = ItemCheck & { readonly strict_outcome: StrictOutcome; readonly strict_reason: string | null };

export interface DroppedItem {
  readonly id: string;
  readonly item: "fact" | "verdict" | "open_item";
  /** The value as given (a fact), or the text (a verdict or open item); null when none was given. */
  readonly value: string | null;
  readonly reason: string;
  /** What went wrong, when the step that dropped it said more than its reason. */
  readonly message?: string;
  readonly fix: string;
  /** For a cascade drop: the root failed fact. */
  readonly dropped_by?: string;
  /** The source the fact cited, when it had one. */
  readonly source?: string;
}

export interface ReturnedItem {
  readonly id: string;
  readonly option: string;
  readonly fix: string;
  readonly round: number;
  readonly value: string | null;
}

export interface StrictCounts {
  pass: number;
  keep_marked: number;
  returned: number;
  dropped: number;
  not_judged: number;
}

export interface StrictDecision {
  readonly facts: StrictFact[];
  readonly items: { readonly verdicts: StrictItem[]; readonly open_items: StrictItem[] };
  /** Every dropped item (facts first, then verdicts and open items), each with its reason and fix (c35). */
  readonly dropped: DroppedItem[];
  readonly returned: ReturnedItem[];
  /** Facts per outcome. */
  readonly counts: StrictCounts;
  /** Dropped items per reason (facts, verdicts and open items). */
  readonly drop_reasons: Record<string, number>;
  readonly judge_counts: JudgeCounts;
  readonly not_judged_message: string | null;
}

/** The judge as runStrict calls it: every fact, and the material for any id. */
export type StrictJudge = (
  facts: readonly FactCheck[],
  material: (id: string) => FactMaterial | undefined,
) => Promise<JudgedFact[]>;

export interface StrictRunInput {
  readonly handbackInput: HandbackInput;
  readonly accuracy: ContractAccuracy;
  readonly settings: StrictSettings;
  /** `support_score.passes`: the options that pass an llm fact. */
  readonly passes: readonly string[];
  readonly evidence: EvidenceContext;
  readonly judge: StrictJudge;
  /** Fact ids returned earlier in this task: answered part or little again, they are kept with the mark. */
  readonly returnedBefore: ReadonlySet<string>;
  /** False when no round is left: a fact that would be returned is kept with the mark instead. */
  readonly canReturn: boolean;
  /** The round a fact returned now is returned in (1-based). */
  readonly round: number;
}

export interface StrictRun {
  readonly payload: unknown;
  readonly check: HandbackCheck;
  readonly decision: StrictDecision;
}

const UNCHECKED_FIX =
  "cite a call whose whole result was saved (a narrower read, search or command) and point at the evidence in it";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function valueOf(raw: Record<string, unknown>): string | null {
  return typeof raw.value === "string" ? raw.value : null;
}

/** Run the strict check over one hand-back. Never throws for anything the decider does (the judge's contract). */
export async function runStrict(input: StrictRunInput): Promise<StrictRun> {
  const payload = input.handbackInput.payload;
  const rawFacts = (Array.isArray(isRecord(payload) ? payload.facts : undefined) ? (payload as { facts: unknown[] }).facts : []).map(
    (f) => (isRecord(f) ? f : {}),
  );
  const own = new Set<object>(rawFacts);
  const copied = new Map<object, EvidenceOk>();
  const failedWith = new Map<object, string>();
  const resolver: EvidenceResolver = (fact) => {
    // A child's facts are its own hand-back's; they are not resolved against this run.
    if (!own.has(fact)) return null as never;
    const result = resolveEvidence(fact, input.evidence);
    if (result.ok) {
      copied.set(fact, result);
      return {
        ok: true,
        quote: result.quote,
        command: result.command,
        result_file: result.result_file,
        value: result.value,
        source_kind: result.source_kind,
      };
    }
    failedWith.set(fact, result.message);
    return { ok: false, reason: result.reason, fix: result.fix };
  };
  const check = checkHandback(input.handbackInput, input.accuracy, { resolveEvidence: resolver });

  // 2. shape rules, then the cascade again
  const shapes = rawFacts.map((raw) => shapeProblem(raw));
  const shaped = cascadeDrops(
    check.facts.map((fact, i): FactCheck => {
      const shape = shapes[i];
      return shape
        ? { ...fact, status: "failed", drop_reason: shape.reason, fix: shape.fix, dropped_by: null, drop_message: null }
        : fact;
    }),
  );

  // 3. the judge, for what is left to judge
  const firstById = new Map<string, number>();
  shaped.forEach((f, i) => {
    if (!firstById.has(f.id)) firstById.set(f.id, i);
  });
  const material = (id: string): FactMaterial | undefined => {
    const i = firstById.get(id);
    if (i === undefined) return undefined;
    const raw = rawFacts[i]!;
    const evidence = copied.get(raw)?.quote ?? (typeof raw.quote === "string" && raw.quote !== "" ? raw.quote : null);
    return { value: valueOf(raw), evidence };
  };
  const judged = await input.judge(shaped, material);

  // 4. the contract's policy for each answer
  const verdictOf: Array<{ outcome: StrictOutcome; fix?: string; option?: string }> = judged.map((fact) => {
    if (fact.status === "not_judged") return { outcome: "not_judged" };
    if (fact.status !== "judged" || !fact.judge || fact.judge.option === null) return { outcome: "pass" };
    const option = fact.judge.option;
    const policy = policyFor(option, fact.judge.question, input.settings, input.passes);
    if (policy === "drop") {
      return {
        outcome: "dropped",
        option,
        fix: `the decider answered '${option}': the evidence does not show the value; point at the lines that show it, or leave the fact out`,
      };
    }
    if (policy === "keep_marked") {
      const keep = input.returnedBefore.has(fact.id) || !input.canReturn;
      return { outcome: keep ? "keep_marked" : "returned", option };
    }
    return { outcome: "pass" };
  });

  // 5. the cascade after the decider's failures
  // A direct fact the harness could not check at all fails too: only items
  // whose basis passed are in the answer (c7), and what rests on it cascades.
  const forCascade = judged.map((fact, i): FactCheck => {
    const own = verdictOf[i]!;
    const base = fact as unknown as FactCheck;
    if (fact.status === "failed") return { ...base, status: "failed" };
    if (fact.status === "dropped") return { ...base, status: "dropped" };
    if (fact.status === "unchecked") {
      return { ...base, status: "failed", drop_reason: fact.reason ?? "unchecked", fix: fact.fix ?? UNCHECKED_FIX };
    }
    if (own.outcome === "dropped") return { ...base, status: "failed", drop_reason: DECIDER_DROP, fix: own.fix ?? null };
    return { ...base, status: "passed" };
  });
  const cascaded = cascadeDrops(forCascade);

  // 6. one outcome per fact
  const facts: StrictFact[] = judged.map((fact, i) => {
    const raw = rawFacts[i]!;
    const after = cascaded[i]!;
    const evidence = copied.get(raw);
    const common = {
      ...fact,
      judge: fact.judge ?? null,
      ...(evidence
        ? {
            evidence: {
              quote: evidence.quote,
              command: evidence.command,
              command_from: evidence.command_from,
              result_file: evidence.result_file,
              lines: evidence.lines,
              run: evidence.run,
            },
          }
        : {}),
    };
    if (after.status === "dropped") {
      return {
        ...common,
        status: "dropped",
        strict_outcome: "dropped",
        drop_reason: after.drop_reason,
        dropped_by: after.dropped_by,
        drop_message: after.drop_message,
      };
    }
    if (after.status === "failed") {
      return { ...common, strict_outcome: "dropped", drop_reason: after.drop_reason, fix: after.fix };
    }
    const own = verdictOf[i]!;
    if (own.outcome === "returned") return { ...common, strict_outcome: "returned", round: input.round };
    if (own.outcome === "keep_marked") return { ...common, strict_outcome: "keep_marked", mark: input.settings.mark_text };
    return { ...common, strict_outcome: own.outcome };
  });

  // 7. verdicts and open items
  const outcomeById = new Map<string, StrictOutcome>();
  for (const f of facts) if (!outcomeById.has(f.id)) outcomeById.set(f.id, f.strict_outcome);
  const items = (key: "verdicts" | "open_items"): Record<string, unknown>[] => {
    const list = isRecord(payload) ? payload[key] : undefined;
    return Array.isArray(list) ? list.map((x) => (isRecord(x) ? x : {})) : [];
  };
  const itemOutcome = (item: ItemCheck, raw: Record<string, unknown>): StrictItem => {
    if (item.outcome === "refused") return { ...item, strict_outcome: "dropped", strict_reason: item.reason };
    const basis = (Array.isArray(raw.basis) ? raw.basis : []).map(str);
    const out = basis.map((id) => outcomeById.get(id));
    if (out.some((o) => o === "dropped" || o === "returned")) {
      const ids = basis.filter((id) => ["dropped", "returned"].includes(outcomeById.get(id) ?? ""));
      return { ...item, strict_outcome: "dropped", strict_reason: BASIS_DROPPED, fix: `it rests on ${ids.join(", ")}, which ${ids.length === 1 ? "is" : "are"} not in the answer; fix or leave out ${ids.join(", ")}, then restate it` };
    }
    if (out.some((o) => o === "not_judged")) return { ...item, strict_outcome: "not_judged", strict_reason: null };
    return { ...item, strict_outcome: "pass", strict_reason: null };
  };
  const rawVerdicts = items("verdicts");
  const rawOpen = items("open_items");
  const verdicts = check.verdicts.map((v, i) => itemOutcome(v, rawVerdicts[i] ?? {}));
  const open_items = check.open_items.map((v, i) => itemOutcome(v, rawOpen[i] ?? {}));

  // the lists and counts
  const dropped: DroppedItem[] = [];
  facts.forEach((f, i) => {
    if (f.strict_outcome !== "dropped") return;
    const raw = rawFacts[i]!;
    const message = f.drop_reason === "based_on_failed" ? undefined : failedWith.get(raw);
    dropped.push({
      id: f.id,
      item: "fact",
      value: valueOf(raw),
      reason: String(f.drop_reason ?? f.reason ?? "dropped"),
      ...(message ? { message } : {}),
      fix: (f.drop_reason === "based_on_failed" ? f.drop_message : f.fix) ?? UNCHECKED_FIX,
      ...(f.dropped_by ? { dropped_by: f.dropped_by } : {}),
      ...(f.source ? { source: f.source } : {}),
    });
  });
  const pushItems = (list: StrictItem[], raws: Record<string, unknown>[], item: "verdict" | "open_item") =>
    list.forEach((v, i) => {
      if (v.strict_outcome !== "dropped") return;
      const text = raws[i]?.text;
      dropped.push({
        id: v.id,
        item,
        value: typeof text === "string" ? text : null,
        reason: String(v.strict_reason ?? "dropped"),
        fix: v.fix ?? "",
      });
    });
  pushItems(verdicts, rawVerdicts, "verdict");
  pushItems(open_items, rawOpen, "open_item");

  const returned: ReturnedItem[] = facts.flatMap((f, i) =>
    f.strict_outcome === "returned"
      ? [{ id: f.id, option: f.judge?.option ?? "", fix: STRICT_RETURN_FIX, round: input.round, value: valueOf(rawFacts[i]!) }]
      : [],
  );
  const counts: StrictCounts = { pass: 0, keep_marked: 0, returned: 0, dropped: 0, not_judged: 0 };
  for (const f of facts) counts[f.strict_outcome] += 1;
  const drop_reasons: Record<string, number> = {};
  for (const d of dropped) drop_reasons[d.reason] = (drop_reasons[d.reason] ?? 0) + 1;

  return {
    payload,
    check,
    decision: {
      facts,
      items: { verdicts, open_items },
      dropped,
      returned,
      counts,
      drop_reasons,
      judge_counts: countJudged(judged),
      not_judged_message: notJudgedMessage(judged),
    },
  };
}

// ------------------------------------------------------------------ the flags

/**
 * report.json flags for the strict drops the checker did not already flag: a
 * drop reason the contract maps to a check id (`refusal_checks`) and that is
 * not one of the checker's own reasons (those are flagged by `checkHandback`).
 */
export function strictFlags(decision: StrictDecision, refusalChecks: Readonly<Record<string, string>>): ReportFlag[] {
  const own = new Set<string>(CHECKER_REASONS);
  const flags: ReportFlag[] = [];
  for (const d of decision.dropped) {
    if (own.has(d.reason) || !Object.hasOwn(refusalChecks, d.reason)) continue;
    const flag: { check: string; detail: string; ref?: string } = { check: refusalChecks[d.reason]!, detail: `${d.id}: ${d.reason}` };
    if (d.source && /^([A-Za-z0-9_-]+:)?w[1-9][0-9]*$/.test(d.source)) flag.ref = d.source;
    flags.push(flag);
  }
  return flags;
}

// ---------------------------------------------------------------- the message

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The text the model receives for a strict hand-back: every dropped item (id,
 * reason, what went wrong, fix; a cascade drop names its root), every returned
 * item (id, the decider's option, the fix), the not-judged line, and either
 * how many finish calls are left (a round sent back) or that the hand-back was
 * accepted without the dropped items and not refused (`final`).
 */
export function formatStrictMessage(
  decision: StrictDecision,
  options: { round: number; retryRounds: number; final: boolean },
): string {
  const { counts } = decision;
  const inAnswer = counts.pass + counts.keep_marked;
  const head = options.final
    ? `Hand-back accepted (strict facts): ${plural(inAnswer, "fact")} in the answer (${counts.keep_marked} kept marked), ` +
      `${decision.dropped.length} dropped, ${counts.not_judged} not judged. The answer goes out without the dropped items; ` +
      "the hand-back is not refused."
    : `Hand-back checked (strict facts), round ${options.round} of ${options.retryRounds}: ` +
      `${decision.dropped.length} dropped, ${decision.returned.length} returned. ` +
      `The answer as it stands (${plural(inAnswer, "fact")}, without the dropped and returned items) is recorded.`;
  const lines = [head];
  if (decision.dropped.length > 0) {
    lines.push("", "Dropped (not in the answer):");
    for (const d of decision.dropped) {
      const where = d.source ? ` (cites ${d.source})` : "";
      if (d.reason === "based_on_failed" && d.dropped_by) {
        lines.push(`- ${d.id}: based_on_failed (root: ${d.dropped_by}). ${d.fix}`);
        continue;
      }
      const label = d.item === "fact" ? "" : ` [${d.item.replace("_", " ")}]`;
      const what = d.message ? ` ${d.message}.` : "";
      lines.push(`- ${d.id}${label}${where}: ${d.reason}.${what} Fix: ${d.fix}`);
    }
  }
  if (decision.returned.length > 0) {
    lines.push("", "Returned once (not in the answer until it comes back):");
    for (const r of decision.returned) {
      lines.push(
        `- ${r.id}: the decider answered '${r.option}' (the evidence shows only part of the value). Fix: ${r.fix}. ` +
          "If it comes back still answered part or little, it is kept in the answer marked as showing part of the value.",
      );
    }
  }
  if (decision.not_judged_message) lines.push("", `Not judged: ${decision.not_judged_message}`);
  if (!options.final) {
    const left = options.retryRounds - options.round + 1;
    lines.push(
      "",
      `You may fix these (tools are still available) and call finish again with the whole hand-back: ` +
        `${plural(left, "finish call")} left, and the last one is accepted as it stands, without its dropped items. ` +
        "Or stop: the answer recorded now goes out as it is.",
    );
  }
  return lines.join("\n");
}

// --------------------------------------------------------- what render is handed

/**
 * The payload and check `lib/render.ts` is handed under strict (its new form
 * is a later task): every fact, verdict and open item outside the answer
 * (dropped, returned, not judged) is marked refused so render leaves it out;
 * a fact whose evidence was copied shows the copied text as its quote, a
 * direct fact with no value shows the value the resolver took, and a kept
 * fact carries the mark and the decider's option on its value.
 */
export function renderView(payload: unknown, check: HandbackCheck, decision: StrictDecision): { payload: unknown; check: HandbackCheck } {
  const record = isRecord(payload) ? payload : {};
  const rawFacts = Array.isArray(record.facts) ? record.facts : [];
  const inAnswer = (o: StrictOutcome) => o === "pass" || o === "keep_marked";
  const facts = rawFacts.map((raw, i) => {
    const fact = isRecord(raw) ? { ...raw } : {};
    const strict = decision.facts[i];
    if (!strict) return fact;
    if (strict.evidence) fact.quote = strict.evidence.quote;
    if (typeof fact.value !== "string" && strict.evidence) fact.value = strict.evidence.quote;
    if (strict.strict_outcome === "keep_marked") {
      fact.value = `${str(fact.value)} [${strict.mark ?? ""}; decider: ${strict.judge?.option ?? "?"}]`;
    }
    return fact;
  });
  const out = (item: ItemCheck, s: StrictItem | undefined): ItemCheck =>
    s && !inAnswer(s.strict_outcome) ? { ...item, outcome: "refused" } : item;
  return {
    payload: { ...record, facts },
    check: {
      ...check,
      facts: check.facts.map((f, i) => {
        const s = decision.facts[i];
        return s && !inAnswer(s.strict_outcome) ? { ...f, verdict: "refused" } : f;
      }),
      verdicts: check.verdicts.map((v, i) => out(v, decision.items.verdicts[i])),
      open_items: check.open_items.map((v, i) => out(v, decision.items.open_items[i])),
    },
  };
}
