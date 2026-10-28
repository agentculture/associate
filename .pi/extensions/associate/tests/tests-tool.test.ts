/**
 * `run_tests` (deviation d12, part b): the operator-named test commands.
 *
 * Every test builds a throwaway git repository as the checkout and configures
 * tiny `node -e` commands (via `process.execPath`, so nothing depends on a
 * binary being on PATH) as the run's test commands.
 *
 *   1. no commands configured → a structured error, not a crash;
 *   2. index selection, run-all, an out-of-range index refused, model-supplied
 *      argv refused;
 *   3. a failing command reports its exit code; a hung one times out;
 *   4. the child environment carries no `ASSOCIATE_*` variable;
 *   5. what a test run changes in the checkout is reverted and listed, while
 *      the model's own uncommitted work survives byte for byte;
 *   6. malformed `ASSOCIATE_TEST_COMMANDS` never crashes load, and the value
 *      is snapshotted once at load.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepoContractDir, loadContract } from "../lib/contract.ts";
import { createAssociateContext } from "../lib/runtime.ts";
import { loadExtension } from "./load-extension.ts";
import {
  childEnvironment,
  createTestsTool,
  parsePorcelainZ,
  parseTestCommands,
  TEST_COMMANDS_ENV,
  TESTS_TOOL_NAME,
} from "../tools/tests.ts";

const NODE = process.execPath;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

interface Rig {
  checkout: string;
  root: string;
  dispose(): void;
}

/** A git checkout with three committed files and an ignore rule. */
function repo(withGit = true): Rig {
  const root = mkdtempSync(join(tmpdir(), "associate-d12-"));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  writeFileSync(join(checkout, "tracked.txt"), "original tracked\n");
  writeFileSync(join(checkout, "other.txt"), "original other\n");
  writeFileSync(join(checkout, "gone.txt"), "original gone\n");
  writeFileSync(join(checkout, ".gitignore"), "*.log\n");
  if (withGit) {
    git(checkout, "init", "-q");
    git(checkout, "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
    git(checkout, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  }
  return { checkout, root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function tool(r: Rig, commands: string[][] | string | undefined, extra: Record<string, unknown> = {}) {
  const raw = typeof commands === "string" || commands === undefined ? commands : JSON.stringify(commands);
  const ctx = createAssociateContext({
    checkoutRoot: r.checkout,
    contract: loadContract({}),
    env: { ASSOCIATE_EXPORT_ROOT: join(r.root, "runs"), ASSOCIATE_SESSION_ID: "d12-tests" },
  });
  const env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: process.env.HOME };
  if (raw !== undefined) env[TEST_COMMANDS_ENV] = raw;
  return createTestsTool(ctx, { env, log: () => {}, ...extra });
}

const js = (source: string) => [NODE, "-e", source];
const payload = (res: { details: unknown }) => res.details as any;

// ------------------------------------------------------------ the parser

test("parseTestCommands: a JSON array of non-empty argv arrays", () => {
  assert.deepEqual(parseTestCommands('[["uv","run","pytest","-q"],["bash","x.sh"]]').commands, [
    ["uv", "run", "pytest", "-q"],
    ["bash", "x.sh"],
  ]);
  for (const absent of [undefined, "", "  ", "[]"]) {
    const parsed = parseTestCommands(absent);
    assert.deepEqual(parsed.commands, []);
    assert.equal(parsed.problem, undefined, String(absent));
  }
  for (const bad of ["{nope", '{"a":1}', '["uv"]', "[[]]", '[["uv",""]]', '[["uv",1]]', '"uv run"']) {
    const parsed = parseTestCommands(bad);
    assert.deepEqual(parsed.commands, [], bad);
    assert.ok(parsed.problem, `${bad} must be reported as malformed`);
  }
});

// ------------------------------------------------------- the porcelain parser

test("parsePorcelainZ returns both sides of a rename or copy entry", () => {
  // Porcelain v1 with -z: "XY <to>\0<from>\0" — the destination comes first
  // and the source is the next NUL field (git-status(1), "-z").
  const out = Buffer.from(
    "M  tracked.txt\0R  new.txt\0old.txt\0C  dup.txt\0copy.txt\0 D gone.txt\0",
  );
  assert.deepEqual(parsePorcelainZ(out), [
    "tracked.txt",
    "new.txt",
    "old.txt",
    "dup.txt",
    "copy.txt",
    "gone.txt",
  ]);
});

test("parsePorcelainZ: a rename whose source field is missing still yields the target", () => {
  // An R/C entry's source path is the next NUL field; when it is absent the
  // target is still reported and nothing is pasted in from a later field.
  assert.deepEqual(parsePorcelainZ(Buffer.from("R  new.txt\0")), ["new.txt"]);
  assert.deepEqual(parsePorcelainZ(Buffer.from("R  new.txt\0old.txt\0 M other\0")), [
    "new.txt",
    "old.txt",
    "other",
  ]);
});

test("childEnvironment drops every ASSOCIATE_* variable and keeps the rest", () => {
  const env = childEnvironment({ ASSOCIATE_API_KEY: "k", ASSOCIATE_MODEL: "worker", PATH: "/bin", OTHER: "x" });
  assert.deepEqual(env, { PATH: "/bin", OTHER: "x" });
});

// ------------------------------------------------------- 1. no commands

test("no commands configured: a structured error naming the operator, not a crash", async () => {
  const r = repo();
  try {
    for (const configured of [undefined, "[]", "{malformed"]) {
      const res = await tool(r, configured).execute("c", {});
      const out = payload(res);
      assert.equal(out.ok, false);
      assert.equal(out.code, "no_test_commands");
      assert.match(out.message, /operator configured no test command/);
    }
  } finally {
    r.dispose();
  }
});

// ------------------------------------------------- 2. selection and argv

test("an index runs exactly that command; no index runs all, in order", async () => {
  const r = repo();
  try {
    const t = tool(r, [js("process.stdout.write('first')"), js("process.stdout.write('second')")]);
    const one = payload(await t.execute("c", { command: 1 }));
    assert.equal(one.ok, true);
    assert.equal(one.passed, true);
    assert.equal(one.results.length, 1);
    assert.equal(one.results[0].index, 1);
    assert.deepEqual(one.results[0].argv, js("process.stdout.write('second')"));
    assert.match(one.results[0].output_tail, /second/);

    const all = payload(await t.execute("c", {}));
    assert.deepEqual(all.results.map((x: any) => x.index), [0, 1]);
    assert.match(all.results[0].output_tail, /first/);
    for (const result of all.results) {
      assert.equal(result.exit_code, 0);
      assert.equal(result.timed_out, false);
      assert.equal(typeof result.duration_ms, "number");
    }
  } finally {
    r.dispose();
  }
});

test("an out-of-range or malformed index is refused and nothing runs", async () => {
  const r = repo();
  try {
    const marker = join(r.checkout, "ran.log");
    const t = tool(r, [js(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`)]);
    for (const params of [{ command: 1 }, { command: -1 }, { command: 0.5 }, { command: "0" }]) {
      const out = payload(await t.execute("c", params as Record<string, unknown>));
      assert.equal(out.ok, false, JSON.stringify(params));
      assert.equal(out.code, "invalid_args", JSON.stringify(params));
    }
    assert.equal(existsSync(marker), false);
  } finally {
    r.dispose();
  }
});

test("the model can never supply argv, flags or extra arguments", async () => {
  const r = repo();
  try {
    const t = tool(r, [js("process.stdout.write(JSON.stringify(process.argv.slice(1)))")]);
    for (const params of [{ argv: ["rm", "-rf", "/"] }, { command: 0, args: ["-k", "x"] }, { command: 0, flags: "-x" }]) {
      const out = payload(await t.execute("c", params as Record<string, unknown>));
      assert.equal(out.ok, false, JSON.stringify(params));
      assert.equal(out.code, "invalid_args");
    }
    const schema = t.parameters as { properties: Record<string, unknown> };
    assert.deepEqual(Object.keys(schema.properties), ["command"]);
  } finally {
    r.dispose();
  }
});

// --------------------------------------------- 3. failure and timeouts

test("a failing command reports its exit code and the run is not passed", async () => {
  const r = repo();
  try {
    const t = tool(r, [js("console.error('boom: 2 failed'); process.exit(3)"), js("process.exit(0)")]);
    const out = payload(await t.execute("c", {}));
    assert.equal(out.ok, true);
    assert.equal(out.passed, false);
    assert.equal(out.results[0].exit_code, 3);
    assert.match(out.results[0].output_tail, /boom: 2 failed/);
    assert.equal(out.results[1].exit_code, 0);
  } finally {
    r.dispose();
  }
});

test("a command that runs past the timeout is killed and reported timed out", async () => {
  const r = repo();
  try {
    const t = tool(r, [js("process.stdout.write('started'); setTimeout(() => {}, 30000)")], { timeoutMs: 400 });
    const started = Date.now();
    const out = payload(await t.execute("c", {}));
    assert.ok(Date.now() - started < 15000, "the timeout did not stop the command");
    assert.equal(out.passed, false);
    assert.equal(out.results[0].timed_out, true);
    assert.match(out.results[0].output_tail, /started/);
  } finally {
    r.dispose();
  }
});

test("a long output keeps only a bounded tail, and it is redacted", async () => {
  const r = repo();
  try {
    const budget = (loadContract({}).policy.budgets as any).shell.max_output_chars as number;
    const t = tool(r, [
      js(`process.stdout.write('HEAD-MARK' + 'x'.repeat(${budget * 2}) + ' token: abcdefsecretvalue TAIL-MARK')`),
    ]);
    const out = payload(await t.execute("c", {}));
    const tail: string = out.results[0].output_tail;
    assert.ok(tail.length <= budget, `tail of ${tail.length} chars exceeds ${budget}`);
    assert.equal(out.results[0].output_truncated, true);
    assert.ok(tail.includes("TAIL-MARK"));
    assert.ok(!tail.includes("HEAD-MARK"));
    assert.ok(!tail.includes("abcdefsecretvalue"), "the contract's redaction filter was not applied");
  } finally {
    r.dispose();
  }
});

// ---------------------------------------------------------- 4. environment

test("the child environment has no ASSOCIATE_* variable and runs in the checkout", async () => {
  const r = repo();
  try {
    const ctx = createAssociateContext({
      checkoutRoot: r.checkout,
      contract: loadContract({}),
      env: { ASSOCIATE_EXPORT_ROOT: join(r.root, "runs"), ASSOCIATE_SESSION_ID: "d12-env" },
    });
    const t = createTestsTool(ctx, {
      log: () => {},
      env: {
        PATH: process.env.PATH,
        ASSOCIATE_API_KEY: "lane-key-must-not-leak",
        ASSOCIATE_BASE_URL: "http://x/v1",
        D12_VISIBLE: "yes",
        [TEST_COMMANDS_ENV]: JSON.stringify([
          js(
            "process.stdout.write(JSON.stringify({keys: Object.keys(process.env).filter(k => k.startsWith('ASSOCIATE_')), " +
              "visible: process.env.D12_VISIBLE, cwd: process.cwd()}))",
          ),
        ]),
      },
    });
    const out = payload(await t.execute("c", {}));
    const seen = JSON.parse(out.results[0].output_tail);
    assert.deepEqual(seen.keys, []);
    assert.equal(seen.visible, "yes");
    assert.equal(seen.cwd, r.checkout);
  } finally {
    r.dispose();
  }
});

// ----------------------------------------------- 5. side-effect protection

test("test-run changes are reverted and listed; the model's uncommitted work survives byte for byte", async () => {
  const r = repo();
  try {
    const c = r.checkout;
    // The model's work before the test run: an edit to a tracked file (with
    // bytes that are not valid UTF-8), a new untracked file, a deleted file.
    const modelBytes = Buffer.from([0x6d, 0x6f, 0x64, 0x65, 0x6c, 0xff, 0xfe, 0x0a]);
    writeFileSync(join(c, "tracked.txt"), modelBytes);
    writeFileSync(join(c, "model_new.txt"), "the model's new file\n");
    mkdirSync(join(c, "pkg"));
    writeFileSync(join(c, "pkg", "mod.txt"), "nested model file\n");
    unlinkSync(join(c, "gone.txt"));

    const script = `
      const fs = require('fs');
      fs.writeFileSync('tracked.txt', 'clobbered by the test run');
      fs.writeFileSync('other.txt', 'lockfile rewritten');
      fs.writeFileSync('created.txt', 'a test artefact');
      fs.mkdirSync('cache', { recursive: true });
      fs.writeFileSync('cache/deep.txt', 'nested artefact');
      fs.unlinkSync('model_new.txt');
      fs.writeFileSync('gone.txt', 'resurrected by the test');
      fs.writeFileSync('pkg/mod.txt', 'nested clobber');
      fs.writeFileSync('run.log', 'ignored output');
    `;
    const out = payload(await tool(r, [js(script)]).execute("c", {}));
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.protection, "git");

    assert.deepEqual(readFileSync(join(c, "tracked.txt")), modelBytes);
    assert.equal(readFileSync(join(c, "model_new.txt"), "utf8"), "the model's new file\n");
    assert.equal(readFileSync(join(c, "pkg", "mod.txt"), "utf8"), "nested model file\n");
    assert.equal(existsSync(join(c, "gone.txt")), false, "a file the model deleted stays deleted");
    assert.equal(readFileSync(join(c, "other.txt"), "utf8"), "original other\n");
    assert.equal(existsSync(join(c, "created.txt")), false);
    assert.equal(existsSync(join(c, "cache", "deep.txt")), false);
    assert.equal(readFileSync(join(c, "run.log"), "utf8"), "ignored output", "ignored files are untouched");

    assert.deepEqual(
      [...out.reverted].sort(),
      ["cache/deep.txt", "created.txt", "gone.txt", "model_new.txt", "other.txt", "pkg/mod.txt", "tracked.txt"],
    );
    assert.equal(out.reverted_count, 7);
    // The checkout's status is exactly the model's work again.
    const status = git(c, "status", "--porcelain=v1", "--untracked-files=all").split("\n").filter(Boolean).sort();
    assert.deepEqual(status, [" D gone.txt", " M tracked.txt", "?? model_new.txt", "?? pkg/mod.txt"]);
  } finally {
    r.dispose();
  }
});

test("a clean checkout comes back clean after a test run that dirties it, and nothing is listed when nothing changed", async () => {
  const r = repo();
  try {
    const dirty = await tool(r, [js("require('fs').writeFileSync('other.txt', 'x')")]).execute("c", {});
    assert.deepEqual(payload(dirty).reverted, ["other.txt"]);
    assert.equal(git(r.checkout, "status", "--porcelain").trim(), "");
    const clean = await tool(r, [js("0")]).execute("c", {});
    assert.deepEqual(payload(clean).reverted, []);
  } finally {
    r.dispose();
  }
});

test("a symlink that was dirty before the test run is restored as a symlink", async () => {
  const r = repo();
  try {
    const c = r.checkout;
    // The model swapped the tracked file for a symlink before the run.
    unlinkSync(join(c, "tracked.txt"));
    symlinkSync("elsewhere", join(c, "tracked.txt"));

    const out = payload(
      await tool(r, [
        js(
          "const fs = require('fs'); fs.unlinkSync('tracked.txt'); fs.writeFileSync('tracked.txt', 'run content'); process.exit(0);",
        ),
      ]).execute("c", {}),
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(out.reverted, ["tracked.txt"]);

    const stat = lstatSync(join(c, "tracked.txt"));
    assert.ok(stat.isSymbolicLink(), "tracked.txt was not restored as a symlink");
    assert.equal(readlinkSync(join(c, "tracked.txt")), "elsewhere");
  } finally {
    r.dispose();
  }
});

test("restore_failed when a dirty-before path cannot be put back", { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false }, async () => {
  const r = repo();
  const locked = join(r.checkout, "work");
  try {
    const c = r.checkout;
    // The model wrote a new file before the run.
    mkdirSync(locked);
    writeFileSync(join(locked, "draft.txt"), "the model's draft\n");

    // The test run deletes it and makes its directory read-only, so the
    // saved bytes cannot be written back.
    const out = payload(
      await tool(r, [
        js("const fs = require('fs'); fs.unlinkSync('work/draft.txt'); fs.chmodSync('work', 0o500); process.exit(0);"),
      ]).execute("c", {}),
    );
    assert.equal(out.ok, false, JSON.stringify(out));
    assert.equal(out.code, "restore_failed", JSON.stringify(out));
    assert.ok(
      out.detail.restore_errors.some((e: any) => e.path === "work/draft.txt"),
      "the restore error names the path that could not be put back",
    );
  } finally {
    if (existsSync(locked)) execFileSync("chmod", ["700", locked]);
    r.dispose();
  }
});

test("over the protection cap the tests are refused, never run unprotected", async () => {
  const r = repo();
  try {
    writeFileSync(join(r.checkout, "tracked.txt"), "x".repeat(64));
    const marker = join(r.checkout, "ran.log");
    const t = tool(r, [js(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`)], { maxProtectedBytes: 16 });
    const out = payload(await t.execute("c", {}));
    assert.equal(out.ok, false);
    assert.equal(out.code, "protection_too_large");
    assert.equal(existsSync(marker), false, "the command ran without protection");
  } finally {
    r.dispose();
  }
});

test("outside a git work tree the command runs unprotected and the result says so", async () => {
  const r = repo(false);
  try {
    const out = payload(await tool(r, [js("require('fs').writeFileSync('made.txt', 'x')")]).execute("c", {}));
    assert.equal(out.ok, true);
    assert.equal(out.protection, "none");
    assert.match(out.protection_note, /not a git work tree/);
    assert.deepEqual(out.reverted, []);
    assert.ok(existsSync(join(r.checkout, "made.txt")));
  } finally {
    r.dispose();
  }
});

// ------------------------------------------------- 6. load-time behaviour

async function loadWith(raw: string | undefined, r: Rig) {
  return loadExtension({
    ASSOCIATE_EXPORT_ROOT: join(r.root, "runs"),
    ASSOCIATE_CHECKOUT_ROOT: r.checkout,
    ASSOCIATE_SESSION_ID: "d12-load",
    ASSOCIATE_MODEL: "worker",
    ASSOCIATE_API_KEY: "dummy",
    ASSOCIATE_CONTRACT_DIR: findRepoContractDir(),
    [TEST_COMMANDS_ENV]: raw,
  });
}

test("malformed ASSOCIATE_TEST_COMMANDS does not crash load; the tool reports none configured", async () => {
  const r = repo();
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    const { pi, cleanup } = await loadWith("[[\"uv\", 7]", r);
    try {
      const out = payload(await pi.tool(TESTS_TOOL_NAME).execute("c", {}));
      assert.equal(out.code, "no_test_commands");
      assert.equal(lines.filter((line) => line.includes(TEST_COMMANDS_ENV)).length, 1);
    } finally {
      cleanup();
    }
  } finally {
    console.error = original;
    r.dispose();
  }
});

test("ASSOCIATE_TEST_COMMANDS is snapshotted at load, never re-read at call time", async () => {
  const r = repo();
  const { pi, cleanup } = await loadWith(JSON.stringify([js("process.stdout.write('configured at load')")]), r);
  const saved = process.env[TEST_COMMANDS_ENV];
  try {
    process.env[TEST_COMMANDS_ENV] = JSON.stringify([js("process.stdout.write('changed later')")]);
    const out = payload(await pi.tool(TESTS_TOOL_NAME).execute("c", {}));
    assert.match(out.results[0].output_tail, /configured at load/);
  } finally {
    if (saved === undefined) delete process.env[TEST_COMMANDS_ENV];
    else process.env[TEST_COMMANDS_ENV] = saved;
    cleanup();
    r.dispose();
  }
});
