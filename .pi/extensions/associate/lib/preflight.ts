/**
 * The preflight extension — a pi session that proves the load and then stops.
 *
 * Deviation d8 (measured on the live lane, 2026-09-12). The launcher used to
 * prove readiness by *hoping* the model called `associate_ready` in the same
 * turn as the real task: with the readiness-only prompt it did, and with a real
 * task prompt it went straight to the work, so a perfectly healthy run was
 * refused. A proof that depends on the model's choice of tools is not a proof.
 *
 * The fix has two halves. `index.ts` writes the same report the sentinel
 * returns to `<exportDir>/ready.json` on `session_start`, which pi fires at
 * startup — before any prompt and before any provider request. This module is
 * the other half: a standalone extension whose only job is to end the process
 * on `before_agent_start`, the first event after the prompt is accepted and
 * still ahead of the first model request (pi `docs/extensions.md`, "Lifecycle
 * Overview").
 *
 * So the launcher runs pi twice: once with this module added via `-e`, which
 * loads every extension, writes `ready.json` and exits without spending a
 * single token, and then — only if that report passes the gate — once for the
 * real task, unchanged.
 *
 * `lib/` is not an auto-discovered extension location (pi loads
 * `.pi/extensions/<name>/index.ts`), so this file is inert unless a launcher
 * asks for it explicitly with `-e`.
 */

/** The minimal slice of `ExtensionAPI` this module uses. */
export interface PreflightHost {
  on(event: string, handler: (event: Record<string, unknown>) => unknown): void;
}

export default async function (pi: PreflightHost): Promise<void> {
  pi.on("before_agent_start", () => {
    // `ready.json` was written synchronously during `session_start`, so there is
    // nothing left to flush. Exiting here is what keeps a preflight free: the
    // provider is never called.
    process.exit(0);
  });
}
