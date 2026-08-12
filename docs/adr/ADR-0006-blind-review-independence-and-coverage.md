# ADR-0006 — Blind review independence and coverage are proven mechanically

- **Status:** Accepted
- **Date:** 2026-08-12
- **Drivers:** PRD §18, CP-HI-04, CP-S30–CP-S34

## Context

Mandatory blind review is the last semantic gate before a candidate reaches the CEO. Its
value collapses if the reviewer saw the producer's reasoning, if it is the producer, or
if it silently skipped part of the diff.

## Decision

**Automatic invocation.** The control plane calls the reviewer after deterministic
verification passes. There is no CTO- or Hermes-facing operation to request or skip it;
a manual attempt is denied with `REVIEW_MANUAL_INVOCATION_DENIED`.

**Independence by session set.** The producer set for a run is computed from the
bindings actually recorded for that run (primary/bootstrap CTO, workers, integrator,
repairer, non-blind reviewer). Binding a reviewer whose session is in that set fails.
The check runs twice — once when binding, once when accepting the packet — because a
session can join the producer set after the reviewer starts.

**Coverage by manifest.** The expected coverage set is derived from the candidate
snapshot's `touchedPaths` across every repository. The review packet declares
`coveredRepositories`, `coveredFiles` and `omittedItems`. A `PASS` with a non-empty
omission set, or with a covered set that does not contain every touched file, is
downgraded to `COVERAGE_INCOMPLETE` and cannot pass the gate.

**Large changes** are split into chunk reviewers, reduced by a coverage reducer that
verifies every file was seen at least once, deduplicated, and finished by a final fresh
reviewer. The reducer's input is the same mechanical coverage set.

**Degraded assurance** may reuse a provider family but never a session or context. If no
valid isolated reviewer can be constituted, the run waits or enters SURVIVAL — the gate
is never lowered (§18.7).

## Alternatives rejected

- **Trusting the reviewer's self-reported coverage** — that is the claim under test.
- **Sampling large diffs** — §18.5 forbids silently allowing file or repository omission.

## Consequences

The review packet is a verifiable artifact: given the snapshot and the packet, coverage
completeness and session independence are both recomputable after the fact.
