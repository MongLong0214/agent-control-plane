import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

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

export interface AnchoredDirectory {
  readonly path: string;
  readonly identity: { readonly dev: number; readonly ino: number };
}

/**
 * CEO review round 3, defect 3 — `assertContained` above closes the window between the
 * containment check and `mkdirSync`, but every operation *after* that (`git init`, the
 * marker write, `commit`, verification, `ls-tree`, …) used to pass the same bare pathname
 * straight through with no re-verification at all. A pathname swapped out from under it at
 * any point after the one check at the top was silently followed — proven directly: a bare
 * `git -C <path>` call given a path that was deleted and replaced with a symlink to
 * elsewhere operates on the symlink's target without complaint.
 *
 * `anchorDirectory` opens `path` once — refusing outright via `O_NOFOLLOW` if it is itself
 * a symlink — and records its device+inode identity. `assertStillAnchored` re-verifies that
 * identity immediately before every subsequent operation, via `lstatSync` (never
 * `statSync`, so a pathname that became a symlink is seen as the symlink, not silently
 * followed). A mismatch means the pathname no longer refers to the exact directory this run
 * created, at any point after it was opened, and every write below refuses rather than
 * operate on whatever now sits there.
 *
 * This is not a full elimination of the race: Node has no binding for the `openat`-family
 * syscalls that would let every later operation go through the already-open fd directly
 * instead of re-resolving the pathname, and this project ships to macOS CI, where `/dev/fd/N`
 * cannot be reopened as a directory or accept an appended subpath (verified directly: both
 * `git -C /dev/fd/N` and a child path under it fail with EBADF/ENOTDIR on Darwin — Linux's
 * `/proc/self/fd/N` supports exactly this, but this project cannot depend on a Linux-only
 * mechanism). Re-verifying immediately before every syscall is the closest real close
 * available in portable Node; it shrinks the window from "the rest of this async function"
 * to the gap between one `lstat` and the operation right after it, and it reliably refuses
 * the attack shape this defect was found with — a swap that happens once and then sits
 * there, which is what a test (and an attacker who is not actively racing this exact
 * process at that instant) produces.
 */
export const anchorDirectory = (path: string): Decision<AnchoredDirectory> => {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    return deny(
      ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
      "could not open the repository checkout as a real directory (it may be a symlink)",
      { path, message: (err as Error).message },
    );
  }
  try {
    const stat = fstatSync(fd);
    return allow(ReasonCode.OK, { path, identity: { dev: stat.dev, ino: stat.ino } });
  } finally {
    closeSync(fd);
  }
};

export const assertStillAnchored = (anchor: AnchoredDirectory): Decision<void> => {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(anchor.path);
  } catch (err) {
    return deny(
      ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
      "repository checkout path disappeared during the run",
      { path: anchor.path, message: (err as Error).message },
    );
  }
  if (stat.dev !== anchor.identity.dev || stat.ino !== anchor.identity.ino) {
    return deny(
      ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
      "repository checkout path no longer refers to the directory this run created — possible symlink swap",
      { path: anchor.path },
    );
  }
  return allow(ReasonCode.OK, undefined);
};

/** Every `git` call after the anchor is taken goes through this, never a bare pathname. */
const gitAnchored = async (
  anchor: AnchoredDirectory,
  args: readonly string[],
  options: { allowFailure?: boolean } = {},
): Promise<Decision<GitResult>> => {
  const stillThere = assertStillAnchored(anchor);
  if (!stillThere.allowed) return stillThere as Decision<GitResult>;
  return allow(ReasonCode.OK, await git(anchor.path, args, options));
};

/** Every file write after the anchor is taken goes through this, never a bare pathname. */
const writeFileAnchored = (
  anchor: AnchoredDirectory,
  relativePath: string,
  content: string,
  flag?: "a",
): Decision<void> => {
  const stillThere = assertStillAnchored(anchor);
  if (!stillThere.allowed) return stillThere;
  writeFileSync(join(anchor.path, relativePath), content, flag ? { flag } : undefined);
  return allow(ReasonCode.OK, undefined);
};

const revParseAnchored = async (anchor: AnchoredDirectory, ref: string): Promise<Decision<string>> => {
  const stillThere = assertStillAnchored(anchor);
  if (!stillThere.allowed) return stillThere as Decision<string>;
  const head = await tryRevParse(anchor.path, ref);
  return head
    ? allow(ReasonCode.OK, head)
    : deny(ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT, "no exact ref could be resolved", {
        path: anchor.path,
        ref,
      });
};

/**
 * Removes the checkout this call created — and only if it is still the exact directory the
 * anchor opened (never a swapped-in replacement) *and* the ownership marker inside it still
 * names this exact operation. Either check failing means either this call's own write never
 * completed or something else now owns that path; either way this refuses to delete it
 * (Integration §13.3's RESOURCE_COLLISION is the right outcome for an unproven resource, not
 * a guess).
 */
const cleanupOwnedCheckout = (anchor: AnchoredDirectory, bootstrapOperationId: string): void => {
  const stillThere = assertStillAnchored(anchor);
  if (!stillThere.allowed) return;
  let marker: unknown;
  try {
    marker = JSON.parse(readFileSync(join(anchor.path, OPERATION_MARKER_NAME), "utf8"));
  } catch {
    return;
  }
  if ((marker as { bootstrapOperationId?: unknown }).bootstrapOperationId !== bootstrapOperationId) return;
  rmSync(anchor.path, { recursive: true, force: true });
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
 *    after the plan's own path-shaped fields were validated, or one swapped in after the
 *    checkout directory was created (see `assertContained` / `anchorDirectory`).
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
  if (existsSync(localRepoPath)) {
    return deny(
      ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
      "local repository checkout path already exists; a same-named resource with unknown provenance is a collision, not a resume (Integration §13.3)",
      { localRepoPath },
    );
  }

  const precheck = assertContained(workDir, localRepoPath);
  if (!precheck.allowed) return precheck as Decision<RepoFactoryResult>;

  mkdirSync(localRepoPath, { recursive: true });

  // Closes the TOCTOU window between the check above and this write: re-verify the boundary
  // against what was actually created before anything is written into it.
  const postCreate = assertContained(workDir, localRepoPath);
  if (!postCreate.allowed) return postCreate as Decision<RepoFactoryResult>;

  const anchored = anchorDirectory(localRepoPath);
  if (!anchored.allowed) return anchored as Decision<RepoFactoryResult>;
  const anchor = anchored.value;

  const markerWrite = writeFileAnchored(
    anchor,
    OPERATION_MARKER_NAME,
    `${JSON.stringify({ bootstrapOperationId: plan.bootstrapOperationId })}\n`,
  );
  if (!markerWrite.allowed) return markerWrite as Decision<RepoFactoryResult>;
  const cleanup = (): void => cleanupOwnedCheckout(anchor, plan.bootstrapOperationId);

  const createdAt = clock.nowIso();

  const init = await gitAnchored(anchor, ["init", "-b", plan.defaultBranch], { allowFailure: true });
  if (!init.allowed) {
    cleanup();
    return init as Decision<RepoFactoryResult>;
  }
  if (init.value.exitCode !== 0) {
    cleanup();
    return deny(ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT, "local git init failed", {
      stderr: init.value.stderr,
    });
  }

  // CEO review round 3, defect 2's other half: the ownership marker is deliberately never
  // committed, so a plain `git status` reports it as untracked — provably dirty, not clean.
  // `.git/info/exclude` is git's own mechanism for "ignored in this local repository without
  // committing a .gitignore for it", and is exactly what this marker is: this run's own
  // bookkeeping, not part of the repository's real content. Tested directly in
  // `tests/unit/repo-factory-producer.test.ts` by running real `git status --porcelain`
  // against a produced repository and asserting its output is empty.
  const excludeWrite = writeFileAnchored(anchor, join(".git", "info", "exclude"), `${OPERATION_MARKER_NAME}\n`, "a");
  if (!excludeWrite.allowed) {
    cleanup();
    return excludeWrite as Decision<RepoFactoryResult>;
  }

  const bootstrapFileWrite = writeFileAnchored(
    anchor,
    ".repo-factory-bootstrap.json",
    `${JSON.stringify({ runId: plan.runId, repositoryRole: plan.repositoryRole }, null, 2)}\n`,
  );
  if (!bootstrapFileWrite.allowed) {
    cleanup();
    return bootstrapFileWrite as Decision<RepoFactoryResult>;
  }

  // Only the bootstrap content file is tracked — the ownership marker above is bookkeeping
  // for this function's own retry/cleanup logic, not part of the repository's real content.
  const added = await gitAnchored(anchor, ["add", ".repo-factory-bootstrap.json"]);
  if (!added.allowed) {
    cleanup();
    return added as Decision<RepoFactoryResult>;
  }
  const commit = await gitAnchored(
    anchor,
    [
      "-c", "user.email=repo-factory@local",
      "-c", "user.name=Repo Factory",
      "commit", "-m", "repo factory bootstrap",
    ],
    { allowFailure: true },
  );
  if (!commit.allowed) {
    cleanup();
    return commit as Decision<RepoFactoryResult>;
  }
  if (commit.value.exitCode !== 0) {
    cleanup();
    return deny(
      ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
      "local bootstrap commit failed; refusing to fabricate a result without a real commit",
      { stderr: commit.value.stderr },
    );
  }

  const headResult = await revParseAnchored(anchor, "HEAD");
  if (!headResult.allowed) {
    cleanup();
    return headResult as Decision<RepoFactoryResult>;
  }
  const head = headResult.value;

  // The real verification kind this run promises `bootstrapVerification` about. A judge
  // that denies is a genuine observation, not a fabricated one, and it must refuse rather
  // than record PASS regardless.
  const verificationSpec = VERIFICATION_KINDS[plan.verificationKind];
  const verificationRun = await gitAnchored(anchor, verificationSpec.argv, { allowFailure: true });
  if (!verificationRun.allowed) {
    cleanup();
    return verificationRun as Decision<RepoFactoryResult>;
  }
  const verificationJudged = verificationSpec.judge(verificationRun.value);
  if (!verificationJudged.allowed) {
    cleanup();
    return verificationJudged as Decision<RepoFactoryResult>;
  }

  const rereadAt = clock.nowIso();
  const rereadResult = await revParseAnchored(anchor, "HEAD");
  if (!rereadResult.allowed) {
    cleanup();
    return rereadResult as Decision<RepoFactoryResult>;
  }
  if (rereadResult.value !== head) {
    cleanup();
    return deny(
      ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
      "local repository HEAD changed between write and post-write re-read",
      { localRepoPath: anchor.path, head, rereadHead: rereadResult.value },
    );
  }

  const trackedRun = await gitAnchored(anchor, ["ls-tree", "-r", "--name-only", "HEAD"], { allowFailure: true });
  if (!trackedRun.allowed) {
    cleanup();
    return trackedRun as Decision<RepoFactoryResult>;
  }
  const tracked = trackedFilesOrDeny(trackedRun.value);
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
        proposedCheckoutPath: anchor.path,
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
