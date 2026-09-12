// Containment library for the associate Pi extension — the permission
// boundary every tool in this extension goes through before it touches a
// path, spends output budget, or trusts an argument set.
//
// Covers plan claims c21 (in-tool argument validation + explicit continuation
// cursors), c29 (containment guards ported before features), c36 (secrets do
// not ride along: denylist + .gitignore), under decision c33 (colleague's base
// tools are ported case by case, origin recorded).
//
// ORIGINS — ported case by case from colleague (decision c33). Paths are
// relative to the colleague repository root; the ledger row recording these
// ports and the drift answer is another task's deliverable.
//
//   confine()             <- colleague/colleague/search_tools.py:90-101
//                            (`confine`, itself mirroring
//                            ToolExecutor._safe_path at colleague/tools.py:844-849)
//   refusePatternEscape() <- colleague/colleague/search_tools.py:105-118
//                            (`_refuse_pattern_escape`)
//   boundOutput()         <- colleague/colleague/readpage.py (`bound_output`)
//                            delegating to colleague/colleague/truncation.py:189-255
//                            (`truncate_output`), :128-172 (`_head_and_tail`),
//                            :175-186 (`_bounded_preview`) and :258-301
//                            (`_create_spill_file`, the O_EXCL|O_NOFOLLOW
//                            symlink-plant fix, finding #441-5/A)
//   validateArgs()        <- associate/contract/validate.py (this repo) — the
//                            same draft-2020-12 subset: type, required,
//                            properties, items, enum, pattern, local $ref
//
// DELIBERATE DIVERGENCES from the colleague originals:
//   * Errors are returned, never thrown. colleague raises ToolError; a Pi tool
//     has to hand the model a corrective, retryable object (c21/h15), so every
//     refusal here is a structured error value with a uniform shape.
//   * colleague's 500 MB per-session spill cap (truncation.MAX_SESSION_SPILL_BYTES)
//     is NOT ported: the contract has no policy key for it, and every budget
//     here must come from the loaded policy rather than a literal. Add the key
//     to associate/contract/policy.json first if the cap is wanted.
//   * colleague reads its budgets from env vars (COLLEAGUE_MAX_OUTPUT_CHARS,
//     COLLEAGUE_TOOL_SPILL); here they are parameters taken from the caller's
//     parsed policy. This module never reads policy.json itself.
//
// Node built-ins only (fs, path, crypto) — no npm packages, no build step.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types — the shape of associate/contract/policy.json, as far as this module
// cares. Everything optional is genuinely optional at the call site.
// ---------------------------------------------------------------------------

export interface Budget {
  max_output_chars: number;
  max_lines?: number;
  max_bytes?: number;
  spill_to_disk?: boolean;
}

export interface Policy {
  version?: number;
  read: {
    confine_to_session_root?: boolean;
    refuse_parent_path_segments?: boolean;
    respect_gitignore?: boolean;
    line_numbers?: string;
    denylist: string[];
  };
  budgets: {
    read: Budget;
    shell?: Budget;
    web?: Budget;
  };
  caps: {
    max_results?: number;
    max_raw_chars?: number;
    max_fetches_per_run?: number;
  };
  [key: string]: unknown;
}

export interface StructuredError {
  ok: false;
  /** The canonical error payload (c21: a corrective error the model can retry on). */
  error: { code: string; message: string; field?: string };
  /** Mirrors of `error.*`, so `{ error, code, field }` destructuring works. */
  code: string;
  message: string;
  field?: string;
}

export interface ConfineOk {
  ok: true;
  path: string;
}

export type ConfineResult = ConfineOk | StructuredError;

export interface Cursor {
  /** Character offset into the source where the next chunk begins. */
  offset: number;
  /** Total length, in characters, of the source being paged. */
  total: number;
  /** Characters to hand back per continuation chunk. */
  chunkChars: number;
  /** Set when the untruncated source was spilled to disk. */
  spillPath?: string;
}

export interface BoundedOutput {
  text: string;
  truncated: boolean;
  spillPath?: string;
  cursor?: Cursor;
}

export interface ChunkResult {
  text: string;
  truncated: boolean;
  cursor: Cursor | null;
}

export type GitignoreMatcher = (rel: string) => boolean;

// ---------------------------------------------------------------------------
// The uniform error object
// ---------------------------------------------------------------------------

/**
 * Build the one error shape every export in this module returns.
 *
 * `{ ok: false, error: { code, message, field? } }` is the canonical payload;
 * `code` / `message` / `field` are mirrored at the top level so a caller can
 * write `const { error, field } = result` without reaching two levels down.
 */
export function makeStructuredError(
  code: string,
  message: string,
  field?: string,
): StructuredError {
  const inner: { code: string; message: string; field?: string } = { code, message };
  if (field !== undefined) inner.field = field;
  const out: StructuredError = { ok: false, error: inner, code, message };
  if (field !== undefined) out.field = field;
  return out;
}

// ---------------------------------------------------------------------------
// Confinement — colleague/colleague/search_tools.py:90-118
// ---------------------------------------------------------------------------

/**
 * Resolve *p* the way Python's `Path.resolve()` does: follow symlinks for the
 * part of the path that exists, and append the (non-existent) remainder
 * lexically. Without this, a confine() check on a path that does not exist yet
 * would silently skip symlink resolution.
 */
function resolveFollowingSymlinks(p: string): string {
  const absolute = path.resolve(p);
  let current = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute; // reached the filesystem root
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve *rel* under *root*, refusing anything that escapes it.
 *
 * Ported from `confine` (colleague/colleague/search_tools.py:90): resolve
 * following symlinks, then require the candidate to equal the root or sit
 * beneath it. An absolute *rel* pointing outside the root is refused by the
 * same check, since `path.resolve` lets it win over the root.
 */
export function confine(root: string, rel: string): ConfineResult {
  const rootResolved = resolveFollowingSymlinks(root);
  const candidate = resolveFollowingSymlinks(path.resolve(rootResolved, rel));
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + path.sep)) {
    return makeStructuredError(
      "path_escapes_root",
      `path '${rel}' escapes the session root`,
      "path",
    );
  }
  return { ok: true, path: candidate };
}

/**
 * Refuse a glob/grep pattern containing a literal `..` path segment.
 *
 * Ported from `_refuse_pattern_escape` (colleague/colleague/search_tools.py:105).
 * `confine()` catches an escaping *path* argument; a *pattern* is never
 * resolved as a path, so a hostile `../../etc/*` would just fail to match
 * anything. Refuse it outright so the caller sees an error rather than a
 * silent empty result.
 */
export function refusePatternEscape(pattern: string): StructuredError | null {
  const parts = pattern.replace(/\\/g, "/").split("/");
  if (parts.some((part) => part === "..")) {
    return makeStructuredError(
      "pattern_escapes_root",
      `pattern '${pattern}' escapes the session root`,
      "pattern",
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Denylist (c36) — policy.read.denylist plus the checkout's .gitignore
// ---------------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Translate a glob (the dialect both policy.read.denylist and .gitignore use)
 * into a regular expression source string.
 *
 * `**` spans separators (and `**\/` also matches zero directories, so
 * `**\/.aws/*` matches `.aws/config` as well as `home/.aws/config`); a single
 * `*` and `?` stop at a separator.
 */
function globToRegExpSource(glob: string): string {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const char = glob[i];
    if (char === "*") {
      let j = i;
      while (glob[j] === "*") j += 1;
      if (j - i >= 2) {
        if (glob[j] === "/") {
          out += "(?:.*/)?";
          i = j + 1;
        } else {
          out += ".*";
          i = j;
        }
      } else {
        out += "[^/]*";
        i = j;
      }
    } else if (char === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += escapeRegExp(char);
      i += 1;
    }
  }
  return out;
}

function normalizeRel(rel: string): string {
  let normalized = rel.replace(/\\/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  while (normalized.startsWith("/")) normalized = normalized.slice(1);
  return normalized;
}

/** True when *rel* matches a policy denylist glob. */
function matchesDenyGlob(glob: string, rel: string): boolean {
  const source = globToRegExpSource(glob);
  if (glob.includes("/")) {
    return new RegExp(`^${source}$`).test(rel);
  }
  // A glob with no separator is a basename pattern, matched at any depth.
  const basename = rel.slice(rel.lastIndexOf("/") + 1);
  return new RegExp(`^${source}$`).test(basename);
}

/**
 * Build a matcher for a `.gitignore` body.
 *
 * Supports the common cases the spec calls for: literal names, a trailing `/`
 * (directory-only), a leading `/` (anchored at the checkout root), `*` and
 * `**` globs, `#` comments, blank lines, and `!` negation. Last matching line
 * wins, as git itself does. This is deliberately not a complete gitignore
 * implementation — a pattern outside this subset simply will not match.
 */
export function gitignoreMatcher(body: string): GitignoreMatcher {
  const rules: Array<{ re: RegExp; negated: boolean }> = [];
  for (const raw of body.split("\n")) {
    let line = raw.replace(/\r$/, "").trim();
    if (line === "" || line.startsWith("#")) continue;

    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }
    let directoryOnly = false;
    if (line.endsWith("/")) {
      directoryOnly = true;
      line = line.slice(0, -1);
    }
    let anchored = false;
    if (line.startsWith("/")) {
      anchored = true;
      line = line.slice(1);
    }
    if (line === "") continue;
    if (line.includes("/")) anchored = true;

    const source = globToRegExpSource(line);
    // A matched directory ignores everything beneath it, so both forms allow a
    // "/..." suffix; a directory-only pattern REQUIRES one (the path we are
    // given is a file, so the directory must be an ancestor of it).
    const suffix = directoryOnly ? "/.*" : "(?:/.*)?";
    const prefix = anchored ? "" : "(?:.*/)?";
    rules.push({ re: new RegExp(`^${prefix}${source}${suffix}$`), negated });
  }

  return (rel: string): boolean => {
    const normalized = normalizeRel(rel);
    let ignored = false;
    for (const rule of rules) {
      if (rule.re.test(normalized)) ignored = !rule.negated;
    }
    return ignored;
  };
}

/**
 * Refuse a read of a path matched by the policy denylist, or — when
 * `policy.read.respect_gitignore` is on and a matcher is supplied — by the
 * checkout's `.gitignore` (c36: secrets do not ride along in artifacts).
 *
 * Returns `null` when the path is readable.
 */
export function isDenylisted(
  rel: string,
  policy: Policy,
  gitignoreMatcher?: GitignoreMatcher,
): StructuredError | null {
  const normalized = normalizeRel(rel);
  for (const glob of policy.read?.denylist ?? []) {
    if (matchesDenyGlob(glob, normalized)) {
      return makeStructuredError(
        "path_denied",
        `read of '${rel}' is refused: it matches the policy denylist pattern '${glob}'`,
        "path",
      );
    }
  }
  if (policy.read?.respect_gitignore !== false && gitignoreMatcher && gitignoreMatcher(normalized)) {
    return makeStructuredError(
      "path_denied",
      `read of '${rel}' is refused: the path is ignored by the checkout's .gitignore`,
      "path",
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Output budget + spill to disk — colleague/colleague/truncation.py:128-301
// ---------------------------------------------------------------------------

const SEPARATOR = "\n\n---\n... [CONTENT TRUNCATED] ...\n---\n\n";
const SEPARATOR_NEWLINES = (SEPARATOR.match(/\n/g) ?? []).length;
const SPILL_FILE_MODE = 0o600;

/** The largest character prefix of *text* that fits *maxBytes* when UTF-8 encoded. */
function charsWithinBytes(text: string, maxBytes: number): number {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text.length;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return low;
}

interface Preview {
  preview: string;
  truncated: boolean;
  /** Characters of the ORIGINAL consumed by the preview's head — the cursor offset. */
  headChars: number;
}

/**
 * Head+tail preview within both budgets — `_head_and_tail`
 * (colleague/colleague/truncation.py:128). The separator's own characters AND
 * its own newlines are reserved out of the budget before any content line is
 * picked (finding #441-9/B), so the returned preview itself always fits.
 */
function headAndTail(text: string, maxChars: number, maxLines: number): Preview {
  const lines = text.split("\n");
  if (text.length <= maxChars && lines.length <= maxLines) {
    return { preview: text, truncated: false, headChars: text.length };
  }

  const availableLines = Math.max(maxLines - SEPARATOR_NEWLINES - 1, 0);
  const effectiveLines = Math.min(availableLines, lines.length);
  let headN = 0;
  let tailN = 0;
  if (effectiveLines > 0) {
    headN = Math.max(Math.floor(effectiveLines / 5), 1);
    tailN = Math.max(effectiveLines - headN, 0);
  }
  const headLines = lines.slice(0, headN);
  const tailLines = tailN ? lines.slice(lines.length - tailN) : [];

  const charBudget = Math.max(maxChars - SEPARATOR.length, 0);
  const headBudget = Math.floor(charBudget / 5);
  const tailBudget = charBudget - headBudget;

  let headText = headLines.join("\n");
  if (headText.length > headBudget) headText = headText.slice(0, headBudget);
  let tailText = tailLines.join("\n");
  if (tailText.length > tailBudget) tailText = tailBudget ? tailText.slice(-tailBudget) : "";

  return {
    preview: headText + SEPARATOR + tailText,
    truncated: true,
    headChars: headText.length,
  };
}

/**
 * `_bounded_preview` (colleague/colleague/truncation.py:175): the preview sized
 * so `prefix + preview` itself stays within the budgets — a straight
 * subtraction, since the prefix is always prepended and nothing follows.
 */
function boundedPreview(text: string, prefix: string, maxChars: number, maxLines: number): Preview {
  const budgetChars = Math.max(maxChars - prefix.length, 0);
  const budgetLines = Math.max(maxLines - (prefix.match(/\n/g) ?? []).length, 0);
  return headAndTail(text, budgetChars, budgetLines);
}

/**
 * Write *encoded* into *spillDir* atomically, refusing to follow a pre-planted
 * symlink — `_create_spill_file` (colleague/colleague/truncation.py:258,
 * finding #441-5/A). `O_CREAT | O_EXCL | O_NOFOLLOW` makes create+open one
 * kernel call that fails rather than following a symlink, and the 0o600 mode
 * is passed to open() itself, never a racy chmod afterwards.
 */
function createSpillFile(spillDir: string, digest: string, encoded: Buffer): string {
  const flags =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
  let candidate = path.join(spillDir, `${digest}.txt`);
  let fd: number;
  try {
    fd = fs.openSync(candidate, flags, SPILL_FILE_MODE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Reuse an existing entry only when it is a regular, non-symlink file whose
    // content already equals ours (two tools spilling identical output — the
    // common case). Anything else gets a fresh, unguessable name.
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isFile() && fs.readFileSync(candidate).equals(encoded)) return candidate;
    } catch {
      /* fall through to the suffixed name */
    }
    candidate = path.join(spillDir, `${digest}-${crypto.randomBytes(4).toString("hex")}.txt`);
    fd = fs.openSync(candidate, flags, SPILL_FILE_MODE);
  }
  try {
    fs.writeSync(fd, encoded);
  } finally {
    fs.closeSync(fd);
  }
  return candidate;
}

/**
 * Bound a tool result at its per-tool budget, spilling the full text to disk
 * and handing back a continuation cursor.
 *
 * Ported from `bound_output` (colleague/colleague/readpage.py) →
 * `truncate_output` (colleague/colleague/truncation.py:189). Every limit comes
 * from *budget* — the caller's slice of `policy.budgets` — never from a
 * literal here. When the text already fits it is returned unchanged and
 * nothing touches disk.
 */
export function boundOutput(text: string, budget: Budget, spillDir: string): BoundedOutput {
  const maxLines = budget.max_lines ?? Number.MAX_SAFE_INTEGER;
  let maxChars = budget.max_output_chars;

  // A byte budget is expressed in bytes; convert it to the equivalent character
  // cap so both budgets can be applied by one code path. Skipped when the byte
  // budget cannot possibly bite (4 bytes/char is UTF-8's worst case).
  const maxBytes = budget.max_bytes;
  if (maxBytes !== undefined && maxBytes < maxChars * 4) {
    maxChars = Math.min(maxChars, charsWithinBytes(text, maxBytes));
  }

  const lineCount = text.split("\n").length;
  if (text.length <= maxChars && lineCount <= maxLines) {
    return { text, truncated: false };
  }

  let spillPath: string | undefined;
  let prefix: string;
  if (budget.spill_to_disk === false) {
    prefix =
      "Tool output was too large and has been truncated " +
      "(spill_to_disk is off in the policy, full output not saved to disk).\n\n";
  } else {
    const encoded = Buffer.from(text, "utf8");
    const digest = crypto.createHash("sha256").update(encoded).digest("hex");
    try {
      fs.mkdirSync(spillDir, { recursive: true });
      spillPath = path.resolve(createSpillFile(spillDir, digest, encoded));
      prefix =
        "Tool output was too large and has been truncated.\n" +
        `The full output has been saved to: ${spillPath}\n` +
        "To read the complete output, read that absolute path, or continue " +
        "with the cursor on this result.\n\n";
    } catch (err) {
      spillPath = undefined;
      prefix =
        "Tool output was too large and has been truncated " +
        `(could not save full output to disk: ${(err as Error).message}).\n\n`;
    }
  }

  const { preview, headChars } = boundedPreview(text, prefix, maxChars, maxLines);
  const out: BoundedOutput = { text: prefix + preview, truncated: true };
  if (spillPath) out.spillPath = spillPath;
  if (headChars < text.length) {
    const cursor: Cursor = {
      offset: headChars,
      total: text.length,
      chunkChars: Math.max(maxChars, 1),
    };
    if (spillPath) cursor.spillPath = spillPath;
    out.cursor = cursor;
  }
  return out;
}

/**
 * Return the next chunk of a paged source (c21: long inputs are chunked with
 * explicit continuation cursors rather than truncated silently).
 *
 * *source* is either the full text or `{ spillPath }` naming the file
 * `boundOutput` spilled it to. Chunks are cut on a line boundary where one is
 * available, and concatenating every chunk from `offset: 0` reproduces the
 * source exactly. The returned `cursor` is `null` once the source is exhausted.
 */
export function nextChunk(source: string | { spillPath: string }, cursor: Cursor): ChunkResult {
  const text = typeof source === "string" ? source : fs.readFileSync(source.spillPath, "utf8");
  const total = text.length;
  const offset = Math.max(0, Math.min(cursor.offset, total));
  const chunkChars = Math.max(1, cursor.chunkChars);

  let chunk = text.slice(offset, offset + chunkChars);
  if (offset + chunk.length < total) {
    const lastNewline = chunk.lastIndexOf("\n");
    if (lastNewline > 0) chunk = chunk.slice(0, lastNewline + 1);
  }
  const nextOffset = offset + chunk.length;
  const more = nextOffset < total;
  return {
    text: chunk,
    truncated: more,
    cursor: more ? { ...cursor, offset: nextOffset, total } : null,
  };
}

// ---------------------------------------------------------------------------
// Argument validation — mirrors associate/contract/validate.py
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

const TYPE_CHECKS: Record<string, (value: unknown) => boolean> = {
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === "string",
  // JSON has no bool type; exclude booleans explicitly or `true` would
  // validate as an integer (the same carve-out validate.py makes for Python).
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  null: (v) => v === null,
};

function fieldName(pathExpr: string): string {
  return pathExpr === "" ? "$" : pathExpr;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Follow a local `#/a/b` $ref inside *root*, once — validate.py's `_resolve`. */
function resolveRef(
  schema: JsonSchema,
  root: JsonSchema,
  pathExpr: string,
): JsonSchema | StructuredError {
  const ref = schema.$ref;
  if (typeof ref !== "string") return schema;
  if (!ref.startsWith("#/")) {
    return makeStructuredError(
      "invalid_schema",
      `unsupported $ref '${ref}': only local '#/...' pointers are supported`,
      fieldName(pathExpr),
    );
  }
  let target: unknown = root;
  for (const rawToken of ref.slice(2).split("/")) {
    const token = rawToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof target !== "object" || target === null || !(token in (target as object))) {
      return makeStructuredError("invalid_schema", `unresolvable $ref '${ref}'`, fieldName(pathExpr));
    }
    target = (target as Record<string, unknown>)[token];
  }
  if (typeof target !== "object" || target === null || Array.isArray(target)) {
    return makeStructuredError(
      "invalid_schema",
      `$ref '${ref}' does not point at a schema`,
      fieldName(pathExpr),
    );
  }
  return target as JsonSchema;
}

function check(
  instance: unknown,
  rawSchema: JsonSchema,
  root: JsonSchema,
  pathExpr: string,
): StructuredError | null {
  const resolved = resolveRef(rawSchema, root, pathExpr);
  if ("ok" in resolved && (resolved as StructuredError).ok === false) {
    return resolved as StructuredError;
  }
  const schema = resolved as JsonSchema;

  const expected = schema.type;
  if (expected !== undefined) {
    const names = typeof expected === "string" ? [expected] : (expected as string[]);
    for (const name of names) {
      if (!(name in TYPE_CHECKS)) {
        return makeStructuredError(
          "invalid_schema",
          `unsupported schema type '${name}'`,
          fieldName(pathExpr),
        );
      }
    }
    if (!names.some((name) => TYPE_CHECKS[name](instance))) {
      return makeStructuredError(
        "invalid_argument",
        `${fieldName(pathExpr)}: expected type ${names.join("|")}, got ${describe(instance)}`,
        fieldName(pathExpr),
      );
      // A wrong type makes every nested check meaningless, so stop here.
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === instance)) {
    return makeStructuredError(
      "invalid_argument",
      `${fieldName(pathExpr)}: ${JSON.stringify(instance)} is not one of ${JSON.stringify(schema.enum)}`,
      fieldName(pathExpr),
    );
  }

  if (typeof schema.pattern === "string" && typeof instance === "string") {
    if (!new RegExp(schema.pattern).test(instance)) {
      return makeStructuredError(
        "invalid_argument",
        `${fieldName(pathExpr)}: ${JSON.stringify(instance)} does not match pattern ${JSON.stringify(schema.pattern)}`,
        fieldName(pathExpr),
      );
    }
  }

  if (typeof instance === "object" && instance !== null && !Array.isArray(instance)) {
    const record = instance as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in record)) {
        const child = pathExpr === "" ? key : `${pathExpr}.${key}`;
        return makeStructuredError(
          "invalid_argument",
          `${fieldName(pathExpr)}: missing required property '${key}'`,
          child,
        );
      }
    }
    const properties = (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
    for (const [key, subschema] of Object.entries(properties)) {
      if (key in record) {
        const child = pathExpr === "" ? key : `${pathExpr}.${key}`;
        const error = check(record[key], subschema, root, child);
        if (error) return error;
      }
    }
  }

  if (Array.isArray(instance) && schema.items !== undefined) {
    for (let index = 0; index < instance.length; index += 1) {
      const error = check(
        instance[index],
        schema.items as JsonSchema,
        root,
        `${fieldName(pathExpr)}[${index}]`,
      );
      if (error) return error;
    }
  }

  return null;
}

/**
 * Validate a tool's argument set against its JSON schema, in-tool (c21/h15:
 * this works whether or not the server honours strict tool schemas).
 *
 * Implements exactly the draft 2020-12 subset associate/contract/validate.py
 * supports — `type`, `required`, `properties`, `items`, `enum`, `pattern`, and
 * local `#/$defs/<name>` refs — and ignores anything else rather than guessing.
 *
 * Returns `null` when *args* is valid, or a structured error whose `field`
 * names the offending argument (`"limit"`, `"opts.depth"`, `"globs[1]"`, or
 * `"$"` for the argument set as a whole).
 */
export function validateArgs(schema: JsonSchema, args: unknown): StructuredError | null {
  return check(args, schema, schema, "");
}
