import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";

/**
 * Which Hermes session an actor's conversation is served from now — its head — and the one rule
 * for when a Gateway-reported head may replace it.
 *
 * `actor_target_bindings` pins a conversation by its lineage root digest and records the head the
 * binding was born with as `target_locator`. Hermes rotates the head when it compresses a
 * conversation: same lineage, same conversation, a new session id. The born head was then pinned a
 * second time, by hand, in the Keychain (`ACP_HERMES_EXPECTED_LIVE_SESSION_ID`,
 * `ACP_HERMES_TARGET_SESSION_ID`), and every rotation stopped adoption, the adopted CEO's tools and
 * Gateway delivery until an operator rewrote both values and restarted the daemon (2026-10-03).
 *
 * That second pin is withdrawn rather than automated. The lineage root digest already says it is
 * the same conversation, and the head comes from the Gateway's authenticated identity endpoint,
 * which reports the head of the binding it actually serves, from the process whose pid and native
 * start ACP reads for itself. A person confirming the head again added no fact the system lacked.
 *
 * `target_locator` cannot be rewritten: `actor_target_bindings_immutable` refuses every UPDATE
 * (CP-HI-04) and the migration list is frozen. So an accepted head is appended as an
 * `ACTOR_TARGET_HEAD_ADVANCED` audit event for the binding rather than written over the born locator,
 * and the newest one is the head — the same shape as the native start pin
 * (`SessionRegistry.pinnedNativeStart`). Every path that compares a Gateway head with the stored
 * target reads it through `readHermesTargetHead` and decides it with `judgeLiveHead`: incumbent
 * adoption, the adopted CEO's tool admission, and Gateway delivery.
 */

export const TARGET_HEAD_ADVANCED = "ACTOR_TARGET_HEAD_ADVANCED";

export interface HermesTargetHead {
  targetBindingId: string;
  actorId: string;
  executorKind: string;
  lineageRootDigest: string;
  /** The head the binding was born with; immutable (CP-HI-04). */
  bornLocator: string;
  /** The head served now: the newest recorded advance, else the born head. */
  head: string;
}

/** The two fields of a Gateway identity readback the head rule reads. */
export interface ReportedHead {
  session_id: string;
  lineage_root_digest: string;
}

export type LiveHeadJudgement =
  | { verdict: "SAME"; head: string }
  | { verdict: "ADVANCE"; head: string; previousHead: string }
  | { verdict: "REFUSE"; message: string };

/** A head as the Gateway identity reader admits one: non-empty, bounded, no control characters. */
export const isHermesHead = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);

const latestAdvance = (
  db: Db,
  row: { target_binding_id: string; target_actor_id: string; target_locator_digest: string },
): string | null => {
  const advanced = db.get<{ head: unknown }>(
    `SELECT json_extract(evidence_json, '$.head') AS head
       FROM audit_events
      WHERE kind = ?
        AND json_extract(evidence_json, '$.targetBindingId') = ?
        AND json_extract(evidence_json, '$.actorId') = ?
        AND json_extract(evidence_json, '$.lineageRootDigest') = ?
      ORDER BY event_id DESC
      LIMIT 1`,
    [TARGET_HEAD_ADVANCED, row.target_binding_id, row.target_actor_id, row.target_locator_digest],
  );
  return advanced !== undefined && isHermesHead(advanced.head) ? advanced.head : null;
};

/** The actor's one target binding and its current head, or null when it has none. */
export const readHermesTargetHead = (db: Db, actorId: string): HermesTargetHead | null => {
  const rows = db.all<{
    target_binding_id: string;
    target_actor_id: string;
    executor_kind: string;
    target_locator: string;
    target_locator_digest: string;
  }>(
    `SELECT target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest
       FROM actor_target_bindings WHERE target_actor_id = ?`,
    [actorId],
  );
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  return {
    targetBindingId: row.target_binding_id,
    actorId: row.target_actor_id,
    executorKind: row.executor_kind,
    lineageRootDigest: row.target_locator_digest,
    bornLocator: row.target_locator,
    head: latestAdvance(db, row) ?? row.target_locator,
  };
};

/**
 * Every head the binding has served: the born head and each recorded advance. A target-bind
 * receipt names the head that was live when it was attested, which a later advance leaves behind.
 */
export const servedHermesHeads = (
  db: Db,
  row: { target_binding_id: string; target_actor_id: string; target_locator: string; target_locator_digest: string },
): ReadonlySet<string> => {
  const advanced = db.all<{ head: unknown }>(
    `SELECT json_extract(evidence_json, '$.head') AS head
       FROM audit_events
      WHERE kind = ?
        AND json_extract(evidence_json, '$.targetBindingId') = ?
        AND json_extract(evidence_json, '$.actorId') = ?
        AND json_extract(evidence_json, '$.lineageRootDigest') = ?`,
    [TARGET_HEAD_ADVANCED, row.target_binding_id, row.target_actor_id, row.target_locator_digest],
  );
  const heads = new Set<string>([row.target_locator]);
  for (const { head } of advanced) if (isHermesHead(head)) heads.add(head);
  return heads;
};

/**
 * The one head rule. Another executor or another lineage is refused; inside the lineage, the head
 * the Gateway reports is the head. The caller must already have tied the report to the bound
 * process (pid and native start read by ACP); this decides only the conversation.
 */
export const judgeLiveHead = (target: HermesTargetHead, reported: ReportedHead): LiveHeadJudgement => {
  if (target.executorKind !== "hermes") return { verdict: "REFUSE", message: "the target is not a Hermes conversation" };
  if (reported.lineage_root_digest !== target.lineageRootDigest) {
    return { verdict: "REFUSE", message: "the Gateway serves another lineage" };
  }
  if (!isHermesHead(reported.session_id)) return { verdict: "REFUSE", message: "the Gateway reported no usable head" };
  if (reported.session_id === target.head) return { verdict: "SAME", head: target.head };
  return { verdict: "ADVANCE", head: reported.session_id, previousHead: target.head };
};

/**
 * Appends the advance. Call inside the transaction that also re-checks the authority it serves,
 * so the head and that authority commit or roll back together; a SAME judgement writes nothing.
 */
export const recordHeadAdvance = (
  audit: AuditLog,
  target: HermesTargetHead,
  judgement: Extract<LiveHeadJudgement, { verdict: "ADVANCE" }>,
  context: { path: "adoption" | "tool_admission" | "gateway_delivery"; sessionId: string; roleKey: string;
    bindingGeneration: number; gatewayPid: number },
): Decision<void> => {
  const recorded = audit.record({
    kind: TARGET_HEAD_ADVANCED,
    reasonCode: ReasonCode.OK,
    sessionId: context.sessionId,
    roleKey: context.roleKey,
    evidence: {
      targetBindingId: target.targetBindingId,
      actorId: target.actorId,
      lineageRootDigest: target.lineageRootDigest,
      previousHead: judgement.previousHead,
      head: judgement.head,
      path: context.path,
      bindingGeneration: context.bindingGeneration,
      gatewayPid: context.gatewayPid,
    },
  });
  return recorded.allowed ? allow(ReasonCode.OK, undefined)
    : deny(ReasonCode.CONFLICT, "the Gateway head could not be recorded", {});
};
