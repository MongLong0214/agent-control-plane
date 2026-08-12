## 336 — fixed
Enforcement: A restart reclaims PENDING `pr_prepare`, `gate_publish`, and `merge_execute` receipts only after GitHub proves the expected resource is absent; observed or ambiguous state remains `RESOURCE_COLLISION`.
Test: #336: stale absent PR, gate and merge reservations are reclaimed after restart in tests/scenarios/github-kernel.test.ts
Change: src/github/github-kernel.ts:345; src/github/github-kernel.ts:586; src/github/github-kernel.ts:1250

## 343 — fixed
Enforcement: A blank or malformed successful-write acknowledgement is denied as `EVIDENCE_MISSING` and retains its PENDING reservation rather than throwing or releasing after a possible write.
Test: #343: empty write acknowledgements preserve the reservation in tests/scenarios/github-kernel.test.ts
Change: src/github/github-kernel.ts:636; src/github/github-kernel.ts:1376

## 309 — fixed
Enforcement: CP-S41 now creates a real tag, then proves that a conflicting existing tag is rejected as `RELEASE_TAG_DUPLICATE` without adding another tag.
Test: rejects tag on an unaccepted commit and a conflicting existing tag in tests/scenarios/github-kernel.test.ts
Change: tests/scenarios/github-kernel.test.ts:658

## 312 — fixed
Enforcement: No production enforcement changed. The coverage test now asserts the reachable declared-check coverage refusal and its exact `POST_MERGE_VERIFICATION_FAILED` reason; the unreachable tail was removed.
Test: requires every declared check, not the subset the caller names (github#5) in tests/scenarios/github-hardening.test.ts
Change: tests/scenarios/github-hardening.test.ts:623

## 314 — fixed
Enforcement: The test revokes the run owner after its grant is issued and proves `RUN_OWNER_REVOKED`, a new managed-write-guard audit event, and no GitHub merge.
Test: stops the merge at the guard, not at GitHub in tests/scenarios/github-kernel.test.ts
Change: tests/scenarios/github-kernel.test.ts:970

## 322 — fixed
Enforcement: Credential-boundary tests enumerate the exact `TrustedCredentialStore` prototype API, so a newly exposed reader or runner changes the test-visible surface.
Test: #77: run-plan entrypoints do not accept raw GitHub tokens in tests/unit/github-r2.test.ts; exposes only the fixed credential-store API in tests/scenarios/github-hardening.test.ts
Change: tests/unit/github-r2.test.ts:160; tests/scenarios/github-hardening.test.ts:473

## 323 — fixed
Enforcement: The credential test now checks the complete readable-method surface and retains audit and receipt token-redaction assertions; the empty-object inspection and unrelated tautology are removed.
Test: keeps token-bearing values out of persisted audit and receipt material in tests/scenarios/github-kernel.test.ts
Change: tests/scenarios/github-kernel.test.ts:1294

## Shared-file edits

None.

## Needed elsewhere

None.

## Not done

Full `tests/unit/github-r2.test.ts` and `tests/scenarios/github-hardening.test.ts` runs are blocked in this sandbox by `SANDBOX_CHILD_CLEANUP_FAILED` during `driveToReviewedCandidate` local-verification setup, before the affected test bodies. Typecheck, lint, and diff checks passed; `tests/scenarios/github-kernel.test.ts` passed 33/33 and both standalone credential API tests passed.
