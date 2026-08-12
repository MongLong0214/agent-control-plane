import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

import { type Clock, systemClock } from "../core/clock.ts";
import { CapacityMonitor, type CapacityOptions } from "../capacity/capacity-monitor.ts";
import { ClaimRegistry } from "../claims/claim-registry.ts";
import { ContinuityKernel } from "../continuity/continuity-kernel.ts";
import { CtoLifecycle, type CtoPreference } from "../cto/cto-lifecycle.ts";
import { ProductionGate } from "../ceo/production-gate.ts";
import { AuditLog } from "../db/audit.ts";
import { ArtifactStore } from "../db/artifacts.ts";
import { Db } from "../db/database.ts";
import { ManagedWriteGuard } from "../guard/managed-write-guard.ts";
import { type WorkspaceProbe, realWorkspaceProbe } from "../guard/workspace-probe.ts";
import { Outbox } from "../outbox/outbox.ts";
import { ProjectRegistry } from "../registry/project-registry.ts";
import { RepositoryRegistry } from "../registry/repository-registry.ts";
import { BlindReviewGate, type ReviewerPreference } from "../review/blind-review.ts";
import { CandidatePipeline } from "../run/candidate-pipeline.ts";
import { RunEngine } from "../run/run-engine.ts";
import { TaskGraph } from "../run/task-graph.ts";
import { ClaudeCliAdapter, CodexCliAdapter } from "../runtime/cli-adapters.ts";
import { type ProviderAdapter, ProviderRegistry } from "../runtime/provider.ts";
import { BindingRegistry } from "../session/binding-registry.ts";
import { SessionRegistry } from "../session/session-registry.ts";
import { Telemetry } from "../telemetry/telemetry.ts";
import { VerificationEngine } from "../verify/verification-engine.ts";
import { WorktreeManager } from "../verify/worktree.ts";
import { GitHubKernel, type GitHubClient } from "../github/github-kernel.ts";
import { OwnerAuthority, type OwnerIdentity } from "../ceo/owner-authority.ts";
import { TrustedCredentialStore } from "../github/credential-store.ts";
import { Doctor } from "../doctor/doctor.ts";
import { Watchdog } from "../doctor/watchdog.ts";
import { RepairService } from "../doctor/repair.ts";
import { BootstrapActivation } from "../bootstrap/activation.ts";

export interface ControlPlaneConfig {
  databasePath: string;
  /**
   * Identities that may act as the owner (§21). Empty means this deployment has no owner
   * identity, so no human gate can be satisfied — an explicit absence, never an implicit
   * grant.
   */
  ownerIdentities?: readonly OwnerIdentity[];
  /** Root under which disposable verification worktrees are created. */
  worktreeRoot: string;
  /** Directory holding the structured local capacity files, one per provider. */
  capacityDir: string;
  /** Directory holding the trusted GitHub credential. Daemon-only (CP-HI-05). */
  secretsDir: string;
  ctoPreference?: CtoPreference;
  reviewer?: { preferred: ReviewerPreference; fallbacks: ReviewerPreference[] };
  capacity?: CapacityOptions;
  /** Adapters to register. Real CLI adapters are registered unless replaced. */
  adapters?: ProviderAdapter[];
  /**
   * Permits binding a role to an adapter that fabricates responses. Off by default, so
   * a deterministic test double cannot become a production path by configuration
   * accident. Scenario suites set it explicitly.
   */
  allowNonProductionAdapters?: boolean;
  clock?: Clock;
  workspaceProbe?: WorkspaceProbe;
  githubClient?: GitHubClient;
}

export const defaultConfig = (root = join(homedir(), ".agent-control-plane")): ControlPlaneConfig => ({
  databasePath: join(root, "state.sqlite"),
  worktreeRoot: join(root, "worktrees"),
  capacityDir: join(root, "capacity"),
  secretsDir: join(root, "secrets"),
  // §21 — owner identities are declared out of band, one per line as `channel:actor` in
  // `<root>/owner-identities`. An absent or empty file means this deployment has no owner,
  // so no human gate can be satisfied; that is the safe reading, not a permissive one.
  ownerIdentities: readOwnerIdentities(join(root, "owner-identities")),
});

const readOwnerIdentities = (file: string): OwnerIdentity[] => {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .flatMap((line) => {
      const at = line.indexOf(":");
      if (at <= 0) return [];
      return [{ channel: line.slice(0, at), actor: line.slice(at + 1) }];
    });
};

/**
 * Composition root.
 *
 * Several services legitimately need each other — the run engine asks the CTO
 * lifecycle to provision, the CTO lifecycle asks the run engine about active runs — so
 * the cycles are closed here with narrow `attach` ports rather than by merging the
 * services into one object with unclear authority.
 */
export class ControlPlane {
  readonly db: Db;
  readonly clock: Clock;
  readonly audit: AuditLog;
  readonly artifacts: ArtifactStore;
  readonly telemetry: Telemetry;
  readonly outbox: Outbox;
  readonly projects: ProjectRegistry;
  readonly repositories: RepositoryRegistry;
  readonly sessions: SessionRegistry;
  readonly bindings: BindingRegistry;
  readonly claims: ClaimRegistry;
  readonly providers: ProviderRegistry;
  readonly worktrees: WorktreeManager;
  readonly guard: ManagedWriteGuard;
  readonly tasks: TaskGraph;
  readonly runs: RunEngine;
  readonly verification: VerificationEngine;
  readonly review: BlindReviewGate;
  readonly capacity: CapacityMonitor;
  readonly continuity: ContinuityKernel;
  readonly ownerAuthority: OwnerAuthority;
  readonly cto: CtoLifecycle;
  readonly ceo: ProductionGate;
  readonly pipeline: CandidatePipeline;
  readonly credentials: TrustedCredentialStore;
  readonly github: GitHubKernel;
  readonly doctor: Doctor;
  readonly watchdog: Watchdog;
  readonly repair: RepairService;
  readonly bootstrap: BootstrapActivation;

  constructor(readonly config: ControlPlaneConfig) {
    this.clock = config.clock ?? systemClock;
    this.db = new Db(config.databasePath);
    this.audit = new AuditLog(this.db, this.clock);
    this.artifacts = new ArtifactStore(this.db, this.clock);
    this.telemetry = new Telemetry(this.db, this.clock);
    this.outbox = new Outbox(this.db, this.clock, this.audit);

    this.projects = new ProjectRegistry(this.db, this.clock, this.audit);
    this.repositories = new RepositoryRegistry(this.db, this.clock, this.audit);
    this.sessions = new SessionRegistry(this.db, this.clock, this.audit);
    this.bindings = new BindingRegistry(this.db, this.clock, this.audit, this.sessions, this.outbox);
    this.claims = new ClaimRegistry(this.db, this.clock, this.audit, this.bindings);

    this.providers = new ProviderRegistry();
    for (const adapter of config.adapters ?? this.defaultAdapters()) {
      if (!adapter.isProduction && !config.allowNonProductionAdapters) {
        throw new Error(
          `adapter '${adapter.provider}' fabricates responses; set allowNonProductionAdapters to register it`,
        );
      }
      this.providers.register(adapter);
    }

    this.worktrees = new WorktreeManager(config.worktreeRoot);
    this.guard = new ManagedWriteGuard(
      this.db,
      config.workspaceProbe ?? realWorkspaceProbe,
      this.audit,
      this.clock,
    );
    this.tasks = new TaskGraph(this.db, this.clock, this.audit, this.telemetry);
    this.runs = new RunEngine(
      this.db, this.clock, this.audit, this.artifacts, this.outbox,
      this.projects, this.repositories, this.tasks, this.claims, this.telemetry,
    );
    this.verification = new VerificationEngine(
      this.db, this.clock, this.audit, this.artifacts, this.repositories, this.worktrees, this.telemetry,
    );
    this.review = new BlindReviewGate(
      this.clock, this.audit, this.artifacts, this.sessions, this.bindings,
      this.providers, this.repositories, this.telemetry,
      config.reviewer ?? {
        preferred: { provider: "gpt", model: "gpt-5.6-sol", effort: "xhigh" },
        fallbacks: [{ provider: "claude", model: "opus", effort: null }],
      },
    );
    this.capacity = new CapacityMonitor(
      this.db, this.clock, this.audit, this.providers, this.telemetry, config.capacity,
    );
    this.continuity = new ContinuityKernel(
      this.db, this.clock, this.audit, this.capacity, this.providers,
      this.projects, this.runs, this.sessions, this.bindings, this.telemetry,
    );
    this.cto = new CtoLifecycle(
      this.db, this.clock, this.audit, this.projects, this.sessions, this.bindings,
      this.providers, this.outbox, this.runs,
      config.ctoPreference ?? { provider: "claude", model: "opus", effort: null },
    );
    this.ceo = new ProductionGate(
      this.db, this.clock, this.audit, this.artifacts, this.runs, this.tasks,
      this.bindings, this.outbox, this.telemetry,
    );

    this.pipeline = new CandidatePipeline(
      this.clock, this.audit, this.artifacts, this.runs, this.tasks, this.projects,
      this.repositories, this.verification, this.review, this.ceo, this.bindings, this.outbox,
      this.telemetry,
    );

    this.credentials = new TrustedCredentialStore(config.secretsDir);
    this.github = new GitHubKernel(
      this.db, this.clock, this.audit, this.artifacts, this.credentials,
      this.repositories, this.runs, this.projects, this.guard,
      ...(config.githubClient ? [config.githubClient] : []),
    );
    this.verification.attachCi(this.github.ciEvidenceSource());
    this.verification.attachManifests((digest) => this.projects.manifest(digest));
    // The database *file*, not its directory: the worktree root lives beside it, and
    // denying the parent would stop a verification command from reading its own worktree.
    this.verification.setDenyReadPaths([config.secretsDir, config.databasePath]);

    this.repair = new RepairService(this.db, this.clock, this.audit, this.artifacts, this.claims, this.worktrees, this.repositories);
    this.doctor = new Doctor(
      this.db, this.clock, this.audit, this.projects, this.repositories, this.sessions,
      this.bindings, this.runs, this.tasks, this.claims, this.capacity, this.continuity,
      this.outbox, this.github, this.worktrees,
    );
    this.watchdog = new Watchdog(this.db, this.clock, this.audit, this.doctor, this.claims, this.outbox);
    this.bootstrap = new BootstrapActivation(
      this.db, this.clock, this.audit, this.artifacts, this.projects, this.repositories,
      this.runs, this.bindings, this.sessions, this.cto, this.doctor, this.ceo, this.outbox,
    );

    // Close the dependency cycles with narrow ports.
    this.runs.attach({
      cto: {
        ensurePrimaryCto: (projectId, runId) => this.cto.ensurePrimaryCto(projectId, runId),
        isDraining: (projectId) => this.cto.isDraining(projectId),
      },
      capacity: { refreshForDispatch: () => this.capacity.refreshForDispatch() },
      continuity: { mode: () => this.continuity.mode() },
    });
    this.ownerAuthority = new OwnerAuthority(config.ownerIdentities ?? []);
    this.cto.attach({ ownerAuthority: this.ownerAuthority });
    this.repair.attach({ ownerAuthority: this.ownerAuthority });
    this.ceo.attach({
      ownerAuthority: this.ownerAuthority,
      continuity: {
        mode: () => this.continuity.mode(),
        assertCompletionAllowed: (runId) => this.continuity.assertCompletionAllowed(runId),
      },
    });
    this.pipeline.attach({
      continuity: { evaluate: (reason) => this.continuity.evaluate(reason) },
    });
    this.cto.attach({ readiness: { checkSession: (id) => this.doctor.sessionReadiness(id) } });
    this.continuity.attach({ readiness: { checkSession: (id) => this.doctor.sessionReadiness(id) } });
  }

  private defaultAdapters(): ProviderAdapter[] {
    return [
      new ClaudeCliAdapter({
        clock: this.clock,
        capacityFile: join(this.config.capacityDir, "claude.json"),
      }),
      new CodexCliAdapter({
        clock: this.clock,
        capacityFile: join(this.config.capacityDir, "gpt.json"),
      }),
    ];
  }

  close(): void {
    this.db.close();
  }
}
