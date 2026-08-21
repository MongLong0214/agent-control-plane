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
import { credentialBearingField, prohibitedDurableField } from "./audit.ts";
import type { Db, EvidenceWritePort } from "./database.ts";

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

/** Artifact kinds whose content a later gate treats as authoritative (CP-HI-04, CP-HI-08). */
export type EvidenceKind = "VERIFICATION" | "BLIND_REVIEW" | "PRODUCTION_READY_PACKET";

/**
 * The label written to `produced_by` for each evidence kind, and the value every consumer
 * compares against.
 *
 * It is a *label*, not an authenticator. Authority comes from the writer capability below:
 * a caller that knows the string "verification-engine" cannot write a VERIFICATION row, so
 * `producedBy === EVIDENCE_PRODUCERS.VERIFICATION` on a stored row now proves the engine
 * that owns the kind produced it rather than proving the expected literal was typed.
 */
export const EVIDENCE_PRODUCERS: Readonly<Record<EvidenceKind, string>> = {
  VERIFICATION: "verification-engine",
  BLIND_REVIEW: "blind-review-gate",
  PRODUCTION_READY_PACKET: "production-gate",
};

/** Own-property check, not `in`: `"toString" in EVIDENCE_PRODUCERS` is true. */
export const isEvidenceKind = (kind: string): kind is EvidenceKind =>
  Object.hasOwn(EVIDENCE_PRODUCERS, kind);

/**
 * The only secret in this module. It is never exported and never stored on a token, so the
 * sole route to a constructed capability is `ArtifactStore.issueEvidenceWriters`. Symbol
 * identity — not the description — is what the constructor compares, so re-creating
 * `Symbol("evidence-writer-mint")` elsewhere buys nothing.
 */
const WRITER_MINT: unique symbol = Symbol("evidence-writer-mint");

/**
 * An opaque per-kind writer capability.
 *
 * Exported as a *type only* (`EvidenceWriter`), so no other module can name the
 * constructor. Two independent runtime barriers back that up: `#minted` is a real private
 * field, so a structural literal, a spread copy and `Object.create(proto)` all fail
 * `#minted in value`; and the constructor refuses to run without `WRITER_MINT`, so
 * smuggling the class out through `Object.getPrototypeOf(writer).constructor` yields
 * nothing usable either.
 */
class EvidenceWriterToken<K extends EvidenceKind> {
  readonly #minted = true;

  /**
   * Never read at runtime: it exists so K sits in a contravariant position, which makes a
   * VERIFICATION capability unassignable to `EvidenceWriter<"BLIND_REVIEW">` and turns a
   * cross-kind write into a compile error as well as a runtime refusal.
   */
  declare private readonly bindsKind: (kind: K) => K;

  constructor(mint: symbol, readonly kind: K) {
    if (mint !== WRITER_MINT) {
      fail(
        ReasonCode.COMPLETION_AUTHORITY_DENIED,
        "an evidence writer capability cannot be constructed outside its issuer",
        { kind },
      );
    }
  }

  /** Brand check on the private field: true only for an instance this module constructed. */
  static kindOf(value: unknown): EvidenceKind | null {
    if (typeof value !== "object" || value === null) return null;
    if (!(#minted in value)) return null;
    return value.kind;
  }
}

/**
 * Opaque handle held by the engine that owns one evidence kind. Callers can pass it and
 * store it; they cannot construct, widen or re-kind it.
 */
export type EvidenceWriter<K extends EvidenceKind> = EvidenceWriterToken<K>;

/** The three capabilities, issued together so no kind is ever left unclaimed. */
export interface EvidenceWriterSet {
  readonly VERIFICATION: EvidenceWriter<"VERIFICATION">;
  readonly BLIND_REVIEW: EvidenceWriter<"BLIND_REVIEW">;
  readonly PRODUCTION_READY_PACKET: EvidenceWriter<"PRODUCTION_READY_PACKET">;
}

/**
 * Databases whose writers have been issued, keyed by the database *file*. The file is the
 * resource being protected: keying by `Db` instance let `new ArtifactStore(new Db(samePath))`
 * mint a second set of capabilities for rows the composition root already owned (#352).
 */
const ISSUED_WRITERS = new Set<string>();

// The port is deliberately not a token property: a caller can obtain a token's constructor
// through its prototype, while this module-private map never hands the database marker out.
const EVIDENCE_WRITE_PORTS = new WeakMap<object, EvidenceWritePort>();

/** Artifact kinds that must be bound to an exact candidate (§30.2 #7, CP-HI-06). */
const SNAPSHOT_BOUND: ReadonlySet<string> = new Set([
  "VERIFICATION",
  "BLIND_REVIEW",
  "PRODUCTION_READY_PACKET",
]);

/** Whether an artifact's digest includes its candidate binding as well as its content. */
export const isSnapshotBoundArtifact = (kind: string): boolean => SNAPSHOT_BOUND.has(kind);

/**
 * The one digest formula used both when evidence is stored and when an offline export
 * corroborates it. Keeping this public avoids an exporter reimplementing a subtly weaker
 * formula that covers content but forgets the candidate it is asserting.
 */
export const digestArtifactContent = (
  kind: ArtifactKind,
  content: unknown,
  candidateSnapshotDigest: string | null,
): string =>
  isSnapshotBoundArtifact(kind)
    ? digestOf({ candidateSnapshotDigest, content })
    : digestOf(content);

/** A stored artifact is publishable only if its declared digest still addresses its bytes. */
export const artifactDigestMatches = (
  artifact: Pick<StoredArtifact, "kind" | "content" | "candidateSnapshotDigest" | "digest">,
): boolean =>
  artifact.digest ===
  digestArtifactContent(artifact.kind, artifact.content, artifact.candidateSnapshotDigest);

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

  /**
   * Issues the writer capabilities, once per database.
   *
   * Composition-root only, and enforced rather than documented: the root constructs the
   * store and claims the set before any other component can reach either, so application
   * code, a tool handler or a compromised engine that later gets hold of a store over this
   * database finds the capabilities already spent and cannot mint its own (#70, CP-HI-04).
   */
  issueEvidenceWriters(): EvidenceWriterSet {
    if (ISSUED_WRITERS.has(this.db.identity)) {
      fail(
        ReasonCode.COMPLETION_AUTHORITY_DENIED,
        "evidence writer capabilities were already issued for this database",
        {},
      );
    }
    const writePort = this.db.claimEvidenceWritePort();
    ISSUED_WRITERS.add(this.db.identity);
    // Handed back when the connection closes. Keyed by identity for the same reason the
    // database's own slots are: two names for one inode are one database.
    this.db.releaseOnClose(() => ISSUED_WRITERS.delete(this.db.identity));
    const verification = new EvidenceWriterToken(WRITER_MINT, "VERIFICATION");
    const blindReview = new EvidenceWriterToken(WRITER_MINT, "BLIND_REVIEW");
    const productionReady = new EvidenceWriterToken(WRITER_MINT, "PRODUCTION_READY_PACKET");
    EVIDENCE_WRITE_PORTS.set(verification, writePort);
    EVIDENCE_WRITE_PORTS.set(blindReview, writePort);
    EVIDENCE_WRITE_PORTS.set(productionReady, writePort);
    return {
      VERIFICATION: verification,
      BLIND_REVIEW: blindReview,
      PRODUCTION_READY_PACKET: productionReady,
    };
  }

  /** Non-evidence artifacts: contracts, plans, snapshots, handoffs, receipts. */
  put<T>(
    runId: string,
    kind: ArtifactKind,
    content: T,
    candidateSnapshotDigest?: string | null,
  ): StoredArtifact<T> {
    if (isEvidenceKind(kind)) {
      fail(
        ReasonCode.COMPLETION_AUTHORITY_DENIED,
        `${kind} is evidence and must be written through putEvidence with the writer capability held by ${EVIDENCE_PRODUCERS[kind]}`,
        { runId, kind },
      );
    }
    return this.write(runId, kind, content, candidateSnapshotDigest ?? null, "service");
  }

  /**
   * Writes an evidence artifact. Authority is the capability the caller holds, never a
   * name it supplies: the recorded producer is derived from the capability's kind, so a
   * caller that knows "verification-engine" but holds nothing is refused, and a caller
   * holding one kind's capability cannot write another's (#70).
   */
  putEvidence<K extends EvidenceKind, T>(
    writer: EvidenceWriter<K>,
    runId: string,
    kind: K,
    content: T,
    candidateSnapshotDigest: string,
  ): StoredArtifact<T> {
    if (!isEvidenceKind(kind)) {
      fail(ReasonCode.INVALID_ARGUMENT, `${kind} is not an evidence kind`, { runId, kind });
    }
    const held = EvidenceWriterToken.kindOf(writer);
    if (held === null) {
      fail(
        ReasonCode.COMPLETION_AUTHORITY_DENIED,
        `${kind} requires the writer capability issued to ${EVIDENCE_PRODUCERS[kind]}; the caller holds none`,
        { runId, kind },
      );
    }
    if (held !== kind) {
      fail(
        ReasonCode.COMPLETION_AUTHORITY_DENIED,
        `a ${held} writer may not write ${kind}; only ${EVIDENCE_PRODUCERS[kind]} may`,
        { runId, kind, writerKind: held },
      );
    }
    const writePort = EVIDENCE_WRITE_PORTS.get(writer);
    if (!writePort) {
      fail(
        ReasonCode.COMPLETION_AUTHORITY_DENIED,
        `${kind} requires a writer issued by this artifact store`,
        { runId, kind },
      );
    }
    return this.write(
      runId,
      kind,
      content,
      candidateSnapshotDigest,
      EVIDENCE_PRODUCERS[kind],
      writePort,
    );
  }

  private write<T>(
    runId: string,
    kind: ArtifactKind,
    content: T,
    candidateSnapshotDigest: string | null,
    producedBy: string,
    evidenceWritePort?: EvidenceWritePort,
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

    // Evidence is stored exactly as produced. Rewriting it would make its digest
    // uncorroborable: a later gate compares the report it was handed against the stored
    // row, and CP-HI-06 makes the stored bytes the authority. So content carrying a
    // credential is *refused* rather than quietly altered — §31.5 is satisfied by
    // refusing to store it at all, and the producer is the one that must not include it.
    const credential = credentialBearingField(content);
    if (credential) {
      fail(
        ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED,
        `${kind} contains a credential and cannot be stored as evidence`,
        { runId, kind, field: credential },
      );
    }
    const durableContent = content;
    const digest = digestArtifactContent(kind, durableContent, candidateSnapshotDigest);
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
    const contentJson = canonicalJson(durableContent);
    if (isEvidenceKind(kind)) {
      const writePort = evidenceWritePort ?? fail(
        ReasonCode.COMPLETION_AUTHORITY_DENIED,
        `${kind} requires an evidence writer capability`,
        { runId, kind },
      );
      this.db.insertEvidenceArtifact(writePort, {
        artifactId: artifact.artifactId,
        runId,
        kind,
        digest,
        candidateSnapshotDigest: artifact.candidateSnapshotDigest,
        contentJson,
        producedBy,
        createdAt: artifact.createdAt,
      });
    } else {
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
          contentJson,
          producedBy,
          artifact.createdAt,
        ],
      );
    }
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

const reviewerEgressProbeSchema = z
  .object({
    host: z.string().min(1),
    proxyMode: z.enum(["unset", "override"]).optional(),
    connected: z.boolean().optional(),
    denied: z.boolean().optional(),
    blocked: z.boolean().optional(),
    statusCode: z.number().int().nullable().optional(),
    errorCode: z.string().nullable().optional(),
  })
  .strict();

const reviewerEgressRecordSchema = z
  .object({
    provider: z.string().min(1),
    allowedEndpoints: z.array(z.string().min(1)).min(1),
    allowlistDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    proxyPort: z.number().int().min(1).max(65_535),
    phase: z.enum(["session-bootstrap", "reviewer-invocation"]),
    // The proxy writes these exact JSONL bytes. The review gate validates every line and
    // ArtifactStore rejects a credential-bearing value rather than redacting evidence.
    jsonl: z.string().min(1),
    probes: z
      .object({
        allowedEndpoint: reviewerEgressProbeSchema,
        deniedEndpoint: reviewerEgressProbeSchema,
        directSocket: z.array(reviewerEgressProbeSchema).min(1),
      })
      .strict(),
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
    egressEvidence: z.array(reviewerEgressRecordSchema).min(1),
    inputManifest: z
      .object({
        contract: z.boolean(),
        snapshotManifest: z.boolean(),
        diff: z.boolean(),
        verificationEvidence: z.boolean(),
        projectContext: z.boolean(),
        withheld: z.array(z.string()),
        // A binary change has no textual diff, so the reviewer receives a digest-bound
        // patch artifact instead. Recording which ones were supplied is what separates
        // "reviewed the binary" from "omitted it".
        binaryArtifacts: z.array(
          z
            .object({
              repository: z.string().min(1),
              path: z.string().min(1),
              digest: DIGEST_SCHEMA,
              method: z.literal("git-binary-patch"),
            })
            .strict(),
        ),
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
