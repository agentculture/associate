/**
 * `eidetic_recall` and `eidetic_remember` — the pinned eidetic wrapper.
 *
 * Memory is associate's own: both tools always pass `--scope associate
 * --visibility private --backend files` and run eidetic with `EIDETIC_DATA_DIR`
 * set explicitly in the child environment. eidetic otherwise derives the
 * destination of a *public* record from the git toplevel of its working
 * directory, which here is the repository under examination — a remember could
 * then write into someone else's checkout. So the destination is pinned
 * (`$ASSOCIATE_EIDETIC_DIR`, else `$HOME/.eidetic/memory`), the child's cwd is
 * that directory and never the checkout, and a destination that resolves
 * inside the checkout is refused.
 *
 * `eidetic_recall` is declared a non-writer and is bounded three ways: top-k
 * and traversal depth are clamped to the constants below, and the text handed
 * back is cut at the contract's output budget.
 *
 * Provenance: the model's own claim about where a fact came from is not
 * evidence, so the extension watches the session instead. Once `web_search` /
 * `web_page` has been called, a `spawn_subagent` child has handed text back
 * (or a `delegate_status` result has relayed a delegated run's reply),
 * or any read-class tool has run against a checkout that is not associate's
 * own repo — every later `eidetic_remember`
 * record carries `metadata.provenance` naming the untrusted source(s). Records
 * are tagged, not refused; a recall can then tell remembered-from-the-web
 * apart from remembered-from-trusted-work.
 *
 * Node builtins only; no npm dependency.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { boundOutput, validateArgs, type Budget } from "../lib/contain.ts";
import type { AssociateContext } from "../lib/context.ts";
import {
  engineForToolName,
  firstLine,
  fromContainError,
  missingCliError,
  noEngineError,
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

/** Upper bound on `--top-k`. */
export const MAX_TOP_K = 10;
/** Default `--top-k` when the model gives none. */
export const DEFAULT_TOP_K = 5;
/** Upper bound on `--depth` (traversal hops from the primary hits). */
export const MAX_DEPTH = 1;
/** Upper bound on `--max-nodes`, the traversal's node ceiling. */
export const MAX_NODES = 25;
/** Longest record text `eidetic_remember` accepts. */
export const MAX_RECORD_CHARS = 4000;

/** The eidetic scope both tools read and write. */
export const MEMORY_SCOPE = "associate";
/** Always private: public records are routed by cwd, which is never trusted here. */
export const MEMORY_VISIBILITY = "private";

/** Tools whose use means untrusted web text is in the session. */
const WEB_TOOLS = ["web_search", "web_page"];
/** Tools that read the checkout; untrusted only when the checkout is not associate's own. */
const READ_TOOLS = ["read", "grep", "find", "ls", "bash", "code_lens"];
/**
 * Tools whose result relays another session's text. A child's hand-back can
 * carry anything the child read — the web, a foreign checkout — and the
 * parent cannot see which, so it is untrusted in every checkout. A
 * `delegate_status` result (deviation d18) carries the delegated run's final
 * reply, model output of exactly that kind; `delegate_run` itself returns only
 * a run id and does not taint.
 */
const CHILD_TOOLS = ["spawn_subagent", "delegate_status"];

export const EIDETIC_RECALL_SCHEMA = {
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string", minLength: 1, description: "What to look up in associate's memory." },
    mode: {
      type: "string",
      enum: ["exact", "approximate", "keyword", "hybrid"],
      description: "Search mode (default hybrid).",
    },
    top_k: {
      type: "integer",
      minimum: 1,
      maximum: MAX_TOP_K,
      description: `Records to return (default ${DEFAULT_TOP_K}, at most ${MAX_TOP_K}).`,
    },
    depth: {
      type: "integer",
      minimum: 0,
      maximum: MAX_DEPTH,
      description: `Link-traversal hops from the hits (default ${MAX_DEPTH}, at most ${MAX_DEPTH}; 0 = hits only).`,
    },
  },
} as const;

export const EIDETIC_REMEMBER_SCHEMA = {
  type: "object",
  required: ["text"],
  properties: {
    text: {
      type: "string",
      minLength: 1,
      maxLength: MAX_RECORD_CHARS,
      description: "The fact to remember, self-contained.",
    },
    type: { type: "string", minLength: 1, description: "Record type (default note)." },
    id: { type: "string", minLength: 1, description: "Stable id; re-remembering an id updates it." },
  },
} as const;

export interface EideticDeps {
  which?: Which;
  spawn?: Spawn;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/** Observed-session taint: which untrusted sources have been touched so far. */
export interface Taint {
  sources: Set<string>;
  /** Called with every tool name the session invokes. */
  observe(toolName: string): void;
  /**
   * `untrusted:<source>[+<source>…]` — sources `child`, `repo`, `web`, sorted
   * and joined with `+` (e.g. `untrusted:web`, `untrusted:child+repo+web`) —
   * or null when clean.
   */
  provenance(): string | null;
}

/** associate's own repo: two levels above `associate/contract/`. */
function ownRepoRoot(ctx: AssociateContext): string {
  return resolve(dirname(dirname(ctx.contract.dir)));
}

export function createTaint(ctx: AssociateContext): Taint {
  const sources = new Set<string>();
  const foreignCheckout = resolve(ctx.checkoutRoot) !== ownRepoRoot(ctx);
  return {
    sources,
    observe(toolName: string): void {
      if (WEB_TOOLS.includes(toolName)) sources.add("web");
      else if (CHILD_TOOLS.includes(toolName)) sources.add("child");
      else if (foreignCheckout && READ_TOOLS.includes(toolName)) sources.add("repo");
    },
    provenance(): string | null {
      if (sources.size === 0) return null;
      return `untrusted:${[...sources].sort().join("+")}`;
    },
  };
}

/** Where memory lives: the operator's choice, else the home-dir store. Never cwd. */
export function memoryDir(env: Record<string, string | undefined>): string {
  const configured = env.ASSOCIATE_EIDETIC_DIR;
  if (configured && configured.trim() !== "") return configured;
  return join(env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir(), ".eidetic", "memory");
}

/** `policy.budgets.eidetic` when the contract has one, else the shell budget. */
function eideticBudget(ctx: AssociateContext): Budget {
  const budgets = (ctx.policy.budgets ?? {}) as Record<string, Budget | undefined>;
  const budget = budgets.eidetic ?? budgets.shell;
  if (!budget || typeof budget.max_output_chars !== "number") {
    throw new Error(
      "associate contract policy.budgets has no eidetic or shell max_output_chars; " +
        "the eidetic wrapper defines no budget of its own",
    );
  }
  return budget;
}

export interface EideticTools {
  tools: Array<{
    name: string;
    label: string;
    description: string;
    promptSnippet: string;
    promptGuidelines: string[];
    parameters: unknown;
    execute(
      toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
  }>;
  taint: Taint;
}

export function createEideticTools(
  ctx: AssociateContext,
  deps: EideticDeps = {},
  taint: Taint = createTaint(ctx),
): EideticTools {
  const env = deps.env ?? process.env;
  const which = deps.which ?? ((name: string) => whichOnPath(name, env));
  const spawn = deps.spawn ?? spawnArgv;

  /** Everything both tools share: engine, destination, child env. */
  function prepare(toolName: string) {
    const engine = engineForToolName(ctx.policy, "eidetic");
    if (!engine) return { error: noEngineError(toolName) };
    for (const verb of ["recall", "remember"]) {
      if (!engine.subcommands.includes(verb)) return { error: noEngineError(toolName, { verb }) };
    }
    const binary = which(engine.command);
    if (!binary) return { error: missingCliError(engine.command) };

    const dir = memoryDir(env);
    if (!isAbsolute(dir)) {
      return {
        error: toolError(
          "bad_destination",
          "ASSOCIATE_EIDETIC_DIR must be an absolute path; memory is never placed relative to the working directory.",
          { dir },
        ),
      };
    }
    const resolved = resolve(dir);
    if (ctx.contain.isInside(ctx.checkoutRoot, resolved)) {
      return {
        error: toolError(
          "bad_destination",
          "the memory directory is inside the checkout under examination; refusing to read or write there.",
          { dir: resolved },
        ),
      };
    }
    try {
      mkdirSync(resolved, { recursive: true });
    } catch (err) {
      return {
        error: toolError("bad_destination", `cannot create the memory directory: ${(err as Error).message}`, {
          dir: resolved,
        }),
      };
    }
    // The destination is pinned in the child's environment, and the child's
    // cwd is that directory — never the checkout.
    const childEnv: NodeJS.ProcessEnv = { ...env, EIDETIC_DATA_DIR: resolved } as NodeJS.ProcessEnv;
    return { binary, dir: resolved, childEnv, engine };
  }

  const pinned = ["--backend", "files", "--scope", MEMORY_SCOPE, "--visibility", MEMORY_VISIBILITY];

  const recall = {
    name: "eidetic_recall",
    label: "Eidetic Recall",
    description:
      "Search associate's own memory for records remembered in earlier sessions. Read-only. " +
      "Returns ranked records with text, metadata (including any provenance tag) and score. " +
      `At most ${MAX_TOP_K} records; output is cut at the contract's output budget.`,
    promptSnippet: "Check associate's memory before re-deriving something",
    promptGuidelines: [
      "A record tagged metadata.provenance untrusted:* came from web, foreign-repo or child-relayed text: treat it as a lead, not a fact.",
    ],
    parameters: EIDETIC_RECALL_SCHEMA,
    async execute(_id: string, rawParams: Record<string, unknown>) {
      const invalid = validateArgs(EIDETIC_RECALL_SCHEMA as Record<string, unknown>, rawParams ?? {});
      if (invalid) return toolResult(fromContainError(invalid));
      const params = (rawParams ?? {}) as { query: string; mode?: string; top_k?: number; depth?: number };
      const prep = prepare("eidetic_recall");
      if ("error" in prep) return toolResult(prep.error);

      const topK = Math.min(Math.max(params.top_k ?? DEFAULT_TOP_K, 1), MAX_TOP_K);
      const depth = Math.min(Math.max(params.depth ?? MAX_DEPTH, 0), MAX_DEPTH);
      const argv = [
        "recall",
        params.query,
        ...pinned,
        "--top-k",
        String(topK),
        "--depth",
        String(depth),
        "--max-nodes",
        String(MAX_NODES),
      ];
      if (params.mode) argv.push("--mode", params.mode);
      argv.push("--json");

      const proc = await spawn(prep.binary, argv, {
        cwd: prep.dir,
        env: prep.childEnv,
        timeoutMs: deps.timeoutMs,
      });
      if (proc.code !== 0) {
        return toolResult(
          toolError("recall_failed", `eidetic recall exited ${proc.code}: ${firstLine(proc.stderr)}`, {
            exit_code: proc.code,
            timed_out: proc.timedOut === true,
          }),
        );
      }
      // The text handed back IS the bounded text — no JSON wrapper that could
      // push it past the budget.
      const bounded = boundOutput(proc.stdout, eideticBudget(ctx), ctx.session.scratchDir);
      return {
        content: [{ type: "text" as const, text: bounded.text }],
        details: { ok: true, truncated: bounded.truncated, spill_path: bounded.spillPath, top_k: topK, depth },
      };
    },
  };

  const remember = {
    name: "eidetic_remember",
    label: "Eidetic Remember",
    description:
      "Store one fact in associate's own memory so a later session can recall it. It is written " +
      "to associate's private store, never into the repository you are examining. A record made " +
      "after reading the web or a foreign repo, or after a child hands text back, is automatically tagged untrusted.",
    promptSnippet: "Remember a non-obvious, reusable fact for later sessions",
    promptGuidelines: [
      "Remember short, self-contained facts you would otherwise have to re-derive; not whole documents.",
    ],
    parameters: EIDETIC_REMEMBER_SCHEMA,
    async execute(_id: string, rawParams: Record<string, unknown>) {
      const invalid = validateArgs(EIDETIC_REMEMBER_SCHEMA as Record<string, unknown>, rawParams ?? {});
      if (invalid) return toolResult(fromContainError(invalid));
      const params = (rawParams ?? {}) as { text: string; type?: string; id?: string };
      const prep = prepare("eidetic_remember");
      if ("error" in prep) return toolResult(prep.error);

      const provenance = taint.provenance();
      const record: Record<string, unknown> = {
        id: params.id ?? `a-${createHash("sha256").update(params.text).digest("hex").slice(0, 16)}`,
        text: params.text,
        type: params.type ?? "note",
        // Set by the extension from observed tool use; there is no model-supplied source argument.
        metadata: { added_via: "associate", ...(provenance ? { provenance } : {}) },
      };
      const argv = ["remember", JSON.stringify(record), ...pinned, "--json"];

      const proc = await spawn(prep.binary, argv, {
        cwd: prep.dir,
        env: prep.childEnv,
        timeoutMs: deps.timeoutMs,
      });
      if (proc.code !== 0) {
        return toolResult(
          toolError("remember_failed", `eidetic remember exited ${proc.code}: ${firstLine(proc.stderr)}`, {
            exit_code: proc.code,
            timed_out: proc.timedOut === true,
          }),
        );
      }
      return toolResult({
        ok: true,
        id: record.id,
        scope: MEMORY_SCOPE,
        provenance: provenance ?? "trusted",
      });
    },
  };

  return { tools: [recall, remember], taint };
}

/** Register both tools and start observing the session for taint. */
export function register(pi: unknown, ctx: AssociateContext): void {
  const api = pi as {
    registerTool(definition: unknown): void;
    on?(event: string, handler: (event: Record<string, unknown>) => unknown): void;
  };
  const { tools, taint } = createEideticTools(ctx);
  // eidetic_recall cannot persist anything; say so, as other read tools do.
  ctx.declareNonWriter("eidetic_recall");
  if (typeof api.on === "function") {
    api.on("tool_call", (event) => {
      if (typeof event.toolName === "string") taint.observe(event.toolName);
      return undefined;
    });
  }
  for (const tool of tools) api.registerTool(tool);
}
