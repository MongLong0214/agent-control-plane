# Scoped CTO binding delegation

## Authority contract

Only an admitted owner decision for `ctoBinding.delegate` can grant recurring,
project-scoped `PRIMARY_CTO` binding authority. Its digest binds the action,
project, CEO session and incarnation, explicit expiry and revocation policy.
Durable grants additionally bind the canonical CEO actor and current assignment.
Delegation is not owner authority and cannot mint owner approvals.

The production composition exposes provisioning through the authenticated operator
boundary and binding through the authenticated CEO session. The binding request
contains no owner credential or caller-supplied target proof. Targets must already
be registered READY sessions with deployment-owned executor identity pins.

Every binding checks the current grant, CEO principal, target incarnation and next
generation. The target verifier authenticates the exact planned actor/target tuple;
a final authority and generation check runs before the binding write. Live incumbents
are preserved. A proven-dead incumbent can be revoked and replaced atomically, with
no partial assignment, target attestation or outbox fence on denial.

## Lifetime and replay

- `owner-or-ceo-loss-or-restart` grants remain local to the running authority.
- `owner-or-ceo-loss` grants are reconstructed only from strictly validated,
  receipt-bound grant events preceded by matching consumed owner decisions.
  Restart survival requires the same live canonical CEO assignment and owner policy.
- Owner revocation needs a separately admitted operation-bound receipt. Expiry
  observed during binding invalidates authority monotonically. After binding rollback,
  expiry maintenance commits its durable tombstone before returning the denial.
  Rolling the clock back must not reauthorize the expired grant.
- Binding and maintenance have distinct transaction outcomes. A binding entry refuses
  an enclosing transaction it cannot own; maintenance failures throw rather than
  reporting a safely settled denial. In-memory invalidation stays fail-closed on a
  persistence error. This is not a claim of atomicity across process termination
  between request rollback and maintenance commit.
- Request identity is bound to the complete request and target incarnation. Current
  authentication, scope and generation checks precede retry handling. Changed reuse
  is refused; a stale retry is not a cached authority permit.
- Only committed binding attempts consume the bounded daemon-local observation
  budget. Denied attempts cannot consume capacity or evict admitted replay state;
  in-memory request observations are published only after database commit.
  Capacity exhaustion fails closed without suppressing expiry maintenance.

`authorize` is a current observation, not a bearer capability. Returned records are
detached copies and carry no credentials. Durable request records and binding writes
share the request transaction; denied requests leave neither behind.

## Restoration and operational boundary

Restoring an existing CEO requires the configured allowlisted CLI owner before any
caller-selected executable runs. Restoration retains the canonical actor and verifies
its target contract; the first-install path does not silently become a restoration
bypass. Neither delegation nor restoration modifies the configured owner allowlist.

Automated verification uses disposable databases and the real production composition.
Executor observation seams and native authentication fixtures are synthetic where
explicitly identified by their tests. They do not establish live owner authentication,
credential-store access, deployment readiness or delivery to a production runtime.
Building this feature neither deploys it nor authorizes an operational launch.
