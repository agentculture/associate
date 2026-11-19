/**
 * The rendered answer shows both signals (decider-score plan task t5; spec
 * c7, h16, h1, c15).
 *
 * One group per acceptance criterion:
 *   1. for a scored fact, answer.md shows the quote-found marker and the
 *      support marker, the decider's answer in words (never a number), as
 *      separate text; a fact that was not scored says so with a plain reason;
 *   2. the text never contains the word accuracy and reads without knowledge
 *      of the mechanism behind the score;
 *   3. with no support results the answer is byte-identical to today's.
 *
 * `renderAnswer` is pure: no file, no network, no model.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadContract } from "../lib/contract.ts";
import { checkHandback } from "../lib/facts.ts";
import { SUPPORT_LEGEND, renderAnswer } from "../lib/render.ts";
import type { SupportResult } from "../lib/support.ts";
import { BAD_FACT, GOOD_FACT, READ_TEXT, SECOND_GOOD_FACT } from "./support-scenario.ts";

const QUOTE_FOUND = "quote found in the saved result";
const F1_HEAD = '- f1: ROLE_RESPONSIBILITIES — "ROLE_RESPONSIBILITIES = {" (w1, file; ';

/** A fact whose cited call has no saved result: the checker leaves it unchecked. */
const UNCHECKED_FACT = { id: "f4", value: "x y", source: "w2", quote: "not saved anywhere at all" };

const NOT_SCORED_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ["no_key", "the check was unavailable"],
  ["bad_url", "the check was unavailable"],
  ["contract_invalid", "the check was unavailable"],
  ["unreachable", "the check was unavailable"],
  ["http_error", "the check was unavailable"],
  ["malformed", "the check was unavailable"],
  ["empty_value", "no value to check"],
  ["empty_quote", "no quote to check"],
  ["too_long", "value and quote too long to check"],
  ["over_cap", "more facts than are checked per answer"],
  ["out_of_time", "no time left for the check"],
  ["timeout", "the check timed out"],
  ["aborted", "the run was stopped before the check"],
  ["skipped_after_failure", "the check was unavailable"],
];

function fixture(facts: readonly Record<string, unknown>[] = [GOOD_FACT, BAD_FACT, SECOND_GOOD_FACT]) {
  const { accuracy } = loadContract({});
  const payload = { summary: "The role table is a dict.", facts };
  const check = checkHandback(
    {
      payload,
      entries: [
        { id: "w1", tool: "read", saved_result: "results/w1.txt" } as never,
        { id: "w2", tool: "read" } as never,
      ],
      results: { w1: READ_TEXT },
      prior_runs: {},
      children: [],
    },
    accuracy,
  );
  return { payload, check, summary: payload.summary };
}

function scored(answer: string, supports = answer === "all" || answer === "mostly", confidence = 0.9): SupportResult {
  return { status: "scored", answer, supports, confidence };
}

/** The mark for each shipped option (deviation d4). */
const MARKS: ReadonlyArray<readonly [string, string]> = [
  ["all", "quote supports the value"],
  ["mostly", "quote supports the main claim; a detail of the value is not in the quote"],
  ["part", "quote shows only part of the value"],
  ["little", "quote shows little of the value"],
  ["none", "quote does not show the value"],
];

function notScored(reason: string, detail?: string): SupportResult {
  return { status: "not_scored", reason, ...(detail ? { detail } : {}) } as SupportResult;
}

function lineOf(answer: string, id: string): string {
  const line = answer.split("\n").find((l) => l.startsWith(`- ${id}: `));
  assert.ok(line, `no line for ${id} in:\n${answer}`);
  return line;
}

/** The shape associate/measure/answer.py drops as a harness-written fact line. */
const PYTHON_FACT_LINE = /^- [fvoa]\d+: .*\([^()]*; [^()]*\)$/;

// --- AC1: both markers, as separate text ----------------------------------------

test("AC1: a scored fact shows quote found and, separately, the support marker: the answer in words", () => {
  const base = fixture();
  assert.deepEqual(base.check.facts.map((f) => f.verdict), ["passed", "refused", "passed"]);
  const answer = renderAnswer({ ...base, support: [scored("all", true, 0.97), undefined, scored("part", false, 0.4)] });
  assert.equal(lineOf(answer, "f1"), `${F1_HEAD}${QUOTE_FOUND}; quote supports the value)`);
  assert.equal(
    lineOf(answer, "f3"),
    `- f3: worker — ""worker": ["execution"" (w1, file; ${QUOTE_FOUND}; quote shows only part of the value)`,
  );
});

test("AC1: each option has its own words, and no number is ever shown", () => {
  const base = fixture();
  for (const [answer, words] of MARKS) {
    for (const confidence of [0, 0.126, 0.5, 1]) {
      const text = renderAnswer({ ...base, support: [scored(answer, answer === "none", confidence), undefined, undefined] });
      assert.equal(lineOf(text, "f1"), `${F1_HEAD}${QUOTE_FOUND}; ${words})`, `${answer} ${confidence}`);
      assert.doesNotMatch(lineOf(text, "f1"), /\d\.\d|support \d/);
    }
  }
});

test("AC1: which words a scored fact gets follow its answer, not its supports flag", () => {
  const base = fixture();
  const answer = renderAnswer({ ...base, support: [scored("none", true), undefined, scored("all", false)] });
  assert.ok(lineOf(answer, "f1").endsWith("; quote does not show the value)"));
  assert.ok(lineOf(answer, "f3").endsWith("; quote supports the value)"));
});

test("AC1: an answer the renderer has no words for is shown by its key", () => {
  const base = fixture();
  const answer = renderAnswer({ ...base, support: [scored("partly", false), undefined, scored("toString", false)] });
  assert.ok(lineOf(answer, "f1").endsWith("; support answer: partly)"), lineOf(answer, "f1"));
  assert.ok(lineOf(answer, "f3").endsWith("; support answer: toString)"), lineOf(answer, "f3"));
});

test("AC1: a fact that was not scored says so with a plain reason, after the quote-found marker", () => {
  const base = fixture();
  for (const [reason, phrase] of NOT_SCORED_PHRASES) {
    const answer = renderAnswer({ ...base, support: [notScored(reason, "HTTP 503 from /v1/systemone"), undefined, undefined] });
    assert.equal(lineOf(answer, "f1"), `${F1_HEAD}${QUOTE_FOUND}; support not scored: ${phrase})`, reason);
    assert.ok(!answer.includes("503") && !answer.includes("systemone"), `${reason}: the detail is not shown`);
  }
  const odd = renderAnswer({ ...base, support: [notScored("some_new_reason"), undefined, undefined] });
  assert.equal(lineOf(odd, "f1"), `${F1_HEAD}${QUOTE_FOUND}; support not scored: the check was unavailable)`);
  for (const odd of [7, "", "  ", undefined]) {
    const shown = renderAnswer({ ...base, support: [scored(odd as never), undefined, undefined] });
    assert.equal(lineOf(shown, "f1"), `${F1_HEAD}${QUOTE_FOUND}; support not scored: the check was unavailable)`, String(odd));
  }
});

test("AC1: the two markers are separate pieces of text on the fact's line", () => {
  const base = fixture();
  const line = lineOf(renderAnswer({ ...base, support: [scored("part"), undefined, undefined] }), "f1");
  const pieces = line.slice(line.lastIndexOf("(") + 1, -1).split("; ");
  assert.deepEqual(pieces, ["w1, file", QUOTE_FOUND, "quote shows only part of the value"]);
});

test("AC1: a fact with no support result, and a fact the check did not pass, render as today", () => {
  const base = fixture([GOOD_FACT, UNCHECKED_FACT, SECOND_GOOD_FACT]);
  assert.deepEqual(base.check.facts.map((f) => f.verdict), ["passed", "unchecked", "passed"]);
  const plain = renderAnswer(base);
  // A result offered for a fact whose quote was not checked is not shown: there is no quote-found marker beside it.
  const answer = renderAnswer({ ...base, support: [scored("all"), scored("all"), undefined] });
  assert.equal(lineOf(answer, "f4"), lineOf(plain, "f4"));
  assert.equal(lineOf(answer, "f3"), lineOf(plain, "f3"));
  assert.notEqual(lineOf(answer, "f1"), lineOf(plain, "f1"));
});

test("AC1: every fact line keeps the shape the Python answer reader drops as a harness line", () => {
  const base = fixture();
  const results = [
    ...MARKS.map(([answer]) => scored(answer)),
    scored("partly"),
    ...NOT_SCORED_PHRASES.map(([reason]) => notScored(reason)),
  ];
  for (const result of results) {
    const answer = renderAnswer({ ...base, support: [result, undefined, result] });
    for (const id of ["f1", "f3"]) assert.match(lineOf(answer, id), PYTHON_FACT_LINE);
  }
});

// --- the legend -----------------------------------------------------------------

test("the legend gains one line on the support marker when at least one shown fact carries one", () => {
  const base = fixture();
  const plain = renderAnswer(base);
  assert.ok(!plain.includes(SUPPORT_LEGEND));
  for (const support of [
    [scored("all"), undefined, undefined],
    [undefined, undefined, notScored("timeout")],
  ]) {
    const lines = renderAnswer({ ...base, support }).split("\n");
    const at = lines.indexOf(SUPPORT_LEGEND);
    assert.ok(at > 0, "the legend line is there");
    assert.match(lines[at - 2], /^A fact marked "quote found" means/);
    assert.equal(lines[at - 1], "");
    assert.equal(lines[at + 1], "");
    assert.match(lines[at + 2], /^- f1: /);
  }
  assert.ok(!SUPPORT_LEGEND.includes("\n"));
  assert.match(SUPPORT_LEGEND, /separate/);
  assert.equal(
    SUPPORT_LEGEND,
    'The support mark is a second, separate check: how much of the value the quote, read on its own, shows, ' +
      'or "support not scored" when that check did not run. Neither mark means the value is true.',
  );
  assert.match(SUPPORT_LEGEND, /Neither .* means the value is true\.$/);
  // A result only for a fact that is not shown (refused) adds no legend.
  assert.equal(renderAnswer({ ...base, support: [undefined, scored("all"), undefined] }), plain);
});

// --- AC2: the wording -------------------------------------------------------------

test("AC2: the text never says accuracy and names nothing of the mechanism behind the score", () => {
  const base = fixture();
  const results = [...MARKS.map(([answer]) => scored(answer)), ...NOT_SCORED_PHRASES.map(([reason]) => notScored(reason, "detail"))];
  for (const result of results) {
    const answer = renderAnswer({ ...base, support: [result, undefined, result], finalMessage: "Done." });
    assert.doesNotMatch(answer, /accura/i, answer);
    const plain = renderAnswer({ ...base, finalMessage: "Done." }).split("\n");
    const added = answer.split("\n").filter((line) => !plain.includes(line));
    assert.ok(added.length >= 3, "the legend and two fact lines differ");
    for (const line of added) {
      const own = line.startsWith("- ") ? line.slice(line.indexOf(QUOTE_FOUND) + QUOTE_FOUND.length) : line;
      assert.doesNotMatch(own, /decider|clef|\bpass|\bfail|systemone|cut-?off|threshold|\bmodel\b|probabilit/i, own);
    }
  }
});

// --- AC3: nothing changes without a score -----------------------------------------

test("AC3: with no support results the answer is byte-identical to the answer rendered without them", () => {
  for (const facts of [
    [GOOD_FACT, BAD_FACT, SECOND_GOOD_FACT],
    [GOOD_FACT, UNCHECKED_FACT],
    [],
  ]) {
    const base = fixture(facts);
    for (const finalMessage of [undefined, "The role table is a dict. It has two roles."]) {
      const plain = renderAnswer({ ...base, finalMessage });
      assert.equal(renderAnswer({ ...base, finalMessage, support: undefined }), plain);
      assert.equal(renderAnswer({ ...base, finalMessage, support: facts.map(() => undefined) }), plain);
      assert.equal(renderAnswer({ ...base, finalMessage, support: [] }), plain);
    }
  }
});
