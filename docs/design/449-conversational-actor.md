# v18 — `conversational_actor` as a first-class entity (#449)

Executable plan. Written so the migration can be built without re-deriving the survey.

## Why this blocks other work

The CEO's L5 reports `BLOCKED_PRODUCT_PREREQUISITE__A2_449_REQUIRED`. Until a binding names the
transcript owner rather than the runtime, ACP's failover rotates the CTO the owner is mid-
conversation with, silently. That is the defect; the column rename is only its surface.

## Measured starting state

- `SCHEMA_VERSION = 17` (`src/db/migrations.ts:11`), so this is **v18** on a settled chain — all
  six lanes have merged and the v15–v17 contention that deferred this is gone.
- `assignments` (`schema.sql:173`) carries `session_id NOT NULL REFERENCES sessions(session_id)`
  and `session_incarnation NOT NULL`.
- **Five** triggers on `assignments`, not six as the issue estimates — worth confirming before
  quoting that number again:

  | trigger | line | what it enforces |
  |---|---:|---|
  | `assignments_generation_monotonic` | 203 | new generation exceeds the max for that role_key |
  | `assignments_generation_immutable` | 214 | generation and identity columns never change |
  | `assignments_revocation_terminal` | 232 | REVOKED is terminal |
  | `assignments_active_generation_current` | 242 | an ACTIVE row holds the current generation |
  | `assignments_active_generation_insert_guard` | 256 | no second ACTIVE row for a role_key |

- Two partial unique indexes (`assignments_active_role_key`, `assignments_active_primary_cto`)
  plus `assignments_owner_tuple` at line 270.
- `runs` holds the composite owner reference (`schema.sql:298`):
  `owner_session_id`, `owner_binding_generation`, `owner_session_incarnation`.

## The semantic change, which is the actual work

`binding_generation` currently rotates when the **runtime** is replaced. After v18 it must rotate
only when the **actor** is replaced. Failover swaps the session inside a living actor and the
generation holds; losing the actor is what creates a new generation.

Every one of the five triggers above encodes the current rule. Rebuilding the table without
rewriting them produces a schema that passes its own tests and enforces the old meaning — the
failure mode this repository has hit repeatedly (26 tests once passed without their enforcement).

**Each trigger therefore needs a mutation test**: delete the enforcement, confirm a named test
fails, restore. That is not optional here.

## Shape

```sql
CREATE TABLE conversational_actors (
  actor_id     TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('CEO','CTO','WORKER','REVIEWER')),
  created_at   TEXT NOT NULL,
  retired_at   TEXT,
  retired_reason TEXT
);
```

`assignments` gains `actor_id TEXT NOT NULL REFERENCES conversational_actors(actor_id)`.

`session_id` / `session_incarnation` are **kept**, not dropped. They stop being identity and
become runtime observability: which model runtime is currently serving the actor. This is what
makes the ~200 call sites tractable — a read of `session_id` still compiles and still means
something true; only the *binding* semantics move. Renaming identity and deleting the old columns
in one migration is what turns a 1-migration change into a 200-site rewrite.

`runs.owner_session_id` gains a parallel `owner_actor_id`, and `assignments_owner_tuple` becomes
`(role_key, binding_generation, actor_id)`.

## Migration mechanics

v13 (`migrations.ts:100`) is the precedent: `foreignKeysOffDuringApply: true`, explicit parent-
table rebuild, triggers dropped and recreated. SQLite cannot alter an identity column under
triggers and indexes, so `assignments` and `runs` both rebuild. One migration covers both plus
the new table.

## Backfill

Existing rows have no actor. One actor per distinct `(role_key)` with a live ACTIVE binding,
`kind` derived from `role`, `created_at` from the binding's `created_at`. This is the honest
reading: before v18 the system could not distinguish actor from runtime, so every historical
binding is treated as its own actor. No fabricated continuity.

## Out of scope, per the issue

Equivalence *proving* — transcript observation, origin-row adjudication — stays outside ACP as an
adapter contract verified by E2E. Read wide, this becomes chat routing inside the control plane.
ACP is not a conversation router.

## Order of work

1. v18 migration + `conversational_actors` + backfill
2. rewrite the five triggers to the actor rule, each with its mutation test
3. `assignments_owner_tuple` and the `runs` composite
4. call-site migration for the binding path only, leaving runtime reads alone
