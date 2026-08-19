# Roadmap — from a running daemon to a working factory

- **Date:** 2026-08-19
- **Head at writing:** `eeb3b53` · 0 open PRs · 19 open issues
- **Runtime:** daemon up, four sockets listening, `runs 0 / projects 0`, doctor reports `CEO_ROLE_UNBOUND`

The end state the owner stated: **one Hermes that is both the personal assistant and the CEO,
several CTOs — one per project, grok as adversarial reviewer, and the control plane as the belt
they all run on.** Whichever channel the owner arrives on, they reach the same counterpart and the
same history, and that history is the control plane's.

That counterpart is a **conversational actor**, not a session, and the distinction is load-bearing
here. `docs/TERMINOLOGY.md` defines it as the thing that owns the transcript and is reached
identically over Remote Control, Buzz or Telegram, whose replacement is a generation rotation
requiring owner approval. The sessions underneath it are meant to be swapped by failover without
asking anyone. Phrase the requirement at that layer and the control plane violates it by working
correctly: a failover rotates the CTO mid-conversation and the owner loses context without being
told.

None of this is a new architecture. `domain/types.ts` already scopes `CEO` globally,
`PRIMARY_CTO` per `projectId`, `OPTIONAL_ADVERSARIAL_REVIEWER` per `runId`, and `WORKER` per
`taskId`; `assertCurrentCeo` refuses any session but the bound one; `assignments` carries
`actor_id` and `registry/conversational-actor-registry.ts` holds the registered set. What is
missing is that nothing is connected to it.

## The ordering constraint that shapes everything below

Two measured facts fix the sequence:

**1. The control plane cannot pass its own acceptance without Hermes.** Its end-to-end criterion
runs `User → Hermes → ACP → CTO → worker → verification → blind review → Hermes`, and #512's
proof predicate requires reaching `CEO_APPROVED`. Only `ceo_decision_submit` produces that state,
and only a session bound to the CEO role may call it. `~/.hermes` contains zero references to
`agent-control-plane`.

**2. The CEO bootstrap succeeds exactly once, ever.** It refuses on binding *history*, not only
on an active binding, so a rehearsal bind is permanent (#596).

Together: **the thin Hermes-side MCP client is a prerequisite of phase 1, not a migration step**,
and the first bootstrap must be the CEO the deployment intends to keep.

They also fix an ordering this document originally had backwards. Handing Telegram to the daemon
before a CEO is bound would leave `ask` with nothing to ask: the owner's assistant channel would be
taken away and a refusal handed back. The cutover is therefore phase 2b, after the binding, and it
carries a rollback. Hermes's *rule and prompt*
refactor correctly stays late — it touches the running system — but the client does not; it is
pure addition and changes nothing about how Hermes behaves today.

## Phase 0 — already done

- Trusted core, registries, run/session/role binding, verification, blind review, GitHub kernel,
  capacity, continuity, doctor. Daemon starts and holds its locks; bootstrap park works in
  production (`DAEMON_BOOTSTRAP_PARKED` → `PROMOTED`).
- Capacity reads each provider's own account surface rather than a rendered terminal
  (`docs/capacity-source.md`).
- **Repo Factory's control-plane side is complete** — ADR-0008 fixes `RepoFactoryResult` as an
  input contract with `bootstrap/repo-factory-result.ts`. The later Repo Factory phase carries
  almost no control-plane work.
- ADR-0009 decides the owner's Telegram channel enters through the control plane.

## Phase 1 — build the client, and prove it without touching the running system

| | Work | Where |
|---|---|---|
| 1.1 | Hermes gains an ACP MCP client: bootstrap handshake, CEO authentication, `sampling` capability. `docs/reference/hermes-ceo-runtime.cjs` is a working one — the process test spawns that exact file, so it is the protocol rather than a description of it | Hermes |
| 1.2 | `onDirect` delivers ordinary conversation to the CEO session over `createMessage` | done — #595 |
| 1.3 | A process test binds that client on a **disposable state directory** and exchanges one DIRECT turn | Hermes + ACP |
| 1.4 | Resolve `provider: "hermes"` against `CAPABILITIES`, which has no such entry | #596 |

1.3 is where the client is proven. It cannot be proven on the production state directory, because
the bootstrap that would prove it is the one bootstrap that deployment ever gets.

**Exit:** the client binds, holds the CEO role and answers a DIRECT turn — on a throwaway state
directory. Telegram is untouched; the owner still talks to the same Hermes they talk to today.

## Phase 2 — bind the CEO on production state, once

`agentctl bootstrap hermes -- <Hermes in ACP mode>`. Detached, long-lived, survives daemon
restarts. `CEO_ROLE_UNBOUND` clears.

**This step is irreversible** — the guard refuses on binding *history*, not only on an active
binding (#596). It runs after 1.3 has shown the client works, and never as a rehearsal.

What it establishes is the CEO **actor**, not merely a process. If that Hermes runtime later dies,
continuity re-staffs the role from the coverage plan — `CAPABILITIES` advertises `ceo` on `claude`
and `gpt` — so the owner keeps the counterpart and the transcript while the runtime behind it
changes. Restarting Hermes specifically is a separate operational question that continuity does
not answer.

**Exit:** `doctor` no longer reports `CEO_ROLE_UNBOUND`, and a DIRECT turn over the MCP socket is
answered by Hermes rather than refused.

## Phase 2b — hand over Telegram, atomically, with a way back

Only now. Before the CEO is bound, `ask` can only answer `CEO_CONVERSATION_UNAVAILABLE`, so a
cutover at that point would take the owner's assistant away and give back a refusal.

```
1  Hermes stops polling Telegram
2  the same bot token moves into the daemon's Keychain entries
3  the daemon's listener starts
4  one real round trip is observed and captured
```

Steps 1–3 are one operation. Telegram admits a single `getUpdates` consumer per bot, so a gap
between them drops the owner's messages and an overlap splits them.

**Rollback:** delete the four Keychain entries, restart the daemon — it logs `Telegram ingress not
configured` and continues — then restart Hermes polling. The bot, the chat and the transcript are
unchanged throughout, because only the consumer moved.

**Exit:** #510 closes here, on a round trip through the daemon's listener that Hermes answered.

## Phase 3 — the three proofs

The owner's sealed gate (`BUZZ-TRANSITION-THREE-PROOF-GATE`, currently `BLOCKED__0_OF_3`). Only
exact `PASS` contributes; the conjunction is a verifier, not a fourth proof.

| Proof | Subject | Note |
|---|---|---|
| P2 · #512 | two public repos, distinct `merge_order`, real lifecycle through `CEO_APPROVED`, daemon finalization, `prPrepare → gatePublish → mergeExecute → postMergeVerify` in order | required checks are configured and verified on both repos |
| P3 · #245 | owner-identity declaration, one real owner decision leaving a durable receipt, allowlist → bind → assign grounding | conjunct (ii) is only meaningful **after** phase 2 — with no CEO bound, `assertCurrentCeo` denies on its first branch and the observation measures nothing |
| P1 | `src/buzz/buzz-adapter.ts` against the installed Buzz CLI, `available(purpose)` answering the specific purpose | subject amended 2026-08-16; the original named an artifact that does not exist |

P2 first: it is the one the whole belt runs through, and P3's negative observation depends on
phase 2 having happened.

## Phase 4 — migration

Begins only after the gate passes. The gate's successor is `T7B-REGISTRY-CENSUS`; the
RepoFactory registration node was retired by the 2026-08-16 owner decision, not deferred.

- **4.1** registry census → current-generation baseline.
- **4.2 Hermes rules.** Reduce to assistant + CEO + specification authority. Everything about
  session identity, provider fallback, quota, retry counts, reviewer creation, merge
  admissibility, worker concurrency, routing tables and handoff state moves out.
- **4.3 CTO rules — the global half only.** Keep repo analysis, technical challenge, dynamic task
  graph, worker and model selection, implementation, integration, the blind-review revision loop,
  escalation judgement. Remove fixed pipelines, fixed concurrency, permanent-CTO identity,
  self-owned run lifecycle, global doctor, global merge authority, self-approved blind review.
- **4.4 Project rules travel with their project, not with this phase.** A CTO is
  `PRIMARY_CTO:{projectId}`, so before a project is registered there is no CTO whose rules could be
  verified. Per-project rule stripping belongs to that project's onboarding step in 5.3.
  `AGENTS.md` keeps project-local content only — structure, test commands, coding rules, real
  prohibitions — and the portable half already has a schema: `ProjectManifest` in
  `contracts/manifest.ts`.

**Every `MOVE_TO_ACP` row must name the ACP symbol that will enforce it (#597).** Loci are named
by symbol, never by line number. A row whose symbol does not resolve is not a move — it is a
missing capability, and the rule stays where it is until a ticket closes it. The current list all
resolves, so this is a check that already passes rather than a tax.

## What runs in parallel, starting now

The phases above are a dependency chain, not a schedule. Three tracks do not sit on it.

**Repo Factory implementation is unblocked today.** The 2026-08-16 owner decision retired
`T7B-RF-REGISTER` — Repo Factory is not going on Buzz as a conversational actor — which removed
its only tie to the three-proof gate. Its integration point is producing a `RepoFactoryResult`,
and the control plane's consuming side is finished (ADR-0008). The checkout is still the public
skill repository at its initial commit with zero occurrences of `buzz`, so nothing there has to be
undone first. It must land before phase 5.1; it can start before phase 1.

**Rule classification can be done before it is applied.** Reading every Hermes rule, global and
per-project `CLAUDE.md`, `AGENTS.md` and agent prompt, and sorting them into
KEEP / MOVE_TO_ACP / SIMPLIFY / DELETE / PROJECT_LOCAL is analysis, not change. Doing it early
surfaces the rows whose ACP enforcement symbol does not resolve (#597), and each of those is a
control-plane ticket that wants to be found before phase 4 rather than during it.

**Closing the open-issue backlog** is an owner criterion for transition and is independent of
every phase here.

## Phase 5 — rollout

1. One new project end to end through Repo Factory.
2. One existing project as pilot — a real one, run for more than a day, exercising parallel runs,
   quota pressure, CTO replacement, doctor, blind review, merge and continuity.
3. The rest, one at a time: strip old rules → manifest → CTO assignment → doctor PASS.
4. Retire the old machinery (`T9D`, `T9E`): legacy routing and session management, duplicated
   reviewers, repo-local merge brokers, duplicate quota tracking, stale multi-agent prompts.

The acceptance for each: **if state has to be adjusted by hand even once, it is not ready.**

## Conditions that sit outside the phase order

- **Zero open issues in both repositories** — reinstated by the owner on 2026-08-16 and explicitly
  outside the gate's arithmetic. Passing the gate does not waive it; closing issues does not
  promote the gate. ACP currently has 19.
- **Subscription only.** No agent is invoked through a metered API in any automated step; reviews
  run on the owner's machine. Local CLI spawn is allowed; CI-runner agent execution is not.
- **Isolation today is emptiness, not environment.** The daemon runs against the production state
  directory and the owner's real provider accounts. It is harmless because `runs 0 / projects 0`,
  not because it is sandboxed — the first #512 run merges into real repositories.

## What Hermes's prompt must not say

The draft bootstrap prompt calls Hermes the "business-decision authority". The control plane
refuses that reading in code: `owner_decision_submit` always denies with
`OWNER_AUTHORITY_NOT_DELEGABLE`, and `admitOwnerApproval` has two production call sites — the
Telegram ingress and the CLI. **Hermes makes CEO decisions and cannot make or relay owner
decisions.** The prompt should say so, or Hermes will be refused repeatedly without understanding
why.
