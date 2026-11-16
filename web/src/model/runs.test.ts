import { describe, expect, it } from "vitest";
import fixtures from "../fixtures/runs.json";
import type { RunCard } from "../api/types";
import {
  ago,
  firstLine,
  needsLook,
  outcomeItems,
  pathsNote,
  pillFor,
  repoName,
  testResultWords,
  testsSummary,
  timing,
  took,
} from "./runs";

const NOW = new Date(fixtures.now);
const cards = fixtures.list.runs as RunCard[];
const card = (key: keyof typeof fixtures.ids) =>
  cards.find((c) => c.run_id === fixtures.ids[key]) as RunCard;

describe("the status pill, from the API's status, ok and merge", () => {
  it("is Running while the run runs", () => {
    expect(pillFor({ status: "running", ok: false, merge: null })).toEqual({
      label: "Running",
      tone: "running",
    });
  });

  it("is Merged for an ok run that merged", () => {
    expect(pillFor({ status: "finished", ok: true, merge: "merged" }).label).toBe("Merged");
  });

  it("is No change for an ok run with nothing to merge", () => {
    expect(pillFor({ status: "finished", ok: true, merge: "nothing_to_merge" })).toEqual({
      label: "No change",
      tone: "neutral",
    });
  });

  it("is Not merged for a finished run that is not ok, whatever the reason", () => {
    for (const merge of ["refused", "not_attempted", "merged", null]) {
      expect(pillFor({ status: "finished", ok: false, merge }).label).toBe("Not merged");
    }
  });

  it("is Lost for a lost run", () => {
    expect(pillFor({ status: "lost", ok: false, merge: null })).toEqual({ label: "Lost", tone: "bad" });
  });

  it("is Failed to start for a run that never started", () => {
    expect(pillFor({ status: "failed-to-start", ok: false, merge: null }).label).toBe(
      "Failed to start",
    );
  });

  it("says an unknown status in its own words rather than guessing", () => {
    expect(pillFor({ status: "paused", ok: false, merge: null })).toEqual({
      label: "Status: paused",
      tone: "bad",
    });
  });

  it("maps every fixture card", () => {
    expect(cards.map((c) => pillFor(c).label)).toEqual([
      "Running",
      "Merged",
      "No change",
      "Not merged",
      "Not merged",
      "Lost",
      "Failed to start",
    ]);
  });

  it("puts not merged, lost and failed-to-start runs under Needs a look", () => {
    expect(cards.filter(needsLook).map((c) => pillFor(c).label)).toEqual([
      "Not merged",
      "Not merged",
      "Lost",
      "Failed to start",
    ]);
  });
});

describe("the outcome line of a card", () => {
  it("tells failing tests from a refused merge", () => {
    expect(outcomeItems(card("testsfail"))).toEqual([
      { text: "1 of 2 test commands failed", warn: true },
      { text: "No merge attempted", warn: false },
    ]);
    expect(outcomeItems(card("refused"))).toEqual([
      { text: "Tests passed", warn: false },
      { text: "Merge refused", warn: true },
    ]);
  });

  it("says what merged, and that nothing needed merging", () => {
    expect(outcomeItems(card("merged"))).toEqual([
      { text: "Tests passed", warn: false },
      { text: "1 file changed", warn: false },
    ]);
    expect(outcomeItems(card("nochange"))).toEqual([
      { text: "Tests passed", warn: false },
      { text: "Nothing to merge", warn: false },
    ]);
  });

  it("names a running run's test commands and a lost or unstarted run's trouble", () => {
    expect(outcomeItems(card("running"))).toEqual([{ text: "2 test commands", warn: false }]);
    expect(outcomeItems(card("lost"))).toEqual([
      { text: "The run stopped without a result", warn: true },
    ]);
    expect(outcomeItems(card("failed"))).toEqual([
      { text: "The run could not be started", warn: true },
    ]);
  });

  it("says a non-zero exit and a missing test result", () => {
    const run = { ...card("testsfail"), exit_code: 2, outcome: "error", tests: null };
    expect(outcomeItems(run)).toEqual([
      { text: "No test result", warn: true },
      { text: "Exited with code 2", warn: true },
    ]);
    const killed = { ...run, exit_code: null };
    expect(outcomeItems(killed)[1]).toEqual({ text: "Ended by a signal", warn: true });
  });

  it("says tests that did not pass with no failing command", () => {
    const run = { ...card("testsfail"), tests: { passed: false, commands: 0, failed: 0 } };
    expect(outcomeItems(run)[0]).toEqual({ text: "The tests did not pass", warn: true });
  });
});

describe("words", () => {
  it("names the checkout by its last path segment", () => {
    expect(repoName("/srv/checkouts/culture-rules")).toBe("culture-rules");
    expect(repoName("/srv/checkouts/culture-rules/")).toBe("culture-rules");
    expect(repoName(null)).toBe("unknown checkout");
  });

  it("says how long ago, in words", () => {
    const at = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
    expect(ago(at(0.2), NOW)).toBe("just now");
    expect(ago(at(1), NOW)).toBe("1 minute ago");
    expect(ago(at(4), NOW)).toBe("4 minutes ago");
    expect(ago(at(60), NOW)).toBe("1 hour ago");
    expect(ago(at(60 * 5), NOW)).toBe("5 hours ago");
    expect(ago(at(60 * 26), NOW)).toBe("yesterday");
    expect(ago(at(60 * 24 * 3), NOW)).toBe("3 days ago");
    expect(ago("2026-09-01T10:00:00+00:00", NOW)).toBe("on 2026-09-01");
    expect(ago("not a date", NOW)).toBeNull();
    expect(ago(null, NOW)).toBeNull();
  });

  it("says how long a run took", () => {
    expect(took("2026-11-16T10:00:00+00:00", "2026-11-16T10:00:20+00:00")).toBe(
      "took under a minute",
    );
    expect(took("2026-11-16T10:00:00+00:00", "2026-11-16T10:01:00+00:00")).toBe("took 1 minute");
    expect(took("2026-11-16T10:00:00+00:00", "2026-11-16T10:09:00+00:00")).toBe("took 9 minutes");
    expect(took("2026-11-16T10:00:00+00:00", "2026-11-16T11:05:00+00:00")).toBe(
      "took 1 hour 5 minutes",
    );
    expect(took("2026-11-16T10:00:00+00:00", null)).toBeNull();
    expect(took("2026-11-16T10:00:00+00:00", "2026-11-16T09:00:00+00:00")).toBeNull();
  });

  it("gives a card's timing line", () => {
    expect(timing(card("running"), NOW)).toBe("Started 4 minutes ago");
    expect(timing(card("merged"), NOW)).toBe("Finished yesterday, took 6 minutes");
    expect(timing(card("testsfail"), NOW)).toBe("Finished 3 days ago, took 9 minutes");
    expect(timing(card("lost"), NOW)).toBe("Started 5 days ago");
    expect(timing(card("failed"), NOW)).toBe("Tried to start 6 days ago");
    expect(timing({ ...card("lost"), started_at: null }, NOW)).toBe("Start time unknown");
  });

  it("takes the first non-empty line of an instruction", () => {
    expect(firstLine("\n\n  Add a guideline  \nmore")).toBe("Add a guideline");
    expect(firstLine("   \n ")).toBeNull();
    expect(firstLine(null)).toBeNull();
  });

  it("summarises the tests from the counts the API gives", () => {
    expect(testsSummary({ passed: true, commands: 2, failed: 0 })).toBe("All 2 test commands passed");
    expect(testsSummary({ passed: true, commands: 1, failed: 0 })).toBe("The test command passed");
    expect(testsSummary({ passed: false, commands: 2, failed: 1 })).toBe("1 of 2 test commands failed");
    expect(testsSummary({ passed: false, commands: 0, failed: 0 })).toBe("The tests did not pass");
    expect(testsSummary({ passed: null, commands: 0, failed: 0 })).toBe("No test result");
    expect(testsSummary(null)).toBe("No test result");
  });

  it("words each test command's result, never by colour alone", () => {
    expect(testResultWords({ command: "x", exit_code: 0, timed_out: false })).toEqual({
      text: "Passed",
      ok: true,
    });
    expect(testResultWords({ command: "x", exit_code: 1, timed_out: false })).toEqual({
      text: "Failed, exit 1",
      ok: false,
    });
    expect(testResultWords({ command: "x", exit_code: null, timed_out: true }).text).toBe(
      "Timed out",
    );
    expect(testResultWords({ command: "x", exit_code: null, timed_out: false }).text).toBe(
      "Did not start",
    );
  });

  it("says whether every changed path is shown", () => {
    expect(pathsNote(2, 2, false)).toBe("2 paths, all shown.");
    expect(pathsNote(1, 1, false)).toBe("1 path, shown.");
    expect(pathsNote(0, 0, false)).toBe("No path changed.");
    expect(pathsNote(5000, 200, true)).toBe(
      "200 of 5000 paths shown; the rest are left out to keep the answer small.",
    );
    expect(pathsNote(3, 3, true)).toBe("3 paths shown; some long paths are shortened.");
  });
});
