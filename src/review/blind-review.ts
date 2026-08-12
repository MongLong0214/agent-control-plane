import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Clock } from "../core/clock.ts";
import { digestOf, sha256 } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
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
import type { InvocationRequest, InvocationResult, ProviderRegistry } from "../runtime/provider.ts";
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
 * PRD §18 — mandatory independent blind review.
 *
 * The gate is invoked by the control plane after deterministic verification passes.
 * There is no operation on any agent-facing surface that requests, skips or overrides
 * it: `manualInvocation` exists solely to return the denial (§18.2).
 */
export class BlindReviewGate {
  readonly #pipelineCapability = Symbol("blind-review-control-plane");
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
  ) {}

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
    const reviewer = await this.constituteReviewer(request.runId);
    if (!reviewer.allowed) return reviewer as Decision<ReviewPacket>;
    const reviewers = [reviewer.value];
    let authoritativeReviewer = reviewer.value;

    try {
      const collected = await this.collectDiffs(request.snapshot);
      if (!collected.allowed) return collected as Decision<ReviewPacket>;
      const { diffs, binaryArtifacts } = collected.value;

      const totalChars = diffs.reduce((n, d) => n + d.diff.length, 0) + this.promptOverhead(request);
      const chunked = totalChars > CHUNK_THRESHOLD_CHARS;

      const outcome = chunked
        ? await this.chunkedReview(request, diffs, authoritativeReviewer)
        : await this.singleReview(request, diffs, authoritativeReviewer);

      if (!outcome.allowed) return outcome as Decision<ReviewPacket>;
      authoritativeReviewer = outcome.value.reviewer;
      if (authoritativeReviewer.sessionId !== reviewer.value.sessionId) reviewers.push(authoritativeReviewer);

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
      // Do not revoke a replacement owned by another attempt. Each session constituted by
      // this attempt is stopped explicitly, including the final chunk reviewer.
      if (this.bindings.isCurrent(authoritativeReviewer.roleKey, authoritativeReviewer.generation)) {
        this.bindings.revoke(authoritativeReviewer.roleKey, "blind review complete");
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
    runId: string,
    purpose: "blind-review" | "blind-review-final" = "blind-review",
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
    const roleKey = roleKeyFor(Role.BLIND_REVIEWER, { runId });
    const attempts: Array<{ preference: ReviewerPreference; reason: string }> = [];

    for (const preference of [this.preferences.preferred, ...this.preferences.fallbacks]) {
      const adapter = this.providers.get(preference.provider);
      if (!adapter) {
        attempts.push({ preference, reason: "no adapter registered" });
        continue;
      }
      const health = await adapter.probeRuntime();
      if (health === "UNAVAILABLE") {
        attempts.push({ preference, reason: "runtime unavailable" });
        continue;
      }

      // The reviewer receives immutable packet data over stdin. Its cwd is intentionally
      // empty so a read-only runtime cannot discover the candidate checkout by walking up
      // from the daemon's repository. Provider-level OS confinement is an additional
      // boundary; this directory is not represented as a sufficient substitute for it.
      const workdir = mkdtempSync(join(tmpdir(), "acp-review-"));
      const handle = await adapter.startSession({
        model: preference.model,
        effort: preference.effort,
        workdir,
        purpose,
      });
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
            mode: preference === this.preferences.preferred ? "PREFERRED" : "FALLBACK",
            reason: `constituting ${purpose}`,
          })
        : this.bindings.bind({
            roleKey,
            role: Role.BLIND_REVIEWER,
            sessionId: session.sessionId,
            runId,
            mode: preference === this.preferences.preferred ? "PREFERRED" : "FALLBACK",
          });
      if (!bound.allowed) {
        this.sessions.transition(session.sessionId, SessionLifecycle.STOPPED, "binding refused");
        rmSync(workdir, { recursive: true, force: true });
        attempts.push({ preference, reason: bound.reasonCode });
        continue;
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
    // Canonical, not as-configured: the sandbox profile matches kernel-resolved paths and
    // filters this list against the *realpath* of the packet root. A symlink alias — the
    // `/var` → `/private/var` case every macOS temp path takes — would compile to a deny
    // rule that never matches anything, so the withholding would be claimed and not done.
    const denyReadPaths = new Set<string>([canonical(process.cwd())]);
    const databasePath = this.db.raw.name;
    if (databasePath && databasePath !== ":memory:") denyReadPaths.add(canonical(databasePath));
    for (const repository of request.snapshot.repositories) {
      const checkout = this.repositories.byIdentity(repository.identity)?.checkoutPath;
      if (checkout) denyReadPaths.add(canonical(checkout));
    }
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
      isolation: {
        packetRoot: reviewer.workdir,
        denyReadPaths: [...denyReadPaths],
        emptyEnvironment: true,
        network: "deny",
        tools: "none",
      },
    };
  }

  private assertIsolationAttested(
    runId: string,
    reviewer: ReviewerBinding,
    result: InvocationResult,
  ): Decision<void> {
    // Only an explicit attestation counts. Anything else — including an adapter that
    // simply omits the field — is an unprovable isolation claim, which §18.3 treats as a
    // lost boundary rather than a benign default.
    if (result.isolationAttested === true) return allow(ReasonCode.OK, undefined);
    return deny(ReasonCode.ISOLATION_LOST, "reviewer adapter did not attest packet-only isolation", {
      runId,
      provider: reviewer.preference.provider,
      reviewerSessionId: reviewer.sessionId,
      packetRoot: reviewer.workdir,
    });
  }

  private async singleReview(
    request: BlindReviewRequest,
    diffs: Array<{ identity: string; diff: string; files: string[] }>,
    reviewer: ReviewerBinding,
  ): Promise<Decision<ReviewOutcome>> {
    const adapter = this.providers.require(reviewer.preference.provider);
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
    return allow(ReasonCode.OK, { verdict: parsed, providerSessionId: result.providerSessionId!, reviewer });
  }

  /**
   * §18.5 — chunk reviewers, then a coverage reducer that verifies every file was seen
   * at least once, finding dedupe, and a final fresh reviewer over the reduced set.
   */
  private async chunkedReview(
    request: BlindReviewRequest,
    diffs: Array<{ identity: string; diff: string; files: string[] }>,
    reviewer: ReviewerBinding,
  ): Promise<Decision<ReviewOutcome>> {
    const adapter = this.providers.require(reviewer.preference.provider);
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
    const covered = new Set<string>();
    const findings: ReviewFinding[] = [];
    const omitted: string[] = [];
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
      const result = await adapter.invoke(this.reviewInvocation(
        request,
        reviewer,
        prompt,
        `${request.runId}:${reviewer.sessionId}:chunk${index + 1}`,
      ));
      const isolation = this.assertIsolationAttested(request.runId, reviewer, result);
      if (!isolation.allowed) return isolation as Decision<ReviewOutcome>;
      const parsed = result.ok ? parseVerdict(result.json ?? result.text) : null;
      if (!parsed) {
        // A chunk that did not produce a usable verdict is an omission, not a pass.
        omitted.push(...chunk.flatMap((c) => c.files.map((f) => `${c.identity}:${f}`)));
        continue;
      }
      const chunkCoverage = validateChunkCoverage(parsed.coveredFiles, chunk);
      if (!chunkCoverage.allowed) return chunkCoverage as Decision<ReviewOutcome>;
      for (const file of chunkCoverage.value) covered.add(file);
      omitted.push(...parsed.omittedItems);
      findings.push(...parsed.findings);
      worst = worseVerdict(worst, parsed.verdict);
    }

    // Coverage reducer: every touched file must have been seen by at least one chunk.
    const expected = snapshotCoverageTargets(request.snapshot).map((t) => `${t.identity}:${t.path}`);
    const unseen = expected.filter((key) => !covered.has(key));
    omitted.push(...unseen);

    const reduced: RawVerdict = {
      verdict: worst,
      coveredFiles: [...covered],
      omittedItems: [...new Set(omitted)],
      findings: dedupeFindings(findings),
    };

    // §18.5 — the reduced result is not the verdict. A *final fresh reviewer* judges it,
    // and only that judgement is authoritative.
    const finalReviewer = await this.constituteReviewer(request.runId, "blind-review-final");
    if (!finalReviewer.allowed) return finalReviewer as Decision<never>;

    const finalPrompt = this.buildFinalPrompt(request, reduced, chunks.length);
    if (finalPrompt.length > CHUNK_THRESHOLD_CHARS) {
      this.disposeReviewer(finalReviewer.value, "final review prompt exceeds context budget");
      return deny(ReasonCode.EVIDENCE_MISSING, "the reduced final-review prompt exceeds the context budget", {
        runId: request.runId,
        length: finalPrompt.length,
        budget: CHUNK_THRESHOLD_CHARS,
      });
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
      this.disposeReviewer(finalReviewer.value, "final reviewer did not attest isolation");
      return finalIsolation as Decision<ReviewOutcome>;
    }

    if (!finalResult.ok) {
      this.disposeReviewer(finalReviewer.value, "final review did not complete");
      return deny(ReasonCode.EVIDENCE_MISSING, "final chunked reviewer did not complete", {
        runId: request.runId,
        exitCode: finalResult.exitCode,
        error: finalResult.error,
      });
    }
    const finalVerdict = parseVerdict(finalResult.json ?? finalResult.text);
    if (!finalVerdict) {
      this.disposeReviewer(finalReviewer.value, "final review returned invalid verdict");
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
      this.disposeReviewer(finalReviewer.value, "provider session attestation failed");
      return attested as Decision<ReviewOutcome>;
    }

    return allow(ReasonCode.OK, {
      verdict: {
        // The final reviewer may not erase coverage gaps the reducer established.
        verdict: worseVerdict(finalVerdict.verdict, reduced.omittedItems.length > 0 ? "REVISE" : "PASS"),
        // Only a reviewer that actually saw a chunk may claim its paths. The final reviewer
        // judges the reduced result and therefore cannot manufacture diff coverage.
        coveredFiles: reduced.coveredFiles,
        omittedItems: [...new Set([...reduced.omittedItems, ...finalVerdict.omittedItems])],
        findings: dedupeFindings([...reduced.findings, ...finalVerdict.findings]),
      },
      providerSessionId: finalResult.providerSessionId!,
      reviewer: finalReviewer.value,
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
      inputManifest: {
        contract: true,
        snapshotManifest: true,
        diff: true,
        verificationEvidence: true,
        projectContext: false,
        // §18.3 — the reviewer is blind to how the candidate was produced.
        withheld: [
          "worker reasoning",
          "CTO reasoning",
          "chat history",
          "producer self-assessment",
          "previous verdicts",
          "daemon state",
          "trusted credentials",
          "candidate checkout paths",
        ],
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

  private disposeReviewer(reviewer: ReviewerBinding, reason: string): void {
    if (this.bindings.isCurrent(reviewer.roleKey, reviewer.generation)) {
      this.bindings.revoke(reviewer.roleKey, reason);
    }
    this.sessions.transition(reviewer.sessionId, SessionLifecycle.STOPPED, reason);
    rmSync(reviewer.workdir, { recursive: true, force: true });
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
  network: "deny";
  tools: "none";
};

/** The isolation field is optional on the wire contract; every reviewer request carries it. */
type IsolatedInvocationRequest = InvocationRequest & { isolation: ReviewerIsolation };

interface ReviewOutcome {
  verdict: RawVerdict;
  providerSessionId: string;
  reviewer: ReviewerBinding;
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

const splitCoverageKey = (key: string): { identity: string; path: string } | null => {
  const separator = key.lastIndexOf(":");
  if (separator <= 0 || separator === key.length - 1) return null;
  return { identity: key.slice(0, separator), path: key.slice(separator + 1) };
};

const validateChunkCoverage = (
  claims: readonly string[],
  chunk: Array<{ identity: string; diff: string; files: string[] }>,
): Decision<string[]> => {
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
  return allow(ReasonCode.OK, [...new Set(claims)]);
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
): Array<Array<{ identity: string; diff: string; files: string[] }>> => {
  const chunks: Array<Array<{ identity: string; diff: string; files: string[] }>> = [];
  let current: Array<{ identity: string; diff: string; files: string[] }> = [];
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
): Array<{ identity: string; diff: string; files: string[] }> => {
  if (repo.diff.length <= budget) return [repo];
  const sections = repo.diff.split(/(?=^diff --git )/m).filter(Boolean);
  const parts: Array<{ identity: string; diff: string; files: string[] }> = [];
  let buffer = "";
  let files: string[] = [];
  for (const section of sections) {
    const named = /^diff --git a\/(\S+) b\//m.exec(section)?.[1];
    if (section.length > budget) {
      if (buffer.length > 0) {
        parts.push({ identity: repo.identity, diff: buffer, files });
        buffer = "";
        files = [];
      }
      if (!named) {
        // A malformed patch cannot be attributed to a touched path, so do not pretend a
        // range split supplies reviewable evidence for it.
        return [{ identity: repo.identity, diff: repo.diff, files: [] }];
      }
      parts.push(...splitOversizedSection(repo.identity, named, section, budget));
      continue;
    }
    if (buffer.length + section.length > budget && buffer.length > 0) {
      parts.push({ identity: repo.identity, diff: buffer, files });
      buffer = "";
      files = [];
    }
    buffer += section;
    if (named) files.push(named);
  }
  if (buffer.length > 0) parts.push({ identity: repo.identity, diff: buffer, files });
  return parts;
};

const splitOversizedSection = (
  identity: string,
  path: string,
  section: string,
  budget: number,
): Array<{ identity: string; diff: string; files: string[] }> => {
  const headerEnd = section.indexOf("\n") + 1;
  const header = headerEnd > 0 ? section.slice(0, headerEnd) : "";
  const payload = section.slice(header.length);
  const capacity = budget - header.length;
  if (capacity <= 0) return [{ identity, diff: section, files: [path] }];

  const parts: Array<{ identity: string; diff: string; files: string[] }> = [];
  for (let offset = 0; offset < payload.length; offset += capacity) {
    parts.push({ identity, diff: `${header}${payload.slice(offset, offset + capacity)}`, files: [path] });
  }
  return parts;
};

export const __testing = { splitDiffs, parseVerdict, worseVerdict, validateChunkCoverage };
