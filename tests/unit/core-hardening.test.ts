import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { chmodSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson, digestOf } from "../../src/core/digest.ts";
import {
  acpError,
  errorPayload,
  fromErrorPayload,
  isAcpError,
} from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { EvidenceWriter } from "../../src/db/artifacts.ts";
import { Db, SCHEMA_VERSION } from "../../src/db/database.ts";
import { schemaDdl } from "../../src/db/migrations.ts";
import { redact } from "../../src/db/audit.ts";
import { WorktreeManager } from "../../src/verify/worktree.ts";
import { TrustedCredentialStore } from "../../src/github/credential-store.ts";
import { legalTargets } from "../../src/domain/run-state.ts";
import { ArtifactKind, RunState } from "../../src/domain/types.ts";
import {
  CANDIDATE_SNAPSHOT_SCHEMA_ID,
  candidateSnapshotDigest,
  type CandidateSnapshot,
} from "../../src/snapshot/candidate-snapshot.ts";
import { cleanupTempDirs, makeCore, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * Regressions for the defects an independent GPT-5.6 Sol review found in the trusted
 * core. Each closes a way authoritative evidence could be forged, rebound or erased.
 */
describe("evidence can only be written by the engine that owns it", () => {
  const setup = () => {
    const core = makeCore();
    const runId = "run_artifact";
    core.db.run(
      `INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
       VALUES (?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'ACTIVE', 'fixture goal', 'sha256:contract', ?)`,
      [runId, core.clock.nowIso()],
    );
    const snapshot: CandidateSnapshot = {
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
      createdAt: core.clock.nowIso(),
    };
    const digest = candidateSnapshotDigest(snapshot);
    core.artifacts.put(runId, ArtifactKind.CANDIDATE_SNAPSHOT, snapshot, digest);
    const verification = {
      runId,
      candidateSnapshotDigest: digest,
      contractDigest: "sha256:contract",
      expectedInputs: 1,
      observedInputs: 1,
      results: [],
      status: "PASS" as const,
      reasonCode: "OK",
      gaps: [],
    };
    return { ...core, runId, digest, verification };
  };

  it("a general caller cannot mint a verification or review artifact", () => {
    const { artifacts, runId, digest } = setup();
    expect(() =>
      artifacts.put(runId, ArtifactKind.VERIFICATION, { status: "PASS" }, digest),
    ).toThrowError(/must be written through putEvidence/);
    expect(() =>
      artifacts.put(runId, ArtifactKind.BLIND_REVIEW, { verdict: "PASS" }, digest),
    ).toThrowError(/must be written through putEvidence/);
  });

  it("putEvidence refuses a capability that does not own the kind", () => {
    const { artifacts, runId, digest, verification } = setup();
    const writers = artifacts.issueEvidenceWriters();
    expect(() =>
      artifacts.putEvidence(
        // The BLIND_REVIEW capability is real; the cast is the only way to present it for
        // another kind, which is what tsc otherwise refuses outright.
        writers.BLIND_REVIEW as unknown as EvidenceWriter<"VERIFICATION">,
        runId,
        ArtifactKind.VERIFICATION,
        { status: "PASS" },
        digest,
      ),
    ).toThrowError(/may not write VERIFICATION/);

    const written = artifacts.putEvidence(
      writers.VERIFICATION,
      runId,
      ArtifactKind.VERIFICATION,
      verification,
      digest,
    );
    expect(written.producedBy).toBe("verification-engine");
  });

  it("evidence cannot be rebound to another candidate, edited or deleted", () => {
    const { db, artifacts, runId, digest, verification } = setup();
    artifacts.putEvidence(
      artifacts.issueEvidenceWriters().VERIFICATION,
      runId,
      ArtifactKind.VERIFICATION,
      verification,
      digest,
    );

    expect(() =>
      db.run(`UPDATE run_artifacts SET candidate_snapshot_digest = 'sha256:candidate-b'`),
    ).toThrowError(/ARTIFACT_IMMUTABLE/);
    expect(() => db.run(`UPDATE run_artifacts SET produced_by = 'someone-else'`)).toThrowError(
      /ARTIFACT_IMMUTABLE/,
    );
    expect(() => db.run(`DELETE FROM run_artifacts`)).toThrowError(/ARTIFACT_IMMUTABLE/);
  });
});

describe("append-only really means append-only", () => {
  it("audit events cannot be deleted", () => {
    const { db, audit } = makeCore();
    audit.record({ kind: "TEST", evidence: {} });
    expect(() => db.run(`DELETE FROM audit_events`)).toThrowError(/AUDIT_APPEND_ONLY/);
  });
});

describe("Telegram owner prompt records are immutable", () => {
  it("refuses direct UPDATE and DELETE of a persisted prompt", () => {
    const raw = new Database(":memory:");
    try {
      raw.exec(schemaDdl());
      raw.prepare(
        `INSERT INTO telegram_owner_prompts
           (chat_id, message_id, correlation_id, run_id, candidate_snapshot_digest, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("owner-chat", 42, "telegram:prompt:42", "run_prompt", "sha256:shown", "2026-08-14T00:00:00.000Z");

      expect(() => raw.prepare(
        "UPDATE telegram_owner_prompts SET candidate_snapshot_digest = 'sha256:rewritten'",
      ).run()).toThrowError(/TELEGRAM_PROMPT_IMMUTABLE/);
      expect(() => raw.prepare("DELETE FROM telegram_owner_prompts").run()).toThrowError(
        /TELEGRAM_PROMPT_IMMUTABLE/,
      );
    } finally {
      raw.close();
    }
  });
});

describe("binding identity is immutable once written", () => {
  it("generation, role key, session and incarnation cannot be updated in place", () => {
    const { db, clock } = makeCore();
    const now = clock.nowIso();
    db.run(`INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
            VALUES ('session_1', 'inc-1', 'test', 'test', 'READY', ?, ?)`, [now, now]);
    db.run(`INSERT INTO assignments (assignment_id, role_key, role, session_id, session_incarnation,
                                     binding_generation, mode, status, created_at)
            VALUES ('assignment_1', 'CEO', 'CEO', 'session_1', 'inc-1', 1, 'PREFERRED', 'ACTIVE', ?)`, [now]);

    // Lowering the generation would reactivate stale authority.
    expect(() =>
      db.run(`UPDATE assignments SET binding_generation = 1 WHERE role_key = 'CEO'`),
    ).not.toThrow(); // already 1: a no-op update is fine
    expect(() =>
      db.run(`UPDATE assignments SET binding_generation = 5 WHERE role_key = 'CEO'`),
    ).toThrowError(/BINDING_IDENTITY_IMMUTABLE/);
    expect(() =>
      db.run(`UPDATE assignments SET role_key = 'OTHER' WHERE role_key = 'CEO'`),
    ).toThrowError(/BINDING_IDENTITY_IMMUTABLE/);
  });
});

describe("transactions must be synchronous", () => {
  it("an async transaction body is refused instead of committing early", () => {
    const { db } = makeCore();
    expect(() =>
      db.tx((() => Promise.resolve("done")) as unknown as () => string),
    ).toThrowError(/transaction bodies must be synchronous/);
  });

  it("a synchronous body still commits and rolls back normally", () => {
    const { db, clock } = makeCore();
    const runId = "run_transaction";
    db.run(
      `INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
       VALUES (?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'ACTIVE', 'initial', 'sha256:contract', ?)`,
      [runId, clock.nowIso()],
    );

    db.tx(() => db.run(`UPDATE runs SET goal = 'committed' WHERE run_id = ?`, [runId]));
    expect(db.get<{ goal: string }>(`SELECT goal FROM runs WHERE run_id = ?`, [runId])?.goal).toBe(
      "committed",
    );

    expect(() =>
      db.tx(() => {
        db.run(`UPDATE runs SET goal = 'rolled back' WHERE run_id = ?`, [runId]);
        throw new Error("boom");
      }),
    ).toThrowError("boom");
    expect(db.get<{ goal: string }>(`SELECT goal FROM runs WHERE run_id = ?`, [runId])?.goal).toBe(
      "committed",
    );
  });
});

describe("schema versioning fails closed", () => {
  it("a database from an unknown schema version is refused", () => {
    const path = join(tempDir("acp-schema-"), "state.sqlite");
    const first = new Db(path);
    expect(Number(first.raw.pragma("user_version", { simple: true }))).toBe(SCHEMA_VERSION);
    first.raw.pragma(`user_version = ${SCHEMA_VERSION + 7}`);
    first.close();

    expect(() => new Db(path)).toThrowError(/schema is newer than this build/);
  });

  it("a database that predates versioning is refused rather than silently reused", () => {
    const path = join(tempDir("acp-schema-"), "legacy.sqlite");
    const first = new Db(path);
    first.raw.pragma("user_version = 0"); // simulate a pre-versioning database
    first.close();

    expect(() => new Db(path)).toThrowError(/predates schema versioning/);
  });
});

describe("state path preflight", () => {
  it("refuses a permissive state directory before SQLite opens or repairs it", () => {
    const root = tempDir("acp-insecure-state-");
    chmodSync(root, 0o755);
    const path = join(root, "state.sqlite");

    try {
      new Db(path);
      throw new Error("expected state preflight denial");
    } catch (error) {
      expect(isAcpError(error) && error.reasonCode).toBe(ReasonCode.STATE_PATH_INSECURE);
    }
  });

  it("refuses a database file made group-readable after a prior clean open", () => {
    const path = join(tempDir("acp-insecure-db-"), "state.sqlite");
    const first = new Db(path);
    first.close();
    chmodSync(path, 0o644);

    try {
      new Db(path);
      throw new Error("expected database preflight denial");
    } catch (error) {
      expect(isAcpError(error) && error.reasonCode).toBe(ReasonCode.STATE_PATH_INSECURE);
    }
  });

  it("refuses a world-writable worktree root before candidate code can be materialised", () => {
    const root = join(tempDir("acp-insecure-worktrees-"), "worktrees");
    mkdirSync(root, { mode: 0o777 });
    chmodSync(root, 0o777);

    try {
      new WorktreeManager(root);
      throw new Error("expected worktree preflight denial");
    } catch (error) {
      expect(isAcpError(error) && error.reasonCode).toBe(ReasonCode.STATE_PATH_INSECURE);
    }
  });

  it("refuses a symlinked secret-store directory before a credential can be installed", () => {
    const root = tempDir("acp-insecure-secrets-");
    const realDirectory = join(root, "real-secrets");
    const alias = join(root, "secrets");
    mkdirSync(realDirectory, { mode: 0o700 });
    symlinkSync(realDirectory, alias);

    try {
      new TrustedCredentialStore(alias).install({ token: "test-token", creatorIdentity: "fixture" });
      throw new Error("expected secret-store preflight denial");
    } catch (error) {
      expect(isAcpError(error) && error.reasonCode).toBe(ReasonCode.STATE_PATH_INSECURE);
    }
  });
});

describe("redaction resists value-borne and alternately-named secrets", () => {
  it("redacts credentials that arrive inside values", () => {
    const out = redact({
      note: "use ghp_abcdefghijklmnopqrstuvwxyz01 for now",
      header: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig",
      dump: "GITHUB_TOKEN=ghp_zzzzzzzzzzzzzzzzzzzzzzzz",
      key: "-----BEGIN RSA PRIVATE KEY-----",
    }) as Record<string, string>;
    for (const value of Object.values(out)) expect(value).toContain("[redacted]");
  });

  it("redacts environment and header collections wholesale", () => {
    const out = redact({
      env: { GITHUB_TOKEN: "ghp_x", PATH: "/usr/bin" },
      headers: { authorization: "Bearer x" },
    }) as Record<string, unknown>;
    expect(out["env"]).toBe("[redacted-collection]");
    expect(out["headers"]).toBe("[redacted-collection]");
  });

  it("refuses to store prompts and transcripts under any casing", () => {
    const out = redact({
      Prompt: "…",
      SYSTEM_PROMPT: "…",
      chat_transcript: "…",
      Reasoning: "…",
    }) as Record<string, string>;
    for (const value of Object.values(out)) expect(value).toBe("[not-stored]");
  });
});

describe("the state machine cannot be reshaped at runtime", () => {
  it("legalTargets hands back a copy", () => {
    const targets = legalTargets(RunState.QUEUED) as RunState[];
    targets.push(RunState.COMPLETED);
    expect(legalTargets(RunState.QUEUED)).not.toContain(RunState.COMPLETED);
  });
});

describe("denials survive a boundary as data", () => {
  it("isAcpError is structural and the payload round-trips", () => {
    const original = acpError(ReasonCode.WRITE_REQUIRES_MANAGED_RUN, "denied", { runId: "r1" });
    const payload = errorPayload(original);

    // What structured cloning of an Error actually leaves behind: a plain object.
    const overWire = JSON.parse(JSON.stringify(payload)) as typeof payload;
    expect(isAcpError(overWire)).toBe(true);

    const rebuilt = fromErrorPayload(overWire);
    expect(rebuilt.reasonCode).toBe(ReasonCode.WRITE_REQUIRES_MANAGED_RUN);
    expect(rebuilt.evidence["runId"]).toBe("r1");
    expect(rebuilt instanceof Error).toBe(true);
  });
});

describe("canonical encoding is injective and newline-stable", () => {
  it("normalizes newlines so a line-ending change is not drift", () => {
    expect(digestOf({ body: "a\r\nb" })).toBe(digestOf({ body: "a\nb" }));
    expect(canonicalJson({ body: "a\rb" })).toBe(canonicalJson({ body: "a\nb" }));
  });

  it("refuses values that would collide", () => {
    expect(() => canonicalJson({ n: 1n })).toThrowError(/bigint/);
    expect(() => canonicalJson({ at: new Date(0) })).toThrowError(/only plain objects/);
    expect(() => canonicalJson({ m: new Map() })).toThrowError(/only plain objects/);
  });

  it("still distinguishes different content", () => {
    expect(digestOf({ a: "1" })).not.toBe(digestOf({ a: 1 }));
  });
});
