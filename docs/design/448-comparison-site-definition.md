# #448 comparison site definition — stage 1 census

Measured against `8622195` (`origin/main` at the start of this work). The census covered the 88
tracked production TypeScript files under `src/`; tests, documents, scripts, and untracked files
were not treated as production callables. Run C2 is reproducible with
`node docs/design/448-comparison-site-census.mjs --json`. That script only reports candidates E and
F: it has no baseline or failure result and is not a package or CI entry point.

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

The exact A–D counts came from C1, a temporary uncommitted script. They cannot be reproduced from
this tree and are withdrawn rather than repeated as measurements. Their inspected samples remain
below because each source expression is reviewable. Candidate C's “controls” means an `if` or
conditional expression contains a binary comparison and its selected branch contains `allow()` or
`deny()`; this is narrower than merely finding unrelated expressions in one large function.

| candidate | measured population | count | disposition |
|---|---|---:|---|
| A | callable with an explicit return annotation containing `Decision<T>` | C1 count withdrawn | Too broad and annotation-dependent. |
| B | callable that directly calls either `allow()` or `deny()` | C1 count withdrawn | Too broad. It misses boolean, drift-valued, and throwing comparators. |
| C | callable that calls both and has a comparison controlling a decision branch | C1 count withdrawn | Still admits pure validation and misses delegated comparisons. |
| D | C-like decision callable with a raw comparison spelling `generation`, `digest`, `sha`, or `head` | C1 count withdrawn | Names are proxies: they admit type/null checks and miss neutral names such as `incarnation`, `changes`, and object entries. |
| E | direct `deny()`/`fail()` call using a member of `STALENESS_REASON_CODES` | 70 sites | An output classification, not a comparison definition: 66 return denials and 4 throw; 67 have a direct controlling condition, and at least 43 expose both compared operands in evidence. |
| F | non-literal binary or `has`/`includes` predicate with a parameter-reachable operand; classify the other operand by origin | 844 predicates | 283 parameter/parameter pairs are compliant, 530 parameter/ambient-reachable asymmetries are flagged, and 31 cannot be resolved. The inspected false-positive rate is 5/5. |

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

Candidate E's corrected count comes from C2. The previously omitted site is the conditional
`MERGE_BASE_STALE` denial in `GitHubKernel.assertPreparedBaseRef`
(`src/github/github-kernel.ts:1912`). It records `expected: prepared.base` and
`observed: observedBaseRef`; including its preceding success guard raises the evidence-pair floor
from 42 to 43.

### Candidate F samples

For C2, an operand is parameter-reachable when it is a parameter or a local derived from one.
`this`/`super`, module-level declarations, imports, globals, and locals derived from them are
ambient-reachable. An operand reachable from both is still ambient-reachable for the asymmetry.
Literals are excluded; unresolved origins are reported separately. The predicates are ordinary
binary relations plus one-argument `has()` and `includes()` membership checks.

The required positive fixture is found. C2 recognizes three predicates in
`validateChunkCoverage` (`src/review/blind-review.ts:1651`), including
`assigned.has(claim)`, and classifies all three as parameter/parameter. `assigned` derives from
`chunk`, while `claim` derives from `claims`, so the caller supplies every dynamic value the
function compares.

Five flagged asymmetries were inspected:

- `outcome.updateId !== UPDATE_IDS[index]`
  (`src/acceptance/disposable-realm-driver.ts:362`) checks a synthetic fixture result.
- `runtimeNonce.length < NONCE_MIN_LENGTH` (`src/bootstrap/hermes-bootstrap.ts:574`) is an input
  shape limit.
- `value.length > MAX_UNKNOWN_AUDIT_STRING` (`src/db/audit.ts:239`) is a storage policy limit.
- `version > SCHEMA_VERSION` (`src/db/backup.ts:264`) is static schema compatibility.
- `TERMINAL_RUN_STATES.includes(state)` (`src/domain/run-state.ts:63`) is enum classification.

All five are true parameter-versus-ambient syntax and false comparison-site positives: the
ambient side is immutable policy, not an independently mutable observation. The observed sample
false-positive rate is therefore **5/5 (100%)**. This is a measured sample rate, not a claim that
all 530 findings were manually classified.

Five misses were also inspected: repository `inspect` compares the live and accepted heads
(`src/registry/repository-registry.ts:251`), repository `observed` repeats that comparison in its
diagnostic path (`:285`), the materialized head and tree comparisons in `WorktreeManager.create`
remain unresolved after the `Promise.all` destructure (`src/verify/worktree.ts:93`, `:94`), and
`markSent` exposes only `changes !== 1` in TypeScript while its generation fence is in SQL
(`src/outbox/outbox.ts:265`). F therefore misses ambient/ambient state, data flow it cannot resolve,
and comparisons below TypeScript. Distinguishing immutable ambient policy from mutable ambient
state would require the semantic classification F was meant to discover, so adding another name
or type proxy would only recreate D. Candidate F does not survive and is not installed.

## 3. Current count

The accepted-definition count is **unmeasured, not zero**, because no candidate survived the
boundary tests. Reporting 0 would mean “looked and found none”; that is not what happened.

For auditability, the closest enumerable proxy, candidate E, produced these 70 direct sites in
run C2. This is a rejected proxy, not the comparison-site list:

- `src/ceo/owner-authority.ts:111`, `:192`, `:265`
- `src/ceo/production-gate.ts:182`, `:202`, `:521`, `:656`, `:902`, `:1163`
- `src/continuity/continuity-kernel.ts:364`
- `src/conversation/turn-coordinator.ts:761`
- `src/cto/cto-lifecycle.ts:325`, `:461`, `:565`, `:739`
- `src/daemon/agentcpd.ts:881`, `:901`, `:937`, `:944`, `:954`, `:1072`, `:1096`
- `src/daemon/finalizer.ts:387`, `:399`
- `src/github/confirmed-merge-operation.ts:124`
- `src/github/github-kernel.ts:403`, `:452`, `:660`, `:955`, `:977`, `:1047`, `:1082`,
  `:1114`, `:1136`, `:1142`, `:1569`, `:1704`, `:1712`, `:1787`, `:1912`, `:1950`,
  `:1969`, `:1987`, `:2028`, `:2089`
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

Missed but ambiguous under candidates A–F:

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

## 6. Existing decision, naming gap, and next step

The handoff agreement in `docs/handoff/20260815-acp-state.md` remains valid and this census does not
replace it: the rule applies to **new staleness denials**, while the existing 75 no-pair raise sites
form a baseline that must not grow and are repaired when touched. The 75 is that handoff's broader
raise-site inventory, not candidate E's 70 direct TypeScript calls; this document does not silently
rebaseline one to the other. The earlier proposal to wait for a future first defect conflicts with
that agreement and is withdrawn.

The exact naming request said to have been made on 2026-08-19 could not be recovered from `docs/`
or the local commit history. The closest record is the handoff's “Two decisions waiting on the
총괄”: A1 item 3 asked how the two staleness sides should be represented when existing sites used
inconsistent names. Its later ratchet section settles when enforcement begins and fixes 75 as the
baseline, but it does not state canonical operand names. Therefore the unresolved item is the
canonical naming contract for the two recorded sides, blocked on the 총괄/issue authority; the exact
alternatives and any more specific recipient are **unmeasured from the local record**.

The next implementation pass must start from the settled new-denial/75-baseline agreement after
that naming decision, not wait for another production defect. This change installs none of A–F:
the accepted comparison-site count and a mechanism implementing the agreement remain
**unmeasured**.
