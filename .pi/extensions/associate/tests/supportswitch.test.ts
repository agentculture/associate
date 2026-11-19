// The per-run switch for the support score (decider-score plan task t7, spec
// h6): $ASSOCIATE_SUPPORT_SCORE over accuracy.json's per-model switch.
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadContract, supportScoreListing, supportScoreSettings } from "../lib/contract.ts";
import {
  SUPPORT_SCORE_ENV,
  resolveSupportScore,
  supportScoreFor,
  supportScoreOverride,
} from "../lib/supportswitch.ts";

const accuracy = loadContract({}).accuracy;
const shipped = accuracy.support_score!;
const workerOn = { ...accuracy, support_score: { ...shipped, enabled: { ...shipped.enabled, worker: true } } };

test("the variable is ASSOCIATE_SUPPORT_SCORE", () => {
  assert.equal(SUPPORT_SCORE_ENV, "ASSOCIATE_SUPPORT_SCORE");
});

test("absent or blank defers to the contract switch", () => {
  for (const env of [{}, { [SUPPORT_SCORE_ENV]: "" }, { [SUPPORT_SCORE_ENV]: "  " }, { [SUPPORT_SCORE_ENV]: undefined }]) {
    assert.deepEqual(supportScoreOverride(env), {});
    assert.deepEqual(resolveSupportScore(accuracy, "worker", env), { settings: undefined, source: "contract" });
    assert.deepEqual(resolveSupportScore(workerOn, "worker", env), {
      settings: supportScoreSettings(workerOn, "worker"),
      source: "contract",
    });
    assert.ok(resolveSupportScore(workerOn, "worker", env).settings);
    assert.equal(resolveSupportScore(workerOn, "cortex", env).settings, undefined);
  }
});

test("'on' forces the score on for a model the contract switches off", () => {
  const env = { [SUPPORT_SCORE_ENV]: "on" };
  assert.equal(supportScoreSettings(accuracy, "worker"), undefined, "fixture assumption: shipped off");
  const got = resolveSupportScore(accuracy, "worker", env);
  assert.equal(got.source, "env");
  assert.equal(got.settings, shipped);
  assert.equal(got.problem, undefined);
  assert.equal(resolveSupportScore(accuracy, "worker", { [SUPPORT_SCORE_ENV]: " on\n" }).settings, shipped);
});

test("'on' cannot switch on what the contract has no settings for", () => {
  const env = { [SUPPORT_SCORE_ENV]: "on" };
  const { support_score: _dropped, ...older } = accuracy;
  for (const [contract, model] of [
    [older, "worker"],
    [accuracy, "no-such-model"],
    [accuracy, "toString"],
    [accuracy, undefined],
    [{ ...accuracy, support_score: { ...shipped, enabled: undefined } }, "worker"],
  ] as const) {
    const got = resolveSupportScore(contract as never, model, env);
    assert.equal(got.settings, undefined);
    assert.equal(got.source, "env");
    assert.match(got.problem ?? "", /ASSOCIATE_SUPPORT_SCORE=on/);
  }
});

test("'off' forces the score off for a model the contract switches on", () => {
  const got = resolveSupportScore(workerOn, "worker", { [SUPPORT_SCORE_ENV]: "off" });
  assert.deepEqual(got, { settings: undefined, source: "env" });
});

test("any other value is not an override: the contract applies and a problem line says so", () => {
  for (const raw of ["true", "1", "ON", "enforce", "on off"]) {
    const env = { [SUPPORT_SCORE_ENV]: raw };
    const override = supportScoreOverride(env);
    assert.equal(override.value, undefined);
    assert.match(override.problem ?? "", /is not 'on' or 'off'/);
    assert.ok(override.problem!.includes(JSON.stringify(raw)));
    assert.equal(resolveSupportScore(accuracy, "worker", env).settings, undefined);
    const on = resolveSupportScore(workerOn, "worker", env);
    assert.equal(on.settings, workerOn.support_score);
    assert.equal(on.source, "contract");
    assert.equal(on.problem, override.problem);
  }
  const long = supportScoreOverride({ [SUPPORT_SCORE_ENV]: "x".repeat(500) });
  assert.ok(long.problem!.length < 300, "a long value is cut in the line");
});

test("supportScoreFor returns the settings and reports each problem once", () => {
  const lines: string[] = [];
  const warn = (line: string) => lines.push(line);
  const seen = new Set<string>();
  const bad = { [SUPPORT_SCORE_ENV]: "maybe" };
  assert.equal(supportScoreFor(workerOn, "worker", bad, warn, seen), workerOn.support_score);
  assert.equal(supportScoreFor(workerOn, "worker", bad, warn, seen), workerOn.support_score);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes("\n"));
  assert.equal(supportScoreFor(accuracy, "worker", { [SUPPORT_SCORE_ENV]: "on" }, warn, seen), shipped);
  assert.equal(supportScoreFor(workerOn, "worker", { [SUPPORT_SCORE_ENV]: "off" }, warn, seen), undefined);
  assert.equal(supportScoreFor(accuracy, "worker", {}, warn, seen), undefined);
  assert.equal(lines.length, 1);
});

test("the per-run switch and the contract switch list the same models: one helper in lib/contract.ts (review finding 3)", () => {
  const on = { [SUPPORT_SCORE_ENV]: "on" };
  const shapes: Array<[unknown, string | undefined]> = [];
  const sections: unknown[] = [
    undefined,
    null,
    { ...shipped, enabled: undefined },
    { ...shipped, enabled: null },
    { ...shipped, enabled: [] },
    { ...shipped, enabled: ["worker"] },
    { ...shipped, enabled: "worker" },
    { ...shipped, enabled: { worker: false } },
    { ...shipped, enabled: { worker: true } },
    { ...shipped, enabled: { worker: "yes" } },
    { ...shipped, enabled: Object.create({ worker: true }) },
  ];
  for (const section of sections) {
    for (const model of ["worker", "toString", "0", undefined]) shapes.push([{ ...accuracy, support_score: section }, model]);
  }
  for (const [contract, model] of shapes) {
    const listed = supportScoreListing(contract as never, model);
    const where = `${JSON.stringify(contract && (contract as any).support_score?.enabled)} / ${model}`;
    assert.equal(resolveSupportScore(contract as never, model, on).settings, listed, `on: ${where}`);
    const fromContract = model === undefined ? undefined : supportScoreSettings(contract as never, model);
    if (fromContract !== undefined) assert.equal(fromContract, listed, `contract: ${where}`);
  }
});

test("lib/supportswitch.ts restates none of the listing checks", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../lib/supportswitch.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Object\.hasOwn/);
  assert.match(source, /supportScoreListing/);
});
