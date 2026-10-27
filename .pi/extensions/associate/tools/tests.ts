/**
 * `run_tests` — run the test commands the operator named for this run
 * (deviation d12, part b).
 *
 * Why it exists. `bash` is the read-only allowlisted shell (`policy.json`
 * `shell`), and it stays that way: `node`, `uv` and `pytest` are not on it. So
 * a model that may change code (`worker` = bolt, `cortex`) could edit code it
 * had no way to verify. This tool closes that gap without widening the shell:
 *
 *   * **The operator names the commands, never the model.** The list comes
 *     from `$ASSOCIATE_TEST_COMMANDS` — a JSON array of argv arrays — read ONCE
 *     when the module registers (the extension snapshots its environment at
 *     load; a value read lazily at call time is a known bug class here). The
 *     model's only parameter is an optional index into that list. It can pass
 *     no argv, no flag and no extra argument; any other key is refused.
 *   * **argv, never a shell.** Each command is spawned with `shell: false`.
 *     `argv[0]` without a path separator is resolved on `$PATH` (absolute
 *     entries only, `_procs.ts`'s rule); one with a separator is the
 *     operator's explicit path, used as given against the checkout.
 *   * **The lane key never reaches test code.** The child's environment is the
 *     snapshotted process environment with every `ASSOCIATE_*` variable
 *     removed.
 *   * **Gated.** `run_tests` is in `models.json` `mutating_tools` — it executes
 *     the checkout's own code — so senses never holds it and every call from
 *     worker/cortex goes through the CLEF gate (`gate.json` `effects.run_tests`
 *     tells the decider what it does).
 *   * **What the tests change is put back.** Test runs modify checkouts (`uv
 *     run` rewrites `uv.lock`, caches, snapshots). Before running, the checkout's
 *     `git status --porcelain=v1 -z --untracked-files=all` is recorded and the
 *     bytes of every listed path saved (capped at {@link MAX_PROTECTED_BYTES};
 *     over it the tests are refused, never run unprotected). Afterwards every
 *     path that is dirty now or was dirty before is restored to exactly its
 *     pre-test state, and listed in `reverted`. Ignored files are untouched.
 *     Outside a git work tree there is nothing to restore against: the command
 *     runs and the result says it was unprotected.
 *
 * What is NOT protected: the git index of a path that was already dirty before
 * the run (its working-tree bytes are restored; a test that `git add`s is not
 * undone in the index), and empty directories a test leaves behind (git does
 * not track them, so they never reach a commit).
 *
 * Output: per command, a bounded TAIL of combined stdout+stderr (a test
 * runner's verdict is at the end), sized from the contract's
 * `policy.budgets.shell.max_output_chars` and passed through the contract's
 * redaction filter (`lib/walk.ts` `compileRedaction`). No new output limit is
 * invented here.
 *
 * Node builtins only; no npm dependency.
 */

import { execFile, spawn as nodeSpawn } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { AssociateContext } from "../lib/context.ts";
import { compileRedaction, type RedactionFilter } from "../lib/walk.ts";
import { toolError, toolResult, whichOnPath, type ToolError } from "./_procs.ts";

/** The registered name; `models.json` `tool_names` lists it. */
export const TESTS_TOOL_NAME = "run_tests";

/** Where the operator's commands come from (shared interface with the harness, d12a). */
export const TEST_COMMANDS_ENV = "ASSOCIATE_TEST_COMMANDS";

/** Environment variables with this prefix never reach a test command. */
const STRIPPED_ENV_PREFIX = "ASSOCIATE_";

// ---------------------------------------------------------------------------
// Tool-local bounds. The contract has no test-run section; these are named
// here, commented, until one exists (the output cap is the contract's own).
// ---------------------------------------------------------------------------

/** Wall clock per configured command. A hung test suite must not hang the run. */
export const DEFAULT_TEST_TIMEOUT_MS = 900_000;

/** Most bytes of pre-existing dirty files saved for restoration; over it the run is refused. */
export const MAX_PROTECTED_BYTES = 64 * 1024 * 1024;

/** Wall clock for each git call the protection makes. */
const GIT_TIMEOUT_MS = 60_000;

/** After a timeout kill, how long to wait for the pipes to close before giving up on them. */
const KILL_GRACE_MS = 5_000;

/** Paths handed to one `git checkout` / `git ls-tree` call. */
const GIT_PATH_BATCH = 100;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ParsedCommands {
  readonly commands: string[][];
  /** Set when the variable was present but malformed. */
  readonly problem?: string;
}

/**
 * Parse `$ASSOCIATE_TEST_COMMANDS`: a JSON array of argv arrays of non-empty
 * strings. Absent, blank or `[]` → no commands. Anything else that is not
 * exactly that shape → no commands plus a `problem` (never a throw: a bad value
 * must not crash the extension's load).
 */
export function parseTestCommands(raw: string | undefined): ParsedCommands {
  if (raw === undefined || raw.trim() === "") return { commands: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { commands: [], problem: `not JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!Array.isArray(parsed)) return { commands: [], problem: "not a JSON array of argv arrays" };
  const commands: string[][] = [];
  for (const [index, argv] of parsed.entries()) {
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      !argv.every((token) => typeof token === "string" && token !== "")
    ) {
      return { commands: [], problem: `entry ${index} is not a non-empty array of non-empty strings` };
    }
    commands.push([...(argv as string[])]);
  }
  return { commands };
}

/** The environment a test command runs with: everything but `ASSOCIATE_*`. */
export function childEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.startsWith(STRIPPED_ENV_PREFIX)) continue;
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Running one command
// ---------------------------------------------------------------------------

export interface CommandResult {
  index: number;
  argv: string[];
  /** Null when the process could not be started or was ended by a signal. */
  exit_code: number | null;
  signal?: string;
  timed_out: boolean;
  duration_ms: number;
  output_tail: string;
  output_truncated: boolean;
  /** Why the command could not be started, when it could not. */
  error?: string;
}

interface RunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  tailChars: number;
  redaction: RedactionFilter;
}

/**
 * Keeps the last bytes of a stream. Enough raw bytes are kept that, once
 * decoded, the character tail is full even for 4-byte UTF-8.
 */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private dropped = false;
  private readonly keepBytes: number;
  constructor(keepBytes: number) {
    this.keepBytes = keepBytes;
  }
  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.keepBytes && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
      this.dropped = true;
    }
    if (this.size > this.keepBytes) {
      const only = this.chunks[0]!;
      this.chunks = [only.subarray(only.length - this.keepBytes)];
      this.size = this.keepBytes;
      this.dropped = true;
    }
  }
  text(): { text: string; dropped: boolean } {
    return { text: Buffer.concat(this.chunks).toString("utf8"), dropped: this.dropped };
  }
}

/** Slack kept beyond the tail so a secret straddling the cut is still redacted whole. */
const REDACTION_SLACK_CHARS = 1024;

function runCommand(index: number, argv: string[], options: RunOptions, env: Record<string, string | undefined>) {
  return new Promise<CommandResult>((resolvePromise) => {
    const started = Date.now();
    const base = { index, argv: argv.map((token) => options.redaction.apply(token)) };
    const [program, ...args] = argv as [string, ...string[]];
    const file = program.includes("/") || program.includes("\\") ? program : whichOnPath(program, env);
    if (!file) {
      resolvePromise({
        ...base,
        exit_code: null,
        timed_out: false,
        duration_ms: 0,
        output_tail: "",
        output_truncated: false,
        error: `${program} was not found on PATH (absolute PATH entries only)`,
      });
      return;
    }

    const windowChars = options.tailChars + REDACTION_SLACK_CHARS;
    const tail = new TailBuffer(windowChars * 4);
    let timedOut = false;
    let settled = false;
    let spawnError: string | undefined;

    const child = nodeSpawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a timeout kills the runner's children too.
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
    };
    child.stdout?.on("data", (chunk: Buffer) => tail.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => tail.push(chunk));

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      const { text, dropped } = tail.text();
      const window = text.length > windowChars ? text.slice(text.length - windowChars) : text;
      const redacted = options.redaction.apply(window);
      const truncated = dropped || text.length > options.tailChars || redacted.length > options.tailChars;
      const outputTail =
        redacted.length > options.tailChars ? redacted.slice(redacted.length - options.tailChars) : redacted;
      const result: CommandResult = {
        ...base,
        exit_code: spawnError ? null : code,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
        output_tail: outputTail,
        output_truncated: truncated,
      };
      if (signal) result.signal = signal;
      if (spawnError) result.error = spawnError;
      resolvePromise(result);
    };

    let grace: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      // A grandchild that escaped the group could hold the pipes open: stop waiting.
      grace = setTimeout(() => finish(null, "SIGKILL"), KILL_GRACE_MS);
    }, options.timeoutMs);

    child.on("error", (error) => {
      spawnError = error.message;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

// ---------------------------------------------------------------------------
// Protecting the checkout
// ---------------------------------------------------------------------------

interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

function gitCall(gitBin: string, cwd: string, args: string[], env: Record<string, string>): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    execFile(
      gitBin,
      args,
      {
        cwd,
        env,
        shell: false,
        encoding: "buffer",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { code?: unknown }) | null;
        const code = failure ? (typeof failure.code === "number" ? failure.code : 1) : 0;
        resolvePromise({ code, stdout: stdout ?? Buffer.alloc(0), stderr: (stderr ?? Buffer.alloc(0)).toString("utf8") });
      },
    );
  });
}

/** Parse `git status --porcelain=v1 -z` into the set of paths it names (both sides of a rename). */
export function parsePorcelainZ(out: Buffer): string[] {
  const fields = out.toString("utf8").split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]!;
    if (field.length < 4) continue;
    const xy = field.slice(0, 2);
    paths.push(field.slice(3));
    // A rename or copy carries its source path as the next NUL field.
    if (xy.includes("R") || xy.includes("C")) {
      const from = fields[i + 1];
      if (from) paths.push(from);
      i += 1;
    }
  }
  return paths;
}

type Saved =
  | { kind: "file"; bytes: Buffer; mode: number }
  | { kind: "symlink"; target: string }
  | { kind: "absent" }
  | { kind: "other" };

function capture(abs: string): Saved {
  let stat;
  try {
    stat = lstatSync(abs);
  } catch {
    return { kind: "absent" };
  }
  if (stat.isSymbolicLink()) return { kind: "symlink", target: readlinkSync(abs) };
  if (stat.isFile()) return { kind: "file", bytes: readFileSync(abs), mode: stat.mode & 0o7777 };
  return { kind: "other" };
}

function sameState(a: Saved, b: Saved): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "file" && b.kind === "file") return a.mode === b.mode && a.bytes.equals(b.bytes);
  if (a.kind === "symlink" && b.kind === "symlink") return a.target === b.target;
  return a.kind === "absent";
}

function putBack(abs: string, saved: Saved): void {
  if (saved.kind === "other") return;
  rmSync(abs, { recursive: true, force: true });
  if (saved.kind === "absent") return;
  mkdirSync(dirname(abs), { recursive: true });
  if (saved.kind === "symlink") {
    symlinkSync(saved.target, abs);
    return;
  }
  writeFileSync(abs, saved.bytes);
  chmodSync(abs, saved.mode);
}

interface Protection {
  readonly gitBin: string;
  readonly top: string;
  readonly saved: Map<string, Saved>;
}

type ProtectOutcome =
  | { kind: "protected"; protection: Protection }
  | { kind: "unprotected"; note: string }
  | { kind: "refused"; error: ToolError };

async function protect(
  cwd: string,
  env: Record<string, string>,
  pathEnv: Record<string, string | undefined>,
  maxBytes: number,
): Promise<ProtectOutcome> {
  const gitBin = whichOnPath("git", pathEnv);
  if (!gitBin) {
    return {
      kind: "refused",
      error: toolError(
        "protection_unavailable",
        "git is not on PATH, so the checkout cannot be snapshotted and restored around the test run; " +
          "the tests were not run (they are never run unprotected in a checkout that may be a git work tree).",
      ),
    };
  }
  const inside = await gitCall(gitBin, cwd, ["rev-parse", "--is-inside-work-tree"], env);
  if (inside.code !== 0 || inside.stdout.toString("utf8").trim() !== "true") {
    return { kind: "unprotected", note: "the checkout is not a git work tree, so nothing could be snapshotted or reverted" };
  }
  const topOut = await gitCall(gitBin, cwd, ["rev-parse", "--show-toplevel"], env);
  const top = resolve(topOut.stdout.toString("utf8").trim());
  if (topOut.code !== 0 || top === "") {
    return { kind: "refused", error: toolError("protection_unavailable", "git could not name the work tree root; the tests were not run.") };
  }
  const status = await statusPaths(gitBin, top, env);
  if (status === null) {
    return { kind: "refused", error: toolError("protection_unavailable", "git status failed, so the checkout could not be snapshotted; the tests were not run.") };
  }
  const saved = new Map<string, Saved>();
  let total = 0;
  for (const rel of status) {
    const abs = resolve(top, rel);
    if (abs !== top && !abs.startsWith(top + sep)) continue;
    const state = capture(abs);
    if (state.kind === "file") total += state.bytes.length;
    if (total > maxBytes) {
      return {
        kind: "refused",
        error: toolError(
          "protection_too_large",
          `the checkout's uncommitted files total more than ${maxBytes} bytes, too much to snapshot and ` +
            "restore around a test run; the tests were not run (they are never run unprotected).",
          { limit_bytes: maxBytes },
        ),
      };
    }
    saved.set(rel, state);
  }
  return { kind: "protected", protection: { gitBin, top, saved } };
}

async function statusPaths(gitBin: string, top: string, env: Record<string, string>): Promise<string[] | null> {
  const out = await gitCall(gitBin, top, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], env);
  return out.code === 0 ? parsePorcelainZ(out.stdout) : null;
}

/** Paths among `paths` that exist in HEAD's tree (none when there is no HEAD). */
async function trackedAtHead(gitBin: string, top: string, paths: string[], env: Record<string, string>): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < paths.length; i += GIT_PATH_BATCH) {
    const batch = paths.slice(i, i + GIT_PATH_BATCH);
    const out = await gitCall(
      gitBin,
      top,
      ["--literal-pathspecs", "ls-tree", "-r", "-z", "--name-only", "--full-tree", "HEAD", "--", ...batch],
      env,
    );
    if (out.code !== 0) continue;
    for (const name of out.stdout.toString("utf8").split("\0")) if (name) found.add(name);
  }
  return found;
}

interface RestoreReport {
  reverted: string[];
  errors: Array<{ path: string; error: string }>;
}

async function restore(protection: Protection, env: Record<string, string>): Promise<RestoreReport> {
  const { gitBin, top, saved } = protection;
  const report: RestoreReport = { reverted: [], errors: [] };
  const after = await statusPaths(gitBin, top, env);
  if (after === null) {
    report.errors.push({ path: ".", error: "git status failed after the test run; nothing could be checked" });
  }
  const candidates = new Set<string>([...saved.keys(), ...(after ?? [])]);

  // Dirty before: put the saved state back, byte for byte.
  const cleanBefore: string[] = [];
  for (const rel of [...candidates].sort()) {
    const abs = resolve(top, rel);
    if (abs !== top && !abs.startsWith(top + sep)) continue;
    const before = saved.get(rel);
    if (before === undefined) {
      cleanBefore.push(rel);
      continue;
    }
    if (before.kind === "other" || sameState(before, capture(abs))) continue;
    try {
      putBack(abs, before);
      report.reverted.push(rel);
    } catch (error) {
      report.errors.push({ path: rel, error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Clean before: back to HEAD if HEAD has it, else it is the test's own file.
  const tracked = await trackedAtHead(gitBin, top, cleanBefore, env);
  const toCheckout = cleanBefore.filter((rel) => tracked.has(rel));
  for (let i = 0; i < toCheckout.length; i += GIT_PATH_BATCH) {
    const batch = toCheckout.slice(i, i + GIT_PATH_BATCH);
    const out = await gitCall(gitBin, top, ["--literal-pathspecs", "checkout", "HEAD", "--", ...batch], env);
    if (out.code === 0) report.reverted.push(...batch);
    else for (const rel of batch) report.errors.push({ path: rel, error: `git checkout failed: ${out.stderr.trim()}` });
  }
  for (const rel of cleanBefore.filter((rel) => !tracked.has(rel))) {
    try {
      rmSync(resolve(top, rel), { recursive: true, force: true });
      report.reverted.push(rel);
    } catch (error) {
      report.errors.push({ path: rel, error: error instanceof Error ? error.message : String(error) });
    }
  }
  report.reverted.sort();
  return report;
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export const RUN_TESTS_SCHEMA = {
  type: "object",
  properties: {
    command: {
      type: "integer",
      minimum: 0,
      description:
        "Index of the configured test command to run (0-based). Omit it to run every configured command, in order.",
    },
  },
  additionalProperties: false,
} as const;

export interface TestsDeps {
  /** The environment snapshot; defaults to a copy of `process.env` taken now. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxProtectedBytes?: number;
  /** Where the one malformed-configuration line goes; defaults to `console.error`. */
  log?: (line: string) => void;
}

type Result = { content: Array<{ type: "text"; text: string }>; details: unknown };

function outputBudget(ctx: AssociateContext): number {
  const budgets = (ctx.policy.budgets ?? {}) as Record<string, { max_output_chars?: unknown } | undefined>;
  const chars = budgets.shell?.max_output_chars;
  if (typeof chars !== "number" || !(chars > 0)) {
    throw new Error(
      "associate contract policy.budgets.shell.max_output_chars is missing; run_tests defines no output budget of its own",
    );
  }
  return chars;
}

/** Cap a listed path set at the contract's `caps.max_results`. */
function maxListed(ctx: AssociateContext): number {
  const caps = (ctx.policy.caps ?? {}) as { max_results?: unknown };
  return typeof caps.max_results === "number" && caps.max_results > 0 ? caps.max_results : Number.MAX_SAFE_INTEGER;
}

export function createTestsTool(ctx: AssociateContext, deps: TestsDeps = {}) {
  // Snapshotted once, here — at load when called from register().
  const env = { ...(deps.env ?? process.env) };
  const parsed = parseTestCommands(env[TEST_COMMANDS_ENV]);
  if (parsed.problem) {
    (deps.log ?? ((line: string) => console.error(line)))(
      `associate: ${TEST_COMMANDS_ENV} is malformed (${parsed.problem}); run_tests has no test command configured for this run`,
    );
  }
  const commands = parsed.commands;
  const stripped = childEnvironment(env);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  const maxBytes = deps.maxProtectedBytes ?? MAX_PROTECTED_BYTES;
  const tailBudget = outputBudget(ctx);
  const redaction = compileRedaction(ctx.policy);
  const listCap = maxListed(ctx);
  // One run at a time: two overlapping runs would each restore over the other.
  let queue: Promise<unknown> = Promise.resolve();

  const describeList =
    commands.length === 0
      ? "No test command is configured for this run."
      : redaction.apply(`Configured commands: ${commands.map((argv, i) => `[${i}] ${argv.join(" ")}`).join("; ")}.`);

  async function run(params: Record<string, unknown>): Promise<Result> {
    const keys = Object.keys(params ?? {});
    const extra = keys.filter((key) => key !== "command");
    if (extra.length > 0) {
      return toolResult(
        toolError(
          "invalid_args",
          `run_tests takes only 'command' (an index); ${extra.join(", ")} cannot be given — the operator's commands run exactly as configured`,
          { field: extra[0] },
        ),
      );
    }
    if (commands.length === 0) {
      return toolResult(
        toolError(
          "no_test_commands",
          "the operator configured no test command for this run, so there is nothing to run. Say so in the hand-back.",
          parsed.problem ? { configuration_problem: parsed.problem } : {},
        ),
      );
    }
    const index = params?.command;
    if (index !== undefined && (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= commands.length)) {
      return toolResult(
        toolError(
          "invalid_args",
          `command must be an integer index from 0 to ${commands.length - 1}, or omitted to run all`,
          { field: "command", configured: commands.length },
        ),
      );
    }
    const selected = index === undefined ? commands.map((_, i) => i) : [index as number];

    const guard = await protect(ctx.checkoutRoot, stripped, env, maxBytes);
    if (guard.kind === "refused") return toolResult(guard.error);

    const tailChars = Math.max(1, Math.floor(tailBudget / selected.length));
    const results: CommandResult[] = [];
    let restored: RestoreReport = { reverted: [], errors: [] };
    try {
      for (const i of selected) {
        results.push(
          await runCommand(i, commands[i]!, { cwd: ctx.checkoutRoot, env: stripped, timeoutMs, tailChars, redaction }, env),
        );
      }
    } finally {
      if (guard.kind === "protected") restored = await restore(guard.protection, stripped);
    }

    const passed = results.every((r) => r.exit_code === 0 && !r.timed_out && r.error === undefined);
    const body: Record<string, unknown> = {
      passed,
      results,
      reverted: restored.reverted.slice(0, listCap),
      reverted_count: restored.reverted.length,
      protection: guard.kind === "protected" ? "git" : "none",
    };
    if (restored.reverted.length > listCap) body.reverted_truncated = true;
    if (guard.kind === "unprotected") body.protection_note = guard.note;
    if (restored.errors.length > 0) {
      return toolResult(
        toolError(
          "restore_failed",
          "the tests ran, but some changes they made to the checkout could not be reverted; the listed paths need a person's attention",
          { ...body, restore_errors: restored.errors.slice(0, listCap) },
        ),
      );
    }
    return toolResult({ ok: true, ...body });
  }

  return {
    name: TESTS_TOOL_NAME,
    label: "Run Tests",
    description:
      "Run the test commands the operator configured for this run and report each one's exit code, " +
      "duration and the tail of its output. You choose only which command (by index) or all of them; " +
      "you cannot add or change arguments. Any change the test run makes to the checkout is reverted " +
      `afterwards. ${describeList}`,
    promptSnippet: "Run the operator's configured test commands to verify a change",
    promptGuidelines: [
      "After changing code and before finish, call run_tests and report any failure honestly; if it says no test command is configured, say so in the hand-back.",
    ],
    parameters: RUN_TESTS_SCHEMA,
    // review r2/5: pi 1.1.0 runs one message's tool calls in parallel unless a
    // tool in the batch is sequential (pi-agent-core agent-loop.js
    // executeToolCalls). run_tests restores the checkout afterwards, so a
    // sibling write running beside it would be reverted; sequential makes pi
    // run the whole batch one call at a time. The guard's test window
    // (lib/guard.ts, review r2/5) is the second half, for anything this misses.
    executionMode: "sequential",
    execute(_toolCallId: string, params: Record<string, unknown>): Promise<Result> {
      const next = queue.then(() => run(params ?? {}));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

/** Register `run_tests`. It is a mutating tool (contract), not a declared writer: the gate sees it. */
export function register(pi: unknown, ctx: AssociateContext): void {
  const api = pi as { registerTool(definition: unknown): void };
  api.registerTool(createTestsTool(ctx));
}
