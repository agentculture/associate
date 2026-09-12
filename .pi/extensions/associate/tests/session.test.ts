/**
 * Per-session scratch and export directories (spec c42, acceptance criterion 3).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { loadContract } from "../lib/contract.ts";
import {
  generateSessionId,
  isInside,
  resolveExportRoot,
  resolveSessionDirs,
  resolveSessionId,
  sanitizeSessionId,
} from "../lib/session.ts";

const policy = loadContract({}).policy;

test("the ACP session id keys the directories when present", () => {
  const { sessionId, fromEnv } = resolveSessionId({ PI_ACP_SESSION_ID: "sess-abc-123" });
  assert.equal(sessionId, "sess-abc-123");
  assert.equal(fromEnv, true);
});

test("a generated id is used when no session id is in the environment", () => {
  const { sessionId, fromEnv } = resolveSessionId({});
  assert.equal(fromEnv, false);
  assert.match(sessionId, /^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
  assert.notEqual(sessionId, generateSessionId());
});

test("a session id can never escape its directory", () => {
  assert.match(sanitizeSessionId("../../etc/passwd"), /^etc-passwd-[0-9a-f]{8}$/);
  assert.match(sanitizeSessionId("a/b"), /^a-b-[0-9a-f]{8}$/);
  assert.ok(!sanitizeSessionId("...").includes("."));
  for (const raw of ["../../etc/passwd", "a/b", "...", "  ", "a\0b"]) {
    assert.ok(!sanitizeSessionId(raw).includes("/"), `${JSON.stringify(raw)} kept a separator`);
    assert.ok(!sanitizeSessionId(raw).startsWith("."), `${JSON.stringify(raw)} kept a leading dot`);
  }
});

test("an id that needs no sanitizing is returned verbatim", () => {
  for (const raw of ["session-alpha", "task-a", "abc_123.4", "A".repeat(96)]) {
    assert.equal(sanitizeSessionId(raw), raw);
  }
});

test("two ids that clean to the same text get different directories", () => {
  // The finding: `task/a` and `task-a` both cleaned to `task-a`, so two
  // concurrent runs shared one scratch dir and could corrupt each other's
  // artifacts. Distinct ids must stay distinct.
  const slashed = sanitizeSessionId("task/a");
  const dashed = sanitizeSessionId("task-a");
  assert.notEqual(slashed, dashed);
  assert.equal(dashed, "task-a");
  assert.match(slashed, /^task-a-[0-9a-f]{8}$/);
  // Stable across calls — the directory has to be findable again.
  assert.equal(sanitizeSessionId("task/a"), slashed);
  // …and the same for two other ids that clean alike.
  assert.notEqual(sanitizeSessionId("a/b"), sanitizeSessionId("a b"));
});

test("an over-long id is truncated but still unique", () => {
  const a = sanitizeSessionId("x".repeat(200));
  const b = sanitizeSessionId(`${"x".repeat(199)}y`);
  assert.equal(a.length, 96);
  assert.equal(b.length, 96);
  assert.match(a, /^x{87}-[0-9a-f]{8}$/);
  assert.notEqual(a, b);
});

test("an id that sanitizes to nothing falls back to a generated one", () => {
  assert.match(sanitizeSessionId("..."), /^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
  assert.match(sanitizeSessionId("   "), /^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
});

test("the export root sits outside the examined checkout", () => {
  const checkout = join(tmpdir(), "some-checkout");
  const root = resolveExportRoot(checkout, policy, {});
  assert.equal(isInside(checkout, root), false);
  assert.ok(root.endsWith(`${sep}.associate-runs`), `unexpected export root ${root}`);
});

test("an export root inside the checkout is refused, not relocated", () => {
  const checkout = join(tmpdir(), "some-checkout");
  assert.throws(
    () => resolveExportRoot(checkout, policy, { ASSOCIATE_EXPORT_ROOT: join(checkout, "runs") }),
    /inside the examined checkout/,
  );
});

test("two parallel sessions resolve disjoint scratch and export dirs named by their ids", () => {
  const root = mkdtempSync(join(tmpdir(), "associate-runs-"));
  const checkout = mkdtempSync(join(tmpdir(), "associate-checkout-"));
  try {
    const a = resolveSessionDirs({
      checkoutRoot: checkout,
      policy,
      env: { ASSOCIATE_EXPORT_ROOT: root, PI_ACP_SESSION_ID: "session-alpha" },
    });
    const b = resolveSessionDirs({
      checkoutRoot: checkout,
      policy,
      env: { ASSOCIATE_EXPORT_ROOT: root, PI_ACP_SESSION_ID: "session-beta" },
    });

    assert.equal(a.sessionId, "session-alpha");
    assert.equal(b.sessionId, "session-beta");

    // Disjoint.
    assert.notEqual(a.scratchDir, b.scratchDir);
    assert.notEqual(a.exportDir, b.exportDir);
    assert.equal(isInside(a.sessionRoot, b.scratchDir), false);
    assert.equal(isInside(b.sessionRoot, a.scratchDir), false);

    // Each path carries its own session id and no other.
    for (const [id, dirs] of [
      ["session-alpha", a],
      ["session-beta", b],
    ] as const) {
      for (const dir of [dirs.sessionRoot, dirs.scratchDir, dirs.exportDir]) {
        assert.ok(dir.includes(id), `${dir} does not carry the session id ${id}`);
      }
    }

    // Created, and outside the checkout.
    for (const dir of [a.scratchDir, a.exportDir, b.scratchDir, b.exportDir]) {
      assert.ok(existsSync(dir), `${dir} was not created`);
      assert.equal(isInside(checkout, dir), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("create: false resolves paths without touching the filesystem", () => {
  const root = join(tmpdir(), `associate-unwritten-${process.pid}`);
  const dirs = resolveSessionDirs({
    checkoutRoot: join(tmpdir(), "checkout"),
    policy,
    env: { ASSOCIATE_EXPORT_ROOT: root, ASSOCIATE_SESSION_ID: "dry-run" },
    create: false,
  });
  assert.equal(dirs.sessionId, "dry-run");
  assert.equal(existsSync(dirs.scratchDir), false);
});
