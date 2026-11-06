import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { ACPBootstrapActivationResult } from "../../src/bootstrap/activation.ts";
import { recordedBootstrapAdoption } from "../../src/bootstrap/bootstrap-adoption-input.ts";
import { sha256 } from "../../src/core/digest.ts";
import { manifestDigest } from "../../src/contracts/manifest.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ArtifactKind, Role, RunKind, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { CanonicalSelfClaim, hostSessionRegistryAbsent } from "../../src/registry/canonical-self-claim.ts";
import { CanonicalSessionRegistry } from "../../src/registry/canonical-session-registry.ts";
import type { HostObservation, HostOperation, HostProjectProvisioner } from "../../src/runtime/host-project-provisioner.ts";
import { reviewBootstrapPlan } from "../helpers/bootstrap-plan.ts";
import { callCtoTool } from "../helpers/cto-tool.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { GenesisGitHub, genesisPlanFixture } from "../helpers/genesis-github.ts";
import { bindCeo, bootstrapCtoProvider, decideThroughHermes, makeHarness, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/** Stand-in CTO processes, each live until its restart kills it. */
const stragglers: ChildProcess[] = [];
afterEach(() => {
  for (const child of stragglers.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

/**
 * #1302 L5 (CEO option 2). A canonical CTO that adopted a PROJECT_BOOTSTRAP run and is then restarted on
 * the same conversation has the run's owner pin moved to its new generation by the official takeover
 * (CANONICAL_LIVE_RUNS_TAKEN_OVER). The adoption follows that pin only along a proven chain: the same
 * project, run and conversation, from the generation RUN_CREATED recorded, one same-conversation restart
 * per generation, to the role's ACTIVE binding. Everything is real (SQLite, the control plane, the
 * self-claim and its dead-predecessor recovery, the run engine, the Repo Factory runner, activation and
 * the CEO door); only the claim's process table, image, transcript and Buzz room are fixtures.
 */

const contract = { goal: "bootstrap", why: "adoption takeover witness", scope: [], nonGoals: [], acceptance: ["developable"], priority: "NORMAL" as const, humanGate: [], references: [] };

class RecordingHost implements HostProjectProvisioner {
  readonly calls: HostOperation[] = [];
  async invoke(operation: HostOperation): Promise<HostObservation> {
    this.calls.push(operation);
    throw new Error("an adopting bootstrap reached the resident host provisioner");
  }
}

const harness = () => {
  const root = realpathSync(tempDir("bootstrap-adoption-takeover-"));
  mkdirSync(join(root, "home"));
  const port = new GenesisGitHub(root);
  const h = makeHarness({ repoFactory: { workRoot: join(root, "factory"), githubPort: port }, residentProvisioner: { home: join(root, "home"), port: new RecordingHost() } });
  h.cp.residentProjects.attachSubscriber(async () => true);
  h.cp.bootstrapProducer.attachWriterLock(() => true);
  bootstrapCtoProvider(h.cp, h.clock);
  return Object.assign(h, { port });
};

/** A real process the adoption's liveness reading finds running, until the restart kills it. */
const standIn = async (): Promise<{ pid: number; startedAt: string; kill: () => Promise<void> }> => {
  const child = spawn("/bin/sleep", ["600"], { stdio: "ignore" });
  stragglers.push(child);
  await once(child, "spawn");
  const startedAt = readProcessStartToken(child.pid!);
  if (startedAt === null) throw new Error("the stand-in process has no readable start token");
  return { pid: child.pid!, startedAt, kill: async () => { child.kill("SIGKILL"); await once(child, "exit"); } };
};

/**
 * One canonical conversation of a manifest-less, registered project, and its self-claims. Each claim
 * runs as `claude` on the given process; every pid outside that claim's own chain reads as gone, so a
 * restart's predecessor is DEAD to the claim's recovery.
 */
const canonicalConversation = (h: Harness, projectId: string, buzzActorId: string) => {
  const sessionUuid = randomUUID();
  const roomId = randomUUID();
  const cwd = realpathSync(tempDir("adopted-cto-cwd-"));
  if (!h.cp.projects.get(projectId)) {
    const registered = h.cp.projects.register({ projectId, name: projectId });
    if (!registered.allowed) throw new Error(registered.message);
  }
  new CanonicalSessionRegistry(h.cp.db).grant({ sessionUuid, projectId, buzzActorId, buzzAddress: roomId }, null);
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
  let callers = 0;
  const claimAs = async (generation: number, claude: { pid: number; startedAt: string }) => {
    const callerPid = 910_000 + 100 * generation + ++callers;
    const claim = new CanonicalSelfClaim(
      h.cp.db, h.clock, h.cp.audit, h.cp.sessions, h.cp.bindings,
      { isAllowedActor: () => true },
      async () => ({ allowed: true, reasonCode: "OK", evidence: {}, value: roomId }),
      { canonicalSessions: [{ sessionUuid, projectId, buzzActorId, buzzAddress: roomId }], canonicalBuzzChannelId: roomId, expectedPeerProtocolVersion: "test", expectedPeerIdentity: "test" },
      {
        processInspector: {
          snapshot: (asked) => asked === callerPid
            ? { pid: asked, ppid: claude.pid, argv: ["node", "mcp"], command: "node mcp", cwd, cwdProbeFailure: null, startedAt: "peer" }
            : asked === claude.pid
              ? { pid: asked, ppid: 1, argv: ["/test/claude", "--resume", sessionUuid], command: "claude", cwd, cwdProbeFailure: null, startedAt: claude.startedAt }
              : null,
        },
        imageInspector: { resolve: () => null },
        transcriptReader: { locate: () => ({ path: "/test/transcript", sizeBytes: 10 }) },
        hostSessionRegistryReader: { read: () => hostSessionRegistryAbsent("test") },
        processSignal: (pid) => {
          if (pid === claude.pid || pid === callerPid) return;
          throw Object.assign(new Error(`no such process: ${pid}`), { code: "ESRCH" });
        },
      },
    );
    const admitted = await claim.claim({
      callerPid, claimedSessionUuid: sessionUuid, projectId, expectedBindingGeneration: generation,
      peerProtocolVersion: "test", peerIdentity: "test", buzzPurpose: "test",
    });
    if (!admitted.allowed) throw new Error(`canonical claim at generation ${generation} refused: ${admitted.reasonCode} ${admitted.message}`);
    return admitted.value.sessionId;
  };
  return { projectId, sessionUuid, buzzActorId, roomId, roleKey, claimAs };
};

/** This test process as the restarted CTO: the one the adoption's real liveness reading finds running. */
const thisProcess = () => ({ pid: process.pid, startedAt: readProcessStartToken(process.pid)! });

/**
 * The adopted conversation on a stand-in process, a bootstrap that adopts it at generation 1, dispatched
 * so its owner pin is that binding.
 */
const adoptedAndDispatched = async (h: Harness, projectId: string, buzzActorId: string) => {
  const conversation = canonicalConversation(h, projectId, buzzActorId);
  const first = await standIn();
  const sessionId = await conversation.claimAs(1, first);
  const created = h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD", contract, adoptCanonicalCto: { projectId, sessionId, bindingGeneration: 1 } });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const dispatched = await h.cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  expect(dispatched.value).toMatchObject({ ownerRoleKey: conversation.roleKey, ownerSessionId: sessionId, ownerBindingGeneration: 1 });
  return { ...conversation, runId, sessionId, first };
};

/** The run's owner pin, its recorded adoption and the binding the role holds now. */
const pinOf = (h: Harness, runId: string) => {
  const run = h.cp.runs.require(runId);
  return { sessionId: run.ownerSessionId, bindingGeneration: run.ownerBindingGeneration, incarnation: run.ownerSessionIncarnation };
};

/** Moves the role and the run's pin to a new generation by hand, with no takeover: what no ACP path does. */
const movePinByHand = (h: Harness, runId: string, roleKey: string, projectId: string, sessionId: string): number => {
  const held = h.cp.bindings.active(roleKey)!;
  h.cp.db.run(`UPDATE assignments SET status = 'REVOKED', revoked_at = ?, revoked_reason = 'test' WHERE assignment_id = ?`, [h.clock.nowIso(), held.assignmentId]);
  const moved = h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId });
  if (!moved.allowed) throw new Error(moved.message);
  h.cp.db.run(`UPDATE runs SET owner_session_id = ?, owner_binding_generation = ?, owner_session_incarnation = ? WHERE run_id = ?`,
    [moved.value.boundSessionId, moved.value.bindingGeneration, moved.value.boundSessionIncarnation, runId]);
  return moved.value.bindingGeneration;
};

/** A CANONICAL_LIVE_RUNS_TAKEN_OVER row written by hand, shaped exactly as the self-claim writes one. */
const forgeTakeoverRow = (h: Harness, row: { runId: string; projectId: string; roleKey: string; toSessionId: string; evidence: Record<string, unknown> }) => {
  h.cp.db.run(
    `INSERT INTO audit_events (at, kind, reason_code, run_id, project_id, session_id, role_key, actor, evidence_json)
     VALUES (?, 'CANONICAL_LIVE_RUNS_TAKEN_OVER', 'OK', ?, ?, ?, ?, 'test', ?)`,
    [h.clock.nowIso(), row.runId, row.projectId, row.toSessionId, row.roleKey, JSON.stringify(row.evidence)],
  );
};

/** An adopted, dispatched bootstrap whose canonical CTO died and was resumed once on the same conversation. */
const restartedOnce = async (h: Harness, projectId: string, buzzActorId: string) => {
  const adopted = await adoptedAndDispatched(h, projectId, buzzActorId);
  const recorded = recordedBootstrapAdoption(h.cp.db, adopted.runId)!;
  expect(recorded).toMatchObject({ sessionId: adopted.sessionId, bindingGeneration: 1 });
  await adopted.first.kill();
  const successorId = await adopted.claimAs(2, thisProcess());
  const successor = h.cp.sessions.require(successorId);
  // The takeover moved the pin, and recorded the move on the run.
  expect(pinOf(h, adopted.runId)).toEqual({ sessionId: successorId, bindingGeneration: 2, incarnation: successor.incarnation });
  expect(h.cp.audit.byKind("CANONICAL_LIVE_RUNS_TAKEN_OVER").map((row) => [row.runId, row.sessionId])).toEqual([[adopted.runId, successorId]]);
  return { adopted, recorded, successorId };
};

describe("an adopted bootstrap follows its canonical CTO through the official takeover (#1302 L5)", () => {
  it("W1a — after a same-conversation restart the pin the takeover moved is the adoption's, at every door the validator answers", async () => {
    const h = harness();
    const { adopted, recorded, successorId } = await restartedOnce(h, "project-restarted", "9".repeat(64));

    // Every door the validator answers now names the restarted CTO at generation 2.
    const adoptions = h.cp.bootstrapAdoptions;
    const current = adoptions.recorded(adopted.runId);
    expect(current).toEqual({ ...recorded, sessionId: successorId, bindingGeneration: 2 });
    const run = h.cp.runs.require(adopted.runId);
    for (const asked of [recorded, current!]) {
      const pinned = adoptions.pinHolds(run, asked);
      expect(pinned.allowed, JSON.stringify(pinned)).toBe(true);
      if (pinned.allowed) expect(pinned.value).toMatchObject({ boundSessionId: successorId, bindingGeneration: 2 });
    }
    const validated = adoptions.validate(current!);
    expect(validated.allowed, JSON.stringify(validated)).toBe(true);
    if (validated.allowed) expect(validated.value.binding).toMatchObject({ sessionId: successorId, bindingGeneration: 2 });
  });

  it("W1 — after a same-conversation restart the bootstrap's next step, the CEO CONFIRM, connects the project on the restarted CTO", async () => {
    const h = harness();
    const f = genesisPlanFixture();
    const { adopted, successorId } = await restartedOnce(h, f.manifest.projectId, "a".repeat(64));
    const doctor = h.cp.doctor.run.bind(h.cp.doctor);
    vi.spyOn(h.cp.doctor, "run").mockImplementation(async (...args) => ({ ...await doctor(...args), status: "HEALTHY", findings: [] }));
    const ceoSessionId = bindCeo(h);
    const reviewed = await reviewBootstrapPlan(h, adopted.runId, { ...f.artifact.content, githubOperations: undefined, requestDigest: h.cp.runs.require(adopted.runId).contractDigest });
    const confirmed = await decideThroughHermes(h, { runId: adopted.runId, candidateSnapshotDigest: reviewed.snapshotDigest, ceoSessionId, rationale: "create and connect" });
    expect(confirmed.allowed).toBe(false);
    expect(confirmed.evidence["incomplete"], JSON.stringify(confirmed)).toEqual(["handoffAck"]);
    expect(h.cp.projects.require(adopted.projectId).activeManifestDigest).toBe(manifestDigest(f.manifest));
    expect(h.cp.runs.require(adopted.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);

    // The restarted CTO acknowledges the handoff, and the same CONFIRM completes the bootstrap on it.
    const pending = h.cp.db.get<{ handoff_id: string; to_session_id: string }>(`SELECT handoff_id, to_session_id FROM handoffs WHERE project_id = ? AND status = 'PENDING'`, [adopted.projectId])!;
    expect(pending.to_session_id).toBe(successorId);
    const session = h.cp.sessions.require(successorId);
    const owner = { sessionId: session.sessionId, incarnation: session.incarnation };
    const listed = await callCtoTool(h, owner, "role_dispatch_pending");
    const received = (listed["value"] as { messages: Array<{ messageId: string; kind: string; payloadDigest: string; bindingGeneration: number; payload: { handoffId?: string } }> })
      .messages.find((message) => message.kind === "HANDOFF_PACKAGE" && message.payload.handoffId === pending.handoff_id)!;
    const acked = await callCtoTool(h, owner, "handoff_ack", {
      idempotencyKey: "restarted-bootstrap-ack", handoffId: pending.handoff_id, messageId: received.messageId,
      payloadDigest: received.payloadDigest, bindingGeneration: received.bindingGeneration,
    });
    expect(acked, JSON.stringify(acked)).toMatchObject({ ok: true });
    const completed = await decideThroughHermes(h, { runId: adopted.runId, candidateSnapshotDigest: reviewed.snapshotDigest, ceoSessionId, rationale: "create and connect" });
    expect(completed.allowed, JSON.stringify(completed)).toBe(true);
    expect(h.cp.runs.require(adopted.runId).state).toBe(RunState.COMPLETED);
    const result = h.cp.artifacts.latest<ACPBootstrapActivationResult>(adopted.runId, ArtifactKind.BOOTSTRAP_ACTIVATION_RESULT)!.content;
    expect(result.primaryCtoBinding).toMatchObject({ sessionId: successorId, bindingGeneration: 2, promotedFromBootstrap: false });
    expect(result.canonicalCtoAdoption).toMatchObject({ sessionId: successorId, bindingGeneration: 2, conversationUuid: adopted.sessionUuid });
    expect(h.port.writes.filter((write) => write.method === "createRepository")).toHaveLength(1);
  });

  it("W1s — after a restart the restarted CTO stages the adopted bootstrap's PLAN; its dead predecessor cannot", async () => {
    const h = harness();
    const f = genesisPlanFixture();
    const { adopted, successorId } = await restartedOnce(h, f.manifest.projectId, "7".repeat(64));
    bindCeo(h);
    const run = h.cp.runs.require(adopted.runId);
    const plan = { ...f.artifact.content, requestDigest: run.contractDigest };
    const planBody = JSON.stringify({ runId: adopted.runId, plan, tasks: [{ key: "create", title: "Create repository", category: "implementation" }] });
    const args = {
      idempotencyKey: `stage-${adopted.runId}`, runId: adopted.runId, planBody, expectedSha256: sha256(planBody), contractDigest: run.contractDigest!,
      bootstrapOperationId: f.artifact.content.bootstrapOperationId as string, projectId: f.manifest.projectId,
      repositoryIdentity: f.manifest.repositories[0]!.remote,
    };
    const as = (sessionId: string) => ({ sessionId, incarnation: h.cp.sessions.require(sessionId).incarnation });
    expect(await callCtoTool(h, as(adopted.sessionId), "bootstrap_plan_stage", { ...args, idempotencyKey: "stale-stage" })).toMatchObject({ ok: false });
    const staged = await callCtoTool(h, as(successorId), "bootstrap_plan_stage", args);
    expect(staged, JSON.stringify(staged)).toMatchObject({ ok: true, value: { digest: args.expectedSha256, stagedBy: adopted.roleKey } });
    expect(h.cp.audit.forRun(adopted.runId).filter((row) => row.kind === "BOOTSTRAP_PLAN_STAGED").map((row) => row.sessionId)).toEqual([successorId]);
  });

  it("W1r — after a restart a revised adopted bootstrap is dispatched again on the restarted CTO", async () => {
    const h = harness();
    const f = genesisPlanFixture();
    const { adopted, successorId } = await restartedOnce(h, f.manifest.projectId, "8".repeat(64));
    const ceoSessionId = bindCeo(h);
    const reviewed = await reviewBootstrapPlan(h, adopted.runId, { ...f.artifact.content, githubOperations: undefined, requestDigest: h.cp.runs.require(adopted.runId).contractDigest });
    const revised = h.cp.ceo.submitCeoDecision({ runId: adopted.runId, decision: "FINAL_REVISE", candidateSnapshotDigest: reviewed.snapshotDigest, ceoSessionId, rationale: "revise it" });
    expect(revised, JSON.stringify(revised)).toMatchObject({ allowed: true, value: { state: RunState.REVISION_REQUIRED } });
    const redispatched = await h.cp.runs.dispatch(adopted.runId);
    expect(redispatched.allowed, JSON.stringify(redispatched)).toBe(true);
    expect(h.cp.runs.require(adopted.runId)).toMatchObject({ state: RunState.ACTIVE, ownerSessionId: successorId, ownerBindingGeneration: 2 });
    expect(h.cp.bindings.history(roleKeyFor(Role.BOOTSTRAP_CTO, { runId: adopted.runId }))).toEqual([]);
  });

  /** A restarted adopted bootstrap at its CEO review, and what a refused CONFIRM of it must leave unwritten. */
  const atConfirm = async (buzzActorId: string) => {
    const h = harness();
    const f = genesisPlanFixture();
    const doctor = h.cp.doctor.run.bind(h.cp.doctor);
    vi.spyOn(h.cp.doctor, "run").mockImplementation(async (...args) => ({ ...await doctor(...args), status: "HEALTHY", findings: [] }));
    const { adopted, successorId } = await restartedOnce(h, f.manifest.projectId, buzzActorId);
    const ceoSessionId = bindCeo(h);
    const reviewed = await reviewBootstrapPlan(h, adopted.runId, { ...f.artifact.content, githubOperations: undefined, requestDigest: h.cp.runs.require(adopted.runId).contractDigest });
    const confirm = () => decideThroughHermes(h, { runId: adopted.runId, candidateSnapshotDigest: reviewed.snapshotDigest, ceoSessionId, rationale: "create and connect" });
    const nothingWritten = () => {
      expect(h.port.writes).toEqual([]);
      expect(h.cp.projects.require(adopted.projectId).activeManifestDigest).toBeNull();
      expect(h.cp.repositories.byIdentity(f.outputs.target.repositoryIdentity)).toBeNull();
      expect(h.cp.bootstrapApplications.get(adopted.runId)?.phase ?? null).not.toBe("WRITTEN");
    };
    return { h, adopted, successorId, confirm, nothingWritten };
  };

  it("W5a — a CONFIRM whose adopted CTO stops holding after its precondition, before the first write, writes nothing to GitHub", async () => {
    const { h, successorId, confirm, nothingWritten } = await atConfirm("6".repeat(64));
    const observe = h.port.observeRepository.bind(h.port);
    const spy = vi.spyOn(h.port, "observeRepository").mockImplementationOnce(async (...args) => {
      h.cp.sessions.transition(successorId, SessionLifecycle.DRAINING, "test: the restarted CTO drains mid-CONFIRM");
      return observe(...args);
    });
    const refused = await confirm();
    expect(spy).toHaveBeenCalled();
    expect(refused.allowed).toBe(false);
    expect(refused.evidence["refusal"], JSON.stringify(refused)).toBe("ADOPTION_SESSION_NOT_READY");
    nothingWritten();
  });

  it("W5b — a CONFIRM whose pin was moved past the proven chain is refused before anything is written", async () => {
    const { h, adopted, successorId, confirm, nothingWritten } = await atConfirm("5".repeat(64));
    expect(movePinByHand(h, adopted.runId, adopted.roleKey, adopted.projectId, successorId)).toBe(3);
    const refused = await confirm();
    expect(refused.allowed).toBe(false);
    expect(refused.evidence, JSON.stringify(refused)).toMatchObject({ refusal: "ADOPTION_OWNER_NOT_PINNED", takeover: "ADOPTION_TAKEOVER_MISSING", fromGeneration: 2 });
    nothingWritten();
  });

  /** An adopted, dispatched bootstrap whose first CONFIRM connected the project and waits for its handoff ACK. */
  const handoffPending = async (buzzActorId: string) => {
    const h = harness();
    const f = genesisPlanFixture();
    const doctor = h.cp.doctor.run.bind(h.cp.doctor);
    vi.spyOn(h.cp.doctor, "run").mockImplementation(async (...args) => ({ ...await doctor(...args), status: "HEALTHY", findings: [] }));
    const adopted = await adoptedAndDispatched(h, f.manifest.projectId, buzzActorId);
    const ceoSessionId = bindCeo(h);
    const reviewed = await reviewBootstrapPlan(h, adopted.runId, { ...f.artifact.content, githubOperations: undefined, requestDigest: h.cp.runs.require(adopted.runId).contractDigest });
    const confirm = () => decideThroughHermes(h, { runId: adopted.runId, candidateSnapshotDigest: reviewed.snapshotDigest, ceoSessionId, rationale: "create and connect" });
    const first = await confirm();
    expect(first.evidence["incomplete"], JSON.stringify(first)).toEqual(["handoffAck"]);
    const handoffs = () => h.cp.db.all<{ handoff_id: string; to_session_id: string; status: string }>(
      `SELECT handoff_id, to_session_id, status FROM handoffs WHERE project_id = ? AND kind = 'BOOTSTRAP' ORDER BY created_at, handoff_id`, [adopted.projectId]);
    expect(handoffs().map((row) => [row.to_session_id, row.status])).toEqual([[adopted.sessionId, "PENDING"]]);
    const original = handoffs()[0]!.handoff_id;
    /** `handoff_ack` of `handoffId`'s package, as `sessionId` on its recorded incarnation. */
    const ackAs = (sessionId: string, handoffId: string, key: string) => {
      const message = h.cp.db.get<{ message_id: string; payload_digest: string; binding_generation: number }>(
        `SELECT message_id, payload_digest, binding_generation FROM outbox WHERE idempotency_key = ?`, [`bootstrap-handoff:${handoffId}`])!;
      return callCtoTool(h, { sessionId, incarnation: h.cp.sessions.require(sessionId).incarnation }, "handoff_ack", {
        idempotencyKey: key, handoffId, messageId: message.message_id, payloadDigest: message.payload_digest, bindingGeneration: message.binding_generation,
      });
    };
    return { h, f, adopted, confirm, handoffs, original, ackAs };
  };

  it("W6 — a restart while the activation handoff waits for its ACK reissues it to the restarted CTO; the dead predecessor's ACK counts for nothing", async () => {
    const { h, f, adopted, confirm, handoffs, original, ackAs } = await handoffPending("4".repeat(64));
    await adopted.first.kill();
    const successorId = await adopted.claimAs(2, thisProcess());
    expect(pinOf(h, adopted.runId)).toMatchObject({ sessionId: successorId, bindingGeneration: 2 });

    // The next CONFIRM reissues the pending handoff to the restarted CTO, the earlier one kept as it is.
    const second = await confirm();
    expect(second.allowed).toBe(false);
    expect(second.evidence["incomplete"], JSON.stringify(second)).toEqual(["handoffAck"]);
    const rows = handoffs();
    expect(rows.map((row) => [row.to_session_id, row.status])).toEqual(expect.arrayContaining([[adopted.sessionId, "PENDING"], [successorId, "PENDING"]]));
    expect(rows).toHaveLength(2);
    const reissued = rows.find((row) => row.to_session_id === successorId)!.handoff_id;
    expect(h.cp.audit.byKind("HANDOFF_SUBMITTED").at(-1)).toMatchObject({ sessionId: successorId, evidence: { handoffId: reissued, reissuedFrom: original } });

    // The dead predecessor cannot acknowledge its package, and nothing it could do completes the run.
    expect(await ackAs(adopted.sessionId, original, "predecessor-ack")).toMatchObject({ ok: false, reasonCode: "HANDOFF_ACK_REQUIRED" });
    expect(handoffs().find((row) => row.handoff_id === original)?.status).toBe("PENDING");
    expect((await confirm()).evidence["incomplete"]).toEqual(["handoffAck"]);

    // The restarted CTO acknowledges the reissued package, and the same CONFIRM completes on it.
    expect(await ackAs(successorId, reissued, "successor-ack"), "successor ack").toMatchObject({ ok: true });
    const completed = await confirm();
    expect(completed.allowed, JSON.stringify(completed)).toBe(true);
    expect(h.cp.runs.require(adopted.runId).state).toBe(RunState.COMPLETED);
    const result = h.cp.artifacts.latest<ACPBootstrapActivationResult>(adopted.runId, ArtifactKind.BOOTSTRAP_ACTIVATION_RESULT)!.content;
    expect(result.primaryCtoBinding).toMatchObject({ sessionId: successorId, bindingGeneration: 2 });
    expect(result.handoffAck).toMatchObject({ handoffId: reissued });
    expect(h.port.writes.filter((write) => write.method === "createRepository")).toHaveLength(1);
    expect(h.cp.projects.require(adopted.projectId).activeManifestDigest).toBe(manifestDigest(f.manifest));
  });

  it("W6c — a restart after the predecessor ACKed but before the completing CONFIRM reissues the handoff, and only the successor's ACK completes", async () => {
    const { h, adopted, confirm, handoffs, original, ackAs } = await handoffPending("2".repeat(64));
    expect(await ackAs(adopted.sessionId, original, "acked-before-restart")).toMatchObject({ ok: true });
    await adopted.first.kill();
    const successorId = await adopted.claimAs(2, thisProcess());
    const second = await confirm();
    expect(second.evidence["incomplete"], JSON.stringify(second)).toEqual(["handoffAck"]);
    const reissued = handoffs().find((row) => row.to_session_id === successorId);
    expect(reissued?.status).toBe("PENDING");
    expect(handoffs().find((row) => row.handoff_id === original)?.status).toBe("ACKED");
    expect(await ackAs(successorId, reissued!.handoff_id, "successor-ack-after")).toMatchObject({ ok: true });
    const completed = await confirm();
    expect(completed.allowed, JSON.stringify(completed)).toBe(true);
    expect(h.cp.artifacts.latest<ACPBootstrapActivationResult>(adopted.runId, ArtifactKind.BOOTSTRAP_ACTIVATION_RESULT)!.content.handoffAck)
      .toMatchObject({ handoffId: reissued!.handoff_id });
  });

  it("W6b — with the handoff pending, a pin moved to an unproven successor reissues nothing and refuses the CONFIRM", async () => {
    const { h, adopted, confirm, handoffs, original, ackAs } = await handoffPending("3".repeat(64));
    const stranger = h.cp.sessions.create({ provider: "scripted", model: "scripted-cto" });
    h.cp.sessions.transition(stranger.sessionId, SessionLifecycle.READY, "test");
    expect(movePinByHand(h, adopted.runId, adopted.roleKey, adopted.projectId, stranger.sessionId)).toBe(2);
    const refused = await confirm();
    expect(refused.allowed).toBe(false);
    expect(refused.evidence, JSON.stringify(refused)).toMatchObject({ refusal: "ADOPTION_OWNER_NOT_PINNED", takeover: "ADOPTION_TAKEOVER_MISSING" });
    expect(handoffs().map((row) => [row.handoff_id, row.to_session_id, row.status])).toEqual([[original, adopted.sessionId, "PENDING"]]);
    expect(await ackAs(stranger.sessionId, original, "stranger-ack")).toMatchObject({ ok: false });
    expect(h.cp.runs.require(adopted.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
  });

  it("W1b — the chain holds through two restarts, one takeover per generation", async () => {
    const h = harness();
    const adopted = await adoptedAndDispatched(h, "project-two-restarts", "b".repeat(64));
    const recorded = recordedBootstrapAdoption(h.cp.db, adopted.runId)!;
    await adopted.first.kill();
    const second = await standIn();
    const middleId = await adopted.claimAs(2, second);
    await second.kill();
    const lastId = await adopted.claimAs(3, thisProcess());
    expect(pinOf(h, adopted.runId)).toMatchObject({ sessionId: lastId, bindingGeneration: 3 });
    expect(h.cp.audit.byKind("CANONICAL_LIVE_RUNS_TAKEN_OVER").map((row) => row.sessionId)).toEqual([middleId, lastId]);

    const adoptions = h.cp.bootstrapAdoptions;
    const current = adoptions.recorded(adopted.runId);
    expect(current).toEqual({ ...recorded, sessionId: lastId, bindingGeneration: 3 });
    const pinned = adoptions.pinHolds(h.cp.runs.require(adopted.runId), recorded);
    expect(pinned.allowed, JSON.stringify(pinned)).toBe(true);
    const validated = adoptions.validate(current!);
    expect(validated.allowed, JSON.stringify(validated)).toBe(true);
  });

  it("W2 — a pin moved to a binding of another conversation is refused, though a takeover row names the move", async () => {
    const h = harness();
    const adopted = await adoptedAndDispatched(h, "project-moved-away", "c".repeat(64));
    const recorded = recordedBootstrapAdoption(h.cp.db, adopted.runId)!;
    const actorOf = (generation: number) => h.cp.db.get<{ actor_id: string }>(
      `SELECT actor_id FROM assignments WHERE role_key = ? AND binding_generation = ?`, [adopted.roleKey, generation])!.actor_id;
    const adoptedActor = actorOf(1);
    // The audit trail of a restart, written by hand: the predecessor recovered DEAD, and the run taken over.
    const released = h.cp.bindings.active(adopted.roleKey)!.assignmentId;
    const recovery = Number(h.cp.db.run(
      `INSERT INTO audit_events (at, kind, reason_code, run_id, project_id, session_id, role_key, actor, evidence_json)
       VALUES (?, 'DEAD_BINDING_RECOVERED', 'OK', NULL, ?, ?, ?, 'test', ?)`,
      [h.clock.nowIso(), adopted.projectId, adopted.sessionId, adopted.roleKey, JSON.stringify({ assignmentId: released, liveness: "DEAD", releasedGeneration: 1 })],
    ).lastInsertRowid);
    // Another runtime, not the adopted conversation, is bound to the role and the pin is moved onto it.
    const stranger = h.cp.sessions.create({ provider: "scripted", model: "scripted-cto" });
    h.cp.sessions.transition(stranger.sessionId, SessionLifecycle.READY, "test");
    const moved = movePinByHand(h, adopted.runId, adopted.roleKey, adopted.projectId, stranger.sessionId);
    expect(moved).toBe(2);
    expect(actorOf(2)).not.toBe(adoptedActor);
    forgeTakeoverRow(h, {
      runId: adopted.runId, projectId: adopted.projectId, roleKey: adopted.roleKey, toSessionId: stranger.sessionId,
      evidence: {
        fromGeneration: 1, toGeneration: 2, fromSession: adopted.sessionId, toSessionId: stranger.sessionId,
        actorId: adoptedActor, recoveryAuditEventId: recovery, sessionIncarnation: h.cp.sessions.require(adopted.sessionId).incarnation,
      },
    });

    const adoptions = h.cp.bootstrapAdoptions;
    expect(adoptions.recorded(adopted.runId)).toEqual(recorded);
    const pinned = adoptions.pinHolds(h.cp.runs.require(adopted.runId), recorded);
    expect(pinned).toMatchObject({ allowed: false, reasonCode: "RUN_OWNER_NOT_PINNED", evidence: { refusal: "ADOPTION_OWNER_NOT_PINNED", takeover: "ADOPTION_TAKEOVER_NOT_PROVEN" } });
    expect(adoptions.validate(recorded)).toMatchObject({ allowed: false, evidence: { refusal: "ADOPTION_SESSION_MISMATCH" } });
  });

  it("W3 — a pin moved by hand, with no takeover, is refused (the stale generation of the adoption record)", async () => {
    const h = harness();
    const adopted = await adoptedAndDispatched(h, "project-moved-by-hand", "d".repeat(64));
    const recorded = recordedBootstrapAdoption(h.cp.db, adopted.runId)!;
    expect(movePinByHand(h, adopted.runId, adopted.roleKey, adopted.projectId, adopted.sessionId)).toBe(2);

    const adoptions = h.cp.bootstrapAdoptions;
    expect(adoptions.recorded(adopted.runId)).toEqual(recorded);
    expect(adoptions.pinHolds(h.cp.runs.require(adopted.runId), recorded))
      .toMatchObject({ allowed: false, evidence: { refusal: "ADOPTION_OWNER_NOT_PINNED", takeover: "ADOPTION_TAKEOVER_MISSING" } });
    expect(adoptions.validate(recorded)).toMatchObject({ allowed: false, evidence: { refusal: "ADOPTION_GENERATION_STALE" } });
  });

  it("W4 — a generation past the takeover chain is refused, by hand or on a takeover row alone", async () => {
    const h = harness();
    const adopted = await adoptedAndDispatched(h, "project-skipped", "e".repeat(64));
    const recorded = recordedBootstrapAdoption(h.cp.db, adopted.runId)!;
    await adopted.first.kill();
    const successorId = await adopted.claimAs(2, thisProcess());
    const successor = h.cp.sessions.require(successorId);
    const adoptions = h.cp.bootstrapAdoptions;
    expect(adoptions.recorded(adopted.runId)).toMatchObject({ sessionId: successorId, bindingGeneration: 2 });

    // Generation 3 is reached by hand from the proven generation 2: no takeover links 2 to 3.
    expect(movePinByHand(h, adopted.runId, adopted.roleKey, adopted.projectId, successorId)).toBe(3);
    expect(adoptions.recorded(adopted.runId)).toEqual(recorded);
    expect(adoptions.pinHolds(h.cp.runs.require(adopted.runId), recorded))
      .toMatchObject({ allowed: false, evidence: { refusal: "ADOPTION_OWNER_NOT_PINNED", takeover: "ADOPTION_TAKEOVER_MISSING", fromGeneration: 2 } });

    // A takeover row for 2 → 3, shaped as the self-claim writes one, is not the succession it records.
    forgeTakeoverRow(h, {
      runId: adopted.runId, projectId: adopted.projectId, roleKey: adopted.roleKey, toSessionId: successorId,
      evidence: {
        fromGeneration: 2, toGeneration: 3, fromSession: successorId, toSessionId: successorId,
        actorId: h.cp.db.get<{ actor_id: string }>(`SELECT actor_id FROM assignments WHERE role_key = ? AND binding_generation = 2`, [adopted.roleKey])!.actor_id,
        recoveryAuditEventId: h.cp.audit.byKind("DEAD_BINDING_RECOVERED").at(-1)!.eventId, sessionIncarnation: successor.incarnation,
      },
    });
    expect(adoptions.recorded(adopted.runId)).toEqual(recorded);
    expect(adoptions.pinHolds(h.cp.runs.require(adopted.runId), recorded))
      .toMatchObject({ allowed: false, evidence: { refusal: "ADOPTION_OWNER_NOT_PINNED", takeover: "ADOPTION_TAKEOVER_NOT_PROVEN", fromGeneration: 2 } });

    // A row that jumps the generation (1 → 3) does not link the chain either.
    const jump = harness();
    const skipped = await adoptedAndDispatched(jump, "project-jumped", "f".repeat(64));
    const skippedRecord = recordedBootstrapAdoption(jump.cp.db, skipped.runId)!;
    const moved = movePinByHand(jump, skipped.runId, skipped.roleKey, skipped.projectId, skipped.sessionId);
    expect(movePinByHand(jump, skipped.runId, skipped.roleKey, skipped.projectId, skipped.sessionId)).toBe(moved + 1);
    forgeTakeoverRow(jump, {
      runId: skipped.runId, projectId: skipped.projectId, roleKey: skipped.roleKey, toSessionId: skipped.sessionId,
      evidence: { fromGeneration: 1, toGeneration: 3, fromSession: skipped.sessionId, toSessionId: skipped.sessionId, actorId: "x", recoveryAuditEventId: 1, sessionIncarnation: "x" },
    });
    expect(jump.cp.bootstrapAdoptions.pinHolds(jump.cp.runs.require(skipped.runId), skippedRecord))
      .toMatchObject({ allowed: false, evidence: { refusal: "ADOPTION_OWNER_NOT_PINNED", takeover: "ADOPTION_TAKEOVER_NOT_PROVEN", fromGeneration: 1 } });
  });
});
