import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";

import Database from "better-sqlite3";
import { type MockInstance, afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { CONTINUITY_RUNTIME_LOST_REVOCATION_REASON } from "../../src/continuity/continuity-kernel.ts";
import { type Decision, allow, deny } from "../../src/core/errors.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { DEAD_CANONICAL_BINDING_RECOVERY_REASON_PREFIX } from "../../src/daemon/dead-binding-recovery.ts";
import { ExecutionMode, Role, type RoleBinding, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import {
  CanonicalSelfClaim,
  hostSessionRegistryAbsent,
  type CanonicalSelfClaimReceipt,
  type ProcessSnapshot,
} from "../../src/registry/canonical-self-claim.ts";
import { CONTINUITY_PAUSE_INCOMPLETE_FAILOVER_REASON, CONTINUITY_PAUSE_RUNTIME_LOST_REASON } from "../../src/run/run-engine.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { bindCeo, bindWorker, bootstrapCtoProvider, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * Measured live (2026-11-13): after a reboot the daemon started with a dead canonical PRIMARY_CTO (gen 22)
 * that owned an ACTIVE run. The first continuity pass paused the run ("the runtime was lost and not failed
 * over") and revoked the binding. The same conversation then re-attached at gen 23, but with its
 * predecessor already revoked the self-claim took no run over, so the run stayed pinned to gen 22: run_ack
 * at gen 23 was RUN_OWNER_REVOKED, and every later pass kept the hold because "the run's owner pin is not
 * its PRIMARY_CTO's active binding". Its only exit was the CEO's run_cancel.
 *
 * The pass that finds the role covered again by that canonical same-actor successor now hands the held
 * run to it (`RunEngine.releaseContinuityHold`): the pin moves to the successor and the hold is released
 * in one transaction, under the checks every release applies. Each refusal below stays held.
 */

const CANON = "77777777-7777-4777-8777-777777777777";
const OTHER_CANON = "66666666-6666-4666-8666-666666666666";
const CWD = "/work/held-cto";
const ROOM = "buzz-held-room";
const CTO_ACTOR = "buzz:held-cto";
const OTHER_ACTOR = "buzz:other-cto";
const PEER_PROTOCOL = "mcp/2025-06-18";
const PEER_IDENTITY = "claude-code-mcp-client";
const PIN_KEPT = "the run's owner pin is not its PRIMARY_CTO's active binding";
const HANDED_OVER = "CONTINUITY_HOLD_HANDED_TO_SUCCESSOR";

const CONTRACT = {
  goal: "make app() return 2",
  why: "downstream callers expect 2",
  scope: ["src/app.js"],
  nonGoals: [],
  acceptance: ["verify.js exits 0"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};

const stragglers: ChildProcess[] = [];
afterEach(() => {
  for (const child of stragglers.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

/** The CTO's claude process as run number `run` of conversation `uuid`. */
const claudeRun = (
  run: number,
  uuid: string,
  claude = { pid: 9 + run, startedAt: `Fri Jan  1 0${run}:00:00 2027` },
): ProcessSnapshot[] => [
  {
    pid: 100, ppid: 50, argv: ["/usr/bin/node", "/opt/acp/mcp-server.js"],
    command: "/usr/bin/node /opt/acp/mcp-server.js", cwd: CWD, cwdProbeFailure: null, startedAt: "t1",
  },
  {
    pid: 50, ppid: claude.pid, argv: ["/bin/zsh", "-c", "relay"], command: "/bin/zsh -c relay", cwd: CWD,
    cwdProbeFailure: null, startedAt: "t2",
  },
  {
    pid: claude.pid, ppid: 1, argv: ["/opt/claude/claude", "--resume", uuid],
    command: `/opt/claude/claude --resume ${uuid}`, cwd: CWD, cwdProbeFailure: null, startedAt: claude.startedAt,
  },
];

const signalFrom = (chain: readonly ProcessSnapshot[]) => (pid: number): void => {
  if (chain.some((entry) => entry.pid === pid)) return;
  throw Object.assign(new Error(`no such process: ${pid}`), { code: "ESRCH" });
};

/**
 * One project whose canonical PRIMARY_CTO (generation 1) owns one dispatched ACTIVE run, killed with
 * nothing revoked, and the daemon started over it (#1391 lets it start). `ownerDies: false` leaves it live.
 */
const deadOwnerUnderDaemon = async ({ ownerDies = true }: { ownerDies?: boolean } = {}) => {
  const harness = makeHarness();
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  bindCeo(harness);
  const registered = await registerFixtureProject(harness);
  const { projectId } = registered;
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
  const { db } = harness.cp;
  bootstrapCtoProvider(harness.cp, harness.clock);

  const live = spawn("/bin/sleep", ["600"], { stdio: "ignore" });
  stragglers.push(live);
  await once(live, "spawn");
  const liveStart = readProcessStartToken(live.pid!);
  if (liveStart === null) throw new Error("the stand-in process has no readable start token");
  const runOne = claudeRun(1, CANON, { pid: live.pid!, startedAt: liveStart });

  const claimAs = (
    run: number,
    who: { uuid: string; actor: string } = { uuid: CANON, actor: CTO_ACTOR },
  ): Promise<Decision<CanonicalSelfClaimReceipt>> => {
    const chain = run === 1 ? runOne : claudeRun(run, who.uuid);
    return new CanonicalSelfClaim(
      db, harness.clock, harness.cp.audit, harness.cp.sessions, harness.cp.bindings,
      { isAllowedActor: () => true },
      async (): Promise<Decision<string>> => allow(ReasonCode.OK, ROOM),
      {
        canonicalSessions: [{ sessionUuid: who.uuid, projectId, buzzActorId: who.actor }],
        canonicalBuzzChannelId: ROOM,
        expectedPeerProtocolVersion: PEER_PROTOCOL,
        expectedPeerIdentity: PEER_IDENTITY,
      },
      {
        processInspector: { snapshot: (pid) => chain.find((entry) => entry.pid === pid) ?? null },
        imageInspector: {
          resolve: () => ({ imagePath: "/fake/claude", version: "0.0.0-test", sha256: `sha256:${"0".repeat(64)}` }),
        },
        transcriptReader: { locate: (uuid) => ({ path: `/fake/transcripts/${uuid}.jsonl`, sizeBytes: 42 }) },
        hostSessionRegistryReader: { read: (pid) => hostSessionRegistryAbsent(`/fake/sessions/${pid}.json is absent`) },
        processSignal: signalFrom(chain),
      },
    ).claim({
      callerPid: 100,
      claimedSessionUuid: who.uuid,
      projectId,
      expectedBindingGeneration: run,
      peerProtocolVersion: PEER_PROTOCOL,
      peerIdentity: PEER_IDENTITY,
      buzzPurpose: "continuity:PRIMARY_CTO",
    });
  };

  const first = await claimAs(1);
  if (!first.allowed) throw new Error(`the first canonical claim failed: ${JSON.stringify(first)}`);
  const sessionId = first.value.sessionId;

  const created = harness.cp.runs.create({
    projectId, executionMode: ExecutionMode.STANDARD, contract: CONTRACT,
    repositories: [{ repositoryId: registered.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const dispatched = await harness.cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);

  if (ownerDies) {
    live.kill("SIGKILL");
    await once(live, "exit");
  }

  const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-held-cto-") });
  const started = await daemon.start({ bootstrapDoor: async () => ({ close: async () => undefined }) });
  if (!started.allowed) throw new Error(`the daemon did not start: ${started.reasonCode}`);

  const owner = () => db.get<{ owner_session_id: string; owner_binding_generation: number; state: string }>(
    `SELECT owner_session_id, owner_binding_generation, state FROM runs WHERE run_id = ?`, [runId],
  );
  const handOvers = () => db.all<{ run_id: string; session_id: string; evidence_json: string }>(
    `SELECT run_id, session_id, evidence_json FROM audit_events WHERE kind = ?`, [HANDED_OVER],
  );
  return { harness, db, daemon, projectId, roleKey, sessionId, runId, claimAs, owner, handOvers };
};
type Fixture = Awaited<ReturnType<typeof deadOwnerUnderDaemon>>;

/** The real ordering: continuity pauses the run and revokes the dead binding, then the claim, then a pass. */
const heldThenClaimed = async (steps: {
  beforePause?: (f: Fixture) => void | Promise<void>;
  afterPause?: (f: Fixture) => void | Promise<void>;
  generation?: number;
  claim?: (f: Fixture) => Promise<Decision<CanonicalSelfClaimReceipt>>;
  afterClaim?: (f: Fixture) => void;
  pauseReason?: string;
} = {}) => {
  const f = await deadOwnerUnderDaemon();
  await steps.beforePause?.(f);
  await f.daemon.reconcileContinuity("test: the dead owner");
  // The premise, as measured live: paused for the lost runtime, and the dead generation revoked for it.
  expect(f.harness.cp.runs.require(f.runId)).toMatchObject({
    state: RunState.BLOCKED, stateReason: steps.pauseReason ?? CONTINUITY_PAUSE_RUNTIME_LOST_REASON, ownerBindingGeneration: 1,
  });
  expect(f.db.get(`SELECT status, revoked_reason FROM assignments WHERE role_key = ? AND binding_generation = 1`, [f.roleKey]))
    .toEqual({ status: "REVOKED", revoked_reason: CONTINUITY_RUNTIME_LOST_REVOCATION_REASON });
  await steps.afterPause?.(f);
  const claimed = await (steps.claim ?? ((fixture) => fixture.claimAs(2)))(f);
  expect(claimed.allowed, JSON.stringify(claimed)).toBe(true);
  if (!claimed.allowed) throw new Error("unreachable");
  expect(claimed.value.binding.bindingGeneration).toBe(steps.generation ?? 2);
  steps.afterClaim?.(f);
  const report = await f.daemon.reconcileContinuity("test: the successor");
  return { f, claimed: claimed.value, holds: report?.continuityHolds };
};

/** Every refusal: held, pinned to the dead generation, and no hand-over recorded. */
const expectStillHeld = (
  held: Awaited<ReturnType<typeof heldThenClaimed>>,
  why: string | ReturnType<typeof expect.stringMatching>,
) => {
  const { f, claimed, holds } = held;
  expect(holds).toEqual({ released: [], kept: [{ runId: f.runId, why }] });
  expect(f.owner()).toEqual({ owner_session_id: f.sessionId, owner_binding_generation: 1, state: RunState.BLOCKED });
  expect(f.handOvers()).toEqual([]);
  expect(f.harness.cp.runs.assertOwner(f.runId, claimed.sessionId, claimed.binding.bindingGeneration)).toMatchObject({
    allowed: false, reasonCode: ReasonCode.RUN_OWNER_REVOKED,
  });
};

/** The role's current holder loses its runtime, and a pass revokes it as continuity does (the run is already held). */
const loseAgain = async (f: Fixture) => {
  const holder = f.harness.cp.bindings.active(f.roleKey)!;
  const settled = f.harness.cp.sessions.transition(holder.sessionId, SessionLifecycle.ERROR, "test: lost again");
  if (!settled.allowed) throw new Error(settled.message);
  await f.daemon.reconcileContinuity("test: lost again");
  expect(f.db.get(`SELECT status, revoked_reason FROM assignments WHERE assignment_id = ?`, [holder.assignmentId]))
    .toEqual({ status: "REVOKED", revoked_reason: CONTINUITY_RUNTIME_LOST_REVOCATION_REASON });
};

describe("a continuity-held run of a dead canonical CTO follows the same conversation's next generation", () => {
  it("is handed to the successor and released in the pass that finds the role covered again", async () => {
    const { f, claimed, holds } = await heldThenClaimed();
    try {
      expect(holds).toEqual({ released: [f.runId], kept: [] });
      expect(claimed.sessionId).not.toBe(f.sessionId);
      expect(f.owner()).toEqual({ owner_session_id: claimed.sessionId, owner_binding_generation: 2, state: RunState.ACTIVE });
      expect(f.harness.cp.runs.require(f.runId).continuityHoldRoleKey).toBeNull();
      // run_ack's owner fence (`RunEngine.assertOwner`) now admits the new generation.
      expect(f.harness.cp.runs.assertOwner(f.runId, claimed.sessionId, 2).allowed).toBe(true);
      const recorded = f.handOvers();
      expect(recorded.map((row) => ({ runId: row.run_id, sessionId: row.session_id }))).toEqual([
        { runId: f.runId, sessionId: claimed.sessionId },
      ]);
      expect(JSON.parse(recorded[0]!.evidence_json)).toMatchObject({
        fromGeneration: 1, toGeneration: 2, fromSession: f.sessionId, toSessionId: claimed.sessionId,
      });
      // A later pass has nothing left to do for it.
      const again = await f.daemon.reconcileContinuity("test: again");
      expect(again?.continuityHolds).toEqual({ released: [], kept: [] });
      expect(f.handOvers()).toHaveLength(1);
    } finally {
      await f.daemon.stop();
    }
  });

  it("moves the run's claims of the dead generation with its pin", async () => {
    const { f, claimed } = await heldThenClaimed({
      beforePause: (fixture) => {
        const repo = fixture.db.get<{ identity: string }>(
          `SELECT r.identity FROM repositories r JOIN run_repositories rr ON rr.repository_id = r.repository_id
            WHERE rr.run_id = ?`,
          [fixture.runId],
        )!;
        const acquired = fixture.harness.cp.claims.acquire({
          runId: fixture.runId, ownerRoleKey: fixture.roleKey, repositoryIdentity: repo.identity,
          ownerSessionId: fixture.sessionId, ownerBindingGeneration: 1, branch: "task/held",
        } as Parameters<typeof fixture.harness.cp.claims.acquire>[0]);
        if (!acquired.allowed) throw new Error(JSON.stringify(acquired));
      },
    });
    try {
      expect(f.owner()?.owner_binding_generation).toBe(2);
      expect(f.db.all(`SELECT owner_session_id, owner_binding_generation FROM resource_claims WHERE run_id = ?`, [f.runId]))
        .toEqual([{ owner_session_id: claimed.sessionId, owner_binding_generation: 2 }]);
    } finally {
      await f.daemon.stop();
    }
  });

  it("rolls the hand-over back when its record is refused", async () => {
    const held = await heldThenClaimed({
      afterClaim: (f) => {
        const record = f.harness.cp.audit.record.bind(f.harness.cp.audit);
        vi.spyOn(f.harness.cp.audit, "record").mockImplementation((entry) =>
          entry.kind === HANDED_OVER ? deny(ReasonCode.AUDIT_WRITE_FAILED, "test: refused") : record(entry));
      },
    });
    try {
      expect(held.holds?.released).toEqual([]);
      expect(held.f.owner()).toEqual({ owner_session_id: held.f.sessionId, owner_binding_generation: 1, state: RunState.BLOCKED });
      expect(held.f.harness.cp.runs.require(held.f.runId).continuityHoldRoleKey).toBe(held.f.roleKey);
    } finally {
      vi.restoreAllMocks();
      await held.f.daemon.stop();
    }
  });

  it("is handed over across a generation of the same conversation that lost its runtime again", async () => {
    const { f, claimed, holds } = await heldThenClaimed({
      generation: 3,
      claim: async (fixture) => {
        const second = await fixture.claimAs(2);
        if (!second.allowed) throw new Error(JSON.stringify(second));
        await loseAgain(fixture);
        return fixture.claimAs(3);
      },
    });
    try {
      expect(holds).toEqual({ released: [f.runId], kept: [] });
      expect(f.owner()).toEqual({ owner_session_id: claimed.sessionId, owner_binding_generation: 3, state: RunState.ACTIVE });
      expect(JSON.parse(f.handOvers()[0]!.evidence_json)).toMatchObject({ fromGeneration: 1, toGeneration: 3 });
    } finally {
      await f.daemon.stop();
    }
  });

  it("is handed over when the next claim, not a pass, released a generation that died again", async () => {
    const { f, claimed, holds } = await heldThenClaimed({
      generation: 3,
      claim: async (fixture) => {
        const second = await fixture.claimAs(2);
        if (!second.allowed) throw new Error(JSON.stringify(second));
        // Gen 2's process is gone; gen 3 claims before any pass, so the claim itself releases gen 2.
        return fixture.claimAs(3);
      },
    });
    try {
      const released = f.db.get<{ status: string; revoked_reason: string }>(
        `SELECT status, revoked_reason FROM assignments WHERE role_key = ? AND binding_generation = 2`, [f.roleKey],
      );
      expect(released?.status).toBe("REVOKED");
      expect(released?.revoked_reason.startsWith(DEAD_CANONICAL_BINDING_RECOVERY_REASON_PREFIX)).toBe(true);
      expect(holds).toEqual({ released: [f.runId], kept: [] });
      expect(f.owner()).toEqual({ owner_session_id: claimed.sessionId, owner_binding_generation: 3, state: RunState.ACTIVE });
      expect(JSON.parse(f.handOvers()[0]!.evidence_json)).toMatchObject({ fromGeneration: 1, toGeneration: 3 });
    } finally {
      await f.daemon.stop();
    }
  });

  describe("stays held", () => {
    it("while the owner has suspended the project", async () => {
      const held = await heldThenClaimed({
        afterPause: async (f) => {
          const suspended = await f.harness.cp.cto.suspendProject(f.projectId, true, "owner stop", undefined, "test-owner");
          expect(suspended.allowed, JSON.stringify(suspended)).toBe(true);
        },
      });
      try {
        expectStillHeld(held, "the run's project is suspended");
      } finally {
        await held.f.daemon.stop();
      }
    });

    it("after a deliberate revocation of a generation between the pin and the successor", async () => {
      const held = await heldThenClaimed({
        generation: 3,
        claim: async (f) => {
          const second = await f.claimAs(2);
          if (!second.allowed) throw new Error(JSON.stringify(second));
          const released = f.harness.cp.bindings.revoke(f.roleKey, "CEO delegated release: stop this CTO");
          expect(released.allowed, JSON.stringify(released)).toBe(true);
          return f.claimAs(3);
        },
      });
      try {
        expectStillHeld(held, PIN_KEPT);
      } finally {
        await held.f.daemon.stop();
      }
    });

    it("across a generation of another actor, though it too lost its runtime", async () => {
      const held = await heldThenClaimed({
        generation: 3,
        claim: async (f) => {
          const other = await f.claimAs(2, { uuid: OTHER_CANON, actor: OTHER_ACTOR });
          if (!other.allowed) throw new Error(JSON.stringify(other));
          await loseAgain(f);
          return f.claimAs(3);
        },
      });
      try {
        expectStillHeld(held, PIN_KEPT);
      } finally {
        await held.f.daemon.stop();
      }
    });

    it("for a different actor's binding", async () => {
      const held = await heldThenClaimed({ claim: (f) => f.claimAs(2, { uuid: OTHER_CANON, actor: OTHER_ACTOR }) });
      try {
        expectStillHeld(held, PIN_KEPT);
      } finally {
        await held.f.daemon.stop();
      }
    });

    it("for an actor that is not a canonical conversation", async () => {
      const held = await heldThenClaimed({
        afterClaim: (f) => {
          // The one fact changed: the actor's lifetime target is not a self-claimed conversation.
          // A second connection, past the guard that keeps a target binding immutable.
          const side = new Database(f.db.file);
          try {
            side.exec(`DROP TRIGGER actor_target_bindings_immutable`);
            side.prepare(
              `UPDATE actor_target_bindings SET executor_kind = 'hermes'
                WHERE target_actor_id = (SELECT actor_id FROM assignments WHERE role_key = ? AND binding_generation = 1)`,
            ).run(f.roleKey);
          } finally {
            side.close();
          }
        },
      });
      try {
        expectStillHeld(held, PIN_KEPT);
      } finally {
        await held.f.daemon.stop();
      }
    });

    for (const reason of ["CEO delegated replacement of proven-dead runtime", "project suspended: operator"]) {
      it(`for a predecessor revoked for another reason: ${reason}`, async () => {
        const held = await heldThenClaimed({
          afterPause: (f) => {
            f.db.run(`UPDATE assignments SET revoked_reason = ? WHERE role_key = ? AND binding_generation = 1`, [reason, f.roleKey]);
          },
        });
        try {
          expectStillHeld(held, PIN_KEPT);
        } finally {
          await held.f.daemon.stop();
        }
      });
    }

    it("while a task execution of the run is RUNNING", async () => {
      const held = await heldThenClaimed({
        beforePause: (f) => {
          const tasks = f.harness.cp.tasks.submit(f.runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
          if (!tasks.allowed) throw new Error(tasks.message);
          const task = f.harness.cp.tasks.ready(f.runId)[0]!;
          const workerSessionId = bindWorker(f.harness, task.taskId);
          const execution = f.harness.cp.tasks.startExecution({
            runId: f.runId, taskId: task.taskId, ownerBindingGeneration: 1, workerSessionId,
            provider: "scripted", model: "scripted-worker",
          });
          if (!execution.allowed) throw new Error(execution.message);
        },
      });
      try {
        expectStillHeld(held, "the predecessor generation still has a RUNNING task execution on the run");
      } finally {
        await held.f.daemon.stop();
      }
    });

    it("while a candidate pipeline attempt of the dead generation is RUNNING", async () => {
      const held = await heldThenClaimed({
        beforePause: (f) => {
          f.db.run(
            `INSERT INTO candidate_pipeline_attempts (run_id, attempt_id, owner_session_id, owner_binding_generation, state, started_at, deadline_at)
             VALUES (?, 'cpa_held', ?, 1, 'RUNNING', ?, '2999-01-01T00:00:00.000Z')`,
            [f.runId, f.sessionId, f.harness.clock.nowIso()],
          );
        },
      });
      try {
        expectStillHeld(held, "the predecessor generation still has a RUNNING candidate pipeline attempt on the run");
      } finally {
        await held.f.daemon.stop();
      }
    });

    it("when the run moved under the hold", async () => {
      const held = await heldThenClaimed({
        afterPause: (f) => {
          f.harness.cp.audit.record({ kind: "RUN_PRIORITY_SET", runId: f.runId, evidence: { priority: "HIGH" } });
        },
      });
      try {
        expectStillHeld(held, expect.stringMatching(/^RUN_PRIORITY_SET \(event \d+\) was recorded for the run after continuity's pause/));
      } finally {
        await held.f.daemon.stop();
      }
    });

    it("for a hold continuity placed for another loss than the runtime's", async () => {
      const held = await heldThenClaimed({
        beforePause: (f) => {
          // The CTO's own hold, for an incomplete failover; the pass then finds the run BLOCKED and only revokes.
          const paused = f.harness.cp.runs.pauseForContinuity(f.runId, f.roleKey, CONTINUITY_PAUSE_INCOMPLETE_FAILOVER_REASON, {
            roleKey: f.roleKey, continuityAction: "PAUSE_NEW_WORK",
          });
          if (!paused.allowed) throw new Error(paused.message);
        },
        pauseReason: CONTINUITY_PAUSE_INCOMPLETE_FAILOVER_REASON,
      });
      try {
        expectStillHeld(held, PIN_KEPT);
      } finally {
        await held.f.daemon.stop();
      }
    });

    it("for a successor that is not READY", async () => {
      let asked: unknown = null;
      const again = await heldThenClaimed({
        afterClaim: (f) => {
          const successor = f.harness.cp.bindings.active(f.roleKey)!;
          const settled = f.harness.cp.sessions.transition(successor.sessionId, SessionLifecycle.ERROR, "test: successor lost");
          if (!settled.allowed) throw new Error(settled.message);
          // A pass does not count it as covering the role, so the release is asked directly.
          asked = f.harness.cp.runs.releaseContinuityHold(f.runId, successor);
        },
      });
      try {
        expect(asked).toMatchObject({ allowed: true, value: { released: false, kept: "the held role's session is not READY" } });
        expect(again.holds?.released).toEqual([]);
        expect(again.f.owner()).toEqual({ owner_session_id: again.f.sessionId, owner_binding_generation: 1, state: RunState.BLOCKED });
        expect(again.f.handOvers()).toEqual([]);
      } finally {
        await again.f.daemon.stop();
      }
    });
  });
});

const CEO = roleKeyFor(Role.CEO);

/** The CEO's session died with the reboot; continuity's failover for it is refused, as live. */
const loseCeo = (f: Fixture): MockInstance => {
  const ceo = f.harness.cp.bindings.active(CEO)!;
  const lost = f.harness.cp.sessions.transition(ceo.sessionId, SessionLifecycle.ERROR, "test: the CEO's session died");
  if (!lost.allowed) throw new Error(lost.message);
  return vi.spyOn(f.harness.cp.continuity, "failover")
    .mockResolvedValue(deny(ReasonCode.SESSION_NOT_READY, "test: the planned CEO session is not ready") as never);
};

/** The CEO re-adopted on a new READY session at its next generation; the dead session is not revived. */
const readoptCeo = (f: Fixture): RoleBinding => {
  const session = f.harness.cp.sessions.create({ provider: "scripted", model: "scripted-ceo" });
  const ready = f.harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test: the CEO re-adopted");
  if (!ready.allowed) throw new Error(ready.message);
  const bound = f.harness.cp.bindings.bind({ roleKey: CEO, role: Role.CEO, sessionId: session.sessionId });
  if (!bound.allowed) throw new Error(bound.message);
  return bound.value;
};

/**
 * Measured live (2026-11-14, run_6591ec8a and run_525e6b28): the reboot took the CEO and the CTOs together.
 * One continuity pass held each run for the CEO's lost runtime (`continuity_hold_role_key` = CEO) and
 * revoked the dead CTO generation for its own. The CEO was re-adopted and the same CTO conversation
 * re-attached at the next generation, and every later pass still kept the hold with "the run's owner pin is
 * not its PRIMARY_CTO's active binding": the hand-over applied only to a hold for the owner's own role.
 */
const heldForCeoThenClaimed = (steps: Parameters<typeof heldThenClaimed>[0] & { readopt?: boolean } = {}) => {
  let failover: MockInstance | null = null;
  return heldThenClaimed({
    ...steps,
    beforePause: async (f) => {
      failover = loseCeo(f);
      await steps.beforePause?.(f);
    },
    afterPause: async (f) => {
      failover?.mockRestore();
      // The premise, as live: the run is held for the CEO, and the CEO's dead generation was revoked too.
      expect(f.harness.cp.runs.require(f.runId).continuityHoldRoleKey).toBe(CEO);
      expect(f.harness.cp.bindings.active(CEO)).toBeNull();
      if (steps.readopt !== false) readoptCeo(f);
      await steps.afterPause?.(f);
    },
  });
};

describe("a run held for the CEO's loss, whose canonical CTO also died, follows the CTO's next generation", () => {
  it("is handed to the successor and released in the pass that finds the CEO covered again", async () => {
    const { f, claimed, holds } = await heldForCeoThenClaimed();
    try {
      expect(holds).toEqual({ released: [f.runId], kept: [] });
      expect(f.owner()).toEqual({ owner_session_id: claimed.sessionId, owner_binding_generation: 2, state: RunState.ACTIVE });
      expect(f.harness.cp.runs.require(f.runId)).toMatchObject({
        continuityHoldRoleKey: null, stateReason: `continuity hold released: ${CEO} covered again`,
      });
      expect(f.harness.cp.runs.assertOwner(f.runId, claimed.sessionId, 2).allowed).toBe(true);
      const recorded = f.handOvers();
      expect(recorded.map((row) => ({ runId: row.run_id, sessionId: row.session_id }))).toEqual([
        { runId: f.runId, sessionId: claimed.sessionId },
      ]);
      expect(JSON.parse(recorded[0]!.evidence_json)).toMatchObject({
        fromGeneration: 1, toGeneration: 2, fromSession: f.sessionId, toSessionId: claimed.sessionId,
      });
      const again = await f.daemon.reconcileContinuity("test: again");
      expect(again?.continuityHolds).toEqual({ released: [], kept: [] });
      expect(f.handOvers()).toHaveLength(1);
    } finally {
      await f.daemon.stop();
    }
  });

  describe("stays held", () => {
    it("while the CEO is not covered again", async () => {
      let asked: unknown[] = [];
      let lostCeo: RoleBinding | null = null;
      const held = await heldForCeoThenClaimed({
        readopt: false,
        beforePause: (f) => {
          lostCeo = f.harness.cp.bindings.active(CEO);
        },
        afterClaim: (f) => {
          const stale = lostCeo!;
          const readopted = readoptCeo(f);
          const lost = f.harness.cp.sessions.transition(readopted.sessionId, SessionLifecycle.ERROR, "test: lost again");
          if (!lost.allowed) throw new Error(lost.message);
          // A pass does not count either as covering the role, so the release is asked directly.
          asked = [stale, readopted].map((binding) => f.harness.cp.runs.releaseContinuityHold(f.runId, binding));
        },
      });
      try {
        expect(asked).toMatchObject([
          { allowed: true, value: { released: false, kept: "the held role's binding is no longer its active one" } },
          { allowed: true, value: { released: false, kept: "the held role's session is not READY" } },
        ]);
        expect(held.holds?.released).toEqual([]);
        expect(held.f.owner()).toEqual({ owner_session_id: held.f.sessionId, owner_binding_generation: 1, state: RunState.BLOCKED });
        expect(held.f.handOvers()).toEqual([]);
      } finally {
        await held.f.daemon.stop();
      }
    });

    it("after a deliberate revocation of a generation between the pin and the successor", async () => {
      const held = await heldForCeoThenClaimed({
        generation: 3,
        claim: async (f) => {
          const second = await f.claimAs(2);
          if (!second.allowed) throw new Error(JSON.stringify(second));
          const released = f.harness.cp.bindings.revoke(f.roleKey, "CEO delegated release: stop this CTO");
          expect(released.allowed, JSON.stringify(released)).toBe(true);
          return f.claimAs(3);
        },
      });
      try {
        expectStillHeld(held, PIN_KEPT);
      } finally {
        await held.f.daemon.stop();
      }
    });

    it("for a different actor's binding", async () => {
      const held = await heldForCeoThenClaimed({ claim: (f) => f.claimAs(2, { uuid: OTHER_CANON, actor: OTHER_ACTOR }) });
      try {
        expectStillHeld(held, PIN_KEPT);
      } finally {
        await held.f.daemon.stop();
      }
    });

    it("while the owner has suspended the project", async () => {
      const held = await heldForCeoThenClaimed({
        afterPause: async (f) => {
          const suspended = await f.harness.cp.cto.suspendProject(f.projectId, true, "owner stop", undefined, "test-owner");
          expect(suspended.allowed, JSON.stringify(suspended)).toBe(true);
        },
      });
      try {
        expectStillHeld(held, "the run's project is suspended");
      } finally {
        await held.f.daemon.stop();
      }
    });

    it("while a task execution of the run is RUNNING", async () => {
      const held = await heldForCeoThenClaimed({
        beforePause: (f) => {
          const tasks = f.harness.cp.tasks.submit(f.runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
          if (!tasks.allowed) throw new Error(tasks.message);
          const task = f.harness.cp.tasks.ready(f.runId)[0]!;
          const workerSessionId = bindWorker(f.harness, task.taskId);
          const execution = f.harness.cp.tasks.startExecution({
            runId: f.runId, taskId: task.taskId, ownerBindingGeneration: 1, workerSessionId,
            provider: "scripted", model: "scripted-worker",
          });
          if (!execution.allowed) throw new Error(execution.message);
        },
      });
      try {
        expectStillHeld(held, "the predecessor generation still has a RUNNING task execution on the run");
      } finally {
        await held.f.daemon.stop();
      }
    });

    it("when the live owner's role changed its binding under the hold, with no hand-over", async () => {
      const f = await deadOwnerUnderDaemon({ ownerDies: false });
      try {
        const failover = loseCeo(f);
        try {
          await f.daemon.reconcileContinuity("test: the CEO is lost");
        } finally {
          failover.mockRestore();
        }
        expect(f.harness.cp.runs.require(f.runId)).toMatchObject({ state: RunState.BLOCKED, continuityHoldRoleKey: CEO });
        expect(f.harness.cp.bindings.active(f.roleKey)?.bindingGeneration).toBe(1);
        // The owner is pinned and READY; only its role's binding record moved after the pause.
        f.harness.cp.audit.record({
          kind: "BINDING_RENEWED", roleKey: f.roleKey, sessionId: f.sessionId, evidence: { generation: 1 },
        });
        readoptCeo(f);
        const pass = await f.daemon.reconcileContinuity("test: the CEO is bound again");
        expect(pass?.continuityHolds).toEqual({
          released: [],
          kept: [{ runId: f.runId, why: expect.stringMatching(/^another role this run depends on changed its binding under the hold: BINDING_RENEWED /) }],
        });
        expect(f.owner()).toEqual({ owner_session_id: f.sessionId, owner_binding_generation: 1, state: RunState.BLOCKED });
        expect(f.handOvers()).toEqual([]);
      } finally {
        await f.daemon.stop();
      }
    });
  });
});
