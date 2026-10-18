import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

import { canonicalJson } from "../../src/core/digest.ts";
import { newArtifactId } from "../../src/core/ids.ts";
import { digestArtifactContent, type StoredArtifact } from "../../src/db/artifacts.ts";
import { installMigrationLedger } from "../../src/db/migrations.ts";

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

/**
 * The v47 freeze: like v45 (#1140) and v46, the released v47 step reads its own frozen snapshot,
 * `src/db/schema-v47.sql`, a byte copy of `schema.sql` at the v47 commit, so a later schema change
 * (v48 onward) cannot change what a database receives at its v47 step. Every value here was measured
 * with the pre-change code, whose `migrations.ts` and `schema.sql` are those of that commit, and is
 * transcribed, not recomputed: a value a run derives from the file it is checking agrees with whatever
 * file it is handed. The one exception is the receipt checksum, which FIX-SEC-R2 changed on purpose (the
 * snapshot did not change); it is transcribed the same way, from that build.
 */
export const V47_FREEZE_BASE_COMMIT = "faa829ec3fecaa5d5aca6cd41160d2f464c4a24f";

export const V47_SNAPSHOT_PATH = "src/db/schema-v47.sql";
/** `git rev-parse faa829ec:src/db/schema.sql`, the v47 canonical source. */
export const V47_SNAPSHOT_GIT_BLOB = "9ca4cad97b1dbf5cbd759d7f11d11b3c7bb9c543";
export const V47_SNAPSHOT_SHA256 = "8c4de11d7ae4d687120196ad9ae73e5b370f6abcc47b9a8b31dc5e69608de487";

/**
 * v47's receipt checksum, in full, since the step refuses canonical labels written before its guard
 * (FIX-SEC-R2, CEO 85eac6ef option B): the snapshot and that refusal's predicate. Transcribed from the
 * build that added the refusal, where `sha256("v47-owner-decision-authority-guard\n" + snapshot +
 * "\nrefused-before-install: " + predicate)` computed outside the code agreed with the step's own value.
 */
export const V47_BASE_CHECKSUM = "sha256:6030b25bbb1ece91d3195a27e8ee703a335863fbd4ab8660c2548dde21eb905b";

/**
 * The receipt checksum of the unreleased candidate v47 (faa829ec to ccc4865f), which installed the guard
 * without that refusal. A database holding it was migrated by the candidate; it is never a released one.
 */
export const V47_CANDIDATE_CHECKSUM = "sha256:f9b2370034620dc56f825fd9119fedd22ba76a46261c64684446992a48958b49";

/**
 * `digestOfSchemaRows` of the database the pre-change build left at v47 from the released chain: from the
 * released v46 image (`releasedChainImage(path, 46)`), from the released v45 image, and from the v11
 * fixture, which runs every step v12–v47. All three reach the same schema, so one value serves them.
 */
export const V47_SCHEMA_DIGEST_FROM_RELEASED_CHAIN =
  "sha256:13b1778f67db771feefdee355247c729b79f7d6283d48641fdcd8f50c969da31";

/** `digestOfSchemaRows` of a fresh database the pre-change build created at v47 (`new Db(path)`). */
export const V47_FRESH_SCHEMA_DIGEST =
  "sha256:5a4dcc90b8c913a1c1e21c1a1150581c8aaa5b93ab9d3a8510fccfd9a0f45c48";

/**
 * A fresh v47 create, made from the snapshot rather than from whatever `schema.sql` holds now. The
 * bootstrap path applies the schema's DDL and then the migration ledger; nothing else it does
 * reaches `sqlite_schema`.
 */
export const freshV47CreateFromSnapshot = (path: string): string => {
  const ddl = readFileSync(new URL(`../../${V47_SNAPSHOT_PATH}`, import.meta.url), "utf8")
    .replace(/^\s*PRAGMA\s+(?:journal_mode|foreign_keys|synchronous)\s*=\s*[^;]+;\s*$/gim, "");
  const raw = new Database(path);
  try {
    raw.exec(ddl);
    installMigrationLedger(raw);
  } finally {
    raw.close();
  }
  return path;
};
