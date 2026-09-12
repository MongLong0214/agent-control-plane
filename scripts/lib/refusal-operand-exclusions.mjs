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
 * It also carries the size, because the size is the decision. Measured at this commit: these 87
 * files hold **3,462** `&&`/`||` operands, against 456 in the nine selected files. Lifting the
 * list wholesale would grow the census roughly ninefold and require a falsifiability row or an
 * UNANSWERED reason for each of those 3,462 — which is this same boilerplate multiplied, not its
 * repair. So the list is worked down per file, and a reader deciding how to do that should see
 * 3,462 rather than derive it.
 *
 * Re-derive it rather than trusting it, because a number in prose is exactly what goes stale here
 * — this line said 88/3,489 until `src/registry/project-registry.ts` left the list:
 *
 *     emptying this Map and running `pnpm guards:operands` reports the repository total
 *     (3,918 at this commit); the census's own PASS line reports what it currently sees (456).
 *     The difference is this list.
 *
 * One shared sentence is correct here and is not the defect #833 names: the reason genuinely is
 * one reason. Inventing 87 different sentences for 87 files whose backlog has one cause would be
 * boilerplate wearing a disguise. What was wrong was that the sentence was false.
 */
const reason =
  "pre-existing operands not yet answered; entered the census when selection became derived; " +
  "tracked as #833, which measured 3,462 operands across these 87 files";

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
  ["src/core/peercred.ts", reason],
  ["src/core/process-argv.ts", reason],
  ["src/core/process-identity.ts", reason],
  ["src/cto/cto-lifecycle.ts", reason],
  ["src/daemon/canonical-self-claim-operator.ts", reason],
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
  ["src/registry/conversational-actor-registry.ts", reason],
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
  ["src/session/session-registry.ts", reason],
  ["src/snapshot/candidate-snapshot.ts", reason],
  ["src/tools/traceability.ts", reason],
  ["src/verify/sandbox.ts", reason],
  ["src/verify/verification-engine.ts", reason],
  ["src/verify/worktree.ts", reason],
]);
