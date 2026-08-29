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
historical fact — those commits do not change. What is *not* a fact that survives rereading is a
pinned "current source" SHA: this was last re-derived 2026-08-29 against `origin/main` merged into
this branch. Re-derive by rerunning the searches and rereading the functions each row names against
whatever `origin/main` is when you read this; where this document and the code disagree, the code
is right and this document is what has gone stale.

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
- **Produced by two paths, of different strength.** (1) A process crash before
  `completeResponse`/`reserveResponse` ever run — what every existing test
  (`TelegramInterruption`) simulates. (2) A Telegram delivery failure:
  `telegram-polling.ts`'s `pollOnce` calls `reserveResponse` before every send and
  `completeResponse` — the only call that sets `repliedAt` — only after `sendMessage` succeeds; if
  it throws, the claim stays unresolved and the exception is caught by `loop()`, which logs it via
  `onError` and keeps polling — the daemon process survives. Neither is a slow CEO turn: a
  `CEO_CONVERSATION_TIMEOUT` deny (`src/mcp/ceo-conversation.ts`, on `McpError`'s `RequestTimeout`
  — "a refusal, not a hang; the peer may still be running server-side") becomes, via
  `agentcpd.ts`'s `answerAsCeo`, an apology string with the same `Promise<string>` shape as a real
  answer; `telegram-router.ts` reports `ReasonCode.OK` for it, and the reply resolves the instant
  Telegram accepts it. A slow-but-answered turn never reaches `unresolvedTurns` at all — it does
  not sit unresolved for the duration of the external call.
- **Terminal or gap:** the single-unresolved-turn case is closed —
  `TelegramHermesRouter`'s DIRECT branch calls `unresolvedTurns(identity.sessionDigest)` before
  `claimTurn` for every DIRECT message (not only a suspected resend), parks with an explicit reply,
  and records a deliberate override (`overriddenUnresolvedNonce`) when the owner replies `/again`.
  **A second unresolved row is neither disclosed nor recorded.** Both the park reply and the
  override write read only `unresolved[0]` — the oldest row. Reproducible with two ordinary
  crashes, no concurrency required: `A` crashes (unresolved); owner sends `/again`, claiming `B`
  and recording the override against `A`; `B` also crashes (now `A` and `B` are both unresolved); a
  third message `C` arrives and its park reply names only `A` — `B` is never mentioned, and a
  further `/again` from the owner would again record only `A`. No test reaches this: the
  production `/again` test resolves its override turn instead of crashing it, so only one
  unresolved row is ever constructed; the guard-level test that does construct two unresolved
  claims bypasses the router and only checks ordering.
- **Disposition:** on the critical path. The single-turn mechanism is closed; the disclosure gap
  for a second unresolved row is real, live on the ingress ledger today (not embargoed by #638),
  and tracked in #695.

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
- **Terminal:** the mechanism gap is closed. `resolveInDoubt` on `ConversationTurnCoordinator`
  (added by #669), wired to the operator surface as `OPERATOR_METHOD.CONVERSATION_RESOLVE`
  (`src/daemon/daemon.ts`), does not need the dead permit — it authenticates the operator's own
  review (`OPERATOR_AFTER_REVIEW` authority, `ABORTED`-only, with a `fenceAsserted` flag checked
  against `actor_target_attestations` where the fence can be verified) and, via `materialize()`
  (`OPERATOR_AFTER_REVIEW` is in `MATERIALIZING_AUTHORITIES`), clears the partial unique index
  (`canonical_turns_one_unresolved`) that was blocking a fresh claim.
- **Disposition:** the mechanism no longer needs absorbing into a wiring ticket — it shipped
  independently. Whether the *state* can occur in production at all is a separate question (see
  C3): `claim()` refuses every call with `CONVERSATION_TARGET_UNVERIFIED` until an
  `actor_target_bindings` row exists, so this state cannot occur in production today regardless of
  the exit mechanism now existing.

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
  the *next* message given that precondition — it does not depend on S2's producing mechanism
  (crash or delivery failure, not a slow turn).
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
once (`src/app/control-plane.ts`), and its read/operator methods (`contradictions`,
`unresolvedAcrossActors`, `resolveInDoubt`, `adjudicate`) are called from `src/daemon/daemon.ts` —
but `.claim()`, the only method that inserts into `canonical_turns`, has no caller anywhere in
`src/` (confirmed by searching every `.conversation.*` call site in `src/`). `src/ingress/
ingress-guard.ts` says so itself, in a comment on `UnresolvedTurn.receivedAt`: *"when
`canonical_turns` gains a writer it will have `claimed_at`."* Present tense: it still does not.
S1/S2/S6's ingress fixes and S4's mechanism fix are independent repairs to independent ledgers,
not one fix reaching both — which is why S4, S5 and S7 remain unreachable in production regardless
of what ships on the ingress side (C3).

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

**Off the critical path, nothing to absorb:** S1, S3, S6 — each closed by a specific commit named
in its row, verifiable by rereading the code rather than trusting this summary.
**On the critical path, real design work:** S2 (the second-unresolved-row disclosure gap), S7 (a
later message against a coalesced batch, unreachable until the embargo lifts but real design work
regardless).
**Independent, embargoed:** S4 (mechanism closed, state unreachable), S5 (no writer, unreachable).
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
