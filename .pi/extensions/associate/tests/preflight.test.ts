/**
 * The preflight extension (deviation d8): it must register one
 * `before_agent_start` handler and nothing else.
 *
 * The handler itself calls `process.exit(0)`, so it is deliberately NOT fired
 * here — firing it would end the test process. What is asserted is the shape:
 * a default-exported factory that hooks the one event which runs after
 * `session_start` (where the extension writes `ready.json`) and before any
 * provider request.
 */

import test from "node:test";
import assert from "node:assert/strict";
import preflight from "../lib/preflight.ts";

test("the preflight extension registers exactly one before_agent_start handler", async () => {
  const handlers = new Map<string, Array<(event: Record<string, unknown>) => unknown>>();
  const fake = {
    on(event: string, handler: (event: Record<string, unknown>) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool() {
      throw new Error("the preflight extension must register no tool");
    },
    registerProvider() {
      throw new Error("the preflight extension must register no provider");
    },
  };

  await preflight(fake);

  assert.deepEqual([...handlers.keys()], ["before_agent_start"]);
  assert.equal(handlers.get("before_agent_start")!.length, 1);
  assert.equal(typeof handlers.get("before_agent_start")![0], "function");
});
