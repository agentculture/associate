/**
 * associate's Pi extension — the core.
 *
 * What this file does, and only this:
 *
 * 1. loads the portable contract (`policy.json` + the walk/statements schemas)
 *    from the Python package — `$ASSOCIATE_CONTRACT_DIR` when the adapter
 *    passes it, the repo-relative `associate/contract/` otherwise. **No policy
 *    value is defined in TypeScript** (spec c46/c50);
 * 2. resolves one scratch and one export directory for this session, keyed by
 *    the ACP session id when present (spec c42), outside the examined checkout;
 * 3. registers `associate_ready` — the sentinel a launcher uses to prove the
 *    extension actually loaded rather than trusting that the config file is on
 *    disk (spec c34) — and `finish`, whose payload is the hand-back;
 * 4. registers the `tool_call` guard: the active model's tool set (plan t12),
 *    senses' no-mutation rule, and the safety gate (`lib/gate.ts`) in front of
 *    every mutating call of a model that may mutate, each decision appended to
 *    the walk (spec c4/c5, c13, c35, c38);
 * 5. registers the `associate` provider from the environment, with the hook
 *    that switches reasoning off on the wire (spec c14/c28) — or, with no key
 *    configured, registers nothing and prints one hint;
 * 6. dynamically imports every module under `tools/` and calls its
 *    `register(pi, ctx)`, so the next wave of tools plugs in without editing
 *    this file.
 *
 * Imports: pi's own types, `typebox` (provided by pi), and node builtins. No
 * npm dependency is added and no `node_modules` is ever tracked (spec c44).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { createGate, type Gate } from "./lib/gate.ts";
import { decideToolCall } from "./lib/guard.ts";
import { normalizeHandback, unreferencedCount } from "./lib/handback.ts";
import { installPromptInjection } from "./lib/prompt.ts";
import { registerAssociateProvider } from "./lib/provider.ts";
import { createAssociateContext, loadToolModules } from "./lib/runtime.ts";
import { installStatementsRecorder } from "./lib/statements.ts";
import { installContinueFrom } from "./lib/torch.ts";
import { activeToolSet, resolveActiveModel, toolsOutsideContract } from "./lib/toolset.ts";
import { installWalkRecorder } from "./lib/walk.ts";

/** Registered by this file rather than by a module under `tools/`. */
export const CORE_TOOL_NAMES = ["associate_ready", "finish"] as const;

/**
 * The readiness report written into the export directory at `session_start`.
 *
 * Deviation d8: a launcher must not have to hope the model calls
 * `associate_ready`. The same report the sentinel returns is also put on disk
 * before the first prompt is ever sent, so a preflight invocation (see
 * `lib/preflight.ts`) can read it without spending a token.
 */
export const READY_REPORT_FILENAME = "ready.json";

export default async function (pi: ExtensionAPI) {
  const ctx = createAssociateContext();
  const { contract, session } = ctx;

  // ------------------------------------------------------------ active model
  // Resolved once, at load, exactly as the provider resolves it. An unknown or
  // pending ASSOCIATE_MODEL leaves no tool set: every call is refused.
  const model = resolveActiveModel(process.env, contract.models);
  if (model.problem) console.error(model.problem);

  // ------------------------------------------------------------ safety gate
  // One gate per session so gate ids (g1, g2, …) are unique in the walk. The
  // environment is snapshotted at load (endpoint + key); `fetch` is looked up
  // per call. A gate that cannot be built leaves mutations refused.
  let gate: Gate | undefined;
  try {
    gate = createGate({
      contract,
      env: { ...process.env },
      fetch: ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as typeof fetch,
    });
  } catch (error) {
    console.error(
      `associate: the safety gate could not be built (${error instanceof Error ? error.message : String(error)}); ` +
        "every mutating tool call will be refused",
    );
  }

  // The task text the gate scores a call against: the prompt of the current
  // agent run, as pi hands it to before_agent_start. Never a tool result.
  let task = "";

  // Every tool this extension registers is recorded, so it can be checked
  // against models.json `tool_names` — the contract is the source of truth.
  const registered = new Set<string>();
  const host = new Proxy(pi, {
    get(target, prop) {
      if (prop === "registerTool") {
        return (definition: { name?: unknown }) => {
          if (typeof definition?.name === "string") registered.add(definition.name);
          return target.registerTool(definition as Parameters<ExtensionAPI["registerTool"]>[0]);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ExtensionAPI;

  // ------------------------------------------------------------ walk record
  // Installed before anything else registers a tool, so the first tool event
  // of the run is already recorded and `walk.jsonl` exists for the sentinel to
  // name. The export is unconditional — there is no flag (spec c23).
  const walk = installWalkRecorder(pi, ctx);

  // ------------------------------------------------------- statements record
  // Artifact B (spec c25/c31): the model's claims, each carrying the walk ids
  // it referenced, with every `path:N` citation checked against the walk's
  // recorded read ranges. Installed after the walk so a statement is always
  // verified against a walk that is already on disk.
  installStatementsRecorder(pi, ctx);

  // ----------------------------------------------------------- runtime prompt
  // The launcher passes `--no-context-files` because pi loads AGENTS.md /
  // CLAUDE.md from every ANCESTOR directory, and a workspace-level file above
  // the checkout would re-task this lane. With discovery off, this puts the
  // checkout's own AGENTS.md back — and only that file. Registers nothing
  // unless `$ASSOCIATE_INJECT_PROMPT` is set.
  installPromptInjection(pi, ctx);

  // ------------------------------------------------------------ continue-from
  // `$ASSOCIATE_CONTINUE_FROM` loads a prior run's walk as this session's
  // first context, so a second agent does not re-walk it. Registers nothing
  // when the variable is unset.
  installContinueFrom(pi, ctx);

  // Set by finish (d9): after the hand-back only a text reply is allowed.
  let finished = false;

  // ---------------------------------------------------------------- sentinel
  // One report, two readers (deviation d8): the `associate_ready` tool returns
  // it when a model asks, and the `session_start` hook below writes the very
  // same object to `<exportDir>/ready.json` so a launcher never has to ask a
  // model at all. Built fresh on each call — the active tool set is exactly
  // what is being reported, and it changes during startup.
  const buildReport = () => {
    const active = pi.getActiveTools();
    return {
      ok: true,
      extension_version: ctx.extensionVersion,
      contract_version: contract.version,
      contract_dir: contract.dir,
      contract_source: contract.source,
      schemas: Object.keys(contract.schemas),
      session: {
        id: session.sessionId,
        id_from_env: session.sessionIdFromEnv,
        scratch_dir: session.scratchDir,
        export_dir: session.exportDir,
        walk_path: walk.walkPath,
      },
      // What a launcher checks (spec c34). Measured against pi 0.84.2 and
      // re-measured on the pinned 1.1.0: `getAllTools()` lists every
      // *configured* tool, built-ins included (on 1.1.0 also `powershell`,
      // `codemode` and `tool_search`), while `defaultTools: []` narrows the
      // *active* set — since pi 0.86.0 the set declared to the model in the
      // transcript. So the launcher's check is `writer_tools_active` being
      // empty, not `tools`.
      tools: pi.getAllTools().map((tool) => tool.name),
      model: model.key ?? null,
      model_may_mutate: model.mayMutate,
      gate_ready: gate !== undefined,
      tools_outside_contract: toolsOutsideContract(registered, contract.models),
      active_tools: active,
      writer_tools_active: active.filter((name) => ctx.contain.isWriter(name)),
    };
  };

  host.registerTool({
    name: "associate_ready",
    label: "Associate Ready",
    description:
      "Report that the associate extension is loaded: its version, the contract version it " +
      "read, and the tools available in this session. Call it when asked to confirm readiness.",
    promptSnippet: "Confirm the associate extension loaded and report its contract version",
    parameters: Type.Object({}),
    async execute() {
      const report = buildReport();
      return {
        content: [{ type: "text", text: JSON.stringify(report) }],
        details: report,
      };
    },
  });

  // ------------------------------------------------------------------ finish
  host.registerTool({
    name: "finish",
    label: "Finish",
    description:
      "End the task and hand the result back. The payload IS the deliverable: a summary, the " +
      "statements you are making, each with the walk entry ids (w1, w2, …) that evidence it, " +
      "and any file:line citations. associate never writes its result into the checkout — " +
      "call finish instead.",
    promptSnippet: "Hand the finished result back as the payload; associate never writes it to disk",
    promptGuidelines: [
      "End every task with finish: its payload is the hand-back, and a result left only in chat is not delivered.",
      "Give each statement passed to finish the walk entry ids that evidence it; a statement with none is reported as unreferenced.",
    ],
    parameters: Type.Object({
      summary: Type.String({
        description: "The answer, in prose. This is what the caller reads first.",
      }),
      statements: Type.Optional(
        Type.Array(
          Type.Object({
            text: Type.String({ description: "One claim." }),
            evidence: Type.Optional(
              Type.Array(Type.String({ description: "Walk entry id, e.g. w3." })),
            ),
          }),
          { description: "The claims being made, each with its evidence." },
        ),
      ),
      citations: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String({ description: "File path the claim came from." }),
            line: Type.Number({ description: "Absolute line number in that file." }),
          }),
          { description: "file:line provenance a caller can check." },
        ),
      ),
    }),
    async execute(_toolCallId, params) {
      // The walk's own ids are the only evidence that exists: a claim citing
      // anything else is not referenced, however well-shaped the id looks.
      const handback = normalizeHandback(params, false, walk.entryIds());
      const unreferenced = unreferencedCount(handback);
      const details = {
        handback,
        unreferenced,
        export_dir: session.exportDir,
        session_id: session.sessionId,
      };
      // Deviation d9 (measured 2026-09-12 on the mesh): with `terminate: true`
      // the loop ended on this call and the model never produced a final
      // message, so culture's ACP bridge — which relays chat text, not tool
      // payloads — posted nothing. The hand-back is recorded here; the turn
      // continues for exactly one text reply, and every further tool call is
      // blocked below.
      finished = true;
      const count = handback.statements.length;
      return {
        content: [
          // The normalized hand-back stays first, as JSON, for the recorder.
          { type: "text", text: JSON.stringify(handback) },
          {
            type: "text",
            text:
              `Hand-back recorded (${count} statement${count === 1 ? "" : "s"}, ` +
              `${unreferenced} unreferenced). Now reply to the requester with the ` +
              "summary as your final message, then stop — a hand-back alone does " +
              "not reach a mesh requester, and no further tool call is allowed.",
          },
        ],
        details,
      };
    },
  });

  // --------------------------------------------------------- tool_call guard
  // Order (lib/guard.ts decideToolCall): finished → model set → senses refuses
  // repo mutations before the gate → pure reads proceed → mutations, and
  // `gated_tools` calls from any model (d6/d7: memory write, web), go through the
  // gate, its entry appended to the walk → a truncated gate state refuses.
  pi.on("tool_call", async (event, eventCtx) => {
    if (finished) {
      return {
        block: true,
        reason:
          "the task was already handed back with finish; reply to the requester " +
          "with the summary as your final message instead of calling tools",
      };
    }
    const piCtx = eventCtx as { modelRegistry?: unknown; signal?: AbortSignal } | undefined;
    return decideToolCall({
      toolName: event.toolName,
      input: event.input,
      model,
      registry: contract.models,
      policy: contract.policy,
      gate,
      task,
      scratchDir: session.scratchDir,
      cwd: ctx.checkoutRoot,
      declaredWriters: ctx.declaredWriters(),
      declaredNonWriters: ctx.declaredNonWriters(),
      recordGate: (entry) => {
        walk.recordGate(entry);
      },
      evaluateOptions: {
        modelRegistry: piCtx?.modelRegistry as never,
        signal: piCtx?.signal,
      },
    });
  });

  // ---------------------------------------------------------------- provider
  // The lane's endpoint, key and model id are configuration (spec c14/h22);
  // reasoning is switched off in the request payload, not assumed from a
  // compat flag (spec c28/h8). With no key set this registers nothing and
  // prints one hint naming the variables — a clone still starts.
  registerAssociateProvider(pi, process.env, undefined, contract.models);

  // ------------------------------------------------------------- tool modules
  await loadToolModules(host, ctx);

  // The contract is the source of truth for tool names: a registered tool it
  // does not list is reported loudly. It is never active and every call to it
  // is refused, because no model's tool set can name it.
  const outside = toolsOutsideContract(registered, contract.models);
  if (outside.length > 0) {
    console.error(
      `associate: CONTRACT MISMATCH — registered tool(s) not in models.json tool_names: ` +
        `${outside.join(", ")}. They are never activated and every call to them is refused; ` +
        "add them to the contract or stop registering them.",
    );
  }

  // ------------------------------------------------- the model's tool set
  // The active set is the active model's models.json `tools`, intersected with
  // what pi has (getAllTools: this extension's tools plus pi's configured
  // built-ins such as write/edit); for a model that may not mutate every writer
  // is removed as well. Deviation d7 still holds — `defaultTools: []` does not
  // travel with a globally installed package — so the restriction is the
  // extension's own. setActiveTools is an action method pi refuses while
  // extensions load, so it runs on session_start and again on
  // before_agent_start in case an earlier hook re-enabled something. Since pi
  // 0.86.0 a tool change is transcript-backed (measured on 1.1.0,
  // tests/test_provider_wire.py). A later agent_start handler of another
  // extension can still re-enable a tool (risk r8): the tool_call guard above
  // checks the model's set on every call, so such a tool is refused anyway.
  const applyModelToolSet = () => {
    const available = pi.getAllTools().map((tool) => tool.name);
    const wanted = activeToolSet(model, available, (name) => ctx.contain.isWriter(name));
    const active = pi.getActiveTools();
    const same = active.length === wanted.length && wanted.every((name) => active.includes(name));
    if (!same) pi.setActiveTools(wanted);
  };
  // ------------------------------------------------- readiness, on disk (d8)
  // Written after applyModelToolSet so the report can never name a writer the run
  // will not actually offer. A failure to write is swallowed on purpose: the
  // launcher fails closed on the *absence* of the file, which is a louder and
  // more honest signal than a crashed session at startup.
  const writeReadyReport = () => {
    try {
      mkdirSync(session.exportDir, { recursive: true });
      writeFileSync(
        join(session.exportDir, READY_REPORT_FILENAME),
        `${JSON.stringify(buildReport(), null, 2)}\n`,
        "utf8",
      );
    } catch {
      // Intentionally silent — see above.
    }
  };

  pi.on("session_start", async () => {
    applyModelToolSet();
    writeReadyReport();
  });
  pi.on("before_agent_start", async (event) => {
    const prompt = (event as { prompt?: unknown } | undefined)?.prompt;
    if (typeof prompt === "string") task = prompt;
    applyModelToolSet();
  });
}
