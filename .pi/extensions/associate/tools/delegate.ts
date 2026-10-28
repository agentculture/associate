/**
 * `delegate_run` / `delegate_status` — the read-only resident hands a task
 * that writes to a separate `associate run` (deviation d18, design D, option O3).
 *
 * The mesh resident (`spark-associate`) is one long-lived pi session in the
 * registered checkout, running `senses`, which may not change anything. A task
 * that needs a change is not done in that session: `delegate_run` starts
 * `associate run --model <target> --checkout <this checkout> --json`, which
 * already gives a writing run its own git worktree, runs the operator's test
 * commands after the model (d12) and merges into the local `main` only when
 * the run is clean and every command passed (t15). `delegate_status` reads
 * that run's result. The rules:
 *
 *   * **Who may delegate to whom is the contract's.** The active model's
 *     `models.json` `may_delegate` (senses: `worker`) is the whole allowlist;
 *     no model name is written in this file. `lib/contract.ts`
 *     `delegationProblems` re-checks the registry at load (a target must be a
 *     writing model that does not delegate); while any problem stands every
 *     delegation is refused.
 *   * **It never blocks the turn.** culture's ACP turn timeout is 600 s and a
 *     live worker run has taken ~25 minutes, so `delegate_run` starts the run
 *     DETACHED (its own process group, stdio to files) and returns a run id at
 *     once; `delegate_status` is a separate, read-only call.
 *   * **The in-tree CLI, never the PATH binary.** The PATH `associate` may be
 *     an older release (0.9.0 has no `--test-command`). The run is
 *     `<python> -m associate run …` with the working directory and
 *     `PYTHONPATH` set to the associate tree that holds THIS extension
 *     (`lib/paths.ts` `associateRoot`), so `associate` is imported from that
 *     tree; `<python>` is that tree's `.venv/bin/python` when present, else
 *     `python3` from absolute PATH entries. No `uv` is run, so the tree's
 *     `uv.lock` is never touched. `ASSOCIATE_EXTENSION_PATH` is set to this
 *     extension's `index.ts`, so the delegated pi loads this same build.
 *   * **The operator's test commands, exactly.** Every command in the
 *     snapshotted `ASSOCIATE_TEST_COMMANDS` is passed as one `--test-command`
 *     (quoted so `shlex.split` returns the same argv); the model can add or
 *     change none. With none configured, or a malformed value, delegation is
 *     refused: the hand-off's safety rests on that check.
 *   * **Never more trusting than this session.** `--untrusted-checkout` unless
 *     `ASSOCIATE_PI_TRUST` is exactly `approve` (`lib/trust.ts`).
 *   * **One delegated run per checkout at a time.** A second start while one
 *     runs is refused, naming the running run id.
 *   * **Everything lands in this session's own directory.** The run's export
 *     root is `<session root>/delegated`, its session id is the run id, so its
 *     walk is `<session root>/delegated/<run id>/export/walk.jsonl`; its stdout
 *     (the `--json` result), stderr and a small record (`delegate.json`) sit
 *     beside that, never in the checkout.
 *   * **Linked in the walk before it starts.** A `{"child": …}` line naming
 *     the delegated walk is appended first; when it cannot be written nothing
 *     is launched (the `spawn_subagent` rule).
 *
 * **Why `delegate_run` is gated but not mutating.** The session calling it
 * changes nothing itself, so it is not in `mutating_tools` (which would refuse
 * it for senses before the gate); it is in `gated_tools`, so CLEF scores it
 * for every model against `gate.json`'s `effects.delegate_run` and the
 * read-only fallback refuses it when CLEF and Super are both unreachable. The
 * delegated run's own changes are gated again, call by call, inside that run.
 *
 * Limits named here, not in the contract: the task length (one argv string)
 * and the stderr tail kept for an error. The run's timeout and the result
 * budget are the contract's (`policy.budgets.delegate`).
 *
 * Node builtins only; no npm dependency. Never a shell.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AssociateContext } from "../lib/context.ts";
import { delegationProblems } from "../lib/contract.ts";
import { associateRoot as defaultAssociateRoot, extensionDir } from "../lib/paths.ts";
import { isCheckoutTrusted } from "../lib/trust.ts";
import { resolveActiveModel } from "../lib/toolset.ts";
import {
  compileRedaction,
  redactValue,
  WALK_FILENAME,
  type ChildEntry,
  type ChildLink,
  type RedactionFilter,
} from "../lib/walk.ts";
import { toolError, toolResult, whichOnPath } from "./_procs.ts";
import { parseTestCommands, TEST_COMMANDS_ENV } from "./tests.ts";

/** The registered names; `models.json` `tool_names` lists both. */
export const DELEGATE_RUN_TOOL = "delegate_run";
export const DELEGATE_STATUS_TOOL = "delegate_status";

/** Under this session's root: one directory per delegated run. */
export const DELEGATED_DIR = "delegated";

/** In a run's directory: the child's stdout (the `associate run --json` result). */
export const RESULT_FILE = "result.json";
/** In a run's directory: the child's stderr (diagnostics, or a `--json` error object). */
export const STDERR_FILE = "stderr.log";
/** In a run's directory: what this tool knows about the run. */
export const RECORD_FILE = "delegate.json";

/** A run id: `dlg-<UTC stamp>-<8 hex>`. Also the delegated run's session id. */
export const RUN_ID_PATTERN = /^dlg-\d{8}T\d{6}Z-[0-9a-f]{8}$/;

/** Linux's MAX_ARG_STRLEN (128 KiB) bounds one argv string; the task travels as one. */
const MAX_TASK_CHARS = 100_000;

/** Chars of a failed run's stderr kept for the error (its end is where the reason is). */
const STDERR_TAIL_CHARS = 4_000;

/**
 * Parent variables the delegated run must not inherit. `associate run` sets
 * or clears most of these itself; removing them here as well means no stale
 * value — another session's checkout root, walk or ACP id — can leak in.
 * `ASSOCIATE_CHECKOUT_ROOT` matters most: `associate run` does not reset it,
 * and inherited it would point the delegated pi at THIS checkout instead of
 * its worktree. The Python variables would let the interpreter load
 * something other than the tree's package.
 */
const NOT_INHERITED = [
  "ASSOCIATE_CHECKOUT_ROOT",
  "ASSOCIATE_CONTINUE_FROM",
  "ASSOCIATE_SESSION_ID",
  "ASSOCIATE_EXPORT_ROOT",
  "ASSOCIATE_MODEL",
  "ASSOCIATE_ISOLATION",
  "ASSOCIATE_RUN_DEADLINE",
  "ASSOCIATE_TEST_COMMANDS",
  "ASSOCIATE_INJECT_PROMPT",
  "ASSOCIATE_PI_TRUST",
  "ASSOCIATE_CONTRACT_DIR",
  "ASSOCIATE_EXTENSION_PATH",
  "PI_ACP_SESSION_ID",
  "ACP_SESSION_ID",
  "PYTHONPATH",
  "PYTHONSAFEPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONUSERBASE",
] as const;

type Env = Record<string, string | undefined>;
type Result = { content: Array<{ type: "text"; text: string }>; details: unknown };

// ---------------------------------------------------------------------------
// Launching, detached
// ---------------------------------------------------------------------------

export interface DetachedSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** The child's stdout goes here (created or truncated). */
  stdoutPath: string;
  /** The child's stderr goes here (created or truncated). */
  stderrPath: string;
}

export interface DetachedExit {
  /** Null when the process did not exit on its own (killed by a signal, or never started). */
  exitCode: number | null;
  signal: string | null;
  /** Why the process could not be started, when it could not. */
  error?: string;
}

export interface DetachedRun {
  pid?: number;
  /** Resolves once, when the process is gone. Never rejects. */
  exited: Promise<DetachedExit>;
}

/** Start one process that outlives the call; return at once. */
export type DetachedLauncher = (spec: DetachedSpec) => DetachedRun;

/**
 * The real launcher: argv only (`shell: false`), its own process group,
 * stdout/stderr straight to files (no pipe the parent must drain), unref'd so
 * a headless parent can exit while the run continues.
 */
export const defaultDetachedLauncher: DetachedLauncher = (spec) => {
  const out = openSync(spec.stdoutPath, "w", 0o600);
  let err: number | undefined;
  try {
    err = openSync(spec.stderrPath, "w", 0o600);
    const child = nodeSpawn(spec.file, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      stdio: ["ignore", out, err],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const exited = new Promise<DetachedExit>((resolveExit) => {
      let settled = false;
      const settle = (value: DetachedExit) => {
        if (settled) return;
        settled = true;
        resolveExit(value);
      };
      child.on("error", (error) => settle({ exitCode: null, signal: null, error: error.message }));
      child.on("exit", (code, signal) => settle({ exitCode: code, signal: signal ?? null }));
    });
    child.unref();
    return { pid: child.pid, exited };
  } finally {
    closeSync(out);
    if (err !== undefined) closeSync(err);
  }
};

/** Whether a pid is still a live process (signal 0 probes without sending). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

// ---------------------------------------------------------------------------
// The in-tree CLI
// ---------------------------------------------------------------------------

export interface CliInvocation {
  /** The interpreter: the tree's `.venv/bin/python`, else `python3` from PATH. */
  file: string;
  /** Always `["-m", "associate"]`. */
  prefix: string[];
  /** The associate tree itself, so `-m associate` imports from it. */
  cwd: string;
  /** The tree, as `PYTHONPATH`. */
  pythonPath: string;
}

/**
 * How to run the `associate` CLI of the tree that holds this extension —
 * never the `associate` on PATH. Returns a problem when the tree carries no
 * Python package (an extension installed without its package) or no
 * interpreter is found.
 */
export function inTreeCli(
  root: string,
  env: Env,
  which: (name: string, env: Env) => string | null = whichOnPath,
): CliInvocation | { problem: string } {
  if (!existsSync(join(root, "associate", "__main__.py"))) {
    return {
      problem:
        `the associate tree holding this extension (${root}) has no associate/__main__.py, ` +
        "so its own CLI cannot be run; the associate on PATH is never used in its place",
    };
  }
  const venvPython = join(root, ".venv", "bin", "python");
  let file: string | null = null;
  try {
    if (statSync(venvPython).isFile()) file = venvPython;
  } catch {
    file = null;
  }
  file ??= which("python3", env);
  if (!file) {
    return {
      problem: `no Python interpreter: ${venvPython} does not exist and python3 is not on PATH (absolute entries only)`,
    };
  }
  return { file, prefix: ["-m", "associate"], cwd: root, pythonPath: root };
}

/** One argv token quoted so Python's `shlex.split` returns exactly it. */
export function shellQuote(token: string): string {
  return `'${token.replace(/'/g, `'"'"'`)}'`;
}

export interface RunArgumentsInput {
  model: string;
  task: string;
  checkout: string;
  exportRoot: string;
  sessionId: string;
  timeoutSeconds: number;
  untrusted: boolean;
  testCommands: readonly (readonly string[])[];
}

/** The argv after `<python> -m associate`. The task follows `--`, so it never parses as a flag. */
export function runArguments(input: RunArgumentsInput): string[] {
  const args = [
    "run",
    "--json",
    "--model",
    input.model,
    "--checkout",
    input.checkout,
    "--export-root",
    input.exportRoot,
    "--session-id",
    input.sessionId,
    "--timeout",
    String(input.timeoutSeconds),
  ];
  if (input.untrusted) args.push("--untrusted-checkout");
  for (const command of input.testCommands) args.push("--test-command", command.map(shellQuote).join(" "));
  args.push("--", input.task);
  return args;
}

/** The delegated run's environment: this session's snapshot minus {@link NOT_INHERITED}, plus the tree. */
export function delegateEnvironment(env: Env, cli: CliInvocation): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if ((NOT_INHERITED as readonly string[]).includes(key)) continue;
    out[key] = value;
  }
  out.PYTHONPATH = cli.pythonPath;
  out.ASSOCIATE_EXTENSION_PATH = join(extensionDir, "index.ts");
  return out;
}

/** True when `dir` is inside a git work tree (a `.git` entry here or above). */
export function inGitWorkTree(dir: string): boolean {
  let current = resolve(dir);
  for (;;) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** `dlg-<UTC stamp>-<8 hex>`; never altered by either side's session-id sanitizer. */
export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `dlg-${stamp}-${randomBytes(4).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Run state, shared by every instance of the tools in this process
// ---------------------------------------------------------------------------

interface RunState {
  runId: string;
  dir: string;
  model: string;
  checkoutKey: string;
  childWalk: string;
  childLink: string;
  startedAt: number;
  pid?: number;
  exit?: DetachedExit;
  finishedAt?: number;
}

/** Running delegations, keyed by checkout real path → run id. */
const activeByCheckout = new Map<string, string>();
/** Every run started in this process, keyed by its directory (so a status lookup is session-scoped). */
const runsByDir = new Map<string, RunState>();

function checkoutKey(checkoutRoot: string): string {
  try {
    return realpathSync(checkoutRoot);
  } catch {
    return resolve(checkoutRoot);
  }
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readTail(path: string, chars: number): string {
  try {
    const size = statSync(path).size;
    const length = Math.min(size, chars * 4);
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const text = buffer.toString("utf8");
      return text.length > chars ? text.slice(text.length - chars) : text;
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** The last stderr line that is the CLI's `--json` error object (`{code, message, remediation}`). */
function cliError(stderr: string): Record<string, unknown> | undefined {
  const lines = stderr.split("\n").filter((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]!);
      if (parsed && typeof parsed === "object" && typeof parsed.message === "string") return parsed;
    } catch {
      // Not JSON: a plain diagnostic line.
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export interface DelegateDeps {
  /** The environment snapshot; defaults to a copy of `process.env` taken now (at load). */
  env?: Env;
  launch?: DetachedLauncher;
  /** PATH lookup; `_procs.ts`'s absolute-entries-only rule by default. */
  which?: (name: string, env: Env) => string | null;
  /** Append the child line; defaults to the session walk attached to `ctx`. */
  recordChild?: (link: ChildLink) => ChildEntry;
  /** Liveness of a pid recorded by an earlier process (status after a restart). */
  isAlive?: (pid: number) => boolean;
  /** The associate tree whose CLI is run; `lib/paths.ts` `associateRoot` by default (tests). */
  associateRoot?: string;
  /** Clock; `Date.now` by default (tests). */
  now?: () => number;
}

function delegateBudget(ctx: AssociateContext): { maxChars: number; timeoutMs: number } | undefined {
  const budgets = (ctx.policy.budgets ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const delegate = budgets.delegate ?? {};
  const maxChars = delegate.max_output_chars;
  const timeoutMs = delegate.timeout_ms;
  if (typeof maxChars !== "number" || !(maxChars > 0) || typeof timeoutMs !== "number" || !(timeoutMs > 0)) {
    return undefined;
  }
  return { maxChars, timeoutMs };
}

/** The run's result within `max` JSON chars: the final reply is cut first, then only the outcome is kept. */
function boundedResult(
  result: Record<string, unknown>,
  max: number,
): { result: Record<string, unknown>; truncated: boolean } {
  const size = (value: unknown) => (JSON.stringify(value) ?? "").length;
  if (size(result) <= max) return { result, truncated: false };
  let cut = result;
  if (typeof result.final_reply === "string") {
    const over = size(result) - max;
    const keep = Math.max(0, result.final_reply.length - over - 64);
    cut = { ...result, final_reply: result.final_reply.slice(0, keep) };
    if (size(cut) <= max) return { result: cut, truncated: true };
  }
  const tests = result.tests && typeof result.tests === "object" ? (result.tests as Record<string, unknown>) : undefined;
  const summary: Record<string, unknown> = {};
  for (const key of ["outcome", "merge", "merge_reason", "worktree", "run_branch", "isolation", "walk_path", "export_dir", "session_id"]) {
    if (key in result) summary[key] = result[key];
  }
  if (tests) summary.tests_passed = tests.passed;
  return { result: summary, truncated: true };
}

export function createDelegateTools(ctx: AssociateContext, deps: DelegateDeps = {}) {
  // Snapshotted once, here — at load when called from register().
  const env: Env = { ...(deps.env ?? process.env) };
  const registry = ctx.contract.models;
  const active = resolveActiveModel(env, registry);
  const problems = delegationProblems(registry);
  const allowed: string[] = problems.length ? [] : [...(active.entry?.may_delegate ?? [])];
  const launch = deps.launch ?? defaultDetachedLauncher;
  const which = deps.which ?? whichOnPath;
  const isAlive = deps.isAlive ?? processAlive;
  const root = deps.associateRoot ?? defaultAssociateRoot;
  const now = deps.now ?? Date.now;
  const budget = delegateBudget(ctx);
  const tests = parseTestCommands(env[TEST_COMMANDS_ENV]);
  const trusted = isCheckoutTrusted(env);
  const redaction: RedactionFilter = compileRedaction(ctx.policy);
  const delegatedRoot = join(ctx.session.sessionRoot, DELEGATED_DIR);
  if (problems.length && (active.entry?.may_delegate ?? []).length) {
    console.error(`associate: models.json may_delegate is malformed (${problems.join("; ")}); every delegation is refused`);
  }

  const refuse = (requested: unknown, why: string): Result =>
    toolResult(
      toolError(
        "delegate_refused",
        `${why}. ${allowed.length ? `This model may delegate only to: ${allowed.join(", ")}.` : "This model may not delegate."}`,
        { requested, allowed, source: "models.json may_delegate" },
      ),
    );

  function writeRecord(state: RunState, extra: Record<string, unknown> = {}): void {
    const record = {
      run_id: state.runId,
      model: state.model,
      checkout: state.checkoutKey,
      child_walk: state.childWalk,
      child_link: state.childLink,
      started_at: new Date(state.startedAt).toISOString(),
      ...(state.pid !== undefined ? { pid: state.pid } : {}),
      ...(state.exit
        ? {
            exit_code: state.exit.exitCode,
            signal: state.exit.signal,
            ...(state.exit.error !== undefined ? { launch_error: state.exit.error } : {}),
            finished_at: new Date(state.finishedAt ?? now()).toISOString(),
          }
        : {}),
      ...extra,
    };
    try {
      writeFileSync(join(state.dir, RECORD_FILE), `${JSON.stringify(redactValue(record, redaction), null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // The in-process state is authoritative while this process lives.
    }
  }

  function start(params: Record<string, unknown>): Result {
    const extra = Object.keys(params).filter((key) => key !== "model" && key !== "task");
    if (extra.length > 0) {
      return toolResult(
        toolError("invalid_args", `${DELEGATE_RUN_TOOL} takes only 'model' and 'task'; ${extra.join(", ")} cannot be given`, {
          field: extra[0],
        }),
      );
    }
    const { model, task } = params;
    if (typeof model !== "string") {
      return toolResult(toolError("invalid_args", "model must be a string naming the registry model to run", { field: "model" }));
    }
    if (typeof task !== "string" || task.trim() === "") {
      return toolResult(toolError("invalid_args", "task must be a non-empty string", { field: "task" }));
    }
    if (task.length > MAX_TASK_CHARS) {
      return toolResult(
        toolError("invalid_args", `task is longer than ${MAX_TASK_CHARS} characters; give the run a shorter brief`, {
          field: "task",
        }),
      );
    }
    if (problems.length) {
      return toolResult(
        toolError("contract_incomplete", `models.json may_delegate is malformed, so no delegation is allowed: ${problems.join("; ")}`),
      );
    }
    if (!allowed.includes(model)) {
      return refuse(model, `'${model}' may not be delegated to by '${active.key ?? "no model"}'`);
    }
    const target = registry.models[model];
    if (!target || target.status !== "active") return refuse(model, `'${model}' is not an active registry model`);
    if (target.may_mutate !== true) return refuse(model, `'${model}' may not mutate, so it gets no run worktree`);

    if (!budget) {
      return toolResult(
        toolError(
          "contract_incomplete",
          "the contract's policy.budgets.delegate (max_output_chars, timeout_ms) is missing; delegate_run defines no budget of its own",
        ),
      );
    }
    if (tests.problem !== undefined) {
      return toolResult(
        toolError(
          "test_commands_malformed",
          `${TEST_COMMANDS_ENV} is malformed (${tests.problem}), so no delegated run can be checked by the operator's tests; nothing was started`,
          { source: TEST_COMMANDS_ENV },
        ),
      );
    }
    if (tests.commands.length === 0) {
      return toolResult(
        toolError(
          "no_test_commands",
          `no operator test command is configured (${TEST_COMMANDS_ENV} is unset or empty), and a delegated run ` +
            "merges only when the operator's tests pass, so nothing was started; describe the change in finish instead",
          { source: TEST_COMMANDS_ENV },
        ),
      );
    }
    if (!inGitWorkTree(ctx.checkoutRoot)) {
      return toolResult(
        toolError(
          "not_a_git_checkout",
          `${ctx.checkoutRoot} is not inside a git work tree, so a delegated run would get no worktree and no merge check; nothing was started`,
          { checkout: ctx.checkoutRoot },
        ),
      );
    }
    const cli = inTreeCli(root, env, which);
    if ("problem" in cli) return toolResult(toolError("tool_missing", cli.problem, { associate_root: root }));

    const key = checkoutKey(ctx.checkoutRoot);
    const busy = activeByCheckout.get(key);
    if (busy !== undefined) {
      return toolResult(
        toolError(
          "delegate_busy",
          `delegated run ${busy} is still running in this checkout; only one runs at a time — check it with ${DELEGATE_STATUS_TOOL}`,
          { running_run_id: busy, checkout: key },
        ),
      );
    }

    const startedAt = now();
    const runId = newRunId(new Date(startedAt));
    const dir = join(delegatedRoot, runId);
    const childWalk = join(dir, "export", WALK_FILENAME);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      return toolResult(
        toolError("delegate_failed", `the run directory could not be created: ${error instanceof Error ? error.message : String(error)}`),
      );
    }

    const recordChild = deps.recordChild ?? ((link: ChildLink) => {
      const walk = ctx.walk();
      if (!walk) throw new Error("no walk recorder is attached to this session");
      return walk.recordChild(link);
    });
    let link: ChildEntry;
    try {
      link = recordChild({ child_model: model, child_walk: childWalk, child_session_id: runId });
    } catch (error) {
      return toolResult(
        toolError(
          "walk_unavailable",
          `the delegated run could not be linked in this session's walk (${error instanceof Error ? error.message : String(error)}), ` +
            "so it was not started: no run starts without its walk path on record",
          { child_model: model },
        ),
      );
    }

    const timeoutSeconds = budget.timeoutMs / 1000;
    const args = [
      ...cli.prefix,
      ...runArguments({
        model,
        task,
        checkout: ctx.checkoutRoot,
        exportRoot: delegatedRoot,
        sessionId: runId,
        timeoutSeconds,
        untrusted: !trusted,
        testCommands: tests.commands,
      }),
    ];
    const state: RunState = { runId, dir, model, checkoutKey: key, childWalk, childLink: link.id, startedAt };

    activeByCheckout.set(key, runId);
    let handle: DetachedRun;
    try {
      handle = launch({
        file: cli.file,
        args,
        cwd: cli.cwd,
        env: delegateEnvironment(env, cli),
        stdoutPath: join(dir, RESULT_FILE),
        stderrPath: join(dir, STDERR_FILE),
      });
    } catch (error) {
      activeByCheckout.delete(key);
      const message = redaction.apply(error instanceof Error ? error.message : String(error));
      state.exit = { exitCode: null, signal: null, error: message };
      state.finishedAt = now();
      runsByDir.set(dir, state);
      writeRecord(state);
      return toolResult(toolError("delegate_failed", `the delegated run could not be started: ${message}`, { run_id: runId }));
    }
    state.pid = handle.pid;
    runsByDir.set(dir, state);
    writeRecord(state, { argv: args.map((arg) => redaction.apply(arg)) });
    void handle.exited.then((exit) => {
      state.exit = exit;
      state.finishedAt = now();
      writeRecord(state);
      if (activeByCheckout.get(key) === runId) activeByCheckout.delete(key);
    });

    return toolResult({
      ok: true,
      run_id: runId,
      state: "started",
      model,
      child_walk: childWalk,
      child_link: link.id,
      started_at: new Date(startedAt).toISOString(),
      timeout_s: timeoutSeconds,
      test_commands: tests.commands.length,
      untrusted_checkout: !trusted,
      note:
        `the run continues after this call returns; it usually takes minutes. Report the run id, and call ` +
        `${DELEGATE_STATUS_TOOL} with it to see whether it is still running or what it did.`,
    });
  }

  function status(params: Record<string, unknown>): Result {
    const extra = Object.keys(params).filter((key) => key !== "run_id");
    if (extra.length > 0) {
      return toolResult(
        toolError("invalid_args", `${DELEGATE_STATUS_TOOL} takes only 'run_id'; ${extra.join(", ")} cannot be given`, { field: extra[0] }),
      );
    }
    const runId = params.run_id;
    if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
      return toolResult(
        toolError("invalid_args", "run_id must be a run id returned by delegate_run (dlg-<stamp>-<hex>)", { field: "run_id" }),
      );
    }
    const dir = join(delegatedRoot, runId);
    const live = runsByDir.get(dir);
    const record = live ? undefined : readJsonObject(join(dir, RECORD_FILE));
    if (!live && !record) {
      return toolResult(toolError("unknown_run", `no delegated run ${runId} was started in this session`, { run_id: runId }));
    }
    const model = live?.model ?? record?.model;
    const childWalk = live?.childWalk ?? record?.child_walk;
    const startedMs = live?.startedAt ?? Date.parse(String(record?.started_at ?? ""));
    const exit: DetachedExit | undefined =
      live?.exit ??
      (record && "exit_code" in record
        ? {
            exitCode: typeof record.exit_code === "number" ? record.exit_code : null,
            signal: typeof record.signal === "string" ? record.signal : null,
            ...(typeof record.launch_error === "string" ? { error: record.launch_error } : {}),
          }
        : undefined);
    const base = { run_id: runId, model, child_walk: childWalk };
    const result = readJsonObject(join(dir, RESULT_FILE));

    if (!exit) {
      const pid = live ? live.pid : typeof record?.pid === "number" ? record.pid : undefined;
      const running = live !== undefined || (result === undefined && pid !== undefined && isAlive(pid));
      if (running) {
        return toolResult({
          ok: true,
          ...base,
          state: "running",
          started_at: Number.isFinite(startedMs) ? new Date(startedMs).toISOString() : undefined,
          elapsed_ms: Number.isFinite(startedMs) ? Math.max(0, now() - startedMs) : undefined,
          note: "still running; ask again later rather than waiting in this turn",
        });
      }
      if (result === undefined) {
        return toolResult(
          toolError(
            "delegate_lost",
            "the delegated run is no longer running and left no result (the process that started it ended before it did)",
            { ...base, state: "lost", stderr_tail: redaction.apply(readTail(join(dir, STDERR_FILE), STDERR_TAIL_CHARS)) },
          ),
        );
      }
    }

    if (exit && (exit.error !== undefined || exit.exitCode !== 0 || result === undefined)) {
      const stderr = redaction.apply(readTail(join(dir, STDERR_FILE), STDERR_TAIL_CHARS));
      const error = cliError(stderr);
      const why =
        exit.error !== undefined
          ? `could not be started: ${redaction.apply(exit.error)}`
          : exit.exitCode === null
            ? `was killed (${exit.signal ?? "signal"})`
            : exit.exitCode !== 0
              ? `exited with status ${exit.exitCode}${error ? `: ${redaction.apply(String(error.message))}` : ""}`
              : "exited 0 but its result could not be read";
      return toolResult(
        toolError("delegate_failed", `the delegated run ${why}`, {
          ...base,
          state: "failed",
          exit_code: exit.exitCode,
          signal: exit.signal,
          ...(error ? { cli_error: redactValue(error, redaction) } : {}),
          stderr_tail: stderr,
        }),
      );
    }

    const bounded = boundedResult(redactValue(result!, redaction), budget?.maxChars ?? 25_000);
    return toolResult({
      ok: true,
      ...base,
      state: "finished",
      exit_code: exit ? exit.exitCode : null,
      result: bounded.result,
      truncated: bounded.truncated,
      note:
        "final_reply is the delegated model's own account; outcome, merge, merge_reason and tests are the harness's",
    });
  }

  const targets = allowed.length ? allowed.join(", ") : "none";
  const runTool = {
    name: DELEGATE_RUN_TOOL,
    label: "Delegate Run",
    description:
      "Hand a task that needs files changed to a separate associate run of a writing model, and return at once " +
      "with a run id (it does not wait). That run works in its own git worktree of this checkout; its changes are " +
      "merged into the local main branch only if it finishes cleanly and every operator test command passes, and " +
      `nothing is pushed. One delegated run per checkout at a time. Models you may delegate to: ${targets}. ` +
      `Check it later with ${DELEGATE_STATUS_TOOL}.`,
    promptSnippet: "Hand a writing task to a separate worktree run and get a run id back",
    promptGuidelines: [
      "Give the delegated run one complete, self-contained task: it sees nothing of this conversation.",
      `Do not wait for a delegated run in the same turn; report its run id and check it later with ${DELEGATE_STATUS_TOOL}.`,
    ],
    parameters: {
      type: "object",
      properties: {
        model: {
          type: "string",
          ...(allowed.length ? { enum: allowed } : {}),
          description: `The registry key of the model to run (${targets}).`,
        },
        task: { type: "string", description: "The task, complete and self-contained: the run sees nothing else." },
      },
      required: ["model", "task"],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<Result> {
      try {
        return start(params ?? {});
      } catch (error) {
        return toolResult(
          toolError("delegate_failed", `delegate_run failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`),
        );
      }
    },
  };

  const statusTool = {
    name: DELEGATE_STATUS_TOOL,
    label: "Delegate Status",
    description:
      "Report a run started with delegate_run, by its run id: still running, or its finished result — outcome, " +
      "whether it merged into main and why not, its worktree and branch, the test results and its final reply. " +
      "Read-only.",
    promptSnippet: "Check a delegated run: running, or its outcome, merge and test results",
    parameters: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "The run id delegate_run returned." },
      },
      required: ["run_id"],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<Result> {
      try {
        return status(params ?? {});
      } catch (error) {
        return toolResult(
          toolError("delegate_failed", `delegate_status failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`),
        );
      }
    },
  };

  return { run: runTool, status: statusTool };
}

/**
 * Register both tools. Registered for every model; only a model whose
 * `models.json` `tools` names them (senses) ever has them active, and the
 * `tool_call` guard refuses them for every other model.
 */
export function register(pi: unknown, ctx: AssociateContext): void {
  const api = pi as { registerTool(definition: unknown): void };
  const tools = createDelegateTools(ctx);
  // delegate_status reads files under this session's own directory only.
  ctx.declareNonWriter(DELEGATE_STATUS_TOOL);
  api.registerTool(tools.run);
  api.registerTool(tools.status);
}
