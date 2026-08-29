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
document says so — confirming a row is as valuable as overturning one, and four of the seven
needed neither: they closed between the census being opened and this re-derivation, or (S3) were
never actually open to begin with.

**Every row below states which commit or code path would have closed it, and whether one
already did — including the rows that stayed open.** A row's own re-derivation is not complete
just because it repeats the original verdict; S3 is the case in this document's own history where
skipping that check for an "open" row carried a defect forward rather than catching one.

## What closed since the census was opened, and what did not

| # | 2026-08-21 judgment | 2026-08-29 measurement | Closed by |
|---|---|---|---|
| S1 | gap — reply reservation erases the claim | **closed** | #671 |
| S2 | gap — nothing bounds one session to one claim | **closed for the reachable case; pure concurrency is inferred, not tested** | #680, not #671 alone |
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

### S2 — many `TURN_CLAIMED` rows on one session — CLOSED, but not by what the issue thread says

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
  checks only `turn_claim_json IS NULL` for *that message's own row*. So, by inspection of
  `claimTurn` alone, two concurrent DIRECT messages on one conversation — arriving inside the same
  in-flight window #646 measured at "a measured 3m15s turn against a 120s inner deadline" — would
  each pass that check and claim cleanly under #671 alone. **This is a reading of the guard's
  code, not something any test in this repository exercises or this document ran**: no test here
  constructs two genuinely concurrent, non-crash claims on one session and asserts the second is
  refused. The claim rests on `claimTurn`'s own logic having no session-scoped check, which is
  checkable by inspection but is not the same thing as a passing (or failing) test naming this
  scenario.
- **What actually closes it:** #680 (`157aeed`), which the issue's own comment does not mention.
  `TelegramHermesRouter`'s DIRECT branch (`src/ingress/telegram-router.ts`) now calls
  `this.ingress.unresolvedTurns(identity.sessionDigest)` **before** `claimTurn`, for every DIRECT
  message, not only a suspected resend — this part is a direct reading of the current source, not
  an inference. What is *not* directly tested is the concurrent case: all three of #680's own
  tests (`tests/unit/telegram-ingress.test.ts`, "parks a resend...", "does not park a DIRECT
  message from an unrelated conversation", "/again lets the owner...") construct the unresolved
  row the same way — one poller throws `TelegramInterruption` to leave a claim unresolved, that
  listener closes, and a *second, later* listener processes the next update. None of them start
  two claims genuinely concurrently, in one live process, with no crash between them. The
  park-before-claim check itself does not read `result_json` or anything else that would
  distinguish "unresolved because of a crash" from "unresolved because a slow turn is still
  running" — both are just `turn_claim_json IS NOT NULL AND repliedAt IS NULL` — so the same code
  path should cover the pure-concurrency case too. But that is this document's inference from the
  guard's SQL, not a claim the test suite backs, and it should be read as such rather than as
  something #680 was proven against.
- **The residual case, precisely:** the owner can still produce two unresolved claims on one
  session — by replying `/again <text>` to the park notice. That path is deliberate: the claim
  carries `overriddenUnresolvedNonce` (`TurnIdentity`, `src/ingress/ingress-guard.ts`) naming
  which earlier turn the owner knowingly ran alongside. So the *state* S2 described (multiple
  unresolved claims, ambiguous which is "the" one) is no longer produced silently; it is produced
  only on an explicit, recorded choice, which is exactly the distinction the original row asked
  for when it said *"the design in #641 assumes exactly one."* #680 does not enforce "exactly
  one" — it enforces "exactly one, unless the owner said otherwise and that is on the record."
- **Disposition:** closed for the critical path, on a code-reading argument rather than a test
  result — no test in the suite exercises two genuinely concurrent, non-crash claims on one
  session, so that specific case is unverified rather than proven. Worth a correction on the
  issue thread regardless: the 2026-08-29 comment's attribution to #671 is measurably incomplete,
  and if the concurrent case is load-bearing for whatever absorbs this, it is worth its own test
  before being called closed with confidence rather than with an inference.

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
  distinct from the ingress-side parking #680 built. No open ticket owned it at the time of this
  re-derivation: #641 (closed) named the framing gap on the ingress side only; #666 (open) is
  about the integrity of sources `claim()` is *handed*, not about adding one *after* claim time;
  #639 (open) is about receipt-matched completion, not about extending a turn's inputs while it
  runs. Filed as **#693** (*"A later message cannot join a canonical turn's batch or start its own
  while the incumbent is IN_DOUBT"*), with the state tuple, producing transition, terminal/gap and
  the ticket-coverage argument above written into its body rather than left as a placeholder — the
  rule this document itself states two sections down (a gap gets its own ticket) applies to its
  own rows, not only to the ones it is reporting on.

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

## Disposition summary

**Closed, nothing to absorb:** S1, S2 (mechanism closed; the pure-concurrency case is a
code-reading argument, not a tested one — see S2), S3 (never actually a hazard; closed by #635
before this census's own baseline), S6.
**Absorb — real work, still open:** S7 (**#693**, filed from this re-derivation).
**Independent, still open, embargoed by #638:** S5.
**Mechanism closed independently (#669); state stays embargoed by #638:** S4.
**Context, carried but not scheduled:** C1 (unchanged), C2 (citation corrected, underlying point
holds), C3 (unchanged; #638 still open).

Cross-references for the still-open gap: S7 is **#693** (*"A later message cannot join a
canonical turn's batch or start its own while the incumbent is IN_DOUBT"*), filed by this
re-derivation because no existing ticket owned it — #641 (closed) named only the ingress-side
framing gap, #666 (open) covers source integrity at claim time rather than adding a source after
it, and #639 (open) covers receipt-matched completion rather than extending a turn's inputs while
it runs. #638 (open) and #639 (open) are the reconciliation tickets #693 sits behind, alongside
S4 and S5's reachability.

**The durable-handler re-execution risk the original S3 misattributed is real, and already has
its own ticket: #673.** `prune` (`src/ingress/ingress-guard.ts`) deletes a row once its claim is
resolved (`turn_claim_json`'s `repliedAt` is set) *and* its TTL has passed — deletes it entirely,
not merely un-claims it. A redelivery after that point finds no row at all, `admit` treats it as
genuinely new, and it is claimed and run again with no record that it already happened. That is
the actual shape of a re-run S3's wording gestured at, correctly assigned to #673 (open) rather
than to S3's `ADMITTED`-and-unclaimed state, which the claim gate already covers. #672 (open — a
claimed turn whose handler returns no reply is never resolved, so it is never eligible for that
same prune path) is the adjacent gap on the other side of the same mechanism. Every still-open
gap in this census — S4/S5's reachability, S7, and the real re-execution risk in #673 — now
resolves to a ticket rather than to this document alone, which is the rule `docs/ACCEPTANCE.md:3`
states and this document was at risk of breaking for S7 until #693 was filed.

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

**Corrected after independent review, twice.** An xhigh read-only review of this document (21
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
to every row still marked open; S5 and S7 were re-checked and confirmed genuinely open (no
writer for `replacement_turn_request_id` exists anywhere, and no second writer of
`canonical_turn_sources` exists on `main` — a commit adding one, `1bd1b81`, is on an unmerged
branch, confirmed by `git merge-base --is-ancestor 1bd1b81 157aeed` returning false). That sweep
also located the real re-execution risk S3's wording had been gesturing at: it is #673's
prune-then-late-redelivery path, not S3's state, and the disposition summary above now says so.

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
comment, and none needed a further correction.

Re-ran `pnpm typecheck`, `pnpm lint` and `pnpm guards:anchors` after every edit across all three
rounds — all still pass. Did not re-run `pnpm test` after any round, since no edit touched
anything but prose and Markdown; the `1404 passed | 9 failed | 2 skipped` baseline above is from
the unmodified checkout and stands unchanged.
