/**
 * The context handed to tool modules, and the dynamic loader that hands it over.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssociateContext, loadToolModules } from "../lib/runtime.ts";
import { normalizeHandback, unreferencedCount } from "../lib/handback.ts";

function context() {
  const root = mkdtempSync(join(tmpdir(), "associate-runs-"));
  const checkout = mkdtempSync(join(tmpdir(), "associate-checkout-"));
  const ctx = createAssociateContext({
    checkoutRoot: checkout,
    env: { ASSOCIATE_EXPORT_ROOT: root, ASSOCIATE_SESSION_ID: "ctx-session" },
  });
  return {
    ctx,
    checkout,
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    },
  };
}

test("the context exposes the contract, the session dirs and the contain helpers", () => {
  const c = context();
  try {
    assert.ok(c.ctx.policy.version);
    assert.deepEqual(Object.keys(c.ctx.schemas).sort(), ["statements", "task", "walk"]);
    assert.equal(c.ctx.session.sessionId, "ctx-session");
    assert.equal(c.ctx.contain.isInside(c.checkout, join(c.checkout, "a", "b")), true);
    assert.equal(
      c.ctx.contain.resolveWithin("docs/spec.md"),
      join(c.checkout, "docs", "spec.md"),
    );
    assert.throws(() => c.ctx.contain.resolveWithin("../../etc/passwd"), /escapes/);
  } finally {
    c.dispose();
  }
});

test("a tool module can declare itself a writer, and the guard then sees it", () => {
  const c = context();
  try {
    assert.equal(c.ctx.contain.isWriter("draft_file"), false);
    c.ctx.declareWriter("draft_file");
    assert.equal(c.ctx.contain.isWriter("draft_file"), true);
    assert.deepEqual(c.ctx.declaredWriters(), ["draft_file"]);
  } finally {
    c.dispose();
  }
});

test("loadToolModules imports every module and calls register(pi, ctx)", async () => {
  const c = context();
  const dir = mkdtempSync(join(tmpdir(), "associate-tools-"));
  try {
    writeFileSync(
      join(dir, "alpha.ts"),
      "export function register(pi, ctx) { pi.seen.push(['alpha', ctx.session.sessionId]); }\n",
    );
    mkdirSync(join(dir, "beta"));
    writeFileSync(
      join(dir, "beta", "index.ts"),
      "export function register(pi) { pi.seen.push(['beta', null]); }\n",
    );

    const pi = { seen: [] as unknown[] };
    const loaded = await loadToolModules(pi, c.ctx, dir);
    assert.deepEqual(pi.seen, [
      ["alpha", "ctx-session"],
      ["beta", null],
    ]);
    assert.deepEqual(
      loaded.map((entry) => entry.name),
      ["alpha", "index"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    c.dispose();
  }
});

test("a tool module without register() fails the load loudly", async () => {
  const c = context();
  const dir = mkdtempSync(join(tmpdir(), "associate-tools-"));
  try {
    writeFileSync(join(dir, "broken.ts"), "export const nope = 1;\n");
    await assert.rejects(() => loadToolModules({}, c.ctx, dir), /does not export register/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    c.dispose();
  }
});

test("the hand-back is shaped by the contract, not by the model", () => {
  const handback = normalizeHandback(
    {
      summary: "  A summary.  ",
      statements: [
        { text: "Cited.", evidence: ["w1", "w02", "nope", "w12"] },
        { text: "  ", evidence: ["w1"] },
        { text: "Uncited." },
      ],
      citations: [
        { path: "a.py", line: 12.9 },
        { path: "", line: 3 },
        { path: "b.py", line: "nope" },
      ],
    },
    true,
  );
  assert.equal(handback.summary, "A summary.");
  assert.equal(handback.statements.length, 2, "empty statements are dropped");
  assert.deepEqual(handback.statements[0]!.evidence, ["w1", "w12"], "w02 and nope are not walk ids");
  assert.equal(handback.statements[1]!.status, "unreferenced");
  assert.deepEqual(handback.citations, [{ path: "a.py", line: 12, check: "unverifiable" }]);
  assert.equal(handback.not_fully_read, true, "set by the run, not by the payload");
  assert.equal(unreferencedCount(handback), 1);
});
