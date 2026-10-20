import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import { SessionLifecycle } from "../domain/types.ts";
import type { SessionRegistry } from "./session-registry.ts";

/** Identity carried by the authenticated connection, never by tool arguments. */
export interface AttestingPeer {
  sessionId: string;
  sessionIncarnation: string;
  sessionSecret: string;
}

/** Readiness uses current authentication directly; no model challenge or settlement. */
export class SessionAttestations {
  constructor(
    private readonly sessions: Pick<SessionRegistry, "get" | "verifySecret">,
    private readonly audit: AuditLog,
  ) {}

  attest(peer: AttestingPeer): Decision<void> {
    const verified = this.sessions.verifySecret(peer.sessionId, peer.sessionSecret);
    if (!verified.allowed) return verified as Decision<void>;
    const session = verified.value;
    if (session.incarnation !== peer.sessionIncarnation) {
      return deny(ReasonCode.SESSION_ATTESTATION_FAILED, "the connection names another session incarnation", {
        sessionId: peer.sessionId,
      });
    }
    if (session.lifecycle !== SessionLifecycle.STARTING && session.lifecycle !== SessionLifecycle.READY) {
      return deny(ReasonCode.SESSION_NOT_READY, "the session is not STARTING or READY", {
        sessionId: peer.sessionId,
        lifecycle: session.lifecycle,
      });
    }
    this.audit.record({
      kind: "SESSION_ATTESTED",
      sessionId: peer.sessionId,
      evidence: { credentialEpoch: session.credentialEpoch },
    });
    return allow(ReasonCode.OK, undefined);
  }
}
