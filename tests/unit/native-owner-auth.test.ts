import { createConnection, createServer } from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { startDaemonOperatorSocket } from "../../src/daemon/agentcpd.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { makeHarness, registerFixtureProject, TEST_OWNER } from "../helpers/harness.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

const nativeRoot = mkdtempSync(join(tmpdir(), "acp-native-owner-"));
const nativeTest = join(nativeRoot, "owner-test");
beforeAll(() => {
  execFileSync("/usr/bin/xcrun", ["swiftc", "-D", "OWNER_AUTH_TEST", "-parse-as-library",
    "native/owner-auth/OwnerAuth.swift", "tests/native/OwnerAuthTests.swift", "-o", nativeTest], { timeout: 120000 });
}, 130000);
afterAll(() => rmSync(nativeRoot, { recursive: true, force: true }));
it("compiled native scope and ordering seam passes without opening any UI", () => {
  expect(execFileSync(nativeTest, [], { timeout: 5000, encoding: "utf8", env: {} })).toContain("AUTH_ORDER_PASS");
});
it.each(["success", "cancel", "auth-error", "keychain-error", "wrong-scope", "denial", "wrong-receipt"])(
  "native child uses real UDS with no bearer in process transport: %s", async mode => {
    const path = join(nativeRoot, "fixture.sock");
    const scope = { projectId: "project-fixture", role: mode === "wrong-scope" ? "CEO" : "PRIMARY_CTO", action: "bind-or-rebind",
      ceoActorId: "actor-fixture", ceoSessionId: "ceo-fixture", ceoIncarnation: "incarnation-fixture",
      expiresAt: "2099-01-01T00:00:00.000Z", revokePolicy: "owner-or-ceo-loss" };
    const frames: Record<string, unknown>[] = [];
    const server = createServer({ allowHalfOpen: true }, socket => {
      let frame = "";
      socket.on("data", c => { frame += c.toString(); });
      socket.on("end", () => {
        frames.push(JSON.parse(frame));
        socket.end(JSON.stringify({ allowed: mode !== "denial", value: {
          delegationId: mode === "wrong-receipt" ? "not-a-receipt" : "11111111-1111-4111-8111-111111111111", scope } }) + "\n");
      });
    });
    await new Promise<void>(resolveListen => server.listen(path, resolveListen)); chmodSync(path, 0o600);
    try {
      const args = ["fixture", path, mode]; const input = JSON.stringify(scope);
      const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
        const child = spawn(nativeTest, args, { env: {}, stdio: ["pipe", "pipe", "pipe"], timeout: 15000 });
        let stdout = ""; let stderr = "";
        child.stdout.on("data", c => { stdout += c.toString(); }); child.stderr.on("data", c => { stderr += c.toString(); });
        child.on("error", reject); child.on("close", code => done({ code, stdout, stderr })); child.stdin.end(input);
      });
      expect(output.code).toBe(0); expect(output.stderr).toBe("");
      expect(JSON.stringify({ args, input, output })).not.toContain("native-child-synthetic-bearer");
      const transmitted = ["success", "denial", "wrong-receipt"].includes(mode);
      expect(frames).toHaveLength(transmitted ? 1 : 0);
      if (transmitted) expect(frames[0]).toMatchObject({ token: "native-child-synthetic-bearer", method: "ctoBinding.approveAndDelegate", params: { scope } });
      const expected = mode === "success" ? "GRANTED 11111111-1111-4111-8111-111111111111" :
        mode === "wrong-scope" ? "SCOPE_INVALID" : mode === "keychain-error" ? "KEYCHAIN_UNAVAILABLE" :
        ["denial", "wrong-receipt"].includes(mode) ? "DAEMON_DENIED" : "AUTH_DENIED";
      expect(output.stdout.trim()).toBe(expected);
    } finally { await new Promise<void>((done, reject) => server.close(e => e ? reject(e) : done())); }
  });
it("production native executable builds without launching it", () => {
  execFileSync("/usr/bin/xcrun", ["swiftc", "-parse-as-library", "native/owner-auth/OwnerAuth.swift", "-o", join(nativeRoot, "owner-auth")], { timeout: 120000 });
  // Bounded like every other exec in this file. `file` on a local binary is fast, but an
  // unbounded child is what wedges a suite when the host is not — `guards:subprocess-bounds`
  // refuses it, and raising the budget instead would remove the only thing enforcing that.
  expect(execFileSync("/usr/bin/file", [join(nativeRoot, "owner-auth")], { encoding: "utf8", timeout: 5000 }))
    .toContain("Mach-O");
}, 130000);

it.each(["success", "append-fault", "wrong-token", "non-owner", "lost-lock", "wrong-role", "wrong-actor", "expired", "extra-field"])(
  "native owner admission on existing authenticated socket: %s", async mode => {
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
