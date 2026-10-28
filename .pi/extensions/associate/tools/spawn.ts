/**
 * `spawn_subagent` — cortex hands a sub-task to a child model (plan t16;
 * spec c40/h24, c52/h34). Modelled on pi's `examples/extensions/subagent`
 * (one child = one `pi --mode json -p --no-session` process whose event
 * stream is parsed for the result), adapted to associate's rules:
 *
 *   * **Who may spawn whom is the contract's.** The parent's `models.json`
 *     `may_spawn` list (cortex: `worker`, `senses`) is the whole allowlist;
 *     no child name is written in this file. A requested model not on it, a
 *     model that is not `active`, and a model that may itself spawn are
 *     refused before anything is launched. Only cortex holds the tool in its
 *     `tools` list, so for every other model the active-set filter never
 *     offers it and the `tool_call` guard refuses it; the `may_spawn` check
 *     here is defence in depth for a call that reaches `execute` anyway.
 *   * **Each child runs under its own model's guard.** A child is launched as
 *     pi with THIS extension (`-e <index.ts>`) and `ASSOCIATE_MODEL=<child>`,
 *     so its own `tool_call` guard, active tool set and CLEF gate apply to
 *     every one of its calls: a senses child is refused every mutation by
 *     its own guard, exactly as a senses run launched by the Python harness
 *     is. Nothing in the child's argv names a tool set (`--tools`) or a
 *     system prompt; the model's set comes from the contract inside the child.
 *   * **The launch mirrors `associate/harness/pi.py`.** `-p --mode json
 *     --no-session`, the trust flags, `--no-context-files` with
 *     `ASSOCIATE_INJECT_PROMPT=1`, `--no-mcp`, `-e`, and `--provider associate
 *     --model <lobes role>` only when `ASSOCIATE_API_KEY` is set.
 *   * **Never more trusting than the parent.** The Python launcher sets
 *     `ASSOCIATE_PI_TRUST` (`approve` | `untrusted`) from the flags it launched
 *     the parent with. Only the exact value `approve` gives a child
 *     `--approve`; anything else — including a parent started by some other
 *     launcher that sets nothing (the mesh's pi-acp today) — gives the
 *     hardened `--no-approve --no-extensions` (deviation d5). `-e` still
 *     loads this extension under `--no-extensions`.
 *   * **One writing child per checkout at a time; readers in parallel.** A
 *     child whose `models.json` entry has `may_mutate: true` (worker) runs
 *     behind a per-checkout queue (keyed by the checkout's real path, shared
 *     by every instance of this tool in the process), so two writing children
 *     never touch the same tree concurrently. A `may_mutate: false` child
 *     (senses) never waits on it. Serialising was chosen over a worktree per
 *     child: worktree creation and the merge-back are the Python harness's job
 *     (`associate/harness/worktree.py`, gated by the operator's tests), and
 *     re-implementing them in TypeScript would create a second, ungated merge
 *     path.
 *   * **Every child is linked in the parent walk, before it starts.** A
 *     `{"child": …}` line (`$defs/child`) naming the child's walk path is
 *     appended before launch; when it cannot be written, nothing is launched.
 *     The child's export root is `<parent session root>/children`, and its
 *     walk path is computed with the very function the child uses
 *     (`resolveSessionDirs`), so the link points where the child writes.
 *
 * **Why `spawn_subagent` is not gated itself.** It is in neither
 * `mutating_tools` nor `gated_tools`: the spawn writes nothing and sends
 * nothing off the machine by itself — the child does both through its own
 * tools, and every such call is classified, guarded and (when mutating or
 * gated) CLEF-scored inside the child under the child's own model. Gating the
 * spawn too would score the same effect twice with less information (the
 * child's task text, not its concrete call). The cost, stated rather than
 * hidden: a child's gate scores calls against the task text cortex wrote for
 * it, not the operator's original prompt.
 *
 * Limits named here, not in the contract: the stderr tail kept for an error
 * and the largest single stdout line parsed. The hand-back budget and the
 * child wall clock are the contract's (`policy.budgets.spawn`); the wall clock
 * is capped by the parent run's own deadline (`ASSOCIATE_RUN_DEADLINE`, set by
 * the Python launcher from `--timeout`) minus a named safety margin, counting
 * any time a writing child spent queued for the checkout.
 *
 * Node builtins only; no npm dependency (spec c44). Never a shell.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AssociateContext } from "../lib/context.ts";
import type { ModelEntry } from "../lib/contract.ts";
import { extensionDir } from "../lib/paths.ts";
import { ASSOCIATE_PROVIDER_ID } from "../lib/provider.ts";
import { resolveSessionDirs, sanitizeSessionId } from "../lib/session.ts";
import { PI_TRUST_ENV, PI_TRUSTED, isCheckoutTrusted } from "../lib/trust.ts";
import { resolveActiveModel } from "../lib/toolset.ts";
import {
  compileRedaction,
  contentToText,
  redactValue,
  WALK_FILENAME,
  type ChildEntry,
  type ChildLink,
  type RedactionFilter,
} from "../lib/walk.ts";
import { toolError, toolResult, whichOnPath, type ToolError } from "./_procs.ts";

/** The registered name; `models.json` `tool_names` lists it. */
export const SPAWN_TOOL_NAME = "spawn_subagent";

/** The parent's trust mode, set by the Python launcher (see the header; read in `lib/trust.ts`). */
export { PI_TRUST_ENV };

/** The only value of {@link PI_TRUST_ENV} that lets a child trust the checkout. */
const TRUSTED = PI_TRUSTED;

/** The binary a child is launched as, found on `$PATH` exactly as the Python harness finds it. */
const PI_BINARY = "pi";

/** Where children's session directories go, under the parent's session root. */
const CHILDREN_DIR = "children";

/** Parent variables a child must not inherit: another run's walk, the parent's ACP session. */
const NOT_INHERITED = ["ASSOCIATE_CONTINUE_FROM", "PI_ACP_SESSION_ID", "ACP_SESSION_ID"] as const;

/** Chars of a failed child's stderr kept for the error (its end is where the reason is). */
const STDERR_TAIL_CHARS = 4_000;

/** One stdout line larger than this is dropped unparsed rather than buffered without bound. */
const MAX_LINE_CHARS = 16 * 1024 * 1024;

/** Linux's MAX_ARG_STRLEN (128 KiB) bounds one argv string; the task travels as one. */
const MAX_TASK_CHARS = 100_000;

/** After a kill, how long to wait for the pipes to close before giving up on them. */
const KILL_GRACE_MS = 5_000;

/**
 * The parent run's deadline, absolute epoch milliseconds, set by the Python
 * launcher from its `--timeout` (it kills the parent pi then). Never inherited
 * from the operator: the launcher sets it or removes it. Snapshotted at load.
 */
export const RUN_DEADLINE_ENV = "ASSOCIATE_RUN_DEADLINE";

/**
 * Run time held back from a child's wall clock: room for the kill grace, the
 * parent reading the child's result and still finishing before its own kill.
 */
export const DEADLINE_SAFETY_MARGIN_MS = 30_000;

/** A child with less wall clock than this is refused rather than started to be killed. */
export const MIN_CHILD_WALL_MS = 30_000;

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------

export interface LaunchSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface LaunchOutcome {
  /** Null when the process did not exit on its own (killed, or never started). */
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  stderrTail: string;
  /** Why the process could not be started, when it could not. */
  error?: string;
}

/** Start one child; call `onLine` for each stdout line; resolve when it is gone. Never rejects by contract. */
export type Launcher = (spec: LaunchSpec, onLine: (line: string) => void) => Promise<LaunchOutcome>;

/**
 * The real launcher: argv only (`shell: false`), its own process group so a
 * timeout or an abort kills the child's children too (the `run_tests` rule).
 */
export const defaultLauncher: Launcher = (spec, onLine) =>
  new Promise<LaunchOutcome>((resolvePromise) => {
    let buffer = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let spawnError: string | undefined;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;

    const child = nodeSpawn(spec.file, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const killTree = () => {
      try {
        if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      grace ??= setTimeout(() => finish(null), KILL_GRACE_MS);
    };
    const emit = (line: string) => {
      if (!line.trim()) return;
      try {
        onLine(line);
      } catch {
        // A parser fault must not leave the child running unobserved.
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) emit(line);
      if (buffer.length > MAX_LINE_CHARS) buffer = "";
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > STDERR_TAIL_CHARS * 2) stderr = stderr.slice(stderr.length - STDERR_TAIL_CHARS);
    });

    const onAbort = () => {
      aborted = true;
      killTree();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, spec.timeoutMs);
    if (spec.signal) {
      if (spec.signal.aborted) onAbort();
      else spec.signal.addEventListener("abort", onAbort, { once: true });
    }

    function finish(code: number | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      spec.signal?.removeEventListener("abort", onAbort);
      if (buffer) emit(buffer);
      const outcome: LaunchOutcome = {
        exitCode: spawnError || timedOut || aborted ? null : code,
        timedOut,
        aborted,
        stderrTail: stderr.length > STDERR_TAIL_CHARS ? stderr.slice(stderr.length - STDERR_TAIL_CHARS) : stderr,
      };
      if (spawnError) outcome.error = spawnError;
      resolvePromise(outcome);
    }
    child.on("error", (error) => {
      spawnError = error.message;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });

// ---------------------------------------------------------------------------
// The writer queue: one writing child per checkout at a time
// ---------------------------------------------------------------------------

/** Shared by every instance of the tool in this process, keyed by checkout real path. */
const writerQueues = new Map<string, Promise<unknown>>();

function checkoutKey(checkoutRoot: string): string {
  try {
    return realpathSync(checkoutRoot);
  } catch {
    return resolve(checkoutRoot);
  }
}

function withWriterLock<T>(checkoutRoot: string, body: () => Promise<T>): Promise<T> {
  const key = checkoutKey(checkoutRoot);
  const previous = writerQueues.get(key) ?? Promise.resolve();
  const next = previous.then(body);
  const tail = next.catch(() => undefined);
  writerQueues.set(key, tail);
  void tail.then(() => {
    if (writerQueues.get(key) === tail) writerQueues.delete(key);
  });
  return next;
}

// ---------------------------------------------------------------------------
// The child's argv and environment
// ---------------------------------------------------------------------------

/** The trust flags for a child of a parent whose environment is `env`. */
export function piTrustFlags(env: Env): string[] {
  return isCheckoutTrusted(env) ? ["--approve"] : ["--no-approve", "--no-extensions"];
}

/** The argv after `pi` for one child. The task is last and prefixed so it can never parse as a flag. */
export function childArguments(env: Env, child: ModelEntry, task: string): string[] {
  const args = [
    "-p",
    "--mode",
    "json",
    "--no-session",
    ...piTrustFlags(env),
    "--no-context-files",
    "--no-mcp",
    "-e",
    join(extensionDir, "index.ts"),
  ];
  if ((env.ASSOCIATE_API_KEY ?? "").trim()) {
    args.push("--provider", ASSOCIATE_PROVIDER_ID, "--model", child.lobes_role);
  }
  args.push(`Task: ${task}`);
  return args;
}

/** The child's environment: the parent's snapshot, minus what must not travel, plus the child's identity. */
export function spawnEnvironment(
  env: Env,
  overrides: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if ((NOT_INHERITED as readonly string[]).includes(key)) continue;
    out[key] = value;
  }
  return { ...out, ...overrides };
}

// ---------------------------------------------------------------------------
// Reading the child's event stream
// ---------------------------------------------------------------------------

interface ChildStream {
  handback?: unknown;
  finalText?: string;
  stopReason?: string;
  errorMessage?: string;
}

function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return typeof content === "string" ? content : undefined;
  for (const block of content) {
    if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
      return (block as { text: string }).text;
    }
  }
  return undefined;
}

/** Fold one `pi --mode json` line into what the parent keeps: the last finish payload and the last reply. */
function readLine(state: ChildStream, line: string): void {
  let event: Record<string, any>;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (!event || typeof event !== "object") return;
  if (event.type === "tool_execution_end" && event.toolName === "finish" && event.isError !== true) {
    // finish's first content block is the normalized hand-back, as JSON (index.ts).
    const text = firstText(event.result?.content);
    if (text !== undefined) {
      try {
        state.handback = JSON.parse(text);
      } catch {
        state.handback = text;
      }
    }
    return;
  }
  if (event.type === "message_end" && event.message?.role === "assistant") {
    state.finalText = contentToText(
      Array.isArray(event.message.content)
        ? event.message.content.filter((block: any) => block && block.type === "text")
        : event.message.content,
    );
    state.stopReason = typeof event.message.stopReason === "string" ? event.message.stopReason : undefined;
    state.errorMessage = typeof event.message.errorMessage === "string" ? event.message.errorMessage : undefined;
  }
}

/** The child walk's run record, read from its last line — the harness's account, not the model's. */
function readRunRecord(walkPath: string): unknown {
  try {
    const size = statSync(walkPath).size;
    const length = Math.min(size, 64 * 1024);
    const fd = openSync(walkPath, "r");
    try {
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const lines = buffer.toString("utf8").split("\n").filter((line) => line.trim());
      const last = JSON.parse(lines[lines.length - 1] ?? "null");
      return last && typeof last === "object" && "run" in last ? last.run : undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export interface SpawnDeps {
  /** The environment snapshot; defaults to a copy of `process.env` taken now (at load). */
  env?: Env;
  launch?: Launcher;
  /** PATH lookup; `_procs.ts`'s absolute-entries-only rule by default. */
  which?: (name: string, env: Env) => string | null;
  /** Append the child line; defaults to the session walk attached to `ctx`. */
  recordChild?: (link: ChildLink) => ChildEntry;
  /** Override the contract's child wall clock (tests). */
  timeoutMs?: number;
  /** The clock the run deadline is measured with; `Date.now` by default (tests). */
  now?: () => number;
}

/** The snapshotted deadline, or undefined when none (or a malformed one) was set. */
function runDeadline(env: Env): number | undefined {
  const raw = env[RUN_DEADLINE_ENV]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

type Result = { content: Array<{ type: "text"; text: string }>; details: unknown };

function spawnBudget(ctx: AssociateContext): { maxChars: number; timeoutMs: number } | undefined {
  const budgets = (ctx.policy.budgets ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const spawn = budgets.spawn ?? {};
  const maxChars = spawn.max_output_chars;
  const timeoutMs = spawn.timeout_ms;
  if (typeof maxChars !== "number" || !(maxChars > 0) || typeof timeoutMs !== "number" || !(timeoutMs > 0)) {
    return undefined;
  }
  return { maxChars, timeoutMs };
}

function bounded(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max ? { text: text.slice(0, Math.max(0, max)), cut: true } : { text, cut: false };
}

export function createSpawnTool(ctx: AssociateContext, deps: SpawnDeps = {}) {
  // Snapshotted once, here — at load when called from register().
  const env: Env = { ...(deps.env ?? process.env) };
  const registry = ctx.contract.models;
  const parent = resolveActiveModel(env, registry);
  const allowed: string[] = [...(parent.entry?.may_spawn ?? [])];
  const launch = deps.launch ?? defaultLauncher;
  const which = deps.which ?? whichOnPath;
  const contractBudget = spawnBudget(ctx);
  const budget =
    contractBudget && deps.timeoutMs !== undefined && deps.timeoutMs > 0
      ? { ...contractBudget, timeoutMs: deps.timeoutMs }
      : contractBudget;
  const deadline = runDeadline(env);
  const now = deps.now ?? Date.now;
  const redaction: RedactionFilter = compileRedaction(ctx.policy);
  let sequence = 0;

  const refuse = (requested: unknown, why: string): Result =>
    toolResult(
      toolError(
        "spawn_refused",
        `${why}. ${allowed.length ? `This model may spawn only: ${allowed.join(", ")}.` : "This model may not spawn."}`,
        { requested, allowed, source: "models.json may_spawn" },
      ),
    );

  /**
   * This child's wall clock: the contract's, capped by what is left of the
   * parent run (measured now, so time spent queued for the writer lock
   * counts), or a refusal when too little is left for a child to finish.
   */
  function childLimits(
    model: string,
    limits: { maxChars: number; timeoutMs: number },
    waitedMs: number,
  ): { maxChars: number; timeoutMs: number; capped: boolean } | Result {
    if (deadline === undefined) return { ...limits, capped: false };
    const left = deadline - now() - DEADLINE_SAFETY_MARGIN_MS;
    if (left < MIN_CHILD_WALL_MS) {
      return toolResult(
        toolError(
          "run_deadline",
          `too little of this run is left to start a child (${Math.max(0, Math.floor(left))} ms after a ` +
            `${DEADLINE_SAFETY_MARGIN_MS} ms safety margin; a child needs at least ${MIN_CHILD_WALL_MS} ms), ` +
            "so it was not started: finish with what you have",
          { child_model: model, remaining_ms: Math.max(0, Math.floor(left)), waited_ms: waitedMs, source: RUN_DEADLINE_ENV },
        ),
      );
    }
    return left < limits.timeoutMs
      ? { ...limits, timeoutMs: Math.floor(left), capped: true }
      : { ...limits, capped: false };
  }

  async function launchChild(
    model: string,
    child: ModelEntry,
    task: string,
    signal: AbortSignal | undefined,
    piPath: string,
    budgetLimits: { maxChars: number; timeoutMs: number },
    waitedMs = 0,
  ): Promise<Result> {
    if (signal?.aborted) {
      return toolResult(toolError("child_aborted", "the spawn was cancelled before the child started", { child_model: model }));
    }
    const fitted = childLimits(model, budgetLimits, waitedMs);
    if ("content" in fitted) return fitted;
    const limits = fitted;
    sequence += 1;
    const childSession = sanitizeSessionId(
      `${ctx.session.sessionId}-${model}-${sequence}-${randomBytes(4).toString("hex")}`,
    );
    const childEnv = spawnEnvironment(env, {
      ASSOCIATE_MODEL: model,
      ASSOCIATE_SESSION_ID: childSession,
      ASSOCIATE_EXPORT_ROOT: join(ctx.session.sessionRoot, CHILDREN_DIR),
      ASSOCIATE_CONTRACT_DIR: ctx.contract.dir,
      ASSOCIATE_CHECKOUT_ROOT: ctx.checkoutRoot,
      ASSOCIATE_INJECT_PROMPT: "1",
      [PI_TRUST_ENV]: isCheckoutTrusted(env) ? TRUSTED : "untrusted",
    });

    // The child's walk path, by the function the child itself will run.
    let childWalk: string;
    try {
      const dirs = resolveSessionDirs({ checkoutRoot: ctx.checkoutRoot, policy: ctx.policy, env: childEnv, create: false });
      childWalk = join(dirs.exportDir, WALK_FILENAME);
    } catch (error) {
      return toolResult(
        toolError("child_failed", `the child's export directory could not be resolved: ${error instanceof Error ? error.message : String(error)}`, {
          child_model: model,
        }),
      );
    }

    const recordChild = deps.recordChild ?? ((link: ChildLink) => {
      const walk = ctx.walk();
      if (!walk) throw new Error("no walk recorder is attached to this session");
      return walk.recordChild(link);
    });
    let link: ChildEntry;
    try {
      link = recordChild({ child_model: model, child_walk: childWalk, child_session_id: childSession });
    } catch (error) {
      return toolResult(
        toolError(
          "walk_unavailable",
          `the child could not be linked in this run's walk (${error instanceof Error ? error.message : String(error)}), so it was not started: ` +
            "no child runs without its walk path on record",
          { child_model: model },
        ),
      );
    }

    const base = {
      child_model: model,
      child_session_id: childSession,
      child_walk: childWalk,
      child_link: link.id,
    };
    const state: ChildStream = {};
    const started = Date.now();
    let outcome: LaunchOutcome;
    try {
      outcome = await launch(
        {
          file: piPath,
          args: childArguments(env, child, task),
          cwd: ctx.checkoutRoot,
          env: childEnv,
          timeoutMs: limits.timeoutMs,
          signal,
        },
        (line) => readLine(state, line),
      );
    } catch (error) {
      outcome = {
        exitCode: null,
        timedOut: false,
        aborted: false,
        stderrTail: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const durationMs = Date.now() - started;
    const childRun = readRunRecord(childWalk);
    const stderrTail = redaction.apply(outcome.stderrTail ?? "");
    const failure = (code: string, message: string): Result =>
      toolResult(
        toolError(code, message, {
          ...base,
          exit_code: outcome.exitCode,
          duration_ms: durationMs,
          stderr_tail: stderrTail,
          ...(state.finalText ? { final_text: bounded(redaction.apply(state.finalText), limits.maxChars).text } : {}),
          ...(childRun !== undefined ? { child_run: childRun } : {}),
        }),
      );

    if (outcome.error !== undefined) {
      return failure("child_failed", `the child could not be run: ${redaction.apply(outcome.error)}`);
    }
    if (outcome.timedOut) {
      return failure(
        "child_timeout",
        `the child exceeded its ${limits.timeoutMs} ms wall clock` +
          (limits.capped ? " (capped by this run's own deadline)" : "") +
          " and was killed",
      );
    }
    if (outcome.aborted) return failure("child_aborted", "the spawn was cancelled and the child was killed");
    if (outcome.exitCode !== 0) {
      return failure("child_failed", `the child exited with status ${String(outcome.exitCode)}`);
    }
    if (state.handback === undefined && state.stopReason === "error") {
      return failure(
        "child_failed",
        `the child's model call failed: ${redaction.apply(state.errorMessage ?? "no error message")}`,
      );
    }

    // Bounded hand-back: the finish payload first, then the reply text, together
    // within the contract's budget.
    let truncated = false;
    let handback: unknown = null;
    let handbackText: string | undefined;
    let used = 0;
    if (state.handback !== undefined) {
      const redacted = redactValue(state.handback, redaction);
      const json = JSON.stringify(redacted) ?? "";
      if (json.length <= limits.maxChars) {
        handback = redacted;
        used = json.length;
      } else {
        handbackText = json.slice(0, limits.maxChars);
        used = handbackText.length;
        truncated = true;
      }
    }
    const reply = bounded(redaction.apply(state.finalText ?? ""), limits.maxChars - used);
    if (reply.cut) truncated = true;

    const body: Record<string, unknown> = {
      ok: true,
      ...base,
      exit_code: outcome.exitCode,
      duration_ms: durationMs,
      handback,
      final_text: reply.text,
      truncated,
    };
    if (handbackText !== undefined) body.handback_text = handbackText;
    if (childRun !== undefined) body.child_run = childRun;
    if (state.handback === undefined) {
      body.note = "the child ended without calling finish; only its final reply text is returned";
    }
    return toolResult(body);
  }

  async function execute(params: Record<string, unknown>, signal: AbortSignal | undefined): Promise<Result> {
    const extra = Object.keys(params).filter((key) => key !== "model" && key !== "task");
    if (extra.length > 0) {
      return toolResult(
        toolError("invalid_args", `spawn_subagent takes only 'model' and 'task'; ${extra.join(", ")} cannot be given`, {
          field: extra[0],
        }),
      );
    }
    const { model, task } = params;
    if (typeof model !== "string") {
      return toolResult(toolError("invalid_args", "model must be a string naming the child model", { field: "model" }));
    }
    if (typeof task !== "string" || task.trim() === "") {
      return toolResult(toolError("invalid_args", "task must be a non-empty string", { field: "task" }));
    }
    if (task.length > MAX_TASK_CHARS) {
      return toolResult(
        toolError("invalid_args", `task is longer than ${MAX_TASK_CHARS} characters; give the child a shorter brief`, {
          field: "task",
        }),
      );
    }

    if (!allowed.includes(model)) {
      return refuse(model, `'${model}' may not be spawned by '${parent.key ?? "no model"}'`);
    }
    const child = registry.models[model];
    if (!child || child.status !== "active") return refuse(model, `'${model}' is not an active registry model`);
    if ((child.may_spawn ?? []).length > 0) {
      return refuse(model, `'${model}' may itself spawn; a child is never a spawner`);
    }

    if (!budget) {
      return toolResult(
        toolError(
          "contract_incomplete",
          "the contract's policy.budgets.spawn (max_output_chars, timeout_ms) is missing; spawn_subagent defines no budget of its own",
        ),
      );
    }
    const piPath = which(PI_BINARY, env);
    if (!piPath) {
      return toolResult(
        toolError("tool_missing", "pi is not on PATH (absolute PATH entries only), so no child can be started", {
          binary: PI_BINARY,
        }),
      );
    }

    // Refuse up front when the run is already too short; nothing is queued or linked.
    const early = childLimits(model, budget, 0);
    if ("content" in early) return early;
    if (child.may_mutate !== true) return launchChild(model, child, task, signal, piPath, budget);

    // A child that may mutate holds the checkout for its whole run; readers never
    // wait. The wait counts against the run deadline: a writer still queued once
    // no child could finish in time gives up its place and is never started.
    const queuedAt = now();
    let gaveUp = false;
    let started = false;
    const queued = withWriterLock(ctx.checkoutRoot, async (): Promise<Result | undefined> => {
      if (gaveUp) return undefined;
      started = true;
      return launchChild(model, child, task, signal, piPath, budget, now() - queuedAt);
    });
    if (deadline === undefined) return (await queued)!;
    const startBy = deadline - DEADLINE_SAFETY_MARGIN_MS - MIN_CHILD_WALL_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((resolveExpired) => {
      timer = setTimeout(() => resolveExpired("expired"), Math.max(0, startBy - now()));
    });
    try {
      const winner = await Promise.race([queued, expired]);
      if (winner !== "expired") return winner!;
      // A child that already holds the lock runs to its own (capped) wall clock.
      if (started) return (await queued)!;
      gaveUp = true;
      return expiredRefusal(model, now() - queuedAt);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function expiredRefusal(model: string, waitedMs: number): Result {
    return toolResult(
      toolError(
        "run_deadline",
        `the run's deadline came while this writing child was still waiting ${waitedMs} ms for the checkout, ` +
          "so it was not started: finish with what you have",
        { child_model: model, remaining_ms: 0, waited_ms: waitedMs, source: RUN_DEADLINE_ENV },
      ),
    );
  }

  const childList = allowed.length ? allowed.join(", ") : "none";
  return {
    name: SPAWN_TOOL_NAME,
    label: "Spawn Subagent",
    description:
      "Start a child model on one sub-task in this checkout and get its hand-back. The child runs as its " +
      "own associate session under its own model's rules: a reading child cannot change anything, and a " +
      "writing child runs only when no other writing child is running in this checkout (reading children " +
      `run in parallel). Children you may start: ${childList}. The result carries the child's finish ` +
      "payload, its final reply and the path of its walk.",
    promptSnippet: "Hand a sub-task to a child model and get its result back",
    promptGuidelines: [
      "Give each child one concrete sub-task and say what it must return; check what it returns before you build on it.",
    ],
    parameters: {
      type: "object",
      properties: {
        model: {
          type: "string",
          ...(allowed.length ? { enum: allowed } : {}),
          description: `The child model's registry key (${childList}).`,
        },
        task: { type: "string", description: "The sub-task, complete and self-contained: the child sees nothing else." },
      },
      required: ["model", "task"],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
      try {
        return await execute(params ?? {}, signal);
      } catch (error) {
        const failure: ToolError = toolError(
          "child_failed",
          `spawn_subagent failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
        );
        return toolResult(failure);
      }
    },
  };
}

/**
 * Register `spawn_subagent`. Registered for every model; only a model whose
 * `models.json` `tools` names it (cortex) ever has it active, and the
 * `tool_call` guard refuses it for every other model.
 */
export function register(pi: unknown, ctx: AssociateContext): void {
  const api = pi as { registerTool(definition: unknown): void };
  api.registerTool(createSpawnTool(ctx));
}
