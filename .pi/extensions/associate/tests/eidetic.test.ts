/**
 * The eidetic wrapper (task t8). A fake `eidetic` on PATH records its argv,
 * cwd and relevant env to a log file; no real memory store is touched.
 *
 *   1. recall output never exceeds the budget; remember always receives
 *      --scope associate and an explicit destination;
 *   2. a remember issued while the session root is another repo writes nothing
 *      under that repo;
 *   3. a remember after a web_page call is tagged untrusted.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContract } from "../lib/contract.ts";
import { createAssociateContext } from "../lib/runtime.ts";
import { createEideticTools, register, MAX_TOP_K } from "../tools/eidetic.ts";
import type { AssociateContext } from "../lib/context.ts";

interface Rig {
  ctx: AssociateContext;
  checkout: string;
  memory: string;
  log: string;
  env: Record<string, string>;
  dispose: () => void;
}

/** Fake eidetic: logs {argv, cwd, data_dir} as a JSON line, prints $FAKE_STDOUT_FILE. */
function rig(opts: { stdoutChars?: number; foreignGit?: boolean } = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), "associate-eidetic-"));
  const checkout = join(root, "checkout");
  const memory = join(root, "memory");
  const bin = join(root, "bin");
  mkdirSync(checkout);
  mkdirSync(bin);
  if (opts.foreignGit) mkdirSync(join(checkout, ".git"));
  const log = join(root, "calls.jsonl");
  const out = join(root, "stdout.txt");
  writeFileSync(out, "x".repeat(opts.stdoutChars ?? 10));
  const script = `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd(), data_dir: process.env.EIDETIC_DATA_DIR}) + "\\n");
process.stdout.write(fs.readFileSync(${JSON.stringify(out)}, "utf8"));
`;
  writeFileSync(join(bin, "eidetic"), script);
  chmodSync(join(bin, "eidetic"), 0o755);
  const env = { PATH: `${bin}:${process.env.PATH}`, ASSOCIATE_EIDETIC_DIR: memory, HOME: root };
  const ctx = createAssociateContext({
    checkoutRoot: checkout,
    contract: loadContract({}),
    env: { ASSOCIATE_EXPORT_ROOT: join(root, "runs"), ASSOCIATE_SESSION_ID: "t8-eidetic" },
  });
  return { ctx, checkout, memory, log, env, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

const calls = (r: Rig) =>
  existsSync(r.log)
    ? readFileSync(r.log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

function get(r: Rig, name: string) {
  const built = createEideticTools(r.ctx, { env: r.env });
  return { tool: built.tools.find((t) => t.name === name)!, taint: built.taint };
}

test("recall output never exceeds the policy budget", async () => {
  const r = rig({ stdoutChars: 200_000 });
  try {
    const budget = (r.ctx.policy.budgets as any).shell.max_output_chars as number;
    const { tool } = get(r, "eidetic_recall");
    const res = await tool.execute("c1", { query: "anything", top_k: 5 });
    assert.ok(res.content[0]!.text.length <= budget, `${res.content[0]!.text.length} > ${budget}`);
    assert.equal((res.details as any).truncated, true);
  } finally {
    r.dispose();
  }
});

test("recall pins scope, visibility, destination and bounds top-k and depth", async () => {
  const r = rig();
  try {
    const { tool } = get(r, "eidetic_recall");
    await tool.execute("c1", { query: "q", top_k: 10, depth: 1 });
    const [call] = calls(r);
    const a = call.argv as string[];
    assert.equal(a[0], "recall");
    assert.equal(a[a.indexOf("--scope") + 1], "associate");
    assert.equal(a[a.indexOf("--visibility") + 1], "private");
    assert.ok(Number(a[a.indexOf("--top-k") + 1]) <= MAX_TOP_K);
    assert.equal(call.data_dir, r.memory);
    // Out-of-range values are clamped to the caps, never passed through.
    await tool.execute("c2", { query: "q", top_k: 500, depth: 9 });
    const b = calls(r)[1].argv as string[];
    assert.equal(b[b.indexOf("--top-k") + 1], String(MAX_TOP_K));
    assert.equal(b[b.indexOf("--depth") + 1], "1");
  } finally {
    r.dispose();
  }
});

test("remember always passes --scope associate and an explicit destination", async () => {
  const r = rig();
  try {
    const { tool } = get(r, "eidetic_remember");
    const res = await tool.execute("c1", { text: "the gateway is on 8001" });
    assert.equal(JSON.parse(res.content[0]!.text).ok, true);
    const [call] = calls(r);
    const a = call.argv as string[];
    assert.equal(a[0], "remember");
    assert.equal(a[a.indexOf("--scope") + 1], "associate");
    assert.equal(a[a.indexOf("--visibility") + 1], "private");
    assert.equal(call.data_dir, r.memory);
    assert.equal(call.cwd, r.memory);
    const record = JSON.parse(a[1]!);
    assert.equal(record.text, "the gateway is on 8001");
    assert.equal(record.metadata.provenance, undefined);
  } finally {
    r.dispose();
  }
});

test("without ASSOCIATE_EIDETIC_DIR the destination is $HOME/.eidetic/memory, still explicit", async () => {
  const r = rig();
  try {
    delete (r.env as any).ASSOCIATE_EIDETIC_DIR;
    const { tool } = get(r, "eidetic_remember");
    await tool.execute("c1", { text: "x" });
    assert.equal(calls(r)[0].data_dir, join(r.env.HOME!, ".eidetic", "memory"));
  } finally {
    r.dispose();
  }
});

test("remember with the session root in another repo writes nothing under that repo", async () => {
  const r = rig({ foreignGit: true });
  try {
    const before = readdirSync(r.checkout, { recursive: true }).sort();
    const { tool } = get(r, "eidetic_remember");
    await tool.execute("c1", { text: "found a thing" });
    const [call] = calls(r);
    assert.ok(!String(call.cwd).startsWith(r.checkout), "child cwd must not be the checkout");
    assert.ok(!String(call.data_dir).startsWith(r.checkout), "destination must not be in the checkout");
    assert.deepEqual(readdirSync(r.checkout, { recursive: true }).sort(), before);
  } finally {
    r.dispose();
  }
});

test("a destination inside the checkout is refused and nothing is spawned", async () => {
  const r = rig();
  try {
    r.env.ASSOCIATE_EIDETIC_DIR = join(r.checkout, ".eidetic", "memory");
    const { tool } = get(r, "eidetic_remember");
    const res = await tool.execute("c1", { text: "x" });
    const body = JSON.parse(res.content[0]!.text);
    assert.equal(body.ok, false);
    assert.equal(body.code, "bad_destination");
    assert.equal(calls(r).length, 0);
    assert.ok(!existsSync(join(r.checkout, ".eidetic")));
  } finally {
    r.dispose();
  }
});

test("a remember after web_page is tagged untrusted:web; the model cannot set a source", async () => {
  const r = rig();
  try {
    const { tool, taint } = get(r, "eidetic_remember");
    await tool.execute("c1", { text: "before the web", source: "trusted", provenance: "trusted" });
    taint.observe("web_page");
    await tool.execute("c2", { text: "after the web" });
    const [first, second] = calls(r).map((c) => JSON.parse(c.argv[1]));
    assert.equal(first.metadata.provenance, undefined);
    assert.equal(second.metadata.provenance, "untrusted:web");
  } finally {
    r.dispose();
  }
});

test("reads in a foreign checkout taint; reads in associate's own repo do not", async () => {
  const foreign = rig();
  try {
    const { taint } = get(foreign, "eidetic_remember");
    taint.observe("read");
    assert.equal(taint.provenance(), "untrusted:repo");
    taint.observe("web_search");
    assert.equal(taint.provenance(), "untrusted:repo+web");
  } finally {
    foreign.dispose();
  }
  const own = rig();
  try {
    const ownCtx = createAssociateContext({
      checkoutRoot: join(own.ctx.contract.dir, "..", ".."),
      contract: own.ctx.contract,
      env: { ASSOCIATE_EXPORT_ROOT: join(own.checkout, "..", "runs2"), ASSOCIATE_SESSION_ID: "own" },
    });
    const { taint } = createEideticTools(ownCtx, { env: own.env });
    taint.observe("read");
    assert.equal(taint.provenance(), null);
    taint.observe("web_page");
    assert.equal(taint.provenance(), "untrusted:web");
  } finally {
    own.dispose();
  }
});

test("r2/10: a spawn_subagent hand-back taints later records untrusted:child, in any checkout", async () => {
  const r = rig();
  try {
    const { tool, taint } = get(r, "eidetic_remember");
    taint.observe("spawn_subagent");
    assert.equal(taint.provenance(), "untrusted:child");
    taint.observe("web_page");
    assert.equal(taint.provenance(), "untrusted:child+web");
    await tool.execute("c1", { text: "relayed by a child" });
    assert.equal(JSON.parse(calls(r)[0].argv[1]).metadata.provenance, "untrusted:child+web");
  } finally {
    r.dispose();
  }
  // In associate's own repo too: the child's text may come from the web or anywhere.
  const own = rig();
  try {
    const ownCtx = createAssociateContext({
      checkoutRoot: join(own.ctx.contract.dir, "..", ".."),
      contract: own.ctx.contract,
      env: { ASSOCIATE_EXPORT_ROOT: join(own.checkout, "..", "runs3"), ASSOCIATE_SESSION_ID: "own-child" },
    });
    const { taint } = createEideticTools(ownCtx, { env: own.env });
    taint.observe("spawn_subagent");
    assert.equal(taint.provenance(), "untrusted:child");
  } finally {
    own.dispose();
  }
});

test("d18: a delegate_status result taints later records untrusted:child; starting a run does not", async () => {
  const r = rig();
  try {
    const { taint } = get(r, "eidetic_remember");
    taint.observe("delegate_run");
    assert.equal(taint.provenance(), null, "delegate_run returns only a run id");
    taint.observe("delegate_status");
    assert.equal(taint.provenance(), "untrusted:child");
  } finally {
    r.dispose();
  }
});

test("register wires a tool_call listener so web use taints later records", async () => {
  const r = rig();
  try {
    const tools: any[] = [];
    const handlers: Record<string, Function> = {};
    const pi = { registerTool: (t: any) => tools.push(t), on: (e: string, h: Function) => (handlers[e] = h) };
    const savedPath = process.env.PATH;
    const savedDir = process.env.ASSOCIATE_EIDETIC_DIR;
    process.env.PATH = r.env.PATH;
    process.env.ASSOCIATE_EIDETIC_DIR = r.memory;
    try {
      register(pi, r.ctx);
      assert.deepEqual(tools.map((t) => t.name).sort(), ["eidetic_recall", "eidetic_remember"]);
      assert.ok(r.ctx.declaredNonWriters().includes("eidetic_recall"));
      assert.ok(!r.ctx.contain.isWriter("eidetic_recall"));
      handlers.tool_call!({ toolName: "web_page", input: { url: "https://example.invalid/" } });
      await tools.find((t) => t.name === "eidetic_remember").execute("c1", { text: "x" });
      assert.equal(JSON.parse(calls(r)[0].argv[1]).metadata.provenance, "untrusted:web");
    } finally {
      process.env.PATH = savedPath;
      if (savedDir === undefined) delete process.env.ASSOCIATE_EIDETIC_DIR;
      else process.env.ASSOCIATE_EIDETIC_DIR = savedDir;
    }
  } finally {
    r.dispose();
  }
});

test("a missing eidetic is a structured install hint", async () => {
  const r = rig();
  try {
    const built = createEideticTools(r.ctx, { env: r.env, which: () => null });
    const res = await built.tools[1]!.execute("c1", { text: "x" });
    assert.equal(JSON.parse(res.content[0]!.text).code, "tool_missing");
  } finally {
    r.dispose();
  }
});
