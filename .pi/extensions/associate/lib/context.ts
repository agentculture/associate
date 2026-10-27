/**
 * The context every tool module receives.
 *
 * `index.ts` builds one of these at load and passes it to each
 * `tools/<name>.ts` module's `register(pi, ctx)`. The next wave of tools
 * (read, search, shell, codelens, web) codes against this type and nothing
 * else: it is where the loaded contract, the session directories and the
 * containment helpers are found, so no tool re-reads `policy.json` or invents
 * its own confinement rule.
 */

import type { Contract, ContractPolicy, ContractSchemas } from "./contract.ts";
import type { SessionDirs } from "./session.ts";
import type { ChildEntry, ChildLink } from "./walk.ts";

/**
 * The part of the session's walk recorder a tool module may use: linking a
 * child walk (plan t16). Tool calls themselves are recorded from pi events,
 * never by a tool, so nothing else of the recorder is exposed.
 */
export interface ChildWalkLinker {
  readonly walkPath: string;
  recordChild(link: ChildLink): ChildEntry;
}

/**
 * Containment helpers shared by every tool.
 *
 * `resolveWithin` is the one a read/search tool wants: it rejects a path that
 * escapes the checkout (spec c30: `confine` and `_refuse_pattern_escape`,
 * ported from colleague) and returns an absolute path otherwise.
 */
export interface ContainHelpers {
  /** True when `child` is `parent` itself or lies underneath it. */
  isInside(parent: string, child: string): boolean;
  /**
   * Resolve `candidate` against `base` (default: the checkout root) and throw
   * a structured error when the result escapes `base`.
   */
  resolveWithin(candidate: string, base?: string): string;
  /** True when the tool named may persist a change to a checkout. */
  isWriter(toolName: string): boolean;
}

export interface AssociateContext {
  /** The extension's own version, reported by the `associate_ready` sentinel. */
  readonly extensionVersion: string;
  /** The checkout pi was started in — the thing under examination. */
  readonly checkoutRoot: string;
  /** The whole loaded contract: directory, source, policy, schemas, version. */
  readonly contract: Contract;
  /** Shorthand for `contract.policy`; never shadowed by a TypeScript default. */
  readonly policy: ContractPolicy;
  /** Shorthand for `contract.schemas` — task, walk, statements. */
  readonly schemas: ContractSchemas;
  /** This session's scratch and export directories. */
  readonly session: SessionDirs;
  /** Containment helpers; see {@link ContainHelpers}. */
  readonly contain: ContainHelpers;
  /**
   * Declare a registered tool as a writer so the `tool_call` guard confines
   * it to the scratch directory. A tool module calls this from `register()`.
   */
  declareWriter(toolName: string): void;
  /** Tool names declared through {@link declareWriter}, for the guard. */
  declaredWriters(): readonly string[];
  /**
   * Declare a registered tool as a safe override of a built-in writer's name —
   * the allowlisted shell registering as `bash` (spec c35). Without it the
   * guard would judge the override by the built-in's reputation and block
   * every call to it, and the `associate_ready` sentinel would report it as an
   * active writer, which the launcher (c34) refuses to serve on.
   */
  declareNonWriter(toolName: string): void;
  /** Tool names declared through {@link declareNonWriter}, for the guard. */
  declaredNonWriters(): readonly string[];
  /**
   * Attach the session's walk recorder. `index.ts` does this once, after
   * installing the recorder and before any tool module registers.
   */
  attachWalk(walk: ChildWalkLinker): void;
  /** The attached walk recorder, or undefined when none was attached (tests). */
  walk(): ChildWalkLinker | undefined;
}

/**
 * The shape every module under `tools/` must export.
 *
 * `index.ts` imports each module dynamically and calls this; a module that
 * does not export `register` is reported at load rather than ignored.
 */
export type ToolModule = {
  register(pi: unknown, ctx: AssociateContext): void | Promise<void>;
};
