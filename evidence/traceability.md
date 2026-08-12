# Requirement traceability

Generated from the vendored SSOT PRDs. Scenario coverage is established by scanning
the executable test suite for each scenario id, not by assertion.

- Requirements: 22 (covered 22, gaps 0)
- Scenarios: 59 (covered 59)
- Missing scenarios: none

| Requirement | Blocking | Scenarios | Status |
|---|---|---|---|
| CP-001 | P0 | CP-S01, CP-S02, CP-S03 | COVERED |
| CP-002 | P0 | CP-S04, CP-S05 | COVERED |
| CP-003 | P0 | CP-S06 | COVERED |
| CP-004 | P0 | CP-S07, CP-S08, CP-S09, CP-S10 | COVERED |
| CP-005 | P0 | CP-S11 | COVERED |
| CP-006 | P0 | CP-S12 | COVERED |
| CP-007 | P0 | CP-S13, CP-S14, CP-S15 | COVERED |
| CP-008 | P0 | CP-S16, CP-S17, CP-S18 | COVERED |
| CP-009 | P0 | CP-S19, CP-S20, CP-S21, CP-S22 | COVERED |
| CP-010 | P0 | CP-S23, CP-S24 | COVERED |
| CP-011 | P0 | CP-S25, CP-S26 | COVERED |
| CP-012 | P0 | CP-S27, CP-S28, CP-S29 | COVERED |
| CP-013 | P0 | CP-S30, CP-S33 | COVERED |
| CP-014 | P0 | CP-S31, CP-S32, CP-S34 | COVERED |
| CP-015 | P0 | CP-S35 | COVERED |
| CP-016 | P0 | CP-S36, CP-S37, CP-S38, CP-S39, CP-S40, CP-S41, CP-S42 | COVERED |
| CP-017 | P0 | CP-S43, CP-S44, CP-S45, CP-S46, CP-S47 | COVERED |
| CP-018 | P0 | CP-S48, CP-S49, CP-S50, CP-S51 | COVERED |
| CP-019 | P0 | CP-S52 | COVERED |
| CP-020 | P0 | CP-S53, CP-S54, CP-S55 | COVERED |
| CP-021 | P1 | CP-S56, CP-S57 | COVERED |
| CP-022 | P1 | CP-S58, CP-S59 | COVERED |

| Scenario | Status | Tests |
|---|---|---|
| CP-S01 | COVERED | ests/unit/trusted-core.test.ts › CP-S01: read-only repository analysis stays DIRECT |
| CP-S02 | COVERED | ests/unit/trusted-core.test.ts › CP-S02: a DIRECT-labelled mutation inside a repo is denied without a managed run |
| CP-S03 | COVERED | ests/unit/trusted-core.test.ts › CP-S03: the same mutation passes with a valid run identity |
| CP-S04 | COVERED | ests/scenarios/registry-cto.test.ts › registry authority (CP-S04, CP-S05, CP-S26)<br>ests/scenarios/registry-cto.test.ts › CP-S04: a manifest carrying an absolute path is refused at registration<br>ests/unit/trusted-core.test.ts › CP-S04 / RF-S05: rejects absolute paths and session identifiers |
| CP-S05 | COVERED | ests/scenarios/registry-cto.test.ts › registry authority (CP-S04, CP-S05, CP-S26)<br>ests/scenarios/registry-cto.test.ts › CP-S05: the absolute checkout path exists only in the repository registry |
| CP-S06 | COVERED | ests/scenarios/registry-cto.test.ts › CP-S06: a project cannot hold two active primary CTO bindings |
| CP-S07 | COVERED | ests/scenarios/registry-cto.test.ts › CTO lifecycle (CP-S07 – CP-S11)<br>ests/scenarios/registry-cto.test.ts › CP-S07: a run against a CTO-less project provisions a fresh CTO and turns it ACTIVE |
| CP-S08 | COVERED | ests/scenarios/registry-cto.test.ts › CP-S08 / CP-S09: a replacement drains the CTO and new runs stay QUEUED<br>ests/scenarios/registry-cto.test.ts › CP-S08: switchover is refused while the outgoing CTO still owns active runs |
| CP-S09 | COVERED | ests/scenarios/registry-cto.test.ts › CP-S08 / CP-S09: a replacement drains the CTO and new runs stay QUEUED |
| CP-S10 | COVERED | ests/scenarios/registry-cto.test.ts › CP-S10: the old binding stays in force until HANDOFF_ACK, then switches atomically<br>ests/scenarios/registry-cto.test.ts › CP-S10: an ack from the wrong session cannot switch the binding |
| CP-S11 | COVERED | ests/scenarios/registry-cto.test.ts › CTO lifecycle (CP-S07 – CP-S11)<br>ests/scenarios/registry-cto.test.ts › CP-S11: recovery takeover repoints the run and makes late results audit-only |
| CP-S12 | COVERED | ests/scenarios/graph-capacity-continuity.test.ts › parallel execution (CP-S12)<br>ests/scenarios/graph-capacity-continuity.test.ts › CP-S12: independent tasks fan out across providers under one run |
| CP-S13 | COVERED | ests/scenarios/graph-capacity-continuity.test.ts › resource claims (CP-S13, CP-S14, CP-S15)<br>ests/scenarios/graph-capacity-continuity.test.ts › CP-S13: two runs cannot hold the same worktree |
| CP-S14 | COVERED | ests/scenarios/graph-capacity-continuity.test.ts › resource claims (CP-S13, CP-S14, CP-S15)<br>ests/scenarios/graph-capacity-continuity.test.ts › CP-S14: exact declared path overlap between runs is a hard reject<br>ests/unit/trusted-core.test.ts › CP-S14: rejects an exact path already claimed by another run |
| CP-S15 | COVERED | ests/scenarios/graph-capacity-continuity.test.ts › resource claims (CP-S13, CP-S14, CP-S15)<br>ests/scenarios/graph-capacity-continuity.test.ts › CP-S15: a semantic (same-directory) overlap is advisory, not a reject |
| CP-S16 | COVERED | ests/scenarios/graph-capacity-continuity.test.ts › provider capacity (CP-S16, CP-S17, CP-S18)<br>ests/scenarios/graph-capacity-continuity.test.ts › CP-S16: several usage windows are normalized into separate buckets |
| CP-S17 | COVERED | ests/scenarios/graph-capacity-continuity.test.ts › provider capacity (CP-S16, CP-S17, CP-S18)<br>ests/scenarios/graph-capacity-continuity.test.ts › CP-S17: a failed probe suspends new allocation and still probes runtime health<br>ests/scenarios/graph-capacity-continuity.test.ts › CP-S17: dispatch is refused rather than routed against an unknown quota |
| CP-S18 | COVERED | ests/scenarios/graph-capacity-continuity.test.ts › provider capacity (CP-S16, CP-S17, CP-S18)<br>ests/scenarios/graph-capacity-continuity.test.ts › CP-S18: a healthy disposable bucket is what makes Luna Max routable |
| CP-S19 | COVERED | ests/scenarios/graph-capacity-continuity.test.ts › role continuity (CP-S19 – CP-S24)<br>ests/scenarios/graph-capacity-continuity.test.ts › CP-S19: GPT exhausted with Claude able to cover everything is DEGRADED / FULL_COVERAGE |
| CP-S20 | COVERED | ests/scenarios/graph-capacity-continuity.test.ts › CP-S20: partial coverage yields a wait-or-pause action rather than a silent pass |
| CP-S21 | COVERED | ests/scenarios/graph-capacity-continuity.test.ts › CP-S21: with Claude down, distinct GPT sessions cover CEO, CTO and reviewer |
| CP-S22 | COVERED | ests/scenarios/graph-capacity-continuity.test.ts › CP-S22: with both providers unavailable the mode is SURVIVAL and completion is refused |
| CP-S23 | COVERED | ests/scenarios/graph-capacity-continuity.test.ts › CP-S23: a message addressed to a revoked generation is never delivered<br>ests/unit/trusted-core.test.ts › CP-S23: an ack from a superseded generation is audit-only |
| CP-S24 | COVERED | ests/scenarios/graph-capacity-continuity.test.ts › role continuity (CP-S19 – CP-S24)<br>ests/scenarios/graph-capacity-continuity.test.ts › CP-S24: a recovered provider does not seize an in-flight run owner |
| CP-S25 | COVERED | ests/integration/pipeline.test.ts › CP-S25: a repository change after freezing invalidates the whole candidate<br>ests/unit/trusted-core.test.ts › CP-S25: freezes every repository and goes stale when one head moves |
| CP-S26 | COVERED | ests/scenarios/registry-cto.test.ts › registry authority (CP-S04, CP-S05, CP-S26)<br>ests/scenarios/registry-cto.test.ts › CP-S26: an unregistered repository gets a run-scoped binding and no active project |
| CP-S27 | COVERED | ests/unit/trusted-core.test.ts › CP-S27: a candidate command cannot read authority secrets from the environment |
| CP-S28 | COVERED | ests/unit/trusted-core.test.ts › CP-S28: kills the whole process group on timeout |
| CP-S29 | COVERED | ests/scenarios/github-kernel.test.ts › trusted CI evidence (CP-S29)<br>ests/scenarios/github-kernel.test.ts › CP-S29: a CI result for a different head is refused, not counted<br>ests/scenarios/github-kernel.test.ts › CP-S29: an unapproved workflow digest or untrusted creator is also refused<br>ests/scenarios/github-kernel.test.ts › CP-S29: a CI result at the exact head from an approved workflow is accepted |
| CP-S30 | COVERED | ests/integration/pipeline.test.ts › registers a project manually and drives contract → verification → blind review → packet |
| CP-S31 | COVERED | ests/integration/pipeline.test.ts › CP-S31: a producer session cannot be bound as the run |
| CP-S32 | COVERED | ests/integration/pipeline.test.ts › CP-S32: a review that misses a touched file cannot pass |
| CP-S33 | COVERED | ests/integration/pipeline.test.ts › CP-S33: a REVISE verdict returns to the CTO and does not notify the CEO |
| CP-S34 | COVERED | ests/scenarios/graph-capacity-continuity.test.ts › CP-S34: a failover the coverage plan cannot staff is refused, not downgraded |
| CP-S35 | COVERED | ests/scenarios/github-kernel.test.ts › production gate provenance (CP-S35, CP-S37)<br>ests/scenarios/github-kernel.test.ts › CP-S35: a same-named check from an untrusted creator or with an unknown payload is refused<br>ests/scenarios/github-kernel.test.ts › CP-S35: a gate whose payload the daemon did record, but under a different head, is refused |
| CP-S36 | COVERED | ests/scenarios/github-kernel.test.ts › branch contract (CP-S36, RF-S10, RF-S11)<br>ests/scenarios/github-kernel.test.ts › CP-S36: pr_prepare refuses a contract-violating target before any external write |
| CP-S37 | COVERED | ests/scenarios/github-kernel.test.ts › production gate provenance (CP-S35, CP-S37)<br>ests/scenarios/github-kernel.test.ts › CP-S37: a merge with no gate at all is refused, whatever the target branch is |
| CP-S38 | COVERED | ests/scenarios/github-kernel.test.ts › merge execution (CP-S38, CP-S39, CP-S40)<br>ests/scenarios/github-kernel.test.ts › CP-S38: a stale head or base is refused |
| CP-S39 | COVERED | ests/scenarios/github-kernel.test.ts › merge execution (CP-S38, CP-S39, CP-S40)<br>ests/scenarios/github-kernel.test.ts › CP-S39: a valid merge happens exactly once and a replay returns the original receipt |
| CP-S40 | COVERED | ests/scenarios/github-kernel.test.ts › merge execution (CP-S38, CP-S39, CP-S40)<br>ests/scenarios/github-kernel.test.ts › CP-S40: a failed post-merge check blocks dependent merges and a rollback plan is prepared |
| CP-S41 | COVERED | ests/scenarios/github-kernel.test.ts › release and hotfix (CP-S41, CP-S42)<br>ests/scenarios/github-kernel.test.ts › CP-S41: a tag on a commit the kernel never merged, and a duplicate tag, are both refused |
| CP-S42 | COVERED | ests/scenarios/github-kernel.test.ts › release and hotfix (CP-S41, CP-S42)<br>ests/scenarios/github-kernel.test.ts › CP-S42: a hotfix missing from an active release reports propagation incomplete |
| CP-S43 | COVERED | ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › doctor (CP-S43 – CP-S45)<br>ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S43: a running receipt with a dead worker process is detected |
| CP-S44 | COVERED | ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S44: an orphan worktree is reported and not deleted |
| CP-S45 | COVERED | ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › doctor (CP-S43 – CP-S45)<br>ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S45: aggregation from findings to status is deterministic |
| CP-S46 | COVERED | ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › watchdog (CP-S46)<br>ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S46: nothing happening past the deadline triggers a scoped doctor |
| CP-S47 | COVERED | ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › repair (CP-S47)<br>ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S47: repair needs an allowlisted operation and the right authorization |
| CP-S48 | COVERED | ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › ingress (CP-S48 – CP-S51)<br>ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S48: a non-allowlisted user or chat is refused<br>ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S48: an update without the webhook secret is refused |
| CP-S49 | COVERED | ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S49: a replayed update is idempotently ignored<br>ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S49: a Buzz message with an invalid HMAC is refused, and a valid one admitted once<br>ests/unit/trusted-core.test.ts › CP-S49: suppresses a replayed enqueue by idempotency key |
| CP-S50 | COVERED | ests/unit/trusted-core.test.ts › CP-S50: only messages matching the currently active generation are deliverable |
| CP-S51 | COVERED | ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › ingress (CP-S48 – CP-S51)<br>ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S51: forwarded and crawled content is admitted as data and cannot change authority |
| CP-S52 | COVERED | ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › Repo Factory boundary (CP-S52)<br>ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S52: a factory result that claims activation facts is rejected<br>ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S52: only the ACP activation result supplies CTO, Buzz and doctor facts |
| CP-S53 | COVERED | ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CEO notification policy (CP-S53, CP-S54)<br>ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S53: routine worker, task and review churn produces no CEO notification |
| CP-S54 | COVERED | ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CEO notification policy (CP-S53, CP-S54)<br>ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S54: a true escalation notifies the CEO and Hermes can close it |
| CP-S55 | COVERED | ests/scenarios/registry-cto.test.ts › CP-S55: an owner decision moves the run through AWAITING_HUMAN and back |
| CP-S56 | COVERED | ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › telemetry (CP-S56, CP-S57)<br>ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S56: start and finish receipts are enough; nothing requires per-second reporting |
| CP-S57 | COVERED | ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › telemetry (CP-S56, CP-S57)<br>ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S57: telemetry that was never collected reports MISSING rather than a default |
| CP-S58 | COVERED | ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › daemon (CP-S58, CP-S59)<br>ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S58: restart reconciles without dispatching the same run twice<br>ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S58: a queued run is resumed exactly once across a restart<br>ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S58: an execution left RUNNING across a restart is abandoned, not left dangling |
| CP-S59 | COVERED | ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › daemon (CP-S58, CP-S59)<br>ests/scenarios/doctor-ingress-bootstrap-daemon.test.ts › CP-S59: a second instance refuses to start and the backoff grows |