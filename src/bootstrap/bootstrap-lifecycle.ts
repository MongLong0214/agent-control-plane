import { REPO_FACTORY_RESULT_SCHEMA_ID } from "./repo-factory-result.ts";

/**
 * What the control plane does with a project-less bootstrap after its CEO CONFIRM, stated for the
 * BOOTSTRAP_PLAN reviewer. The bootstrap PLAN carries one task and one repository create; reading the
 * repository back, parsing the result and activating the manifest, and handing the project to its
 * PRIMARY_CTO are the control plane's steps, not the PLAN's — and a reviewer that was never told so
 * returned them as missing from the PLAN (live run_7717, twice).
 *
 * Every item names the code that makes it true: the file, the function whose body enforces it, and
 * the refusals or checks in that body it rests on. `bootstrap-lifecycle-contract.test.ts` reads each
 * body and fails when one of them is gone, so a statement cannot outlive its enforcement. Three kinds
 * are kept apart, and nothing declared-only is stated as a guarantee:
 *
 * - PLAN_REQUIREMENT — what the PLAN itself must satisfy, checked before it is reviewed at all;
 * - IMPLEMENTED_GUARANTEE — what the control plane enforces after CONFIRM, as code that refuses;
 * - NOT_VERIFIED — a condition the code does not check. Its site names the check that is absent
 *   (`absent`), so the test fails, and the item must be moved, once someone adds it.
 */

export const BootstrapLifecycleKind = {
  PLAN_REQUIREMENT: "PLAN_REQUIREMENT",
  IMPLEMENTED_GUARANTEE: "IMPLEMENTED_GUARANTEE",
  NOT_VERIFIED: "NOT_VERIFIED",
} as const;
export type BootstrapLifecycleKind = (typeof BootstrapLifecycleKind)[keyof typeof BootstrapLifecycleKind];

export interface BootstrapLifecycleSite {
  /** Repository-relative source file. */
  file: string;
  /** The function or method whose body (with its doc comment) enforces the item. */
  symbol: string;
  /** Text that must appear in that body: the refusal or the check the statement rests on. */
  enforces: readonly string[];
  /** Text that must not appear in it: for a NOT_VERIFIED item, the check it reports as absent. */
  absent?: readonly string[];
}

export interface BootstrapLifecycleItem {
  id: string;
  kind: BootstrapLifecycleKind;
  statement: string;
  sites: readonly BootstrapLifecycleSite[];
}

const GITHUB = "src/bootstrap/repo-factory-github.ts";
const RUNNER = "src/bootstrap/repo-factory-bootstrap-run.ts";
const ACTIVATION = "src/bootstrap/activation.ts";
const TASKS = "src/run/task-graph.ts";
const GATE = "src/ceo/production-gate.ts";
const PLAN = "src/bootstrap/bootstrap-plan.ts";
const APPLICATIONS = "src/bootstrap/bootstrap-applications.ts";

export const BOOTSTRAP_POST_CONFIRM_LIFECYCLE: readonly BootstrapLifecycleItem[] = Object.freeze([
  {
    id: "plan-one-repository-create",
    kind: BootstrapLifecycleKind.PLAN_REQUIREMENT,
    statement:
      "The PLAN's first GitHub operation creates the repository, and the PLAN creates exactly one repository; a PLAN that does not has no planned outputs and is not reviewed.",
    sites: [
      {
        file: GITHUB,
        symbol: "preflightGitHubOperations",
        enforces: ["the first GitHub operation must create the repository every later operation targets", "a plan creates exactly one repository"],
      },
      { file: "src/bootstrap/bootstrap-plan.ts", symbol: "plannedBootstrapOutputs", enforces: ["preflightGitHubOperations(", "UNSUPPORTED_PLAN_SHAPE"] },
    ],
  },
  {
    id: "plan-one-task",
    kind: BootstrapLifecycleKind.PLAN_REQUIREMENT,
    statement:
      "The run reaches this review with exactly one live task, and it is READY; a run whose task has an execution or is already SUCCEEDED is not reviewed, nor, once the run has a BOOTSTRAP_PLAN_TASKS record, one whose task no such record binds to the current PLAN.",
    sites: [
      {
        file: TASKS,
        symbol: "bootstrapReviewEntry",
        enforces: ["BOOTSTRAP_TASK_HAS_EXECUTION", "BOOTSTRAP_TASK_SUCCEEDED_BEFORE_CONFIRM", "BOOTSTRAP_PLAN_TASK_COUNT", "BOOTSTRAP_TASK_NOT_OF_CURRENT_PLAN"],
      },
      { file: "src/run/candidate-pipeline.ts", symbol: "reviewEntry", enforces: ["this.tasks.bootstrapReviewEntry("] },
    ],
  },
  {
    id: "github-write-readback",
    kind: BootstrapLifecycleKind.IMPLEMENTED_GUARANTEE,
    statement:
      "After CONFIRM the Repo Factory producer records each GitHub write's receipt in its attempt ledger only after reading the effect back from GitHub; a create-only plan's create is receipted only when GitHub reports the created repository, the plan's default branch as its default branch, and a commit with no parent at that branch's head.",
    sites: [
      {
        file: GITHUB,
        symbol: "applyGitHubOperations",
        enforces: [
          "if (!step.allowed) return step",
          "receipts.set(receipt.operationId, receipt);",
          "WRONG_TARGET",
          "INITIALIZED_BRANCH_MISMATCH",
          "INITIALIZED_HEAD_HAS_PARENT",
          "REREAD_MISMATCH",
        ],
      },
    ],
  },
  {
    id: "completion-on-ledger",
    kind: BootstrapLifecycleKind.IMPLEMENTED_GUARANTEE,
    statement:
      "The CONFIRM transaction completes the run only on a WRITTEN application of the confirmed candidate whose attempt ledger holds a receipt for every planned write, none pending, and whose stored result's receipts are exactly the ledger's: the PLAN's one repository create has exactly one receipt.",
    sites: [
      { file: RUNNER, symbol: "verifyCompletionChain", enforces: ["APPLICATION_NOT_WRITTEN", "this.completionChain(application)"] },
      { file: RUNNER, symbol: "completionChain", enforces: ["this.writtenChain("] },
      {
        file: RUNNER,
        symbol: "writtenChain",
        enforces: [
          "ledger.value.pending.size > 0",
          "the attempt ledger does not hold a receipt for every planned write",
          "the stored result's write receipts are not the ones the attempt ledger holds",
        ],
      },
      { file: GATE, symbol: "submitCeoDecision", enforces: ["chain.verifyCompletionChain(input.runId, input.candidateSnapshotDigest)"] },
    ],
  },
  {
    id: "task-settled-from-create-receipt",
    kind: BootstrapLifecycleKind.IMPLEMENTED_GUARANTEE,
    statement:
      "In that transaction the PLAN's one task moves READY to SUCCEEDED only on a verified create receipt, in the stored producer result, for the PLAN's first operation, and only while a BOOTSTRAP_PLAN_TASKS record binds that task to the current PLAN (no legacy task is settled); a run's create receipt settles one task only.",
    sites: [
      {
        file: TASKS,
        symbol: "settleBootstrapExecutionTask",
        enforces: [
          "OUTSIDE_CONFIRM_TRANSACTION",
          "CREATE_RECEIPT_NOT_BOUND",
          "row.verified",
          "RECEIPT_ALREADY_SETTLED",
          "bootstrapPlanTaskRecorded(this.db, input.runId, input.taskId, input.planDigest)",
          "BOOTSTRAP_TASK_PLAN_UNRECORDED",
        ],
      },
      { file: GATE, symbol: "settleBootstrapTask", enforces: ["this.tasks.settleBootstrapExecutionTask("] },
      { file: GATE, symbol: "submitCeoDecision", enforces: ["this.settleBootstrapTask(input)"] },
    ],
  },
  {
    // Review of run_7717 (F5) — the application's terminal state, stated with the code that sets it.
    id: "application-completed",
    kind: BootstrapLifecycleKind.IMPLEMENTED_GUARANTEE,
    statement:
      "In that transaction, after the run's COMPLETED transition, the confirmed candidate's WRITTEN producer application moves WRITTEN to COMPLETED; an application of another candidate, or one not WRITTEN, is refused, and the run's COMPLETED rolls back with it.",
    sites: [
      {
        file: APPLICATIONS,
        symbol: "markCompleted",
        enforces: ['this.move(runId, "WRITTEN", "COMPLETED", null, "BOOTSTRAP_APPLICATION_COMPLETED")', "the bootstrap application was reserved for another candidate than the one completing"],
      },
      {
        file: GATE,
        symbol: "submitCeoDecision",
        enforces: ["applications.markCompleted(input.runId, input.candidateSnapshotDigest)", "if (!completed.allowed) throw acpError(completed.reasonCode, completed.message, completed.evidence);"],
      },
    ],
  },
  {
    id: "result-parsed",
    kind: BootstrapLifecycleKind.IMPLEMENTED_GUARANTEE,
    statement:
      `The producer's result is parsed as ${REPO_FACTORY_RESULT_SCHEMA_ID}, refused with any unverified receipt, at activation (refused there with any unresolved gap) and again in the CONFIRM transaction, where it must name this run, operation, PLAN and manifest.`,
    sites: [
      { file: "src/bootstrap/repo-factory-result.ts", symbol: "parseRepoFactoryResult", enforces: ["repoFactoryResultSchema.safeParse(input)", "!r.verified || !r.rereadAt"] },
      { file: ACTIVATION, symbol: "activate", enforces: ["parseRepoFactoryResult(input.factoryResult)", "bootstrap reported unresolved gaps"] },
      {
        file: RUNNER,
        symbol: "writtenChain",
        enforces: ["parseRepoFactoryResult(retained.content)", "result.planDigest !== application.planDigest", "result.projectManifestDigest !== application.manifestDigest"],
      },
    ],
  },
  {
    id: "manifest-activation",
    kind: BootstrapLifecycleKind.IMPLEMENTED_GUARANTEE,
    statement:
      "Activation refuses a result whose manifest digest is not the approved manifest's (the one this PLAN names), registers the project on the approved manifest, and refuses an existing project whose active manifest is another; the CONFIRM transaction then requires every local repository binding to be on the project's active manifest.",
    sites: [
      {
        file: ACTIVATION,
        symbol: "activate",
        enforces: ["applied manifest digest differs from the approved digest", "CONTRACT_CHANGE_REQUIRES_DEDICATED_RUN", "activeManifestDigest: approvedDigest"],
      },
      {
        file: ACTIVATION,
        symbol: "validateFactoryProvenance",
        enforces: ["planArtifact.digest !== result.planDigest", "plan.projectManifestDigest !== approvedManifestDigest"],
      },
      { file: ACTIVATION, symbol: "finalizeBootstrapActivationConfirm", enforces: ["local.activeManifestDigest !== project?.activeManifestDigest"] },
    ],
  },
  {
    id: "primary-cto-handoff",
    kind: BootstrapLifecycleKind.IMPLEMENTED_GUARANTEE,
    statement:
      "Activation binds the project's PRIMARY_CTO through the driven door, a fresh session driven on the headless runtime whose handoff is delivered in band (an active binding of that role is reused), and opens a BOOTSTRAP handoff to that session; only the session it was opened to can acknowledge it. An interactive holder with no Buzz identity, whose PENDING handoff was REJECTED undeliverable, is replaced on the activation retry by a driven one in one switch that records its reason, and the handoff is reissued to it as a new PENDING package for a new ACK.",
    sites: [
      { file: ACTIVATION, symbol: "activate", enforces: ["this.cto.ensureDrivenPrimaryCto(projectId, input.runId, undeliverable ?? undefined)", "this.openActivationHandoff("] },
      {
        file: ACTIVATION,
        symbol: "undeliverableHandoff",
        enforces: ['drivenModeOf(this.db, binding.sessionId) !== "NONE"', "session.buzzActorId", 'message.status !== "REJECTED"', 'row?.status !== "PENDING"'],
      },
      { file: ACTIVATION, symbol: "reissuedToReplacement", enforces: ["PRIMARY_CTO_UNDELIVERABLE_REPLACED", 'row?.status !== "PENDING"'] },
      { file: ACTIVATION, symbol: "acknowledgeActivationHandoff", enforces: ["row.to_session_id !== ackBySessionId", "ack must come from the incoming session"] },
    ],
  },
  {
    // Review of run_7717 (F4), PR #1122 R1 (BCG-R1-01, BCG-R1-02).
    id: "handoff-observed-facts",
    kind: BootstrapLifecycleKind.IMPLEMENTED_GUARANTEE,
    statement:
      "The handoff activation delivers carries the repository facts selected from the stored producer result bound to the PLAN's target repository, default branch and required verification; every verification row for that repository must name the one head the required row names, and a result with conflicting rows is refused at activation, before any handoff. The planned outputs' handoff above shows the facts null because the PLAN precedes the create. An ACK is accepted, an ACK is relied on, and a CONFIRM completes only while the delivered package, ACKed or not, carries exactly those facts; the CONFIRM's completion chain requires them to be the create execution's own readback in the attempt ledger (for a create-only plan, the default branch GitHub reported and the parentless head it initialized). An activation retry reissues a persisted handoff without them as a fresh PENDING package for a new ACK from the current PRIMARY_CTO; the earlier handoff is kept and proves nothing.",
    sites: [
      {
        file: PLAN,
        symbol: "observedRepositoryFacts",
        enforces: ["repository.identity !== target.repositoryIdentity", "heads.length !== 1", "row.commandId === target.verificationCommandId", "RESULT_FACTS_UNBOUND"],
      },
      { file: ACTIVATION, symbol: "activate", enforces: ["observedRepositoryFacts(result, factsTargetOf(current.value.outputs))", "deliveredBootstrapHandoff(input.handoff, facts.value)"] },
      { file: ACTIVATION, symbol: "acknowledgeActivationHandoff", enforces: ["this.observedHandoffFacts("] },
      { file: ACTIVATION, symbol: "acknowledgedActivationHandoff", enforces: ["this.observedHandoffFacts(handoffId"] },
      { file: ACTIVATION, symbol: "finalizeBootstrapActivationConfirm", enforces: ["this.observedHandoffFacts(handoffArtifact.content.handoffId"] },
      {
        file: ACTIVATION,
        symbol: "handoffFactsObserved",
        enforces: ["HANDOFF_FACTS_NOT_OBSERVED", "observedRepositoryFacts(parsed.value, factsTargetOf(plan.value.outputs))", "handoffFactsAre(handoff, expected)"],
      },
      { file: ACTIVATION, symbol: "reissuable", enforces: ["!this.observedHandoffFacts(recorded.handoffId", "factless(recorded.handoff) === factless(handoff)"] },
      { file: RUNNER, symbol: "writtenChain", enforces: ["created.observed.initializedHead", "this execution's readback in the attempt ledger"] },
    ],
  },
  {
    id: "handoff-ack-gate",
    kind: BootstrapLifecycleKind.IMPLEMENTED_GUARANTEE,
    statement:
      "The CONFIRM transaction completes the run only while a PRIMARY_CTO binding is active and the run's BOOTSTRAP handoff is ACKED by the session it was opened to.",
    sites: [
      { file: ACTIVATION, symbol: "finalizeBootstrapActivationConfirm", enforces: ["this.acknowledgedActivationHandoff(", "this.incompleteness(activation"] },
      { file: ACTIVATION, symbol: "acknowledgedActivationHandoff", enforces: ["status = 'ACKED'"] },
      { file: ACTIVATION, symbol: "incompleteness", enforces: ['missing.push("primaryCtoBinding")', 'missing.push("handoffAck")'] },
      { file: GATE, symbol: "submitCeoDecision", enforces: ["finalizer.finalizeBootstrapActivationConfirm("] },
    ],
  },
  {
    // Review of run_7717 (F2).
    id: "confirm-manifest-recheck",
    kind: BootstrapLifecycleKind.IMPLEMENTED_GUARANTEE,
    statement:
      "The CONFIRM transaction completes the run only while the project's active manifest digest is this PLAN's projectManifestDigest and the produced repository is the PLAN's planned target, bound on that manifest; a manifest moved after activation, with its bindings or without, is refused.",
    sites: [
      {
        file: ACTIVATION,
        symbol: "finalizeBootstrapActivationConfirm",
        enforces: [
          "plan.value.binding.projectManifestDigest",
          "project?.activeManifestDigest !== plannedManifestDigest",
          "ACTIVE_MANIFEST_NOT_PLANNED",
          "repository.identity !== target.repositoryIdentity",
          "local.activeManifestDigest !== project?.activeManifestDigest",
        ],
      },
    ],
  },
  {
    // Review of run_7717 (F3).
    id: "confirm-ack-recipient",
    kind: BootstrapLifecycleKind.IMPLEMENTED_GUARANTEE,
    statement:
      "The CONFIRM transaction completes the run only while the session the BOOTSTRAP handoff was opened to, the only one that can acknowledge it, is the project's active PRIMARY_CTO binding; after a reassignment it is refused, since the replacement has acknowledged nothing. Only the activation retry's own replacement of an undeliverable recipient redelivers a bootstrap handoff, as a new package to the replacement, whose ACK is then the one required.",
    sites: [
      {
        file: ACTIVATION,
        symbol: "finalizeBootstrapActivationConfirm",
        enforces: ["primary.sessionId !== handoffArtifact.content.toSessionId", "ACK_RECIPIENT_NOT_PRIMARY_CTO"],
      },
      { file: ACTIVATION, symbol: "acknowledgeActivationHandoff", enforces: ["row.to_session_id !== ackBySessionId"] },
    ],
  },
  {
    // Review of #1119, BPI-R1-02 — the legacy exception `plan-one-task` leaves out, disclosed.
    id: "plan-task-legacy-provenance",
    kind: BootstrapLifecycleKind.NOT_VERIFIED,
    statement:
      "At review entry, for a run with no BOOTSTRAP_PLAN_TASKS record (planned before plan_submit wrote one), that its one live task was created with the current PLAN is not checked: the task is accepted for review as the current PLAN's while it is the run's only live task. The CONFIRM settlement does not accept it (task-settled-from-create-receipt), and this run's own case is stated as plan-task-provenance-this-run.",
    sites: [{ file: TASKS, symbol: "boundToBootstrapPlan", enforces: ["if (bindings.length === 0) return liveTasks === 1;"] }],
  },
  {
    id: "forged-ledger",
    kind: BootstrapLifecycleKind.NOT_VERIFIED,
    statement:
      "Creation provenance against a ledger forged by the same OS account is not verified (recorded limit C5I-R1-01): such a ledger can make a preexisting repository pass the create-only readback, since the ledger's ownership and mode checks show only that this account wrote it. That is the approved trust boundary, the single local owner account, and not an exemption from any check: the external create receipt and its readback, the wrong-target refusal and the pre-existence refusal apply to every create unchanged.",
    sites: [
      {
        file: GITHUB,
        symbol: "applyGitHubOperations",
        enforces: [
          "Limit (review C5I-R1-01)",
          "WRONG_TARGET",
          "already exists and carries no receipt from this bootstrap operation",
          "INITIALIZED_HEAD_HAS_PARENT",
          "REREAD_MISMATCH",
        ],
      },
    ],
  },
] satisfies BootstrapLifecycleItem[]);

const KIND_HEADINGS: ReadonlyArray<[BootstrapLifecycleKind, string]> = [
  [BootstrapLifecycleKind.PLAN_REQUIREMENT, "Plan-level requirements, checked before this review (a PLAN that fails one is not reviewed):"],
  [BootstrapLifecycleKind.IMPLEMENTED_GUARANTEE, "Guarantees the control plane implements after CONFIRM:"],
  [BootstrapLifecycleKind.NOT_VERIFIED, "Conditions the control plane does not verify:"],
];

/**
 * Review of run_7717 (F6) — this run's own PLAN-task provenance, read from the store
 * (`bootstrapPlanTaskRecorded`) when the review is constituted: its one live task, the current PLAN, and
 * whether a BOOTSTRAP_PLAN_TASKS record binds them. Never asserted by a caller.
 */
export interface BootstrapPlanTaskProvenance {
  taskId: string | null;
  planDigest: string;
  recorded: boolean;
}

const PROVENANCE_SITE = `${TASKS} bootstrapPlanTaskRecorded`;

/** This run's line: an enforced fact when the record binds its task, the NOT_VERIFIED disclosure when it does not. */
const planTaskProvenanceLine = (run: BootstrapPlanTaskProvenance): [BootstrapLifecycleKind, string] =>
  run.recorded && run.taskId !== null
    ? [
        BootstrapLifecycleKind.IMPLEMENTED_GUARANTEE,
        `- [plan-task-provenance-this-run] For this run, read from the store when this review was constituted: its READY task ${run.taskId} is bound to its current PLAN ${run.planDigest} by a BOOTSTRAP_PLAN_TASKS record, so the legacy exception plan-task-legacy-provenance does not apply to it. (${PROVENANCE_SITE})`,
      ]
    : [
        BootstrapLifecycleKind.NOT_VERIFIED,
        `- [plan-task-provenance-this-run] For this run, read from the store when this review was constituted: its live task ${run.taskId ?? "(none)"} has no BOOTSTRAP_PLAN_TASKS record binding it to its current PLAN ${run.planDigest}, so that it was created with this PLAN is not verified, and the CONFIRM settlement refuses it until the PLAN is submitted again. (${PROVENANCE_SITE})`,
      ];

/**
 * The lifecycle section of the BOOTSTRAP_PLAN review prompt, rendered from the items above and, when the
 * run is named, its own PLAN-task provenance line.
 */
export const bootstrapLifecycleSection = (run?: BootstrapPlanTaskProvenance): string[] => {
  const own = run === undefined ? null : planTaskProvenanceLine(run);
  return [
    "## Control-plane lifecycle after CEO CONFIRM",
    "These are statements about the control plane's code, not about this PLAN, and not a request to pass it. Each",
    "is kept beside the code named with it and tested against that code. Evaluate them as facts: a gap in them,",
    "in their enforcement, or in how this plan's outputs meet the contract is a finding.",
    ...KIND_HEADINGS.flatMap(([kind, heading]) => [
      "",
      heading,
      ...BOOTSTRAP_POST_CONFIRM_LIFECYCLE.filter((item) => item.kind === kind).map(
        (item) => `- [${item.id}] ${item.statement} (${[...new Set(item.sites.map((site) => `${site.file} ${site.symbol}`))].join("; ")})`,
      ),
      ...(own !== null && own[0] === kind ? [own[1]] : []),
    ]),
    "",
  ];
};
