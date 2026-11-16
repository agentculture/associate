import type { RunCard, TestCounts, TestResult } from "../api/types";

/**
 * The words the two screens say about a run, from the API's own fields only. Status is always
 * a word (the pill's label); its tone only adds colour.
 */

export type Tone = "running" | "good" | "neutral" | "bad";
export interface Pill {
  label: string;
  tone: Tone;
}

/** The pill: Running, Merged, No change, Not merged, Lost or Failed to start. */
export function pillFor(run: { status: string; ok: boolean; merge?: string | null }): Pill {
  switch (run.status) {
    case "running":
      return { label: "Running", tone: "running" };
    case "lost":
      return { label: "Lost", tone: "bad" };
    case "failed-to-start":
      return { label: "Failed to start", tone: "bad" };
    case "finished":
      // `ok` is the API's verdict (exit 0, outcome ok, tests passed, merged or nothing to
      // merge); the merge word only says which of the two ok shapes it is
      if (run.ok && run.merge === "merged") return { label: "Merged", tone: "good" };
      if (run.ok && run.merge === "nothing_to_merge") return { label: "No change", tone: "neutral" };
      return { label: "Not merged", tone: "bad" };
    default:
      return { label: `Status: ${run.status}`, tone: "bad" };
  }
}

/** Runs the operator should look at: not merged, lost, failed to start (or unknown). */
export function needsLook(run: { status: string; ok: boolean; merge?: string | null }): boolean {
  return pillFor(run).tone === "bad";
}

export interface OutcomeItem {
  text: string;
  /** Said with weight as well as colour: something went wrong. */
  warn: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The test counts in words (the same sentence on a card and on the run page). */
export function testsSummary(tests: TestCounts | null | undefined): string {
  if (!tests || tests.passed === null || tests.passed === undefined) return "No test result";
  if (tests.passed) {
    return tests.commands === 1
      ? "The test command passed"
      : `All ${plural(tests.commands, "test command")} passed`;
  }
  if (tests.failed > 0) return `${tests.failed} of ${plural(tests.commands, "test command")} failed`;
  return "The tests did not pass";
}

/** A card's outcome line, after the repo: tests and merge, or what went wrong. */
export function outcomeItems(run: RunCard): OutcomeItem[] {
  if (run.status === "running") {
    return [{ text: plural(run.test_command_count, "test command"), warn: false }];
  }
  if (run.status === "lost") return [{ text: "The run stopped without a result", warn: true }];
  if (run.status === "failed-to-start") return [{ text: "The run could not be started", warn: true }];
  if (run.status !== "finished") return [];
  const tests = run.tests;
  const items: OutcomeItem[] = [
    {
      text: tests?.passed === true ? "Tests passed" : testsSummary(tests),
      warn: tests?.passed !== true,
    },
  ];
  if (run.exit_code !== 0) {
    items.push({
      text: run.exit_code === null ? "Ended by a signal" : `Exited with code ${run.exit_code}`,
      warn: true,
    });
  } else if (run.merge === "merged") {
    items.push({ text: plural(run.changed_paths_total ?? 0, "file") + " changed", warn: false });
  } else if (run.merge === "nothing_to_merge") {
    items.push({ text: "Nothing to merge", warn: false });
  } else if (run.merge === "refused") {
    items.push({ text: "Merge refused", warn: true });
  } else {
    items.push({ text: "No merge attempted", warn: false });
  }
  return items;
}

/** The checkout's last path segment: the API has a path, not an `owner/name`. */
export function repoName(checkout: string | null | undefined): string {
  const parts = (checkout ?? "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "unknown checkout";
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function parse(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

/** How long ago, in words ("4 minutes ago", "yesterday", "on 2026-09-01"); null if unknown. */
export function ago(iso: string | null | undefined, now: Date): string | null {
  const at = parse(iso);
  if (at === null) return null;
  const diff = Math.max(0, now.getTime() - at);
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${plural(Math.floor(diff / MINUTE), "minute")} ago`;
  if (diff < DAY) return `${plural(Math.floor(diff / HOUR), "hour")} ago`;
  const days = Math.floor(diff / DAY);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return `on ${new Date(at).toISOString().slice(0, 10)}`;
}

/** "took 9 minutes", from the two timestamps the API gives; null when either is missing. */
export function took(start: string | null | undefined, end: string | null | undefined): string | null {
  const a = parse(start);
  const b = parse(end);
  if (a === null || b === null || b < a) return null;
  const minutes = Math.round((b - a) / MINUTE);
  if (minutes < 1) return "took under a minute";
  if (minutes < 60) return `took ${plural(minutes, "minute")}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `took ${plural(hours, "hour")}${rest ? ` ${plural(rest, "minute")}` : ""}`;
}

/** A run's timing: "Started 4 minutes ago", "Finished yesterday, took 6 minutes". */
export function timing(
  run: { status: string; started_at: string | null; finished_at?: string | null },
  now: Date,
): string {
  const started = ago(run.started_at, now);
  if (run.status === "finished") {
    const finished = ago(run.finished_at, now);
    const length = took(run.started_at, run.finished_at);
    if (finished) return `Finished ${finished}${length ? `, ${length}` : ""}`;
  }
  if (!started) return "Start time unknown";
  if (run.status === "failed-to-start") return `Tried to start ${started}`;
  return `Started ${started}`;
}

/** The first non-empty line of an instruction, trimmed; null when there is none. */
export function firstLine(text: string | null | undefined): string | null {
  for (const line of (text ?? "").split(/\r?\n/)) {
    if (line.trim()) return line.trim();
  }
  return null;
}

/** One test command's result in words. */
export function testResultWords(result: TestResult): { text: string; ok: boolean } {
  if (result.exit_code === 0) return { text: "Passed", ok: true };
  if (result.timed_out) return { text: "Timed out", ok: false };
  if (result.exit_code === null) return { text: "Did not start", ok: false };
  return { text: `Failed, exit ${result.exit_code}`, ok: false };
}

/** Whether every changed path is shown (from `changed_paths_total` and the truncation flag). */
export function pathsNote(total: number, shown: number, truncated: boolean): string {
  if (total === 0 && shown === 0) return "No path changed.";
  if (!truncated) return shown === 1 ? "1 path, shown." : `${shown} paths, all shown.`;
  if (shown < total) {
    return `${shown} of ${total} paths shown; the rest are left out to keep the answer small.`;
  }
  return `${plural(shown, "path")} shown; some long paths are shortened.`;
}
