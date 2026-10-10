import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { type Decision, deny, fail, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { ensurePrivateDirectory } from "../db/state-preflight.ts";
import {
  addWorktree,
  type GuardedGitEffect,
  git,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
  revParse,
  treeOf,
  tryRevParse,
} from "../git/git.ts";
import { WorktreeAction, WriteOperation } from "../guard/managed-write-guard.ts";
import { canonical, isWithin } from "../guard/workspace-probe.ts";

export interface Worktree {
  worktreeId: string;
  path: string;
  repositoryPath: string;
  head: string;
}

export interface CreateOptions {
  /**
   * Materialise a checkout with its own git metadata and objects instead of a linked worktree,
   * for a command that runs git in it (#246 C2v). See `createSelfContained`.
   */
  readonly selfContained?: boolean;
  /**
   * The tree digest (`git-tree:<sha>`) the candidate snapshot froze. A self-contained checkout must
   * hold exactly this tree; see `createSelfContained`. The linked flow re-reads the tree from the
   * source's own object database, which is the same database the snapshot read.
   */
  readonly frozenTree?: string;
}

const WORKTREE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Where self-contained checkouts are registered: beside them under the managed root, never inside
 * one. A checkout is candidate-writable while its command runs, so a record kept inside it could
 * be rewritten to borrow another repository's teardown; the sandbox cannot write here. The leading
 * dot keeps this name outside `WORKTREE_ID`, so no checkout can be created at, or registered as,
 * this path.
 */
const CHECKOUT_REGISTRY = ".verification-checkouts";
const REGISTRATION_SCHEMA = "agent-control-plane.verification-checkout.v1";
const REGISTRATION_SUFFIX = ".json";

interface CheckoutRegistration {
  readonly schema: typeof REGISTRATION_SCHEMA;
  readonly worktreeId: string;
  readonly path: string;
  readonly repositoryPath: string;
  readonly head: string;
}

/** Git that reads the new checkout's own configuration only, never the operator's. */
const OWN_CONFIG = { isolatedConfig: true } as const;

/** Evidence names at most this many status entries; the count says how many there were. */
const STATUS_EVIDENCE_ENTRIES = 20;

const lstatOrNull = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const statusEntries = (stdout: string): string[] => stdout.split("\n").filter((line) => line.length > 0);

/**
 * What every git that prepares or judges a linked verification worktree runs with (#1082 R1-01).
 *
 * `--no-replace-objects`: the worktree holds the objects the candidate commit actually names. A
 * replace ref changes what a local read returns and nothing else, so honouring it materialised a
 * replacement tree -- with a different gate script -- under the candidate's own SHA. The tree is
 * then compared with the one the source resolves the candidate to, which honours replacements as
 * the snapshot does, so a replaced candidate is refused rather than reproduced, as the
 * self-contained copy already refuses it.
 *
 * Every filter driver the repository's configuration declares, emptied. A `.gitattributes` the
 * candidate commits selects a driver by name, and checkout then runs that driver's smudge or
 * process program as the control-plane user, outside the sandbox -- measured, a smudge filter
 * wrote different gate bytes into a worktree that `git status` called clean, and an LFS-shaped
 * process filter ran the same way. An emptied driver is no driver: git writes the blob as stored,
 * and `required=false` keeps a declared-required driver from failing the checkout instead. So LFS
 * content is not fetched into a verification worktree; its pointer files are what a command sees.
 */
const preparationOptions = async (repositoryPath: string): Promise<string[]> => {
  const listed = await git(repositoryPath, ["config", "--name-only", "--get-regexp", "^filter\\."], { allowFailure: true });
  const drivers = new Set(
    listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((key) => key.startsWith("filter.") && key.lastIndexOf(".") > "filter.".length)
      .map((key) => key.slice("filter.".length, key.lastIndexOf("."))),
  );
  return [
    "--no-replace-objects",
    ...[...drivers].flatMap((driver) => [
      "-c", `filter.${driver}.smudge=`,
      "-c", `filter.${driver}.clean=`,
      "-c", `filter.${driver}.process=`,
      "-c", `filter.${driver}.required=false`,
    ]),
  ];
};

/**
 * The source checkout as a self-contained copy would have to match it: its HEAD, and every
 * tracked change or untracked, non-ignored file `git status` reports there. `--untracked-files=all`
 * because a repository's `status.showUntrackedFiles=no` would otherwise hide exactly the file a copy
 * of the commit drops. This reads the source the way `isClean` and the snapshot freshness check do,
 * except that it does not start the source's `core.fsmonitor` hook: measured, `git status` runs a
 * repository-configured fsmonitor program, and this read must not execute the original's config.
 */
const sourceState = async (repositoryPath: string): Promise<{ head: string | null; status: string[] }> => {
  const head = await tryRevParse(repositoryPath, "HEAD");
  const status = await git(repositoryPath, ["-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=all"]);
  return { head, status: statusEntries(status.stdout) };
};

const isRegistration = (value: unknown): value is CheckoutRegistration => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record["schema"] === REGISTRATION_SCHEMA &&
    typeof record["worktreeId"] === "string" &&
    typeof record["path"] === "string" &&
    typeof record["repositoryPath"] === "string" &&
    typeof record["head"] === "string"
  );
};

/** One complete guard request per Git or local cleanup effect. */
export interface WorktreeAuthorization {
  readonly add?: GuardedGitEffect;
  readonly remove?: GuardedGitEffect;
  readonly prune?: GuardedGitEffect;
  readonly cleanup?: GuardedGitEffect;
}

const requireAllowed = <T>(decision: Decision<T>): T => {
  if (!decision.allowed) return fail(decision.reasonCode, decision.message, decision.evidence);
  return decision.value;
};

/**
 * Disposable worktrees for verification (PRD §17.4).
 *
 * A verification worktree is created at the exact candidate head and destroyed
 * afterwards, so a command can never observe or mutate the developer's checkout, and a
 * second run cannot share its working directory.
 */
export class WorktreeManager {
  private readonly rootPath: string;

  constructor(root: string) {
    // Verification executes candidate-controlled code below this root. A permissive or
    // symlinked root would let another local user plant/observe worktree contents before
    // Git's own isolation checks ever run.
    ensurePrivateDirectory(root);
    this.rootPath = canonical(root);
  }

  async create(
    repositoryPath: string,
    head: string,
    worktreeId: string,
    authorization: WorktreeAuthorization,
    options: CreateOptions = {},
  ): Promise<Worktree> {
    const path = this.managedPath(worktreeId);
    const known = await listWorktrees(repositoryPath);
    if (
      existsSync(path) ||
      known.some((entry) => canonical(entry.path) === path) ||
      lstatOrNull(this.registrationPath(worktreeId)) !== null
    ) {
      fail(ReasonCode.CONFLICT, "verification worktree id is already in use", {
        worktreeId,
        path,
        repositoryPath: canonical(repositoryPath),
      });
    }
    if (options.selfContained) {
      return this.createSelfContained(repositoryPath, head, worktreeId, path, authorization, options.frozenTree);
    }

    // Resolve the ref before materialising it. A worktree created for `HEAD` must still
    // be tied to this exact commit even if the source checkout moves while Git is making
    // the disposable tree.
    const expectedHead = await revParse(repositoryPath, head);
    const expectedTree = await treeOf(repositoryPath, expectedHead);
    const preparation = await preparationOptions(repositoryPath);
    try {
      // `worktree add` performs a checkout, which normally invokes a repository-local
      // post-checkout hook as the control-plane user. Candidate-controlled hooks therefore
      // must be disabled before Git has a chance to materialise any verification input.
      requireAllowed(await addWorktree(repositoryPath, path, expectedHead, authorization.add, { gitOptions: preparation }));

      const [materializedHead, materializedTree, status] = await Promise.all([
        revParse(path, "HEAD"),
        git(path, [...preparation, "rev-parse", "HEAD^{tree}"]).then((result) => result.stdout.trim()),
        // Include untracked files explicitly: a hook that adds a replacement executable
        // must not hide behind a repository's status.showUntrackedFiles preference. No
        // fsmonitor either: it is a program the repository's configuration names.
        git(path, [...preparation, "-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=all"]),
      ]);
      if (
        materializedHead !== expectedHead ||
        materializedTree !== expectedTree ||
        status.stdout.trim().length > 0
      ) {
        fail(ReasonCode.SNAPSHOT_STALE, "verification worktree differs from the frozen candidate", {
          repositoryPath: canonical(repositoryPath),
          worktreePath: path,
          expectedHead,
          materializedHead,
          expectedTree: `git-tree:${expectedTree}`,
          materializedTree: `git-tree:${materializedTree}`,
          status: status.stdout.trim(),
        });
      }
      return { worktreeId, path, repositoryPath, head: expectedHead };
    } catch (error) {
      // A failed post-add integrity check must not leave the potentially tampered tree
      // available for a later command. The path was just proven to be under our root.
      //
      // This is the one reader for which a refused listing must not propagate. It is inside the
      // catch of the integrity failure, so throwing here replaces the diagnosis the caller needs
      // with a secondary error -- and skipping the removal is worse still, because an unreadable
      // listing used to answer `[]` and `[]` skipped it, leaving exactly the tree these lines
      // exist to take away. So a listing that did not complete means *presence unknown*, and
      // unknown removes: `worktree remove` on a path git does not know is a refusal we absorb,
      // while a tree left behind is not.
      let after: Array<{ path: string; head: string }> | null = null;
      try {
        after = await listWorktrees(repositoryPath);
      } catch (listingError) {
        if (!isAcpError(listingError)) throw listingError;
        after = null;
      }
      if (after === null || after.some((entry) => canonical(entry.path) === path)) {
        requireAllowed(await removeWorktree(repositoryPath, path, authorization.remove));
      }
      if (existsSync(path)) {
        requireAllowed(await this.cleanup(path, authorization.cleanup));
      }
      requireAllowed(await pruneWorktrees(repositoryPath, authorization.prune));
      throw error;
    }
  }

  async destroy(repositoryPath: string, path: string, authorization: WorktreeAuthorization): Promise<void> {
    const managedPath = this.managedPathFromPath(path);
    // A self-contained checkout is registered beside it, not in the source's worktree list. Its
    // registration is what makes it deletable, exactly as git's listing is for a linked worktree.
    const registration = this.registrationAt(managedPath);
    if (registration !== null) {
      await this.destroySelfContained(repositoryPath, managedPath, registration, authorization);
      return;
    }
    const before = await listWorktrees(repositoryPath);
    if (!before.some((entry) => canonical(entry.path) === managedPath)) {
      fail(ReasonCode.NOT_FOUND, "refusing to delete an unregistered worktree path", {
        path: managedPath,
        repositoryPath: canonical(repositoryPath),
      });
    }
    requireAllowed(await removeWorktree(repositoryPath, managedPath, authorization.remove));
    const remaining = await listWorktrees(repositoryPath);
    if (remaining.some((entry) => canonical(entry.path) === managedPath)) {
      fail(ReasonCode.ISOLATION_LOST, "git did not remove the managed worktree", {
        path: managedPath,
        repositoryPath: canonical(repositoryPath),
      });
    }
    if (existsSync(managedPath)) {
      const stat = lstatSync(managedPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        fail(ReasonCode.ISOLATION_LOST, "managed worktree path changed before cleanup", {
          path: managedPath,
        });
      }
      requireAllowed(await this.cleanup(managedPath, authorization.cleanup));
    }
    requireAllowed(await pruneWorktrees(repositoryPath, authorization.prune));
  }

  async withWorktree<T>(
    repositoryPath: string,
    head: string,
    worktreeId: string,
    authorization: WorktreeAuthorization,
    fn: (worktree: Worktree) => Promise<T>,
  ): Promise<T> {
    const worktree = await this.create(repositoryPath, head, worktreeId, authorization);
    try {
      return await fn(worktree);
    } finally {
      await this.destroy(repositoryPath, worktree.path, authorization);
    }
  }

  /** The exact path a caller must bind into its GIT_WORKTREE request. */
  pathFor(worktreeId: string): string {
    return this.managedPath(worktreeId);
  }

  /**
   * Worktrees under the managed root that git still knows about. The doctor reports
   * these; it deliberately does not delete them (CP-S44 — detect, do not auto-remove).
   */
  async orphans(
    repositoryPath: string,
    liveIds: ReadonlySet<string>,
    isLive?: (worktreeId: string) => boolean | Promise<boolean>,
  ): Promise<string[]> {
    const known = await listWorktrees(repositoryPath);
    const linked = known
      .map((w) => canonical(w.path))
      .filter((path) => isWithin(this.rootPath, path) && path !== this.rootPath)
      .map((path) => path.slice(this.rootPath.length + 1));
    // Self-contained checkouts are invisible to git's listing; their registrations name them.
    const repository = canonical(repositoryPath);
    const selfContained = this.registrations()
      .filter((registration) => registration.repositoryPath === repository)
      .map((registration) => registration.worktreeId);
    const candidates = [...new Set([...linked, ...selfContained])]
      .filter((worktreeId) => !liveIds.has(worktreeId));
    if (!isLive) return candidates;
    const stillOrphaned: string[] = [];
    for (const worktreeId of candidates) {
      if (!(await isLive(worktreeId))) stillOrphaned.push(worktreeId);
    }
    return stillOrphaned;
  }

  /**
   * A verification checkout with its own git metadata and objects (#246 C2v).
   *
   * A linked worktree's `.git` is a file naming `<checkout>/.git/worktrees/<id>`, and the sandbox
   * denies the original checkout (§33.3), so a command that runs git in one exits 128. This is a
   * separate repository instead: `git init` with no template (so no hooks directory at all), then
   * the candidate commit alone, by SHA, fetched from the source over git's own transport. The
   * objects are therefore copied, never hard-linked or borrowed through `objects/info/alternates`;
   * no remote is configured, no tag or FETCH_HEAD is written, and every git that builds or judges
   * it reads only its own configuration (`isolatedConfig`). Nothing of the original's config,
   * hooks or credentials is copied into it or run in it, and neither is the operator's. The source
   * is only read: by `upload-pack`, the side of git's transport built to serve an untrusted
   * repository, and by `git status`, as the snapshot freshness check already reads it.
   *
   * Dirty and untracked state. The candidate is the commit at the source checkout's HEAD, and only
   * that commit is copied, so a tracked change (staged or not) or an untracked, non-ignored file in
   * the source is state the copy would drop. Preparation refuses it as SNAPSHOT_STALE instead of
   * handing CLEAN_TREE a clean copy of a checkout that is not clean. Ignored files are not
   * candidate state; that is the line `git status --porcelain` itself draws. The source is read
   * again after the copy: a moved HEAD or new dirt there is SNAPSHOT_STALE too, as is a copy that is
   * not exactly the candidate, not clean, or not self-contained. Nothing is ever cleaned to make a
   * checkout pass; a refused one is removed.
   */
  private async createSelfContained(
    repositoryPath: string,
    head: string,
    worktreeId: string,
    path: string,
    authorization: WorktreeAuthorization,
    frozenTree: string | undefined,
  ): Promise<Worktree> {
    const source = canonical(repositoryPath);
    const expectedHead = await revParse(repositoryPath, head);
    // The commit SHA does not bind the tree on its own. In the source, `<sha>^{tree}` honours
    // `refs/replace`, so a replaced commit resolves -- in the snapshot, in freshness and in a linked
    // worktree -- to the replacement's tree. The copy is fetched by SHA, and the transport ships
    // the original object, so the copy would hold the original tree under the same HEAD while both
    // sides report clean (#1072 review, RF-REVIEW-03). The copy is therefore bound to the tree the
    // snapshot froze, and the source must still resolve the candidate to that tree before and
    // after the copy. A replaced candidate is refused rather than reproduced: the copy keeps no
    // refs it did not need, and replace refs would be state copied out of the original.
    const sourceTree = `git-tree:${await treeOf(repositoryPath, expectedHead)}`;
    const expectedTree = frozenTree ?? sourceTree;
    // A SHA-256 source cannot be fetched into a SHA-1 repository, so the copy takes its format.
    const objectFormat = (await git(repositoryPath, ["rev-parse", "--show-object-format"])).stdout.trim();
    const prepared = await sourceState(repositoryPath);
    if (prepared.head !== expectedHead || prepared.status.length > 0 || sourceTree !== expectedTree) {
      fail(ReasonCode.SNAPSHOT_STALE, "the source checkout is not exactly the candidate, so a copy of the candidate would not be it", {
        repositoryPath: source,
        worktreePath: path,
        expectedHead,
        sourceHead: prepared.head,
        expectedTree,
        sourceTree,
        sourceStatus: prepared.status.slice(0, STATUS_EVIDENCE_ENTRIES),
        sourceStatusEntries: prepared.status.length,
      });
    }

    // What this call made, so a failure removes exactly that: a registration or directory another
    // creator holds is never this call's to delete.
    let registered = false;
    let madeDirectory = false;
    try {
      requireAllowed(await this.authorizeEffect(authorization.add, WorktreeAction.ADD, path, async () => {
        this.register({ schema: REGISTRATION_SCHEMA, worktreeId, path, repositoryPath: source, head: expectedHead });
        registered = true;
        mkdirSync(path);
        madeDirectory = true;
        await git(path, ["init", "--quiet", "--template=", `--object-format=${objectFormat}`], OWN_CONFIG);
        // A bare SHA with no destination ref stores no ref, so no tag is followed into the copy.
        await git(path, ["fetch", "--quiet", "--no-write-fetch-head", "--depth=1", source, expectedHead], OWN_CONFIG);
        await git(path, ["checkout", "--quiet", "--detach", expectedHead], OWN_CONFIG);
      }));

      const [materializedHead, materializedTree, status, commonDir] = await Promise.all([
        git(path, ["rev-parse", "--verify", "HEAD^{commit}"], OWN_CONFIG),
        git(path, ["rev-parse", "HEAD^{tree}"], OWN_CONFIG),
        git(path, ["status", "--porcelain", "--untracked-files=all"], OWN_CONFIG),
        git(path, ["rev-parse", "--git-common-dir"], OWN_CONFIG),
      ]).then((results) => results.map((result) => result.stdout.trim()));
      const copyStatus = statusEntries(status ?? "");
      // Self-contained means git takes this checkout's refs and objects from its own `.git`
      // directory. The common directory is the one fact that covers both ways out: a `.git` gitfile
      // moves it to wherever the file points, and a `commondir` file moves it to another repository.
      // Alternates are the third: a borrowed object store that neither of those shows.
      const ownGitDir = join(path, ".git");
      const selfContained =
        canonical(resolve(path, commonDir ?? "")) === ownGitDir &&
        lstatOrNull(join(ownGitDir, "objects", "info", "alternates")) === null;
      const after = await sourceState(repositoryPath);
      const sourceTreeAfter = `git-tree:${await treeOf(repositoryPath, expectedHead)}`;
      if (
        materializedHead !== expectedHead ||
        `git-tree:${materializedTree ?? ""}` !== expectedTree ||
        sourceTreeAfter !== expectedTree ||
        copyStatus.length > 0 ||
        !selfContained ||
        after.head !== expectedHead ||
        after.status.length > 0
      ) {
        fail(ReasonCode.SNAPSHOT_STALE, "verification checkout differs from the frozen candidate", {
          repositoryPath: source,
          worktreePath: path,
          expectedHead,
          materializedHead: materializedHead ?? null,
          expectedTree,
          materializedTree: `git-tree:${materializedTree ?? ""}`,
          sourceTree: sourceTreeAfter,
          status: copyStatus.slice(0, STATUS_EVIDENCE_ENTRIES),
          statusEntries: copyStatus.length,
          selfContained,
          sourceHead: after.head,
          sourceStatus: after.status.slice(0, STATUS_EVIDENCE_ENTRIES),
          sourceStatusEntries: after.status.length,
        });
      }
      return { worktreeId, path, repositoryPath, head: expectedHead };
    } catch (error) {
      if (registered) {
        requireAllowed(await this.disposeSelfContained(worktreeId, path, authorization.remove, madeDirectory));
      }
      throw error;
    }
  }

  private async destroySelfContained(
    repositoryPath: string,
    managedPath: string,
    registration: CheckoutRegistration,
    authorization: WorktreeAuthorization,
  ): Promise<void> {
    if (registration.repositoryPath !== canonical(repositoryPath)) {
      fail(ReasonCode.NOT_FOUND, "refusing to delete a verification checkout registered to another repository", {
        path: managedPath,
        repositoryPath: canonical(repositoryPath),
      });
    }
    requireAllowed(await this.disposeSelfContained(registration.worktreeId, managedPath, authorization.remove, true));
    if (lstatOrNull(managedPath) !== null || lstatOrNull(this.registrationPath(registration.worktreeId)) !== null) {
      fail(ReasonCode.ISOLATION_LOST, "the verification checkout or its registration survived its removal", {
        path: managedPath,
        repositoryPath: canonical(repositoryPath),
      });
    }
  }

  /**
   * One guarded REMOVE: the checkout, then its registration. The registration goes last, so a
   * teardown that stops part-way leaves the record the orphan sweep finds the remains by.
   */
  private async disposeSelfContained(
    worktreeId: string,
    path: string,
    authorization: GuardedGitEffect | undefined,
    removeDirectory: boolean,
  ): Promise<Decision<void>> {
    return this.authorizeEffect(authorization, WorktreeAction.REMOVE, path, () => {
      if (removeDirectory && lstatOrNull(path) !== null) {
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          fail(ReasonCode.ISOLATION_LOST, "managed worktree path changed before cleanup", { path });
        }
        rmSync(path, { recursive: true, force: false });
      }
      unlinkSync(this.registrationPath(worktreeId));
    });
  }

  /** The same guard binding `git.ts` applies to a worktree mutation, for an effect done here. */
  private async authorizeEffect(
    authorization: GuardedGitEffect | undefined,
    action: WorktreeAction,
    target: string,
    effect: () => void | Promise<void>,
  ): Promise<Decision<void>> {
    if (!authorization) {
      return deny(ReasonCode.WRITE_REQUIRES_MANAGED_RUN, "verification checkout effect requires guard authorization", {
        path: target,
      });
    }
    if (authorization.request.operation !== WriteOperation.GIT_WORKTREE) {
      return deny(ReasonCode.INVALID_ARGUMENT, "verification checkout effect requires a GIT_WORKTREE authorization", {
        operation: authorization.request.operation,
      });
    }
    if (authorization.request.worktreeAction !== action) {
      return deny(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH, "verification checkout action does not match the guard request", {
        expectedAction: action,
        authorizedAction: authorization.request.worktreeAction ?? null,
      });
    }
    if (!authorization.request.targetPath || canonical(authorization.request.targetPath) !== canonical(target)) {
      return deny(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH, "verification checkout target does not match the guard request", {
        expectedTarget: canonical(target),
        authorizedTarget: authorization.request.targetPath ?? null,
      });
    }
    return authorization.guard.authorize(authorization.request, async () => {
      await effect();
    });
  }

  private registrationPath(worktreeId: string): string {
    return join(this.rootPath, CHECKOUT_REGISTRY, `${worktreeId}${REGISTRATION_SUFFIX}`);
  }

  /**
   * Written to a private name and linked into place: `link` refuses a name that exists, so two
   * creators cannot both own one id, and a reader never sees a half-written record.
   */
  private register(registration: CheckoutRegistration): void {
    const directory = join(this.rootPath, CHECKOUT_REGISTRY);
    ensurePrivateDirectory(directory);
    const staged = join(directory, `.${registration.worktreeId}.${randomUUID()}.tmp`);
    writeFileSync(staged, `${JSON.stringify(registration)}\n`, { flag: "wx", mode: 0o600 });
    try {
      linkSync(staged, this.registrationPath(registration.worktreeId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      fail(ReasonCode.CONFLICT, "verification worktree id is already in use", {
        worktreeId: registration.worktreeId,
        path: registration.path,
      });
    } finally {
      unlinkSync(staged);
    }
  }

  /**
   * The registration for this id, or null when there is none. One that exists but cannot be read
   * is a refusal, not an absence: deciding "unregistered" from a record nothing could read is the
   * same mistake as reading an unreadable worktree listing as an empty one.
   */
  private readRegistration(worktreeId: string): CheckoutRegistration | null {
    const file = this.registrationPath(worktreeId);
    const stat = lstatOrNull(file);
    if (stat === null) return null;
    let parsed: unknown = null;
    if (stat.isFile()) {
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        parsed = null;
      }
    }
    if (!isRegistration(parsed) || parsed.worktreeId !== worktreeId || parsed.path !== join(this.rootPath, worktreeId)) {
      fail(ReasonCode.INTERNAL_ERROR, "a verification checkout registration is unreadable, so whether it is registered is unknown", {
        worktreeId,
        registration: file,
      });
    }
    return parsed as CheckoutRegistration;
  }

  /** The registration naming this managed path, if the path is one a checkout can have. */
  private registrationAt(managedPath: string): CheckoutRegistration | null {
    const worktreeId = managedPath.slice(this.rootPath.length + 1);
    return WORKTREE_ID.test(worktreeId) ? this.readRegistration(worktreeId) : null;
  }

  private registrations(): CheckoutRegistration[] {
    const directory = join(this.rootPath, CHECKOUT_REGISTRY);
    if (lstatOrNull(directory) === null) return [];
    ensurePrivateDirectory(directory);
    const found: CheckoutRegistration[] = [];
    for (const entry of readdirSync(directory).sort()) {
      // A staged record (`.<id>.<uuid>.tmp`) is not a registration until it is linked into place.
      if (!entry.endsWith(REGISTRATION_SUFFIX)) continue;
      const worktreeId = entry.slice(0, -REGISTRATION_SUFFIX.length);
      if (!WORKTREE_ID.test(worktreeId)) continue;
      const registration = this.readRegistration(worktreeId);
      if (registration !== null) found.push(registration);
    }
    return found;
  }

  private managedPath(worktreeId: string): string {
    if (!WORKTREE_ID.test(worktreeId)) {
      fail(ReasonCode.INVALID_ARGUMENT, "worktree id must be a single safe path component", {
        worktreeId,
      });
    }
    return this.managedPathFromPath(join(this.rootPath, worktreeId));
  }

  private managedPathFromPath(path: string): string {
    const resolved = canonical(path);
    if (!isWithin(this.rootPath, resolved) || resolved === this.rootPath) {
      fail(ReasonCode.INVALID_ARGUMENT, "worktree path escapes the managed root", {
        root: this.rootPath,
        path: resolved,
      });
    }
    return resolved;
  }

  /** Guarded local cleanup is a first-class effect, including when Git removed its record. */
  async cleanup(path: string, authorization: GuardedGitEffect | undefined): Promise<Decision<void>> {
    if (!authorization) {
      return deny(ReasonCode.WRITE_REQUIRES_MANAGED_RUN, "local worktree cleanup requires guard authorization", { path });
    }
    if (authorization.request.operation !== WriteOperation.GIT_WORKTREE) {
      return deny(ReasonCode.INVALID_ARGUMENT, "local worktree cleanup requires a GIT_WORKTREE authorization", {
        operation: authorization.request.operation,
      });
    }
    if (authorization.request.worktreeAction !== WorktreeAction.CLEANUP) {
      return deny(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH, "local cleanup requires a CLEANUP lifecycle authorization", {
        action: authorization.request.worktreeAction ?? null,
      });
    }
    const managedPath = this.managedPathFromPath(path);
    if (!authorization.request.targetPath || canonical(authorization.request.targetPath) !== managedPath) {
      return deny(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH, "local cleanup target does not match the guard request", {
        path: managedPath,
        authorizedTarget: authorization.request.targetPath ?? null,
      });
    }
    return authorization.guard.authorize(authorization.request, () => {
      const stat = lstatSync(managedPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        fail(ReasonCode.ISOLATION_LOST, "managed worktree path changed before cleanup", { path: managedPath });
      }
      rmSync(managedPath, { recursive: true, force: false });
    });
  }
}
