/**
 * Every owned tool takes a `purpose`, reports the arguments it used, and
 * search keeps its true total (issue #20, plan t8; spec h8).
 *
 * Covers the plan's acceptance criteria 1 to 3 for read, grep/find/ls, bash,
 * web_search/web_page, code_lens, run_tests, spawn_subagent and
 * delegate_run/delegate_status. (eidetic and ledger tools belong to later
 * tasks and are not checked here.)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepoContractDir, loadContract } from "../lib/contract.ts";
import { createAssociateContext } from "../lib/runtime.ts";
import { ARGS_USED_KEY, DROPPED_ARGS_KEY, NOT_SHOWN_CHARS_KEY, WalkRecorder } from "../lib/walk.ts";
import { register as registerRead } from "../tools/read.ts";
import { register as registerSearch } from "../tools/search.ts";
import { register as registerShell } from "../tools/shell.ts";
import { createWebTools } from "../tools/web.ts";
import { createCodeLensTool } from "../tools/codelens.ts";
import { createTestsTool } from "../tools/tests.ts";
import { createSpawnTool } from "../tools/spawn.ts";
import { createDelegateTools } from "../tools/delegate.ts";
import type { ProcResult, Spawn } from "../tools/_procs.ts";

const CONTRACT = loadContract({});
const CONTRACT_DIR = findRepoContractDir()!;
const PURPOSE = "check that a call with a purpose runs; expect the normal result";

interface Tool {
  name: string;
  parameters: any;
  execute: (id: string, params: any, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text?: string }>; details: any }>;
}

class FakePi {
  tools: Tool[] = [];
  registerTool(definition: Tool): void {
    this.tools.push(definition);
  }
  tool(name: string): Tool {
    const found = this.tools.find((t) => t.name === name);
    if (!found) throw new Error(`no tool named ${name}`);
    return found;
  }
}

interface Rig {
  root: string;
  checkout: string;
  ctx: ReturnType<typeof createAssociateContext>;
  env: Record<string, string | undefined>;
  dispose(): void;
}

function rig(model = "worker", extraEnv: Record<string, string | undefined> = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), "associate-t8-"));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ASSOCIATE_EXPORT_ROOT: join(root, "runs"),
    ASSOCIATE_SESSION_ID: "t8",
    ASSOCIATE_CHECKOUT_ROOT: checkout,
    ASSOCIATE_CONTRACT_DIR: CONTRACT_DIR,
    ASSOCIATE_MODEL: model,
    ASSOCIATE_BASE_URL: "http://lane.invalid:9/v1",
    ASSOCIATE_API_KEY: "dummy-t8-key",
    ...extraEnv,
  };
  const ctx = createAssociateContext({ env, checkoutRoot: checkout });
  return { root, checkout, ctx, env, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("");
}

/** Walk-side view of one call: what the recorder writes for it. */
function walkEntry(r: Rig, toolName: string, asked: Record<string, unknown>, result: { content: any; details: any }) {
  const walk = new WalkRecorder({ exportDir: r.ctx.session.exportDir, policy: r.ctx.policy, installExitHook: false });
  walk.noteToolCall({ toolName, toolCallId: "tc-1", input: asked });
  const entry = walk.recordToolResult({ toolName, toolCallId: "tc-1", input: asked, content: result.content, details: result.details });
  walk.finalize();
  return entry as any;
}

// -------------------------------------------------- criterion 1: purpose in every schema

function checkPurposeSchema(name: string, schema: any): void {
  assert.equal(schema.properties?.purpose?.type, "string", `${name}: purpose is a string property`);
  assert.ok(String(schema.properties.purpose.description ?? "").length > 0, `${name}: purpose is described`);
  assert.ok(!(schema.required ?? []).includes("purpose"), `${name}: purpose is optional in the schema (the hook enforces it)`);
}

test("t8 criterion 1: every owned tool's schema accepts an optional purpose", async () => {
  const r = rig("cortex");
  try {
    const pi = new FakePi();
    await registerRead(pi as any, r.ctx);
    registerSearch(pi as any, r.ctx);
    registerShell(pi as any, r.ctx);
    for (const name of ["read", "grep", "find", "ls", "bash"]) checkPurposeSchema(name, pi.tool(name).parameters);
    for (const tool of createWebTools(r.ctx)) checkPurposeSchema(tool.name, tool.parameters);
    checkPurposeSchema("code_lens", createCodeLensTool(r.ctx).parameters);
    checkPurposeSchema("run_tests", createTestsTool(r.ctx, { env: {}, log: () => {} }).parameters);
    checkPurposeSchema("spawn_subagent", createSpawnTool(r.ctx).parameters);
    const delegate = createDelegateTools(r.ctx);
    checkPurposeSchema("delegate_run", delegate.run.parameters);
    checkPurposeSchema("delegate_status", delegate.status.parameters);
  } finally {
    r.dispose();
  }
});

test("t8 criterion 1: run_tests runs a call that carries a purpose, and runs the same command", async () => {
  const r = rig();
  try {
    const marker = join(r.root, "ran.txt");
    const tool = createTestsTool(r.ctx, {
      env: { PATH: process.env.PATH, ASSOCIATE_TEST_COMMANDS: JSON.stringify([[process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, process.argv.length + ':' + process.argv.slice(1).join(','))`]]) },
      log: () => {},
    });
    const out = await tool.execute("tc", { command: 0, purpose: PURPOSE });
    const details = out.details as any;
    assert.notEqual(details.code, "invalid_args", JSON.stringify(details));
    assert.equal(details.ok, true, JSON.stringify(details));
    assert.equal(readFileSync(marker, "utf8"), "1:", "the purpose is never passed to the test command");
    assert.deepEqual(details[ARGS_USED_KEY], { command: 0 });
    assert.deepEqual(details[DROPPED_ARGS_KEY] ?? [], []);
    // An unknown argument other than purpose is still refused, not run.
    const bad = (await tool.execute("tc", { argv: ["x"], purpose: PURPOSE })).details as any;
    assert.equal(bad.code, "invalid_args");
    assert.equal(bad.detail.field, "argv");
  } finally {
    r.dispose();
  }
});

test("t8 criterion 1: delegate_status and delegate_run run a call that carries a purpose", async () => {
  const r = rig("senses", { ASSOCIATE_TEST_COMMANDS: JSON.stringify([["true"]]) });
  try {
    mkdirSync(join(r.checkout, ".git"));
    const tree = join(r.root, "tree");
    mkdirSync(join(tree, "associate"), { recursive: true });
    writeFileSync(join(tree, "associate", "__main__.py"), "# fake\n");
    mkdirSync(join(tree, ".venv", "bin"), { recursive: true });
    writeFileSync(join(tree, ".venv", "bin", "python"), "#!/bin/sh\n");
    const launches: any[] = [];
    const walk = new WalkRecorder({ exportDir: r.ctx.session.exportDir, policy: r.ctx.policy, installExitHook: false });
    const tools = createDelegateTools(r.ctx, {
      recordChild: (link: any) => walk.recordChild(link),
      env: r.env,
      associateRoot: tree,
      which: () => null,
      isAlive: () => false,
      // main added a one-run-per-checkout lock; nothing holds this fake checkout.
      probeLock: () => ({ held: false, holder: null }),
      launch: (spec: any) => {
        launches.push(spec);
        writeFileSync(spec.stdoutPath, "");
        writeFileSync(spec.stderrPath, "");
        return { pid: 1, exited: new Promise(() => {}) };
      },
    } as any);

    const status = (await tools.status.execute("tc", { run_id: "dlg-20260101T000000Z-abcdef12", purpose: PURPOSE })).details as any;
    assert.equal(status.code, "unknown_run", "the call got past argument checking");

    const started = (await tools.run.execute("tc", { model: "worker", task: "do a thing", purpose: PURPOSE })).details as any;
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(launches.length, 1);
    assert.ok(!JSON.stringify(launches[0]).includes(PURPOSE), "the purpose is not passed to the delegated run");
  } finally {
    r.dispose();
  }
});

test("t8 criterion 1: spawn_subagent runs a call that carries a purpose and never hands it to the child", async () => {
  const r = rig("cortex", { ASSOCIATE_PI_TRUST: "approve" });
  try {
    const specs: any[] = [];
    const walk = new WalkRecorder({ exportDir: r.ctx.session.exportDir, policy: r.ctx.policy, installExitHook: false });
    const tool = createSpawnTool(r.ctx, {
      env: r.env,
      which: () => "/opt/fake/bin/pi",
      launch: async (spec: any, onLine: (l: string) => void) => {
        specs.push(spec);
        onLine(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" } }));
        return { exitCode: 0, timedOut: false, aborted: false, stderrTail: "" };
      },
      recordChild: (link: any) => walk.recordChild(link),
    } as any);
    const out = (await tool.execute("tc", { model: "senses", task: "look at it", purpose: PURPOSE })).details as any;
    assert.notEqual(out.code, "invalid_args", JSON.stringify(out));
    assert.equal(specs.length, 1, JSON.stringify(out));
    assert.ok(!JSON.stringify(specs[0]).includes(PURPOSE), "the purpose is not passed to the child");
    const bad = (await tool.execute("tc", { model: "senses", task: "x", argv: ["--tools", "write"], purpose: PURPOSE })).details as any;
    assert.equal(bad.code, "invalid_args");
  } finally {
    r.dispose();
  }
});

// -------------------------------------------------- criterion 2: arguments as used

test("t8 criterion 2: read with limit and offset (run scope20-cortex-t2): the walk entry shows asked and used differ", async () => {
  const r = rig();
  try {
    writeFileSync(join(r.checkout, "a.txt"), "one\ntwo\nthree\nfour\nfive\n");
    const pi = new FakePi();
    await registerRead(pi as any, r.ctx);
    const asked = { path: "a.txt", limit: "120", offset: "460", purpose: PURPOSE };
    const result = await pi.tool("read").execute("tc", asked);
    assert.deepEqual(result.details[ARGS_USED_KEY], { path: "a.txt", start_line: 1, end_line: 5 });
    assert.deepEqual(result.details[DROPPED_ARGS_KEY], ["limit", "offset"]);
    assert.match(text(result), /^1\tone/);

    const entry = walkEntry(r, "read", asked, result);
    assert.deepEqual(entry.args, asked, "args as asked stay complete");
    assert.deepEqual(entry.args_used, { path: "a.txt", start_line: 1, end_line: 5 });
    assert.deepEqual(entry.dropped_args, ["limit", "offset"]);
    assert.notDeepEqual(entry.args, entry.args_used);
    assert.equal(entry.not_shown_chars, 0);
  } finally {
    r.dispose();
  }
});

test("t8 criterion 2: read reports a window it was asked for, the cursor path, and what a cut hid", async () => {
  const r = rig();
  try {
    writeFileSync(join(r.checkout, "b.txt"), `${"x".repeat(50)}\n`.repeat(3000));
    const pi = new FakePi();
    await registerRead(pi as any, r.ctx);
    const read = pi.tool("read");
    const win = await read.execute("tc", { path: "b.txt", start_line: 10, end_line: 12, purpose: PURPOSE });
    assert.deepEqual(win.details[ARGS_USED_KEY], { path: "b.txt", start_line: 10, end_line: 12 });
    assert.equal(win.details[DROPPED_ARGS_KEY], undefined, "nothing was ignored");

    const big = await read.execute("tc", { path: "b.txt", purpose: PURPOSE });
    assert.equal(big.details.truncated, true);
    assert.ok(big.details[NOT_SHOWN_CHARS_KEY] > 0, "the cut says how much was not shown");
    assert.equal(walkEntry(r, "read", { path: "b.txt" }, big).not_shown_chars, big.details[NOT_SHOWN_CHARS_KEY]);

    // A continuation ignores path and the window; it says so.
    const next = await read.execute("tc", { cursor: big.details.cursor, path: "b.txt", start_line: 3, purpose: PURPOSE });
    assert.deepEqual(next.details[ARGS_USED_KEY], { cursor: big.details.cursor });
    assert.deepEqual(next.details[DROPPED_ARGS_KEY], ["path", "start_line"]);
  } finally {
    r.dispose();
  }
});

test("t8 criterion 2: bash reports argv and cwd as used, drops unknown arguments, and counts what a cut hid", async () => {
  const r = rig();
  try {
    mkdirSync(join(r.checkout, "sub"));
    const out = "y".repeat(40000);
    const pi = new FakePi();
    registerShell(pi as any, r.ctx, {
      spawn: () => {
        const child = {
          stdout: { on: (_e: string, cb: any) => void setImmediate(() => cb(Buffer.from(out))) },
          stderr: { on: () => {} },
          on: (event: string, cb: any) => {
            if (event === "close") setTimeout(() => cb(0, null), 10);
          },
          kill: () => {},
        };
        return child as any;
      },
    });
    const result = await pi.tool("bash").execute("tc", { argv: ["ls"], cwd: "sub", timeout: 5, purpose: PURPOSE });
    assert.deepEqual(result.details[ARGS_USED_KEY], { argv: ["ls"], cwd: "sub" });
    assert.deepEqual(result.details[DROPPED_ARGS_KEY], ["timeout"]);
    assert.equal(result.details.truncated, true);
    assert.ok(result.details[NOT_SHOWN_CHARS_KEY] > 0);
    assert.ok(result.details[NOT_SHOWN_CHARS_KEY] <= out.length);
  } finally {
    r.dispose();
  }
});

function procSpawn(result: Partial<ProcResult>, calls: string[][] = []): Spawn {
  return async (file, args) => {
    calls.push([file, ...args]);
    return { code: 0, stdout: "", stderr: "", ...result };
  };
}

test("t8 criterion 2: web_search and web_page report the arguments they used and the ones they dropped", async () => {
  const r = rig();
  try {
    const calls: string[][] = [];
    const body = JSON.stringify({ content: { untrusted: [{ title: "t", url: "https://example.org/a" }] } });
    const tools = createWebTools(r.ctx, { which: () => "/bin/webglass", spawn: procSpawn({ stdout: body }, calls) });
    const search = tools.find((t) => t.name === "web_search")!;
    const s = (await search.execute("tc", { query: "widgets", session_id: "s1", purpose: PURPOSE })).details as any;
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.deepEqual(s[ARGS_USED_KEY], { query: "widgets" });
    assert.deepEqual(s[DROPPED_ARGS_KEY], ["session_id"]);
    assert.ok(!calls.flat().includes(PURPOSE), "the purpose is not in the web request");

    const page = tools.find((t) => t.name === "web_page")!;
    const p = (await page.execute("tc", { url: "https://example.org/a", purpose: PURPOSE })).details as any;
    assert.equal(p.ok, true, JSON.stringify(p));
    assert.deepEqual(p[ARGS_USED_KEY], { url: "https://example.org/a" });
    assert.equal(p[DROPPED_ARGS_KEY], undefined);
    assert.ok(!calls.flat().includes(PURPOSE));

    // A cut page body reports how much was not shown.
    const huge = JSON.stringify({ content: { untrusted: "z".repeat(60000) } });
    const cut = createWebTools(r.ctx, { which: () => "/bin/webglass", spawn: procSpawn({ stdout: huge }) }).find((t) => t.name === "web_page")!;
    const c = (await cut.execute("tc", { url: "https://example.org/big" })).details as any;
    assert.equal(c.truncated, true);
    assert.ok(c[NOT_SHOWN_CHARS_KEY] > 0 && c[NOT_SHOWN_CHARS_KEY] <= 60002);
  } finally {
    r.dispose();
  }
});

test("t8 criterion 2: code_lens reports the arguments it used and the ones its command ignores", async () => {
  const r = rig();
  try {
    const calls: string[][] = [];
    const tool = createCodeLensTool(r.ctx, {
      which: () => "/bin/code-lens",
      spawn: procSpawn({ stdout: JSON.stringify({ ok: true, data: { files: 3 } }) }, calls),
    });
    const out = (await tool.execute("tc", { command: "profile", count: 5, pattern: "x", colour: "red", purpose: PURPOSE })).details as any;
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(out[ARGS_USED_KEY], { command: "profile", path: ".", online: false });
    assert.deepEqual(out[DROPPED_ARGS_KEY], ["count", "pattern", "colour"]);
    assert.ok(!calls.flat().includes(PURPOSE));

    const recent = (await tool.execute("tc", { command: "recent", count: 5, depth: "deep" })).details as any;
    assert.deepEqual(recent[ARGS_USED_KEY], { command: "recent", path: ".", count: 5 });
    assert.deepEqual(recent[DROPPED_ARGS_KEY], ["depth"]);

    const big = createCodeLensTool(r.ctx, {
      which: () => "/bin/code-lens",
      spawn: procSpawn({ stdout: "w".repeat(40000) }),
    });
    const cut = (await big.execute("tc", { command: "classify" })).details as any;
    assert.equal(cut.truncated, true);
    assert.ok(cut[NOT_SHOWN_CHARS_KEY] > 0 && cut[NOT_SHOWN_CHARS_KEY] <= 40000);
  } finally {
    r.dispose();
  }
});

// -------------------------------------------------- criterion 3: search keeps its true total

function lineSpawner(lines: string[], code = 0, chunkLines = 50) {
  const calls: Array<{ bin: string; argv: string[] }> = [];
  const spawner = ((bin: string, argv: string[]) => {
    calls.push({ bin, argv: [...argv] });
    const stdout = {
      on(event: string, cb: (chunk: Buffer) => void) {
        if (event === "data") {
          for (let i = 0; i < lines.length; i += chunkLines) cb(Buffer.from(lines.slice(i, i + chunkLines).join("\n") + "\n"));
        }
        return stdout;
      },
      destroy() {},
    };
    const stderr = { on: () => stderr, destroy() {} };
    const child: any = {
      stdout,
      stderr,
      kill() {},
      on(event: string, cb: (...a: unknown[]) => void) {
        if (event === "close") queueMicrotask(() => cb(code));
        return child;
      },
    };
    return child;
  }) as any;
  return { spawner, calls };
}

test("t8 criterion 3: grep and find return the true total beside the capped list and save the full result", async () => {
  const r = rig();
  try {
    const { runGrep, runFind } = await import("../tools/search.ts");
    const lines = Array.from({ length: 450 }, (_, i) => `f${i}.txt:1:match`);

    const { spawner, calls } = lineSpawner(lines);
    const grep = (await runGrep(r.ctx, { pattern: "match", purpose: PURPOSE }, spawner)) as any;
    assert.equal(grep.ok, true);
    assert.equal(grep.matches.length, 200);
    assert.equal(grep.count, 200);
    assert.equal(grep.total, 450, "the true total, not the cap");
    assert.equal(grep.total_exact, true);
    assert.equal(grep.truncated, true);
    assert.ok(!calls[0]!.argv.includes(PURPOSE), "the purpose is not passed to rg");
    assert.ok(grep.not_shown_chars > 0);
    assert.ok(existsSync(grep.spill_path), "the full result is saved");
    assert.equal(readFileSync(grep.spill_path, "utf8"), lines.join("\n") + "\n", "the saved result holds every match");
    assert.equal(grep[DROPPED_ARGS_KEY], undefined);
    assert.equal(grep[ARGS_USED_KEY].pattern, "match");

    const fd = lineSpawner(Array.from({ length: 333 }, (_, i) => `d/f${i}`));
    const find = (await runFind(r.ctx, { pattern: "f", colour: "red" }, fd.spawner)) as any;
    assert.equal(find.total, 333);
    assert.equal(find.count, 200);
    assert.ok(!fd.calls[0]!.argv.includes("--max-results"), "find no longer stops the binary at the cap");
    assert.deepEqual(find[DROPPED_ARGS_KEY], ["colour"]);
    assert.ok(existsSync(find.spill_path));

    // Under the cap: nothing hidden, nothing to save.
    const small = lineSpawner(["a:1:x", "b:2:x"]);
    const few = (await runGrep(r.ctx, { pattern: "x" }, small.spawner)) as any;
    assert.equal(few.total, 2);
    assert.equal(few.truncated, false);
    assert.equal(few.not_shown_chars, 0);
    assert.equal(few.spill_path, undefined);
  } finally {
    r.dispose();
  }
});

test("t8 criterion 3: the count stops at the scan ceiling and says the total is a lower bound", async () => {
  const r = rig();
  try {
    const { runGrep } = await import("../tools/search.ts");
    const ceiling = (r.ctx.policy as any).caps.max_raw_chars as number;
    const line = "p".repeat(1000);
    const many = Array.from({ length: Math.ceil(ceiling / 1000) + 500 }, () => line);
    const out = (await runGrep(r.ctx, { pattern: "p" }, lineSpawner(many, 0, 100).spawner)) as any;
    assert.equal(out.truncated, true);
    assert.equal(out.total_exact, false);
    assert.ok(out.total >= 200 && out.total < many.length, `lower bound ${out.total}`);
  } finally {
    r.dispose();
  }
});

test("t8 criterion 3: ls returns the true total, saves the full listing, and reports dropped arguments", async () => {
  const r = rig();
  try {
    for (let i = 0; i < 260; i += 1) writeFileSync(join(r.checkout, `f${String(i).padStart(3, "0")}.txt`), "");
    const pi = new FakePi();
    registerSearch(pi as any, r.ctx);
    const out = (await pi.tool("ls").execute("tc", { path: ".", all: true, purpose: PURPOSE })).details as any;
    assert.equal(out.count, 200);
    assert.equal(out.total, 260);
    assert.equal(out.truncated, true);
    assert.deepEqual(out[DROPPED_ARGS_KEY], ["all"]);
    assert.deepEqual(out[ARGS_USED_KEY], { path: "." });
    assert.ok(out.not_shown_chars > 0);
    assert.ok(existsSync(out.spill_path));
    assert.equal(readFileSync(out.spill_path, "utf8").split("\n").filter(Boolean).length, 260);
  } finally {
    r.dispose();
  }
});

test("t8 criterion 3: the walk saves the search result like any other tool's", async () => {
  const r = rig();
  try {
    writeFileSync(join(r.checkout, "one.txt"), "");
    const pi = new FakePi();
    registerSearch(pi as any, r.ctx);
    const asked = { path: ".", purpose: PURPOSE };
    const result = await pi.tool("ls").execute("tc", asked);
    const entry = walkEntry(r, "ls", asked, result);
    assert.equal(entry.saved_result, "results/w1.txt");
    assert.equal(entry.not_shown_chars, 0);
    assert.deepEqual(entry.args_used, { path: "." });
  } finally {
    r.dispose();
  }
});
