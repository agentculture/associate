/**
 * The prompts name `check_quote` as the way to learn, before the hand-back,
 * whether a quote supports its value (decider-score plan task t8; spec c29,
 * h24).
 *
 * Two things are read from the prompt files themselves:
 *
 * 1. Every prompt that offers `check_quote`, and `AGENTS.md`, says to pass the
 *    fact's value as `value`, that the result may then carry `support` (whether
 *    the quote shows the value), and that a fact whose quote does not show its
 *    value is fixed before `finish`.
 * 2. No prompt promises another turn after `finish`. In report mode `finish`
 *    ends the run, so what it says about support comes too late to act on; a
 *    prompt that told the model otherwise would teach it to skip the check.
 *
 * Text only: no model, no pi, no network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadContract } from "../lib/contract.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const REGISTRY = loadContract({}).models;

/** Each prompt the model can be shown, by a name for the failure message. */
const MODEL_PROMPTS: Array<[string, string]> = Object.values(REGISTRY.models).map((entry) => [
  entry.prompt_file,
  readFileSync(join(REPO_ROOT, entry.prompt_file), "utf8"),
]);
const AGENTS: [string, string] = ["AGENTS.md", readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8")];
const ALL_FILES: Array<[string, string]> = [...MODEL_PROMPTS, AGENTS];

/**
 * The list items (a `- ` bullet or an `N. ` step, with its indented
 * continuation lines) that name `check_quote`, joined. The banned words below
 * are judged against these passages only: the rest of each prompt legitimately
 * says "CLEF safety check" and carries the heading "Accuracy rules".
 */
function checkQuotePassages(text: string): string {
  const items: string[] = [];
  let current: string[] | null = null;
  for (const line of text.split("\n")) {
    if (/^(- |\d+\. )/.test(line)) {
      if (current) items.push(current.join("\n"));
      current = [line];
    } else if (current && /^\s+\S/.test(line)) {
      current.push(line);
    } else {
      if (current) items.push(current.join("\n"));
      current = null;
    }
  }
  if (current) items.push(current.join("\n"));
  return items.filter((item) => item.includes("`check_quote`")).join("\n");
}

test("t8: every registry prompt offers check_quote, so every one is read here", () => {
  assert.ok(MODEL_PROMPTS.length >= 4);
  for (const [name, text] of ALL_FILES) {
    assert.ok(checkQuotePassages(text).length > 0, `${name} has a check_quote passage`);
  }
});

/** What every file must say about `check_quote`, in its check_quote passages. */
const REQUIRED: Array<[string, RegExp]> = [
  ["pass the fact's value as value", /fact's value as\s+`value`/],
  ["the result may carry support", /`support`/],
  ["fix a fact whose quote does not show the value, before finish", /does\s+not\s+show\s+the\s+value,\s+fix\s+the\s+fact\s+before\s+(you\s+call\s+)?`finish`/],
];

/**
 * What each model prompt must say in addition. AGENTS.md carries only the
 * three lines above: a test caps it at 6000 characters, and the model's
 * prompt, which follows it in every session, carries the rest.
 */
const REQUIRED_IN_MODEL_PROMPTS: Array<[string, RegExp]> = [
  ["it returns how much of the value the quote shows", /how\s+much\s+of\s+that\s+value\s+the\s+quote,\s+on\s+its\s+own,\s+shows/],
  ["the answers are named in words (deviation d4)", /\(all,\s+mostly,\s+part,\s+little\s+or\s+none\)/],
  ["any answer but all is acted on before finish", /Unless\s+its\s+`answer`\s+is\s+`all`,\s+do\s+what\s+the\s+meaning\s+says\s+before\s+`finish`/],
  ["read the meaning of support", /`support`,\s+read\s+its\s+`meaning`/],
  ["the ways to fix the fact", /re-read\s+the\s+source,\s+correct\s+the\s+value,\s+quote\s+the\s+line\s+that\s+states\s+it,\s+or\s+say\s+you\s+cannot\s+tell/],
  ["not handed back unchanged", /not\s+hand\s+it\s+back\s+unchanged/],
  ["an absent or not-scored support is not a judgement", /missing\s+`support`,\s+or\s+one\s+that\s+says\s+"not\s+scored",\s+is\s+not\s+a\s+judgement/],
  ["support may be absent: the wording is 'may'", /may\s+add\s+`support`/],
];

for (const [label, re] of REQUIRED) {
  for (const [name, text] of ALL_FILES) {
    test(`t8: ${name} says: ${label}`, () => {
      assert.match(checkQuotePassages(text), re);
    });
  }
}

for (const [label, re] of REQUIRED_IN_MODEL_PROMPTS) {
  for (const [name, text] of MODEL_PROMPTS) {
    test(`t8: ${name} says: ${label}`, () => {
      assert.match(checkQuotePassages(text), re);
    });
  }
}

/**
 * Phrases that would promise the model another turn once `finish` has been
 * called. Each is judged against the whole file.
 *
 * Not on the list, on purpose: rule 10's "If `finish` is refused, fix each
 * problem it names and call it again". That is the enforce-mode refusal, it is
 * conditional on a refusal that report mode never issues, and it says nothing
 * about support. AGENTS.md's "no tool call is allowed after `finish`" is the
 * opposite of a promise and must keep passing, which is why "after finish" is
 * matched only when the same sentence goes on to offer an action.
 */
const SECOND_CHANCE: Array<[string, RegExp]> = [
  // The plainest form of the promise.
  ["second chance", /second\s+chance/i],
  // "another round / try / attempt / turn / chance": the retry-rounds idea leaking into a prompt.
  ["another round", /another\s+(round|try|attempt|turn|chance|go)\b/i],
  // "you will be asked again", "finish will ask you again": a later prompt that report mode never sends.
  ["will be asked again", /(will|may|can)\s+(be\s+asked|ask\s+you)\b[^.]*\bagain\b/i],
  // "try again after finish", "check again after `finish`".
  ["again after finish", /again\s+after\s+`?finish`?/i],
  // "after finish you can fix ...", "after `finish` reports it, correct the fact": acting once finish has run.
  [
    "after finish, then an action",
    /after\s+`?finish`?[^.]*\b(you\s+(can|may|will|get|should)|fix|correct|revise|retry|redo|again)\b/i,
  ],
  // "finish will tell you which quotes ...", "finish reports support, then fix": finish as the place to learn it.
  ["finish as the place to learn support", /`?finish`?\s+(will\s+)?(tells?|reports?|shows?|returns?)\b[^.]*`?support`?/i],
];

for (const [label, re] of SECOND_CHANCE) {
  test(`t8: no prompt promises a turn after finish: ${label}`, () => {
    for (const [name, text] of ALL_FILES) {
      assert.doesNotMatch(text, re, name);
    }
  });
}

test("t8: the second-chance patterns do catch the promises they are meant to", () => {
  const promises = [
    "You get a second chance to fix it.",
    "If support is low you get another round.",
    "You will be asked again for a better quote.",
    "Try again after `finish`.",
    "After `finish` reports the result, fix the fact.",
    "`finish` tells you which facts lack support.",
  ];
  for (const [i, text] of promises.entries()) {
    assert.match(text, SECOND_CHANCE[i]![1], text);
  }
  // The two sentences the prompts keep must stay clear of every pattern.
  const kept = [
    "and no tool call is allowed after `finish`.",
    "If `finish` is refused, fix each problem it names and call it\n    again.",
  ];
  for (const text of kept) {
    for (const [label, re] of SECOND_CHANCE) assert.doesNotMatch(text, re, label);
  }
});

/**
 * Words the check_quote passages must not use: the model is told what the
 * result says and what to do, not what answers the question or where the line
 * is drawn, and never that the check shows a value to be true.
 */
const BANNED: Array<[string, RegExp]> = [
  ["accuracy", /accuracy/i],
  ["decider", /decider/i],
  ["CLEF", /clef/i],
  ["a score threshold or cut-off", /threshold|cut-?\s?off/i],
  ["a number for the support answer", /support[^.]*\b\d\.\d|\bscore\b/i],
  ["a claim that the check proves the value", /\b(proves?|confirms?|guarantees?|means)\b[^.]*\b(true|correct|right)\b/i],
];

for (const [label, re] of BANNED) {
  test(`t8: the check_quote passages do not use: ${label}`, () => {
    for (const [name, text] of ALL_FILES) {
      assert.doesNotMatch(checkQuotePassages(text), re, name);
    }
  });
}

// Strict facts (plan t8): worker and cortex also describe the pointer form of
// check_quote; senses and super-vl keep the quote form. Each group is the same.
for (const group of [/(worker|cortex)\.md$/, /(senses|super-vl)\.md$/]) {
  test(`t8: the check_quote passages are the same in the prompts matching ${group}`, () => {
    const members = MODEL_PROMPTS.filter(([name]) => group.test(name));
    assert.ok(members.length >= 2);
    const passages = members.map(([, text]) => checkQuotePassages(text));
    for (const [i, passage] of passages.entries()) {
      assert.equal(passage, passages[0], `${members[i]![0]} differs from ${members[0]![0]}`);
    }
  });
}

test("t8: worker and cortex tell the model that check_quote takes a pointer", () => {
  for (const [name, text] of MODEL_PROMPTS.filter(([n]) => /(worker|cortex)\.md$/.test(n))) {
    assert.match(checkQuotePassages(text), /give\s+a\s+walk\s+id\s+and\s+`at`/, name);
  }
});
