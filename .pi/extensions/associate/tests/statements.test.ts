/**
 * The statements artifact (spec c25/c31, honesty h19/h25; issue #4 artifact B).
 *
 * Driven with fake Pi `message_end` / `tool_result` events and hand-built walk
 * files — the same pattern `walk.test.ts` uses — so the recorder is exercised
 * without a live pi. The finished artifact is validated against the
 * *contract's* statements schema by shelling to the Python package's
 * stdlib validator, so a drift between the schema and what the TypeScript
 * writes fails here rather than in a bench run.
 *
 * The evaluation correction is the load-bearing assertion in this file: a
 * citation that resolves into a recorded read range is marked ENCOUNTERED and
 * never SUPPORTED, and a statement with no `[wN]` reference is marked
 * UNREFERENCED.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadContract } from "../lib/contract.ts";
import { extensionDir } from "../lib/paths.ts";
import { WALK_FILENAME } from "../lib/walk.ts";
import { normalizeHandback } from "../lib/handback.ts";
import {
  STATEMENTS_JSON_FILENAME,
  STATEMENTS_MD_FILENAME,
  StatementsRecorder,
  assistantMessageText,
  messageHasToolCalls,
  parseCitations,
  parseEvidence,
  readRangesFromWalk,
  readWalkEntries,
  renderStatementsMarkdown,
  splitStatements,
  verifyCitation,
} from "../lib/statements.ts";
import { loadExtension } from "./load-extension.ts";

const policy = loadContract({}).policy;

/** The repo root: `.pi/extensions/associate` → three levels up. */
const repoRoot = dirname(dirname(dirname(extensionDir)));

function withDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "associate-stmt-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write a walk.jsonl made of `read` entries with stamped content. */
function writeWalk(
  dir: string,
  entries: Array<{
    id: string;
    tool?: string;
    args?: Record<string, unknown>;
    content?: string;
    truncated?: boolean;
    result?: Record<string, unknown>;
  }>,
  run: Record<string, unknown> | null = { duration_ms: 1, tool_calls: 1, outcome: "ok", truncated: false },
): string {
  const lines = entries.map((entry) =>
    JSON.stringify({
      id: entry.id,
      ts: "2026-09-12T00:00:00.000Z",
      tool: entry.tool ?? "read",
      args: entry.args ?? {},
      result: entry.result ?? { content: entry.content ?? "" },
      truncated: entry.truncated ?? false,
    }),
  );
  if (run) lines.push(JSON.stringify({ run }));
  const path = join(dir, WALK_FILENAME);
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

/** Stamp `text`'s lines with absolute line numbers starting at `start`. */
function stamp(start: number, lines: string[]): string {
  return lines.map((line, index) => `${start + index}\t${line}`).join("\n");
}

function recorderIn(dir: string, walkPath: string): StatementsRecorder {
  return new StatementsRecorder({ exportDir: dir, walkPath, policy, installExitHook: false });
}

function readJson(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, STATEMENTS_JSON_FILENAME), "utf8"));
}

function readMarkdown(dir: string): string {
  return readFileSync(join(dir, STATEMENTS_MD_FILENAME), "utf8");
}

/**
 * Validate the statements artifact against the contract schema, via the
 * Python package. Returns `undefined` when `uv` is unavailable (the extension
 * tests must still run on a machine with node but no Python toolchain).
 */
function validateStatementsWithContract(dir: string): string | undefined {
  const script = `
import json, sys
from associate import contract
from associate.contract import validate

schema = contract.load_schema("statements")
instance = json.loads(open(sys.argv[1]).read())
print("\\n".join(validate.validate(instance, schema)))
`;
  try {
    return execFileSync("uv", ["run", "python", "-c", script, join(dir, STATEMENTS_JSON_FILENAME)], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT/.test(message)) return undefined; // no uv on PATH
    throw error;
  }
}

// ------------------------------------------------------------------ parsing

test("parseEvidence reads [wN] and [w3, w7] markers and ignores non-ids", () => {
  assert.deepEqual(parseEvidence("The parser lives in read.ts [w3]."), ["w3"]);
  assert.deepEqual(parseEvidence("Both places agree [w3, w7]."), ["w3", "w7"]);
  assert.deepEqual(parseEvidence("Seen twice [w2] and again [w2]."), ["w2"]);
  assert.deepEqual(parseEvidence("No marker at all."), []);
  // `w0` is not a valid walk id (the schema's pattern starts at w1).
  assert.deepEqual(parseEvidence("Bad [w0] and [wx] markers."), []);
});

test("splitStatements splits on paragraphs and list items, skipping headings and fences", () => {
  const message = [
    "# A heading",
    "",
    "First paragraph line one",
    "continues on line two.",
    "",
    "- a bullet [w1]",
    "- another bullet",
    "",
    "```",
    "code that is not a claim",
    "```",
    "",
    "1. a numbered item",
  ].join("\n");
  assert.deepEqual(splitStatements(message), [
    "First paragraph line one continues on line two.",
    "a bullet [w1]",
    "another bullet",
    "a numbered item",
  ]);
});

test("parseCitations finds path:line references and ignores bare numbers", () => {
  assert.deepEqual(parseCitations("See lib/walk.ts:42 for the recorder."), [
    { path: "lib/walk.ts", line: 42 },
  ]);
  assert.deepEqual(parseCitations("no citations here, just 42 lines"), []);
  assert.deepEqual(
    parseCitations("`associate/cli/__init__.py:10` and tools/read.ts:7"),
    [
      { path: "associate/cli/__init__.py", line: 10 },
      { path: "tools/read.ts", line: 7 },
    ],
  );
});

test("assistantMessageText joins text blocks and messageHasToolCalls sees a tool call", () => {
  const withTool = {
    role: "assistant",
    content: [
      { type: "text", text: "Looking now." },
      { type: "toolCall", toolName: "read" },
    ],
  };
  assert.equal(assistantMessageText(withTool), "Looking now.");
  assert.equal(messageHasToolCalls(withTool), true);

  const prose = { role: "assistant", content: [{ type: "text", text: "Here is what I saw." }] };
  assert.equal(messageHasToolCalls(prose), false);
  assert.equal(assistantMessageText(prose), "Here is what I saw.");
  // thinking blocks are not statements
  assert.equal(
    assistantMessageText({
      role: "assistant",
      content: [{ type: "thinking", text: "hmm" }, { type: "text", text: "answer" }],
    }),
    "answer",
  );
});

// ------------------------------------------------------------- walk ranges

test("readRangesFromWalk derives the read range from the stamped content", () => {
  const entries = [
    {
      id: "w1",
      ts: "t",
      tool: "read",
      args: { path: "lib/walk.ts" },
      result: { content: stamp(10, ["alpha", "beta", "gamma"]) },
      truncated: false,
    },
  ];
  assert.deepEqual(readRangesFromWalk(entries), [
    { walkId: "w1", path: "lib/walk.ts", start: 10, end: 12 },
  ]);
});

test("readRangesFromWalk falls back to args when the content was not inlined", () => {
  const entries = [
    {
      id: "w4",
      ts: "t",
      tool: "read",
      args: { path: "big.ts", start_line: 100, end_line: 250 },
      result: { sha256: "a".repeat(64), bytes: 9 },
      truncated: true,
    },
  ];
  assert.deepEqual(readRangesFromWalk(entries), [
    { walkId: "w4", path: "big.ts", start: 100, end: 250 },
  ]);
});

test("readRangesFromWalk ignores failed reads and non-read tools", () => {
  const entries = [
    {
      id: "w1",
      ts: "t",
      tool: "grep",
      args: { path: "lib/walk.ts" },
      result: { content: stamp(1, ["x"]) },
      truncated: false,
    },
    {
      id: "w2",
      ts: "t",
      tool: "read",
      args: { path: "gone.ts" },
      result: { content: "" },
      truncated: false,
      error: "path_not_found",
    },
  ];
  assert.deepEqual(readRangesFromWalk(entries), []);
});

test("readWalkEntries parses the jsonl and drops the run record line", () =>
  withDir((dir) => {
    const walkPath = writeWalk(dir, [
      { id: "w1", args: { path: "a.ts" }, content: stamp(1, ["one"]) },
      { id: "w2", args: { path: "b.ts" }, content: stamp(1, ["two"]), truncated: true },
    ]);
    const entries = readWalkEntries(walkPath);
    assert.deepEqual(
      entries.map((entry) => entry.id),
      ["w1", "w2"],
    );
  }));

// --------------------------------------------------------------- verifier

test("the verifier accepts a citation inside a recorded range and flags one outside it", () => {
  const ranges = readRangesFromWalk([
    {
      id: "w1",
      ts: "t",
      tool: "read",
      args: { path: "lib/walk.ts" },
      result: { content: stamp(10, ["alpha", "beta", "gamma"]) },
      truncated: false,
    },
  ]);

  // criterion 2: one correct, one wrong.
  const correct = verifyCitation({ path: "lib/walk.ts", line: 11 }, ranges);
  assert.equal(correct.check, "encountered");
  assert.equal(correct.walk_id, "w1");

  const wrongLine = verifyCitation({ path: "lib/walk.ts", line: 99 }, ranges);
  assert.equal(wrongLine.check, "unverifiable");
  assert.equal(wrongLine.walk_id, undefined);

  const wrongPath = verifyCitation({ path: "lib/other.ts", line: 11 }, ranges);
  assert.equal(wrongPath.check, "unverifiable");
});

test("the verifier never emits a 'supported' verdict — only encountered or unverifiable", () => {
  const ranges = readRangesFromWalk([
    {
      id: "w1",
      ts: "t",
      tool: "read",
      args: { path: "a.ts" },
      result: { content: stamp(1, ["x", "y"]) },
      truncated: false,
    },
  ]);
  for (const line of [1, 2, 3]) {
    const verdict = verifyCitation({ path: "a.ts", line }, ranges);
    assert.ok(["encountered", "unverifiable"].includes(verdict.check));
  }
});

test("a citation path matches a recorded read of the same file spelled differently", () => {
  const ranges = readRangesFromWalk([
    {
      id: "w2",
      ts: "t",
      tool: "read",
      args: { path: "./associate/cli/__init__.py" },
      result: { content: stamp(1, ["a", "b", "c"]) },
      truncated: false,
    },
  ]);
  assert.equal(verifyCitation({ path: "cli/__init__.py", line: 2 }, ranges).check, "encountered");
  assert.equal(verifyCitation({ path: "init__.py", line: 2 }, ranges).check, "unverifiable");
});

// -------------------------------------------------------------- recorder

test("an unreferenced statement renders with the UNREFERENCED marker, a referenced one carries evidence", () =>
  withDir((dir) => {
    const walkPath = writeWalk(dir, [
      { id: "w1", args: { path: "lib/walk.ts" }, content: stamp(1, ["alpha", "beta"]) },
    ]);
    const recorder = recorderIn(dir, walkPath);
    recorder.recordAssistantMessage(
      ["The recorder appends one line per tool result [w1].", "", "I would rewrite it."].join("\n"),
    );
    recorder.finalize();

    const artifact = readJson(dir) as {
      statements: Array<{ text: string; evidence: string[]; status: string }>;
    };
    assert.equal(artifact.statements.length, 2);
    // criterion 1
    assert.deepEqual(artifact.statements[0].evidence, ["w1"]);
    assert.equal(artifact.statements[0].status, "referenced");
    assert.deepEqual(artifact.statements[1].evidence, []);
    assert.equal(artifact.statements[1].status, "unreferenced");

    const md = readMarkdown(dir);
    const unreferencedLine = md
      .split("\n")
      .find((line) => line.includes("I would rewrite it."));
    assert.ok(unreferencedLine?.includes("UNREFERENCED"), md);
    const referencedLine = md.split("\n").find((line) => line.includes("appends one line"));
    assert.ok(referencedLine?.includes("[REFERENCED w1]"), md);
    assert.ok(!referencedLine?.includes("UNREFERENCED"), md);
  }));

test("no marker anywhere claims a citation is SUPPORTED (the evaluation correction)", () =>
  withDir((dir) => {
    const walkPath = writeWalk(dir, [
      { id: "w1", args: { path: "lib/walk.ts" }, content: stamp(1, ["alpha", "beta"]) },
    ]);
    const recorder = recorderIn(dir, walkPath);
    recorder.recordAssistantMessage("The append happens at lib/walk.ts:2 [w1].");
    recorder.finalize();

    const md = readMarkdown(dir);
    const json = readFileSync(join(dir, STATEMENTS_JSON_FILENAME), "utf8");
    // criterion 4: "SUPPORTED" must not appear at all — and since "UNSUPPORTED"
    // contains it, this also proves the instruction's provisional marker is gone.
    assert.ok(!md.includes("SUPPORTED"), md);
    assert.ok(!json.includes("supported"), json);
    assert.ok(md.includes("ENCOUNTERED"), md);
  }));

test("the recorder verifies a correct and a wrong citation from the same message", () =>
  withDir((dir) => {
    const walkPath = writeWalk(dir, [
      { id: "w1", args: { path: "lib/walk.ts" }, content: stamp(10, ["alpha", "beta", "gamma"]) },
    ]);
    const recorder = recorderIn(dir, walkPath);
    recorder.recordAssistantMessage(
      "Correct: lib/walk.ts:11 [w1]. Wrong: lib/walk.ts:900 [w1].",
    );
    recorder.finalize();

    const artifact = readJson(dir) as {
      citations: Array<{ path: string; line: number; check: string; walk_id?: string }>;
    };
    const byLine = new Map(artifact.citations.map((c) => [c.line, c]));
    assert.equal(byLine.get(11)?.check, "encountered");
    assert.equal(byLine.get(11)?.walk_id, "w1");
    assert.equal(byLine.get(900)?.check, "unverifiable");
  }));

test("not_fully_read is true exactly when a walk entry is truncated", () => {
  withDir((dir) => {
    const walkPath = writeWalk(dir, [
      { id: "w1", args: { path: "a.ts" }, content: stamp(1, ["x"]), truncated: false },
    ]);
    const recorder = recorderIn(dir, walkPath);
    recorder.recordAssistantMessage("A claim.");
    recorder.finalize();
    assert.equal(readJson(dir).not_fully_read, false);
  });
  withDir((dir) => {
    const walkPath = writeWalk(dir, [
      { id: "w1", args: { path: "a.ts" }, content: stamp(1, ["x"]), truncated: false },
      { id: "w2", args: { path: "b.ts" }, content: stamp(1, ["y"]), truncated: true },
    ]);
    const recorder = recorderIn(dir, walkPath);
    recorder.recordAssistantMessage("A claim.");
    recorder.finalize();
    assert.equal(readJson(dir).not_fully_read, true);
    assert.ok(readMarkdown(dir).includes("NOT FULLY READ"));
  });
});

test("not_fully_read comes from the walk, never from the model's prose", () =>
  withDir((dir) => {
    const walkPath = writeWalk(dir, [
      { id: "w1", args: { path: "a.ts" }, content: stamp(1, ["x"]), truncated: false },
    ]);
    const recorder = recorderIn(dir, walkPath);
    recorder.recordAssistantMessage("I read the whole file, nothing was truncated.");
    recorder.finalize();
    assert.equal(readJson(dir).not_fully_read, false);
  }));

test("the artifact is written as each statement arrives, not buffered until the end", () =>
  withDir((dir) => {
    const walkPath = writeWalk(dir, [
      { id: "w1", args: { path: "a.ts" }, content: stamp(1, ["x"]) },
    ]);
    const recorder = recorderIn(dir, walkPath);
    recorder.recordAssistantMessage("First claim [w1].");
    // No finalize() yet: a run killed here must still leave a readable artifact.
    assert.ok(readMarkdown(dir).includes("First claim"));
    assert.equal((readJson(dir).statements as unknown[]).length, 1);

    recorder.recordAssistantMessage("Second claim.");
    assert.equal((readJson(dir).statements as unknown[]).length, 2);
    recorder.finalize();
  }));

test("the finish hand-back's statements and citations are folded in and verified", () =>
  withDir((dir) => {
    const walkPath = writeWalk(dir, [
      { id: "w1", args: { path: "lib/walk.ts" }, content: stamp(1, ["alpha", "beta"]) },
    ]);
    const recorder = recorderIn(dir, walkPath);
    const handback = normalizeHandback({
      summary: "A short answer.",
      statements: [
        { text: "The recorder streams.", evidence: ["w1"] },
        { text: "I would refactor it." },
      ],
      citations: [
        { path: "lib/walk.ts", line: 2 },
        { path: "lib/walk.ts", line: 4000 },
      ],
    });
    recorder.recordHandback(handback);
    recorder.finalize();

    const artifact = readJson(dir) as {
      statements: Array<{ text: string; status: string; evidence: string[] }>;
      citations: Array<{ line: number; check: string }>;
    };
    assert.deepEqual(
      artifact.statements.map((s) => s.status),
      ["referenced", "unreferenced"],
    );
    const byLine = new Map(artifact.citations.map((c) => [c.line, c.check]));
    assert.equal(byLine.get(2), "encountered");
    assert.equal(byLine.get(4000), "unverifiable");
  }));

test("secrets in the model's prose are redacted before the artifact is written", () =>
  withDir((dir) => {
    const walkPath = writeWalk(dir, [
      { id: "w1", args: { path: "a.ts" }, content: stamp(1, ["x"]) },
    ]);
    const recorder = recorderIn(dir, walkPath);
    recorder.recordAssistantMessage("The header was Authorization: Bearer sk-live-AAAABBBBCCCCDDDD [w1].");
    recorder.finalize();
    const md = readMarkdown(dir);
    assert.ok(!md.includes("sk-live-AAAABBBBCCCCDDDD"), md);
    assert.ok(md.includes("[REDACTED]"), md);
  }));

test("renderStatementsMarkdown marks every statement and lists every citation", () => {
  const md = renderStatementsMarkdown({
    statements: [
      {
        text: "Claim one.",
        evidence: ["w1", "w2"],
        status: "referenced",
        citations: [{ path: "a.ts", line: 3, check: "encountered", walk_id: "w1" }],
      },
      { text: "Claim two.", evidence: [], status: "unreferenced", citations: [] },
    ],
    citations: [{ path: "a.ts", line: 3, check: "encountered", walk_id: "w1" }],
    not_fully_read: false,
  });
  assert.ok(md.includes("[REFERENCED w1, w2]"));
  assert.ok(md.includes("[UNREFERENCED]"));
  assert.ok(md.includes("a.ts:3"));
  assert.ok(md.includes("ENCOUNTERED"));
});

test("the written statements.json validates against the contract statements schema", () =>
  withDir((dir) => {
    const walkPath = writeWalk(dir, [
      { id: "w1", args: { path: "lib/walk.ts" }, content: stamp(1, ["alpha", "beta"]), truncated: true },
    ]);
    const recorder = recorderIn(dir, walkPath);
    recorder.recordAssistantMessage(
      ["The recorder appends [w1] at lib/walk.ts:2.", "", "An unreferenced inference."].join("\n"),
    );
    recorder.finalize();
    const problems = validateStatementsWithContract(dir);
    if (problems === undefined) return; // no uv on PATH
    assert.equal(problems, "", problems);
  }));

// ------------------------------------------------------------------ hooks

test("the extension installs the statements hooks and writes the artifact from fake events", async () => {
  const root = mkdtempSync(join(tmpdir(), "associate-runs-"));
  const checkout = mkdtempSync(join(tmpdir(), "associate-checkout-"));
  const loaded = await loadExtension({
    ASSOCIATE_EXPORT_ROOT: root,
    ASSOCIATE_CHECKOUT_ROOT: checkout,
    ASSOCIATE_SESSION_ID: "stmt-session",
  });
  try {
    const exportDir = join(root, "stmt-session", "export");
    const { pi } = loaded;

    // One recorded read, so a citation has something to resolve into.
    const toolCallId = "tc-1";
    for (const handler of pi.handlers.get("tool_call") ?? []) {
      await handler({ toolName: "read", toolCallId, input: { path: "a.ts" } });
    }
    for (const handler of pi.handlers.get("tool_result") ?? []) {
      await handler({
        toolName: "read",
        toolCallId,
        input: { path: "a.ts" },
        content: [{ type: "text", text: stamp(1, ["alpha", "beta"]) }],
      });
    }

    // An assistant message that still calls a tool is not a hand-back.
    for (const handler of pi.handlers.get("message_end") ?? []) {
      await handler({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Looking." }, { type: "toolCall", toolName: "read" }],
        },
      });
    }
    // The final, prose-only assistant message is the statements artifact.
    for (const handler of pi.handlers.get("message_end") ?? []) {
      await handler({
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "The file opens with alpha at a.ts:1 [w1].\n\nI would rename it.",
            },
          ],
        },
      });
    }
    for (const handler of pi.handlers.get("session_shutdown") ?? []) {
      await handler({});
    }

    const artifact = JSON.parse(
      readFileSync(join(exportDir, STATEMENTS_JSON_FILENAME), "utf8"),
    ) as {
      statements: Array<{ text: string; status: string }>;
      citations: Array<{ check: string }>;
      not_fully_read: boolean;
    };
    assert.deepEqual(
      artifact.statements.map((s) => s.status),
      ["referenced", "unreferenced"],
    );
    assert.ok(!artifact.statements.some((s) => s.text.includes("Looking")));
    assert.equal(artifact.citations[0].check, "encountered");
    assert.equal(artifact.not_fully_read, false);

    const md = readFileSync(join(exportDir, STATEMENTS_MD_FILENAME), "utf8");
    assert.ok(md.includes("UNREFERENCED"), md);
  } finally {
    loaded.cleanup();
    rmSync(root, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});
