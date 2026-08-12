# ADR-0001 — Single Node process, SQLite state, no external infrastructure

- **Status:** Accepted
- **Date:** 2026-08-12
- **Drivers:** PRD §33.1, §30, §40 Performance/Maintainability

## Context

`agentcpd` is a local, single-owner, 24/7 workstation service. It must hold the
authoritative runtime state for runs, sessions, bindings, claims and receipts, and it
must survive crashes without duplicating dispatches (§34.5).

## Decision

One supervised Node 22 process, TypeScript with `strict` on, state in a single local
SQLite database opened with WAL and `synchronous=FULL`, accessed through
`better-sqlite3` synchronously inside explicit `BEGIN IMMEDIATE` transactions.

External interfaces are limited to MCP, a Buzz adapter, Telegram ingress and a minimal
CLI (§28.5). No HTTP server, no message broker, no external database.

## Alternatives rejected

- **Postgres or a hosted DB** — buys concurrency the deployment does not have and adds
  an availability dependency to a service whose whole point is local authority.
- **An async SQLite driver** — the authority decisions are short, indexed, single-writer
  transactions. A synchronous driver lets a state transition and its outbox enqueue sit
  in one real transaction (§30.3) without a connection-pool interleaving hazard.
- **Multi-process (daemon + worker pool)** — the single-instance lock and binding
  generation model both assume exactly one writer of authoritative state. Splitting the
  writer would require distributed consensus, explicitly excluded by §30.4.

## Consequences

- A long synchronous query would block the event loop. Every authority query is indexed
  and bounded; anything genuinely long-running (verification, provider probes, git) runs
  in a child process instead.
- Backups are a file copy plus WAL checkpoint (§34.6); provider secrets and transcripts
  are never in the database, so the backup carries no credential material.
