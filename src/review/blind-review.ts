import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { DispatchCapacityTarget } from "../capacity/capacity-monitor.ts";
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
  createdAt: string;
}

export interface ReviewerPreference {
  provider: string;
  model: string;
  effort: string | null;
}

export interface BlindReviewRequest {
  runId: string;
  projectId: string | null;
  executionMode: ExecutionMode;
  snapshot: CandidateSnapshot;
  contract: TaskContract;
  contractDigest: string;
  verification: VerificationReport;
}

/** The composition root supplies the capacity admission that reviewer allocation needs. */
export interface BlindReviewCapacityGate {
  refreshForBlindReview(target?: DispatchCapacityTarget): Promise<Decision<void>>;
}

/** Narrow capability the composition root hands to CandidatePipeline, not to agents. */
export type BlindReviewInvoker = (request: BlindReviewRequest) => Promise<Decision<ReviewPacket>>;

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
const reviewPacketDigest = (request: BlindReviewRequest): string =>
  digestOf({
    candidateSnapshotDigest: candidateSnapshotDigest(request.snapshot),
    contractDigest: request.contractDigest,
    verificationDigest: digestOf(request.verification),
    coverageTargets: snapshotCoverageTargets(request.snapshot).map(({ identity, path }) => `${identity}:${path}`),
  });

/**
 * PRD §18 — mandatory independent blind review.
 *
 * The gate is invoked by the control plane after deterministic verification passes.
 * There is no operation on any agent-facing surface that requests, skips or overrides
 * it: `manualInvocation` exists solely to return the denial (§18.2).
 */
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
    request: BlindReviewRequest,
    capability?: symbol,
  ): Promise<Decision<ReviewPacket>> {
    if (capability !== this.#pipelineCapability) {
      return this.manualInvocation("unscoped-review-call", request.runId) as Decision<ReviewPacket>;
    }
    const snapshotDigest = candidateSnapshotDigest(request.snapshot);

    // The caller's JSON is a transport envelope, never evidence. In particular, a caller
    // cannot manufacture a PASS report and use the public object graph as a second review
    // entrance: the exact contract and verification report are reloaded from immutable,
    // trusted artifacts and corroborated against the engine's result rows.
    const trusted = this.trustedInputs(request, snapshotDigest);
    if (!trusted.allowed) return trusted as Decision<ReviewPacket>;
    request = trusted.value;

    const expected = snapshotCoverageTargets(request.snapshot);
    const reviewers: ReviewerBinding[] = [];
    const rememberReviewer = (reviewer: ReviewerBinding): void => {
      reviewers.push(reviewer);
    };

    try {
      const collected = await this.collectDiffs(request.snapshot);
      if (!collected.allowed) return collected as Decision<ReviewPacket>;
      const { diffs, binaryArtifacts } = collected.value;

      const totalChars = diffs.reduce((n, d) => n + d.diff.length, 0) + this.promptOverhead(request);
      const chunked = totalChars > CHUNK_THRESHOLD_CHARS;

      let outcome: Decision<ReviewOutcome>;
      if (chunked) {
        outcome = await this.chunkedReview(request, diffs, rememberReviewer);
      } else {
        const reviewer = await this.constituteReviewer(request);
        if (!reviewer.allowed) return reviewer as Decision<ReviewPacket>;
        rememberReviewer(reviewer.value);
        outcome = await this.singleReview(request, diffs, reviewer.value);
      }

      if (!outcome.allowed) return outcome as Decision<ReviewPacket>;
      const authoritativeReviewer = outcome.value.reviewer;

      // A reviewer binding is a fencing token. If something replaced it while the
      // provider was working, its verdict is no longer attributable to the active role.
      if (!this.bindings.isCurrent(authoritativeReviewer.roleKey, authoritativeReviewer.generation)) {
        return deny(ReasonCode.BINDING_GENERATION_STALE, "reviewer binding changed during review", {
          runId: request.runId,
          roleKey: authoritativeReviewer.roleKey,
          generation: authoritativeReviewer.generation,
        });
      }

      const packet = this.assemble({
        request,
        snapshotDigest,
        reviewer: authoritativeReviewer,
        chunked,
        raw: outcome.value.verdict,
        providerSessionId: outcome.value.providerSessionId,
        expected,
        binaryArtifacts,
        egressEvidence: outcome.value.egressEvidence,
      });

      // §18.4 / CP-HI-04 — re-check independence at packet time: a session can join the
      // producer set after the reviewer was bound.
      const independence = this.bindings.assertReviewerIndependence(
        request.runId,
        authoritativeReviewer.sessionId,
      );
      if (!independence.allowed) {
        this.audit.record({
          kind: "BLIND_REVIEW_REJECTED",
          runId: request.runId,
          sessionId: authoritativeReviewer.sessionId,
          reasonCode: independence.reasonCode,
          evidence: independence.evidence,
        });
        return independence as Decision<ReviewPacket>;
      }

      const validated = this.validateCoverage(packet, expected);
      this.artifacts.putEvidence(
        this.evidenceWriter,
        request.runId,
        ArtifactKind.BLIND_REVIEW,
        validated,
        snapshotDigest,
      );

      this.audit.record({
        kind: "BLIND_REVIEW_COMPLETED",
        runId: request.runId,
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
          chunkReviewerSessions: outcome.value.chunkReviewers.map((chunkReviewer) => ({
            sessionId: chunkReviewer.sessionId,
            incarnation: chunkReviewer.incarnation,
            providerSessionId: chunkReviewer.providerSessionId,
            generation: chunkReviewer.generation,
            provider: chunkReviewer.provider,
          })),
        },
      });

      this.telemetry.record({
        scope: "quality",
        name: "blind_review",
        runId: request.runId,
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
          { runId: request.runId, packet: validated },
        );
      }
      if (validated.omittedItems.length > 0) {
        return deny(ReasonCode.REVIEW_OMITTED_ITEMS_PRESENT, "PASS requires zero omitted items", {
          runId: request.runId,
          omittedItems: validated.omittedItems,
        });
      }
      return allow(ReasonCode.REVIEW_PASS, validated);
    } finally {
      // Do not revoke a replacement owned by another attempt. Every reviewer constituted
      // by this attempt is stopped explicitly, including a chunk reviewer on an error path
      // before a final reviewer exists.
      const latestReviewer = reviewers.at(-1);
      if (latestReviewer && this.bindings.isCurrent(latestReviewer.roleKey, latestReviewer.generation)) {
        this.bindings.revoke(latestReviewer.roleKey, "blind review complete");
      }
      for (const reviewer of reviewers) {
        this.sessions.transition(reviewer.sessionId, SessionLifecycle.STOPPED, "blind review complete");
        rmSync(reviewer.workdir, { recursive: true, force: true });
      }
    }
  }

  /**
   * §18.1 / §18.7 — prefer GPT-5.6 Sol at xhigh; fall back to a *separate* fresh
   * session when the preferred provider is unavailable. Session and context
   * independence is required even when the provider family is reused; if no isolated
   * reviewer can be constituted the gate is not lowered — the caller waits.
   */
  private async constituteReviewer(
    request: BlindReviewRequest,
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
      const adapter = this.providers.get(preference.provider);
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
      if (health === "UNAVAILABLE") {
        attempts.push({ preference, reason: "runtime unavailable" });
        continue;
      }
      // A runtime probe does not allocate a reviewer. Once a provider is healthy enough
      // to constitute one, refresh and admit immediately before `startSession`; this is
      // the capacity precondition for the allocation, not a best-effort observation.
      const capacity = await this.admitReviewer(preference.provider);
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
          return deny(error.reasonCode, "preferred reviewer isolation could not be proved", {
            runId,
            provider: preference.provider,
            model: preference.model,
            effort: preference.effort,
            reason: message,
            attempts,
          });
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
    request: BlindReviewRequest,
    reviewer: ReviewerBinding,
    prompt: string,
    correlationId: string,
  ): IsolatedInvocationRequest {
    return {
      prompt,
      systemPrompt: REVIEWER_SYSTEM_PROMPT,
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

  private reviewerIsolation(request: BlindReviewRequest, workdir: string): ReviewerIsolation {
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
      const adapter = this.providers.require(reviewer.preference.provider);
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
    request: BlindReviewRequest,
    diffs: Array<{ identity: string; diff: string; files: string[] }>,
    reviewer: ReviewerBinding,
  ): Promise<Decision<ReviewOutcome>> {
    const adapter = this.providers.require(reviewer.preference.provider);
    const capacity = await this.admitReviewer(reviewer.preference.provider);
    if (!capacity.allowed) return capacity as Decision<ReviewOutcome>;
    const result = await adapter.invoke(this.reviewInvocation(
      request,
      reviewer,
      this.buildPrompt(request, diffs),
      `${request.runId}:${reviewer.sessionId}`,
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
  ): Promise<Decision<ReviewOutcome>> {
    // A chunk adds repository/file fences and the chunk heading beyond the empty-prompt
    // measurement. Reserve a bounded envelope so the complete serialized prompt, not only
    // the patch body, remains inside the review budget.
    const chunkBudget = CHUNK_THRESHOLD_CHARS - this.promptOverhead(request) - 4_096;
    if (chunkBudget <= 0) {
      return deny(ReasonCode.EVIDENCE_MISSING, "review prompt metadata exceeds the reviewer context budget", {
        runId: request.runId,
        overhead: this.promptOverhead(request),
        budget: CHUNK_THRESHOLD_CHARS,
      });
    }
    const chunks = splitDiffs(diffs, chunkBudget);
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
      const prompt = this.buildPrompt(request, chunk, { chunk: index + 1, of: chunks.length });
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
      const adapter = this.providers.require(reviewer.preference.provider);
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
    const expected = snapshotCoverageTargets(request.snapshot).map((t) => `${t.identity}:${t.path}`);
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

    const finalPrompt = this.buildFinalPrompt(request, reduced, chunks.length);
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
    const finalResult = await this.providers.require(finalReviewer.value.preference.provider).invoke(
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
      `Packet digest: ${reviewPacketDigest(request)}`,
      "Required coverage:",
      ...snapshotCoverageTargets(request.snapshot).map((target) => `- ${target.identity}:${target.path}`),
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
      `Packet digest: ${reviewPacketDigest(request)}`,
      "Required coverage:",
      ...snapshotCoverageTargets(request.snapshot).map((target) => `- ${target.identity}:${target.path}`),
      "",
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

  private assemble(input: {
    request: BlindReviewRequest;
    snapshotDigest: string;
    reviewer: ReviewerBinding;
    chunked: boolean;
    raw: RawVerdict;
    providerSessionId: string | null;
    expected: Array<{ identity: string; path: string }>;
    binaryArtifacts: Array<{ repository: string; path: string; digest: string; method: "git-binary-patch" }>;
    egressEvidence: ReviewerEgressRecord[];
  }): ReviewPacket {
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
      inputManifest: {
        contract: true,
        snapshotManifest: true,
        diff: true,
        verificationEvidence: true,
        projectContext: false,
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
    if (!contract || digestOf(contract.content) !== run.contract_digest || digestOf(request.contract) !== run.contract_digest) {
      return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "the supplied task contract is not the run's immutable contract", {
        runId: request.runId,
        expected: run.contract_digest,
        found: contract?.digest ?? null,
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
   * Standalone unit gates may exercise packet parsing without a composition root. Every
   * production `ControlPlane` attaches this port; its presence makes reviewer capacity a
   * precondition instead of a best-effort probe hidden in the runtime adapter.
   */
  private async admitReviewer(provider: string): Promise<Decision<void>> {
    if (!this.#capacity) return allow(ReasonCode.OK, undefined);
    return this.#capacity.refreshForBlindReview({
      provider,
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

  private promptOverhead(request: BlindReviewRequest): number {
    return this.buildPrompt(request, []).length;
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
  const separator = key.lastIndexOf(":");
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
