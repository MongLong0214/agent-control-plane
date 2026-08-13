# Acceptance status against PRD §42

> **The GitHub issue tracker is the single source of truth for remaining work** — start at
> the pinned index, [issue #306](https://github.com/MongLong0214/agent-control-plane/issues/306).
> This file
> explains the state; the issues *are* the state. Nothing outstanding lives only here, in a
> transcript or in a commit message. `node scripts/ssot-report.mjs` reconciles the tracker
> against every review finding and every declared work item and fails if one is missing. It
> currently reports 252 findings and 9 declared work items with **0 missing**.
>
> | Query | Returns today | What it is |
> |---|---|---|
> | `label:review-blocker is:open` | 17 | Every blocker-class finding still open. All are round 2 and all carry `partial-fix` |
> | `label:review-major is:open` | 29 | Major findings still open — 15 from round 2, 14 from round 1 |
> | `label:partial-fix is:open` | 47 | The whole open finding queue: a first fix landed with a named regression test and the delegate reported the rest unfinished |
> | `label:round:r1 label:needs-triage is:open` | 14 | The open round-1 majors. Each restates a round-2 major in the same area — triage them against HEAD, do not work them twice |
> | `label:round:r1 label:review-blocker is:closed` | 57 | Round-1 blockers, all closed, each naming its commit and test |
> | `label:review-blocker label:round:r2 is:closed` | 41 | **Undercounts.** 46 round-2 blockers are closed; #81, #82, #86, #137 and #159 were closed before the `round:r2` label existed and this query misses them |
> | `label:acceptance is:open` | 2 | PRD §42 items a build cannot satisfy (#240, #241) |
> | `label:prerequisite is:open` | 4 | Deployment prerequisites only the owner can supply (#242–#245) |
> | `label:epic is:open` | 2 | Repo Factory integration (#246) and this index (#306) |
> | `label:design-decision is:open` | 1 | Nine deliberate trade-offs recorded for revisit (#247) |
>
> Closing rule: close with the commit SHA and the regression test that proves it, or with
> the reason it does not apply. A closed issue with no evidence is not closed.


This is a status ledger, not a claim of completion. Items that require an observation
period cannot be satisfied by a build, and are marked as such rather than glossed.

Every number below was observed on `integration/r3` at `9bbbae6`, against a pristine export
of that commit (`git archive HEAD`), because the working tree is being edited concurrently:

```
npx vitest run --reporter=dot     423 passed | 12 failed | 1 skipped  (436, 7 of 26 files failing)
npx tsc --noEmit                  clean
npx eslint .                      clean
npx tsx src/tools/traceability.ts declaration-coverage report; behavioural coverage is not measured
node scripts/ssot-report.mjs      252 findings, 47 open, 205 closed, 0 missing
```

**The 12 failures are being fixed as this is written**, so the count is a reading and not a
resting state. They sit in `tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts`
(CP-S54), `tests/scenarios/registry-cto.test.ts` (CP-S55),
`tests/scenarios/github-kernel.test.ts` (issue projection),
`tests/unit/github-r2.test.ts` (#87/#192, #96/#196), `tests/unit/review-r2.test.ts` (#132),
`tests/unit/run-gate-r2.test.ts` (#131, #143, #224) and `tests/unit/runtime-hardening.test.ts`
(three §21 owner-decision assertions). At `3c93fe2`, the tip of the round-1/round-2 fix
waves, the same suite was 423 passing and **0 failing**; the wave-3 merges added 13 tests and
these 12 failures arrived with them.

| # | Definition of Done | Status | Evidence / what is missing |
|---|---|---|---|
| 1 | CP-S01–CP-S59 all PASS | **Met in part — regressed mid-change** | The generated traceability report records declaration coverage for the scenario ids; it does not measure behavioural or production-entry-point coverage. Two of the scenario tests were failing at `9bbbae6`: **CP-S54** and **CP-S55**. Mapping is not passing, and passing is not review clearance — see the review status below. |
| 2 | DB constraint and transactional failover tests PASS | **Met** | `tests/unit/trusted-core.test.ts` trips each §30.2 constraint; `switchTo` activate/revoke/outbox-fence runs in one transaction and is asserted in CP-S10 and CP-S23. Both files pass in the run above. |
| 3 | One real end-to-end run in each of SIMPLE, STANDARD, GUARDED | **Not met — component-integration evidence only** | Three opt-in component-integration runs cover one mode each, but they directly construct `ControlPlane` and bypass deployed Hermes/CTO MCP transports, Buzz, the daemon-managed worker runtime, GitHub App merge, and post-merge verification. The historical records retain their `e2e-real-project` filenames: STANDARD 139 s, SIMPLE 146 s, GUARDED 129 s. They are not deployment-E2E evidence. |
| 4 | One multi-repository run with an explicit merge order | **Met in part** | Multi-repository freezing and staleness are proven with two real repositories (CP-S25), `run_repositories.merge_order` and per-repository merge state are implemented, and merge order is enforced with a regression test. A real two-repository run merging in declared order, with the first repository's post-merge verification gating the second, has not been executed — #240. |
| 5 | Zero role/session independence violations under GPT-down and Claude-down continuity | **Met** | CP-S19–CP-S22, CP-S24, CP-S34, all in `tests/scenarios/graph-capacity-continuity.test.ts`, all passing. Distinct sessions are asserted, and a failover the coverage plan cannot staff is refused rather than downgraded. |
| 6 | Repo Factory bootstrap → primary CTO activation → doctor | **Met on the control-plane side** | Activation runs from a fixture `repo-factory.result.v2` through registration, binding, handoff ACK and doctor (CP-S52, passing). The producing side is a separate deliverable and does not exist yet — #246. |
| 7 | Scenario suite + ≥3 dogfood projects + ≥30 observed run/bootstrap lifecycles with zero false completions, duplicate dispatches, accepted stale-generation results, forged gates or unauthorised merges | **Not met — requires an observation period** | The mechanisms each have a negative test proving the zero is enforced rather than hoped for. The *count* needs real operating time across three projects. Three lifecycles exist so far, the three runs of item 3. Tracked as #241. |
| 8 | Recorded observation window and duration for the zero counts | **Not met** | Follows item 7. #241. |
| 9 | Zero owner interrupts for routine technical revision during dogfood | **Not met** | Follows item 7. #241. CP-S33 and CP-S53 prove routine revision and churn do not notify upward, and both pass. |
| 10 | Every P0 requirement linked to a scenario and evidence | **Met** | The generated report links P0 requirements to scenario declarations from the PRD tables. This is declaration traceability, not behavioural proof that a requirement is met. |

## What the three real component-integration runs produced

One run per execution mode, against a local clone of this repository registered by hand, on
the code at `273f53c`. The mode is a parameter of one test —
`tests/e2e/real-component-integration.test.ts`, run with
`ACP_COMPONENT_INTEGRATION=1 ACP_COMPONENT_INTEGRATION_MODE=SIMPLE|STANDARD|GUARDED` — because §12.1 makes contract,
snapshot, verification and blind review mandatory in SIMPLE too; only the plan document is
optional. So the three records differ in what the mode adds, not in how much of the pipeline
ran. The test calls control-plane components directly, so it is not evidence that the
deployment transports or GitHub finalization path work end to end.

| mode | run | duration | record |
|---|---|---|---|
| STANDARD | `run_4add3123010447a59ab68dd2` | 139 s | `evidence/e2e-real-project.json` |
| SIMPLE | `run_6c9fcb2786ae474aa9514ee6` | 146 s | `evidence/e2e-real-project-simple.json` |
| GUARDED | `run_818cfdb2af0d47858a5df121` | 129 s | `evidence/e2e-real-project-guarded.json` |

What all three show, each in its own file:

- Project registered with activity `INACTIVE`; dispatch provisioned a primary CTO and it
  became `ACTIVE`, derived from the binding rather than stored.
- A DIRECT-labelled write to `src/core/reason-codes.ts` was refused with
  `WRITE_REQUIRES_MANAGED_RUN` before any run existed.
- A real Claude session, bound as `PRIMARY_CTO`, returned a parsed lean plan — 78 s, 59 s
  and 61 s respectively.
- Verification ran the project's real contract check inside a seatbelt-confined disposable
  worktree at an exact head (`ba18c9c3…`, `ae6539c8…`, `e2c10c78…`): 1 expected input,
  1 observed, `PASS`, with the evidence digest recorded.
- A **fresh** Claude session, bound as `BLIND_REVIEWER` at generation 1, returned `PASS`
  with 1 file covered, 0 omissions and 0 findings. Each packet records the eight input
  classes withheld from it, `candidate checkout paths` among them.
- The CEO decision came from a third distinct session and moved the run to `COMPLETED`.
- The doctor then reported `DEGRADED` with exactly one finding,
  `CTO_BUZZ_NOT_CONNECTED` — correct, since Buzz is not configured here (#243).

What the **GUARDED** run adds, and it is the part worth reading: it cleared a real human
gate. `recordOwnerDecision` was first called by `cli:someone-else` and refused with
`INGRESS_ACTOR_NOT_ALLOWLISTED` — recorded in the file as `humanGateRefusedNonOwner` — and
then by `cli:isaac`, which this host declares in `~/.agent-control-plane/owner-identities`.
The authorisation is not a test fixture: the composition root reads that file through its own
`readOwnerIdentities` (`src/app/control-plane.ts:82`), so the deployment's declaration is what
authorised the decision. The audit trail records `OWNER_DECISION` before
`CANDIDATE_PROMOTED`, so the packet stated a gate that was genuinely satisfied rather than one
approved after the fact.

**One caveat on this evidence.** The STANDARD record is written to the same path on every
re-run, so only the newest survives. `git log -- evidence/e2e-real-project.json` shows three
revisions — `run_05f4d4ae` (166 s), `run_2c690a75` (110 s), `run_4add3123` (139 s). An earlier
attempt was rejected by its blind reviewer for two correct findings and re-run successfully,
but no version of the file preserves the rejected attempt, so this ledger no longer describes
it: the `REVISE → revise → fresh re-review` loop is proven by CP-S33
(`tests/integration/pipeline.test.ts`), a test, not by a real run.

## Environmental boundaries found while building

These are facts about this machine and about GitHub, not design gaps.

**Production gate publishing needs a GitHub App.** Verified directly:

```
$ gh api -X POST repos/MongLong0214/agent-control-plane/check-runs -f name=acp-production-gate ...
{"message":"You must authenticate via a GitHub App.","status":"403"}
```

A personal access token cannot create check runs. `acp-production-gate` therefore requires
an App installation with `checks:write`, which is exactly the "GitHub Authority Credential"
PRD §24.1 describes — the owner has to create it (#242). Until then the gate predicates are
verified against a modelled GitHub API, including that a same-named check from any other
creator is refused (CP-S35). The other API paths the kernel uses were checked against the
live repository and return the expected shapes.

**Provider capacity is collected from interactive `/usage`.** Claude, Codex, and Grok each
have a PTY collector that sends the slash command and accepts only explicit
remaining-quota/reset statements. A trust prompt, activity-only screen, timeout, or parse
failure is persisted as an error and suspends new allocation; the daemon's JSON mirror is
diagnostic output, not an owner-maintained capacity input. See `docs/capacity-source.md`.

**Buzz delivery is unverified live.** `BUZZ_PRIVATE_KEY` is not configured here, so the CLI
transport has not been exercised against the relay; delivery is covered through the
in-memory transport only (#243). Every one of the three real runs ended in a `DEGRADED`
doctor for precisely this reason.

**A verification worktree has no installed dependencies.** A disposable worktree contains
only committed files and, under `network: "deny"`, cannot fetch anything. A project needs a
dependency-free command or `TRUSTED_CI` evidence. `network: "allowlist"` is deliberately
rejected until a proxy/firewall backend can enforce destination policy; a manifest must not
advertise an allowlist that seatbelt cannot apply. This repository uses the first for local
verification (`scripts/verify-reason-codes.mjs`) and the third for its typecheck.

## Operating requirements the hardening pass introduced

These are configuration facts an operator has to satisfy; the code fails closed without
them rather than assuming a permissive default.

- **Owner identities must be configured.** `ControlPlaneConfig.ownerIdentities` lists the
  channel/actor pairs that may act as the owner. With none configured, an owner decision, an
  owner-approved project suspension and an owner-authorised repair are all refused. A
  deployment with no owner cannot satisfy a human gate — deliberately, because §21 makes the
  owner the one authority the runtime may not synthesise. **This host now declares exactly
  one identity, `cli:isaac`**, which is what let the GUARDED run clear its gate. There is no
  `telegram` or `buzz` identity, so an owner decision arriving over either channel is still
  refused, and only the owner can supply one — #245 stays open for that reason alone.
- **ACP-owned source-facing writes are claimed and fenced.** Burning a Guard grant for a
  source mutation or verification worktree requires the run to hold a `HELD`, unexpired
  claim on that repository under the run's current owner generation; the claim's lease is
  extended at that moment. Manifest mutations instead carry a project/run/session/generation
  proof and exact digest (or the composition-root bootstrap proof), while stranded-worktree
  repair uses the doctor-only repair proof. Agent source-file syscalls are not individually
  routed through the Guard API: the runtime adapter and sandbox confine them to the assigned
  disposable worktree and the active claim/session/task receipt.
- **Post-merge verification needs declared checks.** `postMergeVerify` uses the pinned
  manifest's `ciWorkflows` / `postMergeCommands`; a caller-supplied name that the manifest
  does not declare, or an empty declared set, is refused with
  `POST_MERGE_CHECKS_NOT_DECLARED` instead of passing every commit.
- **Bootstrap activation is two-phase.** The first `activate` opens a `PENDING` handoff and
  returns `BOOTSTRAP_ACTIVATION_INCOMPLETE` with `pendingHandoffId`; the incoming CTO calls
  `acknowledgeActivationHandoff`, and a re-run of `activate` then completes. A bootstrap run
  cannot be confirmed by the CEO without a stored activation result.
- **Ingress signatures cover the envelope.** A signing client must use
  `ingressSignature(secret, request)` from `src/ingress/ingress-guard.ts`; the guard derives
  the signed bytes from channel, actor, conversation, nonce and payload rather than trusting
  a caller-supplied body.
- **The daemon keeps the capacity sensor inside its freshness window.** `agentcpd` probes
  each production adapter every four minutes and rewrites
  `~/.agent-control-plane/capacity/<provider>.json` atomically, preserving the adapter's own
  `observedAt` so an old reading cannot be laundered into a fresh one
  (`src/daemon/daemon.ts:227`). `agentctl doctor capacity` reports
  `CAPACITY_SENSOR_FILE_MISSING`, `_STALE` and `_INVALID` against a five-minute window. With
  the daemon stopped, allocation suspends once the grace window passes.

## Deliberate trade-offs

Nine are recorded on **#247**, each written down so a later reviewer argues with the
reasoning rather than rediscovering the behaviour. Five came out of the hardening pass; four
were taken at integration, and each of those four replaced a fail-closed choice that would
have made the system unable to do its job on the only platform it runs on. In the issue's own
words:

- **Memory is bounded by observation where the kernel will not honour a hard limit.** Darwin
  accepts `setrlimit(RLIMIT_AS, …)` and then ignores it, so an uninstallable hard limit meant
  *no verification could ever PASS* — not caution, an inability to verify anything. CPU and
  process-count limits are hard requirements everywhere and still fail closed; memory falls
  back to RSS observation, and the outcome records which mechanism was in force
  (`enforcement.memoryLimit: "hard" | "observed"`, `src/verify/sandbox.ts`). A reader of the
  evidence can tell the difference, which is the part that matters. Revisit when verification
  can run in a container or VM per attempt. #166/#233 are closed against this.
- **A GitHub merge executes with a fenced head and a proven base, rather than not at all.**
  GitHub's REST merge conditions on the exact expected *head*, not an expected base. The
  base is reread immediately before the merge and then proved after the fact by a
  first-parent walk; a failed proof moves the repository to FAILED and records the residual
  race in the receipt. The residual base race is bounded by that exact-head condition and
  post-merge verification, not by an atomic expected-base predicate. #85 is closed against
  this; the residual window is real and named.
- **Evidence is refused, never rewritten.** Redaction applied to evidence on the way to
  storage made every digest uncorroborable — a gate compares the report it was handed against
  the stored row, and the two could never match. §31.5 is now satisfied by *refusing* to store
  content carrying a credential, and the name-based rule was narrowed so `roleKey` and
  `idempotencyKey` are not mistaken for credentials. Audit records still redact, because
  nothing corroborates an audit row.
- **An agent session authenticates as its own provider.** The fix for #58 withheld the
  daemon's authority by constructing the child environment — and pointed `HOME` at an empty
  scratch directory, which does not contain an agent so much as stop it being one. Both
  shipped CLIs resolve their login through the invoking user's keychain, and neither finds it
  without `USER`: measured, not assumed. The daemon's authority is still withheld by refusing
  every authority-shaped variable and credential-shaped value and by denying reads of the
  database, secrets and capacity directories. A *reviewer* invocation is held to a stricter
  contract (#132, still open).

Items 4 and 5 of the original list — the guard's check-to-act window and reviewer isolation
by binding history rather than process sandboxing — are what #97 and #132 are about, and both
are still open.

## Independent review status — **BLOCK**, 112 issues open

Four independent passes have now been run, by two different model families, and the newest two
found defects the first two did not. That is the point of using more than one lineage: a shared
blind spot is exactly what a second round from the same reviewer cannot catch.

1. **GPT-5.6 Sol, round 1** — nine areas, read-only sandbox, effort `xhigh` (`evidence/review-round1/`).
2. **GPT-5.6 Sol, round 2** — same shape, fresh context, against the hardened code (`evidence/review/`).
3. **Test-integrity audit** — every one of the 436 tests read with one question: *would this still
   pass if the enforcement it names were deleted?* 26 would. Eight closed issues were **reopened**,
   because the regression test they were closed against proves nothing (label `test-integrity`).
4. **Edge-case audit** — the concurrency and lifecycle mechanisms the delegate waves added, read
   for the interleavings their own tests do not cover. 15 defects, 6 of them blocker-class
   (label `edge-case`).
5. **Grok audit of the integrator's own trade-offs** — the nine decisions on issue #247 where a
   fail-closed choice was deliberately relaxed. Verdict: **5 holes, 4 sound** (label `grok-audit`).
   It confirmed one decision by measurement rather than reading, and it caught the two worst
   defects in the whole set: a memory bound whose evidence claims an observation that does not
   exist, and an evidence capability the MCP surface can reach because the integrator's own
   justification for exposing it was false.

**No third Sol round has been run**; there is no `round:r3` label and no `evidence/review-round3/`.
The final gate is a Grok review of all nine areas (`node scripts/grok-review.mjs`), which has not
been run against a settled tree yet.

| Round | Verdict | BLOCKER | MAJOR | Closed | Open |
|---|---|---|---|---|---|
| 1 | BLOCK in all 9 areas | 57 | 66 (+1 minor) | 57 / 52 / 1 | 0 / 14 / 0 |
| 2 | BLOCK in all 9 areas | 63 | 64 (+1 minor) | 46 / 49 / 0 | 17 / 15 / 1 |

252 review findings, 205 closed, 47 open — reconciled by `node scripts/ssot-report.mjs`,
which reports 0 missing. On top of those: 26 `test-integrity`, 16 `edge-case` and 6 `grok-audit`
issues, of which 8 are reopened closures. **112 issues open in total.**

The eight reopened ones matter more than their count suggests. Each had been closed against a
named regression test, which is this project's own bar — and the audit showed the test would pass
with the enforcement removed. The fixes may well be right; what was missing was any way to notice
if they stopped being right. A closed issue with no evidence is not closed, so they are open.

### How the 205 got closed

Three waves of GPT-5.6 terra delegates worked the round-1 and round-2 findings, each from a
self-contained handoff packet in an isolated worktree (`terra/*`, `terra2/*`, `terra3/*`); the
integrator merged them and resolved the cross-area seams. Every one of the 205 closed
findings names both a commit and a regression test in its closing comment — checked across
all 205, with no exceptions. **133** of them use the current template, and it is worth
quoting the shape:

> **Enforcement** … **Regression test** `#166/#233 never passes a memory-pressure command
> without an installed hard limit` in `tests/unit/verify-r2.test.ts` **Change**
> `src/verify/sandbox.ts:76` … Commits: `c7f87f2..3c93fe2`.

The remaining 72 predate that template and name their commit and test in prose: 57 round-1
blockers (#249–#305), ten majors closed during the hardening pass, and the five round-2
blockers closed first (#81, #82, #86, #137, #159).

### Why 47 are still open

All 47 carry `partial-fix`, and that label means something specific: a fix landed, with its
own named regression test, and the delegate reported the finding as `partial` rather than
fixed — usually because the rest of the enforcement needs a change in a file another area
owns. #97 is the pattern:

> **Partially fixed — staying open.** … The delegate reported this as `partial` rather than
> fixed, so the finding is not closed. … it will be closed only when the remaining
> enforcement lands with its own regression test.

So the open queue is not 47 untouched findings, and it is also not 47 fixed ones. It is 47
findings with partial enforcement and a test proving the part that landed.

**Wave 3 has landed in the code but not on the tracker.** Seven commits —
`fix(<area>): complete the partial round-2 fixes in this area` for `core`, `continuity`,
`ctoreg`, `outboxbuzz`, `gates`, `doctordaemon`, `guardreview` — plus the integrator's
reconciliation at `9bbbae6` add roughly 2 600 lines and 13 new tests naming 12 of the open
findings (#54, #57, #75, #76, #97, #109, #130, #131, #132, #176, #183, #244). Not one issue
has been closed against that work, and 12 tests are failing, so by this document's own
closing rule none of it is closed yet. The `partial-fix` count is 47 until the remaining
enforcement is proven green and each issue is closed naming its commit and test.

**Round 2's BLOCKER count was not a regression.** Round 1's findings were fixed and their
regressions still pass; round 2 read the *changed*, larger codebase with fresh context and
went deeper — for example the guard's check-to-act window, evidence-producer impersonation
by an in-process caller, reviewer attribution under chunked review, and post-merge coverage
narrowing. Spot-checking confirmed the round-2 findings were accurate rather than stale.

The 14 open round-1 majors are the other thing to know about the queue: each one restates a
round-2 major in the same area — #207 and #119 are the same daemon MCP finding, #209 and
#112 the same worker-liveness finding, #214 and #124 the same Buzz actor finding, #226/#150,
#227/#156, #176/#54, #182/#55. Six of them already carry a second comment pointing at the
round-2 issue that fixes them. They should be closed against those, not worked twice.

What that means plainly: **this is not production-ready yet, and the review does not say it
is.** The Hard Invariants have real enforcement and real negative tests, and the end-to-end
path works against a real project in all three execution modes — but an adversarial reader
with full source access still finds authority and evidence gaps faster than the fix waves
close them, and the current suite is red.

## What would close items 7–9

Run three real projects through the control plane for as long as it takes to accumulate 30
run or bootstrap lifecycles, then record the window, the duration and the five counts. The
telemetry needed for that is already collected (`telemetry_metrics`, scoped run / task /
quality / capacity / graph / continuity), and `agentctl` can read it back. The three runs in
item 3 are the first three lifecycles and each one wrote its own telemetry rows, visible in
the `telemetry` block of each evidence file.
