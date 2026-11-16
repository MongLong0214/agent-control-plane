import { afterAll, describe, expect, it } from "vitest";

import { type Decision, allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { executeCanonicalSelfClaimOperator } from "../../src/daemon/canonical-self-claim-operator.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import {
  type CanonicalAdoptableSession,
  type CanonicalSelfClaimReceipt,
  type ProcessSnapshot,
  hostSessionRegistryAbsent,
} from "../../src/registry/canonical-self-claim.ts";
import { CanonicalSessionRegistry } from "../../src/registry/canonical-session-registry.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * The Logic Pro CTO on 2026-11-16: the project's entitlement was transferred from the conversation it was configured
 * for to the one running now, which claimed generation 2; that runtime died, generation 2 was revoked, and the same
 * conversation, relaunched, asked for generation 2 again because its relay's argv still said so. Six refusals, each
 * recorded as a bare CONFLICT. The relaunched conversation is entitled and its predecessor is dead, so generation 3 —
 * the role's highest + 1, which is what an `auto` relay reads — is its to take, and nothing else about it changes.
 */

const CONFIGURED = "23efeb04-0000-4000-8000-000000000001";
const CTO = "04a1b7e9-0000-4000-8000-000000000002";
const STRANGER = "88888888-0000-4000-8000-000000000003";
const CWD = "/work/logic";
const ROOM = "6dcb2a67-0000-4000-8000-00000000000a";
const CTO_ACTOR = "buzz:logic-cto";
const PEER_PROTOCOL = "mcp/2025-06-18";
const PEER_UID = 501;

/** The relay (pid 100) under a shell (50) under the claude process `pid` of conversation `uuid`. */
const claudeOf = (uuid: string, pid: number): ProcessSnapshot[] => [
  { pid: 100, ppid: 50, argv: ["/usr/bin/node", "/opt/acp/agentctl.js", "attach"], command: "node agentctl.js attach", cwd: CWD, cwdProbeFailure: null, startedAt: "t1" },
  { pid: 50, ppid: pid, argv: ["/bin/zsh", "-c", "relay"], command: "/bin/zsh -c relay", cwd: CWD, cwdProbeFailure: null, startedAt: "t2" },
  { pid, ppid: 1, argv: ["/opt/claude/claude", "--resume", uuid], command: `/opt/claude/claude --resume ${uuid}`, cwd: CWD, cwdProbeFailure: null, startedAt: `start-${pid}` },
];

const world = async () => {
  const harness = makeHarness();
  const { projectId } = await registerFixtureProject(harness);
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
  const { db } = harness.cp;
  const configured: CanonicalAdoptableSession[] = [{ sessionUuid: CONFIGURED, projectId, buzzActorId: CTO_ACTOR, buzzAddress: ROOM }];
  const registry = new CanonicalSessionRegistry(db);
  for (const entry of registry.effective(configured)) registry.grant({ ...entry, buzzAddress: entry.buzzAddress ?? ROOM }, null);
  /** The claude processes still running, by pid. A pid not here answers ESRCH and has no snapshot. */
  const alive = new Map<number, ProcessSnapshot>();

  const claimAs = (uuid: string, generation: number, pid: number): Promise<Decision<CanonicalSelfClaimReceipt>> => {
    const chain = claudeOf(uuid, pid);
    alive.set(pid, chain[2]!);
    const snapshot = (p: number) => chain.find((entry) => entry.pid === p) ?? alive.get(p) ?? null;
    return executeCanonicalSelfClaimOperator({ peerPid: 100, uid: PEER_UID }, { claimedSessionUuid: uuid, projectId, expectedBindingGeneration: generation }, {
      db, clock: harness.clock, audit: harness.cp.audit, sessions: harness.cp.sessions, bindings: harness.cp.bindings,
      buzzActorAuthenticator: { isAllowedActor: () => true },
      resolveBuzzAddress: async (): Promise<Decision<string>> => allow(ReasonCode.OK, ROOM),
      config: {
        canonicalSessions: configured, canonicalBuzzChannelId: ROOM, expectedPeerProtocolVersion: PEER_PROTOCOL,
        expectedPeerIdentity: `uid:${PEER_UID}`, peerProtocolVersion: PEER_PROTOCOL, buzzPurpose: "continuity:PRIMARY_CTO",
      },
      claimDeps: {
        processInspector: { snapshot },
        imageInspector: { resolve: () => ({ imagePath: "/fake/claude", version: "0.0.0-test", sha256: `sha256:${"0".repeat(64)}` }) },
        transcriptReader: { locate: (u) => ({ path: `/fake/transcripts/${u}.jsonl`, sizeBytes: 42 }) },
        hostSessionRegistryReader: { read: (p) => hostSessionRegistryAbsent(`/fake/sessions/${p}.json is absent`) },
        processSignal: (p) => {
          if (snapshot(p) === null) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
        },
      },
    });
  };
  /** The runtime at `pid` exits; the daemon's reconcile marks its row ERROR, as it did live. */
  const dies = (pid: number, sessionId: string) => {
    alive.delete(pid);
    const errored = harness.cp.sessions.transition(sessionId, SessionLifecycle.ERROR, "session process is dead");
    if (!errored.allowed) throw new Error(JSON.stringify(errored));
  };
  const revoke = (reason: string) => {
    const revoked = harness.cp.bindings.revoke(roleKey, reason);
    if (!revoked.allowed) throw new Error(JSON.stringify(revoked));
  };
  const refusalRows = () => db.all<{ reason_code: string; evidence_json: string }>(
    `SELECT reason_code, evidence_json FROM audit_events WHERE kind = 'CANONICAL_SELF_CLAIM_REFUSED' ORDER BY event_id`,
  ).map((row) => ({ reasonCode: row.reason_code, evidence: JSON.parse(row.evidence_json) as Record<string, unknown> }));
  const generations = () => db.all<{ binding_generation: number; status: string }>(
    `SELECT binding_generation, status FROM assignments WHERE role_key = ? ORDER BY binding_generation`, [roleKey]);

  // gen1: the configured conversation, later revoked for capacity, its runtime gone.
  const first = await claimAs(CONFIGURED, 1, 11);
  if (!first.allowed) throw new Error(JSON.stringify(first));
  revoke("coverage plan cannot staff the bound role");
  dies(11, first.value.sessionId);
  // The CEO moves the entitlement to the conversation that runs now; its claim of gen2 consumes the transfer.
  const transferred = db.tx(() => registry.transfer({ projectId, fromSessionUuid: CONFIGURED, toSessionUuid: CTO, expectedBindingGeneration: 1 },
    "ceo:test", harness.clock.nowIso()));
  if (!transferred.allowed) throw new Error(JSON.stringify(transferred));
  const second = await claimAs(CTO, 2, 22);
  if (!second.allowed) throw new Error(JSON.stringify(second));
  expect(registry.effective(configured).map((entry) => entry.sessionUuid)).toEqual([CTO]);
  return { harness, db, roleKey, registry, configured, claimAs, dies, revoke, refusalRows, generations, second };
};

describe("a relaunched canonical CTO whose binding was lost takes the next generation by itself", () => {
  it("the Logic shape — same conversation, gen1 and gen2 revoked, its old pid dead — claims gen 3; asking for 2 is refused by name", async () => {
    const w = await world();
    w.dies(22, w.second.value.sessionId);
    w.revoke("the bound runtime was lost and continuity did not fail it over");
    expect(w.generations()).toEqual([{ binding_generation: 1, status: "REVOKED" }, { binding_generation: 2, status: "REVOKED" }]);

    // What the live relay sent: its argv still said 2. Refused, and the row says why and with which numbers.
    const stale = await w.claimAs(CTO, 2, 33);
    expect(stale).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT, evidence: { reason: "GENERATION_MISMATCH" } });
    expect(w.refusalRows()).toEqual([{
      reasonCode: ReasonCode.CONFLICT,
      evidence: { identity: CTO, reason: "GENERATION_MISMATCH", expectedGeneration: 2, nextGeneration: 3 },
    }]);

    // What an auto relay reads and sends: the role's highest + 1.
    const claimed = await w.claimAs(CTO, 3, 33);
    expect(claimed.allowed, JSON.stringify(claimed)).toBe(true);
    if (!claimed.allowed) return;
    expect(claimed.value.binding.bindingGeneration).toBe(3);
    expect(w.harness.cp.bindings.active(w.roleKey)?.sessionId).toBe(claimed.value.sessionId);
    expect(w.harness.cp.sessions.require(claimed.value.sessionId).osPid).toBe(33);
    // The entitlement did not move and was not re-settled: the claimed transfer still names this conversation.
    expect(w.registry.effective(w.configured).map((entry) => entry.sessionUuid)).toEqual([CTO]);
    expect(w.db.all(`SELECT claimed_binding_generation, revoked_at FROM canonical_entitlement_transfers`))
      .toEqual([{ claimed_binding_generation: 2, revoked_at: null }]);
  });

  it("a dead predecessor whose binding is still ACTIVE is released by the same claim of gen 3", async () => {
    const w = await world();
    w.dies(22, w.second.value.sessionId);
    const claimed = await w.claimAs(CTO, 3, 33);
    expect(claimed.allowed, JSON.stringify(claimed)).toBe(true);
    expect(w.generations()).toEqual([
      { binding_generation: 1, status: "REVOKED" }, { binding_generation: 2, status: "REVOKED" }, { binding_generation: 3, status: "ACTIVE" },
    ]);
  });

  it("a live incumbent, the superseded conversation and a stranger are still refused, each by name", async () => {
    const w = await world();
    // gen2's claude (pid 22) is alive and ACTIVE: a second process of the same conversation is not its successor.
    const live = await w.claimAs(CTO, 3, 55);
    expect(live).toMatchObject({ allowed: false, reasonCode: ReasonCode.BINDING_ALREADY_ACTIVE, evidence: { reason: "PREDECESSOR_RUNTIME_ALIVE" } });
    // The conversation the entitlement was transferred away from, and one never entitled.
    const superseded = await w.claimAs(CONFIGURED, 3, 66);
    expect(superseded).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT, evidence: { reason: "SESSION_NOT_ENTITLED" } });
    const stranger = await w.claimAs(STRANGER, 3, 77);
    expect(stranger).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT, evidence: { reason: "SESSION_NOT_ENTITLED" } });
    expect(w.refusalRows().map((row) => [row.reasonCode, row.evidence["reason"]])).toEqual([
      [ReasonCode.BINDING_ALREADY_ACTIVE, "PREDECESSOR_RUNTIME_ALIVE"],
      [ReasonCode.CONFLICT, "SESSION_NOT_ENTITLED"],
      [ReasonCode.CONFLICT, "SESSION_NOT_ENTITLED"],
    ]);
    expect(w.harness.cp.bindings.active(w.roleKey)?.sessionId).toBe(w.second.value.sessionId);
  });
});
