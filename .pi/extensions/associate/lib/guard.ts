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

/**
 * Pi's built-in tool names that can persist a change to a checkout.
 *
 * Not a policy value: this is the Pi-side fact of which built-in names write,
 * documented in pi docs/extensions.md ("Overriding Built-in Tools" lists
 * `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`). `bash` is included
 * because pi's built-in bash is an unrestricted write path (spec c35); the
 * extension's own allowlisted shell registers under a different contract and
 * declares itself a non-writer.
 */
export const BUILTIN_WRITER_TOOLS: readonly string[] = [
  "write",
  "edit",
  "multi_edit",
  "multiedit",
  "apply_patch",
  "notebook_edit",
  "bash",
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
}

/** Whether a tool call can persist a change, by name. */
export function isWriterTool(toolName: string, declaredWriters?: Iterable<string>): boolean {
  const name = toolName.toLowerCase();
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
  if (!isWriterTool(options.toolName, options.declaredWriters)) return undefined;

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
