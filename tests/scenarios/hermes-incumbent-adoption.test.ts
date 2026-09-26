import { afterAll, expect, it, vi } from "vitest";
import { deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { processStartedAt } from "../../src/core/process-identity.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { createHermesIncumbentAdoption } from "../../src/bootstrap/hermes-incumbent-adoption.ts";
import { runHermesTargetBind, type HermesTargetBindResponse } from "../../src/runtime/hermes-target-bind.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

it("refuses an asynchronously missing Gateway origin before writing a session", async () => {
  const h = makeHarness();
  try {
    const dead = h.cp.sessions.create({ provider: "hermes", model: "old", osPid: 2147483647 });
    expect(h.cp.sessions.transition(dead.sessionId, SessionLifecycle.READY).allowed).toBe(true);
    expect(h.cp.bindings.bind({ role: Role.CEO, sessionId: dead.sessionId }).allowed).toBe(true);
    const actor = h.cp.db.get<{ actor_id: string }>("SELECT actor_id FROM assignments WHERE role_key = 'CEO'");
    expect(h.cp.bindings.revoke("CEO", "dead incumbent").allowed).toBe(true);
    expect(h.cp.sessions.transition(dead.sessionId, SessionLifecycle.ERROR).allowed).toBe(true);
    const before = h.cp.sessions.list();
    const beforeAssignments = h.cp.db.all("SELECT assignment_id FROM assignments");
    const token = readProcessStartToken(process.pid);
    expect(token).not.toBeNull();
    const adoption = createHermesIncumbentAdoption(h.cp, {
      gatewayOrigin: async () => null,
      target: { sessionId: "canonical", lineageRootDigest: `sha256:${"a".repeat(64)}` },
      expectedLiveSessionId: "live-head",
      hermesExecutable: "unused", hermesProfile: "unused", hermesHome: "unused",
      executorRuntimeIdentity: "unused",
    });
    const result = await adoption.adopt({ gatewayPid: process.pid, gatewayStartToken: token! });
    expect(result.allowed).toBe(false);
    expect(h.cp.sessions.list()).toEqual(before);
    expect(h.cp.db.all("SELECT assignment_id FROM assignments")).toEqual(beforeAssignments);
    expect(h.cp.bindings.active("CEO")).toBeNull();
    expect(h.cp.db.all("SELECT actor_id FROM conversational_actors")).toEqual([actor]);
  } finally {
    h.cp.close();
  }
});

it.each([[true, false, false, false, false], [false, false, false, false, false],
  [true, true, false, false, false], [false, true, false, false, false],
  [true, false, true, false, false], [true, true, false, true, false],
  [true, true, false, false, true]])(
  "adopts only the pinned live head (prior target: %s, switches during readback: %s, actor drift: %s, competing bind: %s, blocked revoke: %s)", async (priorTarget, switchesDuringReadback, actorDrift, competingBind, blockedRevoke) => {
  const h = makeHarness();
  const home = tempDir("acp-adopt-target-");
  symlinkSync(process.execPath, join(home, "node"));
  writeFileSync(join(home, "producer.mjs"), `
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
`);
  try {
    const pinned = { sessionId: "pinned-binding", lineageRootDigest: `sha256:${"a".repeat(64)}` };
    const liveHead = "live-descendant-head";
    const hermesExecutable = new URL("../fixtures/hermes-target-bind-producer.sh", import.meta.url).pathname;
    const dead = h.cp.sessions.create({ provider: "hermes", model: "old", osPid: 2147483647 });
    expect(h.cp.sessions.transition(dead.sessionId, SessionLifecycle.READY).allowed).toBe(true);
    let initialReceipt: HermesTargetBindResponse | null = null;
    const claimed = { executorKind: "hermes", targetLocator: pinned.sessionId, targetLocatorDigest: pinned.lineageRootDigest };
    const old = h.cp.bindings.bind({ role: Role.CEO, sessionId: dead.sessionId,
      ...(priorTarget ? { authenticatedTarget: {
        claimed, protocolVersion: "hermes.target-bind/v1", expectedExecutorRuntimeIdentity: "fixture-runtime",
        get targetBindReceipt() { return initialReceipt; },
        get attestationDigest() { return initialReceipt?.receipt_digest ?? ""; },
        verify: (tuple) => {
          const bound = runHermesTargetBind({ hermesExecutable, hermesHome: home, hermesProfile: "fixture",
            sessionId: pinned.sessionId, expectedLineageRootDigest: pinned.lineageRootDigest,
            actorId: tuple.actorId, bindingGeneration: tuple.generation, executorRuntimeIdentity: "fixture-runtime" });
          if (!bound.allowed) return null;
          initialReceipt = bound.value;
          return claimed;
        },
      } } : {}),
    });
    expect(old.allowed).toBe(true);
    if (!old.allowed) return;
    const previous = h.cp.db.get<{ actor_id: string; binding_generation: number }>(
      "SELECT actor_id, binding_generation FROM assignments WHERE role_key = 'CEO'",
    )!;
    expect(h.cp.db.all("SELECT target_actor_id FROM actor_target_bindings")).toHaveLength(priorTarget ? 1 : 0);
    expect(h.cp.bindings.revoke("CEO", "dead incumbent").allowed).toBe(true);
    expect(h.cp.sessions.transition(dead.sessionId, SessionLifecycle.ERROR).allowed).toBe(true);
    const driftSession = actorDrift
      ? h.cp.sessions.create({ provider: "hermes", model: "drift-fixture", osPid: process.pid }) : null;
    const beforeSessions = h.cp.sessions.list();
    const beforeAssignments = h.cp.db.all<{ assignment_id: string }>("SELECT assignment_id FROM assignments");

    const token = readProcessStartToken(process.pid);
    const startedAt = processStartedAt(process.pid);
    expect(token).not.toBeNull();
    expect(startedAt).not.toBeNull();
    const validProof = { session_id: liveHead, lineage_root_digest: pinned.lineageRootDigest,
      process_pid: process.pid, process_started_at: token! };
    for (const invalid of [
      { ...validProof, process_pid: 2147483647 },
      { ...validProof, process_started_at: "darwin-tv:0.000000" },
      { ...validProof, session_id: "" },
      { ...validProof, session_id: "new-conversation-same-lineage" },
      { ...validProof, lineage_root_digest: `sha256:${"b".repeat(64)}` },
    ]) {
      const beforeSessions = h.cp.sessions.list();
      const beforeAssignments = h.cp.db.all("SELECT assignment_id FROM assignments");
      const rejected = await createHermesIncumbentAdoption(h.cp, {
        gatewayOrigin: async () => invalid, target: pinned, expectedLiveSessionId: liveHead, hermesExecutable,
        hermesProfile: "fixture", hermesHome: home, executorRuntimeIdentity: "fixture-runtime",
      }).adopt({ gatewayPid: process.pid, gatewayStartToken: token! });
      expect(rejected.allowed).toBe(false);
      expect(h.cp.sessions.list()).toEqual(beforeSessions);
      expect(h.cp.db.all("SELECT assignment_id FROM assignments")).toEqual(beforeAssignments);
    }
    let proofReads = 0;
    let sawBindingDuringReadback = false;
    let revokeCalls = 0;
    let competingAssignmentId: string | null = null;
    let competitorSessionId: string | null = null;
    const adoption = createHermesIncumbentAdoption(h.cp, {
      gatewayOrigin: async () => {
        proofReads++;
        // An asynchronous Gateway readback must not expose a provisional CEO to run dispatch.
        if (proofReads > 1 && blockedRevoke) sawBindingDuringReadback = h.cp.bindings.active("CEO") !== null;
        if (proofReads > 1 && competingBind) {
          const competitor = h.cp.sessions.create({ provider: "hermes", model: "competitor", osPid: process.pid,
            osStartedAt: startedAt! });
          competitorSessionId = competitor.sessionId;
          expect(h.cp.sessions.transition(competitor.sessionId, SessionLifecycle.READY).allowed).toBe(true);
          const replacement = h.cp.bindings.bind({ role: Role.CEO, sessionId: competitor.sessionId });
          expect(replacement.allowed).toBe(true);
          if (replacement.allowed) {
            competingAssignmentId = replacement.value.assignmentId;
          }
        }
        if (proofReads > 1 && blockedRevoke) vi.spyOn(h.cp.bindings, "revoke").mockImplementationOnce(() => {
          revokeCalls++;
          return deny(ReasonCode.REVOCATION_BLOCKED_ACTIVE_RUNS, "live runs prevent revocation", {});
        });
        if (proofReads > 1 && actorDrift) {
          h.cp.db.run("UPDATE conversational_actors SET current_session_id = ? WHERE actor_id = ?",
            [driftSession!.sessionId, previous.actor_id]);
          expect(h.cp.db.get<{ current_session_id: string }>(
            "SELECT current_session_id FROM conversational_actors WHERE actor_id = ?", [previous.actor_id],
          )?.current_session_id).toBe(driftSession!.sessionId);
        }
        return proofReads > 1 && switchesDuringReadback
          ? { ...validProof, session_id: "new-conversation-same-lineage" } : validProof;
      },
      target: pinned,
      expectedLiveSessionId: liveHead,
      hermesExecutable,
      hermesProfile: "fixture", hermesHome: home, executorRuntimeIdentity: "fixture-runtime",
    });
    const result = await adoption.adopt({ gatewayPid: process.pid, gatewayStartToken: token! });
    if (blockedRevoke) expect(sawBindingDuringReadback).toBe(false);
    if (switchesDuringReadback || actorDrift) {
      expect(result.allowed).toBe(false);
      expect(result.evidence).toEqual({});
      expect(h.cp.sessions.list().filter((session) => session.sessionId !== competitorSessionId))
        .toEqual(beforeSessions);
      expect(h.cp.db.all<{ assignment_id: string }>("SELECT assignment_id FROM assignments")
        .filter((assignment) => assignment.assignment_id !== competingAssignmentId)).toEqual(beforeAssignments);
      expect(h.cp.db.get("SELECT assignment_id FROM assignments WHERE role_key = 'CEO' AND actor_id = ? AND binding_generation = ?",
        [previous.actor_id, previous.binding_generation + 1])).toBeUndefined();
      if (competingBind) expect(h.cp.bindings.active("CEO")?.assignmentId).toBe(competingAssignmentId);
      else expect(h.cp.bindings.active("CEO")).toBeNull();
      if (blockedRevoke) {
        expect(sawBindingDuringReadback).toBe(false);
        expect(revokeCalls).toBe(0);
      }
      expect(proofReads).toBeGreaterThan(1);
      return;
    }
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.value.bindingGeneration).toBe(previous.binding_generation + 1);
    expect(result.value.actorId).toBe(previous.actor_id);
    expect(result.value.sessionId).not.toBe(dead.sessionId);
    expect(h.cp.sessions.get(result.value.sessionId)).toMatchObject({
      osPid: process.pid, osProcessStartedAt: startedAt, lifecycle: SessionLifecycle.READY,
    });
    expect(h.cp.bindings.active("CEO")).toMatchObject({
      sessionId: result.value.sessionId, bindingGeneration: result.value.bindingGeneration,
    });
    expect(h.cp.db.get("SELECT actor_id FROM assignments WHERE role_key = 'CEO' AND binding_generation = ?",
      [result.value.bindingGeneration])).toEqual({ actor_id: previous.actor_id });
    expect(h.cp.db.get("SELECT current_session_id, current_session_incarnation FROM conversational_actors WHERE actor_id = ?",
      [previous.actor_id])).toEqual({ current_session_id: result.value.sessionId,
      current_session_incarnation: result.value.sessionIncarnation });
    const receipt = h.cp.db.get<{ target_bind_receipt_json: string }>(
      "SELECT target_bind_receipt_json FROM actor_target_attestations WHERE binding_generation = ?",
      [result.value.bindingGeneration],
    );
    expect(JSON.parse(receipt!.target_bind_receipt_json)).toMatchObject({
      actor_id: previous.actor_id, requested_session_id: liveHead,
      lineage_root_digest: pinned.lineageRootDigest, executor_runtime_identity: "fixture-runtime",
    });
    expect(h.cp.db.all("SELECT actor_id FROM conversational_actors")).toEqual([{ actor_id: previous.actor_id }]);
  } finally {
    h.cp.close();
  }
});
