/**
 * The hand-back checker wired into `finish` (issue #20, plan t11).
 *
 * One test group per acceptance criterion:
 *   1. the finish schema carries facts, alternatives, verdicts and open items,
 *      every new field optional, and a summary-only hand-back still finishes;
 *   2. enforce mode refuses a failing hand-back with what is wrong and the fix,
 *      leaves tools callable, allows the contract's retry rounds, and after the
 *      last round ends the run `refused` with nothing marked accepted;
 *   3. report mode accepts the same hand-back and the report lists each
 *      refusal it would have made; the mode is accuracy.json's per model, with
 *      `ASSOCIATE_CHECK_MODE` as the per-run override;
 *   4. facts.json, check.json and report.json are written by the extension in a
 *      session `associate run` did not start, and the statements files are
 *      byte-identical before and after the report is written;
 *   5. the answer is rendered by lib/render.ts from accepted items only; the
 *      summary and the final message sit under the unchecked label and their
 *      sentences are counted (the scope20-cortex-t1 pyproject sentence).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtension, type FakePi } from "./load-extension.ts";
import { associateRoot } from "../lib/paths.ts";
import { loadContract } from "../lib/contract.ts";
import { checkHandback } from "../lib/facts.ts";
import {
  ANSWER_FILENAME,
  CHECK_FILENAME,
  CHECK_MODE_ENV,
  FACTS_FILENAME,
  REPORT_FILENAME,
  checkModeOverride,
  resolveCheckMode,
} from "../lib/handback.ts";
import { UNCHECKED_HEADING, countSentences, renderAnswer } from "../lib/render.ts";
import { STATEMENTS_JSON_FILENAME, STATEMENTS_MD_FILENAME } from "../lib/statements.ts";

const CONTRACT_DIR = join(associateRoot, "associate", "contract");

/** The saved text of the one read the walk records as w1. */
const READ_TEXT = [
  "1\tROLE_RESPONSIBILITIES = {",
  "2\t    \"worker\": [\"execution\", \"tool_use\", \"repo_inspection\"],",
  "3\t    \"senses\": [\"intake\", \"normalize_input\"],",
  "4\t}",
].join("\n");

const GOOD_FACT = {
  id: "f1",
  value: "ROLE_RESPONSIBILITIES",
  source: "w1",
  quote: "ROLE_RESPONSIBILITIES = {",
};
const BAD_FACT = {
  id: "f2",
  value: "pyproject.toml",
  source: "w1",
  quote: "a content-identical copy sits in pyproject.toml",
};

const GOOD_PAYLOAD = {
  summary: "The role table is a dict.",
  facts: [GOOD_FACT],
  verdicts: [{ id: "v1", text: "The role table is defined in the file read.", verdict: "supported", basis: ["f1"] }],
};
const BAD_PAYLOAD = {
  summary: "The role table is a dict.",
  facts: [GOOD_FACT, BAD_FACT],
  verdicts: [{ id: "v1", text: "A copy sits in pyproject.toml.", verdict: "supported", basis: ["f2"] }],
};

interface Session {
  pi: FakePi;
  exportDir: string;
  errors: string[];
  dispose: () => void;
}

/** A contract directory copy with accuracy.json edited by `edit`. */
function contractCopy(edit: (accuracy: Record<string, any>) => void): { dir: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "associate-contract-"));
  const dir = join(root, "contract");
  cpSync(CONTRACT_DIR, dir, { recursive: true });
  const path = join(dir, "accuracy.json");
  const accuracy = JSON.parse(readFileSync(path, "utf8"));
  edit(accuracy);
  writeFileSync(path, JSON.stringify(accuracy, null, 2));
  return { dir, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * A session the extension was loaded into directly — no `associate run`, no
 * prompt injection — with one recorded read (w1) whose saved text is READ_TEXT.
 */
async function openSession(env: Record<string, string | undefined> = {}): Promise<Session> {
  const root = mkdtempSync(join(tmpdir(), "associate-runs-"));
  const checkout = mkdtempSync(join(tmpdir(), "associate-checkout-"));
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  let loaded: Awaited<ReturnType<typeof loadExtension>>;
  try {
    loaded = await loadExtension({
      ASSOCIATE_EXPORT_ROOT: root,
      ASSOCIATE_CHECKOUT_ROOT: checkout,
      ASSOCIATE_SESSION_ID: "finish-check",
      ASSOCIATE_INJECT_PROMPT: undefined,
      ASSOCIATE_CONTINUE_FROM: undefined,
      ASSOCIATE_MODEL: undefined,
      [CHECK_MODE_ENV]: undefined,
      ...env,
    });
  } finally {
    console.error = original;
  }
  const { pi } = loaded;
  await pi.fireSessionStart();
  await startPrompt(pi, "find the role table");
  await pi.fireToolResult({
    toolCallId: "tc-read-1",
    toolName: "read",
    input: { path: "roles.py", purpose: "find the role table" },
    content: [{ type: "text", text: READ_TEXT }],
  });
  const exportDir = join(root, "finish-check", "export");
  return {
    pi,
    exportDir,
    errors,
    dispose: () => {
      loaded.cleanup();
      rmSync(root, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    },
  };
}

async function startPrompt(pi: FakePi, prompt: string): Promise<void> {
  for (const handler of pi.handlers.get("before_agent_start") ?? []) {
    await handler({ type: "before_agent_start", prompt, systemPrompt: "" }, {});
  }
}

/** Call finish the way pi does: tool_call hook, execute, then the tool_result chain. */
async function callFinish(pi: FakePi, id: string, params: Record<string, unknown>): Promise<any> {
  const decision = (await pi.fireToolCall({ type: "tool_call", toolName: "finish", toolCallId: id, input: params })) as any;
  assert.notEqual(decision?.block, true, `finish itself must not be blocked: ${JSON.stringify(decision)}`);
  const result = (await pi.tool("finish").execute(id, params)) as any;
  await pi.fireToolResult({ toolCallId: id, toolName: "finish", input: params, ...result });
  return result;
}

function allText(result: any): string {
  return (result.content as Array<{ text: string }>).map((block) => block.text).join("\n");
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function readAfterFinish(pi: FakePi, id: string): Promise<any> {
  return pi.fireToolCall({
    type: "tool_call",
    toolName: "read",
    toolCallId: id,
    input: { path: "roles.py", purpose: "re-read the role table to fix the quote" },
  });
}

async function shutdown(pi: FakePi): Promise<void> {
  for (const handler of pi.handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" });
}

function walkOutcome(exportDir: string): string | undefined {
  const lines = readFileSync(join(exportDir, "walk.jsonl"), "utf8").trim().split("\n");
  for (const line of lines.reverse()) {
    const record = JSON.parse(line);
    if (record.run) return record.run.outcome;
  }
  return undefined;
}

async function fireFinalMessage(pi: FakePi, text: string, onlyLast = false): Promise<void> {
  const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } };
  const handlers = pi.handlers.get("message_end") ?? [];
  for (const handler of onlyLast ? handlers.slice(-1) : handlers) await handler(event);
}

// --- AC1: the schema ---------------------------------------------------------

test("AC1: the finish schema carries every facts.schema.json field, each new one optional", async () => {
  const s = await openSession();
  try {
    const params = s.pi.tool("finish").parameters as any;
    const facts = JSON.parse(readFileSync(join(CONTRACT_DIR, "schemas", "facts.schema.json"), "utf8"));
    for (const key of Object.keys(facts.properties)) {
      assert.ok(key in params.properties, `finish schema lacks ${key}`);
    }
    for (const key of ["facts", "alternatives", "verdicts", "open_items", "summary"]) {
      assert.ok(!params.required.includes(key), `${key} must be optional`);
    }
    const defs: Record<string, string> = {
      facts: "fact",
      alternatives: "alternative",
      verdicts: "verdict",
      open_items: "open_item",
    };
    for (const [field, def] of Object.entries(defs)) {
      const item = params.properties[field].items;
      assert.equal(item.type, "object", `${field} items are objects`);
      for (const key of Object.keys(facts.$defs[def].properties)) {
        assert.ok(key in item.properties, `finish ${field} items lack ${key}`);
      }
    }
    // Alternatives carry their prediction and refuter; verdicts their basis and open items their check.
    assert.ok("predicts" in params.properties.alternatives.items.properties);
    assert.ok("refuted_by" in params.properties.alternatives.items.properties);
    assert.ok("basis" in params.properties.verdicts.items.properties);
    assert.ok("check" in params.properties.open_items.items.properties);
    // Plain JSON Schema only (pi 1.5.2's pi-schema): no anyOf/oneOf/const anywhere.
    assert.doesNotMatch(JSON.stringify(params), /"(anyOf|oneOf|allOf|const|\$ref)"/);
  } finally {
    s.dispose();
  }
});

test("AC1: a hand-back with only a summary is still accepted and finishes the task", async () => {
  const s = await openSession();
  try {
    const result = await callFinish(s.pi, "fin-1", { summary: "Nothing to report." });
    const head = JSON.parse(result.content[0].text.replace(/^walk id: w\d+\n/, ""));
    assert.equal(head.summary, "Nothing to report.");
    assert.equal(head.outcome, "accepted");
    const after = (await readAfterFinish(s.pi, "r-1")) as any;
    assert.equal(after?.block, true);
    assert.match(String(after?.reason), /handed back/);
  } finally {
    s.dispose();
  }
});

test("AC1: a hand-back with facts, alternatives, verdicts and open items is accepted when it checks", async () => {
  const s = await openSession({ [CHECK_MODE_ENV]: "enforce" });
  try {
    const result = await callFinish(s.pi, "fin-1", {
      summary: "The table is a dict.",
      facts: [GOOD_FACT],
      alternatives: [
        { id: "a1", text: "The table is a list.", predicts: "a [ after the name", refuted_by: "a { after the name" },
      ],
      verdicts: [
        { id: "v1", text: "The role table is a dict.", verdict: "supported", basis: ["f1"], alternative: "a1" },
        { id: "v2", text: "Whether every role is listed.", verdict: "cannot_tell", basis: [], check: "read lines 5-40" },
      ],
      open_items: [{ id: "o1", text: "Where the table is used.", check: "grep ROLE_RESPONSIBILITIES" }],
    });
    assert.notEqual(result.terminate, true);
    const check = readJson(join(s.exportDir, CHECK_FILENAME));
    assert.equal(check.accepted, true, JSON.stringify(check));
    assert.equal(check.outcome, "accepted");
    const after = (await readAfterFinish(s.pi, "r-1")) as any;
    assert.match(String(after?.reason), /handed back/);
  } finally {
    s.dispose();
  }
});

// --- AC2: enforce mode ----------------------------------------------------------

test("AC2: enforce refuses a failing hand-back with the fix, tools stay callable, finished stays false", async () => {
  const s = await openSession({ [CHECK_MODE_ENV]: "enforce" });
  try {
    const result = await callFinish(s.pi, "fin-1", BAD_PAYLOAD);
    assert.notEqual(result.terminate, true, "a first refusal must not end the run");
    const text = allText(result);
    assert.match(text, /quote_not_in_result/, "names the check that failed");
    assert.match(text, /f2/, "names the fact that failed");
    assert.match(text, /fix:/i, "carries the fix");
    assert.match(text, /\bw1\b/, "names the walk id involved");
    assert.match(text, /2 rounds? left/, "states the rounds left (accuracy.json retry_rounds = 2)");
    const head = JSON.parse(result.content[0].text.replace(/^walk id: w\d+\n/, ""));
    assert.equal(head.outcome, "refused");
    assert.notEqual(head.accepted, true);
    // A refused hand-back is not a hand-back: the statements recorder gets none.
    assert.equal(result.details?.handback, undefined);
    // finished stays false: the next tool call is not refused as "handed back".
    const after = (await readAfterFinish(s.pi, "r-1")) as any;
    assert.doesNotMatch(String(after?.reason ?? ""), /handed back/);
    assert.notEqual(after?.block, true, JSON.stringify(after));
    // The model may answer again and be accepted.
    const second = await callFinish(s.pi, "fin-2", GOOD_PAYLOAD);
    assert.notEqual(second.terminate, true);
    assert.equal(readJson(join(s.exportDir, CHECK_FILENAME)).outcome, "accepted");
    assert.ok(existsSync(join(s.exportDir, ANSWER_FILENAME)));
  } finally {
    s.dispose();
  }
});

test("AC2: after the contract's last round the run ends refused and nothing marks the hand-back accepted", async () => {
  const s = await openSession({ [CHECK_MODE_ENV]: "enforce" });
  try {
    const first = await callFinish(s.pi, "fin-1", BAD_PAYLOAD);
    assert.match(allText(first), /2 rounds left/);
    const second = await callFinish(s.pi, "fin-2", BAD_PAYLOAD);
    assert.notEqual(second.terminate, true);
    assert.match(allText(second), /1 round left/);
    const last = await callFinish(s.pi, "fin-3", BAD_PAYLOAD);
    assert.equal(last.terminate, true, "the last refused round ends the run");
    assert.match(allText(last), /refused/);
    assert.match(allText(last), /quote_not_in_result/, "the result text names the failure");
    const head = JSON.parse(last.content[0].text.replace(/^walk id: w\d+\n/, ""));
    assert.equal(head.outcome, "refused");
    assert.notEqual(head.accepted, true);
    assert.equal(last.details?.handback, undefined);
    // facts.json and check.json stay on disk; no rendered answer is left.
    assert.ok(existsSync(join(s.exportDir, FACTS_FILENAME)));
    const check = readJson(join(s.exportDir, CHECK_FILENAME));
    assert.equal(check.accepted, false);
    assert.equal(check.outcome, "refused");
    assert.equal(check.run_ended, true);
    assert.ok(!existsSync(join(s.exportDir, ANSWER_FILENAME)), "no answer is rendered for a refused hand-back");
    // Nothing recorded the refused hand-back as statements.
    const statements = readJson(join(s.exportDir, STATEMENTS_JSON_FILENAME));
    assert.deepEqual(statements.statements, []);
    // Any further call is refused, but never as "handed back".
    const after = (await readAfterFinish(s.pi, "r-1")) as any;
    assert.equal(after?.block, true);
    assert.doesNotMatch(String(after?.reason), /handed back/);
    await shutdown(s.pi);
    assert.equal(walkOutcome(s.exportDir), "refused");
  } finally {
    s.dispose();
  }
});

test("AC2: the round limit comes from accuracy.json retry_rounds", async () => {
  const contract = contractCopy((a) => {
    a.retry_rounds = 0;
    a.mode.worker = "enforce";
  });
  const s = await openSession({ ASSOCIATE_CONTRACT_DIR: contract.dir });
  try {
    const only = await callFinish(s.pi, "fin-1", BAD_PAYLOAD);
    assert.equal(only.terminate, true, "with retry_rounds 0 the first refusal ends the run");
    await shutdown(s.pi);
    assert.equal(walkOutcome(s.exportDir), "refused");
  } finally {
    s.dispose();
    contract.dispose();
  }
});

test("AC2: repeated failed hand-backs are also capped by accuracy.json refusal_cap", async () => {
  const contract = contractCopy((a) => {
    a.retry_rounds = 5;
    a.refusal_cap = 2;
    a.mode.worker = "enforce";
  });
  const s = await openSession({ ASSOCIATE_CONTRACT_DIR: contract.dir });
  try {
    const first = await callFinish(s.pi, "fin-1", BAD_PAYLOAD);
    assert.notEqual(first.terminate, true);
    const second = await callFinish(s.pi, "fin-2", BAD_PAYLOAD);
    assert.equal(second.terminate, true, "the refusal cap ends the run before the rounds run out");
    assert.match(allText(second), /refusal_cap/);
  } finally {
    s.dispose();
    contract.dispose();
  }
});

test("AC2: a new prompt starts with fresh rounds", async () => {
  const s = await openSession({ [CHECK_MODE_ENV]: "enforce" });
  try {
    await callFinish(s.pi, "fin-1", BAD_PAYLOAD);
    await callFinish(s.pi, "fin-2", BAD_PAYLOAD);
    await startPrompt(s.pi, "a second task");
    const again = await callFinish(s.pi, "fin-3", BAD_PAYLOAD);
    assert.notEqual(again.terminate, true);
    assert.match(allText(again), /2 rounds left/);
  } finally {
    s.dispose();
  }
});

// --- AC3: report mode and where the mode comes from ------------------------------

test("AC3: report mode accepts the failing hand-back and the report lists each refusal it would have made", async () => {
  const s = await openSession();
  try {
    const result = await callFinish(s.pi, "fin-1", BAD_PAYLOAD);
    assert.notEqual(result.terminate, true);
    const head = JSON.parse(result.content[0].text.replace(/^walk id: w\d+\n/, ""));
    assert.equal(head.outcome, "accepted");
    assert.equal(head.mode, "report");
    const after = (await readAfterFinish(s.pi, "r-1")) as any;
    assert.match(String(after?.reason), /handed back/, "finished is set in report mode");

    const report = readJson(join(s.exportDir, REPORT_FILENAME));
    const checks = report.flags.map((f: { check: string }) => f.check);
    assert.ok(checks.includes("quote_not_in_result"), JSON.stringify(report.flags));
    assert.ok(checks.includes("conclusion_without_fact"), JSON.stringify(report.flags));
    const check = readJson(join(s.exportDir, CHECK_FILENAME));
    assert.equal(check.mode, "report");
    assert.equal(check.accepted, false, "the checker's own verdict is kept");
    assert.equal(check.outcome, "accepted");
    const would = check.would_refuse.map((r: { id: string; check: string }) => `${r.id}:${r.check}`);
    assert.deepEqual(would.sort(), ["f2:quote_not_in_result", "v1:conclusion_without_fact"]);
    assert.match(allText(result), /would have been refused/);
  } finally {
    s.dispose();
  }
});

test("AC3: the mode comes from accuracy.json for the active model", async () => {
  const contract = contractCopy((a) => {
    a.mode.worker = "enforce";
  });
  const s = await openSession({ ASSOCIATE_CONTRACT_DIR: contract.dir });
  try {
    const result = await callFinish(s.pi, "fin-1", BAD_PAYLOAD);
    const head = JSON.parse(result.content[0].text.replace(/^walk id: w\d+\n/, ""));
    assert.equal(head.outcome, "refused");
    assert.equal(head.mode, "enforce");
  } finally {
    s.dispose();
    contract.dispose();
  }
});

test("AC3: ASSOCIATE_CHECK_MODE overrides the contract per run; another value is ignored with one stderr line", async () => {
  const contract = contractCopy((a) => {
    a.mode.worker = "enforce";
  });
  try {
    const overridden = await openSession({ ASSOCIATE_CONTRACT_DIR: contract.dir, [CHECK_MODE_ENV]: "report" });
    try {
      const result = await callFinish(overridden.pi, "fin-1", BAD_PAYLOAD);
      const head = JSON.parse(result.content[0].text.replace(/^walk id: w\d+\n/, ""));
      assert.equal(head.outcome, "accepted");
      assert.equal(head.mode, "report");
      assert.equal(readJson(join(overridden.exportDir, CHECK_FILENAME)).mode_source, "env");
    } finally {
      overridden.dispose();
    }

    const bogus = await openSession({ ASSOCIATE_CONTRACT_DIR: contract.dir, [CHECK_MODE_ENV]: "strict" });
    try {
      const lines = bogus.errors.filter((line) => line.includes(CHECK_MODE_ENV));
      assert.equal(lines.length, 1, bogus.errors.join("\n"));
      assert.match(lines[0], /strict/);
      const result = await callFinish(bogus.pi, "fin-1", BAD_PAYLOAD);
      const head = JSON.parse(result.content[0].text.replace(/^walk id: w\d+\n/, ""));
      assert.equal(head.mode, "enforce", "the contract's mode applies");
    } finally {
      bogus.dispose();
    }
  } finally {
    contract.dispose();
  }
});

test("AC3: resolveCheckMode and checkModeOverride", () => {
  const { accuracy } = loadContract({});
  assert.deepEqual(checkModeOverride({}), {});
  assert.deepEqual(checkModeOverride({ [CHECK_MODE_ENV]: "enforce" }), { mode: "enforce" });
  assert.deepEqual(checkModeOverride({ [CHECK_MODE_ENV]: " report " }), { mode: "report" });
  const bad = checkModeOverride({ [CHECK_MODE_ENV]: "ENFORCE!" });
  assert.equal(bad.mode, undefined);
  assert.match(String(bad.problem), /ASSOCIATE_CHECK_MODE/);
  assert.deepEqual(resolveCheckMode(accuracy, "worker", undefined), { mode: "report", source: "contract" });
  assert.deepEqual(resolveCheckMode(accuracy, "worker", "enforce"), { mode: "enforce", source: "env" });
});

// --- AC4: files in every session ---------------------------------------------------

test("AC4: a session started without associate run leaves facts.json, check.json and report.json", async () => {
  const s = await openSession();
  try {
    const payload = {
      ...BAD_PAYLOAD,
      summary: "Done. The gateway key is token=abcdef1234567890 for the record.",
    };
    await callFinish(s.pi, "fin-1", payload);
    for (const name of [FACTS_FILENAME, CHECK_FILENAME, REPORT_FILENAME, ANSWER_FILENAME]) {
      assert.ok(existsSync(join(s.exportDir, name)), `${name} must be in the export`);
    }
    const facts = readJson(join(s.exportDir, FACTS_FILENAME));
    assert.deepEqual(facts.facts, payload.facts, "the payload as received");
    assert.deepEqual(facts.verdicts, payload.verdicts);
    assert.ok(!JSON.stringify(facts).includes("abcdef1234567890"), "after redaction");
    assert.match(facts.summary, /\[REDACTED\]/);

    const report = readJson(join(s.exportDir, REPORT_FILENAME));
    const schema = readJson(join(CONTRACT_DIR, "schemas", "report.schema.json"));
    for (const key of schema.required) assert.ok(key in report, `report lacks ${key}`);
    for (const key of Object.keys(report)) assert.ok(key in schema.properties, `report has a key the schema forbids: ${key}`);
    assert.equal(report.python_recheck_ran, false);
    assert.equal(report.facts.made, 2);
    assert.equal(report.facts.passed, 1);
    assert.equal(report.facts.refused, 1);

    const check = readJson(join(s.exportDir, CHECK_FILENAME));
    assert.deepEqual(
      check.facts.map((f: { id: string; verdict: string }) => [f.id, f.verdict]),
      [
        ["f1", "passed"],
        ["f2", "refused"],
      ],
    );
  } finally {
    s.dispose();
  }
});

test("AC4: the statements files are byte-identical before and after the report is written", async () => {
  const s = await openSession();
  try {
    const statementsMd = join(s.exportDir, STATEMENTS_MD_FILENAME);
    const statementsJson = join(s.exportDir, STATEMENTS_JSON_FILENAME);
    const snapshot = () => [readFileSync(statementsMd), readFileSync(statementsJson)];

    // finish's execute writes report.json; it must not touch the statements.
    const beforeExecute = snapshot();
    const result = (await s.pi.tool("finish").execute("fin-1", GOOD_PAYLOAD)) as any;
    assert.ok(existsSync(join(s.exportDir, REPORT_FILENAME)));
    assert.deepEqual(snapshot(), beforeExecute);
    await s.pi.fireToolResult({ toolCallId: "fin-1", toolName: "finish", input: GOOD_PAYLOAD, ...result });

    // The final message rewrites report.json (the extension's own handler,
    // registered last); the statements files do not change.
    const before = snapshot();
    const reportBefore = readFileSync(join(s.exportDir, REPORT_FILENAME), "utf8");
    await fireFinalMessage(s.pi, "The role table is a dict. It has two roles.", true);
    const reportAfter = readFileSync(join(s.exportDir, REPORT_FILENAME), "utf8");
    assert.notEqual(reportAfter, reportBefore, "the report was rewritten");
    assert.deepEqual(snapshot(), before);
  } finally {
    s.dispose();
  }
});

// --- AC5: the rendered answer ------------------------------------------------------

const CORTEX_SUMMARY =
  "The role table is defined in roles.py. A content-identical copy of the same table also sits in pyproject.toml.";

test("AC5: the cortex pyproject sentence in a summary appears only under the unchecked label", async () => {
  const s = await openSession();
  try {
    const result = await callFinish(s.pi, "fin-1", { ...GOOD_PAYLOAD, summary: CORTEX_SUMMARY });
    const answer = readFileSync(join(s.exportDir, ANSWER_FILENAME), "utf8");
    const at = answer.indexOf(UNCHECKED_HEADING);
    assert.ok(at > 0, "the answer has an unchecked section");
    const checked = answer.slice(0, at);
    const unchecked = answer.slice(at);
    assert.ok(!checked.includes("pyproject"), `the checked part must not carry the sentence:\n${checked}`);
    assert.ok(unchecked.includes("A content-identical copy of the same table also sits in pyproject.toml."));
    assert.ok(checked.includes("The role table is defined in the file read."), "the accepted verdict is rendered");
    assert.ok(checked.includes("ROLE_RESPONSIBILITIES = {"), "the passed fact is rendered");

    // The rendered answer is also what finish hands the model to reply with.
    const text = allText(result);
    assert.ok(text.includes(answer.trim()), "finish's result carries the rendered answer");
    assert.match(text, /reply .*with exactly/i);

    const check = readJson(join(s.exportDir, CHECK_FILENAME));
    assert.equal(check.unchecked_text.summary_sentences, 2);
    const report = readJson(join(s.exportDir, REPORT_FILENAME));
    // Unchecked sentences are reported in their own field, never in the statements counts.
    assert.equal(report.statements.made, 1);
    assert.equal(report.statements.without_fact, 0);
    assert.deepEqual(report.unchecked_text, { summary_sentences: 2, final_message_sentences: 0 });

    // The final message is unchecked text too, counted in the report.
    await fireFinalMessage(s.pi, "Done. The table also sits in pyproject.toml.");
    const after = readJson(join(s.exportDir, CHECK_FILENAME));
    assert.equal(after.unchecked_text.final_message_sentences, 2);
    const reportAfter = readJson(join(s.exportDir, REPORT_FILENAME));
    assert.equal(reportAfter.statements.without_fact, 0);
    assert.equal(reportAfter.statements.made, 1);
    assert.deepEqual(reportAfter.unchecked_text, { summary_sentences: 2, final_message_sentences: 2 });
    const answerAfter = readFileSync(join(s.exportDir, ANSWER_FILENAME), "utf8");
    const at2 = answerAfter.indexOf(UNCHECKED_HEADING);
    assert.ok(!answerAfter.slice(0, at2).includes("pyproject"));
    assert.ok(answerAfter.slice(at2).includes("Done. The table also sits in pyproject.toml."));
  } finally {
    s.dispose();
  }
});

test("AC5: a final message that is exactly the rendered answer adds no unchecked sentence", async () => {
  const s = await openSession();
  try {
    await callFinish(s.pi, "fin-1", GOOD_PAYLOAD);
    const answer = readFileSync(join(s.exportDir, ANSWER_FILENAME), "utf8");
    await fireFinalMessage(s.pi, answer);
    const check = readJson(join(s.exportDir, CHECK_FILENAME));
    assert.equal(check.unchecked_text.final_message_sentences, 0);
    assert.equal(check.unchecked_text.final_message, "rendered_answer");
  } finally {
    s.dispose();
  }
});

test("AC5: renderAnswer uses accepted facts and conclusions only", () => {
  const { accuracy } = loadContract({});
  const payload = {
    summary: CORTEX_SUMMARY,
    facts: [GOOD_FACT, BAD_FACT, { id: "f3", value: "x y", source: "w2", quote: "not saved anywhere at all" }],
    alternatives: [{ id: "a1", text: "It is a list.", predicts: "a bracket", refuted_by: "a brace" }],
    verdicts: [
      { id: "v1", text: "The table is a dict.", verdict: "supported", basis: ["f1"], alternative: "a1" },
      { id: "v2", text: "A copy sits in pyproject.toml.", verdict: "supported", basis: ["f2"] },
    ],
    open_items: [
      { id: "o1", text: "Where it is used.", check: "grep the name" },
      { id: "o2", text: "Undecided thing with no check." },
    ],
  };
  const entries = [
    { id: "w1", tool: "read" },
    { id: "w2", tool: "read" },
  ];
  const check = checkHandback({ payload, entries, results: { w1: READ_TEXT } }, accuracy);
  const answer = renderAnswer({ payload, check, summary: payload.summary });
  const [checked, unchecked] = answer.split(UNCHECKED_HEADING);
  assert.ok(checked.includes("The table is a dict."));
  assert.ok(checked.includes("It is a list."), "the alternative of an accepted verdict is shown");
  assert.ok(checked.includes("a brace"));
  assert.ok(checked.includes("Where it is used."));
  assert.ok(checked.includes("ROLE_RESPONSIBILITIES = {"));
  assert.ok(checked.includes("not saved anywhere at all"), "an unchecked fact is shown");
  assert.match(checked, /not checked/i, "...labelled not checked");
  for (const refused of ["A copy sits in pyproject.toml.", "a content-identical copy sits", "Undecided thing"]) {
    assert.ok(!checked.includes(refused), `refused item leaked into the answer: ${refused}`);
  }
  assert.match(checked, /3 items? .*refused/i, "says how many items were left out");
  assert.ok(unchecked.includes("pyproject.toml"));
});

test("AC5: countSentences", () => {
  assert.equal(countSentences(""), 0);
  assert.equal(countSentences("   "), 0);
  assert.equal(countSentences("One."), 1);
  assert.equal(countSentences(CORTEX_SUMMARY), 2);
  assert.equal(countSentences("Pinned to pi 1.5.2. Done!"), 2);
  assert.equal(countSentences("No terminator"), 1);
  assert.equal(countSentences("- first item\n- second item"), 2);
  assert.equal(countSentences("Is it? Yes."), 2);
});
