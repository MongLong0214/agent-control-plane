import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { OwnerApprovalReceipt, OwnerAuthorityPort } from "../ceo/owner-authority.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { Role, SessionLifecycle } from "../domain/types.ts";
import type { RoleConversationPort } from "../mcp/role-conversation.ts";
import { type AuthenticatedMcpPeer, respond } from "../mcp/shared.ts";
import type { BindingRegistry } from "./binding-registry.ts";
import type { SessionRegistry } from "./session-registry.ts";

export const ROLE_ATTACHMENT_OPERATION = "roleAttachment.issue";

export interface AttachmentScope {
  sessionId: string;
  sessionIncarnation: string;
  roleKey: string;
  assignmentId: string;
  bindingGeneration: number;
}

export interface AttachmentCredential extends AttachmentScope {
  attachmentId: string;
  attachmentSecret: string;
}

interface AttachmentRecord {
  scope: AttachmentScope;
  secretHash: Buffer;
  attached: boolean;
  detach?: () => void;
}

const subjectSchema = z.object({ sessionId: z.string().min(1), sessionSecret: z.string().min(1) });
// This is strip-normalisation, not rejection: callers may send extra fields, which are discarded.
// Authorization and single-use consumption receive only this normal form of OwnerApprovalReceipt.
export const approvalSchema = z.object({
  channel: z.string(), actor: z.string(), inboundNonce: z.string(), runId: z.string().nullable(),
  candidateSnapshotDigest: z.string().nullable(), operation: z.string(), parameterDigest: z.string(),
  idempotencyKey: z.string(), approved: z.boolean(),
}) satisfies z.ZodType<OwnerApprovalReceipt>;
const issueSchema = subjectSchema.extend({ roleKey: z.string().min(1), approval: approvalSchema });
const credentialSchema = z.object({
  attachmentId: z.string().min(1), attachmentSecret: z.string().min(1),
  sessionId: z.string().min(1), sessionIncarnation: z.string().min(1), roleKey: z.string().min(1),
  assignmentId: z.string().min(1), bindingGeneration: z.number().int().positive(),
});
const hash = (secret: string): Buffer => createHash("sha256").update(secret).digest();
const refused = (message: string): Decision<never> => deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, message);

/**
 * Daemon-local attachment authority. Retains hashes only; no session credential is changed.
 * Credentials are single-admission bearer tokens, not proof of the issuing process's identity.
 * A copied token can be admitted with the listener's deployment token before its first use.
 */
export class RoleAttachmentCredentials {
  readonly #records = new Map<string, AttachmentRecord>();

  constructor(
    private readonly sessions: SessionRegistry,
    private readonly bindings: BindingRegistry,
    private readonly owner: OwnerAuthorityPort,
  ) {}

  /** Parameters an authenticated owner approves, read from the ACTIVE registry. */
  scope(sessionId: string, roleKey: string): Decision<AttachmentScope> {
    const binding = this.bindings.active(roleKey);
    const session = this.sessions.get(sessionId);
    if (!binding || binding.role !== Role.PRIMARY_CTO || binding.sessionId !== sessionId ||
        !session || binding.sessionIncarnation !== session.incarnation ||
        (session.lifecycle !== SessionLifecycle.READY && session.lifecycle !== SessionLifecycle.DRAINING)) {
      return deny(ReasonCode.BINDING_GENERATION_STALE, "attachment requires the current live primary holder");
    }
    return allow(ReasonCode.OK, {
      sessionId, roleKey, sessionIncarnation: session.incarnation,
      assignmentId: binding.assignmentId, bindingGeneration: binding.bindingGeneration,
    });
  }

  issue(input: unknown): Decision<AttachmentCredential> {
    const parsed = issueSchema.safeParse(input);
    if (!parsed.success) return refused("attachment issuance requires session authentication and owner approval");
    const { sessionId, sessionSecret, roleKey } = parsed.data;
    const authenticated = this.sessions.verifySecret(sessionId, sessionSecret);
    if (!authenticated.allowed) return authenticated;
    const scope = this.scope(sessionId, roleKey);
    if (!scope.allowed) return scope;
    const approval = parsed.data.approval;
    if (!approval || approval.approved !== true || approval.operation !== ROLE_ATTACHMENT_OPERATION ||
        approval.runId !== null || approval.parameterDigest !== digestOf(scope.value)) {
      return deny(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE, "owner decision must approve this attachment generation");
    }
    const consumed = this.owner.consumeApproval(approval, null);
    if (!consumed.allowed) return consumed;
    const attachmentId = randomUUID();
    const attachmentSecret = randomBytes(32).toString("hex");
    this.#records.set(attachmentId, { scope: scope.value, secretHash: hash(attachmentSecret), attached: false });
    return allow(ReasonCode.OK, { ...scope.value, attachmentId, attachmentSecret });
  }

  /** Rechecked on every authorized operation, including after a connection has attached. */
  authorize(input: unknown): Decision<AuthenticatedMcpPeer> {
    const parsed = credentialSchema.safeParse(input);
    if (!parsed.success) return refused("attachment credential is incomplete");
    const credential = parsed.data;
    const record = this.#records.get(credential.attachmentId);
    if (!record || !timingSafeEqual(record.secretHash, hash(credential.attachmentSecret))) {
      return refused("attachment credential is unknown or invalid");
    }
    const { attachmentId: _id, attachmentSecret: _secret, ...presentedScope } = credential;
    if (digestOf(presentedScope) !== digestOf(record.scope)) return refused("attachment scope does not match issuance");
    return this.#authorizeRecord(credential.attachmentId, record);
  }

  #authorizeRecord(attachmentId: string, record: AttachmentRecord): Decision<AuthenticatedMcpPeer> {
    if (this.#records.get(attachmentId) !== record) return refused("attachment has been invalidated");
    const current = this.scope(record.scope.sessionId, record.scope.roleKey);
    if (!current.allowed || digestOf(current.value) !== digestOf(record.scope)) {
      this.#invalidate(attachmentId);
      return deny(ReasonCode.BINDING_GENERATION_STALE, "attachment generation is no longer ACTIVE");
    }
    return allow(ReasonCode.OK, { actor: record.scope.sessionId,
      sessionId: record.scope.sessionId, sessionIncarnation: record.scope.sessionIncarnation });
  }

  /** Consumes admission once. Detach is also callable without any transport for authorization tests. */
  connect(server: McpServer, port: RoleConversationPort, credential: AttachmentCredential): Decision<() => void> {
    const authorized = this.authorize(credential);
    if (!authorized.allowed) return authorized;
    const attachmentId = credential.attachmentId;
    const record = this.#records.get(attachmentId)!;
    if (record.attached) return refused("attachment credential has already admitted a connection");
    if (port.role !== Role.PRIMARY_CTO || port.currentHolderConnected(record.scope.roleKey)) {
      return deny(ReasonCode.CONFLICT, "attachment requires an empty role slot");
    }
    // Admission already proved the secret. Retain only the ID and hash/scope record in callbacks.
    const detach = port.attach(server, () => this.#authorizeRecord(attachmentId, record), record.scope.roleKey);
    if (!port.connected(record.scope.roleKey)) return refused("attachment did not acquire its role slot");
    record.attached = true;
    record.detach = detach;
    const close = () => this.#invalidate(attachmentId);
    const previousClose = server.server.onclose;
    server.server.onclose = () => { close(); previousClose?.(); };
    server.registerTool("role_wake_endpoint_register", {
      description: "Register this connection's wake endpoint.", inputSchema: { endpoint: z.string().min(1) },
    }, async ({ endpoint }) => respond(await port.registerEndpoint(server, endpoint)));
    server.registerTool("role_owner_message_claim", {
      description: "Take an owner message for this connection's role.", inputSchema: { roleKey: z.string().min(1) },
    }, async ({ roleKey }) => respond(port.claimOwnerMessage(server, roleKey)));
    server.registerTool("role_owner_message_complete", {
      description: "Complete a message held by this connection.",
      inputSchema: { roleKey: z.string().min(1), messageId: z.string().min(1) },
    }, async ({ roleKey, messageId }) => respond(port.completeOwnerMessage(server, roleKey, messageId)));
    server.registerTool("role_owner_message_reject", {
      description: "Reject a message held by this connection.",
      inputSchema: { roleKey: z.string().min(1), messageId: z.string().min(1) },
    }, async ({ roleKey, messageId }) => respond(port.rejectOwnerMessage(server, roleKey, messageId)));
    return allow(ReasonCode.OK, close);
  }

  revoke(input: unknown): Decision<void> {
    const parsed = subjectSchema.extend({ attachmentId: z.string().min(1) }).safeParse(input);
    if (!parsed.success) return refused("attachment revocation requires session authentication");
    const { sessionId, sessionSecret, attachmentId } = parsed.data;
    const authenticated = this.sessions.verifySecret(sessionId, sessionSecret);
    if (!authenticated.allowed) return authenticated;
    const record = this.#records.get(attachmentId);
    if (!record || record.scope.sessionId !== sessionId || record.scope.sessionIncarnation !== authenticated.value.incarnation) {
      return refused("attachment does not belong to the authenticated subject");
    }
    this.#invalidate(attachmentId);
    return allow(ReasonCode.OK, undefined);
  }

  #invalidate(attachmentId: string): void {
    const record = this.#records.get(attachmentId);
    this.#records.delete(attachmentId);
    record?.detach?.();
  }
}
