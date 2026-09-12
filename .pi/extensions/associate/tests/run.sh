#!/usr/bin/env bash
# Runs the associate Pi extension's tests with Node's built-in test runner.
#
# Why this script exists instead of a package.json "scripts" entry: this
# repo's package.json is a Pi project manifest and must carry no "scripts"
# and no "dependencies" (see CLAUDE.md). The exact node invocation and its
# flags live here instead.
#
# Discovers any *.test.ts under this directory (recursively) and runs them
# with node --test. Node 22.6+ supports --experimental-strip-types for
# executing TypeScript directly; Node 23+ strips types by default and no
# longer needs the flag (passing it there is harmless but unnecessary).
# Below Node 22, TypeScript stripping isn't available at all, so this
# script skips (exit 0) with a printed reason rather than failing the job.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "SKIP: node not found on PATH"
  exit 0
fi

node_version="$(node --print 'process.versions.node')"
node_major="${node_version%%.*}"

if [ "$node_major" -lt 22 ]; then
  echo "SKIP: node ${node_version} is below the minimum (22) needed for TypeScript type-stripping; skipping extension tests"
  exit 0
fi

node_minor="$(node --print "process.versions.node.split('.')[1]")"

strip_flag="--experimental-strip-types"
if [ "$node_major" -ge 23 ]; then
  # Node 23+ strips types by default; the flag is unnecessary there (and
  # unrecognized on some 23.x builds), so omit it.
  strip_flag=""
elif [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 6 ]; then
  echo "SKIP: node ${node_version} is below 22.6, which is required for --experimental-strip-types"
  exit 0
fi

echo "Running extension tests with node ${node_version}"

shopt -s globstar nullglob
test_files=("${script_dir}"/**/*.test.ts)

if [ "${#test_files[@]}" -eq 0 ]; then
  echo "SKIP: no *.test.ts files found under ${script_dir}"
  exit 0
fi

if [ -n "$strip_flag" ]; then
  exec node --test "$strip_flag" "${test_files[@]}"
else
  exec node --test "${test_files[@]}"
fi
