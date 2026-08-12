import type { Clock } from "../core/clock.ts";
import { digestOf, sha256 } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { parseGitHubIdentity } from "../core/ids.ts";
import { ReasonCode } from "../core/reason-codes.ts";
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
import { WriteOperation, type ManagedWriteGuard } from "../guard/managed-write-guard.ts";
import { hotfixPropagationTargets, validateBranchContract } from "./branch-contract.ts";
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
  /** True only for a provider/queue that atomically rejects an unexpected base SHA. */
  readonly supportsAtomicExpectedBase?: boolean;
  request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T>;
}

/**
 * `gh api` with the trusted token injected into the child environment only.
 *
 * The token never reaches any other process: the daemon is the sole caller and the
 * child is a single short-lived API request (CP-HI-05).
 */
export class GhCliClient implements GitHubClient {
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
    if (result.value.exitCode !== 0) {
      throw new Error(
        `gh api ${method} ${path} exited ${result.value.exitCode}: ${result.value.stderr.trim().slice(0, 2000)}`,
      );
    }
    const stdout = result.value.stdout.trim();
    return (stdout ? JSON.parse(stdout) : null) as T;
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
    private readonly client?: GitHubClient,
  ) {}

  /**
   * CP-HI-01 — every external write this kernel performs goes through the guard, and the
   * grant is consumed immediately before the API call. Without this the guard would be a
   * decision function nobody consults on the paths that actually mutate GitHub.
   *
   * The caller's identity is used when it has one; daemon-initiated operations
   * (gate publish, tag, projection) are authorised as the run's pinned owner.
   */
  private mediate(
    operation: WriteOperation,
    runId: string,
    repositoryIdentity: string,
    caller?: { ownerSessionId: string; ownerBindingGeneration: number },
  ): Decision<string> {
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

    const granted = this.guard.evaluate({
      operation,
      repositoryIdentity,
      runId,
      sessionId,
      bindingGeneration: generation,
      claimedClassification: "MANAGED",
      actor: "github-kernel",
    });
    if (!granted.allowed) return granted as Decision<string>;
    return allow(ReasonCode.OK, granted.value.grantId);
  }

  /** Burns the grant. Called immediately before the side effect. */
  private commitGrant(grantId: string): Decision<void> {
    const consumed = this.guard.consume(grantId);
    return consumed.allowed ? allow(ReasonCode.OK, undefined) : (consumed as Decision<void>);
  }

  private api(): GitHubClient {
    return this.client ?? new GhCliClient(this.credentials);
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

    const grant = this.mediate(WriteOperation.GITHUB_PR, input.runId, input.repositoryIdentity, input);
    if (!grant.allowed) return grant as Decision<{ pullNumber: number; url: string }>;

    const candidate = this.candidateRepository(input.runId, input.repositoryIdentity);
    if (!candidate.allowed) return candidate as Decision<{ pullNumber: number; url: string }>;
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
    const lineage = await this.assertFrozenSourceLineage(
      input.repositoryIdentity,
      candidate.value.baseHead,
      candidate.value.candidateHead,
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
      sourceBase: candidate.value.baseBranch,
    });
    if (!contract.allowed) return contract as Decision<{ pullNumber: number; url: string }>;

    if (input.requireLinkage && (input.linkedIssues ?? []).length === 0) {
      return deny(ReasonCode.PR_LINKAGE_MISSING, "project contract requires PR issue linkage", {
        runId: input.runId,
      });
    }

    const linkedIssues = [...new Set(input.linkedIssues ?? [])].sort((a, b) => a - b);
    const prBody = this.prBody(input.body, input.runId, linkedIssues, Boolean(input.requireLinkage));
    const request = {
      runId: input.runId,
      repositoryIdentity: input.repositoryIdentity,
      head: input.head,
      base: input.base,
      exactHeadSha: input.exactHeadSha,
      expectedBaseSha: candidate.value.baseHead,
      sourceBase: candidate.value.baseBranch,
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
        if (matches.length !== 1) {
          return deny(ReasonCode.RESOURCE_COLLISION, "PR operation is pending reconciliation", { idempotencyKey });
        }
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
      const consumed = this.commitGrant(grant.value);
      if (!consumed.allowed) {
        this.releaseReservation(idempotencyKey, requestDigest);
        return consumed as Decision<{ pullNumber: number; url: string }>;
      }
    }
    const pull = open[0] ?? (await this.api().request<PullRequest>("POST", `/repos/${owner}/${repo}/pulls`, {
      title: input.title,
      body: prBody,
      head: input.head,
      base: input.base,
    }));

    // §16.2 — command success is not evidence; re-read and compare.
    const reread = await this.api().request<PullRequest>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${pull.number}`,
    );
    if (
      reread.head.sha !== input.exactHeadSha ||
      reread.head.ref !== input.head ||
      reread.base.ref !== input.base ||
      reread.base.sha !== candidate.value.baseHead
    ) {
      return deny(ReasonCode.MERGE_HEAD_STALE, "pull request head does not match the candidate head", {
        expected: input.exactHeadSha,
        observed: { head: reread.head, base: reread.base },
      });
    }
    if (input.requireLinkage && !this.hasPrLinkage(reread.body, linkedIssues)) {
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
        runId: input.runId,
        repositoryIdentity: input.repositoryIdentity,
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
  async gatePublish(payload: GatePayload, repositoryIdentity: string): Promise<Decision<{ checkRunId: number }>> {
    if (!this.credentials.available()) {
      return deny(
        ReasonCode.TRUSTED_CREDENTIAL_UNAVAILABLE,
        "no trusted credential; the production gate cannot be published",
        { repositoryIdentity },
      );
    }

    // CP-HI-06 — the gate is an assertion that specific evidence exists. Publishing it
    // without checking that evidence would make the assertion self-issued: a caller could
    // hand over any digests and the merge kernel would then trust its own check run.
    const backed = this.assertGatePayloadBacked(payload, repositoryIdentity);
    if (!backed.allowed) return backed as Decision<{ checkRunId: number }>;
    const slug = this.slug(repositoryIdentity);
    if (!slug.allowed) return slug as Decision<{ checkRunId: number }>;
    const { owner, repo } = slug.value;

    const grant = this.mediate(WriteOperation.GITHUB_CHECK_RUN, payload.runId, repositoryIdentity);
    if (!grant.allowed) return grant as Decision<{ checkRunId: number }>;

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
        const creator = this.credentials.creatorIdentity();
        const checks = await this.api().request<{ check_runs: CheckRun[] }>(
          "GET",
          `/repos/${owner}/${repo}/commits/${payload.exactHead}/check-runs?check_name=${GATE_CHECK_NAME}`,
        );
        const matches = (checks.check_runs ?? []).filter((check) =>
          check.name === GATE_CHECK_NAME &&
          check.head_sha === payload.exactHead &&
          check.status === "completed" &&
          check.conclusion === "success" &&
          check.app?.slug === creator &&
          /payloadDigest=(sha256:[0-9a-f]{64})/.exec(check.output?.summary ?? "")?.[1] === payloadDigest,
        );
        if (matches.length !== 1) {
          return deny(ReasonCode.RESOURCE_COLLISION, "pending gate publication cannot be reconciled unambiguously", {
            idempotencyKey,
            matchingChecks: matches.map((check) => check.id),
          });
        }
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

    const consumed = this.commitGrant(grant.value);
    if (!consumed.allowed) {
      this.releaseReservation(idempotencyKey, payloadDigest);
      return consumed as Decision<{ checkRunId: number }>;
    }

    const created = await this.api().request<CheckRun>("POST", `/repos/${owner}/${repo}/check-runs`, {
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
    });

    // GitHub's POST acknowledgement is not proof that the expected check exists. Re-read
    // the commit's checks and bind the exact id, head, creator and payload projection.
    let reread: CheckRun | undefined;
    try {
      reread = await this.api().request<CheckRun>("GET", `/repos/${owner}/${repo}/check-runs/${created.id}`);
    } catch {
      // Some GitHub-compatible providers do not expose the singular endpoint. Their
      // commit-scoped listing still proves the exact id and every bound field.
      const checks = await this.api().request<{ check_runs: CheckRun[] }>(
        "GET",
        `/repos/${owner}/${repo}/commits/${payload.exactHead}/check-runs?check_name=${GATE_CHECK_NAME}`,
      );
      reread = (checks.check_runs ?? []).find((check) => check.id === created.id);
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
        checkRunId: created.id,
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
      response: { checkRunId: created.id, payload, payloadDigest },
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
        checkRunId: created.id,
        creatorIdentity: this.credentials.creatorIdentity(),
      },
    });
    return allow(ReasonCode.OK, { checkRunId: created.id });
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

    if (run.humanGateRequired) {
      const approval = this.artifacts.byDigest<{ kind?: string; approved?: boolean }>(payload.humanGateDigest);
      if (
        !approval ||
        approval.runId !== payload.runId ||
        approval.kind !== "APPROVAL" ||
        approval.content.kind !== "OWNER_DECISION" ||
        approval.content.approved !== true
      ) {
        return deny(
          ReasonCode.HUMAN_GATE_UNSATISFIED,
          "run requires an owner decision and the gate payload does not name one",
          { runId: payload.runId, digest: payload.humanGateDigest },
        );
      }
    } else if (payload.humanGateDigest !== NO_HUMAN_GATE_DIGEST) {
      return deny(
        ReasonCode.GATE_EVIDENCE_NOT_BACKED,
        "run needs no owner decision; the payload must carry the canonical no-human-gate digest",
        { runId: payload.runId, expected: NO_HUMAN_GATE_DIGEST, observed: payload.humanGateDigest },
      );
    }

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
    if (
      prepared.value.head !== pull.head.ref ||
      prepared.value.base !== pull.base.ref ||
      prepared.value.exactHeadSha !== pull.head.sha ||
      prepared.value.expectedBaseSha !== pull.base.sha ||
      prepared.value.expectedBaseSha !== input.expectedBaseSha
    ) {
      return deny(ReasonCode.MERGE_BRANCH_PROFILE_UNSATISFIED, "live pull request differs from immutable prepare contract", {
        pullNumber: pull.number,
        prepared: prepared.value,
        observed: { head: pull.head, base: pull.base },
      });
    }

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

    // §24.7 — an earlier repository in this run that failed post-merge verification blocks
    // its dependents, and merge order is not advisory.
    const blocked = this.dependentMergeBlocked(input.runId, input.repositoryIdentity);
    if (!blocked.allowed) return blocked as Decision<{ predicates: Record<string, boolean> }>;
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
      sourceBase: prepared.value.sourceBase,
    });
    if (!contract.allowed) {
      return deny(ReasonCode.MERGE_BRANCH_PROFILE_UNSATISFIED, contract.message, contract.evidence);
    }

    const gate = await this.verifyGate(input.repositoryIdentity, pull.head.sha, input.runId);
    if (!gate.allowed) return gate as Decision<{ predicates: Record<string, boolean> }>;

    const run = this.runs.get(input.runId);
    if (run?.humanGateRequired) {
      const humanGate = this.artifacts
        .list<{ kind?: string; approved?: boolean }>(input.runId, "APPROVAL")
        .some((a) => a.content.kind === "OWNER_DECISION" && a.content.approved === true);
      if (!humanGate) {
        return deny(ReasonCode.HUMAN_GATE_UNSATISFIED, "run requires an owner decision", {
          runId: input.runId,
        });
      }
    }

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
    const now = new Date(this.clock.nowIso()).getTime();
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
    const slug = this.slug(repositoryIdentity);
    if (!slug.allowed) return slug as Decision<GatePayload>;
    const { owner, repo } = slug.value;

    const checks = await this.api().request<{ check_runs: CheckRun[] }>(
      "GET",
      `/repos/${owner}/${repo}/commits/${head}/check-runs?check_name=${GATE_CHECK_NAME}`,
    );
    const candidates = checks.check_runs ?? [];
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
        const slug = this.slug(input.repositoryIdentity);
        if (!slug.allowed) return slug as Decision<{ mergeCommitSha: string; replayed: boolean }>;
        const pull = await this.api().request<PullRequest>(
          "GET",
          `/repos/${slug.value.owner}/${slug.value.repo}/pulls/${input.pullNumber}`,
        );
        if (!pull.merged || !pull.merge_commit_sha || pull.head.sha !== input.exactHeadSha) {
          return deny(ReasonCode.RESOURCE_COLLISION, "merge operation is pending reconciliation", { idempotencyKey });
        }
        const method = input.mergeStrategy === "squash" ? "squash" : "merge";
        const onBase = await this.assertMergedOntoBase(
          slug.value.owner,
          slug.value.repo,
          pull.merge_commit_sha,
          input.expectedBaseSha,
          method,
        );
        if (!onBase.allowed) return onBase as Decision<{ mergeCommitSha: string; replayed: boolean }>;
        const finalized = this.finalizeReservedReceipt({
          idempotencyKey,
          requestDigest,
          preexisting: false,
          afterStateDigest: sha256(pull.merge_commit_sha),
          response: {
            mergeCommitSha: pull.merge_commit_sha,
            sourceBranch: pull.head.ref,
            targetBranch: pull.base.ref,
            expectedBaseSha: input.expectedBaseSha,
          },
          reread: true,
        });
        if (!finalized.allowed) return finalized as Decision<{ mergeCommitSha: string; replayed: boolean }>;
        return allow(ReasonCode.MERGE_IDEMPOTENT_REPLAY, {
          mergeCommitSha: pull.merge_commit_sha,
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

    const evaluation = await this.mergeEvaluate(input);
    if (!evaluation.allowed) return evaluation as Decision<{ mergeCommitSha: string; replayed: boolean }>;

    const grant = this.mediate(
      WriteOperation.PROGRAMMATIC_MERGE,
      input.runId,
      input.repositoryIdentity,
      input,
    );
    if (!grant.allowed) return grant as Decision<{ mergeCommitSha: string; replayed: boolean }>;
    const consumed = this.commitGrant(grant.value);
    if (!consumed.allowed) return consumed as Decision<{ mergeCommitSha: string; replayed: boolean }>;

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
    const method = input.mergeStrategy === "squash" ? "squash" : "merge";

    // §24.6 — GitHub's merge API accepts an expected *head* but no expected base, so the
    // base is checked as late as possible before the call and proved after it.
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
    if (preflight.base.sha !== input.expectedBaseSha) {
      return deny(ReasonCode.MERGE_BASE_STALE, "base moved between evaluation and execution", {
        expected: input.expectedBaseSha,
        observed: preflight.base.sha,
      });
    }

    // GitHub's pull-request merge endpoint accepts an expected head SHA but has no
    // expected-base precondition. A preflight followed by a PUT is an irreversible
    // check-then-act race, so this provider cannot execute a contract-bound merge.
    // Keep the exact base in the request and refuse rather than merging onto an
    // unverified target; a future provider must expose an atomic base predicate here.
    if (!this.api().supportsAtomicExpectedBase) {
      return deny(
        ReasonCode.MERGE_BASE_STALE,
        "GitHub cannot atomically condition this merge on the evaluated base SHA",
        { expectedBaseSha: input.expectedBaseSha, exactHeadSha: input.exactHeadSha, provider: "github-rest" },
      );
    }

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

    // Passing `sha` makes GitHub refuse the merge if the head moved between evaluate
    // and execute — the race the exact-head predicate cannot close on its own.
    const merged = await this.api().request<{ sha: string; merged: boolean }>(
      "PUT",
      `/repos/${owner}/${repo}/pulls/${input.pullNumber}/merge`,
      { sha: input.exactHeadSha, expected_base_sha: input.expectedBaseSha, merge_method: method },
    );
    if (!merged.merged) {
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
    if (!merged.sha) {
      return deny(ReasonCode.EVIDENCE_MISSING, "GitHub reported a merge with no commit sha", {
        pullNumber: input.pullNumber,
      });
    }

    this.audit.record({
      kind: "MERGE_EXECUTED",
      runId: input.runId,
      evidence: {
        repositoryIdentity: input.repositoryIdentity,
        pullNumber: input.pullNumber,
        exactHead: input.exactHeadSha,
        mergeCommitSha: merged.sha,
        method,
      },
    });

    const repositoryId = this.runs
      .repositoriesOf(input.runId)
      .find((r) => r.identity === input.repositoryIdentity)?.repositoryId;
    const mergeRepositoryId = repositoryId ?? null;

    // The merge happened; now prove it landed on the base the evidence was bound to. A
    // mismatch is reported, never smoothed over: the merge commit exists and the run's
    // evidence no longer describes it (§24.6).
    const onBase = await this.assertMergedOntoBase(owner, repo, merged.sha, input.expectedBaseSha, method);
    if (!onBase.allowed) {
      if (typeof mergeRepositoryId === "string") this.runs.setRepositoryMergeState(input.runId, mergeRepositoryId as string, "FAILED");
      this.audit.record({
        kind: "MERGE_BASE_DRIFT",
        runId: input.runId,
        reasonCode: ReasonCode.MERGE_BASE_STALE,
        evidence: {
          repositoryIdentity: input.repositoryIdentity,
          mergeCommitSha: merged.sha,
          expectedBase: input.expectedBaseSha,
          detail: (onBase as Extract<Decision<void>, { allowed: false }>).message,
        },
      });
      this.rollbackPrepare(input.runId, input.repositoryIdentity, merged.sha, "halt");
      return onBase as Decision<{ mergeCommitSha: string; replayed: boolean }>;
    }

    const finalized = this.finalizeReservedReceipt({
      idempotencyKey,
      requestDigest,
      preexisting: false,
      afterStateDigest: sha256(merged.sha),
      response: {
        mergeCommitSha: merged.sha,
        sourceBranch: preflight.head.ref,
        targetBranch: preflight.base.ref,
        expectedBaseSha: input.expectedBaseSha,
      },
      reread: true,
    });
    if (!finalized.allowed) return finalized as Decision<{ mergeCommitSha: string; replayed: boolean }>;

    // API success is only a pending merge: dependents remain blocked until the exact
    // merge commit has passed the pinned post-merge checks.
    if (typeof mergeRepositoryId === "string") this.runs.setRepositoryMergeState(input.runId, mergeRepositoryId as string, "PENDING");
    return allow(ReasonCode.OK, { mergeCommitSha: merged.sha, replayed: false });
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
    for (let hop = 0; hop < 64; hop += 1) {
      const commit = await this.api()
        .request<{ sha: string; parents: Array<{ sha: string }> }>(
          "GET",
          `/repos/${owner}/${repo}/commits/${sha}`,
        )
        .catch(() => null);
      if (!commit) {
        return deny(ReasonCode.MERGE_BASE_STALE, "merge commit could not be re-read", {
          mergeCommitSha,
          at: sha,
        });
      }
      const first = commit.parents[0]?.sha ?? null;
      walked.push(sha);
      if (first === expectedBaseSha) return allow(ReasonCode.OK, undefined);
      if (method !== "rebase" || !first) break;
      sha = first;
    }
    return deny(
      ReasonCode.MERGE_BASE_STALE,
      "the merge did not land on the base the run's evidence was bound to",
      { mergeCommitSha, expectedBaseSha, walked },
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
  ): Promise<Decision<{ checks: Array<{ name: string; conclusion: string }> }>> {
    const slug = this.slug(repositoryIdentity);
    if (!slug.allowed) return slug as Decision<{ checks: Array<{ name: string; conclusion: string }> }>;
    const { owner, repo } = slug.value;

    // The required set comes from the project contract, not the caller: a caller-supplied
    // empty list would make this a vacuous PASS for any commit (§24.7).
    const declared = this.declaredPostMergeChecks(runId);
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

    const response = await this.api().request<{ check_runs: CheckRun[] }>(
      "GET",
      `/repos/${owner}/${repo}/commits/${mergeCommitSha}/check-runs`,
    );
    const observed = await Promise.all(effective.map(async (name) => {
      const matching = (response.check_runs ?? []).filter((check) => check.name === name);
      if (matching.length === 0) return { name, conclusion: "missing" };
      // Same-name checks are ambiguous provenance. Selecting whichever one happens to
      // appear first would let a candidate workflow hide beside the required workflow.
      if (matching.length !== 1) return { name, conclusion: "ambiguous" };
      const check = matching[0]!;
      if (check.status !== "completed") return { name, conclusion: `incomplete:${check.status}` };
      if (check.conclusion !== "success") return { name, conclusion: check.conclusion ?? "missing" };
      const trusted = await this.assertTrustedWorkflowCheck(runId, repositoryIdentity, mergeCommitSha, check);
      return { name, conclusion: trusted.allowed ? "success" : "untrusted" };
    }));
    const failed = observed.filter((c) => c.conclusion !== "success");

    this.writeReceipt({
      idempotencyKey: `post_merge_verify:${repositoryIdentity}:${mergeCommitSha}`,
      operation: "post_merge_verify",
      runId,
      repositoryIdentity,
      resourceType: "commit",
      resourceIdentity: `${owner}/${repo}@${mergeCommitSha}`,
      preexisting: false,
      beforeStateDigest: null,
      afterStateDigest: digestOf(observed),
      requestDigest: digestOf({ mergeCommitSha, requiredChecks: effective }),
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

  /** The post-merge checks the run's pinned manifest declares (§24.7). */
  private declaredPostMergeChecks(runId: string): string[] {
    const run = this.runs.get(runId);
    const manifest = run?.pinnedManifestDigest ? this.projects.manifest(run.pinnedManifestDigest) : null;
    const fromWorkflows = (manifest?.ciWorkflows ?? []).map((w) => w.checkName);
    const fromCommands = manifest?.postMergeCommands ?? [];
    return [...new Set([...fromWorkflows, ...fromCommands])];
  }

  /** §24.7 — a repository whose post-merge check failed blocks its dependents. */
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
    caller: { ownerSessionId: string; ownerBindingGeneration: number },
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

    const existing = await this.api()
      .request<{ object?: { sha: string } }>("GET", `/repos/${owner}/${repo}/git/ref/tags/${tag}`)
      .catch(() => null);
    if (existing?.object?.sha) {
      if (existing.object.sha === commitSha) {
        return allow(ReasonCode.MERGE_IDEMPOTENT_REPLAY, { tag, sha: commitSha }, { replayed: true });
      }
      return deny(ReasonCode.RELEASE_TAG_DUPLICATE, "tag already exists on a different commit", {
        tag,
        existing: existing.object.sha,
        requested: commitSha,
      });
    }

    const grant = this.mediate(WriteOperation.GITHUB_RELEASE, runId, repositoryIdentity, caller);
    if (!grant.allowed) return grant as Decision<{ tag: string; sha: string }>;
    const consumed = this.commitGrant(grant.value);
    if (!consumed.allowed) return consumed as Decision<{ tag: string; sha: string }>;

    await this.api().request("POST", `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/tags/${tag}`,
      sha: commitSha,
    });

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

    if (profile.value.releaseBranchCleanup === "delete") {
      await this.api().request(
        "DELETE",
        `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(merge.sourceBranch)}`,
      );
    }

    this.writeReceipt({
      idempotencyKey: `release_tag:${repositoryIdentity}:${tag}`,
      operation: "release_tag",
      runId,
      repositoryIdentity,
      resourceType: "tag",
      resourceIdentity: `${owner}/${repo}@${tag}`,
      preexisting: false,
      beforeStateDigest: null,
      afterStateDigest: sha256(commitSha),
      requestDigest: digestOf({ tag, commitSha }),
      response: { tag, sha: commitSha },
      reread: true,
    });
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
    caller: { ownerSessionId: string; ownerBindingGeneration: number },
  ): Promise<Decision<{ created: number; updated: number }>> {
    const authority = this.assertAuthority(runId, repositoryIdentity, caller);
    if (!authority.allowed) return authority as Decision<{ created: number; updated: number }>;

    const slug = this.slug(repositoryIdentity);
    if (!slug.allowed) return slug as Decision<{ created: number; updated: number }>;
    const { owner, repo } = slug.value;

    const grant = this.mediate(WriteOperation.GITHUB_ISSUE, runId, repositoryIdentity, caller);
    if (!grant.allowed) return grant as Decision<{ created: number; updated: number }>;
    const consumed = this.commitGrant(grant.value);
    if (!consumed.allowed) return consumed as Decision<{ created: number; updated: number }>;

    const existing = await this.api().request<Array<{ number: number; body: string | null }>>(
      "GET",
      `/repos/${owner}/${repo}/issues?state=all&per_page=100`,
    );
    const byMarker = new Map<string, number>();
    for (const issue of existing) {
      const marker = /<!-- acp-ticket:([^\s]+) -->/.exec(issue.body ?? "")?.[1];
      if (marker) byMarker.set(marker, issue.number);
    }

    let created = 0;
    let updated = 0;
    for (const ticket of tickets) {
      const body = `<!-- acp-ticket:${ticket.id} -->\n${ticket.body}`;
      const number = byMarker.get(ticket.id);
      if (number) {
        await this.api().request("PATCH", `/repos/${owner}/${repo}/issues/${number}`, {
          title: ticket.title,
          body,
          labels: ticket.labels ?? [],
        });
        updated += 1;
      } else {
        await this.api().request("POST", `/repos/${owner}/${repo}/issues`, {
          title: ticket.title,
          body,
          labels: ticket.labels ?? [],
        });
        created += 1;
      }
    }

    this.writeReceipt({
      idempotencyKey: `issue_project:${repositoryIdentity}:${digestOf(tickets)}`,
      operation: "issue_project",
      runId,
      repositoryIdentity,
      resourceType: "issues",
      resourceIdentity: `${owner}/${repo}`,
      preexisting: byMarker.size > 0,
      beforeStateDigest: null,
      afterStateDigest: digestOf({ created, updated }),
      requestDigest: digestOf(tickets),
      response: { created, updated },
      reread: true,
    });
    return allow(ReasonCode.OK, { created, updated });
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
    const workflow = manifest.value.ciWorkflows.find((entry) => entry.checkName === check.name);
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
      const repository = this.repositories.byIdentity(repositoryIdentity);
      const content = repository ? await fileAt(repository.checkoutPath, head, workflow.path) : null;
      const workflowDigest = content === null ? "unknown" : sha256(content);
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

  private async assertFrozenSourceLineage(
    repositoryIdentity: string,
    baseHead: string,
    candidateHead: string,
  ): Promise<Decision<void>> {
    const repository = this.repositories.byIdentity(repositoryIdentity);
    if (!repository) {
      return deny(ReasonCode.EVIDENCE_MISSING, "candidate repository has no local checkout for lineage proof", {
        repositoryIdentity,
      });
    }
    const observed = await mergeBase(repository.checkoutPath, baseHead, candidateHead);
    return observed === baseHead
      ? allow(ReasonCode.OK, undefined)
      : deny(ReasonCode.PR_BRANCH_CONTRACT_VIOLATION, "candidate does not descend from its frozen required base", {
          repositoryIdentity,
          expectedBaseHead: baseHead,
          mergeBase: observed,
        });
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
  ): Decision<{
    head: string;
    base: string;
    exactHeadSha: string;
    expectedBaseSha: string;
    sourceBase: string;
    declaredParent: string | null;
  }> {
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
      typeof intent.sourceBase !== "string" ||
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
      sourceBase: intent.sourceBase,
      declaredParent: intent.declaredParent,
    });
  }

  private setMergeState(runId: string, repositoryIdentity: string, state: "MERGED" | "FAILED"): void {
    const repositoryId = this.runs.repositoriesOf(runId).find((entry) => entry.identity === repositoryIdentity)?.repositoryId;
    if (repositoryId) this.runs.setRepositoryMergeState(runId, repositoryId, state);
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
        `INSERT INTO github_receipts
           (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type,
            resource_identity, preexisting, before_state_digest, after_state_digest, request_digest,
            response_json, created_at, reread_at, verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, ?, NULL, 0)`,
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
          SET preexisting = ?, after_state_digest = ?, response_json = ?, reread_at = ?, verified = ?
        WHERE idempotency_key = ? AND request_digest = ? AND verified = 0`,
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
    return updated.changes === 1
      ? allow(ReasonCode.OK, undefined)
      : deny(ReasonCode.RESOURCE_COLLISION, "reserved GitHub receipt could not be finalized", {
          idempotencyKey: input.idempotencyKey,
        });
  }

  /** No external write happened when grant consumption fails, so this reservation is safe to release. */
  private releaseReservation(idempotencyKey: string, requestDigest: string): void {
    this.db.run(
      `DELETE FROM github_receipts WHERE idempotency_key = ? AND request_digest = ? AND verified = 0`,
      [idempotencyKey, requestDigest],
    );
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
    this.db.run(
      `INSERT OR REPLACE INTO github_receipts
         (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type,
          resource_identity, preexisting, before_state_digest, after_state_digest, request_digest,
          response_json, created_at, reread_at, verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `rcp_${sha256(input.idempotencyKey).slice(7, 31)}`,
        input.idempotencyKey, input.operation, input.runId, input.repositoryIdentity,
        input.resourceType, input.resourceIdentity, input.preexisting ? 1 : 0,
        input.beforeStateDigest, input.afterStateDigest, input.requestDigest,
        JSON.stringify(input.response), this.clock.nowIso(),
        input.reread ? this.clock.nowIso() : null, input.reread ? 1 : 0,
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
