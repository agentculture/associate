/**
 * The decider judges llm and derived facts (strict plan t4; spec c24, c31,
 * h18, c36). The decider is always a fake `fetch`; no test opens a socket.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadContract } from "../lib/contract.ts";
import { checkHandback } from "../lib/facts.ts";
import type { FactCheck, HandbackInput } from "../lib/facts.ts";
import { compileGate } from "../lib/gate.ts";
import { compileRedaction } from "../lib/walk.ts";
import { SUPPORT_QUESTION_KEY } from "../lib/support.ts";
import { countJudged, derivedInputs, judgeFacts, notJudgedMessage, policyFor } from "../lib/judge.ts";
import type { FactMaterial, JudgeDeps, StrictSettings } from "../lib/judge.ts";

const CONTRACT = loadContract({});
const { accuracy } = CONTRACT;
const STRICT = (accuracy as unknown as { strict: StrictSettings }).strict;
const SUPPORT = accuracy.support_score!;
const ENV = { ASSOCIATE_API_KEY: "dummy-judge-key", ASSOCIATE_BASE_URL: "http://decider.invalid:9/v1" };

const TEXT = "alpha line one\nbeta line two holds 604 entries\ngamma line three";
const GOOD = "beta line two holds 604 entries";
const BAD = "this sentence is nowhere in the saved result";

interface Call {
  body: any;
}

function fakeDecider(respond: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = { body: JSON.parse(String(init?.body ?? "null")) };
    calls.push(call);
    return respond(call, calls.length - 1);
  };
  return { fn: fn as typeof fetch, calls };
}

const json = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

/** Answers each question with its first listed option unless told otherwise. */
function answering(choiceFor: (question: "support" | "derived") => string = (q) => (q === "support" ? "all" : "yes")) {
  return fakeDecider((call) => {
    const key = Object.keys(call.body.questions)[0]!;
    const which = call.body.questions[key].instructions === STRICT.derived_question.question ? "derived" : "support";
    return json(200, { answers: { [key]: { type: "choice", choice: choiceFor(which), confidence: 0.9 } } });
  });
}

function records(facts: unknown[]): FactCheck[] {
  const input: HandbackInput = {
    payload: { facts },
    entries: [{ id: "w1", tool: "read", saved_result: "results/w1.txt" }],
    results: { w1: TEXT },
  };
  return checkHandback(input, accuracy).facts as FactCheck[];
}

function deps(fetchFn: typeof fetch, material: Record<string, FactMaterial>, over: Partial<JudgeDeps> = {}): JudgeDeps {
  return {
    settings: SUPPORT,
    strict: STRICT,
    config: compileGate(CONTRACT),
    env: ENV,
    redaction: compileRedaction(CONTRACT.policy),
    fetch: fetchFn,
    material: (id) => material[id],
    ...over,
  };
}

const LLM = { id: "f1", kind: "llm", value: "the file has 604 entries", source: "w1", quote: BAD };
const MATERIAL: Record<string, FactMaterial> = {
  f1: { value: "the file has 604 entries", evidence: GOOD },
  f2: { value: "the listing is long", evidence: null },
  d1: { value: "the file is large", evidence: null },
};

// ---------------------------------------------------------- llm fact (c24)

test("an llm fact goes to the decider with its value and the evidence, under the support question; the option is stored", async () => {
  const recs = records([LLM]);
  assert.equal(recs[0]!.status, "to_judge");
  const decider = answering(() => "mostly");
  const [got] = await judgeFacts(recs, deps(decider.fn, MATERIAL));
  assert.equal(decider.calls.length, 1);
  const body = decider.calls[0]!.body;
  assert.deepEqual(Object.keys(body.questions), [SUPPORT_QUESTION_KEY]);
  assert.equal(body.questions[SUPPORT_QUESTION_KEY].instructions, SUPPORT.question);
  assert.deepEqual(body.questions[SUPPORT_QUESTION_KEY].criteria, SUPPORT.options);
  assert.ok(body.state.includes(`value: ${JSON.stringify("the file has 604 entries")}`));
  assert.ok(body.state.includes(`quote: ${JSON.stringify(GOOD)}`));
  assert.equal(got!.status, "judged");
  assert.deepEqual(got!.judge, { question: "support", option: "mostly", judged: true, reason: null, confidence: 0.9 });
});

test("a fact that is not to_judge is passed through unsent, with judge null", async () => {
  const recs = records([{ id: "f1", kind: "direct", value: "the file has 604 entries", source: "w1", quote: GOOD }]);
  const decider = answering();
  const [got] = await judgeFacts(recs, deps(decider.fn, MATERIAL));
  assert.equal(decider.calls.length, 0);
  assert.equal(got!.status, "passed");
  assert.equal(got!.judge, null);
});

test("an llm fact with no evidence text is not judged (no_evidence) and nothing is sent", async () => {
  const decider = answering();
  const [got] = await judgeFacts(records([LLM]), deps(decider.fn, { f1: { value: "v", evidence: null } }));
  assert.equal(decider.calls.length, 0);
  assert.equal(got!.status, "not_judged");
  assert.equal(got!.judge!.reason, "no_evidence");
});

test("what reaches the decider is redacted", async () => {
  const secret = "password: hunter2hunter2";
  const decider = answering();
  await judgeFacts(
    records([LLM]),
    deps(decider.fn, { f1: { value: "v", evidence: `token ${secret} here` } }),
  );
  const state: string = decider.calls[0]!.body.state;
  const redacted = compileRedaction(CONTRACT.policy).apply(`token ${secret} here`);
  assert.notEqual(redacted, `token ${secret} here`, "the policy redacts this text");
  assert.ok(!state.includes("hunter2hunter2"));
});

// ------------------------------------------------------- derived fact (c31)

const FACTS = [
  { id: "f1", kind: "llm", value: "the file has 604 entries", source: "w1", quote: BAD },
  { id: "f2", kind: "direct", value: "the listing is long", source: "w1", quote: GOOD },
  { id: "d1", kind: "derived", value: "the file is large", source: "w1", quote: BAD, based_on: ["f1", "f2"] },
];

test("a derived fact is sent with its conclusion and the values of the facts it lists, under the derived question", async () => {
  const recs = records(FACTS);
  assert.equal(recs.find((r) => r.id === "d1")!.status, "to_judge");
  const decider = answering();
  const out = await judgeFacts(recs, deps(decider.fn, MATERIAL));
  const derivedCall = decider.calls.find((c) => "derived" in c.body.questions || c.body.state.includes("conclusion:"))!;
  const key = Object.keys(derivedCall.body.questions)[0]!;
  assert.equal(derivedCall.body.questions[key].instructions, STRICT.derived_question.question);
  assert.deepEqual(derivedCall.body.questions[key].criteria, STRICT.derived_question.options);
  assert.ok(derivedCall.body.state.includes(`conclusion: ${JSON.stringify("the file is large")}`));
  assert.ok(
    derivedCall.body.state.includes(
      `listed facts: ${JSON.stringify("f1: the file has 604 entries\nf2: the listing is long")}`,
    ),
  );
  assert.ok(!derivedCall.body.state.includes(SUPPORT.background!), "the support background is not sent");
  const d1 = out.find((r) => r.id === "d1")!;
  assert.equal(d1.status, "judged", JSON.stringify(d1.judge));
  assert.deepEqual(d1.judge, { question: "derived", option: "yes", judged: true, reason: null, confidence: 0.9 });
});

test("a derived answer never drops the fact: policy is show_only while derived_decides_drops is false", async () => {
  assert.equal(STRICT.derived_decides_drops, false);
  for (const option of Object.keys(STRICT.derived_question.options)) {
    assert.equal(policyFor(option, "derived", STRICT, SUPPORT.passes), "show_only");
  }
  const decider = answering((q) => (q === "support" ? "all" : "no"));
  const out = await judgeFacts(records(FACTS), deps(decider.fn, MATERIAL));
  const d1 = out.find((r) => r.id === "d1")!;
  assert.equal(d1.judge!.option, "no");
  assert.notEqual(d1.status, "dropped");
  assert.notEqual(d1.status, "failed");
});

test("a listed fact with no value is shown by its copied quote, marked; with neither it is marked unavailable", () => {
  const material: Record<string, FactMaterial> = {
    a: { value: null, evidence: "copied text" },
    b: { value: "   ", evidence: null },
    c: { value: "has a value", evidence: "ignored quote" },
  };
  const text = derivedInputs(["a", "b", "c", "zz"], (id) => material[id]);
  assert.equal(
    text,
    [
      "a: (no value given; its copied quote) copied text",
      "b: (no value or quote available)",
      "c: has a value",
      "zz: (no value or quote available)",
    ].join("\n"),
  );
  assert.equal(derivedInputs(["b", "zz"], (id) => material[id]), null, "nothing usable at all");
});

test("a derived fact with nothing usable to send is not judged (no_inputs)", async () => {
  const decider = answering();
  const out = await judgeFacts(records(FACTS), deps(decider.fn, { d1: MATERIAL.d1! }));
  const d1 = out.find((r) => r.id === "d1")!;
  assert.equal(d1.status, "not_judged");
  assert.equal(d1.judge!.reason, "no_inputs");
});

test("a derived fact whose input failed is dropped by t3's cascade and is never sent", async () => {
  const recs = records([
    { id: "f1", kind: "direct", value: "x", source: "w1", quote: BAD },
    { id: "d1", kind: "derived", value: "y", source: "w1", quote: BAD, based_on: ["f1"] },
  ]);
  assert.equal(recs.find((r) => r.id === "d1")!.status, "dropped");
  const decider = answering();
  const out = await judgeFacts(recs, deps(decider.fn, MATERIAL));
  assert.equal(decider.calls.length, 0);
  assert.equal(out.find((r) => r.id === "d1")!.status, "dropped");
});

// ------------------------------------------------------------- outage (h18)

test("decider unreachable: not judged with the reason, not failed or dropped, and the message names the outage", async () => {
  const down = fakeDecider(() => {
    throw new Error("connect ECONNREFUSED");
  });
  const out = await judgeFacts(records(FACTS), deps(down.fn, MATERIAL));
  const judged = out.filter((r) => r.judge !== null);
  assert.ok(judged.length >= 2);
  for (const r of judged) {
    assert.equal(r.status, "not_judged");
    assert.notEqual(r.status, "failed");
    assert.notEqual(r.status, "dropped");
    assert.equal(r.judge!.judged, false);
    assert.equal(r.judge!.option, null);
  }
  assert.equal(judged[0]!.judge!.reason, "unreachable");
  assert.equal(down.calls.length, 1, "no further request after the decider failed");
  assert.equal(judged[1]!.judge!.reason, "skipped_after_failure");
  const message = notJudgedMessage(out)!;
  assert.match(message, /outage/);
  assert.match(message, /not judged/);
  assert.match(message, /not dropped as failed/);
  assert.match(message, /f1/);
  assert.match(message, /unreachable/);
});

test("a malformed answer is not judged, with reason malformed; an HTTP error likewise", async () => {
  const bad = fakeDecider(() => json(200, { answers: { support: { type: "choice", choice: "bogus", confidence: 0.9 } } }));
  const [got] = await judgeFacts(records([LLM]), deps(bad.fn, MATERIAL));
  assert.equal(got!.status, "not_judged");
  assert.equal(got!.judge!.reason, "malformed");
  const http = fakeDecider(() => json(503, "down"));
  const [h] = await judgeFacts(records([LLM]), deps(http.fn, MATERIAL));
  assert.equal(h!.judge!.reason, "http_error");
});

test("no key: not judged with no_key, nothing sent", async () => {
  const decider = answering();
  const [got] = await judgeFacts(records([LLM]), deps(decider.fn, MATERIAL, { env: {} }));
  assert.equal(decider.calls.length, 0);
  assert.equal(got!.judge!.reason, "no_key");
});

test("no message when every fact was judged or passed", async () => {
  const out = await judgeFacts(records([LLM]), deps(answering().fn, MATERIAL));
  assert.equal(notJudgedMessage(out), null);
});

// ------------------------------------------------------------ counting (c36)

test("judged llm and derived facts are never counted with direct-passed facts", async () => {
  const facts = [
    { id: "p1", kind: "direct", value: "604 entries", source: "w1", quote: GOOD },
    { id: "p2", kind: "llm", value: "beta line two", source: "w1", quote: GOOD },
    ...FACTS,
  ];
  const mat = { ...MATERIAL };
  const out = await judgeFacts(records(facts), deps(answering().fn, mat));
  assert.deepEqual(countJudged(out), { direct_passed: 3, llm_judged: 1, derived_judged: 1, not_judged: 0 });
  const down = fakeDecider(() => {
    throw new Error("down");
  });
  const outage = await judgeFacts(records(facts), deps(down.fn, mat));
  assert.deepEqual(countJudged(outage), { direct_passed: 3, llm_judged: 0, derived_judged: 0, not_judged: 2 });
});

// -------------------------------------------------------------- policyFor

test("policyFor applies the contract's lists to a support option", () => {
  assert.equal(policyFor("all", "support", STRICT, SUPPORT.passes), "pass");
  assert.equal(policyFor("mostly", "support", STRICT, SUPPORT.passes), "pass");
  assert.equal(policyFor("part", "support", STRICT, SUPPORT.passes), "keep_marked");
  assert.equal(policyFor("little", "support", STRICT, SUPPORT.passes), "keep_marked");
  assert.equal(policyFor("none", "support", STRICT, SUPPORT.passes), "drop");
  assert.equal(policyFor("other", "support", STRICT, SUPPORT.passes), "show_only");
  const open = { ...STRICT, derived_decides_drops: true };
  assert.equal(policyFor("yes", "derived", open, SUPPORT.passes), "pass");
  assert.equal(policyFor("no", "derived", open, SUPPORT.passes), "drop");
});
