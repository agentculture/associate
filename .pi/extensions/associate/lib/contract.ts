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

export type ContractSchemas = Readonly<Record<SchemaName, unknown>>;

export interface Contract {
  /** Absolute path of the directory the contract was read from. */
  readonly dir: string;
  /** How the directory was found: the env var, or the repo-relative fallback. */
  readonly source: "env" | "repo";
  readonly policy: ContractPolicy;
  readonly schemas: ContractSchemas;
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

/** Load `policy.json` and every schema from the resolved contract directory. */
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

  return {
    dir,
    source,
    policy,
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
