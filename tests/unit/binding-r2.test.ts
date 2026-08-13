import { afterAll, describe, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import type { HandoffPackage } from "../../src/cto/cto-lifecycle.ts";
import { cleanupTempDirs, makeCore, makeRepo, seedRun } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const COMPLETE_HANDOFF: HandoffPackage = {
  projectStatus: "ACTIVE/HEALTHY",
  activeManifestDigest: null,
  recentDecisions: [],
  openBlockers: [],
  queuedWork: [],
  repositoryFacts: [],
  knownRisks: [],
  recommendedNextAction: "continue",
};

const readySession = (core: ReturnType<typeof makeCore>, sessionId: string) => {
  const session = core.sessions.create({ provider: "scripted", model: "test", sessionId });
  expect(core.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").allowed).toBe(true);
  return session;
};

const insertProject = (core: ReturnType<typeof makeCore>, projectId: string) => {
  core.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [
    projectId,
    projectId,
    core.clock.nowIso(),
  ]);
};

describe("#45 — producer history survives a Primary CTO takeover", () => {
  it("refuses the former Primary CTO as a blind reviewer after takeover", () => {
    const core = makeCore();
    const projectId = "prj_history";
    const runId = "run_history";
    insertProject(core, projectId);
    const former = readySession(core, "ses_former");
    const successor = readySession(core, "ses_successor");
    const initial = core.bindings.bind({
      role: Role.PRIMARY_CTO,
      sessionId: former.sessionId,
      projectId,
    });
    expect(initial.allowed).toBe(true);
    if (!initial.allowed) return;

    const now = core.clock.nowIso();
    core.db.run(
      `INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal,
                         contract_digest, owner_session_id, owner_binding_generation,
                         owner_session_incarnation, owner_role_key, created_at, dispatched_at)
       VALUES (?, ?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'ACTIVE', 'history', 'sha256:history',
               ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        projectId,
        initial.value.sessionId,
        initial.value.bindingGeneration,
        initial.value.sessionIncarnation,
        initial.value.roleKey,
        now,
        now,
      ],
    );

    const takeover = core.bindings.switchTo({
      role: Role.PRIMARY_CTO,
      sessionId: successor.sessionId,
      projectId,
      reason: "emergency replacement",
      takeover: true,
    });
    expect(takeover.allowed).toBe(true);

    const refused = core.bindings.bind({
      role: Role.BLIND_REVIEWER,
      sessionId: former.sessionId,
      runId,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.REVIEWER_SESSION_IS_PRODUCER);
  });

  it("refuses reviewer admission when a dispatched owner history is not reconstructible", () => {
    const core = makeCore();
    const repo = makeRepo();
    const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: repo });
    const refused = core.bindings.assertReviewerIndependence(seeded.runId, "ses_candidate");
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.PRODUCER_HISTORY_UNAVAILABLE);
  });
});

describe("#46 — takeover respects the full owner binding tuple", () => {
  it("does not repoint a same-generation run owned through another role key", () => {
    const core = makeCore();
    const projectId = "prj_tuple";
    const runId = "run_tuple";
    insertProject(core, projectId);
    const outgoing = readySession(core, "ses_outgoing");
    const incoming = readySession(core, "ses_incoming");
    const cto = core.bindings.bind({
      role: Role.PRIMARY_CTO,
      sessionId: outgoing.sessionId,
      projectId,
    });
    expect(cto.allowed).toBe(true);
    if (!cto.allowed) return;
    expect(
      core.bindings.bind({ role: Role.CEO, sessionId: outgoing.sessionId }).allowed,
    ).toBe(true);

    const now = core.clock.nowIso();
    core.db.run(
      `INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal,
                         contract_digest, owner_session_id, owner_binding_generation,
                         owner_session_incarnation, owner_role_key, created_at, dispatched_at)
       VALUES (?, ?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'ACTIVE', 'tuple', 'sha256:tuple',
               ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        projectId,
        cto.value.sessionId,
        cto.value.bindingGeneration,
        cto.value.sessionIncarnation,
        cto.value.roleKey,
        now,
        now,
      ],
    );

    const switched = core.bindings.switchTo({
      role: Role.CEO,
      sessionId: incoming.sessionId,
      reason: "unrelated CEO failover",
      takeover: true,
    });
    expect(switched.allowed).toBe(true);
    expect(
      core.db.get<{ owner_session_id: string; owner_role_key: string }>(
        `SELECT owner_session_id, owner_role_key FROM runs WHERE run_id = ?`,
        [runId],
      ),
    ).toEqual({ owner_session_id: outgoing.sessionId, owner_role_key: cto.value.roleKey });
  });
});

describe("#47 — revocation cannot orphan a live run", () => {
  it("refuses revocation of the exact binding that owns a nonterminal run", () => {
    const core = makeCore();
    const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: makeRepo() });
    const refused = core.bindings.revoke(seeded.roleKey, "operator request");
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.REVOCATION_BLOCKED_ACTIVE_RUNS);
    expect(core.bindings.active(seeded.roleKey)?.bindingGeneration).toBe(seeded.generation);
  });
});

describe("#50 / #172 — only READY sessions can become active bindings", () => {
  it("#50 refuses allowStarting during a direct binding", () => {
    const core = makeCore();
    const starting = core.sessions.create({ provider: "scripted", model: "test", sessionId: "ses_starting" });
    const refused = core.bindings.bind({
      role: Role.CEO,
      sessionId: starting.sessionId,
      allowStarting: true,
    } as unknown as Parameters<typeof core.bindings.bind>[0]);
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.SESSION_NOT_READY);
  });

  it("#172 refuses allowStarting during a takeover and preserves the incumbent", () => {
    const core = makeCore();
    const incumbent = readySession(core, "ses_incumbent");
    const initial = core.bindings.bind({ role: Role.CEO, sessionId: incumbent.sessionId });
    expect(initial.allowed).toBe(true);
    const starting = core.sessions.create({ provider: "scripted", model: "test", sessionId: "ses_starting" });

    const refused = core.bindings.switchTo({
      role: Role.CEO,
      sessionId: starting.sessionId,
      reason: "forged readiness",
      takeover: true,
      allowStarting: true,
    } as unknown as Parameters<typeof core.bindings.switchTo>[0]);
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.SESSION_NOT_READY);
    expect(core.bindings.active(roleKeyFor(Role.CEO))?.sessionId).toBe(incumbent.sessionId);
  });
});

describe("binding fencing mechanisms", () => {
  it("issues an opaque session secret when secret storage is available", () => {
    const core = makeCore();
    const session = core.sessions.create({ provider: "scripted", model: "test", sessionId: "ses_no_secret_store" });
    expect(session.sessionSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const refused = core.sessions.verifySecret(session.sessionId, "forged");
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.SESSION_SECRET_INVALID);
  });

  it("#378 wires real session-secret authentication and delivery for a normal handoff", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const incumbent = await harness.cp.cto.ensurePrimaryCto(projectId, "handoff setup");
    expect(incumbent.allowed).toBe(true);

    const create = harness.cp.sessions.create.bind(harness.cp.sessions);
    let incomingSecret: string | null = null;
    const captureIncoming = vi.spyOn(harness.cp.sessions, "create").mockImplementation((input) => {
      const incoming = create(input);
      incomingSecret = incoming.sessionSecret;
      return incoming;
    });
    const prepared = await harness.cp.cto.prepareSwitchover(projectId, COMPLETE_HANDOFF);
    captureIncoming.mockRestore();
    expect(prepared.allowed).toBe(true);
    if (!prepared.allowed || !incomingSecret) return;

    const envelope = harness.cp.outbox.byIdempotencyKey(`handoff:${prepared.value.handoffId}`);
    expect(envelope).not.toBeNull();
    const delivery = harness.cp.outbox.claimDeliverable();
    expect(delivery).toHaveLength(1);
    expect(harness.cp.outbox.markSent(envelope!.messageId, delivery[0]!.claimToken).allowed).toBe(true);

    const acknowledgement = (sessionSecret: string) => ({
      sessionId: prepared.value.incomingSessionId,
      sessionIncarnation: harness.cp.sessions.require(prepared.value.incomingSessionId).incarnation,
      bindingGeneration: envelope!.bindingGeneration,
      messageId: envelope!.messageId,
      payloadDigest: envelope!.payloadDigest,
      sessionSecret,
    });
    const forged = harness.cp.cto.acknowledgeHandoff(
      prepared.value.handoffId,
      acknowledgement("forged-secret"),
    );
    expect(forged.allowed).toBe(false);
    expect(forged.reasonCode).toBe(ReasonCode.HANDOFF_ACK_AUTHENTICATION_FAILED);

    const acknowledged = harness.cp.cto.acknowledgeHandoff(
      prepared.value.handoffId,
      acknowledgement(incomingSecret),
    );
    expect(acknowledged.allowed).toBe(true);
    expect(harness.cp.bindings.activePrimaryCto(projectId)?.sessionId).toBe(prepared.value.incomingSessionId);
  });

  it("refuses a switch whose expected current generation is stale", () => {
    const core = makeCore();
    const incumbent = readySession(core, "ses_generation_one");
    const incoming = readySession(core, "ses_generation_two");
    expect(core.bindings.bind({ role: Role.CEO, sessionId: incumbent.sessionId }).allowed).toBe(true);

    const refused = core.bindings.switchTo({
      role: Role.CEO,
      sessionId: incoming.sessionId,
      reason: "stale plan",
      expectedCurrentGeneration: 0,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.BINDING_GENERATION_STALE);
    expect(core.bindings.active(roleKeyFor(Role.CEO))?.sessionId).toBe(incumbent.sessionId);
  });

  it("authenticates the session secret and current binding generation in one call", () => {
    const core = makeCore();
    const incumbent = readySession(core, "ses_secret_one");
    expect(incumbent.sessionSecret).not.toBeNull();
    expect(
      core.db.get<{ session_secret_hash: string }>(
        `SELECT session_secret_hash FROM sessions WHERE session_id = ?`,
        [incumbent.sessionId],
      )?.session_secret_hash,
    ).not.toBe(incumbent.sessionSecret);
    const binding = core.bindings.bind({ role: Role.CEO, sessionId: incumbent.sessionId });
    expect(binding.allowed).toBe(true);
    if (!binding.allowed || !incumbent.sessionSecret) return;

    const invalidSecret = core.bindings.authenticateBoundSession({
      roleKey: binding.value.roleKey,
      sessionId: incumbent.sessionId,
      sessionSecret: "forged",
      bindingGeneration: binding.value.bindingGeneration,
    });
    expect(invalidSecret.allowed).toBe(false);
    expect(invalidSecret.reasonCode).toBe(ReasonCode.SESSION_SECRET_INVALID);
    expect(
      core.bindings.authenticateBoundSession({
        roleKey: binding.value.roleKey,
        sessionId: incumbent.sessionId,
        sessionSecret: incumbent.sessionSecret,
        bindingGeneration: binding.value.bindingGeneration,
      }).allowed,
    ).toBe(true);

    const successor = readySession(core, "ses_secret_two");
    expect(
      core.bindings.switchTo({
        role: Role.CEO,
        sessionId: successor.sessionId,
        reason: "normal replacement",
      }).allowed,
    ).toBe(true);
    const stale = core.bindings.authenticateBoundSession({
      roleKey: binding.value.roleKey,
      sessionId: incumbent.sessionId,
      sessionSecret: incumbent.sessionSecret,
      bindingGeneration: binding.value.bindingGeneration,
    });
    expect(stale.allowed).toBe(false);
    expect(stale.reasonCode).toBe(ReasonCode.BINDING_GENERATION_STALE);
  });
});
