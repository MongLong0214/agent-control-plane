/**
 * Owner admission for a durable CEO→CTO grant, over the operator socket that is already
 * authenticated. This file was `native-owner-auth.test.ts` and carried three more tests that
 * compiled `native/owner-auth/OwnerAuth.swift` with `xcrun swiftc` and ran it: that executable
 * put the grant's scope in an AppKit dialog and then required `LAContext.deviceOwnerAuthentication`
 * — Touch ID, or the system passcode — before it would read the operator bearer out of the
 * Keychain. It is deleted, so the tests that built it are gone with it.
 *
 * Deleting this file wholesale along with the Swift was rejected: the half that never touched
 * Swift is what actually holds the two `native-delegation-*` falsifiability rows up. With either
 * row's mutant applied the three Swift tests still passed and these nine cases failed, so taking
 * the file out would have left both rows with no witness while the harness still reported them.
 * The rows' ids still say "native"; they are left alone because their subject is the delegation
 * scope rather than the executable, and renaming them means renaming the case files too.
 */
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { startDaemonOperatorSocket } from "../../src/daemon/agentcpd.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { makeHarness, registerFixtureProject, TEST_OWNER } from "../helpers/harness.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

it.each(["success", "append-fault", "wrong-token", "non-owner", "lost-lock", "wrong-role", "wrong-actor", "expired", "extra-field"])(
  "durable admission on the existing authenticated socket: %s", async mode => {
  const h = makeHarness();
  await registerFixtureProject(h, "native-fixture");
  const ceo = h.cp.sessions.create({ provider: "scripted", model: "ceo", osPid: process.pid });
  h.cp.sessions.transition(ceo.sessionId, SessionLifecycle.READY);
  h.cp.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId });
  const actor = h.cp.db.get<{ actor_id: string }>("SELECT actor_id FROM assignments WHERE role_key = 'CEO' AND revoked_at IS NULL")!.actor_id;
  const scope = { projectId: "native-fixture", role: mode === "wrong-role" ? "CEO" : "PRIMARY_CTO", action: "bind-or-rebind", ceoActorId: mode === "wrong-actor" ? "wrong" : actor,
    ceoSessionId: ceo.sessionId, ceoIncarnation: ceo.incarnation, expiresAt: new Date(h.clock.now().getTime() + (mode === "expired" ? -1 : 3600000)).toISOString(), revokePolicy: "owner-or-ceo-loss",
    ...(mode === "extra-field" ? { extra: "not-authority" } : {}) };
  const listener = await startDaemonOperatorSocket(h.cp,
    { lock: { held: () => mode !== "lost-lock" }, handleOperatorRequest: async () => allow(ReasonCode.OK, {}) } as unknown as Parameters<typeof startDaemonOperatorSocket>[1],
    h.root, { token: "native-fixture-token", peerId: "fixture-owner", actor: mode === "non-owner" ? "not-owner" : TEST_OWNER.actor });
  const before = h.cp.audit.all();
  const run = h.cp.db.run.bind(h.cp.db);
  let appendAttempted = false;
  const fault = mode === "append-fault" ? vi.spyOn(h.cp.db, "run").mockImplementation((sql, params) => {
    if (params?.includes("CTO_BINDING_DURABLE_GRANTED")) {
      appendAttempted = true;
      throw new Error("fixture append fault");
    }
    return run(sql, params);
  }) : undefined;
  try {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(listener.socketPath); let text = "";
      socket.setTimeout(5000, () => socket.destroy(new Error("fixture timeout")));
      socket.on("error", reject); socket.on("data", c => { text += c.toString(); }); socket.on("end", () => resolve(text));
      socket.end(JSON.stringify({ token: mode === "wrong-token" ? "wrong" : "native-fixture-token", method: "ctoBinding.approveAndDelegate", params: { scope, requestId: randomUUID() } }) + "\n");
    });
    if (mode === "success") expect(JSON.parse(response)).toMatchObject({ allowed: true, value: { delegationId: expect.any(String), scope } });
    else expect(JSON.parse(response)).toMatchObject({ allowed: false });
    expect(h.cp.db.get<{ n: number }>("SELECT count(*) AS n FROM audit_events WHERE kind = 'CTO_BINDING_DURABLE_GRANTED'")!.n).toBe(mode === "success" ? 1 : 0);
    expect(h.cp.db.get<{ n: number }>("SELECT count(*) AS n FROM audit_events WHERE kind = 'OWNER_APPROVAL_CONSUMED'")!.n).toBe(mode === "success" ? 1 : 0);
    if (mode === "append-fault") {
      expect(appendAttempted).toBe(true);
      expect(h.cp.audit.all()).toEqual(before);
    }
  } finally { fault?.mockRestore(); await listener.close(); h.cp.db.close(); cleanupTempDirs(); }
});
