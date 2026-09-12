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
import {
  BUILTIN_WRITER_TOOLS,
  collectPathArguments,
  evaluateToolCall,
  isWriterTool,
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
