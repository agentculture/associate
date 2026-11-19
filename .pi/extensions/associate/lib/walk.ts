/**
 * The walk recorder: artifact A of a run.
 *
 * Spec c43: every walk entry maps 1:1 to a Pi event the harness received — the
 * harness adds the id, the digest and the timestamp and **never synthesizes an
 * entry**. So this module hooks `tool_call` and `tool_result` and writes one
 * entry per completed tool event; nothing here invents a call the model did not
 * make, and nothing here is reachable by the model (h24: the walk cannot be
 * hallucinated, only the statements can be wrong). A call pi rejects before
 * the hook (an unknown tool, invalid arguments) has no `tool_call` or
 * `tool_result`; `index.ts` records it from its `tool_execution_end` through
 * {@link WalkRecorder.recordUnseenEnd} (plan t9, approved deviation).
 *
 * Plan t9: the recorder binds each entry's id to the call id it was written
 * for ({@link WalkRecorder.entryIdFor}), and `index.ts` stamps the result the
 * model is sent with that id ({@link WALK_ID_STAMP_PREFIX}).
 *
 * Spec c23/h17: the export happens by default, with no flag — persistence is
 * the harness's job, not the model's habit. The recorder therefore starts
 * writing at the first tool event, not at the end of the run.
 *
 * Spec c30/h29: every string leaf passes through a redaction filter built from
 * `policy.json`'s `redaction.patterns` before it is written. The filter is a
 * harness-side filter, never an instruction to the model, and the patterns are
 * the contract's — no secret shape is defined in TypeScript.
 *
 * Spec c36: the last line is the run record — `duration_ms`, `tool_calls`,
 * `outcome`, `truncated` — so reliability is observable rather than asserted.
 *
 * **Streamed, never buffered.** Each entry is `appendFileSync`-ed the moment
 * its `tool_result` arrives. A run that is killed mid-flight therefore leaves a
 * valid partial `walk.jsonl` (every line written is a complete JSON record); a
 * buffer flushed at exit would leave nothing, which was a measured failure
 * mode. The only cost is the run record, which a killed run does not get — and
 * an absent run record is the honest signal that the run did not finish.
 *
 * On-disk shape, matching `associate/contract/schemas/walk.schema.json`:
 * a first `{"format": <$defs/format>}` line naming the walk format, then one
 * `$defs/entry` per line, interleaved `{"gate": <$defs/gate>}` and
 * `{"child": <$defs/child>}` lines, then a final `{"run": <$defs/run>}` line.
 * A walk with no format line was written before format 2 (issue #20) and is
 * read as format 1; a recorder continuing such a walk never adds the marker
 * mid-file.
 *
 * **The entry is the full action record (issue #20, plan t6).** Besides id,
 * ts, tool, args, result and truncated, an entry carries:
 *
 * - `purpose` — the purpose the model stated on the call: the string value of
 *   the call's `purpose` argument as the `tool_call` event carried it,
 *   redacted. Absent when the call had none (an exempt tool such as finish, a
 *   pre-change walk). The purpose also stays inside `args`, which is complete.
 * - `args` — the arguments **as asked**: a deep copy taken at `tool_call`
 *   (`noteToolCall`), before any later hook can patch `event.input` in place
 *   (pi 1.5.2: "event.input is mutable").
 * - `args_used` / `dropped_args` — the arguments **as used**, when the tool
 *   reports them. The tools fill two keys of their result `details`:
 *     - `details.args_used` (an object): the arguments the tool actually ran
 *       with, defaults applied and ignored arguments left out;
 *     - `details.dropped_args` (an array of strings): names of arguments the
 *       tool ignored.
 *   When a tool reports neither, the entry simply has no "as used" value.
 * - `source_kind` — what kind of source the result is (file, tool, web,
 *   memory, agent, harness), looked up by tool name in the contract's
 *   `accuracy.json` `source_kinds` table, never from model text. Absent for a
 *   tool the table does not list.
 * - `saved_result` — the name, relative to the export directory, of the file
 *   holding the result text (`results/w<N>.txt`, see `lib/results.ts`).
 *   Absent when nothing was saved (a refused or unresolved call).
 * - `not_shown_chars` — characters of the result the model was not shown. A
 *   tool that cuts its output reports the count in `details.not_shown_chars`
 *   (a non-negative integer). A result the tool did not mark truncated counts
 *   0; a truncated result with no reported count carries no value (unknown is
 *   never written as 0).
 * - `partial` — true when the saved file does not hold the whole text the
 *   recorder received: above `caps.max_raw_chars`, or nothing saved at all.
 */

import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { policySection, type ContractPolicy, type SourceKind } from "./contract.ts";
import { saveResult } from "./results.ts";
import type { AssociateContext } from "./context.ts";
import type { GateEntry } from "./gate.ts";

/** The walk's file name inside the session export directory. */
export const WALK_FILENAME = "walk.jsonl";

/**
 * The format marker written as the walk's first line, `{"format": WALK_FORMAT}`.
 * Not a policy value: it names the shape this writer produces, and
 * `walk.schema.json` `$defs/format` pins the same name and version (a test
 * keeps them equal). Version 1 is every walk written before the marker.
 */
export const WALK_FORMAT: Readonly<{ name: string; version: number }> = Object.freeze({
  name: "associate-walk",
  version: 2,
});

/** Result-details key a tool fills with the arguments it actually used (an object). */
export const ARGS_USED_KEY = "args_used";

/** Result-details key a tool fills with the names of arguments it ignored (string array). */
export const DROPPED_ARGS_KEY = "dropped_args";

/** Result-details key a tool fills with the characters it did not show the model. */
export const NOT_SHOWN_CHARS_KEY = "not_shown_chars";

/** The call argument carrying the model's stated purpose. */
export const PURPOSE_ARG = "purpose";

/**
 * The harness line every tool result the model sees begins with (issue #20,
 * plan t9): `walk id: w12` on its own first line, naming the walk entry the
 * recorder wrote for that call, so a fact cites an id the model was given
 * instead of one it counted. Not a policy value: it is the shape this
 * extension writes, and the prompts and the matcher refer to it by this
 * constant. The stamp is added after the entry and its saved result are
 * written, so neither the walk, the saved result nor the matcher ever sees it.
 */
export const WALK_ID_STAMP_PREFIX = "walk id: ";

/** A leading stamp line (`walk id: wN`, then a newline or the end of the text). */
export const WALK_ID_STAMP_PATTERN = /^walk id: (w[1-9][0-9]*)(?:\n|$)/;

/** The stamp line for walk id `id`, without a trailing newline. */
export function walkIdStampLine(id: string): string {
  return `${WALK_ID_STAMP_PREFIX}${id}`;
}

/** `text` with a leading stamp line removed; any other text is returned unchanged. */
export function stripWalkIdStamp(text: string): string {
  return text.replace(WALK_ID_STAMP_PATTERN, "");
}

/** `text` with the stamp line for `id` put in front of it. */
export function stampText(id: string, text: string): string {
  return text === "" ? walkIdStampLine(id) : `${walkIdStampLine(id)}\n${text}`;
}

/**
 * A tool result's `content` with the stamp line for `id` in front.
 *
 * The line is merged into the first block when that block is text, so the
 * text the model reads begins with it however a provider joins blocks; a
 * result whose first block is not text (an image) gets a text block of its
 * own in front. Every other block is kept as it was.
 */
export function stampContent(id: string, content: unknown): unknown {
  if (typeof content === "string") return stampText(id, content);
  if (!Array.isArray(content)) {
    if (content == null) return [{ type: "text", text: walkIdStampLine(id) }];
    return content;
  }
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first && typeof first === "object" && first.type === "text" && typeof first.text === "string") {
    return [{ ...first, text: stampText(id, first.text) }, ...content.slice(1)];
  }
  return [{ type: "text", text: walkIdStampLine(id) }, ...content];
}

/**
 * Tool names whose result is file content, so the entry carries both the
 * content and its digest.
 *
 * Not a policy value: these are the names this extension registers (plus pi's
 * built-in `read`, kept so a walk is still complete if an operator re-enables
 * it). The contract says *what* a read entry must carry, not what a read tool
 * is called.
 */
export const READ_TOOL_NAMES: readonly string[] = ["read", "read_file", "read_page", "readpage"];

/** True when `name` names a tool that returns file content. */
export function isReadToolName(name: string): boolean {
  return READ_TOOL_NAMES.includes(name);
}

/** The outcomes `walk.schema.json`'s run record allows. */
export type WalkOutcome = "ok" | "error" | "refused" | "budget_exceeded";

export interface WalkResult {
  content?: string;
  sha256?: string;
  bytes?: number;
}

export interface WalkEntry {
  id: string;
  ts: string;
  tool: string;
  /** The model's stated purpose, redacted; absent when the call had none. */
  purpose?: string;
  /** Arguments as asked, captured at tool_call. */
  args: Record<string, unknown>;
  /** Arguments as used, when the tool reported them (`details.args_used`). */
  args_used?: Record<string, unknown>;
  /** Arguments the tool ignored, when it reported them (`details.dropped_args`). */
  dropped_args?: string[];
  /** From the contract's `source_kinds` table; absent for a tool it does not list. */
  source_kind?: SourceKind;
  result: WalkResult;
  /** Saved result file, relative to the export directory. */
  saved_result?: string;
  /** Characters the model was not shown; absent when unknown. */
  not_shown_chars?: number;
  /** True when the saved file does not hold the whole result text. */
  partial: boolean;
  truncated: boolean;
  error?: string;
}

export interface WalkRun {
  duration_ms: number;
  tool_calls: number;
  outcome: WalkOutcome;
  truncated: boolean;
  /** The registry key of the active model, when one was resolved (env ASSOCIATE_MODEL, else the registry default). */
  model?: string;
  /** The active model's lobes role (its wire id), when a model was resolved. */
  lobes_role?: string;
}

/** What a parent knows about a child it spawned (plan t16): `$defs/child` minus id and ts. */
export interface ChildLink {
  child_model: string;
  /** Path of the child's own `walk.jsonl`. */
  child_walk: string;
  child_session_id: string;
}

/** One `{"child": …}` line of the walk, as written. */
export interface ChildEntry extends ChildLink {
  /** `c1`, `c2`, … — its own sequence, never a walk (`w`) id. */
  id: string;
  ts: string;
}

/** One `{"reminder": …}` line of the walk (deviation d3): a finish reminder the extension sent. */
export interface ReminderEntry {
  /** `r1`, `r2`, … — its own sequence, never a walk (`w`) id. */
  id: string;
  ts: string;
  /** The contract's reminders-per-session budget the reminder was sent under. */
  max: number;
}

// ----------------------------------------------------------------- redaction

export interface RedactionFilter {
  /** The compiled contract patterns, in contract order. */
  readonly patterns: readonly RegExp[];
  /** What a match is replaced with, from the contract. */
  readonly replacement: string;
  /** Apply every pattern to one string. */
  apply(value: string): string;
}

/**
 * Translate one contract pattern into a JavaScript `RegExp`.
 *
 * The contract's patterns are written in the Python/PCRE dialect, where
 * case-insensitivity is a leading `(?i)` inline flag. JavaScript has no inline
 * flags, so a leading `(?i)` becomes the `i` flag instead of a syntax error.
 * Nothing else about the pattern is rewritten — a pattern this translation
 * cannot express is skipped loudly rather than silently weakened.
 */
export function compilePattern(source: string): RegExp {
  const inline = source.startsWith("(?i)");
  const body = inline ? source.slice(4) : source;
  return new RegExp(body, inline ? "gi" : "g");
}

/** Build the redaction filter from `policy.json`'s `redaction` section. */
export function compileRedaction(policy: ContractPolicy): RedactionFilter {
  const section = policySection(policy, "redaction");
  const rawPatterns = Array.isArray(section.patterns) ? (section.patterns as unknown[]) : [];
  // No fallback replacement is invented here: an empty string is what the
  // contract asked for if the contract says so.
  const replacement = typeof section.replacement === "string" ? section.replacement : "";

  const patterns: RegExp[] = [];
  for (const raw of rawPatterns) {
    if (typeof raw !== "string") continue;
    try {
      patterns.push(compilePattern(raw));
    } catch (error) {
      throw new Error(
        `associate: contract redaction pattern ${JSON.stringify(raw)} is not expressible as a ` +
          `JavaScript RegExp (${error instanceof Error ? error.message : String(error)}); ` +
          "the walk must not be written with a pattern silently dropped",
      );
    }
  }
  return {
    patterns,
    replacement,
    apply(value: string): string {
      let out = value;
      for (const pattern of patterns) out = out.replace(pattern, replacement);
      return out;
    },
  };
}

/** Apply `filter` to every string leaf of `value`, structure preserved. */
export function redactValue<T>(value: T, filter: RedactionFilter): T {
  if (typeof value === "string") return filter.apply(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, filter)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[filter.apply(key)] = redactValue(item, filter);
    }
    return out as unknown as T;
  }
  return value;
}

// -------------------------------------------------------------- event shapes

/** The subset of pi's `tool_call` event the recorder reads. */
export interface ToolCallEventLike {
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  args?: unknown;
}

/** The subset of pi's `tool_result` event the recorder reads. */
export interface ToolResultEventLike extends ToolCallEventLike {
  content?: unknown;
  details?: unknown;
  isError?: boolean;
}

/**
 * Flatten pi's result `content` to the text it carried.
 *
 * A tool result is an array of content blocks (`{type: "text", text}`); a
 * plain string is accepted too because the fake pi used in tests and some
 * built-ins hand one back directly.
 */
export function contentToText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          const text = (block as Record<string, unknown>).text;
          if (typeof text === "string") return text;
        }
        return "";
      })
      .filter((part) => part !== "")
      .join("\n");
  }
  if (typeof content === "object") {
    const text = (content as Record<string, unknown>).text;
    if (typeof text === "string") return text;
  }
  return String(content);
}

// ------------------------------------------------------------------ recorder

export interface WalkRecorderOptions {
  /** The session export directory; `walk.jsonl` is written inside it. */
  exportDir: string;
  /** The loaded contract policy — redaction patterns and the raw cap. */
  policy: ContractPolicy;
  /** Clock, injectable for tests. */
  now?: () => Date;
  /** Install a `process.on("exit")` finalizer. Default true. */
  installExitHook?: boolean;
  /** Override read-tool recognition (a tool module may register its own name). */
  isReadTool?: (toolName: string) => boolean;
  /** Registry key of the active model, when one was resolved (env ASSOCIATE_MODEL, else the registry default). */
  model?: string;
  /** The active model's lobes role (its wire id), when a model was resolved. */
  lobes_role?: string;
  /**
   * The contract's tool-name → source-kind table (`accuracy.json`
   * `source_kinds`). Absent: entries carry no `source_kind`.
   */
  sourceKinds?: Readonly<Record<string, SourceKind>>;
}

/**
 * Writes `walk.jsonl` from Pi tool events.
 *
 * One instance per session. Construct it once at extension load so the file
 * path exists before the first tool runs and a launcher can print it.
 */
export class WalkRecorder {
  readonly walkPath: string;

  private readonly filter: RedactionFilter;
  private readonly now: () => Date;
  private readonly isReadTool: (toolName: string) => boolean;
  /** Inline cap from the contract's `caps.max_raw_chars`; 0 means no cap. */
  private readonly inlineLimit: number;
  private readonly startedAt: number;
  private readonly exportDir: string;
  private readonly sourceKinds: Readonly<Record<string, SourceKind>>;
  /** Whether the format marker question has been settled for this file. */
  private formatChecked = false;
  private readonly pending = new Map<string, { toolName: string; args: unknown }>();
  /** Calls the guard refused (L4): recorded at refusal, never again from a late tool_result. */
  private readonly blocked = new Set<string>();
  /**
   * The walk id of the entry written for each call id (plan t9), so the
   * handler that stamps a result — or a refusal reason — names the very entry
   * this recorder wrote for that call, and `tool_execution_end` can tell a
   * call that was already recorded from one pi rejected before the hook.
   */
  private readonly entryIdByCall = new Map<string, string>();

  private nextId: number;
  private nextChildId: number;
  private nextReminderId: number;
  private toolCalls = 0;
  private anyTruncated = false;
  private unresolved = 0;
  private explicitOutcome?: WalkOutcome;
  private finalized?: WalkRun;
  private readonly model?: string;
  private readonly lobes_role?: string;

  constructor(options: WalkRecorderOptions) {
    this.walkPath = join(options.exportDir, WALK_FILENAME);
    this.exportDir = options.exportDir;
    this.sourceKinds = options.sourceKinds ?? {};
    this.filter = compileRedaction(options.policy);
    this.now = options.now ?? (() => new Date());
    this.isReadTool = options.isReadTool ?? isReadToolName;
    const caps = policySection(options.policy, "caps");
    this.inlineLimit = typeof caps.max_raw_chars === "number" ? caps.max_raw_chars : 0;
    this.startedAt = Date.now();
    this.model = options.model;
    this.lobes_role = options.lobes_role;
    this.nextId = countExistingEntries(this.walkPath) + 1;
    this.nextChildId = countExistingChildren(this.walkPath) + 1;
    this.nextReminderId = countExistingLines(this.walkPath, "reminder") + 1;

    // A headless `pi -p` may exit without a `session_shutdown`; without this
    // the run record — the only place reliability is recorded (c36) — would be
    // missing from otherwise complete runs. `exit` handlers may only do
    // synchronous work, which is exactly what `appendFileSync` is.
    if (options.installExitHook !== false) {
      process.once("exit", () => {
        try {
          this.finalize();
        } catch {
          // Exiting must not be turned into a crash by the recorder.
        }
      });
    }
  }

  /** How many entries this recorder has written. */
  get entryCount(): number {
    return this.nextId - 1;
  }

  /**
   * Every walk id that exists so far — `w1` … `w<entryCount>`.
   *
   * Ids are issued densely from 1 (see {@link append}), so this is the exact
   * set of citable evidence at the moment it is called. `finish` uses it to
   * drop a claim's references to entries that were never recorded.
   */
  entryIds(): string[] {
    const ids: string[] = [];
    for (let n = 1; n <= this.entryCount; n += 1) ids.push(`w${n}`);
    return ids;
  }

  /**
   * The walk id of the entry this recorder wrote for `toolCallId`, or
   * undefined when it wrote none (yet). Used to stamp the result the model is
   * sent with the id of its own entry (plan t9).
   */
  entryIdFor(toolCallId: string | undefined): string | undefined {
    return toolCallId ? this.entryIdByCall.get(toolCallId) : undefined;
  }

  /** Pin the run's outcome; the guard or a launcher may know better than us. */
  markOutcome(outcome: WalkOutcome): void {
    this.explicitOutcome = outcome;
  }

  /**
   * Lift a pinned outcome, only when it is still `outcome` — for a pin whose
   * premise turned out false (the refusal cap's `agent_end` pin, when pi
   * starts another turn of the same run). A different pin is left alone.
   */
  clearOutcome(outcome: WalkOutcome): void {
    if (this.explicitOutcome === outcome) this.explicitOutcome = undefined;
  }

  /**
   * Remember a call's arguments until its result arrives.
   *
   * No entry is written here: an entry needs the result, and writing a second
   * line per call would break the 1:1 event mapping c43 requires. A call whose
   * result never arrives is flushed as its own entry by {@link finalize},
   * carrying the reason; a call the guard refused is recorded at refusal by
   * {@link recordBlocked} instead.
   */
  noteToolCall(event: ToolCallEventLike): void {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    if (!toolCallId) return;
    // A deep copy, taken now: these are the arguments *as asked*. pi lets a
    // later tool_call hook mutate event.input in place, and the object the
    // tool_result event carries may be that patched one.
    this.pending.set(toolCallId, {
      toolName: typeof event.toolName === "string" ? event.toolName : "unknown",
      args: snapshot(event.input ?? event.args),
    });
  }

  /**
   * Record a call the `tool_call` guard refused, with the refusal as its
   * error (L4). Pi sends no `tool_result` for a blocked call, so without this
   * it would be flushed at finalize as unresolved and turn the run outcome
   * into "error"; a refusal is the guard working, not a failed run. A call id
   * that is not pending is ignored. Returns the entry written, if any.
   */
  recordBlocked(toolCallId: string | undefined, reason: string): WalkEntry | undefined {
    if (!toolCallId) return undefined;
    const pendingCall = this.pending.get(toolCallId);
    if (!pendingCall) return undefined;
    this.pending.delete(toolCallId);
    this.blocked.add(toolCallId);
    this.toolCalls += 1;
    return this.append(
      this.buildEntry({
        tool: pendingCall.toolName,
        args: pendingCall.args ?? {},
        text: undefined,
        truncated: false,
        error: `refused: ${reason}`,
      }),
      toolCallId,
    );
  }

  /**
   * Record a call pi ended without ever sending it to the `tool_call` hook
   * (approved deviation, 2026-11-17, plan t9). pi 1.5.2: "An unknown tool or
   * invalid arguments skip `tool_call`; … Each of these still gets
   * `tool_execution_end` with an error result". Such a call is a real event
   * the model caused and saw an error for, so it gets one entry: the tool
   * name, the arguments when the event carries them, pi's error text as
   * `error`, and no saved result.
   *
   * A call id this recorder already knows — noted at `tool_call` (pending, or
   * an aborted call {@link finalize} will flush), refused, or recorded from
   * its `tool_result` — is ignored, so no call is written twice. Nothing is
   * written once the walk is finalized. Returns the entry written, if any.
   */
  recordUnseenEnd(event: ToolResultEventLike & { result?: unknown }): WalkEntry | undefined {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    if (!toolCallId || this.finalized) return undefined;
    if (this.pending.has(toolCallId) || this.blocked.has(toolCallId) || this.entryIdByCall.has(toolCallId)) {
      return undefined;
    }
    const result = event.result as { content?: unknown } | undefined;
    const text = contentToText(result && typeof result === "object" ? result.content : event.content);
    this.toolCalls += 1;
    return this.append(
      this.buildEntry({
        tool: typeof event.toolName === "string" ? event.toolName : "unknown",
        args: snapshot(event.args ?? event.input ?? {}),
        text: undefined,
        truncated: false,
        error: text || "pi ended this tool call before the tool_call hook, with no error text",
      }),
      toolCallId,
    );
  }

  /** Append one entry for a finished tool event. Returns what was written. */
  recordToolResult(event: ToolResultEventLike): WalkEntry | undefined {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    // Already recorded at refusal (L4): one entry per call, never two.
    if (toolCallId && this.blocked.has(toolCallId)) return undefined;
    const remembered = toolCallId ? this.pending.get(toolCallId) : undefined;
    if (toolCallId) this.pending.delete(toolCallId);

    const tool =
      (typeof event.toolName === "string" ? event.toolName : undefined) ??
      remembered?.toolName ??
      "unknown";
    // As asked: the copy taken at tool_call wins over whatever the result
    // event carries; a result with no preceding call falls back to its own.
    const rawArgs = remembered ? (remembered.args ?? {}) : (event.input ?? event.args ?? {});
    const text = contentToText(event.content);
    const details =
      event.details && typeof event.details === "object" && !Array.isArray(event.details)
        ? (event.details as Record<string, unknown>)
        : {};
    const detailTruncated = details.truncated === true;

    const entry = this.buildEntry({
      tool,
      args: rawArgs,
      text,
      truncated: detailTruncated,
      details,
      error: event.isError === true ? text || "tool call failed" : undefined,
    });
    this.toolCalls += 1;
    return this.append(entry, toolCallId);
  }

  /**
   * Append one safety-gate decision as its own `{"gate": <$defs/gate>}` line.
   *
   * The entry comes from `lib/gate.ts`, which already redacted its reason; it
   * passes through this recorder's filter again anyway so no line of the walk
   * is written unfiltered. Gate lines are not tool events: they take no walk
   * id and do not count toward the run record's `tool_calls`. Throws when the
   * line cannot be written — the caller (the `tool_call` guard) refuses the
   * call rather than run a mutation whose decision went unrecorded.
   */
  recordGate(entry: GateEntry): GateEntry {
    if (this.finalized) {
      throw new Error("the walk is already finalized; a gate decision can no longer be recorded");
    }
    const redacted = redactValue(entry, this.filter);
    this.writeLine({ gate: redacted });
    return redacted;
  }

  /**
   * Append one child-walk link as its own `{"child": <$defs/child>}` line
   * (plan t16: the parent walk references every child walk by path).
   *
   * Like a gate line, a child line is not a tool event: it takes no walk id
   * and does not count toward `tool_calls`. Child ids are their own sequence,
   * `c1`, `c2`, …, continued from any child lines already in the file. The
   * line passes through the redaction filter like every other line. Throws
   * when the line cannot be written — the spawn tool then launches nothing,
   * so no child ever runs without its link on disk.
   */
  recordChild(link: ChildLink): ChildEntry {
    if (this.finalized) {
      throw new Error("the walk is already finalized; a child walk can no longer be linked");
    }
    const entry: ChildEntry = redactValue(
      {
        id: `c${this.nextChildId}`,
        ts: this.now().toISOString(),
        child_model: link.child_model,
        child_walk: link.child_walk,
        child_session_id: link.child_session_id,
      },
      this.filter,
    );
    this.writeLine({ child: entry });
    this.nextChildId += 1;
    return entry;
  }

  /**
   * Append one finish reminder as its own `{"reminder": <$defs/reminder>}`
   * line (deviation d3). Like a child line it is not a tool event: it takes
   * no walk id and does not count toward `tool_calls`. Reminder ids are their
   * own sequence, `r1`, `r2`, …, continued from any reminder lines already in
   * the file. Throws when the line cannot be written — the reminder is then
   * not sent, so none is ever sent without its line on disk.
   */
  recordReminder(info: { max: number }): ReminderEntry {
    if (this.finalized) {
      throw new Error("the walk is already finalized; a reminder can no longer be recorded");
    }
    const entry: ReminderEntry = redactValue(
      { id: `r${this.nextReminderId}`, ts: this.now().toISOString(), max: info.max },
      this.filter,
    );
    this.writeLine({ reminder: entry });
    this.nextReminderId += 1;
    return entry;
  }

  /**
   * Write the run record and close the walk. Idempotent: the session can end
   * through `session_shutdown` and through process exit, and one run record is
   * what the schema describes.
   */
  finalize(outcome?: WalkOutcome): WalkRun | undefined {
    if (this.finalized) return this.finalized;

    // Calls Pi fired but never resolved are real events, so they are recorded —
    // as entries carrying why they have no result, never silently dropped.
    for (const [toolCallId, pendingCall] of this.pending) {
      this.unresolved += 1;
      this.toolCalls += 1;
      this.append(
        this.buildEntry({
          tool: pendingCall.toolName,
          args: pendingCall.args ?? {},
          text: undefined,
          truncated: false,
          error:
            "no tool_result was received for this tool call: the run ended first",
        }),
        toolCallId,
      );
    }
    this.pending.clear();

    const run: WalkRun = {
      duration_ms: Math.max(0, Date.now() - this.startedAt),
      tool_calls: this.toolCalls,
      outcome: this.explicitOutcome ?? outcome ?? (this.unresolved > 0 ? "error" : "ok"),
      truncated: this.anyTruncated,
      // Only when resolved: the on-disk JSON drops undefined keys, and the
      // returned record must equal the line written.
      ...(this.model !== undefined ? { model: this.model } : {}),
      ...(this.lobes_role !== undefined ? { lobes_role: this.lobes_role } : {}),
    };
    this.writeLine({ run });
    this.finalized = run;
    return run;
  }

  // -- internals ------------------------------------------------------------

  private buildEntry(input: {
    tool: string;
    args: unknown;
    /** The result text; undefined when the call produced no result at all. */
    text: string | undefined;
    truncated: boolean;
    details?: Record<string, unknown>;
    error?: string;
  }): WalkEntry {
    const id = `w${this.nextId}`;
    // Redact first, digest second: the sha256 is of the content this file
    // stores, so a reader can recompute it from the walk instead of taking it
    // on trust — and no unredacted byte is ever hashed into the artifact.
    const content = this.filter.apply(input.text ?? "");
    const bytes = Buffer.byteLength(content, "utf8");
    const overLimit = this.inlineLimit > 0 && content.length > this.inlineLimit;
    const sha256 = createHash("sha256").update(content, "utf8").digest("hex");

    const result: WalkResult = overLimit
      ? { sha256, bytes }
      : this.isReadTool(input.tool)
        ? { content, sha256, bytes }
        : { content };

    // The schema types `args` as an object; a tool called with a bare value
    // still has to be recorded, so it is wrapped rather than dropped.
    const args = redactValue(input.args, this.filter);
    const argsObject = isPlainObject(args) ? args : { value: args };

    // The saved result: the same redacted text, in full up to the cap. It is
    // written before the entry line, so an entry never names a missing file.
    let savedResult: string | undefined;
    let partial = true;
    if (input.text !== undefined) {
      try {
        const saved = saveResult(this.exportDir, id, content, this.inlineLimit);
        savedResult = saved.name;
        partial = saved.partial;
      } catch {
        // Not saved: the entry is still recorded, without a file, as partial.
      }
    }

    const details = input.details ?? {};
    const entry: WalkEntry = {
      id,
      ts: this.now().toISOString(),
      tool: input.tool,
      args: argsObject,
      result,
      partial,
      truncated: input.truncated || overLimit,
    };

    const purpose = isPlainObject(input.args) ? input.args[PURPOSE_ARG] : undefined;
    if (typeof purpose === "string") entry.purpose = this.filter.apply(purpose);

    const used = details[ARGS_USED_KEY];
    if (isPlainObject(used)) entry.args_used = redactValue(used, this.filter);
    const dropped = details[DROPPED_ARGS_KEY];
    if (Array.isArray(dropped) && dropped.every((name) => typeof name === "string")) {
      entry.dropped_args = dropped.map((name) => this.filter.apply(name));
    }

    if (Object.hasOwn(this.sourceKinds, input.tool)) entry.source_kind = this.sourceKinds[input.tool];
    if (savedResult !== undefined) entry.saved_result = savedResult;

    if (input.text !== undefined) {
      const reported = details[NOT_SHOWN_CHARS_KEY];
      if (typeof reported === "number" && Number.isInteger(reported) && reported >= 0) {
        entry.not_shown_chars = reported;
      } else if (!input.truncated) {
        entry.not_shown_chars = 0;
      }
    }

    if (input.error) entry.error = this.filter.apply(input.error);
    return entry;
  }

  /**
   * Write one entry and issue its id. The id was allocated by
   * {@link buildEntry} from `nextId`; it is bound to `toolCallId` here, only
   * after the line is on disk, so a stamp never names an entry that was not
   * written.
   */
  private append(entry: WalkEntry, toolCallId?: string): WalkEntry {
    this.writeLine(entry);
    if (toolCallId) this.entryIdByCall.set(toolCallId, entry.id);
    this.nextId += 1;
    if (entry.truncated) this.anyTruncated = true;
    return entry;
  }

  /**
   * Append one complete JSON line. The only place the walk file is written:
   * every line is `JSON.stringify` of a record, so no text inside a record —
   * a purpose, an argument, a result — can ever start a line of its own.
   * The first line ever written to an empty or absent file is preceded by the
   * format marker.
   */
  private writeLine(record: unknown): void {
    if (!this.formatChecked) {
      if (!existsSync(this.walkPath) || statSync(this.walkPath).size === 0) {
        appendFileSync(this.walkPath, `${JSON.stringify({ format: WALK_FORMAT })}\n`, "utf8");
      }
      this.formatChecked = true;
    }
    appendFileSync(this.walkPath, `${JSON.stringify(record)}\n`, "utf8");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * A deep copy of a call's arguments as they are now. Arguments are JSON from
 * the model, so `structuredClone` covers them; anything it cannot copy is
 * kept by reference rather than dropped.
 */
function snapshot(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

/** Entries already in a walk file, so a second recorder never re-issues `w1`. */
function countExistingEntries(walkPath: string): number {
  if (!existsSync(walkPath)) return 0;
  let count = 0;
  for (const line of readFileSync(walkPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      // Run, gate, child, reminder and format lines are not tool entries and take no walk id.
      if (
        record &&
        typeof record === "object" &&
        ("run" in record || "gate" in record || "child" in record || "reminder" in record || "format" in record)
      ) {
        continue;
      }
    } catch {
      // A torn line still occupied an id when it was written.
    }
    count += 1;
  }
  return count;
}

/** Child lines already in a walk file, so a second recorder never re-issues `c1`. */
function countExistingChildren(walkPath: string): number {
  return countExistingLines(walkPath, "child");
}

/** Lines of one non-tool kind (`child`, `reminder`) already in a walk file. */
function countExistingLines(walkPath: string, kind: string): number {
  if (!existsSync(walkPath)) return 0;
  let count = 0;
  for (const line of readFileSync(walkPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record && typeof record === "object" && kind in record) count += 1;
    } catch {
      // A torn line is counted as a walk entry by countExistingEntries, not here.
    }
  }
  return count;
}

/**
 * Install the recorder on a pi instance.
 *
 * Additive only: the `tool_call` handler records and returns nothing, so it
 * never blocks — blocking is the write guard's job and stays there.
 */
export function installWalkRecorder(
  pi: {
    on(event: string, handler: (event: Record<string, unknown>) => unknown): void;
  },
  ctx: AssociateContext,
  options: { model?: string; lobes_role?: string } = {},
): WalkRecorder {
  const recorder = new WalkRecorder({
    exportDir: ctx.session.exportDir,
    policy: ctx.policy,
    sourceKinds: ctx.contract?.accuracy?.source_kinds,
    model: options.model,
    lobes_role: options.lobes_role,
  });

  pi.on("tool_call", (event) => {
    recorder.noteToolCall(event as ToolCallEventLike);
    // Returning nothing leaves the call unblocked and the result unpatched.
  });
  pi.on("tool_result", (event) => {
    recorder.recordToolResult(event as ToolResultEventLike);
  });
  pi.on("session_shutdown", () => {
    recorder.finalize();
  });

  return recorder;
}
