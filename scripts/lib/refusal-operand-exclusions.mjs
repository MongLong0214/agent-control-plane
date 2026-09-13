/**
 * Pre-existing operands not yet answered; entered the census when selection became derived.
 * These files have NOT been assessed as non-deciding.
 * Remove a name to bring its operands into scope; no inclusion list exists.
 * sol-simplify: the requested backlog remains visible; remove entries as their operands are answered.
 *
 * The reason used to end "tracked as its own unit" and name no unit. When #833 measured that,
 * `gh issue list --limit 300` returned no such issue — the sentence pointed at nothing, for every
 * one of these files. #833 is that unit now, and the reason says so rather than implying it.
 *
 * The size is the decision — lifting the list wholesale would grow the census by an order of
 * magnitude and require a falsifiability row or an UNANSWERED reason for every operand in it,
 * which is this same boilerplate multiplied rather than its repair. So the list is worked down
 * per file, and a reader deciding how to do that needs the number.
 *
 * **The number is not written here.** It was, three times, and each time it went stale: the line
 * said eighty-nine, then eighty-eight, then eighty-seven as files left the list, and three
 * branches that each decremented it from their own base made the rebase conflict on the literal
 * instead of on any logic. Resolving one of those by adding the decrements is precisely the
 * staleness the line itself warned about.
 *
 * Spelled out, not written as digits, and that is not style. The guard forbids *today's count*
 * rather than any number, so a historical figure sitting here as a numeral goes red the day the
 * live count drifts onto it -- a merge-gate review measured `87` here and `89` in the sibling
 * header as already matchable, and `excluded` walks toward them as #833 is worked down. The
 * collision is in the prose, not in the predicate, so the prose is what changes.
 *
 *     pnpm guards:operands
 *     CENSUS: … excluded N deciding file(s) holding M unanswered operand(s)
 *
 * The census counts this Map every run, so the number cannot disagree with the list. It prints all
 * three numbers in that one line -- selected, excluded, and the repository total -- so the size of
 * this list is the total minus the selected count and needs no second run.
 *
 * An earlier version of this paragraph said to empty the Map and run it again for the total. That
 * instruction outlived the line above it and became worse than unnecessary: with the Map emptied
 * every excused operand becomes an unanswered one, so the census refuses and exits non-zero.
 * Following it produces a red gate and no total at all.
 *
 * No figure appears in this paragraph, and that is the rule rather than an accident: the guard in
 * tests/unit/the-census-prints-its-own-counts.test.ts refuses a header that restates any count the
 * census derives. It caught the first draft of these very sentences, which quoted the refusal's
 * numbers.
 *
 * One shared sentence is correct here and is not the defect #833 names: the reason genuinely is
 * one reason. Inventing a different sentence per file, for files whose backlog has one cause,
 * would be boilerplate wearing a disguise. What was wrong was that the sentence was false.
 */
const reason =
  "pre-existing operands not yet answered; entered the census when selection became derived; " +
  "tracked as #833; `pnpm guards:operands` prints how many operands this list still covers";

export const FILE_EXCLUSIONS = new Map([
  ["src/acceptance/disposable-realm-driver.ts", reason],
  ["src/acceptance/disposable-realm.ts", reason],
  ["src/app/control-plane.ts", reason],
  ["src/bootstrap/activation.ts", reason],
  ["src/bootstrap/hermes-bootstrap.ts", reason],
  ["src/bootstrap/repo-factory-producer.ts", reason],
  ["src/bootstrap/repo-factory-result.ts", reason],
  ["src/buzz/buzz-adapter.ts", reason],
  ["src/buzz/buzz-mention-subscriber.ts", reason],
  ["src/capacity/capacity-monitor.ts", reason],
  ["src/capacity/usage-collectors.ts", reason],
  ["src/ceo/human-gate.ts", reason],
  ["src/ceo/owner-authority.ts", reason],
  ["src/ceo/production-gate.ts", reason],
  ["src/claims/claim-registry.ts", reason],
  ["src/cli/agentctl.ts", reason],
  ["src/continuity/continuity-kernel.ts", reason],
  ["src/contracts/manifest.ts", reason],
  ["src/contracts/verification-command.ts", reason],
  ["src/conversation/settle-from-contact.ts", reason],
  ["src/conversation/turn-coordinator.ts", reason],
  ["src/core/digest.ts", reason],
  ["src/core/errors.ts", reason],
  ["src/core/process-argv.ts", reason],
  ["src/core/process-identity.ts", reason],
  ["src/cto/cto-lifecycle.ts", reason],
  ["src/daemon/dead-binding-recovery.ts", reason],
  ["src/daemon/finalizer.ts", reason],
  ["src/daemon/single-instance.ts", reason],
  ["src/db/artifacts.ts", reason],
  ["src/db/audit.ts", reason],
  ["src/db/backup.ts", reason],
  ["src/db/fd-vfs.ts", reason],
  ["src/db/migration-approval.ts", reason],
  ["src/db/migrations.ts", reason],
  ["src/db/state-admin.ts", reason],
  ["src/db/state-preflight.ts", reason],
  ["src/db/target-identity.ts", reason],
  ["src/deploy/rollback-pair.ts", reason],
  ["src/doctor/doctor.ts", reason],
  ["src/doctor/repair.ts", reason],
  ["src/domain/run-state.ts", reason],
  ["src/export/acceptance-report.ts", reason],
  ["src/export/baseline-contract.ts", reason],
  ["src/export/baseline-recorder.ts", reason],
  ["src/export/experiment-isolation.ts", reason],
  ["src/export/run-evidence.ts", reason],
  ["src/git/git.ts", reason],
  ["src/github/branch-contract.ts", reason],
  ["src/github/confirmed-merge-operation.ts", reason],
  ["src/github/credential-store.ts", reason],
  ["src/github/github-kernel.ts", reason],
  ["src/github/merge-commit-message.ts", reason],
  ["src/guard/managed-write-guard.ts", reason],
  ["src/guard/workspace-probe.ts", reason],
  ["src/ingress/buzz-message.ts", reason],
  ["src/ingress/ingress-guard.ts", reason],
  ["src/ingress/telegram-polling.ts", reason],
  ["src/ingress/telegram-router.ts", reason],
  ["src/ingress/telegram.ts", reason],
  ["src/mcp/ceo-conversation.ts", reason],
  ["src/mcp/cto-server.ts", reason],
  ["src/mcp/hermes-server.ts", reason],
  ["src/mcp/shared.ts", reason],
  ["src/outbox/outbox.ts", reason],
  ["src/registry/canonical-self-claim.ts", reason],
  ["src/registry/project-registry.ts", reason],
  ["src/registry/repository-registry.ts", reason],
  ["src/review/blind-review.ts", reason],
  ["src/run/candidate-pipeline.ts", reason],
  ["src/run/run-engine.ts", reason],
  ["src/run/task-graph.ts", reason],
  ["src/runtime/cli-adapters.ts", reason],
  ["src/runtime/hermes-acp-client.ts", reason],
  ["src/runtime/hermes-ceo.ts", reason],
  ["src/runtime/hermes-target-bind.ts", reason],
  ["src/runtime/provider.ts", reason],
  ["src/runtime/reviewer-egress.ts", reason],
  ["src/runtime/scripted-adapter.ts", reason],
  ["src/snapshot/candidate-snapshot.ts", reason],
  ["src/tools/traceability.ts", reason],
  ["src/verify/sandbox.ts", reason],
  ["src/verify/verification-engine.ts", reason],
  ["src/verify/worktree.ts", reason],
]);
