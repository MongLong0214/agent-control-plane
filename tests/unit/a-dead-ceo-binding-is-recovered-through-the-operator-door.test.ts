import { spawnSync } from "node:child_process";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { createHermesIncumbentAdoption } from "../../src/bootstrap/hermes-incumbent-adoption.ts";
import { dispatch } from "../../src/cli/agentctl.ts";
import type { Decision } from "../../src/core/errors.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  Daemon,
  OPERATOR_METHOD,
  type AuthenticatedOperatorPeer,
  type BlockingFinding,
  type ReconcileReport,
} from "../../src/daemon/daemon.ts";
import { DEAD_BINDING_RECOVERY_ROLES } from "../../src/daemon/dead-binding-recovery.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness, TEST_OWNER, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * The defect measured on the isolated instance: the Hermes CEO died together with the daemon, its
 * binding stayed ACTIVE, and every later start refused for good on SESSION_PROCESS_MISSING. The
 * door that releases a provably dead binding existed only for the canonical PRIMARY_CTO, and the
 * start that refused never opened it. These cases pin the CEO through that same door and proof.
 */

const OWNER_PEER: AuthenticatedOperatorPeer = {
  channel: "cli",
  peerId: `cli:${TEST_OWNER.actor}`,
  actor: TEST_OWNER.actor,
  incarnation: "operator-incarnation-1",
};

/** A reaped child's pid: `kill(pid, 0)` answers ESRCH for it, which is the DEAD the door requires. */
const deadPid = (): number => {
  const finished = spawnSync("/usr/bin/true", [], { stdio: "ignore", timeout: 30_000 });
  const pid = finished.pid;
  if (finished.signal !== null || typeof pid !== "number" || pid <= 0) {
    throw new Error("could not obtain a reaped child pid");
  }
  expect(() => process.kill(pid, 0)).toThrow();
  return pid;
};

interface CeoFixture {
  harness: Harness;
  sessionId: string;
  sessionIncarnation: string;
  assignmentId: string;
  bindingGeneration: number;
  actorId: string;
}

/**
 * An ACTIVE CEO binding on a Hermes session, the shape `bindings.bind` writes for the CEO. The
 * default session's process is gone and the session is still READY, so the start's own reconcile
 * is what discovers it — the production sequence.
 */
const ceoBinding = (
  options: { osPid?: number | null; osStartedAt?: string; lifecycle?: "SWEEP" | "ERROR" } = {},
): CeoFixture => {
  const harness = makeHarness();
  // Otherwise the start refuses on TRUSTED_GATE_CREDENTIAL_MISSING, which is not the case here.
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  const session = harness.cp.sessions.create({
    provider: "hermes",
    model: "hermes-runtime",
    osPid: options.osPid === undefined ? deadPid() : options.osPid,
    ...(options.osStartedAt === undefined ? {} : { osStartedAt: options.osStartedAt }),
  });
  const ready = harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test ceo");
  if (!ready.allowed) throw new Error(`session readiness failed: ${ready.message}`);
  const bound = harness.cp.bindings.bind({ role: Role.CEO, roleKey: roleKeyFor(Role.CEO), sessionId: session.sessionId });
  if (!bound.allowed) throw new Error(`CEO binding failed: ${bound.message}`);
  if (options.lifecycle === "ERROR") {
    const errored = harness.cp.sessions.transition(session.sessionId, SessionLifecycle.ERROR, "test: lost");
    if (!errored.allowed) throw new Error(`session error transition failed: ${errored.message}`);
  }
  const actor = harness.cp.db.get<{ actor_id: string }>(
    `SELECT actor_id FROM assignments WHERE assignment_id = ?`,
    [bound.value.assignmentId],
  );
  if (!actor) throw new Error("the CEO binding has no actor");
  return {
    harness,
    sessionId: session.sessionId,
    sessionIncarnation: bound.value.boundSessionIncarnation,
    assignmentId: bound.value.assignmentId,
    bindingGeneration: bound.value.bindingGeneration,
    actorId: actor.actor_id,
  };
};

/** The request `agentctl binding recover-dead-ceo` sends, with every field overridable. */
const ceoRecovery = (fixture: CeoFixture, overrides: Record<string, unknown> = {}) => ({
  requestId: "req-recover-dead-ceo",
  method: OPERATOR_METHOD.BINDING_RECOVER_DEAD,
  params: {
    projectId: null,
    role: Role.CEO,
    sessionId: fixture.sessionId,
    sessionIncarnation: fixture.sessionIncarnation,
    expectedBindingGeneration: fixture.bindingGeneration,
    ...overrides,
  },
});

/** Everything a refusal must leave as it was: bindings, sessions, actors, outbox and the audit. */
const stateOf = (harness: Harness) => ({
  assignments: harness.cp.db.all<Record<string, unknown>>(
    `SELECT assignment_id, role_key, actor_id, session_id, session_incarnation, binding_generation,
            status, revoked_at, revoked_reason
       FROM assignments ORDER BY assignment_id`,
  ),
  sessions: harness.cp.db.all<Record<string, unknown>>(
    `SELECT session_id, incarnation, lifecycle, os_pid, os_process_started_at FROM sessions ORDER BY session_id`,
  ),
  actors: harness.cp.db.all<Record<string, unknown>>(
    `SELECT actor_id, kind, current_session_id, current_session_incarnation, retired_at
       FROM conversational_actors ORDER BY actor_id`,
  ),
  outbox: harness.cp.db.all<Record<string, unknown>>(
    `SELECT message_id, status, reason_code FROM outbox ORDER BY message_id`,
  ),
  audit: harness.cp.db.all<Record<string, unknown>>(`SELECT event_id, kind FROM audit_events ORDER BY event_id`),
});

const outcomeOf = (started: Decision<ReconcileReport>) => {
  const report = started.allowed
    ? started.value
    : ((started.evidence as { reconcile?: ReconcileReport }).reconcile ?? null);
  return {
    allowed: started.allowed,
    reasonCode: started.reasonCode,
    blockingFindings: (report?.blockingFindings ?? []) as BlockingFinding[],
  };
};

const modeOf = async (daemon: Daemon): Promise<string> => {
  const status = await daemon.handleOperatorRequest(
    { requestId: "req-status", method: OPERATOR_METHOD.DAEMON_STATUS, params: {} },
    OWNER_PEER,
  );
  if (!status.allowed) throw new Error(`daemon.status refused: ${status.message}`);
  return (status.value as { mode: string }).mode;
};

/**
 * Starts the daemon over the fixture's state through the existing start harness and requires it
 * to reach a state whose operator socket answers: a park is reported as one at once rather than
 * as a test timeout, and a refusal is reported with the findings it refused on.
 */
const startedToTheDoor = async (harness: Harness, prefix: string): Promise<Daemon> => {
  const daemon = new Daemon(harness.cp, { stateDir: tempDir(prefix) });
  let markParked: () => void = () => undefined;
  const parked = new Promise<"parked">((resolve) => {
    markParked = () => resolve("parked");
  });
  const starting = daemon.start({
    bootstrapDoor: async () => {
      markParked();
      return { close: async () => undefined };
    },
  });
  const first = await Promise.race([starting, parked]);
  if (first === "parked") {
    await daemon.stop();
    await starting;
    throw new Error("the daemon parked instead of starting");
  }
  expect(outcomeOf(first)).toEqual({ allowed: true, reasonCode: ReasonCode.OK, blockingFindings: [] });
  expect(await modeOf(daemon)).toBe("NORMAL");
  return daemon;
};

/** The startup doctor's own record of a finding, read from the first system DOCTOR_REPORT row. */
const startupFinding = (harness: Harness, code: string) =>
  harness.cp.audit
    .byKind("DOCTOR_REPORT")
    .map((event) => event.evidence as {
      scope: string;
      findings: Array<{ code: string; severity: string; blocking: boolean }>;
    })
    .find((evidence) => evidence.scope === "system")
    ?.findings.find((finding) => finding.code === code);

const PRODUCER = `
import { createHash } from 'node:crypto';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const fields = {
  domain: 'hermes.target-bind', version: 1, actor_id: request.actor_id,
  binding_generation: request.binding_generation,
  executor_runtime_identity: request.executor_runtime_identity,
  requested_session_id: request.session_id,
  lineage_root_digest: request.expected_lineage_root_digest,
};
const canonical = JSON.stringify(Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))));
process.stdout.write(JSON.stringify({ ...fields, receipt_digest: 'sha256:' + createHash('sha256').update(canonical).digest('hex') }));
`;

/**
 * The existing same-actor re-attach door, `hermes.adoptIncumbent` (`agentctl adopt hermes`), with
 * this test process standing in for the live Gateway. Nothing here writes the database: the
 * adoption binds through `BindingRegistry.bind`'s `restoreCeo`, which requires the newest CEO
 * generation REVOKED and its runtime DEAD.
 */
const adoptLiveIncumbent = async (harness: Harness) => {
  const home = tempDir("acp-dead-ceo-adopt-");
  symlinkSync(process.execPath, join(home, "node"));
  writeFileSync(join(home, "producer.mjs"), PRODUCER);
  const token = readProcessStartToken(process.pid);
  if (!token) throw new Error("this process's start token is unreadable");
  const lineageRootDigest = `sha256:${"a".repeat(64)}`;
  const proof = {
    session_id: "authenticated-live-head",
    lineage_root_digest: lineageRootDigest,
    process_pid: process.pid,
    process_started_at: token,
  };
  return createHermesIncumbentAdoption(harness.cp, {
    gatewayOrigin: async () => proof,
    lineageRootDigest,
    hermesExecutable: new URL("../fixtures/hermes-target-bind-producer.sh", import.meta.url).pathname,
    hermesProfile: "fixture",
    hermesHome: home,
    executorRuntimeIdentity: "fixture-runtime",
  }).adopt({ gatewayPid: process.pid, gatewayStartToken: token });
};

const actorCount = (harness: Harness): number =>
  harness.cp.db.all(`SELECT actor_id FROM conversational_actors`).length;

describe("a CEO whose process died with the daemon", () => {
  it("starts to the operator door, which releases the binding, and the same actor re-attaches", async () => {
    const fixture = ceoBinding();
    const { harness } = fixture;
    const daemon = await startedToTheDoor(harness, "acp-dead-ceo-start-");
    try {
      // The premise: the start's reconcile found the session dead and left its binding ACTIVE.
      expect(harness.cp.sessions.require(fixture.sessionId).lifecycle).toBe(SessionLifecycle.ERROR);
      expect(harness.cp.bindings.active(roleKeyFor(Role.CEO))?.assignmentId).toBe(fixture.assignmentId);
      // Still named at system scope, only no longer blocking there; the session's own report blocks.
      expect(startupFinding(harness, "SESSION_PROCESS_MISSING")).toEqual({
        code: "SESSION_PROCESS_MISSING",
        severity: "ERROR",
        blocking: false,
      });
      const sessionReport = await harness.cp.doctor.run("session", fixture.sessionId);
      expect(sessionReport.findings.find((finding) => finding.code === "SESSION_PROCESS_MISSING"))
        .toMatchObject({ severity: "ERROR", blocking: true });

      // While the dead binding is ACTIVE the supported re-attach refuses and writes nothing.
      const early = stateOf(harness);
      expect((await adoptLiveIncumbent(harness)).allowed).toBe(false);
      expect(stateOf(harness)).toEqual(early);

      const recovered = await daemon.handleOperatorRequest(ceoRecovery(fixture), OWNER_PEER);
      expect(recovered).toMatchObject({
        allowed: true,
        reasonCode: ReasonCode.OK,
        value: {
          projectId: null,
          roleKey: roleKeyFor(Role.CEO),
          assignmentId: fixture.assignmentId,
          sessionId: fixture.sessionId,
          releasedGeneration: fixture.bindingGeneration,
          liveness: "DEAD",
        },
      });
      expect(harness.cp.bindings.active(roleKeyFor(Role.CEO))).toBeNull();
      expect(harness.cp.db.get<{ status: string; revoked_reason: string }>(
        `SELECT status, revoked_reason FROM assignments WHERE assignment_id = ?`,
        [fixture.assignmentId],
      )).toMatchObject({ status: "REVOKED", revoked_reason: expect.stringContaining("dead canonical binding recovery") });
      const recorded = harness.cp.audit.byKind("DEAD_BINDING_RECOVERED");
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        roleKey: roleKeyFor(Role.CEO),
        projectId: null,
        sessionId: fixture.sessionId,
        actor: OWNER_PEER.actor,
        evidence: {
          assignmentId: fixture.assignmentId,
          releasedGeneration: fixture.bindingGeneration,
          liveness: "DEAD",
        },
      });

      // A repeat finds nothing to release.
      const repeated = await daemon.handleOperatorRequest(ceoRecovery(fixture), OWNER_PEER);
      expect(repeated).toMatchObject({ allowed: false, reasonCode: ReasonCode.NOT_FOUND });

      // The same actor re-attaches at the next generation; no actor is minted.
      const actorsBefore = actorCount(harness);
      const adopted = await adoptLiveIncumbent(harness);
      expect(adopted).toMatchObject({
        allowed: true,
        value: { actorId: fixture.actorId, bindingGeneration: fixture.bindingGeneration + 1 },
      });
      if (!adopted.allowed) return;
      expect(actorCount(harness)).toBe(actorsBefore);
      const active = harness.cp.bindings.active(roleKeyFor(Role.CEO));
      expect(active).toMatchObject({
        sessionId: adopted.value.sessionId,
        bindingGeneration: fixture.bindingGeneration + 1,
      });
      expect(harness.cp.db.get<{ actor_id: string }>(
        `SELECT actor_id FROM assignments WHERE assignment_id = ?`,
        [active?.assignmentId ?? ""],
      )?.actor_id).toBe(fixture.actorId);
    } finally {
      await daemon.stop();
    }
  });
});

describe("the CEO door fails closed", () => {
  const refusedWithNothingChanged = async (
    fixture: CeoFixture,
    daemon: Daemon,
    overrides: Record<string, unknown>,
  ): Promise<{ reasonCode: ReasonCode; evidence: unknown }> => {
    const before = stateOf(fixture.harness);
    const refused = await daemon.handleOperatorRequest(ceoRecovery(fixture, overrides), OWNER_PEER);
    expect(refused.allowed, JSON.stringify(refused)).toBe(false);
    expect(stateOf(fixture.harness)).toEqual(before);
    expect(fixture.harness.cp.bindings.active(roleKeyFor(Role.CEO))?.assignmentId).toBe(fixture.assignmentId);
    return { reasonCode: refused.reasonCode, evidence: refused.allowed ? null : refused.evidence };
  };

  it.each([
    // This test process, with the start `create()` read for it.
    ["alive", { osPid: process.pid }, "ALIVE"],
    // pid 1 belongs to root: `kill(1, 0)` is EPERM for this user, and EPERM is never dead.
    ["not ours to signal (EPERM)", { osPid: 1 }, "ALIVE"],
    ["no recorded pid", { osPid: null }, "UNKNOWN"],
    ["a live pid whose recorded start cannot be read", { osPid: process.pid, osStartedAt: "not a start time" }, "UNKNOWN"],
  ] as const)("refuses a CEO session that is %s", async (_label, session, liveness) => {
    const fixture = ceoBinding({ ...session, lifecycle: "ERROR" });
    const daemon = await startedToTheDoor(fixture.harness, "acp-dead-ceo-liveness-");
    try {
      const refused = await refusedWithNothingChanged(fixture, daemon, {});
      expect(refused.reasonCode).toBe(ReasonCode.RECOVERY_TAKEOVER_REQUIRES_UNREACHABLE_OWNER);
      expect(refused.evidence).toMatchObject({ liveness });
    } finally {
      await daemon.stop();
    }
  });

  it("refuses a request that names any other target", async () => {
    const fixture = ceoBinding();
    const daemon = await startedToTheDoor(fixture.harness, "acp-dead-ceo-target-");
    try {
      const wrong: Array<[string, Record<string, unknown>, ReasonCode]> = [
        ["the canonical CTO's role key", { role: Role.PRIMARY_CTO, projectId: "some-project" }, ReasonCode.NOT_FOUND],
        ["a CTO with no project", { role: Role.PRIMARY_CTO }, ReasonCode.INVALID_ARGUMENT],
        ["a project", { projectId: "some-project" }, ReasonCode.INVALID_ARGUMENT],
        ["no project field at all", { projectId: undefined }, ReasonCode.INVALID_ARGUMENT],
        ["a bootstrap CTO", { role: Role.BOOTSTRAP_CTO }, ReasonCode.INVALID_ARGUMENT],
        ["a bootstrap CTO with a project", { role: Role.BOOTSTRAP_CTO, projectId: "some-project" }, ReasonCode.INVALID_ARGUMENT],
        ["a worker", { role: Role.WORKER, projectId: "some-project" }, ReasonCode.INVALID_ARGUMENT],
        ["a blind reviewer", { role: Role.BLIND_REVIEWER, projectId: "some-project" }, ReasonCode.INVALID_ARGUMENT],
        ["a role that does not exist", { role: "ANY", projectId: "some-project" }, ReasonCode.INVALID_ARGUMENT],
        ["another session", { sessionId: "ses_not_the_bound_one" }, ReasonCode.INVALID_ARGUMENT],
        ["another incarnation", { sessionIncarnation: "not-the-bound-lifetime" }, ReasonCode.INVALID_ARGUMENT],
        ["a generation not in force", { expectedBindingGeneration: fixture.bindingGeneration + 1 }, ReasonCode.WRITE_BINDING_GENERATION_STALE],
        ["generation zero", { expectedBindingGeneration: 0 }, ReasonCode.INVALID_ARGUMENT],
      ];
      for (const [field, override, expected] of wrong) {
        const refused = await refusedWithNothingChanged(fixture, daemon, override);
        expect({ field, reasonCode: refused.reasonCode }).toEqual({ field, reasonCode: expected });
      }
      expect(await modeOf(daemon)).toBe("NORMAL");
    } finally {
      await daemon.stop();
    }
  });

  it("refuses a generation the CEO has since been re-bound past", async () => {
    // Generation 1 is released and the same dead session is bound again at generation 2 before
    // the request arrives; the request still names generation 1.
    const fixture = ceoBinding();
    const { harness } = fixture;
    expect(harness.cp.bindings.revoke(roleKeyFor(Role.CEO), "test: released").allowed).toBe(true);
    const rebound = harness.cp.bindings.bind({ role: Role.CEO, roleKey: roleKeyFor(Role.CEO), sessionId: fixture.sessionId });
    if (!rebound.allowed) throw new Error(rebound.message);
    expect(rebound.value.bindingGeneration).toBe(fixture.bindingGeneration + 1);
    const daemon = await startedToTheDoor(harness, "acp-dead-ceo-rebound-");
    try {
      const current = { ...fixture, assignmentId: rebound.value.assignmentId };
      const refused = await refusedWithNothingChanged(current, daemon, {});
      expect(refused.reasonCode).toBe(ReasonCode.WRITE_BINDING_GENERATION_STALE);
    } finally {
      await daemon.stop();
    }
  });

  it("refuses when the CEO's live runtime has moved off the dead bound session", async () => {
    // A surviving switch moves the actor's runtime and keeps the binding row and its generation,
    // so the bound session can be dead while the CEO answers on another, live one. That bound
    // session's death says nothing about the CEO's.
    const fixture = ceoBinding();
    const { harness } = fixture;
    const live = harness.cp.sessions.create({ provider: "hermes", model: "hermes-runtime", osPid: process.pid });
    expect(harness.cp.sessions.transition(live.sessionId, SessionLifecycle.READY, "test live runtime").allowed).toBe(true);
    const moved = harness.cp.bindings.switchTo({
      role: Role.CEO,
      roleKey: roleKeyFor(Role.CEO),
      sessionId: live.sessionId,
      reason: "test: surviving move",
      conversation: "SURVIVED",
    });
    if (!moved.allowed) throw new Error(moved.message);
    expect(moved.value).toMatchObject({
      assignmentId: fixture.assignmentId,
      bindingGeneration: fixture.bindingGeneration,
      boundSessionId: fixture.sessionId,
      sessionId: live.sessionId,
    });
    const daemon = await startedToTheDoor(harness, "acp-dead-ceo-moved-");
    try {
      const refused = await refusedWithNothingChanged(fixture, daemon, {});
      expect(refused.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
      expect(refused.evidence).toMatchObject({ boundSessionId: fixture.sessionId, liveSessionId: live.sessionId });
    } finally {
      await daemon.stop();
    }
  });
});

describe("the door's range", () => {
  it("is an explicit two-role allowlist", () => {
    expect(DEAD_BINDING_RECOVERY_ROLES).toEqual([Role.PRIMARY_CTO, Role.CEO]);
  });

  it("is reached for the CEO by `agentctl binding recover-dead-ceo`, and the CTO command is unchanged", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const request = vi.fn(async () => ({
      allowed: true as const,
      reasonCode: ReasonCode.OK,
      evidence: {},
      value: {},
    }));
    try {
      expect(await dispatch({ request }, "binding", ["recover-dead-ceo", "ses_ceo", "ses_ceo#inc", "3"], false)).toBe(0);
      expect(request).toHaveBeenLastCalledWith("binding.recoverDead", {
        projectId: null,
        role: Role.CEO,
        sessionId: "ses_ceo",
        sessionIncarnation: "ses_ceo#inc",
        expectedBindingGeneration: 3,
      }, undefined);
      expect(await dispatch({ request }, "binding", ["recover-dead", "proj", "ses_cto", "ses_cto#inc", "2"], false)).toBe(0);
      expect(request).toHaveBeenLastCalledWith("binding.recoverDead", {
        projectId: "proj",
        role: Role.PRIMARY_CTO,
        sessionId: "ses_cto",
        sessionIncarnation: "ses_cto#inc",
        expectedBindingGeneration: 2,
      }, undefined);
      await expect(dispatch({ request }, "binding", ["recover-dead-ceo", "ses_ceo", "ses_ceo#inc"], false))
        .rejects.toThrow(/expectedBindingGeneration/);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      stdout.mockRestore();
    }
  });
});
