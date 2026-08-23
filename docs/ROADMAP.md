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

### Explicit decoupling of #638

A durable Hermes terminal receipt is required before production-ready closeout, but it is **not an
identity prerequisite** for replacing the Buzz fork with the already-existing canonical CEO. Until
#638 closes, any lost-connection ambiguity remains `UNKNOWN/BLOCKED`, is visible to the owner, and is
never auto-retried. This preserves at-most-once safety while canonical identity is closed first.

## 4. WIP 1 — canonical CEO critical path

No later lane may be pulled ahead merely because its implementation is easier. Read-only preparation
may run in parallel; no second writer may alter the canonical CEO substrate.

### C0 — freeze the fork and authority

1. Keep the legacy Buzz bridge quarantined as a known fork; do not relabel it canonical.
2. Freeze the current canonical CEO actor key, transcript root, binding generation, and legacy Buzz
   child identity from exact source/artifacts.
3. Reconcile #596's still-open bootstrap lifecycle with #627's recorded CEO binding before any live
   bootstrap action. Do not repeat bootstrap to repair documentation drift.
4. Seal one migration rule for forked history and pending work: detect conflict, preserve both inputs,
   and refuse silent merge or overwrite.

**Exit:** one signed authority packet names the existing canonical CEO target and the prohibited
legacy child-creation path.

### C1 — stable admission and fencing

Close the smallest contract shared by both transports:

1. stable external event ID, canonical actor key, channel/thread origin, and request digest;
2. binding generation plus actor fence on every create/renew/finish transition (#639, #664);
3. one canonical top-level turn per admitted event;
4. duplicate ID with identical digest returns prior state; digest conflict fails closed;
5. final delivery route is bound to the originating event and cannot be caller-retargeted;
6. ambiguous downstream completion is `UNKNOWN/BLOCKED`, not an automatic replay.

**Exit:** a fresh process cannot admit the same event twice or route its result to a different target.

### C2 — durable ingress before cursor

Implement in dependency order:

1. single-flight ingress guard (#630);
2. durable inbox admission before cursor advance (#631);
3. restart reconciliation plus durable reply outbox (#632, #641);
4. owner-visible blocked/resend semantics (#650);
5. restart/duplicate/process-crash acceptance matrix (#672, #673);
6. settlement truth remains distinct from transport success (#660, #662, #666).

**Exit:** the event and its reply obligation survive restart without a second conversational turn.

### C3 — targetless ingress into the existing CEO

Replace client-owned session construction with authenticated targetless ingress:

1. the client submits signed event identity and origin metadata, not a caller-selected CEO/session;
2. server-side canonical binding resolves the sole CEO actor and current runtime generation;
3. actor creation, bootstrap, session cloning, and arbitrary session resume are impossible on this
   endpoint;
4. admission uses the C1/C2 durable ID and fence;
5. the turn appends to the existing transcript root and returns a terminal correlation handle;
6. wrong generation, wrong actor, old binary, nonparticipant, or stale binding fails closed.

**Exit:** one synthetic Buzz event appends one top-level turn to the pre-existing canonical CEO while
actor/session creation count remains zero.

### C4 — convert Buzz to a transport adapter

1. remove `hermes acp` child/session ownership from the bridge path (#627);
2. consume addressed events through an agent-independent durable relay subscription (#674);
3. call C3 with the preserved event ID and origin route;
4. write owner-visible correlation/ACK/verdict/reply journal entries;
5. deliver through the outbox to the originating Buzz channel/thread;
6. on dependency loss, persist `BLOCKED` and stop—never spawn a fallback CEO.

**Exit:** the adapter owns transport and delivery metadata only.

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
