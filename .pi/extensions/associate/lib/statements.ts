/**
 * The statements artifact: artifact B of a run (issue #4, spec c25/c31).
 *
 * The walk (artifact A) is what the harness saw. This module is what the
 * *model said*, cross-checked against it. Four rules, and none of them is the
 * model's to bend:
 *
 * - **Evidence is parsed, not asserted.** Each paragraph or list item of the
 *   final assistant message becomes one statement, and its `evidence` list is
 *   the `[wN]` markers `AGENTS.md` asks the model to write inline. A statement
 *   with no marker gets `status: "unreferenced"` and renders with a visible
 *   `[UNREFERENCED]` marker.
 * - **A citation is checked, never believed.** Every `path:N` citation is
 *   resolved against the read ranges the walk actually recorded. Resolving is
 *   marked `encountered`; not resolving is marked `unverifiable`.
 * - **`encountered` is not `supported`** (the evaluation correction, h25). A
 *   citation that lands inside a recorded read range proves the agent
 *   *encountered* those lines. It says nothing about whether they agree with
 *   the claim. The word "supported" appears nowhere in this artifact, in any
 *   spelling — not as a verdict and not as its negation.
 * - **`not_fully_read` is set by the tool that truncated.** It is derived from
 *   the walk's `truncated` flags, never from the model's prose (h19): an agent
 *   claiming it read everything cannot make this false, and an agent silent
 *   about truncation cannot make it true.
 *
 * **Streamed, never buffered**, for the reason `walk.ts` gives: a run killed
 * mid-flight must still leave a readable artifact. `statements.md` is
 * genuinely appended — header at construction, one line per statement as it
 * arrives, footer at finalize. `statements.json` has no append-safe form (it
 * is one JSON object), so it is instead *rewritten complete-so-far* after
 * every statement. Same guarantee, different mechanism; neither waits for
 * exit.
 *
 * The on-disk shape of `statements.json` is
 * `associate/contract/schemas/statements.schema.json`, with two documented
 * additions the schema permits: a `walk_id` on a resolved citation (which walk
 * entry it resolved into) and a per-statement `citations` list (which
 * citations came from that statement's own text).
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContractPolicy } from "./contract.ts";
import type { AssociateContext } from "./context.ts";
import type { Handback } from "./handback.ts";
import {
  WALK_FILENAME,
  compileRedaction,
  isReadToolName,
  type RedactionFilter,
} from "./walk.ts";

/** The statements artifact's file names inside the session export directory. */
export const STATEMENTS_MD_FILENAME = "statements.md";
export const STATEMENTS_JSON_FILENAME = "statements.json";

// ------------------------------------------------------------------- shapes

export type CitationCheck = "encountered" | "unverifiable";
export type StatementStatus = "referenced" | "unreferenced";

export interface StatementCitation {
  path: string;
  line: number;
  check: CitationCheck;
  /** The walk entry the citation resolved into; absent when unverifiable. */
  walk_id?: string;
}

export interface StatementEntry {
  text: string;
  evidence: string[];
  status: StatementStatus;
  citations: StatementCitation[];
}

export interface StatementsArtifact {
  statements: StatementEntry[];
  citations: StatementCitation[];
  not_fully_read: boolean;
}

/** A walk entry as read back from `walk.jsonl` — tolerant of partial lines. */
export interface WalkEntryLike {
  id: string;
  ts?: string;
  tool: string;
  args?: Record<string, unknown>;
  result?: { content?: string; sha256?: string; bytes?: number };
  truncated?: boolean;
  error?: string;
}

/** One contiguous range of a file the walk records as having been returned. */
export interface ReadRange {
  walkId: string;
  path: string;
  start: number;
  end: number;
}

// ------------------------------------------------------------------ parsing

/**
 * Walk ids referenced inline, in first-seen order and deduplicated.
 *
 * Accepts `[w3]` and `[w3, w7]`. The id shape is the statements schema's own
 * `^w[1-9][0-9]*$`, so `[w0]` and `[wx]` are not evidence — they are prose.
 */
export function parseEvidence(text: string): string[] {
  const found: string[] = [];
  const groups = text.matchAll(/\[((?:w[1-9][0-9]*)(?:\s*,\s*w[1-9][0-9]*)*)\]/g);
  for (const group of groups) {
    for (const id of group[1].split(",")) {
      const trimmed = id.trim();
      if (trimmed && !found.includes(trimmed)) found.push(trimmed);
    }
  }
  return found;
}

/**
 * Split an assistant message into one statement per paragraph or list item.
 *
 * Headings are structure, not claims, and fenced code is quoted material, so
 * both are skipped. A wrapped paragraph is re-joined into one statement; a
 * continuation line indented under a list item becomes its own statement
 * rather than being silently glued to the item above it.
 */
export function splitStatements(message: string): string[] {
  const out: string[] = [];
  let paragraph: string[] = [];
  let inFence = false;

  const flush = (): void => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(" ").trim();
    if (text) out.push(text);
    paragraph = [];
  };

  for (const raw of message.split("\n")) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line) {
      flush();
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      flush();
      continue;
    }
    const item = line.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (item) {
      flush();
      const text = item[1].trim();
      if (text) out.push(text);
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return out;
}

/**
 * `path:line` citations in a piece of prose.
 *
 * A path is recognized by having a file extension, so a bare "42 lines" is not
 * mistaken for a citation. Surrounding backticks, parentheses and sentence
 * punctuation are not part of the path.
 */
export function parseCitations(text: string): Array<{ path: string; line: number }> {
  const out: Array<{ path: string; line: number }> = [];
  const matches = text.matchAll(/([A-Za-z0-9._\-/\\]*[A-Za-z0-9_\-]\.[A-Za-z0-9_]+):(\d+)/g);
  for (const match of matches) {
    const path = match[1];
    const line = Number.parseInt(match[2], 10);
    if (!Number.isFinite(line) || line < 1) continue;
    if (out.some((item) => item.path === path && item.line === line)) continue;
    out.push({ path, line });
  }
  return out;
}

/** The text blocks of an assistant message, joined. Thinking is not a claim. */
export function assistantMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as Record<string, unknown>;
      if (record.type !== "text") return "";
      return typeof record.text === "string" ? record.text : "";
    })
    .filter((part) => part !== "")
    .join("\n")
    .trim();
}

/** True when the assistant message is still calling tools — so not a hand-back. */
export function messageHasToolCalls(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      !!block && typeof block === "object" && (block as Record<string, unknown>).type === "toolCall",
  );
}

// -------------------------------------------------------------- walk ranges

/** Read `walk.jsonl` back into entries, dropping the final run record line. */
export function readWalkEntries(walkPath: string): WalkEntryLike[] {
  if (!existsSync(walkPath)) return [];
  const entries: WalkEntryLike[] = [];
  for (const line of readFileSync(walkPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      // A line torn by a kill mid-write is not an entry; the walk's own
      // streaming contract says every *complete* line is a complete record.
      continue;
    }
    if (!record || typeof record !== "object") continue;
    const candidate = record as Record<string, unknown>;
    if (typeof candidate.id !== "string" || typeof candidate.tool !== "string") continue;
    entries.push(candidate as unknown as WalkEntryLike);
  }
  return entries;
}

/** The run record line of a walk, when the run finished. */
export function readWalkRun(walkPath: string): Record<string, unknown> | undefined {
  if (!existsSync(walkPath)) return undefined;
  for (const line of readFileSync(walkPath, "utf8").split("\n").reverse()) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record && typeof record === "object" && record.run && typeof record.run === "object") {
        return record.run as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

/** First and last absolute line numbers stamped onto `read`'s output. */
function stampedRange(content: string): { start: number; end: number } | undefined {
  let start: number | undefined;
  let end: number | undefined;
  for (const line of content.split("\n")) {
    const match = line.match(/^(\d+)\t/);
    if (!match) continue;
    const number = Number.parseInt(match[1], 10);
    if (!Number.isFinite(number)) continue;
    if (start === undefined) start = number;
    end = number;
  }
  if (start === undefined || end === undefined) return undefined;
  return { start, end };
}

/**
 * The file ranges a walk records as having been *returned to the model*.
 *
 * Derived from the stamped content first — `read` prefixes every returned line
 * with its absolute number, so the content itself is the authority on what the
 * model actually saw, including when a budget cut the window short. Only when
 * the content was too large to inline (the walk then stores a digest) does
 * this fall back to the requested `start_line`/`end_line`. A read that failed
 * returned nothing, so it contributes no range.
 */
export function readRangesFromWalk(entries: readonly WalkEntryLike[]): ReadRange[] {
  const ranges: ReadRange[] = [];
  for (const entry of entries) {
    if (entry.error) continue;
    if (!isReadToolName(entry.tool)) continue;
    const path = entry.args?.path;
    if (typeof path !== "string" || !path.trim()) continue;

    const content = entry.result?.content;
    const fromContent = typeof content === "string" ? stampedRange(content) : undefined;
    if (fromContent) {
      ranges.push({ walkId: entry.id, path, ...fromContent });
      continue;
    }
    const start = entry.args?.start_line;
    const end = entry.args?.end_line;
    if (typeof start === "number" && typeof end === "number" && end >= start) {
      ranges.push({ walkId: entry.id, path, start, end });
    }
    // Otherwise the walk does not record which lines came back, so nothing is
    // claimed: citations into this file stay unverifiable rather than being
    // waved through.
  }
  return ranges;
}

/** True when a walk entry recorded a truncated result. */
export function anyTruncated(entries: readonly WalkEntryLike[]): boolean {
  return entries.some((entry) => entry.truncated === true);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** True when two path spellings name the same file as far as the walk shows. */
export function pathsMatch(citationPath: string, walkPath: string): boolean {
  const a = normalizePath(citationPath);
  const b = normalizePath(walkPath);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/**
 * Resolve one `path:line` citation against the walk's recorded read ranges.
 *
 * `encountered` means the walk shows those lines were returned to the model.
 * It is **not** a claim that the lines support anything.
 */
export function verifyCitation(
  citation: { path: string; line: number },
  ranges: readonly ReadRange[],
): StatementCitation {
  for (const range of ranges) {
    if (!pathsMatch(citation.path, range.path)) continue;
    if (citation.line < range.start || citation.line > range.end) continue;
    return { path: citation.path, line: citation.line, check: "encountered", walk_id: range.walkId };
  }
  return { path: citation.path, line: citation.line, check: "unverifiable" };
}

// ----------------------------------------------------------------- markdown

const MD_HEADER = [
  "# associate statements",
  "",
  "Artifact B of this run: what the model said, cross-checked against the walk.",
  "",
  "- A statement carries the walk ids it referenced; one with none is marked",
  "  `[UNREFERENCED]`.",
  "- A citation marked `ENCOUNTERED` means the walk records that those lines were",
  "  returned to the model. It does **not** mean they agree with the statement.",
  "- `NOT FULLY READ` is set by the tool that truncated, never by the model.",
  "",
  "## Statements",
  "",
  "",
].join("\n");

/** One statement as a marked markdown list item. */
export function renderStatementLine(entry: StatementEntry): string {
  const marker =
    entry.status === "referenced" ? `[REFERENCED ${entry.evidence.join(", ")}]` : "[UNREFERENCED]";
  return `- ${marker} ${entry.text}`;
}

/** One citation as a marked markdown list item. */
export function renderCitationLine(citation: StatementCitation): string {
  const verdict = citation.check === "encountered" ? "ENCOUNTERED" : "UNVERIFIABLE";
  const where = citation.walk_id ? ` (${citation.walk_id})` : "";
  return `- ${citation.path}:${citation.line} — ${verdict}${where}`;
}

/** The citations section and the completeness line. */
export function renderFooter(artifact: StatementsArtifact): string {
  const lines = ["", "## Citations", ""];
  if (artifact.citations.length === 0) lines.push("- none");
  else lines.push(...artifact.citations.map(renderCitationLine));
  lines.push("", "## Completeness", "");
  lines.push(
    artifact.not_fully_read
      ? "NOT FULLY READ: at least one tool truncated its input during this run, so the walk covers less than the whole of what was opened."
      : "No tool reported truncating its input during this run.",
  );
  lines.push("");
  return lines.join("\n");
}

/** The whole artifact as markdown — the one-shot equivalent of the stream. */
export function renderStatementsMarkdown(artifact: StatementsArtifact): string {
  const body =
    artifact.statements.length === 0
      ? "- none\n"
      : `${artifact.statements.map(renderStatementLine).join("\n")}\n`;
  return `${MD_HEADER}${body}${renderFooter(artifact)}`;
}

// ----------------------------------------------------------------- recorder

export interface StatementsRecorderOptions {
  /** The session export directory; the artifact is written inside it. */
  exportDir: string;
  /** The walk this run is recording, read back for ranges and truncation. */
  walkPath: string;
  /** The loaded contract policy — redaction patterns. */
  policy: ContractPolicy;
  /** Install a `process.on("exit")` finalizer. Default true. */
  installExitHook?: boolean;
}

/** Builds `statements.md` and `statements.json` as the model speaks. */
export class StatementsRecorder {
  readonly markdownPath: string;
  readonly jsonPath: string;

  private readonly walkPath: string;
  private readonly filter: RedactionFilter;
  private readonly statements: StatementEntry[] = [];
  private readonly citations: StatementCitation[] = [];
  private notFullyRead = false;
  private finalized = false;

  constructor(options: StatementsRecorderOptions) {
    this.markdownPath = join(options.exportDir, STATEMENTS_MD_FILENAME);
    this.jsonPath = join(options.exportDir, STATEMENTS_JSON_FILENAME);
    this.walkPath = options.walkPath;
    this.filter = compileRedaction(options.policy);

    writeFileSync(this.markdownPath, MD_HEADER, "utf8");
    this.writeJson();

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

  /** The artifact as it stands. */
  get artifact(): StatementsArtifact {
    return {
      statements: this.statements.map((entry) => ({ ...entry })),
      citations: this.citations.map((citation) => ({ ...citation })),
      not_fully_read: this.notFullyRead,
    };
  }

  /**
   * Record one assistant message as statements.
   *
   * Called for a prose-only assistant message — the hand-back. Redaction runs
   * before anything is parsed, so no secret shape reaches the artifact even
   * inside a statement's own text.
   */
  recordAssistantMessage(text: string): StatementEntry[] {
    const redacted = this.filter.apply(text);
    const ranges = this.ranges();
    const added = splitStatements(redacted).map((statementText) =>
      this.buildStatement(statementText, parseEvidence(statementText), ranges),
    );
    return this.commit(added);
  }

  /**
   * Fold the `finish` hand-back in.
   *
   * `normalizeHandback` (lib/handback.ts) already derived each statement's
   * `status` from whether it carries evidence ids and stamped every citation
   * `unverifiable`; this method does not redo that work — it verifies the
   * citations against the walk, which is the one thing the normalizer
   * deliberately leaves to the harness-side verifier.
   *
   * The summary is split into statements only when the model passed no
   * explicit statements, so a model that did the work properly is not charged
   * twice for the same prose.
   */
  recordHandback(handback: Handback): StatementEntry[] {
    const ranges = this.ranges();
    const added: StatementEntry[] = [];

    for (const statement of handback.statements) {
      const text = this.filter.apply(statement.text);
      const evidence = statement.evidence.length
        ? statement.evidence
        : parseEvidence(text);
      added.push(this.buildStatement(text, evidence, ranges));
    }
    if (added.length === 0 && handback.summary) {
      const redacted = this.filter.apply(handback.summary);
      for (const text of splitStatements(redacted)) {
        added.push(this.buildStatement(text, parseEvidence(text), ranges));
      }
    }

    const committed = this.commit(added);
    // Citations the model listed on the payload rather than inline in prose.
    for (const citation of handback.citations) {
      this.addCitation(verifyCitation({ path: citation.path, line: citation.line }, ranges));
    }
    this.refreshTruncation();
    this.writeJson();
    return committed;
  }

  /** Append the citation table and the completeness line. Idempotent. */
  finalize(): StatementsArtifact {
    if (this.finalized) return this.artifact;
    this.finalized = true;
    this.refreshTruncation();
    this.writeJson();
    appendFileSync(this.markdownPath, renderFooter(this.artifact), "utf8");
    return this.artifact;
  }

  // -- internals ------------------------------------------------------------

  private ranges(): ReadRange[] {
    return readRangesFromWalk(readWalkEntries(this.walkPath));
  }

  private buildStatement(
    text: string,
    evidence: readonly string[],
    ranges: readonly ReadRange[],
  ): StatementEntry {
    const ids = evidence.filter((id) => /^w[1-9][0-9]*$/.test(id));
    return {
      text,
      evidence: [...ids],
      status: ids.length > 0 ? "referenced" : "unreferenced",
      citations: parseCitations(text).map((citation) => verifyCitation(citation, ranges)),
    };
  }

  /** Append statements to both files as they arrive — never buffered. */
  private commit(added: readonly StatementEntry[]): StatementEntry[] {
    if (added.length === 0) {
      this.refreshTruncation();
      this.writeJson();
      return [];
    }
    for (const entry of added) {
      this.statements.push(entry);
      for (const citation of entry.citations) this.addCitation(citation);
    }
    appendFileSync(
      this.markdownPath,
      `${added.map(renderStatementLine).join("\n")}\n`,
      "utf8",
    );
    this.refreshTruncation();
    this.writeJson();
    return [...added];
  }

  private addCitation(citation: StatementCitation): void {
    if (this.citations.some((seen) => seen.path === citation.path && seen.line === citation.line)) {
      return;
    }
    this.citations.push(citation);
  }

  /** `not_fully_read` comes from the walk's truncated flags, nowhere else. */
  private refreshTruncation(): void {
    this.notFullyRead = anyTruncated(readWalkEntries(this.walkPath));
  }

  private writeJson(): void {
    writeFileSync(this.jsonPath, `${JSON.stringify(this.artifact, null, 2)}\n`, "utf8");
  }
}

/**
 * Install the statements recorder on a pi instance.
 *
 * Additive only: every handler returns nothing, so none of them can block a
 * call, replace a message or change what the model sees.
 */
export function installStatementsRecorder(
  pi: {
    on(event: string, handler: (event: Record<string, unknown>) => unknown): void;
  },
  ctx: AssociateContext,
): StatementsRecorder {
  const recorder = new StatementsRecorder({
    exportDir: ctx.session.exportDir,
    walkPath: join(ctx.session.exportDir, WALK_FILENAME),
    policy: ctx.policy,
  });

  pi.on("message_end", (event) => {
    const message = (event as { message?: unknown }).message;
    if (!message || typeof message !== "object") return;
    if ((message as { role?: unknown }).role !== "assistant") return;
    // An assistant message that is still calling tools is a step, not a
    // hand-back; the final assistant message of a run carries prose only.
    if (messageHasToolCalls(message)) return;
    const text = assistantMessageText(message);
    if (text) recorder.recordAssistantMessage(text);
  });

  pi.on("tool_result", (event) => {
    if ((event as { toolName?: unknown }).toolName !== "finish") return;
    const details = (event as { details?: unknown }).details;
    const handback = (details as { handback?: unknown } | undefined)?.handback;
    if (handback && typeof handback === "object") {
      recorder.recordHandback(handback as Handback);
    }
  });

  pi.on("session_shutdown", () => {
    recorder.finalize();
  });

  return recorder;
}
