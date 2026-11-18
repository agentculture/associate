/**
 * The quote matcher: is a cited quote really in the saved result?
 *
 * A pure function of its inputs (issue #20, t5): no model call, no file
 * access, Node built-ins only. `associate/accuracy/matcher.py` is its twin and
 * both are tested against `associate/contract/matcher_vectors.json`. The
 * minimum quote length is an argument (`accuracy.json` `min_quote_length`);
 * this module restates no setting. A quote that is empty after normalisation is
 * refused as short whatever the minimum is, since the empty string occurs in
 * every text.
 *
 * Normalisation: each line of the quote and of the saved text loses a leading
 * `<digits><tab>` read line stamp, then every run of space, tab, newline,
 * carriage return, form feed and vertical tab becomes one space and the ends
 * are trimmed. Case and punctuation are never changed. Lengths and offsets
 * count Unicode code points, as in Python.
 *
 * Nearest span (only on a refusal for a quote absent from the saved text): with
 * `q` the normalised quote and `t` the normalised saved text, `matched` is the
 * largest k such that the first k code points of `q` occur in `t` (0 when none
 * does), `offset` the lowest position in `t` where that k-prefix occurs (0 when
 * `matched` is 0), and `text` the window of `t` that starts at `offset` and is
 * as long as `q`, clipped at the end of `t`. Prefix presence is monotone in k,
 * so a binary search over native substring search stays cheap on a 2,000,000
 * character text.
 */

export type MatchVerdict = "passed" | "refused" | "unchecked";
export type MatchReason =
  | "no_saved_text"
  | "quote_short"
  | "quote_absent"
  | "literal_not_in_quote";

export interface NearestSpan {
  readonly offset: number;
  readonly matched: number;
  readonly text: string;
}

export interface MatchResult {
  readonly verdict: MatchVerdict;
  readonly reason: MatchReason | null;
  readonly nearest: NearestSpan | null;
}

/** Strip read line stamps, collapse whitespace, trim. Case and punctuation stay. */
export function normalise(text: string): string {
  const stripped = text
    .split("\n")
    .map((line) => line.replace(/^[0-9]+\t/, ""))
    .join("\n");
  return stripped.replace(/[ \t\n\r\f\v]+/g, " ").replace(/^ +| +$/g, "");
}

/** The first `count` code points of `text`, without splitting the whole text. */
function codePointPrefix(text: string, count: number): string {
  let units = 0;
  let seen = 0;
  while (seen < count && units < text.length) {
    const code = text.codePointAt(units) as number;
    units += code > 0xffff ? 2 : 1;
    seen += 1;
  }
  return text.slice(0, units);
}

function codePointLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    count += 1;
  }
  return count;
}

function nearest(quote: string, text: string): NearestSpan {
  const quoteLength = codePointLength(quote);
  let lo = 0;
  let hi = quoteLength;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (text.includes(codePointPrefix(quote, mid))) lo = mid;
    else hi = mid - 1;
  }
  const unitOffset = lo > 0 ? text.indexOf(codePointPrefix(quote, lo)) : 0;
  const offset = codePointLength(text.slice(0, unitOffset));
  // A window never needs more than 2 UTF-16 units per code point.
  const window = codePointPrefix(text.slice(unitOffset, unitOffset + 2 * quoteLength), quoteLength);
  return { offset, matched: lo, text: window };
}

/** Check `quote` (and optional `literal`) against `savedText`. */
export function checkQuote(
  quote: string,
  literal: string | null | undefined,
  savedText: string | null | undefined,
  minQuoteLength: number,
): MatchResult {
  if (savedText === null || savedText === undefined) {
    return { verdict: "unchecked", reason: "no_saved_text", nearest: null };
  }
  const q = normalise(quote);
  // An empty quote is in every text: refused whatever the minimum (even 0 or a missing one).
  if (q === "" || codePointLength(q) < minQuoteLength) {
    return { verdict: "refused", reason: "quote_short", nearest: null };
  }
  const t = normalise(savedText);
  if (!t.includes(q)) {
    return { verdict: "refused", reason: "quote_absent", nearest: nearest(q, t) };
  }
  if (literal !== null && literal !== undefined && !q.includes(normalise(literal))) {
    return { verdict: "refused", reason: "literal_not_in_quote", nearest: null };
  }
  return { verdict: "passed", reason: null, nearest: null };
}
