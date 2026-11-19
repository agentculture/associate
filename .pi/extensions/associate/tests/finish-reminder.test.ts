/**
 * The finish reminder (deviation d3, issue #38).
 *
 * A model sometimes ends its task turn without calling `finish`, writing its
 * hand-back as a plain final message, and the export then holds no facts.json,
 * check.json or answer.md. When the run is about to settle (pi's
 * `agent_before_settle`) and no finish was accepted, the extension sends the
 * contract's reminder text once and asks pi for one more agent run.
 *
 * Driven against a fake pi: `settle()` below plays pi's boundary dispatch, each
 * handler seeing the entries proposed by the ones before it. pi itself is not
 * run here; one live probe of the mechanism with a throwaway extension is all
 * that has been seen of the real event (see CLAUDE.md).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { finishReminderSettings, loadContract } from "../lib/contract.ts";
import {
  FINISH_REMINDER_ENV,
  REMINDER_FILENAME,
  REMINDER_MESSAGE_TYPE,
  resolveFinishReminder,
} from "../lib/reminder.ts";
import { WALK_FILENAME } from "../lib/walk.ts";
import type { FakePi } from "./load-extension.ts";
import {
  BAD_PAYLOAD,
  EXPORT_FILES,
  GOOD_PAYLOAD,
  callFinish,
  contractCopy,
  openSession,
  scenario,
} from "./support-scenario.ts";

const ACCURACY = loadContract({}).accuracy;
const SHIPPED = ACCURACY.finish_reminder!;
const ON = { [FINISH_REMINDER_ENV]: "on" };
const GOLDEN = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "support-off-golden.json"), "utf8"))
  .steps as Record<string, Record<string, string | null>>;
const SETTLE = "agent_before_settle";

interface Boundary {
  entries: Array<Record<string, unknown>>;
  continue: boolean;
}

/** pi's boundary dispatch: every handler in order, each seeing the proposal so far. */
async function settle(
  pi: FakePi,
  options: { outcome?: string; canContinue?: boolean; entries?: Array<Record<string, unknown>> } = {},
): Promise<Boundary> {
  let state: Boundary & Record<string, unknown> = {
    type: SETTLE,
    entries: options.entries ?? [],
    continue: false,
    outcome: options.outcome ?? "completed",
    context: { canContinue: options.canContinue ?? false, contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [] },
  };
  for (const handler of pi.handlers.get(SETTLE) ?? []) {
    const result = (await handler(state, {})) as Partial<Boundary> | undefined;
    if (!result) continue;
    state = {
      ...state,
      ...(result.entries !== undefined ? { entries: result.entries } : {}),
      ...(result.continue !== undefined ? { continue: result.continue } : {}),
    };
  }
  return { entries: state.entries, continue: state.continue };
}

function reminderLines(exportDir: string): any[] {
  const path = join(exportDir, WALK_FILENAME);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((record) => "reminder" in record)
    .map((record) => record.reminder);
}

function reminderRecord(exportDir: string): unknown {
  const path = join(exportDir, REMINDER_FILENAME);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

async function shutdown(pi: FakePi): Promise<void> {
  for (const handler of pi.handlers.get("session_shutdown") ?? []) await handler({});
}

async function refuseWithoutPurpose(pi: FakePi, n: number): Promise<void> {
  const decision = (await pi.fireToolCall({ type: "tool_call", toolName: "read", toolCallId: `tc-np-${n}`, input: { path: "a.py" } })) as any;
  assert.equal(decision?.block, true, "a call without a purpose is refused");
}

// ------------------------------------------------------------ contract reader

test("the shipped contract has a finish_reminder section: one reminder, wording about finish", () => {
  const got = finishReminderSettings(ACCURACY);
  assert.equal(got.problem, undefined);
  assert.equal(got.settings, SHIPPED);
  assert.equal(SHIPPED.max, 1);
  assert.match(SHIPPED.text, /finish/);
});

test("finishReminderSettings: no section is no reminder and no problem", () => {
  const { finish_reminder: _dropped, ...older } = ACCURACY;
  assert.deepEqual(finishReminderSettings(older), {});
  assert.deepEqual(finishReminderSettings(undefined), {});
});

test("finishReminderSettings refuses a malformed section with a problem and no settings", () => {
  const cases: unknown[] = [
    "on",
    [],
    null,
    { ...SHIPPED, max: 0 },
    { ...SHIPPED, max: 1.5 },
    { ...SHIPPED, max: "1" },
    { ...SHIPPED, max: true },
    { ...SHIPPED, text: "  " },
    { ...SHIPPED, text: 3 },
    { text: SHIPPED.text },
    { max: 1 },
  ];
  for (const section of cases) {
    const got = finishReminderSettings({ finish_reminder: section } as never);
    assert.equal(got.settings, undefined, JSON.stringify(section));
    assert.match(got.problem ?? "", /finish_reminder/, JSON.stringify(section));
  }
});

// ------------------------------------------------------------ the switch

test("the variable is ASSOCIATE_FINISH_REMINDER", () => {
  assert.equal(FINISH_REMINDER_ENV, "ASSOCIATE_FINISH_REMINDER");
});

test("absent, blank or off: no reminder, and nothing to say", () => {
  for (const env of [{}, { [FINISH_REMINDER_ENV]: "" }, { [FINISH_REMINDER_ENV]: "  " }, { [FINISH_REMINDER_ENV]: "off" }]) {
    assert.deepEqual(resolveFinishReminder(ACCURACY, env), {}, JSON.stringify(env));
  }
});

test("on: the contract's settings", () => {
  assert.deepEqual(resolveFinishReminder(ACCURACY, ON), { settings: SHIPPED });
  assert.deepEqual(resolveFinishReminder(ACCURACY, { [FINISH_REMINDER_ENV]: " on\n" }), { settings: SHIPPED });
});

test("on without a section, or with a malformed one: no reminder, one problem line", () => {
  const { finish_reminder: _dropped, ...older } = ACCURACY;
  const missing = resolveFinishReminder(older, ON);
  assert.equal(missing.settings, undefined);
  assert.match(missing.problem ?? "", /ASSOCIATE_FINISH_REMINDER=on/);
  const bad = resolveFinishReminder({ ...ACCURACY, finish_reminder: { ...SHIPPED, max: 0 } } as never, ON);
  assert.equal(bad.settings, undefined);
  assert.match(bad.problem ?? "", /finish_reminder/);
});

test("any other value: no reminder, one problem line naming the value", () => {
  const got = resolveFinishReminder(ACCURACY, { [FINISH_REMINDER_ENV]: "yes" });
  assert.equal(got.settings, undefined);
  assert.match(got.problem ?? "", /"yes"/);
});

// ------------------------------------------------------------ the session

test("switched on, a run that settles without finish is reminded once, with the contract's text", async () => {
  const s = await openSession(ON);
  try {
    const earlier = { type: "custom", customType: "another-extension" };
    const first = await settle(s.pi, { entries: [earlier] });
    assert.equal(first.continue, true, "pi is asked for one more agent run");
    assert.equal(first.entries.length, 2, "an earlier handler's entry is kept");
    assert.deepEqual(first.entries[0], earlier);
    assert.deepEqual(first.entries[1], {
      type: "custom_message",
      customType: REMINDER_MESSAGE_TYPE,
      content: SHIPPED.text,
      display: false,
    });
    assert.deepEqual(reminderRecord(s.exportDir), { sent: 1, finish_followed: false });
    const lines = reminderLines(s.exportDir);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].id, "r1");
    assert.equal(lines[0].max, SHIPPED.max);
    assert.equal(typeof lines[0].ts, "string");

    // The model again stops without finish: the budget of one is spent.
    const second = await settle(s.pi);
    assert.equal(second.continue, false);
    assert.deepEqual(second.entries, []);
    assert.equal(reminderLines(s.exportDir).length, 1);
    assert.deepEqual(reminderRecord(s.exportDir), { sent: 1, finish_followed: false });
  } finally {
    s.dispose();
  }
});

test("a finish after the reminder is recorded as followed", async () => {
  const s = await openSession(ON);
  try {
    assert.equal((await settle(s.pi)).continue, true);
    await callFinish(s.pi, "fin-1", GOOD_PAYLOAD);
    await s.pi.fireToolExecutionEnd({ toolCallId: "fin-1", toolName: "finish", isError: false, result: {} });
    assert.deepEqual(reminderRecord(s.exportDir), { sent: 1, finish_followed: true });
    assert.equal((await settle(s.pi)).continue, false, "a finished run is not reminded");
    for (const name of EXPORT_FILES) assert.ok(existsSync(join(s.exportDir, name)), `${name} written by the finish`);
  } finally {
    s.dispose();
  }
});

test("the reminder text is read from the contract, not written in code", async () => {
  const copy = contractCopy((accuracy) => {
    accuracy.finish_reminder.text = "Call finish, please.";
    accuracy.finish_reminder.max = 2;
  });
  const s = await openSession({ ...ON, ASSOCIATE_CONTRACT_DIR: copy.dir });
  try {
    const first = await settle(s.pi);
    assert.equal(first.entries[0]?.content, "Call finish, please.");
    assert.equal((await settle(s.pi)).continue, true, "max 2 allows a second reminder");
    assert.equal((await settle(s.pi)).continue, false);
    assert.deepEqual(reminderRecord(s.exportDir), { sent: 2, finish_followed: false });
    assert.deepEqual(reminderLines(s.exportDir).map((line) => line.id), ["r1", "r2"]);
  } finally {
    s.dispose();
    copy.dispose();
  }
});

for (const [label, env] of [
  ["absent (the mesh resident, a spawned child)", { [FINISH_REMINDER_ENV]: undefined }],
  ["off", { [FINISH_REMINDER_ENV]: "off" }],
] as const) {
  test(`switch ${label}: no settle handler is registered at all`, async () => {
    const s = await openSession(env);
    try {
      assert.equal((s.pi.handlers.get(SETTLE) ?? []).length, 0);
      assert.equal(existsSync(join(s.exportDir, REMINDER_FILENAME)), false);
    } finally {
      s.dispose();
    }
  });
}

test("switched on with no section in the contract: no handler, one stderr line", async () => {
  const copy = contractCopy((accuracy) => {
    delete accuracy.finish_reminder;
  });
  const s = await openSession({ ...ON, ASSOCIATE_CONTRACT_DIR: copy.dir });
  try {
    assert.equal((s.pi.handlers.get(SETTLE) ?? []).length, 0);
    assert.equal(s.errors.filter((line) => line.includes(FINISH_REMINDER_ENV)).length, 1, s.errors.join("\n"));
  } finally {
    s.dispose();
    copy.dispose();
  }
});

test("an aborted run or a run that ended in an error is not reminded", async () => {
  const s = await openSession(ON);
  try {
    for (const options of [{ outcome: "aborted" }, { outcome: "error" }]) {
      const got = await settle(s.pi, options);
      assert.equal(got.continue, false, JSON.stringify(options));
      assert.deepEqual(got.entries, [], JSON.stringify(options));
    }
    assert.equal(existsSync(join(s.exportDir, REMINDER_FILENAME)), false);
    assert.equal(reminderLines(s.exportDir).length, 0);
    assert.equal((await settle(s.pi)).continue, true, "the budget was not spent on them");
  } finally {
    s.dispose();
  }
});

test("a run whose finish was accepted is not reminded", async () => {
  const s = await openSession(ON);
  try {
    await callFinish(s.pi, "fin-1", BAD_PAYLOAD);
    assert.equal((await settle(s.pi)).continue, false);
    assert.equal(existsSync(join(s.exportDir, REMINDER_FILENAME)), false);
  } finally {
    s.dispose();
  }
});

test("enforce: a refused hand-back with rounds left may still be reminded once", async () => {
  const s = await openSession({ ...ON, ASSOCIATE_CHECK_MODE: "enforce" });
  try {
    const refused = await callFinish(s.pi, "fin-1", BAD_PAYLOAD);
    assert.equal(refused.details?.outcome, "refused");
    assert.equal(refused.details?.run_ended, false, "fixture assumption: rounds are left");
    await s.pi.fireToolExecutionEnd({ toolCallId: "fin-1", toolName: "finish", isError: false, result: {} });
    assert.equal(existsSync(join(s.exportDir, REMINDER_FILENAME)), false, "a finish before any reminder is not a follow");
    assert.equal((await settle(s.pi)).continue, true);
    assert.deepEqual(reminderRecord(s.exportDir), { sent: 1, finish_followed: false });
    assert.equal((await settle(s.pi)).continue, false, "the same budget of one");
  } finally {
    s.dispose();
  }
});

test("enforce: a hand-back refused for its last round is not reminded", async () => {
  const copy = contractCopy((accuracy) => {
    accuracy.retry_rounds = 0;
  });
  const s = await openSession({ ...ON, ASSOCIATE_CHECK_MODE: "enforce", ASSOCIATE_CONTRACT_DIR: copy.dir });
  try {
    const refused = await callFinish(s.pi, "fin-1", BAD_PAYLOAD);
    assert.equal(refused.details?.run_ended, true, "fixture assumption: no round is left");
    assert.equal((await settle(s.pi)).continue, false);
    assert.equal(existsSync(join(s.exportDir, REMINDER_FILENAME)), false);
  } finally {
    s.dispose();
    copy.dispose();
  }
});

test("a run the refusal cap ended (outcome refused) is not reminded", async () => {
  const s = await openSession(ON);
  try {
    const cap = loadContract({}).accuracy.refusal_cap;
    for (let n = 1; n <= cap; n += 1) await refuseWithoutPurpose(s.pi, n);
    for (const handler of s.pi.handlers.get("agent_end") ?? []) await handler({ type: "agent_end", messages: [] }, {});
    assert.equal((await settle(s.pi)).continue, false);
    assert.equal(existsSync(join(s.exportDir, REMINDER_FILENAME)), false);
  } finally {
    s.dispose();
  }
});

test("a reminder line takes no walk id, and a later tool entry keeps the next w id", async () => {
  const s = await openSession(ON);
  try {
    await settle(s.pi);
    await s.pi.fireToolResult({
      toolCallId: "tc-read-2",
      toolName: "read",
      input: { path: "roles.py", purpose: "look again" },
      content: [{ type: "text", text: "x" }],
    });
    await shutdown(s.pi);
    const records = readFileSync(join(s.exportDir, WALK_FILENAME), "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    assert.deepEqual(records.filter((r) => typeof r.tool === "string").map((r) => r.id), ["w1", "w2"]);
    assert.equal(records.filter((r) => "reminder" in r).length, 1);
    assert.equal(records.at(-1).run.tool_calls, 2, "a reminder is not a tool call");
  } finally {
    s.dispose();
  }
});

// ------------------------------------------------------------ byte-identical

for (const [label, env] of [
  ["on", ON],
  ["off", { [FINISH_REMINDER_ENV]: "off" }],
  ["absent", { [FINISH_REMINDER_ENV]: undefined }],
] as const) {
  test(`switch ${label}, no reminder sent: every hand-back file matches the golden export byte for byte`, async () => {
    const steps = await scenario(env);
    for (const [step, files] of Object.entries(steps)) {
      for (const name of EXPORT_FILES) {
        assert.equal(files[name], GOLDEN[step][name], `${step}/${name} (${label})`);
      }
    }
  });
}

test("switch on, a finished run that settles: no reminder file, no reminder line, the same walk as switch off", async () => {
  const walks: string[] = [];
  for (const env of [ON, { [FINISH_REMINDER_ENV]: "off" }]) {
    const s = await openSession(env);
    try {
      await callFinish(s.pi, "fin-1", GOOD_PAYLOAD);
      await settle(s.pi);
      await shutdown(s.pi);
      assert.equal(existsSync(join(s.exportDir, REMINDER_FILENAME)), false);
      assert.equal(reminderLines(s.exportDir).length, 0);
      // Timestamps and the duration differ between two runs; everything else is compared.
      walks.push(
        readFileSync(join(s.exportDir, WALK_FILENAME), "utf8")
          .replace(/"ts":"[^"]*"/g, '"ts":""')
          .replace(/"duration_ms":\d+/g, '"duration_ms":0'),
      );
    } finally {
      s.dispose();
    }
  }
  assert.equal(walks[0], walks[1]);
});

test("a run is reminded although pi says it cannot continue yet (seen live on pi 1.5.2)", async () => {
  // Before the reminder is added the context ends with the model's own
  // message, so pi 1.5.2 hands the handler `canContinue: false` on every
  // ordinary settle; it continues once the reminder entry is appended. A trial
  // run on 2026-11-19 ended without finish and without a reminder because this
  // flag was read as a reason not to send one.
  const s = await openSession(ON);
  try {
    const got = await settle(s.pi, { canContinue: false });
    assert.equal(got.continue, true);
    assert.equal(got.entries.length, 1);
    assert.equal(reminderLines(s.exportDir).length, 1);
  } finally {
    s.dispose();
  }
});
