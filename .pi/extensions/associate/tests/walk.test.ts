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
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadContract } from "../lib/contract.ts";
import { extensionDir } from "../lib/paths.ts";
import {
  WALK_FILENAME,
  WalkRecorder,
  compileRedaction,
  isReadToolName,
  redactValue,
} from "../lib/walk.ts";
import { loadExtension } from "./load-extension.ts";

const policy = loadContract({}).policy;

/** The repo root: `.pi/extensions/associate` → three levels up. */
const repoRoot = dirname(dirname(dirname(extensionDir)));

function recorderIn(dir: string, options: Record<string, unknown> = {}): WalkRecorder {
  return new WalkRecorder({ exportDir: dir, policy, installExitHook: false, ...options });
}

function readLines(dir: string): Array<Record<string, unknown>> {
  return readFileSync(join(dir, WALK_FILENAME), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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

entry_schema = contract.walk_entry_schema()
run_schema = contract.walk_run_schema()
lines = [l for l in Path(sys.argv[1]).read_text().splitlines() if l.strip()]
problems = []
for index, line in enumerate(lines, start=1):
    record = json.loads(line)
    schema = run_schema if set(record) == {"run"} else entry_schema
    instance = record["run"] if set(record) == {"run"} else record
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
    await pi.fireToolCall({ toolName: "read", toolCallId: "x1", input: { path: "a.ts" } });
    for (const handler of pi.handlers.get("tool_result") ?? []) {
      await handler({ toolName: "read", toolCallId: "x1", input: { path: "a.ts" }, content: "hi" });
    }
    for (const handler of pi.handlers.get("session_shutdown") ?? []) {
      await handler({ reason: "quit" });
    }

    const lines = readFileSync(walkPath, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    assert.equal(lines[0].id, "w1");
    assert.equal(lines[0].tool, "read");
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
