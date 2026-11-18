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
 * Source reference (issue #20, plan t15): `eidetic_remember` takes an optional
 * `source` (a walk id such as `w12`, or a labelled one such as `run-3:w12`, the
 * form `facts.schema.json` allows) and an optional `quote`. A bare walk id is
 * checked against the ids this run's walk has issued; a labelled one by
 * pattern only. They are written, with the session id, into the record's
 * metadata. A quote given with a current-run reference is checked by the
 * merged matcher against the saved result and the verdict is stored beside it:
 * a failed quote is recorded, not refused. The `purpose` argument is accepted
 * and never stored. The taint tag above is unchanged.
 *
 * Node builtins only; no npm dependency.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { boundOutput, validateArgs, type Budget } from "../lib/contain.ts";
import type { AssociateContext } from "../lib/context.ts";
import { checkQuote } from "../lib/matcher.ts";
import { loadSavedResult } from "../lib/results.ts";
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

/** A current-run source: a walk id. */
const CURRENT_RUN_SOURCE = /^w[1-9][0-9]*$/;
/** Any source `facts.schema.json` allows: an optional label, then a walk id. */
const SOURCE_PATTERN = /^([A-Za-z0-9_-]+:)?w[1-9][0-9]*$/;

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
    purpose: { type: "string", description: "Why you are looking this up and what you expect to find." },
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
    source: {
      type: "string",
      description:
        "Optional: where the fact came from, the walk id of the call whose result shows it (for example w12). Never a path.",
    },
    quote: {
      type: "string",
      maxLength: MAX_RECORD_CHARS,
      description: "Optional: the exact text of that result which shows the fact. Needs source.",
    },
    purpose: { type: "string", description: "Why you are storing this." },
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

/** Names of arguments the call carried that the tool's schema does not define. */
function droppedArgs(schema: { properties: Record<string, unknown> }, raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  return Object.keys(raw as Record<string, unknown>).filter((k) => !(k in schema.properties));
}

/** The walk ids this run has issued, when a recorder is attached and can say. */
function issuedWalkIds(ctx: AssociateContext): string[] {
  const walk = ctx.walk() as unknown as { entryIds?: () => string[] } | undefined;
  return typeof walk?.entryIds === "function" ? walk.entryIds() : [];
}

/**
 * The source/quote/session-id metadata for a record, or a refusal with a fix.
 * Nothing is added when no source was given.
 */
function referenceMetadata(
  ctx: AssociateContext,
  source: string | undefined,
  quote: string | undefined,
): { metadata: Record<string, unknown> } | { error: ReturnType<typeof toolError> } {
  if (source === undefined) {
    if (quote === undefined) return { metadata: {} };
    return {
      error: toolError(
        "quote_without_source",
        "a quote was given without the source it comes from",
        { field: "quote" },
        "pass source, the walk id of the call whose result holds the quote (for example w12), or drop the quote",
      ),
    };
  }
  if (!SOURCE_PATTERN.test(source)) {
    return {
      error: toolError(
        "invalid_source",
        `'${source}' is not a walk id; a source is w1, w2, … (or label:w1) and never a path`,
        { field: "source" },
        "pass the walk id of the call whose result shows the fact, such as w12",
      ),
    };
  }
  const metadata: Record<string, unknown> = { source, session_id: ctx.session.sessionId };
  if (quote !== undefined) metadata.quote = quote;
  if (!CURRENT_RUN_SOURCE.test(source)) return { metadata };
  if (!issuedWalkIds(ctx).includes(source)) {
    return {
      error: toolError(
        "source_not_in_walk",
        `'${source}' is not a walk id this run has issued`,
        { field: "source" },
        "cite a walk id you were given in an earlier tool result in this run, or omit source",
      ),
    };
  }
  if (quote !== undefined) {
    const result = checkQuote(
      quote,
      undefined,
      loadSavedResult(ctx.session.exportDir, source),
      ctx.contract.accuracy.min_quote_length,
    );
    metadata.quote_check = { verdict: result.verdict, reason: result.reason };
  }
  return { metadata };
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
      const dropped = droppedArgs(EIDETIC_RECALL_SCHEMA, rawParams);
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
      const notShown = bounded.truncated && bounded.cursor ? bounded.cursor.total - bounded.cursor.offset : 0;
      return {
        content: [{ type: "text" as const, text: bounded.text }],
        details: {
          ok: true,
          truncated: bounded.truncated,
          spill_path: bounded.spillPath,
          top_k: topK,
          depth,
          args_used: { query: params.query, mode: params.mode ?? "hybrid", top_k: topK, depth },
          dropped_args: dropped,
          not_shown_chars: notShown,
        },
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
      const params = (rawParams ?? {}) as {
        text: string;
        type?: string;
        id?: string;
        source?: string;
        quote?: string;
      };
      const dropped = droppedArgs(EIDETIC_REMEMBER_SCHEMA, rawParams);
      const prep = prepare("eidetic_remember");
      if ("error" in prep) return toolResult(prep.error);

      const reference = referenceMetadata(ctx, params.source, params.quote);
      if ("error" in reference) return toolResult(reference.error);

      const provenance = taint.provenance();
      const record: Record<string, unknown> = {
        id: params.id ?? `a-${createHash("sha256").update(params.text).digest("hex").slice(0, 16)}`,
        text: params.text,
        type: params.type ?? "note",
        // Set by the extension from observed tool use; there is no model-supplied source argument.
        metadata: { added_via: "associate", ...(provenance ? { provenance } : {}), ...reference.metadata },
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
        ...(reference.metadata.quote_check ? { quote_check: reference.metadata.quote_check } : {}),
        args_used: {
          text: params.text,
          type: record.type,
          id: record.id,
          ...(params.source !== undefined ? { source: params.source } : {}),
          ...(params.quote !== undefined ? { quote: params.quote } : {}),
        },
        dropped_args: dropped,
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
