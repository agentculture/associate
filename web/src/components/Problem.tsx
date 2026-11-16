import type { ApiError } from "../api/client";

/**
 * Cited from qodo-cli web/src/components/Problem.tsx @ ee73d5682a02952a76567887995b4f2e3aca5ea2
 * (cite-don't-import: this repo owns its copy). Adapted: the words name runs.
 */

/** The words for a failed read: the server's own message and remediation, never a guess. */
export function readMessage(error: ApiError): string {
  if (error.status === 401) return `The API did not accept the credential: ${error.message}`;
  if (error.status === 403) {
    return "Reading runs needs the viewer role, and this credential does not have it.";
  }
  return error.message;
}

/**
 * A failed read: an alert with the message, the remediation when the server gave one, and a
 * retry. Status is said in words (and a heading-weight line), never by colour alone.
 */
export function Problem({
  error,
  onRetry,
}: Readonly<{ error: ApiError; onRetry?: () => void }>) {
  return (
    <div role="alert" className="problem">
      <p className="problem__message">{readMessage(error)}</p>
      {error.remediation ? <p className="problem__hint">Hint: {error.remediation}</p> : null}
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export default Problem;
