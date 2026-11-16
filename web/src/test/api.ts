// A stub of the associate runs API for component tests: routes `fetch` by method and path,
// records every request and answers from a table the test fills. A route the table does not
// name fails the test loudly instead of hanging.
//
// Cited from qodo-cli web/src/test/api.ts @ ee73d5682a02952a76567887995b4f2e3aca5ea2
// (cite-don't-import: this repo owns its copy). Adapted: associate's flat error envelope; the
// list and one-run answers come from the shared fixtures; no request body (the UI only reads).
import { vi } from "vitest";
import fixtures from "../fixtures/runs.json";

export interface Seen {
  method: string;
  path: string;
  search: string;
}

/** One answer: a JSON body with a status, or a function of the call count. */
export interface AnswerBody {
  status?: number;
  body: unknown;
}
export type Answer = AnswerBody | ((n: number) => AnswerBody | Promise<AnswerBody>);

export function envelope(code: string, message: string, remediation?: string) {
  return { code, message, ...(remediation ? { remediation } : {}) };
}

/** The default table: the fixture list, and every fixture run by id. */
export function fixtureRoutes(): Record<string, Answer> {
  const table: Record<string, Answer> = { "GET /runs": { body: fixtures.list } };
  for (const [id, run] of Object.entries(fixtures.show)) {
    table[`GET /runs/${id}`] = { body: run };
  }
  return table;
}

/** `routes["GET /runs"] = {body: ...}`; unnamed routes fall back to the fixtures. */
export function stubApi(routes: Record<string, Answer> = {}) {
  const seen: Seen[] = [];
  const counts: Record<string, number> = {};
  const table: Record<string, Answer> = { ...fixtureRoutes(), ...routes };
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const [rawPath, search = ""] = String(url).replace(/^\/api/, "").split("?");
    const path = decodeURIComponent(rawPath);
    seen.push({ method, path, search });
    const key = `${method} ${path}`;
    counts[key] = (counts[key] ?? 0) + 1;
    const answer = table[key];
    if (!answer) throw new Error(`unexpected request ${key}`);
    const out = typeof answer === "function" ? await answer(counts[key]) : answer;
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    seen,
    table,
    fetchMock,
    /** The requests to one route, in order. */
    calls: (key: string) => seen.filter((s) => `${s.method} ${s.path}` === key),
  };
}

/** A promise the test resolves by hand, to hold a request open. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Pretend the tab is hidden (or visible again) and tell the page. */
export function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  document.dispatchEvent(new Event("visibilitychange"));
}
