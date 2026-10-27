/**
 * The `associate` provider: built from the model registry and the environment.
 *
 * One pi provider, one `models[]` entry per ACTIVE registry model (wire id =
 * the entry's `lobes_role`), selected by `ASSOCIATE_MODEL` (a registry key).
 * Reasoning is applied per model and only as the entry declares it. The
 * on-the-wire half lives in `tests/test_provider_wire.py`, which drives the
 * real `pi` binary against the stdlib fake lane.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ASSOCIATE_PROVIDER_ID,
  ENV_VARS,
  applyReasoningOff,
  registerAssociateProvider,
  resolveProviderSettings,
} from "../lib/provider.ts";
import { loadContract } from "../lib/contract.ts";
import type { ContractModels } from "../lib/contract.ts";

const REGISTRY: ContractModels = loadContract({}).models;
const ACTIVE_KEYS = Object.entries(REGISTRY.models)
  .filter(([, m]) => m.status === "active")
  .map(([k]) => k);

/** The real registry with `key`'s reasoning replaced. */
function withReasoning(key: string, reasoning: "model-default" | "on" | "off"): ContractModels {
  const copy = structuredClone(REGISTRY) as any;
  copy.models[key].reasoning = reasoning;
  return copy;
}

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
const MINE = { model: { provider: ASSOCIATE_PROVIDER_ID } };

// --------------------------------------------------------------- resolution

test("settings resolve from the env and the registry", () => {
  const resolved = resolveProviderSettings(
    { ...KEY, ASSOCIATE_BASE_URL: "http://example.invalid:9/v1", ASSOCIATE_MODEL: "senses" },
    REGISTRY,
  );
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok && resolved.settings.baseUrl, "http://example.invalid:9/v1");
  assert.equal(resolved.ok && resolved.settings.selectedKey, "senses");
  assert.equal(resolved.ok && resolved.settings.selectedModelId, REGISTRY.models.senses.lobes_role);
});

test("base URL and model fall back to the registry's defaults", () => {
  const resolved = resolveProviderSettings({ ...KEY }, REGISTRY);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok && resolved.settings.baseUrl, REGISTRY.endpoint.default_base_url);
  assert.equal(resolved.ok && resolved.settings.selectedKey, REGISTRY.default);
});

test("an unknown ASSOCIATE_MODEL is an error naming the active models, not a fallback", () => {
  const resolved = resolveProviderSettings({ ...KEY, ASSOCIATE_MODEL: "nope" }, REGISTRY);
  assert.equal(resolved.ok, false);
  const hint = resolved.ok ? "" : resolved.hint;
  assert.match(hint, /nope/);
  assert.match(hint, /not in the registry/);
  for (const key of ACTIVE_KEYS) assert.match(hint, new RegExp(key));
});

test("a pending ASSOCIATE_MODEL is an error, not a fallback", () => {
  const pending = Object.entries(REGISTRY.models).find(([, m]) => m.status === "pending");
  assert.ok(pending, "the registry carries a pending entry");
  const resolved = resolveProviderSettings({ ...KEY, ASSOCIATE_MODEL: pending![0] }, REGISTRY);
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok ? "" : resolved.hint, /pending/);
});

test("a missing API key resolves to a hint naming all three variables", () => {
  const resolved = resolveProviderSettings({}, REGISTRY);
  assert.equal(resolved.ok, false);
  const hint = resolved.ok ? "" : resolved.hint;
  for (const name of ENV_VARS) assert.match(hint, new RegExp(name));
});

test("a blank API key counts as absent", () => {
  assert.equal(resolveProviderSettings({ ASSOCIATE_API_KEY: "   " }, REGISTRY).ok, false);
});

// ------------------------------------------------------------- registration

test("with the key set, one provider registers with one model per active entry", () => {
  const host = fakeHost();
  const result = registerAssociateProvider(host, { ...KEY }, () => {}, REGISTRY);

  assert.equal(result.registered, true);
  assert.equal(host.providers.length, 1);
  const [entry] = host.providers;
  assert.equal(entry.id, ASSOCIATE_PROVIDER_ID);
  assert.equal(entry.config.baseUrl, REGISTRY.endpoint.default_base_url);
  assert.equal(entry.config.api, "openai-completions");
  // The key is handed to pi as an env *reference*, never as a value.
  assert.equal(entry.config.apiKey, "$ASSOCIATE_API_KEY");

  const models = entry.config.models as Array<Record<string, any>>;
  assert.deepEqual(
    models.map((m) => m.id),
    ACTIVE_KEYS.map((k) => REGISTRY.models[k].lobes_role),
    "one entry per active model, id = lobes_role; pending entries absent",
  );
  for (const m of models) {
    assert.equal(m.compat.supportsDeveloperRole, false, "safe default for a vLLM lane");
    assert.equal(m.compat.supportsReasoningEffort, false);
  }
  for (const key of ACTIVE_KEYS) {
    const m = models.find((x) => x.id === REGISTRY.models[key].lobes_role)!;
    assert.deepEqual(m.input, REGISTRY.models[key].input, "input comes from the entry");
    assert.equal(m.reasoning, REGISTRY.models[key].reasoning === "on");
  }
});

test("without the key, nothing registers and one hint line is emitted", () => {
  const host = fakeHost();
  const lines: string[] = [];
  const result = registerAssociateProvider(host, {}, (line) => lines.push(line), REGISTRY);

  assert.equal(result.registered, false);
  assert.equal(host.providers.length, 0, "no provider registered");
  assert.equal(host.handlers.size, 0, "no hook registered either");
  assert.equal(lines.length, 1, "exactly one hint line");
  for (const name of ENV_VARS) assert.match(lines[0], new RegExp(name));
});

test("an unknown ASSOCIATE_MODEL registers nothing and says so", () => {
  const host = fakeHost();
  const lines: string[] = [];
  const result = registerAssociateProvider(
    host,
    { ...KEY, ASSOCIATE_MODEL: "nope" },
    (line) => lines.push(line),
    REGISTRY,
  );
  assert.equal(result.registered, false);
  assert.equal(host.providers.length, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /nope/);
});

test("the hint never contains a key value", () => {
  const lines: string[] = [];
  registerAssociateProvider(fakeHost(), { ASSOCIATE_API_KEY: "" }, (l) => lines.push(l), REGISTRY);
  assert.equal(lines.join("\n").includes("ASSOCIATE_API_KEY="), false);
});

// ----------------------------------------------------------------- reasoning

test("no enable_thinking override is sent for a model whose entry declares none", () => {
  const host = fakeHost();
  // The shipped registry has `senses` as model-default.
  assert.equal(REGISTRY.models.senses.reasoning, "model-default");
  registerAssociateProvider(host, { ...KEY, ASSOCIATE_MODEL: "senses" }, () => {}, REGISTRY);

  for (const key of ACTIVE_KEYS) {
    if (REGISTRY.models[key].reasoning === "off") continue;
    const out = host.firePayload({ model: REGISTRY.models[key].lobes_role }, MINE);
    assert.equal("chat_template_kwargs" in out, false, `${key}: nothing injected`);
    assert.equal("reasoning_effort" in out, false);
  }
});

test("reasoning 'on' marks the pi model reasoning-capable and forces nothing off", () => {
  const host = fakeHost();
  registerAssociateProvider(host, { ...KEY }, () => {}, withReasoning("senses", "on"));
  const models = host.providers[0].config.models as Array<Record<string, any>>;
  const senses = models.find((m) => m.id === REGISTRY.models.senses.lobes_role)!;
  assert.equal(senses.reasoning, true);
  const out = host.firePayload({ model: senses.id }, MINE);
  assert.equal("chat_template_kwargs" in out, false);
});

test("reasoning 'off' injects enable_thinking=false for that model only", () => {
  const host = fakeHost();
  registerAssociateProvider(host, { ...KEY }, () => {}, withReasoning("senses", "off"));

  const off = host.firePayload({ model: REGISTRY.models.senses.lobes_role }, MINE);
  assert.deepEqual(off.chat_template_kwargs, { enable_thinking: false });

  const other = host.firePayload({ model: REGISTRY.models.worker.lobes_role }, MINE);
  assert.equal("chat_template_kwargs" in other, false, "a sibling model is untouched");

  const foreign = host.firePayload({ model: REGISTRY.models.senses.lobes_role }, {
    model: { provider: "openai" },
  });
  assert.equal("chat_template_kwargs" in foreign, false, "another provider is untouched");
});

test("the hook still fires when ctx carries no model, matching on the payload id", () => {
  const host = fakeHost();
  registerAssociateProvider(host, { ...KEY }, () => {}, withReasoning("senses", "off"));
  const out = host.firePayload({ model: REGISTRY.models.senses.lobes_role }, {});
  assert.deepEqual(out.chat_template_kwargs, { enable_thinking: false });
});

test("applyReasoningOff merges into existing chat_template_kwargs and does not mutate", () => {
  const payload = { model: "m", chat_template_kwargs: { preserve_thinking: true } };
  const out = applyReasoningOff(payload);
  assert.deepEqual(out.chat_template_kwargs, { preserve_thinking: true, enable_thinking: false });
  assert.deepEqual(payload.chat_template_kwargs, { preserve_thinking: true });
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
      ASSOCIATE_MODEL: "senses",
    }),
  );
  const { pi, cleanup } = value;
  try {
    assert.equal(pi.providers.length, 1);
    assert.equal(pi.providers[0].id, ASSOCIATE_PROVIDER_ID);
    assert.equal(pi.providers[0].config.baseUrl, "http://example.invalid:9/v1");
    assert.equal(lines.length, 0, "no hint when the lane is configured");

    const models = pi.providers[0].config.models as Array<Record<string, any>>;
    assert.deepEqual(
      models.map((m) => m.id),
      ACTIVE_KEYS.map((k) => REGISTRY.models[k].lobes_role),
    );
    // Every shipped entry is on / model-default: no override reaches a request.
    const out = pi.fireProviderRequest(
      { model: REGISTRY.models.senses.lobes_role },
      { model: { provider: ASSOCIATE_PROVIDER_ID } },
    );
    assert.equal("chat_template_kwargs" in out, false);
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

// ------------------------------------------------------- no literals in code

test("provider.ts and contract.ts carry no model id, role name or endpoint literal", async () => {
  const { libDir } = await import("../lib/paths.ts");
  const names = new Set<string>();
  for (const [key, entry] of Object.entries(REGISTRY.models)) {
    names.add(key);
    names.add(entry.lobes_role);
  }
  for (const file of ["provider.ts", "contract.ts"]) {
    // Comments may explain; only executable text counts.
    const source = readFileSync(join(libDir, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const name of names) {
      assert.equal(
        new RegExp(`["'\`]${name}["'\`]`, "i").test(source),
        false,
        `${file} names the registry entry ${name}`,
      );
    }
    assert.equal(/https?:\/\//.test(source), false, `${file} carries a URL literal`);
    assert.equal(/localhost|127\.0\.0\.1/.test(source), false, `${file} names a host`);
    assert.equal(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(source), false);
    assert.equal(/nemotron|NVIDIA/i.test(source), false, `${file} names a checkpoint`);
  }
});

test("the module names no home-directory config and no credential", async () => {
  const { libDir } = await import("../lib/paths.ts");
  const source = readFileSync(join(libDir, "provider.ts"), "utf8");
  assert.equal(/\.pi\/agent/.test(source), false, "no pi config directory");
  assert.equal(/\/home\//.test(source), false, "no absolute home path");
  assert.equal(/Authorization/i.test(source), false, "no auth header built here");
});
