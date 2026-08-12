import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";

import { canonicalJson, digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ArtifactKind } from "../../src/domain/types.ts";
import {
  CANDIDATE_SNAPSHOT_SCHEMA_ID,
  candidateSnapshotDigest,
  type CandidateSnapshot,
} from "../../src/snapshot/candidate-snapshot.ts";
import { Db } from "../../src/db/database.ts";
import { cleanupTempDirs, makeCore, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const insertRun = (db: Db, runId: string, createdAt = "2026-08-12T00:00:00.000Z"): void => {
  db.run(
    `INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
     VALUES (?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'QUEUED', 'fixture', 'sha256:contract', ?)`,
    [runId, createdAt],
  );
};

const candidateFor = (runId: string): CandidateSnapshot => ({
  schema: CANDIDATE_SNAPSHOT_SCHEMA_ID,
  runId,
  contractDigest: "sha256:contract",
  repositories: [{
    identity: "github:acme/fixture",
    repositoryRole: "primary",
    baseBranch: "main",
    baseHead: "a".repeat(40),
    candidateHead: "b".repeat(40),
    treeDigest: "git-tree:fixture",
    diffDigest: "sha256:fixture",
    worktreeId: null,
    manifestDigest: null,
    touchedPaths: ["src/app.ts"],
  }],
  createdAt: "2026-08-12T00:00:00.000Z",
});

const verificationFor = (runId: string, digest: string) => ({
  runId,
  candidateSnapshotDigest: digest,
  contractDigest: "sha256:contract",
  expectedInputs: 1,
  observedInputs: 1,
  results: [],
  status: "PASS" as const,
  reasonCode: "OK",
  gaps: [],
});

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected operation to throw");
};

const candidateRun = () => {
  const core = makeCore();
  const runId = "run_candidate";
  insertRun(core.db, runId);
  const snapshot = candidateFor(runId);
  const digest = candidateSnapshotDigest(snapshot);
  core.artifacts.put(runId, ArtifactKind.CANDIDATE_SNAPSHOT, snapshot, digest);
  return { ...core, runId, digest };
};

describe("round-2 database and evidence regressions", () => {
  it("#65 poisons a rejected async transaction before its continuation can autocommit", async () => {
    const path = join(tempDir("acp-async-tx-"), "state.sqlite");
    const db = new Db(path);
    let continuation: Promise<void> | null = null;

    expect(() =>
      db.tx((() => {
        continuation = (async () => {
          await Promise.resolve();
          db.run("CREATE TABLE escaped_async_write (id INTEGER)");
        })();
        return continuation as unknown as void;
      }) as () => void),
    ).toThrowError(/transaction bodies must be synchronous/);

    await expect(continuation!).rejects.toMatchObject({ reasonCode: ReasonCode.INTERNAL_ERROR });
    expect(db.inTransaction).toBe(false);

    const reopened = new Db(path);
    expect(
      reopened.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'escaped_async_write'",
      )?.n,
    ).toBe(0);
    reopened.close();
  });

  it("#66 rejects a QUEUED-to-COMPLETED raw state bypass and terminal mutation", () => {
    const { db } = makeCore();
    insertRun(db, "run_state");

    expect(() => db.run("UPDATE runs SET state = 'COMPLETED' WHERE run_id = 'run_state'")).toThrowError(
      /RUN_STATE_TRANSITION_ILLEGAL/,
    );
    db.run("UPDATE runs SET state = 'ACTIVE' WHERE run_id = 'run_state'");
    db.run("UPDATE runs SET state = 'READY_FOR_CEO_REVIEW' WHERE run_id = 'run_state'");
    db.run("UPDATE runs SET state = 'COMPLETED' WHERE run_id = 'run_state'");
    expect(() => db.run("UPDATE runs SET state = 'ACTIVE' WHERE run_id = 'run_state'")).toThrowError(
      /RUN_STATE_TRANSITION_ILLEGAL/,
    );
  });

  it("#67 allows the first contract pin but rejects replacement", () => {
    const { db } = makeCore();
    db.run("INSERT INTO manifests (digest, schema_id, content_json, created_at) VALUES ('sha256:strong', 'm', '{}', 't')");
    db.run("INSERT INTO manifests (digest, schema_id, content_json, created_at) VALUES ('sha256:weak', 'm', '{}', 't')");
    insertRun(db, "run_pin");
    db.run("UPDATE runs SET pinned_manifest_digest = 'sha256:strong' WHERE run_id = 'run_pin'");

    expect(() =>
      db.run("UPDATE runs SET pinned_manifest_digest = 'sha256:weak' WHERE run_id = 'run_pin'"),
    ).toThrowError(/PINNED_MANIFEST_IMMUTABLE/);
  });

  it("#68 refuses an owner tuple that combines a session with another binding", () => {
    const { db } = makeCore();
    db.run("INSERT INTO projects (project_id, name, created_at) VALUES ('p', 'p', 't')");
    db.run("INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at) VALUES ('s1', 'i1', 'x', 'x', 'READY', 't', 't')");
    db.run("INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at) VALUES ('s2', 'i2', 'x', 'x', 'READY', 't', 't')");
    db.run(
      `INSERT INTO assignments (assignment_id, role_key, role, project_id, session_id, session_incarnation,
                               binding_generation, mode, status, created_at)
       VALUES ('a1', 'PRIMARY_CTO:p', 'PRIMARY_CTO', 'p', 's1', 'i1', 1, 'PREFERRED', 'ACTIVE', 't')`,
    );

    expect(() =>
      db.run(
        `INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal, contract_digest,
                           owner_session_id, owner_binding_generation, owner_session_incarnation, owner_role_key, created_at)
         VALUES ('run_forged_owner', 'p', 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'ACTIVE', 'x', 'sha256:contract',
                 's2', 1, 'i2', 'PRIMARY_CTO:p', 't')`,
      ),
    ).toThrowError(/foreign-key authority tuple is invalid/);
  });

  it("#69 keeps a revoked generation terminal even after newer generations are revoked", () => {
    const { db } = makeCore();
    db.run("INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at) VALUES ('s', 'i', 'x', 'x', 'READY', 't', 't')");
    db.run(
      "INSERT INTO assignments (assignment_id, role_key, role, session_id, session_incarnation, binding_generation, mode, status, created_at) VALUES ('a1', 'CEO', 'CEO', 's', 'i', 1, 'PREFERRED', 'REVOKED', 't')",
    );
    db.run(
      "INSERT INTO assignments (assignment_id, role_key, role, session_id, session_incarnation, binding_generation, mode, status, created_at) VALUES ('a2', 'CEO', 'CEO', 's', 'i', 2, 'PREFERRED', 'REVOKED', 't')",
    );

    expect(() => db.run("UPDATE assignments SET status = 'ACTIVE' WHERE assignment_id = 'a1'")).toThrowError(
      /BINDING_REVOKED_TERMINAL/,
    );
  });

  it("#70 rejects a generic PASS blob even when the caller supplies an expected producer name", () => {
    const { artifacts, runId, digest } = candidateRun();
    expect(
      thrown(() =>
        artifacts.putEvidence("verification-engine", runId, ArtifactKind.VERIFICATION, { status: "PASS" }, digest),
      ),
    ).toMatchObject({ reasonCode: ReasonCode.INVALID_ARGUMENT });
  });

  it("#71 rejects evidence whose embedded candidate digest differs from its row binding", () => {
    const { db, artifacts, runId, digest } = candidateRun();
    const mismatched = { ...verificationFor(runId, digest), candidateSnapshotDigest: digestOf({ other: true }) };

    expect(
      thrown(() =>
        artifacts.putEvidence("verification-engine", runId, ArtifactKind.VERIFICATION, mismatched, digest),
      ),
    ).toMatchObject({ reasonCode: ReasonCode.SNAPSHOT_DIGEST_MISMATCH });
    expect(() =>
      db.run(
        `INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest,
                                    content_json, produced_by, created_at)
         VALUES ('raw_mismatch', ?, 'VERIFICATION', 'sha256:raw', ?, ?, 'verification-engine', 't')`,
        [runId, digest, JSON.stringify({ candidateSnapshotDigest: digestOf({ raw: "wrong" }) })],
      ),
    ).toThrowError(/EVIDENCE_CANDIDATE_MISMATCH/);
  });

  it("#72 only permits the one-way superseded marker on an artifact", () => {
    const { db, artifacts, runId } = candidateRun();
    const artifact = artifacts.put(runId, ArtifactKind.PLAN, { phase: "safe" });

    expect(() =>
      db.run("UPDATE run_artifacts SET created_at = '2099-01-01T00:00:00.000Z' WHERE artifact_id = ?", [artifact.artifactId]),
    ).toThrowError(/ARTIFACT_IMMUTABLE/);
    db.run("UPDATE run_artifacts SET superseded = 1 WHERE artifact_id = ?", [artifact.artifactId]);
    expect(() => db.run("UPDATE run_artifacts SET superseded = 0 WHERE artifact_id = ?", [artifact.artifactId])).toThrowError(
      /ARTIFACT_IMMUTABLE/,
    );
  });

  it("#73 encodes sparse array holes as JSON null instead of colliding with an empty array", () => {
    expect(canonicalJson(new Array(1))).toBe("[null]");
    expect(digestOf(new Array(1))).not.toBe(digestOf([]));
    expect(canonicalJson(new Array(2))).toBe("[null,null]");
  });

  it("#74 rejects private bulk content and credential-bearing evidence before durable storage", () => {
    const { artifacts, db, runId } = candidateRun();
    expect(
      thrown(() => artifacts.put(runId, ArtifactKind.PLAN, { prompt: "full private instruction" })),
    ).toMatchObject({ reasonCode: ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED });

    expect(
      thrown(() => artifacts.put(runId, ArtifactKind.PLAN, { requestHeaders: { serviceKey: "arbitrary-password" } })),
    ).toMatchObject({ reasonCode: ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED });
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM run_artifacts WHERE run_id = ?", [runId])?.n).toBe(1);
  });

  it("#75 redacts arbitrary secrets stored under requestHeaders before audit serialization", () => {
    const { audit } = makeCore();
    const recorded = audit.record({
      kind: "TEST",
      evidence: { requestHeaders: { "X-Service-Key": "arbitrary-password" } },
    });
    expect(recorded.reasonCode).toBe(ReasonCode.OK);
    expect(audit.all()[0]?.evidence).toEqual({ requestHeaders: "[redacted-collection]" });
  });

  it("#75 rejects an unallowlisted audit-evidence collection before it can serialize a credential", () => {
    const { audit } = makeCore();
    const rejected = audit.record({
      kind: "TEST",
      evidence: { requestMetadata: { "X-Service-Key": "arbitrary-password" } },
    });

    expect(rejected).toMatchObject({ allowed: false, reasonCode: ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED });
    expect(audit.all()[0]?.evidence).toEqual({ auditEvidenceRejected: true });
  });

  it("#76 rejects receipt edits and deletes that would remove an external-write replay marker", () => {
    const { db } = makeCore();
    db.run(
      `INSERT INTO github_receipts (receipt_id, idempotency_key, operation, repository_identity,
                                    resource_type, resource_identity, request_digest, response_json, created_at, status)
       VALUES ('r1', 'key1', 'merge_execute', 'github:acme/fixture', 'pull', '1', 'sha256:request', '{"pending":true}', 't', 'PENDING')`,
    );
    db.run(
      `UPDATE github_receipts
          SET status = 'APPLIED', after_state_digest = 'sha256:after', response_json = '{"applied":true}',
              reread_at = 't', verified = 1
        WHERE receipt_id = 'r1'`,
    );

    expect(() => db.run("UPDATE github_receipts SET response_json = '{\"forged\":true}' WHERE receipt_id = 'r1'"))
      .toThrowError(/GITHUB_RECEIPT_IMMUTABLE/);
    expect(() => db.run("DELETE FROM github_receipts WHERE receipt_id = 'r1'")).toThrowError(
      /GITHUB_RECEIPT_IMMUTABLE/,
    );
  });

  it("#76 rejects a completed external-write receipt that bypasses its PENDING reservation", () => {
    const { db } = makeCore();
    expect(
      thrown(() =>
        db.run(
          `INSERT INTO github_receipts (receipt_id, idempotency_key, operation, repository_identity,
                                        resource_type, resource_identity, request_digest, response_json, created_at,
                                        reread_at, verified, status)
           VALUES ('r2', 'key2', 'merge_execute', 'github:acme/fixture', 'pull', '2', 'sha256:request', '{}', 't', 't', 1, 'APPLIED')`,
        ),
      ),
    ).toMatchObject({ reasonCode: ReasonCode.GITHUB_RECEIPT_PROTOCOL_VIOLATION });

    db.run(
      `INSERT INTO github_receipts (receipt_id, idempotency_key, operation, repository_identity,
                                    resource_type, resource_identity, request_digest, response_json, created_at, status)
       VALUES ('r3', 'key3', 'merge_execute', 'github:acme/fixture', 'pull', '3', 'sha256:request', '{"pending":true}', 't', 'PENDING')`,
    );
    expect(
      thrown(() => db.run("UPDATE github_receipts SET status = 'APPLIED' WHERE receipt_id = 'r3'")),
    ).toMatchObject({ reasonCode: ReasonCode.GITHUB_RECEIPT_PROTOCOL_VIOLATION });
  });
});
