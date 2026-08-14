# ADR-0004 — Verification runs under macOS seatbelt, and fails closed when it cannot

- **Status:** Accepted
- **Date:** 2026-08-12
- **Drivers:** PRD §17.4, §33.3, CP-HI-08, Integration §15

## Context

Candidate-supplied code decides whether a candidate passes. It must not be able to read
authority credentials, reach the network when the contract says `deny`, write outside its
worktree, or outlive its timeout. v1 supports only owner-trusted repositories, but §17.4 is
explicit that secret stripping and worktree isolation are not optional even so. An argv rule
cannot provide that boundary: an allowed `node`, `npm`, `npx` or `vitest` command can exec a
shell after it starts.

## Decision

Each command runs as: disposable git worktree, constructed (never inherited)
environment, `sandbox-exec` seatbelt profile, own process group, a candidate pid/start-time
rendezvous held before `exec`, wall-clock timeout with `SIGTERM`→`SIGKILL` on the group and the
captured candidate, RSS polling, and output byte cap.

The environment is built from an allowlist. `HOME` and `TMPDIR` point into a scratch
directory, so a tool's normal credential lookup (`~/.gitconfig`, `~/.npmrc`, `~/.claude`)
finds nothing. An allowlist entry matching a known secret pattern is dropped rather than
honoured — an allowlist cannot re-admit a credential.

The executable allowlist is defence in depth. It rejects a contract that directly declares a
shell, `env`, `arch` or another non-build executable, but it does not claim to prevent an
allowlisted interpreter from executing one. The seatbelt profile, named sensitive-path denies,
write confinement, network denial and resource/process-group controls are the execution
boundary. The inside-shell proof is maintained in
`tests/unit/handoff-p1-boundaries.test.ts`.

The seatbelt profile denies all writes and then re-allows the worktree, the scratch root
and `/dev`; it denies `network*` when the command declares `network: "deny"`.

The process group is not the complete containment proof: a candidate can call `setsid()` without
forking. The resource wrapper stops its candidate before `exec` and writes the pid to scratch;
the outer supervisor captures `ps` start time, releases the candidate, and later signals/reaps
that exact identity even if the candidate leaves the original group or kills the wrapper. Any
missing identity or cleanup proof is recorded as `childContainmentEnforced: false` with an
explicit `childContainmentReason` and cannot accompany a contained pass.

**Fail closed:** if the confinement mechanism is unavailable and the command needs
confinement, the command is not executed. The result is `ERROR` with
`SANDBOX_NETWORK_DENIED`, never a pass. CP-HI-08 forbids reporting a weaker execution as
a successful one.

## Alternatives rejected

- **Docker / Linux namespaces** — not the deployment target; adds a daemon dependency to
  a service designed to have none.
- **Running unconfined because the repo is owner-trusted** — makes the isolation claim in
  the production-ready packet false, and CP-S27 unfalsifiable.
- **`ulimit` via a candidate shell wrapper** — `RLIMIT_AS` is unreliable on macOS, and making
  a shell the contract boundary would reopen the interpolation surface §12 closes. The
  trusted resource wrapper may still exec candidate code, including a shell, because seatbelt
  and process-group cleanup—not argv inspection—provide the confinement boundary.

## Consequences

Strong isolation for untrusted repositories (full VM/container) stays in the backlog
(§43). What ships is enforced, tested (CP-S27, CP-S28, write-confinement, network-deny)
and honest about its boundary.
