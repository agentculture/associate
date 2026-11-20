/**
 * A finish session for the support-score tests (decider-score plan task t3),
 * and one fixed scenario whose export files are compared byte for byte.
 *
 * Not a test file itself (no `.test.ts`): `support-finish.test.ts` imports it,
 * and the golden file `fixtures/support-off-golden.json` was written by running
 * `scenario()` against the extension as it was before the score was wired in
 * (commit 31c6747), so "switch off" can be compared with what the branch wrote
 * before this task.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtension, type FakePi } from "./load-extension.ts";
import { associateRoot } from "../lib/paths.ts";

export const CONTRACT_DIR = join(associateRoot, "associate", "contract");

/** The saved text of the one read the walk records as w1. */
export const READ_TEXT = [
  "1\tROLE_RESPONSIBILITIES = {",
  "2\t    \"worker\": [\"execution\", \"tool_use\", \"repo_inspection\"],",
  "3\t    \"senses\": [\"intake\", \"normalize_input\"],",
  "4\t}",
].join("\n");

export const GOOD_FACT = {
  id: "f1",
  value: "ROLE_RESPONSIBILITIES",
  source: "w1",
  quote: "ROLE_RESPONSIBILITIES = {",
};
export const SECOND_GOOD_FACT = {
  id: "f3",
  value: "worker",
  source: "w1",
  quote: "\"worker\": [\"execution\"",
};
export const BAD_FACT = {
  id: "f2",
  value: "pyproject.toml",
  source: "w1",
  quote: "a content-identical copy sits in pyproject.toml",
};

export const GOOD_PAYLOAD = {
  summary: "The role table is a dict.",
  facts: [GOOD_FACT],
  verdicts: [{ id: "v1", text: "The role table is defined in the file read.", verdict: "supported", basis: ["f1"] }],
};
export const BAD_PAYLOAD = {
  summary: "The role table is a dict.",
  facts: [GOOD_FACT, BAD_FACT, SECOND_GOOD_FACT],
  verdicts: [{ id: "v1", text: "A copy sits in pyproject.toml.", verdict: "supported", basis: ["f2"] }],
};

export const FINAL_MESSAGE = "The role table is a dict. It has two roles.";

export interface Session {
  pi: FakePi;
  exportDir: string;
  errors: string[];
  dispose: () => void;
}

/** A contract directory copy with accuracy.json edited by `edit`. */
export function contractCopy(edit: (accuracy: Record<string, any>) => void): { dir: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "associate-contract-"));
  const dir = join(root, "contract");
  cpSync(CONTRACT_DIR, dir, { recursive: true });
  const path = join(dir, "accuracy.json");
  const accuracy = JSON.parse(readFileSync(path, "utf8"));
  edit(accuracy);
  writeFileSync(path, JSON.stringify(accuracy, null, 2));
  return { dir, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

export async function startPrompt(pi: FakePi, prompt: string): Promise<void> {
  for (const handler of pi.handlers.get("before_agent_start") ?? []) {
    await handler({ type: "before_agent_start", prompt, systemPrompt: "" }, {});
  }
}

/**
 * A session the extension was loaded into directly, with one recorded read
 * (w1) whose saved text is READ_TEXT. `env` is applied while the extension
 * loads (it snapshots what it reads then).
 */
export async function openSession(env: Record<string, string | undefined> = {}): Promise<Session> {
  const root = mkdtempSync(join(tmpdir(), "associate-runs-"));
  const checkout = mkdtempSync(join(tmpdir(), "associate-checkout-"));
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  let loaded: Awaited<ReturnType<typeof loadExtension>>;
  try {
    loaded = await loadExtension({
      ASSOCIATE_EXPORT_ROOT: root,
      ASSOCIATE_CHECKOUT_ROOT: checkout,
      ASSOCIATE_SESSION_ID: "support-finish",
      ASSOCIATE_INJECT_PROMPT: undefined,
      ASSOCIATE_CONTINUE_FROM: undefined,
      ASSOCIATE_MODEL: undefined,
      ASSOCIATE_CHECK_MODE: undefined,
      ASSOCIATE_SUPPORT_SCORE: undefined,
      ASSOCIATE_API_KEY: undefined,
      ASSOCIATE_BASE_URL: undefined,
      // Strict facts pinned off (t5): the golden exports are the report/enforce flow.
      ASSOCIATE_STRICT: "off",
      ...env,
    });
  } finally {
    console.error = original;
  }
  const { pi } = loaded;
  await pi.fireSessionStart();
  await startPrompt(pi, "find the role table");
  await pi.fireToolResult({
    toolCallId: "tc-read-1",
    toolName: "read",
    input: { path: "roles.py", purpose: "find the role table" },
    content: [{ type: "text", text: READ_TEXT }],
  });
  const exportDir = join(root, "support-finish", "export");
  return {
    pi,
    exportDir,
    errors,
    dispose: () => {
      loaded.cleanup();
      rmSync(root, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    },
  };
}

/** Call finish the way pi does: tool_call hook, execute, then the tool_result chain. */
export async function callFinish(pi: FakePi, id: string, params: Record<string, unknown>): Promise<any> {
  const decision = (await pi.fireToolCall({ type: "tool_call", toolName: "finish", toolCallId: id, input: params })) as any;
  if (decision?.block === true) throw new Error(`finish itself must not be blocked: ${JSON.stringify(decision)}`);
  const result = (await pi.tool("finish").execute(id, params)) as any;
  await pi.fireToolResult({ toolCallId: id, toolName: "finish", input: params, ...result });
  return result;
}

export async function fireFinalMessage(pi: FakePi, text: string): Promise<void> {
  const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } };
  for (const handler of pi.handlers.get("message_end") ?? []) await handler(event);
}

export const EXPORT_FILES = ["facts.json", "check.json", "report.json", "answer.md"] as const;

/** The export files as text; a missing file is null. */
export function snapshot(exportDir: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const name of EXPORT_FILES) {
    const path = join(exportDir, name);
    out[name] = existsSync(path) ? readFileSync(path, "utf8") : null;
  }
  return out;
}

/**
 * The fixed scenario: report mode (finish with a failing hand-back, then a
 * final message), then enforce mode (a refused round, an accepted round, a
 * final message). Each step's export files, in order.
 */
export async function scenario(env: Record<string, string | undefined> = {}): Promise<Record<string, Record<string, string | null>>> {
  const steps: Record<string, Record<string, string | null>> = {};
  const report = await openSession(env);
  try {
    await callFinish(report.pi, "fin-1", BAD_PAYLOAD);
    steps.report_finish = snapshot(report.exportDir);
    await fireFinalMessage(report.pi, FINAL_MESSAGE);
    steps.report_final_message = snapshot(report.exportDir);
  } finally {
    report.dispose();
  }
  const enforce = await openSession({ ...env, ASSOCIATE_CHECK_MODE: "enforce" });
  try {
    await callFinish(enforce.pi, "fin-1", BAD_PAYLOAD);
    steps.enforce_refused = snapshot(enforce.exportDir);
    await callFinish(enforce.pi, "fin-2", GOOD_PAYLOAD);
    steps.enforce_accepted = snapshot(enforce.exportDir);
    await fireFinalMessage(enforce.pi, FINAL_MESSAGE);
    steps.enforce_final_message = snapshot(enforce.exportDir);
  } finally {
    enforce.dispose();
  }
  return steps;
}
