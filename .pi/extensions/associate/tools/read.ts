/**
 * The `read` tool — overrides pi's built-in `read` by name (task t5).
 *
 * Every line handed back is stamped with its ABSOLUTE line number in the file
 * (spec: `policy.json`'s `read.line_numbers: "absolute"`), regardless of the
 * `start_line`/`end_line` window requested — a model reading from line 3400
 * must see `3400\t...`, never `1\t...`. The path is confined to the checkout
 * (`lib/contain.ts`'s `confine`) and refused when it matches the policy
 * denylist or the checkout's own `.gitignore` (`isDenylisted`). Output is
 * bounded by `ctx.policy.budgets.read` via `boundOutput` — never a literal
 * here — and a truncated read carries a continuation cursor.
 *
 * CHUNKING CHOICE (recorded per the task's plan-risk note): `boundOutput`'s
 * own preview is head+tail (colleague's `_head_and_tail`), and its cursor
 * offset marks the end of the HEAD half, so re-entering with that cursor via
 * `nextChunk` would re-deliver the tail the first response already showed.
 * For `read` that is wrong — a caller paging through a file wants forward
 * progress, not overlap — so this tool takes `boundOutput` only for its
 * truncation detection, its per-call char budget (`cursor.chunkChars`,
 * already converted from `max_bytes` when that is the binding constraint) and
 * its spill file, then throws away `boundOutput`'s own head+tail text and
 * cursor and rebuilds a PREFIX-ONLY chunk from `nextChunk` starting at
 * offset 0. Every subsequent `cursor` argument continues that same
 * prefix-only walk, terminating in a null cursor exactly when the spilled
 * text is exhausted (`nextChunk`'s own contract).
 *
 * A second, defensive clip (`clipToByteBudget`) re-checks every outgoing
 * chunk's UTF-8 byte length against `budget.max_bytes` itself, rather than
 * trusting `cursor.chunkChars` (a char count calibrated against the FIRST
 * chunk's byte density) to still hold for a later chunk of possibly heavier
 * multibyte content — the lapse this task's acceptance criteria calls out.
 */

import { readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import {
  boundOutput,
  confine,
  isDenylisted,
  gitignoreMatcher,
  makeStructuredError,
  nextChunk,
  validateArgs,
  type Cursor,
  type Policy,
  type StructuredError,
} from "../lib/contain.ts";
import type { AssociateContext, ToolModule } from "../lib/context.ts";

// ---------------------------------------------------------------------------
// typebox — provided by the pi runtime as a bare "typebox" specifier.
//
// `index.ts` is loaded by tests through a rewritten copy that redirects
// "typebox" to tests/stubs/typebox.ts (pi is not on the module resolution
// path under plain `node --test`). Tool modules under tools/ are NOT
// rewritten — `lib/runtime.ts` dynamically imports this file at its real
// path — so a static `import { Type } from "typebox"` would resolve fine
// under pi but throw `ERR_MODULE_NOT_FOUND` under the test runner and take
// every other extension test down with it. Resolve it dynamically instead,
// falling back to a minimal local builder that produces the same JSON-Schema
// shape typebox does (typebox's own schemas are plain JSON Schema at
// runtime, so `validateArgs` treats either the same way).
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

interface TypeBuilder {
  Object(properties: Record<string, JsonSchema>, options?: JsonSchema): JsonSchema;
  String(options?: JsonSchema): JsonSchema;
  Integer(options?: JsonSchema): JsonSchema;
  Optional(schema: JsonSchema): JsonSchema;
}

const FALLBACK_TYPE: TypeBuilder = {
  Object(properties, options = {}) {
    const required = Object.keys(properties).filter(
      (key) => !(properties[key] as { __optional?: boolean }).__optional,
    );
    return { type: "object", properties, required, ...options };
  },
  String(options = {}) {
    return { type: "string", ...options };
  },
  Integer(options = {}) {
    return { type: "integer", ...options };
  },
  Optional(schema) {
    return { ...schema, __optional: true };
  },
};

async function resolveTypeBuilder(): Promise<TypeBuilder> {
  try {
    const mod = (await import("typebox")) as { Type: TypeBuilder };
    return mod.Type;
  } catch {
    return FALLBACK_TYPE;
  }
}

// ---------------------------------------------------------------------------
// argument shape
// ---------------------------------------------------------------------------

interface ReadArgs {
  path: string;
  start_line?: number;
  end_line?: number;
  cursor?: string;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

function errorResult(error: StructuredError): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(error) }], details: error as unknown as Record<string, unknown> };
}

/** The largest prefix of *text* whose UTF-8 encoding is at most *maxBytes*. */
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

/**
 * Re-clip *chunk* so its UTF-8 byte length never exceeds `budget.max_bytes`,
 * cutting on the last newline within budget when one is available. Guards
 * against a later chunk being byte-heavier than the chunk `boundOutput`
 * originally calibrated `chunkChars` against (e.g. denser multibyte content
 * later in the file) — see the module comment.
 */
function clipToByteBudget(chunk: string, maxBytes: number | undefined): string {
  if (maxBytes === undefined) return chunk;
  if (Buffer.byteLength(chunk, "utf8") <= maxBytes) return chunk;
  const fitChars = charsWithinBytes(chunk, maxBytes);
  let clipped = chunk.slice(0, fitChars);
  const lastNewline = clipped.lastIndexOf("\n");
  if (lastNewline > 0) clipped = clipped.slice(0, lastNewline + 1);
  return clipped;
}

interface StampedFile {
  /** Every requested line, each stamped `"<absolute-line-number>\t<text>"`. */
  stamped: string;
  totalLines: number;
  startLine: number;
  endLine: number;
}

/** Read *absPath*, stamp the requested window with absolute line numbers. */
function stampWindow(absPath: string, startArg: number | undefined, endArg: number | undefined): StampedFile | StructuredError {
  const content = readFileSync(absPath, "utf8");
  const endsWithNewline = content.endsWith("\n");
  const rawLines = content.split("\n");
  const lines = endsWithNewline ? rawLines.slice(0, -1) : rawLines;
  const totalLines = lines.length;

  const start = startArg ?? 1;
  const end = endArg ?? totalLines;

  if (start < 1) {
    return makeStructuredError("invalid_argument", "start_line must be >= 1", "start_line");
  }
  if (totalLines > 0 && start > totalLines) {
    return makeStructuredError(
      "invalid_argument",
      `start_line ${start} is past the end of the file (${totalLines} lines)`,
      "start_line",
    );
  }
  if (end < start) {
    return makeStructuredError("invalid_argument", "end_line must be >= start_line", "end_line");
  }

  const clampedEnd = Math.min(end, totalLines);
  const windowLines = lines.slice(start - 1, clampedEnd);
  const stamped = windowLines.map((line, index) => `${start + index}\t${line}`).join("\n");

  return { stamped, totalLines, startLine: start, endLine: clampedEnd };
}

/** Build the first, prefix-only chunk of *stamped* per the module's chunking choice. */
function boundStamped(
  stamped: string,
  budget: Policy["budgets"]["read"],
  spillDir: string,
): { text: string; truncated: boolean; cursor: Cursor | null } {
  const bounded = boundOutput(stamped, budget, spillDir);
  if (!bounded.truncated || !bounded.cursor) {
    return { text: stamped, truncated: false, cursor: null };
  }
  const prefixCursor: Cursor = {
    offset: 0,
    total: stamped.length,
    chunkChars: bounded.cursor.chunkChars,
    ...(bounded.cursor.spillPath ? { spillPath: bounded.cursor.spillPath } : {}),
  };
  const chunk = nextChunk(stamped, prefixCursor);
  const clippedText = clipToByteBudget(chunk.text, budget.max_bytes);
  if (clippedText.length === chunk.text.length) {
    return { text: chunk.text, truncated: chunk.truncated, cursor: chunk.cursor };
  }
  // The defensive byte re-clip trimmed further than nextChunk's own cut —
  // shrink the outgoing cursor's offset to match what was actually returned.
  const nextOffset = clippedText.length;
  const cursor: Cursor | null =
    nextOffset < stamped.length
      ? { ...prefixCursor, offset: nextOffset }
      : null;
  return { text: clippedText, truncated: cursor !== null, cursor };
}

function encodeCursor(cursor: Cursor): string {
  return JSON.stringify(cursor);
}

function decodeCursor(raw: string): Cursor | StructuredError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return makeStructuredError("invalid_argument", "cursor is not valid JSON", "cursor");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Cursor).offset !== "number" ||
    typeof (parsed as Cursor).total !== "number" ||
    typeof (parsed as Cursor).chunkChars !== "number"
  ) {
    return makeStructuredError("invalid_argument", "cursor is missing offset/total/chunkChars", "cursor");
  }
  return parsed as Cursor;
}

const DESCRIPTION =
  "Read a file's contents, or a line range of it. Every returned line is prefixed with its " +
  "absolute line number in the file (never renumbered from 1), so `start_line`/`end_line` can " +
  "be used to jump straight to a known location. Output is bounded by the read budget; a " +
  "truncated result carries a `cursor` — pass it back (with no other argument) to fetch the " +
  "next chunk of the same read. Refuses paths outside the checkout, the policy denylist " +
  "(secrets, credentials, keys) and paths ignored by the checkout's .gitignore.";

export const register: ToolModule["register"] = async (pi, ctx: AssociateContext) => {
  const Type = await resolveTypeBuilder();
  // `path` is Optional at the SCHEMA level (still type-checked when present)
  // because a continuation call passes only `cursor`; presence of `path` when
  // there is no `cursor` is enforced by hand below, so the missing-`path`
  // error still names the "path" field rather than accidentally requiring it
  // on every continuation call too.
  const schema: JsonSchema = Type.Object({
    path: Type.Optional(
      Type.String({
        description: "Path to read, relative to the checkout root (or absolute within it).",
      }),
    ),
    start_line: Type.Optional(
      Type.Integer({ description: "First absolute line to return, 1-based. Defaults to 1." }),
    ),
    end_line: Type.Optional(
      Type.Integer({
        description: "Last absolute line to return, 1-based and inclusive. Defaults to the last line.",
      }),
    ),
    cursor: Type.Optional(
      Type.String({
        description:
          "Continuation cursor from a previous truncated read. When set, path/start_line/end_line " +
          "are ignored and the next chunk of that same read is returned.",
      }),
    ),
  });

  (pi as { registerTool: (definition: Record<string, unknown>) => void }).registerTool({
    name: "read",
    label: "Read",
    description: DESCRIPTION,
    promptSnippet: "Read a file with absolute line numbers, honoring the read budget and denylist",
    parameters: schema,
    async execute(_toolCallId: string, rawParams: unknown): Promise<ToolResult> {
      const invalid = validateArgs(schema, rawParams);
      if (invalid) return errorResult(invalid);
      const args = rawParams as ReadArgs;

      if (args.cursor !== undefined) {
        return continueRead(args.cursor);
      }
      if (args.path === undefined) {
        return errorResult(makeStructuredError("invalid_argument", "missing required property 'path'", "path"));
      }
      return startRead(ctx, args as ReadArgs & { path: string });
    },
  });
};

function continueRead(rawCursor: string): ToolResult {
  const decoded = decodeCursor(rawCursor);
  if ("ok" in decoded) return errorResult(decoded);
  const cursor = decoded;
  if (!cursor.spillPath) {
    return errorResult(
      makeStructuredError(
        "cursor_invalid",
        "cursor carries no spill file to continue from (the original read was not spilled to disk)",
        "cursor",
      ),
    );
  }

  let chunk;
  try {
    chunk = nextChunk({ spillPath: cursor.spillPath }, cursor);
  } catch (err) {
    return errorResult(
      makeStructuredError(
        "cursor_invalid",
        `cursor's spill file could not be read: ${(err as Error).message}`,
        "cursor",
      ),
    );
  }

  const details: Record<string, unknown> = { truncated: chunk.truncated };
  if (chunk.cursor) details.cursor = encodeCursor(chunk.cursor);
  return { content: [{ type: "text", text: chunk.text }], details };
}

function startRead(ctx: AssociateContext, args: ReadArgs): ToolResult {
  const confined = confine(ctx.checkoutRoot, args.path);
  if (!confined.ok) return errorResult(confined);

  const rel = relative(resolve(ctx.checkoutRoot), confined.path).split(sep).join("/");
  const policy = ctx.policy as unknown as Policy;

  let matcher;
  try {
    const gitignoreBody = readFileSync(resolve(ctx.checkoutRoot, ".gitignore"), "utf8");
    matcher = gitignoreMatcher(gitignoreBody);
  } catch {
    matcher = undefined;
  }

  const denied = isDenylisted(rel, policy, matcher);
  if (denied) return errorResult(denied);

  let stat;
  try {
    stat = statSync(confined.path);
  } catch (err) {
    return errorResult(
      makeStructuredError("path_not_found", `read of '${args.path}' failed: ${(err as Error).message}`, "path"),
    );
  }
  if (!stat.isFile()) {
    return errorResult(makeStructuredError("not_a_file", `'${args.path}' is not a regular file`, "path"));
  }

  const stampedOrError = stampWindow(confined.path, args.start_line, args.end_line);
  if ("ok" in stampedOrError) return errorResult(stampedOrError);
  const { stamped, totalLines, startLine, endLine } = stampedOrError;

  const spillDir = ctx.session.scratchDir;
  const { text, truncated, cursor } = boundStamped(stamped, policy.budgets.read, spillDir);

  const details: Record<string, unknown> = {
    path: rel,
    start_line: startLine,
    end_line: endLine,
    total_lines: totalLines,
    truncated,
  };
  if (cursor) details.cursor = encodeCursor(cursor);
  return { content: [{ type: "text", text }], details };
}
