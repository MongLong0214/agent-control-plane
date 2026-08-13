# Agent Control Plane

> **Status: not production-ready.** Read [the current status](docs/STATUS.md) before
> attempting to operate or depend on this repository.

Agent Control Plane is intended to be a single local runtime authority for managed project
work: when fully accepted, it turns managed project intent into verified production-ready
results. This checkout currently establishes only verifiable candidate results: it records
the run, binds the sessions that may act, freezes the candidate and contract, verifies it,
requires blind review, and records the decision path. It is deliberately not a general
autonomous agent framework, a hosted service, or an unattended deployment product.

The normative implementation inputs are the vendored [control-plane PRD](docs/prd/AGENT_CONTROL_PLANE_PRD_v1.3_FINAL.md)
and [Repo Factory integration PRD](docs/prd/REPO_FACTORY_CONTROL_PLANE_INTEGRATION_PRD_v1.1_FINAL.md).
The [closeout review](docs/review/AGENT_CONTROL_PLANE_v1.0_FINAL_IMPLEMENTATION_CLOSEOUT_REVIEW.md)
is vendored evidence of what remains wrong; it is not hidden history and it is not a
passing acceptance record.

## The authority boundary

The intended model is one local authority: `agentcpd` owns authoritative state changes,
production-gate publication, and programmatic merge. Tools and model sessions supply
requests and evidence; they must not decide that work is complete on their own.

That is the contract, not a claim that every current surface meets it. In particular, the
direct `agentctl` composition root is an open authority-boundary blocker; do not use direct
CLI mutations as a production control path. See [the tracked issue](https://github.com/MongLong0214/agent-control-plane/issues/393).

## Hard invariants

These are the product, not optional policies. Their normative text is in PRD §4.

| Invariant | What must remain true |
|---|---|
| CP-HI-01 — Managed Write Guard | A project-affecting write needs a valid managed-run identity; a caller's label is not authority. |
| CP-HI-02 — Single Runtime Authority | Project actors cannot independently complete a run, publish an authoritative gate, or merge. |
| CP-HI-03 — Candidate Contract Pinning | Verification is bound to the approved contract digest and frozen candidate, not a mutable replacement. |
| CP-HI-04 — Independent Quality Role | A blind reviewer cannot be a producer for the same run, and the final CEO role is separate. |
| CP-HI-05 — Trusted GitHub Credential | Only the daemon may access the credential for the production gate and programmatic merge. |
| CP-HI-06 — Exact Evidence | Verification, review, gate, and merge evidence bind the same exact candidate snapshot; changed source stales it. |
| CP-HI-07 — Non-delegable Human Role | Provider failover does not invent owner authority. |
| CP-HI-08 — No Silent Degradation | Missing, stale, incomplete, failed, or unisolated evidence must not appear as PASS. |

## Local development and inspection

This is a development workflow, not a production-install recipe. The required Node version
is declared in [package metadata](package.json).

```bash
pnpm install
pnpm rebuild better-sqlite3
pnpm build
pnpm test
pnpm trace
node scripts/ssot-report.mjs
```

After a build, inspect the CLI surface and the daemon lock without invoking a project
mutation:

```bash
node dist/cli/agentctl.js help
node dist/cli/agentctl.js daemon status
node dist/cli/agentctl.js project register my-project /abs/path/to/checkout
node dist/cli/agentctl.js doctor
```

For a disposable local experiment, set a fresh local MCP token and start the daemon in the
foreground:

```bash
export ACP_MCP_TOKEN="$(openssl rand -hex 32)"
node dist/daemon/agentcpd.js
```

The daemon's default state root is local to the user's home directory. Its required owner,
provider, Buzz, and ingress configuration is deliberately not guessed. Read
[operations](docs/OPERATIONS.md) before configuring any of it.

Run the daemon under `launchd` with the rendered installer described in
[`deploy/README.md`](deploy/README.md). Do **not** load the checked-in plist template
directly — it carries unresolved deployment values — and note that a real launchd
installation and reboot have not yet been accepted; that work is tracked in
[the deployment issue](https://github.com/MongLong0214/agent-control-plane/issues/400).

## Current limits and evidence

The repository does not claim live acceptance for any path that has not been observed. In
particular, it does not claim a real GitHub App gate publication, a live Buzz or Telegram
round trip, a launchd installation, or the PRD observation window. The links, blockers, and
milestones are maintained in [current status](docs/STATUS.md).

`pnpm trace` writes [traceability evidence](evidence/traceability.md) from the PRD and a
fresh Vitest JSON result set. Its value is declaration coverage: a labelled executable leaf
appeared with status `passed`. Behavioural coverage and production-entry-point coverage are
not measured, so this report is not proof that a requirement is met in the running system.
`node scripts/ssot-report.mjs` reconciles the tracked review findings and declared work items
with GitHub issues; it does not certify the semantic correctness of a code change.

- a verification command that needs no installed dependencies (this repo's
  `scripts/verify-reason-codes.mjs` is one — it checks the reason-code contract with
  nothing but Node),
- `evidenceMode: "TRUSTED_CI"`, letting CI do the dependency-heavy work and having the
  control plane accept the result only at the exact candidate head from an approved
  workflow digest.

`network: "allowlist"` is not a supported workaround: the manifest schema rejects it
until a proxy or firewall backend can enforce destination policy.

## Persistence

21 tables: the eleven PRD §30.1 names plus ten additions, each justified inline in
[`src/db/schema.sql`](src/db/schema.sql) by the independent lifecycle, integrity constraint
or query it exists for — §40 requires exactly that justification. `tasks` and
`task_dependencies` are separate from `task_executions` because a task node outlives its
attempts and the DAG is queried in both directions; `verification_results` exists because
the completeness gate *counts* rows and a JSON blob cannot be counted or uniquely
constrained; `handoffs` is project-scoped and a replacement happens precisely when the run
count is zero, so it cannot live in `run_artifacts`.

Event sourcing, an audit hash chain, a generic policy DSL, distributed consensus and a
cloud database are all deliberately absent (§30.4).

## Provider capacity

Capacity is collected through each provider CLI's interactive `/usage` surface. The
collectors accept only explicit remaining-quota readings and fail closed on a trust prompt,
activity-only output, timeout, or parser failure; a daemon JSON mirror is not an operator
input. There is no `UNKNOWN` route.
See [docs/capacity-source.md](docs/capacity-source.md).

## Known boundaries

- **Production gate publishing needs a GitHub App.** GitHub does not permit personal
  access tokens to create check runs, so `acp-production-gate` requires an App
  installation with `checks:write`. The kernel's predicate logic is verified against a
  modelled GitHub API, including that a same-named check from any other creator is
  refused.
- **Buzz delivery is unverified live.** The transport is implemented over the `buzz` CLI
  but `BUZZ_PRIVATE_KEY` is not configured in this environment, so delivery has only been
  exercised through the in-memory transport.
- Strong isolation for untrusted repositories, a web dashboard, REST/GraphQL and
  automatic Level 6 routing promotion are backlog (PRD §43).

## Where the remaining work lives

The GitHub issue tracker is the single source of truth. Every finding from both independent
review rounds, every PRD §42 acceptance item that a build cannot satisfy, every deployment
prerequisite and every deliberate trade-off is an issue, labelled by severity, round and
area. `node scripts/ssot-report.mjs` reconciles the tracker against `evidence/review/`,
`evidence/review-round1/` and the declared work items, and exits non-zero if anything is
missing. See [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) for the query table and the current
verdict.

## Documents

- [Ticket DAG](docs/tickets/tickets.json) — 44 atomic tickets across 7 milestones
- [ADRs](docs/adr/) — the eight decisions that shape the implementation
- [Traceability](evidence/traceability.md) — requirement → scenario → executable test

## Public-repository posture

This repository has no published license grant. Public visibility must not be read as
permission to reuse, redistribute, or deploy it; ask the repository owner for terms. This
checkout intentionally includes neither a `LICENSE` nor a `CHANGELOG`; acceptance and status
history are maintained in [the ledger](docs/ACCEPTANCE.md) and [current status](docs/STATUS.md).

There is no production support or uptime commitment. See [security reporting guidance](docs/SECURITY.md)
and [contribution guidance](docs/CONTRIBUTING.md). The architecture decisions live in
[the ADRs](docs/adr/), while acceptance history lives in [the ledger](docs/ACCEPTANCE.md).
