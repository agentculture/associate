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

import { isAbsolute, resolve } from "node:path";
import { isInside } from "./session.ts";
import { buildGateState } from "./gate.ts";
import type { EvaluateOptions, Gate, GateEntry } from "./gate.ts";
import type { ContractModels, ContractPolicy } from "./contract.ts";
import { isMutatingCall, type ActiveModel } from "./toolset.ts";

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

export interface GuardDecision {
  readonly block: true;
  readonly reason: string;
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
    return {
      block: true,
      reason:
        `associate: '${options.toolName}' can modify a checkout and declares no path to confine. ` +
        `associate hands work back instead of enacting it; write under ${options.scratchDir} instead.`,
    };
  }

  for (const target of targets) {
    const resolved = isAbsolute(target) ? resolve(target) : resolve(options.cwd, target);
    if (!isInside(options.scratchDir, resolved)) {
      return {
        block: true,
        reason:
          `associate: '${options.toolName}' would write to ${resolved}, outside this session's ` +
          `scratch directory ${options.scratchDir}. The associate role is forbidden repo_action; ` +
          "drafts are returned through the 'finish' tool, never written into the checkout.",
      };
    }
  }

  return undefined;
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
//   3. model may not mutate (senses):
//        mutating call → refuse, BEFORE the gate (the decider is never asked);
//        otherwise the scratch-dir write confinement above still applies;
//   4. read-only call, not gated         → proceed, the gate is never asked;
//   5. mutating call (worker / cortex), or a `gated_tools` call from ANY
//      model (d6/r17: a memory write — `eidetic_remember`; d7: `web_search`
//      and `web_page`, which can send data off the machine — none a repo
//      mutation, so senses keeps them, but none a read either) →
//      `gate.evaluate` with `isMutating: true` (so the read-only fallback
//      refuses it), entry recorded to the walk; proceed only on `allow`;
//   6. truncation (risk r15): a gate state cut to fit the decider means CLEF
//      scored only part of the call, so the call is refused even on `allow`.
//
// Any exception anywhere — the gate, the classifier, the walk write — blocks.


/** The truncation marker `lib/gate.ts` appends to a reason when the state was cut. */
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
}

function block(reason: string): GuardDecision {
  return { block: true, reason };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Decide one tool call under the active model's guard. Never throws. */
export async function decideToolCall(options: ModelGuardOptions): Promise<GuardDecision | undefined> {
  try {
    return await decide(options);
  } catch (error) {
    return block(`associate: the tool_call guard failed (${errorText(error)}); the call is refused`);
  }
}

async function decide(options: ModelGuardOptions): Promise<GuardDecision | undefined> {
  const { toolName, model } = options;

  // 1. No model, no tools.
  if (!model.entry || model.key === undefined) {
    return block(model.problem ?? "associate: no active model is selected; every tool call is refused");
  }

  // 2. The model's own tool set, checked on every call (r8).
  if (!model.tools.has(toolName)) {
    return block(
      `associate: '${toolName}' is not in the tool set of the active model '${model.key}' ` +
        `(${[...model.tools].join(", ")}); the call is refused`,
    );
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
        `associate: '${toolName}' can change something and the active model '${model.key}' may ` +
          "not mutate (models.json may_mutate: false); hand the work back with 'finish' instead",
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
  }

  // 4. A pure read never reaches the decider.
  if (!mutating && !gated) return undefined;

  // 5. Every mutation, and every gated call, goes through the gate.
  if (!options.gate) {
    return block(
      `associate: '${toolName}' is a ${gated ? "gated" : "mutating"} call and the safety gate is ` +
        "unavailable; the call is refused",
    );
  }
  const request = {
    task: options.task,
    action: toolName,
    arguments: options.input,
    model: model.key,
    isolation: options.isolation,
    isMutating: true,
  } as const;
  const entry = await options.gate.evaluate(request, options.evaluateOptions ?? {});

  // 6. r15: a truncated state means the decider scored only part of the call.
  let truncated: boolean;
  try {
    truncated = buildGateState(options.gate.config, request).truncated;
  } catch {
    truncated = true;
  }
  truncated ||= typeof entry.reason === "string" && entry.reason.includes(GATE_TRUNCATION_MARKER);
  if (truncated) {
    const note =
      "refused by the associate tool_call hook: the gate state was truncated, so the decider " +
      `scored only part of this ${gated ? "gated" : "mutating"} call (risk r15)`;
    entry.reason = entry.reason ? `${entry.reason}; ${note}` : note;
    entry.decision = "refuse";
  }

  // Recorded before the call runs, whatever the decision; a failed write blocks.
  options.recordGate(entry);

  if (entry.decision !== "allow") {
    return block(
      `associate: the safety gate refused '${toolName}' (${entry.id}, tier ${entry.tier})` +
        (entry.reason ? `: ${entry.reason}` : ""),
    );
  }
  return undefined;
}
