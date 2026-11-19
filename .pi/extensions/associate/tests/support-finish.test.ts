/**
 * The support score at finish, stored beside the quote check (decider-score
 * plan task t3; spec c1, c2, h11, h19, c8, h17, c27, h22, c17).
 *
 * One group per acceptance criterion:
 *   1. after checkHandback, finish scores each fact that passed the quote
 *      check and writes the score or a not-scored mark per fact in check.json
 *      (`facts[i].support`), and a count in report.json (`support_scored`);
 *   2. accepted, the refusal list and the passed/refused/unchecked counts are
 *      byte-identical to the same hand-back with the score off — and with the
 *      score off nothing is sent and every export file is byte-identical to
 *      what the branch wrote before this task (fixtures/support-off-golden.json);
 *   3. the message_end rewrite keeps the scores from the saved object and sends
 *      nothing; a refused hand-back answered again with the same fact is one
 *      decider request;
 *   4. with the fake decider failing in each of the four ways (timeout,
 *      unreachable, HTTP error, malformed answer) finish still writes
 *      facts.json, check.json, report.json and answer.md;
 *   5. lib/facts.ts and lib/matcher.ts reach no module that performs a
 *      network call (the shared vectors are facts.test.ts / matcher.test.ts,
 *      left unchanged);
 *   6. no score refuses or retries a hand-back.
 *
 * The fake decider replaces `globalThis.fetch`, which index.ts looks up per
 * request exactly as the safety gate does; no live network call is made.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { libDir } from "../lib/paths.ts";
import { loadContract } from "../lib/contract.ts";
import { checkHandback } from "../lib/facts.ts";
import { compileGate } from "../lib/gate.ts";
import { compileRedaction } from "../lib/walk.ts";
import { SUPPORT_QUESTION_KEY, createSupportCache } from "../lib/support.ts";
import { SUPPORT_SCORE_ENV } from "../lib/supportswitch.ts";
import { CHECK_FILENAME, REPORT_FILENAME, scoreCheckedFacts, withSupport } from "../lib/handback.ts";
import {
  BAD_FACT,
  BAD_PAYLOAD,
  CONTRACT_DIR,
  EXPORT_FILES,
  FINAL_MESSAGE,
  GOOD_FACT,
  GOOD_PAYLOAD,
  READ_TEXT,
  SECOND_GOOD_FACT,
  callFinish,
  contractCopy,
  fireFinalMessage,
  openSession,
  scenario,
  snapshot,
} from "./support-scenario.ts";
import { SUPPORT_LEGEND } from "../lib/render.ts";

const GOLDEN = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "support-off-golden.json"), "utf8"))
  .steps as Record<string, Record<string, string | null>>;

const ON = { [SUPPORT_SCORE_ENV]: "on", ASSOCIATE_API_KEY: "test-key" };

// ------------------------------------------------------------ the fake decider

type Answer = (pair: { value: string; quote: string }) => Promise<Response> | Response;

interface FakeDecider {
  calls: Array<{ url: string; body: any; value: string; quote: string }>;
  restore(): void;
}

function scoreResponse(score: number): Response {
  return new Response(JSON.stringify({ model: "clef", answers: { [SUPPORT_QUESTION_KEY]: { type: "noul", noul: score } } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Read the value and quote back out of the two labelled state lines. */
function pairOf(state: string): { value: string; quote: string } {
  const line = (label: string) => {
    const found = state.split("\n").find((l) => l.startsWith(`${label}: `));
    return found ? (JSON.parse(found.slice(label.length + 2)) as string) : "";
  };
  return { value: line("value"), quote: line("quote") };
}

function installDecider(answer: Answer = () => scoreResponse(0.9)): FakeDecider {
  const original = globalThis.fetch;
  const calls: FakeDecider["calls"] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "null"));
    const pair = pairOf(String(body?.state ?? ""));
    calls.push({ url: String(url), body, ...pair });
    return answer(pair);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** check.json without any `support` field, report.json without `support_scored`. */
function withoutScore(name: string, text: string | null): unknown {
  if (text === null) return null;
  if (name === "check.json") {
    const check = JSON.parse(text);
    check.facts = check.facts.map(({ support: _s, ...rest }: Record<string, unknown>) => rest);
    return check;
  }
  if (name === "report.json") {
    const { support_scored: _n, ...rest } = JSON.parse(text);
    return rest;
  }
  return text;
}

// --- AC1: the score per fact and the count -------------------------------------

test("AC1: each fact that passed the quote check gets a support field in check.json; a refused fact gets none", async () => {
  const decider = installDecider((pair) => scoreResponse(pair.value === GOOD_FACT.value ? 0.9 : 0.2));
  const s = await openSession(ON);
  try {
    await callFinish(s.pi, "fin-1", BAD_PAYLOAD);
    const check = readJson(join(s.exportDir, CHECK_FILENAME));
    const byId = Object.fromEntries(check.facts.map((f: any) => [f.id, f]));
    assert.equal(byId.f1.verdict, "passed");
    assert.deepEqual(byId.f1.support, { status: "scored", score: 0.9, at_or_above_cutoff: true });
    assert.equal(byId.f3.verdict, "passed");
    assert.deepEqual(byId.f3.support, { status: "scored", score: 0.2, at_or_above_cutoff: false });
    assert.equal(byId.f2.verdict, "refused");
    assert.ok(!("support" in byId.f2), "a fact the quote check refused is not scored and carries no field");

    const report = readJson(join(s.exportDir, REPORT_FILENAME));
    assert.equal(report.support_scored, 2);
    const schema = readJson(join(CONTRACT_DIR, "schemas", "report.schema.json"));
    for (const key of Object.keys(report)) assert.ok(key in schema.properties, `report has a key the schema forbids: ${key}`);
    // The quote-check counts are untouched by the score.
    assert.equal(report.facts.passed, 2);
    assert.equal(report.facts.refused, 1);

    // Only the passed facts were sent: their value and quote, never the refused one.
    assert.deepEqual(
      decider.calls.map((c) => [c.value, c.quote]),
      [
        [GOOD_FACT.value, GOOD_FACT.quote],
        [SECOND_GOOD_FACT.value, SECOND_GOOD_FACT.quote],
      ],
    );
    assert.ok(decider.calls.every((c) => c.url.endsWith("/systemone")), decider.calls.map((c) => c.url).join(", "));
    assert.ok(!decider.calls.some((c) => c.value === BAD_FACT.value));
  } finally {
    decider.restore();
    s.dispose();
  }
});

test("AC1: a fact with no score carries a not-scored mark with its reason, and is not counted", async () => {
  const decider = installDecider((pair) =>
    pair.value === GOOD_FACT.value ? scoreResponse(0.7) : new Response("not json", { status: 200 }),
  );
  const s = await openSession(ON);
  try {
    await callFinish(s.pi, "fin-1", BAD_PAYLOAD);
    const check = readJson(join(s.exportDir, CHECK_FILENAME));
    const f3 = check.facts.find((f: any) => f.id === "f3");
    assert.equal(f3.support.status, "not_scored");
    assert.equal(f3.support.reason, "malformed");
    assert.equal(readJson(join(s.exportDir, REPORT_FILENAME)).support_scored, 1);
  } finally {
    decider.restore();
    s.dispose();
  }
});

test("AC1: the score follows accuracy.json's per-model switch when no per-run value is set", async () => {
  const contract = contractCopy((a) => {
    a.support_score.enabled.worker = true;
  });
  const decider = installDecider();
  const s = await openSession({ ASSOCIATE_CONTRACT_DIR: contract.dir, ASSOCIATE_API_KEY: "test-key" });
  try {
    await callFinish(s.pi, "fin-1", GOOD_PAYLOAD);
    assert.equal(decider.calls.length, 1);
    assert.equal(readJson(join(s.exportDir, REPORT_FILENAME)).support_scored, 1);
  } finally {
    decider.restore();
    s.dispose();
    contract.dispose();
  }
});

test("AC1: scoreCheckedFacts returns one result per checked fact, undefined for every fact that did not pass", async () => {
  const contract = loadContract({});
  const decider = installDecider();
  try {
    const payload = { facts: [GOOD_FACT, BAD_FACT, SECOND_GOOD_FACT] };
    const check = checkHandback(
      {
        payload,
        entries: [{ id: "w1", tool: "read", saved_result: "results/w1.txt" } as never],
        results: { w1: READ_TEXT },
        prior_runs: {},
        children: [],
      },
      contract.accuracy,
    );
    assert.deepEqual(check.facts.map((f) => f.verdict), ["passed", "refused", "passed"]);
    const support = await scoreCheckedFacts(check, payload, {
      settings: { ...contract.accuracy.support_score!, enabled: {} } as never,
      config: compileGate(contract),
      env: { ASSOCIATE_API_KEY: "k" },
      redaction: compileRedaction(contract.policy),
      fetch: globalThis.fetch,
      cache: createSupportCache(),
    });
    assert.equal(support.length, 3);
    assert.equal(support[0]?.status, "scored");
    assert.equal(support[1], undefined);
    assert.equal(support[2]?.status, "scored");
    const facts = withSupport(check.facts, support);
    assert.ok("support" in facts[0] && !("support" in facts[1]));
    // withSupport with no scores hands back the very same list.
    assert.equal(withSupport(check.facts, undefined), check.facts);
  } finally {
    decider.restore();
  }
});

/** The quote-found legend line; the support legend follows it, and each shown fact line ends with the quote-found marker. */
const QUOTE_LEGEND = 'A fact marked "quote found" means its quote is in the saved result it cites; it does not mean the value is true.';
const QUOTE_FOUND_END = "; quote found in the saved result)";

/**
 * The switch-off answer.md with the support legend and a mark on every shown
 * fact: the exact text expected with the score on. `mark` is one mark for
 * every fact, or one per shown fact in order.
 */
function withSupportText(answer: string, mark: string | readonly string[]): string {
  let shown = 0;
  const next = () => (typeof mark === "string" ? mark : mark[shown++]);
  return answer
    .split("\n")
    .flatMap((line) => {
      if (line === QUOTE_LEGEND) return [line, "", SUPPORT_LEGEND];
      if (line.startsWith("- f") && line.endsWith(QUOTE_FOUND_END)) return [`${line.slice(0, -1)}; ${next()})`];
      return [line];
    })
    .join("\n");
}

/** answer.md with the support legend and every fact's support marker taken out again. */
function withoutSupportText(answer: string): string {
  return answer
    .replace(`\n\n${SUPPORT_LEGEND}`, "")
    .replace(/^(- f\d+: .*; quote found in the saved result); [^;()]*\)$/gm, "$1)");
}

// --- AC2: the score changes nothing the check decides ---------------------------

test("AC2: with the switch off nothing is sent and every export file is byte-identical to the pre-score writer", async () => {
  for (const env of [{}, { ASSOCIATE_API_KEY: "test-key" }, { ASSOCIATE_API_KEY: "test-key", [SUPPORT_SCORE_ENV]: "off" }]) {
    const decider = installDecider();
    try {
      const steps = await scenario(env);
      assert.equal(decider.calls.length, 0, `nothing is sent with the score off (${JSON.stringify(env)})`);
      assert.deepEqual(Object.keys(steps), Object.keys(GOLDEN));
      for (const [step, files] of Object.entries(steps)) {
        for (const name of EXPORT_FILES) {
          assert.equal(files[name], GOLDEN[step][name], `${step}/${name} differs from the pre-score writer (${JSON.stringify(env)})`);
        }
        assert.doesNotMatch(String(files["check.json"]), /"support"/);
        assert.doesNotMatch(String(files["report.json"]), /support_scored/);
      }
    } finally {
      decider.restore();
    }
  }
});

for (const [label, score] of [
  ["low", 0],
  ["high", 1],
] as const) {
  test(`AC2/AC6: with every score ${label}, accepted, the refusals and the counts match the switch-off hand-back byte for byte`, async () => {
    const decider = installDecider(() => scoreResponse(score));
    try {
      const steps = await scenario(ON);
      assert.ok(decider.calls.length > 0, "the score was asked");
      for (const [step, files] of Object.entries(steps)) {
        const golden = GOLDEN[step];
        // facts.json is not touched by the score at all; answer.md gains the
        // support text (plan task t5) and is otherwise byte-identical.
        assert.equal(files["facts.json"], golden["facts.json"], `${step}/facts.json`);
        if (golden["answer.md"] === null) {
          assert.equal(files["answer.md"], null, `${step}/answer.md`);
        } else {
          const mark = `${score === 1 ? "quote supports the value" : "quote may not support the value"}, support ${score.toFixed(2)}`;
          assert.equal(files["answer.md"], withSupportText(golden["answer.md"], mark), `${step}/answer.md`);
          assert.equal(withoutSupportText(files["answer.md"]!), golden["answer.md"], `${step}/answer.md without the support text`);
        }
        const check = JSON.parse(files["check.json"]!);
        const off = JSON.parse(golden["check.json"]!);
        assert.equal(JSON.stringify(check.accepted), JSON.stringify(off.accepted), `${step}: accepted`);
        assert.equal(check.outcome, off.outcome, `${step}: outcome`);
        assert.equal(JSON.stringify(check.refusals), JSON.stringify(off.refusals), `${step}: refusals`);
        assert.equal(JSON.stringify(check.would_refuse), JSON.stringify(off.would_refuse), `${step}: would_refuse`);
        const report = JSON.parse(files["report.json"]!);
        const offReport = JSON.parse(golden["report.json"]!);
        assert.equal(JSON.stringify(report.facts), JSON.stringify(offReport.facts), `${step}: fact counts`);
        assert.equal(JSON.stringify(report.by_source_kind), JSON.stringify(offReport.by_source_kind), `${step}: counts by kind`);
        // Everything but the score fields is byte-identical.
        for (const name of ["check.json", "report.json"]) {
          assert.equal(
            JSON.stringify(withoutScore(name, files[name])),
            JSON.stringify(withoutScore(name, golden[name])),
            `${step}/${name} without the score fields`,
          );
        }
        assert.equal(typeof report.support_scored, "number", `${step}: the count is written`);
      }
    } finally {
      decider.restore();
    }
  });
}

// --- AC3: the rewrite and the retry round reuse the scores ----------------------

test("AC3: the message_end rewrite keeps the scores from the saved object and sends no new request", async () => {
  const decider = installDecider();
  const s = await openSession(ON);
  try {
    await callFinish(s.pi, "fin-1", BAD_PAYLOAD);
    const sent = decider.calls.length;
    assert.equal(sent, 2);
    const before = readJson(join(s.exportDir, CHECK_FILENAME));
    await fireFinalMessage(s.pi, FINAL_MESSAGE);
    assert.equal(decider.calls.length, sent, "the rewrite sends nothing");
    const after = readJson(join(s.exportDir, CHECK_FILENAME));
    assert.equal(after.unchecked_text.final_message, "unchecked", "the rewrite ran");
    assert.deepEqual(after.facts, before.facts, "the scores are kept");
    assert.equal(readJson(join(s.exportDir, REPORT_FILENAME)).support_scored, 2);
  } finally {
    decider.restore();
    s.dispose();
  }
});

test("AC3: a hand-back refused and answered again with the same fact produces one decider request", async () => {
  const decider = installDecider();
  const s = await openSession({ ...ON, ASSOCIATE_CHECK_MODE: "enforce" });
  try {
    const refused = await callFinish(s.pi, "fin-1", { ...GOOD_PAYLOAD, facts: [GOOD_FACT, BAD_FACT] });
    assert.equal(refused.details.outcome, "refused");
    const first = readJson(join(s.exportDir, CHECK_FILENAME));
    assert.equal(first.facts.find((f: any) => f.id === "f1").support.status, "scored", "the refused round is scored too");
    await callFinish(s.pi, "fin-2", GOOD_PAYLOAD);
    assert.equal(readJson(join(s.exportDir, CHECK_FILENAME)).outcome, "accepted");
    await fireFinalMessage(s.pi, FINAL_MESSAGE);
    assert.equal(decider.calls.length, 1, "one request for the one fact, across both rounds and the rewrite");
    assert.equal(readJson(join(s.exportDir, CHECK_FILENAME)).facts[0].support.status, "scored");
  } finally {
    decider.restore();
    s.dispose();
  }
});

// --- review finding 1: the quote-check files come before the score -----------

/** A decider whose answers wait until `release` is called; `asked` resolves on the first request. */
function heldDecider(score = 0.9) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let asked!: () => void;
  const firstAsk = new Promise<void>((resolve) => (asked = resolve));
  const decider = installDecider(async () => {
    asked();
    await gate;
    return scoreResponse(score);
  });
  return { decider, release, firstAsk };
}

test("finding 1: while the decider has not answered, the export already holds a complete, valid, score-less hand-back", async () => {
  const held = heldDecider();
  const s = await openSession(ON);
  let running: Promise<any> | undefined;
  try {
    const params = BAD_PAYLOAD;
    const decision = (await s.pi.fireToolCall({ type: "tool_call", toolName: "finish", toolCallId: "fin-1", input: params })) as any;
    assert.notEqual(decision?.block, true);
    running = s.pi.tool("finish").execute("fin-1", params) as Promise<any>;
    await held.firstAsk;
    // A kill here (run timeout, a child's budget) must leave a whole export.
    const files = snapshot(s.exportDir);
    for (const name of EXPORT_FILES) assert.notEqual(files[name], null, `${name} is on disk before the score is asked`);
    const check = JSON.parse(files["check.json"]!);
    assert.equal(check.outcome, "accepted");
    assert.doesNotMatch(files["check.json"]!, /"support"/);
    assert.doesNotMatch(files["report.json"]!, /support_scored/);
    // Byte-identical to the switch-off hand-back at this point.
    for (const name of EXPORT_FILES) assert.equal(files[name], GOLDEN.report_finish[name], `${name} while the score is pending`);
    // The session is finished already: any further tool call is refused.
    const blocked = (await s.pi.fireToolCall({
      type: "tool_call",
      toolName: "read",
      toolCallId: "tc-after",
      input: { path: "roles.py", purpose: "after the hand-back" },
    })) as any;
    assert.equal(blocked?.block, true, "the hand-back is recorded before the score is asked");

    held.release();
    const result = await running;
    assert.equal(result.details.outcome, "accepted");
    const after = readJson(join(s.exportDir, CHECK_FILENAME));
    assert.equal(after.facts.find((f: any) => f.id === "f1").support.status, "scored", "the score is written once it comes");
    assert.equal(readJson(join(s.exportDir, REPORT_FILENAME)).support_scored, 2);
    assert.match(readFileSync(join(s.exportDir, "answer.md"), "utf8"), new RegExp(SUPPORT_LEGEND.slice(0, 20)));
    assert.equal(held.decider.calls.length, 2);
  } finally {
    held.release();
    // The finish call ends before the next test installs its own decider.
    await running?.catch(() => undefined);
    held.decider.restore();
    s.dispose();
  }
});

test("finding 1: in enforce mode a refused round is on disk as refused before the score is asked", async () => {
  const held = heldDecider();
  const s = await openSession({ ...ON, ASSOCIATE_CHECK_MODE: "enforce" });
  let running: Promise<any> | undefined;
  try {
    running = s.pi.tool("finish").execute("fin-1", BAD_PAYLOAD) as Promise<any>;
    await held.firstAsk;
    const files = snapshot(s.exportDir);
    for (const name of ["facts.json", "check.json", "report.json"] as const) {
      assert.equal(files[name], GOLDEN.enforce_refused[name], `${name} while the score is pending`);
    }
    assert.equal(files["answer.md"], null);
    held.release();
    const result = await running;
    assert.equal(result.details.outcome, "refused");
    const after = readJson(join(s.exportDir, CHECK_FILENAME));
    assert.equal(after.outcome, "refused");
    assert.equal(after.facts.find((f: any) => f.id === "f1").support.status, "scored");
    assert.ok(!existsSync(join(s.exportDir, "answer.md")));
  } finally {
    held.release();
    // The finish call ends before the next test installs its own decider.
    await running?.catch(() => undefined);
    held.decider.restore();
    s.dispose();
  }
});

// --- AC4: a failing decider never stops the hand-back ---------------------------

const FAILURES: Array<[string, string, Answer]> = [
  ["timeout", "timeout", () => new Promise<Response>(() => {})],
  [
    "unreachable",
    "unreachable",
    () => {
      throw new TypeError("fetch failed: connect ECONNREFUSED");
    },
  ],
  ["HTTP error", "http_error", () => new Response("overloaded", { status: 503 })],
  ["malformed answer", "malformed", () => new Response(JSON.stringify({ answers: { other: 1 } }), { status: 200 })],
];

for (const [label, reason, answer] of FAILURES) {
  test(`AC4: with the decider failing (${label}) finish still writes facts.json, check.json, report.json and answer.md`, async () => {
    const contract = contractCopy((a) => {
      a.support_score.timeout_ms = 40;
    });
    const phrase = reason === "timeout" ? "the check timed out" : "the check was unavailable";
    const decider = installDecider(answer);
    const s = await openSession({ ...ON, ASSOCIATE_CONTRACT_DIR: contract.dir });
    try {
      const result = await callFinish(s.pi, "fin-1", BAD_PAYLOAD);
      assert.equal(result.details.outcome, "accepted");
      for (const name of EXPORT_FILES) assert.ok(existsSync(join(s.exportDir, name)), `${name} is written`);
      const check = readJson(join(s.exportDir, CHECK_FILENAME));
      // After an unreachable, timeout or HTTP error the batch sends nothing
      // more (review finding 2): f3 is skipped; a malformed answer does not stop it.
      const stops = reason !== "malformed";
      const expected: Record<string, string> = { f1: reason, f3: stops ? "skipped_after_failure" : reason };
      for (const id of ["f1", "f3"]) {
        const support = check.facts.find((f: any) => f.id === id).support;
        assert.equal(support.status, "not_scored", `${id}: ${JSON.stringify(support)}`);
        assert.equal(support.reason, expected[id]);
      }
      assert.equal(decider.calls.length, stops ? 1 : 2);
      assert.equal(readJson(join(s.exportDir, REPORT_FILENAME)).support_scored, 0);
      const files = snapshot(s.exportDir);
      // Each shown fact says it was not scored; nothing else in answer.md moves.
      const marks = [`support not scored: ${phrase}`, `support not scored: ${stops ? "the check was unavailable" : phrase}`];
      assert.equal(files["answer.md"], withSupportText(GOLDEN.report_finish["answer.md"]!, marks));
      assert.equal(withoutSupportText(files["answer.md"]!), GOLDEN.report_finish["answer.md"]);
    } finally {
      decider.restore();
      s.dispose();
      contract.dispose();
    }
  });
}

test("AC4: with no key set every passed fact is marked not scored and nothing is sent", async () => {
  const decider = installDecider();
  const s = await openSession({ [SUPPORT_SCORE_ENV]: "on" });
  try {
    await callFinish(s.pi, "fin-1", BAD_PAYLOAD);
    assert.equal(decider.calls.length, 0);
    const check = readJson(join(s.exportDir, CHECK_FILENAME));
    assert.equal(check.facts.find((f: any) => f.id === "f1").support.reason, "no_key");
    for (const name of EXPORT_FILES) assert.ok(existsSync(join(s.exportDir, name)), `${name} is written`);
  } finally {
    decider.restore();
    s.dispose();
  }
});

test("AC4: with the gate contract failing to compile every passed fact is marked contract_invalid, not bad_url (review finding 3)", async () => {
  const contract = contractCopy(() => {});
  const gatePath = join(contract.dir, "gate.json");
  const gate = readJson(gatePath);
  gate.decider.path = "no-leading-slash";
  writeFileSync(gatePath, JSON.stringify(gate, null, 2));
  const decider = installDecider();
  const s = await openSession({ ...ON, ASSOCIATE_CONTRACT_DIR: contract.dir });
  try {
    await callFinish(s.pi, "fin-1", BAD_PAYLOAD);
    assert.equal(decider.calls.length, 0);
    const check = readJson(join(s.exportDir, CHECK_FILENAME));
    for (const id of ["f1", "f3"]) assert.equal(check.facts.find((f: any) => f.id === id).support.reason, "contract_invalid");
    for (const name of EXPORT_FILES) assert.ok(existsSync(join(s.exportDir, name)), `${name} is written`);
  } finally {
    decider.restore();
    s.dispose();
    contract.dispose();
  }
});

// --- AC5: the checker and the matcher stay offline ------------------------------

/** Every module `entry` reaches through relative imports (type-only ones included), itself first. */
function importClosure(entry: string): string[] {
  const seen: string[] = [];
  const visit = (path: string) => {
    if (seen.includes(path)) return;
    seen.push(path);
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/gms)) {
      const spec = match[1];
      if (spec.startsWith(".")) visit(resolve(dirname(path), spec));
    }
    for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) {
      if (match[1].startsWith(".")) visit(resolve(dirname(path), match[1]));
    }
  };
  visit(entry);
  return seen;
}

/** What marks a module as one that performs (or can perform) a network call. */
const NETWORK = [
  /\bfetch\s*\(/,
  /["']node:(?:http|https|http2|net|tls|dgram|dns)["']/,
  /["'](?:http|https|http2|net|tls|dgram|dns|undici)["']/,
  /\bWebSocket\b/,
  /\bXMLHttpRequest\b/,
];

test("AC5: lib/facts.ts and lib/matcher.ts import no module that performs a network call", () => {
  for (const name of ["facts.ts", "matcher.ts"]) {
    const closure = importClosure(join(libDir, name));
    assert.ok(closure.length >= 1);
    for (const path of closure) {
      const base = path.slice(libDir.length + 1);
      assert.ok(!["support.ts", "gate.ts", "supportswitch.ts"].includes(base), `${name} reaches ${base}`);
      const source = readFileSync(path, "utf8");
      for (const pattern of NETWORK) {
        assert.doesNotMatch(source, pattern, `${name} reaches ${base}, which matches ${pattern}`);
      }
    }
  }
});

test("AC5: the import scan catches a module that performs a network call", () => {
  // The scan's own check: support.ts calls fetch through gate.ts's address.
  const closure = importClosure(join(libDir, "support.ts"));
  assert.ok(closure.some((p) => p.endsWith("/gate.ts")), closure.join(", "));
  const hits = closure.filter((p) => NETWORK.some((pattern) => pattern.test(readFileSync(p, "utf8"))));
  assert.ok(hits.length > 0, "support.ts's closure is flagged");
});

// --- AC6: no refusal or retry from a score ---------------------------------------

test("AC6: in enforce mode a passing hand-back whose every score is 0 is accepted and finishes", async () => {
  const decider = installDecider(() => scoreResponse(0));
  const s = await openSession({ ...ON, ASSOCIATE_CHECK_MODE: "enforce" });
  try {
    const result = await callFinish(s.pi, "fin-1", GOOD_PAYLOAD);
    assert.equal(result.details.outcome, "accepted");
    assert.notEqual(result.terminate, true);
    const check = readJson(join(s.exportDir, CHECK_FILENAME));
    assert.equal(check.accepted, true);
    assert.deepEqual(check.would_refuse, []);
    assert.equal(check.facts[0].support.at_or_above_cutoff, false);
    assert.ok(!existsSync(join(s.exportDir, "rejected_handback.json")), "nothing was rejected");
  } finally {
    decider.restore();
    s.dispose();
  }
});
