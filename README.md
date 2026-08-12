# Agent Control Plane

> A single local runtime authority that turns managed project intent into verified
> production-ready results, and binds logical roles to replaceable model runtime sessions.

Implements `AGENT_CONTROL_PLANE_PRD_v1.3_FINAL` and the control-plane half of
`REPO_FACTORY_CONTROL_PLANE_INTEGRATION_PRD_v1.1_FINAL`. Both are vendored under
[`docs/prd/`](docs/prd/) and are the only implementation input.

## What it is

Hermes stays a free-form assistant. The control plane activates only for real project
execution, and from that point it owns official run state, session and role binding,
global resource claims, verification, mandatory blind review, the trusted GitHub gate and
merge, continuity, the doctor, and decision-grade telemetry.

```
User ──┬─ Buzz
       └─ Telegram
             ↓ authenticated ingress
        Hermes (CEO endpoint)
             ↓ MCP
┌──────────── agentcpd ────────────┐
│ run / contract                   │
│ session registry + role binding  │
│ provider capacity monitor        │
│ role continuity kernel           │
│ task graph / resource receipts   │
│ verification engine (sandboxed)  │
│ mandatory blind review gate      │
│ GitHub integration kernel        │
│ doctor + watchdog                │
│ outbox + audit + telemetry       │
└──────────────────────────────────┘
             ↓ Buzz dispatch
     Primary CTO sessions → workers
```

## The eight hard invariants, and where each one lives

| Invariant | Enforced by |
|---|---|
| CP-HI-01 managed write | `src/guard/managed-write-guard.ts` — inspects operation + resolved path, never the caller's label |
| CP-HI-02 single authority | only `agentcpd` transitions a run to COMPLETED or publishes a gate |
| CP-HI-03 contract pinning | `runs.pinned_manifest_digest`, compared before verification |
| CP-HI-04 reviewer independence | `bindings.producerSessions()`, checked at bind time and again at packet time |
| CP-HI-05 trusted credential | `src/github/credential-store.ts` — `withToken` never returns the value |
| CP-HI-06 exact evidence | `candidateSnapshotDigest` on every verification and review row, enforced by a `CHECK` |
| CP-HI-07 owner authority | human-gate items require a recorded owner decision |
| CP-HI-08 no silent degradation | every gate returns a stable reason code; absent evidence is a distinct non-passing status |

Uniqueness and monotonicity that a race could defeat live in SQLite partial indexes and
triggers, not in application code — see [ADR-0002](docs/adr/ADR-0002-invariants-as-types-and-constraints.md).

## Layout

```
src/
  core/         digests, ids, clock, stable reason codes
  db/           schema, transactions, artifacts, audit
  domain/       vocabulary and the run state machine
  guard/        managed write guard
  contracts/    portable project manifest, verification command
  snapshot/     candidate snapshot: freeze, digest, staleness
  verify/       seatbelt sandbox, worktrees, verification engine
  review/       mandatory independent blind review
  ceo/          production-ready packet, CEO decision, escalation
  run/          run engine, task graph, candidate pipeline
  claims/       global resource claim registry
  registry/     project and repository registries
  session/      session registry and role binding
  capacity/     provider capacity monitor
  continuity/   role coverage plan and failover
  cto/          CTO lifecycle: create, drain, handoff, recovery
  github/       branch contract, trusted kernel, credential store
  doctor/       doctor, watchdog, repair
  bootstrap/    Repo Factory contract surface
  ingress/      ingress guard, Telegram
  buzz/         Buzz transport and actor→binding resolution
  mcp/          Hermes and CTO MCP surfaces
  cli/          agentctl
  daemon/       agentcpd, single-instance lock, reconciliation
```

## Running it

```bash
pnpm install
pnpm rebuild better-sqlite3     # native binding
pnpm typecheck
pnpm test                       # 271 tests, incl. the CP-S01..CP-S59 suite
pnpm trace                      # regenerates evidence/traceability.{json,md}
```

Register an existing project by hand — no Repo Factory needed:

```bash
agentctl project register my-project /abs/path/to/checkout
agentctl capacity set claude '{"buckets":[{"id":"rolling-5h","remainingPercent":80,"capabilities":["cto","blind-review","ceo","worker"]}]}'
agentctl doctor
```

Declare who the owner is. Owner-only decisions — a human gate, a project suspension, a
destructive repair — are refused unless they come from an identity listed here, one
`channel:actor` per line:

```bash
printf 'cli:%s\ntelegram:123456789\n' "$USER" > ~/.agent-control-plane/owner-identities
```

An absent or empty file means this deployment has no owner, so no human gate can be
satisfied. That is deliberate: §21 makes the owner the one authority the runtime may not
synthesise for itself.

Run the daemon under `launchd` using
[`deploy/com.agentcontrolplane.agentcpd.plist`](deploy/com.agentcontrolplane.agentcpd.plist).

## Verification isolation

Candidate commands run in a disposable git worktree, under a macOS seatbelt profile that
denies network when the contract says `deny` and confines writes to the worktree and a
scratch root. The environment is constructed, not inherited: `HOME` and `TMPDIR` point
into the scratch directory so a tool's normal credential lookup finds nothing. If the
confinement mechanism is unavailable the command is **not run** — the result is `ERROR`
with `SANDBOX_NETWORK_DENIED`, never a pass. See
[ADR-0004](docs/adr/ADR-0004-verification-sandbox-isolation.md).

**A consequence worth planning for:** a fresh worktree contains only committed files, so
it has no `node_modules`, no `.venv`, no build cache — and with `network: "deny"` it cannot
fetch them. A project therefore needs one of:

- a verification command that needs no installed dependencies (this repo's
  `scripts/verify-reason-codes.mjs` is one — it checks the reason-code contract with
  nothing but Node),
- an install step declared as its own command with `network: "allowlist"` ahead of the
  build in the profile's command order, or
- `evidenceMode: "TRUSTED_CI"`, letting CI do the dependency-heavy work and having the
  control plane accept the result only at the exact candidate head from an approved
  workflow digest.

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

Neither shipped CLI exposes a quota interface, so the adapters read a structured local
capacity file and fail closed when it is absent or stale. There is no `UNKNOWN` route.
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

## Documents

- [Ticket DAG](docs/tickets/tickets.json) — 44 atomic tickets across 7 milestones
- [ADRs](docs/adr/) — the eight decisions that shape the implementation
- [Traceability](evidence/traceability.md) — requirement → scenario → executable test
