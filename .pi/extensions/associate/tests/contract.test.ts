/**
 * The contract is read from the Python package, never restated in TypeScript
 * (spec c46/c50).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCHEMA_NAMES,
  findRepoContractDir,
  loadContract,
  policySection,
  resolveContractDir,
  supportScoreSettings,
} from "../lib/contract.ts";
import { extensionDir } from "../lib/paths.ts";

test("the repo-relative fallback finds associate/contract/", () => {
  const dir = findRepoContractDir();
  assert.ok(dir, "expected to find associate/contract by walking up from the extension");
  assert.match(dir!, /associate[/\\]contract$/);
});

test("loadContract reads policy.json and every schema", () => {
  const contract = loadContract({});
  assert.equal(contract.source, "repo");
  assert.equal(typeof contract.version, "number");
  assert.ok(contract.version >= 1, "policy.json must declare a version");
  for (const name of SCHEMA_NAMES) {
    assert.ok(contract.schemas[name], `missing schema ${name}`);
  }
  // The values come from the file, not from this repo's TypeScript.
  const onDisk = JSON.parse(readFileSync(join(contract.dir, "policy.json"), "utf8"));
  assert.deepEqual(contract.policy, onDisk);
});

test("loadContract exposes models.json (incl. tool_names) and gate.json from disk", () => {
  const contract = loadContract({});
  const models = JSON.parse(readFileSync(join(contract.dir, "models.json"), "utf8"));
  const gate = JSON.parse(readFileSync(join(contract.dir, "gate.json"), "utf8"));
  assert.deepEqual(contract.models, models);
  assert.deepEqual(contract.gate, gate);
  assert.ok(contract.models.tool_names.includes("finish"));
  assert.equal(typeof contract.models.endpoint.default_base_url, "string");
});

test("a contract dir without models.json is refused", () => {
  const real = loadContract({});
  const dir = mkdtempSync(join(tmpdir(), "associate-contract-"));
  try {
    mkdirSync(join(dir, "schemas"), { recursive: true });
    writeFileSync(join(dir, "policy.json"), "{}");
    for (const name of SCHEMA_NAMES) writeFileSync(join(dir, "schemas", `${name}.schema.json`), "{}");
    assert.throws(() => loadContract({ ASSOCIATE_CONTRACT_DIR: dir }), /models\.json/);
    assert.ok(real.dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ASSOCIATE_CONTRACT_DIR wins over the repo-relative fallback", () => {
  const real = loadContract({});
  const dir = mkdtempSync(join(tmpdir(), "associate-contract-"));
  try {
    mkdirSync(join(dir, "schemas"), { recursive: true });
    writeFileSync(join(dir, "policy.json"), JSON.stringify({ version: 99, export: {} }));
    for (const name of SCHEMA_NAMES) {
      writeFileSync(join(dir, "schemas", `${name}.schema.json`), JSON.stringify({ title: name }));
    }
    writeFileSync(join(dir, "models.json"), JSON.stringify(real.models));
    writeFileSync(join(dir, "gate.json"), JSON.stringify(real.gate));
    writeFileSync(join(dir, "accuracy.json"), JSON.stringify({ ...real.accuracy, retry_rounds: 77 }));
    const contract = loadContract({ ASSOCIATE_CONTRACT_DIR: dir });
    assert.equal(contract.accuracy.retry_rounds, 77, "accuracy.json is read from ASSOCIATE_CONTRACT_DIR");
    assert.equal(contract.source, "env");
    assert.equal(contract.version, 99);
    assert.notEqual(contract.dir, real.dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bad ASSOCIATE_CONTRACT_DIR throws instead of silently falling back", () => {
  const dir = mkdtempSync(join(tmpdir(), "associate-nocontract-"));
  try {
    assert.throws(
      () => resolveContractDir({ ASSOCIATE_CONTRACT_DIR: dir }),
      /not an associate contract directory/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("policySection returns the named section and {} for a missing one", () => {
  const policy = loadContract({}).policy;
  assert.ok(Object.keys(policySection(policy, "export")).length > 0);
  assert.deepEqual(policySection(policy, "no-such-section"), {});
});

test("no policy value is hardcoded in the extension's TypeScript", () => {
  // Spec c46 honesty: changing a contract value changes adapter behaviour with
  // no TypeScript edit. The cheap structural check is that the distinctive
  // values of policy.json appear in no .ts file under the extension.
  const contract = loadContract({});
  const policyText = readFileSync(join(contract.dir, "policy.json"), "utf8");
  const denylist: string[] = (contract.policy.read as { denylist?: string[] })?.denylist ?? [];
  const allowlist: Array<{ command: string }> =
    (contract.policy.shell as { allowlist?: Array<{ command: string }> })?.allowlist ?? [];
  assert.ok(denylist.length > 0 && allowlist.length > 0, "fixture assumption: policy.json is populated");

  // Scanned: the shipped extension (index.ts, lib/, tools/). Not tests/ — a
  // test may legitimately name a command it spawns.
  // Quoted, so a policy pattern is only reported when it appears as a literal
  // (".env" the value, not the ".env" inside "process.env").
  //
  // The denylist check covers index.ts, lib/ AND tools/: a read/search tool
  // must never re-decide which paths are secret-shaped by restating a glob.
  // The allowlist check covers only index.ts and lib/: policy.shell.allowlist
  // is the set a future *generic* shell tool validates an arbitrary command
  // against, so re-hardcoding that list would drift from policy.json. A
  // dedicated tool module under tools/ is a different thing — its whole job
  // is to spawn one named, specific binary (search.ts's grep/find spawn `rg`
  // and `fd` by name; that pairing is what the task specifies, not a policy
  // value that could change out from under it), so naming that binary in the
  // module that spawns it is not the duplication this check guards against.
  const denylistNeedles = denylist.slice(0, 5).map((pattern) => `"${pattern}"`);
  const allowlistNeedles = allowlist.map((entry) => `"${entry.command}"`);
  const coreShipped = [join(extensionDir, "index.ts"), ...collectTypeScript(join(extensionDir, "lib"))];
  const toolsShipped = collectTypeScript(join(extensionDir, "tools"));
  for (const path of coreShipped) {
    const text = readFileSync(path, "utf8");
    for (const needle of [...denylistNeedles, ...allowlistNeedles]) {
      assert.ok(
        !text.includes(needle),
        `${path} contains the policy value ${needle}; policy values belong in policy.json only`,
      );
    }
  }
  for (const path of toolsShipped) {
    const text = readFileSync(path, "utf8");
    for (const needle of denylistNeedles) {
      assert.ok(
        !text.includes(needle),
        `${path} contains the policy value ${needle}; policy values belong in policy.json only`,
      );
    }
  }
  assert.ok(policyText.length > 0);
});

function collectTypeScript(dir: string): string[] {
  const found: string[] = [];
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectTypeScript(path));
    } else if (entry.name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}

test("loadContract exposes accuracy.json from disk", () => {
  const contract = loadContract({});
  const onDisk = JSON.parse(readFileSync(join(contract.dir, "accuracy.json"), "utf8"));
  assert.deepEqual(contract.accuracy, onDisk);
  assert.ok(contract.accuracy.version >= 1);
  assert.ok(contract.accuracy.checks.length > 0);
  assert.deepEqual(Object.keys(contract.accuracy.source_kinds).sort(), [...contract.models.tool_names].sort());
});

test("a contract dir without accuracy.json is refused", () => {
  const real = loadContract({});
  const dir = mkdtempSync(join(tmpdir(), "associate-contract-"));
  try {
    mkdirSync(join(dir, "schemas"), { recursive: true });
    writeFileSync(join(dir, "policy.json"), "{}");
    for (const name of SCHEMA_NAMES) writeFileSync(join(dir, "schemas", `${name}.schema.json`), "{}");
    writeFileSync(join(dir, "models.json"), JSON.stringify(real.models));
    writeFileSync(join(dir, "gate.json"), JSON.stringify(real.gate));
    assert.throws(() => loadContract({ ASSOCIATE_CONTRACT_DIR: dir }), /accuracy\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no accuracy setting appears as a literal in the extension's TypeScript", () => {
  // Spec h17: thresholds, modes, retry rounds and the check table live in
  // accuracy.json. The distinctive strings of that file (setting key names,
  // check ids, motivating failures) appear quoted in no shipped .ts file.
  const { accuracy } = loadContract({});
  const needles = [
    ...["retry_rounds", "refusal_cap", "min_quote_length", "source_kinds", "purpose_exempt_tools", "motivating_failure", "refusal_checks"],
    ...accuracy.checks.map((check) => check.id),
  ].map((word) => `"${word}"`);
  needles.push(...accuracy.checks.map((check) => check.motivating_failure));
  assert.ok(needles.length > 6, "fixture assumption: accuracy.json has checks");
  const shipped = [
    join(extensionDir, "index.ts"),
    ...collectTypeScript(join(extensionDir, "lib")),
    ...collectTypeScript(join(extensionDir, "tools")),
  ];
  for (const path of shipped) {
    const text = readFileSync(path, "utf8");
    for (const needle of needles) {
      assert.ok(!text.includes(needle), `${path} restates accuracy.json value ${needle}`);
    }
  }
});

test("loadContract exposes the support-score settings, switched off for every model", () => {
  // Decider-score spec c4/h13, c9/h18.
  const { accuracy, models } = loadContract({});
  const settings = accuracy.support_score;
  assert.ok(settings, "accuracy.json ships a support_score section");
  assert.equal(typeof settings.question, "string");
  assert.ok(settings.question.trim().length > 0);
  assert.ok(settings.cutoff >= 0 && settings.cutoff <= 1);
  for (const value of [settings.timeout_ms, settings.max_facts, settings.total_timeout_ms]) {
    assert.ok(Number.isInteger(value) && value > 0);
  }
  assert.ok(settings.total_timeout_ms >= settings.timeout_ms);
  assert.deepEqual(Object.keys(settings.enabled).sort(), Object.keys(models.models).sort());
  for (const key of Object.keys(models.models)) {
    assert.equal(settings.enabled[key], false, `${key}: the switch is off until the cut-off is fixed`);
    assert.equal(accuracy.mode[key], "report", `${key}: still report mode`);
    assert.equal(supportScoreSettings(accuracy, key), undefined);
  }
});

test("supportScoreSettings returns the settings only for a model switched on with exactly true", () => {
  const { accuracy } = loadContract({});
  const shipped = accuracy.support_score!;
  const on = { ...accuracy, support_score: { ...shipped, enabled: { ...shipped.enabled, worker: true } } };
  assert.deepEqual(supportScoreSettings(on, "worker"), on.support_score);
  assert.equal(supportScoreSettings(on, "cortex"), undefined);
  assert.equal(supportScoreSettings(on, "no-such-model"), undefined);
  assert.equal(supportScoreSettings(on, "toString"), undefined, "an inherited name is not a switch");
  for (const notTrue of ["true", 1, "on", null]) {
    const odd = { ...accuracy, support_score: { ...shipped, enabled: { worker: notTrue } } };
    assert.equal(supportScoreSettings(odd as never, "worker"), undefined, `${String(notTrue)} is not on`);
  }
  // An accuracy.json written before the section existed: the score is off.
  const { support_score: _dropped, ...older } = accuracy;
  assert.equal(supportScoreSettings(older, "worker"), undefined);
  assert.equal(supportScoreSettings({ ...accuracy, support_score: { ...shipped, enabled: undefined } } as never, "worker"), undefined);
});

/** A numeric literal equal to `value`, however TypeScript lets it be written (0.5, .50, 10_000). */
function numberLiteral(value: number): RegExp {
  const [whole, fraction = ""] = String(value).split(".");
  const digits = whole.split("").join("_?");
  const body = fraction
    ? `${whole === "0" ? "0?" : digits}\\.${fraction.split("").join("_?")}0*`
    : `${digits}(?:\\.0*)?`;
  return new RegExp(`(?<![\\w.])${body}(?![\\w.])`);
}

/** Where `text` restates the question wording, the cut-off or the per-fact timeout. */
function restatedSupportSettings(text: string, settings: { question: string; cutoff: number; timeout_ms: number }): string[] {
  const found: string[] = [];
  if (text.includes(settings.question)) found.push("question");
  if (numberLiteral(settings.cutoff).test(text)) found.push("cutoff");
  if (numberLiteral(settings.timeout_ms).test(text)) found.push("timeout_ms");
  return found;
}

test("no support-score setting appears as a literal in the extension's TypeScript", () => {
  // Decider-score spec h13: the question wording, the cut-off and the
  // per-fact timeout live in accuracy.json and nowhere in code. Comments are
  // scanned too, so a value is not restated in prose either.
  const settings = loadContract({}).accuracy.support_score;
  assert.ok(settings, "fixture assumption: accuracy.json has a support_score section");
  const keyNeedles = ["support_score", "cutoff", "max_facts", "total_timeout_ms"].map((word) => `"${word}"`);
  const shipped = [
    join(extensionDir, "index.ts"),
    ...collectTypeScript(join(extensionDir, "lib")),
    ...collectTypeScript(join(extensionDir, "tools")),
  ];
  assert.ok(shipped.length > 10, "fixture assumption: the extension is scanned");
  for (const path of shipped) {
    const text = readFileSync(path, "utf8");
    assert.deepEqual(restatedSupportSettings(text, settings), [], `${path} restates a support-score value`);
    for (const needle of keyNeedles) {
      assert.ok(!text.includes(needle), `${path} restates accuracy.json key ${needle}`);
    }
  }
});

test("the support-score literal scan catches each restated value", () => {
  const settings = { question: "Is it so?", cutoff: 0.5, timeout_ms: 10000 };
  assert.deepEqual(restatedSupportSettings("const q = 'Is it so?';", settings), ["question"]);
  for (const text of ["if (score >= 0.5) {", "x = .5;", "x = 0.50;"]) {
    assert.deepEqual(restatedSupportSettings(text, settings), ["cutoff"], text);
  }
  for (const text of ["setTimeout(f, 10000)", "const T = 10_000;", "t = 10000.0"]) {
    assert.deepEqual(restatedSupportSettings(text, settings), ["timeout_ms"], text);
  }
  for (const text of ["x = 0.55", "x = 10.5", "x = 1.0.5", "t = 110000", "t = 100000", "v0.5.1", "a.timeout_ms"]) {
    assert.deepEqual(restatedSupportSettings(text, settings), [], text);
  }
});

test("package.json declares no dependency", () => {
  const manifest = JSON.parse(readFileSync(join(extensionDir, "..", "..", "..", "package.json"), "utf8"));
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.devDependencies, undefined);
});
