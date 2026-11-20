/**
 * Strict facts (plan task t3; spec claims c22, c23, c36, c40, h10, h26): fact
 * kinds, the kind floor, and the `based_on` graph in `lib/facts.ts`.
 *
 * Old-shape facts (a quote, no kind) are covered by `facts.test.ts` and the
 * shared vectors; these cases add the new fields only.
 *
 * `checkHandback` without `strict` is the strict-off path, where the kind
 * floor still sets `kind_checked` (recorded only). With `strict: true` the
 * direct-or-worded rule replaces it (plan deviation d3); those cases are under
 * "strict on" below.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadContract } from "../lib/contract.ts";
import {
  cascadeDrops,
  checkHandback,
  type EvidenceResolver,
  type FactCheck,
  type HandbackInput,
} from "../lib/facts.ts";

const { accuracy } = loadContract({});

const TEXT = "alpha line one\nbeta line two holds 604 entries\ngamma line three";
const GOOD = "beta line two holds 604 entries";
const BAD = "this sentence is nowhere in the saved result";

function input(facts: unknown[]): HandbackInput {
  return {
    payload: { facts },
    entries: [{ id: "w1", tool: "read", saved_result: "results/w1.txt" }],
    results: { w1: TEXT },
  };
}

function byId(facts: readonly FactCheck[], id: string): FactCheck {
  const found = facts.find((f) => f.id === id);
  assert.ok(found, `fact ${id}`);
  return found;
}

// --- kinds and the kind floor (c22, c40, h26) -------------------------------

test("an old-shape fact (quote, no kind) is a direct fact checked by the matcher", () => {
  const got = checkHandback(input([{ id: "f1", value: "a stated value", source: "w1", quote: GOOD }]), accuracy);
  const f1 = got.facts[0];
  assert.equal(f1.verdict, "passed");
  assert.equal(f1.kind_stated, "direct");
  assert.equal(f1.kind_checked, "direct");
  assert.equal(f1.status, "passed");
  assert.deepEqual(f1.based_on, []);
  assert.equal(f1.drop_reason, null);
  assert.equal(f1.dropped_by, null);
  assert.equal(got.accepted, true);
});

test("strict off (unchanged): the kind floor still records a fact stating llm or derived whose quote is in the result as direct", () => {
  const got = checkHandback(
    input([
      { id: "f1", kind: "llm", value: "the file has 604 entries", source: "w1", quote: GOOD },
      { id: "f2", kind: "derived", value: "the listing is long", source: "w1", quote: GOOD, based_on: ["f1"] },
    ]),
    accuracy,
  );
  for (const id of ["f1", "f2"]) {
    const f = byId(got.facts, id);
    assert.equal(f.verdict, "passed", id);
    assert.equal(f.kind_checked, "direct", id);
    assert.equal(f.status, "passed", id);
  }
  assert.equal(byId(got.facts, "f1").kind_stated, "llm");
  assert.equal(byId(got.facts, "f2").kind_stated, "derived");
  assert.equal(got.report.facts.passed, 2, "counted with the direct-passed facts");
});

test("strict off (unchanged): an llm or derived fact whose evidence the direct check does not find is left to judge, not refused", () => {
  const got = checkHandback(
    input([
      { id: "f1", value: "a stated value", source: "w1", quote: GOOD },
      { id: "f2", kind: "llm", value: "the module is well tested", source: "w1", quote: BAD },
      { id: "f3", kind: "derived", value: "so the change is safe", source: "w1", quote: BAD, based_on: ["f1"] },
    ]),
    accuracy,
  );
  for (const [id, kind] of [
    ["f2", "llm"],
    ["f3", "derived"],
  ] as const) {
    const f = byId(got.facts, id);
    assert.equal(f.kind_checked, kind, id);
    assert.equal(f.status, "to_judge", id);
    assert.equal(f.verdict, "unchecked", id);
    assert.equal(f.reason, "to_judge", id);
    assert.equal(f.drop_reason, null, id);
  }
  assert.equal(got.accepted, true, "a fact left to judge refuses nothing");
});

test("a stated direct fact whose direct check fails is failed", () => {
  const got = checkHandback(input([{ id: "f1", kind: "direct", value: "a stated value", source: "w1", quote: BAD }]), accuracy);
  const f1 = got.facts[0];
  assert.equal(f1.verdict, "refused");
  assert.equal(f1.reason, "quote_absent");
  assert.equal(f1.status, "failed");
  assert.equal(f1.kind_checked, "direct");
  assert.equal(f1.drop_reason, "quote_absent");
  assert.equal(f1.dropped_by, null);
});

test("an llm fact with an unknown source still fails: the kind does not excuse a missing source", () => {
  const got = checkHandback(input([{ id: "f1", kind: "llm", value: "a stated value", source: "w9", quote: GOOD }]), accuracy);
  assert.equal(got.facts[0].status, "failed");
  assert.equal(got.facts[0].drop_reason, "source_unknown");
});

test("an unknown kind string is read as direct (the strictest)", () => {
  const got = checkHandback(input([{ id: "f1", kind: "opinion", value: "a stated value", source: "w1", quote: BAD }]), accuracy);
  assert.equal(got.facts[0].kind_stated, "direct");
  assert.equal(got.facts[0].status, "failed");
});

// --- pointers (at) and the injected resolver --------------------------------

test("a fact with only a pointer and no resolver is unchecked as pointer_unresolved", () => {
  const got = checkHandback(input([{ id: "f1", value: "604", source: "w1", at: { search: "604" } }]), accuracy);
  const f1 = got.facts[0];
  assert.equal(f1.verdict, "unchecked");
  assert.equal(f1.reason, "pointer_unresolved");
  assert.equal(f1.status, "unchecked");
  assert.equal(f1.drop_reason, null);
});

test("strict off (unchanged): a pointer the resolver resolves is checked directly against the copied quote", () => {
  const seen: unknown[] = [];
  const resolveEvidence: EvidenceResolver = (fact, located) => {
    seen.push([fact.id, located.entry.id, located.text]);
    return { ok: true, quote: GOOD, command: "read", result_file: "results/w1.txt", value: "604", source_kind: "file" };
  };
  const got = checkHandback(
    input([
      { id: "f1", value: "604", source: "w1", at: { lines: [2, 2] } },
      { id: "f2", kind: "llm", value: "the count is large", source: "w1", at: { lines: [2, 2] } },
      { id: "f3", value: "605", source: "w1", at: { lines: [2, 2] } },
    ]),
    accuracy,
    { resolveEvidence },
  );
  assert.equal(byId(got.facts, "f1").status, "passed");
  assert.equal(byId(got.facts, "f1").kind_checked, "direct");
  assert.equal(byId(got.facts, "f2").status, "passed", "kind floor: resolved evidence is a direct check");
  assert.equal(byId(got.facts, "f2").kind_checked, "direct");
  assert.equal(byId(got.facts, "f3").status, "failed", "a literal value not in the copied quote fails");
  assert.equal(byId(got.facts, "f3").reason, "literal_not_in_quote");
  assert.deepEqual(seen[0], ["f1", "w1", TEXT]);
});

test("a pointer the resolver cannot resolve fails with the resolver's reason and fix, and cascades", () => {
  const resolveEvidence: EvidenceResolver = () => ({
    ok: false,
    reason: "lines_past_end",
    fix: "point at lines inside the saved result (it has 3 lines)",
  });
  const got = checkHandback(
    input([
      { id: "f1", value: "a stated value", source: "w1", at: { lines: [40, 41] } },
      { id: "f2", kind: "derived", value: "so y", source: "w1", quote: BAD, based_on: ["f1"] },
    ]),
    accuracy,
    { resolveEvidence },
  );
  const f1 = byId(got.facts, "f1");
  assert.equal(f1.status, "failed");
  assert.equal(f1.reason, "pointer_unresolved");
  assert.equal(f1.drop_reason, "lines_past_end");
  assert.match(f1.fix ?? "", /inside the saved result/);
  const f2 = byId(got.facts, "f2");
  assert.equal(f2.status, "dropped");
  assert.equal(f2.dropped_by, "f1");
});

// --- the based_on graph (c23, h10, c36) -------------------------------------

test("h10: f1 fails, f2 and f3 name f1: all three drop and f2's and f3's message names f1", () => {
  const got = checkHandback(
    input([
      { id: "f1", value: "a stated value", source: "w1", quote: BAD },
      { id: "f2", kind: "derived", value: "so y", source: "w1", quote: GOOD, based_on: ["f1"] },
      { id: "f3", kind: "derived", value: "so z", source: "w1", quote: BAD, based_on: ["f1"] },
    ]),
    accuracy,
  );
  const f1 = byId(got.facts, "f1");
  assert.equal(f1.status, "failed");
  assert.equal(f1.drop_reason, "quote_absent");
  for (const id of ["f2", "f3"]) {
    const f = byId(got.facts, id);
    assert.equal(f.status, "dropped", id);
    assert.equal(f.drop_reason, "based_on_failed", id);
    assert.equal(f.dropped_by, "f1", id);
    assert.match(f.drop_message ?? "", /\bf1\b/, `${id}: the message names f1`);
    assert.deepEqual(f.based_on, ["f1"], id);
  }
});

test("the cascade names the root failed fact, not the intermediate, through a chain", () => {
  const got = checkHandback(
    input([
      { id: "f3", kind: "derived", value: "so z", source: "w1", quote: GOOD, based_on: ["f2"] },
      { id: "f2", kind: "derived", value: "so y", source: "w1", quote: GOOD, based_on: ["f1"] },
      { id: "f1", value: "a stated value", source: "w1", quote: BAD },
      { id: "f4", value: "a stated value", source: "w1", quote: GOOD },
    ]),
    accuracy,
  );
  assert.equal(byId(got.facts, "f2").dropped_by, "f1");
  assert.equal(byId(got.facts, "f3").dropped_by, "f1", "root cause, not f2");
  assert.match(byId(got.facts, "f3").drop_message ?? "", /\bf1\b/);
  assert.equal(byId(got.facts, "f4").status, "passed", "a fact outside the chain is untouched");
  assert.deepEqual(got.graph.order, ["f1", "f2", "f3", "f4"], "dependency order, stable by the model's order");
  assert.deepEqual(
    got.facts.map((f) => f.id),
    ["f3", "f2", "f1", "f4"],
    "facts stay listed in the model's order",
  );
});

test("the cascade applies for any kind: a direct fact based on a failed fact is dropped", () => {
  const got = checkHandback(
    input([
      { id: "f1", value: "a stated value", source: "w1", quote: BAD },
      { id: "f2", value: "a stated value", source: "w1", quote: GOOD, based_on: ["f1"] },
    ]),
    accuracy,
  );
  const f2 = byId(got.facts, "f2");
  assert.equal(f2.verdict, "passed", "its own direct check passed");
  assert.equal(f2.status, "dropped");
  assert.equal(f2.dropped_by, "f1");
});

test("a fact left to judge does not cascade: only a failure drops what rests on it", () => {
  const got = checkHandback(
    input([
      { id: "f1", kind: "llm", value: "a stated value", source: "w1", quote: BAD },
      { id: "f2", kind: "derived", value: "so y", source: "w1", quote: BAD, based_on: ["f1"] },
    ]),
    accuracy,
  );
  assert.equal(byId(got.facts, "f2").status, "to_judge");
});

test("a based_on id that names no fact of the hand-back is refused with the fix", () => {
  const got = checkHandback(
    input([
      { id: "f1", value: "a stated value", source: "w1", quote: GOOD },
      { id: "f2", kind: "derived", value: "so y", source: "w1", quote: GOOD, based_on: ["f1", "f7"] },
      { id: "f3", kind: "derived", value: "so z", source: "w1", quote: GOOD, based_on: ["f2"] },
    ]),
    accuracy,
  );
  const f2 = byId(got.facts, "f2");
  assert.equal(f2.status, "failed");
  assert.equal(f2.drop_reason, "based_on_unknown");
  assert.match(f2.fix ?? "", /\bf7\b/);
  assert.equal(byId(got.facts, "f3").dropped_by, "f2");
  assert.equal(byId(got.facts, "f1").status, "passed");
  assert.deepEqual(got.graph.refusals, [
    { reason: "based_on_unknown", fact: "f2", ids: ["f7"], fix: f2.fix },
  ]);
});

test("a cycle f1 -> f2 -> f1 is refused with the ids in the cycle and the fix", () => {
  const got = checkHandback(
    input([
      { id: "f1", kind: "derived", value: "a stated value", source: "w1", quote: GOOD, based_on: ["f2"] },
      { id: "f2", kind: "derived", value: "a stated value", source: "w1", quote: GOOD, based_on: ["f1"] },
      { id: "f3", kind: "derived", value: "a stated value", source: "w1", quote: GOOD, based_on: ["f2"] },
      { id: "f4", value: "a stated value", source: "w1", quote: GOOD },
    ]),
    accuracy,
  );
  for (const id of ["f1", "f2"]) {
    const f = byId(got.facts, id);
    assert.equal(f.status, "failed", id);
    assert.equal(f.drop_reason, "based_on_cycle", id);
    assert.match(f.fix ?? "", /f1.*f2/, `${id}: the fix lists the cycle`);
  }
  assert.equal(byId(got.facts, "f3").status, "dropped");
  assert.equal(byId(got.facts, "f3").dropped_by, "f2");
  assert.equal(byId(got.facts, "f4").status, "passed");
  assert.equal(got.graph.refusals.length, 1);
  assert.equal(got.graph.refusals[0].reason, "based_on_cycle");
  assert.deepEqual(got.graph.refusals[0].ids, ["f1", "f2"]);
  assert.match(got.graph.refusals[0].fix, /based_on/);
});

test("a fact naming itself in based_on is a cycle", () => {
  const got = checkHandback(
    input([{ id: "f1", kind: "derived", value: "a stated value", source: "w1", quote: GOOD, based_on: ["f1"] }]),
    accuracy,
  );
  assert.equal(got.facts[0].drop_reason, "based_on_cycle");
  assert.deepEqual(got.graph.refusals[0].ids, ["f1"]);
});

test("the graph changes nothing for old-shape facts: accepted and counts as before", () => {
  const facts = [
    { id: "f1", value: "a stated value", source: "w1", quote: GOOD },
    { id: "f2", value: "a stated value", source: "w1", quote: BAD },
  ];
  const got = checkHandback(input(facts), accuracy);
  assert.equal(got.accepted, false);
  assert.deepEqual(got.report.facts, { made: 2, checked: 2, passed: 1, refused: 1, unchecked: 0 });
  assert.deepEqual(got.graph, { order: ["f1", "f2"], refusals: [] });
});

test("cascadeDrops recomputes drops after a later status change (for the decider task)", () => {
  const got = checkHandback(
    input([
      { id: "f1", kind: "llm", value: "a stated value", source: "w1", quote: BAD },
      { id: "f2", kind: "derived", value: "so y", source: "w1", quote: BAD, based_on: ["f1"] },
    ]),
    accuracy,
  );
  const judged = got.facts.map((f) => (f.id === "f1" ? { ...f, status: "failed" as const, drop_reason: "none" } : f));
  const after = cascadeDrops(judged);
  assert.equal(byId(after, "f2").status, "dropped");
  assert.equal(byId(after, "f2").dropped_by, "f1");
  assert.equal(byId(after, "f1").drop_reason, "none", "the failed fact keeps its own reason");
});

test("check.json's per-fact record carries kind_stated, kind_checked, based_on and drop_reason", () => {
  const got = checkHandback(
    input([
      { id: "f1", kind: "llm", value: "a stated value", source: "w1", quote: BAD },
      { id: "f2", value: "a stated value", source: "w1", quote: GOOD },
    ]),
    accuracy,
  );
  const written = JSON.parse(JSON.stringify(got.facts)) as Array<Record<string, unknown>>;
  for (const f of written) {
    for (const key of ["kind_stated", "kind_checked", "based_on", "drop_reason"]) {
      assert.ok(Object.hasOwn(f, key), `${String(f.id)}: ${key}`);
    }
  }
  assert.equal(written[0].kind_stated, "llm");
  assert.equal(written[0].kind_checked, "llm");
  assert.equal(written[1].drop_reason, null);
});

// --- strict on: the direct-or-worded rule (plan deviation d3) -----------------

/** A resolver that copies the given text for every fact, as lib/evidence.ts would after its own checks. */
const copying = (quote: string): EvidenceResolver => () => ({
  ok: true,
  quote,
  command: "read",
  result_file: "results/w1.txt",
  value: null,
  source_kind: "file",
});

function strictCheck(facts: unknown[], quote = GOOD) {
  return checkHandback(input(facts), accuracy, { resolveEvidence: copying(quote), strict: true });
}

test("strict on: a fact stating llm whose value is word for word in the evidence is direct, not judged", () => {
  const got = strictCheck([{ id: "f1", kind: "llm", value: "holds 604 entries", source: "w1", at: { lines: [2, 2] } }]);
  const f1 = got.facts[0];
  assert.equal(f1.status, "passed");
  assert.equal(f1.kind_stated, "llm");
  assert.equal(f1.kind_checked, "direct");
  assert.equal(f1.worded, false);
});

test("strict on: a fact stating direct whose value is in its own words is judged as llm", () => {
  const got = strictCheck([{ id: "f1", kind: "direct", value: "the file has 604 entries", source: "w1", at: { lines: [2, 2] } }]);
  const f1 = got.facts[0];
  assert.equal(f1.status, "to_judge");
  assert.equal(f1.verdict, "unchecked");
  assert.equal(f1.reason, "to_judge");
  assert.equal(f1.kind_stated, "direct");
  assert.equal(f1.kind_checked, "llm");
  assert.equal(f1.worded, true);
  assert.equal(got.accepted, true, "a fact left to judge refuses nothing");
});

test("strict on: a fact with no value (or only whitespace) is direct: the harness takes the copied text", () => {
  const got = strictCheck([
    { id: "f1", source: "w1", at: { lines: [2, 2] } },
    { id: "f2", kind: "direct", value: "   ", source: "w1", at: { lines: [2, 2] } },
  ]);
  for (const f of got.facts) {
    assert.equal(f.status, "passed", f.id);
    assert.equal(f.kind_checked, "direct", f.id);
    assert.equal(f.worded, false, f.id);
  }
});

test("strict on: the comparison is an exact substring after trimming the value's ends; case and inner whitespace count", () => {
  const got = strictCheck([
    { id: "f1", value: "  holds 604 entries\n", source: "w1", at: { lines: [2, 2] } },
    { id: "f2", value: "Holds 604 entries", source: "w1", at: { lines: [2, 2] } },
    { id: "f3", value: "holds  604 entries", source: "w1", at: { lines: [2, 2] } },
    { id: "f4", value: "holds\t604 entries", source: "w1", at: { lines: [2, 2] } },
    { id: "f5", value: GOOD, source: "w1", at: { lines: [2, 2] } },
  ]);
  const view = Object.fromEntries(got.facts.map((f) => [f.id, [f.kind_checked, f.worded]]));
  assert.deepEqual(view, {
    f1: ["direct", false],
    f2: ["llm", true],
    f3: ["llm", true],
    f4: ["llm", true],
    f5: ["direct", false],
  });
});

test("strict on: a derived fact is always left for the derived question, its worded field set by the same comparison", () => {
  const got = strictCheck([
    { id: "f1", source: "w1", at: { lines: [2, 2] } },
    { id: "f2", kind: "derived", value: "604 entries", source: "w1", at: { lines: [2, 2] }, based_on: ["f1"] },
    { id: "f3", kind: "derived", value: "so the listing is long", source: "w1", at: { lines: [2, 2] }, based_on: ["f1"] },
  ]);
  assert.deepEqual(
    got.facts.map((f) => [f.id, f.status, f.kind_checked, f.worded]),
    [
      ["f1", "passed", "direct", false],
      ["f2", "to_judge", "derived", false],
      ["f3", "to_judge", "derived", true],
    ],
  );
});

test("strict on: stating llm never skips the pointer check: an unresolved pointer fails any kind", () => {
  const resolveEvidence: EvidenceResolver = () => ({ ok: false, reason: "number_absent", fix: "write only numbers that appear" });
  const got = checkHandback(
    input([{ id: "f1", kind: "llm", value: "605 entries", source: "w1", at: { lines: [2, 2] } }]),
    accuracy,
    { resolveEvidence, strict: true },
  );
  assert.equal(got.facts[0].status, "failed");
  assert.equal(got.facts[0].drop_reason, "number_absent");
  assert.equal(got.facts[0].worded, null, "not classified: it failed first");
});

test("strict on: an old-shape fact is classified against its quote once the matcher finds the quote", () => {
  const got = checkHandback(
    input([
      { id: "f1", value: "604 entries", source: "w1", quote: GOOD },
      { id: "f2", kind: "direct", value: "the listing has 604 entries", source: "w1", quote: GOOD },
      { id: "f3", kind: "llm", value: "the listing is long", source: "w1", quote: BAD },
      { id: "f4", kind: "llm", value: "the listing has 605 entries", source: "w1", quote: GOOD },
    ]),
    accuracy,
    { strict: true },
  );
  const view = Object.fromEntries(got.facts.map((f) => [f.id, [f.status, f.kind_checked, f.worded ?? null, f.drop_reason]]));
  assert.deepEqual(view, {
    f1: ["passed", "direct", false, null],
    f2: ["to_judge", "llm", true, null],
    f3: ["failed", "llm", null, "quote_absent"],
    f4: ["failed", "llm", null, "number_absent"],
  });
  assert.match(byId(got.facts, "f4").fix ?? "", /numbers that appear in the quote/);
});

test("strict on: an old-shape fact on a partial result is unchecked whatever kind it states (the flow drops it)", () => {
  const got = checkHandback(
    {
      payload: { facts: [{ id: "f1", kind: "llm", value: "604 entries", source: "w1", quote: GOOD }] },
      entries: [{ id: "w1", tool: "read", saved_result: "results/w1.txt", partial: true }],
      results: { w1: TEXT },
    },
    accuracy,
    { strict: true },
  );
  assert.equal(got.facts[0].status, "unchecked");
  assert.equal(got.facts[0].reason, "partial_result");
});

test("strict off (unchanged): no worded field, and a literal outside the quote is still refused for a direct fact", () => {
  const got = checkHandback(input([{ id: "f1", value: "605", source: "w1", quote: GOOD }]), accuracy);
  assert.equal(got.facts[0].reason, "literal_not_in_quote");
  assert.equal(got.facts[0].status, "failed");
  assert.ok(!Object.hasOwn(got.facts[0], "worded"), "check.json with strict off gains no field");
});
