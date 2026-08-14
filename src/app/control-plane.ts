import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

import { type Clock, systemClock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { manifestDigest, type ProjectManifest } from "../contracts/manifest.ts";
import { CapacityMonitor, type CapacityOptions } from "../capacity/capacity-monitor.ts";
import { ClaimRegistry } from "../claims/claim-registry.ts";
import { ContinuityKernel } from "../continuity/continuity-kernel.ts";
import { CtoLifecycle, type CtoPreference } from "../cto/cto-lifecycle.ts";
import { ProductionGate } from "../ceo/production-gate.ts";
import { AuditLog } from "../db/audit.ts";
import { allow, deny, fail } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { ArtifactStore, type EvidenceWriterSet } from "../db/artifacts.ts";
import { Db } from "../db/database.ts";
import { ensurePrivateDirectory } from "../db/state-preflight.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../domain/types.ts";
import {
  ManagedWriteGuard,
  type BootstrapManifestAuthority,
  type DaemonFinalizerAuthority,
  type RepairWorktreeAuthority,
} from "../guard/managed-write-guard.ts";
import { type WorkspaceProbe, realWorkspaceProbe } from "../guard/workspace-probe.ts";
import { Outbox } from "../outbox/outbox.ts";
import { ProjectRegistry, type ManagedManifestWrite } from "../registry/project-registry.ts";
import { RepositoryRegistry } from "../registry/repository-registry.ts";
import { BlindReviewGate, type ReviewerPreference } from "../review/blind-review.ts";
import { CandidatePipeline } from "../run/candidate-pipeline.ts";
import { type CompletionAuthority, type CompletionAuthoritySet, RunEngine } from "../run/run-engine.ts";
import { TaskGraph } from "../run/task-graph.ts";
import { ClaudeCliAdapter, CodexCliAdapter, GrokCliAdapter } from "../runtime/cli-adapters.ts";
import {
  GuardedInvocationWriteBroker,
  type ProviderAdapter,
  ProviderRegistry,
  REVIEWER_PROVIDER_ENDPOINTS,
  type ReviewerEgressConfig,
} from "../runtime/provider.ts";
import { BindingRegistry } from "../session/binding-registry.ts";
import { SessionRegistry } from "../session/session-registry.ts";
import { Telemetry } from "../telemetry/telemetry.ts";
import { VerificationEngine } from "../verify/verification-engine.ts";
import { WorktreeManager } from "../verify/worktree.ts";
import { GitHubKernel, type GitHubClient, type GitHubKernelOptions } from "../github/github-kernel.ts";
import { OwnerAuthority, type OwnerIdentity } from "../ceo/owner-authority.ts";
import { TrustedCredentialStore } from "../github/credential-store.ts";
import { Doctor } from "../doctor/doctor.ts";
import { Watchdog } from "../doctor/watchdog.ts";
import { RepairService } from "../doctor/repair.ts";
import { BootstrapActivation } from "../bootstrap/activation.ts";
import { Daemon, type DaemonOptions } from "../daemon/daemon.ts";
import type { DaemonFinalizationAuthorities } from "../daemon/finalizer.ts";

export interface ControlPlaneConfig {
  databasePath: string;
  /**
   * Identities that may act as the owner (§21). Empty means this deployment has no owner
   * identity, so no human gate can be satisfied — an explicit absence, never an implicit
   * grant.
   */
  ownerIdentities?: readonly OwnerIdentity[];
  /** Fixtures only: unlocks `evidenceWritersForTests`. The daemon never sets it (#352). */
  allowTestEvidenceWriters?: boolean;
  /** Root under which disposable verification worktrees are created. */
  worktreeRoot: string;
  /** Directory holding the structured local capacity files, one per provider. */
  capacityDir: string;
  /** Directory holding the trusted GitHub credential. Daemon-only (CP-HI-05). */
  secretsDir: string;
  /** Owner-provisioned App metadata, parsed rather than sourced by the daemon. */
  githubAppEnvFile?: string;
  /** Launcher-provided path override for the App private key. */
  githubAppPrivateKeyPath?: string;
  ctoPreference?: CtoPreference;
  reviewer?: { preferred: ReviewerPreference; fallbacks: ReviewerPreference[] };
  capacity?: CapacityOptions;
  /**
   * Paths for daemon-owned, provider-only blind-review egress. The endpoint policy itself
   * lives in `src/runtime/provider.ts`; this points only at owner-provided infrastructure.
   */
  reviewerEgress?: ReviewerEgressConfig;
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
  /**
   * Explicit roots for independent artifacts. Leaving this empty (the production default)
   * denies every DIRECT mutation, so repository bootstrap cannot be misclassified before
   * Git metadata exists.
   */
  directWriteRoots?: readonly string[];
  /**
   * Bounded post-merge observation controls. Production defaults are deliberately
   * non-zero; fixtures provide a short deterministic seam.
   */
  githubKernelOptions?: GitHubKernelOptions;
  githubClient?: GitHubClient;
}

export const defaultConfig = (root = join(homedir(), ".agent-control-plane")): ControlPlaneConfig => ({
  databasePath: join(root, "state.sqlite"),
  worktreeRoot: join(root, "worktrees"),
  capacityDir: join(root, "capacity"),
  secretsDir: join(root, "secrets"),
  reviewerEgress: {
    profilePath: join(root, "egress", "reviewer.sb"),
    proxyPath: join(root, "egress", "allowlist-proxy.py"),
    runtimeDir: join(root, "egress", "runs"),
    port: 18_443,
  },
  githubAppEnvFile: process.env["ACP_GITHUB_APP_ENV_FILE"] ?? join(root, "credentials", "github-app.env"),
  // The env file is the source of the key path. launchd supplies this override only to
  // bind production to its fixed owner-provisioned credential file.
  ...(process.env["ACP_GITHUB_APP_PRIVATE_KEY_PATH"]
    ? { githubAppPrivateKeyPath: process.env["ACP_GITHUB_APP_PRIVATE_KEY_PATH"] }
    : {}),
  // §21 — owner identities are declared out of band, one per line as `channel:actor` in
  // `<root>/owner-identities`. An absent or empty file means this deployment has no owner,
  // so no human gate can be satisfied; that is the safe reading, not a permissive one.
  ownerIdentities: readOwnerIdentities(join(root, "owner-identities")),
});

/**
 * Reads the deployment's declared owner identities, one `channel:actor` per line. Exported
 * so an acceptance run can authorise against the host's real declaration rather than a
 * list the test invented for itself (§21, §42 #3).
 */
export const readOwnerIdentities = (file: string): OwnerIdentity[] => {
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

  /**
   * The evidence writer capabilities, minted here and nowhere else. Kept in a `#private`
   * field so holding a `ControlPlane` — or the artifact store it exposes — does not confer
   * the authority to write evidence (#70). Each is handed to the single engine that owns
   * its kind at construction; the two still awaiting the constructor change are held here
   * unspent, which is why those engines' writes are refused rather than name-authenticated.
   */
  /**
   * The evidence-writing capabilities, claimed once at construction (#70).
   *
   * Private, because the earlier justification for exposing it was wrong: the MCP servers
   * receive the whole composition root, so a public field put the capabilities one property
   * access away from a tool handler (#352). A test that must write evidence directly asks
   * for them through `evidenceWritersForTests`, which the daemon's own configuration never
   * unlocks.
   */
  readonly #evidenceWriters: EvidenceWriterSet;
  /** #371 — completion is a capability; the gate and bootstrap activation each hold one. */
  readonly #completionAuthorities: CompletionAuthoritySet;
  /** The daemon's one non-forgeable admission to post-CEO GitHub writes. */
  readonly #daemonFinalizerAuthority: DaemonFinalizerAuthority;
  readonly #repairWorktreeAuthority: RepairWorktreeAuthority;
  readonly #bootstrapManifestAuthority: BootstrapManifestAuthority;

  /**
   * The capabilities, for a caller that constructed this control plane *as a fixture*.
   *
   * Gated by construction, not by convention: `allowTestEvidenceWriters` is a constructor
   * input, so a request path that gets hold of this object later cannot turn it on. The
   * daemon never sets it, which is what makes the gate meaningful rather than decorative.
   */
  /**
   * The completion capabilities, for a caller that built this control plane *as a fixture* —
   * gated by the same constructor input as `evidenceWritersForTests`, which the daemon never
   * sets. A test that completed a run by passing the string "production-gate" was performing
   * the forgery #371 describes.
   */
  completionAuthoritiesForTests(): CompletionAuthoritySet {
    if (!this.config.allowTestEvidenceWriters) {
      fail(ReasonCode.COMPLETION_AUTHORITY_DENIED, "completion authorities are not available to this deployment", {});
    }
    return this.#completionAuthorities;
  }

  evidenceWritersForTests(): EvidenceWriterSet {
    if (!this.config.allowTestEvidenceWriters) {
      fail(
        ReasonCode.COMPLETION_AUTHORITY_DENIED,
        "evidence writer capabilities are not available to this deployment",
        {},
      );
    }
    return this.#evidenceWriters;
  }

  /** Fixture-only proof for the initial manifest before a managed bootstrap run exists. */
  manifestAuthorizationForTests(manifest: ProjectManifest): ManagedManifestWrite {
    if (!this.config.allowTestEvidenceWriters) {
      fail(ReasonCode.WRITE_REQUIRES_MANAGED_RUN, "bootstrap manifest authorization is not available to this deployment", {});
    }
    return {
      projectId: manifest.projectId,
      runId: null,
      sessionId: null,
      bindingGeneration: null,
      expectedManifestDigest: manifestDigest(manifest),
      bootstrapManifestAuthority: this.#bootstrapManifestAuthority,
    };
  }

  /**
   * Narrow daemon-only composition input. MCP ports receive function-only surfaces and never
   * this capability; a raw actor string is deliberately insufficient at the guard boundary.
   */
  daemonFinalizationAuthorities(): {
    readonly write: DaemonFinalizerAuthority;
    readonly completion: CompletionAuthority;
  } {
    if (!this.config.allowTestEvidenceWriters) {
      fail(
        ReasonCode.COMPLETION_AUTHORITY_DENIED,
        "daemon finalization authorities are only exposed to an explicitly unlocked fixture",
        {},
      );
    }
    return Object.freeze({
      write: this.#daemonFinalizerAuthority,
      completion: this.#completionAuthorities.daemonFinalizer,
    });
  }

  /**
   * Production daemon construction is the only non-test path that receives the private
   * finalization capabilities. The returned Daemon owns the lock that gates their use; no
   * request-facing object receives the bundle.
   */
  createDaemon(options: DaemonOptions): Daemon {
    const authorities: DaemonFinalizationAuthorities = {
      write: this.#daemonFinalizerAuthority,
      completion: this.#completionAuthorities.daemonFinalizer,
    };
    return new Daemon(this, options, authorities);
  }

  constructor(readonly config: ControlPlaneConfig) {
    this.clock = config.clock ?? systemClock;
    // These roots are trusted before any service is constructed. Db and WorktreeManager
    // independently verify their own paths too; keeping the composition root explicit
    // closes direct credential/capacity entry points before they can create a permissive dir.
    ensurePrivateDirectory(config.secretsDir);
    ensurePrivateDirectory(config.capacityDir);
    this.credentials = new TrustedCredentialStore(config.secretsDir, {
      ...(config.githubAppEnvFile ? { appEnvFile: config.githubAppEnvFile } : {}),
      ...(config.githubAppPrivateKeyPath ? { privateKeyPath: config.githubAppPrivateKeyPath } : {}),
    });
    this.db = new Db(config.databasePath);
    this.audit = new AuditLog(this.db, this.clock);
    this.artifacts = new ArtifactStore(this.db, this.clock);
    // Claimed immediately: issuance succeeds once per database, so claiming here is what
    // makes every later claim — by any component that reaches this store — fail.
    this.#evidenceWriters = this.artifacts.issueEvidenceWriters();
    this.telemetry = new Telemetry(this.db, this.clock);
    this.outbox = new Outbox(this.db, this.clock, this.audit);

    // Construct this before the default runtime adapters. A writable CLI process is never
    // handed an unconstrained checkout: the adapters receive this exact guard-backed broker
    // and invoke it immediately around process launch (CP-HI-01).
    this.guard = new ManagedWriteGuard(
      this.db,
      config.workspaceProbe ?? realWorkspaceProbe,
      this.audit,
      this.clock,
      { directWriteRoots: config.directWriteRoots },
    );
    // Claim before any request-facing service is assembled. A second component cannot mint
    // itself a daemon identity after it has obtained the composition root.
    this.#daemonFinalizerAuthority = this.guard.claimDaemonFinalizerAuthority();
    this.#repairWorktreeAuthority = this.guard.claimRepairWorktreeAuthority();
    this.#bootstrapManifestAuthority = this.guard.claimBootstrapManifestAuthority();

    this.projects = new ProjectRegistry(this.db, this.clock, this.audit, this.guard);
    this.repositories = new RepositoryRegistry(this.db, this.clock, this.audit);
    this.sessions = new SessionRegistry(this.db, this.clock, this.audit);
    this.bindings = new BindingRegistry(this.db, this.clock, this.audit, this.sessions, this.outbox);
    this.claims = new ClaimRegistry(this.db, this.clock, this.audit, this.bindings);

    this.providers = new ProviderRegistry();
    for (const adapter of config.adapters ?? this.defaultAdapters()) {
      if (adapter.isProduction) this.providers.register(adapter);
      else if (config.allowNonProductionAdapters) this.providers.registerTestAdapter(adapter);
      else {
        throw new Error(`adapter '${adapter.provider}' fabricates responses; it is test-only`);
      }
    }

    this.worktrees = new WorktreeManager(config.worktreeRoot);
    this.tasks = new TaskGraph(this.db, this.clock, this.audit, this.telemetry);
    this.tasks.attach({
      workerBindings: {
        hasLiveWorkerBinding: (taskId, sessionId) => {
          const binding = this.bindings.active(roleKeyFor(Role.WORKER, { taskId }));
          const session = this.sessions.get(sessionId);
          return Boolean(
            binding &&
              binding.role === Role.WORKER &&
              binding.taskId === taskId &&
              binding.sessionId === sessionId &&
              session?.lifecycle === SessionLifecycle.READY,
          );
        },
      },
    });
    this.bindings.attach({ tasks: this.tasks });
    this.runs = new RunEngine(
      this.db, this.clock, this.audit, this.artifacts, this.outbox,
      this.projects, this.repositories, this.tasks, this.claims, this.telemetry,
    );
    this.#completionAuthorities = this.runs.issueCompletionAuthorities();
    this.verification = new VerificationEngine(
      this.db, this.clock, this.audit, this.artifacts, this.#evidenceWriters.VERIFICATION,
      this.repositories, this.worktrees, this.claims, this.guard, this.telemetry,
    );
    this.review = new BlindReviewGate(
      this.clock, this.db, this.audit, this.artifacts, this.#evidenceWriters.BLIND_REVIEW,
      this.sessions, this.bindings, this.providers, this.repositories, this.telemetry,
      config.reviewer ?? {
        preferred: { provider: "gpt", model: "gpt-5.6-sol", effort: "xhigh" },
        fallbacks: [{ provider: "claude", model: "opus", effort: null }],
      },
      config.reviewerEgress?.providerEndpoints ?? REVIEWER_PROVIDER_ENDPOINTS,
    );
    this.capacity = new CapacityMonitor(
      this.db, this.clock, this.audit, this.providers, this.telemetry, config.capacity,
    );
    // Provider operations must observe capacity through the same monitor that dispatch
    // uses; otherwise the runtime wrapper is present but no production adapter reaches it.
    this.providers.attachCapacity(this.capacity);
    this.tasks.attach({
      capacity: {
        refreshForWorkerFanout: (target) => this.capacity.refreshForWorkerFanout(target),
        workerReserveDemand: (provider) => this.capacity.workerReserveDemand(provider),
      },
    });
    this.review.attach({
      capacity: { refreshForBlindReview: (target) => this.capacity.refreshForBlindReview(target) },
    });
    this.continuity = new ContinuityKernel(
      this.db, this.clock, this.audit, this.capacity, this.providers,
      this.projects, this.runs, this.sessions, this.bindings, this.telemetry,
    );
    this.capacity.attach({
      providerFailureContinuity: {
        evaluate: (reason) => this.continuity.evaluate(reason),
      },
    });
    this.cto = new CtoLifecycle(
      this.db, this.clock, this.audit, this.projects, this.sessions, this.bindings,
      this.providers, this.outbox, this.runs,
      config.ctoPreference ?? { provider: "claude", model: "opus", effort: null },
    );
    this.ceo = new ProductionGate(
      this.db, this.clock, this.audit, this.artifacts,
      this.#evidenceWriters.PRODUCTION_READY_PACKET,
      this.#completionAuthorities,
      this.runs, this.tasks, this.bindings, this.outbox, this.telemetry,
    );

    this.pipeline = new CandidatePipeline(
      this.db, this.clock, this.audit, this.artifacts, this.runs, this.tasks, this.projects,
      this.repositories, this.verification, this.review, this.review.controlPlaneInvoker(), this.ceo, this.bindings, this.outbox,
      this.telemetry, this.guard,
    );

    const githubKernelOptions = config.githubKernelOptions ?? (config.githubClient
      ? {}
      : {
          // A successful merge starts GitHub Actions asynchronously. Fifteen minutes is
          // enough for dispatch and a normal project-ci job, while remaining bounded.
          postMergePollAttempts: 60,
          postMergePollIntervalMs: 15_000,
        });
    this.github = new GitHubKernel(
      this.db, this.clock, this.audit, this.artifacts, this.credentials,
      this.repositories, this.runs, this.projects, this.guard,
      config.githubClient,
      githubKernelOptions,
    );
    this.verification.attachCi(this.github.ciEvidenceSource());
    this.verification.attachManifests((digest) => this.projects.manifest(digest));
    this.verification.attachRuns((runId) => this.runs.get(runId));
    // The database *file*, not its directory: the worktree root lives beside it, and
    // denying the parent would stop a verification command from reading its own worktree.
    this.verification.setDenyReadPaths([
      config.secretsDir,
      config.databasePath,
      ...this.credentials.sensitivePaths(),
    ]);

    this.repair = new RepairService(
      this.db, this.clock, this.audit, this.artifacts, this.claims, this.worktrees,
      this.repositories, this.guard, this.#repairWorktreeAuthority,
    );
    this.doctor = new Doctor(
      this.db, this.clock, this.audit, this.projects, this.repositories, this.sessions,
      this.bindings, this.runs, this.tasks, this.claims, this.capacity, this.providers, this.continuity,
      this.outbox, this.github, this.worktrees, {
        directory: config.capacityDir,
        freshnessMs: config.capacity?.freshnessMs ?? 5 * 60 * 1000,
        maxClockSkewMs: config.capacity?.maxClockSkewMs ?? 60_000,
      }, {
        databasePath: config.databasePath,
        worktreeRoot: config.worktreeRoot,
        secretsDir: config.secretsDir,
        capacityDir: config.capacityDir,
      },
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
        plannedProvider: (projectId) => this.cto.plannedProvider(projectId),
      },
      // The target has to survive the port: dropping it here is what made every dispatch
      // ask "is any provider healthy?" instead of "is the one this run will use healthy?".
      capacity: { refreshForDispatch: (target) => this.capacity.refreshForDispatch(target) },
      continuity: {
        mode: () => this.continuity.mode(),
        // Dispatch needs the age too: §15.6's rule is that a verdict computed before the
        // providers changed is not evidence, and `evaluate` is how it gets a current one.
        modeAgeMs: () => this.continuity.modeAgeMs(),
        evaluate: (reason) => this.continuity.evaluate(reason),
      },
    });
    this.ownerAuthority = new OwnerAuthority(this.db, config.ownerIdentities ?? []);
    // The GitHub kernel binds the production gate's single human-gate predicate to its
    // payload. It never reinterprets APPROVAL artifacts or ingress receipts itself.
    this.github.attach({
      humanGateStatus: {
        humanGateStatus: (runId) => {
          const status = this.ceo.humanGateStatus(runId);
          return { ...status, humanGateDigest: digestOf(status.items) };
        },
      },
    });
    this.cto.attach({
      ownerAuthority: this.ownerAuthority,
      // §10.1's recipient is intentionally unbound until this acknowledgement switches
      // generations. The session secret is therefore the authentication proof here; the
      // lifecycle validates the delivered envelope and incarnation before it switches.
      handoffAuthentication: {
        verifyHandoffAcknowledgement: (acknowledgement) => {
          const session = this.sessions.verifySecret(
            acknowledgement.sessionId,
            acknowledgement.sessionSecret,
          );
          if (!session.allowed) {
            return deny(
              ReasonCode.HANDOFF_ACK_AUTHENTICATION_FAILED,
              "handoff acknowledgement session secret did not authenticate its recipient",
              { sessionId: acknowledgement.sessionId, authenticationReason: session.reasonCode },
            );
          }
          if (session.value.incarnation !== acknowledgement.sessionIncarnation) {
            return deny(
              ReasonCode.HANDOFF_ACK_AUTHENTICATION_FAILED,
              "handoff acknowledgement belongs to a stale session incarnation",
              {
                sessionId: acknowledgement.sessionId,
                acknowledgementIncarnation: acknowledgement.sessionIncarnation,
                currentIncarnation: session.value.incarnation,
              },
            );
          }
          return allow(ReasonCode.OK, undefined);
        },
      },
    });
    this.repair.attach({ ownerAuthority: this.ownerAuthority });
    this.ceo.attach({
      ownerAuthority: this.ownerAuthority,
      bootstrapActivation: {
        finalizeBootstrapActivationConfirm: (input) => this.bootstrap.finalizeBootstrapActivationConfirm(input),
      },
      sourceReadLeases: this.guard,
      continuity: {
        mode: () => this.continuity.mode(),
        modeAgeMs: () => this.continuity.modeAgeMs(),
        assertCompletionAllowed: (runId) => this.continuity.assertCompletionAllowed(runId),
        evaluate: (reason) => this.continuity.evaluate(reason),
      },
    });
    this.pipeline.attach({
      continuity: { evaluate: (reason) => this.continuity.evaluate(reason) },
    });
    this.cto.attach({ readiness: { checkSession: (id) => this.doctor.sessionReadiness(id) } });
    this.continuity.attach({ readiness: { checkSession: (id) => this.doctor.sessionReadiness(id) } });
  }

  private defaultAdapters(): ProviderAdapter[] {
    const credentialDenyPaths = this.credentials.sensitivePaths();
    const managedWriteBroker = new GuardedInvocationWriteBroker(this.guard);
    return [
      new ClaudeCliAdapter({
        clock: this.clock,
        capacityFile: join(this.config.capacityDir, "claude.json"),
        environmentAllowlist: [],
        denyReadPaths: [this.config.databasePath, this.config.secretsDir, this.config.capacityDir, ...credentialDenyPaths],
        managedWriteBroker,
        providerCredentialDir: process.env["ACP_CLAUDE_REVIEWER_CONFIG_DIR"],
        reviewerEgress: this.config.reviewerEgress,
      }),
      new CodexCliAdapter({
        clock: this.clock,
        capacityFile: join(this.config.capacityDir, "gpt.json"),
        environmentAllowlist: [],
        denyReadPaths: [this.config.databasePath, this.config.secretsDir, this.config.capacityDir, ...credentialDenyPaths],
        managedWriteBroker,
        // A reviewer can only use this deployment-provisioned dedicated CODEX_HOME. The
        // ordinary ~/.codex tree is intentionally never repurposed as a blind-review
        // credential scope because it can contain producer conversations.
        providerCredentialDir: process.env["ACP_CODEX_REVIEWER_HOME"],
        reviewerEgress: this.config.reviewerEgress,
      }),
      new GrokCliAdapter({
        clock: this.clock,
        capacityFile: join(this.config.capacityDir, "grok.json"),
        environmentAllowlist: [],
        denyReadPaths: [this.config.databasePath, this.config.secretsDir, this.config.capacityDir, ...credentialDenyPaths],
        providerCredentialDir: process.env["ACP_GROK_CREDENTIAL_DIR"],
      }),
    ];
  }

  close(): void {
    this.db.close();
  }
}
