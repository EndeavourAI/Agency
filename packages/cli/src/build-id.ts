import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_DAEMON_ENTRY = join(import.meta.dir, "daemon-entry.ts");

/** A compiled binary: Bun serves its sources from a virtual root. */
export const STANDALONE = /^(B:[\\/]~BUN|\/\$bunfs)[\\/]/.test(Bun.main);

/**
 * The build of this Agency: where its daemon's code lives and when that file last changed. The CLI and the daemon
 * compute it alike; an upgrade or another checkout gives another value. An edit in a dev checkout does not.
 */
export function daemonBuild(): string {
  const file = STANDALONE ? process.execPath : DEFAULT_DAEMON_ENTRY;
  try {
    return `${realpathSync(file)}@${Math.round(statSync(file).mtimeMs)}`;
  } catch {
    return file;
  }
}
