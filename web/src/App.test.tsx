import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixtures from "./fixtures/runs.json";
import { setHidden, stubApi } from "./test/api";
import { renderApp } from "./test/render";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(fixtures.now));
  setHidden(false);
  stubApi();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the routes", () => {
  it.each(["/", "/nowhere", "/runs/"])("sends %s to the runs list", async (path) => {
    renderApp(path);
    expect(await screen.findByRole("heading", { level: 1, name: "Runs" })).toBeInTheDocument();
  });

  it("opens one run at /runs/<id>", async () => {
    renderApp(`/runs/${fixtures.ids.merged}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Raise inline comments from medium severity" }),
    ).toBeInTheDocument();
  });

  it("has a skip link to the main region and one banner", async () => {
    renderApp("/runs");
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    await screen.findByRole("list", { name: "Runs" });
  });
});
