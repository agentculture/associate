/**
 * Builds `associate/contract/strict_vectors.json`: shared cases for a second
 * implementation of the strict hand-back check (the Python re-check in
 * evidence-cli). See docs/notes/strict-vectors.md for the file's shape.
 *
 * The expected result of every case is produced by RUNNING the extension's
 * own code: `runStrict` (lib/strict.ts) over the case's walk, saved results,
 * labelled runs and finish payload, with a fake decider that returns the
 * case's stored answers. Nothing here is written by hand except the inputs.
 * The file therefore records what the extension does, not what it should do;
 * a reviewer checks the expectations against the rule.
 *
 *   node --experimental-strip-types scripts/strict_vectors.ts --write
 *
 * rewrites the file; without `--write` it prints whether the committed file
 * is current (exit 1 when it is not). The extension test
 * `tests/strict-vectors.test.ts` regenerates in memory and fails on any
 * difference. No model, network, file outside this repo or environment value
 * is read.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadContract } from "../.pi/extensions/associate/lib/contract.ts";
import type { ContractAccuracy } from "../.pi/extensions/associate/lib/contract.ts";
import type { ChildRun, HandbackInput, RunData } from "../.pi/extensions/associate/lib/facts.ts";
import { derivedInputs, supportEvidence } from "../.pi/extensions/associate/lib/judge.ts";
import type { JudgedFact, StrictSettings } from "../.pi/extensions/associate/lib/judge.ts";
import { associateRoot } from "../.pi/extensions/associate/lib/paths.ts";
import { evidenceContextFor, runStrict, strictReport, type StrictJudge } from "../.pi/extensions/associate/lib/strict.ts";
import { compileRedaction } from "../.pi/extensions/associate/lib/walk.ts";

export const VECTORS_PATH = join(associateRoot, "associate", "contract", "strict_vectors.json");

// ------------------------------------------------------------------- inputs

type Entry = Record<string, unknown> & { id: string; tool: string };
interface Run {
  walk: Entry[];
  /** Saved result text by file name (`results/wN.txt`, as the entry's `saved_result` names it). */
  results: Record<string, string>;
}
type Stored = { question: "support" | "derived"; option: string } | { not_judged: string };

interface CaseDef {
  name: string;
  note: string;
  checkout_root?: string;
  run: Run;
  prior_runs?: Record<string, Run>;
  children?: Array<Run & { label: string }>;
  finish: { facts: unknown[]; verdicts?: unknown[]; open_items?: unknown[] };
  decider?: Record<string, Stored>;
  returned_before?: string[];
  rounds_left?: number;
  contract?: { retry_rounds?: number; min_quote_length?: number };
}

const ROOT = "/home/someone/git/proj";

const LS: Run = {
  walk: [{ id: "w1", tool: "ls", args: { path: `${ROOT}/lib`, purpose: "list lib" }, args_used: { path: `${ROOT}/lib` }, saved_result: "results/w1.txt" }],
  results: { "results/w1.txt": "alpha.ts\nbeta.ts\ngamma.ts\ndelta.ts\n" },
};

const ROLES_TEXT = [
  "1\tROLE_RESPONSIBILITIES = {",
  '2\t    "worker": ["execution", "tool_use"],',
  '3\t    "senses": ["intake"],',
  "4\t}",
  "",
].join("\n");
const ROLES: Run = {
  walk: [
    {
      id: "w1",
      tool: "read",
      args: { path: `${ROOT}/lib/roles.py`, purpose: "read the role table" },
      args_used: { path: `${ROOT}/lib/roles.py` },
      saved_result: "results/w1.txt",
    },
  ],
  results: { "results/w1.txt": ROLES_TEXT },
};

/** The measured colleague case: `ls tests` whose saved result is the line 604. */
const COUNT: Run = {
  walk: [{ id: "w1", tool: "bash", args: { argv: ["ls", "tests"], purpose: "count the tests" }, args_used: { argv: ["ls", "tests"] }, saved_result: "results/w1.txt" }],
  results: { "results/w1.txt": "604\n" },
};

const PYTEST: Run = {
  walk: [
    {
      id: "w1",
      tool: "run_tests",
      args: { purpose: "run the suite" },
      args_used: { argv: ["pytest", "-q"] },
      saved_result: "results/w1.txt",
    },
  ],
  results: { "results/w1.txt": "collected 13 items\n12 passed, 1 skipped in 0.51s\n" },
};

const at = (first: number, last = first) => ({ lines: [first, last] });
const search = (term: string) => ({ search: term });
const support = (option: string): Stored => ({ question: "support", option });
const derived = (option: string): Stored => ({ question: "derived", option });

const F604 = { id: "f1", kind: "direct", source: "w1", at: at(1), value: "There are 604 test files" };

const CASES: CaseDef[] = [
  // --- pointers, and the direct-or-worded rule
  {
    name: "lines_pointer_no_value",
    note: "A lines pointer and no value: the harness copies lines 2 to 3; direct, never judged.",
    run: LS,
    finish: { facts: [{ id: "f1", source: "w1", at: at(2, 3) }] },
  },
  {
    name: "search_pointer_value_copied",
    note: "A search pointer copies the first line holding the term; the value is that line word for word: direct.",
    run: LS,
    finish: { facts: [{ id: "f1", kind: "direct", source: "w1", at: search("gamma"), value: "gamma.ts" }] },
  },
  {
    name: "value_ends_trimmed_is_direct",
    note: "Leading and trailing whitespace of the value is trimmed before the substring test: direct.",
    run: LS,
    finish: { facts: [{ id: "f1", source: "w1", at: search("beta"), value: "  beta.ts\n" }] },
  },
  {
    name: "value_case_differs_is_worded",
    note: "The comparison is case-sensitive: 'Beta.ts' is not in 'beta.ts', so it is worded and judged (all: pass).",
    run: LS,
    finish: { facts: [{ id: "f1", kind: "direct", source: "w1", at: search("beta"), value: "Beta.ts" }] },
    decider: { f1: support("all") },
  },
  {
    name: "value_inner_whitespace_differs_is_worded",
    note: "Whitespace inside the value must match exactly: two spaces where the line has one is worded (mostly: pass).",
    run: PYTEST,
    finish: { facts: [{ id: "f1", source: "w1", at: at(2), value: "12 passed,  1 skipped" }] },
    decider: { f1: support("mostly") },
  },
  {
    name: "stated_llm_value_copied_is_direct",
    note: "A fact stating llm whose value is word for word in the copied line is direct and not judged.",
    run: ROLES,
    finish: { facts: [{ id: "f1", kind: "llm", source: "w1", at: at(2), value: "tool_use" }] },
  },
  {
    name: "worded_all_pass",
    note: "A value in the model's own words, answered all: passes as llm.",
    run: PYTEST,
    finish: { facts: [{ id: "f1", kind: "llm", source: "w1", at: search("passed"), value: "The suite passed 12 tests and skipped 1" }] },
    decider: { f1: support("all") },
  },
  {
    name: "worded_mostly_pass",
    note: "Answered mostly: passes as llm (mostly is in support_score.passes).",
    run: PYTEST,
    finish: { facts: [{ id: "f1", kind: "llm", source: "w1", at: search("passed"), value: "Twelve tests passed and 1 was skipped" }] },
    decider: { f1: support("mostly") },
  },
  {
    name: "604_part_first_time_returned",
    note: "The 604 case: a count in the model's own words, stated direct, judged with the command; part the first time: returned.",
    run: COUNT,
    finish: { facts: [F604] },
    decider: { f1: support("part") },
  },
  {
    name: "604_part_returned_before_kept_marked",
    note: "The same fact answered part after it was returned in an earlier round: kept with the mark.",
    run: COUNT,
    finish: { facts: [F604] },
    decider: { f1: support("part") },
    returned_before: ["f1"],
    rounds_left: 1,
  },
  {
    name: "604_part_no_round_left_kept_marked",
    note: "Answered part with no round left: kept with the mark instead of returned.",
    run: COUNT,
    finish: { facts: [F604] },
    decider: { f1: support("part") },
    rounds_left: 0,
  },
  {
    name: "604_little_first_time_returned",
    note: "Answered little (also a keep_marked option) the first time: returned.",
    run: COUNT,
    finish: { facts: [F604] },
    decider: { f1: support("little") },
  },
  {
    name: "604_none_dropped",
    note: "Answered none: dropped (decider_drop).",
    run: COUNT,
    finish: { facts: [F604] },
    decider: { f1: support("none") },
  },
  {
    name: "604_bare_number_is_direct",
    note: "The value 604 is word for word in the line: direct, whatever the command counted.",
    run: COUNT,
    finish: { facts: [{ id: "f1", kind: "llm", source: "w1", at: at(1), value: "604" }] },
  },
  {
    name: "number_absent",
    note: "A number in the value that the copied line does not show drops the fact for any stated kind, before the decider.",
    run: COUNT,
    finish: { facts: [{ id: "f1", kind: "llm", source: "w1", at: at(1), value: "There are 605 test files" }] },
  },
  {
    name: "number_thousands_separator",
    note: "1,234 in the value and 1234 in the evidence are the same number token; the value is worded and judged.",
    run: {
      walk: [{ id: "w1", tool: "bash", args_used: { argv: ["wc", "-l", "lib/big.ts"] }, args: { argv: ["wc", "-l", "lib/big.ts"], purpose: "count" }, saved_result: "results/w1.txt" }],
      results: { "results/w1.txt": "1234 lib/big.ts\n" },
    },
    finish: { facts: [{ id: "f1", kind: "llm", source: "w1", at: at(1), value: "lib/big.ts has 1,234 lines" }] },
    decider: { f1: support("all") },
  },
  {
    name: "pointer_out_of_range",
    note: "Lines past the end of a whole result: dropped (pointer_out_of_range), whatever the kind.",
    run: LS,
    finish: { facts: [{ id: "f1", kind: "llm", source: "w1", at: at(5, 6), value: "two more files" }] },
  },
  {
    name: "search_not_found",
    note: "A search term in no line of a whole result: dropped (search_not_found).",
    run: LS,
    finish: { facts: [{ id: "f1", source: "w1", at: search("epsilon") }] },
  },
  {
    name: "result_cut",
    note: "A partial (cut) result: lines before the last kept line are copied; the last kept line or beyond is result_cut.",
    run: {
      walk: [{ id: "w1", tool: "bash", args_used: { argv: ["cat", "notes.txt"] }, args: { argv: ["cat", "notes.txt"], purpose: "read" }, saved_result: "results/w1.txt", partial: true }],
      results: { "results/w1.txt": "line one\nline two\nline thr" },
    },
    finish: {
      facts: [
        { id: "f1", source: "w1", at: at(1, 2) },
        { id: "f2", source: "w1", at: at(3) },
        { id: "f3", source: "w1", at: at(4, 5) },
        { id: "f4", source: "w1", at: search("line four") },
      ],
    },
  },
  {
    name: "read_shown_line_numbers",
    note: "A read result is counted by the line numbers it shows: [3401, 3402] copies those stamped lines; [1, 2] is out of range.",
    run: {
      walk: [
        {
          id: "w1",
          tool: "read",
          args: { path: `${ROOT}/lib/big.ts`, start_line: 3400, end_line: 3402, purpose: "read the end" },
          args_used: { path: `${ROOT}/lib/big.ts`, start_line: 3400, end_line: 3402 },
          saved_result: "results/w1.txt",
        },
      ],
      results: { "results/w1.txt": "3400\tfunction a() {}\n3401\tconst b = 2;\n3402\tconst c = 3;\n" },
    },
    finish: {
      facts: [
        { id: "f1", source: "w1", at: at(3401, 3402) },
        { id: "f2", source: "w1", at: search("const c"), value: "const c = 3" },
        { id: "f3", source: "w1", at: at(1, 2) },
      ],
    },
  },
  // --- labelled sources
  {
    name: "prior_source_present",
    note: "A prior: source resolves in the prior run's walk and saved result.",
    run: LS,
    prior_runs: { prior: ROLES },
    finish: { facts: [{ id: "f1", source: "prior:w1", at: at(1), value: "ROLE_RESPONSIBILITIES" }] },
  },
  {
    name: "prior_source_absent",
    note: "A prior: source with no prior run loaded: the checker refuses it as an unknown source before any pointer is resolved.",
    run: LS,
    finish: { facts: [{ id: "f1", source: "prior:w1", at: at(1), value: "ROLE_RESPONSIBILITIES" }] },
  },
  {
    name: "child_source_present",
    note: "A child label (c1:w1) resolves in that child's walk and saved result.",
    run: ROLES,
    children: [{ label: "c1", ...LS }],
    finish: { facts: [{ id: "f1", source: "c1:w1", at: search("beta") }] },
  },
  {
    name: "child_source_absent",
    note: "A child label no child carries: refused as an unknown source.",
    run: ROLES,
    children: [{ label: "c1", ...LS }],
    finish: { facts: [{ id: "f1", source: "c2:w1", at: search("beta") }] },
  },
  {
    name: "unknown_source",
    note: "A walk id the walk never recorded, and a path given as a source: both dropped.",
    run: LS,
    finish: {
      facts: [
        { id: "f1", source: "w9", at: at(1) },
        { id: "f2", source: "lib/a.ts", at: at(1) },
      ],
    },
  },
  {
    name: "no_saved_result",
    note: "A pointer into a call whose result was not saved: dropped (no_saved_result).",
    run: { walk: [{ id: "w1", tool: "ls", args_used: { path: "lib" }, args: { path: "lib", purpose: "list" } }], results: {} },
    finish: { facts: [{ id: "f1", source: "w1", at: at(1) }] },
  },
  // --- old-shape facts under strict
  {
    name: "old_shape_found_direct",
    note: "An old-shape fact (a typed quote, no at) whose quote the matcher finds and whose value is inside the quote: direct.",
    run: ROLES,
    finish: { facts: [{ id: "f1", source: "w1", value: "ROLE_RESPONSIBILITIES", quote: "ROLE_RESPONSIBILITIES = {" }] },
  },
  {
    name: "old_shape_found_worded_judged",
    note: "An old-shape fact whose value is not inside its quote: judged against the quote alone (no command line).",
    run: ROLES,
    finish: { facts: [{ id: "f1", kind: "direct", source: "w1", value: "senses handles intake", quote: '"senses": ["intake"]' }] },
    decider: { f1: support("all") },
  },
  {
    name: "old_shape_not_found",
    note: "An old-shape fact whose quote is not in the result: dropped (quote_absent) even though it states llm.",
    run: ROLES,
    finish: { facts: [{ id: "f1", kind: "llm", source: "w1", value: "senses handles intake", quote: "senses is responsible for all intake" }] },
  },
  {
    name: "old_shape_number_absent",
    note: "An old-shape fact whose quote is found but whose value states a number the quote does not show: number_absent.",
    run: PYTEST,
    finish: { facts: [{ id: "f1", kind: "llm", source: "w1", value: "13 tests passed", quote: "12 passed, 1 skipped in 0.51s" }] },
  },
  // --- shape failures
  {
    name: "shape_unknown_kind",
    note: "A kind that is not direct, llm or derived: dropped (kind_unknown).",
    run: LS,
    finish: { facts: [{ id: "f1", kind: "guess", source: "w1", at: search("beta"), value: "beta.ts" }] },
  },
  {
    name: "shape_no_at_no_quote",
    note: "Neither at nor quote: dropped (pointer_missing).",
    run: LS,
    finish: { facts: [{ id: "f1", source: "w1", value: "beta.ts" }] },
  },
  {
    name: "shape_lines_and_search",
    note: "Both lines and search in at: dropped (pointer_malformed).",
    run: LS,
    finish: { facts: [{ id: "f1", source: "w1", at: { lines: [1, 1], search: "beta" } }] },
  },
  {
    name: "shape_llm_without_value",
    note: "An llm fact with no value: dropped (value_missing), although with no value the copied text alone would be direct.",
    run: LS,
    finish: { facts: [{ id: "f1", kind: "llm", source: "w1", at: at(2) }] },
  },
  {
    name: "shape_derived_without_based_on",
    note: "A derived fact with no based_on: dropped (based_on_missing) and never sent to the decider.",
    run: LS,
    finish: { facts: [{ id: "f1", kind: "derived", source: "w1", at: at(2), value: "lib holds a beta module" }] },
  },
  // --- the based_on graph
  {
    name: "based_on_unknown_id",
    note: "based_on names f7, which no fact has: f2 fails (based_on_unknown) and f3, based on f2, is dropped naming f2.",
    run: LS,
    finish: {
      facts: [
        { id: "f1", source: "w1", at: at(2) },
        { id: "f2", kind: "derived", source: "w1", at: at(2), value: "lib has a beta module", based_on: ["f1", "f7"] },
        { id: "f3", kind: "derived", source: "w1", at: at(2), value: "lib is not empty", based_on: ["f2"] },
      ],
    },
  },
  {
    name: "based_on_cycle",
    note: "f1 and f2 name each other: both fail (based_on_cycle); f3, based on f2, is dropped naming f2.",
    run: LS,
    finish: {
      facts: [
        { id: "f1", kind: "derived", source: "w1", at: at(1), value: "lib has alpha", based_on: ["f2"] },
        { id: "f2", kind: "derived", source: "w1", at: at(2), value: "lib has beta", based_on: ["f1"] },
        { id: "f3", kind: "derived", source: "w1", at: at(3), value: "lib has gamma", based_on: ["f2"] },
      ],
    },
  },
  {
    name: "cascade_chain_names_root",
    note: "f3 rests on f2, which rests on f1, whose pointer fails: both drops name f1 (the root); the order is f1, f2, f3.",
    run: LS,
    finish: {
      facts: [
        { id: "f3", kind: "derived", source: "w1", at: at(3), value: "lib has three or more files", based_on: ["f2"] },
        { id: "f2", kind: "derived", source: "w1", at: at(2), value: "lib has two or more files", based_on: ["f1"] },
        { id: "f1", source: "w1", at: at(9) },
      ],
    },
  },
  {
    name: "derived_each_answer",
    note: "Derived facts answered yes, partly and no: each is shown with its answer and none is dropped (derived_decides_drops false).",
    run: COUNT,
    finish: {
      facts: [
        { id: "f1", source: "w1", at: at(1) },
        { id: "f2", kind: "derived", source: "w1", at: at(1), value: "the tests directory is large", based_on: ["f1"] },
        { id: "f3", kind: "derived", source: "w1", at: at(1), value: "every test passes", based_on: ["f1"] },
        { id: "f4", kind: "derived", source: "w1", at: at(1), value: "there are no tests", based_on: ["f1"] },
      ],
    },
    decider: { f2: derived("yes"), f3: derived("partly"), f4: derived("no") },
  },
  {
    name: "derived_on_decider_dropped_fact",
    note: "A derived fact resting on a fact the decider answered none: dropped by the cascade, naming that fact, and never sent to the decider (it stores no answer).",
    run: COUNT,
    finish: {
      facts: [
        F604,
        { id: "f2", kind: "derived", source: "w1", at: at(1), value: "the suite is large", based_on: ["f1"] },
      ],
    },
    decider: { f1: support("none") },
  },
  {
    name: "direct_on_decider_dropped_fact",
    note: "A direct fact (its own check passed) resting on a fact the decider answered none: dropped by the last cascade, and not counted as direct_passed.",
    run: COUNT,
    finish: {
      facts: [F604, { id: "f2", source: "w1", at: at(1), based_on: ["f1"] }],
    },
    decider: { f1: support("none") },
  },
  {
    name: "derived_with_failed_pointer",
    note: "A derived fact whose own pointer fails is dropped for that reason; it is never judged.",
    run: LS,
    finish: {
      facts: [
        { id: "f1", source: "w1", at: at(1) },
        { id: "f2", kind: "derived", source: "w1", at: at(9), value: "lib has nine files", based_on: ["f1"] },
      ],
    },
  },
  // --- the decider out, verdicts and open items
  {
    name: "decider_outage_not_judged",
    note: "The decider gave no answer: worded facts are not judged (kept out, not dropped); a verdict on one is not judged; a verdict on a direct fact passes.",
    run: PYTEST,
    finish: {
      facts: [
        { id: "f1", kind: "llm", source: "w1", at: at(2), value: "most tests passed" },
        { id: "f2", kind: "llm", source: "w1", at: at(1), value: "the suite has 13 tests" },
        { id: "f3", source: "w1", at: at(2) },
      ],
      verdicts: [
        { id: "v1", text: "Most tests pass.", verdict: "supported", basis: ["f1"] },
        { id: "v2", text: "The run finished.", verdict: "supported", basis: ["f3"] },
      ],
    },
    decider: { f1: { not_judged: "unreachable" }, f2: { not_judged: "skipped_after_failure" } },
  },
  {
    name: "verdicts_on_dropped_facts",
    note: "A verdict on a fact the checker refused is dropped (basis_refused); on a fact the decider dropped or returned, basis_dropped; an open item likewise.",
    run: COUNT,
    finish: {
      facts: [
        { id: "f1", source: "w1", at: at(4) },
        { id: "f2", kind: "llm", source: "w1", at: at(1), value: "the directory has 604 test modules" },
        { id: "f3", kind: "llm", source: "w1", at: at(1), value: "there are 604 tests to run" },
        { id: "f4", source: "w1", at: at(1) },
      ],
      verdicts: [
        { id: "v1", text: "Rests on a refused fact.", verdict: "supported", basis: ["f1"] },
        { id: "v2", text: "Rests on a dropped fact.", verdict: "supported", basis: ["f2"] },
        { id: "v3", text: "Rests on a returned fact.", verdict: "supported", basis: ["f3"] },
        { id: "v4", text: "Rests on a direct fact.", verdict: "supported", basis: ["f4"] },
      ],
      open_items: [{ id: "o1", text: "What does 604 count?", check: "run ls tests | grep -c test_", basis: ["f2"] }],
    },
    decider: { f2: support("none"), f3: support("part") },
  },
  // --- the command
  {
    name: "command_relative_and_redacted",
    note: "Paths under the checkout or its run worktrees print relative, other home paths as ~, token-looking values redacted; an entry without args_used falls back to args.",
    run: {
      walk: [
        {
          id: "w1",
          tool: "bash",
          args: { argv: ["grep", "-rn", "token=abcd1234efgh5678", "lib"], cwd: ROOT, purpose: "find the token" },
          args_used: {
            argv: ["grep", "-rn", "token=abcd1234efgh5678", `${ROOT}/lib`, "/home/someone/git/.worktrees.proj/run-1/lib"],
            cwd: ROOT,
          },
          saved_result: "results/w1.txt",
        },
        { id: "w2", tool: "read", args: { path: "/home/someone/notes/todo.txt", purpose: "read my notes" }, saved_result: "results/w2.txt" },
      ],
      results: { "results/w1.txt": "lib/a.ts:3:found\n", "results/w2.txt": "1\tship it\n" },
    },
    finish: {
      facts: [
        { id: "f1", source: "w1", at: at(1) },
        { id: "f2", source: "w2", at: at(1) },
      ],
    },
  },
];

// ------------------------------------------------------------------ running

function toRunData(run: Run): RunData {
  const results: Record<string, string> = {};
  for (const [name, text] of Object.entries(run.results)) {
    const m = /^results\/(w[1-9][0-9]*)\.txt$/.exec(name);
    if (!m) throw new Error(`saved result name ${name} is not results/wN.txt`);
    results[m[1]!] = text;
  }
  return { entries: run.walk, results };
}

function toolsOf(def: CaseDef): string[] {
  const runs = [def.run, ...Object.values(def.prior_runs ?? {}), ...(def.children ?? [])];
  return [...new Set(runs.flatMap((r) => r.walk.map((e) => e.tool)))].sort();
}

function pick<T extends Record<string, unknown>>(record: T, keys: readonly string[]): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (Object.hasOwn(record, key)) out[key] = record[key];
  return out as Partial<T>;
}

async function buildCase(def: CaseDef, base: ContractAccuracy, redact: (t: string) => string) {
  const strictBase = base.strict as unknown as StrictSettings;
  const retryRounds = def.contract?.retry_rounds ?? (base.retry_rounds as number);
  const minQuote = def.contract?.min_quote_length ?? (base.min_quote_length as number);
  const sourceKinds = pick(base.source_kinds as Record<string, string>, toolsOf(def));
  const contract = {
    strict: {
      keep_marked: strictBase.keep_marked,
      drop: strictBase.drop,
      mark_text: strictBase.mark_text,
      derived_decides_drops: strictBase.derived_decides_drops,
    },
    support_passes: base.support_score!.passes,
    min_quote_length: minQuote,
    retry_rounds: retryRounds,
    source_kinds: sourceKinds,
  };
  const accuracy = { ...base, retry_rounds: retryRounds, min_quote_length: minQuote, source_kinds: sourceKinds } as ContractAccuracy;
  const roundsLeft = def.rounds_left ?? retryRounds;
  const checkoutRoot = def.checkout_root ?? ROOT;

  const payload = { facts: def.finish.facts, verdicts: def.finish.verdicts ?? [], open_items: def.finish.open_items ?? [] };
  const handbackInput: HandbackInput = {
    payload,
    ...toRunData(def.run),
    prior_runs: Object.fromEntries(Object.entries(def.prior_runs ?? {}).map(([label, run]) => [label, toRunData(run)])),
    children: (def.children ?? []).map((c): ChildRun => ({ label: c.label, payload: { facts: [] }, ...toRunData(c) })),
  };

  const decider = def.decider ?? {};
  const asked = new Set<string>();
  const sent = new Map<string, { question: string; value: string; evidence: string }>();
  const judge: StrictJudge = async (facts, material) =>
    facts.map((f): JudgedFact => {
      if (f.status !== "to_judge") return { ...f, judge: null };
      const question = f.kind_stated === "derived" ? "derived" : "support";
      const own = material(f.id);
      const evidence = question === "support" ? supportEvidence(own) : derivedInputs(f.based_on, material);
      if (!evidence) throw new Error(`${def.name}: ${f.id} would not be sent (no evidence text); give it evidence`);
      sent.set(f.id, { question, value: own?.value ?? "", evidence });
      const stored = decider[f.id];
      if (stored === undefined) throw new Error(`${def.name}: ${f.id} is judged but the case stores no decider answer`);
      asked.add(f.id);
      if ("not_judged" in stored) {
        return { ...f, status: "not_judged", judge: { question, option: null, judged: false, reason: stored.not_judged as never, confidence: null } };
      }
      if (stored.question !== question) throw new Error(`${def.name}: ${f.id} is asked the ${question} question, the case stores ${stored.question}`);
      return { ...f, status: "judged", judge: { question, option: stored.option, judged: true, reason: null, confidence: null } };
    });

  const { check, decision } = await runStrict({
    handbackInput,
    accuracy,
    settings: { ...strictBase, ...contract.strict },
    passes: contract.support_passes,
    evidence: evidenceContextFor(handbackInput, { checkoutRoot, redact, sourceKinds: sourceKinds as never }),
    judge,
    returnedBefore: new Set(def.returned_before ?? []),
    canReturn: roundsLeft > 0,
    round: retryRounds - roundsLeft + 1,
  });
  for (const id of Object.keys(decider)) {
    if (!asked.has(id)) throw new Error(`${def.name}: the case stores a decider answer for ${id}, which is never judged`);
  }

  const items = (list: typeof decision.items.verdicts) =>
    list.map((v) => ({ id: v.id, outcome: v.outcome, reason: v.reason, strict_outcome: v.strict_outcome, strict_reason: v.strict_reason }));
  const fromRun = (run: Run) => ({ walk: run.walk, results: run.results });

  return {
    name: def.name,
    note: def.note,
    input: {
      checkout_root: checkoutRoot,
      walk: def.run.walk,
      results: def.run.results,
      prior_runs: Object.fromEntries(Object.entries(def.prior_runs ?? {}).map(([label, run]) => [label, fromRun(run)])),
      children: (def.children ?? []).map((c) => ({ label: c.label, ...fromRun(c) })),
      finish: payload,
      contract,
      decider,
      returned_before: def.returned_before ?? [],
      rounds_left: roundsLeft,
    },
    expect: {
      facts: decision.facts.map((f) => ({
        id: f.id,
        kind_stated: f.kind_stated,
        kind_checked: f.kind_checked,
        worded: f.worded ?? null,
        status: f.status,
        strict_outcome: f.strict_outcome,
        drop_reason: f.drop_reason,
        dropped_by: f.dropped_by,
        evidence: f.evidence
          ? {
              quote: f.evidence.quote,
              command: f.evidence.command,
              command_from: f.evidence.command_from,
              result_file: f.evidence.result_file,
              lines: f.evidence.lines,
              run: f.evidence.run,
            }
          : null,
        judge: f.judge ? { question: f.judge.question, option: f.judge.option, reason: f.judge.reason } : null,
        sent: sent.get(f.id) ?? null,
      })),
      graph: { order: check.graph.order, refusals: check.graph.refusals.map((r) => ({ reason: r.reason, fact: r.fact, ids: r.ids })) },
      verdicts: items(decision.items.verdicts),
      open_items: items(decision.items.open_items),
      counts: decision.counts,
      drop_reasons: decision.drop_reasons,
      judge_counts: decision.judge_counts,
      report: strictReport(decision),
    },
  };
}

/** The whole file's content, built by running the extension's code over every case. */
export async function buildStrictVectors(): Promise<string> {
  const contract = loadContract({});
  const filter = compileRedaction(contract.policy);
  const policy = contract.policy as unknown as { redaction: { replacement: string; patterns: string[] } };
  const names = new Set<string>();
  const cases = [];
  for (const def of CASES) {
    if (names.has(def.name)) throw new Error(`duplicate case name ${def.name}`);
    names.add(def.name);
    cases.push(await buildCase(def, contract.accuracy, filter.apply));
  }
  const doc = {
    $comment:
      "Shared cases for the strict hand-back check (plan deviation d3). Generated by scripts/strict_vectors.ts, which runs the " +
      "extension's own runStrict with a fake decider returning each case's stored answers; held byte-identical in evidence-cli. " +
      "The shape is described in docs/notes/strict-vectors.md. Do not edit by hand: change the inputs in the script and regenerate.",
    version: 1,
    redaction: { replacement: policy.redaction.replacement, patterns: policy.redaction.patterns },
    cases,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const text = await buildStrictVectors();
  if (process.argv.includes("--write")) {
    writeFileSync(VECTORS_PATH, text);
    console.log(`wrote ${VECTORS_PATH}`);
  } else {
    let current = "";
    try {
      current = readFileSync(VECTORS_PATH, "utf8");
    } catch {
      current = "";
    }
    console.log(current === text ? "strict_vectors.json is current" : "strict_vectors.json differs; run with --write");
    process.exitCode = current === text ? 0 : 1;
  }
}
