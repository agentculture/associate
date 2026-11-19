/**
 * The final message file (`final_message.md`).
 *
 * `statements.json` holds the model's prose split into statements, and the
 * split drops headings, list markers and fenced code. A run that ends without
 * `finish` leaves no `answer.md`, so the whole of its last message was kept
 * nowhere (the run result keeps a bounded tail). This file is that message,
 * redacted and otherwise as the model wrote it.
 *
 * Driven with fake Pi `message_end` events through the loaded extension. The
 * statements files are compared byte for byte with what a recorder on its own
 * writes from the same walk and message: the new file changes neither.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContract } from "../lib/contract.ts";
import { FINAL_MESSAGE_FILENAME } from "../lib/finalmessage.ts";
import {
  STATEMENTS_JSON_FILENAME,
  STATEMENTS_MD_FILENAME,
  StatementsRecorder,
} from "../lib/statements.ts";
import { WALK_FILENAME } from "../lib/walk.ts";
import { loadExtension, type FakePi } from "./load-extension.ts";

const MESSAGE = [
  "## What it is",
  "",
  "A rules engine [w1].",
  "",
  "- **lint:** `black --check` [w1]",
  "1. first step",
  "",
  "```bash",
  "uv run pytest -n auto",
  "```",
  "",
  "| verb | does |",
  "| --- | --- |",
  "| run | starts it |",
].join("\n");

async function say(pi: FakePi, content: unknown): Promise<void> {
  for (const handler of pi.handlers.get("message_end") ?? []) {
    await handler({ message: { role: "assistant", content } });
  }
}

async function withRun(
  session: string,
  body: (pi: FakePi, exportDir: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "associate-runs-"));
  const checkout = mkdtempSync(join(tmpdir(), "associate-checkout-"));
  const loaded = await loadExtension({
    ASSOCIATE_EXPORT_ROOT: root,
    ASSOCIATE_CHECKOUT_ROOT: checkout,
    ASSOCIATE_SESSION_ID: session,
  });
  try {
    await body(loaded.pi, join(root, session, "export"));
  } finally {
    loaded.cleanup();
    rmSync(root, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
}

test("the final message is saved whole: headings, list markers, code and table rows", () =>
  withRun("final-whole", async (pi, exportDir) => {
    await say(pi, [{ type: "text", text: MESSAGE }]);
    assert.equal(readFileSync(join(exportDir, FINAL_MESSAGE_FILENAME), "utf8"), MESSAGE);
  }));

test("no final message file is written before the model says anything in prose", () =>
  withRun("final-none", async (pi, exportDir) => {
    await say(pi, [{ type: "text", text: "Looking." }, { type: "toolCall", toolName: "read" }]);
    assert.equal(existsSync(join(exportDir, FINAL_MESSAGE_FILENAME)), false);
  }));

test("a later prose message replaces the earlier one; a message calling a tool does not", () =>
  withRun("final-last", async (pi, exportDir) => {
    await say(pi, [{ type: "text", text: "First answer." }]);
    await say(pi, [{ type: "text", text: "# Second\n\n- the answer" }]);
    await say(pi, [{ type: "text", text: "Looking." }, { type: "toolCall", toolName: "read" }]);
    assert.equal(
      readFileSync(join(exportDir, FINAL_MESSAGE_FILENAME), "utf8"),
      "# Second\n\n- the answer",
    );
  }));

test("the final message file is redacted like every other export file", () =>
  withRun("final-redacted", async (pi, exportDir) => {
    await say(pi, [{ type: "text", text: "## Key\n\nIt was sk-AAAABBBBCCCCDDDDEEEE in the file." }]);
    const saved = readFileSync(join(exportDir, FINAL_MESSAGE_FILENAME), "utf8");
    assert.ok(!saved.includes("sk-AAAABBBBCCCCDDDDEEEE"), saved);
    assert.ok(saved.startsWith("## Key\n\nIt was "), saved);
  }));

test("the statements files are byte-identical to what the recorder alone writes", () =>
  withRun("final-same", async (pi, exportDir) => {
    await say(pi, [{ type: "text", text: MESSAGE }]);
    for (const handler of pi.handlers.get("session_shutdown") ?? []) await handler({});

    const alone = mkdtempSync(join(tmpdir(), "associate-stmt-alone-"));
    try {
      const walkPath = join(alone, WALK_FILENAME);
      if (existsSync(join(exportDir, WALK_FILENAME))) {
        copyFileSync(join(exportDir, WALK_FILENAME), walkPath);
      }
      const recorder = new StatementsRecorder({
        exportDir: alone,
        walkPath,
        policy: loadContract({}).policy,
        installExitHook: false,
      });
      recorder.recordAssistantMessage(MESSAGE);
      recorder.finalize();
      for (const name of [STATEMENTS_JSON_FILENAME, STATEMENTS_MD_FILENAME]) {
        assert.equal(
          readFileSync(join(exportDir, name), "utf8"),
          readFileSync(join(alone, name), "utf8"),
          name,
        );
      }
    } finally {
      rmSync(alone, { recursive: true, force: true });
    }
  }));
