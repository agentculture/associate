/**
 * Building the {@link AssociateContext} and loading the tool modules.
 *
 * Kept out of `index.ts` so it can be unit-tested with Node's test runner:
 * `index.ts` imports `typebox`, which only resolves inside pi's runtime, while
 * everything here imports node builtins only.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { loadContract, type Contract } from "./contract.ts";
import { isInside, resolveSessionDirs, type SessionDirs } from "./session.ts";
import { isWriterTool } from "./guard.ts";
import { EXTENSION_VERSION, toolsDir as defaultToolsDir } from "./paths.ts";
import type { AssociateContext, ToolModule } from "./context.ts";

export interface CreateContextOptions {
  /** Defaults to `process.cwd()` — the checkout pi was started in. */
  checkoutRoot?: string;
  env?: Record<string, string | undefined>;
  /** Pre-loaded contract; loaded from the environment when omitted. */
  contract?: Contract;
  /** Pre-resolved session directories; resolved (and created) when omitted. */
  session?: SessionDirs;
  /** False to resolve directory paths without creating them (tests). */
  create?: boolean;
}

/** Build the context handed to every tool module. */
export function createAssociateContext(options: CreateContextOptions = {}): AssociateContext {
  const env = options.env ?? process.env;
  const checkoutRoot = resolve(options.checkoutRoot ?? env.ASSOCIATE_CHECKOUT_ROOT ?? process.cwd());
  const contract = options.contract ?? loadContract(env);
  const session =
    options.session ??
    resolveSessionDirs({
      checkoutRoot,
      policy: contract.policy,
      env,
      create: options.create,
    });

  const writers = new Set<string>();

  return {
    extensionVersion: EXTENSION_VERSION,
    checkoutRoot,
    contract,
    policy: contract.policy,
    schemas: contract.schemas,
    session,
    contain: {
      isInside,
      resolveWithin(candidate: string, base?: string): string {
        const root = resolve(base ?? checkoutRoot);
        const resolved = resolve(root, candidate);
        if (!isInside(root, resolved)) {
          throw new Error(
            `associate: path ${candidate} escapes ${root}; paths are confined to the ` +
              "session root (contract policy read.confine_to_session_root)",
          );
        }
        return resolved;
      },
      isWriter(toolName: string): boolean {
        return isWriterTool(toolName, writers);
      },
    },
    declareWriter(toolName: string): void {
      writers.add(toolName);
    },
    declaredWriters(): readonly string[] {
      return [...writers];
    },
  };
}

/**
 * Every tool module under `dir`, sorted so load order is deterministic.
 *
 * `*.test.ts`, `*.d.ts` and dotfiles are skipped; a subdirectory with an
 * `index.ts` counts as one module, so a tool that grows past a single file
 * does not need a loader change.
 */
export function discoverToolModules(dir: string = defaultToolsDir): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    if (entry.isDirectory()) {
      const index = join(dir, entry.name, "index.ts");
      if (existsSync(index)) found.push(index);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue;
    found.push(join(dir, entry.name));
  }
  return found.sort();
}

export interface LoadedToolModule {
  readonly path: string;
  readonly name: string;
}

/**
 * Import every tool module and call its `register(pi, ctx)`.
 *
 * A module without a `register` export is a mistake worth surfacing, not
 * silently skipping — the tool would simply never appear and the launcher's
 * sentinel check would not catch it.
 */
export async function loadToolModules(
  pi: unknown,
  ctx: AssociateContext,
  dir: string = defaultToolsDir,
): Promise<LoadedToolModule[]> {
  const loaded: LoadedToolModule[] = [];
  for (const path of discoverToolModules(dir)) {
    const mod = (await import(pathToFileURL(path).href)) as Partial<ToolModule>;
    if (typeof mod.register !== "function") {
      throw new Error(
        `associate tool module ${path} does not export register(pi, ctx); ` +
          "every module under tools/ must register at least one tool",
      );
    }
    await mod.register(pi, ctx);
    loaded.push({ path, name: path.split(sep).pop()!.replace(/\.ts$/, "") });
  }
  return loaded;
}
