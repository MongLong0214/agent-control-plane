# ADR-0007 — Capacity is event-driven and three-signalled; there is no UNKNOWN route

- **Status:** Accepted
- **Date:** 2026-08-12
- **Drivers:** PRD §14, §15, CP-S16–CP-S24

## Context

Role continuity depends on knowing what capacity actually exists. A single "is the
provider up?" boolean conflates three independent failures: the sensor is broken, the
runtime is degraded, and allocation is being deliberately throttled.

## Decision

**Three orthogonal signals per provider**, never collapsed:
`sensorHealth` (HEALTHY|STALE|ERROR), `runtimeHealth` (HEALTHY|DEGRADED|UNAVAILABLE),
`allocationAdmission` (OPEN|CONSERVE|SUSPENDED). Quota lives in named buckets carrying
`remainingPercent`, `resetAt` and the capabilities that bucket can serve.

**Event-driven refresh with a short freshness window**, not polling. Refresh is
mandatory before: run dispatch admission, large worker fan-out, mandatory blind review,
continuity evaluation, doctor capacity report, and any provider switch or allocation
failure (§14.2). A dashboard is not a refresh trigger.

**No UNKNOWN in routing.** A stale reading is usable only inside its freshness window.
Past that, or on probe failure, new allocation is suspended
(`CAPACITY_UNKNOWN_NOT_ROUTABLE`) while existing critical sessions get a separate runtime
health probe. Guessing is what produces a false completion later.

**Dynamic reserve.** Role priority order is fixed (§14.5); the reserve fraction is
computed from buckets, reset times, burn rate, in-flight runs and expected mandatory
reviews. No hard-coded 30%.

**Failover is plan-first.** `RoleCoveragePlan` is computed before any rewiring and
yields FULL / PARTIAL / NO_VALID_COVERAGE plus an action
(WAIT_FOR_RESET, FALLBACK_ROLE, PAUSE_NEW_WORK, OWNER_APPROVED_PROJECT_SUSPEND,
SURVIVAL). Grok's absence alone never degrades the mode — it is optional by contract.

**Restoration never preempts.** A recovered preferred provider takes new work only; the
in-flight reviewer finishes, the acting CTO drains to zero runs first
(`RESTORE_WOULD_PREEMPT_INFLIGHT_OWNER`).

## Alternatives rejected

- **Per-minute polling of every provider** — §14.2 rules it out, and it burns the very
  capacity it measures.
- **One health enum** — cannot express "sensor broken but runtime fine", which is the
  case that decides whether to suspend allocation or keep going.

## Consequences

Probe parsers are per-provider adapters with fixture tests, so a changed CLI output
format surfaces as a parser failure (→ suspend) rather than as a confident wrong number.
