import type { Pill } from "../model/runs";

/** A run's status as a word in a pill; the tone adds colour, never replaces the word. */
export function StatusPill({ pill, large = false }: { pill: Pill; large?: boolean }) {
  return (
    <span className={`pill pill--${pill.tone}${large ? " pill--large" : ""}`} data-tone={pill.tone}>
      {pill.tone === "running" ? <span className="pill__pulse" aria-hidden="true" /> : null}
      {pill.label}
    </span>
  );
}

export default StatusPill;
