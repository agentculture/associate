/**
 * Injecting this lane's runtime prompt when context-file discovery is off.
 *
 * The problem (risk r16, measured): Pi loads `AGENTS.md` / `CLAUDE.md` from
 * **every ancestor directory** of the working directory, not just the checkout
 * (pi `docs/usage.md`, "Context Files"). associate's checkouts live in a
 * workspace whose parent directory carries its own `CLAUDE.md` — instructions
 * written for a Claude Code session working *on* a repo, not for a read-only
 * scout examining one. Those leak straight into the system prompt and quietly
 * re-task the lane.
 *
 * The fix is two-sided, and neither side works alone:
 *
 * 1. the Python launcher passes `--no-context-files`, which turns the whole
 *    ancestor walk off — including the checkout's own file;
 * 2. this module puts the checkout's own `AGENTS.md` back, and only that file.
 *
 * It is opt-in through `$ASSOCIATE_INJECT_PROMPT` so an interactive `pi` run
 * inside the checkout — where context files are loaded normally — does not end
 * up with `AGENTS.md` twice. Nothing is registered when the variable is unset.
 *
 * Like `lib/torch.ts`, the injection rides `before_agent_start` and fires
 * exactly once: a later turn must not re-paste the prompt it already has.
 * Additive only — the handler returns a message and never blocks, replaces or
 * rewrites anything.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssociateContext } from "./context.ts";

/** The environment variable that turns the injection on. */
export const INJECT_PROMPT_ENV = "ASSOCIATE_INJECT_PROMPT";

/** `customType` of the injected message, so a reader can tell where it came from. */
export const PROMPT_MESSAGE_TYPE = "associate-runtime-prompt";

/** The one file this module will read, relative to the checkout root. */
export const RUNTIME_PROMPT_FILENAME = "AGENTS.md";

/** True when the launcher asked for the runtime prompt to be injected. */
export function shouldInjectPrompt(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = (env[INJECT_PROMPT_ENV] ?? "").trim().toLowerCase();
  return value !== "" && value !== "0" && value !== "false" && value !== "no";
}

/**
 * The checkout's own `AGENTS.md`, or `undefined` when it has none.
 *
 * Exactly one path is read — `<checkoutRoot>/AGENTS.md`. No ancestor is
 * consulted, which is the whole point: an ancestor file is what
 * `--no-context-files` was passed to exclude.
 */
export function readRuntimePrompt(checkoutRoot: string): string | undefined {
  const path = join(checkoutRoot, RUNTIME_PROMPT_FILENAME);
  if (!existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, "utf8");
    return text.trim() ? text : undefined;
  } catch {
    // An unreadable prompt file is reported by the caller returning false, not
    // by crashing the session at load.
    return undefined;
  }
}

/** The message text: a labelled header, then the file verbatim. */
export function renderRuntimePrompt(text: string, source: string): string {
  return [
    `# ${RUNTIME_PROMPT_FILENAME} — this lane's runtime prompt`,
    "",
    `Loaded from ${source}. Ancestor context files are deliberately not loaded:`,
    "only this checkout's own prompt applies to this run.",
    "",
    text.trimEnd(),
    "",
  ].join("\n");
}

/**
 * Install the injection on a pi instance.
 *
 * Returns false — registering nothing at all — when the variable is unset or
 * the checkout has no `AGENTS.md`, so an ordinary session gains no handler.
 */
export function installPromptInjection(
  pi: {
    on(event: string, handler: (event: Record<string, unknown>) => unknown): void;
  },
  ctx: AssociateContext,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!shouldInjectPrompt(env)) return false;

  const text = readRuntimePrompt(ctx.checkoutRoot);
  if (text === undefined) return false;

  const source = join(ctx.checkoutRoot, RUNTIME_PROMPT_FILENAME);
  let injected = false;
  pi.on("before_agent_start", () => {
    if (injected) return undefined;
    injected = true;
    return {
      message: {
        customType: PROMPT_MESSAGE_TYPE,
        content: renderRuntimePrompt(text, source),
        display: false,
      },
    };
  });
  return true;
}
