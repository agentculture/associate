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
 * 4. registers the `tool_call` write guard (spec c4/c5);
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
import { Type } from "typebox";
import { evaluateToolCall } from "./lib/guard.ts";
import { normalizeHandback, unreferencedCount } from "./lib/handback.ts";
import { installPromptInjection } from "./lib/prompt.ts";
import { registerAssociateProvider } from "./lib/provider.ts";
import { createAssociateContext, loadToolModules } from "./lib/runtime.ts";
import { installStatementsRecorder } from "./lib/statements.ts";
import { installContinueFrom } from "./lib/torch.ts";
import { installWalkRecorder } from "./lib/walk.ts";

/** Registered by this file rather than by a module under `tools/`. */
export const CORE_TOOL_NAMES = ["associate_ready", "finish"] as const;

export default async function (pi: ExtensionAPI) {
  const ctx = createAssociateContext();
  const { contract, session } = ctx;

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

  // ---------------------------------------------------------------- sentinel
  pi.registerTool({
    name: "associate_ready",
    label: "Associate Ready",
    description:
      "Report that the associate extension is loaded: its version, the contract version it " +
      "read, and the tools available in this session. Call it when asked to confirm readiness.",
    promptSnippet: "Confirm the associate extension loaded and report its contract version",
    parameters: Type.Object({}),
    async execute() {
      const active = pi.getActiveTools();
      const report = {
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
        // What a launcher checks (spec c34). Measured against pi 0.84.2:
        // `getAllTools()` lists every *configured* tool, built-ins included,
        // while `defaultTools: []` narrows the *active* set — the tools the
        // model is actually offered. So the launcher's check is
        // `writer_tools_active` being empty, not `tools`.
        tools: pi.getAllTools().map((tool) => tool.name),
        active_tools: active,
        writer_tools_active: active.filter((name) => ctx.contain.isWriter(name)),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(report) }],
        details: report,
      };
    },
  });

  // ------------------------------------------------------------------ finish
  pi.registerTool({
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
      const handback = normalizeHandback(params);
      const details = {
        handback,
        unreferenced: unreferencedCount(handback),
        export_dir: session.exportDir,
        session_id: session.sessionId,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(handback) }],
        details,
        // The hand-back is the end of the task; there is nothing to follow up.
        terminate: true,
      };
    },
  });

  // -------------------------------------------------------------- write guard
  pi.on("tool_call", (event) => {
    return evaluateToolCall({
      toolName: event.toolName,
      input: event.input,
      scratchDir: session.scratchDir,
      cwd: ctx.checkoutRoot,
      declaredWriters: ctx.declaredWriters(),
      declaredNonWriters: ctx.declaredNonWriters(),
    });
  });

  // ---------------------------------------------------------------- provider
  // The lane's endpoint, key and model id are configuration (spec c14/h22);
  // reasoning is switched off in the request payload, not assumed from a
  // compat flag (spec c28/h8). With no key set this registers nothing and
  // prints one hint naming the variables — a clone still starts.
  registerAssociateProvider(pi);

  // ------------------------------------------------------------- tool modules
  await loadToolModules(pi, ctx);

  // ------------------------------------------------- writers off, by contract
  // Deviation d7 (measured 2026-09-12): `defaultTools: []` lives in the
  // project's .pi/settings.json and does not travel with a globally installed
  // package — run in an unrelated directory, pi still offered edit and write.
  // The restriction has to be the extension's own, so every writer is removed
  // from the active set here. Declared non-writers (the argv shell) survive.
  // setActiveTools is an action method and pi refuses those while extensions
  // are still loading, so it runs on session_start (fired right after load)
  // and again on before_agent_start in case a later hook re-enabled a writer.
  const dropWriters = () => {
    const active = pi.getActiveTools();
    const withoutWriters = active.filter((name) => !ctx.contain.isWriter(name));
    if (withoutWriters.length !== active.length) {
      pi.setActiveTools(withoutWriters);
    }
  };
  pi.on("session_start", async () => dropWriters());
  pi.on("before_agent_start", async () => dropWriters());
}
