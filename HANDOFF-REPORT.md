## 337 — fixed
Enforcement: `acquireSourceReadLease` now sweeps expired grants before scanning, ignores non-source operations, and only conflicts with live source mutations. Source-read leases also expire in the same sweep, so an abandoned grant or stale lease cannot starve completion.
Test: `#337 ignores expired and non-source grants while sweeping expired source-read leases` in `tests/unit/guard-r2.test.ts`
Change: `src/guard/managed-write-guard.ts:356`, `src/guard/managed-write-guard.ts:380`, `src/guard/managed-write-guard.ts:419`
Remaining: none

## 341 — partial
Enforcement: Lease acquisition now requires an existing `ACTIVE` run and every requested identity to appear in `run_repositories`. Leases have a TTL, are swept with grants, and record acquisition/release. `assertSourceReadLease` now requires the repository identity set, checks the run is still active, and refuses uncovered identities.
Test: `#341 leases only ACTIVE participating runs and asserts every required repository` in `tests/unit/guard-r2.test.ts`
Change: `src/guard/managed-write-guard.ts:382`, `src/guard/managed-write-guard.ts:399`, `src/guard/managed-write-guard.ts:471`
Remaining: `src/ceo/production-gate.ts:95-100` must change `SourceReadLeasePort.assertSourceReadLease` to `(runId: string, leaseId: string, repositoryIdentities: readonly string[]) => Decision<void>`, and `src/ceo/production-gate.ts:227` must pass `snapshot.value.repositories.map((repository) => repository.identity)` on every assertion. The current two-argument call is why `tsc` reports `src/app/control-plane.ts:284` as incompatible; the production-gate delegate owns those edits.

## 347 — fixed
Enforcement: `authorize` now keeps a second index keyed by repository identity plus resolved path and returns `RESOURCE_COLLISION` before a second effect can start.
Test: `#347 rejects a second concurrent authorisation for the same repository target` in `tests/unit/guard-r2.test.ts`
Change: `src/guard/managed-write-guard.ts:216`, `src/guard/managed-write-guard.ts:287`, `src/guard/managed-write-guard.ts:927`
Remaining: none

## 339 — fixed
Enforcement: Filesystem fences now open the existing target with `O_RDONLY|O_NOFOLLOW`, retain its device/inode identity, and re-check that identity before and after the effect. A rename-into-place or hardlink replacement therefore returns `WRITE_EFFECT_FENCE_LOST`.
Test: `#339 detects a target inode replaced by rename while the effect is in flight` in `tests/unit/guard-r2.test.ts`
Change: `src/guard/managed-write-guard.ts:198`, `src/guard/managed-write-guard.ts:798`, `src/guard/managed-write-guard.ts:848`
Remaining: none

## 340 — fixed
Enforcement: Filesystem capture now anchors the nearest existing directory ancestor and treats a missing target as an expected first-write state; it still rejects a target that appears before the effect and checks the final canonical path afterward. `workspace-probe.ts` already walked missing paths to an existing ancestor, so it needed no change.
Test: `#340 permits the first write when its parent directories do not exist yet` in `tests/unit/guard-r2.test.ts`
Change: `src/guard/managed-write-guard.ts:770`, `src/guard/managed-write-guard.ts:906`
Remaining: none

## 342 — not-a-defect
Enforcement: The current tree already uses `SOURCE_READ_LEASE_HELD` for “a write blocks lease acquisition” and `SOURCE_READ_LEASE_CONFLICT` for “a lease blocks a write”. `SOURCE_READ_LEASE_NOT_HELD` is absent, as the reason-code comment says.
Test: `#131 blocks a managed source mutation while final publication holds its source-read lease` in `tests/unit/guard-r2.test.ts`; the corresponding `tests/unit/run-gate-r2.test.ts` assertion also currently expects `SOURCE_READ_LEASE_CONFLICT`.
Change: none; both directions and the reachable reason-code set are already consistent in this checkout.
Remaining: none

## 320 — fixed
Enforcement: The binding-revocation regression now asserts the single reason code produced by that path, `RUN_OWNER_REVOKED`, instead of accepting unrelated scope and generation failures.
Test: `a grant is refused once the binding generation moves` in `tests/unit/guard-hardening.test.ts`
Change: `tests/unit/guard-hardening.test.ts:340`
Remaining: none

## Shared-file edits

None. No shared file was modified. The existing `RESOURCE_COLLISION`, source-read lease reason codes, and audit evidence allowlist were reused.

## Needed elsewhere

- `src/ceo/production-gate.ts:95-100,227`: apply the #341 lease assertion signature and pass the full snapshot repository identity set as described above.
- `src/app/control-plane.ts:284`: no direct logic change is needed once the production-gate port signature is updated; this is the current typecheck site.
- `tests/unit/run-gate-r2.test.ts:212-215`: no change is needed in this checkout; preserve its `SOURCE_READ_LEASE_CONFLICT` assertion when the other delegate rebases.

## Not done

- The full suite was not run, per the packet instruction; only the two owned test files were run: 38 tests passed.
- Targeted ESLint passed for all four owned source/test files.
- `pnpm exec tsc --noEmit` is otherwise clean but remains blocked by the unowned two-argument `SourceReadLeasePort` declaration/call above.
- The default Vitest config loader hit an `EPERM` writing through the shared `node_modules` symlink; the owned tests were successfully run with `--configLoader runner`.
- No git write command was run.
