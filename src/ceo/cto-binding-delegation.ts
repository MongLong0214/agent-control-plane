import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { allow, deny, type Decision } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { Role, SessionLifecycle } from "../domain/types.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import { approvalSchema } from "../session/role-attachment-credentials.ts";
import type { SessionRegistry } from "../session/session-registry.ts";
import type { OwnerAuthorityPort } from "./owner-authority.ts";

export const CTO_BINDING_DELEGATE_OPERATION = "ctoBinding.delegate";
const scopeSchema = z.object({
  projectId: z.string().min(1).max(256), role: z.literal("PRIMARY_CTO"),
  action: z.literal("bind-or-rebind"), ceoSessionId: z.string().min(1),
  ceoIncarnation: z.string().min(1), expiresAt: z.string().datetime(),
  revokePolicy: z.enum(["owner-or-ceo-loss-or-restart", "owner-or-ceo-loss"]),
  ceoActorId: z.string().min(1).optional(),
}).strict().refine((s) => s.revokePolicy !== "owner-or-ceo-loss" || !!s.ceoActorId);
const durableEventSchema = z.object({
  version: z.literal(1), scope: scopeSchema, receipt: approvalSchema.strict(),
  assignmentId: z.string().min(1), delegationId: z.string().uuid(),
}).strict();
// Receipt-bound identity prevents copying a consumed approval into a new grant ID.
const durableId = (receipt: unknown): string => {
  const hex = digestOf(receipt).replace(/^sha256:/, "");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const principalSchema = z.object({ sessionId: z.string().min(1), sessionSecret: z.string().min(1) }).strict();
const requestSchema = z.object({
  delegationId: z.string().uuid(), requestId: z.string().min(1).max(256),
  projectId: z.string().min(1).max(256), role: z.literal("PRIMARY_CTO"), action: z.literal("bind-or-rebind"),
  targetSessionId: z.string().min(1), expectedBindingGeneration: z.number().int().positive().safe(),
}).strict();
export type CtoBindingAuthorization = z.infer<typeof requestSchema> & {
  targetIncarnation: string; requestDigest: string;
};
export type CtoBindingDelegationScope = z.infer<typeof scopeSchema>;
export interface CtoBindingDelegationRecord { delegationId: string; scope: CtoBindingDelegationScope }
const refused = (): Decision<never> => deny(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
  "CTO binding delegation is missing, invalid, expired or outside its scope", {});

/**
 * Delegation never becomes owner authority. Legacy grants remain daemon-local;
 * explicit durable grants require a receipt-bound consumed owner decision.
 */
export class CtoBindingDelegation {
  readonly #grants = new Map<string, CtoBindingDelegationRecord>();
  constructor(
    private readonly sessions: SessionRegistry,
    private readonly bindings: BindingRegistry,
    private readonly owner: OwnerAuthorityPort,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
    private readonly db?: Db,
  ) {
    bindings.onSwitch((binding) => {
      if (binding.roleKey === Role.CEO) {
        for (const id of this.#grants.keys()) this.#invalidate(id);
      }
    });
  }

  #currentAssignment(scope: CtoBindingDelegationScope): string | null {
    return this.db?.get<{ assignment_id: string }>(
      `SELECT a.assignment_id FROM assignments a JOIN conversational_actors c ON c.actor_id = a.actor_id
       WHERE a.role_key = 'CEO' AND a.revoked_at IS NULL AND a.actor_id = ?
       AND a.session_id = ? AND a.session_incarnation = ? AND c.retired_at IS NULL
       AND c.current_session_id = a.session_id AND c.current_session_incarnation = a.session_incarnation`,
      [scope.ceoActorId, scope.ceoSessionId, scope.ceoIncarnation],
    )?.assignment_id ?? null;
  }

  #durableGrant(id: string): CtoBindingDelegationRecord | null {
    if (!this.db) return null;
    try {
      const rows = this.db.all<{ event_id: number; kind: string; evidence_json: string }>(
        `SELECT event_id, kind, evidence_json FROM audit_events
         WHERE kind IN ('CTO_BINDING_DURABLE_GRANTED', 'CTO_BINDING_DURABLE_REVOKED', 'OWNER_APPROVAL_CONSUMED') ORDER BY event_id`,
      );
      const grants = new Map<string, z.infer<typeof durableEventSchema>>();
      const consumed = new Map<string, { eventId: number; evidence: Record<string, unknown> }>();
      const revoked = new Set<string>();
      for (const row of rows) {
        const evidence = JSON.parse(row.evidence_json) as Record<string, unknown>;
        if (row.kind === "OWNER_APPROVAL_CONSUMED") {
          if (typeof evidence.receiptDigest !== "string" || consumed.has(evidence.receiptDigest)) return null;
          consumed.set(evidence.receiptDigest, { eventId: row.event_id, evidence });
        } else if (row.kind === "CTO_BINDING_DURABLE_REVOKED") {
          const parsed = z.object({ delegationId: z.string().uuid() }).strict().safeParse(evidence);
          if (!parsed.success) return null;
          revoked.add(parsed.data.delegationId);
        } else {
          const parsed = durableEventSchema.safeParse(evidence);
          if (!parsed.success) return null;
          const g = parsed.data;
          const r = g.receipt;
          const prior = consumed.get(digestOf(r));
          if (grants.has(g.delegationId) || g.delegationId !== durableId(r) ||
              g.scope.revokePolicy !== "owner-or-ceo-loss" || r.operation !== CTO_BINDING_DELEGATE_OPERATION ||
              !r.approved || r.runId !== null || r.candidateSnapshotDigest !== null ||
              r.parameterDigest !== digestOf(g.scope) || !prior || prior.eventId >= row.event_id ||
              prior.evidence.candidateSnapshotDigest !== null || prior.evidence.runId !== null ||
              prior.evidence.operation !== r.operation || prior.evidence.approved !== true ||
              prior.evidence.channel !== r.channel || prior.evidence.actor !== r.actor) return null;
          grants.set(g.delegationId, g);
        }
      }
      const fences = this.db.all<{ kind: string; evidence_json: string }>(
        `SELECT kind, evidence_json FROM audit_events
         WHERE kind IN ('CTO_BINDING_OPERATION_STARTED', 'CTO_BINDING_OPERATION_FINISHED') ORDER BY event_id`,
      );
      const pending = new Map<string, string>();
      const started = new Set<string>();
      for (const row of fences) {
        const parsed = z.object({ operationId: z.string().uuid(), delegationId: z.string().uuid() })
          .strict().safeParse(JSON.parse(row.evidence_json));
        if (!parsed.success) return null;
        const { operationId, delegationId } = parsed.data;
        if (row.kind === "CTO_BINDING_OPERATION_STARTED") {
          if (started.has(operationId)) return null;
          started.add(operationId); pending.set(operationId, delegationId);
        } else {
          if (pending.get(operationId) !== delegationId) return null;
          pending.delete(operationId);
        }
      }
      for (const [operationId, delegationId] of pending) {
        if (delegationId === id && operationId !== this.#operation?.operationId) return null;
      }
      const g = grants.get(id);
      if (!g || revoked.has(id) || !this.owner.isAllowedActor(g.receipt.channel, g.receipt.actor) ||
          this.#currentAssignment(g.scope) !== g.assignmentId) return null;
      return { delegationId: id, scope: g.scope };
    } catch { return null; }
  }

  #append(kind: string, evidence: unknown): void {
    this.db!.run(`INSERT INTO audit_events (at, kind, reason_code, actor, evidence_json) VALUES (?, ?, NULL, ?, ?)`,
      [this.clock.nowIso(), kind, "cto-binding-delegation", JSON.stringify(evidence)]);
  }

  #invalidate(id: string): void {
    this.#grants.delete(id);
    for (const [key, entry] of this.#requests) {
      if (entry.receipt.delegationId === id) this.#requests.delete(key);
    }
  }

  revoke(delegationId: string, rawReceipt: unknown): Decision<void> {
    if (this.db?.inTransaction || this.#ownsTransaction) return refused();
    const receipt = approvalSchema.safeParse(rawReceipt);
    const durable = this.#durableGrant(delegationId);
    if (!receipt.success || (!durable && !this.#grants.has(delegationId))) return refused();
    const r = receipt.data;
    if (!r.approved || r.operation !== "ctoBinding.revoke" || r.runId !== null ||
        r.candidateSnapshotDigest !== null || r.parameterDigest !== digestOf({ delegationId })) return refused();
    if (durable) return this.db!.txDecision(() => {
      const checked = this.owner.consumeApproval(r, null);
      if (!checked.allowed) return checked;
      this.#append("CTO_BINDING_DURABLE_REVOKED", { delegationId });
      this.#invalidate(delegationId);
      return allow(ReasonCode.OK, undefined);
    });
    const checked = this.owner.consumeApproval(r, null);
    if (!checked.allowed) return checked;
    // Invalidate first: an audit failure cannot keep revoked authority alive.
    this.#invalidate(delegationId);
    const audited = this.audit.record({ kind: "CTO_BINDING_DELEGATION_REVOKED", actor: r.actor,
      evidence: { parameterDigest: r.parameterDigest } });
    if (!audited.allowed) return audited;
    return allow(ReasonCode.OK, undefined);
  }

  readonly #requests = new Map<string, { digest: string; receipt: CtoBindingAuthorization }>();

  /**
   * Checks current authority only, not a write permit. The future binding transaction MUST
   * re-run this check and its own generation CAS/target/liveness checks before effects.
   * The returned closed receipt contains no credential and cannot mint owner approvals.
   */
  readonly #pendingRevocations = new Set<string>();
  #operation: { operationId: string; delegationId: string } | null = null;
  #ownsTransaction = false;

  /** A committed fence precedes risky work. An interrupted operation loses its grant,
   * even across process death and clock rollback. Success closes the fence in the
   * binding commit; denial closes it atomically with monotonic revocation settlement.
   * The request's rollback never removes the already committed recovery fence. */
  bindingTransaction<T>(db: Db, principal: unknown, request: unknown, body: () => Decision<T>): Decision<T> {
    if (db.inTransaction || this.#ownsTransaction || this.db !== db) return refused();
    return this.#ownedTransaction(principal, request, body, true);
  }

  #ownedTransaction<T>(rawPrincipal: unknown, rawRequest: unknown, body: () => Decision<T>, rollbackDenial: boolean): Decision<T> {
    const db = this.db!;
    const principal = principalSchema.safeParse(rawPrincipal);
    const request = requestSchema.safeParse(rawRequest);
    if (principal.success && request.success) {
      const grant = this.#durableGrant(request.data.delegationId);
      const authenticated = this.sessions.verifySecret(principal.data.sessionId, principal.data.sessionSecret);
      if (grant && authenticated.allowed && principal.data.sessionId === grant.scope.ceoSessionId &&
          authenticated.value.incarnation === grant.scope.ceoIncarnation) {
        const operation = { operationId: randomUUID(), delegationId: grant.delegationId };
        db.tx(() => this.#append("CTO_BINDING_OPERATION_STARTED", operation));
        this.#operation = operation;
      }
    }
    this.#ownsTransaction = true;
    try {
      const run = () => {
        const result = body();
        if (result.allowed && this.#operation) this.#append("CTO_BINDING_OPERATION_FINISHED", this.#operation);
        return result;
      };
      const result = rollbackDenial ? db.txDecision(run) : db.tx(run);
      if (!result.allowed) this.#settleRevocations(this.#operation);
      return result;
    } finally {
      // On throw, leave the durable fence incomplete: uncertainty is not replay authority.
      this.#operation = null;
      this.#ownsTransaction = false;
    }
  }

  #settleRevocations(operation: { operationId: string; delegationId: string } | null): void {
    const ids = [...this.#pendingRevocations];
    if (ids.length === 0 && !operation) return;
    this.db!.tx(() => {
      for (const delegationId of ids) {
        if (!this.db!.get(`SELECT event_id FROM audit_events
            WHERE kind = 'CTO_BINDING_DURABLE_REVOKED' AND json_extract(evidence_json, '$.delegationId') = ?`, [delegationId])) {
          this.#append("CTO_BINDING_DURABLE_REVOKED", { delegationId });
        }
      }
      if (operation) this.#append("CTO_BINDING_OPERATION_FINISHED", operation);
    });
    for (const id of ids) this.#pendingRevocations.delete(id);
  }

  authorize(rawPrincipal: unknown, rawRequest: unknown): Decision<CtoBindingAuthorization> {
    if (!this.db) return this.#authorize(rawPrincipal, rawRequest);
    if (this.db.inTransaction) return this.#ownsTransaction ? this.#authorize(rawPrincipal, rawRequest) : refused();
    if (this.#ownsTransaction) return refused();
    return this.#ownedTransaction(rawPrincipal, rawRequest, () => this.#authorize(rawPrincipal, rawRequest), false);
  }

  #authorize(rawPrincipal: unknown, rawRequest: unknown): Decision<CtoBindingAuthorization> {
    const principal = principalSchema.safeParse(rawPrincipal);
    const parsed = requestSchema.safeParse(rawRequest);
    if (!principal.success || !parsed.success) return refused();
    const p = principal.data;
    const request = parsed.data;
    const authenticated = this.sessions.verifySecret(p.sessionId, p.sessionSecret);
    if (!authenticated.allowed) return refused();
    const grant = this.#durableGrant(request.delegationId) ?? this.#grants.get(request.delegationId);
    if (!grant || this.#pendingRevocations.has(request.delegationId)) return refused();
    const s = grant.scope;
    if (s.revokePolicy === "owner-or-ceo-loss" && this.#operation?.delegationId !== request.delegationId) return refused();
    const ceo = this.bindings.active(Role.CEO);
    if (Date.parse(s.expiresAt) <= this.clock.now().getTime() || !ceo ||
        ceo.sessionId !== s.ceoSessionId || ceo.sessionIncarnation !== s.ceoIncarnation) {
      this.#invalidate(request.delegationId);
      if (s.revokePolicy === "owner-or-ceo-loss") {
        this.#pendingRevocations.add(request.delegationId);
        this.#append("CTO_BINDING_DURABLE_REVOKED", { delegationId: request.delegationId });
      }
      return refused();
    }
    if (authenticated.value.lifecycle !== SessionLifecycle.READY ||
        authenticated.value.incarnation !== s.ceoIncarnation || p.sessionId !== s.ceoSessionId) return refused();
    if (request.projectId !== s.projectId || request.role !== s.role || request.action !== s.action ||
        request.targetSessionId === p.sessionId) return refused();
    const target = this.sessions.get(request.targetSessionId);
    if (!target || target.lifecycle !== SessionLifecycle.READY) return refused();
    const roleKey = `${Role.PRIMARY_CTO}:${s.projectId}`;
    const next = this.bindings.history(roleKey).reduce((max, b) => Math.max(max, b.bindingGeneration), 0) + 1;
    if (request.expectedBindingGeneration !== next) return refused();
    const key = `${request.delegationId}:${request.requestId}`;
    const digest = digestOf({ ...request, targetIncarnation: target.incarnation });
    if (s.revokePolicy === "owner-or-ceo-loss") {
      try {
        const rows = this.db!.all<{ evidence_json: string }>(
          "SELECT evidence_json FROM audit_events WHERE kind = 'CTO_BINDING_DURABLE_REQUEST' ORDER BY event_id",
        );
        const seen = new Map<string, string>();
        for (const row of rows) {
          const parsed = requestSchema.extend({ targetIncarnation: z.string().min(1), requestDigest: z.string() })
            .strict().safeParse(JSON.parse(row.evidence_json));
          if (!parsed.success) return refused();
          const { requestDigest, ...body } = parsed.data;
          const priorKey = `${body.delegationId}:${body.requestId}`;
          if (requestDigest !== digestOf(body) || seen.has(priorKey)) return refused();
          seen.set(priorKey, requestDigest);
        }
        const saved = seen.get(key);
        if (saved) return saved === digest
          ? allow(ReasonCode.OK, { ...request, targetIncarnation: target.incarnation, requestDigest: digest }) : refused();
      } catch { return refused(); }
    }
    const prior = this.#requests.get(key);
    if (prior) return prior.digest === digest ? allow(ReasonCode.OK, structuredClone(prior.receipt)) : refused();
    const receipt = { ...request, targetIncarnation: target.incarnation, requestDigest: digest };
    const audited = this.audit.record({ kind: "CTO_BINDING_DELEGATION_AUTHORIZED", actor: p.sessionId,
      projectId: s.projectId, sessionId: request.targetSessionId, evidence: { parameterDigest: digest } });
    if (!audited.allowed) return audited;
    if (s.revokePolicy === "owner-or-ceo-loss") this.#append("CTO_BINDING_DURABLE_REQUEST", receipt);
    const remember = () => this.#requests.set(key, { digest, receipt: structuredClone(receipt) });
    if (this.db) this.db.afterCommit(remember);
    else remember();
    return allow(ReasonCode.OK, receipt);
  }

  /** Trusted native composition: admission and durable consumption share our own
   * transaction. Never borrow an external transaction or publish a volatile grant. */
  grantWithAdmission(rawScope: unknown, admit: () => Decision<unknown>): Decision<CtoBindingDelegationRecord> {
    if (!this.db || this.db.inTransaction || this.#ownsTransaction) return refused();
    const scope = scopeSchema.safeParse(rawScope);
    if (!scope.success || scope.data.revokePolicy !== "owner-or-ceo-loss") return refused();
    this.#ownsTransaction = true;
    try {
      return this.db.txDecision(() => {
        const admitted = admit();
        return admitted.allowed ? this.#grant(scope.data, admitted.value) : admitted;
      });
    } finally { this.#ownsTransaction = false; }
  }

  grant(rawScope: unknown, rawReceipt: unknown): Decision<CtoBindingDelegationRecord> {
    if (this.db?.inTransaction || this.#ownsTransaction) return refused();
    return this.#grant(rawScope, rawReceipt);
  }

  #grant(rawScope: unknown, rawReceipt: unknown): Decision<CtoBindingDelegationRecord> {
    const scope = scopeSchema.safeParse(rawScope);
    const receipt = approvalSchema.safeParse(rawReceipt);
    if (!scope.success || !receipt.success) return refused();
    const r = receipt.data;
    const s = scope.data;
    if (!r.approved || r.operation !== CTO_BINDING_DELEGATE_OPERATION ||
        r.parameterDigest !== digestOf(s) || r.runId !== null || r.candidateSnapshotDigest !== null ||
        Date.parse(s.expiresAt) <= this.clock.now().getTime()) return refused();
    const session = this.sessions.get(s.ceoSessionId);
    const binding = this.bindings.active(Role.CEO);
    if (!session || session.lifecycle !== SessionLifecycle.READY || session.incarnation !== s.ceoIncarnation ||
        !binding || binding.sessionId !== s.ceoSessionId || binding.sessionIncarnation !== s.ceoIncarnation) return refused();
    if (s.revokePolicy === "owner-or-ceo-loss") {
      if (!this.db) return refused();
      return this.db.txDecision(() => {
        const assignmentId = this.#currentAssignment(s);
        if (!assignmentId) return refused();
        const checked = this.owner.consumeApproval(r, null);
        if (!checked.allowed) return checked;
        const record = { delegationId: durableId(r), scope: s };
        this.#append("CTO_BINDING_DURABLE_GRANTED", { version: 1, ...record, assignmentId, receipt: r });
        return allow(ReasonCode.OK, record);
      });
    }
    const checked = this.owner.consumeApproval(r, null);
    if (!checked.allowed) return checked;
    const record = { delegationId: randomUUID(), scope: s };
    const audited = this.audit.record({ kind: "CTO_BINDING_DELEGATION_GRANTED", actor: r.actor,
      projectId: s.projectId, sessionId: s.ceoSessionId, evidence: { parameterDigest: digestOf(s) } });
    if (!audited.allowed) return audited;
    this.#grants.set(record.delegationId, structuredClone(record));
    return allow(ReasonCode.OK, record);
  }
}
