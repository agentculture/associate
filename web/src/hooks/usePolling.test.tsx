import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setHidden } from "../test/api";
import { REFRESH_MS, usePolling } from "./usePolling";

beforeEach(() => {
  vi.useFakeTimers();
  setHidden(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("usePolling", () => {
  it("ticks on the interval only while active", () => {
    const tick = vi.fn();
    const { rerender } = renderHook(({ active }) => usePolling(active, tick), {
      initialProps: { active: true },
    });
    act(() => vi.advanceTimersByTime(REFRESH_MS * 2));
    expect(tick).toHaveBeenCalledTimes(2);
    rerender({ active: false });
    act(() => vi.advanceTimersByTime(REFRESH_MS * 3));
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("pauses while hidden and ticks at once when shown again", () => {
    const tick = vi.fn();
    renderHook(() => usePolling(true, tick));
    act(() => setHidden(true));
    act(() => vi.advanceTimersByTime(REFRESH_MS * 3));
    expect(tick).not.toHaveBeenCalled();
    act(() => setHidden(false));
    expect(tick).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(REFRESH_MS));
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("does not tick on showing the tab when inactive", () => {
    const tick = vi.fn();
    renderHook(() => usePolling(false, tick));
    act(() => setHidden(true));
    act(() => setHidden(false));
    expect(tick).not.toHaveBeenCalled();
  });

  it("is a modest interval", () => {
    expect(REFRESH_MS).toBeGreaterThanOrEqual(3000);
    expect(REFRESH_MS).toBeLessThanOrEqual(15000);
  });
});
