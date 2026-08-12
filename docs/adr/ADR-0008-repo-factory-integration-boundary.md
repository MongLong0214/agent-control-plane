# ADR-0008 — The control plane implements only its side of the bootstrap contract

- **Status:** Accepted
- **Date:** 2026-08-12
- **Drivers:** PRD §26, CP-019, Integration §7 Phase J, §13.4–13.6

## Context

Repo Factory is a separate deliverable with its own SSOT. The control plane must be able
to activate a bootstrap result the moment Repo Factory produces one, without either
system growing a second copy of the other's runtime.

## Decision

The control plane implements, in full:

- `RepoFactoryResult` (`repo-factory.result.v2`) as an **input contract** — parsed,
  validated, and rejected if it overclaims. A result that asserts primary CTO
  assignment, Buzz connection, doctor pass, blind review pass, CEO confirm or project
  ACTIVE is rejected with `BOOTSTRAP_RESULT_OVERCLAIMS_ACTIVATION`, because those are
  activation facts and only the control plane may state them.
- `ACPBootstrapActivationResult` as an **output contract** — project registration, local
  binding, blind review, CEO confirm, primary CTO binding, Buzz, handoff ACK, doctor,
  activity/availability. Only this result completes a `PROJECT_BOOTSTRAP` run.
- `BOOTSTRAP_CTO(run)` binding, and its promotion rule: promotable only if the session is
  healthy and was never used as a blind reviewer for that run; otherwise a fresh primary
  CTO is created.
- Contract drift detection: an applied manifest whose digest differs from the approved
  digest rejects activation with `BOOTSTRAP_CONTRACT_DRIFT`.
- The portable-manifest and `VerificationCommand` schemas, as the single canonical
  implementation both systems share (Integration §2.2).

The control plane does **not** implement plan compilation, template rendering, GitHub
provisioning, issue projection generation or any other bootstrap runtime. Those stay in
Repo Factory. Manual project registration exists as a first-class path so a project can
be onboarded with no Repo Factory involvement at all.

## Alternatives rejected

- **Building a minimal bootstrap runtime "to test the seam"** — that is the duplicated
  runtime §26 exists to prevent. The seam is tested with a fixture `RepoFactoryResult`
  and a real manually registered project.
- **Accepting the factory's activation claims when present** — makes CP-S52 pass by
  accident and reintroduces a second runtime authority.

## Consequences

When Repo Factory lands, integration is: produce a valid `repo-factory.result.v2`, call
`bootstrap_activate`. No control-plane change is required.
