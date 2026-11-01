import { readProcessStartToken } from "../core/process-argv.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { Db } from "../db/database.ts";
import { probeSessionLiveness, type SessionLiveness } from "../daemon/dead-binding-recovery.ts";
import { TERMINAL_RUN_STATES } from "../domain/run-state.ts";
import { Role, RunKind, type RoleBinding, type RunRow, SessionLifecycle, roleKeyFor } from "../domain/types.ts";
import { CanonicalSessionRegistry } from "../registry/canonical-session-registry.ts";
import { type CanonicalAdoptableSession, isAdoptedCanonicalRuntime, SELF_CLAIM_EXECUTOR_KIND } from "../registry/canonical-self-claim.ts";
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
 *     conversation's session UUID and its Buzz actor);
 *   - while the project's pointer is NULL, no CONTRACT_CHANGE run of it (necessarily a first
 *     activation) is open: that run moves the same NULL pointer under its own grant, and whichever
 *     moved second would be stranded.
 *
 * Reads only. Every refusal names itself in `evidence.refusal`.
 */
export class CanonicalCtoBootstrapAdoptions {
  constructor(private readonly deps: CanonicalCtoBootstrapAdoptionDeps) {}

  recorded(runId: string): RecordedBootstrapAdoption | null {
    return recordedBootstrapAdoption(this.deps.db, runId);
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
    const admitted = this.deps.db.get(
      `SELECT 1 FROM audit_events WHERE kind = 'CANONICAL_SELF_CLAIM_ADMITTED' AND session_id = ? AND role_key = ?
          AND json_extract(evidence_json, '$.identity') = ? AND json_extract(evidence_json, '$.generation') = ? LIMIT 1`,
      [sessionId, roleKey, entry.sessionUuid, bindingGeneration],
    );
    if (!admitted) {
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

  /**
   * Whether `run` is pinned to exactly the adopted binding, and that binding is still the role's ACTIVE
   * one at the adopted generation. Synchronous and process-free, for the transactions and pre-write
   * checkpoints that ask it again after an await.
   */
  pinHolds(run: RunRow, adoption: CanonicalCtoBootstrapAdoption): Decision<RoleBinding> {
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: adoption.projectId });
    const evidence = { runId: run.runId, projectId: adoption.projectId, sessionId: adoption.sessionId, bindingGeneration: adoption.bindingGeneration };
    if (run.ownerRoleKey !== roleKey || run.ownerSessionId !== adoption.sessionId || run.ownerBindingGeneration !== adoption.bindingGeneration) {
      return refuse(ReasonCode.RUN_OWNER_NOT_PINNED, "ADOPTION_OWNER_NOT_PINNED", "the bootstrap run's owner is not pinned to its adopted canonical CTO", {
        ...evidence,
        ownerRoleKey: run.ownerRoleKey,
      });
    }
    const active = this.deps.bindings.active(roleKey);
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
