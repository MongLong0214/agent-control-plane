import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { digestOf } from "../core/digest.ts";
import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny, fail } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { changedPaths, diffDigest, git, isClean, revParse, treeOf, tryRevParse } from "../git/git.ts";
import { canonical, isWithin } from "../guard/workspace-probe.ts";

export const CANDIDATE_SNAPSHOT_SCHEMA_ID = "agent-control-plane.candidate-snapshot.v1";

/**
 * S6-C — what a candidate that is not its checkout's HEAD was built from: the SUCCEEDED task results of
 * the run in this repository, integrated onto the run's pinned base in the order listed (the task
 * graph's dependencies first, then task id), and the HEAD the registered checkout stood at when it was
 * frozen. Freshness compares the checkout with that HEAD, because the integrated commit is checked out
 * nowhere (`verifySnapshotFreshness`).
 */
export const snapshotIntegrationSchema = z
  .object({
    checkoutHead: z.string().regex(/^[0-9a-f]{40}$/),
    tasks: z
      .array(z.object({ taskId: z.string().min(1), commit: z.string().regex(/^[0-9a-f]{40}$/) }).strict())
      .min(1),
  })
  .strict();

export type SnapshotIntegration = z.infer<typeof snapshotIntegrationSchema>;

export const snapshotRepositorySchema = z
  .object({
    identity: z.string().min(1),
    repositoryRole: z.string().min(1),
    baseBranch: z.string().min(1),
    baseHead: z.string().regex(/^[0-9a-f]{40}$/),
    /** Present when `baseHead` is a run-recorded immutable task pin, not the live `baseBranch` ref. */
    baseHeadPinned: z.literal(true).optional(),
    /**
     * The branch the candidate was required to be cut from, not the mutable PR
     * target. These remain optional only so pre-lineage snapshot artifacts can be
     * parsed; every snapshot built after this field was introduced writes both.
     */
    sourceBranch: z.string().min(1).nullable().optional(),
    sourceHead: z.string().regex(/^[0-9a-f]{40}$/).nullable().optional(),
    candidateHead: z.string().regex(/^[0-9a-f]{40}$/),
    treeDigest: z.string().min(1),
    diffDigest: z.string().min(1),
    worktreeId: z.string().nullable(),
    manifestDigest: z.string().nullable(),
    touchedPaths: z.array(z.string()),
    /**
     * Present only on an integrated candidate (S6-C). A candidate that is its checkout's HEAD leaves
     * the key out, so its digest is exactly what it was before the field existed.
     */
    integration: snapshotIntegrationSchema.optional(),
  })
  .strict()
  .superRefine((repository, ctx) => {
    const hasSourceBranch = repository.sourceBranch != null;
    const hasSourceHead = repository.sourceHead != null;
    if (hasSourceBranch !== hasSourceHead) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sourceBranch and sourceHead must be recorded together",
        path: hasSourceBranch ? ["sourceHead"] : ["sourceBranch"],
      });
    }
  });

/**
 * Issue #246 PR-C slice C2 — what a project-less PROJECT_BOOTSTRAP candidate is: its run's PLAN, the
 * manifest that PLAN carries and the outputs it plans, each by digest. A bootstrap run joins no
 * repository, so without this every re-plan froze the same empty candidate under the same digest,
 * and a review of one plan answered for the next.
 */
export const snapshotBootstrapPlanSchema = z
  .object({
    planDigest: z.string().min(1),
    projectManifestDigest: z.string().min(1),
    plannedOutputsDigest: z.string().min(1),
  })
  .strict();

export type SnapshotBootstrapPlan = z.infer<typeof snapshotBootstrapPlanSchema>;

/**
 * Issue #246 B2-a — what a CONTRACT_CHANGE candidate changes: its run's PLAN, the manifest that PLAN
 * carries and the base it changes (the run's pinned manifest), each by digest. Present only on a
 * CONTRACT_CHANGE candidate, with or without repositories.
 */
export const snapshotContractChangeSchema = z.union([
  z
    .object({
      planDigest: z.string().min(1),
      manifestDigest: z.string().min(1),
      baseManifestDigest: z.string().min(1),
    })
    .strict(),
  // #512 (v45) — a first activation of an operator-registered NULL project changes no base: the base
  // is null only together with `firstActivation` and the digest of the exact workflow revisions.
  z
    .object({
      planDigest: z.string().min(1),
      manifestDigest: z.string().min(1),
      baseManifestDigest: z.null(),
      firstActivation: z.literal(true),
      workflowRevisionsDigest: z.string().min(1),
    })
    .strict(),
]);

export type SnapshotContractChange = z.infer<typeof snapshotContractChangeSchema>;

export const candidateSnapshotSchema = z
  .object({
    schema: z.literal(CANDIDATE_SNAPSHOT_SCHEMA_ID),
    runId: z.string().min(1),
    contractDigest: z.string().min(1),
    // An empty snapshot is reserved for an administrative run with no participating
    // repositories. Ordinary candidate construction still rejects an empty input below;
    // keeping the schema able to represent the explicit no-op case lets that fact be
    // persisted and re-read by the CEO gate and daemon finalizer.
    repositories: z.array(snapshotRepositorySchema),
    /** Present only on a project-less bootstrap candidate; every other snapshot omits the key. */
    bootstrapPlan: snapshotBootstrapPlanSchema.optional(),
    /** Present only on a CONTRACT_CHANGE candidate; every other snapshot omits the key. */
    contractChange: snapshotContractChangeSchema.optional(),
    createdAt: z.string().min(1),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (snapshot.bootstrapPlan !== undefined && snapshot.contractChange !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a candidate is a bootstrap plan or a contract change, never both",
        path: ["contractChange"],
      });
    }
    for (const duplicate of duplicateRepositoryRoles(snapshot.repositories)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `repositoryRole '${duplicate.repositoryRole}' maps to multiple candidate repositories`,
        path: ["repositories"],
      });
    }
  });

export type SnapshotRepository = z.infer<typeof snapshotRepositorySchema>;

/**
 * S6-C — the HEAD a frozen repository's registered checkout must stand at for its candidate to be
 * fresh: the candidate itself, or, for an integrated candidate, the HEAD the checkout stood at when it
 * was frozen (the integrated commit is checked out nowhere). Every reader that holds the live checkout
 * to a frozen candidate asks this, never `candidateHead` directly, so they cannot disagree.
 */
export const expectedCheckoutHead = (repository: Pick<SnapshotRepository, "candidateHead" | "integration">): string =>
  repository.integration?.checkoutHead ?? repository.candidateHead;
export type CandidateSnapshot = z.infer<typeof candidateSnapshotSchema>;

export interface SnapshotRepositoryInput {
  identity: string;
  repositoryRole: string;
  checkoutPath: string;
  baseBranch: string;
  baseRef?: string;
  /** The base ref is an exact run-recorded commit; freshness must not re-resolve `baseBranch`. */
  baseHeadPinned?: true;
  /** Required branch origin, resolved to its exact SHA as part of the freeze. */
  sourceBranch?: string | null;
  /** The exact origin SHA selected by freeze; this ref is never re-resolved here. */
  sourceHead?: string | null;
  candidateRef?: string;
  worktreeId?: string | null;
  manifestDigest?: string | null;
  /** S6-C — given with `candidateRef` naming the integrated commit; see `snapshotIntegrationSchema`. */
  integration?: SnapshotIntegration;
}

/** A verification command must resolve to exactly one repository identity. */
export const duplicateRepositoryRoles = (
  repositories: readonly Readonly<{ identity: string; repositoryRole: string }>[],
): Array<{ repositoryRole: string; identities: string[] }> => {
  const identitiesByRole = new Map<string, string[]>();
  for (const repository of repositories) {
    const identities = identitiesByRole.get(repository.repositoryRole) ?? [];
    identities.push(repository.identity);
    identitiesByRole.set(repository.repositoryRole, identities);
  }
  return [...identitiesByRole.entries()]
    .filter(([, identities]) => identities.length > 1)
    .map(([repositoryRole, identities]) => ({
      repositoryRole,
      identities: [...new Set(identities)].sort(),
    }));
};

/**
 * PRD §16.1/§16.2 — freeze every participating repository, then verify.
 *
 * The digest deliberately excludes `createdAt`: identity is the exact content of the
 * candidate, so re-freezing an unchanged candidate must produce the same digest,
 * while any moved head, tree, pinned manifest, or frozen source lineage must produce
 * a different one.
 *
 * A bootstrap candidate's PLAN, manifest and planned outputs are part of its identity (#246 C2):
 * a re-plan is a different candidate. A snapshot without `bootstrapPlan` digests exactly the four
 * fields it always did — the key is left out, not set to null — so no existing digest moves. The
 * same holds for a CONTRACT_CHANGE candidate's `contractChange` (#246 B2-a).
 */
export const candidateSnapshotDigest = (snapshot: CandidateSnapshot): string =>
  digestOf({
    schema: snapshot.schema,
    runId: snapshot.runId,
    contractDigest: snapshot.contractDigest,
    repositories: snapshot.repositories,
    ...(snapshot.bootstrapPlan === undefined ? {} : { bootstrapPlan: snapshot.bootstrapPlan }),
    ...(snapshot.contractChange === undefined ? {} : { contractChange: snapshot.contractChange }),
  });

export const buildCandidateSnapshot = async (
  params: {
    runId: string;
    contractDigest: string;
    repositories: readonly SnapshotRepositoryInput[];
    contractChange?: SnapshotContractChange;
  },
  clock: Clock,
): Promise<CandidateSnapshot> => {
  if (params.repositories.length === 0) {
    fail(ReasonCode.EVIDENCE_MISSING, "no repositories");
  }
  const duplicateRoles = duplicateRepositoryRoles(params.repositories);
  if (duplicateRoles.length > 0) {
    fail(ReasonCode.VERIFICATION_GAP, "candidate maps a repository role to more than one identity", {
      duplicateRoles,
    });
  }

  const repositories: SnapshotRepository[] = [];
  for (const input of params.repositories) {
    await assertWorktreeBinding(input);
    const baseHead = await revParse(input.checkoutPath, input.baseRef ?? input.baseBranch);
    const sourceBranch = input.sourceBranch ?? null;
    const sourceHead = input.sourceHead ?? null;
    if ((sourceBranch === null) !== (sourceHead === null)) {
      fail(ReasonCode.INVALID_ARGUMENT, "sourceBranch and sourceHead must be supplied together", {
        identity: input.identity,
        sourceBranch,
        sourceHead,
      });
    }
    const candidateHead = await revParse(input.checkoutPath, input.candidateRef ?? "HEAD");
    repositories.push({
      identity: input.identity,
      repositoryRole: input.repositoryRole,
      baseBranch: input.baseBranch,
      baseHead,
      ...(input.baseHeadPinned === true ? { baseHeadPinned: true as const } : {}),
      sourceBranch,
      sourceHead,
      candidateHead,
      treeDigest: `git-tree:${await treeOf(input.checkoutPath, candidateHead)}`,
      diffDigest: await diffDigest(input.checkoutPath, baseHead, candidateHead),
      worktreeId: input.worktreeId ?? null,
      manifestDigest: input.manifestDigest ?? null,
      touchedPaths: await changedPaths(input.checkoutPath, baseHead, candidateHead),
      ...(input.integration === undefined ? {} : { integration: input.integration }),
    });
  }

  // Deterministic ordering so repository iteration order cannot change the digest.
  repositories.sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));

  return candidateSnapshotSchema.parse({
    schema: CANDIDATE_SNAPSHOT_SCHEMA_ID,
    runId: params.runId,
    contractDigest: params.contractDigest,
    repositories,
    ...(params.contractChange === undefined ? {} : { contractChange: params.contractChange }),
    createdAt: clock.nowIso(),
  });
};

/**
 * Builds the candidate proof for a run whose repository participation set is empty.
 * This is intentionally separate from ordinary candidate construction: source work still
 * needs at least one repository, while a contract/administrative run can have a real,
 * digest-bound candidate that says there is nothing to merge.
 */
export const buildNoRepositoryCandidateSnapshot = (
  params: {
    runId: string;
    contractDigest: string;
    bootstrapPlan?: SnapshotBootstrapPlan;
    contractChange?: SnapshotContractChange;
  },
  clock: Clock,
): CandidateSnapshot =>
  candidateSnapshotSchema.parse({
    schema: CANDIDATE_SNAPSHOT_SCHEMA_ID,
    runId: params.runId,
    contractDigest: params.contractDigest,
    repositories: [],
    ...(params.bootstrapPlan === undefined ? {} : { bootstrapPlan: params.bootstrapPlan }),
    ...(params.contractChange === undefined ? {} : { contractChange: params.contractChange }),
    createdAt: clock.nowIso(),
  });

export interface FreshnessProbe {
  identity: string;
  checkoutPath: string;
  /**
   * #1227 — the resident's clone, when `checkoutPath` is that resident's worker clone
   * (`residentBaseClone`): the base branch is read there as the current base. Only read.
   */
  residentClone?: string | null;
  /**
   * Manifest digest currently active for this repository. §16.2 stales the snapshot when
   * the manifest changes, not only when the candidate head moves.
   */
  activeManifestDigest?: string | null;
}

/**
 * CP-HI-06 — re-reads every frozen repository and reports the exact drift. If one
 * head, tree or manifest moved, the whole snapshot is stale and every piece of
 * evidence bound to it must be discarded, not partially reused.
 */
export const verifySnapshotFreshness = async (
  snapshot: CandidateSnapshot,
  probes: readonly FreshnessProbe[],
): Promise<Decision<CandidateSnapshot>> => {
  const drift: Array<Record<string, unknown>> = [];

  for (const repo of snapshot.repositories) {
    const probe = probes.find((p) => p.identity === repo.identity);
    if (!probe) {
      drift.push({ identity: repo.identity, reason: "repository no longer bound to a checkout" });
      continue;
    }
    // Compare the checkout's *current* tip against the frozen candidate. Resolving
    // the recorded sha would always succeed — the commit still exists after the
    // branch moves on — and would report a moved head as fresh. An integrated candidate
    // (S6-C) is checked out nowhere, so its checkout is held to the HEAD it stood at
    // when frozen; a later turn moves that HEAD, and so stales the candidate.
    const expectedHead = expectedCheckoutHead(repo);
    const head = await tryRevParse(probe.checkoutPath, "HEAD");
    if (head !== expectedHead) {
      drift.push({ identity: repo.identity, expectedHead, observedHead: head });
      continue;
    }
    const tree = `git-tree:${await treeOf(probe.checkoutPath, repo.candidateHead)}`;
    if (tree !== repo.treeDigest) {
      drift.push({ identity: repo.identity, expectedTree: repo.treeDigest, observedTree: tree });
      continue;
    }
    // A branch-derived base must not move. A run-recorded task pin is immutable instead: the worker
    // clone's base branch may intentionally remain older, but the exact pinned object must stay readable.
    const base = await tryRevParse(probe.checkoutPath, repo.baseHeadPinned === true ? repo.baseHead : repo.baseBranch);
    if (base !== repo.baseHead) {
      drift.push({
        identity: repo.identity,
        ...(repo.baseHeadPinned === true ? { reason: "pinned base commit is no longer readable" } : { baseBranch: repo.baseBranch }),
        expectedBaseHead: repo.baseHead,
        observedBaseHead: base,
      });
      continue;
    }
    // #1227 review r2 (PR #1256, D-P2) — a resident's worker clone keeps its base branch where the clone
    // was made, so the check above cannot see the resident move its base. The current base is the
    // resident's base branch in its clone, read only (no ref, no FETCH_HEAD); pinned or not, a candidate
    // whose base is no longer that commit is stale.
    if (probe.residentClone) {
      const current = await tryRevParse(probe.residentClone, `refs/heads/${repo.baseBranch}`);
      if (current !== repo.baseHead) {
        drift.push({
          identity: repo.identity,
          reason: "the resident's base branch no longer names the candidate's base",
          baseBranch: repo.baseBranch,
          expectedBaseHead: repo.baseHead,
          observedBaseHead: current,
        });
        continue;
      }
    }
    // The frozen source SHA, not the moving source branch ref, is the lineage evidence.
    // Advancing that branch after freeze must therefore not rewrite or stale a candidate.
    // And a contract change is drift too: the candidate would be judged by a different bar.
    if (
      probe.activeManifestDigest !== undefined &&
      (probe.activeManifestDigest ?? null) !== repo.manifestDigest
    ) {
      drift.push({
        identity: repo.identity,
        expectedManifestDigest: repo.manifestDigest,
        observedManifestDigest: probe.activeManifestDigest ?? null,
      });
      continue;
    }
    // Uncommitted edits change the source the evidence was produced from, so they
    // invalidate the snapshot just as a moved head does (§16.2).
    if (!(await isClean(probe.checkoutPath))) {
      drift.push({ identity: repo.identity, reason: "working tree has uncommitted changes" });
    }
  }

  if (drift.length > 0) {
    return deny(ReasonCode.SNAPSHOT_STALE, "candidate snapshot no longer matches the repositories", {
      snapshotDigest: candidateSnapshotDigest(snapshot),
      drift,
    });
  }

  return allow(ReasonCode.OK, snapshot, { snapshotDigest: candidateSnapshotDigest(snapshot) });
};

/** Every file touched by the candidate, across every repository (blind-review coverage). */
export const snapshotCoverageTargets = (
  snapshot: CandidateSnapshot,
): Array<{ identity: string; path: string }> =>
  snapshot.repositories.flatMap((repo) =>
    repo.touchedPaths.map((path) => ({ identity: repo.identity, path })),
  );

/**
 * A worktree id is Git's metadata directory name, not an advisory label supplied by a
 * worker. The gitdir marker is written by Git itself and points back to the linked
 * checkout, which lets the snapshot bind the recorded id to the exact tree it reads.
 */
const assertWorktreeBinding = async (input: SnapshotRepositoryInput): Promise<void> => {
  if (input.worktreeId == null) return;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.worktreeId)) {
    fail(ReasonCode.INVALID_ARGUMENT, "worktreeId is not a Git worktree metadata id", {
      worktreeId: input.worktreeId,
    });
  }

  const checkout = canonical(input.checkoutPath);
  const commonDirResult = await git(input.checkoutPath, ["rev-parse", "--git-common-dir"]);
  const commonDir = canonical(resolve(input.checkoutPath, commonDirResult.stdout.trim()));
  const metadataRoot = canonical(join(commonDir, "worktrees"));
  const marker = canonical(join(metadataRoot, input.worktreeId, "gitdir"));
  if (!isWithin(metadataRoot, marker) || !existsSync(marker)) {
    fail(ReasonCode.SNAPSHOT_STALE, "recorded worktree metadata is missing", {
      worktreeId: input.worktreeId,
      checkoutPath: checkout,
    });
  }

  const gitFile = readFileSync(marker, "utf8").trim();
  const recordedCheckout = canonical(dirname(gitFile));
  if (recordedCheckout !== checkout) {
    fail(ReasonCode.SNAPSHOT_STALE, "recorded worktree does not match the checkout", {
      worktreeId: input.worktreeId,
      checkoutPath: checkout,
      recordedCheckout,
    });
  }

  const symbolicHead = await git(input.checkoutPath, ["symbolic-ref", "-q", "HEAD"], {
    allowFailure: true,
  });
  if (symbolicHead.exitCode === 0) {
    fail(ReasonCode.SNAPSHOT_STALE, "recorded candidate worktree is not detached", {
      worktreeId: input.worktreeId,
      checkoutPath: checkout,
      symbolicHead: symbolicHead.stdout.trim(),
    });
  }
  // `-q` makes exit **1** git's answer "HEAD is not a symbolic ref", which is what detached means
  // here. Every other nonzero is a fatal — git uses 128 for all of them, `dubious ownership`
  // included — and reading those as "detached" let this assertion *pass* having observed nothing.
  // That is the worse direction than a wrong refusal: it certifies the property it was asked to
  // check. Found by a merge-gate review as a sibling of the same class in `git()`.
  if (symbolicHead.exitCode !== 1) {
    fail(ReasonCode.SNAPSHOT_STALE, "the candidate worktree's HEAD could not be read", {
      worktreeId: input.worktreeId,
      checkoutPath: checkout,
      exitCode: symbolicHead.exitCode,
    });
  }
};
