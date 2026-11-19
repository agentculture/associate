/**
 * Loading the portable contract from the Python package.
 *
 * Spec c46/c50: the permission boundary and the artifact schemas live in
 * `associate/contract/` and are read by every adapter; the runtime prompt,
 * tool descriptions and result presentation are Pi-tailored and live here.
 * The rule that follows is absolute: **no policy value is defined in
 * TypeScript**. This module only locates and parses the JSON.
 *
 * Resolution order for the contract directory:
 *   1. `$ASSOCIATE_CONTRACT_DIR` — set by the Python adapter, which knows
 *      where the installed package is even when the checkout under
 *      examination is some other repo;
 *   2. otherwise walk up from this extension looking for
 *      `associate/contract/policy.json`, so a bare `pi` in a checkout of this
 *      repo works with no environment at all.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { extensionDir } from "./paths.ts";

/** Short names of the contract schemas, matching `associate/contract/schemas/`. */
export const SCHEMA_NAMES = ["task", "walk", "statements"] as const;

export type SchemaName = (typeof SCHEMA_NAMES)[number];

/**
 * The parsed `policy.json`.
 *
 * Deliberately typed as an open record: the fields are the contract's to
 * define and change, and mirroring them as required TypeScript properties
 * would re-encode contract shape here — exactly what c46 forbids. The one
 * field named explicitly is `version`, because the sentinel reports it.
 */
export type ContractPolicy = {
  version?: number;
  [key: string]: unknown;
};

export type ReasoningSetting = "model-default" | "on" | "off";

/** One `models.json` entry. Field names are the contract's, not ours. */
export interface ModelEntry {
  readonly status: "active" | "pending";
  readonly label: string;
  readonly lobes_role: string;
  readonly input: readonly ("text" | "image")[];
  readonly reasoning: ReasoningSetting;
  readonly tools: readonly string[];
  readonly prompt_file: string;
  readonly may_mutate: boolean;
  readonly may_spawn: readonly string[];
  /**
   * Deviation d18: registry models this model may hand a task to through
   * `delegate_run`. Absent (an older contract) reads as none.
   */
  readonly may_delegate?: readonly string[];
}

/** The parsed `models.json`. */
export interface ContractModels {
  readonly version: number;
  /** Registry key used when `ASSOCIATE_MODEL` is unset. */
  readonly default: string;
  readonly endpoint: { readonly default_base_url: string };
  /** The canonical tool-name set (checked against registration by another task). */
  readonly tool_names: readonly string[];
  readonly mutating_tools: readonly string[];
  /**
   * Tools that are not repo mutations but pass the safety gate for every
   * model, senses included (d6/r17: `eidetic_remember`; d7: `web_search`,
   * `web_page`).
   * Disjoint from `mutating_tools` — the Python validator enforces it.
   */
  readonly gated_tools: readonly string[];
  readonly models: Readonly<Record<string, ModelEntry>>;
}

/** The parsed `gate.json`; open record, the gate library owns its shape. */
export type ContractGate = { version?: number; [key: string]: unknown };

/** How strictly the accuracy checks bind one model: report only, or refuse. */
export type AccuracyMode = "report" | "enforce";

/** The six source kinds a walk entry can carry, set by the harness from the tool. */
export type SourceKind = "file" | "tool" | "web" | "memory" | "agent" | "harness";

/** One accuracy check; the contract owns the ids, this only names the fields. */
export interface AccuracyCheck {
  readonly id: string;
  readonly strength: "refuse" | "flag";
  readonly motivating_failure: string;
}

/**
 * The support-score settings of `accuracy.json`: the decider is asked, for a
 * fact whose quote was found, one choice question, how much of the value the
 * quote on its own shows (plan deviation d4). Report-only. Field names are
 * the contract's; no value is restated here.
 */
export interface SupportScoreSettings {
  /** The choice question, sent as written. */
  readonly question: string;
  /** What the decider is told before each pair, sent as written; optional. */
  readonly background?: string;
  /** The question's answers, in order: option key -> the criterion the decider is given. */
  readonly options: Readonly<Record<string, string>>;
  /** The option keys reported as the quote supporting the value. */
  readonly passes: readonly string[];
  /** Time allowed for one fact's request. */
  readonly timeout_ms: number;
  /** Most facts scored for one hand-back. */
  readonly max_facts: number;
  /** Time allowed for all scoring of one hand-back. */
  readonly total_timeout_ms: number;
  /** Registry model key -> switch. */
  readonly enabled: Readonly<Record<string, boolean>>;
}

/**
 * The finish-reminder settings of `accuracy.json` (deviation d3): what is sent
 * to a model whose task run is about to settle without an accepted finish, and
 * how many times per session. Field names are the contract's.
 */
export interface FinishReminderSettings {
  /** How many reminders one session may send (at least 1). */
  readonly max: number;
  /** The reminder sent to the model, as written. */
  readonly text: string;
}

/** The parsed `accuracy.json`. Values are the contract's; none is restated here. */
export interface ContractAccuracy {
  readonly version: number;
  /** Registry model key -> mode. */
  readonly mode: Readonly<Record<string, AccuracyMode>>;
  readonly retry_rounds: number;
  readonly refusal_cap: number;
  readonly min_quote_length: number;
  /** Absent in a file written before the support score: the score is then off. */
  readonly support_score?: SupportScoreSettings;
  /** Absent in a file written before the finish reminder: no reminder is sent. */
  readonly finish_reminder?: FinishReminderSettings;
  /** Tool name -> source kind. */
  readonly source_kinds: Readonly<Record<string, SourceKind>>;
  readonly purpose_exempt_tools: readonly string[];
  readonly checks: readonly AccuracyCheck[];
  /**
   * Reason a checker gives -> id of the check it counts under. The checker
   * (`lib/facts.ts`) owns the reason names; the contract owns the check ids,
   * so no check id is written in TypeScript.
   */
  readonly refusal_checks: Readonly<Record<string, string>>;
}

export type ContractSchemas = Readonly<Record<SchemaName, unknown>>;

export interface Contract {
  /** Absolute path of the directory the contract was read from. */
  readonly dir: string;
  /** How the directory was found: the env var, or the repo-relative fallback. */
  readonly source: "env" | "repo";
  readonly policy: ContractPolicy;
  readonly schemas: ContractSchemas;
  readonly models: ContractModels;
  readonly gate: ContractGate;
  readonly accuracy: ContractAccuracy;
  /** `policy.json`'s `version`, or 0 when it declares none. */
  readonly version: number;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isContractDir(candidate: string): boolean {
  return existsSync(join(candidate, "policy.json")) && existsSync(join(candidate, "schemas"));
}

/**
 * Walk up from `start` looking for `associate/contract/`.
 *
 * Returns `undefined` rather than throwing so the caller can report both
 * failures — env var set but wrong, and nothing found — in one message.
 */
export function findRepoContractDir(start: string = extensionDir): string | undefined {
  let current = resolve(start);
  for (;;) {
    const candidate = join(current, "associate", "contract");
    if (isContractDir(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Resolve the contract directory, preferring `$ASSOCIATE_CONTRACT_DIR`.
 *
 * Throws when the env var points somewhere that is not a contract directory:
 * silently falling back would let a stale in-repo contract shadow the one the
 * adapter meant to pin, and the policy is a permission boundary.
 */
export function resolveContractDir(
  env: Record<string, string | undefined> = process.env,
  start: string = extensionDir,
): { dir: string; source: "env" | "repo" } {
  const fromEnv = env.ASSOCIATE_CONTRACT_DIR?.trim();
  if (fromEnv) {
    const dir = resolve(fromEnv);
    if (!isContractDir(dir)) {
      throw new Error(
        `ASSOCIATE_CONTRACT_DIR=${fromEnv} is not an associate contract directory ` +
          "(expected policy.json and schemas/ inside it)",
      );
    }
    return { dir, source: "env" };
  }

  const dir = findRepoContractDir(start);
  if (!dir) {
    throw new Error(
      "no associate contract found: set ASSOCIATE_CONTRACT_DIR to the installed " +
        "associate/contract directory, or run from a checkout that carries one",
    );
  }
  return { dir, source: "repo" };
}

/** Load `policy.json`, `models.json`, `gate.json`, `accuracy.json` and every schema from the resolved contract directory. */
export function loadContract(
  env: Record<string, string | undefined> = process.env,
  start: string = extensionDir,
): Contract {
  const { dir, source } = resolveContractDir(env, start);
  const policy = readJson(join(dir, "policy.json")) as ContractPolicy;

  const schemas = {} as Record<SchemaName, unknown>;
  for (const name of SCHEMA_NAMES) {
    const path = join(dir, "schemas", `${name}.schema.json`);
    if (!existsSync(path)) {
      throw new Error(`contract at ${dir} is missing schemas/${name}.schema.json`);
    }
    schemas[name] = readJson(path);
  }

  const requireFile = (name: string): unknown => {
    const path = join(dir, name);
    if (!existsSync(path)) throw new Error(`contract at ${dir} is missing ${name}`);
    return readJson(path);
  };
  const models = requireFile("models.json") as ContractModels;
  const gate = requireFile("gate.json") as ContractGate;
  const accuracy = requireFile("accuracy.json") as ContractAccuracy;

  return {
    dir,
    source,
    policy,
    models,
    gate,
    accuracy,
    schemas: Object.freeze(schemas),
    version: typeof policy.version === "number" ? policy.version : 0,
  };
}

/**
 * Read one nested policy section, e.g. `policySection(c, "export")`.
 *
 * Returns an empty object when the section is absent so callers can read
 * optional keys without a null dance. Callers must still supply their own
 * fallback for a missing *value* — and say so where they do.
 */
export function policySection(policy: ContractPolicy, name: string): Record<string, unknown> {
  const section = policy[name];
  return section && typeof section === "object" && !Array.isArray(section)
    ? (section as Record<string, unknown>)
    : {};
}

/**
 * The support-score settings section when it lists `model` among its
 * switches, whatever that switch says; `undefined` when the section is absent,
 * its `enabled` is not an object, or `model` is not an own key of it. The one
 * place both the contract switch (`supportScoreSettings`) and the per-run
 * switch (`lib/supportswitch.ts`) decide which models are listed.
 */
export function supportScoreListing(
  accuracy: { readonly support_score?: SupportScoreSettings } | undefined,
  model: string | undefined,
): SupportScoreSettings | undefined {
  const settings = accuracy?.support_score;
  const enabled: unknown = settings?.enabled;
  if (!settings || !enabled || typeof enabled !== "object" || model === undefined) return undefined;
  if (!Object.hasOwn(enabled, model)) return undefined;
  // A section whose question cannot be asked lists no model: the score stays off.
  return supportChoiceProblem(settings) === undefined ? settings : undefined;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** What is wrong with the section's `options`, or undefined; mirrors validate.py `_support_options_errors`. */
function supportOptionsProblem(options: unknown): string | undefined {
  const where = "support_score.options";
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).length < 2) {
    return `${where} must be an object with at least two options`;
  }
  const entries = Object.entries(options as Record<string, unknown>);
  if (!entries.every(([key, criterion]) => isText(key) && isText(criterion))) {
    return `${where} keys and criteria must be non-blank strings`;
  }
  return undefined;
}

/** What is wrong with the section's pass list, or undefined; mirrors validate.py `_support_passes_errors`. */
function supportPassesProblem(passes: unknown, options: Record<string, unknown>): string | undefined {
  const where = "support_score.passes";
  if (!Array.isArray(passes) || passes.length === 0) return `${where} must be a non-empty list of option keys`;
  if (!passes.every((key) => typeof key === "string" && Object.hasOwn(options, key))) {
    return `${where} must name only keys of support_score.options`;
  }
  const distinct = new Set(passes);
  if (distinct.size !== passes.length) return `${where} must not name an option twice`;
  if (distinct.size === Object.keys(options).length) return `${where} must not name every option`;
  return undefined;
}

/**
 * What makes the support-score section's choice question unaskable, or
 * undefined when it can be asked (plan deviation d4). The same rules as
 * validate.py: `options` at least two entries, every key and criterion a
 * non-blank string; the pass list a non-empty list of distinct option keys
 * that does not name every option. A section with a problem scores nothing.
 */
export function supportChoiceProblem(settings: unknown): string | undefined {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return "support_score must be an object";
  const section = settings as { options?: unknown; passes?: unknown };
  const optionsProblem = supportOptionsProblem(section.options);
  if (optionsProblem) return optionsProblem;
  return supportPassesProblem(section.passes, section.options as Record<string, unknown>);
}

/**
 * The support-score settings for one registry model, or `undefined` when the
 * score is off for it: the section is absent, the model has no switch, or its
 * switch is anything but exactly `true`.
 */
export function supportScoreSettings(
  accuracy: { readonly support_score?: SupportScoreSettings },
  model: string,
): SupportScoreSettings | undefined {
  const settings = supportScoreListing(accuracy, model);
  if (!settings) return undefined;
  return (settings.enabled as Record<string, unknown>)[model] === true ? settings : undefined;
}

/**
 * The finish-reminder settings section (deviation d3), mirroring
 * `validate.py`'s `_finish_reminder_errors`: `max` a whole number of at least
 * 1 and `text` a non-blank string. No section is `{}` (no reminder, nothing to
 * say); a malformed one is a `problem` and no settings, so a broken section
 * never sends a reminder.
 */
export function finishReminderSettings(
  accuracy: { readonly finish_reminder?: unknown } | undefined,
): { settings?: FinishReminderSettings; problem?: string } {
  const section: unknown = accuracy?.finish_reminder;
  if (section === undefined) return {};
  const where = "accuracy.json finish_reminder";
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return { problem: `${where} must be an object` };
  }
  const { max, text } = section as { max?: unknown; text?: unknown };
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1) {
    return { problem: `${where}.max must be a whole number of at least 1, got ${JSON.stringify(max)}` };
  }
  if (typeof text !== "string" || text.trim() === "") {
    return { problem: `${where}.text must be a non-blank string` };
  }
  return { settings: section as FinishReminderSettings };
}

/**
 * The extension-side check of `models.json` `may_delegate` (deviation d18),
 * mirroring `validate.py`'s `_check_delegation`: every list is an array of
 * distinct strings naming a registry model other than its owner that may
 * mutate and does not delegate itself. Returns the problems found, empty when
 * the registry is sound. `tools/delegate.ts` calls it at load and refuses
 * every delegation while any problem stands — a malformed allowlist is never
 * read as permission.
 */
export function delegationProblems(models: ContractModels): string[] {
  const problems: string[] = [];
  for (const [name, entry] of Object.entries(models.models ?? {})) {
    const raw = (entry as { may_delegate?: unknown }).may_delegate;
    if (raw === undefined) continue;
    if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) {
      problems.push(`models.${name}.may_delegate must be an array of registry keys`);
      continue;
    }
    if (new Set(raw).size !== raw.length) problems.push(`models.${name}.may_delegate has duplicates`);
    for (const target of raw as string[]) {
      const other = Object.hasOwn(models.models, target) ? models.models[target] : undefined;
      if (!other) problems.push(`models.${name}.may_delegate names unknown model '${target}'`);
      else if (target === name) problems.push(`models.${name}.may_delegate names itself`);
      else if (other.may_mutate !== true) problems.push(`models.${name}.may_delegate names '${target}', which may not mutate`);
      else if ((other.may_delegate ?? []).length > 0) problems.push(`models.${name}.may_delegate names '${target}', which delegates`);
    }
  }
  return problems;
}
