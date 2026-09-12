/**
 * The `associate` provider: resolved from the environment, reasoning off.
 *
 * Covers spec c14 (the provider entry resolves from environment, never from a
 * committed or home-directory `models.json`), h22 (retarget to any
 * OpenAI-compatible endpoint by configuration only), c28 (reasoning off on the
 * lane) and h8 (reasoning-off is verified on the wire, not assumed from a
 * compat flag). The on-the-wire half of h8 lives in
 * `tests/test_provider_wire.py`, which drives the real `pi` binary against the
 * stdlib fake lane; this file covers the shape of what the hook injects.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ASSOCIATE_PROVIDER_ID,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL_ID,
  ENV_VARS,
  applyReasoningOff,
  reasoningOffMode,
  reasoningOffPatch,
  registerAssociateProvider,
  resolveProviderSettings,
} from "../lib/provider.ts";

/** A minimal recorder standing in for pi's `registerProvider` / `on`. */
function fakeHost() {
  const providers: Array<{ id: string; config: Record<string, unknown> }> = [];
  const handlers = new Map<string, Array<(event: any, ctx?: any) => unknown>>();
  return {
    providers,
    handlers,
    registerProvider(id: string, config: Record<string, unknown>) {
      providers.push({ id, config });
    },
    on(event: string, handler: (event: any, ctx?: any) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    /** Run every `before_provider_request` handler, chaining replacements. */
    firePayload(payload: Record<string, unknown>, ctx: unknown): Record<string, unknown> {
      let current = payload;
      for (const handler of handlers.get("before_provider_request") ?? []) {
        const replacement = handler({ type: "before_provider_request", payload: current }, ctx);
        if (replacement !== undefined) current = replacement as Record<string, unknown>;
      }
      return current;
    },
  };
}

const KEY = { ASSOCIATE_API_KEY: "dummy-test-key" };

// --------------------------------------------------------------- resolution

test("settings resolve from the three env vars", () => {
  const resolved = resolveProviderSettings({
    ASSOCIATE_BASE_URL: "http://example.invalid:9/v1",
    ASSOCIATE_API_KEY: "dummy-test-key",
    ASSOCIATE_MODEL: "some-model",
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok && resolved.settings.baseUrl, "http://example.invalid:9/v1");
  assert.equal(resolved.ok && resolved.settings.modelId, "some-model");
});

test("base URL and model fall back to their documented defaults", () => {
  const resolved = resolveProviderSettings({ ...KEY });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok && resolved.settings.baseUrl, DEFAULT_BASE_URL);
  assert.equal(resolved.ok && resolved.settings.modelId, DEFAULT_MODEL_ID);
  // The lobes gateway, addressed by role — the one documented default (h22).
  assert.equal(DEFAULT_BASE_URL, "http://localhost:8001/v1");
  assert.equal(DEFAULT_MODEL_ID, "associate");
});

test("a missing API key resolves to a hint naming all three variables", () => {
  const resolved = resolveProviderSettings({});
  assert.equal(resolved.ok, false);
  const hint = resolved.ok ? "" : resolved.hint;
  for (const name of ENV_VARS) assert.match(hint, new RegExp(name));
});

test("a blank API key counts as absent", () => {
  assert.equal(resolveProviderSettings({ ASSOCIATE_API_KEY: "   " }).ok, false);
});

// ------------------------------------------------------------- registration

test("with the key set, the provider registers under its id", () => {
  const host = fakeHost();
  const result = registerAssociateProvider(host, { ...KEY }, () => {});

  assert.equal(result.registered, true);
  assert.equal(host.providers.length, 1);
  const [entry] = host.providers;
  assert.equal(entry.id, ASSOCIATE_PROVIDER_ID);
  assert.equal(entry.config.baseUrl, DEFAULT_BASE_URL);
  assert.equal(entry.config.api, "openai-completions");

  // c14: the key is handed to pi as an env *reference*, never as a value, so
  // the secret never passes through this extension's memory or logs.
  assert.equal(entry.config.apiKey, "$ASSOCIATE_API_KEY");

  const models = entry.config.models as Array<Record<string, any>>;
  assert.equal(models.length, 1);
  assert.equal(models[0].id, DEFAULT_MODEL_ID);
  assert.equal(models[0].reasoning, false, "c28: the model declares no extended thinking");
  assert.equal(models[0].compat.supportsDeveloperRole, false, "safe default for a vLLM lane");
  assert.equal(models[0].compat.supportsReasoningEffort, false);
});

test("without the key, nothing registers and one hint line is emitted", () => {
  const host = fakeHost();
  const lines: string[] = [];
  const result = registerAssociateProvider(host, {}, (line) => lines.push(line));

  assert.equal(result.registered, false);
  assert.equal(host.providers.length, 0, "no provider registered");
  assert.equal(host.handlers.size, 0, "no hook registered either");
  assert.equal(lines.length, 1, "exactly one hint line");
  for (const name of ENV_VARS) assert.match(lines[0], new RegExp(name));
});

test("the hint never contains a key value", () => {
  const lines: string[] = [];
  registerAssociateProvider(fakeHost(), { ASSOCIATE_API_KEY: "" }, (line) => lines.push(line));
  assert.equal(lines.join("\n").includes("ASSOCIATE_API_KEY="), false);
});

// ----------------------------------------------------------- reasoning off

test("the default knob is chat_template_kwargs.enable_thinking=false", () => {
  assert.equal(reasoningOffMode({}), "chat_template_kwargs");
  assert.deepEqual(reasoningOffPatch("chat_template_kwargs"), {
    chat_template_kwargs: { enable_thinking: false },
  });
});

test("the alternative knobs are selectable by environment, not by code edit", () => {
  assert.equal(reasoningOffMode({ ASSOCIATE_REASONING_OFF: "reasoning_effort" }), "reasoning_effort");
  assert.deepEqual(reasoningOffPatch("reasoning_effort"), { reasoning_effort: "none" });

  assert.equal(reasoningOffMode({ ASSOCIATE_REASONING_OFF: "both" }), "both");
  assert.deepEqual(reasoningOffPatch("both"), {
    chat_template_kwargs: { enable_thinking: false },
    reasoning_effort: "none",
  });

  assert.equal(reasoningOffMode({ ASSOCIATE_REASONING_OFF: "off" }), "off");
  assert.deepEqual(reasoningOffPatch("off"), {});
});

test("an unrecognized mode falls back to the default rather than throwing", () => {
  assert.equal(reasoningOffMode({ ASSOCIATE_REASONING_OFF: "nonsense" }), "chat_template_kwargs");
});

test("applyReasoningOff merges into existing chat_template_kwargs", () => {
  const out = applyReasoningOff(
    { model: "associate", chat_template_kwargs: { preserve_thinking: true } },
    "both",
  );
  assert.deepEqual(out.chat_template_kwargs, { preserve_thinking: true, enable_thinking: false });
  assert.equal(out.reasoning_effort, "none");
  assert.equal(out.model, "associate");
});

test("applyReasoningOff does not mutate the payload it is given", () => {
  const payload = { model: "associate" };
  const out = applyReasoningOff(payload, "chat_template_kwargs");
  assert.notEqual(out, payload);
  assert.equal("chat_template_kwargs" in payload, false);
});

// ------------------------------------------------------------------- hook

test("the hook rewrites the payload for this provider only", () => {
  const host = fakeHost();
  registerAssociateProvider(host, { ...KEY }, () => {});

  const mine = host.firePayload({ model: "associate" }, { model: { provider: ASSOCIATE_PROVIDER_ID } });
  assert.deepEqual(mine.chat_template_kwargs, { enable_thinking: false });

  const theirs = host.firePayload({ model: "gpt-x" }, { model: { provider: "openai" } });
  assert.equal("chat_template_kwargs" in theirs, false, "another provider is left untouched");
});

test("the hook still fires when ctx carries no model, matching on the payload id", () => {
  const host = fakeHost();
  registerAssociateProvider(host, { ...KEY }, () => {});
  const out = host.firePayload({ model: DEFAULT_MODEL_ID }, {});
  assert.deepEqual(out.chat_template_kwargs, { enable_thinking: false });
});

test("mode 'off' registers the provider but injects nothing", () => {
  const host = fakeHost();
  const result = registerAssociateProvider(host, { ...KEY, ASSOCIATE_REASONING_OFF: "off" }, () => {});
  assert.equal(result.registered, true);
  const out = host.firePayload({ model: "associate" }, { model: { provider: ASSOCIATE_PROVIDER_ID } });
  assert.equal("chat_template_kwargs" in out, false);
  assert.equal("reasoning_effort" in out, false);
});

// ------------------------------------------------- wired into the extension

/** Run `fn` with `console.error` captured, so a hint never dirties test output. */
async function withCapturedStderr<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { value: await fn(), lines };
  } finally {
    console.error = original;
  }
}

test("index.ts registers the provider when the key is set", async () => {
  const { loadExtension } = await import("./load-extension.ts");
  const { value, lines } = await withCapturedStderr(() =>
    loadExtension({
      ASSOCIATE_API_KEY: "dummy-test-key",
      ASSOCIATE_BASE_URL: "http://example.invalid:9/v1",
      ASSOCIATE_MODEL: "associate",
      ASSOCIATE_REASONING_OFF: undefined,
    }),
  );
  const { pi, cleanup } = value;
  try {
    assert.equal(pi.providers.length, 1);
    assert.equal(pi.providers[0].id, ASSOCIATE_PROVIDER_ID);
    assert.equal(pi.providers[0].config.baseUrl, "http://example.invalid:9/v1");
    assert.equal(lines.length, 0, "no hint when the lane is configured");

    const out = pi.fireProviderRequest(
      { model: "associate" },
      { model: { provider: ASSOCIATE_PROVIDER_ID } },
    );
    assert.deepEqual(out.chat_template_kwargs, { enable_thinking: false });
  } finally {
    cleanup();
  }
});

test("index.ts registers nothing and hints when the key is absent", async () => {
  const { loadExtension } = await import("./load-extension.ts");
  const { value, lines } = await withCapturedStderr(() =>
    loadExtension({
      ASSOCIATE_API_KEY: undefined,
      ASSOCIATE_BASE_URL: undefined,
      ASSOCIATE_MODEL: undefined,
    }),
  );
  const { pi, cleanup } = value;
  try {
    assert.equal(pi.providers.length, 0);
    assert.equal(pi.handlers.has("before_provider_request"), false);
    assert.equal(lines.length, 1);
    for (const name of ENV_VARS) assert.match(lines[0], new RegExp(name));
    // The extension itself still loaded: the sentinel is there.
    assert.ok(pi.toolNames().includes("associate_ready"));
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------- no home-dir config

test("the module names no home-directory config and no lane host", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { libDir } = await import("../lib/paths.ts");
  const source = readFileSync(join(libDir, "provider.ts"), "utf8");
  // c14: never read a home-directory model catalogue, and never carry the
  // lane's host or a credential.
  assert.equal(source.includes("models.json"), false, "no home-dir model catalogue");
  assert.equal(/\.pi\/agent/.test(source), false, "no pi config directory");
  assert.equal(/\/home\//.test(source), false, "no absolute home path");
  assert.equal(/Authorization/i.test(source), false, "no auth header built here");
  assert.equal(
    /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(source),
    false,
    "no host literal; the one documented default is localhost",
  );
});
