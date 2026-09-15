import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
// The real class, not a shape check. An ambiguous send is the one signal whose whole meaning is
// "the transport could not say", and deciding that from a duck-typed `failure.kind` would let any
// object claiming that field be read as the transport's own verdict.
import { TelegramDeliveryError } from "../ingress/telegram-polling.ts";

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
 * target that is not the canonical root. The synthetic evidence is bounded to match what runs:
 * production ingress admits and classifies, a driver-owned callback answers, and ingress records
 * an APPLIED reply. Actor handling, a target-authored transcript and CEO durability stay unproven,
 * along with canonical safety, actor reconstitution, duplicate freedom and activation.
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
  /**
   * Every entry directly under the production root, by name.
   *
   * The three id lists and the database family answer "did production's records change". They do
   * not answer "did something appear in production", and twice on this branch a probe reached
   * production by creating a *file* there — a path this census would have called unchanged and the
   * residue check never looks at, because it only looks inside the realm.
   *
   * Names rather than contents: this is the catch-all for something arriving, and reading every
   * file to hash it would make the census a load on the deployment it is supposed to observe
   * without touching. What a file's *contents* changing looks like is the database family's job.
   */
  readonly productionEntries: readonly string[];
}

/**
 * The names directly under the production root, for a census.
 *
 * Fails closed like the family read does: a root that cannot be listed is an unobserved production,
 * not an empty one.
 */
export const censusProductionEntries = (productionRoot: string): Decision<readonly string[]> => {
  try {
    return allow(ReasonCode.OK, readdirSync(productionRoot).sort());
  } catch (error) {
    const code = errorCodeOf(error);
    // Absent is a value: production not existing is a fact two censuses can agree on.
    if (code === "ENOENT") return allow(ReasonCode.OK, []);
    return deny(
      ReasonCode.ACCEPTANCE_CENSUS_UNOBSERVABLE,
      "the production root could not be listed, so what is in it is unknown",
      { productionRoot, code },
    );
  }
};

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
 * is a state where "did the side effect happen" is unanswerable.
 * An ambiguous send is terminal for that reply and stops the loop before another message.
 */
export type ProbeDisposition = "CONTINUE" | "INCONCLUSIVE";

export const classifyProbeSignal = (signal: ProbeSignal): ProbeDisposition =>
  signal === "REPLY_OBSERVED" ? "CONTINUE" : "INCONCLUSIVE";

/**
 * Which of condition 5's named failures a thrown error actually is.
 *
 * `classifyProbeSignal` was a total function over a set whose members nothing constructed:
 * `SESSION_STORAGE_BUSY` and `CHILD_IDENTITY_DRIFT` appeared in this file's type and nowhere else
 * in `src/`, and the driver's own `catch` collapsed every non-ambiguous error to `SOCKET_CLOSED`.
 * Five signals were tested and two could occur, so the tests measured that the mapping is right
 * rather than that the run notices.
 *
 * The disposition is `INCONCLUSIVE` either way, so this changes no control flow -- it changes what
 * the evidence artifact is able to say happened, which for this issue is the deliverable.
 *
 * `code` and not the message: SQLite's text is a runtime string, and a classifier keyed on it
 * would be measuring the wording of someone else's library.
 */
export const probeSignalForError = (error: unknown): ProbeSignal => {
  if (error instanceof TelegramDeliveryError && error.failure.kind === "UNKNOWN") {
    return "TELEGRAM_SEND_AMBIGUOUS";
  }
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) return "SESSION_STORAGE_BUSY";
  return "SOCKET_CLOSED";
};

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
      // ENOENT does not mean "there is nothing here". A symlink pointing at a file that does not
      // exist yet is a directory entry that exists and redirects every write through it, and
      // `realpathSync` reports ENOENT for exactly that. The version this replaces walked past it
      // and judged where the link *sits* rather than where it *points*.
      //
      // Measured: a realm database pre-created as a symlink to a not-yet-existing file inside
      // production planned as ALLOWED, and writing to the realm database created that file inside
      // production with the realm's bytes in it. Nothing afterwards saw it — a new file under
      // production is not an id the census watches, and the residue check never looks there.
      //
      // So the entry is asked about directly. Where it is a link, its target is what this path
      // resolves to, and the walk continues from there rather than around it.
      const entry = lstatSync(probe, { throwIfNoEntry: false });
      if (entry?.isSymbolicLink() === true) {
        // Against where the link *physically sits*, not against the path used to reach it.
        //
        // A relative target is resolved by the kernel against the link's own directory. When the
        // link is reached *through* another symlink, the path used to get there and the directory
        // it lives in are different places — so `dirname(probe)` names a directory the link is not
        // in, and a relative target lands somewhere it never points.
        //
        // Measured on the version this replaces: `realm/state/a` linked to `production/sub`, and
        // `production/sub/b` a relative link to `../escape`. `settled(realm/state/a/b)` answered
        // `realm/state/escape`; the write went to `production/escape`. The plan said ALLOWED and
        // the realm's bytes landed in production — the same end-to-end escape the previous round
        // found, reintroduced by the fix for it.
        //
        // `dirname(probe)` exists here, because `probe` is an entry inside it, so resolving it
        // cannot fail with ENOENT.
        const target = resolve(realpathSync(dirname(probe)), readlinkSync(probe));
        return join(settled(target), ...missing);
      }
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
 * Takes the whole census, so a caller cannot take part of one.
 *
 * `ProductionCensus` has four fields and every one of them is a different way production can
 * change. Assembling it by hand is four opportunities to leave one out — and a census missing a
 * field is not a smaller census, it is a comparison that reports "unchanged" about something it
 * never looked at. The field added most recently exists precisely because two escapes were
 * invisible to the three that came before it.
 *
 * Nothing in this repository builds one yet: this is the safety half, and the driver that will use
 * it is a later change. That is exactly why the constructor is here now rather than left for that
 * change to write — a caller assembling the object literal is how the next field gets forgotten.
 */
export const censusProduction = (
  productionRoot: string,
  records: Pick<ProductionCensus, "actorIds" | "bindingGenerations" | "assignmentIds">,
): Decision<ProductionCensus> => {
  const entries = censusProductionEntries(productionRoot);
  if (!entries.allowed) return entries;
  const family = censusDatabaseFamily(join(productionRoot, "state.sqlite"));
  if (!family.allowed) return family;
  return allow(ReasonCode.OK, {
    ...records,
    productionEntries: entries.value,
    databaseFamily: family.value,
  });
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

/**
 * Whether the allocator above a realm is separate from the host's live ACP state.
 *
 * The realm planner checks every path the realm will write, but the allocator matters too: it is
 * the directory a janitor is allowed to create children in and the authority from which a caller
 * could otherwise substitute a live tree. Check containment in both directions so neither an
 * allocator inside production nor an allocator broad enough to contain production can be called
 * disposable. Both paths are settled before comparison; an inherited spelling is not evidence
 * about where either path actually lands.
 */
export const assertDisposableWorkspaceRoot = (
  home: string,
  workspaceRoot: string,
): Decision<void> => {
  if (!isAbsolute(home) || !isAbsolute(workspaceRoot)) {
    return deny(
      ReasonCode.INVALID_ARGUMENT,
      "the account home and disposable workspace root have to be absolute paths",
      { home, workspaceRoot },
    );
  }
  try {
    const production = settled(productionRoot(home));
    const workspace = settled(workspaceRoot);
    if (within(production, workspace) || within(workspace, production)) {
      return deny(
        ReasonCode.ACCEPTANCE_REALM_NOT_ISOLATED,
        "the disposable workspace allocator shares a path with live ACP production state",
        { production, workspace },
      );
    }
    return allow(ReasonCode.OK, undefined);
  } catch (error) {
    if (!(error instanceof UnresolvablePath)) throw error;
    return deny(
      ReasonCode.ACCEPTANCE_REALM_UNRESOLVABLE,
      "the disposable workspace allocator could not be resolved, so its isolation is unknown",
      { path: error.path, code: error.code },
    );
  }
};

const planResolvedRealm = (request: RealmRequest): Decision<RealmPaths> => {
  const production = settled(productionRoot(request.home));
  // The sidecars are where a WAL database's writes land — this file says so itself, in the census
  // that reads them. Checking `databasePath` alone left `state.sqlite-wal` free to be pre-created
  // as a hard link or a symlink to production's, and SQLite opens it by name the moment it opens
  // the database beside it. Measured: both spellings planned as ALLOWED.
  const family = DATABASE_FAMILY_SUFFIXES.filter((suffix) => suffix !== "").map(
    (suffix) => [`databasePath${suffix}`, `${request.paths.databasePath}${suffix}`] as const,
  );

  // Derived from the object rather than listed, so a path added to `RealmPaths` is checked by
  // existing. A hand-written list here would be one more place that says "every path" and means
  // "the five someone remembered" — the shape this module has already been corrected for twice,
  // in the census that could not see a trigger form and in the guard that named part of a key.
  const named: readonly (readonly [string, string])[] = [
    ...Object.entries(request.paths).map(([name, path]) => [name, path] as const),
    ...family,
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

  // By name, not by position. `slice(1)` meant "everything except the state directory" only while
  // the state directory happened to be written first, and the list it indexes into is derived from
  // an object now — where key order is a property of how the interface was typed rather than of
  // anything this function controls.
  for (const [name, path] of named.filter(([field]) => field !== "stateDir")) {
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

  // The two roots are checked against the realm's own geography as well, which the loop above
  // cannot see because they are not realm paths. A probe root under production means the probe's
  // Hermes instance builds its root and its transcripts inside production state — a new directory
  // there is not an id the census watches and not a path the residue check looks at, so it would
  // be permanent and unreported. And a canonical root inside the state directory puts the owner's
  // conversation inside the directory cleanup is licensed to remove whole, which is the exact
  // hazard this file states for production and had not applied to the other thing it protects.
  if (within(production, settled(request.probeTargetRoot))) {
    return deny(
      ReasonCode.ACCEPTANCE_REALM_NOT_ISOLATED,
      "the probe target is inside the production root, so what it writes would land in production",
      { probeTargetRoot: request.probeTargetRoot, production },
    );
  }
  if (within(settled(request.paths.stateDir), settled(request.canonicalTargetRoot))) {
    return deny(
      ReasonCode.ACCEPTANCE_REALM_NOT_ISOLATED,
      "the canonical root is inside this realm's state directory, which cleanup is allowed to remove whole",
      { canonicalTargetRoot: request.canonicalTargetRoot, stateDir: request.paths.stateDir },
    );
  }

  if (within(settled(request.canonicalTargetRoot), settled(request.probeTargetRoot))) {
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
  if (!sameMultiset(before.productionEntries, after.productionEntries)) {
    differences.push("productionEntries");
  }

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
  "A disposable ACP instance in an exclusively created, driver-established private workspace " +
  "outside live ACP production state admitted and DIRECT-classified two " +
  "synthetic Telegram updates through the production poll-and-router entry, invoked a " +
  "driver-owned direct callback, sent both callback replies through an injected transport, and " +
  "persisted matching APPLIED ingress reply records. The bound actor, production CEO path, " +
  "target-authored transcript, CEO-side durable commit, live Telegram, canonical safety, actor " +
  "reconstitution, duplicate freedom, the target fence and receipt, and activation were not " +
  "exercised.";

/**
 * Condition 3 of #655's safety list: the probe child's tool surface, measured rather than assumed.
 *
 * The condition is phrased as a precondition on *starting* — "if mutating and external tools are
 * not **measured** as off, the run does not start" — and the number behind it is that a trivial
 * prompt once produced 65 tool calls. So the shape that matters is not "are the dangerous tools
 * off" but "did anyone look": a run that never took the census and a run whose census came back
 * clean are the same thing to every check that only reads a boolean.
 *
 * `measuredAt === null` is therefore a refusal and not a pass, which is the whole point of taking
 * a census object rather than a flag. The same applies per tool: a tool this census does not
 * mention is `undefined`, and `undefined` is not `false`.
 */
export interface ProbeToolCensus {
  /** When the census was taken against the probe child's own configuration. `null` means never. */
  readonly measuredAt: string | null;
  /** What the census was taken against, so a reader can tell which child it describes. */
  readonly targetRoot: string;
  /** Every tool the census could name, with whether the child may call it. */
  readonly tools: Readonly<Record<string, boolean>>;
}

/**
 * The tools whose side effects leave the realm. A probe that can call one of these can change the
 * world outside the disposable workspace, which is the thing conditions 1, 2 and 7 all exist to
 * prevent from a different direction — so this list is deliberately about *reach*, not about risk
 * in the abstract.
 *
 * Named here rather than derived from the child's config: a list read out of the thing being
 * judged is not an allowlist, it is a restatement.
 */
export const PROBE_FORBIDDEN_TOOLS = [
  "bash",
  "shell",
  "write",
  "edit",
  "apply_patch",
  "web_fetch",
  "web_search",
  "browser",
  "mcp",
] as const;

/**
 * Takes the census `assertProbeToolsMeasuredOff` refuses without, by reading the settings file the
 * probe child will actually start under.
 *
 * The forbidden list stays where it is. This answers a different question — *does this child's own
 * configuration let it call that tool* — so the list is ours and the answer is the child's, which
 * is what keeps this from being the restatement the list's own comment warns about.
 *
 * Three rules, and the first is the one that matters:
 *
 * 1. `permissions.defaultMode` decides whether the other two mean anything. Claude Code's
 *    `bypassPermissions` and `acceptEdits` grant without consulting the lists, so under either of
 *    them a `deny` entry proves nothing and this census records **no tool at all**. An empty census
 *    is refused by the gate as unmeasured, which is the honest outcome: the file was read and it
 *    does not establish that anything is off.
 * 2. Under `default` or `plan`, a tool named in `deny` is off and a tool named in `allow` is on.
 * 3. A tool in neither list is left out of the census entirely rather than guessed at. The gate
 *    reads an absent key as unmeasured and refuses, so silence costs a refusal instead of buying
 *    a pass.
 *
 * Entries are `Tool` or `Tool(argument)`; only the head is matched, case-insensitively, because
 * this repository's list is lowercase and Claude Code's entries are capitalised. An entry that
 * narrows a tool to particular arguments (`Bash(git status)`) still counts as that tool being
 * reachable — condition 3 is about reach, and a narrowed `Bash` still leaves the realm.
 */
export const takeProbeToolCensus = (
  settingsPath: string,
  now: string,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Decision<ProbeToolCensus> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(settingsPath));
  } catch (error) {
    // Unreadable and absent are the same answer to the only question asked here, and it is not
    // "off": a census that could not be taken must not be returned as one that found nothing
    // enabled. `measuredAt: null` is what the gate refuses on.
    return allow(ReasonCode.OK, {
      measuredAt: null,
      targetRoot: dirname(settingsPath),
      tools: {},
      ...(error instanceof Error ? {} : {}),
    });
  }
  const permissions = (parsed as { permissions?: unknown }).permissions;
  const section = (name: string): readonly string[] => {
    const value = (permissions as Record<string, unknown> | undefined)?.[name];
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  };
  const mode = typeof (permissions as { defaultMode?: unknown } | undefined)?.defaultMode === "string"
    ? ((permissions as { defaultMode: string }).defaultMode)
    : "default";

  // Read, and deliberately answering nothing. Naming the two modes rather than allow-listing the
  // other two: a mode this repository has not met is unknown, and unknown must not read as safe.
  if (mode !== "default" && mode !== "plan") {
    return allow(ReasonCode.OK, { measuredAt: now, targetRoot: dirname(settingsPath), tools: {} });
  }

  const head = (entry: string): string => (entry.split("(")[0] ?? "").trim().toLowerCase();
  const denied = new Set(section("deny").map(head));
  const allowed = new Set(section("allow").map(head));
  const tools: Record<string, boolean> = {};
  for (const tool of PROBE_FORBIDDEN_TOOLS) {
    if (denied.has(tool)) tools[tool] = false;
    else if (allowed.has(tool)) tools[tool] = true;
  }
  return allow(ReasonCode.OK, { measuredAt: now, targetRoot: dirname(settingsPath), tools });
};

/**
 * Refuses unless the census exists and every forbidden tool is measured off.
 *
 * Three distinct refusals rather than one, because the operator's next action differs: an absent
 * census means go and take one, an unmeasured tool means the census is incomplete for this list,
 * and an enabled tool means the child's configuration has to change.
 */
export const assertProbeToolsMeasuredOff = (census: ProbeToolCensus): Decision<ProbeToolCensus> => {
  if (census.measuredAt === null) {
    return deny(
      ReasonCode.ACCEPTANCE_PROBE_INCONCLUSIVE,
      "the probe child's tool surface was never measured, so the run does not start",
      { targetRoot: census.targetRoot },
    );
  }
  const unmeasured = PROBE_FORBIDDEN_TOOLS.filter((tool) => census.tools[tool] === undefined);
  if (unmeasured.length > 0) {
    return deny(
      ReasonCode.ACCEPTANCE_PROBE_INCONCLUSIVE,
      "the tool census does not name every forbidden tool, so it cannot say they are off",
      { targetRoot: census.targetRoot, unmeasured },
    );
  }
  const enabled = PROBE_FORBIDDEN_TOOLS.filter((tool) => census.tools[tool] === true);
  if (enabled.length > 0) {
    return deny(
      ReasonCode.ACCEPTANCE_PROBE_INCONCLUSIVE,
      "the probe child may call tools whose side effects leave the realm",
      { targetRoot: census.targetRoot, enabled },
    );
  }
  return allow(ReasonCode.OK, census);
};

/**
 * Condition 6 of #655's safety list: contention on the shared Hermes `state.db` is the result.
 *
 * The condition has two halves and they pull in opposite directions. `hermes acp` is **not**
 * killed — the run has no authority over a process it did not start, which `mayTerminate` already
 * enforces — and yet the run must not proceed through contention either, because a probe sharing
 * that database with the live gateway is no longer isolated in the sense conditions 1 and 7 mean.
 *
 * So contention resolves to a stop whose *report is the observation*, not to a retry and not to a
 * failure of the probe. The issue says it outright: "that observation is itself the result and the
 * run stops."
 *
 * `observed === null` is a refusal for the same reason the tool census is: not having looked and
 * having looked and found nothing are different facts, and only one of them licenses a start.
 */
export interface HermesSharedStateObservation {
  /** When the shared database was inspected. `null` means it was not. */
  readonly observedAt: string | null;
  /** The shared database the live gateway and any probe would both hold. */
  readonly databasePath: string;
  /**
   * Whether a second holder was observed — a lock, a `-wal` a foreign writer left, a busy answer.
   * `null` means the inspection could not decide, which is not the same as "no".
   */
  readonly contended: boolean | null;
  /** What the inspection saw, carried so the report can be the observation. */
  readonly detail: string;
}

export type HermesContentionDisposition = "PROCEED" | "STOP_AND_REPORT" | "INCONCLUSIVE";

/**
 * Maps the observation to what the run does about it. Deliberately total and deliberately without
 * a retry: a retried contention check is a loop that ends when the answer happens to be the
 * convenient one, and this condition exists to stop rather than to wait.
 */
export const classifyHermesContention = (
  observation: HermesSharedStateObservation,
): HermesContentionDisposition => {
  if (observation.observedAt === null) return "INCONCLUSIVE";
  if (observation.contended === null) return "INCONCLUSIVE";
  return observation.contended ? "STOP_AND_REPORT" : "PROCEED";
};

/**
 * The sentence a contention stop is allowed to claim, built from the observation it rests on.
 *
 * A value rather than prose for the same reason `REALM_EVIDENCE_CLAIM` is: the gap between what
 * was seen and what gets claimed is where an acceptance run stops being evidence. This one says
 * the run stopped *and why*, and says nothing about the probe's subject.
 */
export const hermesContentionReport = (observation: HermesSharedStateObservation): string =>
  `The run stopped before the probe because the shared Hermes database at ${observation.databasePath} ` +
  `was observed contended at ${observation.observedAt ?? "an unrecorded time"}: ${observation.detail}. ` +
  "No process this run did not start was signalled, and nothing about the probe's subject was exercised.";

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
