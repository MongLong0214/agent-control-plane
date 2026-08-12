import type { Clock } from "../core/clock.ts";
import { digestOf, sha256 } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { parseGitHubIdentity } from "../core/ids.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { BranchProfile } from "../contracts/manifest.ts";
import type { AuditLog } from "../db/audit.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { Db } from "../db/database.ts";
import { fileAt } from "../git/git.ts";
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
    const args = ["api", "-X", method, path, "-H", "Accept: application/vnd.github+json"];
    if (body !== undefined) args.push("--input", "-");

    // The store owns the spawn: it injects the token into the child environment and
    // writes the request body to the child's stdin. `gh api --input -` blocks until
    // stdin closes, which is why the body cannot be passed as a plain option.
    const result = await this.credentials.run({
      file: "gh",
      args,
      tokenEnvVar: "GH_TOKEN",
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: process.env["HOME"] ?? "",
        GH_PROMPT_DISABLED: "1",
      },
      ...(body !== undefined ? { input: JSON.stringify(body) } : {}),
      timeoutMs: 120_000,
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
  state: string;
  html_url: string;
}

interface CheckRun {
  id: number;
  name: string;
  head_sha: string;
  conclusion: string | null;
  status: string;
  app?: { slug?: string } | null;
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

    const profile = this.branchProfile(input.runId);
    const contract = validateBranchContract({
      head: input.head,
      base: input.base,
      profile,
      declaredParent: input.declaredParent ?? null,
      activeReleases: input.activeReleases ?? [],
    });
    if (!contract.allowed) return contract as Decision<{ pullNumber: number; url: string }>;

    if (input.requireLinkage && (input.linkedIssues ?? []).length === 0) {
      return deny(ReasonCode.PR_LINKAGE_MISSING, "project contract requires PR issue linkage", {
        runId: input.runId,
      });
    }

    const slug = this.slug(input.repositoryIdentity);
    if (!slug.allowed) return slug as Decision<{ pullNumber: number; url: string }>;
    const { owner, repo } = slug.value;

    const idempotencyKey = `pr_prepare:${input.repositoryIdentity}:${input.head}:${input.base}`;
    const existing = this.receipt(idempotencyKey);
    if (existing) {
      const cached = JSON.parse(existing.response_json) as { pullNumber: number; url: string };
      return allow(ReasonCode.MERGE_IDEMPOTENT_REPLAY, cached, { replayed: true });
    }

    const consumed = this.commitGrant(grant.value);
    if (!consumed.allowed) return consumed as Decision<{ pullNumber: number; url: string }>;

    const open = await this.api().request<PullRequest[]>(
      "GET",
      `/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(input.head)}&base=${encodeURIComponent(input.base)}&state=open`,
    );

    const pull =
      open[0] ??
      (await this.api().request<PullRequest>("POST", `/repos/${owner}/${repo}/pulls`, {
        title: input.title,
        body: `${input.body}\n\n<!-- acp-run:${input.runId} -->`,
        head: input.head,
        base: input.base,
      }));

    // §16.2 — command success is not evidence; re-read and compare.
    const reread = await this.api().request<PullRequest>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${pull.number}`,
    );
    if (reread.head.sha !== input.exactHeadSha) {
      return deny(ReasonCode.MERGE_HEAD_STALE, "pull request head does not match the candidate head", {
        expected: input.exactHeadSha,
        observed: reread.head.sha,
      });
    }

    const value = { pullNumber: reread.number, url: reread.html_url };
    this.writeReceipt({
      idempotencyKey,
      operation: "pr_prepare",
      runId: input.runId,
      repositoryIdentity: input.repositoryIdentity,
      resourceType: "pull_request",
      resourceIdentity: `${owner}/${repo}#${reread.number}`,
      preexisting: Boolean(open[0]),
      beforeStateDigest: null,
      afterStateDigest: digestOf({ head: reread.head.sha, base: reread.base.sha }),
      requestDigest: digestOf(input),
      response: value,
      reread: true,
    });
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
      return allow(
        ReasonCode.MERGE_IDEMPOTENT_REPLAY,
        JSON.parse(existing.response_json) as { checkRunId: number },
        { replayed: true },
      );
    }

    const consumed = this.commitGrant(grant.value);
    if (!consumed.allowed) return consumed as Decision<{ checkRunId: number }>;

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

    this.writeReceipt({
      idempotencyKey,
      operation: "gate_publish",
      runId: payload.runId,
      repositoryIdentity,
      resourceType: "check_run",
      resourceIdentity: `${owner}/${repo}@${payload.exactHead}/${GATE_CHECK_NAME}`,
      preexisting: false,
      beforeStateDigest: null,
      afterStateDigest: payloadDigest,
      requestDigest: payloadDigest,
      response: { checkRunId: created.id, payload, payloadDigest },
      reread: false,
    });

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

    const slug = this.slug(input.repositoryIdentity);
    if (!slug.allowed) return slug as Decision<{ predicates: Record<string, boolean> }>;
    const { owner, repo } = slug.value;

    const pull = await this.api().request<PullRequest>(
      "GET",
      `/repos/${owner}/${repo}/pulls/${input.pullNumber}`,
    );

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

    const profile = this.branchProfile(input.runId);
    const contract = validateBranchContract({
      head: pull.head.ref,
      base: pull.base.ref,
      profile,
      declaredParent: pull.base.ref,
      activeReleases: await this.activeReleases(input.repositoryIdentity),
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
    const idempotencyKey = `merge_execute:${input.repositoryIdentity}:${input.pullNumber}:${input.exactHeadSha}`;
    const existing = this.receipt(idempotencyKey);
    if (existing) {
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

    const method =
      input.mergeStrategy === "fast_forward" ? "rebase" : input.mergeStrategy === "squash" ? "squash" : "merge";

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

    // Passing `sha` makes GitHub refuse the merge if the head moved between evaluate
    // and execute — the race the exact-head predicate cannot close on its own.
    const merged = await this.api().request<{ sha: string; merged: boolean }>(
      "PUT",
      `/repos/${owner}/${repo}/pulls/${input.pullNumber}/merge`,
      { sha: input.exactHeadSha, merge_method: method },
    );
    if (!merged.merged) {
      // No receipt: an unmerged attempt is not an idempotent success to replay later.
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

    this.writeReceipt({
      idempotencyKey,
      operation: "merge_execute",
      runId: input.runId,
      repositoryIdentity: input.repositoryIdentity,
      resourceType: "merge",
      resourceIdentity: `${owner}/${repo}#${input.pullNumber}`,
      preexisting: false,
      beforeStateDigest: digestOf({ head: input.exactHeadSha, base: input.expectedBaseSha }),
      afterStateDigest: sha256(merged.sha),
      requestDigest: digestOf(input),
      response: { mergeCommitSha: merged.sha },
      reread: true,
    });

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

    // The merge happened; now prove it landed on the base the evidence was bound to. A
    // mismatch is reported, never smoothed over: the merge commit exists and the run's
    // evidence no longer describes it (§24.6).
    const onBase = await this.assertMergedOntoBase(owner, repo, merged.sha, input.expectedBaseSha, method);
    if (!onBase.allowed) {
      if (repositoryId) this.runs.setRepositoryMergeState(input.runId, repositoryId, "FAILED");
      this.audit.record({
        kind: "MERGE_BASE_DRIFT",
        runId: input.runId,
        reasonCode: ReasonCode.MERGE_BASE_STALE,
        evidence: {
          repositoryIdentity: input.repositoryIdentity,
          mergeCommitSha: merged.sha,
          expectedBase: input.expectedBaseSha,
          detail: onBase.message,
        },
      });
      this.rollbackPrepare(input.runId, input.repositoryIdentity, merged.sha, "halt");
      return onBase as Decision<{ mergeCommitSha: string; replayed: boolean }>;
    }

    if (repositoryId) this.runs.setRepositoryMergeState(input.runId, repositoryId, "MERGED");
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
    const runsByName = new Map((response.check_runs ?? []).map((c) => [c.name, c]));
    const observed = effective.map((name) => {
      const check = runsByName.get(name);
      // An incomplete check is not a pass; only a completed success is.
      const conclusion = !check
        ? "missing"
        : check.status !== "completed"
          ? `incomplete:${check.status}`
          : (check.conclusion ?? "missing");
      return { name, conclusion };
    });
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

    if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
      return deny(ReasonCode.RELEASE_TAG_SEMVER_MISMATCH, "tag does not match the semver policy", { tag });
    }
    const slug = this.slug(repositoryIdentity);
    if (!slug.allowed) return slug as Decision<{ tag: string; sha: string }>;
    const { owner, repo } = slug.value;

    const acceptedMerge = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM github_receipts
        WHERE operation = 'merge_execute' AND repository_identity = ? AND after_state_digest = ?`,
      [repositoryIdentity, sha256(commitSha)],
    );
    if ((acceptedMerge?.n ?? 0) === 0) {
      return deny(
        ReasonCode.RELEASE_TAG_COMMIT_NOT_ACCEPTED,
        "tag target is not an accepted merge commit produced by this kernel",
        { commitSha, repositoryIdentity },
      );
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
    const targets = hotfixPropagationTargets(profile, await this.activeReleases(repositoryIdentity));

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

  ciEvidenceSource(): CiEvidenceSource {
    return {
      fetch: async (identity, head) => {
        const slug = this.slug(identity);
        if (!slug.allowed) return [];
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
          checks.push({
            commandId: check.name,
            repositoryIdentity: identity,
            head: check.head_sha,
            conclusion: (check.conclusion as CiCheck["conclusion"]) ?? "unknown",
            workflowDigest: await this.workflowDigestFor(identity, head, check.name),
            creatorIdentity: check.app?.slug ?? "unknown",
            completedAt: check.completed_at ?? this.clock.nowIso(),
            nonVacuous: check.status === "completed",
          });
        }
        return checks;
      },
      approvedWorkflowDigests: async (identity) => {
        const repository = this.repositories.byIdentity(identity);
        const digest = repository?.activeManifestDigest ?? null;
        const manifest = digest ? this.projects.manifest(digest) : null;
        return (manifest?.ciWorkflows ?? [])
          .map((w) => w.approvedDigest)
          .filter((d): d is string => Boolean(d));
      },
      trustedCreators: async () => {
        const identity = this.credentials.creatorIdentity();
        return identity ? [identity, "github-actions"] : ["github-actions"];
      },
    };
  }

  private async workflowDigestFor(identity: string, head: string, checkName: string): Promise<string> {
    const repository = this.repositories.byIdentity(identity);
    if (!repository) return "unknown";
    const manifestDigest = repository.activeManifestDigest;
    const manifest = manifestDigest ? this.projects.manifest(manifestDigest) : null;
    const workflow = manifest?.ciWorkflows.find((w) => w.checkName === checkName);
    if (!workflow) return "unknown";
    const content = await fileAt(repository.checkoutPath, head, workflow.path);
    return content === null ? "unknown" : sha256(content);
  }

  // -------------------------------------------------------------------------
  // shared helpers
  // -------------------------------------------------------------------------

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

  private branchProfile(runId: string): BranchProfile {
    const run = this.runs.get(runId);
    const digest = run?.pinnedManifestDigest ?? null;
    const manifest = digest ? this.projects.manifest(digest) : null;
    return (
      manifest?.branchProfile ?? {
        longLived: ["main", "dev"],
        defaultBranch: "dev",
        updateStrategy: "rebase_before_review",
        mergeStrategy: "merge_commit",
        releaseTagPolicy: "semver",
        releaseBranchCleanup: "keep",
      }
    );
  }

  private async activeReleases(repositoryIdentity: string): Promise<string[]> {
    const slug = this.slug(repositoryIdentity);
    if (!slug.allowed) return [];
    const { owner, repo } = slug.value;
    const branches = await this.api()
      .request<Array<{ name: string }>>("GET", `/repos/${owner}/${repo}/branches?per_page=100`)
      .catch(() => []);
    return branches.filter((b) => b.name.startsWith("release/")).map((b) => b.name);
  }

  private receipt(idempotencyKey: string): { response_json: string } | undefined {
    return this.db.get<{ response_json: string }>(
      `SELECT response_json FROM github_receipts WHERE idempotency_key = ?`,
      [idempotencyKey],
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
