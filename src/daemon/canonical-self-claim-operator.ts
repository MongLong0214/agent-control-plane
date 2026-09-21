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
 * The claim orchestration behind `actor.claimCanonicalCto`: compose `CanonicalSelfClaim.claim()`.
 *
 * This module has no peer-credential logic of its own (#760), and imports nothing from
 * `../core/peercred.ts`. That authority lives entirely in `canonical-self-claim-listener.ts` —
 * the one file `scripts/verify-peercred-is-unreachable.mjs` allowlists for it — which
 * authenticates the connecting process by kernel credential *before* this function is ever
 * called, and hands the result in as a plain, already-verified `{ peerPid, uid }` tuple. A
 * process may prove who it is, but it cannot approve itself: that is a statement about which
 * *socket* a caller may reach, not an extra check layered onto a shared one — so the
 * kernel-identity check belongs to the listener that owns the socket, not to the orchestration
 * a caller could in principle reach some other way.
 *
 * This module reads no owner approval, because the claim no longer requires one. It used to
 * demand a `(channel, nonce)` handle naming a decision an owner had minted beforehand through
 * `owner.approveClaimCanonicalCto`, which made binding the canonical CTO role conditional on a
 * human running a command. Measured on this deployment: four such mints, then none, and the role
 * sat unbound for eight days with every Buzz mention in that window delivered nowhere. The
 * authority that remains is the socket's — a caller reaches this only after
 * `canonical-self-claim-listener.ts` has authenticated it by kernel credential.
 */

export interface CanonicalSelfClaimOperatorDeps {
  db: Db;
  clock: Clock;
  sessions: SessionRegistry;
  bindings: BindingRegistry;
  buzzActorAuthenticator: BuzzActorAuthenticator;
  /** Opens the Buzz routing channel; a thin wrapper over the deployment's own transport. */
  resolveBuzzAddress: (purpose: string) => Promise<Decision<string>>;
  /**
   * Deployment facts, fixed at composition time, never read from the claiming request (#760): the
   * peer protocol version this socket speaks, the canonical Buzz channel, the Buzz channel
   * identity this session will authenticate as, and the routing purpose passed to
   * `resolveBuzzAddress`. None of these are caller-supplied input reaching a resolver with no
   * expected-purpose check; fixing them here removes that surface entirely rather than adding a
   * check for it.
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
}

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Parses and requires every field `CanonicalSelfClaimOperatorRequest` needs, nothing assumed. */
export const parseCanonicalSelfClaimOperatorRequest = (
  params: Record<string, unknown>,
): Decision<CanonicalSelfClaimOperatorRequest> => {
  const claimedSessionUuid = params["claimedSessionUuid"];
  const projectId = params["projectId"];
  const expectedBindingGeneration = params["expectedBindingGeneration"];
  if (
    !isNonEmptyString(claimedSessionUuid) ||
    !isNonEmptyString(projectId) ||
    !Number.isSafeInteger(expectedBindingGeneration)
  ) {
    return deny(ReasonCode.INVALID_ARGUMENT, "claim canonical-cto request is missing a required field", {});
  }
  return allow(ReasonCode.OK, {
    claimedSessionUuid,
    projectId,
    expectedBindingGeneration: expectedBindingGeneration as number,
  });
};

/**
 * The claim orchestration: `CanonicalSelfClaim.claim()` composed to produce a READY session,
 * `PRIMARY_CTO` assignment, target binding, attestation, `buzz_actor_id` and `buzz_address` —
 * or none of it.
 *
 * `peer` is a plain `{ peerPid, uid }` tuple the caller (`canonical-self-claim-listener.ts`) has
 * already authenticated against the kernel and this deployment's own effective uid, and against
 * `peerPid === effectivePid`, before this function is ever invoked — this orchestration performs
 * no kernel-credential check of its own and has no way to.
 */
export const executeCanonicalSelfClaimOperator = async (
  peer: { peerPid: number; uid: number },
  rawParams: Record<string, unknown>,
  deps: CanonicalSelfClaimOperatorDeps,
): Promise<Decision<CanonicalSelfClaimReceipt>> => {
  const parsed = parseCanonicalSelfClaimOperatorRequest(rawParams);
  if (!parsed.allowed) return parsed;
  const request = parsed.value;

  const claim = new CanonicalSelfClaim(
    deps.db,
    deps.clock,
    deps.sessions,
    deps.bindings,
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
