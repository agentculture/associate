/**
 * Per-model tool sets and the mutating classifier (plan t12), as pure functions.
 *
 * The extension-level behaviour — the same rules driving a fake pi, a fake
 * decider and the walk — is in tests/toolcall.test.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadContract } from "../lib/contract.ts";
import type { ContractModels, ContractPolicy } from "../lib/contract.ts";
import {
  activeToolSet,
  isMutatingCall,
  isReadOnlyArgv,
  readOnlyShell,
  resolveActiveModel,
  toolsOutsideContract,
} from "../lib/toolset.ts";
import { isWriterTool } from "../lib/guard.ts";

const CONTRACT = loadContract({});
const REGISTRY: ContractModels = CONTRACT.models;
const POLICY: ContractPolicy = CONTRACT.policy;
const isWriter = (name: string) => isWriterTool(name, [], ["bash"]);

const bash = (...argv: string[]) => isMutatingCall("bash", { argv }, REGISTRY, POLICY);

// ------------------------------------------------------------ active model

test("the active model resolves like the provider: ASSOCIATE_MODEL, else the registry default", () => {
  assert.equal(resolveActiveModel({}, REGISTRY).key, REGISTRY.default);
  for (const key of ["worker", "senses", "cortex"]) {
    const model = resolveActiveModel({ ASSOCIATE_MODEL: key }, REGISTRY);
    assert.equal(model.key, key);
    assert.deepEqual([...model.tools], REGISTRY.models[key]!.tools);
    assert.equal(model.mayMutate, REGISTRY.models[key]!.may_mutate);
  }
  assert.equal(resolveActiveModel({ ASSOCIATE_MODEL: "senses" }, REGISTRY).mayMutate, false);
});

test("an unknown or pending model has no tools at all and says why", () => {
  for (const key of ["nope", "super-vl"]) {
    const model = resolveActiveModel({ ASSOCIATE_MODEL: key }, REGISTRY);
    assert.equal(model.key, undefined);
    assert.equal(model.tools.size, 0);
    assert.equal(model.mayMutate, false);
    assert.match(model.problem ?? "", new RegExp(key));
  }
});

test("may_mutate is honoured only when it is strictly true", () => {
  const copy = structuredClone(REGISTRY) as any;
  copy.models.worker.may_mutate = "yes";
  assert.equal(resolveActiveModel({ ASSOCIATE_MODEL: "worker" }, copy).mayMutate, false);
});

// --------------------------------------------------------------- tool sets

test("per model, the active set is exactly its registry tools that pi has", () => {
  const available = [
    ...REGISTRY.tool_names,
    "powershell",
    "codemode",
    "tool_search",
    "mcp__github__create_issue",
  ];
  for (const key of ["worker", "senses", "cortex"]) {
    const model = resolveActiveModel({ ASSOCIATE_MODEL: key }, REGISTRY);
    const active = activeToolSet(model, available, isWriter);
    assert.deepEqual(new Set(active), new Set(REGISTRY.models[key]!.tools), key);
    for (const never of ["powershell", "codemode", "tool_search", "mcp__github__create_issue"]) {
      assert.ok(!active.includes(never), `${never} active for ${key}`);
    }
  }
  // A registry tool pi does not have is not activated.
  const worker = resolveActiveModel({ ASSOCIATE_MODEL: "worker" }, REGISTRY);
  assert.ok(!activeToolSet(worker, ["read", "finish"], isWriter).includes("write"));
});

test("worker and cortex get write/edit; senses never gets a writer, even one its entry lists", () => {
  const available = [...REGISTRY.tool_names];
  for (const key of ["worker", "cortex"]) {
    const active = activeToolSet(resolveActiveModel({ ASSOCIATE_MODEL: key }, REGISTRY), available, isWriter);
    assert.ok(active.includes("write") && active.includes("edit") && active.includes("bash"), key);
  }
  const copy = structuredClone(REGISTRY) as any;
  copy.models.senses.tools.push("write", "edit");
  const senses = activeToolSet(resolveActiveModel({ ASSOCIATE_MODEL: "senses" }, copy), available, isWriter);
  assert.ok(!senses.includes("write") && !senses.includes("edit"), senses.join(", "));
});

test("registered tools outside models.json tool_names are named", () => {
  assert.deepEqual(toolsOutsideContract(["read", "finish"], REGISTRY), []);
  assert.deepEqual(toolsOutsideContract(["read", "zz_new", "aa_new", "zz_new"], REGISTRY), ["aa_new", "zz_new"]);
});

// ------------------------------------------------------------ classifier

test("tools on mutating_tools are mutating; the other registry tools are not", () => {
  for (const name of ["write", "edit", "ledger_append"]) {
    assert.equal(isMutatingCall(name, {}, REGISTRY, POLICY), true, name);
  }
  for (const name of ["read", "grep", "find", "ls", "code_lens", "web_search", "web_page", "eidetic_recall", "ledger_list", "associate_ready", "finish"]) {
    assert.equal(isMutatingCall(name, {}, REGISTRY, POLICY), false, name);
  }
});

test("an unknown tool or an mcp__ tool is never classified read-only", () => {
  for (const name of ["mcp__github__create_issue", "mcp__fs__read_file", "codemode", "powershell", "brand_new"]) {
    assert.equal(isMutatingCall(name, {}, REGISTRY, POLICY), true, name);
  }
});

test("r9: eidetic remember and ledger append are mutating although they are on the shell allowlist", () => {
  assert.equal(bash("eidetic", "remember", "{}"), true);
  assert.equal(bash("ledger", "append", "--json", "{}"), true);
  // Their read-only siblings stay reads.
  assert.equal(bash("eidetic", "recall", "query"), false);
  assert.equal(bash("ledger", "list"), false);
});

test("the read-only shell subset: plain reads skip the gate", () => {
  assert.equal(bash("rg", "-n", "TODO", "lib"), false);
  assert.equal(bash("fd", "-e", "ts"), false);
  assert.equal(bash("ls", "-la"), false);
  assert.equal(bash("cat", "README.md"), false);
  assert.equal(bash("head", "-n", "5", "README.md"), false);
  assert.equal(bash("wc", "-l", "README.md"), false);
  assert.equal(bash("git", "log", "--oneline", "-5"), false);
  assert.equal(bash("git", "diff", "--stat"), false);
  assert.equal(bash("git", "status"), false);
  assert.equal(bash("webglass", "search", "pi"), false);
  assert.equal(bash("code-lens", "symbols", "lib/gate.ts"), false);
});

test("a reading command turned into an execution or a write is mutating", () => {
  assert.equal(bash("fd", "-x", "rm"), true);
  assert.equal(bash("fd", "-Hx", "rm"), true);
  assert.equal(bash("fd", "-X", "rm"), true);
  assert.equal(bash("fd", "--exec", "rm"), true);
  assert.equal(bash("fd", "--exec-batch=rm"), true);
  assert.equal(bash("rg", "--pre", "sh", "x"), true);
  assert.equal(bash("rg", "--pre=sh", "x"), true);
  assert.equal(bash("rg", "--hostname-bin=/bin/sh", "x"), true);
  assert.equal(bash("git", "diff", "--output=/tmp/x"), true);
  assert.equal(bash("git", "log", "--outp=/tmp/x"), true, "git accepts long-option abbreviations");
  assert.equal(bash("git", "diff", "--ext-diff"), true);
  assert.equal(bash("git", "show", "--textconv", "HEAD"), true);
});

test("anything the shell would refuse, or that is not argv, is mutating", () => {
  assert.equal(bash("git", "commit", "-m", "x"), true);
  assert.equal(bash("git", "push"), true);
  assert.equal(bash("rm", "-rf", "."), true);
  assert.equal(bash("cat", "a", ">", "b"), true);
  assert.equal(bash("ls", "|", "sh"), true);
  assert.equal(bash(), true);
  assert.equal(isMutatingCall("bash", { command: "ls" }, REGISTRY, POLICY), true);
  assert.equal(isMutatingCall("bash", { argv: "ls" }, REGISTRY, POLICY), true);
  assert.equal(isMutatingCall("bash", { argv: ["ls", 1] }, REGISTRY, POLICY), true);
  assert.equal(isMutatingCall("bash", undefined, REGISTRY, POLICY), true);
});

test("without a read_only section every shell call is mutating (fail closed)", () => {
  const policy = structuredClone(POLICY) as any;
  delete policy.shell.read_only;
  assert.equal(isReadOnlyArgv(["rg", "x"], policy), false);
  assert.equal(isMutatingCall("bash", { argv: ["git", "log"] }, REGISTRY, policy), true);
});

test("the read-only subset is a subset of the allowlist and excludes every writing subcommand", () => {
  const allow = new Map<string, string[]>(
    ((POLICY.shell as any).allowlist as Array<{ command: string; subcommands: string[] }>).map((e) => [
      e.command,
      e.subcommands,
    ]),
  );
  const subset = readOnlyShell(POLICY);
  assert.ok(subset.size > 0);
  for (const [command, rule] of subset) {
    assert.ok(allow.has(command), `${command} is read-only but not allowlisted`);
    const allowed = allow.get(command)!;
    if (allowed.length > 0) {
      assert.ok(rule.subcommands.length > 0, `${command}: the allowlist names subcommands, the subset must too`);
      for (const sub of rule.subcommands) assert.ok(allowed.includes(sub), `${command} ${sub}`);
    }
  }
  assert.deepEqual(subset.get("eidetic")!.subcommands, ["recall"]);
  assert.deepEqual(subset.get("ledger")!.subcommands, ["list"]);
});
