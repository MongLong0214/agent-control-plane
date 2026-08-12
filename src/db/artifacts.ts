import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { newArtifactId } from "../core/ids.ts";
import { fail } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { ArtifactKind } from "../domain/types.ts";
import type { Db } from "./database.ts";

export interface StoredArtifact<T = unknown> {
  artifactId: string;
  runId: string;
  kind: ArtifactKind;
  digest: string;
  candidateSnapshotDigest: string | null;
  content: T;
  createdAt: string;
  superseded: boolean;
}

/** Artifact kinds that must be bound to an exact candidate (§30.2 #7, CP-HI-06). */
const SNAPSHOT_BOUND: ReadonlySet<string> = new Set([
  "VERIFICATION",
  "BLIND_REVIEW",
  "PRODUCTION_READY_PACKET",
]);

/**
 * Typed immutable artifact store (PRD §30.1). Content is addressed by its canonical
 * digest, and the row-level trigger makes rewriting an artifact impossible — evidence
 * that could be edited after the fact is not evidence.
 */
export class ArtifactStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  put<T>(
    runId: string,
    kind: ArtifactKind,
    content: T,
    candidateSnapshotDigest?: string | null,
  ): StoredArtifact<T> {
    if (SNAPSHOT_BOUND.has(kind) && !candidateSnapshotDigest) {
      fail(
        ReasonCode.EVIDENCE_MISSING,
        `${kind} artifact requires a candidate snapshot digest`,
        { runId, kind },
      );
    }
    const digest = digestOf(content);
    const existing = this.db.get<RawArtifact>(
      `SELECT * FROM run_artifacts WHERE run_id = ? AND kind = ? AND digest = ?`,
      [runId, kind, digest],
    );
    if (existing) return hydrate<T>(existing);

    const artifact: StoredArtifact<T> = {
      artifactId: newArtifactId(),
      runId,
      kind,
      digest,
      candidateSnapshotDigest: candidateSnapshotDigest ?? null,
      content,
      createdAt: this.clock.nowIso(),
      superseded: false,
    };
    this.db.run(
      `INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest,
                                  content_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        artifact.artifactId,
        runId,
        kind,
        digest,
        artifact.candidateSnapshotDigest,
        JSON.stringify(content),
        artifact.createdAt,
      ],
    );
    return artifact;
  }

  latest<T>(runId: string, kind: ArtifactKind): StoredArtifact<T> | null {
    const row = this.db.get<RawArtifact>(
      `SELECT * FROM run_artifacts WHERE run_id = ? AND kind = ? AND superseded = 0
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [runId, kind],
    );
    return row ? hydrate<T>(row) : null;
  }

  /** Latest artifact of a kind that is bound to a specific candidate snapshot. */
  latestForSnapshot<T>(
    runId: string,
    kind: ArtifactKind,
    candidateSnapshotDigest: string,
  ): StoredArtifact<T> | null {
    const row = this.db.get<RawArtifact>(
      `SELECT * FROM run_artifacts
        WHERE run_id = ? AND kind = ? AND candidate_snapshot_digest = ? AND superseded = 0
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [runId, kind, candidateSnapshotDigest],
    );
    return row ? hydrate<T>(row) : null;
  }

  list<T>(runId: string, kind?: ArtifactKind): StoredArtifact<T>[] {
    const rows = kind
      ? this.db.all<RawArtifact>(
          `SELECT * FROM run_artifacts WHERE run_id = ? AND kind = ? ORDER BY created_at, rowid`,
          [runId, kind],
        )
      : this.db.all<RawArtifact>(
          `SELECT * FROM run_artifacts WHERE run_id = ? ORDER BY created_at, rowid`,
          [runId],
        );
    return rows.map((row) => hydrate<T>(row));
  }

  byDigest<T>(digest: string): StoredArtifact<T> | null {
    const row = this.db.get<RawArtifact>(
      `SELECT * FROM run_artifacts WHERE digest = ? ORDER BY rowid LIMIT 1`,
      [digest],
    );
    return row ? hydrate<T>(row) : null;
  }

  /**
   * Marks every artifact of a kind bound to a superseded candidate as stale. Content
   * stays immutable — only the "is this still current" flag moves (§34.4).
   */
  supersedeForOtherSnapshots(
    runId: string,
    kind: ArtifactKind,
    currentSnapshotDigest: string,
  ): number {
    return this.db.run(
      `UPDATE run_artifacts SET superseded = 1
        WHERE run_id = ? AND kind = ? AND candidate_snapshot_digest IS NOT ?
          AND superseded = 0`,
      [runId, kind, currentSnapshotDigest],
    ).changes;
  }
}

interface RawArtifact {
  artifact_id: string;
  run_id: string;
  kind: ArtifactKind;
  digest: string;
  candidate_snapshot_digest: string | null;
  content_json: string;
  created_at: string;
  superseded: number;
}

const hydrate = <T>(row: RawArtifact): StoredArtifact<T> => ({
  artifactId: row.artifact_id,
  runId: row.run_id,
  kind: row.kind,
  digest: row.digest,
  candidateSnapshotDigest: row.candidate_snapshot_digest,
  content: JSON.parse(row.content_json) as T,
  createdAt: row.created_at,
  superseded: row.superseded === 1,
});
