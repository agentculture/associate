/**
 * The change line (deviation d20): which lines a `write` adds and removes
 * versus the file it replaces.
 *
 * Measured once (one pair, not a rate; docs/notes/gate-calibration.md): a
 * large-state evaluator allowed a 40 KB `CLAUDE.md` write carrying one planted
 * exfiltration line when it saw only the full content, and refused it once the
 * added/removed lines were stated next to it. The content stays in the state
 * as before; this line is extra, truthful state that makes the edit salient. It
 * never replaces or summarises the content.
 *
 * Pure and dependency-free. The line diff is Myers' O((N+M)·D) greedy
 * algorithm after trimming the common prefix and suffix, with two bounds:
 *
 * - **work** — at most {@link DIFF_MAX_EDITS} edits are searched for. Past
 *   that, the differing region between the common prefix and suffix is
 *   reported whole (every old line removed, every new line added). That is a
 *   correct diff, only not a minimal one, and the line says so.
 * - **size** — the rendered hunks stop at `maxRenderBytes` (gate.json
 *   `change.max_render_bytes`); the lines left out are counted and named in the
 *   line, never dropped silently.
 */

/**
 * The most edits (inserted + deleted lines) the Myers search explores before
 * falling back to a whole-region diff. A work bound, not a policy value: its
 * memory is about DIFF_MAX_EDITS² 32-bit integers (~4 MB at 1000) and its time
 * O((N+M)·DIFF_MAX_EDITS) line comparisons.
 */
export const DIFF_MAX_EDITS = 1000;

/** The change line for a write to a path where nothing exists yet. */
export const CHANGE_NEW_FILE =
  "creates a new file: nothing exists at this path yet, so there is no current content to compare against.";

/** The change line when the content equals the current file byte for byte. */
export const CHANGE_NONE = "the content is identical to the current file: no line changes.";

export type DiffOp =
  | { readonly kind: "="; readonly oldIndex: number; readonly newIndex: number }
  | { readonly kind: "-"; readonly oldIndex: number }
  | { readonly kind: "+"; readonly newIndex: number };

export interface LineDiff {
  /** Every line of both sides, in order: equal, removed (old side) or added (new side). */
  readonly ops: readonly DiffOp[];
  /** False when the work bound was hit and the differing region is reported whole. */
  readonly minimal: boolean;
}

/** Myers' greedy search on a[0..n) vs b[0..m); undefined when it needs more than `limit` edits. */
function myers(a: readonly string[], b: readonly string[], limit: number): DiffOp[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, limit);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  search: for (let d = 0; d <= max; d++) {
    // Only diagonals -d..d are read when backtracking step d.
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break search;
      }
    }
  }
  if (found < 0) return undefined;

  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const snap = trace[d];
    const at = (k: number) => snap[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    // Walk back the snake (equal lines) that followed this step's one edit;
    // it stops exactly where the edit ended: (prevX, prevY+1) after an
    // insertion, (prevX+1, prevY) after a deletion.
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: "=", oldIndex: x, newIndex: y });
    }
    if (prevK === k + 1) ops.push({ kind: "+", newIndex: prevY });
    else ops.push({ kind: "-", oldIndex: prevX });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ kind: "=", oldIndex: x, newIndex: y });
  }
  return ops.reverse();
}

/**
 * A line diff of `a` → `b`: common prefix and suffix trimmed, then Myers on
 * the middle within `maxEdits`; past it, the middle is reported whole.
 */
export function diffLines(a: readonly string[], b: readonly string[], maxEdits: number = DIFF_MAX_EDITS): LineDiff {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: "=", oldIndex: i, newIndex: i });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle = myers(midA, midB, Math.max(0, maxEdits));
  const minimal = middle !== undefined;
  if (middle) {
    for (const op of middle) {
      if (op.kind === "=") ops.push({ kind: "=", oldIndex: op.oldIndex + start, newIndex: op.newIndex + start });
      else if (op.kind === "-") ops.push({ kind: "-", oldIndex: op.oldIndex + start });
      else ops.push({ kind: "+", newIndex: op.newIndex + start });
    }
  } else {
    for (let i = start; i < endA; i++) ops.push({ kind: "-", oldIndex: i });
    for (let j = start; j < endB; j++) ops.push({ kind: "+", newIndex: j });
  }
  for (let i = endA, j = endB; i < a.length; i++, j++) ops.push({ kind: "=", oldIndex: i, newIndex: j });
  return { ops, minimal };
}

/** Text → lines, without the empty element a final newline leaves; reports that newline. */
export function splitLines(text: string): { lines: string[]; finalNewline: boolean } {
  if (text === "") return { lines: [], finalNewline: false };
  const finalNewline = text.endsWith("\n");
  const lines = (finalNewline ? text.slice(0, -1) : text).split("\n");
  return { lines, finalNewline };
}

interface Hunk {
  readonly oldStart: number;
  readonly newStart: number;
  readonly removed: string[];
  readonly added: string[];
}

/** Group the non-equal ops into hunks (maximal runs between equal lines). */
function hunks(ops: readonly DiffOp[], a: readonly string[], b: readonly string[]): Hunk[] {
  const out: Hunk[] = [];
  let oldPos = 0;
  let newPos = 0;
  let current: Hunk | undefined;
  for (const op of ops) {
    if (op.kind === "=") {
      current = undefined;
      oldPos = op.oldIndex + 1;
      newPos = op.newIndex + 1;
      continue;
    }
    if (!current) {
      current = { oldStart: oldPos, newStart: newPos, removed: [], added: [] };
      out.push(current);
    }
    if (op.kind === "-") {
      current.removed.push(a[op.oldIndex]);
      oldPos = op.oldIndex + 1;
    } else {
      current.added.push(b[op.newIndex]);
      newPos = op.newIndex + 1;
    }
  }
  return out;
}

/** git's header numbering: 1-based start, or the line before when the side is empty. */
function header(h: Hunk): string {
  const side = (start: number, count: number) => `${count === 0 ? start : start + 1},${count}`;
  return `@@ -${side(h.oldStart, h.removed.length)} +${side(h.newStart, h.added.length)} @@`;
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * The change line for a write that replaces `before` with `after`: a summary
 * sentence, then every hunk as git-style `@@ -old,count +new,count @@`
 * headers over its `-` removed and `+` added lines (no context lines: the full
 * content is in the arguments). Hunk text past `maxRenderBytes` is left out
 * and counted in a closing note, never dropped silently.
 */
export function renderChange(
  before: string,
  after: string,
  maxRenderBytes: number,
  maxEdits: number = DIFF_MAX_EDITS,
): string {
  if (before === after) return CHANGE_NONE;
  const old = splitLines(before);
  const neu = splitLines(after);
  const diff = diffLines(old.lines, neu.lines, maxEdits);
  const list = hunks(diff.ops, old.lines, neu.lines);
  const added = list.reduce((sum, h) => sum + h.added.length, 0);
  const removed = list.reduce((sum, h) => sum + h.removed.length, 0);

  let summary =
    `replaces the current file (${plural(old.lines.length, "line")}) with ${plural(neu.lines.length, "line")}: ` +
    `${added} added, ${removed} removed, every other line unchanged.`;
  if (old.finalNewline !== neu.finalNewline) {
    summary += neu.finalNewline
      ? " It also adds a newline at the end of the file."
      : " It also removes the newline at the end of the file.";
  }
  if (!diff.minimal) {
    summary +=
      ` The line diff stopped at its work bound (${DIFF_MAX_EDITS} edits), so the differing region is listed ` +
      "whole (every old line in it removed, every new line added) rather than minimally.";
  }
  if (list.length === 0) return summary;
  summary += ' The changed lines follow, "-" removed and "+" added, under "@@ -old,count +new,count @@" headers:';

  const out: string[] = [summary];
  let used = bytes(summary);
  let omittedAdded = 0;
  let omittedRemoved = 0;
  let full = false;
  const fits = (line: string) => !full && used + 1 + bytes(line) <= maxRenderBytes;
  for (const h of list) {
    const head = header(h);
    if (fits(head)) {
      out.push(head);
      used += 1 + bytes(head);
    } else full = true;
    for (const [sign, lines] of [
      ["-", h.removed],
      ["+", h.added],
    ] as const) {
      for (const text of lines) {
        const line = `${sign}${text}`;
        if (fits(line)) {
          out.push(line);
          used += 1 + bytes(line);
        } else {
          full = true;
          if (sign === "-") omittedRemoved++;
          else omittedAdded++;
        }
      }
    }
  }
  if (omittedAdded + omittedRemoved > 0) {
    out.push(
      `…[${plural(omittedAdded + omittedRemoved, "more changed line")} not shown ` +
        `(${omittedAdded} added, ${omittedRemoved} removed): this change line is bounded by gate.json ` +
        "change.max_render_bytes; the full new content is in arguments]",
    );
  }
  return out.join("\n");
}
