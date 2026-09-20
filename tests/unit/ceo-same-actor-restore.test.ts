import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { digestOf } from "../../src/core/digest.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import * as liveness from "../../src/daemon/dead-binding-recovery.ts";
import type { AuthenticatedTargetBinding, AuthenticatedTargetTuple, BindInput } from "../../src/session/binding-registry.ts";
import { makeHarness } from "../helpers/harness.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const { cp } = makeHarness();
  const old = cp.sessions.create({ provider: "hermes", model: "test", osPid: 12345 });
  cp.sessions.transition(old.sessionId, SessionLifecycle.READY, "fixture");
  const first = cp.bindings.bind({ role: Role.CEO, sessionId: old.sessionId });
  if (!first.allowed) throw new Error("fixture bind refused");
  const actorId = cp.db.get<{ actor_id: string }>("SELECT actor_id FROM assignments WHERE assignment_id = ?", [first.value.assignmentId])!.actor_id;
  cp.bindings.revoke("CEO", "runtime died");
  cp.sessions.transition(old.sessionId, SessionLifecycle.ERROR, "runtime died");
  const replacement = cp.sessions.create({ provider: "hermes", model: "test", osPid: process.pid });
  cp.sessions.transition(replacement.sessionId, SessionLifecycle.READY, "replacement");
  vi.spyOn(liveness, "probeSessionLiveness").mockImplementation((pid) => pid === process.pid ? "ALIVE" : "DEAD");
  const claimed = { executorKind: "hermes", targetLocator: "canonical-session", targetLocatorDigest: digestOf({ root: "canonical" }) };
  let receipt: unknown;
  const authenticatedTarget: AuthenticatedTargetBinding = {
    claimed, protocolVersion: "hermes.target-bind/v1", expectedExecutorRuntimeIdentity: "runtime:test",
    get targetBindReceipt() { return receipt; },
    get attestationDigest() { return (receipt as { receipt_digest: string }).receipt_digest; },
    verify(tuple: AuthenticatedTargetTuple) {
      const fields = { domain: "hermes.target-bind", version: 1, actor_id: tuple.actorId,
        binding_generation: tuple.generation, executor_runtime_identity: "runtime:test",
        requested_session_id: claimed.targetLocator, lineage_root_digest: claimed.targetLocatorDigest };
      receipt = { ...fields, receipt_digest: digestOf(fields) };
      return claimed;
    },
  };
  const input: BindInput & { restoreCeo: { actorId: string; generation: number; sessionId: string; incarnation: string } } = {
    role: Role.CEO, sessionId: replacement.sessionId, authenticatedTarget,
    restoreCeo: { actorId, generation: first.value.bindingGeneration,
      sessionId: old.sessionId, incarnation: old.incarnation },
  };
  return { cp, input, actorId };
}

describe("owner bootstrap same-actor CEO restoration", () => {
  it.each(["actor", "generation", "incarnation", "session", "project", "proof", "live", "unknown", "dead-replacement", "not-ready"])("refuses %s without an actor or assignment write", (fault) => {
    const { cp, input } = fixture();
    if (fault === "actor") input.restoreCeo.actorId = "actor:wrong";
    if (fault === "generation") input.restoreCeo.generation++;
    if (fault === "incarnation") input.restoreCeo.incarnation += "stale";
    if (fault === "session") input.restoreCeo.sessionId = input.sessionId;
    if (fault === "project") input.projectId = "wrong-project";
    if (fault === "proof") input.authenticatedTarget!.verify = () => null;
    if (fault === "live") vi.mocked(liveness.probeSessionLiveness).mockReturnValue("ALIVE");
    if (fault === "unknown") vi.mocked(liveness.probeSessionLiveness).mockReturnValue("UNKNOWN");
    if (fault === "dead-replacement") vi.mocked(liveness.probeSessionLiveness).mockReturnValue("DEAD");
    if (fault === "not-ready") cp.sessions.transition(input.sessionId, SessionLifecycle.ERROR, "failed");
    try {
      expect(cp.bindings.bind(input).allowed).toBe(false);
      expect(cp.bindings.history("CEO")).toHaveLength(1);
      expect(cp.db.all("SELECT actor_id FROM conversational_actors")).toHaveLength(1);
      expect(cp.db.all("SELECT target_actor_id FROM actor_target_bindings")).toHaveLength(0);
    } finally { cp.close(); }
  });
  it.each(["actor_id", "lineage_root_digest", "requested_session_id", "executor_runtime_identity", "binding_generation"])("refuses a receipt for another %s", (field) => {
    const { cp, input } = fixture();
    const target = input.authenticatedTarget!;
    const verify = target.verify;
    target.verify = (tuple) => {
      const result = verify(tuple);
      const receipt = target.targetBindReceipt as Record<string, unknown>;
      receipt[field] = field === "binding_generation" ? 999 : "wrong";
      const { receipt_digest: _digest, ...body } = receipt;
      receipt.receipt_digest = digestOf(body);
      return result;
    };
    try {
      expect(cp.bindings.bind(input).allowed).toBe(false);
      expect(cp.bindings.history("CEO")).toHaveLength(1);
    } finally { cp.close(); }
  });
  it("refuses replay after the successful restoration is revoked", () => {
    const { cp, input } = fixture();
    try {
      expect(cp.bindings.bind(input).allowed).toBe(true);
      cp.bindings.revoke("CEO", "second failure");
      expect(cp.bindings.bind(input).allowed).toBe(false);
      expect(cp.bindings.history("CEO")).toHaveLength(2);
    } finally { cp.close(); }
  });
  it("rechecks incumbent liveness after target verification before any write", () => {
    const { cp, input } = fixture();
    const verify = input.authenticatedTarget!.verify;
    input.authenticatedTarget!.verify = (tuple) => {
      const result = verify(tuple);
      vi.mocked(liveness.probeSessionLiveness).mockReturnValue("ALIVE");
      return result;
    };
    try {
      expect(cp.bindings.bind(input).allowed).toBe(false);
      expect(cp.bindings.active("CEO")).toBeNull();
      expect(cp.db.all("SELECT actor_id FROM conversational_actors")).toHaveLength(1);
      expect(cp.db.all("SELECT target_actor_id FROM actor_target_bindings")).toHaveLength(0);
    } finally { cp.close(); }
  });
  it("attaches the first authenticated target to the existing actor without minting a fork", () => {
    const { cp, input, actorId } = fixture();
    try {
      const result = cp.bindings.bind(input);
      expect(result.allowed).toBe(true);
      if (!result.allowed) return;
      expect(cp.db.get<{ actor_id: string }>("SELECT actor_id FROM assignments WHERE assignment_id = ?", [result.value.assignmentId])?.actor_id).toBe(actorId);
      expect(result.value.bindingGeneration).toBe(2);
      expect(cp.db.all("SELECT actor_id FROM conversational_actors")).toHaveLength(1);
      expect(cp.db.get<{ target_actor_id: string }>("SELECT target_actor_id FROM actor_target_bindings")?.target_actor_id).toBe(actorId);
    } finally { cp.close(); }
  });
});
