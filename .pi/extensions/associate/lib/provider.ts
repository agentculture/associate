/**
 * The `associate` provider — built from the model registry and the environment.
 *
 * Two jobs, both of them spec obligations:
 *
 * 1. **The endpoint and the model set are configuration, not code.** The
 *    provider is assembled at load from `models.json` (via `lib/contract.ts`)
 *    and three environment variables:
 *
 *      - `ASSOCIATE_BASE_URL` — any OpenAI-compatible endpoint. Unset, the
 *                               registry's `endpoint.default_base_url` applies.
 *      - `ASSOCIATE_API_KEY`  — required. Without it the extension registers
 *                               no provider and prints one hint line.
 *      - `ASSOCIATE_MODEL`    — the REGISTRY KEY of the active model (not a wire
 *                               id). Unset, the registry's `default` applies.
 *                               An unknown or pending key is an error, never a
 *                               silent fallback.
 *
 *    One pi provider (`associate`) is registered with one `models[]` entry per
 *    ACTIVE registry model; each entry's wire `id` is that model's `lobes_role`.
 *    This file defines no model id, role name or endpoint: all three come from
 *    the registry. The API key is handed to pi as the env *reference*
 *    `"$ASSOCIATE_API_KEY"`, so the secret's value is never read or held here.
 *
 * 2. **Reasoning is per model, and only as declared.** A registry entry's
 *    `reasoning` is one of:
 *
 *      - `model-default` — the request is left exactly as pi built it: no
 *                          `chat_template_kwargs` override is sent.
 *      - `on`            — the pi model is marked reasoning-capable; nothing
 *                          forces thinking off.
 *      - `off`           — `chat_template_kwargs.enable_thinking = false` is
 *                          injected into requests for that model only.
 *
 *    No server-specific hook (and no `ASSOCIATE_REASONING_OFF` knob) remains.
 *
 * Imports: node builtins and the sibling contract loader only, and no pi
 * runtime import — the host is described structurally below so this module is
 * loadable under `node --test`.
 */

import { loadContract } from "./contract.ts";
import type { ContractModels, ModelEntry } from "./contract.ts";

/** The provider id pi registers the lane under (a pi namespace, not a model). */
export const ASSOCIATE_PROVIDER_ID = "associate";

/** The variables the hint names, in the order a reader should set them. */
export const ENV_VARS = ["ASSOCIATE_BASE_URL", "ASSOCIATE_API_KEY", "ASSOCIATE_MODEL"] as const;

/**
 * Context window and output cap applied to every registered model.
 *
 * The registry does not carry these yet, so they are named defaults here (they
 * are neither model ids, roles nor endpoints). A later task may move them into
 * `models.json` per model.
 */
const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_TOKENS = 16384;

export type Env = Record<string, string | undefined>;

export interface ProviderSettings {
  readonly baseUrl: string;
  /** The env *reference* pi interpolates; never a key value. */
  readonly apiKeyRef: string;
  /** The registry key selected by `ASSOCIATE_MODEL` (or the registry default). */
  readonly selectedKey: string;
  /** The wire model id of the selected entry (its `lobes_role`). */
  readonly selectedModelId: string;
  /** Every ACTIVE registry entry, keyed by registry key. */
  readonly activeModels: Readonly<Record<string, ModelEntry>>;
}

export type ResolveResult =
  | { readonly ok: true; readonly settings: ProviderSettings }
  | { readonly ok: false; readonly hint: string };

/** The slice of pi's `ExtensionAPI` this module uses. */
export interface ProviderHost {
  registerProvider(id: string, config: Record<string, unknown>): void;
  on(event: string, handler: (event: any, ctx?: any) => unknown): void;
  setModel(model: unknown): Promise<boolean>;
}

/** Where the hint goes. Defaults to stderr so it never pollutes a result. */
export type Emit = (line: string) => void;

function trimmed(value: string | undefined): string {
  return (value ?? "").trim();
}

function activeEntries(registry: ContractModels): Record<string, ModelEntry> {
  const active: Record<string, ModelEntry> = {};
  for (const [key, entry] of Object.entries(registry.models)) {
    if (entry.status === "active") active[key] = entry;
  }
  return active;
}

/** Resolve the provider from the registry and environment, or explain what is wrong. */
export function resolveProviderSettings(env: Env, registry: ContractModels): ResolveResult {
  const baseUrl = trimmed(env.ASSOCIATE_BASE_URL) || registry.endpoint.default_base_url;
  if (trimmed(env.ASSOCIATE_API_KEY) === "") {
    return {
      ok: false,
      hint:
        `associate: no ${ASSOCIATE_PROVIDER_ID} provider registered. Set ${ENV_VARS[1]} to ` +
        `enable it; ${ENV_VARS[0]} (default ${registry.endpoint.default_base_url}) and ` +
        `${ENV_VARS[2]} (a registry key; default ${registry.default}) are optional.`,
    };
  }

  const active = activeEntries(registry);
  const selectedKey = trimmed(env.ASSOCIATE_MODEL) || registry.default;
  const known = Object.keys(registry.models);
  if (!(selectedKey in active)) {
    const why = known.includes(selectedKey) ? "is pending, not active" : "is not in the registry";
    return {
      ok: false,
      hint:
        `associate: ${ENV_VARS[2]}=${selectedKey} ${why}; no ${ASSOCIATE_PROVIDER_ID} provider ` +
        `registered. Active models: ${Object.keys(active).join(", ")}.`,
    };
  }
  return {
    ok: true,
    settings: {
      baseUrl,
      apiKeyRef: `$${ENV_VARS[1]}`,
      selectedKey,
      selectedModelId: active[selectedKey].lobes_role,
      activeModels: active,
    },
  };
}

/** The wire ids of every active model whose registry entry says reasoning is `off`. */
export function reasoningOffModelIds(activeModels: Readonly<Record<string, ModelEntry>>): Set<string> {
  const ids = new Set<string>();
  for (const entry of Object.values(activeModels)) {
    if (entry.reasoning === "off") ids.add(entry.lobes_role);
  }
  return ids;
}

/**
 * A copy of `payload` with `chat_template_kwargs.enable_thinking = false`.
 *
 * Merged rather than replaced so template kwargs set elsewhere survive.
 */
export function applyReasoningOff(payload: Record<string, unknown>): Record<string, unknown> {
  const existing = payload.chat_template_kwargs;
  return {
    ...payload,
    chat_template_kwargs: {
      ...(existing && typeof existing === "object" ? (existing as object) : {}),
      enable_thinking: false,
    },
  };
}

/** One pi `models[]` entry for a registry entry. */
export function modelConfig(key: string, entry: ModelEntry): Record<string, unknown> {
  return {
    id: entry.lobes_role,
    name: `associate ${entry.label} (${key})`,
    // `on` is the only setting that marks the pi model reasoning-capable;
    // `model-default` and `off` never ask for thinking on pi's side.
    reasoning: entry.reasoning === "on",
    input: [...entry.input],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: {
      // The safe default for a vLLM lane: send the system prompt as a
      // `system` message, and never send `reasoning_effort` on pi's behalf.
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  };
}

/** The `registerProvider` config for resolved settings. */
export function providerConfig(settings: ProviderSettings): Record<string, unknown> {
  return {
    name: "associate (lobes lane)",
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKeyRef,
    api: "openai-completions",
    models: Object.entries(settings.activeModels).map(([key, entry]) => modelConfig(key, entry)),
  };
}

export interface RegisterResult {
  readonly registered: boolean;
  readonly hint?: string;
  readonly settings?: ProviderSettings;
}

/**
 * Register the provider and its per-model reasoning hook, or print one hint.
 *
 * Called from `index.ts` at load. Registering nothing is a normal outcome: a
 * clone with no lane configured still starts, still loads the tools, and says
 * in one line which variables would turn the lane on. `registry` defaults to
 * the contract's `models.json` so a bare call still works.
 */
export function registerAssociateProvider(
  pi: ProviderHost,
  env: Env = process.env,
  emit: Emit = (line) => console.error(line),
  registry: ContractModels = loadContract(env).models,
): RegisterResult {
  const resolved = resolveProviderSettings(env, registry);
  if (!resolved.ok) {
    emit(resolved.hint);
    return { registered: false, hint: resolved.hint };
  }

  const { settings } = resolved;
  pi.registerProvider(ASSOCIATE_PROVIDER_ID, providerConfig(settings));

  // Pin the session to the selected registry model. pi-acp ignores
  // session/new's `model` and culture never sends session/set_model
  // (docs/notes/resident-model-resolution.md), so without this the mesh
  // resident runs whatever the operator's user-level pi default is.
  pi.on("session_start", async (_event, ctx) => {
    const current = ctx?.model;
    if (current?.provider === ASSOCIATE_PROVIDER_ID && current?.id === settings.selectedModelId) {
      return;
    }
    const model = ctx?.modelRegistry?.find(ASSOCIATE_PROVIDER_ID, settings.selectedModelId);
    if (!model) {
      emit(
        `associate: pi does not list ${ASSOCIATE_PROVIDER_ID}/${settings.selectedModelId}; ` +
          `the session stays on its current model.`,
      );
      return;
    }
    if (!(await pi.setModel(model))) {
      emit(
        `associate: could not switch the session to ${ASSOCIATE_PROVIDER_ID}/` +
          `${settings.selectedModelId} (pi reports no auth for the provider).`,
      );
    }
  });

  const offIds = reasoningOffModelIds(settings.activeModels);
  if (offIds.size > 0) {
    pi.on("before_provider_request", (event, ctx) => {
      const payload = event?.payload;
      if (!payload || typeof payload !== "object") return undefined;
      const record = payload as Record<string, unknown>;

      // Scope to this lane: `ctx.model.provider` when pi hands it over, and
      // only for a model whose registry entry declares reasoning `off`.
      const provider = ctx?.model?.provider;
      if (provider !== undefined && provider !== ASSOCIATE_PROVIDER_ID) return undefined;
      if (typeof record.model !== "string" || !offIds.has(record.model)) return undefined;

      return applyReasoningOff(record);
    });
  }

  return { registered: true, settings };
}
