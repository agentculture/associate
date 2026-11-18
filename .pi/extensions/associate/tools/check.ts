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
 * Node builtins only; no pi runtime import, no npm dependency.
 */

import { join } from "node:path";
import { validateArgs } from "../lib/contain.ts";
import type { AssociateContext } from "../lib/context.ts";
import { checkQuote, type MatchResult } from "../lib/matcher.ts";
import { loadSavedResult } from "../lib/results.ts";
import { CONTINUE_FROM_ENV, resolveRunLabel } from "../lib/torch.ts";
import { fromContainError, toolError, toolResult } from "./_procs.ts";

/** The tool's name, as `models.json` `tool_names` lists it. */
export const CHECK_TOOL_NAME = "check_quote";

/** A current-run source: a walk id (`walk.schema.json` entry id). */
const CURRENT_RUN_SOURCE = /^w[1-9][0-9]*$/;
/** A labelled source, as `facts.schema.json` `source` allows: label, colon, walk id. */
const LABELLED_SOURCE = /^[A-Za-z0-9_-]+:w[1-9][0-9]*$/;

export const CHECK_QUOTE_SCHEMA = {
  type: "object",
  required: ["source", "quote"],
  properties: {
    source: {
      type: "string",
      description: "The walk id of the call whose result you quote, for example w12. Never a path.",
    },
    quote: {
      type: "string",
      description: "The exact text you intend to cite from that call's result.",
    },
    literal: {
      type: "string",
      description: "Optional: a value (a number, a name) that the quote must contain.",
    },
    purpose: {
      type: "string",
      description: "What you are checking and what you expect to see.",
    },
  },
} as const;

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
      "Check that a quote really appears in the saved result of an earlier call, before you cite it. " +
      "Give the walk id (for example w12) and the quote; you get the matcher's verdict (passed, refused or " +
      "unchecked) and, for a quote that is absent, the nearest text that is in the result. Read-only.",
    promptSnippet: "Check a quote against the saved result of a walk entry",
    promptGuidelines: ["Use the walk id, never a path. Run it before you hand a fact back."],
    parameters: CHECK_QUOTE_SCHEMA,
    async execute(_id: string, rawParams: Record<string, unknown>) {
      const invalid = validateArgs(CHECK_QUOTE_SCHEMA as Record<string, unknown>, rawParams ?? {});
      if (invalid) return toolResult(fromContainError(invalid));
      const params = (rawParams ?? {}) as { source: string; quote: string; literal?: string };

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
        const result = checkSource(run.dir, walkId, params.quote, params.literal, minQuoteLength);
        const payload = { source: params.source, ...result };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
          details: { ...payload, args_used: { source: params.source } },
        };
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

      const result = checkSource(ctx.session.exportDir, params.source, params.quote, params.literal, minQuoteLength);
      const payload = { source: params.source, ...result };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        details: { ...payload, args_used: { source: params.source } },
      };
    },
  });
}
