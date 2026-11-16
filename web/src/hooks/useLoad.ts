import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";

/**
 * Cited from qodo-cli web/src/hooks/useLoad.ts @ ee73d5682a02952a76567887995b4f2e3aca5ea2
 * (cite-don't-import: this repo owns its copy). Adapted: none beyond this header.
 */

/** One read's state: every state is its own value, so no view mistakes one for another. */
export type LoadState<T> =
  | { status: "loading" }
  | { status: "ok"; data: T }
  | { status: "error"; error: ApiError };

/** Any failure as an `ApiError` (the client already throws one for every API failure). */
export function asApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return new ApiError(0, "unexpected", err instanceof Error ? err.message : String(err));
}

/**
 * Run `load` now and again whenever `key` changes; `reload()` runs it again (showing loading),
 * `refresh()` runs it again keeping the current data on screen until the answer arrives. A
 * superseded or unmounted run never sets state.
 */
export function useLoad<T>(
  load: (signal: AbortSignal) => Promise<T>,
  key: string,
): { state: LoadState<T>; reload: () => void; refresh: () => void } {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });
  const [run, setRun] = useState({ n: 0, quiet: false });
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const ctl = new AbortController();
    if (!run.quiet) setState({ status: "loading" });
    loadRef
      .current(ctl.signal)
      .then((data) => {
        if (!ctl.signal.aborted) setState({ status: "ok", data });
      })
      .catch((err: unknown) => {
        if (!ctl.signal.aborted) setState({ status: "error", error: asApiError(err) });
      });
    return () => ctl.abort();
  }, [key, run]);

  const reload = useCallback(() => setRun((r) => ({ n: r.n + 1, quiet: false })), []);
  const refresh = useCallback(() => setRun((r) => ({ n: r.n + 1, quiet: true })), []);
  return { state, reload, refresh };
}
