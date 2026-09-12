/**
 * The read-only webglass wrapper (task t8, claims c38/h31).
 *
 * No test here reaches the network: every webglass invocation is a fake spawn
 * returning a recorded webglass JSON body (the shapes were captured from
 * webglass-cli 0.8.3 with `--json`: a loopback policy denial, a non-2xx
 * navigation failure, and a keyless search). The acceptance criteria this file
 * covers:
 *
 *   2. the registered tool list contains web_search and web_page and no tool
 *      that can submit a form or hold a session;
 *   3. a loopback target denied by policy and a 403 fetch each return a typed
 *      error object with kind and detail, and no page text.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContract } from "../lib/contract.ts";
import { createAssociateContext } from "../lib/runtime.ts";
import { whichOnPath, type ProcResult, type Spawn } from "../tools/_procs.ts";
import { createWebTools, register } from "../tools/web.ts";
import type { AssociateContext } from "../lib/context.ts";

// ---------------------------------------------------------------------------
// Recorded webglass bodies (webglass-cli 0.8.3, --json). Trimmed to the fields
// the wrapper reads; the full bodies carry budget, cache and timing sections.
// ---------------------------------------------------------------------------

const LOOPBACK_DENIED = JSON.stringify({
  schema_version: 1,
  kind: "page.open",
  lifecycle_state: "denied",
  content: { trusted: {}, untrusted: {}, sensitive: {}, derived: {} },
  policy_verdict: { decision: "denied", matched_rule_ids: ["target-deny-loopback"] },
  navigation_history: [],
  error: {
    code: "policy_denied",
    message: "policy denied this target: 127.0.0.1 is a loopback address",
    remediation: "rule(s): target-deny-loopback — declare the origin in the effective policy profile",
  },
});

const FORBIDDEN_403 = JSON.stringify({
  schema_version: 1,
  kind: "page.open",
  lifecycle_state: "failed",
  content: {
    trusted: {},
    // A real 403 body often still carries markup; the wrapper must not pass it on.
    untrusted: { text: "SECRET PAGE TEXT the model must never receive on an error" },
    sensitive: {},
    derived: {},
  },
  policy_verdict: { decision: "allowed", matched_rule_ids: ["target-allow-public"] },
  navigation_history: [
    { requested_url: "https://example.invalid/private", response_url: null, status: 403 },
  ],
  error: {
    code: "navigation_failed",
    message:
      "the browser could not load https://example.invalid/private: Page.goto: " +
      "net::ERR_HTTP_RESPONSE_CODE_FAILURE",
    remediation: "check that the server for this target is running and reachable",
  },
});

const PAYWALLED_402 = JSON.stringify({
  schema_version: 1,
  kind: "page.open",
  lifecycle_state: "failed",
  content: { trusted: {}, untrusted: { text: "subscriber-only article body" }, sensitive: {}, derived: {} },
  policy_verdict: { decision: "allowed", matched_rule_ids: ["target-allow-public"] },
  navigation_history: [
    { requested_url: "https://example.invalid/article", response_url: null, status: 402 },
  ],
  error: { code: "navigation_failed", message: "payment required" },
});

const SEARCH_NO_KEY = JSON.stringify({
  schema_version: 1,
  kind: "search",
  lifecycle_state: "failed",
  content: { trusted: {}, untrusted: {}, sensitive: {}, derived: {} },
  policy_verdict: { decision: null, matched_rule_ids: [] },
  error: {
    code: "backend_unavailable",
    message: "this operation needs a search backend and none is configured",
    remediation: "set $WEBGLASS_BRAVE_API_KEY",
  },
});

const SEARCH_OK = JSON.stringify({
  schema_version: 1,
  kind: "search",
  lifecycle_state: "completed",
  content: {
    trusted: {},
    untrusted: {
      results: [
        { title: "Pi docs", url: "https://pi.dev/docs", snippet: "the extension API" },
        { title: "lobes", url: "https://example.invalid/lobes", snippet: "roles" },
      ],
    },
    sensitive: {},
    derived: {},
  },
  policy_verdict: { decision: "allowed", matched_rule_ids: [] },
  navigation_history: [],
  error: null,
});

const PAGE_OK = JSON.stringify({
  schema_version: 1,
  kind: "page.open",
  lifecycle_state: "completed",
  content: {
    trusted: {},
    untrusted: { title: "Example", text: "the readable page body" },
    sensitive: {},
    derived: {},
  },
  policy_verdict: { decision: "allowed", matched_rule_ids: ["target-allow-public"] },
  navigation_history: [
    { requested_url: "https://example.invalid/", response_url: "https://example.invalid/", status: 200 },
  ],
  error: null,
});

// ---------------------------------------------------------------------------

interface Harness {
  ctx: AssociateContext;
  calls: Array<{ file: string; args: string[] }>;
  dispose: () => void;
}

function harness(options: { maxFetches?: number } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "associate-runs-"));
  const checkout = mkdtempSync(join(tmpdir(), "associate-checkout-"));
  const base = loadContract({});
  const caps = { ...(base.policy.caps as Record<string, unknown>) };
  if (options.maxFetches !== undefined) caps.max_fetches_per_run = options.maxFetches;
  const contract = { ...base, policy: { ...base.policy, caps } };
  const ctx = createAssociateContext({
    checkoutRoot: checkout,
    contract,
    env: { ASSOCIATE_EXPORT_ROOT: root, ASSOCIATE_SESSION_ID: "t8-web" },
  });
  return {
    ctx,
    calls: [],
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    },
  };
}

function fakeSpawn(h: Harness, result: Partial<ProcResult>): Spawn {
  return async (file, args) => {
    h.calls.push({ file, args: [...args] });
    return { code: 0, stdout: "", stderr: "", ...result };
  };
}

function tools(h: Harness, result: Partial<ProcResult>, which: (name: string) => string | null = () => "/usr/local/bin/webglass") {
  return createWebTools(h.ctx, { which, spawn: fakeSpawn(h, result) });
}

function tool(h: Harness, name: string, result: Partial<ProcResult>, which?: (n: string) => string | null) {
  const found = tools(h, result, which).find((t) => t.name === name);
  assert.ok(found, `no tool named ${name}`);
  return found!;
}

async function run(t: ReturnType<typeof tool>, params: Record<string, unknown>) {
  const out = await t.execute("call-1", params);
  return { payload: JSON.parse(out.content[0]!.text), details: out.details as Record<string, any> };
}

// ---------------------------------------------------------------------------
// Criterion 2 — the registered surface is read-only
// ---------------------------------------------------------------------------

test("the registered tool list is exactly web_search and web_page", async () => {
  const h = harness();
  try {
    const registered: Array<{ name: string }> = [];
    await register({ registerTool: (t: { name: string }) => registered.push(t) }, h.ctx);
    assert.deepEqual(
      registered.map((t) => t.name).sort(),
      ["web_page", "web_search"],
    );
  } finally {
    h.dispose();
  }
});

test("no registered tool can submit a form, click, or hold a session", async () => {
  const h = harness();
  try {
    const registered: Array<{ name: string; description?: string; parameters?: any }> = [];
    await register({ registerTool: (t: any) => registered.push(t) }, h.ctx);

    for (const forbidden of ["web_action", "web_session", "action", "session", "click", "submit"]) {
      assert.ok(
        !registered.some((t) => t.name === forbidden),
        `webglass ${forbidden} must not be registered: it can produce outward-facing side effects`,
      );
    }
    // Nor may a registered tool take a session handle, which is how webglass
    // holds a persistent login across calls.
    for (const t of registered) {
      const properties = Object.keys(t.parameters?.properties ?? {});
      for (const banned of ["session_id", "session", "policy_profile"]) {
        assert.ok(
          !properties.includes(banned),
          `${t.name} must not expose ${banned}: the read-only surface is not the model's to widen`,
        );
      }
    }
  } finally {
    h.dispose();
  }
});

test("the webglass verbs spawned are only search and page open", async () => {
  const h = harness();
  try {
    await run(tool(h, "web_search", { stdout: SEARCH_OK }), { query: "pi extension api" });
    await run(tool(h, "web_page", { stdout: PAGE_OK }), { url: "https://example.invalid/" });
    assert.deepEqual(h.calls[0]!.args.slice(0, 1), ["search"]);
    assert.deepEqual(h.calls[1]!.args.slice(0, 2), ["page", "open"]);
    for (const call of h.calls) {
      for (const banned of ["action", "session", "--session-id", "--policy-profile"]) {
        assert.ok(!call.args.includes(banned), `argv must not carry ${banned}`);
      }
    }
  } finally {
    h.dispose();
  }
});

// ---------------------------------------------------------------------------
// Install-hint degradation
// ---------------------------------------------------------------------------

test("with webglass shimmed out of PATH both tools return a structured install hint", async () => {
  const h = harness();
  try {
    for (const [name, params] of [
      ["web_search", { query: "anything" }],
      ["web_page", { url: "https://example.invalid/" }],
    ] as const) {
      const { payload } = await run(tool(h, name, {}, () => null), params);
      assert.equal(payload.ok, false);
      assert.equal(payload.error.code, "tool_missing");
      assert.equal(payload.error.kind, "tool_missing");
      assert.deepEqual(payload.error.detail.install, [
        "uv tool install webglass-cli",
        "playwright install --with-deps chromium",
      ]);
      assert.match(payload.error.message, /uv tool install webglass-cli/);
      assert.match(payload.error.message, /playwright install --with-deps chromium/);
    }
    assert.equal(h.calls.length, 0, "nothing is spawned when the CLI is absent");
  } finally {
    h.dispose();
  }
});

// ---------------------------------------------------------------------------
// Criterion 3 — typed errors, and never page text
// ---------------------------------------------------------------------------

test("a loopback target denied by webglass policy returns a typed policy_denied error", async () => {
  const h = harness();
  try {
    const { payload, details } = await run(tool(h, "web_page", { code: 1, stdout: LOOPBACK_DENIED }), {
      url: "http://127.0.0.1:9/",
    });
    assert.equal(payload.ok, false);
    assert.equal(payload.error.kind, "policy_denied");
    assert.equal(payload.error.code, "policy_denied");
    assert.equal(payload.error.detail.url, "http://127.0.0.1:9/");
    assert.deepEqual(payload.error.detail.matched_rule_ids, ["target-deny-loopback"]);
    assert.match(payload.error.detail.reason, /loopback/);
    assert.equal(payload.text, undefined, "a denial returns no page text");
    assert.equal(payload.content, undefined);
    // The walk gets the URL whatever the outcome.
    assert.equal(details.url, "http://127.0.0.1:9/");
  } finally {
    h.dispose();
  }
});

test("a 403 fetch returns a typed fetch_failed error carrying the status and no page text", async () => {
  const h = harness();
  try {
    const out = await tool(h, "web_page", { code: 1, stdout: FORBIDDEN_403 }).execute("c", {
      url: "https://example.invalid/private",
    });
    const text = out.content[0]!.text;
    const payload = JSON.parse(text);

    assert.equal(payload.ok, false);
    assert.equal(payload.error.kind, "fetch_failed");
    assert.equal(payload.error.detail.status, 403);
    assert.equal(payload.error.detail.url, "https://example.invalid/private");
    assert.equal(payload.error.detail.webglass_code, "navigation_failed");
    assert.ok(
      !text.includes("SECRET PAGE TEXT"),
      "no part of the remote body may ride along on an error result",
    );
    assert.ok(!JSON.stringify(out.details).includes("SECRET PAGE TEXT"));
  } finally {
    h.dispose();
  }
});

test("a 402 response is classified as a paywall, not a generic failure", async () => {
  const h = harness();
  try {
    const out = await tool(h, "web_page", { code: 1, stdout: PAYWALLED_402 }).execute("c", {
      url: "https://example.invalid/article",
    });
    const payload = JSON.parse(out.content[0]!.text);
    assert.equal(payload.error.kind, "paywall");
    assert.equal(payload.error.detail.status, 402);
    assert.ok(!out.content[0]!.text.includes("subscriber-only article body"));
  } finally {
    h.dispose();
  }
});

test("a keyless search reports search_key_missing and names the variable", async () => {
  const h = harness();
  try {
    const { payload } = await run(tool(h, "web_search", { code: 1, stdout: SEARCH_NO_KEY }), {
      query: "widgets",
    });
    assert.equal(payload.error.kind, "search_key_missing");
    assert.match(payload.error.message, /WEBGLASS_BRAVE_API_KEY/);
    assert.equal(payload.error.detail.webglass_code, "backend_unavailable");
  } finally {
    h.dispose();
  }
});

test("unparseable webglass output is a typed fetch_failed, never raw stdout", async () => {
  const h = harness();
  try {
    const { payload } = await run(
      tool(h, "web_page", { code: 1, stdout: "Traceback (most recent call last):\n  ..." }),
      { url: "https://example.invalid/" },
    );
    assert.equal(payload.error.kind, "fetch_failed");
    assert.equal(payload.error.detail.reason, "unparseable_output");
  } finally {
    h.dispose();
  }
});

test("a non-http scheme is refused before webglass is spawned", async () => {
  const h = harness();
  try {
    const { payload } = await run(tool(h, "web_page", { stdout: PAGE_OK }), {
      url: "file:///etc/passwd",
    });
    assert.equal(payload.error.code, "invalid_argument");
    assert.equal(payload.error.detail.field, "url");
    assert.equal(h.calls.length, 0);
  } finally {
    h.dispose();
  }
});

// ---------------------------------------------------------------------------
// Success, budgets, and the per-run fetch cap
// ---------------------------------------------------------------------------

test("a successful page open returns bounded text and records the URL for the walk", async () => {
  const h = harness();
  try {
    const { payload, details } = await run(tool(h, "web_page", { stdout: PAGE_OK }), {
      url: "https://example.invalid/",
    });
    assert.equal(payload.ok, true);
    assert.equal(payload.url, "https://example.invalid/");
    assert.equal(payload.status, 200);
    assert.match(payload.text, /the readable page body/);
    assert.equal(details.url, "https://example.invalid/");
    assert.equal(details.fetches_used, 1);
    assert.deepEqual(details.urls_this_run, ["https://example.invalid/"]);
  } finally {
    h.dispose();
  }
});

test("a successful search records every result URL for the walk", async () => {
  const h = harness();
  try {
    const { payload, details } = await run(tool(h, "web_search", { stdout: SEARCH_OK }), {
      query: "pi extension api",
    });
    assert.equal(payload.ok, true);
    assert.equal(details.query, "pi extension api");
    assert.deepEqual(details.result_urls, ["https://pi.dev/docs", "https://example.invalid/lobes"]);
    assert.deepEqual(details.urls_this_run, ["https://pi.dev/docs", "https://example.invalid/lobes"]);
  } finally {
    h.dispose();
  }
});

test("page text larger than the web budget is bounded", async () => {
  const h = harness();
  try {
    const budget = (h.ctx.policy.budgets as Record<string, { max_output_chars: number }>).web;
    const huge = JSON.stringify({
      schema_version: 1,
      kind: "page.open",
      lifecycle_state: "completed",
      content: { untrusted: { text: "y".repeat(budget.max_output_chars * 3) } },
      policy_verdict: { decision: "allowed" },
      navigation_history: [{ requested_url: "https://example.invalid/big", status: 200 }],
      error: null,
    });
    const out = await tool(h, "web_page", { stdout: huge }).execute("c", {
      url: "https://example.invalid/big",
    });
    assert.ok(out.content[0]!.text.length < huge.length);
    assert.equal((out.details as { truncated: boolean }).truncated, true);
  } finally {
    h.dispose();
  }
});

test("the per-run fetch cap is enforced across both tools and returns a typed error", async () => {
  const h = harness({ maxFetches: 2 });
  try {
    const registry = createWebTools(h.ctx, {
      which: () => "/usr/local/bin/webglass",
      spawn: fakeSpawn(h, { stdout: PAGE_OK }),
    });
    const page = registry.find((t) => t.name === "web_page")!;
    const search = registry.find((t) => t.name === "web_search")!;

    const first = JSON.parse((await page.execute("c", { url: "https://a.invalid/" })).content[0]!.text);
    assert.equal(first.ok, true);
    const second = JSON.parse((await search.execute("c", { query: "q" })).content[0]!.text);
    assert.equal(second.ok, true);

    const third = await page.execute("c", { url: "https://c.invalid/" });
    const payload = JSON.parse(third.content[0]!.text);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.kind, "fetch_failed");
    assert.equal(payload.error.detail.reason, "fetch_cap_exceeded");
    assert.equal(payload.error.detail.cap, 2);
    assert.equal(payload.error.detail.url, "https://c.invalid/");
    assert.equal(h.calls.length, 2, "the capped call never reaches webglass");
  } finally {
    h.dispose();
  }
});

test(
  "against the installed webglass, a loopback target really is denied",
  // Acceptance criterion 3's first half against the real CLI. No network: the
  // policy verdict is reached before a browser is launched. Skipped where
  // webglass is absent — CI installs neither wrapped CLI.
  { skip: whichOnPath("webglass") === null ? "webglass is not on PATH" : false },
  async () => {
    const h = harness();
    try {
      const page = createWebTools(h.ctx).find((t) => t.name === "web_page")!;
      const out = await page.execute("c", { url: "http://127.0.0.1:9/" });
      const payload = JSON.parse(out.content[0]!.text);
      assert.equal(payload.ok, false);
      assert.equal(payload.error.kind, "policy_denied");
      assert.match(payload.error.detail.reason, /loopback/);
      assert.deepEqual(payload.error.detail.matched_rule_ids, ["target-deny-loopback"]);
      assert.equal(payload.text, undefined, "a denial returns no page text");
      assert.equal((out.details as { url: string }).url, "http://127.0.0.1:9/");
    } finally {
      h.dispose();
    }
  },
);

test("each registered tool set gets its own fetch counter", async () => {
  const h = harness({ maxFetches: 1 });
  try {
    const a = tool(h, "web_page", { stdout: PAGE_OK });
    const b = tool(h, "web_page", { stdout: PAGE_OK });
    assert.equal(JSON.parse((await a.execute("c", { url: "https://a.invalid/" })).content[0]!.text).ok, true);
    assert.equal(JSON.parse((await b.execute("c", { url: "https://b.invalid/" })).content[0]!.text).ok, true);
  } finally {
    h.dispose();
  }
});
