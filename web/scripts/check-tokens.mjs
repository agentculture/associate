#!/usr/bin/env node
// scripts/check-tokens.mjs
//
// Cited from qodo-cli web/scripts/check-tokens.mjs @ ee73d5682a02952a76567887995b4f2e3aca5ea2
// (which cited culture-rules web/scripts/check-tokens.mjs @ b7f861f690b57c4355f81371cc02ad1dd2ae9cac;
// cite-don't-import: this repo owns its copy).
// Adapted: the environment variable is ASSOCIATE_DESIGN_SOURCE_REPO (as qodo-cli: the optional
// second check reads culture-rules' tokens.css at the recorded commit; unset, it is skipped).
//
// src/culture-design/tokens.css = a provenance header + a VERBATIM copy of agentculture/org
// site-astro/src/styles/global.css. This script:
//   1. always: hashes everything after the header and asserts it equals the recorded sha256,
//      which catches any hand edit and works offline;
//   2. when ASSOCIATE_DESIGN_SOURCE_REPO names a culture-rules checkout holding the recorded commit:
//      reads its tokens.css AT THAT COMMIT (`git show`, never the working tree) and asserts its
//      body is byte-identical.
//
// Exit 0 on pass, 1 on any failure. Node stdlib + git only.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKENS = path.join(WEB, "src", "culture-design", "tokens.css");
const SOURCE_PATH = "web/src/culture-design/tokens.css";
const SOURCE_REPO = process.env.ASSOCIATE_DESIGN_SOURCE_REPO;
const SENTINEL = "---- verbatim copy of site-astro/src/styles/global.css follows ----";

let failures = 0;
const ok = (msg) => console.log(`ok   - ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.error(`FAIL - ${msg}`);
};
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const bodyOf = (css) => {
  const at = css.indexOf(SENTINEL);
  const close = at >= 0 ? css.indexOf("*/", at) : -1;
  const nl = close >= 0 ? css.indexOf("\n", close) : -1;
  return nl < 0 ? null : css.slice(nl + 1);
};

if (!existsSync(TOKENS)) {
  fail(`${path.relative(WEB, TOKENS)} does not exist`);
  process.exit(1);
}
const css = readFileSync(TOKENS, "utf8");
const commit = css.match(/^\s*\*\s*Commit:\s*([0-9a-f]{40})\b/m)?.[1];
const recorded = css.match(/^\s*\*\s*Source sha256:\s*([0-9a-f]{64})\s*$/m)?.[1];
const body = bodyOf(css);

if (!commit) fail("header has no 'Commit: <40-hex sha>' line");
if (!recorded) fail("header has no 'Source sha256: <64-hex>' line");
if (body === null) fail(`header is missing the sentinel ("${SENTINEL}") or its closing */`);
if (failures) process.exit(1);

const bodyHash = sha256(body);
if (bodyHash === recorded) ok(`tokens.css body sha256 matches the recorded ${recorded.slice(0, 12)}`);
else fail(`tokens.css body sha256=${bodyHash} != recorded ${recorded} (the verbatim section was edited)`);

if (SOURCE_REPO) {
  let source = null;
  try {
    source = execFileSync("git", ["-C", SOURCE_REPO, "show", `${commit}:${SOURCE_PATH}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    fail(`${SOURCE_REPO} does not hold ${SOURCE_PATH}@${commit.slice(0, 12)}`);
  }
  if (source !== null) {
    if (bodyOf(source) === body) ok(`tokens.css is byte-identical to ${SOURCE_PATH}@${commit.slice(0, 12)}`);
    else fail(`tokens.css body differs from ${SOURCE_PATH}@${commit.slice(0, 12)}`);
  }
} else {
  console.log("skip - ASSOCIATE_DESIGN_SOURCE_REPO unset; the recorded hash is authoritative");
}

if (failures) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
