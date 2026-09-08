import type { OwnerApprovalReceipt, OwnerAuthorityPort } from "../ceo/owner-authority.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { processStartedAt } from "../core/process-identity.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { Role, roleKeyFor } from "../domain/types.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRegistry } from "../session/session-registry.ts";

/**
 * The owner operation this door authorises. Named once, here, and bound into the approval
 * envelope's `parameterDigest`, so an approval minted for any other operation — a run decision,
 * a repair, a canonical self-claim — cannot be replayed at this door and vice versa.
 */
export const DEAD_BINDING_RECOVERY_OPERATION = "binding.recover_dead_canonical";

/**
 * What the recovery releases. Deliberately one role and not a parameter with a default: this
 * door exists for the canonical CTO binding that locks a restart out, and a caller naming
 * anything else is answered with a refusal rather than with a wider capability.
 */
export const DEAD_BINDING_RECOVERY_ROLE = Role.PRIMARY_CTO;

/**
 * A three-valued answer to "is the process behind this session still running".
 *
 * Two-valued is the wrong shape here and the difference is the whole guard. `Daemon.reconcile`'s
 * own `isAlive` collapses every failure of `kill(pid, 0)` to "not alive", which is right for a
 * sweep whose worst case is marking a session ERROR that a later probe corrects. It is wrong for
 * a door that *releases an authority*: `EPERM` means the pid exists and belongs to someone else,
 * and reading that as dead would let a live incumbent be evicted by a caller who cannot even
 * signal it. So the failure modes are separated, and only `ESRCH` — or a pid whose recorded
 * start time no longer matches — is allowed to mean dead.
 */
export type SessionLiveness = "ALIVE" | "DEAD" | "UNKNOWN";

/**
 * Proves — or fails to prove — that the process a session names is gone.
 *
 * `UNKNOWN` is returned wherever the evidence does not decide, and every caller here treats it
 * as a refusal. That asymmetry is deliberate: a false "dead" revokes a live authority, while a
 * false "unknown" only means an operator has to establish the fact some other way.
 *
 * The `(pid, startedAt)` comparison is the pid-reuse case, and it is the one place this returns
 * `DEAD` for a pid that answers. `src/core/process-identity.ts` states the invariant this leans
 * on: the pair stays unique for as long as the process lives, so a *different* start time on the
 * same number is positive evidence that the recorded process has exited and an unrelated one has
 * inherited its slot. Without this branch a recovery would be impossible after any pid reuse,
 * which on a busy host is a matter of hours.
 */
export const probeSessionLiveness = (
  osPid: number | null,
  recordedStartedAt: string | null,
  probe: {
    signal?: (pid: number) => void;
    startedAt?: (pid: number) => string | null;
  } = {},
): SessionLiveness => {
  if (osPid === null || !Number.isSafeInteger(osPid) || osPid <= 0) return "UNKNOWN";
  const signal = probe.signal ?? ((pid: number) => process.kill(pid, 0));
  const readStartedAt = probe.startedAt ?? processStartedAt;
  try {
    signal(osPid);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ESRCH") return "DEAD";
    // The process exists; this deployment simply may not signal it. Refusing is the only safe
    // reading, and it is the reading that keeps another user's live process from being treated
    // as an absent one.
    if (code === "EPERM") return "ALIVE";
    return "UNKNOWN";
  }
  // Something answers on that number. Whether it is *this* session's process is a question the
  // pid alone cannot answer.
  if (recordedStartedAt === null) return "ALIVE";
  const current = readStartedAt(osPid);
  if (current === null) return "UNKNOWN";
  return current === recordedStartedAt ? "ALIVE" : "DEAD";
};

/** Everything the recovery names, all required, none defaulted. */
export interface DeadBindingRecoveryRequest {
  projectId: string;
  role: string;
  sessionId: string;
  sessionIncarnation: string;
  expectedBindingGeneration: number;
  /** The owner's own nonce for this decision; replay protection lives in `IngressGuard`. */
  nonce: string;
  approved: boolean;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * Parses the request with no defaults anywhere.
 *
 * `approved` in particular has no `?? true`: an omitted or malformed field is not an owner
 * saying yes, and treating it as one would make the cheapest possible request the most
 * powerful one.
 */
export const parseDeadBindingRecoveryRequest = (
  params: Record<string, unknown>,
): Decision<DeadBindingRecoveryRequest> => {
  const projectId = params["projectId"];
  const role = params["role"];
  const sessionId = params["sessionId"];
  const sessionIncarnation = params["sessionIncarnation"];
  const expectedBindingGeneration = params["expectedBindingGeneration"];
  const nonce = params["nonce"];
  const approved = params["approved"];
  if (
    !isNonEmptyString(projectId) ||
    !isNonEmptyString(role) ||
    !isNonEmptyString(sessionId) ||
    !isNonEmptyString(sessionIncarnation) ||
    !Number.isSafeInteger(expectedBindingGeneration) ||
    (expectedBindingGeneration as number) < 1 ||
    !isNonEmptyString(nonce) ||
    typeof approved !== "boolean"
  ) {
    return deny(
      ReasonCode.INVALID_ARGUMENT,
      "dead canonical binding recovery is missing a required field",
      {},
    );
  }
  return allow(ReasonCode.OK, {
    projectId,
    role,
    sessionId,
    sessionIncarnation,
    expectedBindingGeneration: expectedBindingGeneration as number,
    nonce,
    approved,
  });
};

export interface DeadBindingRecoveryDeps {
  db: Db;
  audit: AuditLog;
  sessions: SessionRegistry;
  bindings: BindingRegistry;
  ownerAuthority: OwnerAuthorityPort;
  /**
   * Mints and admits the owner-approval envelope through this deployment's ingress policy.
   *
   * A parameter rather than something built here because the allowlist, the guard and the
   * replay record all belong to the daemon's composition — this module verifies an approval, it
   * does not decide who may give one.
   */
  admitOwnerApproval: (
    actor: string,
    approval: {
      runId: string | null;
      candidateSnapshotDigest: string | null;
      operation: string;
      parameters: unknown;
      idempotencyKey: string;
      approved: boolean;
    },
    nonce: string,
  ) => Decision<OwnerApprovalReceipt>;
  /** Test seam for the liveness probe; production passes nothing and gets the real syscall. */
  liveness?: {
    signal?: (pid: number) => void;
    startedAt?: (pid: number) => string | null;
  };
}

export interface DeadBindingRecoveryReceipt {
  projectId: string;
  roleKey: string;
  assignmentId: string;
  sessionId: string;
  releasedGeneration: number;
  liveness: SessionLiveness;
}

/**
 * Releases a PRIMARY_CTO binding whose session's process is provably gone, and nothing else.
 *
 * This is the door a parked daemon serves for CTO_BINDING_POINTS_AT_DEAD_SESSION. It is
 * deliberately *not* `CtoLifecycle.recoveryTakeover`: that path spawns a replacement CTO and
 * mints it a new generation, which is normal work, and normal work is exactly what a parked
 * daemon must not perform. What this does is strictly smaller — it removes the stale claim on
 * the role and stops. Whoever takes the role afterwards does so through the ordinary
 * provisioning paths, once the daemon has passed its doctor and come up.
 *
 * Everything happens in one transaction: the approval's admission and its consumption, the
 * generation/incarnation re-read, the revoke (which fences the outbox inside the same
 * transaction, in `BindingRegistry.revoke`), and the audit record. A denial returned from this
 * body rolls the whole thing back through `txDecision`, so a refused recovery spends no nonce
 * and leaves no half-released role. The re-read inside the transaction is not redundant with the
 * caller's checks: the liveness probe is a syscall taken outside any transaction, and a binding
 * that moved in that window must not be released by a decision made about the old one.
 *
 * Generation never moves backwards here because nothing is minted. `expectedBindingGeneration`
 * must equal the generation actually held, so a replayed request naming a superseded generation
 * is refused rather than applied; and `BindingRegistry.nextGeneration` counts over the whole
 * history including REVOKED rows, so whatever binds this role next is strictly greater than
 * what this released.
 */
export const recoverDeadCanonicalBinding = (
  actor: string,
  request: DeadBindingRecoveryRequest,
  deps: DeadBindingRecoveryDeps,
): Decision<DeadBindingRecoveryReceipt> => {
  if (request.role !== DEAD_BINDING_RECOVERY_ROLE) {
    return deny(
      ReasonCode.INVALID_ARGUMENT,
      "this door recovers the canonical PRIMARY_CTO binding and no other role",
      { role: request.role, supportedRole: DEAD_BINDING_RECOVERY_ROLE },
    );
  }
  // An explicit rejection is a decision, and the decision it records is "no". Reaching the
  // release with `approved: false` would make the field decorative.
  if (!request.approved) {
    return deny(
      ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
      "the owner decision presented for this recovery is a rejection",
      { projectId: request.projectId, sessionId: request.sessionId },
    );
  }

  const roleKey = roleKeyFor(DEAD_BINDING_RECOVERY_ROLE, { projectId: request.projectId });
  const approval = {
    runId: null,
    candidateSnapshotDigest: null,
    operation: DEAD_BINDING_RECOVERY_OPERATION,
    // Every field the owner is answering for is inside the digest. An approval for one project,
    // session, incarnation or generation therefore cannot authorise the release of another.
    parameters: {
      domain: DEAD_BINDING_RECOVERY_OPERATION,
      projectId: request.projectId,
      role: DEAD_BINDING_RECOVERY_ROLE,
      sessionId: request.sessionId,
      sessionIncarnation: request.sessionIncarnation,
      expectedBindingGeneration: request.expectedBindingGeneration,
    },
    idempotencyKey: `recover-dead-canonical-binding:${request.nonce}`,
    approved: request.approved,
  };

  return deps.db.txDecision<DeadBindingRecoveryReceipt>(() => {
    const current = deps.bindings.active(roleKey);
    if (!current) {
      return deny(
        ReasonCode.NOT_FOUND,
        "no active binding holds this role",
        { projectId: request.projectId, roleKey },
      );
    }
    // Target verification, before any owner authority is spent. The session named is the
    // binding's *bound* session, not the actor's live runtime: this releases a claim written
    // into `assignments`, so the identity that has to match is the one recorded there.
    if (current.boundSessionId !== request.sessionId) {
      return deny(
        ReasonCode.INVALID_ARGUMENT,
        "the recovery names a session that does not hold this role",
        {
          projectId: request.projectId,
          roleKey,
          requestedSessionId: request.sessionId,
          boundSessionId: current.boundSessionId,
        },
      );
    }
    // Against the binding's own recorded incarnation, not the session row's current one. The
    // assignment names the runtime lifetime it was granted to; a respawned session carries a new
    // incarnation, and a request naming the old one is asking about an authority that has
    // already been superseded.
    if (current.boundSessionIncarnation !== request.sessionIncarnation) {
      return deny(
        ReasonCode.INVALID_ARGUMENT,
        "the recovery names a session incarnation that is not the one bound",
        {
          projectId: request.projectId,
          sessionId: request.sessionId,
          requestedIncarnation: request.sessionIncarnation,
          boundIncarnation: current.boundSessionIncarnation,
        },
      );
    }
    if (current.bindingGeneration !== request.expectedBindingGeneration) {
      return deny(
        ReasonCode.WRITE_BINDING_GENERATION_STALE,
        "the recovery names a binding generation that is not the one in force",
        {
          projectId: request.projectId,
          roleKey,
          expectedGeneration: request.expectedBindingGeneration,
          currentGeneration: current.bindingGeneration,
        },
      );
    }

    const session = deps.sessions.get(request.sessionId);
    if (!session) {
      // A binding whose session row is gone is a real state, and it is also one in which no
      // liveness can be established: there is no pid to ask about. "Unknown" is a refusal here
      // exactly as it is below, and this refusal names its own remedy rather than guessing.
      //
      // This state is knowingly left unrecoverable through this door, and that is a boundary
      // rather than an omission. The door's whole authority to release a binding rests on
      // proving that a specific process is gone; a missing session row removes the thing the
      // proof would be about, so admitting it would mean releasing on the strength of an absence
      // of evidence. Widening the range to cover it is a separate decision that has not been
      // made, and it is out of scope for this change — anyone who needs that case answered
      // should get it decided on its own terms, not by loosening this check.
      return deny(
        ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        "the bound session record is absent, so its process cannot be proven dead",
        { projectId: request.projectId, roleKey, sessionId: request.sessionId },
      );
    }

    const liveness = probeSessionLiveness(
      session.osPid,
      session.osProcessStartedAt,
      deps.liveness ?? {},
    );
    if (liveness !== "DEAD") {
      return deny(
        ReasonCode.RECOVERY_TAKEOVER_REQUIRES_UNREACHABLE_OWNER,
        liveness === "ALIVE"
          ? "the bound session's process is still running; this door releases only a dead one"
          : "the bound session's process could not be proven dead, and unproven is not recoverable",
        {
          projectId: request.projectId,
          sessionId: request.sessionId,
          osPid: session.osPid,
          liveness,
        },
      );
    }

    // Only now is owner authority created and spent. Admitting inside the transaction is what
    // makes a mid-flight failure leave the nonce unspent: an admission that survived a rolled
    // back release would be an owner decision on record for something that did not happen.
    const admitted = deps.admitOwnerApproval(actor, approval, request.nonce);
    if (!admitted.allowed) return admitted as Decision<DeadBindingRecoveryReceipt>;
    const consumed = deps.ownerAuthority.consumeApproval(admitted.value, null);
    if (!consumed.allowed) return consumed as Decision<DeadBindingRecoveryReceipt>;

    // No `allowBlockedRuns`. `revokePausedBinding` may pass it because it has already paused the
    // work; nothing here has, so a role that still owns live runs is refused and the daemon goes
    // on blocking. Sweeping that state out of sight is the outcome this whole door exists to
    // avoid.
    const revoked = deps.bindings.revoke(
      roleKey,
      `dead canonical binding recovery: session ${request.sessionId} process ${session.osPid ?? "unknown"} is gone`,
    );
    if (!revoked.allowed) return revoked as Decision<DeadBindingRecoveryReceipt>;

    deps.audit.record({
      kind: "DEAD_BINDING_RECOVERED",
      reasonCode: ReasonCode.OK,
      projectId: request.projectId,
      sessionId: request.sessionId,
      roleKey,
      actor,
      evidence: {
        assignmentId: current.assignmentId,
        releasedGeneration: current.bindingGeneration,
        sessionIncarnation: session.incarnation,
        osPid: session.osPid,
        liveness,
        ownerApprovalNonce: request.nonce,
      },
    });

    return allow(ReasonCode.OK, {
      projectId: request.projectId,
      roleKey,
      assignmentId: current.assignmentId,
      sessionId: request.sessionId,
      releasedGeneration: current.bindingGeneration,
      liveness,
    });
  });
};
