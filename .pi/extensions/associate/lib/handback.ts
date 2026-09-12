/**
 * Normalizing the `finish` payload into the contract's statements artifact.
 *
 * Spec c40/c41 (issue #4): a run exports the walk (artifact A) and the
 * statements (artifact B), where each claim carries evidence references into
 * the walk and a claim with no reference is flagged UNREFERENCED. Two fields
 * are explicitly *not* the model's to set, and this module enforces that:
 *
 * - `status` is derived from whether the claim actually carries evidence ids;
 * - `check` on a citation starts as `unverifiable` and is upgraded to
 *   `encountered` only by the harness-side verifier that compares the citation
 *   against the read ranges recorded in the walk;
 * - `not_fully_read` is set by the tool that truncated, so it is taken from
 *   the run rather than from the payload.
 *
 * The shape checked here is `associate/contract/schemas/statements.schema.json`.
 * This module does not restate the schema's *values* — it only maps the tool's
 * input onto the fields the schema names.
 */

/** Evidence ids are walk entry ids: `w1`, `w2`, … (statements schema `$defs`). */
const EVIDENCE_ID = /^w[1-9][0-9]*$/;

export interface RawStatement {
  text?: unknown;
  evidence?: unknown;
}

export interface RawCitation {
  path?: unknown;
  line?: unknown;
}

export interface FinishInput {
  summary?: unknown;
  statements?: unknown;
  citations?: unknown;
}

export interface Handback {
  summary: string;
  statements: Array<{ text: string; evidence: string[]; status: "referenced" | "unreferenced" }>;
  citations: Array<{ path: string; line: number; check: "encountered" | "unverifiable" }>;
  not_fully_read: boolean;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Build the hand-back artifact from what the model passed to `finish`.
 *
 * `notFullyRead` comes from the run, not the payload.
 */
export function normalizeHandback(input: FinishInput, notFullyRead = false): Handback {
  const rawStatements = Array.isArray(input.statements) ? input.statements : [];
  const statements = rawStatements
    .map((entry) => {
      const item = (entry ?? {}) as RawStatement;
      const text = asString(item.text).trim();
      const evidence = (Array.isArray(item.evidence) ? item.evidence : [])
        .filter((id): id is string => typeof id === "string" && EVIDENCE_ID.test(id.trim()))
        .map((id) => id.trim());
      return {
        text,
        evidence,
        status: (evidence.length > 0 ? "referenced" : "unreferenced") as
          | "referenced"
          | "unreferenced",
      };
    })
    .filter((item) => item.text.length > 0);

  const rawCitations = Array.isArray(input.citations) ? input.citations : [];
  const citations = rawCitations
    .map((entry) => {
      const item = (entry ?? {}) as RawCitation;
      const line = typeof item.line === "number" ? Math.trunc(item.line) : Number.NaN;
      return {
        path: asString(item.path).trim(),
        line,
        // Upgraded to "encountered" only by the walk verifier, never here.
        check: "unverifiable" as const,
      };
    })
    .filter((item) => item.path.length > 0 && Number.isFinite(item.line));

  return {
    summary: asString(input.summary).trim(),
    statements,
    citations,
    not_fully_read: notFullyRead,
  };
}

/** How many claims carry no evidence reference at all. */
export function unreferencedCount(handback: Handback): number {
  return handback.statements.filter((statement) => statement.status === "unreferenced").length;
}
