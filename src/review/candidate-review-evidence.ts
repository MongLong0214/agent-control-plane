import type { Db } from "../db/database.ts";
import { RunKind } from "../domain/types.ts";
import { git } from "../git/git.ts";

const TREE_ENTRY_LIMIT = 2000;

export interface TrackedTreeEvidence {
  repository: string;
  candidateHead: string;
  entryLimit: number;
  truncated: boolean;
  paths: string[];
}

/** The registered repository's frozen objects, never its working tree or current HEAD. */
export const readTrackedTree = async (
  checkoutPath: string,
  repository: string,
  candidateHead: string,
): Promise<TrackedTreeEvidence> => {
  // NUL separation preserves paths containing newlines; JSON below escapes them for the packet.
  // The git wrapper bounds time and output bytes; a read failure refuses review, never a complete list.
  const result = await git(checkoutPath, ["--no-replace-objects", "ls-tree", "-r", "--name-only", "-z", candidateHead]);
  const paths = result.stdout.split("\0").filter(Boolean);
  return { repository, candidateHead, entryLimit: TREE_ENTRY_LIMIT,
    truncated: paths.length > TREE_ENTRY_LIMIT, paths: paths.slice(0, TREE_ENTRY_LIMIT) };
};

/** A projection of canonical records only: no producer text, provider, actor or session identity. */
export const controlPlaneEvidence = (db: Db, runId: string) => ({
  dispatched: db.get(`SELECT 1 FROM audit_events WHERE run_id = ? AND kind = 'DISPATCHED' LIMIT 1`, [runId]) !== undefined,
  // task_id is globally unique; legacy task-scoped bindings may have NULL run_id.
  tasks: db.all<{ taskId: string; category: string; state: string; workerBindingCount: number; activeWorkerBindingCount: number }>(
    `SELECT t.task_id AS taskId, t.category, t.state,
            (SELECT COUNT(*) FROM assignments a
              WHERE a.task_id = t.task_id AND a.role = 'WORKER') AS workerBindingCount,
            (SELECT COUNT(*) FROM assignments a
              WHERE a.task_id = t.task_id AND a.role = 'WORKER' AND a.status = 'ACTIVE') AS activeWorkerBindingCount
       FROM tasks t WHERE t.run_id = ? ORDER BY t.task_id`, [runId]),
  // Match the run's whole owner pin, not whichever CTO happens to be active now. This is the
  // dispatch/renewal delegation, including a historical binding if the owner has since changed.
  owningPrimaryCtoDelegation: db.get(
    `SELECT 1 FROM runs r JOIN assignments a
       ON a.role_key = r.owner_role_key AND a.binding_generation = r.owner_binding_generation
      AND a.session_id = r.owner_session_id AND a.session_incarnation = r.owner_session_incarnation
      AND a.project_id = r.project_id
     WHERE r.run_id = ? AND a.role = 'PRIMARY_CTO'`, [runId]) !== undefined,
});

/** Only run kinds whose COMPLETED authority is the daemon finalizer get these obligations. */
export const laterGateSection = (runKind: string | null, repositoryCount: number): string[] => {
  if (runKind !== RunKind.STANDARD_WORK && runKind !== RunKind.CONTRACT_CHANGE) {
    // src/run/run-engine.ts:1072-1096 routes PROJECT_BOOTSTRAP completion to bootstrap activation,
    // not daemon finalization. Its separate PLAN lifecycle must not inherit these guarantees.
    return ["## Later-gate blockers", "BLOCKER: this run kind has no daemon finalization completion gate; repository publish/PR/CI/merge and post-merge verification are not verified-later obligations here.", ""];
  }
  return [
    "## Obligations verified by later gates, not by this review",
    "These obligations remain pending at this pre-merge review. They are not evidence of completed acceptance criteria.",
    // src/ceo/production-gate.ts:1060-1103 requires a durable CONFIRM of the current candidate;
    // src/daemon/finalizer.ts:443-445 refuses finalization before any write without that decision.
    "- A candidate-bound CEO CONFIRM is required before finalization.",
    ...(repositoryCount === 0 ? [] : [
      // src/daemon/finalizer.ts:247-267 refuses branch publication, PR or gate failure; :366-370
      // refuses merge failure. src/github/github-kernel.ts:2459-2470 requires evaluateMerge;
      // :1941-1953 requires the trusted candidate gate backed by current verification.
      // CI at the merged SHA is mandatory at :3025-3033, :3180-3205 (no declared checks refuses).
      "- For every participating repository, the finalizer must publish the candidate branch, prepare its PR and merge, then verify CI; a failed step prevents completion.",
      // src/github/github-kernel.ts:3036-3049 binds the exact merge SHA to this run's receipt;
      // :3090-3139 reads required checks at that SHA and refuses failed/missing/untrusted checks.
      // src/daemon/finalizer.ts:384-401 calls this before complete and returns on a refusal.
      // src/run/run-engine.ts:1062-1090 refuses COMPLETED without daemon authority and the
      // POST_MERGE_VERIFYING state. Thus none of these obligations is a present PASS assertion.
      "- Post-merge readback must verify the pinned manifest's required trusted checks at the exact merge commit SHA recorded for this run and repository before completion.",
    ]),
    "",
  ];
};

/**
 * #1166 r1 — the listing's serialized size is bounded across the whole packet, not only its entry
 * count: long paths could otherwise fill the review's metadata budget and refuse review for good.
 * Paths are kept in order while the shared budget lasts; a repository cut here is marked truncated.
 */
export const TREE_CHAR_BUDGET = 24_000;

const budgetTrees = (trees: readonly TrackedTreeEvidence[]): TrackedTreeEvidence[] => {
  let used = 0;
  return trees.map((tree) => {
    const kept: string[] = [];
    for (const path of tree.paths) {
      const cost = JSON.stringify(path).length + 8;
      if (used + cost > TREE_CHAR_BUDGET) break;
      used += cost;
      kept.push(path);
    }
    return { ...tree, truncated: tree.truncated || kept.length < tree.paths.length, paths: kept };
  });
};

export const candidateEvidenceSection = (
  db: Db,
  runId: string,
  trees: readonly TrackedTreeEvidence[],
): string[] => [
  "## Frozen candidate tracked trees",
  "Tracked paths at each candidate SHA, including unchanged paths. A truncated listing is incomplete; it cannot establish absence of unlisted paths.",
  "```json", JSON.stringify(budgetTrees(trees), null, 2), "```", "",
  "## Control-plane evidence",
  "Read from canonical audit, task and assignment records. Worker counts include all recorded bindings, with active bindings counted separately.",
  "```json", JSON.stringify(controlPlaneEvidence(db, runId), null, 2), "```", "",
  ...laterGateSection(db.get<{ kind: string }>(`SELECT kind FROM runs WHERE run_id = ?`, [runId])?.kind ?? null, trees.length),
];
