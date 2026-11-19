// The finish reminder (deviation d3, issue #38).
//
// A model sometimes ends its task turn without calling `finish`: it writes its
// hand-back as a plain final message, and the export holds no facts.json,
// check.json or answer.md. At pi's `agent_before_settle` — the last point at
// which an extension may append session entries and ask for one more agent
// run (pi 1.5.2 docs/extensions.md) — this module adds one hidden custom
// message, the contract's reminder text, and asks pi to continue.
//
// It is active only for a run `associate run` started with it switched on: the
// launcher sets ASSOCIATE_FINISH_REMINDER to `on` or `off` for every run (an
// operator's ambient value is never inherited). With the variable absent — the
// mesh resident through pi-acp, a spawned child — nothing is registered, so a
// conversational session is never nagged. Every setting is the contract's
// (`accuracy.json` `finish_reminder`); no wording or count is written here.
//
// What a reminder leaves: a `{"reminder": …}` line in the walk per reminder,
// and REMINDER_FILENAME in the export, `{"sent": n, "finish_followed": bool}`,
// written only once a reminder was sent. `finish_followed` turns true when the
// model calls finish (any outcome: accepted, refused by the check, or rejected
// by pi's argument validation) after the latest reminder. With no reminder sent the
// export is byte-identical to a run without this module.

import { finishReminderSettings, type FinishReminderSettings } from "./contract.ts";

/** The per-run switch the launcher sets: `on` or `off`. Absent means off. */
export const FINISH_REMINDER_ENV = "ASSOCIATE_FINISH_REMINDER";

/** The export file the Python side reads; written only after a reminder was sent. */
export const REMINDER_FILENAME = "reminder.json";

/** The `customType` of the custom message pi is handed. */
export const REMINDER_MESSAGE_TYPE = "associate-finish-reminder";

const SHOWN_CHARS = 40;

/** The part of `accuracy.json` this module reads. */
type Accuracy = { readonly finish_reminder?: unknown };

/**
 * The settings when the reminder is on for this run. `on` with no usable
 * section, or a value that is neither `on` nor `off`, is no reminder and a
 * `problem` for one stderr line. Absent, blank or `off` is `{}`. Pure.
 */
export function resolveFinishReminder(
  accuracy: Accuracy | undefined,
  env: Record<string, string | undefined>,
): { settings?: FinishReminderSettings; problem?: string } {
  const raw = env[FINISH_REMINDER_ENV];
  const value = raw?.trim() ?? "";
  if (value === "" || value === "off") return {};
  if (value !== "on") {
    return {
      problem:
        `associate: ${FINISH_REMINDER_ENV}=${JSON.stringify(String(raw).slice(0, SHOWN_CHARS))} is not 'on' or 'off'; ` +
        "no finish reminder is sent",
    };
  }
  const read = finishReminderSettings(accuracy);
  if (read.settings) return { settings: read.settings };
  return {
    problem:
      `associate: ${FINISH_REMINDER_ENV}=on, but ${read.problem ?? "accuracy.json has no finish_reminder section"}; ` +
      "no finish reminder is sent",
  };
}

/** What `agent_before_settle` hands a handler, as far as this module reads it. */
export interface SettleEventLike {
  entries?: unknown;
  outcome?: unknown;
}

/** The session state the decision needs, read from index.ts at the boundary. */
export interface SettleState {
  /** `finish` was accepted for the current prompt. */
  finished: boolean;
  /** The run already ended refused: the last round's hand-back, or the refusal cap. */
  endedRefused: boolean;
}

export interface FinishReminderOptions {
  settings: FinishReminderSettings;
  /** Writes the walk line; throws when it cannot (the reminder is then not sent). */
  recordLine: (info: { max: number }) => unknown;
  /** Writes one JSON file into the export. */
  writeJson: (name: string, value: unknown) => void;
  warn?: (line: string) => void;
}

/** One session's reminders: the budget, the walk lines and the export record. */
export class FinishReminder {
  private sentCount = 0;
  private followed = false;
  private readonly options: FinishReminderOptions;

  constructor(options: FinishReminderOptions) {
    this.options = options;
  }

  get sent(): number {
    return this.sentCount;
  }

  /**
   * The boundary result that sends one reminder, or undefined. Sent only for
   * a run that completed (not aborted, not ended in an error) and that pi can
   * continue, with no accepted finish, not already ended refused, and the
   * contract's budget not yet spent.
   */
  atSettle(event: SettleEventLike, state: SettleState): { entries: unknown[]; continue: true } | undefined {
    if (state.finished || state.endedRefused) return undefined;
    if (event.outcome !== "completed") return undefined;
    // `event.context.canContinue` is not read: it describes the context before
    // this handler's entry is added, and that context ends with the model's own
    // message, so pi 1.5.2 reports false on every ordinary settle and continues
    // once the reminder is appended.
    if (this.sentCount >= this.options.settings.max) return undefined;
    try {
      this.options.recordLine({ max: this.options.settings.max });
    } catch (error) {
      (this.options.warn ?? (() => undefined))(
        `associate: the finish reminder was not sent: its walk line could not be written ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
      return undefined;
    }
    this.sentCount += 1;
    this.followed = false;
    this.writeRecord();
    const entries = Array.isArray(event.entries) ? event.entries : [];
    return {
      entries: [
        ...entries,
        { type: "custom_message", customType: REMINDER_MESSAGE_TYPE, content: this.options.settings.text, display: false },
      ],
      continue: true,
    };
  }

  /** A finish call ended (any outcome): after a reminder, that reminder was followed. */
  noteFinish(): void {
    if (this.sentCount === 0 || this.followed) return;
    this.followed = true;
    this.writeRecord();
  }

  private writeRecord(): void {
    this.options.writeJson(REMINDER_FILENAME, { sent: this.sentCount, finish_followed: this.followed });
  }
}
