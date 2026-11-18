/**
 * The hand-back checker (issue #20, t10): facts, action claims, source rules,
 * verdicts and counts, as a pure library over a parsed payload, walk entries
 * and saved result texts.
 *
 * The whole-hand-back cases live in `associate/contract/matcher_vectors.json`
 * under `handback_cases`, so the Python checker runs the same ones.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContract } from "../lib/contract.ts";
import { associateRoot, extensionDir } from "../lib/paths.ts";
import {
  CHECKER_REASONS,
  checkHandback,
  literalOf,
  parseSourceRef,
  type HandbackInput,
} from "../lib/facts.ts";
import { childLabels } from "../lib/handback.ts";

const { accuracy } = loadContract({});

interface HandbackCase {
  name: string;
  input: HandbackInput;
  expect: {
    accepted: boolean;
    facts: unknown[];
    verdicts: unknown[];
    open_items: unknown[];
    report: unknown;
  };
}

const vectors = JSON.parse(
  readFileSync(join(associateRoot, "associate", "contract", "matcher_vectors.json"), "utf8"),
) as {
  handback_cases: HandbackCase[];
  literal_cases: Array<{ value: unknown; literal: string | null }>;
  contract_input: HandbackInput;
  contract_cases: Array<{ name: string; min_quote_length?: unknown; expect: unknown }>;
};

function project(got: ReturnType<typeof checkHandback>) {
  return {
    accepted: got.accepted,
    facts: got.facts.map((f) => ({
      id: f.id,
      run: f.run,
      verdict: f.verdict,
      reason: f.reason,
      check: f.check,
      nearest: f.nearest,
      source_kind: f.source_kind,
      first_hand: f.first_hand,
    })),
    verdicts: got.verdicts.map((v) => ({ id: v.id, outcome: v.outcome, reason: v.reason, check: v.check })),
    open_items: got.open_items.map((v) => ({ id: v.id, outcome: v.outcome, reason: v.reason, check: v.check })),
    report: got.report,
  };
}

for (const c of vectors.handback_cases) {
  test(`handback vector: ${c.name}`, () => {
    assert.deepEqual(project(checkHandback(c.input, accuracy)), c.expect);
  });
}

function caseNamed(fragment: string): HandbackCase {
  const found = vectors.handback_cases.find((c) => c.name.includes(fragment));
  assert.ok(found, `vector case containing '${fragment}'`);
  return found;
}

// --- AC1: a verdict per fact, one refusal leaves the others untouched -------

test("removing the refused fact leaves every other fact's verdict unchanged", () => {
  const c = caseNamed("one refused fact");
  const all = checkHandback(c.input, accuracy);
  const payload = c.input.payload as { facts: Array<{ id: string }> };
  const without = checkHandback(
    { ...c.input, payload: { facts: payload.facts.filter((f) => f.id !== "f2") } },
    accuracy,
  );
  const strip = (facts: typeof all.facts) => facts.filter((f) => f.id !== "f2");
  assert.deepEqual(without.facts, strip(all.facts));
  assert.equal(all.facts.find((f) => f.id === "f2")?.verdict, "refused");
  assert.ok(all.facts.find((f) => f.id === "f2")?.nearest, "a quote refusal carries the nearest span");
});

test("same inputs give the same result and the inputs are not changed", () => {
  const c = caseNamed("source references");
  const before = JSON.stringify(c.input);
  assert.deepEqual(checkHandback(c.input, accuracy), checkHandback(c.input, accuracy));
  assert.equal(JSON.stringify(c.input), before);
});

test("every refusal carries a reason, a check id from the contract and a fix", () => {
  for (const c of vectors.handback_cases) {
    const got = checkHandback(c.input, accuracy);
    for (const item of [...got.facts, ...got.verdicts, ...got.open_items]) {
      const refused = "verdict" in item && typeof item.verdict === "string" && item.verdict === "refused"
        ? true
        : "outcome" in item && item.outcome === "refused";
      if (!refused) continue;
      assert.ok(item.reason, `${c.name} ${item.id}: reason`);
      assert.ok(item.check && accuracy.checks.some((k) => k.id === item.check), `${c.name} ${item.id}: check`);
      assert.ok(item.fix && item.fix.trim().length > 0, `${c.name} ${item.id}: fix`);
    }
  }
});

test("every reason the checker can give maps to a check in the contract", () => {
  const ids = new Set(accuracy.checks.map((k) => k.id));
  for (const reason of CHECKER_REASONS) {
    const check = accuracy.refusal_checks[reason];
    assert.ok(check, `accuracy.json refusal_checks has no entry for ${reason}`);
    assert.ok(ids.has(check), `${reason} maps to unknown check ${check}`);
  }
});

test("the minimum quote length comes from the contract", () => {
  const input: HandbackInput = {
    payload: { facts: [{ id: "f1", value: "fox", source: "w1", quote: "fox" }] },
    entries: [{ id: "w1", tool: "read", saved_result: "results/w1.txt" }],
    results: { w1: "the fox" },
  };
  assert.equal(checkHandback(input, accuracy).facts[0].reason, "quote_short");
  assert.equal(checkHandback(input, { ...accuracy, min_quote_length: 3 }).facts[0].verdict, "passed");
});

test("the check id comes from the contract mapping, not from the code", () => {
  const c = caseNamed("one refused fact");
  const renamed = {
    ...accuracy,
    checks: [...accuracy.checks, { id: "renamed_check", strength: "refuse" as const, motivating_failure: "test" }],
    refusal_checks: { ...accuracy.refusal_checks, quote_absent: "renamed_check" },
  };
  const got = checkHandback(c.input, renamed);
  assert.equal(got.facts.find((f) => f.id === "f2")?.check, "renamed_check");
  assert.ok(got.report.flags.some((f) => f.check === "renamed_check"));
});

// --- AC2: action facts ----------------------------------------------------

test("t20 A2: 'Eidetic remember: Success' citing a recall entry is refused with a fix", () => {
  const c = caseNamed("t20 A2");
  const got = checkHandback(c.input, accuracy);
  const f1 = got.facts.find((f) => f.id === "f1")!;
  assert.equal(f1.verdict, "refused");
  assert.equal(f1.reason, "action_wrong_tool");
  assert.match(f1.fix ?? "", /eidetic_remember/);
  assert.equal(got.facts.find((f) => f.id === "f3")?.verdict, "passed");
});

test("an action fact citing a call that ended in an error or refusal is refused", () => {
  const input: HandbackInput = {
    payload: {
      facts: [
        { id: "f1", value: "tests passed", source: "w1", quote: "1 passed in 0.1s", action: true, tool: "run_tests" },
        { id: "f2", value: "tests passed", source: "w2", quote: "1 passed in 0.1s", action: true, tool: "run_tests" },
      ],
    },
    entries: [
      { id: "w1", tool: "run_tests", saved_result: "results/w1.txt", error: "tool call failed" },
      { id: "w2", tool: "run_tests", saved_result: "results/w2.txt" },
    ],
    results: { w1: "1 passed in 0.1s", w2: "1 passed in 0.1s" },
  };
  const got = checkHandback(input, accuracy);
  assert.deepEqual(
    got.facts.map((f) => [f.id, f.verdict, f.reason]),
    [
      ["f1", "refused", "action_failed"],
      ["f2", "passed", null],
    ],
  );
});

// --- AC3: source kinds and verdicts ---------------------------------------

test("source kind comes from the contract table by tool name, not from the entry text", () => {
  const input: HandbackInput = {
    payload: { facts: [{ id: "f1", value: "x", source: "w1", quote: "remembered text" }] },
    entries: [{ id: "w1", tool: "eidetic_recall", source_kind: "file", saved_result: "results/w1.txt" }],
    results: { w1: "remembered text" },
  };
  const f1 = checkHandback(input, accuracy).facts[0];
  assert.equal(f1.source_kind, accuracy.source_kinds.eidetic_recall);
  assert.equal(f1.first_hand, false);
});

test("a delegate_status quote straddling the harness fields and final_reply is second-hand", () => {
  const text = JSON.stringify({
    ok: true,
    result: { outcome: "ok", merge: "merged", final_reply: "all good here" },
  });
  const input: HandbackInput = {
    payload: { facts: [{ id: "f1", value: "merged", source: "w1", quote: '"merge":"merged","final_reply":"all good' }] },
    entries: [{ id: "w1", tool: "delegate_status", saved_result: "results/w1.txt" }],
    results: { w1: text },
  };
  const f1 = checkHandback(input, accuracy).facts[0];
  assert.equal(f1.verdict, "passed");
  assert.equal(f1.first_hand, false);
});

test("a delegate_status quote from the rendered answer is second-hand", () => {
  const text = JSON.stringify({
    ok: true,
    result: {
      outcome: "ok",
      merge: "merged",
      answer: "# Answer\n\nFinish summary: every test passed here",
      final_reply: "all good here",
    },
  });
  const input: HandbackInput = {
    payload: {
      facts: [
        { id: "f1", value: "passed", source: "w1", quote: "every test passed here" },
        { id: "f2", value: "merged", source: "w1", quote: '"merge":"merged"' },
      ],
    },
    entries: [{ id: "w1", tool: "delegate_status", saved_result: "results/w1.txt" }],
    results: { w1: text },
  };
  const facts = checkHandback(input, accuracy).facts;
  assert.equal(facts[0].verdict, "passed");
  assert.equal(facts[0].first_hand, false);
  assert.equal(facts[1].first_hand, true);
});

// --- AC4: source references -----------------------------------------------

test("parseSourceRef reads an optional run label and a walk id", () => {
  assert.deepEqual(parseSourceRef("w12"), { ok: true, label: null, id: "w12" });
  assert.deepEqual(parseSourceRef("run-3:w12"), { ok: true, label: "run-3", id: "w12" });
  assert.deepEqual(parseSourceRef("a_b:w7"), { ok: true, label: "a_b", id: "w7" });
  for (const bad of ["/etc/passwd", "../w1", "a/b:w1", "run\\1:w1", "results/w1.txt"]) {
    assert.deepEqual(parseSourceRef(bad), { ok: false, reason: "source_path" }, bad);
  }
  for (const bad of ["w0", "run:", "x", "w1.txt", "", "W1", 12, null]) {
    assert.deepEqual(parseSourceRef(bad), { ok: false, reason: "source_malformed" }, String(bad));
  }
});

test("a reference containing a path is refused before any saved result is looked up", () => {
  const lookups: string[] = [];
  const watch = <T extends object>(name: string, target: T): T =>
    new Proxy(target, {
      get(obj, key, receiver) {
        if (typeof key === "string") lookups.push(`${name}.${key}`);
        return Reflect.get(obj, key, receiver);
      },
    });
  const input: HandbackInput = {
    payload: {
      facts: [
        { id: "f1", value: "x", source: "../../etc/passwd", quote: "root:x:0:0:root" },
        { id: "f2", value: "x", source: "prior/w1", quote: "root:x:0:0:root" },
      ],
    },
    entries: [{ id: "w1", tool: "read", saved_result: "results/w1.txt" }],
    results: watch("results", { w1: "root:x:0:0:root" }),
    prior_runs: watch("prior_runs", {
      prior: { entries: [{ id: "w1", tool: "read" }], results: watch("prior.results", { w1: "root:x:0:0:root" }) },
    }),
  };
  const got = checkHandback(input, accuracy);
  assert.deepEqual(
    got.facts.map((f) => [f.verdict, f.reason]),
    [
      ["refused", "source_path"],
      ["refused", "source_path"],
    ],
  );
  assert.deepEqual(
    lookups.filter((key) => /\.w1$|passwd/.test(key) && !key.startsWith("prior_runs.prior")),
    [],
    "no saved result was read for a path reference",
  );
});

test("a labelled reference never resolves to a current-run entry", () => {
  const input: HandbackInput = {
    payload: { facts: [{ id: "f1", value: "x", source: "prior:w1", quote: "current run text" }] },
    entries: [{ id: "w1", tool: "read", saved_result: "results/w1.txt" }],
    results: { w1: "current run text" },
    prior_runs: { prior: { entries: [{ id: "w1", tool: "read" }], results: { w1: "prior run text" } } },
  };
  const f1 = checkHandback(input, accuracy).facts[0];
  assert.equal(f1.run, "prior");
  assert.equal(f1.verdict, "refused");
  assert.equal(f1.reason, "quote_absent");
});

// --- AC5: counts and flags in the report schema's shape -------------------

test("the report validates against report.schema.json's required keys, per run", () => {
  const schema = JSON.parse(
    readFileSync(join(associateRoot, "associate", "contract", "schemas", "report.schema.json"), "utf8"),
  ) as { required: string[]; properties: Record<string, unknown> };
  const c = caseNamed("child runs");
  const got = checkHandback(c.input, accuracy);
  for (const report of [got.report, got.report.children[0].report]) {
    for (const key of schema.required) assert.ok(key in report, `report has ${key}`);
    for (const key of Object.keys(report)) assert.ok(key in schema.properties, `report key ${key} is in the schema`);
  }
  assert.equal(got.report.python_recheck_ran, false);
});

test("a child's counts are listed and never summed into the parent's", () => {
  const c = caseNamed("child runs");
  const got = checkHandback(c.input, accuracy);
  const child = got.report.children[0];
  assert.equal(child.label, "child-1");
  assert.equal(child.report.facts.refused, 1);
  assert.equal(got.report.facts.refused, 0);
  assert.equal(got.report.facts.made, 2);
});

test("unchecked facts are never counted as passed", () => {
  for (const c of vectors.handback_cases) {
    const report = checkHandback(c.input, accuracy).report;
    const f = report.facts;
    assert.equal(f.made, f.passed + f.refused + f.unchecked, c.name);
    assert.equal(f.checked, f.passed + f.refused, c.name);
  }
});

test("facts.ts opens no file and imports nothing from pi", () => {
  const text = readFileSync(join(extensionDir, "lib", "facts.ts"), "utf8");
  assert.doesNotMatch(text, /from "node:fs"|from "fs"|readFileSync|openSync|@earendil-works/);
  assert.match(text, /from "\.\/matcher\.ts"/);
});

// --- review fixes: number and boolean literals, a broken contract, malformed children ---

test("a fact value's literal text matches the shared literal cases (numbers, booleans, strings)", () => {
  for (const c of vectors.literal_cases) {
    assert.equal(literalOf(c.value), c.literal, JSON.stringify(c.value));
  }
});

for (const c of vectors.contract_cases) {
  test(`contract vector: min_quote_length ${c.name}`, () => {
    const contract: Record<string, unknown> = { ...accuracy };
    if (Object.hasOwn(c, "min_quote_length")) contract.min_quote_length = c.min_quote_length;
    else delete contract.min_quote_length;
    const got = checkHandback(vectors.contract_input, contract as unknown as typeof accuracy);
    assert.deepEqual(
      {
        accepted: got.accepted,
        facts: got.facts.map((f) => ({ id: f.id, verdict: f.verdict, reason: f.reason, check: f.check })),
        verdicts: got.verdicts.map((v) => ({ id: v.id, outcome: v.outcome, reason: v.reason, check: v.check })),
        flags: got.report.flags,
      },
      c.expect,
    );
  });
}

test("a broken min_quote_length refuses every fact with a fix that names the contract value", () => {
  const got = checkHandback(vectors.contract_input, { ...accuracy, min_quote_length: 0 });
  for (const f of got.facts) {
    assert.equal(f.verdict, "refused");
    assert.match(f.fix ?? "", /min_quote_length is 0/);
  }
  assert.equal(got.accepted, false);
});

test("childLabels keeps only child ids of the form cN, first occurrence, in walk order", () => {
  const dir = mkdtempSync(join(tmpdir(), "assoc-childlabels-"));
  try {
    const walk = join(dir, "walk.jsonl");
    const ids: unknown[] = ["c1", "../c9", "c0", "child-1", "c2", "c1", "C3", 4, "c3\n", "c10"];
    const lines = ids.map((id) => JSON.stringify({ child: { id, child_walk: "/x/walk.jsonl" } }));
    lines.push("not json", JSON.stringify({ child: "c5" }), JSON.stringify(null));
    writeFileSync(walk, lines.join("\n") + "\n");
    assert.deepEqual(childLabels(walk), ["c1", "c2", "c10"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
