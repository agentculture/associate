/**
 * Strict facts: resolve a fact's pointer and copy its evidence by code
 * (docs/specs/2026-11-19-associate-strict-facts.md, claims c8, c9, c14, c32,
 * c33, c34, c41; plan task t2).
 *
 * The model does not retype evidence. A fact names the call it rests on
 * (`source`, a walk id, optionally labelled `prior:wN` / `cN:wN`) and where in
 * that call's saved result the evidence is (`at`). This module copies, by
 * code, the quoted text from the saved result, the command from the walk
 * entry's arguments as used, and the saved result's file name. It is a pure
 * function of what it is handed: it opens no file, starts no process, calls
 * no tool and reads nothing from the environment. Walk entries and saved
 * result texts come through the context (`EvidenceContext`); callers load
 * them (`lib/results.ts`, `lib/walk.ts`).
 *
 * THE POINTER. `at` is exactly one of:
 *   - `{lines: [first, last]}` — 1-based, inclusive.
 *   - `{search: "term"}` — the evidence is the FIRST line of the saved result
 *     that contains the term (exact, case-sensitive substring), that one line
 *     and nothing else.
 *
 * HOW LINES ARE COUNTED (the choice, stated once). Every tool result the
 * model sees begins with the harness line `walk id: wN` (lib/walk.ts
 * `stampContent`). That line is added after the result is saved, so the saved
 * file (`results/wN.txt`) never holds it. Lines are counted in the saved
 * file's text: line 1 is the first line BELOW the `walk id:` line the model
 * saw, i.e. the stamp is a header and not a line of the result. A trailing
 * newline does not make an extra empty line. One exception, because it is
 * what the model was shown: a `read` result (lib/walk.ts `isReadToolName`)
 * stamps every line with its absolute line number in the file
 * (`3400\t...`), so for a read result whose first line carries such a stamp,
 * `lines` names those shown numbers: `[3401, 3402]` copies the lines stamped
 * 3401 and 3402. For a read from line 1 the two counts coincide.
 *
 * WHAT IS COPIED is byte for byte what the saved file holds for those lines,
 * joined with "\n" (read stamps included), never a normalised form.
 *
 * THE CAP (c32). A saved result above the contract cap (`caps.max_raw_chars`,
 * lib/results.ts) keeps only its first characters and its entry is marked
 * `partial`. On such an entry, a pointer that reaches past the kept lines, a
 * search term not in the kept part, or a pointer whose evidence includes the
 * last kept line (which may itself have been cut mid-line) gives
 * `result_cut` — "not checkable from the saved result" — with the fix to cite
 * a narrower call. On a whole result the same pointers give
 * `pointer_out_of_range` / `search_not_found`.
 *
 * THE NUMBER CHECK (c9). Every number token in the fact's value must also be
 * a number token of the copied evidence. A number token is a run of digits,
 * written either with thousands separators (`1,234`, `12,345,678`: one to
 * three digits, then groups of a comma and exactly three digits) or without,
 * optionally followed by one `.digits` decimal part. Tokens are compared as
 * strings with the commas removed (`1,234` equals `1234`); signs, units and
 * surrounding letters are ignored (`w12` holds the token `12`, `v1.5.2` the
 * tokens `1.5` and `2`). Value and evidence are tokenised the same way. When
 * the pointer covers the whole result, the evidence is the whole result, so
 * "in the evidence" and "in the result" are the same rule. What it cannot
 * catch: whether the number counts what the value says. In the measured
 * colleague run, "604 test files" cites a result holding 604, but the command
 * counted directory entries; this check passes that fact (since plan
 * deviation d3 a value in the model's own words then goes to the decider with
 * the command beside the copied line: lib/facts.ts). It also cannot tell
 * `0.50` from `0.5`, or `10,200` (a list of two numbers) from ten thousand two
 * hundred — both are written the same way on both sides or they fail.
 *
 * THE COMMAND (c8, c34). One line, built from the walk entry's `args_used`
 * (the arguments as used, which the tools report); when an entry has none it
 * falls back to `args` (as asked) and says so in `command_from`. Text the
 * model wrote about the command is never read. The `purpose` argument is
 * dropped. Shapes:
 *   - `bash`: the argv as a shell line (a token with characters outside
 *     `[A-Za-z0-9_@%+=:,./~-]` is double-quoted as JSON), prefixed
 *     `cd <cwd> && ` when the call named a working directory;
 *   - `read`: `read <path>`, plus ` lines <start>-<end>` when a window was used;
 *   - any other tool: `<tool> key=value ...` in the recorded key order, a value
 *     quoted as JSON unless it is a plain token, objects and arrays as JSON.
 * Every string in the command is rewritten before quoting: an absolute path
 * under the checkout root, or under a run worktree of it
 * (`<parent>/.worktrees.<name>/<run>`, CLAUDE.md), becomes relative (`.` for
 * the root itself); any other absolute path under a home directory
 * (`/home/<user>`, `/Users/<user>`, `/root`) has that prefix replaced by `~`;
 * then the contract's redaction filter (`ctx.redact`, the walk's
 * `compileRedaction(policy).apply`) masks token-looking values. Nothing comes
 * from the process environment.
 *
 * LABELLED SOURCES (c33). `prior:wN` and `cN:wN` are looked up through
 * `ctx.labelled(label)`, never in the current run. When the labelled export is
 * not available the fact fails as `labelled_unread`, whose message says the
 * fact rests on a labelled run whose result was not read here; it is never
 * reported as directly checked.
 */

import { missingNumbers, numberTokens, parseSourceRef } from "./facts.ts";
import { isReadToolName, PURPOSE_ARG } from "./walk.ts";
import type { SourceKind } from "./contract.ts";

// ----------------------------------------------------------------- interface

/** One run's walk entries and saved results, as the resolver reads them. */
export interface EvidenceRun {
  /** The walk entry with this id (`w1`, `w2`, …), or undefined. */
  entry(id: string): unknown;
  /** The saved result file's text by its name (`results/wN.txt`), or undefined. */
  savedResult(name: string): string | undefined;
}

/** Everything one resolution reads. Nothing else is touched. */
export interface EvidenceContext extends EvidenceRun {
  /** The checkout the run examined; paths under it are printed relative. */
  readonly checkoutRoot: string;
  /** The contract's redaction filter, applied to every printed command string. */
  readonly redact: (text: string) => string;
  /** The run a label names (a prior run or a child), or undefined when its export is not here. */
  labelled(label: string): EvidenceRun | undefined;
  /** `accuracy.json` `source_kinds`; else the entry's own `source_kind` is used. */
  readonly sourceKinds?: Readonly<Record<string, SourceKind>>;
}

/** The fact fields the resolver reads. Any other field (a model's own account of the command) is ignored. */
export interface EvidenceFact {
  readonly source?: unknown;
  readonly at?: unknown;
  readonly value?: unknown;
  readonly kind?: unknown;
  readonly [key: string]: unknown;
}

/** Every reason a resolution can fail. */
export const EVIDENCE_REASONS = [
  "source_malformed",
  "source_unknown",
  "labelled_unread",
  "no_saved_result",
  "pointer_missing",
  "pointer_malformed",
  "pointer_out_of_range",
  "search_not_found",
  "number_absent",
  "result_cut",
] as const;

export type EvidenceReason = (typeof EVIDENCE_REASONS)[number];

/** The wording for evidence a cut saved result does not hold (spec c32). */
export const NOT_CHECKABLE_TEXT = "not checkable from the saved result";

export interface EvidenceOk {
  readonly ok: true;
  /** The lines copied from the saved result, byte for byte, joined with "\n". */
  readonly quote: string;
  /** The one-line command built from the walk entry. */
  readonly command: string;
  /** Whether the command came from the arguments as used or, lacking those, as asked. */
  readonly command_from: "args_used" | "args";
  /** The saved result's file name as the walk entry names it (`results/wN.txt`). */
  readonly result_file: string;
  /** The fact's value; for a direct fact that gave none, the copied text; null for an llm/derived fact that gave none. */
  readonly value: string | null;
  readonly value_from: "fact" | "result" | null;
  /** The pointer as resolved: the first and last line copied, in the pointer's own count. */
  readonly lines: readonly [number, number];
  readonly source_kind: SourceKind | null;
  /** The run label the source named, or null for the current run. */
  readonly run: string | null;
}

export interface EvidenceFail {
  readonly ok: false;
  readonly reason: EvidenceReason;
  /** What went wrong, in words fit for the model and the answer. */
  readonly message: string;
  /** How to fix it. */
  readonly fix: string;
  readonly run: string | null;
}

export type EvidenceResult = EvidenceOk | EvidenceFail;

// ------------------------------------------------------------------- numbers

// The number rule (module header) is defined in lib/facts.ts, which applies it
// to old-shape quotes under strict too, and re-exported here.
export { missingNumbers, numberTokens };

// ------------------------------------------------------------------- command

interface Located {
  readonly id: string;
  readonly tool: string;
  readonly args?: unknown;
  readonly args_used?: unknown;
  readonly saved_result?: unknown;
  readonly partial?: unknown;
  readonly source_kind?: unknown;
}

function asEntry(value: unknown): Located | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const e = value as Record<string, unknown>;
  return typeof e.id === "string" && typeof e.tool === "string" ? (e as unknown as Located) : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** The pattern matching the checkout root, its run worktrees, and the main checkout of a run worktree. */
function checkoutPattern(checkoutRoot: string): RegExp | null {
  const root = trimSlash(checkoutRoot);
  if (!root.startsWith("/") || root === "/") return null;
  const inWorktree = /^(.*)\/\.worktrees\.([^/]+)\/[^/]+$/.exec(root);
  let base: string;
  let worktrees: string;
  if (inWorktree) {
    base = `${inWorktree[1]}/${inWorktree[2]}`;
    worktrees = `${inWorktree[1]}/.worktrees.${inWorktree[2]}`;
  } else {
    const cut = root.lastIndexOf("/");
    const parent = root.slice(0, cut);
    base = root;
    worktrees = `${parent}/.worktrees.${root.slice(cut + 1)}`;
  }
  const alternatives = [`${escapeRegExp(worktrees)}/[^/\\s"'\`]+`, escapeRegExp(base)];
  // A root ends at a slash, or at a character that cannot continue a path name.
  return new RegExp(`(?:${alternatives.join("|")})(?:/|(?![\\w.-]))`, "g");
}

const HOME_PREFIX = /(?:\/home\/[^/\s"'`]+|\/Users\/[^/\s"'`]+|\/root)(?=\/|$|[\s"'`])/g;

function cleanString(text: string, pattern: RegExp | null, redact: (text: string) => string): string {
  let out = text;
  if (pattern !== null) {
    out = out.replace(pattern, (match: string, offset: number, whole: string) => {
      if (!match.endsWith("/")) return ".";
      const next = whole.charAt(offset + match.length);
      return next === "" || /[\s"'`]/.test(next) ? "." : "";
    });
  }
  out = out.replace(HOME_PREFIX, "~");
  return redact(out);
}

function cleanValue(value: unknown, pattern: RegExp | null, redact: (text: string) => string): unknown {
  if (typeof value === "string") return cleanString(value, pattern, redact);
  if (Array.isArray(value)) return value.map((item) => cleanValue(item, pattern, redact));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[redact(key)] = cleanValue(item, pattern, redact);
    return out;
  }
  return value;
}

const PLAIN_TOKEN = /^[\w@%+=:,./~-]+$/;

function token(value: unknown): string {
  if (typeof value === "string") return PLAIN_TOKEN.test(value) ? value : JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  return JSON.stringify(value) ?? "null";
}

function renderArgs(tool: string, args: Record<string, unknown>): string {
  if (tool === "bash" && Array.isArray(args.argv) && args.argv.every((t) => typeof t === "string")) {
    const line = (args.argv as string[]).map(token).join(" ");
    return typeof args.cwd === "string" && args.cwd.trim() !== "" ? `cd ${token(args.cwd)} && ${line}` : line;
  }
  if (isReadToolName(tool) && typeof args.path === "string") {
    const start = args.start_line;
    const end = args.end_line;
    const hasStart = typeof start === "number";
    const hasEnd = typeof end === "number";
    const window = hasStart || hasEnd ? ` lines ${hasStart ? start : 1}-${hasEnd ? end : "end"}` : "";
    return `${tool} ${token(args.path)}${window}`;
  }
  const pairs = Object.entries(args).map(([key, value]) => `${key}=${token(value)}`);
  return pairs.length > 0 ? `${tool} ${pairs.join(" ")}` : tool;
}

/**
 * The one-line command for a walk entry: `args_used` (else `args`), purpose
 * dropped, checkout paths relative, home prefixes as `~`, redacted. See the
 * module header for the shapes.
 */
export function renderCommand(
  entry: unknown,
  ctx: Pick<EvidenceContext, "checkoutRoot" | "redact">,
): { command: string; command_from: "args_used" | "args" } {
  const e = asEntry(entry);
  const tool = e?.tool ?? "unknown";
  const fromUsed = e !== null && isPlainObject(e.args_used);
  const raw = fromUsed ? (e.args_used as Record<string, unknown>) : isPlainObject(e?.args) ? (e?.args as Record<string, unknown>) : {};
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) if (key !== PURPOSE_ARG) args[key] = value;
  const redact = ctx.redact;
  const cleaned = cleanValue(args, checkoutPattern(ctx.checkoutRoot), redact) as Record<string, unknown>;
  return { command: renderArgs(cleanString(tool, null, redact), cleaned), command_from: fromUsed ? "args_used" : "args" };
}

// ------------------------------------------------------------------- pointer

type Pointer = { kind: "lines"; first: number; last: number } | { kind: "search"; term: string };

function parsePointer(at: unknown): Pointer | "missing" | "malformed" {
  if (at === undefined || at === null) return "missing";
  if (!isPlainObject(at)) return "malformed";
  const hasLines = Object.hasOwn(at, "lines");
  const hasSearch = Object.hasOwn(at, "search");
  if (hasLines === hasSearch) return "malformed";
  if (hasSearch) {
    return typeof at.search === "string" && /\S/.test(at.search) ? { kind: "search", term: at.search } : "malformed";
  }
  const lines = at.lines;
  if (!Array.isArray(lines) || lines.length !== 2) return "malformed";
  const [first, last] = lines;
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first) return "malformed";
  return { kind: "lines", first, last };
}

const READ_STAMP = /^(\d+)\t/;

/** The saved text's lines; a trailing newline does not add an empty last line. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

const SAVED_NAME = /^results\/w[1-9][0-9]*\.txt$/;

const FIXES: Record<EvidenceReason, string> = {
  source_malformed:
    "name the source by walk id (wN, or label:wN for a prior or child run), exactly as the harness line on that tool result showed it; never a file path",
  source_unknown: "cite a walk id that the walk recorded, exactly as the harness line on that tool result showed it",
  labelled_unread:
    "cite a call of this run that shows the same evidence, or state the fact as resting on the labelled run without a direct check",
  no_saved_result: "cite a call whose result was saved (one that returned a result)",
  pointer_missing: "say where in the cited result the evidence is: at.lines [first, last] or at.search \"term\"",
  pointer_malformed:
    "give exactly one of at.lines, two whole line numbers [first, last] with 1 <= first <= last, or at.search, a non-empty term",
  pointer_out_of_range:
    "point at lines that are in the cited result: count from the first line below the 'walk id:' line, or for a read use the line numbers shown at the start of each line",
  search_not_found: "search for a term copied exactly from the cited result, or point at its lines",
  number_absent:
    "write only numbers that appear in the lines you point at, or point at the lines that show the number",
  result_cut:
    "cite a narrower call whose whole result was saved (a read of fewer lines, a more specific search or command), and point at the evidence in it",
};

function failure(reason: EvidenceReason, message: string, run: string | null): EvidenceFail {
  return { ok: false, reason, message, fix: FIXES[reason], run };
}

function kindOf(entry: Located, table: Readonly<Record<string, SourceKind>> | undefined): SourceKind | null {
  if (table && Object.hasOwn(table, entry.tool)) return table[entry.tool];
  const own = entry.source_kind;
  return typeof own === "string" && ["file", "tool", "web", "memory", "agent", "harness"].includes(own)
    ? (own as SourceKind)
    : null;
}

/**
 * Resolve one fact's pointer: copy its evidence, its command and its result
 * file from the walk entry and saved result it cites. Pure: reads only what
 * `ctx` hands it. See the module header for every rule.
 */
export function resolveEvidence(fact: EvidenceFact, ctx: EvidenceContext): EvidenceResult {
  const parsed = parseSourceRef(fact.source);
  if (!parsed.ok) {
    return failure("source_malformed", `the source ${JSON.stringify(fact.source)} is not a walk id`, null);
  }
  const label = parsed.label;
  let runData: EvidenceRun;
  if (label === null) {
    runData = ctx;
  } else {
    const other = ctx.labelled(label);
    if (other === undefined) {
      return failure(
        "labelled_unread",
        `rests on a labelled run (${label}) whose result was not read here; it is not checked against that call`,
        label,
      );
    }
    runData = other;
  }

  const entry = asEntry(runData.entry(parsed.id));
  if (entry === null || entry.id !== parsed.id) {
    return failure("source_unknown", `no walk entry ${fact.source} was recorded`, label);
  }
  const name = entry.saved_result;
  const text = typeof name === "string" && SAVED_NAME.test(name) ? runData.savedResult(name) : undefined;
  if (typeof name !== "string" || typeof text !== "string") {
    return failure("no_saved_result", `the call ${fact.source} has no saved result to point into`, label);
  }

  const pointer = parsePointer(fact.at);
  if (pointer === "missing") return failure("pointer_missing", "the fact does not say where its evidence is", label);
  if (pointer === "malformed") return failure("pointer_malformed", `the pointer ${JSON.stringify(fact.at)} is not valid`, label);

  const cut = entry.partial === true;
  const notCheckable = () => failure("result_cut", NOT_CHECKABLE_TEXT, label);
  const lines = splitLines(text);
  const lastIndex = lines.length - 1;

  // Resolve to a span of indexes into `lines`, and the pointer's own numbers.
  let from: number;
  let to: number;
  let shown: [number, number];
  // A read result is counted by the line numbers it shows (module header).
  const stamped = isReadToolName(entry.tool) && lines.length > 0 && READ_STAMP.test(lines[0]);
  if (pointer.kind === "search") {
    from = lines.findIndex((line) => line.includes(pointer.term));
    if (from < 0) {
      if (cut) return notCheckable();
      return failure("search_not_found", `the term ${JSON.stringify(pointer.term)} is not in the result of ${fact.source}`, label);
    }
    to = from;
    const stamp = stamped ? READ_STAMP.exec(lines[from])?.[1] : undefined;
    const at = stamp !== undefined ? Number(stamp) : from + 1;
    shown = [at, at];
  } else {
    if (stamped) {
      const indexOf = (n: number) => lines.findIndex((line) => READ_STAMP.exec(line)?.[1] === String(n));
      from = indexOf(pointer.first);
      to = indexOf(pointer.last);
      if (from < 0 || to < 0) {
        const lastShown = READ_STAMP.exec(lines[lastIndex])?.[1];
        if (cut && (lastShown === undefined || pointer.last > Number(lastShown))) return notCheckable();
        const firstShown = READ_STAMP.exec(lines[0])?.[1];
        return failure(
          "pointer_out_of_range",
          `lines ${pointer.first}-${pointer.last} are not in the result of ${fact.source}, which shows lines ${firstShown}-${lastShown ?? "?"}`,
          label,
        );
      }
    } else {
      from = pointer.first - 1;
      to = pointer.last - 1;
      if (to > lastIndex) {
        if (cut) return notCheckable();
        return failure(
          "pointer_out_of_range",
          `lines ${pointer.first}-${pointer.last} are past the end of the result of ${fact.source}, which has ${lines.length} lines`,
          label,
        );
      }
    }
    shown = [pointer.first, pointer.last];
  }
  // The last kept line of a cut result may itself have been cut mid-line.
  if (cut && to >= lastIndex) return notCheckable();

  const quote = lines.slice(from, to + 1).join("\n");
  const given = typeof fact.value === "string" && fact.value.trim() !== "" ? fact.value : null;
  if (given !== null) {
    const missing = missingNumbers(given, quote);
    if (missing.length > 0) {
      return failure(
        "number_absent",
        `the value states ${missing.join(", ")}, which the lines pointed at in ${fact.source} do not show`,
        label,
      );
    }
  }
  const direct = fact.kind === undefined || fact.kind === null || fact.kind === "direct";
  const value = given ?? (direct ? quote : null);
  const valueFrom = given !== null ? "fact" : direct ? "result" : null;

  const { command, command_from } = renderCommand(entry, ctx);
  return {
    ok: true,
    quote,
    command,
    command_from,
    result_file: name,
    value,
    value_from: valueFrom,
    lines: shown,
    source_kind: kindOf(entry, ctx.sourceKinds),
    run: label,
  };
}

/**
 * An `EvidenceRun` over the shape `lib/facts.ts` already uses (`RunData`:
 * walk entries and saved texts keyed by walk id), so a caller holding one can
 * hand it to `resolveEvidence` as the current run or as a labelled run.
 */
export function runFromData(data: {
  readonly entries: readonly unknown[];
  readonly results: Readonly<Record<string, string>>;
}): EvidenceRun {
  const byId = new Map<string, unknown>();
  for (const line of Array.isArray(data.entries) ? data.entries : []) {
    const e = asEntry(line);
    if (e !== null) byId.set(e.id, line);
  }
  const results = data.results ?? {};
  return {
    entry: (id: string) => byId.get(id),
    savedResult: (name: string) => {
      const m = /^results\/(w[1-9][0-9]*)\.txt$/.exec(name);
      if (!m || !Object.hasOwn(results, m[1])) return undefined;
      const text = results[m[1]];
      return typeof text === "string" ? text : undefined;
    },
  };
}
