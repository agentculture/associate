/**
 * The write guard: defence in depth behind `defaultTools: []`.
 *
 * Spec c4/c5: the restriction on associate is enforced in code, not prompt.
 * `.pi/settings.json` sets `defaultTools: []`, so pi starts with no built-in
 * `edit`, `write` or `bash` at all — that is the structural half, verified from
 * the tool list pi reports. This module is the second half: a `tool_call` hook
 * that blocks a *writing* tool call whose resolved target lies outside the
 * session scratch directory (spec c42), so nothing can persist a change to the
 * examined checkout even if a writer is somehow present (a future tool, an
 * operator's `--tools` override, an extension loaded alongside this one).
 *
 * Reads outside the scratch directory are deliberately allowed: associate's
 * whole job is repo inspection. Path *reading* limits are the read tool's own,
 * driven by `policy.json`'s read denylist — not by this hook.
 */

import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isInside } from "./session.ts";
import { buildGateState } from "./gate.ts";
import { CHANGE_NEW_FILE, renderChange } from "./diff.ts";
import type { EvaluateOptions, Gate, GateEntry } from "./gate.ts";
import type { ContractModels, ContractPolicy } from "./contract.ts";
import { isMutatingCall, type ActiveModel } from "./toolset.ts";
import type { TestWindow } from "./context.ts";

/**
 * Pi's built-in tool names that can persist a change to a checkout.
 *
 * Not a policy value: this is the Pi-side fact of which built-in names write,
 * documented in pi docs/extensions.md ("Overriding Built-in Tools" lists
 * `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`). `bash` is included
 * because pi's built-in bash is an unrestricted write path (spec c35); the
 * extension's own allowlisted shell registers under a different contract and
 * declares itself a non-writer. `powershell` is the optional Windows shell pi
 * 0.84.3 added as a built-in (pi docs/windows.md) — as unrestricted as bash,
 * and no safe override is registered under its name.
 */
export const BUILTIN_WRITER_TOOLS: readonly string[] = [
  "write",
  "edit",
  "multi_edit",
  "multiedit",
  "apply_patch",
  "notebook_edit",
  "bash",
  "powershell",
];

/**
 * Tool argument names that carry a filesystem path.
 *
 * Checked case-insensitively; array values are checked element by element.
 */
export const PATH_ARG_KEYS: readonly string[] = [
  "path",
  "paths",
  "file",
  "files",
  "file_path",
  "filepath",
  "filename",
  "dir",
  "directory",
  "cwd",
  "output",
  "output_path",
  "outfile",
  "destination",
  "dest",
  "target",
  "to",
];

/**
 * One refusal. `reason` is what pi hands the model, so it already ends with
 * the fix; `fix` is also kept on its own (spec c10: every refusal says how to
 * fix the request), and `kind` names the refusal for the refusal cap (issue
 * #20: the same kind repeated up to accuracy.json `refusal_cap` ends the run).
 */
export interface GuardDecision {
  readonly block: true;
  readonly reason: string;
  readonly fix: string;
  readonly kind: string;
}

export interface GuardOptions {
  readonly toolName: string;
  readonly input: unknown;
  /** The only writable directory for this session. */
  readonly scratchDir: string;
  /** Base for resolving relative paths — the checkout pi was started in. */
  readonly cwd: string;
  /**
   * Tool names this extension registered and declared as writers, in addition
   * to {@link BUILTIN_WRITER_TOOLS}. Supplied by the extension context so a
   * tool module declares its own nature instead of this list growing here.
   */
  readonly declaredWriters?: Iterable<string>;
  /**
   * Tool names this extension registered as a *safe override* of a built-in
   * writer. The allowlisted shell (spec c35) is the case this exists for: it
   * registers under the built-in name `bash` — that is what makes it an
   * override — but takes an argv array, spawns with no shell, and refuses
   * everything that is not read-only, so it must not be judged by the built-in
   * name's reputation. A declared non-writer wins over
   * {@link BUILTIN_WRITER_TOOLS}; nothing else clears that list.
   */
  readonly declaredNonWriters?: Iterable<string>;
}

/** Whether a tool call can persist a change, by name. */
export function isWriterTool(
  toolName: string,
  declaredWriters?: Iterable<string>,
  declaredNonWriters?: Iterable<string>,
): boolean {
  const name = toolName.toLowerCase();
  for (const declared of declaredNonWriters ?? []) {
    if (declared.toLowerCase() === name) return false;
  }
  if (BUILTIN_WRITER_TOOLS.includes(name)) return true;
  for (const declared of declaredWriters ?? []) {
    if (declared.toLowerCase() === name) return true;
  }
  return false;
}

/** Every path-shaped argument of a tool call, in declaration order. */
export function collectPathArguments(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const found: string[] = [];
  const keys = new Set(PATH_ARG_KEYS);
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!keys.has(key.toLowerCase())) continue;
    if (typeof value === "string") {
      if (value.trim()) found.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) found.push(item);
      }
    }
  }
  return found;
}

/**
 * Decide one tool call.
 *
 * Returns a `{ block: true, reason }` that a `tool_call` handler can return
 * verbatim, or `undefined` to let the call proceed. Pure and synchronous so a
 * unit test can drive it with a fake call and no pi process (c4's honesty
 * condition: the hook is verified by a test that asserts a blocked call, not
 * only by the startup tool list).
 */
export function evaluateToolCall(options: GuardOptions): GuardDecision | undefined {
  if (!isWriterTool(options.toolName, options.declaredWriters, options.declaredNonWriters)) {
    return undefined;
  }

  const targets = collectPathArguments(options.input);

  // A writer with no path argument is the unrestricted-shell shape (pi's
  // built-in bash takes `command`, not a path). There is nothing to confine,
  // so refuse it rather than wave it through.
  if (targets.length === 0) {
    return block(
      "pathless_writer",
      `associate: '${options.toolName}' can modify a checkout and declares no path to confine. ` +
        "associate hands work back instead of enacting it",
      `name a file under ${options.scratchDir} in 'path', or return the draft through 'finish'`,
    );
  }

  for (const target of targets) {
    const resolved = isAbsolute(target) ? resolve(target) : resolve(options.cwd, target);
    if (!isInside(options.scratchDir, resolved)) {
      return block(
        "outside_scratch",
        `associate: '${options.toolName}' would write to ${resolved}, outside this session's ` +
          `scratch directory ${options.scratchDir}. The active model may not change the checkout ` +
          "(models.json may_mutate: false)",
        `write under ${options.scratchDir} instead, or return the draft through the 'finish' tool`,
      );
    }
  }

  return undefined;
}

// ===========================================================================
// Checkout confinement for models that may mutate (review r2, finding 2)
// ===========================================================================
//
// A worker/cortex write is CLEF-gated, but the gate is told the run's changes
// land in a disposable worktree — true only for paths INSIDE that worktree. A
// write to an absolute path, a `../` escape, `~/...` or a symlink pointing out
// of the checkout would bypass both the merge gate and the test-command gate
// on a single CLEF allow. So, before the gate, every path argument of a writer
// must resolve (symlinks followed on the deepest existing ancestor) inside the
// run's checkout root or this session's scratch directory.

/** pi's own Unicode-space set (pi `utils/paths.js` `UNICODE_SPACES`), normalised to a plain space. */
const PI_UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Turn a tool's path argument into the absolute path pi's built-in writers
 * would act on — mirroring pi 1.1.0 `resolveToCwd` (`core/tools/path-utils.js`
 * → `utils/paths.js` `normalizePath`/`resolvePath`): Unicode spaces become a
 * space, one leading `@` is stripped, `~` and `~/…` expand to the home
 * directory, a `file://` URL becomes its path, and a relative path resolves
 * against `cwd`. Anything this misses only makes the guard stricter, never
 * looser, because the result is then checked against the checkout.
 */
export function resolveWriteTarget(raw: string, cwd: string, home: string = homedir()): string {
  let target = raw.replace(PI_UNICODE_SPACES, " ");
  if (target.startsWith("@")) target = target.slice(1);
  if (target === "~") target = home;
  else if (target.startsWith("~/")) target = join(home, target.slice(2));
  if (/^file:\/\//.test(target)) {
    try {
      target = fileURLToPath(target);
    } catch {
      // An unparsable file URL stays as text; it then resolves under cwd.
    }
  }
  return isAbsolute(target) ? resolve(target) : resolve(cwd, target);
}

/** Symlink hops followed before a write target is treated as a loop and refused. */
const MAX_SYMLINK_HOPS = 40;

/**
 * Where a write to `target` would really land: symlinks followed on the
 * deepest ancestor that exists, the missing remainder appended lexically.
 *
 * Unlike `realpath` (and `lib/contain.ts` `confine`, which is built for
 * reads), a DANGLING symlink is followed too: `fs.writeFile` on a link whose
 * target does not exist yet creates that target, wherever it points. Throws on
 * a symlink loop; the guard turns any throw into a refusal.
 */
export function resolveWriteDestination(target: string, hops = 0): string {
  const absolute = resolve(target);
  let current = absolute;
  const tail: string[] = [];
  for (;;) {
    let isLink: boolean | undefined;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch {
      isLink = undefined;
    }
    if (isLink !== undefined) {
      let real: string;
      try {
        real = realpathSync(current);
      } catch (error) {
        if (!isLink) throw error;
        // Dangling: follow the link text by hand, relative to the link's directory.
        if (hops >= MAX_SYMLINK_HOPS) throw new Error(`too many symlink hops resolving ${target}`);
        real = resolveWriteDestination(resolve(dirname(current), readlinkSync(current)), hops + 1);
      }
      return tail.length ? join(real, ...tail) : real;
    }
    const parent = dirname(current);
    if (parent === current) return absolute;
    tail.unshift(basename(current));
    current = parent;
  }
}

export interface CheckoutConfineOptions {
  readonly toolName: string;
  readonly input: unknown;
  /** The run's checkout root — for a worktree run, the run worktree. */
  readonly checkoutRoot: string;
  /** This session's scratch directory; writes there stay allowed. */
  readonly scratchDir: string;
  /** Base for relative paths (the checkout pi was started in). */
  readonly cwd: string;
  readonly declaredWriters?: Iterable<string>;
  readonly declaredNonWriters?: Iterable<string>;
  /** Home directory for `~` expansion; defaults to `os.homedir()` as pi's does. */
  readonly home?: string;
}

/**
 * Refuse a writing call by a may_mutate model whose target lies outside the
 * run's checkout (and outside the scratch directory). Non-writers — including
 * the allowlisted shell, which confines its own cwd and operands — pass.
 */
export function confineWriteToCheckout(options: CheckoutConfineOptions): GuardDecision | undefined {
  if (!isWriterTool(options.toolName, options.declaredWriters, options.declaredNonWriters)) {
    return undefined;
  }
  const targets = collectPathArguments(options.input);
  if (targets.length === 0) {
    return block(
      "pathless_writer",
      `associate: '${options.toolName}' can modify files and declares no path to confine to the run's ` +
        `checkout ${options.checkoutRoot}; the call is refused`,
      `use write or edit with a 'path' inside ${options.checkoutRoot}`,
    );
  }
  const roots = [options.checkoutRoot, options.scratchDir].map((root) => resolveWriteDestination(root));
  for (const target of targets) {
    const resolved = resolveWriteDestination(resolveWriteTarget(target, options.cwd, options.home));
    if (roots.some((root) => isInside(root, resolved))) continue;
    return block(
      "outside_checkout",
      `associate: '${options.toolName}' would write to ${resolved}, outside the run's checkout ` +
        `${options.checkoutRoot} (symlinks followed). Changes may only land in the checkout this run ` +
        `works in, or in the session scratch directory ${options.scratchDir}; the call is refused ` +
        "before the safety gate",
      `give a path inside ${options.checkoutRoot} (relative to it, no '..' or symlink leading out), ` +
        `or under ${options.scratchDir}`,
    );
  }
  return undefined;
}

// ===========================================================================
// The change line (deviation d20)
// ===========================================================================
//
// A `write` that replaces an existing checkout file is told to the gate as the
// lines it adds and removes (lib/diff.ts), beside the full content. The file
// is located exactly as confinement located it (resolveWriteTarget →
// resolveWriteDestination), read only when it is a regular file inside the
// checkout, and never past gate.json `change.max_file_bytes`. Every case the
// guard does not compute says why: the line is never silently absent.

export interface WriteChangeOptions {
  readonly toolName: string;
  readonly input: unknown;
  /** The run's checkout root: only files inside it are read. */
  readonly checkoutRoot: string;
  /** Base for relative paths (the checkout pi was started in). */
  readonly cwd: string;
  /** Home directory for `~` expansion; defaults to `os.homedir()` as pi's does. */
  readonly home?: string;
  /** gate.json `change.max_file_bytes`: the most of the current file read. */
  readonly maxFileBytes: number;
  /** gate.json `change.max_render_bytes`: the bound on the rendered hunks. */
  readonly maxRenderBytes: number;
}

const notComputed = (why: string) => `the change was not computed: ${why}`;

/** Read at most `max + 1` bytes of a regular file without following a final symlink or blocking. */
function readBounded(path: string, max: number): { bytes: Buffer; over: boolean } {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("the target stopped being a regular file while it was opened");
    const buffer = Buffer.alloc(max + 1);
    let used = 0;
    while (used < buffer.length) {
      const got = readSync(fd, buffer, used, buffer.length - used, null);
      if (got === 0) break;
      used += got;
    }
    return { bytes: buffer.subarray(0, used), over: used > max };
  } finally {
    closeSync(fd);
  }
}

function kindOf(stat: ReturnType<typeof statSync>): string {
  if (stat.isDirectory()) return "a directory";
  if (stat.isFIFO()) return "a named pipe";
  if (stat.isSocket()) return "a socket";
  if (stat.isCharacterDevice() || stat.isBlockDevice()) return "a device";
  return "not a regular file";
}

/**
 * The change line for one `write` call: what it adds and removes versus the
 * file at its target, or why that was not computed. Never throws.
 */
export function describeWriteChange(options: WriteChangeOptions): string {
  try {
    const input = options.input && typeof options.input === "object" ? (options.input as Record<string, unknown>) : {};
    const targets = collectPathArguments(options.input);
    if (targets.length !== 1) return notComputed(`the call names ${targets.length} target paths, not one.`);
    if (typeof input.content !== "string") return notComputed("the content is not text.");
    const dest = resolveWriteDestination(resolveWriteTarget(targets[0], options.cwd, options.home));
    if (!isInside(resolveWriteDestination(options.checkoutRoot), dest)) {
      return notComputed(
        "the target is outside the checkout (the session scratch directory), so its current content was not read.",
      );
    }
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(dest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return CHANGE_NEW_FILE;
      throw error;
    }
    if (!stat.isFile()) return notComputed(`the target exists but is ${kindOf(stat)}, not a regular file.`);
    const tooBig = (size: number | string) =>
      `replaces an existing file of ${size} bytes, over gate.json change.max_file_bytes ` +
      `(${options.maxFileBytes}); the file was not read, so the change was not computed. ` +
      "The full new content is in arguments.";
    if (stat.size > options.maxFileBytes) return tooBig(stat.size);
    const { bytes, over } = readBounded(dest, options.maxFileBytes);
    if (over) return tooBig(`more than ${options.maxFileBytes}`);
    if (bytes.includes(0)) return notComputed("the current file is not text (it contains NUL bytes).");
    let before: string;
    try {
      before = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return notComputed("the current file is not valid UTF-8 text.");
    }
    return renderChange(before, input.content, options.maxRenderBytes);
  } catch (error) {
    return notComputed(`the current file could not be read (${errorText(error)}).`);
  }
}

// ===========================================================================
// The per-model guard (plan t12)
// ===========================================================================
//
// Decision order for every `tool_call`, each step failing closed:
//
//   1. no active model resolved           → refuse (nothing is allowed);
//   2. tool not in the model's tool set   → refuse (risk r8: catches a tool
//      another extension re-enabled after our setActiveTools, an `mcp__*`
//      tool, `codemode`, any unknown name);
//   2b. no stated purpose (issue #20)    → refuse, unless the tool is in
//      accuracy.json `purpose_exempt_tools`; nothing below runs, the gate is
//      never asked;
//   3. model may not mutate (senses):
//        mutating call → refuse, BEFORE the gate (the decider is never asked);
//        otherwise the scratch-dir write confinement above still applies;
//      model may mutate (worker / cortex): a writer's path must resolve inside
//        the run's checkout or the scratch dir (review r2/2), BEFORE the gate;
//   3b. the test window (review r2/5): while an allowed `run_tests` is in
//      flight, every checkout-changing call (a mutating tool, or a spawn of a
//      child that may mutate) is refused, and `run_tests` is refused while
//      such a change is in flight — BEFORE the gate;
//   4. read-only call, not gated         → proceed, the gate is never asked;
//   5. mutating call (worker / cortex), or a `gated_tools` call from ANY
//      model (d6/r17: a memory write — `eidetic_remember`; d7: `web_search`
//      and `web_page`, which can send data off the machine — none a repo
//      mutation, so senses keeps them, but none a read either) →
//      `gate.evaluate` with `isMutating: true` (so the read-only fallback
//      refuses it) and the arguments WITHOUT the purpose (issue #20: gate.json
//      stays at version 9), entry recorded to the walk; proceed only on `allow`;
//   6. truncation (risk r15): a gate state cut to fit the decider means CLEF
//      scored only part of the call, so the call is refused even on `allow`.
//      Since d16 the gate never cuts: an oversized state is judged whole by a
//      large-state evaluator (tier `large`, exempt here) or refused.
//
// Any exception anywhere — the gate, the classifier, the walk write — blocks.


/** The contract's test tool (deviation d12); its run restores the checkout afterwards. */
export const RUN_TESTS_TOOL = "run_tests";
/** The contract's child-spawning tool (plan t16). */
export const SPAWN_TOOL = "spawn_subagent";

/**
 * The truncation marker a gate reason carries when a model scored a cut state. Since d16
 * `lib/gate.ts` never sends a cut state, so it no longer writes this; the guard still honours it.
 */
export const GATE_TRUNCATION_MARKER = "state truncated to fit the decider";

export interface ModelGuardOptions {
  readonly toolName: string;
  readonly input: unknown;
  readonly model: ActiveModel;
  readonly registry: ContractModels;
  readonly policy: ContractPolicy;
  /** The session's gate; undefined means the gate could not be built — mutations refuse. */
  readonly gate: Gate | undefined;
  /** The run's task text as the extension knows it (the user prompt); never a tool result. */
  readonly task: string;
  /** Where the run's writes land (d8, `ASSOCIATE_ISOLATION`); absent reads as in-place. */
  readonly isolation?: string;
  readonly scratchDir: string;
  readonly cwd: string;
  readonly declaredWriters?: Iterable<string>;
  readonly declaredNonWriters?: Iterable<string>;
  /** Append the gate entry to the walk. A throw here blocks the call. */
  readonly recordGate: (entry: GateEntry) => void;
  readonly evaluateOptions?: EvaluateOptions;
  /** pi's id for this call; with {@link testWindow}, an allowed call takes a hold under it. */
  readonly toolCallId?: string;
  /** The session's in-flight checkout holds (review r2/5); absent disables the window. */
  readonly testWindow?: TestWindow;
  /**
   * accuracy.json `purpose_exempt_tools`: the tools that need no purpose.
   * Absent means none is exempt (fail closed).
   */
  readonly purposeExemptTools?: readonly string[];
}

/**
 * Whether a `spawn_subagent` call starts a child that may change the checkout.
 * An unknown, missing or non-string child model counts as one that may: the
 * spawn tool would refuse it anyway, and guessing "reader" would be the
 * unsafe side.
 */
function spawnsWriter(input: unknown, registry: ContractModels): boolean {
  const key = input && typeof input === "object" ? (input as Record<string, unknown>).model : undefined;
  if (typeof key !== "string" || !Object.hasOwn(registry.models, key)) return true;
  return registry.models[key]!.may_mutate !== false;
}

/** A refusal whose reason ends with its fix, since the reason is all pi shows the model. */
function block(kind: string, why: string, fix: string): GuardDecision {
  return { block: true, kind, reason: `${why}. Fix: ${fix}`, fix };
}

// ===========================================================================
// The stated purpose (issue #20, spec c7/h43)
// ===========================================================================
//
// Every call except the contract's `purpose_exempt_tools` states, in a
// `purpose` argument, the question it settles and what it expects to see. It
// is enforced here, in the hook, and stays optional in every schema: pi skips
// `tool_call` for a call whose arguments fail the schema, so a required schema
// property would hand the model pi's message, not this fix. The purpose stays
// in the call's input (the walk recorder copies it from there) and is removed
// only from the request built for the safety gate, so what CLEF is asked —
// and gate.json's version — does not change.

/** The argument a call states its purpose in. */
export const PURPOSE_ARG = "purpose";

/** The call's stated purpose, or undefined when it is missing, not a string, or blank. */
export function statedPurpose(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[PURPOSE_ARG];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** The call's arguments without the purpose: what the safety gate is sent. The input is not changed. */
export function withoutPurpose(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input) || !Object.hasOwn(input, PURPOSE_ARG)) return input;
  const { [PURPOSE_ARG]: _omitted, ...rest } = input as Record<string, unknown>;
  return rest;
}

function missingPurpose(toolName: string, exempt: readonly string[]): GuardDecision {
  return block(
    "missing_purpose",
    `associate: '${toolName}' was called without a purpose: the '${PURPOSE_ARG}' argument is missing ` +
      `or empty, and every call${exempt.length ? ` except ${exempt.join(" and ")}` : ""} must state one ` +
      "before it runs; the call did not run",
    `call '${toolName}' again with the same arguments plus a '${PURPOSE_ARG}' string: one sentence on the ` +
      "question this call settles and what you expect to see, e.g. " +
      `{"${PURPOSE_ARG}": "find where the walk file is written; expect a writeFileSync call in lib/walk.ts", ` +
      "...the other arguments}",
  );
}

// ===========================================================================
// The refusal cap (issue #20, spec c53)
// ===========================================================================

/**
 * Counts consecutive refusals of one kind, at most one per model turn. At
 * accuracy.json `refusal_cap` the hook returns `terminate: true` instead of
 * letting the model loop on the same refusal to its time limit (the walk
 * outcome is pinned by the caller only when the run actually ends; see
 * index.ts).
 *
 * Per turn (fix-refusal-cap, live run acc20-worker-gate-thresholds): the calls
 * of one assistant turn are made together, before the model can read any of
 * their refusals, so several same-kind refusals in one turn count once.
 *
 * Across turns, as before: a turn's refusal of the same kind adds one; a
 * refusal of another kind restarts the count at 1; an allowed call restarts
 * it at 0; {@link reset} clears it.
 *
 * Within one turn: an allowed call restarts the count carried from earlier
 * turns, but does not drop a refusal made in the same turn — the turn ends
 * with count 1 for that kind, whichever of the two the hook saw first. (A
 * refusal decided before the turn's allowed call can still report `capped`;
 * pi does not stop a batch that holds a non-terminating result, and the
 * allowed call brings the count back to 1.) Several refusal kinds in one
 * turn: the last one noted is the kind counted.
 *
 * A note without a turn number is its own turn (a host that sends no
 * `turn_start`), which is the one-count-per-call behaviour.
 */
export class RefusalCap {
  private readonly cap: number;
  private kind: string | undefined;
  private count = 0;
  // The turn being counted, and the state carried into it from earlier turns.
  private turn: number | object | undefined;
  private carriedKind: string | undefined;
  private carriedCount = 0;
  private allowedThisTurn = false;
  private refusedThisTurn = false;

  constructor(cap: number) {
    if (!Number.isInteger(cap) || cap < 1) {
      throw new Error(`accuracy.json refusal_cap must be a positive integer, got ${JSON.stringify(cap)}`);
    }
    this.cap = cap;
  }

  /**
   * Note one decision made in `turn`; `capped` is true when this refusal
   * reaches the cap. With no `turn`, the decision is its own turn.
   */
  note(decision: GuardDecision | undefined, turn?: number): { capped: boolean; count: number } {
    const current = turn ?? {};
    if (current !== this.turn) {
      this.turn = current;
      this.carriedKind = this.kind;
      this.carriedCount = this.count;
      this.allowedThisTurn = false;
      this.refusedThisTurn = false;
    }
    if (!decision?.block) {
      this.allowedThisTurn = true;
      if (this.refusedThisTurn) this.count = 1;
      else {
        this.kind = undefined;
        this.count = 0;
      }
      return { capped: false, count: this.count };
    }
    this.refusedThisTurn = true;
    const carried = !this.allowedThisTurn && this.carriedKind === decision.kind ? this.carriedCount : 0;
    this.kind = decision.kind;
    this.count = carried + 1;
    return { capped: this.count >= this.cap, count: this.count };
  }

  reset(): void {
    this.kind = undefined;
    this.count = 0;
    this.turn = undefined;
    this.carriedKind = undefined;
    this.carriedCount = 0;
    this.allowedThisTurn = false;
    this.refusedThisTurn = false;
  }

  get limit(): number {
    return this.cap;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Decide one tool call under the active model's guard. Never throws. */
export async function decideToolCall(options: ModelGuardOptions): Promise<GuardDecision | undefined> {
  try {
    return await decide(options);
  } catch (error) {
    return block(
      "guard_failed",
      `associate: the tool_call guard failed (${errorText(error)}); the call is refused`,
      "call again once; if it fails the same way, do not keep retrying: report it in finish",
    );
  }
}

async function decide(options: ModelGuardOptions): Promise<GuardDecision | undefined> {
  const { toolName, model } = options;

  // 1. No model, no tools.
  if (!model.entry || model.key === undefined) {
    return block(
      "no_model",
      model.problem ?? "associate: no active model is selected; every tool call is refused",
      "no tool can run in this session; reply in text that the operator must select a registry model",
    );
  }

  // 2. The model's own tool set, checked on every call (r8).
  if (!model.tools.has(toolName)) {
    return block(
      "not_in_tool_set",
      `associate: '${toolName}' is not in the tool set of the active model '${model.key}' ` +
        `(${[...model.tools].join(", ")}); the call is refused`,
      `use one of the tools listed, or hand the step back with 'finish'`,
    );
  }

  // 2b. issue #20: a stated purpose, before anything is judged or gated.
  const exempt = options.purposeExemptTools ?? [];
  if (!exempt.includes(toolName) && statedPurpose(options.input) === undefined) {
    return missingPurpose(toolName, exempt);
  }

  const mutating = isMutatingCall(toolName, options.input, options.registry, options.policy);
  // d6 / r17, d7: not a repo mutation, but gated for every model. A registry
  // without the list (an older contract) gates nothing extra; the Python
  // validator makes the list required for the shipped contract.
  const gated = !mutating && (options.registry.gated_tools ?? []).includes(toolName);

  // 3. A model that may not mutate: repo mutations are refused before the
  //    gate, never asked. A gated tool falls through to the gate below.
  if (!model.mayMutate) {
    if (mutating) {
      return block(
        "may_not_mutate",
        `associate: '${toolName}' can change something and the active model '${model.key}' may ` +
          "not mutate (models.json may_mutate: false)",
        "do not make the change; describe it and hand the work back with 'finish' instead",
      );
    }
    const confined = evaluateToolCall({
      toolName,
      input: options.input,
      scratchDir: options.scratchDir,
      cwd: options.cwd,
      declaredWriters: options.declaredWriters,
      declaredNonWriters: options.declaredNonWriters,
    });
    if (confined || !gated) return confined;
  } else {
    // r2/2: a may_mutate model's writes stay inside the run's checkout.
    const escaped = confineWriteToCheckout({
      toolName,
      input: options.input,
      checkoutRoot: options.cwd,
      scratchDir: options.scratchDir,
      cwd: options.cwd,
      declaredWriters: options.declaredWriters,
      declaredNonWriters: options.declaredNonWriters,
    });
    if (escaped) return escaped;
  }

  // 3b. r2/5: a test run and a change never overlap.
  const window = options.testWindow;
  const holds: "tests" | "change" | undefined = !model.mayMutate
    ? undefined
    : toolName === RUN_TESTS_TOOL
      ? "tests"
      : mutating || (toolName === SPAWN_TOOL && spawnsWriter(options.input, options.registry))
        ? "change"
        : undefined;
  if (window && holds) {
    if (window.testsRunning()) {
      return block(
        "tests_running",
        `associate: '${toolName}' could change the checkout while run_tests is restoring it; ` +
          "tests are running; retry after run_tests returns",
        `wait for run_tests to return, then call '${toolName}' again`,
      );
    }
    if (holds === "tests" && window.changesInFlight()) {
      return block(
        "change_in_flight",
        "associate: run_tests would snapshot and restore the checkout while a change to the checkout " +
          "is still in progress; retry run_tests after that call returns",
        "wait for the pending change to return, then call run_tests again",
      );
    }
  }
  const allow = (): undefined => {
    if (window && holds && options.toolCallId !== undefined) window.begin(options.toolCallId, holds);
    return undefined;
  };

  // 4. A pure read never reaches the decider.
  if (!mutating && !gated) return allow();

  // 5. Every mutation, and every gated call, goes through the gate.
  if (!options.gate) {
    return block(
      "gate_unavailable",
      `associate: '${toolName}' is a ${gated ? "gated" : "mutating"} call and the safety gate is ` +
        "unavailable; the call is refused",
      "do not retry it; describe the change you would make and hand it back with 'finish'",
    );
  }
  // d20: a write that replaces a file is shown to the gate as its change too.
  const change = options.gate.config.changeAppliesTo.includes(toolName)
    ? describeWriteChange({
        toolName,
        input: options.input,
        checkoutRoot: options.cwd,
        cwd: options.cwd,
        maxFileBytes: options.gate.config.changeMaxFileBytes,
        maxRenderBytes: options.gate.config.changeMaxRenderBytes,
      })
    : undefined;
  const request = {
    task: options.task,
    action: toolName,
    // issue #20: the purpose is recorded in the walk, never scored by the gate.
    arguments: withoutPurpose(options.input),
    model: model.key,
    isolation: options.isolation,
    ...(change !== undefined ? { change } : {}),
    isMutating: true,
  } as const;
  // The state is built once, here, and handed to the gate: step 6 needs to
  // know whether it was cut. One that cannot be built is left to the gate,
  // which refuses the call and says why.
  let built: ReturnType<typeof buildGateState> | undefined;
  try {
    built = buildGateState(options.gate.config, request);
  } catch {
    built = undefined;
  }
  const entry = await options.gate.evaluate(request, {
    ...(options.evaluateOptions ?? {}),
    ...(built ? { state: built } : {}),
  });

  // 6. r15: a model that scored a cut state scored only part of the call. Since
  //    d16 an oversized state is never cut: the gate sends it whole to a
  //    large-state evaluator (tier `large`) or refuses it. This check stays as
  //    defence in depth for any allow from a tier that could have seen a cut
  //    state (clef/super), and for the gate's own truncation marker.
  let truncated = entry.tier !== "large" && (built === undefined || built.truncated);
  truncated ||= typeof entry.reason === "string" && entry.reason.includes(GATE_TRUNCATION_MARKER);
  // A refusal at the read-only tier asked nobody, so there is no partial score to note.
  if (truncated && (entry.decision === "allow" || entry.tier !== "readonly")) {
    const note =
      "refused by the associate tool_call hook: the gate state was truncated, so the decider " +
      `scored only part of this ${gated ? "gated" : "mutating"} call (risk r15)`;
    entry.reason = entry.reason ? `${entry.reason}; ${note}` : note;
    entry.decision = "refuse";
  }

  // Recorded before the call runs, whatever the decision; a failed write blocks.
  options.recordGate(entry);

  if (entry.decision !== "allow") {
    const why =
      typeof entry.reason === "string" && entry.reason.trim()
        ? entry.reason
        : `${entry.tier}: refused without a stated reason (treated as unsafe)`;
    return block(
      "gate_refused",
      `associate: the safety gate refused '${toolName}' (${entry.id}, tier ${entry.tier}): ${why}`,
      "do not send the same call again; make the change smaller and closer to what the task asks, " +
        "or describe it in 'finish' and leave it to the operator",
    );
  }
  return allow();
}
