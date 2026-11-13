import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { carriedBootstrapAdoption } from "../../src/bootstrap/canonical-cto-bootstrap-adoption.ts";
import { type Decision, allow } from "../../src/core/errors.ts";
import { sha256 } from "../../src/core/digest.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { executeCanonicalSelfClaimOperator } from "../../src/daemon/canonical-self-claim-operator.ts";
import { Role, RunKind, roleKeyFor } from "../../src/domain/types.ts";
import { type CanonicalSelfClaimReceipt, type ProcessSnapshot, hostSessionRegistryAbsent } from "../../src/registry/canonical-self-claim.ts";
import { CanonicalSessionRegistry } from "../../src/registry/canonical-session-registry.ts";
import type { HostObservation, HostOperation, HostProjectProvisioner } from "../../src/runtime/host-project-provisioner.ts";
import { reviewBootstrapPlan } from "../helpers/bootstrap-plan.ts";
import { callCtoTool } from "../helpers/cto-tool.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { GenesisGitHub, genesisPlanFixture } from "../helpers/genesis-github.ts";
import { bindCeo, bootstrapCtoProvider, decideThroughHermes, makeHarness, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const stragglers: ChildProcess[] = [];
afterEach(() => {
  for (const child of stragglers.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

/**
 * v57, review r1 P1-a/P1-b. A PROJECT_BOOTSTRAP run that adopted a project's canonical CTO has no project_id: it
 * holds the project through its owner pin in the PRIMARY_CTO role. A CEO entitlement transfer must wait for its
 * running work like any other run of the project, and once the new conversation claims, the adoption follows the
 * pin the transfer's hand-over moved, so the bootstrap continues under the new owner.
 */

const contract = { goal: "bootstrap", why: "transfer witness", scope: [], nonGoals: [], acceptance: ["developable"], priority: "NORMAL" as const, humanGate: [], references: [] };
const UID = 501;

class RecordingHost implements HostProjectProvisioner {
  async invoke(_operation: HostOperation): Promise<HostObservation> {
    throw new Error("an adopting bootstrap reached the resident host provisioner");
  }
}

const harness = () => {
  const root = realpathSync(tempDir("adopted-bootstrap-transfer-"));
  mkdirSync(join(root, "home"));
  const port = new GenesisGitHub(root);
  const h = makeHarness({ repoFactory: { workRoot: join(root, "factory"), githubPort: port }, residentProvisioner: { home: join(root, "home"), port: new RecordingHost() } });
  h.cp.residentProjects.attachSubscriber(async () => true);
  h.cp.bootstrapProducer.attachWriterLock(() => true);
  bootstrapCtoProvider(h.cp, h.clock);
  return Object.assign(h, { port });
};

const standIn = async (): Promise<{ pid: number; startedAt: string }> => {
  const child = spawn("/bin/sleep", ["600"], { stdio: "ignore" });
  stragglers.push(child);
  await once(child, "spawn");
  const startedAt = readProcessStartToken(child.pid!);
  if (startedAt === null) throw new Error("the stand-in process has no readable start token");
  return { pid: child.pid!, startedAt };
};

/** A manifest-less project whose canonical CTO (gen 1) adopted a dispatched bootstrap run; claims go through the operator door. */
const adoptedBootstrap = async (h: Harness, projectId: string, options: { transferFirst?: boolean; noBootstrap?: boolean } = {}) => {
  const oldUuid = randomUUID();
  const newUuid = randomUUID();
  const buzzActorId = "7".repeat(64);
  const roomId = randomUUID();
  const cwd = realpathSync(tempDir("adopted-transfer-cwd-"));
  h.cp.projects.register({ projectId, name: projectId });
  const registry = new CanonicalSessionRegistry(h.cp.db);
  const configured = [{ sessionUuid: oldUuid, projectId, buzzActorId, buzzAddress: roomId }];
  registry.grant(configured[0]!, null);
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
  const claimAs = (uuid: string, generation: number, claude: { pid: number; startedAt: string }): Promise<Decision<CanonicalSelfClaimReceipt>> => {
    const chain: ProcessSnapshot[] = [
      { pid: 100, ppid: 50, argv: ["node", "mcp"], command: "node mcp", cwd, cwdProbeFailure: null, startedAt: "peer" },
      { pid: 50, ppid: claude.pid, argv: ["/bin/zsh", "-c", "relay"], command: "relay", cwd, cwdProbeFailure: null, startedAt: "relay" },
      { pid: claude.pid, ppid: 1, argv: ["/test/claude", "--resume", uuid], command: "claude", cwd, cwdProbeFailure: null, startedAt: claude.startedAt },
    ];
    return executeCanonicalSelfClaimOperator({ peerPid: 100, uid: UID }, { claimedSessionUuid: uuid, projectId, expectedBindingGeneration: generation }, {
      db: h.cp.db, clock: h.clock, audit: h.cp.audit, sessions: h.cp.sessions, bindings: h.cp.bindings,
      buzzActorAuthenticator: { isAllowedActor: () => true },
      resolveBuzzAddress: async (): Promise<Decision<string>> => allow(ReasonCode.OK, roomId),
      config: {
        canonicalSessions: configured, canonicalBuzzChannelId: roomId, expectedPeerProtocolVersion: "test",
        expectedPeerIdentity: `uid:${UID}`, peerProtocolVersion: "test", buzzPurpose: "test",
      },
      claimDeps: {
        processInspector: { snapshot: (asked) => chain.find((entry) => entry.pid === asked) ?? null },
        imageInspector: { resolve: () => null },
        transcriptReader: { locate: () => ({ path: "/test/transcript", sizeBytes: 10 }) },
        hostSessionRegistryReader: { read: () => hostSessionRegistryAbsent("test") },
        processSignal: (pid) => {
          if (chain.some((entry) => entry.pid === pid)) return;
          throw Object.assign(new Error(`no such process: ${pid}`), { code: "ESRCH" });
        },
      },
    });
  };
  const first = await claimAs(oldUuid, 1, await standIn());
  if (!first.allowed) throw new Error(`the old conversation's claim failed: ${JSON.stringify(first)}`);
  const oldSessionId = first.value.sessionId;
  const transfer = () => h.cp.db.txDecision(() => registry.transfer(
    { projectId, fromSessionUuid: oldUuid, toSessionUuid: newUuid, expectedBindingGeneration: 1 }, "ceo", h.clock.nowIso()));
  if (options.noBootstrap) return { projectId, roleKey, oldUuid, newUuid, oldSessionId, runId: "", claimAs, transfer };
  if (options.transferFirst) expect(transfer().allowed).toBe(true);
  const created = h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD", contract, adoptCanonicalCto: { projectId, sessionId: oldSessionId, bindingGeneration: 1 } });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const dispatched = await h.cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  expect(h.cp.runs.require(runId)).toMatchObject({ projectId: null, ownerRoleKey: roleKey, ownerSessionId: oldSessionId, ownerBindingGeneration: 1 });
  return { projectId, roleKey, oldUuid, newUuid, oldSessionId, runId, claimAs, transfer };
};

/** The transfer's first line of defence switched off, to reach the doors behind it (defence in depth). */
const withoutBootstrapBlock = () =>
  vi.spyOn(CanonicalSessionRegistry.prototype, "adoptedBootstrapBeforeFirstManifest").mockReturnValue(null);

describe("an adopted bootstrap and a canonical entitlement transfer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("r2 P1: a transfer is refused while an adopted bootstrap of the project has no first manifest yet", async () => {
    const h = harness();
    const f = genesisPlanFixture();
    const a = await adoptedBootstrap(h, f.manifest.projectId);
    expect(a.transfer()).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT, evidence: { refusal: "TRANSFER_BLOCKED_BY_ADOPTED_BOOTSTRAP", runId: a.runId } });
    expect(h.cp.db.all(`SELECT 1 FROM canonical_entitlement_transfers`)).toEqual([]);
    // Once the bootstrap is cancelled, the transfer goes through.
    expect(h.cp.runs.cancel(a.runId, "superseded by the transfer").allowed).toBe(true);
    expect(a.transfer().allowed).toBe(true);
  });

  it("r2 P1: a bootstrap adopted while a transfer is pending blocks the transfer's claim, and the old CTO keeps it", async () => {
    const h = harness();
    const f = genesisPlanFixture();
    const a = await adoptedBootstrap(h, f.manifest.projectId, { transferFirst: true });
    const claimed = await a.claimAs(a.newUuid, 2, { pid: process.pid, startedAt: readProcessStartToken(process.pid)! });
    expect(claimed).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT, evidence: { refusal: "TRANSFER_BLOCKED_BY_ADOPTED_BOOTSTRAP" } });
    expect(h.cp.runs.require(a.runId)).toMatchObject({ ownerSessionId: a.oldSessionId, ownerBindingGeneration: 1 });
    expect(new CanonicalSessionRegistry(h.cp.db).holder(a.projectId)?.sessionUuid).toBe(a.oldUuid);
  });

  it("r2 P1: once a transfer is claimed, a manifest-less project adopts no new bootstrap", async () => {
    const h = harness();
    const f = genesisPlanFixture();
    const a = await adoptedBootstrap(h, f.manifest.projectId, { noBootstrap: true });
    expect(a.transfer().allowed).toBe(true);
    const claimed = await a.claimAs(a.newUuid, 2, { pid: process.pid, startedAt: readProcessStartToken(process.pid)! });
    expect(claimed.allowed, JSON.stringify(claimed)).toBe(true);
    if (!claimed.allowed) throw new Error("unreachable");
    const created = h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD", contract, adoptCanonicalCto: { projectId: a.projectId, sessionId: claimed.value.sessionId, bindingGeneration: 2 } });
    expect(created).toMatchObject({ allowed: false, evidence: { refusal: "ADOPTION_ENTITLEMENT_TRANSFERRED" } });
  });

  it("P1-b: a RUNNING pipeline attempt of an adopted bootstrap run (no project_id) blocks the transfer", async () => {
    const h = harness();
    const f = genesisPlanFixture();
    const a = await adoptedBootstrap(h, f.manifest.projectId);
    h.cp.db.run(
      `INSERT INTO candidate_pipeline_attempts (run_id, attempt_id, owner_session_id, owner_binding_generation, state, started_at, deadline_at)
       VALUES (?, 'cpa_adopted', ?, 1, 'RUNNING', ?, '2999-01-01T00:00:00.000Z')`,
      [a.runId, a.oldSessionId, h.clock.nowIso()],
    );
    expect(a.transfer()).toMatchObject({ allowed: false, reasonCode: ReasonCode.PREDECESSOR_WORKER_TURN_IN_FLIGHT, evidence: { runId: a.runId } });
    expect(h.cp.db.all(`SELECT 1 FROM canonical_entitlement_transfers`)).toEqual([]);
  });

  it("P1-a (defence in depth): after the transfer's claim, the adoption follows the moved pin and the new owner stages the bootstrap PLAN", async () => {
    withoutBootstrapBlock();
    const h = harness();
    const f = genesisPlanFixture();
    const a = await adoptedBootstrap(h, f.manifest.projectId);
    expect(a.transfer().allowed).toBe(true);
    const claimed = await a.claimAs(a.newUuid, 2, { pid: process.pid, startedAt: readProcessStartToken(process.pid)! });
    expect(claimed.allowed, JSON.stringify(claimed)).toBe(true);
    if (!claimed.allowed) throw new Error("unreachable");
    const successorId = claimed.value.sessionId;
    expect(h.cp.runs.require(a.runId)).toMatchObject({ ownerSessionId: successorId, ownerBindingGeneration: 2 });
    expect(carriedBootstrapAdoption(h.cp.db, a.runId)).toMatchObject({ sessionId: successorId, bindingGeneration: 2, entitlementSessionUuid: a.newUuid });

    bindCeo(h);
    const run = h.cp.runs.require(a.runId);
    const plan = { ...f.artifact.content, requestDigest: run.contractDigest };
    const planBody = JSON.stringify({ runId: a.runId, plan, tasks: [{ key: "create", title: "Create repository", category: "implementation" }] });
    const args = {
      idempotencyKey: `stage-${a.runId}`, runId: a.runId, planBody, expectedSha256: sha256(planBody), contractDigest: run.contractDigest!,
      bootstrapOperationId: f.artifact.content.bootstrapOperationId as string, projectId: f.manifest.projectId,
      repositoryIdentity: f.manifest.repositories[0]!.remote,
    };
    const as = (sessionId: string) => ({ sessionId, incarnation: h.cp.sessions.require(sessionId).incarnation });
    expect(await callCtoTool(h, as(a.oldSessionId), "bootstrap_plan_stage", { ...args, idempotencyKey: "stale-stage" })).toMatchObject({ ok: false });
    const staged = await callCtoTool(h, as(successorId), "bootstrap_plan_stage", args);
    expect(staged, JSON.stringify(staged)).toMatchObject({ ok: true, value: { digest: args.expectedSha256, stagedBy: a.roleKey } });
    expect(h.cp.audit.forRun(a.runId).filter((row) => row.kind === "BOOTSTRAP_PLAN_STAGED").map((row) => row.sessionId)).toEqual([successorId]);
  });

  it("P1-a (defence in depth): before the project's first manifest, the transferred bootstrap's CONFIRM is refused before any write (v56's pointer guard would refuse it after)", async () => {
    withoutBootstrapBlock();
    const h = harness();
    const f = genesisPlanFixture();
    const a = await adoptedBootstrap(h, f.manifest.projectId);
    expect(a.transfer().allowed).toBe(true);
    expect((await a.claimAs(a.newUuid, 2, { pid: process.pid, startedAt: readProcessStartToken(process.pid)! })).allowed).toBe(true);
    const doctor = h.cp.doctor.run.bind(h.cp.doctor);
    vi.spyOn(h.cp.doctor, "run").mockImplementation(async (...args) => ({ ...await doctor(...args), status: "HEALTHY", findings: [] }));
    const ceoSessionId = bindCeo(h);
    const reviewed = await reviewBootstrapPlan(h, a.runId, { ...f.artifact.content, githubOperations: undefined, requestDigest: h.cp.runs.require(a.runId).contractDigest });
    const confirmed = await decideThroughHermes(h, { runId: a.runId, candidateSnapshotDigest: reviewed.snapshotDigest, ceoSessionId, rationale: "create and connect" });
    expect(confirmed).toMatchObject({ allowed: false, evidence: { refusal: "ADOPTION_TRANSFERRED_BEFORE_ACTIVATION" } });
    expect(h.port.writes).toEqual([]);
    expect(h.cp.db.all(`SELECT 1 FROM bootstrap_applications`)).toEqual([]);
    expect(h.cp.projects.require(a.projectId).activeManifestDigest).toBeNull();
  });
});
