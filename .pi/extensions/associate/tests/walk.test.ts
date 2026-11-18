/**
 * The walk recorder (spec c23/c25/c30/c36/c43, honesty h17/h24/h29).
 *
 * The hooks are driven directly with fake Pi `tool_call` / `tool_result` /
 * `session_shutdown` events — the same pattern the other extension tests use —
 * so the recorder is tested without a live pi. Every line the recorder writes
 * is validated against the *contract's* walk schema by shelling to the Python
 * package's stdlib validator, so a drift between the schema and what the
 * TypeScript writes fails here rather than in a bench run.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadContract } from "../lib/contract.ts";
import { extensionDir } from "../lib/paths.ts";
import {
  ARGS_USED_KEY,
  DROPPED_ARGS_KEY,
  NOT_SHOWN_CHARS_KEY,
  WALK_FILENAME,
  WALK_FORMAT,
  WalkRecorder,
  compileRedaction,
  installWalkRecorder,
  isReadToolName,
  redactValue,
} from "../lib/walk.ts";
import { RESULTS_DIRNAME, loadSavedResult, savedResultName } from "../lib/results.ts";
import { loadExtension } from "./load-extension.ts";

const contract = loadContract({});
const policy = contract.policy;
const sourceKinds = contract.accuracy.source_kinds;

/** The repo root: `.pi/extensions/associate` → three levels up. */
const repoRoot = dirname(dirname(dirname(extensionDir)));

function recorderIn(dir: string, options: Record<string, unknown> = {}): WalkRecorder {
  return new WalkRecorder({ exportDir: dir, policy, sourceKinds, installExitHook: false, ...options });
}

/** Every line of the walk, the format marker line excluded. */
function readLines(dir: string): Array<Record<string, unknown>> {
  return readAllLines(dir).filter((line) => !isFormatLine(line));
}

/** Every line of the walk as written, the format marker line included. */
function readAllLines(dir: string): Array<Record<string, unknown>> {
  return readFileSync(join(dir, WALK_FILENAME), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function isFormatLine(line: Record<string, unknown>): boolean {
  return Object.keys(line).length === 1 && "format" in line;
}

/** Tool-entry lines only (they carry a walk id). */
function entryLines(dir: string): Array<Record<string, any>> {
  return readAllLines(dir).filter((line) => typeof line.id === "string") as Array<Record<string, any>>;
}

function withDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "associate-walk-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Drive one complete call→result pair through the recorder. */
function callAndResult(
  recorder: WalkRecorder,
  toolName: string,
  input: Record<string, unknown>,
  content: unknown,
  extra: Record<string, unknown> = {},
): void {
  const toolCallId = `tc-${Math.random().toString(16).slice(2)}`;
  recorder.noteToolCall({ toolName, toolCallId, input });
  recorder.recordToolResult({ toolName, toolCallId, input, content, ...extra });
}

/**
 * Validate every line of a walk against the contract schema, via the Python
 * package. Returns `undefined` when `uv` is unavailable (the extension tests
 * must still run on a machine with node but no Python toolchain).
 */
function validateWalkWithContract(dir: string): string | undefined {
  const script = `
import json, sys
from pathlib import Path
from associate import contract
from associate.contract import validate

walk = contract.load_schema("walk")
def sub(key):
    schema = dict(walk["$defs"][key])
    schema["$defs"] = walk["$defs"]
    return schema
wrapped = {key: sub(key) for key in ("run", "gate", "child", "format")}
entry_schema = sub("entry")
lines = [l for l in Path(sys.argv[1]).read_text().splitlines() if l.strip()]
problems = []
for index, line in enumerate(lines, start=1):
    record = json.loads(line)
    keys = set(record)
    key = next(iter(keys)) if len(keys) == 1 and next(iter(keys)) in wrapped else None
    schema = wrapped[key] if key else entry_schema
    instance = record[key] if key else record
    for error in validate.validate(instance, schema):
        problems.append(f"line {index}: {error}")
print("\\n".join(problems))
`;
  try {
    return execFileSync("uv", ["run", "python", "-c", script, join(dir, WALK_FILENAME)], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT/.test(message)) return undefined; // no uv on PATH
    throw error;
  }
}

// -------------------------------------------------------------- redaction

test("the redaction filter is built from the contract, not from TypeScript", () => {
  const filter = compileRedaction(policy);
  const contractPatterns = (policy.redaction as { patterns: string[] }).patterns;
  assert.equal(filter.patterns.length, contractPatterns.length);
  assert.equal(filter.replacement, (policy.redaction as { replacement: string }).replacement);
});

test("known secret shapes are redacted in every string leaf", () => {
  const filter = compileRedaction(policy);
  const redacted = redactValue(
    {
      header: "Authorization: Bearer sk-live-AAAABBBBCCCCDDDDEEEE",
      nested: { list: ["api_key = hunter2hunter2", "harmless text"] },
      count: 3,
    },
    filter,
  ) as Record<string, any>;

  assert.ok(!redacted.header.includes("sk-live-AAAABBBBCCCCDDDDEEEE"), redacted.header);
  assert.ok(redacted.header.includes("[REDACTED]"));
  assert.ok(!redacted.nested.list[0].includes("hunter2hunter2"), redacted.nested.list[0]);
  assert.equal(redacted.nested.list[1], "harmless text");
  assert.equal(redacted.count, 3, "non-strings pass through unchanged");
});

// ------------------------------------------------------------- entry shape

test("ids are monotonic from w1, every entry carries a timestamp, reads carry a sha256", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    callAndResult(recorder, "read", { path: "a.ts" }, "contents of a");
    callAndResult(recorder, "find", { pattern: "*.ts" }, "a.ts\nb.ts");
    callAndResult(recorder, "read", { path: "b.ts" }, "contents of b");
    recorder.finalize();

    const lines = readLines(dir);
    const entries = lines.slice(0, -1);

    assert.deepEqual(
      entries.map((entry) => entry.id),
      ["w1", "w2", "w3"],
    );
    for (const entry of entries) {
      assert.match(String(entry.ts), /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(typeof entry.truncated, "boolean");
      assert.equal(typeof entry.args, "object");
    }

    const reads = entries.filter((entry) => entry.tool === "read");
    assert.equal(reads.length, 2);
    for (const entry of reads) {
      const result = entry.result as Record<string, unknown>;
      assert.match(String(result.sha256), /^[0-9a-f]{64}$/);
      assert.equal(typeof result.content, "string", "a read records both content and its digest");
    }

    // The digest is of the content the walk actually stores, so a reader can
    // recompute it from the file rather than having to trust it.
    const first = entries[0].result as Record<string, string>;
    assert.equal(createHash("sha256").update(first.content, "utf8").digest("hex"), first.sha256);

    // A non-read records the content it returned and no digest is required.
    const find = entries[1].result as Record<string, unknown>;
    assert.equal(find.content, "a.ts\nb.ts");
  });
});

test("pi's content-block array form is flattened to the text it carried", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    callAndResult(recorder, "read", { path: "a.ts" }, [
      { type: "text", text: "line one" },
      { type: "text", text: "line two" },
    ]);
    recorder.finalize();
    const [entry] = readLines(dir);
    assert.equal((entry.result as Record<string, string>).content, "line one\nline two");
  });
});

test("a failed tool call records its error and still gets an entry", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    callAndResult(recorder, "read", { path: "missing.ts" }, "ENOENT: no such file", {
      isError: true,
    });
    recorder.finalize();
    const [entry] = readLines(dir);
    assert.equal(entry.tool, "read");
    assert.match(String(entry.error), /ENOENT/);
  });
});

test("an entry over the contract's raw cap keeps the digest and drops the content", () => {
  withDir((dir) => {
    const cap = (policy.caps as { max_raw_chars: number }).max_raw_chars;
    const recorder = recorderIn(dir);
    callAndResult(recorder, "read", { path: "huge.ts" }, "x".repeat(cap + 10));
    recorder.finalize();
    const [entry] = readLines(dir);
    const result = entry.result as Record<string, unknown>;
    assert.equal(result.content, undefined, "oversized content is not inlined");
    assert.match(String(result.sha256), /^[0-9a-f]{64}$/);
    assert.equal(result.bytes, cap + 10);
    assert.equal(entry.truncated, true);
  });
});

test("a tool call that never produced a result is recorded as one, never dropped", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    recorder.noteToolCall({ toolName: "write", toolCallId: "blocked-1", input: { path: "x" } });
    const run = recorder.finalize();
    const lines = readLines(dir);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].id, "w1");
    assert.match(String(lines[0].error), /no tool_result/);
    assert.equal(run?.outcome, "error");
  });
});

test("the recorder never invents an entry Pi did not emit", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    recorder.recordToolResult({ toolName: "read", toolCallId: "unseen", content: "x" });
    recorder.finalize();
    const lines = readLines(dir);
    // A result with no preceding call is still a real Pi event, so it is
    // recorded — but nothing beyond the events fired ever appears.
    assert.equal(lines.length, 2, "one entry per event, plus the run record");
  });
});

// --------------------------------------------------------------- redaction
// (acceptance criterion 2)

test("a fixture bearer token read during the run appears redacted in walk.jsonl", () => {
  withDir((dir) => {
    const secret = "Authorization: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const recorder = recorderIn(dir);
    callAndResult(recorder, "read", { path: "fixture-secrets.txt" }, secret);
    recorder.finalize();

    const raw = readFileSync(join(dir, WALK_FILENAME), "utf8");
    assert.ok(!raw.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), raw);
    assert.ok(raw.includes("[REDACTED]"), raw);
  });
});

test("a secret in the arguments is redacted too, not only in the result", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    callAndResult(
      recorder,
      "web",
      { url: "https://example.test", header: "bearer sk-ABCDEFGHIJKLMNOPQRST" },
      "ok",
    );
    recorder.finalize();
    const raw = readFileSync(join(dir, WALK_FILENAME), "utf8");
    assert.ok(!raw.includes("sk-ABCDEFGHIJKLMNOPQRST"), raw);
  });
});

// -------------------------------------------------------------- run record
// (acceptance criterion 3)

test("the final line is the run record with duration, calls, outcome and truncated", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    callAndResult(recorder, "read", { path: "a.ts" }, "a");
    callAndResult(recorder, "read", { path: "b.ts" }, "b");
    const run = recorder.finalize("ok");

    const lines = readLines(dir);
    const last = lines[lines.length - 1];
    assert.deepEqual(Object.keys(last), ["run"]);
    const record = last.run as Record<string, unknown>;
    assert.equal(record.tool_calls, 2);
    assert.equal(record.outcome, "ok");
    assert.equal(record.truncated, false);
    assert.equal(typeof record.duration_ms, "number");
    assert.ok((record.duration_ms as number) >= 0);
    assert.deepEqual(record, run);
  });
});

test("the run record carries the active model's registry key and lobes role", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir, { model: "worker", lobes_role: "worker" });
    callAndResult(recorder, "read", { path: "a.ts" }, "a");
    const run = recorder.finalize();

    const lines = readLines(dir);
    const record = lines[lines.length - 1].run as Record<string, unknown>;
    assert.equal(record.model, "worker");
    assert.equal(record.lobes_role, "worker");
    assert.deepEqual(record, run);
  });
});

test("the run record omits model and lobes_role when no model resolved", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    callAndResult(recorder, "read", { path: "a.ts" }, "a");
    const run = recorder.finalize();

    const lines = readLines(dir);
    const record = lines[lines.length - 1].run as Record<string, unknown>;
    assert.equal(record.model, undefined);
    assert.equal(record.lobes_role, undefined);
    assert.deepEqual(record, run);
  });
});

test("L4: a call the guard blocked is recorded with its refusal and does not make the run an error", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    recorder.noteToolCall({ toolCallId: "tc-1", toolName: "bash", input: { argv: ["id", "-u"] } });
    recorder.recordBlocked("tc-1", "associate: 'id' is not on the allowlist");
    const run = recorder.finalize()!;

    const lines = readLines(dir);
    const entry = lines[0] as Record<string, any>;
    assert.equal(entry.id, "w1");
    assert.equal(entry.tool, "bash");
    assert.deepEqual(entry.args, { argv: ["id", "-u"] });
    assert.match(entry.error, /^refused: associate: 'id' is not on the allowlist/);
    assert.equal(run.tool_calls, 1);
    assert.equal(run.outcome, "ok", "a refusal is the guard working, not a run error");
  });
});

test("L4: a tool_result pi sends anyway for a blocked call is not recorded twice", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    recorder.noteToolCall({ toolCallId: "tc-1", toolName: "write", input: { path: "x" } });
    recorder.recordBlocked("tc-1", "blocked");
    recorder.recordToolResult({ toolCallId: "tc-1", toolName: "write", content: "blocked", isError: true });
    recorder.finalize();
    assert.equal(readLines(dir).filter((line) => "id" in line).length, 1);
  });
});

test("L4: a call whose result never arrives and was not blocked still makes the run an error", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    recorder.recordBlocked("tc-unknown", "nothing pending under this id");
    recorder.noteToolCall({ toolCallId: "tc-2", toolName: "read", input: { path: "a" } });
    const run = recorder.finalize()!;
    assert.equal(run.outcome, "error");
    assert.equal(readLines(dir).filter((line) => "id" in line).length, 1);
  });
});

test("finalize is idempotent: two shutdown paths write one run record", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    callAndResult(recorder, "read", { path: "a.ts" }, "a");
    recorder.finalize();
    recorder.finalize();
    const lines = readLines(dir);
    assert.equal(lines.filter((line) => "run" in line).length, 1);
  });
});

test("entries are streamed, so a killed run still leaves a valid partial walk", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    callAndResult(recorder, "read", { path: "a.ts" }, "a");
    // No finalize: this is the killed-run case.
    const lines = readLines(dir);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].id, "w1");
    const problems = validateWalkWithContract(dir);
    assert.equal(problems ?? "", "", `partial walk fails the contract schema:\n${problems}`);
  });
});

// ------------------------------------------------------- schema conformance

test("every line of a finished walk validates against the contract walk schema", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    callAndResult(recorder, "read", { path: "a.ts" }, "a\nb\nc");
    callAndResult(recorder, "search", { pattern: "b" }, "a.ts:2:b");
    callAndResult(recorder, "read", { path: "missing" }, "boom", { isError: true });
    recorder.finalize();
    const problems = validateWalkWithContract(dir);
    if (problems === undefined) {
      console.log("SKIP schema conformance: uv not on PATH");
      return;
    }
    assert.equal(problems, "", `walk fails the contract schema:\n${problems}`);
  });
});

// ------------------------------------------------------------ installation

test("read tools are recognised by the names the extension registers", () => {
  assert.equal(isReadToolName("read"), true);
  assert.equal(isReadToolName("read_file"), true);
  assert.equal(isReadToolName("search"), false);
});

test("the extension installs the recorder and the sentinel names the walk path", async () => {
  const root = mkdtempSync(join(tmpdir(), "associate-runs-"));
  const checkout = mkdtempSync(join(tmpdir(), "associate-checkout-"));
  const env = {
    ASSOCIATE_EXPORT_ROOT: root,
    ASSOCIATE_CHECKOUT_ROOT: checkout,
    ASSOCIATE_SESSION_ID: "walk-session",
  };
  const loaded = await loadExtension(env);
  try {
    const { pi } = loaded;
    assert.ok((pi.handlers.get("tool_result") ?? []).length >= 1, "no tool_result handler");
    assert.ok((pi.handlers.get("session_shutdown") ?? []).length >= 1, "no shutdown handler");

    const report = (await pi.tool("associate_ready").execute("t", {})) as {
      details: { session: { walk_path: string; export_dir: string } };
    };
    const walkPath = report.details.session.walk_path;
    assert.ok(walkPath.endsWith(WALK_FILENAME), walkPath);
    assert.ok(walkPath.startsWith(report.details.session.export_dir), walkPath);

    // Drive the installed hooks end to end.
    const purpose = "does a.ts greet? expect hi";
    await pi.fireToolCall({ toolName: "read", toolCallId: "x1", input: { path: "a.ts", purpose } });
    for (const handler of pi.handlers.get("tool_result") ?? []) {
      await handler({ toolName: "read", toolCallId: "x1", input: { path: "a.ts", purpose }, content: "hi" });
    }
    for (const handler of pi.handlers.get("session_shutdown") ?? []) {
      await handler({ reason: "quit" });
    }

    const lines = readFileSync(walkPath, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
      .filter((line) => !("format" in line));
    assert.equal(lines[0].id, "w1");
    assert.equal(lines[0].tool, "read");
    // t6: through the installed hooks, the entry is the full action record.
    assert.equal(lines[0].purpose, purpose);
    assert.equal(lines[0].source_kind, "file");
    assert.equal(loadSavedResult(report.details.session.export_dir, "w1"), "hi");
    assert.equal(lines[lines.length - 1].run.tool_calls, 1);
  } finally {
    loaded.cleanup();
    rmSync(root, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("appending to an existing walk keeps ids monotonic across recorders", () => {
  withDir((dir) => {
    appendFileSync(
      join(dir, WALK_FILENAME),
      JSON.stringify({
        id: "w1",
        ts: new Date().toISOString(),
        tool: "read",
        args: {},
        result: {},
        truncated: false,
      }) + "\n",
    );
    const recorder = recorderIn(dir);
    callAndResult(recorder, "read", { path: "a.ts" }, "a");
    recorder.finalize();
    const lines = readLines(dir);
    assert.deepEqual(
      lines.slice(0, -1).map((line) => line.id),
      ["w1", "w2"],
    );
  });
});

// --------------------------------------------------- child-walk links (t16)

test("recordChild appends {child} lines c1, c2, … that take no walk id and are not tool calls", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    callAndResult(recorder, "ls", { path: "." }, "a\nb");
    const first = recorder.recordChild({ child_model: "senses", child_walk: "/r/s-1/export/walk.jsonl", child_session_id: "s-1" });
    const second = recorder.recordChild({ child_model: "worker", child_walk: "/r/s-2/export/walk.jsonl", child_session_id: "s-2" });
    callAndResult(recorder, "ls", { path: "." }, "c");
    assert.equal(first.id, "c1");
    assert.equal(second.id, "c2");
    assert.equal(typeof first.ts, "string");
    const run = recorder.finalize()!;
    assert.equal(run.tool_calls, 2);
    assert.deepEqual(recorder.entryIds(), ["w1", "w2"]);
    const children = readLines(dir).filter((line) => "child" in line).map((line) => line.child as Record<string, unknown>);
    assert.deepEqual(children, [first, second]);
  });
});

test("a second recorder on the same walk continues child ids instead of re-issuing c1", () => {
  withDir((dir) => {
    const one = recorderIn(dir);
    one.recordChild({ child_model: "senses", child_walk: "/a", child_session_id: "a" });
    const two = recorderIn(dir);
    assert.equal(two.recordChild({ child_model: "senses", child_walk: "/b", child_session_id: "b" }).id, "c2");
    assert.equal(two.entryCount, 0, "a child line never occupies a walk id");
  });
});

test("recordChild refuses once the walk is finalized", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    recorder.finalize();
    assert.throws(() => recorder.recordChild({ child_model: "senses", child_walk: "/a", child_session_id: "a" }), /finalized/);
  });
});

// ================================================================ issue #20 t6
// The walk entry as the full action record (spec c8/h6, c9/h7, c2, c15).

/** The repo's contract walk schema, parsed. */
function walkSchema(): Record<string, any> {
  return JSON.parse(readFileSync(join(contract.dir, "schemas", "walk.schema.json"), "utf8"));
}

function assertValid(dir: string): void {
  const problems = validateWalkWithContract(dir);
  if (problems === undefined) {
    console.log("SKIP schema conformance: uv not on PATH");
    return;
  }
  assert.equal(problems, "", `walk fails the contract schema:\n${problems}`);
}

/** A policy whose raw cap is `cap`, every other section the contract's. */
function policyWithCap(cap: number): Record<string, unknown> {
  return { ...policy, caps: { ...(policy.caps as Record<string, unknown>), max_raw_chars: cap } };
}

test("t6 c1: an entry carries purpose, args as asked and as used, source kind, saved result, not-shown count, partial", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    const asked = { path: "lib/walk.ts", limit: "120", offset: "460", purpose: "where is the entry appended? expect appendFileSync" };
    recorder.noteToolCall({ toolName: "read", toolCallId: "tc-1", input: asked });
    recorder.recordToolResult({
      toolName: "read",
      toolCallId: "tc-1",
      input: asked,
      content: "1\tline one\n2\tline two",
      details: {
        [ARGS_USED_KEY]: { path: "lib/walk.ts", start_line: 1 },
        [DROPPED_ARGS_KEY]: ["limit", "offset"],
        [NOT_SHOWN_CHARS_KEY]: 1234,
      },
    });
    recorder.finalize();

    const [entry] = entryLines(dir);
    assert.equal(entry.purpose, asked.purpose);
    assert.deepEqual(entry.args, asked, "args as asked stay complete, purpose included");
    assert.deepEqual(entry.args_used, { path: "lib/walk.ts", start_line: 1 });
    assert.deepEqual(entry.dropped_args, ["limit", "offset"]);
    assert.notDeepEqual(entry.args, entry.args_used, "asked and used differ when the tool ignored arguments");
    assert.equal(entry.source_kind, "file");
    assert.equal(entry.saved_result, savedResultName("w1"));
    assert.equal(readFileSync(join(dir, entry.saved_result), "utf8"), "1\tline one\n2\tline two");
    assert.equal(entry.not_shown_chars, 1234);
    assert.equal(entry.partial, false);
    assertValid(dir);
  });
});

test("t6 c1: the result-details keys the tools fill are named args_used and dropped_args", () => {
  assert.equal(ARGS_USED_KEY, "args_used");
  assert.equal(DROPPED_ARGS_KEY, "dropped_args");
  const source = readFileSync(join(extensionDir, "lib", "walk.ts"), "utf8");
  const header = source.slice(0, source.indexOf("import "));
  for (const key of ["args_used", "dropped_args", "not_shown_chars"]) {
    assert.ok(header.includes(key), `walk.ts's header documents the details key ${key}`);
  }
});

test("t6 c1: a tool that reports no arguments as used gets no as-used value", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    callAndResult(recorder, "find", { pattern: "*.ts", purpose: "list sources; expect walk.ts" }, "a.ts");
    recorder.finalize();
    const [entry] = entryLines(dir);
    assert.equal("args_used" in entry, false);
    assert.equal("dropped_args" in entry, false);
    assert.equal(entry.not_shown_chars, 0, "a result the tool did not cut hides nothing");
    assertValid(dir);
  });
});

test("t6 c1: a result the tool marked truncated without a count carries no not-shown count", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    callAndResult(recorder, "bash", { argv: ["ls"] }, "a\nb", { details: { truncated: true } });
    recorder.finalize();
    const [entry] = entryLines(dir);
    assert.equal("not_shown_chars" in entry, false, "an unknown count is absent, never a guessed 0");
    assert.equal(entry.truncated, true);
  });
});

test("t6 c1: args as asked are captured at tool_call, before a hook can mutate the input", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    const input: Record<string, unknown> = { path: "a.ts", purpose: "read a; expect text" };
    recorder.noteToolCall({ toolName: "read", toolCallId: "tc-m", input });
    // pi 1.5.2: event.input is mutable; a later hook patches it in place.
    input.path = "patched.ts";
    delete input.purpose;
    recorder.recordToolResult({ toolName: "read", toolCallId: "tc-m", input, content: "x" });
    recorder.finalize();
    const [entry] = entryLines(dir);
    assert.deepEqual(entry.args, { path: "a.ts", purpose: "read a; expect text" });
    assert.equal(entry.purpose, "read a; expect text");
  });
});

test("t6 c1: the source kind comes from the contract's table, and a tool outside it gets none", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    const tools = ["read", "grep", "web_page", "eidetic_recall", "spawn_subagent", "finish", "not_a_tool"];
    for (const tool of tools) callAndResult(recorder, tool, {}, "x");
    recorder.finalize();
    const entries = entryLines(dir);
    tools.forEach((tool, index) => {
      const expected = Object.hasOwn(sourceKinds, tool) ? sourceKinds[tool] : undefined;
      assert.equal(entries[index].source_kind, expected, tool);
    });
    assert.equal("source_kind" in entries[tools.length - 1], false);
    assertValid(dir);
  });
  // No copy of the table in TypeScript: the kinds the contract assigns are never literals in walk.ts.
  const source = readFileSync(join(extensionDir, "lib", "walk.ts"), "utf8");
  for (const tool of ["eidetic_recall", "web_search", "spawn_subagent", "delegate_status"]) {
    assert.ok(!source.includes(`"${tool}"`), `walk.ts names ${tool}: the source-kind table belongs to accuracy.json`);
  }
});

test("t6 c1: the walk's first line is a format marker the schema describes, written once", () => {
  withDir((dir) => {
    const one = recorderIn(dir);
    callAndResult(one, "read", { path: "a.ts" }, "a");
    // A second recorder on the same walk (a re-open) must not add a second marker.
    const two = recorderIn(dir);
    callAndResult(two, "read", { path: "b.ts" }, "b");
    two.finalize();
    const all = readAllLines(dir);
    assert.deepEqual(all[0], { format: WALK_FORMAT });
    assert.equal(all.filter(isFormatLine).length, 1);
    const def = walkSchema().$defs.format;
    assert.deepEqual(def.properties.name.enum, [WALK_FORMAT.name]);
    assert.deepEqual(def.properties.version.enum, [WALK_FORMAT.version]);
    assert.deepEqual(entryLines(dir).map((e) => e.id), ["w1", "w2"], "the marker takes no walk id");
    assertValid(dir);
  });
});

test("t6 c1: a killed run (no run line) still carries the format marker", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    callAndResult(recorder, "read", { path: "a.ts" }, "a");
    assert.deepEqual(readAllLines(dir)[0], { format: WALK_FORMAT });
  });
});

test("t6 c1: walk.schema.json describes every new entry field", () => {
  const props = walkSchema().$defs.entry.properties;
  for (const field of ["purpose", "args", "args_used", "dropped_args", "source_kind", "saved_result", "not_shown_chars", "partial"]) {
    assert.ok(props[field], `entry.${field} is described`);
    assert.equal(typeof props[field].description === "string" || field === "args", true, `entry.${field} has a description`);
  }
  for (const kind of Object.values(sourceKinds)) {
    assert.ok(props.source_kind.enum.includes(kind), `the schema allows the contract kind ${kind}`);
  }
});

// ---------------------------------------------------------------- criterion 2

test("t6 c2: every result is saved in full under the session export, one file per walk id", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    callAndResult(recorder, "read", { path: "a.ts" }, "contents of a");
    callAndResult(recorder, "grep", { pattern: "x" }, [{ type: "text", text: "a.ts:1:x" }]);
    callAndResult(recorder, "read", { path: "gone" }, "ENOENT", { isError: true });
    recorder.finalize();
    const entries = entryLines(dir);
    assert.deepEqual(
      entries.map((e) => e.saved_result),
      ["w1", "w2", "w3"].map(savedResultName),
    );
    assert.deepEqual(readdirSync(join(dir, RESULTS_DIRNAME)).sort(), ["w1.txt", "w2.txt", "w3.txt"]);
    assert.equal(loadSavedResult(dir, "w1"), "contents of a");
    assert.equal(loadSavedResult(dir, "w2"), "a.ts:1:x");
    assert.equal(loadSavedResult(dir, "w3"), "ENOENT");
    for (const entry of entries) assert.equal(entry.partial, false);
  });
});

test("t6 c2: a saved result is the redacted text, never the raw secret", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    callAndResult(recorder, "read", { path: "s" }, "Authorization: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    recorder.finalize();
    const saved = loadSavedResult(dir, "w1")!;
    assert.ok(!saved.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), saved);
    assert.equal(saved, compileRedaction(policy).apply("Authorization: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"));
  });
});

test("t6 c2: above caps.max_raw_chars the saved file is cut at the cap and the entry is partial", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir, { policy: policyWithCap(10) });
    callAndResult(recorder, "read", { path: "small" }, "0123456789");
    callAndResult(recorder, "read", { path: "big" }, "0123456789abcdef");
    recorder.finalize();
    const [small, big] = entryLines(dir);
    assert.equal(small.partial, false);
    assert.equal(loadSavedResult(dir, "w1"), "0123456789");
    assert.equal(big.partial, true);
    assert.equal(loadSavedResult(dir, "w2"), "0123456789");
    assertValid(dir);
  });
});

test("t6 c2: a call with no result (refused or unresolved) saves nothing and is partial", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    recorder.noteToolCall({ toolCallId: "r", toolName: "write", input: { path: "x", purpose: "p" } });
    recorder.recordBlocked("r", "no");
    recorder.noteToolCall({ toolCallId: "u", toolName: "read", input: { path: "y" } });
    recorder.finalize();
    const [refused, unresolved] = entryLines(dir);
    for (const entry of [refused, unresolved]) {
      assert.equal("saved_result" in entry, false);
      assert.equal(entry.partial, true);
    }
    assert.equal(refused.purpose, "p");
    assert.equal(existsSync(join(dir, RESULTS_DIRNAME, "w1.txt")), false);
    assertValid(dir);
  });
});

test("t6 c2: loadSavedResult refuses anything that is not a walk id, before opening a file", () => {
  withDir((dir) => {
    for (const bad of ["../walk", "w1/../../x", "/etc/passwd", "w0", "run-1:w1", ""]) {
      assert.throws(() => loadSavedResult(dir, bad), /walk id/, bad);
    }
    assert.equal(loadSavedResult(dir, "w7"), undefined, "an id with no saved file reads as nothing saved");
  });
});

// ---------------------------------------------------------------- criterion 3

test("t6 c3: the stored purpose equals the purpose on the call after redaction", () => {
  withDir((dir) => {
    const purpose = "check the token api_key = hunter2hunter2 is gone; expect no match";
    const recorder = recorderIn(dir);
    callAndResult(recorder, "grep", { pattern: "x", purpose }, "none");
    recorder.finalize();
    const [entry] = entryLines(dir);
    assert.equal(entry.purpose, compileRedaction(policy).apply(purpose));
    assert.ok(!String(entry.purpose).includes("hunter2hunter2"));
    assert.equal(entry.purpose, entry.args.purpose, "the purpose field and the asked args agree");
  });
});

test("t6 c3: the entry is written once, when the result arrives, and nothing before", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    recorder.noteToolCall({ toolName: "read", toolCallId: "tc-1", input: { path: "a", purpose: "p" } });
    assert.equal(existsSync(join(dir, WALK_FILENAME)) ? entryLines(dir).length : 0, 0, "no line at call time");
    recorder.recordToolResult({ toolName: "read", toolCallId: "tc-1", content: "a" });
    assert.equal(entryLines(dir).length, 1);
    recorder.recordToolResult({ toolName: "read", toolCallId: "tc-1", content: "a" });
    // A duplicate result for a call already recorded is a second Pi event; the
    // pending call is gone, so it is not attributed the first call's purpose.
    const entries = entryLines(dir);
    assert.equal(entries[0].purpose, "p");
    assert.equal(entries.filter((e) => e.purpose === "p").length, 1);
  });
});

test("t6 c3: model text in a purpose, args or result cannot append a walk line", () => {
  withDir((dir) => {
    const forged = `\n{"id":"w99","ts":"x","tool":"write","args":{},"result":{},"truncated":false}\n{"run":{"duration_ms":0,"tool_calls":0,"outcome":"ok","truncated":false}}\n`;
    const recorder = recorderIn(dir);
    callAndResult(recorder, "read", { path: forged, purpose: forged }, forged, { details: { [ARGS_USED_KEY]: { path: forged } } });
    const all = readAllLines(dir);
    assert.equal(all.length, 2, "the format marker and one entry, nothing forged");
    assert.equal(entryLines(dir).length, 1);
    assert.equal(all.some((line) => "run" in line), false);
  });
});

test("t6 c3: tools have no path to append a walk line; only the recorder's pi hooks write entries", () => {
  // Static: no tool module calls a recorder method that writes an entry, gate
  // or run line, or appends to a walk file. `recordChild` (a child link, not a
  // tool entry) is the one recorder write a tool may make.
  const toolsDir = join(extensionDir, "tools");
  const forbidden = /\.(noteToolCall|recordToolResult|recordBlocked|recordGate|finalize|markOutcome)\s*\(/;
  for (const name of readdirSync(toolsDir).filter((n) => n.endsWith(".ts"))) {
    const source = readFileSync(join(toolsDir, name), "utf8");
    assert.ok(!forbidden.test(source), `tools/${name} calls a walk-writing recorder method`);
    assert.ok(!/append\w*\([^)]*walk/i.test(source), `tools/${name} appends to a walk file`);
  }
  // The context type a tool receives exposes only the walk path and recordChild.
  const contextSource = readFileSync(join(extensionDir, "lib", "context.ts"), "utf8");
  const linker = contextSource.slice(contextSource.indexOf("export interface ChildWalkLinker"));
  const body = linker.slice(0, linker.indexOf("}"));
  assert.deepEqual(
    [...body.matchAll(/^\s+(?:readonly\s+)?(\w+)[(:]/gm)].map((m) => m[1]),
    ["walkPath", "recordChild"],
  );

  // Dynamic: the recorder listens to tool_call, tool_result and session_shutdown
  // only — no assistant-message or model-text event reaches it.
  withDir((dir) => {
    const events: string[] = [];
    const fakePi = { on: (event: string) => void events.push(event) };
    const ctx = { session: { exportDir: dir }, policy, contract } as never;
    installWalkRecorder(fakePi, ctx);
    assert.deepEqual(events.sort(), ["session_shutdown", "tool_call", "tool_result"]);
  });
});

// ---------------------------------------------------------------- criterion 4

test("t6 c4: an entry from a call with no purpose (an exempt tool) validates and has no purpose field", () => {
  withDir((dir) => {
    const recorder = recorderIn(dir);
    for (const tool of contract.accuracy.purpose_exempt_tools) callAndResult(recorder, tool, { summary: "done" }, "ok");
    callAndResult(recorder, "read", {}, "no args at all");
    recorder.finalize();
    for (const entry of entryLines(dir)) assert.equal("purpose" in entry, false, entry.tool);
    assertValid(dir);
  });
});

test("t6 c4: a pre-change walk (no marker, old entry shape) validates and is continued without a marker", () => {
  withDir((dir) => {
    const old = {
      id: "w1",
      ts: "2026-11-17T10:00:00.000Z",
      tool: "read",
      args: { path: "a.ts" },
      result: { content: "a", sha256: createHash("sha256").update("a").digest("hex"), bytes: 1 },
      truncated: false,
    };
    appendFileSync(join(dir, WALK_FILENAME), `${JSON.stringify(old)}\n${JSON.stringify({ run: { duration_ms: 1, tool_calls: 1, outcome: "ok", truncated: false } })}\n`);
    assertValid(dir);
    const recorder = recorderIn(dir);
    callAndResult(recorder, "read", { path: "b.ts" }, "b");
    assert.equal(readAllLines(dir).filter(isFormatLine).length, 0, "a marker is never written mid-file");
    assert.deepEqual(entryLines(dir).map((e) => e.id), ["w1", "w2"]);
    assertValid(dir);
  });
});
