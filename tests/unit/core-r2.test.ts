import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";

import { canonicalJson, digestOf } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ArtifactKind } from "../../src/domain/types.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import {
  CANDIDATE_SNAPSHOT_SCHEMA_ID,
  candidateSnapshotDigest,
  type CandidateSnapshot,
} from "../../src/snapshot/candidate-snapshot.ts";
import { Db } from "../../src/db/database.ts";
import { cleanupTempDirs, makeCore, makeRepo, seedActor, seedRun, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

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

  it("#66 refuses a legal raw state edge unless the evidence-and-outbox operation marks it", () => {
    const { db, audit, outbox, clock } = makeCore();
    const seeded = seedRun({ db, clock, repoPath: makeRepo(), state: "QUEUED" });

    expect(
      thrown(() => db.run(`UPDATE runs SET state = 'COMPLETED' WHERE run_id = ?`, [seeded.runId])),
    ).toMatchObject({ reasonCode: ReasonCode.RUN_TRANSITION_ILLEGAL });
    // ACTIVE is a legal edge, so topology-only enforcement used to accept this write. The
    // assertion becomes green again if the authority trigger is removed.
    expect(
      thrown(() => db.run(`UPDATE runs SET state = 'ACTIVE' WHERE run_id = ?`, [seeded.runId])),
    ).toMatchObject({ reasonCode: ReasonCode.RUN_STATE_TRANSITION_AUTHORITY_DENIED });

    const authority = db.claimRunStateTransitionAuthority();
    expect(
      thrown(() =>
        db.applyRunStateTransition(authority, {
          runId: seeded.runId,
          toState: "ACTIVE",
          recordTransitionEvidence: () =>
            audit.record({
              kind: "RUN_TRANSITION",
              runId: seeded.runId,
              projectId: seeded.projectId,
              evidence: { from: "QUEUED", to: "ACTIVE", reason: "unroutable fixture dispatch" },
            }),
          enqueueTransitionEnvelope: () =>
            outbox.enqueue({
              idempotencyKey: `run-dispatch:${seeded.runId}`,
              roleKey: seeded.roleKey,
              bindingGeneration: seeded.generation + 1,
              targetSessionId: seeded.sessionId,
              runId: seeded.runId,
              kind: MessageKind.RUN_DISPATCH,
              payload: { runId: seeded.runId },
            }),
          updateState: () => db.run(`UPDATE runs SET state = 'ACTIVE' WHERE run_id = ?`, [seeded.runId]),
        }),
      ),
    ).toMatchObject({ reasonCode: ReasonCode.OUTBOX_TARGET_NOT_CURRENT });
    // The audit write happened before its denied enqueue; the enclosing operation must leave
    // neither fact durable, otherwise a later retry would be evidence for the wrong transition.
    expect(audit.byKind("RUN_TRANSITION")).toHaveLength(0);
    expect(db.get<{ state: string }>(`SELECT state FROM runs WHERE run_id = ?`, [seeded.runId])?.state)
      .toBe("QUEUED");

    db.applyRunStateTransition(authority, {
      runId: seeded.runId,
      toState: "ACTIVE",
      recordTransitionEvidence: () =>
        audit.record({
          kind: "RUN_TRANSITION",
          runId: seeded.runId,
          projectId: seeded.projectId,
          evidence: { from: "QUEUED", to: "ACTIVE", reason: "fixture dispatch" },
        }),
      enqueueTransitionEnvelope: () =>
        outbox.enqueue({
          idempotencyKey: `run-dispatch:${seeded.runId}`,
          roleKey: seeded.roleKey,
          bindingGeneration: seeded.generation,
          targetSessionId: seeded.sessionId,
          runId: seeded.runId,
          kind: MessageKind.RUN_DISPATCH,
          payload: { runId: seeded.runId },
        }),
      updateState: () => {
        // The marker covers this exact edge, not every legal transition the engine could name.
        expect(
          thrown(() => db.run(`UPDATE runs SET state = 'CANCELLED' WHERE run_id = ?`, [seeded.runId])),
        ).toMatchObject({ reasonCode: ReasonCode.RUN_STATE_TRANSITION_AUTHORITY_DENIED });
        return db.run(`UPDATE runs SET state = 'ACTIVE' WHERE run_id = ?`, [seeded.runId]);
      },
    });

    expect(db.get<{ state: string }>(`SELECT state FROM runs WHERE run_id = ?`, [seeded.runId])?.state)
      .toBe("ACTIVE");
    expect(audit.all()).toContainEqual(expect.objectContaining({ kind: "RUN_TRANSITION", runId: seeded.runId }));
    expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox WHERE run_id = ?`, [seeded.runId])?.n)
      .toBe(1);
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
      `INSERT INTO assignments (assignment_id, role_key, role, project_id, actor_id, session_id, session_incarnation,
                               binding_generation, mode, status, created_at)
       VALUES ('a1', 'PRIMARY_CTO:p', 'PRIMARY_CTO', 'p', ?, 's1', 'i1', 1, 'PREFERRED', 'ACTIVE', 't')`,
      [seedActor(db, "PRIMARY_CTO")],
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
      `INSERT INTO assignments (assignment_id, role_key, role, actor_id, session_id, session_incarnation, binding_generation, mode, status, created_at) VALUES ('a1', 'CEO', 'CEO', ?, 's', 'i', 1, 'PREFERRED', 'REVOKED', 't')`,
      [seedActor(db, "CEO")],
    );
    db.run(
      `INSERT INTO assignments (assignment_id, role_key, role, actor_id, session_id, session_incarnation, binding_generation, mode, status, created_at) VALUES ('a2', 'CEO', 'CEO', ?, 's', 'i', 2, 'PREFERRED', 'REVOKED', 't')`,
      [seedActor(db, "CEO")],
    );

    expect(() => db.run("UPDATE assignments SET status = 'ACTIVE' WHERE assignment_id = 'a1'")).toThrowError(
      /BINDING_REVOKED_TERMINAL/,
    );
  });

  it("#70 refuses a caller that knows the producer name but holds no capability", () => {
    const { artifacts, runId, digest } = candidateRun();
    // The attack the finding names: an in-process caller passing the producer *string*.
    // It is a type error now, so the cast is what an untyped or compromised caller would
    // effectively do — and it must still be refused at runtime.
    expect(
      thrown(() =>
        artifacts.putEvidence(
          "verification-engine" as never,
          runId,
          ArtifactKind.VERIFICATION,
          verificationFor(runId, digest),
          digest,
        ),
      ),
    ).toMatchObject({ reasonCode: ReasonCode.COMPLETION_AUTHORITY_DENIED });
  });

  it("#70 refuses a capability issued for another evidence kind", () => {
    const { artifacts, runId, digest } = candidateRun();
    const writers = artifacts.issueEvidenceWriters();
    expect(
      thrown(() =>
        artifacts.putEvidence(
          writers.BLIND_REVIEW as never,
          runId,
          ArtifactKind.VERIFICATION,
          verificationFor(runId, digest),
          digest,
        ),
      ),
    ).toMatchObject({ reasonCode: ReasonCode.COMPLETION_AUTHORITY_DENIED });
  });

  it("#70 still rejects a generic PASS blob from the engine that does hold the capability", () => {
    const { artifacts, runId, digest } = candidateRun();
    expect(
      thrown(() =>
        artifacts.putEvidence(
          artifacts.issueEvidenceWriters().VERIFICATION,
          runId,
          ArtifactKind.VERIFICATION,
          { status: "PASS" },
          digest,
        ),
      ),
    ).toMatchObject({ reasonCode: ReasonCode.INVALID_ARGUMENT });
  });

  it("#70/#352 rejects a raw evidence insert even when it names the real producer and candidate", () => {
    const { db, artifacts, runId, digest } = candidateRun();
    const evidence = verificationFor(runId, digest);
    const writer = artifacts.issueEvidenceWriters().VERIFICATION;

    // MCP factories reduce the composition root to operation-only ports before a handler is
    // built. An accidental return of the root would put Db back within a tool's reach.
    const harness = makeHarness();
    const hermesPort = createHermesMcpPort(harness.cp);
    const ctoPort = createCtoMcpPort(harness.cp);
    for (const port of [hermesPort, ctoPort]) {
      expect(Object.hasOwn(port, "db")).toBe(false);
      expect(Object.hasOwn(port, "runs")).toBe(false);
      expect(Object.hasOwn(port.mutation, "db")).toBe(false);
    }
    const authenticate = () => allow(ReasonCode.OK, { actor: "port-only-test" });
    expect(createHermesServer(hermesPort, authenticate)).toBeDefined();
    expect(createCtoServer(ctoPort, authenticate)).toBeDefined();

    // A tool handler may hold Db, but not the native connection that could replace the marker
    // function or drop this trigger before issuing the SQL below.
    expect((db.raw as unknown as { function?: unknown; prepare?: unknown }).function).toBeUndefined();
    expect(
      thrown(() => db.run("DROP TRIGGER run_artifacts_evidence_authority_guard")),
    ).toMatchObject({ reasonCode: ReasonCode.INVALID_ARGUMENT });
    expect(
      thrown(() =>
        db.run(
          `INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest,
                                      content_json, produced_by, created_at)
           VALUES ('raw_evidence', ?, 'VERIFICATION', ?, ?, ?, 'verification-engine', 't')`,
          [runId, digestOf({ candidateSnapshotDigest: digest, content: evidence }), digest, canonicalJson(evidence)],
        ),
      ),
    ).toMatchObject({ reasonCode: ReasonCode.COMPLETION_AUTHORITY_DENIED });

    const written = artifacts.putEvidence(
      writer,
      runId,
      ArtifactKind.VERIFICATION,
      evidence,
      digest,
    );
    expect(written.producedBy).toBe("verification-engine");
  });

  it("#351 refuses a credential-shaped value inside a field the envelope allows", () => {
    const { artifacts, runId, digest } = candidateRun();
    const writer = artifacts.issueEvidenceWriters().VERIFICATION;
    const base = verificationFor(runId, digest);
    // A strict envelope stops an unknown `githubToken` field, so the leak that mattered was a
    // credential *value* inside a field the envelope permits. Each of these reached durable
    // evidence while the detector matched exact names only.
    const shapes = [
      ["github fine-grained pat", "github_pat_11ABCDEFGHIJKLMNOPQRST_abcdefghijklmnopqrstuvwxyz012345"],
      ["telegram bot token", "123456789:AAF-abcdefghijklmnopqrstuvwxyz0123456789"],
      ["aws access key id", "AKIAIOSFODNN7EXAMPLE"],
    ] as const;
    for (const [what, value] of shapes) {
      expect(
        thrown(() =>
          artifacts.putEvidence(writer, runId, ArtifactKind.VERIFICATION, { ...base, gaps: [value] }, digest),
        ),
        what,
      ).toMatchObject({ reasonCode: ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED });
    }
    // And an identifier a report has to be able to state is still storable — the suffix rule
    // would otherwise read `roleKey` as a credential and refuse honest evidence.
    expect(
      artifacts.putEvidence(
        writer,
        runId,
        ArtifactKind.VERIFICATION,
        { ...base, gaps: ["roleKey=PRIMARY_CTO:prj", "idempotencyKey=abc"] },
        digest,
      ).digest,
    ).toMatch(/^sha256:/);
  });

  it("#71 rejects evidence whose embedded candidate digest differs from its row binding", () => {
    const { db, artifacts, runId, digest } = candidateRun();
    const mismatched = { ...verificationFor(runId, digest), candidateSnapshotDigest: digestOf({ other: true }) };

    expect(
      thrown(() =>
        artifacts.putEvidence(
          artifacts.issueEvidenceWriters().VERIFICATION,
          runId,
          ArtifactKind.VERIFICATION,
          mismatched,
          digest,
        ),
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

  it("#75 keeps a credential out of durable audit even under a name nobody allowlisted", () => {
    const { audit } = makeCore();
    // A name-only allowlist rejected the real CANDIDATE_FROZEN record and stopped runs from
    // reaching review, so the boundary asserts the invariant instead: whatever the field is
    // called, the credential must not be in the stored row.
    audit.record({ kind: "TEST", evidence: { requestMetadata: { "X-Service-Key": "arbitrary-password" } } });
    const stored = JSON.stringify(audit.all()[0]?.evidence ?? {});
    expect(stored).not.toContain("arbitrary-password");
    expect(stored).toContain("redacted");
  });

  it("#75 refuses a free-form payload under a field nobody allowlisted", () => {
    const { audit } = makeCore();
    // The shape §31.5 exists to keep out: an unknown name carrying prose, which is what a
    // prompt or a transcript looks like. Identifier-shaped values stay admissible.
    const rejected = audit.record({
      kind: "TEST",
      evidence: { modelNotes: `${"the operator asked the model to summarise the incident. ".repeat(8)}` },
    });
    expect(rejected).toMatchObject({ allowed: false, reasonCode: ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED });
    expect(audit.all()[0]?.evidence).toEqual({ auditEvidenceRejected: true });

    const admitted = audit.record({ kind: "TEST", evidence: { attemptCount: 3, worktreeId: "verify-abc123" } });
    expect(admitted.allowed).toBe(true);
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
    for (const operation of ["merge_execute", "release_tag", "issue_project"] as const) {
      expect(
        thrown(() =>
          db.run(
            `INSERT INTO github_receipts (receipt_id, idempotency_key, operation, repository_identity,
                                          resource_type, resource_identity, request_digest, response_json, created_at,
                                          reread_at, verified, status)
             VALUES (?, ?, ?, 'github:acme/fixture', 'pull', '2', 'sha256:request', '{}', 't', 't', 1, 'APPLIED')`,
            [`r2_${operation}`, `key2_${operation}`, operation],
          ),
        ),
      ).toMatchObject({ reasonCode: ReasonCode.GITHUB_RECEIPT_PROTOCOL_VIOLATION });
    }

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
