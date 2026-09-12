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
 * 0.84.2 in `node_modules/@earendil-works/pi-coding-agent/dist/config.js` —
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
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  /** Complete, non-empty output lines, at most `limits.maxLines` of them. */
  lines: string[];
  /** Bounded stderr — only ever used to build an error message. */
  stderr: string;
  /** Exit status, or `null` when the child was stopped early by a limit. */
  code: number | null;
  /** Set when a limit bit: the line cap, the per-line bound, or the total ceiling. */
  truncated: boolean;
}

/**
 * The bounds a run is held to. Every value is derived from the contract's
 * `policy.json` by {@link streamLimits} — no limit is a literal in this file.
 */
export interface StreamLimits {
  /** Stop consuming (and kill the child) once this many lines have arrived. */
  maxLines: number;
  /** Maximum characters kept for any single line; the rest of that line is dropped. */
  maxLineChars: number;
  /** Hard ceiling on total buffered output characters. */
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
 * **Why streaming rather than "collect everything, then cap".** `rg` on a large
 * tree, or `fd` on a large checkout, can emit output orders of magnitude bigger
 * than the `max_results` cap the answer is sliced to. Buffering all of it and
 * slicing afterwards makes the peak memory of a search a function of the
 * *repository*, not of the policy. So output is split on newlines as it
 * arrives, results are counted as they land, and the moment `limits.maxLines`
 * is reached the child's pipes are destroyed, it is sent `SIGTERM`, and the
 * promise resolves with `truncated: true` — the rest of that output is never
 * read, let alone stored.
 *
 * Three independent bounds, all from the contract (see {@link streamLimits}):
 * the line cap above; a per-line character bound, so a single pathological
 * 10 MB line is clipped to the budget and the remainder of that line is dropped
 * without ever being buffered; and a hard ceiling on total buffered characters.
 * stderr is bounded by the same per-line budget.
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
    let settled = false;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      // A final line with no trailing newline is still a result.
      if (pending.length > 0 && lines.length < limits.maxLines) lines.push(pending);
      resolvePromise({ lines, stderr, code, truncated });
    };

    /** A limit bit: stop consuming, kill the child, answer with what we have. */
    const stopEarly = () => {
      truncated = true;
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

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      let text = chunk.toString("utf8");
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
        if (lines.length >= limits.maxLines || bufferedChars >= limits.maxTotalChars) {
          stopEarly();
          return;
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (settled || stderr.length >= limits.maxLineChars) return;
      stderr += chunk.toString("utf8").slice(0, limits.maxLineChars - stderr.length);
    });

    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.on("close", (code: number | null) => finish(code));
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
    // One past the cap: enough to know the cap *bit* without consuming a line
    // more than that.
    maxLines: cap + 1,
    maxLineChars,
    maxTotalChars: totalCharCeiling(ctx, cap, maxLineChars),
  };
}

// ---------------------------------------------------------------------------
// Argument schemas — plain JSON Schema, validated by lib/contain.ts's
// validateArgs (the draft-2020-12 subset associate/contract/validate.py
// supports: type, required, properties, items, enum, pattern).
// ---------------------------------------------------------------------------

const GREP_SCHEMA = {
  type: "object",
  required: ["pattern"],
  properties: {
    pattern: { type: "string", description: "Regex pattern to search for (rg syntax)." },
    path: { type: "string", description: "Directory or file to search, relative to the checkout root." },
    glob: { type: "string", description: "Optional glob restricting which files are searched." },
    case_insensitive: { type: "boolean", description: "Match case-insensitively." },
  },
};

const FIND_SCHEMA = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Regex pattern matched against file names (fd syntax)." },
    path: { type: "string", description: "Directory to search, relative to the checkout root." },
  },
};

const LS_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", description: "Directory to list, relative to the checkout root." },
  },
};

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

export interface GrepParams {
  pattern?: unknown;
  path?: unknown;
  glob?: unknown;
  case_insensitive?: unknown;
}

export interface GrepSuccess {
  ok: true;
  tool: "grep";
  pattern: string;
  path: string;
  matches: string[];
  /**
   * How many matches are in `matches`. When `truncated` is true the search was
   * stopped at the cap, so the true total is deliberately *not* reported — it
   * was never counted, which is the whole point of stopping early.
   */
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
  return {
    ok: true,
    tool: "grep",
    pattern,
    path: relPath,
    matches: capped.items,
    count: capped.items.length,
    cap,
    truncated: capped.truncated || result.truncated,
  };
}

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

export interface FindParams {
  pattern?: unknown;
  path?: unknown;
}

export interface FindSuccess {
  ok: true;
  tool: "find";
  pattern: string;
  path: string;
  matches: string[];
  /** As {@link GrepSuccess.count}: the returned count, not a total, once truncated. */
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
  // Unlike rg's per-file `--max-count`, fd's `--max-results` is a whole-run
  // cap, so the bound is pushed down into the binary as well as enforced by
  // the streaming collector. One past the cap, so `truncated` still reports
  // honestly when more existed.
  const argv = ["--color", "never", "--max-results", String(cap + 1), "--", pattern, confined.path];
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

export interface LsSuccess {
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
    count: capped.count,
    cap,
    truncated: capped.truncated,
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
