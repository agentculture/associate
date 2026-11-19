// The per-run switch for the support score (decider-score plan task t7, spec
// h6). accuracy.json holds one switch per registry model; `associate run
// --support-score on|off` overrides it for one run by setting
// $ASSOCIATE_SUPPORT_SCORE, which the launcher sets or clears for every run
// (an operator's ambient value is never inherited). This module is the only
// reader of that variable. Every setting stays in the contract: the functions
// here hand back the contract's own settings object or nothing.
import { supportScoreListing, supportScoreSettings, type SupportScoreSettings } from "./contract.ts";

/** The per-run override of accuracy.json's per-model switch: `on` or `off`. */
export const SUPPORT_SCORE_ENV = "ASSOCIATE_SUPPORT_SCORE";

export type SupportSwitch = "on" | "off";

const SWITCHES: readonly SupportSwitch[] = ["on", "off"];
const SHOWN_CHARS = 40;

/** The part of `accuracy.json` this module reads (property access only: no key is restated as a string). */
type Accuracy = { readonly support_score?: SupportScoreSettings };

export interface SupportScoreResolution {
  /** The contract's settings when the score is on for this run, else undefined. */
  settings: SupportScoreSettings | undefined;
  /** What decided: the per-run variable, or accuracy.json's switch for the model. */
  source: "env" | "contract";
  /** One line for stderr when the variable was ignored or could not be honoured. */
  problem?: string;
}

/**
 * The override named by `ASSOCIATE_SUPPORT_SCORE`, if any. A value that is not
 * `on` or `off` (after trimming) is not an override; `problem` then says so,
 * for the one stderr line the caller prints.
 */
export function supportScoreOverride(env: Record<string, string | undefined>): {
  value?: SupportSwitch;
  problem?: string;
} {
  const raw = env[SUPPORT_SCORE_ENV];
  if (raw === undefined || raw.trim() === "") return {};
  const value = raw.trim();
  if ((SWITCHES as readonly string[]).includes(value)) return { value: value as SupportSwitch };
  return {
    problem:
      `associate: ${SUPPORT_SCORE_ENV}=${JSON.stringify(raw.slice(0, SHOWN_CHARS))} is not 'on' or 'off'; ` +
      "it is ignored and accuracy.json's support-score switch for the model applies",
  };
}

/**
 * Whether the support score is on for one model in this run, and by what.
 *
 * `off` switches it off. `on` switches it on for a model the contract's
 * settings section lists among its switches, whatever that switch says; a
 * contract with no section, or a model it does not list, cannot be switched
 * on (there is nothing to score with), and `problem` says so. No override, or
 * a value that is neither, defers to `supportScoreSettings`. Pure: nothing is
 * printed here.
 */
export function resolveSupportScore(
  accuracy: Accuracy | undefined,
  modelKey: string | undefined,
  env: Record<string, string | undefined>,
): SupportScoreResolution {
  const override = supportScoreOverride(env);
  if (override.value === "off") return { settings: undefined, source: "env" };
  if (override.value === "on") {
    const settings = supportScoreListing(accuracy, modelKey);
    if (settings) return { settings, source: "env" };
    return {
      settings: undefined,
      source: "env",
      problem:
        `associate: ${SUPPORT_SCORE_ENV}=on, but accuracy.json has no support-score settings ` +
        `for model ${JSON.stringify(modelKey ?? null)}; the score stays off`,
    };
  }
  const settings = accuracy && modelKey !== undefined ? supportScoreSettings(accuracy, modelKey) : undefined;
  const resolution: SupportScoreResolution = { settings, source: "contract" };
  if (override.problem) resolution.problem = override.problem;
  return resolution;
}

const reported = new Set<string>();

/**
 * The effective support-score settings for one model in this run, or
 * undefined when the score is off. A problem with the variable is written to
 * stderr once per process (`seen` holds what was already said), never thrown.
 */
export function supportScoreFor(
  accuracy: Accuracy | undefined,
  modelKey: string | undefined,
  env: Record<string, string | undefined> = process.env,
  warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  seen: Set<string> = reported,
): SupportScoreSettings | undefined {
  const resolution = resolveSupportScore(accuracy, modelKey, env);
  if (resolution.problem && !seen.has(resolution.problem)) {
    seen.add(resolution.problem);
    warn(resolution.problem);
  }
  return resolution.settings;
}
