import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny, fail } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { Db } from "../db/database.ts";
import type { Role } from "../domain/types.ts";

export type ActorRegistrationState = "REGISTERED" | "RETIRED";
export type ActorAttachmentState = "ATTACHED" | "DETACHED";

export interface RegisterConversationalActorInput {
  actorId: string;
  actorGeneration: number;
  expectedRegistrySetGeneration: number;
}

export interface UnregisterConversationalActorInput extends RegisterConversationalActorInput {
  reason: string;
}

export interface ActorRegistrationReceipt {
  actorId: string;
  actorGeneration: number;
  registrationState: ActorRegistrationState;
  registrySetGeneration: number;
}

export interface RegisteredConversationalActor {
  actorId: string;
  actorGeneration: number;
  kind: Role;
  registrationState: "REGISTERED";
  attachmentState: ActorAttachmentState;
  currentSessionId: string | null;
  currentSessionIncarnation: string | null;
}

export interface ActiveActorSet {
  registrySetGeneration: number;
  actors: RegisteredConversationalActor[];
}

interface ActorRow {
  actor_id: string;
  kind: Role;
  current_session_id: string | null;
  current_session_incarnation: string | null;
  retired_at: string | null;
}

interface RegisteredActorRow extends ActorRow {
  actor_generation: number;
}

/**
 * Atomic registration authority for already-existing first-class conversational actors.
 * It never creates an actor, assignment, runtime, route, or audit event.
 */
export class ConversationalActorRegistry {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  register(input: RegisterConversationalActorInput): Decision<ActorRegistrationReceipt> {
    const invalid = validateGenerationInput(input);
    if (invalid) return invalid;

    return this.db.tx(() => {
      const observed = this.registrySetGeneration();
      if (input.expectedRegistrySetGeneration !== observed) {
        return deny(ReasonCode.REGISTERED_SET_GENERATION_MISMATCH, "the registered actor set changed before registration", {
          expectedRegistrySetGeneration: input.expectedRegistrySetGeneration,
          observedRegistrySetGeneration: observed,
        });
      }

      const actor = this.db.get<ActorRow>(
        `SELECT actor_id, kind, current_session_id, current_session_incarnation, retired_at
           FROM conversational_actors WHERE actor_id = ?`,
        [input.actorId],
      );
      if (!actor) {
        return deny(ReasonCode.NOT_FOUND, "registration target is not a first-class conversational actor", {
          actorId: input.actorId,
        });
      }
      if (actor.retired_at !== null) {
        return deny(ReasonCode.CONFLICT, "a retired conversational actor cannot be registered", {
          actorId: input.actorId,
        });
      }

      const active = this.db.get<{ actor_generation: number }>(
        `SELECT actor_generation FROM conversational_actor_registrations
          WHERE actor_id = ? AND registration_state = 'REGISTERED'`,
        [input.actorId],
      );
      if (active) {
        return deny(ReasonCode.CONFLICT, "conversational actor is already registered", {
          actorId: input.actorId,
          actorGeneration: input.actorGeneration,
          observedActorGeneration: active.actor_generation,
        });
      }

      const prior = this.db.get<{ actor_generation: number }>(
        `SELECT MAX(actor_generation) AS actor_generation
           FROM conversational_actor_registrations WHERE actor_id = ?`,
        [input.actorId],
      );
      if (prior?.actor_generation !== null && prior?.actor_generation !== undefined &&
          input.actorGeneration <= prior.actor_generation) {
        return deny(ReasonCode.CONFLICT, "actor generation must advance for rotation", {
          actorId: input.actorId,
          actorGeneration: input.actorGeneration,
          observedActorGeneration: prior.actor_generation,
        });
      }

      this.db.run(
        `INSERT INTO conversational_actor_registrations
           (actor_id, actor_generation, registration_state, registered_at)
         VALUES (?, ?, 'REGISTERED', ?)`,
        [input.actorId, input.actorGeneration, this.clock.nowIso()],
      );
      const advanced = this.db.run(
        `UPDATE conversational_actor_registry_state
            SET registry_set_generation = registry_set_generation + 1
          WHERE registry_id = 1 AND registry_set_generation = ?`,
        [observed],
      );
      if (advanced.changes !== 1) {
        fail(ReasonCode.INTERNAL_ERROR, "registered actor set generation did not advance", {
          expectedRegistrySetGeneration: observed,
        });
      }

      return allow(ReasonCode.OK, {
        actorId: input.actorId,
        actorGeneration: input.actorGeneration,
        registrationState: "REGISTERED",
        registrySetGeneration: observed + 1,
      });
    });
  }

  unregister(input: UnregisterConversationalActorInput): Decision<ActorRegistrationReceipt> {
    const invalid = validateGenerationInput(input);
    if (invalid) return invalid;
    if (input.reason.trim().length === 0) {
      return deny(ReasonCode.INVALID_ARGUMENT, "unregistration reason must not be empty", {});
    }

    return this.db.tx(() => {
      const observed = this.registrySetGeneration();
      if (input.expectedRegistrySetGeneration !== observed) {
        return deny(
          ReasonCode.REGISTERED_SET_GENERATION_MISMATCH,
          "the registered actor set changed before unregistration",
          {
            expectedRegistrySetGeneration: input.expectedRegistrySetGeneration,
            observedRegistrySetGeneration: observed,
          },
        );
      }

      const active = this.db.get<{ actor_generation: number }>(
        `SELECT actor_generation FROM conversational_actor_registrations
          WHERE actor_id = ? AND registration_state = 'REGISTERED'`,
        [input.actorId],
      );
      if (!active) {
        return deny(ReasonCode.NOT_FOUND, "conversational actor is not registered", {
          actorId: input.actorId,
          actorGeneration: input.actorGeneration,
        });
      }
      if (active.actor_generation !== input.actorGeneration) {
        return deny(ReasonCode.CONFLICT, "unregistration target is not the active actor generation", {
          actorId: input.actorId,
          actorGeneration: input.actorGeneration,
          observedActorGeneration: active.actor_generation,
        });
      }

      const retired = this.db.run(
        `UPDATE conversational_actor_registrations
            SET registration_state = 'RETIRED', retired_at = ?, retired_reason = ?
          WHERE actor_id = ? AND actor_generation = ? AND registration_state = 'REGISTERED'`,
        [this.clock.nowIso(), input.reason, input.actorId, input.actorGeneration],
      );
      if (retired.changes !== 1) {
        fail(ReasonCode.INTERNAL_ERROR, "active actor registration did not retire", {
          actorId: input.actorId,
          actorGeneration: input.actorGeneration,
        });
      }
      const advanced = this.db.run(
        `UPDATE conversational_actor_registry_state
            SET registry_set_generation = registry_set_generation + 1
          WHERE registry_id = 1 AND registry_set_generation = ?`,
        [observed],
      );
      if (advanced.changes !== 1) {
        fail(ReasonCode.INTERNAL_ERROR, "registered actor set generation did not advance", {
          expectedRegistrySetGeneration: observed,
        });
      }

      return allow(ReasonCode.OK, {
        actorId: input.actorId,
        actorGeneration: input.actorGeneration,
        registrationState: "RETIRED",
        registrySetGeneration: observed + 1,
      });
    });
  }

  activeSet(): ActiveActorSet {
    const registrySetGeneration = this.registrySetGeneration();
    const actors = this.db.all<RegisteredActorRow>(
      `SELECT r.actor_id, r.actor_generation, a.kind,
              a.current_session_id, a.current_session_incarnation, a.retired_at
         FROM conversational_actor_registrations r
         JOIN conversational_actors a ON a.actor_id = r.actor_id
        WHERE r.registration_state = 'REGISTERED'
        ORDER BY r.actor_id, r.actor_generation`,
    ).map((row): RegisteredConversationalActor => ({
      actorId: row.actor_id,
      actorGeneration: row.actor_generation,
      kind: row.kind,
      registrationState: "REGISTERED",
      attachmentState: row.current_session_id === null ? "DETACHED" : "ATTACHED",
      currentSessionId: row.current_session_id,
      currentSessionIncarnation: row.current_session_incarnation,
    }));
    return { registrySetGeneration, actors };
  }

  private registrySetGeneration(): number {
    const state = this.db.get<{ registry_set_generation: number }>(
      `SELECT registry_set_generation
         FROM conversational_actor_registry_state WHERE registry_id = 1`,
    );
    return state?.registry_set_generation ??
      fail(ReasonCode.INTERNAL_ERROR, "registered actor set generation is missing", {});
  }
}

const validateGenerationInput = (
  input: RegisterConversationalActorInput,
): Decision<ActorRegistrationReceipt> | null => {
  if (input.actorId.trim().length === 0) {
    return deny(ReasonCode.INVALID_ARGUMENT, "actorId must not be empty", {});
  }
  if (!Number.isSafeInteger(input.actorGeneration) || input.actorGeneration <= 0) {
    return deny(ReasonCode.INVALID_ARGUMENT, "actorGeneration must be a positive safe integer", {
      actorGeneration: input.actorGeneration,
    });
  }
  if (!Number.isSafeInteger(input.expectedRegistrySetGeneration) || input.expectedRegistrySetGeneration < 0) {
    return deny(ReasonCode.INVALID_ARGUMENT, "expectedRegistrySetGeneration must be a non-negative safe integer", {
      expectedRegistrySetGeneration: input.expectedRegistrySetGeneration,
    });
  }
  return null;
};
