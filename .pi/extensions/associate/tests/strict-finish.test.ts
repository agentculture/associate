/**
 * The strict hand-back flow through `finish` (strict-facts plan t5; spec c7,
 * c10, c25, c28, c31, c35, c36).
 *
 * The extension is loaded against a fake pi (tests/support-scenario.ts) with
 * one recorded read (w1). The decider is a fake `globalThis.fetch`, which
 * index.ts looks up per request; no live network call is made.
 *
 * Acceptance criteria covered here:
 *   - drop on none; return-then-keep on part; the cascade message; rounds
 *     exhausted (the hand-back is accepted without the dropped items, never
 *     refused);
 *   - ASSOCIATE_STRICT on|off overrides the contract; another value is ignored
 *     with one stderr line; with strict off the report/enforce flow runs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SUPPORT_QUESTION_KEY } from "../lib/support.ts";
import { CHECK_FILENAME, REPORT_FILENAME } from "../lib/handback.ts";
import { loadContract } from "../lib/contract.ts";
import { STRICT_ENV } from "../lib/strict.ts";
import { callFinish, contractCopy, fireFinalMessage, openSession, type Session } from "./support-scenario.ts";

const MARK = loadContract({}).accuracy.strict!.mark_text;

// ------------------------------------------------------------ the fake decider

function choice(option: string): Response {
  const answer = { type: "choice", choice: option, confidence: 0.9, probabilities: { [option]: 0.9 } };
  return new Response(JSON.stringify({ model: "clef", answers: { [SUPPORT_QUESTION_KEY]: answer } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A decider answering every question with `answer()`; `calls` counts requests. */
function installDecider(answer: () => Response | Promise<Response>) {
  const original = globalThis.fetch;
  const calls: unknown[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body ?? "null")));
    return answer();
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

/** Strict as the contract sets it for worker (the default model), with a key for the decider. */
const STRICT_DEFAULT = { [STRICT_ENV]: undefined, ASSOCIATE_API_KEY: "test-key" };

const readJson = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const textOf = (result: any): string => result.content.map((c: any) => c.text).join("\n");

// The read w1 (support-scenario READ_TEXT) shows these lines:
//   1  ROLE_RESPONSIBILITIES = {
//   2      "worker": ["execution", "tool_use", "repo_inspection"],
//   3      "senses": ["intake", "normalize_input"],
const DIRECT = { id: "f1", kind: "direct", source: "w1", at: { lines: [1, 1] }, value: "ROLE_RESPONSIBILITIES" };
// An llm fact whose literal is not in the line it points at: the decider judges it.
const LLM = { id: "f2", kind: "llm", source: "w1", at: { lines: [2, 2] }, value: "senses" };
const BAD = { id: "f3", value: "pyproject.toml", source: "w1", quote: "a content-identical copy sits in pyproject.toml" };

const payload = (...facts: unknown[]) => ({ summary: "The role table.", facts });

async function withStrict(env: Record<string, string | undefined>, body: (s: Session) => Promise<void>) {
  const s = await openSession(env);
  try {
    await body(s);
  } finally {
    s.dispose();
  }
}

/** The finish entries of the walk, with their saved result text. */
function finishEntries(exportDir: string): Array<{ id: string; saved: string }> {
  return readFileSync(join(exportDir, "walk.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((e) => e.tool === "finish" && typeof e.saved_result === "string")
    .map((e) => ({ id: e.id, saved: readFileSync(join(exportDir, e.saved_result), "utf8") }));
}

// ------------------------------------------------------------------ drop on none

test("drop on none: an llm fact the decider answers none is dropped, the model told why, and the round sent back", async () => {
  const decider = installDecider(() => choice("none"));
  try {
    await withStrict(STRICT_DEFAULT, async (s) => {
      const first = await callFinish(s.pi, "fin-1", payload(DIRECT, LLM));
      assert.equal(first.details.outcome, "returned");
      assert.notEqual(first.terminate, true);
      const message = textOf(first);
      assert.match(message, /round 1 of 2: 1 dropped, 0 returned/);
      assert.match(message, /- f2 \(cites w1\): decider_drop\. Fix: the decider answered 'none'/);
      assert.match(message, /2 finish calls left/);
      assert.equal(decider.calls.length, 1, "only the llm fact is sent; the direct fact passed by its pointer");

      const check = readJson(join(s.exportDir, CHECK_FILENAME));
      assert.equal(check.mode, "strict");
      assert.equal(check.outcome, "accepted", "the answer as it stands is recorded at once");
      assert.equal(check.strict.round_open, true);
      assert.deepEqual(check.strict.counts, { pass: 1, keep_marked: 0, returned: 0, dropped: 1, not_judged: 0 });
      assert.deepEqual(check.strict.dropped.map((d: any) => [d.id, d.value, d.reason]), [["f2", "senses", "decider_drop"]]);
      assert.equal(check.facts[1].judge.option, "none");
      assert.equal(check.facts[1].strict_outcome, "dropped");
      const report = readJson(join(s.exportDir, REPORT_FILENAME));
      assert.ok(report.flags.some((f: any) => f.check === "decider_answered_none" && f.detail === "f2: decider_drop"));
      const answer = readFileSync(join(s.exportDir, "answer.md"), "utf8");
      assert.match(answer, /\*\*f1:\*\* ROLE_RESPONSIBILITIES/);
      assert.doesNotMatch(answer, /\*\*f2:\*\*/);

      // Tools stay callable while the round is open.
      const read = (await s.pi.fireToolCall({
        type: "tool_call",
        toolName: "read",
        toolCallId: "tc-r",
        input: { path: "roles.py", purpose: "look again" },
      })) as any;
      assert.notEqual(read?.block, true);

      const second = await callFinish(s.pi, "fin-2", payload(DIRECT));
      assert.equal(second.details.outcome, "accepted");
      assert.ok(second.details.handback, "the accepted hand-back reaches the statements recorder");
      assert.equal(readJson(join(s.exportDir, CHECK_FILENAME)).strict.round_open, false);
    });
  } finally {
    decider.restore();
  }
});

// ------------------------------------------------------------- return, then keep

test("return then keep on part: returned once with the answer and the fix, then kept with the mark; the walk shows both", async () => {
  const decider = installDecider(() => choice("part"));
  try {
    await withStrict(STRICT_DEFAULT, async (s) => {
      const first = await callFinish(s.pi, "fin-1", payload(DIRECT, LLM));
      assert.equal(first.details.outcome, "returned");
      const message = textOf(first);
      assert.match(message, /- f2: the decider answered 'part'/);
      assert.match(message, /Fix: narrow the value to what the evidence shows, or point at a source that shows the rest/);
      const firstCheck = readJson(join(s.exportDir, CHECK_FILENAME));
      assert.equal(firstCheck.facts[1].strict_outcome, "returned");
      assert.equal(firstCheck.facts[1].round, 1);
      assert.deepEqual(firstCheck.strict.returned_before, [], "nothing was returned before the first round");
      assert.doesNotMatch(readFileSync(join(s.exportDir, "answer.md"), "utf8"), /\*\*f2:\*\*/, "a returned fact is not in the answer");

      // Unchanged and still answered part: kept with the mark, accepted.
      const second = await callFinish(s.pi, "fin-2", payload(DIRECT, LLM));
      assert.equal(second.details.outcome, "accepted");
      const check = readJson(join(s.exportDir, CHECK_FILENAME));
      assert.equal(check.facts[1].strict_outcome, "keep_marked");
      assert.equal(check.facts[1].mark, MARK);
      assert.equal(check.facts[1].judge.option, "part");
      assert.deepEqual(check.strict.returned, []);
      // The record says why f2 is kept with the mark: it was returned in an earlier round of this prompt.
      assert.deepEqual(check.strict.returned_before, ["f2"]);
      const answer = readFileSync(join(s.exportDir, "answer.md"), "utf8");
      assert.match(answer, new RegExp(`\\*\\*f2:\\*\\* senses\n[^]*- marked: ${MARK} \\(the decider answered part\\)`));

      const walk = finishEntries(s.exportDir);
      assert.equal(walk.length, 2);
      assert.match(walk[0].saved, /"outcome":"returned"/);
      assert.match(walk[0].saved, /"returned":1/);
      assert.match(walk[1].saved, /"outcome":"accepted"/);
      assert.match(walk[1].saved, /"keep_marked":1/);
    });
  } finally {
    decider.restore();
  }
});

// ------------------------------------------------------------------- cascade

test("cascade message: facts based on a failed fact are dropped, the message naming the failed fact as the reason", async () => {
  const decider = installDecider(() => choice("all"));
  try {
    await withStrict(STRICT_DEFAULT, async (s) => {
      const f4 = { id: "f4", kind: "derived", source: "w1", at: { lines: [1, 1] }, value: "ROLE_RESPONSIBILITIES", based_on: ["f3"] };
      const f5 = { id: "f5", kind: "derived", source: "w1", at: { lines: [1, 1] }, value: "ROLE_RESPONSIBILITIES", based_on: ["f4"] };
      const result = await callFinish(s.pi, "fin-1", payload(DIRECT, BAD, f4, f5));
      const message = textOf(result);
      assert.match(message, /- f3 \(cites w1\): quote_absent\./);
      assert.match(message, /- f4: based_on_failed \(root: f3\)\. f4 is dropped because it is based on f3, which failed \(quote_absent\)/);
      assert.match(message, /- f5: based_on_failed \(root: f3\)\. f5 is dropped because it is based on f3/);
      const check = readJson(join(s.exportDir, CHECK_FILENAME));
      assert.deepEqual(check.strict.drop_reasons, { quote_absent: 1, based_on_failed: 2 });
      assert.deepEqual(
        check.strict.dropped.map((d: any) => [d.id, d.dropped_by ?? null]),
        [
          ["f3", null],
          ["f4", "f3"],
          ["f5", "f3"],
        ],
      );
      const report = readJson(join(s.exportDir, REPORT_FILENAME));
      assert.ok(report.flags.some((f: any) => f.check === "based_on_unsound" && f.detail === "f4: based_on_failed"));
    });
  } finally {
    decider.restore();
  }
});

// ----------------------------------------------------------- rounds exhausted

test("rounds exhausted: after retry_rounds the hand-back is accepted without the dropped items and is not refused", async () => {
  const decider = installDecider(() => choice("none"));
  try {
    await withStrict(STRICT_DEFAULT, async (s) => {
      const r1 = await callFinish(s.pi, "fin-1", payload(DIRECT, BAD));
      assert.equal(r1.details.outcome, "returned");
      assert.match(textOf(r1), /2 finish calls left/);
      const r2 = await callFinish(s.pi, "fin-2", payload(DIRECT, BAD));
      assert.equal(r2.details.outcome, "returned");
      assert.match(textOf(r2), /round 2 of 2/);
      assert.match(textOf(r2), /1 finish call left, and the last one is accepted as it stands/);
      const r3 = await callFinish(s.pi, "fin-3", payload(DIRECT, BAD));
      assert.equal(r3.details.outcome, "accepted");
      assert.notEqual(r3.terminate, true);
      assert.match(textOf(r3), /The answer goes out without the dropped items; the hand-back is not refused/);
      assert.match(textOf(r3), /- f3 \(cites w1\): quote_absent/, "the last round still tells the model what was dropped");

      const check = readJson(join(s.exportDir, CHECK_FILENAME));
      assert.equal(check.outcome, "accepted");
      assert.equal(check.strict.rounds_used, 2);
      assert.equal(check.strict.round_open, false);
      assert.deepEqual(check.strict.dropped.map((d: any) => d.id), ["f3"]);
      const answer = readFileSync(join(s.exportDir, "answer.md"), "utf8");
      assert.match(answer, /\*\*f1:\*\* ROLE_RESPONSIBILITIES/);
      assert.doesNotMatch(answer, /pyproject/);
      assert.ok(!existsSync(join(s.exportDir, "rejected_handback.json")), "nothing was rejected");

      // The hand-back is final: a further tool call is refused, and the final message is recorded.
      const after = (await s.pi.fireToolCall({
        type: "tool_call",
        toolName: "read",
        toolCallId: "tc-after",
        input: { path: "roles.py", purpose: "after" },
      })) as any;
      assert.equal(after?.block, true);
      await fireFinalMessage(s.pi, "The role table is a dict.");
      assert.equal(readJson(join(s.exportDir, CHECK_FILENAME)).unchecked_text.final_message, "unchecked");
    });
  } finally {
    decider.restore();
  }
});

test("a part answer first seen in the last round is kept with the mark, not returned", async () => {
  const contract = contractCopy((a) => {
    a.retry_rounds = 0;
  });
  const decider = installDecider(() => choice("little"));
  try {
    await withStrict({ ...STRICT_DEFAULT, ASSOCIATE_CONTRACT_DIR: contract.dir }, async (s) => {
      const result = await callFinish(s.pi, "fin-1", payload(DIRECT, LLM, BAD));
      assert.equal(result.details.outcome, "accepted");
      const check = readJson(join(s.exportDir, CHECK_FILENAME));
      assert.deepEqual(
        check.facts.map((f: any) => f.strict_outcome),
        ["pass", "keep_marked", "dropped"],
      );
      // Kept with the mark because no round was left, not because it was returned before: the record tells them apart.
      assert.deepEqual(check.strict.returned_before, []);
      assert.equal(check.strict.retry_rounds, 0);
    });
  } finally {
    decider.restore();
    contract.dispose();
  }
});

// ------------------------------------------------------------------- outage

test("an outage: llm facts are kept out as not judged, none dropped, the model told; no round is spent on it", async () => {
  const decider = installDecider(() => {
    throw new TypeError("fetch failed: connect ECONNREFUSED");
  });
  try {
    await withStrict(STRICT_DEFAULT, async (s) => {
      const result = await callFinish(s.pi, "fin-1", payload(DIRECT, LLM));
      assert.equal(result.details.outcome, "accepted");
      assert.match(textOf(result), /Not judged: The decider that judges llm and derived facts gave no usable answer \(outage\)/);
      const check = readJson(join(s.exportDir, CHECK_FILENAME));
      assert.equal(check.facts[1].strict_outcome, "not_judged");
      assert.deepEqual(check.strict.dropped, []);
      assert.doesNotMatch(readFileSync(join(s.exportDir, "answer.md"), "utf8"), /\*\*f2:\*\*/);
    });
  } finally {
    decider.restore();
  }
});

// --------------------------------------------------------------- the override

test("ASSOCIATE_STRICT=off runs the report flow unchanged for a model the contract has strict on", async () => {
  const decider = installDecider(() => choice("none"));
  try {
    await withStrict({ ...STRICT_DEFAULT, [STRICT_ENV]: "off" }, async (s) => {
      const result = await callFinish(s.pi, "fin-1", payload(DIRECT, BAD));
      assert.equal(result.details.outcome, "accepted");
      assert.equal(result.details.mode, "report");
      const check = readJson(join(s.exportDir, CHECK_FILENAME));
      assert.equal(check.mode, "report");
      assert.ok(!("strict" in check));
      assert.deepEqual(check.would_refuse.map((r: any) => r.id), ["f3"]);
      assert.equal(decider.calls.length, 0);
    });
  } finally {
    decider.restore();
  }
});

test("ASSOCIATE_STRICT=on switches strict on for senses, which the contract leaves off", async () => {
  const decider = installDecider(() => choice("all"));
  try {
    await withStrict({ ...STRICT_DEFAULT, ASSOCIATE_MODEL: "senses", [STRICT_ENV]: "on" }, async (s) => {
      const result = await callFinish(s.pi, "fin-1", payload(DIRECT));
      assert.equal(result.details.mode, "strict");
      assert.equal(readJson(join(s.exportDir, CHECK_FILENAME)).strict.source, "environment");
    });
    await withStrict({ ...STRICT_DEFAULT, ASSOCIATE_MODEL: "senses" }, async (s) => {
      const result = await callFinish(s.pi, "fin-1", payload(DIRECT, BAD));
      assert.equal(result.details.mode, "report", "senses has strict off in the contract");
    });
  } finally {
    decider.restore();
  }
});

test("another ASSOCIATE_STRICT value is ignored with one stderr line, and the contract applies", async () => {
  const decider = installDecider(() => choice("all"));
  try {
    await withStrict({ ...STRICT_DEFAULT, [STRICT_ENV]: "maybe" }, async (s) => {
      const lines = s.errors.filter((line) => line.includes(STRICT_ENV));
      assert.equal(lines.length, 1, s.errors.join("\n"));
      assert.match(lines[0], /ASSOCIATE_STRICT="maybe" is not 'on' or 'off'; it is ignored/);
      const result = await callFinish(s.pi, "fin-1", payload(DIRECT));
      assert.equal(result.details.mode, "strict");
      assert.equal(readJson(join(s.exportDir, CHECK_FILENAME)).strict.source, "contract");
    });
  } finally {
    decider.restore();
  }
});

// ------------------------------------------------------- strict off: old shape

test("strict off: a fact with no quote and no at is refused as pi's validation refused it; a pointer fact is not", async () => {
  await withStrict({ [STRICT_ENV]: "off" }, async (s) => {
    const params = payload({ id: "f1", value: "ROLE_RESPONSIBILITIES", source: "w1" });
    await assert.rejects(
      () => s.pi.tool("finish").execute("fin-1", params) as Promise<unknown>,
      /^Error: Validation failed for tool "finish": facts\.0\.quote: must be string/,
    );
    assert.ok(!existsSync(join(s.exportDir, CHECK_FILENAME)), "nothing was checked");
    const ok = await callFinish(s.pi, "fin-2", payload(DIRECT));
    assert.equal(ok.details.outcome, "accepted");
  });
});

test("strict on: a fact with no quote and no at is dropped with the fix, not a validation error", async () => {
  const decider = installDecider(() => choice("all"));
  try {
    await withStrict(STRICT_DEFAULT, async (s) => {
      const result = await callFinish(s.pi, "fin-1", payload(DIRECT, { id: "f2", value: "ROLE_RESPONSIBILITIES", source: "w1" }));
      assert.match(textOf(result), /- f2 \(cites w1\): pointer_missing\. Fix: say where the evidence is/);
    });
  } finally {
    decider.restore();
  }
});
