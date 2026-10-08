import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { handOverEligibleSql } from "../../src/outbox/outbox.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { SessionLifecycle } from "../../src/domain/types.ts";
import { makeCore, seedRun } from "../helpers/fixtures.ts";

it.each(["takeover", "runtime-move"] as const)("NARROW2: %s refuses bytes that have no JSON parse", (path) => {
  const core = makeCore();
  try {
    const run = seedRun({ db: core.db, clock: core.clock, repoPath: process.cwd() });
    const enqueued = core.outbox.enqueue({
      idempotencyKey: "narrow2-malformed", roleKey: run.roleKey, bindingGeneration: run.generation,
      targetSessionId: run.sessionId, runId: run.runId, kind: MessageKind.OWNER_MESSAGE,
      payload: { sourceChannel: "buzz", sourceNonce: "buzz-message:fresh", sourcePayloadDigest: "sha256:fresh" },
    });
    if (!enqueued.allowed) throw new Error(enqueued.message);
    core.db.run("UPDATE outbox SET payload_json = ? WHERE message_id = ?", ["{invalid", enqueued.value.messageId]);
    const successor = core.sessions.create({ provider: "claude", model: "successor" });
    expect(core.sessions.transition(successor.sessionId, SessionLifecycle.READY, "failover").allowed).toBe(true);
    const result = path === "takeover"
      ? core.outbox.retargetOrReject(run.roleKey, run.generation, run.generation + 1, successor.sessionId)
      : core.outbox.carryHolderMessagesToRuntime(run.roleKey, run.generation, run.sessionId, successor.sessionId);
    expect("retargeted" in result ? result.retargeted : result.carried).toEqual([]);
    expect(result.rejected).toEqual([enqueued.value.messageId]);
  } finally {
    core.db.close();
  }
});

it.each(["selecting read", "moving write"] as const)("NARROW2: the shared SQL %s refuses deep repeated keys", (layer) => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE outbox (message_id TEXT, payload_json TEXT);
      CREATE TABLE holder_message_departures (message_id TEXT);
      CREATE TABLE holder_message_source_departures (source_channel TEXT, source_nonce TEXT, reason TEXT);`);
    const payload = '{"deep":' + "[".repeat(1001) + '{"k":1,"k":2}' + "]".repeat(1001) + "}";
    expect(() => JSON.parse(payload)).not.toThrow();
    expect(db.prepare("SELECT json_valid(?) AS valid").get(payload)).toEqual({ valid: 0 });
    db.prepare("INSERT INTO outbox VALUES (?, ?)").run("narrow2-deep", payload);
    if (layer === "selecting read") {
      expect(db.prepare(`SELECT ${handOverEligibleSql("o")} AS eligible FROM outbox o`).get())
        .toEqual({ eligible: 0 });
    } else {
      expect(db.prepare(`UPDATE outbox SET message_id = message_id WHERE ${handOverEligibleSql("outbox")}`).run().changes)
        .toBe(0);
    }
  } finally {
    db.close();
  }
});
