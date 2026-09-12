/**
 * The code-lens wrapper (task t8, claims c7/h5).
 *
 * Every test drives the tool with an injected `which` and `spawn`, so nothing
 * here needs code-lens installed and nothing here runs a real process. The
 * one thing that *is* exercised against the real filesystem is
 * `whichOnPath`'s refusal to resolve an engine relative to the checkout.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssociateContext } from "../lib/runtime.ts";
import { whichOnPath, type ProcResult, type Spawn } from "../tools/_procs.ts";
import { CODE_LENS_COMMANDS, createCodeLensTool, register } from "../tools/codelens.ts";
import type { AssociateContext } from "../lib/context.ts";

interface Harness {
  ctx: AssociateContext;
  checkout: string;
  calls: Array<{ file: string; args: string[] }>;
  dispose: () => void;
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "associate-runs-"));
  const checkout = mkdtempSync(join(tmpdir(), "associate-checkout-"));
  const ctx = createAssociateContext({
    checkoutRoot: checkout,
    env: { ASSOCIATE_EXPORT_ROOT: root, ASSOCIATE_SESSION_ID: "t8-codelens" },
  });
  return {
    ctx,
    checkout,
    calls: [],
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    },
  };
}

function fakeSpawn(h: Harness, result: Partial<ProcResult>): Spawn {
  return async (file, args) => {
    h.calls.push({ file, args: [...args] });
    return { code: 0, stdout: "", stderr: "", ...result };
  };
}

const PROFILE_JSON = JSON.stringify({
  ok: true,
  data: { name: "associate", language: "python", manifest: "pyproject.toml" },
});

test("with code-lens shimmed out of PATH the tool returns a structured install hint", async () => {
  const h = harness();
  try {
    const tool = createCodeLensTool(h.ctx, {
      which: () => null,
      spawn: fakeSpawn(h, {}),
    });
    const out = await tool.execute("call-1", { command: "profile" });
    const payload = JSON.parse(out.content[0]!.text);

    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "tool_missing");
    assert.equal(payload.error.kind, "tool_missing");
    assert.match(payload.error.message, /uv tool install code-lens-cli/);
    assert.deepEqual(payload.error.detail.install, ["uv tool install code-lens-cli"]);
    assert.match(payload.error.detail.lookup, /PATH only/);
    assert.equal(h.calls.length, 0, "nothing may be spawned when the CLI is absent");
  } finally {
    h.dispose();
  }
});

test("with code-lens present, profile returns structured output and an argv-only call", async () => {
  const h = harness();
  try {
    const tool = createCodeLensTool(h.ctx, {
      which: (name) => (name === "code-lens" ? "/usr/local/bin/code-lens" : null),
      spawn: fakeSpawn(h, { stdout: PROFILE_JSON }),
    });
    const out = await tool.execute("call-1", { command: "profile" });
    const payload = JSON.parse(out.content[0]!.text);

    assert.equal(payload.ok, true);
    assert.equal(payload.command, "profile");
    assert.equal(payload.data.name, "associate");
    assert.equal(payload.exit_code, 0);

    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]!.file, "/usr/local/bin/code-lens");
    assert.deepEqual(h.calls[0]!.args, ["profile", h.checkout, "--basic", "--json"]);
    assert.ok(
      h.calls[0]!.args.every((arg) => typeof arg === "string"),
      "the CLI is spawned with an argv array, never a shell string",
    );
  } finally {
    h.dispose();
  }
});

test("each command builds the argv the installed CLI documents", async () => {
  const h = harness();
  try {
    const tool = createCodeLensTool(h.ctx, {
      which: () => "/usr/local/bin/code-lens",
      spawn: fakeSpawn(h, { stdout: PROFILE_JSON }),
    });

    await tool.execute("c", { command: "profile", depth: "deep", online: true });
    assert.deepEqual(h.calls.at(-1)!.args, ["profile", h.checkout, "--depth", "deep", "--json"]);

    await tool.execute("c", { command: "classify" });
    assert.deepEqual(h.calls.at(-1)!.args, ["classify", h.checkout, "--json"]);

    await tool.execute("c", { command: "grep", pattern: "def register" });
    assert.deepEqual(h.calls.at(-1)!.args, ["grep", "def register", h.checkout, "--json"]);

    await tool.execute("c", { command: "recent", count: 5 });
    assert.deepEqual(h.calls.at(-1)!.args, ["recent", h.checkout, "-n", "5", "--json"]);

    await tool.execute("c", { command: "connections" });
    assert.deepEqual(h.calls.at(-1)!.args, ["connections", h.checkout, "--json"]);

    await tool.execute("c", { command: "graph" });
    assert.deepEqual(h.calls.at(-1)!.args, ["graph", h.checkout, "--json"]);
  } finally {
    h.dispose();
  }
});

test("the command enum is the one the spec names", () => {
  assert.deepEqual(
    [...CODE_LENS_COMMANDS],
    ["profile", "classify", "grep", "recent", "connections", "graph"],
  );
});

test("a malformed argument set is refused with a corrective error naming the field", async () => {
  const h = harness();
  try {
    const tool = createCodeLensTool(h.ctx, {
      which: () => "/usr/local/bin/code-lens",
      spawn: fakeSpawn(h, { stdout: PROFILE_JSON }),
    });

    const bad = JSON.parse((await tool.execute("c", { command: "nonsense" })).content[0]!.text);
    assert.equal(bad.error.code, "invalid_argument");
    assert.equal(bad.error.detail.field, "command");

    const missing = JSON.parse((await tool.execute("c", {})).content[0]!.text);
    assert.equal(missing.error.code, "invalid_argument");

    const noPattern = JSON.parse((await tool.execute("c", { command: "grep" })).content[0]!.text);
    assert.equal(noPattern.error.code, "invalid_argument");
    assert.equal(noPattern.error.detail.field, "pattern");

    assert.equal(h.calls.length, 0, "a rejected argument set never reaches the CLI");
  } finally {
    h.dispose();
  }
});

test("a path escaping the checkout and a pattern escaping it are both refused", async () => {
  const h = harness();
  try {
    const tool = createCodeLensTool(h.ctx, {
      which: () => "/usr/local/bin/code-lens",
      spawn: fakeSpawn(h, { stdout: PROFILE_JSON }),
    });

    const escaped = JSON.parse(
      (await tool.execute("c", { command: "profile", path: "../../etc" })).content[0]!.text,
    );
    assert.equal(escaped.error.code, "path_escapes_root");

    const pattern = JSON.parse(
      (await tool.execute("c", { command: "grep", pattern: "../../etc/*" })).content[0]!.text,
    );
    assert.equal(pattern.error.code, "pattern_escapes_root");

    assert.equal(h.calls.length, 0);
  } finally {
    h.dispose();
  }
});

test("a subcommand the installed code-lens does not have is reported as unsupported", async () => {
  const h = harness();
  try {
    const tool = createCodeLensTool(h.ctx, {
      which: () => "/usr/local/bin/code-lens",
      spawn: fakeSpawn(h, {
        code: 2,
        stderr:
          "usage: code-lens [-h] [--version] {learn,explain,whoami,classify,grep,recent,profile} ...\n" +
          "code-lens: error: argument command: invalid choice: 'graph'",
      }),
    });
    const payload = JSON.parse((await tool.execute("c", { command: "graph" })).content[0]!.text);
    assert.equal(payload.error.code, "unsupported_command");
    assert.equal(payload.error.detail.command, "graph");
    assert.match(payload.error.message, /installed code-lens/);
  } finally {
    h.dispose();
  }
});

test("a non-zero exit that is not an unknown subcommand is a typed cli_failed error", async () => {
  const h = harness();
  try {
    const tool = createCodeLensTool(h.ctx, {
      which: () => "/usr/local/bin/code-lens",
      spawn: fakeSpawn(h, { code: 1, stderr: "fatal: not a git repository" }),
    });
    const payload = JSON.parse((await tool.execute("c", { command: "recent" })).content[0]!.text);
    assert.equal(payload.error.code, "cli_failed");
    assert.equal(payload.error.detail.exit_code, 1);
    assert.match(payload.error.detail.stderr, /not a git repository/);
  } finally {
    h.dispose();
  }
});

test("non-JSON stdout is handed back as text rather than pretended to be structured", async () => {
  const h = harness();
  try {
    const tool = createCodeLensTool(h.ctx, {
      which: () => "/usr/local/bin/code-lens",
      spawn: fakeSpawn(h, { stdout: "associate — python — pyproject.toml\n" }),
    });
    const payload = JSON.parse((await tool.execute("c", { command: "profile" })).content[0]!.text);
    assert.equal(payload.ok, true);
    assert.equal(payload.data, undefined);
    assert.match(payload.text, /associate — python/);
  } finally {
    h.dispose();
  }
});

test("output larger than the shell budget is bounded, not returned whole", async () => {
  const h = harness();
  try {
    const budget = (h.ctx.policy.budgets as Record<string, { max_output_chars: number }>).shell;
    const huge = JSON.stringify({ ok: true, data: { blob: "x".repeat(budget.max_output_chars * 2) } });
    const tool = createCodeLensTool(h.ctx, {
      which: () => "/usr/local/bin/code-lens",
      spawn: fakeSpawn(h, { stdout: huge }),
    });
    const out = await tool.execute("c", { command: "profile" });
    assert.ok(out.content[0]!.text.length < huge.length, "the result must be bounded");
    const details = out.details as { truncated: boolean };
    assert.equal(details.truncated, true);
  } finally {
    h.dispose();
  }
});

test("register() registers exactly one tool, named code_lens", async () => {
  const h = harness();
  try {
    const registered: Array<{ name: string }> = [];
    await register({ registerTool: (t: { name: string }) => registered.push(t) }, h.ctx);
    assert.deepEqual(
      registered.map((t) => t.name),
      ["code_lens"],
    );
  } finally {
    h.dispose();
  }
});

test(
  "against the installed code-lens, profile really does return structured output",
  // Acceptance criterion 1, the "with it present" half. Skipped rather than
  // failed where the CLI is absent — CI installs neither wrapped CLI, and the
  // whole point of this wrapper is that its absence degrades.
  { skip: whichOnPath("code-lens") === null ? "code-lens is not on PATH" : false },
  async () => {
    const h = harness();
    try {
      const tool = createCodeLensTool(h.ctx);
      const out = await tool.execute("call-1", { command: "profile" });
      const payload = JSON.parse(out.content[0]!.text);
      assert.equal(payload.ok, true, JSON.stringify(payload));
      assert.equal(payload.exit_code, 0);
      assert.equal(typeof payload.data, "object");
      // The profile is mechanical facts about the target, not prose.
      assert.equal(payload.data.path, h.checkout);
      assert.ok("language" in payload.data && "manifest" in payload.data);
    } finally {
      h.dispose();
    }
  },
);

test("whichOnPath resolves from PATH only and never from the working directory", () => {
  // A name carrying a separator would let a checkout-relative path in.
  assert.equal(whichOnPath("./code-lens", { PATH: "/usr/bin" }), null);
  assert.equal(whichOnPath("../bin/code-lens", { PATH: "/usr/bin" }), null);
  // Empty and relative PATH entries both mean "the current directory" — the
  // checkout under examination — and must be skipped.
  assert.equal(whichOnPath("code-lens", { PATH: "" }), null);
  assert.equal(whichOnPath("code-lens", { PATH: ".:bin:" }), null);
  assert.equal(whichOnPath("definitely-not-a-real-binary-t8", { PATH: "/usr/bin:/bin" }), null);
  // A real one, when the platform has it, resolves to an absolute path.
  const sh = whichOnPath("sh", { PATH: "/usr/bin:/bin" });
  if (sh !== null) assert.ok(sh.startsWith("/"), "a resolved binary is an absolute path");
});
