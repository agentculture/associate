/**
 * The walk recorder: artifact A of a run.
 *
 * Spec c43: every walk entry maps 1:1 to a Pi event the harness received — the
 * harness adds the id, the digest and the timestamp and **never synthesizes an
 * entry**. So this module hooks `tool_call` and `tool_result` and writes one
 * entry per completed tool event; nothing here invents a call the model did not
 * make, and nothing here is reachable by the model (h24: the walk cannot be
 * hallucinated, only the statements can be wrong).
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
 * one `$defs/entry` per line, then a final `{"run": <$defs/run>}` line.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { policySection, type ContractPolicy } from "./contract.ts";
import type { AssociateContext } from "./context.ts";

/** The walk's file name inside the session export directory. */
export const WALK_FILENAME = "walk.jsonl";

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
  args: Record<string, unknown>;
  result: WalkResult;
  truncated: boolean;
  error?: string;
}

export interface WalkRun {
  duration_ms: number;
  tool_calls: number;
  outcome: WalkOutcome;
  truncated: boolean;
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
  private readonly pending = new Map<string, { toolName: string; args: unknown }>();

  private nextId: number;
  private toolCalls = 0;
  private anyTruncated = false;
  private unresolved = 0;
  private explicitOutcome?: WalkOutcome;
  private finalized?: WalkRun;

  constructor(options: WalkRecorderOptions) {
    this.walkPath = join(options.exportDir, WALK_FILENAME);
    this.filter = compileRedaction(options.policy);
    this.now = options.now ?? (() => new Date());
    this.isReadTool = options.isReadTool ?? isReadToolName;
    const caps = policySection(options.policy, "caps");
    this.inlineLimit = typeof caps.max_raw_chars === "number" ? caps.max_raw_chars : 0;
    this.startedAt = Date.now();
    this.nextId = countExistingEntries(this.walkPath) + 1;

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

  /** Pin the run's outcome; the guard or a launcher may know better than us. */
  markOutcome(outcome: WalkOutcome): void {
    this.explicitOutcome = outcome;
  }

  /**
   * Remember a call's arguments until its result arrives.
   *
   * No entry is written here: an entry needs the result, and writing a second
   * line per call would break the 1:1 event mapping c43 requires. A call whose
   * result never arrives — blocked by the write guard, or cut short — is
   * flushed as its own entry by {@link finalize}, carrying the reason.
   */
  noteToolCall(event: ToolCallEventLike): void {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    if (!toolCallId) return;
    this.pending.set(toolCallId, {
      toolName: typeof event.toolName === "string" ? event.toolName : "unknown",
      args: event.input ?? event.args,
    });
  }

  /** Append one entry for a finished tool event. Returns what was written. */
  recordToolResult(event: ToolResultEventLike): WalkEntry {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    const remembered = toolCallId ? this.pending.get(toolCallId) : undefined;
    if (toolCallId) this.pending.delete(toolCallId);

    const tool =
      (typeof event.toolName === "string" ? event.toolName : undefined) ??
      remembered?.toolName ??
      "unknown";
    const rawArgs = event.input ?? event.args ?? remembered?.args ?? {};
    const text = contentToText(event.content);
    const details = event.details;
    const detailTruncated =
      !!details &&
      typeof details === "object" &&
      (details as Record<string, unknown>).truncated === true;

    const entry = this.buildEntry({
      tool,
      args: rawArgs,
      text,
      truncated: detailTruncated,
      error: event.isError === true ? text || "tool call failed" : undefined,
    });
    this.toolCalls += 1;
    return this.append(entry);
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
    for (const [, pendingCall] of this.pending) {
      this.unresolved += 1;
      this.toolCalls += 1;
      this.append(
        this.buildEntry({
          tool: pendingCall.toolName,
          args: pendingCall.args ?? {},
          text: "",
          truncated: false,
          error:
            "no tool_result was received for this tool call: it was blocked or the run ended first",
        }),
      );
    }
    this.pending.clear();

    const run: WalkRun = {
      duration_ms: Math.max(0, Date.now() - this.startedAt),
      tool_calls: this.toolCalls,
      outcome: this.explicitOutcome ?? outcome ?? (this.unresolved > 0 ? "error" : "ok"),
      truncated: this.anyTruncated,
    };
    appendFileSync(this.walkPath, `${JSON.stringify({ run })}\n`, "utf8");
    this.finalized = run;
    return run;
  }

  // -- internals ------------------------------------------------------------

  private buildEntry(input: {
    tool: string;
    args: unknown;
    text: string;
    truncated: boolean;
    error?: string;
  }): WalkEntry {
    // Redact first, digest second: the sha256 is of the content this file
    // stores, so a reader can recompute it from the walk instead of taking it
    // on trust — and no unredacted byte is ever hashed into the artifact.
    const content = this.filter.apply(input.text);
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
    const argsObject =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : { value: args };

    const entry: WalkEntry = {
      id: `w${this.nextId}`,
      ts: this.now().toISOString(),
      tool: input.tool,
      args: argsObject,
      result,
      truncated: input.truncated || overLimit,
    };
    if (input.error) entry.error = this.filter.apply(input.error);
    return entry;
  }

  private append(entry: WalkEntry): WalkEntry {
    appendFileSync(this.walkPath, `${JSON.stringify(entry)}\n`, "utf8");
    this.nextId += 1;
    if (entry.truncated) this.anyTruncated = true;
    return entry;
  }
}

/** Entries already in a walk file, so a second recorder never re-issues `w1`. */
function countExistingEntries(walkPath: string): number {
  if (!existsSync(walkPath)) return 0;
  return readFileSync(walkPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() && !line.includes('"run"')).length;
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
): WalkRecorder {
  const recorder = new WalkRecorder({
    exportDir: ctx.session.exportDir,
    policy: ctx.policy,
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
