# ADR-0002 — Hard invariants live in typed code and DB constraints, never in a policy engine

- **Status:** Accepted
- **Date:** 2026-08-12
- **Drivers:** PRD §35.1, §35.3, §30.2, §13.3, §40 Maintainability

## Context

Eight hard invariants (CP-HI-01..08) must hold under crash, concurrency, agent error and
prompt injection. The tempting generalisation is a rule engine that expresses them
declaratively; the PRD forbids exactly that until real policy complexity is demonstrated.

## Decision

Each hard invariant is enforced at the lowest layer that can actually see the violation:

| Invariant | Enforcement point |
|---|---|
| CP-HI-01 managed write | `ManagedWriteGuard` inspects each ACP-owned operation plus its resolved path or project identity; runtime adapters/sandbox and claims bind agent source-file writes to the assigned worktree rather than routing every syscall through the Guard |
| CP-HI-02 single authority | only `agentcpd` code paths can transition a run to COMPLETED |
| CP-HI-03 contract pinning | `runs.pinned_manifest_digest` + digest comparison before verification |
| CP-HI-04 reviewer independence | producer-session query at binding time, checked again at packet time |
| CP-HI-05 trusted credential | credential is read from a store only the daemon process opens |
| CP-HI-06 exact evidence | `candidateSnapshotDigest` recorded on every verification/review row, `CHECK` enforced |
| CP-HI-07 owner authority | human-gate artifacts require an owner decision record |
| CP-HI-08 no silent degradation | every gate returns a reason code; absence of evidence is a distinct, non-passing status |

Uniqueness and monotonicity that a race could otherwise defeat are pushed into SQLite
partial indexes and triggers (§30.2), so two concurrent code paths cannot both win.

## Alternatives rejected

- **A policy DSL / rule engine** — §35.3 forbids it before the complexity is proven, and
  a DSL would move the invariants out of the type system into runtime strings.
- **Application-level uniqueness only** — a check-then-insert cannot prevent a second
  active primary CTO under concurrent dispatch; the partial unique index can.
- **Triggers for everything** — trigger-only enforcement produces opaque failures. The
  DB layer translates each constraint violation back into the same stable reason code
  the service layer would have returned.

## Consequences

Project-to-project variation is expressed as small typed config (the project manifest),
not as rules. Adding an invariant means adding a constraint and a typed check, and the
scenario suite gains a negative test for it.
