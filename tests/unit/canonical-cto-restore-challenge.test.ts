import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { CanonicalCtoRestoreCondition, type CanonicalCtoRestoreTarget } from "../../src/continuity/continuity-kernel.ts";
import {
  CANONICAL_CTO_RESTORE_CHALLENGE_PREFIX,
  CANONICAL_CTO_RESTORE_SUCCESSION_METHOD,
  createCanonicalCtoAttachChallenger,
  takeRestoreChallengeAnswer,
  type ReattachConnection,
} from "../../src/daemon/agentcpd.ts";
import { hostSessionRegistryAbsent, type ProcessAncestryInspector, type ProcessSnapshot } from "../../src/registry/canonical-self-claim.ts";
import type { CanonicalCtoAdmission } from "../../src/registry/canonical-cto-reattach.ts";
import type { ProcessLineageReader } from "../../src/session/runtime-lineage.ts";
import type { RoleBinding } from "../../src/domain/types.ts";
import {
  canonicalCtoFixture,
  CONVERSATION,
  CTO,
  PROJECT,
  RELAY,
  type CanonicalCtoFixture,
} from "../helpers/canonical-cto-reattach.ts";

/**
 * #1106 — the capacity restore's liveness challenge, on the door's own connection records: an answer
 * is taken once, only from the connection the challenge was written on, only before it expires, and
 * only as a result. The process-level file drives the same code through the real door and relay;
 * these are the cases a live relay cannot be made to produce on demand.
 */

const CHALLENGE_TIMEOUT_MS = 400;

const fixtures: CanonicalCtoFixture[] = [];
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const made of fixtures.splice(0)) made.h.cp.close();
});

/** A real accepted socket, so `destroyed` and `destroy()` are the kernel's, not a stand-in's. */
const acceptedSocket = async (): Promise<Socket> => {
  const dir = mkdtempSync("/tmp/acprc-");
  const path = join(dir, "s.sock");
  const accepted = new Promise<Socket>((resolve) => {
    const server: Server = createServer((socket) => {
      socket.on("error", () => undefined);
      resolve(socket);
    });
    server.listen(path);
    cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
  });
  const client = createConnection(path);
  client.on("error", () => undefined);
  cleanups.push(() => {
    client.destroy();
    rmSync(dir, { recursive: true, force: true });
  });
  return accepted;
};

const subject = async () => {
  const f = canonicalCtoFixture();
  fixtures.push(f);
  const inspector: ProcessAncestryInspector = {
    readStartToken: (pid) => f.processes.get(pid)?.startedAt ?? null,
    snapshot: (pid): ProcessSnapshot | null => {
      const stated = f.processes.get(pid);
      if (!stated) return null;
      return {
        pid,
        ppid: stated.ppid,
        command: stated.argv.join(" "),
        cwd: "/Users/fixture/work",
        cwdProbeFailure: null,
        startedAt: stated.startedAt,
        argv: stated.argv,
      };
    },
  };
  const processes: ProcessLineageReader = {
    parentOf: (pid) => f.processes.get(pid)?.ppid ?? null,
    startToken: (pid) => f.processes.get(pid)?.startedAt ?? null,
  };
  const registryReader = { read: () => hostSessionRegistryAbsent("absent") };
  const admitted = f.reattach().admit({ peerPid: RELAY, uid: process.getuid?.() ?? 0 });
  if (!admitted.allowed) throw new Error(admitted.message);
  const binding = f.h.cp.bindings.active(CTO)!;
  expect(f.h.cp.bindings.revoke(CTO, "fixture revocation").allowed).toBe(true);
  const target: CanonicalCtoRestoreTarget = {
    roleKey: CTO,
    projectId: PROJECT,
    revokedAssignmentId: binding.assignmentId,
    revokedGeneration: binding.bindingGeneration,
    revokedAt: f.h.clock.nowIso(),
    revokeEventId: 0,
    actorId: admitted.value.actorId,
    sessionId: f.sessionId,
    sessionIncarnation: binding.sessionIncarnation,
    conversation: CONVERSATION,
    provider: "claude",
  };
  const connections = new Set<ReattachConnection>();
  const connection = async (admission: CanonicalCtoAdmission) => {
    const socket = await acceptedSocket();
    const sent: JSONRPCMessage[] = [];
    const record: ReattachConnection = {
      connectionId: `conn-${connections.size + 1}`,
      peer: { peerPid: RELAY, uid: process.getuid?.() ?? 0 },
      admitted: admission,
      socket,
      closed: false,
      challenges: new Map(),
      send: async (message) => {
        sent.push(message);
      },
    };
    connections.add(record);
    return { record, sent };
  };
  const challenger = createCanonicalCtoAttachChallenger(f.h.cp, connections, {
    processes,
    inspector,
    registryReader,
    challengeTimeoutMs: CHALLENGE_TIMEOUT_MS,
  });
  return { f, admitted: admitted.value, target, connections, connection, challenger };
};

const idOf = (ping: JSONRPCMessage): string | number => {
  const id = "id" in ping ? ping.id : undefined;
  if (typeof id !== "string" && typeof id !== "number") throw new Error("the challenge carries no id");
  return id;
};

const answerTo = (ping: JSONRPCMessage): JSONRPCMessage => ({ jsonrpc: "2.0", id: idOf(ping), result: {} });

const until = async (condition: () => boolean, budgetMs = 2_000): Promise<boolean> => {
  for (const started = Date.now(); Date.now() - started < budgetMs;) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return condition();
};

describe("#1106: the capacity restore's liveness challenge", () => {
  it("is a ping whose id names the challenge, taken from the connection it was written on", async () => {
    const s = await subject();
    const x = await s.connection(s.admitted);
    const proving = s.challenger.challenge(s.target);
    expect(await until(() => x.sent.length === 1)).toBe(true);
    const ping = x.sent[0]!;
    expect(ping).toMatchObject({ jsonrpc: "2.0", method: "ping" });
    expect("id" in ping && String(ping.id).startsWith(CANONICAL_CTO_RESTORE_CHALLENGE_PREFIX)).toBe(true);
    expect(takeRestoreChallengeAnswer(x.record, answerTo(ping))).toBe(true);
    const proof = await proving;
    expect(proof.allowed).toBe(true);
    expect(proof.allowed && proof.value.connectionId).toBe(x.record.connectionId);
  });

  it("refuses an answer delivered on another connection, even one carrying the challenge's own id", async () => {
    const s = await subject();
    // An earlier connection, admitted under the binding before this one: not the challenged one.
    const earlier = await s.connection({ ...s.admitted, assignmentId: "assignment-before", bindingGeneration: 0 });
    const x = await s.connection(s.admitted);
    const proving = s.challenger.challenge(s.target);
    expect(await until(() => x.sent.length === 1)).toBe(true);
    expect(earlier.sent).toEqual([]);
    expect(takeRestoreChallengeAnswer(earlier.record, answerTo(x.sent[0]!))).toBe(true);
    const refused = await proving;
    expect(refused.allowed).toBe(false);
    expect(refused.evidence).toMatchObject({ condition: CanonicalCtoRestoreCondition.LIVENESS_CHALLENGE_FAILED });
  });

  it("takes an answer once: a replay settles nothing and does not answer a later challenge", async () => {
    const s = await subject();
    const x = await s.connection(s.admitted);
    const first = s.challenger.challenge(s.target);
    expect(await until(() => x.sent.length === 1)).toBe(true);
    const answer = answerTo(x.sent[0]!);
    takeRestoreChallengeAnswer(x.record, answer);
    expect((await first).allowed).toBe(true);
    expect(x.record.challenges.size).toBe(0);

    const second = s.challenger.challenge(s.target);
    expect(await until(() => x.sent.length === 2)).toBe(true);
    expect(x.sent[1]).not.toEqual(x.sent[0]);
    expect(takeRestoreChallengeAnswer(x.record, answer)).toBe(true);
    const refused = await second;
    expect(refused.allowed).toBe(false);
    expect(refused.evidence).toMatchObject({ condition: CanonicalCtoRestoreCondition.LIVENESS_CHALLENGE_FAILED });
  });

  it("refuses an answer that arrives after the challenge expired by the daemon's clock", async () => {
    const s = await subject();
    const x = await s.connection(s.admitted);
    const proving = s.challenger.challenge(s.target);
    expect(await until(() => x.sent.length === 1)).toBe(true);
    s.f.h.clock.advance(CHALLENGE_TIMEOUT_MS + 1);
    takeRestoreChallengeAnswer(x.record, answerTo(x.sent[0]!));
    const refused = await proving;
    expect(refused.allowed).toBe(false);
    expect(refused.evidence).toMatchObject({ condition: CanonicalCtoRestoreCondition.LIVENESS_CHALLENGE_FAILED });
  });

  it("refuses an error answered in place of a result", async () => {
    const s = await subject();
    const x = await s.connection(s.admitted);
    const proving = s.challenger.challenge(s.target);
    expect(await until(() => x.sent.length === 1)).toBe(true);
    const ping = x.sent[0]!;
    takeRestoreChallengeAnswer(x.record, { jsonrpc: "2.0", id: idOf(ping), error: { code: -32601, message: "no" } });
    expect((await proving).evidence).toMatchObject({ condition: CanonicalCtoRestoreCondition.LIVENESS_CHALLENGE_FAILED });
  });

  it("never chooses between two open connections admitted under the revoked binding", async () => {
    const s = await subject();
    const x = await s.connection(s.admitted);
    const y = await s.connection(s.admitted);
    const refused = await s.challenger.challenge(s.target);
    expect(refused.allowed).toBe(false);
    expect(refused.evidence).toMatchObject({ condition: CanonicalCtoRestoreCondition.LIVENESS_CHALLENGE_FAILED });
    expect([...x.sent, ...y.sent]).toEqual([]);
  });

  it("names no connection when none is open under the revoked binding", async () => {
    const s = await subject();
    const x = await s.connection(s.admitted);
    x.record.closed = true;
    expect(s.challenger.connected(s.target)).toBe(false);
    const refused = await s.challenger.challenge(s.target);
    expect(refused.evidence).toMatchObject({ condition: CanonicalCtoRestoreCondition.NO_REATTACH_CONNECTION });
  });

  it("an answered challenge's proof stops holding once its connection ends", async () => {
    const s = await subject();
    const x = await s.connection(s.admitted);
    const proving = s.challenger.challenge(s.target);
    expect(await until(() => x.sent.length === 1)).toBe(true);
    takeRestoreChallengeAnswer(x.record, answerTo(x.sent[0]!));
    const proof = await proving;
    if (!proof.allowed) throw new Error(proof.message);
    expect(proof.value.stillAttached().allowed).toBe(true);
    x.record.socket.destroy();
    expect(proof.value.stillAttached().evidence).toMatchObject({ condition: CanonicalCtoRestoreCondition.ATTACH_TARGET_NOT_LIVE });
  });

  it("on release writes the one succession it proved on that connection and ends it (review S2B-R1-01)", async () => {
    const s = await subject();
    const x = await s.connection(s.admitted);
    const proving = s.challenger.challenge(s.target);
    expect(await until(() => x.sent.length === 1)).toBe(true);
    takeRestoreChallengeAnswer(x.record, answerTo(x.sent[0]!));
    const proof = await proving;
    if (!proof.allowed) throw new Error(proof.message);
    expect(proof.value.challengeId).toBe(idOf(x.sent[0]!));
    const restored = {
      ...s.f.h.cp.bindings.active(CTO),
      roleKey: CTO,
      assignmentId: "restored-assignment",
      bindingGeneration: s.admitted.bindingGeneration + 1,
      sessionId: s.admitted.sessionId,
      sessionIncarnation: s.admitted.sessionIncarnation,
    } as RoleBinding;
    proof.value.release(restored);
    expect(await until(() => x.record.socket.destroyed)).toBe(true);
    expect(x.sent).toHaveLength(2);
    expect(x.sent[1]).toEqual({
      jsonrpc: "2.0",
      method: CANONICAL_CTO_RESTORE_SUCCESSION_METHOD,
      params: {
        from: {
          roleKey: CTO,
          assignmentId: s.admitted.assignmentId,
          bindingGeneration: s.admitted.bindingGeneration,
          sessionId: s.admitted.sessionId,
          sessionIncarnation: s.admitted.sessionIncarnation,
        },
        to: {
          roleKey: CTO,
          assignmentId: "restored-assignment",
          bindingGeneration: s.admitted.bindingGeneration + 1,
          sessionId: s.admitted.sessionId,
          sessionIncarnation: s.admitted.sessionIncarnation,
        },
        challengeId: idOf(x.sent[0]!),
      },
    });
  });
});
