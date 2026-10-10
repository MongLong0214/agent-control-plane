import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  type BootstrapPlanBinding,
  type PlannedBootstrapOutputs,
  bootstrapPlanCoverageTargets,
  currentBootstrapPlan,
  isProjectlessBootstrap,
  sameBootstrapPlanBinding,
} from "../bootstrap/bootstrap-plan.ts";
import type { DispatchCapacityTarget } from "../capacity/capacity-monitor.ts";
import type { ProjectManifest } from "../contracts/manifest.ts";
import type { Clock } from "../core/clock.ts";
import { digestOf, sha256 } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { credentialBearingField, type AuditLog } from "../db/audit.ts";
import { EVIDENCE_PRODUCERS, type ArtifactStore, type EvidenceWriter } from "../db/artifacts.ts";
import type { Db } from "../db/database.ts";
import {
  ArtifactKind,
  type ExecutionMode,
  Role,
  type ReviewFindingCategory,
  type ReviewVerdict,
  SessionLifecycle,
  roleKeyFor,
} from "../domain/types.ts";
import { diffDigest, git } from "../git/git.ts";
import { canonical } from "../guard/workspace-probe.ts";
import {
  type ContractChangeBinding,
  type ContractChangeWorkflowEvidence,
  contractChangeCoverageTarget,
  currentContractChangePlan,
  isContractChangeRun,
  sameContractChangeBinding,
  storedManifest,
} from "../registry/contract-change-plan.ts";
import type { RepositoryRegistry } from "../registry/repository-registry.ts";
import {
  ProviderSessionProvisionError,
  REVIEWER_EGRESS_DENY_PROBE_ENDPOINTS,
  REVIEWER_PROVIDER_ENDPOINTS,
  type InvocationRequest,
  type InvocationResult,
  type ProviderRegistry,
  type ReviewerEgressRecord,
} from "../runtime/provider.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRegistry } from "../session/session-registry.ts";
import {
  type CandidateSnapshot,
  candidateSnapshotDigest,
  snapshotCoverageTargets,
} from "../snapshot/candidate-snapshot.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";
import type { VerificationReport } from "../verify/verification-engine.ts";
import type { TaskContract } from "../run/run-engine.ts";

export interface ReviewFinding {
  category: ReviewFindingCategory;
  severity: "INFO" | "MINOR" | "MAJOR" | "BLOCKER";
  repository: string;
  path: string | null;
  summary: string;
  detail: string;
}

/** PRD §18.4 — the complete review packet. */
export interface ReviewPacket {
  runId: string;
  candidateSnapshotDigest: string;
  contractDigest: string;
  reviewerRoleBindingGeneration: number;
  reviewerSessionId: string;
  reviewerSessionIncarnation: string;
  /**
   * Session the provider itself reports for the invocation that produced this verdict.
   * Without it, an independence check proves only that a synthetic id was not a producer.
   */
  reviewerProviderSessionId: string | null;
  provider: string;
  model: string;
  effort: string | null;
  /** Verbatim proxy JSONL plus per-invocation probes, covered by this packet's digest. */
  egressEvidence: ReviewerEgressRecord[];
  inputManifest: {
    contract: boolean;
    snapshotManifest: boolean;
    diff: boolean;
    verificationEvidence: boolean;
    projectContext: boolean;
    /** §18.3 — what was deliberately withheld from the reviewer. */
    withheld: string[];
    /** Immutable representations supplied for binary paths. */
    binaryArtifacts: Array<{ repository: string; path: string; digest: string; method: "git-binary-patch" }>;
  };
  coveredRepositories: string[];
  coveredFiles: string[];
  omittedItems: string[];
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  chunked: boolean;
  /**
   * Issue #246 PR-C slice C2 — present only on a BOOTSTRAP_PLAN review: the PLAN, manifest and
   * planned outputs the reviewer judged, as the gate reloaded them from the PLAN artifact.
   */
  bootstrapPlan?: BootstrapPlanBinding;
  /**
   * Issue #246 B2-a — present only on a CONTRACT_CHANGE review: the PLAN, the manifest it carries and
   * the base it changes, as the gate reloaded them, and the CI workflows a later activation verifies.
   */
  contractChange?: ContractChangeReviewBinding;
  createdAt: string;
}

/** What a CONTRACT_CHANGE review records it judged (#246 B2-a). */
export interface ContractChangeReviewBinding extends ContractChangeBinding {
  workflowEvidence: ContractChangeWorkflowEvidence[];
}

export interface ReviewerPreference {
  provider: string;
  model: string;
  effort: string | null;
}

export interface BlindReviewRequest {
  /** A candidate review: the frozen repositories' diffs and their verification. The default. */
  kind?: "CANDIDATE";
  runId: string;
  projectId: string | null;
  executionMode: ExecutionMode;
  snapshot: CandidateSnapshot;
  contract: TaskContract;
  contractDigest: string;
  verification: VerificationReport;
}

/**
 * Issue #246 PR-C slice C2 — the review a project-less PROJECT_BOOTSTRAP candidate gets before any
 * write: its planned outputs judged against the task contract and the project manifest.
 *
 * Like a candidate request, this is a transport envelope. The gate trusts only the run, the
 * candidate the run is on and the PLAN artifact that candidate names; the planned outputs and the
 * manifest it reviews are reloaded from that artifact (`currentBootstrapPlan`). Anything a caller
 * puts in `plannedOutputs` or `manifest` is never read.
 */
export interface BootstrapPlanReviewRequest {
  kind: "BOOTSTRAP_PLAN";
  runId: string;
  snapshot: CandidateSnapshot;
  contract: TaskContract;
  contractDigest: string;
  plannedOutputs?: unknown;
  manifest?: unknown;
}

/**
 * Issue #246 B2-a — the review a CONTRACT_CHANGE candidate that joins no repository gets: the
 * manifest its PLAN carries judged against the task contract and the base it changes. A
 * CONTRACT_CHANGE candidate with repositories gets the candidate review, which then covers the
 * manifest as well. As with the other requests, only the run, its current candidate and the PLAN
 * that candidate names are trusted; `manifest` and `baseManifest` here are never read.
 */
export interface ContractChangeReviewRequest {
  kind: "CONTRACT_CHANGE";
  runId: string;
  snapshot: CandidateSnapshot;
  contract: TaskContract;
  contractDigest: string;
  manifest?: unknown;
  baseManifest?: unknown;
}

/** The composition root supplies the capacity admission that reviewer allocation needs. */
export interface BlindReviewCapacityGate {
  refreshForBlindReview(target?: DispatchCapacityTarget): Promise<Decision<void>>;
}

/** Narrow capability the composition root hands to CandidatePipeline, not to agents. */
export type BlindReviewInvoker = (
  request: BlindReviewRequest | BootstrapPlanReviewRequest | ContractChangeReviewRequest,
) => Promise<Decision<ReviewPacket>>;

/** What every reviewer constituted for a run needs to know about the request. */
type ReviewSubject = Pick<BlindReviewRequest, "runId" | "snapshot">;

/** A BOOTSTRAP_PLAN request once its trusted inputs have been reloaded. */
interface TrustedBootstrapPlanReview {
  runId: string;
  snapshot: CandidateSnapshot;
  contract: TaskContract;
  contractDigest: string;
  binding: BootstrapPlanBinding;
  outputs: PlannedBootstrapOutputs;
  manifest: unknown;
}

/** A CONTRACT_CHANGE candidate's change once it has been reloaded from the PLAN it names. */
interface TrustedContractChange {
  projectId: string;
  binding: ContractChangeBinding;
  manifest: ProjectManifest;
  baseManifest: ProjectManifest;
  workflowEvidence: ContractChangeWorkflowEvidence[];
  /** `<projectId>:#manifest/<manifestDigest>`, the coverage item the reviewer must account for. */
  target: { identity: string; path: string };
}

/** A CONTRACT_CHANGE request once its run, candidate, contract and change have been reloaded. */
interface TrustedContractChangeReview {
  runId: string;
  snapshot: CandidateSnapshot;
  contract: TaskContract;
  contractDigest: string;
  change: TrustedContractChange;
}

/** Every coverage item a candidate review must account for: its files, and a contract change's manifest. */
const candidateCoverageTargets = (
  snapshot: CandidateSnapshot,
  change: TrustedContractChange | null,
): Array<{ identity: string; path: string }> => [
  ...snapshotCoverageTargets(snapshot),
  ...(change === null ? [] : [change.target]),
];

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "coveredFiles", "omittedItems", "findings"],
  properties: {
    verdict: { type: "string", enum: ["PASS", "REVISE", "BLOCK"] },
    coveredFiles: { type: "array", items: { type: "string" } },
    omittedItems: { type: "array", items: { type: "string" } },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "severity", "repository", "summary", "detail"],
        properties: {
          category: {
            type: "string",
            enum: [
              "correctness", "regression", "security", "scope", "performance",
              "maintainability", "evidence", "freshness", "source",
            ],
          },
          severity: { type: "string", enum: ["INFO", "MINOR", "MAJOR", "BLOCKER"] },
          repository: { type: "string" },
          path: { type: ["string", "null"] },
          summary: { type: "string" },
          detail: { type: "string" },
        },
      },
    },
  },
} as const;

/** Diff size above which a single reviewer context is not trusted to hold everything. */
const CHUNK_THRESHOLD_CHARS = 120_000;
const REVIEW_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * A compact commitment to every logical packet input. The snapshot digest binds the
 * actual candidate heads and diffs; coverage targets make omissions mechanically visible
 * to the reviewer before it answers.
 */
const reviewPacketDigest = (request: BlindReviewRequest, change: TrustedContractChange | null = null): string =>
  digestOf({
    candidateSnapshotDigest: candidateSnapshotDigest(request.snapshot),
    contractDigest: request.contractDigest,
    verificationDigest: digestOf(request.verification),
    coverageTargets: candidateCoverageTargets(request.snapshot, change).map(({ identity, path }) => `${identity}:${path}`),
  });

/**
 * PRD §18 — mandatory independent blind review.
 *
 * The gate is invoked by the control plane after deterministic verification passes.
 * There is no operation on any agent-facing surface that requests, skips or overrides
 * it: `manualInvocation` exists solely to return the denial (§18.2).
 */
/**
 * One sentence per way provisioning a reviewer session can fail, keyed by the error's own union.
 *
 * Total by construction: `Record<ProviderSessionProvisionError["reasonCode"], string>` cannot be
 * satisfied while a member has no sentence, so the next reason to arrive here is a compile error
 * rather than a run that silently reports the wrong one. That is what replaced the ternary chain
 * — the chain had a default, and a default is where an unnamed reason goes to be misreported.
 */
const REVIEWER_SESSION_FAILURE_MESSAGES: Record<ProviderSessionProvisionError["reasonCode"], string> = {
  [ReasonCode.ISOLATION_LOST]: "preferred reviewer isolation could not be proved",
  [ReasonCode.REVIEWER_SESSION_HANDSHAKE_TIMEOUT]:
    "preferred reviewer was isolated and did not answer its identity handshake",
  [ReasonCode.REVIEWER_SESSION_UNREADABLE_ANSWER]:
    "preferred reviewer answered its identity handshake without a resumable session id",
};

export class BlindReviewGate {
  readonly #pipelineCapability = Symbol("blind-review-control-plane");
  #capacity: BlindReviewCapacityGate | null = null;
  constructor(
    private readonly clock: Clock,
    private readonly db: Db,
    private readonly audit: AuditLog,
    private readonly artifacts: ArtifactStore,
    /**
     * The capability that makes this gate the only writer of BLIND_REVIEW evidence. It is
     * issued once by the composition root, so reaching the store is not enough to write a
     * review packet (#70, CP-HI-04).
     */
    private readonly evidenceWriter: EvidenceWriter<"BLIND_REVIEW">,
    private readonly sessions: SessionRegistry,
    private readonly bindings: BindingRegistry,
    private readonly providers: ProviderRegistry,
    private readonly repositories: RepositoryRegistry,
    private readonly telemetry: Telemetry,
    private readonly preferences: {
      preferred: ReviewerPreference;
      fallbacks: ReviewerPreference[];
    },
    /** The same daemon-owned endpoint policy supplied to production CLI adapters. */
    private readonly reviewerEgressEndpoints: Readonly<Record<string, readonly string[]>> = REVIEWER_PROVIDER_ENDPOINTS,
  ) {}

  /** Closed by the production composition root once the capacity monitor exists. */
  attach(ports: { capacity?: BlindReviewCapacityGate }): void {
    if (ports.capacity) this.#capacity = ports.capacity;
  }

  /** §18.2 — CTO and Hermes do not invoke the review. */
  manualInvocation(actor: string, runId: string): Decision<never> {
    this.audit.record({
      kind: "BLIND_REVIEW_MANUAL_DENIED",
      runId,
      actor,
      reasonCode: ReasonCode.REVIEW_MANUAL_INVOCATION_DENIED,
      evidence: {},
    });
    return deny(
      ReasonCode.REVIEW_MANUAL_INVOCATION_DENIED,
      "blind review is invoked by the control plane, not by an agent",
      { actor, runId },
    );
  }

  /** The only control-plane port that can invoke the automatic review transition. */
  controlPlaneInvoker(): BlindReviewInvoker {
    return (request) => this.review(request, this.#pipelineCapability);
  }

  async review(
    request: BlindReviewRequest | BootstrapPlanReviewRequest | ContractChangeReviewRequest,
    capability?: symbol,
  ): Promise<Decision<ReviewPacket>> {
    if (capability !== this.#pipelineCapability) {
      return this.manualInvocation("unscoped-review-call", request.runId) as Decision<ReviewPacket>;
    }
    if (request.kind === "BOOTSTRAP_PLAN") return this.reviewBootstrapPlan(request);
    if (request.kind === "CONTRACT_CHANGE") return this.reviewContractChangePlan(request);
    return this.reviewCandidate(request);
  }

  private async reviewCandidate(request: BlindReviewRequest): Promise<Decision<ReviewPacket>> {
    const snapshotDigest = candidateSnapshotDigest(request.snapshot);

    // The caller's JSON is a transport envelope, never evidence. In particular, a caller
    // cannot manufacture a PASS report and use the public object graph as a second review
    // entrance: the exact contract and verification report are reloaded from immutable,
    // trusted artifacts and corroborated against the engine's result rows.
    const trusted = this.trustedInputs(request, snapshotDigest);
    if (!trusted.allowed) return trusted as Decision<ReviewPacket>;
    request = trusted.value;
    // #246 B2-a — a CONTRACT_CHANGE candidate's review covers the manifest its PLAN carries as well
    // as its files, reloaded from that PLAN rather than taken from the request.
    const changed = this.contractChangeForCandidate(request.runId, request.snapshot);
    if (!changed.allowed) return changed as Decision<ReviewPacket>;
    const change = changed.value;

    const expected = candidateCoverageTargets(request.snapshot, change);
    const reviewers: ReviewerBinding[] = [];
    const rememberReviewer = (reviewer: ReviewerBinding): void => {
      reviewers.push(reviewer);
    };

    try {
      const collected = await this.collectDiffs(request.snapshot);
      if (!collected.allowed) return collected as Decision<ReviewPacket>;
      const { diffs, binaryArtifacts } = collected.value;

      const totalChars = diffs.reduce((n, d) => n + d.diff.length, 0) + this.promptOverhead(request, change);
      const chunked = totalChars > CHUNK_THRESHOLD_CHARS;

      let outcome: Decision<ReviewOutcome>;
      if (chunked) {
        outcome = await this.chunkedReview(request, diffs, rememberReviewer, change);
      } else {
        const reviewer = await this.constituteReviewer(request);
        if (!reviewer.allowed) return reviewer as Decision<ReviewPacket>;
        rememberReviewer(reviewer.value);
        outcome = await this.singleReview(request, this.buildPrompt(request, diffs, undefined, change), reviewer.value);
      }

      if (!outcome.allowed) return outcome as Decision<ReviewPacket>;
      // The reviewer answered asynchronously and `plan_submit` may have replaced the PLAN meanwhile:
      // a verdict on a PLAN the run no longer has is stale and is not stored. `settle` does not await.
      if (change !== null) {
        const stillCurrent = this.contractChangeForCandidate(request.runId, request.snapshot);
        if (!stillCurrent.allowed) return stillCurrent as Decision<ReviewPacket>;
      }
      return this.settle({
        runId: request.runId,
        contractDigest: request.contractDigest,
        snapshotDigest,
        outcome: outcome.value,
        chunked,
        expected,
        binaryArtifacts,
        bootstrapPlan: null,
        contractChange: change === null ? null : { ...change.binding, workflowEvidence: change.workflowEvidence },
        planReview: false,
      });
    } finally {
      this.release(reviewers);
    }
  }

  /**
   * Issue #246 PR-C slice C2 — the BOOTSTRAP_PLAN review. The planned outputs and the manifest come
   * from the PLAN artifact the run's current candidate names, never from the request; the reviewer
   * is constituted, isolated, egress-checked and judged for coverage exactly as a candidate's is,
   * and its packet is stored through the same evidence writer with the PLAN binding it judged.
   */
  private async reviewBootstrapPlan(request: BootstrapPlanReviewRequest): Promise<Decision<ReviewPacket>> {
    const snapshotDigest = candidateSnapshotDigest(request.snapshot);
    const trusted = this.trustedBootstrapPlanInputs(request, snapshotDigest);
    if (!trusted.allowed) return trusted as Decision<ReviewPacket>;
    const inputs = trusted.value;
    const expected = bootstrapPlanCoverageTargets(inputs.outputs);

    const reviewers: ReviewerBinding[] = [];
    try {
      const reviewer = await this.constituteReviewer(inputs);
      if (!reviewer.allowed) return reviewer as Decision<ReviewPacket>;
      reviewers.push(reviewer.value);
      const outcome = await this.singleReview(
        inputs,
        this.buildBootstrapPlanPrompt(inputs, expected),
        reviewer.value,
        BOOTSTRAP_PLAN_REVIEWER_SYSTEM_PROMPT,
      );
      if (!outcome.allowed) return outcome as Decision<ReviewPacket>;
      // Review round 1 (RF-REVIEW-02) — the reviewer answered asynchronously, and `plan_submit` may
      // have replaced the PLAN meanwhile. The trusted inputs are reloaded before the verdict is kept:
      // a verdict on a PLAN the run no longer has is stale (EVIDENCE_STALE) and is not stored, so
      // only a review of the current PLAN can make its candidate ready. `settle` does not await, so
      // nothing can replace the PLAN between this reload and the packet it stores.
      const stillCurrent = this.trustedBootstrapPlanInputs(request, snapshotDigest);
      if (!stillCurrent.allowed) return stillCurrent as Decision<ReviewPacket>;
      return this.settle({
        runId: inputs.runId,
        contractDigest: inputs.contractDigest,
        snapshotDigest,
        outcome: outcome.value,
        chunked: false,
        expected,
        binaryArtifacts: [],
        bootstrapPlan: inputs.binding,
        contractChange: null,
        planReview: true,
      });
    } finally {
      this.release(reviewers);
    }
  }

  /**
   * Issue #246 B2-a — the review of a CONTRACT_CHANGE candidate that joins no repository: the manifest
   * its PLAN carries and the base it changes, both reloaded by digest, judged by a reviewer that is
   * constituted, isolated, egress-checked and held to coverage exactly as a candidate's is. The packet
   * is stored through the same evidence writer with the change it judged.
   */
  private async reviewContractChangePlan(request: ContractChangeReviewRequest): Promise<Decision<ReviewPacket>> {
    const snapshotDigest = candidateSnapshotDigest(request.snapshot);
    const trusted = this.trustedContractChangeInputs(request, snapshotDigest);
    if (!trusted.allowed) return trusted as Decision<ReviewPacket>;
    const inputs = trusted.value;
    const expected = [inputs.change.target];

    const reviewers: ReviewerBinding[] = [];
    try {
      const reviewer = await this.constituteReviewer(inputs);
      if (!reviewer.allowed) return reviewer as Decision<ReviewPacket>;
      reviewers.push(reviewer.value);
      const outcome = await this.singleReview(
        inputs,
        this.buildContractChangePrompt(inputs, expected),
        reviewer.value,
        CONTRACT_CHANGE_REVIEWER_SYSTEM_PROMPT,
      );
      if (!outcome.allowed) return outcome as Decision<ReviewPacket>;
      // As for a bootstrap PLAN: reloaded after the reviewer answered, before the verdict is kept.
      const stillCurrent = this.trustedContractChangeInputs(request, snapshotDigest);
      if (!stillCurrent.allowed) return stillCurrent as Decision<ReviewPacket>;
      return this.settle({
        runId: inputs.runId,
        contractDigest: inputs.contractDigest,
        snapshotDigest,
        outcome: outcome.value,
        chunked: false,
        expected,
        binaryArtifacts: [],
        bootstrapPlan: null,
        contractChange: { ...inputs.change.binding, workflowEvidence: inputs.change.workflowEvidence },
        planReview: true,
      });
    } finally {
      this.release(reviewers);
    }
  }

  /**
   * What every review does with a verdict once a reviewer has answered: the reviewer's binding is
   * still the current one, the packet is assembled, independence is asked again, coverage decides
   * whether a PASS stands, and the packet is stored as BLIND_REVIEW evidence before the verdict is
   * returned.
   */
  private settle(input: {
    runId: string;
    contractDigest: string;
    snapshotDigest: string;
    outcome: ReviewOutcome;
    chunked: boolean;
    expected: Array<{ identity: string; path: string }>;
    binaryArtifacts: Array<{ repository: string; path: string; digest: string; method: "git-binary-patch" }>;
    bootstrapPlan: BootstrapPlanBinding | null;
    contractChange: ContractChangeReviewBinding | null;
    /** The reviewer read a PLAN's outputs or manifest, not a diff and its verification. */
    planReview: boolean;
  }): Decision<ReviewPacket> {
    const { runId, snapshotDigest, outcome, chunked, expected } = input;
    const authoritativeReviewer = outcome.reviewer;

    // A reviewer binding is a fencing token. If something replaced it while the
    // provider was working, its verdict is no longer attributable to the active role.
    if (!this.bindings.isCurrent(authoritativeReviewer.roleKey, authoritativeReviewer.generation)) {
      return deny(ReasonCode.BINDING_GENERATION_STALE, "reviewer binding changed during review", {
        runId,
        roleKey: authoritativeReviewer.roleKey,
        generation: authoritativeReviewer.generation,
      });
    }

    const packet = this.assemble({
      request: { runId, contractDigest: input.contractDigest },
      snapshotDigest,
      reviewer: authoritativeReviewer,
      chunked,
      raw: outcome.verdict,
      providerSessionId: outcome.providerSessionId,
      expected,
      binaryArtifacts: input.binaryArtifacts,
      egressEvidence: outcome.egressEvidence,
      bootstrapPlan: input.bootstrapPlan,
      contractChange: input.contractChange,
      planReview: input.planReview,
    });

    // §18.4 / CP-HI-04 — re-check independence at packet time: a session can join the
    // producer set after the reviewer was bound.
    const independence = this.bindings.assertReviewerIndependence(
      runId,
      authoritativeReviewer.sessionId,
    );
    if (!independence.allowed) {
      this.audit.record({
        kind: "BLIND_REVIEW_REJECTED",
        runId,
        sessionId: authoritativeReviewer.sessionId,
        reasonCode: independence.reasonCode,
        evidence: independence.evidence,
      });
      return independence as Decision<ReviewPacket>;
    }

    const validated = this.validateCoverage(packet, expected);
    this.artifacts.putEvidence(
      this.evidenceWriter,
      runId,
      ArtifactKind.BLIND_REVIEW,
      validated,
      snapshotDigest,
    );

    this.audit.record({
      kind: "BLIND_REVIEW_COMPLETED",
      runId,
      sessionId: authoritativeReviewer.sessionId,
      roleKey: authoritativeReviewer.roleKey,
      reasonCode:
        validated.verdict === "PASS"
          ? ReasonCode.REVIEW_PASS
          : validated.verdict === "REVISE"
            ? ReasonCode.REVIEW_REVISE
            : ReasonCode.REVIEW_BLOCK,
      evidence: {
        candidateSnapshotDigest: snapshotDigest,
        verdict: validated.verdict,
        provider: authoritativeReviewer.preference.provider,
        model: authoritativeReviewer.preference.model,
        effort: authoritativeReviewer.preference.effort,
        coveredFiles: validated.coveredFiles.length,
        omittedItems: validated.omittedItems,
        chunked,
        findings: validated.findings.length,
        egressRecords: validated.egressEvidence.length,
        egressProviders: [...new Set(validated.egressEvidence.map((record) => record.provider))],
        // The final reviewer is the packet authority. Persist the distinct chunk
        // reviewers too, because they are the sessions that actually saw the diff.
        chunkReviewerSessions: outcome.chunkReviewers.map((chunkReviewer) => ({
          sessionId: chunkReviewer.sessionId,
          incarnation: chunkReviewer.incarnation,
          providerSessionId: chunkReviewer.providerSessionId,
          generation: chunkReviewer.generation,
          provider: chunkReviewer.provider,
        })),
        ...(input.bootstrapPlan === null ? {} : { reviewKind: "BOOTSTRAP_PLAN" }),
        ...(input.contractChange === null ? {} : { reviewKind: "CONTRACT_CHANGE" }),
      },
    });

    this.telemetry.record({
      scope: "quality",
      name: "blind_review",
      runId,
      text: validated.verdict,
      dims: {
        provider: authoritativeReviewer.preference.provider,
        model: authoritativeReviewer.preference.model,
        chunked,
        findingCategories: validated.findings.map((f) => f.category),
      },
    });

    if (validated.verdict !== "PASS") {
      return deny(
        validated.verdict === "REVISE" ? ReasonCode.REVIEW_REVISE : ReasonCode.REVIEW_BLOCK,
        `blind review returned ${validated.verdict}`,
        { runId, packet: validated },
      );
    }
    if (validated.omittedItems.length > 0) {
      return deny(ReasonCode.REVIEW_OMITTED_ITEMS_PRESENT, "PASS requires zero omitted items", {
        runId,
        omittedItems: validated.omittedItems,
      });
    }
    return allow(ReasonCode.REVIEW_PASS, validated);
  }

  /**
   * Do not revoke a replacement owned by another attempt. Every reviewer constituted by this
   * attempt is stopped explicitly, including a chunk reviewer on an error path before a final
   * reviewer exists.
   */
  private release(reviewers: readonly ReviewerBinding[]): void {
    const latestReviewer = reviewers.at(-1);
    if (latestReviewer && this.bindings.isCurrent(latestReviewer.roleKey, latestReviewer.generation)) {
      this.bindings.revoke(latestReviewer.roleKey, "blind review complete");
    }
    for (const reviewer of reviewers) {
      this.sessions.transition(reviewer.sessionId, SessionLifecycle.STOPPED, "blind review complete");
      rmSync(reviewer.workdir, { recursive: true, force: true });
    }
  }

  /**
   * §18.1 / §18.7 — prefer GPT-5.6 Sol at xhigh; fall back to a *separate* fresh
   * session when the preferred provider is unavailable. Session and context
   * independence is required even when the provider family is reused; if no isolated
   * reviewer can be constituted the gate is not lowered — the caller waits.
   */
  private async constituteReviewer(
    request: ReviewSubject,
    purpose: "blind-review" | "blind-review-chunk" | "blind-review-final" = "blind-review",
  ): Promise<
    Decision<{
      sessionId: string;
      incarnation: string;
      externalSessionId: string;
      generation: number;
      preference: ReviewerPreference;
      roleKey: string;
      /** Empty packet-only directory; candidate checkouts are never reviewer cwd. */
      workdir: string;
    }>
  > {
    const runId = request.runId;
    const roleKey = roleKeyFor(Role.BLIND_REVIEWER, { runId });
    const attempts: Array<{ preference: ReviewerPreference; reason: string }> = [];
    let capacityFailure: Decision<void> | null = null;

    for (const preference of [this.preferences.preferred, ...this.preferences.fallbacks]) {
      const isPreferred = preference === this.preferences.preferred;
      // Unknown registry scope is not an availability proof authorizing fallback.
      const scope = this.reviewerScope(preference.provider);
      if (!scope.allowed) return scope;
      const adapter = scope.value
        ? this.providers.requireForRole(preference.provider, Role.BLIND_REVIEWER)
        : this.providers.get(preference.provider);
      if (!adapter) {
        attempts.push({ preference, reason: "no adapter registered" });
        // An omitted GPT adapter is a deployment/configuration defect, not measured
        // evidence that GPT is down. Routing to Claude here would make the fallback
        // indistinguishable from the original always-Claude failure mode.
        if (isPreferred) {
          return deny(ReasonCode.ISOLATION_LOST, "preferred reviewer adapter is not registered", {
            runId,
            provider: preference.provider,
            attempts,
          });
        }
        continue;
      }
      if (adapter.supportsReviewerIsolation === false) {
        attempts.push({ preference, reason: "reviewer isolation is unsupported by adapter" });
        if (isPreferred) {
          return deny(ReasonCode.ISOLATION_LOST, "preferred reviewer adapter cannot enforce packet isolation", {
            runId,
            provider: preference.provider,
            attempts,
          });
        }
        continue;
      }
      const health = await adapter.probeRuntime();
      // The awaited probe may invalidate scope. Stop before treating any subsequent
      // denial as capacity exhaustion or an outage eligible for another provider.
      const admissionScope = this.reviewerScope(preference.provider);
      if (!admissionScope.allowed) return admissionScope;
      if (health === "UNAVAILABLE") {
        attempts.push({ preference, reason: "runtime unavailable" });
        continue;
      }
      // A runtime probe does not allocate a reviewer. Once a provider is healthy enough
      // to constitute one, refresh and admit immediately before `startSession`; this is
      // the capacity precondition for the allocation, not a best-effort observation.
      const capacity = await this.admitReviewer(preference.provider, admissionScope);
      if (!capacity.allowed) {
        capacityFailure ??= capacity;
        attempts.push({ preference, reason: capacity.reasonCode });
        continue;
      }

      // The reviewer receives immutable packet data over stdin. Its cwd is intentionally
      // empty so a read-only runtime cannot discover the candidate checkout by walking up
      // from the daemon's repository. Provider-level OS confinement is an additional
      // boundary; this directory is not represented as a sufficient substitute for it.
      const workdir = mkdtempSync(join(tmpdir(), "acp-review-"));
      let handle;
      try {
        handle = await adapter.startSession({
          model: preference.model,
          effort: preference.effort,
          workdir,
          purpose,
          isolation: this.reviewerIsolation(request, workdir),
        });
      } catch (error) {
        rmSync(workdir, { recursive: true, force: true });
        const message = error instanceof Error ? error.message : "provider reviewer session setup failed";
        // A missing OS/profile/provider-identity proof is not a capacity outage. Falling
        // back to Claude here would hide a broken mandatory GPT gate behind a successful
        // alternate review, which is exactly the P0-07 failure mode.
        if (error instanceof ProviderSessionProvisionError) {
          // The message follows the reason rather than assuming it, through a total map rather
          // than a chain of ternaries: every `ProviderSessionProvisionError` used to be reported
          // as unproven isolation, and each time a reason is added the chain's default silently
          // reclaims it. A `Record` keyed by the error's own union has no default to fall into —
          // adding a member without its sentence is a type error, which is the property that
          // matters here. An operator reading "isolation could not be proved" about a reviewer
          // that answered audits the sandbox and never looks at the provider (#512, #967).
          return deny(
            error.reasonCode,
            REVIEWER_SESSION_FAILURE_MESSAGES[error.reasonCode],
            {
              runId,
              provider: preference.provider,
              model: preference.model,
              effort: preference.effort,
              reason: message,
              attempts,
            },
          );
        }
        return deny(ReasonCode.ISOLATION_LOST, "reviewer session creation failed without an availability proof", {
          runId,
          provider: preference.provider,
          model: preference.model,
          effort: preference.effort,
          reason: message,
          attempts,
        });
      }
      if (adapter.requiresReviewerProviderSessionProof === true && handle.providerSessionProven !== true) {
        rmSync(workdir, { recursive: true, force: true });
        return deny(ReasonCode.ISOLATION_LOST, "reviewer adapter did not prove a provider-issued fresh session", {
          runId,
          provider: preference.provider,
          model: preference.model,
          effort: preference.effort,
          attempts,
        });
      }
      const session = this.sessions.create({
        provider: adapter.provider,
        model: preference.model,
        effort: preference.effort,
        sessionId: `ses_review_${handle.externalSessionId.replace(/-/g, "").slice(0, 20)}`,
        incarnation: `${handle.externalSessionId}#${this.clock.nowIso()}`,
      });
      this.sessions.transition(session.sessionId, SessionLifecycle.READY, "reviewer ready");

      // A second reviewer for the same run replaces the first generation rather than
      // colliding with it: §18.5's final reviewer is a distinct, fresh session.
      const bound = this.bindings.active(roleKey)
        ? this.bindings.switchTo({
            roleKey,
            role: Role.BLIND_REVIEWER,
            sessionId: session.sessionId,
            runId,
            mode: isPreferred ? "PREFERRED" : "FALLBACK",
            reason: `constituting ${purpose}`,
            // #493 — a reviewer rebind is a different reviewer, and CP-HI-04 requires it to be.
            conversation: "REPLACED",
          })
        : this.bindings.bind({
            roleKey,
            role: Role.BLIND_REVIEWER,
            sessionId: session.sessionId,
            runId,
            mode: isPreferred ? "PREFERRED" : "FALLBACK",
          });
      if (!bound.allowed) {
        this.sessions.transition(session.sessionId, SessionLifecycle.STOPPED, "binding refused");
        rmSync(workdir, { recursive: true, force: true });
        attempts.push({ preference, reason: bound.reasonCode });
        continue;
      }

      if (!isPreferred) {
        const preferredAttempt = attempts.find((attempt) => attempt.preference === this.preferences.preferred);
        this.audit.record({
          kind: "BLIND_REVIEW_FALLBACK",
          runId,
          sessionId: session.sessionId,
          roleKey,
          reasonCode: ReasonCode.OK,
          evidence: {
            from: this.preferences.preferred.provider,
            provider: preference.provider,
            reason: preferredAttempt?.reason ?? "preferred provider unavailable",
          },
        });
      }

      return allow(ReasonCode.OK, {
        sessionId: session.sessionId,
        incarnation: session.incarnation,
        externalSessionId: handle.externalSessionId,
        generation: bound.value.bindingGeneration,
        preference,
        roleKey,
        workdir,
      });
    }

    if (capacityFailure) {
      return deny(
        capacityFailure.reasonCode,
        "no blind reviewer could be constituted with current routable capacity",
        { runId, attempts, capacity: capacityFailure.evidence },
      );
    }
    return deny(
      ReasonCode.ISOLATION_LOST,
      "no isolated blind reviewer could be constituted; the gate is not lowered",
      { runId, attempts },
    );
  }

  /**
   * Collects the real diff for every repository in the candidate.
   *
   * Fails closed rather than substituting an empty string: a reviewer handed no diff can
   * still echo the touched paths back and return PASS, and the packet would then claim
   * `diff: true` for content nobody saw (CP-HI-08). Git's binary patch is an immutable,
   * digest-bound artifact representation, so a legitimate binary update is reviewable
   * rather than a permanent omission.
   */
  private async collectDiffs(
    snapshot: CandidateSnapshot,
  ): Promise<
    Decision<{
      diffs: Array<{ identity: string; diff: string; files: string[] }>;
      binaryArtifacts: Array<{ repository: string; path: string; digest: string; method: "git-binary-patch" }>;
    }>
  > {
    const diffs: Array<{ identity: string; diff: string; files: string[] }> = [];
    const binaryArtifacts: Array<{
      repository: string;
      path: string;
      digest: string;
      method: "git-binary-patch";
    }> = [];

    for (const repo of snapshot.repositories) {
      const record = this.repositories.byIdentity(repo.identity);
      if (!record) {
        return deny(
          ReasonCode.EVIDENCE_MISSING,
          "a repository in the candidate has no local binding, so its diff cannot be produced",
          { identity: repo.identity },
        );
      }

      const diff = (await git(record.checkoutPath, [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--full-index",
        "--binary",
        `${repo.baseHead}..${repo.candidateHead}`,
      ])).stdout;
      // The diff must be the one the frozen candidate describes.
      const observedDigest = await diffDigest(record.checkoutPath, repo.baseHead, repo.candidateHead);
      if (observedDigest !== repo.diffDigest) {
        return deny(ReasonCode.EVIDENCE_STALE, "diff no longer matches the frozen candidate", {
          identity: repo.identity,
          expected: repo.diffDigest,
          observed: observedDigest,
        });
      }

      for (const section of diff.split(/(?=^diff --git )/m).filter(Boolean)) {
        if (!section.includes("GIT binary patch")) continue;
        const path = /^diff --git a\/(.+?) b\//m.exec(section)?.[1];
        if (!path || !repo.touchedPaths.includes(path)) {
          return deny(ReasonCode.EVIDENCE_MISSING, "binary patch cannot be bound to a touched path", {
            identity: repo.identity,
            section: section.slice(0, 200),
          });
        }
        binaryArtifacts.push({
          repository: repo.identity,
          path,
          digest: sha256(section),
          method: "git-binary-patch",
        });
      }

      diffs.push({ identity: repo.identity, diff, files: repo.touchedPaths });
    }

    return allow(ReasonCode.OK, { diffs, binaryArtifacts });
  }

  private reviewInvocation(
    request: ReviewSubject,
    reviewer: ReviewerBinding,
    prompt: string,
    correlationId: string,
    systemPrompt: string = REVIEWER_SYSTEM_PROMPT,
  ): IsolatedInvocationRequest {
    return {
      prompt,
      systemPrompt,
      workdir: reviewer.workdir,
      timeoutMs: REVIEW_TIMEOUT_MS,
      model: reviewer.preference.model,
      effort: reviewer.preference.effort ?? undefined,
      responseSchema: VERDICT_SCHEMA as unknown as Record<string, unknown>,
      readOnly: true,
      correlationId,
      externalSessionId: reviewer.externalSessionId,
      isolation: this.reviewerIsolation(request, reviewer.workdir),
    };
  }

  private reviewerIsolation(request: ReviewSubject, workdir: string): ReviewerIsolation {
    // Canonical, not as-configured: the sandbox profile matches kernel-resolved paths and
    // filters this list against the *realpath* of the packet root. A symlink alias — the
    // `/var` → `/private/var` case every macOS temp path takes — would compile to a deny
    // rule that never matches anything, so the withholding would be claimed and not done.
    const denyReadPaths = new Set<string>([canonical(process.cwd())]);
    const databasePath = this.db.raw.name;
    if (databasePath && databasePath !== ":memory:") denyReadPaths.add(canonical(databasePath));
    // A reviewer must not discover producer reasoning by reading the host provider's
    // conversation stores. The runtime adapter must enforce this request before it may
    // attest isolation; including the canonical paths here makes that contract explicit.
    const hostHome = homedir();
    for (const providerState of [join(hostHome, ".claude"), join(hostHome, ".codex")]) {
      denyReadPaths.add(canonical(providerState));
    }
    for (const repository of request.snapshot.repositories) {
      const checkout = this.repositories.byIdentity(repository.identity)?.checkoutPath;
      if (checkout) denyReadPaths.add(canonical(checkout));
    }
    return {
      packetRoot: workdir,
      denyReadPaths: [...denyReadPaths],
      emptyEnvironment: true,
      network: "provider-only",
      tools: "none",
    };
  }

  private assertIsolationAttested(
    runId: string,
    reviewer: ReviewerBinding,
    result: InvocationResult,
  ): Decision<ReviewerEgressRecord[]> {
    // Only an explicit attestation counts. Anything else — including an adapter that
    // simply omits the field — is an unprovable isolation claim, which §18.3 treats as a
    // lost boundary rather than a benign default.
    if (result.isolationAttested === true && result.isolationReasonCode === undefined) {
      const adapter = this.providers.requireForRole(reviewer.preference.provider, Role.BLIND_REVIEWER);
      if (
        adapter.supportsReviewerEffortAttestation === true &&
        reviewer.preference.effort !== null &&
        result.effortAttested !== true
      ) {
        return deny(ReasonCode.ISOLATION_LOST, "reviewer adapter did not attest the configured effort", {
          runId,
          provider: reviewer.preference.provider,
          model: reviewer.preference.model,
          effort: reviewer.preference.effort,
          reviewerSessionId: reviewer.sessionId,
        });
      }
      const egress = result.egressEvidence;
      if (!egress || egress.length === 0) {
        return deny(ReasonCode.ISOLATION_LOST, "reviewer adapter did not bind proxy JSONL evidence", {
          runId,
          provider: reviewer.preference.provider,
          reviewerSessionId: reviewer.sessionId,
        });
      }
      for (const record of egress) {
        const invalid = reviewerEgressRecordProblem(
          record,
          reviewer.preference.provider,
          this.reviewerEgressEndpoints,
        );
        if (invalid) {
          return deny(ReasonCode.ISOLATION_LOST, "reviewer egress evidence is incomplete or unsafe", {
            runId,
            provider: reviewer.preference.provider,
            reviewerSessionId: reviewer.sessionId,
            problem: invalid,
          });
        }
      }
      return allow(ReasonCode.OK, egress);
    }
    return deny(ReasonCode.ISOLATION_LOST, "reviewer adapter did not attest packet-only isolation", {
      runId,
      provider: reviewer.preference.provider,
      reviewerSessionId: reviewer.sessionId,
      packetRoot: reviewer.workdir,
      isolationAttested: result.isolationAttested,
      isolationReasonCode: result.isolationReasonCode ?? null,
      // Which probe refused, not merely that one did. proveReviewerIsolation names the failing
      // probe and runCli puts that text in `error`; this deny recorded only the code, so every
      // failure read identically as ISOLATION_LOST. A fail-closed path that cannot say why is
      // expensive in exactly the way #419 has been — the boundary was working and the reason it
      // refused was unreadable from the evidence it left behind.
      isolationDetail: result.error ?? null,
    });
  }

  private async singleReview(
    request: ReviewSubject,
    prompt: string,
    reviewer: ReviewerBinding,
    systemPrompt: string = REVIEWER_SYSTEM_PROMPT,
  ): Promise<Decision<ReviewOutcome>> {
    const adapter = this.providers.requireForRole(reviewer.preference.provider, Role.BLIND_REVIEWER);
    const capacity = await this.admitReviewer(reviewer.preference.provider);
    if (!capacity.allowed) return capacity as Decision<ReviewOutcome>;
    const result = await adapter.invoke(this.reviewInvocation(
      request,
      reviewer,
      prompt,
      `${request.runId}:${reviewer.sessionId}`,
      systemPrompt,
    ));
    const isolation = this.assertIsolationAttested(request.runId, reviewer, result);
    if (!isolation.allowed) return isolation as Decision<ReviewOutcome>;

    // CP-HI-08 — a timed-out or errored invocation is missing evidence, even if whatever
    // it managed to emit happens to parse as a PASS.
    if (!result.ok) {
      return deny(ReasonCode.EVIDENCE_MISSING, "reviewer invocation did not complete", {
        runId: request.runId,
        provider: reviewer.preference.provider,
        exitCode: result.exitCode,
        error: result.error,
      });
    }

    const parsed = parseVerdict(result.json ?? result.text);
    if (!parsed) {
      return deny(ReasonCode.EVIDENCE_MISSING, "reviewer did not return a parsable verdict", {
        runId: request.runId,
        provider: reviewer.preference.provider,
        error: result.error,
        raw: result.text.slice(0, 500),
      });
    }
    const attested = this.assertInvocationIdentity(request.runId, reviewer, result.providerSessionId);
    if (!attested.allowed) return attested as Decision<ReviewOutcome>;
    return allow(ReasonCode.OK, {
      verdict: parsed,
      providerSessionId: result.providerSessionId!,
      reviewer,
      chunkReviewers: [],
      egressEvidence: isolation.value,
    });
  }

  /**
   * §18.5 — chunk reviewers, then a coverage reducer that verifies every file was seen
   * at least once, finding dedupe, and a final fresh reviewer over the reduced set.
   */
  private async chunkedReview(
    request: BlindReviewRequest,
    diffs: Array<{ identity: string; diff: string; files: string[] }>,
    rememberReviewer: (reviewer: ReviewerBinding) => void,
    change: TrustedContractChange | null = null,
  ): Promise<Decision<ReviewOutcome>> {
    // A chunk adds repository/file fences and the chunk heading beyond the empty-prompt
    // measurement. Reserve a bounded envelope so the complete serialized prompt, not only
    // the patch body, remains inside the review budget.
    const chunkBudget = CHUNK_THRESHOLD_CHARS - this.promptOverhead(request, change) - 4_096;
    if (chunkBudget <= 0) {
      return deny(ReasonCode.EVIDENCE_MISSING, "review prompt metadata exceeds the reviewer context budget", {
        runId: request.runId,
        overhead: this.promptOverhead(request, change),
        budget: CHUNK_THRESHOLD_CHARS,
      });
    }
    const chunks = splitDiffs(diffs, chunkBudget);
    // #246 B2-a — every chunk prompt carries the contract change; the first chunk's reviewer is the
    // one that may claim the manifest, so the reducer can tell whether any reviewer covered it.
    if (change !== null && chunks.length > 0) {
      const key = `${change.target.identity}:${change.target.path}`;
      chunks[0]!.push({
        identity: change.target.identity,
        diff: "",
        files: [change.target.path],
        coverageTargets: [{ file: key, slice: `${key}:whole` }],
      });
    }
    const coveredFiles = new Set<string>();
    const coveredSlices = new Set<string>();
    const expectedSlices = new Map<string, string>();
    for (const part of chunks.flat()) {
      for (const target of part.coverageTargets) expectedSlices.set(target.slice, target.file);
    }
    const findings: ReviewFinding[] = [];
    const omitted: string[] = [];
    const chunkReviewers: ChunkReviewerEvidence[] = [];
    const egressEvidence: ReviewerEgressRecord[] = [];
    let worst: ReviewVerdict = "PASS";

    for (const [index, chunk] of chunks.entries()) {
      const prompt = this.buildPrompt(request, chunk, { chunk: index + 1, of: chunks.length }, change);
      if (prompt.length > CHUNK_THRESHOLD_CHARS) {
        return deny(ReasonCode.EVIDENCE_MISSING, "a review chunk exceeds the context budget", {
          runId: request.runId,
          chunk: index + 1,
          length: prompt.length,
          budget: CHUNK_THRESHOLD_CHARS,
        });
      }
      // CP-HI-04 / ADR-0006: every chunk is a fresh provider session and a fresh
      // packet-only workdir. Reusing one session turns the second chunk into a later
      // conversation turn that can read earlier verdicts.
      const constituted = await this.constituteReviewer(request, "blind-review-chunk");
      if (!constituted.allowed) return constituted as Decision<ReviewOutcome>;
      const reviewer = constituted.value;
      rememberReviewer(reviewer);

      const capacity = await this.admitReviewer(reviewer.preference.provider);
      if (!capacity.allowed) return capacity as Decision<ReviewOutcome>;
      const adapter = this.providers.requireForRole(reviewer.preference.provider, Role.BLIND_REVIEWER);
      const result = await adapter.invoke(this.reviewInvocation(
        request,
        reviewer,
        prompt,
        `${request.runId}:${reviewer.sessionId}:chunk${index + 1}`,
      ));
      const isolation = this.assertIsolationAttested(request.runId, reviewer, result);
      if (!isolation.allowed) return isolation as Decision<ReviewOutcome>;
      egressEvidence.push(...isolation.value);
      // The chunk reviewers are the only reviewers that received the candidate diff.
      // Verify the provider's session attestation for each one before accepting any of
      // their coverage or findings; checking only the final reducer reviewer proves the
      // wrong invocation was independent.
      const attested = this.assertInvocationIdentity(request.runId, reviewer, result.providerSessionId);
      if (!attested.allowed) return attested as Decision<ReviewOutcome>;
      chunkReviewers.push({
        sessionId: reviewer.sessionId,
        incarnation: reviewer.incarnation,
        providerSessionId: result.providerSessionId!,
        generation: reviewer.generation,
        provider: reviewer.preference.provider,
      });
      const parsed = result.ok ? parseVerdict(result.json ?? result.text) : null;
      if (!parsed) {
        // A chunk that did not produce a usable verdict is an omission, not a pass.
        omitted.push(...chunk.flatMap((c) => c.files.map((f) => `${c.identity}:${f}`)));
        continue;
      }
      const chunkCoverage = validateChunkCoverage(parsed.coveredFiles, chunk);
      if (!chunkCoverage.allowed) return chunkCoverage as Decision<ReviewOutcome>;
      for (const file of chunkCoverage.value.files) coveredFiles.add(file);
      for (const slice of chunkCoverage.value.slices) coveredSlices.add(slice);
      omitted.push(...parsed.omittedItems);
      findings.push(...parsed.findings);
      worst = worseVerdict(worst, parsed.verdict);
    }

    // Coverage reducer: every touched file must have been seen by at least one chunk,
    // and every range slice of an oversized file must have been claimed by the chunk
    // that actually contained it. A first-slice claim cannot cover later slices.
    const expected = candidateCoverageTargets(request.snapshot, change).map((t) => `${t.identity}:${t.path}`);
    const unseenFiles = expected.filter((key) => !coveredFiles.has(key));
    const unseenSlices = [...expectedSlices.entries()]
      .filter(([slice]) => !coveredSlices.has(slice))
      .map(([, file]) => file);
    omitted.push(...unseenFiles, ...unseenSlices);

    const reduced: RawVerdict = {
      verdict: worst,
      coveredFiles: [...coveredFiles],
      omittedItems: [...new Set(omitted)],
      findings: dedupeFindings(findings),
    };

    // §18.5 — the reduced result is not the verdict. A *final fresh reviewer* judges it,
    // and only that judgement is authoritative.
    const finalReviewer = await this.constituteReviewer(request, "blind-review-final");
    if (!finalReviewer.allowed) return finalReviewer as Decision<never>;
    rememberReviewer(finalReviewer.value);

    const finalPrompt = this.buildFinalPrompt(request, reduced, chunks.length, change);
    if (finalPrompt.length > CHUNK_THRESHOLD_CHARS) {
      return deny(ReasonCode.EVIDENCE_MISSING, "the reduced final-review prompt exceeds the context budget", {
        runId: request.runId,
        length: finalPrompt.length,
        budget: CHUNK_THRESHOLD_CHARS,
      });
    }

    const finalCapacity = await this.admitReviewer(finalReviewer.value.preference.provider);
    if (!finalCapacity.allowed) {
      return finalCapacity as Decision<ReviewOutcome>;
    }
    const finalResult = await this.providers.requireForRole(finalReviewer.value.preference.provider, Role.BLIND_REVIEWER).invoke(
      this.reviewInvocation(
        request,
        finalReviewer.value,
        finalPrompt,
        `${request.runId}:${finalReviewer.value.sessionId}:final`,
      ),
    );
    const finalIsolation = this.assertIsolationAttested(request.runId, finalReviewer.value, finalResult);
    if (!finalIsolation.allowed) {
      return finalIsolation as Decision<ReviewOutcome>;
    }
    egressEvidence.push(...finalIsolation.value);

    if (!finalResult.ok) {
      return deny(ReasonCode.EVIDENCE_MISSING, "final chunked reviewer did not complete", {
        runId: request.runId,
        exitCode: finalResult.exitCode,
        error: finalResult.error,
      });
    }
    const finalVerdict = parseVerdict(finalResult.json ?? finalResult.text);
    if (!finalVerdict) {
      return deny(ReasonCode.EVIDENCE_MISSING, "final chunked reviewer returned no usable verdict", {
        runId: request.runId,
        raw: finalResult.text.slice(0, 500),
      });
    }

    const attested = this.assertInvocationIdentity(
      request.runId,
      finalReviewer.value,
      finalResult.providerSessionId,
    );
    if (!attested.allowed) {
      return attested as Decision<ReviewOutcome>;
    }

    return allow(ReasonCode.OK, {
      verdict: {
        // A final reviewer judges the reduction but cannot erase a BLOCK/REVISE reached
        // by a reviewer that saw the diff, nor a mechanical coverage omission.
        verdict: worseVerdict(
          worseVerdict(finalVerdict.verdict, reduced.verdict),
          reduced.omittedItems.length > 0 ? "REVISE" : "PASS",
        ),
        // Only a reviewer that actually saw a chunk may claim its paths. The final reviewer
        // judges the reduced result and therefore cannot manufacture diff coverage.
        coveredFiles: reduced.coveredFiles,
        omittedItems: [...new Set([...reduced.omittedItems, ...finalVerdict.omittedItems])],
        findings: dedupeFindings([...reduced.findings, ...finalVerdict.findings]),
      },
      providerSessionId: finalResult.providerSessionId!,
      reviewer: finalReviewer.value,
      chunkReviewers,
      egressEvidence,
    });
  }

  /** Input for §18.5's final reviewer: the reduced coverage and findings, nothing else. */
  private buildFinalPrompt(
    request: BlindReviewRequest,
    reduced: RawVerdict,
    chunkCount: number,
    change: TrustedContractChange | null = null,
  ): string {
    return [
      `# Final review over a reduced ${chunkCount}-chunk result`,
      "",
      "Earlier reviewers examined this candidate in chunks. You are judging their reduced",
      "output, not re-reading the diff. Decide the authoritative verdict.",
      "",
      "## Task contract",
      `Goal: ${request.contract.goal}`,
      "",
      "## Packet identity and required coverage",
      `Packet digest: ${reviewPacketDigest(request, change)}`,
      "Required coverage:",
      ...candidateCoverageTargets(request.snapshot, change).map((target) => `- ${target.identity}:${target.path}`),
      "Acceptance criteria:",
      ...request.contract.acceptance.map((a) => `- ${a}`),
      "",
      "## Reduced coverage and findings",
      "```json",
      JSON.stringify(reduced, null, 2),
      "```",
      "",
      "## Required response",
      "Return a single JSON object matching the schema, and nothing else.",
      "You may not return PASS while omittedItems is non-empty.",
    ].join("\n");
  }

  private buildPrompt(
    request: BlindReviewRequest,
    diffs: Array<{ identity: string; diff: string; files: string[] }>,
    chunk?: { chunk: number; of: number },
    change: TrustedContractChange | null = null,
  ): string {
    const sections = [
      chunk ? `# Review chunk ${chunk.chunk} of ${chunk.of}` : "# Candidate review",
      "",
      "## Task contract",
      `Goal: ${request.contract.goal}`,
      `Why: ${request.contract.why}`,
      `Scope: ${request.contract.scope.join("; ") || "(unspecified)"}`,
      `Non-goals: ${request.contract.nonGoals.join("; ") || "(none)"}`,
      "Acceptance criteria:",
      ...request.contract.acceptance.map((a) => `- ${a}`),
      "",
      "## Candidate snapshot manifest",
      "```json",
      JSON.stringify(request.snapshot, null, 2),
      "```",
      "",
      "## Packet identity and required coverage",
      `Packet digest: ${reviewPacketDigest(request, change)}`,
      "Required coverage:",
      ...candidateCoverageTargets(request.snapshot, change).map((target) => `- ${target.identity}:${target.path}`),
      "",
      ...(change === null ? [] : contractChangeSection(change)),
      "## Deterministic verification evidence",
      "```json",
      JSON.stringify(request.verification, null, 2),
      "```",
      "",
      "## Actual diff",
    ];

    for (const repo of diffs) {
      sections.push(`### ${repo.identity}`, "Files:", ...repo.files.map((f) => `- ${f}`), "```diff", repo.diff, "```");
    }

    sections.push(
      "",
      "## Required response",
      // Only some runtimes enforce a response schema, so the shape is stated here too.
      "Return a single JSON object and nothing else — no prose before or after it:",
      "```json",
      JSON.stringify(
        {
          verdict: "PASS | REVISE | BLOCK",
          coveredFiles: ["<repository-identity>:<path>"],
          omittedItems: [],
          findings: [
            {
              category: "correctness",
              severity: "MINOR",
              repository: "<repository-identity>",
              path: "<path or null>",
              summary: "one line",
              detail: "what is wrong and why it matters",
            },
          ],
        },
        null,
        2,
      ),
      "```",
      "`coveredFiles` must list every file you actually examined, formatted `<repository-identity>:<path>`.",
      "`omittedItems` must list anything you could not examine. Do not return PASS with a non-empty omission list.",
      "`findings` may be empty. Everything you need is above; you have no tools and are not expected to look anything up.",
    );
    return sections.filter(Boolean).join("\n");
  }

  /**
   * Issue #246 PR-C slice C2 — the reviewer is asked to judge the planned outputs against the task
   * contract and the project manifest, and to account for every planned file and operation.
   */
  private buildBootstrapPlanPrompt(
    inputs: TrustedBootstrapPlanReview,
    expected: Array<{ identity: string; path: string }>,
  ): string {
    const contract = inputs.contract;
    return [
      "# Bootstrap plan review",
      "",
      "A new project's repository has not been created yet. Below is everything this plan would",
      "produce: the files with their exact content, the GitHub operations in the order they run, the",
      "default branch and the repository they target, the verification command and the handoff to the",
      "project's first CTO. Judge whether these outputs are what the task contract and the project",
      "manifest ask for, and whether anything in them is unsafe, wrong or missing.",
      "",
      "## Task contract",
      `Goal: ${contract.goal}`,
      `Why: ${contract.why}`,
      `Scope: ${contract.scope.join("; ") || "(unspecified)"}`,
      `Non-goals: ${contract.nonGoals.join("; ") || "(none)"}`,
      "Acceptance criteria:",
      ...contract.acceptance.map((a) => `- ${a}`),
      "",
      "## Project manifest",
      "```json",
      JSON.stringify(inputs.manifest, null, 2),
      "```",
      "",
      "## Planned outputs",
      `Plan digest: ${inputs.binding.planDigest}`,
      `Manifest digest: ${inputs.binding.projectManifestDigest}`,
      `Planned outputs digest: ${inputs.binding.plannedOutputsDigest}`,
      "```json",
      JSON.stringify(inputs.outputs, null, 2),
      "```",
      "",
      "## Required coverage",
      ...expected.map((target) => `- ${target.identity}:${target.path}`),
      "",
      "## Required response",
      "Return a single JSON object and nothing else — no prose before or after it:",
      "```json",
      JSON.stringify(
        {
          verdict: "PASS | REVISE | BLOCK",
          coveredFiles: ["<repository-identity>:<path or #operation/...>"],
          omittedItems: [],
          findings: [],
        },
        null,
        2,
      ),
      "```",
      "`coveredFiles` must list every required coverage item you actually examined, exactly as written above.",
      "`omittedItems` must list anything you could not examine. Do not return PASS with a non-empty omission list.",
      "`findings` may be empty. Everything you need is above; you have no tools and are not expected to look anything up.",
    ].join("\n");
  }

  /**
   * Issue #246 B2-a — the reviewer is asked to judge the manifest a CONTRACT_CHANGE PLAN carries
   * against the task contract and the base it changes, and to account for the manifest item.
   */
  private buildContractChangePrompt(
    inputs: TrustedContractChangeReview,
    expected: Array<{ identity: string; path: string }>,
  ): string {
    const contract = inputs.contract;
    return [
      "# Contract change review",
      "",
      "This run changes the project's contract and joins no repository. Below are the manifest it",
      "proposes and the base manifest it would replace. Judge whether the proposed manifest is what the",
      "task contract asks for, and whether anything it requires, runs or trusts is unsafe, wrong or missing.",
      "",
      "## Task contract",
      `Goal: ${contract.goal}`,
      `Why: ${contract.why}`,
      `Scope: ${contract.scope.join("; ") || "(unspecified)"}`,
      `Non-goals: ${contract.nonGoals.join("; ") || "(none)"}`,
      "Acceptance criteria:",
      ...contract.acceptance.map((a) => `- ${a}`),
      "",
      ...contractChangeSection(inputs.change),
      "## Required coverage",
      ...expected.map((target) => `- ${target.identity}:${target.path}`),
      "",
      "## Required response",
      "Return a single JSON object and nothing else — no prose before or after it:",
      "```json",
      JSON.stringify(
        {
          verdict: "PASS | REVISE | BLOCK",
          coveredFiles: ["<project-id>:#manifest/<digest>"],
          omittedItems: [],
          findings: [],
        },
        null,
        2,
      ),
      "```",
      "`coveredFiles` must list every required coverage item you actually examined, exactly as written above.",
      "`omittedItems` must list anything you could not examine. Do not return PASS with a non-empty omission list.",
      "`findings` may be empty. Everything you need is above; you have no tools and are not expected to look anything up.",
    ].join("\n");
  }

  private assemble(input: {
    request: Pick<BlindReviewRequest, "runId" | "contractDigest">;
    snapshotDigest: string;
    reviewer: ReviewerBinding;
    chunked: boolean;
    raw: RawVerdict;
    providerSessionId: string | null;
    expected: Array<{ identity: string; path: string }>;
    binaryArtifacts: Array<{ repository: string; path: string; digest: string; method: "git-binary-patch" }>;
    egressEvidence: ReviewerEgressRecord[];
    /** A BOOTSTRAP_PLAN review's binding; null for a candidate review, whose packet has no such key. */
    bootstrapPlan: BootstrapPlanBinding | null;
    /** A CONTRACT_CHANGE review's binding; null for any other review, whose packet has no such key. */
    contractChange: ContractChangeReviewBinding | null;
    planReview: boolean;
  }): ReviewPacket {
    const planReview = input.planReview;
    return {
      runId: input.request.runId,
      candidateSnapshotDigest: input.snapshotDigest,
      contractDigest: input.request.contractDigest,
      reviewerRoleBindingGeneration: input.reviewer.generation,
      reviewerSessionId: input.reviewer.sessionId,
      reviewerSessionIncarnation: input.reviewer.incarnation,
      reviewerProviderSessionId: input.providerSessionId,
      provider: input.reviewer.preference.provider,
      model: input.reviewer.preference.model,
      effort: input.reviewer.preference.effort,
      egressEvidence: input.egressEvidence,
      // A BOOTSTRAP_PLAN reviewer reads the planned outputs and the project manifest, not a diff
      // or verification evidence: there is no repository yet to diff or to verify.
      inputManifest: {
        contract: true,
        snapshotManifest: true,
        diff: !planReview,
        verificationEvidence: !planReview,
        projectContext: planReview || input.contractChange !== null,
        withheld: [...LOGICAL_WITHHELD_INPUTS],
        binaryArtifacts: input.binaryArtifacts,
      },
      coveredRepositories: [
        ...new Set(
          input.raw.coveredFiles
            .map((file) => splitCoverageKey(file)?.identity)
            .filter((identity): identity is string => identity !== undefined),
        ),
      ],
      coveredFiles: [...new Set(input.raw.coveredFiles)],
      omittedItems: [...new Set(input.raw.omittedItems)],
      verdict: input.raw.verdict,
      findings: input.raw.findings,
      chunked: input.chunked,
      ...(input.bootstrapPlan === null ? {} : { bootstrapPlan: input.bootstrapPlan }),
      ...(input.contractChange === null ? {} : { contractChange: input.contractChange }),
      createdAt: this.clock.nowIso(),
    };
  }

  /** Reloads the only contract and verification evidence the gate is allowed to trust. */
  private trustedInputs(
    request: BlindReviewRequest,
    snapshotDigest: string,
  ): Decision<BlindReviewRequest> {
    const run = this.db.get<{ contract_digest: string; current_candidate_digest: string | null }>(
      `SELECT contract_digest, current_candidate_digest FROM runs WHERE run_id = ?`,
      [request.runId],
    );
    if (!run || request.snapshot.runId !== request.runId) {
      return deny(ReasonCode.EVIDENCE_MISSING, "review request is not bound to a persisted run", {
        runId: request.runId,
        snapshotRunId: request.snapshot.runId,
      });
    }
    if (run.current_candidate_digest !== snapshotDigest) {
      return deny(ReasonCode.EVIDENCE_STALE, "review request is not the run's current candidate", {
        runId: request.runId,
        currentCandidate: run.current_candidate_digest,
        snapshotDigest,
      });
    }
    if (request.snapshot.contractDigest !== run.contract_digest || request.contractDigest !== run.contract_digest) {
      return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "review request is not pinned to the run contract", {
        runContractDigest: run.contract_digest,
        snapshotContractDigest: request.snapshot.contractDigest,
        suppliedContractDigest: request.contractDigest,
      });
    }

    const contract = this.artifacts
      .list<TaskContract>(request.runId, ArtifactKind.TASK_CONTRACT)
      .find((artifact) => !artifact.superseded && artifact.digest === run.contract_digest);
    if (!contract || digestOf(contract.content) !== run.contract_digest) {
      // #448: nothing was compared — the artifact store has no contract that both matches the
      // run's pinned digest by name and hashes to it. There is no trustworthy stored contract
      // here to compare the caller's submission against.
      return deny(ReasonCode.CONTRACT_UNVERIFIED, "the run's pinned task contract is not retrievable by digest", {
        runId: request.runId,
        expected: run.contract_digest,
        found: contract?.digest ?? null,
      });
    }
    if (digestOf(request.contract) !== run.contract_digest) {
      // A trustworthy stored contract is in hand; this is the actual comparison — the
      // caller's submitted contract against the run's pinned one — and they disagree.
      return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "the supplied task contract is not the run's immutable contract", {
        runId: request.runId,
        expected: run.contract_digest,
        found: contract.digest,
      });
    }

    const verification = this.artifacts.latestForSnapshot<VerificationReport>(
      request.runId,
      ArtifactKind.VERIFICATION,
      snapshotDigest,
    );
    if (!verification || verification.producedBy !== EVIDENCE_PRODUCERS.VERIFICATION) {
      return deny(ReasonCode.EVIDENCE_MISSING, "review requires verification produced by the verification engine", {
        runId: request.runId,
        candidateSnapshotDigest: snapshotDigest,
        producedBy: verification?.producedBy ?? null,
      });
    }
    const report = verification.content;
    if (
      report.status !== "PASS" ||
      report.runId !== request.runId ||
      report.candidateSnapshotDigest !== snapshotDigest ||
      report.contractDigest !== run.contract_digest ||
      digestOf(request.verification) !== digestOf(report)
    ) {
      return deny(ReasonCode.EVIDENCE_MISSING, "supplied verification report does not match trusted passing evidence", {
        runId: request.runId,
        status: report.status,
        verificationRunId: report.runId,
        verificationSnapshotDigest: report.candidateSnapshotDigest,
        verificationContractDigest: report.contractDigest,
      });
    }

    const rows = this.db.all<{
      command_id: string;
      repository_identity: string;
      source: string;
      exact_head: string;
      status: string;
    }>(
      `SELECT command_id, repository_identity, source, exact_head, status
         FROM verification_results WHERE run_id = ? AND candidate_snapshot_digest = ?`,
      [request.runId, snapshotDigest],
    );
    const reported = new Set(
      report.results.map((result) => `${result.commandId}\u0000${result.repositoryIdentity}\u0000${result.source}\u0000${result.exactHead}`),
    );
    const corroborated = rows.length >= report.expectedInputs && rows.every((row) =>
      row.status === "PASS" && reported.has(`${row.command_id}\u0000${row.repository_identity}\u0000${row.source}\u0000${row.exact_head}`),
    );
    if (!corroborated || report.observedInputs !== report.expectedInputs || report.results.length < report.expectedInputs) {
      return deny(ReasonCode.EVIDENCE_MISSING, "passing verification report lacks corroborating result rows", {
        runId: request.runId,
        expectedInputs: report.expectedInputs,
        observedInputs: report.observedInputs,
        reportResults: report.results.length,
        rows: rows.length,
      });
    }
    return allow(ReasonCode.OK, { ...request, contract: contract.content, verification: report });
  }

  /**
   * Issue #246 PR-C slice C2 — reloads what a BOOTSTRAP_PLAN reviewer may be shown. Trusted: the
   * run row, the candidate the run is on (whose digest covers its PLAN binding), the pinned task
   * contract, and the PLAN artifact that binding names. The planned outputs and the manifest are
   * recomputed from that artifact; the request's own `plannedOutputs` and `manifest` are not read.
   */
  private trustedBootstrapPlanInputs(
    request: BootstrapPlanReviewRequest,
    snapshotDigest: string,
  ): Decision<TrustedBootstrapPlanReview> {
    const run = this.db.get<{
      contract_digest: string;
      current_candidate_digest: string | null;
      kind: string;
      project_id: string | null;
    }>(
      `SELECT contract_digest, current_candidate_digest, kind, project_id FROM runs WHERE run_id = ?`,
      [request.runId],
    );
    if (!run || request.snapshot.runId !== request.runId) {
      return deny(ReasonCode.EVIDENCE_MISSING, "review request is not bound to a persisted run", {
        runId: request.runId,
        snapshotRunId: request.snapshot.runId,
      });
    }
    if (!isProjectlessBootstrap({ kind: run.kind, projectId: run.project_id })) {
      return deny(ReasonCode.INVALID_ARGUMENT, "a BOOTSTRAP_PLAN review is for a project-less PROJECT_BOOTSTRAP run", {
        runId: request.runId,
        kind: run.kind,
        projectId: run.project_id,
      });
    }
    if (run.current_candidate_digest !== snapshotDigest) {
      return deny(ReasonCode.EVIDENCE_STALE, "review request is not the run's current candidate", {
        runId: request.runId,
        currentCandidate: run.current_candidate_digest,
        snapshotDigest,
      });
    }
    if (request.snapshot.contractDigest !== run.contract_digest || request.contractDigest !== run.contract_digest) {
      return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "review request is not pinned to the run contract", {
        runContractDigest: run.contract_digest,
        snapshotContractDigest: request.snapshot.contractDigest,
        suppliedContractDigest: request.contractDigest,
      });
    }
    const contract = this.artifacts
      .list<TaskContract>(request.runId, ArtifactKind.TASK_CONTRACT)
      .find((artifact) => !artifact.superseded && artifact.digest === run.contract_digest);
    if (!contract || digestOf(contract.content) !== run.contract_digest) {
      return deny(ReasonCode.CONTRACT_UNVERIFIED, "the run's pinned task contract is not retrievable by digest", {
        runId: request.runId,
        expected: run.contract_digest,
        found: contract?.digest ?? null,
      });
    }
    if (digestOf(request.contract) !== run.contract_digest) {
      return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "the supplied task contract is not the run's immutable contract", {
        runId: request.runId,
        expected: run.contract_digest,
        found: contract.digest,
      });
    }
    const named = request.snapshot.bootstrapPlan;
    if (request.snapshot.repositories.length > 0 || named === undefined) {
      return deny(ReasonCode.EVIDENCE_MISSING, "a BOOTSTRAP_PLAN candidate names its PLAN and joins no repository", {
        runId: request.runId,
        repositories: request.snapshot.repositories.length,
        bootstrapPlan: named ?? null,
      });
    }
    const current = currentBootstrapPlan(request.runId, this.artifacts.latest<unknown>(request.runId, ArtifactKind.PLAN));
    if (!current.allowed) return current as Decision<TrustedBootstrapPlanReview>;
    if (!sameBootstrapPlanBinding(current.value.binding, named)) {
      return deny(ReasonCode.EVIDENCE_STALE, "the candidate names a PLAN, manifest or planned outputs that are not the run's current ones", {
        runId: request.runId,
        candidate: named,
        current: current.value.binding,
      });
    }
    return allow(ReasonCode.OK, {
      runId: request.runId,
      snapshot: request.snapshot,
      contract: contract.content,
      contractDigest: run.contract_digest,
      binding: current.value.binding,
      outputs: current.value.outputs,
      manifest: current.value.manifest,
    });
  }

  /**
   * Issue #246 B2-a — a candidate's contract change, reloaded. A CONTRACT_CHANGE run's candidate must
   * name the change its current PLAN implies, and is judged against it; any other run's candidate
   * names none (null). The manifest and the base come from the PLAN artifact and the stored manifest
   * by digest, never from a request.
   */
  private contractChangeForCandidate(runId: string, snapshot: CandidateSnapshot): Decision<TrustedContractChange | null> {
    const run = this.db.get<{ kind: string; project_id: string | null; pinned_manifest_digest: string | null }>(
      `SELECT kind, project_id, pinned_manifest_digest FROM runs WHERE run_id = ?`,
      [runId],
    );
    if (!run || !isContractChangeRun(run)) {
      if (snapshot.contractChange === undefined) return allow(ReasonCode.OK, null);
      return deny(ReasonCode.INVALID_ARGUMENT, "only a CONTRACT_CHANGE run's candidate names a contract change", {
        runId,
        kind: run?.kind ?? null,
      });
    }
    const named = snapshot.contractChange;
    if (named === undefined || run.project_id === null) {
      return deny(ReasonCode.EVIDENCE_MISSING, "a CONTRACT_CHANGE candidate names the PLAN and manifest it changes", {
        runId,
        contractChange: named ?? null,
      });
    }
    const current = currentContractChangePlan(
      { kind: run.kind, projectId: run.project_id, pinnedManifestDigest: run.pinned_manifest_digest },
      this.artifacts.latest<unknown>(runId, ArtifactKind.PLAN),
      (digest) => storedManifest(this.db, digest),
    );
    if (!current.allowed) return current as Decision<TrustedContractChange | null>;
    if (!sameContractChangeBinding(current.value.binding, named)) {
      return deny(ReasonCode.EVIDENCE_STALE, "the candidate names a PLAN or manifest that is not the run's current one", {
        runId,
        candidate: named,
        current: current.value.binding,
      });
    }
    return allow(ReasonCode.OK, {
      projectId: run.project_id,
      binding: current.value.binding,
      manifest: current.value.manifest,
      baseManifest: current.value.baseManifest,
      workflowEvidence: current.value.workflowEvidence,
      target: contractChangeCoverageTarget(run.project_id, current.value.binding),
    });
  }

  /**
   * Issue #246 B2-a — what a no-repository CONTRACT_CHANGE reviewer may be shown. Trusted: the run row,
   * the candidate the run is on (whose digest covers its contract change), the pinned task contract,
   * and the change that candidate names, reloaded by `contractChangeForCandidate`.
   */
  private trustedContractChangeInputs(
    request: ContractChangeReviewRequest,
    snapshotDigest: string,
  ): Decision<TrustedContractChangeReview> {
    const run = this.db.get<{ contract_digest: string; current_candidate_digest: string | null }>(
      `SELECT contract_digest, current_candidate_digest FROM runs WHERE run_id = ?`,
      [request.runId],
    );
    if (!run || request.snapshot.runId !== request.runId) {
      return deny(ReasonCode.EVIDENCE_MISSING, "review request is not bound to a persisted run", {
        runId: request.runId,
        snapshotRunId: request.snapshot.runId,
      });
    }
    if (run.current_candidate_digest !== snapshotDigest) {
      return deny(ReasonCode.EVIDENCE_STALE, "review request is not the run's current candidate", {
        runId: request.runId,
        currentCandidate: run.current_candidate_digest,
        snapshotDigest,
      });
    }
    if (request.snapshot.contractDigest !== run.contract_digest || request.contractDigest !== run.contract_digest) {
      return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "review request is not pinned to the run contract", {
        runContractDigest: run.contract_digest,
        snapshotContractDigest: request.snapshot.contractDigest,
        suppliedContractDigest: request.contractDigest,
      });
    }
    const contract = this.artifacts
      .list<TaskContract>(request.runId, ArtifactKind.TASK_CONTRACT)
      .find((artifact) => !artifact.superseded && artifact.digest === run.contract_digest);
    if (!contract || digestOf(contract.content) !== run.contract_digest) {
      return deny(ReasonCode.CONTRACT_UNVERIFIED, "the run's pinned task contract is not retrievable by digest", {
        runId: request.runId,
        expected: run.contract_digest,
        found: contract?.digest ?? null,
      });
    }
    if (digestOf(request.contract) !== run.contract_digest) {
      return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "the supplied task contract is not the run's immutable contract", {
        runId: request.runId,
        expected: run.contract_digest,
        found: contract.digest,
      });
    }
    if (request.snapshot.repositories.length > 0 || request.snapshot.contractChange === undefined) {
      return deny(ReasonCode.EVIDENCE_MISSING, "a CONTRACT_CHANGE plan review is for a candidate that names its change and joins no repository", {
        runId: request.runId,
        repositories: request.snapshot.repositories.length,
        contractChange: request.snapshot.contractChange ?? null,
      });
    }
    const change = this.contractChangeForCandidate(request.runId, request.snapshot);
    if (!change.allowed) return change as Decision<TrustedContractChangeReview>;
    if (change.value === null) {
      return deny(ReasonCode.INVALID_ARGUMENT, "a CONTRACT_CHANGE review is for a CONTRACT_CHANGE run", { runId: request.runId });
    }
    return allow(ReasonCode.OK, {
      runId: request.runId,
      snapshot: request.snapshot,
      contract: contract.content,
      contractDigest: run.contract_digest,
      change: change.value,
    });
  }

  /** Registry uncertainty must remain distinct from fallback-eligible capacity denial. */
  private reviewerScope(provider: string): Decision<boolean> {
    try {
      const scoped = this.providers.hasRoleScoped(provider);
      if (typeof scoped !== "boolean") throw new Error("unknown provider scope");
      return allow(ReasonCode.OK, scoped);
    } catch {
      return deny(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE, "provider role scope is unavailable", { provider });
    }
  }

  /**
   * Standalone unit gates may exercise packet parsing without a composition root. Every
   * production `ControlPlane` attaches this port; its presence makes reviewer capacity a
   * precondition instead of a best-effort probe hidden in the runtime adapter.
   */
  private async admitReviewer(provider: string, scope = this.reviewerScope(provider)): Promise<Decision<void>> {
    if (!scope.allowed) return scope;
    if (!this.#capacity) return allow(ReasonCode.OK, undefined);
    return this.#capacity.refreshForBlindReview({
      provider,
      ...(scope.value ? { role: Role.BLIND_REVIEWER } : {}),
      capabilities: ["blind-review"],
      priority: "critical",
    });
  }

  /** Provider attestation must name the constituted reviewer, not a resumed producer. */
  private assertInvocationIdentity(
    runId: string,
    reviewer: ReviewerBinding,
    providerSessionId: string | null,
  ): Decision<void> {
    if (!providerSessionId) {
      return deny(ReasonCode.ISOLATION_LOST, "provider did not attest the constituted reviewer session", {
        runId,
        expectedProviderSessionId: reviewer.externalSessionId,
        providerSessionId,
      });
    }
    const producerExternalSessions = [...this.bindings.producerSessions(runId)]
      .map((sessionId) => this.sessions.get(sessionId)?.incarnation.split("#", 1)[0])
      .filter((sessionId): sessionId is string => Boolean(sessionId));
    if (producerExternalSessions.includes(providerSessionId)) {
      return deny(ReasonCode.REVIEWER_SESSION_IS_PRODUCER, "provider-attested reviewer session belongs to a producer", {
        runId,
        providerSessionId,
        producerExternalSessions,
      });
    }
    if (providerSessionId !== reviewer.externalSessionId) {
      return deny(ReasonCode.ISOLATION_LOST, "provider did not attest the constituted reviewer session", {
        runId,
        expectedProviderSessionId: reviewer.externalSessionId,
        providerSessionId,
      });
    }
    return allow(ReasonCode.OK, undefined);
  }

  private promptOverhead(request: BlindReviewRequest, change: TrustedContractChange | null = null): number {
    return this.buildPrompt(request, [], undefined, change).length;
  }

  /**
   * §18.4 — PASS requires `omittedItems=0` *and* a covered set that accounts for every
   * touched file. A reviewer that simply forgot to mention a file has not covered it.
   */
  private validateCoverage(
    packet: ReviewPacket,
    expected: Array<{ identity: string; path: string }>,
  ): ReviewPacket {
    if (packet.verdict !== "PASS") return packet;

    // §18.4 — PASS requires omittedItems=0. Normalising here, before the artifact is
    // persisted and before the audit and telemetry records are written, is what keeps a
    // packet with omissions from ever being *recorded* as a pass.
    if (packet.omittedItems.length > 0) return { ...packet, verdict: "REVISE" };

    const covered = new Set(packet.coveredFiles.map(normalizeCoverageKey));
    const missing = expected
      .map((t) => `${t.identity}:${t.path}`)
      .filter((key) => !covered.has(normalizeCoverageKey(key)));

    if (missing.length === 0) return packet;
    return { ...packet, verdict: "REVISE", omittedItems: [...packet.omittedItems, ...missing] };
  }

  latestPacket(runId: string, snapshotDigest: string): ReviewPacket | null {
    return (
      this.artifacts.latestForSnapshot<ReviewPacket>(
        runId,
        ArtifactKind.BLIND_REVIEW,
        snapshotDigest,
      )?.content ?? null
    );
  }
}

interface RawVerdict {
  verdict: ReviewVerdict;
  coveredFiles: string[];
  omittedItems: string[];
  findings: ReviewFinding[];
}

interface ReviewerBinding {
  sessionId: string;
  incarnation: string;
  externalSessionId: string;
  generation: number;
  preference: ReviewerPreference;
  roleKey: string;
  workdir: string;
}

type ReviewerIsolation = {
  packetRoot: string;
  denyReadPaths: readonly string[];
  emptyEnvironment: true;
  network: "provider-only";
  tools: "none";
};

/** The isolation field is optional on the wire contract; every reviewer request carries it. */
type IsolatedInvocationRequest = InvocationRequest & { isolation: ReviewerIsolation };

interface ReviewOutcome {
  verdict: RawVerdict;
  providerSessionId: string;
  reviewer: ReviewerBinding;
  /** Durable audit evidence for the fresh sessions that saw individual diff chunks. */
  chunkReviewers: ChunkReviewerEvidence[];
  /** Every provider process whose proxy record is bound into the authoritative packet. */
  egressEvidence: ReviewerEgressRecord[];
}

interface ChunkReviewerEvidence {
  sessionId: string;
  incarnation: string;
  providerSessionId: string;
  generation: number;
  provider: string;
}

const REVIEWER_SYSTEM_PROMPT = [
  "You are an independent blind reviewer for a production gate.",
  "You did not write this change and you have no access to how it was produced.",
  "Judge only the candidate diff against the stated contract and the verification evidence.",
  "Attack the result: look for correctness defects, regressions, security issues, scope creep,",
  "missing evidence and stale claims. Do not praise. Do not restate the diff.",
  "If you could not examine something, say so in omittedItems rather than guessing.",
].join(" ");

/** The same independent reviewer, told that the candidate is a plan's outputs rather than a diff. */
const BOOTSTRAP_PLAN_REVIEWER_SYSTEM_PROMPT = [
  "You are an independent blind reviewer for a production gate.",
  "You did not write this plan and you have no access to how it was produced.",
  "Judge only the planned outputs against the stated task contract and the project manifest.",
  "Attack the result: look for correctness defects, security issues, scope creep, outputs the",
  "manifest does not call for and outputs it calls for that are missing. Do not praise.",
  "If you could not examine something, say so in omittedItems rather than guessing.",
].join(" ");

/** The same independent reviewer, told that the candidate is a proposed project manifest (#246 B2-a). */
const CONTRACT_CHANGE_REVIEWER_SYSTEM_PROMPT = [
  "You are an independent blind reviewer for a production gate.",
  "You did not write this change and you have no access to how it was produced.",
  "Judge only the proposed project manifest against the stated task contract and the base manifest it replaces.",
  "Attack the result: look for commands that do not check what they claim, evidence the manifest stops",
  "requiring, CI workflows it trusts without reason, scope creep and anything missing. Do not praise.",
  "If you could not examine something, say so in omittedItems rather than guessing.",
].join(" ");

/**
 * Issue #246 B2-a — the proposed and base manifests a CONTRACT_CHANGE reviewer judges, both as the
 * gate reloaded them by digest, and the CI workflows a later activation will check.
 */
const contractChangeSection = (change: TrustedContractChange): string[] => [
  "## Contract change",
  "This run proposes a new project manifest. It replaces the base manifest only if it is approved and",
  "later activated; until then every run, this one included, is verified against the base.",
  `Plan digest: ${change.binding.planDigest}`,
  `Proposed manifest digest: ${change.binding.manifestDigest}`,
  `Base manifest digest: ${change.binding.baseManifestDigest}`,
  `Coverage item for the proposed manifest: ${change.target.identity}:${change.target.path}`,
  "",
  "### Proposed manifest",
  "```json",
  JSON.stringify(change.manifest, null, 2),
  "```",
  "",
  "### Base manifest",
  "```json",
  JSON.stringify(change.baseManifest, null, 2),
  "```",
  "",
  "### CI workflows a later activation must verify",
  "```json",
  JSON.stringify(change.workflowEvidence, null, 2),
  "```",
  "",
];

const parseVerdict = (input: unknown): RawVerdict | null => {
  const value =
    typeof input === "string"
      ? (() => {
          try {
            return JSON.parse(input) as unknown;
          } catch {
            return null;
          }
        })()
      : input;
  if (!isPlainRecord(value) || !hasExactKeys(value, ["verdict", "coveredFiles", "omittedItems", "findings"])) return null;
  const record = value as Record<string, unknown>;
  const verdict = record["verdict"];
  if (verdict !== "PASS" && verdict !== "REVISE" && verdict !== "BLOCK") return null;
  if (!isStringArray(record["coveredFiles"]) || !isStringArray(record["omittedItems"])) return null;
  if (!Array.isArray(record["findings"]) || !record["findings"].every(isReviewFinding)) return null;
  return {
    verdict,
    coveredFiles: record["coveredFiles"],
    omittedItems: record["omittedItems"],
    findings: record["findings"],
  };
};

const REVIEW_CATEGORIES = new Set<ReviewFindingCategory>([
  "correctness", "regression", "security", "scope", "performance", "maintainability", "evidence", "freshness", "source",
]);
const REVIEW_SEVERITIES = new Set<ReviewFinding["severity"]>(["INFO", "MINOR", "MAJOR", "BLOCKER"]);

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/**
 * The runtime constructs this record only after the live proxy probes pass. The gate still
 * validates its durable shape instead of treating an adapter's `isolationAttested` boolean
 * as sufficient: the review artifact must visibly contain an ALLOW, DENY, direct-socket
 * refusal, timestamps, and no credential-shaped content.
 */
const normalizeEgressEndpoint = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const endpoint = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    endpoint.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(endpoint)
  ) return null;
  return endpoint;
};

const sameEndpointSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((endpoint) => right.includes(endpoint));

const reviewerEgressRecordProblem = (
  record: ReviewerEgressRecord,
  provider: string,
  endpointPolicy: Readonly<Record<string, readonly string[]>>,
): string | null => {
  if (record.provider !== provider) return "provider-mismatch";
  if (!Array.isArray(record.allowedEndpoints) || record.allowedEndpoints.length === 0) return "allowlist-missing";
  const configured = endpointPolicy[provider];
  if (!configured || configured.length === 0) return "provider-policy-missing";
  const expectedEndpoints = [...new Set(configured.map(normalizeEgressEndpoint))];
  const allowedEndpoints = record.allowedEndpoints.map(normalizeEgressEndpoint);
  if (
    expectedEndpoints.some((endpoint) => endpoint === null) ||
    allowedEndpoints.some((endpoint) => endpoint === null) ||
    new Set(allowedEndpoints).size !== allowedEndpoints.length
  ) return "allowlist-invalid";
  const expected = expectedEndpoints as string[];
  const allowedList = allowedEndpoints as string[];
  // `allowlist.txt` is exactly one normalized hostname per line. The durable record must
  // name the same daemon-owned policy rather than an adapter-chosen plausible-looking host.
  if (!sameEndpointSet(allowedList, expected)) return "allowlist-policy-mismatch";
  if (record.allowedEndpoints.some((endpoint, index) => endpoint !== allowedList[index])) return "allowlist-not-canonical";
  if (record.allowlistDigest !== sha256(`${record.allowedEndpoints.join("\n")}\n`)) return "allowlist-digest-mismatch";
  if (!Number.isInteger(record.proxyPort) || record.proxyPort < 1 || record.proxyPort > 65_535) return "proxy-port-invalid";
  if (record.phase !== "session-bootstrap" && record.phase !== "reviewer-invocation") return "phase-invalid";
  if (!record.jsonl || credentialBearingField({ egress: record.jsonl })) return "proxy-log-unsafe";
  const events = record.jsonl
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return isPlainRecord(parsed) ? parsed : null;
      } catch {
        return null;
      }
    });
  if (events.length === 0 || events.some((event) => event === null)) return "proxy-log-not-jsonl";
  const jsonl = events as Record<string, unknown>[];
  const sameHost = (event: Record<string, unknown>, host: string): boolean =>
    typeof event["host"] === "string" && event["host"].toLowerCase() === host.toLowerCase();
  const samePort = (event: Record<string, unknown>): boolean => String(event["port"]) === "443";
  const stamped = (event: Record<string, unknown>): boolean => typeof event["t"] === "number";
  const allowed = record.probes?.allowedEndpoint;
  const denied = record.probes?.deniedEndpoint;
  const direct = record.probes?.directSocket;
  if (
    !allowed ||
    !denied ||
    !Array.isArray(direct) ||
    !isPlainRecord(allowed) ||
    !isPlainRecord(denied) ||
    direct.some((probe) => !isPlainRecord(probe))
  ) return "probe-shape-missing";
  if (allowed.connected !== true || allowed.statusCode !== 200 || !allowedList.includes(allowed.host)) return "allow-probe-missing";
  if (
    denied.denied !== true ||
    denied.statusCode !== 403 ||
    allowedList.includes(denied.host) ||
    !REVIEWER_EGRESS_DENY_PROBE_ENDPOINTS.includes(denied.host)
  ) return "real-deny-probe-missing";
  const modes = new Set(direct.map((probe) => probe.proxyMode));
  if (
    !modes.has("unset") ||
    !modes.has("override") ||
    direct.some((probe) => probe.blocked !== true || probe.connected === true)
  ) return "direct-socket-probe-missing";
  if (!jsonl.some((event) =>
    event["verdict"] === "START" &&
    stamped(event) &&
    Number(event["port"]) === record.proxyPort &&
    event["allowlistDigest"] === record.allowlistDigest,
  )) return "allowlist-binding-missing";
  if (jsonl.some((event) => {
    if (event["verdict"] !== "ALLOW") return false;
    const host = typeof event["host"] === "string" ? event["host"].toLowerCase() : null;
    return host === null || !allowedList.includes(host);
  })) return "unexpected-allow-jsonl";
  if (!jsonl.some((event) => event["verdict"] === "ALLOW" && stamped(event) && samePort(event) && sameHost(event, allowed.host))) {
    return "allow-jsonl-missing";
  }
  if (!jsonl.some((event) => event["verdict"] === "DENY" && stamped(event) && samePort(event) && sameHost(event, denied.host))) {
    return "deny-jsonl-missing";
  }
  return null;
};

const hasExactKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item): item is string => typeof item === "string");

const isReviewFinding = (value: unknown): value is ReviewFinding => {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["category", "severity", "repository", "path", "summary", "detail"])) return false;
  return (
    typeof value["category"] === "string" && REVIEW_CATEGORIES.has(value["category"] as ReviewFindingCategory) &&
    typeof value["severity"] === "string" && REVIEW_SEVERITIES.has(value["severity"] as ReviewFinding["severity"]) &&
    typeof value["repository"] === "string" &&
    (typeof value["path"] === "string" || value["path"] === null) &&
    typeof value["summary"] === "string" &&
    typeof value["detail"] === "string"
  );
};

const normalizeCoverageKey = (key: string): string => key.replace(/^\.\//, "").trim();

/**
 * §18.3 — logical inputs the gate never serialises into a reviewer prompt.
 *
 * These are true structurally: none is a field of `BlindReviewRequest`, so `buildPrompt`
 * has nothing to serialise them from. That is why they can be asserted without measuring
 * anything.
 *
 * Sandbox facts are the opposite: filesystem, network and tool confinement are properties of
 * a seatbelt profile, and stating them here would be a claim about something this list cannot
 * see. #360 was filed because the manifest had drifted into exactly that — advertising
 * `network: "provider-only"` and `tools: "none"` that the profile did not implement.
 * `reviewerWithheldIsLogicalOnly` fails if a sandbox-domain term is added back.
 */
export const LOGICAL_WITHHELD_INPUTS = Object.freeze([
  "worker reasoning",
  "CTO reasoning",
  "chat history",
  "producer self-assessment",
] as const);

/** Terms naming a runtime boundary rather than a prompt input. */
const SANDBOX_DOMAIN_TERMS = [
  "network",
  "filesystem",
  "file system",
  "tools",
  "socket",
  "path",
  "egress",
  "process",
  "sandbox",
];

/**
 * True when every withheld entry is a logical prompt input. A sandbox term here would be an
 * unmeasured claim: this manifest is built from the request, and cannot observe a profile.
 */
export const reviewerWithheldIsLogicalOnly = (withheld: readonly string[]): boolean =>
  withheld.every(
    (entry) => !SANDBOX_DOMAIN_TERMS.some((term) => entry.toLowerCase().includes(term)),
  );

const splitCoverageKey = (key: string): { identity: string; path: string } | null => {
  // A manifest item's path is `#manifest/<digest>`, and a digest has a colon of its own (#246 B2-a).
  const manifest = key.indexOf(":#manifest/");
  const separator = manifest > 0 ? manifest : key.lastIndexOf(":");
  if (separator <= 0 || separator === key.length - 1) return null;
  return { identity: key.slice(0, separator), path: key.slice(separator + 1) };
};

interface SliceCoverageTarget {
  /** The public `<repository>:<path>` claim a reviewer is allowed to make. */
  file: string;
  /** Internal, unique identity for the exact diff range that supplied that path. */
  slice: string;
}

interface ReviewChunkPart {
  identity: string;
  diff: string;
  files: string[];
  coverageTargets: SliceCoverageTarget[];
}

type ReviewChunkInput = ReviewChunkPart | { identity: string; diff: string; files: string[] };

const coverageTargetsFor = (part: ReviewChunkInput): SliceCoverageTarget[] =>
  "coverageTargets" in part
    ? part.coverageTargets
    : part.files.map((path) => ({
        file: `${part.identity}:${path}`,
        // The fallback exists only for the direct unit helper. Production chunks always
        // carry the explicit range identity generated by splitDiffs.
        slice: `${part.identity}:${path}:whole`,
      }));

const validateChunkCoverage = (
  claims: readonly string[],
  chunk: readonly ReviewChunkInput[],
): Decision<{ files: string[]; slices: string[] }> => {
  const assigned = new Set(chunk.flatMap((part) => part.files.map((path) => `${part.identity}:${path}`)));
  for (const claim of claims) {
    const parsed = splitCoverageKey(claim);
    if (!parsed || claim !== `${parsed.identity}:${parsed.path}` || !assigned.has(claim)) {
      return deny(ReasonCode.COVERAGE_INCOMPLETE, "reviewer claimed coverage outside its assigned chunk", {
        claim,
        assigned: [...assigned],
      });
    }
  }
  const files = [...new Set(claims)];
  const claimed = new Set(files);
  const slices = chunk
    .flatMap(coverageTargetsFor)
    .filter((target) => claimed.has(target.file))
    .map((target) => target.slice);
  return allow(ReasonCode.OK, { files, slices: [...new Set(slices)] });
};

const worseVerdict = (a: ReviewVerdict, b: ReviewVerdict): ReviewVerdict => {
  const rank = { PASS: 0, REVISE: 1, BLOCK: 2 } as const;
  return rank[b] > rank[a] ? b : a;
};

const dedupeFindings = (findings: ReviewFinding[]): ReviewFinding[] => {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = digestOf({ c: f.category, r: f.repository, p: f.path, s: f.summary });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const splitDiffs = (
  diffs: Array<{ identity: string; diff: string; files: string[] }>,
  budget: number,
): ReviewChunkPart[][] => {
  const chunks: ReviewChunkPart[][] = [];
  let current: ReviewChunkPart[] = [];
  let size = 0;
  for (const repo of diffs) {
    for (const part of splitByFile(repo, budget)) {
      if (size + part.diff.length > budget && current.length > 0) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push(part);
      size += part.diff.length;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks.length > 0 ? chunks : [[]];
};

/** Split on file boundaries first, then bounded ranges when one file alone is oversized. */
const splitByFile = (
  repo: { identity: string; diff: string; files: string[] },
  budget: number,
): ReviewChunkPart[] => {
  if (repo.diff.length <= budget) return [wholeFilePart(repo.identity, repo.diff, repo.files)];
  const sections = repo.diff.split(/(?=^diff --git )/m).filter(Boolean);
  const parts: ReviewChunkPart[] = [];
  let buffer = "";
  let files: string[] = [];
  for (const section of sections) {
    const named = /^diff --git a\/(\S+) b\//m.exec(section)?.[1];
    if (section.length > budget) {
      if (buffer.length > 0) {
        parts.push(wholeFilePart(repo.identity, buffer, files));
        buffer = "";
        files = [];
      }
      if (!named) {
        // A malformed patch cannot be attributed to a touched path, so do not pretend a
        // range split supplies reviewable evidence for it.
        return [wholeFilePart(repo.identity, repo.diff, [])];
      }
      parts.push(...splitOversizedSection(repo.identity, named, section, budget));
      continue;
    }
    if (buffer.length + section.length > budget && buffer.length > 0) {
      parts.push(wholeFilePart(repo.identity, buffer, files));
      buffer = "";
      files = [];
    }
    buffer += section;
    if (named) files.push(named);
  }
  if (buffer.length > 0) parts.push(wholeFilePart(repo.identity, buffer, files));
  return parts;
};

const wholeFilePart = (identity: string, diff: string, files: string[]): ReviewChunkPart => ({
  identity,
  diff,
  files,
  coverageTargets: files.map((path) => ({
    file: `${identity}:${path}`,
    slice: `${identity}:${path}:whole`,
  })),
});

const splitOversizedSection = (
  identity: string,
  path: string,
  section: string,
  budget: number,
): ReviewChunkPart[] => {
  const headerEnd = section.indexOf("\n") + 1;
  const header = headerEnd > 0 ? section.slice(0, headerEnd) : "";
  const payload = section.slice(header.length);
  const capacity = budget - header.length;
  if (capacity <= 0) return [wholeFilePart(identity, section, [path])];

  const parts: ReviewChunkPart[] = [];
  for (let offset = 0; offset < payload.length; offset += capacity) {
    parts.push({
      identity,
      diff: `${header}${payload.slice(offset, offset + capacity)}`,
      files: [path],
      coverageTargets: [{
        file: `${identity}:${path}`,
        slice: `${identity}:${path}:range:${offset}`,
      }],
    });
  }
  return parts;
};

export const __testing = { splitDiffs, parseVerdict, worseVerdict, validateChunkCoverage };
