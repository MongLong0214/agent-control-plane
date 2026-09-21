import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, createConnection, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CtoBindingDelegation } from "../../src/ceo/cto-binding-delegation.ts";
import { CtoDelegatedBinding, serveCtoDelegatedBinding } from "../../src/daemon/cto-delegated-binding.ts";
import { digestOf } from "../../src/core/digest.ts";
import type { Decision } from "../../src/core/errors.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";

const value = <T>(d: Decision<T>): T => { if (!d.allowed) throw new Error(JSON.stringify(d)); return d.value; };
let h: Harness | undefined;
let server: Server | undefined;
const children: ChildProcess[] = [];
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill(); await exited;
  }
  h?.cp.db.close(); h = undefined; cleanupTempDirs();
});
async function fixture() {
  h = makeHarness();
  const { cp } = h;
  await registerFixtureProject(h, "project-a");
  const ceo = cp.sessions.create({ provider: "scripted", model: "ceo", osPid: process.pid });
  value(cp.sessions.transition(ceo.sessionId, SessionLifecycle.READY));
  value(cp.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId }));
  // No owner receipt is admitted and no grant is minted: the CEO's own live binding, bound to
  // the secret this principal presents, is the entire authority this writer consults.
  const authority = new CtoBindingDelegation(cp.sessions, cp.bindings, cp.audit, cp.db);
  const principal = { sessionId: ceo.sessionId, sessionSecret: ceo.sessionSecret! };
  const controls = { confirmTarget: true, beforeVerify: () => {} };
  const service = new CtoDelegatedBinding({ db: cp.db, sessions: cp.sessions, bindings: cp.bindings, authority,
    // Trusted executor test seam; target authentication is simulated, never claimed as production attestation.
    target: (sessionId) => {
      const claimed = { executorKind: "claude-cli", targetLocator: sessionId, targetLocatorDigest: digestOf(sessionId) };
      // Both production targets digest the tuple they verified, so the digest differs per
      // generation. This fixture used a constant one, and `actor_target_attestations_no_replace`
      // refuses a repeated (target_binding_id, attestation_digest) pair — so any second bind of
      // the *same* session aborted with ACTOR_TARGET_ATTESTATION_NO_REPLACE. No case had ever
      // rebound one session before, so the fixture's shortcut read as a control-plane rule.
      let attestationDigest = digestOf(claimed);
      return { claimed, protocolVersion: "fixture/v1",
        get attestationDigest() { return attestationDigest; },
        verify: (tuple) => { controls.beforeVerify();
          if (!controls.confirmTarget || tuple.sessionId !== sessionId) return null;
          attestationDigest = digestOf({ ...tuple, target: claimed });
          return claimed; } };
    } });
  const path = join(h.root, "binding.sock");
  server = createServer((socket) => serveCtoDelegatedBinding(socket, service));
  server.listen(path); await once(server, "listening");
  async function target() {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000);process.stdout.write('ready\\n')"], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(child); await once(child.stdout!, "data");
    const session = cp.sessions.create({ provider: "scripted", model: "cto", osPid: child.pid! });
    value(cp.sessions.transition(session.sessionId, SessionLifecycle.READY));
    return { child, session };
  }
  const request = (sessionId: string, generation: number) => ({
    requestId: randomUUID(), projectId: "project-a", role: "PRIMARY_CTO", action: "bind-or-rebind",
    targetSessionId: sessionId, expectedBindingGeneration: generation });
  async function rpc(request: unknown, who: unknown = principal,
    method = "ctoBinding.bind"): Promise<Decision<Record<string, unknown>>> {
    const client = createConnection(path); client.setTimeout(5000, () => client.destroy(new Error("fixture timeout")));
    const done = new Promise<string>((resolve, reject) => { let text = "";
      client.on("data", (chunk) => { text += chunk.toString(); }); client.on("end", () => resolve(text)); client.on("error", reject); });
    client.end(JSON.stringify({ method, principal: who, request }) + "\n");
    return JSON.parse(await done) as Decision<Record<string, unknown>>;
  }
  return { cp, authority, principal, service, request, rpc, target, controls };
}
it("socket authenticates CEO, binds ACTIVE, preserves live incumbent and rebinds after real process exit", async () => {
  const f = await fixture();
  const first = await f.target();
  const req = f.request(first.session.sessionId, 1);
  expect((await f.rpc(req, { ...f.principal, sessionSecret: "wrong" })).allowed).toBe(false);
  const bound = value(await f.rpc(req));
  expect(bound).toMatchObject({ status: "ACTIVE", sessionId: first.session.sessionId, bindingGeneration: 1 });
  expect(f.cp.bindings.activePrimaryCto("project-a")).toMatchObject(bound);
  const next = await f.target();
  const rebind = f.request(next.session.sessionId, 2);
  expect((await f.rpc(rebind)).allowed).toBe(false);
  expect(f.cp.bindings.activePrimaryCto("project-a")?.sessionId).toBe(first.session.sessionId);
  const exited = once(first.child, "exit"); first.child.kill(); await exited;
  const rebound = value(await f.rpc(rebind));
  expect(rebound).toMatchObject({ status: "ACTIVE", sessionId: next.session.sessionId, bindingGeneration: 2 });
  expect(f.cp.bindings.activePrimaryCto("project-a")).toMatchObject(rebound);
  // Two binds over this socket, and no owner decision was minted, presented or consumed for either.
  expect(JSON.stringify(f.cp.audit.all())).not.toContain("OWNER_APPROVAL");
  expect((await f.rpc(rebind)).allowed).toBe(false); // stale replay is fail-closed, not a cached permit
  expect(f.cp.bindings.history("PRIMARY_CTO:project-a")).toHaveLength(2);
  expect(f.cp.db.get<{ n: number }>("SELECT count(*) AS n FROM actor_target_attestations")?.n).toBe(2);
}, 15000);

// `{ projectId: "other" }` used to belong in the refusal list below and no longer does. The grant
// it was refused against was cut for one project; the CEO's live binding is not, so another
// project is an ordinary request. Left in the list it stopped being a refusal, committed a
// binding for an unregistered project, and latched this writer for every later case in the test.
it("rejects wrong principal/shape/target and two concurrent requests cannot both acquire generation one", async () => {
  const f = await fixture(); const first = await f.target(); const second = await f.target();
  const request = f.request(first.session.sessionId, 1);
  for (const change of [{ role: "CEO" }, { targetSessionId: "missing" },
    { targetSessionId: f.principal.sessionId }, { expectedBindingGeneration: 2 }, { extra: true }]) {
    expect((await f.rpc({ ...request, ...change })).allowed).toBe(false);
  }
  expect((await f.rpc(request, { sessionId: first.session.sessionId, sessionSecret: first.session.sessionSecret! })).allowed).toBe(false);
  // `delegationId` was a required field here; it is now an unknown one, and the envelope is strict.
  expect((await f.rpc({ ...request, delegationId: randomUUID() })).allowed).toBe(false);
  const results = await Promise.all([f.rpc(request), f.rpc(f.request(second.session.sessionId, 1))]);
  expect(results.filter((r) => r.allowed)).toHaveLength(1);
  expect(f.cp.bindings.history("PRIMARY_CTO:project-a")).toHaveLength(1);
  expect(JSON.stringify(f.cp.audit.all())).not.toContain(f.principal.sessionSecret);
}, 15000);

// The bind cases above all need a proven-dead incumbent before the role can move. This one does
// not kill anything: the child stays alive for the whole test, which is the point of a release.
it("releases a live incumbent over the socket, and a stale generation is refused", async () => {
  const f = await fixture();
  const first = await f.target();
  value(await f.rpc(f.request(first.session.sessionId, 1)));
  expect(f.cp.bindings.activePrimaryCto("project-a")?.sessionId).toBe(first.session.sessionId);
  const release = (generation: number, who: unknown = f.principal) => f.rpc({ requestId: randomUUID(),
    projectId: "project-a", role: "PRIMARY_CTO", action: "release",
    expectedBindingGeneration: generation, reason: "the owner is done with this session" },
    who, "ctoBinding.release");
  expect((await release(2)).allowed).toBe(false);
  expect((await release(1, { ...f.principal, sessionSecret: "wrong" })).allowed).toBe(false);
  expect(first.child.exitCode).toBeNull();
  expect(value(await release(1))).toMatchObject({ releasedSessionId: first.session.sessionId });
  expect(f.cp.bindings.activePrimaryCto("project-a")).toBeNull();
  // Releasing ends generation 1; it does not rewind the counter. The next bind is generation 2,
  // and a session can be bound again after being released, which is the "freely" half.
  expect((await f.rpc(f.request(first.session.sessionId, 1))).allowed).toBe(false);
  const rebound = value(await f.rpc(f.request(first.session.sessionId, 2)));
  expect(rebound).toMatchObject({ sessionId: first.session.sessionId, bindingGeneration: 2 });
  expect(JSON.stringify(f.cp.audit.all())).not.toContain("OWNER_APPROVAL");
}, 15000);

it("failed target attestation rolls back dead incumbent revoke, then the identical request can commit", async () => {
  const f = await fixture(); const first = await f.target();
  const original = value(await f.rpc(f.request(first.session.sessionId, 1)));
  const exited = once(first.child, "exit"); first.child.kill(); await exited;
  const next = await f.target(); const request = f.request(next.session.sessionId, 2);
  f.controls.confirmTarget = false;
  expect((await f.rpc(request)).allowed).toBe(false);
  expect(f.cp.bindings.activePrimaryCto("project-a")).toMatchObject(original);
  expect(f.cp.bindings.history("PRIMARY_CTO:project-a")).toHaveLength(1);
  f.controls.confirmTarget = true;
  expect(value(await f.rpc(request))).toMatchObject({ sessionId: next.session.sessionId, bindingGeneration: 2 });
}, 15000);

// "expiry" was a third case here and is gone with the grant that could expire. Losing the CEO
// binding mid-verification is now the whole of what expiry used to add: the authority is read
// again at the write boundary, so a role that left between the two reads refuses the write.
it.each(["ceo-loss", "target-loss"])("fresh write-boundary authorization refuses %s during verification", async (loss) => {
  const f = await fixture(); const target = await f.target();
  f.controls.beforeVerify = () => {
    if (loss === "ceo-loss") value(f.cp.bindings.revoke(Role.CEO, "fixture race"));
    if (loss === "target-loss") value(f.cp.sessions.transition(target.session.sessionId, SessionLifecycle.STOPPED));
  };
  expect((await f.rpc(f.request(target.session.sessionId, 1))).allowed).toBe(false);
  expect(f.cp.bindings.activePrimaryCto("project-a")).toBeNull();
  expect(f.cp.db.get<{ n: number }>("SELECT count(*) AS n FROM actor_target_attestations")?.n).toBe(0);
}, 15000);
