/**
 * The write guard (spec c4/c5, acceptance criterion 2).
 *
 * These drive the hook's decision function directly with fake tool calls. The
 * companion end-to-end proof — that the block is visible in a real pi
 * transcript — lives in `pi-integration.test.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import {
  BUILTIN_WRITER_TOOLS,
  collectPathArguments,
  confineWriteToCheckout,
  evaluateToolCall,
  isWriterTool,
  resolveWriteDestination,
  resolveWriteTarget,
} from "../lib/guard.ts";

const scratchDir = join(tmpdir(), "associate-runs", "sess-1", "scratch");
const cwd = join(tmpdir(), "examined-checkout");

test("a write outside the scratch dir is blocked with a reason naming both paths", () => {
  const decision = evaluateToolCall({
    toolName: "write",
    input: { path: "associate/cli/__init__.py", content: "x" },
    scratchDir,
    cwd,
  });
  assert.ok(decision, "expected the call to be blocked");
  assert.equal(decision!.block, true);
  assert.match(decision!.reason, /outside this session's/);
  assert.ok(decision!.reason.includes(scratchDir), "reason must name the scratch dir");
  assert.ok(
    decision!.reason.includes(join(cwd, "associate/cli/__init__.py")),
    "reason must name the resolved target",
  );
});

test("an absolute path outside the scratch dir is blocked", () => {
  const decision = evaluateToolCall({
    toolName: "edit",
    input: { file_path: "/etc/hosts", edits: [] },
    scratchDir,
    cwd,
  });
  assert.ok(decision);
  assert.match(decision!.reason, /\/etc\/hosts/);
});

test("a path that escapes the scratch dir with .. is blocked", () => {
  const decision = evaluateToolCall({
    toolName: "write",
    input: { path: join(scratchDir, "..", "..", "escape.txt") },
    scratchDir,
    cwd,
  });
  assert.ok(decision);
});

test("a write inside the scratch dir is allowed", () => {
  assert.equal(
    evaluateToolCall({
      toolName: "write",
      input: { path: join(scratchDir, "notes", "draft.md") },
      scratchDir,
      cwd,
    }),
    undefined,
  );
});

test("a writer with no path argument is blocked rather than waved through", () => {
  const decision = evaluateToolCall({
    toolName: "bash",
    input: { command: "echo hi > /tmp/f" },
    scratchDir,
    cwd,
  });
  assert.ok(decision);
  assert.match(decision!.reason, /declares no path to confine/);
});

test("a read outside the scratch dir is allowed: inspection is the job", () => {
  for (const toolName of ["read", "grep", "find", "ls", "associate_ready", "finish"]) {
    assert.equal(
      evaluateToolCall({ toolName, input: { path: "/etc/hosts" }, scratchDir, cwd }),
      undefined,
      `${toolName} must not be treated as a writer`,
    );
  }
});

test("a tool that declares itself a writer is guarded too", () => {
  const call = { toolName: "draft_file", input: { output: "/tmp/elsewhere.md" }, scratchDir, cwd };
  assert.equal(evaluateToolCall(call), undefined);
  assert.ok(evaluateToolCall({ ...call, declaredWriters: ["draft_file"] }));
});

test("pi's built-in writers are all recognised", () => {
  for (const name of BUILTIN_WRITER_TOOLS) {
    assert.equal(isWriterTool(name), true);
    assert.equal(isWriterTool(name.toUpperCase()), true);
  }
  assert.equal(isWriterTool("read"), false);
});

test("pi 0.84.3's built-in powershell is a writer, blocked like bash", () => {
  // pi 0.84.3 added an optional `powershell` built-in (docs/windows.md): an
  // unrestricted shell exactly like the built-in bash, configurable through
  // defaultTools/--tools. The extension never registers a safe override under
  // that name, so it must be judged a writer and dropped from the active set.
  assert.equal(isWriterTool("powershell"), true);
  const decision = evaluateToolCall({
    toolName: "powershell",
    input: { command: "Set-Content -Path hello.txt -Value hi" },
    scratchDir,
    cwd: "/repo",
  });
  assert.equal(decision?.block, true);
});

test("every path-shaped argument is collected, including arrays", () => {
  const paths = collectPathArguments({
    path: "a.txt",
    files: ["b.txt", "c.txt"],
    cwd: "/tmp",
    content: "not a path",
    line: 3,
    empty: "",
  });
  assert.deepEqual(paths, ["a.txt", ["b.txt", "c.txt"], "/tmp"].flat());
});

// ---------------------------------------------- review r2/2: checkout confinement

test("r2/2: write targets resolve the way pi's resolveToCwd does", () => {
  const home = join(tmpdir(), "fake-home");
  assert.equal(resolveWriteTarget("~", cwd, home), home);
  assert.equal(resolveWriteTarget("~/.bashrc", cwd, home), join(home, ".bashrc"));
  assert.equal(resolveWriteTarget("@src/a.ts", cwd, home), join(cwd, "src", "a.ts"));
  assert.equal(resolveWriteTarget("@/etc/x", cwd, home), "/etc/x");
  assert.equal(resolveWriteTarget("file:///etc/x", cwd, home), "/etc/x");
  assert.equal(resolveWriteTarget("a/../../b", cwd, home), join(cwd, "..", "b"));
});

test("r2/2: a dangling symlink is followed to where a write would create it", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "associate-r2-dangle-")));
  try {
    mkdirSync(join(dir, "root"));
    symlinkSync(join(dir, "elsewhere", "f.txt"), join(dir, "root", "link.txt"));
    assert.equal(resolveWriteDestination(join(dir, "root", "link.txt")), join(dir, "elsewhere", "f.txt"));
    symlinkSync(join(dir, "root", "loop-b"), join(dir, "root", "loop-a"));
    symlinkSync(join(dir, "root", "loop-a"), join(dir, "root", "loop-b"));
    assert.throws(() => resolveWriteDestination(join(dir, "root", "loop-a")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("r2/2: confineWriteToCheckout passes non-writers and refuses a pathless writer", () => {
  const base = { checkoutRoot: cwd, scratchDir, cwd };
  assert.equal(confineWriteToCheckout({ ...base, toolName: "read", input: { path: "/etc/passwd" } }), undefined);
  assert.equal(
    confineWriteToCheckout({ ...base, toolName: "bash", input: { argv: ["ls"] }, declaredNonWriters: ["bash"] }),
    undefined,
  );
  assert.match(confineWriteToCheckout({ ...base, toolName: "bash", input: { command: "rm -rf ~" } })!.reason, /declares no path/);
  assert.equal(confineWriteToCheckout({ ...base, toolName: "write", input: { path: join(scratchDir, "d.md") } }), undefined);
  assert.match(confineWriteToCheckout({ ...base, toolName: "write", input: { path: "/etc/x" } })!.reason, /outside the run's checkout/);
});

// ------------------------------------------------ r15 still fires on any cut state (d16)

import { decideToolCall } from "../lib/guard.ts";
import { compileGate } from "../lib/gate.ts";
import type { Gate, GateEntry } from "../lib/gate.ts";
import { loadContract } from "../lib/contract.ts";
import { resolveActiveModel } from "../lib/toolset.ts";

function fakeGate(entry: Partial<GateEntry>): Gate {
  const contract = loadContract({});
  const config = compileGate(contract);
  return {
    config,
    evaluate: async () => ({
      id: "g1",
      ts: "2026-10-28T00:00:00.000Z",
      question_set_version: config.version,
      gated_tool: "write",
      tier: "clef",
      decision: "allow",
      ...entry,
    }),
  };
}

async function guardWrite(entry: Partial<GateEntry>, content: string) {
  const contract = loadContract({});
  const recorded: GateEntry[] = [];
  const decision = await decideToolCall({
    toolName: "write",
    input: { path: "f.txt", content },
    model: resolveActiveModel({ ASSOCIATE_MODEL: "worker" }, contract.models),
    registry: contract.models,
    policy: contract.policy,
    gate: fakeGate(entry),
    task: "t",
    scratchDir,
    cwd,
    recordGate: (e) => recorded.push(e),
  });
  return { decision, recorded };
}

test("r15: an allow from a tier that saw a cut state (clef/super) is still refused", async () => {
  const contract = loadContract({});
  const big = "x".repeat((contract.gate as any).decider.max_input_tokens * 2);
  for (const tier of ["clef", "super"] as const) {
    const { decision, recorded } = await guardWrite({ tier }, big);
    assert.ok(decision?.block, tier);
    assert.match(decision!.reason, /r15/);
    assert.equal(recorded[0]!.decision, "refuse");
  }
  // The gate's own truncation marker refuses too, whatever the size.
  const marked = await guardWrite({ tier: "clef", reason: "clef: ok (state truncated to fit the decider)" }, "small");
  assert.ok(marked.decision?.block);
});

test("d16: a large-tier allow on the full state is not a truncation, and is not refused by r15", async () => {
  const contract = loadContract({});
  const big = "x".repeat((contract.gate as any).decider.max_input_tokens * 2);
  const { decision, recorded } = await guardWrite({ tier: "large", evaluator: "cortex", verdict: {} }, big);
  assert.equal(decision, undefined, decision?.reason);
  assert.equal(recorded[0]!.decision, "allow");
  // Fitting states at clef are unaffected.
  const small = await guardWrite({ tier: "clef" }, "small");
  assert.equal(small.decision, undefined);
});
