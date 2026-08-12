import { z } from "zod";

import { digestOf } from "../core/digest.ts";
import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { changedPaths, diffDigest, isClean, revParse, treeOf, tryRevParse } from "../git/git.ts";

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
  .strict();

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
    return deny(ReasonCode.EVIDENCE_MISSING, "no repositories") as never;
  }

  const repositories: SnapshotRepository[] = [];
  for (const input of params.repositories) {
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
