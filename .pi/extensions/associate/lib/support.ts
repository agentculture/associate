/**
 * The support-score client (decider-score spec c3/h12, c22/h8, c25/h20,
 * c28/h23).
 *
 * Asks the lobes decider one yes/no question about one fact: does the quote,
 * on its own, state or directly show the value. The answer is a number in
 * [0, 1], reported with whether it is at or above the contract's cut-off, or
 * the fact is `not_scored` with a machine reason. It is a signal for a report
 * and refuses nothing.
 *
 * This is a client of its own, not the safety gate. It shares only the
 * decider's address and headers with `lib/gate.ts` (`buildClefRequest`). It
 * has one tier: there is no second model to ask and no fallback that answers
 * in the decider's place, so a missing key, a timeout, a non-2xx answer or a
 * malformed answer is `not_scored` and never a score. It records nothing: no
 * walk line, no gate id, no file. What a caller does with a result is the
 * caller's business.
 *
 * Every setting is an argument. The question wording, the cut-off, the
 * per-fact timeout, the cap on scored facts and the total time come from
 * `accuracy.json` as a `SupportScoreSettings`; the decider's input limit and
 * address come from the compiled `gate.json` (`GateConfig`); the redaction
 * filter is the policy's. Whether the score is switched on at all is decided
 * by the caller before it calls here.
 *
 * What is sent: a state of two labelled lines, `value:` and `quote:`, each a
 * JSON string of the redacted text, so a quote (text from a file, a command
 * or a web page, picked by the model) can never start what reads as another
 * labelled line. A pair that does not fit the decider's input limit is not
 * sent at all; nothing is ever sent cut short.
 *
 * Pure library: no top-level side effect, `fetch` injected, and the cache an
 * object the caller owns for one session.
 */

import type { SupportScoreSettings } from "./contract.ts";
import { TEMPLATE_RESERVE_TOKENS, buildClefRequest } from "./gate.ts";
import type { Env, GateConfig } from "./gate.ts";
import type { RedactionFilter } from "./walk.ts";

// ---------------------------------------------------------------------- types

/** The key the one question travels under, and the key its answer is read from. A wire name, not a setting. */
export const SUPPORT_QUESTION_KEY = "support";

/** Why a fact has no score. */
export type SupportNotScoredReason =
  /** `ASSOCIATE_API_KEY` is not set; nothing was sent. */
  | "no_key"
  /** The base URL could not be parsed; nothing was sent. */
  | "bad_url"
  /** The gate contract (the decider's address and input limit) failed to compile; nothing was sent. */
  | "contract_invalid"
  /** The value is empty or only whitespace; nothing was sent. */
  | "empty_value"
  /** The quote is empty or only whitespace; nothing was sent. */
  | "empty_quote"
  /** Value and quote do not fit the decider's input limit; nothing was sent. */
  | "too_long"
  /** The hand-back's cap on scored facts was reached; nothing was sent. */
  | "over_cap"
  /** The hand-back's total scoring time was spent before an answer came. */
  | "out_of_time"
  /** The decider did not answer within the per-fact time. */
  | "timeout"
  /** The request failed before any answer (connection refused, DNS, …). */
  | "unreachable"
  /** The decider answered with a non-2xx status. */
  | "http_error"
  /** The answer was not JSON, or held no yes/no probability in [0, 1] for the question. */
  | "malformed"
  /** The caller's own signal ended the request. */
  | "aborted"
  /**
   * Not sent: an earlier request of the same batch came back `unreachable`,
   * `timeout` or `http_error`, so the rest of that batch was not sent to a
   * decider that had just failed. A later batch or ask tries again.
   */
  | "skipped_after_failure";

export interface SupportScored {
  readonly status: "scored";
  /** The decider's probability of yes, in [0, 1]. */
  readonly score: number;
  /** Whether `score` is at or above the contract's cut-off. */
  readonly at_or_above_cutoff: boolean;
}

export interface SupportNotScored {
  readonly status: "not_scored";
  readonly reason: SupportNotScoredReason;
  /** A short human-readable note (an HTTP status, a size); never the value or the quote. */
  readonly detail?: string;
}

export type SupportResult = SupportScored | SupportNotScored;

/** One fact's value and the quote offered for it. */
export interface SupportPair {
  readonly value: string;
  readonly quote: string;
}

/**
 * One session's scores, keyed by the exact value and quote. The caller makes
 * one per session with {@link createSupportCache} and hands it to every call,
 * so a fact scored once (in a retry round, by `check_quote` before a
 * hand-back) is not sent again. Only a score is kept: a not-scored result is
 * dropped once it is known, so a later ask tries again.
 */
export interface SupportCache {
  /** Distinct pairs held: each scored pair, and any still being asked. */
  readonly size: number;
  clear(): void;
  /** Internal to this module. */
  readonly entries: Map<string, Promise<SupportResult>>;
}

export interface SupportOptions {
  /** `accuracy.json`'s support-score settings, as `supportScoreSettings` returns them. */
  readonly settings: SupportScoreSettings;
  /** The compiled gate contract: the decider's path, header, domain and input limit. */
  readonly config: GateConfig;
  /** `ASSOCIATE_BASE_URL` and `ASSOCIATE_API_KEY` are read from here. */
  readonly env: Env;
  /** The policy redaction filter; value and quote go through it before sending. */
  readonly redaction: RedactionFilter;
  readonly fetch: typeof fetch;
  /** The session's cache. Without one, every ask is a request. */
  readonly cache?: SupportCache;
  /** The caller's own cancellation. */
  readonly signal?: AbortSignal;
  /** The clock, in epoch milliseconds; `Date.now` when absent. */
  readonly now?: () => number;
}

/** The request this module sends: the gate's address and headers, one question. */
export interface SupportRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: {
    readonly model: string;
    readonly state: string;
    readonly questions: Record<string, { readonly type: "noul"; readonly instructions: string }>;
  };
}

// --------------------------------------------------------------------- pieces

export function createSupportCache(): SupportCache {
  const entries = new Map<string, Promise<SupportResult>>();
  return {
    entries,
    get size() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "unprintable error";
  }
}

function notScored(reason: SupportNotScoredReason, detail?: string): SupportNotScored {
  return detail === undefined ? { status: "not_scored", reason } : { status: "not_scored", reason, detail };
}

/**
 * One field as a JSON string on one line. `JSON.stringify` escapes the C0
 * controls and the double quote; DEL, the C1 controls, U+2028 and U+2029 are
 * escaped here as well, so no character that breaks a line survives.
 */
function oneLineJson(text: string): string {
  return JSON.stringify(text).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** The state for one pair: redacted first (while still multi-line), then one labelled line each. */
export function buildSupportState(redaction: RedactionFilter, pair: SupportPair): string {
  return [
    `value: ${oneLineJson(redaction.apply(pair.value))}`,
    `quote: ${oneLineJson(redaction.apply(pair.quote))}`,
  ].join("\n");
}

function supportQuestions(settings: SupportScoreSettings): SupportRequest["body"]["questions"] {
  return { [SUPPORT_QUESTION_KEY]: { type: "noul", instructions: settings.question } };
}

/**
 * The `POST` to the decider: the gate's URL, headers and body `model`
 * (`buildClefRequest`), with the gate's questions replaced by the one
 * support question. Throws on a base URL that cannot be parsed.
 */
export function buildSupportRequest(
  config: GateConfig,
  settings: SupportScoreSettings,
  state: string,
  env: Env,
): SupportRequest {
  const base = buildClefRequest(config, state, env);
  return {
    url: base.url,
    headers: base.headers,
    body: { model: base.body.model, state, questions: supportQuestions(settings) },
  };
}

/**
 * Whether the state and the question fit the decider's input limit, counted
 * like the gate counts: one token per UTF-8 byte (a byte-level tokenizer
 * never emits more tokens than bytes), with the gate's reserve held back for
 * the decider's own prompt template.
 */
function stateBytesOver(config: GateConfig, settings: SupportScoreSettings, state: string): number {
  const budget =
    config.maxInputTokens - byteLength(JSON.stringify(supportQuestions(settings))) - TEMPLATE_RESERVE_TOKENS;
  return byteLength(state) - budget;
}

/** Read the score from a response body, or `undefined` when it is not there in the right shape. */
function readScore(body: unknown): number | undefined {
  if (!isRecord(body) || !isRecord(body.answers)) return undefined;
  const answer = body.answers[SUPPORT_QUESTION_KEY];
  if (!isRecord(answer) || answer.type !== "noul" || !isUnit(answer.noul)) return undefined;
  return answer.noul;
}

/** Why a request was stopped; set once, by whichever stop comes first. */
type Stop = "timeout" | "out_of_time" | "aborted";

/** A signal that stops after `ms`, or when `outer` does. `stopped()` says which came first. */
function stopAfter(
  ms: number,
  onExpiry: Stop,
  outer?: AbortSignal,
): { signal: AbortSignal; stopped: () => Stop | undefined; done: () => void } {
  const controller = new AbortController();
  let why: Stop | undefined;
  const stop = (reason: Stop) => {
    if (why !== undefined) return;
    why = reason;
    controller.abort(new Error(reason));
  };
  const timer = setTimeout(() => stop(onExpiry), Math.max(0, ms));
  const onAbort = () => stop("aborted");
  if (outer?.aborted) onAbort();
  else outer?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    stopped: () => why,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    },
  };
}

/** Race `promise` against `signal`, so a callee that ignores the signal still stops on time. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// ------------------------------------------------------------------- one pair

/** The checks that need no decider. A result here means nothing is sent. */
function localResult(pair: SupportPair, options: SupportOptions): { state: string } | SupportNotScored {
  if (typeof pair?.value !== "string" || pair.value.trim() === "") return notScored("empty_value");
  if (typeof pair.quote !== "string" || pair.quote.trim() === "") return notScored("empty_quote");
  const state = buildSupportState(options.redaction, pair);
  const over = stateBytesOver(options.config, options.settings, state);
  if (over > 0) return notScored("too_long", `${over} bytes over the decider's input limit`);
  return { state };
}

/** Send one state and read the answer. `deadline` (epoch ms) is a batch's total-time bound. */
async function ask(state: string, options: SupportOptions, deadline?: number): Promise<SupportResult> {
  const { settings } = options;
  if ((options.env.ASSOCIATE_API_KEY ?? "").trim() === "") return notScored("no_key");
  if (options.signal?.aborted) return notScored("aborted");

  let request: SupportRequest;
  try {
    request = buildSupportRequest(options.config, settings, state, options.env);
  } catch (error) {
    return notScored("bad_url", errorText(error));
  }

  // The per-fact time, or what is left of the batch's total when that is less.
  const now = options.now ?? Date.now;
  const left = deadline === undefined ? Infinity : deadline - now();
  if (left <= 0) return notScored("out_of_time");
  const bounded = left < settings.timeout_ms;
  const timer = stopAfter(bounded ? left : settings.timeout_ms, bounded ? "out_of_time" : "timeout", options.signal);
  const { signal } = timer;
  try {
    let response: Response;
    try {
      response = await raceAbort(
        Promise.resolve().then(() =>
          options.fetch(request.url, {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal,
          }),
        ),
        signal,
      );
    } catch (error) {
      const why = timer.stopped();
      return why ? notScored(why) : notScored("unreachable", errorText(error));
    }
    if (!response.ok) return notScored("http_error", `HTTP ${response.status}`);
    let text: string;
    try {
      text = await raceAbort(response.text(), signal);
    } catch (error) {
      const why = timer.stopped();
      return why ? notScored(why) : notScored("unreachable", errorText(error));
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return notScored("malformed", "the answer is not JSON");
    }
    const score = readScore(body);
    if (score === undefined) return notScored("malformed", "the answer holds no yes/no probability");
    return { status: "scored", score, at_or_above_cutoff: score >= settings.cutoff };
  } finally {
    timer.done();
  }
}

function cacheKey(pair: SupportPair): string {
  return JSON.stringify([pair.value, pair.quote]);
}

/**
 * Ask through the session cache. Only a score is kept (review finding 2): a
 * not-scored result of any kind — a timeout, an HTTP error, a malformed
 * answer, the batch's time running out, no key — is dropped once known, so a
 * later ask for the pair tries again. Two asks for one pair at the same time
 * share the request.
 */
function askCached(pair: SupportPair, state: string, options: SupportOptions, deadline?: number): Promise<SupportResult> {
  const entries = options.cache?.entries;
  if (!entries) return ask(state, options, deadline);
  const key = cacheKey(pair);
  const held = entries.get(key);
  if (held) return held;
  const forget = () => {
    if (entries.get(key) === pending) entries.delete(key);
  };
  const pending: Promise<SupportResult> = ask(state, options, deadline).then(
    (result) => {
      if (result.status !== "scored") forget();
      return result;
    },
    (error) => {
      forget();
      throw error;
    },
  );
  entries.set(key, pending);
  return pending;
}

/**
 * Score one value and quote. Never throws for anything the decider or the
 * network does: every failure is a `not_scored` result with its reason.
 */
export async function scoreSupport(pair: SupportPair, options: SupportOptions): Promise<SupportResult> {
  const local = localResult(pair, options);
  if ("status" in local) return local;
  return askCached(pair, local.state, options);
}

// ---------------------------------------------------------------------- batch

/** Wait for `promise` no longer than `ms`; `undefined` when the time ran out first. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  if (ms === Infinity) return promise;
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** The failures after which one batch sends nothing more: the decider is down or failing, not one answer odd. */
const STOPS_BATCH: ReadonlySet<SupportNotScoredReason> = new Set(["unreachable", "timeout", "http_error"]);

/**
 * Score the facts of one hand-back, in order, one request at a time (the
 * decider serves one at a time and the safety gate shares it). Returns one
 * result per pair, in the order given.
 *
 * Two bounds from the contract apply to the whole call. The cap: only the
 * first `max_facts` pairs that get as far as the decider or the cache are
 * answered, and the rest are `over_cap`; a pair refused locally (empty, too
 * long) takes no place, and a cached pair does, so the same list gives the
 * same split on every round. The total time: once `total_timeout_ms` has
 * gone by since the call began, no request starts, a request in flight is
 * stopped, and each fact without an answer is `out_of_time` (one already in
 * the cache is still returned from it).
 *
 * One failure bound applies to this call only: after the first answer that is
 * `unreachable`, `timeout` or `http_error`, no further request is sent, and
 * each later pair not already in the cache is `skipped_after_failure`. None
 * of these is kept, so the next call (a retry round, a `check_quote`) tries
 * again.
 */
export async function scoreSupportBatch(
  pairs: readonly SupportPair[],
  options: SupportOptions,
): Promise<SupportResult[]> {
  const { settings } = options;
  const now = options.now ?? Date.now;
  const deadline = now() + settings.total_timeout_ms;
  const results: SupportResult[] = [];
  let taken = 0;
  let failed: SupportNotScoredReason | undefined;
  for (const pair of pairs) {
    const local = localResult(pair, options);
    if ("status" in local) {
      results.push(local);
      continue;
    }
    if (taken >= settings.max_facts) {
      results.push(notScored("over_cap"));
      continue;
    }
    taken += 1;
    const result = await batchResult(pair, local.state, options, deadline, failed);
    if (result.status === "not_scored" && STOPS_BATCH.has(result.reason)) failed ??= result.reason;
    results.push(result);
  }
  return results;
}

/** One pair's result inside a batch: from the cache, skipped after a failure, out of time, or asked. */
async function batchResult(
  pair: SupportPair,
  state: string,
  options: SupportOptions,
  deadline: number,
  failed: SupportNotScoredReason | undefined,
): Promise<SupportResult> {
  const now = options.now ?? Date.now;
  const held = options.cache?.entries.get(cacheKey(pair));
  const left = deadline - now();
  if (!held && failed !== undefined) return notScored("skipped_after_failure", `not sent after ${failed}`);
  if (!held && left <= 0) return notScored("out_of_time");
  // A held entry may be another caller's request still in flight: wait for
  // it no longer than this call's own time.
  const result = await within(held ?? askCached(pair, state, options, deadline), Math.max(0, left));
  return result ?? notScored("out_of_time");
}
