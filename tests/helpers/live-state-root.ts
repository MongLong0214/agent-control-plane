import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

/**
 * #1093 — whether a path leads into the operator's live state, answered without reading that state.
 *
 * Apart from `isolated-home.ts` so the answer can be tested on its own: that file moves HOME and
 * registers hooks the moment it loads.
 */

/** The operator's live state root, from the passwd entry — HOME is exactly what a test run moves. */
export const LIVE_STATE_ROOT = join(userInfo().homedir, ".agent-control-plane");

export type Realpath = (path: string) => string;

/** How a single path component is inspected: neither call reads what a link points at. */
export type Links = {
  lstat: (path: string) => { isSymbolicLink: () => boolean };
  readlink: (path: string) => string;
};

const NODE_LINKS: Links = {
  lstat: (path) => lstatSync(path),
  readlink: (path) => readlinkSync(path),
};

/**
 * Errors that mean "this cannot be resolved from here": it is absent (ENOENT, ENOTDIR) or
 * unreadable (EPERM, EACCES). The unreadable case is the live root itself on a host whose sandbox
 * protects it — resolving it there fails with EPERM, and a guard that had to read the state it keeps
 * tests out of stopped every test file before its first assertion (#1093, review R2). Any other
 * error is not an answer, and is thrown.
 */
const UNRESOLVABLE: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR", "EPERM", "EACCES"]);
const ABSENT: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

/** The links one resolution may follow before it is treated as a loop. */
const MAX_LINKS = 40;

const unresolvable = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === undefined || !UNRESOLVABLE.has(code)) throw error;
  return code;
};

/** A path's best spelling, and whether nothing on the way to it was left unknown. */
type Resolution = { path: string; established: boolean };

/**
 * `path` resolved one component at a time where resolving it whole fails.
 *
 * A component that resolves is taken as resolved. One that does not is inspected with lstat: if it
 * is a directory, its spelling under an already-resolved parent is its identity; if it is a link,
 * its target is read with readlink and resolution carries on through it, so an alias of a protected
 * directory is still that directory (review r2, R3). Round 2 dropped the link and kept its lexical
 * spelling here, and an alias straight to the live root read as somewhere else.
 *
 * An absent component ends the walk with the rest appended as written: nothing below it exists to
 * lead elsewhere. A component that cannot even be inspected, or a link whose target cannot be read,
 * also ends it — with `established: false`, because whatever it is could lead anywhere.
 */
const resolution = (path: string, realpath: Realpath, links: Links): Resolution => {
  const absolute = resolve(path);
  try {
    return { path: realpath(absolute), established: true };
  } catch (error) {
    unresolvable(error);
  }
  const pending = absolute.split(sep).filter(Boolean);
  let current = parse(absolute).root;
  let followed = 0;
  for (let name = pending.shift(); name !== undefined; name = pending.shift()) {
    if (name === ".") continue;
    if (name === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, name);
    try {
      current = realpath(next);
      continue;
    } catch (error) {
      unresolvable(error);
    }
    let link: boolean;
    try {
      link = links.lstat(next).isSymbolicLink();
    } catch (error) {
      return { path: join(next, ...pending), established: ABSENT.has(unresolvable(error)) };
    }
    if (!link) {
      current = next;
      continue;
    }
    followed += 1;
    if (followed > MAX_LINKS) {
      throw Object.assign(new Error(`ELOOP: too many symbolic links, resolving '${absolute}'`), { code: "ELOOP" });
    }
    let target: string;
    try {
      target = links.readlink(next);
    } catch (error) {
      unresolvable(error);
      return { path: join(next, ...pending), established: false };
    }
    if (isAbsolute(target)) current = parse(target).root;
    pending.unshift(...target.split(sep).filter(Boolean));
  }
  return { path: current, established: true };
};

/** `path`'s best spelling: resolved as far as anything on the way can be resolved or inspected. */
export const canonical = (path: string, realpath: Realpath = realpathSync, links: Links = NODE_LINKS): string =>
  resolution(path, realpath, links).path;

/**
 * True when `path` is `root` or inside it. A candidate whose identity could not be established is
 * treated as inside: this answers "may a test allocate here?", and the answer for an unknown is no.
 * The root has no such alternative, and is compared by its best spelling.
 */
export const isWithin = (
  path: string,
  root: string,
  realpath: Realpath = realpathSync,
  links: Links = NODE_LINKS,
): boolean => {
  const candidate = resolution(path, realpath, links);
  if (!candidate.established) return true;
  const base = canonical(root, realpath, links);
  return candidate.path === base || candidate.path.startsWith(`${base}${sep}`);
};

/** True when `path` is, or is inside, the operator's live `~/.agent-control-plane`. */
export const resolvesToLiveState = (
  path: string,
  realpath: Realpath = realpathSync,
  links: Links = NODE_LINKS,
): boolean => isWithin(path, LIVE_STATE_ROOT, realpath, links);
