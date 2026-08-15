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

**Correction to the paragraph above.** I wrote that all five triggers encode the runtime rule.
They do not, and I should have read them before saying so. Four enforce monotonicity and
terminality of `binding_generation` per `role_key` — orthogonal to what a generation *means*, and
true unchanged after v18. Exactly one encodes the runtime binding:
`assignments_generation_immutable` (line 214), which lists `session_id` and `session_incarnation`
in its immutable set. That is the trigger this issue is about. The work is smaller than I
estimated, and the estimate was wrong in the direction that would have made me rebuild things
that did not need rebuilding.

A mutation test per trigger still applies to the ones v18 touches.

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

**`runs` is not rebuilt, and the composite FK does not move.** The first draft of this plan had
v18 rebuilding `runs` to pin `owner_actor_id`. Working through it showed that is unnecessary and
the reason is worth stating, because it is the difference between a 2-table migration and a
1-table one.

`runs` pins `(owner_role_key, owner_binding_generation, owner_session_id,
owner_session_incarnation)` against `assignments_owner_tuple`. That tuple is an **identifier for a
binding row**, not a live pointer at a runtime. Its components stay immutable under v18, so the FK
keeps resolving and the ownership claim — "this run belongs to generation N of role_key R" —
stays exactly as true as before.

What moves instead is where the *live* runtime pointer lives:

```sql
CREATE TABLE conversational_actors (
  actor_id                   TEXT PRIMARY KEY,
  kind                       TEXT NOT NULL CHECK (kind IN (...)),
  current_session_id         TEXT REFERENCES sessions(session_id),
  current_session_incarnation TEXT,
  created_at                 TEXT NOT NULL,
  retired_at                 TEXT,
  retired_reason             TEXT
);
```

Failover updates `conversational_actors.current_session_id`. `assignments.session_id` stays, and
stays immutable, demoted to *the runtime at binding time* — a historical fact, which is what it
always actually recorded. The binding generation is untouched by failover, which is the whole
point of #449.

## Migration mechanics

v13 (`migrations.ts:100`) is the precedent: `foreignKeysOffDuringApply: true`, explicit parent-
table rebuild, triggers dropped and recreated. SQLite cannot alter an identity column under
triggers and indexes, so `assignments` and `runs` both rebuild. One migration covers both plus
the new table.

## Backfill

Existing rows have no actor. **One actor per binding row**, `actor_id = 'actor:' || assignment_id`, `kind` from `role`,
`created_at` and the current-session columns from that binding.

An earlier draft of this section said "one actor per distinct role_key" in one sentence and "every
historical binding is its own actor" in the next. Those contradict, and the second is right.
Before v18 a new generation was created precisely *because* the runtime was replaced, and nothing
recorded whether the conversation survived that replacement. Collapsing a role_key's history into
one actor would assert a continuity the database never observed. One actor per row asserts
nothing.

## Out of scope, per the issue

Equivalence *proving* — transcript observation, origin-row adjudication — stays outside ACP as an
adapter contract verified by E2E. Read wide, this becomes chat routing inside the control plane.
ACP is not a conversation router.

## Order of work

1. v18 migration: `conversational_actors`, `assignments.actor_id`, backfill — `assignments`
   rebuilt, `runs` untouched
2. `assignments_generation_immutable` gains `actor_id`; the other four triggers are recreated
   byte-identical, and the rebuild must prove all five still exist
3. failover writes `conversational_actors.current_session_id` and leaves `binding_generation` alone
   — the behaviour change #449 exists for, and the one that needs a test asserting the generation
   does *not* move
4. call-site migration for the binding path only, leaving runtime reads alone
