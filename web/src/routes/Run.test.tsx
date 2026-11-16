import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixtures from "../fixtures/runs.json";
import { REFRESH_MS } from "../hooks/usePolling";
import { deferred, envelope, setHidden, stubApi } from "../test/api";
import { renderApp } from "../test/render";

const NOW = new Date(fixtures.now);
const ids = fixtures.ids;
const show = fixtures.show as Record<string, Record<string, unknown>>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  setHidden(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function panel(name: string) {
  return screen.getByRole("region", { name });
}

async function openRun(id: string, routes = {}) {
  const api = stubApi(routes);
  renderApp(`/runs/${id}`);
  await screen.findByRole("heading", { level: 1 });
  return api;
}

describe("one finished run that was not merged", () => {
  it("has the pill, the timing and model, the title and the checkout with its base commit", async () => {
    await openRun(ids.testsfail);
    expect(screen.getByRole("link", { name: "All runs" })).toHaveAttribute("href", "/runs");
    const head = screen.getByTestId("run-head");
    expect(within(head).getByText("Not merged")).toBeInTheDocument();
    expect(
      within(head).getByText("Finished 3 days ago, took 9 minutes. Model: cortex."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Add a compliance guideline for secrets in logs" }),
    ).toBeInTheDocument();
    expect(within(head).getByText("/srv/checkouts/qodo-cli", { exact: false })).toBeInTheDocument();
    const commit = within(head).getByText("6f85313");
    expect(commit.tagName).toBe("CODE");
    expect(commit).toHaveAttribute("title", "6f85313c0ffee0000000000000000000000000ab");
    expect(document.title).toBe("Add a compliance guideline for secrets in logs - associate");
  });

  it("says why it was not merged in the API's own words, and where the work is kept", async () => {
    await openRun(ids.testsfail);
    const why = panel("Why it was not merged");
    expect(why).toHaveTextContent("Not ok because the tests did not pass; the merge is not_attempted.");
    expect(why).toHaveTextContent("tests failed: `markdownlint-cli2 REVIEW.md` (exit 1)");
    expect(within(why).getByText("associate-run/run-dddd")).toBeInTheDocument();
    expect(within(why).getByText("/srv/checkouts/.worktrees.qodo-cli/run-dddd")).toBeInTheDocument();
  });

  it("shows each test command with its own result and the count", async () => {
    await openRun(ids.testsfail);
    const tests = panel("Tests");
    expect(tests).toHaveTextContent("1 of 2 test commands failed");
    const rows = within(tests).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("qodo-cli config validate")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Passed")).toBeInTheDocument();
    expect(within(rows[1]).getByText("markdownlint-cli2 REVIEW.md")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Failed, exit 1")).toBeInTheDocument();
  });

  it("lists the changed paths, all shown", async () => {
    await openRun(ids.testsfail);
    const paths = panel("Changed paths");
    expect(within(paths).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      ".pr_agent.toml",
      "REVIEW.md",
    ]);
    expect(paths).toHaveTextContent("2 paths, all shown.");
  });

  it("shows the full instruction and what the agent said, as paragraphs", async () => {
    await openRun(ids.testsfail);
    expect(panel("Instruction")).toHaveTextContent(
      "Read the last ten merged pull requests' accepted and rejected suggestions.",
    );
    const said = panel("What the agent said");
    const paragraphs = within(said).getAllByText(/./, { selector: ".reply p" });
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[2]).toHaveTextContent("The configuration validates. I did not run the Markdown check.");
    expect(said).toHaveTextContent("They are not checked: the tests above are.");
  });
});

describe("other finished runs", () => {
  it("has no 'not merged' panel when the run merged", async () => {
    await openRun(ids.merged);
    expect(screen.getByTestId("run-head")).toHaveTextContent("Merged");
    expect(screen.queryByRole("region", { name: "Why it was not merged" })).not.toBeInTheDocument();
    expect(panel("Tests")).toHaveTextContent("The test command passed");
    expect(panel("Changed paths")).toHaveTextContent("1 path, shown.");
  });

  it("calls a clean run with nothing to merge No change, with no path changed", async () => {
    await openRun(ids.nochange);
    expect(screen.getByTestId("run-head")).toHaveTextContent("No change");
    expect(panel("Changed paths")).toHaveTextContent("No path changed.");
  });

  it("gives a refused merge its own reason", async () => {
    await openRun(ids.refused);
    const why = panel("Why it was not merged");
    expect(why).toHaveTextContent("Not ok because the merge is refused.");
    expect(why).toHaveTextContent("main is checked out at /srv/checkouts/qodo-cli with uncommitted changes");
  });

  it("notes truncated paths with the total", async () => {
    const run = {
      ...show[ids.merged],
      changed_paths: ["a.txt", "b.txt"],
      changed_paths_total: 5000,
      changed_paths_truncated: true,
    };
    await openRun(ids.merged, { [`GET /runs/${ids.merged}`]: { body: run } });
    expect(panel("Changed paths")).toHaveTextContent(
      "2 of 5000 paths shown; the rest are left out to keep the answer small.",
    );
  });

  it("says a changed-paths error, a missing or dropped reply and a cut instruction", async () => {
    const run = {
      ...show[ids.merged],
      changed_paths_error: "the merge commit for this run was not found on main",
      final_reply: null,
      final_reply_dropped: true,
      instruction_truncated: true,
    };
    await openRun(ids.merged, { [`GET /runs/${ids.merged}`]: { body: run } });
    expect(panel("Changed paths")).toHaveTextContent("the merge commit for this run was not found on main");
    expect(panel("What the agent said")).toHaveTextContent(
      "The reply was left out to keep the answer small.",
    );
    expect(panel("Instruction")).toHaveTextContent("The instruction is shortened here.");
  });

  it("says when the agent left no final reply", async () => {
    const run = { ...show[ids.merged], final_reply: null };
    await openRun(ids.merged, { [`GET /runs/${ids.merged}`]: { body: run } });
    expect(panel("What the agent said")).toHaveTextContent("The agent left no final reply.");
  });

  it("shows only the counts when the per-command results were left out", async () => {
    const run = {
      ...show[ids.testsfail],
      tests: { passed: false, commands: 2, failed: 1, error: null, results: null, results_truncated: true },
    };
    await openRun(ids.testsfail, { [`GET /runs/${ids.testsfail}`]: { body: run } });
    const tests = panel("Tests");
    expect(tests).toHaveTextContent("1 of 2 test commands failed");
    expect(within(tests).queryAllByRole("listitem")).toHaveLength(0);
    expect(tests).toHaveTextContent("Each command's result was left out to keep the answer small.");
  });

  it("says a run that exited with an error and its message", async () => {
    const run = {
      ...show[ids.testsfail],
      exit_code: 2,
      outcome: null,
      not_ok_because: "the run exited with 2; the outcome is None, not 'ok'",
      error: "pi is not on PATH",
      tests: { passed: null, commands: 0, failed: 0, error: null, results: [], results_truncated: false },
    };
    await openRun(ids.testsfail, { [`GET /runs/${ids.testsfail}`]: { body: run } });
    const why = panel("Why it was not merged");
    expect(why).toHaveTextContent("the run exited with 2");
    expect(why).toHaveTextContent("The run said: pi is not on PATH");
    expect(panel("Tests")).toHaveTextContent("No test result");
  });
});

describe("a running run", () => {
  it("says it is running, how many test commands follow, and that the result comes later", async () => {
    await openRun(ids.running);
    expect(screen.getByTestId("run-head")).toHaveTextContent("Running");
    expect(screen.getByTestId("run-head")).toHaveTextContent("Started 4 minutes ago. Model: cortex.");
    expect(panel("Tests")).toHaveTextContent("2 test commands run after the agent finishes.");
    expect(screen.getByText(/The result appears here when the run finishes/)).toBeInTheDocument();
    expect(panel("Instruction")).toHaveTextContent("Read docs/operations/green-pr-merge.md");
  });

  it("reads again while running, stops once finished, and pauses while hidden", async () => {
    vi.useRealTimers(); // re-installing over the Date-only clock would not fake the intervals
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    const finished = { ...show[ids.merged], run_id: ids.running };
    const api = stubApi({
      [`GET /runs/${ids.running}`]: (n) => ({ body: n < 3 ? show[ids.running] : finished }),
    });
    renderApp(`/runs/${ids.running}`);
    const tick = async (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    await tick(0);
    const key = `GET /runs/${ids.running}`;
    expect(api.calls(key)).toHaveLength(1);
    act(() => setHidden(true));
    await tick(REFRESH_MS * 2);
    expect(api.calls(key)).toHaveLength(1);
    act(() => setHidden(false));
    await tick(0);
    expect(api.calls(key)).toHaveLength(2);
    await tick(REFRESH_MS);
    expect(api.calls(key)).toHaveLength(3);
    expect(screen.getByTestId("run-head")).toHaveTextContent("Merged");
    await tick(REFRESH_MS * 3);
    expect(api.calls(key)).toHaveLength(3);
  });
});

describe("runs with no result", () => {
  it("shows a lost run with the API's explanation", async () => {
    await openRun(ids.lost);
    expect(screen.getByTestId("run-head")).toHaveTextContent("Lost");
    expect(screen.getByTestId("run-head")).toHaveTextContent("Started 5 days ago. Model: cortex.");
    expect(panel("Why there is no result")).toHaveTextContent(
      "the run is no longer running and left no result",
    );
    expect(screen.queryByRole("region", { name: "Tests" })).not.toBeInTheDocument();
    expect(panel("Instruction")).toBeInTheDocument();
  });

  it("shows a run that failed to start with its error", async () => {
    await openRun(ids.failed);
    expect(screen.getByTestId("run-head")).toHaveTextContent("Failed to start");
    expect(panel("Why there is no result")).toHaveTextContent(
      "the run could not be started: No such file or directory",
    );
  });
});

describe("the run page's states", () => {
  it("is loading until the answer arrives", async () => {
    const hold = deferred<{ body: unknown }>();
    stubApi({ [`GET /runs/${ids.merged}`]: () => hold.promise });
    renderApp(`/runs/${ids.merged}`);
    expect(screen.getByRole("status")).toHaveTextContent("Loading the run");
    await act(async () => hold.resolve({ body: show[ids.merged] }));
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
  });

  it("says no run has an unknown id", async () => {
    const unknown = "run-" + "0".repeat(32);
    stubApi({
      [`GET /runs/${unknown}`]: { status: 404, body: envelope("not_found", `no run ${unknown}`) },
    });
    renderApp(`/runs/${unknown}`);
    expect(await screen.findByRole("heading", { level: 1, name: "No such run" })).toBeInTheDocument();
    expect(screen.getByText(/no run run-0/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All runs" })).toBeInTheDocument();
  });

  it("does not ask the API about a malformed id", async () => {
    const api = stubApi();
    renderApp("/runs/not-a-run-id");
    expect(await screen.findByRole("heading", { level: 1, name: "No such run" })).toBeInTheDocument();
    expect(screen.getByText(/A run id is 'run-' followed by 32 lowercase hex digits/)).toBeInTheDocument();
    expect(api.seen.filter((s) => s.path.startsWith("/runs/"))).toEqual([]);
  });

  it("says a viewer role is needed", async () => {
    stubApi({ [`GET /runs/${ids.merged}`]: { status: 403, body: envelope("forbidden", "nope") } });
    renderApp(`/runs/${ids.merged}`);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Reading runs needs the viewer role, and this credential does not have it.",
    );
  });

  it("shows an error with a retry", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const api = stubApi({
      [`GET /runs/${ids.merged}`]: (n) =>
        n === 1 ? { status: 500, body: envelope("env", "the state cannot be read") } : { body: show[ids.merged] },
    });
    renderApp(`/runs/${ids.merged}`);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("the state cannot be read");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Raise inline comments");
    expect(api.calls(`GET /runs/${ids.merged}`)).toHaveLength(2);
  });

  it("goes back to all runs from the keyboard", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openRun(ids.merged);
    await user.tab(); // skip link
    await user.tab();
    expect(screen.getByRole("link", { name: "All runs" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { level: 1, name: "Runs" })).toBeInTheDocument();
  });

  it("titles a run with no instruction text by its id", async () => {
    const run = { ...show[ids.merged], instruction: null };
    await openRun(ids.merged, { [`GET /runs/${ids.merged}`]: { body: run } });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(`Run ${ids.merged}`);
  });
});
