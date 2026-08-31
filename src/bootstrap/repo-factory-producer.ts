import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import { type Clock, systemClock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { git, tryRevParse, type GitResult } from "../git/git.ts";
import { canonical, isWithin } from "../guard/workspace-probe.ts";
import {
  REPO_FACTORY_RESULT_SCHEMA_ID,
  type ExternalWriteReceipt,
  type RepoFactoryResult,
} from "./repo-factory-result.ts";

/**
 * Issue #246, first slice — the producing side of the bootstrap contract that
 * `repo-factory-result.ts` already parses and rejects. This producer performs local
 * filesystem and local git writes only. It never touches GitHub: no network call, no
 * repository creation, no activation.
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
    /** Correlates to a named command in the approved manifest — never itself run as argv. */
    verificationCommandId: z.string().min(1),
    /** Which of `VERIFICATION_KINDS` this producer actually runs. Closed, not free-form argv. */
    verificationKind: z.enum(["CLEAN_TREE"]),
    /**
     * GitHub-side operations the plan calls for. Integration §13.3/§16 define
     * `ExternalWriteReceipt` around a *GitHub* resource write; this producer makes none, so
     * a non-empty list here cannot be honestly receipted and is refused outright.
     */
    githubOperations: z
      .array(
        z.object({
          operationId: z.string().min(1),
          resourceType: z.string().min(1),
          resourceIdentity: z.string().min(1),
        }),
      )
      .default([]),
  })
  .strict();

export type RepoFactoryPlanFixture = z.infer<typeof repoFactoryPlanFixtureSchema>;

export interface RepoFactoryProducerInput {
  plan: RepoFactoryPlanFixture;
  /** Directory the producer may write inside. Nothing is written outside it. */
  workDir: string;
  clock?: Clock;
}

/** Single source of truth for where a role's local checkout lives under `workDir`. */
export const repositoryCheckoutPath = (workDir: string, repositoryRole: string): string =>
  join(resolve(workDir), "repositories", repositoryRole);

const localRepositoryIdentity = (repositoryRole: string): string => `local:${repositoryRole}`;

/** Marker this run's own checkout carries so a later failure only ever cleans up its own. */
const OPERATION_MARKER_NAME = ".repo-factory-operation.json";

/**
 * A repository role is checked against `workDir` twice on purpose: once before anything is
 * created, and once again immediately after `mkdirSync`, right before the first byte is
 * written into it. `canonical()`/`isWithin()` are the same realpath-based containment
 * primitives the managed-write guard already uses (`src/guard/workspace-probe.ts`) — they
 * resolve every symlink a path component *actually has*, including one planted after the
 * role passed its kebab-case check but before this call reached it, which a lexical
 * `resolve()`-only comparison cannot see at all.
 *
 * This answers "is the path lexically/structurally where it claims to be", which is a
 * different question from "can someone else change that answer out from under this run" —
 * `assertParentChainNotAttackerWritable` below answers that one.
 */
const assertContained = (workDir: string, target: string): Decision<void> => {
  const canonicalWorkDir = canonical(workDir);
  const canonicalTarget = canonical(target);
  if (!isWithin(canonicalWorkDir, canonicalTarget)) {
    return deny(
      ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
      "repository checkout path escapes the given work directory",
      { workDir, target, canonicalWorkDir, canonicalTarget },
    );
  }
  return allow(ReasonCode.OK, undefined);
};

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
    if (!existsSync(dir)) continue; // not created yet — nothing to own or misconfigure
    const judged = judgeDirectoryOwnership(dir, statSync(dir), myUid);
    if (!judged.allowed) return judged;
  }
  return allow(ReasonCode.OK, undefined);
};

/**
 * Creates `dir` if it does not already exist — one level, never `recursive: true`. A single
 * recursive `mkdirSync` call can silently create *several* missing path components in one
 * shot, including ones that did not exist at precheck time; if a symlink was raced into
 * place anywhere along that path in the meantime, recursive creation tunnels straight
 * through it and writes real directories inside whatever it points to, *before* any
 * post-creation check gets a chance to refuse (CEO review round 4, defect 3b). A plain
 * `mkdirSync(dir)` either creates a fresh, genuine directory atomically, or fails `EEXIST`
 * if anything — including a symlink raced into place — already occupies that exact path; the
 * `lstatSync` fallback below (never `statSync`, which would follow a symlink and inspect its
 * *target* instead of the entry itself) tells the two cases apart and refuses the second.
 *
 * `workDir` and the shared `repositories` directory are created this way; the checkout leaf
 * itself uses the same primitive directly in `produceRepoFactoryResult` as the collision
 * authority (see the comment there for why that matters for same-UID concurrency).
 */
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
 * below without needing a real race).
 */
export const createCheckoutLeafOrDeny = (localRepoPath: string): Decision<void> => {
  try {
    mkdirSync(localRepoPath);
    return allow(ReasonCode.OK, undefined);
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
};

export const ensureDirectoryLevel = (dir: string): Decision<void> => {
  try {
    mkdirSync(dir);
    return allow(ReasonCode.OK, undefined);
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
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(dir);
  } catch (statErr) {
    return deny(
      ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
      "a directory this run needs disappeared between creation and inspection",
      { dir, message: (statErr as Error).message },
    );
  }
  if (!stat.isDirectory()) {
    return deny(
      ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
      "a path this run needs to be a real directory is something else (possibly a symlink raced into place)",
      { dir },
    );
  }
  return allow(ReasonCode.OK, undefined);
};

/**
 * Removes the checkout this call created — and only if containment and the ownership
 * precondition both still hold for it *and* the ownership marker inside it still names this
 * exact operation. Any of those failing means either this call's own write never completed
 * or something else may now be involved with that path; either way this refuses to delete it
 * (Integration §13.3's RESOURCE_COLLISION is the right outcome for an unproven resource, not
 * a guess).
 */
const cleanupOwnedCheckout = (workDir: string, localRepoPath: string, bootstrapOperationId: string): void => {
  const containment = assertContained(workDir, localRepoPath);
  if (!containment.allowed) return;
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
 * observed: `bootstrapVerification[].exactHead` is a real `git rev-parse HEAD` read back
 * after the write, and the `externalWriteReceipt` describes the local git repository this
 * call created, not a GitHub resource it never touched.
 *
 * Things this deliberately refuses to fabricate rather than fill because the schema demands
 * a value:
 *
 *  - a plan that requires a GitHub write (`githubOperations` non-empty) — honestly
 *    receipting that requires performing it, which this producer never does;
 *  - a `bootstrapVerification` PASS when the real local verification command's exit code or
 *    stdout says otherwise, or the tracked-file listing behind the receipt fails — recording
 *    PASS anyway would be a schema-complete lie;
 *  - a checkout path outside `workDir`, even one reached only through a symlink planted
 *    after the plan's own path-shaped fields were validated (`assertContained`), or one a
 *    different-account actor could plant later because it shares write access to a
 *    directory in the chain (`assertParentChainNotAttackerWritable`).
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

  if (plan.githubOperations.length > 0) {
    return deny(
      ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
      "producer cannot honestly receipt GitHub operations without performing a GitHub write, and this producer never performs one (issue #246 boundary)",
      { githubOperations: plan.githubOperations.map((op) => op.operationId) },
    );
  }

  const workDir = resolve(input.workDir);
  const localRepoPath = repositoryCheckoutPath(workDir, plan.repositoryRole);
  const repositoriesDir = dirname(localRepoPath);

  // Fast-path only — refusing early avoids the containment/ownership/creation work below for
  // the common, non-concurrent case. It is NOT the collision authority: see the atomic
  // `mkdirSync(localRepoPath)` further down, which is (CEO review round 4, defect 3b — this
  // system runs multiple same-UID producers concurrently as normal operation, and an
  // `existsSync` check has a gap another process's own creation can land in before this one
  // reads it).
  if (existsSync(localRepoPath)) {
    return deny(
      ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
      "local repository checkout path already exists; a same-named resource with unknown provenance is a collision, not a resume (Integration §13.3)",
      { localRepoPath },
    );
  }

  const precheck = assertContained(workDir, localRepoPath);
  if (!precheck.allowed) return precheck as Decision<RepoFactoryResult>;
  const ownershipPrecheck = assertParentChainNotAttackerWritable(workDir, localRepoPath);
  if (!ownershipPrecheck.allowed) return ownershipPrecheck as Decision<RepoFactoryResult>;

  // `workDir` and `repositories` are created one level at a time, never `recursive: true` —
  // a single recursive call can tunnel through several path components (including one raced
  // into place after the precheck above) before anything checks again. Each step below
  // either creates a fresh, genuine directory or discovers a real, already-existing one;
  // anything else — a symlink raced into place in that exact window — is refused immediately,
  // producing no write inside it, not merely a refusal after the fact.
  for (const dir of [workDir, repositoriesDir]) {
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

  const createdAt = clock.nowIso();

  const init = await git(localRepoPath, ["init", "-b", plan.defaultBranch], { allowFailure: true });
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

  writeFileSync(
    join(localRepoPath, ".repo-factory-bootstrap.json"),
    `${JSON.stringify({ runId: plan.runId, repositoryRole: plan.repositoryRole }, null, 2)}\n`,
  );

  // Only the bootstrap content file is tracked — the ownership marker above is bookkeeping
  // for this function's own retry/cleanup logic, not part of the repository's real content.
  await git(localRepoPath, ["add", ".repo-factory-bootstrap.json"]);
  const commit = await git(
    localRepoPath,
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

  const head = await tryRevParse(localRepoPath, "HEAD");
  if (!head) {
    cleanup();
    return deny(
      ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
      "local repository has no exact HEAD after commit",
      { localRepoPath },
    );
  }

  // The real verification kind this run promises `bootstrapVerification` about. A judge
  // that denies is a genuine observation, not a fabricated one, and it must refuse rather
  // than record PASS regardless.
  const verificationSpec = VERIFICATION_KINDS[plan.verificationKind];
  const verificationRun = await git(localRepoPath, verificationSpec.argv, { allowFailure: true });
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

  const trackedRun = await git(localRepoPath, ["ls-tree", "-r", "--name-only", "HEAD"], { allowFailure: true });
  const tracked = trackedFilesOrDeny(trackedRun);
  if (!tracked.allowed) {
    cleanup();
    return tracked as Decision<RepoFactoryResult>;
  }

  const identity = localRepositoryIdentity(plan.repositoryRole);
  const receipt: ExternalWriteReceipt = {
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
  };

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
    externalWriteReceipts: [receipt],
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

  return allow(ReasonCode.OK, result);
};
