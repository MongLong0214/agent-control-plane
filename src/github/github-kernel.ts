import { homedir } from "node:os";
import { dirname, isAbsolute } from "node:path";

import type { Clock } from "../core/clock.ts";
import { digestOf, sha256 } from "../core/digest.ts";
import { type Decision, allow, deny, fromErrorPayload, isAcpError } from "../core/errors.ts";
import { parseGitHubIdentity } from "../core/ids.ts";
import { RunState } from "../domain/types.ts";
import { isStalenessReasonCode, ReasonCode } from "../core/reason-codes.ts";
import { projectManifestSchema, type BranchProfile, type ProjectManifest } from "../contracts/manifest.ts";
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
import { EVIDENCE_PRODUCERS, OWNER_DECIDE_AGAIN_MESSAGE, ownerDecideAgainEvidence } from "../db/artifacts.ts";
import {
  WriteOperation,
  type DaemonFinalizerAuthority,
  type ManagedWriteGuard,
} from "../guard/managed-write-guard.ts";
import { hotfixPropagationTargets, requiredBaseFor, validateBranchContract } from "./branch-contract.ts";
import type { BeforeDispatch, TrustedCredentialStore } from "./credential-store.ts";
import {
  type BranchObjects,
  type BranchPublishLimits,
  DEFAULT_BRANCH_PUBLISH_LIMITS,
  collectBranchObjects,
  gitBytes,
} from "../git/branch-objects.ts";
import { scanPublication, workflowChanges } from "./branch-publish.ts";

/**
 * The gate's GitHub-side correlator: run, candidate, and the payload digest that binds the rest.
 *
 * Deliberately reuses values already bound into the payload rather than inventing an identifier —
 * a correlator with its own namespace would be one more thing that can disagree with the receipt.
 */
export const gateExternalId = (runId: string, candidateSnapshotDigest: string, payloadDigest: string): string =>
  `acp:${runId}:${candidateSnapshotDigest}:${payloadDigest}`;

export const GATE_CHECK_NAME = "acp-production-gate";

/**
 * The only value a gate payload may carry for `humanGateDigest` when the run needs no
 * owner decision. A free-form digest there would let a caller satisfy the field with
 * anything at all.
 */
export const NO_HUMAN_GATE_DIGEST = digestOf({ humanGate: "NOT_REQUIRED" });
export const PROJECT_CHECK_NAME = "project-ci";

/** Run states after the CEO's CONFIRM, in which the daemon finalizer writes to GitHub. */
const FINALIZING_STATES: ReadonlySet<string> = new Set([RunState.CEO_APPROVED, RunState.MERGING, RunState.POST_MERGE_VERIFYING]);
/** How long a branch claim renewed for finalization stays held. */
const FINALIZATION_CLAIM_RENEWAL_MS = 2 * 60 * 60 * 1000;

/**
 * Whether a failed GitHub call was *answered* or merely *unheard* (#533).
 *
 * `PROBE_FAILED` is read by exactly one branch — `keepsMergeProofPending` — which decides whether
 * a merge whose proof did not complete stays PENDING and reconcilable, or is written FAILED.
 * Keying that on "unknown" is right. What was wrong is what arrived labelled unknown: a 404 and a
 * 403 are answers, a timeout is not, and all three were the same value.
 *
 * The discriminator already exists and is already sanitized. `credential-store.githubApi` records
 * `status` when a response arrived and omits it when the transport threw before one did, and it
 * deliberately drops the body so that no diagnostic path can preserve an echoed credential. A
 * status code is a small integer with nowhere to hide a secret; a message is unbounded, which is
 * why this classifies rather than forwarding one.
 *
 * Unrecognised throws classify as `unknown` on purpose. `GitHubClient` is an injectable interface
 * and a test double may throw anything, so an exception this code cannot read is not evidence that
 * the far end answered.
 */
export type TransportOutcome = "answered" | "unheard";

export const transportOutcome = (error: unknown): { outcome: TransportOutcome; status?: number } => {
  if (!isAcpError(error)) return { outcome: "unheard" };
  const status = (error.evidence as { status?: unknown } | undefined)?.status;
  return typeof status === "number" ? { outcome: "answered", status } : { outcome: "unheard" };
};

/**
 * FD-R2 — `beforeDispatch` is a synchronous check that a client awaiting something before it sends
 * (`GitHubAppClient`: the installation token) runs after that await and immediately before the
 * request leaves. If the check refuses or throws, the client sends nothing and rejects.
 */
export interface GitHubRequestOptions {
  beforeDispatch?: BeforeDispatch;
}

export interface GitHubClient {
  request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    options?: GitHubRequestOptions,
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
  /** #512 S-PUSH — bounds on one branch publication; a candidate past any of them is refused. */
  branchPublishLimits?: Partial<BranchPublishLimits>;
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
    options?: GitHubRequestOptions,
  ): Promise<T> {
    const result = await this.credentials.githubApi({
      method,
      path,
      ...(body !== undefined ? { input: JSON.stringify(body) } : {}),
      ...(options?.beforeDispatch ? { beforeDispatch: options.beforeDispatch } : {}),
    });
    // Throw the denial structurally rather than flattening it to a string (#533): the evidence
    // carries `status` when a response arrived, and that is the only thing distinguishing an
    // answer from silence. The message is the credential store's own controlled failure text —
    // never a response body, which that layer drops before this one sees it.
    if (!result.allowed) throw fromErrorPayload({
      reasonCode: result.reasonCode,
      message: result.message,
      evidence: result.evidence,
    });
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
 * #512 S-PUSH — one repository's branch publication, derived by the daemon finalizer from durable run
 * state (`deriveConfirmedMergePlan`), never accepted from an MCP caller. Every SHA here is checked against
 * the frozen candidate snapshot, which is the only source the kernel reads them from.
 */
export interface BranchPublishInput {
  runId: string;
  repositoryIdentity: string;
  /** The branch created on GitHub, create-only. Never a long-lived, default or base branch. */
  branch: string;
  baseBranch: string;
  exactHeadSha: string;
  expectedBaseSha: string;
  candidateSnapshotDigest: string;
  /** The plan's human-gate binding: the value its gate payload carries, re-read before every send. */
  humanGateDigest: string;
  declaredParent?: string | null;
  /** The pull request text that follows the publication, scanned with everything sent. */
  pullRequest: { title: string; body: string; linkedIssues?: readonly number[]; requireLinkage?: boolean };
  ownerSessionId: string;
  ownerBindingGeneration: number;
  /** Opaque capability supplied only by the daemon finalizer after CEO approval. */
  daemonFinalizerAuthority?: DaemonFinalizerAuthority;
}

export interface BranchPublishResult {
  ref: string;
  sha: string;
  scanDigest: string;
  /** Whether this call sent anything. False when the branch already stood at the exact candidate. */
  sent: boolean;
}

/** What GitHub's ref read answered: the exact commit, an answered 404, or nothing usable. */
type BranchRefObservation =
  | { kind: "at"; sha: string }
  | { kind: "missing" }
  /** #1161 BP-02 — an answer that is not exactly the ref asked for: another name, another type, no commit id. */
  | { kind: "contradicts"; observed: { ref: unknown; type: unknown; sha: unknown } }
  | { kind: "unknown"; outcome: TransportOutcome; status?: number };

/** One publication attempt's local facts, shared by the fresh and the reconciling path. */
interface BranchDelivery {
  input: BranchPublishInput;
  owner: string;
  repo: string;
  ref: string;
  refPath: string;
  baseRefPath: string;
  candidateHead: string;
  baseHead: string;
  objects: BranchObjects;
  scanDigest: string;
  counts: { commits: number; trees: number; blobs: number; bytes: number };
  idempotencyKey: string;
  requestDigest: string;
  request: Record<string, unknown>;
}

/**
 * The GitHub boundary deliberately reads the owner gate through this narrow port.
 * `ProductionGate.resolveHumanGate` is the sole place that interprets owner decisions, T3 approvals
 * and their ingress receipts; the port answers `ProductionGate.humanGateBinding`, and the kernel only
 * compares its binding with the gate payload's, each time it publishes and each time it merges.
 */
export interface HumanGateStatusPort {
  humanGateStatus(runId: string): {
    required: boolean;
    items: readonly string[];
    satisfied: boolean;
    /**
     * FIX-FINALIZER-DIGEST — the current human-gate binding: the digest of the gate definition digest,
     * the current candidate and each required item's authenticated decision, the same value the daemon
     * finalizer names as the payload's `humanGateDigest`. Null while the gate is unsatisfied, so no
     * payload can name it; never the definition digest alone.
     */
    humanGateDigest: string | null;
    /**
     * SEC-OD1-R1-02 — the undecided items whose latest owner approval is not a canonical owner decision
     * (recorded before SEC-OD1), named so the refusal says the owner must decide again.
     */
    decideAgain?: readonly string[];
  };
}

interface PullRequest {
  number: number;
  commits?: number;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  merged: boolean;
  merge_commit_sha?: string | null;
  /** GitHub's own mergeability: false is a conflict, null while GitHub is still computing it. */
  mergeable?: boolean | null;
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

/** Where CommitLore keeps a commit's records beside its message; a merge does not move it (#1269). */
const NOTES_REF = "refs/notes/commitlore";

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
  external_id?: string | null;
}

interface ObservedPostMergeCheck {
  name: string;
  conclusion: string;
}

/** A declared post-merge check that has not answered yet: absent, or still running. */
const isUnansweredPostMergeCheck = (check: ObservedPostMergeCheck): boolean =>
  check.conclusion === "missing" || check.conclusion.startsWith("incomplete:");

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
  /** `ProductionGate.resolveHumanGate`, through `humanGateBinding`, is the sole human-gate predicate. */
  private humanGateStatusPort: HumanGateStatusPort | null = null;
  private readonly client: GitHubClient | undefined;
  private readonly postMergePollAttempts: number;
  private readonly postMergePollIntervalMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly branchPublishLimits: BranchPublishLimits;

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
    this.branchPublishLimits = { ...DEFAULT_BRANCH_PUBLISH_LIMITS, ...options.branchPublishLimits };
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
        reread.title !== input.title ||
        reread.body !== prBody ||
        (input.requireLinkage && !this.hasPrLinkage(reread.body, linkedIssues))
      ) {
        return deny(ReasonCode.RESOURCE_COLLISION, "cached PR no longer proves the same operation", {
          idempotencyKey,
          pullNumber: cached.pullNumber,
        });
      }
      // #1189 B5 — the same pull, whose base moved past the frozen base: a stale base, as the merge step names it.
      if (reread.base.sha !== candidate.value.baseHead) {
        return deny(ReasonCode.MERGE_BASE_STALE, "the prepared PR's base moved since the candidate froze", {
          pullNumber: cached.pullNumber,
          expected: candidate.value.baseHead,
          observed: reread.base.sha,
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
    if (reread.head.sha !== input.input.exactHeadSha || reread.head.ref !== input.input.head) {
      return deny(ReasonCode.MERGE_HEAD_STALE, "pull request head does not match the candidate head", {
        expected: { sha: input.input.exactHeadSha, ref: input.input.head },
        observed: reread.head,
      });
    }
    if (reread.base.ref !== input.input.base || reread.base.sha !== input.candidate.baseHead) {
      return deny(ReasonCode.MERGE_BASE_STALE, "pull request base does not match the frozen candidate base", {
        expected: { sha: input.candidate.baseHead, ref: input.input.base },
        observed: reread.base,
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
  // branch_publish (#512 S-PUSH)
  // -------------------------------------------------------------------------

  /**
   * #512 S-PUSH (CEO f5879479, 3d0daed0) — delivers a STANDARD_WORK candidate's branch to GitHub through
   * the Git Data API with the App token, in process, before the pull request is prepared.
   *
   * Before any network call: the pinned owner, the branch claim, the frozen candidate, CEO-approved
   * finalization with the daemon capability, the existing human-gate binding (D2), a branch that is no
   * long-lived, default or base branch, the frozen source lineage, and the refusing public-safety scan over
   * every object the publication would send and the pull request text that follows (a finding refuses;
   * nothing is redacted, because redaction changes the ids). Then, by GitHub reads: the branch contract and
   * the remote base ref, which must stand at the frozen base SHA (MERGE_BASE_STALE otherwise).
   *
   * Reconciliation is by `branch_publish:<repoIdentity>:<branch>:<candidateHead>`, the request digest binds
   * {runId, candidateSnapshotDigest, baseHead, scanDigest}, and GitHub's ref is the truth: at the candidate
   * the publication is APPLIED, whoever wrote it (an answer lost, or the same commit pushed by anyone);
   * missing, it is sent again; at any other commit it is RESOURCE_COLLISION, never forced (D4). A branch
   * already at the candidate before anything is sent is recorded as an observation (preexisting).
   *
   * Sending (D1, no fallback): a PENDING receipt is reserved first; blobs, trees and commits are uploaded,
   * each built from the local object, and each id GitHub answers must be the local one, the commit's tree
   * included, or nothing more is sent and no ref is written. The ref is then created once, under the guard,
   * and the human gate is re-read immediately before every send. APPLIED is recorded only after the ref is
   * read back at the exact candidate; a 422, an answered failure and silence all take that same read. A
   * TRUSTED_CI or BOTH_REQUIRED contract (D3) and any change under `.github/workflows/` (D5) are refused
   * before the reservation. The uploads are external sends even when no ref is written.
   */
  async publishBranch(input: BranchPublishInput): Promise<Decision<BranchPublishResult>> {
    type Published = Decision<BranchPublishResult>;
    const authority = this.assertAuthority(input.runId, input.repositoryIdentity, input);
    if (!authority.allowed) return authority as Published;
    const claimed = this.assertClaim(input.runId, input.repositoryIdentity, input.branch);
    if (!claimed.allowed) return claimed as Published;
    const candidate = this.candidateRepository(input.runId, input.repositoryIdentity);
    if (!candidate.allowed) return candidate as Published;
    const frozen = candidate.value;
    if (
      this.runs.currentCandidate(input.runId) !== input.candidateSnapshotDigest ||
      input.exactHeadSha !== frozen.candidateHead ||
      input.expectedBaseSha !== frozen.baseHead ||
      input.baseBranch !== frozen.baseBranch
    ) {
      return deny(ReasonCode.SNAPSHOT_STALE, "branch publication does not name the run's frozen candidate", {
        runId: input.runId,
        repositoryIdentity: input.repositoryIdentity,
        candidateSnapshotDigest: input.candidateSnapshotDigest,
        currentCandidateSnapshotDigest: this.runs.currentCandidate(input.runId),
      });
    }
    const finalization = this.assertFreshDaemonFinalization(input.runId, input.daemonFinalizerAuthority, "branch_publish");
    if (!finalization.allowed) return finalization as Published;
    const humanGate = this.assertGatePayloadHumanGateStatus(input);
    if (!humanGate.allowed) return humanGate as Published;
    const profile = this.branchProfile(input.runId);
    if (!profile.allowed) return profile as Published;
    if (
      input.branch === input.baseBranch ||
      input.branch === profile.value.defaultBranch ||
      profile.value.longLived.includes(input.branch)
    ) {
      return deny(ReasonCode.PR_BRANCH_CONTRACT_VIOLATION, "a branch publication never writes a long-lived, default or base branch", {
        runId: input.runId,
        branch: input.branch,
      });
    }
    const lineage = await this.assertFrozenSourceLineage(
      input.repositoryIdentity,
      input.branch,
      profile.value,
      input.declaredParent ?? null,
      frozen,
    );
    if (!lineage.allowed) return lineage as Published;
    const repository = this.repositories.byIdentity(input.repositoryIdentity);
    if (!repository) {
      return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "branch publication has no registered checkout", {
        repositoryIdentity: input.repositoryIdentity,
      });
    }
    // The lower bound is the frozen base SHA, never a branch tip read now.
    const objects = await collectBranchObjects(repository.checkoutPath, frozen.baseHead, frozen.candidateHead, this.branchPublishLimits);
    if (!objects.allowed) return objects as Published;
    if (`git-tree:${objects.value.candidateTree}` !== frozen.treeDigest) {
      return deny(ReasonCode.SNAPSHOT_STALE, "the local candidate tree is not the frozen tree", {
        runId: input.runId,
        candidateHead: frozen.candidateHead,
      });
    }
    const linkedIssues = [...new Set(input.pullRequest.linkedIssues ?? [])].sort((a, b) => a - b);
    const scan = scanPublication({
      objects: objects.value,
      branch: input.branch,
      pullRequestTitle: input.pullRequest.title,
      pullRequestBody: this.prBody(input.pullRequest.body, input.runId, linkedIssues, Boolean(input.pullRequest.requireLinkage)),
      forbiddenPaths: this.publicationForbiddenPaths(),
      limits: this.branchPublishLimits,
    });
    if (!scan.allowed) {
      this.audit.record({
        kind: "BRANCH_PUBLISH_REFUSED",
        runId: input.runId,
        reasonCode: scan.reasonCode,
        evidence: { repositoryIdentity: input.repositoryIdentity, branch: input.branch, ...scan.evidence },
      });
      return scan as Published;
    }

    const slug = this.slug(input.repositoryIdentity);
    if (!slug.allowed) return slug as Published;
    const { owner, repo } = slug.value;
    const releases = await this.activeReleases(input.repositoryIdentity);
    if (!releases.allowed) return releases as Published;
    const contract = validateBranchContract({
      head: input.branch,
      base: input.baseBranch,
      profile: profile.value,
      declaredParent: input.declaredParent ?? null,
      activeReleases: releases.value,
      sourceBranch: lineage.value.sourceBranch,
    });
    if (!contract.allowed) return contract as Published;

    const request = {
      runId: input.runId,
      candidateSnapshotDigest: input.candidateSnapshotDigest,
      baseHead: frozen.baseHead,
      scanDigest: scan.value.scanDigest,
    };
    const delivery: BranchDelivery = {
      input,
      owner,
      repo,
      ref: `refs/heads/${input.branch}`,
      refPath: `/repos/${owner}/${repo}/git/ref/heads/${this.refPathOf(input.branch)}`,
      baseRefPath: `/repos/${owner}/${repo}/git/ref/heads/${this.refPathOf(input.baseBranch)}`,
      candidateHead: frozen.candidateHead,
      baseHead: frozen.baseHead,
      objects: objects.value,
      scanDigest: scan.value.scanDigest,
      counts: scan.value.counts,
      idempotencyKey: `branch_publish:${input.repositoryIdentity}:${input.branch}:${frozen.candidateHead}`,
      requestDigest: digestOf(request),
      request,
    };
    const result = (sent: boolean): BranchPublishResult => ({
      ref: delivery.ref,
      sha: delivery.candidateHead,
      scanDigest: delivery.scanDigest,
      sent,
    });

    const existing = this.receipt(delivery.idempotencyKey);
    if (existing) {
      if (existing.request_digest !== delivery.requestDigest) {
        return deny(ReasonCode.RESOURCE_COLLISION, "branch publication is already bound to different operation intent", {
          idempotencyKey: delivery.idempotencyKey,
          existingRequestDigest: existing.request_digest,
          requestDigest: delivery.requestDigest,
        });
      }
      if (this.inFlightReservations.has(delivery.idempotencyKey)) {
        return deny(ReasonCode.RESOURCE_COLLISION, "branch publication is in flight", { idempotencyKey: delivery.idempotencyKey });
      }
      const observed = await this.readBranchRef(delivery.refPath, delivery.ref);
      if (observed.kind === "unknown") {
        return deny(ReasonCode.PROBE_FAILED, "the branch ref could not be read to reconcile its publication", {
          idempotencyKey: delivery.idempotencyKey,
          outcome: observed.outcome,
          ...(observed.status === undefined ? {} : { status: observed.status }),
        });
      }
      if (observed.kind === "contradicts") return this.refContradiction(delivery, "reconciliation readback", observed);
      if (observed.kind === "at" && observed.sha === delivery.candidateHead) {
        if (existing.verified !== 1) {
          // The ref is the candidate: an answer was lost, or the same commit was pushed by anyone. No resend.
          const finalized = this.finalizeReservedReceipt({
            idempotencyKey: delivery.idempotencyKey,
            requestDigest: delivery.requestDigest,
            preexisting: false,
            afterStateDigest: digestOf({ ref: delivery.ref, sha: observed.sha }),
            response: { ...result(false), reconciled: true, request: delivery.request, counts: delivery.counts },
            reread: true,
          });
          if (!finalized.allowed) return finalized as Published;
          this.recordBranchPublished(delivery, "RECONCILED");
        }
        return allow(ReasonCode.MERGE_IDEMPOTENT_REPLAY, result(false), { replayed: true });
      }
      if (observed.kind === "at") {
        return deny(ReasonCode.RESOURCE_COLLISION, "the branch stands at another commit; a publication never moves or forces it", {
          idempotencyKey: delivery.idempotencyKey,
          expected: delivery.candidateHead,
          observed: observed.sha,
        });
      }
      if (existing.verified === 1) {
        return deny(ReasonCode.RESOURCE_COLLISION, "the published branch no longer exists; an applied publication is never recreated", {
          idempotencyKey: delivery.idempotencyKey,
        });
      }
      // PENDING and the ref is missing: send again under the same reservation, whose record stays.
      return this.deliverBranch(delivery, false);
    }

    const finalizationAgain = this.assertFreshDaemonFinalization(input.runId, input.daemonFinalizerAuthority, "branch_publish");
    if (!finalizationAgain.allowed) return finalizationAgain as Published;
    const base = await this.assertRemoteBase(delivery);
    if (!base.allowed) return base as Published;
    const head = await this.readBranchRef(delivery.refPath, delivery.ref);
    if (head.kind === "contradicts") return this.refContradiction(delivery, "branch read before publication", head);
    if (head.kind === "unknown") {
      return deny(ReasonCode.PROBE_FAILED, "the branch ref could not be read before publication", {
        repositoryIdentity: input.repositoryIdentity,
        branch: input.branch,
        outcome: head.outcome,
        ...(head.status === undefined ? {} : { status: head.status }),
      });
    }
    if (head.kind === "at" && head.sha !== delivery.candidateHead) {
      return deny(ReasonCode.RESOURCE_COLLISION, "the branch already stands at another commit; a publication never moves or forces it", {
        repositoryIdentity: input.repositoryIdentity,
        branch: input.branch,
        expected: delivery.candidateHead,
        observed: head.sha,
      });
    }
    if (head.kind === "at") {
      // Already at the exact candidate before anything is sent: an observation, recorded as one.
      this.writeReceipt({
        idempotencyKey: delivery.idempotencyKey,
        operation: "branch_publish",
        runId: input.runId,
        repositoryIdentity: input.repositoryIdentity,
        resourceType: "git_ref",
        resourceIdentity: `${owner}/${repo}@${delivery.ref}`,
        preexisting: true,
        beforeStateDigest: null,
        afterStateDigest: digestOf({ ref: delivery.ref, sha: head.sha }),
        requestDigest: delivery.requestDigest,
        response: { ...result(false), request: delivery.request, counts: delivery.counts },
        reread: true,
      });
      this.recordBranchPublished(delivery, "OBSERVED");
      return allow(ReasonCode.OK, result(false));
    }
    return this.deliverBranch(delivery, true);
  }

  /**
   * The sending half of `publishBranch`: D3 and D5, then (for a fresh publication) the reservation, the
   * object uploads with each answered id checked, the one create-only ref, and the readback that alone may
   * record APPLIED. `reserve` is false when a PENDING reservation for the same intent is being sent again.
   */
  private async deliverBranch(delivery: BranchDelivery, reserve: boolean): Promise<Decision<BranchPublishResult>> {
    type Published = Decision<BranchPublishResult>;
    const { input, owner, repo, idempotencyKey, requestDigest } = delivery;
    if (!reserve) {
      const base = await this.assertRemoteBase(delivery);
      if (!base.allowed) return base as Published;
    }
    const manifest = this.pinnedManifest(input.runId);
    if (!manifest.allowed) return manifest as Published;
    const ciEvidence = manifest.value.verificationCommands.filter((command) => command.evidenceMode !== "LOCAL_COMMAND");
    if (ciEvidence.length > 0) {
      return deny(ReasonCode.BRANCH_PUBLISH_UNSUPPORTED, "v1 does not publish for a contract whose evidence needs CI before CEO approval (D3); nothing was sent", {
        runId: input.runId,
        commands: ciEvidence.map((command) => ({ id: command.id, evidenceMode: command.evidenceMode })),
      });
    }
    const workflows = workflowChanges(delivery.objects.changedPaths);
    if (workflows.length > 0) {
      return deny(ReasonCode.BRANCH_PUBLISH_UNSUPPORTED, "a branch publication never changes a workflow under .github/workflows (D5); nothing was sent", {
        runId: input.runId,
        paths: workflows.slice(0, 20),
      });
    }
    const target = this.writeTarget(input.runId, input.repositoryIdentity, input.branch);
    if (!target.allowed) return target as Published;
    if (reserve) {
      const reserved = this.reserveReceipt({
        idempotencyKey,
        operation: "branch_publish",
        runId: input.runId,
        repositoryIdentity: input.repositoryIdentity,
        resourceType: "git_ref",
        resourceIdentity: `${owner}/${repo}@${delivery.ref}`,
        beforeStateDigest: null,
        requestDigest,
      });
      if (!reserved.allowed) return reserved as Published;
    } else {
      this.inFlightReservations.add(idempotencyKey);
    }
    try {
      const caller: GitHubCaller = {
        ownerSessionId: input.ownerSessionId,
        ownerBindingGeneration: input.ownerBindingGeneration,
        daemonFinalizerAuthority: input.daemonFinalizerAuthority,
      };
      const uploaded = await this.mediate(
        WriteOperation.GITHUB_BRANCH_PUBLISH,
        input.runId,
        input.repositoryIdentity,
        target.value,
        caller,
        () => this.uploadBranchObjects(delivery),
      );
      if (!uploaded.allowed) {
        if (reserve && uploaded.evidence["effectInvoked"] !== true) this.releaseReservation(idempotencyKey, requestDigest);
        return uploaded as Published;
      }
      const progress = uploaded.value;
      if (progress.refused) {
        if (reserve && progress.sent === 0) this.releaseReservation(idempotencyKey, requestDigest);
        return progress.refused as Published;
      }
      if (progress.mismatch) {
        return deny(ReasonCode.BRANCH_PUBLISH_OBJECT_MISMATCH, "GitHub answered an object id that is not the local one; no ref was written", {
          idempotencyKey,
          ...progress.mismatch,
          objectsSent: progress.sent,
        });
      }
      if (progress.failure) {
        return deny(ReasonCode.PROBE_FAILED, "an object upload did not complete; no ref was written and the publication stays pending", {
          idempotencyKey,
          ...progress.failure,
          objectsSent: progress.sent,
        });
      }

      const dispatch = this.branchPublishAtDispatch(input);
      const created = await this.mediate(
        WriteOperation.GITHUB_BRANCH_PUBLISH,
        input.runId,
        input.repositoryIdentity,
        target.value,
        caller,
        async () => {
          try {
            const answer = await this.api().request<unknown>(
              "POST",
              `/repos/${owner}/${repo}/git/refs`,
              { ref: delivery.ref, sha: delivery.candidateHead },
              { beforeDispatch: dispatch.beforeDispatch },
            );
            return { refused: null, outcome: null as ReturnType<typeof transportOutcome> | null, answer };
          } catch (error) {
            return { refused: dispatch.refused(), outcome: transportOutcome(error), answer: undefined as unknown };
          }
        },
      );
      if (!created.allowed) return created as Published;
      if (created.value.refused) return created.value.refused as Published;
      if (created.value.outcome === null) {
        // #1161 BP-02 — the create answered: it must name exactly this ref, a commit, at the candidate. Any other
        // answer leaves the remote uncertain, so nothing is recorded APPLIED here and the receipt stays PENDING;
        // the reconciliation path settles it later by reading only the exact target ref.
        const answered = this.refAnswer(created.value.answer, delivery.ref);
        if (answered.kind !== "at" || answered.sha !== delivery.candidateHead) {
          return this.refContradiction(
            delivery,
            "ref create answer",
            answered.kind === "contradicts"
              ? answered
              : { kind: "contradicts", observed: { ref: delivery.ref, type: "commit", sha: answered.sha } },
          );
        }
      }

      // A created ref, a 422 "Reference already exists", an answered failure and silence: one readback decides.
      const observed = await this.readBranchRef(delivery.refPath, delivery.ref);
      if (observed.kind === "contradicts") return this.refContradiction(delivery, "readback after the create", observed);
      if (observed.kind === "at" && observed.sha === delivery.candidateHead) {
        const finalized = this.finalizeReservedReceipt({
          idempotencyKey,
          requestDigest,
          preexisting: false,
          afterStateDigest: digestOf({ ref: delivery.ref, sha: observed.sha }),
          response: {
            ref: delivery.ref,
            sha: observed.sha,
            scanDigest: delivery.scanDigest,
            sent: true,
            request: delivery.request,
            counts: delivery.counts,
            objectsSent: progress.sent,
            createOutcome: created.value.outcome,
          },
          reread: true,
        });
        if (!finalized.allowed) return finalized as Published;
        this.recordBranchPublished(delivery, "CREATED");
        return allow(ReasonCode.OK, {
          ref: delivery.ref,
          sha: observed.sha,
          scanDigest: delivery.scanDigest,
          sent: true,
        });
      }
      if (observed.kind === "at") {
        return deny(ReasonCode.RESOURCE_COLLISION, "the branch stands at another commit; a publication never moves or forces it", {
          idempotencyKey,
          expected: delivery.candidateHead,
          observed: observed.sha,
          createOutcome: created.value.outcome,
        });
      }
      return deny(ReasonCode.PROBE_FAILED, "the created ref was not read back at the candidate; the publication stays pending", {
        idempotencyKey,
        readback: observed.kind,
        createOutcome: created.value.outcome,
      });
    } finally {
      this.inFlightReservations.delete(idempotencyKey);
    }
  }

  /** Blobs, then trees, then commits, each id GitHub answers checked before the next send. Never throws. */
  private async uploadBranchObjects(delivery: BranchDelivery): Promise<{
    sent: number;
    refused: Decision<void> | null;
    mismatch: { object: string; type: string; expected: string; observed: unknown } | null;
    failure: { object: string; type: string; outcome: TransportOutcome; status?: number } | null;
  }> {
    const progress = {
      sent: 0,
      refused: null as Decision<void> | null,
      mismatch: null as { object: string; type: string; expected: string; observed: unknown } | null,
      failure: null as { object: string; type: string; outcome: TransportOutcome; status?: number } | null,
    };
    const prefix = `/repos/${delivery.owner}/${delivery.repo}/git`;
    const send = async (
      type: "blob" | "tree" | "commit",
      object: string,
      body: unknown,
      expected: (answer: { sha?: unknown; tree?: { sha?: unknown } } | null) => boolean,
    ): Promise<boolean> => {
      const dispatch = this.branchPublishAtDispatch(delivery.input);
      let answer: { sha?: unknown; tree?: { sha?: unknown } } | null;
      try {
        answer = await this.api().request<{ sha?: unknown; tree?: { sha?: unknown } } | null>(
          "POST",
          `${prefix}/${type}s`,
          body,
          { beforeDispatch: dispatch.beforeDispatch },
        );
      } catch (error) {
        const refused = dispatch.refused();
        if (refused) {
          progress.refused = refused;
          return false;
        }
        progress.sent += 1;
        progress.failure = { object, type, ...transportOutcome(error) };
        return false;
      }
      progress.sent += 1;
      if (!expected(answer)) {
        progress.mismatch = {
          object,
          type,
          expected: object,
          observed: { sha: answer?.sha ?? null, ...(type === "commit" ? { tree: answer?.tree?.sha ?? null } : {}) },
        };
        return false;
      }
      return true;
    };
    for (const blob of delivery.objects.blobs) {
      const ok = await send("blob", blob.sha, { content: blob.content.toString("base64"), encoding: "base64" }, (answer) => answer?.sha === blob.sha);
      if (!ok) return progress;
    }
    for (const tree of delivery.objects.trees) {
      const ok = await send("tree", tree.sha, { tree: tree.entries }, (answer) => answer?.sha === tree.sha);
      if (!ok) return progress;
    }
    for (const commit of delivery.objects.commits) {
      const ok = await send("commit", commit.sha, commit.fields, (answer) =>
        answer?.sha === commit.sha && answer.tree?.sha === commit.fields.tree);
      if (!ok) return progress;
    }
    return progress;
  }

  /**
   * The check run immediately before each publication send, after the transport's last await: the plan's
   * human-gate binding is still the current one (D2), and the candidate is still the run's. A refusal sends
   * nothing and is reported as a refusal, not as silence.
   */
  private branchPublishAtDispatch(input: BranchPublishInput): { beforeDispatch: BeforeDispatch; refused: () => Decision<void> | null } {
    let refused: Decision<void> | null = null;
    return {
      beforeDispatch: () => {
        let verified: Decision<void>;
        try {
          verified = this.runs.currentCandidate(input.runId) !== input.candidateSnapshotDigest
            ? deny(ReasonCode.SNAPSHOT_STALE, "the candidate changed before a branch publication send", { runId: input.runId })
            : this.assertGatePayloadHumanGateStatus(input);
        } catch {
          verified = deny(ReasonCode.INTERNAL_ERROR, "branch publication could not be re-verified before dispatch", {
            runId: input.runId,
          });
        }
        refused = verified.allowed ? null : verified;
        return verified;
      },
      refused: () => refused,
    };
  }

  /** The remote base ref must stand at the frozen base SHA; a moved or unread base sends nothing. */
  private async assertRemoteBase(delivery: BranchDelivery): Promise<Decision<void>> {
    const base = await this.readBranchRef(delivery.baseRefPath, `refs/heads/${delivery.input.baseBranch}`);
    if (base.kind === "at" && base.sha === delivery.baseHead) return allow(ReasonCode.OK, undefined);
    if (base.kind === "contradicts") return this.refContradiction(delivery, "base ref read", base);
    if (base.kind === "unknown") {
      return deny(ReasonCode.PROBE_FAILED, "the remote base ref could not be read before publication", {
        baseBranch: delivery.input.baseBranch,
        outcome: base.outcome,
        ...(base.status === undefined ? {} : { status: base.status }),
      });
    }
    return deny(ReasonCode.MERGE_BASE_STALE, "the remote base ref is not the frozen base SHA; nothing was sent", {
      runId: delivery.input.runId,
      baseBranch: delivery.input.baseBranch,
      expected: delivery.baseHead,
      observed: base.kind === "at" ? base.sha : null,
    });
  }

  /**
   * #1161 BP-02 — a ref answer that is not exactly the ref asked for refuses. Nothing is recorded APPLIED
   * and no ref is written; a PENDING receipt stays for the reconciliation path, which reads only the exact
   * target. Another branch at the same commit never stands in for the intended one.
   */
  private refContradiction(
    delivery: BranchDelivery,
    where: string,
    observation: { kind: "contradicts"; observed: { ref: unknown; type: unknown; sha: unknown } },
  ): Decision<never> {
    const text = (value: unknown): string | null => typeof value === "string" ? value.slice(0, 200) : null;
    return deny(ReasonCode.BRANCH_PUBLISH_OBJECT_MISMATCH, `GitHub's ${where} is not exactly the ref asked for; nothing is recorded applied`, {
      idempotencyKey: delivery.idempotencyKey,
      expected: { ref: delivery.ref, type: "commit", sha: delivery.candidateHead },
      observed: {
        ref: text(observation.observed.ref),
        type: text(observation.observed.type),
        sha: text(observation.observed.sha),
      },
    });
  }

  /** An answer that names a ref: exactly `expectedRef`, an object of type commit, a full commit id. */
  private refAnswer(answer: unknown, expectedRef: string): { kind: "at"; sha: string } | { kind: "contradicts"; observed: { ref: unknown; type: unknown; sha: unknown } } {
    const body = answer !== null && typeof answer === "object" && !Array.isArray(answer)
      ? answer as { ref?: unknown; object?: { sha?: unknown; type?: unknown } | null }
      : null;
    const observed = { ref: body?.ref, type: body?.object?.type, sha: body?.object?.sha };
    if (
      body === null ||
      observed.ref !== expectedRef ||
      observed.type !== "commit" ||
      typeof observed.sha !== "string" ||
      !/^[0-9a-f]{40}$/.test(observed.sha)
    ) {
      return { kind: "contradicts", observed };
    }
    return { kind: "at", sha: observed.sha };
  }

  /**
   * GitHub's exact-ref read: the commit it names, an answered 404, an answer that is not exactly `expectedRef`
   * (#1161 BP-02: another name, another type or no commit id contradicts it), or nothing a decision may rest on.
   */
  private async readBranchRef(path: string, expectedRef: string): Promise<BranchRefObservation> {
    let answer: unknown;
    try {
      answer = await this.api().request<unknown>("GET", path);
    } catch (error) {
      const outcome = transportOutcome(error);
      if (outcome.outcome === "answered" && outcome.status === 404) return { kind: "missing" };
      return { kind: "unknown", ...outcome };
    }
    return this.refAnswer(answer, expectedRef);
  }

  /** A branch name as a ref path: each component escaped, the separators kept. */
  private refPathOf(branch: string): string {
    return branch.split("/").map((component) => encodeURIComponent(component)).join("/");
  }

  /** Absolute paths no publication may carry: the home directory, the ACP state root, every registered checkout. */
  private publicationForbiddenPaths(): string[] {
    const paths = [homedir(), ...this.repositories.list().map((repository) => repository.checkoutPath)];
    if (isAbsolute(this.db.file)) paths.push(dirname(this.db.file));
    return paths;
  }

  private recordBranchPublished(delivery: BranchDelivery, how: "CREATED" | "OBSERVED" | "RECONCILED"): void {
    this.audit.record({
      kind: "BRANCH_PUBLISHED",
      runId: delivery.input.runId,
      evidence: {
        repositoryIdentity: delivery.input.repositoryIdentity,
        ref: delivery.ref,
        sha: delivery.candidateHead,
        scanDigest: delivery.scanDigest,
        how,
      },
    });
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
      // FD-GATE — the replay is of this publication: its payload was found current above, and the gate
      // selected is the trusted one that carries exactly it, wherever GitHub lists it.
      const replay = await this.verifyGate(repositoryIdentity, payload.exactHead, payload.runId, (published) =>
        digestOf(published) === payloadDigest
          ? allow(ReasonCode.OK, undefined)
          : deny(ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID, "a trusted gate on this head carries another payload", {
            idempotencyKey,
          }));
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

    // FD-R2 (ROUND1-ESCAPE-PUBLISH) — the transport awaits its installation token after the check above,
    // so it checks the payload again once it holds the token, immediately before the POST.
    const dispatch = this.payloadBackedAtDispatch(payload, repositoryIdentity);
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
        // A correlator GitHub itself indexes. The payload digest already travels in `output.summary`
        // and is verified on re-read, but only ACP can find a check run by it; `external_id` is
        // queryable from the GitHub side, which is what a reconciliation after a daemon crash or a
        // dispute about which run published a gate actually needs.
        //
        // Verified on re-read below rather than merely sent. A field written and never read back is
        // decoration, and this file already carries the lesson: the gate does not trust its own POST
        // response either.
        external_id: gateExternalId(payload.runId, payload.candidateSnapshotDigest, payloadDigest),
        completed_at: this.clock.nowIso(),
        output: {
          title: "Agent Control Plane production gate",
          summary: `payloadDigest=${payloadDigest}`,
          text: JSON.stringify(payload, null, 2),
        },
      }, { beforeDispatch: dispatch.beforeDispatch }),
    );
    if (!created.allowed) {
      const refusedAtDispatch = dispatch.refused();
      if (refusedAtDispatch) {
        // Nothing was sent: the reservation goes, as the check above would have left none.
        this.releaseReservation(idempotencyKey, payloadDigest);
        return refusedAtDispatch as Decision<{ checkRunId: number }>;
      }
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
      // Checked only when GitHub returned one. The correlator grants no authority — the digest
      // does — so making publication depend on a field GitHub may stop echoing would put an
      // availability risk on the merge path in exchange for nothing. If it comes back, it must
      // be ours; if it does not, the digest comparison below is still what decides. Same limit as
      // at the merge boundary: a deleted correlator passes, and one recomputed from the payload
      // agrees by construction.
      (typeof reread.external_id === "string" &&
        reread.external_id !== gateExternalId(payload.runId, payload.candidateSnapshotDigest, payloadDigest)) ||
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
   * FD-R2 — the check the transport runs immediately before it sends a write that `payload` authorises
   * (the gate POST, the merge PUT): `assertGatePayloadBacked` again, because the installation token is
   * awaited after the kernel's own last check. `refused` reports whether that check refused, and
   * therefore that nothing was sent, so the write is not mistaken for one whose outcome is unknown.
   */
  private payloadBackedAtDispatch(
    payload: GatePayload,
    repositoryIdentity: string,
  ): { beforeDispatch: BeforeDispatch; refused: () => Decision<void> | null } {
    let refused: Decision<void> | null = null;
    return {
      beforeDispatch: () => {
        let verified: Decision<void>;
        try {
          verified = this.assertGatePayloadBacked(payload, repositoryIdentity);
        } catch {
          verified = deny(ReasonCode.INTERNAL_ERROR, "gate payload could not be re-verified before dispatch", {
            runId: payload.runId,
          });
        }
        refused = verified.allowed ? null : verified;
        return verified;
      },
      refused: () => refused,
    };
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
    const evaluated = await this.evaluateMerge(input);
    return evaluated.allowed ? allow(evaluated.reasonCode, { predicates: evaluated.value.predicates }) : evaluated;
  }

  /** `mergeEvaluate`, also naming the gate payload it selected, which `mergeExecute` re-verifies before it writes. */
  private async evaluateMerge(
    input: MergeInput,
  ): Promise<Decision<{ predicates: Record<string, boolean>; gate?: GatePayload }>> {
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
    // #1189 B5 — what GitHub already knows would refuse this merge refuses it here, before any reservation.
    // At the PUT the same refusal is an answered failure of an invoked effect, which leaves an unproven
    // PENDING merge and a run blocked as if it might have merged; here it is a candidate to send back.
    if (pull.mergeable === false) {
      return deny(ReasonCode.MERGE_CONFLICT, "GitHub reports that the pull request does not merge cleanly", {
        pullNumber: pull.number,
        exactHead: input.exactHeadSha,
        expectedBase: input.expectedBaseSha,
      });
    }
    const declaredChecks = await this.refuseFailedDeclaredChecks(input.runId, input.repositoryIdentity, pull.head.sha);
    if (!declaredChecks.allowed) return declaredChecks as Decision<{ predicates: Record<string, boolean> }>;
    // FD-GATE — the gate selected is the trusted one whose payload is backed by the current state, its
    // human-gate binding included, so a stale gate listed ahead of it cannot mask it.
    const gate = await this.verifyGate(input.repositoryIdentity, pull.head.sha, input.runId, (payload) =>
      this.assertGatePayloadBacked(payload, input.repositoryIdentity));
    if (!gate.allowed) return gate as Decision<{ predicates: Record<string, boolean> }>;

    // The gate payload was checked against local evidence when it was published; at merge
    // time that evidence must still be the run's current evidence.
    const stillBacked = this.assertGatePayloadBacked(gate.value, input.repositoryIdentity);
    if (!stillBacked.allowed) return stillBacked as Decision<{ predicates: Record<string, boolean> }>;

    return allow(ReasonCode.OK, {
      gate: gate.value,
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
    // #664 — deliberately plain `tx()`, not `txDecision`. The expiry sweep below is
    // unconditional housekeeping the decision only reads; it must survive every denial
    // in this body, so an opt-in rollback-on-denial would be a regression here, not a fix.
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
      let valid = onBranch.find(
        (r) =>
          r.status === "HELD" &&
          new Date(r.expires_at).getTime() > now &&
          r.owner_binding_generation === run?.ownerBindingGeneration,
      );
      // Owner directive 2026-10-20: once the CEO has confirmed, the owner's own branch claim
      // lapsing while the run waited is not a reason to stop finalization. Renew it when nobody
      // else holds the branch; the unique HELD-branch index still refuses a real conflict.
      if (!valid && run && FINALIZING_STATES.has(run.state)) {
        const lapsed = onBranch.find(
          (r) => r.status === "EXPIRED" && r.owner_binding_generation === run.ownerBindingGeneration,
        );
        const holder = this.db.get<{ claim_id: string }>(
          `SELECT claim_id FROM resource_claims WHERE repository_identity = ? AND branch = ? AND status = 'HELD'`,
          [repositoryIdentity, branch],
        );
        if (lapsed && !holder) {
          const renewedUntil = new Date(now + FINALIZATION_CLAIM_RENEWAL_MS).toISOString();
          this.db.run(
            `UPDATE resource_claims SET status = 'HELD', expires_at = ?, released_at = NULL WHERE claim_id = ?`,
            [renewedUntil, lapsed.claim_id],
          );
          this.audit.record({
            kind: "CLAIM_RENEWED_FOR_FINALIZATION",
            runId,
            reasonCode: ReasonCode.OK,
            evidence: { claimId: lapsed.claim_id, repositoryIdentity, branch, expiredAt: lapsed.expires_at, renewedUntil },
          });
          valid = { ...lapsed, status: "HELD", expires_at: renewedUntil };
        }
      }
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
   *
   * FD-GATE (CEO ef7fa698) — of the trusted gates, only one whose payload `selects` accepts is
   * returned: the payload the caller requires, judged against the current state. A head can carry a
   * trusted gate for a binding that no longer holds (the owner decided again after it was published)
   * beside the gate for the binding that holds now, and GitHub's listing order says nothing about which
   * is which, so the first trusted gate is not the answer, and neither is the newest. Gates that pass
   * `selects` each name the required state exactly (a retry's gate differs only in its timestamp), so
   * which of them is returned decides nothing. With no gate selected the refusal is the first trusted
   * gate's own `selects` refusal, never that gate.
   */
  private async verifyGate(
    repositoryIdentity: string,
    head: string,
    runId: string,
    selects: (payload: GatePayload) => Decision<void>,
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

    let unselected: Decision<void> | null = null;
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

      // The correlator must match the one our own publication receipt implies. GitHub stores
      // `external_id`, and a check run edited after publication can have it rewritten while the
      // digest in `output.summary` still reads correctly. The digest is what grants authority, so
      // a correlator that no longer derives from the receipt's payload means the run's GitHub side
      // was rewritten. Publication verifies its own POST and nothing re-reads the field afterwards,
      // so this is where a *mismatched* one is seen.
      //
      // Limit, because the sentence above reads like coverage and is not: this catches an
      // `external_id` that is still present and disagrees. It does not catch one that was deleted —
      // both comparisons skip when the field is absent, so silence passes — and it does not catch
      // one recomputed to agree, because the formula is deterministic from values inside the
      // payload and anyone holding it can reproduce the string. It is a consistency label, not a
      // MAC. Authority is the digest's, which is why the skip-when-absent behaviour is correct
      // rather than a gap to close here.
      //
      // Derived from the stored receipt rather than from current state: recomputing from the live
      // candidate would fold in a freshness judgement that belongs to the checks above.
      const receiptForDigest = digest ? published.find((row) => row.after_state_digest === digest) : undefined;
      const expectedExternalId = (() => {
        if (!receiptForDigest || !digest) return null;
        try {
          const stored = JSON.parse(receiptForDigest.response_json) as { payload?: GatePayload };
          return stored.payload
            ? gateExternalId(stored.payload.runId, stored.payload.candidateSnapshotDigest, digest)
            : null;
        } catch {
          return null;
        }
      })();
      if (check.external_id && expectedExternalId && check.external_id !== expectedExternalId) {
        this.audit.record({
          kind: "GATE_REJECTED",
          runId,
          reasonCode: ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID,
          evidence: {
            repositoryIdentity,
            head,
            checkRunId: check.id,
            observedExternalId: check.external_id,
            expectedExternalId,
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
      // Trusted, and still only a candidate: a gate for a binding that no longer holds is the daemon's
      // own and not forged, so it is passed over without a GATE_REJECTED record.
      const selected = selects(payload);
      if (!selected.allowed) {
        unselected ??= selected;
        continue;
      }
      return allow(ReasonCode.OK, payload);
    }

    if (unselected) return unselected as Decision<GatePayload>;
    return deny(
      ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID,
      "no production gate on this head was published by the trusted credential",
      { repositoryIdentity, head, observed: candidates.length },
    );
  }

  // -------------------------------------------------------------------------
  // merge_execute
  // -------------------------------------------------------------------------

  /**
   * #1189 B5 — settle a merge request this run already sent, by reading only. The pull is re-read and the
   * outcome it establishes is recorded: merged, the PENDING receipt is proven as `mergeExecute` proves it;
   * proven unmerged, nothing was applied and the reservation is released; a read that cannot tell keeps it
   * PENDING. No merge is requested from here: an unmerged pull is merged only by the ordinary path, after its
   * branch, pull request and gate have been published and validated again. `merged` is true only when a
   * receipt proves the merge; with no receipt there is nothing to settle.
   */
  async mergeSettle(input: MergeInput): Promise<Decision<{ merged: boolean }>> {
    const authority = this.assertAuthority(input.runId, input.repositoryIdentity, input);
    if (!authority.allowed) return authority as Decision<{ merged: boolean }>;
    const repositoryId = this.mergeRepositoryId(input.runId, input.repositoryIdentity);
    if (!repositoryId.allowed) return repositoryId as Decision<{ merged: boolean }>;
    const idempotencyKey = `merge_execute:${input.repositoryIdentity}:${input.pullNumber}`;
    const requestDigest = this.mergeRequestDigest(input);
    const existing = this.receipt(idempotencyKey);
    if (!existing) return allow(ReasonCode.OK, { merged: false });
    if (existing.request_digest !== requestDigest) {
      return deny(ReasonCode.RESOURCE_COLLISION, "merge resource is already bound to different operation intent", {
        idempotencyKey,
        existingRequestDigest: existing.request_digest,
        requestDigest,
      });
    }
    if (existing.verified) return allow(ReasonCode.OK, { merged: true });
    const settled = await this.reconcilePendingMerge(input, repositoryId.value, idempotencyKey, requestDigest);
    if (settled === null) return allow(ReasonCode.OK, { merged: false });
    return settled.allowed ? allow(settled.reasonCode, { merged: true }) : settled as Decision<{ merged: boolean }>;
  }

  private mergeRequestDigest(input: MergeInput): string {
    return digestOf({
      runId: input.runId,
      repositoryIdentity: input.repositoryIdentity,
      pullNumber: input.pullNumber,
      exactHeadSha: input.exactHeadSha,
      expectedBaseSha: input.expectedBaseSha,
      mergeStrategy: input.mergeStrategy,
      ownerBindingGeneration: input.ownerBindingGeneration,
    });
  }

  /**
   * The re-read of a pull whose merge receipt is still PENDING, recording only what that read establishes:
   * merged, the receipt is proven (or its proof failure recorded); a read that cannot tell keeps it PENDING.
   * `null` means the pull is proven unmerged and its reservation released; nothing is sent to GitHub here.
   */
  private async reconcilePendingMerge(
    input: MergeInput,
    mergeRepositoryId: string,
    idempotencyKey: string,
    requestDigest: string,
    carryNotes = false,
  ): Promise<Decision<{ mergeCommitSha: string; replayed: boolean }> | null> {
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
    } catch (error) {
      const unavailable = deny(ReasonCode.PROBE_FAILED, "pending merge pull could not be re-read", {
        pullNumber: input.pullNumber,
        phase: "reconcile-pull",
        ...transportOutcome(error),
      });
      this.recordPendingMergeProofFailure(input, mergeRepositoryId, idempotencyKey, null, unavailable);
      return unavailable as Decision<{ mergeCommitSha: string; replayed: boolean }>;
    }
    const observedMerged = (pull as unknown as { merged?: unknown }).merged;
    if (observedMerged === false) {
      // The pull is still open, so the reserved PUT did not merge it: nothing was applied, and the stale
      // reservation is released. Whether a merge is requested again is the caller's decision.
      this.releaseReservation(idempotencyKey, requestDigest);
      return null;
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
      if (this.keepsMergeProofPending(prepared)) {
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
      input.exactHeadSha,
      this.githubMergeMethod(input.mergeStrategy),
    );
    if (!proof.allowed) {
      if (this.keepsMergeProofPending(proof)) {
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
    // #1269 — the notes are written only on the merge path; a settle reads them and never writes.
    const notesTarget = carryNotes ? this.writeTarget(input.runId, input.repositoryIdentity, prepared.value.head) : null;
    const notes = notesTarget && !notesTarget.allowed
      ? notesTarget
      : await this.carryCandidateNotes(input, slug.value.owner, slug.value.repo, notesTarget?.value ?? null);
    if (!notes.allowed) {
      this.recordPendingMergeProofFailure(input, mergeRepositoryId, idempotencyKey, observedMergeCommitSha, notes);
      return notes as Decision<{ mergeCommitSha: string; replayed: boolean }>;
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
    const requestDigest = this.mergeRequestDigest(input);
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
        const settled = await this.reconcilePendingMerge(input, mergeRepositoryId, idempotencyKey, requestDigest, true);
        // Proven unmerged after reclaiming the stale crash-era reservation: the merge is evaluated and sent again.
        return settled ?? this.mergeExecute(input);
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

    const evaluation = await this.evaluateMerge(input);
    if (!evaluation.allowed) return evaluation as Decision<{ mergeCommitSha: string; replayed: boolean }>;
    const selectedGate = evaluation.value.gate;
    if (!selectedGate) {
      return deny(ReasonCode.INTERNAL_ERROR, "merge evaluation named no gate payload to re-verify", {
        runId: input.runId,
        repositoryIdentity: input.repositoryIdentity,
      });
    }

    const slug = this.slug(input.repositoryIdentity);
    if (!slug.allowed) return slug as Decision<{ mergeCommitSha: string; replayed: boolean }>;
    const { owner, repo } = slug.value;

    if (input.mergeStrategy !== "merge_commit") {
      // #1269 — pull requests merge only as merge commits. A contract naming squash, rebase or fast-forward
      // predates that rule; it is refused here, before anything is sent, and never mapped onto another
      // method. #1189 B5 — the one refusal the finalizer ends a run FAILED for, and only on this read's
      // confirmation that the pull request is not merged: no receipt alone proves that nothing was applied.
      let pullMerged: boolean | null = null;
      try {
        const observed = await this.api().request<unknown>("GET", `/repos/${owner}/${repo}/pulls/${input.pullNumber}`);
        const flag = (observed as { merged?: unknown } | null)?.merged;
        pullMerged = typeof flag === "boolean" ? flag : null;
      } catch {
        pullMerged = null;
      }
      return deny(
        ReasonCode.MERGE_BRANCH_PROFILE_UNSATISFIED,
        "pull requests merge only as merge commits; the pinned contract must be migrated by a contract change",
        { mergeStrategy: input.mergeStrategy, pullNumber: input.pullNumber, pullMerged },
      );
    }
    const method = "merge";

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

    // #1269 — the merge commit's tree is the verified head's tree only when the head already contains the
    // base. A head that does not would merge into a tree no verification saw, so it goes back for a new
    // candidate rather than being merged; read before the reservation, so a refusal leaves nothing reserved.
    const contained = await this.assertHeadContainsBase(owner, repo, input.expectedBaseSha, input.exactHeadSha);
    if (!contained.allowed) return contained as Decision<{ mergeCommitSha: string; replayed: boolean }>;

    const target = this.writeTarget(input.runId, input.repositoryIdentity, preflight.head.ref);
    if (!target.allowed) return target as Decision<{ mergeCommitSha: string; replayed: boolean }>;

    // FD-R1-RACE — the evaluation above was followed by awaited reads (the preflight and the base-in-head
    // compare), and an owner decision or a new candidate can land during
    // any of them. So the selected gate's payload is verified again here, after the last await: its
    // evidence still backs the current candidate and its human-gate binding is the one the owner's
    // current decisions resolve to. Nothing is awaited between this check and the client's request
    // call (the reservation and the guard's authorisation are synchronous up to the effect). The
    // production transport then awaits its installation token, so it runs the same check again
    // after that await, immediately before the PUT (FD-R2, below). The check and GitHub's merge are
    // still two steps, not one atomic one.
    const stillCurrent = this.assertGatePayloadBacked(selectedGate, input.repositoryIdentity);
    if (!stillCurrent.allowed) return stillCurrent as Decision<{ mergeCommitSha: string; replayed: boolean }>;

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
    const dispatch = this.payloadBackedAtDispatch(selectedGate, input.repositoryIdentity);
    // #1189 B5 — the guard reports a failed effect without its error, so whether GitHub answered the PUT, and
    // with what status, is kept here.
    const put: { failure: { outcome: TransportOutcome; status?: number } | null } = { failure: null };
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
        { beforeDispatch: dispatch.beforeDispatch },
      ).catch((error: unknown) => {
        put.failure = transportOutcome(error);
        throw error;
      }),
    );
    if (!merged.allowed) {
      const refusedAtDispatch = dispatch.refused();
      if (refusedAtDispatch) {
        // Nothing was sent: the reservation goes, as the check above would have left none.
        this.releaseReservation(idempotencyKey, requestDigest);
        return refusedAtDispatch as Decision<{ mergeCommitSha: string; replayed: boolean }>;
      }
      if (merged.evidence["effectInvoked"] !== true) {
        this.releaseReservation(idempotencyKey, requestDigest);
      } else {
        // The fenced effect ran but did not yield a proveable acknowledgement. Preserve the
        // PENDING row for recovery while making the run fail closed now.
        this.markMergeUnproven(input, mergeRepositoryId, idempotencyKey);
        // INTERNAL_ERROR is the guard's answer when the effect itself failed with its fence intact.
        if (put.failure && merged.reasonCode === ReasonCode.INTERNAL_ERROR &&
            (put.failure.outcome === "unheard" || (put.failure.status ?? 0) >= 400)) {
          // #1189 B5 — the request was sent and came back with an error status (a 405 included) or with
          // nothing: whether it merged is unknown, and the PENDING receipt holds it. Recorded so the
          // finalizer keeps the run MERGING, where the next attempt's merge step reconciles that receipt
          // (re-reading the pull before any second PUT), instead of blocking it as merged. A redirect is
          // not among them: the transport refuses to follow it, and the run fails closed as before.
          this.audit.record({
            kind: "MERGE_OUTCOME_UNKNOWN",
            runId: input.runId,
            reasonCode: merged.reasonCode,
            evidence: {
              repositoryIdentity: input.repositoryIdentity,
              pullNumber: input.pullNumber,
              exactHead: input.exactHeadSha,
              phase: "merge-put",
              ...put.failure,
            },
          });
          return deny(merged.reasonCode, merged.message, { ...merged.evidence, phase: "merge-put", ...put.failure });
        }
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
    } catch (error) {
      const unproven = deny(
        ReasonCode.PROBE_FAILED,
        "merged pull request could not be re-read for base proof",
        {
          ...transportOutcome(error),
          pullNumber: input.pullNumber,
          mergeCommitSha,
          phase: "postflight-pull",
        },
      );
      // Consult the classification here too (#533). This site recorded PENDING unconditionally,
      // so an answered failure stayed reconcilable even once the branches below started asking.
      // A guard that only some paths reach is one path's property, not the kernel's.
      if (this.keepsMergeProofPending(unproven)) {
        this.recordPendingMergeProofFailure(input, mergeRepositoryId, idempotencyKey, mergeCommitSha, unproven);
      } else {
        this.recordMergeProofFailure(input, mergeRepositoryId, idempotencyKey, mergeCommitSha, unproven);
      }
      return unproven as Decision<{ mergeCommitSha: string; replayed: boolean }>;
    }
    const proof = await this.assertExecutedMergeProof(
      owner,
      repo,
      postflight,
      prepared.value,
      mergeCommitSha,
      input.expectedBaseSha,
      input.exactHeadSha,
      method,
    );
    if (!proof.allowed) {
      if (this.keepsMergeProofPending(proof)) {
        this.recordPendingMergeProofFailure(input, mergeRepositoryId, idempotencyKey, mergeCommitSha, proof);
      } else {
        this.recordMergeProofFailure(input, mergeRepositoryId, idempotencyKey, mergeCommitSha, proof);
      }
      return proof as Decision<{ mergeCommitSha: string; replayed: boolean }>;
    }
    const notes = await this.carryCandidateNotes(input, owner, repo, target.value);
    if (!notes.allowed) {
      this.recordPendingMergeProofFailure(input, mergeRepositoryId, idempotencyKey, mergeCommitSha, notes);
      return notes as Decision<{ mergeCommitSha: string; replayed: boolean }>;
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

  /**
   * #1269 — the candidate's CommitLore notes, on the remote. A merge commit keeps the branch's commits, but
   * their notes travel only on `refs/notes/commitlore`, which no merge moves. Every note the registered
   * checkout holds for a commit of base..head must be on the remote ref as the same blob. With a `target`,
   * the missing ones are written through the Git Data API (their blobs, a tree on the remote notes tree, a
   * commit on the remote notes commit, then a fast-forward of the ref); without one nothing is written. The
   * ref is then read back. A remote note that differs is never overwritten, and every failure is a refusal
   * the caller records as a pending proof failure.
   */
  private async carryCandidateNotes(
    input: MergeInput,
    owner: string,
    repo: string,
    target: GitHubWriteTarget | null,
  ): Promise<Decision<{ notes: number }>> {
    const refused = (message: string, evidence: Record<string, unknown> = {}) =>
      deny<{ notes: number }>(ReasonCode.EVIDENCE_MISSING, message, { phase: "postflight-notes", ref: NOTES_REF, ...evidence });
    const checkout = this.repositories.byIdentity(input.repositoryIdentity)?.checkoutPath;
    if (!checkout) return refused("the candidate's checkout is not registered, so its notes cannot be read");
    const text = async (args: readonly string[]) => (await gitBytes(checkout, args)).stdout.toString("utf8");
    const owed: Array<{ object: string; blob: string }> = [];
    try {
      if ((await text(["for-each-ref", "--format=%(objectname)", NOTES_REF])).trim() !== "") {
        const listed = new Map((await text(["notes", `--ref=${NOTES_REF}`, "list"])).split("\n").filter(Boolean)
          .map((line) => [line.split(" ")[1], line.split(" ")[0]] as const));
        for (const object of (await text(["rev-list", `${input.expectedBaseSha}..${input.exactHeadSha}`])).split("\n").filter(Boolean)) {
          const blob = listed.get(object);
          if (blob) owed.push({ object, blob });
        }
      }
    } catch {
      return refused("the candidate's CommitLore notes could not be read from its checkout");
    }
    if (owed.length === 0) return allow(ReasonCode.OK, { notes: 0 });

    const before = await this.remoteNotes(owner, repo);
    if (!before.allowed) return before as Decision<{ notes: number }>;
    const differing = owed.filter((note) => before.value.notes.has(note.object) && before.value.notes.get(note.object) !== note.blob);
    if (differing.length > 0) {
      return refused("the remote carries a different note for a candidate commit, which is not overwritten", {
        objects: differing.map((note) => note.object),
      });
    }
    const missing = owed.filter((note) => !before.value.notes.has(note.object));
    if (missing.length > 0) {
      if (!target) return refused("the remote does not carry the candidate's notes", { objects: missing.map((note) => note.object) });
      let contents: Buffer[];
      try {
        contents = await Promise.all(missing.map(async (note) => (await gitBytes(checkout, ["cat-file", "blob", note.blob])).stdout));
      } catch {
        return refused("a candidate note could not be read from its checkout");
      }
      // The remote's own fan-out, so a note lands where git looks for it.
      const depth = (before.value.paths[0]?.split("/").length ?? 1) - 1;
      const pathOf = (object: string) =>
        [...Array.from({ length: depth }, (_, level) => object.slice(level * 2, level * 2 + 2)), object.slice(depth * 2)].join("/");
      const root = `/repos/${owner}/${repo}/git`;
      const written = await this.mediate(
        WriteOperation.PROGRAMMATIC_MERGE,
        input.runId,
        input.repositoryIdentity,
        target,
        input,
        async () => {
          for (const [index, note] of missing.entries()) {
            const blob = await this.api().request<{ sha?: unknown }>("POST", `${root}/blobs`, {
              content: contents[index]!.toString("base64"),
              encoding: "base64",
            });
            if (blob?.sha !== note.blob) throw new Error("GitHub answered another blob id for a note");
          }
          const tree = await this.api().request<{ sha?: unknown }>("POST", `${root}/trees`, {
            ...(before.value.tree ? { base_tree: before.value.tree } : {}),
            tree: missing.map((note) => ({ path: pathOf(note.object), mode: "100644", type: "blob", sha: note.blob })),
          });
          const commit = await this.api().request<{ sha?: unknown }>("POST", `${root}/commits`, {
            message: "Notes added by the control plane",
            tree: tree?.sha,
            parents: before.value.commit ? [before.value.commit] : [],
          });
          if (typeof commit?.sha !== "string") throw new Error("GitHub answered no notes commit");
          await (before.value.commit
            ? this.api().request("PATCH", `${root}/refs/notes/commitlore`, { sha: commit.sha, force: false })
            : this.api().request("POST", `${root}/refs`, { ref: NOTES_REF, sha: commit.sha }));
        },
      );
      if (!written.allowed) {
        return refused("the candidate's notes could not be written to the remote", { cause: written.reasonCode });
      }
    }

    const after = await this.remoteNotes(owner, repo);
    if (!after.allowed) return after as Decision<{ notes: number }>;
    const absent = owed.filter((note) => after.value.notes.get(note.object) !== note.blob);
    if (absent.length > 0) {
      return refused("reading the remote notes back does not find every candidate note", { objects: absent.map((note) => note.object) });
    }
    return allow(ReasonCode.OK, { notes: owed.length });
  }

  /** The remote `refs/notes/commitlore`: its commit, tree and notes (object -> blob), or none. */
  private async remoteNotes(owner: string, repo: string): Promise<Decision<{
    commit: string | null;
    tree: string | null;
    paths: string[];
    notes: Map<string, string>;
  }>> {
    const unreadable = (message: string) =>
      deny<{ commit: string | null; tree: string | null; paths: string[]; notes: Map<string, string> }>(
        ReasonCode.EVIDENCE_MISSING, message, { phase: "postflight-notes", ref: NOTES_REF });
    const ref = await this.readBranchRef(`/repos/${owner}/${repo}/git/ref/notes/commitlore`, NOTES_REF);
    if (ref.kind === "missing") return allow(ReasonCode.OK, { commit: null, tree: null, paths: [], notes: new Map() });
    if (ref.kind !== "at") return unreadable("the remote notes ref could not be read");
    try {
      const commit = await this.api().request<{ tree?: { sha?: unknown } }>("GET", `/repos/${owner}/${repo}/git/commits/${ref.sha}`);
      const tree = commit?.tree?.sha;
      if (typeof tree !== "string") return unreadable("the remote notes commit names no tree");
      const listed = await this.api().request<{ tree?: unknown; truncated?: unknown }>(
        "GET",
        `/repos/${owner}/${repo}/git/trees/${tree}?recursive=1`,
      );
      if (!Array.isArray(listed?.tree) || listed.truncated !== false) return unreadable("the remote notes tree did not come back whole");
      const blobs = (listed.tree as Array<{ path?: unknown; type?: unknown; sha?: unknown }>)
        .filter((entry) => entry?.type === "blob" && typeof entry.path === "string" && typeof entry.sha === "string");
      const paths = blobs.map((entry) => entry.path as string);
      const notes = new Map(blobs.map((entry) => [(entry.path as string).replaceAll("/", ""), entry.sha as string]));
      return allow(ReasonCode.OK, { commit: ref.sha, tree, paths, notes });
    } catch {
      return unreadable("the remote notes could not be read");
    }
  }

  /**
   * The shape a merge's proof expects. Only `merge` is ever sent (#1269); `squash` and `rebase` remain so a
   * receipt a contract of that strategy left PENDING is still proven against what that request did.
   */
  private githubMergeMethod(strategy: BranchProfile["mergeStrategy"]): "merge" | "squash" | "rebase" {
    if (strategy === "squash") return "squash";
    if ((strategy as string) === "rebase") return "rebase";
    return "merge";
  }

  /** #1269 — the head merges only if it already contains the base, so the merge commit's tree is its tree. */
  private async assertHeadContainsBase(
    owner: string,
    repo: string,
    expectedBaseSha: string,
    exactHeadSha: string,
  ): Promise<Decision<void>> {
    let status: unknown;
    try {
      const compared = await this.api().request<{ status?: unknown } | null>(
        "GET",
        `/repos/${owner}/${repo}/compare/${expectedBaseSha}...${exactHeadSha}`,
      );
      status = compared?.status;
    } catch (error) {
      return deny(ReasonCode.PROBE_FAILED, "whether the head contains the base could not be read", {
        expectedBase: expectedBaseSha,
        exactHead: exactHeadSha,
        phase: "preflight-compare",
        ...transportOutcome(error),
      });
    }
    if (status === "ahead" || status === "identical") return allow(ReasonCode.OK, undefined);
    return deny(ReasonCode.MERGE_BASE_STALE, "the head does not contain the base it would merge into; a new candidate must be verified", {
      expectedBase: expectedBaseSha,
      exactHead: exactHeadSha,
      observed: typeof status === "string" ? status : null,
      phase: "preflight-compare",
    });
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
    exactHeadSha: string,
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
    } catch (error) {
      return deny(ReasonCode.PROBE_FAILED, "merged target ref could not be re-read", {
        pullNumber: pull.number,
        baseRef: pull.base.ref,
        phase: "postflight-target-ref",
        ...transportOutcome(error),
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
    return this.assertMergedOntoBase(owner, repo, mergeCommitSha, expectedBaseSha, exactHeadSha, method);
  }

  /**
   * §24.6 — the merge commit's first-parent chain must reach the base the run evaluated. For a merge or
   * squash the first parent *is* the base tip; a rebase produces a chain of rebased commits ending at it,
   * so the chain is walked. Only `merge` is sent (#1269); squash and rebase remain for a receipt such a
   * contract left PENDING.
   *
   * #1269 — a merge commit is then read back as exactly the commit it should be: its second and last
   * parent is the exact head, so the head stays an ancestor, and its tree is the head's own tree, which
   * the merge's tree must be because the head was checked to contain the base before the request.
   */
  private async assertMergedOntoBase(
    owner: string,
    repo: string,
    mergeCommitSha: string,
    expectedBaseSha: string,
    exactHeadSha: string,
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
      if (first === expectedBaseSha) {
        return method === "merge"
          ? this.assertHeadMergedAsItself(owner, repo, mergeCommitSha, commit, exactHeadSha)
          : allow(ReasonCode.OK, undefined);
      }
      if (method !== "rebase") break;
      sha = first;
    }
    return deny(
      ReasonCode.MERGE_BASE_STALE,
      "the merge did not land on the base the run's evidence was bound to",
      { mergeCommitSha, expected: expectedBaseSha, observed: observedFirstParent, walked },
    );
  }

  /** #1269 — the merge commit's second and last parent is the exact head, and its tree is the head's. */
  private async assertHeadMergedAsItself(
    owner: string,
    repo: string,
    mergeCommitSha: string,
    merged: unknown,
    exactHeadSha: string,
  ): Promise<Decision<void>> {
    const parents = (merged as { parents?: unknown[] }).parents ?? [];
    const second = (parents[1] as { sha?: unknown } | null | undefined)?.sha;
    if (parents.length !== 2 || second !== exactHeadSha) {
      return deny(ReasonCode.MERGE_BASE_STALE, "the merge commit's parents are not the evaluated base and the exact head", {
        mergeCommitSha,
        expected: exactHeadSha,
        observed: typeof second === "string" ? second : null,
        parentCount: parents.length,
        phase: "postflight-merge-parents",
      });
    }
    const head = await this.api()
      .request<unknown>("GET", `/repos/${owner}/${repo}/commits/${exactHeadSha}`)
      .catch(() => null);
    const treeOf = (commit: unknown): string | null => {
      const tree = (commit as { commit?: { tree?: { sha?: unknown } } } | null)?.commit?.tree?.sha;
      return typeof tree === "string" && tree.trim() !== "" ? tree : null;
    };
    if (!head) {
      return deny(ReasonCode.PROBE_FAILED, "the merged head could not be re-read", {
        mergeCommitSha,
        at: exactHeadSha,
        phase: "postflight-merge-tree",
      });
    }
    const mergedTree = treeOf(merged);
    const headTree = treeOf(head);
    if (!mergedTree || !headTree) {
      return deny(ReasonCode.EVIDENCE_MISSING, "the merge commit or its head has no usable tree sha", {
        mergeCommitSha,
        phase: "postflight-merge-tree",
      });
    }
    if (mergedTree !== headTree) {
      return deny(ReasonCode.MERGE_BASE_STALE, "the merge commit's tree is not the exact head's tree", {
        mergeCommitSha,
        expected: headTree,
        observed: mergedTree,
        phase: "postflight-merge-tree",
      });
    }
    return allow(ReasonCode.OK, undefined);
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
  ): Promise<Decision<{ checks: Array<{ name: string; conclusion: string }>; noChecksDeclared?: true }>> {
    const slug = this.slug(repositoryIdentity);
    if (!slug.allowed) return slug as Decision<{ checks: Array<{ name: string; conclusion: string }> }>;
    const { owner, repo } = slug.value;

    // The required set comes from the project contract, not the caller: a caller-supplied
    // empty list would make this a vacuous PASS for any commit (§24.7).
    const resolved = this.declaredPostMergeChecks(runId, repositoryIdentity);
    if (!resolved.allowed) return resolved;
    const declared = resolved.value;
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
    // §24.7 — the commit under verification must be the one this run actually merged into
    // this repository. Otherwise an unrelated green commit could stand in for a red merge.
    const mergedHere = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM github_receipts
        WHERE operation = 'merge_execute' AND run_id = ? AND repository_identity = ?
          AND after_state_digest = ? AND status = 'APPLIED' AND verified = 1`,
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
      const cached = JSON.parse(existing.response_json) as { checks?: Array<{ name: string; conclusion: string }>; noChecksDeclared?: true };
      if (!Array.isArray(cached.checks) ||
          (effective.length === 0 && (cached.checks.length !== 0 || cached.noChecksDeclared !== true)) ||
          effective.some((name) => !cached.checks!.some((check) => check.name === name))) {
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
      return allow(ReasonCode.OK, effective.length === 0
        ? { checks: [], noChecksDeclared: true as const }
        : { checks: cached.checks });
    }

    const finalization = this.assertFreshDaemonFinalization(
      runId,
      daemonFinalizerAuthority,
      "post_merge_verify",
    );
    if (!finalization.allowed) return finalization as Decision<{ checks: Array<{ name: string; conclusion: string }> }>;

    if (effective.length === 0) {
      return this.db.tx(() => {
        const response = { checks: [], noChecksDeclared: true as const };
        this.writeReceipt({
          idempotencyKey,
          operation: "post_merge_verify",
          runId,
          repositoryIdentity,
          resourceType: "commit",
          resourceIdentity: `${owner}/${repo}@${mergeCommitSha}`,
          preexisting: false,
          beforeStateDigest: null,
          afterStateDigest: digestOf(response),
          requestDigest,
          response,
          reread: true,
        });
        this.setMergeState(runId, repositoryIdentity, "MERGED");
        this.audit.record({
          kind: "POST_MERGE_NO_CHECKS_DECLARED",
          runId,
          evidence: { repositoryIdentity, mergeCommitSha },
        });
        return allow(ReasonCode.OK, response);
      });
    }

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

    // #1189 B13 — the bounded wait ended with every failing check still missing or incomplete. That is
    // no answer: no receipt is written and the merge state stays pending, so dependent merges stay
    // blocked and a later lookup on this exact merge is not replayed as a failure. Every declared
    // check stays mandatory; anything that answered other than success is a FAIL below.
    if (failed.length > 0 && failed.every(isUnansweredPostMergeCheck)) {
      this.audit.record({
        kind: "POST_MERGE_CHECKS_INCOMPLETE",
        runId,
        reasonCode: ReasonCode.POST_MERGE_CHECKS_INCOMPLETE,
        evidence: { repositoryIdentity, mergeCommitSha, incomplete: failed },
      });
      return deny(
        ReasonCode.POST_MERGE_CHECKS_INCOMPLETE,
        "post-merge checks were still missing or incomplete when the bounded wait ended; dependent merges stay blocked",
        { mergeCommitSha, incomplete: failed },
      );
    }

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
      const transientOnly = failed.length > 0 && failed.every(isUnansweredPostMergeCheck);
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
      // Provenance names the producer, not the outcome. A successful job inside an approved run that
      // failed or has not finished is not a successful check, and gets the same refusal as unproven
      // provenance.
      if (trusted.allowed) return { name, conclusion: actionsRunSucceeded(trusted.value) ? "success" : "untrusted" };
      // "untrusted" says a check could not be believed and not why, which for the two causes
      // here points in opposite directions: bad provenance is a check somebody may have staged,
      // while an unapproved workflow is a manifest that never recorded a digest (#527). Both are
      // refusals; only one of them is anybody's fault. Carrying the distinction into the
      // conclusion is what puts it in the receipt and in the deny evidence an operator reads.
      return {
        name,
        conclusion: trusted.reasonCode === ReasonCode.VERIFICATION_CI_WORKFLOW_NOT_APPROVED
          ? "unapproved"
          : "untrusted",
      };
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
  postMergeVerificationInputs(runId: string, repositoryIdentity: string): Decision<readonly string[]> {
    return this.declaredPostMergeChecks(runId, repositoryIdentity);
  }

  /**
   * #1189 B5 — a check the pinned manifest declares for this repository that GitHub Actions already concluded
   * as failure on the head being merged refuses the merge, before any reservation: post-merge verification
   * would refuse the same check only after an irreversible merge. Per declared name only the newest Actions
   * run counts, so a re-run that passed is not refused; a pending or absent check refuses nothing here. A
   * manifest this cannot resolve is left to post-merge verification, which refuses it as before.
   */
  private async refuseFailedDeclaredChecks(runId: string, repositoryIdentity: string, head: string): Promise<Decision<void>> {
    const declared = this.declaredPostMergeChecks(runId, repositoryIdentity);
    if (!declared.allowed) return allow(ReasonCode.OK, undefined);
    for (const name of declared.value) {
      const listed = await this.listCheckRuns(repositoryIdentity, head, name);
      if (!listed.allowed) return listed as Decision<void>;
      const newest = listed.value
        .filter((check) => check.name === name && check.head_sha === head && check.app?.slug === "github-actions")
        .reduce<CheckRun | null>((latest, check) => (latest === null || check.id > latest.id ? check : latest), null);
      if (newest?.status === "completed" && newest.conclusion === "failure") {
        return deny(ReasonCode.MERGE_CHECK_FAILED, "a check the pinned manifest declares failed on the head being merged", {
          repositoryIdentity,
          head,
          name,
          checkRunId: newest.id,
          conclusion: newest.conclusion,
        });
      }
    }
    return allow(ReasonCode.OK, undefined);
  }

  private declaredPostMergeChecks(runId: string, repositoryIdentity: string): Decision<string[]> {
    try {
      const run = this.runs.get(runId);
      const stored = run?.pinnedManifestDigest ? this.projects.manifest(run.pinnedManifestDigest) : null;
      const manifest = projectManifestSchema.safeParse(stored);
      const role = this.repositoryRoleInRun(runId, repositoryIdentity);
      if (!manifest.success || !role || !manifest.data.repositories.some((repository) => repository.role === role)) {
        return deny(ReasonCode.EVIDENCE_MISSING, "pinned post-merge manifest or repository role could not be resolved", {
          runId, repositoryIdentity,
        });
      }
      const fromWorkflows = manifest.data.ciWorkflows
        .filter((workflow) => workflow.repositoryRole === role)
        .map((workflow) => workflow.checkName);
      return allow(ReasonCode.OK, [...new Set([...fromWorkflows, ...manifest.data.postMergeCommands])]);
    } catch {
      return deny(ReasonCode.EVIDENCE_MISSING, "pinned post-merge manifest could not be read or parsed", {
        runId, repositoryIdentity,
      });
    }
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
    // #448: neither branch here is a digest disagreement — zero matches means no pinned
    // contract identifies this head at all, and more than one means the head cannot be
    // resolved to a single contract to compare against. Both are "could not compare",
    // reported the same way the CI-trust manifest lookup right below reports it.
    return matches.length === 1
      ? allow(ReasonCode.OK, matches[0]!)
      : deny(ReasonCode.CONTRACT_UNVERIFIED, "CI head does not resolve to exactly one pinned run contract", {
          repositoryIdentity,
          head,
          matchingRuns: matches,
        });
  }

  private pinnedManifest(runId: string): Decision<ProjectManifest> {
    const run = this.runs.get(runId);
    if (!run?.pinnedManifestDigest) {
      // #448: absent, not disagreeing — the same fact `branchProfile()` reports for the
      // PR-preparation path.
      return deny(ReasonCode.CONTRACT_UNVERIFIED, "run has no pinned manifest", { runId });
    }
    const manifest = this.projects.manifest(run.pinnedManifestDigest);
    return manifest
      ? allow(ReasonCode.OK, manifest)
      : deny(ReasonCode.CONTRACT_UNVERIFIED, "pinned manifest is not retrievable", {
          runId,
          pinnedManifestDigest: run.pinnedManifestDigest,
        });
  }

  /**
   * Trust an Actions check only after resolving the actual suite, Actions run and
   * workflow path. A check name and `github-actions` app slug are candidate-controlled
   * unless this chain proves the approved workflow at the exact commit produced it. It says
   * who produced the check, not that its run passed: see `actionsRunSucceeded`.
   */
  private async assertTrustedWorkflowCheck(
    runId: string,
    repositoryIdentity: string,
    head: string,
    check: CheckRun,
  ): Promise<Decision<ProvenActionsCheck>> {
    const manifest = this.pinnedManifest(runId);
    if (!manifest.allowed) return manifest as Decision<ProvenActionsCheck>;
    // Matched on role as well as name (#512): the digest below is read from this repository, so
    // an entry belonging to a different participant must not be the one it is compared against.
    const role = this.repositoryRoleInRun(runId, repositoryIdentity);
    const workflow = manifest.value.ciWorkflows.find(
      (entry) => entry.checkName === check.name && entry.repositoryRole === role,
    );
    // An unapproved first-activation workflow is refused here, and refused by name (#527). The
    // old code reached the same verdict through `!approvedDigest` and reported it as missing
    // provenance, which describes a candidate-controlled check rather than a manifest that
    // never stated a digest. Same answer, wrong cause — and the wrong cause is what an operator
    // acts on.
    if (workflow?.unapprovedFirstActivation) {
      return deny(
        ReasonCode.VERIFICATION_CI_WORKFLOW_NOT_APPROVED,
        "the pinned manifest declares this workflow unapproved, so its checks cannot be trusted CI",
        { checkRunId: check.id, checkName: check.name, path: workflow.path },
      );
    }
    return proveActionsCheckProvenance(this.api(), {
      head,
      check,
      workflow: workflow ?? null,
      root: () => {
        const slug = this.slug(repositoryIdentity);
        return slug.allowed
          ? allow(ReasonCode.OK, { root: `/repos/${slug.value.owner}/${slug.value.repo}`, ...slug.value })
          : (slug as Decision<never>);
      },
      workflowDigest: async ({ owner, repo }, path) => {
        const content = await this.workflowContentAtExactHead(repositoryIdentity, owner, repo, head, path);
        return content.allowed ? allow(ReasonCode.OK, sha256(content.value)) : (content as Decision<never>);
      },
    });
  }

  /**
   * A local checkout intentionally lags a remote merge. Prefer its exact object when it is
   * present, then read the same immutable file from GitHub at the merge SHA rather than
   * mistaking an absent local object for a different workflow.
   */
  /**
   * #246 B2-b — the sha256 of one file's exact bytes at an exact revision of a registered repository:
   * the merge commit a finalization verified, or, given a branch, the commit that branch names now,
   * resolved first so the bytes and the revision are one answer. Read the way post-merge provenance
   * reads a workflow (the local object if present, else GitHub at that SHA). Read-only; the caller
   * decides what a mismatch means.
   */
  async workflowDigestAt(
    repositoryIdentity: string,
    at: { sha: string } | { branch: string },
    path: string,
  ): Promise<Decision<{ revision: string; workflowDigest: string }>> {
    const slug = this.slug(repositoryIdentity);
    if (!slug.allowed) return slug as Decision<{ revision: string; workflowDigest: string }>;
    const { owner, repo } = slug.value;
    let revision: string;
    if ("sha" in at) {
      revision = at.sha;
    } else {
      try {
        const ref = await this.api().request<{ object?: { sha?: string } }>(
          "GET",
          `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(at.branch)}`,
        );
        const sha = ref?.object?.sha;
        if (typeof sha !== "string" || sha.trim() === "") {
          return deny(ReasonCode.PROBE_FAILED, "GitHub returned no commit for the branch", { repositoryIdentity, branch: at.branch });
        }
        revision = sha;
      } catch (error) {
        return deny(ReasonCode.PROBE_FAILED, "could not resolve the branch to an exact commit", {
          repositoryIdentity,
          branch: at.branch,
          ...transportOutcome(error),
        });
      }
    }
    const content = await this.workflowContentAtExactHead(repositoryIdentity, owner, repo, revision, path);
    if (!content.allowed) return content as Decision<{ revision: string; workflowDigest: string }>;
    return allow(ReasonCode.OK, { revision, workflowDigest: sha256(content.value) });
  }

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
    } catch (error) {
      return deny(
        ReasonCode.PROBE_FAILED,
        "could not read the exact workflow file for post-merge provenance",
        { repositoryIdentity, head, path, ...transportOutcome(error) },
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
          // A failed or unfinished approved run is attributed and reported with its conclusion; only
          // `trustedCiConclusion` decides whether that conclusion is a success.
          const trusted = await this.assertTrustedWorkflowCheck(run.value, identity, head, check);
          if (!trusted.allowed) continue;
          checks.push({
            commandId: check.name,
            repositoryIdentity: identity,
            head: check.head_sha,
            conclusion: trustedCiConclusion(check, trusted.value),
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
      // #448: absent, not disagreeing.
      return deny(ReasonCode.CONTRACT_UNVERIFIED, "run has no pinned manifest", { runId });
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
   * interpretation: the production gate resolves the human gate again for both publication and
   * merge (FIX-FINALIZER-DIGEST), and the payload must name its current binding exactly. A payload
   * named before a decision or the candidate changed names a binding that no longer exists.
   */
  private assertGatePayloadHumanGateStatus(payload: Pick<GatePayload, "runId" | "humanGateDigest">): Decision<void> {
    const port = this.humanGateStatusPort;
    if (!port) {
      return deny(ReasonCode.HUMAN_GATE_UNSATISFIED, "GitHub kernel has no human-gate status port", {
        runId: payload.runId,
      });
    }
    const status = port.humanGateStatus(payload.runId);
    if (!status.required) return allow(ReasonCode.OK, undefined);
    if (!status.satisfied) {
      const evidence = {
        runId: payload.runId,
        required: status.required,
        items: status.items,
        satisfied: status.satisfied,
      };
      return !status.satisfied && status.decideAgain && status.decideAgain.length > 0
        ? deny(ReasonCode.HUMAN_GATE_UNSATISFIED, OWNER_DECIDE_AGAIN_MESSAGE, {
          ...evidence,
          ...ownerDecideAgainEvidence(status.decideAgain),
        })
        : deny(ReasonCode.HUMAN_GATE_UNSATISFIED, "current human-gate status does not satisfy this payload", evidence);
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
        ORDER BY created_at DESC, rowid DESC`,
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

  /**
   * An unfinished merge proof stays PENDING only while the outcome is genuinely unknown (#533).
   *
   * `PROBE_FAILED` used to mean both "we were told 404" and "we heard nothing", and both kept the
   * proof reconcilable. An answered failure is an answer: leaving it pending invites a retry
   * against a far end that already decided, and postpones a verdict that exists.
   *
   * The classification travels in the denial's evidence because these callers hold a `Decision`,
   * not the exception — the classification is made at the `catch`, where the error still exists.
   */
  private keepsMergeProofPending(decision: Decision<unknown>): boolean {
    if (decision.allowed) return false;
    if (
      decision.reasonCode === ReasonCode.PROBE_FAILED &&
      (decision.evidence as { outcome?: unknown } | undefined)?.outcome === "answered"
    ) {
      return false;
    }
    return this.pendingReasonCode(decision.reasonCode);
  }

  private pendingReasonCode(reasonCode: ReasonCode): boolean {
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
    // #448: neither branch below has two values to compare — one side is simply absent.
    // CONTRACT_DIGEST_MISMATCH reads as "two digests were compared and disagree"; reporting
    // it here told a caller a comparison happened when the manifest was never produced.
    if (!run?.pinnedManifestDigest) {
      return deny(ReasonCode.CONTRACT_UNVERIFIED, "run has no pinned manifest for a GitHub decision", {
        runId,
      });
    }
    const manifest = this.projects.manifest(run.pinnedManifestDigest);
    if (!manifest?.branchProfile) {
      return deny(ReasonCode.CONTRACT_UNVERIFIED, "run's pinned manifest is unavailable", {
        runId,
        pinnedManifestDigest: run.pinnedManifestDigest,
      });
    }
    // #1269 — a stored contract written before the field existed reads as the default, a merge commit.
    return allow(ReasonCode.OK, { ...manifest.branchProfile, mergeStrategy: manifest.branchProfile.mergeStrategy ?? "merge_commit" });
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
        `SELECT operation, resource_identity, verified FROM github_receipts WHERE run_id = ? ORDER BY created_at, rowid`,
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

/** One approved Actions workflow: the check it reports and the SHA-256 its bytes were approved at. */
export interface ApprovedActionsWorkflow {
  path: string;
  checkName: string;
  approvedDigest: string;
}

/** GitHub's statuses for an Actions run that has not finished: a later read can still see it conclude. */
const ACTIONS_RUN_UNFINISHED: ReadonlySet<string> = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

/** A check the approved workflow's run produced, with that run's own state as GitHub reported it. */
export interface ProvenActionsCheck {
  workflowDigest: string;
  /** `completed` or one of `ACTIONS_RUN_UNFINISHED`; any other status is refused as provenance. */
  run: { status: string; conclusion: string | null };
}

/**
 * Provenance says which workflow run produced a check, never that the run passed. Every caller that
 * lets a check satisfy a requirement asks this as well: post-merge verification, the genesis CI
 * observation and merge, and trusted-CI evidence before it reports a success.
 */
const actionsRunSucceeded = (proven: ProvenActionsCheck): boolean =>
  proven.run.status === "completed" && proven.run.conclusion === "success";

/**
 * A proven check's conclusion as trusted-CI evidence. A check that finished without success keeps its
 * own conclusion. An unfinished check is `unknown`, which the verification engine records as pending.
 * A successful check is `success` only inside a run that succeeded: while its run is unfinished it is
 * `unknown`, and once the run has finished otherwise it takes the run's conclusion.
 */
const trustedCiConclusion = (check: CheckRun, proven: ProvenActionsCheck): CiCheck["conclusion"] => {
  if (check.status !== "completed" || !check.conclusion) return "unknown";
  if (check.conclusion !== "success") return check.conclusion as CiCheck["conclusion"];
  if (actionsRunSucceeded(proven)) return "success";
  if (proven.run.status !== "completed" || !proven.run.conclusion) return "unknown";
  return proven.run.conclusion as CiCheck["conclusion"];
};

/**
 * Trust an Actions check only after resolving the actual suite, Actions run and workflow path, at the
 * exact head, and the workflow file's digest at that head. A check name and `github-actions` app slug
 * are candidate-controlled: any workflow in the repository can report a check of any name, so only
 * this chain proves that the approved workflow produced it. Normal kernel merges, the bootstrap
 * genesis verification and the genesis merge all prove a check through this one function.
 *
 * The chain is the same whatever the run concluded, so a failed or unfinished run of the approved
 * workflow is attributed to it as well. The result carries the run's status and conclusion and does
 * not by itself let a check count as passed: see `actionsRunSucceeded`.
 */
export async function proveActionsCheckProvenance(
  client: GitHubClient,
  input: {
    head: string;
    check: CheckRun;
    workflow: { path: string; approvedDigest?: string | null } | null;
    /** The repository the check belongs to, resolved only once the check names a job and suite. */
    root: () => Decision<{ root: string; owner: string; repo: string }>;
    /** The digest of the workflow file's bytes at `head`, in the approval's own form. */
    workflowDigest: (target: { owner: string; repo: string }, path: string) => Promise<Decision<string>>;
  },
): Promise<Decision<ProvenActionsCheck>> {
  const { head, check, workflow } = input;
  if (!workflow?.approvedDigest || check.head_sha !== head || check.app?.slug !== "github-actions") {
    return deny(ReasonCode.GATE_CREATOR_UNTRUSTED, "check has no approved Actions workflow provenance", {
      checkRunId: check.id,
      checkName: check.name,
    });
  }
  const suiteId = check.check_suite?.id;
  const runIdFromUrl = /\/actions\/runs\/(\d+)\/job\/\d+/.exec(check.details_url ?? "")?.[1];
  const runId = Number(runIdFromUrl);
  if (!Number.isSafeInteger(check.id) || check.id < 1 || !Number.isSafeInteger(suiteId) || !suiteId || suiteId < 1 ||
      !Number.isSafeInteger(runId) || runId < 1) {
    return deny(ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID, "check does not identify an Actions job and suite", {
      checkRunId: check.id,
    });
  }
  const target = input.root();
  if (!target.allowed) return target as Decision<ProvenActionsCheck>;
  const { root, owner, repo } = target.value;
  try {
    type RepositoryIdentity = { id?: number; full_name?: string };
    const [suite, run] = await Promise.all([
      client.request<{ id?: number; repository?: RepositoryIdentity; head_sha: string; app?: { slug?: string } | null }>("GET", `${root}/check-suites/${suiteId}`),
      client.request<{ id?: number; repository?: RepositoryIdentity; check_suite_id?: number; head_sha: string; path?: string; status?: string; conclusion?: string | null }>(
        "GET",
        `${root}/actions/runs/${runId}`,
      ),
    ]);
    // details_url is only an integrator-supplied lookup hint. Prove the returned GitHub identities
    // and repository before attributing the check, whatever its run concluded.
    const repositoryName = `${owner}/${repo}`.toLowerCase();
    if (suite.id !== suiteId || run.id !== runId || run.check_suite_id !== suiteId ||
        !Number.isSafeInteger(suite.repository?.id) || (suite.repository?.id ?? 0) < 1 ||
        suite.repository?.id !== run.repository?.id ||
        suite.repository?.full_name?.toLowerCase() !== repositoryName ||
        run.repository?.full_name?.toLowerCase() !== repositoryName) {
      return deny(ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID, "Actions suite/run identity or repository differs from the check", { checkRunId: check.id });
    }
    // A run status GitHub does not document is refused rather than read as finished or as pending.
    const runStatus = run.status ?? "";
    if (
      suite.head_sha !== head ||
      suite.app?.slug !== "github-actions" ||
      run.head_sha !== head ||
      run.path !== workflow.path ||
      (runStatus !== "completed" && !ACTIONS_RUN_UNFINISHED.has(runStatus))
    ) {
      return deny(ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID, "Actions suite or run differs from the required check", {
        checkRunId: check.id,
        suiteHead: suite.head_sha,
        runHead: run.head_sha,
        runPath: run.path ?? null,
        runStatus: run.status ?? null,
      });
    }
    const digest = await input.workflowDigest({ owner, repo }, workflow.path);
    if (!digest.allowed) return digest as Decision<ProvenActionsCheck>;
    return digest.value === workflow.approvedDigest
      ? allow(ReasonCode.OK, { workflowDigest: digest.value, run: { status: runStatus, conclusion: run.conclusion ?? null } })
      : deny(ReasonCode.VERIFICATION_CI_WORKFLOW_DIGEST_MISMATCH, "Actions workflow differs from pinned approval", {
          checkRunId: check.id,
          expected: workflow.approvedDigest,
          observed: digest.value,
        });
  } catch (err) {
    return deny(ReasonCode.PROBE_FAILED, "could not resolve Actions provenance for check", {
      checkRunId: check.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** What the required checks at one head say, once each is proven against its approved workflow. */
export type ApprovedWorkflowChecks =
  | { state: "success" }
  | { state: "pending"; checkName: string }
  | { state: "refused"; checkName: string | null; reasonCode: ReasonCode; message: string };

/**
 * #246 genesis — the required checks of a bootstrap's approved workflows at an exact head, before any
 * project or run exists to pin a manifest: the reviewed PLAN supplies the workflows. Every check of a
 * required name must be completed, successful and proven by `proveActionsCheckProvenance`, inside an
 * approved run that succeeded; a same-name check from any other workflow or app, a failed lane or run,
 * or a check that cannot be proven refuses. A name with no check yet, or one whose check or run is
 * still running, is pending. Reads only.
 */
export async function observeApprovedWorkflowChecks(
  client: GitHubClient,
  input: { root: string; owner: string; repo: string; head: string; workflows: readonly ApprovedActionsWorkflow[]; requiredChecks?: readonly string[] },
): Promise<ApprovedWorkflowChecks> {
  if (input.workflows.length === 0) {
    return { state: "refused", checkName: null, reasonCode: ReasonCode.VERIFICATION_GAP, message: "no approved workflow is required" };
  }
  let pending: string | null = null;
  const required = [...new Set([...input.workflows.map(workflow => workflow.checkName), ...(input.requiredChecks ?? [])])];
  for (const checkName of required) {
    // Post-merge commands are check names too. They must come from an approved workflow, even
    // when that workflow declares another primary check name in the manifest.
    const workflows = input.workflows.filter(workflow => workflow.checkName === checkName);
    const approved = workflows.length > 0 ? workflows : input.workflows;
    const checks: CheckRun[] = [];
    for (let page = 1; ; page += 1) {
      if (page > 10) {
        return { state: "refused", checkName, reasonCode: ReasonCode.PROBE_FAILED, message: "check-run enumeration exceeded its bound" };
      }
      const query = new URLSearchParams({ check_name: checkName, per_page: "100", page: String(page) });
      const listed = await client.request<{ check_runs?: CheckRun[] }>(
        "GET",
        `${input.root}/commits/${encodeURIComponent(input.head)}/check-runs?${query.toString()}`,
      );
      const runs = listed.check_runs ?? [];
      checks.push(...runs);
      if (runs.length < 100) break;
    }
    const matching = checks.filter((check) => check.name === checkName);
    if (matching.some(check => !["queued", "in_progress", "completed", "waiting", "requested", "pending"].includes(check.status))) {
      return { state: "refused", checkName, reasonCode: ReasonCode.VERIFICATION_GAP, message: "a required check has an unknown status" };
    }
    if (matching.some((check) => check.status === "completed" && check.conclusion !== "success")) {
      return { state: "refused", checkName, reasonCode: ReasonCode.VERIFICATION_GAP, message: "a required check failed at this head" };
    }
    if (matching.length === 0) {
      pending ??= checkName;
      continue;
    }
    for (const check of matching) {
      let proven: Decision<ProvenActionsCheck> = deny(ReasonCode.VERIFICATION_GAP, "check has no approved workflow provenance");
      for (const approvedWorkflow of approved) {
        proven = await proveActionsCheckProvenance(client, {
          head: input.head,
          check,
          workflow: approvedWorkflow,
          root: () => allow(ReasonCode.OK, { root: input.root, owner: input.owner, repo: input.repo }),
          workflowDigest: async (_target, path) => {
            const encoded = path.split("/").map(encodeURIComponent).join("/");
            const file = await client.request<{ type?: string; encoding?: string; content?: string }>(
              "GET",
              `${input.root}/contents/${encoded}?ref=${encodeURIComponent(input.head)}`,
            );
            if ((file.type !== undefined && file.type !== "file") || file.encoding !== "base64" || typeof file.content !== "string") {
              return deny(ReasonCode.PROBE_FAILED, "GitHub did not return the exact workflow file", { path, head: input.head });
            }
            // Approved over the file's exact bytes, as the genesis bundle's SHA-256 is.
            return allow(ReasonCode.OK, sha256(Buffer.from(file.content.replace(/\s/g, ""), "base64")));
          },
        });
        if (proven.allowed) break;
      }
      if (!proven.allowed) {
        return { state: "refused", checkName, reasonCode: proven.reasonCode, message: proven.message };
      }
      // Provenance names the producer, not the outcome: the approved run must itself succeed. A run
      // still finishing is the one difference a later read can clear.
      if (ACTIONS_RUN_UNFINISHED.has(proven.value.run.status)) {
        pending ??= checkName;
        continue;
      }
      if (!actionsRunSucceeded(proven.value)) {
        return { state: "refused", checkName, reasonCode: ReasonCode.VERIFICATION_GAP, message: "a required check's approved workflow run did not succeed at this head" };
      }
      if (check.status !== "completed") pending ??= checkName;
    }
  }
  return pending === null ? { state: "success" } : { state: "pending", checkName: pending };
}

/** Bootstrap has no activated project yet. Its reviewed PLAN supplies this narrowly scoped
 * merge contract; it uses the same GitHub client, exact-head merge API, parent proof and Actions
 * workflow provenance as normal kernel merges. The caller persists intent before entry and
 * reconciles the PR after. */
export async function mergeBootstrapGenesis(client:GitHubClient, input:{owner:string;repo:string;pullNumber:number;headSha:string;baseSha:string;workflows:readonly ApprovedActionsWorkflow[]}):Promise<void> {
  const root = `/repos/${input.owner}/${input.repo}`;
  const requiredChecks = input.workflows.map(workflow => workflow.checkName);
  const pull = await client.request<{state:string;merged:boolean;head:{ref:string;sha:string;repo:{full_name:string}};base:{ref:string;sha:string};merge_commit_sha:string|null}>("GET",`${root}/pulls/${input.pullNumber}`);
  if (pull.head.ref !== "genesis" || pull.head.sha !== input.headSha || pull.base.ref !== "main" || pull.head.repo.full_name.toLowerCase() !== `${input.owner}/${input.repo}`.toLowerCase()) throw new Error("genesis merge target/head drift");
  let mergeSha = pull.merge_commit_sha;
  if (!pull.merged) {
    if (pull.state !== "open" || pull.base.sha !== input.baseSha) throw new Error("genesis merge base drift");
    const protection = await client.request<{allow_force_pushes:{enabled:boolean};allow_deletions:{enabled:boolean};enforce_admins:{enabled:boolean};required_status_checks:{strict:boolean;contexts:string[]}}>("GET",`${root}/branches/main/protection`);
    if (protection.allow_force_pushes?.enabled !== false || protection.allow_deletions?.enabled !== false || protection.enforce_admins?.enabled !== true || protection.required_status_checks?.strict !== true || canonicalCheckNames(protection.required_status_checks.contexts) !== canonicalCheckNames(requiredChecks)) throw new Error("genesis main protection drift");
    const checks = await observeApprovedWorkflowChecks(client, { root, owner: input.owner, repo: input.repo, head: input.headSha, workflows: input.workflows });
    if (checks.state !== "success") throw new Error("genesis exact-head CI refused");
    const ref = await client.request<{object:{sha:string}}>("GET",`${root}/git/ref/heads/main`);
    if (ref.object.sha !== input.baseSha) throw new Error("genesis main moved before merge");
    const response = await client.request<{merged:boolean;sha:string}>("PUT",`${root}/pulls/${input.pullNumber}/merge`,{sha:input.headSha,merge_method:"merge"});
    if (!response.merged || !response.sha) throw new Error("genesis protected merge refused");
    mergeSha = response.sha;
  }
  if (!mergeSha) throw new Error("genesis merge proof missing");
  const [commit,ref,merged] = await Promise.all([
    client.request<{parents:Array<{sha:string}>}>("GET",`${root}/git/commits/${mergeSha}`),
    client.request<{object:{sha:string}}>("GET",`${root}/git/ref/heads/main`),
    client.request<{merged:boolean;merge_commit_sha:string;head:{sha:string}}>("GET",`${root}/pulls/${input.pullNumber}`),
  ]);
  if (commit.parents.length !== 2 || commit.parents[0]?.sha !== input.baseSha || commit.parents[1]?.sha !== input.headSha || ref.object.sha !== mergeSha || !merged.merged || merged.merge_commit_sha !== mergeSha || merged.head.sha !== input.headSha) throw new Error("genesis merge parent/readback proof refused");
}
const canonicalCheckNames = (checks:readonly string[]):string => JSON.stringify([...checks].sort());
