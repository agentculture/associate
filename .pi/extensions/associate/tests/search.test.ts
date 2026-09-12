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

/**
 * What the fake child recorded about how it was consumed.
 *
 * `emittedChunks` is the load-bearing one: it is how the streaming tests prove
 * the tool stopped *consuming* at the cap instead of reading a huge output and
 * slicing it afterwards. A fake that had all its chunks read would show the
 * full count here.
 */
interface FakeState {
  emittedChunks: number;
  kills: string[];
  destroyed: boolean;
}

// runGrep/runFind call runProcess(bin, argv, cwd, limits, spawner), and
// runProcess expects the Spawner to return a ChildProcess-shaped object with
// .stdout, .stderr, .kill() and .on(). Build a minimal fake of that instead of
// stubbing runProcess itself, so the real runProcess code (argv array,
// shell:false, the streaming collector) is exercised end to end.
//
// The fake produces its stdout lazily, chunk by chunk, and stops the moment
// the consumer destroys the stream or kills the child — exactly what a real
// pipe does when the reader goes away. That is what makes "it stopped early"
// observable.
function chunkSpawner(
  chunks: () => Iterable<string>,
  code: number,
): { spawner: Spawner; calls: RecordedCall[]; state: FakeState } {
  const calls: RecordedCall[] = [];
  const state: FakeState = { emittedChunks: 0, kills: [], destroyed: false };
  const spawner = ((bin: string, argv: string[], options: { cwd: string; shell: false }) => {
    calls.push({ bin, argv: [...argv], options: { ...options } });
    const stopped = () => state.destroyed || state.kills.length > 0;
    const stdout = {
      on(event: string, cb: (chunk: Buffer) => void) {
        if (event === "data") {
          for (const chunk of chunks()) {
            if (stopped()) break;
            state.emittedChunks += 1;
            cb(Buffer.from(chunk, "utf8"));
          }
        }
        return stdout;
      },
      destroy() {
        state.destroyed = true;
      },
    };
    const stderr = {
      on() {
        return stderr;
      },
      destroy() {},
    };
    const fake = {
      stdout,
      stderr,
      kill(signal?: string) {
        state.kills.push(signal ?? "SIGTERM");
      },
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === "close") queueMicrotask(() => cb(code));
        return fake;
      },
    };
    return fake as unknown as ReturnType<Spawner>;
  }) as Spawner;
  return { spawner, calls, state };
}

/** The single-chunk shorthand most tests want. */
function fakeChildProcessSpawner(
  stdout: string,
  code: number,
): { spawner: Spawner; calls: RecordedCall[]; state: FakeState } {
  return chunkSpawner(() => (stdout.length > 0 ? [stdout] : []), code);
}

/** A spawner whose `spawn` throws synchronously, as a missing binary does. */
function throwingSpawner(err: Error): { spawner: Spawner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const spawner = ((bin: string, argv: string[], options: { cwd: string; shell: false }) => {
    calls.push({ bin, argv: [...argv], options: { ...options } });
    throw err;
  }) as Spawner;
  return { spawner, calls };
}

/**
 * A spawner that returns a child which then emits `error` — how Node actually
 * reports an ENOENT from `child_process.spawn` (asynchronously, on the child),
 * as distinct from a synchronous throw.
 */
function errorEventSpawner(err: Error): { spawner: Spawner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const spawner = ((bin: string, argv: string[], options: { cwd: string; shell: false }) => {
    calls.push({ bin, argv: [...argv], options: { ...options } });
    const stream = {
      on() {
        return stream;
      },
      destroy() {},
    };
    const fake = {
      stdout: stream,
      stderr: stream,
      kill() {},
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === "error") queueMicrotask(() => cb(err));
        return fake;
      },
    };
    return fake as unknown as ReturnType<Spawner>;
  }) as Spawner;
  return { spawner, calls };
}

function enoent(binary: string): NodeJS.ErrnoException {
  const err = new Error(`spawn ${binary} ENOENT`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

function lineBudget(ctx: ReturnType<typeof context>["ctx"]): number {
  const budgets = (ctx.policy as { budgets?: { shell?: { max_output_chars?: number } } }).budgets;
  return budgets?.shell?.max_output_chars ?? 0;
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
    // `count` is the returned count, not a total: the search stops at the cap,
    // so the 300 the fixture *would* have produced is deliberately never
    // counted (see the streaming test below).
    assert.equal(result.count, 200);
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
    assert.equal(result.count, 200);
    assert.equal(result.truncated, true);

    assert.equal(calls.length, 1);
    assert.ok(Array.isArray(calls[0]!.argv));
    assert.equal(calls[0]!.options.shell, false);
    // fd's --max-results is a whole-run cap (unlike rg's per-file
    // --max-count), so the bound is pushed into the binary too.
    const maxResultsAt = calls[0]!.argv.indexOf("--max-results");
    assert.ok(maxResultsAt >= 0, "fd must be given --max-results");
    assert.equal(calls[0]!.argv[maxResultsAt + 1], "201");
  } finally {
    c.dispose();
  }
});

// ---------------------------------------------------------------------------
// bounded memory — the cap stops consumption, it does not just slice the end
// ---------------------------------------------------------------------------

test("grep stops consuming at the cap and kills the child instead of buffering 100,000 lines", async () => {
  const c = context();
  try {
    const total = 100_000;
    const { spawner, state } = chunkSpawner(function* () {
      for (let i = 0; i < total; i += 1) yield `src/file${i}.py:1:needle ${i}\n`;
    }, 0);

    const result = await runGrep(c.ctx, { pattern: "needle" }, spawner);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.matches.length, 200);
    assert.equal(result.truncated, true);

    // The proof this is streaming and not "collect 100,000 lines, then slice":
    // exactly one chunk past the cap was ever read (the 201st line is what
    // makes `truncated` honest), and the child was signalled.
    assert.equal(state.emittedChunks, 201, "the tool must stop consuming one line past the cap");
    assert.ok(state.emittedChunks < total / 100, "nowhere near the full output may be consumed");
    assert.deepEqual(state.kills, ["SIGTERM"], "the child must be killed once the cap is reached");
    assert.equal(state.destroyed, true, "stdout must be destroyed, not drained");
  } finally {
    c.dispose();
  }
});

test("find stops consuming at the cap and kills the child", async () => {
  const c = context();
  try {
    const { spawner, state } = chunkSpawner(function* () {
      for (let i = 0; i < 100_000; i += 1) yield `${join(c.checkout, `file${i}.txt`)}\n`;
    }, 0);

    const result = await runFind(c.ctx, { pattern: "file" }, spawner);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.matches.length, 200);
    assert.equal(result.truncated, true);
    assert.equal(state.emittedChunks, 201);
    assert.deepEqual(state.kills, ["SIGTERM"]);
  } finally {
    c.dispose();
  }
});

test("a single 10 MB line is bounded by the policy's output budget, not stored whole", async () => {
  const c = context();
  try {
    const budget = lineBudget(c.ctx);
    assert.ok(budget > 0, "the policy fixture must declare budgets.shell.max_output_chars");

    const megabyte = "x".repeat(1_000_000);
    const { spawner } = chunkSpawner(function* () {
      for (let i = 0; i < 10; i += 1) yield megabyte; // one 10 MB line, no newline yet
      yield "\n";
    }, 0);

    const result = await runGrep(c.ctx, { pattern: "needle" }, spawner);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.matches.length, 1);
    assert.equal(
      result.matches[0]!.length,
      budget,
      "the over-long line must be clipped to the policy budget",
    );
    assert.equal(result.truncated, true, "clipping a line must be reported as truncation");
  } finally {
    c.dispose();
  }
});

// ---------------------------------------------------------------------------
// a missing or unstartable binary is a structured result, never a rejection
// ---------------------------------------------------------------------------

test("grep and find report tool_missing when spawn throws ENOENT, instead of rejecting", async () => {
  const c = context();
  try {
    const grep = await runGrep(
      c.ctx,
      { pattern: "needle" },
      throwingSpawner(enoent("rg")).spawner,
    );
    assert.equal(grep.ok, false);
    if (grep.ok) return;
    assert.equal(grep.error.code, "tool_missing");
    assert.match(grep.error.message, /rg/);
    assert.match(grep.error.message, /ripgrep/);

    const find = await runFind(c.ctx, { pattern: "a" }, throwingSpawner(enoent("fd")).spawner);
    assert.equal(find.ok, false);
    if (find.ok) return;
    assert.equal(find.error.code, "tool_missing");
    assert.match(find.error.message, /fd/);
  } finally {
    c.dispose();
  }
});

test("grep and find report tool_missing when the child emits an ENOENT 'error' event", async () => {
  const c = context();
  try {
    const grep = await runGrep(
      c.ctx,
      { pattern: "needle" },
      errorEventSpawner(enoent("rg")).spawner,
    );
    assert.equal(grep.ok, false);
    if (grep.ok) return;
    assert.equal(grep.error.code, "tool_missing");

    const find = await runFind(c.ctx, { pattern: "a" }, errorEventSpawner(enoent("fd")).spawner);
    assert.equal(find.ok, false);
    if (find.ok) return;
    assert.equal(find.error.code, "tool_missing");
  } finally {
    c.dispose();
  }
});

test("a non-ENOENT spawn failure is a structured search_failed, from a throw or an 'error' event", async () => {
  const c = context();
  try {
    const denied = Object.assign(new Error("spawn rg EACCES"), { code: "EACCES" });

    const thrown = await runGrep(c.ctx, { pattern: "needle" }, throwingSpawner(denied).spawner);
    assert.equal(thrown.ok, false);
    if (thrown.ok) return;
    assert.equal(thrown.error.code, "search_failed");
    assert.match(thrown.error.message, /EACCES/);

    const emitted = await runFind(c.ctx, { pattern: "a" }, errorEventSpawner(denied).spawner);
    assert.equal(emitted.ok, false);
    if (emitted.ok) return;
    assert.equal(emitted.error.code, "search_failed");
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
