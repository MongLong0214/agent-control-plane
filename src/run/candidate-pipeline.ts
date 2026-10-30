import { type CommitLorePort, commitloreGoverned, checkGeneratedCommitMessage, createCommitLoreCliPort } from "../bootstrap/commitlore-observation.ts";
import { randomUUID } from "node:crypto";

import {
  bootstrapPlanIntentTasks,
  bootstrapReviewIntentCurrent,
  currentBootstrapPlan,
  isProjectlessBootstrap,
  sameBootstrapPlanBinding,
} from "../bootstrap/bootstrap-plan.ts";
import { collectBootstrapCeoDecisions, frozenBootstrapCeoDecisions } from "../bootstrap/bootstrap-ceo-decisions.ts";
import { collectBootstrapReviewEvidence } from "../bootstrap/bootstrap-review-evidence.ts";
import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, type Evidence, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { commandsForMode, type BranchProfile } from "../contracts/manifest.ts";
import type { VerificationCommand } from "../contracts/verification-command.ts";
import { EVIDENCE_PRODUCERS, type ArtifactStore } from "../db/artifacts.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { ArtifactKind, type RunRow, RunState } from "../domain/types.ts";
import { requiredBaseFor, sourceProbeBranchesFor } from "../github/branch-contract.ts";
import { currentBranch, mergeBase, revParse, tryRevParse } from "../git/git.ts";
import { MessageKind } from "../outbox/envelope.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { ProductionGate, ProductionReadyPacket } from "../ceo/production-gate.ts";
import { currentContractChangeTarget, isContractChangeRun, sameContractChangeBinding, type WorkflowRevision } from "../registry/contract-change-plan.ts";
import { firstActivationFactsOf } from "../registry/manifest-activation-grants.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { RepositoryRegistry } from "../registry/repository-registry.ts";
import { residentBaseClone } from "../registry/resident-repositories.ts";
import type { BlindReviewGate, BlindReviewInvoker, ReviewPacket } from "../review/blind-review.ts";
import { captureContractChangeReviewContext, storeContractChangeReviewContext } from "../review/contract-change-review-context.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import {
  type CandidateSnapshot,
  type SnapshotRepositoryInput,
  buildCandidateSnapshot,
  buildNoRepositoryCandidateSnapshot,
  candidateSnapshotDigest,
  verifySnapshotFreshness,
} from "../snapshot/candidate-snapshot.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";
import type { VerificationEngine, VerificationReport } from "../verify/verification-engine.ts";
import {
  BASE_REF_NAMESPACE,
  CANDIDATE_REF_NAMESPACE,
  type SucceededTaskCommit,
  applyCandidateRefPlan,
  baseRefFor,
  candidateRefFor,
  candidateRefPlan,
  type CheckMergeMessage,
  integratePredecessors,
  integrateTaskResults,
  lostTaskChanges,
  succeededTaskCommits,
} from "./candidate-integration.ts";
import type { RunEngine, TaskContract } from "./run-engine.ts";
import type { TaskGraph } from "./task-graph.ts";
import { type PredecessorBase, type StartsFrom, recordedTargetForBranch } from "./task-write-target.ts";
import type { ManagedWriteGuard } from "../guard/managed-write-guard.ts";

const ATTEMPT_LEASE_TTL_MS = 30 * 60 * 1000;

/**
 * The BLIND_REVIEW_UNAVAILABLE row, built field by field and never spread from the denial. A denial
 * can carry provider text, and one free-form string over the audit's bound for an unlisted field
 * makes the audit keep none of the row: not the reason, and not the candidate the official retry
 * (daemon `#bootstrapReviewRetry`) matches on. So the row holds the candidate this attempt froze, the
 * scalar fields named here when their values are numbers, booleans or bounded identifiers (digests
 * and lengths stand in for provider text), and the reviewer attempts by preference and fixed reason.
 * The denial's reason is the row's reason code.
 */
const UNAVAILABLE_REVIEW_FIELDS = [
  "runId", "provider", "model", "effort", "problem", "chunk", "exitCode", "isolationAttested",
  "isolationReasonCode", "answerDigest", "answerLength", "errorDigest", "errorLength",
  "isolationDetailDigest", "isolationDetailLength",
] as const;
const BOUNDED_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/#+-]{0,199}$/;
const ATTEMPT_REASON = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,119}$/;
const boundedScalar = (value: unknown, shape: RegExp = BOUNDED_IDENTIFIER): string | number | boolean | null | undefined => {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  return typeof value === "string" && shape.test(value) ? value : undefined;
};

const unavailableReviewEvidence = (candidateSnapshotDigest: string, denial: Evidence | undefined, attemptId: string): Evidence => {
  const source: Record<string, unknown> = denial ?? {};
  const evidence: Record<string, unknown> = {};
  for (const field of UNAVAILABLE_REVIEW_FIELDS) {
    const value = boundedScalar(source[field]);
    if (value !== undefined) evidence[field] = value;
  }
  const attempts = source["attempts"];
  if (Array.isArray(attempts)) {
    evidence["attempts"] = attempts.slice(0, 20).map((attempt: unknown) => {
      const record = (attempt ?? {}) as { preference?: Record<string, unknown>; reason?: unknown };
      return {
        preference: {
          provider: boundedScalar(record.preference?.["provider"]) ?? null,
          model: boundedScalar(record.preference?.["model"]) ?? null,
          effort: boundedScalar(record.preference?.["effort"]) ?? null,
        },
        reason: boundedScalar(record.reason, ATTEMPT_REASON) ?? null,
      };
    });
  }
  evidence["candidateSnapshotDigest"] = candidateSnapshotDigest;
  // #1189 — the submission attempt that wrote this row, so a reader can tell it from another attempt's.
  evidence["attemptId"] = attemptId;
  return evidence as Evidence;
};

/**
 * The REVISION_RETURNED_TO_CTO row, built field by field as the UNAVAILABLE row is. The revision
 * delivered to the CTO carries the review packet or the verification report whole, and spread into
 * the row the reviewer's findings text (and the packet's egress JSONL) made the audit refuse it: the
 * row kept `{auditEvidenceRejected:true}`, its stage and candidate gone with the rest (live run_7717,
 * both REVISE rounds). So the row keeps the stage, the candidate, counts, severities and digests, and
 * names the stored BLIND_REVIEW artifact by digest; the findings themselves are read from that
 * verified artifact, never from the audit. The delivery is unchanged.
 */
const FINDING_SEVERITIES = ["INFO", "MINOR", "MAJOR", "BLOCKER"] as const;
const MAX_AUDITED_FINDING_DIGESTS = 50;

const revisionAuditEvidence = (
  delivered: Record<string, unknown>,
  review: { digest: string; content: ReviewPacket } | null,
): Evidence => {
  const candidateSnapshotDigest = boundedScalar(delivered["candidateSnapshotDigest"]) ?? null;
  if (delivered["stage"] === "verification") {
    const report = (delivered["report"] ?? null) as Partial<VerificationReport> | null;
    return {
      stage: "verification",
      candidateSnapshotDigest,
      reportDigest: digestOf(report),
      status: boundedScalar(report?.status) ?? null,
      expectedInputs: boundedScalar(report?.expectedInputs) ?? null,
      observedInputs: boundedScalar(report?.observedInputs) ?? null,
      results: Array.isArray(report?.results) ? report.results.length : null,
      gaps: Array.isArray(report?.gaps) ? report.gaps.length : null,
    } as Evidence;
  }
  if (review === null) return { stage: "blind-review", candidateSnapshotDigest, reviewArtifactDigest: null } as Evidence;
  const packet = review.content;
  const findings = Array.isArray(packet.findings) ? packet.findings : [];
  const planDigest = packet.bootstrapPlan?.planDigest ?? packet.contractChange?.planDigest;
  return {
    stage: "blind-review",
    candidateSnapshotDigest,
    reviewArtifactDigest: review.digest,
    reviewKind: packet.bootstrapPlan ? "BOOTSTRAP_PLAN" : packet.contractChange ? "CONTRACT_CHANGE" : "CANDIDATE",
    verdict: boundedScalar(packet.verdict) ?? null,
    findings: findings.length,
    findingsBySeverity: Object.fromEntries(
      FINDING_SEVERITIES.map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length]),
    ),
    findingDigests: findings.slice(0, MAX_AUDITED_FINDING_DIGESTS).map((finding) => digestOf(finding)),
    coveredFiles: packet.coveredFiles.length,
    omittedItems: packet.omittedItems.length,
    ...(planDigest === undefined ? {} : { planDigest: boundedScalar(planDigest) ?? null }),
    ...(packet.bootstrapPlanIntentDigest === undefined ? {} : { bootstrapPlanIntentDigest: boundedScalar(packet.bootstrapPlanIntentDigest) ?? null }),
  } as Evidence;
};

export interface SubmitResultInput {
  runId: string;
  ownerSessionId: string;
  ownerBindingGeneration: number;
  resultSummary: string;
  recommendation: string;
  residualRisk?: string[];
  /**
   * Run-scoped verification commands. Used only when the repository has no active
   * project manifest (§17.5); otherwise the pinned contract's commands win.
   */
  runScopedCommands?: readonly VerificationCommand[];
}

export type PipelineOutcome =
  | { stage: "COMPLETED_REVIEW"; packet: ProductionReadyPacket; snapshotDigest: string }
  | { stage: "REVISION_REQUIRED"; reasonCode: string; snapshotDigest: string; review?: ReviewPacket }
  | { stage: "VERIFICATION_FAILED"; reasonCode: string; snapshotDigest: string; report: VerificationReport }
  /**
   * §18.7 — assurance could not be constituted. Editing the candidate cannot fix a lost
   * reviewer isolation or a dead provider, so this is *not* a revision request: the run
   * waits, and continuity decides.
   */
  | {
      stage: "REVIEW_UNAVAILABLE";
      reasonCode: string;
      snapshotDigest: string;
      /**
       * Why assurance could not be constituted, not merely that it could not (#512).
       *
       * `ISOLATION_LOST` is returned from about twenty places across the reviewer path — adapter
       * not registered, adapter cannot enforce, no fresh session attested, a named probe refused,
       * egress evidence incomplete. Each of those denials already carries a distinct message and
       * evidence, and `blind-review.ts` went to the trouble of recording *which probe* refused
       * rather than only that one did. This stage dropped all of it and reported the code alone,
       * so a live run failed with a verdict that named twenty possible causes and none of them.
       *
       * The audit event beside this one keeps the evidence, so the fact was durable — it just was
       * not in the answer the caller received, which is where someone reads it.
       */
      detail: { message: string; evidence: Evidence };
    }
  /**
   * The source moved while the candidate was being judged; all its evidence is stale. Review of
   * 2bf6f98c — a freshness denial after the review keeps its message and evidence here (`detail`),
   * so what to do next (a fresh-key plan_submit) is in this answer rather than the next one.
   */
  | { stage: "CANDIDATE_STALE"; reasonCode: string; snapshotDigest: string; detail?: { message: string; evidence: Evidence } };

/**
 * A durable submission lease that a watchdog reclaimed after its holder disappeared.
 * `deadlineAt` is the deadline persisted when the lease was acquired. Recovery must honor
 * that fact rather than reconstructing a potentially changed policy from `startedAt` (#335).
 */
export interface ReclaimedCandidatePipelineAttempt {
  runId: string;
  attemptId: string;
  startedAt: string;
  deadlineAt: string;
  ageMs: number;
}

/**
 * The candidate completion path (PRD §§16–19).
 *
 * Freeze → verify → *automatically* blind review → production-ready packet. The
 * automatic step is the point: §18.2 gives the control plane the invocation, and no
 * agent-facing operation can skip, reorder or repeat it against stale evidence. A
 * REVISE verdict returns to the CTO here and never reaches Hermes (§18.6, CP-S33).
 */
export class CandidatePipeline {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly artifacts: ArtifactStore,
    private readonly runs: RunEngine,
    private readonly tasks: TaskGraph,
    private readonly projects: ProjectRegistry,
    private readonly repositories: RepositoryRegistry,
    private readonly verification: VerificationEngine,
    private readonly review: BlindReviewGate,
    private readonly invokeReview: BlindReviewInvoker,
    private readonly ceo: ProductionGate,
    private readonly bindings: BindingRegistry,
    private readonly outbox: Outbox,
    private readonly telemetry: Telemetry,
    private readonly guard: ManagedWriteGuard,
  ) {}

  #continuity: { evaluate?(reason: string): Promise<unknown> } | null = null;
  /**
   * #1268 — the CommitLore the merge commit messages of a run whose contract requires it are checked by. Defaults
   * to the pinned CLI (`createCommitLoreCliPort`); null is a deployment with none, where such a merge is not made.
   */
  #commitlore: CommitLorePort | null = createCommitLoreCliPort();

  attach(ports: { continuity?: { evaluate?(reason: string): Promise<unknown> }; commitlore?: CommitLorePort | null }): void {
    if (ports.continuity) this.#continuity = ports.continuity;
    if (ports.commitlore !== undefined) this.#commitlore = ports.commitlore;
  }

  /** #1268 — the message check a run's merge commits get, or none when its contract does not require CommitLore. */
  private checkMergeMessages(runId: string): CheckMergeMessage | undefined {
    if (!commitloreGoverned(this.db, runId)) return undefined;
    return (input) => checkGeneratedCommitMessage(this.#commitlore, input);
  }

  /**
   * Freeze the candidate across every repository participating in the run (§16.2). A submission
   * passes its attempt id, which the CANDIDATE_FROZEN row then names (#1189).
   */
  async freeze(runId: string, attemptId?: string): Promise<Decision<CandidateSnapshot>> {
    const run = this.runs.get(runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });

    const participants = this.runs.repositoriesOf(runId);

    // This is the dispatch-time contract, so a later project-profile change cannot alter
    // the branch a frozen candidate is asserted to have been cut from.
    const profile: BranchProfile | null = run.pinnedManifestDigest
      ? (this.projects.manifest(run.pinnedManifestDigest)?.branchProfile ?? null)
      : null;
    const tasks = participants.length === 0 ? [] : this.tasks.list(runId);
    // One read of the run's SUCCEEDED task commits: what the integration places and what the
    // missing-commit guard below asks the final candidate for are the same commits (S6-B, S6-C).
    const commits = participants.length === 0 ? [] : succeededTaskCommits(this.db, runId);
    const repositories: SnapshotRepositoryInput[] = [];
    // #1268 — every merge commit the integration makes has its message checked by CommitLore when the run requires it.
    const checkMergeMessages = this.checkMergeMessages(runId);
    const commitloreMessageChecked = new Map<string, number>();
    for (const repo of participants) {
      // S6-C — when the checkout's HEAD does not hold every SUCCEEDED task's commit, the candidate is
      // their integration onto the run's pinned base; a conflict between two tasks refuses the freeze.
      const integrated = await integrateTaskResults({
        db: this.db,
        runId,
        tasks,
        commits,
        repositoryIdentity: repo.identity,
        checkoutPath: repo.checkoutPath,
        worktree: (input, use) => this.verification.withRunWorktree(run, input, use),
        ...(checkMergeMessages === undefined ? {} : { checkMessage: checkMergeMessages }),
      });
      if (!integrated.allowed) return integrated as Decision<CandidateSnapshot>;
      // Recorded where a check was required or made; a run that requires none keeps its evidence as it was.
      if (integrated.value !== null && (checkMergeMessages !== undefined || integrated.value.commitloreMessageChecked > 0)) {
        commitloreMessageChecked.set(repo.identity, integrated.value.commitloreMessageChecked);
      }
      // The integrated candidate's origin is its tasks' recorded one (S-TB-06), as one task's is below.
      const source = integrated.value === null
        ? await this.sourceAtFreeze(repo.checkoutPath, repo.workBranch, repo.baseBranch, profile, { runId, identity: repo.identity })
        : profile
          ? { sourceBranch: integrated.value.declaredParent, sourceHead: integrated.value.baseSha, taskBaseHead: integrated.value.baseSha }
          : { sourceBranch: null, sourceHead: null, taskBaseHead: integrated.value.baseSha };
      const taskBaseHead = integrated.value?.baseSha ?? source.taskBaseHead;
      repositories.push({
        identity: repo.identity,
        repositoryRole: repo.repositoryRole,
        checkoutPath: repo.checkoutPath,
        baseBranch: repo.baseBranch,
        baseRef: taskBaseHead ?? repo.baseBranch,
        ...(taskBaseHead === null ? {} : { baseHeadPinned: true as const }),
        sourceBranch: source.sourceBranch,
        sourceHead: source.sourceHead,
        worktreeId: repo.worktreeId,
        manifestDigest: this.repositories.byIdentity(repo.identity)?.activeManifestDigest ?? null,
        ...(integrated.value === null ? {} : { candidateRef: integrated.value.head, integration: integrated.value.integration }),
        // #1232 — the same receipts' import manifests: an import the candidate holds byte for byte is
        // bound by blob and sha256, and its patch is not materialised (`buildCandidateSnapshot`).
        imports: commits
          .filter((commit) => commit.repositoryIdentity === repo.identity)
          .flatMap((commit) => commit.imports.map((entry) => ({ ...entry, taskId: commit.taskId }))),
      });
    }

    // #246 C2 — a project-less bootstrap run joins no repository; its candidate is its PLAN, the
    // manifest that PLAN carries and the outputs it plans. A PLAN with no plannable outputs freezes
    // nothing, so nothing can be reviewed or confirmed for it.
    let bootstrapPlan: Parameters<typeof buildNoRepositoryCandidateSnapshot>[0]["bootstrapPlan"];
    if (participants.length === 0 && isProjectlessBootstrap(run)) {
      const current = currentBootstrapPlan(runId, this.artifacts.latest<unknown>(runId, ArtifactKind.PLAN));
      if (!current.allowed) return current as Decision<CandidateSnapshot>;
      bootstrapPlan = current.value.binding;
    }
    // #246 B2-a — a CONTRACT_CHANGE candidate, with or without repositories, is also its PLAN: the
    // manifest that PLAN carries and the base it changes. A run whose PLAN carries none freezes nothing.
    // The carried manifest is what is reviewed, and what a later activation may install; the bar this
    // run is verified against stays its dispatch pin, rather than a contract the candidate proposes.
    let contractChange: Parameters<typeof buildNoRepositoryCandidateSnapshot>[0]["contractChange"];
    let boundRevisions: readonly WorkflowRevision[] = [];
    if (isContractChangeRun(run)) {
      // #512 (v45) — or a first activation, judged against the project as it stands now (E2–E6).
      const current = currentContractChangeTarget(
        run,
        this.artifacts.latest<unknown>(runId, ArtifactKind.PLAN),
        (digest) => this.projects.manifest(digest),
        firstActivationFactsOf(this.db, run),
      );
      if (!current.allowed) return current as Decision<CandidateSnapshot>;
      contractChange = current.value.binding;
      if (current.value.firstActivation) boundRevisions = current.value.workflowRevisions;
    }

    const snapshot = participants.length === 0
      ? buildNoRepositoryCandidateSnapshot(
          {
            runId,
            contractDigest: run.contractDigest,
            ...(bootstrapPlan === undefined ? {} : { bootstrapPlan }),
            ...(contractChange === undefined ? {} : { contractChange }),
          },
          this.clock,
        )
      : await buildCandidateSnapshot(
          {
            runId,
            contractDigest: run.contractDigest,
            repositories,
            ...(contractChange === undefined ? {} : { contractChange }),
          },
          this.clock,
        );

    // CEO (S6-B) — a candidate that is missing a SUCCEEDED task's own commit is refused here,
    // before it is ever persisted as this run's current candidate. Asked of the final candidate
    // head, integrated or not: the post-condition of the integration above, never replaced by it.
    if (participants.length > 0) {
      const missing = await this.missingTaskCommits(commits, snapshot.repositories, repositories);
      if (missing.length > 0) {
        return deny(
          ReasonCode.CANDIDATE_MISSING_TASK_COMMIT,
          "a SUCCEEDED task's commit is not in the candidate's history for its repository",
          { runId, missing },
        );
      }
      // S6 review — ancestry is not content: a merge that keeps one side holds a task's commit in its
      // history and none of its change. With two or more task commits, each task's change must stand
      // in the candidate's tree as the task left it.
      for (const frozen of snapshot.repositories) {
        const checkoutPath = repositories.find((repo) => repo.identity === frozen.identity)?.checkoutPath;
        if (!checkoutPath) continue;
        const lost = await lostTaskChanges({ db: this.db, runId, commits, repositoryIdentity: frozen.identity, checkoutPath, candidateHead: frozen.candidateHead });
        if (!lost.allowed) return lost as Decision<CandidateSnapshot>;
        if (lost.value.length > 0) {
          const named = lost.value.map((task) => `${task.taskId} (${task.paths.join(", ")})`).join("; ");
          return deny(
            ReasonCode.CANDIDATE_MISSING_TASK_CHANGE,
            `a SUCCEEDED task's change is not in the candidate's tree although its commit is in the candidate's history: ${named}`,
            { runId, repositoryIdentity: frozen.identity, lost: lost.value },
          );
        }
      }
    }

    const digest = candidateSnapshotDigest(snapshot);
    // S6 review — an integrated candidate is a commit no branch names. A private ref keeps it from
    // git gc for as long as it is this run's candidate; it is written, through the guard, before the
    // candidate is recorded, and a freeze that cannot write it records nothing.
    for (const frozen of snapshot.repositories) {
      if (frozen.integration === undefined) continue;
      const checkoutPath = repositories.find((repo) => repo.identity === frozen.identity)!.checkoutPath;
      const plan = await candidateRefPlan(checkoutPath, runId, { ref: candidateRefFor(runId, digest), commit: frozen.candidateHead });
      if (!plan.allowed) return plan as Decision<CandidateSnapshot>;
      const held = await this.writeCandidateRefs(run, frozen.identity, checkoutPath, plan.value.filter((line) => !line.startsWith("delete ")));
      if (!held.allowed) return held as Decision<CandidateSnapshot>;
    }

    // #1255 — what a CONTRACT_CHANGE candidate's review is shown beside its PLAN, read by ACP now, at the
    // freeze, and bound to this candidate and this freeze, so the review sees what held when it was frozen.
    const reviewContext = contractChange === undefined || run.projectId === null
      ? null
      : await captureContractChangeReviewContext(
          { db: this.db, repositories: this.repositories, clock: this.clock },
          {
            runId, projectId: run.projectId, candidateSnapshotDigest: digest, planDigest: contractChange.planDigest,
            workflowRevisions: boundRevisions,
            freezeId: `freeze_${randomUUID().replace(/-/g, "").slice(0, 24)}`, attemptId: attemptId ?? null,
          },
        );

    this.artifacts.put(runId, ArtifactKind.CANDIDATE_SNAPSHOT, snapshot, digest);
    // G-6 — a readback the store refuses is replaced by this freeze's refusal row, so the review names it
    // missing with the refusal rather than showing an earlier freeze's readback of the same candidate.
    const reviewContextOutcome = reviewContext === null ? null : storeContractChangeReviewContext(this.artifacts, reviewContext);
    // One transaction records the new candidate and stales everything bound to an older
    // one, so no window exists in which superseded evidence still reads as current.
    this.runs.promoteCandidate(runId, digest);
    // The refs of the candidates this one supersedes go now. Best effort: one left behind keeps an
    // old candidate's objects from gc, nothing more, and the next freeze asks again.
    for (const repo of repositories) {
      const frozen = snapshot.repositories.find((candidate) => candidate.identity === repo.identity);
      const keep = frozen?.integration === undefined ? null : { ref: candidateRefFor(runId, digest), commit: frozen.candidateHead };
      const plan = await candidateRefPlan(repo.checkoutPath, runId, keep);
      const superseded = plan.allowed ? plan.value.filter((line) => line.startsWith("delete ")) : [];
      if (superseded.length > 0) await this.writeCandidateRefs(run, repo.identity, repo.checkoutPath, superseded);
    }
    this.audit.record({
      kind: "CANDIDATE_FROZEN",
      runId,
      evidence: {
        candidateSnapshotDigest: digest,
        repositories: snapshot.repositories.map((r) => ({
          identity: r.identity,
          candidateHead: r.candidateHead,
          sourceBranch: r.sourceBranch ?? null,
          sourceHead: r.sourceHead ?? null,
          files: r.touchedPaths.length,
          ...(r.integration === undefined ? {} : { integratedTasks: r.integration.tasks.length }),
          // #1268 — internal execution evidence: how many merge messages CommitLore's commit-msg check passed. It is
          // no capture and no record; nothing is recorded on a merge no session produced.
          ...(commitloreMessageChecked.has(r.identity) ? { commitloreMessageChecked: commitloreMessageChecked.get(r.identity)! } : {}),
        })),
        ...(attemptId === undefined ? {} : { attemptId }),
        ...(reviewContextOutcome === null ? {} : { reviewContext: reviewContextOutcome }),
      },
    });
    return allow(ReasonCode.OK, snapshot);
  }

  async submitResult(input: SubmitResultInput): Promise<Decision<PipelineOutcome>> {
    // A caller that cannot prove the run owner must not be able to reserve the run's
    // durable submission fence, even briefly. This check is repeated after acquisition
    // to cover a state/ownership change between the two database operations.
    const owner = this.runs.assertOwner(
      input.runId,
      input.ownerSessionId,
      input.ownerBindingGeneration,
    );
    if (!owner.allowed) return owner as Decision<PipelineOutcome>;
    if (owner.value.state !== RunState.ACTIVE) {
      return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, `run is ${owner.value.state}`, { runId: input.runId });
    }

    const attemptId = `attempt_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const acquired = this.acquireAttempt(input, attemptId);
    if (!acquired.allowed) return acquired as Decision<PipelineOutcome>;
    try {
      return await this.submitResultOnce(input, attemptId);
    } finally {
      this.releaseAttempt(input.runId, attemptId);
    }
  }

  private async submitResultOnce(input: SubmitResultInput, attemptId: string): Promise<Decision<PipelineOutcome>> {
    const owner = this.runs.assertOwner(
      input.runId,
      input.ownerSessionId,
      input.ownerBindingGeneration,
    );
    if (!owner.allowed) return owner as Decision<PipelineOutcome>;
    const run = owner.value;

    if (run.state !== RunState.ACTIVE) {
      return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, `run is ${run.state}`, { runId: input.runId });
    }

    const completeness = this.reviewEntry(run);
    if (!completeness.allowed) return completeness as Decision<PipelineOutcome>;

    const frozen = await this.freeze(input.runId, attemptId);
    if (!frozen.allowed) return frozen as Decision<PipelineOutcome>;
    const snapshot = frozen.value;
    const snapshotDigest = candidateSnapshotDigest(snapshot);
    const boundAttempt = this.bindAttemptCandidate(input.runId, attemptId, snapshotDigest);
    if (!boundAttempt.allowed) return boundAttempt as Decision<PipelineOutcome>;

    // No repository means no source, verification command, or blind-review input exists to
    // inspect. Publish the explicit no-op packet through the same production gate, then let
    // CEO confirmation and the daemon own completion exactly as for a repository run.
    if (snapshot.repositories.length === 0) {
      // #246 C2 — except a project-less bootstrap candidate, whose planned outputs are exactly the
      // blind-review input there is. Its review is as automatic as a candidate's (§18.2): the gate
      // reloads the outputs from the PLAN artifact, a verdict other than PASS returns the run to its
      // CTO, and only a PASS reaches the production gate.
      if (snapshot.bootstrapPlan !== undefined) {
        const contract = this.pinnedContract(input.runId, run.contractDigest);
        if (!contract.allowed) return contract as Decision<PipelineOutcome>;
        const reviewed = await this.invokeReview({
          kind: "BOOTSTRAP_PLAN",
          runId: input.runId,
          snapshot,
          contract: contract.value,
          contractDigest: run.contractDigest,
          attemptId,
        });
        // Review rounds 1 and 2 (RF-REVIEW-02) — the review is asynchronous, and `plan_submit` can
        // replace the PLAN while it runs or while anything after it is awaited. A candidate whose PLAN
        // was replaced is stale whatever the verdict: a PASS is not P2's review, and a REVISE or BLOCK
        // is not the CTO's next instruction for P2. So the PLAN is checked after the last await before
        // each thing this path does — the revision request or unavailable-review record
        // (`unpassedReview`), and the packet (below) — never only once after the review.
        // A verdict rests on the review the gate stored, whose intent must still be the run's too
        // (BPI-R1-01): a task replaced during the await keeps the PLAN binding and changes only that.
        const unpassed = await this.unpassedReview(input.runId, snapshotDigest, reviewed, attemptId, (verdict) =>
          this.bootstrapPlanStillCurrent(input.runId, snapshot, verdict ? snapshotDigest : null),
        );
        if (unpassed !== null) return unpassed;
        if (this.#continuity?.evaluate) await this.#continuity.evaluate("pre-completion");
      } else if (snapshot.contractChange !== undefined) {
        // #246 B2-a — a no-repository CONTRACT_CHANGE candidate is reviewed as a bootstrap plan is: the
        // manifest its PLAN carries is the review input, and a PLAN replaced since makes it stale. The
        // packet the production gate builds for it still summarizes its review as not applicable, as for
        // any no-repository candidate that is not a bootstrap plan's; the BLIND_REVIEW is the review.
        const contract = this.pinnedContract(input.runId, run.contractDigest);
        if (!contract.allowed) return contract as Decision<PipelineOutcome>;
        const reviewed = await this.invokeReview({
          kind: "CONTRACT_CHANGE",
          runId: input.runId,
          snapshot,
          contract: contract.value,
          contractDigest: run.contractDigest,
          attemptId,
        });
        const unpassed = await this.unpassedReview(input.runId, snapshotDigest, reviewed, attemptId, () =>
          this.contractChangePlanStillCurrent(input.runId, snapshot),
        );
        if (unpassed !== null) return unpassed;
        if (this.#continuity?.evaluate) await this.#continuity.evaluate("pre-completion");
      }
      const sourceReadLease = this.guard.acquireSourceReadLease(input.runId, []);
      if (!sourceReadLease.allowed) return sourceReadLease as Decision<PipelineOutcome>;
      try {
        // And again at publication, as a repository candidate's source is: continuity was awaited
        // since, and nothing below awaits before the packet is built.
        if (snapshot.bootstrapPlan !== undefined) {
          const planAtPublication = this.bootstrapPlanStillCurrent(input.runId, snapshot);
          if (!planAtPublication.allowed) {
            return allow(ReasonCode.OK, { stage: "CANDIDATE_STALE", reasonCode: planAtPublication.reasonCode, snapshotDigest,
              detail: { message: planAtPublication.message, evidence: planAtPublication.evidence } });
          }
        }
        if (snapshot.contractChange !== undefined) {
          const planAtPublication = this.contractChangePlanStillCurrent(input.runId, snapshot);
          if (!planAtPublication.allowed) {
            return allow(ReasonCode.OK, { stage: "CANDIDATE_STALE", reasonCode: planAtPublication.reasonCode, snapshotDigest });
          }
        }
        const built = this.ceo.buildPacket({
          runId: input.runId,
          candidateSnapshotDigest: snapshotDigest,
          sourceReadLeaseId: sourceReadLease.value.leaseId,
          approval: {
            runId: input.runId,
            candidateSnapshotDigest: snapshotDigest,
            resultSummary: input.resultSummary,
            recommendation: input.recommendation,
            residualRisk: input.residualRisk ?? [],
            approvedBySessionId: input.ownerSessionId,
            approvedByGeneration: input.ownerBindingGeneration,
            approvedAt: this.clock.nowIso(),
          },
        } as Parameters<ProductionGate["buildPacket"]>[0] & { sourceReadLeaseId: string });
        if (!built.allowed) return built as Decision<PipelineOutcome>;
        return allow(ReasonCode.OK, {
          stage: "COMPLETED_REVIEW",
          packet: built.value,
          snapshotDigest,
        });
      } finally {
        sourceReadLease.value.release();
      }
    }

    const commands = this.resolveCommands(
      run.pinnedManifestDigest,
      run.executionMode,
      input.runScopedCommands,
    );
    const verified = await this.verification.verify({
      runId: input.runId,
      snapshot,
      commands,
      contractDigest: run.contractDigest,
      pinnedManifestDigest: run.pinnedManifestDigest,
      executionMode: run.executionMode,
      runScoped: Boolean(input.runScopedCommands),
    });

    if (!verified.allowed) {
      const report =
        this.verification.latestReport(input.runId, snapshotDigest) ??
        ({
          runId: input.runId,
          candidateSnapshotDigest: snapshotDigest,
          contractDigest: run.contractDigest,
          expectedInputs: commands.length,
          observedInputs: 0,
          results: [],
          status: "INCOMPLETE",
          reasonCode: verified.reasonCode,
          gaps: [],
        } satisfies VerificationReport);

      // §34.2 — a failed verification returns to CTO revision with the evidence still
      // bound to the candidate that failed.
      const returned = this.returnToCto(input.runId, verified.reasonCode, {
        stage: "verification",
        candidateSnapshotDigest: snapshotDigest,
        report,
      }, attemptId);
      if (!returned.allowed) return returned as Decision<PipelineOutcome>;
      return allow(ReasonCode.OK, {
        stage: "VERIFICATION_FAILED",
        reasonCode: verified.reasonCode,
        snapshotDigest,
        report,
      });
    }

    // CP-HI-06 / §16.2 — verification ran against a detached head, but the source may have
    // moved while it ran. Re-check before spending a review on it.
    const stillFreshAfterVerify = await this.assertStillFresh(snapshot);
    if (!stillFreshAfterVerify.allowed) {
      return allow(ReasonCode.OK, {
        stage: "CANDIDATE_STALE",
        reasonCode: stillFreshAfterVerify.reasonCode,
        snapshotDigest,
      });
    }

    const contract = this.pinnedContract(input.runId, run.contractDigest);
    if (!contract.allowed) return contract as Decision<PipelineOutcome>;

    // §18.2 — automatic, immediately after verification passes.
    const reviewed = await this.invokeReview({
      runId: input.runId,
      projectId: run.projectId,
      executionMode: run.executionMode,
      snapshot,
      contract: contract.value,
      contractDigest: run.contractDigest,
      verification: verified.value,
      attemptId,
    });

    // #246 B2-a — a CONTRACT_CHANGE candidate's verdict is for the PLAN it names; one replaced since
    // gets no revision request. Any other candidate's verdict is delivered as before.
    const unpassed = snapshot.contractChange === undefined
      ? await this.unpassedReview(input.runId, snapshotDigest, reviewed, attemptId)
      : await this.unpassedReview(input.runId, snapshotDigest, reviewed, attemptId, () =>
          this.contractChangePlanStillCurrent(input.runId, snapshot),
        );
    if (unpassed !== null) return unpassed;

    // Coverage is re-evaluated here, in async context, so the gate's completion check
    // decides on a current mode rather than one that predates a provider outage (§15.6).
    if (this.#continuity?.evaluate) await this.#continuity.evaluate("pre-completion");

    const sourceReadLease = this.guard.acquireSourceReadLease(
      input.runId,
      snapshot.repositories.map((repository) => repository.identity),
    );
    if (!sourceReadLease.allowed) return sourceReadLease as Decision<PipelineOutcome>;
    try {
      // And again before the packet: the review is also asynchronous. Managed source
      // writes cannot slip between this observation and production-ready publication.
      const stillFreshAfterReview = await this.assertStillFresh(snapshot);
      if (!stillFreshAfterReview.allowed) {
        return allow(ReasonCode.OK, {
          stage: "CANDIDATE_STALE",
          reasonCode: stillFreshAfterReview.reasonCode,
          snapshotDigest,
        });
      }
      // #246 B2-a — and its PLAN, as a no-repository candidate's is; nothing below awaits.
      if (snapshot.contractChange !== undefined) {
        const planAtPublication = this.contractChangePlanStillCurrent(input.runId, snapshot);
        if (!planAtPublication.allowed) {
          return allow(ReasonCode.OK, { stage: "CANDIDATE_STALE", reasonCode: planAtPublication.reasonCode, snapshotDigest });
        }
      }

      const built = this.ceo.buildPacket({
        runId: input.runId,
        candidateSnapshotDigest: snapshotDigest,
        sourceReadLeaseId: sourceReadLease.value.leaseId,
        approval: {
          runId: input.runId,
          candidateSnapshotDigest: snapshotDigest,
          resultSummary: input.resultSummary,
          recommendation: input.recommendation,
          residualRisk: input.residualRisk ?? [],
          approvedBySessionId: input.ownerSessionId,
          approvedByGeneration: input.ownerBindingGeneration,
          approvedAt: this.clock.nowIso(),
        },
      } as Parameters<ProductionGate["buildPacket"]>[0] & { sourceReadLeaseId: string });
      if (!built.allowed) return built as Decision<PipelineOutcome>;

      return allow(ReasonCode.OK, {
        stage: "COMPLETED_REVIEW",
        packet: built.value,
        snapshotDigest,
      });
    } finally {
      sourceReadLease.value.release();
    }
  }

  /**
   * What review entry asks of the run's tasks (CEO 1792120507 / 1792120860). A project-less
   * PROJECT_BOOTSTRAP run that joins no repository is asked `TaskGraph.bootstrapReviewEntry` against
   * its current PLAN, whose preparation `currentBootstrapPlan` validates here and again at the
   * freeze and the review: its one task is the external create, settled only at CEO CONFIRM from the
   * producer's receipt, so no task success is required or fabricated before review. Every other run
   * keeps `completeness` exactly. The owner was asserted by the caller just before.
   */
  private reviewEntry(run: RunRow): Decision<unknown> {
    if (!isProjectlessBootstrap(run) || this.runs.repositoriesOf(run.runId).length > 0) return this.tasks.administrativeReviewEntry(run.runId);
    const planArtifact = this.artifacts.latest<unknown>(run.runId, ArtifactKind.PLAN);
    const current = currentBootstrapPlan(run.runId, planArtifact);
    if (!current.allowed || planArtifact === null) return current;
    const carried = this.bootstrapPlanCarriesCurrentAuthority(run.runId, planArtifact);
    if (!carried.allowed) return carried;
    return this.tasks.bootstrapReviewEntry(run.runId, current.value.binding.planDigest);
  }

  /**
   * Live run_3884d4fc — attached review evidence and admitted CEO decisions reach a bootstrap PLAN
   * review only as `plan_submit` froze them into the PLAN, and a `plan_submit` under a key an earlier
   * one used replays that earlier PLAN and freezes nothing. So review entry asks the collectors
   * `plan_submit` freezes from, and refuses while the run holds an attachment or a decision its current
   * PLAN lacks: absent from the PLAN is not absent from the run. A run that holds neither is unchanged.
   * `bootstrapPlanStillCurrent` asks it again after the review, for what arrived while it ran.
   */
  private bootstrapPlanCarriesCurrentAuthority(runId: string, plan: { digest: string; content: unknown }): Decision<void> {
    const source = { db: this.db, artifacts: this.artifacts, audit: this.audit, runs: this.runs, bindings: this.bindings };
    let attached: ReturnType<typeof collectBootstrapReviewEvidence>;
    // An attachment `plan_submit` cannot freeze (one naming a replaced PLAN input) is refused as there.
    try { attached = collectBootstrapReviewEvidence(source, runId); }
    catch { return deny(ReasonCode.SNAPSHOT_DIGEST_MISMATCH, "attached review evidence cannot be frozen", { runId }); }
    const content = plan.content as { reviewEvidence?: unknown; bootstrapPlanDigest?: unknown };
    const evidenceUnfrozen = attached !== null
      && (content.reviewEvidence === undefined || digestOf(content.reviewEvidence) !== digestOf(attached));
    // currentBootstrapPlan has already validated the frozen records this reads.
    const frozen = new Set(frozenBootstrapCeoDecisions(plan.content).map((decision) => decision.digest));
    const decisionsUnfrozen = collectBootstrapCeoDecisions(this.db, runId).filter((decision) => !frozen.has(decision.digest));
    if (!evidenceUnfrozen && decisionsUnfrozen.length === 0) return allow(ReasonCode.OK, undefined);
    return deny(
      ReasonCode.BOOTSTRAP_PLAN_AUTHORITY_NOT_FROZEN,
      "this run's current PLAN does not carry the review evidence attached or the CEO decisions admitted since it was submitted, so no review of it is entered or accepted and the run is not made ready for CEO review. Call plan_submit again with the same bootstrapPlanDigest and a NEW idempotencyKey (a key an earlier plan_submit used replays that earlier PLAN and freezes nothing), then result_submit with a new idempotencyKey",
      {
        runId,
        refusal: "BOOTSTRAP_PLAN_AUTHORITY_NOT_FROZEN",
        planDigest: plan.digest,
        bootstrapPlanDigest: typeof content.bootstrapPlanDigest === "string" ? content.bootstrapPlanDigest : null,
        unfrozenReviewEvidenceAttachment: evidenceUnfrozen ? attached!.source.attachmentDigest : null,
        unfrozenCeoDecisionEvents: decisionsUnfrozen.map((decision) => decision.source.decisionEventId),
      },
    );
  }

  /** The run's pinned task contract, read back by its digest. */
  private pinnedContract(runId: string, contractDigest: string): Decision<TaskContract> {
    const contract = this.artifacts
      .list<TaskContract>(runId, ArtifactKind.TASK_CONTRACT)
      .find((artifact) => !artifact.superseded && artifact.digest === contractDigest);
    if (!contract || digestOf(contract.content) !== contractDigest) {
      // #448: nothing was compared — the artifact store has no contract that both matches the
      // run's pinned digest by name and hashes to it. Not a disagreement; a record that could
      // not be produced to compare at all.
      return deny(ReasonCode.CONTRACT_UNVERIFIED, "run's pinned task contract is not retrievable by digest", {
        runId,
        expected: contractDigest,
        found: contract?.digest ?? null,
      });
    }
    return allow(ReasonCode.OK, contract.content);
  }

  /**
   * What a review that did not pass leaves the run with, or null for a PASS: a verdict returns the
   * run to its CTO, and an assurance failure waits (§18.6, §18.7).
   */
  private async unpassedReview(
    runId: string,
    snapshotDigest: string,
    reviewed: Decision<ReviewPacket>,
    /** The submission this review belongs to: its revision is delivered once per attempt. */
    attemptId: string,
    /**
     * Whether the candidate is still the one to act on, asked after the last await and before
     * anything is delivered or recorded, told whether the outcome is a reviewer verdict (one the gate
     * stored a review for). A repository candidate's verdict is delivered as before.
     */
    stillCurrent: (verdict: boolean) => Decision<void> = () => allow(ReasonCode.OK, undefined),
  ): Promise<Decision<PipelineOutcome> | null> {
    if (reviewed.allowed) return null;
    // §18.7 is an assurance decision too. Re-evaluate continuity before deciding
    // whether a provider/isolation failure waits or moves the system into SURVIVAL.
    if (this.#continuity?.evaluate) await this.#continuity.evaluate("blind-review-unavailable");
    // #246 C2, review round 2 (RF-REVIEW-02) — the review and the evaluation above were awaited, and
    // a bootstrap PLAN replaced during either makes this outcome stale: no revision request and no
    // unavailable-review record is produced for it. Nothing below awaits before either is written.
    // §18.7 — only a reviewer *verdict* enters the CTO revision loop. A lost isolation
    // or a provider that never answered is an assurance failure the candidate cannot
    // repair, so the gate is neither lowered nor handed to the CTO to "fix".
    const isVerdict =
      reviewed.reasonCode === ReasonCode.REVIEW_REVISE ||
      reviewed.reasonCode === ReasonCode.REVIEW_BLOCK ||
      reviewed.reasonCode === ReasonCode.REVIEW_OMITTED_ITEMS_PRESENT;
    const current = stillCurrent(isVerdict);
    if (!current.allowed) {
      return allow(ReasonCode.OK, { stage: "CANDIDATE_STALE", reasonCode: current.reasonCode, snapshotDigest,
        detail: { message: current.message, evidence: current.evidence } });
    }

    if (!isVerdict) {
      this.audit.record({
        kind: "BLIND_REVIEW_UNAVAILABLE",
        runId,
        reasonCode: reviewed.reasonCode,
        evidence: unavailableReviewEvidence(snapshotDigest, reviewed.evidence, attemptId),
      });
      return allow(ReasonCode.OK, {
        stage: "REVIEW_UNAVAILABLE",
        reasonCode: reviewed.reasonCode,
        snapshotDigest,
        detail: { message: reviewed.message, evidence: reviewed.evidence },
      });
    }

    const returned = this.returnToCto(runId, reviewed.reasonCode, {
      stage: "blind-review",
      candidateSnapshotDigest: snapshotDigest,
      ...reviewed.evidence,
    }, attemptId);
    if (!returned.allowed) return returned as Decision<PipelineOutcome>;
    const packet = this.review.latestPacket(runId, snapshotDigest);
    return allow(ReasonCode.OK, {
      stage: "REVISION_REQUIRED",
      reasonCode: reviewed.reasonCode,
      snapshotDigest,
      ...(packet ? { review: packet } : {}),
    });
  }

  /** Durable, per-run fence for the whole asynchronous verification/review attempt. */
  private acquireAttempt(input: SubmitResultInput, attemptId: string): Decision<void> {
    // #664 — the upsert below is the reservation itself; a denial means the reservation
    // did not happen and must not leave a row behind.
    return this.db.txDecision(() => {
      const acquiredAt = this.clock.now();
      const startedAt = acquiredAt.toISOString();
      const deadlineAt = new Date(acquiredAt.getTime() + ATTEMPT_LEASE_TTL_MS).toISOString();
      // Read the prior holder in the same transaction so a direct acquisition reclaim is
      // evidence-producing too. A watchdog is not guaranteed to run between a crash and
      // the next submit, so silently replacing an expired RUNNING row would erase the
      // only durable record of that interrupted attempt.
      const prior = this.db.get<{
        attempt_id: string;
        started_at: string;
        deadline_at: string;
        state: string;
      }>(
        `SELECT attempt_id, started_at, deadline_at, state
           FROM candidate_pipeline_attempts WHERE run_id = ?`,
        [input.runId],
      );
      const inserted = this.db.run(
        `INSERT INTO candidate_pipeline_attempts
           (run_id, attempt_id, owner_session_id, owner_binding_generation, candidate_digest, state, started_at, deadline_at, released_at)
         VALUES (?, ?, ?, ?, NULL, 'RUNNING', ?, ?, NULL)
         ON CONFLICT(run_id) DO UPDATE SET
           attempt_id = excluded.attempt_id,
           owner_session_id = excluded.owner_session_id,
           owner_binding_generation = excluded.owner_binding_generation,
           candidate_digest = NULL,
           state = 'RUNNING',
           started_at = excluded.started_at,
           deadline_at = excluded.deadline_at,
           released_at = NULL
         WHERE candidate_pipeline_attempts.state = 'RELEASED'
            OR (candidate_pipeline_attempts.state = 'RUNNING'
                AND candidate_pipeline_attempts.deadline_at <= ?)`,
        [input.runId, attemptId, input.ownerSessionId, input.ownerBindingGeneration, startedAt, deadlineAt, startedAt],
      );
      if (inserted.changes === 1) {
        if (prior?.state === "RUNNING" && prior.deadline_at <= startedAt) {
          this.recordAttemptReclaimed({
            runId: input.runId,
            attemptId: prior.attempt_id,
            startedAt: prior.started_at,
            deadlineAt: prior.deadline_at,
            ageMs: acquiredAt.getTime() - new Date(prior.started_at).getTime(),
          }, "acquire");
        }
        return allow(ReasonCode.OK, undefined);
      }
      const current = this.db.get<{
        attempt_id: string;
        owner_session_id: string;
        owner_binding_generation: number;
        candidate_digest: string | null;
        state: string;
        deadline_at: string;
      }>(
        `SELECT attempt_id, owner_session_id, owner_binding_generation, candidate_digest, state, deadline_at
           FROM candidate_pipeline_attempts WHERE run_id = ?`,
        [input.runId],
      );
      return deny(ReasonCode.CONFLICT, "a durable candidate submission attempt already owns this run", {
        runId: input.runId,
        current,
      });
    });
  }

  /**
   * Releases leases whose owner can no longer be assumed live. This is deliberately a
   * synchronous, conditional transaction: a watchdog may observe a stale row just as a
   * new submission replaces it, and must never release that new holder's fence.
   *
   * The watchdog owns the diagnostic report; this method owns the candidate pipeline's
   * state transition, durable reclaim audit, and the exact rows it changed.
   */
  reclaimExpiredAttempts(): ReclaimedCandidatePipelineAttempt[] {
    return this.db.tx(() => {
      const now = this.clock.now();
      const releasedAt = now.toISOString();
      const stale = this.db.all<{
        run_id: string;
        attempt_id: string;
        started_at: string;
        deadline_at: string;
      }>(
        `SELECT run_id, attempt_id, started_at, deadline_at
           FROM candidate_pipeline_attempts
          WHERE state = 'RUNNING' AND deadline_at <= ?
          ORDER BY deadline_at, run_id`,
        [releasedAt],
      );
      const reclaimed: ReclaimedCandidatePipelineAttempt[] = [];
      for (const attempt of stale) {
        const released = this.db.run(
          `UPDATE candidate_pipeline_attempts
              SET state = 'RELEASED', released_at = ?
            WHERE run_id = ? AND attempt_id = ? AND state = 'RUNNING' AND deadline_at <= ?`,
          [releasedAt, attempt.run_id, attempt.attempt_id, releasedAt],
        );
        if (released.changes !== 1) continue;
        const startedAt = new Date(attempt.started_at).getTime();
        const reclaimedAttempt = {
          runId: attempt.run_id,
          attemptId: attempt.attempt_id,
          startedAt: attempt.started_at,
          deadlineAt: attempt.deadline_at,
          ageMs: now.getTime() - startedAt,
        };
        reclaimed.push(reclaimedAttempt);
        this.recordAttemptReclaimed(reclaimedAttempt, "sweep");
      }
      return reclaimed;
    });
  }

  /** Records every state-changing reclamation, whether the watchdog or a new submit finds it. */
  private recordAttemptReclaimed(
    attempt: ReclaimedCandidatePipelineAttempt,
    via: "acquire" | "sweep",
  ): void {
    this.audit.record({
      kind: "CANDIDATE_PIPELINE_ATTEMPT_RECLAIMED",
      runId: attempt.runId,
      reasonCode: ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE,
      evidence: {
        attemptId: attempt.attemptId,
        startedAt: attempt.startedAt,
        deadlineAt: attempt.deadlineAt,
        ageMs: attempt.ageMs,
        via,
      },
    });
  }

  private bindAttemptCandidate(runId: string, attemptId: string, candidateDigest: string): Decision<void> {
    const updated = this.db.run(
      `UPDATE candidate_pipeline_attempts
          SET candidate_digest = ?
        WHERE run_id = ? AND attempt_id = ? AND state = 'RUNNING'`,
      [candidateDigest, runId, attemptId],
    );
    return updated.changes === 1
      ? allow(ReasonCode.OK, undefined)
      : deny(ReasonCode.CONFLICT, "candidate submission attempt lease was replaced before snapshot binding", {
          runId,
          attemptId,
          candidateDigest,
        });
  }

  private releaseAttempt(runId: string, attemptId: string): void {
    this.db.run(
      `UPDATE candidate_pipeline_attempts
          SET state = 'RELEASED', released_at = ?
        WHERE run_id = ? AND attempt_id = ? AND state = 'RUNNING'`,
      [this.clock.nowIso(), runId, attemptId],
    );
  }

  /**
   * §18.6 — the revision loop is internal. The run returns to the CTO with the reason
   * and the evidence; Hermes is not notified.
   *
   * PR #1114 BOOT-03 — each submission's verdict is its own revision cycle, so the delivery is keyed
   * by the attempt as well as the candidate: a second verdict on the same PLAN is a second message.
   * A delivery the outbox refuses is answered as that refusal, with nothing recorded as returned.
   */
  private returnToCto(runId: string, reasonCode: string, evidence: Record<string, unknown>, attemptId: string): Decision<void> {
    const run = this.runs.require(runId);
    const roleKey = this.runs.ownerRoleKeyFor(run);
    const binding = roleKey ? this.bindings.active(roleKey) : null;

    if (binding) {
      const enqueued = this.outbox.enqueue({
        idempotencyKey: `revision:${runId}:${String(evidence["candidateSnapshotDigest"])}:${reasonCode}:${attemptId}`,
        roleKey: binding.roleKey,
        bindingGeneration: binding.bindingGeneration,
        targetSessionId: binding.sessionId,
        runId,
        kind: MessageKind.REVISION_REQUEST,
        payload: { runId, reasonCode, ...evidence },
      });
      if (!enqueued.allowed) return enqueued as Decision<void>;
    }

    // The delivery above carries `evidence` whole; the row keeps a fixed field list (revisionAuditEvidence).
    const review = evidence["stage"] === "blind-review" ? this.storedReview(runId, String(evidence["candidateSnapshotDigest"])) : null;
    this.audit.record({
      kind: "REVISION_RETURNED_TO_CTO",
      runId,
      roleKey: binding?.roleKey ?? null,
      reasonCode: reasonCode as never,
      evidence: revisionAuditEvidence(evidence, review),
    });

    // §31.3 — revision count is run-scope telemetry. The FSM keeps a blind-review
    // revision inside ACTIVE (§29.2 has no ACTIVE→REVISION_REQUIRED edge), so the count
    // has to be recorded here rather than inferred from a state change.
    this.telemetry.record({
      scope: "run",
      name: "revision",
      runId,
      value: 1,
      text: reasonCode,
      dims: { stage: evidence["stage"] ?? null, mode: run.executionMode },
    });
    return allow(ReasonCode.OK, undefined);
  }

  /** The review gate's own BLIND_REVIEW artifact for a candidate, or null when the gate stored none. */
  private storedReview(runId: string, candidateSnapshotDigest: string): { digest: string; content: ReviewPacket } | null {
    const stored = this.artifacts.latestForSnapshot<ReviewPacket>(runId, ArtifactKind.BLIND_REVIEW, candidateSnapshotDigest);
    return stored !== null && stored.producedBy === EVIDENCE_PRODUCERS.BLIND_REVIEW ? stored : null;
  }

  /**
   * §17.1/§17.5 — commands come from the pinned project contract. A repository with no
   * active manifest may use run-scoped commands the CTO proposed, validated against the
   * same argv/sandbox contract and never persisted as a default.
   */
  /**
   * CP-HI-03 — commands come from the manifest this run pinned at dispatch admission, not
   * from whatever is active now. A concurrent CONTRACT_CHANGE must not change the bar a
   * run in flight is judged against.
   */
  private resolveCommands(
    pinnedManifestDigest: string | null,
    mode: "SIMPLE" | "STANDARD" | "GUARDED",
    runScoped: readonly VerificationCommand[] | undefined,
  ): VerificationCommand[] {
    if (pinnedManifestDigest) {
      const pinned = this.projects.manifest(pinnedManifestDigest);
      if (pinned) return commandsForMode(pinned, mode);
    }
    return [...(runScoped ?? [])];
  }

  /**
   * #246 C2, review round 1 (RF-REVIEW-02) — a project-less bootstrap candidate's freshness: the PLAN
   * binding it froze is still the one the run's current PLAN artifact implies. A current PLAN with no
   * plannable outputs has no binding, and is not the candidate's either. Given the snapshot of a
   * stored review an outcome rests on, that review's intent must also be the run's current one
   * (`bootstrapReviewIntentCurrent`, review of #1119 BPI-R1-01).
   */
  private bootstrapPlanStillCurrent(runId: string, snapshot: CandidateSnapshot, reviewedSnapshotDigest: string | null = null): Decision<void> {
    const planArtifact = this.artifacts.latest<unknown>(runId, ArtifactKind.PLAN);
    const current = currentBootstrapPlan(runId, planArtifact);
    const currentBinding = current.allowed ? current.value.binding : null;
    if (!sameBootstrapPlanBinding(currentBinding, snapshot.bootstrapPlan)) {
      return deny(ReasonCode.EVIDENCE_STALE, "the PLAN this candidate names was replaced while it was being judged", {
        runId,
        candidate: snapshot.bootstrapPlan ?? null,
        current: currentBinding,
      });
    }
    // Review of 51a21441 — evidence attached or a CEO decision admitted while the candidate was judged
    // leaves the PLAN binding as it was, so every outcome (PASS, verdict or unavailable) is stale on the
    // same check review entry asks. A matched binding means currentBootstrapPlan read a PLAN.
    const carried = this.bootstrapPlanCarriesCurrentAuthority(runId, planArtifact!);
    if (!carried.allowed) return carried;
    if (reviewedSnapshotDigest === null) return allow(ReasonCode.OK, undefined);
    const intent = bootstrapReviewIntentCurrent({
      runId,
      reviewedIntentDigest: this.storedReview(runId, reviewedSnapshotDigest)?.content.bootstrapPlanIntentDigest,
      planArtifact,
      tasks: bootstrapPlanIntentTasks(this.db, runId),
    });
    return intent.allowed ? allow(ReasonCode.OK, undefined) : (intent as Decision<void>);
  }

  /**
   * #246 B2-a — a CONTRACT_CHANGE candidate's freshness: the change it froze is still the one the
   * run's latest PLAN implies, against the same base. Asked after review and at publication; a PLAN
   * replaced after the packet is published is not refused here, but at the CEO's confirmation.
   */
  private contractChangePlanStillCurrent(runId: string, snapshot: CandidateSnapshot): Decision<void> {
    const run = this.runs.get(runId);
    const current = run
      ? currentContractChangeTarget(
          run,
          this.artifacts.latest<unknown>(runId, ArtifactKind.PLAN),
          (digest) => this.projects.manifest(digest),
          firstActivationFactsOf(this.db, run),
        )
      : null;
    const currentBinding = current?.allowed ? current.value.binding : null;
    if (!sameContractChangeBinding(currentBinding, snapshot.contractChange)) {
      return deny(ReasonCode.EVIDENCE_STALE, "the PLAN this candidate names was replaced while it was being judged", {
        runId,
        candidate: snapshot.contractChange ?? null,
        current: currentBinding,
      });
    }
    return allow(ReasonCode.OK, undefined);
  }

  /** Re-reads every frozen repository and reports drift (§16.2). */
  private async assertStillFresh(snapshot: CandidateSnapshot): Promise<Decision<CandidateSnapshot>> {
    const probes = snapshot.repositories
      .map((repo) => {
        const record = this.repositories.byIdentity(repo.identity);
        return {
          identity: repo.identity,
          checkoutPath: record?.checkoutPath ?? "",
          residentClone: record ? residentBaseClone(this.db, record.repositoryId, record.checkoutPath) : null,
          activeManifestDigest: record?.activeManifestDigest ?? null,
        };
      })
      .filter((p) => p.checkoutPath);
    return verifySnapshotFreshness(snapshot, probes);
  }

  /**
   * #1242 — the base a task with dependsOn predecessors starts from (`PredecessorBase`): its
   * predecessors' SUCCEEDED commits in its repository, integrated on the run's pinned base by the
   * freeze's own integration, kept from gc by a private ref under `BASE_REF_NAMESPACE` written through
   * the guard before the base is returned. A base that cannot be kept is refused, as one that cannot
   * be built is.
   */
  async predecessorBase(input: Parameters<PredecessorBase>[0]): Promise<Decision<StartsFrom | null>> {
    const run = this.runs.get(input.runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId: input.runId });
    const checkMergeMessages = this.checkMergeMessages(input.runId);
    const built = await integratePredecessors({
      db: this.db,
      runId: input.runId,
      taskId: input.taskId,
      tasks: this.tasks.list(input.runId),
      predecessors: input.predecessors,
      repositoryIdentity: input.repositoryIdentity,
      checkoutPath: input.checkoutPath,
      baseSha: input.baseSha,
      worktree: (worktreeInput, use) => this.verification.withRunWorktree(run, worktreeInput, use),
      ...(checkMergeMessages === undefined ? {} : { checkMessage: checkMergeMessages }),
    });
    if (!built.allowed || built.value === null) return built;
    const ref = baseRefFor(input.runId, input.taskId);
    const plan = await candidateRefPlan(input.checkoutPath, input.runId, { ref, commit: built.value.commit }, ref);
    if (!plan.allowed) return plan as Decision<never>;
    if (plan.value.length > 0) {
      const held = await this.verification.writeRunRefs(
        run,
        { repositoryIdentity: input.repositoryIdentity, namespace: `${BASE_REF_NAMESPACE}/${input.runId}` },
        () => applyCandidateRefPlan(input.checkoutPath, plan.value),
      );
      if (!held.allowed) return held as Decision<never>;
    }
    return built;
  }

  /**
   * S6 review — one guarded ref transaction under the run's private candidate namespace
   * (`CANDIDATE_REF_NAMESPACE`): never a branch, never HEAD, never a task's ref (S-TB-02).
   */
  private async writeCandidateRefs(run: RunRow, identity: string, checkoutPath: string, lines: readonly string[]): Promise<Decision<void>> {
    if (lines.length === 0) return allow(ReasonCode.OK, undefined);
    return this.verification.writeRunRefs(
      run,
      { repositoryIdentity: identity, namespace: `${CANDIDATE_REF_NAMESPACE}/${run.runId}` },
      () => applyCandidateRefPlan(checkoutPath, lines),
    );
  }

  /**
   * CEO (S6-B) — every task's own commit that a valid SUCCEEDED receipt of this run names
   * (`succeededTaskCommits`), checked against the candidate just frozen for its repository. Each
   * STANDARD_WORK task's work branch is created at the run's pinned base (#512 S-TB), or at its
   * dependsOn predecessors' integration on it (#1242), so the checkout's HEAD can hold one task's
   * branch alone. The integration (S6-C) places every commit it can; this is its post-condition on
   * the final head, so a commit it did not place (no write target, or an integration that dropped
   * one) refuses the freeze instead of being lost. Not drift in an already-frozen snapshot
   * (SNAPSHOT_STALE re-reads one after the fact; this is asked before one is ever recorded).
   */
  private async missingTaskCommits(
    commits: readonly SucceededTaskCommit[],
    snapshotRepositories: readonly { identity: string; candidateHead: string }[],
    repositories: readonly { identity: string; checkoutPath: string }[],
  ): Promise<Array<{ taskId: string; commitHead: string; repositoryIdentity: string }>> {
    const checkoutByIdentity = new Map(repositories.map((repo) => [repo.identity, repo.checkoutPath]));
    const candidateByIdentity = new Map(snapshotRepositories.map((repo) => [repo.identity, repo.candidateHead]));

    const missing: Array<{ taskId: string; commitHead: string; repositoryIdentity: string }> = [];
    for (const receipt of commits) {
      const checkoutPath = checkoutByIdentity.get(receipt.repositoryIdentity);
      const candidateHead = candidateByIdentity.get(receipt.repositoryIdentity);
      if (!checkoutPath || !candidateHead) continue;
      // The same ancestry idiom `sourceAtFreeze` uses below: a commit not resolvable in this
      // checkout at all makes `mergeBase` answer null, which is "not contained" exactly as a
      // resolvable but non-ancestor commit is — fail closed either way. An integrated head's
      // objects are in this checkout's object store: its integration worktree was linked to it.
      const ancestor = await mergeBase(checkoutPath, receipt.commit, candidateHead);
      if (ancestor !== receipt.commit) {
        missing.push({ taskId: receipt.taskId, commitHead: receipt.commit, repositoryIdentity: receipt.repositoryIdentity });
      }
    }
    return missing.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  }

  /**
   * Resolve the origin once, while freezing, and pass the resulting SHA to the snapshot
   * builder. For release/hotfix candidates, a shared ancestor can make both long-lived
   * refs appear ancestral; only a unique most-specific ref is recorded. A non-required
   * winner is retained as evidence so the GitHub kernel can refuse it by branch contract.
   */
  private async sourceAtFreeze(
    checkoutPath: string,
    workBranch: string | null,
    targetBranch: string,
    profile: BranchProfile | null,
    scope: { runId: string; identity: string },
  ): Promise<{ sourceBranch: string | null; sourceHead: string | null; taskBaseHead: string | null }> {
    const observedBranch = await currentBranch(checkoutPath);
    const candidateBranch = observedBranch === "HEAD" ? workBranch : observedBranch;
    if (!candidateBranch) return { sourceBranch: null, sourceHead: null, taskBaseHead: null };

    // #512 S-TB (c98ea8a3, S-TB-06) — a branch the control plane made for one of this run's tasks has
    // its origin on record: the declared parent and the pinned base commit it was created at. That is
    // the lineage frozen, whatever the parent's tip names now; it is never re-derived from a moving tip.
    // The candidate must still descend from that commit, or no origin is carried (fail closed).
    const recorded = recordedTargetForBranch(this.db, scope.runId, scope.identity, candidateBranch);
    if (recorded) {
      const candidateHead = await revParse(checkoutPath, "HEAD");
      const ancestor = await mergeBase(checkoutPath, recorded.baseSha, candidateHead);
      return ancestor === recorded.baseSha
        ? { sourceBranch: profile ? recorded.declaredParent : null, sourceHead: profile ? recorded.baseSha : null, taskBaseHead: recorded.baseSha }
        : { sourceBranch: null, sourceHead: null, taskBaseHead: null };
    }

    if (!profile) return { sourceBranch: null, sourceHead: null, taskBaseHead: null };

    const requiredSource = requiredBaseFor(candidateBranch, profile, targetBranch);
    if (!requiredSource) return { sourceBranch: null, sourceHead: null, taskBaseHead: null };

    const candidateHead = await revParse(checkoutPath, "HEAD");
    const probes = sourceProbeBranchesFor(candidateBranch, profile, targetBranch);
    const qualifying = (
      await Promise.all(
        probes.map(async (branch) => {
          const head = await tryRevParse(checkoutPath, branch);
          if (!head) return null;
          const ancestor = await mergeBase(checkoutPath, head, candidateHead);
          return ancestor === head ? { branch, head } : null;
        }),
      )
    ).filter((probe): probe is { branch: string; head: string } => probe !== null);

    const mostSpecific: Array<{ branch: string; head: string }> = [];
    for (const candidate of qualifying) {
      let isAncestorOfAnother = false;
      for (const other of qualifying) {
        if (candidate.branch === other.branch || candidate.head === other.head) continue;
        const relation = await mergeBase(checkoutPath, candidate.head, other.head);
        if (relation === candidate.head) {
          isAncestorOfAnother = true;
          break;
        }
      }
      if (!isAncestorOfAnother) mostSpecific.push(candidate);
    }

    if (mostSpecific.length !== 1) {
      // No unique fact exists. Carrying no origin preserves the existing fail-closed PR
      // behavior and prevents a shared ancestor from being silently assigned to dev/main.
      return { sourceBranch: null, sourceHead: null, taskBaseHead: null };
    }
    const selected = mostSpecific[0]!;
    // Keep a unique but wrong origin in the digest. assertFrozenSourceLineage then rejects
    // the candidate before any PR write, independently of branch divergence.
    return { sourceBranch: selected.branch, sourceHead: selected.head, taskBaseHead: null };
  }
}
