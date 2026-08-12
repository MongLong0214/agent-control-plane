# ADR-0003 — Role binding generation is the fencing token for all authority

- **Status:** Accepted
- **Date:** 2026-08-12
- **Drivers:** PRD §9.4, §11.1, §15.7, §29.4, §34.4

## Context

Logical roles are stable; the runtime sessions behind them are disposable and can be
replaced mid-flight by continuity failover, replacement or emergency takeover. A
replaced session may still be alive and may still emit results. Those late results must
never mutate authoritative state.

## Decision

Every logical role is addressed by a `roleKey` (`PRIMARY_CTO:<projectId>`,
`BLIND_REVIEWER:<runId>`, `WORKER:<taskId>`, …). A binding attaches a session to a
roleKey with a strictly monotonic `bindingGeneration`, enforced by a DB trigger.

The generation is the fencing token, carried on:

- every outbox envelope (§15.7),
- the run owner pin (`owner_session_id` + `owner_binding_generation`, §11.1),
- every task execution receipt,
- every managed write guard request.

A failover is one transaction: activate the new generation, switch the logical route,
revoke the old binding, retarget-or-reject pending outbox messages. Anything arriving
afterwards under the old generation is written to the audit log and dropped.

Retargeting is by message kind rather than case-by-case judgement: role-level intent
(dispatch, task assignment, cancel, CEO notification) moves to the new incarnation;
anything addressed to a specific incarnation (handoff package, recovery package, reply to
that session's question) is rejected as stale.

## Alternatives rejected

- **Session id as the fence** — a session can be restarted with the same logical role;
  incarnation alone does not order two bindings, and comparison would be equality rather
  than "is this the current one".
- **Timestamps** — clock-based ordering fails exactly in the crash/restart window the
  fence exists to cover.
- **Retarget everything** — redelivering an in-flight handoff to a different session
  produces two CTOs believing they own the same transfer.

## Consequences

`bindingGeneration` appears in most signatures. That verbosity is deliberate: a call
site that cannot supply a generation is a call site that has no authority.
