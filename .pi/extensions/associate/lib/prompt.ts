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
 *
 * Per-model prompts (t11): the active registry model's own prompt file
 * (`models.json` `prompt_file`, repo-relative) rides ALONGSIDE `AGENTS.md` in
 * the same single message. `AGENTS.md` stays the general, acp-facing prompt
 * file on disk (culture's backend-consistency check and pi-acp both read it);
 * the model file carries what is specific to one model — its exact tools,
 * whether it may change things, and who it may spawn. The model file comes
 * last so it is the more specific instruction.
 *
 * Two different trust sources, on purpose:
 *
 *   - `AGENTS.md` is the CHECKOUT's own file (r16: what pi itself would have
 *     loaded from the working directory, minus the ancestors);
 *   - the model file is ASSOCIATE's own, resolved against the repo holding
 *     this extension (`lib/paths.ts` `associateRoot`), never the checkout. A
 *     foreign checkout has no such file, and a hostile one could commit its
 *     own `.pi/extensions/associate/prompts/worker.md` to be injected as the
 *     "more specific" instruction.
 *
 * The active model is the one `lib/toolset.ts` `resolveActiveModel` resolved
 * — `index.ts` passes its load-time result in — so a pending or unknown key,
 * which gets no tool set, gets no model prompt either.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import type { ModelEntry } from "./contract.ts";
import type { AssociateContext } from "./context.ts";
import { associateRoot } from "./paths.ts";
import { resolveActiveModel, type ActiveModel } from "./toolset.ts";

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

/**
 * The active model's own prompt file, `entry.prompt_file` resolved against
 * the associate repo that holds this extension (`root`, default
 * `associateRoot`) — never the checkout under examination. `undefined` when
 * the file is missing, empty, or the path would leave `root`.
 */
export function readModelPrompt(
  entry: ModelEntry,
  root: string = associateRoot,
): { text: string; source: string } | undefined {
  const base = resolve(root);
  const source = resolve(base, entry.prompt_file);
  const rel = relative(base, source);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  if (!existsSync(source)) return undefined;
  try {
    const text = readFileSync(source, "utf8");
    return text.trim() ? { text, source } : undefined;
  } catch {
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
 * there is neither a checkout `AGENTS.md` nor a model prompt, so an ordinary
 * session gains no handler. `active` is the model `index.ts` resolved at load
 * (`resolveActiveModel`); it is only re-resolved from `env` when omitted.
 */
export function installPromptInjection(
  pi: {
    on(event: string, handler: (event: Record<string, unknown>) => unknown): void;
  },
  ctx: AssociateContext,
  env: Record<string, string | undefined> = process.env,
  active: ActiveModel = resolveActiveModel(env, ctx.contract.models),
): boolean {
  if (!shouldInjectPrompt(env)) return false;

  const text = readRuntimePrompt(ctx.checkoutRoot);
  const selected =
    active.key !== undefined && active.entry !== undefined ? { key: active.key, entry: active.entry } : undefined;
  const model = selected ? readModelPrompt(selected.entry) : undefined;
  if (text === undefined && model === undefined) return false;

  const parts: string[] = [];
  if (text !== undefined) {
    parts.push(renderRuntimePrompt(text, join(ctx.checkoutRoot, RUNTIME_PROMPT_FILENAME)));
  }
  if (model !== undefined && selected !== undefined) {
    parts.push(
      [
        `# Model prompt — ${selected.key} (${selected.entry.label})`,
        "",
        `Loaded from ${model.source}. It is more specific than the general prompt`,
        "above: where they differ, this one applies to you.",
        "",
        model.text.trimEnd(),
        "",
      ].join("\n"),
    );
  }
  const content = parts.join("\n---\n\n");
  let injected = false;
  pi.on("before_agent_start", () => {
    if (injected) return undefined;
    injected = true;
    return {
      message: {
        customType: PROMPT_MESSAGE_TYPE,
        content,
        display: false,
      },
    };
  });
  return true;
}
