/**
 * Replays of two measured colleague runs under strict facts (strict-facts plan
 * t9; spec c9, h4, c35, h22).
 *
 * Both fixtures are cut from the stored exports of the broad-task runs of
 * 2026-11-19 (`tests/fixtures/accuracy/strict_*.json`, each with an `_origin`
 * field saying what was cut). No decider is called: the 604 replay drives
 * `runStrict` with a fake judge, and the other replay drives the real `finish`
 * tool against a fake `fetch` that counts requests (it must see none).
 *
 * THE 604 REPLAY. In the measured run (check-off, repeat r1) the model handed
 * back a fact "604 test files in tests/" with the quote `total":604`. That
 * REAL fact is old-shape and passed the old check, because the quote is in the
 * saved result of w7. The call behind it is an `ls` of tests/, whose result
 * lists up to 200 entries and says `total":604`: 604 entries (files and
 * directories, test or not), not 604 test files. The strict fact used here
 * (`constructed_strict_fact`) is CONSTRUCTED: it is the fact a model would have
 * had to hand back under strict (a pointer to the line of w7 that holds the
 * number, the recorded value as the model worded it). The recorded sentence
 * "across 604 test files" is real free text of that run's summary, kept in the
 * fixture for the record; no check reads it.
 *
 * What the strict check CATCHES here:
 *   - a number that is not in the cited result (605 against a result that says
 *     604): dropped as number_absent, before the decider;
 *   - a pointer that does not resolve: dropped (search_not_found);
 *   - any value in the model's own words, whatever it states: it reaches the
 *     decider, and what the decider is sent includes the `command:` line, so
 *     it can see that the number came from `ls tests` (shown as `ls path=tests`).
 * What it does NOT catch:
 *   - the check itself cannot tell that 604 entries are not 604 test files.
 *     Whether the decider can is NOT shown here: the fake answers what the
 *     test tells it, so test (d) shows only that the outcome follows the
 *     answer (part: returned once, then kept with the mark; none: dropped;
 *     all: passes). A passed fact still never means the value is true.
 *
 * THE NO-FACT-PASSED REPLAY. In the measured run (check-off, repeat r3) the
 * model handed back 10 old-shape facts, a verdict resting on all of them, and
 * none of the facts passed the old check (each quote joined pieces of the
 * result with "..." or was reworded). Under strict an old-shape fact whose
 * quote is not found is dropped, so the answer holds no fact. The test drives
 * the stored hand-back through the real `finish` tool of a loaded extension
 * and compares the export it writes with the committed one
 * (`strict_colleague_no_fact_passed_export/`, read by tests/test_strict_replay.py).
 * Regenerate that export with `ASSOCIATE_WRITE_REPLAY_EXPORT=1` before the
 * run, and review the diff. Walk ids are kept as recorded: the 13 calls of
 * the stored run that no fact cites are stood in for by one-line placeholder
 * results so w3, w4, w5, w12 and w18 get the ids the facts name.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContract } from "../lib/contract.ts";
import { associateRoot } from "../lib/paths.ts";
import type { HandbackInput } from "../lib/facts.ts";
import { supportEvidence, type FactMaterial, type JudgedFact } from "../lib/judge.ts";
import { compileRedaction } from "../lib/walk.ts";
import { SUPPORT_QUESTION_KEY } from "../lib/support.ts";
import { DROPPED_FILENAME, evidenceContextFor, runStrict, type StrictJudge } from "../lib/strict.ts";
import { loadExtension } from "./load-extension.ts";
import { callFinish, fireFinalMessage, startPrompt } from "./support-scenario.ts";

const CONTRACT = loadContract({});
const { accuracy } = CONTRACT;
const STRICT = accuracy.strict!;
const FIXTURES = join(associateRoot, "tests", "fixtures", "accuracy");
const fixture = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

// ------------------------------------------------------------------ 604

const FX604 = fixture("strict_604_colleague_ls.json");
const F604 = FX604.constructed_strict_fact;

function fakeJudge(answers: Record<string, string>, seen: Array<{ id: string; material: FactMaterial | undefined }> = []): StrictJudge {
  return async (facts, material) =>
    facts.map((f): JudgedFact => {
      if (f.status !== "to_judge") return { ...f, judge: null };
      seen.push({ id: f.id, material: material(f.id) });
      return { ...f, status: "judged", judge: { question: "support", option: answers[f.id]!, judged: true, reason: null, confidence: 0.9 } };
    });
}

function run604(facts: unknown[], judge: StrictJudge, options: Partial<{ returnedBefore: Set<string>; canReturn: boolean }> = {}) {
  const handbackInput: HandbackInput = { payload: { facts }, entries: FX604.walk, results: FX604.results, prior_runs: {}, children: [] };
  return runStrict({
    handbackInput,
    accuracy,
    settings: STRICT,
    passes: accuracy.support_score!.passes,
    evidence: evidenceContextFor(handbackInput, {
      checkoutRoot: "/nonexistent/checkout",
      redact: compileRedaction(CONTRACT.policy).apply,
      sourceKinds: accuracy.source_kinds,
    }),
    judge,
    returnedBefore: options.returnedBefore ?? new Set(),
    canReturn: options.canReturn ?? true,
    round: 1,
  });
}

test("604 replay, recorded: the old fact was a quote found in the result, and the stored call is the listing of tests/", () => {
  assert.equal(FX604.recorded_fact.value, "604 test files in tests/");
  assert.equal(FX604.recorded_fact.quote, 'total":604');
  assert.ok(FX604.results.w7.includes(FX604.recorded_fact.quote), "the old check found the quote, so it passed");
  assert.equal(FX604.walk[0].tool, "ls");
  assert.deepEqual(FX604.walk[0].args_used, { path: "tests" });
  assert.match(FX604.recorded_sentence.text, /across 604 test files/);
});

test("604 replay (a): the pointer resolves and the number is found in the cited result", async () => {
  const { decision } = await run604([F604], fakeJudge({ f11: "all" }));
  const f = decision.facts[0]!;
  assert.notEqual(f.drop_reason, "number_absent");
  assert.notEqual(f.drop_reason, "search_not_found");
  assert.ok(f.evidence, "the pointer resolved: evidence was copied");
  assert.equal(f.evidence!.result_file, "results/w7.txt");
  assert.ok(f.evidence!.quote.includes('"total":604'), "the copied line holds the number");
});

test("604 replay (b): the command shown is the listing of entries as the walk recorded it, and its result lists entries of every kind", async () => {
  const { decision } = await run604([F604], fakeJudge({ f11: "all" }));
  const evidence = decision.facts[0]!.evidence!;
  assert.equal(evidence.command, "ls path=tests");
  assert.equal(evidence.command_from, "args_used");
  // What the number counts: entries (the copied line shows directories and non-test files too, and says the listing was capped).
  assert.ok(evidence.quote.includes('"name":"conftest.py"'));
  assert.ok(evidence.quote.includes('"type":"directory"'));
  assert.ok(evidence.quote.includes('"cap":200,"truncated":true,"total":604'));
});

test("604 replay (c): the value in the model's wording is judged by the decider, and what it is sent includes the command line", async () => {
  const seen: Array<{ id: string; material: FactMaterial | undefined }> = [];
  const { decision } = await run604([F604], fakeJudge({ f11: "all" }, seen));
  const f = decision.facts[0]!;
  assert.equal(f.kind_stated, "direct", "the model stated no kind; the wording decides, not the stated kind");
  assert.equal(f.worded, true);
  assert.equal(f.kind_checked, "llm");
  assert.equal(seen.length, 1, "it went to the decider");
  assert.equal(seen[0]!.material!.value, "604 test files in tests/");
  assert.equal(seen[0]!.material!.command, "ls path=tests");
  const sent = supportEvidence(seen[0]!.material);
  assert.ok(sent.startsWith("command: ls path=tests\n"), "the first line of the evidence is the command");
  assert.ok(sent.includes('"total":604'));
});

test("604 replay (d): the outcome follows the decider's answer (a fake here): part is returned once then kept with the mark, none is dropped, all passes", async () => {
  const first = await run604([F604], fakeJudge({ f11: "part" }));
  assert.equal(first.decision.facts[0]!.strict_outcome, "returned");

  const again = await run604([F604], fakeJudge({ f11: "part" }), { returnedBefore: new Set(["f11"]) });
  assert.equal(again.decision.facts[0]!.strict_outcome, "keep_marked");
  assert.equal(again.decision.facts[0]!.mark, STRICT.mark_text);

  const none = await run604([F604], fakeJudge({ f11: "none" }));
  assert.equal(none.decision.facts[0]!.strict_outcome, "dropped");
  assert.equal(none.decision.dropped[0]!.reason, "decider_drop");

  // Not shown by this test: whether the real decider says 'none' or 'part' to
  // "604 test files" beside the listing (shown as `ls path=tests`). With 'all' the fact passes although 604
  // entries are not 604 test files; the check cannot tell that itself.
  const all = await run604([F604], fakeJudge({ f11: "all" }));
  assert.equal(all.decision.facts[0]!.strict_outcome, "pass");
});

test("604 replay (e): the bare number, or no value, is direct and never sent to the decider", async () => {
  const seen: Array<{ id: string; material: FactMaterial | undefined }> = [];
  const { decision } = await run604(
    [
      { id: "f1", source: "w7", at: { search: '"total":604' }, value: "604" },
      { id: "f2", source: "w7", at: { search: '"total":604' } },
    ],
    fakeJudge({}, seen),
  );
  assert.deepEqual(decision.facts.map((f) => [f.strict_outcome, f.kind_checked, f.worded]), [["pass", "direct", false], ["pass", "direct", false]]);
  assert.deepEqual(seen, []);
});

test("604 replay (what it catches): a number not in the result, and a pointer that does not resolve, are dropped before the decider", async () => {
  const seen: Array<{ id: string; material: FactMaterial | undefined }> = [];
  const { decision } = await run604(
    [
      { ...F604, id: "f1", value: "605 test files in tests/" },
      { ...F604, id: "f2", at: { search: '"total":605' } },
    ],
    fakeJudge({ f1: "all", f2: "all" }, seen),
  );
  assert.deepEqual(decision.dropped.map((d) => [d.id, d.reason]), [["f1", "number_absent"], ["f2", "search_not_found"]]);
  assert.deepEqual(seen, [], "neither was sent");
});

// ------------------------------------------------------------ no fact passed

const FXNONE = fixture("strict_colleague_no_fact_passed.json");
const EXPORT_NAME = "strict_colleague_no_fact_passed_export";
const COMMITTED_EXPORT = join(FIXTURES, EXPORT_NAME);
const WRITE_ENV = "ASSOCIATE_WRITE_REPLAY_EXPORT";
const SESSION = "strict-replay-colleague";
const PLACEHOLDER = "(this call of the stored run is not kept in the fixture; no fact cites it)";
const FIXED_TS = "1970-01-01T00:00:00.000Z";

/** The export files the replay compares and commits (the walk and its results, the check records, the answer). */
const EXPORT_FILES = ["facts.json", "check.json", "report.json", DROPPED_FILENAME, "answer.md", "final_message.md"];

function textOfFiles(dir: string, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) out[name] = readFileSync(join(dir, name), "utf8");
  return out;
}

/** The walk with its clock fields fixed, so two replays write the same bytes. */
function normalizedWalk(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const entry = JSON.parse(line);
      if (typeof entry.ts === "string") entry.ts = FIXED_TS;
      if (entry.run && typeof entry.run.duration_ms === "number") entry.run.duration_ms = 0;
      return JSON.stringify(entry);
    })
    .join("\n")
    .concat("\n");
}

/** Replay the stored hand-back through the real finish tool; returns the export directory and what the fake decider saw. */
async function replayNoFactPassed(): Promise<{ exportDir: string; deciderCalls: number; dispose: () => void }> {
  const root = mkdtempSync(join(tmpdir(), "associate-replay-runs-"));
  const checkout = mkdtempSync(join(tmpdir(), "associate-replay-checkout-"));
  const originalFetch = globalThis.fetch;
  let deciderCalls = 0;
  globalThis.fetch = (async () => {
    deciderCalls += 1;
    return new Response(JSON.stringify({ model: "clef", answers: { [SUPPORT_QUESTION_KEY]: { type: "choice", choice: "all", confidence: 0.9, probabilities: { all: 0.9 } } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const loaded = await loadExtension({
    ASSOCIATE_EXPORT_ROOT: root,
    ASSOCIATE_CHECKOUT_ROOT: checkout,
    ASSOCIATE_SESSION_ID: SESSION,
    ASSOCIATE_INJECT_PROMPT: undefined,
    ASSOCIATE_CONTINUE_FROM: undefined,
    ASSOCIATE_MODEL: undefined,
    ASSOCIATE_CHECK_MODE: undefined,
    ASSOCIATE_SUPPORT_SCORE: undefined,
    ASSOCIATE_STRICT: undefined, // strict as the contract sets it for worker
    ASSOCIATE_API_KEY: "test-key",
    ASSOCIATE_BASE_URL: undefined,
  });
  const dispose = () => {
    loaded.cleanup();
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  };
  try {
    const { pi } = loaded;
    await pi.fireSessionStart();
    await startPrompt(pi, "summarise the colleague repository");
    const byId = new Map<number, any>(FXNONE.walk.map((e: any) => [Number(e.id.slice(1)), e]));
    const last = Math.max(...byId.keys());
    for (let n = 1; n <= last; n += 1) {
      const kept = byId.get(n);
      await pi.fireToolResult({
        toolCallId: `tc-${n}`,
        toolName: kept ? kept.tool : "ls",
        input: kept ? kept.args : { path: ".", purpose: "placeholder for a call not kept in this fixture" },
        content: [{ type: "text", text: kept ? FXNONE.results[kept.id] : PLACEHOLDER }],
      });
    }
    await callFinish(pi, "fin-1", FXNONE.finish);
    await fireFinalMessage(pi, FXNONE.final_message);
    return { exportDir: join(root, SESSION, "export"), deciderCalls, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

test("no-fact-passed replay: the stored old-shape hand-back is dropped under strict, counted, and the answer says how many and why", async () => {
  const replay = await replayNoFactPassed();
  try {
    const decider = () => replay.deciderCalls;
    const read = (name: string): any => JSON.parse(readFileSync(join(replay.exportDir, name), "utf8"));
    const facts = FXNONE.finish.facts;
    assert.equal(facts.length, 10);
    assert.equal(FXNONE.finish.verdicts.length, 1);

    // The old shape: quotes, no pointers; the decider is never asked (no fact is both found and worded).
    assert.ok(facts.every((f: any) => typeof f.quote === "string" && f.at === undefined));
    assert.equal(decider(), 0, "no fact reached the decider");

    // dropped.json: each item with its reason.
    const dropped = read(DROPPED_FILENAME);
    assert.deepEqual(dropped.dropped.map((d: any) => [d.id, d.item, d.reason]), [
      ...facts.map((f: any) => [f.id, "fact", "quote_absent"]),
      ["v1", "verdict", "basis_refused"],
    ]);
    assert.deepEqual(dropped.returned, []);
    assert.deepEqual(dropped.not_judged, []);
    assert.ok(dropped.dropped.every((d: any) => typeof d.fix === "string" && d.fix.length > 0));

    // check.json: the counts the run result carries.
    const check = read("check.json");
    assert.equal(check.mode, "strict");
    assert.deepEqual(check.strict.counts, { pass: 0, keep_marked: 0, returned: 0, dropped: 10, not_judged: 0 });
    assert.deepEqual(check.strict.drop_reasons, { quote_absent: 10, basis_refused: 1 });
    assert.deepEqual(check.strict.dropped.map((d: any) => d.id), dropped.dropped.map((d: any) => d.id));

    // report.json: the strict object.
    const report = read("report.json");
    assert.equal(report.strict.dropped.total, 10);
    assert.deepEqual(report.strict.dropped.by_reason, { quote_absent: 10 });
    assert.equal(report.strict.direct_passed, 0);
    assert.equal(report.strict.judged, 0);

    // The rendered answer states the count and the reasons, and holds no fact.
    const answer = readFileSync(join(replay.exportDir, "answer.md"), "utf8");
    assert.match(answer, /No fact or conclusion is in the answer\./);
    assert.match(answer, /11 items were dropped \(10 quote_absent, 1 basis_refused\); dropped\.json in the export lists each with its reason and fix\./);
    assert.doesNotMatch(answer, /## Facts/);
    assert.match(answer, /## Unchecked: the model's own words/);

    // The export is the committed one (regenerate with ASSOCIATE_WRITE_REPLAY_EXPORT=1 and review the diff).
    const generated: Record<string, string> = {
      ...textOfFiles(replay.exportDir, EXPORT_FILES),
      "walk.jsonl": normalizedWalk(join(replay.exportDir, "walk.jsonl")),
    };
    const resultsDir = join(replay.exportDir, "results");
    for (const name of readdirSync(resultsDir).sort()) generated[`results/${name}`] = readFileSync(join(resultsDir, name), "utf8");
    for (const [name, text] of Object.entries(generated)) {
      assert.ok(!/\/tmp\/|\/home\/|associate-replay-/.test(text), `${name} holds no machine path`);
    }
    if (process.env[WRITE_ENV] === "1") {
      rmSync(COMMITTED_EXPORT, { recursive: true, force: true });
      mkdirSync(join(COMMITTED_EXPORT, "results"), { recursive: true });
      for (const [name, text] of Object.entries(generated)) writeFileSync(join(COMMITTED_EXPORT, name), text, "utf8");
    }
    assert.ok(existsSync(COMMITTED_EXPORT), `${EXPORT_NAME} is committed (run once with ${WRITE_ENV}=1)`);
    for (const [name, text] of Object.entries(generated)) {
      assert.equal(readFileSync(join(COMMITTED_EXPORT, name), "utf8"), text, `${name} equals the committed export`);
    }
    const committed = readdirSync(COMMITTED_EXPORT).filter((n) => n !== "results").sort();
    assert.deepEqual(committed, Object.keys(generated).filter((n) => !n.startsWith("results/")).sort(), "no stray committed file");
  } finally {
    replay.dispose();
  }
});

test("no-fact-passed replay: the stored results are cut, so the fixture's quotes still are not found in them", () => {
  // The cut keeps the lines each quote draws on; none of the ten quotes is a substring of its cut result.
  for (const f of FXNONE.finish.facts) assert.ok(!FXNONE.results[f.source].includes(f.quote), f.id);
  assert.deepEqual(Object.keys(FXNONE.results).sort(), ["w12", "w18", "w3", "w4", "w5"]);
});

