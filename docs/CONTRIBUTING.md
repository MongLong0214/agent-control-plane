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
(`LOCAL_PEERCRED`) does, and #450 tracks absorbing one. That absorption is not done: the source it
names is not reachable from this checkout, and writing the C from scratch would be new native code
wearing the word "absorb".

The weaker property covers what #450 says it is for — rebinding after a daemon restart, and actors
the daemon did not spawn are both registry questions. It would not stop an adversary, and #450
records that it is not meant to: the socket is 0600, and the same UID reads the session secret
anyway.

**This gap expires** when `peercred.c` becomes reachable. The start-time pairing is not thrown away
then — kernel proof stacks on top of it rather than replacing it, because the two answer different
questions. Neither is this an argument that #450 should be closed; that is an owner roadmap item and
the decision belongs to the owner.



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

