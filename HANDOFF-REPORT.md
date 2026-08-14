## Live sequence — captured

Evidence file: `evidence/p0-14-live-gate-merge-postmerge.json` and `evidence/p0-14-live-gate-refusals.json`

gate_publish: check-run `94632113610` on `f2c5d925acd75c5d2852b28c4021b6ba37b42596`, `success`, created by `acp-production-gate`; the payload digest was `sha256:e1de1f1acaa00ac64ccebfa236fcf48c0c04953a6a4bcce75f8c5afb0e97617a`.

merge_execute: PR #429 merged at `25c8ab3e3074e090c6047b70b297bea3841f359d`; `Daemon.start` resumed `Daemon.finalizeApprovedRun`, which performed the sequence. No caller performed a merge.

post_merge_verify: the pinned `.github/workflows/p0-14-live-post-merge.yml` produced the `verify` GitHub Actions check-run `94632132421` in workflow run `31756131029`, with `success` on the exact merge SHA `25c8ab3e3074e090c6047b70b297bea3841f359d`.

Refusals proven live: untrusted same-name check-run `94632897373` was `success` on the candidate but created by `github-actions`, and `mergeEvaluate` returned `GATE_PAYLOAD_PROVENANCE_INVALID`; a candidate with no same-named check returned `MERGE_GATE_MISSING`; and a current candidate at `2c4de95600047174ef38da1aab9720d89445a957` was refused with `MERGE_GATE_MISSING` rather than reusing the prior trusted App gate on `f2c5d925acd75c5d2852b28c4021b6ba37b42596`. PRs #430–#432 stayed unmerged.

Created and removed: merged PRs #428 and #429 used `acp/p0-14-live-20260814-085734-77184` / `feature/p0-14-live-20260814-085734-77184` and `acp/p0-14-live-20260814-090409-98629` / `feature/p0-14-live-20260814-090409-98629`. Closed PRs #430–#432 used `acp/p0-14-forge-base-20260814-090734-33303`, `feature/p0-14-forged-20260814-090734-33303`, `acp/p0-14-clean-base-20260814-090734-33303`, `feature/p0-14-missing-20260814-090734-33303`, and `feature/p0-14-stale-20260814-090734-33303`. All listed branches were deleted; the eight local capture directories were moved recoverably to Trash; pre-existing PR #425 was not changed.

Secrets in evidence: none — records contain only App/PR/check/commit identifiers and conclusions. Credential files were parsed in process, JWTs and installation tokens remained in memory, and HTTP error evidence omits response bodies.

## Two-repository (#240)

Blocked before a live sequence. The authenticated installation returned exactly one repository, `MongLong0214/agent-control-plane`. This deployment also cannot substitute two branch pairs: `repositories.identity` is unique and `RepositoryRegistry.register` rejects a second checkout for the same normalized identity. A second App-installed repository is required before the ordered two-repository capture can be run.

## Wiring

Replaced the static trusted-token path with a private-file GitHub App credential store: in-process RS256 JWT minting, `GET /app` slug and exact-permission validation, in-memory installation-token refresh, and a narrow authenticated REST client. `ControlPlane` supplies bounded production post-merge polling and denies App credential paths/environment to child adapters.

The kernel now polls only for missing/incomplete exact-SHA Actions checks, falls back to GitHub Contents at the immutable merge SHA when the local checkout lags, and proves a merge through the merged PR identifier, exact target-ref reread, and first-parent lineage. This corrected a live #428 finding: GitHub retains a merged PR's original `base.sha`; treating it as the mutable branch tip caused a safe `MERGE_BASE_STALE` refusal after a real merge.

Deletion-sensitive coverage: `tests/unit/github-app-credential-store.test.ts`; delayed Action and remote-workflow tests in `tests/scenarios/github-hardening.test.ts`; and the merged-PR base-snapshot/target-ref proof test in that same scenario. `pnpm typecheck`, `pnpm lint`, `pnpm build`, and the rebuilt full Vitest suite passed.

## CommitLore trailers recorded

Limit: Only the daemon finalizer may sequence an App-authorized production merge.

Ruled-out: Caller-held credentials and neutral/non-App same-name checks | neither can authorize a merge.

Warn: GitHub retains a merged PR's original base snapshot; prove the target ref and merge lineage instead.

Record-Id: r-p014live20260814

## Not done

The live two-repository ordered merge is not done because this installation has only one repository and the current registry intentionally forbids treating two checkouts of it as distinct repositories. No required-status check was registered.
