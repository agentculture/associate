/** The quote matcher against the shared vectors (issue #20, t5). */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkQuote } from "../lib/matcher.ts";
import { associateRoot } from "../lib/paths.ts";

interface VectorCase {
  name: string;
  min_quote_length: number;
  quote: string;
  literal: string | null;
  saved_text: string | null;
  expect: unknown;
}
const vectors = JSON.parse(readFileSync(join(associateRoot, "associate", "contract", "matcher_vectors.json"), "utf8")) as {
  verdicts: string[];
  reasons: string[];
  cases: VectorCase[];
};

for (const c of vectors.cases) {
  test(`vector: ${c.name}`, () => {
    assert.deepEqual(checkQuote(c.quote, c.literal, c.saved_text, c.min_quote_length), c.expect);
  });
}

test("vectors cover every verdict and reason", () => {
  const expects = vectors.cases.map((c) => c.expect as { verdict: string; reason: string | null });
  assert.deepEqual(new Set(expects.map((e) => e.verdict)), new Set(vectors.verdicts));
  assert.deepEqual(new Set(expects.map((e) => e.reason).filter(Boolean)), new Set(vectors.reasons));
});

test("same inputs give the same verdict", () => {
  const a = checkQuote("brown fox leaps", null, "The quick brown fox jumps", 8);
  assert.deepEqual(a, checkQuote("brown fox leaps", null, "The quick brown fox jumps", 8));
});

test("a 2,000,000 character text is cheap", () => {
  const got = checkQuote("a".repeat(50) + "b", null, "a".repeat(2_000_000), 8);
  assert.equal(got.nearest?.matched, 50);
  assert.equal(got.nearest?.offset, 0);
});
