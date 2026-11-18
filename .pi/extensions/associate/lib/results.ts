/**
 * Saved results: the full text of every tool result, one file per walk id
 * (issue #20, plan t6; spec c8/h6).
 *
 * The walk entry is the record of an action; this module keeps what the
 * action returned, so a fact can later be checked against the text its entry
 * points at without re-running anything. The layout under the session export
 * directory is fixed and derived from the walk id alone:
 *
 *     <export>/results/w<N>.txt
 *
 * What is saved is the text the walk recorder received for the call **after
 * the contract's redaction filter** — the same redacted text the walk has
 * always stored inline. No unredacted byte is written here. The recorder is
 * the only writer: this module is called from `lib/walk.ts` when a result
 * arrives, never from a tool and never from model text.
 *
 * Each file holds at most `caps.max_raw_chars` characters (the contract's cap,
 * passed in by the recorder; 0 means no cap). Above the cap the file holds the
 * first `max_raw_chars` characters and the caller marks the entry `partial`.
 *
 * Reading back takes a walk id, validated by pattern before any path is
 * built, so a name supplied by a model can never become a path (spec scope
 * boundary: "neither the matcher nor the check tool opens a path supplied by
 * the model").
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The directory, inside the session export directory, that holds saved results. */
export const RESULTS_DIRNAME = "results";

/** A walk id as `walk.schema.json` defines it (`$defs/entry/properties/id`). */
const WALK_ID = /^w[1-9][0-9]*$/;

/** What saving one result produced. */
export interface SavedResult {
  /** The file's name relative to the export directory, e.g. `results/w3.txt`. */
  name: string;
  /** Characters written to the file. */
  savedChars: number;
  /** Characters of the (redacted) result text before any cut. */
  totalChars: number;
  /** True when the file holds less than the whole text (the cap was exceeded). */
  partial: boolean;
}

function checkWalkId(walkId: string): void {
  if (typeof walkId !== "string" || !WALK_ID.test(walkId)) {
    throw new Error(`not a walk id: ${JSON.stringify(walkId)} (expected w1, w2, …)`);
  }
}

/** The saved-result name for `walkId`, relative to the export directory. */
export function savedResultName(walkId: string): string {
  checkWalkId(walkId);
  return `${RESULTS_DIRNAME}/${walkId}.txt`;
}

/**
 * Cut `text` to at most `cap` UTF-16 code units without splitting a surrogate
 * pair. `cap <= 0` means no cap.
 */
function cutAt(text: string, cap: number): string {
  if (cap <= 0 || text.length <= cap) return text;
  let end = cap;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * Save one result's (already redacted) text under `exportDir`.
 *
 * Throws when the file cannot be written; the recorder then records the entry
 * without a saved result and marks it partial rather than losing the entry.
 */
export function saveResult(exportDir: string, walkId: string, text: string, maxChars: number): SavedResult {
  const name = savedResultName(walkId);
  const saved = cutAt(text, maxChars);
  mkdirSync(join(exportDir, RESULTS_DIRNAME), { recursive: true });
  writeFileSync(join(exportDir, name), saved, "utf8");
  return { name, savedChars: saved.length, totalChars: text.length, partial: saved.length < text.length };
}

/**
 * Read the saved result of `walkId` from `exportDir`, or `undefined` when that
 * entry saved nothing. Throws, before touching the filesystem, when `walkId`
 * is not a walk id.
 */
export function loadSavedResult(exportDir: string, walkId: string): string | undefined {
  const path = join(exportDir, savedResultName(walkId));
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}
