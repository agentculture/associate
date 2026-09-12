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

test("ASSOCIATE_CONTRACT_DIR wins over the repo-relative fallback", () => {
  const real = loadContract({});
  const dir = mkdtempSync(join(tmpdir(), "associate-contract-"));
  try {
    mkdirSync(join(dir, "schemas"), { recursive: true });
    writeFileSync(join(dir, "policy.json"), JSON.stringify({ version: 99, export: {} }));
    for (const name of SCHEMA_NAMES) {
      writeFileSync(join(dir, "schemas", `${name}.schema.json`), JSON.stringify({ title: name }));
    }
    const contract = loadContract({ ASSOCIATE_CONTRACT_DIR: dir });
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
  const needles = [
    ...denylist.slice(0, 5).map((pattern) => `"${pattern}"`),
    ...allowlist.map((entry) => `"${entry.command}"`),
  ];
  const shipped = [
    join(extensionDir, "index.ts"),
    ...collectTypeScript(join(extensionDir, "lib")),
    ...collectTypeScript(join(extensionDir, "tools")),
  ];
  for (const path of shipped) {
    const text = readFileSync(path, "utf8");
    for (const needle of needles) {
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
