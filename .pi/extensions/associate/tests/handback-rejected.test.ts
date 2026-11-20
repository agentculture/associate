/**
 * A quoted list in `finish`, and the rejected hand-back file (plan task t3,
 * claims c38 and h27).
 *
 * The recorded failure: the worker review run t9-worker-review of 2026-11-18
 * called finish twice with `facts` given as a string holding a JSON list of
 * eight facts. pi's argument validation rejected both calls before the tool
 * ran, and the payload survived only inside the walk's error text. The
 * fixture `tests/fixtures/accuracy/worker_review_quoted_facts.json` keeps that
 * payload (see its `_origin`).
 *
 * One group per acceptance criterion:
 *   1. a quoted list is parsed and accepted when it is a JSON list, and refused
 *      with a fix naming the quoted list when it is not — the recorded payload
 *      is not valid JSON (fact f4 holds unescaped quotes), so it is refused;
 *   2. every rejected finish (pi's validation, the quoted-list refusal, the
 *      check in enforce mode) leaves `rejected_handback.json` labelled
 *      rejected, the latest one kept, and no answer.md presenting it;
 *   4. the purpose rule still exempts finish.
 * (Criterion 3, the timeout result, is a pytest in tests/test_run.py.)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtension, type FakePi } from "./load-extension.ts";
import { associateRoot } from "../lib/paths.ts";
import {
  ANSWER_FILENAME,
  CHECK_FILENAME,
  CHECK_MODE_ENV,
  FACTS_FILENAME,
  QUOTED_LIST_REFUSAL,
  REJECTED_HANDBACK_FILENAME,
  REJECTED_LABEL,
  prepareFinishArguments,
} from "../lib/handback.ts";

const FIXTURE = JSON.parse(
  readFileSync(join(associateRoot, "tests", "fixtures", "accuracy", "worker_review_quoted_facts.json"), "utf8"),
);
const RECORDED_ARGS: Record<string, unknown> = FIXTURE.finish_arguments;

/**
 * The recorded payload with the two unescaped quote pairs in fact f4's value
 * escaped. CONSTRUCTED from the fixture for this test, not recorded: it is the
 * smallest change that makes the model's quoted list valid JSON.
 */
function correctedArgs(): Record<string, unknown> {
  const facts = (RECORDED_ARGS.facts as string).replace(
    '`("see src/lib/facts.ts", "lib/facts.ts", False)`',
    '`(\\"see src/lib/facts.ts\\", \\"lib/facts.ts\\", False)`',
  );
  assert.notEqual(facts, RECORDED_ARGS.facts, "the f4 value was found and escaped");
  return { ...RECORDED_ARGS, facts };
}

const READ_TEXT = ["1\tROLE_RESPONSIBILITIES = {", "2\t    \"worker\": [\"execution\"],", "3\t}"].join("\n");
const GOOD_FACT = { id: "f1", value: "ROLE_RESPONSIBILITIES", source: "w1", quote: "ROLE_RESPONSIBILITIES = {" };
const BAD_FACT = { id: "f2", value: "pyproject.toml", source: "w1", quote: "a copy sits in pyproject.toml" };

interface Session {
  pi: FakePi;
  exportDir: string;
  dispose: () => void;
}

async function openSession(env: Record<string, string | undefined> = {}): Promise<Session> {
  const root = mkdtempSync(join(tmpdir(), "associate-runs-"));
  const checkout = mkdtempSync(join(tmpdir(), "associate-checkout-"));
  const original = console.error;
  console.error = () => {};
  let loaded: Awaited<ReturnType<typeof loadExtension>>;
  try {
    loaded = await loadExtension({
      ASSOCIATE_EXPORT_ROOT: root,
      ASSOCIATE_CHECKOUT_ROOT: checkout,
      ASSOCIATE_SESSION_ID: "rejected",
      ASSOCIATE_INJECT_PROMPT: undefined,
      ASSOCIATE_CONTINUE_FROM: undefined,
      ASSOCIATE_MODEL: undefined,
      [CHECK_MODE_ENV]: undefined,
      // Strict facts pinned off (t5): these tests are the report/enforce flow.
      ASSOCIATE_STRICT: "off",
      ...env,
    });
  } finally {
    console.error = original;
  }
  const { pi } = loaded;
  await pi.fireSessionStart();
  for (const handler of pi.handlers.get("before_agent_start") ?? []) {
    await handler({ type: "before_agent_start", prompt: "find the role table", systemPrompt: "" }, {});
  }
  await pi.fireToolResult({
    toolCallId: "tc-read-1",
    toolName: "read",
    input: { path: "roles.py", purpose: "find the role table" },
    content: [{ type: "text", text: READ_TEXT }],
  });
  return {
    pi,
    exportDir: join(root, "rejected", "export"),
    dispose: () => {
      loaded.cleanup();
      rmSync(root, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    },
  };
}

async function fireStart(pi: FakePi, id: string, args: unknown): Promise<void> {
  for (const handler of pi.handlers.get("tool_execution_start") ?? []) {
    await handler({ type: "tool_execution_start", toolCallId: id, toolName: "finish", args });
  }
}

/**
 * Call finish the way pi 1.5.2 does (agent-loop.js prepareToolCall):
 * tool_execution_start with the raw arguments, then the tool's
 * prepareArguments; a throw there is an immediate error result that reaches
 * only tool_execution_end. Otherwise the tool_call hook, execute, the
 * tool_result chain and tool_execution_end.
 */
async function piCallsFinish(pi: FakePi, id: string, raw: Record<string, unknown>): Promise<{ error?: string; result?: any }> {
  await fireStart(pi, id, raw);
  const prepare = pi.tool("finish").prepareArguments as ((args: unknown) => Record<string, unknown>) | undefined;
  let params = raw;
  try {
    if (prepare) params = prepare(structuredClone(raw));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pi.fireToolExecutionEnd({
      toolCallId: id,
      toolName: "finish",
      result: { content: [{ type: "text", text: message }] },
      isError: true,
    });
    return { error: message };
  }
  const decision = (await pi.fireToolCall({ type: "tool_call", toolName: "finish", toolCallId: id, input: params })) as any;
  assert.notEqual(decision?.block, true, `finish must not be blocked: ${JSON.stringify(decision)}`);
  const result = (await pi.tool("finish").execute(id, params)) as any;
  await pi.fireToolResult({ toolCallId: id, toolName: "finish", input: params, ...result });
  await pi.fireToolExecutionEnd({ toolCallId: id, toolName: "finish", result, isError: false });
  return { result };
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

// --- AC1: the quoted list ----------------------------------------------------

test("AC1: a list field given as a string holding a JSON list is parsed into the list", () => {
  const raw = { summary: "s", facts: JSON.stringify([GOOD_FACT]), verdicts: [] };
  const prepared = prepareFinishArguments(raw) as Record<string, unknown>;
  assert.deepEqual(prepared.facts, [GOOD_FACT]);
  assert.equal(prepared.summary, "s");
  assert.deepEqual(prepared.verdicts, []);
});

test("AC1: arguments with no quoted list are returned as the same object (pi then skips the shim)", () => {
  const raw = { summary: "s", facts: [GOOD_FACT] };
  assert.equal(prepareFinishArguments(raw), raw);
});

test("AC1: the recorded payload is refused with a fix that names the quoted list and where it breaks", () => {
  assert.equal(typeof RECORDED_ARGS.facts, "string", "the fixture keeps facts as the string the model sent");
  assert.throws(
    () => prepareFinishArguments(structuredClone(RECORDED_ARGS)),
    (error: Error) => {
      assert.ok(error.message.startsWith(QUOTED_LIST_REFUSAL), error.message);
      assert.match(error.message, /`facts`/, "names the field");
      assert.match(error.message, /string holding a JSON list|quoted list/, "says the list was quoted");
      assert.match(error.message, /not valid JSON/);
      assert.match(error.message, /character 752/, "says where the parse stopped");
      assert.match(error.message, /Fix: pass `facts` as a list/);
      return true;
    },
  );
});

test("AC1: the recorded list, with fact f4's quotes escaped, yields a hand-back with its eight facts", async () => {
  const s = await openSession();
  try {
    const { result, error } = await piCallsFinish(s.pi, "fin-1", correctedArgs());
    assert.equal(error, undefined);
    const head = JSON.parse(result.content[0].text.replace(/^walk id: w\d+\n/, ""));
    assert.equal(head.outcome, "accepted");
    const facts = readJson(join(s.exportDir, FACTS_FILENAME)).facts;
    assert.equal(facts.length, 8);
    assert.deepEqual(
      facts.map((f: any) => f.id),
      ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"],
    );
    const check = readJson(join(s.exportDir, CHECK_FILENAME));
    assert.deepEqual(check.quoted_lists, ["facts"], "check.json says which list arrived quoted");
    assert.match(result.content.map((b: any) => b.text).join("\n"), /`facts` arrived as a string holding a JSON list/);
  } finally {
    s.dispose();
  }
});

test("AC1: a quoted list that holds no list (an object) is refused, naming the field", () => {
  assert.throws(
    () => prepareFinishArguments({ facts: JSON.stringify(GOOD_FACT) }),
    (error: Error) => error.message.startsWith(QUOTED_LIST_REFUSAL) && /`facts`/.test(error.message) && /not a list/.test(error.message),
  );
});

test("AC1: finish is registered with the shim pi calls before validation", async () => {
  const s = await openSession();
  try {
    assert.equal(typeof s.pi.tool("finish").prepareArguments, "function");
  } finally {
    s.dispose();
  }
});

// --- AC2: the rejected hand-back file -----------------------------------------

test("AC2: replaying the recorded payload leaves a labelled rejected hand-back and no answer", async () => {
  const s = await openSession();
  try {
    const { error } = await piCallsFinish(s.pi, "fin-1", structuredClone(RECORDED_ARGS));
    assert.ok(error?.startsWith(QUOTED_LIST_REFUSAL));
    const path = join(s.exportDir, REJECTED_HANDBACK_FILENAME);
    assert.match(REJECTED_HANDBACK_FILENAME, /rejected/);
    const rejected = readJson(path);
    assert.equal(rejected.label, REJECTED_LABEL);
    assert.equal(REJECTED_LABEL, "rejected");
    assert.equal(rejected.checked, false);
    assert.equal(rejected.stage, "quoted_list");
    assert.equal(rejected.payload.facts, RECORDED_ARGS.facts, "the payload is kept as the model sent it");
    assert.equal(rejected.payload.summary, RECORDED_ARGS.summary);
    assert.ok(String(rejected.error).startsWith(QUOTED_LIST_REFUSAL));
    assert.equal(rejected.rejections, 1);
    assert.equal(existsSync(join(s.exportDir, ANSWER_FILENAME)), false, "no answer.md presents it");
    assert.equal(existsSync(join(s.exportDir, FACTS_FILENAME)), false, "no facts.json was written for it");
  } finally {
    s.dispose();
  }
});

test("AC2: a call pi's own validation rejected is kept, with the payload pi quoted when no start event carried it", async () => {
  const s = await openSession();
  try {
    const recorded = `${FIXTURE.rejections[0].error_head}\n\nReceived arguments:\n${JSON.stringify(RECORDED_ARGS, null, 2)}`;
    await s.pi.fireToolExecutionEnd({
      toolCallId: "fin-v",
      toolName: "finish",
      result: { content: [{ type: "text", text: recorded }] },
      isError: true,
    });
    const rejected = readJson(join(s.exportDir, REJECTED_HANDBACK_FILENAME));
    assert.equal(rejected.label, "rejected");
    assert.equal(rejected.stage, "schema");
    assert.equal(rejected.payload_source, "error_text");
    assert.deepEqual(rejected.payload, RECORDED_ARGS);
    assert.equal(existsSync(join(s.exportDir, ANSWER_FILENAME)), false);
  } finally {
    s.dispose();
  }
});

test("AC2: a hand-back the check refuses in enforce mode is kept as rejected, the latest one kept", async () => {
  const s = await openSession({ [CHECK_MODE_ENV]: "enforce" });
  try {
    await piCallsFinish(s.pi, "fin-1", { summary: "first", facts: [GOOD_FACT, BAD_FACT] });
    const path = join(s.exportDir, REJECTED_HANDBACK_FILENAME);
    const first = readJson(path);
    assert.equal(first.label, "rejected");
    assert.equal(first.stage, "check");
    assert.equal(first.payload.summary, "first");
    assert.equal(first.refusals.length, 1);
    assert.equal(first.refusals[0].id, "f2");
    assert.equal(existsSync(join(s.exportDir, ANSWER_FILENAME)), false);

    await piCallsFinish(s.pi, "fin-2", { summary: "second", facts: [BAD_FACT] });
    const second = readJson(path);
    assert.equal(second.payload.summary, "second", "the latest rejected payload replaces the earlier one");
    assert.equal(second.rejections, 2);
    assert.equal(second.tool_call_id, "fin-2");
    assert.equal(existsSync(join(s.exportDir, ANSWER_FILENAME)), false);
  } finally {
    s.dispose();
  }
});

test("AC2: an accepted hand-back is never written as rejected", async () => {
  const s = await openSession();
  try {
    await piCallsFinish(s.pi, "fin-1", { summary: "ok", facts: [GOOD_FACT] });
    assert.equal(existsSync(join(s.exportDir, REJECTED_HANDBACK_FILENAME)), false);
  } finally {
    s.dispose();
  }
});

test("a rejected finish stays in the export after a later finish is accepted; check.json then says accepted", async () => {
  // What the Python harness relies on (associate/harness/pi.py): the file is the
  // latest REJECTED payload, kept as a record, and check.json's outcome tells a
  // reader that a later hand-back was accepted and the rejected one is superseded.
  const s = await openSession({ [CHECK_MODE_ENV]: "enforce" });
  try {
    await piCallsFinish(s.pi, "fin-1", { summary: "first", facts: [GOOD_FACT, BAD_FACT] });
    assert.equal(readJson(join(s.exportDir, CHECK_FILENAME)).outcome, "refused");
    await piCallsFinish(s.pi, "fin-2", { summary: "second", facts: [GOOD_FACT] });
    assert.equal(readJson(join(s.exportDir, CHECK_FILENAME)).outcome, "accepted");
    const rejected = readJson(join(s.exportDir, REJECTED_HANDBACK_FILENAME));
    assert.equal(rejected.payload.summary, "first");
    assert.equal(existsSync(join(s.exportDir, ANSWER_FILENAME)), true);
  } finally {
    s.dispose();
  }
});

// --- AC4: the purpose rule ------------------------------------------------------

test("AC4: the purpose rule still exempts finish, with or without a quoted list", async () => {
  const s = await openSession();
  try {
    const prepared = prepareFinishArguments({ summary: "s", facts: JSON.stringify([GOOD_FACT]) });
    const decision = (await s.pi.fireToolCall({ type: "tool_call", toolName: "finish", toolCallId: "p-1", input: prepared })) as any;
    assert.notEqual(decision?.block, true, JSON.stringify(decision));
  } finally {
    s.dispose();
  }
});
