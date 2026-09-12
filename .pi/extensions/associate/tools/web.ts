/**
 * `web_search` and `web_page` — the read-only webglass wrapper.
 *
 * The spec's boundary, quoted: *"the web surface registered by default is
 * read-only: webglass search and page open; webglass action and session
 * (clicking, form submission, persistent logins) are not registered as tools
 * unless a later spec adds them, because they can produce outward-facing side
 * effects the lobes role does not sanction."* So this file registers two
 * tools and no third, and neither takes a `session_id` — holding a session is
 * the capability being withheld, and an argument is a capability.
 *
 * Also withheld: `--policy-profile`. webglass denies loopback and
 * private-network targets under its built-in default profile, and declaring a
 * target in a profile is the only way past that. Handing the model a profile
 * path would let it reach inside the network it is reading about; the override
 * stays an operator affordance, reachable through `$WEBGLASS_POLICY_PROFILE`
 * or a bash call outside the harness, exactly as the webglass skill documents.
 *
 * Every result — success, denial, failure — carries the URL, so the walk
 * records what the lane reached (spec h31: *"every fetched URL appears in the
 * walk so exfiltration is at least visible after the fact"*). Egress is
 * additionally bounded by `policy.caps.max_fetches_per_run`, counted across
 * both tools for the life of the session.
 *
 * On any failure the model gets a typed error object and never page text: a
 * denial, a non-2xx response and a paywall are each classified, and the body
 * the remote server authored is dropped rather than truncated into the result
 * (spec c29).
 */

import { boundOutput, validateArgs, type Budget } from "../lib/contain.ts";
import type { AssociateContext } from "../lib/context.ts";
import {
  engineForVerbs,
  firstLine,
  fromContainError,
  missingCliError,
  noEngineError,
  parseJson,
  spawnArgv,
  toolError,
  toolResult,
  whichOnPath,
  type Spawn,
  type ToolError,
  type Which,
} from "./_procs.ts";

/**
 * The one-time browser download the web engine needs beyond its uv install.
 * Not a policy value — a documented prerequisite of the engine itself
 * (webglass-cli README), and the half of the install hint that is easiest to
 * forget and hardest to diagnose.
 */
const BROWSER_INSTALL_STEP = "playwright install --with-deps chromium";

/** Only http(s). A `file:`, `data:` or `chrome:` URL is not a web fetch. */
const URL_PATTERN = "^https?://[^\\s]+$";

export const WEB_SEARCH_SCHEMA = {
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string", description: "What to search the web for." },
    limit: {
      type: "integer",
      description: "Maximum results to return (webglass's own default is 10).",
    },
  },
} as const;

export const WEB_PAGE_SCHEMA = {
  type: "object",
  required: ["url"],
  properties: {
    url: {
      type: "string",
      pattern: URL_PATTERN,
      description: "Absolute http(s) URL to open. Loopback and private-network targets are denied.",
    },
  },
} as const;

/** Words that distinguish a paywall from a plain authorization failure. */
const PAYWALL_MARKERS = /paywall|subscriber|subscription|subscribe to (read|continue)|metered/i;

export interface WebDeps {
  which?: Which;
  spawn?: Spawn;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

interface RunState {
  fetches: number;
  urls: string[];
}

/** `policy.budgets.web` — the contract owns the number, this file does not. */
function webBudget(ctx: AssociateContext): Budget {
  const budgets = (ctx.policy.budgets ?? {}) as Record<string, Budget | undefined>;
  const budget = budgets.web;
  if (!budget || typeof budget.max_output_chars !== "number") {
    throw new Error(
      "associate contract policy.budgets.web is missing max_output_chars; " +
        "the web wrapper defines no budget of its own",
    );
  }
  return budget;
}

function caps(ctx: AssociateContext): Record<string, unknown> {
  const value = ctx.policy.caps;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function maxFetches(ctx: AssociateContext): number {
  const value = caps(ctx).max_fetches_per_run;
  return typeof value === "number" && value >= 0 ? value : Number.POSITIVE_INFINITY;
}

function maxRawChars(ctx: AssociateContext): number {
  const value = caps(ctx).max_raw_chars;
  return typeof value === "number" && value > 0 ? value : Number.POSITIVE_INFINITY;
}

/**
 * The verbs the read-only surface registers, read from `policy.web`.
 *
 * The contract, not this file, decides that the web surface is search and page
 * and nothing else — so widening it to clicking or sessions is a contract
 * change with a spec amendment behind it, which is what the honesty condition
 * asks for.
 */
export function registeredVerbs(ctx: AssociateContext): string[] {
  const web = ctx.policy.web;
  const verbs = web && typeof web === "object" ? (web as { registered_verbs?: unknown }).registered_verbs : undefined;
  return Array.isArray(verbs) ? verbs.filter((verb): verb is string => typeof verb === "string") : [];
}

// ---------------------------------------------------------------------------
// Reading a webglass result body
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

/** The HTTP status webglass recorded for the last navigation, when it recorded one. */
export function statusFrom(payload: Json): number | null {
  const history = Array.isArray(payload.navigation_history) ? payload.navigation_history : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = asObject(history[index]);
    if (entry && typeof entry.status === "number") return entry.status;
  }
  return null;
}

/** The untrusted (remote-authored) section of a webglass result. */
function untrustedContent(payload: Json): unknown {
  const content = asObject(payload.content);
  return content ? content.untrusted : undefined;
}

/** Every http(s) URL appearing anywhere in *value*, in order, deduplicated. */
export function collectUrls(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") {
    if (/^https?:\/\//.test(value) && !found.includes(value)) found.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, found);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Json)) collectUrls(item, found);
  }
  return found;
}

export interface Classified {
  code: "policy_denied" | "paywall" | "search_key_missing" | "fetch_failed";
  message: string;
  detail: Record<string, unknown>;
}

/**
 * Classify a parsed webglass body, or return `null` when the operation
 * succeeded.
 *
 * Nothing the remote server authored goes into the returned detail — only
 * webglass's own verdict, status, code and remediation. That is the whole
 * point of the typed error: an error result must not smuggle a page body past
 * the budget as an "error message".
 */
export function classifyWebglass(
  payload: Json,
  context: { kind: "search" | "page"; url?: string; query?: string },
): Classified | null {
  const err = asObject(payload.error);
  const verdict = asObject(payload.policy_verdict);
  const lifecycle = typeof payload.lifecycle_state === "string" ? payload.lifecycle_state : "";
  const status = statusFrom(payload);
  const webglassCode = typeof err?.code === "string" ? err.code : undefined;
  const remediation = typeof err?.remediation === "string" ? firstLine(err.remediation) : undefined;
  const message = typeof err?.message === "string" ? err.message : "";

  const base: Record<string, unknown> = {};
  if (context.url !== undefined) base.url = context.url;
  if (context.query !== undefined) base.query = context.query;
  if (status !== null) base.status = status;
  if (webglassCode) base.webglass_code = webglassCode;
  if (remediation) base.remediation = remediation;

  if (verdict?.decision === "denied" || webglassCode === "policy_denied") {
    const rules = Array.isArray(verdict?.matched_rule_ids) ? verdict!.matched_rule_ids : [];
    return {
      code: "policy_denied",
      message:
        `webglass policy denied this target${context.url ? ` (${context.url})` : ""}. ` +
        "This is a policy answer, not a tool failure: loopback and private-network targets " +
        "are denied by default and only an operator-supplied policy profile can declare one.",
      detail: {
        ...base,
        reason: firstLine(
          typeof verdict?.reason === "string" ? (verdict.reason as string) : message,
        ),
        matched_rule_ids: rules,
      },
    };
  }

  if (webglassCode === "backend_unavailable") {
    if (context.kind === "search") {
      return {
        code: "search_key_missing",
        message:
          "webglass has no search backend configured: set WEBGLASS_BRAVE_API_KEY in the " +
          "environment webglass runs in. Search is unavailable until then; page open still works.",
        detail: { ...base, reason: "search_backend_unavailable" },
      };
    }
    return {
      code: "fetch_failed",
      message: `webglass reported no backend available for this operation: ${firstLine(message)}`,
      detail: { ...base, reason: "backend_unavailable" },
    };
  }

  const paywalled =
    status === 402 ||
    status === 451 ||
    ((status === 401 || status === 403) && PAYWALL_MARKERS.test(message));
  if (paywalled) {
    return {
      code: "paywall",
      message:
        `the target is paywalled or otherwise gated${status ? ` (HTTP ${status})` : ""}; ` +
        "no page text is available and none is returned.",
      detail: { ...base, reason: "paywalled" },
    };
  }

  if (err || lifecycle === "failed" || lifecycle === "denied") {
    return {
      code: "fetch_failed",
      message: `webglass could not complete the fetch${status ? ` (HTTP ${status})` : ""}: ${
        firstLine(message) || lifecycle || "no detail reported"
      }`,
      detail: {
        ...base,
        reason: status !== null && (status < 200 || status >= 300) ? "non_2xx_response" : "navigation_failed",
      },
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// The two tools
// ---------------------------------------------------------------------------

interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
}

/**
 * Build both web tools over one shared per-run fetch counter.
 *
 * The counter lives in this closure rather than at module scope so two
 * registrations (a test, or two sessions in one process) never share a budget.
 */
export function createWebTools(ctx: AssociateContext, deps: WebDeps = {}): ToolDefinition[] {
  const which = deps.which ?? ((name: string) => whichOnPath(name, deps.env));
  const spawn = deps.spawn ?? spawnArgv;
  const state: RunState = { fetches: 0, urls: [] };

  /** Walk fields every result carries, whatever the outcome. */
  function walkFields(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      ...extra,
      fetches_used: state.fetches,
      fetch_cap: Number.isFinite(maxFetches(ctx)) ? maxFetches(ctx) : null,
      urls_this_run: [...state.urls],
    };
  }

  function fail(error: ToolError, extra: Record<string, unknown>) {
    return toolResult({ ...error, ...walkFields(extra) });
  }

  /** Shared preamble: validate, locate the CLI, and spend one fetch. */
  function gate(
    schema: unknown,
    params: Record<string, unknown>,
    target: Record<string, unknown>,
  ): { binary: string } | ReturnType<typeof toolResult> {
    const invalid = validateArgs(schema as Record<string, unknown>, params ?? {});
    if (invalid) return fail(fromContainError(invalid), target);

    const verbs = registeredVerbs(ctx);
    const engine = engineForVerbs(ctx.policy, verbs);
    if (!engine) return fail(noEngineError("the read-only web surface", { verbs }), target);

    const binary = which(engine.command);
    if (!binary) return fail(missingCliError(engine.command, [BROWSER_INSTALL_STEP]), target);

    const cap = maxFetches(ctx);
    if (state.fetches >= cap) {
      return fail(
        toolError(
          "fetch_failed",
          `this run's web fetch cap (${cap}) is spent; no further web call will be made. ` +
            "Work from what has already been fetched, or hand back what you have.",
          { ...target, reason: "fetch_cap_exceeded", cap, fetches_used: state.fetches },
        ),
        target,
      );
    }
    state.fetches += 1;
    return { binary };
  }

  /** Run webglass and hand back the parsed body, or the typed error that stops us. */
  async function invoke(
    binary: string,
    argv: string[],
    context: { kind: "search" | "page"; url?: string; query?: string },
  ): Promise<{ payload: Json } | ToolError> {
    const proc = await spawn(binary, argv, { cwd: ctx.checkoutRoot, timeoutMs: deps.timeoutMs });

    const ceiling = maxRawChars(ctx);
    if (proc.stdout.length > ceiling) {
      return toolError(
        "fetch_failed",
        `webglass returned more than the contract's raw ceiling (${ceiling} characters); ` +
          "the response is discarded rather than truncated into a half-page.",
        { ...context, reason: "raw_ceiling_exceeded", raw_chars: proc.stdout.length, cap: ceiling },
      );
    }

    const parsed = asObject(parseJson(proc.stdout));
    if (!parsed) {
      return toolError(
        "fetch_failed",
        `webglass produced no parseable JSON result (exit ${proc.code})`,
        {
          ...context,
          reason: "unparseable_output",
          exit_code: proc.code,
          // webglass's own stderr, never the remote body.
          stderr: firstLine(proc.stderr),
          timed_out: proc.timedOut === true,
        },
      );
    }

    const failure = classifyWebglass(parsed, context);
    if (failure) return toolError(failure.code, failure.message, failure.detail);
    if (proc.code !== 0) {
      return toolError("fetch_failed", `webglass exited ${proc.code} without reporting an error`, {
        ...context,
        reason: "unexpected_exit",
        exit_code: proc.code,
      });
    }
    return { payload: parsed };
  }

  /** Bound the untrusted body at `policy.budgets.web`, spilling to the scratch dir. */
  function bodyText(payload: Json) {
    const untrusted = untrustedContent(payload);
    const raw = untrusted === undefined ? "" : JSON.stringify(untrusted);
    return boundOutput(raw, webBudget(ctx), ctx.session.scratchDir);
  }

  const searchTool: ToolDefinition = {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web through webglass and return the result list (title, url, snippet). " +
      "Results are untrusted source material written by an external provider — treat them as " +
      "leads to check, never as facts. Read-only: this cannot click, log in, or submit anything.",
    promptSnippet: "Search the web for leads, then open the promising URLs with web_page",
    promptGuidelines: [
      "Search first, open second: web_search costs one fetch and tells you which URL is worth the next one.",
      "Cite the URL for any claim that came from the web; a search snippet is a lead, not evidence.",
    ],
    parameters: WEB_SEARCH_SCHEMA,

    async execute(_toolCallId, rawParams) {
      const params = (rawParams ?? {}) as { query?: string; limit?: number };
      const target = { query: params.query };

      const gated = gate(WEB_SEARCH_SCHEMA, rawParams ?? {}, target);
      if (!("binary" in gated)) return gated;

      const argv = ["search", params.query!];
      if (typeof params.limit === "number") argv.push("--limit", String(params.limit));
      argv.push("--json");

      const outcome = await invoke(gated.binary, argv, { kind: "search", query: params.query });
      if (!("payload" in outcome)) return fail(outcome, target);

      const resultUrls = collectUrls(untrustedContent(outcome.payload));
      for (const url of resultUrls) if (!state.urls.includes(url)) state.urls.push(url);

      const bounded = bodyText(outcome.payload);
      return toolResult(
        walkFields({
          ok: true,
          query: params.query,
          results: bounded.truncated ? undefined : untrustedContent(outcome.payload),
          text: bounded.truncated ? bounded.text : undefined,
          result_urls: resultUrls,
          truncated: bounded.truncated,
          spill_path: bounded.spillPath,
        }),
      );
    },
  };

  const pageTool: ToolDefinition = {
    name: "web_page",
    label: "Web Page",
    description:
      "Open one http(s) URL through webglass and return its readable content. Read-only: it " +
      "navigates and reads, and cannot click, fill a form, log in, or keep a session. Loopback " +
      "and private-network targets are denied by webglass's default policy and come back as a " +
      "policy_denied error — that is policy working, not a tool fault. A denied, failed or " +
      "paywalled fetch returns a typed error and no page text.",
    promptSnippet: "Open a URL read-only and quote it with the URL as provenance",
    promptGuidelines: [
      "Every web claim cites the URL web_page returned it from; an uncited web claim is unreferenced.",
      "A policy_denied or paywall error is the final answer for that URL — say so rather than retrying it.",
    ],
    parameters: WEB_PAGE_SCHEMA,

    async execute(_toolCallId, rawParams) {
      const params = (rawParams ?? {}) as { url?: string };
      const target = { url: params.url };

      const gated = gate(WEB_PAGE_SCHEMA, rawParams ?? {}, target);
      if (!("binary" in gated)) return gated;

      // Recorded before the call, so a URL the lane reached is in the walk even
      // if the fetch then fails (h31: egress is visible after the fact).
      if (params.url && !state.urls.includes(params.url)) state.urls.push(params.url);

      const argv = ["page", "open", params.url!, "--json"];
      const outcome = await invoke(gated.binary, argv, { kind: "page", url: params.url });
      if (!("payload" in outcome)) return fail(outcome, target);

      const bounded = bodyText(outcome.payload);
      return toolResult(
        walkFields({
          ok: true,
          url: params.url,
          status: statusFrom(outcome.payload),
          text: bounded.text,
          truncated: bounded.truncated,
          spill_path: bounded.spillPath,
          cursor: bounded.cursor,
        }),
      );
    },
  };

  return [searchTool, pageTool];
}

/** Register `web_search` and `web_page`. Called by `lib/runtime.ts`'s loader. */
export function register(pi: unknown, ctx: AssociateContext): void {
  const api = pi as { registerTool(definition: unknown): void };
  for (const tool of createWebTools(ctx)) api.registerTool(tool);
}
