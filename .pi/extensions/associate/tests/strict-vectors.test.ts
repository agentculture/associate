/**
 * The shared strict cases (`associate/contract/strict_vectors.json`) are what
 * the extension does today: the file is regenerated in memory by running
 * `runStrict` over every case (scripts/strict_vectors.ts) and must equal the
 * committed bytes. evidence-cli holds a byte-identical copy for its strict
 * re-check; docs/notes/strict-vectors.md describes the shape.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildStrictVectors, VECTORS_PATH } from "../../../../scripts/strict_vectors.ts";

const committed = readFileSync(VECTORS_PATH, "utf8");

test("strict_vectors.json is exactly what the extension's code produces for its cases", async () => {
  const built = await buildStrictVectors();
  assert.ok(
    built === committed,
    "associate/contract/strict_vectors.json differs from what runStrict now produces; " +
      "if the change is intended, run `node --experimental-strip-types scripts/strict_vectors.ts --write` " +
      "and copy the file to evidence-cli",
  );
});

test("the cases cover every outcome, every checked kind, and both worded values", () => {
  const doc = JSON.parse(committed) as {
    cases: Array<{ name: string; expect: { facts: Array<{ strict_outcome: string; kind_checked: string; worded: boolean | null }> } }>;
  };
  const facts = doc.cases.flatMap((c) => c.expect.facts);
  assert.deepEqual(new Set(facts.map((f) => f.strict_outcome)), new Set(["pass", "keep_marked", "returned", "dropped", "not_judged"]));
  assert.deepEqual(new Set(facts.map((f) => f.kind_checked)), new Set(["direct", "llm", "derived"]));
  assert.deepEqual(new Set(facts.map((f) => f.worded)), new Set([true, false, null]));
  const names = doc.cases.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, "case names are unique");
});
