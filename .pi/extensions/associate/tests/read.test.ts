// Tests for the `read` tool (task t5, plan
// associate-on-pi-with-opinionated-tools).
//
// `register()` is called directly against a minimal fake `pi` — the tool's
// own behavior is what is under test here, not the extension's loading
// machinery (that is extension.test.ts / runtime.test.ts). Budgets are read
// from the REAL contract at associate/contract/policy.json wherever the test
// does not need to force truncation with a smaller override.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssociateContext } from "../lib/runtime.ts";
import { loadContract } from "../lib/contract.ts";
import { register, signCursor } from "../tools/read.ts";
import type { AssociateContext } from "../lib/context.ts";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface RegisteredTool {
  name: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
}

class FakePi {
  tools: RegisteredTool[] = [];
  registerTool(definition: RegisteredTool): void {
    this.tools.push(definition);
  }
  tool(name: string): RegisteredTool {
    const found = this.tools.find((t) => t.name === name);
    if (!found) throw new Error(`no tool named ${name}`);
    return found;
  }
}

interface Harness {
  ctx: AssociateContext;
  checkout: string;
  readTool: RegisteredTool;
  dispose: () => void;
}

/** Build a context + registered `read` tool over a scratch checkout. */
async function harness(options: { maxBytes?: number } = {}): Promise<Harness> {
  const runsRoot = mkdtempSync(join(tmpdir(), "associate-runs-"));
  const checkout = mkdtempSync(join(tmpdir(), "associate-checkout-"));
  const env = { ASSOCIATE_EXPORT_ROOT: runsRoot, ASSOCIATE_SESSION_ID: "read-test" };

  let contract;
  if (options.maxBytes !== undefined) {
    const base = loadContract(env);
    contract = {
      ...base,
      policy: {
        ...base.policy,
        budgets: {
          ...(base.policy.budgets as Record<string, unknown>),
          read: {
            ...(base.policy.budgets as Record<string, Record<string, unknown>>).read,
            max_bytes: options.maxBytes,
          },
        },
      },
    };
  }

  const ctx = createAssociateContext({ checkoutRoot: checkout, env, contract });
  const pi = new FakePi();
  await register(pi as unknown as Parameters<typeof register>[0], ctx);

  return {
    ctx,
    checkout,
    readTool: pi.tool("read"),
    dispose: () => {
      rmSync(runsRoot, { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    },
  };
}

function write(checkout: string, rel: string, content: string): void {
  writeFileSync(join(checkout, rel), content, "utf8");
}

function fiveThousandLines(): string {
  return Array.from({ length: 5000 }, (_, i) => `line ${i + 1} of the fixture`).join("\n") + "\n";
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

// ---------------------------------------------------------------------------
// criterion 1 — absolute line numbers regardless of the requested window
// ---------------------------------------------------------------------------

test("reading from line 3400 stamps absolute line numbers, never renumbered from 1", async () => {
  const h = await harness();
  try {
    write(h.checkout, "fixture.txt", fiveThousandLines());
    const result = await h.readTool.execute("call-1", {
      path: "fixture.txt",
      start_line: 3400,
      end_line: 3405,
    });
    const lines = (result.content[0]!.text as string).split("\n");
    assert.deepEqual(
      lines,
      [3400, 3401, 3402, 3403, 3404, 3405].map((n) => `${n}\tline ${n} of the fixture`),
    );
    assert.equal(result.details.start_line, 3400);
    assert.equal(result.details.end_line, 3405);
    assert.equal(result.details.total_lines, 5000);
    assert.equal(result.details.truncated, false);
  } finally {
    h.dispose();
  }
});

test("a read with no window starts at line 1", async () => {
  const h = await harness();
  try {
    write(h.checkout, "small.txt", "alpha\nbeta\ngamma\n");
    const result = await h.readTool.execute("call-2", { path: "small.txt" });
    const lines = (result.content[0]!.text as string).split("\n");
    assert.deepEqual(lines, ["1\talpha", "2\tbeta", "3\tgamma"]);
  } finally {
    h.dispose();
  }
});

// ---------------------------------------------------------------------------
// criterion 2 — byte cap, truncation, continuation cursor
// ---------------------------------------------------------------------------

test("a file larger than the read budget is truncated and carries a cursor; the cursor re-read continues forward", async () => {
  const h = await harness();
  try {
    const fixture = fiveThousandLines();
    write(h.checkout, "big.txt", fixture);

    const first = await h.readTool.execute("call-3", { path: "big.txt" });
    assert.equal(first.details.truncated, true);
    assert.equal(typeof first.details.cursor, "string");

    // Walk the whole cursor chain and reassemble; every intermediate chunk
    // must be a strict forward step (no re-delivered tail) and the walk must
    // terminate.
    let seen = first.content[0]!.text as string;
    let cursor = first.details.cursor as string | undefined;
    let guard = 0;
    while (cursor) {
      const next = await h.readTool.execute("call-3b", { cursor });
      assert.ok(next.content[0]!.text.length > 0, "a continuation chunk must not be empty");
      seen += next.content[0]!.text;
      cursor = next.details.cursor as string | undefined;
      guard += 1;
      assert.ok(guard < 10_000, "continuation did not terminate");
    }

    const wholeStamped = fixture
      .split("\n")
      .slice(0, -1) // trailing empty element from the final "\n"
      .map((line, i) => `${i + 1}\t${line}`)
      .join("\n");
    assert.equal(seen, wholeStamped, "concatenating every chunk reproduces the full stamped file exactly once");
  } finally {
    h.dispose();
  }
});

// ---------------------------------------------------------------------------
// multibyte — the recorded lapse: bounded output must never exceed max_bytes
// ---------------------------------------------------------------------------

test("a byte cap smaller than the char cap forces truncation on CJK/emoji content, and every chunk stays within max_bytes", async () => {
  // Each line is heavy multibyte (CJK ideographs + emoji); with a max_bytes
  // set below what the char/line budget alone would allow, the byte cap is
  // the actually-binding constraint.
  const h = await harness({ maxBytes: 2000 });
  try {
    const line = "日本語テスト行😀🎉多字节字符";
    const content = Array.from({ length: 300 }, (_, i) => `${line}${i}`).join("\n") + "\n";
    write(h.checkout, "multibyte.txt", content);

    const maxBytes = (h.ctx.policy.budgets as { read: { max_bytes?: number } }).read.max_bytes!;

    let result = await h.readTool.execute("call-4", { path: "multibyte.txt" });
    assert.equal(result.details.truncated, true);
    let guard = 0;
    let sawTruncated = false;
    for (;;) {
      const text = result.content[0]!.text as string;
      assert.ok(
        utf8Bytes(text) <= maxBytes,
        `chunk is ${utf8Bytes(text)} utf-8 bytes, over the ${maxBytes}-byte budget`,
      );
      if (result.details.truncated) sawTruncated = true;
      const cursor = result.details.cursor as string | undefined;
      if (!cursor) break;
      guard += 1;
      assert.ok(guard < 10_000, "continuation did not terminate");
      result = await h.readTool.execute("call-4", { cursor });
    }
    assert.ok(sawTruncated, "the read must actually have been truncated at least once");
  } finally {
    h.dispose();
  }
});

// ---------------------------------------------------------------------------
// criterion 3 — denylist and malformed arguments
// ---------------------------------------------------------------------------

test("a read of .env is refused with a structured error", async () => {
  const h = await harness();
  try {
    write(h.checkout, ".env", "SECRET=1\n");
    const result = await h.readTool.execute("call-5", { path: ".env" });
    const payload = JSON.parse(result.content[0]!.text as string);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "path_denied");
    assert.equal(payload.field, "path");
  } finally {
    h.dispose();
  }
});

test("a path escaping the checkout is refused with a structured error naming the path", async () => {
  const h = await harness();
  try {
    const result = await h.readTool.execute("call-6", { path: "../../etc/passwd" });
    const payload = JSON.parse(result.content[0]!.text as string);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "path_escapes_root");
    assert.equal(payload.field, "path");
  } finally {
    h.dispose();
  }
});

test("a malformed argument set (missing path) returns an error naming the field", async () => {
  const h = await harness();
  try {
    const result = await h.readTool.execute("call-7", {});
    const payload = JSON.parse(result.content[0]!.text as string);
    assert.equal(payload.ok, false);
    assert.equal(payload.field, "path");
  } finally {
    h.dispose();
  }
});

test("a malformed argument set (wrong type) names the offending field", async () => {
  const h = await harness();
  try {
    write(h.checkout, "ok.txt", "hi\n");
    const result = await h.readTool.execute("call-8", { path: "ok.txt", start_line: "not-a-number" });
    const payload = JSON.parse(result.content[0]!.text as string);
    assert.equal(payload.ok, false);
    assert.equal(payload.field, "start_line");
  } finally {
    h.dispose();
  }
});

test("respects the checkout's .gitignore", async () => {
  const h = await harness();
  try {
    write(h.checkout, ".gitignore", "ignored/\n");
    mkdirSync(join(h.checkout, "ignored"), { recursive: true });
    write(h.checkout, "ignored/secret.txt", "shh\n");
    const result = await h.readTool.execute("call-9", { path: "ignored/secret.txt" });
    const payload = JSON.parse(result.content[0]!.text as string);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "path_denied");
  } finally {
    h.dispose();
  }
});

// ---------------------------------------------------------------------------
// continuation cursors are caller-controlled input (security finding:
// "forged cursors expose denied files")
// ---------------------------------------------------------------------------

/** Parse an error result's payload. */
function payloadOf(result: { content: Array<{ text: string }> }): any {
  return JSON.parse(result.content[0]!.text);
}

test("a forged cursor naming an arbitrary file is refused, not read", async () => {
  const h = await harness();
  try {
    for (const spillPath of ["/etc/passwd", "/etc/hostname"]) {
      const forged = JSON.stringify({ offset: 0, total: 10_000, chunkChars: 1000, spillPath });
      const result = await h.readTool.execute("call-forge", { cursor: forged });
      const payload = payloadOf(result);
      assert.equal(payload.ok, false, `${spillPath} was read through a forged cursor`);
      assert.equal(payload.error.code, "cursor_invalid");
      assert.equal(payload.field, "cursor");
      assert.ok(!result.content[0]!.text.includes("root:"), "file content leaked");
    }
  } finally {
    h.dispose();
  }
});

test("a forged cursor naming a denylisted file inside the checkout is refused", async () => {
  const h = await harness();
  try {
    write(h.checkout, ".env", "SECRET=hunter2\n");
    const forged = JSON.stringify({
      offset: 0,
      total: 100,
      chunkChars: 100,
      spillPath: join(h.checkout, ".env"),
    });
    const result = await h.readTool.execute("call-forge-env", { cursor: forged });
    const payload = payloadOf(result);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, "cursor_invalid");
    assert.ok(!result.content[0]!.text.includes("hunter2"), "the secret leaked through a cursor");
  } finally {
    h.dispose();
  }
});

test("a cursor with a tampered offset is refused", async () => {
  const h = await harness();
  try {
    write(h.checkout, "big.txt", fiveThousandLines());
    const first = await h.readTool.execute("call-tamper", { path: "big.txt" });
    const genuine = JSON.parse(first.details.cursor as string);

    for (const tampered of [
      { ...genuine, offset: genuine.offset + 1 },
      { ...genuine, chunkChars: 10_000_000 },
      { ...genuine, spillPath: "/etc/passwd" },
      { ...genuine, tag: "0".repeat(64) },
      { offset: genuine.offset, total: genuine.total, chunkChars: genuine.chunkChars, spillPath: genuine.spillPath },
    ]) {
      const result = await h.readTool.execute("call-tamper-b", { cursor: JSON.stringify(tampered) });
      const payload = payloadOf(result);
      assert.equal(payload.ok, false, `a tampered cursor was accepted: ${JSON.stringify(tampered)}`);
      assert.equal(payload.error.code, "cursor_invalid");
    }

    // …while the untouched one still works.
    const ok = await h.readTool.execute("call-tamper-c", { cursor: first.details.cursor as string });
    assert.ok((ok.content[0]!.text as string).length > 0);
    assert.match(ok.content[0]!.text as string, /^\d+\t/);
  } finally {
    h.dispose();
  }
});

test("even a correctly signed cursor is refused when its spill file is not ours", async () => {
  // Defence in depth: the signature is the first gate, the confinement check
  // the second. A key compromise (or a future bug that signs attacker input)
  // must still not turn the cursor into an arbitrary-file read.
  const h = await harness();
  try {
    const outside = join(h.checkout, "..", "outside.txt");
    writeFileSync(outside, "not a spill file\n", "utf8");
    const budget = (h.ctx.policy.budgets as any).read;

    const cases: Array<[string, Record<string, unknown>]> = [
      ["outside the scratch dir", { offset: 0, total: 10, chunkChars: 10, spillPath: outside }],
      ["no spill file at all", { offset: 0, total: 10, chunkChars: 10 }],
      [
        "a scratch path with a name we never write",
        {
          offset: 0,
          total: 10,
          chunkChars: 10,
          spillPath: join(h.ctx.session.scratchDir, "not-a-spill.txt"),
        },
      ],
    ];
    for (const [why, cursor] of cases) {
      const signed = JSON.stringify({ ...cursor, tag: signCursor(cursor as any) });
      const result = await h.readTool.execute("call-signed", { cursor: signed });
      const payload = payloadOf(result);
      assert.equal(payload.ok, false, `accepted a signed cursor ${why}`);
      assert.equal(payload.error.code, "cursor_invalid");
    }

    // The numeric fields are re-validated too, on a genuine spill file.
    write(h.checkout, "big2.txt", fiveThousandLines());
    const first = await h.readTool.execute("call-signed-b", { path: "big2.txt" });
    const genuine = JSON.parse(first.details.cursor as string);
    const spillPath = genuine.spillPath as string;
    for (const bad of [
      { offset: -1, total: 10, chunkChars: 10, spillPath },
      { offset: 1e12, total: 10, chunkChars: 10, spillPath },
      { offset: 0, total: 10, chunkChars: 0, spillPath },
      { offset: 0, total: 10, chunkChars: budget.max_output_chars + 1, spillPath },
      { offset: 0.5, total: 10, chunkChars: 10, spillPath },
    ]) {
      const signed = JSON.stringify({ ...bad, tag: signCursor(bad as any) });
      const result = await h.readTool.execute("call-signed-c", { cursor: signed });
      const payload = payloadOf(result);
      assert.equal(payload.ok, false, `accepted out-of-range cursor ${JSON.stringify(bad)}`);
      assert.equal(payload.error.code, "cursor_invalid");
    }

    rmSync(outside, { force: true });
  } finally {
    h.dispose();
  }
});

test("a cursor that is not JSON, or is missing fields, names the cursor field", async () => {
  const h = await harness();
  try {
    for (const cursor of ["not json", "{}", '{"offset":1}']) {
      const payload = payloadOf(await h.readTool.execute("call-bad-cursor", { cursor }));
      assert.equal(payload.ok, false);
      assert.equal(payload.field, "cursor");
    }
  } finally {
    h.dispose();
  }
});
