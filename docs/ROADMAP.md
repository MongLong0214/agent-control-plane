# Roadmap — one authority, one canonical CEO, then the factory

- **Reconciled:** 2026-09-21 (previously 2026-08-24)
- **Document base:** `831fe785`; the previous base was `686281a897c44937bd40e1759decd95b76d63f49`.
- **Purpose:** dependency order and terminal acceptance only; live status remains in the issue tracker.
- **Owner terminal deadline:** `2026-08-27 09:12 KST` — **expired, and the program did not stop at
  it.** The schedule in §4 is kept as the record of a direction that was given, not as a live plan.
  Nothing below may be read as on-time or overdue against it.

> **Reconciliation note, 2026-09-21.** This document went twenty-eight days without being read
> against the tracker. In that window **every issue it names as a blocker closed** — all twenty-six
> of them — and the terminal acceptance list in §7 names two acceptances the owner has since retired
> by decision. A roadmap whose blockers are all closed and whose gates name retired acceptances is
> not a dependency order; it is a historical document being read as a current one. Each section
> below now carries its measured state inline. **Re-derive before acting:**
> `gh issue list --state open --limit 40 --json number,title` returns **five** issues, and §3 says
> which.

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

1. canonical CEO safe terminalization, including durable turn truth and activation rollback;
2. remaining three canonical actors;
3. Buzz transition proofs;
4. factory acceptance and observation;
5. final closeout.

The complete terminal outcome remains one program WIP. Independent responsibility units may execute in
parallel only when their writable files, symbols, and transaction ownership are disjoint and explicit.

## 3. Reconciliation snapshot

**Measured 2026-09-21.** The 2026-08-24 column is kept so the movement is visible.

| | 2026-08-24 | 2026-09-21 |
|---|---|---|
| repository commit | `686281a8` | `831fe785` (`origin/main` = `507ad977`) |
| open pull requests | 0 | **2** — #986 (frozen), #987 (CI hotfix, in review) |
| open issues | 38 | **5** — #954, #627, #512, #306 (the index), #246 (a separate deliverable) |
| `node scripts/ssot-report.mjs` | PASS | **PASS** — *"open review issues: 0"*, *"SSOT reconciled"* |
| evidence freshness | 0 current, 5 stale | **0 current, 6 stale** |
| suite | — | 3911 tests / 3900 passed / 0 failed / 11 pending, 790 files |

These are timestamped evidence, not counters to maintain by hand.

### Confirmed blockers — **every issue this section named is closed**

The list below is preserved struck through, because deleting it would hide that this document
asserted these as current for twenty-eight days after they stopped being true.

- ~~Telegram and Buzz do not currently reach one CEO conversational actor. The Buzz bridge path
  starts its own `hermes acp` child (#627).~~ **#627 is still open but its subject changed.
  Measured 2026-09-21: `buzz-acp`, `hermes acp` and `ai.hermes.buzz-bridge` are all absent from the
  process list and from `launchctl`.** The fork is not running — the bridge is down under the
  owner's standing freeze (*"제출 경로 완성 전 bridge 재기동 금지"*). #627 is an **open design
  obligation** (nothing in `hermes acp` would prevent a fork if the bridge came back), not a live
  violation. Do not restate it as one.
- ~~Buzz addressed-mention delivery is not a durable agent-independent subscription yet (#674).~~
  **#674 closed 2026-09-13**, traced end to end on durable evidence.
- ~~Stable identity, fencing, ingress, reconciliation, outbox, settlement, and crash behavior remain
  open in #639, #664, #630, #631, #632, #641, #650, #660, #662, #666, and #672–#673.~~
  **All eleven closed** between 2026-08-29 and 2026-09-21 (#631 last, 2026-09-21).
- ~~ACP cannot yet prove a disconnected Hermes turn's terminal commit from a durable receipt (#638),
  broad writer closure remains open in #675, and #676…~~ **#638 and #639 closed 2026-09-06; #675
  closed 2026-08-29; #676 closed 2026-08-30.**
- ~~Canonical live cutover remains owner-gated in #510…~~ **#510 closed `COMPLETED` 2026-09-15**, and
  ~~#655~~ with it. The Telegram round trip's design premise was withdrawn on an owner direction
  (*"봇 공유등 미러링방식은 절대 쓰면 안돼 / 각 세션은 유일해야돼"*), because `getUpdates` allows one
  consumer per bot and the plan required sharing one.
- **Still true:** the evidence manifests are stale, so none authorizes a live cutover.
  `verify-evidence-freshness` reports **0 current, 6 stale** — `e2e-real-project.json` by **462
  source commits** (it describes `6ea11e6`). Re-derive from a run; do not edit a file to agree.

### What is blocking, 2026-09-21

Three things, and the first is not owner-gated:

1. **Nothing holds a binding.** `~/.agent-control-plane/state.sqlite` → `assignments`: **7 rows,
   all REVOKED**. CEO since 2026-08-23 (`PROBE_FAILED`); `PRIMARY_CTO` generation 6 since
   2026-09-16 (*"coverage plan cannot staff the bound role"*). `continuity_state` reads
   **DEGRADED / FULL_COVERAGE**, evaluated 2026-09-21T02:52Z — full coverage over a role unbound
   for five days. #975 merged 2026-09-20 (`893d42a7`) and **is deployed** (the live daemon runs
   `runtime/generation-893d42a`), making the rebind one action per *grant* rather than per
   *incident*; it has never been used — `audit_events kind LIKE 'CTO_BINDING_DELEGATION%'` returns
   **0 rows**. See **#954**.
2. **The ACP↔CEO caller does not exist** (#627). Both endpoints do: Hermes serves a
   canonical-surface endpoint on `127.0.0.1:8642`, and ACP's `buzz-message.ingress.sock` is open and
   answers on the same connection.
3. **Real GitHub writes and real provider calls** for #512, which are owner-gated and unchanged.

### Exact-source implementation baseline

> **Superseded 2026-09-21.** This was reconnaissance taken on 2026-08-24 and every gap it names has
> since been built or closed — most of §4's C1–C4 landed through #630, #632, #638, #639, #664, #675
> and #676. It is kept as the starting point the work was planned from, **not as a description of
> the current source.** Read the source, or §3's *What is blocking* above.

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

### Safety interlock with #638 and #510

> **Discharged 2026-09-21.** #638 and #639 closed 2026-09-06; #664 and #675 closed 2026-08-29; #510
> closed 2026-09-15. The receipt contract this interlock guarded now exists, so the interlock no
> longer gates anything. The paragraph stays because the *rule* it states — a receipt, not a process
> exit, is terminal truth — is still the contract, and §9 depends on it.

A targetless existing-only ingress can be built and proven in disposable state before receipt support,
but canonical activation cannot. Hermes must first commit the #638 receipt atomically with the final
assistant row and provide idempotent re-invocation; ACP must then match that receipt through #639 and
preserve `OUTCOME_UNKNOWN` with `NO_AUTO_RETRY` whenever identity or outcome is unproved. The live
cutover in #510 remains blocked until that contract, its writer/crash matrix, wrapper removal, and the
bounded rollback path all pass on one integrated candidate.

## 4. WIP 1 — canonical CEO critical path

No later acceptance may be declared early merely because its implementation is easier. C1/C2, C3/C4,
C5, and C6 may use separate writers on explicitly disjoint responsibility units; shared transaction or
schema files have one integration owner. C7 and C8 remain ordered terminal gates.

> **Measured 2026-09-21 — where the ladder actually stands.** The gate *contracts* below are
> unchanged and still binding; what changed is that their tracking issues are closed. Closed
> tracking issues mean **the code exists**, not that the gate was observed — C7 and C8 are
> observations and neither has been run.
>
> | Gate | Tracking issues | State |
> |---|---|---|
> | C0 freeze the fork | #596, #627 | #596 closed 2026-08-29. The fork is **not running** (§3). #627 open as a design obligation |
> | C1 bound-turn kernel | — | built; `buzz-message.ingress.sock` is open and answers on the same connection |
> | C2 request-local reply sink | — | built |
> | C3 receipt authority | #638, #639, #664, #675, #676 | **all closed** 2026-08-29 … 2026-09-06 |
> | C4 admission/settlement/delivery | #630, #631, #632, #641, #650, #660, #662, #666, #672, #673, #693, #695 | **all closed**, #631 last on 2026-09-21 |
> | C5 bounded rollback | — | not separately tracked; unverified against this list |
> | C6 model-free Buzz façade | #674, #627 | #674 closed 2026-09-13. **Item 1 below is met; items 2–8 are #627 and are open** |
> | C7 isolated zero-new-session gate | #655 | #655 closed 2026-09-15, but **the gate has never been run** |
> | C8 live cutover | #510 | #510 closed 2026-09-15 with its premise withdrawn on owner direction. **Never run** |
>
> The honest summary: **C1–C4 are built, C6 is one component short, and C7/C8 are unobserved.**
> Ahead of all of it is a prerequisite this ladder never listed — see §3, blocker 1: with every
> assignment REVOKED there is no CEO to route a turn to and no CTO to hand a run to. **#954 is the
> first step of C6/C7, not a side issue.**

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

### C3 — durable Hermes receipt and ACP receipt authority

Close terminal-turn truth before any canonical activation:

1. Hermes commits the final assistant row, `COMPLETED`, stable turn request ID, terminal message ID,
   response digest, and binding/session identity in one transaction (#638; upstream #91434);
2. re-invoking the same turn request ID returns that completion receipt only, with zero model, tool, or
   duplicate assistant execution;
3. ACP fixes the stable turn ID, prompt/session/binding digests, and binding generation before dispatch,
   and never transitions to completed without a matching receipt (#639);
4. absent, stale-generation, contradictory, or identity-mismatched evidence remains
   `OUTCOME_UNKNOWN`; queue state is separately `BLOCKED`, and retry policy is `NO_AUTO_RETRY`;
5. admission-correctness writes roll back on deny (#664);
6. broad writer closure passes before the denominator is frozen (#675); #676's exact-symbol,
   inline-SQL `Db.run` owner census does not establish that closure;
7. crash-before/after-row/receipt, duplicate-ID, wrong-target, and stale-generation matrices prove the
   row and receipt are visible together or not visible together.

**Exit:** a matched atomic receipt—not process exit, stdout, or transport success—is the only terminal
completion authority.

### C4 — durable admission, reconciliation, settlement, and delivery

1. single-flight execution leaves the poll loop without losing serialization (#630);
2. durable inbox precedes cursor advance (#631), and completed-turn reconciliation closes #632;
3. duplicate ID with identical digest returns prior state; digest conflict fails closed;
4. a durable reply outbox preserves the exact origin route without replaying the model turn;
5. owner resend is a deliberate decision path, not a text-equality shortcut (#641);
6. `OUTCOME_UNKNOWN` is visible in doctor and metrics (#650);
7. the #660 owner-message state census enumerates seven ingress states and three context facts,
   each with its producing transition and current terminal-or-gap derived from source; S2's
   second-unresolved-turn disclosure gap and S7's coalesced-batch gap are the two still on this
   critical path, tracked in #695 and #693. Full derivation, re-derivable against current source:
   `docs/design/660-owner-message-state-census.md` (see that document, not this line, for current
   status — this roadmap does not restate it);
8. settlement authority, contradiction escalation, and source/attestation truth close #662 and #666;
9. unresolved-turn operator recovery and durable duplicate retention close #672–#673.

**Exit:** event admission, conversational execution, terminal truth, and delivery obligation survive
restart without a second turn, hidden settlement, or retargeted reply.

### C5 — bounded rollback and recovery prerequisite

Before live transport ownership changes:

1. correct the seven blocking manifest-v2 producer/restore/public-log classes and obtain a fresh
   independent exact-head PASS;
2. seal and read back the corrected topic head;
3. implement detached-artifact rollback output;
4. implement the store-wide maintenance epoch and one-connection in-place rollback;
5. prove wrong-target, unsafe-path, tamper, publication-failure, crash, and recovery matrices;
6. rehearse restoration without touching unowned or live state.

**Exit:** activation has one operator-usable, evidence-bound recovery path; a blocked candidate or green
focused test is not a seal.

### C6 — model-free Buzz façade and offline wrapper migration

1. consume addressed events through an agent-independent durable relay subscription (#674);
2. call C1–C5 with preserved event identity and origin route;
3. remove `hermes acp` child/session ownership from the bridge path (#627);
4. remove command/config session targeting and any child-model lifecycle from the façade;
5. write owner-visible correlation/ACK/verdict/reply journal entries;
6. deliver through the outbox to the originating Buzz channel/thread;
7. on dependency loss, persist `BLOCKED` and stop—never spawn a fallback CEO;
8. prove the legacy wrapper is absent or disabled before live activation.

**Exit:** the adapter owns transport and delivery metadata only; model/session/process ownership stays
inside the existing Gateway.

### C7 — isolated zero-new-session gate

Issue #655 may supply a disposable two-message transport observation, but it proves only that bounded
noncanonical realm. It is not a receipt, duplicate, canonical-safety, or full C7 proof.

Run the full gate from disposable state with a known canonical transcript and no live owner traffic:

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

### C8 — owner-authorized live cutover and zero-new-session proof (#510)

The 2026-08-24 09:12 KST owner direction is conditional activation authority: execute this gate only
after C3–C7 pass on the same integrated candidate, without another stepwise confirmation. It does not
authorize a direct or force push, destructive deletion, or activation with a failed prerequisite.

1. verify the #638/#639 receipt contract, writer denominator, recovery rehearsal, and legacy-wrapper
   removal are exact-head current;
2. backup current bridge/binding/correlation state;
3. drain ingress and prove one consumer;
4. atomically switch the Buzz adapter;
5. send a fresh Telegram nonce followed by a Buzz continuation, then reverse direction;
6. compare exact pre/post identity and transcript-root census;
7. restart the bridge/relay and replay duplicate delivery;
8. prove the legacy fork path cannot become fallback;
9. retain a bounded rollback to the **blocked legacy transport**, never to an independent CEO.

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

### 72-hour execution checkpoints

> **Expired 2026-08-27, twenty-five days before this reconciliation.** Checkpoints 1-4 were met in
> substance (C1-C4 are built, §4); 5, 6 and 7 were not run and remain unrun. The schedule is kept as
> the record of a direction that was given. **It is not a live plan and no item below is "due".**
> Anyone restating a date from this list as current is repeating the defect §3 documents.

The owner replaced every September checkpoint with this bounded schedule:

1. exact writer map and candidate selection — `2026-08-24 13:12 KST`;
2. C1–C4 implementation candidates — `2026-08-24 23:12 KST`;
3. C5 rollback/recovery and C6 façade candidate — `2026-08-25 21:12 KST`;
4. integrated exact-head gate — `2026-08-26 09:12 KST`;
5. C7 isolated canonical/four-actor rehearsal — `2026-08-26 21:12 KST`;
6. C8 live cutover and three canonical-CTO canaries — `2026-08-27 05:12 KST`;
7. factory acceptance, thirty lifecycle observations, issue disposition, and closeout receipt —
   `2026-08-27 09:12 KST`.

This compression removes duplicate gates and parallelizes non-overlapping writers. It does not waive
receipt, crash, rollback, wrong-target, zero-shadow, independent-review, or exact-head evidence.

## 5. WIP 2 — Task 7 full four-actor cardinality

After C8:

1. lock the four canonical actor identities: CEO, AOS CTO, coordination-only CommitLore CTO, and Logic
   CTO;
2. run one project at a time through registry binding, process/session continuity, reconnect, duplicate,
   and zero-shadow proof;
3. require owner-visible request, ACK, blocker, verdict, and reply correlations;
4. enforce exactly one actor, one active lineage head, and one transcript root per role.

Product installation, configuration, diagnostics, auditing, repair, and feature/useability testing for
CommitLore are outside this program. Its Task 7 lane is coordination continuity only.

## 6. Buzz transition gate — three proofs, not issue count

The transition gate is exactly the conjunction of:

1. installed Buzz adapter/CLI purpose contract and live capture PASS —
   **`evidence/p0-09-buzz-live-delivery.json` records `result: "PARTIAL"`, captured 2026-08-15.
   Not a PASS.**
2. #512 full-lifecycle bring-up through `CEO_APPROVED` and daemon finalization; it does not claim
   #240 ordered two-repository acceptance or #241 observation — **#512 open; see §7 for what
   happened to #240 and #241**;
3. #245's declared owner identities plus one durable owner-decision receipt through that
   declaration — **#245 closed 2026-09-11.**

Distinct CEO/CTO conversational Buzz-key binding is a separate Task 7 identity proof and must be tied to
current binding artifacts; #245 does not prove it by itself. **Measured 2026-09-21: there are no
current binding artifacts to tie it to — every assignment is REVOKED (§3).**

#306, #416, #418, #448, and #461—or any historical report—do not substitute for these proofs.

## 7. Factory completion after transport/identity

> **The acceptance bar was narrowed by owner decision on 2026-08-31, and this roadmap did not record
> it.** That is the single most consequential correction in this reconciliation, because it changes
> what "production-ready" means:
>
> - **#240** (ordered two-repository merge acceptance) closed **`NOT_PLANNED`** on an owner direction
>   — *"이 시스템 어차피 나만 내 로컬에서 쓸 거라서"* — with the CEO verdict recorded on the issue:
>   the ordered-merge **code and tests are preserved**; the live two-repository acceptance is a PRD
>   artifact with no user, and **resumes if a real multi-repo run appears**.
> - **#418** (V1-BR-10 baseline minimum) closed `NOT_PLANNED` the same day, folded into #241.
> - **#241** (observation window) closed **`COMPLETED`** the same day.
>
> Items 5 and 6 below are therefore **retired, not achieved**, and no one should schedule work
> against them. If the owner reinstates multi-repo use, item 5 reopens with its code intact.

1. declared owner identities plus one durable owner-decision receipt (#245) — **closed 2026-09-11**;
2. Repo Factory producer contract (#246) — **open**; producer exists and passes the canonical
   parser, contract pin repaired 2026-09-15, activation waits on the GitHub-writing producer
   (the same gate as item 4), RF-S **11 of 25** traceable by name;
3. generated-repository migrations and service-owned integration — **unverified against this list**;
4. #512 full-lifecycle bring-up through daemon finalization — **open, and the critical path.** Its
   external half has been finished since 2026-08-16 (both seed repositories public, `ci.yml`
   present, green, `main` protected with a required `project-ci` check);
5. ~~ordered two-repository merge acceptance (#240)~~ — **retired by owner decision 2026-08-31**;
6. ~~observation window across at least three real projects and thirty lifecycles (#241)~~ —
   **closed `COMPLETED` 2026-08-31**;
7. final open-issue disposition and fresh independent closeout review — **open.** Five issues remain
   (§3). Both review lanes are currently unavailable: `production-review.mjs` needs `codex login`
   and codex is prohibited for this work; grok returned `402 Payment Required` on 2026-09-12. Rounds
   run under `sol-simplify-review` meanwhile, which the protocol permits — *"a model being
   unavailable changes who executes the round; it does not change the round."*

Owner/API/interactive boundaries remain explicit. A closed prerequisite or successful command is not a
live acceptance proof.

## 8. Parallel, non-preempting work

Read-only analysis, issue normalization, rule classification, and Repo Factory implementation may
continue when they do not mutate the canonical CEO substrate or consume its sole writer. Their
completion cannot advance C0–C8.

## 9. Evidence invalidation

Invalidate affected evidence when any of these changes:

- canonical actor key, binding generation, transcript root, or runtime identity;
- Hermes turn persistence, targetless-ingress, fence, or session-store behavior;
- ACP ingress, reconciliation, outbox, receipt, or settlement behavior;
- Telegram/Buzz event schema, signer, relay, adapter, or delivery route;
- backup/rollback authority or operator command;
- candidate head or acceptance denominator.

Role names, prompt similarity, process liveness, CLI exit 0, reply text, and transport ACK are not actor
identity or terminal-commit evidence.

## 10. Final program gate

The repository may claim production readiness only after all of the following are current:

1. canonical CEO live gate C8, including current receipt, writer-closure, recovery, and rollback evidence;
2. Task 7 four-actor continuity and zero-shadow gate;
3. Buzz three-proof transition gate;
4. full factory acceptance **as scoped by §7 after the owner's 2026-08-31 decision** — item 5 there
   is retired and item 6 is closed, so this reads: #246 and #512, not #240 and #241;
5. every open issue has an evidence-backed terminal disposition;
6. a fresh independent closeout review passes.

Until then the repository remains **not production-ready**.

### The shortest honest path from here, 2026-09-21

Not a schedule — a dependency order with nothing between the steps. Each is a prerequisite of the
next, and only the last two need the owner:

1. **Issue a delegation grant and rebind `PRIMARY_CTO` to generation 7** (#954). Merged, deployed
   and unexercised; this is the one blocker that is neither code nor an owner action at a terminal.
   Nothing else can start while every assignment is REVOKED.
2. **Write the caller onto `buzz-message.ingress.sock`** and observe one Buzz round trip with a
   zero-new-session census (#627, C6 items 2-8, then C7). Both endpoints already exist.
3. **Drive one document-only change through `CEO_APPROVED`**, daemon finalization and an exact-SHA
   readback (#512), then **re-derive `evidence/e2e-real-project.json` from that run** — the
   committed copy is stale by 462 source commits and five other evidence files are stale too.
   Needs real GitHub writes: owner-gated.
4. **The GitHub-writing Repo Factory producer** (#246), which is the same gate as (3) and follows it.
5. **A closeout review round** on a restored lane, and a terminal disposition for whatever is open.

What that list does *not* contain is as informative as what it does: no receipt work, no ingress
work, no settlement work, no writer-closure work, and no two-repository acceptance. Those are
finished, or retired.
