# Contributing

This repository is not a production-ready service and has no published license grant. Ask
the repository owner before relying on contribution or reuse terms.

Before proposing a change, read the normative [PRDs](prd/), the
[closeout review](review/AGENT_CONTROL_PLANE_v1.0_FINAL_IMPLEMENTATION_CLOSEOUT_REVIEW.md),
and [current status](STATUS.md). Keep a change tied to a tracked finding or documented
requirement, and state what live evidence it does not create.

Run the repository gates relevant to the change:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm trace
node scripts/ssot-report.mjs
```

Do not hand-edit generated traceability evidence or status counts. A document that names a
changing number must derive it from a command, query, or generated artifact. A test that
passes after its enforcement is removed is not adequate regression evidence; say which
assertion fails when you check that negative control.

Do not represent a local test, fixture, modelled adapter, or template as live GitHub, Buzz,
Telegram, launchd, provider, or owner evidence. Those claims require the live evidence and
owner-controlled configuration described in [STATUS.md](STATUS.md).

## A test is worth what it refuses, not what it asserts

This repository has repeatedly found tests that pass without their enforcement. Twenty-six were
found at once during the hardening pass; #443 found ten more; #419 found a probe whose result was
effectively hardcoded. In every case the test read correctly to a human, was green, and proved
nothing. Reading cannot catch this, because reading selects the signal you already believe.

So a change that claims to fix or add an enforcement carries a **mutation proof**:

1. delete the enforcement the test names
2. confirm the named test fails, and fails for the stated reason
3. restore

If it does not go red, the test does not yet prove anything, whatever it asserts. Record the
mutation and its result in the PR — that record is the evidence, not the green run.

### Layered defences need one test per layer

Where a property is protected by more than one mechanism — a primary and a backstop — the proof
must bind to each **separately**. For every layer there must be at least one test that fails when
**only that layer** is removed.

Otherwise redundancy hides its own failure. #494 is the worked example: candidate containment has
a primary fence in the trusted wrapper and a secondary reap in TypeScript, and the containment
tests are satisfied by either. Removing the primary alone leaves every test green. The system
would quietly fall back to a single mechanism, and nobody would learn that until the day the
backstop failed too — which is the outcome CP-HI-08 exists to prevent.

The acceptance criterion is a table, because it is checkable:

| mutation | expected |
|---|---|
| remove layer A only | some named test fails |
| remove layer B only | some named test fails |

A defence whose layers cannot be told apart is one defence wearing two names.

#### Known exception: candidate containment

The primary fence in the trusted wrapper (`fence_descendants`) is **unproved**, and stays that
way deliberately. Removing its kill leaves every test green; the TypeScript identity reap is a
secondary backstop that satisfies each end-to-end assertion on its own.

Three end-to-end designs and three function-level designs were measured before this was written:

- **end-to-end cannot separate them.** A descendant cannot be forked (`RLIMIT_NPROC` refuses it
  by design), and the TypeScript kill always lands inside the wrapper's one-second wait loop, so
  the fence's failure never becomes observable. The third design passed even with *both* layers
  deleted — it was watching the process exit on its own, and would have shipped as false coverage.
- **function-level cannot separate them either.** The fence can be called directly, but its
  process discovery assumes the wrapper's own fork topology and does not find processes created
  outside it. With its kill removed it still reported success, because it had discovered nothing
  to reap.
- **a seam was rejected, not overlooked.** Isolating the primary would need a way to disable the
  secondary. A switch that turns containment off exists in the production path too, and
  containment that can be disabled is eventually run disabled. The cost of satisfying the rule
  would create the failure the rule is written against.

So this pair is exempt, and the exemption is a decision rather than an omission.

**This exception expires.** It holds only while the fence's process discovery is bound to the
wrapper's own fork topology. That is a design fact, not a law: if discovery is ever changed to
accept an arbitrary set of pids, the function-level test becomes possible and this exemption is
void. Whoever makes that change can lift this, and should.

What restores the rule here is therefore a change to how the fence discovers processes — not
another test.

#### Known gap: peer identity is registry-level, not kernel-level

`sessions.os_pid` is verified against the process start time, so a reused pid resolves to nothing
rather than to the wrong session (#505). That answers *is this pid still the process we recorded*.

It does **not** answer *is the peer on this socket that process*. Only a kernel credential check
(`LOCAL_PEERCRED`) does, and #539 tracks absorbing one.

**Update:** the owner has since approved this repository's own native-addon build convention
(ADR-0010 — `binding.gyp` + `node-addon-api`, prebuilt on the `macos-15` CI runner, modelled on how
`better-sqlite3` is consumed) rather than importing the pinned-toolchain regime found elsewhere on
this machine. `src/core/peercred.ts` and `native/peercred/` now exist and build on Darwin. That is
not the same event as the gap below closing — see the next paragraph.

This pointed at #450 until that issue was closed on 2026-08-15 with the work unfinished. An expiry
condition hanging off a closed ticket expires by accident — the same defect #538 fixed one layer
down, where `STATUS.md` listed six closed issues as live work still owed.

The weaker property covers what the absorption was for — rebinding after a daemon restart, and
actors the daemon did not spawn are both registry questions. It would not stop an adversary, and
#450 recorded that it was never meant to: the socket is 0600, and the same UID reads the session
secret anyway.

**This gap expires** when a kernel credential check actually answers the peer-identity question —
not when the primitive exists. Those are two events, and the distance between them is deliberate:
#539 delivers a boundary that **nothing calls**, and a new live call site is a RED mutant there
rather than a deliverable. Wiring one needs a separately authorized ticket that does not exist yet.

Stating the condition as "when `peercred.c` becomes reachable" was wrong for that reason. It would
have marked this gap expired at a point where the property still does not hold, which is the failure
this section exists to prevent, committed by the section itself. The word also collides: "reachable"
there meant *the legacy source is available to port*, while the ticket uses *unreachable from live
surfaces* to mean the opposite thing about call sites.

The start-time pairing is not thrown away when that day comes — kernel proof stacks on top of it
rather than replacing it, because the two answer different questions. #450's closure is not being
reversed here: that decision was the owner's. What does not follow from it is that the property now
holds, so the remaining work is tracked in #539 and this paragraph points there.

#### Known gap: the bootstrap activation half of `repositoryRole` is unproven

`ciWorkflows` entries carry a `repositoryRole` (#512), and three sites consume it. Two are proven by
mutation: `declaredPostMergeChecks` and `assertTrustedWorkflowCheck` each go red in
`tests/scenarios/finalizer.test.ts` when the role is dropped from them.

The third, `validateFactoryProvenance`'s `missingCi` in `src/bootstrap/activation.ts`, is not. The
input that separates the two behaviours needs a **two-repository bootstrap activation**: a manifest
declaring a check for one role only, and a factory result covering both repositories. Nothing
smaller reaches it — a role the manifest does not declare is refused by manifest validation, and a
role the factory result does not cover is refused earlier with `COVERAGE_INCOMPLETE`. Building it
means a bootstrap plan whose `githubOperations` cover both repositories, receipts matching that plan
exactly, local bindings for both, and a candidate snapshot for both. That fixture does not exist,
and no test exercises multi-repository bootstrap at all.

So this one rests on a correctness argument rather than a verified one: the change makes activation
resolve a workflow through its own role, the same way required verification commands are resolved
eight lines above it, and the cross product it replaces cannot be satisfied by any two repositories
whose CI differs. That reasoning is exactly what this document says not to trust on its own, which
is why it is recorded here instead of left implicit.

**This gap expires** when a two-repository bootstrap fixture exists — whoever builds one for any
reason should point this mutation at it. Until then the activation site is unverified, and green
there proves the single-repository path only.



### What went wrong while building these checks

Three of the checks in `scripts/` nearly shipped with the exact defect they were written to
catch. They are recorded because the next person writing one will meet the same three.

**A check that never runs.** The invariant-coverage step was added to a workflow filename that
does not exist. The script would have sat in the repository, passing by never executing, and its
absence would have looked like success. Verify the file you edited is the one CI runs —
`grep` the workflow for a step you know executes.

**A check that measures a proxy and reports it as the thing.** That same script counts invariant
*identifiers* in tests, while tests actually assert a trigger's *sentinel*. It reported CP-HI-02
at one test when four of its six triggers were genuinely proved. The proxy was usable for
ranking and useless as a measure, and nothing in the output said so until it was measured.

**A check that skips what it cannot parse.** The mutation sweep first neutered each trigger's
`WHEN` clause, which throws on triggers that have none. Had that exception been swallowed to keep
the sweep going, the unhandled shapes would have been skipped silently and the result reported as
"all clean". Replacing `SELECT RAISE(ABORT, 'X');` with `SELECT 1;` handles every shape.

**A mutation of the wrong site.** Deleting an enforcement is only a test of that enforcement if
the line deleted is the one the path executes. A helper called from several places will happily
stay green when the wrong caller is edited, and that green looks exactly like a coverage gap —
the reviewer-isolation deny was mutated at a probe's call site and the seatbelt test passed,
which briefly read as the boundary being unproved. It was not; the profile builds its deny list
somewhere else. **An invalid mutation is an invalid observation**, so establish which site the
path actually runs before drawing anything from a green result.

The common thread is that all four report success for something they did not examine. A check
is a claim about what it looked at, and the dangerous failure is not a wrong answer but a
confident answer about nothing.

**A passing suite is not evidence about infrastructure the suite does not use.** While localising a
live `ISOLATION_LOST`, the owner-provisioned reviewer egress at `~/.agent-control-plane/egress/` was
ruled out twice on bad grounds: first because the files exist, then because
`tests/unit/reviewer-egress.test.ts` passes. The second is the worse error and was made while
correcting the first. That suite calls `makeFixture()`, which builds **its own** proxy in a temporary
directory — it never touches the owner's. Ten green tests said the mechanism works and said nothing
about the deployment.

Settling it took one probe that acquired a lease against the real profile and measured the round
trip: allowlisted `200`, non-allowlisted `403`. That is what ruling something out costs.

Exclusions deserve more suspicion than confirmations, and for a structural reason: a wrong
confirmation gets caught at the next step that depends on it, while a wrong exclusion removes a
place from the search and then becomes the grounds for excluding the next one. Both of the above
were exclusions, and the first licensed the second.

### Find the enforcement, not the line number

An issue body is a fact about the moment it was written. Its line numbers, and its statement
that something is still broken, were true then. The code has moved since.

So when working a tracked finding, locate each item by **the enforcement it names**, not by its
recorded path and line. Whether it is still broken then comes out of the code rather than out of
the issue.

This is not a small correction. The #443 sweep of tests cited as proof found that five of six recorded items had
already been repaired, and every line number in the list had drifted. Working the list literally
would have produced five fixes to things that were already fixed, and a green run to go with
them. The sixth — a genuine gap, now #498 — was found because the sweep went looking for the
enforcement rather than the line.

The same rule explains a disagreement worth recording: a test named as the top priority was read
from the issue by one reviewer and from `main` by another, and only the second saw that it had
been fixed. When an issue and the code disagree, the code is the fact.


## Install the hooks, first thing

```sh
pnpm hooks:install   # writes shims into .git/hooks pointing at .githooks/
pnpm hooks:check     # proves each one refuses the case it names
```

Git will not let a repository install its own hooks — a clone that silently starts executing them
is a code-execution path, and git closes that deliberately. So this is a local step, and
`hooks:check` is the thing that notices it was skipped.

`core.hooksPath` would have been one line and is the wrong answer here: it replaces the hook
directory wholesale, so CommitLore's four hooks would stop running the moment it was set. The
installer writes into CommitLore's published `*.commitlore-chained` slots instead, which is why
`commit-msg` is not at the path you would look for it.

## What the hooks refuse, and what each one cost

Every item here was made more than once inside 48 hours, and every one was already *detected* by
something at the time. Detection was never the missing part.

| Mistake | Times | What noticed, and why that was not enough | What refuses it now |
|---|---|---|---|
| Committing while the falsifiability sweep holds a mutation | 2 | The sweep's own start-up check asks "is the tree dirty" — false after a killed run, irrelevant during a live one | `pre-commit`, on the sentinel file, which exists in exactly both cases |
| Editing a line a mutation row anchors to | 3 | The full sweep, forty minutes into CI | `pre-commit` and `pre-push` run the one-second anchors pass; CI runs it before the build |
| Wrapping a `Limit:` or `Ruled-out:` trailer onto a second line | 6 | `commitlore validate` printed a warning **and exited 0**, after the commit existed | `commit-msg`, and `pnpm trailers` over the range in CI |
| Pushing before the local gate CI runs had finished | 2 | CI, twice, in about eight minutes each | `pre-push` runs the cheap half of that gate |

## Never pipe a gate

```sh
pnpm guards:falsifiable | tail -20     # WRONG — the status is tail's, which is 0
pnpm guards:falsifiable > out.txt; echo $?   # right
```

A pipeline exits with its *last* command's status. A failing sweep piped into `tail` reports
success, and on 2026-08-22 that is exactly how a red gate was read as green — the failure text was
on screen and looked like a footer. Gates in this repository end with a single `RESULT: PASS` or
`RESULT: FAIL` line so a truncated read still says which one it was.
