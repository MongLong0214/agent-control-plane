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

export const snapshotRepositorySchema = z
  .object({
    identity: z.string().min(1),
    repositoryRole: z.string().min(1),
    baseBranch: z.string().min(1),
    baseHead: z.string().regex(/^[0-9a-f]{40}$/),
    candidateHead: z.string().regex(/^[0-9a-f]{40}$/),
    treeDigest: z.string().min(1),
    diffDigest: z.string().min(1),
    worktreeId: z.string().nullable(),
    manifestDigest: z.string().nullable(),
    touchedPaths: z.array(z.string()),
  })
  .strict();

export const candidateSnapshotSchema = z
  .object({
    schema: z.literal(CANDIDATE_SNAPSHOT_SCHEMA_ID),
    runId: z.string().min(1),
    contractDigest: z.string().min(1),
    repositories: z.array(snapshotRepositorySchema).min(1),
    createdAt: z.string().min(1),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    for (const duplicate of duplicateRepositoryRoles(snapshot.repositories)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `repositoryRole '${duplicate.repositoryRole}' maps to multiple candidate repositories`,
        path: ["repositories"],
      });
    }
  });

export type SnapshotRepository = z.infer<typeof snapshotRepositorySchema>;
export type CandidateSnapshot = z.infer<typeof candidateSnapshotSchema>;

export interface SnapshotRepositoryInput {
  identity: string;
  repositoryRole: string;
  checkoutPath: string;
  baseBranch: string;
  baseRef?: string;
  candidateRef?: string;
  worktreeId?: string | null;
  manifestDigest?: string | null;
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
 * while any moved head, tree or pinned manifest must produce a different one.
 */
export const candidateSnapshotDigest = (snapshot: CandidateSnapshot): string =>
  digestOf({
    schema: snapshot.schema,
    runId: snapshot.runId,
    contractDigest: snapshot.contractDigest,
    repositories: snapshot.repositories,
  });

export const buildCandidateSnapshot = async (
  params: {
    runId: string;
    contractDigest: string;
    repositories: readonly SnapshotRepositoryInput[];
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
    const candidateHead = await revParse(input.checkoutPath, input.candidateRef ?? "HEAD");
    repositories.push({
      identity: input.identity,
      repositoryRole: input.repositoryRole,
      baseBranch: input.baseBranch,
      baseHead,
      candidateHead,
      treeDigest: `git-tree:${await treeOf(input.checkoutPath, candidateHead)}`,
      diffDigest: await diffDigest(input.checkoutPath, baseHead, candidateHead),
      worktreeId: input.worktreeId ?? null,
      manifestDigest: input.manifestDigest ?? null,
      touchedPaths: await changedPaths(input.checkoutPath, baseHead, candidateHead),
    });
  }

  // Deterministic ordering so repository iteration order cannot change the digest.
  repositories.sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));

  return candidateSnapshotSchema.parse({
    schema: CANDIDATE_SNAPSHOT_SCHEMA_ID,
    runId: params.runId,
    contractDigest: params.contractDigest,
    repositories,
    createdAt: clock.nowIso(),
  });
};

export interface FreshnessProbe {
  identity: string;
  checkoutPath: string;
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
    // branch moves on — and would report a moved head as fresh.
    const head = await tryRevParse(probe.checkoutPath, "HEAD");
    if (head !== repo.candidateHead) {
      drift.push({ identity: repo.identity, expectedHead: repo.candidateHead, observedHead: head });
      continue;
    }
    const tree = `git-tree:${await treeOf(probe.checkoutPath, repo.candidateHead)}`;
    if (tree !== repo.treeDigest) {
      drift.push({ identity: repo.identity, expectedTree: repo.treeDigest, observedTree: tree });
      continue;
    }
    // A moved base changes what the diff means, even when the candidate head is untouched.
    const base = await tryRevParse(probe.checkoutPath, repo.baseBranch);
    if (base !== repo.baseHead) {
      drift.push({
        identity: repo.identity,
        baseBranch: repo.baseBranch,
        expectedBaseHead: repo.baseHead,
        observedBaseHead: base,
      });
      continue;
    }
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
};
