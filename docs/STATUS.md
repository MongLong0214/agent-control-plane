# Current status and acceptance limits

**This repository is not production-ready.** The issue tracker, not this page, is the
current source of truth for remaining work. This page intentionally does not copy counts
from a point in time.

Use these sources together:

- [Open P0 work](https://github.com/MongLong0214/agent-control-plane/issues?q=is%3Aissue%20state%3Aopen%20label%3AP0)
- [Open live-evidence work](https://github.com/MongLong0214/agent-control-plane/issues?q=is%3Aissue%20state%3Aopen%20label%3Alive-evidence)
- [Tracker index](https://github.com/MongLong0214/agent-control-plane/issues/306)
- `node scripts/ssot-report.mjs`, which fails when a tracked review finding or declared work item has no current issue
- `pnpm trace`, which regenerates declaration-coverage traceability evidence; behavioural
  coverage is not measured

The closeout review is vendored at
[docs/review/](review/AGENT_CONTROL_PLANE_v1.0_FINAL_IMPLEMENTATION_CLOSEOUT_REVIEW.md).
Its findings are real unless their GitHub issue records a disposition and evidence; a review
document is not made obsolete by a reassuring README sentence.

## Live work that is still owed

No document or generated test report is evidence for the following until the linked work has
its required live record:

- A GitHub App production-gate publication and merge path: [issue](https://github.com/MongLong0214/agent-control-plane/issues/242).
- A live Buzz delivery and acknowledgement: [issue](https://github.com/MongLong0214/agent-control-plane/issues/243).
- A real Telegram owner ingress and response path: [issue](https://github.com/MongLong0214/agent-control-plane/issues/392) and [follow-up](https://github.com/MongLong0214/agent-control-plane/issues/406).
- A deployable, observed launchd installation: [issue](https://github.com/MongLong0214/agent-control-plane/issues/400).
- The required real-world observation window: [issue](https://github.com/MongLong0214/agent-control-plane/issues/241).
- Owner-only channel configuration that only the owner can provide: [issue](https://github.com/MongLong0214/agent-control-plane/issues/245).
- Deployment-level observation that a configured reviewer can reach only its provider endpoint on macOS: [residual](https://github.com/MongLong0214/agent-control-plane/issues/419).

The runtime now has a fail-closed provider-egress path: each isolated reviewer receives a
daemon-generated provider allowlist, a kernel-enforced loopback proxy route, and fresh
allow/deny/direct-socket probes whose JSONL is bound to `BLIND_REVIEW` evidence. It still does
not make a general live-acceptance claim for an unconfigured deployment: missing or failed
infrastructure refuses review, and the outstanding deployment-level observation remains owed.
See [reviewer egress](reviewer-egress.md).

## Milestones

The work is organized in the active milestones rather than in hand-maintained progress bars:

- [Reviewer, Provider & Write Boundary](https://github.com/MongLong0214/agent-control-plane/milestone/12)
- [Single Authority, Channels & Deployment](https://github.com/MongLong0214/agent-control-plane/milestone/13)
- [Full Vertical Acceptance](https://github.com/MongLong0214/agent-control-plane/milestone/14)
- [Baseline Observation & Fresh Review](https://github.com/MongLong0214/agent-control-plane/milestone/15)

## Deliberate trade-offs and residuals

The [recorded design decisions](https://github.com/MongLong0214/agent-control-plane/issues/247)
are not an approval to ignore their residual risk. They explain why a constrained choice was
made and what would cause it to be revisited. The open P0 queue and the independent review
remain the governing evidence for release readiness.

## Paths this repository does not verify

Named here because a green suite otherwise reads as coverage of them.

- **The Linux hard-memory path is unverified.** `memoryLimitForPlatform("linux") === "hard"`
  is asserted as a pure function return (`tests/unit/verify-r2.test.ts`), and every sandbox
  and resource-limit test is `sandboxIt`, which runs only on Darwin. CI is macos-15 only
  (`.github/workflows/ci.yml`). So the Linux enforcement path has never executed here, and
  could regress to unlimited without any test failing. CP-HI-08 is behaviourally verified on
  Darwin only.
- **The full-vertical e2e is off by default.** `tests/e2e/real-component-integration.test.ts`
  is `describe.runIf(ACP_COMPONENT_INTEGRATION=1)` — it is the only test that drives SIMPLE,
  STANDARD and GUARDED through a real cloned repository and a live adapter, and it is the
  `1 pending` that `pnpm trace` reports. `pnpm test` stays green if that path breaks.
  `evidence/e2e-real-project-*.json` records manual runs; CI does not catch a regression.
- **`pnpm trace` run on its own still executes the suite twice.** CI passes
  `ACP_VITEST_RESULTS` so the suite runs once, but a bare `pnpm trace` falls back to spawning
  its own Vitest pass (`src/tools/traceability.ts`). That fallback is what crashed under
  `pool: "threads"`; it is safe under `forks`, but it is still a second full run.

## What the automated checks mean

`pnpm trace` establishes that labelled scenario declarations executed and passed in the current
Vitest result set. It measures declaration coverage only; behavioural coverage and production
entry-point coverage are not measured. It does not prove live provider, GitHub, Buzz, Telegram,
launchd, or operator behavior. `node scripts/ssot-report.mjs` checks tracker linkage and
recorded disposition consistency; it cannot determine from arbitrary code text that a semantic
defect has truly been fixed. Run both, then read the linked evidence before making a status claim.

`pnpm terminology` checks the vocabulary contract in [docs/TERMINOLOGY.md](TERMINOLOGY.md), which
is the SSOT for what the contested words mean — most importantly that `session` is a *replaceable
model runtime*, and that the long-lived counterpart holding a transcript is a **conversational
actor**. It checks collocations rather than words, because every contested word has legitimate
uses here; it therefore catches the confusions the decision was written to prevent, not every
possible misuse. One rule (`buzz-actor-qualified`) is staged: counted and held at a baseline, not
yet failing, because the rename it demands touches files that unmerged lanes are editing.
