import { readFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import * as planModule from "../../src/bootstrap/bootstrap-plan.ts";
import { bootstrapActivationHandoff } from "../../src/bootstrap/bootstrap-plan.ts";
import type { RepoFactoryResult } from "../../src/bootstrap/repo-factory-result.ts";
import { allow } from "../../src/core/errors.ts";
import { manifestDigest, type ProjectManifest } from "../../src/contracts/manifest.ts";
import type { HandoffPackage } from "../../src/cto/cto-lifecycle.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, RunState, SessionLifecycle } from "../../src/domain/types.ts";
import { git } from "../../src/git/git.ts";
import { cleanTreeManifest } from "../helpers/bootstrap-plan.ts";
import { ownerApprovalFor, type PreparedBootstrapRun, prepareBootstrapRun } from "../helpers/bootstrap-runner.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * Review of run_7717 (BLOCK, F2–F6) — what the CEO's CONFIRM completion transaction of a project-less
 * bootstrap requires beyond activation, each refusal witnessed with nothing completed: no run COMPLETED,
 * no application COMPLETED, no task SUCCEEDED and no completion audit. And the ordinary path still
 * completes, delivering the repository facts the create's readback observed.
 */

type Operation = PreparedBootstrapRun["ops"][number];

const IDENTITY = "github:acme/fixture";
const CREATE_OPERATION = "create-repository:fixture";

const createOnlyOperations = (): Operation[] => [
  { operationId: CREATE_OPERATION, resourceType: "repository", resourceIdentity: IDENTITY, desiredState: { visibility: "public", autoInit: true } },
] as Operation[];

const manifestFor = (projectId: string): ProjectManifest => {
  const base = cleanTreeManifest(projectId);
  return { ...base, branchProfile: { ...base.branchProfile, defaultBranch: "main" } };
};

/** As production delivers it: the PLAN-time package, its repository facts not yet observed. */
const prepare = async (projectId: string, options: { legacyTask?: boolean } = {}) => {
  const manifest = manifestFor(projectId);
  const prepared = await prepareBootstrapRun(projectId, { ops: createOnlyOperations(), manifest, ...options });
  return { ...prepared, input: { ...prepared.input, handoff: bootstrapActivationHandoff(manifest), ownerApproval: ownerApprovalFor(prepared) } };
};

/** Produce under the owner's approval: the create is made and receipted, and the handoff opened and PENDING. */
const produce = async (prepared: PreparedBootstrapRun): Promise<string> => {
  const first = await prepared.runner.produceAndActivate(prepared.input);
  expect(first, JSON.stringify(first)).toMatchObject({ allowed: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
  expect(prepared.github.createRequests).toHaveLength(1);
  return first.evidence["pendingHandoffId"] as string;
};

const primaryOf = (prepared: PreparedBootstrapRun) => prepared.harness.cp.bindings.activePrimaryCto(prepared.manifest.projectId)!;

/** ACK by the recipient, activate again (the WRITTEN application resumes): ready for the CONFIRM. */
const ackAndActivate = async (prepared: PreparedBootstrapRun, handoffId: string) => {
  expect(prepared.harness.cp.bootstrap.acknowledgeActivationHandoff(handoffId, primaryOf(prepared).sessionId)).toMatchObject({ allowed: true });
  const second = await prepared.runner.produceAndActivate(prepared.input);
  expect(second, JSON.stringify(second)).toMatchObject({ allowed: true });
  await prepared.harness.cp.continuity.evaluate("bootstrap confirmation");
};

const confirm = (prepared: PreparedBootstrapRun) =>
  prepared.harness.cp.ceo.submitCeoDecision({
    runId: prepared.runId,
    decision: "CONFIRM",
    candidateSnapshotDigest: prepared.snapshotDigest,
    ceoSessionId: prepared.ceoSessionId,
    rationale: "apply the bootstrap",
  });

const auditsOf = (prepared: PreparedBootstrapRun, kind: string) =>
  prepared.harness.cp.audit.byKind(kind).filter((row) => row.runId === prepared.runId);

/** CEO fa88aa72 — a refused CONFIRM writes no false success record of any kind. */
const nothingCompleted = (prepared: PreparedBootstrapRun) => {
  const { harness, runId } = prepared;
  expect(harness.cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
  expect(harness.cp.bootstrapApplications.get(runId)?.phase).toBe("WRITTEN");
  expect(harness.cp.tasks.list(runId).map((task) => task.state)).toEqual(["READY"]);
  expect(harness.cp.artifacts.latest(runId, "BOOTSTRAP_ACTIVATION_RESULT")).toBeNull();
  for (const kind of ["BOOTSTRAP_ACTIVATED", "BOOTSTRAP_TASK_SETTLED", "BOOTSTRAP_APPLICATION_COMPLETED", "CEO_DECISION"]) {
    expect(auditsOf(prepared, kind), kind).toEqual([]);
  }
  expect(prepared.github.createRequests).toHaveLength(1);
};

/** The create's own receipt, as the attempt ledger holds it: the default branch and head its readback observed. */
const createReadback = (prepared: PreparedBootstrapRun): { defaultBranch: string; initializedHead: string } => {
  const ledger = JSON.parse(readFileSync(join(prepared.workRoot, prepared.runId, "github-ledger", "primary.json"), "utf8")) as {
    receipts: Array<{ operationId: string; observed: { defaultBranch?: string; initializedHead?: string } }>;
  };
  const observed = ledger.receipts.find((receipt) => receipt.operationId === CREATE_OPERATION)!.observed;
  return { defaultBranch: observed.defaultBranch!, initializedHead: observed.initializedHead! };
};

const deliveredHandoff = (prepared: PreparedBootstrapRun, handoffId: string): HandoffPackage => {
  const row = prepared.harness.cp.db.get<{ package_json: string }>(`SELECT package_json FROM handoffs WHERE handoff_id = ?`, [handoffId]);
  return JSON.parse(row!.package_json) as HandoffPackage;
};

describe("the ordinary path: produce, ACK, activate, CONFIRM completes with the observed repository facts", () => {
  it("the delivered handoff carries the create's observed branch and parentless head; CONFIRM completes the run, the application and the task", async () => {
    const prepared = await prepare("bcg-ordinary");
    const handoffId = await produce(prepared);
    const readback = createReadback(prepared);
    expect(readback.defaultBranch).toBe("main");
    expect(readback.initializedHead).toMatch(/^[0-9a-f]{40}$/);
    const bare = prepared.github.repository("acme", "fixture")!.bare;
    expect((await git(bare, ["rev-parse", "refs/heads/main"])).stdout.trim()).toBe(readback.initializedHead);
    // The PLAN-time package shows no observed fact; the delivered one carries the readback's.
    expect(prepared.input.handoff.repositoryFacts).toEqual([{ identity: IDENTITY, branch: null, head: null }]);
    expect(deliveredHandoff(prepared, handoffId).repositoryFacts).toEqual([{ identity: IDENTITY, branch: "main", head: readback.initializedHead }]);

    await ackAndActivate(prepared, handoffId);
    expect(confirm(prepared)).toMatchObject({ allowed: true, value: { state: RunState.COMPLETED } });
    const { harness, runId } = prepared;
    expect(harness.cp.runs.require(runId).state).toBe(RunState.COMPLETED);
    expect(harness.cp.bootstrapApplications.get(runId)?.phase).toBe("COMPLETED");
    expect(harness.cp.tasks.list(runId).map((task) => task.state)).toEqual(["SUCCEEDED"]);
    expect(auditsOf(prepared, "BOOTSTRAP_ACTIVATED")).toHaveLength(1);
    expect(auditsOf(prepared, "BOOTSTRAP_TASK_SETTLED")).toHaveLength(1);
    expect(prepared.github.createRequests).toHaveLength(1);
  });
});

describe("F2: the CONFIRM transaction rechecks the active manifest against the PLAN's", () => {
  it("the project's active manifest and its repository binding moved together after activation: CONFIRM is refused and nothing completes", async () => {
    const prepared = await prepare("bcg-manifest");
    await ackAndActivate(prepared, await produce(prepared));
    const { harness } = prepared;
    const projectId = prepared.manifest.projectId;
    // A raw writer on its own connection moves both pointers to another manifest, the trigger that
    // guards the project's pointer out of its way: the bindings stay on the project's active manifest.
    const other = cleanTreeManifest(projectId);
    const otherDigest = manifestDigest(other);
    expect(otherDigest).not.toBe(manifestDigest(prepared.manifest));
    const raw = new Database(harness.cp.config.databasePath);
    try {
      raw.prepare(`INSERT INTO manifests (digest, schema_id, content_json, created_at) VALUES (?, ?, ?, ?)`).run(
        otherDigest,
        other.schema,
        JSON.stringify(other),
        harness.clock.nowIso(),
      );
      raw.exec("DROP TRIGGER projects_active_manifest_moves_by_grant");
      raw.prepare(`UPDATE projects SET active_manifest_digest = ? WHERE project_id = ?`).run(otherDigest, projectId);
      raw.prepare(`UPDATE repositories SET active_manifest_digest = ? WHERE project_id = ?`).run(otherDigest, projectId);
    } finally {
      raw.close();
    }
    expect(harness.cp.projects.get(projectId)?.activeManifestDigest).toBe(otherDigest);

    const refused = confirm(prepared);
    expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.BOOTSTRAP_CONTRACT_DRIFT, evidence: { refusal: "ACTIVE_MANIFEST_NOT_PLANNED" } });
    nothingCompleted(prepared);
  });
});

describe("F3: the acknowledged recipient must be the PRIMARY_CTO bound at CONFIRM", () => {
  it("ACK by A, PRIMARY_CTO reassigned to B: CONFIRM is refused and nothing completes", async () => {
    const prepared = await prepare("bcg-recipient");
    await ackAndActivate(prepared, await produce(prepared));
    const { harness } = prepared;
    const projectId = prepared.manifest.projectId;
    const acknowledger = primaryOf(prepared).sessionId;
    const replacement = harness.cp.sessions.create({ provider: "scripted", model: "scripted-cto" });
    expect(harness.cp.sessions.transition(replacement.sessionId, SessionLifecycle.READY, "replacement CTO").allowed).toBe(true);
    harness.cp.sessions.setBuzzAddress(replacement.sessionId, "buzz:replacement-cto");
    const switched = harness.cp.bindings.switchTo({
      role: Role.PRIMARY_CTO,
      projectId,
      sessionId: replacement.sessionId,
      reason: "reassigned after the ACK",
      conversation: "REPLACED",
      takeover: true,
    });
    expect(switched, JSON.stringify(switched)).toMatchObject({ allowed: true });
    expect(primaryOf(prepared).sessionId).toBe(replacement.sessionId);

    const refused = confirm(prepared);
    expect(refused).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.HANDOFF_ACK_REQUIRED,
      evidence: { refusal: "ACK_RECIPIENT_NOT_PRIMARY_CTO", handoffRecipient: acknowledger, primaryCto: replacement.sessionId },
    });
    nothingCompleted(prepared);
  });
});

describe("F4: an ACK is accepted only for a handoff carrying the observed branch and head", () => {
  for (const [name, tamper] of [
    ["a null head", (facts: HandoffPackage["repositoryFacts"]) => facts.map((fact) => ({ ...fact, head: null }))],
    ["a null branch", (facts: HandoffPackage["repositoryFacts"]) => facts.map((fact) => ({ ...fact, branch: null }))],
    ["another head", (facts: HandoffPackage["repositoryFacts"]) => facts.map((fact) => ({ ...fact, head: "0".repeat(40) }))],
    ["another branch", (facts: HandoffPackage["repositoryFacts"]) => facts.map((fact) => ({ ...fact, branch: "dev" }))],
    ["no fact at all", () => []],
  ] as const) {
    it(`a delivered handoff with ${name} is refused at ACK; CONFIRM is then refused and nothing completes`, async () => {
      const prepared = await prepare(`bcg-facts-${name.replaceAll(" ", "-")}`);
      const handoffId = await produce(prepared);
      const delivered = deliveredHandoff(prepared, handoffId);
      prepared.harness.cp.db.run(`UPDATE handoffs SET package_json = ? WHERE handoff_id = ?`, [
        JSON.stringify({ ...delivered, repositoryFacts: tamper(delivered.repositoryFacts) }),
        handoffId,
      ]);
      const ack = prepared.harness.cp.bootstrap.acknowledgeActivationHandoff(handoffId, primaryOf(prepared).sessionId);
      expect(ack).toMatchObject({ allowed: false, reasonCode: ReasonCode.HANDOFF_PACKAGE_INCOMPLETE, evidence: { refusal: "HANDOFF_FACTS_NOT_OBSERVED" } });
      const status = prepared.harness.cp.db.get<{ status: string }>(`SELECT status FROM handoffs WHERE handoff_id = ?`, [handoffId]);
      expect(status?.status).toBe("PENDING");
      expect(confirm(prepared)).toMatchObject({ allowed: false });
      nothingCompleted(prepared);
    });
  }
});

describe("F6: settlement requires the task's BOOTSTRAP_PLAN_TASKS binding to the current PLAN", () => {
  it("a bound run's review prompt states this run's task is bound, from the store", async () => {
    const prepared = await prepare("bcg-bound");
    const [task] = prepared.harness.cp.tasks.list(prepared.runId);
    const prompt = prepared.harness.scripted.invocations.find((invocation) => invocation.prompt.startsWith("# Bootstrap plan review"))!.prompt;
    const lines = prompt.split("\n");
    const guarantees = lines.indexOf("Guarantees the control plane implements after CONFIRM:");
    const notVerified = lines.indexOf("Conditions the control plane does not verify:");
    const bound = lines.findIndex((line) => line.startsWith("- [plan-task-provenance-this-run]"));
    expect(bound).toBeGreaterThan(guarantees);
    expect(bound).toBeLessThan(notVerified);
    expect(lines[bound]).toContain(`task ${task!.taskId} is bound to its current PLAN ${prepared.planDigest} by a BOOTSTRAP_PLAN_TASKS record`);
  });

  it("a legacy-shaped run's review prompt keeps the NOT_VERIFIED disclosure for this run, from the store", async () => {
    const prepared = await prepare("bcg-legacy-prompt", { legacyTask: true });
    expect(auditsOf(prepared, "BOOTSTRAP_PLAN_TASKS")).toEqual([]);
    const prompt = prepared.harness.scripted.invocations.find((invocation) => invocation.prompt.startsWith("# Bootstrap plan review"))!.prompt;
    const lines = prompt.split("\n");
    const notVerified = lines.indexOf("Conditions the control plane does not verify:");
    const legacy = lines.findIndex((line) => line.startsWith("- [plan-task-provenance-this-run]"));
    expect(legacy).toBeGreaterThan(notVerified);
    expect(lines[legacy]).toContain("no BOOTSTRAP_PLAN_TASKS record");
  });

  it("a legacy-shaped run (its task stored before any PLAN, no record) is refused at settlement: nothing completes", async () => {
    const prepared = await prepare("bcg-legacy", { legacyTask: true });
    const { harness, runId } = prepared;
    expect(auditsOf(prepared, "BOOTSTRAP_PLAN_TASKS")).toEqual([]);
    await ackAndActivate(prepared, await produce(prepared));
    const refused = confirm(prepared);
    expect(refused).toMatchObject({ allowed: false, evidence: { refusal: "BOOTSTRAP_TASK_PLAN_UNRECORDED" } });
    expect(harness.cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
    nothingCompleted(prepared);
  });
});

/**
 * PR #1122 R1 (BCG-R1-01) — a handoff persisted before activation delivered observed facts. Its package is
 * checked at CONFIRM, ACKed or not, and an activation retry reissues it with the observed facts for a new
 * ACK from the current PRIMARY_CTO; the earlier handoff and its ACK are kept and prove nothing.
 */
describe("BCG-R1-01: a persisted handoff without the observed facts", () => {
  /** What the implementation before F4 persisted: the PLAN-time package delivered, and its ACK accepted. */
  const asBeforeF4 = (prepared: PreparedBootstrapRun, options: { ack: boolean }) => {
    vi.spyOn(planModule, "deliveredBootstrapHandoff").mockImplementation((planned) => planned);
    if (options.ack) {
      vi.spyOn(prepared.harness.cp.bootstrap as unknown as { observedHandoffFacts: () => unknown }, "observedHandoffFacts").mockReturnValue(
        allow(ReasonCode.OK, undefined),
      );
    }
  };

  it("an ACKed package with null branch and head: CONFIRM is refused HANDOFF_FACTS_NOT_OBSERVED and nothing completes", async () => {
    const prepared = await prepare("bcg-r1-acked");
    asBeforeF4(prepared, { ack: true });
    const handoffId = await produce(prepared);
    await ackAndActivate(prepared, handoffId);
    vi.restoreAllMocks();
    expect(deliveredHandoff(prepared, handoffId).repositoryFacts).toEqual([{ identity: IDENTITY, branch: null, head: null }]);
    expect(prepared.harness.cp.db.get<{ status: string }>(`SELECT status FROM handoffs WHERE handoff_id = ?`, [handoffId])?.status).toBe("ACKED");
    expect(confirm(prepared)).toMatchObject({ allowed: false, reasonCode: ReasonCode.HANDOFF_PACKAGE_INCOMPLETE, evidence: { refusal: "HANDOFF_FACTS_NOT_OBSERVED" } });
    nothingCompleted(prepared);
  });

  it("a PENDING package with null facts: refused at ACK and at CONFIRM, reissued by the activation retry, ACKed anew by the current PRIMARY_CTO, then completed", async () => {
    const prepared = await prepare("bcg-r1-pending");
    asBeforeF4(prepared, { ack: false });
    const stale = await produce(prepared);
    vi.restoreAllMocks();
    const { harness } = prepared;
    const primary = primaryOf(prepared).sessionId;
    expect(harness.cp.bootstrap.acknowledgeActivationHandoff(stale, primary)).toMatchObject({ allowed: false, evidence: { refusal: "HANDOFF_FACTS_NOT_OBSERVED" } });

    const retried = await prepared.runner.produceAndActivate(prepared.input);
    expect(retried, JSON.stringify(retried)).toMatchObject({ allowed: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
    const reissued = retried.evidence["pendingHandoffId"] as string;
    expect(reissued).not.toBe(stale);
    const readback = createReadback(prepared);
    expect(deliveredHandoff(prepared, reissued).repositoryFacts).toEqual([{ identity: IDENTITY, branch: "main", head: readback.initializedHead }]);
    // The earlier handoff is kept as it was, and neither it nor a CONFIRM before the new ACK completes anything.
    const rows = harness.cp.db.all<{ handoff_id: string; status: string; to_session_id: string }>(
      `SELECT handoff_id, status, to_session_id FROM handoffs WHERE project_id = ? ORDER BY created_at, rowid`,
      [prepared.manifest.projectId],
    );
    expect(rows).toEqual([
      { handoff_id: stale, status: "PENDING", to_session_id: primary },
      { handoff_id: reissued, status: "PENDING", to_session_id: primary },
    ]);
    expect(harness.cp.audit.byKind("HANDOFF_SUBMITTED").filter((row) => row.evidence["handoffId"] === reissued).map((row) => row.evidence["reissuedFrom"])).toEqual([stale]);
    expect(harness.cp.bootstrap.acknowledgeActivationHandoff(stale, primary).allowed).toBe(false);
    expect(confirm(prepared)).toMatchObject({ allowed: false });
    nothingCompleted(prepared);

    await ackAndActivate(prepared, reissued);
    expect(confirm(prepared)).toMatchObject({ allowed: true, value: { state: RunState.COMPLETED } });
    expect(harness.cp.bootstrapApplications.get(prepared.runId)?.phase).toBe("COMPLETED");
    expect(harness.cp.tasks.list(prepared.runId).map((task) => task.state)).toEqual(["SUCCEEDED"]);
    expect(harness.cp.artifacts.latest<{ handoffAck: { handoffId: string } }>(prepared.runId, "BOOTSTRAP_ACTIVATION_RESULT")?.content.handoffAck.handoffId).toBe(reissued);
    expect(prepared.github.createRequests).toHaveLength(1);
  });
});

/**
 * PR #1122 R1 (BCG-R1-02) — the handoff's head is the one the run's required verification names for the
 * PLAN's target, one head across every verification row, and the create's readback at completion.
 */
describe("BCG-R1-02: the delivered head is bound to the required verification and the create's readback", () => {
  /** A factory result altered at activation's input boundary, the receipts and ledger left as they are. */
  const alterAtActivation = (prepared: PreparedBootstrapRun, alter: (result: RepoFactoryResult, checkoutPath: string) => Promise<RepoFactoryResult>) => {
    const bootstrap = prepared.harness.cp.bootstrap;
    const activate = bootstrap.activate.bind(bootstrap);
    vi.spyOn(bootstrap, "activate").mockImplementation(async (input) =>
      activate({ ...input, factoryResult: await alter(input.factoryResult as RepoFactoryResult, input.localBindings[0]!.checkoutPath) }),
    );
  };

  const noHandoff = (prepared: PreparedBootstrapRun) => {
    expect(prepared.harness.cp.artifacts.latest(prepared.runId, "HANDOFF")).toBeNull();
    expect(prepared.harness.cp.db.all(`SELECT handoff_id FROM handoffs WHERE project_id = ?`, [prepared.manifest.projectId])).toEqual([]);
  };

  for (const [name, row] of [
    ["an all-zero head under another command, prepended", (head: string) => [{ commandId: "unrelated-command", head: "0".repeat(40) }, { commandId: "clean-tree", head }]],
    ["a second well-formed head under the required command", (head: string) => [{ commandId: "clean-tree", head }, { commandId: "clean-tree", head: "0123456789abcdef0123456789abcdef01234567" }]],
  ] as const) {
    it(`conflicting verification rows (${name}) are refused at activation: no handoff is delivered and CONFIRM completes nothing`, async () => {
      const prepared = await prepare(`bcg-r1-rows-${name.split(" ")[1]}`);
      alterAtActivation(prepared, async (result) => ({
        ...result,
        bootstrapVerification: row(result.bootstrapVerification[0]!.exactHead).map(({ commandId, head }) => ({
          commandId,
          repositoryIdentity: IDENTITY,
          exactHead: head,
          status: "PASS" as const,
        })),
      }));
      const refused = await prepared.runner.produceAndActivate(prepared.input);
      expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.HANDOFF_PACKAGE_INCOMPLETE, evidence: { refusal: "RESULT_FACTS_UNBOUND" } });
      noHandoff(prepared);
      expect(confirm(prepared)).toMatchObject({ allowed: false });
      nothingCompleted(prepared);
    });
  }

  it("a well-formed head that is not the create's readback (the checkout moved to it, one coherent row): ACKed, then refused at completion with nothing completed", async () => {
    const prepared = await prepare("bcg-r1-not-readback");
    let moved = "";
    alterAtActivation(prepared, async (result, checkoutPath) => {
      if (moved === "") {
        await git(checkoutPath, ["-c", "user.email=other@example.com", "-c", "user.name=other", "commit", "-q", "--allow-empty", "-m", "a later commit"]);
        moved = (await git(checkoutPath, ["rev-parse", "HEAD"])).stdout.trim();
      }
      return { ...result, bootstrapVerification: result.bootstrapVerification.map((row) => ({ ...row, exactHead: moved })) };
    });
    const handoffId = await produce(prepared);
    vi.restoreAllMocks();
    const readback = createReadback(prepared);
    expect(moved).toMatch(/^[0-9a-f]{40}$/);
    expect(moved).not.toBe(readback.initializedHead);
    expect(deliveredHandoff(prepared, handoffId).repositoryFacts).toEqual([{ identity: IDENTITY, branch: "main", head: moved }]);
    expect(prepared.harness.cp.bootstrap.acknowledgeActivationHandoff(handoffId, primaryOf(prepared).sessionId)).toMatchObject({ allowed: true });
    const resumed = await prepared.runner.produceAndActivate(prepared.input);
    expect(resumed).toMatchObject({ allowed: false, evidence: { refusal: "WRITTEN_RESULT_UNATTRIBUTED" } });
    const refused = confirm(prepared);
    expect(refused).toMatchObject({ allowed: false, evidence: { refusal: "WRITTEN_RESULT_UNATTRIBUTED", readback: { head: readback.initializedHead } } });
    nothingCompleted(prepared);
  });
});
