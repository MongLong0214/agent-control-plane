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
needed neither: they closed between the census being opened and this re-derivation.

## What closed since the census was opened, and what did not

| # | 2026-08-21 judgment | 2026-08-29 measurement | Closed by |
|---|---|---|---|
| S1 | gap — reply reservation erases the claim | **closed** | #671 |
| S2 | gap — nothing bounds one session to one claim | **closed, differently than the record on this issue says** | #680, not #671 alone |
| S3 | absorb — re-admission race for a durable handler | **unchanged, still open** | — |
| S4 | gap — no exit for a permit that died with its process | **mechanism closed; state stays unreachable** | #669, discovered independently of this task's brief |
| S5 | independent — schema state with no writer | **unchanged, still open** | — |
| S6 | gap in framing — refuses a non-resend the same as a resend | **closed** | #680 |
| S7 | gap — no API extends a turn in flight | **unchanged, still open** | — |

S2 and S4 are the two rows worth reading carefully before trusting a summary table: both have a
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

### S2 — many `TURN_CLAIMED` rows on one session — CLOSED, but not by what the issue thread says

- **State (as of 2026-08-21):** two or more rows claimed on the same channel and session digest,
  with nothing naming which one is "the" outstanding turn.
- **Produced by:** two updates admitted and claimed before either recorded an outcome. The
  ordering built into `unresolvedTurns` (`src/ingress/ingress-guard.ts`) — oldest first — reads
  as though it expects more than one live row, and nothing in `claimTurn` bounded the count.
- **The issue thread's 2026-08-29 comment attributes this closure to #671 alone**, on the same
  reasoning as S1: splitting `turn_claim_json` from `result_json` removed the crash window. That
  reasoning proves S1. It does not prove S2, and measuring it shows why: #671 closes a *crash*
  window between two writes on the *same* message. S2 is not about a crash — it is about two
  *different* messages, each claimed honestly, arriving before either turn resolves. Nothing in
  `claimTurn` (`src/ingress/ingress-guard.ts`) checks the session digest before claiming; it
  checks only `turn_claim_json IS NULL` for *that message's own row*. Two concurrent DIRECT
  messages on one conversation, arriving inside the same in-flight window #646 measured at "a
  measured 3m15s turn against a 120s inner deadline," would each claim cleanly under #671 alone —
  S2's state, reproduced, with no crash anywhere in the sequence.
- **What actually closes it:** #680 (`157aeed`), which the issue's own comment does not mention.
  `TelegramHermesRouter`'s DIRECT branch (`src/ingress/telegram-router.ts`) now calls
  `this.ingress.unresolvedTurns(identity.sessionDigest)` **before** `claimTurn`, for every DIRECT
  message, not only a suspected resend. An unresolved turn on the session parks the new message
  (`ReasonCode.INGRESS_TURN_UNRESOLVED_CONVERSATION`) instead of claiming it, so a second
  concurrent claim on one session no longer happens by accident.
- **The residual case, precisely:** the owner can still produce two unresolved claims on one
  session — by replying `/again <text>` to the park notice. That path is deliberate: the claim
  carries `overriddenUnresolvedNonce` (`TurnIdentity`, `src/ingress/ingress-guard.ts`) naming
  which earlier turn the owner knowingly ran alongside. So the *state* S2 described (multiple
  unresolved claims, ambiguous which is "the" one) is no longer produced silently; it is produced
  only on an explicit, recorded choice, which is exactly the distinction the original row asked
  for when it said *"the design in #641 assumes exactly one."* #680 does not enforce "exactly
  one" — it enforces "exactly one, unless the owner said otherwise and that is on the record."
- **Disposition:** closed for the critical path. Worth a correction on the issue thread: the
  2026-08-29 comment's attribution to #671 is measurably incomplete.

### S3 — `ADMITTED` and not claimed — unchanged, still open

- **State:** let in, handler not yet run.
- **Produced by:** a crash between `admit` and `claimTurn` (both `src/ingress/ingress-guard.ts`).
  `admit` writes `phase: "ADMITTED"`, and `isRecoverableIngressResult` / `isClaimable`
  (`src/ingress/ingress-guard.ts`) are exactly the predicates that treat that state as
  re-admittable.
- **Measured now:** unchanged. `isClaimable`'s own comment still states the mechanism plainly:
  *"Claiming what recovery would otherwise re-run is the whole mechanism: after the claim the
  same reader sees a state it will not re-run, so the handler cannot execute twice."* Nothing
  about the admit/claim split changed across #671 or #680 — both touched the claimed side of the
  lifecycle, not the pre-claim recovery path.
- **Terminal:** re-admitted and claimed on the next poll. Correct for a handler that only formats
  a reply; still the re-execution hazard for one that writes durably, same as the original row
  said.
- **Disposition:** absorb. Named by the claim mechanism itself — this state is the reason
  `claimTurn` exists, and it is still reachable exactly as described.

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
  distinct from the ingress-side parking #680 built. No open ticket names it directly today; the
  nearest is #641 (closed — its resend framing is what named the gap, per the original census)
  and the #638/#639 reconciliation work this whole mechanism sits behind. Flagging that gap here
  is this document doing the job the disposition summary asks for: naming what a future DIRECT
  wiring ticket has to pick up, since nothing currently open is titled for it.

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
- `CEO_CONVERSATION_STALE` itself is a distinct reason code (session rotated under failover, added
  by #654/`f2497ec`, 2026-08-21) with its own sentence: *"The CEO role moved to a new session...
  Nothing was asked of either; send the message again."* That one *does* invite a resend,
  correctly — nothing was asked the first time, so there is no duplicate to create. #654's own
  message is explicit that this and the #643 fix are two of the same shape found the same day:
  *"#633 removed a claim the seam could not observe, #643 removed an invitation that was itself
  the duplicate path, and this is the last one"* (the third being `CEO_CONVERSATION_BUSY`'s
  sentence).
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

### C3 — the embargo still makes S4, S5 and S7 unreachable, and "no occurrences observed" is still not evidence about them

`ConversationTurnCoordinator.claim` refuses with `ReasonCode.CONVERSATION_TARGET_UNVERIFIED` until
`actor_target_bindings` names which conversation an actor owns, and with
`ReasonCode.CONVERSATION_TARGET_UNATTESTED` until a runtime has attested that binding — both gated
behind the #638 authenticated preflight bind, which is still open (`state: OPEN`, measured
2026-08-29). `src/db/schema.sql` and `src/db/migrations.ts` state the embargo is structural, not
only behavioral: *"authenticated preflight bind can produce them. Admission fails closed at the
schema."* #657 (merged — reconstitution reuses the actor a verified target names) closed Part A of
#649 since the census opened, chipping at the machinery around the embargo — but #638 itself
remains open, so `claim()` still cannot mint the incumbent that S4, S5 and S7 are all states *of*.
The reasoning still holds: their absence from any log is silence, not confirmation.

## Disposition summary

**Closed, nothing to absorb:** S1, S2, S6.
**Absorb — real work, still open:** S3, S7.
**Independent, still open, embargoed by #638:** S5.
**Mechanism closed independently (#669); state stays embargoed by #638:** S4.
**Context, carried but not scheduled:** C1 (unchanged), C2 (citation corrected, underlying point
holds), C3 (unchanged; #638 still open).

Cross-references for the still-open gaps: S3 and S7 are the residual ingress/canonical-ledger
work; #638 (open) and #639 (open) are the reconciliation tickets both sit behind. #672 (open —
a claimed turn whose handler returns no reply is never resolved) and #673 (open — a resolved row
is pruned before a late redelivery can arrive) are adjacent gaps this same code surfaced along
the way; they are not additional numbered states here because neither is a state distinct from
S3's claim/recovery mechanism — #672 and #673 are, respectively, what happens after a claim
resolves with no reply and what happens after a resolved row's TTL expires. They are tracked on
their own issues rather than folded into this census, consistent with the disposition rule this
document is following: a gap gets its own ticket, and this document points at it rather than
becoming a second source of truth for it.

## Verification

Measured on an unmodified checkout of `origin/main` at `157aeed` before writing this document,
and unchanged by writing it (docs-only):

- `pnpm typecheck` — clean.
- `pnpm lint` — clean.
- `pnpm test` — `1404 passed | 9 failed | 2 skipped`, all nine failures in
  `tests/unit/deploy-launchd.test.ts`, matching the environment-specific shape #680's own PR
  description records (`1396 passed / 9 failed / 2 skipped` at that point in history; the passed
  count has grown with intervening merges, the nine failures have not changed in kind).
- `pnpm guards:anchors` — `RESULT: PASS`, `115 anchor(s) still match, exactly once each`.

Every code citation in this document was located by symbol name or by a quoted comment fragment,
re-`grep`ed against `157aeed` while writing this file — not carried forward from the original
issue's line numbers.
