/**
 * Issue #20, plan t9: every tool result the model sees is stamped with its
 * walk id (spec c29, honesty h22).
 *
 * pi 1.5.2 documents `tool_result` as "can modify the result": handlers chain
 * like middleware and "can return partial patches (`content`, …); omitted
 * fields keep their current values". So the probe is answered by returning a
 * patched `content` — and this file confirms it against the real `index.ts`
 * by driving the `tool_result` handlers the way pi does, chaining each
 * handler's patch into the event the next one sees and into the result the
 * model is sent.
 *
 * A refused call gets no `tool_result` (pi skips it); pi turns the hook's
 * `reason` into the result text the model receives (`createErrorToolResult`),
 * so the refusal reason carries the stamp.
 *
 * Approved deviation (operator, 2026-11-17): a call pi rejected before the
 * hook (unknown tool, invalid arguments) still gets `tool_execution_end`;
 * the recorder writes a walk entry for it from there, once.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtension, type FakePi } from "./load-extension.ts";
import { findRepoContractDir, loadContract } from "../lib/contract.ts";
import { checkQuote } from "../lib/matcher.ts";
import { loadSavedResult } from "../lib/results.ts";
import {
  WALK_ID_STAMP_PREFIX,
  WALK_ID_STAMP_PATTERN,
  stripWalkIdStamp,
  walkIdStampLine,
} from "../lib/walk.ts";

const CONTRACT = loadContract({});
const GATE = CONTRACT.gate as any;
const QUESTIONS: Record<string, any> = GATE.questions;
const TOOL_NAMES: string[] = CONTRACT.models.tool_names;
const PURPOSE = "stamp test: is the walk id on the result";
const PI_BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

// ------------------------------------------------------------ fake decider

function safeClefAnswers(): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const [key, q] of Object.entries(QUESTIONS)) {
    if (q.type === "noul") answers[key] = { type: "noul", noul: 0.5 };
    else {
      const probabilities: Record<string, number> = {};
      for (const option of Object.keys(q.criteria)) probabilities[option] = 0;
      answers[key] = { type: "choice", choice: Object.keys(q.criteria)[0], probabilities };
    }
  }
  for (const rule of GATE.clef.allow_when) {
    const target = rule.op === ">=" ? Math.min(1, rule.value + 0.05) : Math.max(0, rule.value - 0.05);
    const a = answers[rule.question] as any;
    if (rule.option) a.probabilities[rule.option] = target;
    else a.noul = target;
  }
  return answers;
}

function installDecider(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ model: "clef", answers: safeClefAnswers() }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  return () => (globalThis.fetch = original);
}

// --------------------------------------------------------------- fixtures

interface Session {
  pi: FakePi;
  exportDir: string;
  walkPath: string;
  cleanup(): void;
}

async function open(model: string, root: string, checkout: string, sessionId: string): Promise<Session> {
  const { pi, cleanup } = await loadExtension(
    {
      ASSOCIATE_EXPORT_ROOT: root,
      ASSOCIATE_CHECKOUT_ROOT: checkout,
      ASSOCIATE_SESSION_ID: sessionId,
      ASSOCIATE_MODEL: model,
      ASSOCIATE_API_KEY: "dummy-t9-key",
      ASSOCIATE_BASE_URL: "http://decider.invalid:9/v1",
      ASSOCIATE_CONTRACT_DIR: findRepoContractDir(),
      ASSOCIATE_TEST_COMMANDS: JSON.stringify([["true"]]),
      ASSOCIATE_ISOLATION: "worktree",
    },
    (fake) => {
      fake.builtinTools = [...PI_BUILTINS];
      fake.activeBuiltinTools = [...PI_BUILTINS];
    },
  );
  await pi.fireSessionStart();
  for (const handler of pi.handlers.get("before_agent_start") ?? []) {
    await handler({ type: "before_agent_start", prompt: "stamp every tool result", systemPrompt: "" }, {});
  }
  const exportDir = join(root, sessionId, "export");
  return { pi, exportDir, walkPath: join(exportDir, "walk.jsonl"), cleanup };
}

async function withSession(model: string, body: (s: Session) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "associate-t9-runs-"));
  const checkout = mkdtempSync(join(tmpdir(), "associate-t9-checkout-"));
  const restore = installDecider();
  const session = await open(model, root, checkout, `t9-${model}`);
  try {
    await body(session);
  } finally {
    restore();
    session.cleanup();
    rmSync(root, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
}

/**
 * Run every `tool_result` handler as pi 1.5.2 does: in load order, each
 * handler seeing the latest result, a returned patch replacing only the
 * fields it names. Returns the result the model is sent.
 */
async function fireChainedToolResult(pi: FakePi, event: Record<string, unknown>): Promise<Record<string, any>> {
  let current: Record<string, any> = { ...event };
  for (const handler of pi.handlers.get("tool_result") ?? []) {
    const patch = (await handler({ ...current })) as Record<string, unknown> | undefined;
    if (patch && typeof patch === "object") {
      for (const key of ["content", "details", "structuredContent", "isError", "usage"]) {
        if (key in patch) current[key] = patch[key];
      }
    }
  }
  return current;
}

/** The text the model receives, from a result's content blocks. */
function modelText(content: unknown): string {
  if (typeof content === "string") return content;
  return (content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

function entries(walkPath: string): any[] {
  if (!existsSync(walkPath)) return [];
  return readFileSync(walkPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((record) => typeof record?.id === "string" && record.id.startsWith("w"));
}

/** The registry model that holds `tool`; worker when it does. */
function modelHolding(tool: string): string {
  for (const key of ["worker", "cortex", "senses"]) {
    if (CONTRACT.models.models[key]!.tools.includes(tool)) return key;
  }
  throw new Error(`no active model holds ${tool}`);
}

/** An input the guard lets through for `tool` (plus a stated purpose). */
function inputFor(tool: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    read: { path: "README.md" },
    find: { pattern: "*.md" },
    grep: { pattern: "x" },
    ls: { path: "." },
    bash: { command: "echo hi" },
    code_lens: { path: "README.md" },
    web_search: { query: "pi coding agent" },
    web_page: { url: "https://example.com" },
    write: { path: "README.md", content: "x" },
    edit: { path: "README.md", edits: [] },
    eidetic_recall: { query: "x" },
    eidetic_remember: { text: "x" },
    ledger_append: { action: "a", summary: "s" },
    ledger_list: {},
    run_tests: {},
    spawn_subagent: { model: "senses", task: "look" },
    delegate_run: { model: "worker", task: "do" },
    delegate_status: { run_id: "r1" },
    associate_ready: {},
    check_quote: { source: "w1", quote: "a quote long enough to check" },
    finish: { summary: "done" },
  }[tool] as Record<string, unknown> | undefined;
  if (!base) throw new Error(`no test input for ${tool}; add one`);
  return CONTRACT.accuracy.purpose_exempt_tools.includes(tool) ? base : { ...base, purpose: PURPOSE };
}

// ------------------------------------------------------ the stamp line form

test("t9: the stamp line has one exported form, and strip undoes exactly it", () => {
  assert.equal(walkIdStampLine("w12"), `${WALK_ID_STAMP_PREFIX}w12`);
  assert.equal(walkIdStampLine("w12"), "walk id: w12");
  assert.ok(WALK_ID_STAMP_PATTERN.test("walk id: w12\nrest"));
  assert.equal(stripWalkIdStamp("walk id: w12\nthe result"), "the result");
  assert.equal(stripWalkIdStamp("walk id: w3"), "");
  // Only a leading stamp is a stamp; text that merely mentions one is kept.
  assert.equal(stripWalkIdStamp("the result\nwalk id: w12"), "the result\nwalk id: w12");
  assert.equal(stripWalkIdStamp("no stamp"), "no stamp");
});

// ------------------------- criterion 1 + 2: every tool name, through index.ts

for (const tool of TOOL_NAMES) {
  test(`t9 criterion 1/2: a ${tool} result reaches the model stamped with its own walk id`, async () => {
    await withSession(modelHolding(tool), async ({ pi, walkPath, exportDir }) => {
      // Two earlier calls, so the id under test is not w1 by luck.
      for (const n of [1, 2]) {
        const id = `pre-${n}`;
        const input = { path: "README.md", purpose: PURPOSE };
        assert.equal(await pi.fireToolCall({ type: "tool_call", toolName: "read", toolCallId: id, input }), undefined);
        await fireChainedToolResult(pi, { toolName: "read", toolCallId: id, input, content: [{ type: "text", text: `pre ${n}` }] });
      }
      const input = inputFor(tool);
      const decision = await pi.fireToolCall({ type: "tool_call", toolName: tool, toolCallId: "under-test", input });
      assert.equal(decision, undefined, `the guard refused ${tool}: ${(decision as any)?.reason}`);
      const body = `the ${tool} result\nsecond line`;
      const sent = await fireChainedToolResult(pi, {
        toolName: tool,
        toolCallId: "under-test",
        input,
        content: [{ type: "text", text: body }],
        details: { kept: true },
      });
      const last = entries(walkPath).at(-1);
      assert.equal(last.tool, tool);
      assert.equal(last.id, "w3");
      const text = modelText(sent.content);
      assert.equal(text.split("\n")[0], `walk id: ${last.id}`, "the first line is the stamp");
      assert.equal(text, `walk id: ${last.id}\n${body}`, "exactly one harness line, the rest unchanged");
      assert.deepEqual(sent.details, { kept: true }, "details are left as the tool returned them");
      // criterion 3: what was saved and what the matcher reads carry no stamp.
      assert.equal(loadSavedResult(exportDir, last.id), body);
      assert.equal(last.result.content, body);
    });
  });
}

// ------------------------------------------------------------- criterion 2

test("t9 criterion 2: a refused call's reason carries the id of the entry written for it, and the next result does not reuse it", async () => {
  await withSession("worker", async ({ pi, walkPath }) => {
    const ok = { path: "README.md", purpose: PURPOSE };
    await pi.fireToolCall({ type: "tool_call", toolName: "read", toolCallId: "a", input: ok });
    await fireChainedToolResult(pi, { toolName: "read", toolCallId: "a", input: ok, content: "one" });

    // No purpose: refused in the hook, recorded at refusal.
    const refused = (await pi.fireToolCall({
      type: "tool_call",
      toolName: "read",
      toolCallId: "b",
      input: { path: "README.md" },
    })) as { block: boolean; reason: string };
    assert.ok(refused?.block);
    const refusedEntry = entries(walkPath).at(-1);
    assert.equal(refusedEntry.id, "w2");
    assert.equal(refused.reason.split("\n")[0], "walk id: w2");
    // The entry's error is the reason without the stamp line.
    assert.equal(refusedEntry.error, `refused: ${stripWalkIdStamp(refused.reason)}`);
    assert.doesNotMatch(refusedEntry.error, /walk id:/);

    await pi.fireToolCall({ type: "tool_call", toolName: "read", toolCallId: "c", input: ok });
    const sent = await fireChainedToolResult(pi, { toolName: "read", toolCallId: "c", input: ok, content: "three" });
    assert.equal(modelText(sent.content), "walk id: w3\nthree");
    assert.equal(entries(walkPath).at(-1).id, "w3");
  });
});

test("t9 criterion 2: a call refused after finish carries its entry id too", async () => {
  await withSession("worker", async ({ pi, walkPath }) => {
    const finishInput = { summary: "done" };
    await pi.fireToolCall({ type: "tool_call", toolName: "finish", toolCallId: "f", input: finishInput });
    const result = await pi.tool("finish").execute("f", finishInput);
    const sent = await fireChainedToolResult(pi, { toolName: "finish", toolCallId: "f", input: finishInput, ...result });
    assert.equal(modelText(sent.content).split("\n")[0], "walk id: w1");
    const after = (await pi.fireToolCall({
      type: "tool_call",
      toolName: "read",
      toolCallId: "late",
      input: { path: "README.md", purpose: PURPOSE },
    })) as { block: boolean; reason: string };
    assert.ok(after.block);
    assert.equal(after.reason.split("\n")[0], "walk id: w2");
    assert.equal(entries(walkPath).at(-1).id, "w2");
  });
});

test("t9 criterion 2: across a recorder re-open the stamp continues from the ids already on disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "associate-t9-reopen-"));
  const checkout = mkdtempSync(join(tmpdir(), "associate-t9-reopen-co-"));
  const restore = installDecider();
  const input = { path: "README.md", purpose: PURPOSE };
  try {
    const first = await open("worker", root, checkout, "t9-reopen");
    for (const id of ["a", "b"]) {
      await first.pi.fireToolCall({ type: "tool_call", toolName: "read", toolCallId: id, input });
      await fireChainedToolResult(first.pi, { toolName: "read", toolCallId: id, input, content: id });
    }
    first.cleanup();

    const second = await open("worker", root, checkout, "t9-reopen");
    try {
      await second.pi.fireToolCall({ type: "tool_call", toolName: "read", toolCallId: "c", input });
      const sent = await fireChainedToolResult(second.pi, { toolName: "read", toolCallId: "c", input, content: "again" });
      const last = entries(second.walkPath).at(-1);
      assert.equal(last.id, "w3");
      assert.equal(modelText(sent.content), "walk id: w3\nagain");
      const refused = (await second.pi.fireToolCall({
        type: "tool_call",
        toolName: "read",
        toolCallId: "d",
        input: { path: "README.md" },
      })) as { reason: string };
      assert.equal(refused.reason.split("\n")[0], "walk id: w4");
      assert.equal(entries(second.walkPath).at(-1).id, "w4");
    } finally {
      second.cleanup();
    }
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- criterion 3

test("t9 criterion 3: the saved result and the matcher see the text without the stamp line", async () => {
  await withSession("worker", async ({ pi, exportDir, walkPath }) => {
    const input = { path: "README.md", purpose: PURPOSE };
    await pi.fireToolCall({ type: "tool_call", toolName: "read", toolCallId: "r", input });
    const body = "1\tfirst line of the file\n2\tsecond line of the file";
    const sent = await fireChainedToolResult(pi, { toolName: "read", toolCallId: "r", input, content: [{ type: "text", text: body }] });
    assert.match(modelText(sent.content), /^walk id: w1\n/);
    const saved = loadSavedResult(exportDir, "w1");
    assert.equal(saved, body);
    const minimum = CONTRACT.accuracy.min_quote_length as number;
    assert.equal(checkQuote("walk id: w1", null, saved, minimum).verdict, "refused");
    assert.equal(checkQuote("first line of the file", null, saved, minimum).verdict, "passed");
    const entry = entries(walkPath)[0];
    assert.equal(entry.result.content, body);
    assert.equal(entry.result.sha256 !== undefined, true);
  });
});

test("t9 criterion 3: a stamped result keeps image blocks and structured content", async () => {
  await withSession("worker", async ({ pi }) => {
    const input = { path: "a.png", purpose: PURPOSE };
    await pi.fireToolCall({ type: "tool_call", toolName: "read", toolCallId: "img", input });
    const image = { type: "image", data: "AAAA", mimeType: "image/png" };
    const sent = await fireChainedToolResult(pi, {
      toolName: "read",
      toolCallId: "img",
      input,
      content: [image],
      structuredContent: { k: 1 },
    });
    assert.deepEqual(sent.content[0], { type: "text", text: "walk id: w1" });
    assert.deepEqual(sent.content[1], image);
    assert.deepEqual(sent.structuredContent, { k: 1 });
  });
});

// ------------------------------------- approved deviation: calls pi rejected

test("t9 deviation: an unknown-tool call pi rejected before the hook gets one walk entry from tool_execution_end", async () => {
  await withSession("worker", async ({ pi, walkPath }) => {
    await pi.fireToolExecutionEnd({
      toolCallId: "unknown-1",
      toolName: "no_such_tool",
      result: { content: [{ type: "text", text: "Tool no_such_tool not found" }], details: {} },
      isError: true,
    });
    const all = entries(walkPath);
    assert.equal(all.length, 1);
    assert.equal(all[0].id, "w1");
    assert.equal(all[0].tool, "no_such_tool");
    assert.equal(all[0].error, "Tool no_such_tool not found");
    assert.deepEqual(all[0].args, {});
    assert.equal(all[0].saved_result, undefined);
  });
});

test("t9 deviation: an invalid-arguments call is recorded with its arguments when the event carries them", async () => {
  await withSession("worker", async ({ pi, walkPath }) => {
    await pi.fireToolExecutionEnd({
      toolCallId: "invalid-1",
      toolName: "read",
      args: { path: 5 },
      result: {
        content: [{ type: "text", text: 'Validation failed for tool "read": path: must be string' }],
        details: {},
      },
      isError: true,
    });
    const all = entries(walkPath);
    assert.equal(all.length, 1);
    assert.equal(all[0].tool, "read");
    assert.deepEqual(all[0].args, { path: 5 });
    assert.equal(all[0].error, 'Validation failed for tool "read": path: must be string');
    assert.equal(all[0].saved_result, undefined);
    // The next recorded call takes the next id.
    const input = { path: "README.md", purpose: PURPOSE };
    await pi.fireToolCall({ type: "tool_call", toolName: "read", toolCallId: "next", input });
    const sent = await fireChainedToolResult(pi, { toolName: "read", toolCallId: "next", input, content: "ok" });
    assert.equal(modelText(sent.content), "walk id: w2\nok");
  });
});

test("t9 deviation: a normally recorded call and a refused call are not written twice by tool_execution_end", async () => {
  await withSession("worker", async ({ pi, walkPath }) => {
    const input = { path: "README.md", purpose: PURPOSE };
    await pi.fireToolCall({ type: "tool_call", toolName: "read", toolCallId: "ran", input });
    const sent = await fireChainedToolResult(pi, { toolName: "read", toolCallId: "ran", input, content: "body" });
    await pi.fireToolExecutionEnd({ toolCallId: "ran", toolName: "read", result: { content: sent.content }, isError: false });

    const refused = (await pi.fireToolCall({
      type: "tool_call",
      toolName: "read",
      toolCallId: "no-purpose",
      input: { path: "README.md" },
    })) as { reason: string };
    await pi.fireToolExecutionEnd({
      toolCallId: "no-purpose",
      toolName: "read",
      result: { content: [{ type: "text", text: refused.reason }] },
      isError: true,
    });
    const all = entries(walkPath);
    assert.deepEqual(
      all.map((entry) => entry.id),
      ["w1", "w2"],
    );
  });
});
