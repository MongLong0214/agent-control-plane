# A census of the states an owner message can be in (#660)

A reference, not a work item. It exists so a change touching the DIRECT ingress path — the
route an owner's Telegram message takes from `TelegramLongPollListener` through `IngressGuard`
and `TelegramHermesRouter` to a CEO turn — can be checked against the full state list instead of
whatever subset the last PR happened to exercise.

**Re-derived against `origin/main` at `157aeed` (2026-08-29), not transcribed from the issue.**
The first version cited `telegram-router.ts:551-558` and `ingress-guard.ts:420-424`; both regions
have since been rewritten by merged PRs, and a line-number citation would now point at whatever
moved into that line rather than failing visibly. Every locus below is named by symbol or by a
quoted, `grep`-able comment fragment instead, per the rule #597 states for exactly this reason:
*"a renamed symbol makes the search return nothing, and nothing is a visible failure."*

Each row is `state tuple / producer transition / current terminal or gap / critical-path
disposition`, as the original census defined it. Where a row's judgment still holds, this
document says so — confirming a row is as valuable as overturning one, and three of the seven
needed neither: S1 and S6 closed between the census being opened and this re-derivation, and S3
(unlike this document's own first pass on it) was never actually open to begin with. S2 looked
like a fourth on an earlier pass of this document and is not — a review found the "closed"
verdict itself wrong, and it is written up in full below as the reminder that this document's own
claims need the same check as the issue's.

**Every row below states which commit or code path would have closed it, and whether one
already did — including the rows that stayed open.** A row's own re-derivation is not complete
just because it repeats the original verdict; S3 is the case in this document's own history where
skipping that check for an "open" row carried a defect forward rather than catching one.

## What closed since the census was opened, and what did not

| # | 2026-08-21 judgment | 2026-08-29 measurement | Closed by |
|---|---|---|---|
| S1 | gap — reply reservation erases the claim | **closed** | #671 |
| S2 | gap — nothing bounds one session to one claim | **still open — #680 discloses/records only the single oldest unresolved turn, a second one silently accumulates** | partially narrowed by #680, not closed |
| S3 | absorb — re-admission race for a durable handler | **never actually a hazard — the original verdict was backwards** | #635, merged *before* the census's own baseline |
| S4 | gap — no exit for a permit that died with its process | **mechanism closed; state stays unreachable** | #669, discovered independently of this task's brief |
| S5 | independent — schema state with no writer | **checked, unchanged, still open** | — (no writer exists to close it) |
| S6 | gap in framing — refuses a non-resend the same as a resend | **closed** | #680 |
| S7 | gap — no API extends a turn in flight | **checked, unchanged, still open — now ticketed** | #693 (filed by this re-derivation) |

S2, S3 and S4 are the rows worth reading carefully before trusting a summary table: each has a
richer story than "closed" or "open" captures, and it is given in full below.

## Seven message states

### S1 — `TURN_CLAIMED` erased by the reply reservation — CLOSED

- **State (as of 2026-08-21):** claimed, then overwritten before any outcome is recorded.
- **Produced by:** the reply reservation (`recordResultIf` in `src/ingress/ingress-guard.ts`)
  writing `result_json` whole under an `"AVAILABLE"` precondition that `TURN_CLAIMED` satisfied,
  because the claim and the reply lifecycle shared one field.
- **Measured now:** `src/db/schema.sql`'s `inbound_messages` table carries the claim in its own
  `turn_claim_json` column, separate from `result_json`. The table's own comment states the
  reason: *"Two lifecycles in one field is the whole defect: the reply's advanced and took the
  turn's with it. They reference each other by id now and share no storage."* `recordResultIf`
  (`src/ingress/ingress-guard.ts`) no longer touches `turn_claim_json` at all, and the terminal
  reply transition runs through `completeReplyAndResolveTurn`, which commits the reply's
  `APPLIED` write and the claim's resolution (`#resolveTurnHere`, setting `turn_claim_json`'s
  `repliedAt`) in one transaction — closing the window a prior review found between the two.
- **Closed by:** #671 (`686281a`). Confirmed independently by reading the current schema and
  guard, not merely by trusting the issue's own comment.
- **Disposition:** no longer on the critical path — nothing to absorb.
- **Path traced:** `schema.sql`'s `inbound_messages` definition (the `turn_claim_json` column and
  its comment), `ingress-guard.ts`'s `recordResultIf`, `#resolveTurnHere` and
  `completeReplyAndResolveTurn` — all read directly, and `686281a`'s diff confirmed the same. Not
  traced beyond the ingress ledger: this row makes no claim about `canonical_turns` (see C1) or
  about whether the CEO's own execution actually completed (see C1's second half) — only that the
  *ingress* claim can no longer be silently erased by a reply reservation.

### S2 — many `TURN_CLAIMED` rows on one session — OPEN, narrower than originally described, and not closed by #680

**"Session" in this row, and everywhere below it uses the word loosely, means the ingress
`sessionDigest` — `digestOf({channel, conversation})` (`src/ingress/telegram.ts`), a per-chat
grouping key `unresolvedTurns` and `claimTurn` key on. It is not `TERMINOLOGY.md`'s "session" (the
replaceable model runtime a role is bound to), and it is not a `conversational actor` either —
this digest exists and is read entirely on the ingress ledger, before any actor binding exists
(see C1, C3). Where this document quotes a production string that uses "session" in
`TERMINOLOGY.md`'s confirmed sense — C2's `CEO_CONVERSATION_TIMEOUT`/`STALE` sentences, both
about the CEO's bound runtime — it is quoted verbatim and marked as a quote, not asserted as this
document's own usage.**

- **State (as of 2026-08-21):** two or more rows claimed on the same channel and session digest,
  with nothing naming which one is "the" outstanding turn.
- **Produced by:** two updates admitted and claimed before either recorded an outcome. The
  ordering built into `unresolvedTurns` (`src/ingress/ingress-guard.ts`) — oldest first — reads
  as though it expects more than one live row, and nothing in `claimTurn` bounded the count.
- **The issue thread's 2026-08-29 comment attributes this closure to #671 alone**, on the same
  reasoning as S1: splitting `turn_claim_json` from `result_json` removed the crash window. That
  reasoning proves S1. It does not prove S2, and reading the code shows why: #671 closes a
  *crash* window between two writes on the *same* message. S2 is not about a crash — it is about
  two *different* messages, each claimed honestly, arriving before either turn resolves. Nothing
  in `claimTurn` (`src/ingress/ingress-guard.ts`) checks the session digest before claiming; it
  checks only `turn_claim_json IS NULL` for *that message's own row*.
- **A review found the scenario this row previously cited here does not occur.** An earlier
  version of this paragraph cited #646's *"a measured 3m15s turn against a 120s inner deadline"*
  as an example of an in-flight window a second claim could land inside. Traced end to end, an
  ordinary CEO turn — timed out or not — does not stay unresolved for anything like that long,
  because a timeout is not silence:
  ```
  ceo-conversation.ts ~243   McpError(RequestTimeout) → deny(CEO_CONVERSATION_TIMEOUT, …) —
                             a refusal, not a hang; the peer may still be running server-side
  agentcpd.ts ~1256         answerAsCeo: `if (answered.allowed) return answered.value; return
                            ceoUnavailableSentence(...)` — deny or allow, the return type is
                            the same Promise<string>, indistinguishable to the caller
  agentcpd.ts ~1515        production wiring: onDirect: (input) => answerAsCeo(ceoConversation,
                           input.text)
  telegram-router.ts ~564  const directText = await this.directHandler(...); … outcome with
                           ReasonCode.OK — a timeout apology is a successful DIRECT outcome
  telegram-polling.ts ~462 reserveResponse(outcome) → sendMessage(outcome.reply) →
                           completeResponse(outcome) on success, calling
                           completeReplyAndResolveTurn — the claim resolves the moment the
                           reply is accepted by Telegram, independent of whether the CEO's own
                           `createMessage` call ever actually finished
  ```
  So a slow turn that hits the CEO port's own budget is answered with a sentence and resolved
  immediately once that sentence is sent — it does not sit as an unresolved claim for the
  duration of the external turn, and #646's 3m15s figure describes a pre-#671 world where the
  reply reservation *overwrote* the claim (S1), not a window a second claim could race into
  today. That citation is dropped rather than corrected in place, since nothing replaces it as a
  *slow-turn* mechanism for reaching S2 — there is not one.
- **What does leave a row genuinely unresolved without a full process crash, traced through the
  same file:** `telegram-polling.ts`'s `pollOnce` (~462–472) calls `reserveResponse` before every
  Telegram send and `completeResponse` — the only call that sets `repliedAt` — only after
  `sendMessage` succeeds. If `sendMessage` throws, `completeResponse` never runs, the claim stays
  unresolved, and the exception propagates out of `pollOnce` to `loop()` (~498–510), which
  catches it, calls `onError`, waits `retryDelayMs`, and polls again — the daemon process
  survives and keeps running. So a Telegram delivery failure — not a crash, not a slow CEO turn,
  and not simulated by any test here — is a second, real, code-verified path to an unresolved
  claim, alongside the process-crash path `TelegramInterruption` simulates. Whether the CEO
  answered instantly or timed out is irrelevant to this path; what matters is whether Telegram
  accepted the reply.
- **What actually closes the common case:** #680 (`157aeed`), which the issue's own comment does
  not mention. `TelegramHermesRouter`'s DIRECT branch (`src/ingress/telegram-router.ts`) now calls
  `this.ingress.unresolvedTurns(identity.sessionDigest)` **before** `claimTurn`, for every DIRECT
  message, not only a suspected resend — a direct reading of the current source, not an
  inference. What is *not* directly tested is the concurrent case: all three of #680's own
  tests (`tests/unit/telegram-ingress.test.ts`, "parks a resend...", "does not park a DIRECT
  message from an unrelated conversation", "/again lets the owner...") construct the unresolved
  row by having a poller throw `TelegramInterruption` (simulating a process crash) and then a
  *second, later* listener process the next update — none of them use the delivery-failure path
  above, and none start two claims genuinely concurrently in one live process. The
  park-before-claim check itself does not read `result_json` or anything that would distinguish
  "unresolved because of a crash" from "unresolved because Telegram never confirmed delivery" —
  both are just `turn_claim_json IS NOT NULL AND repliedAt IS NULL` — so the same code path
  should cover the delivery-failure case too. That is this document's inference from the guard's
  SQL, not a claim the test suite backs for either producing mechanism.
- **This document's previous round called this "closed" and that was wrong — a real, minimal
  sequence still reaches S2's state with an undisclosed second claim.** `/again` was checked as a
  single-shot override and it is not one. Both places the router touches an unresolved list read
  only its first element:

  ```
  telegram-router.ts ~526   const unresolved = this.ingress.unresolvedTurns(identity.sessionDigest);
                            if (unresolved.length > 0 && !overridesUnresolved) { … park, name
                            unresolved[0] only … }
  telegram-router.ts ~549   const overriddenUnresolvedNonce = unresolved[0]?.nonce;
  ```

  Walk the sequence Sol's review named:

  ```
  A     crashes (TelegramInterruption) → unresolved, oldest on the session
  /again→B   owner overrides; claim records overriddenUnresolvedNonce = A's nonce (unresolved[0])
  B     also crashes → now unresolved too. Session has TWO unresolved rows: A, B.
  C     arrives (an ordinary message, no /again)
        unresolvedTurns(sessionDigest) returns [A, B], oldest first
        oldest = unresolved[0] = A
        park reply: "an earlier message … is still unresolved (received {A.receivedAt})"
        — singular, names only A. B is never mentioned.
  ```

  If the owner now sends `/again` for C, `overriddenUnresolvedNonce = unresolved[0]?.nonce` is
  still **A's** nonce — the code has no way to reach B, because it never looks past index 0. C's
  claim is recorded as a deliberate override of A. B is not named on C's claim, not disclosed in
  any reply the owner sees, and not distinguishable from an ordinary crash nobody chose to run
  alongside. At this point the session carries (at least) three claimed rows — A, B, C — under
  exactly the ambiguity the original row described: multiple `TURN_CLAIMED` rows exist and nothing
  names which one is "the" outstanding turn beyond the single oldest one. #680 makes the *first*
  override explicit and recorded; it does not make a *second* one visible, because
  `unresolvedTurns`'s full result is computed but only its head is ever read.
- **No test exercises this, on either side of the guard.** The production round trip
  (`tests/unit/telegram-ingress.test.ts`, *"/again lets the owner deliberately run a second turn
  over an unresolved one, and records the choice"*, ~808) constructs exactly one unresolved turn
  (`A`) and its overriding handler (`B`) returns a reply immediately rather than crashing — `B`
  resolves, so the test never reaches a state with two simultaneously unresolved rows, and never
  sends a third message. The guard-level test that does construct two unresolved claims directly
  (`tests/unit/ingress-turn-claim.test.ts`, *"returns the oldest first, because that is the one
  unanswered longest"*, ~269) calls `claimTurn` on the guard twice with two identities, bypassing
  the router entirely, and asserts only the ordering `unresolvedTurns` returns — it does not go
  through `TelegramHermesRouter`, does not check what a third arrival's park reply would name, and
  does not check what a third `/again` would record. Neither test is the sequence above; nothing
  in the suite is.
- **Disposition:** open, narrower than the original row. The common case — one prior unresolved
  turn, one park, one disclosed and recorded override — is real and #680 built it correctly; that
  part is closed. What remains open is the shape above: `unresolvedTurns`'s result is truncated to
  its first element at both read sites, so a second (or later) unresolved row sharing that
  conversation's `sessionDigest` is never surfaced to the owner and never named on any claim,
  silently reproducing "the design assumes exactly one" one layer past where #680 addressed it.
  Filed as **#695**
  (*"A repeated `/again` names and records only the oldest unresolved turn, so a second one
  accumulates silently"*), not embargoed and not dependent on #638/#639/#693 — it is live on the
  ingress ledger today and testable with the existing harness. `docs/ROADMAP.md`'s C4 item 7 is
  corrected alongside this row rather than left claiming S2 closed.
- **Path traced:** `claimTurn`, `unresolvedTurns`, and both `telegram-router.ts` read sites
  (`~526`, `~549`) for the disclosure gap; `ceo-conversation.ts` (~243), `agentcpd.ts` (~1256,
  ~1515), `telegram-router.ts` (~564) and `telegram-polling.ts` (~462–510) for ruling out a slow
  turn as a producing mechanism and establishing a Telegram delivery failure as a real one instead.
  **Not traced, and stated as such above rather than assumed:** whether a delivery failure has
  ever actually occurred in this deployment's history, and whether two such failures on one
  session have ever coincided — this row asserts the code *permits* the state, not that it has
  been *observed*. The crash-based reproduction (`TelegramInterruption`) is what the test suite
  exercises; the delivery-failure reproduction is read from source only.

### S3 — `ADMITTED` and not claimed — CLOSED, and its "open" verdict was backwards

- **State:** let in, handler not yet run. Still reachable — a crash between `admit` and
  `claimTurn` (both `src/ingress/ingress-guard.ts`), or simply the ordinary moment between the
  two calls in a live request, leaves a row with `phase: "ADMITTED"` and `turn_claim_json IS
  NULL`.
- **Produced by:** the same reachable moment the original row named. `isRecoverableIngressResult`
  / `isClaimable` (`src/ingress/ingress-guard.ts`) are exactly the predicates that treat that
  state as re-admittable, unchanged.
- **This row was wrong, not merely stale, and it was wrong at the moment it was written.** The
  original text called the terminal state "the re-execution hazard for one that writes durably,"
  and this document's first pass repeated that verdict without checking it against the code path
  that actually dispatches the handler — the same check applied to S1/S2/S4/S6 and skipped here.
  Doing that check: `TelegramHermesRouter`'s DIRECT branch (`src/ingress/telegram-router.ts`)
  calls `this.ingress.admit(...)`, then (after classification and the S6 unresolved-turn check)
  `this.ingress.claimTurn(...)`, and only *after* `claimed.allowed` is true does it
  `await this.directHandler(...)`. The claim is not a courtesy check performed near the handler —
  it structurally gates every DIRECT dispatch. `claimTurn` (`src/ingress/ingress-guard.ts`) runs
  the read-then-write as one `db.tx()`, so a second attempt to claim the same nonce cannot
  observe the pre-claim state and race the first; it is refused outright
  (`ReasonCode.INGRESS_TURN_OUTCOME_UNKNOWN`). Two tests exercise exactly this at the guard level:
  *"succeeds once and refuses the second claimer"* and *"stops the recovery path from re-admitting
  a claimed message"* (`tests/unit/ingress-turn-claim.test.ts`), the second asserting the specific
  case S3 is about — a message `isRecoverableIngressResult` would treat as re-admittable is
  refused the moment it is *also* already claimed.
- **So "ADMITTED and not claimed" cannot be a re-execution hazard for a durable handler, by
  construction:** the handler runs only after a successful claim, a successful claim can happen
  at most once per nonce, and a message still sitting in "ADMITTED, not claimed" is, by
  definition, one whose handler has never run yet — reaching it and claiming it *is* the first
  (and only) execution, not a re-run. This document's own quote of `isClaimable`'s comment two
  paragraphs up already said as much — *"Claiming what recovery would otherwise re-run is the
  whole mechanism: after the claim the same reader sees a state it will not re-run, so the
  handler cannot execute twice"* — and the previous draft of this row asserted the opposite
  conclusion in the same breath. That contradiction, not a code change, is the defect a review
  caught.
- **What closed it, and when:** `0d12bf2` (#635, *"claim a message's turn before running it,
  once"*), merged **2026-08-20 18:34** — the day before this issue's own "normalized 2026-08-21"
  text was written, and the commit that introduced `claimTurn` as a mandatory pre-dispatch gate in
  the first place. The original census's S3 was describing a hazard that had already been
  designed out before the census existed to describe it; this document's first pass inherited
  that error rather than checking #635 against it.
- **Disposition:** closed — nothing to absorb. The reachable state itself (a transient or
  crash-truncated `ADMITTED`-not-claimed row) is ordinary and safe; the concern the original row
  attached to it does not hold under the claim-before-dispatch ordering that predates this
  census.
- **Path traced:** `telegram-router.ts`'s DIRECT branch, in order — `admit` → S6's unresolved
  check → `claimTurn` → `directHandler` — read directly to confirm the ordering; `claimTurn`'s
  `db.tx()` read directly for the serialization claim; `0d12bf2`'s diff read directly for the
  closing commit. `isRecoverableIngressResult`/`isClaimable` read directly for what makes a row
  re-admittable. Not traced beyond the DIRECT path specifically: whether every non-Telegram or
  non-DIRECT ingress path also claims before dispatch is not asserted here.

### S4 — permit-dead `IN_DOUBT` — mechanism closed, state stays unreachable

- **State:** a canonical turn (`canonical_turns`, `src/db/schema.sql`) in doubt whose permit no
  longer exists.
- **Produced by:** a `ConversationTurnCoordinator` (`src/conversation/turn-coordinator.ts`)
  restart. `TurnPermit.issuance` is signed with `#issuanceKey`, generated fresh
  (`randomUUID()`) per instance and never persisted — the type's own comment says why: *"The key
  is per instance and not persisted, so a permit does not survive the process that issued it.
  That is the right lifetime rather than a limitation... reconciling a turn after a restart is
  the reconciler's job, from a receipt, not a resurrected permit."*
- **This is the one row where re-derivation found something the task brief did not name.** The
  2026-08-21 "confirmed" comment on this issue judged S4 unreachable-and-uncleared: *"none
  reachable... it means an incumbent can exist that nothing in the current design clears."* That
  was accurate the day it was written. It stopped being accurate the next day: #669 (`73328c0`,
  2026-08-22, merged *before* #671 and well before the 2026-08-29 "S3–S7 still accurate" comment)
  added `resolveInDoubt` to `ConversationTurnCoordinator`, wired to the operator surface as
  `OPERATOR_METHOD.CONVERSATION_RESOLVE` (`src/daemon/daemon.ts`). Its doc comment names this
  exact state: *"The permit is signed with a key that dies with the coordinator instance, so a
  turn held across a restart has no settler... Doctor reports `CANONICAL_TURN_IN_DOUBT` and names
  no command, which is the shape the operator door was built to remove."* `resolveInDoubt` does
  not need the dead permit — it authenticates the operator's own review (`OPERATOR_AFTER_REVIEW`
  authority, `ABORTED`-only, with a `fenceAsserted` flag checked against
  `actor_target_attestations` where the fence can be verified) and clears the partial unique
  index (`canonical_turns_one_unresolved`) that was blocking a fresh claim.
- **What is still true, and why "closed" alone would overclaim:** `canonical_turns` still has no
  production writer (see C1 below) — `claim()` (`src/conversation/turn-coordinator.ts`) refuses
  every call with `ReasonCode.CONVERSATION_TARGET_UNVERIFIED` until an `actor_target_bindings` row
  exists, which needs the #638 preflight bind. So the *state* S4 describes cannot occur in
  production today, embargo intact — but the *mechanism gap* the row was reporting (nothing
  clears it once it exists) is gone. The census's most recent comment, written 2026-08-29,
  asserts S4 "재확인 결과 여전히 정확" (accurate on reconfirmation) without mentioning #669 at all;
  measured against the code, that assertion is itself stale by a week.
- **Disposition:** the mechanism no longer needs absorbing into a wiring ticket — it shipped
  independently. The reachability question (C3, #638) is unchanged and belongs there, not here.
- **Path traced:** `resolveInDoubt`'s full body, `MATERIALIZING_AUTHORITIES`'s set contents, and
  `73328c0`'s diff — all read directly, plus `OPERATOR_METHOD.CONVERSATION_RESOLVE`'s wiring in
  `daemon.ts`. The reachability half rests on `claim()`'s `CONVERSATION_TARGET_UNVERIFIED` refusal
  (C3) rather than being re-derived here. Not traced: whether `resolveInDoubt` has ever actually
  been invoked outside a test — like S2's delivery-failure path, this is "the mechanism exists and
  is wired to an operator command," not "an operator has used it."

### S5 — `replacement_turn_request_id` set while still `IN_DOUBT` — unchanged, still open

- **State:** a turn naming its replacement without having ended.
- **Produced by:** nothing today. `replacement_turn_request_id` (`src/db/schema.sql`,
  `src/db/migrations.ts`) is a column with a foreign key back onto `canonical_turns` and an
  immutability trigger guarding it once set — but no `.ts` source outside the schema/migration
  definitions ever assigns it.
- **Measured now:** confirmed unchanged by search — the symbol appears only in `schema.sql`,
  `migrations.ts` (three CREATE TABLE generations plus the immutability trigger), and nowhere in
  `src/conversation/turn-coordinator.ts` or any router. A schema state with no writer, exactly as
  the original row said.
- **Disposition:** independent, as before. Nothing on the critical path reaches it, and like S4
  it sits behind the same #638 embargo before it could ever be produced.
- **Path traced:** an exhaustive symbol search (`grep -rn "replacementTurnRequestId\|replacement_turn_request_id"`)
  across `src/`, not a sample — this is an absence claim, checkable by rerunning the same search
  rather than by tracing a path. The embargo half is inherited from C3, not re-derived here.

### S6 — a different question during the window — CLOSED

- **State:** a new, non-duplicate message arriving while a turn is in doubt.
- **Produced by:** the owner asking something else. The original row's complaint was that
  `claimTurn` refused *any* second turn — resend or not — under one reason code, which reads as
  though the design assumed every second message was a duplicate of the first.
- **Measured now:** `TelegramHermesRouter`'s DIRECT branch (`src/ingress/telegram-router.ts`)
  calls `unresolvedTurns(identity.sessionDigest)` **without inspecting the new message's text at
  all**. A different question during the window is parked exactly like a literal resend would
  be — the mechanism does not distinguish them, and does not need to: the reply names the earlier
  turn's `receivedAt`, states plainly that nothing was appended twice, and offers `/again <text>`
  regardless of what the new text says. That is the framing gap closed: the router no longer
  treats "is this the same words" as the question. The question is "is this conversation's prior
  turn resolved," and the owner — not a text comparison — decides whether to proceed anyway.
- **Closed by:** #680 (`157aeed`).
- **Disposition:** no longer on the critical path.
- **Path traced:** the DIRECT branch's `unresolvedTurns` call and its lack of any text comparison,
  read directly. This row assumes an unresolved turn already exists on the session and is only
  about what happens to the *next* message given that precondition — it does not depend on, and
  is not affected by, the S2 correction to how that precondition arises (crash or delivery
  failure, not a slow turn).

### S7 — a later message against a coalesced batch — unchanged, still open

- **State:** a follow-up arriving after a turn built from earlier messages has started.
- **Produced by:** `canonical_turn_sources` rows (`src/db/schema.sql`) are written inside
  `ConversationTurnCoordinator.claim` (`src/conversation/turn-coordinator.ts`) and nowhere else.
- **Measured now:** unchanged. `#680` and `#671` both operate on the *ingress* ledger
  (`inbound_messages.turn_claim_json`) — a different ledger from the *canonical* one
  (`canonical_turns` / `canonical_turn_sources`) this row is about (see C1). Searching
  `turn-coordinator.ts` for any second writer of `canonical_turn_sources`, or any method that
  attaches a source to a turn already `IN_DOUBT`, finds none. `claim`'s own docstring still frames
  batching as something that happens once, at claim time, over `input.sources`. This is also why
  this row, like S4 and S5, is unreachable in production today (C3): `claim()` refuses before it
  can ever accumulate sources to begin with.
- **Disposition:** absorb, as originally dispositioned — this is real design work still to do,
  distinct from the ingress-side parking #680 built. No open ticket owned it at the time of this
  re-derivation: #641 (closed) named the framing gap on the ingress side only; #666 (open) is
  about the integrity of sources `claim()` is *handed*, not about adding one *after* claim time;
  #639 (open) is about receipt-matched completion, not about extending a turn's inputs while it
  runs. Filed as **#693** (*"A later message cannot join a canonical turn's batch or start its own
  while the incumbent is IN_DOUBT"*), with the state tuple, producing transition, terminal/gap and
  the ticket-coverage argument above written into its body rather than left as a placeholder — the
  rule this document itself states two sections down (a gap gets its own ticket) applies to its
  own rows, not only to the ones it is reporting on.
- **Path traced:** `ConversationTurnCoordinator.claim`'s body and the search for a second writer
  of `canonical_turn_sources` — both read directly. The unreachability claim is inherited from C3
  (`CONVERSATION_TARGET_UNVERIFIED`), not independently re-derived here.

## Three context facts, not states

Carried forward because flattening them into a list of names would lose exactly the part that
makes each one load-bearing: *why* it is a fact about the system rather than a state a message
passes through.

### C1 — the two ledgers still do not meet

`canonical_turns` (the coordinator's ledger) and `inbound_messages.turn_claim_json` (the
ingress ledger) are separate tables with separate writers, and #671/#680 only ever touched the
second. Measured now: `ConversationTurnCoordinator` is instantiated once, in
`src/app/control-plane.ts`, and its read/operator methods (`contradictions`,
`unresolvedAcrossActors`, `resolveInDoubt`, `adjudicate`) are called from
`src/daemon/daemon.ts` — but `.claim()`, the only method that inserts into `canonical_turns`, has
no caller anywhere in `src/`. `src/ingress/ingress-guard.ts` says so itself, in a comment on
`UnresolvedTurn.receivedAt`: *"when `canonical_turns` gains a writer it will have `claimed_at`."*
Present tense: it still does not. This is why S4's mechanism fix (#669) and S1/S2/S6's ingress
fixes (#671, #680) are independent repairs to independent ledgers, not one fix reaching both —
and why S4, S5 and S7 remain unreachable in production regardless of what ships on the ingress
side.

**A second, related divergence, found while re-checking S2: the ingress ledger can mark a turn
"resolved" and "answered" while the CEO's own execution may still be running.** `answerAsCeo`
(`src/daemon/agentcpd.ts` ~1256) returns `Promise<string>` whether `port.ask` allowed or denied —
a `CEO_CONVERSATION_TIMEOUT` deny (`src/mcp/ceo-conversation.ts` ~243, on `McpError`'s
`RequestTimeout`) becomes an apology sentence with exactly the same shape as a real answer.
`TelegramHermesRouter` (`src/ingress/telegram-router.ts` ~564) has no way to tell the two apart —
both are just a string returned from `directHandler` — so it reports `ReasonCode.OK`, and
`telegram-polling.ts`'s `completeResponse` (~466) resolves the turn (`completeReplyAndResolveTurn`)
the moment that sentence is accepted by Telegram. Nothing here asked the CEO's `createMessage`
call to stop, and nothing observes whether it later completes, writes into the transcript, or
fails — the ingress ledger's `repliedAt` is set regardless. This is the same family as the fact
above — a ledger recording a state the thing it describes has not actually reached — but it is a
different pair than `canonical_turns`/`inbound_messages`: here it is the ingress ledger against
the CEO's own execution, which no table in this schema observes at all. Not one of the seven
states (it is a transition, in the shape C2 already named for a different sentence), and not
embargoed — it is live in production behavior today, on the same path S2 traced.

**This question turned out to be two questions, and answering them with one source was itself the
mistake.** `docs/ACCEPTANCE.md:3` and this repository's PRD split two authorities that do not
overlap: **what was decided, known, or ruled out** — the commit record is authority for that,
independent of what an issue's prose later says; and **what remains to be done, and who owns
it** — the *issue tracker* is authority for that, and a commit trailer recording a limitation is
not, by itself, a ticket owning the work.

Two adjacent `Limit:` trailers on `686281a` (the commit that introduced
`resolveTurn`/`completeReplyAndResolveTurn`) answer the first question — this consequence was
*known* at #671's merge:

```
Limit: `resolveTurn` records that Telegram accepted the reply, which is not the CEO proving a
  durable commit — the same distinction the canonical ledger draws between `HERMES_TARGET` and
  `ACP_OBSERVED_HERMES_REPLY`, on the ingress side. A turn whose reply was accepted and whose
  CEO-side work was not durable still reads as resolved here.
Limit: this is the ingress representation, not the canonical one. #639's coordinator is meant to
  replace this seam entirely, and the shape here is chosen so the turn column can later hold the
  canonical id rather than a copy of the state.
```

That much held from the moment this row was written and was never in question. What was wrong
was treating the second trailer's *intent* ("meant to replace this seam entirely") as already
*answering* the ownership question — an unticketed intent in a trailer is not the same thing as a
tracked commitment, and closing #696 on the trailer alone put outstanding work back exactly where
`docs/ACCEPTANCE.md:3` forbids it living: in a document (or a commit message) instead of the
tracker.

**Resolved by making the tracker true rather than routing around it: #639's issue body was
amended** to state this scope in its own text — that it owns the ingress reply lifecycle
(`completeReplyAndResolveTurn`/`repliedAt`), not only the canonical ledger's three contracts —
quoting `686281a`'s trailers as the evidence that this was already known, not as the source of the
commitment itself. With that amendment, #639 is a real ticket for this consequence, and #696 is
now correctly closed as a duplicate of tracked work rather than of a trailer.

**Path traced:** for the first half, `.claim()`'s absence of any caller (`grep -rn "\.conversation\b" src/`,
exhaustive, not sampled) and `daemon.ts`'s four operator-method call sites, all read directly. For
the second half, the same `answerAsCeo`/`ceo-conversation.ts`/`telegram-router.ts`/
`telegram-polling.ts` chain S2 traces, plus `686281a`'s full trailer set read directly via
`git log -1 --format=%B` and cross-checked with `git interpret-trailers --parse` — not the MCP
CommitLore index, which returned zero records for both `src/ingress/ingress-guard.ts` and
`src/db/schema.sql` with an explicit diagnostic that the zero was uninformative (no matching blob
in its walked history), and a repo-wide query returned two unrelated records from what appears to
be a different repository entirely. The commit's own embedded trailers, read directly with plain
`git`, were the reliable source here, not the indexing tool. The ownership question was settled by
reading `docs/ACCEPTANCE.md:3` and this repository's PRD statement that CommitLore is decision
memory, not operational authority, against how #696 had actually been closed — a re-read of policy
already on file, not a new code path.

### C2 — the sentence the original C2 cited has since been rewritten twice more, and no longer says what C2 quoted

The original census attributed *"it may have written part of an answer to the conversation
already — check there before asking again"* to `CEO_CONVERSATION_STALE` in
`src/daemon/agentcpd.ts`, calling it "a transition that produces S1/S2, not a state" and judging
it "correct as a sentence."

Measured now, both halves need correcting, and the timeline is worth being exact about because
it shows the citation was stale on arrival, not merely stale by 2026-08-29:

- That sentence was never `CEO_CONVERSATION_STALE`'s — `ceoUnavailableSentence`
  (`src/daemon/agentcpd.ts`) shows it belonged to `CEO_CONVERSATION_TIMEOUT`. And by the time this
  issue's "normalized 2026-08-21" text quoted it as the live sentence, it was already gone: commit
  `97f5d0a` (#643, "the timeout sentence stops asking the owner to resend," 2026-08-20 20:44 — the
  evening *before* the 2026-08-21 normalization) rewrote it in one pass, its own message naming
  three corrections landed in that single commit: *"It said 'Nothing was lost; ask again.' The
  first correction was that this seam cannot see whether anything was lost... (#633). The second
  is that 'ask again' is not advice — it is a mechanism... (#641). The third came from the CEO's
  judgement on #641: the automatic path is held and the owner keeps an explicit way through."* The
  "check there" wording this issue's C2 quotes is not findable in that commit or after it — the
  three corrections replaced "Nothing was lost" with the current framing directly, in one commit,
  the day before C2's own text was normalized.
- The comment above the current `CEO_CONVERSATION_TIMEOUT` text names the failure a version like
  C2's would have repeated anyway: *"an earlier draft said a later message 'is held rather than
  run', and the gate that would hold it does not exist yet (#641). That sentence would have been
  false in the other direction... a blind review caught it before it shipped."* The sentence today
  reads: *"The CEO session has not answered yet. Its turn is unresolved rather than abandoned...
  Sending the same message again starts a second turn rather than retrying this one."* That does
  not invite a resend; it warns against treating one as a retry — the opposite framing from what
  C2 quoted.
- `CEO_CONVERSATION_STALE` itself is a distinct reason code (session rotated under failover) with
  its own sentence: *"The CEO role moved to a new session... Nothing was asked of either; send the
  message again."* That one *does* invite a resend, correctly — nothing was asked the first time,
  so there is no duplicate to create. **This document's previous round attributed STALE's
  addition to #654/`f2497ec` and that is wrong** — checked by reading each commit's diff rather
  than trusting its file list, the actual sequence is three separate commits: `7b5490f` (#601,
  2026-08-19) adds the bare reason-code constant `CEO_CONVERSATION_STALE` to `reason-codes.ts`
  with no sentence yet; `1285e81` (#634, 2026-08-20 18:17) adds the dedicated sentence quoted
  above, with its own commit message naming the defect it fixed — *"A stale binding was reported
  as an undeliverable answer. `STALE` had no sentence and fell through to 'answered with something
  this route cannot deliver'... Found by the third test here, which requires every
  `CEO_CONVERSATION_*` code to have its own sentence."* `f2497ec` (#654, 2026-08-21 07:23, *after*
  `1285e81`) does not touch `STALE` at all — its own message is about a different code
  entirely: *"The BUSY sentence still told the owner to resend. This is the third copy of that
  shape: #633 removed a claim the seam could not observe, #643 removed an invitation that was
  itself the duplicate path, and this is the last one"* — "this" is `CEO_CONVERSATION_BUSY`'s
  sentence, not `STALE`'s, and the quote was misapplied in the previous round.
- `CEO_CONVERSATION_TRANSPORT_FAILED` and `CEO_CONVERSATION_PEER_FAILED` did not exist as reason
  codes at all when C2 was written; #681 (`3136292`, "a CEO conversation failure says which side
  failed," merged 2026-08-29 closing issue #633 — which had stayed open since 2026-08-20 for
  exactly this taxonomy work even after `97f5d0a`'s wording fix) split them out of the single
  generic timeout report. `CEO_CONVERSATION_TIMEOUT` used to run for every `createMessage`
  rejection; now each shape gets its own code and sentence. This is why no verbatim match for C2's
  quoted sentence exists anywhere in the current file — it never covered five distinguishable
  failures under one wording, and does not today either, but for the opposite reason: there are
  now five sentences where C2 remembers one.
- **Still correct, unchanged:** the underlying point C2 was making — that this is a transition
  producing a state, not a state itself — holds regardless of which reason code says it, or how
  many now exist. It is just not the reason code, nor the wording, the original row named.
- **Path traced:** every commit named in this row (`97f5d0a`, `7b5490f`, `1285e81`, `f2497ec`,
  `3136292`) by its own diff, listed in full in the Verification section's commit table below —
  not by title or message alone, after this row's own history of getting that wrong twice.

### C3 — the embargo still makes S4, S5 and S7 unreachable, but not for the reason this document first gave

`ConversationTurnCoordinator.claim` refuses with `ReasonCode.CONVERSATION_TARGET_UNVERIFIED` until
`actor_target_bindings` names which conversation an actor owns, and with
`ReasonCode.CONVERSATION_TARGET_UNATTESTED` until a runtime has attested that binding. Both
refusals are real and directly verified by reading `claim()`. **The conclusion this document drew
from them — a canonical turn is currently impossible in production — is correct. The reason this
document first gave for it was wrong, and wrong in the dangerous direction: it said the schema
enforces the embargo, and it does not.**

The first pass here quoted `src/db/schema.sql`'s own comment — *"authenticated preflight bind can
produce them. Admission fails closed at the schema"* — as if that were a verified mechanism. It is
the schema's claim about itself, not a checked fact, and reading the code that actually produces
these rows contradicts it:

- `VerifiedTargetBinding` (`src/session/binding-registry.ts`) is an ordinary TypeScript interface
  — `{ executorKind, targetLocator, targetLocatorDigest }` — with no signature, token, or any
  other field a schema constraint could check for authenticity. `BindingRegistry.bind` takes one
  as a plain, optional constructor argument (`BindInput.verifiedTarget`) and, when supplied,
  `recordTargetBinding` inserts it into `actor_target_bindings` **as the caller handed it**: no
  verification step sits between the argument and the `INSERT`.
  `src/db/schema.sql`'s `actor_target_bindings` table constraints are `UNIQUE (target_actor_id)`,
  `UNIQUE (executor_kind, target_locator_digest)`, and a foreign key to
  `conversational_actors` — shape and uniqueness, not provenance. Nothing in the schema can tell
  an authenticated preflight bind's object apart from one a caller constructed by hand.
- `actor_target_attestations` has **no writer anywhere in `src/`** — confirmed by search; every
  `INSERT INTO actor_target_attestations` in the repository is inside a test fixture
  (`tests/unit/adjudicating-a-disagreement.test.ts`, `doctor-sees-the-canonical-ledger.test.ts`,
  `an-unresolved-turn-has-an-operator-exit.test.ts`, and others), each writing the row directly by
  raw SQL to construct a fixture, not through any production code path. There is no "authority
  trigger" refusing an unauthorized write, because there is no writer, authorized or not, to
  refuse.
- **#666 (open) already says this in as many words**, in a section titled "Related, and not fixed
  by either": *"The activation embargo is not a schema constraint. `bind()` accepts an
  unauthenticated verified-target object, and the attestation table has no authority trigger and
  no production writer. The honest statement is that the schema constrains shape, not provenance —
  the embargo is the absence of a writer. Anything claiming otherwise in a comment or a commit
  message is wrong and should be corrected where it appears."* This document's first pass was
  exactly the kind of artifact that sentence warns about — it quoted the wrong comment as though
  quoting it made it checked.

**What actually holds the embargo today:** no production code path calls `bind()` with a
populated `verifiedTarget`, and no production code path writes `actor_target_attestations` at
all. `claim()`'s refusals are real and will keep firing as long as that remains true — but that is
a fact about what nothing currently does, not a fact about what the schema would stop someone from
doing. A caller wiring up a `VerifiedTargetBinding` from an unauthenticated source — a config
value, an argv echo, an operator-typed string, exactly the routes `VerifiedTargetBinding`'s own
doc comment lists as the wrong ones to derive it from — would pass every check `bind()` and the
schema run today. The #638 authenticated preflight bind is what would make the object honestly
mean what its name claims; until it exists, the embargo is enforced by nobody having written the
caller, not by anything refusing to accept one that lies.

#657 (merged — reconstitution reuses the actor a verified target names) closed Part A of #649
since the census opened, touching how an existing binding is reused, not how one is authenticated
or produced — it does not change any of the above. #638 remains open, so the state persists: no
production writer exists for either table, `claim()` therefore still cannot mint the incumbent
that S4, S5 and S7 are all states *of*, and their absence from any log is silence, not
confirmation of anything the schema enforces.

**Path traced:** `BindingRegistry.bind`, `recordTargetBinding`, `VerifiedTargetBinding`'s
definition, `claim()`'s two refusal branches, and an exhaustive grep for
`INSERT INTO actor_target_attestations` across the repository (eleven hits, all under
`tests/unit/`) — all read directly, plus `f1cdde9`'s diff for `VerifiedTargetBinding`'s origin.
This traces *that* nothing writes these tables in production; it does not trace every possible
future call site, and the note in the row above about a caller wiring one up unauthenticated is a
structural argument from the schema's constraints, not an enumeration of every way it could
happen.

## Disposition summary

**Closed, nothing to absorb:** S1, S3 (never actually a hazard; closed by #635 before this
census's own baseline), S6.
**Absorb — real work, still open:** S2 (**#695**, filed from this re-derivation — narrower than
the original row, but genuinely open, not embargoed), S7 (**#693**, filed from this
re-derivation).
**Independent, still open, embargoed by #638:** S5.
**Mechanism closed independently (#669); state stays embargoed by #638:** S4.
**Context, carried but not scheduled:** C1's first half (the two ledgers not meeting —
unchanged), C2 (citation corrected, underlying point holds), C3 (mechanism corrected — the
embargo is an absence of a writer, not a schema guarantee; #638 still open).
**Context that turned out to be outstanding work, now tracked in an existing ticket's own text:**
C1's second half — the ingress ledger resolving a turn on a timeout apology — was known at
`686281a` but not previously *owned* by any ticket's own text; **#639's body was amended** to
state this scope explicitly, and #696 (filed, then briefly closed on the trailer alone, which was
itself wrong) now stays closed as a genuine duplicate of that tracked commitment.

Cross-references for the still-open gaps: S2 is **#695** (*"A repeated `/again` names and records
only the oldest unresolved turn, so a second one accumulates silently"*) — a review found this
document's earlier "closed" verdict wrong: `unresolvedTurns`'s full result is read only at index
0 by both the park reply and the override record in `telegram-router.ts`, so a second unresolved
row on one session is never disclosed or named once one override has already been made. Not
embargoed; live and testable today. S7 is **#693** (*"A later message cannot join a canonical
turn's batch or start its own while the incumbent is IN_DOUBT"*), filed by this re-derivation
because no existing ticket owned it — #641 (closed) named only the ingress-side framing gap,
#666 (open) covers source integrity at claim time rather than adding a source after it, and #639
(open) covers receipt-matched completion rather than extending a turn's inputs while it runs.
#638 (open) and #639 (open) are the reconciliation tickets #693 sits behind, alongside S4 and
S5's reachability. C1's second half is **not** a separate ticket: **#696** was filed for it, then
closed once on `686281a`'s commit trailers alone (wrong — a trailer records what was *known*, not
who *owns* the outstanding work, and `docs/ACCEPTANCE.md:3` makes the tracker the authority on the
latter), then correctly closed after **#639's own body was amended** to state this scope in its
own text rather than leaving the commitment implicit in a trailer.

**The durable-handler re-execution risk the original S3 misattributed is real, and already has
its own ticket: #673.** `prune` (`src/ingress/ingress-guard.ts`) deletes a row once its claim is
resolved (`turn_claim_json`'s `repliedAt` is set) *and* its TTL has passed — deletes it entirely,
not merely un-claims it. A redelivery after that point finds no row at all, `admit` treats it as
genuinely new, and it is claimed and run again with no record that it already happened. That is
the actual shape of a re-run S3's wording gestured at, correctly assigned to #673 (open) rather
than to S3's `ADMITTED`-and-unclaimed state, which the claim gate already covers. #672 (open — a
claimed turn whose handler returns no reply is never resolved, so it is never eligible for that
same prune path) is the adjacent gap on the other side of the same mechanism. Every still-open
gap in this census — S2, S4/S5's reachability, S7, and the real re-execution risk in #673 — now
resolves to a ticket rather than to this document alone, which is the rule `docs/ACCEPTANCE.md:3`
states and this document was at risk of breaking for S2 and S7 until #695 and #693 were filed. C1's
second half took three passes to land correctly: a ticket (#696) was filed for it, closed once on
the belief that `686281a`'s trailer alone settled ownership (wrong — a trailer is decision memory,
not the tracker), and closed correctly only after **#639's own body was amended** to state the
scope in its own text. The rule was right every time; what moved was which source answers which
half of it.

## Verification

Measured on an unmodified checkout of `origin/main` at `157aeed` before writing this document,
and unchanged by writing it (docs-only):

- `pnpm typecheck` — clean.
- `pnpm lint` — clean.
- `pnpm test` — `1442 passed | 9 failed | 2 skipped` (measured on this round; `1404 passed` on an
  earlier round of this same branch, before two unrelated upstream merges landed on it), all nine
  failures in `tests/unit/deploy-launchd.test.ts`, matching the environment-specific shape #680's
  own PR description records (`1396 passed / 9 failed / 2 skipped` at that point in history; the
  passed count keeps growing with intervening merges, the nine failures have not changed in kind).
- `pnpm guards:anchors` — `RESULT: PASS`, `119 anchor(s) still match, exactly once each` (count
  has moved twice, from 115, as unrelated upstream merges landed on this branch — see below).
- `pnpm terminology` — `9 enforced rules over 119 files, 0 violations, 0 waived`.

Every code citation in this document was located by symbol name or by a quoted comment fragment,
re-`grep`ed against `157aeed` while writing this file — not carried forward from the original
issue's line numbers.

**Corrected after independent review, five times so far — the count below is itself append-only,
not a final tally.** An xhigh read-only review of this document (21
files) returned two findings, both accepted: S2's "closed" claim originally implied more than any
test in this repository exercises — no test constructs two genuinely concurrent, non-crash
claims on one session, only the crash/restart reconstruction #680's own tests use — and that
section now says so explicitly rather than calling it proven. And S7 named a gap with no owning
ticket, which `docs/ACCEPTANCE.md:3`'s rule forbids; #693 was filed to close that, with the state
tuple, producing transition, and ticket-coverage argument written into its body.

A second review of the fixed commit found S3's verdict was backwards: it called
`ADMITTED`-and-unclaimed "the re-execution hazard for one that writes durably," when
`claimTurn` (`src/ingress/ingress-guard.ts`) is called strictly before the handler dispatches
(`src/ingress/telegram-router.ts`) and is transactionally serialized, so that state cannot
produce a re-run — closed by `0d12bf2` (#635), merged 2026-08-20, the day *before* this issue's
own baseline. The review also asked for the same "which commit closed this" check to be applied
to every row still marked open; S5 and S7 were re-checked and confirmed genuinely open — no
writer for `replacement_turn_request_id` exists anywhere, and (as then described) no second
writer of `canonical_turn_sources` exists on `main` either. That sweep also located the real
re-execution risk S3's wording had been gesturing at: it is #673's prune-then-late-redelivery
path, not S3's state, and the disposition summary above now says so.

A third review found C3 got its conclusion right (a canonical turn is currently impossible in
production) from the wrong mechanism: this document had quoted `schema.sql`'s own comment —
*"Admission fails closed at the schema"* — as though the schema enforced the embargo, when
`VerifiedTargetBinding` (`src/session/binding-registry.ts`) is an ordinary caller-supplied object
`bind()` writes into `actor_target_bindings` with no authenticity check, and
`actor_target_attestations` has no production writer at all — every insert into it in the
repository is a test fixture writing raw SQL directly. #666 (open) already states this outcome in
its own words: *"the schema constrains shape, not provenance — the embargo is the absence of a
writer."* C3 now says that, with the two code reads behind it, rather than quoting the schema's
claim about itself. This is the same failure shape as S3, one level more subtle: S3 stated a false
conclusion, C3 stated a true conclusion resting on a mechanism that does not produce it. The same
"name the mechanism, confirm it does the work" check was then re-applied to every remaining claim
in the document (S1's atomic transaction, S2's early-return ordering, S4's
`MATERIALIZING_AUTHORITIES`/`materialize()` path that actually clears `IN_DOUBT`, S5/S7's writer
absence, C1's caller absence) — each was already backed by a direct code read rather than a quoted
comment, and none needed a further correction **at that pass**. Round four, below, found that
"the mechanism is real" and "the mechanism closes the state" are not the same check, and S2's
early-return ordering had only had the first one done.

**A fourth review found two more of this same general shape, one in S2 and one in this
Verification log itself.**

*S2 was reopened.* The third round's sweep confirmed `unresolvedTurns`'s early-return ordering is
real — a direct code read — but stopped at confirming the mechanism exists, not at confirming it
covers every reachable case. It does not: `telegram-router.ts` reads only `unresolved[0]` at both
the park site and the override-recording site, so a *second* unresolved row on one session (an
overriding `/again` that itself fails to resolve) is never disclosed to the owner and never named
on any claim. The reproduction needs no concurrency, only two ordinary crashes:
`A` crashes → unresolved; owner sends `/again` → `B` claimed, recorded as overriding `A`; `B` also
crashes → now `A` and `B` are both unresolved; a third message `C` arrives and its park reply
names only `A` (`unresolved[0]`), never `B`. Neither existing test reaches this: the production
`/again` test (`tests/unit/telegram-ingress.test.ts` ~808) resolves its override turn instead of
crashing it, so only one unresolved row ever exists; the guard-level ordering test
(`tests/unit/ingress-turn-claim.test.ts` ~269) constructs two unresolved claims directly on the
guard, bypassing the router, and checks only ordering. S2's row above now says this in full and
is marked open; filed as **#695**. `docs/ROADMAP.md`'s C4 item 7 no longer claims S2 closed.

*The `1bd1b81` description in round two, above, was itself wrong* — inferred from the fact that
the commit touches `turn-coordinator.ts`, not from reading its diff. Reading the diff: `1bd1b81`
adds two validation checks *inside* the existing `claim()` — an attestation-freshness join against
`actor_target_bindings`/`assignments`, and a check that every source's channel/nonce was actually
admitted into `inbound_messages` before `claim()` accepts it (both closing halves of #666's own
findings). It touches neither `replacement_turn_request_id` nor the `INSERT INTO
canonical_turn_sources` statement, which is unchanged. The conclusion round two drew — S5 and S7
stay open on `main` regardless, and `1bd1b81`'s unmerged status (`git merge-base --is-ancestor
1bd1b81 157aeed` → false) was checked correctly — was never wrong; only the description of what
the commit *contains* was invented rather than read, corrected above in round two's own paragraph
rather than left standing next to a retraction.

**A fifth review found the previous round's own completeness claim was the same shape again**:
"none of the other citations rested on an inferred description; `1bd1b81` was the one case" was
itself a sweep result asserted as fact without the sweep having covered everything the word "the
only one" claims. It also missed a real second case: C2's attribution of `CEO_CONVERSATION_STALE`
to `#654`/`f2497ec` was wrong (see C2 above, corrected) — the sentence was invented by
misapplying a quote from `f2497ec`'s message about a different reason code (`BUSY`), a citation
error of the same kind as `1bd1b81`'s.

So rather than assert a count again, here is the complete, checkable list: every commit hash this
document cites, and whether the claim attached to it was confirmed by reading that commit's own
diff (`git show <sha>`) as opposed to a commit message, a current-source read, or an inference
from which files it touches.

| Commit | Cited for | Diff read? |
|---|---|---|
| `686281a` (#671) | S1 — `turn_claim_json` split, `completeReplyAndResolveTurn` | yes — confirms the column and the split |
| `157aeed` (#680, this branch's base) | S2/S6 — `unresolvedTurns` read only at `unresolved[0]`, park/override, `overridesUnresolved` | yes — confirms the exact `unresolved[0]` line S2 turns on |
| `0d12bf2` (#635) | S3 — `claimTurn` added before handler dispatch | yes |
| `73328c0` (#669) | S4 — `resolveInDoubt`, `MATERIALIZING_AUTHORITIES`, `OPERATOR_METHOD.CONVERSATION_RESOLVE` | yes |
| `97f5d0a` (#643) | C2 — `CEO_CONVERSATION_TIMEOUT`'s sentence rewritten, removed line matches C2's quote verbatim | yes |
| `7b5490f` (#601) | C2 — bare `CEO_CONVERSATION_STALE` constant added, no sentence yet | yes |
| `1285e81` (#634) | C2 — `CEO_CONVERSATION_STALE`'s dedicated sentence added | yes |
| `f2497ec` (#654) | C2 — fixes `CEO_CONVERSATION_BUSY`'s sentence; does **not** touch `STALE` (this document's previous round said it did — corrected above) | yes, on this round |
| `3136292` (#681) | C2 — adds `CEO_CONVERSATION_TRANSPORT_FAILED` and `CEO_CONVERSATION_PEER_FAILED` | yes, on this round (previously read via the PR body only) |
| `f1cdde9` (#657) | C3 — introduces `VerifiedTargetBinding`; its own message states nothing produces one yet | yes |
| `1bd1b81` (unmerged `#666` branch) | S5/S7 — confirmed to add validation checks inside `claim()`, not a new writer (this document's earlier round said it added one — corrected above) | yes, on this round |

Eleven commit citations, all now read by diff rather than by title, message, or file list alone.
That is a complete list for this document as it stands today, not a claim that no future edit can
introduce another inferred one — the next person adding a citation owes it the same check, and
"was this diff actually opened" is now the standing question for any commit hash this document
names.

**A sixth round: CI, not a semantic review, caught a real ambiguity a review had passed.**
`pnpm terminology` (CI job `verify-terminology`) flagged a sentence in S2's disposition — the
phrase paired "the same" with "session," describing a row as sharing one — under its
`session-identity-continuity` rule: `session` described as something that stays the same, which
`TERMINOLOGY.md` reserves for a `conversational actor`, not a `session` (a replaceable model
runtime). Checked which sense was meant by reading how
`sessionDigest` is built (`digestOf({channel, conversation})`, `src/ingress/telegram.ts`) and
what S2 actually asserts: the ingress ledger's grouping key for "these rows are the same
conversation," entirely pre-actor-binding (C1/C3) — neither the runtime-session sense nor the
conversational-actor sense `TERMINOLOGY.md` is policing. Substituting `conversational actor` into
the sentence does not hold — no conversational actor is reachable from the ingress ledger at all
today — confirming this is a homonym, not the forbidden usage. Rather than suppress the check with
`terminology-ok`, the sentence was reworded to name `sessionDigest` directly and drop the
ambiguous phrase, and a disambiguation note was added at the top of S2 (this document's heaviest
concentration of the word) stating explicitly which sense is meant everywhere below it, and that
the two places this document quotes production text using the *confirmed* `TERMINOLOGY.md` sense
(C2's `CEO_CONVERSATION_TIMEOUT`/`STALE` sentences, both correctly about the CEO's bound runtime)
are quotes, not this document's own usage. A full sweep of every remaining "session" occurrence
in the file found no other match for the check's patterns and no other case of the two senses
being conflated; `pnpm terminology` now reports `0 violations, 0 waived`.

**A seventh round found S2's disposition assumed a producing mechanism production does not have.**
S2 (and the "3m15s turn" citation specifically) implied an ordinary slow CEO turn leaves a row
unresolved long enough for a second claim to land beside it. Traced end to end — `ceo-conversation.ts`'s
timeout deny, `agentcpd.ts`'s `answerAsCeo` collapsing allow/deny into the same `Promise<string>`,
`telegram-router.ts` reporting `ReasonCode.OK` for a timeout apology, `telegram-polling.ts`
calling `completeResponse` immediately once Telegram accepts that reply — a slow turn is
*answered* and its row *resolves*, so it never reaches `unresolvedTurns` at all. That citation is
retracted rather than repaired, since no slow-turn mechanism replaces it. In its place: a
Telegram delivery failure (`sendMessage` throwing inside `pollOnce`) is a second, real,
code-verified path to a genuinely unresolved row, distinct from the crash path every test in the
suite uses — `loop()` catches the exception and keeps polling, so the process survives while the
claim stays open. Separately, tracing this surfaced a fact worth keeping regardless of S2: the
ingress ledger resolves a turn the moment Telegram accepts *any* reply, including a timeout
apology, with no way to tell whether the CEO's own execution actually finished — appended to C1
as its own paragraph rather than folded into S2's fix. Finally, applying the same "which path did
I trace, which am I implying" question to every row added an explicit **Path traced** statement to
each of S1–S7 and C1–C3, naming what was read directly versus inherited from another row versus
not checked at all.

**An eighth round settled a judgement call the seventh round's C1 addition left open: fact or
outstanding item?** Read #638 and #639 in full to check whether either already states the
consequence C1's second half describes. Neither does — both are scoped to the canonical ledger's
receipt-matching mechanism, and neither claims an intent to gate the *ingress* ledger's
resolution on it once built, so closing them would not obviously close this. That makes it an
outstanding item by the same test that produced #693 and #695, not a fact this document could
carry on its own — filed as **#696**, and C1 now states which judgement applies and why, so a
later reader does not have to redo it.

**A ninth round found the eighth round's own judgement was wrong — tested against the wrong
source.** The eighth round checked #638's and #639's *issue bodies* and, finding neither stated
the ingress consequence, filed #696. What it did not check was the *commit record*: `686281a`'s
own `Limit:` trailers, which this repository treats as decision authority independent of an
issue's later prose. Read directly (`git log -1 --format=%B 686281a`, cross-checked with
`git interpret-trailers --parse`, since the MCP CommitLore index returned zero records for both
`ingress-guard.ts` and `schema.sql` with a diagnostic that the zero was uninformative — no
matching blob in its walked history — and a repo-wide query surfaced two records from what
appears to be an unrelated repository, not this one): two adjacent trailers on the commit that
introduced `resolveTurn`/`completeReplyAndResolveTurn` name this exact consequence and then record
`#639`'s coordinator as "meant to replace this seam entirely" — a broader claim than #639's issue
body makes. That reverses the eighth round's conclusion: this is a fact already owned by #639, not
an untracked outstanding item. #696 is closed as a duplicate, with the correction stated on the
issue and here in C1, including that filing it was encouraged on the same incomplete reading this
round corrected.

**A tenth round found the ninth round's conclusion was itself wrong, on the same question a third
time — this one reversing round nine, not merely refining it.** Round nine closed #696 on the
strength that `686281a`'s trailer "records #639... as owning its replacement" and treated that as
settling *ownership*. It does not: `docs/ACCEPTANCE.md:3` and this repository's PRD (CommitLore is
decision memory, not operational authority) split the question round nine answered with one
source into two that need different ones — **what was known** (the commit record answers this;
round nine's reading of the trailers was correct and stands) and **what is tracked, and by whom**
(only the issue tracker answers this; a trailer is not a ticket, however clearly it names an
intent). Round nine's error was answering the second question with evidence for the first. The
fix was not a third reading of the same two sources — it was making the tracker true: **#639's
issue body was amended** to state the ingress scope in its own text, with `686281a`'s trailers
cited in the amendment as evidence the consequence was already known, not as the grounds for
closure. #696 stays closed, but now as a duplicate of a real ticket rather than of a trailer's
intent. Reopening #696 (the safer, immediate option offered) was not needed because the more
thorough option — making #639 state its own scope — was doable cleanly: #639 is this repository's
own ticket, its existing text was extended rather than overwritten, and the amendment is
attributed to this census's finding rather than presented as though #639 always said this.

Re-ran `pnpm typecheck`, `pnpm lint`, `pnpm guards:anchors` and `pnpm terminology` after every edit
across all ten rounds — all still pass. Did not re-run `pnpm test` this round: the edit was prose
and one issue-tracker amendment, not a `src/` change, so the `1442 passed | 9 failed | 2 skipped`
measurement from the seventh round stands.

**On the rounds themselves.** This one question — is C1's second half a fact or outstanding work —
took three rounds to land: round eight said outstanding and filed #696; round nine said fact and
closed #696 on a trailer; round ten said outstanding-but-now-tracked and closed #696 on an amended
#639. Round eight's sources supported its conclusion at the time; round nine's did not — it had a
source (`docs/ACCEPTANCE.md:3`'s own split of authority) that was available all along and was not
checked. That is the actual lesson, stated plainly rather than left to infer: reversing a
conclusion on a better source is not the same act as reversing one because a check was skipped,
and this document had one of each in two consecutive rounds. Both are corrections; only one of
them means the previous round's method was sound and the ground moved. Any reader treating a
"settled" judgement in this document as final should weigh it against how many sources were
actually checked, not against how many rounds have already passed.
