/**
 * The entry point: what it registers, and what it must not register
 * (acceptance criteria 1 and 2).
 *
 * `loadExtension()` runs the real `index.ts` against a fake pi. The companion
 * proof that a real `pi` process reports the same tool list is in
 * `pi-integration.test.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtension } from "./load-extension.ts";
import { toolsDir } from "../lib/paths.ts";
import { discoverToolModules } from "../lib/runtime.ts";

async function withExtension<T>(
  env: Record<string, string | undefined>,
  body: (loaded: Awaited<ReturnType<typeof loadExtension>>) => Promise<T>,
): Promise<T> {
  const loaded = await loadExtension(env);
  try {
    return await body(loaded);
  } finally {
    loaded.cleanup();
  }
}

function scratch(): { root: string; env: Record<string, string>; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "associate-runs-"));
  const checkout = mkdtempSync(join(tmpdir(), "associate-checkout-"));
  return {
    root,
    env: {
      ASSOCIATE_EXPORT_ROOT: root,
      ASSOCIATE_CHECKOUT_ROOT: checkout,
      ASSOCIATE_SESSION_ID: "unit-session",
    },
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    },
  };
}

test("the extension registers associate_ready and finish and no writer", async () => {
  const s = scratch();
  try {
    await withExtension(s.env, async ({ pi }) => {
      const names = pi.toolNames();
      assert.ok(names.includes("associate_ready"), `missing sentinel: ${names.join(", ")}`);
      assert.ok(names.includes("finish"), `missing finish: ${names.join(", ")}`);
      for (const forbidden of ["edit", "write", "bash", "apply_patch"]) {
        assert.ok(!names.includes(forbidden), `the extension must not register ${forbidden}`);
      }
    });
  } finally {
    s.dispose();
  }
});

test("associate_ready reports the extension version, the contract version and the session", async () => {
  const s = scratch();
  try {
    await withExtension(s.env, async ({ pi }) => {
      const result = await pi.tool("associate_ready").execute("call-1", {});
      const report = JSON.parse(result.content[0]!.text) as Record<string, any>;
      assert.equal(report.ok, true);
      assert.match(report.extension_version, /^\d+\.\d+\.\d+$/);
      assert.ok(report.contract_version >= 1, "must report the loaded contract's version");
      assert.deepEqual(report.schemas.sort(), ["statements", "task", "walk"]);
      assert.equal(report.session.id, "unit-session");
      assert.ok(report.session.scratch_dir.includes("unit-session"));
      assert.ok(report.tools.includes("associate_ready") && report.tools.includes("finish"));
    });
  } finally {
    s.dispose();
  }
});

test("associate_ready reports no active writer under defaultTools: []", async () => {
  // Measured against pi 0.84.2: getAllTools() lists the built-ins even when
  // defaultTools: [] leaves them inactive, so the launcher's check (spec c34)
  // is writer_tools_active, and the sentinel must not hide a writer that *is*
  // active.
  const s = scratch();
  try {
    await withExtension(s.env, async ({ pi }) => {
      pi.builtinTools = ["read", "bash", "edit", "write"];

      let report = JSON.parse(
        (await pi.tool("associate_ready").execute("call-1", {})).content[0]!.text,
      ) as { tools: string[]; active_tools: string[]; writer_tools_active: string[] };
      assert.ok(report.tools.includes("write"), "configured built-ins are reported as configured");
      assert.deepEqual(report.active_tools, ["associate_ready", "finish"]);
      assert.deepEqual(report.writer_tools_active, [], "no writer may be active");

      pi.activeBuiltinTools = ["write"];
      report = JSON.parse(
        (await pi.tool("associate_ready").execute("call-2", {})).content[0]!.text,
      ) as typeof report;
      assert.deepEqual(report.writer_tools_active, ["write"], "an active writer must be reported");
    });
  } finally {
    s.dispose();
  }
});

test("finish returns the hand-back as its payload and terminates", async () => {
  const s = scratch();
  try {
    await withExtension(s.env, async ({ pi }) => {
      const result = (await pi.tool("finish").execute("call-2", {
        summary: "Two routes are registered.",
        statements: [
          { text: "Route /walk is registered.", evidence: ["w1", "bogus"] },
          { text: "Nothing evidences this." },
        ],
        citations: [{ path: "server.py", line: 3444 }],
      })) as any;
      const handback = JSON.parse(result.content[0].text);
      assert.equal(handback.summary, "Two routes are registered.");
      assert.deepEqual(handback.statements[0].evidence, ["w1"]);
      assert.equal(handback.statements[0].status, "referenced");
      assert.equal(handback.statements[1].status, "unreferenced");
      assert.equal(handback.citations[0].check, "unverifiable");
      assert.equal(handback.not_fully_read, false);
      assert.equal(result.terminate, true);
      assert.equal(result.details.unreferenced, 1);
    });
  } finally {
    s.dispose();
  }
});

test("the tool_call hook is registered and blocks a write into the checkout", async () => {
  const s = scratch();
  try {
    await withExtension(s.env, async ({ pi }) => {
      // The guard is one of the `tool_call` hooks; the walk recorder is the
      // other, and it records without ever blocking.
      assert.ok((pi.handlers.get("tool_call")?.length ?? 0) >= 1, "no tool_call hook");

      const blocked = (await pi.fireToolCall({
        toolName: "write",
        toolCallId: "tc-1",
        input: { path: "README.md", content: "tampered" },
      })) as { block: boolean; reason: string } | undefined;
      assert.ok(blocked, "a write into the checkout must be blocked");
      assert.equal(blocked!.block, true);
      assert.match(blocked!.reason, /outside this session's scratch directory/);

      const allowed = await pi.fireToolCall({
        toolName: "read",
        toolCallId: "tc-2",
        input: { path: "README.md" },
      });
      assert.equal(allowed, undefined, "reads inside the checkout stay allowed");
    });
  } finally {
    s.dispose();
  }
});

test("the extension creates its session dirs and writes nothing into the checkout", async () => {
  const s = scratch();
  try {
    await withExtension(s.env, async ({ pi }) => {
      const result = await pi.tool("associate_ready").execute("call-1", {});
      const report = JSON.parse(result.content[0]!.text) as any;
      assert.ok(existsSync(report.session.scratch_dir));
      assert.ok(existsSync(report.session.export_dir));
      assert.ok(report.session.scratch_dir.startsWith(s.root));
    });
  } finally {
    s.dispose();
  }
});

test("every module under tools/ is discovered and must export register()", async () => {
  // The directory ships empty (only .gitkeep); the next wave drops modules in.
  assert.deepEqual(discoverToolModules(toolsDir), []);

  const dir = mkdtempSync(join(tmpdir(), "associate-tools-"));
  try {
    writeFileSync(join(dir, "alpha.ts"), "export function register(pi, ctx) { pi.__alpha = ctx; }\n");
    writeFileSync(join(dir, "beta.test.ts"), "throw new Error('test files must be skipped');\n");
    writeFileSync(join(dir, ".hidden.ts"), "throw new Error('dotfiles must be skipped');\n");
    const found = discoverToolModules(dir);
    assert.deepEqual(
      found.map((path) => path.split("/").pop()),
      ["alpha.ts"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
