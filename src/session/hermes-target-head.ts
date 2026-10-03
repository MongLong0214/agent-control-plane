import { canonicalJson, sha256 } from "../core/digest.ts";
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
 *
 * The audit writer is not a lossless store: it redacts secret-shaped text and refuses long
 * unidentified fields (`AuditLog.record`). So an advance row carries the head's digest
 * (`hermesHeadDigest`) beside the head as display text, readers go by the digests and use the text
 * only where it hashes to its digest, and the writer reads its own row back inside the transaction:
 * a head that would not be stored exactly rolls the transaction back and is refused (PR #1053
 * review, ACP1053-03). A head only moves forward: compare-and-set on the stored head, and never to
 * a head the binding has already served.
 */

export const TARGET_HEAD_ADVANCED = "ACTOR_TARGET_HEAD_ADVANCED";

export interface HermesTargetHead {
  targetBindingId: string;
  actorId: string;
  executorKind: string;
  lineageRootDigest: string;
  /** The head the binding was born with; immutable (CP-HI-04). */
  bornLocator: string;
  /** The head served now, exactly: the newest recorded advance, else the born head. */
  head: string;
  /** `hermesHeadDigest(head)`, the form the head rule compares. */
  headDigest: string;
  /** Every head the binding has served, born head first and `head` last; none appears twice. */
  history: readonly string[];
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

/**
 * A head every path accepts, stored or reported. Hermes session ids look like
 * `20261001_123456_a1b2c3` (the suffix length varies); this is a conservative bound rather than that
 * format: at most 128 characters of `[A-Za-z0-9_.:-]`.
 */
export const isHermesHead = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);

/** The exact form of a head in an advance row, which the audit writer's redaction leaves intact. */
export const hermesHeadDigest = (head: string): string => sha256(head);

/** Thrown when an advance row does not read back exactly; it rolls the transaction back. */
const HEAD_NOT_RECORDED = Symbol("hermes-target-head.not-recorded");
const headNotRecorded = (): Error =>
  Object.assign(new Error("the Gateway head could not be recorded exactly"), { [HEAD_NOT_RECORDED]: true as const });
const isHeadNotRecorded = (error: unknown): error is Error =>
  error instanceof Error && HEAD_NOT_RECORDED in error;

type TargetRow = { target_binding_id: string; target_actor_id: string; target_locator: string; target_locator_digest: string };

/**
 * The binding's heads, born head first, read and checked one way for every reader. A recorded
 * advance counts by its digests: its display head is taken only when it hashes to `headDigest`, it
 * must continue the head before it (`previousHeadDigest`), and it must not return to a head already
 * served. Anything else makes the whole history unusable (null) rather than skipping the row, since
 * a skipped newest row would hand back an older head.
 */
const headHistory = (db: Db, row: TargetRow): readonly string[] | null => {
  if (!isHermesHead(row.target_locator)) return null;
  const advances = db.all<{ head: unknown; headDigest: unknown; previousHeadDigest: unknown }>(
    `SELECT json_extract(evidence_json, '$.head') AS head,
            json_extract(evidence_json, '$.headDigest') AS headDigest,
            json_extract(evidence_json, '$.previousHeadDigest') AS previousHeadDigest
       FROM audit_events
      WHERE kind = ?
        AND json_extract(evidence_json, '$.targetBindingId') = ?
        AND json_extract(evidence_json, '$.actorId') = ?
        AND json_extract(evidence_json, '$.lineageRootDigest') = ?
      ORDER BY event_id`,
    [TARGET_HEAD_ADVANCED, row.target_binding_id, row.target_actor_id, row.target_locator_digest],
  );
  const history: string[] = [row.target_locator];
  for (const advance of advances) {
    if (!isHermesHead(advance.head)) return null;
    if (advance.headDigest !== hermesHeadDigest(advance.head)) return null;
    if (advance.previousHeadDigest !== hermesHeadDigest(history[history.length - 1]!)) return null;
    if (history.includes(advance.head)) return null;
    history.push(advance.head);
  }
  return history;
};

/** The actor's one target binding and its current head, or null when it has none or its heads are unusable. */
export const readHermesTargetHead = (db: Db, actorId: string): HermesTargetHead | null => {
  const rows = db.all<TargetRow & { executor_kind: string }>(
    `SELECT target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest
       FROM actor_target_bindings WHERE target_actor_id = ?`,
    [actorId],
  );
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  const history = headHistory(db, row);
  if (history === null) return null;
  const head = history[history.length - 1]!;
  return {
    targetBindingId: row.target_binding_id,
    actorId: row.target_actor_id,
    executorKind: row.executor_kind,
    lineageRootDigest: row.target_locator_digest,
    bornLocator: row.target_locator,
    head,
    headDigest: hermesHeadDigest(head),
    history,
  };
};

/**
 * Every head the binding has served: the born head and each recorded advance. A target-bind
 * receipt names the head that was live when it was attested, which a later advance leaves behind.
 * The same reader as `readHermesTargetHead`, so an unusable history serves nothing here either.
 */
export const servedHermesHeads = (db: Db, row: TargetRow): ReadonlySet<string> =>
  new Set(headHistory(db, row) ?? []);

/**
 * The one head rule. Another executor or another lineage is refused; inside the lineage, the head
 * the Gateway reports is the head, unless the binding has already served it and moved on. The
 * caller must already have tied the report to the bound process (pid and native start read by
 * ACP); this decides only the conversation.
 */
export const judgeLiveHead = (target: HermesTargetHead, reported: ReportedHead): LiveHeadJudgement => {
  if (target.executorKind !== "hermes") return { verdict: "REFUSE", message: "the target is not a Hermes conversation" };
  if (reported.lineage_root_digest !== target.lineageRootDigest) {
    return { verdict: "REFUSE", message: "the Gateway serves another lineage" };
  }
  if (!isHermesHead(reported.session_id)) return { verdict: "REFUSE", message: "the Gateway reported no usable head" };
  if (hermesHeadDigest(reported.session_id) === target.headDigest) return { verdict: "SAME", head: reported.session_id };
  if (target.history.includes(reported.session_id)) {
    return { verdict: "REFUSE", message: "the Gateway reported a head this conversation has already left" };
  }
  return { verdict: "ADVANCE", head: reported.session_id, previousHead: target.head };
};

/**
 * Appends the advance, the one writer all three paths share. Call it inside the transaction that
 * also re-checks the authority it serves (`headAdvanceTransaction`), so the head and that authority
 * commit or roll back together; a SAME judgement writes nothing.
 *
 * It records only a forward move from the head stored now (compare-and-set), and only a row that
 * reads back exactly: otherwise it throws, rolling back whatever the
 * transaction wrote.
 */
export const recordHeadAdvance = (
  db: Db,
  audit: AuditLog,
  target: HermesTargetHead,
  judgement: Extract<LiveHeadJudgement, { verdict: "ADVANCE" }>,
  context: { path: "adoption" | "tool_admission" | "gateway_delivery"; sessionId: string; roleKey: string;
    bindingGeneration: number; gatewayPid: number },
): Decision<void> => {
  const refused = (message: string): Decision<void> => deny(ReasonCode.CONFLICT, message, {});
  if (!db.inTransaction) return refused("a head advance is recorded only inside the transaction that fences it");
  if (!isHermesHead(judgement.head)) return refused("the Gateway reported no usable head");
  const current = readHermesTargetHead(db, target.actorId);
  if (current === null) return refused("the recorded head moved since it was read");
  if (current.targetBindingId !== target.targetBindingId) return refused("the recorded head moved since it was read");
  if (current.lineageRootDigest !== target.lineageRootDigest) return refused("the recorded head moved since it was read");
  if (current.head !== judgement.previousHead) return refused("the recorded head moved since it was read");
  if (current.history.includes(judgement.head)) {
    return refused("the Gateway reported a head this conversation has already left");
  }
  const evidence = {
    targetBindingId: target.targetBindingId,
    actorId: target.actorId,
    lineageRootDigest: target.lineageRootDigest,
    previousHeadDigest: hermesHeadDigest(judgement.previousHead),
    headDigest: hermesHeadDigest(judgement.head),
    // Display text; a reader takes it only where it hashes to the digest beside it.
    previousHead: judgement.previousHead,
    head: judgement.head,
    path: context.path,
    bindingGeneration: context.bindingGeneration,
    gatewayPid: context.gatewayPid,
  };
  const recorded = audit.record({
    kind: TARGET_HEAD_ADVANCED,
    reasonCode: ReasonCode.OK,
    sessionId: context.sessionId,
    roleKey: context.roleKey,
    evidence,
  });
  // `allowed` says a row was written, not that it holds this head: read it back.
  if (!recorded.allowed) throw headNotRecorded();
  const stored = db.get<{ kind: string; evidence_json: string }>(
    "SELECT kind, evidence_json FROM audit_events WHERE event_id = ?",
    [recorded.value],
  );
  if (stored === undefined) throw headNotRecorded();
  if (stored.kind !== TARGET_HEAD_ADVANCED) throw headNotRecorded();
  let readBack: string;
  try {
    readBack = canonicalJson(JSON.parse(stored.evidence_json));
  } catch {
    throw headNotRecorded();
  }
  if (readBack !== canonicalJson(evidence)) throw headNotRecorded();
  if (readHermesTargetHead(db, target.actorId)?.head !== judgement.head) throw headNotRecorded();
  return allow(ReasonCode.OK, undefined);
};

/**
 * The transaction a head advance is recorded in. A row that did not read back exactly throws inside
 * it, which rolls back everything it wrote — an adoption's binding included — and is answered here
 * as a refusal. Nested in another transaction, the throw is left to reach the one that owns it.
 */
export const headAdvanceTransaction = <T>(db: Db, body: () => Decision<T>): Decision<T> => {
  if (db.inTransaction) return db.txDecision(body);
  try {
    return db.txDecision(body);
  } catch (error) {
    if (isHeadNotRecorded(error)) return deny(ReasonCode.CONFLICT, error.message, {});
    throw error;
  }
};
