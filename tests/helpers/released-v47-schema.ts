import Database from "better-sqlite3";

import { canonicalJson } from "../../src/core/digest.ts";
import { newArtifactId } from "../../src/core/ids.ts";
import { digestArtifactContent, type StoredArtifact } from "../../src/db/artifacts.ts";

/**
 * SEC-OD1 (v47) — fixtures for the v46 → v47 step and for rows the v47 guard leaves standing.
 *
 * v47 adds one trigger and nothing else, so a v46 image taken back from a database written at v47 or
 * later differs from it by that trigger alone. Historical images for the v47 tests themselves come from
 * the released chain (`releasedChainImage`), never from taking a newer database back.
 */

/** The trigger v47 adds, named here rather than read from the code under test. */
export const V47_ADDED_TRIGGERS = ["run_artifacts_owner_decision_authority_guard"];

/** The sentinel v47's trigger raises. */
export const OWNER_DECISION_WRITE_DENIED = /OWNER_DECISION_WRITE_AUTHORITY_DENIED/;

/** Removes v47's trigger on an open raw connection. `IF EXISTS`, so an older build's database is a no-op. */
export const dropV47Triggers = (raw: Database.Database): void => {
  raw.exec(V47_ADDED_TRIGGERS.map((name) => `DROP TRIGGER IF EXISTS ${name};`).join("\n"));
};

/**
 * An APPROVAL row exactly as `ArtifactStore.put` stored one before v47 (canonical JSON, the store's
 * digest, the "service" label unless another is given), written by a second connection that defines
 * `acp_evidence_write_authorized` itself, to return 1.
 *
 * That connection is v47's stated Limit (CEO 52c3b1e6 (b)): the guard refuses ACP's own `Db.run` and
 * `put`, not a writer that supplies the marker function. Every OWNER_DECISION row recorded before v47
 * looks like this one, so the readers' own checks are still exercised on rows v47 leaves standing. It
 * must not run while ACP's connection holds a write transaction.
 */
export const writeOutsideTheGuard = <T>(
  databasePath: string,
  runId: string,
  content: T,
  candidateSnapshotDigest: string | null,
  createdAt: string,
  producedBy = "service",
): StoredArtifact<T> => {
  const artifact: StoredArtifact<T> = {
    artifactId: newArtifactId(),
    runId,
    kind: "APPROVAL",
    digest: digestArtifactContent("APPROVAL", content, candidateSnapshotDigest),
    candidateSnapshotDigest,
    content,
    producedBy,
    createdAt,
    superseded: false,
  };
  const side = new Database(databasePath);
  try {
    side.function("acp_evidence_write_authorized", () => 1);
    side.prepare(
      `INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
       VALUES (?, ?, 'APPROVAL', ?, ?, ?, ?, ?)`,
    ).run(artifact.artifactId, runId, artifact.digest, candidateSnapshotDigest, canonicalJson(content), producedBy, createdAt);
  } finally {
    side.close();
  }
  return artifact;
};
