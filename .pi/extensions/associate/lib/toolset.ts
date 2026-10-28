/**
 * Per-model tool sets and the mutating-call classifier (plan t12).
 *
 * The user's decision (q17/q21/q22) makes this the security boundary: only
 * `senses` is barred from changing things; `worker` (bolt) and `cortex` may
 * call every mutating tool and command, any mesh peer may trigger them, and
 * the CLEF gate (`lib/gate.ts`) is the only control in front of a mutation.
 * So everything here **fails closed**:
 *
 *   - the active model is resolved exactly as the provider resolves it
 *     (`$ASSOCIATE_MODEL`, else the registry default); an unknown or pending
 *     key yields NO tool set at all, so every call is blocked;
 *   - a model's tool set is its `models.json` `tools` list, verbatim — a tool
 *     not on it (an `mcp__*` tool from pi's built-in MCP, `codemode`,
 *     `tool_search`, `powershell`, anything another extension registers) is
 *     never active and is refused at `tool_call`;
 *   - a call is MUTATING when its tool is on `models.json` `mutating_tools`,
 *     except that `bash` — the extension's argv-only shell — is judged per
 *     call: read-only only when its argv is in `policy.shell.read_only`,
 *     mutating otherwise. A call that cannot be classified is mutating.
 *
 * Imports node builtins, sibling libs and the shell tool's own argv checker
 * only — no pi runtime import — so it runs under `node --test`.
 */

import type { ContractModels, ContractPolicy, ModelEntry } from "./contract.ts";
import { policySection } from "./contract.ts";
import { resolveProviderSettings, type Env } from "./provider.ts";
import { refuseArgv, SHELL_TOOL_NAME } from "../tools/shell.ts";

// ------------------------------------------------------------- active model

export interface ActiveModel {
  /** The registry key (`worker`, `senses`, …), or undefined when none resolved. */
  readonly key: string | undefined;
  readonly entry: ModelEntry | undefined;
  /** The model's `tools`, exactly as the registry lists them; empty without a model. */
  readonly tools: ReadonlySet<string>;
  /** The registry's `may_mutate`; false without a model. */
  readonly mayMutate: boolean;
  /** Why no model resolved (printed and returned as the block reason). */
  readonly problem?: string;
}

/**
 * The active registry model, resolved the way `lib/provider.ts` resolves it.
 *
 * Reuses `resolveProviderSettings` with a placeholder key (as `tools/read.ts`
 * does): the provider's API-key gate is irrelevant to which model is active,
 * and the selection rule must not exist twice.
 */
export function resolveActiveModel(env: Env, registry: ContractModels): ActiveModel {
  const resolved = resolveProviderSettings({ ...env, ASSOCIATE_API_KEY: "unused" }, registry);
  if (!resolved.ok) {
    return {
      key: undefined,
      entry: undefined,
      tools: new Set(),
      mayMutate: false,
      problem:
        resolved.hint.replace(/; no associate provider registered\./, "") +
        " Every tool call is refused until a known, active model is selected.",
    };
  }
  const key = resolved.settings.selectedKey;
  const entry = resolved.settings.activeModels[key]!;
  return {
    key,
    entry,
    tools: new Set(entry.tools),
    // Strictly `true`: a missing or malformed field is a model that may not mutate.
    mayMutate: entry.may_mutate === true,
  };
}

/**
 * The tool names to hand `pi.setActiveTools`: the model's `tools` intersected
 * with what pi actually has (`getAllTools()` — the extension's tools plus pi's
 * configured built-ins such as `write`/`edit`). For a model that may not
 * mutate, anything `isWriter` names is removed as well (defence in depth: the
 * registry already keeps writers off senses' list).
 */
export function activeToolSet(
  model: ActiveModel,
  available: Iterable<string>,
  isWriter: (name: string) => boolean,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of available) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!model.tools.has(name)) continue;
    if (!model.mayMutate && isWriter(name)) continue;
    out.push(name);
  }
  return out;
}

/** Registered tool names the contract's `tool_names` does not list. */
export function toolsOutsideContract(registered: Iterable<string>, registry: ContractModels): string[] {
  const known = new Set(registry.tool_names);
  return [...new Set(registered)].filter((name) => !known.has(name)).sort();
}

// ------------------------------------------------- read-only shell subset

/** One entry of `policy.shell.read_only.commands`, parsed. */
export interface ReadOnlyShellCommand {
  readonly command: string;
  /** Read-only subcommands; empty = the command itself is read-only. */
  readonly subcommands: readonly string[];
  readonly unsafeOptions: readonly string[];
  readonly unsafeShortFlags: readonly string[];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * The read-only shell subset, read from `policy.shell.read_only` (risk r9).
 *
 * `policy.shell.allowlist` is a PERMISSION list — what the shell runs at all —
 * and since t4 it holds `eidetic remember` and `ledger append`, which write.
 * Being on the allowlist therefore says nothing about being read-only; the
 * contract states the read-only subset separately, and this only parses it.
 * A missing or malformed section yields an empty subset: every shell call is
 * then mutating and gated (fail closed).
 */
export function readOnlyShell(policy: ContractPolicy): Map<string, ReadOnlyShellCommand> {
  const out = new Map<string, ReadOnlyShellCommand>();
  const section = policySection(policy, "shell").read_only;
  const commands =
    section && typeof section === "object" ? (section as Record<string, unknown>).commands : undefined;
  for (const raw of Array.isArray(commands) ? commands : []) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.command !== "string" || !entry.command) continue;
    out.set(entry.command, {
      command: entry.command,
      subcommands: stringList(entry.subcommands),
      unsafeOptions: stringList(entry.unsafe_options),
      unsafeShortFlags: stringList(entry.unsafe_short_flags),
    });
  }
  return out;
}

/**
 * True when `token` names one of `rule`'s unsafe options: `--opt`,
 * `--opt=value`, or any abbreviation `--o…` of it (git accepts unambiguous
 * long-option prefixes, so `--outp=f` IS `--output=f`); or a single-dash
 * cluster (`-Hx`) containing an unsafe short flag.
 */
export function isUnsafeOption(token: string, rule: ReadOnlyShellCommand): boolean {
  if (token.startsWith("--") && token.length > 2) {
    const name = token.split("=", 1)[0]!;
    return rule.unsafeOptions.some((option) => option === name || (name.length > 2 && option.startsWith(name)));
  }
  if (token.startsWith("-") && token.length > 1) {
    return rule.unsafeShortFlags.some((flag) => token.slice(1).includes(flag));
  }
  return false;
}

/**
 * True when `argv` is a read-only shell call: the shell's own allowlist check
 * accepts it, it matches a `read_only` entry (and subcommand, where the entry
 * names any), and it carries none of that entry's unsafe options.
 */
export function isReadOnlyArgv(argv: unknown, policy: ContractPolicy): boolean {
  if (!Array.isArray(argv) || argv.length === 0) return false;
  if (!argv.every((token) => typeof token === "string")) return false;
  const tokens = argv as string[];
  // The shell itself would refuse it (not allowlisted, an operator, …): not a
  // read we can vouch for, so it is classified like any other unknown.
  if (refuseArgv(tokens, policy) !== null) return false;
  const rule = readOnlyShell(policy).get(tokens[0]!);
  if (!rule) return false;
  const hasSubcommand = rule.subcommands.length > 0;
  if (hasSubcommand && !rule.subcommands.includes(tokens[1] ?? "")) return false;
  return !tokens.slice(hasSubcommand ? 2 : 1).some((token) => isUnsafeOption(token, rule));
}

// ------------------------------------------------------------ classifier

/**
 * Whether one tool call can change something, for the gate's `isMutating`.
 *
 * `bash` is judged per call (read-only argv → false, anything else → true),
 * whatever `mutating_tools` says about the name. Every other tool is mutating
 * when `mutating_tools` lists it. A tool the registry does not know at all is
 * mutating — though the per-model set check refuses it before this is asked.
 */
export function isMutatingCall(
  toolName: string,
  input: unknown,
  registry: ContractModels,
  policy: ContractPolicy,
): boolean {
  if (toolName === SHELL_TOOL_NAME) {
    const argv = input && typeof input === "object" ? (input as Record<string, unknown>).argv : undefined;
    return !isReadOnlyArgv(argv, policy);
  }
  if (!registry.tool_names.includes(toolName)) return true;
  return registry.mutating_tools.includes(toolName);
}
