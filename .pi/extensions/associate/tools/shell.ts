/**
 * The allowlisted shell — a same-named override of pi's built-in `bash`.
 *
 * Spec c20/c35: pi's built-in bash is an unrestricted write path (any shell
 * command can redirect, tee, `sed -i`, `git commit`). The tool set associate
 * ships must still include a shell, so the shell it ships is this one: it
 * registers under the name `bash`, which pi treats as an override of the
 * built-in (pi docs/extensions.md, "Overriding Built-in Tools"), and it is a
 * different contract entirely —
 *
 *   * its input is an **argv array**, never a command line. Nothing here is
 *     parsed, split, quoted or joined, and `child_process.spawn` is called
 *     with `shell: false`, so no code path reaches `/bin/sh` with
 *     model-supplied text (honesty h28);
 *   * `argv[0]` must appear in the contract's read-only allowlist, and where
 *     that entry names subcommands, `argv[1]` must be one of them — so
 *     `git log` and `git diff` run while `git commit` and `git push` do not;
 *   * a redirection, pipe or separator token is refused outright, under
 *     `policy.shell.refuse_redirection` / `refuse_pipes`;
 *   * every refusal is a structured error naming the offending token in
 *     `field`, so the model can correct itself and retry (spec c21).
 *
 * **No allowlist or denylist is defined in this file.** Every command, every
 * subcommand and every budget is read from `policy.json` through
 * `ctx.policy` — changing the contract changes this tool's behaviour with no
 * TypeScript edit (spec c46/c50). The one list that *is* here is the set of
 * POSIX shell operator tokens, which is shell syntax, not policy — the same
 * kind of fact as `guard.ts`'s `BUILTIN_WRITER_TOOLS`.
 *
 * **This module never calls `ctx.declareWriter`.** It is the safe shell: it
 * cannot write, so the `tool_call` write guard has nothing to confine here.
 *
 * Two deliberate notes for a reader:
 *
 *   * the tool's `parameters` are a plain JSON Schema object rather than a
 *     `typebox` builder. TypeBox schemas *are* plain JSON Schema objects at
 *     runtime, so pi is satisfied either way; writing it out means the same
 *     schema also feeds `validateArgs()` for the in-tool check (spec c21), and
 *     it keeps this module importable by `node --test`, which cannot resolve
 *     pi's bundled `typebox`.
 *   * pi inherits the built-in bash *renderer* when an override supplies none
 *     (docs/extensions.md). That renderer reads `args.command`, which this
 *     tool does not have, so an interactive session renders the call line as
 *     "invalid args". Harmless for the headless lane associate runs on;
 *     `details.command_display` carries a readable form for anything that
 *     wants one. A renderer of our own needs `@earendil-works/pi-tui`, which
 *     spec c44 keeps out of this extension.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  boundOutput,
  confine,
  gitignoreMatcher,
  isDenylisted,
  makeStructuredError,
  validateArgs,
  type Budget,
  type GitignoreMatcher,
  type Policy,
  type StructuredError,
} from "../lib/contain.ts";
import { policySection, type ContractPolicy } from "../lib/contract.ts";
import type { AssociateContext } from "../lib/context.ts";

/** The registered name. It is `bash` on purpose: this overrides the built-in. */
export const SHELL_TOOL_NAME = "bash";

/** How the override identifies itself in the tool list (criterion 2). */
export const SHELL_TOOL_LABEL = "Shell (allowlisted)";

/** The code every policy refusal carries. */
export const SHELL_REFUSED = "shell_refused";

// ---------------------------------------------------------------------------
// The argument schema — one object, used both to register and to validate
// ---------------------------------------------------------------------------

export const SHELL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    argv: {
      type: "array",
      items: { type: "string" },
      description:
        "The command as an argv array: the executable first, then one element per argument. " +
        'Shape: ["<executable>", "<argument>", "<argument>"]. This is NOT a shell command line — ' +
        "there is no shell, so quoting, globbing, redirection and pipes do not exist here.",
    },
    cwd: {
      type: "string",
      description:
        "Optional working directory, relative to the checkout being examined. " +
        "It must stay inside that checkout.",
    },
  },
  required: ["argv"],
};

// ---------------------------------------------------------------------------
// Shell syntax facts (not policy)
// ---------------------------------------------------------------------------

/**
 * Tokens that are a redirection in POSIX shell.
 *
 * Shell syntax, not a contract value: `policy.shell.refuse_redirection` says
 * *whether* to refuse these, this list says *what they look like*.
 */
export const REDIRECTION_TOKENS: readonly string[] = [
  ">",
  ">>",
  ">|",
  "<",
  "<<",
  "<<<",
  "<>",
  "&>",
  "&>>",
  ">&",
  "2>",
  "2>>",
];

/** Tokens that pipe or separate commands. Governed by `refuse_pipes`. */
export const SEPARATOR_TOKENS: readonly string[] = ["|", "|&", "||", "&&", "&", ";", ";;"];

/** A pure redirection form such as `2>`, `>>`, `>&2`. */
const REDIRECTION_SHAPE = /^\d*(?:>>?|<<?|&>>?|>&)&?\d*$/;

// ---------------------------------------------------------------------------
// Reading the contract
// ---------------------------------------------------------------------------

export interface ShellRules {
  /** `policy.shell.argv_only` — the input is an argv array. */
  readonly argvOnly: boolean;
  /** `policy.shell.shell_interpretation` — always expected false. */
  readonly shellInterpretation: boolean;
  readonly refuseRedirection: boolean;
  readonly refusePipes: boolean;
  /**
   * `policy.shell.allowlist`, as command → allowed subcommands. An empty array
   * means the command takes any arguments; a non-empty one means `argv[1]`
   * must be in it.
   */
  readonly allowlist: ReadonlyMap<string, readonly string[]>;
}

/** Read `policy.shell` into the shape this tool works with. */
export function shellRules(policy: ContractPolicy): ShellRules {
  const section = policySection(policy, "shell");
  const allowlist = new Map<string, readonly string[]>();
  for (const raw of (section.allowlist as unknown[]) ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { command?: unknown; subcommands?: unknown };
    if (typeof entry.command !== "string" || entry.command === "") continue;
    const subcommands = Array.isArray(entry.subcommands)
      ? entry.subcommands.filter((value): value is string => typeof value === "string")
      : [];
    allowlist.set(entry.command, subcommands);
  }
  return {
    argvOnly: section.argv_only !== false,
    shellInterpretation: section.shell_interpretation === true,
    refuseRedirection: section.refuse_redirection !== false,
    refusePipes: section.refuse_pipes !== false,
    allowlist,
  };
}

/** `policy.budgets.shell`, or `undefined` when the contract declares none. */
export function shellBudget(policy: ContractPolicy): Budget | undefined {
  const budget = policySection(policy, "budgets").shell;
  if (!budget || typeof budget !== "object") return undefined;
  const candidate = budget as Budget;
  return typeof candidate.max_output_chars === "number" ? candidate : undefined;
}

// ---------------------------------------------------------------------------
// The refusal rules
// ---------------------------------------------------------------------------

function refuse(message: string, field: string): StructuredError {
  return makeStructuredError(SHELL_REFUSED, message, field);
}

/**
 * The offending shell operator in *token*, or `null`.
 *
 * A token is an operator when it *is* one, or when it *starts* with one — so
 * `>`, `>f`, `2>`, `|` and `&&x` are caught while a pattern that merely
 * contains one (`rg 'foo|bar'`) is not. With no shell in the picture an
 * embedded `|` is an ordinary character, so refusing it would only cost the
 * model working searches.
 */
export function shellOperator(token: string): { kind: "redirection" | "separator"; op: string } | null {
  if (REDIRECTION_TOKENS.includes(token) || REDIRECTION_SHAPE.test(token)) {
    return { kind: "redirection", op: token };
  }
  if (SEPARATOR_TOKENS.includes(token)) return { kind: "separator", op: token };
  const redirectionPrefix = /^(?:\d*[<>]|&>)/.exec(token);
  if (redirectionPrefix) return { kind: "redirection", op: redirectionPrefix[0] };
  const separatorPrefix = /^(?:\|\||&&|\||;|&)/.exec(token);
  if (separatorPrefix) return { kind: "separator", op: separatorPrefix[0] };
  return null;
}

/**
 * Decide one argv against the contract, or `null` when it may run.
 *
 * Order matters, because the first refusal is what the model is told: shell
 * syntax first (it explains `echo x > f` as redirection rather than as "echo
 * is not allowlisted"), then the executable, then the subcommand.
 */
export function refuseArgv(argv: readonly string[], policy: ContractPolicy): StructuredError | null {
  const rules = shellRules(policy);

  if (argv.length === 0) {
    return makeStructuredError(
      "invalid_argument",
      "argv must name a command: the executable first, then one element per argument",
      "argv",
    );
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const field = `argv[${index}]`;
    if (token.includes("\0") || /[\r\n]/.test(token)) {
      return refuse(
        `token ${JSON.stringify(token)} contains a newline or NUL; argv elements are single arguments`,
        field,
      );
    }
    const operator = shellOperator(token);
    if (!operator) continue;
    if (operator.kind === "redirection" && rules.refuseRedirection) {
      return refuse(
        `token ${JSON.stringify(token)} is a shell redirection (${operator.op}); this shell takes an ` +
          "argv array and never redirects output — the contract forbids it " +
          "(policy.shell.refuse_redirection)",
        field,
      );
    }
    if (operator.kind === "separator" && rules.refusePipes) {
      return refuse(
        `token ${JSON.stringify(token)} is a shell pipe or command separator (${operator.op}); ` +
          "one call runs exactly one command, and the contract forbids pipes " +
          "(policy.shell.refuse_pipes)",
        field,
      );
    }
  }

  const command = argv[0]!;
  if (/\s/.test(command)) {
    return refuse(
      `argv[0] ${JSON.stringify(command)} contains whitespace, so it was meant as a command line. ` +
        'There is no shell here: pass one argv element per argument, i.e. ["<executable>", "<argument>"]',
      "argv[0]",
    );
  }
  if (!rules.allowlist.has(command)) {
    return refuse(
      `command ${JSON.stringify(command)} is not in the contract's read-only shell allowlist ` +
        `(${[...rules.allowlist.keys()].join(", ")}). associate inspects a checkout and hands the ` +
        "result back; it never mutates one",
      "argv[0]",
    );
  }

  const subcommands = rules.allowlist.get(command)!;
  if (subcommands.length > 0) {
    const sub = argv[1];
    if (sub === undefined) {
      return refuse(
        `${command} requires one of its allowlisted subcommands as argv[1]: ${subcommands.join(", ")}`,
        "argv[1]",
      );
    }
    if (!subcommands.includes(sub)) {
      return refuse(
        `${command} subcommand ${JSON.stringify(sub)} is not allowlisted; the contract allows only ` +
          `${subcommands.join(", ")} — the read-only ones`,
        "argv[1]",
      );
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Path operands — the same boundary the `read` tool enforces
//
// The allowlist alone says nothing about WHAT an allowlisted command reads.
// `cat` is read-only, so it passes the allowlist; an argv of cat plus a
// dotenv file is still a secret leaving the box, and cat plus ../../etc/passwd
// is still a read outside the checkout — both of which the `read` tool refuses
// outright. An agent that can reach either through `bash` makes `read`'s
// confinement and denylist decorative. So every operand that names an
// existing path goes through the same two checks `read` applies: confine to
// the checkout, then the policy denylist plus the checkout's `.gitignore`.
//
// "Names an existing path" is the deliberate limit: an `rg` pattern, a `git`
// revision or a `--flag` is not refused for merely looking path-shaped, and a
// path that does not exist can leak nothing. Existence is checked with
// `lstat`, so a symlink is judged by where it lands (confine resolves it)
// rather than skipped.
// ---------------------------------------------------------------------------

/** A token that is an option, not an operand (`--` included: it is syntax). */
function isFlag(token: string): boolean {
  return token.startsWith("-");
}

/** True when *candidate* exists (a dangling symlink counts — lstat sees it). */
function pathExists(candidate: string): boolean {
  try {
    lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse an argv whose path operands escape the checkout or name a denied
 * file. *cwd* is the already-confined working directory the command will run
 * in, so a relative operand is judged where it will actually resolve.
 */
export function refusePathOperands(
  argv: readonly string[],
  cwd: string,
  ctx: AssociateContext,
): StructuredError | null {
  const rules = shellRules(ctx.policy);
  const policy = ctx.policy as unknown as Policy;
  // The subcommand slot is a keyword, not a path: `git log` must not be read
  // as "open the file named log" when one happens to exist.
  const firstOperand = (rules.allowlist.get(argv[0]!)?.length ?? 0) > 0 ? 2 : 1;

  let matcher: GitignoreMatcher | undefined;
  let matcherLoaded = false;
  const gitignore = (): GitignoreMatcher | undefined => {
    if (!matcherLoaded) {
      matcherLoaded = true;
      try {
        matcher = gitignoreMatcher(readFileSync(resolve(ctx.checkoutRoot, ".gitignore"), "utf8"));
      } catch {
        matcher = undefined;
      }
    }
    return matcher;
  };

  for (let index = firstOperand; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "" || isFlag(token)) continue;
    const candidate = isAbsolute(token) ? token : resolve(cwd, token);
    if (!pathExists(candidate)) continue;

    const field = `argv[${index}]`;
    const confined = confine(ctx.checkoutRoot, candidate);
    if (!confined.ok) {
      return refuse(
        `operand ${JSON.stringify(token)} resolves outside the checkout being examined; ` +
          "this shell may only look at paths inside it",
        field,
      );
    }
    const rel = relative(resolve(ctx.checkoutRoot), confined.path).split(sep).join("/");
    const denied = isDenylisted(rel, policy, gitignore());
    if (denied) {
      const why = denied.message.replace(/^read of '[^']*' is refused: /, "");
      return refuse(`operand ${JSON.stringify(token)} is refused: ${why}`, field);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

/** The minimum of a child process this tool uses. */
export interface ChildLike {
  stdout: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  stderr: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  on(event: string, listener: (...args: any[]) => void): unknown;
  kill(signal?: string): unknown;
}

export interface SpawnOptions {
  /** Always false. Typed as the literal so a shell string cannot be smuggled in. */
  readonly shell: false;
  readonly cwd: string;
}

/**
 * The spawn function, injected so a test can assert the exact call (criterion
 * 3) rather than infer it from a side effect.
 */
export type SpawnFn = (file: string, args: string[], options: SpawnOptions) => ChildLike;

interface RunOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  error?: Error;
}

function collect(child: ChildLike, stream: "stdout" | "stderr", chunks: Buffer[]): void {
  child[stream]?.on("data", (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
  });
}

function runChild(spawnFn: SpawnFn, argv: readonly string[], cwd: string, signal?: AbortSignal): Promise<RunOutcome> {
  return new Promise<RunOutcome>((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let child: ChildLike;
    try {
      child = spawnFn(argv[0]!, argv.slice(1), { shell: false, cwd });
    } catch (thrown) {
      resolve({ stdout: "", stderr: "", exitCode: null, signal: null, error: thrown as Error });
      return;
    }

    collect(child, "stdout", out);
    collect(child, "stderr", err);

    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });

    const settle = (outcome: Omit<RunOutcome, "stdout" | "stderr">): void => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        ...outcome,
      });
    };

    child.on("error", (error: Error) => settle({ exitCode: null, signal: null, error }));
    child.on("close", (code: number | null, sig: string | null) =>
      settle({ exitCode: code, signal: sig ?? null }),
    );
  });
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

/** One record for both the model and the walk — the same object, both places. */
function asResult(details: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

function quoteForDisplay(argv: readonly string[]): string {
  return argv.map((token) => (/^[\w@%+=:,./-]+$/.test(token) ? token : JSON.stringify(token))).join(" ");
}

export interface ShellDeps {
  spawn?: SpawnFn;
}

/**
 * Build the tool's `execute`, with the spawn function injected.
 *
 * Every path returns a result; nothing throws. A refusal and a failed command
 * are both ordinary results carrying a structured record, which is what makes
 * the whole invocation visible to the walk recorder (t9) through the tool
 * events (`details` is the record).
 */
export function makeShellExecute(ctx: AssociateContext, deps: ShellDeps = {}) {
  const spawnFn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const spillDir = join(ctx.session.scratchDir, "shell");

  return async function execute(
    _toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const startedAt = Date.now();

    // A model trained on pi's built-in bash reaches for { command }. Say what
    // this tool wants instead of failing on a missing required field (c21).
    if (params && typeof params === "object" && params.argv === undefined && "command" in params) {
      return asResult({
        ...makeStructuredError(
          "invalid_argument",
          "this shell takes argv, not a command string: pass " +
            '["<executable>", "<argument>", "<argument>"] rather than one "executable argument" ' +
            "string. There is no shell, so redirection, pipes and globbing are unavailable by " +
            "construction",
          "argv",
        ),
      } as unknown as Record<string, unknown>);
    }

    const invalid = validateArgs(SHELL_PARAMETERS, params);
    if (invalid) return asResult({ ...invalid } as unknown as Record<string, unknown>);

    const argv = (params.argv as string[]).slice();
    const refusal = refuseArgv(argv, ctx.policy);
    if (refusal) {
      return asResult({
        ...(refusal as unknown as Record<string, unknown>),
        argv,
        command_display: quoteForDisplay(argv),
      });
    }

    let cwd = ctx.checkoutRoot;
    if (typeof params.cwd === "string" && params.cwd.trim() !== "") {
      const confined = confine(ctx.checkoutRoot, params.cwd);
      if (!confined.ok) {
        // confine() names its own argument `path`; re-field it to the argument
        // the model actually passed, so the corrective error is actionable.
        return asResult({
          ...(makeStructuredError(
            confined.code,
            confined.message.replace("path '", "cwd '"),
            "cwd",
          ) as unknown as Record<string, unknown>),
          argv,
        });
      }
      cwd = confined.path;
    }

    // Only now, with cwd settled: a relative operand means nothing until we
    // know which directory the command runs in.
    const operandRefusal = refusePathOperands(argv, cwd, ctx);
    if (operandRefusal) {
      return asResult({
        ...(operandRefusal as unknown as Record<string, unknown>),
        argv,
        cwd,
        command_display: quoteForDisplay(argv),
      });
    }

    const outcome = await runChild(spawnFn, argv, cwd, signal);
    const duration = Date.now() - startedAt;

    if (outcome.error) {
      return asResult({
        ...makeStructuredError(
          "shell_spawn_failed",
          `could not run ${JSON.stringify(argv[0]!)}: ${outcome.error.message}`,
          "argv[0]",
        ),
        argv,
        cwd,
        command_display: quoteForDisplay(argv),
        duration_ms: duration,
      } as unknown as Record<string, unknown>);
    }

    const budget = shellBudget(ctx.policy);
    const stdout = budget ? boundOutput(outcome.stdout, budget, spillDir) : undefined;
    const stderr = budget ? boundOutput(outcome.stderr, budget, spillDir) : undefined;

    const details: Record<string, unknown> = {
      ok: true,
      exit_code: outcome.exitCode,
      stdout: stdout ? stdout.text : outcome.stdout,
      stderr: stderr ? stderr.text : outcome.stderr,
      truncated: Boolean(stdout?.truncated || stderr?.truncated),
      // Everything below is for the walk: the call and its result, in full.
      argv,
      cwd,
      command_display: quoteForDisplay(argv),
      duration_ms: duration,
    };
    if (outcome.signal) details.signal = outcome.signal;
    if (stdout?.spillPath) details.stdout_spill = stdout.spillPath;
    if (stderr?.spillPath) details.stderr_spill = stderr.spillPath;
    if (stdout?.cursor) details.stdout_cursor = stdout.cursor;
    return asResult(details);
  };
}

/** Register the override. Called by `lib/runtime.ts`'s module loader. */
export function register(pi: unknown, ctx: AssociateContext, deps: ShellDeps = {}): void {
  const rules = shellRules(ctx.policy);
  const allowed = [...rules.allowlist.entries()]
    .map(([command, subs]) => (subs.length ? `${command} (${subs.join(", ")})` : command))
    .join(", ");

  (pi as { registerTool(definition: Record<string, unknown>): void }).registerTool({
    name: SHELL_TOOL_NAME,
    label: SHELL_TOOL_LABEL,
    description:
      "Run ONE read-only command, given as an argv array. There is no shell: no quoting, globbing, " +
      "redirection, pipes or command chaining, and nothing is ever parsed from a string. " +
      `Allowed commands (subcommands in brackets): ${allowed}. ` +
      "Anything else — and any redirection, pipe or separator token — is refused with a structured " +
      "error naming the offending argument, which you can correct and retry.",
    promptSnippet: `Run one allowlisted read-only command as an argv array (${[...rules.allowlist.keys()].join(", ")})`,
    promptGuidelines: [
      "Call bash with argv as an array of arguments, never as a command line string; it is not a shell.",
      "bash refuses anything that writes — no redirection, no pipes, no rm, no mutating git subcommand — so use it only to look.",
    ],
    parameters: SHELL_PARAMETERS,
    execute: makeShellExecute(ctx, deps),
  });

  // Deliberately NOT ctx.declareWriter(SHELL_TOOL_NAME): this shell cannot
  // write. The opposite declaration IS needed, because the name it overrides
  // is on the guard's built-in writer list: without this the guard would block
  // every call to the safe shell as a path-less writer, and `associate_ready`
  // would report it as an active writer, which the launcher refuses to serve
  // on (spec c34). See lib/guard.ts.
  ctx.declareNonWriter(SHELL_TOOL_NAME);
}
