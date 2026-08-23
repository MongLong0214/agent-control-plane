# Roadmap — one authority, one canonical CEO, then the factory

- **Reconciled:** 2026-08-24
- **Document base:** `686281a897c44937bd40e1759decd95b76d63f49`
- **Purpose:** dependency order and terminal acceptance only; live status remains in the issue tracker.

## 1. Authority and state model

The program uses one authority chain:

1. the owner's latest direction;
2. current GitHub issue state and ACP durable artifacts;
3. this roadmap for dependency order;
4. historical reports and evidence only when their exact inputs still match.

`docs/STATUS.md` is a durable boundary map, not a current status ledger. Local bridge-era ledgers,
transport-specific pending queues, process liveness, role names, prompt similarity, and old evidence do
not create a second program authority.

## 2. Current terminal outcome

The owner reaches one long-lived **CEO conversational actor** from Telegram or Buzz. Both surfaces
share the same transcript root, pending-work authority, ordering fence, and durable turn state. A
transport may own channel-specific delivery metadata, but it may not create a CEO clone, resume an
independent CEO, or accumulate a separate conversation history.

This is narrower than the complete four-actor Task 7 outcome and takes priority over it. The next
program phases are:

1. canonical CEO;
2. Hermes rollback/turn-receipt completion;
3. remaining three canonical actors;
4. Buzz transition proofs;
5. factory acceptance and observation;
6. final closeout.

Only the first outcome is WIP 1.

## 3. Reconciliation snapshot

At the reconciliation point:

- repository commit: `686281a897c44937bd40e1759decd95b76d63f49`;
- repository tree: `6e13bcbda40ebe926bf677eb82a8a79df7470b70`;
- open pull requests: 0;
- open issues returned by the tracker query: 38;
- `node scripts/ssot-report.mjs`: PASS;
- tree-bound evidence freshness: 0 current, 5 stale.

These are timestamped evidence, not counters to maintain by hand.

### Confirmed blockers

- Telegram and Buzz do not currently reach one CEO conversational actor. The Buzz bridge path starts
  its own `hermes acp` child (#627). That is an actor/runtime fork, not a canonical CEO.
- Buzz addressed-mention delivery is not a durable agent-independent subscription yet (#674).
- Stable identity, fencing, ingress, reconciliation, outbox, settlement, and crash behavior remain
  open in #639, #664, #630, #631, #632, #641, #650, #660, #662, #666, and #672–#673.
- ACP cannot yet prove a disconnected Hermes turn's terminal commit from a durable receipt (#638;
  upstream #91434).
- The current evidence manifests are stale, so none authorizes a live cutover.

### Exact-source implementation baseline

Current-source reconnaissance found usable primitives but no end-to-end canonical ingress:

- the Gateway has read-only session lookup, a routing-key agent cache, a session-ID turn lease, and an
  authenticated/body-limited API listener;
- it has no canonical-surface binding registry, existing-only bound-turn endpoint, request-local reply
  sink, or durable `(binding,event_id)` ledger;
- the native Buzz adapter derives a Buzz routing key and therefore creates a different session on a
  cache/store miss;
- the current ACP CEO runtime spawns an external child command per turn and accepts a configured
  session identifier, so it does not reuse the running Gateway's cached agent and is not targetless;
- the implementation base is pinned to upstream Hermes commit
  `4621a2d699daeaa92efb93dae9db076308cbe823`; a divergent working checkout and historical live binding
  seals are not implementation authority.

The first implementation slice therefore starts in disposable state and proves one event against a
seeded existing session/cache/lease. It must not hard-code or rediscover a live owner binding.

### Explicit decoupling of #638

A durable Hermes terminal receipt is required before production-ready closeout, but it is **not an
identity prerequisite** for replacing the Buzz fork with the already-existing canonical CEO. Until
#638 closes, any lost-connection ambiguity remains `UNKNOWN/BLOCKED`, is visible to the owner, and is
never auto-retried. This preserves at-most-once safety while canonical identity is closed first.

## 4. WIP 1 — canonical CEO critical path

No later lane may be pulled ahead merely because its implementation is easier. Read-only preparation
may run in parallel; no second writer may alter the canonical CEO substrate.

### C0 — freeze the fork and disposable authority

1. Keep the legacy Buzz bridge quarantined as a known fork; do not relabel it canonical.
2. Pin the current-source implementation base and the exact legacy child-creation chain.
3. Reconcile #596's still-open bootstrap lifecycle with #627's recorded CEO binding before any live
   bootstrap action. Do not repeat bootstrap to repair documentation drift.
4. In disposable state, seed an existing Telegram routing entry, session row, cached agent, and lease
   target. Do not copy a historical live binding into configuration.
5. Seal one later migration rule for forked history and pending work: detect conflict, preserve both
   inputs, and refuse silent merge or overwrite.

**Exit:** one authority packet names the pinned implementation base, the disposable existing target,
and the prohibited legacy child-creation path.

### C1 — VS1 targetless existing-only bound-turn kernel

Build the narrow server-side execution seam before transport migration:

1. authenticated request schema accepts only a binding name, stable event ID, author/channel origin,
   and text;
2. caller-supplied session ID/key, route, platform, chat target, or user target is rejected before any
   agent/session contact;
3. server-side binding resolves one existing routing entry and session row without create, reset,
   switch, fork, resume-child, or recovery fallback;
4. the exact session-ID lease is acquired before history load;
5. the exact routing-key cached agent is reused; cache miss fails closed instead of constructing one;
6. one request appends one user row and one terminal assistant chain and returns the same event ID;
7. pre/post session-ID set and existing row identity remain unchanged.

The behavioral RED must use disposable state, raising spies on every constructor/create/reset/switch/
fork path, and object-identity assertions on the cached agent.

**Exit:** one synthetic Buzz-shaped event executes one turn on the seeded existing CEO target while all
new-session and new-agent counters remain zero. This is isolated evidence only.

### C2 — request-local reply sink

Separate conversational execution from transport delivery:

1. add a turn-local terminal reply capability that is bound to the admitted event;
2. keep Telegram transport references out of Buzz-originated execution and Buzz transport references
   out of the canonical transcript-root/conversational-actor identity;
3. stream/progress/clarification paths without a safe sink fail closed in this slice;
4. wrong event, channel, thread, or reused sink cannot receive the terminal response;
5. sink failure records a durable reply obligation without replaying the model turn.

**Exit:** the same canonical turn can return to its originating event without changing the actor's
routing identity or invoking a second platform adapter.

### C3 — durable admission, reconciliation, and delivery

Close the shared durability contract before replacing the wrapper:

1. stable external event ID, binding, origin route, request digest, and binding generation/fence
   (#639, #664);
2. single-flight ingress guard (#630);
3. durable inbox before cursor advance (#631);
4. duplicate ID with identical digest returns prior state; digest conflict fails closed;
5. restart reconciliation plus durable reply outbox (#632, #641);
6. owner-visible blocked/resend semantics (#650);
7. settlement truth remains distinct from transport success (#660, #662, #666);
8. ambiguous downstream completion remains `UNKNOWN/BLOCKED` with no automatic replay;
9. restart/duplicate/process-crash acceptance matrix (#672, #673).

**Exit:** the event and its delivery obligation survive restart without a second conversational turn or
a retargeted reply.

### C4 — model-free Buzz façade and offline wrapper migration

1. consume addressed events through an agent-independent durable relay subscription (#674);
2. call C1–C3 with preserved event identity and origin route;
3. remove `hermes acp` child/session ownership from the bridge path (#627);
4. remove command/config session targeting and any child-model lifecycle from the façade;
5. write owner-visible correlation/ACK/verdict/reply journal entries;
6. deliver through the outbox to the originating Buzz channel/thread;
7. on dependency loss, persist `BLOCKED` and stop—never spawn a fallback CEO;
8. prove the legacy wrapper is absent or disabled before live activation.

**Exit:** the adapter owns transport and delivery metadata only; model/session/process ownership stays
inside the existing Gateway.

### C5 — isolated zero-new-session gate

Run from disposable state with a known canonical transcript and no live owner traffic:

1. Telegram event → canonical CEO turn → Telegram reply;
2. Buzz event → same CEO continuation → originating Buzz reply;
3. reverse ordering;
4. 100 duplicate deliveries of each event;
5. crash after inbox, after cursor, during turn, after terminal result, and during reply;
6. reconnect and bridge restart;
7. wrong target, stale generation, old binary, and nonparticipant negatives;
8. forked pending-work conflict;
9. exact pre/post conversational-actor, runtime-generation, process, transcript-root,
   pending-state, event-ID, and reply-route census.

**Exit:** `ISOLATED_CANONICAL_CEO_PASS`; live traffic remains disabled.

### C6 — live cutover and zero-new-session proof

1. backup current bridge/binding/correlation state;
2. drain ingress and prove one consumer;
3. atomically switch the Buzz adapter;
4. send a fresh Telegram nonce followed by a Buzz continuation, then reverse direction;
5. compare exact pre/post identity and transcript-root census;
6. restart the bridge/relay and replay duplicate delivery;
7. prove the legacy fork path cannot become fallback;
8. retain a bounded rollback to the **blocked legacy transport**, never to an independent CEO.

**Terminal acceptance:**

- canonical CEO conversational actors: exactly 1;
- transcript/pending authority: exactly 1;
- adapter-created CEO sessions: 0;
- one event → one canonical top-level turn;
- one terminal assistant chain per accepted event;
- one reply to the exact originating event/thread;
- 100 duplicate deliveries → at most one admission and one reply;
- restart → zero unexpected conversational actors, runtime generations, processes, or transcript rows;
- forked pending work → zero silent merges or overwrites;
- transport failure → zero fallback actor creation.

## 5. WIP 2 — Hermes #638 rollback and terminal receipt

This lane starts after C6. A blocked candidate is not a seal.

1. correct and independently re-review manifest-v2 producer/restore authority;
2. seal the corrected exact head and verify fork topic-branch readback;
3. implement detached-artifact rollback output;
4. implement the store-wide maintenance epoch and one-connection in-place rollback;
5. complete Hermes terminal turn receipt (#91434);
6. complete ACP receipt consumption and fail-closed contradictions (#638);
7. run exact-head rollback, disconnect, duplicate, crash, wrong-target, and public-safety gates.

**Exit:** rollback is operator-usable, terminal commit truth is durable, and a matched receipt—not a
transport outcome—authorizes completion.

## 6. WIP 3 — Task 7 full four-actor cardinality

After WIP 2:

1. lock the four canonical actor identities: CEO, AOS CTO, coordination-only CommitLore CTO, and Logic
   CTO;
2. run one project at a time through registry binding, process/session continuity, reconnect, duplicate,
   and zero-shadow proof;
3. require owner-visible request, ACK, blocker, verdict, and reply correlations;
4. enforce exactly one actor, one active lineage head, and one transcript root per role.

Product installation, configuration, diagnostics, auditing, repair, and feature/useability testing for
CommitLore are outside this program. Its Task 7 lane is coordination continuity only.

## 7. Buzz transition gate — three proofs, not issue count

The transition gate is exactly the conjunction of:

1. installed Buzz adapter/CLI purpose contract and live capture PASS;
2. #512 full lifecycle across two repositories through `CEO_APPROVED` and daemon finalization;
3. #245 owner identity declarations plus Telegram and distinct CEO/CTO Buzz-key allowlist grounding.

#306, #416, #418, #448, and #461—or any historical report—do not substitute for these proofs.

## 8. Factory completion after transport/identity

1. owner identity declarations and allowlists (#245);
2. Repo Factory producer contract (#246);
3. generated-repository migrations and service-owned integration;
4. two-repository ordered merge acceptance (#240/#512);
5. observation window across at least three real projects and thirty lifecycles (#241);
6. final open-issue disposition and fresh independent closeout review.

Owner/API/interactive boundaries remain explicit. A closed prerequisite or successful command is not a
live acceptance proof.

## 9. Parallel, non-preempting work

Read-only analysis, issue normalization, rule classification, and Repo Factory implementation may
continue when they do not mutate the canonical CEO substrate or consume its sole writer. Their
completion cannot advance C0–C6.

## 10. Evidence invalidation

Invalidate affected evidence when any of these changes:

- canonical actor key, binding generation, transcript root, or runtime identity;
- Hermes turn persistence, targetless-ingress, fence, or session-store behavior;
- ACP ingress, reconciliation, outbox, receipt, or settlement behavior;
- Telegram/Buzz event schema, signer, relay, adapter, or delivery route;
- backup/rollback authority or operator command;
- candidate head or acceptance denominator.

Role names, prompt similarity, process liveness, CLI exit 0, reply text, and transport ACK are not actor
identity or terminal-commit evidence.

## 11. Final program gate

The repository may claim production readiness only after all of the following are current:

1. canonical CEO live gate C6;
2. Hermes rollback and terminal-receipt gate;
3. Task 7 four-actor continuity and zero-shadow gate;
4. Buzz three-proof transition gate;
5. full factory acceptance and observation window;
6. every open issue has an evidence-backed terminal disposition;
7. a fresh independent closeout review passes.

Until then the repository remains **not production-ready**.
