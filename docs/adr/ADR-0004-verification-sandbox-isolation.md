# ADR-0004 — Verification runs under macOS seatbelt, and fails closed when it cannot

- **Status:** Accepted
- **Date:** 2026-08-12
- **Drivers:** PRD §17.4, §33.3, CP-HI-08, Integration §15

## Context

Candidate-supplied commands decide whether a candidate passes. They must not be able to
read authority credentials, reach the network when the contract says `deny`, write
outside their worktree, or outlive their timeout. v1 supports only owner-trusted
repositories, but §17.4 is explicit that secret stripping and worktree isolation are not
optional even so.

## Decision

Each command runs as: disposable git worktree, constructed (never inherited)
environment, `sandbox-exec` seatbelt profile, own process group, wall-clock timeout with
`SIGTERM`→`SIGKILL` on the group, RSS polling, and output byte cap.

The environment is built from an allowlist. `HOME` and `TMPDIR` point into a scratch
directory, so a tool's normal credential lookup (`~/.gitconfig`, `~/.npmrc`, `~/.claude`)
finds nothing. An allowlist entry matching a known secret pattern is dropped rather than
honoured — an allowlist cannot re-admit a credential.

The seatbelt profile denies all writes and then re-allows the worktree, the scratch root
and `/dev`; it denies `network*` when the command declares `network: "deny"`.

**Fail closed:** if the confinement mechanism is unavailable and the command needs
confinement, the command is not executed. The result is `ERROR` with
`SANDBOX_NETWORK_DENIED`, never a pass. CP-HI-08 forbids reporting a weaker execution as
a successful one.

## Alternatives rejected

- **Docker / Linux namespaces** — not the deployment target; adds a daemon dependency to
  a service designed to have none.
- **Running unconfined because the repo is owner-trusted** — makes the isolation claim in
  the production-ready packet false, and CP-S27 unfalsifiable.
- **`ulimit` via a shell wrapper** — `RLIMIT_AS` is unreliable on macOS, and introducing a
  shell into the candidate path reopens the interpolation surface §12 closes.

## Consequences

Strong isolation for untrusted repositories (full VM/container) stays in the backlog
(§43). What ships is enforced, tested (CP-S27, CP-S28, write-confinement, network-deny)
and honest about its boundary.
