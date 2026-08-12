## 311 — partial
Enforcement: targetless dispatch admission now fails closed with `CAPACITY_UNKNOWN_NOT_ROUTABLE`; it can no longer pass because an unrelated provider is healthy.
Test: `CP-S17: dispatch refuses its selected CTO provider when its capacity probe fails` in `tests/scenarios/graph-capacity-continuity.test.ts`
Change: `src/capacity/capacity-monitor.ts:150`
Remaining: `src/app/control-plane.ts` still discards the `DispatchCapacityTarget`, so the production-path test currently receives `{ target: null }` rather than the expected Claude/CTO denial. The control-plane owner must forward it.

## 328 — partial
Enforcement: the capacity half now proves both sides of the claimed distinction: GPT/worker is admitted and GPT/CTO is refused with `CAPACITY_UNKNOWN_NOT_ROUTABLE` and target evidence.
Test: `#53/#179/#328 admits a working capability and denies the selected missing capability` in `tests/unit/continuity-r2.test.ts`
Change: `tests/unit/continuity-r2.test.ts:122`
Remaining: the unrelated verification half remains in `tests/unit/verify-r2.test.ts:262`; its owner must assert `temporaryForRun` (or the denial message) so deletion of that particular check cannot return the same `VERIFICATION_GAP` for another reason.

## 53 — partial
Enforcement: an admission must name a registered target provider and at least one required capability; targetless admission is denied rather than evaluated against any healthy provider.
Test: `CP-S17: dispatch refuses its selected CTO provider when its capacity probe fails` in `tests/scenarios/graph-capacity-continuity.test.ts`
Change: `src/capacity/capacity-monitor.ts:150`
Remaining: `src/app/control-plane.ts:273` must forward `target` into `this.capacity.refreshForDispatch(target)`. `RunEngine.dispatch` already derives the actual CTO provider; without the root forwarding it, dispatch safely denies all targetless calls rather than admitting the wrong one.

## 179 — partial
Enforcement: the selected provider is checked against every requested capability, and the regression distinguishes GPT/worker allow from GPT/CTO deny.
Test: `#53/#179/#328 admits a working capability and denies the selected missing capability` in `tests/unit/continuity-r2.test.ts`
Change: `src/capacity/capacity-monitor.ts:195`
Remaining: same control-plane target-forwarding repair as #53. The run-engine side already derives `{ provider, capabilities: ["cto"], priority: "critical" }` at `src/run/run-engine.ts:359`.

## 54 — partial
Enforcement: continuity allocation failure already refreshes the selected provider with `PROVIDER_SWITCH_OR_FAILURE` and returns `SESSION_NOT_READY`; the mandatory blind-review runtime path is still not wrapped at composition time.
Test: `#54/#176 refreshes selected capacity when continuity session allocation fails` in `tests/unit/continuity-r2.test.ts`
Change: existing enforcement verified at `src/continuity/continuity-kernel.ts:567` (no new source edit required there)
Remaining: the control-plane owner must call `providers.attachCapacity({ refresh: (trigger, providerIds) => capacity.refresh(trigger, providerIds) })` after constructing the monitor. That activates the existing registry wrapper for blind-review session creation/invocation and provider failures.

## 55 — partial
Enforcement: worker-capable allocations must explicitly use `priority: "worker"`; they refuse missing reserve demand, evaluate reserve per applicable bucket, and fail closed for malformed demand, unknown quota, or an absent/expired reset horizon. An unrelated unknown bucket no longer inflates a worker bucket's reserve.
Test: `#55/#182 computes reserve per window, includes reset/burn, and reserves unknown capacity` in `tests/unit/continuity-r2.test.ts`
Change: `src/capacity/capacity-monitor.ts:204`
Remaining: `TaskGraph.startExecution` has no capacity admission caller, so this is monitor-level coverage only, not closure evidence. The task-graph owner must add the production worker-fan-out gate described below.

## 176 — partial
Enforcement: the continuity failure path is verified to refresh the exact failed provider and deny with `SESSION_NOT_READY`; worker fan-out and blind-review triggers are still absent from their production callers.
Test: `#54/#176 refreshes selected capacity when continuity session allocation fails` in `tests/unit/continuity-r2.test.ts`
Change: existing enforcement verified at `src/continuity/continuity-kernel.ts:574` (no new source edit required there)
Remaining: attach the existing runtime observer in `src/app/control-plane.ts`, and add the worker-fan-out admission in `src/run/task-graph.ts`.

## 182 — partial
Enforcement: reserve computation now requires measured burn, preserves the entire relevant window when reset/burn/demand facts are unusable, and applies only the reserve of buckets constraining the requested worker capability.
Test: `#55/#182 computes reserve per window, includes reset/burn, and reserves unknown capacity` in `tests/unit/continuity-r2.test.ts`
Change: `src/capacity/capacity-monitor.ts:320`
Remaining: no production worker allocator currently supplies `priority: "worker"` plus DB-derived `reserveDemand`; see the task-graph handoff below.

## 57 — fixed
Enforcement: session liveness is checked against the exact constituted handle before continuity marks it READY; a healthy provider runtime cannot substitute for an unknown session.
Test: `#57 refuses failover when a healthy runtime cannot prove its exact constituted session` in `tests/unit/continuity-r2.test.ts`
Change: `src/runtime/scripted-adapter.ts:47`
Remaining: none. Current `ContinuityKernel` already calls `probeSession(handle)` at `src/continuity/continuity-kernel.ts:598`; the strengthened fixture now makes the regression distinguish provider health from session health.

## Shared-file edits

None.

## Needed elsewhere

- `src/app/control-plane.ts`, constructor wiring at the `runs.attach` capacity port: change the callback signature to `(target: DispatchCapacityTarget) => this.capacity.refreshForDispatch(target)`. This is the required #311/#53/#179 caller fix.
- `src/app/control-plane.ts`, after `this.capacity` is constructed: call `this.providers.attachCapacity({ refresh: (trigger, providerIds) => this.capacity.refresh(trigger, providerIds) })`. This activates the already-implemented `BLIND_REVIEW` and `PROVIDER_SWITCH_OR_FAILURE` wrapper paths for #54/#176.
- `src/run/run-engine.ts`, `CapacityGate.refreshForDispatch` and `RunEngine.dispatch`: make the target parameter required at the port boundary and refuse a null `dispatchCapacityTarget(run)` before invoking the gate. The provider derivation itself is already present in `dispatchCapacityTarget`.
- `src/run/task-graph.ts`, `TaskGraph.startExecution(input: ExecutionStart)`: make it asynchronous and place, before the database transaction, `await capacity.refresh(RefreshTrigger.WORKER_FANOUT, [input.provider])` followed by targeted worker admission with `{ provider: input.provider, capabilities: ["worker"], priority: "worker", reserveDemand }`. `reserveDemand` must be derived from durable state (critical role demand, expected mandatory reviews, in-flight runs, measured burn), not supplied by the MCP caller. Deny `CAPACITY_ADMISSION_CONSERVE` without creating an execution.
- `src/app/control-plane.ts`, TaskGraph composition: add/attach that worker capacity gate once the monitor exists.
- `src/mcp/cto-server.ts:163`, await the now-async `cp.tasks.startExecution(...)` before `respond(...)`.
- `tests/unit/verify-r2.test.ts:262`, pin the `temporaryForRun` condition for #328's verification half as noted above.

## Not done

- I did not edit `src/app/control-plane.ts`, `src/run/run-engine.ts`, `src/run/task-graph.ts`, `src/mcp/cto-server.ts`, or verification-owned files.
- The CP-S17 production-path regression is intentionally failing on current HEAD until the target-forwarding control-plane change lands; it fails with the safe `CAPACITY_UNKNOWN_NOT_ROUTABLE` result and `{ target: null }`, not an unsafe admission.
- Verification run: `npx tsc --noEmit` passed. `tests/unit/continuity-r2.test.ts` and `tests/unit/continuity-hardening.test.ts` passed (32 tests). `tests/scenarios/graph-capacity-continuity.test.ts` has 19 passing tests and the single expected CP-S17 caller-side failure. A temporary Vitest config under `/private/tmp` was used because the repository's symlinked `node_modules/.vite-temp` is not writable in this sandbox.
