/**
 * How far this run trusts the checkout it examines (deviations d5, d17).
 *
 * The Python launcher (`associate/harness/pi.py` `PiHarness.environment()`)
 * sets `$ASSOCIATE_PI_TRUST` from the flags it launched pi with: `approve` for
 * a trusted checkout, `untrusted` under `--untrusted-checkout`. One reading of
 * it serves every consumer, so `spawn_subagent` (a child is never more
 * trusting than its parent) and `lib/prompt.ts` (an untrusted checkout's
 * `AGENTS.md` is never injected) cannot disagree.
 *
 * Fail safe: only the exact value `approve` is trust. Absent, empty, any other
 * casing or any other value — including a pi started by a launcher that sets
 * nothing, such as the mesh's pi-acp today — is untrusted.
 */

/** The environment variable carrying the launcher's trust mode. */
export const PI_TRUST_ENV = "ASSOCIATE_PI_TRUST";

/** The only value of {@link PI_TRUST_ENV} that trusts the checkout. */
export const PI_TRUSTED = "approve";

/** True only when the launcher said, exactly, that the checkout is trusted. */
export function isCheckoutTrusted(env: Record<string, string | undefined>): boolean {
  return env[PI_TRUST_ENV] === PI_TRUSTED;
}
