import {
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import { type Clock, systemClock } from "../core/clock.ts";
import { canonicalJson, digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { git, tryRevParse, type GitResult } from "../git/git.ts";
import type { GitHubWritePort } from "./github-write-port.ts";
import {
  GITHUB_LEDGER_SCHEMA_ID,
  applyGitHubOperations,
  githubLedgerPath,
  githubOperationSchema,
  preflightGitHubOperations,
  readGitHubLedger,
  toExternalWriteReceipt,
  writeGitHubLedger,
  type AppliedGitHubOperations,
  type GitHubExecutionPlan,
  type GitHubWriteAuthority,
  type LedgerState,
} from "./repo-factory-github.ts";
import {
  REPO_FACTORY_RESULT_SCHEMA_ID,
  type ExternalWriteReceipt,
  type RepoFactoryResult,
} from "./repo-factory-result.ts";

/**
 * Issue #246 — the producing side of the bootstrap contract that `repo-factory-result.ts`
 * already parses and rejects. With no GitHub operations in its plan, this producer performs
 * local filesystem and local git writes only. With GitHub operations, it performs them through
 * the injected `GitHubWritePort` and receipts what GitHub answered (`repo-factory-github.ts`);
 * without a port it refuses such a plan rather than receipting a write it did not perform.
 * It never activates anything.
 *
 * `RepoFactoryPlanFixture` is a deliberately minimal stand-in for the PRD's approved
 * `BootstrapPlanCore` (Integration §8.1/§13.2) — enough of the plan for this slice's
 * repository-role/verification/GitHub-operation facts, not the full canonical plan.
 */

/**
 * Local-only verification checks, closed by construction. CEO review round 3, defect 1:
 * an earlier version accepted `verificationArgs: string[]` — arbitrary git argv straight
 * from the plan — and `git -C <trusted> <plan argv...>` let a *second* `-C` (or
 * `--git-dir`/`--work-tree`/`--global`) inside that argv override the first, so every
 * containment check upstream validated a path the command then ignored. Blocklisting those
 * flag names would still miss "and anything else you find"; the only closure that does not
 * depend on enumerating git's flag surface is to never accept argv from the plan at all.
 * Each kind below maps to one fixed, hardcoded invocation with its own judge — there is no
 * path from plan content to argv content.
 */
export const VERIFICATION_KINDS = {
  CLEAN_TREE: {
    argv: ["status", "--porcelain"],
    /**
     * CEO review round 3, defect 2: `git status --porcelain` exits 0 whether or not the
     * tree is dirty — the dirtiness is on stdout, not the exit code. A judge that only
     * checked `exitCode` reported PASS over a working tree that provably was not clean (the
     * producer's own `.repo-factory-operation.json` marker sitting there untracked).
     */
    judge: (result: GitResult): Decision<void> => {
      if (result.exitCode !== 0) {
        return deny(
          ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
          "local verification command failed; refusing to record a fabricated PASS",
          { stderr: result.stderr },
        );
      }
      if (result.stdout.trim().length > 0) {
        return deny(
          ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
          "local verification observed a dirty working tree; refusing to record a fabricated PASS",
          { stdout: result.stdout },
        );
      }
      return allow(ReasonCode.OK, undefined);
    },
  },
} as const;

export type VerificationKind = keyof typeof VERIFICATION_KINDS;

/**
 * The verification kind whose fixed invocation *is* this argv — run as `git <argv...>` in the
 * checkout root — or null. A result's PASS names a manifest command id; it is honest only when
 * that command is the invocation the producer actually ran (PR #1043 review, RF1043-03). The
 * argv is compared, never executed: the executed argv is still only the hardcoded one above.
 */
export const verificationKindRunning = (argv: readonly string[]): VerificationKind | null => {
  for (const [kind, spec] of Object.entries(VERIFICATION_KINDS) as Array<[VerificationKind, { argv: readonly string[] }]>) {
    if (canonicalJson(["git", ...spec.argv]) === canonicalJson(argv)) return kind;
  }
  return null;
};

export const repoFactoryPlanFixtureSchema = z
  .object({
    runId: z.string().min(1),
    bootstrapOperationId: z.string().min(1),
    requestDigest: z.string().min(1),
    planDigest: z.string().min(1),
    projectManifestDigest: z.string().min(1),
    /** Kebab-case only — this is also the local directory name, so it cannot carry a path. */
    repositoryRole: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, "repositoryRole must be kebab-case"),
    defaultBranch: z.string().min(1),
    /**
     * The approved manifest command the PASS is recorded under — never itself run as argv. The
     * label is honest only if that command *is* `verificationKind`'s invocation; this producer
     * cannot see the manifest, so its caller must establish that (`verificationKindRunning`,
     * as `RepoFactoryBootstrapRunner` does — PR #1043 review, RF1043-03).
     */
    verificationCommandId: z.string().min(1),
    /** Which of `VERIFICATION_KINDS` this producer actually runs. Closed, not free-form argv. */
    verificationKind: z.enum(["CLEAN_TREE"]),
    /**
     * GitHub-side operations the plan calls for, each with the state it asks for. Integration
     * §13.3/§16 define `ExternalWriteReceipt` around a *GitHub* resource write, so these are
     * performed only through `RepoFactoryProducerInput.github`, and a resource type this
     * producer cannot both perform and re-read fails the schema here.
     */
    githubOperations: z.array(githubOperationSchema).default([]),
  })
  .strict();

export type RepoFactoryPlanFixture = z.infer<typeof repoFactoryPlanFixtureSchema>;

/**
 * Issue #246 PR-C slice C2 — one file a bootstrap plan says the produced repository holds, with its
 * exact bytes and git mode. The producer writes exactly these and nothing else into the commit, and
 * the tree at the produced head must then equal them (`producedTreeDrift`).
 */
export interface PlannedBootstrapFile {
  path: string;
  mode: "100644";
  content: string;
}

/** The one content file this producer commits. Its name is fixed; only its bytes vary by plan. */
export const BOOTSTRAP_CONTENT_FILE = ".repo-factory-bootstrap.json";

/**
 * The files a plan produces, rendered from the plan alone. `plannedBootstrapOutputs` lists exactly
 * these for review, and the producer writes exactly these, so the reviewed outputs and the produced
 * ones cannot be two renderings. That sharing is not the verification: the produced tree is read
 * back at its exact head and compared with the approved files (`producedTreeDrift`).
 */
export const plannedBootstrapFiles = (
  plan: Pick<RepoFactoryPlanFixture, "runId" | "repositoryRole">,
): PlannedBootstrapFile[] => [
  {
    path: BOOTSTRAP_CONTENT_FILE,
    mode: "100644",
    content: `${JSON.stringify({ runId: plan.runId, repositoryRole: plan.repositoryRole }, null, 2)}\n`,
  },
];

/**
 * A planned file is written at the checkout's root. A name with a separator, `.`/`..`, git's own
 * directory or this producer's bookkeeping marker is refused before anything is written: the
 * producer writes only what a reviewer could read as a plain file of the new repository.
 */
const plannedFileSchema = z
  .object({
    path: z
      .string()
      .regex(/^[A-Za-z0-9._-]+$/, "a planned file is a single file name at the repository root")
      .refine((path) => path !== "." && path !== ".." && path !== ".git", "a planned file cannot name git's own entries")
      .refine((path) => path !== OPERATION_MARKER_NAME, "a planned file cannot name the producer's marker"),
    mode: z.literal("100644"),
    content: z.string(),
  })
  .strict();

const plannedFilesSchema = z
  .array(plannedFileSchema)
  .min(1)
  .refine((files) => new Set(files.map((file) => file.path)).size === files.length, "a planned file is named twice");

export interface RepoFactoryGitHubInput {
  port: GitHubWritePort;
  /** What the owner approved — supplied by the caller, never read from the plan. */
  authority: GitHubWriteAuthority;
}

export interface RepoFactoryProducerInput {
  plan: RepoFactoryPlanFixture;
  /** Directory the producer may write inside. Nothing local is written outside it. */
  workDir: string;
  clock?: Clock;
  /** Required for a plan with GitHub operations; unused for one without. */
  github?: RepoFactoryGitHubInput;
  /**
   * Stores the result before it is returned. A throw removes this run's checkout, as any other
   * failure does, and propagates.
   */
  persist?: (result: RepoFactoryResult) => void;
  /**
   * Issue #246 PR-C slice C2 — the files the approved plan names (`plannedBootstrapOutputs`). The
   * producer commits exactly these, and refuses `BOOTSTRAP_CONTRACT_DRIFT` unless the tree at the
   * head it reports is exactly these. Omitted, they are `plannedBootstrapFiles(plan)`.
   */
  approvedFiles?: readonly PlannedBootstrapFile[];
}

/** The blob id git gives `content`, in the object format the repository's own ids use. */
const blobId = (content: string, objectFormat: "sha1" | "sha256"): string => {
  const bytes = Buffer.from(content, "utf8");
  return createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
};

/**
 * Issue #246 PR-C slice C2 — the CEO's correction: rendering the reviewed outputs and the produced
 * ones from one function is not verification. The tree at the exact head this run reports is read
 * back with `git ls-tree` and must be the approved files exactly — every path, mode and blob, no
 * file missing and none extra. Whatever stood between the write and that head (a hook, a filter, a
 * resumed push that reset onto the commit GitHub holds) is caught here rather than activated.
 *
 * Review round 2 (RF-REVIEW-04) — the tree is read with `--no-replace-objects`. A replacement
 * (`refs/replace/<id>`, under whatever `GIT_REPLACE_REF_BASE` names) changes what a local read of
 * `<id>` returns and nothing else: `git push` packs the objects themselves, so a hook that committed
 * unreviewed bytes and then replaced that commit with an approved one passed this check while the
 * unreviewed bytes were published. Reading unreplaced is reading what the transport sends, whichever
 * namespace or mechanism the replacement came from; refusing replacement refs instead would have to
 * enumerate a configurable namespace, and would still read through a replacement made after it looked.
 */
export const producedTreeDrift = async (
  checkoutPath: string,
  head: string,
  approved: readonly PlannedBootstrapFile[],
): Promise<Decision<void>> => {
  const listed = await git(checkoutPath, ["--no-replace-objects", "ls-tree", "-r", "-z", "--full-tree", head], {
    allowFailure: true,
  });
  if (listed.exitCode !== 0) {
    return deny(
      ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
      "the produced tree could not be read back at its exact head; refusing to report it as the approved outputs",
      { head, stderr: listed.stderr },
    );
  }
  // A 64-hex head is a SHA-256 repository; the blob ids are then SHA-256 as well.
  const objectFormat = head.length === 64 ? "sha256" : "sha1";
  const observed = new Map<string, { mode: string; type: string; id: string }>();
  for (const entry of listed.stdout.split("\0").filter((line) => line.length > 0)) {
    const tab = entry.indexOf("\t");
    const [mode = "", type = "", id = ""] = entry.slice(0, tab).split(" ");
    observed.set(entry.slice(tab + 1), { mode, type, id });
  }
  const expected = new Map(approved.map((file) => [file.path, { mode: file.mode, type: "blob", id: blobId(file.content, objectFormat) }]));
  const missing = [...expected.keys()].filter((path) => !observed.has(path)).sort();
  const extra = [...observed.keys()].filter((path) => !expected.has(path)).sort();
  const changed = [...expected.entries()]
    .flatMap(([path, want]) => {
      const got = observed.get(path);
      if (!got || (got.mode === want.mode && got.type === want.type && got.id === want.id)) return [];
      return [{ path, expected: want, observed: got }];
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (missing.length > 0 || extra.length > 0 || changed.length > 0) {
    return deny(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, "the produced tree is not the approved outputs", {
      refusal: "BOOTSTRAP_CONTRACT_DRIFT",
      head,
      missing,
      extra,
      changed,
    });
  }
  return allow(ReasonCode.OK, undefined);
};

/** Single source of truth for where a role's local checkout lives under `workDir`. */
export const repositoryCheckoutPath = (workDir: string, repositoryRole: string): string =>
  join(resolve(workDir), "repositories", repositoryRole);

const localRepositoryIdentity = (repositoryRole: string): string => `local:${repositoryRole}`;

/** Marker this run's own checkout carries so a later failure only ever cleans up its own. */
const OPERATION_MARKER_NAME = ".repo-factory-operation.json";

/**
 * The bootstrap operation an existing checkout's marker names, or null. Read only to word a
 * refusal: nothing is removed or reused on its strength, so a forged marker changes a message.
 */
const checkoutMarkerOf = (localRepoPath: string): string | null => {
  try {
    if (!lstatSync(localRepoPath).isDirectory()) return null;
    const marker = JSON.parse(readFileSync(join(localRepoPath, OPERATION_MARKER_NAME), "utf8")) as {
      bootstrapOperationId?: unknown;
    };
    return typeof marker.bootstrapOperationId === "string" ? marker.bootstrapOperationId : null;
  } catch {
    return null;
  }
};

/**
 * Issue #246 PR-C slice C3 — whether anything already occupies the checkout leaf a plan would
 * create, as the refusal the producer's own fast path gives for it, or null when the leaf is free.
 * The runner asks this among its pre-write checks, before the owner's approval is consumed; the
 * producer asks it again, and the atomic leaf creation below stays the collision authority. Read
 * with `lstat`, so a symlink, dangling or not, occupies the leaf too. Nothing is removed or reused on
 * the strength of what this finds.
 */
export const occupiedCheckoutLeaf = (
  workDir: string,
  plan: Pick<RepoFactoryPlanFixture, "repositoryRole" | "bootstrapOperationId">,
): Decision<never> | null => {
  const localRepoPath = repositoryCheckoutPath(workDir, plan.repositoryRole);
  try {
    lstatSync(localRepoPath);
  } catch {
    return null;
  }
  // Said explicitly when the checkout is this operation's own (PR #1043 review, RF1043-02): a
  // run that stopped without cleaning up — killed, or still running — leaves it. It is named
  // and kept rather than reclaimed: a matching HEAD does not make its tracked edits, untracked or
  // ignored files recoverable, and a live run cannot be told from a dead one, so a reclaiming
  // retry could delete what another retry had just claimed (round 3, RF1043-07). A person
  // removes it once nothing in it is wanted and no run of this operation is active; the next
  // run then resumes from the GitHub ledger.
  if (checkoutMarkerOf(localRepoPath) === plan.bootstrapOperationId) {
    return deny(
      ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
      "this bootstrap operation's checkout already exists: an earlier run of it stopped without cleaning up, or is still running. It is not removed automatically; remove it once nothing in it is wanted and no run of this operation is active, and the next run resumes from the GitHub ledger",
      { refusal: "INTERRUPTED_RUN_CHECKOUT", localRepoPath, resumable: false },
    );
  }
  return deny(
    ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
    "local repository checkout path already exists; a same-named resource with unknown provenance is a collision, not a resume (Integration §13.3)",
    { localRepoPath },
  );
};

/**
 * CEO review round 8 — this producer used to also run a realpath-based containment check
 * (`canonical()`/`isWithin()`, the same primitives `src/guard/workspace-probe.ts` uses) ahead
 * of every operation below. It was removed rather than kept as belt-and-braces: CEO neutered
 * it on a scratch copy of this exact head (`if (!isWithin(...))` → `if (false && ...)`) and
 * every test still passed. Measured why, rather than assumed: `repositoryCheckoutPath` joins
 * `role` — which the schema restricts to `^[a-z0-9][a-z0-9-]*$`, so it can carry no `/` or
 * `..` — straight onto `resolve(workDir)`, so for every input the schema admits, the only way
 * the resulting path can differ from a plain subdirectory of `workDir` is a *real* symlink
 * sitting at `workDir`, `repositories`, `dirname(workDir)`, or the leaf itself. Every one of
 * those is already refused by an `lstatSync`-based check elsewhere: the first three by
 * `assertParentChainNotAttackerWritable`'s chain walk below (which denies outright on
 * `isSymbolicLink()`, not merely on where it resolves to), and the leaf by the pre-creation
 * `existsSync` fast path or `createCheckoutLeafOrDeny`'s own `EEXIST` — both of which already
 * fire before any write, regardless of whether the pre-existing entry is a symlink or
 * anything else. No input reaches the removed check that is not already refused by one of
 * these — that is what "no test noticed" was reporting. A dead guard that reads as live
 * defense is worse than none, because it is counted; removing it removes a claim nothing
 * behind it could actually back.
 */

/**
 * The ownership/permission decision, factored out so it can be exercised directly with a
 * crafted `{ uid, mode }` — the exact fields `fs.Stats` carries — without needing a real
 * directory owned by a different account, which a test sandbox cannot create without root.
 */
export const judgeDirectoryOwnership = (
  dir: string,
  stat: { uid: number; mode: number },
  myUid: number,
): Decision<void> => {
  if (stat.uid !== myUid) {
    return deny(
      ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
      "a directory between the work directory and the repository checkout is not owned by this process; refusing rather than risk a symlink swap by another account",
      { dir, ownerUid: stat.uid, myUid },
    );
  }
  if ((stat.mode & 0o022) !== 0) {
    return deny(
      ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
      "a directory between the work directory and the repository checkout is writable by another user or group; refusing rather than risk a symlink swap",
      { dir, mode: (stat.mode & 0o777).toString(8) },
    );
  }
  return allow(ReasonCode.OK, undefined);
};

/**
 * Judges the real, on-disk entry at `dir` — via `lstatSync`, which the caller must have
 * already taken (never `statSync`, which follows a symlink and reports its *target*'s
 * identity instead of the entry's own). CEO review round 6, defect 1: a `workDir` reached
 * through `unsafeGrandparent/link -> safeTarget` looked safe under `statSync`, because it
 * silently inspected `safeTarget` (0700, owned by this process) and never examined `link`
 * itself or `unsafeGrandparent`, the directory that actually governs whether the `link`
 * *entry* can be renamed or replaced by another account. A symlink anywhere this producer
 * expects a real directory is refused outright, regardless of what it resolves to or who
 * owns that target — verifying the indirection away is not the same as refusing to depend
 * on one at all, and only the second is real.
 */
const judgeRealDirectoryEntry = (
  dir: string,
  stat: Stats,
  myUid: number,
): Decision<void> => {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return deny(
      ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
      "a directory this run depends on is a symlink or not a directory at all; refusing rather than trust what it resolves to or who can replace the entry itself",
      { dir },
    );
  }
  return judgeDirectoryOwnership(dir, stat, myUid);
};

/**
 * CEO review round 4, defect 3 — round 3's fix re-verified the checkout path's device+inode
 * identity immediately before every subsequent operation. CEO's verdict was explicit and
 * demonstrated directly: a swap injected strictly between a successful re-check and the git
 * call right after it was followed exactly as before — shrinking a check-then-act window is
 * not closing it, no matter how tight the shrink. Re-checking faster does not help; the only
 * real close is removing the actor who could ever win that race.
 *
 * This does that by converting the race into a precondition: every existing directory
 * between the checkout's own parent and `dirname(workDir)` — **not stopping at `workDir`
 * itself** — must be owned by this process's effective user and must not be writable by any
 * other user or group (`mode & 0o022 === 0`). Stopping the walk at `workDir` (round 4's
 * first attempt) answered "can someone tamper with what's *inside* workDir", which is a
 * different question from "can someone rename or replace the `workDir` *entry* itself" —
 * that second question is answered by `workDir`'s own parent's permissions, and only its
 * own parent's: renaming or deleting a directory entry needs write access on the directory
 * that *contains* the entry, not on the entry itself. An attacker-writable grandparent
 * holding an owner-only `workDir` swaps the `workDir` entry with no need to write inside it
 * at all, which stopping at `workDir` could not see.
 *
 * If the whole chain holds, no *other* account can create, delete, or rename anything in it
 * — not "probably won't in the brief window before the next syscall", but categorically
 * cannot, because doing so requires write access to the parent directory and, by
 * construction, nothing but this process has it. Once verified, the invariant holds for the
 * rest of this run without needing to be re-checked before every operation: changing it
 * would itself require the very write access this check just proved nobody but this process
 * holds.
 *
 * What this does *not* do, stated rather than left as a documented hole: it does not defend
 * against a same-account actor. In this system same-UID *concurrent* producers are the
 * normal operating mode, not an attacker — that case is real and is closed separately, by
 * making leaf creation atomic (see `produceRepoFactoryResult`'s `mkdirSync(localRepoPath)`
 * with no `recursive`), not by an ownership check, because two same-UID processes legitimately
 * share exactly the access this check verifies. A same-UID actor deliberately racing this
 * producer maliciously is a compromised-account scenario no single producer function can
 * meaningfully defend against; the guarantee here is narrower on purpose: it refuses to
 * operate in a namespace a *different* user or group could tamper with.
 */
const assertParentChainNotAttackerWritable = (workDir: string, localRepoPath: string): Decision<void> => {
  if (typeof process.getuid !== "function") {
    return deny(
      ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
      "ownership verification is not supported on this platform; refusing rather than silently skipping it",
      { workDir, localRepoPath },
    );
  }
  const myUid = process.getuid();
  const boundary = resolve(workDir);
  const chain: string[] = [];
  let current = dirname(resolve(localRepoPath));
  let reachedBoundary = false;
  for (;;) {
    chain.push(current);
    if (current === boundary) {
      reachedBoundary = true;
      break;
    }
    const parent = dirname(current);
    if (parent === current) break; // reached the filesystem root without meeting workDir
    current = parent;
  }
  if (reachedBoundary) {
    // The one directory that governs whether `workDir` *itself* can be renamed, deleted, or
    // replaced. Deliberately exactly one level further, not a walk to the filesystem root:
    // going further would need to special-case shared, sticky-bit-protected roots like the
    // OS temp directory (world-writable but safe, because the sticky bit already restricts
    // deletion/rename to an entry's own owner) to avoid refusing every ordinary temp-rooted
    // workDir, and this producer's contract is "given a workDir", not "given everything
    // above it". A caller wanting one more level of protection nests workDir one directory
    // deeper under something it already owns — which is what every test and the CLI already do.
    const parentOfWorkDir = dirname(boundary);
    if (parentOfWorkDir !== boundary) chain.push(parentOfWorkDir);
  }
  for (const dir of chain) {
    let stat: Stats;
    try {
      stat = lstatSync(dir);
    } catch {
      continue; // not created yet — nothing to own or misconfigure
    }
    const judged = judgeRealDirectoryEntry(dir, stat, myUid);
    if (!judged.allowed) return judged;
  }
  return allow(ReasonCode.OK, undefined);
};

/** Owner-only. Passed explicitly to every `mkdirSync` this producer performs — see below. */
const SAFE_DIRECTORY_MODE = 0o700;

/**
 * How `judgeAndCleanupIfJustCreated` reads back what is actually at a path. Always
 * `lstatSync` in production — every real call site below passes it explicitly, not as an
 * implicit default a caller happens to rely on — so this is the one seam a test can supply a
 * different value through, following the same shape `judgeDirectoryOwnership` above already
 * uses for its crafted `{ uid, mode }`.
 *
 * CEO review round 7 named exactly why this seam has to exist rather than a umask trick:
 * `mkdirSync(dir, { mode })` applies `mode & ~umask`, which can only *clear* bits — a
 * directory freshly created at `SAFE_DIRECTORY_MODE` can never come back group- or
 * world-writable from the umask alone, so no umask value can make the judgement below
 * observably fire for a freshly created directory. What it exists to catch is a real race —
 * another process replacing or chmod'ing the entry between `mkdirSync` and this call — and a
 * real race is not a deterministic thing to trigger in a test. Supplying a `statEntry` that
 * reports what a winning racer would have left is how that race is exercised without needing
 * to win one.
 */
type DirectoryStatReader = (path: string) => Stats;

/**
 * Judges whatever now sits at `dir` — freshly created by this same call, or discovered
 * already there — and, if this call is the one that just created it, removes it again on a
 * denial. CEO review round 6, defect 2: an explicit `mode` on `mkdirSync` is still subject to
 * the process umask (`mode & ~umask`), and the previous shape returned `allow` the instant
 * `mkdirSync` succeeded, never inspecting what was actually created. Reproduced directly:
 * under `umask(0)`, a bare `mkdirSync(dir)` with no mode argument created `workDir`,
 * `repositories`, and the checkout leaf all at `0777` — world-writable — and the run
 * completed successfully anyway. `SAFE_DIRECTORY_MODE` narrows what is *requested*; this
 * function is what actually verifies what was *granted*, via `statEntry` (`lstatSync` in
 * production — never `statSync`, for the same reason `judgeRealDirectoryEntry` above does
 * not use it).
 *
 * Self-cleanup is safe exactly because there is no gap to race here: `mkdirSync` above and
 * this judgement are the same synchronous call, so whatever this call just created is
 * unambiguously its own — unlike `cleanupOwnedCheckout`, which needs the ownership-marker
 * dance because real async work happens between creating the checkout and a possible later
 * failure.
 */
const judgeAndCleanupIfJustCreated = (
  dir: string,
  justCreated: boolean,
  statEntry: DirectoryStatReader,
): Decision<void> => {
  if (typeof process.getuid !== "function") {
    if (justCreated) rmSync(dir, { recursive: true, force: true });
    return deny(
      ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
      "ownership verification is not supported on this platform; refusing rather than silently skipping it",
      { dir },
    );
  }
  let stat: Stats;
  try {
    stat = statEntry(dir);
  } catch (err) {
    return deny(
      ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
      "a directory this run needs disappeared between creation and inspection",
      { dir, message: (err as Error).message },
    );
  }
  const judged = judgeRealDirectoryEntry(dir, stat, process.getuid());
  if (!judged.allowed && justCreated) {
    rmSync(dir, { recursive: true, force: true });
  }
  return judged;
};

/**
 * Creates `dir` if it does not already exist — one level, never `recursive: true`. A single
 * recursive `mkdirSync` call can silently create *several* missing path components in one
 * shot, including ones that did not exist at precheck time; if a symlink was raced into
 * place anywhere along that path in the meantime, recursive creation tunnels straight
 * through it and writes real directories inside whatever it points to, *before* any
 * post-creation check gets a chance to refuse (CEO review round 4, defect 3b). A plain
 * `mkdirSync(dir)` either creates a fresh, genuine directory atomically, or fails `EEXIST`
 * if anything — including a symlink raced into place — already occupies that exact path.
 * Either way, `judgeAndCleanupIfJustCreated` verifies what is actually there afterward —
 * freshly created or reused, real directory or something else, safe mode or not.
 *
 * `workDir` and the shared `repositories` directory are created this way; the checkout leaf
 * itself uses `createCheckoutLeafOrDeny` in `produceRepoFactoryResult` (same shape, except an
 * already-existing directory there is a collision, never something to reuse).
 */
export const ensureDirectoryLevel = (dir: string, statEntry: DirectoryStatReader = lstatSync): Decision<void> => {
  let justCreated = false;
  try {
    mkdirSync(dir, { mode: SAFE_DIRECTORY_MODE });
    justCreated = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      return deny(
        ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
        "could not create a directory this run needs",
        { dir, message: (err as Error).message },
      );
    }
  }
  return judgeAndCleanupIfJustCreated(dir, justCreated, statEntry);
};

/**
 * THE collision authority for the checkout leaf itself (CEO review round 5, defect 2). Unlike
 * `ensureDirectoryLevel` above — which treats an already-existing real directory as fine to
 * reuse, because `repositories` is legitimately shared across roles and calls — the leaf must
 * be *freshly created by this exact call*. `mkdirSync` with no `recursive` is a single atomic
 * syscall: it either creates a genuinely new directory or fails `EEXIST`, decided by the
 * kernel. Exactly one concurrent caller for this exact path succeeds; every other one —
 * including another of this project's own producers racing the same operation, the normal
 * concurrent case this system actually runs as one user all day, not only a hypothetical
 * attacker — gets `EEXIST` here, never a check-then-act `existsSync` another process can run
 * between (proof: `mkdirSync(existingRealDir, { recursive: true })` does not throw at all —
 * that is Node's own documented idempotent behaviour, and it is exactly why the previous
 * shape gave two concurrent creators no collision signal whatsoever; a plain, non-recursive
 * `mkdirSync` on the same already-existing directory does throw `EEXIST`, tested directly
 * below without needing a real race). As with `ensureDirectoryLevel`, a successful create is
 * still judged afterward — see `judgeAndCleanupIfJustCreated` for why (CEO review round 6,
 * defect 2).
 */
export const createCheckoutLeafOrDeny = (
  localRepoPath: string,
  statEntry: DirectoryStatReader = lstatSync,
): Decision<void> => {
  let justCreated = false;
  try {
    mkdirSync(localRepoPath, { mode: SAFE_DIRECTORY_MODE });
    justCreated = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return deny(
        ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
        "local repository checkout path already exists; a same-named resource with unknown provenance is a collision, not a resume (Integration §13.3)",
        { localRepoPath },
      );
    }
    return deny(
      ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
      "could not create the local repository checkout directory",
      { localRepoPath, message: (err as Error).message },
    );
  }
  return judgeAndCleanupIfJustCreated(localRepoPath, justCreated, statEntry);
};

/**
 * Removes the checkout this call created — and only if the ownership precondition still
 * holds for it *and* the ownership marker inside it still names this exact operation. Either
 * failing means either this call's own write never completed or something else may now be
 * involved with that path; either way this refuses to delete it (Integration §13.3's
 * RESOURCE_COLLISION is the right outcome for an unproven resource, not a guess).
 */
const cleanupOwnedCheckout = (workDir: string, localRepoPath: string, bootstrapOperationId: string): void => {
  const ownership = assertParentChainNotAttackerWritable(workDir, localRepoPath);
  if (!ownership.allowed) return;
  let marker: unknown;
  try {
    marker = JSON.parse(readFileSync(join(localRepoPath, OPERATION_MARKER_NAME), "utf8"));
  } catch {
    return;
  }
  if ((marker as { bootstrapOperationId?: unknown }).bootstrapOperationId !== bootstrapOperationId) return;
  rmSync(localRepoPath, { recursive: true, force: true });
};

/**
 * The decision `produceRepoFactoryResult` makes about `git ls-tree`'s real exit code,
 * pulled out as its own function so it can be exercised directly with the exact `GitResult`
 * shape `git()` returns — reproducing a genuine `ls-tree` failure at exactly this point in a
 * real repository is not reliably possible without corrupting the process's own working
 * tree mid-run. Production calls this function with that exact shape, so a test that calls
 * it the same way is entering at the same place production does, not a different layer.
 */
export const trackedFilesOrDeny = (tracked: GitResult): Decision<string[]> => {
  if (tracked.exitCode !== 0) {
    return deny(
      ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
      "local tracked-file listing failed; refusing to build a verified receipt on top of it",
      { stderr: tracked.stderr },
    );
  }
  return allow(
    ReasonCode.OK,
    tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean).sort(),
  );
};

/**
 * Builds one `repo-factory.result.v2` from a real local filesystem/git run — no GitHub
 * write, no hand-authored result. Every fact this returns is something the run actually
 * observed: `bootstrapVerification[].exactHead` is the commit this run checked and published (on a
 * resume, the head GitHub holds as the push step receipted it), and a real `git rev-parse HEAD`
 * read back after the verification must equal it, and the `externalWriteReceipt` describes the local git repository this
 * call created, not a GitHub resource it never touched.
 *
 * Things this deliberately refuses to fabricate rather than fill because the schema demands
 * a value:
 *
 *  - a GitHub write it did not perform — a plan with `githubOperations` and no
 *    `input.github` port is refused, and with a port each receipt is built from GitHub's
 *    readback after the write, never from the plan (`repo-factory-github.ts`);
 *  - a `bootstrapVerification` PASS when the real local verification command's exit code or
 *    stdout says otherwise, or the tracked-file listing behind the receipt fails — recording
 *    PASS anyway would be a schema-complete lie;
 *  - a checkout path outside `workDir`, reached through a symlink anywhere in the chain
 *    between `workDir`'s own parent and the checkout leaf — refused outright by
 *    `assertParentChainNotAttackerWritable` and the `lstatSync` checks in
 *    `ensureDirectoryLevel`/`createCheckoutLeafOrDeny`, not by resolving where the symlink
 *    points and judging that instead.
 *
 * A failure after the checkout directory exists cleans up only the exact thing this call
 * created (see `cleanupOwnedCheckout`), so the same operation can be retried rather than
 * being permanently refused by its own leftover collision.
 */
export const produceRepoFactoryResult = async (
  input: RepoFactoryProducerInput,
): Promise<Decision<RepoFactoryResult>> => {
  const parsedPlan = repoFactoryPlanFixtureSchema.safeParse(input.plan);
  if (!parsedPlan.success) {
    return deny(ReasonCode.INVALID_ARGUMENT, "repo factory plan fixture failed validation", {
      issues: parsedPlan.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const plan = parsedPlan.data;
  const clock = input.clock ?? systemClock;
  const parsedFiles = plannedFilesSchema.safeParse(input.approvedFiles ?? plannedBootstrapFiles(plan));
  if (!parsedFiles.success) {
    return deny(ReasonCode.INVALID_ARGUMENT, "the approved files failed validation", {
      issues: parsedFiles.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const approvedFiles = parsedFiles.data;

  if (plan.githubOperations.length > 0 && input.github === undefined) {
    return deny(
      ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
      "a plan with GitHub operations needs a GitHub write port; without one this producer cannot perform them and will not receipt a write it did not perform (issue #246 boundary)",
      { githubOperations: plan.githubOperations.map((op) => op.operationId) },
    );
  }

  // Every GitHub check that needs no GitHub call — approval coverage, owner, visibility, plan
  // shape — runs here, before any local write and before the port is touched at all.
  let github: { execution: GitHubExecutionPlan; port: GitHubWritePort; ledgerPath: string } | null = null;
  if (plan.githubOperations.length > 0 && input.github !== undefined) {
    const preflight = preflightGitHubOperations(plan, input.github.authority);
    if (!preflight.allowed) return preflight as Decision<RepoFactoryResult>;
    github = {
      execution: preflight.value,
      port: input.github.port,
      ledgerPath: githubLedgerPath(input.workDir, plan.repositoryRole),
    };
  }
  const ledgerOwner = { bootstrapOperationId: plan.bootstrapOperationId, requestDigest: plan.requestDigest };

  const workDir = resolve(input.workDir);
  const localRepoPath = repositoryCheckoutPath(workDir, plan.repositoryRole);
  const repositoriesDir = dirname(localRepoPath);

  // Fast-path only — refusing early avoids the containment/ownership/creation work below for
  // the common, non-concurrent case. It is NOT the collision authority: see the atomic
  // `mkdirSync(localRepoPath)` further down, which is (CEO review round 4, defect 3b — this
  // system runs multiple same-UID producers concurrently as normal operation, and an
  // `existsSync` check has a gap another process's own creation can land in before this one
  // reads it).
  const occupied = occupiedCheckoutLeaf(workDir, plan);
  if (occupied !== null) return occupied;

  const ownershipPrecheck = assertParentChainNotAttackerWritable(workDir, localRepoPath);
  if (!ownershipPrecheck.allowed) return ownershipPrecheck as Decision<RepoFactoryResult>;

  // `workDir` and `repositories` are created one level at a time, never `recursive: true` —
  // a single recursive call can tunnel through several path components (including one raced
  // into place after the precheck above) before anything checks again. Each step below
  // either creates a fresh, genuine directory or discovers a real, already-existing one;
  // anything else — a symlink raced into place in that exact window — is refused immediately,
  // producing no write inside it, not merely a refusal after the fact.
  const levels = github === null ? [workDir, repositoriesDir] : [workDir, repositoriesDir, dirname(github.ledgerPath)];
  for (const dir of levels) {
    const ensured = ensureDirectoryLevel(dir);
    if (!ensured.allowed) return ensured as Decision<RepoFactoryResult>;
  }

  const leafCreated = createCheckoutLeafOrDeny(localRepoPath);
  if (!leafCreated.allowed) return leafCreated as Decision<RepoFactoryResult>;

  writeFileSync(
    join(localRepoPath, OPERATION_MARKER_NAME),
    `${JSON.stringify({ bootstrapOperationId: plan.bootstrapOperationId })}\n`,
  );
  const cleanup = (): void => cleanupOwnedCheckout(workDir, localRepoPath, plan.bootstrapOperationId);
  /**
   * Every git call below, with the cleanup its denial paths already run.
   *
   * `cleanup()` was on each *denial* path and on none of the throwing ones. That was harmless
   * while these calls could not throw — three of them pass `allowFailure: true` and returned a
   * nonzero exit code instead — and #859's time bound changed it: a git that outlives its bound
   * now raises `GIT_TIMEOUT`. The throw skipped `cleanup()`, the checkout and its ownership marker
   * survived, and `createCheckoutLeafOrDeny` then refused **every** retry with `EEXIST` —
   * "a same-named resource with unknown provenance is a collision, not a resume". That is the
   * opposite of what the marker is for, in this function's own words: it exists "so the same
   * operation can be retried rather than being permanently refused by its own leftover collision".
   *
   * So one slow git made the operation permanently unretryable, by the exact mechanism the marker
   * was added to prevent. `git add` below has no `allowFailure` and could already throw, so this
   * is a pre-existing hole the bound widened rather than opened (#871).
   */
  const gitOrCleanup = async (
    args: readonly string[],
    options: { allowFailure?: boolean } = {},
  ): Promise<Awaited<ReturnType<typeof git>>> => {
    try {
      return await git(localRepoPath, args, options);
    } catch (err) {
      cleanup();
      throw err;
    }
  };

  // Read only once this call holds the checkout leaf, which `createCheckoutLeafOrDeny` grants to
  // exactly one caller per role — so no other producer is writing this ledger while it is read.
  let prior: LedgerState = { receipts: new Map(), pending: new Map() };
  if (github !== null) {
    const ledger = readGitHubLedger(github.ledgerPath, ledgerOwner, github.execution.operations);
    if (!ledger.allowed) {
      cleanup();
      return ledger as Decision<RepoFactoryResult>;
    }
    prior = ledger.value;
  }

  const createdAt = clock.nowIso();

  const init = await gitOrCleanup(["init", "-b", plan.defaultBranch], { allowFailure: true });
  if (init.exitCode !== 0) {
    cleanup();
    return deny(ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT, "local git init failed", {
      stderr: init.stderr,
    });
  }

  // CEO review round 3, defect 2's other half: the ownership marker is deliberately never
  // committed, so a plain `git status` reports it as untracked — provably dirty, not clean.
  // `.git/info/exclude` is git's own mechanism for "ignored in this local repository without
  // committing a .gitignore for it", and is exactly what this marker is: this run's own
  // bookkeeping, not part of the repository's real content. Tested directly in
  // `tests/unit/repo-factory-producer.test.ts` by running real `git status --porcelain`
  // against a produced repository and asserting its output is empty.
  writeFileSync(join(localRepoPath, ".git", "info", "exclude"), `${OPERATION_MARKER_NAME}\n`, { flag: "a" });

  // The approved files and nothing else (#246 C2): the bytes the plan's review read.
  for (const file of approvedFiles) writeFileSync(join(localRepoPath, file.path), file.content);

  // Only the approved files are tracked — the ownership marker above is bookkeeping for this
  // function's own retry/cleanup logic, not part of the repository's real content.
  await gitOrCleanup(["add", "--", ...approvedFiles.map((file) => file.path)]);
  const commit = await gitOrCleanup(
    [
      "-c", "user.email=repo-factory@local",
      "-c", "user.name=Repo Factory",
      "commit", "-m", "repo factory bootstrap",
    ],
    { allowFailure: true },
  );
  if (commit.exitCode !== 0) {
    cleanup();
    return deny(
      ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
      "local bootstrap commit failed; refusing to fabricate a result without a real commit",
      { stderr: commit.stderr },
    );
  }

  // #246 C2, review round 1 (RF-REVIEW-01) — the commit just made is compared with the approved
  // files before anything reaches GitHub. Checked only after the GitHub operations, a tree a hook
  // had changed was refused once the repository existed with those bytes pushed, its default branch
  // set and its branch protected; a refusal undoes none of that. A head GitHub already holds is
  // checked the same way once it is checked out (`approvedTree` below), and the head this run
  // finally reports once more after.
  //
  // Review round 3 (RF-REVIEW-01) — what is checked is a commit id, and that id is what is published:
  // the push sends `validatedHead` and the result reports the head the push step receipted. HEAD is
  // read once, here, before any await on GitHub; read again later it could name a commit that moved
  // in while GitHub was awaited, which nothing had checked.
  const approvedTree = (at: string): Promise<Decision<void>> => producedTreeDrift(localRepoPath, at, approvedFiles);
  const checkedCommit = async (): Promise<Decision<string>> => {
    const committed = await tryRevParse(localRepoPath, "HEAD");
    if (!committed) {
      return deny(ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT, "local repository has no exact HEAD after commit", { localRepoPath });
    }
    const committedDrift = await approvedTree(committed);
    return committedDrift.allowed ? allow(ReasonCode.OK, committed) : (committedDrift as Decision<string>);
  };
  let validated: Decision<string>;
  try {
    validated = await checkedCommit();
  } catch (thrown) {
    cleanup();
    throw thrown;
  }
  if (!validated.allowed) {
    cleanup();
    return validated as Decision<RepoFactoryResult>;
  }
  const validatedHead = validated.value;

  // GitHub's half, between the commit and the verification: the verified head below must be
  // the head GitHub holds. On a resumed push the commit just made is not that head — its
  // timestamp differs from the one GitHub holds — so the push step fetches the receipted
  // commit and resets onto it rather than pushing a second one. A failure leaves the ledger —
  // every write that succeeded, with its readback — and removes only the local checkout, which
  // a retry rebuilds (see `repo-factory-github.ts` for why there is no rollback). A throw cleans
  // up the same way, for the reason `gitOrCleanup` above gives.
  let applied: AppliedGitHubOperations | null = null;
  if (github !== null) {
    const ledgerPath = github.ledgerPath;
    let outcome: Decision<AppliedGitHubOperations>;
    try {
      outcome = await applyGitHubOperations({
        execution: github.execution,
        port: github.port,
        checkoutPath: localRepoPath,
        defaultBranch: plan.defaultBranch,
        prior,
        record: (state) =>
          writeGitHubLedger(ledgerPath, {
            schema: GITHUB_LEDGER_SCHEMA_ID,
            ...ledgerOwner,
            receipts: state.receipts,
            pending: state.pending,
          }),
        ledgerPath,
        clock,
        approvedTree,
        validatedHead,
      });
    } catch (thrown) {
      cleanup();
      throw thrown;
    }
    if (!outcome.allowed) {
      cleanup();
      return outcome as Decision<RepoFactoryResult>;
    }
    applied = outcome.value;
  }

  // The head this run reports is the one it published — the checked commit, or on a resume the head
  // GitHub holds as the push step receipted it after checking it — never HEAD read back after the
  // awaits above (RF-REVIEW-01, round 3). The re-read after verification below refuses a checkout
  // that is not at it.
  const head = applied === null ? validatedHead : applied.publishedHead;

  // #246 C2 — the head this run reports, GitHub's own on a resumed push, must hold exactly the
  // approved files. A drifted tree is refused before it is verified, receipted or activated.
  let drift: Decision<void>;
  try {
    drift = await approvedTree(head);
  } catch (thrown) {
    cleanup();
    throw thrown;
  }
  if (!drift.allowed) {
    cleanup();
    return drift as Decision<RepoFactoryResult>;
  }

  // The real verification kind this run promises `bootstrapVerification` about. A judge
  // that denies is a genuine observation, not a fabricated one, and it must refuse rather
  // than record PASS regardless.
  const verificationSpec = VERIFICATION_KINDS[plan.verificationKind];
  const verificationRun = await gitOrCleanup(verificationSpec.argv, { allowFailure: true });
  const verificationJudged = verificationSpec.judge(verificationRun);
  if (!verificationJudged.allowed) {
    cleanup();
    return verificationJudged as Decision<RepoFactoryResult>;
  }

  const rereadAt = clock.nowIso();
  const rereadHead = await tryRevParse(localRepoPath, "HEAD");
  if (rereadHead !== head) {
    cleanup();
    return deny(
      ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
      "local repository HEAD changed between write and post-write re-read",
      { localRepoPath, head, rereadHead },
    );
  }

  const trackedRun = await gitOrCleanup(["ls-tree", "-r", "--name-only", head], { allowFailure: true });
  const tracked = trackedFilesOrDeny(trackedRun);
  if (!tracked.allowed) {
    cleanup();
    return tracked as Decision<RepoFactoryResult>;
  }

  // A GitHub-provisioned repository is named by its GitHub identity — the portable form an
  // approved manifest's `remote` must take (`assertPortableManifest`) — and receipted only by
  // its GitHub operations: activation matches every receipt against the approved plan's
  // `githubOperations`, where a local checkout has no entry. A local-only run keeps its local
  // identity and its one local receipt, and stays unactivatable by design (#246).
  const identity = github === null ? localRepositoryIdentity(plan.repositoryRole) : github.execution.repositoryIdentity;
  const receipts: ExternalWriteReceipt[] =
    applied === null
      ? [
          {
            bootstrapOperationId: plan.bootstrapOperationId,
            requestDigest: plan.requestDigest,
            operationId: `${plan.bootstrapOperationId}:local-repository-create`,
            resourceType: "local_git_repository",
            resourceIdentity: identity,
            preexisting: false,
            beforeStateDigest: null,
            afterStateDigest: digestOf({ head, files: tracked.value }),
            createdAt,
            rereadAt,
            verified: true,
          },
        ]
      : applied.receipts.map((receipt) => toExternalWriteReceipt(receipt, ledgerOwner));

  const result: RepoFactoryResult = {
    schema: REPO_FACTORY_RESULT_SCHEMA_ID,
    runId: plan.runId,
    bootstrapOperationId: plan.bootstrapOperationId,
    planDigest: plan.planDigest,
    projectManifestDigest: plan.projectManifestDigest,
    repositories: [
      {
        role: plan.repositoryRole,
        identity,
        // Integration §13's own comment: Repo Factory may *propose* a local binding, it
        // never commits one. This is the honest form of that — a real path this run
        // created, offered as a proposal only.
        proposedCheckoutPath: localRepoPath,
        defaultBranch: plan.defaultBranch,
        createdBranches: [],
      },
    ],
    externalWriteReceipts: receipts,
    bootstrapVerification: [
      {
        commandId: plan.verificationCommandId,
        repositoryIdentity: identity,
        exactHead: head,
        status: "PASS",
      },
    ],
    ciEvidence: [],
    unresolvedGaps: [],
  };

  // The caller's store, run inside this function's cleanup: a result that could not be kept
  // leaves no checkout behind, so the retry takes the ordinary path — the ledger reconciled
  // against GitHub, the result rebuilt — and is never refused at its own checkout (PR #1043
  // review, RF1043-02). The caller's store keeps it rather than a file beside the ledger: a copy
  // only this producer can vouch for is a copy anyone who can write the file can forge (round 3,
  // RF1043-08).
  if (input.persist !== undefined) {
    try {
      input.persist(result);
    } catch (thrown) {
      cleanup();
      throw thrown;
    }
  }
  return allow(ReasonCode.OK, result);
};
