import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, createConnection, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CtoBindingDelegation, CTO_BINDING_DELEGATE_OPERATION } from "../../src/ceo/cto-binding-delegation.ts";
import { CtoDelegatedBinding, serveCtoDelegatedBinding } from "../../src/daemon/cto-delegated-binding.ts";
import { digestOf } from "../../src/core/digest.ts";
import type { Decision } from "../../src/core/errors.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { IngressGuard, ownerApprovalPayload } from "../../src/ingress/ingress-guard.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject, TEST_OWNER, type Harness } from "../helpers/harness.ts";

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
  const { cp, clock } = h;
  await registerFixtureProject(h, "project-a");
  const ceo = cp.sessions.create({ provider: "scripted", model: "ceo", osPid: process.pid });
  value(cp.sessions.transition(ceo.sessionId, SessionLifecycle.READY));
  value(cp.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId }));
  const authority = new CtoBindingDelegation(cp.sessions, cp.bindings, cp.ownerAuthority, cp.audit, clock, cp.db);
  const scope = { projectId: "project-a", role: "PRIMARY_CTO", action: "bind-or-rebind",
    ceoSessionId: ceo.sessionId, ceoIncarnation: ceo.incarnation,
    expiresAt: new Date(clock.now().getTime() + 3600000).toISOString(),
    revokePolicy: "owner-or-ceo-loss-or-restart" };
  // Private fixture admission of the approved TEST_OWNER identity, NOT OS owner authentication.
  const approval = { runId: null, candidateSnapshotDigest: null, operation: CTO_BINDING_DELEGATE_OPERATION,
    parameters: scope, idempotencyKey: randomUUID(), approved: true };
  const receipt = value(new IngressGuard(cp.db, clock, cp.audit, { cli: { allowedActors: [TEST_OWNER.actor] } })
    .admitOwnerApproval({ channel: "cli", actor: TEST_OWNER.actor, nonce: randomUUID(),
      payload: ownerApprovalPayload(approval) }, approval));
  const grant = value(authority.grant(scope, receipt));
  const principal = { sessionId: ceo.sessionId, sessionSecret: ceo.sessionSecret! };
  const controls = { confirmTarget: true, beforeVerify: () => {} };
  const service = new CtoDelegatedBinding({ db: cp.db, sessions: cp.sessions, bindings: cp.bindings, authority,
    // Trusted executor test seam; target authentication is simulated, never claimed as production attestation.
    target: (sessionId) => {
      const claimed = { executorKind: "claude-cli", targetLocator: sessionId, targetLocatorDigest: digestOf(sessionId) };
      return { claimed, protocolVersion: "fixture/v1", attestationDigest: digestOf(claimed),
        verify: (tuple) => { controls.beforeVerify(); return controls.confirmTarget && tuple.sessionId === sessionId ? claimed : null; } };
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
  const request = (sessionId: string, generation: number) => ({ delegationId: grant.delegationId,
    requestId: randomUUID(), projectId: "project-a", role: "PRIMARY_CTO", action: "bind-or-rebind",
    targetSessionId: sessionId, expectedBindingGeneration: generation });
  async function rpc(request: unknown, who: unknown = principal): Promise<Decision<Record<string, unknown>>> {
    const client = createConnection(path); client.setTimeout(5000, () => client.destroy(new Error("fixture timeout")));
    const done = new Promise<string>((resolve, reject) => { let text = "";
      client.on("data", (chunk) => { text += chunk.toString(); }); client.on("end", () => resolve(text)); client.on("error", reject); });
    client.end(JSON.stringify({ method: "ctoBinding.bind", principal: who, request }) + "\n");
    return JSON.parse(await done) as Decision<Record<string, unknown>>;
  }
  return { cp, clock, authority, principal, service, request, rpc, target, controls };
}
it("socket authenticates CEO, binds ACTIVE, preserves live incumbent and rebinds after real process exit under one grant", async () => {
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
  expect(f.cp.audit.byKind("CTO_BINDING_DELEGATION_GRANTED")).toHaveLength(1);
  expect((await f.rpc(rebind)).allowed).toBe(false); // stale replay is fail-closed, not a cached permit
  expect(f.cp.bindings.history("PRIMARY_CTO:project-a")).toHaveLength(2);
  expect(f.cp.db.get<{ n: number }>("SELECT count(*) AS n FROM actor_target_attestations")?.n).toBe(2);
}, 15000);

it("rejects wrong principal/scope/target and two concurrent requests cannot both acquire generation one", async () => {
  const f = await fixture(); const first = await f.target(); const second = await f.target();
  const request = f.request(first.session.sessionId, 1);
  for (const change of [{ projectId: "other" }, { role: "CEO" }, { targetSessionId: "missing" },
    { targetSessionId: f.principal.sessionId }, { expectedBindingGeneration: 2 }, { extra: true }]) {
    expect((await f.rpc({ ...request, ...change })).allowed).toBe(false);
  }
  expect((await f.rpc(request, { sessionId: first.session.sessionId, sessionSecret: first.session.sessionSecret! })).allowed).toBe(false);
  expect((await f.rpc({ ...request, delegationId: randomUUID() })).allowed).toBe(false);
  const results = await Promise.all([f.rpc(request), f.rpc(f.request(second.session.sessionId, 1))]);
  expect(results.filter((r) => r.allowed)).toHaveLength(1);
  expect(f.cp.bindings.history("PRIMARY_CTO:project-a")).toHaveLength(1);
  expect(JSON.stringify(f.cp.audit.all())).not.toContain(f.principal.sessionSecret);
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

it.each(["expiry", "ceo-loss", "target-loss"])("fresh write-boundary authorization refuses %s during verification", async (loss) => {
  const f = await fixture(); const target = await f.target();
  f.controls.beforeVerify = () => {
    if (loss === "expiry") f.clock.advance(3600000);
    if (loss === "ceo-loss") value(f.cp.bindings.revoke(Role.CEO, "fixture race"));
    if (loss === "target-loss") value(f.cp.sessions.transition(target.session.sessionId, SessionLifecycle.STOPPED));
  };
  expect((await f.rpc(f.request(target.session.sessionId, 1))).allowed).toBe(false);
  expect(f.cp.bindings.activePrimaryCto("project-a")).toBeNull();
  expect(f.cp.db.get<{ n: number }>("SELECT count(*) AS n FROM actor_target_attestations")?.n).toBe(0);
}, 15000);
