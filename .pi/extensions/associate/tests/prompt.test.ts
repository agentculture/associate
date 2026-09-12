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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INJECT_PROMPT_ENV,
  PROMPT_MESSAGE_TYPE,
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

function fakeCtx(checkoutRoot: string) {
  return { checkoutRoot } as unknown as Parameters<typeof installPromptInjection>[1];
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
