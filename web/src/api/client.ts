import routeTable from "./routes.json";

/**
 * Cited from qodo-cli web/src/api/client.ts @ ee73d5682a02952a76567887995b4f2e3aca5ea2
 * (which cited culture-rules web/src/api/client.ts @ b7f861f690b57c4355f81371cc02ad1dd2ae9cac;
 * cite-don't-import: this repo owns its copy). Adapted: the UI only reads, so there is no
 * request body and no verb POST; the routes come from `routes.json`, which
 * `tests/test_web_contract.py` binds to `associate.runs.service.VERBS` (this app has no pinned
 * OpenAPI file); the error envelope is associate's flat `{code, message, remediation}`, and the
 * static layer's nested `{error: {...}}` and a framework `{detail}` are read too.
 *
 * Same-origin API prefix. In dev, vite.config.ts proxies `/api` to `associate serve`
 * (ASSOCIATE_API_URL, default http://127.0.0.1:8794) with the prefix stripped; in production
 * `associate serve` strips it itself and serves this bundle. Never an absolute remote URL.
 *
 * No request from this client attaches a credential: behind Cloudflare Access on the
 * loopback listener the browser carries the Access cookie on every same-origin request.
 */
export const API_ROOT = "/api";

/** How long one API call may take before it fails with code `timeout`. */
export const REQUEST_TIMEOUT_MS = 15_000;

export type Method = "GET";

export interface Route {
  method: Method;
  path: string;
  /** The `associate.runs.service.VERBS` name this route serves, or null (health). */
  verb: string | null;
}

/** Every route the UI calls, by name; the one table the server-side contract test reads. */
export const ROUTES = routeTable as Record<keyof typeof routeTable, Route>;

/** A route's path with its `{params}` filled in (each one URL-encoded). */
export function pathOf(name: keyof typeof routeTable, params: Record<string, string> = {}): string {
  return ROUTES[name].path.replace(/\{(\w+)\}/g, (_m, key: string) =>
    encodeURIComponent(params[key] ?? ""),
  );
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** The envelope's `remediation`, when it carried one. */
  readonly remediation?: string;

  constructor(status: number, code: string, message: string, remediation?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.remediation = remediation;
  }
}

interface Envelope {
  code?: unknown;
  message?: unknown;
  remediation?: unknown;
  detail?: unknown;
  error?: { code?: unknown; message?: unknown; remediation?: unknown };
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

function errorFrom(response: Response, parsed: unknown): ApiError {
  const body = (parsed && typeof parsed === "object" ? parsed : {}) as Envelope;
  const inner = body.error && typeof body.error === "object" ? body.error : {};
  const code = text(body.code) ?? text(inner.code) ?? "http_error";
  const message =
    text(body.message) ??
    text(inner.message) ??
    text(body.detail) ??
    `${response.status} ${response.statusText}`.trim();
  return new ApiError(
    response.status,
    code,
    message,
    text(body.remediation) ?? text(inner.remediation),
  );
}

/**
 * One call to the API: JSON out, the error envelope turned into an `ApiError`.
 * Answers the parsed body, which may be `null` for an empty answer.
 */
export async function request<T>(method: Method, path: string, signal?: AbortSignal): Promise<T> {
  // A request that never answers must still settle, or a view waits on it forever: give up
  // after REQUEST_TIMEOUT_MS. The caller's own signal keeps working.
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, REQUEST_TIMEOUT_MS);
  const forward = () => ctl.abort();
  signal?.addEventListener("abort", forward);
  if (signal?.aborted) ctl.abort();
  let response: Response;
  let body: string;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      method,
      signal: ctl.signal,
      headers: { accept: "application/json" },
    });
    body = await response.text();
  } catch {
    if (timedOut) {
      throw new ApiError(0, "timeout", `the associate API did not answer ${method} ${path}`);
    }
    if (signal?.aborted) {
      throw new ApiError(0, "aborted", `${method} ${path} was cancelled`);
    }
    throw new ApiError(0, "unreachable", `cannot reach the associate API at ${API_ROOT}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
  let parsed: unknown = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) throw errorFrom(response, parsed);
  return parsed as T;
}

/** `GET path`; a 2xx answer that is not JSON is an `ApiError` (`not_json`). */
export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const parsed = await request<T | null>("GET", path, signal);
  if (parsed === null) {
    throw new ApiError(200, "not_json", `${path} did not return JSON`);
  }
  return parsed;
}

/** A query string from the defined params (`?a=1&b=2`, or "" when none). */
export function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const q = search.toString();
  return q ? `?${q}` : "";
}
