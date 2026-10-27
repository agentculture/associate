/**
 * The per-model guard and the safety-gate wiring, through the real `index.ts`
 * (plan t12, acceptance criteria 1–3).
 *
 * `loadExtension()` runs the real entry point against a fake pi. The decider
 * is a fake `fetch` installed on `globalThis` (the extension looks `fetch` up
 * per call), so every CLEF request is counted and no socket is opened. The
 * walk is read back from the session export directory.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtension, type FakePi } from "./load-extension.ts";
import { findRepoContractDir, loadContract } from "../lib/contract.ts";
import { WalkRecorder } from "../lib/walk.ts";

const CONTRACT = loadContract({});
const GATE = CONTRACT.gate as any;
const QUESTIONS: Record<string, any> = GATE.questions;
const TASK = "Add a CHANGELOG line for the gate wiring";

/** Every tool the shipped contract names, plus pi built-ins and an MCP tool. */
const PI_BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell", "codemode", "tool_search"];

// ------------------------------------------------------------ fake decider

function safeClefAnswers(): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const [key, q] of Object.entries(QUESTIONS)) {
    if (q.type === "noul") answers[key] = { type: "noul", noul: 0.5 };
    else {
      const probabilities: Record<string, number> = {};
      for (const option of Object.keys(q.criteria)) probabilities[option] = 0;
      answers[key] = { type: "choice", choice: Object.keys(q.criteria)[0], probabilities };
    }
  }
  for (const rule of GATE.clef.allow_when) {
    const target = rule.op === ">=" ? Math.min(1, rule.value + 0.05) : Math.max(0, rule.value - 0.05);
    const a = answers[rule.question] as any;
    if (rule.option) a.probabilities[rule.option] = target;
    else a.noul = target;
  }
  return answers;
}

function unsafeClefAnswers(): Record<string, unknown> {
  const answers = safeClefAnswers();
  const rule = GATE.clef.allow_when.find((r: any) => r.op === "<=" && !r.option);
  (answers[rule.question] as any).noul = 0.99;
  return answers;
}

interface Decider {
  calls: Array<{ url: string; body: any }>;
  restore(): void;
}

function installDecider(answers: () => Record<string, unknown>): Decider {
  const original = globalThis.fetch;
  const calls: Decider["calls"] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "null")) });
    return new Response(JSON.stringify({ model: "clef", answers: answers() }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

// --------------------------------------------------------------- fixtures

interface Run {
  pi: FakePi;
  walkPath: string;
  decider: Decider;
  dispose(): void;
}

async function start(
  model: string,
  options: {
    answers?: () => Record<string, unknown>;
    key?: boolean;
    contractDir?: string;
    env?: Record<string, string>;
  } = {},
): Promise<Run> {
  const root = mkdtempSync(join(tmpdir(), "associate-t12-runs-"));
  const checkout = mkdtempSync(join(tmpdir(), "associate-t12-checkout-"));
  const decider = installDecider(options.answers ?? safeClefAnswers);
  const { pi, cleanup } = await loadExtension(
    {
      ASSOCIATE_EXPORT_ROOT: root,
      ASSOCIATE_CHECKOUT_ROOT: checkout,
      ASSOCIATE_SESSION_ID: `t12-${model}`,
      ASSOCIATE_MODEL: model,
      ASSOCIATE_API_KEY: options.key === false ? undefined : "dummy-t12-key",
      ASSOCIATE_BASE_URL: "http://decider.invalid:9/v1",
      ASSOCIATE_CONTRACT_DIR: options.contractDir ?? findRepoContractDir(),
      ...options.env,
    },
    (fake) => {
      fake.builtinTools = [...PI_BUILTINS];
      fake.activeBuiltinTools = [...PI_BUILTINS];
    },
  );
  await pi.fireSessionStart();
  for (const handler of pi.handlers.get("before_agent_start") ?? []) {
    await handler({ type: "before_agent_start", prompt: TASK, systemPrompt: "" }, {});
  }
  return {
    pi,
    walkPath: join(root, `t12-${model}`, "export", "walk.jsonl"),
    decider,
    dispose() {
      decider.restore();
      cleanup();
      rmSync(root, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    },
  };
}

let callSeq = 0;
async function call(pi: FakePi, toolName: string, input: unknown): Promise<{ block: boolean; reason: string } | undefined> {
  callSeq += 1;
  return (await pi.fireToolCall({ type: "tool_call", toolName, toolCallId: `tc-${callSeq}`, input })) as any;
}

function gateLines(walkPath: string): any[] {
  if (!existsSync(walkPath)) return [];
  return readFileSync(walkPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((record) => record && typeof record === "object" && "gate" in record)
    .map((record) => record.gate);
}

async function withRun(
  model: string,
  body: (run: Run) => Promise<void>,
  options?: Parameters<typeof start>[1],
): Promise<void> {
  const run = await start(model, options);
  try {
    await body(run);
  } finally {
    run.dispose();
  }
}

// ------------------------------------------- criterion 1: per-model sets

for (const key of ["worker", "senses", "cortex"]) {
  test(`criterion 1: ${key}'s active set is exactly its registered tools`, async () => {
    await withRun(key, async ({ pi }) => {
      const available = new Set(pi.getAllTools().map((tool) => tool.name));
      const expected = CONTRACT.models.models[key]!.tools.filter((name) => available.has(name));
      assert.deepEqual(new Set(pi.getActiveTools()), new Set(expected));
      for (const never of ["powershell", "codemode", "tool_search"]) {
        assert.ok(!pi.getActiveTools().includes(never), `${never} active for ${key}`);
      }
      if (key === "senses") {
        for (const writer of ["write", "edit", "bash"]) assert.ok(!pi.getActiveTools().includes(writer), writer);
      } else {
        for (const writer of ["write", "edit", "bash"]) assert.ok(pi.getActiveTools().includes(writer), writer);
      }
    });
  });
}

test("criterion 1: the shipped extension registers only tools the contract names", async () => {
  await withRun("worker", async ({ pi }) => {
    const report = JSON.parse((await pi.tool("associate_ready").execute("r", {})).content[0]!.text);
    assert.deepEqual(report.tools_outside_contract, []);
    assert.equal(report.model, "worker");
    assert.equal(report.gate_ready, true);
    for (const name of pi.toolNames()) assert.ok(CONTRACT.models.tool_names.includes(name), name);
  });
});

test("criterion 1: a call outside the model's set is refused, and the decider is never asked", async () => {
  await withRun("worker", async ({ pi, decider, walkPath }) => {
    for (const name of ["mcp__github__create_issue", "codemode", "powershell", "tool_search", "spawn_subagent", "brand_new"]) {
      const decision = await call(pi, name, { anything: true });
      assert.ok(decision?.block, `${name} was not blocked`);
      assert.match(decision!.reason, /not in the tool set of the active model 'worker'/);
    }
    assert.equal(decider.calls.length, 0);
    assert.deepEqual(gateLines(walkPath), []);
  });
  await withRun("senses", async ({ pi }) => {
    for (const name of ["bash", "write", "edit", "code_lens", "ledger_append"]) {
      const decision = await call(pi, name, { argv: ["ls"], path: "x", content: "y" });
      assert.ok(decision?.block, `${name} was not blocked for senses`);
    }
  });
});

test("criterion 1 / r8: a writer re-enabled after our setActiveTools is still refused for senses", async () => {
  await withRun("senses", async ({ pi, decider }) => {
    // Another extension's agent_start handler re-enables the writers.
    pi.setActiveTools([...pi.getActiveTools(), "write", "edit", "bash"]);
    for (const name of ["write", "edit", "bash"]) {
      const decision = await call(pi, name, { path: "README.md", content: "x", argv: ["ls"] });
      assert.ok(decision?.block, `${name} re-enabled for senses was not refused`);
    }
    assert.equal(decider.calls.length, 0);
  });
});

test("an unknown or pending model refuses every call", async () => {
  for (const model of ["nope", "super-vl"]) {
    await withRun(model, async ({ pi, decider }) => {
      for (const name of ["read", "finish", "write"]) {
        const decision = await call(pi, name, { path: "README.md" });
        assert.ok(decision?.block, `${name} not refused under ${model}`);
      }
      assert.equal(decider.calls.length, 0);
      assert.deepEqual(pi.getActiveTools(), []);
    });
  }
});

// ------------------------------------- criterion 2: senses vs bolt/cortex

test("criterion 2: senses' write is refused before the gate even when its entry lists write", async () => {
  // A contract copy whose senses entry lists write: the may_mutate rule, not
  // the tool list, is what refuses it — and the decider is never asked.
  const dir = mkdtempSync(join(tmpdir(), "associate-t12-contract-"));
  try {
    cpSync(findRepoContractDir(), dir, { recursive: true });
    const modelsPath = join(dir, "models.json");
    const doc = JSON.parse(readFileSync(modelsPath, "utf8"));
    doc.models.senses.tools.push("write");
    writeFileSync(modelsPath, JSON.stringify(doc));
    await withRun(
      "senses",
      async ({ pi, decider, walkPath }) => {
        assert.ok(!pi.getActiveTools().includes("write"), "a writer must stay dropped for senses");
        const decision = await call(pi, "write", { path: "README.md", content: "x" });
        assert.ok(decision?.block);
        assert.match(decision!.reason, /may not mutate/);
        assert.equal(decider.calls.length, 0);
        assert.deepEqual(gateLines(walkPath), []);
      },
      { contractDir: dir },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const key of ["worker", "cortex"]) {
  test(`criterion 2: ${key}'s write executes only after a safe gate verdict, recorded in the walk`, async () => {
    await withRun(key, async ({ pi, decider, walkPath }) => {
      const decision = await call(pi, "write", { path: "CHANGELOG.md", content: "- gate wiring\n" });
      assert.equal(decision, undefined, `a safe verdict must let ${key}'s write run: ${decision?.reason}`);
      assert.equal(decider.calls.length, 1);
      const [gate] = gateLines(walkPath);
      assert.equal(gate.decision, "allow");
      assert.equal(gate.tier, "clef");
      assert.equal(gate.gated_tool, "write");
      assert.match(gate.id, /^g1$/);
      assert.equal(typeof gate.question_set_version, "number");
      // The state carries the task from before_agent_start and the model key.
      const state: string = decider.calls[0]!.body.state;
      assert.ok(state.includes(TASK), state);
      assert.ok(state.includes(`model: ${key}`), state);
    });
  });

  test(`criterion 2: ${key}'s write is refused on an unsafe verdict, with the gate's reason`, async () => {
    await withRun(
      key,
      async ({ pi, decider, walkPath }) => {
        const decision = await call(pi, "edit", { path: "README.md", edits: [] });
        assert.ok(decision?.block);
        assert.match(decision!.reason, /safety gate refused 'edit' \(g1, tier clef\)/);
        assert.equal(decider.calls.length, 1);
        assert.equal(gateLines(walkPath)[0].decision, "refuse");
      },
      { answers: unsafeClefAnswers },
    );
  });
}

test("criterion 2: with the decider unreachable a mutation is refused by the read-only fallback", async () => {
  await withRun(
    "worker",
    async ({ pi, decider, walkPath }) => {
      const decision = await call(pi, "write", { path: "README.md", content: "x" });
      assert.ok(decision?.block);
      assert.equal(decider.calls.length, 0, "no key: CLEF is never contacted");
      const [gate] = gateLines(walkPath);
      assert.equal(gate.tier, "readonly");
      assert.equal(gate.decision, "refuse");
    },
    { key: false },
  );
});

test("d8: the decider state carries the run's isolation from ASSOCIATE_ISOLATION", async () => {
  const gate = JSON.parse(readFileSync(join(findRepoContractDir()!, "gate.json"), "utf8"));
  await withRun(
    "worker",
    async ({ pi, decider }) => {
      await call(pi, "write", { path: "README.md", content: "x" });
      assert.equal(decider.calls.length, 1);
      assert.ok(decider.calls[0].body.state.includes(gate.isolation.describe.worktree));
    },
    { env: { ASSOCIATE_ISOLATION: "worktree" } },
  );
  await withRun("worker", async ({ pi, decider }) => {
    await call(pi, "write", { path: "README.md", content: "x" });
    assert.ok(decider.calls[0].body.state.includes(gate.isolation.describe["in-place"]));
  });
});

test("r9: bash eidetic remember and ledger append go through the gate", async () => {
  await withRun("worker", async ({ pi, decider, walkPath }) => {
    assert.equal(await call(pi, "bash", { argv: ["eidetic", "remember", "{}"] }), undefined);
    assert.equal(await call(pi, "bash", { argv: ["ledger", "append", "--json", "{}"] }), undefined);
    assert.equal(decider.calls.length, 2);
    assert.deepEqual(
      gateLines(walkPath).map((g) => [g.id, g.gated_tool]),
      [
        ["g1", "bash"],
        ["g2", "bash"],
      ],
    );
  });
});

test("r15: a mutating call whose gate state was truncated is refused even on a safe verdict", async () => {
  await withRun("worker", async ({ pi, decider, walkPath }) => {
    const budget = (GATE.decider.max_input_tokens as number) * 2;
    const decision = await call(pi, "write", { path: "big.txt", content: "x".repeat(budget) });
    assert.ok(decision?.block, "a truncated mutating call must be refused");
    assert.match(decision!.reason, /truncated/);
    assert.equal(decider.calls.length, 1, "the decider was asked and allowed");
    const [gate] = gateLines(walkPath);
    assert.equal(gate.decision, "refuse");
    assert.match(gate.reason, /r15/);
  });
});

// ------------- d6 / r17, d7: gated_tools (memory writes, web egress)

test("d6/d7: gated_tools lists the memory write and both web tools, none a repo mutation", () => {
  assert.deepEqual([...CONTRACT.models.gated_tools], ["eidetic_remember", "web_search", "web_page"]);
  for (const name of CONTRACT.models.gated_tools) {
    assert.ok(!CONTRACT.models.mutating_tools.includes(name), `${name} must not be a repo mutation`);
    assert.ok(CONTRACT.models.models.senses!.tools.includes(name), `senses keeps ${name} (c35, d7)`);
  }
});

/** One sample call per gated tool (d6: memory write; d7: the web tools send data off the machine). */
const GATED_CALLS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["eidetic_remember", { text: "the gate wiring landed" }],
  ["web_search", { query: "pi coding agent" }],
  ["web_page", { url: "https://example.invalid/page" }],
];

for (const key of ["senses", "worker"]) {
  for (const [tool, input] of GATED_CALLS) {
    test(`d6/d7: ${key}'s ${tool} passes the gate and runs on allow, with a gate line`, async () => {
      await withRun(key, async ({ pi, decider, walkPath }) => {
        const decision = await call(pi, tool, input);
        assert.equal(decision, undefined, `a safe verdict must let ${key}'s ${tool} run: ${decision?.reason}`);
        assert.equal(decider.calls.length, 1, `the decider was asked about ${tool}`);
        const [gate] = gateLines(walkPath);
        assert.equal(gate.decision, "allow");
        assert.equal(gate.tier, "clef");
        assert.equal(gate.gated_tool, tool);
        const state: string = decider.calls[0]!.body.state;
        assert.ok(state.includes(`model: ${key}`), state);
      });
    });

    test(`d6/d7: ${key}'s ${tool} is refused on an unsafe verdict, with a gate line`, async () => {
      await withRun(
        key,
        async ({ pi, decider, walkPath }) => {
          const decision = await call(pi, tool, input);
          assert.ok(decision?.block, `${key}'s ${tool} ran on an unsafe verdict`);
          assert.match(decision!.reason, new RegExp(`safety gate refused '${tool}' \\(g1, tier clef\\)`));
          assert.equal(decider.calls.length, 1);
          const [gate] = gateLines(walkPath);
          assert.equal(gate.decision, "refuse");
          assert.equal(gate.gated_tool, tool);
        },
        { answers: unsafeClefAnswers },
      );
    });

    test(`d6/d7: ${key}, decider unreachable and Super pending: ${tool} is refused (fail closed)`, async () => {
      await withRun(
        key,
        async ({ pi, decider, walkPath }) => {
          const decision = await call(pi, tool, input);
          assert.ok(decision?.block, `${tool} is not a read: the read-only fallback must refuse it`);
          assert.equal(decider.calls.length, 0, "no key: CLEF is never contacted");
          const lines = gateLines(walkPath);
          assert.equal(lines.length, 1);
          assert.equal(lines[0].tier, "readonly");
          assert.equal(lines[0].decision, "refuse");
          assert.equal(lines[0].gated_tool, tool);
        },
        { key: false },
      );
    });
  }
}

for (const key of ["senses", "worker"]) {
  test(`d6/d7: ${key}, decider unreachable: eidetic_recall and read/grep/find/ls still run, never asking`, async () => {
    await withRun(
      key,
      async ({ pi, decider, walkPath }) => {
        for (const [name, input] of [
          ["eidetic_recall", { query: "gate" }],
          ["read", { path: "README.md" }],
          ["grep", { pattern: "x" }],
          ["find", { pattern: "*.ts" }],
          ["ls", { path: "." }],
        ] as const) {
          const decision = await call(pi, name, input);
          assert.equal(decision, undefined, `${key} ${name} was blocked: ${decision?.reason}`);
        }
        assert.equal(decider.calls.length, 0);
        assert.deepEqual(gateLines(walkPath), []);
      },
      { key: false },
    );
  });
}


for (const key of ["senses", "worker"]) {
  test(`d6 / r15: ${key}'s truncated eidetic_remember is refused even on a safe verdict`, async () => {
    await withRun(key, async ({ pi, decider, walkPath }) => {
      const budget = (GATE.decider.max_input_tokens as number) * 2;
      const decision = await call(pi, "eidetic_remember", { text: "x".repeat(budget) });
      assert.ok(decision?.block, "a truncated memory write must be refused");
      assert.match(decision!.reason, /truncated/);
      assert.equal(decider.calls.length, 1);
      const [gate] = gateLines(walkPath);
      assert.equal(gate.decision, "refuse");
      assert.match(gate.reason, /r15/);
    });
  });
}

test("d6: senses' write/edit/bash stay refused before the gate while eidetic_remember is gated", async () => {
  // Shipped contract: refused at the tool-set check, the decider never asked.
  await withRun("senses", async ({ pi, decider, walkPath }) => {
    pi.setActiveTools([...pi.getActiveTools(), "write", "edit", "bash"]);
    for (const name of ["write", "edit", "bash"]) {
      const decision = await call(pi, name, { path: "README.md", content: "x", argv: ["eidetic", "remember", "{}"] });
      assert.ok(decision?.block, `${name} was not refused for senses`);
    }
    assert.equal(decider.calls.length, 0, "a senses repo mutation reached the decider");
    assert.deepEqual(gateLines(walkPath), []);
    assert.equal(await call(pi, "eidetic_remember", { text: "x" }), undefined);
    assert.equal(decider.calls.length, 1);
    assert.equal(gateLines(walkPath).length, 1);
  });
  // A contract copy whose senses entry lists the writers: the may_mutate rule
  // (not the set check) refuses them before the gate, while the gated memory
  // write still reaches it.
  const dir = mkdtempSync(join(tmpdir(), "associate-d6-senses-"));
  try {
    cpSync(findRepoContractDir(), dir, { recursive: true });
    const modelsPath = join(dir, "models.json");
    const doc = JSON.parse(readFileSync(modelsPath, "utf8"));
    doc.models.senses.tools.push("write", "edit", "bash");
    writeFileSync(modelsPath, JSON.stringify(doc));
    await withRun(
      "senses",
      async ({ pi, decider, walkPath }) => {
        for (const [name, input] of [
          ["write", { path: "README.md", content: "x" }],
          ["edit", { path: "README.md", edits: [] }],
          ["bash", { argv: ["eidetic", "remember", "{}"] }],
        ] as const) {
          const decision = await call(pi, name, input);
          assert.ok(decision?.block, `${name} was not refused for senses`);
          assert.match(decision!.reason, /may not mutate/, `${name} refused for the wrong reason`);
        }
        assert.equal(decider.calls.length, 0, "a senses repo mutation reached the decider");
        assert.deepEqual(gateLines(walkPath), []);
        assert.equal(await call(pi, "eidetic_remember", { text: "x" }), undefined);
        assert.equal(decider.calls.length, 1);
        assert.deepEqual(gateLines(walkPath).map((g) => g.gated_tool), ["eidetic_remember"]);
      },
      { contractDir: dir },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("d6: a gated_tools-only contract change gates the named tool for senses (contract-driven)", async () => {
  // Remove eidetic_remember from gated_tools: senses' memory write goes back to
  // ungated — proving the guard reads the list, not a hard-coded name.
  const dir = mkdtempSync(join(tmpdir(), "associate-d6-contract-"));
  try {
    cpSync(findRepoContractDir(), dir, { recursive: true });
    const modelsPath = join(dir, "models.json");
    const doc = JSON.parse(readFileSync(modelsPath, "utf8"));
    doc.gated_tools = [];
    writeFileSync(modelsPath, JSON.stringify(doc));
    await withRun(
      "senses",
      async ({ pi, decider }) => {
        assert.equal(await call(pi, "eidetic_remember", { text: "x" }), undefined);
        assert.equal(decider.calls.length, 0);
      },
      { contractDir: dir },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------ criterion 3: reads skip it

test("criterion 3: pure reads never call the decider and write no gate line (web tools are gated since d7)", async () => {
  for (const key of ["worker", "cortex", "senses"]) {
    await withRun(key, async ({ pi, decider, walkPath }) => {
      const reads: Array<[string, unknown]> = [
        ["read", { path: "README.md" }],
        ["grep", { pattern: "x" }],
        ["find", { pattern: "*.ts" }],
        ["ls", { path: "." }],
        ["eidetic_recall", { query: "gate" }],
        ["associate_ready", {}],
      ];
      if (key !== "senses") {
        reads.push(
          ["code_lens", { path: "x" }],
          ["bash", { argv: ["rg", "-n", "TODO"] }],
          ["bash", { argv: ["git", "log", "--oneline"] }],
          ["bash", { argv: ["eidetic", "recall", "gate"] }],
          ["bash", { argv: ["ledger", "list"] }],
        );
      }
      for (const [name, input] of reads) {
        const decision = await call(pi, name, input);
        assert.equal(decision, undefined, `${key} ${name} was blocked: ${decision?.reason}`);
      }
      assert.equal(decider.calls.length, 0, `${key}: a pure read reached the decider`);
      assert.deepEqual(gateLines(walkPath), []);
    });
  }
});

// ---------------------------------------------------------------- walk

test("gate lines take no walk id: a reopened walk keeps numbering entries densely", () => {
  const dir = mkdtempSync(join(tmpdir(), "associate-t12-walk-"));
  try {
    const first = new WalkRecorder({ exportDir: dir, policy: CONTRACT.policy, installExitHook: false });
    first.noteToolCall({ toolName: "read", toolCallId: "a", input: { path: "x" } });
    first.recordToolResult({ toolName: "read", toolCallId: "a", content: "x" });
    first.recordGate({
      id: "g1",
      ts: new Date(0).toISOString(),
      tier: "clef",
      question_set_version: 1,
      gated_tool: "write",
      decision: "allow",
      reason: "token: sk-abcdefghijklmnopqrstuvwx",
    });
    const second = new WalkRecorder({ exportDir: dir, policy: CONTRACT.policy, installExitHook: false });
    assert.equal(second.entryCount, 1);
    const lines = readFileSync(join(dir, "walk.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(Object.keys(lines[1]), ["gate"]);
    assert.ok(!JSON.stringify(lines[1]).includes("sk-abcdefghijklmnopqrstuvwx"), "gate lines are redacted");
    first.finalize();
    assert.throws(() =>
      first.recordGate({ id: "g2", ts: "", tier: "clef", question_set_version: 1, gated_tool: "w", decision: "allow" }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------- d12: run_tests, the operator's tests

test("d12: run_tests is offered to worker and cortex, never to senses", async () => {
  for (const key of ["worker", "cortex"]) {
    await withRun(key, async ({ pi }) => {
      assert.ok(pi.toolNames().includes("run_tests"), "the tool module registered run_tests");
      assert.ok(pi.getActiveTools().includes("run_tests"), `run_tests not active for ${key}`);
    });
  }
  await withRun("senses", async ({ pi, decider, walkPath }) => {
    assert.ok(!pi.getActiveTools().includes("run_tests"), "run_tests active for senses");
    const decision = await call(pi, "run_tests", {});
    assert.ok(decision?.block, "senses' run_tests was not refused");
    assert.equal(decider.calls.length, 0, "senses' run_tests reached the decider");
    assert.deepEqual(gateLines(walkPath), []);
  });
});

test("d12: worker's run_tests reaches the CLEF gate with its effect and isolation lines", async () => {
  const gate = JSON.parse(readFileSync(join(findRepoContractDir()!, "gate.json"), "utf8"));
  await withRun(
    "worker",
    async ({ pi, decider, walkPath }) => {
      const decision = await call(pi, "run_tests", { command: 0 });
      assert.equal(decision, undefined, `a safe verdict must let run_tests run: ${decision?.reason}`);
      assert.equal(decider.calls.length, 1);
      const [line] = gateLines(walkPath);
      assert.equal(line.gated_tool, "run_tests");
      assert.equal(line.decision, "allow");
      const state: string = decider.calls[0]!.body.state;
      assert.ok(state.includes(gate.effects.run_tests), state);
      assert.ok(state.includes(gate.isolation.describe.worktree), state);
    },
    { env: { ASSOCIATE_ISOLATION: "worktree" } },
  );
  await withRun(
    "worker",
    async ({ pi, decider }) => {
      const decision = await call(pi, "run_tests", {});
      assert.ok(decision?.block);
      assert.match(decision!.reason, /safety gate refused 'run_tests' \(g1, tier clef\)/);
      assert.equal(decider.calls.length, 1);
    },
    { answers: unsafeClefAnswers },
  );
});
