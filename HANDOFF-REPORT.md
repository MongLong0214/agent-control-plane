## 307 — fixed
Enforcement: `buildSandboxEnvironment` reads only its explicit `extra` input; non-safe names never enter the candidate environment.
Test: `#163 drops an opaque provider token even when a command asks for its name` in `tests/unit/verify-r2.test.ts`
Change: `tests/unit/verify-r2.test.ts:116`

## 308 — fixed
Enforcement: a credential-shaped value is rejected even when supplied through an otherwise safe allowlisted name.
Test: `#308 drops a credential-shaped value even through an allowlisted name` in `tests/unit/trusted-core.test.ts`
Change: `src/verify/sandbox.ts:76`, `src/verify/sandbox.ts:368`, `tests/unit/trusted-core.test.ts:621`

## 313 — partial
Enforcement: the memory regression no longer uses a plain alias or a skipped test; it asserts `observed` plus PASS/null on Darwin and `hard` plus non-PASS elsewhere.
Test: `#166/#233 reports observed memory enforcement on Darwin and hard enforcement elsewhere` in `tests/unit/verify-r2.test.ts`
Change: `tests/unit/verify-r2.test.ts:202`
Remaining: `runSandboxed` fails closed before installing any Linux resource wrapper when `/usr/bin/sandbox-exec` is unavailable, so it records `observed`, not `hard`, on normal Linux. A real Linux confinement backend is required; reporting `hard` without installing the limit would weaken CP-HI-08.

## 319 — fixed
Enforcement: the trusted resource wrapper's `RLIMIT_NPROC=1` prevents the detached fork; the probe requires PASS/null and either `EAGAIN` with no child or an already-reaped child PID.
Test: `#164 prevents a detached descendant from escaping containment` in `tests/unit/verify-r2.test.ts`
Change: `tests/unit/verify-r2.test.ts:130`

## 328 — partial
Enforcement: the temporary-repository denial is pinned to the unique cross-run message and `temporaryForRun` evidence, not merely the shared `VERIFICATION_GAP` reason code.
Test: `#237 refuses untrusted and another run's temporary repositories before execution` in `tests/unit/verify-r2.test.ts`
Change: `tests/unit/verify-r2.test.ts:309`
Remaining: the separate #53/#179 capacity proof is in an unowned file and still needs its accept/deny controls.

## 329 — fixed
Enforcement: the command now constructs the credential path internally, runs under the profile, catches the denied read, and must report the kernel `EPERM` result.
Test: `#329 denies an attempted credential-store read made inside the command` in `tests/unit/trusted-core.test.ts`
Change: `tests/unit/trusted-core.test.ts:589`

## 317 — partial
Enforcement: the test now requires an `AcpError`, `INVALID_ARGUMENT`, and `sqlite` evidence instead of accepting the raw SQLite failure.
Test: `#317 translates a database CHECK failure into a stable reason code and evidence` in `tests/unit/trusted-core.test.ts`
Change: `tests/unit/trusted-core.test.ts:757`
Remaining: `Db.translate` currently returns an untyped generic CHECK-constraint error, so this regression correctly fails until the database boundary is fixed.

## 318 — fixed
Enforcement: a numeric-address `net.connect` avoids DNS/offline ambiguity; the candidate must complete after observing the kernel's `EPERM` denial, rather than relying on the self-reported flag.
Test: `#318 returns the kernel network-denial errno for a refused connection` in `tests/unit/trusted-core.test.ts`
Change: `tests/unit/trusted-core.test.ts:654`

## Shared-file edits

None.

## Needed elsewhere

- `src/db/database.ts` — `translate(err: unknown): unknown` at line 235 must wrap generic `CHECK constraint failed` errors in `acpError(ReasonCode.INVALID_ARGUMENT, ..., { sqlite: message })` (or another documented stable code), retaining the SQLite detail only as evidence. This unblocks #317.
- `tests/unit/continuity-r2.test.ts` — the #53/#179 case at line 120 must exercise `CapacityMonitor.refreshForDispatch(target?: DispatchCapacityTarget)`: assert `gpt`/`worker` is allowed with `ReasonCode.OK`, then assert `gpt`/`cto` is denied with `CAPACITY_UNKNOWN_NOT_ROUTABLE`. This unblocks the other half of #328.
- `src/verify/sandbox.ts` — `runSandboxed(request: SandboxRequest)` needs a Linux confinement backend with equivalent network, read/write, process, and resource isolation before it can satisfy #313's required non-Darwin `hard` memory assertion. Do not relabel the current fail-closed path as hard enforcement.

## Not done

- The normal Vitest command cannot load this worktree's config because `node_modules` is a symlink to a non-writable location and Vite receives `EPERM` creating `.vite-temp`. I used a temporary CJS config under `/tmp` only to run the owned files.
- Final owned-file run: 49 passed, 9 failed. Eight sandbox-execution failures are caused by this nested host rejecting `sandbox-exec` with `sandbox_apply: Operation not permitted` before candidate code starts; the new probes intentionally reject that wrapper-start failure. The ninth is #317, the real typed-error-boundary defect above.
- `npm run typecheck -- --pretty false` and ESLint on the three changed files pass.
