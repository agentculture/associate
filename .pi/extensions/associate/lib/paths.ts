/**
 * Where this extension lives on disk.
 *
 * Every other module resolves its paths from here rather than from
 * `process.cwd()`, so the extension keeps working when pi is started from a
 * subdirectory and so a test can import a rewritten copy of `index.ts` from a
 * temp directory and still discover the real `lib/` and `tools/`.
 */

import { dirname, join } from "node:path";

/** `.pi/extensions/associate/lib` */
export const libDir: string = import.meta.dirname;

/** `.pi/extensions/associate` */
export const extensionDir: string = dirname(libDir);

/** `.pi/extensions/associate/tools` — one module per registered tool. */
export const toolsDir: string = join(extensionDir, "tools");

/**
 * The extension's own version.
 *
 * Reported by the `associate_ready` sentinel so a launcher can tell which
 * build of the extension actually loaded (spec c34: the launcher verifies the
 * extension loaded from the tool list pi reports, never from the config file
 * on disk). This is not a contract value — the contract's version is
 * `policy.json`'s `version` field and is reported alongside it.
 */
export const EXTENSION_VERSION = "0.1.0";
