import type { Clock } from "../core/clock.ts";
import { digestOf, sha256 } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { parseGitHubIdentity } from "../core/ids.ts";
import { isStalenessReasonCode, ReasonCode } from "../core/reason-codes.ts";
import type { BranchProfile, ProjectManifest } from "../contracts/manifest.ts";
import type { AuditLog } from "../db/audit.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { Db } from "../db/database.ts";
import { fileAt, mergeBase } from "../git/git.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { RepositoryRegistry } from "../registry/repository-registry.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { CiCheck, CiEvidenceSource, VerificationReport } from "../verify/verification-engine.ts";
import type { ReviewPacket } from "../review/blind-review.ts";
import type { CandidateSnapshot } from "../snapshot/candidate-snapshot.ts";
import { EVIDENCE_PRODUCERS } from "../db/artifacts.ts";
import {
  WriteOperation,
  type DaemonFinalizerAuthority,
  type ManagedWriteGuard,
} from "../guard/managed-write-guard.ts";
import { hotfixPropagationTargets, requiredBaseFor, validateBranchContract } from "./branch-contract.ts";
import type { TrustedCredentialStore } from "./credential-store.ts";

export const GATE_CHECK_NAME = "acp-production-gate";

/**
 * The only value a gate payload may carry for `humanGateDigest` when the run needs no
 * owner decision. A free-form digest there would let a caller satisfy the field with
 * anything at all.
 */
export const NO_HUMAN_GATE_DIGEST = digestOf({ humanGate: "NOT_REQUIRED" });
export const PROJECT_CHECK_NAME = "project-ci";

export interface GitHubClient {
  request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T>;
}

/**
 * Waiting is only for an expected CI result to appear after a successful merge. It never
 * turns a failed, untrusted, or ambiguous result into a retryable one.
 */
export interface GitHubKernelOptions {
  /** Number of exact-check observations before a missing/incomplete result is final. */
  postMergePollAttempts?: number;
  /** Delay between observations; production supplies a non-zero bounded value. */
  postMergePollIntervalMs?: number;
  /** Test seam for the bounded wait. */
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Process-local GitHub App HTTPS transport. The credential store mints and retains the
 * installation token internally; this client can receive only decoded API responses.
 *
 * Requests do not invoke `gh`: the installation token is consumed by
 * `TrustedCredentialStore` inside this process and is never placed in a child environment
 * (CP-HI-05).
 */
export class GitHubAppClient implements GitHubClient {
  constructor(private readonly credentials: TrustedCredentialStore) {}

  async request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const result = await this.credentials.githubApi({
      method,
      path,
      ...(body !== undefined ? { input: JSON.stringify(body) } : {}),
    });
    if (!result.allowed) throw new Error(`${result.reasonCode}: ${result.message}`);
    const responseBody = result.value.body.trim();
    return (responseBody ? JSON.parse(responseBody) : null) as T;
  }
}

/** PRD §24.4 — the exact payload a production gate binds to. */
export interface GatePayload {
  runId: string;
  candidateSnapshotDigest: string;
  contractDigest: string;
  verificationDigest: string;
  blindReviewDigest: string;
  humanGateDigest: string;
  bindingGeneration: number;
  exactHead: string;
  timestamp: string;
}

export interface PrepareInput {
  runId: string;
  repositoryIdentity: string;
  head: string;
  base: string;
  title: string;
  body: string;
  declaredParent?: string | null;
  activeReleases?: readonly string[];
  /** Issue or ticket references the project contract requires on a PR. */
  linkedIssues?: readonly number[];
  requireLinkage?: boolean;
  ownerSessionId: string;
  ownerBindingGeneration: number;
  exactHeadSha: string;
  /** Opaque capability supplied only by the daemon finalizer after CEO approval. */
  daemonFinalizerAuthority?: DaemonFinalizerAuthority;
}

export interface MergeInput {
  runId: string;
  repositoryIdentity: string;
  pullNumber: number;
  exactHeadSha: string;
  expectedBaseSha: string;
  mergeStrategy: BranchProfile["mergeStrategy"];
  ownerSessionId: string;
  ownerBindingGeneration: number;
  /** Opaque capability supplied only by the daemon finalizer after CEO approval. */
  daemonFinalizerAuthority?: DaemonFinalizerAuthority;
}

interface GitHubCaller {
  ownerSessionId: string;
  ownerBindingGeneration: number;
  daemonFinalizerAuthority?: DaemonFinalizerAuthority;
}

/**
 * The GitHub boundary deliberately reads the owner-gate predicate through this narrow port.
 * `ProductionGate.humanGateStatus` is the sole place that interprets approval artifacts and
 * their ingress receipts; the kernel only binds its result to a gate payload.
 */
export interface HumanGateStatusPort {
  humanGateStatus(runId: string): {
    required: boolean;
    items: readonly string[];
    satisfied: boolean;
    /** Digest of the current ProductionGate definition, supplied with the status. */
    humanGateDigest: string;
  };
}

interface PullRequest {
  number: number;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  merged: boolean;
  merge_commit_sha?: string | null;
  state: string;
  html_url: string;
  title?: string;
  body?: string | null;
}

/** The immutable branch and snapshot binding recorded by `prPrepare`. */
interface PreparedPrIntent {
  head: string;
  base: string;
  exactHeadSha: string;
  expectedBaseSha: string;
  /** Digest of the immutable candidate snapshot that supplied the frozen origin. */
  candidateSnapshotDigest: string;
  /** Immutable source branch recorded inside the candidate snapshot. */
  sourceBranch: string;
  /** Immutable source commit recorded inside the candidate snapshot. */
  sourceHead: string;
  declaredParent: string | null;
}

interface GitHubWriteTarget {
  /** The concrete branch whose claim fences this remote write. */
  targetBranch: string;
  /** Registered local checkout used by the guard to bind remote writes to this repository. */
  targetPath: string;
}

interface CheckRun {
  id: number;
  name: string;
  head_sha: string;
  conclusion: string | null;
  status: string;
  app?: { slug?: string } | null;
  check_suite?: { id?: number } | null;
  details_url?: string | null;
  output?: { title?: string | null; summary?: string | null; text?: string | null } | null;
  completed_at?: string | null;
}

interface ObservedPostMergeCheck {
  name: string;
  conclusion: string;
}

/**
 * PRD §24 — the sole writer of programmatic merges and production gates.
 *
 * Two design points carry the invariant. Trust is by provenance: a gate is accepted
 * only when its creator identity and payload digest match what this kernel recorded
 * locally, so a candidate cannot mint an approval by publishing a check with the right
 * name (CP-S35). And every external write is idempotent by operation key, so a replay
 * returns the original receipt instead of merging twice (CP-S39).
 */
export class GitHubKernel {
  /**
   * A PENDING row remains reconcilable after a daemon crash. Within this daemon, though,
   * a second caller must not seize the first caller's in-flight external write merely
   * because GitHub has already accepted it but the first caller has not reread it yet.
   */
  private readonly inFlightReservations = new Set<string>();
  /** `ProductionGate.humanGateStatus` is the sole human-gate predicate. */
  private humanGateStatusPort: HumanGateStatusPort | null = null;
  private readonly client: GitHubClient | undefined;
  private readonly postMergePollAttempts: number;
  private readonly postMergePollIntervalMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly artifacts: ArtifactStore,
    private readonly credentials: TrustedCredentialStore,
    private readonly repositories: RepositoryRegistry,
    private readonly runs: RunEngine,
    private readonly projects: ProjectRegistry,
    private readonly guard: ManagedWriteGuard,
    client?: GitHubClient,
    options: GitHubKernelOptions = {},
  ) {
    this.client = client;
    this.postMergePollAttempts = Math.max(1, Math.floor(options.postMergePollAttempts ?? 1));
    this.postMergePollIntervalMs = Math.max(0, Math.floor(options.postMergePollIntervalMs ?? 0));
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  attach(ports: { humanGateStatus?: HumanGateStatusPort }): void {
    if (ports.humanGateStatus) this.humanGateStatusPort = ports.humanGateStatus;
  }

  /**
   * CP-HI-01 — every external write this kernel performs goes through the guard, and the
   * API call is performed inside the guard's fenced authorisation lifecycle. Without this
   * the guard would be a decision function nobody consults on the paths that actually
   * mutate GitHub.
   *
   * The caller's identity is used when it has one; daemon-initiated operations
   * (gate publish, tag, projection) are authorised as the run's pinned owner.
   */
  private async mediate<T>(
    operation: WriteOperation,
    runId: string,
    repositoryIdentity: string,
    target: GitHubWriteTarget,
    caller?: GitHubCaller,
    effect?: () => T | Promise<T>,
  ): Promise<Decision<T>> {
    const run = this.runs.get(runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });

    const sessionId = caller?.ownerSessionId ?? run.ownerSessionId;
    const generation = caller?.ownerBindingGeneration ?? run.ownerBindingGeneration;
    if (!sessionId || generation == null) {
      return deny(ReasonCode.RUN_OWNER_NOT_PINNED, "run has no pinned owner to authorise against", {
        runId,
        operation,
      });
    }

    if (!effect) {
      return deny(ReasonCode.INTERNAL_ERROR, "GitHub write has no fenced effect", { operation, runId });
    }
    return this.guard.authorize({
      operation,
      repositoryIdentity,
      targetBranch: target.targetBranch,
      targetPath: target.targetPath,
      runId,
      sessionId,
      bindingGeneration: generation,
      claimedClassification: "MANAGED",
      actor: "github-kernel",
      daemonFinalizerAuthority: caller?.daemonFinalizerAuthority,
    }, () => effect());
  }

  /**
   * A completed receipt is safe to re-read from any caller, but a fresh GitHub effect is
   * admitted only while finalization is in progress and only with the daemon capability.
   * Do this before reserving a receipt so an unauthorised caller cannot manufacture a
   * durable PENDING record without ever reaching GitHub.
   */
  private assertFreshDaemonFinalization(
    runId: string,
    authority: DaemonFinalizerAuthority | undefined,
    operation: string,
  ): Decision<void> {
    const run = this.runs.get(runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
    if (
      run.state !== "CEO_APPROVED" &&
      run.state !== "MERGING" &&
      run.state !== "POST_MERGE_VERIFYING"
    ) {
      return deny(ReasonCode.WRITE_RUN_NOT_ACTIVE, "fresh GitHub finalization requires a CEO-approved run", {
        runId,
        state: run.state,
        operation,
      });
    }
    if (!this.guard.hasDaemonFinalizerAuthority(authority)) {
      return deny(ReasonCode.MERGE_AUTHORITY_DENIED, "fresh GitHub finalization requires daemon authority", {
        runId,
        state: run.state,
        operation,
      });
    }
    return allow(ReasonCode.OK, undefined);
  }

  private api(): GitHubClient {
    return this.client ?? new GitHubAppClient(this.credentials);
  }

  private slug(identity: string): Decision<{ owner: string; repo: string }> {
    const parsed = parseGitHubIdentity(identity);
    return parsed
      ? allow(ReasonCode.OK, parsed)
      : deny(ReasonCode.INVALID_ARGUMENT, "not a GitHub repository identity", { identity });
  }

  // -------------------------------------------------------------------------
  // pr_prepare
  // -------------------------------------------------------------------------

  async prPrepare(input: PrepareInput): Promise<Decision<{ pullNumber: number; url: string }>> {
    const authority = this.assertAuthority(input.runId, input.repositoryIdentity, input);
    if (!authority.allowed) return authority as Decision<{ pullNumber: number; url: string }>;

    // A PR is a write against the head branch, so it needs the same live claim a merge
    // needs — otherwise two runs can open competing PRs from the same branch (§24.3).
    const claimed = this.assertClaim(input.runId, input.repositoryIdentity, input.head);
    if (!claimed.allowed) return claimed as Decision<{ pullNumber: number; url: string }>;

    const candidate = this.candidateRepository(input.runId, input.repositoryIdentity);
    if (!candidate.allowed) return candidate as Decision<{ pullNumber: number; url: string }>;
    const candidateSnapshotDigest = this.runs.currentCandidate(input.runId);
    if (!candidateSnapshotDigest) {
      return deny(ReasonCode.EVIDENCE_MISSING, "run has no current frozen candidate", { runId: input.runId });
    }
    if (input.exactHeadSha !== candidate.value.candidateHead) {
      return deny(ReasonCode.SNAPSHOT_STALE, "PR head is not the run's frozen candidate", {
        runId: input.runId,
        expected: candidate.value.candidateHead,
        supplied: input.exactHeadSha,
      });
    }
    if (input.base !== candidate.value.baseBranch) {
      return deny(ReasonCode.PR_BRANCH_CONTRACT_VIOLATION, "PR target is not the frozen candidate base", {
        runId: input.runId,
        expected: candidate.value.baseBranch,
        supplied: input.base,
      });
    }

    const profile = this.branchProfile(input.runId);
    if (!profile.allowed) return profile as Decision<{ pullNumber: number; url: string }>;
    // The candidate snapshot's base is the PR *target*. It cannot prove the branch this
    // source was cut from: release/* may target main although it must originate at dev, and
    // hotfix/* may target dev/release although it must originate at main. Validate the frozen
    // origin from the pinned branch contract against the candidate's recorded commit instead.
    const lineage = await this.assertFrozenSourceLineage(
      input.repositoryIdentity,
      input.head,
      profile.value,
      input.declaredParent ?? null,
      candidate.value,
    );
    if (!lineage.allowed) return lineage as Decision<{ pullNumber: number; url: string }>;
    const releases = await this.activeReleases(input.repositoryIdentity);
    if (!releases.allowed) return releases as Decision<{ pullNumber: number; url: string }>;
    const contract = validateBranchContract({
      head: input.head,
      base: input.base,
      profile: profile.value,
      declaredParent: input.declaredParent ?? null,
      activeReleases: releases.value,
      sourceBranch: lineage.value.sourceBranch,
    });
    if (!contract.allowed) return contract as Decision<{ pullNumber: number; url: string }>;

    if (input.requireLinkage && (input.linkedIssues ?? []).length === 0) {
      return deny(ReasonCode.PR_LINKAGE_MISSING, "project contract requires PR issue linkage", {
        runId: input.runId,
      });
    }

    const linkedIssues = [...new Set(input.linkedIssues ?? [])].sort((a, b) => a - b);
    const prBody = this.prBody(input.body, input.runId, linkedIssues, Boolean(input.requireLinkage));
    if (this.runs.currentCandidate(input.runId) !== candidateSnapshotDigest) {
      return deny(ReasonCode.SNAPSHOT_STALE, "candidate changed while preparing its pull request", {
        runId: input.runId,
        expected: candidateSnapshotDigest,
        current: this.runs.currentCandidate(input.runId),
      });
    }
    const request = {
      runId: input.runId,
      repositoryIdentity: input.repositoryIdentity,
      head: input.head,
      base: input.base,
      exactHeadSha: input.exactHeadSha,
      expectedBaseSha: candidate.value.baseHead,
      candidateSnapshotDigest,
      sourceBranch: lineage.value.sourceBranch,
      sourceHead: lineage.value.sourceHead,
      title: input.title,
      body: prBody,
      declaredParent: input.declaredParent ?? null,
      linkedIssues,
      ownerBindingGeneration: input.ownerBindingGeneration,
    };
    const requestDigest = digestOf(request);

    const slug = this.slug(input.repositoryIdentity);
    if (!slug.allowed) return slug as Decision<{ pullNumber: number; url: string }>;
    const { owner, repo } = slug.value;

    const idempotencyKey = `pr_prepare:${input.repositoryIdentity}:${input.head}:${input.base}`;
    const existing = this.receipt(idempotencyKey);
    if (existing) {
      if (existing.request_digest !== requestDigest) {
        return deny(ReasonCode.RESOURCE_COLLISION, "PR resource is already bound to different operation intent", {
          idempotencyKey,
          existingRequestDigest: existing.request_digest,
          requestDigest,
        });
      }
      const cached = JSON.parse(existing.response_json) as { pullNumber?: number; url?: string };
      if (!cached.pullNumber || !cached.url || existing.verified !== 1) {
        if (this.inFlightReservations.has(idempotencyKey)) {
          return deny(ReasonCode.RESOURCE_COLLISION, "PR operation is in flight", { idempotencyKey });
        }
        const open = await this.api().request<PullRequest[]>(
          "GET",
          `/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(input.head)}&base=${encodeURIComponent(input.base)}&state=open`,
        );
        const matches = open.filter((pull) =>
          pull.head.sha === input.exactHeadSha &&
          pull.base.sha === candidate.value.baseHead &&
          this.hasPrRunMarker(pull.body, input.runId) &&
          (!input.requireLinkage || this.hasPrLinkage(pull.body, linkedIssues)),
        );
        if (matches.length > 1) {
          return deny(ReasonCode.RESOURCE_COLLISION, "PR operation is pending reconciliation", { idempotencyKey });
        }
        if (matches.length === 1) {
          const value = { pullNumber: matches[0]!.number, url: matches[0]!.html_url };
          const finalized = this.finalizeReservedReceipt({
            idempotencyKey,
            requestDigest,
            preexisting: false,
            afterStateDigest: digestOf({ head: matches[0]!.head.sha, base: matches[0]!.base.sha }),
            response: { ...value, intent: request },
            reread: true,
          });
          if (!finalized.allowed) return finalized as Decision<{ pullNumber: number; url: string }>;
          return allow(ReasonCode.MERGE_IDEMPOTENT_REPLAY, value, { replayed: true });
        }
        if (open.length > 0) {
          return deny(ReasonCode.RESOURCE_COLLISION, "PR operation is pending reconciliation", { idempotencyKey });
        }
        // An empty branch-pair query proves the reserved POST was never applied, so this
        // stale receipt may be reclaimed before the new attempt reserves it again.
        this.releaseReservation(idempotencyKey, requestDigest);
        return this.prPrepare(input);
      }
      const reread = await this.api().request<PullRequest>(
        "GET",
        `/repos/${owner}/${repo}/pulls/${cached.pullNumber}`,
      );
      if (
        reread.state !== "open" ||
        reread.head.sha !== input.exactHeadSha ||
        reread.head.ref !== input.head ||
        reread.base.ref !== input.base ||
        reread.base.sha !== candidate.value.baseHead ||
        reread.title !== input.title ||
        reread.body !== prBody ||
        (input.requireLinkage && !this.hasPrLinkage(reread.body, linkedIssues))
      ) {
        return deny(ReasonCode.RESOURCE_COLLISION, "cached PR no longer proves the same operation", {
          idempotencyKey,
          pullNumber: cached.pullNumber,
        });
      }
      return allow(ReasonCode.MERGE_IDEMPOTENT_REPLAY, {
        pullNumber: cached.pullNumber,
        url: cached.url,
      }, { replayed: true });
    }

    const finalization = this.assertFreshDaemonFinalization(
      input.runId,
      input.daemonFinalizerAuthority,
      "pr_prepare",
    );
    if (!finalization.allowed) return finalization as Decision<{ pullNumber: number; url: string }>;

    const open = await this.api().request<PullRequest[]>(
      "GET",
      `/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(input.head)}&base=${encodeURIComponent(input.base)}&state=open`,
    );
    if (open.length > 1 || (open[0] && !this.hasPrRunMarker(open[0]!.body, input.runId))) {
      return deny(ReasonCode.RESOURCE_COLLISION, "an open pull request already owns this branch pair", {
        head: input.head,
        base: input.base,
        matchingPulls: open.map((pull) => pull.number),
      });
    }

    const createdByUs = !open[0];
    if (createdByUs) {
      const reserved = this.reserveReceipt({
        idempotencyKey,
        operation: "pr_prepare",
        runId: input.runId,
        repositoryIdentity: input.repositoryIdentity,
        resourceType: "pull_request",
        resourceIdentity: `${owner}/${repo}@${input.head}->${input.base}`,
        beforeStateDigest: null,
        requestDigest,
      });
      if (!reserved.allowed) return reserved as Decision<{ pullNumber: number; url: string }>;
      const target = this.writeTarget(input.runId, input.repositoryIdentity, input.head);
      if (!target.allowed) return target as Decision<{ pullNumber: number; url: string }>;
      const created = await this.mediate(
        WriteOperation.GITHUB_PR,
        input.runId,
        input.repositoryIdentity,
        target.value,
        input,
        () => this.api().request<PullRequest>("POST", `/repos/${owner}/${repo}/pulls`, {
          title: input.title,
          body: prBody,
          head: input.head,
          base: input.base,
        }),
      );
      if (!created.allowed) {
        if (created.evidence["effectInvoked"] !== true) this.releaseReservation(idempotencyKey, requestDigest);
        return created as Decision<{ pullNumber: number; url: string }>;
      }
      const pull = created.value;
      return this.finishPreparedPr({
        pull,
        createdByUs,
        input,
        candidate: candidate.value,
        linkedIssues,
        idempotencyKey,
        requestDigest,
        request,
        owner,
        repo,
      });
    }
    const pull = open[0]!;

    return this.finishPreparedPr({
      pull,
      createdByUs,
      input,
      candidate: candidate.value,
      linkedIssues,
      idempotencyKey,
      requestDigest,
      request,
      owner,
      repo,
    });
  }

  private async finishPreparedPr(input: {
    pull: PullRequest;
    createdByUs: boolean;
    input: PrepareInput;
    candidate: { candidateHead: string; baseHead: string; baseBranch: string };
    linkedIssues: number[];
    idempotencyKey: string;
    requestDigest: string;
    request: Record<string, unknown>;
    owner: string;
    repo: string;
  }): Promise<Decision<{ pullNumber: number; url: string }>> {
    const { pull, createdByUs, linkedIssues, idempotencyKey, requestDigest, request, owner, repo } = input;

    // §16.2 — command success is not evidence; re-read and compare.
    const reread = await this.api().request<PullRequest>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${pull.number}`,
    );
    if (
      reread.head.sha !== input.input.exactHeadSha ||
      reread.head.ref !== input.input.head ||
      reread.base.ref !== input.input.base ||
      reread.base.sha !== input.candidate.baseHead
    ) {
      return deny(ReasonCode.MERGE_HEAD_STALE, "pull request head does not match the candidate head", {
        expected: input.input.exactHeadSha,
        observed: { head: reread.head, base: reread.base },
      });
    }
    if (input.input.requireLinkage && !this.hasPrLinkage(reread.body, linkedIssues)) {
      return deny(ReasonCode.PR_LINKAGE_MISSING, "GitHub did not persist the required PR issue linkage", {
        pullNumber: reread.number,
        linkedIssues,
      });
    }

    const value = { pullNumber: reread.number, url: reread.html_url };
    if (createdByUs) {
      const finalized = this.finalizeReservedReceipt({
        idempotencyKey,
        requestDigest,
        preexisting: false,
        afterStateDigest: digestOf({ head: reread.head.sha, base: reread.base.sha }),
        response: { ...value, intent: request },
        reread: true,
      });
      if (!finalized.allowed) return finalized as Decision<{ pullNumber: number; url: string }>;
    } else {
      this.writeReceipt({
        idempotencyKey,
        operation: "pr_prepare",
        runId: input.input.runId,
        repositoryIdentity: input.input.repositoryIdentity,
        resourceType: "pull_request",
        resourceIdentity: `${owner}/${repo}#${reread.number}`,
        preexisting: true,
        beforeStateDigest: null,
        afterStateDigest: digestOf({ head: reread.head.sha, base: reread.base.sha }),
        requestDigest,
        response: { ...value, intent: request },
        reread: true,
      });
    }
    return allow(ReasonCode.OK, value);
  }

  // -------------------------------------------------------------------------
  // gate_publish
  // -------------------------------------------------------------------------

  /**
   * §24.4 — publishes `acp-production-gate` and records the payload locally. The local
   * record is the authority; the check run is a projection of it.
   */
  async gatePublish(
    payload: GatePayload,
    repositoryIdentity: string,
    daemonFinalizerAuthority?: DaemonFinalizerAuthority,
  ): Promise<Decision<{ checkRunId: number }>> {
    const credential = await this.credentials.authenticate();
    if (!credential.allowed) return credential as Decision<{ checkRunId: number }>;

    // CP-HI-06 — the gate is an assertion that specific evidence exists. Publishing it
    // without checking that evidence would make the assertion self-issued: a caller could
    // hand over any digests and the merge kernel would then trust its own check run.
    const backed = this.assertGatePayloadBacked(payload, repositoryIdentity);
    if (!backed.allowed) return backed as Decision<{ checkRunId: number }>;
    const slug = this.slug(repositoryIdentity);
    if (!slug.allowed) return slug as Decision<{ checkRunId: number }>;
    const { owner, repo } = slug.value;

    const payloadDigest = digestOf(payload);
    const idempotencyKey = `gate_publish:${repositoryIdentity}:${payload.exactHead}:${payloadDigest}`;
    const existing = this.receipt(idempotencyKey);
    if (existing) {
      if (existing.request_digest !== payloadDigest) {
        return deny(ReasonCode.RESOURCE_COLLISION, "gate publication is pending or has different intent", {
          idempotencyKey,
        });
      }
      if (existing.verified !== 1) {
        if (this.inFlightReservations.has(idempotencyKey)) {
          return deny(ReasonCode.RESOURCE_COLLISION, "gate publication is in flight", { idempotencyKey });
        }
        const checks = await this.listCheckRuns(repositoryIdentity, payload.exactHead, GATE_CHECK_NAME);
        if (!checks.allowed) return checks as Decision<{ checkRunId: number }>;
        const creator = this.credentials.creatorIdentity();
        if (!creator) {
          return deny(
            ReasonCode.GITHUB_APP_IDENTITY_UNVERIFIED,
            "GitHub App creator identity was not retained after authentication",
            {},
          );
        }
        const observed = checks.value.filter((check) =>
          check.name === GATE_CHECK_NAME && check.head_sha === payload.exactHead,
        );
        const matches = observed.filter((check) =>
          check.name === GATE_CHECK_NAME &&
          check.head_sha === payload.exactHead &&
          check.status === "completed" &&
          check.conclusion === "success" &&
          check.app?.slug === creator &&
          /payloadDigest=(sha256:[0-9a-f]{64})/.exec(check.output?.summary ?? "")?.[1] === payloadDigest,
        );
        if (matches.length === 1) {
          const finalized = this.finalizeReservedReceipt({
            idempotencyKey,
            requestDigest: payloadDigest,
            preexisting: false,
            afterStateDigest: payloadDigest,
            response: { checkRunId: matches[0]!.id, payload, payloadDigest },
            reread: true,
          });
          if (!finalized.allowed) return finalized as Decision<{ checkRunId: number }>;
          return allow(ReasonCode.MERGE_IDEMPOTENT_REPLAY, { checkRunId: matches[0]!.id }, { replayed: true });
        }
        if (observed.length > 0) {
          return deny(ReasonCode.RESOURCE_COLLISION, "pending gate publication cannot be reconciled unambiguously", {
            idempotencyKey,
            matchingChecks: matches.map((check) => check.id),
          });
        }
        // No check with this name and head exists, so the reserved POST demonstrably did
        // not happen and the next attempt can safely claim a fresh reservation.
        this.releaseReservation(idempotencyKey, payloadDigest);
        return this.gatePublish(payload, repositoryIdentity, daemonFinalizerAuthority);
      }
      const replay = await this.verifyGate(repositoryIdentity, payload.exactHead, payload.runId);
      if (!replay.allowed || digestOf(replay.value) !== payloadDigest) {
        return deny(ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID, "cached gate no longer matches its recorded payload", {
          idempotencyKey,
        });
      }
      return allow(
        ReasonCode.MERGE_IDEMPOTENT_REPLAY,
        JSON.parse(existing.response_json) as { checkRunId: number },
        { replayed: true },
      );
    }

    const finalization = this.assertFreshDaemonFinalization(
      payload.runId,
      daemonFinalizerAuthority,
      "gate_publish",
    );
    if (!finalization.allowed) return finalization as Decision<{ checkRunId: number }>;

    const target = this.writeTargetForRun(payload.runId, repositoryIdentity);
    if (!target.allowed) return target as Decision<{ checkRunId: number }>;
    const reserved = this.reserveReceipt({
      idempotencyKey,
      operation: "gate_publish",
      runId: payload.runId,
      repositoryIdentity,
      resourceType: "check_run",
      resourceIdentity: `${owner}/${repo}@${payload.exactHead}/${GATE_CHECK_NAME}`,
      beforeStateDigest: null,
      requestDigest: payloadDigest,
    });
    if (!reserved.allowed) return reserved as Decision<{ checkRunId: number }>;

    const created = await this.mediate(
      WriteOperation.GITHUB_CHECK_RUN,
      payload.runId,
      repositoryIdentity,
      target.value,
      { ownerSessionId: this.runs.require(payload.runId).ownerSessionId!, ownerBindingGeneration: payload.bindingGeneration, daemonFinalizerAuthority },
      () => this.api().request<CheckRun>("POST", `/repos/${owner}/${repo}/check-runs`, {
        name: GATE_CHECK_NAME,
        head_sha: payload.exactHead,
        status: "completed",
        conclusion: "success",
        completed_at: this.clock.nowIso(),
        output: {
          title: "Agent Control Plane production gate",
          summary: `payloadDigest=${payloadDigest}`,
          text: JSON.stringify(payload, null, 2),
        },
      }),
    );
    if (!created.allowed) {
      if (created.evidence["effectInvoked"] !== true) this.releaseReservation(idempotencyKey, payloadDigest);
      return created as Decision<{ checkRunId: number }>;
    }
    const createdCheck = created.value as unknown;
    if (
      !createdCheck ||
      typeof createdCheck !== "object" ||
      !("id" in createdCheck) ||
      typeof createdCheck.id !== "number"
    ) {
      // A blank acknowledgement can follow an applied POST, so the receipt must remain
      // PENDING until a future reconciliation can prove whether the check exists.
      return deny(ReasonCode.EVIDENCE_MISSING, "GitHub returned no usable gate publication acknowledgement", {
        repositoryIdentity,
        exactHead: payload.exactHead,
      });
    }
    const checkRunId = createdCheck.id;

    // GitHub's POST acknowledgement is not proof that the expected check exists. Re-read
    // the commit's checks and bind the exact id, head, creator and payload projection.
    let reread: CheckRun | undefined;
    try {
      reread = await this.api().request<CheckRun>("GET", `/repos/${owner}/${repo}/check-runs/${checkRunId}`);
    } catch {
      // Some GitHub-compatible providers do not expose the singular endpoint. Their
      // commit-scoped listing still proves the exact id and every bound field.
      const checks = await this.listCheckRuns(repositoryIdentity, payload.exactHead, GATE_CHECK_NAME);
      if (!checks.allowed) return checks as Decision<{ checkRunId: number }>;
      reread = checks.value.find((check) => check.id === checkRunId);
    }
    const creator = this.credentials.creatorIdentity();
    const observedDigest = /payloadDigest=(sha256:[0-9a-f]{64})/.exec(reread?.output?.summary ?? "")?.[1];
    if (
      !reread ||
      !creator ||
      reread.name !== GATE_CHECK_NAME ||
      reread.head_sha !== payload.exactHead ||
      reread.status !== "completed" ||
      reread.conclusion !== "success" ||
      reread.app?.slug !== creator ||
      observedDigest !== payloadDigest
    ) {
      return deny(ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID, "published gate did not survive GitHub re-read", {
        checkRunId,
        observed: reread
          ? { head: reread.head_sha, status: reread.status, conclusion: reread.conclusion, creator: reread.app?.slug }
          : null,
      });
    }
    const finalized = this.finalizeReservedReceipt({
      idempotencyKey,
      requestDigest: payloadDigest,
      preexisting: false,
      afterStateDigest: payloadDigest,
      response: { checkRunId, payload, payloadDigest },
      reread: true,
    });
    if (!finalized.allowed) return finalized as Decision<{ checkRunId: number }>;

    this.audit.record({
      kind: "PRODUCTION_GATE_PUBLISHED",
      runId: payload.runId,
      evidence: {
        repositoryIdentity,
        exactHead: payload.exactHead,
        payloadDigest,
        checkRunId,
        creatorIdentity: this.credentials.creatorIdentity(),
      },
    });
    return allow(ReasonCode.OK, { checkRunId });
  }

  /**
   * §24.4 — every digest in a gate payload must resolve to evidence this daemon stored,
   * for *this* run's current candidate, produced by the component that owns that evidence
   * kind. Anything else is refused before a check run exists.
   */
  private assertGatePayloadBacked(payload: GatePayload, repositoryIdentity: string): Decision<void> {
    const run = this.runs.get(payload.runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId: payload.runId });

    const participating = this.runs
      .repositoriesOf(payload.runId)
      .some((r) => r.identity === repositoryIdentity);
    if (!participating) {
      return deny(
        ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
        "repository does not participate in this run",
        { runId: payload.runId, repositoryIdentity },
      );
    }

    if (run.ownerBindingGeneration == null || !run.ownerSessionId) {
      return deny(ReasonCode.RUN_OWNER_NOT_PINNED, "run has no pinned owner to gate against", {
        runId: payload.runId,
      });
    }
    if (payload.bindingGeneration !== run.ownerBindingGeneration) {
      return deny(
        ReasonCode.WRITE_BINDING_GENERATION_STALE,
        "gate payload does not carry the run owner's current binding generation",
        { runId: payload.runId, payload: payload.bindingGeneration, current: run.ownerBindingGeneration },
      );
    }

    if (payload.contractDigest !== run.contractDigest) {
      return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "gate payload pins a different contract", {
        runId: payload.runId,
        payload: payload.contractDigest,
        active: run.contractDigest,
      });
    }

    const current = this.runs.currentCandidate(payload.runId);
    if (!current) {
      return deny(ReasonCode.EVIDENCE_MISSING, "run has no frozen candidate to gate", {
        runId: payload.runId,
      });
    }
    if (payload.candidateSnapshotDigest !== current) {
      return deny(ReasonCode.SNAPSHOT_STALE, "gate payload is not the run's current candidate", {
        runId: payload.runId,
        payload: payload.candidateSnapshotDigest,
        current,
      });
    }

    const verification = this.artifacts.byDigest<VerificationReport>(payload.verificationDigest);
    if (
      !verification ||
      verification.runId !== payload.runId ||
      verification.superseded ||
      verification.kind !== "VERIFICATION" ||
      verification.producedBy !== EVIDENCE_PRODUCERS.VERIFICATION ||
      verification.content.candidateSnapshotDigest !== current ||
      verification.content.status !== "PASS"
    ) {
      return deny(
        ReasonCode.GATE_EVIDENCE_NOT_BACKED,
        "gate payload's verification digest does not resolve to a passing report for this candidate",
        {
          runId: payload.runId,
          digest: payload.verificationDigest,
          found: verification
            ? { kind: verification.kind, producedBy: verification.producedBy, status: verification.content.status }
            : null,
        },
      );
    }

    const review = this.artifacts.byDigest<ReviewPacket>(payload.blindReviewDigest);
    if (
      !review ||
      review.runId !== payload.runId ||
      review.superseded ||
      review.kind !== "BLIND_REVIEW" ||
      review.producedBy !== EVIDENCE_PRODUCERS.BLIND_REVIEW ||
      review.content.candidateSnapshotDigest !== current ||
      review.content.verdict !== "PASS"
    ) {
      return deny(
        ReasonCode.GATE_EVIDENCE_NOT_BACKED,
        "gate payload's blind review digest does not resolve to a PASS verdict for this candidate",
        {
          runId: payload.runId,
          digest: payload.blindReviewDigest,
          found: review
            ? { kind: review.kind, producedBy: review.producedBy, verdict: review.content.verdict }
            : null,
        },
      );
    }

    const humanGate = this.assertGatePayloadHumanGateStatus(payload);
    if (!humanGate.allowed) return humanGate;

    const snapshot = this.artifacts.latestForSnapshot<CandidateSnapshot>(
      payload.runId,
      "CANDIDATE_SNAPSHOT",
      current,
    );
    const repository = snapshot?.content.repositories.find((r) => r.identity === repositoryIdentity);
    if (!repository) {
      return deny(
        ReasonCode.GATE_EVIDENCE_NOT_BACKED,
        "no stored candidate snapshot covers this repository",
        { runId: payload.runId, repositoryIdentity, candidate: current },
      );
    }
    if (repository.candidateHead !== payload.exactHead) {
      return deny(ReasonCode.MERGE_HEAD_STALE, "gate payload head is not the candidate head", {
        runId: payload.runId,
        repositoryIdentity,
        payload: payload.exactHead,
        candidate: repository.candidateHead,
      });
    }

    return allow(ReasonCode.OK, undefined);
  }

  // -------------------------------------------------------------------------
  // merge_evaluate
  // -------------------------------------------------------------------------

  /** PRD §24.5 — every predicate, evaluated against live GitHub state. */
  async mergeEvaluate(input: MergeInput): Promise<Decision<{ predicates: Record<string, boolean> }>> {
    const authority = this.assertAuthority(input.runId, input.repositoryIdentity, input);
    if (!authority.allowed) return authority as Decision<{ predicates: Record<string, boolean> }>;

    const profile = this.branchProfile(input.runId);
    if (!profile.allowed) return profile as Decision<{ predicates: Record<string, boolean> }>;
    if (input.mergeStrategy !== profile.value.mergeStrategy) {
      return deny(ReasonCode.MERGE_BRANCH_PROFILE_UNSATISFIED, "caller merge strategy differs from pinned contract", {
        requested: input.mergeStrategy,
        pinned: profile.value.mergeStrategy,
      });
    }
    const candidate = this.candidateRepository(input.runId, input.repositoryIdentity);
    if (!candidate.allowed) return candidate as Decision<{ predicates: Record<string, boolean> }>;
    const candidateSnapshotDigest = this.runs.currentCandidate(input.runId);
    if (
      input.exactHeadSha !== candidate.value.candidateHead ||
      input.expectedBaseSha !== candidate.value.baseHead
    ) {
      return deny(ReasonCode.SNAPSHOT_STALE, "merge input is not bound to the frozen candidate", {
        expectedHead: candidate.value.candidateHead,
        expectedBase: candidate.value.baseHead,
        suppliedHead: input.exactHeadSha,
        suppliedBase: input.expectedBaseSha,
      });
    }

    const slug = this.slug(input.repositoryIdentity);
    if (!slug.allowed) return slug as Decision<{ predicates: Record<string, boolean> }>;
    const { owner, repo } = slug.value;

    const pull = await this.api().request<PullRequest>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${input.pullNumber}`,
    );

    const prepared = this.preparedPrIntent(input.runId, input.repositoryIdentity, pull.number);
    if (!prepared.allowed) return prepared as Decision<{ predicates: Record<string, boolean> }>;
    if (prepared.value.head !== pull.head.ref || prepared.value.base !== pull.base.ref) {
      return deny(ReasonCode.MERGE_BRANCH_PROFILE_UNSATISFIED, "live pull request differs from immutable prepare contract", {
        pullNumber: pull.number,
        prepared: prepared.value,
        observed: { head: pull.head, base: pull.base },
      });
    }

    if (
      prepared.value.exactHeadSha !== input.exactHeadSha ||
      prepared.value.expectedBaseSha !== input.expectedBaseSha ||
      prepared.value.candidateSnapshotDigest !== candidateSnapshotDigest
    ) {
      return deny(ReasonCode.SNAPSHOT_STALE, "prepared pull request is bound to a different frozen candidate", {
        pullNumber: pull.number,
        prepared: {
          exactHeadSha: prepared.value.exactHeadSha,
          expectedBaseSha: prepared.value.expectedBaseSha,
          candidateSnapshotDigest: prepared.value.candidateSnapshotDigest,
        },
        supplied: {
          exactHeadSha: input.exactHeadSha,
          expectedBaseSha: input.expectedBaseSha,
          candidateSnapshotDigest,
        },
      });
    }

    // §24.7 first: a sibling repository that failed post-merge verification blocks this merge
    // whatever the branch state is. Checking freshness ahead of it reported a moved base — a
    // *consequence* of the earlier merge — and hid the reason the run must stop.
    const blocked = this.dependentMergeBlocked(input.runId, input.repositoryIdentity);
    if (!blocked.allowed) return blocked as Decision<{ predicates: Record<string, boolean> }>;

    if (pull.head.sha !== input.exactHeadSha) {
      return deny(ReasonCode.MERGE_HEAD_STALE, "pull request head moved since the candidate froze", {
        expected: input.exactHeadSha,
        observed: pull.head.sha,
      });
    }
    if (pull.base.sha !== input.expectedBaseSha) {
      return deny(ReasonCode.MERGE_BASE_STALE, "base branch moved since the candidate froze", {
        expected: input.expectedBaseSha,
        observed: pull.base.sha,
      });
    }

    // CP-HI-01 / §24.3 — a live claim on the branch being merged, held by this run under
    // the owner's current generation and not expired.
    const claimed = this.assertClaim(input.runId, input.repositoryIdentity, pull.head.ref);
    if (!claimed.allowed) return claimed as Decision<{ predicates: Record<string, boolean> }>;

    const ordered = this.assertMergeOrder(input.runId, input.repositoryIdentity);
    if (!ordered.allowed) return ordered as Decision<{ predicates: Record<string, boolean> }>;

    const releases = await this.activeReleases(input.repositoryIdentity);
    if (!releases.allowed) return releases as Decision<{ predicates: Record<string, boolean> }>;
    const contract = validateBranchContract({
      head: pull.head.ref,
      base: pull.base.ref,
      profile: profile.value,
      declaredParent: prepared.value.declaredParent,
      activeReleases: releases.value,
      sourceBranch: prepared.value.sourceBranch,
    });
    if (!contract.allowed) {
      return deny(ReasonCode.MERGE_BRANCH_PROFILE_UNSATISFIED, contract.message, contract.evidence);
    }
    const gate = await this.verifyGate(input.repositoryIdentity, pull.head.sha, input.runId);
    if (!gate.allowed) return gate as Decision<{ predicates: Record<string, boolean> }>;

    // The gate payload was checked against local evidence when it was published; at merge
    // time that evidence must still be the run's current evidence.
    const stillBacked = this.assertGatePayloadBacked(gate.value, input.repositoryIdentity);
    if (!stillBacked.allowed) return stillBacked as Decision<{ predicates: Record<string, boolean> }>;

    return allow(ReasonCode.OK, {
      predicates: {
        exactHead: true,
        expectedBase: true,
        activeContractDigest: true,
        validResourceClaim: true,
        currentVerification: true,
        blindReviewPass: true,
        humanGateSatisfied: true,
        branchProfileSatisfied: true,
        currentRoleGeneration: true,
        idempotency: true,
      },
    });
  }

  /**
   * §23.2 — a claim is only a claim while it is HELD, unexpired, on the branch in
   * question, and held under the generation the owner currently has.
   */
  private assertClaim(runId: string, repositoryIdentity: string, branch: string): Decision<void> {
    return this.db.tx(() => {
      // The partial unique index treats only HELD rows as occupying a resource. Mark
      // overdue rows before the guard reads them so the decision and the index agree in
      // the same transaction, including the exact expiry boundary.
      const nowIso = this.clock.nowIso();
      this.db.run(
        `UPDATE resource_claims SET status = 'EXPIRED'
          WHERE status = 'HELD' AND expires_at <= ?`,
        [nowIso],
      );
      const rows = this.db.all<{
        claim_id: string;
        branch: string | null;
        status: string;
        expires_at: string;
        owner_binding_generation: number;
      }>(
        `SELECT claim_id, branch, status, expires_at, owner_binding_generation
           FROM resource_claims
          WHERE run_id = ? AND repository_identity = ?`,
        [runId, repositoryIdentity],
      );
      if (rows.length === 0) {
        return deny(ReasonCode.MERGE_CLAIM_INVALID, "no resource claim exists for this repository", {
          runId,
          repositoryIdentity,
        });
      }

      const run = this.runs.get(runId);
      const now = new Date(nowIso).getTime();
      const onBranch = rows.filter((r) => r.branch === branch);
      if (onBranch.length === 0) {
        return deny(ReasonCode.MERGE_CLAIM_INVALID, "no claim covers the branch being merged", {
          runId,
          repositoryIdentity,
          branch,
          claimed: rows.map((r) => r.branch),
        });
      }
      const valid = onBranch.find(
        (r) =>
          r.status === "HELD" &&
          new Date(r.expires_at).getTime() > now &&
          r.owner_binding_generation === run?.ownerBindingGeneration,
      );
      if (!valid) {
        return deny(ReasonCode.MERGE_CLAIM_INVALID, "the claim on this branch is not currently valid", {
          runId,
          repositoryIdentity,
          branch,
          observed: onBranch.map((r) => ({
            status: r.status,
            expiresAt: r.expires_at,
            generation: r.owner_binding_generation,
          })),
          ownerGeneration: run?.ownerBindingGeneration ?? null,
        });
      }
      return allow(ReasonCode.OK, undefined);
    });
  }

  /** §24.7 — repositories merge in declared order; a pending predecessor blocks. */
  private assertMergeOrder(runId: string, repositoryIdentity: string): Decision<void> {
    const repositories = this.runs.repositoriesOf(runId);
    const target = repositories.find((r) => r.identity === repositoryIdentity);
    if (!target) {
      return deny(
        ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
        "repository does not participate in this run",
        { runId, repositoryIdentity },
      );
    }
    const pending = repositories.filter(
      (r) => r.mergeOrder < target.mergeOrder && r.mergeState !== "MERGED" && r.mergeState !== "SKIPPED",
    );
    if (pending.length > 0) {
      return deny(ReasonCode.MERGE_ORDER_VIOLATION, "an earlier repository in this run has not merged", {
        runId,
        repositoryIdentity,
        pending: pending.map((r) => ({ identity: r.identity, state: r.mergeState, order: r.mergeOrder })),
      });
    }
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * CP-S35 — a gate is trusted only if the daemon published it. Name alone proves
   * nothing: the creator identity and the payload digest must both match the local
   * publication record, and the payload's head must be the head being merged.
   */
  private async verifyGate(
    repositoryIdentity: string,
    head: string,
    runId: string,
  ): Promise<Decision<GatePayload>> {
    const checks = await this.listCheckRuns(repositoryIdentity, head, GATE_CHECK_NAME);
    if (!checks.allowed) return checks as Decision<GatePayload>;
    const candidates = checks.value;
    if (candidates.length === 0) {
      return deny(ReasonCode.MERGE_GATE_MISSING, "no production gate on this head", {
        repositoryIdentity,
        head,
      });
    }

    const published = this.db.all<{ response_json: string; after_state_digest: string | null }>(
      `SELECT response_json, after_state_digest FROM github_receipts
        WHERE operation = 'gate_publish' AND repository_identity = ? AND run_id = ?`,
      [repositoryIdentity, runId],
    );
    const knownDigests = new Set(published.map((p) => p.after_state_digest).filter(Boolean));
    const trustedCreator = this.credentials.creatorIdentity();
    if (!trustedCreator) {
      return deny(
        ReasonCode.TRUSTED_CREDENTIAL_UNAVAILABLE,
        "no trusted creator identity is installed, so no gate can be attributed",
        { repositoryIdentity, head },
      );
    }

    for (const check of candidates) {
      const summary = check.output?.summary ?? "";
      const digest = /payloadDigest=(sha256:[0-9a-f]{64})/.exec(summary)?.[1] ?? null;

      // A gate is only an approval when GitHub says it concluded successfully on *this*
      // head. A queued, failed or cancelled check carrying a known digest is not one.
      if (check.head_sha !== head || check.status !== "completed" || check.conclusion !== "success") {
        this.audit.record({
          kind: "GATE_REJECTED",
          runId,
          reasonCode: ReasonCode.MERGE_GATE_MISSING,
          evidence: {
            repositoryIdentity,
            head,
            checkRunId: check.id,
            observedHead: check.head_sha,
            status: check.status,
            conclusion: check.conclusion,
          },
        });
        continue;
      }

      if (!digest || !knownDigests.has(digest)) {
        this.audit.record({
          kind: "GATE_REJECTED",
          runId,
          reasonCode: ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID,
          evidence: {
            repositoryIdentity,
            head,
            checkRunId: check.id,
            observedDigest: digest,
            knownDigests: [...knownDigests],
          },
        });
        continue;
      }
      // Absent creator evidence is not a pass: an unattributable check cannot be shown to
      // be ours, and CP-HI-05 makes provenance the whole basis of trust here.
      if (check.app?.slug !== trustedCreator) {
        this.audit.record({
          kind: "GATE_REJECTED",
          runId,
          reasonCode: ReasonCode.GATE_CREATOR_UNTRUSTED,
          evidence: {
            repositoryIdentity,
            head,
            creator: check.app?.slug ?? null,
            expected: trustedCreator,
          },
        });
        continue;
      }

      const record = published.find((p) => p.after_state_digest === digest);
      const response = record
        ? (JSON.parse(record.response_json) as { payload: GatePayload; checkRunId?: number })
        : null;
      const payload = response?.payload ?? null;
      // The recorded check run id is part of the local record; a *different* check run
      // carrying the same summary text is a replacement, not the gate we published.
      if (!payload || payload.exactHead !== head || response?.checkRunId !== check.id) {
        this.audit.record({
          kind: "GATE_REJECTED",
          runId,
          reasonCode: ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID,
          evidence: {
            repositoryIdentity,
            head,
            payloadHead: payload?.exactHead ?? null,
            observedCheckRunId: check.id,
            recordedCheckRunId: response?.checkRunId ?? null,
          },
        });
        continue;
      }
      return allow(ReasonCode.OK, payload);
    }

    return deny(
      ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID,
      "no production gate on this head was published by the trusted credential",
      { repositoryIdentity, head, observed: candidates.length },
    );
  }

  // -------------------------------------------------------------------------
  // merge_execute
  // -------------------------------------------------------------------------

  async mergeExecute(
    input: MergeInput,
  ): Promise<Decision<{ mergeCommitSha: string; replayed: boolean }>> {
    // Authorise before considering a replay. A receipt is a record of an operation, not
    // a capability that a later caller may present in place of the run owner.
    const authority = this.assertAuthority(input.runId, input.repositoryIdentity, input);
    if (!authority.allowed) return authority as Decision<{ mergeCommitSha: string; replayed: boolean }>;

    // Resolve this before any write. Once GitHub may have merged, a missing local run
    // repository row must not turn a proof failure into a silently untracked merge.
    const repositoryId = this.mergeRepositoryId(input.runId, input.repositoryIdentity);
    if (!repositoryId.allowed) return repositoryId as Decision<{ mergeCommitSha: string; replayed: boolean }>;
    const mergeRepositoryId = repositoryId.value;

    const idempotencyKey = `merge_execute:${input.repositoryIdentity}:${input.pullNumber}`;
    const requestDigest = digestOf({
      runId: input.runId,
      repositoryIdentity: input.repositoryIdentity,
      pullNumber: input.pullNumber,
      exactHeadSha: input.exactHeadSha,
      expectedBaseSha: input.expectedBaseSha,
      mergeStrategy: input.mergeStrategy,
      ownerBindingGeneration: input.ownerBindingGeneration,
    });
    const existing = this.receipt(idempotencyKey);
    if (existing) {
      if (existing.request_digest !== requestDigest) {
        return deny(ReasonCode.RESOURCE_COLLISION, "merge resource is already bound to different operation intent", {
          idempotencyKey,
          existingRequestDigest: existing.request_digest,
          requestDigest,
        });
      }
      if (!existing.verified) {
        if (this.inFlightReservations.has(idempotencyKey)) {
          return deny(ReasonCode.RESOURCE_COLLISION, "merge operation is in flight", { idempotencyKey });
        }
        const slug = this.slug(input.repositoryIdentity);
        if (!slug.allowed) return slug as Decision<{ mergeCommitSha: string; replayed: boolean }>;
        let pull: PullRequest;
        try {
          const observed = await this.api().request<unknown>(
            "GET",
            `/repos/${slug.value.owner}/${slug.value.repo}/pulls/${input.pullNumber}`,
          );
          if (!observed || typeof observed !== "object") throw new Error("reconciliation pull returned no value");
          pull = observed as PullRequest;
        } catch {
          const unavailable = deny(ReasonCode.PROBE_FAILED, "pending merge pull could not be re-read", {
            pullNumber: input.pullNumber,
            phase: "reconcile-pull",
          });
          this.recordPendingMergeProofFailure(input, mergeRepositoryId, idempotencyKey, null, unavailable);
          return unavailable as Decision<{ mergeCommitSha: string; replayed: boolean }>;
        }
        const observedMerged = (pull as unknown as { merged?: unknown }).merged;
        if (observedMerged === false) {
          // The pull is still open, so the reserved PUT did not merge it and may be
          // retried after reclaiming the stale crash-era reservation.
          this.releaseReservation(idempotencyKey, requestDigest);
          return this.mergeExecute(input);
        } else if (typeof observedMerged !== "boolean") {
          const unavailable = deny(ReasonCode.EVIDENCE_MISSING, "pending merge pull has no usable merged state", {
            pullNumber: input.pullNumber,
            phase: "reconcile-pull",
          });
          const observedMergeCommitSha =
            typeof pull.merge_commit_sha === "string" && pull.merge_commit_sha.trim() !== ""
              ? pull.merge_commit_sha
              : null;
          this.recordPendingMergeProofFailure(
            input,
            mergeRepositoryId,
            idempotencyKey,
            observedMergeCommitSha,
            unavailable,
          );
          return unavailable as Decision<{ mergeCommitSha: string; replayed: boolean }>;
        }
        const observedMergeCommitSha =
          typeof pull.merge_commit_sha === "string" && pull.merge_commit_sha.trim() !== ""
            ? pull.merge_commit_sha
            : null;
        if (!observedMergeCommitSha) {
          const unavailable = deny(ReasonCode.EVIDENCE_MISSING, "pending merge pull has no usable merge commit sha", {
            pullNumber: input.pullNumber,
            phase: "reconcile-pull",
          });
          this.recordPendingMergeProofFailure(input, mergeRepositoryId, idempotencyKey, null, unavailable);
          return unavailable as Decision<{ mergeCommitSha: string; replayed: boolean }>;
        }
        const observedHead = (pull as unknown as { head?: { sha?: unknown } }).head?.sha;
        const observedHeadSha =
          typeof observedHead === "string" && observedHead.trim() !== "" ? observedHead : null;
        if (!observedHeadSha) {
          const unavailable = deny(ReasonCode.EVIDENCE_MISSING, "pending merge pull has no usable head sha", {
            pullNumber: input.pullNumber,
            phase: "reconcile-pull",
          });
          this.recordPendingMergeProofFailure(
            input,
            mergeRepositoryId,
            idempotencyKey,
            observedMergeCommitSha,
            unavailable,
          );
          return unavailable as Decision<{ mergeCommitSha: string; replayed: boolean }>;
        }
        if (observedHeadSha !== input.exactHeadSha) {
          const stale = deny(ReasonCode.MERGE_HEAD_STALE, "pending merge pull no longer names the reserved head", {
            pullNumber: input.pullNumber,
            phase: "reconcile-pull",
            expected: input.exactHeadSha,
            observed: observedHeadSha,
          });
          this.recordPendingMergeProofFailure(
            input,
            mergeRepositoryId,
            idempotencyKey,
            observedMergeCommitSha,
            stale,
          );
          return stale as Decision<{ mergeCommitSha: string; replayed: boolean }>;
        }
        const prepared = this.preparedPrIntent(input.runId, input.repositoryIdentity, input.pullNumber);
        if (!prepared.allowed) {
          if (this.keepsMergeProofPending(prepared.reasonCode)) {
            this.recordPendingMergeProofFailure(
              input,
              mergeRepositoryId,
              idempotencyKey,
              observedMergeCommitSha,
              prepared,
            );
          } else {
            this.recordMergeProofFailure(input, mergeRepositoryId, idempotencyKey, observedMergeCommitSha, prepared);
          }
          return prepared as Decision<{ mergeCommitSha: string; replayed: boolean }>;
        }
        const proof = await this.assertExecutedMergeProof(
          slug.value.owner,
          slug.value.repo,
          pull,
          prepared.value,
          observedMergeCommitSha,
          input.expectedBaseSha,
          this.githubMergeMethod(input.mergeStrategy),
        );
        if (!proof.allowed) {
          if (this.keepsMergeProofPending(proof.reasonCode)) {
            this.recordPendingMergeProofFailure(
              input,
              mergeRepositoryId,
              idempotencyKey,
              observedMergeCommitSha,
              proof,
            );
          } else {
            this.recordMergeProofFailure(input, mergeRepositoryId, idempotencyKey, observedMergeCommitSha, proof);
          }
          return proof as Decision<{ mergeCommitSha: string; replayed: boolean }>;
        }
        const finalized = this.finalizeReservedReceipt({
          idempotencyKey,
          requestDigest,
          preexisting: false,
          afterStateDigest: sha256(observedMergeCommitSha),
          response: {
            mergeCommitSha: observedMergeCommitSha,
            sourceBranch: prepared.value.head,
            targetBranch: prepared.value.base,
            expectedBaseSha: input.expectedBaseSha,
            baseVerification: {
              preflight: "prepared-base-ref-and-sha",
              postflight: "prepared-base-ref-points-at-merge-commit",
              residualRace: "base-may-move-between-preflight-and-merge",
              proof: "merge-commit-first-parent",
            },
          },
          reread: true,
        });
        if (!finalized.allowed) return finalized as Decision<{ mergeCommitSha: string; replayed: boolean }>;
        this.runs.setRepositoryMergeState(input.runId, mergeRepositoryId, "PENDING");
        return allow(ReasonCode.MERGE_IDEMPOTENT_REPLAY, {
          mergeCommitSha: observedMergeCommitSha,
          replayed: true,
        });
      }
      const slug = this.slug(input.repositoryIdentity);
      if (!slug.allowed) return slug as Decision<{ mergeCommitSha: string; replayed: boolean }>;
      const reread = await this.api().request<PullRequest>(
        "GET",
        `/repos/${slug.value.owner}/${slug.value.repo}/pulls/${input.pullNumber}`,
      );
      if (!reread.merged || reread.head.sha !== input.exactHeadSha) {
        return deny(ReasonCode.RESOURCE_COLLISION, "cached merge receipt no longer matches GitHub state", {
          idempotencyKey,
          observed: { merged: reread.merged, head: reread.head.sha },
        });
      }
      const cached = JSON.parse(existing.response_json) as { mergeCommitSha: string };
      this.audit.record({
        kind: "MERGE_REPLAY",
        runId: input.runId,
        reasonCode: ReasonCode.MERGE_IDEMPOTENT_REPLAY,
        evidence: { idempotencyKey, mergeCommitSha: cached.mergeCommitSha },
      });
      return allow(ReasonCode.MERGE_IDEMPOTENT_REPLAY, { ...cached, replayed: true });
    }

    const finalization = this.assertFreshDaemonFinalization(
      input.runId,
      input.daemonFinalizerAuthority,
      "merge_execute",
    );
    if (!finalization.allowed) return finalization as Decision<{ mergeCommitSha: string; replayed: boolean }>;

    const evaluation = await this.mergeEvaluate(input);
    if (!evaluation.allowed) return evaluation as Decision<{ mergeCommitSha: string; replayed: boolean }>;

    const slug = this.slug(input.repositoryIdentity);
    if (!slug.allowed) return slug as Decision<{ mergeCommitSha: string; replayed: boolean }>;
    const { owner, repo } = slug.value;

    if (input.mergeStrategy === "fast_forward") {
      return deny(
        ReasonCode.MERGE_BRANCH_PROFILE_UNSATISFIED,
        "GitHub's pull-request merge API cannot perform a true fast-forward",
        { mergeStrategy: input.mergeStrategy },
      );
    }
    const method = this.githubMergeMethod(input.mergeStrategy);

    const prepared = this.preparedPrIntent(input.runId, input.repositoryIdentity, input.pullNumber);
    if (!prepared.allowed) return prepared as Decision<{ mergeCommitSha: string; replayed: boolean }>;

    // §24.6 — GitHub's merge API accepts an expected *head* but no expected base, so the
    // base is checked as late as possible before the call and proved after it. SHA equality
    // alone is insufficient: another ref can temporarily name the same commit.
    const preflight = await this.api().request<PullRequest>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${input.pullNumber}`,
    );
    if (preflight.head.sha !== input.exactHeadSha) {
      return deny(ReasonCode.MERGE_HEAD_STALE, "head moved between evaluation and execution", {
        expected: input.exactHeadSha,
        observed: preflight.head.sha,
      });
    }
    const preflightBase = this.assertPreparedBaseRef(preflight, prepared.value, "before-put");
    if (!preflightBase.allowed) return preflightBase as Decision<{ mergeCommitSha: string; replayed: boolean }>;
    if (preflight.base.sha !== input.expectedBaseSha) {
      return deny(ReasonCode.MERGE_BASE_STALE, "base moved between evaluation and execution", {
        expected: input.expectedBaseSha,
        observed: preflight.base.sha,
      });
    }

    const target = this.writeTarget(input.runId, input.repositoryIdentity, preflight.head.ref);
    if (!target.allowed) return target as Decision<{ mergeCommitSha: string; replayed: boolean }>;

    const reserved = this.reserveReceipt({
      idempotencyKey,
      operation: "merge_execute",
      runId: input.runId,
      repositoryIdentity: input.repositoryIdentity,
      resourceType: "merge",
      resourceIdentity: `${owner}/${repo}#${input.pullNumber}`,
      beforeStateDigest: digestOf({ head: input.exactHeadSha, base: input.expectedBaseSha }),
      requestDigest,
    });
    if (!reserved.allowed) return reserved as Decision<{ mergeCommitSha: string; replayed: boolean }>;

    // GitHub fences the irreversible write on the exact head. Its REST API has no base
    // predicate, so the late base reread and first-parent proof below make that residual
    // race explicit rather than treating the preflight as an atomic guarantee.
    const merged = await this.mediate(
      WriteOperation.PROGRAMMATIC_MERGE,
      input.runId,
      input.repositoryIdentity,
      target.value,
      input,
      () => this.api().request<{ sha: string; merged: boolean }>(
        "PUT",
        `/repos/${owner}/${repo}/pulls/${input.pullNumber}/merge`,
        { sha: input.exactHeadSha, merge_method: method },
      ),
    );
    if (!merged.allowed) {
      if (merged.evidence["effectInvoked"] !== true) {
        this.releaseReservation(idempotencyKey, requestDigest);
      } else {
        // The fenced effect ran but did not yield a proveable acknowledgement. Preserve the
        // PENDING row for recovery while making the run fail closed now.
        this.markMergeUnproven(input, mergeRepositoryId, idempotencyKey);
      }
      return merged as Decision<{ mergeCommitSha: string; replayed: boolean }>;
    }
    const mergeResponse = merged.value as unknown;
    if (
      !mergeResponse ||
      typeof mergeResponse !== "object" ||
      !("merged" in mergeResponse) ||
      typeof mergeResponse.merged !== "boolean"
    ) {
      // A blank acknowledgement can follow an applied PUT, so retain the receipt until a
      // reconciliation can establish whether the merge occurred. It is nevertheless an
      // executed-but-unproven merge for this run until that proof succeeds.
      this.markMergeUnproven(input, mergeRepositoryId, idempotencyKey);
      return deny(ReasonCode.EVIDENCE_MISSING, "GitHub returned no usable merge acknowledgement", {
        pullNumber: input.pullNumber,
      });
    }
    if (!mergeResponse.merged) {
      // GitHub explicitly reports no mutation, so this is not an ambiguous outcome and
      // the pre-write reservation may be released for a corrected retry.
      this.releaseReservation(idempotencyKey, requestDigest);
      this.audit.record({
        kind: "MERGE_REFUSED",
        runId: input.runId,
        reasonCode: ReasonCode.MERGE_HEAD_STALE,
        evidence: {
          repositoryIdentity: input.repositoryIdentity,
          pullNumber: input.pullNumber,
          exactHead: input.exactHeadSha,
        },
      });
      return deny(ReasonCode.MERGE_HEAD_STALE, "GitHub refused the merge", {
        pullNumber: input.pullNumber,
      });
    }
    if (!("sha" in mergeResponse) || typeof mergeResponse.sha !== "string" || !mergeResponse.sha) {
      this.markMergeUnproven(input, mergeRepositoryId, idempotencyKey);
      return deny(ReasonCode.EVIDENCE_MISSING, "GitHub reported a merge with no commit sha", {
        pullNumber: input.pullNumber,
      });
    }
    const mergeCommitSha = mergeResponse.sha;

    this.audit.record({
      kind: "MERGE_EXECUTED",
      runId: input.runId,
      evidence: {
        repositoryIdentity: input.repositoryIdentity,
        pullNumber: input.pullNumber,
        exactHead: input.exactHeadSha,
        mergeCommitSha,
        method,
      },
    });

    // A merge acknowledgement names a commit but does not prove the mutable PR target
    // still names the branch prepared by this run, nor that branch's current ref points to
    // that commit. Re-read both before accepting the irreversible write.
    let postflight: PullRequest;
    try {
      postflight = await this.api().request<PullRequest>(
        "GET",
        `/repos/${owner}/${repo}/pulls/${input.pullNumber}`,
      );
      if (!postflight) throw new Error("postflight pull read returned no value");
    } catch {
      const unproven = deny(
        ReasonCode.PROBE_FAILED,
        "merged pull request could not be re-read for base proof",
        {
          pullNumber: input.pullNumber,
          mergeCommitSha,
          phase: "postflight-pull",
        },
      );
      this.recordPendingMergeProofFailure(input, mergeRepositoryId, idempotencyKey, mergeCommitSha, unproven);
      return unproven as Decision<{ mergeCommitSha: string; replayed: boolean }>;
    }
    const proof = await this.assertExecutedMergeProof(
      owner,
      repo,
      postflight,
      prepared.value,
      mergeCommitSha,
      input.expectedBaseSha,
      method,
    );
    if (!proof.allowed) {
      if (this.keepsMergeProofPending(proof.reasonCode)) {
        this.recordPendingMergeProofFailure(input, mergeRepositoryId, idempotencyKey, mergeCommitSha, proof);
      } else {
        this.recordMergeProofFailure(input, mergeRepositoryId, idempotencyKey, mergeCommitSha, proof);
      }
      return proof as Decision<{ mergeCommitSha: string; replayed: boolean }>;
    }

    const finalized = this.finalizeReservedReceipt({
      idempotencyKey,
      requestDigest,
      preexisting: false,
      afterStateDigest: sha256(mergeCommitSha),
      response: {
        mergeCommitSha,
        sourceBranch: preflight.head.ref,
        targetBranch: preflight.base.ref,
        expectedBaseSha: input.expectedBaseSha,
        baseVerification: {
          preflight: "prepared-base-ref-and-sha",
          postflight: "prepared-base-ref-points-at-merge-commit",
          residualRace: "base-may-move-between-preflight-and-merge",
          proof: "merge-commit-first-parent",
        },
      },
      reread: true,
    });
    if (!finalized.allowed) return finalized as Decision<{ mergeCommitSha: string; replayed: boolean }>;

    // API success is only a pending merge: dependents remain blocked until the exact
    // merge commit has passed the pinned post-merge checks.
    this.runs.setRepositoryMergeState(input.runId, mergeRepositoryId, "PENDING");
    return allow(ReasonCode.OK, { mergeCommitSha, replayed: false });
  }

  /** Translate the pinned contract vocabulary to GitHub's REST API vocabulary. */
  private githubMergeMethod(strategy: BranchProfile["mergeStrategy"]): "merge" | "squash" | "rebase" {
    if (strategy === "squash") return "squash";
    // `rebase` is intentionally checked at runtime as well as in the manifest schema so a
    // newly admitted pinned contract cannot silently degrade into GitHub's merge method.
    if ((strategy as string) === "rebase") return "rebase";
    return "merge";
  }

  /** The prepare receipt binds a branch name, not merely the commit it happened to name. */
  private assertPreparedBaseRef(
    pull: PullRequest,
    prepared: PreparedPrIntent,
    phase: "before-put" | "after-put",
  ): Decision<void> {
    const observedBase = (pull as unknown as { base?: { ref?: unknown } }).base?.ref;
    const observedBaseRef =
      typeof observedBase === "string" && observedBase.trim() !== "" ? observedBase : null;
    if (!observedBaseRef) {
      return deny(ReasonCode.EVIDENCE_MISSING, "pull request has no usable base ref", {
        pullNumber: pull.number,
        phase,
      });
    }
    if (observedBaseRef === prepared.base) return allow(ReasonCode.OK, undefined);
    return deny(
      phase === "before-put" ? ReasonCode.MERGE_BRANCH_PROFILE_UNSATISFIED : ReasonCode.MERGE_BASE_STALE,
      "pull request base ref differs from the immutable prepare contract",
      {
        pullNumber: pull.number,
        phase,
        expected: prepared.base,
        observed: observedBaseRef,
      },
    );
  }

  /**
   * GitHub's PUT acknowledgement is only a claim. A merged pull retains its *original*
   * `base.sha` in GitHub's API, so it cannot prove the mutable target ref advanced. Re-read
   * that ref itself, while retaining the pull's immutable base snapshot and first-parent
   * lineage checks. This makes a concurrent target advance a safe refusal, not a false pass.
   */
  private async assertExecutedMergeProof(
    owner: string,
    repo: string,
    pull: PullRequest,
    prepared: PreparedPrIntent,
    mergeCommitSha: string,
    expectedBaseSha: string,
    method: "merge" | "squash" | "rebase",
  ): Promise<Decision<void>> {
    const preparedBase = this.assertPreparedBaseRef(pull, prepared, "after-put");
    if (!preparedBase.allowed) return preparedBase;
    const observedMerged = (pull as unknown as { merged?: unknown }).merged;
    if (typeof observedMerged !== "boolean") {
      return deny(ReasonCode.EVIDENCE_MISSING, "merged pull has no usable merged state", {
        pullNumber: pull.number,
        baseRef: pull.base.ref,
        phase: "postflight-pull",
      });
    }
    if (!observedMerged) {
      return deny(ReasonCode.MERGE_BASE_STALE, "pull no longer reports the acknowledged merge", {
        pullNumber: pull.number,
        baseRef: pull.base.ref,
        expected: true,
        observed: observedMerged,
      });
    }
    const observedMergeCommitSha =
      typeof pull.merge_commit_sha === "string" && pull.merge_commit_sha.trim() !== ""
        ? pull.merge_commit_sha
        : null;
    if (!observedMergeCommitSha) {
      return deny(ReasonCode.EVIDENCE_MISSING, "merged pull has no usable merge commit sha", {
        pullNumber: pull.number,
        baseRef: pull.base.ref,
        phase: "postflight-pull",
      });
    }
    if (observedMergeCommitSha !== mergeCommitSha) {
      return deny(ReasonCode.MERGE_BASE_STALE, "merged pull does not name the acknowledged merge commit", {
        pullNumber: pull.number,
        baseRef: pull.base.ref,
        expected: mergeCommitSha,
        observed: observedMergeCommitSha,
      });
    }
    const observedBase = (pull as unknown as { base?: { sha?: unknown } }).base?.sha;
    const observedBaseSha =
      typeof observedBase === "string" && observedBase.trim() !== "" ? observedBase : null;
    if (!observedBaseSha) {
      return deny(ReasonCode.EVIDENCE_MISSING, "merged pull has no usable base snapshot sha", {
        pullNumber: pull.number,
        baseRef: pull.base.ref,
        phase: "postflight-pull",
      });
    }
    if (observedBaseSha !== expectedBaseSha) {
      return deny(ReasonCode.MERGE_BASE_STALE, "merged pull no longer carries the prepared base snapshot", {
        pullNumber: pull.number,
        baseRef: pull.base.ref,
        expected: expectedBaseSha,
        observed: observedBaseSha,
      });
    }
    let targetHead: string | null = null;
    try {
      const target = await this.api().request<{ object?: { sha?: string } }>(
        "GET",
        `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(pull.base.ref)}`,
      );
      if (!target) {
        return deny(ReasonCode.PROBE_FAILED, "merged target ref returned no value", {
          pullNumber: pull.number,
          baseRef: pull.base.ref,
          phase: "postflight-target-ref",
          observed: null,
        });
      }
      targetHead =
        typeof target.object?.sha === "string" && target.object.sha.trim() !== ""
          ? target.object.sha
          : null;
      if (!targetHead) {
        return deny(ReasonCode.EVIDENCE_MISSING, "merged target ref has no usable commit sha", {
          pullNumber: pull.number,
          baseRef: pull.base.ref,
          phase: "postflight-target-ref",
        });
      }
    } catch {
      return deny(ReasonCode.PROBE_FAILED, "merged target ref could not be re-read", {
        pullNumber: pull.number,
        baseRef: pull.base.ref,
        phase: "postflight-target-ref",
      });
    }
    if (targetHead !== mergeCommitSha) {
      return deny(ReasonCode.MERGE_BASE_STALE, "prepared target ref does not point at the merge commit", {
        pullNumber: pull.number,
        baseRef: pull.base.ref,
        expected: mergeCommitSha,
        observed: targetHead,
      });
    }
    return this.assertMergedOntoBase(owner, repo, mergeCommitSha, expectedBaseSha, method);
  }

  /**
   * §24.6 — the merge commit's first-parent chain must reach the base the run evaluated.
   * For a merge or squash the first parent *is* the base tip; a rebase produces a chain of
   * rebased commits ending at it, so the chain is walked.
   */
  private async assertMergedOntoBase(
    owner: string,
    repo: string,
    mergeCommitSha: string,
    expectedBaseSha: string,
    method: "merge" | "squash" | "rebase",
  ): Promise<Decision<void>> {
    const walked: string[] = [];
    let sha = mergeCommitSha;
    let observedFirstParent: string | null = null;
    for (let hop = 0; hop < 64; hop += 1) {
      const commit = await this.api()
        .request<unknown>(
          "GET",
          `/repos/${owner}/${repo}/commits/${sha}`,
        )
        .catch(() => null);
      if (!commit) {
        return deny(ReasonCode.PROBE_FAILED, "merge commit could not be re-read", {
          mergeCommitSha,
          at: sha,
          phase: "postflight-first-parent",
        });
      }
      const parents = typeof commit === "object" ? (commit as { parents?: unknown }).parents : undefined;
      const candidate = Array.isArray(parents) ? parents[0] : undefined;
      const first =
        candidate &&
        typeof candidate === "object" &&
        typeof (candidate as { sha?: unknown }).sha === "string" &&
        (candidate as { sha: string }).sha.trim() !== ""
          ? (candidate as { sha: string }).sha
          : null;
      if (!first) {
        return deny(ReasonCode.EVIDENCE_MISSING, "merge commit has no usable first-parent sha", {
          mergeCommitSha,
          at: sha,
          phase: "postflight-first-parent",
        });
      }
      if (hop === 0) observedFirstParent = first;
      walked.push(sha);
      if (first === expectedBaseSha) return allow(ReasonCode.OK, undefined);
      if (method !== "rebase") break;
      sha = first;
    }
    return deny(
      ReasonCode.MERGE_BASE_STALE,
      "the merge did not land on the base the run's evidence was bound to",
      { mergeCommitSha, expected: expectedBaseSha, observed: observedFirstParent, walked },
    );
  }

  // -------------------------------------------------------------------------
  // post_merge_verify
  // -------------------------------------------------------------------------

  /** §24.7 — merge API success is not completion. */
  async postMergeVerify(
    runId: string,
    repositoryIdentity: string,
    mergeCommitSha: string,
    requiredChecks: readonly string[] = [],
    daemonFinalizerAuthority?: DaemonFinalizerAuthority,
  ): Promise<Decision<{ checks: Array<{ name: string; conclusion: string }> }>> {
    const slug = this.slug(repositoryIdentity);
    if (!slug.allowed) return slug as Decision<{ checks: Array<{ name: string; conclusion: string }> }>;
    const { owner, repo } = slug.value;

    // The required set comes from the project contract, not the caller: a caller-supplied
    // empty list would make this a vacuous PASS for any commit (§24.7).
    const declared = this.declaredPostMergeChecks(runId, repositoryIdentity);
    const undeclared = requiredChecks.filter((name) => !declared.includes(name));
    if (undeclared.length > 0) {
      return deny(
        ReasonCode.POST_MERGE_CHECKS_NOT_DECLARED,
        "post-merge checks must be declared by the pinned project manifest",
        { runId, undeclared, declared },
      );
    }
    // Every declared check is required. A caller-supplied subset would be silent coverage
    // reduction: naming one of two declared checks must not make the other optional.
    const effective = [...new Set([...declared, ...requiredChecks])];
    if (effective.length === 0) {
      return deny(
        ReasonCode.POST_MERGE_CHECKS_NOT_DECLARED,
        "the pinned manifest declares no post-merge checks, so a merge cannot be verified",
        { runId, repositoryIdentity, mergeCommitSha },
      );
    }

    // §24.7 — the commit under verification must be the one this run actually merged into
    // this repository. Otherwise an unrelated green commit could stand in for a red merge.
    const mergedHere = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM github_receipts
        WHERE operation = 'merge_execute' AND run_id = ? AND repository_identity = ?
          AND after_state_digest = ?`,
      [runId, repositoryIdentity, sha256(mergeCommitSha)],
    );
    if ((mergedHere?.n ?? 0) === 0) {
      return deny(
        ReasonCode.EVIDENCE_MISSING,
        "no merge this run performed on this repository produced that commit",
        { runId, repositoryIdentity, mergeCommitSha },
      );
    }

    const idempotencyKey = `post_merge_verify:${repositoryIdentity}:${mergeCommitSha}`;
    const requestDigest = digestOf({ mergeCommitSha, requiredChecks: effective });
    const existing = this.receipt(idempotencyKey);
    if (existing) {
      if (existing.request_digest !== requestDigest || existing.verified !== 1) {
        return deny(ReasonCode.RESOURCE_COLLISION, "post-merge verification receipt cannot be replayed", {
          idempotencyKey,
          verified: existing.verified === 1,
        });
      }
      const cached = JSON.parse(existing.response_json) as { checks?: Array<{ name: string; conclusion: string }> };
      if (!Array.isArray(cached.checks)) {
        return deny(ReasonCode.EVIDENCE_MISSING, "post-merge verification receipt is malformed", {
          idempotencyKey,
        });
      }
      const failed = cached.checks.filter((check) => check.conclusion !== "success");
      if (failed.length > 0) {
        this.setMergeState(runId, repositoryIdentity, "FAILED");
        return deny(
          ReasonCode.POST_MERGE_VERIFICATION_FAILED,
          "recorded post-merge verification failed; dependent merges remain blocked",
          { mergeCommitSha, failed, replayed: true },
        );
      }
      this.setMergeState(runId, repositoryIdentity, "MERGED");
      return allow(ReasonCode.OK, { checks: cached.checks });
    }

    const finalization = this.assertFreshDaemonFinalization(
      runId,
      daemonFinalizerAuthority,
      "post_merge_verify",
    );
    if (!finalization.allowed) return finalization as Decision<{ checks: Array<{ name: string; conclusion: string }> }>;

    const observedResult = await this.waitForPostMergeChecks(
      runId,
      repositoryIdentity,
      mergeCommitSha,
      effective,
    );
    if (!observedResult.allowed) {
      return observedResult as Decision<{ checks: Array<{ name: string; conclusion: string }> }>;
    }
    const observed = observedResult.value;
    const failed = observed.filter((c) => c.conclusion !== "success");

    this.writeReceipt({
      idempotencyKey,
      operation: "post_merge_verify",
      runId,
      repositoryIdentity,
      resourceType: "commit",
      resourceIdentity: `${owner}/${repo}@${mergeCommitSha}`,
      preexisting: false,
      beforeStateDigest: null,
      afterStateDigest: digestOf(observed),
      requestDigest,
      response: { checks: observed },
      reread: true,
    });

    if (failed.length > 0) {
      this.setMergeState(runId, repositoryIdentity, "FAILED");
      this.audit.record({
        kind: "POST_MERGE_FAILED",
        runId,
        reasonCode: ReasonCode.POST_MERGE_VERIFICATION_FAILED,
        evidence: { repositoryIdentity, mergeCommitSha, failed },
      });
      return deny(
        ReasonCode.POST_MERGE_VERIFICATION_FAILED,
        "post-merge verification failed; dependent merges are blocked",
        { mergeCommitSha, failed },
      );
    }
    this.setMergeState(runId, repositoryIdentity, "MERGED");
    return allow(ReasonCode.OK, { checks: observed });
  }

  /**
   * GitHub Actions normally begins after the merge API returns. Keep the finalizer in this
   * exact-SHA proof step until a bounded observation sees a terminal answer. Only absence
   * and incompleteness are transient; all other failures are immediate and load-bearing.
   */
  private async waitForPostMergeChecks(
    runId: string,
    repositoryIdentity: string,
    mergeCommitSha: string,
    effective: readonly string[],
  ): Promise<Decision<ObservedPostMergeCheck[]>> {
    let observed: ObservedPostMergeCheck[] = [];
    for (let attempt = 1; attempt <= this.postMergePollAttempts; attempt += 1) {
      const inspected = await this.observePostMergeChecks(
        runId,
        repositoryIdentity,
        mergeCommitSha,
        effective,
      );
      if (!inspected.allowed) return inspected;
      observed = inspected.value;
      const failed = observed.filter((check) => check.conclusion !== "success");
      const transientOnly = failed.length > 0 && failed.every((check) =>
        check.conclusion === "missing" || check.conclusion.startsWith("incomplete:"),
      );
      if (!transientOnly || attempt === this.postMergePollAttempts) return allow(ReasonCode.OK, observed);
      await this.sleep(this.postMergePollIntervalMs);
    }
    return allow(ReasonCode.OK, observed);
  }

  /** Read one exact-SHA observation without accepting a name-only or unverifiable check. */
  private async observePostMergeChecks(
    runId: string,
    repositoryIdentity: string,
    mergeCommitSha: string,
    effective: readonly string[],
  ): Promise<Decision<ObservedPostMergeCheck[]>> {
    // Filter by the declared name server-side, then paginate. An unrelated check flood must
    // not hide the one trusted check we are required to assess, while same-name duplicates
    // remain an explicit ambiguous refusal below.
    const checksByName = new Map<string, CheckRun[]>();
    for (const name of effective) {
      const listed = await this.listCheckRuns(repositoryIdentity, mergeCommitSha, name);
      if (!listed.allowed) return listed as Decision<ObservedPostMergeCheck[]>;
      checksByName.set(name, listed.value);
    }
    return allow(ReasonCode.OK, await Promise.all(effective.map(async (name) => {
      const matching = checksByName.get(name)!.filter((check) => check.name === name);
      if (matching.length === 0) return { name, conclusion: "missing" };
      // Same-name checks are ambiguous provenance. Selecting whichever one happens to
      // appear first would let a candidate workflow hide beside the required workflow.
      if (matching.length !== 1) return { name, conclusion: "ambiguous" };
      const check = matching[0]!;
      if (check.status !== "completed") return { name, conclusion: `incomplete:${check.status}` };
      if (check.conclusion !== "success") return { name, conclusion: check.conclusion ?? "missing" };
      const trusted = await this.assertTrustedWorkflowCheck(runId, repositoryIdentity, mergeCommitSha, check);
      return { name, conclusion: trusted.allowed ? "success" : "untrusted" };
    })));
  }

  /**
   * The post-merge checks the run's pinned manifest declares for one repository (§24.7).
   *
   * Scoped to the repository rather than the run (#512). A workflow entry names the repository
   * it lives in, and its `approvedDigest` is later compared against the file read from that
   * repository — so returning every entry for every participant required each one to carry a
   * byte-identical workflow file. `postMergeCommands` carry no role and stay run-wide.
   */
  private declaredPostMergeChecks(runId: string, repositoryIdentity: string): string[] {
    const run = this.runs.get(runId);
    const manifest = run?.pinnedManifestDigest ? this.projects.manifest(run.pinnedManifestDigest) : null;
    const role = this.repositoryRoleInRun(runId, repositoryIdentity);
    const fromWorkflows = (manifest?.ciWorkflows ?? [])
      .filter((w) => w.repositoryRole === role)
      .map((w) => w.checkName);
    const fromCommands = manifest?.postMergeCommands ?? [];
    return [...new Set([...fromWorkflows, ...fromCommands])];
  }

  /**
   * The role this repository holds in this run, or null when it holds none.
   *
   * Read from `run_repositories` rather than `repositories`: the role is a property of the
   * repository's participation in a run, and a repository absent from the run must resolve to
   * nothing rather than to whatever role it happened to be registered with elsewhere.
   */
  private repositoryRoleInRun(runId: string, repositoryIdentity: string): string | null {
    const row = this.db.get<{ repository_role: string }>(
      `SELECT rr.repository_role FROM run_repositories rr
         JOIN repositories r ON r.repository_id = rr.repository_id
        WHERE rr.run_id = ? AND r.identity = ?`,
      [runId, repositoryIdentity],
    );
    return row?.repository_role ?? null;
  }

  /**
   * §24.7 — a repository blocks its dependents until its own post-merge verification has
   * answered, and blocks them permanently if the answer was a failure.
   *
   * The pending half was added deliberately (#512). Before it, a merged-but-unverified
   * repository returned `allowed`, which folded "the answer is not known yet" into "the answer
   * was fine" — the CP-HI-08 shape, and the same fold as a read failure reported as a stale
   * base or a delivery timeout recorded as a non-delivery.
   *
   * The cost of that fold is unusually high here. Releasing a dependent while the first
   * repository is still verifying means two irreversible external writes have happened before
   * anything checked the first, and learning the answer afterwards is too late.
   *
   * Correct sequencing already exists in the finalizer, which awaits each `postMergeVerify`
   * before the next merge. That is one caller's property, not the kernel's: anything else
   * reaching `mergeExecute` — a capture script, a future concurrent finalizer — got no
   * protection at all. This makes the guard a real second layer rather than a name.
   *
   * `merge_state` is the discriminator because only `postMergeVerify` ever writes it: MERGED
   * means verified, FAILED means it answered badly, and PENDING with a merge receipt present
   * means the merge happened and nothing has answered yet.
   */
  dependentMergeBlocked(runId: string, repositoryIdentity: string): Decision<void> {
    const failed = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events
        WHERE run_id = ? AND kind = 'POST_MERGE_FAILED'`,
      [runId],
    );
    if ((failed?.n ?? 0) > 0) {
      return deny(
        ReasonCode.DEPENDENT_MERGE_BLOCKED,
        "an earlier repository in this run failed post-merge verification",
        { runId, repositoryIdentity },
      );
    }

    const unverified = this.db.get<{ identity: string }>(
      `SELECT r.identity AS identity
         FROM github_receipts g
         JOIN repositories r ON r.identity = g.repository_identity
         JOIN run_repositories rr ON rr.run_id = g.run_id AND rr.repository_id = r.repository_id
        WHERE g.run_id = ?
          AND g.operation = 'merge_execute'
          AND g.status = 'APPLIED'
          AND rr.merge_state = 'PENDING'
        LIMIT 1`,
      [runId],
    );
    if (unverified) {
      return deny(
        ReasonCode.DEPENDENT_MERGE_BLOCKED,
        "an earlier repository in this run is merged and its post-merge verification has not answered",
        { runId, repositoryIdentity, awaiting: unverified.identity },
      );
    }
    return allow(ReasonCode.OK, undefined);
  }

  // -------------------------------------------------------------------------
  // release_tag
  // -------------------------------------------------------------------------

  /** §24.8 — semver match, exact accepted main merge commit, no duplicate, re-read. */
  async releaseTag(
    runId: string,
    repositoryIdentity: string,
    tag: string,
    commitSha: string,
    caller: GitHubCaller,
  ): Promise<Decision<{ tag: string; sha: string }>> {
    const authority = this.assertAuthority(runId, repositoryIdentity, caller);
    if (!authority.allowed) return authority as Decision<{ tag: string; sha: string }>;

    const profile = this.branchProfile(runId);
    if (!profile.allowed) return profile as Decision<{ tag: string; sha: string }>;
    if (profile.value.releaseTagPolicy !== "semver") {
      return deny(ReasonCode.MERGE_BRANCH_PROFILE_UNSATISFIED, "pinned manifest disables release tags", {
        runId,
        releaseTagPolicy: profile.value.releaseTagPolicy,
      });
    }
    if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
      return deny(ReasonCode.RELEASE_TAG_SEMVER_MISMATCH, "tag does not match the semver policy", { tag });
    }
    const slug = this.slug(repositoryIdentity);
    if (!slug.allowed) return slug as Decision<{ tag: string; sha: string }>;
    const { owner, repo } = slug.value;

    const acceptedMerge = this.db.get<{ response_json: string; verified: number }>(
      `SELECT response_json, verified FROM github_receipts
        WHERE operation = 'merge_execute' AND run_id = ? AND repository_identity = ? AND after_state_digest = ?`,
      [runId, repositoryIdentity, sha256(commitSha)],
    );
    const merge = acceptedMerge
      ? (JSON.parse(acceptedMerge.response_json) as { sourceBranch?: string; targetBranch?: string })
      : null;
    if (
      acceptedMerge?.verified !== 1 ||
      !merge ||
      !merge.sourceBranch?.startsWith("release/") ||
      merge.targetBranch !== "main"
    ) {
      return deny(
        ReasonCode.RELEASE_TAG_COMMIT_NOT_ACCEPTED,
        "tag target is not this run's verified release-to-main merge",
        { commitSha, repositoryIdentity, runId },
      );
    }

    const postMerge = this.db.get<{ response_json: string; verified: number }>(
      `SELECT response_json, verified FROM github_receipts
        WHERE operation = 'post_merge_verify' AND run_id = ? AND repository_identity = ?
          AND resource_identity = ?`,
      [runId, repositoryIdentity, `${owner}/${repo}@${commitSha}`],
    );
    const postChecks = postMerge
      ? (JSON.parse(postMerge.response_json) as { checks?: Array<{ conclusion?: string }> }).checks
      : null;
    if (postMerge?.verified !== 1 || !postChecks?.length || postChecks.some((check) => check.conclusion !== "success")) {
      return deny(ReasonCode.RELEASE_TAG_COMMIT_NOT_ACCEPTED, "release merge lacks a successful exact post-merge verification", {
        commitSha,
        repositoryIdentity,
      });
    }
    let devContainsMerge: { status: string };
    try {
      devContainsMerge = await this.api().request<{ status: string }>(
        "GET",
        `/repos/${owner}/${repo}/compare/${encodeURIComponent(profile.value.defaultBranch)}...${commitSha}`,
      );
    } catch (err) {
      return deny(ReasonCode.PROBE_FAILED, "could not verify release propagation to dev", {
        commitSha,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (devContainsMerge.status !== "behind" && devContainsMerge.status !== "identical") {
      return deny(ReasonCode.HOTFIX_PROPAGATION_INCOMPLETE, "release merge has not propagated to dev", {
        commitSha,
        target: profile.value.defaultBranch,
      });
    }

    const idempotencyKey = `release_tag:${repositoryIdentity}:${tag}`;
    const requestDigest = digestOf({ tag, commitSha });
    const prior = this.receipt(idempotencyKey);
    if (prior && prior.request_digest !== requestDigest) {
      return deny(ReasonCode.RESOURCE_COLLISION, "tag is already bound to different operation intent", {
        idempotencyKey,
        requestDigest,
        existingRequestDigest: prior.request_digest,
      });
    }
    if (prior?.verified !== 1 && this.inFlightReservations.has(idempotencyKey)) {
      return deny(ReasonCode.RESOURCE_COLLISION, "release tag operation is in flight", { idempotencyKey });
    }

    const existing = await this.api()
      .request<{ object?: { sha: string } }>("GET", `/repos/${owner}/${repo}/git/ref/tags/${tag}`)
      .catch(() => null);
    if (existing?.object?.sha) {
      if (existing.object.sha !== commitSha) {
        return deny(ReasonCode.RELEASE_TAG_DUPLICATE, "tag already exists on a different commit", {
          tag,
          existing: existing.object.sha,
          requested: commitSha,
        });
      }
      // The tag is already on the requested commit. When a reservation from an interrupted
      // attempt is still open, this read is exactly the reread its completion requires, so
      // the reservation is finished rather than abandoned as a permanent PENDING row.
      if (prior && prior.verified !== 1) {
        const reconciled = this.finalizeReservedReceipt({
          idempotencyKey,
          requestDigest,
          preexisting: false,
          afterStateDigest: sha256(commitSha),
          response: { tag, sha: commitSha },
          reread: true,
        });
        if (!reconciled.allowed) return reconciled as Decision<{ tag: string; sha: string }>;
      }
      return allow(ReasonCode.MERGE_IDEMPOTENT_REPLAY, { tag, sha: commitSha }, { replayed: true });
    }
    if (prior?.verified === 1) {
      // A completed receipt records a tag GitHub no longer has. Tagging again would be a
      // second external write under a receipt that already claims to describe the first.
      return deny(ReasonCode.RESOURCE_COLLISION, "recorded release tag is absent from GitHub", {
        idempotencyKey,
        tag,
      });
    }

    const finalization = this.assertFreshDaemonFinalization(
      runId,
      caller.daemonFinalizerAuthority,
      "release_tag",
    );
    if (!finalization.allowed) return finalization as Decision<{ tag: string; sha: string }>;
    // GitHub holds no such tag, so a leftover reservation's external write demonstrably did
    // not happen: releasing it destroys no evidence and lets this attempt reserve afresh.
    if (prior) this.releaseReservation(idempotencyKey, requestDigest);

    const tagTarget = this.writeTarget(runId, repositoryIdentity, merge.sourceBranch);
    if (!tagTarget.allowed) return tagTarget as Decision<{ tag: string; sha: string }>;

    const reserved = this.reserveReceipt({
      idempotencyKey,
      operation: "release_tag",
      runId,
      repositoryIdentity,
      resourceType: "tag",
      resourceIdentity: `${owner}/${repo}@${tag}`,
      beforeStateDigest: null,
      requestDigest,
    });
    if (!reserved.allowed) return reserved as Decision<{ tag: string; sha: string }>;

    const tagged = await this.mediate(
      WriteOperation.GITHUB_RELEASE,
      runId,
      repositoryIdentity,
      tagTarget.value,
      caller,
      () => this.api().request("POST", `/repos/${owner}/${repo}/git/refs`, {
        ref: `refs/tags/${tag}`,
        sha: commitSha,
      }),
    );
    if (!tagged.allowed) {
      if (tagged.evidence["effectInvoked"] !== true) this.releaseReservation(idempotencyKey, requestDigest);
      return tagged as Decision<{ tag: string; sha: string }>;
    }

    const reread = await this.api().request<{ object: { sha: string } }>(
      "GET",
      `/repos/${owner}/${repo}/git/ref/tags/${tag}`,
    );
    if (reread.object.sha !== commitSha) {
      return deny(ReasonCode.RELEASE_TAG_COMMIT_NOT_ACCEPTED, "tag re-read does not match", {
        tag,
        expected: commitSha,
        observed: reread.object.sha,
      });
    }

    // The reread proved the tag, so the reservation is completed here rather than after the
    // branch cleanup below: the receipt records the tag write, not an unrelated deletion.
    const finalized = this.finalizeReservedReceipt({
      idempotencyKey,
      requestDigest,
      preexisting: false,
      afterStateDigest: sha256(commitSha),
      response: { tag, sha: commitSha },
      reread: true,
    });
    if (!finalized.allowed) return finalized as Decision<{ tag: string; sha: string }>;

    if (profile.value.releaseBranchCleanup === "delete") {
      const sourceBranch = merge.sourceBranch;
      if (!sourceBranch) {
        return deny(ReasonCode.RELEASE_TAG_COMMIT_NOT_ACCEPTED, "accepted release merge has no source branch", {
          runId,
          repositoryIdentity,
          commitSha,
        });
      }
      const deleteTarget = this.writeTarget(runId, repositoryIdentity, sourceBranch);
      if (!deleteTarget.allowed) return deleteTarget as Decision<{ tag: string; sha: string }>;
      const deleted = await this.mediate(
        WriteOperation.GITHUB_RELEASE,
        runId,
        repositoryIdentity,
        deleteTarget.value,
        caller,
        () => this.api().request(
          "DELETE",
          `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(sourceBranch)}`,
        ),
      );
      if (!deleted.allowed) return deleted as Decision<{ tag: string; sha: string }>;
    }

    return allow(ReasonCode.OK, { tag, sha: commitSha });
  }

  // -------------------------------------------------------------------------
  // hotfix propagation and rollback
  // -------------------------------------------------------------------------

  /** §24.9 / Integration §9.6 — the fix must exist on main, dev and every active release. */
  async verifyHotfixPropagation(
    runId: string,
    repositoryIdentity: string,
    fixCommitSha: string,
  ): Promise<Decision<{ present: string[]; missing: string[] }>> {
    const slug = this.slug(repositoryIdentity);
    if (!slug.allowed) return slug as Decision<{ present: string[]; missing: string[] }>;
    const { owner, repo } = slug.value;

    const profile = this.branchProfile(runId);
    if (!profile.allowed) return profile as Decision<{ present: string[]; missing: string[] }>;
    const releases = await this.activeReleases(repositoryIdentity);
    if (!releases.allowed) return releases as Decision<{ present: string[]; missing: string[] }>;
    const targets = hotfixPropagationTargets(profile.value, releases.value);

    const present: string[] = [];
    const missing: string[] = [];
    for (const branch of targets) {
      const compared = await this.api()
        .request<{ status: string }>(
          "GET",
          `/repos/${owner}/${repo}/compare/${encodeURIComponent(branch)}...${fixCommitSha}`,
        )
        .catch(() => null);
      // "behind" or "identical" means the branch already contains the fix commit.
      if (compared && (compared.status === "behind" || compared.status === "identical")) present.push(branch);
      else missing.push(branch);
    }

    if (missing.length > 0) {
      this.audit.record({
        kind: "HOTFIX_PROPAGATION",
        runId,
        reasonCode: ReasonCode.HOTFIX_PROPAGATION_INCOMPLETE,
        evidence: { repositoryIdentity, fixCommitSha, present, missing },
      });
      return deny(ReasonCode.HOTFIX_PROPAGATION_INCOMPLETE, "hotfix is missing from active targets", {
        present,
        missing,
      });
    }
    return allow(ReasonCode.OK, { present, missing });
  }

  /** §24.10 — a compensation plan, prepared but never executed automatically. */
  rollbackPrepare(
    runId: string,
    repositoryIdentity: string,
    mergeCommitSha: string,
    strategy: "rollback" | "forward_fix" | "halt",
  ): Decision<{ plan: Record<string, unknown> }> {
    const plan = {
      runId,
      repositoryIdentity,
      mergeCommitSha,
      strategy,
      partialMergeState: this.runs.repositoriesOf(runId).map((r) => ({
        identity: r.identity,
        mergeState: r.mergeState,
        mergeOrder: r.mergeOrder,
      })),
      preparedAt: this.clock.nowIso(),
    };
    this.writeReceipt({
      idempotencyKey: `rollback_prepare:${repositoryIdentity}:${mergeCommitSha}:${strategy}`,
      operation: "rollback_prepare",
      runId,
      repositoryIdentity,
      resourceType: "plan",
      resourceIdentity: `${repositoryIdentity}@${mergeCommitSha}`,
      preexisting: false,
      beforeStateDigest: null,
      afterStateDigest: digestOf(plan),
      requestDigest: digestOf({ mergeCommitSha, strategy }),
      response: { plan },
      reread: false,
    });
    return allow(ReasonCode.OK, { plan });
  }

  // -------------------------------------------------------------------------
  // issue_project
  // -------------------------------------------------------------------------

  /**
   * Integration §17.3 — marker-based idempotent projection. The ticket file stays the
   * portable contract; the issue is a projection of it.
   */
  async issueProject(
    runId: string,
    repositoryIdentity: string,
    tickets: ReadonlyArray<{ id: string; title: string; body: string; labels?: string[] }>,
    caller: GitHubCaller,
  ): Promise<Decision<{ created: number; updated: number }>> {
    const authority = this.assertAuthority(runId, repositoryIdentity, caller);
    if (!authority.allowed) return authority as Decision<{ created: number; updated: number }>;

    const slug = this.slug(repositoryIdentity);
    if (!slug.allowed) return slug as Decision<{ created: number; updated: number }>;
    const { owner, repo } = slug.value;

    const requestDigest = digestOf(tickets);
    const idempotencyKey = `issue_project:${repositoryIdentity}:${requestDigest}`;
    const prior = this.receipt(idempotencyKey);
    if (prior?.verified === 1) {
      // This exact ticket set was already projected and reread. Running the writes again
      // would mutate GitHub under a receipt that already records the completed projection.
      return allow(
        ReasonCode.MERGE_IDEMPOTENT_REPLAY,
        JSON.parse(prior.response_json) as { created: number; updated: number },
        { replayed: true },
      );
    }
    const finalization = this.assertFreshDaemonFinalization(
      runId,
      caller.daemonFinalizerAuthority,
      "issue_project",
    );
    if (!finalization.allowed) return finalization as Decision<{ created: number; updated: number }>;
    if (prior && this.inFlightReservations.has(idempotencyKey)) {
      return deny(ReasonCode.RESOURCE_COLLISION, "issue projection is in flight", { idempotencyKey });
    }

    const existing = await this.listIssues(repositoryIdentity);
    if (!existing.allowed) return existing as Decision<{ created: number; updated: number }>;
    const byMarker = new Map<string, number>();
    for (const issue of existing.value) {
      const marker = this.ticketMarker(issue.body);
      if (marker) byMarker.set(marker, issue.number);
    }

    const target = tickets.length > 0 ? this.writeTargetForRun(runId, repositoryIdentity) : null;
    if (target && !target.allowed) return target as Decision<{ created: number; updated: number }>;

    // The reservation is claimed before the first PATCH or POST, so a crash between the
    // write and its reread leaves a reconcilable PENDING row rather than an unrecorded
    // projection. A reservation left over from such a crash describes this same intent and
    // the projection is marker-idempotent, so it is resumed instead of reserved twice — but
    // it becomes this caller's in-flight write, which no concurrent caller may seize.
    if (prior) {
      this.inFlightReservations.add(idempotencyKey);
    } else {
      const reserved = this.reserveReceipt({
        idempotencyKey,
        operation: "issue_project",
        runId,
        repositoryIdentity,
        resourceType: "issues",
        resourceIdentity: `${owner}/${repo}`,
        beforeStateDigest: null,
        requestDigest,
      });
      if (!reserved.allowed) return reserved as Decision<{ created: number; updated: number }>;
    }

    let created = 0;
    let updated = 0;
    for (const ticket of tickets) {
      const body = `<!-- acp-ticket:${ticket.id} -->\n${ticket.body}`;
      const number = byMarker.get(ticket.id);
      const written = number
        ? await this.mediate(
            WriteOperation.GITHUB_ISSUE,
            runId,
            repositoryIdentity,
            target!.value,
            caller,
            () => this.api().request("PATCH", `/repos/${owner}/${repo}/issues/${number}`, {
              title: ticket.title,
              body,
              labels: ticket.labels ?? [],
            }),
          )
        : await this.mediate(
            WriteOperation.GITHUB_ISSUE,
            runId,
            repositoryIdentity,
            target!.value,
            caller,
            () => this.api().request("POST", `/repos/${owner}/${repo}/issues`, {
              title: ticket.title,
              body,
              labels: ticket.labels ?? [],
            }),
          );
      if (!written.allowed) {
        // Only a reservation whose external write demonstrably did not happen may be
        // released: once any ticket has been projected the row stays PENDING as the record
        // of a partial projection that has to be reconciled.
        if (created + updated === 0 && written.evidence["effectInvoked"] !== true) {
          this.releaseReservation(idempotencyKey, requestDigest);
        }
        return written as Decision<{ created: number; updated: number }>;
      }
      if (number) updated += 1;
      else created += 1;
    }

    if (created + updated === 0) {
      // Nothing was projected, so no external write happened and there is nothing to
      // record: the reservation is released rather than completed into an empty receipt.
      this.releaseReservation(idempotencyKey, requestDigest);
      return allow(ReasonCode.OK, { created, updated });
    }

    // §16.2 — the PATCH and POST acknowledgements are not evidence. Re-read the issues and
    // require every projected ticket to be present with the marker, title and body sent.
    const reread = await this.listIssues(repositoryIdentity);
    if (!reread.allowed) return reread as Decision<{ created: number; updated: number }>;
    const projected = new Map<string, { number: number; title?: string; body: string | null }>();
    for (const issue of reread.value) {
      const marker = this.ticketMarker(issue.body);
      if (marker) projected.set(marker, issue);
    }
    const unprojected = tickets.filter((ticket) => {
      const issue = projected.get(ticket.id);
      return (
        !issue ||
        issue.title !== ticket.title ||
        issue.body !== `<!-- acp-ticket:${ticket.id} -->\n${ticket.body}`
      );
    });
    if (unprojected.length > 0) {
      return deny(ReasonCode.ISSUE_PROJECTION_UNVERIFIED, "GitHub did not persist the projected tickets", {
        repositoryIdentity,
        tickets: unprojected.map((ticket) => ticket.id),
      });
    }

    // `preexisting` says the resource was observed rather than written by this kernel; a
    // completed reservation always records writes this kernel performed, and how many of
    // them landed on issues that already existed is what `updated` reports.
    const finalized = this.finalizeReservedReceipt({
      idempotencyKey,
      requestDigest,
      preexisting: false,
      afterStateDigest: digestOf({ created, updated }),
      response: { created, updated },
      reread: true,
    });
    if (!finalized.allowed) return finalized as Decision<{ created: number; updated: number }>;
    return allow(ReasonCode.OK, { created, updated });
  }

  /** The projection marker is the idempotency key GitHub itself carries (Integration §17.3). */
  private ticketMarker(body: string | null | undefined): string | null {
    return /<!-- acp-ticket:([^\s]+) -->/.exec(body ?? "")?.[1] ?? null;
  }

  // -------------------------------------------------------------------------
  // CI evidence
  // -------------------------------------------------------------------------

  /** Resolve the one pinned run whose current frozen candidate owns this CI head. */
  private runForCandidateHead(repositoryIdentity: string, head: string): Decision<string> {
    const rows = this.db.all<{ run_id: string }>(
      `SELECT run_id FROM runs WHERE current_candidate_digest IS NOT NULL AND pinned_manifest_digest IS NOT NULL`,
    );
    const matches = rows
      .map((row) => row.run_id)
      .filter((runId) => {
        const candidate = this.candidateRepository(runId, repositoryIdentity);
        return candidate.allowed && candidate.value.candidateHead === head;
      });
    return matches.length === 1
      ? allow(ReasonCode.OK, matches[0]!)
      : deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "CI head does not resolve to exactly one pinned run contract", {
          repositoryIdentity,
          head,
          matchingRuns: matches,
        });
  }

  private pinnedManifest(runId: string): Decision<ProjectManifest> {
    const run = this.runs.get(runId);
    if (!run?.pinnedManifestDigest) {
      return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "run has no pinned manifest", { runId });
    }
    const manifest = this.projects.manifest(run.pinnedManifestDigest);
    return manifest
      ? allow(ReasonCode.OK, manifest)
      : deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "pinned manifest is not retrievable", {
          runId,
          pinnedManifestDigest: run.pinnedManifestDigest,
        });
  }

  /**
   * Trust an Actions check only after resolving the actual suite, Actions run and
   * workflow path. A check name and `github-actions` app slug are candidate-controlled
   * unless this chain proves the approved workflow at the exact commit produced it.
   */
  private async assertTrustedWorkflowCheck(
    runId: string,
    repositoryIdentity: string,
    head: string,
    check: CheckRun,
  ): Promise<Decision<{ workflowDigest: string }>> {
    const manifest = this.pinnedManifest(runId);
    if (!manifest.allowed) return manifest as Decision<{ workflowDigest: string }>;
    // Matched on role as well as name (#512): the digest below is read from this repository, so
    // an entry belonging to a different participant must not be the one it is compared against.
    const role = this.repositoryRoleInRun(runId, repositoryIdentity);
    const workflow = manifest.value.ciWorkflows.find(
      (entry) => entry.checkName === check.name && entry.repositoryRole === role,
    );
    if (!workflow?.approvedDigest || check.head_sha !== head || check.app?.slug !== "github-actions") {
      return deny(ReasonCode.GATE_CREATOR_UNTRUSTED, "check has no approved Actions workflow provenance", {
        checkRunId: check.id,
        checkName: check.name,
      });
    }
    const suiteId = check.check_suite?.id;
    const runIdFromUrl = /\/actions\/runs\/(\d+)\/job\/\d+/.exec(check.details_url ?? "")?.[1];
    if (!suiteId || !runIdFromUrl) {
      return deny(ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID, "check does not identify an Actions job and suite", {
        checkRunId: check.id,
      });
    }
    const slug = this.slug(repositoryIdentity);
    if (!slug.allowed) return slug as Decision<{ workflowDigest: string }>;
    const { owner, repo } = slug.value;
    try {
      const [suite, run] = await Promise.all([
        this.api().request<{ head_sha: string; app?: { slug?: string } | null }>(
          "GET",
          `/repos/${owner}/${repo}/check-suites/${suiteId}`,
        ),
        this.api().request<{ head_sha: string; path?: string; status?: string; conclusion?: string | null }>(
          "GET",
          `/repos/${owner}/${repo}/actions/runs/${runIdFromUrl}`,
        ),
      ]);
      if (
        suite.head_sha !== head ||
        suite.app?.slug !== "github-actions" ||
        run.head_sha !== head ||
        run.path !== workflow.path ||
        run.status !== "completed" ||
        run.conclusion !== "success"
      ) {
        return deny(ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID, "Actions suite or run differs from the required check", {
          checkRunId: check.id,
          suiteHead: suite.head_sha,
          runHead: run.head_sha,
          runPath: run.path ?? null,
        });
      }
      const content = await this.workflowContentAtExactHead(
        repositoryIdentity,
        owner,
        repo,
        head,
        workflow.path,
      );
      if (!content.allowed) return content as Decision<{ workflowDigest: string }>;
      const workflowDigest = sha256(content.value);
      return workflowDigest === workflow.approvedDigest
        ? allow(ReasonCode.OK, { workflowDigest })
        : deny(ReasonCode.VERIFICATION_CI_WORKFLOW_DIGEST_MISMATCH, "Actions workflow differs from pinned approval", {
            checkRunId: check.id,
            expected: workflow.approvedDigest,
            observed: workflowDigest,
          });
    } catch (err) {
      return deny(ReasonCode.PROBE_FAILED, "could not resolve Actions provenance for check", {
        checkRunId: check.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * A local checkout intentionally lags a remote merge. Prefer its exact object when it is
   * present, then read the same immutable file from GitHub at the merge SHA rather than
   * mistaking an absent local object for a different workflow.
   */
  private async workflowContentAtExactHead(
    repositoryIdentity: string,
    owner: string,
    repo: string,
    head: string,
    path: string,
  ): Promise<Decision<string>> {
    const repository = this.repositories.byIdentity(repositoryIdentity);
    const local = repository ? await fileAt(repository.checkoutPath, head, path) : null;
    if (local !== null) return allow(ReasonCode.OK, local);
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    try {
      const remote = await this.api().request<{ type?: string; encoding?: string; content?: string }>(
        "GET",
        `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(head)}`,
      );
      if (remote.type !== "file" || remote.encoding !== "base64" || typeof remote.content !== "string") {
        return deny(
          ReasonCode.PROBE_FAILED,
          "GitHub did not return the exact workflow file for post-merge provenance",
          { repositoryIdentity, head, path },
        );
      }
      return allow(ReasonCode.OK, Buffer.from(remote.content.replace(/\s/g, ""), "base64").toString("utf8"));
    } catch {
      return deny(
        ReasonCode.PROBE_FAILED,
        "could not read the exact workflow file for post-merge provenance",
        { repositoryIdentity, head, path },
      );
    }
  }

  ciEvidenceSource(): CiEvidenceSource {
    return {
      fetch: async (identity, head) => {
        const slug = this.slug(identity);
        if (!slug.allowed) return [];
        const run = this.runForCandidateHead(identity, head);
        if (!run.allowed) return [];
        const { owner, repo } = slug.value;
        const response = await this.api()
          .request<{ check_runs: CheckRun[] }>(
            "GET",
            `/repos/${owner}/${repo}/commits/${head}/check-runs`,
          )
          .catch(() => ({ check_runs: [] as CheckRun[] }));

        const checks: CiCheck[] = [];
        for (const check of response.check_runs ?? []) {
          if (check.name === GATE_CHECK_NAME) continue; // the gate is not its own evidence
          const trusted = await this.assertTrustedWorkflowCheck(run.value, identity, head, check);
          if (!trusted.allowed) continue;
          checks.push({
            commandId: check.name,
            repositoryIdentity: identity,
            head: check.head_sha,
            conclusion: (check.conclusion as CiCheck["conclusion"]) ?? "unknown",
            workflowDigest: trusted.value.workflowDigest,
            creatorIdentity: check.app?.slug ?? "unknown",
            completedAt: check.completed_at ?? this.clock.nowIso(),
            nonVacuous: true,
          });
        }
        return checks;
      },
      approvedWorkflowDigests: async (identity) => {
        const rows = this.db.all<{ run_id: string }>(
          `SELECT run_id FROM runs WHERE current_candidate_digest IS NOT NULL AND pinned_manifest_digest IS NOT NULL`,
        );
        // The fetch path binds an individual check to one exact run; this list only
        // supplies the verification port's membership set, so it may never consult an
        // active repository manifest that a candidate can rotate.
        return rows
          .filter((row) => this.candidateRepository(row.run_id, identity).allowed)
          .map((row) => this.pinnedManifest(row.run_id))
          .filter((result): result is Extract<Decision<ProjectManifest>, { allowed: true }> => result.allowed)
          .flatMap((result) => result.value.ciWorkflows)
          .map((workflow) => workflow.approvedDigest)
          .filter((d): d is string => Boolean(d));
      },
      trustedCreators: async () => {
        const identity = this.credentials.creatorIdentity();
        return identity ? [identity, "github-actions"] : ["github-actions"];
      },
    };
  }

  // -------------------------------------------------------------------------
  // shared helpers
  // -------------------------------------------------------------------------

  private candidateRepository(
    runId: string,
    repositoryIdentity: string,
  ): Decision<CandidateSnapshot["repositories"][number]> {
    const run = this.runs.get(runId);
    const current = this.runs.currentCandidate(runId);
    if (!run || !current) {
      return deny(ReasonCode.EVIDENCE_MISSING, "run has no current frozen candidate", { runId });
    }
    if (!run.pinnedManifestDigest) {
      return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "run has no pinned manifest", { runId });
    }
    const snapshot = this.artifacts.latestForSnapshot<CandidateSnapshot>(
      runId,
      "CANDIDATE_SNAPSHOT",
      current,
    );
    const repository = snapshot?.content.repositories.find((entry) => entry.identity === repositoryIdentity);
    if (
      !snapshot ||
      snapshot.superseded ||
      snapshot.content.contractDigest !== run.contractDigest ||
      !repository ||
      repository.manifestDigest !== run.pinnedManifestDigest
    ) {
      return deny(ReasonCode.EVIDENCE_MISSING, "frozen candidate does not prove this repository's pinned contract", {
        runId,
        repositoryIdentity,
        candidateSnapshotDigest: current,
      });
    }
    return allow(ReasonCode.OK, repository);
  }

  private prBody(body: string, runId: string, linkedIssues: readonly number[], requireLinkage: boolean): string {
    const markers = [`<!-- acp-run:${runId} -->`];
    if (requireLinkage) {
      markers.unshift(...linkedIssues.map((issue) => `Closes #${issue}`));
      markers.push(`<!-- acp-linked-issues:${linkedIssues.join(",")} -->`);
    }
    return `${body.trimEnd()}\n\n${markers.join("\n")}`;
  }

  /**
   * Resolve the resource declaration every remote write gives the managed-write guard.
   *
   * A repository identity alone is not enough for an operation that can race another run:
   * the guard must know both the local checkout whose registration it is validating and the
   * branch whose claim owns the remote mutation. Callers that cannot name one fail closed.
   */
  private writeTarget(
    runId: string,
    repositoryIdentity: string,
    targetBranch: string | null | undefined,
  ): Decision<GitHubWriteTarget> {
    if (!targetBranch?.trim()) {
      return deny(ReasonCode.MERGE_CLAIM_INVALID, "GitHub write has no concrete target branch", {
        runId,
        repositoryIdentity,
      });
    }
    const repository = this.repositories.byIdentity(repositoryIdentity);
    if (!repository) {
      return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "GitHub write has no registered checkout", {
        runId,
        repositoryIdentity,
      });
    }
    return allow(ReasonCode.OK, { targetBranch, targetPath: repository.checkoutPath });
  }

  /**
   * Some projections do not carry a branch in their external payload. They still have to
   * name the one branch the run holds for this repository; guessing from a checkout or
   * accepting an unscoped issue/tag write would defeat the guard's resource fence.
   */
  private writeTargetForRun(runId: string, repositoryIdentity: string): Decision<GitHubWriteTarget> {
    const participant = this.runs.repositoriesOf(runId).find((entry) => entry.identity === repositoryIdentity);
    if (!participant) {
      return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "repository does not participate in this run", {
        runId,
        repositoryIdentity,
      });
    }
    if (participant.workBranch) return this.writeTarget(runId, repositoryIdentity, participant.workBranch);

    const claims = this.db.all<{ branch: string }>(
      `SELECT branch FROM resource_claims
        WHERE run_id = ? AND repository_identity = ? AND status = 'HELD'
          AND expires_at > ? AND branch IS NOT NULL
        ORDER BY acquired_at, claim_id`,
      [runId, repositoryIdentity, this.clock.nowIso()],
    );
    const branches = [...new Set(claims.map((claim) => claim.branch))];
    if (branches.length !== 1) {
      return deny(ReasonCode.MERGE_CLAIM_INVALID, "GitHub write cannot resolve one claimed branch", {
        runId,
        repositoryIdentity,
        branches,
      });
    }
    return this.writeTarget(runId, repositoryIdentity, branches[0]!);
  }

  /**
   * The frozen PR target is not source lineage. The candidate snapshot already captured the
   * origin branch and SHA inside its digest, so never re-resolve a live branch here: a later
   * source advance must not rewrite a candidate's origin or make it stale.
   */
  private async assertFrozenSourceLineage(
    repositoryIdentity: string,
    head: string,
    profile: BranchProfile,
    declaredParent: string | null,
    candidate: CandidateSnapshot["repositories"][number],
  ): Promise<Decision<{ sourceBranch: string; sourceHead: string }>> {
    const requiredSourceBranch = requiredBaseFor(head, profile, declaredParent);
    if (!requiredSourceBranch) {
      return deny(ReasonCode.PR_BRANCH_CONTRACT_VIOLATION, "branch class has no required source lineage", {
        repositoryIdentity,
        head,
      });
    }
    const { sourceBranch, sourceHead } = candidate;
    if (!sourceBranch || !sourceHead) {
      return deny(ReasonCode.PR_BRANCH_CONTRACT_VIOLATION, "frozen candidate has no source lineage", {
        repositoryIdentity,
        head,
        candidateHead: candidate.candidateHead,
        sourceBranch: sourceBranch ?? null,
        sourceHead: sourceHead ?? null,
      });
    }
    if (sourceBranch !== requiredSourceBranch) {
      return deny(ReasonCode.PR_BRANCH_CONTRACT_VIOLATION, "frozen candidate source branch violates the branch contract", {
        repositoryIdentity,
        head,
        sourceBranch,
        requiredSourceBranch,
      });
    }
    const repository = this.repositories.byIdentity(repositoryIdentity);
    if (!repository) {
      return deny(ReasonCode.EVIDENCE_MISSING, "candidate repository has no local checkout for source lineage proof", {
        repositoryIdentity,
      });
    }
    const observed = await mergeBase(repository.checkoutPath, sourceHead, candidate.candidateHead);
    return observed === sourceHead
      ? allow(ReasonCode.OK, { sourceBranch, sourceHead })
      : deny(ReasonCode.PR_BRANCH_CONTRACT_VIOLATION, "candidate does not descend from the required source", {
          repositoryIdentity,
          sourceBranch,
          expectedSourceHead: sourceHead,
          mergeBase: observed,
        });
  }

  /**
   * CP-HI-07 at the GitHub boundary. The kernel owns payload binding, not owner-decision
   * interpretation: `ProductionGate.humanGateStatus` is re-read for both publication and
   * merge, then its current definition digest is bound to the payload.
   */
  private assertGatePayloadHumanGateStatus(payload: GatePayload): Decision<void> {
    const port = this.humanGateStatusPort;
    if (!port) {
      return deny(ReasonCode.HUMAN_GATE_UNSATISFIED, "GitHub kernel has no human-gate status port", {
        runId: payload.runId,
      });
    }
    const status = port.humanGateStatus(payload.runId);
    if (!status.required) {
      return payload.humanGateDigest === NO_HUMAN_GATE_DIGEST
        ? allow(ReasonCode.OK, undefined)
        : deny(
            ReasonCode.GATE_EVIDENCE_NOT_BACKED,
            "run needs no owner decision; the payload must carry the canonical no-human-gate digest",
            { runId: payload.runId, expected: NO_HUMAN_GATE_DIGEST, observed: payload.humanGateDigest },
          );
    }
    if (!status.satisfied || payload.humanGateDigest !== status.humanGateDigest) {
      return deny(ReasonCode.HUMAN_GATE_UNSATISFIED, "current human-gate status does not satisfy this payload", {
        runId: payload.runId,
        required: status.required,
        items: status.items,
        satisfied: status.satisfied,
        expectedDigest: status.humanGateDigest,
        suppliedDigest: payload.humanGateDigest,
      });
    }
    return allow(ReasonCode.OK, undefined);
  }

  private hasPrLinkage(body: string | null | undefined, linkedIssues: readonly number[]): boolean {
    if (!body) return false;
    return (
      linkedIssues.every((issue) => new RegExp(`\\bCloses\\s+#${issue}\\b`, "i").test(body)) &&
      body.includes(`<!-- acp-linked-issues:${linkedIssues.join(",")} -->`)
    );
  }

  private hasPrRunMarker(body: string | null | undefined, runId: string): boolean {
    return Boolean(body?.includes(`<!-- acp-run:${runId} -->`));
  }

  private preparedPrIntent(
    runId: string,
    repositoryIdentity: string,
    pullNumber: number,
  ): Decision<PreparedPrIntent> {
    const receipts = this.db.all<{ response_json: string; verified: number }>(
      `SELECT response_json, verified FROM github_receipts
        WHERE operation = 'pr_prepare' AND run_id = ? AND repository_identity = ?
        ORDER BY created_at DESC`,
      [runId, repositoryIdentity],
    );
    const receipt = receipts.find((entry) => {
      const parsed = JSON.parse(entry.response_json) as { pullNumber?: number };
      return parsed.pullNumber === pullNumber;
    });
    const response = receipt ? (JSON.parse(receipt.response_json) as { intent?: Record<string, unknown> }) : null;
    const intent = response?.intent;
    if (
      receipt?.verified !== 1 ||
      !intent ||
      typeof intent.head !== "string" ||
      typeof intent.base !== "string" ||
      typeof intent.exactHeadSha !== "string" ||
      typeof intent.expectedBaseSha !== "string" ||
      typeof intent.candidateSnapshotDigest !== "string" ||
      typeof intent.sourceBranch !== "string" ||
      typeof intent.sourceHead !== "string" ||
      (intent.declaredParent !== null && typeof intent.declaredParent !== "string")
    ) {
      return deny(ReasonCode.EVIDENCE_MISSING, "pull request has no immutable prepare contract", {
        runId,
        repositoryIdentity,
        pullNumber,
      });
    }
    return allow(ReasonCode.OK, {
      head: intent.head,
      base: intent.base,
      exactHeadSha: intent.exactHeadSha,
      expectedBaseSha: intent.expectedBaseSha,
      candidateSnapshotDigest: intent.candidateSnapshotDigest,
      sourceBranch: intent.sourceBranch,
      sourceHead: intent.sourceHead,
      declaredParent: intent.declaredParent,
    });
  }

  private setMergeState(runId: string, repositoryIdentity: string, state: "MERGED" | "FAILED"): void {
    const repositoryId = this.runs.repositoriesOf(runId).find((entry) => entry.identity === repositoryIdentity)?.repositoryId;
    if (repositoryId) this.runs.setRepositoryMergeState(runId, repositoryId, state);
  }

  private mergeRepositoryId(runId: string, repositoryIdentity: string): Decision<string> {
    const repositoryId = this.runs.repositoriesOf(runId).find((entry) => entry.identity === repositoryIdentity)?.repositoryId;
    return repositoryId
      ? allow(ReasonCode.OK, repositoryId)
      : deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "repository does not participate in this run", {
          runId,
          repositoryIdentity,
        });
  }

  /**
   * The durable PENDING receipt must survive an inconclusive external write, but its
   * in-memory reservation only prevents duplicate concurrent writes. Keeping that set bit
   * after a proof failure prevents the very reconciliation the receipt was retained for.
   */
  private markMergeUnproven(input: MergeInput, repositoryId: string, idempotencyKey: string): void {
    this.runs.setRepositoryMergeState(input.runId, repositoryId, "FAILED");
    this.inFlightReservations.delete(idempotencyKey);
  }

  private keepsMergeProofPending(reasonCode: ReasonCode): boolean {
    return (
      isStalenessReasonCode(reasonCode) ||
      reasonCode === ReasonCode.EVIDENCE_MISSING ||
      reasonCode === ReasonCode.PROBE_FAILED
    );
  }

  private recordPendingMergeProofFailure(
    input: MergeInput,
    repositoryId: string,
    idempotencyKey: string,
    mergeCommitSha: string | null,
    failure: Decision<unknown>,
  ): void {
    this.markMergeUnproven(input, repositoryId, idempotencyKey);
    this.audit.record({
      kind: "MERGE_BASE_DRIFT",
      runId: input.runId,
      reasonCode: failure.reasonCode,
      evidence: {
        repositoryIdentity: input.repositoryIdentity,
        mergeCommitSha,
        expectedBase: input.expectedBaseSha,
        detail: failure.allowed ? "merge proof was not established" : failure.message,
      },
    });
  }

  private recordMergeProofFailure(
    input: MergeInput,
    repositoryId: string,
    idempotencyKey: string,
    mergeCommitSha: string,
    failure: Decision<unknown>,
  ): void {
    this.recordPendingMergeProofFailure(input, repositoryId, idempotencyKey, mergeCommitSha, failure);
    this.rollbackPrepare(input.runId, input.repositoryIdentity, mergeCommitSha, "halt");
  }

  private assertAuthority(
    runId: string,
    repositoryIdentity: string,
    caller: { ownerSessionId: string; ownerBindingGeneration: number },
  ): Decision<void> {
    const owner = this.runs.assertOwner(runId, caller.ownerSessionId, caller.ownerBindingGeneration);
    if (!owner.allowed) return owner as Decision<void>;
    const participating = this.runs
      .repositoriesOf(runId)
      .some((r) => r.identity === repositoryIdentity);
    if (!participating) {
      return deny(
        ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
        "repository does not participate in this run",
        { runId, repositoryIdentity },
      );
    }
    return allow(ReasonCode.OK, undefined);
  }

  private branchProfile(runId: string): Decision<BranchProfile> {
    const run = this.runs.get(runId);
    if (!run?.pinnedManifestDigest) {
      return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "run has no pinned manifest for a GitHub decision", {
        runId,
      });
    }
    const manifest = this.projects.manifest(run.pinnedManifestDigest);
    if (!manifest?.branchProfile) {
      return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "run's pinned manifest is unavailable", {
        runId,
        pinnedManifestDigest: run.pinnedManifestDigest,
      });
    }
    return allow(ReasonCode.OK, manifest.branchProfile);
  }

  private async activeReleases(repositoryIdentity: string): Promise<Decision<string[]>> {
    const slug = this.slug(repositoryIdentity);
    if (!slug.allowed) return slug as Decision<string[]>;
    const { owner, repo } = slug.value;
    const names: string[] = [];
    for (let page = 1; page <= 10_000; page += 1) {
      let branches: Array<{ name: string }>;
      try {
        branches = await this.api().request<Array<{ name: string }>>(
          "GET",
          `/repos/${owner}/${repo}/branches?per_page=100&page=${page}`,
        );
      } catch (err) {
        return deny(ReasonCode.PROBE_FAILED, "could not enumerate active release branches", {
          repositoryIdentity,
          page,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      names.push(...branches.filter((branch) => branch.name.startsWith("release/")).map((branch) => branch.name));
      if (branches.length < 100) return allow(ReasonCode.OK, [...new Set(names)].sort());
    }
    return deny(ReasonCode.PROBE_FAILED, "release branch enumeration exceeded pagination bound", {
      repositoryIdentity,
    });
  }

  /** GitHub's list endpoint defaults to 30; never let a first page decide a merge gate. */
  private async listCheckRuns(
    repositoryIdentity: string,
    head: string,
    checkName?: string,
  ): Promise<Decision<CheckRun[]>> {
    const slug = this.slug(repositoryIdentity);
    if (!slug.allowed) return slug as Decision<CheckRun[]>;
    const { owner, repo } = slug.value;
    const all: CheckRun[] = [];
    for (let page = 1; page <= 10_000; page += 1) {
      const query = new URLSearchParams({ per_page: "100", page: String(page) });
      if (checkName) query.set("check_name", checkName);
      let response: { check_runs?: CheckRun[] };
      try {
        response = await this.api().request<{ check_runs?: CheckRun[] }>(
          "GET",
          `/repos/${owner}/${repo}/commits/${encodeURIComponent(head)}/check-runs?${query.toString()}`,
        );
      } catch (error) {
        return deny(ReasonCode.PROBE_FAILED, "could not enumerate GitHub check runs", {
          repositoryIdentity,
          head,
          checkName: checkName ?? null,
          page,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const checks = response.check_runs ?? [];
      all.push(...checks);
      if (checks.length < 100) return allow(ReasonCode.OK, all);
    }
    return deny(ReasonCode.PROBE_FAILED, "GitHub check-run enumeration exceeded pagination bound", {
      repositoryIdentity,
      head,
      checkName: checkName ?? null,
    });
  }

  /** Marker idempotency is correct only if the scan covers every issue GitHub can return. */
  private async listIssues(
    repositoryIdentity: string,
  ): Promise<Decision<Array<{ number: number; title?: string; body: string | null }>>> {
    const slug = this.slug(repositoryIdentity);
    if (!slug.allowed) return slug as Decision<Array<{ number: number; title?: string; body: string | null }>>;
    const { owner, repo } = slug.value;
    const all: Array<{ number: number; title?: string; body: string | null }> = [];
    for (let page = 1; page <= 10_000; page += 1) {
      let issues: Array<{ number: number; title?: string; body: string | null }>;
      try {
        issues = await this.api().request<Array<{ number: number; title?: string; body: string | null }>>(
          "GET",
          `/repos/${owner}/${repo}/issues?state=all&per_page=100&page=${page}`,
        );
      } catch (error) {
        return deny(ReasonCode.PROBE_FAILED, "could not enumerate GitHub issues for projection", {
          repositoryIdentity,
          page,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      all.push(...issues);
      if (issues.length < 100) return allow(ReasonCode.OK, all);
    }
    return deny(ReasonCode.PROBE_FAILED, "GitHub issue enumeration exceeded pagination bound", {
      repositoryIdentity,
    });
  }

  private receipt(idempotencyKey: string): { response_json: string; request_digest: string; verified: number } | undefined {
    return this.db.get<{ response_json: string; request_digest: string; verified: number }>(
      `SELECT response_json, request_digest, verified FROM github_receipts WHERE idempotency_key = ?`,
      [idempotencyKey],
    );
  }

  /**
   * A durable reservation is written before a GitHub mutation. SQLite's unique key
   * serializes concurrent daemon processes; callers with different intent see a
   * collision rather than inheriting an unrelated receipt.
   */
  private reserveReceipt(input: {
    idempotencyKey: string;
    operation: string;
    runId: string | null;
    repositoryIdentity: string;
    resourceType: string;
    resourceIdentity: string;
    beforeStateDigest: string | null;
    requestDigest: string;
  }): Decision<void> {
    const existing = this.receipt(input.idempotencyKey);
    if (existing) {
      return deny(
        ReasonCode.RESOURCE_COLLISION,
        existing.request_digest === input.requestDigest
          ? "GitHub operation is already pending reconciliation"
          : "GitHub resource is already bound to different operation intent",
        { idempotencyKey: input.idempotencyKey },
      );
    }
    try {
      this.db.run(
        // PENDING is what makes this a reservation rather than a record: it is claimed
        // before the external call, and only the reread that follows may complete it.
        `INSERT INTO github_receipts
           (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type,
            resource_identity, preexisting, before_state_digest, after_state_digest, request_digest,
            response_json, created_at, reread_at, verified, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, ?, NULL, 0, 'PENDING')`,
        [
          `rcp_${sha256(input.idempotencyKey).slice(7, 31)}`,
          input.idempotencyKey,
          input.operation,
          input.runId,
          input.repositoryIdentity,
          input.resourceType,
          input.resourceIdentity,
          input.beforeStateDigest,
          input.requestDigest,
          JSON.stringify({ pending: true }),
          this.clock.nowIso(),
        ],
      );
      this.inFlightReservations.add(input.idempotencyKey);
      return allow(ReasonCode.OK, undefined);
    } catch {
      return deny(ReasonCode.RESOURCE_COLLISION, "GitHub operation reservation raced another writer", {
        idempotencyKey: input.idempotencyKey,
      });
    }
  }

  private finalizeReservedReceipt(input: {
    idempotencyKey: string;
    requestDigest: string;
    preexisting: boolean;
    afterStateDigest: string | null;
    response: unknown;
    reread: boolean;
  }): Decision<void> {
    const updated = this.db.run(
      `UPDATE github_receipts
          SET status = 'APPLIED', preexisting = ?, after_state_digest = ?, response_json = ?,
              reread_at = ?, verified = ?
        WHERE idempotency_key = ? AND request_digest = ? AND status = 'PENDING' AND verified = 0`,
      [
        input.preexisting ? 1 : 0,
        input.afterStateDigest,
        JSON.stringify(input.response),
        input.reread ? this.clock.nowIso() : null,
        input.reread ? 1 : 0,
        input.idempotencyKey,
        input.requestDigest,
      ],
    );
    if (updated.changes === 1) {
      this.inFlightReservations.delete(input.idempotencyKey);
      return allow(ReasonCode.OK, undefined);
    }
    return deny(ReasonCode.RESOURCE_COLLISION, "reserved GitHub receipt could not be finalized", {
      idempotencyKey: input.idempotencyKey,
    });
  }

  /** No external write happened when grant consumption fails, so this reservation is safe to release. */
  private releaseReservation(idempotencyKey: string, requestDigest: string): void {
    this.db.run(
      `DELETE FROM github_receipts
        WHERE idempotency_key = ? AND request_digest = ? AND status = 'PENDING' AND verified = 0`,
      [idempotencyKey, requestDigest],
    );
    this.inFlightReservations.delete(idempotencyKey);
  }

  private writeReceipt(input: {
    idempotencyKey: string;
    operation: string;
    runId: string | null;
    repositoryIdentity: string;
    resourceType: string;
    resourceIdentity: string;
    preexisting: boolean;
    beforeStateDigest: string | null;
    afterStateDigest: string | null;
    requestDigest: string;
    response: unknown;
    reread: boolean;
  }): void {
    // A reserved receipt is *completed*, never replaced: `INSERT OR REPLACE` deletes the
    // PENDING row first, and an append-only receipt table refuses that (§24.5). Where no
    // reservation exists — operations that record an observation rather than perform a
    // write — the row is inserted APPLIED in one step.
    const now = this.clock.nowIso();
    const reserved = this.db.get<{ status: string; request_digest: string }>(
      `SELECT status, request_digest FROM github_receipts WHERE idempotency_key = ?`,
      [input.idempotencyKey],
    );
    if (reserved?.status === "PENDING") {
      const finalized = this.finalizeReservedReceipt({
        idempotencyKey: input.idempotencyKey,
        requestDigest: input.requestDigest,
        preexisting: input.preexisting,
        afterStateDigest: input.afterStateDigest,
        response: input.response,
        reread: input.reread,
      });
      if (!finalized.allowed) throw new Error(`${finalized.reasonCode}: ${finalized.message}`);
      return;
    }
    if (reserved?.status === "APPLIED") {
      if (reserved.request_digest === input.requestDigest) return;
      throw new Error(`RESOURCE_COLLISION: receipt already records different operation intent (${input.idempotencyKey})`);
    }
    this.db.run(
      `INSERT INTO github_receipts
         (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type,
          resource_identity, preexisting, before_state_digest, after_state_digest, request_digest,
          response_json, created_at, reread_at, verified, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'APPLIED')`,
      [
        `rcp_${sha256(input.idempotencyKey).slice(7, 31)}`,
        input.idempotencyKey, input.operation, input.runId, input.repositoryIdentity,
        input.resourceType, input.resourceIdentity, input.preexisting ? 1 : 0,
        input.beforeStateDigest, input.afterStateDigest, input.requestDigest,
        JSON.stringify(input.response), now,
        input.reread ? now : null, input.reread ? 1 : 0,
      ],
    );
  }

  receipts(runId: string): Array<{ operation: string; resourceIdentity: string; verified: boolean }> {
    return this.db
      .all<{ operation: string; resource_identity: string; verified: number }>(
        `SELECT operation, resource_identity, verified FROM github_receipts WHERE run_id = ? ORDER BY created_at`,
        [runId],
      )
      .map((r) => ({ operation: r.operation, resourceIdentity: r.resource_identity, verified: r.verified === 1 }));
  }

  /** Doctor input — is the trusted gate path healthy? */
  gateHealth(): { credentialInstalled: boolean; permissionsOk: boolean; creatorIdentity: string | null } {
    return {
      credentialInstalled: this.credentials.available(),
      permissionsOk: this.credentials.permissionsOk(),
      creatorIdentity: this.credentials.creatorIdentity(),
    };
  }
}
