/**
 * Replays of the six failures recorded on 2026-11-17 (issue #20, plan t19).
 *
 * Each test takes a RECORDED failure (or, for the senses case, one rebuilt from
 * a note) out of `tests/fixtures/accuracy/` and runs it through the merged
 * entry point, asserting the failure is now caught. These are not the unit
 * tests of the building tasks (`statements.test.ts`, `facts.test.ts`,
 * `torch.test.ts`, `toolcall.test.ts`/`guard.test.ts`, `finish-check.test.ts`);
 * they feed those entry points what the live runs actually produced.
 *
 * The fixtures are trimmed copies of the pre-change exports of the runs
 * scope20-cortex-t1, scope20-worker-t2, scope20-worker-t3 and
 * scope20-worker-t5, with scratch paths rewritten to `/checkout`. The senses
 * case (t20 run A2) has no recorded walk; its fixture is rebuilt from
 * docs/notes/t20-live-acceptance.md and says so in its `_origin` field.
 *
 * Against commit 33141ff (the parent of the accuracy work), run on
 * 2026-11-18 by copying this file and the fixtures into a temporary checkout
 * of that commit and running `node --test` on it:
 *
 *   1. invented [w999] in a final message ....... FAILED by assertion
 *        (the final-message route recorded it as referenced).
 *   2. fact quoting text absent from its entry ... FAILED: `lib/facts.ts` does
 *        not exist there (import error).
 *   3. prior-run id in a continued run ........... FAILED by assertion
 *        (renderPriorContext showed the prior entries as bare `wN`); the
 *        checker half was not reached (it needs the missing `lib/facts.ts`).
 *   4. call with no purpose ....................... FAILED by assertion
 *        (decideToolCall let the call through).
 *   5. cortex pyproject sentence in a summary ..... FAILED: `lib/facts.ts` (reached
 *        first) and `lib/render.ts` do not exist there (import error).
 *   6. senses "Eidetic remember: Success" ......... FAILED: `lib/facts.ts` does
 *        not exist there (import error).
 *
 * The modules that do not exist at 33141ff are imported inside the tests, so
 * each replay fails on its own there instead of the whole file failing to load.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContract } from "../lib/contract.ts";
import { associateRoot } from "../lib/paths.ts";
import { WALK_FILENAME } from "../lib/walk.ts";
import { StatementsRecorder, STATEMENTS_JSON_FILENAME } from "../lib/statements.ts";
import { decideToolCall } from "../lib/guard.ts";
import { loadPriorWalk, renderPriorContext } from "../lib/torch.ts";
import { resolveActiveModel } from "../lib/toolset.ts";

const contract = loadContract({});
const FIXTURES = join(associateRoot, "tests", "fixtures", "accuracy");

function fixture(name: string): any {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

function withDir<T>(body: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "associate-replay-"));
  return Promise.resolve(body(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** Fixture walk entries as walk.jsonl lines. */
function walkLines(entries: any[]): string {
  const lines = entries.map((e) =>
    JSON.stringify({ id: e.id, ts: "2026-11-17T00:00:00.000Z", tool: e.tool, args: e.args, result: e.result, truncated: false }),
  );
  lines.push(JSON.stringify({ run: { duration_ms: 1, tool_calls: entries.length, outcome: "ok", truncated: false } }));
  return `${lines.join("\n")}\n`;
}

/** The checker's inputs from fixture entries: the saved text of each is its inline content. */
function runData(entries: any[]) {
  const results: Record<string, string> = {};
  for (const e of entries) results[e.id] = e.result.content;
  return {
    entries: entries.map((e) => ({ ...e, ts: "2026-11-17T00:00:00.000Z", truncated: false })),
    results,
  };
}

async function checker() {
  const { checkHandback } = await import("../lib/facts.ts");
  return checkHandback;
}

// 1 ------------------------------------------------------------------------

test("replay 1: the recorded final message citing [w999] is recorded as unreferenced (scope20-worker-t5)", () =>
  withDir((dir) => {
    const fx = fixture("final_message_w999.json");
    assert.equal(fx.recorded_status, "referenced", "the recorded run stored it as referenced");
    const walkPath = join(dir, WALK_FILENAME);
    writeFileSync(walkPath, walkLines(fx.walk), "utf8");
    const recorder = new StatementsRecorder({ exportDir: dir, walkPath, policy: contract.policy, installExitHook: false });
    recorder.recordAssistantMessage(fx.final_message);
    recorder.finalize();

    const artifact = JSON.parse(readFileSync(join(dir, STATEMENTS_JSON_FILENAME), "utf8")) as {
      statements: Array<{ text: string; status: string; evidence: string[] }>;
    };
    const cited = artifact.statements.filter((s) => s.text.includes(fx.invented_id));
    assert.ok(cited.length > 0, "the recorded statement is still in the artifact");
    for (const s of cited) {
      assert.equal(s.status, "unreferenced", s.text);
      assert.ok(!s.evidence.includes(fx.invented_id), `${fx.invented_id} names no walk entry`);
    }
  }));

// 2 ------------------------------------------------------------------------

test("replay 2: the recorded statement on w3 and w7 becomes two refused quote_absent facts (scope20-worker-t2)", async () => {
  const checkHandback = await checker();
  const fx = fixture("quote_absent_example_markers.json");
  assert.equal(fx.recorded_statement.status, "referenced", "the recorded run stored it as referenced");
  const got = checkHandback({ payload: { facts: [...fx.facts, fx.control_fact] }, ...runData(fx.entries) }, contract.accuracy);
  const verdict = (id: string) => got.facts.find((f) => f.id === id)!;
  for (const id of ["f1", "f2"]) {
    assert.equal(verdict(id).verdict, "refused", id);
    assert.equal(verdict(id).reason, "quote_absent", id);
    assert.ok(verdict(id).nearest !== null, `${id}: the refusal shows the nearest span`);
  }
  // The same quote against the entry that really holds it passes.
  assert.equal(verdict("f3").verdict, "passed");
  assert.equal(got.accepted, false);
});

// 3 ------------------------------------------------------------------------

test("replay 3: a prior run's id is labelled in the context and refused or flagged when cited bare (scope20-worker-t3 -> t5)", async () => {
  const fx = fixture("prior_run_ids.json");
  assert.equal(fx.recorded_statement.status, "referenced", "the recorded run stored it as referenced");

  // The context the continued run was given: every prior entry carries a label.
  await withDir((dir) => {
    writeFileSync(join(dir, WALK_FILENAME), walkLines(fx.prior_entries), "utf8");
    const text = renderPriorContext(loadPriorWalk(dir), { policy: contract.policy, maxChars: 1_000_000 });
    const shown = [...text.matchAll(/^- \[([^\]]+)\]/gm)].map((m) => m[1]);
    assert.equal(shown.length, fx.prior_entries.length);
    for (const id of shown) assert.match(id, /^prior:w[1-9][0-9]*$/, `${id} must not look like a current-run id`);
  });

  // The citation: bare w10 is the current run's policy.json read, not the prior index.ts read.
  const checkHandback = await checker();
  const prior = runData(fx.prior_entries);
  const current = runData(fx.current_entries);
  const bare = checkHandback(
    { payload: { facts: [fx.fact] }, ...current, prior_runs: { prior } },
    contract.accuracy,
  );
  assert.equal(bare.facts[0]!.verdict, "refused");
  assert.equal(bare.facts[0]!.reason, "quote_absent");
  assert.ok(
    bare.report.flags.some((f) => f.detail.includes("ambiguous_reference") && f.ref === "w10"),
    JSON.stringify(bare.report.flags),
  );
  const labelled = checkHandback(
    { payload: { facts: [{ ...fx.fact, source: "prior:w10" }] }, ...current, prior_runs: { prior } },
    contract.accuracy,
  );
  assert.equal(labelled.facts[0]!.verdict, "passed");
  assert.equal(labelled.facts[0]!.run, "prior");
});

// 4 ------------------------------------------------------------------------

test("replay 4: the recorded calls, which stated no purpose, are refused as missing_purpose (scope20-cortex-t1)", async () => {
  const fx = fixture("no_purpose_calls.json");
  const exempt: readonly string[] = (contract as any).accuracy?.purpose_exempt_tools ?? [];
  const base = {
    model: resolveActiveModel({ ASSOCIATE_MODEL: "cortex" }, contract.models),
    registry: contract.models,
    policy: contract.policy,
    gate: undefined,
    task: "replay",
    scratchDir: join(tmpdir(), "associate-replay-scratch"),
    cwd: join(tmpdir(), "associate-replay-cwd"),
    recordGate: () => {},
    purposeExemptTools: exempt,
  };
  assert.ok(fx.calls.length >= 3);
  for (const call of fx.calls) {
    assert.equal(Object.hasOwn(call.args, "purpose"), false, `${call.id} is recorded without a purpose`);
    const refused = await decideToolCall({ ...base, toolName: call.tool, input: call.args });
    assert.equal(refused?.block, true, `${call.tool} ${call.id} must be refused`);
    assert.equal(refused?.kind, "missing_purpose", call.id);
    // The refusal is what the model is told; the same call with a purpose goes through.
    const stated = { ...call.args, purpose: "replay: the same call, now stating its purpose" };
    assert.equal(await decideToolCall({ ...base, toolName: call.tool, input: stated }), undefined, call.id);
  }
});

// 5 ------------------------------------------------------------------------

test("replay 5: the cortex pyproject sentence in a finish summary sits only under the unchecked label (scope20-cortex-t1)", async () => {
  const checkHandback = await checker();
  const { UNCHECKED_HEADING, countSentences, renderAnswer } = await import("../lib/render.ts");
  const fx = fixture("finish_summary_pyproject.json");
  assert.ok(fx.summary.includes(fx.pyproject_sentence), "the recorded summary carries the sentence");

  const payload = { summary: fx.summary, facts: [fx.fact] };
  const check = checkHandback({ payload, ...runData(fx.entries) }, contract.accuracy);
  // The sentence as a fact: its quote is not in the gate.json read it cites.
  assert.equal(check.facts[0]!.verdict, "refused");
  assert.equal(check.facts[0]!.reason, "quote_absent");

  // The sentence as the summary the model wrote: never in the checked part, counted as unchecked.
  const answer = renderAnswer({ payload, check, summary: fx.summary });
  const at = answer.indexOf(UNCHECKED_HEADING);
  assert.ok(at >= 0, "the unchecked label is present");
  assert.ok(!answer.slice(0, at).includes("pyproject"), `the checked part must not carry the sentence:\n${answer.slice(0, at)}`);
  assert.ok(answer.slice(at).includes(fx.pyproject_sentence));
  assert.ok(countSentences(fx.summary) >= 3, "the summary is counted sentence by sentence");
});

// 6 ------------------------------------------------------------------------

test("replay 6: 'Eidetic remember: Success' with no eidetic_remember call is refused (t20 run A2, rebuilt from the note)", async () => {
  const checkHandback = await checker();
  const fx = fixture("senses_remember_success.json");
  assert.equal(fx.kind, "rebuilt-from-note");
  assert.ok(fx._origin.startsWith("REBUILT FROM A NOTE"), "the fixture says it is rebuilt");
  assert.ok(!fx.entries.some((e: any) => e.tool === "eidetic_remember"), "the walk has no such call");

  const got = checkHandback({ payload: { facts: fx.facts }, ...runData(fx.entries) }, contract.accuracy);
  const [wrongTool, unknown] = got.facts;
  assert.equal(wrongTool!.verdict, "refused");
  assert.equal(wrongTool!.reason, "action_wrong_tool", "a recall entry is not a remember call");
  assert.equal(unknown!.verdict, "refused");
  assert.equal(unknown!.reason, "source_unknown", "w3 is no entry of the walk");
  assert.equal(got.accepted, false);
});

// portability --------------------------------------------------------------

test("every fixture is free of absolute home and temp paths and of redaction-pattern secrets", () => {
  const redaction = contract.policy.redaction as { patterns: string[] };
  const patterns = redaction.patterns.map((p) => new RegExp(p.replace(/^\(\?i\)/, ""), p.startsWith("(?i)") ? "i" : ""));
  const names = readdirSync(FIXTURES).filter((n) => n.endsWith(".json"));
  assert.ok(names.length >= 6, names.join(", "));
  for (const name of names) {
    const text = readFileSync(join(FIXTURES, name), "utf8");
    assert.ok(!text.includes("/home/"), `${name} holds /home/`);
    assert.ok(!text.includes("/tmp/"), `${name} holds /tmp/`);
    for (const re of patterns) assert.ok(!re.test(text), `${name} matches redaction pattern ${re}`);
  }
});
