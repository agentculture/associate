/**
 * `ledger_append` and `ledger_list` — the pinned workledger wrapper.
 *
 * Both tools shell out (argv only, via `_procs.ts`) to the released
 * `workledger-cli` console script, `ledger`, and to exactly two of its verbs:
 * `ledger append <entry-json> --json` and `ledger list [filters] --json`. No
 * other verb of the CLI is ever spawned ({@link ALLOWED_VERBS}); the contract's
 * shell allowlist (`{"command":"ledger","subcommands":["append","list"]}`) is
 * checked at call time as well.
 *
 * Where the ledger lives. workledger defaults to `.workledger/ledger.jsonl` at
 * the git toplevel of its cwd, which here would be the repository under
 * examination: the ledger would be written into someone else's checkout.
 * So the file is pinned with `WORKLEDGER_PATH` in the child's environment
 * (`$ASSOCIATE_LEDGER_PATH` if set, else `$HOME/.workledger/associate.jsonl`),
 * the child's cwd is that file's directory and never the checkout, and a path
 * that is relative or resolves inside the checkout is refused. Unlike memory,
 * the ledger is evidence ABOUT the work done in the checkout; keeping it
 * outside the checkout means the thing being examined cannot edit (or be
 * polluted by) its own audit trail, and a branch checkout/clean cannot lose it.
 *
 * Identity. The `agent` field is filled by the extension from the active
 * model's registry key (`associate/<key>`), never from the model's arguments,
 * so one model cannot write entries as another. `id` and `timestamp` are not
 * caller-suppliable in workledger and are never sent.
 *
 * `ledger_append` mutates the ledger and is deliberately NOT declared a
 * non-writer (the CLEF gate sees it); `ledger_list` is a read and is.
 *
 * Node builtins only; no npm dependency.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { boundOutput, validateArgs, type Budget } from "../lib/contain.ts";
import type { AssociateContext } from "../lib/context.ts";
import { activeModelKey } from "../lib/prompt.ts";
import {
  engineForToolName,
  firstLine,
  fromContainError,
  noEngineError,
  parseJson,
  spawnArgv,
  toolError,
  toolResult,
  whichOnPath,
  type Spawn,
  type Which,
} from "./_procs.ts";

// ---------------------------------------------------------------------------
// Tool-local bounds. NOT policy values: they belong in associate/contract/
// (policy.json) and should move there; kept here, commented, until then.
// ---------------------------------------------------------------------------

/** Upper bound on `--limit` for `ledger_list`. */
export const MAX_LIST_LIMIT = 100;
/** Default `--limit` when the model gives none. */
export const DEFAULT_LIST_LIMIT = 20;
/** Longest `summary` accepted (the CLI itself has no cap; the ledger is read back into context). */
export const MAX_SUMMARY_CHARS = 500;
/** Longest `action` accepted. */
export const MAX_ACTION_CHARS = 80;
/** Most `refs` per entry. */
export const MAX_REFS = 20;
/** Longest single ref. */
export const MAX_REF_CHARS = 300;
/** Largest serialised `data` object accepted. */
export const MAX_DATA_CHARS = 2000;

/** The only workledger verbs this extension may spawn. */
export const ALLOWED_VERBS: readonly string[] = ["append", "list"];

/** Identity prefix for the `agent` field. */
const AGENT_PREFIX = "associate/";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export const LEDGER_APPEND_SCHEMA = {
  type: "object",
  required: ["action", "summary"],
  properties: {
    action: {
      type: "string",
      minLength: 1,
      maxLength: MAX_ACTION_CHARS,
      description: "Short verb phrase for what was done (e.g. edited, ran-tests, fetched).",
    },
    summary: {
      type: "string",
      minLength: 1,
      maxLength: MAX_SUMMARY_CHARS,
      description: "One line, no control characters, saying what was done and why.",
    },
    refs: {
      type: "array",
      items: { type: "string" },
      description: `Paths, URLs or ids the entry concerns (at most ${MAX_REFS}).`,
    },
    data: { type: "object", description: "Optional small structured detail." },
  },
} as const;

export const LEDGER_LIST_SCHEMA = {
  type: "object",
  properties: {
    agent: { type: "string", minLength: 1, description: "Only entries by this agent." },
    action: { type: "string", minLength: 1, description: "Only entries with this action." },
    since: { type: "string", minLength: 1, description: "Only entries at/after this ISO-8601 timestamp." },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_LIST_LIMIT,
      description: `Most recent N matching entries (default ${DEFAULT_LIST_LIMIT}, at most ${MAX_LIST_LIMIT}).`,
    },
  },
} as const;

export interface LedgerDeps {
  which?: Which;
  spawn?: Spawn;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/** Where the ledger lives: the operator's choice, else a per-agent home file. Never cwd. */
export function ledgerPath(env: Record<string, string | undefined>): string {
  const configured = env.ASSOCIATE_LEDGER_PATH;
  if (configured && configured.trim() !== "") return configured;
  return join(env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir(), ".workledger", "associate.jsonl");
}

/** `policy.budgets.ledger` when the contract has one, else the shell budget. */
function ledgerBudget(ctx: AssociateContext): Budget {
  const budgets = (ctx.policy.budgets ?? {}) as Record<string, Budget | undefined>;
  const budget = budgets.ledger ?? budgets.shell;
  if (!budget || typeof budget.max_output_chars !== "number") {
    throw new Error(
      "associate contract policy.budgets has no ledger or shell max_output_chars; " +
        "the ledger wrapper defines no budget of its own",
    );
  }
  return budget;
}

/** The console script `ledger` ships in the `workledger-cli` distribution, so the generic `<name>-cli` hint would be wrong. */
function missingLedgerError(binary: string) {
  const install = ["uv tool install workledger-cli"];
  return toolError(
    "tool_missing",
    `${binary} is not on PATH, so this tool is unavailable. Install it with: ${install.join(" && ")}. Nothing else in this session is affected.`,
    { binary, install, lookup: "PATH only; this tool never resolves an engine relative to the checkout" },
  );
}

type Result = { content: Array<{ type: "text"; text: string }>; details: unknown };

export interface LedgerTools {
  tools: Array<{
    name: string;
    label: string;
    description: string;
    promptSnippet: string;
    promptGuidelines: string[];
    parameters: unknown;
    execute(toolCallId: string, params: Record<string, unknown>): Promise<Result>;
  }>;
}

export function createLedgerTools(ctx: AssociateContext, deps: LedgerDeps = {}): LedgerTools {
  const env = deps.env ?? process.env;
  const which = deps.which ?? ((name: string) => whichOnPath(name, env));
  const spawn = deps.spawn ?? spawnArgv;

  function prepare(toolName: string, verb: string) {
    const engine = engineForToolName(ctx.policy, "ledger");
    if (!engine || !ALLOWED_VERBS.includes(verb) || !engine.subcommands.includes(verb)) {
      return { error: noEngineError(toolName, { verb }) };
    }
    const binary = which(engine.command);
    if (!binary) return { error: missingLedgerError(engine.command) };

    const file = ledgerPath(env);
    if (!isAbsolute(file)) {
      return {
        error: toolError(
          "bad_destination",
          "ASSOCIATE_LEDGER_PATH must be an absolute path; the ledger is never placed relative to the working directory.",
          { path: file },
        ),
      };
    }
    const resolved = resolve(file);
    if (ctx.contain.isInside(ctx.checkoutRoot, resolved)) {
      return {
        error: toolError(
          "bad_destination",
          "the ledger path is inside the checkout under examination; refusing to read or write there.",
          { path: resolved },
        ),
      };
    }
    const dir = dirname(resolved);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      return {
        error: toolError("bad_destination", `cannot create the ledger directory: ${(err as Error).message}`, { dir }),
      };
    }
    const childEnv = { ...env, WORKLEDGER_PATH: resolved } as NodeJS.ProcessEnv;
    return { binary, dir, childEnv };
  }

  /** Map a non-zero exit to a structured error. Exit 1 = user error, 2 = environment. */
  function failure(verb: string, proc: { code: number; stderr: string; timedOut?: boolean }) {
    let message = firstLine(proc.stderr);
    const parsed = parseJson(proc.stderr.trim()) as { message?: unknown; remediation?: unknown } | undefined;
    if (parsed && typeof parsed.message === "string") {
      message = parsed.message + (typeof parsed.remediation === "string" ? ` (${parsed.remediation})` : "");
    }
    const code = proc.code === 1 ? "ledger_user_error" : proc.code === 2 ? "ledger_env_error" : "ledger_failed";
    return toolResult(
      toolError(code, `ledger ${verb} exited ${proc.code}: ${message}`, {
        exit_code: proc.code,
        timed_out: proc.timedOut === true,
      }),
    );
  }

  const append = {
    name: "ledger_append",
    label: "Ledger Append",
    description:
      "Append one entry to associate's work ledger: what you did, in one line. The entry is attributed " +
      "to you automatically; you cannot set the agent, id or timestamp. The ledger lives outside the " +
      "repository you are examining.",
    promptSnippet: "Record an action in the work ledger",
    promptGuidelines: ["One line per action; summary has no newlines. Put detail in refs or data."],
    parameters: LEDGER_APPEND_SCHEMA,
    async execute(_id: string, rawParams: Record<string, unknown>): Promise<Result> {
      const invalid = validateArgs(LEDGER_APPEND_SCHEMA as Record<string, unknown>, rawParams ?? {});
      if (invalid) return toolResult(fromContainError(invalid));
      const params = (rawParams ?? {}) as { action: string; summary: string; refs?: string[]; data?: Record<string, unknown> };

      const bad = (field: string, message: string) =>
        toolResult(toolError("invalid_args", message, { field }));
      if (params.action.trim() === "" || params.action.length > MAX_ACTION_CHARS || CONTROL_CHARS.test(params.action)) {
        return bad("action", `action must be non-empty, single-line, at most ${MAX_ACTION_CHARS} characters`);
      }
      if (params.summary.trim() === "" || params.summary.length > MAX_SUMMARY_CHARS || CONTROL_CHARS.test(params.summary)) {
        return bad("summary", `summary must be non-empty, single-line, no control characters, at most ${MAX_SUMMARY_CHARS} characters`);
      }
      if (params.refs !== undefined) {
        if (params.refs.length > MAX_REFS || params.refs.some((r) => typeof r !== "string" || r.length > MAX_REF_CHARS)) {
          return bad("refs", `refs: at most ${MAX_REFS} strings of at most ${MAX_REF_CHARS} characters`);
        }
      }
      if (params.data !== undefined && JSON.stringify(params.data).length > MAX_DATA_CHARS) {
        return bad("data", `data must serialise to at most ${MAX_DATA_CHARS} characters`);
      }

      const prep = prepare("ledger_append", "append");
      if ("error" in prep) return toolResult(prep.error);

      // Identity comes from the active model, never from the arguments.
      const entry: Record<string, unknown> = {
        agent: `${AGENT_PREFIX}${activeModelKey(ctx.contract.models, env)}`,
        action: params.action,
        summary: params.summary,
      };
      if (params.refs !== undefined) entry.refs = params.refs;
      if (params.data !== undefined) entry.data = params.data;

      const proc = await spawn(prep.binary, ["append", JSON.stringify(entry), "--json"], {
        cwd: prep.dir,
        env: prep.childEnv,
        timeoutMs: deps.timeoutMs,
      });
      if (proc.code !== 0) return failure("append", proc);
      const stored = parseJson(proc.stdout);
      if (stored === undefined) {
        return toolResult(toolError("ledger_bad_output", "ledger append --json printed output that is not JSON", { exit_code: 0 }));
      }
      return toolResult({ ok: true, entry: stored });
    },
  };

  const list = {
    name: "ledger_list",
    label: "Ledger List",
    description:
      "List entries already in associate's work ledger, oldest first among the most recent N. Read-only. " +
      `At most ${MAX_LIST_LIMIT} entries; output is cut at the contract's output budget.`,
    promptSnippet: "Check what the work ledger already holds",
    promptGuidelines: [],
    parameters: LEDGER_LIST_SCHEMA,
    async execute(_id: string, rawParams: Record<string, unknown>): Promise<Result> {
      const invalid = validateArgs(LEDGER_LIST_SCHEMA as Record<string, unknown>, rawParams ?? {});
      if (invalid) return toolResult(fromContainError(invalid));
      const params = (rawParams ?? {}) as { agent?: string; action?: string; since?: string; limit?: number };
      const prep = prepare("ledger_list", "list");
      if ("error" in prep) return toolResult(prep.error);

      const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
      const argv = ["list"];
      if (params.agent) argv.push("--agent", params.agent);
      if (params.action) argv.push("--action", params.action);
      if (params.since) argv.push("--since", params.since);
      argv.push("--limit", String(limit), "--json");

      const proc = await spawn(prep.binary, argv, { cwd: prep.dir, env: prep.childEnv, timeoutMs: deps.timeoutMs });
      if (proc.code !== 0) return failure("list", proc);
      const entries = parseJson(proc.stdout);
      if (!Array.isArray(entries)) {
        return toolResult(toolError("ledger_bad_output", "ledger list --json did not print a JSON array", { exit_code: 0 }));
      }
      const bounded = boundOutput(JSON.stringify(entries), ledgerBudget(ctx), ctx.session.scratchDir);
      return {
        content: [{ type: "text" as const, text: bounded.text }],
        details: {
          ok: true,
          entries: bounded.truncated ? undefined : entries,
          count: entries.length,
          truncated: bounded.truncated,
          spill_path: bounded.spillPath,
          limit,
        },
      };
    },
  };

  return { tools: [append, list] };
}

/** Register both tools. `ledger_append` is a writer and is NOT declared otherwise. */
export function register(pi: unknown, ctx: AssociateContext): void {
  const api = pi as { registerTool(definition: unknown): void };
  const { tools } = createLedgerTools(ctx);
  ctx.declareNonWriter("ledger_list");
  for (const tool of tools) api.registerTool(tool);
}
