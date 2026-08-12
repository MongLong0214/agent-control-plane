import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";

import { canonicalJson, digestOf } from "../../src/core/digest.ts";
import {
  acpError,
  errorPayload,
  fromErrorPayload,
  isAcpError,
} from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Db, SCHEMA_VERSION } from "../../src/db/database.ts";
import { redact } from "../../src/db/audit.ts";
import { legalTargets } from "../../src/domain/run-state.ts";
import { ArtifactKind, RunState } from "../../src/domain/types.ts";
import { cleanupTempDirs, makeCore, makeRepo, seedRun, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * Regressions for the defects an independent GPT-5.6 Sol review found in the trusted
 * core. Each closes a way authoritative evidence could be forged, rebound or erased.
 */
describe("evidence can only be written by the engine that owns it", () => {
  const setup = () => {
    const core = makeCore();
    const repo = makeRepo();
    const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: repo });
    return { ...core, seeded };
  };

  it("a general caller cannot mint a verification or review artifact", () => {
    const { artifacts, seeded } = setup();
    expect(() =>
      artifacts.put(seeded.runId, ArtifactKind.VERIFICATION, { status: "PASS" }, "sha256:x"),
    ).toThrowError(/must be written through putEvidence/);
    expect(() =>
      artifacts.put(seeded.runId, ArtifactKind.BLIND_REVIEW, { verdict: "PASS" }, "sha256:x"),
    ).toThrowError(/must be written through putEvidence/);
  });

  it("putEvidence refuses a producer that does not own the kind", () => {
    const { artifacts, seeded } = setup();
    expect(() =>
      artifacts.putEvidence(
        "blind-review-gate",
        seeded.runId,
        ArtifactKind.VERIFICATION,
        { status: "PASS" },
        "sha256:x",
      ),
    ).toThrowError(/may not write VERIFICATION/);

    const written = artifacts.putEvidence(
      "verification-engine",
      seeded.runId,
      ArtifactKind.VERIFICATION,
      { status: "PASS" },
      "sha256:x",
    );
    expect(written.producedBy).toBe("verification-engine");
  });

  it("evidence cannot be rebound to another candidate, edited or deleted", () => {
    const { db, artifacts, seeded } = setup();
    artifacts.putEvidence(
      "verification-engine",
      seeded.runId,
      ArtifactKind.VERIFICATION,
      { status: "PASS" },
      "sha256:candidate-a",
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

describe("binding identity is immutable once written", () => {
  it("generation, role key, session and incarnation cannot be updated in place", () => {
    const { db, clock } = makeCore();
    const repo = makeRepo();
    const seeded = seedRun({ db, clock, repoPath: repo });

    // Lowering the generation would reactivate stale authority.
    expect(() =>
      db.run(`UPDATE assignments SET binding_generation = 1 WHERE role_key = ?`, [seeded.roleKey]),
    ).not.toThrow(); // already 1: a no-op update is fine
    expect(() =>
      db.run(`UPDATE assignments SET binding_generation = 5 WHERE role_key = ?`, [seeded.roleKey]),
    ).toThrowError(/BINDING_IDENTITY_IMMUTABLE/);
    expect(() =>
      db.run(`UPDATE assignments SET role_key = 'CEO' WHERE role_key = ?`, [seeded.roleKey]),
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
    const repo = makeRepo();
    const seeded = seedRun({ db, clock, repoPath: repo });

    db.tx(() => db.run(`UPDATE runs SET goal = 'committed' WHERE run_id = ?`, [seeded.runId]));
    expect(db.get<{ goal: string }>(`SELECT goal FROM runs WHERE run_id = ?`, [seeded.runId])?.goal).toBe(
      "committed",
    );

    expect(() =>
      db.tx(() => {
        db.run(`UPDATE runs SET goal = 'rolled back' WHERE run_id = ?`, [seeded.runId]);
        throw new Error("boom");
      }),
    ).toThrowError("boom");
    expect(db.get<{ goal: string }>(`SELECT goal FROM runs WHERE run_id = ?`, [seeded.runId])?.goal).toBe(
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
