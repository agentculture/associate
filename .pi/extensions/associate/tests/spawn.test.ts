/**
 * `spawn_subagent` — cortex's spawn tool (plan t16; spec c40/h24, c52/h34).
 *
 * No test here starts a real pi or a model. The tool takes an injectable
 * launcher; the fakes below record the argv/env a child would get, emit the
 * JSON-mode event lines pi would print, and observe start/end ordering. Two
 * tests go further and load the REAL extension with the environment a child
 * was handed, to prove (a) the child's own guard refuses writes under
 * `ASSOCIATE_MODEL=senses` and (b) the child's walk lands exactly where the
 * parent's `child` line says it does. One test drives the real default
 * launcher against `node -e` (not pi) to cover the process plumbing.
 *
 * Acceptance criteria:
 *   1. spawning any model other than worker or senses is refused;
 *   2. a senses child cannot write; two writing bolt children never write the
 *      same tree concurrently (senses children do run in parallel);
 *   3. the parent walk references every child walk by path.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepoContractDir, loadContract } from "../lib/contract.ts";
import { extensionDir } from "../lib/paths.ts";
import { createAssociateContext } from "../lib/runtime.ts";
import { WALK_FILENAME, WalkRecorder } from "../lib/walk.ts";
import { loadExtension } from "./load-extension.ts";
import {
  createSpawnTool,
  defaultLauncher,
  piTrustFlags,
  DEADLINE_SAFETY_MARGIN_MS,
  MIN_CHILD_WALL_MS,
  PI_TRUST_ENV,
  RUN_DEADLINE_ENV,
  SPAWN_TOOL_NAME,
  type LaunchOutcome,
  type LaunchSpec,
  type Launcher,
} from "../tools/spawn.ts";

const CONTRACT = loadContract({});
const CONTRACT_DIR = findRepoContractDir()!;
const repoRoot = join(extensionDir, "..", "..", "..");
const FAKE_PI = "/opt/fake/bin/pi";

// ------------------------------------------------------------------ fixtures

interface Rig {
  root: string;
  checkout: string;
  walk: WalkRecorder;
  ctx: ReturnType<typeof createAssociateContext>;
  env: Record<string, string | undefined>;
  dispose(): void;
}

function rig(model = "cortex", extraEnv: Record<string, string | undefined> = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), "associate-t16-"));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    ASSOCIATE_EXPORT_ROOT: join(root, "runs"),
    ASSOCIATE_SESSION_ID: `parent-${model}`,
    ASSOCIATE_CHECKOUT_ROOT: checkout,
    ASSOCIATE_CONTRACT_DIR: CONTRACT_DIR,
    ASSOCIATE_MODEL: model,
    ASSOCIATE_BASE_URL: "http://lane.invalid:9/v1",
    ASSOCIATE_API_KEY: "dummy-t16-key",
    ASSOCIATE_PI_TRUST: "approve",
    ...extraEnv,
  };
  const ctx = createAssociateContext({ env, checkoutRoot: checkout });
  const walk = new WalkRecorder({ exportDir: ctx.session.exportDir, policy: ctx.policy, installExitHook: false });
  return { root, checkout, walk, ctx, env, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

interface Event {
  kind: "start" | "end";
  model: string;
  at: number;
}

/** What a fake child does: the JSON lines it prints and how it ends. */
interface Script {
  lines?: (spec: LaunchSpec) => string[];
  outcome?: Partial<LaunchOutcome>;
  delayMs?: number;
  throws?: boolean;
}

interface FakeLauncher {
  launch: Launcher;
  specs: LaunchSpec[];
  events: Event[];
}

function finishLine(handback: Record<string, unknown>): string {
  return JSON.stringify({
    type: "tool_execution_end",
    toolCallId: "f1",
    toolName: "finish",
    result: {
      content: [
        { type: "text", text: JSON.stringify(handback) },
        { type: "text", text: "Hand-back recorded. Now reply." },
      ],
    },
    isError: false,
  });
}

function assistantLine(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra },
  });
}

function fakeLauncher(script: Script | ((spec: LaunchSpec) => Script) = {}): FakeLauncher {
  const specs: LaunchSpec[] = [];
  const events: Event[] = [];
  let clock = 0;
  const launch: Launcher = async (spec, onLine) => {
    specs.push(spec);
    const s = typeof script === "function" ? script(spec) : script;
    const model = spec.env.ASSOCIATE_MODEL ?? "?";
    events.push({ kind: "start", model, at: (clock += 1) });
    if (s.throws) throw new Error("launcher exploded");
    await new Promise((r) => setTimeout(r, s.delayMs ?? 20));
    const lines =
      s.lines?.(spec) ?? [
        JSON.stringify({ type: "agent_start" }),
        finishLine({ summary: `done by ${model}`, statements: [] }),
        assistantLine(`final reply from ${model}`),
      ];
    for (const line of lines) onLine(line);
    events.push({ kind: "end", model, at: (clock += 1) });
    return { exitCode: 0, timedOut: false, aborted: false, stderrTail: "", ...s.outcome };
  };
  return { launch, specs, events };
}

function tool(r: Rig, launcher: FakeLauncher, extra: Parameters<typeof createSpawnTool>[1] = {}) {
  return createSpawnTool(r.ctx, {
    env: r.env,
    launch: launcher.launch,
    which: () => FAKE_PI,
    recordChild: (link) => r.walk.recordChild(link),
    ...extra,
  });
}

async function run(t: ReturnType<typeof createSpawnTool>, params: Record<string, unknown>, signal?: AbortSignal) {
  const result = await t.execute("tc", params, signal);
  return result.details as any;
}

function childLines(walkPath: string): any[] {
  if (!existsSync(walkPath)) return [];
  return readFileSync(walkPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((record) => record && typeof record === "object" && "child" in record)
    .map((record) => record.child);
}

/** Overlap of two [start, end] intervals for the named models in event order. */
function intervals(events: Event[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const open: number[] = [];
  for (const event of events) {
    if (event.kind === "start") open.push(event.at);
    else out.push([open.shift()!, event.at]);
  }
  return out;
}

// ------------------------------------------- criterion 1: who may be spawned

test("criterion 1: cortex may spawn worker and senses — read from models.json may_spawn", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher();
    const t = tool(r, launcher);
    assert.equal(t.name, SPAWN_TOOL_NAME);
    assert.deepEqual([...(t.parameters as any).properties.model.enum], [...CONTRACT.models.models.cortex!.may_spawn]);
    for (const model of ["worker", "senses"]) {
      const out = await run(t, { model, task: "look at README.md" });
      assert.equal(out.ok, true, JSON.stringify(out));
      assert.equal(out.child_model, model);
    }
    assert.equal(launcher.specs.length, 2);
  } finally {
    r.dispose();
  }
});

test("criterion 1: spawning cortex, super-vl or any unknown model is refused without launching", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher();
    const t = tool(r, launcher);
    for (const model of ["cortex", "super-vl", "nobody", "", "WORKER", "bolt"]) {
      const out = await run(t, { model, task: "anything" });
      assert.equal(out.ok, false, model);
      assert.equal(out.code, "spawn_refused", `${model}: ${JSON.stringify(out)}`);
      assert.deepEqual(out.detail.allowed, ["worker", "senses"]);
    }
    assert.equal(launcher.specs.length, 0, "a refused spawn never launched a process");
    assert.deepEqual(childLines(r.walk.walkPath), [], "a refused spawn writes no child line");
  } finally {
    r.dispose();
  }
});

test("criterion 1: the allowed set is the contract's, not TypeScript's", async () => {
  // A contract whose cortex may spawn only senses refuses worker.
  const r = rig();
  try {
    const models = structuredClone(CONTRACT.models) as any;
    models.models.cortex.may_spawn = ["senses"];
    const ctx = { ...r.ctx, contract: { ...r.ctx.contract, models } } as typeof r.ctx;
    const launcher = fakeLauncher();
    const t = createSpawnTool(ctx, {
      env: r.env,
      launch: launcher.launch,
      which: () => FAKE_PI,
      recordChild: (link) => r.walk.recordChild(link),
    });
    assert.equal((await run(t, { model: "worker", task: "x" })).code, "spawn_refused");
    assert.equal((await run(t, { model: "senses", task: "x" })).ok, true);
  } finally {
    r.dispose();
  }
});

test("criterion 1: a child that may itself spawn is refused even if a contract lists it", async () => {
  const r = rig();
  try {
    const models = structuredClone(CONTRACT.models) as any;
    models.models.worker.may_spawn = ["senses"];
    const ctx = { ...r.ctx, contract: { ...r.ctx.contract, models } } as typeof r.ctx;
    const launcher = fakeLauncher();
    const t = createSpawnTool(ctx, {
      env: r.env,
      launch: launcher.launch,
      which: () => FAKE_PI,
      recordChild: (link) => r.walk.recordChild(link),
    });
    const out = await run(t, { model: "worker", task: "x" });
    assert.equal(out.code, "spawn_refused");
    assert.equal(launcher.specs.length, 0);
  } finally {
    r.dispose();
  }
});

for (const parent of ["worker", "senses"]) {
  test(`criterion 1: a ${parent} parent (may_spawn []) is refused every child, even if the call reaches execute`, async () => {
    const r = rig(parent);
    try {
      const launcher = fakeLauncher();
      const t = tool(r, launcher);
      for (const model of ["worker", "senses"]) {
        assert.equal((await run(t, { model, task: "x" })).code, "spawn_refused");
      }
      assert.equal(launcher.specs.length, 0);
    } finally {
      r.dispose();
    }
  });
}

test("malformed arguments are refused as invalid_args", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher();
    const t = tool(r, launcher);
    for (const params of [
      {},
      { model: "senses" },
      { model: "senses", task: "   " },
      { model: "senses", task: 7 },
      { model: "senses", task: "x", argv: ["--tools", "write"] },
      { model: "senses", task: "x", env: { ASSOCIATE_MODEL: "worker" } },
    ]) {
      const out = await run(t, params as Record<string, unknown>);
      assert.equal(out.code, "invalid_args", JSON.stringify(params));
    }
    assert.equal(launcher.specs.length, 0);
  } finally {
    r.dispose();
  }
});

// --------------------------------------- the child launch: argv and environment

test("the child is launched as pi with this extension, mirroring the Python harness flags", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher();
    await run(tool(r, launcher), { model: "senses", task: "--tools write please" });
    const spec = launcher.specs[0]!;
    assert.equal(spec.file, FAKE_PI);
    assert.equal(spec.cwd, r.checkout);
    const args = spec.args;
    for (const flag of ["-p", "--no-session", "--no-context-files", "--no-mcp"]) assert.ok(args.includes(flag), flag);
    assert.deepEqual(args.slice(args.indexOf("--mode"), args.indexOf("--mode") + 2), ["--mode", "json"]);
    // Exactly one extension, and it is this one.
    const eFlags = args.flatMap((a, i) => (a === "-e" || a === "--extension" ? [args[i + 1]] : []));
    assert.deepEqual(eFlags, [join(extensionDir, "index.ts")]);
    // The provider and the child's own wire id when a key is configured.
    assert.deepEqual(args.slice(args.indexOf("--provider"), args.indexOf("--provider") + 4), [
      "--provider",
      "associate",
      "--model",
      CONTRACT.models.models.senses!.lobes_role,
    ]);
    // The task is the last argument and cannot be read as a flag.
    const last = args[args.length - 1]!;
    assert.ok(last.includes("--tools write please"));
    assert.ok(!last.startsWith("-"), last);
  } finally {
    r.dispose();
  }
});

test("criterion 2: a senses child's argv and env cannot grant it writers", async () => {
  const r = rig("cortex", { ASSOCIATE_MODEL: "cortex" });
  try {
    const launcher = fakeLauncher();
    await run(tool(r, launcher), { model: "senses", task: "read the docs" });
    const spec = launcher.specs[0]!;
    assert.equal(spec.env.ASSOCIATE_MODEL, "senses", "the child runs under senses' own guard");
    for (const flag of ["--tools", "-t", "--no-tools", "--thinking", "--append-system-prompt", "--system-prompt"]) {
      assert.ok(!spec.args.includes(flag), `${flag} in child argv`);
    }
    // Nothing in the env can select another model or reuse the parent's session.
    assert.notEqual(spec.env.ASSOCIATE_SESSION_ID, r.env.ASSOCIATE_SESSION_ID);
    assert.equal(spec.env.ASSOCIATE_INJECT_PROMPT, "1");
    assert.equal(spec.env.ASSOCIATE_CONTRACT_DIR, r.ctx.contract.dir);
  } finally {
    r.dispose();
  }
});

test("criterion 2: the real extension, loaded with a senses child's env, offers no writer and refuses write", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher();
    await run(tool(r, launcher), { model: "senses", task: "read" });
    const childEnv = launcher.specs[0]!.env;
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("no network in tests");
    }) as typeof fetch;
    const { pi, cleanup } = await loadExtension({ ...childEnv }, (fake) => {
      fake.builtinTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
      fake.activeBuiltinTools = [...fake.builtinTools];
    });
    try {
      await pi.fireSessionStart();
      const report = JSON.parse((await pi.tool("associate_ready").execute("r", {})).content[0]!.text);
      assert.equal(report.model, "senses");
      assert.deepEqual(report.writer_tools_active, []);
      assert.ok(!pi.getActiveTools().includes(SPAWN_TOOL_NAME), "a senses child cannot spawn");
      for (const name of ["write", "edit", "bash", SPAWN_TOOL_NAME]) {
        const decision = (await pi.fireToolCall({
          type: "tool_call",
          toolName: name,
          toolCallId: `c-${name}`,
          input: { path: "README.md", content: "x", argv: ["touch", "x"], model: "worker", task: "x" },
        })) as any;
        assert.ok(decision?.block, `${name} was not refused in the senses child`);
      }
      assert.equal(fetches, 0, "the senses child refused writes before any gate call");
    } finally {
      globalThis.fetch = originalFetch;
      cleanup();
    }
  } finally {
    r.dispose();
  }
});

test("the child inherits the lane, isolation and test commands, and never the parent's continue-from or ACP id", async () => {
  const r = rig("cortex", {
    ASSOCIATE_ISOLATION: "worktree",
    ASSOCIATE_TEST_COMMANDS: '[["make","test"]]',
    ASSOCIATE_CONTINUE_FROM: "/x/old/walk.jsonl",
    PI_ACP_SESSION_ID: "acp-parent",
    ACP_SESSION_ID: "acp-parent",
  });
  try {
    const launcher = fakeLauncher();
    await run(tool(r, launcher), { model: "worker", task: "edit" });
    const env = launcher.specs[0]!.env;
    assert.equal(env.ASSOCIATE_BASE_URL, r.env.ASSOCIATE_BASE_URL);
    assert.equal(env.ASSOCIATE_API_KEY, r.env.ASSOCIATE_API_KEY);
    assert.equal(env.ASSOCIATE_ISOLATION, "worktree");
    assert.equal(env.ASSOCIATE_TEST_COMMANDS, '[["make","test"]]');
    assert.equal(env.ASSOCIATE_CHECKOUT_ROOT, r.checkout);
    assert.equal(env.ASSOCIATE_MODEL, "worker");
    for (const gone of ["ASSOCIATE_CONTINUE_FROM", "PI_ACP_SESSION_ID", "ACP_SESSION_ID"]) {
      assert.ok(!(gone in env), `${gone} reached the child`);
    }
  } finally {
    r.dispose();
  }
});

test("without a key the child gets no --provider (pi's default applies, as in the Python harness)", async () => {
  const r = rig("cortex", { ASSOCIATE_API_KEY: undefined });
  try {
    const launcher = fakeLauncher();
    await run(tool(r, launcher), { model: "senses", task: "x" });
    assert.ok(!launcher.specs[0]!.args.includes("--provider"));
  } finally {
    r.dispose();
  }
});

test("trust: a child is never launched more trusting than its parent", () => {
  assert.deepEqual(piTrustFlags({ [PI_TRUST_ENV]: "approve" }), ["--approve"]);
  for (const value of [undefined, "", "untrusted", "APPROVE", "yes", "1"]) {
    assert.deepEqual(piTrustFlags({ [PI_TRUST_ENV]: value }), ["--no-approve", "--no-extensions"], String(value));
  }
});

test("trust: an untrusted (or unknown-trust) parent's child gets --no-approve --no-extensions and passes the mode on", async () => {
  for (const value of ["untrusted", undefined]) {
    const r = rig("cortex", { ASSOCIATE_PI_TRUST: value });
    try {
      const launcher = fakeLauncher();
      await run(tool(r, launcher), { model: "worker", task: "x" });
      const spec = launcher.specs[0]!;
      assert.ok(!spec.args.includes("--approve"), String(value));
      assert.ok(spec.args.includes("--no-approve") && spec.args.includes("--no-extensions"));
      assert.equal(spec.env[PI_TRUST_ENV], "untrusted");
    } finally {
      r.dispose();
    }
  }
});

// ------------------------------------------- the parent run's deadline (r3)

const POLICY_TIMEOUT_MS = (CONTRACT.policy.budgets as any).spawn.timeout_ms as number;

test("deadline: with no run deadline the child gets the contract's wall clock", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher();
    await run(tool(r, launcher), { model: "senses", task: "read" });
    assert.equal(launcher.specs[0]!.timeoutMs, POLICY_TIMEOUT_MS);
  } finally {
    r.dispose();
  }
});

test("deadline: SpawnDeps.timeoutMs overrides the contract's wall clock", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher();
    await run(tool(r, launcher, { timeoutMs: 1234 }), { model: "senses", task: "read" });
    assert.equal(launcher.specs[0]!.timeoutMs, 1234);
  } finally {
    r.dispose();
  }
});

test("deadline: the run deadline caps the child's wall clock, minus the safety margin", async () => {
  const now = 1_000_000;
  const remaining = 200_000;
  const r = rig("cortex", { [RUN_DEADLINE_ENV]: String(now + remaining) });
  try {
    const launcher = fakeLauncher();
    const out = await run(tool(r, launcher, { now: () => now }), { model: "senses", task: "read" });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.ok(remaining - DEADLINE_SAFETY_MARGIN_MS < POLICY_TIMEOUT_MS);
    assert.equal(launcher.specs[0]!.timeoutMs, remaining - DEADLINE_SAFETY_MARGIN_MS);
  } finally {
    r.dispose();
  }
});

test("deadline: the deadline is snapshotted at load, not re-read from a later env", async () => {
  const now = 1_000_000;
  const r = rig("cortex", { [RUN_DEADLINE_ENV]: String(now + 200_000) });
  try {
    const launcher = fakeLauncher();
    const t = tool(r, launcher, { now: () => now });
    r.env[RUN_DEADLINE_ENV] = String(now + 10 * POLICY_TIMEOUT_MS);
    await run(t, { model: "senses", task: "read" });
    assert.equal(launcher.specs[0]!.timeoutMs, 200_000 - DEADLINE_SAFETY_MARGIN_MS);
  } finally {
    r.dispose();
  }
});

test("deadline: time spent waiting for the writer lock counts against it", async () => {
  let clock = 1_000_000;
  const deadline = clock + 400_000;
  const r = rig("cortex", { [RUN_DEADLINE_ENV]: String(deadline) });
  try {
    const base = fakeLauncher({ delayMs: 5 });
    const launch: Launcher = async (spec, onLine) => {
      const outcome = await base.launch(spec, onLine);
      clock += 100_000; // the first writer runs 100 s of (fake) wall clock
      return outcome;
    };
    const t = tool(r, { ...base, launch }, { now: () => clock });
    const [a, b] = await Promise.all([
      run(t, { model: "worker", task: "edit a" }),
      run(t, { model: "worker", task: "edit b" }),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(base.specs[0]!.timeoutMs, 400_000 - DEADLINE_SAFETY_MARGIN_MS);
    assert.equal(base.specs[1]!.timeoutMs, 300_000 - DEADLINE_SAFETY_MARGIN_MS);
  } finally {
    r.dispose();
  }
});

test("deadline: a spawn with too little run time left is refused and nothing starts", async () => {
  const now = 1_000_000;
  const r = rig("cortex", { [RUN_DEADLINE_ENV]: String(now + DEADLINE_SAFETY_MARGIN_MS + MIN_CHILD_WALL_MS - 1) });
  try {
    const launcher = fakeLauncher();
    const out = await run(tool(r, launcher, { now: () => now }), { model: "senses", task: "read" });
    assert.equal(out.ok, false);
    assert.equal(out.error.code, "run_deadline", JSON.stringify(out));
    assert.equal(launcher.specs.length, 0);
    assert.equal(childLines(r.ctx.session.exportDir + "/" + WALK_FILENAME).length, 0);
  } finally {
    r.dispose();
  }
});

test("deadline: a writer still queued when the run runs out of time is refused, never started", async () => {
  // Real clock: the queued writer's start budget is ~150 ms; the first writer holds the lock 400 ms.
  const r = rig("cortex", {
    [RUN_DEADLINE_ENV]: String(Date.now() + DEADLINE_SAFETY_MARGIN_MS + MIN_CHILD_WALL_MS + 150),
  });
  try {
    const launcher = fakeLauncher({ delayMs: 400 });
    const t = tool(r, launcher);
    const [a, b] = await Promise.all([
      run(t, { model: "worker", task: "edit a" }),
      run(t, { model: "worker", task: "edit b" }),
    ]);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(b.ok, false);
    assert.equal(b.error.code, "run_deadline", JSON.stringify(b));
    assert.equal(typeof b.detail.waited_ms, "number", JSON.stringify(b));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(launcher.specs.length, 1, "the refused writer was started after all");
  } finally {
    r.dispose();
  }
});

test("deadline: a malformed deadline value falls back to the contract's wall clock", async () => {
  const r = rig("cortex", { [RUN_DEADLINE_ENV]: "soon" });
  try {
    const launcher = fakeLauncher();
    await run(tool(r, launcher), { model: "senses", task: "read" });
    assert.equal(launcher.specs[0]!.timeoutMs, POLICY_TIMEOUT_MS);
  } finally {
    r.dispose();
  }
});

// ------------------------------------------------ criterion 2: concurrency

test("criterion 2 (h34): two writing worker children against one checkout never overlap", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher({ delayMs: 40 });
    const t = tool(r, launcher);
    const results = await Promise.all([
      run(t, { model: "worker", task: "edit a" }),
      run(t, { model: "worker", task: "edit b" }),
      run(t, { model: "worker", task: "edit c" }),
    ]);
    for (const out of results) assert.equal(out.ok, true);
    const spans = intervals(launcher.events);
    assert.equal(spans.length, 3);
    for (let i = 1; i < spans.length; i += 1) {
      assert.ok(spans[i]![0] > spans[i - 1]![1], `writer ${i} started before writer ${i - 1} ended: ${JSON.stringify(spans)}`);
    }
  } finally {
    r.dispose();
  }
});

test("criterion 2 (h34): the serialisation holds across two tool instances on the same checkout", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher({ delayMs: 40 });
    const a = tool(r, launcher);
    const b = tool(r, launcher);
    await Promise.all([run(a, { model: "worker", task: "a" }), run(b, { model: "worker", task: "b" })]);
    const [first, second] = intervals(launcher.events);
    assert.ok(second![0] > first![1], JSON.stringify(launcher.events));
  } finally {
    r.dispose();
  }
});

test("criterion 2: a failed writer releases the checkout for the next one", async () => {
  const r = rig();
  try {
    let n = 0;
    const launcher = fakeLauncher(() => (n++ === 0 ? { throws: true } : { delayMs: 5 }));
    const t = tool(r, launcher);
    const [first, second] = await Promise.all([run(t, { model: "worker", task: "a" }), run(t, { model: "worker", task: "b" })]);
    assert.equal(first.ok, false);
    assert.equal(second.ok, true);
  } finally {
    r.dispose();
  }
});

test("c52: senses children run in parallel, and alongside a writer", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher({ delayMs: 40 });
    const t = tool(r, launcher);
    await Promise.all([
      run(t, { model: "senses", task: "a" }),
      run(t, { model: "senses", task: "b" }),
      run(t, { model: "worker", task: "c" }),
    ]);
    const starts = launcher.events.filter((e) => e.kind === "start").map((e) => e.at);
    const firstEnd = launcher.events.find((e) => e.kind === "end")!.at;
    assert.equal(starts.length, 3);
    assert.ok(starts.every((at) => at < firstEnd), `not all three were running at once: ${JSON.stringify(launcher.events)}`);
  } finally {
    r.dispose();
  }
});

// --------------------------------------- criterion 3: the parent walk links

test("criterion 3: every spawn appends a child line naming the child's walk, c1, c2, … with no w id", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher();
    const t = tool(r, launcher);
    const outs = [
      await run(t, { model: "senses", task: "a" }),
      await run(t, { model: "worker", task: "b" }),
    ];
    const lines = childLines(r.walk.walkPath);
    assert.deepEqual(
      lines.map((l) => l.id),
      ["c1", "c2"],
    );
    for (const [i, line] of lines.entries()) {
      const env = launcher.specs[i]!.env;
      assert.equal(line.child_model, env.ASSOCIATE_MODEL);
      assert.equal(line.child_session_id, env.ASSOCIATE_SESSION_ID);
      assert.equal(line.child_walk, join(env.ASSOCIATE_EXPORT_ROOT!, env.ASSOCIATE_SESSION_ID!, "export", WALK_FILENAME));
      assert.equal(outs[i].child_walk, line.child_walk, "the tool result names the same walk path");
      assert.equal(typeof line.ts, "string");
    }
    // Child lines take no walk id and are not tool calls.
    assert.equal(r.walk.entryCount, 0);
    assert.equal(r.walk.finalize()!.tool_calls, 0);
    // Children live under the parent's session root, outside the checkout.
    assert.ok(lines[0].child_walk.startsWith(r.ctx.session.sessionRoot));
    assert.ok(!lines[0].child_walk.startsWith(r.checkout));
  } finally {
    r.dispose();
  }
});

test("criterion 3: a failed or timed-out child is still linked", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher((spec) =>
      spec.env.ASSOCIATE_MODEL === "worker"
        ? { outcome: { exitCode: null, timedOut: true } }
        : { outcome: { exitCode: 3, stderrTail: "boom" }, lines: () => [] },
    );
    const t = tool(r, launcher);
    await run(t, { model: "worker", task: "a" });
    await run(t, { model: "senses", task: "b" });
    assert.equal(childLines(r.walk.walkPath).length, 2);
  } finally {
    r.dispose();
  }
});

test("criterion 3: a child line that cannot be written means the child is never launched", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher();
    const t = tool(r, launcher, {
      recordChild: () => {
        throw new Error("disk full");
      },
    });
    const out = await run(t, { model: "senses", task: "a" });
    assert.equal(out.ok, false);
    assert.equal(out.code, "walk_unavailable");
    assert.equal(launcher.specs.length, 0);
  } finally {
    r.dispose();
  }
});

test("criterion 3: child lines validate against the contract walk schema ($defs/child)", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher();
    const t = tool(r, launcher);
    await run(t, { model: "senses", task: "a" });
    await run(t, { model: "worker", task: "b" });
    const lines = childLines(r.walk.walkPath);
    const script =
      "import json,sys\n" +
      "from associate import contract\n" +
      "from associate.contract import validate\n" +
      "s = contract.walk_child_schema()\n" +
      "print(json.dumps([validate.validate(e, s) for e in json.loads(sys.argv[1])]))";
    let out: string;
    try {
      out = execFileSync("uv", ["run", "python", "-c", script, JSON.stringify(lines)], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      if (/ENOENT/.test(String(error))) {
        console.log("SKIP child schema conformance: uv not on PATH");
        return;
      }
      throw error;
    }
    assert.deepEqual(JSON.parse(out.trim()), [[], []]);
  } finally {
    r.dispose();
  }
});

test("criterion 3: the recorded child walk is where the child's export actually lands", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher();
    await run(tool(r, launcher), { model: "worker", task: "a" });
    const childEnv = launcher.specs[0]!.env;
    const recorded = childLines(r.walk.walkPath)[0].child_walk;
    const { pi, cleanup } = await loadExtension({ ...childEnv });
    try {
      const report = JSON.parse((await pi.tool("associate_ready").execute("r", {})).content[0]!.text);
      assert.equal(report.model, "worker");
      assert.equal(report.session.walk_path, recorded);
    } finally {
      cleanup();
    }
  } finally {
    r.dispose();
  }
});

// ---------------------------------------- the hand-back and failure shapes

test("the tool returns the child's finish payload and final text, with its walk path", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher();
    const out = await run(tool(r, launcher), { model: "senses", task: "a" });
    assert.equal(out.ok, true);
    assert.deepEqual(out.handback, { summary: "done by senses", statements: [] });
    assert.equal(out.final_text, "final reply from senses");
    assert.equal(out.truncated, false);
    assert.equal(out.exit_code, 0);
    assert.equal(typeof out.child_walk, "string");
  } finally {
    r.dispose();
  }
});

test("the hand-back is bounded by the contract's budgets.spawn.max_output_chars and redacted", async () => {
  const budget = (CONTRACT.policy.budgets as any).spawn.max_output_chars as number;
  assert.ok(budget > 0);
  const r = rig();
  try {
    const big = "x".repeat(budget * 2);
    const launcher = fakeLauncher({
      lines: () => [
        finishLine({ summary: big }),
        assistantLine(`token: Authorization: Bearer sk-live-AAAABBBBCCCCDDDDEEEE ${big}`),
      ],
    });
    const out = await run(tool(r, launcher), { model: "senses", task: "a" });
    assert.equal(out.ok, true);
    assert.equal(out.truncated, true);
    const size = JSON.stringify(out.handback ?? "").length + (out.handback_text ?? "").length + (out.final_text ?? "").length;
    assert.ok(size <= budget + 64, `returned ${size} chars over a ${budget} budget`);
    assert.ok(!JSON.stringify(out).includes("sk-live-AAAABBBBCCCCDDDDEEEE"));
  } finally {
    r.dispose();
  }
});

test("a child with no finish still returns its final text, handback null", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher({ lines: () => ["not json", assistantLine("only text")] });
    const out = await run(tool(r, launcher), { model: "senses", task: "a" });
    assert.equal(out.ok, true);
    assert.equal(out.handback, null);
    assert.equal(out.final_text, "only text");
  } finally {
    r.dispose();
  }
});

test("failures are structured errors carrying the child walk, never a crash", async () => {
  const cases: Array<[Script, string]> = [
    [{ outcome: { exitCode: 2, stderrTail: "provider said no" }, lines: () => [] }, "child_failed"],
    [{ outcome: { exitCode: null, timedOut: true } }, "child_timeout"],
    [{ outcome: { exitCode: null, aborted: true } }, "child_aborted"],
    [{ outcome: { exitCode: null, error: "spawn EACCES" } }, "child_failed"],
    [{ throws: true }, "child_failed"],
    [{ lines: () => [assistantLine("", { stopReason: "error", errorMessage: "429 overloaded" })] }, "child_failed"],
  ];
  for (const [script, code] of cases) {
    const r = rig();
    try {
      const out = await run(tool(r, fakeLauncher(script)), { model: "senses", task: "a" });
      assert.equal(out.ok, false, JSON.stringify(script));
      assert.equal(out.code, code, JSON.stringify(out));
      assert.equal(typeof out.detail.child_walk, "string");
    } finally {
      r.dispose();
    }
  }
});

test("pi missing from PATH is a structured error and no child line", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher();
    const out = await run(tool(r, launcher, { which: () => null }), { model: "senses", task: "a" });
    assert.equal(out.ok, false);
    assert.equal(out.code, "tool_missing");
    assert.equal(launcher.specs.length, 0);
    assert.deepEqual(childLines(r.walk.walkPath), []);
  } finally {
    r.dispose();
  }
});

test("an already-aborted call launches nothing", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher();
    const controller = new AbortController();
    controller.abort();
    const out = await run(tool(r, launcher), { model: "worker", task: "a" }, controller.signal);
    assert.equal(out.code, "child_aborted");
    assert.equal(launcher.specs.length, 0);
  } finally {
    r.dispose();
  }
});

// ------------------------------------------- the real default launcher

test("defaultLauncher streams lines, reports the exit code, and kills on timeout", async () => {
  const lines: string[] = [];
  const ok = await defaultLauncher(
    {
      file: process.execPath,
      args: ["-e", "console.log(JSON.stringify({a:1}));process.stdout.write('{\"b\":2}');console.error('warn');process.exit(4)"],
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 10_000,
    },
    (line) => lines.push(line),
  );
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  assert.equal(ok.exitCode, 4);
  assert.equal(ok.timedOut, false);
  assert.match(ok.stderrTail, /warn/);

  const started = Date.now();
  const slow = await defaultLauncher(
    { file: process.execPath, args: ["-e", "setTimeout(()=>{}, 60000)"], cwd: tmpdir(), env: {}, timeoutMs: 200 },
    () => undefined,
  );
  assert.equal(slow.timedOut, true);
  assert.ok(Date.now() - started < 10_000);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const aborted = await defaultLauncher(
    { file: process.execPath, args: ["-e", "setTimeout(()=>{}, 60000)"], cwd: tmpdir(), env: {}, timeoutMs: 30_000, signal: controller.signal },
    () => undefined,
  );
  assert.equal(aborted.aborted, true);

  const missing = await defaultLauncher(
    { file: "/nonexistent/pi", args: [], cwd: tmpdir(), env: {}, timeoutMs: 1000 },
    () => undefined,
  );
  assert.equal(typeof missing.error, "string");
});

// --------------------------------------------- only cortex is offered it

for (const model of ["worker", "senses", "cortex"]) {
  test(`only cortex is offered spawn_subagent (${model})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "associate-t16-ext-"));
    mkdirSync(join(root, "checkout"));
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("no network in tests");
    }) as typeof fetch;
    const { pi, cleanup } = await loadExtension({
      ASSOCIATE_EXPORT_ROOT: join(root, "runs"),
      ASSOCIATE_CHECKOUT_ROOT: join(root, "checkout"),
      ASSOCIATE_SESSION_ID: `t16-offer-${model}`,
      ASSOCIATE_MODEL: model,
      ASSOCIATE_CONTRACT_DIR: CONTRACT_DIR,
    });
    try {
      await pi.fireSessionStart();
      assert.ok(pi.toolNames().includes(SPAWN_TOOL_NAME), "the tool is registered");
      const offered = pi.getActiveTools().includes(SPAWN_TOOL_NAME);
      assert.equal(offered, model === "cortex");
      const decision = (await pi.fireToolCall({
        type: "tool_call",
        toolName: SPAWN_TOOL_NAME,
        toolCallId: "s1",
        input: { model: "senses", task: "x" },
      })) as any;
      if (model === "cortex") {
        assert.equal(decision, undefined, "cortex's spawn is not blocked by the guard");
        assert.equal(fetches, 0, "spawn_subagent itself is not gated: each child gates its own calls");
      } else {
        assert.ok(decision?.block, `${model} was not refused spawn_subagent`);
      }
    } finally {
      globalThis.fetch = originalFetch;
      cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
