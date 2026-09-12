/**
 * The allowlisted shell override (spec c20/c35, honesty h27/h28).
 *
 * Three acceptance criteria are settled here:
 *
 *  1. `echo x > f`, `tee f`, `sed -i`, `git commit`, `git push` and `rm` are
 *     each refused with a structured error, while `git log`, `git diff`, `rg`,
 *     `fd` and `code-lens profile` are accepted;
 *  2. the startup tool list carries exactly one tool named `bash`, and it is
 *     this extension's — asserted through the real loader;
 *  3. the spawn call receives an argv *array* and never a shell string
 *     (h28: no code path reaches /bin/sh with model-supplied text).
 *
 * Criterion 3 is why `makeShellExecute` takes its spawn function as a
 * parameter: the test asserts the exact call rather than inferring it from an
 * observed side effect.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssociateContext } from "../lib/runtime.ts";
import type { AssociateContext } from "../lib/context.ts";
import { FakePi } from "./load-extension.ts";
import { loadExtension } from "./load-extension.ts";
import {
  SHELL_TOOL_LABEL,
  SHELL_TOOL_NAME,
  makeShellExecute,
  refuseArgv,
  register,
  shellRules,
  type SpawnFn,
} from "../tools/shell.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Ctx {
  ctx: AssociateContext;
  checkout: string;
  dispose: () => void;
}

function testContext(): Ctx {
  const exportRoot = mkdtempSync(join(tmpdir(), "associate-runs-"));
  const checkout = mkdtempSync(join(tmpdir(), "associate-checkout-"));
  const ctx = createAssociateContext({
    checkoutRoot: checkout,
    env: {
      ASSOCIATE_EXPORT_ROOT: exportRoot,
      ASSOCIATE_CHECKOUT_ROOT: checkout,
      ASSOCIATE_SESSION_ID: "shell-unit",
    },
    create: true,
  });
  return {
    ctx,
    checkout,
    dispose: () => {
      rmSync(exportRoot, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    },
  };
}

interface SpawnRecord {
  file: string;
  args: string[];
  options: Record<string, unknown>;
}

/** A spawn stand-in that records its call and replays a scripted result. */
function fakeSpawn(script: { stdout?: string; stderr?: string; code?: number; error?: Error } = {}): {
  fn: SpawnFn;
  calls: SpawnRecord[];
} {
  const calls: SpawnRecord[] = [];
  const fn: SpawnFn = (file, args, options) => {
    calls.push({ file, args: [...args], options: options as unknown as Record<string, unknown> });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (script.error) {
        child.emit("error", script.error);
        return;
      }
      if (script.stdout) child.stdout.emit("data", Buffer.from(script.stdout, "utf8"));
      if (script.stderr) child.stderr.emit("data", Buffer.from(script.stderr, "utf8"));
      child.emit("close", script.code ?? 0, null);
    });
    return child as never;
  };
  return { fn, calls };
}

type Details = Record<string, any>;

async function run(
  ctx: AssociateContext,
  params: Record<string, unknown>,
  spawn?: SpawnFn,
): Promise<Details> {
  const execute = makeShellExecute(ctx, { spawn: spawn ?? fakeSpawn().fn });
  const result = await execute("call-1", params);
  const parsed = JSON.parse(result.content[0]!.text) as Details;
  assert.deepEqual(parsed, result.details, "content and details must carry the same record");
  return result.details as Details;
}

// ---------------------------------------------------------------------------
// The policy is read from the contract, never from a literal here
// ---------------------------------------------------------------------------

test("the rules come from policy.shell, not from TypeScript", () => {
  const t = testContext();
  try {
    const rules = shellRules(t.ctx.policy);
    assert.equal(rules.argvOnly, true);
    assert.equal(rules.refuseRedirection, true);
    assert.equal(rules.refusePipes, true);
    assert.deepEqual(rules.allowlist.get("git"), ["log", "diff", "show", "status", "blame"]);
    assert.deepEqual(rules.allowlist.get("rg"), []);
    assert.equal(rules.allowlist.has("rm"), false);
  } finally {
    t.dispose();
  }
});

// ---------------------------------------------------------------------------
// Criterion 1 — refusals
// ---------------------------------------------------------------------------

const REFUSED: Array<{ name: string; argv: string[]; field: string; match: RegExp }> = [
  { name: "echo x > f", argv: ["echo", "x", ">", "f"], field: "argv[2]", match: /redirection/i },
  { name: "echo x >f", argv: ["echo", "x", ">f"], field: "argv[2]", match: /redirection/i },
  { name: "cmd 2> log", argv: ["rg", "x", "2>", "log"], field: "argv[2]", match: /redirection/i },
  { name: "cmd >> log", argv: ["rg", "x", ">>", "log"], field: "argv[2]", match: /redirection/i },
  { name: "a | b", argv: ["rg", "x", "|", "tee", "f"], field: "argv[2]", match: /pipe|separator/i },
  { name: "a && b", argv: ["rg", "x", "&&", "rm", "f"], field: "argv[2]", match: /pipe|separator/i },
  { name: "a ; b", argv: ["rg", "x", ";", "rm", "f"], field: "argv[2]", match: /pipe|separator/i },
  { name: "tee f", argv: ["tee", "f"], field: "argv[0]", match: /allowlist/i },
  { name: "sed -i", argv: ["sed", "-i", "s/a/b/", "f"], field: "argv[0]", match: /allowlist/i },
  { name: "rm -rf .", argv: ["rm", "-rf", "."], field: "argv[0]", match: /allowlist/i },
  { name: "git commit", argv: ["git", "commit", "-m", "x"], field: "argv[1]", match: /subcommand/i },
  { name: "git push", argv: ["git", "push"], field: "argv[1]", match: /subcommand/i },
];

for (const c of REFUSED) {
  test(`refused: ${c.name}`, () => {
    const t = testContext();
    try {
      const refusal = refuseArgv(c.argv, t.ctx.policy);
      assert.ok(refusal, `${c.name} must be refused`);
      assert.equal(refusal!.ok, false);
      assert.equal(refusal!.code, "shell_refused");
      assert.equal(refusal!.field, c.field, `field must name the offending token (${c.name})`);
      assert.match(refusal!.message, c.match);
      // The offending token itself is named, so the model can correct itself.
      const index = Number(c.field.slice(c.field.indexOf("[") + 1, -1));
      assert.ok(
        refusal!.message.includes(c.argv[index]!),
        `message must quote the offending token: ${refusal!.message}`,
      );
    } finally {
      t.dispose();
    }
  });
}

const ALLOWED: Array<{ name: string; argv: string[] }> = [
  { name: "git log", argv: ["git", "log", "--oneline", "-n", "5"] },
  { name: "git diff", argv: ["git", "diff", "--stat"] },
  { name: "rg", argv: ["rg", "-n", "def hello", "."] },
  { name: "rg with an alternation pattern", argv: ["rg", "foo|bar"] },
  { name: "fd", argv: ["fd", "-e", "py"] },
  { name: "code-lens profile", argv: ["code-lens", "profile", "."] },
  { name: "webglass search", argv: ["webglass", "search", "pi extensions"] },
];

for (const c of ALLOWED) {
  test(`allowed: ${c.name}`, () => {
    const t = testContext();
    try {
      assert.equal(refuseArgv(c.argv, t.ctx.policy), null, `${c.name} must be accepted`);
    } finally {
      t.dispose();
    }
  });
}

test("a command string with spaces in argv[0] is refused — nothing is ever shell-parsed", () => {
  const t = testContext();
  try {
    const refusal = refuseArgv(["git log --oneline"], t.ctx.policy);
    assert.ok(refusal);
    assert.equal(refusal!.field, "argv[0]");
    assert.match(refusal!.message, /argv/i);
  } finally {
    t.dispose();
  }
});

test("an empty argv is refused before anything is spawned", async () => {
  const t = testContext();
  try {
    const spawn = fakeSpawn();
    const details = await run(t.ctx, { argv: [] }, spawn.fn);
    assert.equal(details.ok, false);
    assert.equal(details.field, "argv");
    assert.equal(spawn.calls.length, 0, "nothing may be spawned for a refused call");
  } finally {
    t.dispose();
  }
});

test("a bash-style { command } argument set gets a corrective error naming argv", async () => {
  const t = testContext();
  try {
    const spawn = fakeSpawn();
    const details = await run(t.ctx, { command: "git log --oneline" }, spawn.fn);
    assert.equal(details.ok, false);
    assert.equal(details.field, "argv");
    assert.match(details.message, /argv/);
    assert.match(details.message, /\["<executable>"/, "the corrective message shows the argv form");
    assert.equal(spawn.calls.length, 0);
  } finally {
    t.dispose();
  }
});

test("a non-string argv element is refused by in-tool schema validation", async () => {
  const t = testContext();
  try {
    const details = await run(t.ctx, { argv: ["git", 7] });
    assert.equal(details.ok, false);
    assert.equal(details.field, "argv[1]");
  } finally {
    t.dispose();
  }
});

// ---------------------------------------------------------------------------
// Criterion 3 — the spawn call
// ---------------------------------------------------------------------------

test("the spawn call receives an argv array and never a shell string", async () => {
  const t = testContext();
  try {
    const spawn = fakeSpawn({ stdout: "a1b2c3 fix\n" });
    const details = await run(t.ctx, { argv: ["git", "log", "--oneline", "-n", "1"] }, spawn.fn);

    assert.equal(spawn.calls.length, 1);
    const call = spawn.calls[0]!;
    assert.equal(call.file, "git");
    assert.deepEqual(call.args, ["log", "--oneline", "-n", "1"]);
    assert.equal(call.options.shell, false, "shell interpretation must be off");
    assert.equal(call.options.cwd, t.checkout);
    assert.equal(typeof call.file, "string");
    assert.ok(Array.isArray(call.args), "arguments must be an array, never one joined string");
    assert.ok(!call.file.includes(" "), "the executable is never a command line");

    assert.equal(details.ok, true);
    assert.equal(details.exit_code, 0);
    assert.equal(details.stdout, "a1b2c3 fix\n");
    assert.equal(details.stderr, "");
    assert.equal(details.truncated, false);
    // Visible for the walk (t9 records these from the tool events).
    assert.deepEqual(details.argv, ["git", "log", "--oneline", "-n", "1"]);
    assert.equal(details.cwd, t.checkout);
    assert.equal(typeof details.duration_ms, "number");
  } finally {
    t.dispose();
  }
});

test("a non-zero exit is reported as a result, not thrown", async () => {
  const t = testContext();
  try {
    const spawn = fakeSpawn({ stderr: "fatal: bad revision\n", code: 128 });
    const details = await run(t.ctx, { argv: ["git", "show", "nope"] }, spawn.fn);
    assert.equal(details.ok, true, "a failed command is still a completed tool call");
    assert.equal(details.exit_code, 128);
    assert.equal(details.stderr, "fatal: bad revision\n");
  } finally {
    t.dispose();
  }
});

test("a spawn failure becomes a structured error", async () => {
  const t = testContext();
  try {
    const spawn = fakeSpawn({ error: Object.assign(new Error("spawn fd ENOENT"), { code: "ENOENT" }) });
    const details = await run(t.ctx, { argv: ["fd", "-e", "py"] }, spawn.fn);
    assert.equal(details.ok, false);
    assert.equal(details.code, "shell_spawn_failed");
    assert.equal(details.field, "argv[0]");
    assert.match(details.message, /ENOENT/);
  } finally {
    t.dispose();
  }
});

test("stdout is bounded by policy.budgets.shell and the truncation is reported", async () => {
  const t = testContext();
  try {
    const budget = (t.ctx.policy.budgets as Record<string, any>).shell.max_output_chars as number;
    const spawn = fakeSpawn({ stdout: `${"x".repeat(budget * 2)}\n` });
    const details = await run(t.ctx, { argv: ["rg", "x"] }, spawn.fn);
    assert.equal(details.ok, true);
    assert.equal(details.truncated, true);
    assert.ok(details.stdout.length <= budget, `stdout must fit the budget, got ${details.stdout.length}`);
  } finally {
    t.dispose();
  }
});

// ---------------------------------------------------------------------------
// cwd confinement
// ---------------------------------------------------------------------------

test("a cwd outside the session root is refused", async () => {
  const t = testContext();
  try {
    const spawn = fakeSpawn();
    const details = await run(t.ctx, { argv: ["git", "status"], cwd: "../.." }, spawn.fn);
    assert.equal(details.ok, false);
    assert.equal(details.field, "cwd");
    assert.equal(spawn.calls.length, 0);
  } finally {
    t.dispose();
  }
});

test("a cwd inside the session root is passed through to spawn", async () => {
  const t = testContext();
  try {
    const spawn = fakeSpawn();
    const details = await run(t.ctx, { argv: ["git", "status"], cwd: "sub/dir" }, spawn.fn);
    assert.equal(details.ok, true);
    assert.equal(spawn.calls[0]!.options.cwd, join(t.checkout, "sub", "dir"));
  } finally {
    t.dispose();
  }
});

// ---------------------------------------------------------------------------
// Criterion 2 — exactly one tool named bash, and it is ours
// ---------------------------------------------------------------------------

test("the module registers exactly one tool, named bash, and declares no writer", async () => {
  const t = testContext();
  try {
    const pi = new FakePi();
    register(pi as never, t.ctx);
    assert.deepEqual(pi.toolNames(), [SHELL_TOOL_NAME]);
    assert.equal(SHELL_TOOL_NAME, "bash");
    // h27/c4: the override is the *safe* shell. It never declares itself a
    // writer — it declares the opposite, so the guard does not judge it by the
    // built-in name it overrides.
    assert.deepEqual(t.ctx.declaredWriters(), []);
    assert.deepEqual(t.ctx.declaredNonWriters(), [SHELL_TOOL_NAME]);
    assert.equal(t.ctx.contain.isWriter(SHELL_TOOL_NAME), false);
    // The description is built from the contract's allowlist, not a literal.
    assert.match(pi.tool("bash").description!, /code-lens/);
  } finally {
    t.dispose();
  }
});

test("the loaded extension's tool list carries exactly one bash and it is the override", async () => {
  const exportRoot = mkdtempSync(join(tmpdir(), "associate-runs-"));
  const checkout = mkdtempSync(join(tmpdir(), "associate-checkout-"));
  const loaded = await loadExtension({
    ASSOCIATE_EXPORT_ROOT: exportRoot,
    ASSOCIATE_CHECKOUT_ROOT: checkout,
    ASSOCIATE_SESSION_ID: "shell-loader",
  });
  try {
    const named = loaded.pi.tools.filter((tool) => tool.name === "bash");
    assert.equal(named.length, 1, `expected one bash, got ${loaded.pi.toolNames().join(", ")}`);
    assert.equal(named[0]!.label, SHELL_TOOL_LABEL, "the registered bash must be the extension's");

    // Under defaultTools: [] there is no built-in bash to compete with, so the
    // startup (active) tool list shows exactly one.
    assert.deepEqual(
      loaded.pi.getActiveTools().filter((name) => name === "bash"),
      ["bash"],
    );

    // The write guard lets the safe shell through — it blocks pi's built-in
    // bash as a path-less writer, and this is not that tool.
    const decision = await loaded.pi.fireToolCall({
      toolName: "bash",
      input: { argv: ["git", "log"] },
    });
    assert.equal(decision, undefined, "the guard must not block the extension's own shell");

    // And it behaves like the override: a mutating command is refused.
    const result = await named[0]!.execute("call-1", { argv: ["rm", "-rf", "/"] });
    const details = result.details as Details;
    assert.equal(details.ok, false);
    assert.equal(details.code, "shell_refused");
  } finally {
    loaded.cleanup();
    rmSync(exportRoot, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Path operands (security finding: "secret files become visible to agents")
//
// The allowlist says a command is read-only; it says nothing about WHAT it
// reads. These assert that an allowlisted command gets the same path boundary
// the `read` tool enforces — confinement plus the denylist and .gitignore.
// ---------------------------------------------------------------------------

function fixtureCheckout(): Ctx {
  const t = testContext();
  writeFileSync(join(t.checkout, "a.py"), "print('hi')\n", "utf8");
  writeFileSync(join(t.checkout, ".env"), "TOKEN=hunter2\n", "utf8");
  writeFileSync(join(t.checkout, "deploy.key"), "-----BEGIN PRIVATE KEY-----\n", "utf8");
  writeFileSync(join(t.checkout, ".gitignore"), "ignored/\n", "utf8");
  mkdirSync(join(t.checkout, "ignored"), { recursive: true });
  writeFileSync(join(t.checkout, "ignored", "notes.txt"), "local only\n", "utf8");
  return t;
}

const OPERAND_REFUSED: Array<{ name: string; argv: string[]; field: string; match: RegExp }> = [
  { name: "cat .env", argv: ["cat", ".env"], field: "argv[1]", match: /denylist/i },
  { name: "cat ./.env", argv: ["cat", "./.env"], field: "argv[1]", match: /denylist/i },
  { name: "cat deploy.key", argv: ["cat", "deploy.key"], field: "argv[1]", match: /denylist/i },
  { name: "head -n 5 .env", argv: ["head", "-n", "5", ".env"], field: "argv[3]", match: /denylist/i },
  {
    name: "cat ../../etc/passwd",
    argv: ["cat", "../../etc/passwd"],
    field: "argv[1]",
    match: /outside the checkout/i,
  },
  {
    name: "head /etc/passwd",
    argv: ["head", "/etc/passwd"],
    field: "argv[1]",
    match: /outside the checkout/i,
  },
  {
    name: "git log -- .env",
    argv: ["git", "log", "--", ".env"],
    field: "argv[3]",
    match: /denylist/i,
  },
  {
    name: "cat a gitignored file",
    argv: ["cat", "ignored/notes.txt"],
    field: "argv[1]",
    match: /gitignore/i,
  },
];

for (const c of OPERAND_REFUSED) {
  test(`operand refused: ${c.name}`, async () => {
    const t = fixtureCheckout();
    try {
      const spawn = fakeSpawn({ stdout: "SHOULD NEVER RUN" });
      const details = await run(t.ctx, { argv: c.argv }, spawn.fn);
      assert.equal(details.ok, false, `${c.name} must be refused`);
      assert.equal(details.code, "shell_refused");
      assert.equal(details.field, c.field);
      assert.match(details.message, c.match);
      assert.ok(details.message.includes(c.argv[Number(c.field.slice(5, -1))]!));
      assert.equal(spawn.calls.length, 0, "a refused command must never be spawned");
    } finally {
      t.dispose();
    }
  });
}

const OPERAND_ALLOWED: Array<{ name: string; argv: string[] }> = [
  { name: "cat a.py", argv: ["cat", "a.py"] },
  { name: "git log -- a.py", argv: ["git", "log", "--", "a.py"] },
  { name: "git log (no operand)", argv: ["git", "log", "--oneline"] },
  { name: "rg with a pattern that is not a path", argv: ["rg", "-n", "TOKEN", "a.py"] },
  { name: "rg with a pattern that looks like a path", argv: ["rg", "a.py/b", "."] },
  { name: "rg with an alternation pattern", argv: ["rg", "foo|bar", "a.py"] },
  { name: "ls the checkout", argv: ["ls", "."] },
  { name: "wc a.py", argv: ["wc", "-l", "a.py"] },
];

for (const c of OPERAND_ALLOWED) {
  test(`operand allowed: ${c.name}`, async () => {
    const t = fixtureCheckout();
    try {
      const spawn = fakeSpawn({ stdout: "ran\n" });
      const details = await run(t.ctx, { argv: c.argv }, spawn.fn);
      assert.equal(details.ok, true, `${c.name} must be allowed: ${details.message}`);
      assert.equal(spawn.calls.length, 1);
      assert.deepEqual(spawn.calls[0]!.args, c.argv.slice(1));
    } finally {
      t.dispose();
    }
  });
}

test("the subcommand slot is never mistaken for a path operand", async () => {
  const t = fixtureCheckout();
  try {
    // A file literally named `log` next to a `git log` call must not make the
    // subcommand keyword look like a path (and must not be checked as one).
    writeFileSync(join(t.checkout, "log"), "not a subcommand\n", "utf8");
    const spawn = fakeSpawn({ stdout: "ran\n" });
    const details = await run(t.ctx, { argv: ["git", "log"] }, spawn.fn);
    assert.equal(details.ok, true, details.message);
    assert.equal(spawn.calls.length, 1);
  } finally {
    t.dispose();
  }
});

test("an operand is judged from the cwd the command will actually run in", async () => {
  const t = fixtureCheckout();
  try {
    mkdirSync(join(t.checkout, "pkg"), { recursive: true });
    writeFileSync(join(t.checkout, "pkg", "mod.py"), "x = 1\n", "utf8");
    const ok = await run(t.ctx, { argv: ["cat", "mod.py"], cwd: "pkg" }, fakeSpawn().fn);
    assert.equal(ok.ok, true, ok.message);

    // …and the denylist still bites from a subdirectory.
    const spawn = fakeSpawn({ stdout: "SHOULD NEVER RUN" });
    const denied = await run(t.ctx, { argv: ["cat", "../.env"], cwd: "pkg" }, spawn.fn);
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "shell_refused");
    assert.equal(spawn.calls.length, 0);
  } finally {
    t.dispose();
  }
});

test("a symlink out of the checkout is judged by where it lands", async () => {
  const t = fixtureCheckout();
  try {
    symlinkSync("/etc/passwd", join(t.checkout, "innocent.txt"));
    const spawn = fakeSpawn({ stdout: "SHOULD NEVER RUN" });
    const details = await run(t.ctx, { argv: ["cat", "innocent.txt"] }, spawn.fn);
    assert.equal(details.ok, false, "a symlink out of the checkout must be refused");
    assert.equal(details.code, "shell_refused");
    assert.equal(spawn.calls.length, 0);
  } finally {
    t.dispose();
  }
});
