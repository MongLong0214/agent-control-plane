import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    verificationCommandId: z.string().min(1),
    /**
     * A `git` subcommand run for real, inside the repository this producer just created,
     * via the same argv-only `git()` helper the rest of the codebase uses (no shell, so no
     * interpolation). Its real exit code decides `bootstrapVerification`'s status — see
     * `produceRepoFactoryResult` below for why a failure here refuses rather than fabricates.
     */
    verificationArgs: z.array(z.string().min(1)).min(1),
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

/**
 * Removes the checkout this call created — and only if the ownership marker it wrote right
 * after creating it still names this exact operation. A marker that is missing, unreadable,
 * or names a different operation means either this call's own write never completed or
 * something else now owns that path; either way this refuses to delete it (Integration
 * §13.3's RESOURCE_COLLISION is the right outcome for an unproven resource, not a guess).
 */
const cleanupOwnedCheckout = (workDir: string, localRepoPath: string, bootstrapOperationId: string): void => {
  const containment = assertContained(workDir, localRepoPath);
  if (!containment.allowed) return; // never delete through a path that resolves outside workDir
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
 *  - a `bootstrapVerification` PASS when the real local verification command it ran, or the
 *    tracked-file listing behind the receipt, exits non-zero — recording PASS anyway would
 *    be a schema-complete lie;
 *  - a checkout path outside `workDir`, even one reached only through a symlink planted
 *    after the plan's own path-shaped fields were validated.
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
  // against what was actually created before anything is written into it. If a symlink was
  // planted in that window, `localRepoPath` may now resolve outside `workDir` entirely — in
  // which case this refuses without deleting anything, because a recursive remove through a
  // path that escaped containment could destroy something this call never owned.
  const postCreate = assertContained(workDir, localRepoPath);
  if (!postCreate.allowed) return postCreate as Decision<RepoFactoryResult>;

  const operationMarkerPath = join(localRepoPath, OPERATION_MARKER_NAME);
  writeFileSync(operationMarkerPath, `${JSON.stringify({ bootstrapOperationId: plan.bootstrapOperationId })}\n`);
  const cleanup = (): void => cleanupOwnedCheckout(workDir, localRepoPath, plan.bootstrapOperationId);

  const createdAt = clock.nowIso();

  const init = await git(localRepoPath, ["init", "-b", plan.defaultBranch], { allowFailure: true });
  if (init.exitCode !== 0) {
    cleanup();
    return deny(ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT, "local git init failed", {
      stderr: init.stderr,
    });
  }

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

  // The real verification command this run promises `bootstrapVerification` about. A
  // non-zero exit is a genuine observation, not a fabricated one, and it must refuse
  // rather than record PASS regardless.
  const verification = await git(localRepoPath, plan.verificationArgs, { allowFailure: true });
  if (verification.exitCode !== 0) {
    cleanup();
    return deny(
      ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
      "local verification command failed; refusing to record a fabricated PASS",
      { verificationCommandId: plan.verificationCommandId, argv: plan.verificationArgs, stderr: verification.stderr },
    );
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

  const trackedResult = await git(localRepoPath, ["ls-tree", "-r", "--name-only", "HEAD"], { allowFailure: true });
  const tracked = trackedFilesOrDeny(trackedResult);
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
