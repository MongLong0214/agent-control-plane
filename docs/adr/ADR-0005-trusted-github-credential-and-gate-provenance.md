# ADR-0005 — One credential holder, and gates are trusted by provenance not by name

- **Status:** Accepted
- **Date:** 2026-08-12
- **Drivers:** PRD §24, CP-HI-05, CP-S35, Integration §14.2–14.4

## Context

Removing the repo-local merge broker concentrates merge authority in the control plane.
A candidate repository can create a check run called `acp-production-gate` through its
own CI. If the merge predicate matched on check *name*, a candidate could mint its own
approval.

## Decision

1. The GitHub authority credential lives in a local secret store outside every project
   repo, read only by the daemon process. It is never placed in the environment of a
   CTO, worker, reviewer, verification subprocess, Repo Factory, Buzz or Telegram
   adapter. The sandbox's forbidden-env list contains the same patterns as a second
   assertion.
2. `gate_publish` writes a payload binding runId, candidateSnapshotDigest,
   contractDigest, verificationDigest, blindReviewDigest, humanGateDigest,
   bindingGeneration, exact head and timestamp, and records the same payload locally.
3. `merge_evaluate` accepts a gate only when **all** of: the check was created by the
   trusted app/account identity, the payload digest matches the locally recorded
   publication, and the payload's head equals the exact head being merged. A check with
   the right name and the wrong creator or payload is rejected with
   `GATE_CREATOR_UNTRUSTED` / `GATE_PAYLOAD_PROVENANCE_INVALID`.
4. Branch protection and rulesets are defence in depth. The final authority is the
   kernel, because some repository profiles cannot physically enforce every pattern
   (Integration §9.4).

## Alternatives rejected

- **Trusting the check name plus a required-status-check ruleset** — CP-S35 is precisely
  the attack this loses to.
- **Signing the gate payload with a key the CI can hold** — any key a candidate workflow
  can reach is a key a candidate can forge with.

## Consequences

Every programmatic merge is a local decision backed by locally held evidence; GitHub is
the execution surface, not the source of truth.
