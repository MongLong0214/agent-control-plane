# #448 comparison site definition — stage 1 census

Measured against `8622195` (`origin/main` at the start of this work). The census covered the 88
tracked production TypeScript files under `src/`; tests, documents, scripts, and the two existing
untracked files were not treated as production callables. The exploratory AST scripts are not part
of this change.

## 1. Definition

**No operational definition was found.** Semantically, a comparison site would be the operation
that turns two independently mutable observations into a verdict about whether they agree; both
observations must belong to one generation, or the operation must refuse before producing the
verdict. A literal, enum, schema, type, null, count, or immutable-policy check is not such a site.
That sentence separates the intended concepts, but the current syntax does not identify its own
members: the comparison can be inline, delegated to a boolean helper, hidden in SQL, expressed as a
row-count result, or emitted by throwing rather than by returning `Decision<T>`. Consequently there
is no accepted site count or file:line set to turn into a static check.

## 2. Why this is the result

One AST census run (`C1`, temporary uncommitted `.tmp-candidate-census.mjs`) found 2,911 callables.
Candidate C's “controls” means an `if` or conditional expression contains a binary comparison and
its selected branch contains `allow()` or `deny()`; this is narrower than merely finding unrelated
expressions in one large function.

| candidate | measured population | count | disposition |
|---|---|---:|---|
| A | callable with an explicit return annotation containing `Decision<T>` | 343 | Too broad and annotation-dependent. |
| B | callable that directly calls either `allow()` or `deny()` | 374 | Too broad; 231 call both. It misses boolean, drift-valued, and throwing comparators. |
| C | callable that calls both and has a comparison controlling a decision branch | 184 | Still admits pure validation and misses delegated comparisons. |
| D | C-like decision callable with a raw comparison spelling `generation`, `digest`, `sha`, or `head` | 67 | Names are proxies: they admit type/null checks and miss neutral names such as `incarnation`, `changes`, and object entries. |
| E | direct `deny()`/`fail()` call using a member of `STALENESS_REASON_CODES` | 69 sites | An output classification, not a comparison definition: 65 return denials and 4 throw; 67 have a controlling condition, but only 42 expose both compared operands in evidence. |

### Candidate A samples

Five caught sites were inspected: `assertEvidenceClaim`
(`src/acceptance/disposable-realm-driver.ts:405`), `assertSyntheticTransportInjected` (`:414`),
`parseBootstrapRequest` (`src/bootstrap/hermes-bootstrap.ts:241`), `assertPortableManifest`
(`src/contracts/manifest.ts:183`), and `canTransition` (`src/domain/run-state.ts:71`). All five are
real decisions, but all are fixed-sentence, structural, format, or state-machine validation where
a generation is meaningless.

Five missed sites were inspected: the inferred inline `verifyHandoffAcknowledgement`
(`src/app/control-plane.ts:599`), `isCurrent` (`src/session/binding-registry.ts:809`),
`sameAuthorisationFacts` (`src/guard/managed-write-guard.ts:894`), `assertWorktreeBinding`
(`src/snapshot/candidate-snapshot.ts:295`), and `WorktreeManager.create`
(`src/verify/worktree.ts:58`). They compare mutable identity or frozen/current state but return an
inferred decision, boolean, `void`, or `Worktree`.

### Candidate B samples

The same five generation-irrelevant sites above are caught because each calls `allow()` or
`deny()`. Five inspected misses are `isCurrent` (`src/session/binding-registry.ts:809`),
`sameAuthorisationFacts` (`src/guard/managed-write-guard.ts:894`), repository `inspect`
(`src/registry/repository-registry.ts:240`), repository `observed` (`:269`), and
`WorktreeManager.create` (`src/verify/worktree.ts:58`). They return a boolean, a drift-valued record,
or throw via `fail()` instead of calling `allow()`/`deny()`.

### Candidate C samples

Five caught sites were again `assertEvidenceClaim` (`src/acceptance/disposable-realm-driver.ts:405`),
`assertSyntheticTransportInjected` (`:414`), `parseBootstrapRequest`
(`src/bootstrap/hermes-bootstrap.ts:241`), `assertPortableManifest`
(`src/contracts/manifest.ts:183`), and `canTransition` (`src/domain/run-state.ts:71`). Each has a
comparison controlling its two-way verdict, but none compares generations.

Five inspected misses were `isCurrent` (`src/session/binding-registry.ts:809`),
`sameAuthorisationFacts` (`src/guard/managed-write-guard.ts:894`), repository `inspect`
(`src/registry/repository-registry.ts:240`), repository `observed` (`:269`), and
`WorktreeManager.create` (`src/verify/worktree.ts:58`). Candidate C therefore narrows B without
fixing either kind of classification error.

### Candidate D samples

Five caught expressions show why names do not establish a generation comparison:
`typeof plan.requestDigest !== "string"` (`src/bootstrap/activation.ts:714`),
`typeof projectRegistration["activeManifestDigest"] !== "string"`
(`src/ceo/production-gate.ts:910`), the string-shape checks in `preparedPrIntent`
(`src/github/github-kernel.ts:3323`), `request.bindingGeneration == null`
(`src/guard/managed-write-guard.ts:1340`), and `input.harnessDigest != null`
(`src/run/task-graph.ts:295`). These are format or absence checks.

Five inspected misses are the session-incarnation comparison in the inline
`verifyHandoffAcknowledgement` (`src/app/control-plane.ts:599`), `sameAuthorisationFacts`
(`src/guard/managed-write-guard.ts:894`), repository `inspect`
(`src/registry/repository-registry.ts:240`), repository `observed` (`:269`), and the affected-row
comparison in `markSent` (`src/outbox/outbox.ts:265`). Each has temporal meaning without relying on
one of D's names at the decision expression.

### Candidate E samples

Five caught, genuine staleness refusals were inspected: managed-write revalidation
(`src/guard/managed-write-guard.ts:881`), binding authentication
(`src/session/binding-registry.ts:832`), candidate freshness
(`src/snapshot/candidate-snapshot.ts:273`), verification worktree materialisation
(`src/verify/worktree.ts:97`), and merge head/base checks
(`src/github/github-kernel.ts:1136`, `:1142`).

Five missed comparison loci were the helper `sameAuthorisationFacts`
(`src/guard/managed-write-guard.ts:894`), `isCurrent`
(`src/session/binding-registry.ts:809`), repository `inspect`
(`src/registry/repository-registry.ts:240`), repository `observed` (`:269`), and the bootstrap
history comparison `observed !== expectedGeneration - 1`
(`src/bootstrap/hermes-bootstrap.ts:265`). Conversely E catches sites that have no local pair to
compare, including `staleClaim` (`src/outbox/outbox.ts:613`) and missing-worktree-metadata handling
(`src/snapshot/candidate-snapshot.ts:309`). A reason family cannot define the operation that
produced it.

## 3. Current count

The accepted-definition count is **unmeasured, not zero**, because no candidate survived the
boundary tests. Reporting 0 would mean “looked and found none”; that is not what happened.

For auditability, the closest enumerable proxy, candidate E, produced these 69 direct sites in
run C1. This is a rejected proxy, not the comparison-site list:

- `src/ceo/owner-authority.ts:111`, `:192`, `:265`
- `src/ceo/production-gate.ts:182`, `:202`, `:521`, `:656`, `:902`, `:1163`
- `src/continuity/continuity-kernel.ts:364`
- `src/conversation/turn-coordinator.ts:761`
- `src/cto/cto-lifecycle.ts:325`, `:461`, `:565`, `:739`
- `src/daemon/agentcpd.ts:881`, `:901`, `:937`, `:944`, `:954`, `:1072`, `:1096`
- `src/daemon/finalizer.ts:387`, `:399`
- `src/github/confirmed-merge-operation.ts:124`
- `src/github/github-kernel.ts:403`, `:452`, `:660`, `:955`, `:977`, `:1047`, `:1082`,
  `:1114`, `:1136`, `:1142`, `:1569`, `:1704`, `:1712`, `:1787`, `:1950`, `:1969`,
  `:1987`, `:2028`, `:2089`
- `src/guard/managed-write-guard.ts:881`, `:1824`, `:1854`, `:1929`
- `src/ingress/telegram-router.ts:395`
- `src/mcp/ceo-conversation.ts:205`
- `src/mcp/cto-server.ts:96`
- `src/outbox/outbox.ts:275`, `:456`, `:614`
- `src/registry/conversational-actor-registry.ts:76`, `:162`
- `src/review/blind-review.ts:273`, `:636`, `:1181`
- `src/run/run-engine.ts:839`
- `src/run/task-graph.ts:497`
- `src/session/binding-registry.ts:281`, `:416`, `:832`
- `src/snapshot/candidate-snapshot.ts:273`, `:309`, `:318`, `:329`
- `src/verify/worktree.ts:97`

## 4. Boundary cases

Caught but ambiguous under candidate E:

- `src/outbox/outbox.ts:275` sees `changes !== 1`; the actual generation fence is inside the SQL
  predicate. Requiring two generation arguments at this TypeScript line would inspect the wrong
  layer.
- `src/snapshot/candidate-snapshot.ts:309` refuses missing metadata. Absence prevents comparison;
  it is not a comparison of two generations.
- `src/ingress/telegram-router.ts:395` refuses because no candidate digest exists. Again, one side
  is absent.
- `src/github/github-kernel.ts:1787` maps a non-merged response to `MERGE_HEAD_STALE` without a
  local two-operand comparison.
- `src/session/binding-registry.ts:416` refuses a missing task port when stale executions exist;
  the local condition is capability plus count, not two generations.

Missed but ambiguous under candidates A–E:

- `src/guard/managed-write-guard.ts:894` compares complete authorization records; generation is
  one field among many, and the denial is at its caller.
- `src/registry/repository-registry.ts:240` and `:269` compare accepted and observed heads but
  return drift classifications rather than `Decision<T>`.
- `src/verify/worktree.ts:58` binds head and tree by local derivation, then throws if the
  materialized worktree differs; no two generation parameters appear in its signature.
- `src/session/binding-registry.ts:809` is the smallest generation comparison in the tree, but it
  deliberately returns a boolean for callers to compose.
- `src/bootstrap/hermes-bootstrap.ts:265` compares a planned generation with observed history but
  reports an initialization race, not a member of the staleness family.

## 5. The issue's nine observed cases

The issue's own later classification is borne out by the current tree: seven cases were never
TypeScript comparison sites, and the two code cases are not loci in this repository's current
`src/` tree.

| # | observed case | caught by an accepted definition? | current-tree check |
|---:|---|---|---|
| 1 | CEO T6 froze a target while source kept landing | No definition; not a current `src/` locus | The issue classifies it with document/process state; `LIVE_0` is absent from tracked source. |
| 2 | Trust helper's current prestate versus orchestrator's past config prestate | No definition; code-shaped but absent here | `TRUST_RECEIPT_INVALID` and “trust receipt” are absent from this tree. A/B/C would depend on the foreign implementation shape, proving they do not define the concept. |
| 3 | CommitLore README prose versus generated block | No | Document content in another repository, not a production callable here. |
| 4 | README called closed #393 open | No | Historical document claim; current `README.md` has no #393 locus. |
| 5 | `evidence/review/*.json` predated egress hardening | No | Artifact provenance, not a TypeScript verdict. The later freshness script is a remedy, not the original comparison site. |
| 6 | Four documents asserted different test counts | No | Document claims; no production callable owns the comparison. |
| 7 | Monitor read `.gate` after rename to `current_phase_marker` | No | `docs/TERMINOLOGY.md` records the incident; the monitor implementation is not in this tree. |
| 8 | Anti-idle read API retry wait as idleness | No | Runtime-state interpretation outside the current source; no anti-idle implementation is present. |
| 9 | CommitLore #653 cached signature state across keyring generations | No | The issue explicitly says this belongs to another repository. |

This comparison is not a successful nine-of-nine detector result. It is evidence that a checker
over `src/**/*.ts` is aimed at a layer containing none of the issue's original defect loci.

## 6. Next step

Do not write the static check from any of these populations. The next implementable step is to
introduce an explicit declaration only when the first in-tree generation-binding defect supplies a
negative fixture: one operation or wrapper must name both observations and both generations, while
an explicitly cross-generation operation must state that intent. A later static check can enumerate
that declaration and require its four operands without guessing from return types, helper names, or
reason codes. Until such a production consumer exists, the honest check count and implementation
are both **unmeasured**.
