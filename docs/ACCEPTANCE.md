# Acceptance status against PRD §42

This is a status ledger, not a claim of completion. Items that require an observation
period cannot be satisfied by a build, and are marked as such rather than glossed.

| # | Definition of Done | Status | Evidence / what is missing |
|---|---|---|---|
| 1 | CP-S01–CP-S59 all PASS | **Met** | Every scenario id maps to an executable test; `pnpm trace` reports 59/59 covered and the suite passes. See `evidence/traceability.md`. |
| 2 | DB constraint and transactional failover tests PASS | **Met** | `tests/unit/trusted-core.test.ts` trips each §30.2 constraint; `switchTo` activate/revoke/outbox-fence runs in one transaction and is asserted in CP-S10 and CP-S23. |
| 3 | One real end-to-end run in each of SIMPLE, STANDARD, GUARDED | **Partly met** | STANDARD ran end to end against a real project with a real reviewer (`evidence/e2e-real-project.json`). SIMPLE and GUARDED are exercised by the scenario suite — including the GUARDED human gate — but not yet as real runs with live model sessions. |
| 4 | One multi-repository run with an explicit merge order | **Partly met** | Multi-repository freezing and staleness are proven with two real repositories (CP-S25), and `run_repositories.merge_order` plus per-repo merge state are implemented. A full two-repository merge sequence has not been executed. |
| 5 | Zero role/session independence violations under GPT-down and Claude-down continuity | **Met** | CP-S19–CP-S22, CP-S24, CP-S34. Distinct sessions are asserted, and a failover the coverage plan cannot staff is refused rather than downgraded. |
| 6 | Repo Factory bootstrap → primary CTO activation → doctor | **Met on the control-plane side** | Activation runs from a fixture `repo-factory.result.v2` through registration, binding, handoff ACK and doctor (CP-S52). The producing side is a separate deliverable and does not exist yet. |
| 7 | Scenario suite + ≥3 dogfood projects + ≥30 observed run/bootstrap lifecycles with zero false completions, duplicate dispatches, accepted stale-generation results, forged gates or unauthorised merges | **Not met — requires an observation period** | The mechanisms each have a negative test proving the zero is enforced rather than hoped for. The *count* needs real operating time across three projects. |
| 8 | Recorded observation window and duration for the zero counts | **Not met** | Follows item 7. |
| 9 | Zero owner interrupts for routine technical revision during dogfood | **Not met** | Follows item 7. CP-S33 and CP-S53 prove routine revision and churn do not notify upward. |
| 10 | Every P0 requirement linked to a scenario and evidence | **Met** | 22/22 requirements covered, 0 gaps, generated from the PRD tables rather than hand-maintained. |

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

## What would close items 7–9

Run three real projects through the control plane for as long as it takes to accumulate 30
run or bootstrap lifecycles, then record the window, the duration and the five counts. The
telemetry needed for that is already collected (`telemetry_metrics`, scoped run / task /
quality / capacity / graph / continuity), and `agentctl` can read it back.
