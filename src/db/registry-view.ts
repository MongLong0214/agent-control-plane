import type { RegistryView } from "../core/credential-shapes.ts";
import type { Db } from "./database.ts";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const member = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;

const entries = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * The digests a run's PLAN declares for the records it names: its manifest, and each workflow's
 * revision and approved digest. Each is a whole-value field of a stored PLAN.
 */
const planReferences = (plan: unknown): unknown[] => [
  member(plan, "projectManifestDigest"),
  ...entries(member(plan, "workflowRevisions")).map((revision) => member(revision, "fileDigest")),
  ...entries(member(member(plan, "projectManifest"), "ciWorkflows")).map((workflow) => member(workflow, "approvedDigest")),
];

/**
 * The digests of what ACP read for a CONTRACT_CHANGE candidate's review (review/contract-change-review-context.ts):
 * each bound workflow revision's observed bytes and the project's active manifest.
 */
const REVIEW_CONTEXT_SCHEMA = "acp.contract-change-review-context.v1";
const reviewContextReferences = (context: unknown): unknown[] => [
  member(member(context, "project"), "activeManifestDigest"),
  ...entries(member(context, "workflowRevisions")).map((revision) => member(member(revision, "read"), "observedDigest")),
];

/** The digests a stored candidate binds: its contract change's or bootstrap PLAN's, as ACP computed them. */
const candidateReferences = (snapshot: unknown): unknown[] =>
  ["contractChange", "bootstrapPlan"].flatMap((key) => {
    const binding = member(snapshot, key);
    return binding !== null && typeof binding === "object" ? Object.values(binding as Record<string, unknown>) : [];
  });

/**
 * Every digest of a record the run has, read from the store's own rows: each artifact's digest and
 * candidate, the run's contract, pin and current candidate, its project's active manifest, what its
 * PLANs and candidates name by digest, and the workflow bytes ACP read for its review.
 */
const runReferences = (db: Db, runId: string): ReadonlySet<string> => {
  const found = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "string" && DIGEST.test(value)) found.add(value);
  };
  const rows = db.all<{ kind: string; digest: string; candidate_snapshot_digest: string | null; content_json: string | null }>(
    `SELECT kind, digest, candidate_snapshot_digest,
            CASE WHEN kind IN ('PLAN', 'CANDIDATE_SNAPSHOT')
                   OR (kind = 'HANDOFF' AND json_valid(content_json) AND json_extract(content_json, '$.schema') = ?)
                 THEN content_json END AS content_json
       FROM run_artifacts WHERE run_id = ?`,
    [REVIEW_CONTEXT_SCHEMA, runId],
  );
  for (const row of rows) {
    add(row.digest);
    add(row.candidate_snapshot_digest);
    if (row.content_json === null) continue;
    let content: unknown;
    try { content = JSON.parse(row.content_json); } catch { continue; }
    (row.kind === "PLAN" ? planReferences(content) : row.kind === "HANDOFF" ? reviewContextReferences(content) : candidateReferences(content)).forEach(add);
  }
  const run = db.get<{ contract_digest: string | null; pinned_manifest_digest: string | null; current_candidate_digest: string | null; active: string | null }>(
    `SELECT r.contract_digest, r.pinned_manifest_digest, r.current_candidate_digest, p.active_manifest_digest AS active
       FROM runs r LEFT JOIN projects p ON p.project_id = r.project_id WHERE r.run_id = ?`,
    [runId],
  );
  [run?.contract_digest, run?.pinned_manifest_digest, run?.current_candidate_digest, run?.active].forEach(add);
  return found;
};

/**
 * Facts ACP already stored, read from a store's own database: what a stored repository identity,
 * checkout or grant path is checked against before it is read per segment
 * (core/credential-shapes.ts). Read-only. Only locations ACP itself made or registered: the
 * registry's checkouts (the canonical git toplevel it resolved) and the verification engine's own
 * trees (under its configured worktree root). A path a caller or MCP request supplied and ACP only
 * stored, such as a task execution's worktree, is never one. Each is the exact string ACP stored
 * when it resolved or created the location, never resolved again: what is at that path now (a
 * symlink swapped in after registration) does not move the root.
 *
 * `boundReference` answers from the same rows, read once per view (one write): a digest or 64-hex id
 * is a reference only when it is exactly one the store already holds, so naming it in text discloses
 * nothing the store does not already keep. A lookup that fails answers no.
 */
export const registryView = (db: Db): RegistryView => {
  const perRun = new Map<string, ReadonlySet<string>>();
  const ofRun = (runId: string): ReadonlySet<string> => {
    let found = perRun.get(runId);
    if (found === undefined) {
      found = runReferences(db, runId);
      perRun.set(runId, found);
    }
    return found;
  };
  const storedDigest = (runId: string | null, digest: string): boolean =>
    (runId !== null && ofRun(runId).has(digest)) ||
    db.get(`SELECT 1 AS found FROM manifests WHERE digest = ?`, [digest]) !== undefined;
  return {
    records: (identity, checkoutPath) =>
      db.get(`SELECT 1 AS found FROM repositories WHERE identity = ? AND checkout_path = ?`, [identity, checkoutPath]) !== undefined,
    recordsForRun: (runId, identity, checkoutPath) =>
      db.get(
        `SELECT 1 AS found FROM repositories
          WHERE identity = ? AND checkout_path = ?
            AND (temporary_for_run = ? OR project_id = (SELECT project_id FROM runs WHERE run_id = ?))`,
        [identity, checkoutPath, runId, runId],
      ) !== undefined,
    checkoutsOf: (identity) =>
      db.all<{ checkout_path: string }>(`SELECT checkout_path FROM repositories WHERE identity = ?`, [identity])
        .map((row) => row.checkout_path),
    runWorktrees: (runId, identity) =>
      db.all<{ worktree_path: string }>(
        `SELECT worktree_path FROM verification_worktrees WHERE run_id = ? AND repository_identity = ?`, [runId, identity],
      ).map((row) => row.worktree_path),
    boundReference: (runId, token) => {
      try {
        if (DIGEST.test(token)) return storedDigest(runId, token);
        if (!HEX64.test(token)) return false;
        return storedDigest(runId, `sha256:${token}`) ||
          db.get(`SELECT 1 AS found FROM buzz_events WHERE event_id = ?`, [token]) !== undefined;
      } catch {
        return false;
      }
    },
  };
};
