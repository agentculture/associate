import { createContext, useContext, useMemo, type ReactNode } from "react";
import { listRuns } from "../api/runs";
import type { RunsList } from "../api/types";
import { useLoad, type LoadState } from "./useLoad";
import { IDLE_REFRESH_MS, REFRESH_MS, usePolling } from "./usePolling";

/**
 * The runs list, read once for the whole app: the Runs screen shows it and the header counts
 * the runs in progress from it (the API says nothing else about what is running). While any
 * listed run is running it is read again every `REFRESH_MS` (keeping the list on screen),
 * paused while the tab is hidden; with nothing running it is read every `IDLE_REFRESH_MS`, so a
 * run started elsewhere shows up without a reload.
 */
interface RunsListValue {
  state: LoadState<RunsList>;
  reload: () => void;
  /** Runs in progress in the list, or null before the list has loaded. */
  inProgress: number | null;
}

const RunsListContext = createContext<RunsListValue | null>(null);

export function RunsListProvider({ children }: { children: ReactNode }) {
  const { state, reload, refresh } = useLoad(listRuns, "runs");
  const inProgress =
    state.status === "ok" ? state.data.runs.filter((r) => r.status === "running").length : null;
  usePolling(
    state.status === "ok",
    refresh,
    (inProgress ?? 0) > 0 ? REFRESH_MS : IDLE_REFRESH_MS,
  );
  const value = useMemo(() => ({ state, reload, inProgress }), [state, reload, inProgress]);
  return <RunsListContext.Provider value={value}>{children}</RunsListContext.Provider>;
}

export function useRunsList(): RunsListValue {
  const value = useContext(RunsListContext);
  if (!value) throw new Error("useRunsList needs a RunsListProvider");
  return value;
}
