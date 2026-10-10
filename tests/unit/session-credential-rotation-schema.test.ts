import { createHash } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { SessionLifecycle } from "../../src/domain/types.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * Issue #246 PR-C slice C1b, schema v42 — what a credential rotation is, said by the database: the
 * secret hash is replaced only by the statement that also moves `credential_epoch` up by exactly one,
 * on a READY row that keeps its session id and incarnation. Every row writes raw SQL, the way a
 * writer that bypassed `SessionRegistry.rotateSecret` would.
 */
const hashOf = (secret: string): string => createHash("sha256").update(secret, "utf8").digest("hex");

const readySession = () => {
  const harness = makeHarness();
  const created = harness.cp.sessions.create({ provider: "claude", model: "opus" });
  harness.cp.sessions.transition(created.sessionId, SessionLifecycle.READY, "fixture");
  return { harness, sessionId: created.sessionId };
};

describe("v42: a session's credential is replaced only by a rotation", () => {
  it("a new session starts at epoch 0, and a row inserted ahead of its own history is refused", () => {
    const { harness, sessionId } = readySession();
    expect(harness.cp.sessions.require(sessionId).credentialEpoch).toBe(0);
    expect(() => harness.cp.db.run(
      `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, session_secret_hash,
                             credential_epoch, created_at, updated_at)
       VALUES ('ses_forged', 'ses_forged#1', 'claude', 'opus', 'READY', ?, 3, 'now', 'now')`,
      [hashOf("forged")],
    )).toThrow(/SESSION_CREDENTIAL_EPOCH_INVALID|credential epoch/i);
  });

  it("the legitimate rotation — epoch +1 with a new hash, READY, same row and incarnation — is allowed", () => {
    const { harness, sessionId } = readySession();
    harness.cp.db.run(
      `UPDATE sessions SET session_secret_hash = ?, credential_epoch = credential_epoch + 1 WHERE session_id = ?`,
      [hashOf("rotated"), sessionId],
    );
    expect(harness.cp.sessions.require(sessionId).credentialEpoch).toBe(1);
    expect(harness.cp.sessions.verifySecret(sessionId, "rotated").allowed).toBe(true);
  });

  it.each([
    ["the hash alone", `UPDATE sessions SET session_secret_hash = ? WHERE session_id = ?`, /SESSION_SECRET_HASH_IMMUTABLE|conflict/i],
    ["the hash cleared with the epoch", `UPDATE sessions SET session_secret_hash = NULL, credential_epoch = credential_epoch + 1 WHERE session_id = ? AND ? IS NOT NULL`, /SESSION_SECRET_HASH_IMMUTABLE|SESSION_CREDENTIAL_EPOCH_INVALID|conflict|epoch/i],
    ["the hash with the epoch skipped ahead", `UPDATE sessions SET session_secret_hash = ?, credential_epoch = credential_epoch + 2 WHERE session_id = ?`, /SESSION_SECRET_HASH_IMMUTABLE|SESSION_CREDENTIAL_EPOCH_INVALID|conflict|epoch/i],
  ] as const)("refuses %s", (_name, statement, refusal) => {
    const { harness, sessionId } = readySession();
    const params = statement.includes("NULL") ? [sessionId, "x"] : [hashOf("other"), sessionId];
    expect(() => harness.cp.db.run(statement, params)).toThrow(refusal);
    expect(harness.cp.sessions.require(sessionId).credentialEpoch).toBe(0);
  });

  it("refuses the epoch moved alone, moved back, or moved on a session that is not READY", () => {
    const { harness, sessionId } = readySession();
    expect(() => harness.cp.db.run(`UPDATE sessions SET credential_epoch = credential_epoch + 1 WHERE session_id = ?`, [sessionId]))
      .toThrow(/SESSION_CREDENTIAL_EPOCH_INVALID|epoch/i);
    harness.cp.db.run(
      `UPDATE sessions SET session_secret_hash = ?, credential_epoch = 1 WHERE session_id = ?`,
      [hashOf("first"), sessionId],
    );
    expect(() => harness.cp.db.run(
      `UPDATE sessions SET session_secret_hash = ?, credential_epoch = 0 WHERE session_id = ?`,
      [hashOf("back"), sessionId],
    )).toThrow(/SESSION_SECRET_HASH_IMMUTABLE|SESSION_CREDENTIAL_EPOCH_INVALID|conflict|epoch/i);
    harness.cp.sessions.transition(sessionId, SessionLifecycle.STOPPED, "fixture");
    expect(() => harness.cp.db.run(
      `UPDATE sessions SET session_secret_hash = ?, credential_epoch = 2 WHERE session_id = ?`,
      [hashOf("stopped"), sessionId],
    )).toThrow(/SESSION_SECRET_HASH_IMMUTABLE|SESSION_CREDENTIAL_EPOCH_INVALID|conflict|epoch/i);
    expect(harness.cp.sessions.require(sessionId).credentialEpoch).toBe(1);
  });

  it("the incarnation stays absolute: a rotation cannot carry a new incarnation", () => {
    const { harness, sessionId } = readySession();
    expect(() => harness.cp.db.run(
      `UPDATE sessions SET session_secret_hash = ?, credential_epoch = 1, incarnation = incarnation || ':moved' WHERE session_id = ?`,
      [hashOf("moved"), sessionId],
    )).toThrow(/SESSION_INCARNATION_IMMUTABLE|SESSION_SECRET_HASH_IMMUTABLE|epoch|incarnation/i);
  });

  it("SessionRegistry.rotateSecret is the compare-and-set: a stale expected epoch writes nothing", () => {
    const { harness, sessionId } = readySession();
    const first = harness.cp.sessions.rotateSecret(sessionId, 0);
    expect(first).toMatchObject({ allowed: true, value: { session: { credentialEpoch: 1 } } });
    const stale = harness.cp.sessions.rotateSecret(sessionId, 0);
    expect(stale).toMatchObject({ allowed: false, reasonCode: ReasonCode.SESSION_CREDENTIAL_EPOCH_STALE });
    expect(harness.cp.sessions.require(sessionId).credentialEpoch).toBe(1);
    // The plaintext left the registry once and authenticates; the previous one does not.
    if (!first.allowed) throw new Error("rotation refused");
    expect(harness.cp.sessions.verifySecret(sessionId, first.value.sessionSecret).allowed).toBe(true);
    const audit = harness.cp.db.all<{ evidence_json: string }>(
      `SELECT evidence_json FROM audit_events WHERE kind = 'SESSION_CREDENTIAL_ROTATED' AND session_id = ?`, [sessionId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.evidence_json).not.toContain(first.value.sessionSecret);
  });
});
