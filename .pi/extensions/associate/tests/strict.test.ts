/**
 * The strict hand-back decision, without pi (strict-facts plan t5; spec c7,
 * c10, c25, c28, c31, c35, c36, c37, c40, c41).
 *
 * `lib/strict.ts` is driven here with a fake judge (no decider, no network):
 * the override, the switch per model, the shape rules (the same rules as
 * Python `validate_facts`), the outcome of each fact, the cascade, the
 * return-once rule and the message the model receives.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadContract } from "../lib/contract.ts";
import type { FactCheck, HandbackInput } from "../lib/facts.ts";
import { supportEvidence, type FactMaterial, type JudgedFact } from "../lib/judge.ts";
import { compileRedaction } from "../lib/walk.ts";
import {
  STRICT_ENV,
  STRICT_RETURN_FIX,
  evidenceContextFor,
  formatStrictMessage,
  resolveStrict,
  runStrict,
  shapeProblem,
  strictOverride,
  strictReport,
  type StrictJudge,
} from "../lib/strict.ts";

const CONTRACT = loadContract({});
const { accuracy } = CONTRACT;
const STRICT = accuracy.strict!;

const READ_TEXT = [
  "1\tROLE_RESPONSIBILITIES = {",
  '2\t    "worker": ["execution", "tool_use", "repo_inspection"],',
  '3\t    "senses": ["intake", "normalize_input"],',
  "4\t}",
].join("\n");

function input(facts: unknown[], extra: Record<string, unknown> = {}): HandbackInput {
  return {
    payload: { facts, ...extra },
    entries: [{ id: "w1", tool: "read", saved_result: "results/w1.txt" }],
    results: { w1: READ_TEXT },
    prior_runs: {},
    children: [],
  };
}

/** A judge that answers each to_judge fact with the option named for its id. */
function fakeJudge(answers: Record<string, string | null>, seen: Array<{ id: string; material: FactMaterial | undefined }> = []): StrictJudge {
  return async (facts, material) =>
    facts.map((f): JudgedFact => {
      if (f.status !== "to_judge") return { ...f, judge: null };
      seen.push({ id: f.id, material: material(f.id) });
      const option = answers[f.id] ?? null;
      const question = f.kind_stated === "derived" ? "derived" : "support";
      return option === null
        ? { ...f, status: "not_judged", judge: { question, option: null, judged: false, reason: "unreachable", confidence: null } }
        : { ...f, status: "judged", judge: { question, option, judged: true, reason: null, confidence: 0.9 } };
    });
}

function run(facts: unknown[], judge: StrictJudge, options: Partial<{ returnedBefore: Set<string>; canReturn: boolean; extra: Record<string, unknown> }> = {}) {
  const handbackInput = input(facts, options.extra);
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

const outcomes = (facts: ReadonlyArray<{ id: string; strict_outcome: string }>) =>
  Object.fromEntries(facts.map((f) => [f.id, f.strict_outcome]));

// A direct fact whose pointer resolves and whose literal is in the copied line.
const DIRECT = { id: "f1", kind: "direct", source: "w1", at: { lines: [1, 1] }, value: "ROLE_RESPONSIBILITIES" };
// An llm fact whose literal is not in the line pointed at: left to judge (the kind floor).
const LLM = { id: "f2", kind: "llm", source: "w1", at: { lines: [2, 2] }, value: "senses" };

// ------------------------------------------------------------------ the switch

test("ASSOCIATE_STRICT: on and off override; anything else is ignored with one problem line", () => {
  assert.deepEqual(strictOverride({}), {});
  assert.deepEqual(strictOverride({ [STRICT_ENV]: "  " }), {});
  assert.deepEqual(strictOverride({ [STRICT_ENV]: "on" }), { value: "on" });
  assert.deepEqual(strictOverride({ [STRICT_ENV]: " off " }), { value: "off" });
  const bad = strictOverride({ [STRICT_ENV]: "yes" });
  assert.equal(bad.value, undefined);
  assert.match(bad.problem!, /ASSOCIATE_STRICT="yes" is not 'on' or 'off'; it is ignored/);
  assert.equal(bad.problem!.split("\n").length, 1);
});

test("the contract switches strict on for worker and cortex, off for senses; the environment overrides it", () => {
  assert.deepEqual(resolveStrict(accuracy, "worker", undefined), { enabled: true, source: "contract", settings: STRICT });
  assert.deepEqual(resolveStrict(accuracy, "cortex", undefined).enabled, true);
  assert.deepEqual(resolveStrict(accuracy, "senses", undefined), { enabled: false, source: "contract" });
  assert.deepEqual(resolveStrict(accuracy, "worker", "off"), { enabled: false, source: "environment" });
  assert.deepEqual(resolveStrict(accuracy, "senses", "on"), { enabled: true, source: "environment", settings: STRICT });
  // No strict block: nothing to run with, whatever the override says.
  const { strict: _s, ...old } = accuracy;
  assert.equal(resolveStrict(old as typeof accuracy, "worker", undefined).enabled, false);
  const forced = resolveStrict(old as typeof accuracy, "worker", "on");
  assert.equal(forced.enabled, false);
  assert.match(forced.problem!, /no strict block/);
});

// ------------------------------------------------------------- the shape rules

test("shape rules: the same cross-field rules as validate_facts, one reason and fix each", () => {
  const cases: Array<[Record<string, unknown>, string | null]> = [
    [{ id: "f1", source: "w1", value: "x", quote: "some quote here" }, null],
    [{ id: "f1", source: "w1", at: { lines: [1, 2] } }, null],
    [{ id: "f1", source: "w1", kind: "guess", value: "x", quote: "q" }, "kind_unknown"],
    [{ id: "f1", source: "w1", value: "x" }, "pointer_missing"],
    [{ id: "f1", source: "w1", at: { lines: [1, 2], search: "x" } }, "pointer_malformed"],
    [{ id: "f1", source: "w1", at: {} }, "pointer_malformed"],
    [{ id: "f1", source: "w1", at: { lines: [2, 1] } }, "pointer_malformed"],
    [{ id: "f1", source: "w1", at: { lines: [1.5, 2] } }, "pointer_malformed"],
    [{ id: "f1", source: "w1", at: { search: "  " } }, "pointer_malformed"],
    [{ id: "f1", source: "w1", quote: "a quote with no value" }, "value_missing"],
    [{ id: "f1", source: "w1", kind: "llm", at: { lines: [1, 1] } }, "value_missing"],
    [{ id: "f1", source: "w1", kind: "derived", value: "x", at: { lines: [1, 1] } }, "based_on_missing"],
    [{ id: "f1", source: "w1", kind: "derived", value: "x", at: { lines: [1, 1] }, based_on: [] }, "based_on_missing"],
    [{ id: "f1", source: "w1", kind: "derived", value: "x", at: { lines: [1, 1] }, based_on: ["f2"] }, null],
  ];
  for (const [fact, reason] of cases) {
    const problem = shapeProblem(fact);
    assert.equal(problem?.reason ?? null, reason, JSON.stringify(fact));
    if (problem) assert.ok(problem.fix.length > 20, `${reason} has a fix`);
  }
});

// ------------------------------------------------------------------- outcomes

test("a fact that fails a direct check is dropped with its reason and fix", async () => {
  const bad = { id: "f3", source: "w1", value: "pyproject.toml", quote: "a content-identical copy sits in pyproject.toml" };
  const { decision } = await run([DIRECT, bad], fakeJudge({}));
  assert.deepEqual(outcomes(decision.facts), { f1: "pass", f3: "dropped" });
  const dropped = decision.dropped.find((d) => d.id === "f3")!;
  assert.equal(dropped.reason, "quote_absent");
  assert.equal(dropped.value, "pyproject.toml");
  assert.match(dropped.fix, /copy the quote word for word/);
});

test("a pointer that does not resolve is dropped with the resolver's reason, message and fix", async () => {
  const past = { id: "f4", source: "w1", at: { lines: [9, 9] }, value: "x" };
  const { decision } = await run([past], fakeJudge({}));
  assert.equal(decision.facts[0].strict_outcome, "dropped");
  assert.equal(decision.dropped[0].reason, "pointer_out_of_range");
  assert.match(decision.dropped[0].message ?? "", /lines 9-9/);
  assert.match(decision.dropped[0].fix, /point at lines that are in the cited result/);
});

test("drop on none: an llm fact the decider answers none is dropped; the decider was given the copied evidence", async () => {
  const seen: Array<{ id: string; material: FactMaterial | undefined }> = [];
  const { decision } = await run([DIRECT, LLM], fakeJudge({ f2: "none" }, seen));
  assert.deepEqual(outcomes(decision.facts), { f1: "pass", f2: "dropped" });
  assert.equal(decision.dropped[0].reason, "decider_drop");
  assert.match(decision.dropped[0].fix, /answered 'none'/);
  assert.equal(decision.facts[1].judge?.option, "none");
  assert.deepEqual(seen, [{ id: "f2", material: { value: "senses", evidence: '2\t    "worker": ["execution", "tool_use", "repo_inspection"],', command: "read" } }]);
});

test("return once: part is returned the first time, kept with the mark when seen again or when no round is left", async () => {
  const first = await run([DIRECT, LLM], fakeJudge({ f2: "part" }));
  assert.equal(first.decision.facts[1].strict_outcome, "returned");
  assert.deepEqual(first.decision.returned, [{ id: "f2", option: "part", fix: STRICT_RETURN_FIX, round: 1, value: "senses" }]);
  assert.equal(first.decision.facts[1].round, 1);

  const again = await run([DIRECT, { ...LLM, value: "intake" }], fakeJudge({ f2: "little" }), {
    returnedBefore: new Set(["f2"]),
  });
  assert.equal(again.decision.facts[1].strict_outcome, "keep_marked");
  assert.equal(again.decision.facts[1].mark, STRICT.mark_text);
  assert.deepEqual(again.decision.returned, []);

  const noRound = await run([DIRECT, LLM], fakeJudge({ f2: "part" }), { canReturn: false });
  assert.equal(noRound.decision.facts[1].strict_outcome, "keep_marked");
});

test("all or mostly passes an llm fact; it is never counted as a direct pass", async () => {
  const { decision } = await run([DIRECT, LLM], fakeJudge({ f2: "mostly" }));
  assert.deepEqual(outcomes(decision.facts), { f1: "pass", f2: "pass" });
  assert.deepEqual(decision.judge_counts, { direct_passed: 1, llm_judged: 1, derived_judged: 0, not_judged: 0 });
});

test("an outage keeps an llm fact out of the answer as not judged, never dropped as failed", async () => {
  const { decision } = await run([DIRECT, LLM], fakeJudge({ f2: null }));
  assert.equal(decision.facts[1].strict_outcome, "not_judged");
  assert.deepEqual(decision.dropped, []);
  assert.match(decision.not_judged_message ?? "", /outage/);
  assert.equal(decision.counts.not_judged, 1);
});

test("a derived fact's decider answer is shown and never drops it", async () => {
  const derived = { id: "f5", kind: "derived", source: "w1", at: { lines: [3, 3] }, value: "worker", based_on: ["f1"] };
  const { decision } = await run([DIRECT, derived], fakeJudge({ f5: "no" }));
  assert.equal(decision.facts[1].status, "judged");
  assert.equal(decision.facts[1].kind_checked, "derived");
  assert.equal(decision.facts[1].strict_outcome, "pass");
  assert.equal(decision.facts[1].judge?.question, "derived");
  assert.equal(decision.facts[1].judge?.judged, true);
  assert.equal(decision.facts[1].judge?.option, "no");
  assert.equal(decision.judge_counts.derived_judged, 1);
});

test("cascade: f2 and f3 based on a failed f1 are dropped, each naming f1 as the reason", async () => {
  const f1 = { id: "f1", source: "w1", value: "pyproject.toml", quote: "a content-identical copy sits in pyproject.toml" };
  const f2 = { id: "f2", kind: "derived", source: "w1", at: { lines: [1, 1] }, value: "ROLE_RESPONSIBILITIES", based_on: ["f1"] };
  const f3 = { id: "f3", kind: "derived", source: "w1", at: { lines: [1, 1] }, value: "ROLE_RESPONSIBILITIES", based_on: ["f2"] };
  const { decision } = await run([f1, f2, f3], fakeJudge({}));
  assert.deepEqual(outcomes(decision.facts), { f1: "dropped", f2: "dropped", f3: "dropped" });
  for (const id of ["f2", "f3"]) {
    const d = decision.dropped.find((x) => x.id === id)!;
    assert.equal(d.reason, "based_on_failed");
    assert.equal(d.dropped_by, "f1");
    assert.match(d.fix, /based on f1, which failed \(quote_absent\)/);
  }
  const message = formatStrictMessage(decision, { round: 1, retryRounds: 2, final: false });
  assert.match(message, /- f2: based_on_failed \(root: f1\)/);
  assert.match(message, /- f3: based_on_failed \(root: f1\)/);
});

test("cascade after the decider: a fact based on an llm fact answered none is dropped, naming it", async () => {
  const f3 = { id: "f3", kind: "derived", source: "w1", at: { lines: [1, 1] }, value: "ROLE_RESPONSIBILITIES", based_on: ["f2"] };
  const { decision } = await run([DIRECT, LLM, f3], fakeJudge({ f2: "none" }));
  assert.deepEqual(outcomes(decision.facts), { f1: "pass", f2: "dropped", f3: "dropped" });
  const d = decision.dropped.find((x) => x.id === "f3")!;
  assert.equal(d.dropped_by, "f2");
  assert.match(d.fix, /f2, which failed \(decider_drop\)/);
});

test("a shape failure drops the fact before it is judged, and cascades", async () => {
  const noBasis = { id: "f2", kind: "derived", source: "w1", at: { lines: [2, 2] }, value: "senses" };
  const after = { id: "f3", kind: "derived", source: "w1", at: { lines: [1, 1] }, value: "ROLE_RESPONSIBILITIES", based_on: ["f2"] };
  const seen: Array<{ id: string; material: FactMaterial | undefined }> = [];
  const { decision } = await run([DIRECT, noBasis, after], fakeJudge({ f2: "yes" }, seen), {});
  assert.deepEqual(outcomes(decision.facts), { f1: "pass", f2: "dropped", f3: "dropped" });
  assert.equal(decision.dropped[0].reason, "based_on_missing");
  assert.deepEqual(seen.map((s) => s.id), [], "a fact dropped for its shape is never sent to the decider");
});

test("graph refusals: an unknown based_on id and a cycle drop those facts with the fix", async () => {
  const unknown = { id: "f2", kind: "derived", source: "w1", at: { lines: [1, 1] }, value: "ROLE_RESPONSIBILITIES", based_on: ["f9"] };
  const a = { id: "f3", kind: "derived", source: "w1", at: { lines: [1, 1] }, value: "ROLE_RESPONSIBILITIES", based_on: ["f4"] };
  const b = { id: "f4", kind: "derived", source: "w1", at: { lines: [1, 1] }, value: "ROLE_RESPONSIBILITIES", based_on: ["f3"] };
  const { decision } = await run([DIRECT, unknown, a, b], fakeJudge({}));
  assert.deepEqual(outcomes(decision.facts), { f1: "pass", f2: "dropped", f3: "dropped", f4: "dropped" });
  assert.equal(decision.drop_reasons.based_on_unknown, 1);
  assert.equal(decision.drop_reasons.based_on_cycle, 2);
  assert.match(decision.dropped.find((d) => d.id === "f3")!.fix, /cycle \(f3 -> f4 -> f3\)/);
});

test("a conclusion resting on a dropped fact is dropped too; one resting on a not-judged fact is not judged", async () => {
  const extra = {
    verdicts: [
      { id: "v1", text: "rests on the dropped fact", verdict: "supported", basis: ["f2"] },
      { id: "v2", text: "rests on f1", verdict: "supported", basis: ["f1"] },
    ],
  };
  const dropped = await run([DIRECT, LLM], fakeJudge({ f2: "none" }), { extra });
  assert.deepEqual(
    dropped.decision.items.verdicts.map((v) => [v.id, v.strict_outcome, v.strict_reason]),
    [
      ["v1", "dropped", "basis_dropped"],
      ["v2", "pass", null],
    ],
  );
  assert.ok(dropped.decision.dropped.some((d) => d.id === "v1" && d.item === "verdict"));
  const outage = await run([DIRECT, LLM], fakeJudge({ f2: null }), { extra });
  assert.equal(outage.decision.items.verdicts[0].strict_outcome, "not_judged");
});

test("counts per outcome and per drop reason", async () => {
  const bad = { id: "f3", source: "w1", value: "pyproject.toml", quote: "a content-identical copy sits in pyproject.toml" };
  const { decision } = await run([DIRECT, LLM, bad], fakeJudge({ f2: "part" }));
  assert.deepEqual(decision.counts, { pass: 1, keep_marked: 0, returned: 1, dropped: 1, not_judged: 0 });
  assert.deepEqual(decision.drop_reasons, { quote_absent: 1 });
});

// ------------------------------------------------------------------ the message

test("the message lists every dropped and returned item, the rounds left, and that the model may stop", async () => {
  const bad = { id: "f3", source: "w1", value: "pyproject.toml", quote: "a content-identical copy sits in pyproject.toml" };
  const { decision } = await run([DIRECT, LLM, bad], fakeJudge({ f2: "part" }));
  const message = formatStrictMessage(decision, { round: 1, retryRounds: 2, final: false });
  assert.match(message, /round 1 of 2/);
  assert.match(message, /1 dropped, 1 returned/);
  assert.match(message, /- f3 \(cites w1\): quote_absent\. Fix: copy the quote word for word/);
  assert.match(message, /- f2: the decider answered 'part'/);
  assert.match(message, new RegExp(`Fix: ${STRICT_RETURN_FIX}`));
  assert.match(message, /2 finish calls left/);
  assert.match(message, /Or stop: the answer recorded now goes out/);
  const final = formatStrictMessage(decision, { round: 2, retryRounds: 2, final: true });
  assert.doesNotMatch(final, /finish calls left/);
  assert.match(final, /not refused/);
});

// ------------------------------------------- the direct-or-worded rule (deviation d3)

/** One `ls tests` call whose saved result is the line `604`: the measured colleague case. */
function run604(facts: unknown[], judge: StrictJudge, options: Partial<{ returnedBefore: Set<string>; canReturn: boolean }> = {}) {
  const handbackInput: HandbackInput = {
    payload: { facts },
    entries: [{ id: "w1", tool: "bash", args: { argv: ["ls", "tests"], purpose: "count" }, args_used: { argv: ["ls", "tests"] }, saved_result: "results/w1.txt" }],
    results: { w1: "604\n" },
    prior_runs: {},
    children: [],
  };
  return runStrict({
    handbackInput,
    accuracy,
    settings: STRICT,
    passes: accuracy.support_score!.passes,
    evidence: evidenceContextFor(handbackInput, { checkoutRoot: "/nonexistent/checkout", redact: (t) => t, sourceKinds: accuracy.source_kinds }),
    judge,
    returnedBefore: options.returnedBefore ?? new Set(),
    canReturn: options.canReturn ?? true,
    round: 1,
  });
}

const F604 = { id: "f1", kind: "direct", source: "w1", at: { lines: [1, 1] }, value: "There are 604 test files" };

test("604: a count in the model's own words is judged, with the command beside the copied line", async () => {
  const seen: Array<{ id: string; material: FactMaterial | undefined }> = [];
  const first = await run604([F604], fakeJudge({ f1: "part" }, seen));
  const f1 = first.decision.facts[0];
  assert.equal(f1.kind_stated, "direct");
  assert.equal(f1.kind_checked, "llm");
  assert.equal(f1.worded, true);
  assert.equal(f1.strict_outcome, "returned", "part, the first time: returned once");
  assert.deepEqual(seen, [{ id: "f1", material: { value: "There are 604 test files", evidence: "604", command: "ls tests" } }]);
  assert.equal(supportEvidence(seen[0]!.material), "command: ls tests\n604", "what the decider reads as the evidence");

  const again = await run604([F604], fakeJudge({ f1: "part" }), { returnedBefore: new Set(["f1"]) });
  assert.equal(again.decision.facts[0].strict_outcome, "keep_marked");
  assert.equal(again.decision.facts[0].mark, STRICT.mark_text);

  const none = await run604([F604], fakeJudge({ f1: "none" }));
  assert.equal(none.decision.facts[0].strict_outcome, "dropped");
  assert.equal(none.decision.dropped[0].reason, "decider_drop");
});

test("604: the bare number, or no value, is direct and never sent to the decider", async () => {
  const seen: Array<{ id: string; material: FactMaterial | undefined }> = [];
  const { decision } = await run604(
    [
      { id: "f1", kind: "llm", source: "w1", at: { lines: [1, 1] }, value: "604" },
      { id: "f2", source: "w1", at: { lines: [1, 1] } },
    ],
    fakeJudge({}, seen),
  );
  assert.deepEqual(outcomes(decision.facts), { f1: "pass", f2: "pass" });
  assert.deepEqual(decision.facts.map((f) => [f.kind_checked, f.worded]), [["direct", false], ["direct", false]]);
  assert.deepEqual(seen, []);
});

test("604: a number the copied line does not show drops the fact for any stated kind, before the decider", async () => {
  const seen: Array<{ id: string; material: FactMaterial | undefined }> = [];
  const { decision } = await run604([{ ...F604, kind: "llm", value: "There are 605 test files" }], fakeJudge({ f1: "all" }, seen));
  assert.equal(decision.facts[0].strict_outcome, "dropped");
  assert.equal(decision.dropped[0].reason, "number_absent");
  assert.deepEqual(seen, []);
});

test("an old-shape fact under strict: judged against its quote alone (no command), and dropped when the quote is not found", async () => {
  const seen: Array<{ id: string; material: FactMaterial | undefined }> = [];
  const worded = { id: "f1", kind: "direct", source: "w1", value: "the table lists the worker role", quote: '"worker": ["execution", "tool_use", "repo_inspection"]' };
  const absent = { id: "f2", kind: "llm", source: "w1", value: "senses", quote: "a line that is not in the result at all" };
  const { decision } = await run([worded, absent], fakeJudge({ f1: "all" }, seen));
  assert.deepEqual(outcomes(decision.facts), { f1: "pass", f2: "dropped" });
  assert.equal(decision.facts[0].kind_checked, "llm");
  assert.equal(seen.length, 1);
  assert.equal(supportEvidence(seen[0]!.material), worded.quote, "the quote alone, as before");
  assert.equal(decision.dropped[0].reason, "quote_absent");
});

test("report.json strict counts worded and judged facts", async () => {
  const { decision } = await run604(
    [F604, { id: "f2", source: "w1", at: { lines: [1, 1] }, value: "604" }],
    fakeJudge({ f1: "all" }),
  );
  const report = strictReport(decision);
  assert.equal(report.worded, 1);
  assert.equal(report.judged, 1);
  assert.equal(report.direct_passed, 1);
  assert.deepEqual(report.by_stated_kind.direct, { stated: 2, checked_as_direct: 1 });
});

// ------------------------------------- follow-on: shape records, judging order, final counts

test("a fact dropped by a shape rule carries no kind_checked, no worded and no evidence; kind_stated stays", async () => {
  const noValue = { id: "f1", kind: "llm", source: "w1", at: { lines: [2, 2] } };
  const noBasis = { id: "f2", kind: "derived", source: "w1", at: { lines: [2, 2] }, value: "senses" };
  const { decision } = await run([noValue, noBasis], fakeJudge({}));
  for (const f of decision.facts) {
    assert.equal(f.strict_outcome, "dropped", f.id);
    assert.equal(f.kind_checked, null, f.id);
    assert.equal(f.worded, null, f.id);
    assert.ok(!("evidence" in f), `${f.id} has no evidence`);
  }
  assert.deepEqual(decision.facts.map((f) => f.kind_stated), ["llm", "derived"]);
  assert.equal(strictReport(decision).worded, 0);
});

test("a derived fact is not sent in the same pass as an input the decider then drops; it is dropped with judge null", async () => {
  const seen: Array<{ id: string; material: FactMaterial | undefined }> = [];
  const derived = { id: "f2", kind: "derived", source: "w1", at: { lines: [1, 1] }, value: "the suite is large", based_on: ["f1"] };
  const { decision } = await run604([F604, derived], fakeJudge({ f1: "none", f2: "yes" }, seen));
  assert.deepEqual(seen.map((s) => s.id), ["f1"], "only the input was sent");
  const f2 = decision.facts[1];
  assert.equal(f2.strict_outcome, "dropped");
  assert.equal(f2.dropped_by, "f1");
  assert.equal(f2.judge, null);
  assert.equal(decision.judge_counts.derived_judged, 0);
});

test("a derived fact is judged in the second step when its input stands, and the judge is called once per step", async () => {
  const calls: string[][] = [];
  const inner = fakeJudge({ f1: "all", f2: "yes" });
  const judge: StrictJudge = async (facts, material) => {
    calls.push(facts.filter((f) => f.status === "to_judge").map((f) => f.id));
    return inner(facts, material);
  };
  const derived = { id: "f2", kind: "derived", source: "w1", at: { lines: [1, 1] }, value: "the suite is large", based_on: ["f1"] };
  const { decision } = await run604([derived, F604], judge);
  assert.deepEqual(calls, [["f1"], ["f2"]]);
  assert.deepEqual(outcomes(decision.facts), { f2: "pass", f1: "pass" });
  assert.equal(decision.facts[0].judge?.option, "yes");
});

test("judge counts are taken after the last cascade: a direct fact that ends dropped is not counted as passed", async () => {
  const direct = { id: "f2", source: "w1", at: { lines: [1, 1] }, based_on: ["f1"] };
  const { decision } = await run604([F604, direct], fakeJudge({ f1: "none" }));
  assert.equal(decision.facts[1].strict_outcome, "dropped");
  assert.deepEqual(decision.judge_counts, { direct_passed: 0, llm_judged: 1, derived_judged: 0, not_judged: 0 });
  assert.equal(strictReport(decision).direct_passed, 0);
});
