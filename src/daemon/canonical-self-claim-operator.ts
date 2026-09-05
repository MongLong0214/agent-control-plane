import type { Socket } from "node:net";

import type { OwnerApprovalReceipt, OwnerAuthorityPort } from "../ceo/owner-authority.ts";
import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { getPeerCredentials, type PeerCredentials } from "../core/peercred.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { IngressGuard, ownerApprovalPayload } from "../ingress/ingress-guard.ts";
import {
  CanonicalSelfClaim,
  SELF_CLAIM_OPERATION,
  type CanonicalSelfClaimConfig,
  type CanonicalSelfClaimReceipt,
} from "../registry/canonical-self-claim.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { BuzzActorAuthenticator, SessionRegistry } from "../session/session-registry.ts";

/**
 * The one production call site #539/#760-round-3 authorizes: `actor.claimCanonicalCto`'s
 * operator handler. `scripts/verify-peercred-is-unreachable.mjs` allowlists exactly this file by
 * path; nothing else in `src/` may import `../core/peercred.ts`.
 *
 * This is a separate, self-contained module by design — the ruling required "a separate atomic
 * commit... its own rollback unit. Not folded into the claim commit." `CanonicalSelfClaim` itself
 * (src/registry/canonical-self-claim.ts) is unchanged by this file and never imports it back.
 */

/**
 * Node exposes no public API for a socket's raw fd. `_handle.fd` is the field this repository's
 * own `tests/unit/g5-peercred.test.ts` already reads for exactly this reason — there is no other
 * way to hand a real kernel fd to `getsockopt`. Returns `null` (never throws) for a socket with no
 * live native handle, e.g. one already closed by the time this runs — fail-closed, the same shape
 * `getPeerCredentials` itself uses for "cannot be established".
 */
const rawFd = (socket: Socket): number | null => {
  const handle = (socket as unknown as { _handle: { fd: number } | null } | null)?._handle;
  return handle && typeof handle.fd === "number" ? handle.fd : null;
};

/**
 * The kernel's own record of who is on the other end of this exact connection — never the shared
 * bearer token, a CLI field, the configured operator actor string, or anything in the request
 * payload. Those are each explicitly not substitutes (#760 round 3): a caller can assert any pid
 * it likes in a JSON body, and the whole point of this primitive is that nothing here ever reads
 * that assertion as identity.
 */
export const derivePeerCredentialsFromSocket = (socket: Socket): PeerCredentials | null => {
  const fd = rawFd(socket);
  return fd === null ? null : getPeerCredentials(fd);
};

export interface CanonicalSelfClaimOperatorDeps {
  db: Db;
  clock: Clock;
  audit: AuditLog;
  sessions: SessionRegistry;
  bindings: BindingRegistry;
  ownerAuthority: OwnerAuthorityPort;
  buzzActorAuthenticator: BuzzActorAuthenticator;
  /** Opens the Buzz routing channel; a thin wrapper over the deployment's own transport. */
  resolveBuzzAddress: (purpose: string) => Promise<Decision<string>>;
  /** The `cli` channel actor allowed to mint an owner approval for this operation, e.g. the OS user. */
  ownerActor: string;
  config: CanonicalSelfClaimConfig;
}

export interface CanonicalSelfClaimOperatorRequest {
  claimedSessionUuid: string;
  projectId: string;
  expectedBindingGeneration: number;
  /** Identifies the operator's own admitted ingress envelope; not the approval itself. */
  ownerNonce: string;
  peerProtocolVersion: string;
  buzzChannelId: string;
  buzzActorId: string;
  buzzPurpose: string;
}

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Parses and requires every field `CanonicalSelfClaimOperatorRequest` needs, nothing assumed. */
export const parseCanonicalSelfClaimOperatorRequest = (
  params: Record<string, unknown>,
): Decision<CanonicalSelfClaimOperatorRequest> => {
  const claimedSessionUuid = params["claimedSessionUuid"];
  const projectId = params["projectId"];
  const expectedBindingGeneration = params["expectedBindingGeneration"];
  const ownerNonce = params["ownerNonce"];
  const peerProtocolVersion = params["peerProtocolVersion"];
  const buzzChannelId = params["buzzChannelId"];
  const buzzActorId = params["buzzActorId"];
  const buzzPurpose = params["buzzPurpose"];
  if (
    !isNonEmptyString(claimedSessionUuid) ||
    !isNonEmptyString(projectId) ||
    !Number.isSafeInteger(expectedBindingGeneration) ||
    !isNonEmptyString(ownerNonce) ||
    !isNonEmptyString(peerProtocolVersion) ||
    !isNonEmptyString(buzzChannelId) ||
    !isNonEmptyString(buzzActorId) ||
    !isNonEmptyString(buzzPurpose)
  ) {
    return deny(ReasonCode.INVALID_ARGUMENT, "claim canonical-cto request is missing a required field", {});
  }
  return allow(ReasonCode.OK, {
    claimedSessionUuid,
    projectId,
    expectedBindingGeneration: expectedBindingGeneration as number,
    ownerNonce,
    peerProtocolVersion,
    buzzChannelId,
    buzzActorId,
    buzzPurpose,
  });
};

/**
 * Admits the operator's owner-approval envelope through the same route
 * `Daemon`'s own `admitCliOwnerApproval` (src/daemon/daemon.ts) uses for `owner approve` and
 * `repair execute` — a real, channel-authenticated ingress admission, not a caller-typed receipt.
 * `parameters` is exactly the shape `canonicalSelfClaimParameterDigest` hashes, so the minted
 * `parameterDigest` matches `CanonicalSelfClaim.claim()`'s own binding check.
 *
 * Ordering, stated rather than left implicit: this runs — and durably records `INGRESS_ADMITTED`
 * / `OWNER_APPROVAL_INGRESS` — *before* the peer-identity check, the ancestry walk, `lsof`, the
 * transcript read, and the Buzz relay contact that follow it, all of which can still deny. That
 * admission is not rolled back by a later denial, and is not meant to be: it is real evidence
 * about the inbound envelope itself ("this exact nonce, from this exact allowlisted actor,
 * arrived"), independent of and prior to any question about what the claim it names goes on to
 * do — exactly like an ordinary Telegram or Buzz message's admission is recorded before the
 * daemon decides what to do with it. `OwnerAuthority.consumeApproval` is the gate that actually
 * matters for replay, and it lives inside `CanonicalSelfClaim`'s own transaction, rolled back on
 * every denial along with the rest of the adoption state — this earlier admission step never
 * substitutes for it. Moving admission after the identity check was considered and rejected: it
 * would mean re-deriving `CanonicalSelfClaim`'s own ancestry/version/transcript logic a second
 * time just to decide whether admission may proceed, duplicating exactly the logic this module
 * exists to compose rather than reimplement.
 */
const admitOwnerApproval = (
  deps: CanonicalSelfClaimOperatorDeps,
  request: CanonicalSelfClaimOperatorRequest,
): Decision<OwnerApprovalReceipt> => {
  const guard = new IngressGuard(deps.db, deps.clock, deps.audit, {
    cli: { allowedActors: [deps.ownerActor] },
  });
  const approval = {
    runId: null,
    candidateSnapshotDigest: null,
    operation: SELF_CLAIM_OPERATION,
    parameters: {
      domain: SELF_CLAIM_OPERATION,
      projectId: request.projectId,
      claimedSessionUuid: request.claimedSessionUuid,
      role: "PRIMARY_CTO",
      expectedBindingGeneration: request.expectedBindingGeneration,
    },
    idempotencyKey: `claim-canonical-cto:${request.projectId}:${request.expectedBindingGeneration}:${request.ownerNonce}`,
    approved: true,
  };
  return guard.admitOwnerApproval(
    { channel: "cli", actor: deps.ownerActor, nonce: request.ownerNonce, payload: ownerApprovalPayload(approval) },
    approval,
  );
};

/**
 * The one callable, routable terminal slice #760 round 3 requires: peer credentials derived from
 * the accepted connection, an owner approval admitted through real ingress, and
 * `CanonicalSelfClaim.claim()` composed to produce a READY session, `PRIMARY_CTO` assignment,
 * target binding, attestation, `buzz_actor_id` and `buzz_address` — or none of it.
 *
 * The peer identity check is deliberately the very first thing this does, before any admission,
 * ancestry walk, `lsof`, transcript read, or Buzz relay contact: a caller that is not even the
 * kernel-verified peer this deployment expects should never cause any of that side-effecting I/O,
 * authenticated or not.
 */
export const executeCanonicalSelfClaimOperator = async (
  socket: Socket,
  rawParams: Record<string, unknown>,
  deps: CanonicalSelfClaimOperatorDeps,
): Promise<Decision<CanonicalSelfClaimReceipt>> => {
  const parsed = parseCanonicalSelfClaimOperatorRequest(rawParams);
  if (!parsed.allowed) return parsed;
  const request = parsed.value;

  const credentials = derivePeerCredentialsFromSocket(socket);
  if (credentials === null) {
    return deny(
      ReasonCode.OPERATOR_UNAUTHENTICATED,
      "the connecting peer's kernel credentials could not be established",
      {},
    );
  }
  if (credentials.uid !== process.geteuid?.()) {
    return deny(
      ReasonCode.OPERATOR_UNAUTHENTICATED,
      "the connecting peer's effective uid does not match this daemon's own",
      { observedUid: credentials.uid },
    );
  }

  const approval = admitOwnerApproval(deps, request);
  if (!approval.allowed) return approval as Decision<CanonicalSelfClaimReceipt>;

  const claim = new CanonicalSelfClaim(
    deps.db,
    deps.clock,
    deps.sessions,
    deps.bindings,
    deps.ownerAuthority,
    deps.buzzActorAuthenticator,
    deps.resolveBuzzAddress,
    deps.config,
  );
  return claim.claim({
    callerPid: credentials.peerPid,
    claimedSessionUuid: request.claimedSessionUuid,
    projectId: request.projectId,
    expectedBindingGeneration: request.expectedBindingGeneration,
    ownerApproval: approval.value,
    peerProtocolVersion: request.peerProtocolVersion,
    // Derived from the kernel-verified connection, never from the request body — this is the
    // "connected peer identity" clause 2 names, expressed as the effective uid the socket
    // actually belongs to rather than a string the caller could type.
    peerIdentity: `uid:${credentials.uid}`,
    buzzChannelId: request.buzzChannelId,
    buzzActorId: request.buzzActorId,
    buzzPurpose: request.buzzPurpose,
  });
};
