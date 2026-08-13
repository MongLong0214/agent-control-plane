# Handoff — fourth pass: the export needs a trust anchor, and you are working from a stale base

Two rounds of independent review have now landed on the same conclusion, and the second stated it
plainly:

> **the portable export still has no trust anchor, so an editor can rewrite source records, recompute
> every public hash, reseal, and pass verification.**

That is not a bug you can patch by hashing more fields. It is a property of the design: if every digest
is computed from the bundle's own contents by a published formula, and the resealer is available, then
any holder can produce a bundle that verifies. Hashing more fields only makes the attacker's script
longer. **Stop trying to close it that way** — the last two passes both did, and both were overturned.

## First: rebase. Your base is stale and it is causing false findings

You are on `d4f334b`. `main` is now `9d5f204`, and it contains work your tree does not:

- the **finalization state machine** — `CEO_APPROVED`, `MERGING`, `POST_MERGE_VERIFYING` — in
  `src/domain/run-state.ts`, so direct review→completion is no longer legal
- **`v13-finalization-state-machine`** in the ordered registry, and `SCHEMA_VERSION = 13`
- the migration path's **pre-migration backup, restore-on-fault and bounded retention**

The reviewer flagged that your tree "carries the v13 finalization schema while the domain machine still
permits direct review→completion" — that contradiction is an artifact of your stale base, not a defect
you introduced. Rebase onto `main` first, keep your ledger as **v14**, and re-run everything before you
read the rest of this packet.

That rebase also resolves the migration REGRESSION it found: `main`'s migration path already takes a
`VACUUM INTO` snapshot before applying, restores the original file on a post-commit fault, and retains a
bounded set of backups. Your v14 entry must go **through that path**, not beside it — and the drill must
prove injected-failure restore for v14 exactly as the v12→v13 drill does, not just a successful migration.

## The trust anchor — decide, implement one, and state the boundary honestly

Pick the strongest option v1 can actually deliver, implement it, and write the limit into the export's own
documentation:

- **A — host-anchored verification (expected).** The export is a *transport and inspection* format. Its
  verification is authoritative **only against the durable records that produced it**: the verifier reads
  the source database and reconciles every derived field — `baseline.runtime`, `baseline.harness`,
  `baseline.quality`, the graph facts, `gateAAssessment` — against the immutable artifacts. A bundle alone
  is then *reproducible*, not *self-proving*, and the export must say exactly that where a reader will see
  it. Any claim of portable immutability is removed.
- **B — daemon-signed export.** The daemon signs the sealed bundle with a key only it holds, and
  verification checks the signature. This is genuinely portable, but the key is owner-provisioned
  infrastructure — if you choose it, implement the verification side and report the key provisioning as an
  owner prerequisite, in the same way #242 and #243 are.

**A is almost certainly the honest answer for v1**, and choosing it is not a failure — mislabelling a
rewritable bundle as immutable is. Whichever you choose, `P0-18`'s heading must match what you built.

## The three reseal attacks that must fail

Whatever anchor you choose, each of these must be refused, with a test that performs the **whole**
attack — edit, recompute the inner digest with the published formula, reseal, verify:

1. edit `HARNESS_PINNED.payload`, recompute its `payloadDigest`, update `baseline.harness`, reseal
   (`src/export/run-evidence.ts:1028`, `:1155`)
2. flip an invocation to `qualificationEligible: true`, supply identity and duration, reseal the run and
   the recomputed assessment (`:1175`, `:1221`, `:1282`)
3. edit graph nodes, edges, counts, observed width or critical path and reseal — the verifier currently
   reconciles only snapshots and four selected fields (`:1192`)

The previous tests left the inner digest stale, which is why they missed all three. Model an attacker who
does not make that mistake.

## Also still open from the last review

- **V1-BR-01 / V1-BR-07** the named test passes with the assessor filter deleted, because both
  invocations already carry observed identity and duration
  (`tests/unit/baseline-export.test.ts:519`, `:526`, `:539`). Add the case that actually distinguishes it:
  an unqualified invocation **lacking** identity and duration must not affect coverage, and the resealed
  bundle must then fail verification.
- **V1-BR-10** the positive-count predicate is **CONFIRMED**. But real exports still produce no
  unauthorized-merge count at all, so #241's observation requirement is unmet. That is honest as a
  `partial` — say so rather than implying the count is being produced.
- **V1-BR-08** correctly reported `partial`. Leave it.

## Hard rules

1. **Do not hash your way out of the anchor problem.** Two passes tried; both were overturned.
2. Every claim needs a test that fails when its enforcement is deleted, and for the seal, a test that
   models an attacker who recomputes everything public.
3. **A truthful `partial` beats a `fixed` a reviewer overturns.** You are three rounds in on this item.
4. No ACP 2.0 features. Recording and export contracts only.
5. Not yours: `src/daemon/**`, `src/guard/**`, `src/github/**`, `src/ceo/**`, `src/runtime/**`,
   `src/review/**`, `src/capacity/**`, `src/tools/**`, `src/cli/agentctl.ts` (another lane is moving it
   behind the daemon socket right now — if your export needs a CLI surface, describe it).
6. Run no git write commands. Do not touch GitHub issues.

## Report — overwrite `HANDOFF-REPORT.md`

```
## Rebase
Base: <the main SHA you rebased onto>   v14 through main's migration path: <how>
Injected-failure restore for v14: <the test>
## P0-18 / V1-BR-06 — fixed | partial
Anchor: <A or B, and why that is what v1 can deliver>
What the bundle alone proves: <stated exactly>
Where that limit is written: <file>
Attack 1 (harness): <test, and that it recomputes payloadDigest>
Attack 2 (qualification): <test>
Attack 3 (graph facts): <test>
## V1-BR-01 / V1-BR-07 — fixed
Distinguishing case: <the unqualified invocation lacking identity and duration>
## V1-BR-10 — partial
Produced by real exports: <no — and what that means for #241>
## V1-BR-08 — partial (unchanged)
## Corrections to my previous report
```
