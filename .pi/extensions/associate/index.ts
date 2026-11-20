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
 *    disk (spec c34) — and `finish`, whose payload is the hand-back, checked
 *    by `lib/facts.ts` in report or enforce mode (issue #20, t11) with
 *    facts.json, check.json, report.json and answer.md written to the export;
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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { checkHandback, type HandbackCheck, type HandbackReport } from "./lib/facts.ts";
import { compileGate, createGate, type Gate, type GateConfig } from "./lib/gate.ts";
import { decideToolCall, RefusalCap } from "./lib/guard.ts";
import {
  ANSWER_FILENAME,
  CHECK_FILENAME,
  FACTS_FILENAME,
  REJECTED_HANDBACK_FILENAME,
  REPORT_FILENAME,
  argumentsFromErrorText,
  buildHandbackInput,
  checkModeOverride,
  factsPayload,
  formatRefusals,
  normalizeHandback,
  prepareFinishArguments,
  quotedListFields,
  refusalsOf,
  rejectedHandbackRecord,
  rejectionStage,
  resolveCheckMode,
  scoreCheckedFacts,
  supportAnswerCounts,
  supportScoredCount,
  unreferencedCount,
  withSupport,
  withUncheckedCounts,
  type FactSupport,
  type UncheckedCounts,
} from "./lib/handback.ts";
import { installPromptInjection } from "./lib/prompt.ts";
import { registerAssociateProvider } from "./lib/provider.ts";
import { countSentences, renderAnswer } from "./lib/render.ts";
import { createAssociateContext, loadToolModules } from "./lib/runtime.ts";
import { FinishReminder, resolveFinishReminder, type SettleEventLike } from "./lib/reminder.ts";
import { createSupportCache, type SupportOptions } from "./lib/support.ts";
import { supportScoreFor } from "./lib/supportswitch.ts";
import { assistantMessageText, installStatementsRecorder, messageHasToolCalls } from "./lib/statements.ts";
import { installFinalMessageRecorder } from "./lib/finalmessage.ts";
import { installContinueFrom, resolveContinueFrom } from "./lib/torch.ts";
import { activeToolSet, resolveActiveModel, toolsOutsideContract } from "./lib/toolset.ts";
import { compileRedaction, contentToText, installWalkRecorder, stampContent, stampText } from "./lib/walk.ts";

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

  // Where this run's writes land (d8), snapshotted at load like the gate's
  // environment; `associate run` sets it from the run it actually started.
  const isolation = process.env.ASSOCIATE_ISOLATION;

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
  const walk = installWalkRecorder(pi, ctx, {
    model: model.key,
    lobes_role: model.entry?.lobes_role,
  });
  // The spawn tool (tools/spawn.ts, plan t16) links each child walk here.
  ctx.attachWalk(walk);

  // ------------------------------------------------------- statements record
  // Artifact B (spec c25/c31): the model's claims, each carrying the walk ids
  // it referenced, with every `path:N` citation checked against the walk's
  // recorded read ranges. Installed after the walk so a statement is always
  // verified against a walk that is already on disk.
  installStatementsRecorder(pi, ctx);
  // The latest prose-only assistant message, whole, as `final_message.md`: the
  // statements above are a split that drops headings, list markers and code,
  // and a run that ends without `finish` leaves no answer.md.
  installFinalMessageRecorder(pi, ctx);

  // ----------------------------------------------------------- runtime prompt
  // The launcher passes `--no-context-files` because pi loads AGENTS.md /
  // CLAUDE.md from every ANCESTOR directory, and a workspace-level file above
  // the checkout would re-task this lane. With discovery off, this injects
  // associate's OWN AGENTS.md as the runtime prompt and, only for a trusted
  // checkout (`$ASSOCIATE_PI_TRUST=approve`, d17), the examined checkout's
  // AGENTS.md labelled as repository context. Registers nothing unless
  // `$ASSOCIATE_INJECT_PROMPT` is set.
  // The model prompt follows the model resolved above — one rule, one snapshot.
  installPromptInjection(pi, ctx, process.env, model);

  // ------------------------------------------------------------ continue-from
  // `$ASSOCIATE_CONTINUE_FROM` loads a prior run's walk as this session's
  // first context, so a second agent does not re-walk it. Registers nothing
  // when the variable is unset.
  installContinueFrom(pi, ctx);

  // Set by finish (d9): after the hand-back only a text reply is allowed.
  // Per PROMPT, not per session: the mesh resident runs one long-lived
  // `pi --mode rpc` session (pi-acp) and sends one prompt per mesh request, so
  // before_agent_start below clears it when the next task begins.
  let finished = false;

  // ------------------------------------------------------- hand-back check
  // Issue #20, plan t11. finish runs the hand-back checker (lib/facts.ts) over
  // the facts payload and writes facts.json, check.json, report.json and
  // answer.md into the export, in every session (headless, mesh, child). The
  // mode is accuracy.json's for the active model, overridable per run by
  // $ASSOCIATE_CHECK_MODE (snapshotted at load, like the other ASSOCIATE_*
  // variables). In enforce mode a failing hand-back is refused with what is
  // wrong and the fix, `finished` stays false, and the model may answer again
  // for accuracy.json `retry_rounds` more rounds; the last refused round — or
  // the `refusal_cap`-th refusal in a row, counted by the same RefusalCap class
  // the tool_call guard uses — ends the run with outcome 'refused'.
  const accuracy = contract.accuracy;
  const modeOverride = checkModeOverride(process.env);
  if (modeOverride.problem) console.error(modeOverride.problem);
  const checkMode = resolveCheckMode(accuracy, model.key, modeOverride.mode);
  const retryRounds =
    Number.isInteger(accuracy?.retry_rounds) && accuracy.retry_rounds >= 0 ? accuracy.retry_rounds : undefined;
  if (retryRounds === undefined) {
    console.error(
      `associate: accuracy.json retry_rounds must be a non-negative integer, got ${JSON.stringify(accuracy?.retry_rounds)}; ` +
        "in enforce mode a refused hand-back ends the run at once",
    );
  }
  const continueFrom = resolveContinueFrom(process.env);
  const redaction = compileRedaction(contract.policy);
  // ------------------------------------------------ support score (decider t3)
  // Spec c1/c2: after the quote check, finish asks the decider whether each
  // passed fact's quote supports its value and stores the answer beside the
  // check (check.json `facts[i].support`, report.json `support_scored` and
  // `support_answers`, one count per contract option). It is
  // a report-only signal: it is asked after `accepted`, the refusals and the
  // counts are fixed, and nothing reads it back into them. Off (the default
  // for every model in accuracy.json) nothing is sent and no field is written.
  // The switch, the environment (base URL and key) and the gate contract are
  // snapshotted at load like the gate's; `fetch` is looked up per request, so
  // a test's fake decider is `globalThis.fetch`. One cache per session (s7):
  // a retry round reuses every score (only scores are kept, so a pair that
  // was not scored is asked again), and the message_end rewrite asks nothing,
  // reading the scores saved with the accepted hand-back. finish writes the
  // quote-check files before it asks (review finding 1).
  const supportSettings = supportScoreFor(accuracy, model.key, process.env, (line) => console.error(line));
  const supportEnv = { ...process.env };
  const supportCache = createSupportCache();
  let supportConfig: GateConfig | undefined;
  if (supportSettings) {
    try {
      supportConfig = compileGate(contract);
    } catch (error) {
      console.error(
        `associate: the support score cannot reach the decider (${error instanceof Error ? error.message : String(error)}); ` +
          "every fact will be recorded as not scored",
      );
    }
  }
  const supportOptions = (settings: SupportOptions["settings"], config: GateConfig, signal?: AbortSignal): SupportOptions => ({
    settings,
    config,
    env: supportEnv,
    redaction,
    fetch: ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as typeof fetch,
    cache: supportCache,
    signal,
  });
  const scoreFacts = async (
    check: HandbackCheck,
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<FactSupport | undefined> => {
    if (!supportSettings) return undefined;
    if (!supportConfig) {
      return check.facts.map((f) =>
        f.verdict === "passed"
          ? { status: "not_scored" as const, reason: "contract_invalid" as const, detail: "the decider's contract did not compile" }
          : undefined,
      );
    }
    return scoreCheckedFacts(check, payload, supportOptions(supportSettings, supportConfig, signal));
  };
  // check_quote (decider t4) asks with these same options and this same cache.
  if (supportSettings) {
    ctx.attachSupport((signal) => (supportConfig ? supportOptions(supportSettings, supportConfig, signal) : null));
  }

  // Per prompt, reset by before_agent_start with `finished`.
  let handbackRefusals = 0;
  let handbackEnded = false;
  let handbackCap: RefusalCap | undefined;
  try {
    handbackCap = new RefusalCap(accuracy?.refusal_cap as number);
  } catch {
    // The tool_call guard below reports the same bad cap once; rounds still apply.
  }
  // The accepted hand-back of the current prompt, so the final message that
  // follows it can be counted as unchecked text and the report rewritten.
  let accepted:
    | {
        payload: Record<string, unknown>;
        check: HandbackCheck;
        checkRecord: Record<string, unknown>;
        summary: string;
        answer: string;
        /**
         * The support score per fact (decider t3), aligned with `check.facts`;
         * undefined when the score is off. What check.json's `facts[i].support`
         * and report.json's `support_scored` are written from, and rewritten
         * from on message_end without asking again.
         */
        support: FactSupport | undefined;
      }
    | undefined;

  const writeExport = (name: string, text: string): void => {
    try {
      mkdirSync(session.exportDir, { recursive: true });
      writeFileSync(join(session.exportDir, name), text, "utf8");
    } catch (error) {
      console.error(
        `associate: could not write ${name} to the export (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  };
  const writeJson = (name: string, value: unknown): void => writeExport(name, `${JSON.stringify(value, null, 2)}\n`);

  // ------------------------------------------------ finish reminder (d3)
  // Issue #38: a run about to settle with no accepted finish is reminded,
  // with accuracy.json's text, up to its `max` times per session. Only when
  // `associate run` switched it on ($ASSOCIATE_FINISH_REMINDER=on, snapshotted
  // at load); absent or off — the mesh resident, a spawned child — nothing is
  // created and no settle handler is registered below. Each reminder is a
  // walk line and updates reminder.json; with none sent the export is as it
  // was without this.
  const reminderSetting = resolveFinishReminder(accuracy, process.env);
  if (reminderSetting.problem) console.error(reminderSetting.problem);
  const finishReminder = reminderSetting.settings
    ? new FinishReminder({
        settings: reminderSetting.settings,
        recordLine: (info) => walk.recordReminder(info),
        writeJson,
        warn: (line) => console.error(line),
      })
    : undefined;
  const writeReport = (report: HandbackReport, counts: UncheckedCounts, support?: FactSupport): void =>
    writeJson(REPORT_FILENAME, {
      ...withUncheckedCounts(report, counts),
      ...(support !== undefined && supportSettings
        ? {
            support_scored: supportScoredCount(support),
            support_answers: supportAnswerCounts(support, supportSettings.options),
          }
        : {}),
    });

  // ------------------------------------------- the rejected hand-back (t3)
  // Every rejected finish payload — pi's argument validation, the quoted-list
  // refusal of prepareFinishArguments, or the check in enforce mode — is kept
  // in REJECTED_HANDBACK_FILENAME, labelled rejected, the latest replacing any
  // earlier one. The raw arguments come from tool_execution_start (pi emits it
  // with the arguments as the model sent them, before prepareArguments and
  // validation); without one, from the arguments pi quoted in its error text.
  const finishStartArgs = new Map<string, unknown>();
  let rejectedFinishes = 0;
  const rawFinishArgs = (
    toolCallId: string | undefined,
    fallback: { args?: unknown; errorText?: string },
  ): { payload: unknown; source: Parameters<typeof rejectedHandbackRecord>[0]["payloadSource"] } => {
    if (toolCallId !== undefined && finishStartArgs.has(toolCallId)) {
      return { payload: finishStartArgs.get(toolCallId), source: "tool_execution_start" };
    }
    const quoted = fallback.errorText !== undefined ? argumentsFromErrorText(fallback.errorText) : undefined;
    if (quoted) return { payload: quoted, source: "error_text" };
    if (fallback.args !== undefined) return { payload: fallback.args, source: "tool_arguments" };
    return { payload: {}, source: "none" };
  };
  const writeRejected = (options: {
    stage: ReturnType<typeof rejectionStage>;
    error: string;
    toolCallId: string | undefined;
    args?: unknown;
    refusals?: Parameters<typeof rejectedHandbackRecord>[0]["refusals"];
  }): void => {
    rejectedFinishes += 1;
    const raw = rawFinishArgs(options.toolCallId, { args: options.args, errorText: options.error });
    writeJson(
      REJECTED_HANDBACK_FILENAME,
      rejectedHandbackRecord({
        stage: options.stage,
        error: options.error,
        toolCallId: options.toolCallId,
        rejections: rejectedFinishes,
        payload: raw.payload,
        payloadSource: raw.source,
        refusals: options.refusals,
        filter: redaction,
      }),
    );
  };
  pi.on("tool_execution_start", (event) => {
    const e = event as { toolCallId?: unknown; toolName?: unknown; args?: unknown };
    if (e.toolName !== "finish" || typeof e.toolCallId !== "string") return;
    try {
      finishStartArgs.set(e.toolCallId, structuredClone(e.args ?? {}));
    } catch {
      // Arguments that cannot be cloned are not kept; the error text is the fallback.
    }
  });
  pi.on("tool_execution_end", (event) => {
    const e = event as { toolCallId?: unknown; toolName?: unknown; isError?: unknown; result?: unknown };
    if (e.toolName !== "finish") return;
    const toolCallId = typeof e.toolCallId === "string" ? e.toolCallId : undefined;
    if (e.isError === true) {
      // A finish that ended in an error result never reached the hand-back:
      // pi rejected its arguments, the quoted-list shim refused them, or the
      // tool threw. The enforce-mode refusal is not an error result and is
      // written by execute itself.
      const result = e.result as { content?: unknown } | undefined;
      const error = contentToText(result && typeof result === "object" ? result.content : undefined);
      writeRejected({ stage: rejectionStage(error), error, toolCallId });
    }
    if (toolCallId !== undefined) finishStartArgs.delete(toolCallId);
    // Any finish that ended, accepted, refused or rejected, follows a reminder.
    finishReminder?.noteFinish();
  });

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
  // The facts-payload fields mirror associate/contract/schemas/facts.schema.json
  // in plain JSON Schema (pi 1.5.2 validates arguments with pi-schema). Every
  // one is optional, so a hand-back with only a summary is still valid input;
  // the checker, not the schema, enforces the cross-field rules.
  const text = (description: string) => Type.String({ description });
  host.registerTool({
    name: "finish",
    label: "Finish",
    description:
      "End the task and hand the result back. The payload IS the deliverable: the facts you found, " +
      "the alternatives you weighed, your verdicts with the facts they rest on, and what is still " +
      "open with the check that would decide it. Each fact points at its evidence: give the walk id " +
      "it came from (source), where in that result the evidence is (at: {lines: [first, last]} or " +
      "{search: \"term\"}), its kind (direct, llm or derived) and, for a derived fact, based_on. " +
      "Do not retype evidence: the harness copies the quoted text and the command from the saved " +
      "result and renders the answer from what passes; the summary is never a checked answer. " +
      "Try a pointer with check_quote first. " +
      "associate never writes its result into the checkout — call finish instead.",
    promptSnippet: "Hand the finished result back as the payload; associate never writes it to disk",
    promptGuidelines: [
      "End every task with finish: its payload is the hand-back, and a result left only in chat is not delivered.",
      "Give each fact the walk id shown on the tool result it came from, at (where in that result the evidence is), its kind, and based_on when it is derived. Point; do not retype evidence.",
      "Give each statement passed to finish the walk entry ids that evidence it; a statement with none is reported as unreferenced.",
    ],
    // Plan t3 (c38): a list field sent as a string holding a JSON list is
    // unquoted before pi validates; any other string there is refused with a fix.
    prepareArguments: prepareFinishArguments,
    parameters: Type.Object({
      schema_version: Type.Optional(
        Type.Number({ description: "The facts schema version this payload is written for (2 adds kind, at and based_on)." }),
      ),
      summary: Type.Optional(
        text("Free text. Delivered under an unchecked label, never as the checked answer."),
      ),
      facts: Type.Optional(
        Type.Array(
          Type.Object({
            id: text("Fact id: f1, f2, …"),
            value: text(
              "The value found, written as text: a number, an identifier, a path, or a short phrase. " +
                "A direct fact may leave it out (the harness uses the copied text); an llm or derived fact needs it.",
            ),
            source: text(
              "The walk id the fact came from, exactly as the harness line on that tool result showed it " +
                "(w3), or a run label and a walk id for a prior or child run (prior:w3, c1:w2). Never a path.",
            ),
            quote: text(
              "Do not copy text from results into quote: point with at instead, and the harness copies the evidence. " +
                "Older form: text copied word for word from that entry's result; it must contain a literal value.",
            ),
            action: Type.Optional(
              Type.Boolean({
                description:
                  "True when the fact states that an action happened (a tool ran, a file changed, a test passed, a record was stored).",
              }),
            ),
            tool: Type.Optional(text("For an action fact: the tool whose call the fact says happened.")),
            // Strict facts (t1): contract fields only. Nothing reads them yet, and
            // value/quote stay required here until the strict hand-back task.
            kind: Type.Optional(
              Type.String({
                enum: ["direct", "llm", "derived"],
                description:
                  "direct (default): the cited result itself shows it. llm: your judgement on what the evidence means; " +
                  "say so, and give value. derived: follows from other facts; list them in based_on, and give value.",
              }),
            ),
            at: Type.Optional(
              Type.Object(
                {
                  lines: Type.Optional(
                    Type.Array(Type.Number(), {
                      minItems: 2,
                      description:
                        "First and last line, from 1 at the first line below the walk id line; for a read result, " +
                        "the line numbers shown at the start of each line.",
                    }),
                  ),
                  search: Type.Optional(text("A term; the first line of the cited result that contains it exactly is the evidence.")),
                },
                { description: "Where in the cited result the fact is read: exactly one of lines or search." },
              ),
            ),
            based_on: Type.Optional(
              Type.Array(text("A fact id of this hand-back, e.g. f1."), { description: "For a derived fact: the ids of the facts it follows from." }),
            ),
          }),
          { description: "What you found, each tied to one walk entry by a quote." },
        ),
      ),
      alternatives: Type.Optional(
        Type.Array(
          Type.Object({
            id: text("Alternative id: a1, a2, …"),
            text: text("The alternative explanation or answer."),
            predicts: text("What would be seen if this alternative held."),
            refuted_by: text("What would refute it."),
          }),
          { description: "The alternatives you weighed." },
        ),
      ),
      verdicts: Type.Optional(
        Type.Array(
          Type.Object({
            id: text("Verdict id: v1, v2, …"),
            text: text("The conclusion."),
            verdict: text("One of: supported, refuted, open, cannot_tell."),
            basis: Type.Array(text("A fact id of this hand-back, e.g. f1."), {
              description: "Ids of the facts this verdict rests on.",
            }),
            alternative: Type.Optional(text("The alternative id this verdict decides, e.g. a1.")),
            unread: Type.Optional(
              Type.Array(text("Something not read that bears on this verdict."), {
                description: "What was not read; a supported or refuted verdict must have none.",
              }),
            ),
            check: Type.Optional(text("For open or cannot_tell: the check that would decide it.")),
            closing: Type.Optional(
              Type.Boolean({ description: "Marks the closing conclusion; otherwise the last verdict closes." }),
            ),
          }),
          { description: "Your conclusions, each with the facts it rests on." },
        ),
      ),
      open_items: Type.Optional(
        Type.Array(
          Type.Object({
            id: text("Open item id: o1, o2, …"),
            text: text("What is still open."),
            check: Type.Optional(text("The check that would decide it; an open item without one is refused.")),
            basis: Type.Optional(Type.Array(text("A fact id of this hand-back, e.g. f1."))),
          }),
          { description: "What is still open, each with the check that would decide it." },
        ),
      ),
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
    async execute(toolCallId, params, signal) {
      const raw = (params ?? {}) as Record<string, unknown>;
      // The list fields the model sent quoted, which prepareFinishArguments unquoted.
      const quoted = finishStartArgs.has(toolCallId) ? quotedListFields(finishStartArgs.get(toolCallId)) : [];
      // The walk's own ids are the only evidence that exists: a claim citing
      // anything else is not referenced, however well-shaped the id looks.
      const handback = normalizeHandback(raw, false, walk.entryIds());
      const unreferenced = unreferencedCount(handback);
      const payload = factsPayload(raw, redaction);
      writeJson(FACTS_FILENAME, payload);

      const check = checkHandback(
        buildHandbackInput({ payload, exportDir: session.exportDir, walkPath: walk.walkPath, continueFrom }),
        accuracy,
      );
      const refusals = refusalsOf(check, payload);
      const summary = typeof payload.summary === "string" ? payload.summary : "";
      const counts: UncheckedCounts = { summary_sentences: countSentences(summary), final_message_sentences: 0 };
      // check.json's fields shared by both outcomes; `support` adds the score
      // per fact (decider t3) and is undefined while it is not yet asked or off.
      const baseFor = (support: FactSupport | undefined) => ({
        mode: checkMode.mode,
        mode_source: checkMode.source,
        accepted: check.accepted,
        facts: withSupport(check.facts, support),
        verdicts: check.verdicts,
        open_items: check.open_items,
        unchecked_text: { ...counts, final_message: "none" },
        ...(quoted.length > 0 ? { quoted_lists: quoted } : {}),
      });
      const base = baseFor(undefined);
      const where = { export_dir: session.exportDir, session_id: session.sessionId };
      // Review finding 1: every quote-check file and the session state are
      // written first, exactly as with the score off, so a run killed while
      // the decider is asked (up to the total scoring time) leaves a whole,
      // score-less hand-back. Only then is the score asked, and the files it
      // changes are written again with it.
      const scoreAfter = () => scoreFacts(check, payload, signal as AbortSignal | undefined);

      if (checkMode.mode === "enforce" && !check.accepted) {
        // A refused hand-back is not a hand-back: `finished` stays false, the
        // statements recorder gets no `details.handback`, no answer is left on
        // disk, and tools stay callable for the next round.
        handbackRefusals += 1;
        const capped =
          handbackCap?.note({
            block: true,
            kind: "handback_refused",
            reason: "the hand-back failed the check",
            fix: "fix each refused item and call finish again",
          }).capped === true;
        const roundsLeft = Math.max(0, (retryRounds ?? 0) - handbackRefusals + 1);
        const last = roundsLeft === 0 || capped;
        const why = capped
          ? `refusal ${handbackRefusals} in a row reached accuracy.json refusal_cap (${handbackCap?.limit})`
          : `accuracy.json retry_rounds (${retryRounds ?? 0}) allowed no further round`;
        const refusedRecord = (support: FactSupport | undefined) => ({
          ...baseFor(support),
          outcome: "refused",
          round: handbackRefusals,
          rounds_left: roundsLeft,
          run_ended: last,
          refusals,
        });
        writeJson(CHECK_FILENAME, refusedRecord(undefined));
        writeReport(check.report, counts);
        rmSync(join(session.exportDir, ANSWER_FILENAME), { force: true });
        accepted = undefined;
        writeRejected({
          stage: "check",
          error: `the hand-back failed the check (enforce mode), round ${handbackRefusals}`,
          toolCallId,
          args: raw,
          refusals,
        });
        if (last) {
          walk.markOutcome("refused");
          handbackEnded = true;
        }
        // The refused round is scored too, after it is on disk as refused;
        // the score changes no refusal, and a later round reuses each score.
        const refusedSupport = await scoreAfter();
        if (refusedSupport !== undefined) {
          writeJson(CHECK_FILENAME, refusedRecord(refusedSupport));
          writeReport(check.report, counts, refusedSupport);
        }
        const head = {
          outcome: "refused",
          accepted: false,
          mode: checkMode.mode,
          round: handbackRefusals,
          rounds_left: roundsLeft,
          run_ended: last,
          refusals,
        };
        const message = last
          ? `Hand-back refused by the check (enforce mode), round ${handbackRefusals}: ${why}. ` +
            "The run is ended with outcome 'refused'; no result is accepted. What failed:\n" +
            formatRefusals(refusals)
          : `Hand-back refused by the check (enforce mode), round ${handbackRefusals}; ` +
            `${roundsLeft} round${roundsLeft === 1 ? "" : "s"} left. Nothing was handed back. Fix each item below ` +
            "(tools are still available), then call finish again with the whole hand-back:\n" +
            formatRefusals(refusals);
        const result = {
          content: [
            { type: "text" as const, text: JSON.stringify(head) },
            { type: "text" as const, text: message },
          ],
          details: { ...head, ...where },
        };
        return last ? { ...result, terminate: true } : result;
      }

      // Accepted (enforce: it passed; report: whatever the checker found).
      // Deviation d9 (measured 2026-09-12 on the mesh): with `terminate: true`
      // the loop ended on this call and the model never produced a final
      // message, so culture's ACP bridge — which relays chat text, not tool
      // payloads — posted nothing. The hand-back is recorded here; the turn
      // continues for exactly one text reply, and every further tool call is
      // blocked below.
      finished = true;
      handbackCap?.note(undefined);
      const wouldRefuse = checkMode.mode === "report" ? refusals : [];
      let answer = renderAnswer({ payload, check, summary });
      const checkRecord = { ...base, outcome: "accepted", would_refuse: wouldRefuse };
      writeJson(CHECK_FILENAME, checkRecord);
      writeReport(check.report, counts);
      writeExport(ANSWER_FILENAME, answer);
      const recorded = { payload, check, checkRecord, summary, answer, support: undefined as FactSupport | undefined };
      accepted = recorded;

      const support = await scoreAfter();
      if (support !== undefined) {
        answer = renderAnswer({ payload, check, summary, support });
        const scoredRecord = { ...baseFor(support), outcome: "accepted", would_refuse: wouldRefuse };
        writeJson(CHECK_FILENAME, scoredRecord);
        writeReport(check.report, counts, support);
        writeExport(ANSWER_FILENAME, answer);
        // The saved object the message_end rewrite reads, unless a later
        // prompt replaced it while the score was asked.
        if (accepted === recorded) accepted = { ...recorded, checkRecord: scoredRecord, answer, support };
      }

      const count = handback.statements.length;
      const f = check.report.facts;
      const lines = [
        `Hand-back recorded (${count} statement${count === 1 ? "" : "s"}, ${unreferenced} unreferenced; ` +
          `facts: ${f.made} made, ${f.passed} quote-checked and passed, ${f.refused} refused, ${f.unchecked} unchecked; ` +
          `check mode ${checkMode.mode}). Now reply to the requester with exactly the answer below as your final ` +
          "message, then stop — a hand-back alone does not reach a mesh requester, and no further tool call is allowed.",
      ];
      for (const field of quoted) {
        lines.push(
          `\`${field}\` arrived as a string holding a JSON list; it was parsed and checked as that list. ` +
            `Next time pass \`${field}\` as a list, not as a string.`,
        );
      }
      if (wouldRefuse.length > 0) {
        lines.push(
          `In enforce mode these ${wouldRefuse.length} item${wouldRefuse.length === 1 ? "" : "s"} would have been refused ` +
            "(report mode: recorded, not refused):",
          formatRefusals(wouldRefuse),
        );
      }
      return {
        content: [
          // The normalized hand-back stays first, as JSON, for the recorder and
          // for a parent reading a child's result (tools/spawn.ts).
          {
            type: "text",
            text: JSON.stringify({ ...handback, outcome: "accepted", mode: checkMode.mode, facts_checked: f }),
          },
          { type: "text", text: lines.join("\n") },
          { type: "text", text: answer },
        ],
        details: {
          handback,
          unreferenced,
          outcome: "accepted",
          mode: checkMode.mode,
          facts_checked: f,
          ...where,
        },
      };
    },
  });

  // ------------------------------------------------- the final message (t11)
  // The final message arrives after finish, in a message_end event. It is
  // unchecked text: its sentences are counted into check.json and report.json
  // (as statements with no fact) and it is kept in answer.md under the
  // unchecked label. A final message that is exactly the rendered answer adds
  // nothing. Registered after the statements recorder, which this handler
  // never touches: only the extension's own report files are rewritten.
  pi.on("message_end", (event) => {
    if (!finished || !accepted) return;
    const message = (event as { message?: unknown }).message;
    if (!message || typeof message !== "object") return;
    if ((message as { role?: unknown }).role !== "assistant") return;
    if (messageHasToolCalls(message)) return;
    const said = redaction.apply(assistantMessageText(message));
    if (!said) return;
    const same = said.replace(/\s+/g, " ").trim() === accepted.answer.replace(/\s+/g, " ").trim();
    const counts: UncheckedCounts = {
      summary_sentences: countSentences(accepted.summary),
      final_message_sentences: same ? 0 : countSentences(said),
    };
    const checkRecord = {
      ...accepted.checkRecord,
      unchecked_text: { ...counts, final_message: same ? "rendered_answer" : "unchecked" },
    };
    writeJson(CHECK_FILENAME, checkRecord);
    writeReport(accepted.check.report, counts, accepted.support);
    if (!same) {
      writeExport(
        ANSWER_FILENAME,
        renderAnswer({ payload: accepted.payload, check: accepted.check, summary: accepted.summary, finalMessage: said, support: accepted.support }),
      );
    }
  });

  // --------------------------------------------------------- tool_call guard
  // Order (lib/guard.ts decideToolCall): finished → model set → stated purpose → senses refuses
  // repo mutations before the gate → pure reads proceed → mutations, and
  // `gated_tools` calls from any model (d6/d7: memory write, web), go through the
  // gate, its entry appended to the walk → a truncated gate state refuses.
  //
  // Issue #20: a call with no stated purpose is refused after the model-set
  // check (accuracy.json `purpose_exempt_tools` excepted), and the same kind of
  // refusal repeated up to accuracy.json `refusal_cap` ends the run — pi's
  // documented `terminate: true` — rather than looping on it to the time
  // limit. A cap the contract does not state as a positive integer leaves the
  // run uncapped, said once at load.
  //
  // fix-refusal-cap (live run acc20-worker-gate-thresholds, pi 1.5.2): the
  // refusals of one turn count once (RefusalCap, per `turn_start`), and the
  // walk outcome is not pinned at the capping refusal. pi 1.5.2 stops early
  // only when every finalized result in the batch terminates, so a capped
  // refusal beside an allowed call does not end the run. The cap is held
  // pending; a later `turn_start` means pi went on and forgets it (the count
  // stays, so the next same-kind refusal caps again); `agent_end` with the
  // cap still pending pins `refused`. pi 1.5.2 docs: agent_end fires when the
  // low-level run ends, inside the run lifecycle and so before
  // `session_shutdown` and the walk's finalize; pi may still retry or take a
  // queued message after it, which shows up here as another `turn_start` and
  // lifts that pin again.
  let refusals: RefusalCap | undefined;
  try {
    refusals = new RefusalCap(contract.accuracy?.refusal_cap as number);
  } catch (error) {
    console.error(
      `associate: ${error instanceof Error ? error.message : String(error)}; repeated refusals will not end the run`,
    );
  }
  let countedTask = task;
  // Monotonic over the session (pi's own turnIndex is per run). 0 until the
  // first turn_start: a host that sends none counts every call as its own turn.
  let turnCount = 0;
  let capPending = false;
  let capPinned = false;
  pi.on("turn_start", () => {
    turnCount += 1;
    capPending = false;
    if (capPinned) {
      // pi went on after agent_end (retry, compaction retry, follow-up): the
      // run the pin described did not end there.
      walk.clearOutcome("refused");
      capPinned = false;
    }
  });
  pi.on("agent_end", () => {
    if (capPending && !handbackEnded && !finished) {
      walk.markOutcome("refused");
      capPinned = true;
    }
    capPending = false;
  });
  pi.on("before_agent_start", () => {
    // A new prompt: a pin left by the previous prompt's run stays (that run
    // did end refused); only a turn of the same run lifts it.
    capPinned = false;
    capPending = false;
  });
  // The finish reminder (d3), at pi's last actionable boundary: after
  // agent_end above (so a refusal-cap pin is already set) and only when no
  // retry or queued message will run. pi skips this event for an aborted run;
  // FinishReminder also refuses an outcome other than "completed". A
  // continuation is not a new prompt (no before_agent_start), so `finished`
  // and the enforce-mode round count carry over. The preflight never gets
  // here: lib/preflight.ts exits at before_agent_start.
  if (finishReminder) {
    pi.on("agent_before_settle", (event) =>
      finishReminder.atSettle(event as SettleEventLike, { finished, endedRefused: handbackEnded || capPinned }),
    );
  }
  pi.on("tool_call", async (event, eventCtx) => {
    if (finished) {
      // Not counted toward the refusal cap: the hand-back is already recorded,
      // and a capped outcome would misreport a delivered run as refused.
      const reason =
        "the task was already handed back with finish. Fix: reply to the requester " +
        "with the answer finish returned as your final message instead of calling tools";
      const entry = walk.recordBlocked(event.toolCallId, reason);
      return { block: true, reason: entry ? stampText(entry.id, reason) : reason };
    }
    if (handbackEnded) {
      // The run already ended on a refused hand-back (t11); its outcome is set.
      const reason =
        "the run was ended with outcome 'refused': the hand-back failed the check in its last round. " +
        "Fix: none in this run; the operator reads check.json in the export and starts a new run";
      const entry = walk.recordBlocked(event.toolCallId, reason);
      return { block: true, reason: entry ? stampText(entry.id, reason) : reason, terminate: true };
    }
    const piCtx = eventCtx as { modelRegistry?: unknown; signal?: AbortSignal } | undefined;
    const decision = await decideToolCall({
      toolName: event.toolName,
      input: event.input,
      model,
      registry: contract.models,
      policy: contract.policy,
      gate,
      task,
      isolation,
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
      // review r2/5: an allowed call holds the checkout until its tool_execution_end.
      toolCallId: event.toolCallId,
      testWindow: ctx.testWindow,
      purposeExemptTools: contract.accuracy?.purpose_exempt_tools,
    });
    // A new prompt is a new task (before_agent_start sets `task`): its
    // refusals are counted afresh.
    if (task !== countedTask) {
      refusals?.reset();
      countedTask = task;
    }
    const counted = refusals?.note(decision, turnCount > 0 ? turnCount : undefined);
    if (!decision?.block) {
      // An allowed call in the batch: pi does not stop on it, so no cap
      // decided earlier in this turn ends the run.
      capPending = false;
      return undefined;
    }
    let reason = decision.reason;
    const capped = counted?.capped === true;
    if (capped) {
      reason +=
        ` This is refusal ${counted!.count} in a row of the same kind (${decision.kind}), counted once per turn, ` +
        `the contract's refusal_cap (accuracy.json); the run is ended with outcome 'refused'.`;
      capPending = true;
    }
    // L4: pi sends no tool_result for a blocked call; record the refusal now.
    const entry = walk.recordBlocked(event.toolCallId, reason);
    // Plan t9: pi makes the reason the result text the model receives, so the
    // stamp rides at its head; the entry's error keeps the unstamped reason.
    if (entry) reason = stampText(entry.id, reason);
    // pi's documented hook result: `fix` and `kind` already ride in the reason.
    return capped ? { block: true, reason, terminate: true } : { block: true, reason };
  });

  // ------------------------------------------------------- walk-id stamp (t9)
  // Every tool result the model is sent begins with one harness line naming
  // the walk id of that call (`walk id: wN`, lib/walk.ts WALK_ID_STAMP_PREFIX).
  // pi 1.5.2 `tool_result` handlers chain in load order and may return a
  // partial patch; this one is registered after the walk and statements
  // recorders, so both — and the saved result the matcher reads — see the
  // result unstamped, and the id is the one the walk recorder just wrote for
  // this call id. Replacing `content` drops `structuredContent` unless it is
  // returned too, so it is passed through unchanged.
  pi.on("tool_result", (event) => {
    const e = event as { toolCallId?: string; content?: unknown; structuredContent?: unknown };
    const id = walk.entryIdFor(e.toolCallId);
    if (!id) return undefined;
    return {
      content: stampContent(id, e.content),
      ...(e.structuredContent !== undefined ? { structuredContent: e.structuredContent } : {}),
    };
  });

  // review r2/5: pi emits tool_execution_end for every prepared call, blocked or
  // run, so this releases exactly the holds the guard took above.
  // Plan t9 (approved deviation): a call pi rejected before the hook (unknown
  // tool, invalid arguments) reaches only this event; the walk records it here,
  // and ignores every call id it already recorded or noted.
  pi.on("tool_execution_end", (event) => {
    ctx.testWindow.end(event.toolCallId);
    walk.recordUnseenEnd(event as Parameters<typeof walk.recordUnseenEnd>[0]);
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
  // A new prompt is a new task. Only what belongs to ONE task is reset here:
  // the gate's task text and the post-finish block. The walk, the statements
  // artifact and the gate's id counter stay session-scoped on purpose — they
  // describe the whole session (one export dir per session id), and the
  // transcript the model sees is session-scoped too.
  pi.on("before_agent_start", async (event) => {
    const prompt = (event as { prompt?: unknown } | undefined)?.prompt;
    if (typeof prompt === "string") task = prompt;
    finished = false;
    handbackRefusals = 0;
    handbackEnded = false;
    handbackCap?.reset();
    accepted = undefined;
    applyModelToolSet();
  });
}
