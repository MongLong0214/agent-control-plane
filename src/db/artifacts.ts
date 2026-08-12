import { z } from "zod";

import type { Clock } from "../core/clock.ts";
import { canonicalJson, digestOf, isDigest } from "../core/digest.ts";
import { newArtifactId } from "../core/ids.ts";
import { fail } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { ArtifactKind } from "../domain/types.ts";
import {
  candidateSnapshotDigest as digestCandidateSnapshot,
  candidateSnapshotSchema,
} from "../snapshot/candidate-snapshot.ts";
import { prohibitedDurableField, redact } from "./audit.ts";
import type { Db } from "./database.ts";

export interface StoredArtifact<T = unknown> {
  artifactId: string;
  runId: string;
  kind: ArtifactKind;
  digest: string;
  candidateSnapshotDigest: string | null;
  content: T;
  /** Trusted component that wrote this artifact; part of the evidence, not decoration. */
  producedBy: string;
  createdAt: string;
  superseded: boolean;
}

/**
 * Components permitted to write each evidence kind. Passing an arbitrary JSON blob as a
 * verification or review result would let any caller mint a PASS, so those kinds are
 * written only through `putEvidence` and only by the engine that owns them (CP-HI-04,
 * CP-HI-08).
 */
export const EVIDENCE_PRODUCERS: Readonly<Record<string, string>> = {
  VERIFICATION: "verification-engine",
  BLIND_REVIEW: "blind-review-gate",
  PRODUCTION_READY_PACKET: "production-gate",
};

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

  /** Non-evidence artifacts: contracts, plans, snapshots, handoffs, receipts. */
  put<T>(
    runId: string,
    kind: ArtifactKind,
    content: T,
    candidateSnapshotDigest?: string | null,
  ): StoredArtifact<T> {
    if (kind in EVIDENCE_PRODUCERS) {
      fail(
        ReasonCode.COMPLETION_AUTHORITY_DENIED,
        `${kind} is evidence and must be written through putEvidence by ${EVIDENCE_PRODUCERS[kind]}`,
        { runId, kind },
      );
    }
    return this.write(runId, kind, content, candidateSnapshotDigest ?? null, "service");
  }

  /**
   * Writes an evidence artifact on behalf of the component that owns that kind. The
   * producer is recorded and checked, so the gate can distinguish engine output from a
   * blob some other caller assembled.
   */
  putEvidence<T>(
    producer: string,
    runId: string,
    kind: ArtifactKind,
    content: T,
    candidateSnapshotDigest: string,
  ): StoredArtifact<T> {
    const expected = EVIDENCE_PRODUCERS[kind];
    if (!expected) {
      fail(ReasonCode.INVALID_ARGUMENT, `${kind} is not an evidence kind`, { runId, kind });
    }
    if (expected !== producer) {
      fail(
        ReasonCode.COMPLETION_AUTHORITY_DENIED,
        `${producer} may not write ${kind}; only ${expected} may`,
        { runId, kind, producer },
      );
    }
    return this.write(runId, kind, content, candidateSnapshotDigest, producer);
  }

  private write<T>(
    runId: string,
    kind: ArtifactKind,
    content: T,
    candidateSnapshotDigest: string | null,
    producedBy: string,
  ): StoredArtifact<T> {
    if (SNAPSHOT_BOUND.has(kind) && !candidateSnapshotDigest) {
      fail(
        ReasonCode.EVIDENCE_MISSING,
        `${kind} artifact requires a candidate snapshot digest`,
        { runId, kind },
      );
    }
    this.validateContent(runId, kind, content, candidateSnapshotDigest);
    const prohibited = prohibitedDurableField(content);
    if (prohibited) {
      fail(
        ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED,
        `${kind} contains prohibited private bulk content`,
        { runId, kind, field: prohibited },
      );
    }

    // Redact before both hashing and serializing. A returned digest is therefore a
    // digest of exactly the durable representation, never a secret-bearing input.
    const durableContent = redact(content) as T;
    const digest = SNAPSHOT_BOUND.has(kind)
      ? digestOf({ candidateSnapshotDigest, content: durableContent })
      : digestOf(durableContent);
    const existing = this.db.get<RawArtifact>(
      `SELECT * FROM run_artifacts
        WHERE run_id = ? AND kind = ? AND digest = ? AND candidate_snapshot_digest IS ?`,
      [runId, kind, digest, candidateSnapshotDigest],
    );
    if (existing) return hydrate<T>(existing);

    const artifact: StoredArtifact<T> = {
      artifactId: newArtifactId(),
      runId,
      kind,
      digest,
      candidateSnapshotDigest: candidateSnapshotDigest ?? null,
      content: durableContent,
      producedBy,
      createdAt: this.clock.nowIso(),
      superseded: false,
    };
    this.db.run(
      `INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest,
                                  content_json, produced_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        artifact.artifactId,
        runId,
        kind,
        digest,
        artifact.candidateSnapshotDigest,
        canonicalJson(durableContent),
        producedBy,
        artifact.createdAt,
      ],
    );
    return artifact;
  }

  private validateContent(
    runId: string,
    kind: ArtifactKind,
    content: unknown,
    candidateSnapshotDigest: string | null,
  ): void {
    if (kind === "CANDIDATE_SNAPSHOT") {
      const parsed = candidateSnapshotSchema.safeParse(content);
      const snapshotContent = parsed.data ?? fail(
        ReasonCode.INVALID_ARGUMENT,
        "candidate snapshot is malformed or belongs to another run",
        { runId, kind },
      );
      if (snapshotContent.runId !== runId) {
        fail(ReasonCode.INVALID_ARGUMENT, "candidate snapshot is malformed or belongs to another run", {
          runId,
          kind,
        });
      }
      if (!candidateSnapshotDigest || !isDigest(candidateSnapshotDigest)) {
        fail(ReasonCode.SNAPSHOT_DIGEST_MISMATCH, "candidate snapshot requires a sha256 digest", {
          runId,
          kind,
          candidateSnapshotDigest,
        });
      }
      if (digestCandidateSnapshot(snapshotContent) !== candidateSnapshotDigest) {
        fail(ReasonCode.SNAPSHOT_DIGEST_MISMATCH, "candidate snapshot digest does not address its content", {
          runId,
          candidateSnapshotDigest,
        });
      }
      return;
    }

    if (!SNAPSHOT_BOUND.has(kind)) return;
    if (!candidateSnapshotDigest || !isDigest(candidateSnapshotDigest)) {
      fail(ReasonCode.SNAPSHOT_DIGEST_MISMATCH, `${kind} requires a sha256 candidate digest`, {
        runId,
        kind,
        candidateSnapshotDigest,
      });
    }

    const schema = EVIDENCE_SCHEMAS[kind as keyof typeof EVIDENCE_SCHEMAS];
    const parsed = schema.safeParse(content);
    const evidenceContent = parsed.data ?? fail(
      ReasonCode.INVALID_ARGUMENT,
      `${kind} has an invalid evidence envelope`,
      { runId, kind },
    );
    if (evidenceContent.runId !== runId) {
      fail(ReasonCode.INVALID_ARGUMENT, `${kind} has an invalid evidence envelope`, {
        runId,
        kind,
      });
    }
    if (evidenceContent.candidateSnapshotDigest !== candidateSnapshotDigest) {
      fail(ReasonCode.SNAPSHOT_DIGEST_MISMATCH, `${kind} content is bound to another candidate`, {
        runId,
        kind,
        contentCandidateSnapshotDigest: evidenceContent.candidateSnapshotDigest,
        candidateSnapshotDigest,
      });
    }

    const snapshot = this.db.get<{ artifact_id: string }>(
      `SELECT artifact_id FROM run_artifacts
        WHERE run_id = ? AND kind = 'CANDIDATE_SNAPSHOT' AND candidate_snapshot_digest = ?`,
      [runId, candidateSnapshotDigest],
    );
    if (!snapshot) {
      fail(ReasonCode.EVIDENCE_MISSING, "evidence names no stored candidate snapshot for this run", {
        runId,
        kind,
        candidateSnapshotDigest,
      });
    }
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
  produced_by: string;
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
  producedBy: row.produced_by,
  createdAt: row.created_at,
  superseded: row.superseded === 1,
});

const DIGEST_SCHEMA = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const verificationEvidenceSchema = z
  .object({
    runId: z.string().min(1),
    candidateSnapshotDigest: DIGEST_SCHEMA,
    contractDigest: z.string().min(1),
    expectedInputs: z.number().int().nonnegative(),
    observedInputs: z.number().int().nonnegative(),
    results: z.array(z.object({}).passthrough()),
    status: z.enum(["PASS", "FAIL", "INCOMPLETE"]),
    reasonCode: z.string().min(1),
    gaps: z.array(z.string()),
  })
  .strict();

const blindReviewEvidenceSchema = z
  .object({
    runId: z.string().min(1),
    candidateSnapshotDigest: DIGEST_SCHEMA,
    contractDigest: z.string().min(1),
    reviewerRoleBindingGeneration: z.number().int().positive(),
    reviewerSessionId: z.string().min(1),
    reviewerSessionIncarnation: z.string().min(1),
    reviewerProviderSessionId: z.string().nullable(),
    provider: z.string().min(1),
    model: z.string().min(1),
    effort: z.string().nullable(),
    inputManifest: z
      .object({
        contract: z.boolean(),
        snapshotManifest: z.boolean(),
        diff: z.boolean(),
        verificationEvidence: z.boolean(),
        projectContext: z.boolean(),
        withheld: z.array(z.string()),
      })
      .strict(),
    coveredRepositories: z.array(z.string()),
    coveredFiles: z.array(z.string()),
    omittedItems: z.array(z.string()),
    verdict: z.enum(["PASS", "REVISE", "BLOCK"]),
    findings: z.array(z.object({}).passthrough()),
    chunked: z.boolean(),
    createdAt: z.string().min(1),
  })
  .strict();

const productionReadyEvidenceSchema = z
  .object({
    runId: z.string().min(1),
    projectId: z.string().nullable(),
    goal: z.string(),
    resultSummary: z.string(),
    candidateSnapshotDigest: DIGEST_SCHEMA,
    verification: z.object({}).passthrough(),
    blindReview: z.object({}).passthrough(),
    knownResidualRisk: z.array(z.string()),
    changedRepositories: z.array(z.object({}).passthrough()),
    ctoRecommendation: z.string(),
    humanGate: z.object({}).passthrough(),
    createdAt: z.string().min(1),
  })
  .strict();

const EVIDENCE_SCHEMAS = {
  VERIFICATION: verificationEvidenceSchema,
  BLIND_REVIEW: blindReviewEvidenceSchema,
  PRODUCTION_READY_PACKET: productionReadyEvidenceSchema,
} as const;
