# A census of the states an owner message can be in (#660)

A reference, not a work item — the seven states an owner's Telegram message can be in on its way
from `TelegramLongPollListener` through `IngressGuard` and `TelegramHermesRouter` to a CEO turn,
so a change touching the DIRECT ingress path can be checked against the full list instead of
whatever subset the last PR happened to exercise.

**Anchored by symbol and quoted comment, not by file:line or a pinned commit.** A line number or a
hard SHA goes stale the moment the code around it moves, and a stale locus fails silently — nothing
marks it wrong until a reader notices the search comes up empty (#597). Every claim below names a
function, a type, or a quoted comment fragment `grep`-able against whatever `origin/main` is when
this is read, and every producing transition names the commit that closed or introduced it as a
historical fact — those commits do not change. Re-derive by rerunning the searches and rereading
the functions each row names against whatever `origin/main` is when you read this; where this
document and the code disagree, the code is right and this document is what has gone stale.

**This document was last re-derived 2026-08-30 against `origin/main` at commit**
**`8ba6e271a39d2d627f2d041257a2678802eb276b` (#713, "the CEO turn leaves pollOnce, and the seven**
**fault tests still observe what they name"), plus this branch's Telegram reply-delivery changes.** This pinned SHA
is not the same kind of fact as a file:line locus above — it names *when this document's prose was checked*, not *where a
claim lives in the code*, and it is the one piece of "current source" bookkeeping this document
keeps, precisely because the alternative already failed once: an earlier version of this document
was re-derived against a commit before #691 merged, and its `S4`/`C1` rows described `main` as it
was then without any way for a reader to tell that a further commit had shipped since — a blind
review caught the gap, not this document. Re-derive by rerunning the searches above against
whatever `origin/main` now is; when you do, update this SHA to the one you checked against, so the
next reader inherits the same one-command staleness check instead of having to re-derive every row
to discover it.

Each row is `state / producing transition / current terminal or gap / critical-path disposition`.
The disposition is this document's own judgment about whether a state belongs on the DIRECT wiring
critical path, is independent, or is blocked on something else — that judgment doesn't change with
a linked issue's open/closed status. **For what remains outstanding and who owns it, the issue
tracker is authoritative; issue numbers below are citations, not status reports** — check the
tracker itself for current state.

## Seven message states

### S1 — `TURN_CLAIMED` erased by the reply reservation

- **State:** claimed, then overwritten before any outcome is recorded.
- **Produced by:** the reply reservation (`recordResultIf` in `src/ingress/ingress-guard.ts`)
  writing `result_json` whole under an `"AVAILABLE"` precondition that `TURN_CLAIMED` satisfied,
  because the claim and the reply lifecycle shared one field.
- **Terminal:** closed. `inbound_messages` (`src/db/schema.sql`) now carries the claim in its own
  `turn_claim_json` column, separate from `result_json` — the table's own comment states why:
  *"Two lifecycles in one field is the whole defect: the reply's advanced and took the turn's with
  it. They reference each other by id now and share no storage."* `recordResultIf` no longer
  touches `turn_claim_json`, and the terminal reply transition runs through
  `completeReplyAndResolveTurn`, which commits the reply's `APPLIED` write and the claim's
  resolution (`#resolveTurnHere`, setting `repliedAt`) in one transaction. Closed by #671.
- **Disposition:** off the critical path — nothing to absorb. This row makes no claim about
  `canonical_turns` (C1) or about whether the CEO's own execution actually completed (C1's second
  half) — only that the *ingress* claim can no longer be silently erased by a reply reservation.

### S2 — many `TURN_CLAIMED` rows on one session

"Session" here, and everywhere below in this row, means the ingress `sessionDigest` —
`digestOf({channel, conversation})` (`src/ingress/telegram.ts`), the per-chat grouping key
`unresolvedTurns`/`claimTurn` key on — not `TERMINOLOGY.md`'s replaceable-model-runtime "session,"
and not a `conversational actor` either: this digest is read entirely on the ingress ledger, before
any actor binding exists (see C1, C3).

- **State:** two or more rows claimed on the same channel and `sessionDigest`, with nothing naming
  which one is "the" outstanding turn.
- **Every DIRECT turn is unresolved for the duration of its own handler call, ordinary or not —
  this is an interval claim, not a terminal one, and this row previously conflated the two.**
  `claimTurn` (`telegram-router.ts` ~550) runs and sets `turn_claim_json` with no `repliedAt`
  *before* `const directText = await this.directHandler(...)` (~564) — the external call to the
  CEO. For the entire duration of that `await`, the row is exactly what `unresolvedTurns`
  (`ingress-guard.ts` ~507, `turn_claim_json IS NOT NULL AND repliedAt IS NULL`) selects,
  whether the CEO answers in a second or hits its own timeout. What is true only *after* the
  handler returns: `CEO_CONVERSATION_TIMEOUT` is a deny (`src/mcp/ceo-conversation.ts`, on
  `McpError`'s `RequestTimeout` — "a refusal, not a hang; the peer may still be running
  server-side"), and `agentcpd.ts`'s `answerAsCeo` turns either an allow or that deny into the
  same `Promise<string>` shape; `telegram-router.ts` reports `ReasonCode.OK` regardless. The reply
  then has its own durable lifecycle: `reserveResponse` writes `PENDING` before Telegram is called;
  acceptance runs `completeReplyAndResolveTurn` and sets the claim's `repliedAt`; a permanent
  rejection or an unknown send outcome records `UNANSWERABLE` or `UNRESOLVED` and sets the claim's
  separate `settledAt`. So a slow-but-answered turn *does* sit unresolved while its handler runs,
  and stops being an outstanding claim only once the reply reaches one of those durable terminal
  states — both are true, at different times. A settled claim does not assert that Telegram
  accepted the reply.
- **Why an ordinary slow turn does not by itself produce a second unresolved row: the ingress
  check, not poll-loop seriality.** `telegram-polling.ts` now waits through admission,
  classification, and `claimTurn`, then detaches only the pending DIRECT handler that calls the
  CEO. Managed commands and owner decisions remain inside `pollOnce`; a later DIRECT update can
  reach the router while the first CEO handler is still open. Before it can claim, however, the
  DIRECT branch reads `unresolvedTurns(identity.sessionDigest)` and parks an ordinary message.
  `/again` is the explicit exception: it may claim a later turn while the first is unresolved,
  after recording every overridden nonce. This is a claim about one listener's route policy; it
  says nothing about whether two listener processes could run concurrently, which this row does
  not check. **Produced by two paths that can leave unresolved rows:** (1) a process crash before
  `reserveResponse` records the handler's reply; (2) a known retryable or batch/global rejection.
  `deliverRouteOutcome` releases those reservations to `RETRYABLE`, and the route wrapper calls
  `retryUpdate` so ordered offset advancement remains held. A 400 records `UNANSWERABLE`; an
  unknown send result records `UNRESOLVED`; and a replay of a surviving `PENDING` reservation
  records `UNRESOLVED` without another send. Each of those terminal transitions settles the claim
  in the same database transaction as the reply state.
- **Terminal or gap:** the single-unresolved-turn case is closed —
  `TelegramHermesRouter`'s DIRECT branch calls `unresolvedTurns(identity.sessionDigest)` before
  `claimTurn` for every DIRECT message (not only a suspected resend), parks with an explicit reply,
  and records a deliberate override when the owner replies `/again`. The plural
  `overriddenUnresolvedNonces` records every unresolved nonce, including a second row created when
  an earlier `/again` turn also fails. The park reply names at most
  `MAX_NAMED_UNRESOLVED_TURNS` rows, reports the total, and summarizes the rest so disclosure stays
  within Telegram's message limit without narrowing the durable override record. The production
  path tests construct both the two-row sequence and a sequence beyond the reply cap.
- **Disposition:** closed for both one and multiple unresolved rows. The rows themselves remain
  unresolved until a reply is accepted, a fresh no-reply outcome completes, a terminal delivery
  result settles it, or a later authority reconciles it. The owner-visible park reply is bounded,
  while `/again` records the full set it overrides. `UNANSWERABLE` and `UNRESOLVED` remain visible
  through Doctor, and an authenticated operator may acknowledge `NO_RETRY` without changing the
  delivery fact.
- **Rollback compatibility:** `settledAt` is a new forward-only JSON state. The `origin/main`
  reader at `8ba6e27` recognizes only `repliedAt` and `noReplyAt`, so a binary rollback after this
  version has written `settledAt` will classify that claim as unresolved and may park later turns.
  Dual-writing either older field would make a false claim about acceptance or no-reply. Roll back
  only with a data-aware compatibility release that teaches the older reader `settledAt`; a plain
  binary rollback is not safe.

### S3 — `ADMITTED` and not claimed

- **State:** let in, handler not yet run. Reachable — a crash between `admit` and `claimTurn`
  (both `src/ingress/ingress-guard.ts`), or simply the ordinary moment between the two calls in a
  live request, leaves a row with `phase: "ADMITTED"` and `turn_claim_json IS NULL`.
- **Produced by:** `isRecoverableIngressResult`/`isClaimable` (`src/ingress/ingress-guard.ts`),
  which treat exactly that state as re-admittable.
- **Terminal:** this state is not a re-execution hazard for a durable handler, by construction.
  `TelegramHermesRouter`'s DIRECT branch calls `admit`, then (after the S6 unresolved-turn check)
  `claimTurn`, and only after `claimed.allowed` does it call `directHandler` — the claim structurally
  gates every DIRECT dispatch, not a courtesy check near the handler. `claimTurn` runs its
  read-then-write as one `db.tx()`, so a second attempt on the same nonce cannot race the first; it
  is refused outright (`ReasonCode.INGRESS_TURN_OUTCOME_UNKNOWN`), asserted directly by two
  guard-level tests (`tests/unit/ingress-turn-claim.test.ts`: *"succeeds once and refuses the
  second claimer"*, *"stops the recovery path from re-admitting a claimed message"*). A message
  still sitting in `ADMITTED`-not-claimed is, by definition, one whose handler has never run —
  reaching and claiming it is the first execution, not a re-run. Closed by #635 (`claim a
  message's turn before running it, once`), which introduced `claimTurn` as a mandatory
  pre-dispatch gate.
- **Disposition:** off the critical path — nothing to absorb. The real durable-handler re-run risk
  in this codebase is a different mechanism: `prune` (`src/ingress/ingress-guard.ts`) deletes a row
  once its claim is resolved *and* its TTL has passed — deletes it entirely, not merely un-claims
  it — so a redelivery after that point is treated as genuinely new and the handler runs again
  with no record it already happened. That is tracked separately (#673), distinct from this row's
  `ADMITTED`-and-unclaimed state, which the claim gate already covers.

### S4 — permit-dead `IN_DOUBT`

- **State:** a canonical turn (`canonical_turns`, `src/db/schema.sql`) in doubt whose permit no
  longer exists.
- **Produced by:** a `ConversationTurnCoordinator` (`src/conversation/turn-coordinator.ts`)
  restart. `TurnPermit.issuance` is signed with `#issuanceKey`, generated fresh per instance and
  never persisted: *"The key is per instance and not persisted, so a permit does not survive the
  process that issued it... reconciling a turn after a restart is the reconciler's job, from a
  receipt, not a resurrected permit."*
- **Terminal:** two independent exit mechanisms exist, neither needing the dead permit, and both
  reachable only through the daemon (see C1).
  1. `resolveInDoubt` on `ConversationTurnCoordinator` (added by #669), wired to the operator
     surface as `OPERATOR_METHOD.CONVERSATION_RESOLVE` (`src/daemon/daemon.ts`) — it authenticates
     the operator's own review (`OPERATOR_AFTER_REVIEW` authority, `ABORTED`-only, with a
     `fenceAsserted` flag checked against `actor_target_attestations` where the fence can be
     verified) and, via `materialize()` (`OPERATOR_AFTER_REVIEW` is in `MATERIALIZING_AUTHORITIES`),
     clears the partial unique index (`canonical_turns_one_unresolved`) that was blocking a fresh
     claim. A person acts; nothing asks a target.
  2. `reconcileUnresolved` on `ConversationTurnCoordinator` (added by #691) — asks
     `this.#receiptPort` (the `ReceiptPort` interface, #638's seam) about every `IN_DOUBT` row and,
     for a matched receipt, settles it through `#settleFromReceipt` with no `TurnPermit` at all: a
     restart's dead permit is exactly the gap this path exists to route around. It can materialize
     `ABORTED` (authority `HERMES_TARGET`) once eight identity fields — turn, actor, prompt,
     binding generation, target binding, target attestation, executor session and incarnation —
     all match the row it settles (`ReceiptLookupResult`'s docstring: the wider field set closes a
     gap `bindingGeneration` alone leaves, where a `SURVIVED` failover moves an actor's runtime to a
     new session without advancing the generation). **It refuses every `COMPLETED` receipt
     unconditionally**, not only while today's other gaps hold: `#settleFromReceipt` denies with
     `CONVERSATION_TURN_RECEIPT_REPLY_OBLIGATION_UNDISCHARGEABLE` before any identity check runs,
     because a matched receipt is supposed to move `TURN_COMPLETED` and insert one reply-outbox
     item atomically, and nothing wired to `canonical_turns` can perform that second half yet
     (`src/outbox/outbox.ts`'s message kinds are role-to-role task dispatch, not a reply to the
     owner). `daemon.ts` calls this once at startup, fire-and-forget (`void
     this.runPeriodic("turn_reconcile", ...)`, right after `resumeQueuedRuns`/`resumeApprovedRuns`)
     and again on a periodic timer (default `turnReconcileIntervalMs` 60s, budgeted by
     `RECONCILE_SWEEP_BUDGET_MS`/`turnReconcileBudgetMs`, asserted to fit inside the interval).
  **Both mechanisms are, today, reachable code with nothing for them to act on — the
  mechanism-exists-but-unreachable state this row is required to record rather than collapse into
  either "present" or "absent."** Two independent facts hold at once, per `reconcileUnresolved`'s
  own docstring: `ConversationTurnCoordinator.claim()` — the only writer into `canonical_turns` —
  still has no caller in `src/` (C1), so every sweep runs over an empty set regardless of the port;
  and separately, `control-plane.ts` wires the coordinator's `#receiptPort` to
  `NEVER_FOUND_RECEIPT_PORT` explicitly, not left to the default, so even a populated table would
  answer `found: false` on every lookup. Both facts would have to change — a `claim()` caller and a
  real `ReceiptPort` implementation (#638) — before `reconcileUnresolved` could settle anything real,
  and even then `COMPLETED` stays refused until a reply-outbox mechanism is wired to this ledger.
- **Disposition:** neither mechanism needs absorbing into a wiring ticket — both shipped
  independently. Whether the *state* can occur in production at all is a separate question (see
  C3): `claim()` refuses every call with `CONVERSATION_TARGET_UNVERIFIED` until an
  `actor_target_bindings` row exists, so this state cannot occur in production today regardless of
  either exit mechanism now existing.

### S5 — `replacement_turn_request_id` set while still `IN_DOUBT`

- **State:** a turn naming its replacement without having ended.
- **Produced by:** nothing today. `replacement_turn_request_id` (`src/db/schema.sql`,
  `src/db/migrations.ts`) carries a foreign key back onto `canonical_turns` and an immutability
  trigger guarding it once set, but no `.ts` source outside the schema/migration definitions ever
  assigns it — confirmed by an exhaustive search
  (`grep -rn "replacementTurnRequestId\|replacement_turn_request_id"` across `src/`), not a
  sample; rerunning that search is the check.
- **Disposition:** independent. Nothing on the critical path reaches it, and it sits behind the
  same embargo as S4 and S7 (C3) before it could ever be produced.

### S6 — a different question during the window

- **State:** a new, non-duplicate message arriving while a turn is in doubt.
- **Produced by:** the owner asking something else.
- **Terminal:** closed. `TelegramHermesRouter`'s DIRECT branch calls
  `unresolvedTurns(identity.sessionDigest)` without inspecting the new message's text at all — a
  different question during the window is parked exactly like a literal resend, because the
  mechanism does not distinguish them: the reply names the earlier turn's `receivedAt`, states
  plainly that nothing was appended twice, and offers `/again <text>` regardless of what the new
  text says. The question the router asks is "is this conversation's prior turn resolved," not
  "is this the same words" — the owner, not a text comparison, decides whether to proceed. Closed
  by #680. This row assumes an unresolved turn already exists and is only about what happens to
  the *next*, separately-routed message given that precondition. It does not depend on *how* the
  earlier turn became unresolved: an ordinary in-flight turn is unresolved too (S2), and #713's
  polling path can route the second message while the first CEO handler is still pending. The
  ingress check parks that second route; it does not rely on poll-loop seriality. Terminal delivery
  failures settle the claim and do not produce this state.
- **Disposition:** off the critical path.

### S7 — a later message against a coalesced batch

- **State:** a follow-up arriving after a turn built from earlier messages has started.
- **Produced by:** `canonical_turn_sources` rows (`src/db/schema.sql`) are written inside
  `ConversationTurnCoordinator.claim` (`src/conversation/turn-coordinator.ts`) and nowhere else —
  confirmed by searching `turn-coordinator.ts` for any second writer, or any method that attaches
  a source to a turn already `IN_DOUBT`: none exists. `claim`'s own docstring still frames
  batching as something that happens once, at claim time, over `input.sources`.
- **Terminal or gap:** unchanged — a real gap. `#680` and `#671` both operate on the *ingress*
  ledger (`inbound_messages.turn_claim_json`), a different ledger from the *canonical* one
  (`canonical_turns`/`canonical_turn_sources`) this row is about (see C1), so neither touches it.
  A later message is refused twice over: not a legal extra source of a turn already in flight (no
  API adds one), and not a legal new turn either while the incumbent is `IN_DOUBT`.
- **Disposition:** on the critical path — real design work, distinct from the ingress-side parking
  #680 built. Tracked in #693. Also unreachable in production today for the same reason as S4/S5
  (C3): `claim()` refuses before it can ever accumulate sources to begin with.

## Three context facts, not states

These are facts about the system's shape, not states a message passes through — carried forward
because flattening them into a list of names would lose *why* each is load-bearing.

### C1 — the two ledgers do not meet, and a resolved reply does not mean the CEO finished

`canonical_turns` (the coordinator's ledger) and `inbound_messages.turn_claim_json` (the ingress
ledger) are separate tables with separate writers. `ConversationTurnCoordinator` is instantiated
once (`src/app/control-plane.ts`), and its read/operator/reconciliation methods (`contradictions`,
`unresolvedAcrossActors`, `resolveInDoubt`, `adjudicate`, and — added by #691 —
`reconcileUnresolved`) are called from `src/daemon/daemon.ts` — but `.claim()`, the only method
that inserts into `canonical_turns`, still has no caller anywhere in `src/` (confirmed by searching
every `.conversation.*` call site in `src/`). `src/ingress/ingress-guard.ts` says so itself, in a
comment on `UnresolvedTurn.receivedAt`: *"when `canonical_turns` gains a writer it will have
`claimed_at`."* Present tense: it still does not. `reconcileUnresolved` is a real, running
daemon-connected path — called at startup and on a periodic timer (S4) — not a hypothetical one,
and it is not the `.claim()` writer either: it only settles rows that already exist, and
`unresolvedIdentities()` (its read half) selects from `canonical_turns` the same way every other
operator method does. So the count of independent repairs to independent ledgers is now three —
S1/S2/S6's ingress fixes, `resolveInDoubt`, and `reconcileUnresolved` — not one fix reaching both
ledgers, and not two mechanisms collapsing to one: `resolveInDoubt` needs a person and settles
`ABORTED` under `OPERATOR_AFTER_REVIEW`; `reconcileUnresolved` needs a receipt and settles
`ABORTED` under `HERMES_TARGET`, refusing `COMPLETED` outright. Which is why S4, S5 and S7 remain
unreachable in production regardless of what ships on the ingress side or how many exit mechanisms
`canonical_turns` accumulates (C3) — a writer for `.claim()` is the one prerequisite none of this
touches.

**A second divergence, in the ingress ledger alone: it can mark a turn "resolved" and "answered"
while the CEO's own execution may still be running.** `answerAsCeo` (`src/daemon/agentcpd.ts`)
returns `Promise<string>` whether `port.ask` allowed or denied — a `CEO_CONVERSATION_TIMEOUT` deny
becomes an apology sentence with exactly the same shape as a real answer.
`TelegramHermesRouter` has no way to tell the two apart, reports `ReasonCode.OK`, and
`telegram-polling.ts`'s `completeResponse` resolves the turn (`completeReplyAndResolveTurn`) the
moment that sentence is accepted by Telegram. Nothing asks the CEO's `createMessage` call to stop,
and nothing later checks whether it completed, wrote into the transcript, or failed — `repliedAt`
is set regardless.

Two adjacent `Limit:` trailers on `686281a` (the commit that introduced `resolveTurn`/
`completeReplyAndResolveTurn`) record this was known at the time:

```
Limit: `resolveTurn` records that Telegram accepted the reply, which is not the CEO proving a
  durable commit — the same distinction the canonical ledger draws between `HERMES_TARGET` and
  `ACP_OBSERVED_HERMES_REPLY`, on the ingress side. A turn whose reply was accepted and whose
  CEO-side work was not durable still reads as resolved here.
Limit: this is the ingress representation, not the canonical one. #639's coordinator is meant to
  replace this seam entirely, and the shape here is chosen so the turn column can later hold the
  canonical id rather than a copy of the state.
```

A commit trailer records what was *known*; it is not, by itself, a ticket *owning* the work — the
issue tracker is authoritative on ownership, per this repository's own split of decision memory
from operational authority. #639's own text now states this scope explicitly (amended to do so),
so this divergence is tracked there rather than needing separate tracking.

### C2 — reason-code sentences for CEO unavailability keep changing, and quoting one is quoting a snapshot

`ceoUnavailableSentence` (`src/daemon/agentcpd.ts`) gives each `CEO_CONVERSATION_*` reason code its
own owner-facing sentence, and both the taxonomy and the wording have changed more than once:
`CEO_CONVERSATION_STALE`'s reason code was added before its sentence was (two separate commits);
the `CEO_CONVERSATION_TIMEOUT` sentence was rewritten to stop inviting a bare resend, in favor of
language that states only what's true without promising machinery that doesn't exist yet;
`CEO_CONVERSATION_TRANSPORT_FAILED` and `CEO_CONVERSATION_PEER_FAILED` were split out of a single
generic timeout report so a timeout, a dropped connection, and a peer-side error are no longer
folded into one code. **Any prose elsewhere that quotes one of these sentences verbatim is quoting
a snapshot** — the reliable check is reading `ceoUnavailableSentence` directly rather than trusting
a remembered wording, and a test (`gives every CEO conversation reason code its own sentence`)
already enforces the taxonomy/sentence pairing structurally.

### C3 — the embargo is an absence of a writer, not a schema guarantee

`ConversationTurnCoordinator.claim` refuses with `CONVERSATION_TARGET_UNVERIFIED` until
`actor_target_bindings` names which conversation an actor owns, and with
`CONVERSATION_TARGET_UNATTESTED` until a runtime has attested that binding. **The reason a
canonical turn is currently impossible in production is that nothing writes either table — not
that the schema would refuse an unauthenticated one.** `VerifiedTargetBinding`
(`src/session/binding-registry.ts`) is an ordinary TypeScript interface — `{executorKind,
targetLocator, targetLocatorDigest}` — with no signature or token; `BindingRegistry.bind` takes
one as a plain optional argument and, when supplied, `recordTargetBinding` inserts it into
`actor_target_bindings` exactly as the caller handed it, with no verification step in between. The
table's constraints (`UNIQUE(target_actor_id)`, `UNIQUE(executor_kind, target_locator_digest)`, an
FK to `conversational_actors`) are shape and uniqueness, not provenance — nothing in the schema can
tell an authenticated preflight bind's object apart from one a caller constructed by hand.
`actor_target_attestations` has no writer anywhere in `src/` at all; every `INSERT INTO
actor_target_attestations` in the repository is inside a test fixture, writing the row directly by
raw SQL to construct a state no production path produces.

A caller wiring up a `VerifiedTargetBinding` from an unauthenticated source — a config value, an
argv echo, an operator-typed string, exactly the routes the type's own doc comment lists as the
wrong ones to derive it from — would pass every check `bind()` and the schema run today. An
authenticated preflight bind is what would make the object honestly mean what its name claims;
until it exists, the embargo is enforced by nobody having written the caller, not by anything
refusing to accept one that lies. This is why S4, S5 and S7's states cannot occur in production
regardless of their individual mechanism status, and why their absence from any log is silence,
not confirmation of a guarantee.

## Disposition summary

**Off the critical path, nothing to absorb:** S1, S2, S3, S6 — each closed by a specific commit named
in its row, verifiable by rereading the code rather than trusting this summary.
**On the critical path, real design work:** S7 (a later message against a coalesced batch,
unreachable until the embargo lifts but real design work regardless).
**Independent, embargoed:** S4 (two exit mechanisms shipped — operator `resolveInDoubt` and
receipt-driven `reconcileUnresolved` — both currently inert: no `.claim()` writer, and
`reconcileUnresolved` additionally wired to a `ReceiptPort` that always answers `found: false`),
S5 (no writer, unreachable).
**Context, not scheduled:** C1 (two ledgers; ingress-resolves-early divergence), C2 (sentences
keep changing), C3 (embargo mechanism).

Every state's disposition is derived above from source read directly — this summary is an index
into that reasoning, not a substitute for it, and it does not carry the linked issues' current
open/closed state. Check the tracker for that.

## Re-deriving this document

No cached test, lint, or anchor-count output is reproduced here — run `pnpm typecheck`, `pnpm
lint`, `pnpm test`, `pnpm guards:anchors` and `pnpm terminology` directly; a docs-only change to
this file should move none of them. To re-check a row: re-read the functions and files it names
(all anchored by symbol, never by line number) against current `origin/main`, and re-run any
`grep` it describes as exhaustive. Where a row cites a historical commit as what closed or
introduced a state, that citation is a fact about history and does not need re-checking; where it
describes current behavior, it does.
