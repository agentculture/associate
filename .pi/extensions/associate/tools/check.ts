/**
 * `check_quote` — ask the quote matcher whether a quote is really in the saved
 * result of an earlier call (issue #20, plan t12; spec c13/h11).
 *
 * The model names a source (a walk id such as `w12`) and the quote it intends
 * to cite; the tool answers with the verdict of `lib/matcher.ts` `checkQuote`,
 * the same function the hand-back check runs, and on a refusal for a quote
 * that is absent, the nearest span. Nothing here is a second matcher: the
 * minimum quote length comes from `accuracy.json` through the loaded contract.
 *
 * A pure read. The tool changes nothing, is not on `mutating_tools` or
 * `gated_tools`, and never opens a path of its own: the only file read is the
 * saved result `lib/results.ts` `loadSavedResult` derives from a walk id that
 * has first been matched against the walk-id pattern, so no text a model
 * supplies can become a path. A labelled reference (`prior:w12`, `c1:w3`)
 * resolves through `lib/torch.ts` `resolveRunLabel`, which looks the label up
 * (the `--continue-from` run, or a child line of this walk) and never opens a
 * name the model supplied; an unknown label is refused.
 *
 * The support score (decider-score plan t4; spec c6/h15). With the optional
 * `value` argument, and only when the score is switched on for the session
 * and the matcher found the quote, the result gains one key, `support`: the
 * answer of `lib/support.ts` `scoreSupport` for that value and quote, with a
 * `meaning` in plain words. It is asked with the session's own options
 * (`ctx.support()`), so a score sits in the same cache `finish` reads and a
 * pair scored here and handed back later is one request. The cache keeps
 * scores only: a pair that was not scored here is asked again by `finish`. A quote the
 * matcher did not find is not asked about and gets no key: the score is
 * defined for a found quote only, and the matcher's refusal already says what
 * to fix. The score changes no other key and refuses nothing.
 *
 * The pointer form (strict facts, plan t8; spec c41). Instead of `quote`, the
 * model may give `at` (`{lines: [first, last]}` or `{search: "term"}`), the
 * way a fact points at its evidence in `finish`. The tool then runs
 * `lib/evidence.ts` `resolveEvidence` over the same run data the hand-back
 * check loads (`lib/handback.ts` `loadRunData`: the walk entries and saved
 * results of the export, or of the labelled run), with the contract's
 * redaction filter, and returns what the harness would copy: the quote, the
 * command, the saved result's file name and the line numbers; or the reason
 * and the fix. An optional `value` is number-checked against the copied
 * lines, as `finish` will do. No support score is asked for in this form. The
 * quote form above is unchanged. Give `quote` or `at`, never both.
 *
 * Node builtins only; no pi runtime import, no npm dependency.
 */

import { join } from "node:path";
import { validateArgs } from "../lib/contain.ts";
import type { AssociateContext } from "../lib/context.ts";
import { resolveEvidence, runFromData, type EvidenceContext, type EvidenceRun } from "../lib/evidence.ts";
import { loadRunData } from "../lib/handback.ts";
import { checkQuote, type MatchResult } from "../lib/matcher.ts";
import { loadSavedResult } from "../lib/results.ts";
import { scoreSupport, type SupportNotScoredReason, type SupportResult } from "../lib/support.ts";
import { CONTINUE_FROM_ENV, resolveRunLabel } from "../lib/torch.ts";
import { compileRedaction } from "../lib/walk.ts";
import { fromContainError, toolError, toolResult } from "./_procs.ts";

/** The tool's name, as `models.json` `tool_names` lists it. */
export const CHECK_TOOL_NAME = "check_quote";

/** A current-run source: a walk id (`walk.schema.json` entry id). */
const CURRENT_RUN_SOURCE = /^w[1-9][0-9]*$/;
/** A labelled source, as `facts.schema.json` `source` allows: label, colon, walk id. */
const LABELLED_SOURCE = /^[A-Za-z0-9_-]+:w[1-9][0-9]*$/;

export const CHECK_QUOTE_SCHEMA = {
  type: "object",
  required: ["source"],
  properties: {
    source: {
      type: "string",
      description: "The walk id of the call whose result you cite, for example w12. Never a path.",
    },
    quote: {
      type: "string",
      description: "The exact text you intend to cite from that call's result. Give this or at, not both.",
    },
    at: {
      type: "object",
      description:
        "Instead of quote: where in that result the evidence is, exactly as a fact in finish says it. " +
        "Either lines, the first and last line (counted from 1 at the first line below the walk id line; " +
        "for a read result, the line numbers shown at the start of each line), or search, a term: " +
        "the first line that contains it exactly is the evidence. You get back what the harness would copy.",
      properties: {
        lines: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 },
        search: { type: "string" },
      },
    },
    literal: {
      type: "string",
      description: "Optional: a value (a number, a name) that the quote must contain.",
    },
    value: {
      type: "string",
      description:
        "Optional: the claim you mean the quote to support, in your own words. When the quote is found, " +
        "the result may then also say whether the quote, on its own, shows that claim. " +
        "With at, every number in it must be in the lines pointed at.",
    },
    purpose: {
      type: "string",
      description: "What you are checking and what you expect to see.",
    },
  },
} as const;

// ------------------------------------------------------------ the support key

/**
 * What the `support` key says for each answer, with what to do about it,
 * keyed by the shipped contract's option keys (deviation d4). Never a number.
 */
const QUOTE_MORE = "quote more of the source or claim less";
const ANSWER_MEANINGS: Readonly<Record<string, string>> = {
  all: "the quote shows the value",
  mostly: "the quote shows the main claim; a detail of the value is not in it; quote that detail too or leave it out",
  part: `the quote shows only part of the value; ${QUOTE_MORE}`,
  little: `the quote shows little of the value; ${QUOTE_MORE}`,
  none: "the quote does not show the value; cite the text that does, or drop the fact",
};

/**
 * Why there is no score, for a reader who does not know what answers the
 * question: no name of a service, no status code, no setting.
 */
const NOT_SCORED_WORDS: Record<SupportNotScoredReason, string> = {
  no_key: "scoring is not set up for this run",
  bad_url: "the address scoring is sent to is not usable",
  contract_invalid: "the settings scoring needs could not be read",
  empty_value: "the value is empty",
  empty_quote: "the quote is empty",
  too_long: "the value and the quote together are too long to score",
  over_cap: "the limit on scored facts was reached",
  out_of_time: "the time allowed for scoring ran out",
  timeout: "no answer came in time",
  unreachable: "scoring could not be reached",
  http_error: "scoring answered with an error",
  malformed: "the answer that came back could not be read",
  aborted: "the call was cancelled first",
  skipped_after_failure: "it was not asked, because scoring had just failed for another fact",
};

/** A support result as `check_quote` returns it: the result's own fields and what they mean. */
export type QuoteSupport =
  | { status: "scored"; answer: string; supports: boolean; confidence: number; meaning: string }
  | { status: "not_scored"; reason: SupportNotScoredReason; meaning: string };

/** The plain words for one support result. Never a judgement that the value is true. */
export function supportMeaning(result: SupportResult): string {
  if (result.status === "scored") {
    return Object.hasOwn(ANSWER_MEANINGS, result.answer)
      ? ANSWER_MEANINGS[result.answer]!
      : `the answer was ${JSON.stringify(result.answer)}; check the value against the quote, or say you cannot tell`;
  }
  const why = Object.hasOwn(NOT_SCORED_WORDS, result.reason) ? NOT_SCORED_WORDS[result.reason] : "no score could be had";
  return `not scored (${why}); this is not a judgement on the claim`;
}

/** The `support` key for one result. The result's `detail` note is for logs and is left out. */
function describeSupport(result: SupportResult): QuoteSupport {
  const meaning = supportMeaning(result);
  return result.status === "scored"
    ? { status: result.status, answer: result.answer, supports: result.supports, confidence: result.confidence, meaning }
    : { status: result.status, reason: result.reason, meaning };
}

/**
 * The `support` key for a found quote, or undefined when none is due: no
 * value was given, or the score is off for the session. The value and quote
 * go through the session's redaction filter first, as `finish` redacts a fact
 * before it scores it, so both ask about (and cache) the same text.
 */
async function supportFor(
  ctx: AssociateContext,
  value: string | undefined,
  quote: string,
  signal: unknown,
): Promise<QuoteSupport | undefined> {
  const optionsFor = ctx.support();
  if (value === undefined || !optionsFor) return undefined;
  const options = optionsFor(signal instanceof AbortSignal ? signal : undefined);
  if (!options) return describeSupport({ status: "not_scored", reason: "contract_invalid" });
  try {
    const pair = { value: options.redaction.apply(value), quote: options.redaction.apply(quote) };
    return describeSupport(await scoreSupport(pair, options));
  } catch {
    return describeSupport({ status: "not_scored", reason: "unreachable" });
  }
}

/**
 * The matcher's verdict for `quote` against the saved result of `source`.
 *
 * Throws when `source` is not a current-run walk id, before any path is built.
 * The hand-back check and the tool share this: same loader, same matcher, same
 * minimum length.
 */
export function checkSource(
  exportDir: string,
  source: string,
  quote: string,
  literal: string | null | undefined,
  minQuoteLength: number,
): MatchResult {
  if (typeof source !== "string" || !CURRENT_RUN_SOURCE.test(source)) {
    throw new Error(`not a current-run walk id: ${JSON.stringify(source)}`);
  }
  return checkQuote(quote, literal, loadSavedResult(exportDir, source), minQuoteLength);
}

/** The run data the pointer form reads: the export's walk and saved results, loaded when asked for. */
function pointerContext(
  ctx: AssociateContext,
  exportDir: string,
  labelDir: (label: string) => string | undefined,
): EvidenceContext {
  const current = runFromData(loadRunData(exportDir));
  return {
    entry: (id) => current.entry(id),
    savedResult: (name) => current.savedResult(name),
    checkoutRoot: ctx.checkoutRoot,
    redact: compileRedaction(ctx.policy).apply,
    labelled: (label): EvidenceRun | undefined => {
      const dir = labelDir(label);
      return dir === undefined ? undefined : runFromData(loadRunData(dir));
    },
    sourceKinds: ctx.contract.accuracy.source_kinds,
  };
}

export function register(
  pi: unknown,
  ctx: AssociateContext,
  env: Record<string, string | undefined> = process.env,
): void {
  const api = pi as { registerTool(definition: unknown): void };
  const minQuoteLength = ctx.contract.accuracy.min_quote_length;
  api.registerTool({
    name: CHECK_TOOL_NAME,
    label: "Check Quote",
    description:
      "Check a fact's evidence against the saved result of an earlier call, before you hand it back. " +
      "Pointer form: give the walk id (for example w12) and at ({lines: [first, last]} or {search: \"term\"}); " +
      "you get back what the harness would copy: the quote, the command, the result file and the line numbers, " +
      "or the reason it cannot and the fix. Add value to have its numbers checked against those lines. " +
      "Quote form: give the walk id and the quote; you get the matcher's verdict (passed, refused or " +
      "unchecked) and, for a quote that is absent, the nearest text that is in the result. " +
      "Optionally give value, the claim the quote is meant to support: when the quote is found, the result " +
      "may add a support key saying how much of that value the quote, on its own, shows (its answer and " +
      "what it means you should do), or that it was not scored and why. The support key is a second opinion " +
      "about the quote; it does not say the value is true. " +
      "Read-only.",
    promptSnippet: "Try a pointer (or check a quote) against the saved result of a walk entry",
    promptGuidelines: ["Use the walk id, never a path. Run it before you hand a fact back."],
    parameters: CHECK_QUOTE_SCHEMA,
    async execute(_id: string, rawParams: Record<string, unknown>, signal?: unknown) {
      const invalid = validateArgs(CHECK_QUOTE_SCHEMA as Record<string, unknown>, rawParams ?? {});
      if (invalid) return toolResult(fromContainError(invalid));
      const params = (rawParams ?? {}) as {
        source: string;
        quote?: string;
        at?: unknown;
        literal?: string;
        value?: string;
      };
      if (params.at !== undefined && params.quote !== undefined) {
        return toolResult(
          toolError("quote_and_at", "give quote or at, not both", { field: "at" }, "point with at, or quote, not both"),
        );
      }
      if (params.at === undefined && typeof params.quote !== "string") {
        return toolResult(
          toolError(
            "quote_or_at",
            "give the quote to check, or at to say where the evidence is",
            { field: "quote" },
            "pass quote (text from the result) or at ({lines: [first, last]} or {search: \"term\"})",
          ),
        );
      }
      const quote = params.quote ?? "";
      // The matcher's answer, with the support key added for a found quote when one is due.
      const answer = async (result: MatchResult) => {
        const support = result.verdict === "passed" ? await supportFor(ctx, params.value, quote, signal) : undefined;
        const payload = { source: params.source, ...result, ...(support ? { support } : {}) };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
          details: { ...payload, args_used: { source: params.source } },
        };
      };

      // The pointer form: what the harness would copy for this fact, or why not.
      const pointer = (labelDir: string | undefined) => {
        const evidence = resolveEvidence(
          { source: params.source, at: params.at, ...(params.value !== undefined ? { value: params.value } : {}) },
          pointerContext(ctx, ctx.session.exportDir, () => labelDir),
        );
        const payload = evidence.ok
          ? {
              source: params.source,
              ok: evidence.ok,
              quote: evidence.quote,
              command: evidence.command,
              result_file: evidence.result_file,
              lines: evidence.lines,
              run: evidence.run,
              source_kind: evidence.source_kind,
            }
          : {
              source: params.source,
              // A pointer that cannot be resolved is an answer, not a tool error.
              ok: evidence.ok,
              reason: evidence.reason,
              message: evidence.message,
              fix: evidence.fix,
            };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
          details: { ...payload, args_used: { source: params.source, at: params.at } },
        };
      };

      if (LABELLED_SOURCE.test(params.source)) {
        // A label is looked up (lib/torch.ts), never opened: only `prior` and
        // the child ids of this session's walk name a directory.
        const [label, walkId] = params.source.split(":") as [string, string];
        const walkPath = ctx.walk()?.walkPath ?? join(ctx.session.exportDir, "walk.jsonl");
        const run = resolveRunLabel(label, { continueFrom: env[CONTINUE_FROM_ENV]?.trim() || undefined, walkPath });
        if (!run.ok) {
          return toolResult(
            toolError(
              "source_not_resolvable",
              `'${params.source}' cannot be resolved: ${run.message}`,
              { field: "source" },
              "cite a walk id from this run, such as w12, or a label this session was given (prior, c1, …)",
            ),
          );
        }
        if (params.at !== undefined) return pointer(run.dir);
        return answer(checkSource(run.dir, walkId, quote, params.literal, minQuoteLength));
      }
      if (!CURRENT_RUN_SOURCE.test(params.source)) {
        return toolResult(
          toolError(
            "invalid_source",
            `'${params.source}' is not a walk id; a source is w1, w2, … and never a path`,
            { field: "source" },
            "pass the walk id of the call whose result you quote, such as w12",
          ),
        );
      }

      if (params.at !== undefined) return pointer(undefined);
      return answer(checkSource(ctx.session.exportDir, params.source, quote, params.literal, minQuoteLength));
    },
  });
}
