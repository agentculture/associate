/**
 * `code_lens` — the wrapper around the code-lens PATH CLI.
 *
 * One tool with a `command` enum rather than six tools: the six verbs share a
 * target path, a JSON flag and an error contract, and the spec's tool list is
 * "fixed and small" (c20). code-lens is the repo-inspection engine — profile,
 * classify, grep, recent, connections, graph — and this file re-implements
 * none of it (scope: "Pi tools wrap those CLIs rather than re-implementing
 * repo profiling").
 *
 * What this wrapper owns:
 *
 *   * **PATH-only resolution with install-hint degradation.** The engine is
 *     found with `whichOnPath` and nothing else; absent, the tool returns a
 *     `tool_missing` error naming `uv tool install code-lens-cli`. The upstream
 *     code-lens-cli skill wrappers resolve the engine four levels above the
 *     script and `uv run --directory` there — in this repo (`dependencies = []`)
 *     that finds no `code_lens` module, which is why that pattern is refused
 *     here (spec: 2026-09-05-webglass-code-lens-as-tools, Scope / boundaries).
 *   * **In-tool argument validation** against the same schema the model is
 *     offered, so a malformed call gets a corrective error naming the field
 *     rather than a CLI usage dump (c21/h15).
 *   * **Containment**: the target path is confined to the checkout and a
 *     pattern carrying `..` is refused, both through `lib/contain.ts`.
 *   * **Bounded output** at `policy.budgets.shell`, spilling to the session
 *     scratch dir — no policy number is written here.
 *
 * Known version gap, deliberately not papered over: code-lens 0.10.0 ships
 * `profile`, `classify`, `grep` and `recent` but not `connections` or `graph`.
 * The enum carries all six because the spec names all six; a verb the installed
 * CLI lacks comes back as a typed `unsupported_command` error naming the verb,
 * so the model learns the truth about the installed engine instead of reading
 * an argparse usage string.
 */

import {
  boundOutput,
  confine,
  makeStructuredError,
  refusePatternEscape,
  validateArgs,
  type Budget,
} from "../lib/contain.ts";
import type { AssociateContext } from "../lib/context.ts";
import {
  engineForToolName,
  firstLine,
  fromContainError,
  missingCliError,
  noEngineError,
  parseJson,
  spawnArgv,
  toolError,
  toolResult,
  whichOnPath,
  type Spawn,
  type Which,
} from "./_procs.ts";

/** This tool's name — and, with underscores swapped for hyphens, its engine's. */
export const CODE_LENS_TOOL_NAME = "code_lens";

/** The verbs the spec names, in the order it names them. */
export const CODE_LENS_COMMANDS = [
  "profile",
  "classify",
  "grep",
  "recent",
  "connections",
  "graph",
] as const;

export type CodeLensCommand = (typeof CODE_LENS_COMMANDS)[number];

/**
 * The tool's parameter schema.
 *
 * A plain JSON Schema object rather than a `typebox` builder: TypeBox emits
 * exactly this shape, `typebox` only resolves inside pi's runtime, and the same
 * object is handed to `validateArgs` so the model is validated against the
 * schema it was shown — never a second, drifting copy.
 */
export const CODE_LENS_SCHEMA = {
  type: "object",
  required: ["command"],
  properties: {
    command: {
      type: "string",
      enum: [...CODE_LENS_COMMANDS],
      description:
        "profile: mechanical facts about a repo. classify: project-type tags. grep: regex " +
        "search with the AST scope of each match. recent: recent commits with symbol diffs. " +
        "connections / graph: cross-module relations.",
    },
    path: {
      type: "string",
      description:
        "Repo-relative path to inspect. Defaults to the checkout root; may not escape it.",
    },
    pattern: {
      type: "string",
      description: "Regex to search for. Required by, and only used by, command=grep.",
    },
    count: {
      type: "integer",
      description: "How many commits command=recent returns. Defaults to the CLI's own default.",
    },
    depth: {
      type: "string",
      enum: ["shallow", "deep"],
      description: "command=profile only. deep walks submodules; shallow stays top-level.",
    },
    online: {
      type: "boolean",
      description:
        "command=profile only. False (the default) passes --basic, skipping the fields that " +
        "need network access; set true to include them.",
    },
  },
} as const;

export interface CodeLensDeps {
  which?: Which;
  spawn?: Spawn;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

type Params = {
  command?: CodeLensCommand;
  path?: string;
  pattern?: string;
  count?: number;
  depth?: "shallow" | "deep";
  online?: boolean;
};

/** `policy.budgets.shell` — code-lens output is spawned-process output. */
function shellBudget(ctx: AssociateContext): Budget {
  const budgets = (ctx.policy.budgets ?? {}) as Record<string, Budget | undefined>;
  const budget = budgets.shell ?? budgets.read;
  if (!budget || typeof budget.max_output_chars !== "number") {
    // The contract owns every budget (c46); an absent one is a contract bug,
    // not something to paper over with a literal.
    throw new Error(
      "associate contract policy.budgets.shell is missing max_output_chars; " +
        "the code_lens wrapper defines no budget of its own",
    );
  }
  return budget;
}

/** Build the argv for one validated call, or return the error that refuses it. */
export function buildArgv(
  params: Params,
  targetPath: string,
): string[] | ReturnType<typeof toolError> {
  const command = params.command as CodeLensCommand;
  switch (command) {
    case "grep": {
      const pattern = params.pattern;
      if (typeof pattern !== "string" || pattern === "") {
        return fromContainError(
          makeStructuredError(
            "invalid_argument",
            "command=grep needs a 'pattern' to search for",
            "pattern",
          ),
        );
      }
      const escape = refusePatternEscape(pattern);
      if (escape) return fromContainError(escape);
      return ["grep", pattern, targetPath, "--json"];
    }
    case "recent": {
      const argv = ["recent", targetPath];
      if (typeof params.count === "number") argv.push("-n", String(params.count));
      argv.push("--json");
      return argv;
    }
    case "profile": {
      const argv = ["profile", targetPath];
      if (params.depth) argv.push("--depth", params.depth);
      // Default to the offline profile: a read/find lane should not reach the
      // network as a side effect of asking what a repo is.
      if (params.online !== true) argv.push("--basic");
      argv.push("--json");
      return argv;
    }
    default:
      return [command, targetPath, "--json"];
  }
}

/**
 * True when *stderr* is argparse telling us the installed CLI has no such verb.
 *
 * Matched on argparse's own wording (`invalid choice`) plus the usage line, so
 * an unrelated failure is not misreported as a missing feature.
 */
export function looksUnsupported(stderr: string, command: string): boolean {
  return /invalid choice/i.test(stderr) && stderr.includes(command);
}

/** Build the `code_lens` tool definition. */
export function createCodeLensTool(ctx: AssociateContext, deps: CodeLensDeps = {}) {
  const which = deps.which ?? ((name: string) => whichOnPath(name, deps.env));
  const spawn = deps.spawn ?? spawnArgv;

  return {
    name: CODE_LENS_TOOL_NAME,
    label: "Code Lens",
    description:
      "Inspect a repository through the code-lens CLI: profile (mechanical facts — manifest, " +
      "layout, deps, entry points), classify (project-type tags), grep (regex search annotated " +
      "with each match's AST scope), recent (recent commits with per-file symbol diffs), " +
      "connections and graph (cross-module relations). One call answers questions that would " +
      "otherwise cost a dozen reads. Read-only; it never modifies the checkout.",
    promptSnippet: "Ask code-lens about a repo before reading files one by one",
    promptGuidelines: [
      "Start repo questions with code_lens profile or classify: one call replaces a directory walk.",
      "Use code_lens grep rather than a plain search when the AST scope of each match matters.",
    ],
    parameters: CODE_LENS_SCHEMA,

    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const params = (rawParams ?? {}) as Params;

      const invalid = validateArgs(CODE_LENS_SCHEMA as unknown as Record<string, unknown>, params);
      if (invalid) return toolResult(fromContainError(invalid));

      // Confine the target before anything is spawned (c30).
      const confined = confine(ctx.checkoutRoot, params.path ?? ".");
      if (confined.ok !== true) return toolResult(fromContainError(confined));
      const targetPath = confined.path;

      const argv = buildArgv(params, targetPath);
      if (!Array.isArray(argv)) return toolResult(argv);

      const engine = engineForToolName(ctx.policy, CODE_LENS_TOOL_NAME);
      if (!engine) return toolResult(noEngineError(CODE_LENS_TOOL_NAME, { tool: CODE_LENS_TOOL_NAME }));

      const binary = which(engine.command);
      if (!binary) return toolResult(missingCliError(engine.command));

      const proc = await spawn(binary, argv, {
        cwd: ctx.checkoutRoot,
        timeoutMs: deps.timeoutMs,
      });

      if (proc.code !== 0) {
        const command = params.command as string;
        if (looksUnsupported(proc.stderr, command)) {
          return toolResult(
            toolError(
              "unsupported_command",
              `the installed code-lens has no '${command}' verb. Use one it does have, or ` +
                "upgrade with: uv tool install --upgrade code-lens-cli",
              { command, binary, stderr: firstLine(proc.stderr), exit_code: proc.code },
            ),
          );
        }
        return toolResult(
          toolError("cli_failed", `code-lens ${command} exited ${proc.code}`, {
            command,
            binary,
            argv,
            exit_code: proc.code,
            stderr: firstLine(proc.stderr),
            timed_out: proc.timedOut === true,
          }),
        );
      }

      const bounded = boundOutput(proc.stdout, shellBudget(ctx), ctx.session.scratchDir);
      const parsed = bounded.truncated ? undefined : parseJson(proc.stdout);

      const payload: Record<string, unknown> = {
        ok: true,
        command: params.command,
        path: targetPath,
        binary,
        argv,
        exit_code: proc.code,
        truncated: bounded.truncated,
      };
      // code-lens --json answers {"ok": true, "data": {...}}; anything else
      // (a human-readable body, or output the budget cut short) is handed back
      // as text rather than dressed up as structure it does not have.
      if (parsed && typeof parsed === "object" && "data" in (parsed as object)) {
        payload.data = (parsed as { data: unknown }).data;
      } else {
        payload.text = bounded.text;
      }
      if (bounded.spillPath) payload.spill_path = bounded.spillPath;
      if (bounded.cursor) payload.cursor = bounded.cursor;

      return toolResult(payload);
    },
  };
}

/** Register `code_lens`. Called by `lib/runtime.ts`'s module loader. */
export function register(pi: unknown, ctx: AssociateContext): void {
  (pi as { registerTool(definition: unknown): void }).registerTool(createCodeLensTool(ctx));
}
