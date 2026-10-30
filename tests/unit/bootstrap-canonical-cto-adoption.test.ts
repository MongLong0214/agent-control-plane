import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";

import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { manifestDigest } from "../../src/contracts/manifest.ts";
import { CanonicalSelfClaim, hostSessionRegistryAbsent } from "../../src/registry/canonical-self-claim.ts";
import { CanonicalSessionRegistry } from "../../src/registry/canonical-session-registry.ts";
import { residentRepositories } from "../../src/registry/resident-repositories.ts";
import { ArtifactKind, Role, RunKind, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import type { HostObservation, HostOperation, HostProjectProvisioner } from "../../src/runtime/host-project-provisioner.ts";
import type { ACPBootstrapActivationResult } from "../../src/bootstrap/activation.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { callCtoTool } from "../helpers/cto-tool.ts";
import { GenesisGitHub, genesisPlanFixture } from "../helpers/genesis-github.ts";
import { reviewBootstrapPlan } from "../helpers/bootstrap-plan.ts";
import { CONTRACT_CHANGE_CONTRACT } from "../helpers/contract-change.ts";
import { bindCeo, bootstrapCtoProvider, decideThroughHermes, dispatchBootstrapRun, makeHarness, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * The explicit canonical-CTO adoption of a PROJECT_BOOTSTRAP run, through the real run engine, Repo
 * Factory runner, activation and CEO door: an existing conversation that already holds the PRIMARY_CTO
 * of a registered, manifest-less project owns the bootstrap and keeps the project, and nothing creates
 * a BOOTSTRAP_CTO, a resident, a session or a Buzz identity for it.
 */

const contract = { goal: "bootstrap", why: "adoption witness", scope: [], nonGoals: [], acceptance: ["developable"], priority: "NORMAL" as const, humanGate: [], references: [] };

/** A host that records every call; the adoption path must never reach it. */
class RecordingHost implements HostProjectProvisioner {
  readonly calls: HostOperation[] = [];
  async invoke(operation: HostOperation): Promise<HostObservation> {
    this.calls.push(operation);
    throw new Error("an adopting bootstrap reached the resident host provisioner");
  }
}

interface AdoptedCto {
  projectId: string;
  sessionUuid: string;
  buzzActorId: string;
  roomId: string;
  sessionId: string;
  assignmentId: string;
}

/**
 * A manifest-less, operator-registered project, its canonical entry in the daemon's entitlement table
 * (as agentcpd mirrors the configured canonical sessions at startup), and the existing
 * conversation's authenticated canonical self-claim of its PRIMARY_CTO at generation 1. `pid` is a real
 * process, so the adoption's liveness reading is the production one.
 */
const adoptExistingConversation = async (
  h: Harness,
  input: { projectId: string; pid: number; callerPid: number; buzzActorId: string },
): Promise<AdoptedCto> => {
  const { projectId, pid, callerPid, buzzActorId } = input;
  const sessionUuid = randomUUID();
  const roomId = randomUUID();
  const cwd = realpathSync(tempDir("adopted-cto-cwd-"));
  if (!h.cp.projects.get(projectId)) {
    const registered = h.cp.projects.register({ projectId, name: projectId });
    if (!registered.allowed) throw new Error(registered.message);
  }
  new CanonicalSessionRegistry(h.cp.db).grant({ sessionUuid, projectId, buzzActorId, buzzAddress: roomId }, null);
  const startedAt = readProcessStartToken(pid)!;
  const claim = new CanonicalSelfClaim(
    h.cp.db, h.clock, h.cp.audit, h.cp.sessions, h.cp.bindings,
    { isAllowedActor: () => true },
    async () => ({ allowed: true, reasonCode: "OK", evidence: {}, value: roomId }),
    { canonicalSessions: [{ sessionUuid, projectId, buzzActorId, buzzAddress: roomId }], canonicalBuzzChannelId: roomId, expectedPeerProtocolVersion: "test", expectedPeerIdentity: "test" },
    {
      processInspector: {
        snapshot: (asked) => asked === callerPid
          ? { pid: asked, ppid: pid, argv: ["node", "mcp"], command: "node mcp", cwd, cwdProbeFailure: null, startedAt: "peer" }
          : asked === pid
            ? { pid: asked, ppid: 1, argv: ["/test/claude", "--session-id", sessionUuid], command: "claude", cwd, cwdProbeFailure: null, startedAt }
            : null,
      },
      imageInspector: { resolve: () => null },
      transcriptReader: { locate: () => ({ path: "/test/transcript", sizeBytes: 10 }) },
      hostSessionRegistryReader: { read: () => hostSessionRegistryAbsent("test") },
      processSignal: () => {},
    },
  );
  const admitted = await claim.claim({
    callerPid, claimedSessionUuid: sessionUuid, projectId, expectedBindingGeneration: 1,
    peerProtocolVersion: "test", peerIdentity: "test", buzzPurpose: "test",
  });
  if (!admitted.allowed) throw new Error(`canonical claim refused: ${admitted.reasonCode} ${admitted.message}`);
  const binding = h.cp.bindings.active(roleKeyFor(Role.PRIMARY_CTO, { projectId }))!;
  return { projectId, sessionUuid, buzzActorId, roomId, sessionId: admitted.value.sessionId, assignmentId: binding.assignmentId };
};

/** Everything the adoption must leave exactly as it found it, read in one pass. */
const preserved = (h: Harness, adopted: AdoptedCto) => {
  const binding = h.cp.bindings.active(roleKeyFor(Role.PRIMARY_CTO, { projectId: adopted.projectId }));
  const session = h.cp.sessions.get(adopted.sessionId);
  return {
    binding: binding && { assignmentId: binding.assignmentId, sessionId: binding.sessionId, generation: binding.bindingGeneration, status: binding.status },
    session: session && { lifecycle: session.lifecycle, incarnation: session.incarnation, buzzActorId: session.buzzActorId, buzzAddress: session.buzzAddress, osPid: session.osPid },
    entitlements: h.cp.db.all(`SELECT * FROM canonical_session_entitlements ORDER BY session_uuid`),
    buzzIdentities: h.cp.db.all(`SELECT session_id, buzz_actor_id, buzz_address FROM sessions WHERE buzz_actor_id IS NOT NULL ORDER BY session_id`),
  };
};

const adoptionHarness = () => {
  const root = realpathSync(tempDir("bootstrap-adoption-"));
  const workRoot = join(root, "factory");
  mkdirSync(join(root, "home"));
  const port = new GenesisGitHub(root);
  const host = new RecordingHost();
  const h = makeHarness({ repoFactory: { workRoot, githubPort: port }, residentProvisioner: { home: join(root, "home"), port: host } });
  h.cp.residentProjects.attachSubscriber(async () => true);
  h.cp.bootstrapProducer.attachWriterLock(() => true);
  // The fixed Claude double a BOOTSTRAP_CTO would be spawned on: registered, so a spawn would succeed
  // and only the adoption keeps it from happening.
  bootstrapCtoProvider(h.cp, h.clock);
  return { h, port, host, workRoot };
};

const createAdopting = (h: Harness, adoption: { projectId: string; sessionId: string; bindingGeneration: number }) =>
  h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD", contract, adoptCanonicalCto: adoption });

/** A Hermes tool call as the CEO's door makes it, authenticated as the bound CEO session. */
let hermesKeys = 0;
const hermesTool = async (h: Harness, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const ceo = h.cp.bindings.active(roleKeyFor(Role.CEO))!;
  const server = createHermesServer(createHermesMcpPort(h.cp), () =>
    allow(ReasonCode.OK, { actor: ceo.sessionId, sessionId: ceo.sessionId, sessionIncarnation: ceo.sessionIncarnation }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "adoption-ceo-door", version: "1" });
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name, arguments: { idempotencyKey: `adoption-${++hermesKeys}`, ...args } });
    return (result.structuredContent ?? {}) as Record<string, unknown>;
  } finally {
    await client.close();
  }
};

const runCount = (h: Harness): number => h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM runs`)!.n;

describe("PROJECT_BOOTSTRAP adopting an existing canonical CTO", () => {
  it("completes on the existing conversation: no BOOTSTRAP_CTO, no resident, binding and Buzz route preserved, the new repository linked by its node id", async () => {
    const { h, port, host, workRoot } = adoptionHarness();
    const f = genesisPlanFixture();
    const projectId = f.manifest.projectId;
    const adopted = await adoptExistingConversation(h, { projectId, pid: process.pid, callerPid: 900_001, buzzActorId: "a".repeat(64) });
    const before = preserved(h, adopted);
    const spawn = vi.spyOn(h.cp.cto, "spawnBootstrapCto");
    const driven = vi.spyOn(h.cp.cto, "ensureDrivenPrimaryCto");
    const resident = vi.spyOn(h.cp.residentProjects, "ensure");
    const doctor = h.cp.doctor.run.bind(h.cp.doctor);
    vi.spyOn(h.cp.doctor, "run").mockImplementation(async (...args) => ({ ...await doctor(...args), status: "HEALTHY", findings: [] }));

    // The CEO's exact payloads: run_create with the adoption input, then run_dispatch.
    const ceoSessionId = bindCeo(h);
    const created = await hermesTool(h, "run_create", {
      kind: "PROJECT_BOOTSTRAP", executionMode: "STANDARD", contract,
      adoptCanonicalCto: { projectId, sessionId: adopted.sessionId, bindingGeneration: 1 },
    });
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true, value: { projectId: null, kind: "PROJECT_BOOTSTRAP" } });
    const runId = (created["value"] as { runId: string }).runId;
    // What ACP stored is its own reading: the request's three fields and the entitlement it found.
    expect(h.cp.audit.forRun(runId).find((row) => row.kind === "RUN_CREATED")?.evidence["adoptCanonicalCto"]).toEqual({
      projectId, sessionId: adopted.sessionId, bindingGeneration: 1, entitlementSessionUuid: adopted.sessionUuid, buzzActorId: adopted.buzzActorId,
    });
    const dispatched = await hermesTool(h, "run_dispatch", { runId });
    expect(dispatched, JSON.stringify(dispatched)).toMatchObject({ ok: true, value: {
      ownerRoleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId }), ownerSessionId: adopted.sessionId, ownerBindingGeneration: 1,
    } });
    expect(h.cp.bindings.history(roleKeyFor(Role.BOOTSTRAP_CTO, { runId }))).toEqual([]);

    const reviewed = await reviewBootstrapPlan(h, runId, { ...f.artifact.content, githubOperations: undefined, requestDigest: h.cp.runs.require(runId).contractDigest });
    const first = await decideThroughHermes(h, { runId, candidateSnapshotDigest: reviewed.snapshotDigest, ceoSessionId, rationale: "create and connect" });
    // The handoff to the adopted conversation is not acknowledged yet, so nothing completes.
    expect(first.allowed).toBe(false);
    expect(first.reasonCode).toBe("BOOTSTRAP_ACTIVATION_INCOMPLETE");
    expect(first.evidence["incomplete"]).toEqual(["handoffAck"]);
    // The first activation already connected the existing project: its first manifest and the repository.
    expect(h.cp.projects.require(projectId).activeManifestDigest).toBe(manifestDigest(f.manifest));
    expect(h.cp.audit.byKind("PROJECT_MANIFEST_ADOPTED_BY_BOOTSTRAP").map((row) => row.runId)).toEqual([runId]);
    expect(h.cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);

    const pending = h.cp.db.get<{ handoff_id: string; to_session_id: string }>(`SELECT handoff_id, to_session_id FROM handoffs WHERE project_id = ? AND status = 'PENDING'`, [projectId])!;
    expect(pending.to_session_id).toBe(adopted.sessionId);
    const session = h.cp.sessions.require(adopted.sessionId);
    const listed = await callCtoTool(h, { sessionId: session.sessionId, incarnation: session.incarnation }, "role_dispatch_pending");
    const received = (listed["value"] as { messages: Array<{ messageId: string; kind: string; payloadDigest: string; bindingGeneration: number; payload: { handoffId?: string } }> })
      .messages.find((message) => message.kind === "HANDOFF_PACKAGE" && message.payload.handoffId === pending.handoff_id)!;
    expect(received).toBeTruthy();
    const acked = await callCtoTool(h, { sessionId: session.sessionId, incarnation: session.incarnation }, "handoff_ack", {
      idempotencyKey: "adopted-bootstrap-ack", handoffId: pending.handoff_id, messageId: received.messageId,
      payloadDigest: received.payloadDigest, bindingGeneration: received.bindingGeneration,
    });
    expect(acked, JSON.stringify(acked)).toMatchObject({ ok: true });

    const confirmed = await decideThroughHermes(h, { runId, candidateSnapshotDigest: reviewed.snapshotDigest, ceoSessionId, rationale: "create and connect" });
    expect(confirmed.allowed, JSON.stringify(confirmed)).toBe(true);
    expect(h.cp.runs.require(runId).state).toBe(RunState.COMPLETED);

    // The project is the existing one, now on the approved manifest, with the new repository bound.
    const project = h.cp.projects.require(projectId);
    expect(project.activeManifestDigest).toBe(manifestDigest(f.manifest));
    expect(h.cp.projects.list().map((p) => p.projectId)).toEqual([projectId]);
    const repository = h.cp.repositories.byIdentity(f.outputs.target.repositoryIdentity)!;
    expect(repository.projectId).toBe(projectId);
    // The checkout: the control plane's own Repo Factory clone of this run, a separate git dir that is
    // never the adopted conversation's working directory, and no resident clone for #1227 to move.
    const produced = h.cp.artifacts.latest<{ repositories: Array<{ proposedCheckoutPath: string | null }> }>(runId, ArtifactKind.REPO_FACTORY_RESULT)!.content;
    expect(repository.checkoutPath).toBe(produced.repositories[0]!.proposedCheckoutPath);
    expect(repository.checkoutPath.startsWith(`${join(workRoot, runId)}${sep}`)).toBe(true);
    expect(residentRepositories(h.cp.db)).toEqual([]);
    const result = h.cp.artifacts.latest<ACPBootstrapActivationResult>(runId, ArtifactKind.BOOTSTRAP_ACTIVATION_RESULT)!.content;
    expect(result.primaryCtoBinding).toMatchObject({ sessionId: adopted.sessionId, bindingGeneration: 1, promotedFromBootstrap: false });
    expect(result.provisioning).toBeUndefined();
    const createReceipt = h.cp.artifacts.latest<{ repositories: Array<{ repositoryNodeId?: string }> }>(runId, ArtifactKind.REPO_FACTORY_RESULT)!.content;
    expect(result.canonicalCtoAdoption).toEqual({
      sessionId: adopted.sessionId, bindingGeneration: 1, conversationUuid: adopted.sessionUuid,
      buzzActorId: adopted.buzzActorId, buzzAddress: adopted.roomId,
      repositoryIdentity: f.outputs.target.repositoryIdentity, repositoryNodeId: createReceipt.repositories[0]!.repositoryNodeId!,
    });
    expect(result.canonicalCtoAdoption!.repositoryNodeId).toMatch(/\S/);
    expect(result.buzz).toEqual({ connected: true, address: adopted.roomId });

    // Nothing was spawned, launched or created for the CTO, and the binding and Buzz route are as they were.
    expect(spawn).not.toHaveBeenCalled();
    expect(driven).not.toHaveBeenCalled();
    expect(resident).not.toHaveBeenCalled();
    expect(host.calls).toEqual([]);
    expect(h.cp.residentProjects.row(runId)).toBeUndefined();
    expect(h.cp.audit.byKind("BOOTSTRAP_CTO_SESSION_SPAWNED")).toEqual([]);
    expect(h.cp.audit.byKind("PRIMARY_CTO_DRIVEN_SESSION_SPAWNED")).toEqual([]);
    expect(preserved(h, adopted)).toEqual(before);
    expect(port.writes.filter((write) => write.method === "createRepository")).toHaveLength(1);
  });

  it("refuses a wrong session, a stale generation and another project's canonical CTO, storing nothing", async () => {
    const { h } = adoptionHarness();
    const a = await adoptExistingConversation(h, { projectId: "project-a", pid: process.pid, callerPid: 900_002, buzzActorId: "b".repeat(64) });
    const b = await adoptExistingConversation(h, { projectId: "project-b", pid: process.ppid, callerPid: 900_003, buzzActorId: "c".repeat(64) });
    const stranger = h.cp.sessions.create({ provider: "scripted", model: "scripted-cto" });
    h.cp.sessions.transition(stranger.sessionId, SessionLifecycle.READY, "test");
    const beforeA = preserved(h, a);
    const beforeB = preserved(h, b);
    const runs = runCount(h);

    const wrongSession = createAdopting(h, { projectId: a.projectId, sessionId: stranger.sessionId, bindingGeneration: 1 });
    expect(wrongSession.allowed).toBe(false);
    expect(wrongSession.evidence["refusal"]).toBe("ADOPTION_SESSION_MISMATCH");

    const stale = createAdopting(h, { projectId: a.projectId, sessionId: a.sessionId, bindingGeneration: 2 });
    expect(stale.allowed).toBe(false);
    expect(stale.evidence["refusal"]).toBe("ADOPTION_GENERATION_STALE");

    const hijack = createAdopting(h, { projectId: b.projectId, sessionId: a.sessionId, bindingGeneration: 1 });
    expect(hijack.allowed).toBe(false);
    expect(hijack.evidence["refusal"]).toBe("ADOPTION_FOREIGN_PROJECT_CTO");

    const notBootstrap = h.cp.runs.create({ kind: RunKind.STANDARD_WORK, executionMode: "STANDARD", contract, adoptCanonicalCto: { projectId: a.projectId, sessionId: a.sessionId, bindingGeneration: 1 } });
    expect(notBootstrap.allowed).toBe(false);
    expect(notBootstrap.evidence["refusal"]).toBe("ADOPTION_REQUIRES_BOOTSTRAP");

    // The entitlement fields are ACP's to record; a requester that sends them is refused, not believed.
    const injected = h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD", contract,
      adoptCanonicalCto: { projectId: a.projectId, sessionId: a.sessionId, bindingGeneration: 1, entitlementSessionUuid: a.sessionUuid, buzzActorId: a.buzzActorId } as never });
    expect(injected.allowed).toBe(false);
    expect(injected.evidence["refusal"]).toBe("ADOPTION_INPUT_INVALID");
    const flag = h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD", contract, adoptCanonicalCto: true as never });
    expect(flag.allowed).toBe(false);
    expect(flag.evidence["refusal"]).toBe("ADOPTION_INPUT_INVALID");

    expect(runCount(h)).toBe(runs);
    expect(preserved(h, a)).toEqual(beforeA);
    expect(preserved(h, b)).toEqual(beforeB);
  });

  it("refuses, before anything is reserved or written, a PLAN whose manifest names another project than the adopted CTO's", async () => {
    const { h, port } = adoptionHarness();
    const f = genesisPlanFixture();
    const adopted = await adoptExistingConversation(h, { projectId: "project-x", pid: process.pid, callerPid: 900_006, buzzActorId: "f".repeat(64) });
    const created = createAdopting(h, { projectId: adopted.projectId, sessionId: adopted.sessionId, bindingGeneration: 1 });
    if (!created.allowed) throw new Error(created.message);
    const runId = created.value.runId;
    await h.cp.runs.dispatch(runId);
    const ceoSessionId = bindCeo(h);
    expect(f.manifest.projectId).not.toBe(adopted.projectId);
    const reviewed = await reviewBootstrapPlan(h, runId, { ...f.artifact.content, githubOperations: undefined, requestDigest: h.cp.runs.require(runId).contractDigest });
    const before = preserved(h, adopted);
    const refused = await decideThroughHermes(h, { runId, candidateSnapshotDigest: reviewed.snapshotDigest, ceoSessionId, rationale: "create" });
    expect(refused.allowed).toBe(false);
    expect(refused.evidence["refusal"]).toBe("ADOPTION_PROJECT_NOT_TARGET");
    expect(h.cp.bootstrapApplications.get(runId)).toBeNull();
    expect(port.writes).toEqual([]);
    expect(h.cp.projects.get(f.manifest.projectId)).toBeNull();
    expect(preserved(h, adopted)).toEqual(before);
  });

  it("a target that stops holding at dispatch is refused with no BOOTSTRAP_CTO staffed in its place", async () => {
    const { h } = adoptionHarness();
    const adopted = await adoptExistingConversation(h, { projectId: "project-c", pid: process.pid, callerPid: 900_004, buzzActorId: "d".repeat(64) });
    const spawn = vi.spyOn(h.cp.cto, "spawnBootstrapCto");
    const created = createAdopting(h, { projectId: adopted.projectId, sessionId: adopted.sessionId, bindingGeneration: 1 });
    expect(created.allowed).toBe(true);
    if (!created.allowed) return;
    h.cp.sessions.transition(adopted.sessionId, SessionLifecycle.DRAINING, "test: the canonical CTO is draining");
    const refused = await h.cp.runs.dispatch(created.value.runId);
    expect(refused.allowed).toBe(false);
    expect(refused.evidence["refusal"]).toBe("ADOPTION_SESSION_NOT_READY");
    expect(spawn).not.toHaveBeenCalled();
    expect(h.cp.bindings.history(roleKeyFor(Role.BOOTSTRAP_CTO, { runId: created.value.runId }))).toEqual([]);
    expect(h.cp.runs.require(created.value.runId)).toMatchObject({ state: RunState.QUEUED, ownerSessionId: null });
    expect(h.cp.bindings.active(roleKeyFor(Role.PRIMARY_CTO, { projectId: adopted.projectId }))?.assignmentId).toBe(adopted.assignmentId);
  });

  it("a CONFIRM whose adopted CTO no longer holds writes nothing and leaves the binding untouched; the same CONFIRM proceeds on that CTO once it holds again", async () => {
    const { h, port, host } = adoptionHarness();
    const f = genesisPlanFixture();
    const projectId = f.manifest.projectId;
    const adopted = await adoptExistingConversation(h, { projectId, pid: process.pid, callerPid: 900_005, buzzActorId: "e".repeat(64) });
    const doctor = h.cp.doctor.run.bind(h.cp.doctor);
    vi.spyOn(h.cp.doctor, "run").mockImplementation(async (...args) => ({ ...await doctor(...args), status: "HEALTHY", findings: [] }));
    const created = createAdopting(h, { projectId, sessionId: adopted.sessionId, bindingGeneration: 1 });
    if (!created.allowed) throw new Error(created.message);
    const runId = created.value.runId;
    await h.cp.runs.dispatch(runId);
    const ceoSessionId = bindCeo(h);
    const reviewed = await reviewBootstrapPlan(h, runId, { ...f.artifact.content, githubOperations: undefined, requestDigest: h.cp.runs.require(runId).contractDigest });
    const before = preserved(h, adopted);

    // The canonical CTO's project is suspended between review and CONFIRM: the adoption no longer holds.
    expect(h.cp.projects.setSuspended(projectId, true, true).allowed).toBe(true);
    const refused = await decideThroughHermes(h, { runId, candidateSnapshotDigest: reviewed.snapshotDigest, ceoSessionId, rationale: "create and connect" });
    expect(refused.allowed).toBe(false);
    expect(refused.evidence["refusal"]).toBe("ADOPTION_PROJECT_SUSPENDED");
    // Nothing half-adopted: no reservation, no GitHub write, no manifest, no repository, no handoff.
    expect(h.cp.bootstrapApplications.get(runId)).toBeNull();
    expect(port.writes).toEqual([]);
    expect(h.cp.projects.require(projectId).activeManifestDigest).toBeNull();
    expect(h.cp.repositories.byIdentity(f.outputs.target.repositoryIdentity)).toBeNull();
    expect(h.cp.db.get(`SELECT 1 FROM handoffs WHERE project_id = ?`, [projectId])).toBeUndefined();
    expect(h.cp.artifacts.latest(runId, ArtifactKind.BOOTSTRAP_ACTIVATION_RESULT)).toBeNull();
    expect(preserved(h, adopted)).toEqual(before);
    expect(h.cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);

    // Restored, the same CONFIRM proceeds on the same adopted CTO.
    expect(h.cp.projects.setSuspended(projectId, false, true).allowed).toBe(true);
    const resumed = await decideThroughHermes(h, { runId, candidateSnapshotDigest: reviewed.snapshotDigest, ceoSessionId, rationale: "create and connect" });
    expect(resumed.allowed).toBe(false);
    expect(resumed.evidence["incomplete"]).toEqual(["handoffAck"]);
    expect(h.cp.db.get<{ to_session_id: string }>(`SELECT to_session_id FROM handoffs WHERE project_id = ? AND status = 'PENDING'`, [projectId])?.to_session_id).toBe(adopted.sessionId);
    expect(host.calls).toEqual([]);
    expect(h.cp.bindings.active(roleKeyFor(Role.PRIMARY_CTO, { projectId }))?.assignmentId).toBe(adopted.assignmentId);
  });

  it("refuses the adoption while a first-activation CONTRACT_CHANGE run of the project is open, at creation and at dispatch, and admits it once that run has ended", async () => {
    const { h } = adoptionHarness();
    const adopted = await adoptExistingConversation(h, { projectId: "project-fa", pid: process.pid, callerPid: 900_007, buzzActorId: "1".repeat(64) });
    const asked = { projectId: adopted.projectId, sessionId: adopted.sessionId, bindingGeneration: 1 };
    // Created before the first activation exists, refused at its next door.
    const early = createAdopting(h, asked);
    if (!early.allowed) throw new Error(early.message);
    const firstActivation = h.cp.runs.create({ projectId: adopted.projectId, kind: RunKind.CONTRACT_CHANGE, executionMode: "STANDARD", contract: CONTRACT_CHANGE_CONTRACT, repositories: [] });
    if (!firstActivation.allowed) throw new Error(firstActivation.message);
    const spawn = vi.spyOn(h.cp.cto, "spawnBootstrapCto");
    const dispatched = await h.cp.runs.dispatch(early.value.runId);
    expect(dispatched.allowed).toBe(false);
    expect(dispatched.evidence["refusal"]).toBe("ADOPTION_FIRST_ACTIVATION_OPEN");
    expect(spawn).not.toHaveBeenCalled();
    expect(h.cp.runs.require(early.value.runId)).toMatchObject({ state: RunState.QUEUED, ownerSessionId: null });
    // Created while it is open, refused and nothing stored.
    const runs = runCount(h);
    const refused = createAdopting(h, asked);
    expect(refused.allowed).toBe(false);
    expect(refused.evidence["refusal"]).toBe("ADOPTION_FIRST_ACTIVATION_OPEN");
    expect(runCount(h)).toBe(runs);
    // Ended, the same adoption is admitted.
    expect(h.cp.runs.cancel(firstActivation.value.runId, "adoption witness").allowed).toBe(true);
    expect(createAdopting(h, asked).allowed).toBe(true);
    const redispatched = await h.cp.runs.dispatch(early.value.runId);
    expect(redispatched.allowed, JSON.stringify(redispatched)).toBe(true);
    expect(h.cp.runs.require(early.value.runId)).toMatchObject({ ownerRoleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId: adopted.projectId }), ownerSessionId: adopted.sessionId });
  });

  it("PROJECT_EXISTS still refuses a bootstrap created without the adoption; the adopting one for the same project passes that door", async () => {
    const { h, port } = adoptionHarness();
    const f = genesisPlanFixture();
    const projectId = f.manifest.projectId;
    const adopted = await adoptExistingConversation(h, { projectId, pid: process.pid, callerPid: 900_008, buzzActorId: "2".repeat(64) });
    const doctor = h.cp.doctor.run.bind(h.cp.doctor);
    vi.spyOn(h.cp.doctor, "run").mockImplementation(async (...args) => ({ ...await doctor(...args), status: "HEALTHY", findings: [] }));
    const ceoSessionId = bindCeo(h);

    const plain = h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD", contract });
    if (!plain.allowed) throw new Error(plain.message);
    await dispatchBootstrapRun(h.cp, h.clock, plain.value.runId);
    const plainReview = await reviewBootstrapPlan(h, plain.value.runId, { ...f.artifact.content, githubOperations: undefined, requestDigest: h.cp.runs.require(plain.value.runId).contractDigest });
    const refused = await decideThroughHermes(h, { runId: plain.value.runId, candidateSnapshotDigest: plainReview.snapshotDigest, ceoSessionId, rationale: "create" });
    expect(refused.allowed).toBe(false);
    expect(refused.evidence["refusal"]).toBe("PROJECT_EXISTS");
    expect(h.cp.bootstrapApplications.get(plain.value.runId)).toBeNull();
    expect(port.writes).toEqual([]);
    expect(h.cp.projects.require(projectId).activeManifestDigest).toBeNull();
    expect(h.cp.runs.cancel(plain.value.runId, "adoption witness").allowed).toBe(true);

    const adopting = createAdopting(h, { projectId, sessionId: adopted.sessionId, bindingGeneration: 1 });
    if (!adopting.allowed) throw new Error(adopting.message);
    await h.cp.runs.dispatch(adopting.value.runId);
    const review = await reviewBootstrapPlan(h, adopting.value.runId, { ...f.artifact.content, githubOperations: undefined, requestDigest: h.cp.runs.require(adopting.value.runId).contractDigest });
    const passed = await decideThroughHermes(h, { runId: adopting.value.runId, candidateSnapshotDigest: review.snapshotDigest, ceoSessionId, rationale: "create and connect" });
    expect(passed.allowed).toBe(false);
    expect(passed.evidence["incomplete"]).toEqual(["handoffAck"]);
    expect(h.cp.projects.require(projectId).activeManifestDigest).toBe(manifestDigest(f.manifest));
  });

  it("a bootstrap created without the input still staffs its own BOOTSTRAP_CTO, exactly as before", async () => {
    const { h } = adoptionHarness();
    const created = h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD", contract });
    if (!created.allowed) throw new Error(created.message);
    const dispatched = await dispatchBootstrapRun(h.cp, h.clock, created.value.runId);
    expect(dispatched.ownerRoleKey).toBe(roleKeyFor(Role.BOOTSTRAP_CTO, { runId: created.value.runId }));
    expect(h.cp.audit.byKind("BOOTSTRAP_CTO_SESSION_SPAWNED")).toHaveLength(1);
    expect(h.cp.audit.forRun(created.value.runId).find((row) => row.kind === "RUN_CREATED")?.evidence).not.toHaveProperty("adoptCanonicalCto");
  });
});
