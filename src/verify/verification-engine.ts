import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { VerificationCommand } from "../contracts/verification-command.ts";
import type { AuditLog } from "../db/audit.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { Db } from "../db/database.ts";
import { ArtifactKind } from "../domain/types.ts";
import type { RepositoryRegistry } from "../registry/repository-registry.ts";
import {
  type CandidateSnapshot,
  candidateSnapshotDigest,
  verifySnapshotFreshness,
} from "../snapshot/candidate-snapshot.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";
import { type SandboxEnforcement, runSandboxed } from "./sandbox.ts";
import type { WorktreeManager } from "./worktree.ts";

export interface CiCheck {
  commandId: string;
  repositoryIdentity: string;
  head: string;
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "unknown";
  workflowDigest: string;
  creatorIdentity: string;
  completedAt: string;
  nonVacuous: boolean;
}

/**
 * Trusted CI evidence lookup (Integration §14.4). Kept as a port so the verification
 * engine has no dependency on the GitHub kernel; the daemon wires the real one in.
 */
export interface CiEvidenceSource {
  fetch(repositoryIdentity: string, head: string): Promise<CiCheck[]>;
  /** Workflow/config digests the project contract approved for this repository. */
  approvedWorkflowDigests(repositoryIdentity: string): Promise<string[]>;
  trustedCreators(): Promise<string[]>;
}

export interface VerificationResultRecord {
  commandId: string;
  repositoryIdentity: string;
  source: "local" | "ci";
  exactHead: string;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  outputDigest: string;
  outputTruncated: boolean;
  status: "PASS" | "FAIL" | "TIMEOUT" | "ERROR" | "SKIPPED";
  reasonCode: string | null;
  enforcement?: SandboxEnforcement;
}

export interface VerificationReport {
  runId: string;
  candidateSnapshotDigest: string;
  contractDigest: string;
  expectedInputs: number;
  observedInputs: number;
  results: VerificationResultRecord[];
  status: "PASS" | "FAIL" | "INCOMPLETE";
  reasonCode: string;
  gaps: string[];
}

export interface VerifyOptions {
  runId: string;
  snapshot: CandidateSnapshot;
  commands: readonly VerificationCommand[];
  /** Digest of the approved contract the commands came from (CP-HI-03). */
  contractDigest: string;
  /** Commands the CTO proposed for an unregistered repository (§17.5). */
  runScoped?: boolean;
}

/**
 * PRD §17.
 *
 * Two properties matter more than the individual command outcomes. First, the
 * candidate is pinned before anything runs, so a source change invalidates the whole
 * evidence set rather than part of it. Second, the completeness gate counts expected
 * inputs — a missing command, a missing repository, a null result, a stale CI answer or
 * truncated output all block success instead of quietly reducing the bar (§17.7,
 * CP-HI-08).
 */
export class VerificationEngine {
  #ci: CiEvidenceSource | null = null;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly artifacts: ArtifactStore,
    private readonly repositories: RepositoryRegistry,
    private readonly worktrees: WorktreeManager,
    private readonly telemetry: Telemetry,
  ) {}

  attachCi(source: CiEvidenceSource): void {
    this.#ci = source;
  }

  async verify(options: VerifyOptions): Promise<Decision<VerificationReport>> {
    const { runId, snapshot, commands } = options;
    const snapshotDigest = candidateSnapshotDigest(snapshot);

    // CP-HI-03 — the pinned contract, not whatever the candidate now contains.
    if (snapshot.contractDigest !== options.contractDigest) {
      return deny(
        ReasonCode.CANDIDATE_CANNOT_WEAKEN_CONTRACT,
        "candidate snapshot is pinned to a different contract than the one supplied",
        { snapshotContract: snapshot.contractDigest, supplied: options.contractDigest },
      );
    }

    const probes = snapshot.repositories.map((repo) => {
      const record = this.repositories.byIdentity(repo.identity);
      return { identity: repo.identity, checkoutPath: record?.checkoutPath ?? "" };
    });
    const fresh = await verifySnapshotFreshness(snapshot, probes.filter((p) => p.checkoutPath));
    if (!fresh.allowed) return fresh as Decision<VerificationReport>;

    if (commands.length === 0) {
      // §17.5 — no defensible verification method is a declared gap, not a pass.
      const report = this.buildReport(options, snapshotDigest, [], [
        "no verification command is configured for this candidate",
      ]);
      this.persist(runId, snapshotDigest, report);
      return deny(ReasonCode.VERIFICATION_GAP, "no verification command configured", {
        runId,
        snapshotDigest,
      });
    }

    const results: VerificationResultRecord[] = [];
    const gaps: string[] = [];

    for (const command of commands) {
      const repo = snapshot.repositories.find((r) => r.repositoryRole === command.repositoryRole);
      if (!repo) {
        gaps.push(`command '${command.id}' targets repositoryRole '${command.repositoryRole}' which is not in the candidate`);
        continue;
      }
      const record = this.repositories.byIdentity(repo.identity);
      if (!record) {
        gaps.push(`repository '${repo.identity}' has no local binding`);
        continue;
      }

      if (command.evidenceMode !== "TRUSTED_CI") {
        results.push(await this.runLocal(runId, snapshotDigest, command, repo.identity, record.checkoutPath, repo.candidateHead));
      }
      if (command.evidenceMode !== "LOCAL_COMMAND") {
        results.push(await this.collectCi(runId, snapshotDigest, command, repo.identity, repo.candidateHead));
      }
    }

    const report = this.buildReport(options, snapshotDigest, results, gaps);
    this.persist(runId, snapshotDigest, report);

    this.telemetry.record({
      scope: "quality",
      name: "verification",
      runId,
      text: report.status,
      dims: { expected: report.expectedInputs, observed: report.observedInputs, gaps: gaps.length },
    });

    if (report.status === "PASS") return allow(ReasonCode.OK, report, { snapshotDigest });
    return deny(
      report.reasonCode as ReasonCode,
      report.status === "INCOMPLETE" ? "verification evidence is incomplete" : "verification failed",
      { runId, snapshotDigest, report },
    );
  }

  private async runLocal(
    runId: string,
    snapshotDigest: string,
    command: VerificationCommand,
    identity: string,
    checkoutPath: string,
    head: string,
  ): Promise<VerificationResultRecord> {
    const worktreeId = `verify-${runId}-${command.id}-${head.slice(0, 8)}`;
    const outcome = await this.worktrees.withWorktree(checkoutPath, head, worktreeId, (worktree) =>
      runSandboxed({ command, worktreePath: worktree.path }),
    );

    const record: VerificationResultRecord = {
      commandId: command.id,
      repositoryIdentity: identity,
      source: "local",
      exactHead: head,
      startedAt: outcome.startedAt,
      endedAt: outcome.endedAt,
      exitCode: outcome.exitCode,
      outputDigest: outcome.outputDigest,
      outputTruncated: outcome.outputTruncated,
      // Truncated output is not usable evidence, whatever the exit code said.
      status: outcome.outputTruncated && outcome.status === "PASS" ? "ERROR" : outcome.status,
      reasonCode: outcome.reasonCode,
      enforcement: outcome.enforcement,
    };
    this.writeResultRow(runId, snapshotDigest, record);
    return record;
  }

  /**
   * Integration §14.4 — a CI result counts only at the exact candidate head, from an
   * approved workflow digest, created by a trusted identity, with a non-vacuous job.
   */
  private async collectCi(
    runId: string,
    snapshotDigest: string,
    command: VerificationCommand,
    identity: string,
    head: string,
  ): Promise<VerificationResultRecord> {
    const now = this.clock.nowIso();
    const base: VerificationResultRecord = {
      commandId: command.id,
      repositoryIdentity: identity,
      source: "ci",
      exactHead: head,
      startedAt: now,
      endedAt: now,
      exitCode: null,
      outputDigest: digestOf({ commandId: command.id, head }),
      outputTruncated: false,
      status: "ERROR",
      reasonCode: ReasonCode.EVIDENCE_MISSING,
    };

    if (!this.#ci) {
      const record = { ...base, reasonCode: ReasonCode.EVIDENCE_MISSING };
      this.writeResultRow(runId, snapshotDigest, record);
      return record;
    }

    const [checks, approved, creators] = await Promise.all([
      this.#ci.fetch(identity, head),
      this.#ci.approvedWorkflowDigests(identity),
      this.#ci.trustedCreators(),
    ]);

    const match = checks.find((c) => c.commandId === command.id);
    if (!match) {
      const record = { ...base, reasonCode: ReasonCode.EVIDENCE_MISSING };
      this.writeResultRow(runId, snapshotDigest, record);
      return record;
    }
    if (match.head !== head) {
      const record = { ...base, reasonCode: ReasonCode.VERIFICATION_CI_HEAD_MISMATCH };
      this.writeResultRow(runId, snapshotDigest, record);
      return record;
    }
    if (!approved.includes(match.workflowDigest)) {
      const record = { ...base, reasonCode: ReasonCode.VERIFICATION_CI_WORKFLOW_DIGEST_MISMATCH };
      this.writeResultRow(runId, snapshotDigest, record);
      return record;
    }
    if (!creators.includes(match.creatorIdentity) || !match.nonVacuous) {
      const record = { ...base, reasonCode: ReasonCode.GATE_CREATOR_UNTRUSTED };
      this.writeResultRow(runId, snapshotDigest, record);
      return record;
    }

    const record: VerificationResultRecord = {
      ...base,
      startedAt: match.completedAt,
      endedAt: match.completedAt,
      status: match.conclusion === "success" ? "PASS" : "FAIL",
      reasonCode: match.conclusion === "success" ? null : ReasonCode.VERIFICATION_COMMAND_FAILED,
      outputDigest: digestOf(match),
    };
    this.writeResultRow(runId, snapshotDigest, record);
    return record;
  }

  private buildReport(
    options: VerifyOptions,
    snapshotDigest: string,
    results: VerificationResultRecord[],
    gaps: string[],
  ): VerificationReport {
    // §17.7 — count what evidence *should* exist, not what happened to arrive.
    const expectedInputs = options.commands
      .filter((c) => c.required)
      .reduce((n, c) => n + (c.evidenceMode === "BOTH_REQUIRED" ? 2 : 1), 0);
    const requiredIds = new Set(options.commands.filter((c) => c.required).map((c) => c.id));
    const observedInputs = results.filter((r) => requiredIds.has(r.commandId)).length;

    const failed = results.filter((r) => requiredIds.has(r.commandId) && r.status !== "PASS");
    const incomplete = gaps.length > 0 || observedInputs !== expectedInputs;

    const status: VerificationReport["status"] = incomplete
      ? "INCOMPLETE"
      : failed.length > 0
        ? "FAIL"
        : "PASS";

    const reasonCode = incomplete
      ? gaps.length > 0
        ? ReasonCode.VERIFICATION_GAP
        : ReasonCode.VERIFICATION_INCOMPLETE
      : failed.length > 0
        ? (failed[0]!.reasonCode ?? ReasonCode.VERIFICATION_COMMAND_FAILED)
        : ReasonCode.OK;

    return {
      runId: options.runId,
      candidateSnapshotDigest: snapshotDigest,
      contractDigest: options.contractDigest,
      expectedInputs,
      observedInputs,
      results,
      status,
      reasonCode,
      gaps,
    };
  }

  private persist(runId: string, snapshotDigest: string, report: VerificationReport): void {
    this.artifacts.putEvidence("verification-engine", runId, ArtifactKind.VERIFICATION, report, snapshotDigest);
    this.audit.record({
      kind: "VERIFICATION_COMPLETED",
      runId,
      reasonCode: report.reasonCode as ReasonCode,
      evidence: {
        candidateSnapshotDigest: snapshotDigest,
        status: report.status,
        expectedInputs: report.expectedInputs,
        observedInputs: report.observedInputs,
        gaps: report.gaps,
        results: report.results.map((r) => ({
          commandId: r.commandId,
          source: r.source,
          status: r.status,
          exactHead: r.exactHead,
        })),
      },
    });
  }

  private writeResultRow(
    runId: string,
    snapshotDigest: string,
    record: VerificationResultRecord,
  ): void {
    this.db.run(
      `INSERT OR REPLACE INTO verification_results
         (result_id, run_id, candidate_snapshot_digest, command_id, repository_identity, source,
          exact_head, started_at, ended_at, exit_code, output_digest, output_truncated, status, reason_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `${snapshotDigest}:${record.commandId}:${record.repositoryIdentity}:${record.source}`,
        runId, snapshotDigest, record.commandId, record.repositoryIdentity, record.source,
        record.exactHead, record.startedAt, record.endedAt, record.exitCode, record.outputDigest,
        record.outputTruncated ? 1 : 0, record.status, record.reasonCode,
      ],
    );
  }

  latestReport(runId: string, snapshotDigest: string): VerificationReport | null {
    return (
      this.artifacts.latestForSnapshot<VerificationReport>(
        runId,
        ArtifactKind.VERIFICATION,
        snapshotDigest,
      )?.content ?? null
    );
  }
}
