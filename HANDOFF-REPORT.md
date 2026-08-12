## 48 — fixed
Enforcement: A binding switch rejects old-generation `IN_FLIGHT` rows, clears their claims, and both completion paths require the binding tuple to still be active.
Test: `#48 fences an in-flight old-generation claim during failover` in `tests/unit/outbox-buzz-claims-r2.test.ts:48`.
Change: `src/outbox/outbox.ts:470`.

## 51 — fixed
Enforcement: A non-retryable classified delivery is terminally rejected with `OUTBOX_DELIVERY_REJECTED`; its `failure_class`, `retry_eligible`, and `next_attempt_at` decision is durable.
Test: `#51 terminally rejects a non-retryable delivery with its durable classification` in `tests/unit/outbox-buzz-claims-r2.test.ts:231`.
Change: `src/db/schema.sql:637`, `src/outbox/outbox.ts:278`.

## 173 — fixed
Enforcement: Every enqueue now requires a persisted request fingerprint, duplicate replay compares only that original identity, and SQLite rejects any later fingerprint rewrite as `OUTBOX_PAYLOAD_DIGEST_MISMATCH`.
Test: `#173 denies a different request that reuses an idempotency key` in `tests/unit/outbox-buzz-claims-r2.test.ts:162`.
Change: `src/db/schema.sql:616`, `src/db/schema.sql:656`, `src/outbox/outbox.ts:151`, `src/db/database.ts:203`.

## 174 — fixed
Enforcement: Only classified transient/capacity/infrastructure failures with a valid positive backoff and remaining budget return to `PENDING`; they cannot be claimed before `next_attempt_at`, and exhaustion is terminal.
Test: `#174 defers only retryable failures, then terminates at the bounded attempt policy` in `tests/unit/outbox-buzz-claims-r2.test.ts:267`.
Change: `src/db/schema.sql:637`, `src/outbox/outbox.ts:278`.

## 175 — fixed
Enforcement: `SessionRegistry.transition` atomically rejects matching `PENDING` and `IN_FLIGHT` outbox rows when the target enters `ERROR` or `STOPPED`, with `OUTBOX_STALE_GENERATION_REJECTED`.
Test: `#175 atomically rejects pending and in-flight messages when their target enters ERROR or STOPPED` in `tests/unit/outbox-buzz-claims-r2.test.ts:100`.
Change: `src/session/session-registry.ts:160`, `src/session/session-registry.ts:204`.

## 214 — partial
Enforcement: `sessions.buzz_actor_id`, its live-session uniqueness/write-once guards, `SessionRegistry.bindBuzzActor`, and `BuzzAdapter.resolveActor` now distinguish a delivery channel from an authenticated actor identity.
Test: `#321/#124/#214 maps only an authenticated actor identity to an active binding` in `tests/unit/outbox-buzz-claims-r2.test.ts:376`.
Change: `src/db/schema.sql:101`, `src/session/session-registry.ts:243`, `src/buzz/buzz-adapter.ts:177`.
Remaining: No production ingress/MCP path currently invokes `SessionRegistry.bindBuzzActor` with a signed Buzz identity admission; see **Needed elsewhere**.

## 248 — fixed
Enforcement: `RETARGETED` is not admitted by the outbox status CHECK; retargeting leaves a message `PENDING` and records `OUTBOX_RETARGETED` as provenance.
Test: `#248 retains retarget provenance without admitting RETARGETED as a delivery state` in `tests/unit/outbox-buzz-claims-r2.test.ts:201`.
Change: `src/db/schema.sql:625`, `src/outbox/outbox.ts:470`.

## 321 — fixed
Enforcement: The live #321 ticket is the actor-resolution test finding. The regression now proves both the unauthenticated refusal (`SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED`) and a distinct authenticated actor resolving to its active binding; it cannot pass if `resolveActor` returns a constant null.
Test: `#321/#124/#214 maps only an authenticated actor identity to an active binding` in `tests/unit/outbox-buzz-claims-r2.test.ts:376`.
Change: `tests/unit/outbox-buzz-claims-r2.test.ts:376`.

## 327 — fixed
Enforcement: CP-S05 now registers a real checkout path, then reads the stored manifest row and re-reads it through the registry to prove the checkout appears only in the repository registry.
Test: `CP-S05: the absolute checkout path exists only in the repository registry` in `tests/scenarios/registry-cto.test.ts:72`.
Change: `tests/scenarios/registry-cto.test.ts:72`.

## 330 — partial
Enforcement: The packet's “four ownership/expiry tests” is live ticket #330, not #321. The owned expired-ACK test now exercises a real owner session and asserts `OUTBOX_EXPIRED` rather than merely `allowed === false`.
Test: `refuses an ACK for an expired message` in `tests/unit/binding-hardening.test.ts:214`.
Change: `src/outbox/outbox.ts:397`, `tests/unit/binding-hardening.test.ts:214`.
Remaining: Three non-owned tests still use nonexistent session IDs; see **Needed elsewhere**.

## 324 — partial
Enforcement: None in this owned area; the live ticket remains two import-appeasing assertions in non-owned tests.
Test: Not changed; the affected assertions remain in `tests/unit/runtime-hardening.test.ts:509` and `tests/e2e/real-project.test.ts:421`.
Change: No owned file.
Remaining: Remove the unused imports and tautological assertions in the two files above.

## 315 — partial
Enforcement: The live #315 ticket is the #143 owner-gate test, not the actor-resolution ticket described in the packet. Its test still omits the post-approval `satisfied === true` assertion.
Test: Not changed; `#143 lets an owner rejection revoke an earlier approval` in `tests/unit/run-gate-r2.test.ts:343`.
Change: No owned file.
Remaining: Add the intermediate positive assertion in the non-owned test; see **Needed elsewhere**.

## Shared-file edits

None.

## Needed elsewhere

- `tests/unit/runtime-hardening.test.ts`: remove the unused `applyPassingChange` import and its `expect(...).toBeTypeOf("function")` at line 509 (#324).
- `tests/e2e/real-project.test.ts`: remove the unused `candidateSnapshotDigest` import and its `expect(...).toBeTypeOf("function")` at line 421 (#324).
- `tests/unit/run-gate-r2.test.ts`, `#143 lets an owner rejection revoke an earlier approval`: after the first `recordOwnerDecision(...)`, assert `humanGateStatus(runId).satisfied === true`; the old debug log is already absent (#315).
- `tests/scenarios/github-hardening.test.ts`, `GitHubKernel.issueProject(runId, repositoryIdentity, tickets, caller)` and `GitHubKernel.releaseTag(runId, repositoryIdentity, tag, commitSha, caller)`: create a real READY session that is not the run owner, pass it as `caller`, and assert `RUN_OWNER_REVOKED` (#330).
- `tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts`, `BootstrapActivation.acknowledgeActivationHandoff(handoffId, ackBySessionId)`: create a real unrelated session and assert `HANDOFF_ACK_REQUIRED` (#330).
- `src/ingress/ingress-guard.ts` and the authenticated runtime ingress/MCP composition path: mint an opaque actor-binding receipt only after a signed Buzz ingress admission, then pass that receipt to `SessionRegistry.bindBuzzActor(...)`. The current structural `BuzzActorAuthenticator` is not invoked by a production path (#214).

## Not done

- Schema version is now 7. There is no ordered migration: a version-6 database is explicitly refused by `Db.applySchema` and must be recreated or migrated by an operator; no data migration is included.
- Per instruction, the full suite was not run. The four owned test files passed: 55 tests across 4 files. `pnpm exec tsc --noEmit` also passed. The stock Vitest config could not write Vite's temporary config under the read-only `node_modules` symlink, so the scoped run used a temporary config outside the repository.
