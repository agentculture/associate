/**
 * The runtime-prompt injection (risk r16).
 *
 * The leak being closed is concrete: a workspace directory holding many sibling
 * checkouts carries its own `CLAUDE.md`, and pi walks every ancestor looking for
 * context files. The fixture below reproduces exactly that shape — a parent
 * `CLAUDE.md` and a child `AGENTS.md` — and asserts that only the child's file
 * is ever read or rendered.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadContract } from "../lib/contract.ts";
import {
  INJECT_PROMPT_ENV,
  PROMPT_MESSAGE_TYPE,
  activeModel,
  installPromptInjection,
  readRuntimePrompt,
  renderRuntimePrompt,
  shouldInjectPrompt,
} from "../lib/prompt.ts";

const ANCESTOR_MARKER = "WORKSPACE-LEVEL-INSTRUCTIONS-THAT-MUST-NOT-LEAK";
const CHECKOUT_MARKER = "THE-CHECKOUTS-OWN-RUNTIME-PROMPT";

/** A workspace directory with its own CLAUDE.md, holding a checkout with AGENTS.md. */
function fixture(): { workspace: string; checkout: string; cleanup: () => void } {
  const workspace = mkdtempSync(join(tmpdir(), "associate-prompt-"));
  writeFileSync(join(workspace, "CLAUDE.md"), `# workspace\n\n${ANCESTOR_MARKER}\n`, "utf8");
  const checkout = join(workspace, "checkout");
  mkdirSync(checkout);
  writeFileSync(join(checkout, "AGENTS.md"), `# associate\n\n${CHECKOUT_MARKER}\n`, "utf8");
  return { workspace, checkout, cleanup: () => rmSync(workspace, { recursive: true, force: true }) };
}

function fakePi() {
  const handlers: Array<{ event: string; handler: (e: Record<string, unknown>) => unknown }> = [];
  return {
    handlers,
    on(event: string, handler: (e: Record<string, unknown>) => unknown) {
      handlers.push({ event, handler });
    },
  };
}

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const contract = loadContract({});

function fakeCtx(checkoutRoot: string) {
  return { checkoutRoot, contract } as unknown as Parameters<typeof installPromptInjection>[1];
}

test("the env flag gates the injection", () => {
  assert.equal(shouldInjectPrompt({}), false);
  assert.equal(shouldInjectPrompt({ [INJECT_PROMPT_ENV]: "" }), false);
  assert.equal(shouldInjectPrompt({ [INJECT_PROMPT_ENV]: "0" }), false);
  assert.equal(shouldInjectPrompt({ [INJECT_PROMPT_ENV]: "false" }), false);
  assert.equal(shouldInjectPrompt({ [INJECT_PROMPT_ENV]: "1" }), true);
});

test("only the checkout's own AGENTS.md is read", () => {
  const { checkout, cleanup } = fixture();
  try {
    const text = readRuntimePrompt(checkout)!;
    assert.ok(text.includes(CHECKOUT_MARKER));
    assert.ok(
      !text.includes(ANCESTOR_MARKER),
      "an ancestor CLAUDE.md must never reach the runtime prompt",
    );
  } finally {
    cleanup();
  }
});

test("a checkout without AGENTS.md registers no handler", () => {
  const empty = mkdtempSync(join(tmpdir(), "associate-prompt-empty-"));
  try {
    const pi = fakePi();
    assert.equal(
      installPromptInjection(pi, fakeCtx(empty), { [INJECT_PROMPT_ENV]: "1" }),
      false,
    );
    assert.equal(pi.handlers.length, 0);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("without the flag nothing is registered at all", () => {
  const { checkout, cleanup } = fixture();
  try {
    const pi = fakePi();
    assert.equal(installPromptInjection(pi, fakeCtx(checkout), {}), false);
    assert.equal(pi.handlers.length, 0);
  } finally {
    cleanup();
  }
});

test("the injected message carries AGENTS.md once, and nothing from above it", () => {
  const { checkout, cleanup } = fixture();
  try {
    const pi = fakePi();
    assert.equal(installPromptInjection(pi, fakeCtx(checkout), { [INJECT_PROMPT_ENV]: "1" }), true);
    assert.deepEqual(
      pi.handlers.map((entry) => entry.event),
      ["before_agent_start"],
    );

    const first = pi.handlers[0]!.handler({}) as { message: { customType: string; content: string } };
    assert.equal(first.message.customType, PROMPT_MESSAGE_TYPE);
    assert.ok(first.message.content.includes(CHECKOUT_MARKER));
    assert.ok(!first.message.content.includes(ANCESTOR_MARKER));
    assert.equal(first.message.content.split(CHECKOUT_MARKER).length - 1, 1);

    // Once only: a later turn must not re-paste the prompt.
    assert.equal(pi.handlers[0]!.handler({}), undefined);
  } finally {
    cleanup();
  }
});

test("the rendered prompt says the ancestor files were left out on purpose", () => {
  const rendered = renderRuntimePrompt("body", "/somewhere/AGENTS.md");
  assert.ok(rendered.includes("/somewhere/AGENTS.md"));
  assert.ok(rendered.toLowerCase().includes("ancestor"));
  assert.ok(rendered.includes("body"));
});

// ----------------------------------------------------------- per-model prompts

const REGISTRY = contract.models;
const TOOL_NAMES = new Set(REGISTRY.tool_names);

/** Inject for one model against the real checkout and return the message text. */
function injectedFor(key: string | undefined): string {
  const pi = fakePi();
  const env: Record<string, string | undefined> = { [INJECT_PROMPT_ENV]: "1" };
  if (key !== undefined) env.ASSOCIATE_MODEL = key;
  assert.equal(installPromptInjection(pi, fakeCtx(REPO_ROOT), env), true);
  const out = pi.handlers[0]!.handler({}) as { message: { content: string } };
  return out.message.content;
}

function promptFile(key: string): string {
  return readFileSync(join(REPO_ROOT, REGISTRY.models[key]!.prompt_file), "utf8");
}

/** Every registry tool name that appears in backticks in the text. */
function toolsNamed(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/`([a-z_]+)`/g)) {
    if (TOOL_NAMES.has(match[1]!)) found.add(match[1]!);
  }
  return found;
}

for (const key of Object.keys(REGISTRY.models)) {
  test(`${key}: the injected prompt is that model's file, and no other model's`, () => {
    const injected = injectedFor(key);
    assert.ok(injected.includes(promptFile(key).trimEnd()));
    for (const other of Object.keys(REGISTRY.models)) {
      if (other === key) continue;
      assert.ok(
        !injected.includes(promptFile(other).trimEnd()),
        `${other}'s prompt leaked into ${key}'s`,
      );
    }
    assert.ok(injected.includes(`# ${key} `), "the model's own heading is present");
  });

  test(`${key}: the prompt names exactly the model's tools`, () => {
    const named = toolsNamed(promptFile(key));
    const listed = new Set(REGISTRY.models[key]!.tools);
    assert.deepEqual([...named].sort(), [...listed].sort());
  });
}

test("the model prompt rides alongside AGENTS.md, once, in one message", () => {
  const injected = injectedFor("senses");
  assert.ok(injected.includes("associate — the runtime prompt"));
  assert.ok(injected.indexOf("associate — the runtime prompt") < injected.indexOf("# senses "));
  const pi = fakePi();
  installPromptInjection(pi, fakeCtx(REPO_ROOT), { [INJECT_PROMPT_ENV]: "1" });
  assert.notEqual(pi.handlers[0]!.handler({}), undefined);
  assert.equal(pi.handlers[0]!.handler({}), undefined);
});

test("with ASSOCIATE_MODEL unset the registry default's prompt is injected", () => {
  assert.equal(activeModel(REGISTRY, {})!.key, REGISTRY.default);
  assert.ok(injectedFor(undefined).includes(promptFile(REGISTRY.default).trimEnd()));
});

test("an unknown model key injects AGENTS.md only", () => {
  const injected = injectedFor("no-such-model");
  assert.ok(injected.includes("associate — the runtime prompt"));
  assert.ok(!injected.includes("# Model prompt"));
});

test("the cortex prompt names the spawn tool and both child models", () => {
  const text = promptFile("cortex");
  assert.ok(text.includes("`spawn_subagent`"));
  assert.ok(text.includes("`senses`"));
  assert.ok(text.includes("`worker`"));
  assert.deepEqual(REGISTRY.models.cortex!.may_spawn, ["worker", "senses"]);
});

test("the super-vl prompt is marked pending and the registry agrees", () => {
  assert.equal(REGISTRY.models["super-vl"]!.status, "pending");
  assert.match(promptFile("super-vl"), /^# super-vl[^\n]*\n\s*\n\*\*PENDING\.\*\*/);
});

test("read-only senses says so; mutating prompts carry the CLEF check", () => {
  assert.match(promptFile("senses"), /Nothing\./);
  for (const key of ["worker", "cortex", "super-vl"]) {
    const text = promptFile(key);
    assert.ok(text.includes("CLEF"), `${key} names the CLEF check`);
    assert.ok(text.includes("eidetic_recall") && text.includes("ledger_append"));
  }
});
