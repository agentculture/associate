/**
 * The strict answer (strict-facts plan t6; spec c1, c6, c7, c35, h11).
 *
 * `renderStrictAnswer` is driven from a real `runStrict` result with a fake
 * judge (no decider, no network). One group per acceptance criterion:
 *   1. the answer section holds only passed and kept-marked items, each with
 *      its kind, command, result file and the copied evidence;
 *   2. no sentence of the summary or the final message is in the answer
 *      section, and both stay in the export under the unchecked label;
 *   3. the answer counts dropped items by reason, and every dropped item is in
 *      dropped.json with its reason;
 *   4. report.json's `strict` object counts each way a fact was checked.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadContract } from "../lib/contract.ts";
import type { HandbackInput } from "../lib/facts.ts";
import type { JudgedFact } from "../lib/judge.ts";
import { UNCHECKED_HEADING, codeSpan, fenceFor, renderStrictAnswer } from "../lib/render.ts";
import { evidenceContextFor, droppedRecord, runStrict, strictReport, type StrictJudge } from "../lib/strict.ts";
import { renderCommand } from "../lib/evidence.ts";
import { compileRedaction } from "../lib/walk.ts";
import { SUPPORT_QUESTION_KEY } from "../lib/support.ts";
import { STRICT_ENV } from "../lib/strict.ts";
import { callFinish, fireFinalMessage, openSession } from "./support-scenario.ts";

const CONTRACT = loadContract({});
const { accuracy } = CONTRACT;
const STRICT = accuracy.strict!;

const ROLES = [
  "1\tROLE_RESPONSIBILITIES = {",
  '2\t    "worker": ["execution", "tool_use", "repo_inspection"],',
  '3\t    "senses": ["intake", "normalize_input"],',
  "4\t}",
].join("\n");
const COUNT = "4 roles.py";
const TICKS = ["1\tuse ```fenced``` text here", "2\tand a `span` too"].join("\n");

const ENTRIES = [
  { id: "w1", tool: "read", args: { path: "roles.py", purpose: "read the table" }, saved_result: "results/w1.txt", source_kind: "file" },
  { id: "w2", tool: "bash", args: { argv: ["wc", "-l", "roles.py"], purpose: "count" }, saved_result: "results/w2.txt", source_kind: "command" },
  { id: "w3", tool: "read", args: { path: "ticks.md", purpose: "read" }, saved_result: "results/w3.txt", source_kind: "file" },
];

function input(payload: unknown, extra: Partial<HandbackInput> = {}): HandbackInput {
  return {
    payload,
    entries: ENTRIES as never[],
    results: { w1: ROLES, w2: COUNT, w3: TICKS },
    prior_runs: {},
    children: [],
    ...extra,
  };
}

const judge = (answers: Record<string, string>): StrictJudge => async (facts) =>
  facts.map((f): JudgedFact => {
    if (f.status !== "to_judge") return { ...f, judge: null };
    const question = f.kind_stated === "derived" ? "derived" : "support";
    const option = answers[f.id];
    return option === undefined
      ? { ...f, status: "not_judged", judge: { question, option: null, judged: false, reason: "unreachable", confidence: null } }
      : { ...f, status: "judged", judge: { question, option, judged: true, reason: null, confidence: 0.9 } };
  });

async function run(payload: Record<string, unknown>, answers: Record<string, string>, extra: Partial<HandbackInput> = {}) {
  const handbackInput = input(payload, extra);
  const result = await runStrict({
    handbackInput,
    accuracy,
    settings: STRICT,
    passes: accuracy.support_score!.passes,
    evidence: evidenceContextFor(handbackInput, {
      checkoutRoot: "/nonexistent/checkout",
      redact: compileRedaction(CONTRACT.policy).apply,
      sourceKinds: accuracy.source_kinds,
    }),
    judge: judge(answers),
    returnedBefore: new Set(),
    canReturn: false,
    round: 1,
  });
  return { ...result, payload };
}

const SUMMARY = "The role table has two roles. Nothing else was read.";
const FINAL = "I looked at the table and it seems complete.";

const F_COUNT = { id: "f1", kind: "direct", source: "w2", at: { lines: [1, 1] }, value: "4" };
const F_LLM = { id: "f2", kind: "llm", source: "w1", at: { lines: [2, 2] }, value: "senses" };
const F_DERIVED = { id: "f3", kind: "derived", source: "w1", at: { lines: [1, 4] }, value: "two-roles", based_on: ["f1", "f2"] };
const F_MARKED = { id: "f4", kind: "llm", source: "w1", at: { lines: [2, 2] }, value: "planner" };
const F_BAD = { id: "f5", source: "w1", value: "pyproject.toml", quote: "a copy sits in pyproject.toml" };
const F_NONE = { id: "f6", kind: "llm", source: "w1", at: { lines: [2, 2] }, value: "reviewer" };
const F_OLD = { id: "f7", source: "w1", value: "ROLE_RESPONSIBILITIES", quote: "ROLE_RESPONSIBILITIES = {" };

const FULL = {
  summary: SUMMARY,
  facts: [F_COUNT, F_LLM, F_DERIVED, F_MARKED, F_BAD, F_NONE, F_OLD],
  verdicts: [
    { id: "v1", verdict: "supported", text: "The table has two roles.", basis: ["f1", "f2"] },
    { id: "v2", verdict: "supported", text: "It rests on a bad fact.", basis: ["f5"] },
  ],
  open_items: [{ id: "o1", text: "Is a third role planned?", check: "read the roadmap" }],
};
const ANSWERS = { f2: "all", f3: "all", f4: "part", f6: "none" };

async function full(finalMessage?: string) {
  const result = await run(FULL, ANSWERS);
  const answer = renderStrictAnswer({ payload: FULL, decision: result.decision, markText: STRICT.mark_text, summary: SUMMARY, finalMessage, legacy });
  return { ...result, answer };
}

/** What index.ts hands the renderer for an old-shape fact: the command of the call it cites. */
const legacy = (source: string) => {
  const entry = ENTRIES.find((e) => e.id === source);
  return entry ? { command: renderCommand(entry, { checkoutRoot: "/nonexistent/checkout", redact: (t) => t }).command, result_file: entry.saved_result } : undefined;
};

const section = (answer: string) => answer.slice(0, answer.indexOf(UNCHECKED_HEADING));

// ------------------------------------------------- 1. only passed and marked items

test("the answer section holds passed and kept-marked facts, each with kind, command, result and copied evidence", async () => {
  const { decision, answer } = await full();
  assert.deepEqual(
    decision.facts.map((f) => [f.id, f.strict_outcome]),
    [["f1", "pass"], ["f2", "pass"], ["f3", "pass"], ["f4", "keep_marked"], ["f5", "dropped"], ["f6", "dropped"], ["f7", "pass"]],
  );
  const body = section(answer);
  const ids = [...body.matchAll(/^\*\*(f\d+):\*\*/gm)].map((m) => m[1]);
  assert.deepEqual(ids, ["f1", "f2", "f3", "f4", "f7"], "in the model's order; no dropped fact");

  // f1: a direct count fact, checked by running the command again.
  assert.match(body, /\*\*f1:\*\* 4\n\n- kind: direct \(copied from the result\)\n- how to check: `wc -l roles.py`\n- result: `results\/w2.txt`, line 1\n\n```text\n4 roles.py\n```/);
  // f2: llm, judged.
  assert.match(body, /\*\*f2:\*\* senses\n\n- kind: llm \(judged by the decider: all\)\n- how to check: `read roles.py`\n- result: `results\/w1.txt`, line 2\n\n```text\n2\t {4}"worker": \["execution"/);
  // f3: derived from f1, f2.
  assert.match(body, /- kind: derived \(from f1, f2; the decider answered all\)/);
  // f4: kept with the mark and the option.
  assert.match(body, new RegExp(`- marked: ${STRICT.mark_text} \\(the decider answered part\\)`));
  // f7: an old-shape fact shows its quote and the command of the call it cites.
  assert.match(body, /\*\*f7:\*\* ROLE_RESPONSIBILITIES\n\n- kind: direct \(quote found in the result\)\n- how to check: `read roles.py`\n- result: `results\/w1.txt`, the quote as the model gave it, found in it\n\n```text\nROLE_RESPONSIBILITIES = \{\n```/);
});

test("conclusions and open items stay in the answer only when their basis is not dropped", async () => {
  const { answer } = await full();
  const body = section(answer);
  assert.match(body, /- v1 \[supported\] The table has two roles\. \(rests on f1, f2\)/);
  assert.doesNotMatch(body, /v2/);
  assert.match(body, /- o1: Is a third role planned\? \(deciding check: read the roadmap\)/);
});

test("copied evidence is byte for byte, in a fence the content cannot close; commands in a code span", async () => {
  const payload = { facts: [{ id: "f1", source: "w3", at: { lines: [1, 2] }, value: "fenced" }] };
  const { decision } = await run(payload, {});
  const answer = renderStrictAnswer({ payload, decision, markText: STRICT.mark_text });
  const quote = decision.facts[0].evidence!.quote;
  assert.equal(quote, TICKS);
  assert.ok(section(answer).includes(`\n\`\`\`\`text\n${quote}\n\`\`\`\`\n`), "a four-backtick fence around text holding three");
  assert.equal(fenceFor("a ``` b"), "````");
  assert.equal(fenceFor("plain"), "```");
  assert.equal(codeSpan("a`b"), "``a`b``");
  assert.equal(codeSpan("`x"), "`` `x ``");
});

test("a fact with no value shows the copied text as its value", async () => {
  const payload = { facts: [{ id: "f1", source: "w2", at: { lines: [1, 1] } }] };
  const { decision } = await run(payload, {});
  const body = section(renderStrictAnswer({ payload, decision, markText: STRICT.mark_text }));
  assert.match(body, /\*\*f1:\*\* 4 roles\.py\n/);
});

test("a fact resting on a labelled run says which run; one whose labelled export was not read is not in the answer", async () => {
  const prior = { entries: [ENTRIES[0]], results: { w1: ROLES } };
  const payload = {
    facts: [
      { id: "f1", source: "prior:w1", at: { lines: [1, 1] }, value: "ROLE_RESPONSIBILITIES" },
      { id: "f2", source: "c9:w1", at: { lines: [1, 1] }, value: "ROLE_RESPONSIBILITIES" },
    ],
  };
  const { decision } = await run(payload, {}, { prior_runs: { prior } });
  const body = section(renderStrictAnswer({ payload, decision, markText: STRICT.mark_text }));
  assert.match(body, /\*\*f1:\*\*[^]*- run: it rests on the labelled run prior; its saved result was read here/);
  assert.doesNotMatch(body, /\*\*f2:\*\*/);
  assert.equal(decision.facts[1].strict_outcome, "dropped");
});

test("the kind line says what was checked: direct when copied, llm when judged, with the stated kind when it differs", async () => {
  const payload = {
    facts: [
      // stated llm, value word for word in line 1: direct
      { id: "f1", kind: "llm", source: "w1", at: { lines: [1, 1] }, value: "ROLE_RESPONSIBILITIES" },
      // stated direct, value in its own words: judged as llm
      { id: "f2", kind: "direct", source: "w2", at: { lines: [1, 1] }, value: "roles.py has 4 lines" },
      // stated direct, copied: no stated suffix
      { id: "f3", kind: "direct", source: "w2", at: { lines: [1, 1] }, value: "4 roles.py" },
    ],
  };
  const { decision } = await run(payload, { f2: "all" });
  const body = section(renderStrictAnswer({ payload, decision, markText: STRICT.mark_text }));
  assert.match(body, /\*\*f1:\*\* ROLE_RESPONSIBILITIES\n\n- kind: direct \(copied from the result\); stated: llm\n/);
  assert.match(body, /\*\*f2:\*\* roles\.py has 4 lines\n\n- kind: llm \(judged by the decider: all\); stated: direct\n/);
  assert.match(body, /\*\*f3:\*\* 4 roles\.py\n\n- kind: direct \(copied from the result\)\n/);
  // The legend says which items the harness copied and which the decider judged.
  assert.match(body, /Items marked direct: the harness copied the evidence/);
  assert.match(body, /Items marked llm: the value is in the model's own words/);
  assert.doesNotMatch(body, /was checked by the harness/);
});

// ---------------------------------------- 2. the model's own words stay unchecked

test("no sentence of the summary or the final message is in the answer section; both are under the unchecked label", async () => {
  const { answer } = await full(FINAL);
  const body = section(answer);
  for (const sentence of [...SUMMARY.split(/(?<=\.)\s+/), FINAL]) {
    assert.ok(!body.includes(sentence.replace(/\.$/, "")), `in the answer section: ${sentence}`);
    assert.ok(answer.includes(sentence), `missing from the export text: ${sentence}`);
  }
  const tail = answer.slice(answer.indexOf(UNCHECKED_HEADING));
  assert.match(tail, /Finish summary \(2 sentences\):/);
  assert.match(tail, /Final message \(1 sentence\):/);
});

// --------------------------------------------- 3. dropped items, by reason

test("the answer says how many items were dropped by reason, returned and not judged, each only when non-zero", async () => {
  const { answer } = await full();
  assert.match(
    section(answer),
    /3 items were dropped \(1 quote_absent, 1 decider_drop, 1 basis_refused\); dropped\.json/,
  );
  const line = section(answer).split("\n").find((l) => l.includes("were dropped"))!;
  assert.match(line, /decider_drop/);
  assert.match(line, /basis_refused/);
  assert.doesNotMatch(section(answer), /returned|not judged/);

  const clean = { facts: [F_COUNT] };
  const result = await run(clean, {});
  const plain = renderStrictAnswer({ payload: clean, decision: result.decision, markText: STRICT.mark_text });
  assert.doesNotMatch(section(plain), /dropped|returned|not judged/);

  // a returned fact and a not-judged fact
  const two = { facts: [F_LLM, F_MARKED] };
  const handbackInput = input(two);
  const r = await runStrict({
    handbackInput,
    accuracy,
    settings: STRICT,
    passes: accuracy.support_score!.passes,
    evidence: evidenceContextFor(handbackInput, { checkoutRoot: "/x", redact: (t) => t, sourceKinds: accuracy.source_kinds }),
    judge: judge({ f4: "part" }),
    returnedBefore: new Set(),
    canReturn: true,
    round: 1,
  });
  const text = section(renderStrictAnswer({ payload: two, decision: r.decision, markText: STRICT.mark_text }));
  assert.match(text, /1 item was returned and not answered again; it is not in this answer\./);
  assert.match(text, /1 item was not judged \(1 unreachable\); it is not in this answer\./);
});

test("dropped.json holds every dropped item with its reason and fix, and returned and not-judged items under their own keys", async () => {
  const { decision } = await full();
  const record = droppedRecord(FULL, decision);
  assert.deepEqual(
    record.dropped.map((d) => [d.id, d.item, d.reason]),
    [["f5", "fact", "quote_absent"], ["f6", "fact", "decider_drop"], ["v2", "verdict", "basis_refused"]],
  );
  assert.equal(record.dropped.length, decision.dropped.length);
  assert.equal(record.dropped[0].value, "pyproject.toml", "the value as given");
  assert.ok(record.dropped.every((d) => d.fix.length > 0));
  assert.deepEqual(record.returned, []);
  assert.deepEqual(record.not_judged, []);
});

// ------------------------------------------------------- 4. report.json counts

test("report.json's strict object counts each way a fact was checked, and facts per stated kind", async () => {
  const { decision } = await full();
  assert.deepEqual(strictReport(decision), {
    direct_passed: 2,
    llm_judged: 1,
    derived: 1,
    kept_with_mark: 1,
    returned: 0,
    not_judged: 0,
    dropped: { total: 2, by_reason: { quote_absent: 1, decider_drop: 1 } },
    by_stated_kind: {
      direct: { stated: 3, checked_as_direct: 2 },
      llm: { stated: 3, checked_as_direct: 0 },
      derived: { stated: 1, checked_as_direct: 0 },
    },
    worded: 4,
    judged: 4,
  });
});

// -------------------------------------------------------------- wording

test("the harness's own words never say accuracy, score, verified or true", async () => {
  const { answer } = await full();
  assert.doesNotMatch(section(answer), /\b(accuracy|score|scored|verified|true)\b/i);
});

// ------------------------------------------------ through finish, in the export

function choice(option: string): Response {
  const answer = { type: "choice", choice: option, confidence: 0.9, probabilities: { [option]: 0.9 } };
  return new Response(JSON.stringify({ model: "clef", answers: { [SUPPORT_QUESTION_KEY]: answer } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("through finish: answer.md, dropped.json and report.json strict; summary and final message only under the unchecked label", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => choice("none")) as typeof fetch;
  const s = await openSession({ [STRICT_ENV]: undefined, ASSOCIATE_API_KEY: "test-key" });
  try {
    const good = { id: "f1", kind: "direct", source: "w1", at: { lines: [1, 1] }, value: "ROLE_RESPONSIBILITIES" };
    const judged = { id: "f2", kind: "llm", source: "w1", at: { lines: [2, 2] }, value: "senses" };
    const result = await callFinish(s.pi, "fin-1", { summary: SUMMARY, facts: [good, judged] });
    assert.equal(result.details.outcome, "returned");
    await fireFinalMessage(s.pi, FINAL);
    const answer = readFileSync(join(s.exportDir, "answer.md"), "utf8");
    const body = section(answer);
    assert.match(body, /\*\*f1:\*\* ROLE_RESPONSIBILITIES/);
    assert.doesNotMatch(body, /\*\*f2:\*\*/);
    assert.match(body, /1 item was dropped \(1 decider_drop\)/);
    for (const text of ["The role table has two roles", FINAL]) {
      assert.ok(!body.includes(text), `in the answer section: ${text}`);
      assert.ok(answer.slice(answer.indexOf(UNCHECKED_HEADING)).includes(text), `not under the unchecked label: ${text}`);
    }
    const dropped = JSON.parse(readFileSync(join(s.exportDir, "dropped.json"), "utf8"));
    assert.deepEqual(dropped.dropped.map((d: any) => [d.id, d.reason, d.value]), [["f2", "decider_drop", "senses"]]);
    assert.ok(existsSync(join(s.exportDir, "report.json")));
    const report = JSON.parse(readFileSync(join(s.exportDir, "report.json"), "utf8"));
    assert.equal(report.strict.direct_passed, 1);
    assert.deepEqual(report.strict.dropped, { total: 1, by_reason: { decider_drop: 1 } });
    assert.equal(report.facts.made, 2, "existing keys stay");
  } finally {
    globalThis.fetch = original;
    s.dispose();
  }
});
