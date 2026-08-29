import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { chmodSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson, digestOf } from "../../src/core/digest.ts";
import {
  acpError,
  allow,
  deny,
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
import { BaselineRecordKind } from "../../src/export/baseline-contract.ts";
import { BaselineRecorder } from "../../src/export/baseline-recorder.ts";
import { cleanupTempDirs, makeCore, makeRepo, tempDir, seedActor, seedRun } from "../helpers/fixtures.ts";

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
    db.run(`INSERT INTO assignments (assignment_id, role_key, role, actor_id, session_id, session_incarnation,
                                     binding_generation, mode, status, created_at)
            VALUES ('assignment_1', 'CEO', 'CEO', ?, 'session_1', 'inc-1', 1, 'PREFERRED', 'ACTIVE', ?)`,
           [seedActor(db, "CEO"), now]);

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

describe("#664 — a transaction whose body decides 'no' still commits its writes", () => {
  it("plain tx() commits a write even when the body returns a denied Decision", () => {
    // This is the exact shape the issue reproduced: a Decision denial is a normal
    // return, and tx() cannot tell it apart from any other value a body hands back.
    // Bodies that write unconditional housekeeping a later decision only reads (see
    // github-kernel.ts's claim-expiry sweep) rely on exactly this: `tx()` is documented
    // and kept this way on purpose, not fixed here — `txDecision` is the opt-in.
    const { db, clock } = makeCore();
    const actorId = "actor_probe_664";
    const decision = db.tx(() => {
      db.run(
        `INSERT INTO conversational_actors (actor_id, kind, created_at) VALUES (?, 'WORKER', ?)`,
        [actorId, clock.nowIso()],
      );
      return deny(ReasonCode.CONFLICT, "changed my mind");
    });
    expect(decision.allowed).toBe(false);
    expect(
      db.get<{ actor_id: string }>(`SELECT actor_id FROM conversational_actors WHERE actor_id = ?`, [
        actorId,
      ]),
    ).toBeTruthy();
  });

  it("txDecision() rolls back a write when the body returns a denied Decision", () => {
    const { db, clock } = makeCore();
    const actorId = "actor_probe_664_txdecision";
    const decision = db.txDecision(() => {
      db.run(
        `INSERT INTO conversational_actors (actor_id, kind, created_at) VALUES (?, 'WORKER', ?)`,
        [actorId, clock.nowIso()],
      );
      return deny(ReasonCode.CONFLICT, "changed my mind");
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reasonCode).toBe(ReasonCode.CONFLICT);
    expect(
      db.get<{ actor_id: string }>(`SELECT actor_id FROM conversational_actors WHERE actor_id = ?`, [
        actorId,
      ]),
    ).toBeUndefined();
  });

  it("txDecision() still commits a write when the body returns an allowed Decision", () => {
    const { db, clock } = makeCore();
    const actorId = "actor_probe_664_allow";
    const decision = db.txDecision(() => {
      db.run(
        `INSERT INTO conversational_actors (actor_id, kind, created_at) VALUES (?, 'WORKER', ?)`,
        [actorId, clock.nowIso()],
      );
      return allow(ReasonCode.OK, actorId);
    });
    expect(decision.allowed).toBe(true);
    expect(
      db.get<{ actor_id: string }>(`SELECT actor_id FROM conversational_actors WHERE actor_id = ?`, [
        actorId,
      ]),
    ).toBeTruthy();
  });

  it("txDecision() still rolls back on a thrown error, same as tx()", () => {
    const { db, clock } = makeCore();
    const actorId = "actor_probe_664_throw";
    expect(() =>
      db.txDecision((): ReturnType<typeof allow<string>> => {
        db.run(
          `INSERT INTO conversational_actors (actor_id, kind, created_at) VALUES (?, 'WORKER', ?)`,
          [actorId, clock.nowIso()],
        );
        throw new Error("boom");
      }),
    ).toThrowError("boom");
    expect(
      db.get<{ actor_id: string }>(`SELECT actor_id FROM conversational_actors WHERE actor_id = ?`, [
        actorId,
      ]),
    ).toBeUndefined();
  });

  it("a nested txDecision() hands its denial back as data; it cannot roll back on its own", () => {
    // There is no SAVEPOINT here — a nested call has no physical boundary of its own.
    // Whether a nested denial rolls anything back is entirely up to whoever owns the
    // outermost transaction, exactly as it already is for a nested tx().
    const { db, clock } = makeCore();
    const actorId = "actor_probe_664_nested_under_plain_tx";
    const outerResult = db.tx(() => {
      const inner = db.txDecision(() => {
        db.run(
          `INSERT INTO conversational_actors (actor_id, kind, created_at) VALUES (?, 'WORKER', ?)`,
          [actorId, clock.nowIso()],
        );
        return deny(ReasonCode.CONFLICT, "changed my mind");
      });
      // The outer body is a plain tx(): it does not inspect `inner.allowed`, so it
      // commits regardless, the same way it would for any other returned value.
      return inner;
    });
    expect(outerResult.allowed).toBe(false);
    expect(
      db.get<{ actor_id: string }>(`SELECT actor_id FROM conversational_actors WHERE actor_id = ?`, [
        actorId,
      ]),
    ).toBeTruthy();
  });

  it("a nested txDecision() rolls back when its outer frame is txDecision too", () => {
    // This is the shape CtoLifecycle.acknowledgeHandoff/recoveryTakeover actually use:
    // an outer write (the handoff record) plus a nested BindingRegistry.switchTo call,
    // and the outer denial must undo both.
    const { db, clock } = makeCore();
    const outerActorId = "actor_probe_664_nested_outer";
    const innerActorId = "actor_probe_664_nested_inner";
    const outerResult = db.txDecision(() => {
      db.run(
        `INSERT INTO conversational_actors (actor_id, kind, created_at) VALUES (?, 'WORKER', ?)`,
        [outerActorId, clock.nowIso()],
      );
      const inner = db.txDecision(() => {
        db.run(
          `INSERT INTO conversational_actors (actor_id, kind, created_at) VALUES (?, 'WORKER', ?)`,
          [innerActorId, clock.nowIso()],
        );
        return deny(ReasonCode.CONFLICT, "changed my mind");
      });
      if (!inner.allowed) return inner;
      return allow(ReasonCode.OK, undefined);
    });
    expect(outerResult.allowed).toBe(false);
    for (const actorId of [outerActorId, innerActorId]) {
      expect(
        db.get<{ actor_id: string }>(`SELECT actor_id FROM conversational_actors WHERE actor_id = ?`, [
          actorId,
        ]),
      ).toBeUndefined();
    }
  });

  it("an async txDecision() body is refused instead of being misread as a denial", () => {
    // The type signature promises a synchronous `Decision<T>`, exactly like `tx()`
    // promises a synchronous `T` — and, exactly like `tx()`, a caller that bypasses the
    // type system with an async callback must be refused, not silently misread. An
    // async body returns a pending Promise, which has no `.allowed`; reading `.allowed`
    // before checking for a thenable turns that `undefined` into "denied", hands the raw
    // Promise back through the catch as if it were a real `Decision`, and never poisons
    // the handle — the still-running callback's writes after its first `await` would
    // then land as autocommit outside any transaction. Mirrors the identical `tx()` test
    // above ("an async transaction body is refused instead of committing early").
    const { db } = makeCore();
    expect(() =>
      db.txDecision((() => Promise.resolve(allow(ReasonCode.OK, "done"))) as unknown as () => ReturnType<
        typeof allow<string>
      >),
    ).toThrowError(/transaction bodies must be synchronous/);
  });

  it("#664/#679 — a second, independent recorder call denying does not save the first recorder's write", () => {
    // TaskGraph.finishExecution's real shape: `#baseline.recordInvocationFinished(...)`
    // writes and commits, and `#baseline.recordTaskClassification(...)` right after it is
    // an unrelated call that can independently deny — Sol's counterexample to the census
    // (BaselineRecorder.record() is reached by name, not by a literal `.run(`/`.exec(`, so
    // the census cannot see this shape and never claims to — see the header comment in
    // scripts/verify-tx-denial-sites.mjs).
    //
    // finishExecution's own two denials in BaselineRecorder.record() ("unknown run",
    // "prohibited/credential field") are not reachable through finishExecution's own
    // parameters — every field task-graph.ts passes is a fixed key name, not caller data,
    // and the run/execution existence is already reverified by finishExecution's own
    // preflight moments earlier with no `await` in between. So this proves the shared
    // mechanism finishExecution's fix now relies on directly against the real
    // `BaselineRecorder` and the real `Db.txDecision`, using `record()`'s one naturally
    // reachable denial (an unknown run id) rather than a synthetic table.
    const core = makeCore();
    const repo = makeRepo();
    const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: repo });
    const baseline = new BaselineRecorder(core.db, core.clock, core.audit);

    const result = core.db.txDecision(() => {
      const first = baseline.record(seeded.runId, BaselineRecordKind.INVOCATION_FINISHED, {
        probe: "first-write-must-not-survive",
      });
      if (!first.allowed) return first;
      // A second, independent recorder call — same shape as recordTaskClassification
      // right after recordInvocationFinished — denying on an unrelated ground.
      return baseline.record("run_does_not_exist", BaselineRecordKind.TASK_CLASSIFICATION, {
        probe: "second-call-denies-independently",
      });
    });

    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reasonCode).toBe(ReasonCode.NOT_FOUND);
    // Read the table directly, not the returned Decision, to prove the first recorder's
    // write did not survive the second, independent call's denial.
    expect(
      core.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM baseline_records WHERE run_id = ?`,
        [seeded.runId],
      )?.n,
    ).toBe(0);
  });

  it("an async txDecision() body poisons the handle, the same as an async tx() body", () => {
    const { db } = makeCore();
    expect(() =>
      db.txDecision((() => Promise.resolve(allow(ReasonCode.OK, "done"))) as unknown as () => ReturnType<
        typeof allow<string>
      >),
    ).toThrowError(/transaction bodies must be synchronous/);
    // Nothing on this handle may run again — not a query, not a fresh transaction —
    // because the callback that returned the promise is still running unobserved and
    // may still be mid-write when something else tries to use the same connection.
    expect(() => db.get(`SELECT 1`)).toThrowError(/poisoned/);
    expect(() => db.tx(() => undefined)).toThrowError(/poisoned/);
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
