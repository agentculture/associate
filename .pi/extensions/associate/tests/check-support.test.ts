/**
 * `check_quote` returns the support score (decider-score plan task t4; spec
 * c6, h15; scope findings s4, s8).
 *
 * One group per acceptance criterion:
 *   1. the verdict and nearest text are what they were for the same inputs,
 *      and one key is added (`support`) holding the score or a not-scored
 *      reason;
 *   2. the key is present only when a value is given AND the score is on for
 *      the session AND the matcher found the quote; with the decider
 *      unreachable it reports not scored;
 *   3. the words in the key can be acted on by a reader who does not know what
 *      the decider is;
 *   4. the tool shares the session's cache and options with finish: a pair
 *      checked here and handed back later is one decider request in total.
 *
 * `check.test.ts` pins the keys the tool had before and is left unedited. The
 * fake decider is an injected `fetch` (or `globalThis.fetch` for a session
 * loaded through index.ts); no live network call is made.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssociateContext } from "../lib/runtime.ts";
import { loadContract } from "../lib/contract.ts";
import { compileGate } from "../lib/gate.ts";
import { saveResult } from "../lib/results.ts";
import { compileRedaction } from "../lib/walk.ts";
import {
  SUPPORT_QUESTION_KEY,
  createSupportCache,
  type SupportCache,
  type SupportNotScoredReason,
  type SupportOptions,
} from "../lib/support.ts";
import { SUPPORT_SCORE_ENV } from "../lib/supportswitch.ts";
import { CHECK_FILENAME } from "../lib/handback.ts";
import { CHECK_TOOL_NAME, register, supportMeaning } from "../tools/check.ts";
import type { AssociateContext } from "../lib/context.ts";
import { GOOD_FACT, GOOD_PAYLOAD, READ_TEXT, callFinish, openSession } from "./support-scenario.ts";

const CONTRACT = loadContract({});
const SETTINGS = CONTRACT.accuracy.support_score!;
const SAVED = "1\texport function alpha() {\n2\t  return computeTheAnswer(42);\n3\t}\n";
const FOUND = "return computeTheAnswer(42);";
const ABSENT = "return computeTheQuestion(42);";
const VALUE = "alpha returns the answer computed from 42";

const AT_OR_ABOVE = "the quote, on its own, states or directly shows this value";
const BELOW =
  "the quote does not, on its own, show this value: check the value against the quote, " +
  "quote the line that states it, or say you cannot tell";
const NOT_SCORED = /^not scored \((.+)\); this is not a judgement on the claim$/;
/** Words a reader would have to know the machinery to understand. */
const INSIDE_WORDS = /decider|clef|systemone|noul|gateway|lobes|cut-?off|threshold/i;

type Tool = {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute: (
    id: string,
    params: unknown,
    signal?: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: any }>;
};

class FakePi {
  tools: Tool[] = [];
  registerTool(definition: Tool): void {
    this.tools.push(definition);
  }
}

function scoreResponse(score: number): Response {
  return new Response(JSON.stringify({ model: "clef", answers: { [SUPPORT_QUESTION_KEY]: { type: "noul", noul: score } } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function pairOf(state: string): { value: string; quote: string } {
  const line = (label: string) => {
    const found = state.split("\n").find((l) => l.startsWith(`${label}: `));
    return found ? (JSON.parse(found.slice(label.length + 2)) as string) : "";
  };
  return { value: line("value"), quote: line("quote") };
}

interface Decider {
  calls: Array<{ value: string; quote: string; raw: string }>;
  fetch: typeof fetch;
}

function decider(answer: (pair: { value: string; quote: string }, init?: RequestInit) => Promise<Response> | Response): Decider {
  const calls: Decider["calls"] = [];
  const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
    const raw = String(init?.body ?? "null");
    const pair = pairOf(String(JSON.parse(raw)?.state ?? ""));
    calls.push({ ...pair, raw });
    return answer(pair, init);
  }) as typeof fetch;
  return { calls, fetch: fake };
}

interface RigOptions {
  /** The fake decider; absent means the score is off (nothing is attached). */
  decider?: Decider;
  /** Attached, but the options cannot be built (the score is on and cannot be asked). */
  unavailable?: boolean;
  settings?: typeof SETTINGS;
  env?: Record<string, string | undefined>;
  cache?: SupportCache;
  toolEnv?: Record<string, string | undefined>;
  prior?: string;
}

async function rig(options: RigOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "associate-check-support-"));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  const ctx: AssociateContext = createAssociateContext({
    checkoutRoot: checkout,
    contract: CONTRACT,
    env: { ASSOCIATE_EXPORT_ROOT: join(root, "runs"), ASSOCIATE_SESSION_ID: "t4-check" },
  });
  saveResult(ctx.session.exportDir, "w3", SAVED, 0);
  const cache = options.cache ?? createSupportCache();
  if (options.unavailable) ctx.attachSupport(() => null);
  else if (options.decider) {
    const fake = options.decider;
    ctx.attachSupport(
      (signal): SupportOptions => ({
        settings: options.settings ?? SETTINGS,
        config: compileGate(CONTRACT),
        env: options.env ?? { ASSOCIATE_API_KEY: "test-key" },
        redaction: compileRedaction(CONTRACT.policy),
        fetch: fake.fetch,
        cache,
        signal,
      }),
    );
  }
  let toolEnv = options.toolEnv;
  if (options.prior !== undefined) {
    const priorExport = join(root, "prior", "export");
    mkdirSync(priorExport, { recursive: true });
    writeFileSync(
      join(priorExport, "walk.jsonl"),
      `${JSON.stringify({ id: "w3", ts: "t", tool: "read", args: {}, result: {}, truncated: false })}\n`,
    );
    saveResult(priorExport, "w3", options.prior, 0);
    toolEnv = { ...toolEnv, ASSOCIATE_CONTINUE_FROM: priorExport };
  }
  const pi = new FakePi();
  await register(pi, ctx, toolEnv ?? {});
  const tool = pi.tools.find((t) => t.name === CHECK_TOOL_NAME)!;
  return { ctx, tool, cache, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/** A result with the added key taken out, for comparing with what the tool returned before. */
function withoutSupport(out: { content: Array<{ text: string }>; details: any }): { shown: unknown; details: unknown } {
  const { support: _a, ...shown } = JSON.parse(out.content[0]!.text);
  const { support: _b, ...details } = out.details;
  return { shown, details };
}

// --- AC1: the same verdict and nearest text, plus one added key ----------------

test("AC1: a found quote with a value returns the old keys unchanged plus one key, support, holding the score", async () => {
  const plain = await rig();
  const fake = decider(() => scoreResponse(0.9));
  const scored = await rig({ decider: fake });
  try {
    const before = await plain.tool.execute("a", { source: "w3", quote: FOUND, value: VALUE });
    const after = await scored.tool.execute("a", { source: "w3", quote: FOUND, value: VALUE });
    assert.deepEqual(withoutSupport(after), withoutSupport(before));
    assert.deepEqual(
      Object.keys(after.details).filter((key) => !(key in before.details)),
      ["support"],
    );
    assert.deepEqual(after.details.support, {
      status: "scored",
      score: 0.9,
      at_or_above_cutoff: true,
      meaning: AT_OR_ABOVE,
    });
    assert.deepEqual(JSON.parse(after.content[0]!.text).support, after.details.support);
    assert.equal(after.details.verdict, "passed");
    assert.deepEqual(fake.calls.map((c) => [c.value, c.quote]), [[VALUE, FOUND]]);
  } finally {
    plain.dispose();
    scored.dispose();
  }
});

test("AC1: a score below the contract's cut-off is reported as below, with the fix in words", async () => {
  const fake = decider(() => scoreResponse(0.2));
  const r = await rig({ decider: fake });
  try {
    const out = await r.tool.execute("a", { source: "w3", quote: FOUND, value: VALUE });
    assert.equal(out.details.verdict, "passed", "the score never changes the matcher's verdict");
    assert.deepEqual(out.details.support, { status: "scored", score: 0.2, at_or_above_cutoff: false, meaning: BELOW });
  } finally {
    r.dispose();
  }
});

test("AC1: the comparison uses the cut-off from the settings it was handed, not a number of its own", async () => {
  const fake = decider(() => scoreResponse(0.9));
  const r = await rig({ decider: fake, settings: { ...SETTINGS, cutoff: 0.95 } });
  try {
    const out = await r.tool.execute("a", { source: "w3", quote: FOUND, value: VALUE });
    assert.equal(out.details.support.at_or_above_cutoff, false);
    assert.equal(out.details.support.meaning, BELOW);
  } finally {
    r.dispose();
  }
});

test("AC1: a labelled source is scored like a current-run one", async () => {
  const fake = decider(() => scoreResponse(0.8));
  const r = await rig({ decider: fake, prior: "1\tthe prior run read this line only\n" });
  try {
    const out = await r.tool.execute("a", {
      source: "prior:w3",
      quote: "the prior run read this line only",
      value: "the prior run read one line",
    });
    assert.equal(out.details.verdict, "passed");
    assert.equal(out.details.source, "prior:w3");
    assert.equal(out.details.support.status, "scored");
    assert.equal(out.details.support.score, 0.8);
    assert.equal(fake.calls.length, 1);
  } finally {
    r.dispose();
  }
});

// --- AC2: when the key is present ----------------------------------------------

test("AC2: without a value nothing is asked and the result is exactly what it was", async () => {
  const plain = await rig();
  const fake = decider(() => scoreResponse(0.9));
  const scored = await rig({ decider: fake });
  try {
    for (const params of [
      { source: "w3", quote: FOUND },
      { source: "w3", quote: FOUND, literal: "42" },
      { source: "w3", quote: ABSENT },
      { source: "w9", quote: FOUND },
    ]) {
      const before = await plain.tool.execute("a", params);
      const after = await scored.tool.execute("a", params);
      assert.deepEqual(after, before, JSON.stringify(params));
      assert.ok(!("support" in after.details));
    }
    assert.equal(fake.calls.length, 0);
  } finally {
    plain.dispose();
    scored.dispose();
  }
});

test("AC2: with the score off for the session a value adds no key", async () => {
  const r = await rig();
  try {
    const withValue = await r.tool.execute("a", { source: "w3", quote: FOUND, value: VALUE });
    const without = await r.tool.execute("a", { source: "w3", quote: FOUND });
    assert.deepEqual(withValue, without);
    assert.ok(!("support" in withValue.details));
    assert.ok(!withValue.content[0]!.text.includes("support"));
  } finally {
    r.dispose();
  }
});

test("AC2: a quote the matcher did not find is not asked about and gets no key", async () => {
  const plain = await rig();
  const fake = decider(() => scoreResponse(0.9));
  const scored = await rig({ decider: fake });
  try {
    for (const params of [
      { source: "w3", quote: ABSENT, value: VALUE }, // refused: quote_absent
      { source: "w3", quote: "alpha", value: VALUE }, // refused: quote_short
      { source: "w3", quote: FOUND, literal: "43", value: VALUE }, // refused: literal_not_in_quote
      { source: "w9", quote: FOUND, value: VALUE }, // unchecked: no saved text
    ]) {
      const before = await plain.tool.execute("a", params);
      const after = await scored.tool.execute("a", params);
      assert.notEqual(after.details.verdict, "passed", JSON.stringify(params));
      assert.deepEqual(after, before, JSON.stringify(params));
    }
    assert.equal(fake.calls.length, 0);
  } finally {
    plain.dispose();
    scored.dispose();
  }
});

test("AC2: with the decider failing in each way the key reports not scored and the verdict stands", async () => {
  const hang = () => new Promise<Response>(() => {});
  const cases: Array<[SupportNotScoredReason, RigOptions]> = [
    [
      "unreachable",
      {
        decider: decider(() => {
          throw new TypeError("fetch failed: ECONNREFUSED");
        }),
      },
    ],
    ["timeout", { decider: decider(hang), settings: { ...SETTINGS, timeout_ms: 20 } }],
    ["http_error", { decider: decider(() => new Response("no", { status: 503 })) }],
    ["malformed", { decider: decider(() => new Response("not json", { status: 200 })) }],
    ["no_key", { decider: decider(() => scoreResponse(0.9)), env: {} }],
  ];
  for (const [reason, options] of cases) {
    const r = await rig(options);
    try {
      const out = await r.tool.execute("a", { source: "w3", quote: FOUND, value: VALUE });
      assert.equal(out.details.verdict, "passed", reason);
      assert.equal(out.details.reason, null, reason);
      assert.equal(out.details.support.status, "not_scored", reason);
      assert.equal(out.details.support.reason, reason);
      assert.match(out.details.support.meaning, NOT_SCORED, reason);
      assert.ok(!("score" in out.details.support), reason);
      assert.ok(!("at_or_above_cutoff" in out.details.support), reason);
      assert.deepEqual(JSON.parse(out.content[0]!.text).support, out.details.support, reason);
    } finally {
      r.dispose();
    }
  }
});

test("AC2: switched on but with nothing to ask with, a value is reported not scored", async () => {
  const r = await rig({ unavailable: true });
  try {
    const out = await r.tool.execute("a", { source: "w3", quote: FOUND, value: VALUE });
    assert.equal(out.details.verdict, "passed");
    assert.equal(out.details.support.status, "not_scored");
    assert.match(out.details.support.meaning, NOT_SCORED);
  } finally {
    r.dispose();
  }
});

test("AC2: an empty value is given, so the key is present and says why there is no score", async () => {
  const fake = decider(() => scoreResponse(0.9));
  const r = await rig({ decider: fake });
  try {
    const out = await r.tool.execute("a", { source: "w3", quote: FOUND, value: "   " });
    assert.equal(out.details.support.status, "not_scored");
    assert.equal(out.details.support.reason, "empty_value");
    assert.match(out.details.support.meaning, NOT_SCORED);
    assert.equal(fake.calls.length, 0);
  } finally {
    r.dispose();
  }
});

test("AC2: the caller's own cancellation is handed on and reported as not scored", async () => {
  const fake = decider(() => new Promise<Response>(() => {}));
  const r = await rig({ decider: fake });
  try {
    const controller = new AbortController();
    const pending = r.tool.execute("a", { source: "w3", quote: FOUND, value: VALUE }, controller.signal);
    setTimeout(() => controller.abort(), 10);
    const out = await pending;
    assert.equal(out.details.support.status, "not_scored");
    assert.equal(out.details.support.reason, "aborted");
  } finally {
    r.dispose();
  }
});

test("AC2: a value is redacted before it is sent, as finish redacts a fact", async () => {
  const fake = decider(() => scoreResponse(0.9));
  const r = await rig({ decider: fake });
  try {
    const secret = "sk-abcdefghijklmnop1234";
    await r.tool.execute("a", { source: "w3", quote: FOUND, value: `the key is ${secret}` });
    assert.equal(fake.calls.length, 1);
    assert.ok(!fake.calls[0]!.raw.includes(secret));
    assert.equal(fake.calls[0]!.value, "the key is [REDACTED]");
  } finally {
    r.dispose();
  }
});

// --- AC3: words a reader can act on --------------------------------------------

test("AC3: every text the key can hold is plain words, and names nothing of the machinery behind it", () => {
  const reasons: SupportNotScoredReason[] = [
    "no_key",
    "bad_url",
    "empty_value",
    "empty_quote",
    "too_long",
    "over_cap",
    "out_of_time",
    "timeout",
    "unreachable",
    "http_error",
    "malformed",
    "aborted",
  ];
  const texts = new Set<string>();
  for (const reason of reasons) {
    const text = supportMeaning({ status: "not_scored", reason, detail: "5 bytes over the decider's input limit" });
    const found = NOT_SCORED.exec(text);
    assert.ok(found, `${reason}: ${text}`);
    assert.ok(found[1]!.includes(" "), `${reason} is explained in words, not by its code: ${text}`);
    assert.ok(!found[1]!.includes(reason) || !reason.includes("_"), `${reason} shows its code: ${text}`);
    assert.doesNotMatch(text, INSIDE_WORDS, reason);
    texts.add(text);
  }
  assert.equal(texts.size, reasons.length, "each reason has words of its own");
  // A reason this tool does not know still reads as not scored.
  assert.match(supportMeaning({ status: "not_scored", reason: "something_new" as SupportNotScoredReason }), NOT_SCORED);
  assert.equal(supportMeaning({ status: "scored", score: 1, at_or_above_cutoff: true }), AT_OR_ABOVE);
  assert.equal(supportMeaning({ status: "scored", score: 0, at_or_above_cutoff: false }), BELOW);
  for (const text of [AT_OR_ABOVE, BELOW]) assert.doesNotMatch(text, INSIDE_WORDS);
});

test("AC3: nothing the model is shown carries the detail note or names the machinery", async () => {
  const fake = decider(() => new Response("no", { status: 503 }));
  const r = await rig({ decider: fake });
  try {
    const out = await r.tool.execute("a", { source: "w3", quote: FOUND, value: VALUE });
    assert.doesNotMatch(out.content[0]!.text, INSIDE_WORDS);
    assert.ok(!("detail" in JSON.parse(out.content[0]!.text).support));
  } finally {
    r.dispose();
  }
});

test("AC3: the description and the schema tell the model the optional value exists, in plain words", async () => {
  const r = await rig();
  try {
    const schema = r.tool.parameters;
    assert.equal(schema.properties.value.type, "string");
    assert.match(schema.properties.value.description, /optional/i);
    assert.deepEqual([...schema.required].sort(), ["quote", "source"]);
    assert.match(r.tool.description, /value/);
    assert.match(r.tool.description, /support/);
    assert.match(r.tool.description, /not .*(true|correct)/i, "the description does not let the key read as truth");
    for (const text of [r.tool.description, schema.properties.value.description]) {
      assert.doesNotMatch(text, INSIDE_WORDS);
      assert.doesNotMatch(text, /accura|pass(ed|es|ing)? the score/i);
    }
  } finally {
    r.dispose();
  }
});

// --- AC4: one session cache, shared with finish --------------------------------

test("AC4: the same pair asked twice through the tool is one request", async () => {
  const fake = decider(() => scoreResponse(0.7));
  const r = await rig({ decider: fake });
  try {
    const first = await r.tool.execute("a", { source: "w3", quote: FOUND, value: VALUE });
    const second = await r.tool.execute("b", { source: "w3", quote: FOUND, value: VALUE });
    assert.deepEqual(second.details.support, first.details.support);
    assert.equal(fake.calls.length, 1);
    assert.equal(r.cache.size, 1);
  } finally {
    r.dispose();
  }
});

function installGlobalDecider(score: number): { calls: Array<{ value: string; quote: string }>; restore(): void } {
  const original = globalThis.fetch;
  const fake = decider(() => scoreResponse(score));
  globalThis.fetch = fake.fetch;
  return { calls: fake.calls, restore: () => (globalThis.fetch = original) };
}

const ON = { [SUPPORT_SCORE_ENV]: "on", ASSOCIATE_API_KEY: "test-key" };

test("AC4: a pair checked with check_quote and later handed back at finish costs one decider request in total", async () => {
  const global = installGlobalDecider(0.9);
  const s = await openSession(ON);
  try {
    assert.ok(READ_TEXT.includes(GOOD_FACT.quote));
    const out = (await s.pi.tool(CHECK_TOOL_NAME).execute("cq-1", {
      source: GOOD_FACT.source,
      quote: GOOD_FACT.quote,
      value: GOOD_FACT.value,
      purpose: "check the fact before handing it back",
    })) as any;
    assert.equal(out.details.verdict, "passed");
    assert.deepEqual(out.details.support, { status: "scored", score: 0.9, at_or_above_cutoff: true, meaning: AT_OR_ABOVE });
    assert.equal(global.calls.length, 1);

    await callFinish(s.pi, "fin-1", GOOD_PAYLOAD);
    assert.equal(global.calls.length, 1, "finish reused the answer check_quote was given");
    const check = JSON.parse(readFileSync(join(s.exportDir, CHECK_FILENAME), "utf8"));
    assert.deepEqual(check.facts[0].support, { status: "scored", score: 0.9, at_or_above_cutoff: true });
  } finally {
    global.restore();
    s.dispose();
  }
});

test("AC4: a pair with text the redaction filter rewrites is still one request across check_quote and finish", async () => {
  const global = installGlobalDecider(0.9);
  const s = await openSession(ON);
  try {
    const value = "ROLE_RESPONSIBILITIES, guarded by sk-abcdefghijklmnop1234";
    await s.pi.tool(CHECK_TOOL_NAME).execute("cq-1", { source: "w1", quote: GOOD_FACT.quote, value, purpose: "p" });
    assert.equal(global.calls.length, 1);
    await callFinish(s.pi, "fin-1", { ...GOOD_PAYLOAD, facts: [{ ...GOOD_FACT, value }] });
    assert.equal(global.calls.length, 1);
  } finally {
    global.restore();
    s.dispose();
  }
});

test("AC4: in a session with the score off, check_quote with a value asks nothing and adds no key", async () => {
  const global = installGlobalDecider(0.9);
  const s = await openSession({ ASSOCIATE_API_KEY: "test-key" });
  try {
    const out = (await s.pi.tool(CHECK_TOOL_NAME).execute("cq-1", {
      source: "w1",
      quote: GOOD_FACT.quote,
      value: GOOD_FACT.value,
      purpose: "p",
    })) as any;
    assert.equal(out.details.verdict, "passed");
    assert.ok(!("support" in out.details));
    assert.equal(global.calls.length, 0);
  } finally {
    global.restore();
    s.dispose();
  }
});
