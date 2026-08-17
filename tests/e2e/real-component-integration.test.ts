import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ControlPlane, readOwnerIdentities } from "../../src/app/control-plane.ts";
import { sha256 } from "../../src/core/digest.ts";
import { systemClock } from "../../src/core/clock.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { PROJECT_MANIFEST_SCHEMA_ID, type ProjectManifest } from "../../src/contracts/manifest.ts";
import { IngressGuard, ownerApprovalPayload } from "../../src/ingress/ingress-guard.ts";
import { ExecutionMode, RunState, SessionLifecycle } from "../../src/domain/types.ts";
import { AGENTCTL_CAPACITY_OBSERVATION_SOURCE, RefreshTrigger } from "../../src/capacity/capacity-monitor.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs, gitSync, tempDir } from "../helpers/fixtures.ts";
import { bindWorkerForTask } from "../helpers/harness.ts";

/**
 * Opt-in component integration on a real pre-existing project, registered by hand with
 * no Repo Factory involvement.
 *
 * It exercises a real repository, a seatbelt-confined verification command, a fresh
 * headless Claude reviewer, a candidate snapshot, and the component-level gates. It
 * deliberately constructs `ControlPlane` and invokes component APIs directly; the worker
 * edit also uses `writeFileSync` and git directly. It therefore does not exercise the
 * deployed Hermes or CTO MCP transports, Buzz, the daemon-managed worker runtime, GitHub
 * App merge, or post-merge verification. Those surfaces require deployment E2E evidence.
 *
 * Opt in with ACP_COMPONENT_INTEGRATION=1 because it spends real provider quota.
 */
const ENABLED = process.env["ACP_COMPONENT_INTEGRATION"] === "1";
const REAL_PROJECT = resolve(process.env["ACP_COMPONENT_INTEGRATION_PROJECT"] ?? process.cwd());
/**
 * A second participating repository, for the multi-repository merge sequence (#512, #240).
 *
 * Optional and off by default. #240 needs two repositories merging in declared order with the
 * first's post-merge verification gating the second, and a run's repository set is fixed at
 * `runs.create` — so the second has to be present from the start rather than appended after the
 * CEO confirmation. Guarding it keeps the single-repository path, which is what has been run
 * until now, exactly as it was.
 *
 * Set both to a checkout path and its `github:owner/repo` identity.
 */
const SECOND_PROJECT = process.env["ACP_COMPONENT_INTEGRATION_SECOND_PROJECT"];
const SECOND_IDENTITY = process.env["ACP_COMPONENT_INTEGRATION_SECOND_IDENTITY"];
const TWO_REPOSITORIES = Boolean(SECOND_PROJECT && SECOND_IDENTITY);
/** The long-lived branch the manifest contract names, in one place. */
const MANIFEST_DEFAULT_BRANCH = "main";
/**
 * The workflow whose digest this run's manifest approves.
 *
 * Read from the real checkout rather than written as a constant (#527): the digest has to be the
 * one the file actually hashes to at the merge commit, and a literal here would be a second copy
 * of the workflow that drifts the first time CI changes. The run does not modify this file, so
 * its content at HEAD is its content at the merge commit.
 */
const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";

/**
 * The reviewer egress this host provisioned, for both providers.
 *
 * The profile is the owner's; the proxy is the vendored one rather than the host copy, because
 * `reviewer-egress.ts` requires a handshake and a script outside the tree cannot be held to it.
 */
const ACCEPTANCE_REVIEWER_EGRESS = (root: string) => ({
  profilePath: join(EGRESS_ROOT, "reviewer.sb"),
  proxyPath: fileURLToPath(new URL("../../deploy/egress/allowlist-proxy.py", import.meta.url)),
  runtimeDir: join(root, "egress-runtime"),
});

/** The owner-provisioned reviewer egress infrastructure this host declares. */
const EGRESS_ROOT = join(process.env["HOME"] ?? "", ".agent-control-plane", "egress");
const REVIEWER_MODEL = process.env["ACP_COMPONENT_INTEGRATION_MODEL"] ?? "sonnet";

/**
 * §42 #3 wants one real run per execution mode. The flow is the same one: §12.1 keeps
 * contract, snapshot, verification and blind review mandatory in SIMPLE and makes only the
 * plan document optional, so the mode is a parameter rather than a second copy of the run.
 * GUARDED additionally carries a human gate, and a real owner decision has to satisfy it.
 */
const MODE = (process.env["ACP_COMPONENT_INTEGRATION_MODE"] ?? "STANDARD") as "SIMPLE" | "STANDARD" | "GUARDED";
const EVIDENCE_FILE =
  MODE === "STANDARD"
    ? "component-integration-real-project.json"
    : `component-integration-real-project-${MODE.toLowerCase()}.json`;
/** The identity this deployment allowlists in `~/.agent-control-plane/owner-identities`. */
const OWNER = { channel: "cli", actor: process.env["USER"] ?? "" } as const;

const CONTRACT: TaskContract = {
  goal: "Add a documented helper that reports the reason-code catalogue size",
  why: "Operators need a machine-readable count of the stable reason codes when auditing denials",
  scope: ["src/core/reason-codes.ts"],
  nonGoals: ["renaming any existing reason code"],
  acceptance: [
    // The criteria name the evidence this run actually produces. The full typecheck
    // needs installed dependencies and so belongs to CI as TRUSTED_CI evidence; stating
    // it here would promise evidence the local verification cannot supply.
    "the reason-code contract check (scripts/verify-reason-codes.mjs) passes at the exact candidate head",
    "no existing reason code string is removed or renamed",
    "nothing outside src/core/reason-codes.ts is modified",
  ],
  priority: "NORMAL",
  // A GUARDED run is exactly the one that must not complete on machine evidence alone
  // (§12.3, §21), so the gate is real and an allowlisted owner has to clear it.
  humanGate: MODE === "GUARDED" ? ["owner approval before a guarded change is published"] : [],
  references: ["PRD §40 Explainability"],
};

const manifestFor = (projectId: string): ProjectManifest => ({
  schema: PROJECT_MANIFEST_SCHEMA_ID,
  projectId,
  repositories: [
    { role: "primary", remote: "github:MongLong0214/agent-control-plane", manifestRoot: "." },
    // The manifest has to describe the second participant, not just the run (#512). The
    // repository registry does not check a registered role against the manifest, so a missing
    // declaration here does not fail at registration — it fails much later, when the secondary's
    // post-merge verification finds no declared check and denies with
    // POST_MERGE_CHECKS_NOT_DECLARED, after that repository has already been merged.
    ...(TWO_REPOSITORIES
      ? [{ role: "secondary", remote: SECOND_IDENTITY!, manifestRoot: "." }]
      : []),
  ],
  branchProfile: {
    longLived: [MANIFEST_DEFAULT_BRANCH, "dev"],
    defaultBranch: MANIFEST_DEFAULT_BRANCH,
    updateStrategy: "rebase_before_review",
    mergeStrategy: "merge_commit",
    releaseTagPolicy: "semver",
    releaseBranchCleanup: "keep",
  },
  verificationProfiles: {
    simple: ["reason-codes"],
    standard: ["reason-codes"],
    guarded: ["reason-codes"],
  },
  verificationCommands: [
    {
      id: "reason-codes",
      /**
       * The project's real reason-code contract check. Chosen over `tsc` because
       * verification runs in a disposable worktree with no installed packages and no
       * network (PRD §17.4) — a command that needs `node_modules` cannot execute there.
       * The typecheck is the repository's CI job and reaches the control plane as
       * TRUSTED_CI evidence instead.
       */
      argv: ["node", "scripts/verify-reason-codes.mjs"],
      repositoryRole: "primary",
      cwd: ".",
      timeoutSeconds: 120,
      envAllowlist: ["CI"],
      network: "deny",
      networkAllowlist: [],
      required: true,
      evidenceMode: "LOCAL_COMMAND",
      maxOutputBytes: 1_048_576,
      maxMemoryMb: 2048,
    },
  ],
  postMergeCommands: [],
  ciWorkflows: [
    {
      path: CI_WORKFLOW_PATH,
      // GitHub names a check run after the **job**, not the workflow. This repository's workflow
      // is `name: project-ci` with job `verify`, and the check run it produces is `verify` — so
      // the workflow name was never going to match. It was invisible because the unapproved-digest
      // refusal (#527) fired first: one unpassable condition hiding another.
      checkName: "verify",
      approvedDigest: sha256(readFileSync(join(REAL_PROJECT, CI_WORKFLOW_PATH), "utf8")),
      repositoryRole: "primary",
      unapprovedFirstActivation: false,
    },
    // Each repository declares its own, because each has its own workflow file and its own digest
    // (#512). The disposable acceptance repositories name their job `project-ci`.
    ...(TWO_REPOSITORIES
      ? [{
        path: CI_WORKFLOW_PATH,
        checkName: "project-ci",
        approvedDigest: sha256(readFileSync(join(resolve(SECOND_PROJECT!), CI_WORKFLOW_PATH), "utf8")),
        repositoryRole: "secondary",
        unapprovedFirstActivation: false,
      }]
      : []),
  ],
  commitlore: { mode: "preferred" },
});

describe.runIf(ENABLED)("component integration: real project, verification, and blind review", () => {
  it(
    `drives ${MODE} through direct component calls to verification, fresh blind review, packet, and confirm`,
    async () => {
      const root = tempDir("acp-component-integration-");
      const checkout = join(root, "project");

      // A real, pre-existing project. Cloned so the owner's working tree is untouched;
      // the code, history and verification command are the real ones.
      execFileSync("git", ["clone", "--local", "--quiet", REAL_PROJECT, checkout]);
      // A local clone points `origin` at the source directory. The repository's identity is
      // its real remote, and the registry now refuses a declared identity that contradicts
      // what the checkout says — so the clone is pointed at the same remote the source has.
      const sourceRemote = execFileSync("git", ["-C", REAL_PROJECT, "remote", "get-url", "origin"], {
        encoding: "utf8",
      }).trim();
      execFileSync("git", ["-C", checkout, "remote", "set-url", "origin", sourceRemote]);
      // Local-only exclude: the symlink is a convenience for this checkout and must never
      // enter a candidate. Committing a machine-specific absolute symlink is exactly the
      // scope violation an independent reviewer should refuse.
      writeFileSync(join(checkout, ".git", "info", "exclude"), "node_modules\n");
      symlinkSync(join(REAL_PROJECT, "node_modules"), join(checkout, "node_modules"), "dir");
      // Check the clone onto the branch the manifest's contract names, rather than inheriting
      // whatever the source happens to be on. It previously asserted the inherited branch was
      // "main", so the suite could not run from any feature branch — including in CI, where
      // every change arrives on one. Combined with being opt-in, that is why it drifted until
      // it failed at its first step. The branch contract still wants a real long-lived branch,
      // so this checks one out instead of relaxing the contract to match the runner.
      gitSync(checkout, ["checkout", "--quiet", MANIFEST_DEFAULT_BRANCH]);
      expect(gitSync(checkout, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(MANIFEST_DEFAULT_BRANCH);

      // The host's own declaration, read once: it authorises the owner and it names the actor
      // who may author a capacity observation. Inventing a second actor here would make the
      // observation prove itself rather than the deployment.
      const ownerIdentities = readOwnerIdentities(
        join(process.env["HOME"] ?? "", ".agent-control-plane", "owner-identities"),
      );
      const cliOwner = ownerIdentities.find((identity) => identity.channel === "cli");
      if (!cliOwner) throw new Error("no cli owner identity is declared on this host");

      const cp = new ControlPlane({
        // The initial manifest predates any run, so there is no run-scoped authorization to
        // sign it with. manifestAuthorizationForTests is the intended bootstrap proof.
        allowTestEvidenceWriters: true,
        databasePath: join(root, "state.sqlite"),
        worktreeRoot: join(root, "worktrees"),
        capacityDir: join(root, "capacity"),
        secretsDir: join(root, "secrets"),
        clock: systemClock,
        // Overrides, not replacements (#552). `adapters:` would discard every option
        // ControlPlane passes and make each one this test's responsibility — four were lost that
        // way, three of them found by a live run failing hundreds of seconds in. Naming only what
        // differs means a future option arrives here automatically.
        adapterOptions: {
          gpt: {
            // The reviewer scope holds auth.json and nothing else. ~/.codex carries producer
            // conversation state, which is exactly what a blind reviewer must not read.
            providerCredentialDir: join(process.env["HOME"] ?? "", ".acp-reviewer", "codex"),
            reviewerEgress: ACCEPTANCE_REVIEWER_EGRESS(root),
          },
          claude: {
            // The reviewer profile denies `~/.claude` — the producer's transcript store — so the
            // reviewer needs its own scoped identity. `providerCredentialDir` is the only thing
            // that exports CLAUDE_CONFIG_DIR.
            providerCredentialDir: join(process.env["HOME"] ?? "", ".agent-control-plane", "reviewer", "claude"),
            reviewerEgress: ACCEPTANCE_REVIEWER_EGRESS(root),
          },
        },
        // The host's own declaration authorises the owner, not a list this test invented:
        // an empty or absent file means the deployment has no owner and the gate cannot be
        // cleared, which is the safe reading of §21.
        ownerIdentities: ownerIdentities,
        ctoPreference: { provider: "claude", model: REVIEWER_MODEL, effort: null },
        // Codex, not Claude. Only two of the three adapters declare
        // supportsReviewerIsolation, and the Claude one needs an interactive OAuth login that
        // cannot be completed away from the machine. Codex has a real credential already, and
        // requiresReviewerProviderSessionProof is true — a stricter reviewer contract, not a
        // looser one. The Claude path stays available and is not the default.
        reviewer: {
          preferred: { provider: "gpt", model: "gpt-5.6-sol", effort: null },
          // Production configures `[claude/opus]` here; this said `[]`, so the sentence above —
          // "the Claude path stays available" — was true of the deployment and false of the test
          // asserting it. A preferred reviewer that cannot constitute isolation had nothing to
          // fall through to, and the run stopped at ISOLATION_LOST rather than exercising the
          // fallback the deployment relies on.
          //
          // Matching production is the point of this acceptance: a bring-up that tests a weaker
          // configuration than the one that ships proves the weaker configuration.
          fallbacks: [{ provider: "claude", model: "opus", effort: null }],
        },
      });

      // The owner supplies the capacity file; without it the sensor fails closed and
      // dispatch is refused, which is the documented behaviour rather than a guess.
      mkdirSync(join(root, "capacity"), { recursive: true });
      writeFileSync(
        join(root, "capacity", "claude.json"),
        JSON.stringify({
          observedAt: new Date().toISOString(),
          runtimeHealth: "HEALTHY",
          buckets: [
            {
              id: "rolling-5h",
              remainingPercent: 75,
              resetAt: null,
              capabilities: ["ceo", "cto", "blind-review", "worker"],
            },
          ],
        }),
      );
      // The reviewer is gpt, and capacity is per provider. Seeding only claude left review
      // refused CAPACITY_UNKNOWN_NOT_ROUTABLE: dispatch had a routable provider and the
      // reviewer did not.
      writeFileSync(
        join(root, "capacity", "gpt.json"),
        JSON.stringify({
          observedAt: new Date().toISOString(),
          runtimeHealth: "HEALTHY",
          buckets: [
            {
              id: "rolling-5h",
              remainingPercent: 75,
              resetAt: null,
              capabilities: ["ceo", "cto", "blind-review", "worker"],
            },
          ],
        }),
      );

      // Writing the file is not enough: the monitor only holds a reading once a refresh has
      // read it, and in production that is the daemon's sensor tick. This test drives
      // components directly, so nothing ticked and dispatch refused
      // CAPACITY_UNKNOWN_NOT_ROUTABLE — the sensor had no reading rather than a bad one.
      // The collector runs for real here and cannot read quota on this host: the Claude CLI's
      // interactive /usage output carries no parseable window, so the reading comes back
      // sensorHealth ERROR and overwrites the seeded file. That is #424's exact scenario, and
      // the operator observation is the mechanism built for it — an authenticated reading that
      // outlives a collector which cannot see quota. Supplying one is what a real operator
      // does via `agentctl capacity observe`, not a way around the sensor.
      await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["claude", "gpt"]);
      const observed = await cp.capacity.observe({
        provider: "claude",
        observedAt: new Date().toISOString(),
        actor: cliOwner.actor,
        source: AGENTCTL_CAPACITY_OBSERVATION_SOURCE,
        runtimeHealth: "HEALTHY",
        buckets: [{
          id: "owner-observed-window",
          remainingPercent: 75,
          resetAt: null,
          capabilities: ["ceo", "cto", "worker", "blind-review"],
        }],
      });
      if (!observed.allowed) {
        throw new Error(`capacity observation refused: ${observed.reasonCode} ${observed.message}`);
      }
      // The same operator observation for the reviewer's provider. Its collector cannot read
      // quota here either, so the authenticated reading is what makes review routable.
      const observedGpt = await cp.capacity.observe({
        provider: "gpt",
        observedAt: new Date().toISOString(),
        actor: cliOwner.actor,
        source: AGENTCTL_CAPACITY_OBSERVATION_SOURCE,
        runtimeHealth: "HEALTHY",
        buckets: [{
          id: "owner-observed-window",
          remainingPercent: 75,
          resetAt: null,
          capabilities: ["ceo", "cto", "worker", "blind-review"],
        }],
      });
      if (!observedGpt.allowed) {
        throw new Error(`gpt capacity observation refused: ${observedGpt.reasonCode} ${observedGpt.message}`);
      }
      expect(
        cp.capacity.current("claude")?.allocationAdmission,
        "claude capacity is not routable, so no run can be dispatched",
      ).toBe("OPEN");

      const evidence: Record<string, unknown> = {};

      // --- manual registration, no Repo Factory ----------------------------
      const projectId = "agent-control-plane";
      const initialManifest = manifestFor(projectId);
      const project = cp.projects.register({
        projectId,
        name: "agent-control-plane",
        manifest: initialManifest,
        authorization: cp.manifestAuthorizationForTests(initialManifest),
      });
      if (!project.allowed) {
        throw new Error(`registration refused: ${project.reasonCode} ${project.message}`);
      }

      const repository = await cp.repositories.register({
        checkoutPath: checkout,
        projectId,
        repositoryRole: "primary",
        activeManifestDigest: project.value.activeManifestDigest,
        identity: "github:MongLong0214/agent-control-plane",
      });
      expect(repository.allowed).toBe(true);
      if (!repository.allowed) return;

      // #512 — the second participant, when one is configured. Registered here rather than later
      // because `runs.create` below writes `run_repositories`, and a repository absent from that
      // call can never be part of the run's merge order.
      let secondRepositoryId: string | null = null;
      if (TWO_REPOSITORIES) {
        const secondCheckout = join(root, "project-2");
        execFileSync("git", ["clone", "--local", "--quiet", resolve(SECOND_PROJECT!), secondCheckout]);
        // Same reason as the primary above, and it was missed here when the second repository was
        // added: a `--local` clone points `origin` at the source *directory*, so the checkout says
        // its remote is a filesystem path while the declared identity says `github:owner/repo`.
        // The registry compares the two and refuses. Point the clone at the remote its source has.
        const secondRemote = execFileSync(
          "git",
          ["-C", resolve(SECOND_PROJECT!), "remote", "get-url", "origin"],
          { encoding: "utf8" },
        ).trim();
        execFileSync("git", ["-C", secondCheckout, "remote", "set-url", "origin", secondRemote]);
        const second = await cp.repositories.register({
          checkoutPath: secondCheckout,
          projectId,
          repositoryRole: "secondary",
          activeManifestDigest: project.value.activeManifestDigest,
          identity: SECOND_IDENTITY!,
        });
        expect(second.allowed, `second repository refused: ${second.allowed ? "" : second.message}`).toBe(true);
        if (!second.allowed) return;
        secondRepositoryId = second.value.repositoryId;
      }
      evidence["registration"] = {
        projectId,
        activeManifestDigest: project.value.activeManifestDigest,
        identity: repository.value.identity,
        activityBeforeCto: cp.projects.require(projectId).activity,
      };

      // Hermes is the CEO endpoint; it is a distinct session from the CTO and reviewer.
      const hermes = cp.sessions.create({ provider: "hermes", model: "operator" });
      cp.sessions.transition(hermes.sessionId, SessionLifecycle.READY, "operator endpoint");
      cp.bindings.bind({ roleKey: "CEO", role: "CEO", sessionId: hermes.sessionId });

      // --- DIRECT cannot write --------------------------------------------
      const directAttempt = cp.guard.evaluate({
        operation: "FILE_MUTATION",
        targetPath: join(checkout, "src/core/reason-codes.ts"),
        claimedClassification: "DIRECT",
      });
      expect(directAttempt.allowed).toBe(false);
      expect(directAttempt.reasonCode).toBe(ReasonCode.WRITE_REQUIRES_MANAGED_RUN);
      evidence["directWriteRefused"] = directAttempt.reasonCode;

      // --- run creation and dispatch --------------------------------------
      const created = cp.runs.create({
        projectId,
        executionMode: ExecutionMode[MODE],
        contract: CONTRACT,
        repositories: [
          // `mergeOrder` is explicit even for the single-repository case: the default of 0 is
          // the same value the first participant would take, and writing it makes the ordering
          // this run is asserting visible at the point it is decided.
          { repositoryId: repository.value.repositoryId, repositoryRole: "primary", baseBranch: MANIFEST_DEFAULT_BRANCH, mergeOrder: 0 },
          ...(secondRepositoryId
            ? [{ repositoryId: secondRepositoryId, repositoryRole: "secondary", baseBranch: MANIFEST_DEFAULT_BRANCH, mergeOrder: 1 }]
            : []),
        ],
      });
      expect(created.allowed).toBe(true);
      if (!created.allowed) return;
      const runId = created.value.runId;

      const dispatched = await cp.runs.dispatch(runId);
      expect(dispatched.allowed).toBe(true);
      if (!dispatched.allowed) return;
      const run = dispatched.value;
      evidence["dispatch"] = {
        runId,
        ownerSessionId: run.ownerSessionId,
        ownerBindingGeneration: run.ownerBindingGeneration,
        pinnedManifestDigest: run.pinnedManifestDigest,
        activityAfterCto: cp.projects.require(projectId).activity,
      };

      // --- the real Primary CTO session produces the lean plan -------------
      const ctoAdapter = cp.providers.require("claude");
      const planning = await ctoAdapter.invoke({
        prompt: [
          "You are the Primary CTO for this run. Remove unnecessary complexity.",
          "",
          `Goal: ${CONTRACT.goal}`,
          `Scope: ${CONTRACT.scope.join(", ")}`,
          `Acceptance: ${CONTRACT.acceptance.join("; ")}`,
          "",
          "Reply with JSON only:",
          '{"summary":"...","tasks":[{"key":"impl","title":"...","category":"implementation"}],"removedOverengineering":["..."]}',
        ].join("\n"),
        workdir: checkout,
        timeoutMs: 5 * 60 * 1000,
        model: REVIEWER_MODEL,
        readOnly: true,
        correlationId: `${runId}:plan`,
      });
      if (!planning.ok) {
        throw new Error(`CTO planning invocation failed: ${planning.error ?? "unknown"}`);
      }
      evidence["ctoPlan"] = {
        provider: planning.provider,
        model: planning.model,
        durationMs: planning.durationMs,
        parsed: planning.json !== null,
      };

      const submitted = cp.tasks.submit(runId, [
        { key: "impl", title: "add the reason-code count helper", category: "implementation" },
        { key: "verify", title: "confirm the typecheck passes", category: "test", dependsOn: ["impl"] },
      ]);
      expect(submitted.allowed).toBe(true);
      if (!submitted.allowed) return;

      cp.artifacts.put(runId, "PLAN", {
        summary: "single-file helper, no new abstraction",
        source: "primary-cto",
        raw: planning.json ?? planning.text.slice(0, 2000),
      });

      // --- claim, then the worker's real repository change ------------------
      const claim = cp.claims.acquire({
        runId,
        ownerSessionId: run.ownerSessionId!,
        ownerBindingGeneration: run.ownerBindingGeneration!,
        ownerRoleKey: run.ownerRoleKey!,
        repositoryIdentity: repository.value.identity,
        branch: "task/E2E-1-reason-code-count",
        declaredPaths: ["src/core/reason-codes.ts"],
      });
      expect(claim.allowed).toBe(true);

      const implTask = cp.tasks.ready(runId)[0]!;
      const implWorkerSessionId = bindWorkerForTask(cp, implTask.taskId);
      const implExecution = cp.tasks.startExecution({
        runId,
        taskId: implTask.taskId,
        ownerBindingGeneration: run.ownerBindingGeneration!,
        workerSessionId: implWorkerSessionId,
        workerProcessId: process.pid,
        provider: "claude",
        model: REVIEWER_MODEL,
        repositoryId: repository.value.repositoryId,
        concurrencyWidth: 1,
      });
      expect(implExecution.allowed).toBe(true);
      if (!implExecution.allowed) return;

      gitSync(checkout, ["checkout", "-q", "-b", "task/component-integration-1-reason-code-count"]);
      const target = join(checkout, "src/core/reason-codes.ts");
      const addition = [
        "",
        "/** Number of stable reason codes in the catalogue; used when auditing denials. */",
        "export const reasonCodeCount = (): number => ALL.size;",
        "",
      ].join("\n");
      writeFileSync(target, `${readUtf8(target)}${addition}`);
      gitSync(checkout, ["add", "-A"]);
      gitSync(checkout, ["commit", "-q", "-m", "feat(core): expose the reason-code catalogue size"]);
      const candidateHead = gitSync(checkout, ["rev-parse", "HEAD"]);

      cp.tasks.finishExecution(implExecution.value.executionId, {
        status: "SUCCEEDED",
        resultDigest: `sha256:${candidateHead}`,
      });

      const verifyTask = cp.tasks.ready(runId)[0]!;
      const verifyWorkerSessionId = bindWorkerForTask(cp, verifyTask.taskId);
      const verifyExecution = cp.tasks.startExecution({
        runId,
        taskId: verifyTask.taskId,
        ownerBindingGeneration: run.ownerBindingGeneration!,
        workerSessionId: verifyWorkerSessionId,
        workerProcessId: process.pid,
        provider: "claude",
        model: REVIEWER_MODEL,
        repositoryId: repository.value.repositoryId,
      });
      if (!verifyExecution.allowed) throw new Error(verifyExecution.message);
      cp.tasks.finishExecution(verifyExecution.value.executionId, { status: "SUCCEEDED", resultDigest: "sha256:task-report" });

      // --- the full candidate path: freeze, verify, review, packet ----------
      const outcome = await cp.pipeline.submitResult({
        runId,
        ownerSessionId: run.ownerSessionId!,
        ownerBindingGeneration: run.ownerBindingGeneration!,
        resultSummary: "added reasonCodeCount() with no change to any existing code string",
        recommendation: "merge",
        residualRisk: [],
      });

      expect(outcome.allowed).toBe(true);
      if (!outcome.allowed) throw new Error(`${outcome.reasonCode}: ${outcome.message}`);
      if (outcome.value.stage !== "COMPLETED_REVIEW") {
        throw new Error(
          `pipeline stopped at ${outcome.value.stage}: ${JSON.stringify(outcome.value, null, 2)}`,
        );
      }

      const packet = outcome.value.packet;
      const snapshotDigest = outcome.value.snapshotDigest;

      expect(packet.verification.status).toBe("PASS");
      expect(packet.verification.observedInputs).toBe(packet.verification.expectedInputs);
      expect(packet.blindReview.verdict).toBe("PASS");
      expect(packet.blindReview.omittedItems).toBe(0);
      expect(packet.changedRepositories[0]?.candidateHead).toBe(candidateHead);

      const reviewPacket = cp.review.latestPacket(runId, snapshotDigest)!;
      // The reviewer is a genuinely different session from every producer.
      expect(cp.bindings.producerSessions(runId).has(reviewPacket.reviewerSessionId)).toBe(false);

      evidence["verification"] = packet.verification;
      evidence["blindReview"] = {
        verdict: reviewPacket.verdict,
        provider: reviewPacket.provider,
        model: reviewPacket.model,
        reviewerSessionId: reviewPacket.reviewerSessionId,
        reviewerGeneration: reviewPacket.reviewerRoleBindingGeneration,
        coveredFiles: reviewPacket.coveredFiles,
        omittedItems: reviewPacket.omittedItems,
        findings: reviewPacket.findings.length,
        withheld: reviewPacket.inputManifest.withheld,
      };
      evidence["candidateSnapshotDigest"] = snapshotDigest;

      // --- Hermes final confirmation ---------------------------------------
      expect(cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      const notified = cp.audit
        .byKind("CEO_NOTIFICATION")
        .filter((e) => e.evidence["notification"] === "READY_FOR_CEO_REVIEW");
      expect(notified).toHaveLength(1);

      // A GUARDED run must not complete on machine evidence alone (§12.3, §21). Record the
      // real owner decision only after submitResult has frozen the current candidate, then
      // before CEO confirmation. An identity that is not the owner cannot obtain a receipt,
      // so it cannot clear the gate (#102).
      if (MODE === "GUARDED") {
        const guard = new IngressGuard(cp.db, cp.clock, cp.audit, { cli: { allowedActors: [OWNER.actor] } });
        const receiptFor = (item: string, actor: string) => {
          const approval = {
            runId,
            candidateSnapshotDigest: cp.runs.currentCandidate(runId),
            operation: "owner_decision_submit",
            parameters: { item, approved: true, note: "reviewed the contract and the declared scope" },
            idempotencyKey: `owner-decision:${item}:${actor}`,
            approved: true,
          };
          return guard.admitOwnerApproval(
            { channel: "cli", actor, nonce: `owner-decision:${item}:${actor}`, payload: ownerApprovalPayload(approval) },
            approval,
          );
        };

        const impostor = receiptFor(CONTRACT.humanGate[0]!, "someone-else");
        expect(impostor.allowed).toBe(false);
        evidence["humanGateRefusedNonOwner"] = impostor.reasonCode;

        for (const item of CONTRACT.humanGate) {
          const admitted = receiptFor(item, OWNER.actor);
          if (!admitted.allowed) throw new Error(`owner ingress refused: ${admitted.message}`);
          const decided = cp.ceo.recordOwnerDecision({
            runId,
            item,
            approved: true,
            note: "reviewed the contract and the declared scope",
            receipt: admitted.value,
          });
          expect(decided.allowed).toBe(true);
        }
        evidence["ownerDecision"] = { owner: OWNER, items: CONTRACT.humanGate, via: "admitted cli ingress receipt" };
      }

      const confirmed = cp.ceo.submitCeoDecision({
        runId,
        decision: "CONFIRM",
        candidateSnapshotDigest: snapshotDigest,
        ceoSessionId: hermes.sessionId,
        rationale: "verification and an independent review both pass at this exact candidate",
      });
      expect(confirmed.allowed).toBe(true);
      expect(cp.runs.require(runId).state).toBe(RunState.CEO_APPROVED);

      evidence["ceoConfirm"] = { state: cp.runs.require(runId).state, sessionId: hermes.sessionId };

      // #512 / #240 — the ordering claim, asserted where it is decidable.
      //
      // The kernel gate is what this checks, not the finalizer's sequential loop. Measured on
      // #521: deleting the gate entirely left the finalizer's two-repository test green, because
      // that test observes the order the merges happened in and would observe the same order
      // with no gate at all. Two merges landing in sequence is what a system with no gate
      // produces on a fast day.
      //
      // So the assertion is a *refusal*: with the first repository merged and its post-merge
      // verification not yet answered, a merge of the second must be denied and say why.
      if (secondRepositoryId) {
        const ordered = cp.runs.repositoriesOf(runId);
        evidence["mergeOrder"] = ordered.map((entry) => ({
          identity: entry.identity,
          mergeOrder: entry.mergeOrder,
          mergeState: entry.mergeState,
        }));
        expect(
          ordered.map((entry) => entry.mergeOrder),
          "the run did not record a distinct merge order for each participant",
        ).toEqual([0, 1]);

        // Before any merge, nothing is pending and nothing is blocked.
        const beforeAnyMerge = cp.github.dependentMergeBlocked(runId, SECOND_IDENTITY!);
        expect(
          beforeAnyMerge.allowed,
          "a dependent was blocked before any repository had merged",
        ).toBe(true);
        evidence["dependentGate"] = { beforeAnyMerge: beforeAnyMerge.reasonCode };

        // The merge itself goes through the production entry point. `finalizeApprovedRun` is
        // what the daemon calls on a CEO-approved run, and it already walks the participants in
        // `merge_order`, awaiting each post-merge before the next merge.
        //
        // The refusal that gate produces is *not* asserted here, and cannot usefully be: the
        // finalizer never attempts the second merge early, so there is no moment in this path
        // where a well-behaved caller is refused. That property is proved against the kernel in
        // github-kernel.test.ts (#521), where the moment can be constructed. What this run
        // proves is the end-to-end consequence — both repositories merged, in the declared
        // order, each with its own post-merge verification.
        const daemon = new Daemon(cp, { stateDir: tempDir("acp-two-repo-finalizer-") });
        const finalized = await daemon.finalizeApprovedRun(runId);
        expect(
          finalized.allowed,
          `finalization refused: ${finalized.allowed ? "" : `${finalized.reasonCode} ${finalized.message}`}`,
        ).toBe(true);

        const settled = cp.runs.repositoriesOf(runId);
        evidence["mergeSequence"] = settled.map((entry) => ({
          identity: entry.identity,
          mergeOrder: entry.mergeOrder,
          mergeState: entry.mergeState,
        }));
        expect(
          settled.map((entry) => entry.mergeState),
          "both participants must reach MERGED — a repository left PENDING means its post-merge never answered",
        ).toEqual(["MERGED", "MERGED"]);
        await daemon.stop();
      }
      evidence["doctor"] = await cp.doctor.run("project", projectId);
      evidence["telemetry"] = {
        run: cp.telemetry.query("run"),
        task: cp.telemetry.query("task"),
        quality: cp.telemetry.query("quality"),
      };
      evidence["auditTrail"] = cp.audit.forRun(runId).map((e) => ({
        kind: e.kind,
        reasonCode: e.reasonCode,
      }));

      mkdirSync(join(REAL_PROJECT, "evidence"), { recursive: true });
      writeFileSync(
        join(REAL_PROJECT, "evidence", EVIDENCE_FILE),
        JSON.stringify(evidence, null, 2),
      );

      cp.close();
      cleanupTempDirs();
    },
    30 * 60 * 1000,
  );
});

const readUtf8 = (path: string): string => readFileSync(path, "utf8");
