/**
 * Every structured refusal a tool hands the model carries a fix (issue #20 t7,
 * acceptance criterion 3; spec c10/h21).
 *
 * `makeStructuredError` (lib/contain.ts) and `toolError` (tools/_procs.ts)
 * are the two constructors every tool's refusal goes through. Each error code
 * the extension's source passes to either one is collected from the source
 * itself, so a new code cannot slip in without a fix.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extensionDir } from "../lib/paths.ts";
import { makeStructuredError } from "../lib/contain.ts";
import { fromContainError, toolError, toolResult } from "../tools/_procs.ts";

function sources(): string[] {
  const out: string[] = [];
  for (const dir of ["lib", "tools"]) {
    for (const name of readdirSync(join(extensionDir, dir))) {
      if (name.endsWith(".ts")) out.push(readFileSync(join(extensionDir, dir, name), "utf8"));
    }
  }
  return out;
}

/** Every string-literal code passed to makeStructuredError / toolError, and every `*_REFUSED`-style constant they use. */
function codesInSource(): Set<string> {
  const codes = new Set<string>();
  const constants = new Map<string, string>();
  for (const text of sources()) {
    for (const m of text.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]+)\s*=\s*"([a-z][a-z0-9_]*)"/g)) constants.set(m[1]!, m[2]!);
  }
  for (const text of sources()) {
    for (const m of text.matchAll(/(?:makeStructuredError|toolError)\(\s*(?:"([a-z][a-z0-9_]*)"|([A-Z][A-Z0-9_]+))/g)) {
      if (m[1]) codes.add(m[1]);
      else if (constants.has(m[2]!)) codes.add(constants.get(m[2]!)!);
    }
  }
  return codes;
}

test("t7 criterion 3: the source scan finds the refusal codes (sanity)", () => {
  const codes = codesInSource();
  for (const code of ["invalid_argument", "path_escapes_root", "path_denied", "invalid_args", "tool_missing"]) {
    assert.ok(codes.has(code), `${code} not found by the scan: ${[...codes].join(", ")}`);
  }
});

test("t7 criterion 3: makeStructuredError carries a fix for every code the source uses, and an explicit fix wins", () => {
  for (const code of codesInSource()) {
    for (const field of [undefined, "path"]) {
      const err = makeStructuredError(code, "m", field);
      assert.equal(typeof err.fix, "string", code);
      assert.ok(err.fix.trim().length > 0, code);
      assert.equal(err.message, "m");
    }
  }
  assert.equal(makeStructuredError("invalid_argument", "m", "limit", "pass limit as a number").fix, "pass limit as a number");
  // A blank explicit fix falls back to the default rather than shipping nothing.
  assert.ok(makeStructuredError("invalid_argument", "m", "limit", "  ").fix.trim().length > 0);
  // The model reads the JSON text: the fix is in it.
  assert.match(JSON.stringify(makeStructuredError("path_escapes_root", "m", "path")), /"fix":"[^"]+"/);
});

test("t7 criterion 3: toolError carries a fix for every code the source uses, in the error and at the top level", () => {
  for (const code of codesInSource()) {
    const err = toolError(code, "m", { field: "x" });
    assert.ok(typeof err.fix === "string" && err.fix.trim().length > 0, code);
    assert.equal(err.error.fix, err.fix, code);
  }
  const explicit = toolError("invalid_args", "m", {}, "send only 'model' and 'task'");
  assert.equal(explicit.fix, "send only 'model' and 'task'");
  assert.match(toolResult(explicit).content[0]!.text, /send only 'model' and 'task'/);
});

test("t7 criterion 3: fromContainError keeps the structured error's fix", () => {
  const contain = makeStructuredError("path_denied", "read of '.env' is refused", "path", "read another file");
  const wrapped = fromContainError(contain, { path: ".env" });
  assert.equal(wrapped.fix, "read another file");
  assert.equal(wrapped.error.fix, "read another file");
});
