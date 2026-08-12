# Acceptance status against PRD §42

This is a status ledger, not a claim of completion. Items that require an observation
period cannot be satisfied by a build, and are marked as such rather than glossed.

| # | Definition of Done | Status | Evidence / what is missing |
|---|---|---|---|
| 1 | CP-S01–CP-S59 all PASS | **Met** | Every scenario id maps to an executable test; `pnpm trace` reports 59/59 covered and all 275 tests pass. See `evidence/traceability.md`. Scenario coverage is not the same as review clearance — see the review status below. |
| 2 | DB constraint and transactional failover tests PASS | **Met** | `tests/unit/trusted-core.test.ts` trips each §30.2 constraint; `switchTo` activate/revoke/outbox-fence runs in one transaction and is asserted in CP-S10 and CP-S23. |
| 3 | One real end-to-end run in each of SIMPLE, STANDARD, GUARDED | **Partly met** | STANDARD ran end to end in 166s against a real project with a real CTO session, real sandboxed verification and a real independent reviewer — see `evidence/e2e-real-project.json`. SIMPLE and GUARDED are exercised by the scenario suite, including the GUARDED human gate, but not yet as real runs with live model sessions. |
| 4 | One multi-repository run with an explicit merge order | **Partly met** | Multi-repository freezing and staleness are proven with two real repositories (CP-S25), and `run_repositories.merge_order` plus per-repo merge state are implemented. A full two-repository merge sequence has not been executed. |
| 5 | Zero role/session independence violations under GPT-down and Claude-down continuity | **Met** | CP-S19–CP-S22, CP-S24, CP-S34. Distinct sessions are asserted, and a failover the coverage plan cannot staff is refused rather than downgraded. |
| 6 | Repo Factory bootstrap → primary CTO activation → doctor | **Met on the control-plane side** | Activation runs from a fixture `repo-factory.result.v2` through registration, binding, handoff ACK and doctor (CP-S52). The producing side is a separate deliverable and does not exist yet. |
| 7 | Scenario suite + ≥3 dogfood projects + ≥30 observed run/bootstrap lifecycles with zero false completions, duplicate dispatches, accepted stale-generation results, forged gates or unauthorised merges | **Not met — requires an observation period** | The mechanisms each have a negative test proving the zero is enforced rather than hoped for. The *count* needs real operating time across three projects. |
| 8 | Recorded observation window and duration for the zero counts | **Not met** | Follows item 7. |
| 9 | Zero owner interrupts for routine technical revision during dogfood | **Not met** | Follows item 7. CP-S33 and CP-S53 prove routine revision and churn do not notify upward. |
| 10 | Every P0 requirement linked to a scenario and evidence | **Met** | 22/22 requirements covered, 0 gaps, generated from the PRD tables rather than hand-maintained. |

## What the real end-to-end run produced

One run, `run_05f4d4ae2b624ecb92c51a87`, against a local clone of this repository
registered by hand. Full record in `evidence/e2e-real-project.json`.

- Project registered with activity `INACTIVE`; dispatch provisioned a primary CTO and it
  became `ACTIVE`, derived from the binding rather than stored.
- A DIRECT-labelled write to `src/core/reason-codes.ts` was refused with
  `WRITE_REQUIRES_MANAGED_RUN` before any run existed.
- A real Claude session, bound as `PRIMARY_CTO`, returned a parsed lean plan in 49s.
- Verification ran the project's real contract check inside a seatbelt-confined disposable
  worktree at exact head `e0a990d8…`: 1 expected input, 1 observed, `PASS`.
- A **fresh** Claude session, bound as `BLIND_REVIEWER` at generation 1 and confirmed not
  to be in the run's producer set, returned `PASS` with 1 file covered, 0 omissions and 1
  non-blocking finding. The packet records what was withheld from it.
- The CEO decision came from a third distinct session and moved the run to `COMPLETED`.
- The doctor then reported `DEGRADED` with exactly one finding,
  `CTO_BUZZ_NOT_CONNECTED` — correct, since Buzz is not configured here.

The first attempt at this run **failed**, and that is the more interesting evidence: the
independent reviewer returned `REVISE` with two findings that were both correct. It caught
a machine-specific `node_modules` symlink that had entered the candidate diff (scope creep
that would have broken any other checkout) and a mismatch between the contract's stated
acceptance criterion and the verification evidence actually supplied. Both were real
defects in the setup, both were fixed, and the re-run passed under a fresh reviewer — the
`REVISE → revise → fresh re-review` loop executed for real rather than simulated.

## Environmental boundaries found while building

These are facts about this machine and about GitHub, not design gaps.

**Production gate publishing needs a GitHub App.** Verified directly:

```
$ gh api -X POST repos/MongLong0214/agent-control-plane/check-runs -f name=acp-production-gate ...
{"message":"You must authenticate via a GitHub App.","status":"403"}
```

A personal access token cannot create check runs. `acp-production-gate` therefore requires
an App installation with `checks:write`, which is exactly the "GitHub Authority Credential"
PRD §24.1 describes — the owner has to create it. Until then the gate predicates are
verified against a modelled GitHub API, including that a same-named check from any other
creator is refused (CP-S35). The other API paths the kernel uses were checked against the
live repository and return the expected shapes.

**No provider exposes a quota interface.** `claude` has no `usage` subcommand and `codex`
has no usage command, so capacity comes from a structured local file and fails closed when
it is absent or stale. See `docs/capacity-source.md`.

**Buzz delivery is unverified live.** `BUZZ_PRIVATE_KEY` is not configured here, so the CLI
transport has not been exercised against the relay; delivery is covered through the
in-memory transport only.

**A verification worktree has no installed dependencies.** A disposable worktree contains
only committed files and, under `network: "deny"`, cannot fetch anything. A project needs a
dependency-free command, an install command declared with a network allowlist, or
`TRUSTED_CI` evidence. This repository uses the first for local verification
(`scripts/verify-reason-codes.mjs`) and the third for its typecheck.

## Operating requirements the hardening pass introduced

These are configuration facts an operator has to satisfy; the code fails closed without
them rather than assuming a permissive default.

- **Owner identities must be configured.** `ControlPlaneConfig.ownerIdentities` lists the
  channel/actor pairs that may act as the owner. With none configured, an owner decision, an
  owner-approved project suspension and an owner-authorised repair are all refused with
  `INGRESS_ACTOR_NOT_ALLOWLISTED` / `REPAIR_REQUIRES_OWNER`. A deployment with no owner
  cannot satisfy a human gate — deliberately, because §21 makes the owner the one authority
  the runtime may not synthesise.
- **A managed write needs a live claim.** Burning a guard grant requires the run to hold a
  `HELD`, unexpired claim on that repository under the run's current owner generation; the
  claim's lease is extended at that moment. A worker that writes without claiming is refused
  with `WRITE_PATH_NOT_CLAIMED`.
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

## Independent review status — **BLOCK**, 122 findings open

Two rounds of independent review by GPT-5.6 Sol (nine areas, read-only sandbox, reasoning
effort `xhigh`, no shared context between rounds). Both are recorded under
`evidence/review/` — round 1 in `evidence/review-round1/`, round 2 in `evidence/review/`.

| Round | Verdict | BLOCKER | MAJOR | What happened |
|---|---|---|---|---|
| 1 | BLOCK in all 9 areas | 55 | 68 | All 55 closed with regression tests across seven commits. |
| 2 | BLOCK in all 9 areas | 63 | 64 | 5 closed so far; the remaining 122 are filed as GitHub issues. |

**Round 2's BLOCKER count is not a regression.** Round 1's findings were fixed and their
regressions still pass; round 2 read the *changed*, larger codebase with fresh context and
went deeper — for example the guard's check-to-act window, evidence-producer impersonation
by an in-process caller, reviewer attribution under chunked review, and post-merge coverage
narrowing. Spot-checking confirmed the round-2 findings are accurate rather than stale.

What that means plainly: **this is not production-ready yet, and the review does not say it
is.** The Hard Invariants have real enforcement and real negative tests, and the end-to-end
path works against a real project — but an adversarial reader with full source access still
finds authority and evidence gaps faster than one hardening pass closes them.

Every round-2 finding is a GitHub issue carrying the reviewer's own reasoning, labelled
`review-blocker` / `review-major` plus `area:<area>`. That is deliberately the handoff
artifact: the next session works from the tracker, not from a transcript.

Closed from round 2 so far:

- `runtime#1` — only the production gate or a bootstrap activation may write `COMPLETED`.
- `runtime#12` — releasing a claim requires the run that holds it, in one transaction.
- `github#5` — post-merge verification requires every declared check, not a caller's subset.
- `github#6` — post-merge results must belong to a merge this run actually performed.
- `github#10` — a merge GitHub refused leaves no receipt to replay as success.

## What would close items 7–9

Run three real projects through the control plane for as long as it takes to accumulate 30
run or bootstrap lifecycles, then record the window, the duration and the five counts. The
telemetry needed for that is already collected (`telemetry_metrics`, scoped run / task /
quality / capacity / graph / continuity), and `agentctl` can read it back.
