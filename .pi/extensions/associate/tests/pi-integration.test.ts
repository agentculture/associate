/**
 * End-to-end checks against a real `pi` process.
 *
 * Acceptance criteria 1, 2 and 4 are about what pi actually does, so a fake
 * cannot settle them. Each test here skips with a printed reason when the
 * preconditions are absent — `pi` not on PATH, or the configured model lane
 * unreachable — because CI must pass with no lane and no Node-22 model access
 * (spec scope: "CI never needs the lane"; "any test that needs pi is skipped
 * with a reason when pi is absent").
 *
 * Override the lane with ASSOCIATE_TEST_PI_PROVIDER / ASSOCIATE_TEST_PI_MODEL;
 * with neither set, pi's own default provider is used. No endpoint or key is
 * ever read from the environment to make a test *pass* — an unreachable lane
 * skips, never silently succeeds.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extensionDir } from "../lib/paths.ts";
import { findRepoContractDir } from "../lib/contract.ts";

const REPO_ROOT = join(extensionDir, "..", "..", "..");
const TIMEOUT_MS = 300_000;

interface PiRun {
  events: Array<Record<string, any>>;
  stdout: string;
  laneError?: string;
}

function piOnPath(): boolean {
  return spawnSync("pi", ["--version"], { encoding: "utf8" }).status === 0;
}

/** Run `pi -p --mode json` and parse the event stream. */
function runPi(prompt: string, options: { cwd: string; args?: string[]; env?: NodeJS.ProcessEnv }): PiRun {
  const lane: string[] = [];
  if (process.env.ASSOCIATE_TEST_PI_PROVIDER) {
    lane.push("--provider", process.env.ASSOCIATE_TEST_PI_PROVIDER);
  }
  if (process.env.ASSOCIATE_TEST_PI_MODEL) {
    lane.push("--model", process.env.ASSOCIATE_TEST_PI_MODEL);
  }

  const result = spawnSync(
    "pi",
    ["-p", "--no-session", "--approve", "--mode", "json", ...lane, ...(options.args ?? []), prompt],
    {
      cwd: options.cwd,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      env: { ...process.env, ...options.env },
    },
  );

  const events: Array<Record<string, any>> = [];
  for (const line of (result.stdout ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      /* a partial line is not an event */
    }
  }

  // A provider/lane failure surfaces as an assistant message with an
  // errorMessage; report it so the caller can skip rather than fail.
  let laneError: string | undefined;
  for (const event of events) {
    for (const message of event.messages ?? []) {
      if (message.errorMessage) laneError = String(message.errorMessage).slice(0, 200);
    }
  }
  if (!laneError && events.length === 0) {
    laneError = `pi produced no events (status ${result.status}): ${(result.stderr ?? "").slice(0, 200)}`;
  }
  return { events, stdout: result.stdout ?? "", laneError };
}

function toolResults(run: PiRun, toolName: string): Array<Record<string, any>> {
  return run.events.filter(
    (event) => event.type === "tool_execution_end" && event.toolName === toolName,
  );
}

test("a real pi run lists associate_ready and finish and activates no writer", { timeout: TIMEOUT_MS + 30_000 }, (t) => {
  if (!piOnPath()) return t.skip("pi is not on PATH");

  const run = runPi("Call the associate_ready tool, then call finish with a one-line summary.", {
    cwd: REPO_ROOT,
    env: { ASSOCIATE_CONTRACT_DIR: findRepoContractDir() },
  });

  const ready = toolResults(run, "associate_ready");
  if (ready.length === 0) {
    return t.skip(`associate_ready was never called — lane unavailable? ${run.laneError ?? ""}`);
  }

  const report = ready[0]!.result.details;
  assert.equal(report.ok, true);
  assert.equal(report.contract_source, "env", "the adapter's ASSOCIATE_CONTRACT_DIR must win");
  assert.ok(report.contract_version >= 1);

  // Criterion 1: the sentinel and finish are offered; no writer is.
  assert.ok(report.active_tools.includes("associate_ready"), "associate_ready must be active");
  assert.ok(report.active_tools.includes("finish"), "finish must be active");
  // `bash` is active on purpose: it is the extension's allowlisted override
  // (spec c35/h27), and the assertion below is that exactly one tool carries
  // that name and no writer is active.
  assert.deepEqual(
    report.active_tools.filter((name: string) => name === "bash"),
    ["bash"],
    `exactly one bash must be active: ${report.active_tools.join(", ")}`,
  );
  for (const forbidden of ["edit", "write"]) {
    assert.ok(
      !report.active_tools.includes(forbidden),
      `${forbidden} must not be active: ${report.active_tools.join(", ")}`,
    );
  }
  assert.deepEqual(report.writer_tools_active, []);
});

test("a real pi run blocks a write into the checkout and shows the block in the transcript", { timeout: TIMEOUT_MS + 30_000 }, (t) => {
  if (!piOnPath()) return t.skip("pi is not on PATH");

  // defaultTools: [] leaves no writer to attempt, so the built-in write is
  // re-enabled for this run only, with --tools. That is the point of the
  // guard: it holds even when the structural restriction is overridden.
  const probe = join(REPO_ROOT, "GUARD_PROBE.txt");
  rmSync(probe, { force: true });

  const run = runPi(
    "Use the write tool to create the file GUARD_PROBE.txt in the current directory containing the word hi. Then call finish with a one-line summary of what happened.",
    {
      cwd: REPO_ROOT,
      args: ["--tools", "write,associate_ready,finish"],
      env: { ASSOCIATE_CONTRACT_DIR: findRepoContractDir() },
    },
  );

  try {
    const attempts = run.events.filter(
      (event) => event.type === "tool_execution_start" && event.toolName === "write",
    );
    if (attempts.length === 0) {
      return t.skip(
        `the model never attempted a write, so the guard was not exercised end to end ` +
          `(the unit test in guard.test.ts covers the decision) ${run.laneError ?? ""}`,
      );
    }

    // The block is visible in the transcript…
    assert.match(
      run.stdout,
      /outside this session's scratch directory/,
      "the guard's reason must appear in the transcript",
    );
    // …and nothing was written.
    assert.equal(existsSync(probe), false, "the guard must have prevented the write");
  } finally {
    rmSync(probe, { force: true });
  }
});

test("a full fixture run leaves the examined checkout clean", { timeout: TIMEOUT_MS + 30_000 }, (t) => {
  if (!piOnPath()) return t.skip("pi is not on PATH");
  if (spawnSync("git", ["--version"], { encoding: "utf8" }).status !== 0) {
    return t.skip("git is not on PATH");
  }

  const parent = mkdtempSync(join(tmpdir(), "associate-fixture-"));
  const checkout = join(parent, "fixture-repo");
  try {
    spawnSync("git", ["init", "-q", checkout], { encoding: "utf8" });
    writeFileSync(join(checkout, "hello.py"), "def hello():\n    return 'hi'\n");
    for (const args of [
      ["config", "user.email", "fixture@example.invalid"],
      ["config", "user.name", "fixture"],
      ["add", "-A"],
      ["commit", "-qm", "fixture"],
    ]) {
      spawnSync("git", args, { cwd: checkout, encoding: "utf8" });
    }

    const run = runPi(
      "Call the associate_ready tool, then call finish with a one-line summary. Do not do anything else.",
      {
        cwd: checkout,
        // The fixture repo has no .pi/settings.json, so load the extension
        // explicitly and drop the built-ins the way defaultTools: [] does.
        args: ["-e", join(extensionDir, "index.ts"), "--no-builtin-tools"],
        env: { ASSOCIATE_CONTRACT_DIR: findRepoContractDir() },
      },
    );

    const status = spawnSync("git", ["status", "--porcelain"], { cwd: checkout, encoding: "utf8" });
    assert.equal(status.stdout.trim(), "", `the checkout must be untouched, got:\n${status.stdout}`);

    const ready = toolResults(run, "associate_ready");
    if (ready.length === 0) {
      return t.skip(
        `the checkout stayed clean, but no tool ran — lane unavailable? ${run.laneError ?? ""}`,
      );
    }
    const report = ready[0]!.result.details;
    assert.ok(
      report.session.export_dir.startsWith(parent) && !report.session.export_dir.startsWith(checkout),
      `the export dir must sit outside the examined checkout, got ${report.session.export_dir}`,
    );
    assert.ok(existsSync(report.session.scratch_dir));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
