/**
 * The decider judges llm and derived facts (strict-facts plan t4; spec claims
 * c24, c31, h18, c36).
 *
 * Under strict, `checkHandback` leaves `status: to_judge` every fact whose
 * value is in the model's own wording (not word for word in its evidence),
 * whatever kind it stated, and every fact stating `derived` (plan deviation
 * d3). `judgeFacts` asks the lobes decider about each one, through the support
 * client's request path (`lib/support.ts`, so the same address, headers,
 * redaction and bounds):
 *
 *  - any fact but a derived one: the five-option support question
 *    (`support_score`), asked of the fact's value and its evidence text. For a
 *    fact whose pointer resolved, the evidence text is the line
 *    `command: <the command as rendered>` and then the copied lines, so the
 *    decider can see what a count counts. Sending the command is new and has
 *    not been measured on a labelled set. For an old-shape fact (a quote the
 *    model typed) the evidence text is that quote alone, as before;
 *  - a `derived` fact: the contract's derived question
 *    (`strict.derived_question`), asked of the fact's conclusion (its value)
 *    and the values of the facts it lists in `based_on`, one per line with
 *    its id. A listed fact with no value is shown by its copied quote,
 *    marked as such; one with neither is shown as unavailable.
 *
 * What comes back is stored, never acted on. A record leaves here with
 * `status: judged` (an answer came back; `judge.option` holds it) or
 * `status: not_judged` (the decider is unreachable, answered something that
 * is not one of the options, or the fact could not be sent; `judge.reason`
 * says which). It is never `failed` and never `dropped` from here: an outage
 * is not a verdict on the fact. What a stored option means for the answer is
 * the contract's policy, applied by the hand-back flow through `policyFor`.
 * By the contract (`derived_decides_drops` false) a derived answer is shown
 * and never drops the fact.
 *
 * Pure library: no top-level side effect, no network except through the
 * injected `fetch`. Every setting is an argument; the wording and options
 * are the contract's.
 */

import type { FactCheck, FactStatus } from "./facts.ts";
import { scoreSupport } from "./support.ts";
import type {
  SupportCache,
  SupportLabels,
  SupportNotScoredReason,
  SupportOptions,
  SupportResult,
} from "./support.ts";

// ---------------------------------------------------------------------- types

/** The `strict` block of `accuracy.json`; field names are the contract's. */
export interface StrictSettings {
  readonly keep_marked: readonly string[];
  readonly drop: readonly string[];
  readonly mark_text: string;
  readonly derived_decides_drops: boolean;
  readonly derived_question: {
    readonly question: string;
    readonly options: Readonly<Record<string, string>>;
  };
  /** Derived answers that would pass a derived fact if `derived_decides_drops` were true. */
  readonly derived_passes?: readonly string[];
}

export type JudgeQuestion = "support" | "derived";

/** Why a fact was not judged: the support client's reasons, plus the three this module adds. */
export type NotJudgedReason =
  | SupportNotScoredReason
  /** The fact has no evidence text to send (an llm fact). */
  | "no_evidence"
  /** A derived fact lists no fact with a value or quote to send. */
  | "no_inputs"
  /** The judging settings (support question or derived question) are missing or cannot be asked. */
  | "no_settings";

/** Reasons that mean the decider itself did not answer, as opposed to the fact not being sendable. */
export const OUTAGE_REASONS: ReadonlySet<string> = new Set([
  "no_key",
  "bad_url",
  "contract_invalid",
  "out_of_time",
  "timeout",
  "unreachable",
  "http_error",
  "malformed",
  "aborted",
  "skipped_after_failure",
]);

export interface JudgeResult {
  readonly question: JudgeQuestion;
  /** The option the decider picked (a key of the question's options), or null when not judged. */
  readonly option: string | null;
  readonly judged: boolean;
  /** Why not judged, else null. */
  readonly reason: NotJudgedReason | null;
  /** The decider's probability for `option`, else null. */
  readonly confidence: number | null;
}

export type JudgedStatus = FactStatus | "judged" | "not_judged";

/** A `FactCheck` after judging. `judge` is null for a fact that was not `to_judge`. */
export type JudgedFact = Omit<FactCheck, "status"> & {
  readonly status: JudgedStatus;
  readonly judge: JudgeResult | null;
};

/** What the harness holds for one fact id: its value and its evidence text. */
export interface FactMaterial {
  /** The fact's own value (a conclusion, for a derived fact), or null when it gave none. */
  readonly value: string | null;
  /** The text copied for it: the harness's copied quote (a fact with `at`), else the fact's own quote; null when none. */
  readonly evidence: string | null;
  /** The command the copied quote came from (a fact whose pointer resolved), else null or absent. */
  readonly command?: string | null;
}

/**
 * The evidence text the support question is asked of: `command: <command>`
 * on the first line, then the copied quote, when the fact's pointer resolved;
 * the quote alone otherwise. Sending the command is new (plan deviation d3)
 * and has not been measured on a labelled set.
 */
export function supportEvidence(material: FactMaterial | undefined): string {
  const evidence = material?.evidence ?? "";
  if (!evidence.trim()) return "";
  const command = material?.command;
  return typeof command === "string" && command.trim() !== "" ? `command: ${command}\n${evidence}` : evidence;
}

export interface JudgeDeps {
  /** `accuracy.json`'s support-score settings (question, options, pass list, bounds). */
  readonly settings: SupportOptions["settings"];
  /** `accuracy.json`'s `strict` block. */
  readonly strict: StrictSettings;
  readonly config: SupportOptions["config"];
  readonly env: SupportOptions["env"];
  readonly redaction: SupportOptions["redaction"];
  readonly fetch: typeof fetch;
  /** Value and evidence for a fact id, from the facts as given and the evidence the harness copied. */
  readonly material: (id: string) => FactMaterial | undefined;
  readonly cache?: SupportCache;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  /**
   * Bounds shared by several `judgeFacts` calls for one hand-back (the strict
   * flow judges in two steps). Absent: each call has its own.
   */
  readonly budget?: JudgeBudget;
}

/** The per-hand-back bounds: the deadline, the requests sent, and the first failure seen. */
export interface JudgeBudget {
  readonly deadline: number;
  sent: number;
  failed: string | undefined;
}

/** A fresh budget for one hand-back: `total_timeout_ms` from now, nothing sent. */
export function createJudgeBudget(settings: { readonly total_timeout_ms?: number } | undefined, now: () => number = Date.now): JudgeBudget {
  return { deadline: now() + (settings?.total_timeout_ms ?? 0), sent: 0, failed: undefined };
}

// -------------------------------------------------------------------- the pair

const DERIVED_LABELS: SupportLabels = { value: "conclusion", quote: "listed facts" };

/** Text of one listed fact for a derived question, or null when nothing is available. */
function listedLine(id: string, material: FactMaterial | undefined): string | null {
  const value = material?.value?.trim() ? material.value : null;
  if (value !== null) return `${id}: ${value}`;
  const quote = material?.evidence?.trim() ? material.evidence : null;
  if (quote !== null) return `${id}: (no value given; its copied quote) ${quote}`;
  return null;
}

/** The evidence text a derived fact is sent with: one line per listed fact, in `based_on` order. */
export function derivedInputs(basedOn: readonly string[], material: (id: string) => FactMaterial | undefined): string | null {
  const lines: string[] = [];
  for (const id of basedOn) {
    const line = listedLine(id, material(id));
    lines.push(line ?? `${id}: (no value or quote available)`);
  }
  const usable = basedOn.some((id) => listedLine(id, material(id)) !== null);
  return usable ? lines.join("\n") : null;
}

// -------------------------------------------------------------------- the asks

const mapResult = (question: JudgeQuestion, result: SupportResult): JudgeResult =>
  result.status === "scored"
    ? { question, option: result.answer, judged: true, reason: null, confidence: result.confidence }
    : { question, option: null, judged: false, reason: result.reason, confidence: null };

const notJudged = (question: JudgeQuestion, reason: NotJudgedReason): JudgeResult => ({
  question,
  option: null,
  judged: false,
  reason,
  confidence: null,
});

function derivedSettings(deps: JudgeDeps): SupportOptions["settings"] | undefined {
  const q = deps.strict?.derived_question;
  if (!q || typeof q.question !== "string" || !q.question.trim()) return undefined;
  const keys = Object.keys(q.options ?? {});
  if (keys.length < 2) return undefined;
  // The question's own pass list (the support client wants one): the contract's derived_passes that are
  // options, else "yes" when it is a key, else the first option. What is done with an answer is policyFor's.
  const named = (deps.strict.derived_passes ?? []).filter((k) => keys.includes(k));
  const passes = named.length > 0 ? named : keys.includes("yes") ? ["yes"] : [keys[0]!];
  return { ...deps.settings, question: q.question, options: q.options, passes, background: undefined };
}

function supportReady(deps: JudgeDeps): boolean {
  const s = deps.settings;
  return !!s && typeof s.question === "string" && !!s.options && Object.keys(s.options).length >= 2;
}

/**
 * Judge every `to_judge` fact, in the order given. One request at a time (the
 * decider serves one at a time). Bounds are the support settings': the
 * per-fact time, `max_facts` requests, and `total_timeout_ms` overall; a fact
 * past a bound is `not_judged`. After the first `unreachable`, `timeout` or
 * `http_error`, no further request is sent: the rest are `not_judged` with
 * `skipped_after_failure`. Never throws for anything the decider does.
 */
export async function judgeFacts(facts: readonly FactCheck[], deps: JudgeDeps): Promise<JudgedFact[]> {
  const now = deps.now ?? Date.now;
  const budget = deps.budget ?? createJudgeBudget(deps.settings, now);
  const out: JudgedFact[] = [];
  for (const fact of facts) {
    if (fact.status !== "to_judge") {
      out.push({ ...fact, judge: null });
      continue;
    }
    const question: JudgeQuestion = fact.kind_stated === "derived" ? "derived" : "support";
    const judge = await judgeOne(fact, question, deps, {
      overCap: budget.sent >= (deps.settings?.max_facts ?? Infinity),
      failed: budget.failed,
      deadline: budget.deadline,
      now,
      count: () => {
        budget.sent += 1;
      },
    });
    if (!judge.judged && (judge.reason === "unreachable" || judge.reason === "timeout" || judge.reason === "http_error")) {
      budget.failed ??= judge.reason;
    }
    out.push({ ...fact, status: judge.judged ? "judged" : "not_judged", judge });
  }
  return out;
}

interface Run {
  readonly overCap: boolean;
  readonly failed: string | undefined;
  readonly deadline: number;
  readonly now: () => number;
  readonly count: () => void;
}

async function judgeOne(fact: FactCheck, question: JudgeQuestion, deps: JudgeDeps, run: Run): Promise<JudgeResult> {
  const own = deps.material(fact.id);
  let pair: { value: string; quote: string };
  let settings: SupportOptions["settings"] | undefined;
  let labels: SupportLabels | undefined;
  if (question === "support") {
    if (!supportReady(deps)) return notJudged(question, "no_settings");
    settings = deps.settings;
    const evidence = supportEvidence(own);
    if (!evidence) return notJudged(question, "no_evidence");
    pair = { value: own?.value ?? "", quote: evidence };
  } else {
    settings = derivedSettings(deps);
    if (!settings) return notJudged(question, "no_settings");
    labels = DERIVED_LABELS;
    const inputs = derivedInputs(fact.based_on, deps.material);
    if (inputs === null) return notJudged(question, "no_inputs");
    pair = { value: own?.value ?? "", quote: inputs };
  }
  if (run.overCap) return notJudged(question, "over_cap");
  if (run.failed !== undefined) return notJudged(question, "skipped_after_failure");
  if (run.deadline - run.now() <= 0) return notJudged(question, "out_of_time");
  run.count();
  const left = run.deadline - run.now();
  const bounded = { ...settings, timeout_ms: Math.max(1, Math.min(settings.timeout_ms, left)) };
  const result = await scoreSupport(pair, {
    settings: bounded,
    config: deps.config,
    env: deps.env,
    redaction: deps.redaction,
    fetch: deps.fetch,
    cache: deps.cache,
    signal: deps.signal,
    now: deps.now,
    labels,
  });
  return mapResult(question, result);
}

// ---------------------------------------------------------------------- policy

export type JudgePolicy = "pass" | "keep_marked" | "drop" | "show_only";

/**
 * What the contract says to do with a stored option, for t5's hand-back flow.
 *
 * - `derived`: always `show_only` while `derived_decides_drops` is false (the
 *   answer is shown, the fact stays). When it is true: an option named in
 *   `derived_passes` is `pass`, any other option `drop` (a contract without
 *   `derived_passes` passes none: it fails closed).
 * - `support`: an option in `keep_marked` is `keep_marked`, one in `drop` is
 *   `drop`, else `pass` when `passes` (the support_score pass list) names it.
 *   An option in none of the three lists is `show_only`: shown, nothing applied.
 */
export function policyFor(
  option: string,
  question: JudgeQuestion,
  strict: Pick<StrictSettings, "keep_marked" | "drop" | "derived_decides_drops" | "derived_passes">,
  passes: readonly string[],
): JudgePolicy {
  if (question === "derived") {
    if (strict.derived_decides_drops !== true) return "show_only";
    return (strict.derived_passes ?? []).includes(option) ? "pass" : "drop";
  }
  if (strict.keep_marked.includes(option)) return "keep_marked";
  if (strict.drop.includes(option)) return "drop";
  return passes.includes(option) ? "pass" : "show_only";
}

// -------------------------------------------------------------- counts, message

export interface JudgeCounts {
  /** Facts the direct check passed (no value, or a value word for word in the evidence). Never a judged fact. */
  direct_passed: number;
  /** Facts of kind llm the decider answered for. */
  llm_judged: number;
  /** Derived facts the decider answered for. */
  derived_judged: number;
  /** Facts nobody judged: the decider gave no answer, or the fact could not be sent. */
  not_judged: number;
}

/** Counts by how a fact got through, each under its own name. A judged fact never adds to `direct_passed`. */
export function countJudged(facts: readonly JudgedFact[]): JudgeCounts {
  const counts: JudgeCounts = { direct_passed: 0, llm_judged: 0, derived_judged: 0, not_judged: 0 };
  for (const fact of facts) {
    if (fact.status === "judged") {
      if (fact.judge?.question === "derived") counts.derived_judged += 1;
      else counts.llm_judged += 1;
    } else if (fact.status === "not_judged") counts.not_judged += 1;
    else if (fact.status === "passed") counts.direct_passed += 1;
  }
  return counts;
}

/**
 * The one line for the model when facts went unjudged, or null when none did.
 * Names the outage (the reasons the decider gave no answer, with the fact
 * ids), and says they are kept out of the answer as not judged, not dropped
 * as failed. A fact that could not be sent for its own sake (no evidence, too
 * long) is named by its reason in the same line.
 */
export function notJudgedMessage(facts: readonly JudgedFact[]): string | null {
  const unjudged = facts.filter((f) => f.status === "not_judged");
  if (unjudged.length === 0) return null;
  const reasons = [...new Set(unjudged.map((f) => f.judge?.reason ?? "unknown"))];
  const outage = unjudged.some((f) => OUTAGE_REASONS.has(f.judge?.reason ?? ""));
  const ids = unjudged.map((f) => f.id).join(", ");
  const lead = outage
    ? "The decider that judges llm and derived facts gave no usable answer (outage)"
    : "Some llm or derived facts could not be sent to the decider";
  return (
    `${lead}: ${reasons.join(", ")}. ` +
    `${unjudged.length} fact${unjudged.length === 1 ? "" : "s"} (${ids}) ` +
    `${unjudged.length === 1 ? "was" : "were"} kept out of the answer as not judged; ` +
    `${unjudged.length === 1 ? "it was" : "they were"} not dropped as failed.`
  );
}
