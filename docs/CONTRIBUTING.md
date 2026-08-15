# Contributing

This repository is not a production-ready service and has no published license grant. Ask
the repository owner before relying on contribution or reuse terms.

Before proposing a change, read the normative [PRDs](prd/), the
[closeout review](review/AGENT_CONTROL_PLANE_v1.0_FINAL_IMPLEMENTATION_CLOSEOUT_REVIEW.md),
and [current status](STATUS.md). Keep a change tied to a tracked finding or documented
requirement, and state what live evidence it does not create.

Run the repository gates relevant to the change:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm trace
node scripts/ssot-report.mjs
```

Do not hand-edit generated traceability evidence or status counts. A document that names a
changing number must derive it from a command, query, or generated artifact. A test that
passes after its enforcement is removed is not adequate regression evidence; say which
assertion fails when you check that negative control.

Do not represent a local test, fixture, modelled adapter, or template as live GitHub, Buzz,
Telegram, launchd, provider, or owner evidence. Those claims require the live evidence and
owner-controlled configuration described in [STATUS.md](STATUS.md).

## A test is worth what it refuses, not what it asserts

This repository has repeatedly found tests that pass without their enforcement. Twenty-six were
found at once during the hardening pass; #443 found ten more; #419 found a probe whose result was
effectively hardcoded. In every case the test read correctly to a human, was green, and proved
nothing. Reading cannot catch this, because reading selects the signal you already believe.

So a change that claims to fix or add an enforcement carries a **mutation proof**:

1. delete the enforcement the test names
2. confirm the named test fails, and fails for the stated reason
3. restore

If it does not go red, the test does not yet prove anything, whatever it asserts. Record the
mutation and its result in the PR — that record is the evidence, not the green run.

### Layered defences need one test per layer

Where a property is protected by more than one mechanism — a primary and a backstop — the proof
must bind to each **separately**. For every layer there must be at least one test that fails when
**only that layer** is removed.

Otherwise redundancy hides its own failure. #494 is the worked example: candidate containment has
a primary fence in the trusted wrapper and a secondary reap in TypeScript, and the containment
tests are satisfied by either. Removing the primary alone leaves every test green. The system
would quietly fall back to a single mechanism, and nobody would learn that until the day the
backstop failed too — which is the outcome CP-HI-08 exists to prevent.

The acceptance criterion is a table, because it is checkable:

| mutation | expected |
|---|---|
| remove layer A only | some named test fails |
| remove layer B only | some named test fails |

A defence whose layers cannot be told apart is one defence wearing two names.
