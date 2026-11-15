import { randomUUID } from "node:crypto";

import { digestOf, sha256 } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { type FailureClass, Role, roleKeyFor } from "../domain/types.ts";
import { HOLDER_CLAIMED_KIND_SQL, outboxDeliveryReadback } from "../outbox/outbox.ts";
import { LIVE_RUN_STATES } from "../session/binding-registry.ts";
import { SELF_CLAIM_EXECUTOR_KIND } from "./canonical-self-claim.ts";
import { type CanonicalEntitlementTransfer, CanonicalSessionRegistry } from "./canonical-session-registry.ts";

/**
 * v58 — the record half of a canonical PRIMARY_CTO switchover (PRD §10.1) to a new conversation UUID of the SAME
 * conversational actor. `CtoLifecycle.prepareCanonicalSwitchover` owns the switchover rules (the outgoing holder is
 * canonical, owns zero live runs, hands over a complete package, and drains); this module records it and is read by
 * the new conversation's self-claim, which is the switchover's acknowledgement.
 *
 * A switchover rides a v57 entitlement transfer (`CanonicalSessionRegistry.transfer`, which checks the project, that
 * the old conversation is its holder, the role's generation, that the new conversation was never entitled, and that
 * no worker turn or pipeline attempt of the project is RUNNING) plus a `canonical_cto_rotations` row naming the actor
 * that keeps the role. Knowing a UUID grants nothing: the new conversation is admissible only on its own claim of
 * exactly that pending transfer, at exactly `toGeneration`, and only an authenticated owner records one.
 */

export interface CanonicalCtoRotationRequest {
  projectId: string;
  toSessionUuid: string;
  /** The role's CURRENT (highest) binding generation; the claim is issued `expectedGeneration + 1`. */
  expectedGeneration: number;
}

/** What the outgoing holder left: owner and peer messages queued and never handed over, and handed over and never ACKed. */
export interface CanonicalCtoCarried {
  pendingMessageIds: string[];
  inFlightMessageIds: string[];
}

export interface CanonicalCtoRotation {
  transferId: string;
  actorId: string;
  targetBindingId: string;
  fromSessionId: string;
  fromGeneration: number;
  toGeneration: number;
  packageJson: string;
  handoffId: string | null;
  carried: CanonicalCtoCarried | null;
}

interface RotationRow {
  transfer_id: string; actor_id: string; target_binding_id: string; from_session_id: string; from_generation: number;
  to_generation: number; package_json: string; handoff_id: string | null; carried_json: string | null;
}
const rotationOf = (row: RotationRow): CanonicalCtoRotation => ({
  transferId: row.transfer_id, actorId: row.actor_id, targetBindingId: row.target_binding_id, fromSessionId: row.from_session_id,
  fromGeneration: row.from_generation, toGeneration: row.to_generation, packageJson: row.package_json, handoffId: row.handoff_id,
  carried: row.carried_json === null ? null : JSON.parse(row.carried_json) as CanonicalCtoCarried,
});

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const roleKeyOf = (projectId: string) => roleKeyFor(Role.PRIMARY_CTO, { projectId });

export const highestGeneration = (db: Pick<Db, "get">, roleKey: string): number =>
  db.get<{ maximum: number | null }>(`SELECT MAX(binding_generation) AS maximum FROM assignments WHERE role_key = ?`, [roleKey])
    ?.maximum ?? 0;

/** The switchover riding transfer `transferId`, or null when that transfer is not one. */
export const rotationOfTransfer = (db: Pick<Db, "get">, transferId: string): CanonicalCtoRotation | null => {
  const row = db.get<RotationRow>(`SELECT * FROM canonical_cto_rotations WHERE transfer_id = ?`, [transferId]);
  return row === undefined ? null : rotationOf(row);
};

/** The project's unacknowledged switchover and its transfer, or null. */
export const pendingRotationOf = (db: Db, projectId: string): { transfer: CanonicalEntitlementTransfer; rotation: CanonicalCtoRotation } | null => {
  const row = db.get<{ transfer_id: string }>(
    `SELECT t.transfer_id FROM canonical_entitlement_transfers t JOIN canonical_cto_rotations r ON r.transfer_id = t.transfer_id
      WHERE t.project_id = ? AND t.claimed_at IS NULL AND t.revoked_at IS NULL`,
    [projectId],
  );
  if (row === undefined) return null;
  const transfer = new CanonicalSessionRegistry(db).transferById(row.transfer_id);
  const rotation = rotationOfTransfer(db, row.transfer_id);
  return transfer === null || rotation === null ? null : { transfer, rotation };
};

/**
 * The message half of the drain: whether `holder` is the generation an unacknowledged switchover was prepared from.
 * While it is, the hand-over gives that holder no message it was not already handed; what it holds it may finish.
 * (The run half is the outgoing session's DRAINING lifecycle: its project's runs queue.)
 */
export const drainingRotationFor = (
  db: Pick<Db, "get">,
  holder: { roleKey: string; bindingGeneration: number },
): { transferId: string; toGeneration: number } | null => {
  const row = db.get<{ transfer_id: string; to_generation: number }>(
    `SELECT r.transfer_id, r.to_generation FROM canonical_cto_rotations r
       JOIN canonical_entitlement_transfers t ON t.transfer_id = r.transfer_id
      WHERE 'PRIMARY_CTO:' || t.project_id = ? AND r.from_generation = ?
        AND t.claimed_at IS NULL AND t.revoked_at IS NULL`,
    [holder.roleKey, holder.bindingGeneration],
  );
  return row === undefined ? null : { transferId: row.transfer_id, toGeneration: row.to_generation };
};

/** The live runs `sessionId` owns, by id: the switchover barrier, the same states `RunEngine.activeRunsOwnedBy` reads. */
export const liveRunIdsOwnedBySession = (db: Pick<Db, "all">, sessionId: string): string[] =>
  db.all<{ run_id: string }>(
    `SELECT run_id FROM runs WHERE owner_session_id = ? AND state IN (${LIVE_RUN_STATES.map(() => "?").join(",")}) ORDER BY run_id`,
    [sessionId, ...LIVE_RUN_STATES],
  ).map((row) => row.run_id);

/**
 * What the role's holders leave behind: owner and peer messages of the role still queued and never handed to anyone,
 * apart from those handed over (or whose hand-over is unknown) and never ACKed, read through the shared readback.
 * Both are carried to the new holder under their ids; an in-flight one is redelivered, so its new holder dedupes by id
 * and checks what the old one already did.
 */
export const carriedMessagesOf = (db: Pick<Db, "all">, roleKey: string): CanonicalCtoCarried => {
  const messages = db.all<{ message_id: string; status: "PENDING" | "SENT"; failure_class: FailureClass | null }>(
    `SELECT message_id, status, failure_class FROM outbox WHERE role_key = ? AND kind IN (${HOLDER_CLAIMED_KIND_SQL})
       AND status IN ('PENDING','SENT') ORDER BY created_at, message_id`,
    [roleKey],
  );
  const queued = (row: (typeof messages)[number]) => outboxDeliveryReadback({ status: row.status, failureClass: row.failure_class }).status === "PENDING";
  return {
    pendingMessageIds: messages.filter(queued).map((row) => row.message_id),
    inFlightMessageIds: messages.filter((row) => !queued(row)).map((row) => row.message_id),
  };
};

/**
 * Records a forward switchover in the caller's transaction, from `fromSessionId`'s ACTIVE binding: the project's
 * canonical conversation must be held, at exactly `expectedGeneration`, by the actor whose claude-cli target is that
 * conversation; the transfer's own checks follow (a `toSessionUuid` another actor targets is refused at the claim's
 * retarget by the binding's own uniqueness).
 */
export const recordCanonicalRotation = (
  db: Db,
  request: CanonicalCtoRotationRequest,
  outgoing: { sessionId: string; packageJson: string },
  requestedBy: string,
  at: string,
): Decision<{ transfer: CanonicalEntitlementTransfer; rotation: CanonicalCtoRotation }> => {
  if (!db.inTransaction) return deny(ReasonCode.CONFLICT, "a canonical switchover is recorded in the caller's transaction", {});
  const { projectId, toSessionUuid, expectedGeneration } = request;
  if (typeof toSessionUuid !== "string" || !LOWER_UUID.test(toSessionUuid)) {
    return deny(ReasonCode.INVALID_ARGUMENT, "toSessionUuid must be a lower-case UUID", {});
  }
  const registry = new CanonicalSessionRegistry(db);
  const roleKey = roleKeyOf(projectId);
  const holder = registry.holder(projectId);
  if (holder === null) return deny(ReasonCode.NOT_FOUND, "the project has no canonical entitlement to switch over", { projectId });
  const generation = highestGeneration(db, roleKey);
  if (generation !== expectedGeneration) {
    return deny(ReasonCode.BINDING_GENERATION_STALE, "expectedGeneration is not the role's current generation", {
      roleKey, expected: expectedGeneration, actual: generation,
    });
  }
  // The current actor: the claude-cli target naming the project's conversation, whose ACTIVE binding at the role's
  // current generation is the outgoing session.
  const target = db.get<{ target_binding_id: string; target_actor_id: string }>(
    `SELECT target_binding_id, target_actor_id FROM actor_target_bindings
      WHERE executor_kind = ? AND target_locator = ? AND target_locator_digest = ?`,
    [SELF_CLAIM_EXECUTOR_KIND, holder.sessionUuid, sha256(holder.sessionUuid)],
  );
  const current = target === undefined ? undefined : db.get<{ actor_id: string; retired_at: string | null }>(
    `SELECT a.actor_id, c.retired_at FROM assignments a JOIN conversational_actors c ON c.actor_id = a.actor_id
      WHERE a.role_key = ? AND a.binding_generation = ? AND a.status = 'ACTIVE' AND a.session_id = ?`,
    [roleKey, generation, outgoing.sessionId],
  );
  if (target === undefined || current === undefined || current.actor_id !== target.target_actor_id || current.retired_at !== null) {
    return deny(ReasonCode.CONFLICT, "the role's current binding is not held by the actor of the project's canonical conversation", {
      projectId, generation,
    });
  }
  const transferred = registry.transfer(
    { projectId, fromSessionUuid: holder.sessionUuid, toSessionUuid, expectedBindingGeneration: generation }, requestedBy, at);
  if (!transferred.allowed) return transferred as Decision<never>;
  const transfer = transferred.value;
  db.run(
    `INSERT INTO canonical_cto_rotations (transfer_id, actor_id, target_binding_id, from_session_id, from_generation, to_generation, package_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [transfer.transferId, target.target_actor_id, target.target_binding_id, outgoing.sessionId, generation, generation + 1, outgoing.packageJson],
  );
  return allow(ReasonCode.OK, { transfer, rotation: rotationOfTransfer(db, transfer.transferId)! });
};

/**
 * The claim's half, inside `CanonicalSelfClaim`'s transaction: the switchover's actor still targets the transfer's
 * old conversation, and that target moves to the claimed one. The guard on `actor_target_bindings` admits this rewrite
 * only for exactly this unacknowledged switchover, so a refusal there is a refusal here.
 */
export const retargetRotatedActor = (
  db: Db,
  rotation: CanonicalCtoRotation,
  transfer: CanonicalEntitlementTransfer,
  claimedSessionUuid: string,
): Decision<void> => {
  if (!db.inTransaction) return deny(ReasonCode.CONFLICT, "a switchover's retarget requires the claim's transaction", {});
  if (claimedSessionUuid !== transfer.toSessionUuid) {
    return deny(ReasonCode.CONFLICT, "the claimed conversation is not the one the switchover names", {});
  }
  try {
    const moved = db.run(
      `UPDATE actor_target_bindings SET target_locator = ?, target_locator_digest = ?
        WHERE target_binding_id = ? AND target_actor_id = ? AND executor_kind = ? AND target_locator = ?`,
      [claimedSessionUuid, sha256(claimedSessionUuid), rotation.targetBindingId, rotation.actorId, SELF_CLAIM_EXECUTOR_KIND,
        transfer.fromSessionUuid],
    ).changes;
    if (moved !== 1) return deny(ReasonCode.CONFLICT, "the switchover's actor no longer targets the old conversation", {});
  } catch (error) {
    return deny(ReasonCode.CONFLICT, "the switchover's retarget was refused", { error: error instanceof Error ? error.message : String(error) });
  }
  return allow(ReasonCode.OK, undefined);
};

/**
 * The acknowledgement's record, once, in the claim's transaction after the same actor is bound at `toGeneration`: the
 * ACKED `handoffs` row from the outgoing session and generation to the claimed session with the package the owner
 * submitted, its `HANDOFF_ACK` row, and what was carried, on the switchover.
 */
export const recordRotationAcknowledged = (
  db: Db,
  audit: AuditLog,
  rotation: CanonicalCtoRotation,
  transfer: CanonicalEntitlementTransfer,
  incoming: { sessionId: string; generation: number },
  carried: CanonicalCtoCarried,
  at: string,
): Decision<string> => {
  const handoffId = `hof_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const handoff = JSON.parse(rotation.packageJson) as unknown;
  try {
    db.run(
      `INSERT INTO handoffs (handoff_id, project_id, kind, from_session_id, from_generation, to_session_id, package_json, digest,
                             status, created_at, acked_at, ack_by_session_id)
       VALUES (?, ?, 'HANDOFF', ?, ?, ?, ?, ?, 'ACKED', ?, ?, ?)`,
      [handoffId, transfer.projectId, rotation.fromSessionId, rotation.fromGeneration, incoming.sessionId, rotation.packageJson,
        digestOf(handoff), transfer.createdAt, at, incoming.sessionId],
    );
    db.run(
      `UPDATE canonical_cto_rotations SET handoff_id = ?, carried_json = ?, revision = revision + 1
        WHERE transfer_id = ? AND handoff_id IS NULL`,
      [handoffId, JSON.stringify(carried), rotation.transferId],
    );
  } catch (error) {
    return deny(ReasonCode.CONFLICT, "the switchover's acknowledgement could not be recorded", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  let recorded: Decision<number>;
  try {
    recorded = audit.record({
      kind: "HANDOFF_ACK", reasonCode: ReasonCode.OK, projectId: transfer.projectId, roleKey: roleKeyOf(transfer.projectId),
      sessionId: incoming.sessionId, actor: transfer.requestedBy,
      evidence: { handoffId, fromGeneration: rotation.fromGeneration, toGeneration: incoming.generation, transferId: transfer.transferId,
        actorId: rotation.actorId, fromSessionUuid: transfer.fromSessionUuid, toSessionUuid: transfer.toSessionUuid, ...carried },
    });
  } catch (error) {
    recorded = deny(ReasonCode.AUDIT_WRITE_FAILED, error instanceof Error ? error.message : String(error), {});
  }
  return recorded.allowed ? allow(ReasonCode.OK, handoffId) : recorded as Decision<never>;
};

/** The project's switchovers, newest first, with their state. Read-only. */
export const canonicalCtoRotations = (db: Pick<Db, "all">, projectId: string) =>
  db.all<RotationRow & { from_session_uuid: string; to_session_uuid: string; created_at: string; claimed_at: string | null; revoked_at: string | null }>(
    `SELECT r.*, t.from_session_uuid, t.to_session_uuid, t.created_at, t.claimed_at, t.revoked_at
       FROM canonical_cto_rotations r JOIN canonical_entitlement_transfers t ON t.transfer_id = r.transfer_id
      WHERE t.project_id = ? ORDER BY t.created_at DESC, r.transfer_id`,
    [projectId],
  ).map((row) => {
    const { packageJson: _package, ...rotation } = rotationOf(row);
    return {
      ...rotation, fromSessionUuid: row.from_session_uuid, toSessionUuid: row.to_session_uuid, createdAt: row.created_at,
      state: row.claimed_at !== null ? "ACKED" as const : row.revoked_at !== null ? "ROLLED_BACK" as const : "PENDING" as const,
    };
  });
