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
      "The run reaches this review with exactly one live task, READY and created with the current PLAN; a run whose task has an execution or is already SUCCEEDED is not reviewed.",
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
      "In that transaction the PLAN's one task moves READY to SUCCEEDED only on a verified create receipt, in the stored producer result, for the PLAN's first operation; a run's create receipt settles one task only.",
    sites: [
      {
        file: TASKS,
        symbol: "settleBootstrapExecutionTask",
        enforces: ["OUTSIDE_CONFIRM_TRANSACTION", "CREATE_RECEIPT_NOT_BOUND", "row.verified", "RECEIPT_ALREADY_SETTLED"],
      },
      { file: GATE, symbol: "settleBootstrapTask", enforces: ["this.tasks.settleBootstrapExecutionTask("] },
      { file: GATE, symbol: "submitCeoDecision", enforces: ["this.settleBootstrapTask(input)"] },
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
      "Activation binds the project's PRIMARY_CTO (an active binding of that role is reused) and opens a BOOTSTRAP handoff to that session; only the session it was opened to can acknowledge it.",
    sites: [
      { file: ACTIVATION, symbol: "activate", enforces: ["this.cto.ensurePrimaryCto(projectId, input.runId)", "this.openActivationHandoff("] },
      { file: ACTIVATION, symbol: "acknowledgeActivationHandoff", enforces: ["row.to_session_id !== ackBySessionId", "ack must come from the incoming session"] },
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
    id: "confirm-manifest-recheck",
    kind: BootstrapLifecycleKind.NOT_VERIFIED,
    statement:
      "The CONFIRM transaction does not compare the project's active manifest digest with this PLAN's projectManifestDigest; that comparison is made at activation, before the CONFIRM transaction.",
    sites: [
      {
        file: ACTIVATION,
        symbol: "finalizeBootstrapActivationConfirm",
        enforces: ["activeManifestDigest: project?.activeManifestDigest"],
        absent: ["projectManifestDigest", "manifestDigest("],
      },
    ],
  },
  {
    id: "confirm-ack-recipient",
    kind: BootstrapLifecycleKind.NOT_VERIFIED,
    statement:
      "The CONFIRM transaction does not check that the session which acknowledged the handoff is the PRIMARY_CTO binding active at CONFIRM: it reads the handoff's recipient from the run's HANDOFF artifact and the binding separately.",
    sites: [
      {
        file: ACTIVATION,
        symbol: "finalizeBootstrapActivationConfirm",
        enforces: ["handoffArtifact.content.toSessionId", "this.bindings.active(roleKeyFor(Role.PRIMARY_CTO, { projectId }))"],
        absent: ["primary.sessionId !==", "!== primary.sessionId", "primary?.sessionId !==", "!== primary?.sessionId"],
      },
    ],
  },
  {
    id: "forged-ledger",
    kind: BootstrapLifecycleKind.NOT_VERIFIED,
    statement:
      "A ledger forged by the same OS account can make a preexisting repository pass the create-only readback (recorded limit C5I-R1-01): the ledger's ownership and mode checks show only that this account wrote it.",
    sites: [{ file: GITHUB, symbol: "applyGitHubOperations", enforces: ["Limit (review C5I-R1-01)"] }],
  },
] satisfies BootstrapLifecycleItem[]);

const KIND_HEADINGS: ReadonlyArray<[BootstrapLifecycleKind, string]> = [
  [BootstrapLifecycleKind.PLAN_REQUIREMENT, "Plan-level requirements, checked before this review (a PLAN that fails one is not reviewed):"],
  [BootstrapLifecycleKind.IMPLEMENTED_GUARANTEE, "Guarantees the control plane implements after CONFIRM:"],
  [BootstrapLifecycleKind.NOT_VERIFIED, "Conditions the control plane does not verify:"],
];

/** The lifecycle section of the BOOTSTRAP_PLAN review prompt, rendered from the items above alone. */
export const bootstrapLifecycleSection = (): string[] => [
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
  ]),
  "",
];
