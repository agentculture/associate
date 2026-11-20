/**
 * Resolving a fact's pointer and copying its evidence by code (strict facts,
 * plan task t2; spec claims c8, c9, c14, c32, c33, c34, c41).
 *
 * Every case builds a walk entry and a saved result in memory and hands them to
 * `resolveEvidence` through its context; nothing here starts a model or a tool.
 */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadContract } from "../lib/contract.ts";
import { compileRedaction } from "../lib/walk.ts";
import { extensionDir } from "../lib/paths.ts";
import {
  EVIDENCE_REASONS,
  NOT_CHECKABLE_TEXT,
  missingNumbers,
  numberTokens,
  renderCommand,
  resolveEvidence,
  runFromData,
  type EvidenceContext,
  type EvidenceRun,
  type EvidenceResult,
} from "../lib/evidence.ts";

const contract = loadContract({});
const redact = compileRedaction(contract.policy).apply;
const sourceKinds = contract.accuracy.source_kinds;

const ROOT = "/home/someone/git/associate";
const RUN_WORKTREE = "/home/someone/git/.worktrees.associate/run-abc123";

interface Call {
  id: string;
  tool: string;
  args?: Record<string, unknown>;
  args_used?: Record<string, unknown>;
  text?: string;
  partial?: boolean;
}

/** A run made of walk entries and their saved results, the way the recorder writes them. */
function run(calls: Call[]): EvidenceRun {
  const entries = calls.map((c) => ({
    id: c.id,
    ts: "2026-11-20T00:00:00.000Z",
    tool: c.tool,
    args: c.args ?? c.args_used ?? {},
    ...(c.args_used ? { args_used: c.args_used } : {}),
    result: {},
    partial: c.partial ?? c.text === undefined,
    truncated: false,
    ...(c.text !== undefined ? { saved_result: `results/${c.id}.txt` } : {}),
  }));
  const results: Record<string, string> = {};
  for (const c of calls) if (c.text !== undefined) results[c.id] = c.text;
  return runFromData({ entries, results });
}

function ctx(calls: Call[], labelled: Record<string, EvidenceRun> = {}, root = ROOT): EvidenceContext {
  const current = run(calls);
  return {
    ...current,
    checkoutRoot: root,
    redact,
    sourceKinds,
    labelled: (label) => (Object.hasOwn(labelled, label) ? labelled[label] : undefined),
  };
}

function ok(result: EvidenceResult) {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`);
  return result as Extract<EvidenceResult, { ok: true }>;
}

function fail(result: EvidenceResult) {
  assert.equal(result.ok, false, `expected a failure, got ${JSON.stringify(result)}`);
  return result as Extract<EvidenceResult, { ok: false }>;
}

const LS_TEXT = "alpha.ts\nbeta.ts\ngamma.ts\ndelta.ts\n";

// --- copying -----------------------------------------------------------------

test("a lines pointer copies those lines, the command from args_used and the result file", () => {
  const c = ctx([{ id: "w1", tool: "ls", args_used: { path: "lib" }, text: LS_TEXT }]);
  const r = ok(resolveEvidence({ source: "w1", at: { lines: [2, 3] }, value: "beta.ts and gamma.ts are in lib" }, c));
  assert.equal(r.quote, "beta.ts\ngamma.ts");
  assert.equal(r.command, "ls path=lib");
  assert.equal(r.command_from, "args_used");
  assert.equal(r.result_file, "results/w1.txt");
  assert.equal(r.value, "beta.ts and gamma.ts are in lib");
  assert.equal(r.value_from, "fact");
  assert.deepEqual(r.lines, [2, 3]);
  assert.equal(r.source_kind, "tool");
  assert.equal(r.run, null);
});

test("lines are counted in the saved file: line 1 is the first line under the walk id line", () => {
  // The model sees "walk id: w1\nalpha.ts\n…"; the saved file holds no stamp.
  const c = ctx([{ id: "w1", tool: "ls", args_used: { path: "lib" }, text: LS_TEXT }]);
  assert.equal(ok(resolveEvidence({ source: "w1", at: { lines: [1, 1] } }, c)).quote, "alpha.ts");
  assert.equal(ok(resolveEvidence({ source: "w1", at: { lines: [4, 4] } }, c)).quote, "delta.ts");
  // The trailing newline does not make a fifth line.
  assert.equal(fail(resolveEvidence({ source: "w1", at: { lines: [5, 5] } }, c)).reason, "pointer_out_of_range");
});

test("a direct fact with no value takes the copied text as its value", () => {
  const c = ctx([{ id: "w1", tool: "ls", args_used: { path: "lib" }, text: LS_TEXT }]);
  const r = ok(resolveEvidence({ source: "w1", at: { lines: [3, 3] } }, c));
  assert.equal(r.value, "gamma.ts");
  assert.equal(r.value_from, "result");
  // Absent kind reads as direct; an explicit direct kind behaves the same.
  assert.equal(ok(resolveEvidence({ source: "w1", kind: "direct", at: { lines: [3, 3] } }, c)).value, "gamma.ts");
  // An llm or derived fact never borrows the result as its claim.
  assert.equal(ok(resolveEvidence({ source: "w1", kind: "llm", at: { lines: [3, 3] } }, c)).value, null);
});

test("a search pointer copies the first line that contains the term, and nothing else", () => {
  const c = ctx([{ id: "w1", tool: "ls", args_used: { path: "lib" }, text: "a.ts\nbeta.ts\nbeta2.ts\n" }]);
  const r = ok(resolveEvidence({ source: "w1", at: { search: "beta" } }, c));
  assert.equal(r.quote, "beta.ts");
  assert.deepEqual(r.lines, [2, 2]);
});

test("a read result is pointed at by the line numbers the model was shown", () => {
  const text = "3400\tconst a = 1;\n3401\tconst b = 2;\n3402\tconst c = 3;";
  const c = ctx([
    { id: "w1", tool: "read", args_used: { path: "lib/big.ts", start_line: 3400, end_line: 3402 }, text },
  ]);
  const r = ok(resolveEvidence({ source: "w1", at: { lines: [3401, 3402] } }, c));
  // Copied byte for byte, line stamps included.
  assert.equal(r.quote, "3401\tconst b = 2;\n3402\tconst c = 3;");
  assert.equal(r.command, "read lib/big.ts lines 3400-3402");
  assert.equal(r.source_kind, "file");
  // A search in a read result reports the shown line number too.
  assert.deepEqual(ok(resolveEvidence({ source: "w1", at: { search: "const c" } }, c)).lines, [3402, 3402]);
  // Positions within the result are not what the model saw for a read from line 3400.
  const miss = fail(resolveEvidence({ source: "w1", at: { lines: [1, 2] } }, c));
  assert.equal(miss.reason, "pointer_out_of_range");
  assert.match(miss.fix, /line numbers shown/);
});

// --- named failures ----------------------------------------------------------

test("a pointer past the end of the result fails as pointer_out_of_range, with the fix", () => {
  const c = ctx([{ id: "w1", tool: "ls", args_used: { path: "lib" }, text: LS_TEXT }]);
  const r = fail(resolveEvidence({ source: "w1", at: { lines: [3, 9] } }, c));
  assert.equal(r.reason, "pointer_out_of_range");
  assert.match(r.message, /4 lines/);
  assert.ok(r.fix.length > 0);
});

test("a search term not in the result fails as search_not_found, with the fix", () => {
  const c = ctx([{ id: "w1", tool: "ls", args_used: { path: "lib" }, text: LS_TEXT }]);
  const r = fail(resolveEvidence({ source: "w1", at: { search: "epsilon" } }, c));
  assert.equal(r.reason, "search_not_found");
  assert.ok(r.fix.length > 0);
});

test("a malformed or missing pointer, an unknown or malformed source, a call with no saved result", () => {
  const c = ctx([
    { id: "w1", tool: "ls", args_used: { path: "lib" }, text: LS_TEXT },
    { id: "w2", tool: "bash", args_used: { argv: ["git", "status"] } },
  ]);
  assert.equal(fail(resolveEvidence({ source: "w1" }, c)).reason, "pointer_missing");
  // An empty at is a pointer that names neither lines nor search: malformed, with its own message and fix.
  const empty = fail(resolveEvidence({ source: "w1", at: {} }, c));
  assert.equal(empty.reason, "pointer_malformed");
  assert.equal(empty.message, "the pointer {} is not valid");
  assert.match(empty.fix, /exactly one of at\.lines/);
  assert.equal(empty.run, null);
  for (const at of [{}, { lines: [3, 2] }, { lines: [0, 1] }, { lines: [1] }, { lines: [1, 2], search: "x" }, { search: " " }]) {
    assert.equal(fail(resolveEvidence({ source: "w1", at }, c)).reason, "pointer_malformed", JSON.stringify(at));
  }
  assert.equal(fail(resolveEvidence({ source: "w9", at: { lines: [1, 1] } }, c)).reason, "source_unknown");
  assert.equal(fail(resolveEvidence({ source: "lib/a.ts", at: { lines: [1, 1] } }, c)).reason, "source_malformed");
  assert.equal(fail(resolveEvidence({ source: "w2", at: { lines: [1, 1] } }, c)).reason, "no_saved_result");
});

test("every failure reason is one of the exported names and carries a message and a fix", () => {
  const c = ctx([{ id: "w1", tool: "ls", args_used: { path: "lib" }, text: LS_TEXT }]);
  const r = fail(resolveEvidence({ source: "w1", at: { search: "nothing here" } }, c));
  assert.ok((EVIDENCE_REASONS as readonly string[]).includes(r.reason));
  assert.equal(typeof r.message, "string");
  assert.equal(typeof r.fix, "string");
});

// --- numbers -----------------------------------------------------------------

test("a number in the value must be in the copied evidence; absent gives number_absent", () => {
  const text = "test session starts\n12 passed, 1 skipped in 0.51s\n";
  const c = ctx([{ id: "w1", tool: "run_tests", args_used: { command: "all" }, text }]);
  ok(resolveEvidence({ source: "w1", at: { search: "passed" }, value: "12 tests passed and 1 was skipped" }, c));
  const r = fail(resolveEvidence({ source: "w1", at: { search: "passed" }, value: "13 tests passed" }, c));
  assert.equal(r.reason, "number_absent");
  assert.match(r.message, /13/);
  // The number has to be in the lines pointed at, not merely somewhere in the result.
  const elsewhere = fail(resolveEvidence({ source: "w1", at: { lines: [1, 1] }, value: "12 tests passed" }, c));
  assert.equal(elsewhere.reason, "number_absent");
});

test("number tokens: thousands separators and decimals compare as written without separators", () => {
  assert.deepEqual(numberTokens("1,234 files, 0.51s, v1.5.2 and w12"), ["1234", "0.51", "1.5", "2", "12"]);
  assert.deepEqual(missingNumbers("1,234 lines", "total 1234"), []);
  assert.deepEqual(missingNumbers("604 test files", "1604 entries"), ["604"]);
  assert.deepEqual(missingNumbers("no numbers here", "anything"), []);
});

test("the number check cannot see what a number counts: the 604 test files case passes", () => {
  // The measured colleague run: 604 is in the result, but the command counts
  // directory entries, not test files. The check finds the number and stops there.
  const c = ctx([{ id: "w3", tool: "bash", args_used: { argv: ["sh", "-c", "ls tests | wc -l"] }, text: "604\n" }]);
  const r = ok(resolveEvidence({ source: "w3", at: { lines: [1, 1] }, value: "the repo has 604 test files" }, c));
  assert.equal(r.command, 'sh -c "ls tests | wc -l"');
  assert.equal(r.quote, "604");
});

// --- the cap ------------------------------------------------------------------

test("evidence beyond a result cut at the cap is not checkable from the saved result", () => {
  const cut = "line one\nline two\nline thr"; // the recorder kept only the first characters
  const c = ctx([{ id: "w1", tool: "bash", args_used: { argv: ["cat", "big.log"] }, text: cut, partial: true }]);
  for (const at of [{ lines: [5, 6] }, { search: "total 9999" }, { lines: [2, 3] }]) {
    const r = fail(resolveEvidence({ source: "w1", at }, c));
    assert.equal(r.reason, "result_cut", JSON.stringify(at));
    assert.equal(r.message, NOT_CHECKABLE_TEXT);
    assert.equal(NOT_CHECKABLE_TEXT, "not checkable from the saved result");
    assert.match(r.fix, /narrower call/);
  }
  // Lines wholly inside the kept part still resolve.
  assert.equal(ok(resolveEvidence({ source: "w1", at: { lines: [1, 2] } }, c)).quote, "line one\nline two");
});

test("the same pointer on a whole result is out of range, not cut", () => {
  const c = ctx([{ id: "w1", tool: "bash", args_used: { argv: ["cat", "small.log"] }, text: "line one\nline two\n" }]);
  assert.equal(fail(resolveEvidence({ source: "w1", at: { lines: [5, 6] } }, c)).reason, "pointer_out_of_range");
});

// --- labelled runs ----------------------------------------------------------

test("prior:wN and cN:wN resolve against the labelled export when it is present", () => {
  const prior = run([{ id: "w2", tool: "grep", args_used: { pattern: "TODO", path: "lib" }, text: "lib/a.ts:3: TODO x\n" }]);
  const child = run([{ id: "w1", tool: "read", args_used: { path: "README.md" }, text: "1\t# associate\n2\tharness" }]);
  const c = ctx([{ id: "w2", tool: "ls", args_used: { path: "." }, text: "other\n" }], { prior, c1: child });
  const p = ok(resolveEvidence({ source: "prior:w2", at: { search: "TODO" } }, c));
  assert.equal(p.run, "prior");
  assert.equal(p.quote, "lib/a.ts:3: TODO x");
  assert.equal(p.command, "grep pattern=TODO path=lib");
  const k = ok(resolveEvidence({ source: "c1:w1", at: { lines: [2, 2] } }, c));
  assert.equal(k.run, "c1");
  assert.equal(k.quote, "2\tharness");
  assert.equal(k.command, "read README.md");
  // The label is looked up, never the current run.
  assert.equal(fail(resolveEvidence({ source: "prior:w9", at: { lines: [1, 1] } }, c)).reason, "source_unknown");
});

test("a labelled source whose export is not here gets the labelled-run wording, never direct", () => {
  const c = ctx([{ id: "w2", tool: "ls", args_used: { path: "." }, text: "other\n" }]);
  for (const source of ["prior:w2", "c1:w4"]) {
    const r = fail(resolveEvidence({ source, at: { lines: [1, 1] } }, c));
    assert.equal(r.reason, "labelled_unread");
    assert.equal(r.run, source.split(":")[0]);
    assert.match(r.message, /rests on a labelled run .* whose result was not read here/);
    assert.doesNotMatch(r.message, /direct/);
  }
});

// --- the printed command ------------------------------------------------------

test("printed commands show checkout paths relative and carry no token or home path", () => {
  const token = "sk-abcdefghijklmnopqrstuvwx";
  const bearer = "Bearer abcdefghijklmnop1234";
  const c = ctx(
    [
      {
        id: "w1",
        tool: "bash",
        args_used: {
          argv: ["grep", "-rn", `${RUN_WORKTREE}/lib/walk.ts`, `--header=Authorization: ${bearer}`, token],
          cwd: `${RUN_WORKTREE}/lib`,
        },
        text: "found\n",
      },
      { id: "w2", tool: "read", args_used: { path: `${ROOT}/lib/facts.ts` }, text: "1\tx" },
      { id: "w3", tool: "web_page", args_used: { url: "https://example.org", note: "/home/someone/secret.txt" }, text: "page" },
    ],
    {},
    RUN_WORKTREE,
  );
  const commands = ["w1", "w2", "w3"].map((id) => ok(resolveEvidence({ source: id, at: { lines: [1, 1] } }, c)).command);
  const printed = commands.join("\n");
  for (const banned of [RUN_WORKTREE, ROOT, "/home/someone", token, "abcdefghijklmnop1234"]) {
    assert.ok(!printed.includes(banned), `${JSON.stringify(banned)} leaked into ${printed}`);
  }
  assert.match(commands[0], /^cd lib && grep -rn lib\/walk\.ts /);
  assert.equal(commands[1], "read lib/facts.ts");
  assert.match(commands[2], /note=~\/secret\.txt/);
});

test("a path that only shares a prefix with the checkout is not made relative", () => {
  const line = renderCommand(
    { id: "w1", tool: "ls", args_used: { path: `${ROOT}-other/x` } },
    { checkoutRoot: ROOT, redact },
  ).command;
  // Not under the checkout, but under a home directory: masked, never shown.
  assert.equal(line, "ls path=~/git/associate-other/x");
  assert.equal(renderCommand({ id: "w1", tool: "ls", args_used: { path: ROOT } }, { checkoutRoot: ROOT, redact }).command, "ls path=.");
});

test("the command is rendered from args_used even when the model described another one", () => {
  const c = ctx([
    {
      id: "w1",
      tool: "bash",
      // What the model asked (and what its fact says it ran) differs from what ran.
      args: { argv: ["find", ".", "-name", "*.test.ts"], timeout: 5, purpose: "count tests" },
      args_used: { argv: ["ls", "tests"] },
      text: "a.test.ts\n",
    },
  ]);
  const r = ok(
    resolveEvidence(
      { source: "w1", at: { lines: [1, 1] }, value: "find . -name '*.test.ts' lists a.test.ts", command: "find . -name '*.test.ts'" },
      c,
    ),
  );
  assert.equal(r.command, "ls tests");
  assert.equal(r.command_from, "args_used");
});

test("without args_used the command falls back to the arguments as asked, purpose dropped, and says so", () => {
  const r = renderCommand(
    { id: "w1", tool: "grep", args: { pattern: "a b", path: "lib", purpose: "find a b" } },
    { checkoutRoot: ROOT, redact },
  );
  assert.equal(r.command, 'grep pattern="a b" path=lib');
  assert.equal(r.command_from, "args");
});

// --- no process, no tool call -------------------------------------------------

test("resolving starts no process and makes no tool call", (t) => {
  const spawners = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;
  const mocks = spawners.map((name) => t.mock.method(childProcess, name, () => {
    throw new Error(`${name} called`);
  }));
  const read: string[] = [];
  const base = ctx(
    [{ id: "w1", tool: "bash", args_used: { argv: ["ls"] }, text: "a\nb\n" }],
    { prior: run([{ id: "w1", tool: "ls", args_used: { path: "." }, text: "x\n" }]) },
  );
  // Every property the resolver reads from its context is recorded; nothing it
  // is handed can run a tool (there is no tool runner in the context at all).
  const watched = new Proxy(base, {
    get(target, key, receiver) {
      read.push(String(key));
      return Reflect.get(target, key, receiver);
    },
  });
  ok(resolveEvidence({ source: "w1", at: { lines: [1, 2] }, value: "a" }, watched));
  ok(resolveEvidence({ source: "prior:w1", at: { search: "x" } }, watched));
  fail(resolveEvidence({ source: "w1", at: { lines: [7, 8] } }, watched));
  for (const m of mocks) assert.equal(m.mock.callCount(), 0);
  const allowed = new Set(["entry", "savedResult", "checkoutRoot", "redact", "labelled", "sourceKinds"]);
  for (const key of read) assert.ok(allowed.has(key), `resolver read ctx.${key}`);
  mock.restoreAll();

  // And the module itself brings in nothing that could start a process or read the environment.
  const source = readFileSync(join(extensionDir, "lib", "evidence.ts"), "utf8");
  for (const banned of ["node:child_process", "node:fs", "process.env", "registerTool", "execute("]) {
    assert.ok(!source.includes(banned), `evidence.ts mentions ${banned}`);
  }
});
