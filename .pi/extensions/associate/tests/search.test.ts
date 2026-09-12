/**
 * `find`, `grep` and `ls` (task t6, plan associate-on-pi-with-opinionated-tools,
 * covers c20).
 *
 * The cap and spawn-shape assertions drive `runGrep`/`runFind` with an
 * injected fake `Spawner` so they run with no dependency on the real `rg`/`fd`
 * binaries being installed on the test machine and so the exact
 * `(bin, argv, options)` triple reaching `child_process.spawn` can be
 * inspected directly. `ls` reads the filesystem itself (no subprocess), so its
 * tests use a real fixture directory. The escape-refusal tests never call the
 * spawner at all — confinement and pattern checks run before anything spawns.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAssociateContext } from "../lib/runtime.ts";
import {
  capResults,
  resolveAgentBinDir,
  resolveBinary,
  runFind,
  runGrep,
  runLs,
  type ProcessResult,
  type Spawner,
} from "../tools/search.ts";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function context() {
  const checkout = mkdtempSync(join(tmpdir(), "associate-search-checkout-"));
  const exportRoot = mkdtempSync(join(tmpdir(), "associate-search-runs-"));
  const ctx = createAssociateContext({
    checkoutRoot: checkout,
    env: { ASSOCIATE_EXPORT_ROOT: exportRoot, ASSOCIATE_SESSION_ID: "search-test" },
  });
  return {
    ctx,
    checkout,
    dispose: () => {
      rmSync(checkout, { recursive: true, force: true });
      rmSync(exportRoot, { recursive: true, force: true });
    },
  };
}

interface RecordedCall {
  bin: string;
  argv: string[];
  options: { cwd: string; shell: boolean };
}

// runGrep/runFind call runProcess(bin, argv, cwd, spawner), and runProcess
// expects the Spawner to return a ChildProcess-shaped object with .stdout,
// .stderr and .on(). Build a minimal fake of that instead of stubbing
// runProcess itself, so the real runProcess code (argv array, shell:false)
// is exercised end to end.
function fakeChildProcessSpawner(stdout: string, code: number): { spawner: Spawner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const spawner = ((bin: string, argv: string[], options: { cwd: string; shell: false }) => {
    calls.push({ bin, argv: [...argv], options: { ...options } });
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const stream = (data: string) => ({
      on(event: string, cb: (chunk: Buffer) => void) {
        if (event === "data") cb(Buffer.from(data, "utf8"));
        return stream;
      },
    });
    const fake = {
      stdout: stream(stdout),
      stderr: stream(""),
      on(event: string, cb: (...args: unknown[]) => void) {
        (listeners[event] ??= []).push(cb);
        if (event === "close") queueMicrotask(() => cb(code));
        return fake;
      },
    };
    return fake as unknown as ReturnType<Spawner>;
  }) as Spawner;
  return { spawner, calls };
}

// ---------------------------------------------------------------------------
// bin resolution
// ---------------------------------------------------------------------------

test("resolveAgentBinDir prefers $PI_CODING_AGENT_DIR, falls back to ~/.pi/agent/bin", () => {
  const fakeAgentDir = mkdtempSync(join(tmpdir(), "associate-agentdir-"));
  mkdirSync(join(fakeAgentDir, "bin"));
  writeFileSync(join(fakeAgentDir, "bin", "rg"), "#!/bin/sh\n");
  try {
    const dir = resolveAgentBinDir({ PI_CODING_AGENT_DIR: fakeAgentDir });
    assert.equal(dir, join(fakeAgentDir, "bin"));

    const empty = resolveAgentBinDir({ PI_CODING_AGENT_DIR: join(tmpdir(), "does-not-exist-associate") });
    // Falls through to os.homedir()/.pi/agent/bin, which may or may not exist
    // on the test machine; either a string or undefined is a valid answer,
    // the point is it never throws and never returns the missing env dir.
    assert.notEqual(empty, join(tmpdir(), "does-not-exist-associate", "bin"));
  } finally {
    rmSync(fakeAgentDir, { recursive: true, force: true });
  }
});

test("resolveBinary falls back to the bare command name when no vendored bin dir has it", () => {
  const emptyAgentDir = mkdtempSync(join(tmpdir(), "associate-agentdir-empty-"));
  try {
    const bin = resolveBinary("rg", { PI_CODING_AGENT_DIR: emptyAgentDir });
    assert.equal(bin, "rg");
  } finally {
    rmSync(emptyAgentDir, { recursive: true, force: true });
  }
});

test("resolveBinary resolves to the vendored path when present", () => {
  const fakeAgentDir = mkdtempSync(join(tmpdir(), "associate-agentdir-vendored-"));
  mkdirSync(join(fakeAgentDir, "bin"));
  const rgPath = join(fakeAgentDir, "bin", "fd");
  writeFileSync(rgPath, "#!/bin/sh\n");
  try {
    const bin = resolveBinary("fd", { PI_CODING_AGENT_DIR: fakeAgentDir });
    assert.equal(bin, rgPath);
  } finally {
    rmSync(fakeAgentDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// capResults
// ---------------------------------------------------------------------------

test("capResults slices at the cap and reports truncated only when it bites", () => {
  const under = capResults([1, 2, 3], 200);
  assert.deepEqual(under, { items: [1, 2, 3], count: 3, truncated: false });

  const exact = capResults(Array.from({ length: 200 }, (_, i) => i), 200);
  assert.equal(exact.truncated, false);
  assert.equal(exact.items.length, 200);

  const over = capResults(Array.from({ length: 300 }, (_, i) => i), 200);
  assert.equal(over.truncated, true);
  assert.equal(over.items.length, 200);
  assert.equal(over.count, 300);
});

// ---------------------------------------------------------------------------
// criterion 1 — grep and find cap at 200 with truncated:true
// ---------------------------------------------------------------------------

test("grep caps at policy.caps.max_results (200) and sets truncated:true when a fixture has 300 matches", async () => {
  const c = context();
  try {
    const cap = (c.ctx.policy as { caps?: { max_results?: number } }).caps?.max_results ?? 200;
    assert.equal(cap, 200, "the real policy.json fixture must declare caps.max_results = 200");

    const lines = Array.from({ length: 300 }, (_, i) => `src/file${i}.py:1:needle match ${i}`).join("\n") + "\n";
    const { spawner, calls } = fakeChildProcessSpawner(lines, 0);
    const result = await runGrep(c.ctx, { pattern: "needle" }, spawner);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.matches.length, 200);
    assert.equal(result.count, 300);
    assert.equal(result.truncated, true);
    assert.equal(result.cap, 200);

    assert.equal(calls.length, 1);
    assert.ok(Array.isArray(calls[0]!.argv), "spawn must be called with an argv array");
    assert.equal(calls[0]!.options.shell, false, "spawn must never use a shell");
    assert.ok(calls[0]!.argv.includes("needle"), "the pattern is passed as one argv element, not shell text");
  } finally {
    c.dispose();
  }
});

test("grep under the cap is not truncated", async () => {
  const c = context();
  try {
    const lines = Array.from({ length: 5 }, (_, i) => `a.py:${i + 1}:needle`).join("\n") + "\n";
    const { spawner } = fakeChildProcessSpawner(lines, 0);
    const result = await runGrep(c.ctx, { pattern: "needle" }, spawner);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.matches.length, 5);
    assert.equal(result.truncated, false);
  } finally {
    c.dispose();
  }
});

test("find caps at policy.caps.max_results (200) and sets truncated:true when a fixture has 300 files", async () => {
  const c = context();
  try {
    const lines = Array.from({ length: 300 }, (_, i) => join(c.checkout, `file${i}.txt`)).join("\n") + "\n";
    const { spawner, calls } = fakeChildProcessSpawner(lines, 0);
    const result = await runFind(c.ctx, { pattern: "file" }, spawner);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.matches.length, 200);
    assert.equal(result.count, 300);
    assert.equal(result.truncated, true);

    assert.equal(calls.length, 1);
    assert.ok(Array.isArray(calls[0]!.argv));
    assert.equal(calls[0]!.options.shell, false);
  } finally {
    c.dispose();
  }
});

// ---------------------------------------------------------------------------
// criterion 2 — escape refusals, structured error, no spawn
// ---------------------------------------------------------------------------

test("grep refuses a pattern containing a literal '..' segment before spawning anything", async () => {
  const c = context();
  try {
    const { spawner, calls } = fakeChildProcessSpawner("", 0);
    const result = await runGrep(c.ctx, { pattern: "../../etc/passwd" }, spawner);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "pattern_escapes_root");
    assert.equal(calls.length, 0, "an escaping pattern must never reach spawn");
  } finally {
    c.dispose();
  }
});

test("grep refuses a path that escapes the checkout root with ../", async () => {
  const c = context();
  try {
    const { spawner, calls } = fakeChildProcessSpawner("", 0);
    const result = await runGrep(c.ctx, { pattern: "needle", path: "../outside" }, spawner);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "path_escapes_root");
    assert.equal(calls.length, 0);
  } finally {
    c.dispose();
  }
});

test("find refuses an absolute path outside the checkout root", async () => {
  const c = context();
  try {
    const { spawner, calls } = fakeChildProcessSpawner("", 0);
    const result = await runFind(c.ctx, { path: "/etc" }, spawner);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "path_escapes_root");
    assert.equal(calls.length, 0);
  } finally {
    c.dispose();
  }
});

test("ls refuses an absolute path outside the checkout root", () => {
  const c = context();
  try {
    const result = runLs(c.ctx, { path: "/etc" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "path_escapes_root");
    assert.equal(result.field, "path");
  } finally {
    c.dispose();
  }
});

test("ls refuses a path containing ../ that escapes the checkout root", () => {
  const c = context();
  try {
    const result = runLs(c.ctx, { path: "../../etc" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "path_escapes_root");
  } finally {
    c.dispose();
  }
});

test("grep and find report a validation error for a missing/invalid pattern before spawning", async () => {
  const c = context();
  try {
    const { spawner: grepSpawner, calls: grepCalls } = fakeChildProcessSpawner("", 0);
    const grepResult = await runGrep(c.ctx, {}, grepSpawner);
    assert.equal(grepResult.ok, false);
    if (!grepResult.ok) assert.equal(grepResult.error.code, "invalid_argument");
    assert.equal(grepCalls.length, 0);

    const { spawner: findSpawner, calls: findCalls } = fakeChildProcessSpawner("", 0);
    const findResult = await runFind(c.ctx, { pattern: 42 }, findSpawner);
    assert.equal(findResult.ok, false);
    if (!findResult.ok) assert.equal(findResult.error.code, "invalid_argument");
    assert.equal(findCalls.length, 0);
  } finally {
    c.dispose();
  }
});

// ---------------------------------------------------------------------------
// criterion 3 — argv array, no shell, checked directly against runProcess
// ---------------------------------------------------------------------------

test("runGrep spawns rg with an argv array and shell:false, never a shell string", async () => {
  const c = context();
  try {
    const { spawner, calls } = fakeChildProcessSpawner("a.py:1:needle\n", 0);
    await runGrep(c.ctx, { pattern: "needle", path: ".", glob: "*.py", case_insensitive: true }, spawner);
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.ok(Array.isArray(call.argv));
    assert.equal(call.options.shell, false);
    assert.equal(call.options.cwd, c.checkout);
    // Every model-controlled value is its own argv element, never
    // concatenated into a single string that could be shell-interpreted.
    assert.ok(call.argv.includes("needle"));
    assert.ok(call.argv.includes("*.py"));
    assert.ok(call.argv.includes("--ignore-case"));
  } finally {
    c.dispose();
  }
});

test("runFind spawns fd with an argv array and shell:false", async () => {
  const c = context();
  try {
    const { spawner, calls } = fakeChildProcessSpawner("a.py\n", 0);
    await runFind(c.ctx, { pattern: "a" }, spawner);
    assert.equal(calls.length, 1);
    assert.ok(Array.isArray(calls[0]!.argv));
    assert.equal(calls[0]!.options.shell, false);
  } finally {
    c.dispose();
  }
});

test("a non-zero, non-one rg exit code is reported as a structured search_failed error", async () => {
  const c = context();
  try {
    const { spawner } = fakeChildProcessSpawner("", 2);
    const result = await runGrep(c.ctx, { pattern: "needle" }, spawner);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "search_failed");
  } finally {
    c.dispose();
  }
});

// ---------------------------------------------------------------------------
// ls — real filesystem, no subprocess
// ---------------------------------------------------------------------------

test("ls lists a confined directory's entries with their types", () => {
  const c = context();
  try {
    mkdirSync(join(c.checkout, "sub"));
    writeFileSync(join(c.checkout, "a.txt"), "hi");
    try {
      symlinkSync(join(c.checkout, "a.txt"), join(c.checkout, "link.txt"));
    } catch {
      /* symlinks may be unavailable in some sandboxes; the rest still holds */
    }

    const result = runLs(c.ctx, { path: "." });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const byName = Object.fromEntries(result.entries.map((e) => [e.name, e.type]));
    assert.equal(byName["sub"], "directory");
    assert.equal(byName["a.txt"], "file");
  } finally {
    c.dispose();
  }
});

test("ls caps entries at policy.caps.max_results and reports truncated:true over the cap", () => {
  const c = context();
  try {
    for (let i = 0; i < 210; i += 1) {
      writeFileSync(join(c.checkout, `f${i}.txt`), "x");
    }
    const result = runLs(c.ctx, { path: "." });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.entries.length, 200);
    assert.equal(result.count, 210);
    assert.equal(result.truncated, true);
  } finally {
    c.dispose();
  }
});
