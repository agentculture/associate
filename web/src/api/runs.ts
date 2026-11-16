import { getJson, pathOf, query } from "./client";
import type { RunDetail, RunsList } from "./types";

/** The largest page `runs list` allows (`associate.runs.service.LIST_LIMIT`). */
export const LIST_LIMIT = 100;

/** A run id: `run-` and 32 lowercase hex digits (`associate.runs.state.RUN_ID`). */
export const RUN_ID = /^run-[0-9a-f]{32}$/;

/** `GET /runs?limit=100`: the most recent runs, newest first. */
export const listRuns = (signal?: AbortSignal): Promise<RunsList> =>
  getJson<RunsList>(pathOf("list") + query({ limit: LIST_LIMIT }), signal);

/** `GET /runs/{run_id}`: one run's status and, once finished, its result. */
export const showRun = (runId: string, signal?: AbortSignal): Promise<RunDetail> =>
  getJson<RunDetail>(pathOf("show", { run_id: runId }), signal);
