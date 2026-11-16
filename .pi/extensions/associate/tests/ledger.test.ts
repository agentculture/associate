/**
 * The workledger wrapper (task t13). A fake `ledger` on PATH records argv,
 * cwd and WORKLEDGER_PATH; one optional test drives the real released CLI.
 *
 *   1. append and list pass their argv and parse --json;
 *   2. the only verbs ever spawned are `append` and `list`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContract } from "../lib/contract.ts";
import { createAssociateContext } from "../lib/runtime.ts";
import { createLedgerTools, ledgerPath, register, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT, ALLOWED_VERBS } from "../tools/ledger.ts";
import { whichOnPath } from "../tools/_procs.ts";
import type { AssociateContext } from "../lib/context.ts";

interface Rig {
  ctx: AssociateContext;
  root: string;
  checkout: string;
  ledgerFile: string;
  log: string;
  env: Record<string, string>;
  setFake: (stdout: string, code?: number, stderr?: string) => void;
  dispose: () => void;
}

function rig(extraEnv: Record<string, string> = {}, withBinary = true): Rig {
  const root = mkdtempSync(join(tmpdir(), "associate-ledger-"));
  const checkout = join(root, "checkout");
  const bin = join(root, "bin");
  mkdirSync(checkout);
  mkdirSync(bin);
  const log = join(root, "calls.jsonl");
  const cfg = join(root, "fake.json");
  writeFileSync(cfg, JSON.stringify({ stdout: "[]", code: 0, stderr: "" }));
  const script = `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd(), path: process.env.WORKLEDGER_PATH}) + "\\n");
const c = JSON.parse(fs.readFileSync(${JSON.stringify(cfg)}, "utf8"));
process.stdout.write(c.stdout); process.stderr.write(c.stderr); process.exit(c.code);
`;
  if (withBinary) {
    writeFileSync(join(bin, "ledger"), script);
    chmodSync(join(bin, "ledger"), 0o755);
  }
  const ledgerFile = join(root, "home", "associate.jsonl");
  const env = {
    PATH: withBinary ? `${bin}:${process.env.PATH}` : "/nonexistent-bin",
    ASSOCIATE_LEDGER_PATH: ledgerFile,
    HOME: join(root, "home"),
    ...extraEnv,
  };
  const ctx = createAssociateContext({
    checkoutRoot: checkout,
    contract: loadContract({}),
    env: { ASSOCIATE_EXPORT_ROOT: join(root, "runs"), ASSOCIATE_SESSION_ID: "t13-ledger" },
  });
  return {
    ctx, root, checkout, ledgerFile, log, env,
    setFake: (stdout, code = 0, stderr = "") => writeFileSync(cfg, JSON.stringify({ stdout, code, stderr })),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

const calls = (r: Rig) =>
  existsSync(r.log)
    ? readFileSync(r.log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

function get(r: Rig, name: string, model = "worker") {
  const built = createLedgerTools(r.ctx, { env: { ...r.env, ASSOCIATE_MODEL: model } });
  return built.tools.find((t) => t.name === name)!;
}
const payload = (res: { details: unknown }) => res.details as any;

test("append passes the entry as one argv element and parses --json", async () => {
  const r = rig();
  try {
    r.setFake(JSON.stringify({ id: "e1", timestamp: "2026-01-01T00:00:00Z", agent: "associate/worker" }));
    const res = await get(r, "ledger_append").execute("c1", {
      action: "edited",
      summary: "fixed typo; rm -rf /",
      refs: ["a.md"],
      data: { n: 1 },
    });
    const [call] = calls(r);
    assert.equal(call.argv[0], "append");
    assert.ok(call.argv.includes("--json"));
    const entry = JSON.parse(call.argv[1]);
    assert.deepEqual(entry, {
      agent: "associate/worker", action: "edited", summary: "fixed typo; rm -rf /", refs: ["a.md"], data: { n: 1 },
    });
    assert.equal(payload(res).ok, true);
    assert.equal(payload(res).entry.id, "e1");
  } finally {
    r.dispose();
  }
});

test("the agent field is filled from the active model, never from arguments", async () => {
  const r = rig();
  try {
    r.setFake("{}");
    await get(r, "ledger_append", "cortex").execute("c1", { action: "a", summary: "s", agent: "someone-else" });
    const entry = JSON.parse(calls(r)[0].argv[1]);
    assert.equal(entry.agent, "associate/cortex");
    // extra model-supplied keys are not forwarded either
    assert.deepEqual(Object.keys(entry).sort(), ["action", "agent", "summary"]);
  } finally {
    r.dispose();
  }
});

test("append rejects a bad summary before spawning anything", async () => {
  const r = rig();
  try {
    for (const summary of ["", "two\nlines", "bell\u0007"]) {
      const res = await get(r, "ledger_append").execute("c", { action: "a", summary });
      assert.equal(payload(res).ok, false, JSON.stringify(summary));
    }
    assert.equal(calls(r).length, 0);
  } finally {
    r.dispose();
  }
});

test("list passes filters, clamps the limit and parses the array", async () => {
  const r = rig();
  try {
    r.setFake(JSON.stringify([{ id: "e1" }, { id: "e2" }]));
    const res = await get(r, "ledger_list").execute("c1", {
      agent: "associate/worker", action: "edited", since: "2026-01-01T00:00:00Z", limit: 3,
    });
    assert.deepEqual(calls(r)[0].argv, [
      "list", "--agent", "associate/worker", "--action", "edited",
      "--since", "2026-01-01T00:00:00Z", "--limit", "3", "--json",
    ]);
    assert.equal(payload(res).ok, true);
    assert.equal(payload(res).entries.length, 2);

    await get(r, "ledger_list").execute("c2", {});
    const argv2 = calls(r)[1].argv;
    assert.equal(argv2[argv2.indexOf("--limit") + 1], String(DEFAULT_LIST_LIMIT));

    await get(r, "ledger_list").execute("c3", { limit: MAX_LIST_LIMIT + 1 });
    const argv3 = calls(r)[2].argv;
    assert.equal(argv3[argv3.indexOf("--limit") + 1], String(MAX_LIST_LIMIT));
  } finally {
    r.dispose();
  }
});

test("list output is cut at the policy budget", async () => {
  const r = rig();
  try {
    const budget = (r.ctx.policy.budgets as any).shell.max_output_chars as number;
    r.setFake(JSON.stringify([{ summary: "x".repeat(budget * 2) }]));
    const res = await get(r, "ledger_list").execute("c1", {});
    assert.ok(res.content[0]!.text.length <= budget);
    assert.equal((res.details as any).truncated, true);
  } finally {
    r.dispose();
  }
});

test("WORKLEDGER_PATH is pinned in the child env; cwd is never the checkout", async () => {
  const r = rig();
  try {
    r.setFake("[]");
    await get(r, "ledger_list").execute("c1", {});
    const [call] = calls(r);
    assert.equal(call.path, r.ledgerFile);
    assert.notEqual(call.cwd, r.checkout);
    assert.ok(existsSync(join(r.root, "home")), "parent dir created");
  } finally {
    r.dispose();
  }
});

test("the default ledger is a per-agent home file; relative or in-checkout paths are refused", async () => {
  assert.equal(ledgerPath({ HOME: "/home/x" }), "/home/x/.workledger/associate.jsonl");
  const rel = rig({ ASSOCIATE_LEDGER_PATH: "rel/ledger.jsonl" });
  try {
    const res = await get(rel, "ledger_list").execute("c", {});
    assert.equal(payload(res).code, "bad_destination");
    assert.equal(calls(rel).length, 0);
  } finally {
    rel.dispose();
  }
  const r = rig();
  try {
    const inside = createLedgerTools(r.ctx, { env: { ...r.env, ASSOCIATE_LEDGER_PATH: join(r.checkout, ".workledger", "l.jsonl") } });
    const res = await inside.tools[0]!.execute("c", { action: "a", summary: "s" });
    assert.equal(payload(res).code, "bad_destination");
    assert.equal(calls(r).length, 0);
  } finally {
    r.dispose();
  }
});

test("exit 1 and exit 2 become structured tool errors", async () => {
  const r = rig();
  try {
    r.setFake("", 1, JSON.stringify({ code: "bad_entry", message: "unknown field", remediation: "drop it" }));
    let res = await get(r, "ledger_append").execute("c", { action: "a", summary: "s" });
    assert.equal(payload(res).ok, false);
    assert.equal(payload(res).code, "ledger_user_error");
    assert.equal(payload(res).detail.exit_code, 1);
    assert.match(payload(res).message, /unknown field/);

    r.setFake("", 2, "corrupt ledger");
    res = await get(r, "ledger_list").execute("c", {});
    assert.equal(payload(res).code, "ledger_env_error");
    assert.equal(payload(res).detail.exit_code, 2);
  } finally {
    r.dispose();
  }
});

test("a missing ledger binary is a tool_missing install hint", async () => {
  const r = rig({}, false);
  try {
    const res = await get(r, "ledger_list").execute("c", {});
    assert.equal(payload(res).code, "tool_missing");
    assert.match(payload(res).message, /uv tool install workledger-cli/);
  } finally {
    r.dispose();
  }
});

test("unparseable --json output is an error, not a crash", async () => {
  const r = rig();
  try {
    r.setFake("not json");
    const res = await get(r, "ledger_list").execute("c", {});
    assert.equal(payload(res).code, "ledger_bad_output");
  } finally {
    r.dispose();
  }
});

test("only the append and list verbs are ever spawned", async () => {
  assert.deepEqual([...ALLOWED_VERBS].sort(), ["append", "list"]);
  const r = rig();
  try {
    r.setFake("[]");
    await get(r, "ledger_list").execute("c", { limit: 2 });
    r.setFake("{}");
    await get(r, "ledger_append").execute("c", { action: "a", summary: "s" });
    const verbs = new Set(calls(r).map((c) => c.argv[0]));
    assert.deepEqual([...verbs].sort(), ["append", "list"]);
    for (const c of calls(r)) assert.ok(!c.argv.includes("--stdin"));
  } finally {
    r.dispose();
  }
});

test("register: ledger_list is a declared non-writer, ledger_append is not", () => {
  const r = rig();
  try {
    const registered: string[] = [];
    register({ registerTool: (t: { name: string }) => registered.push(t.name) }, r.ctx);
    assert.deepEqual(registered.sort(), ["ledger_append", "ledger_list"]);
    assert.ok(r.ctx.declaredNonWriters().includes("ledger_list"));
    assert.ok(!r.ctx.declaredNonWriters().includes("ledger_append"));
    assert.ok(!r.ctx.declaredWriters().includes("ledger_append"));
  } finally {
    r.dispose();
  }
});

const realLedger = whichOnPath("ledger");
test("real released ledger CLI round-trips append and list", { skip: realLedger ? false : "ledger not installed" }, async () => {
  const r = rig({ PATH: process.env.PATH! });
  try {
    const tools = createLedgerTools(r.ctx, { env: { ...r.env, PATH: process.env.PATH!, ASSOCIATE_MODEL: "worker" } });
    const [append, list] = [tools.tools[0]!, tools.tools[1]!];
    const a = await append.execute("c", { action: "probe", summary: "t13 round trip", refs: ["x"] });
    assert.equal(payload(a).ok, true, JSON.stringify(payload(a)));
    const l = await list.execute("c", { action: "probe" });
    assert.equal(payload(l).entries[0].agent, "associate/worker");
    assert.ok(readFileSync(r.ledgerFile, "utf8").includes("t13 round trip"));
    const bad = await append.execute("c", { action: "probe", summary: "ok" });
    assert.equal(payload(bad).ok, true);
  } finally {
    r.dispose();
  }
});
