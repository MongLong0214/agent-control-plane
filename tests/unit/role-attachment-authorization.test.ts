import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { queryObjects } from "node:v8";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OwnerApprovalReceipt } from "../../src/ceo/owner-authority.ts";
import { digestOf } from "../../src/core/digest.ts";
import { type Decision, allow } from "../../src/core/errors.ts";
import { approvalSchema, type AttachmentCredential } from "../../src/session/role-attachment-credentials.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ExecutionMode, Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
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
  const approval = (overrides: Partial<{ approved: boolean; operation: string; parameters: unknown; runId: string }> = {}) => {
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
    const receipt = valueOf(result) as OwnerApprovalReceipt;
    expect(receipt).toMatchObject({ approved: true, operation: "roleAttachment.issue", runId: null,
      parameterDigest: digestOf(valueOf(daemon.attachments.scope(subject.sessionId, roleKey))) });
    expect(h.cp.ownerAuthority.assertApproval(receipt).allowed).toBe(true);
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
    const detachFirst = port.attach(first, auth, roleKey);
    const detachSecond = port.attach(second, auth, roleKey);
    detachSecond();
    expect(port.connected(roleKey)).toBe(true);
    detachFirst();
    expect(port.connected(roleKey)).toBe(false);
  });

  it("an ordinary reconnect acquires its holder slot before the incumbent closes", () => {
    const credential = grant();
    const auth = () => allow(ReasonCode.OK, { actor: subject.sessionId,
      sessionId: subject.sessionId, sessionIncarnation: credential.sessionIncarnation });
    const first = server();
    const second = server();
    const detachFirst = port.attach(first, auth);
    const detachSecond = port.attach(second, auth);
    expect(port.claimOwnerMessage(second, roleKey).reasonCode).toBe(ReasonCode.ROLE_PEER_UNSUPPORTED);
    expect(port.claimOwnerMessage(first, roleKey).allowed).toBe(false);
    detachFirst();
    expect(port.claimOwnerMessage(second, roleKey).reasonCode).toBe(ReasonCode.ROLE_PEER_UNSUPPORTED);
    detachSecond();
    expect(port.connected(roleKey)).toBe(false);
  });

  it("issuance rejects a wrong session secret without spending the approval", () => {
    const receipt = approval();
    expect(issue(receipt, { sessionSecret: "wrong" }).allowed).toBe(false);
    expect(issue(receipt).allowed).toBe(true);
  });

  it("another authenticated subject cannot spend the holder approval", () => {
    const receipt = approval();
    const other = ready();
    expect(issue(receipt, other).allowed).toBe(false);
    expect(issue(receipt).allowed).toBe(true);
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

  it("an otherwise valid run-bound approval cannot issue an attachment", () => {
    const run = valueOf(h.cp.runs.create({ projectId: "attachment-project", executionMode: ExecutionMode.STANDARD,
      contract: { goal: "attachment scope", why: "isolate the run-bound refusal", scope: [], nonGoals: [],
        acceptance: ["run approvals cannot issue attachments"], priority: "NORMAL", humanGate: [], references: [] } }));
    const receipt = approval({ runId: run.runId });
    expect(h.cp.ownerAuthority.assertApproval(receipt).allowed).toBe(true);
    const consume = vi.spyOn(h.cp.ownerAuthority, "consumeApproval");
    try {
      expect(issue(receipt)).toMatchObject({ allowed: false,
        reasonCode: ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        message: "owner decision must approve this attachment generation" });
      expect(consume).not.toHaveBeenCalled();
      expect(h.cp.ownerAuthority.consumeApproval(receipt, null).allowed).toBe(true);
      expect(issue().allowed).toBe(true);
    } finally {
      consume.mockRestore();
    }
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

  it("approval schema matches declared keys and consumption proves the same normal-form object", () => {
    // Interfaces are erased at runtime. Derive their keys from the real declaration with
    // the type checker, including optional/inherited fields, rather than a second field list.
    const path = fileURLToPath(new URL("../../src/ceo/owner-authority.ts", import.meta.url));
    const program = ts.createProgram([path], { types: [], noEmit: true });
    const checker = program.getTypeChecker();
    const module = checker.getSymbolAtLocation(program.getSourceFile(path)!)!;
    const declaration = checker.getExportsOfModule(module).find((symbol) => symbol.name === "OwnerApprovalReceipt")!;
    const receiptFields = checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(declaration))
      .map((symbol) => symbol.name).sort();
    expect(Object.keys(approvalSchema.shape).sort()).toEqual(receiptFields);

    const receipt = approval();
    const owner = h.cp.ownerAuthority;
    // Identity and key equality do not establish which fields the proof depends on.
    const proof = vi.spyOn(owner, "assertApproval");
    const consumption = vi.spyOn(owner, "consumeApproval");
    try {
      // An extended first presentation must succeed after stripping, not be rejected.
      const extendedReceipt = { ...receipt, ignored: "caller metadata" };
      expect(issue(extendedReceipt).allowed).toBe(true);
      expect(consumption).toHaveBeenCalledExactlyOnceWith(receipt, null);
      const consumed = consumption.mock.calls[0]![0];
      expect(consumed).toStrictEqual(receipt);
      expect(Object.keys(consumed).sort()).toEqual(receiptFields);
      expect(proof).toHaveBeenCalledExactlyOnceWith(consumed);
      expect(proof.mock.calls[0]![0]).toBe(consumed);
      expect(proof.mock.results[0]!.value.allowed).toBe(true);
      const records = h.cp.db.all<{ evidence_json: string }>(
        "SELECT evidence_json FROM audit_events WHERE kind = 'OWNER_APPROVAL_CONSUMED'",
      );
      expect(records).toHaveLength(1);
      expect(JSON.parse(records[0]!.evidence_json).receiptDigest).toBe(digestOf(consumed));
    } finally {
      proof.mockRestore();
      consumption.mockRestore();
    }
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

  it("a committed generation change permanently invalidates the credential", () => {
    const credential = grant();
    const binding = h.cp.bindings.active(roleKey)!;
    advance();
    expect(daemon.attachments.authorize(credential).allowed).toBe(false);
    // Restoring the former registry view must not revive the deleted credential.
    const active = vi.spyOn(h.cp.bindings, "active").mockReturnValue(binding);
    try {
      expect(daemon.attachments.scope(subject.sessionId, roleKey).allowed).toBe(true);
      expect(daemon.attachments.authorize(credential).allowed).toBe(false);
      expect(daemon.attachments.connect(server(), port, credential).allowed).toBe(false);
    } finally {
      active.mockRestore();
    }
  });

  it.each([
    { attached: false, nested: false }, { attached: true, nested: false },
    { attached: false, nested: true }, { attached: true, nested: true },
  ])("an unobserved same-generation round trip permanently revokes an attachment: %j", ({ attached, nested }) => {
    const credential = grant();
    const binding = h.cp.bindings.active(roleKey)!;
    const peer = server();
    if (attached) valueOf(daemon.attachments.connect(peer, port, credential));
    const roundTrip = () => {
      advance("SURVIVED");
      valueOf(h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: "attachment-project",
        ...subject, conversation: "SURVIVED", reason: "unobserved return" }));
    };
    if (nested) h.cp.db.tx(roundTrip);
    else roundTrip();
    expect(h.cp.bindings.active(roleKey)).toEqual(binding);
    // No authorization, lookup, or admission ran during the round trip.
    expect(daemon.attachments.authorize(credential)).toMatchObject({ allowed: false,
      reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED, message: "attachment credential is unknown or invalid" });
    expect(daemon.attachments.connect(server(), port, credential).allowed).toBe(false);
    expect(port.connected(roleKey)).toBe(false);
    expect(h.cp.sessions.verifySecret(subject.sessionId, subject.sessionSecret).allowed).toBe(true);
  });

  it("committed transfers detach immediately and rolled-back transfers preserve attachments", () => {
    const credential = grant();
    valueOf(daemon.attachments.connect(server(), port, credential));
    expect(() => h.cp.db.tx(() => { advance("SURVIVED"); throw new Error("rollback transfer"); }))
      .toThrow("rollback transfer");
    // An unrelated commit must not flush a notification left behind by rollback.
    h.cp.db.tx(() => {});
    expect(port.connected(roleKey)).toBe(true);
    expect(daemon.attachments.authorize(credential).allowed).toBe(true);
    h.cp.db.tx(() => {
      advance("SURVIVED");
      expect(port.connected(roleKey)).toBe(true);
    });
    expect(port.connected(roleKey)).toBe(false);
  });

  it("transfer notification retains its identity when the returned binding is edited", () => {
    const credential = grant();
    const other = ready();
    h.cp.db.tx(() => {
      const moved = valueOf(h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: "attachment-project",
        ...other, conversation: "SURVIVED", reason: "move before commit" }));
      moved.sessionId = credential.sessionId;
      moved.sessionIncarnation = credential.sessionIncarnation;
      valueOf(h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: "attachment-project",
        ...subject, conversation: "SURVIVED", reason: "return before commit" }));
    });
    expect(daemon.attachments.authorize(credential).allowed).toBe(false);
  });

  it("a fresh attachment after a round trip survives later commits", () => {
    const old = grant();
    advance("SURVIVED");
    valueOf(h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: "attachment-project",
      ...subject, conversation: "SURVIVED", reason: "return for fresh approval" }));
    expect(daemon.attachments.authorize(old).allowed).toBe(false);
    const fresh = grant();
    valueOf(daemon.attachments.connect(server(), port, fresh));
    h.cp.db.tx(() => {});
    expect(daemon.attachments.authorize(fresh).allowed).toBe(true);
    expect(port.connected(roleKey)).toBe(true);
  });

  it("authorization rejects a noncurrent snapshot without repairing stored ownership", () => {
    const credential = grant();
    valueOf(daemon.attachments.connect(server(), port, credential));
    const binding = h.cp.bindings.active(roleKey)!;
    const active = vi.spyOn(h.cp.bindings, "active").mockReturnValue({ ...binding, bindingGeneration: 999 });
    try {
      expect(daemon.attachments.authorize(credential).allowed).toBe(false);
      expect(port.endpointFor(roleKey)).toBeNull();
      expect(port.connected(roleKey)).toBe(true);
    } finally {
      active.mockRestore();
    }
    // Reading an inconsistent view cannot manufacture a transfer or a revocation.
    expect(daemon.attachments.authorize(credential).allowed).toBe(true);
  });

  it("an unchanged holder and a sibling transfer preserve the approved attachment", () => {
    const credential = grant();
    valueOf(daemon.attachments.connect(server(), port, credential));
    valueOf(h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: "attachment-project",
      ...subject, conversation: "SURVIVED", reason: "same holder" }));
    expect(daemon.attachments.authorize(credential).allowed).toBe(true);
    const manifest = fixtureManifest("attachment-sibling");
    valueOf(h.cp.projects.register({ projectId: manifest.projectId, name: "fixture", manifest,
      authorization: h.cp.manifestAuthorizationForTests(manifest) }));
    valueOf(h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: manifest.projectId, ...subject }));
    valueOf(h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: manifest.projectId,
      ...ready(), conversation: "SURVIVED", reason: "move sibling" }));
    expect(daemon.attachments.authorize(credential).allowed).toBe(true);
    expect(port.connected(roleKey)).toBe(true);
  });

  const expectSuccessorAcquires = (route: "port" | "credential") => {
    const former = subject;
    const credential = grant();
    const binding = h.cp.bindings.active(roleKey)!;
    const incumbent = server();
    // An ordinary socket is not detached by attachment revocation. Admission must repair it.
    port.attach(incumbent, () => allow(ReasonCode.OK, { actor: former.sessionId,
      sessionId: former.sessionId, sessionIncarnation: credential.sessionIncarnation }));
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
    class CallerCredential {}
    const attach = vi.spyOn(port, "attach");
    const attachmentId = (() => {
      const credential = Object.assign(new CallerCredential(), grant());
      const id = credential.attachmentId;
      valueOf(daemon.attachments.connect(server(), port, credential));
      credential.attachmentSecret = "discarded by caller";
      credential.attachmentId = "discarded by caller";
      expect(attach.mock.calls[0]![1]().allowed).toBe(true);
      return id;
    })();
    // queryObjects runs a full GC. The live authenticator must not keep the caller's
    // object reachable, even if it no longer reads that object's secret to authenticate.
    expect(queryObjects(CallerCredential, { format: "count" })).toBe(0);
    const authenticate = attach.mock.calls[0]![1];
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
  });

  it("daemon object reconstruction on the same ControlPlane forgets credentials and retains approval consumption", () => {
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
