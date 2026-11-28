import type { Db } from "../db/database.ts";
import { type SnapshotPathHistory, candidateSnapshotSchema } from "../snapshot/candidate-snapshot.ts";

/** #1457 — how many of the project's runs are read, newest first, the current run not among them. */
export const PATH_HISTORY_RUN_WINDOW = 50;
/** Earlier runs a blind review returned with a MAJOR or BLOCKER on a path, at or above which the path is over. */
export const PATH_HISTORY_RETURN_THRESHOLD = 2;
/** Earlier runs that went BLOCKED_POST_MERGE having touched a path, at or above which the path is over. */
export const PATH_HISTORY_POST_MERGE_THRESHOLD = 1;
/** Entries kept in the snapshot; the rest are counted in `omitted`. */
export const PATH_HISTORY_MAX_ENTRIES = 20;

/** One touched path's history: how many window runs were returned on it, and how many failed after merge with it. */
export type PathHistoryEntry = SnapshotPathHistory["entries"][number];

export const overPathHistoryThreshold = (entry: PathHistoryEntry): boolean =>
  entry.returnedRuns >= PATH_HISTORY_RETURN_THRESHOLD || entry.postMergeBlockedRuns >= PATH_HISTORY_POST_MERGE_THRESHOLD;

const JUDGED_SEVERITIES = new Set(["MAJOR", "BLOCKER"]);
const keyOf = (repository: string, path: string): string => `${repository}\u0000${path}`;

/**
 * The history of the touched paths in the last `PATH_HISTORY_RUN_WINDOW` runs of the project other than
 * `excludeRunId`, or null when no touched path has any. Read-only.
 *
 * - `returnedRuns`: window runs with a blind-review REVISION_RETURNED_TO_CTO row whose stored BLIND_REVIEW
 *   artifact (named by `reviewArtifactDigest`) holds a MAJOR or BLOCKER finding on that repository and path.
 * - `postMergeBlockedRuns`: window runs with a RUN_TRANSITION to BLOCKED_POST_MERGE whose latest
 *   CANDIDATE_SNAPSHOT lists the path. The whole run is attributed to every path it touched.
 *
 * Each run counts once per path. Entries over a threshold come first, then by count.
 */
export const pathHistory = (
  db: Db,
  input: { projectId: string; excludeRunId: string; touched: ReadonlyArray<{ repository: string; path: string }> },
): SnapshotPathHistory | null => {
  const touched = new Set(input.touched.map((entry) => keyOf(entry.repository, entry.path)));
  if (touched.size === 0) return null;
  const window = JSON.stringify(db.all<{ run_id: string }>(
    `SELECT run_id FROM runs WHERE project_id = ? AND run_id <> ? ORDER BY created_at DESC, run_id DESC LIMIT ?`,
    [input.projectId, input.excludeRunId, PATH_HISTORY_RUN_WINDOW],
  ).map((row) => row.run_id));

  const returned = new Map<string, Set<string>>();
  const blocked = new Map<string, Set<string>>();
  const count = (counts: Map<string, Set<string>>, key: string, runId: string): void => {
    if (!touched.has(key)) return;
    counts.set(key, (counts.get(key) ?? new Set()).add(runId));
  };

  const reviews = db.all<{ run_id: string; content_json: string }>(
    `SELECT a.run_id, r.content_json
       FROM audit_events a
       JOIN run_artifacts r
         ON r.run_id = a.run_id AND r.kind = 'BLIND_REVIEW' AND r.digest = json_extract(a.evidence_json, '$.reviewArtifactDigest')
      WHERE a.run_id IN (SELECT value FROM json_each(?)) AND a.kind = 'REVISION_RETURNED_TO_CTO'
        AND json_extract(a.evidence_json, '$.stage') = 'blind-review'`,
    [window],
  );
  for (const review of reviews) {
    const findings = (JSON.parse(review.content_json) as { findings?: unknown }).findings;
    for (const finding of Array.isArray(findings) ? findings as Array<Record<string, unknown>> : []) {
      if (!JUDGED_SEVERITIES.has(String(finding["severity"]))) continue;
      if (typeof finding["repository"] !== "string" || typeof finding["path"] !== "string") continue;
      count(returned, keyOf(finding["repository"], finding["path"]), review.run_id);
    }
  }

  const blockedRuns = db.all<{ run_id: string }>(
    `SELECT DISTINCT run_id FROM audit_events
      WHERE run_id IN (SELECT value FROM json_each(?)) AND kind = 'RUN_TRANSITION'
        AND json_extract(evidence_json, '$.to') = 'BLOCKED_POST_MERGE'`,
    [window],
  );
  for (const { run_id: runId } of blockedRuns) {
    const latest = db.get<{ content_json: string }>(
      `SELECT content_json FROM run_artifacts WHERE run_id = ? AND kind = 'CANDIDATE_SNAPSHOT'
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [runId],
    );
    const snapshot = latest === undefined ? null : candidateSnapshotSchema.safeParse(JSON.parse(latest.content_json)).data ?? null;
    for (const repository of snapshot?.repositories ?? []) {
      for (const path of repository.touchedPaths) count(blocked, keyOf(repository.identity, path), runId);
    }
  }

  const entries: PathHistoryEntry[] = [...new Set([...returned.keys(), ...blocked.keys()])].map((key) => {
    const [repository, path] = key.split("\u0000") as [string, string];
    return { repository, path, returnedRuns: returned.get(key)?.size ?? 0, postMergeBlockedRuns: blocked.get(key)?.size ?? 0 };
  });
  if (entries.length === 0) return null;
  const rank = (entry: PathHistoryEntry): [number, number] =>
    [overPathHistoryThreshold(entry) ? 1 : 0, entry.returnedRuns + entry.postMergeBlockedRuns];
  entries.sort((a, b) => {
    const [aOver, aCount] = rank(a);
    const [bOver, bCount] = rank(b);
    if (aOver !== bOver) return bOver - aOver;
    if (aCount !== bCount) return bCount - aCount;
    return keyOf(a.repository, a.path) < keyOf(b.repository, b.path) ? -1 : 1;
  });
  return {
    entries: entries.slice(0, PATH_HISTORY_MAX_ENTRIES),
    omitted: Math.max(0, entries.length - PATH_HISTORY_MAX_ENTRIES),
    postMergeAttribution: "RUN",
  };
};
