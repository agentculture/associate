// Tests for the `check_quote` tool (issue #20, plan t12; spec c13/h11).
//
// The tool reads the saved result of a current-run walk id and returns the
// matcher's verdict. It is driven directly through `register()` against a fake
// pi, with saved results written by `lib/results.ts` exactly as the walk
// recorder writes them.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssociateContext } from "../lib/runtime.ts";
import { loadContract } from "../lib/contract.ts";
import { checkQuote } from "../lib/matcher.ts";
import { loadSavedResult, saveResult } from "../lib/results.ts";
import { decideToolCall, evaluateToolCall } from "../lib/guard.ts";
import { isMutatingCall, resolveActiveModel } from "../lib/toolset.ts";
import { CHECK_TOOL_NAME, checkSource, register } from "../tools/check.ts";
import type { AssociateContext } from "../lib/context.ts";

interface RegisteredTool {
  name: string;
  parameters: Record<string, any>;
  execute: (id: string, params: unknown) => Promise<{ content: Array<{ type: string; text: string }>; details: any }>;
}

class FakePi {
  tools: RegisteredTool[] = [];
  registerTool(definition: RegisteredTool): void {
    this.tools.push(definition);
  }
}

const CONTRACT = loadContract({});
const MIN = CONTRACT.accuracy.min_quote_length;
const SAVED = "1\texport function alpha() {\n2\t  return computeTheAnswer(42);\n3\t}\n";

async function rig() {
  const root = mkdtempSync(join(tmpdir(), "associate-check-"));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  const ctx: AssociateContext = createAssociateContext({
    checkoutRoot: checkout,
    contract: CONTRACT,
    env: { ASSOCIATE_EXPORT_ROOT: join(root, "runs"), ASSOCIATE_SESSION_ID: "t12-check" },
  });
  saveResult(ctx.session.exportDir, "w3", SAVED, 0);
  const pi = new FakePi();
  await register(pi, ctx);
  const tool = pi.tools.find((t) => t.name === CHECK_TOOL_NAME)!;
  return { root, ctx, checkout, tool, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("a quote found in the saved result of a current-run id is passed", async () => {
  const r = await rig();
  try {
    const out = await r.tool.execute("c1", { source: "w3", quote: "return computeTheAnswer(42);", purpose: "p" });
    assert.equal(out.details.verdict, "passed");
    assert.equal(out.details.reason, null);
    assert.deepEqual(JSON.parse(out.content[0]!.text).verdict, "passed");
  } finally {
    r.dispose();
  }
});

test("a quote that is not in the saved result is refused with the nearest span", async () => {
  const r = await rig();
  try {
    const out = await r.tool.execute("c2", { source: "w3", quote: "return computeTheQuestion(42);" });
    assert.equal(out.details.verdict, "refused");
    assert.equal(out.details.reason, "quote_absent");
    assert.ok(out.details.nearest.matched > 0);
    assert.match(out.details.nearest.text, /computeThe/);
  } finally {
    r.dispose();
  }
});

test("a quote shorter than min_quote_length is refused, the limit coming from the contract", async () => {
  const r = await rig();
  try {
    const out = await r.tool.execute("c3", { source: "w3", quote: "alpha" });
    assert.ok("alpha".length < MIN);
    assert.equal(out.details.verdict, "refused");
    assert.equal(out.details.reason, "quote_short");
  } finally {
    r.dispose();
  }
});

test("a walk id with no saved result is unchecked", async () => {
  const r = await rig();
  try {
    const out = await r.tool.execute("c4", { source: "w9", quote: "return computeTheAnswer(42);" });
    assert.equal(out.details.verdict, "unchecked");
    assert.equal(out.details.reason, "no_saved_text");
  } finally {
    r.dispose();
  }
});

test("a prior: reference is checked against the --continue-from run's saved result, never this run's", async () => {
  const root = mkdtempSync(join(tmpdir(), "associate-check-prior-"));
  try {
    const priorExport = join(root, "prior", "export");
    mkdirSync(priorExport, { recursive: true });
    writeFileSync(join(priorExport, "walk.jsonl"), `${JSON.stringify({ id: "w3", ts: "t", tool: "read", args: {}, result: {}, truncated: false })}\n`);
    saveResult(priorExport, "w3", "1\tthe prior run read this line only\n", 0);
    const checkout = join(root, "checkout");
    mkdirSync(checkout);
    const ctx: AssociateContext = createAssociateContext({
      checkoutRoot: checkout,
      contract: CONTRACT,
      env: { ASSOCIATE_EXPORT_ROOT: join(root, "runs"), ASSOCIATE_SESSION_ID: "t12-prior" },
    });
    saveResult(ctx.session.exportDir, "w3", SAVED, 0); // the current run's w3 holds different text
    const pi = new FakePi();
    await register(pi, ctx, { ASSOCIATE_CONTINUE_FROM: priorExport });
    const tool = pi.tools.find((t) => t.name === CHECK_TOOL_NAME)!;

    const fromPrior = await tool.execute("p1", { source: "prior:w3", quote: "the prior run read this line only" });
    assert.equal(fromPrior.details.verdict, "passed");
    assert.equal(fromPrior.details.source, "prior:w3");
    const notInPrior = await tool.execute("p2", { source: "prior:w3", quote: "return computeTheAnswer(42);" });
    assert.equal(notInPrior.details.verdict, "refused", "the current run's w3 must not answer for prior:w3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a label this session does not know is refused with the fix; a malformed source is an argument error", async () => {
  const r = await rig();
  try {
    const labelled = await r.tool.execute("c5", { source: "run-3:w3", quote: "return computeTheAnswer(42);" });
    assert.equal(labelled.details.ok, false);
    assert.equal(labelled.details.code, "source_not_resolvable");
    assert.match(labelled.details.message, /unknown run label/);
    const noPrior = await r.tool.execute("c5b", { source: "prior:w3", quote: "return computeTheAnswer(42);" });
    assert.equal(noPrior.details.code, "source_not_resolvable");
    assert.match(noPrior.details.message, /not started with --continue-from/);
    for (const bad of ["../w3", "/etc/passwd", "w0", "w3.txt", "", "w3\n"]) {
      const out = await r.tool.execute("c6", { source: bad, quote: "return computeTheAnswer(42);" });
      assert.equal(out.details.ok, false, JSON.stringify(bad));
      assert.equal(out.details.code, "invalid_source", JSON.stringify(bad));
    }
    const missing = await r.tool.execute("c7", { source: "w3" });
    assert.equal(missing.details.ok, false);
  } finally {
    r.dispose();
  }
});

test("the optional literal is checked against the quote, as the matcher does", async () => {
  const r = await rig();
  try {
    const ok = await r.tool.execute("c8", { source: "w3", quote: "return computeTheAnswer(42);", literal: "42" });
    assert.equal(ok.details.verdict, "passed");
    const bad = await r.tool.execute("c9", { source: "w3", quote: "return computeTheAnswer(42);", literal: "43" });
    assert.equal(bad.details.verdict, "refused");
    assert.equal(bad.details.reason, "literal_not_in_quote");
  } finally {
    r.dispose();
  }
});

test("the tool and the matcher call return the same verdict for the same inputs", async () => {
  const r = await rig();
  try {
    const cases: Array<[string, string, string | undefined]> = [
      ["w3", "return computeTheAnswer(42);", undefined],
      ["w3", "return computeTheAnswer(42);", "42"],
      ["w3", "return computeTheAnswer(42);", "43"],
      ["w3", "return computeTheQuestion(42);", undefined],
      ["w3", "alpha", undefined],
      ["w3", "  RETURN computeTheAnswer(42);  ", undefined],
      ["w9", "return computeTheAnswer(42);", undefined],
    ];
    for (const [source, quote, literal] of cases) {
      const viaTool = await r.tool.execute("cx", { source, quote, ...(literal !== undefined ? { literal } : {}) });
      // What a hand-back check does for one fact: load the saved result of the
      // cited id, then call the matcher with the contract's minimum length.
      const direct = checkQuote(quote, literal, loadSavedResult(r.ctx.session.exportDir, source), MIN);
      assert.equal(viaTool.details.verdict, direct.verdict, `${source} ${quote}`);
      assert.equal(viaTool.details.reason, direct.reason, `${source} ${quote}`);
      assert.deepEqual(viaTool.details.nearest, direct.nearest, `${source} ${quote}`);
      // And the exported function the tool runs gives the same answer.
      assert.deepEqual(checkSource(r.ctx.session.exportDir, source, quote, literal, MIN), direct);
    }
  } finally {
    r.dispose();
  }
});

test("the tool never opens a path from its arguments: a path-shaped source reads nothing", async () => {
  const r = await rig();
  try {
    const secret = join(r.root, "secret.txt");
    writeFileSync(secret, "the secret file holds this sentence");
    for (const source of [secret, "../../secret.txt", "results/w3.txt", `file://${secret}`]) {
      const out = await r.tool.execute("cp", { source, quote: "the secret file holds this sentence" });
      assert.equal(out.details.ok, false, source);
      assert.equal(out.details.code, "invalid_source", source);
    }
    const src = readFileSync(new URL("../tools/check.ts", import.meta.url), "utf8");
    for (const banned of ["readFileSync", "readFile(", "openSync", "createReadStream", "node:child_process"]) {
      assert.ok(!src.includes(banned), `check.ts uses ${banned}`);
    }
  } finally {
    r.dispose();
  }
});

test("the schema declares purpose as an optional string and requires only source (quote or at is checked by the tool)", async () => {
  const r = await rig();
  try {
    const schema = r.tool.parameters;
    assert.equal(schema.properties.purpose.type, "string");
    assert.deepEqual([...schema.required].sort(), ["source"]);
    assert.equal(schema.properties.at.type, "object");
  } finally {
    r.dispose();
  }
});

test("the guard treats check_quote as a pure read for every active model", async () => {
  const registry = CONTRACT.models;
  assert.ok(registry.tool_names.includes(CHECK_TOOL_NAME));
  assert.equal(registry.mutating_tools.includes(CHECK_TOOL_NAME), false);
  assert.equal((registry.gated_tools ?? []).includes(CHECK_TOOL_NAME), false);
  assert.equal(isMutatingCall(CHECK_TOOL_NAME, { source: "w1", quote: "x" }, registry, CONTRACT.policy), false);
  for (const [key, entry] of Object.entries(registry.models)) {
    if (entry.status !== "active") continue;
    assert.ok(entry.tools.includes(CHECK_TOOL_NAME), `${key} lacks ${CHECK_TOOL_NAME}`);
    const model = resolveActiveModel({ ASSOCIATE_MODEL: key }, registry);
    const decision = await decideToolCall({
      toolName: CHECK_TOOL_NAME,
      input: { source: "w1", quote: "some quoted text", purpose: "check a fact" },
      model,
      registry,
      policy: CONTRACT.policy,
      // A gate that fails the test if it is asked: a pure read never reaches it.
      gate: {
        config: {} as any,
        evaluate: async () => {
          throw new Error("the gate was asked about a pure read");
        },
      },
      task: "t",
      scratchDir: "/nonexistent/scratch",
      cwd: "/nonexistent/cwd",
      recordGate: () => assert.fail("a pure read recorded a gate entry"),
      purposeExemptTools: CONTRACT.accuracy.purpose_exempt_tools,
    });
    assert.equal(decision, undefined, `${key}: ${JSON.stringify(decision)}`);
  }
  assert.equal(evaluateToolCall({ toolName: CHECK_TOOL_NAME, input: { source: "w1", quote: "q" }, scratchDir: "/s", cwd: "/c" }), undefined);
});

// ------------------------------------------------ the pointer form (strict facts, plan t8)

/** Write a walk with the given entries beside the rig's saved results. */
function writeWalk(exportDir: string, entries: Array<Record<string, unknown>>): void {
  const lines = entries.map((e) => JSON.stringify({ ts: "t", result: {}, truncated: false, ...e }));
  writeFileSync(join(exportDir, "walk.jsonl"), `${lines.join("\n")}\n`);
}

async function pointerRig() {
  const r = await rig();
  writeWalk(r.ctx.session.exportDir, [
    { id: "w3", tool: "read", args: { path: "a.ts" }, args_used: { path: "a.ts" }, saved_result: "results/w3.txt", partial: false },
    { id: "w4", tool: "bash", args_used: { argv: ["wc", "-l", "README.md"] }, saved_result: "results/w4.txt", partial: false },
  ]);
  saveResult(r.ctx.session.exportDir, "w4", '{"ok":true,"exit_code":0,"stdout":"412 README.md\\n"}\n', 0);
  return r;
}

test("pointer form: lines return the copied quote, the command, the result file and the line numbers", async () => {
  const r = await pointerRig();
  try {
    const out = await r.tool.execute("p1", { source: "w3", at: { lines: [2, 3] }, purpose: "p" });
    assert.equal(out.details.ok, true);
    assert.equal(out.details.quote, "2\t  return computeTheAnswer(42);\n3\t}");
    assert.equal(out.details.command, "read a.ts");
    assert.equal(out.details.result_file, "results/w3.txt");
    assert.deepEqual(out.details.lines, [2, 3]);
    assert.equal(out.details.source, "w3");
    assert.deepEqual(JSON.parse(out.content[0]!.text).quote, out.details.quote);
  } finally {
    r.dispose();
  }
});

test("pointer form: search copies the first line holding the term, and a given value is number-checked", async () => {
  const r = await pointerRig();
  try {
    const ok = await r.tool.execute("p2", { source: "w4", at: { search: "412 README.md" }, value: "README.md has 412 lines" });
    assert.equal(ok.details.ok, true);
    assert.equal(ok.details.command, "wc -l README.md");
    assert.deepEqual(ok.details.lines, [1, 1]);
    assert.match(ok.details.quote, /412 README\.md/);
    const bad = await r.tool.execute("p3", { source: "w4", at: { search: "412 README.md" }, value: "README.md has 413 lines" });
    assert.equal(bad.details.ok, false);
    assert.equal(bad.details.reason, "number_absent");
    assert.ok(bad.details.fix.length > 0);
  } finally {
    r.dispose();
  }
});

test("pointer form: a failed pointer gives the reason and the fix", async () => {
  const r = await pointerRig();
  try {
    const past = await r.tool.execute("p4", { source: "w3", at: { lines: [10, 12] } });
    assert.equal(past.details.ok, false);
    assert.equal(past.details.reason, "pointer_out_of_range");
    assert.ok(past.details.message.length > 0 && past.details.fix.length > 0);
    const absent = await r.tool.execute("p5", { source: "w3", at: { search: "no such term" } });
    assert.equal(absent.details.reason, "search_not_found");
    const unknown = await r.tool.execute("p6", { source: "w8", at: { lines: [1, 1] } });
    assert.equal(unknown.details.reason, "source_unknown");
    const noWalk = await r.tool.execute("p7", { source: "w3", at: {} });
    assert.equal(noWalk.details.ok, false);
  } finally {
    r.dispose();
  }
});

test("pointer form: a path-shaped source is refused, a label is looked up, and quote with at is refused", async () => {
  const r = await pointerRig();
  try {
    const path = await r.tool.execute("p8", { source: "../w3", at: { lines: [1, 1] } });
    assert.equal(path.details.code, "invalid_source");
    const label = await r.tool.execute("p9", { source: "prior:w3", at: { lines: [1, 1] } });
    assert.equal(label.details.code, "source_not_resolvable");
    const both = await r.tool.execute("p10", { source: "w3", at: { lines: [1, 1] }, quote: "return computeTheAnswer(42);" });
    assert.equal(both.details.ok, false);
    assert.equal(both.details.code, "quote_and_at");
  } finally {
    r.dispose();
  }
});

test("pointer form: a prior: source is resolved in the --continue-from run", async () => {
  const root = mkdtempSync(join(tmpdir(), "associate-check-prior-at-"));
  try {
    const priorExport = join(root, "prior", "export");
    mkdirSync(priorExport, { recursive: true });
    writeWalk(priorExport, [{ id: "w3", tool: "read", args_used: { path: "p.ts" }, saved_result: "results/w3.txt", partial: false }]);
    saveResult(priorExport, "w3", "1\tthe prior run read this line only\n", 0);
    const checkout = join(root, "checkout");
    mkdirSync(checkout);
    const ctx = createAssociateContext({
      checkoutRoot: checkout,
      contract: CONTRACT,
      env: { ASSOCIATE_EXPORT_ROOT: join(root, "runs"), ASSOCIATE_SESSION_ID: "t8-prior" },
    });
    const pi = new FakePi();
    await register(pi, ctx, { ASSOCIATE_CONTINUE_FROM: priorExport });
    const tool = pi.tools.find((t) => t.name === CHECK_TOOL_NAME)!;
    const out = await tool.execute("q1", { source: "prior:w3", at: { lines: [1, 1] } });
    assert.equal(out.details.ok, true);
    assert.equal(out.details.run, "prior");
    assert.match(out.details.quote, /prior run read this line only/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pointer form: the quote form is unchanged and neither form given is an argument error", async () => {
  const r = await pointerRig();
  try {
    const q = await r.tool.execute("p11", { source: "w3", quote: "return computeTheAnswer(42);" });
    assert.equal(q.details.verdict, "passed");
    const none = await r.tool.execute("p12", { source: "w3" });
    assert.equal(none.details.ok, false);
    assert.equal(none.details.code, "quote_or_at");
  } finally {
    r.dispose();
  }
});
