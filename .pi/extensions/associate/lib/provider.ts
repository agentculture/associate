/**
 * The `associate` provider — built from the environment, with reasoning off.
 *
 * Two jobs, both of them spec obligations:
 *
 * 1. **c14 / h22 — the endpoint is configuration, not code.** The provider is
 *    assembled at load from three environment variables and nothing else:
 *
 *      - `ASSOCIATE_BASE_URL`  — any OpenAI-compatible endpoint.
 *                                Default: the lobes gateway, `http://localhost:8001/v1`.
 *      - `ASSOCIATE_API_KEY`   — required. Without it the extension registers
 *                                no provider and prints one hint line.
 *      - `ASSOCIATE_MODEL`     — the model id to address. Default: `associate`,
 *                                the lobes *role* name. lobes resolves the role
 *                                to whichever box currently hosts it, so no
 *                                checkpoint id and no lane host appears here.
 *
 *    The only endpoint constant in this file is that documented default. The
 *    API key is handed to pi as the env *reference* `"$ASSOCIATE_API_KEY"`,
 *    which pi interpolates per request — so the secret's value is never read,
 *    held, or logged by this extension. This module reads no file at all, and
 *    in particular never reads a user's home-directory pi model catalogue.
 *
 * 2. **c28 / h8 — reasoning is off, and off *on the wire*.** The lane is served
 *    with `--reasoning-parser nemotron_v3`, so reasoning is on by default at
 *    the server regardless of what pi's model flags say; declaring
 *    `reasoning: false` and `compat.supportsReasoningEffort: false` only stops
 *    pi from *asking* for thinking. A `before_provider_request` hook therefore
 *    injects the off switch into the serialized payload, and a test asserts it
 *    against a real request captured by the stdlib fake lane
 *    (`tests/test_provider_wire.py`) rather than inferring it from the flags.
 *
 *    Which switch the *server* honours is still open (the spec parks it as an
 *    unknown, and the lane was down when this shipped), so the field is
 *    selectable by `ASSOCIATE_REASONING_OFF` — again configuration, not a code
 *    edit:
 *
 *      - `chat_template_kwargs` (default) — `chat_template_kwargs.enable_thinking = false`.
 *        Chosen as the default because vLLM passes `chat_template_kwargs`
 *        straight into the chat template, and `"none"` is not a value the
 *        OpenAI `reasoning_effort` enum defines, so a server that validates it
 *        strictly would reject the request outright.
 *      - `reasoning_effort`  — top-level `reasoning_effort: "none"`.
 *      - `both`              — send both.
 *      - `off`               — inject nothing (for measuring the lane's default).
 *
 * Imports: node builtins only, and no pi runtime import — the host is described
 * structurally below so this module is loadable under `node --test`.
 */

/** The provider id pi registers this lane under. */
export const ASSOCIATE_PROVIDER_ID = "associate";

/** The lobes gateway. The one endpoint constant this file is allowed. */
export const DEFAULT_BASE_URL = "http://localhost:8001/v1";

/** The lobes *role* name, not a checkpoint id. */
export const DEFAULT_MODEL_ID = "associate";

/** The variables the hint names, in the order a reader should set them. */
export const ENV_VARS = ["ASSOCIATE_BASE_URL", "ASSOCIATE_API_KEY", "ASSOCIATE_MODEL"] as const;

/**
 * Context window and output cap for the lane.
 *
 * 128k is what the spec's serving note records for the lane's shape; the output
 * cap is a deliberately conservative bound for a scout seat that hands work
 * back rather than writing long-form output.
 */
const CONTEXT_WINDOW = 131072;
const MAX_TOKENS = 16384;

export type Env = Record<string, string | undefined>;

export type ReasoningOffMode = "chat_template_kwargs" | "reasoning_effort" | "both" | "off";

const REASONING_OFF_MODES: readonly ReasoningOffMode[] = [
  "chat_template_kwargs",
  "reasoning_effort",
  "both",
  "off",
];

const DEFAULT_REASONING_OFF_MODE: ReasoningOffMode = "chat_template_kwargs";

export interface ProviderSettings {
  readonly baseUrl: string;
  readonly modelId: string;
  /** The env *reference* pi interpolates; never a key value. */
  readonly apiKeyRef: string;
  readonly reasoningOff: ReasoningOffMode;
}

export type ResolveResult =
  | { readonly ok: true; readonly settings: ProviderSettings }
  | { readonly ok: false; readonly hint: string };

/** The slice of pi's `ExtensionAPI` this module uses. */
export interface ProviderHost {
  registerProvider(id: string, config: Record<string, unknown>): void;
  on(event: string, handler: (event: any, ctx?: any) => unknown): void;
}

/** Where the hint goes. Defaults to stderr so it never pollutes a result. */
export type Emit = (line: string) => void;

function trimmed(value: string | undefined): string {
  return (value ?? "").trim();
}

/** Which reasoning-off field to inject; unknown values fall back to the default. */
export function reasoningOffMode(env: Env): ReasoningOffMode {
  const raw = trimmed(env.ASSOCIATE_REASONING_OFF).toLowerCase();
  return (REASONING_OFF_MODES as readonly string[]).includes(raw)
    ? (raw as ReasoningOffMode)
    : DEFAULT_REASONING_OFF_MODE;
}

/** The fields `mode` adds to a provider payload. */
export function reasoningOffPatch(mode: ReasoningOffMode): Record<string, unknown> {
  switch (mode) {
    case "chat_template_kwargs":
      return { chat_template_kwargs: { enable_thinking: false } };
    case "reasoning_effort":
      return { reasoning_effort: "none" };
    case "both":
      return { chat_template_kwargs: { enable_thinking: false }, reasoning_effort: "none" };
    case "off":
      return {};
  }
}

/**
 * A copy of `payload` with the reasoning-off field(s) merged in.
 *
 * `chat_template_kwargs` is merged rather than replaced so a future compat
 * flag that sets its own template kwargs is not silently dropped.
 */
export function applyReasoningOff(
  payload: Record<string, unknown>,
  mode: ReasoningOffMode,
): Record<string, unknown> {
  const patch = reasoningOffPatch(mode);
  const next: Record<string, unknown> = { ...payload, ...patch };
  if (patch.chat_template_kwargs) {
    const existing = payload.chat_template_kwargs;
    next.chat_template_kwargs = {
      ...(existing && typeof existing === "object" ? (existing as object) : {}),
      ...(patch.chat_template_kwargs as object),
    };
  }
  return next;
}

/** Resolve the provider from the environment, or explain what is missing. */
export function resolveProviderSettings(env: Env): ResolveResult {
  if (trimmed(env.ASSOCIATE_API_KEY) === "") {
    return {
      ok: false,
      hint:
        `associate: no ${ASSOCIATE_PROVIDER_ID} provider registered. Set ${ENV_VARS[1]} to ` +
        `enable it; ${ENV_VARS[0]} (default ${DEFAULT_BASE_URL}) and ${ENV_VARS[2]} ` +
        `(default ${DEFAULT_MODEL_ID}) are optional.`,
    };
  }
  return {
    ok: true,
    settings: {
      baseUrl: trimmed(env.ASSOCIATE_BASE_URL) || DEFAULT_BASE_URL,
      modelId: trimmed(env.ASSOCIATE_MODEL) || DEFAULT_MODEL_ID,
      apiKeyRef: `$${ENV_VARS[1]}`,
      reasoningOff: reasoningOffMode(env),
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
    models: [
      {
        id: settings.modelId,
        name: `associate (${settings.modelId})`,
        // c28: a scout seat must not spend its first tokens thinking. pi is
        // told the model has no extended thinking so it never asks for any;
        // the hook below is what makes that true on the wire.
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: CONTEXT_WINDOW,
        maxTokens: MAX_TOKENS,
        compat: {
          // The safe default for a vLLM lane: send the system prompt as a
          // `system` message, and never send `reasoning_effort` on pi's behalf.
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        },
      },
    ],
  };
}

export interface RegisterResult {
  readonly registered: boolean;
  readonly hint?: string;
  readonly settings?: ProviderSettings;
}

/**
 * Register the provider and its reasoning-off hook, or print one hint.
 *
 * Called from `index.ts` at load. Registering nothing is a normal outcome: a
 * clone with no lane configured still starts, still loads the tools, and says
 * in one line which variables would turn the lane on.
 */
export function registerAssociateProvider(
  pi: ProviderHost,
  env: Env = process.env,
  emit: Emit = (line) => console.error(line),
): RegisterResult {
  const resolved = resolveProviderSettings(env);
  if (!resolved.ok) {
    emit(resolved.hint);
    return { registered: false, hint: resolved.hint };
  }

  const { settings } = resolved;
  pi.registerProvider(ASSOCIATE_PROVIDER_ID, providerConfig(settings));

  pi.on("before_provider_request", (event, ctx) => {
    const payload = event?.payload;
    if (!payload || typeof payload !== "object") return undefined;
    const record = payload as Record<string, unknown>;

    // Scope to this lane. `ctx.model.provider` is authoritative when pi hands
    // it over; the payload's model id is the fallback for hosts that do not.
    const provider = ctx?.model?.provider;
    const mine =
      provider === ASSOCIATE_PROVIDER_ID ||
      (provider === undefined && record.model === settings.modelId);
    if (!mine) return undefined;

    return applyReasoningOff(record, settings.reasoningOff);
  });

  return { registered: true, settings };
}
