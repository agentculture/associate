/**
 * `delegate_run` / `delegate_status` — the read-only resident hands a writing
 * task to a separate `associate run` (deviation d18).
 *
 * No test here starts a real associate run, pi or a model. The tools take an
 * injectable detached launcher; the fake below records the argv/env/cwd the
 * run would get and lets a test decide when (and how) it ends by writing the
 * files a real `associate run --json` would leave. Three tests go further on
 * purpose: one runs the real default launcher against `node -e` (not
 * associate) to cover the detached process plumbing, one runs the in-tree
 * interpreter exactly as the tool would to prove it imports THIS tree's
 * `associate` package and not one from PATH, and one round-trips the
 * test-command quoting through Python's own `shlex.split`.
 *
 * The gate wiring (the start call reaching CLEF with its effect line) is
 * covered through the real extension in `toolcall.test.ts`, and the taint
 * rule in `eidetic.test.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepoContractDir, loadContract } from "../lib/contract.ts";
import { associateRoot, extensionDir } from "../lib/paths.ts";
import { createAssociateContext } from "../lib/runtime.ts";
import { WalkRecorder } from "../lib/walk.ts";
import { whichOnPath } from "../tools/_procs.ts";
import {
  createDelegateTools,
  defaultDetachedLauncher,
  delegateEnvironment,
  inTreeCli,
  shellQuote,
  DELEGATE_RUN_TOOL,
  DELEGATE_STATUS_TOOL,
  RECORD_FILE,
  RESULT_FILE,
  RUN_ID_PATTERN,
  STDERR_FILE,
  type DetachedExit,
  type DetachedLauncher,
  type DetachedSpec,
} from "../tools/delegate.ts";

const CONTRACT = loadContract({});
const CONTRACT_DIR = findRepoContractDir()!;
const POLICY_TIMEOUT_MS = (CONTRACT.policy.budgets as any).delegate.timeout_ms as number;

/** The operator's commands, one with a quote and a space to exercise the quoting. */
const OPERATOR_COMMANDS = [
  ["uv", "run", "pytest", "-q"],
  ["bash", "-c", "echo it's fine"],
];

// ------------------------------------------------------------------ fixtures

interface Rig {
  root: string;
  checkout: string;
  tree: string;
  walk: WalkRecorder;
  ctx: ReturnType<typeof createAssociateContext>;
  env: Record<string, string | undefined>;
  dispose(): void;
}

function rig(
  model = "senses",
  extraEnv: Record<string, string | undefined> = {},
  options: { git?: boolean; venv?: boolean; mainPy?: boolean } = {},
): Rig {
  const root = mkdtempSync(join(tmpdir(), "associate-d18-"));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  if (options.git !== false) mkdirSync(join(checkout, ".git"));
  // A fake associate tree: the package entry point and (by default) a venv interpreter.
  const tree = join(root, "tree");
  mkdirSync(join(tree, "associate"), { recursive: true });
  if (options.mainPy !== false) writeFileSync(join(tree, "associate", "__main__.py"), "# fake\n");
  if (options.venv !== false) {
    mkdirSync(join(tree, ".venv", "bin"), { recursive: true });
    writeFileSync(join(tree, ".venv", "bin", "python"), "#!/bin/sh\n");
  }
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    ASSOCIATE_EXPORT_ROOT: join(root, "runs"),
    ASSOCIATE_SESSION_ID: `resident-${model}`,
    ASSOCIATE_CHECKOUT_ROOT: checkout,
    ASSOCIATE_CONTRACT_DIR: CONTRACT_DIR,
    ASSOCIATE_MODEL: model,
    ASSOCIATE_BASE_URL: "http://lane.invalid:9/v1",
    ASSOCIATE_API_KEY: "dummy-d18-key",
    ASSOCIATE_TEST_COMMANDS: JSON.stringify(OPERATOR_COMMANDS),
    PI_ACP_SESSION_ID: "acp-parent-session",
    ...extraEnv,
  };
  const ctx = createAssociateContext({ env, checkoutRoot: checkout });
  const walk = new WalkRecorder({ exportDir: ctx.session.exportDir, policy: ctx.policy, installExitHook: false });
  return { root, checkout, tree, walk, ctx, env, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

interface FakeRun {
  spec: DetachedSpec;
  /** End the run: write what associate run would leave, then report the exit. */
  end(exit: Partial<DetachedExit>, files?: { stdout?: string; stderr?: string }): Promise<void>;
}

interface FakeLauncher {
  launch: DetachedLauncher;
  runs: FakeRun[];
}

function fakeLauncher(): FakeLauncher {
  const runs: FakeRun[] = [];
  const launch: DetachedLauncher = (spec) => {
    // Like the real launcher: both files exist (empty) once the run starts.
    writeFileSync(spec.stdoutPath, "");
    writeFileSync(spec.stderrPath, "");
    let resolveExit!: (exit: DetachedExit) => void;
    const exited = new Promise<DetachedExit>((r) => (resolveExit = r));
    runs.push({
      spec,
      async end(exit, files = {}) {
        if (files.stdout !== undefined) writeFileSync(spec.stdoutPath, files.stdout);
        if (files.stderr !== undefined) writeFileSync(spec.stderrPath, files.stderr);
        resolveExit({ exitCode: 0, signal: null, ...exit });
        await new Promise((r) => setImmediate(r));
      },
    });
    return { pid: 424242, exited };
  };
  return { launch, runs };
}

const whichCalls: string[] = [];
/** A PATH lookup that would find a PATH `associate` and a PATH python3 — the tool must never use the former. */
function fakeWhich(name: string): string | null {
  whichCalls.push(name);
  if (name === "associate") return "/fake/bin/associate";
  if (name === "python3") return "/fake/bin/python3";
  return null;
}

function tools(r: Rig, launcher: FakeLauncher, extra: Parameters<typeof createDelegateTools>[1] = {}) {
  return createDelegateTools(r.ctx, {
    env: r.env,
    launch: launcher.launch,
    which: fakeWhich,
    recordChild: (link) => r.walk.recordChild(link),
    associateRoot: r.tree,
    isAlive: () => false,
    ...extra,
  });
}

async function call(t: { execute: (id: string, p: Record<string, unknown>) => Promise<any> }, params: Record<string, unknown>) {
  return (await t.execute("tc", params)).details as any;
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

/** The value following `flag` in argv (first occurrence). */
function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function flagValues(args: string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((arg, index) => {
    if (arg === flag) out.push(args[index + 1]!);
  });
  return out;
}

/** What a finished `associate run --json` prints (the fields delegate_status hands back). */
function runResult(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    walk_path: "/x/export/walk.jsonl",
    export_dir: "/x/export",
    outcome: "ok",
    session_id: "dlg-x",
    isolation: "worktree",
    merge: "merged",
    merge_reason: null,
    worktree: "/x/.worktrees.checkout/run-dlg-x",
    run_branch: "associate-run/dlg-x",
    tests: { passed: true, commands: [] },
    final_reply: "I changed the file.",
    stop_reason: "stop",
    ...overrides,
  });
}

const TASK = "Add a CHANGELOG line for the delegation tools";

// ----------------------------------------------------- who holds the tools

test("d18: senses holds delegate_run and delegate_status; worker, cortex and super-vl do not", () => {
  const models = CONTRACT.models.models;
  for (const name of [DELEGATE_RUN_TOOL, DELEGATE_STATUS_TOOL]) {
    assert.ok(CONTRACT.models.tool_names.includes(name), `${name} in tool_names`);
    assert.ok(models.senses!.tools.includes(name), `senses holds ${name}`);
    for (const other of ["worker", "cortex", "super-vl"]) assert.ok(!models[other]!.tools.includes(name), `${other} holds ${name}`);
  }
  assert.deepEqual([...(models.senses!.may_delegate ?? [])], ["worker"]);
  for (const other of ["worker", "cortex", "super-vl"]) assert.deepEqual([...(models[other]!.may_delegate ?? [])], []);
  // Gated for every model (d6/d7 pattern), never a repo mutation; status is a plain read.
  assert.ok(CONTRACT.models.gated_tools.includes(DELEGATE_RUN_TOOL));
  assert.ok(!CONTRACT.models.mutating_tools.includes(DELEGATE_RUN_TOOL));
  assert.ok(!CONTRACT.models.gated_tools.includes(DELEGATE_STATUS_TOOL));
  assert.ok(!CONTRACT.models.mutating_tools.includes(DELEGATE_STATUS_TOOL));
  // senses still may not mutate and holds no writer.
  assert.equal(models.senses!.may_mutate, false);
  for (const writer of ["write", "edit", "bash", "run_tests", "ledger_append"]) assert.ok(!models.senses!.tools.includes(writer), writer);
});

test("d18: the start tool's schema offers exactly the contract's may_delegate targets", () => {
  const r = rig();
  try {
    const t = tools(r, fakeLauncher());
    assert.deepEqual((t.run.parameters as any).properties.model.enum, ["worker"]);
    assert.deepEqual((t.run.parameters as any).required, ["model", "task"]);
    assert.deepEqual((t.status.parameters as any).required, ["run_id"]);
  } finally {
    r.dispose();
  }
});

// ------------------------------------------------- refusals before launch

for (const model of ["cortex", "senses", "super-vl", "nobody"]) {
  test(`d18: senses delegating to '${model}' is refused before anything is launched or linked`, async () => {
    const r = rig();
    try {
      const launcher = fakeLauncher();
      const out = await call(tools(r, launcher).run, { model, task: TASK });
      assert.equal(out.ok, false);
      assert.equal(out.code, "delegate_refused");
      assert.deepEqual(out.detail.allowed, ["worker"]);
      assert.equal(launcher.runs.length, 0);
      assert.deepEqual(childLines(r.walk.walkPath), []);
    } finally {
      r.dispose();
    }
  });
}

for (const parent of ["worker", "cortex"]) {
  test(`d18: a ${parent} session (may_delegate []) is refused every delegation, even if the call reaches execute`, async () => {
    const r = rig(parent);
    try {
      const launcher = fakeLauncher();
      const out = await call(tools(r, launcher).run, { model: "worker", task: TASK });
      assert.equal(out.code, "delegate_refused");
      assert.match(out.message, /may not delegate/);
      assert.equal(launcher.runs.length, 0);
    } finally {
      r.dispose();
    }
  });
}

test("d18: a malformed may_delegate (a target that may not mutate) refuses every delegation", async () => {
  const r = rig();
  try {
    const broken = structuredClone(r.ctx.contract.models) as any;
    broken.models.senses.may_delegate = ["cortex", "senses"];
    broken.models.cortex.may_mutate = false;
    const ctx = { ...r.ctx, contract: { ...r.ctx.contract, models: broken } } as typeof r.ctx;
    const launcher = fakeLauncher();
    const t = createDelegateTools(ctx, { env: r.env, launch: launcher.launch, which: fakeWhich, associateRoot: r.tree });
    const out = await call(t.run, { model: "cortex", task: TASK });
    assert.equal(out.code, "contract_incomplete");
    assert.match(out.message, /may not mutate/);
    assert.match(out.message, /names itself/);
    assert.equal(launcher.runs.length, 0);
  } finally {
    r.dispose();
  }
});

test("d18: bad arguments are refused: extra keys, an empty task, a non-string model", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher();
    const t = tools(r, launcher);
    assert.equal((await call(t.run, { model: "worker", task: TASK, test_command: "rm -rf /" })).code, "invalid_args");
    assert.equal((await call(t.run, { model: "worker", task: "  " })).code, "invalid_args");
    assert.equal((await call(t.run, { model: 1, task: TASK })).code, "invalid_args");
    assert.equal(launcher.runs.length, 0);
  } finally {
    r.dispose();
  }
});

test("d18: with no operator test command, or a malformed one, nothing is started", async () => {
  for (const [value, code] of [
    [undefined, "no_test_commands"],
    ["[]", "no_test_commands"],
    ["not json", "test_commands_malformed"],
    [JSON.stringify([[]]), "test_commands_malformed"],
  ] as const) {
    const r = rig("senses", { ASSOCIATE_TEST_COMMANDS: value });
    try {
      const launcher = fakeLauncher();
      const out = await call(tools(r, launcher).run, { model: "worker", task: TASK });
      assert.equal(out.code, code, String(value));
      assert.equal(launcher.runs.length, 0);
      assert.deepEqual(childLines(r.walk.walkPath), []);
    } finally {
      r.dispose();
    }
  }
});

test("d18: a checkout outside any git work tree is refused (no worktree, no merge check)", async () => {
  const r = rig("senses", {}, { git: false });
  try {
    const launcher = fakeLauncher();
    const out = await call(tools(r, launcher).run, { model: "worker", task: TASK });
    // The temp dir may itself sit under a git repo on some machines; only assert when it does not.
    if (out.code === "not_a_git_checkout") assert.equal(launcher.runs.length, 0);
    else assert.equal(out.ok, true, JSON.stringify(out));
  } finally {
    r.dispose();
  }
});

test("d18: an associate tree with no Python package is refused — the PATH associate is never the fallback", async () => {
  const r = rig("senses", {}, { mainPy: false });
  try {
    whichCalls.length = 0;
    const launcher = fakeLauncher();
    const out = await call(tools(r, launcher).run, { model: "worker", task: TASK });
    assert.equal(out.code, "tool_missing");
    assert.match(out.message, /never used/);
    assert.equal(launcher.runs.length, 0);
    assert.ok(!whichCalls.includes("associate"), "the tool looked the associate binary up on PATH");
  } finally {
    r.dispose();
  }
});

test("d18: the run is not started when its child line cannot be written to the walk", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher();
    const out = await call(
      tools(r, launcher, {
        recordChild: () => {
          throw new Error("disk full");
        },
      }).run,
      { model: "worker", task: TASK },
    );
    assert.equal(out.code, "walk_unavailable");
    assert.equal(launcher.runs.length, 0);
  } finally {
    r.dispose();
  }
});

// ------------------------------------------------------------- the launch

test("d18: the argv runs the in-tree CLI with exactly the operator's tests, the contract timeout and --untrusted-checkout", async () => {
  const r = rig();
  try {
    whichCalls.length = 0;
    const launcher = fakeLauncher();
    const out = await call(tools(r, launcher).run, { model: "worker", task: "--json is not a flag here" });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.match(out.run_id, RUN_ID_PATTERN);
    assert.equal(out.state, "started");
    assert.equal(launcher.runs.length, 1);
    const { spec } = launcher.runs[0]!;

    // The tree's interpreter, run as `-m associate` from the tree itself — never a PATH associate.
    assert.equal(spec.file, join(r.tree, ".venv", "bin", "python"));
    assert.deepEqual(spec.args.slice(0, 3), ["-m", "associate", "run"]);
    assert.equal(spec.cwd, r.tree);
    assert.equal(spec.env.PYTHONPATH, r.tree);
    assert.equal(spec.env.ASSOCIATE_EXTENSION_PATH, join(extensionDir, "index.ts"));
    assert.ok(!whichCalls.includes("associate"));
    assert.ok(!spec.file.endsWith("/associate"));

    const args = spec.args;
    assert.ok(args.includes("--json"));
    assert.equal(flagValue(args, "--model"), "worker");
    assert.equal(flagValue(args, "--checkout"), r.checkout);
    assert.equal(flagValue(args, "--export-root"), join(r.ctx.session.sessionRoot, "delegated"));
    assert.equal(flagValue(args, "--session-id"), out.run_id);
    assert.equal(Number(flagValue(args, "--timeout")), POLICY_TIMEOUT_MS / 1000);
    assert.equal(out.timeout_s, POLICY_TIMEOUT_MS / 1000);
    assert.ok(args.includes("--untrusted-checkout"), "ASSOCIATE_PI_TRUST unset reads as untrusted");
    assert.equal(out.untrusted_checkout, true);
    // Exactly the operator's commands, in order, each quoted for shlex.split.
    assert.deepEqual(flagValues(args, "--test-command"), OPERATOR_COMMANDS.map((c) => c.map(shellQuote).join(" ")));
    assert.equal(out.test_commands, OPERATOR_COMMANDS.length);
    // The task is last, after `--`, verbatim.
    assert.deepEqual(args.slice(-2), ["--", "--json is not a flag here"]);
    assert.equal(args.filter((a) => a === "--").length, 1);

    // stdout/stderr land in this session's own directory, never the checkout.
    const runDir = join(r.ctx.session.sessionRoot, "delegated", out.run_id);
    assert.equal(spec.stdoutPath, join(runDir, RESULT_FILE));
    assert.equal(spec.stderrPath, join(runDir, STDERR_FILE));
    assert.ok(!spec.stdoutPath.startsWith(r.checkout));
  } finally {
    r.dispose();
  }
});

test("d18: the delegated env keeps the lane key, drops per-session variables, and sets the tree", async () => {
  const r = rig("senses", {
    ASSOCIATE_RUN_DEADLINE: "1",
    ASSOCIATE_ISOLATION: "worktree",
    ASSOCIATE_EXTENSION_PATH: "/elsewhere/index.ts",
    PYTHONPATH: "/planted",
    PYTHONSAFEPATH: "1",
  });
  try {
    const launcher = fakeLauncher();
    await call(tools(r, launcher).run, { model: "worker", task: TASK });
    const { env } = launcher.runs[0]!.spec;
    assert.equal(env.ASSOCIATE_API_KEY, "dummy-d18-key", "the run needs the lane key");
    assert.equal(env.ASSOCIATE_BASE_URL, "http://lane.invalid:9/v1");
    for (const gone of [
      "ASSOCIATE_CHECKOUT_ROOT",
      "ASSOCIATE_SESSION_ID",
      "ASSOCIATE_EXPORT_ROOT",
      "ASSOCIATE_MODEL",
      "ASSOCIATE_TEST_COMMANDS",
      "ASSOCIATE_RUN_DEADLINE",
      "ASSOCIATE_ISOLATION",
      "ASSOCIATE_CONTRACT_DIR",
      "PI_ACP_SESSION_ID",
      "PYTHONSAFEPATH",
    ]) {
      assert.ok(!(gone in env), `${gone} reached the delegated run`);
    }
    assert.equal(env.PYTHONPATH, r.tree);
    assert.equal(env.ASSOCIATE_EXTENSION_PATH, join(extensionDir, "index.ts"));
    // Nothing that was not in the parent snapshot appears, beyond the two tree variables.
    for (const key of Object.keys(env)) {
      assert.ok(key in r.env || key === "PYTHONPATH" || key === "ASSOCIATE_EXTENSION_PATH", key);
    }
  } finally {
    r.dispose();
  }
});

for (const [trust, untrusted] of [
  ["approve", false],
  ["APPROVE", true],
  ["untrusted", true],
  ["", true],
] as const) {
  test(`d18: ASSOCIATE_PI_TRUST='${trust}' → --untrusted-checkout ${untrusted ? "passed" : "not passed"}`, async () => {
    const r = rig("senses", { ASSOCIATE_PI_TRUST: trust });
    try {
      const launcher = fakeLauncher();
      await call(tools(r, launcher).run, { model: "worker", task: TASK });
      assert.equal(launcher.runs[0]!.spec.args.includes("--untrusted-checkout"), untrusted);
    } finally {
      r.dispose();
    }
  });
}

test("d18: without a tree venv the interpreter is python3 from PATH, still running the tree's package", async () => {
  const r = rig("senses", {}, { venv: false });
  try {
    const launcher = fakeLauncher();
    await call(tools(r, launcher).run, { model: "worker", task: TASK });
    const { spec } = launcher.runs[0]!;
    assert.equal(spec.file, "/fake/bin/python3");
    assert.deepEqual(spec.args.slice(0, 2), ["-m", "associate"]);
    assert.equal(spec.cwd, r.tree);
    assert.equal(spec.env.PYTHONPATH, r.tree);
  } finally {
    r.dispose();
  }
});

test("d18: the in-tree interpreter, run as the tool runs it, imports THIS tree's associate, not a PATH one", (t) => {
  const cli = inTreeCli(associateRoot, process.env);
  if ("problem" in cli) {
    t.skip(cli.problem);
    return;
  }
  const bin = mkdtempSync(join(tmpdir(), "associate-d18-path-"));
  try {
    // A PATH associate that would announce itself if it were ever run.
    writeFileSync(join(bin, "associate"), "#!/bin/sh\necho PATH-ASSOCIATE\n");
    chmodSync(join(bin, "associate"), 0o755);
    const env = delegateEnvironment({ ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, PYTHONPATH: bin }, cli);
    const out = execFileSync(cli.file, ["-c", "import associate.cli, sys; print(associate.cli.__file__)"], {
      cwd: cli.cwd,
      env,
      encoding: "utf8",
    }).trim();
    assert.ok(out.startsWith(join(associateRoot, "associate")), `${out} is not under ${associateRoot}`);
    assert.notEqual(cli.file, join(bin, "associate"));
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("d18: each operator test command round-trips through Python's shlex.split unchanged", (t) => {
  const python = whichOnPath("python3", process.env);
  if (!python) {
    t.skip("python3 is not on PATH");
    return;
  }
  const commands = [...OPERATOR_COMMANDS, ["printf", "%s\n", "a b", "", "$HOME", "x'y\"z", "--flag=1"]];
  for (const command of commands) {
    const line = command.map(shellQuote).join(" ");
    const out = execFileSync(python, ["-c", "import json, shlex, sys; print(json.dumps(shlex.split(sys.argv[1])))", line], {
      encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(out), command);
  }
});

// --------------------------------------------------- concurrency and status

test("d18: a second start while one runs in the checkout is refused; after it ends a new one starts", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher();
    const t = tools(r, launcher);
    const first = await call(t.run, { model: "worker", task: TASK });
    assert.equal(first.ok, true);
    // A second instance of the tool (another session in the same process) shares the lock.
    const other = tools(r, launcher);
    const second = await call(other.run, { model: "worker", task: "another change" });
    assert.equal(second.code, "delegate_busy");
    assert.equal(second.detail.running_run_id, first.run_id);
    assert.equal(launcher.runs.length, 1);

    await launcher.runs[0]!.end({ exitCode: 0 }, { stdout: runResult() });
    const third = await call(t.run, { model: "worker", task: "a third change" });
    assert.equal(third.ok, true, JSON.stringify(third));
    assert.notEqual(third.run_id, first.run_id);
    await launcher.runs[1]!.end({ exitCode: 0 }, { stdout: runResult() });
  } finally {
    r.dispose();
  }
});

test("d18: status reports running, then the finished associate run --json result", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher();
    const t = tools(r, launcher);
    const started = await call(t.run, { model: "worker", task: TASK });

    const running = await call(t.status, { run_id: started.run_id });
    assert.equal(running.ok, true);
    assert.equal(running.state, "running");
    assert.equal(running.model, "worker");
    assert.equal(typeof running.elapsed_ms, "number");

    await launcher.runs[0]!.end(
      { exitCode: 0 },
      { stdout: runResult({ merge: "kept", merge_reason: "tests failed: uv run pytest -q exited 1", final_reply: "done; token=abcdef123456" }) },
    );
    const finished = await call(t.status, { run_id: started.run_id });
    assert.equal(finished.ok, true, JSON.stringify(finished));
    assert.equal(finished.state, "finished");
    assert.equal(finished.exit_code, 0);
    for (const key of ["outcome", "merge", "merge_reason", "worktree", "tests", "final_reply"]) {
      assert.ok(key in finished.result, `${key} missing from the result`);
    }
    assert.equal(finished.result.merge, "kept");
    assert.match(finished.result.merge_reason, /tests failed/);
    assert.ok(!finished.result.final_reply.includes("abcdef123456"), "the result is redacted");
    assert.equal(finished.truncated, false);

    // The record on disk says how it ended.
    const record = JSON.parse(readFileSync(join(r.ctx.session.sessionRoot, "delegated", started.run_id, RECORD_FILE), "utf8"));
    assert.equal(record.exit_code, 0);
    assert.equal(record.run_id, started.run_id);
  } finally {
    r.dispose();
  }
});

test("d18: a run that fails reports a structured error with the CLI's own error object", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher();
    const t = tools(r, launcher);
    const started = await call(t.run, { model: "worker", task: TASK });
    await launcher.runs[0]!.end(
      { exitCode: 2 },
      {
        stderr:
          "associate: run worktree /x on branch associate-run/dlg\n" +
          `${JSON.stringify({ code: 2, message: "pi is not on PATH", remediation: "install pi" })}\n`,
      },
    );
    const out = await call(t.status, { run_id: started.run_id });
    assert.equal(out.ok, false);
    assert.equal(out.code, "delegate_failed");
    assert.equal(out.detail.state, "failed");
    assert.equal(out.detail.exit_code, 2);
    assert.equal(out.detail.cli_error.message, "pi is not on PATH");
    assert.match(out.message, /exited with status 2: pi is not on PATH/);
  } finally {
    r.dispose();
  }
});

test("d18: status refuses an unknown or malformed run id (no path escapes)", async () => {
  const r = rig();
  try {
    const t = tools(r, fakeLauncher());
    assert.equal((await call(t.status, { run_id: "dlg-20261028T101500Z-0badc0de" })).code, "unknown_run");
    for (const bad of ["../../etc", "dlg-x/../..", "", 3]) {
      assert.equal((await call(t.status, { run_id: bad })).code, "invalid_args", String(bad));
    }
  } finally {
    r.dispose();
  }
});

test("d18: status after a restart reads the record on disk: running while the pid lives, then finished or lost", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher();
    const started = await call(tools(r, launcher).run, { model: "worker", task: TASK });
    const runDir = join(r.ctx.session.sessionRoot, "delegated", started.run_id);
    // A fresh process: no in-memory state, only the files. Its own module state is
    // simulated by a record with no exit fields and a tool instance that knows nothing.
    const record = JSON.parse(readFileSync(join(runDir, RECORD_FILE), "utf8"));
    assert.equal(record.pid, 424242);
    // Move the run to a sibling id, as another process would have left it.
    const orphanId = "dlg-20261028T101500Z-00c0ffee";
    const orphanDir = join(r.ctx.session.sessionRoot, "delegated", orphanId);
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, RECORD_FILE), JSON.stringify({ ...record, run_id: orphanId }));
    writeFileSync(join(orphanDir, RESULT_FILE), "");

    const alive = await call(tools(r, launcher, { isAlive: () => true }).status, { run_id: orphanId });
    assert.equal(alive.state, "running");
    const lost = await call(tools(r, launcher, { isAlive: () => false }).status, { run_id: orphanId });
    assert.equal(lost.code, "delegate_lost");
    writeFileSync(join(orphanDir, RESULT_FILE), runResult());
    const done = await call(tools(r, launcher, { isAlive: () => false }).status, { run_id: orphanId });
    assert.equal(done.state, "finished");
    assert.equal(done.result.merge, "merged");
    await launcher.runs[0]!.end({ exitCode: 0 }, { stdout: runResult() });
  } finally {
    r.dispose();
  }
});

test("d18: a result over the contract budget is cut, final reply first", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher();
    const t = tools(r, launcher);
    const started = await call(t.run, { model: "worker", task: TASK });
    const max = (CONTRACT.policy.budgets as any).delegate.max_output_chars as number;
    await launcher.runs[0]!.end({ exitCode: 0 }, { stdout: runResult({ final_reply: "y".repeat(max * 2) }) });
    const out = await call(t.status, { run_id: started.run_id });
    assert.equal(out.truncated, true);
    assert.ok(JSON.stringify(out.result).length <= max);
    assert.equal(out.result.merge, "merged");
  } finally {
    r.dispose();
  }
});

// ---------------------------------------------------------- the walk link

test("d18: each delegated run is a child line in the session walk naming the delegated walk", async () => {
  const r = rig();
  try {
    const launcher = fakeLauncher();
    const out = await call(tools(r, launcher).run, { model: "worker", task: TASK });
    const [line] = childLines(r.walk.walkPath);
    assert.equal(line.id, out.child_link);
    assert.equal(line.child_model, "worker");
    assert.equal(line.child_session_id, out.run_id);
    // Exactly where `associate run --export-root <root> --session-id <id>` writes its walk.
    assert.equal(line.child_walk, join(r.ctx.session.sessionRoot, "delegated", out.run_id, "export", "walk.jsonl"));
    assert.equal(out.child_walk, line.child_walk);
    await launcher.runs[0]!.end({ exitCode: 0 }, { stdout: runResult() });
  } finally {
    r.dispose();
  }
});

// ------------------------------------------------ the real detached launcher

test("d18: the default launcher detaches, writes stdout/stderr to files and reports the exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "associate-d18-launch-"));
  try {
    const run = defaultDetachedLauncher({
      file: process.execPath,
      args: ["-e", "process.stdout.write('{\"outcome\":\"ok\"}'); process.stderr.write('diag\\n'); process.exit(3)"],
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      stdoutPath: join(dir, "out"),
      stderrPath: join(dir, "err"),
    });
    assert.equal(typeof run.pid, "number");
    const exit = await run.exited;
    assert.equal(exit.exitCode, 3);
    assert.equal(readFileSync(join(dir, "out"), "utf8"), '{"outcome":"ok"}');
    assert.equal(readFileSync(join(dir, "err"), "utf8"), "diag\n");

    const missing = defaultDetachedLauncher({
      file: join(dir, "no-such-binary"),
      args: [],
      cwd: dir,
      env: {},
      stdoutPath: join(dir, "out2"),
      stderrPath: join(dir, "err2"),
    });
    const failed = await missing.exited;
    assert.equal(failed.exitCode, null);
    assert.match(failed.error ?? "", /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
