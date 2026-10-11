import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, vi } from "vitest";

import { processGroupEmpty } from "../../src/bootstrap/attempt-writer-group.ts";
import { writeWithheldRequest } from "../../src/bootstrap/bootstrap-approval-anchor.ts";
import { plannedBootstrapOutputs } from "../../src/bootstrap/bootstrap-plan.ts";
import {
  REPO_FACTORY_GITHUB_WRITE_OPERATION,
  RepoFactoryBootstrapRunner,
  repoFactoryGitHubWriteParameters,
  type ProduceAndActivateInput,
} from "../../src/bootstrap/repo-factory-bootstrap-run.ts";
import { digestOf } from "../../src/core/digest.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { ProjectManifest } from "../../src/contracts/manifest.ts";
import type { HandoffPackage } from "../../src/cto/cto-lifecycle.ts";
import { ExecutionMode, RunKind, RunState } from "../../src/domain/types.ts";
import { git } from "../../src/git/git.ts";
import { IngressGuard, ownerApprovalPayload } from "../../src/ingress/ingress-guard.ts";
import { bootstrapPlan, cleanTreeManifest, reviewBootstrapPlan } from "./bootstrap-plan.ts";
import { FakeGitHub, type Target } from "./fake-github-write-port.ts";
import { tempDir } from "./fixtures.ts";
import { TEST_OWNER, dispatchBootstrapRun, makeHarness, type Harness } from "./harness.ts";

/**
 * Issue #246 — a PROJECT_BOOTSTRAP run at CEO review and the Repo Factory runner wired to the
 * bare-repository GitHub double, composed as the runner's own witnesses compose it, for the witnesses of
 * a bootstrap's full path: produce, activate, acknowledge, CONFIRM. Temporary directories are
 * `tempDir`'s; a test file that uses this runs `cleanupTempDirs` after all.
 */

/**
 * GitHub's `auto_init` on the double: a create that asks for it gets one parentless commit holding a
 * README on `initialBranch` (the owner account's default-branch setting), and that branch becomes the
 * default. A create that does not ask gets an empty repository, as before. The knobs are GitHub
 * misbehaving or someone else acting: `ignoreAutoInit` initializes nothing, `initializeEvenUnasked`
 * initializes a push-mode create, `commitOnTopOfInit` lands a second commit before anything reads it.
 */
export class InitializingGitHub extends FakeGitHub {
  readonly createRequests: Array<{ target: string; autoInit: unknown }> = [];
  initialBranch = "main";
  ignoreAutoInit = false;
  initializeEvenUnasked = false;
  commitOnTopOfInit = false;

  constructor(private readonly scratch: string) {
    super(scratch);
  }

  override async createRepository(target: Target, visibility: string, description?: string, autoInit?: boolean) {
    this.createRequests.push({ target: `${target.owner}/${target.name}`, autoInit });
    const initialize = this.initializeEvenUnasked ? true : autoInit === true ? !this.ignoreAutoInit : false;
    const existed = this.repository(target.owner, target.name) !== undefined;
    try {
      const created = await super.createRepository(target, visibility, description);
      if (!initialize) return created;
      await this.initialize(target, description ?? null);
      return { ...created, defaultBranch: this.initialBranch };
    } catch (error) {
      // A create whose answer was lost still ran on GitHub, its initialization included.
      if (initialize && !existed && this.repository(target.owner, target.name) !== undefined) {
        await this.initialize(target, description ?? null);
      }
      throw error;
    }
  }

  private async initialize(target: Target, description: string | null): Promise<void> {
    const repository = this.repository(target.owner, target.name);
    if (repository === undefined) throw new Error("no repository to initialize");
    const work = mkdtempSync(join(this.scratch, "init-"));
    const commit = async (message: string) =>
      git(work, ["-c", "user.email=noreply@github.com", "-c", "user.name=GitHub", "commit", "-q", "-m", message]);
    await git(work, ["init", "-q", "-b", this.initialBranch]);
    writeFileSync(join(work, "README.md"), `# ${target.name}\n${description === null ? "" : `\n${description}\n`}`);
    await git(work, ["add", "README.md"]);
    await commit("Initial commit");
    if (this.commitOnTopOfInit) {
      writeFileSync(join(work, "LATER.md"), "pushed after the repository was created\n");
      await git(work, ["add", "LATER.md"]);
      await commit("someone else's commit");
    }
    await git(work, ["push", "-q", repository.bare, `HEAD:refs/heads/${this.initialBranch}`]);
    repository.defaultBranch = this.initialBranch;
  }
}

export type Operation = Record<string, unknown> & { operationId: string; resourceType: string; resourceIdentity: string };

const CONTRACT = {
  goal: "bootstrap",
  why: "bootstrap",
  scope: [],
  nonGoals: [],
  acceptance: ["verify"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};

const HANDOFF: HandoffPackage = {
  projectStatus: "new",
  activeManifestDigest: null,
  recentDecisions: [],
  openBlockers: [],
  queuedWork: [],
  repositoryFacts: [],
  knownRisks: [],
  recommendedNextAction: "verify",
};

export interface PreparedBootstrapRun {
  harness: Harness;
  runId: string;
  github: InitializingGitHub;
  runner: RepoFactoryBootstrapRunner;
  workRoot: string;
  ops: Operation[];
  planDigest: string;
  snapshotDigest: string;
  ceoSessionId: string;
  manifest: ProjectManifest;
  input: ProduceAndActivateInput;
}

/**
 * The run at CEO review with a PLAN of `ops` under `manifest`. A PLAN the producer cannot plan has no
 * outputs and so no review: an executable PLAN is reviewed and the PLAN under test replaces it
 * afterwards, as the runner's own witnesses do.
 */
export const prepareBootstrapRun = async (
  projectId: string,
  options: { ops: Operation[]; manifest: ProjectManifest },
): Promise<PreparedBootstrapRun> => {
  const harness = makeHarness();
  const created = harness.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: ExecutionMode.STANDARD, contract: CONTRACT });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  await dispatchBootstrapRun(harness.cp, harness.clock, runId);

  const { manifest, ops } = options;
  const plan = bootstrapPlan(manifest, { operations: ops });
  const plannable = plannedBootstrapOutputs({ runId, planArtifact: { digest: "probe", content: plan } }, manifest).allowed;
  const reviewed = await reviewBootstrapPlan(harness, runId, plannable ? plan : bootstrapPlan(cleanTreeManifest(projectId)));
  const planArtifact = plannable ? { digest: reviewed.planDigest } : harness.cp.artifacts.put(runId, "PLAN", plan);

  const workRoot = tempDir("acp-246-runner-");
  const github = new InitializingGitHub(workRoot);
  const runner = new RepoFactoryBootstrapRunner({
    runs: harness.cp.runs,
    artifacts: harness.cp.artifacts,
    ownerAuthority: harness.cp.ownerAuthority,
    bootstrap: harness.cp.bootstrap,
    githubPort: github,
    workRoot,
    clock: harness.cp.clock,
    db: harness.cp.db,
    applications: harness.cp.bootstrapApplications,
    ceo: harness.cp.ceo,
    bindings: harness.cp.bindings,
    projects: harness.cp.projects,
    repositories: harness.cp.repositories,
  });
  // As the runner's own witnesses do (#246 C3, review 1076-R3): every attempt is recorded with a writer
  // that has since exited — a real process that led its own group, its start token read while it ran,
  // its group empty — since a vitest worker does not lead its group.
  const exited = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { detached: true, stdio: "ignore" });
  const writer = {
    pid: exited.pid!,
    startToken: readProcessStartToken(exited.pid!),
    startedAt: new Date().toISOString(),
    processGroup: exited.pid!,
  };
  const gone = new Promise((resolveExit) => exited.once("exit", resolveExit));
  exited.kill("SIGKILL");
  await gone;
  await vi.waitFor(() => expect(processGroupEmpty(writer.processGroup)).toBe(true), { timeout: 10_000, interval: 20 });
  expect(writer.startToken).not.toBeNull();
  runner.attachWriterLock(() => true, () => writer);
  harness.cp.ceo.attach({ bootstrapCompletionChain: runner });
  harness.cp.bootstrap.attachCompletionChain(runner);
  await harness.cp.continuity.evaluate("bootstrap confirmation");
  return {
    harness,
    runId,
    github,
    runner,
    workRoot,
    ops,
    planDigest: planArtifact.digest,
    snapshotDigest: reviewed.snapshotDigest,
    ceoSessionId: reviewed.ceoSessionId,
    manifest,
    input: {
      runId,
      candidateSnapshotDigest: reviewed.snapshotDigest,
      ceoSessionId: reviewed.ceoSessionId,
      ownerApproval: null,
      approvedManifest: manifest,
      projectName: projectId,
      handoff: HANDOFF,
    },
  };
};

/**
 * The owner's approval as production carries it, admitted through the real ingress guard, over the
 * parameters named (by default the plan's). It is presented as the plan's own visibility; the receipt
 * is what binds the one the owner approved.
 */
export const ownerApprovalFor = (
  prepared: PreparedBootstrapRun,
  overrides: { visibility?: "public" | "private"; operations?: Operation[] } = {},
): NonNullable<ProduceAndActivateInput["ownerApproval"]> => {
  const { harness, runId } = prepared;
  const parameters = repoFactoryGitHubWriteParameters({
    owner: "acme",
    visibility: overrides.visibility ?? "public",
    planDigest: prepared.planDigest,
    githubOperations: (overrides.operations ?? prepared.ops) as never,
  });
  const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, { cli: { allowedActors: [TEST_OWNER.actor] } });
  const approval = {
    runId,
    candidateSnapshotDigest: harness.cp.runs.currentCandidate(runId),
    operation: REPO_FACTORY_GITHUB_WRITE_OPERATION,
    parameters,
    idempotencyKey: `repo-factory-write:${digestOf({ runId, parameters })}`,
    approved: true,
  };
  const admitted = guard.admitOwnerApproval(
    { channel: "cli", actor: TEST_OWNER.actor, nonce: `rf-write:${digestOf(approval)}`, payload: ownerApprovalPayload(approval) },
    approval,
  );
  if (!admitted.allowed) throw new Error(`${admitted.reasonCode}: ${admitted.message}`);
  return { owner: "acme", visibility: "public", receipt: admitted.value };
};

export const writesOf = (github: FakeGitHub): string[] => github.writes.map((write) => write.method);

/** No GitHub read or write, no result, no application. */
export const noGitHubCall = (prepared: PreparedBootstrapRun): void => {
  expect(prepared.github.writes).toEqual([]);
  expect(prepared.github.reads).toEqual([]);
  expect(prepared.harness.cp.artifacts.latest(prepared.runId, "REPO_FACTORY_RESULT")).toBeNull();
  expect(prepared.harness.cp.bootstrapApplications.get(prepared.runId)).toBeNull();
};

/**
 * produce → acknowledge the handoff → activate again → CEO CONFIRM. Returns the activation the runner
 * answered before the CONFIRM and the BOOTSTRAP_ACTIVATION_RESULT the CONFIRM wrote.
 */
export const activateAndConfirm = async (
  prepared: PreparedBootstrapRun,
): Promise<{ beforeConfirm: Record<string, unknown>; final: Record<string, unknown> }> => {
  const { harness, runId } = prepared;
  const input = { ...prepared.input, ownerApproval: ownerApprovalFor(prepared) };
  const first = await prepared.runner.produceAndActivate(input);
  if (first.allowed || first.reasonCode !== ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE) {
    throw new Error(`the first activation must wait for the handoff: ${JSON.stringify(first)}`);
  }
  const primary = harness.cp.bindings.activePrimaryCto(prepared.manifest.projectId);
  if (!primary) throw new Error("activation bound no primary CTO");
  const acked = harness.cp.bootstrap.acknowledgeActivationHandoff(first.evidence["pendingHandoffId"] as string, primary.sessionId);
  if (!acked.allowed) throw new Error(acked.message);
  const second = await prepared.runner.produceAndActivate(input);
  if (!second.allowed) throw new Error(`${second.reasonCode}: ${second.message} ${JSON.stringify(second.evidence)}`);
  await harness.cp.continuity.evaluate("bootstrap confirmation");
  const confirmed = harness.cp.ceo.submitCeoDecision({
    runId,
    decision: "CONFIRM",
    candidateSnapshotDigest: prepared.snapshotDigest,
    ceoSessionId: prepared.ceoSessionId,
    rationale: "apply the bootstrap",
  });
  if (!confirmed.allowed) throw new Error(`${confirmed.reasonCode}: ${confirmed.message}`);
  expect(harness.cp.runs.require(runId).state).toBe(RunState.COMPLETED);
  const final = harness.cp.artifacts.latest<Record<string, unknown>>(runId, "BOOTSTRAP_ACTIVATION_RESULT");
  if (final === null) throw new Error("no BOOTSTRAP_ACTIVATION_RESULT");
  return { beforeConfirm: second.value as unknown as Record<string, unknown>, final: final.content };
};

/**
 * C3's proof that a request was never sent, for every intent the GitHub ledger in `workDir` holds
 * pending: the withheld record the runner writes, for the digest of the whole intent and a request
 * generation, when it refuses a request at its start. A producer row whose double refused a request
 * before mutating anything writes it to say exactly that, so the producer may send the request again
 * (#246 C5, review C5I-R1-02). `attempt` is the request generation that withheld it.
 */
export const withholdPending = (workDir: string, attempt = 1, role = "primary"): Array<Record<string, unknown>> => {
  const ledger = JSON.parse(readFileSync(join(workDir, "github-ledger", `${role}.json`), "utf8")) as {
    pending: Array<Record<string, unknown> & { operationId: string; resourceType: string; attemptedAt: string }>;
  };
  for (const intent of ledger.pending) {
    writeWithheldRequest(workDir, {
      runId: "run_withheld_fixture",
      operationId: intent.operationId,
      resourceType: intent.resourceType,
      intentDigest: digestOf(intent),
      attemptedAt: intent.attemptedAt,
      attempt,
      withheldAt: intent.attemptedAt,
      refusal: "WITHHELD_BEFORE_SEND",
    });
  }
  return ledger.pending;
};
