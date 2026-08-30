import type { Clock } from "../core/clock.ts";
import { randomUUID } from "node:crypto";
import { canonicalJson, digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { type VerificationCommand, verificationCommandSchema } from "../contracts/verification-command.ts";
import { type ProjectManifest, commandsForMode } from "../contracts/manifest.ts";
import type { AuditLog } from "../db/audit.ts";
import type { ArtifactStore, EvidenceWriter } from "../db/artifacts.ts";
import type { Db } from "../db/database.ts";
import { ArtifactKind, type RunRow } from "../domain/types.ts";
import type { ClaimRegistry } from "../claims/claim-registry.ts";
import { WorktreeAction, WriteOperation, type ManagedWriteGuard } from "../guard/managed-write-guard.ts";
import type { RepositoryRegistry } from "../registry/repository-registry.ts";
import {
  type CandidateSnapshot,
  candidateSnapshotDigest,
  duplicateRepositoryRoles,
  verifySnapshotFreshness,
} from "../snapshot/candidate-snapshot.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";
import { type SandboxEnforcement, runSandboxed } from "./sandbox.ts";
import type { WorktreeAuthorization, WorktreeManager } from "./worktree.ts";

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
  /** Local sandbox measurement; CI evidence has no host-process RSS. */
  peakRssMb?: number | null;
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
  /**
   * Deprecated caller assertions. They are checked against the registered run but never
   * select a command profile; the engine reads that authority from the run itself.
   */
  pinnedManifestDigest?: string | null;
  executionMode?: "SIMPLE" | "STANDARD" | "GUARDED";
  /** Commands the CTO proposed for an unregistered repository (§17.5). */
  runScoped?: boolean;
}

const memoryEvidenceReason = (
  peakRssMb: number | null | undefined,
  maxMemoryMb: number,
): ReasonCode | null => {
  if (peakRssMb == null) return ReasonCode.SANDBOX_RESOURCE_LIMIT_UNAVAILABLE;
  return peakRssMb > maxMemoryMb ? ReasonCode.SANDBOX_RESOURCE_LIMIT_EXCEEDED : null;
};

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
  private extraDenyReadPaths: string[] = [];
  /** Injected manifest loader; kept as a function so the engine owns no registry. */
  private manifests: ((digest: string) => ProjectManifest | null) | null = null;
  /** Run lookup makes the dispatch-time pin the only command-selection authority. */
  private runs: ((runId: string) => RunRow | null) | null = null;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly artifacts: ArtifactStore,
    /**
     * The capability that makes this engine the only writer of VERIFICATION evidence. It
     * is issued once by the composition root; holding the store is not enough to write
     * (#70, CP-HI-04).
     */
    private readonly evidenceWriter: EvidenceWriter<"VERIFICATION">,
    private readonly repositories: RepositoryRegistry,
    private readonly worktrees: WorktreeManager,
    private readonly claims: ClaimRegistry,
    private readonly guard: ManagedWriteGuard,
    private readonly telemetry: Telemetry,
  ) {}

  attachCi(source: CiEvidenceSource): void {
    this.#ci = source;
  }

  attachManifests(loader: (digest: string) => ProjectManifest | null): void {
    this.manifests = loader;
  }

  attachRuns(loader: (runId: string) => RunRow | null): void {
    this.runs = loader;
  }

  async verify(options: VerifyOptions): Promise<Decision<VerificationReport>> {
    const { runId, snapshot } = options;
    const snapshotDigest = candidateSnapshotDigest(snapshot);
    const run = this.runs?.(runId) ?? null;
    if (!run) {
      return deny(ReasonCode.NOT_FOUND, "verification requires a registered run", { runId });
    }

    const duplicateRoles = duplicateRepositoryRoles(snapshot.repositories);
    if (duplicateRoles.length > 0) {
      return deny(
        ReasonCode.VERIFICATION_GAP,
        "candidate maps a verification repository role to more than one identity",
        { runId, duplicateRoles },
      );
    }

    // CP-HI-03 — the pinned contract, not whatever the candidate now contains.
    if (snapshot.contractDigest !== options.contractDigest || run.contractDigest !== options.contractDigest) {
      return deny(
        ReasonCode.CANDIDATE_CANNOT_WEAKEN_CONTRACT,
        "candidate snapshot is pinned to a different contract than the one supplied",
        {
          snapshotContract: snapshot.contractDigest,
          runContract: run.contractDigest,
          supplied: options.contractDigest,
        },
      );
    }

    let commands: readonly VerificationCommand[];
    if (run.pinnedManifestDigest) {
      if (options.runScoped) {
        return deny(
          ReasonCode.CANDIDATE_CANNOT_WEAKEN_CONTRACT,
          "a run with a pinned manifest cannot submit run-scoped commands",
          { runId, pinnedManifestDigest: run.pinnedManifestDigest },
        );
      }
      if (
        (options.pinnedManifestDigest != null && options.pinnedManifestDigest !== run.pinnedManifestDigest) ||
        (options.executionMode != null && options.executionMode !== run.executionMode)
      ) {
        return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "caller assertions do not match the registered run", {
          runId,
          registeredManifestDigest: run.pinnedManifestDigest,
          registeredExecutionMode: run.executionMode,
          suppliedManifestDigest: options.pinnedManifestDigest ?? null,
          suppliedExecutionMode: options.executionMode ?? null,
        });
      }

      // CP-HI-03 — the command set is derived from the dispatch-time manifest. A caller
      // may repeat it for compatibility, but it cannot select a weaker replacement.
      const pinned = this.manifests?.(run.pinnedManifestDigest) ?? null;
      if (!pinned) {
        // #448: the run's pinned digest exists, but the manifest it names cannot be produced
        // to compare against. That is not a disagreement between two known values — nothing
        // was compared — so it must not report as MISMATCH, which reads as "compared and
        // differs" to anyone matching on the code.
        return deny(ReasonCode.CONTRACT_UNVERIFIED, "pinned manifest is not retrievable", {
          runId,
          pinnedManifestDigest: run.pinnedManifestDigest,
        });
      }
      const expected = commandsForMode(pinned, run.executionMode);
      if (digestOf(expected) !== digestOf([...options.commands])) {
        return deny(
          ReasonCode.CANDIDATE_CANNOT_WEAKEN_CONTRACT,
          "supplied verification commands do not match the run's pinned manifest",
          {
            runId,
            pinnedManifestDigest: run.pinnedManifestDigest,
            expected: expected.map((c) => c.id),
            supplied: options.commands.map((c) => c.id),
          },
        );
      }
      commands = expected;
      // Every repository in the candidate must also be pinned to that same manifest.
      const mismatched = snapshot.repositories.filter(
        (repo) => repo.manifestDigest !== run.pinnedManifestDigest,
      );
      if (mismatched.length > 0) {
        return deny(
          ReasonCode.CONTRACT_DIGEST_MISMATCH,
          "a repository in the candidate is pinned to a different manifest than the run",
          {
            runId,
            pinnedManifestDigest: run.pinnedManifestDigest,
            mismatched: mismatched.map((r) => ({ identity: r.identity, manifestDigest: r.manifestDigest })),
          },
        );
      }
    } else {
      if (!options.runScoped) {
        return deny(ReasonCode.VERIFICATION_GAP, "run-scoped commands require a temporary repository run", {
          runId,
        });
      }
      commands = options.commands;
    }

    const records = snapshot.repositories.map((repo) => ({
      repo,
      record: this.repositories.byIdentity(repo.identity),
    }));
    for (const { repo, record } of records) {
      if (!record) continue;
      if (record.trustClass !== "OWNER_TRUSTED") {
        return deny(ReasonCode.VERIFICATION_REPOSITORY_UNTRUSTED, "repository is not owner-trusted", {
          runId,
          identity: repo.identity,
          trustClass: record.trustClass,
        });
      }
      if (record.registration === "TEMPORARY" && record.temporaryForRun !== runId) {
        return deny(ReasonCode.VERIFICATION_GAP, "temporary repository is bound to a different run", {
          runId,
          identity: repo.identity,
          temporaryForRun: record.temporaryForRun,
        });
      }
    }
    if (!run.pinnedManifestDigest) {
      const invalidScopedRepository = records.find(
        ({ repo, record }) =>
          !record ||
          record.registration !== "TEMPORARY" ||
          record.temporaryForRun !== runId ||
          record.activeManifestDigest !== null ||
          repo.manifestDigest !== null,
      );
      if (invalidScopedRepository) {
        return deny(
          ReasonCode.VERIFICATION_GAP,
          "run-scoped commands require repositories temporary to this run with no pinned manifest",
          {
            runId,
            identity: invalidScopedRepository.repo.identity,
            registration: invalidScopedRepository.record?.registration ?? null,
            temporaryForRun: invalidScopedRepository.record?.temporaryForRun ?? null,
            activeManifestDigest: invalidScopedRepository.record?.activeManifestDigest ?? null,
            snapshotManifestDigest: invalidScopedRepository.repo.manifestDigest,
          },
        );
      }

      // §17.5 has no project manifest to pin at dispatch, so the first usable
      // run-scoped command set becomes this run's immutable verification contract.
      // A retry may re-submit it verbatim, but cannot replace a real failing suite with
      // a weaker argv after observing the first result.
      const scoped = this.pinRunScopedCommands(runId, commands);
      if (!scoped.allowed) return scoped as Decision<VerificationReport>;
      commands = scoped.value;
    }

    const verifiedOptions: VerifyOptions = { ...options, commands };

    const probes = records.map(({ repo, record }) => {
      return {
        identity: repo.identity,
        checkoutPath: record?.checkoutPath ?? "",
        activeManifestDigest: record?.activeManifestDigest ?? null,
      };
    });
    const fresh = await verifySnapshotFreshness(snapshot, probes.filter((p) => p.checkoutPath));
    if (!fresh.allowed) return fresh as Decision<VerificationReport>;

    if (commands.length === 0) {
      // §17.5 — no defensible verification method is a declared gap, not a pass.
      const report = this.buildReport(verifiedOptions, snapshotDigest, [], [
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
      const matchingRepositories = snapshot.repositories.filter(
        (repository) => repository.repositoryRole === command.repositoryRole,
      );
      if (matchingRepositories.length !== 1) {
        gaps.push(
          `command '${command.id}' targets repositoryRole '${command.repositoryRole}' which does not map to exactly one candidate repository`,
        );
        continue;
      }
      const repo = matchingRepositories[0]!;
      const record = this.repositories.byIdentity(repo.identity);
      if (!record) {
        gaps.push(`repository '${repo.identity}' has no local binding`);
        continue;
      }

      if (command.evidenceMode !== "TRUSTED_CI") {
        const claim = this.ensureVerificationClaim(run, repo.identity);
        if (!claim.allowed) return claim as Decision<VerificationReport>;
        results.push(await this.runLocal(
          run,
          snapshotDigest,
          command,
          repo.identity,
          record.checkoutPath,
          repo.candidateHead,
          repo.sourceBranch ?? null,
        ));
      }
      if (command.evidenceMode !== "LOCAL_COMMAND") {
        results.push(await this.collectCi(runId, snapshotDigest, command, repo.identity, repo.candidateHead));
      }
    }

    // §16.2 — the commands ran against a detached worktree, but the source may have moved
    // while they ran. A PASS for a candidate that no longer exists is not evidence.
    const stillFresh = await verifySnapshotFreshness(snapshot, probes.filter((p) => p.checkoutPath));
    if (!stillFresh.allowed) {
      const staleReport = this.buildReport(verifiedOptions, snapshotDigest, results, [
        ...gaps,
        "the candidate changed while verification was running",
      ]);
      this.persist(runId, snapshotDigest, staleReport);
      return stillFresh as Decision<VerificationReport>;
    }

    const report = this.buildReport(verifiedOptions, snapshotDigest, results, gaps);
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

  /** Persist and retrieve the §17.5 contract without treating a caller's argv as durable authority. */
  private pinRunScopedCommands(
    runId: string,
    supplied: readonly VerificationCommand[],
  ): Decision<readonly VerificationCommand[]> {
    const parsed = verificationCommandSchema.array().safeParse([...supplied]);
    if (!parsed.success) {
      return deny(ReasonCode.INVALID_ARGUMENT, "run-scoped verification commands are malformed", {
        runId,
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    const proposed = parsed.data;
    const proposedDigest = digestOf(proposed);

    // #664 — every denial below this line is a decision about the pin this body just
    // wrote (or found already written); none of it is housekeeping a caller relies on
    // regardless of the outcome, so a denial must roll the pin attempt back.
    return this.db.txDecision(() => {
      const current = this.db.get<{
        pinned_run_scoped_commands_digest: string | null;
        pinned_run_scoped_commands_json: string | null;
      }>(
        `SELECT pinned_run_scoped_commands_digest, pinned_run_scoped_commands_json
           FROM runs WHERE run_id = ?`,
        [runId],
      );
      if (!current) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });

      if (
        current.pinned_run_scoped_commands_digest === null &&
        current.pinned_run_scoped_commands_json === null
      ) {
        this.db.run(
          `UPDATE runs
              SET pinned_run_scoped_commands_digest = ?, pinned_run_scoped_commands_json = ?
            WHERE run_id = ?
              AND pinned_run_scoped_commands_digest IS NULL
              AND pinned_run_scoped_commands_json IS NULL`,
          [proposedDigest, canonicalJson(proposed), runId],
        );
      }

      const pinned = this.db.get<{
        pinned_run_scoped_commands_digest: string | null;
        pinned_run_scoped_commands_json: string | null;
      }>(
        `SELECT pinned_run_scoped_commands_digest, pinned_run_scoped_commands_json
           FROM runs WHERE run_id = ?`,
        [runId],
      );
      if (
        !pinned ||
        pinned.pinned_run_scoped_commands_digest === null ||
        pinned.pinned_run_scoped_commands_json === null
      ) {
        return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "run-scoped verification contract was not durably pinned", {
          runId,
        });
      }

      let persisted: readonly VerificationCommand[];
      try {
        const decoded: unknown = JSON.parse(pinned.pinned_run_scoped_commands_json);
        const parsedPersisted = verificationCommandSchema.array().safeParse(decoded);
        if (!parsedPersisted.success) {
          return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "stored run-scoped verification contract is malformed", {
            runId,
          });
        }
        persisted = parsedPersisted.data;
      } catch {
        return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "stored run-scoped verification contract is malformed", {
          runId,
        });
      }

      const persistedDigest = digestOf(persisted);
      if (persistedDigest !== pinned.pinned_run_scoped_commands_digest) {
        return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "stored run-scoped verification contract digest is invalid", {
          runId,
          stored: pinned.pinned_run_scoped_commands_digest,
          calculated: persistedDigest,
        });
      }
      if (proposedDigest !== persistedDigest) {
        return deny(
          ReasonCode.CANDIDATE_CANNOT_WEAKEN_CONTRACT,
          "supplied run-scoped verification commands do not match the run's pinned contract",
          {
            runId,
            pinnedDigest: persistedDigest,
            suppliedDigest: proposedDigest,
            expected: persisted.map((command) => command.id),
            supplied: proposed.map((command) => command.id),
          },
        );
      }
      return allow(ReasonCode.OK, persisted);
    });
  }

  private async runLocal(
    run: RunRow,
    snapshotDigest: string,
    command: VerificationCommand,
    identity: string,
    checkoutPath: string,
    head: string,
    sourceBranch: string | null,
  ): Promise<VerificationResultRecord> {
    const runId = run.runId;
    const worktreeId = `verify-${runId}-${command.id}-${head.slice(0, 8)}-${randomUUID().replaceAll("-", "")}`;
    const path = this.worktrees.pathFor(worktreeId);
    const authorization = this.worktreeAuthorization(
      run,
      identity,
      checkoutPath,
      path,
      sourceBranch,
    );
    this.recordVerificationWorktree({
      worktreeId,
      runId,
      commandId: command.id,
      candidateSnapshotDigest: snapshotDigest,
      repositoryIdentity: identity,
      repositoryCheckoutPath: checkoutPath,
      worktreePath: path,
      head,
      ownerSessionId: run.ownerSessionId,
      ownerBindingGeneration: run.ownerBindingGeneration,
      ownerRoleKey: run.ownerRoleKey,
    });

    let worktree: Awaited<ReturnType<WorktreeManager["create"]>> | null = null;
    let outcome: Awaited<ReturnType<typeof runSandboxed>> | null = null;
    try {
      worktree = await this.worktrees.create(checkoutPath, head, worktreeId, authorization);
      this.updateVerificationWorktree(worktreeId, "ACTIVE", "active_at");
      outcome = await runSandboxed({
        command,
        worktreePath: worktree.path,
        // §33.3 — the control plane's own secret store and state must be unreadable to a
        // candidate, as must every other checkout on this machine.
        denyReadPaths: this.denyReadPaths(checkoutPath),
      });
    } finally {
      if (worktree) {
        this.updateVerificationWorktree(worktreeId, "DESTROYING");
        try {
          await this.worktrees.destroy(checkoutPath, worktree.path, authorization);
          this.updateVerificationWorktree(worktreeId, "DESTROYED", "ended_at");
        } catch (error) {
          // Keep DESTROYING durable: repair must see that teardown was interrupted and
          // re-evaluate ownership before touching the path.
          throw error;
        }
      } else {
        this.updateVerificationWorktree(worktreeId, "FAILED", "ended_at");
      }
    }
    if (!outcome) {
      throw new Error("verification sandbox did not produce an outcome");
    }
    const memoryFailure = memoryEvidenceReason(outcome.peakRssMb, command.maxMemoryMb);
    const passingMemoryFailure = outcome.status === "PASS" ? memoryFailure : null;

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
      // Truncated output or unmeasured/over-cap memory is not usable passing evidence.
      status:
        outcome.status === "PASS" && (outcome.outputTruncated || passingMemoryFailure !== null)
          ? "ERROR"
          : outcome.status,
      reasonCode: passingMemoryFailure ?? outcome.reasonCode,
      peakRssMb: outcome.peakRssMb,
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

    // Filter to this command and this repository, but *not* by head: a result for another
    // head must be reported as a head mismatch rather than as missing evidence.
    const candidates = checks.filter(
      (c) => c.commandId === command.id && c.repositoryIdentity === identity,
    );
    const exactHead = candidates.filter((candidate) => candidate.head === head);
    // Integration §14.4 — the *current exact-head* result. An obsolete red result must
    // not hide a later green result, and a result from another head is only diagnostic
    // when there is no exact candidate evidence at all.
    const ordered = [...exactHead].sort(
      (a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime(),
    );
    const match = ordered[0];
    if (!match) {
      const record = {
        ...base,
        reasonCode:
          candidates.length > 0 ? ReasonCode.VERIFICATION_CI_HEAD_MISMATCH : ReasonCode.EVIDENCE_MISSING,
      };
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

  private ensureVerificationClaim(
    run: RunRow,
    repositoryIdentity: string,
  ): Decision<void> {
    const existing = this.claims.heldByRun(run.runId).some(
      (claim) => claim.repositoryIdentity === repositoryIdentity,
    );
    if (existing) return allow(ReasonCode.OK, undefined);
    if (!run.ownerSessionId || run.ownerBindingGeneration == null || !run.ownerRoleKey) {
      return deny(ReasonCode.WRITE_REQUIRES_MANAGED_RUN, "verification worktree requires a pinned run owner", {
        runId: run.runId,
        repositoryIdentity,
      });
    }
    const acquired = this.claims.acquire({
      runId: run.runId,
      ownerSessionId: run.ownerSessionId,
      ownerBindingGeneration: run.ownerBindingGeneration,
      ownerRoleKey: run.ownerRoleKey,
      repositoryIdentity,
      branch: null,
      // ClaimRegistry stores repository-relative paths as non-empty components; this
      // run-specific coordination path is only the worktree-lifecycle lease, not an
      // assertion about candidate files or the branch a later GitHub write will target.
      declaredPaths: [`__verification_worktree__/${run.runId}`],
    });
    if (!acquired.allowed) return acquired as Decision<void>;
    return allow(ReasonCode.OK, undefined);
  }

  private worktreeAuthorization(
    run: RunRow,
    repositoryIdentity: string,
    checkoutPath: string,
    path: string,
    sourceBranch: string | null,
  ): WorktreeAuthorization {
    const common = {
      guard: this.guard,
      request: {
        operation: WriteOperation.GIT_WORKTREE,
        repositoryIdentity,
        // This is the disposable tree being created, not the registered source checkout.
        // Repository identity supplies the claim scope; using the checkout here would make
        // every concurrent verification of the same repository collide by construction.
        targetWorktreeId: path,
        targetBranch: sourceBranch,
        runId: run.runId,
        sessionId: run.ownerSessionId,
        bindingGeneration: run.ownerBindingGeneration,
        claimedClassification: "MANAGED" as const,
        actor: "verification-engine",
      },
    };
    return {
      add: { ...common, request: { ...common.request, targetPath: path, worktreeAction: WorktreeAction.ADD } },
      remove: { ...common, request: { ...common.request, targetPath: path, worktreeAction: WorktreeAction.REMOVE } },
      cleanup: { ...common, request: { ...common.request, targetPath: path, worktreeAction: WorktreeAction.CLEANUP } },
      prune: { ...common, request: { ...common.request, targetPath: checkoutPath, worktreeAction: WorktreeAction.PRUNE } },
    };
  }

  private recordVerificationWorktree(input: {
    worktreeId: string;
    runId: string;
    commandId: string;
    candidateSnapshotDigest: string;
    repositoryIdentity: string;
    repositoryCheckoutPath: string;
    worktreePath: string;
    head: string;
    ownerSessionId: string | null;
    ownerBindingGeneration: number | null;
    ownerRoleKey: string | null;
  }): void {
    if (!input.ownerSessionId || input.ownerBindingGeneration == null || !input.ownerRoleKey) {
      throw new Error("verification worktree requires a pinned run owner");
    }
    this.db.run(
      `INSERT INTO verification_worktrees
         (worktree_id, run_id, command_id, candidate_snapshot_digest, repository_identity,
          repository_checkout_path, worktree_path, head, owner_session_id,
          owner_binding_generation, owner_role_key, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATING', ?)`,
      [
        input.worktreeId,
        input.runId,
        input.commandId,
        input.candidateSnapshotDigest,
        input.repositoryIdentity,
        input.repositoryCheckoutPath,
        input.worktreePath,
        input.head,
        input.ownerSessionId,
        input.ownerBindingGeneration,
        input.ownerRoleKey,
        this.clock.nowIso(),
      ],
    );
  }

  private updateVerificationWorktree(
    worktreeId: string,
    state: "ACTIVE" | "DESTROYING" | "DESTROYED" | "FAILED",
    timestampColumn?: "active_at" | "ended_at",
  ): void {
    if (timestampColumn) {
      this.db.run(
        `UPDATE verification_worktrees SET state = ?, ${timestampColumn} = ? WHERE worktree_id = ?`,
        [state, this.clock.nowIso(), worktreeId],
      );
      return;
    }
    this.db.run(`UPDATE verification_worktrees SET state = ? WHERE worktree_id = ?`, [state, worktreeId]);
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
    const commandsById = new Map(options.commands.map((command) => [command.id, command]));
    const localMemoryFailure = (record: VerificationResultRecord): ReasonCode | null => {
      if (record.source !== "local") return null;
      const command = commandsById.get(record.commandId);
      return command ? memoryEvidenceReason(record.peakRssMb, command.maxMemoryMb) : null;
    };

    // This is a second fail-closed gate over the sandbox result. A future sandbox regression
    // must not turn a missing RSS observation into authoritative PASS evidence.
    const failed = results.filter(
      (record) =>
        requiredIds.has(record.commandId) &&
        (record.status !== "PASS" || localMemoryFailure(record) !== null),
    );
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
        ? (failed[0]!.reasonCode ?? localMemoryFailure(failed[0]!) ?? ReasonCode.VERIFICATION_COMMAND_FAILED)
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
    this.artifacts.putEvidence(
      this.evidenceWriter,
      runId,
      ArtifactKind.VERIFICATION,
      report,
      snapshotDigest,
    );
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

  /** Absolute paths a candidate command must not read (§33.3). */
  private denyReadPaths(ownCheckout: string): string[] {
    const others = this.repositories
      .list()
      .map((r) => r.checkoutPath)
      .filter(Boolean);
    return [...new Set([ownCheckout, ...others, ...this.extraDenyReadPaths])];
  }

  /** Wired by the composition root: the secret store and state directory. */
  setDenyReadPaths(paths: readonly string[]): void {
    this.extraDenyReadPaths = [...paths];
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
