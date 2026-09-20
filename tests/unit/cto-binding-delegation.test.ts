import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CtoBindingDelegation, CTO_BINDING_DELEGATE_OPERATION } from "../../src/ceo/cto-binding-delegation.ts";
import type { Decision } from "../../src/core/errors.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { IngressGuard, ownerApprovalPayload } from "../../src/ingress/ingress-guard.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject, TEST_OWNER, type Harness } from "../helpers/harness.ts";

const value = <T>(d: Decision<T>): T => { if (!d.allowed) throw new Error(JSON.stringify(d)); return d.value; };
let h: Harness | undefined;
afterEach(() => { h?.cp.db.close(); h = undefined; cleanupTempDirs(); });
function fixture() {
  h = makeHarness();
  const { cp, clock } = h;
  const session = cp.sessions.create({ provider: "scripted", model: "fixture" });
  value(cp.sessions.transition(session.sessionId, SessionLifecycle.READY));
  value(cp.bindings.bind({ role: Role.CEO, sessionId: session.sessionId }));
  const principal = { sessionId: session.sessionId, sessionSecret: session.sessionSecret! };
  const authority = new CtoBindingDelegation(cp.sessions, cp.bindings, cp.ownerAuthority, cp.audit, clock);
  const scope = { projectId: "project-a", role: "PRIMARY_CTO" as const, action: "bind-or-rebind" as const,
    ceoSessionId: session.sessionId, ceoIncarnation: session.incarnation,
    expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    revokePolicy: "owner-or-ceo-loss-or-restart" as const };
  function approval(parameters: unknown = scope, approved = true, operation = CTO_BINDING_DELEGATE_OPERATION) {
    const decision = { runId: null, candidateSnapshotDigest: null, operation, parameters,
      idempotencyKey: randomUUID(), approved };
    return value(new IngressGuard(cp.db, clock, cp.audit, { cli: { allowedActors: [TEST_OWNER.actor] } })
      .admitOwnerApproval({ channel: "cli", actor: TEST_OWNER.actor, nonce: randomUUID(),
        payload: ownerApprovalPayload(decision) }, decision));
  }
  return { cp, clock, principal, authority, scope, approval };
}

describe("owner-scoped CTO binding delegation foundation", () => {
  it("authenticates the CEO session and scopes authorization to an exact runtime request", () => {
    const f = fixture();
    const grant = value(f.authority.grant(f.scope, f.approval()));
    const target = f.cp.sessions.create({ provider: "scripted", model: "target" });
    value(f.cp.sessions.transition(target.sessionId, SessionLifecycle.READY));
    const request = { delegationId: grant.delegationId, requestId: "request-1", projectId: "project-a",
      role: "PRIMARY_CTO", action: "bind-or-rebind", targetSessionId: target.sessionId,
      expectedBindingGeneration: 1 };
    expect(f.authority.authorize({ ...f.principal, sessionSecret: "wrong" }, request).allowed).toBe(false);
    expect(f.authority.authorize({ sessionId: target.sessionId, sessionSecret: target.sessionSecret! }, request).allowed).toBe(false);
    expect(f.authority.authorize(f.principal, { ...request, projectId: "project-b" }).allowed).toBe(false);
    expect(f.authority.authorize(f.principal, { ...request, role: "CEO" }).allowed).toBe(false);
    expect(f.authority.authorize(f.principal, { ...request, expectedBindingGeneration: 7 }).allowed).toBe(false);
    const accepted = value(f.authority.authorize(f.principal, request));
    expect(value(f.authority.authorize(f.principal, request))).toEqual(accepted);
    expect(f.authority.authorize(f.principal, { ...request, targetSessionId: f.principal.sessionId }).allowed).toBe(false);
    expect(f.cp.bindings.activePrimaryCto("project-a")).toBeNull();
    expect(f.cp.audit.byKind("CTO_BINDING_DELEGATION_AUTHORIZED")).toHaveLength(1);
  });
  function authorizedFixture() {
    const f = fixture();
    const receipt = f.approval();
    const grant = value(f.authority.grant(f.scope, receipt));
    const target = f.cp.sessions.create({ provider: "scripted", model: "target" });
    value(f.cp.sessions.transition(target.sessionId, SessionLifecycle.READY));
    const request = { delegationId: grant.delegationId, requestId: "request-1", projectId: "project-a",
      role: "PRIMARY_CTO", action: "bind-or-rebind", targetSessionId: target.sessionId,
      expectedBindingGeneration: 1 };
    return { ...f, receipt, grant, target, request };
  }
  it("owner revocation invalidates cached retries and cannot be replayed into a new grant", () => {
    const f = authorizedFixture();
    value(f.authority.authorize(f.principal, f.request));
    expect(f.authority.revoke(f.grant.delegationId, f.approval()).allowed).toBe(false);
    const revoke = f.approval({ delegationId: f.grant.delegationId }, true, "ctoBinding.revoke");
    value(f.authority.revoke(f.grant.delegationId, revoke));
    expect(f.authority.authorize(f.principal, f.request).allowed).toBe(false);
    expect(f.authority.grant(f.scope, f.receipt).allowed).toBe(false);
    expect(f.cp.audit.byKind("CTO_BINDING_DELEGATION_REVOKED")).toHaveLength(1);
  });
  it("expiry stays revoked after clock rollback and restart never reconstructs grants from audit", () => {
    const f = authorizedFixture();
    value(f.authority.authorize(f.principal, f.request));
    f.clock.advance(3_600_000);
    expect(f.authority.authorize(f.principal, f.request).allowed).toBe(false);
    f.clock.advance(-3_600_000);
    expect(f.authority.authorize(f.principal, f.request).allowed).toBe(false);
    const restarted = new CtoBindingDelegation(f.cp.sessions, f.cp.bindings, f.cp.ownerAuthority, f.cp.audit, f.clock);
    expect(restarted.authorize(f.principal, f.request).allowed).toBe(false);
    expect(restarted.grant(f.scope, f.receipt).allowed).toBe(false);
  });
  it("CEO role loss is permanent even if the same session reacquires CEO before the next request", () => {
    const f = authorizedFixture();
    value(f.cp.bindings.revoke(Role.CEO, "test revoke"));
    value(f.cp.bindings.bind({ role: Role.CEO, sessionId: f.principal.sessionId }));
    expect(f.authority.authorize(f.principal, f.request).allowed).toBe(false);
  });
  it("one grant authorizes successive registered runtimes and refuses changed replay and stale generation", async () => {
    const f = authorizedFixture();
    await registerFixtureProject(h!, "project-a");
    value(f.authority.authorize(f.principal, f.request));
    const successor = f.cp.sessions.create({ provider: "scripted", model: "replacement" });
    value(f.cp.sessions.transition(successor.sessionId, SessionLifecycle.READY));
    expect(f.authority.authorize(f.principal, { ...f.request, targetSessionId: successor.sessionId }).allowed).toBe(false);
    // Fixture-only registry writes are NOT the delegated API or proof of dead-process fencing.
    value(f.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: "project-a", sessionId: f.target.sessionId }));
    expect(f.authority.authorize(f.principal, f.request).allowed).toBe(false);
    value(f.cp.bindings.revoke("PRIMARY_CTO:project-a", "fixture ended"));
    value(f.cp.sessions.transition(f.target.sessionId, SessionLifecycle.STOPPED));
    const next = { ...f.request, requestId: "request-2", targetSessionId: successor.sessionId,
      expectedBindingGeneration: 2 };
    expect(f.authority.authorize(f.principal, { ...next, expectedBindingGeneration: 1 }).allowed).toBe(false);
    value(f.authority.authorize(f.principal, next));
    expect(f.cp.audit.byKind("CTO_BINDING_DELEGATION_GRANTED")).toHaveLength(1);
    expect(f.cp.audit.byKind("CTO_BINDING_DELEGATION_AUTHORIZED")).toHaveLength(2);
  });
  it.each(["denied", "expired", "wrong-operation", "wrong-role", "wrong-action", "non-ceo", "extra-field"])(
    "does not consume or grant an invalid owner scope: %s", (variant) => {
      const f = fixture();
      const scope = { ...f.scope } as Record<string, unknown>;
      if (variant === "expired") scope.expiresAt = f.clock.nowIso();
      if (variant === "wrong-role") scope.role = "CEO";
      if (variant === "wrong-action") scope.action = "owner.approve";
      if (variant === "non-ceo") scope.ceoSessionId = "missing-session";
      if (variant === "extra-field") scope.wildcard = true;
      const approval = f.approval(scope, variant !== "denied", variant === "wrong-operation" ? "other" : CTO_BINDING_DELEGATE_OPERATION);
      expect(f.authority.grant(scope, approval).allowed).toBe(false);
      expect(f.cp.audit.byKind("OWNER_APPROVAL_CONSUMED")).toHaveLength(0);
      expect(f.cp.audit.byKind("CTO_BINDING_DELEGATION_GRANTED")).toHaveLength(0);
    });
  it("returned scopes and authorization receipts cannot mutate internal authorization", () => {
    const f = authorizedFixture();
    f.grant.scope.projectId = "evil";
    const result = value(f.authority.authorize(f.principal, f.request));
    result.projectId = "evil";
    expect(value(f.authority.authorize(f.principal, f.request)).projectId).toBe("project-a");
    expect(f.authority.authorize(f.principal, { ...f.request, projectId: "evil" }).allowed).toBe(false);
    const audit = JSON.stringify(f.cp.audit.all());
    expect(audit).not.toContain(f.principal.sessionSecret);
    expect(audit).not.toContain(f.target.sessionSecret!);
  });
  it("requires an admitted explicit owner decision bound to the exact delegation scope", () => {
    const f = fixture();
    const receipt = f.approval();
    expect(f.authority.grant({ ...f.scope, projectId: "other-project" }, receipt).allowed).toBe(false);
    expect(f.authority.grant(f.scope, { ...receipt, inboundNonce: "fabricated" }).allowed).toBe(false);
    const granted = value(f.authority.grant(f.scope, receipt));
    expect(granted.scope).toEqual(f.scope);
    expect(granted.delegationId).toBeTruthy();
    expect(f.cp.audit.byKind("CTO_BINDING_DELEGATION_GRANTED")).toHaveLength(1);
  });
});
