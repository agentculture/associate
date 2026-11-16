// Cited from qodo-cli web/vitest.setup.ts @ ee73d5682a02952a76567887995b4f2e3aca5ea2, which cited (trimmed) culture-rules
// web/vitest.setup.ts @ b7f861f690b57c4355f81371cc02ad1dd2ae9cac (cite-don't-import).
// Adapted: only what this shell needs (jest-dom matchers, cleanup after each test, a default
// matchMedia answering "no preference"); React Flow's polyfills are not needed here.
import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// matchMedia is the reduced-motion signal's only source. Default every query to "no
// preference"; individual tests override it.
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

afterEach(() => {
  cleanup();
});
