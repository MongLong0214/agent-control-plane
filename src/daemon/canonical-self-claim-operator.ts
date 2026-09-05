import type { OwnerApprovalReceipt, OwnerAuthorityPort } from "../ceo/owner-authority.ts";
import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
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
 * The claim orchestration behind `actor.claimCanonicalCto`: load an *already-admitted* owner
 * approval back out of storage and compose `CanonicalSelfClaim.claim()`.
 *
 * #760 round 6 — this module has no peer-credential logic of its own any more, and imports
 * nothing from `../core/peercred.ts`. That authority now lives entirely in
 * `canonical-self-claim-listener.ts` — the one file `scripts/verify-peercred-is-unreachable.mjs`
 * allowlists for it — which authenticates the connecting process by kernel credential *before*
 * this function is ever called, and hands the result in as a plain, already-verified
 * `{ peerPid, uid }` tuple. That split is the CEO's ruling on the mint/claim separation made
 * concrete: "a process may prove who it is, but it cannot approve itself" is a statement about
 * which *socket* a caller may reach, not an extra check layered onto a shared one — so the
 * kernel-identity check belongs to the listener that owns the socket, not to the orchestration
 * a caller could in principle reach some other way.
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
   * needs the real `ps`/`lsof`-backed ancestry walk to be genuine (that is the property this
   * primitive exists to prove) but must not depend on this machine's actual
   * `~/.claude/projects` transcript directory sets exactly the inspector it needs to replace,
   * leaving the rest real.
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
 * `owner.approveClaimCanonicalCto` operator method, authenticated by the shared bearer token on a
 * socket this listener does not serve).
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
 * The claim orchestration: an *already-admitted* owner approval loaded back out of storage, and
 * `CanonicalSelfClaim.claim()` composed to produce a READY session, `PRIMARY_CTO` assignment,
 * target binding, attestation, `buzz_actor_id` and `buzz_address` — or none of it.
 *
 * `peer` is a plain `{ peerPid, uid }` tuple the caller (`canonical-self-claim-listener.ts`) has
 * already authenticated against the kernel and this deployment's own effective uid, and against
 * `peerPid === effectivePid`, before this function is ever invoked — this orchestration performs
 * no kernel-credential check of its own and has no way to. `CanonicalSelfClaim.claim()` itself
 * then re-validates the loaded receipt's operation, parameter binding and `approved` flag before
 * opening its own transaction, exactly as it does for every other caller — this module adds no
 * second copy of that logic, it only refuses to fabricate what `claim()` verifies.
 */
export const executeCanonicalSelfClaimOperator = async (
  peer: { peerPid: number; uid: number },
  rawParams: Record<string, unknown>,
  deps: CanonicalSelfClaimOperatorDeps,
): Promise<Decision<CanonicalSelfClaimReceipt>> => {
  const parsed = parseCanonicalSelfClaimOperatorRequest(rawParams);
  if (!parsed.allowed) return parsed;
  const request = parsed.value;

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
    callerPid: peer.peerPid,
    claimedSessionUuid: request.claimedSessionUuid,
    projectId: request.projectId,
    expectedBindingGeneration: request.expectedBindingGeneration,
    ownerApproval,
    peerProtocolVersion: deps.config.peerProtocolVersion,
    // Derived from the kernel-verified connection, never from the request body — this is the
    // "connected peer identity" clause 2 names, expressed as the effective uid the socket
    // actually belongs to rather than a string the caller could type.
    peerIdentity: `uid:${peer.uid}`,
    buzzChannelId: deps.config.buzzChannelId,
    buzzActorId: deps.config.buzzActorId,
    buzzPurpose: deps.config.buzzPurpose,
  });
};
