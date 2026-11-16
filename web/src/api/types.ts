/**
 * The runs API's replies, field for field (associate/runs/service.py: `list_runs`, `show`).
 * `tests/test_web_contract.py` checks that the fixtures carry exactly these fields, so a field
 * renamed on the server fails there. Nothing here is invented: a value the API may omit or
 * null is typed so.
 */

/** `run.status`: what the run is doing. Anything else is shown in its own words. */
export type RunStatus = "running" | "finished" | "failed-to-start" | "lost";

/** `run.merge`, once finished. */
export type MergeWord = "merged" | "nothing_to_merge" | "refused" | "not_attempted";

export interface TestCounts {
  passed: boolean | null;
  commands: number;
  failed: number;
}

/** One run in `GET /runs` (`list_runs`): what a card shows. */
export interface RunCard {
  run_id: string;
  status: string;
  ok: boolean;
  model: string | null;
  started_at: string | null;
  finished_at: string | null;
  checkout: string | null;
  /** The instruction's first non-empty line, cut. */
  title: string | null;
  merge: string | null;
  outcome: string | null;
  exit_code: number | null;
  tests: TestCounts | null;
  changed_paths_total: number | null;
  test_command_count: number;
}

export interface RunsList {
  runs: RunCard[];
  total: number;
  /** Set when runs were left out to keep the reply under 64 KiB. */
  truncated?: boolean;
}

/** One test command's result: its command line and how it ended, never its output. */
export interface TestResult {
  command: string;
  exit_code: number | null;
  timed_out: boolean;
}

export interface TestsDetail extends TestCounts {
  error: string | null;
  /** Null when left out to keep the reply small. */
  results: TestResult[] | null;
  results_truncated: boolean;
}

/** `GET /runs/{run_id}` (`show`). The finished fields are absent while it runs. */
export interface RunDetail {
  run_id: string;
  status: string;
  ok: boolean;
  checkout: string | null;
  model: string | null;
  started_at: string | null;
  base_commit: string | null;
  pushed: boolean;
  instruction: string | null;
  instruction_truncated: boolean;
  test_command_count: number;
  finished_at?: string | null;
  exit_code?: number | null;
  signal?: number | null;
  not_ok_because?: string | null;
  outcome?: string | null;
  merge?: string | null;
  merge_reason?: string | null;
  worktree?: string | null;
  run_branch?: string | null;
  tests?: TestsDetail | null;
  changed_paths?: string[];
  changed_paths_total?: number;
  changed_paths_truncated?: boolean;
  changed_paths_error?: string | null;
  final_reply?: string | null;
  final_reply_dropped?: boolean;
  details_dropped?: boolean;
  error?: string | null;
}
