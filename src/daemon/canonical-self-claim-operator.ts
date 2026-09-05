import type { Socket } from "node:net";

import type { OwnerApprovalReceipt, OwnerAuthorityPort } from "../ceo/owner-authority.ts";
import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { getPeerCredentials, type PeerCredentials } from "../core/peercred.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { Db } from "../db/database.ts";
import {
  CanonicalSelfClaim,
  type CanonicalSelfClaimConfig,
  type CanonicalSelfClaimDeps,
  type CanonicalSelfClaimReceipt,
} from "../registry/canonical-self-claim.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { BuzzActorAuthenticator, SessionRegistry } from "../session/session-registry.ts";

/**
 * The one production call site #539/#760 authorizes: `actor.claimCanonicalCto`'s operator
 * handler. `scripts/verify-peercred-is-unreachable.mjs` allowlists exactly this file by path;
 * nothing else in `src/` may import `../core/peercred.ts`.
 *
 * #760 round 4 correction A — this module never mints an owner approval and never admits one.
 * Minting happens exactly once, elsewhere: `Daemon.executeApproveCanonicalCtoClaim`
 * (`OPERATOR_METHOD.OWNER_APPROVE_CLAIM_CANONICAL_CTO`), reached only through the normal
 * bearer-authenticated operator method table — a channel this file's exported function never
 * touches and the claiming connection never needs to reach. The bootstrap problem is not solved
 * by handing the claimant owner authority: the claiming connection presents a `(channel, nonce)`
 * handle naming a decision an owner already made, and this module *loads and verifies* that
 * decision — it does not make one.
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
 * payload. Those are each explicitly not substitutes: a caller can assert any pid it likes in a
 * JSON body, and the whole point of this primitive is that nothing here ever reads that assertion
 * as identity.
 */
export const derivePeerCredentialsFromSocket = (socket: Socket): PeerCredentials | null => {
  const fd = rawFd(socket);
  return fd === null ? null : getPeerCredentials(fd);
};

export interface CanonicalSelfClaimOperatorDeps {
  db: Db;
  clock: Clock;
  sessions: SessionRegistry;
  bindings: BindingRegistry;
  ownerAuthority: OwnerAuthorityPort;
  buzzActorAuthenticator: BuzzActorAuthenticator;
  /** Opens the Buzz routing channel; a thin wrapper over the deployment's own transport. */
  resolveBuzzAddress: (purpose: string) => Promise<Decision<string>>;
  /**
   * #760 round 4 correction C — deployment facts, fixed at composition time, never read from the
   * claiming request: the peer protocol version this socket speaks, the canonical Buzz channel,
   * the Buzz channel identity this session will authenticate as, and the routing purpose passed
   * to `resolveBuzzAddress`. `buzzPurpose` in particular used to be caller-supplied input reaching
   * a resolver with no expected-purpose check at all — moving it here removes that surface rather
   * than adding a check for it.
   */
  config: CanonicalSelfClaimConfig & {
    peerProtocolVersion: string;
    buzzChannelId: string;
    buzzActorId: string;
    buzzPurpose: string;
  };
  /**
   * `CanonicalSelfClaim`'s own injectable process/image/transcript inspectors — a test-only
   * escape hatch. Production composition (`src/daemon/agentcpd.ts`) never sets this, so
   * `CanonicalSelfClaim` falls back to its real, OS-backed defaults there. A process test that
   * needs the kernel-derived peer identity and the real `ps`/`lsof`-backed ancestry walk to be
   * genuine (that is the property this operator exists to prove) but must not depend on this
   * machine's actual `~/.claude/projects` transcript directory — or on whatever real process
   * happens to be running above the test in this environment's own ancestry — sets exactly the
   * inspector it needs to replace, leaving the rest real. Found necessary by review (round 5):
   * without this seam, a process test's fixture file was written to disk and never actually
   * read, because the operator always constructed `CanonicalSelfClaim` with no deps at all — the
   * test's assertions passed only because this specific developer machine happened to already
   * hold that exact file on disk for the real production `CANONICAL_SESSION_UUID` the test
   * reused, which is not true of a CI runner or any other machine.
   */
  claimDeps?: CanonicalSelfClaimDeps;
}

export interface CanonicalSelfClaimOperatorRequest {
  claimedSessionUuid: string;
  projectId: string;
  expectedBindingGeneration: number;
  /** The `(channel="cli", nonce)` handle naming an owner approval admitted earlier, elsewhere. */
  ownerApprovalNonce: string;
}

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Parses and requires every field `CanonicalSelfClaimOperatorRequest` needs, nothing assumed. */
export const parseCanonicalSelfClaimOperatorRequest = (
  params: Record<string, unknown>,
): Decision<CanonicalSelfClaimOperatorRequest> => {
  const claimedSessionUuid = params["claimedSessionUuid"];
  const projectId = params["projectId"];
  const expectedBindingGeneration = params["expectedBindingGeneration"];
  const ownerApprovalNonce = params["ownerApprovalNonce"];
  if (
    !isNonEmptyString(claimedSessionUuid) ||
    !isNonEmptyString(projectId) ||
    !Number.isSafeInteger(expectedBindingGeneration) ||
    !isNonEmptyString(ownerApprovalNonce)
  ) {
    return deny(ReasonCode.INVALID_ARGUMENT, "claim canonical-cto request is missing a required field", {});
  }
  return allow(ReasonCode.OK, {
    claimedSessionUuid,
    projectId,
    expectedBindingGeneration: expectedBindingGeneration as number,
    ownerApprovalNonce,
  });
};

interface StoredOwnerApprovalPayload {
  type: "OWNER_APPROVAL";
  runId: string | null;
  candidateSnapshotDigest: string | null;
  operation: string;
  parameterDigest: string;
  idempotencyKey: string;
  approved: boolean;
}

const isStoredOwnerApprovalPayload = (value: unknown): value is StoredOwnerApprovalPayload => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record["type"] === "OWNER_APPROVAL" &&
    (record["runId"] === null || typeof record["runId"] === "string") &&
    (record["candidateSnapshotDigest"] === null || typeof record["candidateSnapshotDigest"] === "string") &&
    typeof record["operation"] === "string" &&
    typeof record["parameterDigest"] === "string" &&
    typeof record["idempotencyKey"] === "string" &&
    typeof record["approved"] === "boolean"
  );
};

/**
 * Reads back an owner approval that some *other*, earlier, owner-authenticated call already
 * admitted — never mints, never admits, never accepts approval content from the claiming request.
 *
 * `IngressGuard.admit` persists the exact admitted envelope into
 * `inbound_messages.payload_json` (the same durable row `OwnerAuthority.assertApproval` joins
 * `(channel, nonce)` against — `src/ingress/ingress-guard.ts`, `src/ceo/owner-authority.ts`), and
 * `ownerApprovalPayload` shapes that envelope as `{type, runId, candidateSnapshotDigest,
 * operation, parameterDigest, idempotencyKey, approved}`. Reconstructing an `OwnerApprovalReceipt`
 * from exactly that stored row — plus the row's own `actor` column and the `nonce` the caller
 * named — is reading an owner's already-made decision, not accepting the claimant's word for one:
 * every field comes from storage this connection cannot write to (writing it requires the
 * `owner.approveClaimCanonicalCto` operator method, authenticated by the shared bearer token, not
 * by this socket's kernel identity).
 *
 * Returns `null` for anything that does not check out — no such nonce, no payload, a payload that
 * is not a valid `OWNER_APPROVAL` envelope — so a missing or fabricated handle denies before this
 * value is ever handed to `OwnerAuthority`.
 */
const loadAdmittedOwnerApproval = (db: Db, nonce: string): OwnerApprovalReceipt | null => {
  const row = db.get<{ actor: string; payload_json: string | null }>(
    `SELECT actor, payload_json FROM inbound_messages WHERE channel = 'cli' AND nonce = ?`,
    [nonce],
  );
  if (!row || row.payload_json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json);
  } catch {
    return null;
  }
  if (!isStoredOwnerApprovalPayload(parsed)) return null;
  return {
    channel: "cli",
    actor: row.actor,
    inboundNonce: nonce,
    runId: parsed.runId,
    candidateSnapshotDigest: parsed.candidateSnapshotDigest,
    operation: parsed.operation,
    parameterDigest: parsed.parameterDigest,
    idempotencyKey: parsed.idempotencyKey,
    approved: parsed.approved,
  };
};

/**
 * Correction B — this deployment expects a direct local connection from the exact claude process,
 * not one relayed through an entitlement-checked proxy. `src/core/peercred.ts` documents the
 * distinction its own type carries: `peerPid` is who opened the socket, `effectivePid` is who a
 * proxy says is acting on their behalf, and the two differ exactly when a proxy sits in between.
 * A mismatch denies before the approval handle is ever looked up. Exported as its own pure
 * function — no socket, no I/O — so the mismatch case is a focused unit test rather than
 * something only provable by constructing a real entitlement-checked proxy.
 */
export const assertDirectPeer = (credentials: PeerCredentials): Decision<PeerCredentials> => {
  if (credentials.peerPid !== credentials.effectivePid) {
    return deny(
      ReasonCode.OPERATOR_UNAUTHENTICATED,
      "the connecting peer is not a direct connection; a proxied identity is not accepted",
      { peerPid: credentials.peerPid, effectivePid: credentials.effectivePid },
    );
  }
  return allow(ReasonCode.OK, credentials);
};

/**
 * The one callable, routable terminal slice #760 requires: peer credentials derived from the
 * accepted connection, an *already-admitted* owner approval loaded back out of storage, and
 * `CanonicalSelfClaim.claim()` composed to produce a READY session, `PRIMARY_CTO` assignment,
 * target binding, attestation, `buzz_actor_id` and `buzz_address` — or none of it.
 *
 * Ordering: peer identity (both the kernel-established credential and correction B's
 * `peerPid === effectivePid` requirement) is checked first, before the approval is even looked
 * up — a caller that is not the exact, non-proxied peer this deployment expects should never
 * cause the lookup, the ancestry walk, `lsof`, the transcript read, or the Buzz relay contact that
 * follow it. `CanonicalSelfClaim.claim()` itself then re-validates the loaded receipt's operation,
 * parameter binding and `approved` flag before opening its own transaction, exactly as it does for
 * every other caller — this module adds no second copy of that logic, it only refuses to
 * fabricate what `claim()` verifies.
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
  const direct = assertDirectPeer(credentials);
  if (!direct.allowed) return direct as Decision<CanonicalSelfClaimReceipt>;
  if (credentials.uid !== process.geteuid?.()) {
    return deny(
      ReasonCode.OPERATOR_UNAUTHENTICATED,
      "the connecting peer's effective uid does not match this daemon's own",
      { observedUid: credentials.uid },
    );
  }

  const ownerApproval = loadAdmittedOwnerApproval(deps.db, request.ownerApprovalNonce);
  if (ownerApproval === null) {
    return deny(
      ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
      "no admitted owner approval exists for the presented handle",
      {},
    );
  }

  const claim = new CanonicalSelfClaim(
    deps.db,
    deps.clock,
    deps.sessions,
    deps.bindings,
    deps.ownerAuthority,
    deps.buzzActorAuthenticator,
    deps.resolveBuzzAddress,
    deps.config,
    deps.claimDeps ?? {},
  );
  return claim.claim({
    callerPid: credentials.peerPid,
    claimedSessionUuid: request.claimedSessionUuid,
    projectId: request.projectId,
    expectedBindingGeneration: request.expectedBindingGeneration,
    ownerApproval,
    peerProtocolVersion: deps.config.peerProtocolVersion,
    // Derived from the kernel-verified connection, never from the request body — this is the
    // "connected peer identity" clause 2 names, expressed as the effective uid the socket
    // actually belongs to rather than a string the caller could type.
    peerIdentity: `uid:${credentials.uid}`,
    buzzChannelId: deps.config.buzzChannelId,
    buzzActorId: deps.config.buzzActorId,
    buzzPurpose: deps.config.buzzPurpose,
  });
};
