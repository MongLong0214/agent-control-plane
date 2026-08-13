# Requirement declaration traceability

Generated from the vendored SSOT PRDs. This report measures declaration coverage only: a
scenario label resolves to an executable Vitest leaf that appears with status `passed` in
this fresh JSON-reporter result set. Behavioural coverage and production-entry-point coverage
are not measured, so this report is not proof that a requirement is met in the running system.

- Vitest result set: 642/643 passed; 0 failed; 1 pending
- Requirements: 22 (declaration coverage 22, gaps 0)
- Scenarios: 59 (passed declarations 59)
- Missing scenarios: none

| Requirement | Blocking | Declared scenarios | Declaration status |
|---|---|---|---|
| CP-001 | P0 | CP-S01, CP-S02, CP-S03 | DECLARATION_COVERED |
| CP-002 | P0 | CP-S04, CP-S05 | DECLARATION_COVERED |
| CP-003 | P0 | CP-S06 | DECLARATION_COVERED |
| CP-004 | P0 | CP-S07, CP-S08, CP-S09, CP-S10 | DECLARATION_COVERED |
| CP-005 | P0 | CP-S11 | DECLARATION_COVERED |
| CP-006 | P0 | CP-S12 | DECLARATION_COVERED |
| CP-007 | P0 | CP-S13, CP-S14, CP-S15 | DECLARATION_COVERED |
| CP-008 | P0 | CP-S16, CP-S17, CP-S18 | DECLARATION_COVERED |
| CP-009 | P0 | CP-S19, CP-S20, CP-S21, CP-S22 | DECLARATION_COVERED |
| CP-010 | P0 | CP-S23, CP-S24 | DECLARATION_COVERED |
| CP-011 | P0 | CP-S25, CP-S26 | DECLARATION_COVERED |
| CP-012 | P0 | CP-S27, CP-S28, CP-S29 | DECLARATION_COVERED |
| CP-013 | P0 | CP-S30, CP-S33 | DECLARATION_COVERED |
| CP-014 | P0 | CP-S31, CP-S32, CP-S34 | DECLARATION_COVERED |
| CP-015 | P0 | CP-S35 | DECLARATION_COVERED |
| CP-016 | P0 | CP-S36, CP-S37, CP-S38, CP-S39, CP-S40, CP-S41, CP-S42 | DECLARATION_COVERED |
| CP-017 | P0 | CP-S43, CP-S44, CP-S45, CP-S46, CP-S47 | DECLARATION_COVERED |
| CP-018 | P0 | CP-S48, CP-S49, CP-S50, CP-S51 | DECLARATION_COVERED |
| CP-019 | P0 | CP-S52 | DECLARATION_COVERED |
| CP-020 | P0 | CP-S53, CP-S54, CP-S55 | DECLARATION_COVERED |
| CP-021 | P1 | CP-S56, CP-S57 | DECLARATION_COVERED |
| CP-022 | P1 | CP-S58, CP-S59 | DECLARATION_COVERED |

| Scenario | Declaration status | Passed executable test declarations |
|---|---|---|
| CP-S01 | DECLARATION_COVERED | tests/unit/trusted-core.test.ts › CP-S01: read-only repository analysis stays DIRECT |
| CP-S02 | DECLARATION_COVERED | tests/unit/trusted-core.test.ts › CP-S02: a DIRECT-labelled mutation inside a repo is denied without a managed run |
| CP-S03 | DECLARATION_COVERED | tests/unit/trusted-core.test.ts › CP-S03: the same mutation passes with a valid run identity |
| CP-S04 | DECLARATION_COVERED | tests/scenarios/registry-cto.test.ts › CP-S04: a manifest carrying an absolute path is refused at registration<br>tests/unit/trusted-core.test.ts › CP-S04 / RF-S05: rejects absolute paths and session identifiers |
| CP-S05 | DECLARATION_COVERED | tests/scenarios/registry-cto.test.ts › CP-S05: the absolute checkout path exists only in the repository registry |
| CP-S06 | DECLARATION_COVERED | tests/scenarios/registry-cto.test.ts › CP-S06: a project cannot hold two active primary CTO bindings |
| CP-S07 | DECLARATION_COVERED | tests/scenarios/registry-cto.test.ts › CP-S07: a run against a CTO-less project provisions a fresh CTO and turns it ACTIVE<br>tests/scenarios/registry-cto.test.ts › suspending a project requires owner approval and removes the CTO binding<br>tests/scenarios/registry-cto.test.ts › CP-HI-03: replacing an active manifest outside a CONTRACT_CHANGE run is refused |
| CP-S08 | DECLARATION_COVERED | tests/scenarios/registry-cto.test.ts › CP-S08 / CP-S09: a replacement drains the CTO and new runs stay QUEUED<br>tests/scenarios/registry-cto.test.ts › CP-S08: switchover is refused while the outgoing CTO still owns active runs |
| CP-S09 | DECLARATION_COVERED | tests/scenarios/registry-cto.test.ts › CP-S08 / CP-S09: a replacement drains the CTO and new runs stay QUEUED |
| CP-S10 | DECLARATION_COVERED | tests/scenarios/registry-cto.test.ts › CP-S10: the old binding stays in force until HANDOFF_ACK, then switches atomically<br>tests/scenarios/registry-cto.test.ts › CP-S10: an ack from the wrong session cannot switch the binding |
| CP-S11 | DECLARATION_COVERED | tests/scenarios/registry-cto.test.ts › CP-S11: recovery takeover repoints the run and makes late results audit-only<br>tests/scenarios/registry-cto.test.ts › suspending a project requires owner approval and removes the CTO binding<br>tests/scenarios/registry-cto.test.ts › CP-HI-03: replacing an active manifest outside a CONTRACT_CHANGE run is refused |
| CP-S12 | DECLARATION_COVERED | tests/scenarios/graph-capacity-continuity.test.ts › CP-S12: independent tasks fan out across providers under one run |
| CP-S13 | DECLARATION_COVERED | tests/scenarios/graph-capacity-continuity.test.ts › CP-S13: two runs cannot hold the same worktree<br>tests/scenarios/graph-capacity-continuity.test.ts › a claim under a revoked generation is refused<br>tests/scenarios/graph-capacity-continuity.test.ts › an expired lease is reclaimable so a dead holder cannot block forever |
| CP-S14 | DECLARATION_COVERED | tests/scenarios/graph-capacity-continuity.test.ts › CP-S14: exact declared path overlap between runs is a hard reject<br>tests/scenarios/graph-capacity-continuity.test.ts › a claim under a revoked generation is refused<br>tests/scenarios/graph-capacity-continuity.test.ts › an expired lease is reclaimable so a dead holder cannot block forever<br>tests/unit/trusted-core.test.ts › CP-S14: rejects an exact path already claimed by another run |
| CP-S15 | DECLARATION_COVERED | tests/scenarios/graph-capacity-continuity.test.ts › CP-S15: a semantic (same-directory) overlap is advisory, not a reject<br>tests/scenarios/graph-capacity-continuity.test.ts › a claim under a revoked generation is refused<br>tests/scenarios/graph-capacity-continuity.test.ts › an expired lease is reclaimable so a dead holder cannot block forever |
| CP-S16 | DECLARATION_COVERED | tests/scenarios/graph-capacity-continuity.test.ts › CP-S16: several usage windows are normalized into separate buckets<br>tests/scenarios/graph-capacity-continuity.test.ts › a stale reading is usable inside the grace window and suspends past it<br>tests/scenarios/graph-capacity-continuity.test.ts › the reserve is computed from demand, not fixed |
| CP-S17 | DECLARATION_COVERED | tests/scenarios/graph-capacity-continuity.test.ts › CP-S17: a failed probe suspends new allocation and still probes runtime health<br>tests/scenarios/graph-capacity-continuity.test.ts › CP-S17: dispatch refuses its selected CTO provider when its capacity probe fails<br>tests/scenarios/graph-capacity-continuity.test.ts › a stale reading is usable inside the grace window and suspends past it<br>tests/scenarios/graph-capacity-continuity.test.ts › the reserve is computed from demand, not fixed |
| CP-S18 | DECLARATION_COVERED | tests/scenarios/graph-capacity-continuity.test.ts › CP-S18: a healthy disposable bucket is what makes Luna Max routable<br>tests/scenarios/graph-capacity-continuity.test.ts › a stale reading is usable inside the grace window and suspends past it<br>tests/scenarios/graph-capacity-continuity.test.ts › the reserve is computed from demand, not fixed |
| CP-S19 | DECLARATION_COVERED | tests/scenarios/graph-capacity-continuity.test.ts › CP-S19: GPT exhausted with Claude able to cover everything is DEGRADED / FULL_COVERAGE<br>tests/scenarios/graph-capacity-continuity.test.ts › Grok being absent on its own never degrades continuity |
| CP-S20 | DECLARATION_COVERED | tests/scenarios/graph-capacity-continuity.test.ts › CP-S20: partial coverage yields a wait-or-pause action rather than a silent pass |
| CP-S21 | DECLARATION_COVERED | tests/scenarios/graph-capacity-continuity.test.ts › CP-S21: with Claude down, distinct GPT sessions cover CEO, CTO and reviewer |
| CP-S22 | DECLARATION_COVERED | tests/scenarios/graph-capacity-continuity.test.ts › CP-S22: with both providers unavailable the mode is SURVIVAL and completion is refused |
| CP-S23 | DECLARATION_COVERED | tests/scenarios/graph-capacity-continuity.test.ts › CP-S23: a message addressed to a revoked generation is never delivered<br>tests/unit/trusted-core.test.ts › CP-S23: an ack from a superseded generation is audit-only |
| CP-S24 | DECLARATION_COVERED | tests/scenarios/graph-capacity-continuity.test.ts › Grok being absent on its own never degrades continuity<br>tests/scenarios/graph-capacity-continuity.test.ts › CP-S24: a recovered provider does not seize an in-flight run owner |
| CP-S25 | DECLARATION_COVERED | tests/integration/pipeline.test.ts › CP-S25: a repository change after freezing invalidates the whole candidate<br>tests/unit/trusted-core.test.ts › CP-S25: freezes every repository and goes stale when one head moves |
| CP-S26 | DECLARATION_COVERED | tests/scenarios/registry-cto.test.ts › CP-S26: an unregistered repository gets a run-scoped binding and no active project |
| CP-S27 | DECLARATION_COVERED | tests/unit/trusted-core.test.ts › CP-S27: a candidate command cannot read authority secrets from the environment |
| CP-S28 | DECLARATION_COVERED | tests/unit/trusted-core.test.ts › CP-S28: times out and reaps an in-group child when one can start |
| CP-S29 | DECLARATION_COVERED | tests/scenarios/github-kernel.test.ts › CP-S29: a CI result for a different head is refused, not counted<br>tests/scenarios/github-kernel.test.ts › CP-S29: an unapproved workflow digest or untrusted creator is also refused<br>tests/scenarios/github-kernel.test.ts › an older green CI result does not mask a newer red one for the same head<br>tests/scenarios/github-kernel.test.ts › a CI result belonging to another repository is not evidence for this one<br>tests/scenarios/github-kernel.test.ts › CP-HI-03: a command list that does not match the pinned manifest is refused<br>tests/scenarios/github-kernel.test.ts › CP-S29: a CI result at the exact head from an approved workflow is accepted |
| CP-S30 | DECLARATION_COVERED | tests/integration/pipeline.test.ts › registers a project manually and drives contract → verification → blind review → packet |
| CP-S31 | DECLARATION_COVERED | tests/integration/pipeline.test.ts › CP-S31: a producer session cannot be bound as the run's blind reviewer |
| CP-S32 | DECLARATION_COVERED | tests/integration/pipeline.test.ts › CP-S32: a review that misses a touched file cannot pass |
| CP-S33 | DECLARATION_COVERED | tests/integration/pipeline.test.ts › CP-S33: a REVISE verdict returns to the CTO and does not notify the CEO |
| CP-S34 | DECLARATION_COVERED | tests/scenarios/graph-capacity-continuity.test.ts › CP-S34: a failover the coverage plan cannot staff is refused, not downgraded |
| CP-S35 | DECLARATION_COVERED | tests/scenarios/github-kernel.test.ts › CP-S35: a same-named check from an untrusted creator or with an unknown payload is refused<br>tests/scenarios/github-kernel.test.ts › #388: a copied trusted payload digest from an untrusted app slug cannot approve a merge<br>tests/scenarios/github-kernel.test.ts › CP-S35: a gate whose payload the daemon did record, but under a different head, is refused<br>tests/scenarios/github-kernel.test.ts › gate_publish refuses when the trusted credential is absent |
| CP-S36 | DECLARATION_COVERED | tests/scenarios/github-kernel.test.ts › classifies every pattern in the Integration §9.2 matrix<br>tests/scenarios/github-kernel.test.ts › release and hotfix targets follow the matrix, including active-release checks<br>tests/scenarios/github-kernel.test.ts › CP-S36: pr_prepare refuses a contract-violating target before any external write<br>tests/scenarios/github-kernel.test.ts › pr_prepare re-reads the pull request and refuses a head that does not match the candidate<br>tests/scenarios/github-kernel.test.ts › #382: a source ref advancing after freeze does not replace the frozen origin<br>tests/scenarios/github-kernel.test.ts › #382: a candidate without a frozen source fails closed before PR creation<br>tests/scenarios/github-kernel.test.ts › #382: a release cut from main cannot use its main target to masquerade as a dev cut<br>tests/scenarios/github-kernel.test.ts › #422: a release cut from main is refused when main and dev still share their ancestor<br>tests/scenarios/github-kernel.test.ts › refuses a PR when the project contract requires issue linkage and none is supplied |
| CP-S37 | DECLARATION_COVERED | tests/scenarios/github-kernel.test.ts › #388: a copied trusted payload digest from an untrusted app slug cannot approve a merge<br>tests/scenarios/github-kernel.test.ts › CP-S37: a merge with no gate at all is refused, whatever the target branch is<br>tests/scenarios/github-kernel.test.ts › gate_publish refuses when the trusted credential is absent |
| CP-S38 | DECLARATION_COVERED | tests/scenarios/github-kernel.test.ts › CP-S38: a stale head or base is refused<br>tests/scenarios/github-kernel.test.ts › post-merge verification treats a missing check as a failure, not a pass |
| CP-S39 | DECLARATION_COVERED | tests/scenarios/github-kernel.test.ts › CP-S39: a valid merge happens exactly once and a replay returns the original receipt<br>tests/scenarios/github-kernel.test.ts › post-merge verification treats a missing check as a failure, not a pass |
| CP-S40 | DECLARATION_COVERED | tests/scenarios/github-kernel.test.ts › CP-S40: a failed post-merge check blocks dependent merges and a rollback plan is prepared<br>tests/scenarios/github-kernel.test.ts › post-merge verification treats a missing check as a failure, not a pass |
| CP-S41 | DECLARATION_COVERED | tests/scenarios/github-kernel.test.ts › CP-S41: a tag on an unaccepted commit and a conflicting existing tag are both refused |
| CP-S42 | DECLARATION_COVERED | tests/scenarios/github-kernel.test.ts › CP-S42: a hotfix missing from an active release reports propagation incomplete |
| CP-S43 | DECLARATION_COVERED | tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S43: a running receipt with a dead worker process is detected<br>tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › reports a missing trusted GitHub credential as blocking<br>tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › reports a CTO binding that points at a dead session as critical<br>tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › reports state-path permission drift as a blocking, actionable finding |
| CP-S44 | DECLARATION_COVERED | tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S44: an orphan worktree is reported and not deleted |
| CP-S45 | DECLARATION_COVERED | tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S45: aggregation from findings to status is deterministic<br>tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › reports a missing trusted GitHub credential as blocking<br>tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › reports a CTO binding that points at a dead session as critical<br>tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › reports state-path permission drift as a blocking, actionable finding |
| CP-S46 | DECLARATION_COVERED | tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S46: nothing happening past the deadline triggers a scoped doctor |
| CP-S47 | DECLARATION_COVERED | tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S47: repair needs an allowlisted operation and the right authorization<br>tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › a dry run changes nothing while the executed run does |
| CP-S48 | DECLARATION_COVERED | tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S48: a non-allowlisted user or chat is refused<br>tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S48: an update without the webhook secret is refused |
| CP-S49 | DECLARATION_COVERED | tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S49: a replayed update is idempotently ignored<br>tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S49: a Buzz message with an invalid HMAC is refused, and a valid one admitted once<br>tests/unit/trusted-core.test.ts › CP-S49: suppresses a replayed enqueue by idempotency key |
| CP-S50 | DECLARATION_COVERED | tests/unit/trusted-core.test.ts › CP-S50: only messages matching the currently active generation are deliverable |
| CP-S51 | DECLARATION_COVERED | tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S51: forwarded and crawled content is admitted as data and cannot change authority |
| CP-S52 | DECLARATION_COVERED | tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S52: a factory result that claims activation facts is rejected<br>tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › an unverified external write receipt is not evidence<br>tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › a manifest digest that does not match the approved one is contract drift<br>tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S52: only the ACP activation result supplies CTO, Buzz and doctor facts<br>tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › a bootstrap CTO that reviewed the run cannot be promoted |
| CP-S53 | DECLARATION_COVERED | tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S53: routine worker, task and review churn produces no CEO notification |
| CP-S54 | DECLARATION_COVERED | tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S54: a true escalation notifies the CEO and Hermes can close it |
| CP-S55 | DECLARATION_COVERED | tests/scenarios/registry-cto.test.ts › CP-S55: an owner decision moves the run through AWAITING_HUMAN and back |
| CP-S56 | DECLARATION_COVERED | tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S56: start and finish receipts are enough; nothing requires per-second reporting<br>tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › run outcome telemetry records mode, priority and revision count |
| CP-S57 | DECLARATION_COVERED | tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S57: telemetry that was never collected reports MISSING rather than a default<br>tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › run outcome telemetry records mode, priority and revision count |
| CP-S58 | DECLARATION_COVERED | tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S58: restart reconciles without dispatching the same run twice<br>tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S58: a queued run is resumed exactly once across a restart<br>tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S58: an execution left RUNNING across a restart is abandoned, not left dangling<br>tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › a lock left by a dead process is reclaimable |
| CP-S59 | DECLARATION_COVERED | tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S59: a second instance refuses to start and the backoff grows<br>tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › a lock left by a dead process is reclaimable |