import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";

/**
 * A one-shot ACP instance that exists to produce acceptance evidence and then be gone.
 *
 * #655 needs an observed Telegram round trip. The obvious way to get one — rebind the production
 * CEO and send a message — was refused, and correctly: an actor is the lifetime owner of a
 * transcript, so a second actor over the same root permanently splits turn partitioning, receipt
 * harvest and reconstitution. Revocation does not fence a running child, so "only one is ACTIVE"
 * is not the property that makes it safe.
 *
 * What is allowed instead is a realm that shares nothing with production: its own state
 * directory, database, sockets, lock and runtime root, its own disposable actor, and a probe
 * target that is not the canonical root. The evidence it can produce is bounded to match — an
 * isolated instance answered and remembered, which is not a statement about canonical safety,
 * actor reconstitution, duplicate freedom, or activation.
 *
 * **Every safety condition here is a refusal, not a note.** The failure this module is written
 * against is a procedure that lists its own preconditions in prose and then runs anyway, so each
 * condition below is either checked and denied, or absent and named as absent.
 */

/** Where production lives. Read to be avoided, never to be opened for writing. */
export const productionRoot = (home = homedir()): string => join(home, ".agent-control-plane");

export interface RealmPaths {
  /** Everything the disposable instance creates lives under here, and nothing else does. */
  readonly stateDir: string;
  readonly databasePath: string;
  readonly runtimeRoot: string;
  readonly socketDir: string;
  readonly lockPath: string;
}

export interface RealmRequest {
  readonly paths: RealmPaths;
  /** The Hermes root the probe addresses. Must not be the canonical one. */
  readonly probeTargetRoot: string;
  /** The canonical root this run must stay away from, supplied rather than discovered, so a
   *  misconfigured lookup cannot silently make them equal. */
  readonly canonicalTargetRoot: string;
  readonly home?: string;
}

/**
 * A census of production, taken read-only, that a later census has to still match.
 *
 * Two of them and a comparison is the whole mechanism: the run is permitted to change nothing
 * about production, so the check is not "did we avoid the write paths" but "does production look
 * the same afterwards". The first phrasing trusts the code; the second observes the result.
 *
 * **Not bit-for-bit, and it used to say that it was.** What is compared is a set of ids plus each
 * database file's presence, size and mtime. A writer that rewrote bytes in place at equal length
 * and restored the timestamps would pass — nothing benign does that, and nothing here forbids it.
 * The word was doing work the code does not do, which is the defect this whole module is written
 * against, present in its own header.
 */
export interface DatabaseFile {
  /** "", "-wal", "-shm" or "-journal". */
  readonly suffix: string;
  readonly present: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface ProductionCensus {
  readonly actorIds: readonly string[];
  readonly bindingGenerations: readonly string[];
  readonly assignmentIds: readonly string[];
  /**
   * Every file SQLite may write for this database, not just the one named after it.
   *
   * The version this replaces carried a single mtime on `state.sqlite` and called it a catch-all.
   * It is not one. Under WAL — which is the mode a running deployment uses — a committed write
   * goes to the `-wal` sidecar and the main file's size and mtime do not move at all. Measured:
   * two hundred inserts left `state.sqlite` byte-identical and grew `-wal` past 800KB. A census
   * that watched only the main file would have reported an untouched production database.
   *
   * Absence is part of the state. A `-wal` that disappears between the two censuses means a
   * checkpoint ran, which is a write to the main file by another name.
   */
  readonly databaseFamily: readonly DatabaseFile[];
}

/** The suffixes SQLite may create beside a database file. */
export const DATABASE_FAMILY_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

/**
 * Reads the database family for a census, recording absence as a value rather than skipping it.
 *
 * Skipping an absent sidecar would make "the -wal was checkpointed away" indistinguishable from
 * "there never was one", and the first of those is a write.
 */
export const censusDatabaseFamily = (databasePath: string): Decision<readonly DatabaseFile[]> => {
  const files: DatabaseFile[] = [];
  for (const suffix of DATABASE_FAMILY_SUFFIXES) {
    try {
      const stat = statSync(`${databasePath}${suffix}`);
      files.push({ suffix, present: true, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === "ENOENT") {
        files.push({ suffix, present: false, size: 0, mtimeMs: 0 });
        continue;
      }
      // A failure to look is not an observation that there is nothing there. The version this
      // replaces recorded every error as absence, so making the parent directory unreadable
      // turned a populated database family into four "not present" rows — and two such censuses
      // compared equal, reporting an unchanged production database that had not been read at all.
      return deny(
        ReasonCode.ACCEPTANCE_CENSUS_UNOBSERVABLE,
        "the production database family could not be read, which is not the same as its being absent",
        { suffix, code },
      );
    }
  }
  return allow(ReasonCode.OK, files);
};

/** Anything that says this run can no longer describe what happened. */
export type ProbeSignal =
  | "REPLY_OBSERVED"
  | "TIMEOUT"
  | "SESSION_STORAGE_BUSY"
  | "SOCKET_CLOSED"
  | "TELEGRAM_SEND_AMBIGUOUS"
  | "CHILD_IDENTITY_DRIFT";

/**
 * What a run may do next.
 *
 * `INCONCLUSIVE` is terminal on purpose and has no retry beside it. Every signal that produces it
 * is a state where "did the side effect happen" is unanswerable, and the one thing that must not
 * follow an unanswerable question is another message.
 */
export type ProbeDisposition = "CONTINUE" | "INCONCLUSIVE";

export const classifyProbeSignal = (signal: ProbeSignal): ProbeDisposition =>
  signal === "REPLY_OBSERVED" ? "CONTINUE" : "INCONCLUSIVE";

/**
 * A process this run started, identified by more than its number.
 *
 * A pid alone is not an identity: pids are reused, and a cleanup that kills by pid can kill
 * whatever inherited it. The start time pins which process wore that number, which is what makes
 * "terminate only what this run owns" checkable rather than hopeful.
 */
export interface OwnedProcess {
  readonly pid: number;
  readonly startedAtMs: number;
}

/** A file's identity: what it *is*, rather than a string that reaches it. `null` if it is absent. */
const identityOf = (path: string): string | null => {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
};

/**
 * Containment, on paths both sides of which have already been resolved.
 *
 * It does not resolve anything itself, on purpose: a caller that passes one resolved path and one
 * declared path gets a wrong answer on any host where a temporary directory is a symlink — which
 * is every macOS host, where `/var` links to `/private/var`.
 *
 * And on those same macOS hosts `realpathSync` preserves case rather than normalising it, while
 * the volume does not distinguish it. So two spellings of one directory resolve to two different
 * strings, and a comparison made of strings says they are different places. Measured:
 *
 * ```
 * realpath(FooBar) = FooBar     realpath(foobar) = foobar
 * string equal: false           same inode: true
 * ```
 *
 * A review reached production twice through that gap — a probe target spelled in lower case, and
 * a realm state directory spelled as a case variant of the production root. So the decision is
 * made on `(device, inode)` wherever the path exists: that is the identity, and the string is a
 * way to reach it. The lexical comparison remains for the part of a path that does not exist yet,
 * where there is nothing to stat and nothing but the string to go on.
 */
const within = (parent: string, child: string): boolean => {
  const parentIdentity = identityOf(parent);
  if (parentIdentity !== null) {
    // Walk the child upward. An ancestor that *is* the parent settles it whatever either was
    // spelled as; reaching the root without finding one settles the other way.
    for (let cursor = resolve(child); ; ) {
      const cursorIdentity = identityOf(cursor);
      if (cursorIdentity !== null && cursorIdentity === parentIdentity) return true;
      const up = dirname(cursor);
      if (up === cursor) break;
      cursor = up;
    }
    // The child may not exist yet, in which case the walk above compared nothing until it reached
    // an existing ancestor. Fall through to the lexical answer, which is what a not-yet-created
    // path has.
  }
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Whether two paths name the same place — by identity where they exist, lexically where they do not.
 *
 * Separate from `within` because the probe check used `===` on resolved strings while every other
 * check used containment, and that asymmetry was itself a finding: a probe target *inside* the
 * canonical root is still addressing the owner's conversation tree.
 */
const sameFile = (a: string, b: string): boolean => {
  const left = identityOf(a);
  return left !== null ? left === identityOf(b) : resolve(a) === resolve(b);
};

/**
 * Resolves as much of a path as exists, and keeps the rest.
 *
 * A realm's paths mostly do not exist yet, so `realpathSync` on the whole thing throws and the
 * obvious fallback is the lexical path. That fallback is a hole: if an existing *ancestor* is a
 * symlink into production and only the leaf is missing, the lexical path looks clean and the
 * write lands in production. Measured on the version this replaces — a `stateDir/escape` link
 * pointing at the production root, with `escape/new.sqlite` as the database, was allowed.
 *
 * So the nearest existing ancestor is resolved and the missing suffix is appended to it. What is
 * judged is where the path would actually write, which is the only thing that matters.
 */
/** Raised when a path cannot be resolved for a reason that is not "it does not exist yet". */
class UnresolvablePath extends Error {
  constructor(
    readonly path: string,
    readonly code: string,
  ) {
    super(`cannot resolve ${path}: ${code}`);
  }
}

const errorCodeOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "UNKNOWN";

const settled = (path: string): string => {
  const absolute = resolve(path);
  const missing: string[] = [];
  let probe = absolute;
  for (;;) {
    try {
      return join(realpathSync(probe), ...missing);
    } catch (error) {
      const code = errorCodeOf(error);
      // Only "it is not there yet" justifies walking up and keeping the suffix. Every other
      // failure means this path's identity is unknown — a symlink cycle, a directory that
      // cannot be read, a component that is not a directory — and an unknown identity must not
      // be reported as a clean one. Measured on the version this replaces: a self-referential
      // symlink (ELOOP) was allowed as a realm path.
      if (code !== "ENOENT") throw new UnresolvablePath(probe, code);
      const parent = dirname(probe);
      // Reached the filesystem root without finding anything that exists. Nothing can be
      // resolved, so the lexical path is all there is.
      if (parent === probe) return absolute;
      missing.unshift(basename(probe));
      probe = parent;
    }
  }
};

/**
 * Whether this realm is separate from production in every way that matters.
 *
 * Checked by resolved path rather than by declared path, because a symlink into production is
 * exactly the shape a careless scratch directory takes.
 */
export const planDisposableRealm = (request: RealmRequest): Decision<RealmPaths> => {
  try {
    return planResolvedRealm(request);
  } catch (error) {
    if (!(error instanceof UnresolvablePath)) throw error;
    // Refused rather than resolved a different way. Every fallback available here — the lexical
    // path, the parent, skipping the check — answers a question the filesystem declined to
    // answer, and this module's whole job is to not do that.
    return deny(
      ReasonCode.ACCEPTANCE_REALM_UNRESOLVABLE,
      "a realm path could not be resolved, so where it would write is unknown",
      { path: error.path, code: error.code },
    );
  }
};

const planResolvedRealm = (request: RealmRequest): Decision<RealmPaths> => {
  const production = settled(productionRoot(request.home));
  const named: readonly (readonly [string, string])[] = [
    ["stateDir", request.paths.stateDir],
    ["databasePath", request.paths.databasePath],
    ["runtimeRoot", request.paths.runtimeRoot],
    ["socketDir", request.paths.socketDir],
    ["lockPath", request.paths.lockPath],
  ];

  // The two roots whose comparison *is* the safety decision were the two the loop below never
  // checked, so a relative one was silently rebased on `process.cwd()` — the ambient working
  // directory deciding whether a probe is the owner's conversation.
  for (const [name, path] of [
    ["probeTargetRoot", request.probeTargetRoot],
    ["canonicalTargetRoot", request.canonicalTargetRoot],
  ] as const) {
    if (!isAbsolute(path)) {
      return deny(ReasonCode.INVALID_ARGUMENT, `${name} has to be an absolute path`, { name, path });
    }
  }

  for (const [name, path] of named) {
    if (!isAbsolute(path)) {
      return deny(ReasonCode.INVALID_ARGUMENT, `${name} has to be an absolute path`, { name, path });
    }
    // A hard link is a second name for one file, and no amount of resolving reveals it: the realm
    // path resolves to itself while the bytes are production's. Measured — a realm database
    // pre-created as a link to production's passed isolation, and writing through it changed
    // production. `nlink > 1` is what a second name looks like from here.
    //
    // Regular files only. A directory always has at least two links — itself and its own `.` —
    // and one more per child, so the same rule applied to `stateDir` refuses every realm there
    // could ever be. The first version of this check did exactly that, and every scenario it was
    // written for still "passed" because it refused them all for the wrong reason.
    // `settled` first, and deliberately: it is what turns an unresolvable path — a symlink cycle,
    // a directory that cannot be read — into this module's typed refusal. A bare `statSync` ahead
    // of it throws ELOOP or EACCES straight out of the planner, which is the same "unknown
    // identity reported as something else" the resolver exists to prevent. Two tests said so.
    const resolved = settled(path);
    const existing = statSync(resolved, { throwIfNoEntry: false });
    if (existing?.isFile() === true && existing.nlink > 1) {
      return deny(
        ReasonCode.ACCEPTANCE_REALM_NOT_ISOLATED,
        `${name} has more than one name on disk, so what it resolves to is not what it is`,
        { name, path },
      );
    }
    if (within(production, resolved)) {
      // The whole point of the realm. A path that resolves inside production is production,
      // whatever it is called.
      return deny(
        ReasonCode.ACCEPTANCE_REALM_NOT_ISOLATED,
        `${name} resolves inside the production root`,
        { name, path, production },
      );
    }
  }

  // The other direction, which the loop above cannot see. Every path being *inside* the state
  // directory is exactly what licenses removing that directory whole — so a state directory that
  // happens to contain production turns the completeness argument into a licence to delete it.
  // Measured on the version this replaces: `stateDir` set to the home directory was allowed, and
  // production sits inside the home directory.
  if (within(settled(request.paths.stateDir), production)) {
    return deny(
      ReasonCode.ACCEPTANCE_REALM_NOT_ISOLATED,
      "the production root is inside this realm's state directory, which cleanup is allowed to remove whole",
      { stateDir: request.paths.stateDir, production },
    );
  }

  for (const [name, path] of named.slice(1)) {
    if (!within(settled(request.paths.stateDir), settled(path))) {
      // Otherwise cleanup cannot be complete by construction: removing the state directory
      // would leave whatever was placed outside it, and nothing would say so.
      return deny(
        ReasonCode.ACCEPTANCE_REALM_NOT_ISOLATED,
        `${name} is outside the realm's own state directory, so cleanup could not account for it`,
        { name, path, stateDir: request.paths.stateDir },
      );
    }
  }

  if (
    sameFile(settled(request.probeTargetRoot), settled(request.canonicalTargetRoot)) ||
    within(settled(request.canonicalTargetRoot), settled(request.probeTargetRoot))
  ) {
    // The condition that separates this from the procedure that was refused. A probe against
    // the canonical root is a second writer to the owner's transcript no matter how isolated
    // the ACP side is.
    //
    // Containment, not equality. Every other check here asks "is it inside", and this one asked
    // "is it the same" — so a probe target one directory *under* the canonical root passed, while
    // still addressing the owner's conversation tree. The asymmetry was the defect.
    return deny(
      ReasonCode.ACCEPTANCE_PROBE_TARGET_IS_CANONICAL,
      "the probe target is the canonical root, which is the thing this realm exists not to touch",
      { probeTargetRoot: request.probeTargetRoot },
    );
  }

  return allow(ReasonCode.OK, request.paths);
};

/**
 * Whether production is the same set of facts it was before.
 *
 * Compares the census rather than trusting that the write paths were avoided. A run that
 * believed itself isolated and was not produces exactly the same log as one that was.
 */
export const assertProductionUnchanged = (
  before: ProductionCensus,
  after: ProductionCensus,
): Decision<void> => {
  const differences: string[] = [];

  /**
   * Sorted, then compared element by element.
   *
   * The version this replaces joined both sides with a delimiter and compared the strings, which
   * is not a set comparison: any element containing the delimiter can be split and reassembled
   * across a neighbour, so `["a", "b|c"]` and `["a|b", "c"]` are reported as equal. No delimiter
   * fixes it — an id is opaque, and the one byte assumed not to appear in it is the one that
   * eventually does.
   */
  const sameMultiset = (a: readonly string[], b: readonly string[]): boolean => {
    if (a.length !== b.length) return false;
    const left = [...a].sort();
    const right = [...b].sort();
    return left.every((value, index) => value === right[index]);
  };

  const sameFamily = (a: readonly DatabaseFile[], b: readonly DatabaseFile[]): boolean => {
    if (a.length !== b.length) return false;
    const key = (file: DatabaseFile) => `${file.suffix}:${file.present}:${file.size}:${file.mtimeMs}`;
    const left = a.map(key).sort();
    const right = b.map(key).sort();
    return left.every((value, index) => value === right[index]);
  };

  if (!sameMultiset(before.actorIds, after.actorIds)) differences.push("actorIds");
  if (!sameMultiset(before.bindingGenerations, after.bindingGenerations)) {
    differences.push("bindingGenerations");
  }
  if (!sameMultiset(before.assignmentIds, after.assignmentIds)) differences.push("assignmentIds");
  if (!sameFamily(before.databaseFamily, after.databaseFamily)) differences.push("databaseFamily");

  if (differences.length > 0) {
    return deny(
      ReasonCode.ACCEPTANCE_PRODUCTION_CHANGED,
      "production changed during an acceptance run that is not permitted to change it",
      { differences },
    );
  }
  return allow(ReasonCode.OK, undefined);
};

/**
 * Whether the realm left anything behind.
 *
 * Reported as the paths that still exist, not as a boolean. "Cleanup failed" sends someone
 * looking; "these four files remain" tells them where.
 */
export const verifyRealmResidue = (paths: RealmPaths): Decision<void> => {
  // `lstat`, not `exists`. `existsSync` follows the link and answers about the target, so a
  // leftover symlink whose target is gone — a real directory entry, still on disk — reported
  // clean. That is reachable: a socket directory declared outside the state directory but
  // resolving inside it passes planning, cleanup removes the state directory, and the entry
  // outside is left dangling and invisible. The mirror image of the hazard this file was written
  // around, from the other side.
  const present = (path: string): boolean => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  };
  const remaining = [paths.databasePath, paths.runtimeRoot, paths.socketDir, paths.lockPath].filter(
    (path) => present(path),
  );
  if (present(paths.stateDir)) {
    const entries = readdirSync(paths.stateDir).map((entry) => join(paths.stateDir, entry));
    remaining.push(paths.stateDir, ...entries);
  }
  if (remaining.length > 0) {
    return deny(ReasonCode.ACCEPTANCE_REALM_RESIDUE, "the disposable realm left files behind", {
      remaining: [...new Set(remaining)].sort(),
    });
  }
  return allow(ReasonCode.OK, undefined);
};

/**
 * Whether a process may be terminated by this run.
 *
 * The rule is ownership, and ownership is the pair. Matching a pid alone is how a cleanup kills
 * a process that merely inherited the number; matching a name is how it kills a peer that
 * happens to be the same program — which is the specific thing the shared Hermes instance must
 * survive.
 */
export const mayTerminate = (owned: readonly OwnedProcess[], candidate: OwnedProcess): boolean =>
  owned.some((one) => one.pid === candidate.pid && one.startedAtMs === candidate.startedAtMs);

/**
 * The strongest sentence a completed run is allowed to say.
 *
 * Written as a value rather than left to whoever writes the report, because the gap between what
 * was observed and what gets claimed is where an acceptance run stops being evidence.
 */
export const REALM_EVIDENCE_CLAIM =
  "an isolated disposable ACP instance admitted, routed, answered and remembered a two-message " +
  "probe. This says nothing about canonical safety, actor reconstitution, duplicate freedom, " +
  "the target fence and receipt, or activation.";

/** Whether the production database can be read without being opened for writing. */
export const productionIsReadable = (home = homedir()): boolean => {
  const database = join(productionRoot(home), "state.sqlite");
  try {
    return statSync(database).isFile();
  } catch {
    return false;
  }
};

/** For evidence: the realm's own paths, relative to its state directory. */
export const realmLayout = (paths: RealmPaths): readonly string[] =>
  [paths.databasePath, paths.runtimeRoot, paths.socketDir, paths.lockPath]
    .map((path) => relative(paths.stateDir, path).split(sep).join("/"))
    .sort();
