import { afterEach, describe, expect, it, vi } from "vitest";
import routes from "./routes.json";
import { ApiError, REQUEST_TIMEOUT_MS, ROUTES, getJson, pathOf, query, request } from "./client";
import { listRuns, showRun } from "./runs";

function reply(status: number, body: unknown, statusText = ""): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, statusText });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the error envelope", () => {
  it("becomes a typed ApiError from associate's flat {code, message, remediation}", async () => {
    const envelope = {
      code: "not_found",
      message: "no run run-0",
      remediation: "list runs with `associate runs list`",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(404, envelope)));
    const error = await getJson("/runs/run-0").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const api = error as ApiError;
    expect([api.status, api.code, api.message]).toEqual([404, "not_found", "no run run-0"]);
    expect(api.remediation).toBe("list runs with `associate runs list`");
  });

  it("reads the static layer's nested {error: {code, message}} as well", async () => {
    const nested = { error: { code: "not_found", message: "no such API route", errors: [] } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(404, nested)));
    const api = (await getJson("/nope").catch((e: unknown) => e)) as ApiError;
    expect([api.code, api.message]).toEqual(["not_found", "no such API route"]);
    expect(api.remediation).toBeUndefined();
  });

  it("reads the auth envelope and a framework detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(reply(401, { code: "no_credentials", message: "needs auth" })),
    );
    const unauth = (await getJson("/runs").catch((e: unknown) => e)) as ApiError;
    expect([unauth.status, unauth.code, unauth.message]).toEqual([401, "no_credentials", "needs auth"]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(405, { detail: "Method Not Allowed" })));
    const detail = (await getJson("/runs").catch((e: unknown) => e)) as ApiError;
    expect([detail.code, detail.message]).toEqual(["http_error", "Method Not Allowed"]);
  });

  it("falls back to http_error with the status line when the body is no envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(reply(502, "<html>bad gateway</html>", "Bad Gateway")),
    );
    const api = (await request("GET", "/health").catch((e: unknown) => e)) as ApiError;
    expect([api.status, api.code, api.message]).toEqual([502, "http_error", "502 Bad Gateway"]);
  });

  it("reports an unreachable API and a cancelled call with their own codes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));
    const down = (await request("GET", "/health").catch((e: unknown) => e)) as ApiError;
    expect([down.status, down.code]).toEqual([0, "unreachable"]);

    const ctl = new AbortController();
    ctl.abort();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("x", "AbortError")));
    const gone = (await request("GET", "/health", ctl.signal).catch((e: unknown) => e)) as ApiError;
    expect(gone.code).toBe("aborted");
  });

  it("gives up with code timeout when nothing answers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("x", "AbortError")));
          }),
      ),
    );
    const pending = request("GET", "/health").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    expect(((await pending) as ApiError).code).toBe("timeout");
  });

  it("treats a 2xx answer that is not JSON as not_json", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(200, "<html></html>")));
    const api = (await getJson("/health").catch((e: unknown) => e)) as ApiError;
    expect(api.code).toBe("not_json");
  });
});

describe("requests", () => {
  it("go to the same-origin /api prefix, as GET, and send no credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { runs: [], total: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    await listRuns();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/runs?limit=100");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ accept: "application/json" });
    expect(init.credentials).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it("fill the run id into the show route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { run_id: "run-1" }));
    vi.stubGlobal("fetch", fetchMock);
    await showRun("run-" + "a".repeat(32));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/runs/run-" + "a".repeat(32));
  });

  it("build every route from the one route table the server test checks", () => {
    expect(ROUTES).toBe(routes);
    expect(pathOf("show", { run_id: "run-x y" })).toBe("/runs/run-x%20y");
    expect(pathOf("list")).toBe("/runs");
    expect(Object.values(ROUTES).every((r) => r.method === "GET")).toBe(true);
  });

  it("build a query string from the defined params only", () => {
    expect(query({ limit: 5, nope: undefined })).toBe("?limit=5");
    expect(query({})).toBe("");
  });
});
