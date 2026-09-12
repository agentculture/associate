/**
 * Per-session scratch and export directories.
 *
 * Spec c42: every run gets its own scratch and export directory keyed by
 * session id — the ACP session id culture's `session/new` logged when the lane
 * runs on the mesh, a generated id headless — so two concurrent mesh tasks
 * against the same checkout never share a scratch dir or interleave walk
 * entries. Spec c34/c38: the export directory is never inside the checkout
 * being examined, so a full run leaves `git status --porcelain` empty.
 *
 * The three booleans that govern this live in `policy.json`'s `export`
 * section; nothing here re-decides them.
 */

import { mkdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { policySection, type ContractPolicy } from "./contract.ts";

/**
 * Environment variables that may carry a session id, most specific first.
 *
 * `PI_ACP_SESSION_ID` is what the ACP launcher exports for the session
 * culture's runner opened; `ASSOCIATE_SESSION_ID` lets the Python adapter pin
 * one for a headless run.
 */
export const SESSION_ID_ENV_KEYS = [
  "ASSOCIATE_SESSION_ID",
  "PI_ACP_SESSION_ID",
  "ACP_SESSION_ID",
] as const;

/**
 * Directory name used under the checkout's parent when the contract names no
 * export root of its own. Not a policy value — a filesystem default the
 * contract may override with `export.root` or `export.root_name`.
 */
const DEFAULT_EXPORT_ROOT_NAME = ".associate-runs";

export interface SessionDirs {
  /** The id the directories are keyed by. */
  readonly sessionId: string;
  /** True when the id came from the environment rather than being generated. */
  readonly sessionIdFromEnv: boolean;
  /** Root holding every session's directories, outside the examined checkout. */
  readonly exportRoot: string;
  /** `<exportRoot>/<sessionId>` — this session's own directory. */
  readonly sessionRoot: string;
  /** The only directory any tool of this extension may write into. */
  readonly scratchDir: string;
  /** Where walk.jsonl and the statements artifact are written. */
  readonly exportDir: string;
}

/**
 * Make an arbitrary id safe to use as one path segment.
 *
 * ACP session ids are opaque strings; a `/` or `..` in one must not be able to
 * redirect the scratch directory.
 */
export function sanitizeSessionId(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 96);
  return cleaned || generateSessionId();
}

/** A generated id: sortable timestamp plus randomness, unique per process. */
export function generateSessionId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

/** The session id from the environment, or a generated one. */
export function resolveSessionId(env: Record<string, string | undefined> = process.env): {
  sessionId: string;
  fromEnv: boolean;
} {
  for (const key of SESSION_ID_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) return { sessionId: sanitizeSessionId(value), fromEnv: true };
  }
  return { sessionId: generateSessionId(), fromEnv: false };
}

/** True when `child` is `parent` itself or lies underneath it. */
export function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * Where every session directory lives.
 *
 * `$ASSOCIATE_EXPORT_ROOT` wins when set (the Python adapter passes the run's
 * root); otherwise the contract's `export.root`, then `export.root_name` under
 * the checkout's parent, then `.associate-runs` under the checkout's parent.
 * When the contract says `outside_examined_checkout`, a root that would land
 * inside the checkout is refused rather than quietly relocated — a silent
 * relocation would make an artifact appear somewhere the operator is not
 * looking.
 */
export function resolveExportRoot(
  checkoutRoot: string,
  policy: ContractPolicy,
  env: Record<string, string | undefined> = process.env,
): string {
  const exportPolicy = policySection(policy, "export");
  const checkout = resolve(checkoutRoot);

  const fromEnv = env.ASSOCIATE_EXPORT_ROOT?.trim();
  const fromPolicy = typeof exportPolicy.root === "string" ? exportPolicy.root.trim() : "";
  const rootName =
    typeof exportPolicy.root_name === "string" && exportPolicy.root_name.trim()
      ? exportPolicy.root_name.trim()
      : DEFAULT_EXPORT_ROOT_NAME;

  const root = fromEnv
    ? resolve(fromEnv)
    : fromPolicy
      ? resolve(checkout, fromPolicy)
      : join(dirname(checkout), rootName);

  if (exportPolicy.outside_examined_checkout === true && isInside(checkout, root)) {
    throw new Error(
      `export root ${root} is inside the examined checkout ${checkout}, but the ` +
        "contract's export.outside_examined_checkout is true",
    );
  }
  return root;
}

/**
 * Resolve (and by default create) this session's scratch and export dirs.
 *
 * Both paths carry the session id, so an operator can join a mesh transcript
 * to its walk and two parallel sessions can never collide.
 */
export function resolveSessionDirs(options: {
  checkoutRoot: string;
  policy: ContractPolicy;
  env?: Record<string, string | undefined>;
  create?: boolean;
}): SessionDirs {
  const env = options.env ?? process.env;
  const { sessionId, fromEnv } = resolveSessionId(env);
  const exportRoot = resolveExportRoot(options.checkoutRoot, options.policy, env);
  const sessionRoot = join(exportRoot, sessionId);
  const scratchDir = join(sessionRoot, "scratch");
  const exportDir = join(sessionRoot, "export");

  if (options.create !== false) {
    mkdirSync(scratchDir, { recursive: true });
    mkdirSync(exportDir, { recursive: true });
  }

  return {
    sessionId,
    sessionIdFromEnv: fromEnv,
    exportRoot,
    sessionRoot,
    scratchDir,
    exportDir,
  };
}
