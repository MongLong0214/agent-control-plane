import { afterEach, describe, expect, it } from "vitest";
import { CtoBindingDelegation } from "../../src/ceo/cto-binding-delegation.ts";
import type { Decision } from "../../src/core/errors.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";

const value = <T>(d: Decision<T>): T => { if (!d.allowed) throw new Error(JSON.stringify(d)); return d.value; };
const CTO_KEY = `${Role.PRIMARY_CTO}:project-a`;
let h: Harness | undefined;
afterEach(() => { h?.cp.db.close(); h = undefined; cleanupTempDirs(); });
function fixture() {
  h = makeHarness();
  const { cp } = h;
  const session = cp.sessions.create({ provider: "scripted", model: "fixture" });
  value(cp.sessions.transition(session.sessionId, SessionLifecycle.READY));
  value(cp.bindings.bind({ role: Role.CEO, sessionId: session.sessionId }));
  const principal = { sessionId: session.sessionId, sessionSecret: session.sessionSecret! };
  const target = cp.sessions.create({ provider: "scripted", model: "target" });
  value(cp.sessions.transition(target.sessionId, SessionLifecycle.READY));
  const request = { requestId: "request-1", projectId: "project-a", role: "PRIMARY_CTO",
    action: "bind-or-rebind", targetSessionId: target.sessionId, expectedBindingGeneration: 1 };
  const authority = new CtoBindingDelegation(cp.sessions, cp.bindings, cp.audit);
  return { cp, session, principal, target, request, authority };
}

describe("CTO binding delegation, authorized by the live CEO binding", () => {
  it("authenticates the CEO session and scopes authorization to an exact runtime request", () => {
    const f = fixture();
    const request = f.request;
    expect(f.authority.authorize({ ...f.principal, sessionSecret: "wrong" }, request).allowed).toBe(false);
    expect(f.authority.authorize({ sessionId: f.target.sessionId, sessionSecret: f.target.sessionSecret! }, request).allowed).toBe(false);
    expect(f.authority.authorize(f.principal, { ...request, role: "CEO" }).allowed).toBe(false);
    expect(f.authority.authorize(f.principal, { ...request, expectedBindingGeneration: 7 }).allowed).toBe(false);
    expect(f.authority.authorize(f.principal, { ...request, targetSessionId: f.principal.sessionId }).allowed).toBe(false);
    const accepted = value(f.authority.authorize(f.principal, request));
    expect(value(f.authority.authorize(f.principal, request))).toEqual(accepted);
    // A repeated requestId must carry an identical request; a changed one is refused, not re-decided.
    expect(f.authority.authorize(f.principal, { ...request, projectId: "project-b" }).allowed).toBe(false);
    // Under its own requestId a second project is permitted. The grant this replaces was cut for
    // one project and refused every other; the CEO's authority is the role it holds, so the answer
    // to "which projects" is now "the ones it is CEO for", and that is the intended widening.
    value(f.authority.authorize(f.principal, { ...request, requestId: "request-2", projectId: "project-b" }));
    // Authorization is a decision, never the write: nothing is bound by asking.
    expect(f.cp.bindings.active(CTO_KEY)).toBeNull();
    expect(f.cp.audit.byKind("CTO_BINDING_DELEGATION_AUTHORIZED")).toHaveLength(2);
  });

  it("needs no owner decision: nothing is minted, presented or consumed", () => {
    const f = fixture();
    // The whole request. No receipt, nonce, scope or approval appears in it, and no owner port
    // was constructed into this authority — it takes sessions, bindings and audit. If an owner
    // gate is ever put back on this door, this case is what fails.
    value(f.authority.authorize(f.principal, f.request));
    expect(f.cp.audit.byKind("OWNER_APPROVAL_CONSUMED")).toHaveLength(0);
    expect(f.cp.audit.byKind("CTO_BINDING_DELEGATION_GRANTED")).toHaveLength(0);
    expect(JSON.stringify(f.cp.audit.all())).not.toContain("OWNER_APPROVAL");
  });

  it("losing the CEO role loses the permission, and regaining it gets the permission back", () => {
    const f = fixture();
    value(f.authority.authorize(f.principal, f.request));
    value(f.cp.bindings.revoke(Role.CEO, "the CEO seat is vacated"));
    // Nothing had to be revoked or settled here: the permission was the binding, so it left with it.
    expect(f.authority.authorize(f.principal, f.request).allowed).toBe(false);
    value(f.cp.bindings.bind({ role: Role.CEO, sessionId: f.principal.sessionId }));
    // The old design refused here permanently, because a grant outlived the role it was cut for
    // and had to be invalidated to stay safe. Reading the live binding has no such residue, and
    // this is what the removal is for: a CEO seat can be vacated and filled freely.
    value(f.authority.authorize(f.principal, f.request));
  });

  it("a restarted authority authorizes from the live registry, remembering nothing", () => {
    const f = fixture();
    value(f.authority.authorize(f.principal, f.request));
    const restarted = new CtoBindingDelegation(f.cp.sessions, f.cp.bindings, f.cp.audit);
    // Replay memory is per-instance and deliberately never rebuilt from audit, so the restarted
    // authority decides again rather than returning the first instance's receipt.
    value(restarted.authorize(f.principal, f.request));
    expect(f.cp.audit.byKind("CTO_BINDING_DELEGATION_AUTHORIZED")).toHaveLength(2);
  });

  it("authorizes successive registered runtimes and refuses changed replay and stale generation", async () => {
    const f = fixture();
    await registerFixtureProject(h!, "project-a");
    value(f.authority.authorize(f.principal, f.request));
    const successor = f.cp.sessions.create({ provider: "scripted", model: "replacement" });
    value(f.cp.sessions.transition(successor.sessionId, SessionLifecycle.READY));
    // Same requestId, different target: a changed replay is refused, not re-decided.
    expect(f.authority.authorize(f.principal, { ...f.request, targetSessionId: successor.sessionId }).allowed).toBe(false);
    // Fixture-only registry writes are NOT the delegated API or proof of dead-process fencing.
    value(f.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: "project-a", sessionId: f.target.sessionId }));
    expect(f.authority.authorize(f.principal, f.request).allowed).toBe(false);
    value(f.cp.bindings.revoke(CTO_KEY, "fixture ended"));
    value(f.cp.sessions.transition(f.target.sessionId, SessionLifecycle.STOPPED));
    const next = { ...f.request, requestId: "request-2", targetSessionId: successor.sessionId,
      expectedBindingGeneration: 2 };
    expect(f.authority.authorize(f.principal, { ...next, expectedBindingGeneration: 1 }).allowed).toBe(false);
    value(f.authority.authorize(f.principal, next));
    expect(f.cp.audit.byKind("CTO_BINDING_DELEGATION_AUTHORIZED")).toHaveLength(2);
  });

  it("returned authorization receipts cannot mutate internal authorization", () => {
    const f = fixture();
    const result = value(f.authority.authorize(f.principal, f.request));
    result.projectId = "evil";
    result.targetSessionId = "evil";
    expect(value(f.authority.authorize(f.principal, f.request)).projectId).toBe("project-a");
    const audit = JSON.stringify(f.cp.audit.all());
    expect(audit).not.toContain(f.principal.sessionSecret);
    expect(audit).not.toContain(f.target.sessionSecret!);
  });

  it("refuses a CEO session that is not READY and a target that is not READY", () => {
    const f = fixture();
    value(f.cp.sessions.transition(f.target.sessionId, SessionLifecycle.STOPPED));
    expect(f.authority.authorize(f.principal, f.request).allowed).toBe(false);
    value(f.cp.sessions.transition(f.session.sessionId, SessionLifecycle.STOPPED));
    expect(f.authority.authorize(f.principal, f.request).allowed).toBe(false);
  });
});
