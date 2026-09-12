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

export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
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
 * and collect stdout/stderr. `shell: false` is passed explicitly so no
 * argument here is ever handed to a shell for interpretation.
 */
export function runProcess(
  bin: string,
  argv: string[],
  cwd: string,
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
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err: Error) => reject(err));
    child.on("close", (code: number | null) => resolvePromise({ stdout, stderr, code }));
  });
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

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
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

  const bin = resolveBinary("rg");
  const result = await runProcess(bin, argv, ctx.checkoutRoot, spawner);

  // rg: 0 = matches found, 1 = no matches (not an error), 2+ = real error.
  if (result.code !== null && result.code > 1) {
    return makeStructuredError(
      "search_failed",
      `rg exited with code ${result.code}: ${result.stderr.trim() || "no error output"}`,
    );
  }

  const cap = maxResultsCap(ctx);
  const capped = capResults(nonEmptyLines(result.stdout), cap);
  return {
    ok: true,
    tool: "grep",
    pattern,
    path: relPath,
    matches: capped.items,
    count: capped.count,
    cap,
    truncated: capped.truncated,
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

  const argv = ["--color", "never", "--", pattern, confined.path];
  const bin = resolveBinary("fd");
  const result = await runProcess(bin, argv, ctx.checkoutRoot, spawner);

  if (result.code !== null && result.code > 1) {
    return makeStructuredError(
      "search_failed",
      `fd exited with code ${result.code}: ${result.stderr.trim() || "no error output"}`,
    );
  }

  const cap = maxResultsCap(ctx);
  const capped = capResults(nonEmptyLines(result.stdout), cap);
  return {
    ok: true,
    tool: "find",
    pattern,
    path: relPath,
    matches: capped.items,
    count: capped.count,
    cap,
    truncated: capped.truncated,
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
