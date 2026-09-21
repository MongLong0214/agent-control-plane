import type { Socket } from "node:net";
import { z } from "zod";
import type { CtoBindingDelegation, CtoReleaseAuthorization } from "../ceo/cto-binding-delegation.ts";
import { allow, deny, type Decision } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { Db } from "../db/database.ts";
import { Role, type RoleBinding } from "../domain/types.ts";
import type { AuthenticatedTargetBinding, BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRegistry } from "../session/session-registry.ts";
import { probeSessionLiveness } from "./dead-binding-recovery.ts";
import { readOneJsonLineRequest } from "./local-socket-framing.ts";

const principalSchema = z.object({
  sessionId: z.string().min(1).max(256), sessionSecret: z.string().min(1).max(256) }).strict();
const envelope = z.object({ method: z.literal("ctoBinding.bind"), principal: principalSchema,
  request: z.object({ requestId: z.string().min(1).max(256),
    projectId: z.string().min(1).max(256), role: z.literal("PRIMARY_CTO"), action: z.literal("bind-or-rebind"),
    targetSessionId: z.string().min(1).max(256), expectedBindingGeneration: z.number().int().positive().safe(),
  }).strict(),
}).strict();
const releaseEnvelope = z.object({ method: z.literal("ctoBinding.release"), principal: principalSchema,
  request: z.object({ requestId: z.string().min(1).max(256),
    projectId: z.string().min(1).max(256), role: z.literal("PRIMARY_CTO"), action: z.literal("release"),
    expectedBindingGeneration: z.number().int().positive().safe(), reason: z.string().min(1).max(512),
  }).strict(),
}).strict();
const refused = (): Decision<never> => deny(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE, "delegated binding refused", {});

/**
 * Daemon-local writer, composed by cto-binding-runtime behind authenticated MCP. There is no grant
 * to provision any more: the authority this asks is whether the caller holds the live CEO binding,
 * so nothing here mints, stores or expires a permission. This port accepts no owner token, receipt
 * or caller-supplied target proof. The trusted executor port must authenticate the planned tuple.
 * No async gap is permitted in the binding transaction. Local replay observations die on restart.
 * Committed bindings persist. A stale retry is refused, not replayed as authority.
 */
export class CtoDelegatedBinding {
  #observations = 0;
  #failed = false;
  constructor(private readonly deps: {
    db: Db; sessions: SessionRegistry; bindings: BindingRegistry; authority: CtoBindingDelegation;
    target(sessionId: string): AuthenticatedTargetBinding | null;
  }) {}

  /**
   * Releasing is the half of "add and remove freely" that had no door. It shares this writer's
   * latch and capacity because it is the same writer against the same registry, and it shares
   * the authority because the permission is identical: hold the live CEO binding. What it does
   * not share is the proven-dead precondition — a replacement needs the incumbent gone because
   * two live runtimes would both believe they hold the role, and a release leaves nobody there.
   */
  release(raw: unknown): Decision<CtoReleaseAuthorization> {
    if (this.#failed) return refused();
    try { return this.#release(raw); }
    catch (error) {
      this.#failed = true;
      throw error;
    }
  }

  #release(raw: unknown): Decision<CtoReleaseAuthorization> {
    const parsed = releaseEnvelope.safeParse(raw);
    if (!parsed.success) return refused();
    const { principal, request } = parsed.data;
    const { db, bindings, authority } = this.deps;
    return authority.bindingTransaction(db, () => {
      const checked = authority.authorizeRelease(principal, request);
      if (!checked.allowed) return checked;
      if (this.#observations >= 1024) return refused();
      db.afterCommit(() => { this.#observations++; });
      // No second read at a write seam, unlike the bind path below. That recheck exists there
      // because the executor's `verify` callback runs process probes between authorization and
      // the write; nothing runs between these two lines, so re-reading the same row in the same
      // transaction would be a second authority on one fact rather than defence in depth.
      const revoked = bindings.revoke(`${Role.PRIMARY_CTO}:${request.projectId}`,
        `CEO delegated release: ${request.reason}`);
      if (!revoked.allowed) return revoked;
      return allow(ReasonCode.OK, checked.value);
    });
  }

  execute(raw: unknown): Decision<RoleBinding> {
    if (this.#failed) return refused();
    try { return this.#execute(raw); }
    catch (error) {
      // A COMMIT may already have succeeded before an afterCommit callback throws.
      // Never authorize again with uncertain capacity or replay-memory publication.
      // This latch is irreversible for this daemon-local writer, for every exception
      // (including a thrown non-Error); callback order is not a safety assumption.
      this.#failed = true;
      throw error;
    }
  }

  #execute(raw: unknown): Decision<RoleBinding> {
    const parsed = envelope.safeParse(raw);
    if (!parsed.success) return refused();
    const { principal, request } = parsed.data;
    const { db, sessions, bindings, authority } = this.deps;
    return authority.bindingTransaction(db, () => {
      // The foundation's result is an observation, never accepted as an input permit.
      const checked = authority.authorize(principal, request);
      if (!checked.allowed) return checked;
      // Denied requests neither reserve capacity nor evict admitted replay state.
      // Check after authority maintenance, so reaching capacity cannot suppress expiry.
      if (this.#observations >= 1024) return refused();
      db.afterCommit(() => { this.#observations++; });
      const roleKey = `${Role.PRIMARY_CTO}:${request.projectId}`;
      const current = bindings.active(roleKey);
      const dead = (binding: RoleBinding): boolean => {
        const session = sessions.get(binding.sessionId);
        return !!session && session.incarnation === binding.sessionIncarnation &&
          probeSessionLiveness(session.osPid, session.osProcessStartedAt) === "DEAD";
      };
      if (current && !dead(current)) return refused();
      const target = this.deps.target(request.targetSessionId);
      if (!target) return refused();
      const authenticatedTarget: AuthenticatedTargetBinding = { ...target,
        // The real executor fills these during verify; spreading alone snapshots pre-proof nulls.
        get targetBindReceipt() { return target.targetBindReceipt; },
        get attestationDigest() { return target.attestationDigest; },
        verify: (tuple) => {
        const verified = target.verify(tuple);
        // Recheck after executor verification, at the binding writer's last pre-write seam.
        const fresh = authority.authorize(principal, request);
        const incumbent = bindings.active(roleKey);
        if (!fresh.allowed || fresh.value.targetIncarnation !== tuple.incarnation ||
            tuple.generation !== request.expectedBindingGeneration ||
            incumbent !== null || (current && !dead(current))) return null;
        return verified;
      } };
      const input = { role: Role.PRIMARY_CTO, projectId: request.projectId,
        sessionId: request.targetSessionId, authenticatedTarget };
      // switchTo(REPLACED) does not consume authenticatedTarget. Reuse revoke + bind
      // inside this outer txDecision instead; denial rolls back revocation and outbox fences.
      if (current) {
        const revoked = bindings.revoke(roleKey, "CEO delegated replacement of proven-dead runtime");
        if (!revoked.allowed) return revoked;
      }
      const written = bindings.bind(input);
      if (!written.allowed) return written;
      const active = bindings.active(roleKey);
      if (!active || active.assignmentId !== written.value.assignmentId ||
          active.sessionId !== request.targetSessionId ||
          active.bindingGeneration !== request.expectedBindingGeneration) return refused();
      return allow(ReasonCode.OK, active);
    });
  }
}

/** One request/connection; reuse the production framing primitive, never the owner listener. */
export function serveCtoDelegatedBinding(socket: Socket, service: CtoDelegatedBinding): void {
  socket.setTimeout(5000, () => socket.destroy());
  socket.on("error", () => socket.destroy());
  const reply = (decision: Decision<unknown>) => socket.end(JSON.stringify(decision.allowed
    ? { allowed: true, reasonCode: decision.reasonCode, value: decision.value }
    : { allowed: false, reasonCode: decision.reasonCode }) + "\n");
  // Route on the declared method without narrowing `raw` by assertion: each door re-parses the
  // whole envelope itself, so a method that does not match one falls through to a strict parse
  // that refuses it. This peek chooses which parser runs; it never admits anything on its own.
  const routed = z.object({ method: z.literal("ctoBinding.release") });
  const reader = readOneJsonLineRequest(socket,
    { tooLarge: "request too large", multipleRequests: "one request only", notJson: "invalid JSON" },
    (raw) => { try {
      reply(routed.safeParse(raw).success ? service.release(raw) : service.execute(raw));
    } catch { reply(refused()); } }, reply, 16384);
  socket.once("close", () => reader.dispose());
}
