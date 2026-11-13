import { readProcessStartToken } from "../core/process-argv.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { Db } from "../db/database.ts";
import { probeSessionLiveness, type SessionLiveness } from "../daemon/dead-binding-recovery.ts";
import { TERMINAL_RUN_STATES } from "../domain/run-state.ts";
import { Role, RunKind, type RoleBinding, type RunRow, SessionLifecycle, roleKeyFor } from "../domain/types.ts";
import { CanonicalSessionRegistry } from "../registry/canonical-session-registry.ts";
import {
  type CanonicalAdoptableSession,
  isAdoptedCanonicalRuntime,
  type PeerMessageSuccession,
  peerMessageSuccessionIsProven,
  SELF_CLAIM_EXECUTOR_KIND,
} from "../registry/canonical-self-claim.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRecord, SessionRegistry } from "../session/session-registry.ts";
import { type CanonicalCtoBootstrapAdoption, type RecordedBootstrapAdoption, recordedBootstrapAdoption } from "./bootstrap-adoption-input.ts";

/** A request, or the record a run was created with (which also names the entitlement it was admitted on). */
type AskedAdoption = CanonicalCtoBootstrapAdoption & Partial<Pick<RecordedBootstrapAdoption, "entitlementSessionUuid" | "buzzActorId">>;

/** What an adoption's validation proved about its target, read in one pass. */
export interface AdoptedCanonicalCto {
  adoption: AskedAdoption;
  /** The PRIMARY_CTO binding, in the owner-pin form (binding-time runtime, #493). */
  binding: RoleBinding;
  entry: CanonicalAdoptableSession;
  session: SessionRecord;
}

const refuse = <T>(reasonCode: ReasonCode, refusal: string, message: string, evidence: Record<string, unknown> = {}): Decision<T> =>
  deny<T>(reasonCode, message, { refusal, ...evidence });

/** The live-process reading `CtoLifecycle` dispatches an adopted canonical CTO on, as one value. */
const defaultLiveness = (session: SessionRecord): SessionLiveness | "EPERM" => {
  if (session.osPid === null || session.osProcessStartedAt === null) return "UNKNOWN";
  let refused = false;
  const liveness = probeSessionLiveness(session.osPid, session.osProcessStartedAt, {
    signal: (pid) => {
      try {
        process.kill(pid, 0);
      } catch (error) {
        refused = (error as { code?: unknown }).code === "EPERM";
        throw error;
      }
    },
    startedAt: readProcessStartToken,
  });
  return liveness === "ALIVE" && refused ? "EPERM" : liveness;
};

/** Whether an authenticated canonical claim of `identity` admitted `sessionId` to `roleKey` at `generation`. */
const selfClaimAdmitted = (db: Pick<Db, "get">, sessionId: string, roleKey: string, identity: string, generation: number): boolean =>
  db.get(
    `SELECT 1 FROM audit_events WHERE kind = 'CANONICAL_SELF_CLAIM_ADMITTED' AND session_id = ? AND role_key = ?
        AND json_extract(evidence_json, '$.identity') = ? AND json_extract(evidence_json, '$.generation') = ? LIMIT 1`,
    [sessionId, roleKey, identity, generation],
  ) !== undefined;

type OwnerPin = Pick<RunRow, "runId" | "ownerRoleKey" | "ownerSessionId" | "ownerBindingGeneration" | "ownerSessionIncarnation">;

/**
 * One CANONICAL_LIVE_RUNS_TAKEN_OVER row of a run that has a link's shape: integer generations, a from
 * session, and a to session that is the row's own `session_id`. The rows the v56 manifest-pointer guard
 * counts as links, read by its own predicate, so the chain this module walks is the chain it checks.
 * The facts the link's proof reads are typed here and judged there.
 */
interface TakeoverLink {
  event_id: number;
  from_generation: number;
  to_generation: number;
  from_session: string;
  to_session_id: string;
  actor_id: unknown;
  actor_type: string | null;
  recovery_event_id: unknown;
  recovery_type: string | null;
  from_incarnation: unknown;
  incarnation_type: string | null;
}

const takeoverLinks = (db: Pick<Db, "all">, runId: string, roleKey: string, projectId: string): TakeoverLink[] =>
  db.all<TakeoverLink>(
    `SELECT event_id,
            json_extract(evidence_json, '$.fromGeneration') AS from_generation,
            json_extract(evidence_json, '$.toGeneration') AS to_generation,
            json_extract(evidence_json, '$.fromSession') AS from_session,
            session_id AS to_session_id,
            json_extract(evidence_json, '$.actorId') AS actor_id, json_type(evidence_json, '$.actorId') AS actor_type,
            json_extract(evidence_json, '$.recoveryAuditEventId') AS recovery_event_id,
            json_type(evidence_json, '$.recoveryAuditEventId') AS recovery_type,
            json_extract(evidence_json, '$.sessionIncarnation') AS from_incarnation,
            json_type(evidence_json, '$.sessionIncarnation') AS incarnation_type
       FROM audit_events
      WHERE run_id = ? AND kind = 'CANONICAL_LIVE_RUNS_TAKEN_OVER' AND project_id IS ? AND role_key IS ?
        AND CASE WHEN json_valid(evidence_json) THEN
              json_type(evidence_json, '$.fromGeneration') = 'integer'
              AND json_type(evidence_json, '$.toGeneration') = 'integer'
              AND json_type(evidence_json, '$.fromSession') = 'text'
              AND json_type(evidence_json, '$.toSessionId') = 'text'
              AND json_extract(evidence_json, '$.toSessionId') IS session_id
            ELSE 0 END
      ORDER BY event_id`,
    [runId, projectId, roleKey],
  );

/**
 * v57 — one CANONICAL_ENTITLEMENT_TRANSFER_RUN_HANDED_OVER row of a run: the claim of a CEO entitlement transfer
 * moved the run's pin from `from_generation` (the transferred-away conversation's) to `to_generation`, the new
 * conversation's first, in the row's own `session_id`. Typed here; judged against the transfer row it names.
 */
interface TransferLink {
  event_id: number;
  transfer_id: string;
  from_generation: number;
  to_generation: number;
  from_session: string;
  to_session_id: string;
  from_uuid: string;
  to_uuid: string;
}

const transferLinks = (db: Pick<Db, "all">, runId: string, roleKey: string, projectId: string): TransferLink[] =>
  db.all<TransferLink>(
    `SELECT event_id,
            json_extract(evidence_json, '$.transferId') AS transfer_id,
            json_extract(evidence_json, '$.fromGeneration') AS from_generation,
            json_extract(evidence_json, '$.toGeneration') AS to_generation,
            json_extract(evidence_json, '$.fromSession') AS from_session,
            session_id AS to_session_id,
            json_extract(evidence_json, '$.fromSessionUuid') AS from_uuid,
            json_extract(evidence_json, '$.toSessionUuid') AS to_uuid
       FROM audit_events
      WHERE run_id = ? AND kind = 'CANONICAL_ENTITLEMENT_TRANSFER_RUN_HANDED_OVER' AND project_id IS ? AND role_key IS ?
        AND CASE WHEN json_valid(evidence_json) THEN
              json_type(evidence_json, '$.transferId') = 'text'
              AND json_type(evidence_json, '$.fromGeneration') = 'integer'
              AND json_type(evidence_json, '$.toGeneration') = 'integer'
              AND json_type(evidence_json, '$.fromSession') = 'text'
              AND json_type(evidence_json, '$.fromSessionUuid') = 'text'
              AND json_type(evidence_json, '$.toSessionUuid') = 'text'
              AND json_extract(evidence_json, '$.toSessionId') IS session_id
            ELSE 0 END
      ORDER BY event_id`,
    [runId, projectId, roleKey],
  );

/** An adoption where the official takeovers carried it, and the sessions its chain passed through, in order. */
export interface CarriedAdoption {
  adoption: RecordedBootstrapAdoption;
  through: string[];
}

/**
 * #1302 — where the official takeovers of `pin`'s run carried the adoption its RUN_CREATED recorded:
 * `record` itself while the pin is still on it, or exactly the pin once every generation between the
 * two was left by one same-conversation restart of the adopted CTO.
 *
 * The chain's shape is the one the v56 manifest-pointer guard checks, so this proof is never looser:
 * the run's own takeover rows of this project and the pin's role (`takeoverLinks`), exactly one per
 * generation from the record's to the pin's predecessor, each N to N + 1, each leaving the session the
 * link before it reached (the first, the record's), after it in event order, the last reaching the pin's
 * session. A row only names its link. Each link is proven on the facts the takeover itself was admitted
 * on, re-read from the bindings, sessions and recovery row (same actor, the record's conversation and
 * Buzz identity, N to N + 1, the predecessor recovered DEAD) by `peerMessageSuccessionIsProven`, the
 * takeover's own judgement: the link onto the pin with its successor ACTIVE, an earlier one with its
 * successor REVOKED by the later restart; and every generation it reaches was admitted by an
 * authenticated claim of the record's conversation. A link missing, ambiguous, out of
 * shape or unproven refuses by name; the run's ACTIVE owner is asked by the caller.
 */
const carriedByTakeovers = (
  db: Pick<Db, "get" | "all">,
  record: RecordedBootstrapAdoption,
  pin: OwnerPin,
): Decision<CarriedAdoption> => {
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: record.projectId });
  const broken = (takeover: string, fromGeneration: number): Decision<CarriedAdoption> =>
    deny(ReasonCode.RUN_OWNER_NOT_PINNED, "the run's owner pin was not carried to its current binding by the adopted CTO's own restarts", {
      takeover,
      fromGeneration,
    });
  if (pin.ownerRoleKey !== roleKey || pin.ownerSessionId === null || pin.ownerBindingGeneration === null || pin.ownerSessionIncarnation === null) {
    return broken("ADOPTION_TAKEOVER_PIN_FOREIGN", record.bindingGeneration);
  }
  if (pin.ownerSessionId === record.sessionId && pin.ownerBindingGeneration === record.bindingGeneration) {
    return allow(ReasonCode.OK, { adoption: record, through: [record.sessionId] });
  }
  if (pin.ownerBindingGeneration <= record.bindingGeneration) return broken("ADOPTION_TAKEOVER_NOT_PROVEN", record.bindingGeneration);
  const assignmentAt = (generation: number, sessionId: string) => {
    const rows = db.all<{ assignment_id: string; session_incarnation: string }>(
      `SELECT assignment_id, session_incarnation FROM assignments WHERE role_key = ? AND binding_generation = ? AND session_id = ?`,
      [roleKey, generation, sessionId],
    );
    return rows.length === 1 ? rows[0]! : null;
  };
  const links = takeoverLinks(db, pin.runId, roleKey, record.projectId);
  const transfers = transferLinks(db, pin.runId, roleKey, record.projectId);
  let at = { sessionId: record.sessionId, eventId: 0 };
  // The conversation holding the entitlement at `at`: the record's, until a transfer's claim moved it.
  let conversation = record.entitlementSessionUuid;
  const through = [record.sessionId];
  for (let generation = record.bindingGeneration; generation < pin.ownerBindingGeneration; generation += 1) {
    const candidates = links.filter((link) => link.from_generation === generation);
    const moved = transfers.filter((link) => link.from_generation === generation);
    if (candidates.length + moved.length === 0) return broken("ADOPTION_TAKEOVER_MISSING", generation);
    if (candidates.length + moved.length > 1) return broken("ADOPTION_TAKEOVER_AMBIGUOUS", generation);
    // v57 — a CEO entitlement transfer's claim moved the pin to another conversation, a different actor. The
    // transfer row it names is the proof: this project, the conversation the chain reached, the record's Buzz
    // actor, claimed at exactly the link's generation by the link's session, which an authenticated claim of
    // the new conversation admitted. The chain then continues on that conversation.
    if (moved.length === 1) {
      const link = moved[0]!;
      const onPin = link.to_generation === pin.ownerBindingGeneration;
      if (link.to_generation <= generation || link.to_generation > pin.ownerBindingGeneration ||
        link.from_session !== at.sessionId || link.event_id <= at.eventId || link.from_uuid !== conversation ||
        (onPin && link.to_session_id !== pin.ownerSessionId)) {
        return broken("ADOPTION_TAKEOVER_NOT_PROVEN", generation);
      }
      const transfer = db.get(
        `SELECT 1 FROM canonical_entitlement_transfers
          WHERE transfer_id = ? AND project_id = ? AND from_session_uuid = ? AND to_session_uuid = ? AND buzz_actor_id = ?
            AND claimed_at IS NOT NULL AND claimed_binding_generation = ?`,
        [link.transfer_id, record.projectId, conversation, link.to_uuid, record.buzzActorId, link.to_generation],
      );
      const prev = assignmentAt(generation, link.from_session);
      const next = assignmentAt(link.to_generation, link.to_session_id);
      if (!transfer || !prev || !next || (onPin && next.session_incarnation !== pin.ownerSessionIncarnation) ||
        !selfClaimAdmitted(db, link.to_session_id, roleKey, link.to_uuid, link.to_generation)) {
        return broken("ADOPTION_TAKEOVER_NOT_PROVEN", generation);
      }
      conversation = link.to_uuid;
      at = { sessionId: link.to_session_id, eventId: link.event_id };
      through.push(link.to_session_id);
      generation = link.to_generation - 1;
      continue;
    }
    const link = candidates[0]!;
    const onPin = generation + 1 === pin.ownerBindingGeneration;
    if (link.to_generation !== generation + 1 || link.from_session !== at.sessionId || link.event_id <= at.eventId ||
      (onPin && link.to_session_id !== pin.ownerSessionId) ||
      link.actor_type !== "text" || link.recovery_type !== "integer" || link.incarnation_type !== "text") {
      return broken("ADOPTION_TAKEOVER_NOT_PROVEN", generation);
    }
    const prev = assignmentAt(generation, link.from_session);
    const next = assignmentAt(generation + 1, link.to_session_id);
    if (!prev || !next || (onPin && next.session_incarnation !== pin.ownerSessionIncarnation)) return broken("ADOPTION_TAKEOVER_NOT_PROVEN", generation);
    const succession: Omit<PeerMessageSuccession, "proven"> = {
      roleKey,
      fromSessionId: link.from_session,
      fromSessionIncarnation: link.from_incarnation as string,
      fromGeneration: generation,
      fromAssignmentId: prev.assignment_id,
      toSessionId: link.to_session_id,
      toSessionIncarnation: next.session_incarnation,
      toGeneration: generation + 1,
      toAssignmentId: next.assignment_id,
      actorId: link.actor_id as string,
      conversationUuid: conversation,
      buzzActorId: record.buzzActorId,
      recoveryAuditEventId: link.recovery_event_id as number,
    };
    const proven = peerMessageSuccessionIsProven(db, succession, onPin ? "ACTIVE" : "REVOKED");
    if (!proven || !selfClaimAdmitted(db, link.to_session_id, roleKey, conversation, generation + 1)) {
      return broken("ADOPTION_TAKEOVER_NOT_PROVEN", generation);
    }
    at = { sessionId: link.to_session_id, eventId: link.event_id };
    through.push(link.to_session_id);
  }
  return allow(ReasonCode.OK, {
    adoption: { ...record, sessionId: pin.ownerSessionId, bindingGeneration: pin.ownerBindingGeneration, entitlementSessionUuid: conversation },
    through,
  });
};

/**
 * The adoption `runId` was created with, at the session and generation the official takeovers of its
 * owner pin carried it to (`carriedByTakeovers`): the record itself until a same-conversation restart
 * moves the pin, and on any chain that does not prove the pin's move, so every door asked with it
 * refuses. Null for a run created without the adoption. Every door reads the adoption through this.
 */
export const carriedBootstrapAdoption = (db: Pick<Db, "get" | "all">, runId: string): RecordedBootstrapAdoption | null =>
  carriedBootstrapAdoptionChain(db, runId)?.adoption ?? null;

/**
 * `carriedBootstrapAdoption` with the sessions its proven chain passed through, the record's first and
 * the pin's last (only the record's when nothing was proven to move it): the same walk, read whole, for
 * what the adopted CTO was handed before a restart moved it (activation's pending handoff).
 */
export const carriedBootstrapAdoptionChain = (db: Pick<Db, "get" | "all">, runId: string): CarriedAdoption | null => {
  const record = recordedBootstrapAdoption(db, runId);
  if (!record) return null;
  const unmoved = { adoption: record, through: [record.sessionId] };
  const pin = db.get<{
    owner_role_key: string | null; owner_session_id: string | null; owner_binding_generation: number | null; owner_session_incarnation: string | null;
  }>(`SELECT owner_role_key, owner_session_id, owner_binding_generation, owner_session_incarnation FROM runs WHERE run_id = ?`, [runId]);
  if (!pin || pin.owner_session_id === null) return unmoved;
  const carried = carriedByTakeovers(db, record, {
    runId,
    ownerRoleKey: pin.owner_role_key,
    ownerSessionId: pin.owner_session_id,
    ownerBindingGeneration: pin.owner_binding_generation,
    ownerSessionIncarnation: pin.owner_session_incarnation,
  });
  return carried.allowed ? carried.value : unmoved;
};

/**
 * Whether `run` is pinned to exactly the adopted binding, and that binding is still the role's ACTIVE
 * one at the adopted generation. The adopted binding is the one RUN_CREATED recorded or, once the
 * official takeovers moved the pin, the one they carried it to (`carriedByTakeovers`); `adoption` is
 * either. Synchronous and process-free, for the transactions and pre-write checkpoints that ask it
 * again after an await, and the one owner-pin judgement of an adopting run: dispatch, PLAN staging, the
 * Repo Factory runner and activation all ask this.
 */
export const adoptedOwnerPinHolds = (
  deps: { db: Pick<Db, "get" | "all">; bindings: Pick<BindingRegistry, "active"> },
  run: RunRow,
  adoption: CanonicalCtoBootstrapAdoption,
): Decision<RoleBinding> => {
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: adoption.projectId });
  const evidence = { runId: run.runId, projectId: adoption.projectId, sessionId: adoption.sessionId, bindingGeneration: adoption.bindingGeneration };
  const record = recordedBootstrapAdoption(deps.db, run.runId);
  const carried = record?.projectId === adoption.projectId ? carriedByTakeovers(deps.db, record, run) : null;
  const asked = (held: CanonicalCtoBootstrapAdoption) => held.sessionId === adoption.sessionId && held.bindingGeneration === adoption.bindingGeneration;
  // An allowed carry ends exactly on the run's pin, under this role.
  if (!carried?.allowed || !(asked(record!) || asked(carried.value.adoption))) {
    return refuse(ReasonCode.RUN_OWNER_NOT_PINNED, "ADOPTION_OWNER_NOT_PINNED", "the bootstrap run's owner is not pinned to its adopted canonical CTO", {
      ...evidence,
      ownerRoleKey: run.ownerRoleKey,
      ...(carried && !carried.allowed ? carried.evidence : {}),
    });
  }
  const active = deps.bindings.active(roleKey);
  if (!active || active.status !== "ACTIVE" || active.boundSessionId !== run.ownerSessionId ||
    active.boundSessionIncarnation !== run.ownerSessionIncarnation) {
    return refuse(ReasonCode.RUN_OWNER_REVOKED, "ADOPTION_OWNER_NOT_ACTIVE", "the adopted canonical CTO is no longer the run's ACTIVE owner", evidence);
  }
  if (active.bindingGeneration !== run.ownerBindingGeneration) {
    return refuse(ReasonCode.BINDING_GENERATION_STALE, "ADOPTION_OWNER_PIN_STALE", "the adopted canonical CTO's binding moved to another generation", {
      ...evidence,
      currentGeneration: active.bindingGeneration,
    });
  }
  return allow(ReasonCode.OK, active);
};

export interface CanonicalCtoBootstrapAdoptionDeps {
  db: Pick<Db, "get" | "all">;
  bindings: Pick<BindingRegistry, "active" | "activePrimaryCtos">;
  sessions: Pick<SessionRegistry, "get">;
  projects: Pick<ProjectRegistry, "get">;
  /** Tests replace the process reading; production reads the recorded (pid, start token). */
  liveness?: (session: SessionRecord) => SessionLiveness | "EPERM";
}

/**
 * The one validator every door of an adopting bootstrap asks (run creation, dispatch, the Repo Factory
 * runner before its first write, activation before its first mutation, and the CEO completion
 * transaction). The target is an exact, existing session at its current generation:
 *
 *   - its project is registered, not retired, not suspended;
 *   - the daemon's canonical session configuration (`canonical_session_entitlements`, which the
 *     daemon fills from its configured canonical sessions at startup) has an entry for that project;
 *   - the session is not another project's PRIMARY_CTO;
 *   - the project's ACTIVE PRIMARY_CTO binding is held by exactly that session, at exactly that
 *     generation, by an adopted canonical runtime (the canonical self-claim's own predicate) whose
 *     conversation is the entry's, admitted by an authenticated claim (CANONICAL_SELF_CLAIM_ADMITTED);
 *   - the session is READY, its recorded process is the one running, and its Buzz identity and room
 *     are the entry's;
 *   - for a recorded adoption, the entitlement is still the one the run was created on (its
 *     conversation's session UUID and its Buzz actor), and the session and generation are where the
 *     official takeovers of the run's owner pin carried the recorded ones (`recorded`, #1302);
 *   - while the project's pointer is NULL, no CONTRACT_CHANGE run of it (necessarily a first
 *     activation) is open: that run moves the same NULL pointer under its own grant, and whichever
 *     moved second would be stranded.
 *
 * Reads only. Every refusal names itself in `evidence.refusal`.
 */
export class CanonicalCtoBootstrapAdoptions {
  constructor(private readonly deps: CanonicalCtoBootstrapAdoptionDeps) {}

  /** `carriedBootstrapAdoption`: the run's recorded adoption, where the official takeovers carried it. */
  recorded(runId: string): RecordedBootstrapAdoption | null {
    return carriedBootstrapAdoption(this.deps.db, runId);
  }

  /** `carriedBootstrapAdoptionChain`: `recorded`, with the sessions its proven chain passed through. */
  recordedChain(runId: string): CarriedAdoption | null {
    return carriedBootstrapAdoptionChain(this.deps.db, runId);
  }

  /**
   * run_create's door: the request, validated in full, and what ACP records for it. Beyond `validate`,
   * the project still has no active manifest and no other bootstrap holds a reservation of it. The
   * record's entitlement fields are the ones this validation read from `canonical_session_entitlements`,
   * never the requester's.
   */
  admitAtCreation(adoption: CanonicalCtoBootstrapAdoption): Decision<RecordedBootstrapAdoption> {
    const evidence = { projectId: adoption.projectId, sessionId: adoption.sessionId, bindingGeneration: adoption.bindingGeneration };
    const project = this.deps.projects.get(adoption.projectId);
    if (project && project.activeManifestDigest !== null) {
      return refuse(ReasonCode.CONTRACT_CHANGE_REQUIRES_DEDICATED_RUN, "ADOPTION_PROJECT_HAS_MANIFEST",
        "the adopted CTO's project already has an active manifest; a bootstrap never moves it", evidence);
    }
    const reserved = this.deps.db.get<{ run_id: string }>(
      `SELECT run_id FROM bootstrap_applications WHERE project_id = ? AND phase <> 'RELEASED' AND retired_at IS NULL LIMIT 1`,
      [adoption.projectId],
    );
    if (reserved) {
      return refuse(ReasonCode.BOOTSTRAP_APPLICATION_RESERVED, "ADOPTION_PROJECT_RESERVED",
        "another bootstrap run holds the reservation for the adopted CTO's project", { ...evidence, heldBy: reserved.run_id });
    }
    // v57: once a transfer's claim revoked the project's entitlement row, v56's pointer guard can no longer
    // activate an adopting bootstrap's first manifest, so none is created.
    if (!this.deps.db.get(`SELECT 1 FROM canonical_session_entitlements WHERE project_id = ? AND revoked_at IS NULL`, [adoption.projectId])) {
      return refuse(ReasonCode.CONFLICT, "ADOPTION_ENTITLEMENT_TRANSFERRED",
        "the project's canonical entitlement was transferred; v56's pointer guard admits a first manifest only on the original one", evidence);
    }
    const validated = this.validate(adoption);
    if (!validated.allowed) return validated as Decision<RecordedBootstrapAdoption>;
    return allow(ReasonCode.OK, {
      projectId: adoption.projectId,
      sessionId: adoption.sessionId,
      bindingGeneration: adoption.bindingGeneration,
      entitlementSessionUuid: validated.value.entry.sessionUuid,
      buzzActorId: validated.value.entry.buzzActorId,
    });
  }

  validate(adoption: AskedAdoption, options: { liveness?: boolean } = {}): Decision<AdoptedCanonicalCto> {
    const { projectId, sessionId, bindingGeneration } = adoption;
    const evidence = { projectId, sessionId, bindingGeneration };
    const project = this.deps.projects.get(projectId);
    if (!project) return refuse(ReasonCode.NOT_FOUND, "ADOPTION_PROJECT_UNKNOWN", "the adopted CTO's project is not registered", evidence);
    if (project.retiredAt !== null) return refuse(ReasonCode.CONFLICT, "ADOPTION_PROJECT_RETIRED", "the adopted CTO's project is retired", evidence);
    if (project.suspended) return refuse(ReasonCode.CONFLICT, "ADOPTION_PROJECT_SUSPENDED", "the adopted CTO's project is suspended", evidence);

    const entry = new CanonicalSessionRegistry(this.deps.db as Db).effective().find((candidate) => candidate.projectId === projectId);
    if (!entry) {
      return refuse(ReasonCode.CONFLICT, "ADOPTION_NOT_CANONICAL", "the daemon's canonical session configuration has no entry for this project", evidence);
    }
    if (
      (adoption.entitlementSessionUuid !== undefined && adoption.entitlementSessionUuid !== entry.sessionUuid) ||
      (adoption.buzzActorId !== undefined && adoption.buzzActorId !== entry.buzzActorId)
    ) {
      return refuse(ReasonCode.CONFLICT, "ADOPTION_ENTITLEMENT_MOVED", "the project's canonical entitlement is not the one the run was created on", evidence);
    }
    // Only while the pointer is still NULL: once this adoption has moved it, no CONTRACT_CHANGE is a first activation.
    const firstActivation = project.activeManifestDigest !== null ? undefined : this.deps.db.get<{ run_id: string }>(
      `SELECT run_id FROM runs WHERE project_id = ? AND kind = ? AND pinned_manifest_digest IS NULL
          AND state NOT IN (${TERMINAL_RUN_STATES.map(() => "?").join(", ")}) LIMIT 1`,
      [projectId, RunKind.CONTRACT_CHANGE, ...TERMINAL_RUN_STATES],
    );
    if (firstActivation) {
      return refuse(ReasonCode.CONFLICT, "ADOPTION_FIRST_ACTIVATION_OPEN",
        "a first-activation CONTRACT_CHANGE run of the adopted CTO's project is open", { ...evidence, openRunId: firstActivation.run_id });
    }

    // Another project's CTO is refused by name before anything else about the binding is asked.
    const foreign = this.deps.bindings.activePrimaryCtos()
      .find((held) => (held.sessionId === sessionId || held.boundSessionId === sessionId) && held.projectId !== projectId);
    if (foreign) {
      return refuse(ReasonCode.CONFLICT, "ADOPTION_FOREIGN_PROJECT_CTO", "the named session is another project's PRIMARY_CTO", {
        ...evidence,
        holdsProjectId: foreign.projectId,
      });
    }

    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    const binding = this.deps.bindings.active(roleKey);
    if (!binding) return refuse(ReasonCode.RUN_OWNER_NOT_PINNED, "ADOPTION_BINDING_ABSENT", "the project has no ACTIVE PRIMARY_CTO binding to adopt", evidence);
    if (binding.sessionId !== sessionId || binding.boundSessionId !== sessionId) {
      return refuse(ReasonCode.RUN_OWNER_REVOKED, "ADOPTION_SESSION_MISMATCH", "the project's PRIMARY_CTO is held by another session", evidence);
    }
    if (binding.bindingGeneration !== bindingGeneration) {
      return refuse(ReasonCode.BINDING_GENERATION_STALE, "ADOPTION_GENERATION_STALE", "the PRIMARY_CTO binding is at another generation", {
        ...evidence,
        currentGeneration: binding.bindingGeneration,
      });
    }
    if (!isAdoptedCanonicalRuntime(this.deps.db, binding.sessionId, binding.assignmentId)) {
      return refuse(ReasonCode.CONFLICT, "ADOPTION_NOT_ADOPTED_RUNTIME", "the PRIMARY_CTO binding is not held by an adopted canonical runtime", evidence);
    }
    const target = this.deps.db.get<{ target_locator: string }>(
      `SELECT tb.target_locator FROM assignments a JOIN actor_target_bindings tb ON tb.target_actor_id = a.actor_id
        WHERE a.assignment_id = ? AND tb.executor_kind = ?`,
      [binding.assignmentId, SELF_CLAIM_EXECUTOR_KIND],
    );
    if (target?.target_locator !== entry.sessionUuid) {
      return refuse(ReasonCode.CONFLICT, "ADOPTION_CONVERSATION_NOT_ENTITLED", "the binding's conversation is not the canonical entry's", evidence);
    }
    if (!selfClaimAdmitted(this.deps.db, sessionId, roleKey, entry.sessionUuid, bindingGeneration)) {
      return refuse(ReasonCode.MCP_PEER_UNAUTHENTICATED, "ADOPTION_NOT_AUTHENTICATED", "no authenticated canonical claim admitted this binding", evidence);
    }
    const session = this.deps.sessions.get(sessionId);
    if (!session || session.lifecycle !== SessionLifecycle.READY || session.incarnation !== binding.sessionIncarnation) {
      return refuse(ReasonCode.SESSION_NOT_READY, "ADOPTION_SESSION_NOT_READY", "the adopted session is not READY on the bound incarnation", {
        ...evidence,
        lifecycle: session?.lifecycle ?? null,
      });
    }
    if (session.buzzActorId !== entry.buzzActorId || session.buzzAddress !== (entry.buzzAddress ?? null)) {
      return refuse(ReasonCode.CONFLICT, "ADOPTION_BUZZ_ROUTE_MISMATCH", "the adopted session's Buzz identity or room is not the canonical entry's", evidence);
    }
    if (options.liveness !== false) {
      const liveness = (this.deps.liveness ?? defaultLiveness)(session);
      if (liveness !== "ALIVE") {
        return refuse(liveness === "DEAD" ? ReasonCode.CANONICAL_CTO_AWAITING_RECLAIM : ReasonCode.PROBE_FAILED, "ADOPTION_SESSION_NOT_LIVE",
          "the adopted session's recorded process is not shown to be running", { ...evidence, liveness });
      }
    }
    return allow(ReasonCode.OK, {
      adoption,
      binding: { ...binding, sessionId: binding.boundSessionId, sessionIncarnation: binding.boundSessionIncarnation },
      entry,
      session,
    });
  }

  /** `validate` as the run engine's port asks it at dispatch: the binding the dispatch pins. */
  admit(adoption: RecordedBootstrapAdoption): Decision<RoleBinding> {
    const validated = this.validate(adoption);
    return validated.allowed ? allow(ReasonCode.OK, validated.value.binding) : (validated as Decision<RoleBinding>);
  }

  /**
   * Inside the dispatch transaction, after the awaits since `admit`: the binding admitted is still the
   * role's ACTIVE one, on the same assignment, session and generation. Process-free.
   */
  stillHeld(adoption: CanonicalCtoBootstrapAdoption, admitted: RoleBinding): Decision<RoleBinding> {
    const active = this.deps.bindings.active(roleKeyFor(Role.PRIMARY_CTO, { projectId: adoption.projectId }));
    if (
      !active ||
      active.assignmentId !== admitted.assignmentId ||
      active.bindingGeneration !== adoption.bindingGeneration ||
      active.boundSessionId !== adoption.sessionId ||
      active.sessionId !== adoption.sessionId
    ) {
      return refuse(ReasonCode.BINDING_GENERATION_STALE, "ADOPTION_BINDING_MOVED", "the adopted PRIMARY_CTO binding moved while dispatch admitted it", {
        projectId: adoption.projectId,
        sessionId: adoption.sessionId,
        bindingGeneration: adoption.bindingGeneration,
        currentGeneration: active?.bindingGeneration ?? null,
      });
    }
    return allow(ReasonCode.OK, { ...active, sessionId: active.boundSessionId, sessionIncarnation: active.boundSessionIncarnation });
  }

  /** `adoptedOwnerPinHolds`, on this validator's database and bindings. */
  pinHolds(run: RunRow, adoption: CanonicalCtoBootstrapAdoption): Decision<RoleBinding> {
    return adoptedOwnerPinHolds(this.deps, run, adoption);
  }

  /**
   * The project the bootstrap connects to: the adopted CTO's own, already registered and manifest-less
   * (a resumed activation of this run finds it on exactly the manifest this run activated), with no
   * repository bound except the one this run's PLAN creates. `manifestProjectId` is the PLAN manifest's.
   */
  targetHolds(
    adoption: CanonicalCtoBootstrapAdoption,
    target: { manifestProjectId: string; approvedManifestDigest: string; repositoryIdentity: string },
  ): Decision<void> {
    const evidence = { projectId: adoption.projectId, manifestProjectId: target.manifestProjectId };
    if (target.manifestProjectId !== adoption.projectId) {
      return refuse(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "ADOPTION_PROJECT_NOT_TARGET",
        "the bootstrap's manifest names another project than the adopted CTO's", evidence);
    }
    const project = this.deps.projects.get(adoption.projectId);
    if (!project) return refuse(ReasonCode.NOT_FOUND, "ADOPTION_PROJECT_UNKNOWN", "the adopted CTO's project is not registered", evidence);
    if (project.activeManifestDigest !== null && project.activeManifestDigest !== target.approvedManifestDigest) {
      return refuse(ReasonCode.CONTRACT_CHANGE_REQUIRES_DEDICATED_RUN, "ADOPTION_PROJECT_HAS_MANIFEST",
        "the adopted project already has another active manifest; a bootstrap never moves it", {
          ...evidence,
          activeManifestDigest: project.activeManifestDigest,
        });
    }
    // v57: the v56 manifest-pointer guard moves a NULL pointer for an adopted bootstrap only on the project's
    // unrevoked entitlement row. After a CEO entitlement transfer's claim revoked it, the bootstrap would write to
    // GitHub and then be refused the pointer, so it is refused here, before the first write.
    if (project.activeManifestDigest === null &&
      !this.deps.db.get(`SELECT 1 FROM canonical_session_entitlements WHERE project_id = ? AND revoked_at IS NULL`, [adoption.projectId])) {
      return refuse(ReasonCode.CONFLICT, "ADOPTION_TRANSFERRED_BEFORE_ACTIVATION",
        "the adopted project's entitlement was transferred before its first manifest, which v56's pointer guard then refuses", evidence);
    }
    const bound = this.deps.db.all<{ identity: string; active_manifest_digest: string | null }>(
      `SELECT identity, active_manifest_digest FROM repositories WHERE project_id = ? AND retired_at IS NULL ORDER BY repository_id`,
      [adoption.projectId],
    );
    const foreign = bound.filter((row) => row.identity !== target.repositoryIdentity || row.active_manifest_digest !== target.approvedManifestDigest);
    if (foreign.length > 0) {
      return refuse(ReasonCode.CONFLICT, "ADOPTION_PROJECT_HAS_REPOSITORY",
        "the adopted project already has a repository bound; the bootstrap connects only the repository it creates", {
          ...evidence,
          bound: foreign.map((row) => row.identity),
        });
    }
    return allow(ReasonCode.OK, undefined);
  }
}
