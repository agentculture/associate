/**
 * Loading `index.ts` under Node's test runner, with a fake pi.
 *
 * The extension entry point imports `typebox`, which only resolves inside pi's
 * runtime. Rather than adding an npm dependency (spec c44 forbids it) or
 * leaving the entry point untested, the loader copies `index.ts` to a temp
 * file with two specifiers rewritten:
 *
 *   "typebox"   → tests/stubs/typebox.ts
 *   "./lib/…"   → the real absolute lib paths
 *
 * `lib/paths.ts` derives the extension and tools directories from its own
 * `import.meta.dirname`, so the copy still discovers the real `tools/`.
 *
 * The pi type import is `import type`, which type-stripping erases, so no stub
 * of the pi package itself is needed.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionDir, libDir } from "../lib/paths.ts";

export interface RegisteredTool {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: unknown,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
  [key: string]: unknown;
}

export type EventHandler = (event: Record<string, unknown>, ctx?: unknown) => unknown;

/** A fake `ExtensionAPI` recording what the extension registered. */
export class FakePi {
  readonly tools: RegisteredTool[] = [];
  readonly handlers = new Map<string, EventHandler[]>();
  readonly commands = new Map<string, unknown>();
  /**
   * Built-in tools pi has *configured*. Measured against pi 0.84.2:
   * `getAllTools()` lists these even when `defaultTools: []` leaves them
   * inactive, so the fake models the same split.
   */
  builtinTools: string[] = [];
  /** Built-ins pi has *active* — empty under `defaultTools: []`. */
  activeBuiltinTools: string[] = [];

  registerTool(definition: RegisteredTool): void {
    this.tools.push(definition);
  }

  registerCommand(name: string, definition: unknown): void {
    this.commands.set(name, definition);
  }

  on(event: string, handler: EventHandler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  getAllTools(): Array<{ name: string }> {
    return [...this.builtinTools.map((name) => ({ name })), ...this.tools.map((t) => ({ name: t.name }))];
  }

  getActiveTools(): string[] {
    return [...this.activeBuiltinTools, ...this.toolNames()];
  }

  toolNames(): string[] {
    return this.tools.map((tool) => tool.name);
  }

  tool(name: string): RegisteredTool {
    const found = this.tools.find((tool) => tool.name === name);
    if (!found) throw new Error(`no tool named ${name}; registered: ${this.toolNames().join(", ")}`);
    return found;
  }

  /** Run every `tool_call` handler, returning the first block decision. */
  async fireToolCall(event: Record<string, unknown>): Promise<unknown> {
    for (const handler of this.handlers.get("tool_call") ?? []) {
      const decision = await handler(event);
      if (decision) return decision;
    }
    return undefined;
  }
}

/** Load the real `index.ts` against a fake pi and return both. */
export async function loadExtension(
  env: Record<string, string | undefined> = {},
): Promise<{ pi: FakePi; cleanup: () => void }> {
  const source = readFileSync(join(extensionDir, "index.ts"), "utf8")
    .replaceAll('from "typebox"', `from ${JSON.stringify(join(import.meta.dirname, "stubs", "typebox.ts"))}`)
    .replaceAll('from "./lib/', `from "${libDir}/`);

  const dir = mkdtempSync(join(tmpdir(), "associate-ext-"));
  const copy = join(dir, "index.ts");
  writeFileSync(copy, source, "utf8");

  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const pi = new FakePi();
  try {
    const mod = await import(`${pathToFileURL(copy).href}?t=${Date.now()}-${Math.random()}`);
    await mod.default(pi);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  return { pi, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
