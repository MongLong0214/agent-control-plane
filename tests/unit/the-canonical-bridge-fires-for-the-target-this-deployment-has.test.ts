import { afterAll, describe, expect, it } from "vitest";

import {
  startTelegramLongPollListener,
  type TelegramBotTransport,
  type TelegramGetUpdatesOptions,
} from "../../src/ingress/telegram-polling.ts";
import type { TelegramUpdate } from "../../src/ingress/telegram.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #858, the half the bridge itself could not reach.
 *
 * The bridge landed gated on `IngressGuard.receiptIdentityForClaim`, whose resolver asks for
 * `Role.CEO` bound to `executor_kind = 'hermes'` with a `hermes.target-bind/v1` attestation
 * carrying a receipt. Measured against the live deployment on 2026-09-15, every one of those is
 * empty: the only `CEO` assignment was revoked at generation 1, the one active assignment is a
 * `PRIMARY_CTO` bound to `claude-cli`, and all six attestations carry
 * `acp.canonical-self-claim/v1`. So the writer could not write, and no test said so — the two
 * cases in `the-router-hands-a-claimed-turn-to-the-canonical-ledger` measure the router handing
 * the turn over, with the coordinator replaced by a spy, and its own header records that it binds
 * no target and therefore never asserts the row.
 *
 * This is that missing assertion, against the shape the deployment actually has. It binds a
 * `claude-cli` target with a self-claim attestation — not a Hermes one — and requires a
 * `canonical_turns` row to exist afterwards.
 *
 * It enters through `startTelegramLongPollListener` and `pollOnce`, not through a re-assembled
 * copy of that wiring, because the defect was *in* the wiring: every closure here was individually
 * correct and the composition named a target this deployment cannot produce. A test that builds
 * its own guard options would have passed against the broken production root.
 */
const SECRET = "canonical-bridge-secret";
const NOW = "2026-08-12T00:00:00.000Z";

class OneUpdateTransport implements TelegramBotTransport {
  readonly redeliveryRetentionMs = 24 * 60 * 60 * 1000;
  readonly sent: string[] = [];
  #delivered = false;
  constructor(private readonly update: TelegramUpdate) {}
  async getUpdates(_options: TelegramGetUpdatesOptions): Promise<readonly TelegramUpdate[]> {
    if (this.#delivered) return [];
    this.#delivered = true;
    return [this.update];
  }
  async sendMessage(input: { text: string }): Promise<{ messageId: number }> {
    this.sent.push(input.text);
    return { messageId: this.sent.length };
  }
}

/**
 * The live deployment's own shape: a `claude-cli` executor kind and an
 * `acp.canonical-self-claim/v1` attestation, under an ACTIVE `PRIMARY_CTO` assignment whose
 * generation the attestation names. Deliberately not `hermes` and not `hermes.target-bind/v1` —
 * a fixture that used those would pass against the very resolver this change replaces.
 */
const selfClaimedTarget = (harness: ReturnType<typeof makeHarness>) => {
  const db = harness.cp.db;
  const actorId = "actor:self-claimed-cto";
  const bindingId = "bind:self-claimed-cto";
  const attestationId = "att:self-claimed-cto";
  const sessionId = "ses:self-claimed-cto";
  const assignmentId = "asg:self-claimed-cto";
  db.run(`INSERT INTO conversational_actors (actor_id, kind, created_at) VALUES (?, 'CEO', ?)`, [actorId, NOW]);
  db.run(
    `INSERT INTO actor_target_bindings
       (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
     VALUES (?, ?, 'claude-cli', ?, ?, ?)`,
    [bindingId, actorId, "root:self-claimed-cto", "digest:root:self-claimed-cto", NOW],
  );
  db.run(
    `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
     VALUES (?, 'inc-1', 'claude', 'opus', 'READY', ?, ?)`,
    [sessionId, NOW, NOW],
  );
  db.run(
    `UPDATE conversational_actors SET current_session_id = ?, current_session_incarnation = 'inc-1'
      WHERE actor_id = ?`,
    [sessionId, actorId],
  );
  db.run(
    `INSERT INTO assignments
       (assignment_id, role_key, role, actor_id, session_id, session_incarnation,
        binding_generation, mode, status, created_at)
     VALUES (?, 'PRIMARY_CTO:prj-fixture', 'PRIMARY_CTO', ?, ?, 'inc-1', 6, 'PREFERRED', 'ACTIVE', ?)`,
    [assignmentId, actorId, sessionId, NOW],
  );
  db.run(
    `INSERT INTO actor_target_attestations
       (target_attestation_id, target_binding_id, protocol_version, attestation_digest,
        executor_session_id, executor_session_incarnation, binding_generation, assignment_id,
        attested_at)
     VALUES (?, ?, 'acp.canonical-self-claim/v1', ?, ?, 'inc-1', 6, ?, ?)`,
    [attestationId, bindingId, `att-digest:${attestationId}`, sessionId, assignmentId, NOW],
  );
  return { actorId, bindingId, attestationId };
};

const ownerMessage = (updateId: number, text: string): TelegramUpdate => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1_700_000_000,
    text,
    from: { id: 424242, username: "owner" },
    chat: { id: 999 },
  },
});

const config = {
  botToken: "fixture-token",
  allowedOwnerIds: ["424242"],
  allowedChatIds: ["999"],
  webhookSecret: SECRET,
  pollTimeoutSeconds: 1,
};

describe("#858 the canonical bridge fires for the target this deployment actually has", () => {
  it("writes a canonical turn for a claude-cli self-claim target", async () => {
    const harness = makeHarness();
    const target = selfClaimedTarget(harness);
    const transport = new OneUpdateTransport(ownerMessage(8591, "원장에 남아야 하는 문장"));

    const listener = await startTelegramLongPollListener(harness.cp, config, { transport, start: false });
    try {
      await listener.service.pollOnce();
    } finally {
      await listener.close();
    }

    const rows = harness.cp.db.all<{ target_actor_id: string; target_attestation_id: string }>(
      `SELECT target_actor_id, target_attestation_id FROM canonical_turns`,
      [],
    );
    expect(rows, "the owner's message produced no canonical turn").toHaveLength(1);
    expect(rows[0]?.target_actor_id).toBe(target.actorId);
    // The attestation the turn cites has to be the one currency actually matched, not any row that
    // happens to exist: a bridge that cited a stale attestation would record a turn for a
    // generation nothing attested.
    expect(rows[0]?.target_attestation_id).toBe(target.attestationId);
  });

  it("writes nothing when the deployment has no admissible target", async () => {
    // The closed direction, and the one the bridge was stuck in. No binding at all, so
    // `canonicalTurnTarget` resolves nothing and the claim carries no target to name.
    const harness = makeHarness();
    const transport = new OneUpdateTransport(ownerMessage(8592, "타깃이 없을 때"));

    const listener = await startTelegramLongPollListener(harness.cp, config, { transport, start: false });
    try {
      await listener.service.pollOnce();
    } finally {
      await listener.close();
    }

    const rows = harness.cp.db.all<{ turn_request_id: string }>(`SELECT turn_request_id FROM canonical_turns`, []);
    expect(rows, "a turn was written with no verified target behind it").toHaveLength(0);
    // And the owner is answered exactly as before — the bridge must not turn its own refusal into
    // a reply about a ledger the owner cannot act on.
    expect(harness.cp.db.all<{ nonce: string }>(`SELECT nonce FROM inbound_messages WHERE channel = 'telegram'`, []))
      .toHaveLength(1);
  });
});
