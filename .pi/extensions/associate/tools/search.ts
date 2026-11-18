/**
 * `find`, `grep` and `ls` — Pi's vendored `rg`/`fd` binaries with result caps.
 *
 * Task t6 (plan associate-on-pi-with-opinionated-tools, covers c20). These
 * three tools override Pi's built-ins by name (`.pi/settings.json` starts
 * with `defaultTools: []`, so nothing is overridden at runtime — this module
 * is what *provides* the names). Every path argument is confined to the
 * checkout with `confine()`, every pattern argument is checked with
 * `refusePatternEscape()`, every argument set is checked with `validateArgs()`
 * before anything runs, and every result list is capped at
 * `ctx.policy.caps.max_results` with a `truncated` marker — all from
 * `lib/contain.ts` (spec c29/c30/c21), never redefined here.
 *
 * No parameter schema imports `typebox`: a tool module is imported directly
 * off disk by `lib/runtime.ts`'s `loadToolModules`, in both the real pi
 * runtime and under `node --test` (`tests/extension.test.ts` exercises the
 * real `tools/` directory, unlike `tests/load-extension.ts`'s stubbed copy of
 * `index.ts`), so `typebox` is not resolvable here. The schemas below are
 * plain JSON Schema objects — draft 2020-12's `type`/`required`/`properties`
 * subset `validateArgs()` understands — which is exactly what `typebox`'s
 * `Type.Object` would produce anyway.
 *
 * Locating the vendored binaries: Pi keeps `rg` and `fd` under its agent
 * directory's `bin/` (pi-coding-agent's `getBinDir()` — measured against pi
 * 0.84.2, and unchanged on 1.1.0, in
 * `node_modules/@earendil-works/pi-coding-agent/dist/config.js` —
 * joins `getAgentDir()` with `"bin"`, and `getAgentDir()` prefers
 * `$PI_CODING_AGENT_DIR`, falling back to `~/.pi/agent`). This module mirrors
 * that resolution rather than hardcoding a home path: `$PI_CODING_AGENT_DIR`
 * first, `os.homedir()/.pi/agent` otherwise (both resolved at runtime, never
 * a literal on disk), and a bare `rg`/`fd` name — resolved against `PATH` by
 * `child_process.spawn` itself — when the vendored binary is not found there.
 *
 * Every spawn goes through `child_process.spawn(bin, argv)` with an explicit
 * `argv` array and `shell: false` — never `exec`, never `shell: true`, so no
 * code path here can hand model-supplied text to a shell. The spawn call is
 * made through an injectable `Spawner` so tests can assert on the exact
 * `(bin, argv, options)` triple without touching a real process.
 *
 * Two properties the caps depend on, both enforced by `runProcess` below:
 * output is consumed as a *stream* of lines and the child is killed the moment
 * the cap is reached (so a search's memory is bounded by the policy, not by the
 * size of the checkout), and a binary that cannot run at all comes back as a
 * structured `tool_missing`/`search_failed` result rather than a rejected
 * promise that would abort the whole tool call.
 */

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  confine,
  makeStructuredError,
  refusePatternEscape,
  validateArgs,
  type StructuredError,
} from "../lib/contain.ts";
import type { AssociateContext, ToolModule } from "../lib/context.ts";

// ---------------------------------------------------------------------------
// Locating rg / fd
// ---------------------------------------------------------------------------

/** The env var pi-coding-agent reads for its agent directory (`getAgentDir`). */
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export type BinaryName = "rg" | "fd";

/**
 * The vendored binaries directory, if it exists: `$PI_CODING_AGENT_DIR/bin`
 * when set, else `os.homedir()/.pi/agent/bin`. Returns `undefined` when
 * neither exists, so the caller falls back to a bare name on `PATH`.
 */
export function resolveAgentBinDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const agentDir = env[PI_AGENT_DIR_ENV] || join(homedir(), ".pi", "agent");
  const binDir = join(agentDir, "bin");
  return existsSync(binDir) ? binDir : undefined;
}

/**
 * Resolve *name* to an absolute path under the vendored bin dir when it is
 * there, else the bare name — left for `child_process.spawn` (and, through
 * it, the OS) to resolve against `PATH`.
 */
export function resolveBinary(name: BinaryName, env: NodeJS.ProcessEnv = process.env): string {
  const dir = resolveAgentBinDir(env);
  if (dir) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

// ---------------------------------------------------------------------------
// Spawning — argv array, never a shell
// ---------------------------------------------------------------------------

/**
 * What a bounded run produced.
 *
 * There is deliberately **no `stdout` string**: the point of this module's
 * collector is that the child's output is never accumulated in full. Callers
 * get already-split, already-bounded `lines`.
 */
export interface ProcessResult {
  /**
   * Complete, non-empty output lines: every line the child printed, until the
   * scan ceiling (`limits.maxTotalChars`). The caller caps what it shows; the
   * rest is how the true total is known and what is saved.
   */
  lines: string[];
  /** Bounded stderr — only ever used to build an error message. */
  stderr: string;
  /** Exit status, or `null` when the child was stopped early by a limit. */
  code: number | null;
  /** Set when a limit bit: the per-line bound or the scan ceiling. */
  truncated: boolean;
  /**
   * False when the scan ceiling stopped the run before the child finished, so
   * `lines.length` is a lower bound on the total, not the total.
   */
  complete: boolean;
}

/**
 * The bounds a run is held to. Every value is derived from the contract's
 * `policy.json` by {@link streamLimits} — no limit is a literal in this file.
 */
export interface StreamLimits {
  /** Maximum characters kept for any single line; the rest of that line is dropped. */
  maxLineChars: number;
  /** Hard ceiling on total buffered output characters: the scan stops (and the child is killed) there. */
  maxTotalChars: number;
}

/** The exact shape `child_process.spawn` has; tests inject a fake of this. */
export type Spawner = (
  bin: string,
  argv: string[],
  options: { cwd: string; shell: false },
) => ChildProcessWithoutNullStreams;

const defaultSpawner: Spawner = (bin, argv, options) =>
  nodeSpawn(bin, argv, { ...options, stdio: ["ignore", "pipe", "pipe"] });

/**
 * Run *bin* with *argv* (an array — never a shell string) confined to *cwd*,
 * streaming stdout line by line under *limits*. `shell: false` is passed
 * explicitly so no argument here is ever handed to a shell for interpretation.
 *
 * **Why streaming, and why a scan ceiling.** `rg` on a large tree, or `fd` on a
 * large checkout, can emit output orders of magnitude bigger than the
 * `max_results` cap the answer is cut to. The answer still says how many there
 * were (the true total) and the full list is saved, so output is split on
 * newlines as it arrives and every line is kept — but only up to a ceiling on
 * total buffered characters (`caps.max_raw_chars`). At the ceiling the child's
 * pipes are destroyed, it is sent `SIGTERM`, and the promise resolves with
 * `complete: false` — the total is then a lower bound, and the rest of that
 * output is never read, let alone stored. So the peak memory of a search is a
 * function of the policy, not of the repository.
 *
 * Two independent bounds, both from the contract (see {@link streamLimits}):
 * a per-line character bound, so a single pathological 10 MB line is clipped
 * to the budget and the remainder of that line is dropped without ever being
 * buffered; and the ceiling above. stderr is bounded by the same per-line budget.
 *
 * Rejects only when the child cannot run at all (a synchronous throw from
 * `spawn`, or the child's `error` event). Callers convert that into a
 * structured error — see {@link spawnFailure}.
 */
export function runProcess(
  bin: string,
  argv: string[],
  cwd: string,
  limits: StreamLimits,
  spawner: Spawner = defaultSpawner,
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawner(bin, argv, { cwd, shell: false });
    } catch (err) {
      reject(err as Error);
      return;
    }

    const lines: string[] = [];
    let pending = "";
    // True while the tail of an over-long line is being discarded, up to its
    // newline. `pending` then already holds the bounded prefix.
    let droppingOverlong = false;
    let bufferedChars = 0;
    let stderr = "";
    let truncated = false;
    let complete = true;
    let settled = false;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      // A final line with no trailing newline is still a result.
      if (pending.length > 0) lines.push(pending);
      resolvePromise({ lines, stderr, code, truncated, complete });
    };

    /** The ceiling bit: stop consuming, kill the child, answer with what we have. */
    const stopEarly = () => {
      truncated = true;
      complete = false;
      pending = "";
      try {
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
      } catch {
        /* an undestroyable stream is not a reason to fail the search */
      }
      try {
        child.kill?.("SIGTERM");
      } catch {
        /* the child may already be gone; nothing to do */
      }
      finish(null);
    };

    // Streaming decoders: a character split across two chunks is decoded whole.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const decode = (decoder: StringDecoder, chunk: Buffer | string) =>
      typeof chunk === "string" ? chunk : decoder.write(chunk);

    const onStdout = (decoded: string) => {
      if (settled) return;
      let text = decoded;
      while (text.length > 0) {
        const newline = text.indexOf("\n");
        if (newline === -1) {
          // No line terminator yet — buffer, but never past the per-line bound.
          if (!droppingOverlong) {
            const room = Math.max(limits.maxLineChars - pending.length, 0);
            if (text.length >= room) {
              pending += text.slice(0, room);
              droppingOverlong = true;
              truncated = true;
            } else {
              pending += text;
            }
          }
          return;
        }
        const segment = text.slice(0, newline);
        text = text.slice(newline + 1);

        let line: string;
        if (droppingOverlong) {
          line = pending;
          droppingOverlong = false;
        } else {
          const room = Math.max(limits.maxLineChars - pending.length, 0);
          if (segment.length > room) {
            line = pending + segment.slice(0, room);
            truncated = true;
          } else {
            line = pending + segment;
          }
        }
        pending = "";
        if (line.length === 0) continue; // blank lines are not results

        lines.push(line);
        bufferedChars += line.length;
        if (bufferedChars >= limits.maxTotalChars) {
          stopEarly();
          return;
        }
      }
    };
    child.stdout?.on("data", (chunk: Buffer | string) => onStdout(decode(stdoutDecoder, chunk)));

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = decode(stderrDecoder, chunk);
      if (settled || stderr.length >= limits.maxLineChars) return;
      stderr += text.slice(0, limits.maxLineChars - stderr.length);
    });

    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.on("close", (code: number | null) => {
      // Flush: bytes of a character the stream ended inside come out as U+FFFD.
      onStdout(stdoutDecoder.end());
      finish(code);
    });
  });
}

// ---------------------------------------------------------------------------
// A search binary that cannot run is an answer, not a crash
// ---------------------------------------------------------------------------

/** How to get each binary, when neither the vendored copy nor `PATH` has it. */
const INSTALL_HINT: Record<BinaryName, string> = {
  rg: "install ripgrep (which provides `rg`) on PATH",
  fd: "install fd (which provides `fd`; packaged as `fd-find` on some distributions) on PATH",
};

/**
 * Turn a spawn failure into a structured error the model can act on.
 *
 * `ENOENT` means the executable simply is not there — a `tool_missing` error
 * naming the binary and how to get it, the same degradation `_procs.ts`'s
 * `missingCliError` gives the wrapped CLIs. Anything else (a permission
 * problem, a bad interpreter, a resource limit) is a `search_failed`. Either
 * way the tool call returns a *result*; it never rejects, so one absent binary
 * cannot abort the tool call.
 */
export function spawnFailure(name: BinaryName, bin: string, err: unknown): StructuredError {
  const failure = err as NodeJS.ErrnoException | undefined;
  const detail = failure?.message ?? String(err);
  if (failure?.code === "ENOENT") {
    return makeStructuredError(
      "tool_missing",
      `${name} could not be executed (tried '${bin}'): ${detail}. pi vendors rg and fd in its ` +
        "agent bin directory ($PI_CODING_AGENT_DIR/bin, else the .pi/agent/bin under your home " +
        `directory); otherwise ${INSTALL_HINT[name]}. Nothing else in this session is affected.`,
    );
  }
  return makeStructuredError("search_failed", `${name} failed to start (tried '${bin}'): ${detail}`);
}

// ---------------------------------------------------------------------------
// Result capping (c20: cap at policy.caps.max_results, truncated marker)
// ---------------------------------------------------------------------------

export interface Capped<T> {
  items: T[];
  count: number;
  truncated: boolean;
}

/** Slice *items* to *cap*, reporting whether more existed. */
export function capResults<T>(items: T[], cap: number): Capped<T> {
  if (items.length <= cap) {
    return { items, count: items.length, truncated: false };
  }
  return { items: items.slice(0, cap), count: items.length, truncated: true };
}

function maxResultsCap(ctx: AssociateContext): number {
  const caps = (ctx.policy as { caps?: { max_results?: number } }).caps;
  return typeof caps?.max_results === "number" ? caps.max_results : 200;
}

interface PolicyShape {
  caps?: { max_results?: number; max_raw_chars?: number };
  budgets?: Record<string, { max_output_chars?: number } | undefined>;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The per-line character budget: `budgets.search.max_output_chars` if the
 * contract ever grows a search-specific budget, else the shell budget a
 * spawned-command's output is held to today. The final fallback is the read
 * budget — still the contract, never a number written here.
 */
function outputCharBudget(ctx: AssociateContext): number {
  const budgets = (ctx.policy as PolicyShape).budgets;
  return (
    positive(budgets?.search?.max_output_chars) ??
    positive(budgets?.shell?.max_output_chars) ??
    positive(budgets?.read?.max_output_chars) ??
    // No budget in the contract at all: fall back to the result cap's worth of
    // one budget-less line rather than inventing a size.
    maxResultsCap(ctx)
  );
}

/**
 * The hard ceiling on total buffered output: the contract's raw-character cap
 * when it declares one, else the product of the two bounds above — so the
 * ceiling is always *derived*, never a literal.
 */
function totalCharCeiling(ctx: AssociateContext, cap: number, lineChars: number): number {
  const caps = (ctx.policy as PolicyShape).caps;
  return positive(caps?.max_raw_chars) ?? (cap + 1) * lineChars;
}

/** The bounds one search run is held to, all read from the contract. */
function streamLimits(ctx: AssociateContext, cap: number): StreamLimits {
  const maxLineChars = outputCharBudget(ctx);
  return {
    maxLineChars,
    maxTotalChars: totalCharCeiling(ctx, cap, maxLineChars),
  };
}

// ---------------------------------------------------------------------------
// Argument schemas — plain JSON Schema, validated by lib/contain.ts's
// validateArgs (the draft-2020-12 subset associate/contract/validate.py
// supports: type, required, properties, items, enum, pattern).
// ---------------------------------------------------------------------------

/** The `purpose` argument: stated on every call, read by the harness, never by this tool's own logic. */
const PURPOSE_PROPERTY = {
  type: "string",
  description:
    "Why you are making this call: the question it settles and what you expect to see. " +
    "It is recorded with the call; it does not change what the tool does.",
};

const GREP_SCHEMA = {
  type: "object",
  required: ["pattern"],
  properties: {
    pattern: { type: "string", description: "Regex pattern to search for (rg syntax)." },
    path: { type: "string", description: "Directory or file to search, relative to the checkout root." },
    glob: { type: "string", description: "Optional glob restricting which files are searched." },
    case_insensitive: { type: "boolean", description: "Match case-insensitively." },
    purpose: PURPOSE_PROPERTY,
  },
};

const FIND_SCHEMA = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Regex pattern matched against file names (fd syntax)." },
    path: { type: "string", description: "Directory to search, relative to the checkout root." },
    purpose: PURPOSE_PROPERTY,
  },
};

const LS_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Directory to list, relative to the checkout root." },
    purpose: PURPOSE_PROPERTY,
  },
};

// ---------------------------------------------------------------------------
// What the walk is told (issue #20, plan t8): arguments as used, the true
// total, the saved full result
// ---------------------------------------------------------------------------

/** Names in `params` that the tool does not use (and is not the harness's `purpose`). */
function droppedArgs(params: unknown, used: readonly string[]): string[] {
  if (!params || typeof params !== "object") return [];
  return Object.keys(params as object).filter((key) => key !== "purpose" && !used.includes(key));
}

/** The result fields shared by grep, find and ls once a list has been capped. */
interface Listing {
  total: number;
  /** False when the scan ceiling stopped the count: `total` is then a lower bound. */
  total_exact: boolean;
  /** Characters of the full list (one line per item) the model was not shown. */
  not_shown_chars: number;
  /** Where the full list is saved, when anything was not shown. */
  spill_path?: string;
  args_used: Record<string, unknown>;
  dropped_args?: string[];
}

/**
 * Save the full list, one item per line, in the session scratch directory,
 * named by its hash so the same list is the same file. Nothing is saved when
 * nothing was hidden. A file that cannot be written leaves `spill_path` out:
 * the result still says how many were not shown.
 */
function saveFullList(ctx: AssociateContext, lines: readonly string[]): string | undefined {
  const body = `${lines.join("\n")}\n`;
  const dir = join(ctx.session.scratchDir, "search");
  const file = join(dir, `${createHash("sha256").update(body, "utf8").digest("hex")}.txt`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    // The same list already saved is the same file.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
  }
  return file;
}

function listing(
  ctx: AssociateContext,
  lines: readonly string[],
  cap: number,
  exact: boolean,
  used: Record<string, unknown>,
  params: unknown,
  usedKeys: readonly string[],
): Listing {
  const hidden = lines.slice(cap);
  const out: Listing = {
    total: lines.length,
    total_exact: exact,
    not_shown_chars: hidden.reduce((sum, line) => sum + line.length + 1, 0),
    args_used: used,
  };
  if (hidden.length > 0) {
    const saved = saveFullList(ctx, lines);
    if (saved !== undefined) out.spill_path = saved;
  }
  const dropped = droppedArgs(params, usedKeys);
  if (dropped.length > 0) out.dropped_args = dropped;
  return out;
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

export interface GrepParams {
  pattern?: unknown;
  path?: unknown;
  glob?: unknown;
  case_insensitive?: unknown;
}

export interface GrepSuccess extends Listing {
  ok: true;
  tool: "grep";
  pattern: string;
  path: string;
  matches: string[];
  /** How many matches are in `matches` (at most `cap`); `total` is how many there were. */
  count: number;
  cap: number;
  truncated: boolean;
}

export async function runGrep(
  ctx: AssociateContext,
  rawParams: unknown,
  spawner: Spawner = defaultSpawner,
): Promise<GrepSuccess | StructuredError> {
  const schemaError = validateArgs(GREP_SCHEMA, rawParams);
  if (schemaError) return schemaError;
  const params = rawParams as GrepParams;
  const pattern = params.pattern as string;

  const patternError = refusePatternEscape(pattern);
  if (patternError) return patternError;

  const relPath = typeof params.path === "string" && params.path.length > 0 ? params.path : ".";
  const confined = confine(ctx.checkoutRoot, relPath);
  if (!confined.ok) return confined;

  const argv = ["--line-number", "--no-heading", "--color", "never"];
  if (params.case_insensitive === true) argv.push("--ignore-case");
  if (typeof params.glob === "string" && params.glob.length > 0) argv.push("--glob", params.glob);
  argv.push("--", pattern, confined.path);

  const cap = maxResultsCap(ctx);
  const bin = resolveBinary("rg");
  let result: ProcessResult;
  try {
    result = await runProcess(bin, argv, ctx.checkoutRoot, streamLimits(ctx, cap), spawner);
  } catch (err) {
    // rg absent, or unable to start: a structured answer, never a rejected
    // tool call (a `--max-count` cap is per *file* in rg, so the streaming
    // cap above is what bounds the run; nothing to add to argv here).
    return spawnFailure("rg", bin, err);
  }

  // rg: 0 = matches found, 1 = no matches (not an error), 2+ = real error.
  if (result.code !== null && result.code > 1) {
    return makeStructuredError(
      "search_failed",
      `rg exited with code ${result.code}: ${result.stderr.trim() || "no error output"}`,
    );
  }

  const capped = capResults(result.lines, cap);
  const usedKeys = ["pattern", "path", "glob", "case_insensitive"];
  const used: Record<string, unknown> = { pattern, path: relPath };
  if (typeof params.glob === "string" && params.glob.length > 0) used.glob = params.glob;
  if (params.case_insensitive === true) used.case_insensitive = true;
  return {
    ok: true,
    tool: "grep",
    pattern,
    path: relPath,
    matches: capped.items,
    count: capped.items.length,
    cap,
    truncated: capped.truncated || result.truncated,
    ...listing(ctx, result.lines, cap, result.complete, used, rawParams, usedKeys),
  };
}

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

export interface FindParams {
  pattern?: unknown;
  path?: unknown;
}

export interface FindSuccess extends Listing {
  ok: true;
  tool: "find";
  pattern: string;
  path: string;
  matches: string[];
  /** As {@link GrepSuccess.count}: the returned count; `total` is how many there were. */
  count: number;
  cap: number;
  truncated: boolean;
}

export async function runFind(
  ctx: AssociateContext,
  rawParams: unknown,
  spawner: Spawner = defaultSpawner,
): Promise<FindSuccess | StructuredError> {
  const schemaError = validateArgs(FIND_SCHEMA, rawParams);
  if (schemaError) return schemaError;
  const params = rawParams as FindParams;
  // fd's pattern is a regex matched against file names; "." (any character)
  // is fd's own idiom for "match everything" when the caller wants a plain
  // directory listing rather than a name filter.
  const pattern = typeof params.pattern === "string" && params.pattern.length > 0 ? params.pattern : ".";

  const patternError = refusePatternEscape(pattern);
  if (patternError) return patternError;

  const relPath = typeof params.path === "string" && params.path.length > 0 ? params.path : ".";
  const confined = confine(ctx.checkoutRoot, relPath);
  if (!confined.ok) return confined;

  const cap = maxResultsCap(ctx);
  // No `--max-results`: the true total is reported, so fd runs to the end (or
  // to the collector's scan ceiling, which kills it).
  const argv = ["--color", "never", "--", pattern, confined.path];
  const bin = resolveBinary("fd");
  let result: ProcessResult;
  try {
    result = await runProcess(bin, argv, ctx.checkoutRoot, streamLimits(ctx, cap), spawner);
  } catch (err) {
    return spawnFailure("fd", bin, err);
  }

  if (result.code !== null && result.code > 1) {
    return makeStructuredError(
      "search_failed",
      `fd exited with code ${result.code}: ${result.stderr.trim() || "no error output"}`,
    );
  }

  const capped = capResults(result.lines, cap);
  return {
    ok: true,
    tool: "find",
    pattern,
    path: relPath,
    matches: capped.items,
    count: capped.items.length,
    cap,
    truncated: capped.truncated || result.truncated,
    ...listing(ctx, result.lines, cap, result.complete, { pattern, path: relPath }, rawParams, ["pattern", "path"]),
  };
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

export interface LsParams {
  path?: unknown;
}

export type EntryType = "file" | "directory" | "symlink" | "other";

export interface LsEntry {
  name: string;
  type: EntryType;
}

export interface LsSuccess extends Listing {
  ok: true;
  tool: "ls";
  path: string;
  entries: LsEntry[];
  count: number;
  cap: number;
  truncated: boolean;
}

function entryType(dirent: ReturnType<typeof readdirSync>[number]): EntryType {
  if (dirent.isSymbolicLink()) return "symlink";
  if (dirent.isDirectory()) return "directory";
  if (dirent.isFile()) return "file";
  return "other";
}

/**
 * List a confined directory's entries with their types.
 *
 * Reads the directory directly rather than spawning `ls`: pi's `ls` built-in
 * output isn't a stable machine-parseable contract across platforms, and a
 * directory listing is a call `fs.readdirSync` answers exactly, without a
 * subprocess. The bin-resolution and containment path is identical to
 * `grep`/`find`.
 */
export function runLs(ctx: AssociateContext, rawParams: unknown): LsSuccess | StructuredError {
  const schemaError = validateArgs(LS_SCHEMA, rawParams);
  if (schemaError) return schemaError;
  const params = rawParams as LsParams;
  const relPath = typeof params.path === "string" && params.path.length > 0 ? params.path : ".";

  const confined = confine(ctx.checkoutRoot, relPath);
  if (!confined.ok) return confined;

  let dirents: ReturnType<typeof readdirSync>;
  try {
    dirents = readdirSync(confined.path, { withFileTypes: true });
  } catch (err) {
    return makeStructuredError("ls_failed", `could not list '${relPath}': ${(err as Error).message}`, "path");
  }

  const entries: LsEntry[] = dirents
    .map((dirent) => ({ name: dirent.name, type: entryType(dirent) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const cap = maxResultsCap(ctx);
  const capped = capResults(entries, cap);
  return {
    ok: true,
    tool: "ls",
    path: relPath,
    entries: capped.items,
    count: capped.items.length,
    cap,
    truncated: capped.truncated,
    ...listing(
      ctx,
      entries.map((entry) => `${entry.name}\t${entry.type}`),
      cap,
      true,
      { path: relPath },
      rawParams,
      ["path"],
    ),
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function toToolResult(payload: { ok: boolean }) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: payload,
  };
}

export const register: ToolModule["register"] = (pi, ctx) => {
  const api = pi as {
    registerTool: (definition: Record<string, unknown>) => void;
  };

  api.registerTool({
    name: "grep",
    label: "Grep",
    description:
      "Search file contents under the checkout with rg (ripgrep). Results are capped at " +
      "the policy's max_results, with truncated:true when more matches exist.",
    promptSnippet: "Search file contents for a pattern",
    parameters: GREP_SCHEMA,
    async execute(_toolCallId: string, params: unknown) {
      return toToolResult(await runGrep(ctx, params));
    },
  });

  api.registerTool({
    name: "find",
    label: "Find",
    description:
      "Find files by name under the checkout with fd. Results are capped at the policy's " +
      "max_results, with truncated:true when more matches exist.",
    promptSnippet: "Find files by name",
    parameters: FIND_SCHEMA,
    async execute(_toolCallId: string, params: unknown) {
      return toToolResult(await runFind(ctx, params));
    },
  });

  api.registerTool({
    name: "ls",
    label: "List Directory",
    description:
      "List a directory's entries and their types, confined to the checkout. Entries are " +
      "capped at the policy's max_results, with truncated:true when more entries exist.",
    promptSnippet: "List a directory's entries",
    parameters: LS_SCHEMA,
    execute(_toolCallId: string, params: unknown) {
      return toToolResult(runLs(ctx, params));
    },
  });
};
