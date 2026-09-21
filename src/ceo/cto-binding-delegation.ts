import { z } from "zod";
import { digestOf } from "../core/digest.ts";
import { allow, deny, type Decision } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { Role, SessionLifecycle } from "../domain/types.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRegistry } from "../session/session-registry.ts";

const principalSchema = z.object({ sessionId: z.string().min(1), sessionSecret: z.string().min(1) }).strict();
const requestSchema = z.object({
  requestId: z.string().min(1).max(256),
  projectId: z.string().min(1).max(256), role: z.literal("PRIMARY_CTO"), action: z.literal("bind-or-rebind"),
  targetSessionId: z.string().min(1), expectedBindingGeneration: z.number().int().positive().safe(),
}).strict();
export type CtoBindingAuthorization = z.infer<typeof requestSchema> & {
  targetIncarnation: string; requestDigest: string;
};
// A release names no target, because it produces none: the role ends up held by nobody. What it
// must name is the binding it removes, so `expectedBindingGeneration` is read here as the current
// generation rather than the next one — the one field whose meaning differs between the two doors.
const releaseRequestSchema = z.object({
  requestId: z.string().min(1).max(256),
  projectId: z.string().min(1).max(256), role: z.literal("PRIMARY_CTO"), action: z.literal("release"),
  expectedBindingGeneration: z.number().int().positive().safe(), reason: z.string().min(1).max(512),
}).strict();
export type CtoReleaseAuthorization = z.infer<typeof releaseRequestSchema> & {
  releasedSessionId: string; requestDigest: string;
};
const refused = (): Decision<never> => deny(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
  "the caller does not hold the live CEO binding, or the request is outside what it permits", {});

/**
 * Who may rebind the canonical CTO. The answer used to be "whoever holds a grant", where a grant
 * was minted by an owner decision: a receipt whose digest covered a scope, admitted through the
 * CLI owner allowlist, with durable grants reconstructed from an audit-event ledger behind an
 * operation fence. All of that is gone. The authority is now the CEO's own live binding —
 * the principal proves it holds the session by secret, and that session must be the one the
 * `Role.CEO` binding currently names, at its current incarnation, and be READY.
 *
 * That is not a smaller version of the old check; it is a different question. The grant asked
 * "did the owner once approve this arrangement", and its answer stayed true after the CEO that
 * requested it was gone, which is why it needed expiry, revocation, a switch hook and a fence to
 * chase it. Asking instead "is the caller the CEO right now" has no such tail: the binding
 * registry is the authority, so losing the role *is* losing the permission, with nothing to
 * settle. A CEO can therefore be added or removed freely, which is the point.
 *
 * What survives is everything that was about the write rather than about permission: the target
 * must be READY and must not be the caller, `expectedBindingGeneration` must equal the next
 * generation, a repeated `requestId` must carry an identical request, and the caller re-runs
 * this check at the writer's last pre-write seam inside one transaction.
 */
export class CtoBindingDelegation {
  readonly #requests = new Map<string, { digest: string; receipt: CtoBindingAuthorization }>();
  // Each door replays only its own requestIds. One map holding both would need the receipt type
  // to be a union that no call site can narrow, and a requestId reused across the two doors
  // carries a different digest either way, so neither door can replay the other's answer.
  readonly #releases = new Map<string, { digest: string; receipt: CtoReleaseAuthorization }>();
  #ownsTransaction = false;

  constructor(
    private readonly sessions: SessionRegistry,
    private readonly bindings: BindingRegistry,
    private readonly audit: AuditLog,
    private readonly db?: Db,
  ) {
    // A new CEO does not inherit the previous one's replay memory. The authorization check
    // below reads the live binding before it consults this cache, so a stale entry cannot
    // authorize anything by itself; dropping it keeps the cache from answering for a request
    // whose author no longer exists.
    bindings.onSwitch((binding) => {
      if (binding.roleKey === Role.CEO) { this.#requests.clear(); this.#releases.clear(); }
    });
  }

  /** The binding write runs in one transaction owned here, so a partial rebind cannot commit. */
  bindingTransaction<T>(db: Db, body: () => Decision<T>): Decision<T> {
    if (db.inTransaction || this.#ownsTransaction || this.db !== db) return refused();
    this.#ownsTransaction = true;
    try { return db.txDecision(body); }
    finally { this.#ownsTransaction = false; }
  }

  authorize(rawPrincipal: unknown, rawRequest: unknown): Decision<CtoBindingAuthorization> {
    if (!this.db) return this.#authorize(rawPrincipal, rawRequest);
    if (this.db.inTransaction) return this.#ownsTransaction ? this.#authorize(rawPrincipal, rawRequest) : refused();
    if (this.#ownsTransaction) return refused();
    return this.db.txDecision(() => this.#authorize(rawPrincipal, rawRequest));
  }

  authorizeRelease(rawPrincipal: unknown, rawRequest: unknown): Decision<CtoReleaseAuthorization> {
    if (!this.db) return this.#authorizeRelease(rawPrincipal, rawRequest);
    if (this.db.inTransaction) return this.#ownsTransaction ? this.#authorizeRelease(rawPrincipal, rawRequest) : refused();
    if (this.#ownsTransaction) return refused();
    return this.db.txDecision(() => this.#authorizeRelease(rawPrincipal, rawRequest));
  }

  /**
   * The whole permission, asked the same way at every door this authority opens. Holding the
   * secret proves which session is calling; holding the role is what lets that session speak
   * here, and it is read live rather than remembered. Both doors ask this and nothing else:
   * what differs between them is the write they then describe, never who may ask for it.
   */
  #callerHoldsTheCeoRole(p: { sessionId: string; sessionSecret: string }): boolean {
    const authenticated = this.sessions.verifySecret(p.sessionId, p.sessionSecret);
    if (!authenticated.allowed) return false;
    const ceo = this.bindings.active(Role.CEO);
    if (!ceo || ceo.sessionId !== p.sessionId || ceo.sessionIncarnation !== authenticated.value.incarnation) return false;
    if (authenticated.value.lifecycle !== SessionLifecycle.READY) return false;
    return true;
  }

  #authorize(rawPrincipal: unknown, rawRequest: unknown): Decision<CtoBindingAuthorization> {
    const principal = principalSchema.safeParse(rawPrincipal);
    const parsed = requestSchema.safeParse(rawRequest);
    if (!principal.success || !parsed.success) return refused();
    const p = principal.data;
    const request = parsed.data;
    if (!this.#callerHoldsTheCeoRole(p)) return refused();
    // A CEO cannot hand the CTO role to itself; one runtime holding both is the thing every
    // separate-seat check downstream assumes cannot happen.
    if (request.targetSessionId === p.sessionId) return refused();
    const target = this.sessions.get(request.targetSessionId);
    if (!target || target.lifecycle !== SessionLifecycle.READY) return refused();
    const roleKey = `${Role.PRIMARY_CTO}:${request.projectId}`;
    const next = this.bindings.history(roleKey).reduce((max, b) => Math.max(max, b.bindingGeneration), 0) + 1;
    if (request.expectedBindingGeneration !== next) return refused();
    const digest = digestOf({ ...request, targetIncarnation: target.incarnation });
    const prior = this.#requests.get(request.requestId);
    if (prior) return prior.digest === digest ? allow(ReasonCode.OK, structuredClone(prior.receipt)) : refused();
    const receipt = { ...request, targetIncarnation: target.incarnation, requestDigest: digest };
    const audited = this.audit.record({ kind: "CTO_BINDING_DELEGATION_AUTHORIZED", actor: p.sessionId,
      projectId: request.projectId, sessionId: request.targetSessionId, evidence: { parameterDigest: digest } });
    if (!audited.allowed) return audited;
    const remember = () => this.#requests.set(request.requestId, { digest, receipt: structuredClone(receipt) });
    if (this.db) this.db.afterCommit(remember);
    else remember();
    return allow(ReasonCode.OK, receipt);
  }

  #authorizeRelease(rawPrincipal: unknown, rawRequest: unknown): Decision<CtoReleaseAuthorization> {
    const principal = principalSchema.safeParse(rawPrincipal);
    const parsed = releaseRequestSchema.safeParse(rawRequest);
    if (!principal.success || !parsed.success) return refused();
    const p = principal.data;
    const request = parsed.data;
    if (!this.#callerHoldsTheCeoRole(p)) return refused();
    const roleKey = `${Role.PRIMARY_CTO}:${request.projectId}`;
    const current = this.bindings.active(roleKey);
    // A release names the exact binding it removes. Without this the request means "remove
    // whoever is there now", which silently wins a race against a rebind it never saw.
    if (!current || current.bindingGeneration !== request.expectedBindingGeneration) return refused();
    // Deliberately not conditioned on the incumbent being proven dead, which is what rebinding
    // requires. Two live runtimes would both believe they hold the role, so a *replacement* has
    // to prove the incumbent is gone; a release leaves the role held by nobody, so a live
    // incumbent is the ordinary case here rather than the dangerous one. This is the half of
    // "add and remove freely" that had no door at all. Whether work in flight makes the write
    // unsafe is BindingRegistry.revoke's question, and it is asked at the write, not here.
    const digest = digestOf({ ...request, releasedSessionId: current.sessionId });
    const prior = this.#releases.get(request.requestId);
    if (prior) return prior.digest === digest ? allow(ReasonCode.OK, structuredClone(prior.receipt)) : refused();
    const receipt = { ...request, releasedSessionId: current.sessionId, requestDigest: digest };
    const audited = this.audit.record({ kind: "CTO_BINDING_RELEASE_AUTHORIZED", actor: p.sessionId,
      projectId: request.projectId, sessionId: current.sessionId, evidence: { parameterDigest: digest } });
    if (!audited.allowed) return audited;
    const remember = () => this.#releases.set(request.requestId, { digest, receipt: structuredClone(receipt) });
    if (this.db) this.db.afterCommit(remember);
    else remember();
    return allow(ReasonCode.OK, receipt);
  }
}
