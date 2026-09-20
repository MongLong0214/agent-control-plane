import type { Socket } from "node:net";
import { z } from "zod";
import type { CtoBindingDelegation } from "../ceo/cto-binding-delegation.ts";
import { allow, deny, type Decision } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { Db } from "../db/database.ts";
import { Role, type RoleBinding } from "../domain/types.ts";
import type { AuthenticatedTargetBinding, BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRegistry } from "../session/session-registry.ts";
import { probeSessionLiveness } from "./dead-binding-recovery.ts";
import { readOneJsonLineRequest } from "./local-socket-framing.ts";

const envelope = z.object({ method: z.literal("ctoBinding.bind"),
  principal: z.object({ sessionId: z.string().min(1).max(256), sessionSecret: z.string().min(1).max(256) }).strict(),
  request: z.object({ delegationId: z.string().uuid(), requestId: z.string().min(1).max(256),
    projectId: z.string().min(1).max(256), role: z.literal("PRIMARY_CTO"), action: z.literal("bind-or-rebind"),
    targetSessionId: z.string().min(1).max(256), expectedBindingGeneration: z.number().int().positive().safe(),
  }).strict(),
}).strict();
const refused = (): Decision<never> => deny(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE, "delegated binding refused", {});

/**
 * Daemon-local writer, composed by cto-binding-runtime behind authenticated MCP. Grant provisioning remains on
 * the existing owner-admitted boundary. This port accepts no owner token, receipt or caller
 * supplied target proof. The trusted executor port must authenticate the planned tuple.
 * No async gap is permitted in the binding transaction. Legacy grants and local replay
 * observations die on restart; explicit durable grants use the validated event ledger.
 * Committed bindings persist. A stale retry is refused, not replayed as authority.
 */
export class CtoDelegatedBinding {
  #observations = 0;
  #failed = false;
  constructor(private readonly deps: {
    db: Db; sessions: SessionRegistry; bindings: BindingRegistry; authority: CtoBindingDelegation;
    target(sessionId: string): AuthenticatedTargetBinding | null;
  }) {}

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
    return authority.bindingTransaction(db, principal, request, () => {
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
  const reader = readOneJsonLineRequest(socket,
    { tooLarge: "request too large", multipleRequests: "one request only", notJson: "invalid JSON" },
    (raw) => { try { reply(service.execute(raw)); } catch { reply(refused()); } }, reply, 16384);
  socket.once("close", () => reader.dispose());
}
