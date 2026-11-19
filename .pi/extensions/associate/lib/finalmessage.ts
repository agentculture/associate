/**
 * The final message file: the model's last prose message, whole.
 *
 * `statements.json` and `statements.md` hold the model's prose split into
 * statements (`lib/statements.ts` `splitStatements`): headings and fenced code
 * are skipped, list markers are removed and wrapped lines are joined, so the
 * message cannot be rebuilt from them. `answer.md` keeps the final message
 * only after an accepted `finish`. A run that ends without `finish` therefore
 * kept the whole of its last message nowhere; the run result holds a bounded
 * tail of it.
 *
 * This writes `final_message.md` into the session export: the text blocks of
 * the latest assistant message that calls no tool, redacted with the
 * contract's patterns and otherwise unchanged (no heading, no label, no added
 * newline). Each such message replaces the file, so at the end of a run it
 * holds the last one. It is written whether or not `finish` was called.
 *
 * Additive only: the handler returns nothing and touches no other file.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssociateContext } from "./context.ts";
import { assistantMessageText, messageHasToolCalls } from "./statements.ts";
import { compileRedaction } from "./walk.ts";

/** The final message's file name inside the session export directory. */
export const FINAL_MESSAGE_FILENAME = "final_message.md";

/** Install the final message recorder on a pi instance. */
export function installFinalMessageRecorder(
  pi: {
    on(event: string, handler: (event: Record<string, unknown>) => unknown): void;
  },
  ctx: AssociateContext,
): void {
  const filter = compileRedaction(ctx.policy);
  const path = join(ctx.session.exportDir, FINAL_MESSAGE_FILENAME);

  pi.on("message_end", (event) => {
    const message = (event as { message?: unknown }).message;
    if (!message || typeof message !== "object") return;
    if ((message as { role?: unknown }).role !== "assistant") return;
    if (messageHasToolCalls(message)) return;
    const text = assistantMessageText(message);
    if (!text) return;
    try {
      mkdirSync(ctx.session.exportDir, { recursive: true });
      writeFileSync(path, filter.apply(text), "utf8");
    } catch (error) {
      console.error(
        `associate: could not write ${FINAL_MESSAGE_FILENAME} to the export (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  });
}
