import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

/**
 * #1093 — whether a path leads into the operator's live state, answered without reading that state.
 *
 * Apart from `isolated-home.ts` so the answer can be tested on its own: that file moves HOME and
 * registers hooks the moment it loads.
 */

/** The operator's live state root, from the passwd entry — HOME is exactly what a test run moves. */
export const LIVE_STATE_ROOT = join(userInfo().homedir, ".agent-control-plane");

export type Realpath = (path: string) => string;

/**
 * Errors that mean "this ancestor cannot be resolved from here": it is absent (ENOENT, ENOTDIR) or
 * unreadable (EPERM, EACCES). The unreadable case is the live root itself on a host whose sandbox
 * protects it — resolving it there fails with EPERM, and a guard that had to read the state it keeps
 * tests out of stopped every test file before its first assertion (#1093, review R2). Any other
 * error is not an answer, and is thrown.
 */
const UNRESOLVABLE: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR", "EPERM", "EACCES"]);

/**
 * `path` with its deepest resolvable ancestor resolved and the rest appended as written. Where the
 * ancestors resolve, a symlinked spelling of the live root still compares equal to it; below one
 * that cannot be read, the comparison is lexical, which is all a protected directory allows.
 */
export const canonical = (path: string, realpath: Realpath = realpathSync): string => {
  const tail: string[] = [];
  let head = resolve(path);
  for (;;) {
    try {
      return join(realpath(head), ...tail);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === undefined || !UNRESOLVABLE.has(code)) throw error;
    }
    const parent = dirname(head);
    if (parent === head) return join(head, ...tail);
    tail.unshift(basename(head));
    head = parent;
  }
};

/** True when `path` is `root` or inside it, after both are resolved as far as they can be. */
export const isWithin = (path: string, root: string, realpath: Realpath = realpathSync): boolean => {
  const candidate = canonical(path, realpath);
  const base = canonical(root, realpath);
  return candidate === base || candidate.startsWith(`${base}${sep}`);
};

/** True when `path` is, or is inside, the operator's live `~/.agent-control-plane`. */
export const resolvesToLiveState = (path: string, realpath: Realpath = realpathSync): boolean =>
  isWithin(path, LIVE_STATE_ROOT, realpath);
