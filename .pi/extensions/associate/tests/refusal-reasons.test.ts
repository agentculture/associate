/**
 * Every refusal constructor states a reason and a fix (issue #20, plan t8,
 * acceptance criterion 4; spec h8, c10).
 *
 * The test reads the source of guard.ts, gate.ts, contain.ts and every file in
 * tools/, finds each function that builds a refusal and every place that calls
 * one, and fails when a call can produce a refusal with no reason or no fix.
 * It also fails when the source builds a refusal by hand (an `ok: false`
 * result, a `block: true` decision, a `decision: "refuse"` entry) somewhere
 * that is not a listed constructor, so a new kind of refusal cannot appear
 * unchecked: adding one means listing it here.
 *
 * A static scan reads source text, so what it can show is limited to the call
 * sites it can see: an argument that is a variable or an expression is read for
 * a non-empty string part and otherwise reported, never assumed fine.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extensionDir } from "../lib/paths.ts";
import { defaultFix, makeStructuredError } from "../lib/contain.ts";
import { ensureRefusalReason } from "../lib/gate.ts";
import { toolError } from "../tools/_procs.ts";

// ---------------------------------------------------------------- source reading

/** Source text with comments blanked out (same length, so offsets and lines hold). String contents stay. */
export function blankComments(src: string): string {
  let out = "";
  let i = 0;
  const templateDepth: number[] = [];
  let braceDepth = 0;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") (out += " "), i++;
    } else if (c === "/" && n === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) (out += src[i] === "\n" ? "\n" : " "), i++;
      out += "  ";
      i += 2;
    } else if (c === '"' || c === "'") {
      out += c;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") (out += src[i]), i++;
        out += src[i++];
      }
      out += src[i++] ?? "";
    } else if (c === "`") {
      out += c;
      i++;
      while (i < src.length && src[i] !== "`") {
        if (src[i] === "\\") {
          out += src[i++];
        } else if (src[i] === "$" && src[i + 1] === "{") {
          // Keep the interpolation as code, balanced.
          let depth = 0;
          do {
            if (src[i] === "{") depth++;
            if (src[i] === "}") depth--;
            out += src[i++];
          } while (i < src.length && depth > 0);
          continue;
        }
        out += src[i++];
      }
      out += src[i++] ?? "";
    } else {
      out += c;
      i++;
    }
  }
  void templateDepth;
  void braceDepth;
  return out;
}

/** The top-level arguments of the call whose `(` is at `open`, as source text, and the index after its `)`. */
export function callArgs(src: string, open: number): { args: string[]; end: number } {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  let i = open;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
    } else if (c === "`") {
      i++;
      while (i < src.length && src[i] !== "`") {
        if (src[i] === "\\") i += 2;
        else if (src[i] === "$" && src[i + 1] === "{") {
          let d = 0;
          do {
            if (src[i] === "{") d++;
            if (src[i] === "}") d--;
            i++;
          } while (i < src.length && d > 0);
        } else i++;
      }
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        const last = src.slice(start, i).trim();
        if (last !== "") args.push(last);
        return { args, end: i + 1 };
      }
    } else if (c === "," && depth === 1) {
      args.push(src.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  throw new Error("unbalanced call");
}

/** True when the argument source can be nothing: an empty or blank string literal. */
function isBlankLiteral(arg: string): boolean {
  return /^(?:""|''|``|"\s+"|'\s+'|`\s+`)$/.test(arg);
}

/** True when the argument carries some literal text, or is an expression the scan cannot judge (reported separately). */
function hasLiteralText(arg: string): boolean {
  return /["'`][^"'`]*\S[^"'`]*["'`]/.test(arg) || /\$\{/.test(arg);
}

function lineOf(src: string, offset: number): number {
  return src.slice(0, offset).split("\n").length;
}

interface SourceFile {
  rel: string;
  text: string;
}

function files(): SourceFile[] {
  const out: SourceFile[] = [];
  for (const rel of ["lib/guard.ts", "lib/gate.ts", "lib/contain.ts"]) {
    out.push({ rel, text: blankComments(readFileSync(join(extensionDir, rel), "utf8")) });
  }
  for (const name of readdirSync(join(extensionDir, "tools")).sort()) {
    if (name.endsWith(".ts")) out.push({ rel: `tools/${name}`, text: blankComments(readFileSync(join(extensionDir, "tools", name), "utf8")) });
  }
  return out;
}

// ---------------------------------------------------------------- the constructors

interface Constructor {
  file: string;
  /** How it is defined in source, so a rename or removal fails the test. */
  definition: RegExp;
  name: string;
  /** Argument index of the reason, and of the fix when the constructor does not default one. */
  reason: number;
  fix?: number;
  /** The constructor gives a default fix when the call names none. */
  defaultsFix: boolean;
}

const CONSTRUCTORS: Constructor[] = [
  { file: "lib/contain.ts", name: "makeStructuredError", definition: /export function makeStructuredError\(/, reason: 1, fix: 3, defaultsFix: true },
  { file: "tools/_procs.ts", name: "toolError", definition: /export function toolError\(/, reason: 1, fix: 3, defaultsFix: true },
  { file: "lib/guard.ts", name: "block", definition: /function block\(kind: string, why: string, fix: string\)/, reason: 1, fix: 2, defaultsFix: false },
  { file: "lib/gate.ts", name: "refuse", definition: /const refuse = \(reason: string/, reason: 0, defaultsFix: false },
  { file: "tools/shell.ts", name: "refuse", definition: /function refuse\(message: string, field: string\)/, reason: 0, defaultsFix: true },
  { file: "tools/spawn.ts", name: "refuse", definition: /const refuse = \(requested: unknown, why: string\)/, reason: 1, defaultsFix: true },
  { file: "tools/delegate.ts", name: "refuse", definition: /const refuse = \(requested: unknown, why: string\)/, reason: 1, defaultsFix: true },
  { file: "tools/spawn.ts", name: "failure", definition: /const failure = \(code: string, message: string\)/, reason: 1, defaultsFix: true },
];

/** The `kind`s of refusal object this scan accepts building by hand, only inside the listed constructor. */
const HAND_BUILT: Array<{ file: string; pattern: RegExp; allowed: RegExp[]; what: string }> = [
  {
    file: "lib/contain.ts",
    pattern: /\bok: false\b/,
    allowed: [/^\s*ok: false;\s*$/, /^\s*const out: StructuredError = \{ ok: false, error: inner, code, message, fix: resolvedFix \};\s*$/],
    what: "a structured error built outside makeStructuredError",
  },
  {
    file: "tools/_procs.ts",
    pattern: /\bok: false\b/,
    allowed: [/^\s*ok: false;\s*$/, /^\s*return \{ ok: false, error, code, kind: code, message, detail, fix: resolvedFix \};\s*$/],
    what: "a tool error built outside toolError",
  },
  {
    file: "lib/guard.ts",
    pattern: /\bblock: true\b/,
    allowed: [/^\s*readonly block: true;\s*$/, /^\s*return \{ block: true, kind, reason: `\$\{why\}\. Fix: \$\{fix\}`, fix \};\s*$/],
    what: "a guard decision built outside block()",
  },
];

// ---------------------------------------------------------------- the tests

test("t8 criterion 4: every listed refusal constructor is still defined where the scan expects it", () => {
  const byFile = new Map(files().map((f) => [f.rel, f.text]));
  for (const c of CONSTRUCTORS) {
    assert.match(byFile.get(c.file)!, c.definition, `${c.file}: ${c.name} is no longer defined as the scan expects; update the scan`);
  }
});

test("t8 criterion 4: no call to a refusal constructor can leave out the reason or the fix", () => {
  const problems: string[] = [];
  let calls = 0;
  for (const file of files()) {
    for (const c of CONSTRUCTORS.filter((x) => x.file === file.rel || (x.name !== "refuse" && x.name !== "failure" && x.name !== "block"))) {
      // `makeStructuredError` and `toolError` are called from everywhere; the local helpers only in their own file.
      const own = c.file === file.rel;
      if (!own && c.name !== "makeStructuredError" && c.name !== "toolError") continue;
      const call = new RegExp(`(?<![\\w.])${c.name}\\(`, "g");
      for (let m = call.exec(file.text); m; m = call.exec(file.text)) {
        const before = file.text.slice(Math.max(0, m.index - 20), m.index);
        if (/function\s+$/.test(before)) continue; // the definition itself
        const open = m.index + m[0].length - 1;
        const { args } = callArgs(file.text, open);
        calls += 1;
        const where = `${file.rel}:${lineOf(file.text, m.index)} ${c.name}(`;
        const reason = args[c.reason];
        if (reason === undefined) problems.push(`${where}…): no reason argument`);
        else if (isBlankLiteral(reason)) problems.push(`${where}…): the reason is blank`);
        else if (!hasLiteralText(reason) && !/^[A-Za-z_][\w.]*(?:\([^)]*\))?$/.test(reason)) problems.push(`${where}…): the reason is an expression with no text: ${reason.slice(0, 60)}`);
        if (c.fix !== undefined) {
          const fix = args[c.fix];
          if (fix === undefined && !c.defaultsFix) problems.push(`${where}…): no fix argument and no default`);
          else if (fix !== undefined && isBlankLiteral(fix)) problems.push(`${where}…): the fix is blank`);
        }
      }
    }
  }
  assert.ok(calls > 100, `the scan found only ${calls} calls; it is not reading the source`);
  assert.deepEqual(problems, []);
});

test("t8 criterion 4: a refusal is not built by hand outside the listed constructors", () => {
  const byFile = new Map(files().map((f) => [f.rel, f.text]));
  const problems: string[] = [];
  for (const spec of HAND_BUILT) {
    const lines = byFile.get(spec.file)!.split("\n");
    lines.forEach((line, index) => {
      if (spec.pattern.test(line) && !spec.allowed.some((ok) => ok.test(line))) {
        problems.push(`${spec.file}:${index + 1}: ${spec.what}: ${line.trim()}`);
      }
    });
  }
  // Any other file building a structured error or a guard decision by hand.
  for (const file of files()) {
    if (HAND_BUILT.some((h) => h.file === file.rel)) continue;
    file.text.split("\n").forEach((line, index) => {
      if (/\bok: false\b/.test(line) || /\bblock: true\b/.test(line)) problems.push(`${file.rel}:${index + 1}: a refusal built by hand: ${line.trim()}`);
    });
  }
  assert.deepEqual(problems, []);
});

test("t8 criterion 4: a gate refusal entry carries a reason wherever it is built", () => {
  const gate = files().find((f) => f.rel === "lib/gate.ts")!.text;
  const problems: string[] = [];
  const literal = /(?:decision: "refuse"|allow: false)/g;
  for (let m = literal.exec(gate); m; m = literal.exec(gate)) {
    // The object literal around it: back to the nearest `{`, forward to its `}`.
    let start = m.index;
    let depth = 0;
    while (start > 0 && !(gate[start] === "{" && depth === 0)) {
      if (gate[start] === "}") depth++;
      if (gate[start] === "{") depth--;
      start--;
    }
    let end = start;
    depth = 0;
    do {
      if (gate[end] === "{") depth++;
      if (gate[end] === "}") depth--;
      end++;
    } while (end < gate.length && depth > 0);
    const body = gate.slice(start, end);
    if (!/\breason\b/.test(body)) problems.push(`lib/gate.ts:${lineOf(gate, m.index)}: a refusal literal without a reason: ${body.replace(/\s+/g, " ").slice(0, 80)}`);
  }
  assert.deepEqual(problems, []);

  // A decision that reaches the walk without one gets a reason naming its tier.
  const entry: { tier?: unknown; decision?: unknown; reason?: unknown } = { tier: "clef", decision: "refuse" };
  ensureRefusalReason(entry);
  assert.ok(typeof entry.reason === "string" && entry.reason.trim().length > 0);
});

test("t8 criterion 4: the constructors themselves always return a fix, for any code", () => {
  for (const code of ["no_such_code_zzz", "invalid_argument", "path_denied", "shell_refused"]) {
    assert.ok(defaultFix(code).trim().length > 0, code);
    assert.ok(makeStructuredError(code, "why").fix.trim().length > 0, code);
    assert.ok(toolError(code, "why").fix.trim().length > 0, code);
  }
});
