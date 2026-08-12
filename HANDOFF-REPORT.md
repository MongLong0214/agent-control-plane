## 333 — fixed
Enforcement: `ProviderAdapter.supportsReviewerIsolation === false` preferences are skipped before probing or binding; Codex declares that capability false, while every invocation still requires explicit attestation.
Test: `#333 skips a preferred adapter that cannot attest reviewer isolation` in `tests/unit/review-r2.test.ts` — asserts `REVIEW_PASS` and Claude fallback selection.
Change: `src/review/blind-review.ts:369`; `src/runtime/provider.ts:121`; `src/runtime/cli-adapters.ts:548,711`.
Remaining: —

## 334 — fixed
Enforcement: Reviewer CLIs now use an absolute executable, an explicit packet-local `HOME`/`TMPDIR` environment with only the required provider config root and `USER`, credential paths are explicitly allowlisted in the reviewer profile, and profile acceptance is attested independently of the model exit code.
Test: `#334 uses a packet-local reviewer home and reports answer failure separately` in `tests/unit/review-r2.test.ts` — asserts `EVIDENCE_MISSING` for an attested boundary with a failed model answer.
Change: `src/runtime/cli-adapters.ts:225,307,420,492`; `tests/unit/review-r2.test.ts:343`.
Remaining: —

## 335 — partial
Enforcement: `acquireAttempt` atomically reclaims a `RUNNING` row older than the 30-minute attempt lease TTL, so the next owner-valid submission can replace a lease left by a crashed process; live non-stale leases still return `CONFLICT`.
Test: `#335 reclaims an aged crashed submission lease` in `tests/unit/review-r2.test.ts` — asserts `OK` after inserting a stale `RUNNING` row.
Change: `src/run/candidate-pipeline.ts:32,141,354`.
Remaining: `src/doctor/watchdog.ts:41-198` (`Watchdog.tick`) does not yet sweep/report stale `candidate_pipeline_attempts`; add a narrow candidate-pipeline lease-reclaim port and invoke it from `tick` so a dead attempt is surfaced without waiting for another submission. The attempt table also has no durable deadline/heartbeat in `src/db/schema.sql:300-308`.

## 344 — partial
Enforcement: `submitResult` now proves the run owner and `ACTIVE` state before calling `acquireAttempt`; the post-acquisition checks remain as a race fence.
Test: `#344 validates the owner before reserving the submission lease` in `tests/unit/review-r2.test.ts` — asserts `RUN_OWNER_REVOKED` for the bogus caller and `OK` for the immediate valid submission.
Change: `src/run/candidate-pipeline.ts:141`.
Remaining: Add the requested `run_id` foreign key to `candidate_pipeline_attempts` in `src/db/schema.sql:304-308` (and the corresponding migration for existing databases), e.g. `FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE`.

## 316 — fixed
Enforcement: The splitter regression now requires `chunks.flat()` to contain more than one part before checking per-part properties, so dropping the file cannot pass vacuously.
Test: `#135 range-splits an oversized single-file patch` in `tests/unit/review-r2.test.ts` — asserts `parts.length > 1` and both exact per-part properties.
Change: `tests/unit/review-r2.test.ts:481`.
Remaining: —

## Shared-file edits

None. No shared reason-code, control-plane, domain-type, or helper file was changed.

## Needed elsewhere

- `src/doctor/watchdog.ts`, `Watchdog` constructor/`tick()`: wire a narrow candidate-pipeline lease sweep/reporting port for stale `candidate_pipeline_attempts`; the current pipeline-side reclaim only runs when a later submission arrives.
- `src/db/schema.sql`, `candidate_pipeline_attempts`: add the `runs(run_id)` foreign key and migrate existing databases; consider a durable deadline/heartbeat if watchdog ownership is made authoritative.

## Not done

- The real acceptance run was intentionally not executed: it requires a live provider session and spends provider quota. I believe the default run can reach a packet again when the Claude fallback is authenticated and the daemon is running outside this test runner’s enclosing sandbox: the shipped GPT preference is skipped as incapable, Claude has the explicit reviewer environment/profile path, and model failure is no longer reported as isolation loss.
- Verified instead: `pnpm typecheck` passed; targeted ESLint passed; `tests/unit/review-r2.test.ts` passed 20/20, including all five regressions. `tests/integration/pipeline.test.ts` ran 11 tests, with 3 passing and 8 stopping at `VERIFICATION_FAILED` because this workspace cannot nest `/usr/bin/sandbox-exec` (`sandbox_apply: Operation not permitted`); no provider quota was used.
- No git write commands were run. The existing reviewer-path assertion was made canonical-path aware and a stray debug print was removed while keeping the test’s enforcement claim unchanged.
