import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Decision, allow } from "../../src/core/errors.ts";
import type { AttachmentCredential } from "../../src/session/role-attachment-credentials.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { IngressGuard, ownerApprovalPayload } from "../../src/ingress/ingress-guard.ts";
import { RoleConversationPort } from "../../src/mcp/role-conversation.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { fixtureManifest, makeHarness, TEST_OWNER, type Harness } from "../helpers/harness.ts";

const valueOf = <T>(decision: Decision<T>): T => {
  if (!decision.allowed) throw new Error(JSON.stringify(decision));
  return decision.value;
};

// No transport, listener, registration or wake here. These tests call authorization and
// attach/detach directly; actual connection ownership and close belong to the socket file.
describe("role attachment authorization without sockets", () => {
  let h: Harness;
  let daemon: Daemon;
  let port: RoleConversationPort;
  let subject: { sessionId: string; sessionSecret: string };
  let roleKey: string;
  const operator = { channel: "cli", actor: TEST_OWNER.actor, peerId: "test-owner", incarnation: "test" } as const;
  const request = (method: string, params: Record<string, unknown>) =>
    daemon.handleOperatorRequest({ requestId: randomUUID(), idempotencyKey: randomUUID(), method, params }, operator);
  const approval = (overrides: Partial<{ approved: boolean; operation: string; parameters: unknown }> = {}) => {
    const binding = h.cp.bindings.active(roleKey)!;
    const decision = {
      runId: null, candidateSnapshotDigest: null, operation: "roleAttachment.issue",
      parameters: { sessionId: subject.sessionId, sessionIncarnation: binding.sessionIncarnation,
        roleKey, assignmentId: binding.assignmentId, bindingGeneration: binding.bindingGeneration },
      idempotencyKey: randomUUID(), approved: true,
      ...overrides,
    };
    const guard = new IngressGuard(h.cp.db, h.clock, h.cp.audit, { cli: { allowedActors: [TEST_OWNER.actor] } });
    return valueOf(guard.admitOwnerApproval({ channel: "cli", actor: TEST_OWNER.actor,
      nonce: randomUUID(), payload: ownerApprovalPayload(decision) }, decision));
  };
  const issue = (receipt = approval(), overrides = {}) =>
    daemon.attachments.issue({ ...subject, roleKey, approval: receipt, ...overrides });
  const grant = () => valueOf(issue());
  const server = () => new McpServer({ name: "attachment-test", version: "1" });
  const ready = () => {
    const session = h.cp.sessions.create({ provider: "scripted", model: "fixture" });
    valueOf(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY));
    if (!session.sessionSecret) throw new Error("fixture secret unavailable");
    return { sessionId: session.sessionId, sessionSecret: session.sessionSecret };
  };
  const advance = (conversation: "REPLACED" | "SURVIVED" = "REPLACED") => {
    const other = ready();
    valueOf(h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: "attachment-project",
      sessionId: other.sessionId, conversation, reason: "test transition" }));
    return other;
  };
  beforeEach(() => {
    h = makeHarness();
    const manifest = fixtureManifest("attachment-project");
    valueOf(h.cp.projects.register({ projectId: manifest.projectId, name: "fixture", manifest,
      authorization: h.cp.manifestAuthorizationForTests(manifest) }));
    const session = h.cp.sessions.create({ provider: "scripted", model: "fixture" });
    valueOf(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY));
    if (!session.sessionSecret) throw new Error("fixture secret unavailable");
    subject = { sessionId: session.sessionId, sessionSecret: session.sessionSecret };
    roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: manifest.projectId });
    valueOf(h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: manifest.projectId, sessionId: subject.sessionId }));
    daemon = new Daemon(h.cp, { stateDir: tempDir("at-") });
    valueOf(daemon.lock.acquire(h.clock.nowIso()));
    port = new RoleConversationPort(Role.PRIMARY_CTO, {
      active: (key) => h.cp.bindings.active(key), currentCandidates: () => [h.cp.bindings.active(roleKey)!],
    });
  });
  afterEach(() => {
    daemon?.lock.release();
    h?.cp.db.close();
    cleanupTempDirs();
  });

  it("an explicit owner decision is admitted for the ACTIVE registry generation", async () => {
    const result = await request("owner.approveRoleAttachment", {
      sessionId: subject.sessionId, roleKey, nonce: randomUUID(), approved: true,
    });
    expect(result.allowed, JSON.stringify(result)).toBe(true);
  });

  it("session authentication and an admitted owner approval issue a separate attachment credential", async () => {
    const result = await request("roleAttachment.issue", { ...subject, roleKey, approval: approval() });
    expect(result.allowed, JSON.stringify(result)).toBe(true);
    const credential = valueOf(result) as { attachmentSecret: string };
    expect(credential.attachmentSecret).toEqual(expect.any(String));
    expect(credential.attachmentSecret).not.toBe(subject.sessionSecret);
    expect(h.cp.sessions.verifySecret(subject.sessionId, subject.sessionSecret).allowed).toBe(true);
  });

  it("attach takes an empty slot and a later detach cannot evict its incumbent", () => {
    const auth = () => allow(ReasonCode.OK, { actor: subject.sessionId, ...subject,
      sessionIncarnation: h.cp.sessions.require(subject.sessionId).incarnation });
    const first = new McpServer({ name: "first", version: "1" });
    const second = new McpServer({ name: "second", version: "1" });
    const detachFirst = port.attach(first, auth);
    const detachSecond = port.attach(second, auth);
    detachSecond();
    expect(port.connected(roleKey)).toBe(true);
    detachFirst();
    expect(port.connected(roleKey)).toBe(false);
  });

  it("issuance rejects a wrong session secret without spending the approval", () => {
    const receipt = approval();
    expect(issue(receipt, { sessionSecret: "wrong" }).allowed).toBe(false);
    expect(issue(receipt).allowed).toBe(true);
  });

  it("another authenticated subject cannot spend the holder approval", () => {
    const receipt = approval();
    const other = advance("SURVIVED");
    expect(issue(receipt, other).allowed).toBe(false);
    expect(issue(approval()).allowed).toBe(false);
  });

  it("missing and forged decisions cannot authorize issuance", () => {
    const receipt = approval();
    expect(issue(receipt, { approval: undefined }).allowed).toBe(false);
    expect(issue({ ...receipt, inboundNonce: "unadmitted" }).allowed).toBe(false);
    expect(issue(receipt).allowed).toBe(true);
  });

  it("an admitted rejection cannot issue a credential", () => {
    expect(issue(approval({ approved: false })).allowed).toBe(false);
  });

  it("approval for another operation cannot issue a credential", () => {
    expect(issue(approval({ operation: "actor.claimCanonicalCto" })).allowed).toBe(false);
  });

  it("only an explicitly deciding authenticated owner can mint approval", async () => {
    const params = { sessionId: subject.sessionId, roleKey, nonce: randomUUID() };
    expect((await request("owner.approveRoleAttachment", params)).allowed).toBe(false);
    expect((await daemon.handleOperatorRequest({ requestId: randomUUID(), method: "owner.approveRoleAttachment",
      params: { ...params, approved: true } }, { ...operator, actor: "not-owner" })).allowed).toBe(false);
    expect((await daemon.handleOperatorRequest({ requestId: randomUUID(), method: "owner.approveRoleAttachment",
      params: { ...params, approved: true } })).allowed).toBe(false);
    expect((await request("owner.approveRoleAttachment", { ...params, approved: true })).allowed).toBe(true);
  });

  it("one admitted approval issues only one credential", () => {
    const receipt = approval();
    expect(issue(receipt).allowed).toBe(true);
    expect(issue(receipt).allowed).toBe(false);
  });

  it("unknown approval fields cannot create a second consumption", () => {
    const receipt = approval();
    expect(h.cp.ownerAuthority.assertApproval(receipt).allowed).toBe(true);
    expect(issue(receipt).allowed).toBe(true);
    const extendedReceipt = { ...receipt, ignored: "x" };
    const retry = issue(extendedReceipt);
    expect({ allowed: retry.allowed, consumptions: h.cp.db.all(
      "SELECT * FROM audit_events WHERE kind = 'OWNER_APPROVAL_CONSUMED'",
    ).length }).toEqual({ allowed: false, consumptions: 1 });
  });

  it("operator retries never re-serve a plaintext attachment credential", async () => {
    const input = { requestId: randomUUID(), idempotencyKey: randomUUID(), method: "roleAttachment.issue",
      params: { ...subject, roleKey, approval: approval() } };
    const first = await daemon.handleOperatorRequest(input, operator);
    expect(first.allowed).toBe(true);
    const retry = await daemon.handleOperatorRequest(input, operator);
    expect(retry.allowed).toBe(false);
    expect(JSON.stringify(retry)).not.toContain((valueOf(first) as AttachmentCredential).attachmentSecret);
  });

  it("approval cannot follow a holder into a new registry generation", () => {
    const receipt = approval();
    advance();
    valueOf(h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: "attachment-project",
      ...subject, conversation: "REPLACED", reason: "return to original subject" }));
    expect(issue(receipt).allowed).toBe(false);
    expect(issue().allowed).toBe(true);
  });

  it("authorization rejects a wrong attachment secret", () => {
    const credential = grant();
    expect(daemon.attachments.authorize({ ...credential, attachmentSecret: "wrong" }).allowed).toBe(false);
    expect(daemon.attachments.authorize(credential).allowed).toBe(true);
  });

  it("client declared identity and generation cannot change attachment scope", () => {
    const credential = grant();
    for (const override of [{ sessionId: ready().sessionId }, { bindingGeneration: 999 },
      { roleKey: "PRIMARY_CTO:other" }, { assignmentId: "other" }, { sessionIncarnation: "other" }]) {
      expect(daemon.attachments.authorize({ ...credential, ...override }).allowed).toBe(false);
    }
    expect(daemon.attachments.authorize(credential).allowed).toBe(true);
  });

  it("authorization permanently invalidates a non-ACTIVE generation", () => {
    const credential = grant();
    advance();
    expect(daemon.attachments.authorize(credential).allowed).toBe(false);
    expect(daemon.attachments.connect(server(), port, credential).allowed).toBe(false);
  });

  const expectSuccessorAcquires = (route: "port" | "credential") => {
    const former = subject;
    const credential = grant();
    const binding = h.cp.bindings.active(roleKey)!;
    const incumbent = server();
    valueOf(daemon.attachments.connect(incumbent, port, credential));
    subject = advance("SURVIVED");
    const successorCredential = grant();
    const successor = server();
    // No authorization, connected(), endpoint registration or detach of A between transfer
    // and B's attach. The admission path must discover and clear the stale incumbent itself.
    let detachSuccessor: () => void;
    if (route === "port") {
      detachSuccessor = port.attach(successor, () => daemon.attachments.authorize(successorCredential), roleKey);
    } else {
      const connected = daemon.attachments.connect(successor, port, successorCredential);
      expect(connected.allowed).toBe(true);
      detachSuccessor = valueOf(connected);
    }
    // The port has no ledger: reaching that refusal proves B owns the receiving server slot.
    expect(port.claimOwnerMessage(successor, roleKey).reasonCode).toBe(ReasonCode.ROLE_PEER_UNSUPPORTED);
    detachSuccessor();
    expect(port.connected(roleKey)).toBe(false);
    valueOf(h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: "attachment-project",
      ...former, conversation: "SURVIVED", reason: "return to former holder" }));
    expect(h.cp.bindings.active(roleKey)).toMatchObject({
      assignmentId: binding.assignmentId, bindingGeneration: binding.bindingGeneration,
    });
    expect(daemon.attachments.authorize(credential).allowed).toBe(false);
  };

  it("a same-generation successor acquires the slot via port", () => expectSuccessorAcquires("port"));
  it("a same-generation successor acquires the slot via credential", () => expectSuccessorAcquires("credential"));

  it("late detach of a former server preserves its successor", () => {
    const former = subject;
    const identity = (holder: typeof subject) => () => allow(ReasonCode.OK, {
      actor: holder.sessionId, sessionId: holder.sessionId,
      sessionIncarnation: h.cp.sessions.require(holder.sessionId).incarnation,
    });
    const detachFormer = port.attach(server(), identity(former));
    subject = advance("SURVIVED");
    // Ordinary session authentication remains valid for A. The port must check the registry.
    const detachSuccessor = port.attach(server(), identity(subject));
    detachFormer();
    expect(port.connected(roleKey)).toBe(true);
    detachSuccessor();
    expect(port.connected(roleKey)).toBe(false);
  });

  it("an admitted connection authenticates without retaining the caller credential", () => {
    const credential = grant();
    const attachmentId = credential.attachmentId;
    const attach = vi.spyOn(port, "attach");
    valueOf(daemon.attachments.connect(server(), port, credential));
    const authenticate = attach.mock.calls[0]![1];
    credential.attachmentSecret = "discarded by caller";
    credential.attachmentId = "discarded by caller";
    expect(authenticate().allowed).toBe(true);
    valueOf(daemon.attachments.revoke({ ...subject, attachmentId }));
    expect(authenticate().allowed).toBe(false);
  });

  it("connect refuses an occupied slot without consuming a pending credential", () => {
    const credential = grant();
    const incumbent = server();
    const detach = port.attach(incumbent, () => allow(ReasonCode.OK, { actor: subject.sessionId,
      sessionId: subject.sessionId, sessionIncarnation: credential.sessionIncarnation }));
    const binding = h.cp.bindings.active(roleKey);
    expect(daemon.attachments.connect(server(), port, credential).allowed).toBe(false);
    expect(h.cp.bindings.active(roleKey)).toEqual(binding);
    detach();
    expect(daemon.attachments.connect(server(), port, credential).allowed).toBe(true);
  });

  it("an attachment never auto-authorizes a sibling role held by the same subject", () => {
    const manifest = fixtureManifest("attachment-sibling");
    valueOf(h.cp.projects.register({ projectId: manifest.projectId, name: "fixture", manifest,
      authorization: h.cp.manifestAuthorizationForTests(manifest) }));
    const sibling = valueOf(h.cp.bindings.bind({ role: Role.PRIMARY_CTO,
      projectId: manifest.projectId, sessionId: subject.sessionId }));
    const scopedPort = new RoleConversationPort(Role.PRIMARY_CTO, {
      active: (key) => h.cp.bindings.active(key),
      currentCandidates: () => [h.cp.bindings.active(roleKey)!, sibling],
    });
    valueOf(daemon.attachments.connect(server(), scopedPort, grant()));
    expect(scopedPort.connected(roleKey)).toBe(true);
    expect(scopedPort.connected(sibling.roleKey)).toBe(false);
  });

  it("one credential cannot admit two simultaneous connections even to another port", () => {
    const credential = grant();
    valueOf(daemon.attachments.connect(server(), port, credential));
    const otherPort = new RoleConversationPort(Role.PRIMARY_CTO, {
      active: (key) => h.cp.bindings.active(key), currentCandidates: () => [h.cp.bindings.active(roleKey)!],
    });
    expect(daemon.attachments.connect(server(), otherPort, credential).allowed).toBe(false);
  });

  it("explicit detach frees the slot and invalidates its credential", () => {
    const credential = grant();
    const detach = valueOf(daemon.attachments.connect(server(), port, credential));
    expect(port.connected(roleKey)).toBe(true);
    detach();
    expect(port.connected(roleKey)).toBe(false);
    expect(daemon.attachments.authorize(credential).allowed).toBe(false);
    expect(daemon.attachments.connect(server(), port, credential).allowed).toBe(false);
    expect(h.cp.sessions.verifySecret(subject.sessionId, subject.sessionSecret).allowed).toBe(true);
  });

  it("only the authenticated subject can revoke its attachment", () => {
    const credential = grant();
    valueOf(daemon.attachments.connect(server(), port, credential));
    const attachmentId = credential.attachmentId;
    expect(daemon.attachments.revoke({ ...ready(), attachmentId }).allowed).toBe(false);
    expect(daemon.attachments.revoke({ ...subject, sessionSecret: "wrong", attachmentId }).allowed).toBe(false);
    expect(daemon.attachments.authorize(credential).allowed).toBe(true);
    expect(daemon.attachments.revoke({ ...subject, attachmentId }).allowed).toBe(true);
    expect(port.connected(roleKey)).toBe(false);
    expect(daemon.attachments.authorize(credential).allowed).toBe(false);
    expect(h.cp.sessions.verifySecret(subject.sessionId, subject.sessionSecret).allowed).toBe(true);
  });

  it("a stopped subject loses attachment authorization", () => {
    const credential = grant();
    valueOf(daemon.attachments.connect(server(), port, credential));
    valueOf(h.cp.sessions.transition(subject.sessionId, SessionLifecycle.STOPPED));
    expect(daemon.attachments.authorize(credential).allowed).toBe(false);
    expect(port.connected(roleKey)).toBe(false);
  });

  it("daemon reconstruction restores neither credentials nor approval consumption authority", () => {
    const receipt = approval();
    const credential = valueOf(issue(receipt));
    const fresh = new Daemon(h.cp, { stateDir: tempDir("at-") });
    expect(fresh.attachments.authorize(credential).allowed).toBe(false);
    expect(fresh.attachments.issue({ ...subject, roleKey, approval: receipt }).allowed).toBe(false);
    const stored = JSON.stringify(h.cp.db.all("SELECT * FROM sessions")) +
      JSON.stringify(h.cp.db.all("SELECT * FROM audit_events")) +
      JSON.stringify(h.cp.db.all("SELECT * FROM inbound_messages"));
    expect(stored).not.toContain(credential.attachmentSecret);
    expect(stored).not.toContain(subject.sessionSecret);
  });
});
