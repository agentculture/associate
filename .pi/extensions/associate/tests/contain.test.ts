// Tests for the containment library (task t3, plan
// associate-on-pi-with-opinionated-tools).
//
// Every budget, cap and pattern under test is read from the REAL contract at
// associate/contract/policy.json — never a literal in this file. That is the
// point of the exercise: if the policy changes, these tests follow it.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  boundOutput,
  confine,
  gitignoreMatcher,
  isDenylisted,
  makeStructuredError,
  nextChunk,
  refusePatternEscape,
  validateArgs,
} from "../lib/contain.ts";
import type { Policy } from "../lib/contain.ts";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const POLICY: Policy = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "associate", "contract", "policy.json"), "utf8"),
);

function tmpdir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function isStructuredError(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.ok !== false) return false;
  const err = obj.error as Record<string, unknown> | undefined;
  return (
    typeof err === "object" &&
    err !== null &&
    typeof err.code === "string" &&
    typeof err.message === "string"
  );
}

// ---------------------------------------------------------------------------
// criterion 1 — confinement and pattern escape
// ---------------------------------------------------------------------------

test("policy.json fixture carries the keys these tests depend on", () => {
  assert.ok(Array.isArray(POLICY.read.denylist) && POLICY.read.denylist.length > 0);
  assert.equal(typeof POLICY.budgets.read.max_output_chars, "number");
  assert.equal(typeof POLICY.budgets.read.max_lines, "number");
  assert.equal(typeof POLICY.caps.max_results, "number");
});

test("confine resolves a path inside the root", () => {
  const root = tmpdir("contain-confine-");
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "a.txt"), "hi");
  const result = confine(root, "sub/a.txt");
  assert.equal(result.ok, true);
  assert.equal(result.path, path.join(root, "sub", "a.txt"));
});

test("confine allows the root itself", () => {
  const root = tmpdir("contain-confine-root-");
  const result = confine(root, ".");
  assert.equal(result.ok, true);
  assert.equal(result.path, root);
});

test("confine refuses ../outside-root with a structured error", () => {
  const root = tmpdir("contain-escape-");
  const result = confine(root, "../outside-root");
  assert.equal(result.ok, false);
  assert.ok(isStructuredError(result));
  assert.equal(result.error.code, "path_escapes_root");
  assert.equal(result.error.field, "path");
  assert.equal(result.field, "path");
  assert.match(result.error.message, /escapes/);
});

test("confine refuses an absolute path outside the root", () => {
  const root = tmpdir("contain-abs-");
  const result = confine(root, "/etc/passwd");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "path_escapes_root");
});

test("confine refuses a symlink that points outside the root", () => {
  const root = tmpdir("contain-symlink-");
  const outside = tmpdir("contain-symlink-outside-");
  fs.writeFileSync(path.join(outside, "secret.txt"), "s");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
  const result = confine(root, "link.txt");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "path_escapes_root");
});

test("confine accepts an absolute path that is inside the root", () => {
  const root = tmpdir("contain-abs-inside-");
  const result = confine(root, path.join(root, "nested", "f.txt"));
  assert.equal(result.ok, true);
});

test("a grep pattern containing ../ is refused with a structured error", () => {
  const refused = refusePatternEscape("../../etc/*");
  assert.notEqual(refused, null);
  assert.ok(isStructuredError(refused));
  assert.equal(refused.error.code, "pattern_escapes_root");
  assert.equal(refused.field, "pattern");
});

test("refusePatternEscape also catches backslash separators", () => {
  assert.notEqual(refusePatternEscape("..\\windows\\system32"), null);
});

test("refusePatternEscape passes a benign pattern and a literal dotdot substring", () => {
  assert.equal(refusePatternEscape("src/**/*.ts"), null);
  // "..." is not a ".." path *component*, so it is not an escape.
  assert.equal(refusePatternEscape("foo...bar"), null);
});

// ---------------------------------------------------------------------------
// criterion 2 — output budget, spill to disk, continuation cursor
// ---------------------------------------------------------------------------

function fiveMegabytes(): string {
  const line = "x".repeat(99);
  const target = 5 * 1024 * 1024;
  const lines: string[] = [];
  let size = 0;
  let n = 0;
  while (size < target) {
    const entry = `line ${n} ${line}`;
    lines.push(entry);
    size += entry.length + 1;
    n += 1;
  }
  return lines.join("\n");
}

test("a 5 MB input is bounded at the policy budget and spills to disk", () => {
  const spillDir = path.join(tmpdir("contain-spill-"), "tool-output");
  const text = fiveMegabytes();
  assert.ok(text.length >= 5 * 1024 * 1024);

  const budget = POLICY.budgets.read;
  const result = boundOutput(text, budget, spillDir);

  assert.equal(result.truncated, true);
  assert.ok(
    result.text.length <= budget.max_output_chars,
    `bounded text ${result.text.length} exceeds budget ${budget.max_output_chars}`,
  );
  assert.ok(result.text.split("\n").length <= budget.max_lines);
  assert.ok(typeof result.spillPath === "string");
  assert.ok(fs.existsSync(result.spillPath as string));
  assert.equal(fs.readFileSync(result.spillPath as string, "utf8"), text);
  // owner-only, ported from colleague's _SPILL_FILE_MODE
  assert.equal(fs.statSync(result.spillPath as string).mode & 0o777, 0o600);
  assert.ok(result.text.includes(result.spillPath as string));
});

test("a short input is returned unchanged and nothing touches disk", () => {
  const spillDir = path.join(tmpdir("contain-nospill-"), "tool-output");
  const result = boundOutput("hello\nworld", POLICY.budgets.read, spillDir);
  assert.equal(result.truncated, false);
  assert.equal(result.text, "hello\nworld");
  assert.equal(result.spillPath, undefined);
  assert.equal(result.cursor, undefined);
  assert.equal(fs.existsSync(spillDir), false);
});

test("spill_to_disk=false truncates without writing a file", () => {
  const spillDir = path.join(tmpdir("contain-spilloff-"), "tool-output");
  const budget = { ...POLICY.budgets.read, spill_to_disk: false };
  const result = boundOutput(fiveMegabytes(), budget, spillDir);
  assert.equal(result.truncated, true);
  assert.equal(result.spillPath, undefined);
  assert.equal(fs.existsSync(spillDir), false);
  assert.ok(result.text.length <= budget.max_output_chars);
});

test("a continuation cursor re-enters at the right offset", () => {
  const spillDir = path.join(tmpdir("contain-cursor-"), "tool-output");
  const text = fiveMegabytes();
  const result = boundOutput(text, POLICY.budgets.read, spillDir);

  const cursor = result.cursor;
  assert.ok(cursor, "a truncated result must carry a continuation cursor");
  assert.equal(cursor.total, text.length);
  assert.ok(cursor.offset > 0 && cursor.offset < text.length);

  const chunk = nextChunk(text, cursor);
  assert.equal(chunk.text, text.slice(cursor.offset, cursor.offset + chunk.text.length));
  assert.ok(chunk.text.length > 0);
  assert.ok(chunk.text.length <= POLICY.budgets.read.max_output_chars);
  assert.equal(chunk.truncated, true);
  assert.ok(chunk.cursor);
  assert.equal(chunk.cursor.offset, cursor.offset + chunk.text.length);
});

test("continuation walks the whole source and ends with a null cursor", () => {
  const budget = { max_output_chars: 200, max_lines: 5, spill_to_disk: false };
  const text = Array.from({ length: 60 }, (_, i) => `row ${i}`).join("\n");
  let cursor = { offset: 0, total: text.length, chunkChars: budget.max_output_chars };
  let seen = "";
  let guard = 0;
  for (;;) {
    const chunk = nextChunk(text, cursor);
    seen += chunk.text;
    if (!chunk.cursor) break;
    cursor = chunk.cursor;
    guard += 1;
    assert.ok(guard < 1000, "continuation did not terminate");
  }
  assert.equal(seen, text);
});

test("nextChunk can re-enter from a spilled file", () => {
  const spillDir = path.join(tmpdir("contain-cursor-spill-"), "tool-output");
  const text = fiveMegabytes();
  const result = boundOutput(text, POLICY.budgets.read, spillDir);
  const chunk = nextChunk({ spillPath: result.spillPath as string }, result.cursor!);
  assert.equal(chunk.text, text.slice(result.cursor!.offset, result.cursor!.offset + chunk.text.length));
});

test("a byte budget alone is enough to force truncation", () => {
  const spillDir = path.join(tmpdir("contain-bytes-"), "tool-output");
  const text = "é".repeat(400); // 400 chars, 800 bytes
  const budget = { max_output_chars: 10_000, max_lines: 1000, max_bytes: 500, spill_to_disk: true };
  const result = boundOutput(text, budget, spillDir);
  assert.equal(result.truncated, true);
});

// ---------------------------------------------------------------------------
// criterion 3 — denylist and argument validation
// ---------------------------------------------------------------------------

test("a read of .env is refused", () => {
  const refused = isDenylisted(".env", POLICY);
  assert.notEqual(refused, null);
  assert.ok(isStructuredError(refused));
  assert.equal(refused.error.code, "path_denied");
  assert.equal(refused.field, "path");
});

test("a nested .env and an .env.local variant are refused", () => {
  assert.notEqual(isDenylisted("config/.env", POLICY), null);
  assert.notEqual(isDenylisted(".env.local", POLICY), null);
});

test("files matched by the secret patterns are refused", () => {
  for (const rel of [
    "keys/server.pem",
    "keys/server.key",
    "home/.ssh/id_rsa",
    "home/.aws/credentials",
    "src/my_secret_notes.txt",
    "src/api_key.json",
    "src/session_token.txt",
    ".netrc",
  ]) {
    assert.notEqual(isDenylisted(rel, POLICY), null, `${rel} should be denied`);
  }
});

test("an ordinary source file is not denied", () => {
  assert.equal(isDenylisted("associate/cli/__init__.py", POLICY), null);
  assert.equal(isDenylisted("README.md", POLICY), null);
});

test("a path ignored by the checkout's .gitignore is refused", () => {
  const matcher = gitignoreMatcher(
    ["# comment", "", "build/", "*.log", "/root-only.txt", "node_modules", "!keep.log"].join("\n"),
  );
  assert.notEqual(isDenylisted("build/out.js", POLICY, matcher), null);
  assert.notEqual(isDenylisted("deep/debug.log", POLICY, matcher), null);
  assert.notEqual(isDenylisted("root-only.txt", POLICY, matcher), null);
  assert.notEqual(isDenylisted("node_modules/pkg/index.js", POLICY, matcher), null);
  // negation wins
  assert.equal(isDenylisted("keep.log", POLICY, matcher), null);
  // leading-slash pattern is anchored at the root
  assert.equal(isDenylisted("sub/root-only.txt", POLICY, matcher), null);
  assert.equal(isDenylisted("src/main.ts", POLICY, matcher), null);
});

test("respect_gitignore=false ignores the matcher", () => {
  const matcher = gitignoreMatcher("build/");
  const policy: Policy = {
    ...POLICY,
    read: { ...POLICY.read, respect_gitignore: false },
  };
  assert.equal(isDenylisted("build/out.js", policy, matcher), null);
});

test("gitignoreMatcher handles ** globs", () => {
  const matcher = gitignoreMatcher(["**/dist/**", "docs/**/*.tmp"].join("\n"));
  assert.equal(matcher("a/b/dist/x/y.js"), true);
  assert.equal(matcher("docs/a/b/c.tmp"), true);
  assert.equal(matcher("docs/a.txt"), false);
});

test("validateArgs returns null for a valid argument set", () => {
  const schema = {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string" },
      limit: { type: "integer" },
      mode: { type: "string", enum: ["head", "tail"] },
      globs: { type: "array", items: { type: "string" } },
    },
  };
  assert.equal(
    validateArgs(schema, { path: "a.txt", limit: 10, mode: "head", globs: ["*.ts"] }),
    null,
  );
});

test("validateArgs returns {error, field} naming the offending field", () => {
  const schema = {
    type: "object",
    required: ["path"],
    properties: { path: { type: "string" }, limit: { type: "integer" } },
  };

  const missing = validateArgs(schema, { limit: 1 });
  assert.ok(isStructuredError(missing));
  assert.equal(missing.field, "path");
  assert.equal(missing.error.code, "invalid_argument");
  assert.match(missing.error.message, /required/);

  const wrongType = validateArgs(schema, { path: 7 });
  assert.ok(isStructuredError(wrongType));
  assert.equal(wrongType.field, "path");
  assert.match(wrongType.error.message, /string/);

  // a bool must not validate as an integer (mirrors validate.py's carve-out)
  const boolAsInt = validateArgs(schema, { path: "a", limit: true });
  assert.ok(isStructuredError(boolAsInt));
  assert.equal(boolAsInt.field, "limit");
});

test("validateArgs checks enum, pattern, items and nested properties", () => {
  const enumErr = validateArgs(
    { type: "object", properties: { mode: { type: "string", enum: ["a", "b"] } } },
    { mode: "c" },
  );
  assert.equal(enumErr?.field, "mode");

  const patternErr = validateArgs(
    { type: "object", properties: { sha: { type: "string", pattern: "^[0-9a-f]{7}$" } } },
    { sha: "zzz" },
  );
  assert.equal(patternErr?.field, "sha");

  const itemErr = validateArgs(
    { type: "object", properties: { globs: { type: "array", items: { type: "string" } } } },
    { globs: ["ok", 3] },
  );
  assert.equal(itemErr?.field, "globs[1]");

  const nestedErr = validateArgs(
    {
      type: "object",
      properties: { opts: { type: "object", required: ["depth"], properties: { depth: { type: "integer" } } } },
    },
    { opts: {} },
  );
  assert.equal(nestedErr?.field, "opts.depth");
});

test("validateArgs resolves a local $ref and rejects a foreign one", () => {
  const schema = {
    $defs: { name: { type: "string", pattern: "^[a-z]+$" } },
    type: "object",
    properties: { who: { $ref: "#/$defs/name" } },
  };
  assert.equal(validateArgs(schema, { who: "abc" }), null);
  assert.equal(validateArgs(schema, { who: "A1" })?.field, "who");

  const foreign = validateArgs(
    { type: "object", properties: { who: { $ref: "https://example.invalid/s.json" } } },
    { who: "x" },
  );
  assert.ok(isStructuredError(foreign));
  assert.equal(foreign.error.code, "invalid_schema");
});

test("validateArgs rejects a non-object argument set against an object schema", () => {
  const err = validateArgs({ type: "object" }, "nope");
  assert.ok(isStructuredError(err));
  assert.equal(err.field, "$");
});

test("makeStructuredError has one uniform shape", () => {
  const err = makeStructuredError("some_code", "some message", "some_field");
  assert.deepEqual(err.error, {
    code: "some_code",
    message: "some message",
    field: "some_field",
  });
  assert.equal(err.ok, false);
  assert.equal(err.code, "some_code");
  assert.equal(err.message, "some message");
  assert.equal(err.field, "some_field");

  const noField = makeStructuredError("c", "m");
  assert.equal("field" in noField.error, false);
  assert.equal(noField.field, undefined);
});
