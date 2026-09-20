import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { createCtoBindingRuntime } from "../../src/daemon/cto-binding-runtime.ts";
import { CtoDelegatedBinding } from "../../src/daemon/cto-delegated-binding.ts";
import { digestOf } from "../../src/core/digest.ts";
import { OwnerAuthority } from "../../src/ceo/owner-authority.ts";
import { CtoBindingDelegation } from "../../src/ceo/cto-binding-delegation.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { IngressGuard, ownerApprovalPayload } from "../../src/ingress/ingress-guard.ts";
import type { Decision } from "../../src/core/errors.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject, TEST_OWNER, type Harness } from "../helpers/harness.ts";
const value = <T>(d: Decision<T>): T => { if (!d.allowed) throw new Error(JSON.stringify(d)); return d.value; };
let h: Harness | undefined;
afterEach(() => { h?.cp.db.close(); h = undefined; cleanupTempDirs(); });
function fixture() {
  h = makeHarness();
  const { cp, clock } = h;
  const ceo = cp.sessions.create({ provider: "scripted", model: "fixture", osPid: process.pid });
  value(cp.sessions.transition(ceo.sessionId, SessionLifecycle.READY));
  value(cp.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId }));
  const actor = cp.db.get<{ actor_id: string }>("SELECT actor_id FROM assignments WHERE role_key = 'CEO'")!;
  const scope = { projectId: "project-a", role: "PRIMARY_CTO", action: "bind-or-rebind",
    ceoActorId: actor.actor_id, ceoSessionId: ceo.sessionId, ceoIncarnation: ceo.incarnation,
    expiresAt: new Date(clock.now().getTime() + 3600000).toISOString(), revokePolicy: "owner-or-ceo-loss" };
  const authority = () => new CtoBindingDelegation(cp.sessions, cp.bindings, cp.ownerAuthority, cp.audit, clock, cp.db);
  const approve = (parameters: unknown = scope, operation = "ctoBinding.delegate") => {
    const decision = { runId: null, candidateSnapshotDigest: null, operation, parameters, approved: true, idempotencyKey: randomUUID() };
    return value(new IngressGuard(cp.db, clock, cp.audit, { cli: { allowedActors: [TEST_OWNER.actor] } })
      .admitOwnerApproval({ channel: "cli", actor: TEST_OWNER.actor, nonce: randomUUID(), payload: ownerApprovalPayload(decision) }, decision));
  };
  const target = cp.sessions.create({ provider: "scripted", model: "target", osPid: process.pid });
  value(cp.sessions.transition(target.sessionId, SessionLifecycle.READY));
  const request = (delegationId: string) => ({ delegationId, requestId: "request-a", projectId: "project-a", role: "PRIMARY_CTO", action: "bind-or-rebind", targetSessionId: target.sessionId, expectedBindingGeneration: 1 });
  return { cp, clock, scope, authority, approve, request, principal: { sessionId: ceo.sessionId, sessionSecret: ceo.sessionSecret! } };
}
it.each([
  ["before-request", "after-rollback"], ["during-verification", "after-rollback"],
  ["before-request", "before-tombstone"], ["during-verification", "before-tombstone"],
])("crashed durable expiry cannot resurrect in another process: %s / %s", async (phase, seam) => {
  const f = fixture(); await registerFixtureProject(h!, "project-a");
  const grant = value(f.authority().grant(f.scope, f.approve()));
  const data = { root: h!.root, repoPath: h!.repoPath, principal: f.principal,
    request: f.request(grant.delegationId), phase, seam };
  const prelude = `
    import { makeHarness } from './tests/helpers/harness.ts';
    import { CtoBindingDelegation } from './src/ceo/cto-binding-delegation.ts';
    import { CtoDelegatedBinding } from './src/daemon/cto-delegated-binding.ts';
    import { digestOf } from './src/core/digest.ts';
    const data = ${JSON.stringify(data)};
    const { cp, clock } = makeHarness({ root: data.root, repoPath: data.repoPath });
    const authority = new CtoBindingDelegation(cp.sessions, cp.bindings, cp.ownerAuthority, cp.audit, clock, cp.db);
  `;
  const crash = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", prelude + `
    const txDecision = cp.db.txDecision.bind(cp.db);
    cp.db.txDecision = (body) => {
      const result = txDecision(body);
      if (!result.allowed && !cp.db.inTransaction && data.seam === 'after-rollback') process.exit(73);
      return result;
    };
    const run = cp.db.run.bind(cp.db);
    cp.db.run = (sql, params) => {
      if (data.seam === 'before-tombstone' && params?.includes('CTO_BINDING_DURABLE_REVOKED')) process.exit(73);
      return run(sql, params);
    };
    const service = new CtoDelegatedBinding({ db: cp.db, sessions: cp.sessions, bindings: cp.bindings, authority,
      target: (sessionId) => {
        const claimed = { executorKind: 'claude-cli', targetLocator: sessionId, targetLocatorDigest: digestOf(sessionId) };
        return { claimed, protocolVersion: 'fixture/v1', attestationDigest: digestOf(claimed), verify: () => {
          if (data.phase === 'during-verification') clock.advance(3600000);
          return claimed;
        } };
      } });
    if (data.phase === 'before-request') clock.advance(3600000);
    const result = service.execute({ method: 'ctoBinding.bind', principal: data.principal, request: data.request });
    console.log(JSON.stringify(result)); cp.db.close(); process.exit(74);
  `], { encoding: "utf8", timeout: 15000 });
  expect(crash.status, crash.stderr + crash.stdout).toBe(73);
  const restart = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", prelude + `
    const result = authority.authorize(data.principal, data.request);
    console.log(JSON.stringify({ allowed: result.allowed,
      requests: cp.audit.byKind('CTO_BINDING_DURABLE_REQUEST').length,
      bindings: cp.bindings.history('PRIMARY_CTO:project-a').length,
      attestations: cp.db.get('SELECT count(*) AS n FROM actor_target_attestations').n }));
    cp.db.close();
  `], { encoding: "utf8", timeout: 15000 });
  expect(restart.status, restart.stderr).toBe(0);
  expect(JSON.parse(restart.stdout)).toEqual({ allowed: false, requests: 0, bindings: 0, attestations: 0 });
}, 35000);

it.each(["authorize", "revoke", "grant"])("external transaction is refused without consuming or mutating it: %s", (operation) => {
  const f = fixture(); const authority = f.authority();
  const grant = value(authority.grant(f.scope, f.approve()));
  const receipt = f.approve({ delegationId: grant.delegationId }, "ctoBinding.revoke");
  const grantReceipt = f.approve();
  const before = f.cp.audit.all();
  f.cp.db.tx(() => {
    const result = operation === "authorize"
      ? authority.authorize(f.principal, f.request(grant.delegationId))
      : operation === "revoke" ? authority.revoke(grant.delegationId, receipt) : authority.grant(f.scope, grantReceipt);
    expect(result.allowed).toBe(false);
    expect(f.cp.db.inTransaction).toBe(true);
    expect(f.cp.audit.all()).toEqual(before);
  });
  expect(authority.authorize(f.principal, f.request(grant.delegationId)).allowed).toBe(true);
  const begun = f.cp.audit.byKind("CTO_BINDING_OPERATION_STARTED");
  expect(begun).toHaveLength(1);
  expect(f.cp.audit.byKind("CTO_BINDING_OPERATION_FINISHED")).toHaveLength(begun.length);
});

it("a failed preflight cannot authorize an unfenced durable request", () => {
  const f = fixture(); const authority = f.authority();
  const grant = value(authority.grant(f.scope, f.approve()));
  const original = f.cp.db.all.bind(f.cp.db);
  const spy = vi.spyOn(f.cp.db, "all").mockImplementation(original);
  spy.mockImplementationOnce(() => { throw new Error("fixture read fault"); });
  try { expect(authority.authorize(f.principal, f.request(grant.delegationId)).allowed).toBe(false); }
  finally { spy.mockRestore(); }
  expect(f.cp.audit.byKind("CTO_BINDING_DURABLE_REQUEST")).toHaveLength(0);
});

it("reconstructs only an explicitly durable consumed owner grant after authority restart", () => {
  const f = fixture();
  const receipt = f.approve();
  const grant = value(f.authority().grant(f.scope, receipt));
  expect(f.authority().authorize(f.principal, f.request(grant.delegationId)).allowed).toBe(true);
  expect(f.authority().grant(f.scope, receipt).allowed).toBe(false);
  expect(JSON.stringify(f.cp.audit.all())).not.toContain(f.principal.sessionSecret);
});
it("daemon composition opts into durable grants and revoke survives a new composition", () => {
  const f = fixture();
  const runtime = createCtoBindingRuntime(f.cp, undefined);
  const grant = value(runtime.grant(f.scope, f.approve()));
  value(createCtoBindingRuntime(f.cp, undefined).revoke(grant.delegationId,
    f.approve({ delegationId: grant.delegationId }, "ctoBinding.revoke")));
  expect(f.authority().authorize(f.principal, f.request(grant.delegationId)).allowed).toBe(false);
});
it("reopens the actual database and reconstructs only the consumed grant", () => {
  const f = fixture();
  const grant = value(f.authority().grant(f.scope, f.approve()));
  const { root, repoPath, clock } = h!;
  f.cp.db.close(); h = undefined;
  h = makeHarness({ root, repoPath, clock });
  const cp = h.cp;
  const restarted = new CtoBindingDelegation(cp.sessions, cp.bindings, cp.ownerAuthority, cp.audit, clock, cp.db);
  expect(restarted.authorize(f.principal, f.request(grant.delegationId)).allowed).toBe(true);
});
it("changed request replay remains refused after authority restart", () => {
  const f = fixture(); const grant = value(f.authority().grant(f.scope, f.approve()));
  const request = f.request(grant.delegationId);
  value(f.authority().authorize(f.principal, request));
  const target = f.cp.sessions.create({ provider: "scripted", model: "successor" });
  value(f.cp.sessions.transition(target.sessionId, SessionLifecycle.READY));
  expect(f.authority().authorize(f.principal, { ...request, targetSessionId: target.sessionId }).allowed).toBe(false);
  expect(f.authority().authorize(f.principal, request).allowed).toBe(true);
});
it.each(["project", "role", "action", "generation", "secret", "expired", "ceo-loss", "ceo-stopped", "target-stopped", "owner-loss"])(
  "rechecks fresh authority after restart: %s", (variant) => {
    const f = fixture(); const grant = value(f.authority().grant(f.scope, f.approve()));
    const request = f.request(grant.delegationId); const principal = { ...f.principal };
    if (variant === "project") request.projectId = "other";
    if (variant === "role") request.role = "CEO";
    if (variant === "action") request.action = "owner.approve";
    if (variant === "generation") request.expectedBindingGeneration = 2;
    if (variant === "secret") principal.sessionSecret = "wrong";
    if (variant === "expired") f.clock.advance(3600000);
    if (variant === "ceo-loss") {
      value(f.cp.bindings.revoke(Role.CEO, "fixture"));
      value(f.cp.bindings.bind({ role: Role.CEO, sessionId: principal.sessionId }));
    }
    if (variant === "ceo-stopped") value(f.cp.sessions.transition(principal.sessionId, SessionLifecycle.STOPPED));
    if (variant === "target-stopped") value(f.cp.sessions.transition(request.targetSessionId, SessionLifecycle.STOPPED));
    const authority = variant === "owner-loss"
      ? new CtoBindingDelegation(f.cp.sessions, f.cp.bindings, new OwnerAuthority(f.cp.db, [], f.clock), f.cp.audit, f.clock, f.cp.db)
      : f.authority();
    expect(authority.authorize(principal, request).allowed).toBe(false);
    if (variant === "expired") {
      f.clock.advance(-3600000);
      expect(f.authority().authorize(principal, request).allowed).toBe(false);
    }
  });
it.each(["missing-actor", "wrong-actor", "wrong-incarnation", "missing-store"])("refuses invalid durable scope: %s", (variant) => {
  const f = fixture(); const scope: Record<string, unknown> = { ...f.scope };
  if (variant === "missing-actor") delete scope.ceoActorId;
  if (variant === "wrong-actor") scope.ceoActorId = "other";
  if (variant === "wrong-incarnation") scope.ceoIncarnation = "other";
  const a = variant === "missing-store" ? new CtoBindingDelegation(f.cp.sessions, f.cp.bindings, f.cp.ownerAuthority, f.cp.audit, f.clock) : f.authority();
  expect(a.grant(scope, f.approve(scope)).allowed).toBe(false);
  expect(f.cp.audit.byKind("OWNER_APPROVAL_CONSUMED")).toHaveLength(0);
});
it.each(["duplicate", "malformed", "scope", "identity", "receipt", "duplicate-consumption", "malformed-revoke"])(
  "fails closed on corrupted or replayed append-only events: %s", (variant) => {
    const f = fixture(); const grant = value(f.authority().grant(f.scope, f.approve()));
    const row = f.cp.db.get<{ evidence_json: string }>("SELECT evidence_json FROM audit_events WHERE kind = 'CTO_BINDING_DURABLE_GRANTED'")!;
    const event = JSON.parse(row.evidence_json);
    if (variant === "scope") event.scope.projectId = "other";
    if (variant === "identity") event.delegationId = randomUUID();
    if (variant === "receipt") event.receipt.inboundNonce = "forged";
    let kind = "CTO_BINDING_DURABLE_GRANTED";
    let encoded = variant === "malformed" ? "{" : JSON.stringify(event);
    if (variant === "duplicate-consumption") {
      kind = "OWNER_APPROVAL_CONSUMED";
      encoded = f.cp.db.get<{ evidence_json: string }>("SELECT evidence_json FROM audit_events WHERE kind = 'OWNER_APPROVAL_CONSUMED'")!.evidence_json;
    }
    if (variant === "malformed-revoke") { kind = "CTO_BINDING_DURABLE_REVOKED"; encoded = "{}"; }
    // Deliberate corruption in a disposable fixture, never a production database.
    f.cp.db.run("INSERT INTO audit_events (at,kind,actor,evidence_json) VALUES (?,?,?,?)", [f.clock.nowIso(), kind, "fixture", encoded]);
    expect(f.authority().authorize(f.principal, f.request(grant.delegationId)).allowed).toBe(false);
  });
it.each(["extra-receipt-field", "missing-consumption", "scope", "actor", "incarnation", "expiry", "assignment", "receipt", "identity"])(
  "rejects an isolated tampered grant projection without relying on duplicate rejection: %s", (variant) => {
    const f = fixture(); const grant = value(f.authority().grant(f.scope, f.approve()));
    const original = f.cp.db.all.bind(f.cp.db);
    const spy = vi.spyOn(f.cp.db, "all").mockImplementation((sql, params) => {
      const rows = original(sql, params);
      if (!sql.includes("'CTO_BINDING_DURABLE_GRANTED',")) return rows;
      return rows.filter((row) => variant !== "missing-consumption" || (row as { kind: string }).kind !== "OWNER_APPROVAL_CONSUMED").map((raw) => {
        const row = raw as { kind: string; evidence_json: string };
        if (row.kind !== "CTO_BINDING_DURABLE_GRANTED") return row;
        const event = JSON.parse(row.evidence_json);
        if (variant === "extra-receipt-field") event.receipt.sessionSecret = "must-not-be-accepted";
        if (variant === "scope") event.scope.projectId = "other";
        if (variant === "actor") event.scope.ceoActorId = "other";
        if (variant === "incarnation") event.scope.ceoIncarnation = "other";
        if (variant === "expiry") event.scope.expiresAt = "2099-01-01T00:00:00.000Z";
        if (variant === "assignment") event.assignmentId = "other";
        if (variant === "receipt") event.receipt.inboundNonce = "other";
        if (variant === "identity") event.delegationId = randomUUID();
        return { ...row, evidence_json: JSON.stringify(event) };
      });
    });
    try { expect(f.authority().authorize(f.principal, f.request(grant.delegationId)).allowed).toBe(false); }
    finally { spy.mockRestore(); }
  });
it.each(["success", "expiry", "ceo-loss", "owner-revoke"])("reconstructed authority reaches real binding transaction: %s", async (mode) => {
  const f = fixture(); await registerFixtureProject(h!, "project-a");
  const grant = value(f.authority().grant(f.scope, f.approve()));
  const request = f.request(grant.delegationId);
  const revocation = f.approve({ delegationId: grant.delegationId }, "ctoBinding.revoke");
  const service = new CtoDelegatedBinding({ db: f.cp.db, sessions: f.cp.sessions, bindings: f.cp.bindings, authority: f.authority(),
    // Only executor attestation is synthetic; authority, transaction and registry are real.
    target: (sessionId) => {
      const claimed = { executorKind: "claude-cli", targetLocator: sessionId, targetLocatorDigest: digestOf(sessionId) };
      return { claimed, protocolVersion: "fixture/v1", attestationDigest: digestOf(claimed), verify: () => {
        if (mode === "expiry") f.clock.advance(3600000);
        if (mode === "ceo-loss") value(f.cp.bindings.revoke(Role.CEO, "fixture race"));
        if (mode === "owner-revoke") value(f.authority().revoke(grant.delegationId, revocation));
        return claimed;
      } };
    } });
  const result = service.execute({ method: "ctoBinding.bind", principal: f.principal, request });
  expect(result.allowed).toBe(mode === "success");
  if (mode === "success") {
    expect(f.cp.bindings.activePrimaryCto("project-a")?.sessionId).toBe(request.targetSessionId);
    expect(service.execute({ method: "ctoBinding.bind", principal: f.principal, request }).allowed).toBe(false);
  } else {
    expect(f.cp.bindings.activePrimaryCto("project-a")).toBeNull();
    expect(f.cp.db.get<{ n: number }>("SELECT count(*) AS n FROM actor_target_attestations")!.n).toBe(0);
  }
});
it.each(["duplicate", "malformed"])("refuses corrupted durable request records: %s", (mode) => {
  const f = fixture(); const grant = value(f.authority().grant(f.scope, f.approve()));
  const request = f.request(grant.delegationId); value(f.authority().authorize(f.principal, request));
  const row = f.cp.db.get<{ evidence_json: string }>("SELECT evidence_json FROM audit_events WHERE kind = 'CTO_BINDING_DURABLE_REQUEST'")!;
  f.cp.db.run("INSERT INTO audit_events (at,kind,actor,evidence_json) VALUES (?,?,?,?)",
    [f.clock.nowIso(), "CTO_BINDING_DURABLE_REQUEST", "fixture", mode === "duplicate" ? row.evidence_json : "{}"]);
  expect(f.authority().authorize(f.principal, request).allowed).toBe(false);
});
it("rolls back owner consumption when durable grant append fails", () => {
  const f = fixture(); const receipt = f.approve(); const original = f.cp.db.run.bind(f.cp.db);
  const spy = vi.spyOn(f.cp.db, "run").mockImplementation((sql, params) => {
    if (params?.includes("CTO_BINDING_DURABLE_GRANTED")) throw new Error("fixture append fault");
    return original(sql, params);
  });
  try { expect(() => f.authority().grant(f.scope, receipt)).toThrow(); } finally { spy.mockRestore(); }
  expect(f.cp.audit.byKind("OWNER_APPROVAL_CONSUMED")).toHaveLength(0);
  expect(f.authority().grant(f.scope, receipt).allowed).toBe(true);
});
