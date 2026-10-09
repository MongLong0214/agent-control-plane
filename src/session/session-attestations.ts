import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import { SessionLifecycle } from "../domain/types.ts";
import type { SessionRegistry } from "./session-registry.ts";

/** What an authenticated MCP connection says about itself; the secret is the one it handshook with. */
export interface AttestingPeer {
  sessionId: string;
  sessionIncarnation: string;
  sessionSecret: string;
}

interface PendingChallenge {
  nonce: string;
  incarnation: string;
  credentialEpoch: number;
  expiresAtMs: number;
  attested: boolean;
}

/** A challenge outlives one turn comfortably and nothing more. */
const CHALLENGE_TTL_MS = 15 * 60_000;

const ATTESTABLE: ReadonlySet<SessionLifecycle> = new Set([SessionLifecycle.STARTING, SessionLifecycle.READY]);

/**
 * #246 C1b — the daemon-verifiable proof that a provisioned session's real runtime is reachable and
 * holds the session's current credential.
 *
 * Readiness is never taken from a UUID, a row or a process that started: the runtime driver mints a
 * challenge for the session, runs one turn of that session's own conversation, and the turn's relay
 * — which authenticated on `cto.mcp.sock` with the credential the daemon delivered — presents the
 * challenge through the `session_attest` tool. The tool's authority is the authenticated connection:
 * its session, incarnation and secret, verified again here, and the credential epoch the challenge
 * was minted at. Only after the driver settles an answered challenge is the session ready.
 *
 * In memory only, like the launch channel: a restart drops every pending challenge, and a session
 * whose challenge is gone can only be asked again.
 */
export class SessionAttestations {
  readonly #pending = new Map<string, PendingChallenge>();

  constructor(
    private readonly sessions: Pick<SessionRegistry, "get" | "verifySecret">,
    private readonly audit: AuditLog,
  ) {}

  /** A fresh challenge for the session's next turn; it replaces any earlier one for the session. */
  challenge(sessionId: string): Decision<{ nonce: string }> {
    const session = this.sessions.get(sessionId);
    if (!session || !ATTESTABLE.has(session.lifecycle)) {
      return deny(ReasonCode.SESSION_NOT_READY, "only a STARTING or READY session is asked to attest", {
        sessionId,
        lifecycle: session?.lifecycle ?? null,
      });
    }
    const nonce = `att_${randomBytes(24).toString("base64url")}`;
    this.#pending.set(sessionId, {
      nonce,
      incarnation: session.incarnation,
      credentialEpoch: session.credentialEpoch,
      expiresAtMs: Date.now() + CHALLENGE_TTL_MS,
      attested: false,
    });
    return allow(ReasonCode.OK, { nonce });
  }

  /**
   * Whether an unbound connection for this session may be admitted, and kept, to answer its
   * challenge: one is pending, unexpired and unanswered, minted for this incarnation and epoch.
   */
  isPending(sessionId: string, incarnation: string, credentialEpoch: number): boolean {
    const pending = this.#pending.get(sessionId);
    return pending !== undefined &&
      !pending.attested &&
      pending.expiresAtMs > Date.now() &&
      pending.incarnation === incarnation &&
      pending.credentialEpoch === credentialEpoch;
  }

  /**
   * The `session_attest` tool's write: the authenticated connection presents the challenge. The
   * secret is verified again here, and the session must still be the incarnation and the epoch the
   * challenge was minted for, so an answer over a connection opened with a rotated-away credential
   * is refused even if that connection was admitted before the rotation.
   */
  attest(peer: AttestingPeer, nonce: string): Decision<void> {
    const verified = this.sessions.verifySecret(peer.sessionId, peer.sessionSecret);
    if (!verified.allowed) return verified as Decision<void>;
    const session = verified.value;
    const pending = this.#pending.get(peer.sessionId);
    const refuse = (message: string): Decision<void> =>
      deny(ReasonCode.SESSION_ATTESTATION_FAILED, message, { sessionId: peer.sessionId });
    if (!ATTESTABLE.has(session.lifecycle)) return refuse("the session is not STARTING or READY");
    if (!pending || pending.expiresAtMs <= Date.now()) return refuse("no challenge is pending for this session");
    if (pending.attested) return refuse("this challenge was already answered");
    if (session.incarnation !== peer.sessionIncarnation || pending.incarnation !== session.incarnation) {
      return refuse("the challenge was minted for another incarnation");
    }
    if (pending.credentialEpoch !== session.credentialEpoch) {
      return refuse("the challenge was minted for another credential epoch");
    }
    if (!sameNonce(pending.nonce, nonce)) return refuse("the presented challenge is not this session's");
    pending.attested = true;
    this.audit.record({
      kind: "SESSION_ATTESTED",
      sessionId: peer.sessionId,
      evidence: { credentialEpoch: session.credentialEpoch, challengeDigest: challengeDigest(pending.nonce) },
    });
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * The driver's check once the turn has returned: the challenge it minted was answered, by this
   * incarnation at the epoch it was minted for, and the session is still there. Consumes the
   * challenge either way, so one answer settles exactly one readiness.
   */
  settle(sessionId: string, nonce: string): Decision<void> {
    const pending = this.#pending.get(sessionId);
    if (pending && sameNonce(pending.nonce, nonce)) this.#pending.delete(sessionId);
    const session = this.sessions.get(sessionId);
    const refuse = (message: string): Decision<void> =>
      deny(ReasonCode.SESSION_ATTESTATION_FAILED, message, { sessionId });
    if (!pending || !sameNonce(pending.nonce, nonce)) return refuse("the challenge this turn was asked to answer is gone");
    if (!pending.attested) return refuse("the runtime did not present its challenge over an authenticated connection");
    if (!session || !ATTESTABLE.has(session.lifecycle)) return refuse("the session left STARTING/READY while it attested");
    if (session.incarnation !== pending.incarnation || session.credentialEpoch !== pending.credentialEpoch) {
      return refuse("the session's credential moved while it attested");
    }
    return allow(ReasonCode.OK, undefined);
  }

  /** Drops an unanswered challenge, for a turn that will not be asked to answer it. */
  withdraw(sessionId: string, nonce: string): void {
    const pending = this.#pending.get(sessionId);
    if (pending && sameNonce(pending.nonce, nonce)) this.#pending.delete(sessionId);
  }
}

const sameNonce = (expected: string, presented: string): boolean => {
  const left = Buffer.from(expected);
  const right = Buffer.from(presented);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Names a challenge in the audit without carrying it. */
const challengeDigest = (nonce: string): string => createHash("sha256").update(nonce).digest("hex").slice(0, 16);
