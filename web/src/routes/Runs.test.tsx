import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixtures from "../fixtures/runs.json";
import { REFRESH_MS } from "../hooks/usePolling";
import { deferred, envelope, setHidden, stubApi } from "../test/api";
import { renderApp } from "../test/render";

const NOW = new Date(fixtures.now);
const ids = fixtures.ids;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  setHidden(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function loaded() {
  await screen.findByRole("list", { name: "Runs" });
}

function cardOf(id: string) {
  const link = screen
    .getAllByRole("link")
    .find((a) => a.getAttribute("href") === `/runs/${id}`) as HTMLElement;
  expect(link, id).toBeDefined();
  return link;
}

describe("the runs list", () => {
  it("has the heading, the explanation and one card per run, each a link to its run", async () => {
    stubApi();
    renderApp("/runs");
    expect(screen.getByRole("heading", { level: 1, name: "Runs" })).toBeInTheDocument();
    expect(screen.getByText(/merges into the checkout's local main only when/)).toBeInTheDocument();
    await loaded();
    const items = within(screen.getByRole("list", { name: "Runs" })).getAllByRole("listitem");
    expect(items).toHaveLength(7);
    for (const id of Object.values(ids)) cardOf(id);
    expect(document.title).toBe("Runs - associate");
  });

  it("shows each card's pill, timing, model, title, repo and outcome", async () => {
    stubApi();
    renderApp("/runs");
    await loaded();
    const failing = cardOf(ids.testsfail);
    expect(within(failing).getByText("Not merged")).toBeInTheDocument();
    expect(within(failing).getByText("Finished 3 days ago, took 9 minutes")).toBeInTheDocument();
    expect(within(failing).getByText("Model: cortex")).toBeInTheDocument();
    expect(
      within(failing).getByRole("heading", {
        level: 2,
        name: "Add a compliance guideline for secrets in logs",
      }),
    ).toBeInTheDocument();
    expect(within(failing).getByText("qodo-cli")).toBeInTheDocument();
    expect(within(failing).getByText("1 of 2 test commands failed")).toBeInTheDocument();

    const running = cardOf(ids.running);
    expect(within(running).getByText("Running")).toBeInTheDocument();
    expect(within(running).getByText("Started 4 minutes ago")).toBeInTheDocument();
    expect(within(running).getByText("2 test commands")).toBeInTheDocument();

    expect(within(cardOf(ids.merged)).getByText("Merged")).toBeInTheDocument();
    expect(within(cardOf(ids.merged)).getByText("1 file changed")).toBeInTheDocument();
    expect(within(cardOf(ids.nochange)).getByText("No change")).toBeInTheDocument();
    expect(within(cardOf(ids.refused)).getByText("Merge refused")).toBeInTheDocument();
    expect(within(cardOf(ids.lost)).getByText("Lost")).toBeInTheDocument();
    expect(within(cardOf(ids.failed)).getByText("Failed to start")).toBeInTheDocument();
  });

  it("names each card link by its title and describes it by its status", async () => {
    stubApi();
    renderApp("/runs");
    await loaded();
    const link = screen.getByRole("link", { name: "Raise inline comments from medium severity" });
    expect(link).toHaveAccessibleDescription(/Merged/);
  });

  it("reads the list with the largest page the API allows", async () => {
    const api = stubApi();
    renderApp("/runs");
    await loaded();
    expect(api.calls("GET /runs")[0].search).toBe("limit=100");
  });

  it("filters to the runs in progress and to the runs that need a look", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    stubApi();
    renderApp("/runs");
    await loaded();
    const group = screen.getByRole("group", { name: "Show" });
    const all = within(group).getByRole("button", { name: "All" });
    const inProgress = within(group).getByRole("button", { name: "In progress" });
    const needsLook = within(group).getByRole("button", { name: "Needs a look" });
    expect(all).toHaveAttribute("aria-pressed", "true");

    await user.click(inProgress);
    expect(inProgress).toHaveAttribute("aria-pressed", "true");
    expect(all).toHaveAttribute("aria-pressed", "false");
    let items = within(screen.getByRole("list", { name: "Runs" })).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(within(items[0]).getByText("Running")).toBeInTheDocument();

    await user.click(needsLook);
    items = within(screen.getByRole("list", { name: "Runs" })).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector(".pill")?.textContent)).toEqual([
      "Not merged",
      "Not merged",
      "Lost",
      "Failed to start",
    ]);
    await user.click(all);
    expect(within(screen.getByRole("list", { name: "Runs" })).getAllByRole("listitem")).toHaveLength(7);
  });

  it("says so when a filter matches nothing", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const done = fixtures.list.runs.filter((r) => r.status !== "running");
    stubApi({ "GET /runs": { body: { runs: done, total: done.length } } });
    renderApp("/runs");
    await loaded();
    await user.click(screen.getByRole("button", { name: "In progress" }));
    expect(screen.getByText("No run is in progress.")).toBeInTheDocument();
  });

  it("is operated from the keyboard: the filter, then the cards", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    stubApi();
    renderApp("/runs");
    await loaded();
    await user.tab(); // skip link
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "All" })).toHaveFocus();
    await user.tab();
    const inProgress = screen.getByRole("button", { name: "In progress" });
    expect(inProgress).toHaveFocus();
    await user.keyboard(" ");
    expect(inProgress).toHaveAttribute("aria-pressed", "true");
    await user.tab();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Needs a look" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.tab();
    expect(cardOf(ids.testsfail)).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Add a compliance guideline for secrets in logs",
      }),
    ).toBeInTheDocument();
  });

  it("says the page only shows runs and never offers to start one", async () => {
    stubApi();
    renderApp("/runs");
    await loaded();
    expect(screen.getByText(/Runs are started by a workflow or from the command line/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /start|new run/i })).not.toBeInTheDocument();
  });

  it("notes when the list was cut to stay small", async () => {
    stubApi({ "GET /runs": { body: { ...fixtures.list, total: 140, truncated: true } } });
    renderApp("/runs");
    await loaded();
    expect(screen.getByText("Showing 7 of 140 runs, the most recent first.")).toBeInTheDocument();
  });
});

describe("the list's states", () => {
  it("is loading until the answer arrives", async () => {
    const hold = deferred<{ body: unknown }>();
    stubApi({ "GET /runs": () => hold.promise });
    renderApp("/runs");
    expect(screen.getByRole("status")).toHaveTextContent("Loading runs");
    await act(async () => hold.resolve({ body: fixtures.list }));
    await loaded();
    expect(screen.queryByText("Loading runs…")).not.toBeInTheDocument();
  });

  it("is empty with no runs, saying how one is started", async () => {
    stubApi({ "GET /runs": { body: { runs: [], total: 0 } } });
    renderApp("/runs");
    expect(await screen.findByRole("heading", { name: "No runs yet" })).toBeInTheDocument();
    expect(screen.getByText(/associate runs start/)).toBeInTheDocument();
    expect(screen.getByText(/POST \/runs/)).toBeInTheDocument();
  });

  it("shows the API's message and a retry that reads again", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const api = stubApi({
      "GET /runs": (n) =>
        n === 1
          ? { status: 500, body: envelope("env", "the runs state directory cannot be read") }
          : { body: fixtures.list },
    });
    renderApp("/runs");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("the runs state directory cannot be read");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    await loaded();
    expect(api.calls("GET /runs")).toHaveLength(2);
  });

  it("says a viewer role is needed when the credential has none", async () => {
    stubApi({ "GET /runs": { status: 403, body: envelope("forbidden", "x needs viewer") } });
    renderApp("/runs");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Reading runs needs the viewer role, and this credential does not have it.",
    );
  });

  it("says the credential was not accepted", async () => {
    stubApi({ "GET /runs": { status: 401, body: envelope("no_credentials", "this route needs authentication") } });
    renderApp("/runs");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The API did not accept the credential: this route needs authentication",
    );
  });
});

describe("the list's refresh", () => {
  beforeEach(() => {
    vi.useRealTimers(); // re-installing over the Date-only clock would not fake the intervals
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
  });

  async function tick(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("reads again on an interval while a run is running, and stops when none is", async () => {
    const done = fixtures.list.runs.map((r) =>
      r.status === "running" ? { ...r, status: "finished", ok: true, merge: "merged" } : r,
    );
    const api = stubApi({
      "GET /runs": (n) => ({ body: n < 3 ? fixtures.list : { runs: done, total: done.length } }),
    });
    renderApp("/runs");
    await tick(0);
    expect(api.calls("GET /runs")).toHaveLength(1);
    await tick(REFRESH_MS);
    expect(api.calls("GET /runs")).toHaveLength(2);
    expect(screen.getByText("1 run in progress")).toBeInTheDocument();
    await tick(REFRESH_MS);
    expect(api.calls("GET /runs")).toHaveLength(3);
    expect(screen.getByText("No run in progress")).toBeInTheDocument();
    await tick(REFRESH_MS * 4);
    expect(api.calls("GET /runs")).toHaveLength(3); // nothing running: no more reads
  });

  it("never refreshes a list with nothing running", async () => {
    const done = fixtures.list.runs.filter((r) => r.status !== "running");
    const api = stubApi({ "GET /runs": { body: { runs: done, total: done.length } } });
    renderApp("/runs");
    await tick(REFRESH_MS * 5);
    expect(api.calls("GET /runs")).toHaveLength(1);
  });

  it("pauses while the tab is hidden and reads at once when it is shown again", async () => {
    const api = stubApi();
    renderApp("/runs");
    await tick(0);
    act(() => setHidden(true));
    await tick(REFRESH_MS * 3);
    expect(api.calls("GET /runs")).toHaveLength(1);
    act(() => setHidden(false));
    await tick(0);
    expect(api.calls("GET /runs")).toHaveLength(2);
    await tick(REFRESH_MS);
    expect(api.calls("GET /runs")).toHaveLength(3);
  });

  it("keeps the list on screen while a refresh is in flight", async () => {
    const hold = deferred<{ body: unknown }>();
    stubApi({ "GET /runs": (n) => (n === 1 ? { body: fixtures.list } : hold.promise) });
    renderApp("/runs");
    await tick(0);
    await tick(REFRESH_MS);
    expect(screen.getByRole("list", { name: "Runs" })).toBeInTheDocument();
    expect(screen.queryByText("Loading runs…")).not.toBeInTheDocument();
    await act(async () => hold.resolve({ body: fixtures.list }));
  });
});

describe("the header", () => {
  it("has the brand and the count of runs in progress from the list, and no avatar", async () => {
    stubApi();
    renderApp("/runs");
    const banner = screen.getByRole("banner");
    expect(within(banner).getByText("associate")).toBeInTheDocument();
    await waitFor(() => expect(within(banner).getByText("1 run in progress")).toBeInTheDocument());
    expect(within(banner).queryByRole("img")).not.toBeInTheDocument();
  });

  it("counts several runs in progress", async () => {
    const two = [fixtures.list.runs[0], { ...fixtures.list.runs[0], run_id: "run-" + "9".repeat(32) }];
    stubApi({ "GET /runs": { body: { runs: two, total: 2 } } });
    renderApp("/runs");
    expect(await screen.findByText("2 runs in progress")).toBeInTheDocument();
  });
});
