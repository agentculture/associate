/**
 * Spawning a PATH CLI, and the typed errors the wrappers return.
 *
 * Shared by `tools/codelens.ts` and `tools/web.ts`, the two tools that wrap an
 * external CLI rather than implementing the work themselves (spec: "Pi tools
 * wrap those CLIs rather than re-implementing repo profiling or guarded web
 * fetch"). The leading underscore keeps `lib/runtime.ts`'s module discovery
 * from treating this file as a tool module — it exports no `register`.
 *
 * Three rules are enforced here rather than restated in each wrapper:
 *
 *   1. **PATH lookup only.** {@link whichOnPath} refuses a name carrying a path
 *      separator and skips every non-absolute `$PATH` entry, so no engine is
 *      ever resolved relative to the checkout under examination — the failure
 *      mode the webglass/code-lens spec records in the upstream code-lens-cli
 *      wrappers (they resolve the engine four levels above the script).
 *   2. **argv, never a shell.** {@link spawnArgv} goes through `execFile` with
 *      `shell: false`, so no model-supplied text ever reaches `/bin/sh`
 *      (spec c35).
 *   3. **A missing CLI is a structured install hint, not a crash** — the
 *      `tool_missing` error below names the complete install path, matching
 *      the ask-colleague optional-prerequisite precedent.
 *
 * Node builtins only; no npm dependency (spec c44).
 */

import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { StructuredError } from "../lib/contain.ts";

// ---------------------------------------------------------------------------
// The typed error object
// ---------------------------------------------------------------------------

/**
 * The error shape both wrappers return.
 *
 * `{ ok: false, error: { code, kind, message, detail } }`, with `code` /
 * `kind` / `message` / `detail` mirrored at the top level so a caller can
 * destructure either way — the same mirroring `lib/contain.ts`'s
 * `makeStructuredError` does. `kind` is an alias of `code`: the plan's
 * acceptance criterion names `kind`, the error contract names `code`, and one
 * object satisfies both rather than forcing a reader to know which word won.
 *
 * `detail` never carries page text. A denied, failed or paywalled fetch hands
 * back provenance (the URL, the status, the rule that denied it) and nothing
 * the remote server authored.
 */
export interface ToolError {
  ok: false;
  error: { code: string; kind: string; message: string; detail: Record<string, unknown> };
  code: string;
  kind: string;
  message: string;
  detail: Record<string, unknown>;
}

/** Build a {@link ToolError}. */
export function toolError(
  code: string,
  message: string,
  detail: Record<string, unknown> = {},
): ToolError {
  const error = { code, kind: code, message, detail };
  return { ok: false, error, code, kind: code, message, detail };
}

/**
 * Re-shape a `lib/contain.ts` structured error (argument validation, path
 * confinement, pattern escape) into the wrapper's error object, so a tool
 * result has one shape whatever refused it.
 */
export function fromContainError(
  err: StructuredError,
  detail: Record<string, unknown> = {},
): ToolError {
  const merged = { ...detail };
  if (err.error.field !== undefined) merged.field = err.error.field;
  return toolError(err.error.code, err.error.message, merged);
}

/** Render an error (or any result) as the pi tool result a wrapper returns. */
export function toolResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: payload,
  };
}

// ---------------------------------------------------------------------------
// Which engine may run — read from the contract, never named here
// ---------------------------------------------------------------------------

/**
 * One entry of `policy.shell.allowlist`.
 *
 * The executable names live in `policy.json` and in no TypeScript file: the
 * contract decides which binaries this extension may spawn, and a wrapper that
 * spelled its engine's name here would have quietly taken that decision back
 * (spec c46 — `contract.test.ts` enforces it).
 */
export interface AllowlistEntry {
  command: string;
  subcommands: string[];
}

export function shellAllowlist(policy: Record<string, unknown>): AllowlistEntry[] {
  const shell = policy.shell;
  const list =
    shell && typeof shell === "object" ? (shell as { allowlist?: unknown }).allowlist : undefined;
  if (!Array.isArray(list)) return [];
  return list
    .filter((entry): entry is { command: string; subcommands?: unknown } =>
      Boolean(entry && typeof entry === "object" && typeof (entry as AllowlistEntry).command === "string"),
    )
    .map((entry) => ({
      command: entry.command,
      subcommands: Array.isArray(entry.subcommands) ? (entry.subcommands as string[]) : [],
    }));
}

/**
 * The allowlisted engine a tool drives, found by the tool's own name:
 * `code_lens` → the allowlist entry whose command is `code-lens`.
 *
 * The mapping is mechanical (underscores are the only thing a tool name may
 * not share with an executable name), so the contract still names the binary.
 */
export function engineForToolName(
  policy: Record<string, unknown>,
  toolName: string,
): AllowlistEntry | null {
  const wanted = toolName.split("_").join("-");
  return shellAllowlist(policy).find((entry) => entry.command === wanted) ?? null;
}

/**
 * The allowlisted engine able to run every one of *verbs*.
 *
 * How the web wrapper finds its engine: `policy.web.registered_verbs` says
 * which verbs the read-only surface exposes, and exactly one allowlist entry
 * sanctions them — so the contract names both the binary and what it may do.
 */
export function engineForVerbs(
  policy: Record<string, unknown>,
  verbs: readonly string[],
): AllowlistEntry | null {
  if (verbs.length === 0) return null;
  return (
    shellAllowlist(policy).find((entry) => verbs.every((verb) => entry.subcommands.includes(verb))) ??
    null
  );
}

/** The contract sanctions no engine for this tool — a configuration answer, not a crash. */
export function noEngineError(toolLabel: string, detail: Record<string, unknown> = {}): ToolError {
  return toolError(
    "tool_unavailable",
    `the contract's shell allowlist sanctions no engine for ${toolLabel}, so this tool cannot ` +
      "run. Add the command to policy.shell.allowlist in the associate contract.",
    { ...detail, source: "policy.shell.allowlist" },
  );
}

// ---------------------------------------------------------------------------
// Install hints
// ---------------------------------------------------------------------------

/**
 * The install path for a wrapped CLI: its PyPI distribution is the binary name
 * with a `-cli` suffix, installed as a uv tool. *extra* carries the steps a
 * particular engine needs beyond that — the one-time Playwright Chromium
 * download webglass needs, which an install hint naming only the uv step would
 * leave out, giving an installed tool that cannot open a page.
 */
export function installSteps(binary: string, extra: readonly string[] = []): string[] {
  return [`uv tool install ${binary}-cli`, ...extra];
}

/**
 * The `tool_missing` error returned when the CLI is absent from `$PATH`.
 *
 * Degradation, not failure: the rest of the harness keeps working and the
 * model is told exactly how to make this tool available.
 */
export function missingCliError(binary: string, extra: readonly string[] = []): ToolError {
  const steps = installSteps(binary, extra);
  return toolError(
    "tool_missing",
    `${binary} is not on PATH, so this tool is unavailable. Install it with: ` +
      `${steps.join(" && ")}. Nothing else in this session is affected.`,
    {
      binary,
      install: steps,
      // Say plainly why no fallback was tried: a checkout-relative engine is
      // refused by design, so "it is not installed" is the whole story.
      lookup: "PATH only; this tool never resolves an engine relative to the checkout",
    },
  );
}

// ---------------------------------------------------------------------------
// PATH lookup
// ---------------------------------------------------------------------------

export type Which = (name: string) => string | null;

/**
 * Find *name* on `$PATH`, or return `null`.
 *
 * A name containing a path separator is refused outright, and a `$PATH` entry
 * that is empty or relative (`""`, `.`, `bin`) is skipped: both are ways for
 * the process's working directory — the checkout under examination — to supply
 * the executable, which is exactly what must never happen.
 */
export function whichOnPath(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (name.includes("/") || name.includes("\\")) return null;
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (!entry || !isAbsolute(entry)) continue;
    const candidate = join(entry, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

export interface ProcResult {
  /** Exit status; 124 when the child was killed for exceeding its timeout. */
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the child was killed rather than exiting on its own. */
  timedOut?: boolean;
}

export interface SpawnOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export type Spawn = (
  file: string,
  args: readonly string[],
  options?: SpawnOptions,
) => Promise<ProcResult>;

/** Default per-call wall clock, in ms. A wrapped CLI that hangs must not hang the run. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Run *file* with *args* as an argv list — no shell, no interpolation.
 *
 * Resolves rather than rejects on a non-zero exit: a wrapped CLI's failure is
 * data the wrapper classifies (webglass reports a policy denial with exit 1
 * and a complete JSON body on stdout), not an exception.
 */
export function spawnArgv(
  file: string,
  args: readonly string[],
  options: SpawnOptions = {},
): Promise<ProcResult> {
  return new Promise((resolvePromise) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: options.maxBytes ?? 8 * 1024 * 1024,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        env: options.env,
      },
      (err, stdout, stderr) => {
        const failure = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        let code = 0;
        let timedOut = false;
        if (failure) {
          if (failure.killed || failure.code === "ETIMEDOUT") {
            code = 124;
            timedOut = true;
          } else if (typeof failure.code === "number") {
            code = failure.code;
          } else {
            code = 1;
          }
        }
        const result: ProcResult = { code, stdout: stdout ?? "", stderr: stderr ?? "" };
        if (timedOut) result.timedOut = true;
        resolvePromise(result);
      },
    );
  });
}

/** Parse *text* as JSON, returning `undefined` rather than throwing. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** First line of *text*, trimmed and length-capped — safe to put in an error message. */
export function firstLine(text: string, max = 400): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}
