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
  /** Providers registered through `registerProvider`, in registration order. */
  readonly providers: Array<{ id: string; config: Record<string, unknown> }> = [];
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

  registerProvider(id: string, config: Record<string, unknown>): void {
    this.providers.push({ id, config });
  }

  /** Run every `before_provider_request` handler, chaining any replacement. */
  fireProviderRequest(payload: Record<string, unknown>, ctx?: unknown): Record<string, unknown> {
    let current = payload;
    for (const handler of this.handlers.get("before_provider_request") ?? []) {
      const replacement = handler({ type: "before_provider_request", payload: current }, ctx);
      if (replacement !== undefined) current = replacement as Record<string, unknown>;
    }
    return current;
  }

  on(event: string, handler: EventHandler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  getAllTools(): Array<{ name: string }> {
    return [...this.builtinTools.map((name) => ({ name })), ...this.tools.map((t) => ({ name: t.name }))];
  }

  /** Set by setActiveTools(); until then the active set is builtins + registered tools. */
  activeOverride: string[] | null = null;

  getActiveTools(): string[] {
    if (this.activeOverride) return [...this.activeOverride];
    return [...this.activeBuiltinTools, ...this.toolNames()];
  }

  setActiveTools(names: string[]): void {
    this.activeOverride = [...names];
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
  async fireSessionStart(reason = "startup"): Promise<void> {
    for (const handler of this.handlers.get("session_start") ?? []) {
      await handler({ type: "session_start", reason }, {});
    }
  }

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
  setup?: (pi: FakePi) => void,
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
  setup?.(pi);
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
