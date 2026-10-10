#!/usr/bin/env node
import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AttachmentCredential, RoleAttachmentCredentials } from "../session/role-attachment-credentials.ts";

import { ControlPlane, defaultConfig, type ControlPlaneConfig } from "../app/control-plane.ts";
import { COLLECTOR_TIMEOUT_MS } from "../capacity/usage-collectors.ts";
import { REPOSITORY_SWEEP_BUDGET_MS } from "../doctor/doctor.ts";
import {
  DEFAULT_RUNTIME_TIMEOUT_MS as HERMES_RUNTIME_TIMEOUT_MS,
  createHermesBootstrapAuthority,
  type HermesBootstrapAuthority,
} from "../bootstrap/hermes-bootstrap.ts";
import {
  createHermesIncumbentAdoption,
  type AutomaticAdoptionIncumbent,
  type GatewayIncumbentProof,
} from "../bootstrap/hermes-incumbent-adoption.ts";
import {
  createHermesAutoAdoption,
  type HermesAutoAdoption,
  type HermesAutoAdoptionOptions,
} from "../bootstrap/hermes-auto-adoption.ts";
import {
  headAdvanceTransaction,
  judgeLiveHead,
  readHermesTargetHead,
  recordHeadAdvance,
} from "../session/hermes-target-head.ts";
import {
  createAdoptedCeoToolAdmission,
  type AdoptedCeoToolAdmission,
} from "../bootstrap/adopted-ceo-tool-admission.ts";
import { createHermesGatewayIdentityReader } from "../runtime/hermes-gateway-identity.ts";
import {
  createHermesGatewayConversationSender,
  createHermesGatewayDaemonNoticeSender,
} from "../runtime/hermes-gateway-conversation.ts";
import {
  type DaemonNoticeDeliveryReport,
  type DaemonNoticeProbeReport,
  type DaemonNoticeTargetResolver,
  deliverOwedPeerMessageNotices,
  sendDaemonNoticeProbe,
} from "../runtime/acp-daemon-notice.ts";
import {
  SELF_CLAIM_EXECUTOR_KIND,
  assertCanonicalSessionsValid,
  canonicalBuzzChannelFor,
  unsubscribedRoomRefusal,
  type CanonicalAdoptableSession,
  type SubscribedBuzzRooms,
} from "../registry/canonical-self-claim.ts";
import { readProcessStartToken } from "../core/process-argv.ts";
import { processStartedAt } from "../core/process-identity.ts";
import { BuzzAdapter, BuzzCliTransport } from "../buzz/buzz-adapter.ts";
import { BuzzBindChallenges, buzzBindContentOf } from "../buzz/buzz-bind-challenge.ts";
import {
  BUZZ_MENTION_ADDRESSED_TO,
  nativeSubscriberScheduler,
  startBuzzMentionSubscriberFromStateDir,
  type BuzzMentionAdmission,
  type BuzzMentionAdmissionReporter,
  type BuzzMentionAdmissionRequest,
  type BuzzMentionDeliveryBinding,
  type BuzzMentionIdentityJudgement,
  type BuzzMentionRegistry,
  type BuzzMentionSink,
  type BuzzMentionSubscriberHandle,
  type BuzzMentionVerdict,
  type BuzzRelaySocketFactory,
  type BuzzSubscriberIdentityRooms,
  type BuzzSubscriberScheduler,
} from "../buzz/buzz-mention-subscriber.ts";
import { OwnerReplyConsumer, type OwnerReplyTimers } from "../conversation/owner-reply-consumer.ts";
import type { OwnerIdentity } from "../ceo/owner-authority.ts";
import { canonicalTurnTarget } from "../conversation/canonical-turn-target.ts";
import { type Decision, allow, deny, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { recordMigrationRefusal } from "../db/migration-approval.ts";
import {
  BuzzActorIngress,
  IngressGuard,
  ingressSignature,
  isTransportRetentionUnknown,
  type IngressPolicy,
} from "../ingress/ingress-guard.ts";
import {
  BUZZ_MESSAGE_NONCE_PREFIX,
  BuzzMessageIngress,
  buzzMessageNonce,
  buzzMessageSigningRequest,
  deliverBuzzMessage,
  ownerMessagePointerOf,
  peerMessageRefusalNoticeOf,
  peerProofIsCurrent,
  selfClaimCarriedTo,
  type BuzzMentionRouter,
  type BuzzMessageIngressInput,
  type BuzzMessageTurnPort,
  type AdmittedPeerSource,
  type BuzzPeerRegistry,
  type CeoTurnDelivery,
} from "../ingress/buzz-message.ts";
import {
  configuredTelegramExternalConsumerConfig,
  configuredTelegramLongPollConfig,
  startTelegramLongPollListener,
  type TelegramBotTransport,
  type TelegramExternalConsumerConfig,
  type TelegramLongPollStartOptions,
  type TelegramLongPollListener,
} from "../ingress/telegram-polling.ts";
import {
  TELEGRAM_EXTERNAL_MAX_REQUEST_BYTES,
  TELEGRAM_EXTERNAL_SOCKET_NAME,
  TelegramExternalUpdateLane,
  type TelegramExternalAnswer,
} from "../ingress/telegram-external.ts";
import type { TelegramDirectAnswer } from "../ingress/telegram-router.ts";
import { Role, SessionLifecycle, roleKeyFor, type RoleBinding } from "../domain/types.ts";
import { ProvisionedSessionRuntime } from "../runtime/provisioned-session-runtime.ts";
import type { SessionLaunchCredential } from "../cto/cto-lifecycle.ts";
import { createCtoMcpPort, createCtoServer } from "../mcp/cto-server.ts";
import { createHermesMcpPort, createHermesServer } from "../mcp/hermes-server.ts";
import { CeoConversationPort, type CeoTurnOutcome } from "../mcp/ceo-conversation.ts";
import type { GatewayEventSource } from "../runtime/hermes-gateway-conversation.ts";
import {
  RoleConversationPort,
  type OwnerMessageHandover,
  type OwnerMessageLedger,
  type OwnerMessageProvenance,
  type MentionWakeContext,
  type MentionWakeGate,
} from "../mcp/role-conversation.ts";
import { digestOf, isDigest, sha256 } from "../core/digest.ts";
import { HOLDER_CLAIMED_KINDS, MessageKind } from "../outbox/envelope.ts";
import type { HolderIdentity } from "../outbox/outbox.ts";
import { respond, type AuthenticatedMcpPeer, type McpPeerAuthenticator } from "../mcp/shared.ts";
import type { AuthenticatedOperatorPeer, Daemon } from "./daemon.ts";
import { executeCanonicalSelfClaimOperator } from "./canonical-self-claim-operator.ts";
import {
  startAdoptedCeoToolListener,
  startCanonicalCtoToolListener,
  startCanonicalSelfClaimListener,
  type CanonicalSelfClaimListener,
} from "./canonical-self-claim-listener.ts";
import { createCanonicalCtoReattach, type CanonicalCtoReattach } from "../registry/canonical-cto-reattach.ts";
import { recordedStartIsLive } from "../session/runtime-lineage.ts";
import { readOneJsonLineRequest } from "./local-socket-framing.ts";
import { daemonCtoBindingRuntime, type CtoBindingRuntime } from "./cto-binding-runtime.ts";

/** The exit status of a stop that could not confirm every worker git process group finished. */
const STOP_INCOMPLETE_EXIT_CODE = 75;

/**
 * The bound on one message: the bytes of a single line, terminator excluded, measured after the
 * newline that ends it has been found. Only the two readers that serve a stream of messages —
 * `SocketTransport.processBuffer` and the MCP handshake — measure this, and this comment speaks
 * for them alone. The single-request readers on this daemon's other local sockets bound the whole
 * framed request instead and name `MAX_MCP_FRAMED_REQUEST_BYTES` for it (#816).
 *
 * Until #805 both newline readers on this socket compared it against everything buffered so far,
 * before looking for a boundary. That bounds a read rather than a message, and a read is the one
 * thing neither peer chooses: two messages each within the limit were both refused and the
 * connection destroyed whenever one read happened to deliver the tail of the first alongside the
 * second, while the same bytes succeeded when the reads landed elsewhere. It was weak in the
 * other direction too — a line just under the limit passed with most of another message already
 * behind it, because the comparison ran once per read rather than once per line.
 */
export const MAX_MCP_LINE_BYTES = 1024 * 1024;
/**
 * The bound on input that has not produced a line yet, so a peer that never writes a newline
 * cannot grow the buffer without limit.
 *
 * One number cannot answer both questions, even though this one is derived from the other. A
 * buffer with no newline in it is the prefix of a line, so once it is longer than a line may be,
 * no byte arriving later can make it legal — that is why the value follows `MAX_MCP_LINE_BYTES`
 * rather than being chosen independently. What differs is *when* it is consulted: only while no
 * boundary is present. That is what keeps a complete line of exactly `MAX_MCP_LINE_BYTES`
 * acceptable, since with its terminator such a line occupies one byte more than either bound and
 * would be refused by any check that measured the buffer without first finding the newline.
 */
const MAX_MCP_PENDING_BYTES = MAX_MCP_LINE_BYTES;
/**
 * The bound on one framed request: the whole buffer, the terminating newline included, at the
 * readers on this daemon's single-request local sockets — the session launch credential channel,
 * the two Buzz ingress endpoints, and the operator socket by way of `readOneJsonLineRequest`.
 *
 * Those readers measure the buffer before looking for a boundary and are right to (#805 changed
 * only the two stream readers): each takes exactly one request per connection and refuses any
 * byte after the first newline, so their buffer is that one request rather than whatever a read
 * happened to deliver. What was wrong is that they said `MAX_MCP_LINE_BYTES` while doing it, so a
 * call site could not tell which of the two measurements it was under, and the difference is real:
 * a line of exactly `MAX_MCP_LINE_BYTES` content is a legal message to the transport and one byte
 * too long for these, because here the terminator is counted too (#816).
 *
 * The value is derived rather than chosen, for the reason `MAX_MCP_PENDING_BYTES` is: a second
 * independent number can drift away from the line bound, and nothing about these sockets wants a
 * request budget that is not the message budget. Only the measurement differs, so only the name
 * does.
 */
const MAX_MCP_FRAMED_REQUEST_BYTES = MAX_MCP_LINE_BYTES;
const DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS = 5_000;
/**
 * The handshake budget covers reaching an authenticated request and nothing after it. Execution
 * gets its own, larger one because the two answer different questions: a peer that has not
 * identified itself in five seconds is not going to, while `doctor.run` probes every capacity
 * sensor and measured about six seconds on the deployment host.
 *
 * Running one deadline over both is how a healthy daemon came to answer `OPERATOR_UNAUTHENTICATED`
 * to an operator whose token was correct and whose peer had already been admitted (#609).
 */
export const DEFAULT_OPERATOR_REQUEST_TIMEOUT_MS = 30_000;

/**
 * How many collectors a doctor pass may wait on, one after another. `CapacityMonitor.refresh`
 * loops the adapters sequentially, so the pass costs the sum and not the maximum.
 */
const PROVIDER_BUDGET_SLOTS = 3;

/**
 * Per-method budgets, because one number cannot be right for both `daemon.status` (2ms measured)
 * and `doctor.run`.
 *
 * A flat 30s was chosen against a healthy day — measured 7.4s with three healthy providers — and
 * would have refused the very method it was raised for as soon as two providers went slow, which
 * is #609 again in a different dress. So the doctor's budget is derived from the collector budget
 * rather than picked, and grows when that grows.
 *
 * **Derived from every sequential cost in the pass, not only the collectors.** That sentence was
 * once true about collectors and incomplete about the pass: `checkRepositories` probes each
 * registered repository with two git calls, and until #877 those inherited `git()`'s blanket 120s,
 * so one slow checkout after slow collectors expired this budget and discarded the partial report
 * the doctor had just been taught to preserve. `REPOSITORY_SWEEP_BUDGET_MS` is that sweep's own
 * deadline, and it is a term here so the derivation covers what the pass actually spends.
 *
 * `bootstrap.hermes` gets more than the runtime budget it waits on, for the same reason the
 * client budget exceeds the server's: two equal deadlines racing is how one healthy daemon
 * reported two different reason codes for one failure.
 */
export const OPERATOR_METHOD_BUDGET_MS: Readonly<Record<string, number>> = {
  "doctor.run":
    PROVIDER_BUDGET_SLOTS * COLLECTOR_TIMEOUT_MS
    + REPOSITORY_SWEEP_BUDGET_MS
    + DEFAULT_OPERATOR_REQUEST_TIMEOUT_MS,
  "bootstrap.hermes": HERMES_RUNTIME_TIMEOUT_MS + DEFAULT_OPERATOR_REQUEST_TIMEOUT_MS,
};

/**
 * `configured` scales the whole table rather than replacing one entry. A socket configured with a
 * smaller budget shrinks every method in proportion, which keeps the ratios — the reason
 * `doctor.run` is wider than `daemon.status` does not change because a test wants both faster —
 * and keeps the table reachable from a test at all. An absolute table that ignored the option
 * would have made these budgets unconfigurable and unmeasurable, which is the same thing.
 */
export const operatorMethodBudgetMs = (method: string, configured: number): number => {
  const stated = OPERATOR_METHOD_BUDGET_MS[method];
  if (stated === undefined) return configured;
  const scale = configured / DEFAULT_OPERATOR_REQUEST_TIMEOUT_MS;
  return Math.max(1, Math.round(stated * scale));
};

/** The widest server-side budget any method may take; the client has to outlast it. */
export const MAX_OPERATOR_METHOD_BUDGET_MS = Math.max(
  DEFAULT_OPERATOR_REQUEST_TIMEOUT_MS,
  ...Object.values(OPERATOR_METHOD_BUDGET_MS),
);
// A normal handoff package remains deliverable for thirty minutes. Do not make its recipient's
// one-time bootstrap proof expire sooner than the package it must acknowledge.
const SESSION_LAUNCH_TTL_MS = 30 * 60_000;

export interface LocalMcpListeners {
  socketPaths: readonly string[];
  /** §6.1 DIRECT — the daemon's handle on whoever currently holds the CEO socket. */
  ceoConversation: CeoConversationPort;
  /**
   * The destination for a message addressed to the CTO role (#760 Part B / B2).
   *
   * The CEO field above has existed since the owner-conversation route; this one did not, so an
   * addressed message had nowhere inside the daemon to go and a person carried it.
   */
  ctoConversation: RoleConversationPort;
  close(): Promise<void>;
  /**
   * Opens the canonical CTO's reattach socket (#1037) beside `cto.mcp.sock`: the same CTO server,
   * for a connection the process tree admits instead of a session secret. Closed by `close()`.
   * Resolves to the socket's path.
   */
  openCanonicalCtoReattach(reattach: CanonicalCtoReattach, daemon: { lock: { held(): boolean } }): Promise<string>;
}

/**
 * Main's live listener composition: CEO CONFIRM is handed to the lock-held daemon, and the CTO wake
 * port is handed to its report.
 *
 * The second hand-over is what makes a binding that cannot receive wakes visible. It lives here
 * rather than in `main` so a test holding a real `Daemon` and these real listeners exercises the
 * same line production runs; `setWakeTransportPeers` is optional in this parameter only because
 * several callers pass a bare `finalizeApprovedRun` object, and a real daemon always has it.
 */
export const startDaemonMcpListeners = async (
  cp: ControlPlane,
  stateDir: string,
  token: string,
  daemon: {
    finalizeApprovedRun(runId: string): void | Promise<unknown>;
    attachments?: RoleAttachmentCredentials;
    setWakeTransportPeers?(peers: RoleConversationPort): void;
  },
): Promise<LocalMcpListeners> => {
  const listeners = await startLocalMcpListeners(cp, stateDir, token, {
    onCeoApproved: (runId) => daemon.finalizeApprovedRun(runId),
    ...(daemon.attachments ? { attachments: daemon.attachments } : {}),
  });
  daemon.setWakeTransportPeers?.(listeners.ctoConversation);
  // In-band delivery to an adopted canonical CTO: a row withheld from Buzz wakes the role through
  // the same port a role-addressed Buzz message wakes it through. Then one pass for rows that were
  // queued while no port existed (before a restart, or before these listeners opened); the
  // daemon's delivery tick repeats it, at most once per row per window.
  cp.outbox.attachInBandWake((roleKey, messageIds) => wakeRoleHolder(cp, listeners.ctoConversation, roleKey, {
    kind: "in-band dispatch",
    ids: messageIds ?? [],
  }));
  void cp.outbox.wakeInBandPending();
  return listeners;
};

/**
 * #246 C1b — one wake, routed by who holds the role now: a provisioned session's headless runtime
 * runs (or coalesces) a turn of its conversation; anyone else is knocked on through the conversation
 * port as before. A wake names what it is for, so the runtime can refuse one it already ran; a wake
 * that names nothing (an owner message arrives as a role wake) is its own trigger.
 */
export const wakeRoleHolder = async (
  cp: Pick<ControlPlane, "bindings" | "sessionRuntime">,
  conversation: Pick<RoleConversationPort, "wake">,
  roleKey: string,
  cause: { kind: string; ids: readonly string[] },
): Promise<Decision<void>> => {
  const holder = cp.bindings.active(roleKey);
  if (!holder || !ProvisionedSessionRuntime.drives(holder.role)) return conversation.wake(roleKey);
  const ids = cause.ids.length > 0 ? cause.ids : [`${cause.kind}:${randomUUID()}`];
  const woke = cp.sessionRuntime.wake(roleKey, ids.map((id) => ({ id, kind: cause.kind })));
  return woke.allowed ? allow(ReasonCode.OK, undefined) : (woke as Decision<void>);
};

/** Tests shorten the deadline without weakening the daemon's production default. */
export interface LocalMcpListenerOptions {
  attachments?: RoleAttachmentCredentials;
  handshakeTimeoutMs?: number;
  /** Internal daemon notification after a successful ordinary CEO confirmation. */
  onCeoApproved?: (runId: string) => void | Promise<unknown>;
  /** Lets a test shorten the conversation budget without waiting out the production one. */
  ceoConversation?: CeoConversationPort;
}

/** A one-time, owner-only credential handoff for a runtime that was just constituted. */
export interface LocalSessionLaunchChannel {
  socketPath: string;
  prepare(): Promise<Decision<void>>;
  provision(input: SessionLaunchCredential): Promise<Decision<void>>;
  /**
   * #246 C1b — removes a credential still waiting for its runtime. True when one was there to
   * remove: the runtime never took it. False when none was: it was taken, or never offered.
   */
  withdraw(externalSessionId: string): boolean;
  close(): Promise<void>;
}

/** What a launch channel hands a runtime besides its session credential. */
export interface SessionLaunchChannelOptions {
  /**
   * #246 C1b — the deployment's MCP socket gate (`ACP_MCP_TOKEN`), handed with the credential so
   * a provisioned session's relay can present both on `cto.mcp.sock` without either reaching its
   * argv or environment. Omitted, a reply carries the credential alone, as before.
   */
  mcpToken?: string;
}

/** A daemon-owned local hop from the authenticated Buzz relay to SessionRegistry. */
export interface LocalBuzzActorIngress {
  socketPath: string;
  close(): Promise<void>;
}

/** Hermes' local hop into the Telegram external-consumer lane (U4). */
export interface LocalTelegramExternalIngress {
  socketPath: string;
  lane: TelegramExternalUpdateLane;
  close(): Promise<void>;
}

/** A daemon-owned local hop from the authenticated Buzz relay to the CEO conversation port. */
export interface LocalBuzzMessageIngress {
  socketPath: string;
  /**
   * The exact admission seam this socket serves (#760 Part C).
   *
   * Exposed rather than rebuilt, because the daemon's own relay subscriber now feeds the same
   * path a person's CLI feeds, and *one* seam is the whole requirement: replay refusal, the owner
   * allowlist, the `(buzz, nonce)` slot and the `OWNER_MESSAGE` row all have exactly one authority
   * today. A subscriber that constructed a second ingress and a second port would have made a
   * second one — and the two would agree until the first time a message arrived on both.
   */
  readonly seam: {
    readonly ingress: BuzzMessageIngress;
    readonly port: BuzzMessageTurnPort;
    /** The role port `port.wakeRole` wakes, so a mention's wake can carry its context to it. */
    readonly roleConversation: RoleConversationPort | null;
  };
  close(): Promise<void>;
}

/** The authenticated local RPC endpoint used by `agentctl`. */
export interface LocalOperatorListener {
  socketPath: string;
  close(): Promise<void>;
}

/**
 * A dedicated operator credential is bound to one configured local peer before a socket
 * accepts a request. The actor is deliberately not read from the request body. The token is
 * provisioned separately from ACP_MCP_TOKEN; the latter is a deployment gate for MCP and has
 * no peer identity of its own.
 */
export interface LocalOperatorCredential {
  token: string;
  peerId: string;
  actor: string;
}

export interface LocalOperatorSocketOptions {
  ctoBinding?: CtoBindingRuntime;
  approveCtoDelegate?: (params: Record<string, unknown>) => Decision<unknown>;
  handshakeTimeoutMs?: number;
  /** Execution budget for an authenticated method, distinct from the handshake budget. */
  requestTimeoutMs?: number;
  /** Used only to reject accidental reuse of the non-identifying MCP deployment token. */
  mcpToken?: string;
  /** The sole additional operator method: a fresh-install Hermes authority bootstrap. */
  bootstrapHermes?: (params: Record<string, unknown>) => Promise<Decision<unknown>>;
  /** Binding-only adoption of a separately pinned, live incumbent; never starts a chat. */
  adoptHermesIncumbent?: () => Promise<Decision<unknown>>;
  /** Server-configured actor predicate; checked before reading request parameters. */
  adoptHermesIncumbentOwnerAllowed?: () => boolean;
  // No `claimCanonicalCto` option on this bearer-token-authenticated socket (#760): a process may
  // prove who it is, but it cannot approve itself, so the claiming connection cannot sit on this
  // credential surface at all, not even behind its own kernel-credential check layered on top. It
  // has its own dedicated, token-less listener — `startCanonicalSelfClaimListener` in
  // `canonical-self-claim-listener.ts` — which this socket neither starts nor knows the method
  // name of.
}

interface LiveOperatorBinding extends LocalOperatorCredential {
  incarnation: string;
  active: boolean;
}

interface PendingLaunchCredential {
  credential: SessionLaunchCredential;
  expiresAtMs: number;
}

/**
 * The provider-issued external session id is a high-entropy, recipient-scoped rendezvous
 * key. The channel lives on an owner-only socket, retains no credential durably, and deletes
 * an entry before replying, so a runtime can obtain its MCP proof exactly once.
 */
export const startSessionLaunchChannel = async (
  stateDir: string,
  options: SessionLaunchChannelOptions = {},
): Promise<LocalSessionLaunchChannel> => {
  const socketPath = join(stateDir, "cto.launch.sock");
  const pending = new Map<string, PendingLaunchCredential>();
  let server: Server | null = null;
  let opening: Promise<Decision<void>> | null = null;
  let closing: Promise<void> | null = null;
  let closed = false;

  const pruneExpired = (): void => {
    const now = Date.now();
    for (const [externalSessionId, launch] of pending) {
      if (launch.expiresAtMs <= now) pending.delete(externalSessionId);
    }
  };
  const prepare = async (): Promise<Decision<void>> => {
    if (closed) {
      return deny(ReasonCode.CONFLICT, "session launch channel is closed", { socketPath });
    }
    if (server) return allow(ReasonCode.OK, undefined);
    if (opening) return opening;

    opening = (async (): Promise<Decision<void>> => {
      let candidate: Server | null = null;
      try {
        // `main` creates the channel object before `Daemon.start` so queued-run resume can
        // use it, but this binding is deliberately delayed until `CtoLifecycle.spawn` runs
        // under the daemon lock. A losing daemon can therefore never unlink the winner's
        // live launch socket while it is merely attempting startup.
        removeStaleSocket(socketPath);
        candidate = createServer((socket) => serveSessionLaunchCredential(socket, pending, options.mcpToken));
        await listenSocket(candidate, socketPath);
        if (closed) {
          await closeSocketServer(candidate);
          return deny(ReasonCode.CONFLICT, "session launch channel closed while opening", { socketPath });
        }
        server = candidate;
        return allow(ReasonCode.OK, undefined);
      } catch (error) {
        if (candidate) {
          try {
            await closeSocketServer(candidate);
          } catch {
            /* an unsuccessful listen owns no server that needs further cleanup */
          }
        }
        return deny(ReasonCode.CONFLICT, "could not open the session launch channel", {
          socketPath,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        opening = null;
      }
    })();
    return opening;
  };

  return {
    socketPath,
    prepare,
    provision: async (credential) => {
      const prepared = await prepare();
      if (!prepared.allowed) return prepared;
      pruneExpired();
      if (pending.has(credential.externalSessionId)) {
        return deny(
          ReasonCode.CONFLICT,
          "a launch credential is already pending for this external session",
          { sessionId: credential.sessionId },
        );
      }
      pending.set(credential.externalSessionId, {
        credential,
        expiresAtMs: Date.now() + SESSION_LAUNCH_TTL_MS,
      });
      return allow(ReasonCode.OK, undefined);
    },
    withdraw: (externalSessionId) => pending.delete(externalSessionId),
    close: async () => {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        pending.clear();
        if (opening) await opening;
        const active = server;
        server = null;
        if (active) await closeSocketServer(active);
      })();
      return closing;
    },
  };
};

/**
 * PRD §27.3 — each role gets its own owner-only Unix socket and must present the
 * deployment token before its MCP server sees a byte. Keeping the endpoints separate
 * prevents a CTO client from discovering Hermes operations through a shared transport.
 */
export const startLocalMcpListeners = async (
  cp: ControlPlane,
  stateDir: string,
  token: string,
  options: LocalMcpListenerOptions = {},
): Promise<LocalMcpListeners> => {
  if (token.length === 0) throw new Error("ACP_MCP_TOKEN must be configured to expose MCP");
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS;
  if (!Number.isInteger(handshakeTimeoutMs) || handshakeTimeoutMs <= 0) {
    throw new Error("MCP handshake timeout must be a positive integer");
  }

  const hermesPath = join(stateDir, "hermes.mcp.sock");
  const ctoPath = join(stateDir, "cto.mcp.sock");
  // Server handlers receive these function-only ports, never the composition root. The
  // transport still needs `cp` to authenticate a socket, but a tool cannot turn that into
  // raw database access or evidence-write authority (#352).
  const hermesPort = createHermesMcpPort(cp, { onCeoApproved: options.onCeoApproved });
  const ctoBinding = daemonCtoBindingRuntime(cp);
  const ctoPort = createCtoMcpPort(cp);
  const ceoConversation = options.ceoConversation ?? new CeoConversationPort();
  /*
   * The registry view the CTO port enumerates its slots from.
   *
   * `bindings.bySession` cannot serve here: it selects on the assignment's own session column and
   * joins nothing, so it answers with the session a binding was *created* for. A conversation that
   * survives a failover moves to another runtime without rewriting that column, which makes the
   * historical answer wrong in both directions — it lists roles the session has lost and omits
   * roles it has gained. `activePrimaryCto` resolves the live runtime through the actor, so the
   * question asked here is "which project has which runtime as its CTO, right now".
   *
   * The list is deliberately not narrowed to the connecting session. Deciding who may hold a slot
   * is the port's single enforcement point; repeating it here would leave two copies of one rule,
   * and removing either would change nothing a test could see.
   */
  const ctoConversation = new RoleConversationPort(
    Role.PRIMARY_CTO,
    {
      active: (roleKey) => cp.bindings.active(roleKey),
      currentCandidates: () => currentBindingsForRoles(cp, [Role.PRIMARY_CTO]),
    },
    // The wake endpoint directory is this same `stateDir` — the 0700 directory `hermes.mcp.sock`
    // and `cto.mcp.sock` are already in, two lines above. It is passed rather than derived inside
    // the port so the port never has to know what a deployment's layout is, and so a test that
    // wants a different directory gets one without moving the daemon's.
    // The wake's final holder check and its frame handoff run in the daemon's write transaction.
    { endpointDir: stateDir, ownerMessages: ownerMessageLedger(cp), serializeWake: (body) => cp.db.tx(body) },
  );
  // A wake caused by a verified mention is gated on that mention's identity, role and room, judged by
  // whichever mention subscriber runs over this control plane. No other wake meets this gate.
  ctoConversation.useMentionWakeGate(buzzMentionWakeGate(cp, () => runningMentionSubscribers.get(cp) ?? null));
  const hermes = await startMcpSocket(
    hermesPath,
    token,
    cp,
    [Role.CEO],
    handshakeTimeoutMs,
    (auth, _opening, credential) => {
      const server = createHermesServer(hermesPort, auth);
      // The description said "under an existing owner delegation. Restart revokes grants" until
      // the grant was removed; it now names the authority that actually decides. A tool
      // description is what the caller reads to know what it may ask for, so a stale one is a
      // wrong answer to that question even though nothing dispatches on it.
      // Both doors publish through one boundary rather than a copy each. The sanitization below
      // is the only place a nested internal denial is closed, and a second copy of it would be a
      // second authority on that one fact — and would leave the guard's anchor matching twice,
      // so the row watching it would no longer name a unique site.
      const publishCtoBinding = (ask: (request: unknown) => Decision<unknown>) =>
        async ({ request }: { request: Record<string, unknown> }) => {
          try {
            const peer = auth();
            const decision = peer.allowed ? ask(request) : peer;
            // Internal composition may return an exception as a denial instead of throwing.
            return respond(!decision.allowed && decision.reasonCode === ReasonCode.INTERNAL_ERROR
              ? deny(ReasonCode.INTERNAL_ERROR, "CTO binding request failed", {})
              : decision);
          } catch {
            // Do not inspect/log the exception: even its message, code or getters may
            // contain private deployment data. Cover authentication and serialization too.
            return respond(deny(ReasonCode.INTERNAL_ERROR, "CTO binding request failed", {}));
          }
        };
      server.registerTool("cto_binding_bind", {
        description: "Bind or replace a proven-dead CTO. The caller must hold the live CEO binding; stale retries are refused.",
        inputSchema: { request: z.record(z.unknown()) },
      }, publishCtoBinding((request) => ctoBinding.bind(credential, request)));
      server.registerTool("cto_binding_release", {
        description: "End the current CTO binding for a project, naming its generation. The caller must hold the live CEO binding; the incumbent need not be dead.",
        inputSchema: { request: z.record(z.unknown()) },
      }, publishCtoBinding((request) => ctoBinding.release(credential, request)));
      // The authenticator travels with the connection, not just the server. Reaching this line
      // proves the peer held the CEO binding at handshake; `ask` re-runs `auth` so a socket
      // that outlives its binding cannot keep receiving the owner.
      server.server.onclose = ceoConversation.attach(server, auth);
      return server;
    },
  );
  /**
   * One CTO MCP server for one admitted connection, whichever door admitted it: `cto.mcp.sock` by
   * the session secret, or the canonical CTO's reattach socket by the process tree (#1037). `auth`
   * is binding-scoped tool authority; `connectionAuth` is the binding-free standing the conversation
   * port re-asks on delivery. `door` is which of the two admitted the connection, named by that
   * door's code; the reattach door's server also tells its client the tool list changed after each
   * wake registration is answered. Neither door's server differs from the other's in anything else.
   */
  const ctoServer = (
    auth: McpPeerAuthenticator,
    opening: BoundSocketPeer,
    connectionAuth: () => McpPeerAuthenticator,
    door: "session-secret" | "canonical-reattach",
  ): ReturnType<typeof createCtoServer> => {
    // `auth` stays binding-scoped: MCP tool authority *is* authority over the one assignment
    // this connection was admitted under, and `createCtoServer` must keep getting it.
    const server = createCtoServer(
      ctoPort,
      auth,
      opening.kind === "PENDING_HANDOFF_ACK"
        ? { pendingHandoffId: opening.handoffId }
        : opening.kind === "PENDING_ATTESTATION"
          ? { attestationOnly: true }
          : undefined,
    );
    // The line the CEO socket has had and this one did not. The binding the connection was
    // admitted under is what the port keys and verifies on: this socket also admits
    // BOOTSTRAP_CTO and admits PRIMARY_CTO for any project, and neither may become the peer
    // for this project's canonical CTO. A handoff-pending peer holds no binding at all, so
    // there is nothing for it to be the target of.
    if (opening.kind === "BOUND") {
      // The credential authenticated a *session*; admission then picked one of its bindings to
      // admit the connection under. Which one it picked decides nothing here — the port asks
      // the registry which roles this authenticated runtime currently holds. `opening.binding`
      // is deliberately not passed: making a sibling slot's eligibility depend on whichever
      // binding admission happened to choose is how a role becomes unreachable. For the same
      // reason the port gets a *credential-only* authenticator rather than `auth` — a
      // binding-scoped re-check at delivery time reintroduces that dependency through the back
      // door, and moving the admitted project away took the session's other project with it.
      server.server.onclose = ctoConversation.attach(server, connectionAuth());
      // Registration is a tool on *this* connection's server, and the handler passes `server`
      // — the object identity `attach` keyed the slots on — rather than anything from `args`.
      // That is the whole of "connection-bound": there is no argument here in which a peer
      // could name a role, a session or a connection other than its own, so the only thing it
      // can say is which path it is listening on. Everything else the port takes from the
      // registry and from the filesystem.
      server.registerTool(
        "role_wake_endpoint_register",
        {
          description:
            "Register this connection's own wake endpoint socket. Local runtime contract, version-pinned; not a public interface.",
          inputSchema: { endpoint: z.string().min(1) },
        },
        async (args: { endpoint: string }) =>
          respond(await ctoConversation.registerEndpoint(server, args.endpoint)),
      );
      /*
       * The owner-message tools, registered in this same composition — not on a second
       * server, and not against a durable endpoint registry.
       *
       * `roleKey` is the only thing a caller may say, and it is a **lookup key**: it selects
       * which of this connection's slots to act on. There is deliberately no argument here for
       * a session, an incarnation, an assignment, a generation, a pid, a client version or a
       * digest — `RoleConversationPort` derives the whole `HolderIdentity` from `server` (the
       * object identity `attach` keyed the slot on), from this connection's own authenticator,
       * and from the binding registry, and it does that again on every call rather than
       * trusting what was true at handshake. So a caller supplying a different holder tuple has
       * nowhere to put it, which is stronger than validating one it could have supplied.
       */
      server.registerTool(
        "role_owner_message_claim",
        {
          description:
            "Take at most one message addressed to a role this connection currently holds. " +
            "`principal` says who sent it: `peer` is the CEO, whose message carries no owner authority.",
          inputSchema: { roleKey: z.string().min(1) },
        },
        async (args: { roleKey: string }) =>
          respond(ctoConversation.claimOwnerMessage(server, args.roleKey)),
      );
      server.registerTool(
        "role_owner_message_complete",
        {
          description: "Record that this connection took and finished one owner message.",
          inputSchema: { roleKey: z.string().min(1), messageId: z.string().min(1) },
        },
        async (args: { roleKey: string; messageId: string }) =>
          respond(ctoConversation.completeOwnerMessage(server, args.roleKey, args.messageId)),
      );
      server.registerTool(
        "role_owner_message_reject",
        {
          description: "Terminally refuse one owner message this connection was handed.",
          inputSchema: { roleKey: z.string().min(1), messageId: z.string().min(1) },
        },
        async (args: { roleKey: string; messageId: string }) =>
          respond(ctoConversation.rejectOwnerMessage(server, args.roleKey, args.messageId)),
      );
      server.registerTool(
        "role_owner_message_report_refusal",
        {
          description:
            "Take on telling the CEO about one rejected peer message the claim listed under " +
            "`refusedAtRestart`. Call it before telling the CEO: when it is refused, the daemon is " +
            "telling the CEO itself and this connection must not. Later holders are no longer shown it.",
          inputSchema: { roleKey: z.string().min(1), messageId: z.string().min(1) },
        },
        async (args: { roleKey: string; messageId: string }) =>
          respond(ctoConversation.reportPeerMessageRefusal(server, args.roleKey, args.messageId)),
      );
    }
    /*
     * `notifications/tools/list_changed`, so a client carried across a daemon restart re-lists.
     *
     * A canonical CTO's relay carries its client across a restart by replaying the client's
     * `initialize`, its `notifications/initialized` and its last wake registration on a new
     * connection through the reattach door, and answers every client request with "reattaching"
     * until the last of those is answered (src/cli/attach-relay.ts `restore`). The client never
     * re-lists on its own, so a restart onto a build with other tools left it holding the old list.
     *
     * Every connection is told at `initialized`, whatever ids it uses, so no client goes without
     * one. A connection the reattach door admitted is told again after the answer to each wake
     * registration on it: that is the point a relay replaying a registration goes live, and the
     * notification sent at `initialized` may have reached its client while the relay was still
     * refusing requests. Which door admitted the connection is `door`, set by the door's own code
     * after its admission, never by anything the client sends.
     *
     * The notification decides nothing. It follows a refused registration as it follows an
     * accepted one, it does not touch the wake slot, and the list the client then asks for is
     * answered under this connection's own authentication like any other request. A send that
     * fails is written to stderr and is not retried.
     */
    const refreshToolList = (): void => {
      server.server.sendToolListChanged().catch(() => {
        process.stderr.write("cto tool list change notification not sent\n");
      });
    };
    server.server.oninitialized = refreshToolList;
    if (door === "canonical-reattach") {
      // The registration is read on the transport, before the SDK dispatches it, so its answer is
      // known whichever way the SDK answers it (a result, a refusal, or a request it rejects). The
      // notification is sent once that answer is written, so it is behind it on the wire.
      const registrations = new Set<string | number>();
      const observeInbound = (message: JSONRPCMessage): void => {
        if (!("method" in message) || !("id" in message) || message.method !== "tools/call") return;
        if ((message.params as { name?: unknown } | undefined)?.name !== "role_wake_endpoint_register") return;
        registrations.add(message.id);
      };
      const observeSent = (message: JSONRPCMessage): void => {
        if ("method" in message || !("id" in message) || message.id === undefined || message.id === null) return;
        if (registrations.delete(message.id)) refreshToolList();
      };
      const connect = server.connect.bind(server);
      server.connect = (transport: Transport): Promise<void> => {
        const observed: Transport = {
          start: () => {
            transport.onmessage = (message, extra) => {
              observeInbound(message);
              observed.onmessage?.(message, extra);
            };
            transport.onclose = () => observed.onclose?.();
            transport.onerror = (error) => observed.onerror?.(error);
            return transport.start();
          },
          send: async (message, options) => {
            await transport.send(message, options);
            observeSent(message);
          },
          close: () => transport.close(),
        };
        return connect(observed);
      };
    }
    return server;
  };
  let cto: Server;
  try {
    cto = await startMcpSocket(
      ctoPath,
      token,
      cp,
      [Role.PRIMARY_CTO, Role.BOOTSTRAP_CTO],
      handshakeTimeoutMs,
      (auth, opening, credential) =>
        ctoServer(
          auth,
          opening,
          () =>
            conversationPeerAuthenticator(
              cp,
              credential,
              opening.sessionIncarnation,
              opening.credentialEpoch,
              ctoConversation.role,
            ),
          "session-secret",
        ),
      { pendingHandoffAck: true, pendingAttestation: true },
      options.attachments ? { authority: options.attachments, port: ctoConversation } : undefined,
    );
  } catch (err) {
    await closeSocketServer(hermes);
    if (existsSync(hermesPath)) unlinkSync(hermesPath);
    throw err;
  }
  // #1037 — the canonical CTO's reattach door. A live claimant whose binding is still ACTIVE gets
  // the same server as above, admitted by `CanonicalCtoReattach` rather than by a secret; a
  // connection it does not admit is refused before MCP begins and its relay claims instead.
  let reattach: CanonicalSelfClaimListener | null = null;
  const openCanonicalCtoReattach = async (
    admission: CanonicalCtoReattach,
    daemon: { lock: { held(): boolean } },
  ): Promise<string> => {
    if (reattach !== null) throw new Error("the canonical CTO reattach socket is already open");
    reattach = await startCanonicalCtoToolListener(
      daemon,
      stateDir,
      async (peer) => {
        const admitted = admission.admit(peer);
        // After admission and never part of it: the correction opens the room through the Buzz
        // CLI, and a reattach must not wait on, or fail with, the relay. It admits the peer again
        // itself, so it cannot act for anyone this line did not just admit, and it is a no-op for
        // a row already in its room. A refusal or a throw leaves the row as it was; the next
        // reattach asks again. Only the reason code is printed, never a room or a session.
        if (admitted.allowed) {
          void admission.correctBuzzAddress(peer).then(
            (corrected) => {
              if (!corrected.allowed) {
                process.stderr.write(`canonical CTO buzz address correction refused: ${corrected.reasonCode}\n`);
              }
            },
            () => {
              process.stderr.write("canonical CTO buzz address correction failed\n");
            },
          );
        }
        return admitted;
      },
      (admitted, socket) => {
        const binding = cp.bindings.active(admitted.roleKey);
        if (binding === null) {
          socket.destroy();
          return;
        }
        const server = ctoServer(
          () => admission.authenticate(admitted),
          {
            kind: "BOUND",
            binding,
            sessionIncarnation: admitted.sessionIncarnation,
            credentialEpoch: cp.sessions.get(binding.sessionId)?.credentialEpoch ?? 0,
          },
          () => () => admission.connection(admitted),
          "canonical-reattach",
        );
        void server.connect(new SocketTransport(socket, Buffer.alloc(0))).catch((err: unknown) => {
          socket.destroy(err instanceof Error ? err : new Error(String(err)));
        });
      },
    );
    return reattach.socketPath;
  };
  const servers = [hermes, cto];

  return {
    socketPaths: [hermesPath, ctoPath],
    ceoConversation,
    ctoConversation,
    openCanonicalCtoReattach,
    close: async () => {
      await reattach?.close();
      await Promise.all(servers.map(closeSocketServer));
      for (const path of [hermesPath, ctoPath]) {
        try {
          if (existsSync(path)) unlinkSync(path);
        } catch {
          /* closing the server already releases its socket; this is only cleanup */
        }
      }
    },
  };
};

/**
 * Hosts the only production writer for `sessions.buzz_actor_id`. The relay submits a
 * signed Buzz envelope over this owner-only socket; the handler verifies that envelope
 * before it lets SessionRegistry verify the runtime's separate session secret.
 */
export const startBuzzActorIngressListener = async (
  cp: ControlPlane,
  stateDir: string,
  policy: IngressPolicy,
): Promise<LocalBuzzActorIngress> => {
  if (!policy.secret || policy.secret.trim().length === 0) {
    throw new Error("Buzz channel identity ingress requires a non-empty signing secret");
  }

  const guard = new IngressGuard(cp.db, cp.clock, cp.audit, { buzz: policy });
  const ingress = new BuzzActorIngress(guard, cp.sessions);
  const socketPath = join(stateDir, "buzz-actor.ingress.sock");
  removeStaleSocket(socketPath);
  const server = createServer((socket) => serveBuzzActorBinding(socket, ingress));

  try {
    await listenSocket(server, socketPath);
  } catch (err) {
    if (existsSync(socketPath)) unlinkSync(socketPath);
    throw err;
  }

  return {
    socketPath,
    close: async () => {
      await closeSocketServer(server);
      try {
        if (existsSync(socketPath)) unlinkSync(socketPath);
      } catch {
        /* closing the server already releases its socket; this is only cleanup */
      }
    },
  };
};

/**
 * Hermes' door into the Telegram external-consumer lane (U4): `telegram-update.ingress.sock` in the
 * daemon's owner-only state directory, created and permissioned like the Buzz ingress sockets.
 *
 * The socket is authenticated by the shared secret inside each envelope, which
 * `TelegramIngress.admit` compares; the file mode keeps every other uid off it. One envelope per
 * connection, bounded in size and time, one answer, then the connection is closed.
 */
export const startTelegramExternalIngress = async (
  cp: ControlPlane,
  stateDir: string,
  config: TelegramExternalConsumerConfig,
  options: { reconcileBudgetMs?: number } = {},
): Promise<LocalTelegramExternalIngress> => {
  const lane = new TelegramExternalUpdateLane(cp, config, options);
  const socketPath = join(stateDir, TELEGRAM_EXTERNAL_SOCKET_NAME);
  removeStaleSocket(socketPath);
  const server = createServer((socket) => {
    trackConnection(server, socket);
    serveTelegramExternalUpdate(socket, lane);
  });

  try {
    await listenSocket(server, socketPath);
  } catch (err) {
    if (existsSync(socketPath)) unlinkSync(socketPath);
    throw err;
  }

  return {
    socketPath,
    lane,
    close: async () => {
      await closeSocketServer(server);
      try {
        if (existsSync(socketPath)) unlinkSync(socketPath);
      } catch {
        /* closing the server already releases its socket; this is only cleanup */
      }
    },
  };
};

/**
 * The roles a Buzz `p` tag may address.
 *
 * Every role the daemon binds, not the subset that happens to have a live-peer port today. The
 * two questions are different: which role a tag names is a fact about the registry, and whether
 * that role can be reached is a fact about who is attached. Narrowing the first by the second
 * would turn a session that is CTO of two projects into an unambiguous single answer whenever
 * only one of them had a peer — the ambiguity would disappear at exactly the moment it matters.
 */
const MENTIONABLE_ROLES: readonly Role[] = [Role.CEO, Role.PRIMARY_CTO, Role.BOOTSTRAP_CTO];

/**
 * `p` tag → role, through the two things that already know the answer.
 *
 * `sessions.buzz_actor_id` is the mapping, and it is the same column `BuzzAdapter.resolveActor`
 * reads inbound — written only by an authenticated `bindBuzzActor`, unique across live sessions,
 * and never a display name or a room address. `currentBindingsForRoles` is the registry's answer
 * to "who holds which role right now", resolved through the actor rather than through the
 * assignment's own session column, so a conversation that survived a failover is found on the
 * runtime it is on rather than the one it was created on.
 *
 * `resolveActor` itself is not called here for one reason: it answers with a single binding, via
 * a `find` over the session's ACTIVE assignments. One session legitimately holds several roles —
 * the CTO of two projects, or a bootstrap binding beside a primary one — and collapsing that to
 * whichever row came back first is delivery by accident. This returns all of them and lets the
 * ingress refuse.
 */
const buzzMentionRouter = (cp: ControlPlane): BuzzMentionRouter => ({
  rolesFor: (mention) => {
    const actor = mention.trim();
    if (actor.length === 0) return [];
    // A live session only. A stopped one may still carry the column — the unique index excludes
    // terminal lifecycles precisely so a respawn can take the identity back — and mail for a
    // role must not be resolved onto a runtime that has gone.
    const session = cp.db.get<{ session_id: string }>(
      `SELECT session_id FROM sessions
        WHERE buzz_actor_id = ? AND lifecycle IN ('READY','DRAINING')`,
      [actor],
    );
    if (!session) return [];
    return currentBindingsForRoles(cp, MENTIONABLE_ROLES)
      .filter((binding) => binding.sessionId === session.session_id)
      .map((binding) => binding.roleKey);
  },
  journalUnbound: (record) => {
    cp.audit.record({
      kind: "BUZZ_MENTION_TARGET_UNBOUND",
      reasonCode: ReasonCode.MENTION_TARGET_UNBOUND,
      actor: record.actor,
      evidence: {
        channel: "buzz",
        conversation: record.conversation,
        nonce: buzzMessageNonce(record.eventId),
        target: record.mention,
        // The count, not the keys. Which roles a tag nearly reached is the operator's question
        // and the registry answers it; putting them on the relay's side of this boundary would
        // tell an unaddressed sender the deployment's role topology.
        candidates: record.candidates.length,
        // Which of the five failures this was. A bare count of unbound events cannot separate
        // "the relay stopped attaching tags" from "this runtime is the CTO of two projects", and
        // those are different repairs.
        shape: record.shape,
      },
    });
  },
});

/**
 * Whether `runtime` carried `identity` at any moment it was serving a CEO generation earlier than
 * `generation` (#1044) — the identity's history, not the runtime's.
 *
 * `sessions.buzz_actor_id` is written once per session, so a runtime carries an identity from the
 * moment it took it onward. That moment is the runtime's first `SESSION_BUZZ_ACTOR_BOUND` record
 * for it, and the CEO generations the runtime served are replayed from the binding records in
 * `event_id` order — which is total, so two records that share one clock reading are still ordered —
 * reading each record's own generation. The identity was used by an earlier generation exactly when
 * this runtime was serving one at or after the moment it took the identity.
 *
 * Fails closed: no record of the binding, or a binding record whose generation is not readable,
 * counts as used, because nothing can then show that no earlier generation saw the identity.
 */
const identityUsedInAnEarlierCeoGeneration = (
  cp: ControlPlane,
  runtime: string,
  identity: string,
  generation: number,
): boolean => {
  const tookIdentityAt =
    cp.db.get<{ first: number | null }>(
      `SELECT MIN(event_id) AS first FROM audit_events
        WHERE kind = 'SESSION_BUZZ_ACTOR_BOUND' AND session_id = ? AND actor = ?`,
      [runtime, `buzz:${identity}`],
    )?.first ?? null;
  if (tookIdentityAt === null) return true;
  const records = cp.db.all<{ event_id: number; kind: string; session_id: string | null; evidence_json: string }>(
    `SELECT event_id, kind, session_id, evidence_json FROM audit_events
      WHERE role_key = ?
        AND kind IN ('BINDING_CREATED','BINDING_SWITCHED','BINDING_RUNTIME_MOVED','BINDING_REVOKED')
      ORDER BY event_id`,
    [roleKeyFor(Role.CEO)],
  );
  let serving: { generation: number; runtime: string | null } | null = null;
  const servingAnEarlierGenerationHere = (): boolean =>
    serving !== null && serving.runtime === runtime && serving.generation < generation;
  for (const record of records) {
    // The state in force just before this record covers the moment the identity was taken, or a
    // moment after it, once this record comes after that moment.
    if (record.event_id > tookIdentityAt && servingAnEarlierGenerationHere()) return true;
    if (record.kind === "BINDING_REVOKED") {
      serving = null;
      continue;
    }
    let evidence: Record<string, unknown>;
    try {
      evidence = JSON.parse(record.evidence_json) as Record<string, unknown>;
    } catch {
      return true;
    }
    const recorded = record.kind === "BINDING_SWITCHED" ? evidence["toGeneration"] : evidence["generation"];
    if (typeof recorded !== "number") return true;
    serving = { generation: recorded, runtime: record.session_id };
  }
  return servingAnEarlierGenerationHere();
};

/**
 * The registry facts the Buzz peer rule reads (#1038). Reads only, like `buzzMentionRouter`.
 *
 * `currentCeo` reads the column off the CEO binding's *live* runtime, so a NULL there — the adopted
 * runtime's state on 2026-10-02 — answers with a null identity and every CEO mention is refused.
 * Nothing here binds one: `BuzzActorIngress.bindActor` is still the only writer, and it needs the
 * session secret #1037 issues.
 *
 * `primaryCtoFor` asks `buzzMentionSubscriberRegistry`'s question — a live session whose one
 * mentionable role is a PRIMARY_CTO — without its stderr diagnostics, because a refused peer
 * envelope is an ordinary event here rather than a subscriber that cannot start; and it adds the two
 * facts the peer rule binds to: the binding's generation and that session's project channel.
 *
 * Two deployment facts this change does not configure: the guard every sender meets needs the
 * CEO's key on `ACP_BUZZ_ALLOWED_ACTORS`, and the peer rule needs the CTO runtime's `buzz_address`
 * to be the room the CEO writes in.
 */
export const buzzPeerRegistry = (cp: ControlPlane): BuzzPeerRegistry => ({
  currentCeo: () => {
    const ceo = cp.bindings.active(roleKeyFor(Role.CEO));
    if (!ceo) return null;
    const runtime = cp.db.get<{ buzz_actor_id: string | null }>(
      `SELECT buzz_actor_id FROM sessions
        WHERE session_id = ? AND lifecycle IN ('READY','DRAINING')`,
      [ceo.sessionId],
    );
    const channelIdentity = runtime?.buzz_actor_id ?? null;
    // #1044. Two ways an identity is not this generation's alone, and both are about the identity's
    // own history rather than the runtime's. Another session row carries it — a stopped one keeps
    // the column, which is what makes a key's earlier holder visible — or this runtime carried it
    // while serving an earlier CEO generation. A runtime that served an earlier generation with no
    // identity, and took this one only later, holds an identity no earlier generation used.
    const reused =
      channelIdentity !== null &&
      (cp.db.get<{ carried: number }>(
        `SELECT EXISTS (SELECT 1 FROM sessions WHERE buzz_actor_id = ? AND session_id <> ?) AS carried`,
        [channelIdentity, ceo.sessionId],
      )?.carried !== 0 ||
        identityUsedInAnEarlierCeoGeneration(cp, ceo.sessionId, channelIdentity, ceo.bindingGeneration));
    return {
      bindingGeneration: ceo.bindingGeneration,
      sessionId: ceo.sessionId,
      channelIdentity,
      generationStartedAt: ceo.createdAt,
      channelIdentityReused: reused,
    };
  },
  primaryCtoFor: (mention) => {
    const channelIdentity = mention.trim();
    if (channelIdentity.length === 0) return null;
    const session = cp.db.get<{ session_id: string; buzz_address: string | null }>(
      `SELECT session_id, buzz_address FROM sessions
        WHERE buzz_actor_id = ? AND lifecycle IN ('READY','DRAINING')`,
      [channelIdentity],
    );
    if (!session) return null;
    const held = currentBindingsForRoles(cp, MENTIONABLE_ROLES).filter(
      (binding) => binding.sessionId === session.session_id,
    );
    const only = held.length === 1 ? held[0] : undefined;
    if (!only || only.role !== Role.PRIMARY_CTO) return null;
    return {
      roleKey: only.roleKey,
      bindingGeneration: only.bindingGeneration,
      sessionId: only.sessionId,
      channel: session.buzz_address,
    };
  },
  nowMs: () => cp.clock.now().getTime(),
});

/**
 * §6.1 DIRECT for the Buzz surface: an owner's message becomes one turn for the session that
 * currently holds the CEO binding, and the CEO's answer goes back to the relay that sent it.
 *
 * **Its own socket, beside `buzz-actor.ingress.sock` rather than on it.** The three reasons are
 * not stylistic:
 *
 *   - The binding socket's protocol has no method field. It reads one envelope per connection
 *     and dispatches it to `bindActor` by field presence alone, and its answer is a
 *     `Decision<SessionRecord>` with no payload. Multiplexing a second request type onto it
 *     would mean inventing a discriminator on a wire that has none, and a malformed envelope of
 *     either kind could then be parsed as the other.
 *   - `BuzzActorIngress.bindActor` is the only production writer of `sessions.buzz_actor_id`
 *     and requires the local session secret to prove possession. Nothing on the message path
 *     needs that authority, and separate sockets mean it cannot reach it even by accident: the
 *     parse boundary and the authority boundary are the same boundary.
 *   - Their dependencies differ. The binding listener needs only the ingress policy; this one
 *     is meaningless without the CEO conversation port, which `main` builds later, from the
 *     MCP listeners.
 *
 * A client that connects to the wrong one is refused, never silently served: a message envelope
 * on the binding socket has no `sessionId`/`sessionSecret` and is refused as incomplete (that is
 * exactly what #627's base measurement observed), and a binding envelope here has no
 * `text`/`eventId` and is refused the same way. Neither crosses.
 */
export const startBuzzMessageIngressListener = async (
  cp: ControlPlane,
  stateDir: string,
  policy: IngressPolicy,
  options: {
    ceoConversation: CeoConversationPort;
    ownerActors: readonly string[];
    /** Daemon-owned existing-session sender; when present, never fall back to MCP. */
    gatewayConversation?: (text: string, source: GatewayEventSource) => Promise<CeoTurnOutcome>;
    /**
     * B2's live-peer port, for events addressed to a role by `p` tag.
     *
     * Optional, and its absence fails closed rather than open: with no port every resolved role
     * is unreachable, so a mention is refused with `ROLE_PEER_ABSENT` and nothing is delivered.
     * A composition that forgets to wire it loses delivery, never gains a wrong recipient.
     */
    roleConversation?: RoleConversationPort;
  },
): Promise<LocalBuzzMessageIngress> => {
  if (!policy.secret || policy.secret.trim().length === 0) {
    throw new Error("Buzz message ingress requires a non-empty signing secret");
  }

  // The second argument is #858's other half. `IngressGuard` stores a claim's canonical target
  // only when it is given a resolver, and this composition never was -- so the live Buzz claim
  // (`msg_b4177e7ec603...`, 2026-09-13) carries `deliveryStatus`, three digests and no
  // `canonicalTarget`, and `canonicalTargetForClaim("buzz", nonce)` can only answer null for it.
  // Without this line the bridge below is a call that always refuses, which is the shape
  // `telegram-polling.ts` already met once and named: a writer that cannot write.
  const guard = new IngressGuard(cp.db, cp.clock, cp.audit, { buzz: policy }, {
    canonicalTargetForClaim: (identity) => {
      const target = canonicalTurnTarget(cp);
      return target
        ? { turnRequestId: identity.turnRequestId, promptDigest: identity.promptDigest, ...target }
        : null;
    },
  });
  // `policy.allowedActors` is the relay credential's list and admits every ACTIVE Buzz channel
  // identity; `ownerActors` is who may speak to the CEO as the owner. Passing the first for the
  // second is the defect this argument exists to make impossible to write by accident.
  //
  // The fourth is the peer rule (#1038), and it is how the CEO reaches the CTO without being on the
  // owner list: the CEO binding's own Buzz channel identity, toward its bound PRIMARY_CTO only.
  const ingress = new BuzzMessageIngress(
    guard,
    options.ownerActors,
    buzzMentionRouter(cp),
    buzzPeerRegistry(cp),
  );
  const roleConversation = options.roleConversation ?? null;
  const port: BuzzMessageTurnPort = {
    deliverToCeo: (text, source) =>
      deliverAsCeoTurn(options.ceoConversation, text, source, options.gatewayConversation),
    // Read at claim time, from the binding registry rather than from the peer: the fence is
    // "which CEO generation was this turn claimed under", and the peer cannot be its own
    // authority for that. Telegram's production composition still passes none (#639's seam is
    // unwired there), so this is the first path that records a real generation on a claim.
    bindingGeneration: () => cp.bindings.active(roleKeyFor(Role.CEO))?.bindingGeneration ?? null,
    // The database's own transaction, not a second one built here. `Db.tx` joins an outer
    // transaction rather than opening a nested one, so the guard's insert, the outbox's insert and
    // the claim's compare-and-set all land inside this single BEGIN IMMEDIATE.
    atomically: (body) => cp.db.tx(body),
    activeRoleTarget: (roleKey) => {
      const binding = cp.bindings.active(roleKey);
      return binding
        ? {
            bindingGeneration: binding.bindingGeneration,
            targetSessionId: binding.sessionId,
            createdAt: binding.createdAt,
          }
        : null;
    },
    enqueueOwnerMessage: (input) => {
      const enqueued = cp.outbox.enqueue({
        // The `(buzz, nonce)` slot the guard just consumed *is* the idempotency of this row. A
        // fresh key would let one event id enqueue twice if it ever reached here twice, and the
        // outbox's own duplicate suppression is the second line under the ingress replay refusal
        // rather than a different rule.
        idempotencyKey: `${input.principal}-message:${input.nonce}`,
        roleKey: input.roleKey,
        bindingGeneration: input.bindingGeneration,
        targetSessionId: input.targetSessionId,
        runId: null,
        // #1038: a peer's row is a kind of its own, so its holder is told it is not the owner's.
        kind: input.principal === "peer" ? MessageKind.PEER_MESSAGE : MessageKind.OWNER_MESSAGE,
        payload: input.pointer,
      });
      if (!enqueued.allowed) return enqueued as Decision<{ messageId: string }>;
      // Suppression is a *replay* answer, and on this path it can only be reached by a redelivery
      // whose ingress row is gone: `admit` refuses a live `(buzz, nonce)` slot as a replay long
      // before anything reaches here, and `IngressGuard.prune` keeps that slot alive for as long as
      // its turn claim is unresolved. So the row this hands back is one whose claim has already
      // been resolved and pruned — 24 hours and one settled turn ago.
      //
      // Returning it would be the fourth way an owner loses a message: outbox rows are never
      // pruned, so the caller would be handed a terminal row's id, told "Stored for the role", and
      // a *fresh* turn claim would be attached to an outbox row nothing can ever settle. Refusing
      // rolls the whole admission back, which leaves no spent nonce and no claim — the relay is
      // told plainly that this event id is spent rather than being told it was queued.
      if (enqueued.reasonCode === ReasonCode.OUTBOX_DUPLICATE_SUPPRESSED) {
        return deny(
          ReasonCode.OUTBOX_DUPLICATE_SUPPRESSED,
          "this event id already has an owner-message row, so nothing new was queued for it",
          { messageId: enqueued.value.messageId, status: enqueued.value.status },
        );
      }
      return allow(enqueued.reasonCode, { messageId: enqueued.value.messageId });
    },
    // #858. The ingress claim is the ledger `IngressGuard` writes; this is the one it does not.
    // The target is read back from the claim rather than resolved a second time -- the guard
    // stored what was decided, and a binding that fails over between the claim and this call must
    // not silently retarget the turn.
    materializeTurn: ({ channel, nonce, prompt, payload }) => {
      const query = guard.canonicalTargetForClaim(channel, nonce);
      if (!query) {
        return deny(
          ReasonCode.CONVERSATION_TARGET_UNVERIFIED,
          "the claim names no canonical target, so no canonical turn can name one either",
          { channel, nonce },
        );
      }
      const claimed = cp.conversation.claim({
        targetActorId: query.targetActorId,
        prompt,
        sources: [{ channel, nonce, attempt: 1, payload }],
      });
      return claimed.allowed
        ? allow(ReasonCode.OK, undefined)
        : deny(claimed.reasonCode, claimed.message, claimed.evidence);
    },
    wakeRole: async (roleKey) =>
      roleConversation
        ? await wakeRoleHolder(cp, roleConversation, roleKey, { kind: "owner message", ids: [] })
        : deny(ReasonCode.ROLE_PEER_ABSENT, "no role conversation listener is configured", {
            roleKey,
          }),
  };
  const socketPath = join(stateDir, "buzz-message.ingress.sock");
  removeStaleSocket(socketPath);
  const server = createServer((socket) => serveBuzzMessageTurn(socket, ingress, port));

  try {
    await listenSocket(server, socketPath);
  } catch (err) {
    if (existsSync(socketPath)) unlinkSync(socketPath);
    throw err;
  }

  return {
    socketPath,
    seam: { ingress, port, roleConversation },
    close: async () => {
      await closeSocketServer(server);
      try {
        if (existsSync(socketPath)) unlinkSync(socketPath);
      } catch {
        /* closing the server already releases its socket; this is only cleanup */
      }
    },
  };
};

/**
 * Main's own Buzz message composition: the listeners it just built, wired to the ingress.
 *
 * A named function rather than an object literal inside `main` because the one line that matters
 * here — which port a role-addressed event is delivered through — was otherwise unreachable by
 * any test. `main` runs a daemon, so a row that exercised it would have to stand one up; a row
 * that skipped it and passed its own port measured the port and not the wiring, and deleting the
 * production line left it green. This is the seam that makes the wiring falsifiable: a caller
 * hands over the real `LocalMcpListeners` and gets back the same ingress `main` gets.
 *
 * `startDaemonMcpListeners` sits beside `startLocalMcpListeners` for the same reason.
 */
export const startDaemonBuzzMessageIngress = (
  cp: ControlPlane,
  stateDir: string,
  policy: IngressPolicy,
  listeners: Pick<LocalMcpListeners, "ceoConversation" | "ctoConversation">,
  ownerActors: readonly string[],
  gatewayConversation?: (text: string, source: GatewayEventSource) => Promise<CeoTurnOutcome>,
): Promise<LocalBuzzMessageIngress> =>
  startBuzzMessageIngressListener(cp, stateDir, policy, {
    ceoConversation: listeners.ceoConversation,
    ownerActors,
    gatewayConversation,
    // The other half of #760 B4: a `p` tag that resolves to the CTO has somewhere to go. Without
    // this line resolution still happens and every role delivery refuses with ROLE_PEER_ABSENT,
    // which is the state that had a person carrying messages between the two roles.
    roleConversation: listeners.ctoConversation,
  });

/** The canonical session entries, when canonical activation is configured: one per CTO identity. */
export interface BuzzMentionCanonicalEntries {
  readonly sessions: readonly CanonicalAdoptableSession[];
}

/**
 * One identity's admission, with the line `primaryCtoBindingFor` prints when it refuses.
 *
 * Every condition is read here, in one place, because neither half is enough alone: an ACTIVE
 * PRIMARY_CTO assignment whose live runtime is not this READY session, and a READY session holding
 * no such assignment, are both refused. When canonical activation names this identity, the
 * binding's project must also be the one its entry names. The session's room is reported, and the
 * subscriber requires it to be one of the rooms its identity listens in.
 */
const judgeBuzzMentionIdentity = (
  cp: ControlPlane,
  canonical: BuzzMentionCanonicalEntries | null,
  pubkey: string,
): { judgement: BuzzMentionIdentityJudgement; said: string; detail: Record<string, unknown> } => {
  const refuse = (reason: string, said: string, detail: Record<string, unknown> = {}) => ({
    judgement: { verdict: "EXCLUDED", reason } as const,
    said,
    detail,
  });
  const channelIdentity = pubkey.trim();
  if (channelIdentity.length === 0) return refuse("CHANNEL_IDENTITY_EMPTY", "the channel identity is empty");
  const session = cp.db.get<{
    session_id: string;
    incarnation: string;
    buzz_actor_id: string | null;
    buzz_address: string | null;
  }>(
    `SELECT session_id, incarnation, buzz_actor_id, buzz_address FROM sessions
      WHERE buzz_actor_id = ? AND lifecycle IN ('READY','DRAINING')`,
    [channelIdentity],
  );
  if (!session || session.buzz_actor_id === null) {
    return refuse("NO_LIVE_SESSION", "no READY or DRAINING session carries this channel identity", {
      sessionsWithThisActor: cp.db.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM sessions WHERE buzz_actor_id = ?`,
        [channelIdentity],
      )[0]?.n ?? 0,
    });
  }
  const held = currentBindingsForRoles(cp, MENTIONABLE_ROLES).filter(
    (binding) => binding.sessionId === session.session_id,
  );
  const only = held.length === 1 ? held[0] : undefined;
  if (!only) {
    return refuse("NO_SINGLE_MENTIONABLE_ROLE", "that session holds no single mentionable role", {
      heldForSession: held.length,
      roles: held.map((binding) => binding.role),
      projects: cp.projects.list().length,
    });
  }
  if (only.role !== Role.PRIMARY_CTO) {
    return refuse("NOT_PRIMARY_CTO", "the one role that session holds is not PRIMARY_CTO", { role: only.role });
  }
  const entry = canonical?.sessions.find((one) => one.buzzActorId === channelIdentity);
  if (entry && entry.projectId !== only.projectId) {
    return refuse("PROJECT_MISMATCH", "the binding's project is not the one its canonical entry names");
  }
  // A canonical entry names one conversation. The binding must be that conversation's, by the same
  // authority the reattach admits a holder with: the assignment's actor carries the claude-cli
  // target for the entry's session UUID and digest, and that actor's live runtime is this exact
  // session and incarnation. A READY runtime under an ACTIVE assignment without it is not the
  // canonical session, and missing evidence is refused, never assumed.
  if (entry && !canonicalTargetHolds(cp, only.assignmentId, entry.sessionUuid, session.session_id, session.incarnation)) {
    return refuse("CANONICAL_TARGET_UNVERIFIED", "the binding is not the canonical session its entry names");
  }
  // The stored column travels back with the answer rather than being assumed equal to the lookup
  // key. `WHERE buzz_actor_id = ?` is SQLite's comparison, and the subscriber re-runs it in
  // constant time before it will speak for the role.
  return {
    judgement: {
      verdict: "ADMITTED",
      binding: {
        roleKey: only.roleKey,
        buzzActorId: session.buzz_actor_id,
        bindingGeneration: only.bindingGeneration,
        sessionId: only.sessionId,
        ...(only.projectId === null ? {} : { projectId: only.projectId }),
        room: session.buzz_address,
      },
    },
    said: "",
    detail: {},
  };
};

/**
 * Whether `assignmentId` is an ACTIVE PRIMARY_CTO assignment whose actor is bound to the canonical
 * conversation `sessionUuid` (executor, locator and digest) and is served right now by exactly
 * `sessionId` at `incarnation`. The join is the one canonical reattach admits a holder by.
 */
const canonicalTargetHolds = (
  cp: ControlPlane,
  assignmentId: string,
  sessionUuid: string,
  sessionId: string,
  incarnation: string,
): boolean =>
  (cp.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM assignments a
       JOIN conversational_actors c ON c.actor_id = a.actor_id AND c.retired_at IS NULL
       JOIN actor_target_bindings tb ON tb.target_actor_id = a.actor_id
      WHERE a.assignment_id = ? AND a.role = ? AND a.status = 'ACTIVE'
        AND tb.executor_kind = ? AND tb.target_locator = ? AND tb.target_locator_digest = ?
        AND c.current_session_id = ? AND c.current_session_incarnation = ?`,
    [assignmentId, Role.PRIMARY_CTO, SELF_CLAIM_EXECUTOR_KIND, sessionUuid, sha256(sessionUuid), sessionId, incarnation],
  )?.n ?? 0) === 1;

/**
 * The registry answer the relay subscriber preflights against (#760 Part C).
 *
 * Deliberately narrower than `buzzMentionRouter`'s. That one answers "which roles does this tag
 * name", for an envelope somebody else already decided to send; this one answers "may this daemon
 * open a socket and speak *as* this identity", and the two are not the same question. A session
 * holding the CEO binding as well as a CTO one is a perfectly good delivery address and is not
 * something this daemon may subscribe as: the subscriber asserts one role over one NIP-42
 * connection, and an identity with a second role has no single thing to assert.
 *
 * So: a live session, exactly one mentionable binding, and that binding a `PRIMARY_CTO`. Anything
 * else is `null` (or, asked through `judgeIdentity`, an exclusion with its reason), and it excludes
 * that identity alone: the subscriber's other identities are judged on their own answers.
 */
export const buzzMentionSubscriberRegistry = (
  cp: ControlPlane,
  canonical: BuzzMentionCanonicalEntries | null = null,
): BuzzMentionRegistry => ({
  // Four ways to answer `null`, and until 2026-09-16 they were one silent `null` between them.
  //
  // Measured that day: the subscriber refused at every start with "identities[0] does not currently
  // hold a live PRIMARY_CTO binding", while the same question answered *yes* everywhere it could be
  // asked from outside — the live database's rows, this exact code against a copy of them, the
  // deployed generation's own build of it, and a `ControlPlane` built over the copy. Five
  // hypotheses were eliminated by measurement (identity mismatch, key derivation, startup
  // ordering, database preconditions, deployed-versus-current build) and the refusal still could
  // not be attributed, because the one thing nobody could see was which of these four lines the
  // live process took.
  //
  // A refusal that does not say what it refused costs a day of narrowing from the outside. So each
  // return says which condition failed and what it saw. `reason` is a fixed string, never a value
  // read from the request, and the numbers are counts — a pubkey is public but this stays a
  // diagnostic about the deployment's own shape rather than an echo of its input.
  primaryCtoBindingFor: (pubkey) => {
    const judged = judgeBuzzMentionIdentity(cp, canonical, pubkey);
    if (judged.judgement.verdict === "ADMITTED") return judged.judgement.binding;
    process.stderr.write(`Buzz mention binding lookup refused: ${judged.said} ${JSON.stringify(judged.detail)}\n`);
    return null;
  },
  // The same judgement with its reason code and without the line above: the subscriber asks it at
  // startup, on every re-judgement and before every delivery, and writes the reason into health.
  judgeIdentity: (pubkey) => judgeBuzzMentionIdentity(cp, canonical, pubkey).judgement,
  // #1044. Read when a frame arrives, before it queues: the CEO binding and this role's binding as
  // they stand at that moment. The seam compares it with the registry when the frame is processed.
  peerReceiptFor: (roleKey) => {
    const ceo = cp.bindings.active(roleKeyFor(Role.CEO));
    const cto = cp.bindings.active(roleKey);
    return ceo && cto
      ? {
          ceoBindingGeneration: ceo.bindingGeneration,
          ceoSessionId: ceo.sessionId,
          ctoRoleKey: cto.roleKey,
          ctoBindingGeneration: cto.bindingGeneration,
          ctoSessionId: cto.sessionId,
        }
      : null;
  },
});

/**
 * A retry is a statement that the answer may change; a refusal is a statement about one event and
 * about nothing else.
 *
 * Only one refusal on this path is transient: the addressed role is between holders, so the
 * admission rolled back, nothing was spent, and the same event admitted a minute later is the
 * message arriving rather than a duplicate.
 *
 * The `ALREADY_DURABLE` codes are the ones where the durable copy demonstrably exists — a replay
 * of a message this daemon already has, a claimed turn whose outcome nobody recorded, an event id
 * that already owns an outbox row. Those are as good as a success for the purpose the subscriber
 * uses this answer for, which is deciding how far its request window may move.
 *
 * **Everything else is `REFUSED`, and that is deliberately not cursor-trusted.** The list of ways
 * a stranger reaches this function is short and it is not empty: the relay's `p` filter authorizes
 * nobody, so anyone who can sign a kind-9 event can address one here and collect an
 * `INGRESS_ACTOR_NOT_ALLOWLISTED`. If that answer advanced the window, a stranger could choose it
 * — one far-future timestamp and the owner's real messages fall outside the next request. So the
 * default is the answer that changes nothing, and a code has to be named above to be trusted with
 * the cursor rather than merely to avoid a reconnect loop.
 */
const SUBSCRIBER_RETRY_CODES: readonly string[] = [ReasonCode.ROLE_PEER_ABSENT];
const SUBSCRIBER_ALREADY_DURABLE_CODES: readonly string[] = [
  ReasonCode.INGRESS_REPLAY_IGNORED,
  ReasonCode.INGRESS_TURN_OUTCOME_UNKNOWN,
  ReasonCode.OUTBOX_DUPLICATE_SUPPRESSED,
];

/** What the admission seam's `Decision` means to a subscriber holding a volatile cursor. */
export const buzzMentionAdmissionOf = (decision: Decision<unknown>): BuzzMentionAdmission => {
  if (decision.allowed) return "DURABLE";
  if (SUBSCRIBER_ALREADY_DURABLE_CODES.includes(decision.reasonCode)) return "ALREADY_DURABLE";
  if (SUBSCRIBER_RETRY_CODES.includes(decision.reasonCode)) return "RETRY";
  // Terminal, and trusted with the cursor: the event was signed before the addressed role's binding
  // generation, so it moves the window only to a time before that binding, where nothing this
  // binding may be handed can be. Only an owner or the current CEO as a peer reaches this refusal —
  // a stranger is refused before admission — and floors only move forward, because a later
  // generation is created later.
  if (decision.reasonCode === ReasonCode.BUZZ_MENTION_PRECEDES_BINDING) return "PRECEDES_BINDING";
  return "REFUSED";
};

/**
 * `buzzMentionAdmissionOf`, with a refusal's reason code kept for health (#1038).
 *
 * The cursor still reads only the four-valued answer. The code is for the operator: on the live
 * daemon 710 of 721 `admission-refused` frames were the CEO's own mentions, and the bare count
 * could not say so.
 */
export const buzzMentionVerdictOf = (decision: Decision<unknown>): BuzzMentionVerdict => {
  const admission = buzzMentionAdmissionOf(decision);
  return admission === "REFUSED" ? { admission, reasonCode: decision.reasonCode } : { admission };
};

/**
 * The envelope the daemon's sink presents for one verified relay event (#760 Part C, #1038).
 *
 * The event's author is presented as the actor and the seam decides what it is: an owner, the
 * current CEO binding speaking as a peer, or nobody. For the CEO's event this is also where the
 * event is bound to its generation — at receipt, through the same rule admission re-runs before
 * its first write — so an envelope built here and dispatched after a rotation is refused rather
 * than re-attributed. Exported so that "built at receipt, dispatched later" is a row a test can
 * write against the exact envelope the sink builds.
 */
export const buzzMentionInputFor = (
  ingress: BuzzMessageIngress,
  secret: string,
  request: BuzzMentionAdmissionRequest,
): BuzzMessageIngressInput => {
  const input: BuzzMessageIngressInput = {
    // The event's own author, checked against the declared buzz owners by the seam. A
    // subscriber cannot widen that: it presents who signed the event and nothing else.
    actor: request.event.pubkey,
    conversation: request.conversation,
    eventId: request.event.id,
    addressedTo: BUZZ_MENTION_ADDRESSED_TO,
    // The identity whose `p` tag matched, which is the address the seam resolves to a role.
    mention: request.identityPubkey,
    text: request.event.content,
    // The signed time, which is inside the payload only once a generation proof is attached.
    createdAt: request.event.created_at,
  };
  // #1044. The proof presented is the subscriber's receipt — what was current when the frame
  // arrived — rather than one built here: a frame that waited across a rotation would otherwise be
  // stamped with the generation it happened to be processed under. `observePeer` only decides
  // whether this is a peer's envelope at all, so an owner's payload stays exactly what it was.
  const peer = ingress.observePeer(input).allowed ? request.receipt : null;
  const bound = peer ? { ...input, peer } : input;
  return { ...bound, signature: ingressSignature(secret, buzzMessageSigningRequest(bound)) };
};

/**
 * The adopted CEO's Buzz binding challenges (`BuzzBindChallenges`), over this daemon's registries:
 * minted on the adopted CEO tool socket, answered through the mention subscriber, written by the one
 * writer of `sessions.buzz_actor_id` with the relay credential's allowlist as its authenticator.
 *
 * A refused answer leaves one `SESSION_BUZZ_ACTOR_BIND_REFUSED` row per challenge and cause.
 */
export const createDaemonBuzzBindChallenges = (cp: ControlPlane, policy: IngressPolicy): BuzzBindChallenges => {
  const guard = new IngressGuard(cp.db, cp.clock, cp.audit, { buzz: policy });
  return new BuzzBindChallenges({
    nowMs: () => cp.clock.now().getTime(),
    currentCeo: () => {
      const ceo = cp.bindings.active(roleKeyFor(Role.CEO));
      if (!ceo) return null;
      const lifecycle = cp.sessions.get(ceo.sessionId)?.lifecycle;
      return {
        sessionId: ceo.sessionId,
        sessionIncarnation: ceo.sessionIncarnation,
        bindingGeneration: ceo.bindingGeneration,
        live: lifecycle === SessionLifecycle.READY || lifecycle === SessionLifecycle.DRAINING,
      };
    },
    // The refusals the writer would give, asked before a challenge exists so the CEO hears them
    // from the tool call rather than from a message that silently binds nothing.
    bindable: (sessionId, actor) => {
      if (!guard.isAllowedActor("buzz", actor)) {
        return deny(
          ReasonCode.SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED,
          "buzz channel identity is not authenticated by the deployment's ingress policy",
          { sessionId, buzzActorId: actor },
        );
      }
      const held = cp.sessions.get(sessionId)?.buzzActorId ?? null;
      if (held !== null && held !== actor) {
        return deny(ReasonCode.SESSION_BUZZ_ACTOR_IMMUTABLE, "session already speaks as a different buzz channel identity", {
          sessionId,
        });
      }
      if (cp.sessions.otherSessionCarrying(actor, sessionId) !== null) {
        return deny(ReasonCode.SESSION_BUZZ_ACTOR_ALREADY_BOUND, "another session row already carries this identity", {
          sessionId,
        });
      }
      return allow(ReasonCode.OK, undefined);
    },
    bind: (possession) => cp.sessions.bindBuzzActor({ possession }, guard),
    recordRefusal: (refusal) => {
      cp.audit.record({
        kind: "SESSION_BUZZ_ACTOR_BIND_REFUSED",
        reasonCode: refusal.reasonCode,
        sessionId: refusal.sessionId,
        actor: `buzz:${refusal.author}`,
        evidence: {
          channel: "buzz",
          cause: refusal.cause,
          nonce: buzzMessageNonce(refusal.eventId),
          generation: refusal.ceoBindingGeneration,
        },
      });
    },
  });
};

/**
 * The daemon's own front door on the relay, feeding the seam a person's CLI feeds (#760 Part C).
 *
 * Two things are worth stating about the signature this composes. The subscriber has already
 * verified the *event's* signature — that is what says the owner wrote these words — and the
 * envelope it hands the seam is then signed with the deployment's ingress secret, because that is
 * the credential `IngressGuard` authenticates a local submission with. The daemon is standing
 * where the relay-side CLI stood, so it presents the credential that surface has always presented.
 *
 * What it deliberately does not do is skip the seam. Calling `enqueue` directly would be shorter
 * and would bypass the owner allowlist, the `(buzz, nonce)` replay slot, the address resolution
 * and the single-transaction admission — every one of which is a refusal this path is required to
 * make, and none of which this module is allowed to be a second authority for.
 *
 * A daemon with no `buzz-nostr-subscriber.json` gets a handle reporting zero sockets. That is the
 * configured-off state, and it is a value rather than a `null` so a caller cannot read "absent"
 * as "running".
 */
export const startDaemonBuzzMentionSubscriber = (
  cp: ControlPlane,
  stateDir: string,
  policy: IngressPolicy,
  messageIngress: Pick<LocalBuzzMessageIngress, "seam">,
  options: {
    openSocket?: BuzzRelaySocketFactory;
    scheduler?: BuzzSubscriberScheduler;
    /** The adopted CEO's pending Buzz binding challenges, shared with its tool socket. */
    bindChallenges?: BuzzBindChallenges;
    /** The canonical session entries, so an identity's binding must be on its entry's project. */
    canonical?: BuzzMentionCanonicalEntries | null;
    /** Where admission changes are reported; the subscriber's own stderr line when absent. */
    reportAdmission?: BuzzMentionAdmissionReporter;
  } = {},
): BuzzMentionSubscriberHandle => {
  const secret = policy.secret?.trim() ?? "";
  if (secret.length === 0) {
    throw new Error("Buzz mention subscriber requires a non-empty signing secret");
  }
  const sink: BuzzMentionSink = {
    admit: async (request) => {
      // A verified event carrying the binding marker in any form goes to the binding, and never to
      // admission, so it is not delivered as a message to anyone (ACP1055-01). Decided by the
      // content, not by whether a store is wired: without one, such an event is refused outright.
      if (buzzBindContentOf(request.event.content).kind !== "NONE") {
        return buzzMentionVerdictOf(
          options.bindChallenges?.settle(request.event) ??
            deny(ReasonCode.INVALID_ARGUMENT, "this daemon serves no Buzz binding challenge"),
        );
      }
      // The subscriber judged this delivery against the binding it names, immediately before
      // calling here. Read once more before the seam's first write: a re-claim or a session change
      // committed in between makes this a retry, never a delivery on the strength of a binding that
      // has moved. The retry asks the relay again and is judged against the binding that holds then.
      if (request.binding !== undefined && buzzMentionBindingMoved(cp, request.roleKey, request.binding)) {
        return "RETRY";
      }
      // The seam's own port, with its wake replaced for this one delivery: the wake this admission
      // causes is a mention's, and carries the context this path verified. Nothing a caller says
      // decides that; only this path builds it.
      const mention: MentionWakeContext = {
        actorId: request.identityPubkey,
        roleKey: request.roleKey,
        room: request.conversation,
        eventId: request.event.id,
      };
      const delivered = await deliverBuzzMessage(
        messageIngress.seam.ingress,
        {
          ...messageIngress.seam.port,
          wakeRole: (roleKey) => wakeForMention(messageIngress.seam.roleConversation, roleKey, mention),
        },
        buzzMentionInputFor(messageIngress.seam.ingress, secret, request),
      );
      return buzzMentionVerdictOf(delivered);
    },
  };
  const handle = startBuzzMentionSubscriberFromStateDir(stateDir, {
    registry: buzzMentionSubscriberRegistry(cp, options.canonical ?? null),
    sink,
    ...(options.openSocket ? { openSocket: options.openSocket } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    ...(options.reportAdmission ? { reportAdmission: options.reportAdmission } : {}),
  });
  runningMentionSubscribers.set(cp, handle);
  return handle;
};

/**
 * The mention subscriber started over each control plane, read by the CTO port's wake eligibility.
 * The latest start wins; a closed subscriber answers no eligibility, so it gates nothing.
 */
const runningMentionSubscribers = new WeakMap<ControlPlane, BuzzMentionSubscriberHandle>();

/**
 * Whether `roleKey`'s live binding is no longer the generation and serving session a delivery names.
 * Exported so the sink's last check is a row a test can write without racing the subscriber.
 */
export const buzzMentionBindingMoved = (
  cp: ControlPlane,
  roleKey: string,
  binding: BuzzMentionDeliveryBinding,
): boolean => {
  const current = cp.bindings.active(roleKey);
  if (!current) return true;
  if (binding.bindingGeneration !== null && current.bindingGeneration !== binding.bindingGeneration) return true;
  return binding.sessionId !== null && current.sessionId !== binding.sessionId;
};

/**
 * The gate a mention's wake must pass: the holder's current session carries exactly the channel
 * identity the mention named, for the role it was admitted for, and the mention subscriber judges
 * that identity admitted, answering in the room the mention arrived in. The holder's own identity
 * is read from its current session; no other subscription's role pin stands in for it.
 */
export const buzzMentionWakeGate = (
  cp: ControlPlane,
  running: () => Pick<BuzzMentionSubscriberHandle, "deliveryEligibility"> | null,
): MentionWakeGate => (binding, mention) => {
  const actorId =
    cp.db.get<{ buzz_actor_id: string | null }>(`SELECT buzz_actor_id FROM sessions WHERE session_id = ?`, [
      binding.sessionId,
    ])?.buzz_actor_id ?? null;
  if (actorId !== mention.actorId || binding.roleKey !== mention.roleKey) return false;
  const eligibility = running()?.deliveryEligibility({ actorId, roleKey: binding.roleKey }) ?? null;
  return eligibility !== null && eligibility.eligible && eligibility.room === mention.room;
};

/**
 * The wake for a mention the daemon's own subscriber delivered, carrying that mention's verified
 * context. A context this path cannot state, or no role port to give it to, refuses the wake; it
 * never falls through to an ordinary wake.
 */
const wakeForMention = (
  roleConversation: Pick<RoleConversationPort, "wake"> | null,
  roleKey: string,
  mention: MentionWakeContext,
): Promise<Decision<void>> => {
  if (roleConversation === null || mention.roleKey !== roleKey || [mention.actorId, mention.room, mention.eventId].some((value) => value.length === 0)) {
    return Promise.resolve(deny(ReasonCode.ROLE_PEER_STALE, "a mention's wake carried no usable mention context", { roleKey }));
  }
  return roleConversation.wake(roleKey, mention);
};

/**
 * Re-judges the mention subscriber's identities after every committed binding switch: a bind, a
 * re-claim, a session change and a revoke all publish one (`BindingRegistry.onSwitch`). Off the
 * committing call stack, and against whichever subscriber is running when it fires, so a switch
 * before the subscriber starts or after it closes does nothing.
 *
 * The subscriber's own judgement timer covers what no switch announces — a session taking its
 * channel identity, or its room, after its binding — on the reconnect schedule.
 */
export const rejudgeBuzzMentionSubscriberOnBindingSwitch = (
  cp: ControlPlane,
  running: () => Pick<BuzzMentionSubscriberHandle, "rejudge"> | null,
): void => {
  cp.bindings.onSwitch(() => {
    setImmediate(() => {
      running()?.rejudge();
    });
  });
};

/** The running owner-reply consumer and the wake-ups wired to it. */
export interface DaemonOwnerReplyConsumer {
  readonly consumer: OwnerReplyConsumer;
  /** The startup sweep, for a caller that wants to wait for it. Main does not. */
  readonly started: Promise<void>;
  close(): void;
}

/**
 * Main's owner-reply consumer (#1036), beside the mention subscriber whose identities and
 * connections it publishes through, so it shares that subscriber's relay and configuration.
 *
 * Woken three ways and no other: when the coordinator commits a settlement that wrote a new item,
 * when an identity's relay connection authenticates (first connect and every reconnect), and once
 * now, at startup. A deployment with no subscriber still runs it, because a Telegram item must
 * still get its one `OWNER_REPLY_UNDELIVERABLE_NO_TRANSPORT` row, and a Buzz item one saying the
 * same.
 */
export const startDaemonOwnerReplyConsumer = (
  cp: ControlPlane,
  subscriber: BuzzMentionSubscriberHandle | null,
  options: { timers?: OwnerReplyTimers; publishTimeoutMs?: number } = {},
): DaemonOwnerReplyConsumer => {
  const replies = subscriber !== null && subscriber.socketCount > 0 ? subscriber.replies : null;
  const consumer = new OwnerReplyConsumer({
    db: cp.db,
    clock: cp.clock,
    audit: cp.audit,
    buzz: replies,
    timers: options.timers ?? nativeSubscriberScheduler(),
    ...(options.publishTimeoutMs === undefined ? {} : { publishTimeoutMs: options.publishTimeoutMs }),
    onError: (error) => {
      process.stderr.write(`owner-reply consumer: ${error instanceof Error ? error.message : String(error)}\n`);
    },
  });
  const stopSettlementWake = cp.conversation.onOwnerReplyEnqueued(() => void consumer.wake("DUE"));
  const stopRelayWake = replies?.onAuthenticated(() => void consumer.wake("RELAY")) ?? (() => undefined);
  const started = consumer.start();
  return {
    consumer,
    started,
    close: () => {
      stopSettlementWake();
      stopRelayWake();
      consumer.close();
    },
  };
};

/**
 * The daemon's own room and the mention subscriber's rooms, cross-checked.
 *
 * A pure comparison, deliberately: `ACP_BUZZ_CHANNEL` is read once, by `main()`, and the
 * subscriber's handle carries its own configured rooms without ever touching the environment
 * itself (`src/buzz/buzz-mention-subscriber.ts`) — so this is where the two meet, and it is
 * exported specifically so that meeting is testable without a daemon subprocess.
 *
 * Refuses only when both sides have something to disagree about: an unset `ACP_BUZZ_CHANNEL` or
 * an unconfigured subscriber (`rooms.length === 0`, meaning no `buzz-nostr-subscriber.json`) leave
 * nothing to cross-check, and `buzz-adapter.ts`'s own refusal already covers the outbound-only
 * case. A mismatch here means the daemon would answer a reply in one room while its subscriber
 * listens in another — silent on both sides, since neither adapter can see the other's binding.
 */
export const assertBuzzChannelMatchesSubscriberRooms = (
  answeringBuzzChannel: string | undefined,
  subscriberRooms: readonly string[],
): void => {
  if (!answeringBuzzChannel || subscriberRooms.length === 0) return;
  if (subscriberRooms.includes(answeringBuzzChannel)) return;
  throw new Error(
    `ACP_BUZZ_CHANNEL (${answeringBuzzChannel}) is not among the Buzz mention subscriber's ` +
      `configured rooms (${subscriberRooms.join(", ")}); the daemon would answer in one room and ` +
      "listen in another",
  );
};

/** The subscriber's per-identity rooms as the lookup `unsubscribedRoomRefusal` asks. */
export const subscribedBuzzRoomsFrom = (identityRooms: readonly BuzzSubscriberIdentityRooms[]): SubscribedBuzzRooms =>
  (buzzActorId) => identityRooms.find((identity) => identity.actorId === buzzActorId)?.rooms ?? null;

/**
 * Every adopted session's room, cross-checked against the rooms its own subscriber identity
 * listens in.
 *
 * `assertBuzzChannelMatchesSubscriberRooms` above compares one room with the union of all of them,
 * which was the whole question while every canonical CTO was written into `ACP_BUZZ_CHANNEL`. An
 * entry may now name its own room (`buzzAddress`), and the claim and the reattach's correction write
 * that room into the CTO's row, where the peer rule admits its CEO's mentions from that room only.
 * The subscriber asks the relay for each identity's own rooms, so an entry routed to room B whose
 * identity listens in A alone passes the union check and then never hears a mention in B.
 *
 * Per entry, its effective room (its `buzzAddress`, else `ACP_BUZZ_CHANNEL`) must be among the rooms
 * of the identity that listens as its `buzzActorId`. An entry no identity listens as is not checked,
 * and neither is anything when no subscriber runs: there is nothing to be deaf in either case. The
 * refusal names the project and both rooms, never the session, the actor or a key.
 *
 * Refused, not repaired: the subscription keeps the rooms its own file declares instead of following
 * the entry's room, as `ACP_BUZZ_CHANNEL` above is refused rather than added. It reads configuration
 * only, never a session's `buzz_address`, so a row left in a room no entry names any more is not
 * found here.
 */
export const assertCanonicalRoomsAreSubscribed = (
  canonicalSessions: readonly CanonicalAdoptableSession[],
  canonicalBuzzChannelId: string,
  subscribedRooms: SubscribedBuzzRooms,
): void => {
  for (const entry of canonicalSessions) {
    const deaf = unsubscribedRoomRefusal(entry, canonicalBuzzChannelFor(entry, canonicalBuzzChannelId), subscribedRooms);
    if (deaf !== null) throw new Error(`ACP_CANONICAL_SESSIONS_JSON does not match the Buzz mention subscriber: ${deaf}`);
  }
};

/**
 * The operator surface is deliberately a one-request protocol rather than a general RPC
 * framework. A dedicated credential is bound to a configured peer and a live listener
 * incarnation before the daemon applies the per-method lock/authority checks. The MCP token
 * is never accepted here: it is shared deployment authentication, not operator identity.
 */
export const startDaemonOperatorSocket = (
  cp: ControlPlane,
  daemon: Pick<Daemon, "handleOperatorRequest" | "lock">,
  stateDir: string,
  credential: LocalOperatorCredential,
  options: Omit<LocalOperatorSocketOptions, "ctoBinding"> = {},
): Promise<LocalOperatorListener> => {
  // Possession of the deployment operator bearer is not owner authority. Restoring
  // an existing CEO actor transfers its identity and issues a new session secret,
  // so admit only the server-configured CLI owner before the bootstrap authority
  // derives a restoration target or launches either caller-selected executable.
  // Never take channel/actor/owner claims from the request body or peerId text.
  const operatorActor = credential.actor.trim();
  const bootstrap = options.bootstrapHermes;
  const adopt = options.adoptHermesIncumbent;
  return startOperatorSocket(daemon, stateDir, credential, {
    ...options,
    ...(bootstrap ? { bootstrapHermes: (params: Record<string, unknown>) => {
      if (cp.bindings.history(Role.CEO).length > 0 &&
          !cp.ownerAuthority.isAllowedActor("cli", operatorActor)) {
        return Promise.resolve(deny(ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED,
          "restoring CEO authority requires an allowlisted CLI owner", {}));
      }
      return bootstrap(params);
    } } : {}),
    ...(adopt ? { adoptHermesIncumbent: () => {
      if (!cp.ownerAuthority.isAllowedActor("cli", operatorActor)) {
        return Promise.resolve(deny(ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED,
          "incumbent adoption requires an allowlisted CLI owner", {}));
      }
      return adopt();
    }, adoptHermesIncumbentOwnerAllowed: () => cp.ownerAuthority.isAllowedActor("cli", operatorActor) } : {}),
    ctoBinding: daemonCtoBindingRuntime(cp),
  });
};

/**
 * No head is configured. `ACP_HERMES_EXPECTED_LIVE_SESSION_ID` and `ACP_HERMES_TARGET_SESSION_ID`
 * pinned the conversation's head by hand, and a compression that rotated it stopped adoption, the
 * adopted CEO's tools and delivery until both were rewritten and the daemon restarted (2026-10-03).
 * Inside the configured lineage the head is the one the Gateway reports, kept in the database
 * (`hermes-target-head.ts`). A Keychain that still holds the two values is not refused; nothing
 * reads them.
 */
const HERMES_ADOPTION_VARS = [
  "ACP_HERMES_LINEAGE_ROOT_DIGEST", "ACP_HERMES_EXECUTABLE", "ACP_HERMES_PROFILE",
  "ACP_HERMES_HOME", "ACP_HERMES_EXECUTOR_RUNTIME_IDENTITY", "ACP_HERMES_GATEWAY_API_KEY",
] as const;

const configuredHermesAdoptionValues = (configuration: Readonly<Record<string, string | undefined>>) => {
  const values = Object.fromEntries(HERMES_ADOPTION_VARS.map((key) => [key, configuration[key]])) as
    Record<(typeof HERMES_ADOPTION_VARS)[number], string | undefined>;
  const validText = (value: string | undefined): value is string =>
    typeof value === "string" && value.trim() === value && value.length > 0 &&
    value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
  return HERMES_ADOPTION_VARS.every((key) => validText(values[key])) &&
    isDigest(values.ACP_HERMES_LINEAGE_ROOT_DIGEST) &&
    /^[\x21-\x7e]+$/.test(values.ACP_HERMES_GATEWAY_API_KEY ?? "") ? values : null;
};

/**
 * The daemon's receipt port (U4, A2): the Hermes Gateway's own receipt store for Telegram turns,
 * read with the Gateway key the daemon already holds for the identity readback.
 *
 * Only the key decides. Without it the coordinator keeps `NEVER_FOUND_RECEIPT_PORT`, the dark
 * default, and a configuration that already names a receipt port keeps the one it names. The port
 * is not asked for anything until a turn is in doubt.
 */
export const withConfiguredHermesGatewayReceipt = (
  config: ControlPlaneConfig,
  environment: Readonly<Record<string, string | undefined>>,
): ControlPlaneConfig => {
  const apiKey = environment["ACP_HERMES_GATEWAY_API_KEY"];
  if (config.hermesReceipt || config.hermesGatewayReceipt) return config;
  if (typeof apiKey !== "string" || !/^[\x21-\x7e]+$/.test(apiKey)) return config;
  return { ...config, hermesGatewayReceipt: { apiKey } };
};

/** The ports the pinned CEO Gateway target reads through; every one is a test seam. */
interface HermesCeoPinPorts {
  identityReader?: typeof createHermesGatewayIdentityReader;
  processStartToken?: typeof readProcessStartToken;
  processStartedAt?: typeof processStartedAt;
  authorityHeld?: () => boolean;
}

/** One pinned CEO Gateway target: the four fields a POST must name, and the fence at its dispatch. */
interface HermesCeoPin {
  apiKey: string;
  expected: GatewayIncumbentProof;
  preDispatch: () => boolean;
}

/**
 * The CEO Gateway target every daemon-to-CEO POST is pinned to: the conversation turn below and the
 * daemon notice (acp-daemon-notice/v1) alike, so the two cannot disagree about where the CEO is.
 * Undefined when no Hermes adoption variable is configured; a pin that resolves to null refuses the
 * POST before it is made.
 */
const configuredHermesCeoPin = (
  cp: ControlPlane,
  configuration: Readonly<Record<string, string | undefined>>,
  ports: HermesCeoPinPorts,
): (() => Promise<HermesCeoPin | null>) | undefined => {
  if (!HERMES_ADOPTION_VARS.some((key) => configuration[key] !== undefined)) return undefined;
  const values = configuredHermesAdoptionValues(configuration);
  const readGateway = values ? lockedGatewayOrigin(values, ports) : null;
  const currentAuthority = () => {
    if (!values || (ports.authorityHeld && !ports.authorityHeld())) return null;
    const binding = cp.bindings.active("CEO");
    if (!binding || binding.status !== "ACTIVE") return null;
    const session = cp.sessions.get(binding.sessionId);
    const owner = cp.db.get<{ actor_id: string }>(
      `SELECT actor_id FROM assignments
        WHERE assignment_id = ? AND role_key = 'CEO' AND status = 'ACTIVE'
          AND binding_generation = ? AND session_id = ? AND session_incarnation = ?`,
      [binding.assignmentId, binding.bindingGeneration, binding.sessionId, binding.sessionIncarnation],
    );
    // The stored target, not a configured head: the lineage is configured, the head is whatever
    // the database last recorded for it (`hermes-target-head.ts`).
    const target = owner ? readHermesTargetHead(cp.db, owner.actor_id) : null;
    if (!session || session.lifecycle !== SessionLifecycle.READY || session.incarnation !== binding.sessionIncarnation ||
        session.provider !== "hermes" || !Number.isSafeInteger(session.osPid) || !session.osPid ||
        session.osPid <= 0 || !session.osProcessStartedAt ||
        (ports.processStartedAt ?? processStartedAt)(session.osPid) !== session.osProcessStartedAt ||
        !target || target.executorKind !== "hermes" ||
        target.lineageRootDigest !== values.ACP_HERMES_LINEAGE_ROOT_DIGEST) return null;
    const startToken = (ports.processStartToken ?? readProcessStartToken)(session.osPid);
    if (!startToken || (ports.authorityHeld && !ports.authorityHeld())) return null;
    // #1037 R1: the lstart compare above has one-second grain. The tool admission's own rule
    // decides whether the live process is the recorded one, exactly: the live token equals the
    // native start pinned for the row, or nothing is delivered. A row with no pin is refused here
    // as it is there; the lstart rule that once decided an unpinned row is deleted (see
    // `recordedStartIsLive`). Falling back to the live token when no pin exists was dropped rather
    // than kept: it compared the live process with itself.
    const recordedStart = recordedStartIsLive(
      { sessionId: session.sessionId, osProcessStartedAt: session.osProcessStartedAt },
      startToken,
      cp.sessions,
    );
    if (!recordedStart.allowed) return null;
    return { assignmentId: binding.assignmentId, bindingGeneration: binding.bindingGeneration,
      sessionId: binding.sessionId, sessionIncarnation: binding.sessionIncarnation,
      processPid: session.osPid, startToken, target };
  };
  type Authority = NonNullable<ReturnType<typeof currentAuthority>>;
  const sameAuthority = (current: Authority | null, pinned: Authority): current is Authority =>
    current !== null && current.assignmentId === pinned.assignmentId &&
    current.bindingGeneration === pinned.bindingGeneration && current.sessionId === pinned.sessionId &&
    current.sessionIncarnation === pinned.sessionIncarnation && current.processPid === pinned.processPid &&
    current.startToken === pinned.startToken && current.target.targetBindingId === pinned.target.targetBindingId &&
    current.target.head === pinned.target.head;
  /**
   * The head this turn is delivered to, by the rule adoption and the tool admission share: the
   * Gateway's readback must come from the bound process (its pid and the native start pinned for
   * it) in the bound lineage, and a head that moved inside the lineage is recorded first, in one
   * transaction fenced on the same authority. Null refuses the turn before any POST.
   */
  const trackedHead = async (pinned: Authority): Promise<string | null> => {
    let reported: GatewayIncumbentProof;
    try { reported = await readGateway!(); } catch { return null; }
    const current = currentAuthority();
    if (!sameAuthority(current, pinned)) return null;
    if (reported.process_pid !== current.processPid) return null;
    if (reported.process_started_at !== current.startToken) return null;
    const head = judgeLiveHead(current.target, reported);
    if (head.verdict === "REFUSE") return null;
    if (head.verdict === "SAME") return head.head;
    const advanced = headAdvanceTransaction(cp.db, (): Decision<void> => {
      if (!sameAuthority(currentAuthority(), pinned)) {
        return deny(ReasonCode.CONFLICT, "the CEO authority moved while the Gateway was read", {});
      }
      return recordHeadAdvance(cp.db, cp.audit, current.target, head, { path: "gateway_delivery",
        sessionId: current.sessionId, roleKey: roleKeyFor(Role.CEO),
        bindingGeneration: current.bindingGeneration, gatewayPid: current.processPid });
    });
    return advanced.allowed ? head.head : null;
  };
  return async () => {
    const before = currentAuthority();
    if (!values || !before) return null;
    const head = await trackedHead(before);
    const pinned = head === null ? null : currentAuthority();
    if (head === null || pinned === null || pinned.target.head !== head) return null;
    return {
      apiKey: values["ACP_HERMES_GATEWAY_API_KEY"]!,
      expected: { session_id: head,
        lineage_root_digest: values.ACP_HERMES_LINEAGE_ROOT_DIGEST!,
        process_pid: pinned.processPid, process_started_at: pinned.startToken },
      preDispatch: () => sameAuthority(currentAuthority(), pinned),
    };
  };
};

/** A configured route must never revert to the independently attached MCP peer. */
export const createConfiguredHermesGatewayConversation = (
  cp: ControlPlane,
  configuration: Readonly<Record<string, string | undefined>>,
  ports: HermesCeoPinPorts & { senderFactory?: typeof createHermesGatewayConversationSender } = {},
): ((text: string, source: GatewayEventSource) => Promise<CeoTurnOutcome>) | undefined => {
  const pin = configuredHermesCeoPin(cp, configuration, ports);
  if (pin === undefined) return undefined;
  const refuse = (): CeoTurnOutcome => ({ contact: "NEVER_REACHED",
    answered: deny(ReasonCode.CEO_CONVERSATION_STALE, "adopted Gateway CEO target unavailable") });
  return async (text, source) => {
    const pinned = await pin();
    if (pinned === null) return refuse();
    return (ports.senderFactory ?? createHermesGatewayConversationSender)({
      apiKey: pinned.apiKey, binding: "acp-canonical-ceo", expected: pinned.expected, preDispatch: pinned.preDispatch,
    })(text, source);
  };
};

/**
 * acp-daemon-notice/v1 (#1068 finding 04): where the daemon delivers a refusal notice to the CEO — the
 * same pinned CEO Gateway target as the conversation turn above, with a sender bound to it. Undefined
 * when no Hermes adoption variable is configured.
 */
export const createConfiguredHermesGatewayDaemonNoticeTarget = (
  cp: ControlPlane,
  configuration: Readonly<Record<string, string | undefined>>,
  ports: HermesCeoPinPorts & { noticeSenderFactory?: typeof createHermesGatewayDaemonNoticeSender } = {},
): DaemonNoticeTargetResolver | undefined => {
  const pin = configuredHermesCeoPin(cp, configuration, ports);
  if (pin === undefined) return undefined;
  return async () => {
    const pinned = await pin();
    if (pinned === null) return null;
    return {
      destination: { ...pinned.expected },
      send: (ports.noticeSenderFactory ?? createHermesGatewayDaemonNoticeSender)({
        apiKey: pinned.apiKey, preDispatch: pinned.preDispatch,
      }),
    };
  };
};

/** The daemon's notice delivery loop, as the composition holds it. */
export interface DaemonPeerMessageNoticeDelivery {
  /** One pass, single-flight: a pass already running is joined, never doubled. */
  tick(): Promise<DaemonNoticeDeliveryReport | null>;
  close(): void;
}

/** Between passes. A delivery waits at most this long after the notice it owes is written. */
export const PEER_MESSAGE_NOTICE_DELIVERY_INTERVAL_MS = 30_000;

/**
 * Starts the daemon's own delivery of OWED refusal notices to the CEO (acp-daemon-notice/v1), with no
 * successor CTO involved: a pass now, then one every interval, never two at once. The lane secret is
 * held by this closure only for the derivation each pass makes; nothing here logs or stores it.
 */
export const startDaemonPeerMessageNoticeDelivery = (
  cp: ControlPlane,
  resolveTarget: DaemonNoticeTargetResolver,
  laneSecret: string,
  options: { intervalMs?: number; onError?: (error: unknown) => void; startImmediately?: boolean } = {},
): DaemonPeerMessageNoticeDelivery => {
  let running: Promise<DaemonNoticeDeliveryReport | null> | null = null;
  let closed = false;
  const tick = (): Promise<DaemonNoticeDeliveryReport | null> => {
    if (closed) return Promise.resolve(null);
    if (running) return running;
    running = deliverOwedPeerMessageNotices(cp.outbox, resolveTarget, laneSecret)
      .catch((error: unknown) => {
        (options.onError ?? ((failure: unknown) => {
          process.stderr.write(`peer-message notice delivery: ${failure instanceof Error ? failure.message : String(failure)}\n`);
        }))(error);
        return null;
      })
      .finally(() => { running = null; });
    return running;
  };
  const timer = setInterval(() => void tick(), options.intervalMs ?? PEER_MESSAGE_NOTICE_DELIVERY_INTERVAL_MS);
  timer.unref?.();
  if (options.startImmediately !== false) void tick();
  return { tick, close: () => { closed = true; clearInterval(timer); } };
};

/** What the composition started for refusal notices, and why not when it did not. */
export interface ConfiguredPeerMessageNoticeDelivery {
  delivery: DaemonPeerMessageNoticeDelivery | null;
  /** Why no delivery runs; null when it does. */
  notStarted: string | null;
  /** The live-acceptance probe, when `ACP_DAEMON_NOTICE_PROBE` asked for one; the first pass waits for it. */
  probe: Promise<DaemonNoticeProbeReport> | null;
}

/**
 * The daemon's refusal-notice delivery as the launch environment configures it (amendment 1).
 *
 * Off unless `ACP_DAEMON_NOTICE_ENABLED` is exactly `1`, so ACP can deploy before Hermes enables the
 * daemon principal and fail no notice meanwhile. It also needs the pinned CEO Gateway target and the
 * U4 lane secret. With `ACP_DAEMON_NOTICE_PROBE=<nonce>` the synthetic probe is sent first, once per
 * nonce, and the first delivery pass follows it.
 */
export const startConfiguredPeerMessageNoticeDelivery = (
  cp: ControlPlane,
  options: {
    environment: Readonly<Record<string, string | undefined>>;
    hermesConfiguration: Readonly<Record<string, string | undefined>>;
    laneSecret: string | null;
    ports?: Parameters<typeof createConfiguredHermesGatewayDaemonNoticeTarget>[2];
    intervalMs?: number;
  },
): ConfiguredPeerMessageNoticeDelivery => {
  const off = (notStarted: string): ConfiguredPeerMessageNoticeDelivery => ({ delivery: null, notStarted, probe: null });
  if (options.environment["ACP_DAEMON_NOTICE_ENABLED"] !== "1") return off("ACP_DAEMON_NOTICE_ENABLED is not 1");
  const target = createConfiguredHermesGatewayDaemonNoticeTarget(cp, options.hermesConfiguration, options.ports);
  if (target === undefined) return off("no Hermes Gateway CEO target is configured");
  if (!options.laneSecret) return off("the U4 lane secret is not configured");
  const nonce = options.environment["ACP_DAEMON_NOTICE_PROBE"];
  const probe = nonce === undefined || nonce === ""
    ? null
    : sendDaemonNoticeProbe(cp.outbox, target, options.laneSecret, nonce);
  const delivery = startDaemonPeerMessageNoticeDelivery(cp, target, options.laneSecret, {
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    startImmediately: probe === null,
  });
  if (probe !== null) void probe.then(() => delivery.tick(), () => delivery.tick());
  return { delivery, notStarted: null, probe };
};

/**
 * The authenticated Gateway readback both adoption and the adopted CEO's tool admission use: one
 * reader, fenced on the daemon lock on both sides of the await.
 */
const lockedGatewayOrigin = (
  values: NonNullable<ReturnType<typeof configuredHermesAdoptionValues>>,
  ports: { identityReader?: typeof createHermesGatewayIdentityReader; authorityHeld?: () => boolean },
): (() => Promise<GatewayIncumbentProof>) => {
  const readGateway = (ports.identityReader ?? createHermesGatewayIdentityReader)({
    apiKey: values.ACP_HERMES_GATEWAY_API_KEY!,
  });
  return async () => {
    if (ports.authorityHeld && !ports.authorityHeld()) throw new Error("daemon lock lost");
    const proof = await readGateway();
    if (ports.authorityHeld && !ports.authorityHeld()) throw new Error("daemon lock lost");
    return proof;
  };
};

/**
 * The adopted CEO's tool admission (#1037), from the same configuration adoption reads. Undefined
 * when that configuration is incomplete, so a deployment that never adopted opens no tool socket.
 */
export const createConfiguredAdoptedCeoToolAdmission = (
  cp: ControlPlane,
  configuration: Readonly<Record<string, string | undefined>>,
  ports: {
    identityReader?: typeof createHermesGatewayIdentityReader;
    authorityHeld?: () => boolean;
  } = {},
): AdoptedCeoToolAdmission | undefined => {
  const values = configuredHermesAdoptionValues(configuration);
  if (!values) return undefined;
  return createAdoptedCeoToolAdmission(cp, {
    gatewayOrigin: lockedGatewayOrigin(values, ports),
    lineageRootDigest: values.ACP_HERMES_LINEAGE_ROOT_DIGEST!,
  });
};

/**
 * Serves the Hermes MCP tools to the adopted CEO (#1037) on its own kernel-peer socket.
 *
 * The connection is authenticated once, by `admission.admit` — same uid, a descendant of the bound
 * CEO runtime's recorded process, and the Gateway's own readback agreeing — and every tool call
 * then consumes that admission: `admission.authenticate` fences it on the binding, and the
 * provenance guard compares each mutation's caller against the session and lineage it read. There
 * is no session secret on this path, so there is none to issue, rotate or lose.
 *
 * Deliberately not `ceoConversation.attach`: this channel is how the CEO calls ACP, not how ACP
 * reaches the CEO. Registering it would let the daemon ask the Gateway for sampling outside the
 * adopted conversation's lineage — a new conversation by another door.
 *
 * Only the Hermes server's own tools are served. `cto_binding_bind`/`cto_binding_release` take the
 * runtime's session secret as their principal, which this runtime does not hold.
 *
 * One tool is added when Buzz channel identity binding is configured: `buzz_actor_bind`, the adopted CEO
 * binding its own Buzz channel identity. It reaches the one writer of `sessions.buzz_actor_id`
 * (`BuzzActorIngress.bindActor`) with this connection's admitted runtime as the session proof, and
 * the relay-signed envelope still has to verify; it is a mutation, so caller provenance applies.
 *
 * Called with the actor alone, it mints a challenge instead (`BuzzBindChallenges`) for this
 * connection's admitted runtime and writes nothing: the CEO, which has no signer for the relay's
 * secret, answers it by posting the token in a Buzz mention signed with that actor's key.
 */
export const startAdoptedCeoToolSocket = (
  cp: ControlPlane,
  daemon: { lock: { held(): boolean } },
  stateDir: string,
  admission: AdoptedCeoToolAdmission,
  options: {
    onCeoApproved?: (runId: string) => void | Promise<unknown>;
    admissionTimeoutMs?: number;
    buzzActorIngress?: BuzzActorIngress;
    buzzBindChallenges?: BuzzBindChallenges;
  } = {},
): Promise<CanonicalSelfClaimListener> => {
  const port = createHermesMcpPort(cp, { onCeoApproved: options.onCeoApproved });
  return startAdoptedCeoToolListener(
    daemon,
    stateDir,
    (peer) => admission.admit(peer),
    (admitted, socket) => {
      const server = createHermesServer(port, () => admission.authenticate(admitted), {
        provenance: admitted.provenance,
      });
      const buzzActorIngress = options.buzzActorIngress;
      const buzzBindChallenges = options.buzzBindChallenges;
      if (buzzActorIngress !== undefined || buzzBindChallenges !== undefined) {
        server.registerTool(
          "buzz_actor_bind",
          {
            description:
              "Bind this CEO runtime's own Buzz channel identity. With the actor alone (hex or npub), " +
              "returns a one-time challenge token valid for 10 minutes: post it in a Buzz mention of the " +
              "CTO, signed with that actor's key, to bind. With a relay-signed binding envelope (the " +
              "actor, a fresh nonce, and the relay's signature over them and this session), binds directly.",
            inputSchema: {
              actor: z.string().min(1),
              nonce: z.string().min(1).optional(),
              signature: z.string().min(1).optional(),
            },
          },
          async (args: { actor: string; nonce?: string | undefined; signature?: string | undefined }) => {
            const peer = admission.authenticate(admitted);
            if (!peer.allowed) return respond(peer);
            if (args.nonce === undefined && args.signature === undefined) {
              if (buzzBindChallenges === undefined) {
                return respond(deny(ReasonCode.INVALID_ARGUMENT, "this daemon serves no signed-event binding challenge"));
              }
              return respond(buzzBindChallenges.mint(admitted.runtime, args.actor));
            }
            if (args.nonce === undefined || args.signature === undefined || buzzActorIngress === undefined) {
              return respond(deny(
                ReasonCode.INVALID_ARGUMENT,
                "a relay-signed binding needs both a nonce and a signature, and a configured relay binding",
              ));
            }
            const bound = buzzActorIngress.bindActor({
              actor: args.actor,
              nonce: args.nonce,
              signature: args.signature,
              admitted: admitted.runtime,
            });
            return respond(bound.allowed
              ? allow(bound.reasonCode, { sessionId: bound.value.sessionId, buzzActorId: bound.value.buzzActorId })
              : bound);
          },
        );
      }
      void server.connect(new SocketTransport(socket, Buffer.alloc(0))).catch((err: unknown) => {
        socket.destroy(err instanceof Error ? err : new Error(String(err)));
      });
    },
    options.admissionTimeoutMs === undefined ? {} : { admissionTimeoutMs: options.admissionTimeoutMs },
  );
};

/** Capture independent daemon configuration before exposing the operator method. */
export const createConfiguredHermesIncumbentAdoption = (
  cp: ControlPlane,
  configuration: Readonly<Record<string, string | undefined>>,
  ports: {
    identityReader?: typeof createHermesGatewayIdentityReader;
    adoptionFactory?: typeof createHermesIncumbentAdoption;
    authorityHeld?: () => boolean;
  } = {},
): ((automatic?: AutomaticAdoptionIncumbent) => Promise<Decision<unknown>>) | undefined => {
  const values = configuredHermesAdoptionValues(configuration);
  if (!values) return undefined;

  const gatewayOrigin = lockedGatewayOrigin(values, ports);
  const adoption = (ports.adoptionFactory ?? createHermesIncumbentAdoption)(cp, {
    gatewayOrigin,
    lineageRootDigest: values.ACP_HERMES_LINEAGE_ROOT_DIGEST!,
    hermesExecutable: values.ACP_HERMES_EXECUTABLE!,
    hermesProfile: values.ACP_HERMES_PROFILE!,
    hermesHome: values.ACP_HERMES_HOME!,
    executorRuntimeIdentity: values.ACP_HERMES_EXECUTOR_RUNTIME_IDENTITY!,
  });
  // `automatic` is the daemon's own pass's eligible generation; the operator method passes none.
  return async (automatic) => {
    try {
      const proof = await gatewayOrigin();
      return adoption.adopt({ gatewayPid: proof.process_pid, gatewayStartToken: proof.process_started_at,
        ...(automatic ? { automatic } : {}) });
    } catch {
      return ports.authorityHeld && !ports.authorityHeld()
        ? deny(ReasonCode.DAEMON_LOCK_LOST, "daemon lock was lost during incumbent adoption", {})
        : deny(ReasonCode.CONFLICT, "authenticated live Gateway incumbent cannot be established", {});
    }
  };
};

/** How often the daemon asks whether a revoked CEO's restarted Gateway can be adopted. */
export const HERMES_AUTO_ADOPTION_INTERVAL_MS = 30_000;

/**
 * The daemon's own adoption pass over the operator method's core (`hermes-auto-adoption.ts`):
 * same configuration, same Gateway reader, same lock. Undefined when adoption is not configured.
 */
export const createConfiguredHermesAutoAdoption = (
  cp: ControlPlane,
  configuration: Readonly<Record<string, string | undefined>>,
  ports: Parameters<typeof createConfiguredHermesIncumbentAdoption>[2] & {
    adopt?: HermesAutoAdoptionOptions["adopt"];
    backoff?: { baseMs: number; maxMs: number };
  } = {},
): HermesAutoAdoption | undefined => {
  const adopt = ports.adopt ?? createConfiguredHermesIncumbentAdoption(cp, configuration, ports);
  if (!adopt) return undefined;
  return createHermesAutoAdoption(cp, {
    adopt,
    ...(ports.authorityHeld ? { authorityHeld: ports.authorityHeld } : {}),
    ...(ports.backoff ? { backoff: ports.backoff } : {}),
  });
};

/**
 * Runs the pass when a CEO binding is revoked and on an interval, so a redeployed Gateway is
 * re-adopted without a person. Returns the timer for shutdown to clear.
 */
export const startHermesAutoAdoption = (
  cp: ControlPlane,
  autoAdoption: HermesAutoAdoption,
  intervalMs = HERMES_AUTO_ADOPTION_INTERVAL_MS,
): NodeJS.Timeout => {
  const ceo = roleKeyFor(Role.CEO);
  // After the revoking transaction commits, and off its call stack: the revoker may be the
  // continuity pass, which must finish before an adoption starts reading the Gateway.
  cp.bindings.onSwitch((binding) => {
    if (binding.roleKey === ceo && binding.status === "REVOKED") {
      setImmediate(() => void autoAdoption.tick("ceo_revoked"));
    }
  });
  const timer = setInterval(() => void autoAdoption.tick("periodic"), intervalMs);
  timer.unref();
  setImmediate(() => void autoAdoption.tick("startup"));
  return timer;
};

export const startOperatorSocket = async (
  daemon: Pick<Daemon, "handleOperatorRequest" | "lock">,
  stateDir: string,
  credential: LocalOperatorCredential,
  options: LocalOperatorSocketOptions = {},
): Promise<LocalOperatorListener> => {
  const token = credential.token.trim();
  const mcpToken = options.mcpToken?.trim() || process.env["ACP_MCP_TOKEN"]?.trim();
  if (token.length === 0) {
    throw new Error(
      "ACP_OPERATOR_TOKEN is required for the operator socket; ACP_MCP_TOKEN identifies no peer and cannot be reused",
    );
  }
  if (mcpToken && token === mcpToken) {
    throw new Error(
      "ACP_OPERATOR_TOKEN must be a dedicated credential distinct from ACP_MCP_TOKEN; the MCP token identifies no peer",
    );
  }
  if (credential.peerId.trim().length === 0 || credential.actor.trim().length === 0) {
    throw new Error("operator socket requires a server-configured peer id and actor");
  }
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS;
  if (!Number.isInteger(handshakeTimeoutMs) || handshakeTimeoutMs <= 0) {
    throw new Error("operator handshake timeout must be a positive integer");
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_OPERATOR_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("operator request timeout must be a positive integer");
  }

  const binding: LiveOperatorBinding = {
    token,
    peerId: credential.peerId.trim(),
    actor: credential.actor.trim(),
    incarnation: randomUUID(),
    active: true,
  };
  const socketPath = join(stateDir, "agentcpd.operator.sock");
  removeStaleSocket(socketPath);
  const server = createServer((socket) =>
    serveOperatorRequest(socket, daemon, binding, handshakeTimeoutMs, requestTimeoutMs, options),
  );
  try {
    await listenSocket(server, socketPath);
  } catch (err) {
    if (existsSync(socketPath)) unlinkSync(socketPath);
    throw err;
  }

  return {
    socketPath,
    close: async () => {
      binding.active = false;
      await closeSocketServer(server);
      try {
        if (existsSync(socketPath)) unlinkSync(socketPath);
      } catch {
        /* closing the server already releases its socket; this is only cleanup */
      }
    },
  };
};

/**
 * The listener a parked daemon serves. It is the operator socket with the Hermes bootstrap
 * extension withheld: `bootstrap.hermes` constitutes CEO (`hermes-bootstrap.ts`), which is not
 * something a daemon that has not passed its startup doctor may hand out. Every other
 * restriction is the daemon's — `BOOTSTRAP_OPERATOR_METHODS` decides what a parked daemon
 * answers, so the transport never becomes a second, divergent opinion about what is admitted.
 */
export const startBootstrapOperatorDoor = (
  daemon: Pick<Daemon, "handleOperatorRequest" | "lock">,
  stateDir: string,
  credential: LocalOperatorCredential,
  options: Omit<LocalOperatorSocketOptions, "bootstrapHermes" | "adoptHermesIncumbent" | "adoptHermesIncumbentOwnerAllowed"> = {},
): Promise<LocalOperatorListener> => startOperatorSocket(daemon, stateDir, credential, options);

const startMcpSocket = async (
  path: string,
  token: string,
  cp: ControlPlane,
  expectedRoles: readonly Role[],
  handshakeTimeoutMs: number,
  factory: (
    authenticate: McpPeerAuthenticator,
    opening: BoundSocketPeer,
    credential: PeerCredential,
  ) => ReturnType<typeof createHermesServer>,
  admission: UnboundPeerAdmission = {},
  attachments?: { authority: RoleAttachmentCredentials; port: RoleConversationPort },
): Promise<Server> => {
  removeStaleSocket(path);
  const server = createServer((socket) => {
    trackConnection(server, socket);
    void authenticateSocket(socket, token, handshakeTimeoutMs).then(async (accepted) => {
      if (!accepted) return;
      if ("attachmentId" in accepted.credential) {
        if (!attachments) {
          endWithDecision(socket, deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "this socket does not admit attachments"));
          return;
        }
        const mcp = new McpServer({ name: "role-attachment", version: "1" });
        const attached = attachments.authority.connect(mcp, attachments.port, accepted.credential);
        if (!attached.allowed) {
          endWithDecision(socket, attached);
          return;
        }
        // The ordinary CTO and CEO factories set server.server.onclose to their detach.
        // The current SDK's Protocol.connect wires transport.onclose synchronously before
        // SocketTransport.start resumes the paused socket. Fresh servers/transports cannot
        // hit the already-connected/already-started rejections, so those routes rely on MCP
        // close, including socket.destroy in catch. Attachments additionally cover SDK/mock
        // orderings that close or reject before that wiring. Revisit both sibling routes if
        // an SDK upgrade changes this ordering.
        socket.once("close", attached.value);
        try {
          await mcp.connect(accepted.transport);
        } catch (err) {
          attached.value();
          socket.destroy(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }
      // One server per authenticated connection: the peer identity belongs to the
      // transport, so it can never be re-declared by a tool argument (§21, §27.3).
      const opening = authenticateSocketPeer(cp, accepted.credential, expectedRoles, admission);
      if (!opening.allowed) {
        endWithDecision(socket, opening);
        return;
      }
      const mcp = factory(
        peerAuthenticator(cp, accepted.credential, opening.value),
        opening.value,
        accepted.credential,
      );
      try {
        await mcp.connect(accepted.transport);
      } catch (err) {
        socket.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });

  return listenSocket(server, path);
};

const listenSocket = (server: Server, path: string): Promise<Server> =>
  new Promise<Server>((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      chmodSync(path, 0o600);
      resolveServer(server);
    });
  });

const removeStaleSocket = (path: string): void => {
  if (!existsSync(path)) return;
  if (!lstatSync(path).isSocket()) {
    throw new Error(`refusing to replace non-socket MCP path: ${path}`);
  }
  unlinkSync(path);
};

/**
 * Every connection an MCP socket accepted (#1037, review PR1046-R3). `server.close()` stops
 * accepting and then waits for each open connection to end on its own; an attached runtime's
 * connection ends only when that runtime does, so a shutdown with one attached never reached its
 * lock release. Closing a tracked server ends its connections as well.
 */
const TRACKED_CONNECTIONS = new WeakMap<Server, Set<Socket>>();

const trackConnection = (server: Server, socket: Socket): void => {
  const open = TRACKED_CONNECTIONS.get(server) ?? new Set<Socket>();
  TRACKED_CONNECTIONS.set(server, open);
  open.add(socket);
  socket.once("close", () => open.delete(socket));
};

const closeSocketServer = (server: Server): Promise<void> =>
  new Promise((resolveClose, reject) => {
    server.close((err) => (err ? reject(err) : resolveClose()));
    for (const socket of TRACKED_CONNECTIONS.get(server) ?? []) socket.destroy();
  });

/** A compact wire result for local authenticated ingress; secret-bearing values stay local. */
const endWithDecision = <T>(socket: Socket, decision: Decision<T>): void => {
  const body = decision.allowed
    ? { ok: true, reasonCode: decision.reasonCode, evidence: decision.evidence }
    : {
        ok: false,
        reasonCode: decision.reasonCode,
        message: decision.message,
        evidence: decision.evidence,
      };
  socket.end(`${JSON.stringify(body)}\n`);
};

const serveOperatorRequest = (
  socket: Socket,
  daemon: Pick<Daemon, "handleOperatorRequest" | "lock">,
  binding: LiveOperatorBinding,
  handshakeTimeoutMs: number,
  requestTimeoutMs: number,
  options: LocalOperatorSocketOptions,
): void => {
  let settled = false;
  let timeout: NodeJS.Timeout | null = null;
  const finish = (decision: Decision<unknown>): void => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    frame.dispose();
    if (!socket.destroyed) socket.end(`${JSON.stringify(decision)}\n`);
  };
  const beginRequest = (method: string): void => {
    if (timeout) clearTimeout(timeout);
    const budgetMs = operatorMethodBudgetMs(method, requestTimeoutMs);
    timeout = setTimeout(() => {
      // "did not answer", not "did not happen". The socket closes; the dispatched method keeps
      // running and its later `finish` is a no-op, so a mutation can still land after this
      // refusal. Calling it a failure would be a claim about the write, which this does not know.
      finish(
        deny(
          ReasonCode.OPERATOR_REQUEST_TIMEOUT,
          "operator method did not answer within its budget; it was not cancelled and may still complete",
          { method, budgetMs },
        ),
      );
    }, budgetMs);
    timeout.unref();
  };
  // The wire framing (accumulate bytes, find the newline, refuse a second request, parse JSON) is
  // shared with the canonical self-claim listener via `local-socket-framing.ts` (#760). Only the
  // framing is shared: `authenticateOperatorPeer` below is still this socket's own, and the
  // shared helper never sees the parsed value before this callback does.
  const frame = readOneJsonLineRequest(
    socket,
    {
      tooLarge: "operator request exceeds local transport limit",
      multipleRequests: "operator socket accepts one request per connection",
      notJson: "operator request is not JSON",
    },
    (value) => {
      const peer = authenticateOperatorPeer(value, binding);
      if (!peer.allowed) return finish(peer);
      const method = operatorRequestMethod(value);
      // The handshake is over: this peer authenticated. Everything from here is a statement about
      // the method, so the deadline governing it has to be a different one under a different name.
      // Leaving the handshake timer armed made every method slower than five seconds report that
      // the operator had not authenticated, which they had.
      beginRequest(method ?? "<none>");
      // `ctoBinding.delegate` and `ctoBinding.revoke` used to live here: one minted a grant from
      // an owner receipt, the other spent a second receipt to take it back. Both are gone with
      // the grant itself — there is nothing to hand out, so there is nothing to withdraw, and
      // `ctoBinding.bind` asks the only question left by reading the CEO's live binding.
      if (method === "bootstrap.hermes") {
        if (!options.bootstrapHermes) {
          return finish(deny(ReasonCode.OPERATOR_METHOD_NOT_ALLOWED, "Hermes bootstrap is not enabled on this socket", {}));
        }
        if (!daemon.lock.held()) {
          return finish(deny(ReasonCode.DAEMON_LOCK_LOST, "daemon lock is not held for Hermes bootstrap", {}));
        }
        const params = operatorRequestParams(value);
        if (!params) return finish(deny(ReasonCode.INVALID_ARGUMENT, "Hermes bootstrap parameters are invalid", {}));
        void options.bootstrapHermes(params).then(finish).catch((error: unknown) => {
          finish(deny(ReasonCode.INTERNAL_ERROR, "Hermes bootstrap request failed", {
            error: error instanceof Error ? error.message : String(error),
          }));
        });
        return;
      }
      if (method === "hermes.adoptIncumbent") {
        if (!options.adoptHermesIncumbent) {
          return finish(deny(ReasonCode.OPERATOR_METHOD_NOT_ALLOWED, "Hermes incumbent adoption is not configured", {}));
        }
        if (!daemon.lock.held()) {
          return finish(deny(ReasonCode.DAEMON_LOCK_LOST, "daemon lock is not held for incumbent adoption", {}));
        }
        if (options.adoptHermesIncumbentOwnerAllowed?.() === false) {
          return finish(deny(ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED,
            "incumbent adoption requires an allowlisted CLI owner", {}));
        }
        const params = operatorRequestParams(value);
        if (!params || Object.keys(params).length !== 0) {
          return finish(deny(ReasonCode.INVALID_ARGUMENT, "incumbent adoption accepts no parameters", {}));
        }
        void options.adoptHermesIncumbent().then(finish).catch(() => {
          finish(deny(ReasonCode.INTERNAL_ERROR, "Hermes incumbent adoption failed", {}));
        });
        return;
      }
      // `actor.claimCanonicalCto` does not dispatch here (#760): a process may prove who it is,
      // but it cannot approve itself, so the claiming connection is kept off this bearer-token
      // surface entirely and reaches a dedicated, token-less listener instead
      // (`startCanonicalSelfClaimListener`, `canonical-self-claim-listener.ts`). The method is not
      // in `OPERATOR_METHOD`, so falling through to the generic dispatch below denies it
      // `OPERATOR_METHOD_NOT_ALLOWED` — the same refusal any other unknown method gets, which is
      // the point: this socket has no special knowledge of that method's existence.
      void daemon.handleOperatorRequest(value, peer.value).then(finish).catch((error: unknown) => {
        finish(deny(ReasonCode.INTERNAL_ERROR, "operator request failed", {
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    },
    (decision) => finish(decision),
    MAX_MCP_FRAMED_REQUEST_BYTES,
  );
  socket.once("error", () => {
    if (timeout) clearTimeout(timeout);
    settled = true;
    frame.dispose();
  });
  socket.once("close", () => {
    if (timeout) clearTimeout(timeout);
    settled = true;
    frame.dispose();
  });
  timeout = setTimeout(() => {
    finish(deny(ReasonCode.OPERATOR_UNAUTHENTICATED, "operator handshake timed out"));
  }, handshakeTimeoutMs);
  timeout.unref();
};

const operatorRequestMethod = (value: unknown): string | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const method = (value as { method?: unknown }).method;
  return typeof method === "string" ? method : null;
};

const operatorRequestParams = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const params = (value as { params?: unknown }).params ?? {};
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const prototype = Object.getPrototypeOf(params);
  return prototype === Object.prototype || prototype === null
    ? params as Record<string, unknown>
    : null;
};

/**
 * Operator authentication is a credential-to-peer lookup, not a bearer check. The request
 * can present a token, but it cannot select the peer id, actor, or incarnation returned here.
 * The daemon lock is checked again for every request, so this binding is live only while the
 * lock-held daemon that created it remains authoritative.
 */
const authenticateOperatorPeer = (
  value: unknown,
  binding: LiveOperatorBinding,
): Decision<AuthenticatedOperatorPeer> => {
  if (!localMcpTokenMatches(value, binding.token)) {
    return deny(ReasonCode.OPERATOR_UNAUTHENTICATED, "operator socket authentication failed");
  }
  if (!binding.active) {
    return deny(ReasonCode.OPERATOR_UNAUTHENTICATED, "operator peer binding is no longer live");
  }
  return allow(ReasonCode.OK, {
    channel: "cli",
    peerId: binding.peerId,
    actor: binding.actor,
    incarnation: binding.incarnation,
  });
};

/**
 * The launch channel is intentionally much smaller than MCP: it accepts one externally
 * constituted session id, returns that session's credential once, and closes.  It never
 * accepts a caller-supplied control-plane session id or writes any received value durably.
 */
const serveSessionLaunchCredential = (
  socket: Socket,
  pending: Map<string, PendingLaunchCredential>,
  mcpToken: string | undefined,
): void => {
  let buffer = Buffer.alloc(0);
  let settled = false;
  const finish = (body: Record<string, unknown>): void => {
    if (settled) return;
    settled = true;
    socket.removeListener("data", receive);
    socket.end(`${JSON.stringify(body)}\n`);
  };
  const refuse = (): void => finish({ ok: false, reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED });
  const receive = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_MCP_FRAMED_REQUEST_BYTES) return refuse();
    const boundary = buffer.indexOf(0x0a);
    if (boundary === -1) return;
    if (buffer.subarray(boundary + 1).length > 0) return refuse();
    let request: unknown;
    try {
      request = JSON.parse(buffer.subarray(0, boundary).toString("utf8")) as unknown;
    } catch {
      return refuse();
    }
    const externalSessionId = launchExternalSessionId(request);
    if (!externalSessionId) return refuse();
    const launch = pending.get(externalSessionId);
    if (!launch || launch.expiresAtMs <= Date.now()) {
      pending.delete(externalSessionId);
      return refuse();
    }

    // Consume before writing. If the peer disappears while receiving its response, retrying
    // this session is unsafe because the plaintext could already have crossed the socket.
    pending.delete(externalSessionId);
    finish({
      ok: true,
      sessionId: launch.credential.sessionId,
      sessionIncarnation: launch.credential.sessionIncarnation,
      sessionSecret: launch.credential.sessionSecret,
      ...(mcpToken === undefined ? {} : { token: mcpToken }),
    });
  };
  socket.on("data", receive);
  socket.once("error", () => {
    if (!settled) {
      settled = true;
      socket.removeListener("data", receive);
    }
  });
};

const launchExternalSessionId = (value: unknown): string | null => {
  if (!value || typeof value !== "object") return null;
  const externalSessionId = (value as { externalSessionId?: unknown }).externalSessionId;
  return typeof externalSessionId === "string" && externalSessionId.length > 0
    ? externalSessionId
    : null;
};

/**
 * One Telegram update envelope per connection, answered once.
 *
 * The answer to a new turn is written by the lane from inside the coordinator's dispatch, after the
 * turn and its dispatch row are committed; `respond` is idempotent so a late error after that write
 * cannot add a second line. A peer that sends nothing complete within the handshake budget, more
 * than the request bound, more than one line or something that is not JSON is refused without
 * reaching the lane.
 */
const serveTelegramExternalUpdate = (socket: Socket, lane: TelegramExternalUpdateLane): void => {
  let answered = false;
  let frame: { dispose(): void } | null = null;
  const respond = (answer: TelegramExternalAnswer): void => {
    if (answered) return;
    answered = true;
    clearTimeout(deadline);
    frame?.dispose();
    if (!socket.destroyed) socket.end(`${JSON.stringify(answer)}\n`);
  };
  const refuse = (decision: Decision<unknown>): void => {
    if (!decision.allowed) respond({ allowed: false, reasonCode: decision.reasonCode, message: decision.message });
  };
  const deadline = setTimeout(() => {
    refuse(deny(ReasonCode.INVALID_ARGUMENT, "Telegram update ingress received no complete envelope"));
  }, DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS);
  deadline.unref();
  socket.on("error", () => {
    answered = true;
    clearTimeout(deadline);
    frame?.dispose();
  });
  frame = readOneJsonLineRequest(
    socket,
    {
      tooLarge: "Telegram update envelope exceeds the request bound",
      multipleRequests: "Telegram update ingress accepts one envelope per connection",
      notJson: "Telegram update envelope is not JSON",
    },
    (value) => {
      clearTimeout(deadline);
      void lane.handle(value, respond).catch((error: unknown) => {
        refuse(deny(ReasonCode.INTERNAL_ERROR, error instanceof Error ? error.message : String(error)));
      });
    },
    refuse,
    TELEGRAM_EXTERNAL_MAX_REQUEST_BYTES,
  );
};

const serveBuzzActorBinding = (socket: Socket, ingress: BuzzActorIngress): void => {
  let buffer = Buffer.alloc(0);
  let settled = false;
  const finish = (decision: Decision<unknown>): void => {
    if (settled) return;
    settled = true;
    socket.removeListener("data", receive);
    endWithDecision(socket, decision);
  };
  const receive = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_MCP_FRAMED_REQUEST_BYTES) {
      return finish(deny(ReasonCode.INVALID_ARGUMENT, "Buzz channel identity ingress message exceeds local transport limit"));
    }
    const boundary = buffer.indexOf(0x0a);
    if (boundary === -1) return;
    const line = buffer.subarray(0, boundary).toString("utf8");
    // This endpoint accepts exactly one relay envelope per connection. Ignoring a second
    // line would make its replay and ordering semantics impossible to reason about.
    if (buffer.subarray(boundary + 1).length > 0) {
      return finish(deny(ReasonCode.INVALID_ARGUMENT, "Buzz channel identity ingress accepts one envelope per connection"));
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return finish(deny(ReasonCode.INVALID_ARGUMENT, "Buzz channel identity ingress message is not JSON"));
    }
    const input = presentedBuzzActorBinding(value);
    if (!input) {
      return finish(deny(ReasonCode.INVALID_ARGUMENT, "Buzz channel identity ingress message is incomplete"));
    }
    finish(ingress.bindActor(input));
  };
  socket.on("data", receive);
  socket.once("error", () => {
    settled = true;
    socket.removeListener("data", receive);
  });
};

const presentedBuzzActorBinding = (value: unknown): {
  actor: string;
  sessionId: string;
  sessionSecret: string;
  nonce: string;
  signature: string | null;
} | null => {
  if (!value || typeof value !== "object") return null;
  const { actor, sessionId, sessionSecret, nonce, signature } = value as {
    actor?: unknown;
    sessionId?: unknown;
    sessionSecret?: unknown;
    nonce?: unknown;
    signature?: unknown;
  };
  if (
    typeof actor !== "string" ||
    typeof sessionId !== "string" ||
    typeof sessionSecret !== "string" ||
    typeof nonce !== "string" ||
    (signature !== undefined && signature !== null && typeof signature !== "string")
  ) {
    return null;
  }
  return { actor, sessionId, sessionSecret, nonce, signature: signature ?? null };
};

/**
 * One Buzz message per connection, answered on the same connection.
 *
 * The connection is held for the length of the CEO turn rather than acknowledged and forgotten,
 * because the relay is the thing that owns the Buzz thread: the answer has to go back where the
 * question came from (SSOT §126–127), and this is the only handle on that thread. A message that
 * never completes its first line inside the handshake budget is refused, so a peer that connects
 * and says nothing cannot hold a slot open.
 */
const serveBuzzMessageTurn = (
  socket: Socket,
  ingress: BuzzMessageIngress,
  port: BuzzMessageTurnPort,
): void => {
  let buffer = Buffer.alloc(0);
  let settled = false;
  const envelopeDeadline = setTimeout(() => {
    finish(deny(ReasonCode.INVALID_ARGUMENT, "Buzz message ingress received no complete envelope"));
  }, DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS);
  envelopeDeadline.unref();
  function finish(decision: Decision<unknown>): void {
    if (settled) return;
    settled = true;
    clearTimeout(envelopeDeadline);
    socket.removeListener("data", receive);
    endWithBuzzMessage(socket, decision);
  }
  const receive = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_MCP_FRAMED_REQUEST_BYTES) {
      return finish(deny(ReasonCode.INVALID_ARGUMENT, "Buzz message exceeds local transport limit"));
    }
    const boundary = buffer.indexOf(0x0a);
    if (boundary === -1) return;
    const line = buffer.subarray(0, boundary).toString("utf8");
    if (buffer.subarray(boundary + 1).length > 0) {
      return finish(deny(ReasonCode.INVALID_ARGUMENT, "Buzz message ingress accepts one envelope per connection"));
    }
    // Stop reading before the turn starts. A second envelope arriving while the CEO is
    // answering would otherwise re-enter this handler on the same connection.
    socket.removeListener("data", receive);
    clearTimeout(envelopeDeadline);
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return finish(deny(ReasonCode.INVALID_ARGUMENT, "Buzz message ingress message is not JSON"));
    }
    const input = presentedBuzzMessage(value);
    if (!input) {
      return finish(deny(ReasonCode.INVALID_ARGUMENT, "Buzz message ingress message is incomplete"));
    }
    void deliverBuzzMessage(ingress, port, input).then(
      (decision) => finish(decision),
      (error: unknown) => finish(deny(
        ReasonCode.INTERNAL_ERROR,
        error instanceof Error ? error.message : String(error),
      )),
    );
  };
  socket.on("data", receive);
  socket.once("error", () => {
    settled = true;
    clearTimeout(envelopeDeadline);
    socket.removeListener("data", receive);
  });
};

/**
 * Like `endWithDecision`, except the value crosses.
 *
 * That function keeps values local because the things it answers with are credentials. Here the
 * value is the CEO's answer to the owner, and the relay cannot post it to the Buzz thread
 * without receiving it — a reply that stays inside the daemon is the silence this path exists
 * to end.
 */
const endWithBuzzMessage = (socket: Socket, decision: Decision<unknown>): void => {
  const answer = decision.allowed ? (decision.value as { answer?: unknown; answeredByCeo?: unknown }) : null;
  const body = decision.allowed
    ? {
        ok: true,
        reasonCode: decision.reasonCode,
        answer: typeof answer?.answer === "string" ? answer.answer : null,
        answeredByCeo: answer?.answeredByCeo === true,
        evidence: decision.evidence,
      }
    : {
        ok: false,
        reasonCode: decision.reasonCode,
        message: decision.message,
        evidence: decision.evidence,
      };
  if (!socket.destroyed) socket.end(`${JSON.stringify(body)}\n`);
};

const presentedBuzzMessage = (value: unknown): BuzzMessageIngressInput | null => {
  if (!value || typeof value !== "object") return null;
  const { actor, conversation, eventId, addressedTo, mention, text, signature } = value as {
    actor?: unknown;
    conversation?: unknown;
    eventId?: unknown;
    addressedTo?: unknown;
    mention?: unknown;
    text?: unknown;
    signature?: unknown;
  };
  if (
    typeof actor !== "string" ||
    typeof conversation !== "string" ||
    typeof eventId !== "string" ||
    typeof addressedTo !== "string" ||
    // `mention` is deliberately not type-checked here. It is inside the signature, so it has to
    // reach `buzzMessagePayload` byte-identical to what the relay sent; rejecting a number or an
    // object at the parser would refuse the envelope before anything had authenticated its
    // sender, and would report a bad *address* as a malformed *message*. A tag of the wrong
    // shape is admitted as data and refused as an address, with the journal row that owes.
    typeof text !== "string" ||
    (signature !== undefined && signature !== null && typeof signature !== "string")
  ) {
    return null;
  }
  return {
    actor,
    conversation,
    eventId,
    addressedTo,
    mention: mention ?? null,
    text,
    signature: signature ?? null,
  };
};

/**
 * Every ACTIVE binding of these roles, as the registry currently holds it (`#760` Part B).
 *
 * The question is "who holds this role right now", and only the registry answers it. An
 * assignment row keeps the session it was created for, and `BindingRegistry.switchTo`'s
 * `SURVIVED` failover moves an actor's live runtime without rewriting that column — so a lookup
 * keyed on it is wrong in both directions: it names roles a session has lost and omits roles it
 * has gained. `activePrimaryCto` and `active` resolve the live runtime through the actor, which
 * is the routing answer.
 *
 * Callers filter this list themselves. Narrowing it here as well would put one rule in two
 * places, and then removing either changes nothing a test can see.
 */
const currentBindingsForRoles = (cp: ControlPlane, roles: readonly Role[]): RoleBinding[] => {
  const out: RoleBinding[] = [];
  for (const role of roles) {
    if (role === Role.CEO) {
      const ceo = cp.bindings.active(roleKeyFor(Role.CEO));
      if (ceo) out.push(ceo);
    } else if (role === Role.PRIMARY_CTO) {
      for (const project of cp.projects.list()) {
        const cto = cp.bindings.activePrimaryCto(project.projectId);
        if (cto) out.push(cto);
      }
    } else if (role === Role.BOOTSTRAP_CTO) {
      for (const run of cp.runs.list()) {
        const bootstrap = cp.bindings.active(roleKeyFor(Role.BOOTSTRAP_CTO, { runId: run.runId }));
        if (bootstrap) out.push(bootstrap);
      }
    }
  }
  return out;
};

interface AcceptedConnection {
  transport: SocketTransport;
  credential: PeerCredential | AttachmentCredential;
}

interface ActiveBoundSocketPeer {
  kind: "BOUND";
  binding: RoleBinding;
  sessionIncarnation: string;
  /** The credential epoch this connection authenticated at; a rotation since refuses it (#246 C1b). */
  credentialEpoch: number;
}

/** An unbound peer shape: a recipient of one current normal handoff. */
interface PendingHandoffSocketPeer {
  kind: "PENDING_HANDOFF_ACK";
  handoffId: string;
  sessionIncarnation: string;
  fromGeneration: number;
  credentialEpoch: number;
}

/**
 * #246 C1b — the other unbound peer shape: a provisioned session the runtime driver asked to attest,
 * which may answer that challenge (`session_attest`) and nothing else. A spawn attests before it is
 * READY or bound, so a STARTING session is admitted here and nowhere else.
 */
interface PendingAttestationSocketPeer {
  kind: "PENDING_ATTESTATION";
  sessionIncarnation: string;
  credentialEpoch: number;
}

type BoundSocketPeer = ActiveBoundSocketPeer | PendingHandoffSocketPeer | PendingAttestationSocketPeer;

/** Which unbound peers a socket admits besides its bound role holders. */
interface UnboundPeerAdmission {
  pendingHandoffAck?: boolean;
  pendingAttestation?: boolean;
}

interface PendingNormalHandoff {
  handoffId: string;
  fromGeneration: number;
}

/**
 * The socket name is an authority boundary, not just an API catalogue. Capturing the
 * exact binding here lets request authentication reject a connection after failover.
 */
const authenticateSocketPeer = (
  cp: ControlPlane,
  credential: PeerCredential,
  expectedRoles: readonly Role[],
  admission: UnboundPeerAdmission = {},
): Decision<BoundSocketPeer> => {
  const session = cp.sessions.verifySecret(credential.sessionId, credential.sessionSecret);
  if (!session.allowed) return session as Decision<BoundSocketPeer>;
  const attesting = (): Decision<BoundSocketPeer> | null =>
    admission.pendingAttestation &&
    cp.sessionAttestations.isPending(credential.sessionId, session.value.incarnation, session.value.credentialEpoch)
      ? allow(ReasonCode.OK, {
          kind: "PENDING_ATTESTATION",
          sessionIncarnation: session.value.incarnation,
          credentialEpoch: session.value.credentialEpoch,
        })
      : null;
  if (session.value.lifecycle === SessionLifecycle.STARTING) {
    const admitted = attesting();
    if (admitted) return admitted;
  }
  if (
    session.value.lifecycle !== SessionLifecycle.READY &&
    session.value.lifecycle !== SessionLifecycle.DRAINING
  ) {
    return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "peer session is not eligible for a local MCP socket", {
      sessionId: credential.sessionId,
      lifecycle: session.value.lifecycle,
    });
  }

  // Eligibility is decided against current state, not the assignment's own session column. A
  // conversation that survived a failover to this runtime has the same assignment and generation
  // and a different `session_id`; judging on that column refuses the rightful holder before the
  // connection ever reaches a port, and admits a runtime the role has already left.
  const candidate = currentBindingsForRoles(cp, expectedRoles).find(
    (binding) =>
      binding.sessionId === credential.sessionId &&
      binding.sessionIncarnation === session.value.incarnation,
  );
  if (!candidate) {
    if (admission.pendingHandoffAck && session.value.lifecycle === SessionLifecycle.READY) {
      const pending = currentPendingNormalHandoff(cp, credential.sessionId);
      if (pending.allowed) {
        return allow(ReasonCode.OK, {
          kind: "PENDING_HANDOFF_ACK",
          handoffId: pending.value.handoffId,
          fromGeneration: pending.value.fromGeneration,
          sessionIncarnation: session.value.incarnation,
          credentialEpoch: session.value.credentialEpoch,
        });
      }
    }
    if (session.value.lifecycle === SessionLifecycle.READY) {
      const admitted = attesting();
      if (admitted) return admitted;
    }
    return deny(ReasonCode.BINDING_GENERATION_STALE, "session does not hold this socket's current role", {
      sessionId: credential.sessionId,
      expectedRoles,
    });
  }
  if (!lifecyclePermitsBoundSocket(session.value.lifecycle, candidate.role)) {
    return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "peer session cannot use this socket in its lifecycle", {
      sessionId: credential.sessionId,
      lifecycle: session.value.lifecycle,
      role: candidate.role,
    });
  }
  const authenticated = cp.bindings.authenticateBoundSession({
    roleKey: candidate.roleKey,
    sessionId: credential.sessionId,
    sessionSecret: credential.sessionSecret,
    bindingGeneration: candidate.bindingGeneration,
  });
  if (!authenticated.allowed) return authenticated as Decision<BoundSocketPeer>;
  if (authenticated.value.sessionIncarnation !== session.value.incarnation) {
    return deny(ReasonCode.BINDING_GENERATION_STALE, "role binding belongs to a previous session incarnation", {
      roleKey: authenticated.value.roleKey,
      sessionId: credential.sessionId,
      bindingIncarnation: authenticated.value.sessionIncarnation,
      sessionIncarnation: session.value.incarnation,
    });
  }
  return allow(ReasonCode.OK, {
    kind: "BOUND",
    binding: authenticated.value,
    sessionIncarnation: session.value.incarnation,
    credentialEpoch: session.value.credentialEpoch,
  });
};

/**
 * Normal handoff recipients are intentionally unbound.  This predicate is their entire
 * authority: one PENDING HANDOFF row addressed to them, plus the still-current outgoing
 * PRIMARY_CTO generation that created it.  Bootstrap and recovery handoffs never qualify.
 */
const currentPendingNormalHandoff = (
  cp: ControlPlane,
  sessionId: string,
): Decision<PendingNormalHandoff> => {
  const rows = cp.db.all<{
    handoff_id: string;
    project_id: string;
    from_session_id: string | null;
    from_generation: number | null;
  }>(
    `SELECT handoff_id, project_id, from_session_id, from_generation
       FROM handoffs
      WHERE to_session_id = ? AND kind = 'HANDOFF' AND status = 'PENDING'
      ORDER BY created_at, handoff_id`,
    [sessionId],
  );
  if (rows.length !== 1) {
    return deny(ReasonCode.BINDING_GENERATION_STALE, "session has no unique pending normal handoff", {
      sessionId,
      pendingHandoffs: rows.length,
    });
  }
  const handoff = rows[0]!;
  if (handoff.from_session_id === null || handoff.from_generation === null) {
    return deny(ReasonCode.BINDING_GENERATION_STALE, "normal handoff has no outgoing binding fence", {
      handoffId: handoff.handoff_id,
    });
  }
  const outgoing = cp.bindings.active(roleKeyFor(Role.PRIMARY_CTO, { projectId: handoff.project_id }));
  if (
    !outgoing ||
    outgoing.sessionId !== handoff.from_session_id ||
    outgoing.bindingGeneration !== handoff.from_generation
  ) {
    return deny(ReasonCode.BINDING_GENERATION_STALE, "handoff outgoing binding is no longer current", {
      handoffId: handoff.handoff_id,
      expectedGeneration: handoff.from_generation,
      currentGeneration: outgoing?.bindingGeneration ?? null,
    });
  }
  return allow(ReasonCode.OK, {
    handoffId: handoff.handoff_id,
    fromGeneration: handoff.from_generation,
  });
};

/** A draining primary keeps only its already-fenced authority; no other draining role does. */
const lifecyclePermitsBoundSocket = (lifecycle: SessionLifecycle, role: Role): boolean =>
  lifecycle === SessionLifecycle.READY ||
  (lifecycle === SessionLifecycle.DRAINING && role === Role.PRIMARY_CTO);

export const authenticateSocket = (
  socket: Socket,
  token: string,
  handshakeTimeoutMs: number,
): Promise<AcceptedConnection | null> =>
  new Promise((resolveTransport) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    const finish = (transport: AcceptedConnection | null): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      socket.removeListener("data", receive);
      socket.removeListener("error", transportError);
      socket.removeListener("close", transportClosed);
      resolveTransport(transport);
    };
    const reject = (respond = true): void => {
      if (settled) return;
      if (respond && !socket.destroyed) {
        // The client receives the stable denial without ever reaching an MCP transport
        // or a tool handler. This makes the ordering observable to both callers and tests.
        endWithDecision(socket, deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "local MCP authentication failed"));
      } else {
        socket.destroy();
      }
      finish(null);
    };
    const transportError = (): void => reject(false);
    const transportClosed = (): void => reject(false);
    const receive = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const boundary = buffer.indexOf(0x0a);
      // Nothing here may be measured against the whole buffer: the bytes after the handshake line
      // are the peer's first messages, handed to the transport below, and refusing the handshake
      // for their size refuses a credential for something the credential did not say (#805).
      if (boundary === -1) {
        if (buffer.length > MAX_MCP_PENDING_BYTES) return reject();
        return;
      }
      if (boundary > MAX_MCP_LINE_BYTES) return reject();
      const line = buffer.subarray(0, boundary).toString("utf8");
      const remainder = buffer.subarray(boundary + 1);
      let presented: unknown;
      try {
        presented = JSON.parse(line) as unknown;
      } catch {
        return reject();
      }
      if (!localMcpTokenMatches(presented, token)) return reject();
      const credential = presented && typeof presented === "object" && "attachmentId" in presented
        ? presented as AttachmentCredential
        : presentedCredential(presented);
      if (!credential) return reject();
      socket.pause();
      finish({ transport: new SocketTransport(socket, remainder), credential });
    };
    socket.on("data", receive);
    socket.once("error", transportError);
    socket.once("close", transportClosed);
    timeout = setTimeout(() => reject(), handshakeTimeoutMs);
    timeout.unref();
  });

/**
 * The deployment token proves the caller may reach the socket at all; it says nothing
 * about *which* session is calling. The handshake therefore also carries the session's
 * own secret, and every request re-verifies it — a session that has been respawned or
 * stopped is no longer a peer even on a connection that authenticated earlier.
 */
const presentedCredential = (value: unknown): PeerCredential | null => {
  if (!value || typeof value !== "object") return null;
  const { sessionId, sessionSecret } = value as { sessionId?: unknown; sessionSecret?: unknown };
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  if (typeof sessionSecret !== "string" || sessionSecret.length === 0) return null;
  return { sessionId, sessionSecret };
};

interface PeerCredential {
  sessionId: string;
  sessionSecret: string;
}

const peerAuthenticator =
  (cp: ControlPlane, credential: PeerCredential, opening: BoundSocketPeer): McpPeerAuthenticator =>
  () => {
    const session = cp.sessions.verifySecret(credential.sessionId, credential.sessionSecret);
    if (!session.allowed) return session as Decision<AuthenticatedMcpPeer>;
    if (session.value.incarnation !== opening.sessionIncarnation) {
      return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "session was respawned since this connection authenticated", {
        sessionId: credential.sessionId,
        handshake: opening.sessionIncarnation,
        current: session.value.incarnation,
      });
    }
    // #246 C1b — a rotation ends the authority of every connection opened before it, at that
    // connection's next request: the secret check above already fails for the replaced secret,
    // and the epoch says so even of a connection whose secret somehow still verified.
    if (session.value.credentialEpoch !== opening.credentialEpoch) {
      return deny(ReasonCode.SESSION_CREDENTIAL_EPOCH_STALE, "the session's credential was rotated since this connection authenticated", {
        sessionId: credential.sessionId,
        handshakeEpoch: opening.credentialEpoch,
        currentEpoch: session.value.credentialEpoch,
      });
    }
    if (opening.kind === "PENDING_ATTESTATION") {
      if (!cp.sessionAttestations.isPending(credential.sessionId, session.value.incarnation, session.value.credentialEpoch)) {
        return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "the attestation this connection was admitted for is no longer pending", {
          sessionId: credential.sessionId,
        });
      }
      return allow(ReasonCode.OK, authenticatedPeer(credential, opening.sessionIncarnation));
    }
    if (opening.kind === "PENDING_HANDOFF_ACK") {
      if (session.value.lifecycle !== SessionLifecycle.READY) {
        return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "pending handoff recipient is not READY", {
          sessionId: credential.sessionId,
          lifecycle: session.value.lifecycle,
        });
      }
      const pending = currentPendingNormalHandoff(cp, credential.sessionId);
      if (
        !pending.allowed ||
        pending.value.handoffId !== opening.handoffId ||
        pending.value.fromGeneration !== opening.fromGeneration
      ) {
        return deny(ReasonCode.BINDING_GENERATION_STALE, "pending handoff is no longer current for this socket", {
          sessionId: credential.sessionId,
          handoffId: opening.handoffId,
          expectedGeneration: opening.fromGeneration,
        });
      }
      return allow(ReasonCode.OK, authenticatedPeer(credential, opening.sessionIncarnation));
    }

    if (!lifecyclePermitsBoundSocket(session.value.lifecycle, opening.binding.role)) {
      return deny(
        ReasonCode.MCP_PEER_UNAUTHENTICATED,
        `peer session is ${session.value.lifecycle} and cannot retain this role's socket authority`,
        { sessionId: credential.sessionId, lifecycle: session.value.lifecycle, role: opening.binding.role },
      );
    }
    const bound = cp.bindings.authenticateBoundSession({
      roleKey: opening.binding.roleKey,
      sessionId: credential.sessionId,
      sessionSecret: credential.sessionSecret,
      bindingGeneration: opening.binding.bindingGeneration,
    });
    if (!bound.allowed) return bound as Decision<AuthenticatedMcpPeer>;
    if (bound.value.sessionIncarnation !== opening.sessionIncarnation) {
      return deny(ReasonCode.BINDING_GENERATION_STALE, "socket binding no longer matches this session incarnation", {
        roleKey: opening.binding.roleKey,
        sessionId: credential.sessionId,
        handshake: opening.sessionIncarnation,
        binding: bound.value.sessionIncarnation,
      });
    }
    return allow(ReasonCode.OK, authenticatedPeer(credential, opening.sessionIncarnation));
  };

/**
 * The same connection's authority with **no binding in it** — for a `RoleConversationPort`.
 *
 * `peerAuthenticator` above is binding-scoped, and has to be: MCP tool authority is authority over
 * one role's assignment, so its tail re-asks `authenticateBoundSession` about `opening.binding`.
 * That is exactly wrong for the conversation port. A session legitimately holds several bindings
 * at once, socket admission admits the connection under whichever one it happens to find first,
 * and the port keeps a slot per role. Handing the port a binding-scoped authenticator makes every
 * slot's liveness depend on the admitting binding: measured 2026-09-05, a same-generation
 * `switchTo({ conversation: "SURVIVED" })` moving *only* the admitted project away then refused
 * delivery for the session's other project with `ROLE_PEER_STALE` — while that session was still
 * the registry's exact current holder of it. A role was lost to an event in a different project.
 *
 * So this re-authenticates the three things that are true of the *connection* rather than of any
 * role: the session secret still verifies, the session has not been respawned since this
 * connection handshook, and the lifecycle still permits holding a bound socket. It reads no
 * roleKey, no assignment, no binding generation, and never touches `opening.binding`. Which roles
 * this authenticated runtime may receive for stays entirely with `RoleConversationPort`'s single
 * enforcement point, `#isCurrentHolder`, evaluated per slot at attach and again at delivery.
 *
 * The lifecycle question needs a role, and the one passed is the **port's own** role — the role
 * every slot this authenticator can ever guard is a binding of, since `#isCurrentHolder` admits no
 * other. It is not `opening.binding.role`, which would put the admitting binding back in. Nor is
 * it hardcoded to the strictest form (`READY` only): a DRAINING primary keeps its already-fenced
 * authority, and denying it here would silently drop delivery to a holder the registry still names.
 */
const conversationPeerAuthenticator =
  (
    cp: ControlPlane,
    credential: PeerCredential,
    sessionIncarnation: string,
    credentialEpoch: number,
    role: Role,
  ): McpPeerAuthenticator =>
  () => {
    const session = cp.sessions.verifySecret(credential.sessionId, credential.sessionSecret);
    if (!session.allowed) return session as Decision<AuthenticatedMcpPeer>;
    if (session.value.incarnation !== sessionIncarnation) {
      return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "session was respawned since this connection authenticated", {
        sessionId: credential.sessionId,
        handshake: sessionIncarnation,
        current: session.value.incarnation,
      });
    }
    if (session.value.credentialEpoch !== credentialEpoch) {
      return deny(ReasonCode.SESSION_CREDENTIAL_EPOCH_STALE, "the session's credential was rotated since this connection authenticated", {
        sessionId: credential.sessionId,
        handshakeEpoch: credentialEpoch,
        currentEpoch: session.value.credentialEpoch,
      });
    }
    if (!lifecyclePermitsBoundSocket(session.value.lifecycle, role)) {
      return deny(
        ReasonCode.MCP_PEER_UNAUTHENTICATED,
        `peer session is ${session.value.lifecycle} and cannot retain this role's socket authority`,
        { sessionId: credential.sessionId, lifecycle: session.value.lifecycle, role },
      );
    }
    return allow(ReasonCode.OK, authenticatedPeer(credential, sessionIncarnation));
  };

/**
 * The plaintext is attached only to this in-process peer context. It never becomes a tool
 * argument or response; `handoff_ack` uses it to construct the lifecycle's authenticated
 * envelope, which verifies it again against SessionRegistry before switching generations.
 */
const authenticatedPeer = (
  credential: PeerCredential,
  sessionIncarnation: string,
): AuthenticatedMcpPeer & { sessionSecret: string } => ({
  actor: credential.sessionId,
  sessionId: credential.sessionId,
  sessionIncarnation,
  sessionSecret: credential.sessionSecret,
});

export const localMcpTokenMatches = (value: unknown, expected: string): boolean => {
  if (!value || typeof value !== "object" || !("token" in value)) return false;
  const presented = (value as { token: unknown }).token;
  if (typeof presented !== "string") return false;
  const actualBytes = Buffer.from(presented);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

class SocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  #buffer: Buffer;
  #started = false;
  #closed = false;

  constructor(
    private readonly socket: Socket,
    initial: Buffer,
  ) {
    // The handshake remainder is a view over plaintext credentials, even when empty.
    // Allocate outside the Buffer pool: Buffer.from could share that same backing slab.
    this.#buffer = Buffer.alloc(initial.length);
    initial.copy(this.#buffer);
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error("MCP socket transport already started");
    this.#started = true;
    this.socket.on("data", this.receive);
    this.socket.once("error", this.error);
    this.socket.once("close", this.closed);
    this.processBuffer();
    this.socket.resume();
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.#closed) throw new Error("MCP socket transport is closed");
    await new Promise<void>((resolveWrite, reject) => {
      this.socket.write(`${JSON.stringify(message)}\n`, (err) => (err ? reject(err) : resolveWrite()));
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.socket.end();
    this.closed();
  }

  private readonly receive = (chunk: Buffer): void => {
    // A later pooled concat could regain the slab that held the handshake credentials.
    const next = Buffer.alloc(this.#buffer.length + chunk.length);
    this.#buffer.copy(next);
    chunk.copy(next, this.#buffer.length);
    this.#buffer = next;
    this.processBuffer();
  };

  private processBuffer(): void {
    let boundary = this.#buffer.indexOf(0x0a);
    while (boundary !== -1) {
      // `boundary` is the byte length of the line it terminates, so this is the message's own
      // size and not the read's. A line of exactly the limit is still a legal message (#805).
      if (boundary > MAX_MCP_LINE_BYTES) {
        this.error(new Error("MCP message exceeds local transport limit"));
        this.socket.destroy();
        return;
      }
      const line = this.#buffer.subarray(0, boundary).toString("utf8");
      this.#buffer = this.#buffer.subarray(boundary + 1);
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object") throw new Error("MCP message is not an object");
        this.onmessage?.(parsed as JSONRPCMessage);
      } catch (err) {
        this.error(err instanceof Error ? err : new Error(String(err)));
        this.socket.destroy();
        return;
      }
      boundary = this.#buffer.indexOf(0x0a);
    }
    // What is left has no terminator, so it is the prefix of a line. Past the bound no byte
    // arriving later can make it a legal message, and holding it would let a peer that never
    // writes a newline grow this buffer without limit.
    if (this.#buffer.length > MAX_MCP_PENDING_BYTES) {
      this.error(new Error("MCP message exceeds local transport limit before its terminator"));
      this.socket.destroy();
    }
  }

  private readonly error = (err: Error): void => {
    this.onerror?.(err);
  };

  private readonly closed = (): void => {
    if (this.#closed) return;
    this.#closed = true;
    this.onclose?.();
  };
}

/** The channel-identity allowlist is deployment configuration, never a relay-supplied claim. */
/**
 * The deployment's Buzz ingress policy, read from the environment `agentcpd` runs under.
 *
 * Exported so `scripts/capture-buzz-live.ts` can prove the refusal is *this* policy's rather than
 * one the capture constructed (#243). A capture that builds its own allowlist shows that
 * `IngressGuard` enforces a list, which was never in doubt — it does not show that the deployment
 * would refuse the actor.
 */
export const configuredBuzzActorIngressPolicy = (): IngressPolicy | null => {
  const secret = process.env["ACP_BUZZ_INGRESS_SECRET"]?.trim() ?? "";
  const allowedActors = (process.env["ACP_BUZZ_ALLOWED_ACTORS"] ?? "")
    .split(",")
    .map((actor) => actor.trim())
    .filter((actor) => actor.length > 0);
  if (secret.length === 0 && allowedActors.length === 0) return null;
  if (secret.length === 0 || allowedActors.length === 0) {
    throw new Error(
      "ACP_BUZZ_INGRESS_SECRET and ACP_BUZZ_ALLOWED_ACTORS must be configured together",
    );
  }
  return { allowedActors, secret };
};

/**
 * Which Buzz channel identities may speak to the CEO as the owner.
 *
 * Read from `owner-identities` (#245) rather than from `ACP_BUZZ_ALLOWED_ACTORS`, because the
 * two answer different questions. The environment allowlist is the relay credential's: it says
 * which channel identities may present an envelope at all, and every ACTIVE Buzz channel
 * identity the deployment talks to is on it. Owner authority is declared once, on the host, for every
 * channel — Telegram already refuses to start on an owner id missing from that file — and the
 * message path takes its owners from the same place.
 *
 * An empty result is not a permissive default: `main` leaves the message socket closed and says
 * so, which is the fail-closed half of the same separation.
 */
export const configuredBuzzMessageOwnerActors = (
  ownerIdentities: readonly OwnerIdentity[],
): string[] => [
  ...new Set(
    ownerIdentities
      .filter((identity) => identity.channel === "buzz")
      .map((identity) => identity.actor.trim())
      .filter((actor) => actor.length > 0),
  ),
];

/**
 * The daemon's Telegram composition root. Tests may replace only the external transport; the
 * guard, sealed Hermes port, CEO receipt callback, durable response reader and poll service are
 * still assembled by the same factory `main` uses.
 */
export type DaemonTelegramStartOptions = Omit<TelegramLongPollStartOptions, "onCeoApproved"> & {
  transport?: TelegramBotTransport;
};

type DaemonTelegramComposition = {
  finalizeApprovedRun(runId: string): void | Promise<unknown>;
  setTelegramIngressStatus?(status: {
    configured: boolean;
    running: boolean;
    disabledReason: string | null;
    recoveryNonce?: string | null;
  }): void;
  attachTelegramIngressController?(controller: TelegramLongPollListener["service"]): void;
  detachTelegramIngressController?(controller: TelegramLongPollListener["service"]): void;
};

export const startDaemonTelegramListener = async (
  cp: ControlPlane,
  config: Parameters<typeof startTelegramLongPollListener>[1],
  daemon: DaemonTelegramComposition,
  options: DaemonTelegramStartOptions = {},
): Promise<TelegramLongPollListener> => {
  const listener = await startTelegramLongPollListener(cp, config, {
    ...options,
    // The daemon attaches the recovery controller before the first poll can possibly stop.
    start: false,
    onCeoApproved: (runId) => daemon.finalizeApprovedRun(runId),
    onRuntimeStatus: (status) => {
      try {
        daemon.setTelegramIngressStatus?.({
          configured: true,
          running: status.running,
          disabledReason: status.running
            ? null
            : status.stopReason === "UNKNOWN_DELIVERY"
              ? `listener stopped after an UNKNOWN reply delivery for nonce '${status.recoveryNonce}'; acknowledge this exact nonce to resume`
              : status.stopReason === "NOT_STARTED"
                ? "listener has not been started"
                : "listener closed",
          recoveryNonce: status.recoveryNonce,
        });
      } catch (error) {
        // Health I/O is an observer of the loop. Report its failure without turning a running
        // listener into a half-started one that the composition root no longer has a handle on.
        options.onError?.(error);
      }
      options.onRuntimeStatus?.(status);
    },
  });
  daemon.attachTelegramIngressController?.(listener.service);
  if (options.start === false) {
    const status = { running: false, stopReason: "NOT_STARTED", recoveryNonce: null } as const;
    daemon.setTelegramIngressStatus?.({
      configured: true,
      running: false,
      disabledReason: "listener has not been started",
      recoveryNonce: null,
    });
    options.onRuntimeStatus?.(status);
  } else {
    listener.service.start();
  }
  return {
    service: listener.service,
    close: async () => {
      try {
        await listener.close();
      } finally {
        daemon.detachTelegramIngressController?.(listener.service);
      }
    },
  };
};

/**
 * `startDaemonTelegramListener`, but a transport whose redelivery retention `IngressGuard`
 * cannot bound (#682, round 8) is refused as `null` rather than thrown.
 *
 * A supported, deliberately-configured transport — most commonly a self-hosted Bot API server
 * behind `ACP_TELEGRAM_API_BASE_URL` — can have a retention nobody here has measured, and the
 * guard now refuses to build a nonce floor it cannot bound. That refusal must not take the rest
 * of the daemon down with it: this operator configured Telegram on purpose, and MCP listeners,
 * Buzz and the operator door still have to come up. Any other failure is still a real bug and is
 * rethrown unchanged, so `main`'s own startup teardown still runs for it exactly as before.
 *
 * A separate top-level function rather than a nested `try`/`catch` inline in `main`: a nested
 * `try` that reassigns an outer `let` and conditionally rethrows is a real TypeScript control-flow
 * analysis gap (confirmed with a minimal reproduction against this repo's compiler) — the outer
 * variable narrows to `never` at the enclosing `catch` even though the value is reachable there.
 * One `await` of a plain function does not exhibit it.
 */
const startDaemonTelegramListenerOrRefuse = async (
  cp: ControlPlane,
  config: Parameters<typeof startTelegramLongPollListener>[1],
  daemon: DaemonTelegramComposition,
  options: DaemonTelegramStartOptions,
): Promise<{ listener: TelegramLongPollListener | null; disabledReason: string | null }> => {
  try {
    const listener = await startDaemonTelegramListener(cp, config, daemon, options);
    process.stdout.write("Telegram ingress started\n");
    return { listener, disabledReason: null };
  } catch (error) {
    if (!isTransportRetentionUnknown(error)) throw error;
    // The reason travels with the outcome rather than being re-derived at the call site, so
    // `health.json` (via `Daemon.setTelegramIngressStatus`, #682 round 8's second follow-up)
    // says the same thing this stderr line does — a daemon that comes up healthy while a
    // configured feature silently never started is exactly the gap that review found.
    const disabledReason =
      `transport's redelivery retention is not known for channel '${error.channel}'`;
    process.stderr.write(
      `Telegram ingress refused: its ${disabledReason}, so a safe nonce floor cannot be ` +
        "established; continuing without Telegram ingress\n",
    );
    return { listener: null, disabledReason };
  }
};

/**
 * `directHandler` returns a string, so a refusal has to be readable rather than thrown: the
 * owner is a person waiting in a chat, and an exception here would surface as a dropped
 * message. The reason code travels with the sentence so a refusal in the transcript can still
 * be traced to the branch that produced it.
 *
 * The return carries `answered` beside the text, and that is the whole of #639's residual fix.
 * Both branches produce a sentence the owner must see — silence after a timeout is worse than an
 * apology — but only one of them is the CEO answering. A bare string could not tell the ingress
 * layer which, so the reply's acceptance by Telegram resolved the turn either way, and a
 * `CEO_CONVERSATION_TIMEOUT` apology was indistinguishable from an answer in the row. Delivering
 * it and counting it as answered are now two separate things.
 */
export const answerAsCeo = async (
  port: CeoConversationPort,
  text: string,
): Promise<TelegramDirectAnswer> => {
  const answered = await port.ask(text);
  if (answered.allowed) return { answered: true, text: answered.value };
  return {
    answered: false,
    reasonCode: answered.reasonCode,
    text: `${ceoUnavailableSentence(answered.reasonCode)} (${answered.reasonCode})`,
  };
};

/**
 * `answerAsCeo` with the contact boundary kept, which the Buzz path needs and Telegram's
 * `directHandler` signature cannot carry.
 *
 * Whether the request crossed to the CEO peer is not derivable from the reason code — that is
 * the whole of #652 — and it decides whether the ingress claim closes or stays outstanding. A
 * string return value throws that fact away, so this returns it beside the text.
 */
export const deliverAsCeoTurn = async (
  port: CeoConversationPort,
  text: string,
  // Provenance reaches this delivery boundary; do not add it to the runtime prompt/transport.
  source: Pick<BuzzMessageIngressInput, "eventId" | "actor" | "conversation">,
  gatewayConversation?: (text: string, source: GatewayEventSource) => Promise<CeoTurnOutcome>,
): Promise<CeoTurnDelivery> => {
  const outcome = gatewayConversation
    ? await gatewayConversation(text, source)
    : await port.attempt(text);
  const reachedCeo = outcome.contact === "REACHED";
  if (outcome.answered.allowed) {
    return { answer: outcome.answered.value, reachedCeo, reasonCode: ReasonCode.OK };
  }
  return {
    answer: `${ceoUnavailableSentence(outcome.answered.reasonCode)} (${outcome.answered.reasonCode})`,
    reachedCeo,
    reasonCode: outcome.answered.reasonCode,
  };
};

/**
 * The durable owner-message ledger the connection-bound tools act through (`#760` Q2 §5/§6).
 *
 * Built here, from the control plane, because this is the only place that holds the outbox, the
 * database and an ingress guard at once — and because the alternative, letting `RoleConversationPort`
 * reach for them itself, would give a transport port database authority it has no business having.
 *
 * The ingress settlement is **not** here. `Outbox.completeForHolder` and `Outbox.rejectForHolder`
 * close the source claim inside their own transactions, and they are the single enforcement site
 * because they are the only one every caller passes through — the ledger below is one of five, next
 * to a fence sweep, a takeover, a revoke and the claim-path refusal. A copy here would be a second
 * site that reports coverage it does not independently have: it would settle the two transitions
 * the outbox already settles, and none of the three it does not.
 */
/**
 * A claimed message's provenance, from its own stored source row: the digest-checked payload's
 * room and the row's nonce, with the row's `actor` beside them labelled unverified because no digest
 * covers it. Buzz fields are read on the Buzz channel only, and anything absent or unreadable is
 * `null` rather than inferred.
 */
export const ownerMessageProvenanceOf = (
  channel: string,
  nonce: string,
  actor: string,
  payload: unknown,
): OwnerMessageProvenance => {
  const buzz = channel === "buzz";
  const conversation =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)["conversation"]
      : undefined;
  const eventId = nonce.startsWith(BUZZ_MESSAGE_NONCE_PREFIX) ? nonce.slice(BUZZ_MESSAGE_NONCE_PREFIX.length) : "";
  return {
    channel,
    room: buzz && typeof conversation === "string" && conversation.length > 0 ? conversation : null,
    // The digest-covered payload carries no signer, so there is no verified sender to report.
    senderKey: null,
    storedActorUnverified: actor.length > 0 ? actor : null,
    eventId: buzz && eventId.length > 0 ? eventId : null,
    replyToEventId: null,
  };
};

export const ownerMessageLedger = (cp: ControlPlane): OwnerMessageLedger => {
  /** The pointer on one owner-message row, or a denial naming what is wrong with it. */
  const pointerOn = (messageId: string) => {
    const row = cp.outbox.get(messageId);
    if (!row || !HOLDER_CLAIMED_KINDS.has(row.kind)) {
      return { pointer: null, refusal: deny(ReasonCode.NOT_FOUND, "no owner message has that id", { messageId }) };
    }
    const pointer = ownerMessagePointerOf(row.payload);
    if (!pointer) {
      return {
        pointer: null,
        refusal: deny(
          ReasonCode.OUTBOX_PAYLOAD_DIGEST_MISMATCH,
          "this owner message does not carry a readable source pointer",
          { messageId },
        ),
      };
    }
    return { pointer, refusal: null };
  };

  return {
    /**
     * §5 — Q1 moves at most one row, and only then is its source re-verified.
     *
     * The order is load-bearing in both directions. The transition happens first because a read
     * that decided whether to move the row would leave a window where a crash loses the message
     * with no record it was ever handed over. The verification happens second, inside the same
     * transaction, because a payload handed over on the strength of a pointer nobody re-checked is
     * a payload from wherever that pointer now points.
     *
     * A missing, malformed or mismatched source returns **no text** and terminally rejects the row
     * this call just claimed — and that rejection is why the outer frame is `tx` rather than
     * `txDecision`: the denial must commit, or the row would silently return to `PENDING` and be
     * served again with the same broken source forever.
     */
    claim: (holder: HolderIdentity): Decision<OwnerMessageHandover> => {
      try {
      return cp.db.tx((): Decision<OwnerMessageHandover> => {
        // #1044. A peer message's proof is checked here, before the hand-over's first write and in
        // its transaction, against the registry as it stands now: the CEO generation and the CEO
        // runtime it was admitted under, that runtime's channel identity — still the one that
        // signed, still not reused — and exactly this holder as the receiving CTO, on the project
        // channel the event arrived on. A row that fails is withheld rather than burned — not
        // handed over and not written to — and reported by id so the holder can reject it.
        const ceo = buzzPeerRegistry(cp).currentCeo();
        const ctoChannel = cp.sessions.get(holder.targetSessionId)?.buzzAddress ?? null;
        const taken = cp.outbox.claimForHolder(
          holder,
          (candidate) => {
            if (candidate.kind !== MessageKind.PEER_MESSAGE) return true;
            const source = admittedPeerSource(cp, candidate.payload);
            return peerProofIsCurrent(
              source,
              ceo,
              holder,
              ctoChannel,
              // The one holder besides the proof's own: its conversation restarted once, the row
              // carried to it by the canonical self-claim's recovery (2026-10-03) — accepted only
              // through that carry's record (ACP-PEER-SUCCESSION-01).
              selfClaimCarriedTo(cp.db, candidate, holder, source),
            );
          },
        );
        const unresolved = taken.unresolved;
        const withheld = taken.withheld;
        // ACP-PEER-SUCCESSION-01, ACP-RESTART-04: the CEO peer messages ACP rejected while they
        // were queued for this role — on a revoke, a takeover, a runtime move or a restart that
        // refused to carry them — that no holder has reported yet, by id, event, signer and reason
        // and never their text, so the CTO can tell the CEO in the thread and then report it.
        // Shown to the role's exact current holder only, whether or not it is the carry successor.
        // Present only when there is one, so a handover without any keeps its shape.
        const refusals = cp.outbox.peerMessageRefusalNoticesFor(holder).map(peerMessageRefusalNoticeOf);
        const notices = refusals.length > 0 ? { refusedAtRestart: refusals } : {};
        const message = taken.claimed[0];
        // Nothing new was handed over: either the queue is empty, or an unresolved hand-over is
        // blocking it. Both are reported with metadata only — `UnresolvedOwnerMessage` has no
        // payload field, so "never the payload twice" holds by the shape of what is returned.
        if (!message) {
          return allow(ReasonCode.OK, { claimed: null, unresolved, withheld, hasMore: taken.hasMore, ...notices });
        }
        const refuseClaimed = (reasonCode: ReasonCode, why: string): Decision<OwnerMessageHandover> => {
          const burned = cp.outbox.rejectForHolder(message.messageId, holder);
          // The reject and the settlement of the ingress claim it closes are one transition inside
          // `rejectForHolder`, and its `Decision` is the only report that both halves landed.
          // Discarding it was the fifth loss: the row went terminal, the claim stayed unresolved,
          // and the caller was handed this branch's refusal as if the burn had been clean.
          //
          // A refusal there cannot be *returned* from here, because the outer frame is `tx` and a
          // returned denial commits — which is exactly what the burn needs and exactly what half a
          // burn must not get. So it is thrown, the whole claim rolls back, and the row stays
          // `PENDING` with its claim untouched: a state a person can still act on, unlike a
          // terminal row holding a nonce forever.
          if (!burned.allowed) throw rollingBackClaim(burned);
          return deny(reasonCode, why, { messageId: message.messageId });
        };
        const pointer = ownerMessagePointerOf(message.payload);
        if (!pointer) {
          return refuseClaimed(
            ReasonCode.OUTBOX_PAYLOAD_DIGEST_MISMATCH,
            "this owner message does not carry a readable source pointer",
          );
        }
        const source = cp.db.get<{ payload_json: string | null; actor: string }>(
          `SELECT payload_json, actor FROM inbound_messages WHERE channel = ? AND nonce = ?`,
          [pointer.sourceChannel, pointer.sourceNonce],
        );
        if (!source?.payload_json) {
          return refuseClaimed(
            ReasonCode.NOT_FOUND,
            "the single durable copy of this message is gone, so there is nothing to hand over",
          );
        }
        let payload: unknown;
        try {
          payload = JSON.parse(source.payload_json) as unknown;
        } catch {
          return refuseClaimed(ReasonCode.INVALID_ARGUMENT, "the stored source envelope is not readable");
        }
        // The **full** payload, not the text: a digest over the text alone still matches after the
        // recipient fields inside the signature have been rewritten.
        if (digestOf(payload) !== pointer.sourcePayloadDigest) {
          return refuseClaimed(
            ReasonCode.OUTBOX_PAYLOAD_DIGEST_MISMATCH,
            "the stored source envelope is not the one this message was enqueued for",
          );
        }
        // Parsed as data, never as instructions (§27.4). A `text` of the wrong type is a source
        // this route cannot read, not something to coerce into a string.
        const text = (payload as { text?: unknown }).text;
        if (typeof text !== "string") {
          return refuseClaimed(
            ReasonCode.INVALID_ARGUMENT,
            "the stored source envelope carries no readable text",
          );
        }
        return allow(ReasonCode.UNTRUSTED_CONTENT_IS_DATA, {
          claimed: {
            messageId: message.messageId,
            text,
            sourceNonce: pointer.sourceNonce,
            createdAt: message.createdAt,
            // #1038. From the row's kind — the daemon's own fact — and never from the payload.
            principal: message.kind === MessageKind.PEER_MESSAGE ? "peer" : "owner",
            // From this message's own source row, read in the same transaction as its text.
            provenance: ownerMessageProvenanceOf(pointer.sourceChannel, pointer.sourceNonce, source.actor, payload),
          },
          unresolved,
          withheld,
          hasMore: taken.hasMore,
          ...notices,
        });
      });
      } catch (err) {
        const rolledBack = rolledBackClaim(err);
        if (rolledBack) return rolledBack;
        throw err;
      }
    },

    /**
     * §6 — the outbox row and the ingress claim close together, or neither closes.
     *
     * `txDecision`, so a refusal in the second half rolls the first half back: an outbox row moved
     * to `ACKED` beside an ingress claim still reading unresolved is exactly the split state that
     * makes `prune` and `unresolvedTurns` disagree about whether a turn finished.
     *
     * Both halves happen inside `Outbox.completeForHolder`, which is the single site every caller
     * of that transition passes through. What this frame adds is the *shape* check the outbox does
     * not do: that the id names an owner-message carrying a readable pointer at all, so a caller
     * naming some other row's id is refused before anything moves.
     */
    complete: (messageId: string, holder: HolderIdentity): Decision<void> =>
      cp.db.txDecision((): Decision<void> => {
        const { refusal } = pointerOn(messageId);
        if (refusal) return refusal;
        return cp.outbox.completeForHolder(messageId, holder);
      }),

    /** The same two ledgers, the same transaction, for a holder that refuses the message. */
    reject: (messageId: string, holder: HolderIdentity): Decision<void> =>
      cp.db.txDecision((): Decision<void> => {
        const { refusal } = pointerOn(messageId);
        if (refusal) return refusal;
        return cp.outbox.rejectForHolder(messageId, holder);
      }),

    /**
     * ACP-RESTART-04 — the role's current holder says it told the CEO about one rejected peer
     * message listed under `refusedAtRestart`, which retires that notice for every later holder.
     */
    reportRefusal: (messageId: string, holder: HolderIdentity): Decision<void> =>
      cp.outbox.reportPeerMessageRefusal(messageId, holder),
  };
};

/**
 * What a queued peer message was admitted from, read back through its pointer (#1044): the
 * generation proof and the room in the admitted payload, and the inbound row's author — or
 * `undefined` when the pointer, the stored envelope or its digest does not check out.
 *
 * Reads only, and the digest is checked here as well as after the claim: the proof a hand-over is
 * decided on must be the one admission digested, not merely whatever the pointer's row now says.
 */
const admittedPeerSource = (cp: ControlPlane, outboxPayload: unknown): AdmittedPeerSource | undefined => {
  const pointer = ownerMessagePointerOf(outboxPayload);
  if (!pointer) return undefined;
  const source = cp.db.get<{ actor: string; payload_json: string | null }>(
    `SELECT actor, payload_json FROM inbound_messages WHERE channel = ? AND nonce = ?`,
    [pointer.sourceChannel, pointer.sourceNonce],
  );
  if (!source?.payload_json) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(source.payload_json) as unknown;
  } catch {
    return undefined;
  }
  if (digestOf(payload) !== pointer.sourcePayloadDigest) return undefined;
  const admitted = payload as { peer?: unknown; conversation?: unknown; mention?: unknown };
  return {
    proof: admitted.peer,
    author: source.actor,
    conversation: admitted.conversation,
    mention: admitted.mention,
  };
};

/**
 * The claim path's rollback signal, thrown to undo a hand-over whose burn could not complete.
 *
 * A thrown object rather than a denied return, because `ownerMessageLedger.claim`'s frame is
 * `db.tx` and a *returned* denial there commits — which is what the ordinary source refusals need
 * (the row must stay burned) and what half a burn must not get. Deliberately not an `Error`:
 * `Db.translate` inspects an `Error`'s message for SQLite constraint text and would rewrite one
 * that happened to contain it, so the signal is a plain object that passes through untouched. The
 * same shape, and the same reasoning, as `admitBuzzMessage`'s.
 */
const CLAIM_ROLLBACK = Symbol("owner-message-claim-rollback");
interface ClaimRollback {
  readonly [CLAIM_ROLLBACK]: Decision<never>;
}
const rollingBackClaim = (decision: Decision<unknown>): ClaimRollback => ({
  [CLAIM_ROLLBACK]: decision as Decision<never>,
});
const rolledBackClaim = (err: unknown): Decision<never> | null =>
  typeof err === "object" && err !== null && CLAIM_ROLLBACK in err
    ? (err as ClaimRollback)[CLAIM_ROLLBACK]
    : null;

/**
 * Exported for test: these sentences are the only thing the owner sees when the CEO route
 * refuses, and one of them used to assert something this seam cannot observe. A sentence with no
 * test is a sentence that drifts back.
 */
export const ceoUnavailableSentence = (reasonCode: string): string => {
  if (reasonCode === ReasonCode.CEO_CONVERSATION_UNAVAILABLE) {
    return "No CEO session is connected right now, so there is nobody to answer this. Commands and owner decisions still work.";
  }
  if (reasonCode === ReasonCode.CEO_CONVERSATION_UNSUPPORTED) {
    return "The connected CEO session cannot hold a conversation over this route — it did not offer sampling at handshake.";
  }
  if (reasonCode === ReasonCode.CEO_CONVERSATION_TIMEOUT) {
    // Three corrections have landed on this one sentence, and each was the same mistake in a
    // different place.
    //
    // It said "Nothing was lost; ask again". The first correction was that this seam cannot see
    // whether anything was lost — the reply command resumes the owner's own conversation, so the
    // CEO may already have written part of an answer into it (#633).
    //
    // The second is that "ask again" is not advice, it is a mechanism. A resent message is a new
    // update with a new nonce and a new turn id, so nothing in the duplicate protection treats
    // it as the same turn — and the transcript gets the exchange twice (#641). The sentence that
    // was meant to help the owner recover was the path by which the thing being prevented
    // happened.
    //
    // So it no longer invites it. What it must not do instead is promise the mechanism that
    // replaces it: an earlier draft said a later message "is held rather than run", and the gate
    // that would hold it does not exist yet (#641). That sentence would have been false in the
    // other direction — the same defect, pointed the other way — and a blind review caught it
    // before it shipped.
    //
    // So it says only what is true now and stays true after the gate lands: the turn is
    // unresolved rather than failed, and a resend is a second turn rather than a retry. Asking
    // again remains the owner's call; it is not something this sentence asks for on their
    // behalf, before anyone knows whether the first turn landed.
    return "The CEO session has not answered yet. Its turn is unresolved rather than abandoned — an answer may still be arriving in the conversation. Sending the same message again starts a second turn rather than retrying this one.";
  }
  if (reasonCode === ReasonCode.CEO_CONVERSATION_TRANSPORT_FAILED) {
    // Not a timeout: the connection itself closed, or was already gone, rather than this
    // daemon's own clock running out. Same lesson as the sentence above — this seam cannot see
    // whether the turn reached the CEO before the connection dropped, so it does not claim
    // either way, and "ask again" is a new turn rather than advice to retry the old one.
    return "The connection to the CEO session dropped before it answered. Whether this message reached it is not known from here. Sending the same message again starts a new turn rather than retrying this one.";
  }
  if (reasonCode === ReasonCode.CEO_CONVERSATION_PEER_FAILED) {
    // This one the seam can say more about than the two above: the turn did reach the CEO
    // session, and it answered with an error instead of a reply. The peer's own error text is
    // not repeated here — it is written by the CEO runtime and may quote whatever it was
    // handling when it failed (see the port's catch block).
    return "The CEO session received this message and its reply failed. Sending the same message again starts a new turn rather than retrying this one.";
  }
  if (reasonCode === ReasonCode.CEO_CONVERSATION_BUSY) {
    // Not "send it again", and not a queue. The single-flight port refuses before this turn
    // reaches the canonical session; #631 may add durable ordering later, but #630 must tell the
    // owner only what exists now.
    return "The CEO is still working on the previous message. This one was not started.";
  }
  if (reasonCode === ReasonCode.CEO_CONVERSATION_STALE) {
    // This used to fall through to the sentence below, which says the CEO answered. It did not:
    // `ask` refuses a superseded socket before speaking to it at all, and the existing port test
    // asserts the peer received nothing. The owner was being told about an answer that was never
    // requested, on the one occasion when the identity of who answers had just changed.
    return "The CEO role moved to a new session, and the one this route was holding is no longer it. Nothing was asked of either; send the message again.";
  }
  if (reasonCode === ReasonCode.INTERNAL_ERROR) {
    // The port's catch block reaches this only when a rejection is none of the three it
    // classifies (timeout, transport failure, peer error). Falling through to the sentence below
    // would tell the owner the CEO answered, which is exactly the unearned claim this issue
    // exists to remove — an unclassified failure is not an answer.
    return "This message to the CEO session failed in a way that was not recognized. Sending the same message again starts a new turn rather than retrying this one.";
  }
  return "The CEO session answered with something this route cannot deliver as a message.";
};

export interface AgentcpdMainOptions {
  /** Test-only composition override; production calls `main()` without options. */
  config?: ControlPlaneConfig;
  /** Test-only transport/lifecycle seam; production uses the real Bot API and stays alive. */
  telegramStartOptions?: DaemonTelegramStartOptions;
  /** Allows a composition test to inspect the lock-held composition before shutting down. */
  waitForShutdown?: (
    shutdown: (signal: string) => Promise<void>,
    context: AgentcpdMainContext,
  ) => Promise<void>;
}

export interface AgentcpdMainContext {
  cp: ControlPlane;
  daemon: Daemon;
  telegram: TelegramLongPollListener | null;
  /**
   * The live CEO conversation port, exposed for the same reason `telegram` is: a composition
   * test has to be able to stand a peer in front of the surface `main` actually wired, rather
   * than assert against one it built itself.
   */
  ceoConversation: CeoConversationPort | null;
}

// Shape only — that this is an array of objects carrying these three string keys and optionally a
// fourth, `buzzAddress`, so an unrecognised key in the deployment's JSON is refused rather than
// ignored. Emptiness, the size bound, blank and padded fields, UUID form (the room's included) and
// uniqueness are `assertCanonicalSessionsValid`'s, which the claim's constructor calls too.
// Restating any of them here would put the same rule in two places, and the half kept here is the
// half that runs at startup.
const canonicalSessionsSchema = z.array(
  z
    .object({
      sessionUuid: z.string(),
      projectId: z.string(),
      buzzActorId: z.string(),
      buzzAddress: z.string().optional(),
    })
    .strict(),
);

/**
 * Which running sessions this deployment may adopt, and what each one is entitled to.
 *
 * One variable holding a list rather than a pair of scalars holding one session's uuid and one
 * session's Buzz channel identity, because the scalars made the cardinality a property of the
 * config *shape*: a second CTO could not be expressed at all, and the project a claimant asked
 * for was never compared against anything, so the single entitled session could hold
 * `PRIMARY_CTO` for every registered project (#1005). An entry is the whole entitlement — the
 * session, the one project it may hold, and the channel identity it speaks as — so neither half
 * can be configured without the other. It may also name the Buzz room that project's CEO talks to
 * its CTO in (`buzzAddress`); an entry that names none is written into `ACP_BUZZ_CHANNEL`.
 *
 * Deliberately the same shape as `ACP_CTO_BINDING_TARGETS_JSON`: a bounded JSON array parsed once
 * at startup, whose refusal names the variable and never its contents.
 */
export const configuredCanonicalSessions = (raw: string): readonly CanonicalAdoptableSession[] => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error("ACP_CANONICAL_SESSIONS_JSON is invalid");
  }
  const parsed = canonicalSessionsSchema.safeParse(decoded);
  if (!parsed.success) throw new Error("ACP_CANONICAL_SESSIONS_JSON is invalid");
  // The semantic rule, at startup, through the same function the claim's constructor uses. Without
  // this call the shape check passed a set with two entries sharing a uuid, the listener started
  // and reported itself up, and every claim then failed with INTERNAL_ERROR from the constructor —
  // while `deploy/README.md` said an invalid array refuses startup. The message names the variable
  // and never its contents, like every other refusal on this path.
  try {
    return assertCanonicalSessionsValid(parsed.data);
  } catch {
    throw new Error("ACP_CANONICAL_SESSIONS_JSON is invalid");
  }
};

/**
 * `agentcpd` — the single local runtime authority (PRD §33.1).
 *
 * Intended to run under a process supervisor (`launchd` on macOS). The daemon owns the
 * single-instance lock, restart reconciliation, the watchdog timer and Buzz delivery.
 */
export const main = async (options: AgentcpdMainOptions = {}): Promise<void> => {
  // Classify the complete environment-only group before reading config or acquiring resources.
  // Blank values are absent; nonblank values are retained exactly for the claim boundary.
  //
  // Three, not six. `ACP_CANONICAL_REQUIRED_EXECUTOR_VERSION`, `…_EXPECTED_EXECUTOR_REALPATH` and
  // `…_EXPECTED_EXECUTOR_SHA256` used to belong to the group; the claim no longer compares the
  // executing image against anything, so nothing reads them. They are not refused either: a
  // deployment that still provisions them starts exactly as one that does not, and they count
  // neither toward the group being present nor toward it being partial.
  const CANONICAL_ACTIVATION_VARS = [
    "ACP_CANONICAL_SESSIONS_JSON",
    "ACP_CANONICAL_CTO_PEER_PROTOCOL",
    "ACP_CANONICAL_CTO_BUZZ_PURPOSE",
  ] as const;
  const canonicalActivationValues = Object.fromEntries(
    CANONICAL_ACTIVATION_VARS.map((name) => [name, process.env[name] ?? ""]),
  ) as Record<(typeof CANONICAL_ACTIVATION_VARS)[number], string>;
  const missingCanonicalActivation = CANONICAL_ACTIVATION_VARS.filter(
    (name) => canonicalActivationValues[name].trim() === "",
  );
  const canonicalActivationPresentCount = CANONICAL_ACTIVATION_VARS.length - missingCanonicalActivation.length;
  if (canonicalActivationPresentCount > 0 && missingCanonicalActivation.length > 0) {
    throw new Error(
      `canonical self-claim activation is partially configured; missing: ${missingCanonicalActivation.join(", ")}`,
    );
  }
  // The existing shared transport channel does not activate canonical self-claim by itself.
  const canonicalBuzzChannelId = process.env["ACP_BUZZ_CHANNEL"]?.trim() ?? "";
  if (canonicalActivationPresentCount > 0 && !canonicalBuzzChannelId) {
    throw new Error("ACP_BUZZ_CHANNEL is required once canonical self-claim activation is fully configured");
  }

  // A2: the Gateway key the daemon holds for identity reads also reads the Gateway's Telegram turn
  // receipts. Without it the coordinator keeps its dark default.
  const config = withConfiguredHermesGatewayReceipt(options.config ?? defaultConfig(), process.env);
  const stateDir = dirname(config.databasePath);
  const buzzActorIngressPolicy = configuredBuzzActorIngressPolicy();
  if (process.env["BUZZ_PRIVATE_KEY"] && !buzzActorIngressPolicy) {
    throw new Error(
      "Buzz transport requires ACP_BUZZ_INGRESS_SECRET and ACP_BUZZ_ALLOWED_ACTORS for authenticated actor binding",
    );
  }
  const mcpToken = process.env["ACP_MCP_TOKEN"];
  if (!mcpToken) throw new Error("ACP_MCP_TOKEN is required for authenticated local MCP sockets");
  const operatorToken = process.env["ACP_OPERATOR_TOKEN"]?.trim();
  if (!operatorToken) {
    throw new Error(
      "ACP_OPERATOR_TOKEN is required for the operator socket; ACP_MCP_TOKEN identifies no peer and cannot be reused",
    );
  }
  if (operatorToken === mcpToken.trim()) {
    throw new Error(
      "ACP_OPERATOR_TOKEN must be a dedicated credential distinct from ACP_MCP_TOKEN; the MCP token identifies no peer",
    );
  }
  const operatorActor = process.env["ACP_OPERATOR_ACTOR"]?.trim() || process.env["USER"]?.trim() || "";
  if (!operatorActor) {
    throw new Error("ACP_OPERATOR_ACTOR or USER is required to establish the operator peer identity");
  }
  const hermesAdoptionConfiguration = Object.fromEntries(
    HERMES_ADOPTION_VARS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof HERMES_ADOPTION_VARS)[number], string | undefined>;
  // Both parsers refuse `ACP_TELEGRAM_EXTERNAL_CONSUMER=hermes` beside a bot token, here, before the
  // control plane or any listener exists. In that mode the long-poll parser answers null.
  const telegramExternalConfig = configuredTelegramExternalConsumerConfig(config.ownerIdentities ?? []);
  const telegramConfig = configuredTelegramLongPollConfig(config.ownerIdentities ?? []);
  const cp = new ControlPlane(config);

  // A migration that ran did so because someone approved it, and the approval names them.
  // `schema_migrations` records what changed; this records who decided it should (#738).
  if (cp.db.appliedMigrationApproval !== null) {
    cp.audit.record({
      kind: "SCHEMA_MIGRATION_APPROVAL_SPENT",
      reasonCode: ReasonCode.OK,
      evidence: {
        ...cp.db.appliedMigrationApproval,
        // #747 — filing the approval away can fail after the migration commits, and that no
        // longer fails the start. This is where the outcome becomes visible rather than lost:
        // an approval left on disk is inert, but it is not silent.
        retirement: cp.db.migrationApprovalRetirement,
      },
    });
  }
  // The repair half: an approval that outlived its own migration, filed away on this open.
  if (cp.db.staleMigrationApprovalRetirement !== null) {
    cp.audit.record({
      kind: "SCHEMA_MIGRATION_APPROVAL_RETIRED_LATE",
      reasonCode: ReasonCode.OK,
      evidence: { ...cp.db.staleMigrationApprovalRetirement },
    });
  }

  let sessionLaunch: LocalSessionLaunchChannel;
  try {
    sessionLaunch = await startSessionLaunchChannel(stateDir, { mcpToken });
  } catch (err) {
    cp.close();
    throw err;
  }

  // The configured set is parsed and checked here, before `daemon.start()`, not beside the listener
  // it configures. `start()` does not always return: a startup doctor finding eligible for the
  // bootstrap park waits in `parkForBootstrap()` for an observation, holding the lock with an
  // operator door open, and a denied start reports its own error first. A check placed after
  // `start()` is skipped on both paths, so a deployment with an unregistered project and no usable
  // capacity parked instead of refusing (review ACP1014-R1-01).
  //
  // Every entry's project must already be in the `projects` registry. The parse reads the value's
  // shape and its internal consistency; neither can see whether the project an entry entitles a
  // session to hold `PRIMARY_CTO` of was ever registered. Without this, a deployment configured
  // with an unregistered project started the listener and reported itself up while the entitlement
  // it held named a project no row exists for.
  //
  // Refused, not repaired and not dropped: a silently dropped entry is a session that can never
  // prove it may start work, with nothing saying why.
  //
  // Existence only — deliberately not availability. Whether a registered project is suspended or
  // not HEALTHY is a runtime condition, decided while the daemon runs by the code that owns it, and
  // it changes without the configuration changing; refusing startup on it would refuse a deployment
  // that is merely paused, and the daemon that must come up to unpause it is this one. What is
  // checked here is the one thing no later event can make true on its own: a project that was
  // never registered at all. Do not widen this to availability.
  let canonicalSessions: readonly CanonicalAdoptableSession[] | null = null;
  if (canonicalActivationPresentCount > 0) {
    try {
      canonicalSessions = configuredCanonicalSessions(canonicalActivationValues["ACP_CANONICAL_SESSIONS_JSON"]);
      const unregisteredEntryIndex = canonicalSessions.findIndex(
        (entry) => cp.projects.get(entry.projectId) === null,
      );
      if (unregisteredEntryIndex !== -1) {
        // This path's refusal shape: it names the variable and never its contents. The zero-based
        // index and the entry count are what let an operator find the offending entry in the value
        // they set, without this line quoting the project, the session or the actor it holds.
        throw new Error(
          `ACP_CANONICAL_SESSIONS_JSON is invalid: entry ${unregisteredEntryIndex} of ` +
            `${canonicalSessions.length} names a project that is not registered`,
        );
      }
    } catch (err) {
      // Nothing past this point has started yet: the session-launch channel and the control plane
      // are the two things open, and both are closed before the refusal leaves.
      await sessionLaunch.close();
      cp.close();
      throw err;
    }
  }

  const buzzTransport = new BuzzCliTransport(
    process.env["ACP_BUZZ_BINARY"] ?? "buzz",
    process.env["ACP_BUZZ_CHANNEL"] ?? null,
  );
  const buzz = new BuzzAdapter(cp.db, cp.clock, cp.audit, cp.sessions, cp.bindings, cp.outbox, buzzTransport);
  // A channel address only, deliberately not `BuzzAdapter.connect` (#760): that method also calls
  // `sessions.setBuzzAddress(sessionId, ...)` for an *existing* session, and the canonical
  // self-claim primitive resolves its address before the session it belongs to exists
  // (`sessions.create` accepts `buzzAddress` directly, inside the same transaction that mints it).
  //
  // `channelId` is the claiming entry's room: its own `buzzAddress`, or `ACP_BUZZ_CHANNEL` when it
  // names none. A transport bound to that one room is asked, so a per-entry room goes through the
  // same `available` and `openChannel` — `buzz channels get`, and the relay's answer required to
  // name that very channel — as the deployment's default room did through `buzzTransport`.
  const resolveCanonicalSelfClaimBuzzAddress = async (
    purpose: string,
    channelId: string,
  ): Promise<Decision<string>> => {
    const roomTransport = new BuzzCliTransport(process.env["ACP_BUZZ_BINARY"] ?? "buzz", channelId);
    if (!(await roomTransport.available(purpose))) {
      return deny(ReasonCode.PROBE_FAILED, "buzz transport is not available", { purpose });
    }
    try {
      return allow(ReasonCode.OK, await roomTransport.openChannel(purpose));
    } catch (err) {
      return deny(ReasonCode.PROBE_FAILED, `buzz connect failed: ${(err as Error).message}`, { purpose });
    }
  };
  cp.cto.attach({
    buzz: {
      connect: (sessionId, purpose) => buzz.connect(sessionId, purpose),
      disconnect: (sessionId) => buzz.disconnect(sessionId),
    },
    readiness: { checkSession: (id) => cp.doctor.sessionReadiness(id) },
    sessionLaunch,
  });

  const daemon = cp.createDaemon({ stateDir, buzz });

  let listeners: LocalMcpListeners | null = null;
  let buzzActorIngress: LocalBuzzActorIngress | null = null;
  let buzzMessageIngress: LocalBuzzMessageIngress | null = null;
  let buzzMentionSubscriber: BuzzMentionSubscriberHandle | null = null;
  // Read when asked, not captured: the claim and the reattach are composed before the subscriber
  // starts, and until it does (or where none runs) this answers `null` and checks nothing. That
  // `null` is only an answer once startup has decided whether a subscriber runs, which is what the
  // latch below is for.
  const subscribedBuzzRooms: SubscribedBuzzRooms = (buzzActorId) =>
    subscribedBuzzRoomsFrom(buzzMentionSubscriber?.identityRooms ?? [])(buzzActorId);
  // One way, released once, as startup's last statement: after it has decided the mention subscriber,
  // `assertCanonicalRoomsAreSubscribed` accepted every entry and no later step refused. The claim and reattach
  // sockets open before that, and a claim or correction let through then found the lookup above
  // `null`, opened its room and wrote its row before the start was refused (PR1060-R2-01). Until
  // the release a claim is refused and a correction waits; a start that throws never releases it,
  // so neither has written anything.
  let canonicalRoomsSettled = false;
  let settleCanonicalRooms: () => void = () => undefined;
  const canonicalRoomsChecked = new Promise<void>((resolve) => {
    settleCanonicalRooms = () => {
      canonicalRoomsSettled = true;
      resolve();
    };
  });
  let ownerReplies: DaemonOwnerReplyConsumer | null = null;
  let peerMessageNotices: DaemonPeerMessageNoticeDelivery | null = null;
  let operator: LocalOperatorListener | null = null;
  let canonicalSelfClaim: CanonicalSelfClaimListener | null = null;
  let adoptedCeoTools: CanonicalSelfClaimListener | null = null;
  let hermesAutoAdoptionTimer: NodeJS.Timeout | null = null;
  let hermesBootstrap: HermesBootstrapAuthority | null = null;
  let telegram: TelegramLongPollListener | null = null;
  let telegramExternal: LocalTelegramExternalIngress | null = null;
  let startCompleted = false;

  let shuttingDown: Promise<void> | null = null;
  const shutdown = async (signal: string): Promise<void> => {
    // A supervisor that sends SIGTERM twice, or SIGTERM then SIGINT, must not run this twice:
    // the listener handles have no closing guard, and Node rejects a second `server.close()`
    // with ERR_SERVER_NOT_RUNNING — which, through `void shutdown(...)`, is an unhandled
    // rejection during the one operation that most needs to finish.
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
    process.stdout.write(`\nshutting down on ${signal}\n`);
    if (hermesAutoAdoptionTimer) clearInterval(hermesAutoAdoptionTimer);
    await telegram?.close();
    ownerReplies?.close();
    peerMessageNotices?.close();
    await telegramExternal?.close();
    buzzMentionSubscriber?.close();
    await buzzMessageIngress?.close();
    await buzzActorIngress?.close();
    await operator?.close();
    await canonicalSelfClaim?.close();
    await adoptedCeoTools?.close();
    await hermesBootstrap?.close();
    await listeners?.close();
    await sessionLaunch.close();
    const stopped = await daemon.stop();
    // Before `start()` returns, the control plane is still unwinding it — `daemon.stop()` has
    // released the lock, which is what a supervisor is waiting for, and closing the database
    // out from under that unwind would only turn a clean stop into an error.
    if (startCompleted) cp.close();
    // #1070 ACP-WORKER-03-FC — an incomplete stop is reported, never exited as clean. The lock and the
    // durable fence beside it stay, so exiting here does not let a successor take authority while a
    // worker git process group may still run; the exit status tells the supervisor why.
    if (!stopped.complete) {
      process.stderr.write("agentcpd: a worker git process group was not confirmed finished; the daemon lock stays fenced\n");
      process.exit(STOP_INCOMPLETE_EXIT_CODE);
    }
    process.exit(0);
    })();
    return shuttingDown;
  };

  // Installed before `start()`, not after. A daemon that parks has not returned from `start()`,
  // and only `daemon.stop()` releases the single-instance lock. Without a handler here a
  // supervisor's SIGTERM is a default kill that leaves the lock file behind, and
  // `install-launchd.sh upgrade` and `rollback` both wait for that file to disappear before
  // they will touch the database — so a parked daemon would fail every deploy on the host this
  // whole change exists for.
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  const started = await daemon.start({
    bootstrapDoor: () =>
      startBootstrapOperatorDoor(
        daemon,
        stateDir,
        { token: operatorToken, peerId: `cli:${operatorActor}`, actor: operatorActor },
        { mcpToken },
      ),
  });
  if (!started.allowed) {
    process.stderr.write(`${JSON.stringify(started, null, 2)}\n`);
    process.stderr.write(
      `backoff: ${JSON.stringify(daemon.crashLoopState())}\n`,
    );
    const backoffSeconds = daemon.crashLoopState().backoffSeconds;
    if (backoffSeconds > 0) await waitForBackoff(backoffSeconds);
    await sessionLaunch.close();
    cp.close();
    process.exit(1);
  }

  startCompleted = true;
  try {
    hermesBootstrap = createHermesBootstrapAuthority(cp, {
      stateDir,
      mcpSocketPath: join(stateDir, "hermes.mcp.sock"),
      mcpToken,
      authorityHeld: () => daemon.lock.held(),
    });
    const adoptHermesIncumbent = createConfiguredHermesIncumbentAdoption(
      cp, hermesAdoptionConfiguration, { authorityHeld: () => daemon.lock.held() },
    );
    // The same core, asked by the daemon: a revoked CEO whose Gateway was redeployed is adopted
    // again without anyone running `agentctl adopt hermes`, which stays as a way to ask sooner.
    const hermesAutoAdoption = adoptHermesIncumbent
      ? createConfiguredHermesAutoAdoption(cp, hermesAdoptionConfiguration, {
        adopt: adoptHermesIncumbent, authorityHeld: () => daemon.lock.held(),
      })
      : undefined;
    if (hermesAutoAdoption) {
      hermesAutoAdoptionTimer = startHermesAutoAdoption(cp, hermesAutoAdoption);
      process.stdout.write("Hermes CEO auto-adoption started\n");
    }
    // The operator socket is opened first so the uninitialized-only bootstrap door can be
    // reached without exposing a normal Hermes listener that has no bound peer yet.
    operator = await startDaemonOperatorSocket(
      cp,
      daemon,
      stateDir,
      {
        token: operatorToken,
        peerId: `cli:${operatorActor}`,
        actor: operatorActor,
      },
      {
        mcpToken,
        bootstrapHermes: (params) => hermesBootstrap!.bootstrap(params),
        ...(adoptHermesIncumbent ? { adoptHermesIncumbent } : {}),
      },
    );
    if (canonicalSessions === null) {
      // Disabled: no partial credential surface is exposed, no socket is bound, and normal
      // startup continues exactly as it would for a deployment that has never heard of this
      // feature. The diagnostic names only the variables themselves — no value, secret or
      // otherwise, is ever in this line.
      process.stdout.write(
        `canonical self-claim disabled: none of ${CANONICAL_ACTIVATION_VARS.join(", ")} is set\n`,
      );
    } else {
      // No `daemon.setCanonicalExecutorVersion` call any more. It handed the deployment's required
      // executor version to the system report so #886 could compare it against the build the wake
      // transport was qualified on. With no version pin on the claim there was nothing to hand it,
      // and the setter and that finding were removed from `daemon.ts` with it.
      // Its own dedicated, token-less listener (#760): a process may prove who it is, but it
      // cannot approve itself, so the claiming connection never holds, reads, or is checked
      // against `ACP_OPERATOR_TOKEN`; its only authority is the kernel's own record of who opened
      // this socket, checked by `startCanonicalSelfClaimListener` itself before this handler is
      // ever called.
      canonicalSelfClaim = await startCanonicalSelfClaimListener(daemon, stateDir, async (peer, params) => {
        // Refused before anything is constructed, so a claim in that window opens no room and
        // writes no row, not even its refusal's audit row. Claiming again after startup succeeds.
        if (!canonicalRoomsSettled) {
          return deny(
            ReasonCode.CONFLICT,
            "the daemon is still starting and has not checked each canonical CTO's Buzz room against its mention subscriber",
            {},
          );
        }
        // Deployment facts are the entry-time snapshot, never request or callback-time values.
        return executeCanonicalSelfClaimOperator(peer, params, {
          db: cp.db,
          clock: cp.clock,
          audit: cp.audit,
          sessions: cp.sessions,
          bindings: cp.bindings,
          // Each canonical CTO's own Buzz channel identity is a deployment fact, configured the
          // same way the CLI operator identity is (`ACP_OPERATOR_ACTOR`) — not something a
          // caller asserts and this authenticator merely echoes back. Every entry's identity is
          // admissible here and the claim then uses the one belonging to the session the kernel
          // says is calling, so this guard bounds the set without choosing from it.
          buzzActorAuthenticator: new IngressGuard(cp.db, cp.clock, cp.audit, {
            buzz: { allowedActors: canonicalSessions.map((entry) => entry.buzzActorId) },
          }),
          resolveBuzzAddress: resolveCanonicalSelfClaimBuzzAddress,
          config: {
            canonicalSessions,
            canonicalBuzzChannelId,
            expectedPeerProtocolVersion: canonicalActivationValues["ACP_CANONICAL_CTO_PEER_PROTOCOL"],
            // Matches the listener's own derivation exactly: both read this daemon's effective
            // uid, never a value either side is told by the other.
            expectedPeerIdentity: `uid:${process.geteuid?.() ?? -1}`,
            peerProtocolVersion: canonicalActivationValues["ACP_CANONICAL_CTO_PEER_PROTOCOL"],
            buzzPurpose: canonicalActivationValues["ACP_CANONICAL_CTO_BUZZ_PURPOSE"],
          },
          subscribedBuzzRooms,
        });
      });
      process.stdout.write("canonical self-claim listener started\n");
    }
    listeners = await startDaemonMcpListeners(cp, stateDir, mcpToken, daemon);
    // #246 C1b — a provisioned session's turns reach the daemon only through these two sockets,
    // so its runtime gets them once both are listening. Until then (the queued-run resume inside
    // `daemon.start()` included) a bootstrap dispatch is refused SESSION_RUNTIME_UNAVAILABLE before
    // any provider turn is spent, and its run stays QUEUED.
    cp.sessionRuntime.attach({
      delivery: sessionLaunch,
      route: { launchSocketPath: sessionLaunch.socketPath, mcpSocketPath: join(stateDir, "cto.mcp.sock") },
    });
    // #1037 — only where the canonical claim is configured: reattaching is that claim's sequel.
    if (canonicalSessions !== null) {
      // The same set, resolver and purpose the claim is given, so the room a reattach corrects a
      // live holder's row to is the room a claim would write and is opened the same way.
      const canonicalCtoReattach = createCanonicalCtoReattach(cp, {
        buzzAddress: {
          canonicalSessions,
          resolveBuzzAddress: resolveCanonicalSelfClaimBuzzAddress,
          buzzPurpose: canonicalActivationValues["ACP_CANONICAL_CTO_BUZZ_PURPOSE"],
          subscribedBuzzRooms,
        },
      });
      // Admission is untouched and never waits on Buzz. Only the correction waits for the room
      // check: it is fired after admission and nobody retries it, so refusing it would leave the
      // CTO in its old room until the next reattach, while refusing the reattach ends the relay.
      await listeners.openCanonicalCtoReattach({
        ...canonicalCtoReattach,
        correctBuzzAddress: async (peer) => {
          await canonicalRoomsChecked;
          return canonicalCtoReattach.correctBuzzAddress(peer);
        },
      }, daemon);
      process.stdout.write("canonical CTO reattach socket started\n");
    }
    // #1037 — the adopted CEO's tools, on their own kernel-peer socket; only when adoption is
    // configured, since that configuration is what the admission compares the Gateway against.
    const adoptedCeoAdmission = createConfiguredAdoptedCeoToolAdmission(cp, hermesAdoptionConfiguration, {
      authorityHeld: () => daemon.lock.held(),
    });
    // Minted on the adopted CEO tool socket and answered through the mention subscriber, so one
    // store serves both; in memory only, and a restart drops every pending challenge.
    const buzzBindChallenges = buzzActorIngressPolicy === null
      ? undefined
      : createDaemonBuzzBindChallenges(cp, buzzActorIngressPolicy);
    if (adoptedCeoAdmission) {
      adoptedCeoTools = await startAdoptedCeoToolSocket(cp, daemon, stateDir, adoptedCeoAdmission, {
        onCeoApproved: (runId) => daemon.finalizeApprovedRun(runId),
        // The same guard policy the relay's binding socket uses: one allowlist, one signing secret.
        ...(buzzActorIngressPolicy === null ? {} : {
          buzzActorIngress: new BuzzActorIngress(
            new IngressGuard(cp.db, cp.clock, cp.audit, { buzz: buzzActorIngressPolicy }),
            cp.sessions,
          ),
        }),
        ...(buzzBindChallenges === undefined ? {} : { buzzBindChallenges }),
      });
      process.stdout.write("adopted CEO tool socket started\n");
    }
    if (buzzActorIngressPolicy) {
      buzzActorIngress = await startBuzzActorIngressListener(cp, stateDir, buzzActorIngressPolicy);
      // The receiving half of #627. It opens with the binding half because both are the same
      // relay credential, and separately from it because they are different authorities — which
      // is why it needs a second fact the binding half does not: who the owner is. Without a
      // declared buzz owner the relay credential alone would carry owner authority, so the
      // socket stays closed and the operator is told which file to declare it in.
      const buzzMessageOwnerActors = configuredBuzzMessageOwnerActors(config.ownerIdentities ?? []);
      if (buzzMessageOwnerActors.length === 0) {
        process.stdout.write(
          "Buzz message ingress not started: no owner identity with channel \"buzz\" is declared in owner-identities\n",
        );
      } else {
        buzzMessageIngress = await startDaemonBuzzMessageIngress(
          cp,
          stateDir,
          buzzActorIngressPolicy,
          listeners,
          buzzMessageOwnerActors,
          createConfiguredHermesGatewayConversation(cp, hermesAdoptionConfiguration, {
            authorityHeld: () => daemon.lock.held(),
          }),
        );
        process.stdout.write("Buzz message ingress started\n");
        // #760 Part C — the daemon's own front door on the relay, feeding the socket above.
        //
        // Configured-off by default and by construction: with no `buzz-nostr-subscriber.json`
        // beside the daemon's other state this opens nothing and reports zero sockets, which is
        // every deployment until an operator writes that file. A malformed one is a startup
        // error rather than a quiet zero, because an operator who wrote the file meant it.
        //
        // An identity without a live binding no longer refuses the subscriber: it is excluded,
        // reported, and re-judged on every binding switch and on the subscriber's own schedule,
        // while every other identity subscribes. One paused CTO used to silence all of them.
        buzzMentionSubscriber = startDaemonBuzzMentionSubscriber(cp, stateDir, buzzActorIngressPolicy, buzzMessageIngress, {
          ...(buzzBindChallenges === undefined ? {} : { bindChallenges: buzzBindChallenges }),
          canonical: canonicalSessions === null ? null : { sessions: canonicalSessions },
        });
        rejudgeBuzzMentionSubscriberOnBindingSwitch(cp, () => buzzMentionSubscriber);
        process.stdout.write(
          `Buzz mention subscriber configured identities: ${buzzMentionSubscriber.socketCount}\n`,
        );
        // The configured count above is not continuity. This line is: how many of them are
        // delivering, and the one word that says whether that is all of them.
        if (buzzMentionSubscriber.socketCount > 0) {
          const admission = buzzMentionSubscriber.admission();
          process.stdout.write(
            `Buzz mention subscriber admitted identities: ${admission.admittedIdentities} of ` +
              `${admission.configuredIdentities} (${admission.continuity})\n`,
          );
        }
        // Hand `doctor` the counters, not this number. The line above is what the subscriber was
        // *configured* to be and is printed once; `doctor` needs what it has actually received,
        // and that is the only thing that can tell "connected and silent" from "receiving and
        // refusing" (#674, #841). Only when a subscriber exists: a deployment without one has
        // nothing to be silent about. The counters carry `admission` beside them, so health.json
        // shows a PARTIAL subscriber and each excluded identity's reason, read when it is written.
        // Captured into a const: `buzzMentionSubscriber` is a `let` the startup path reassigns,
        // and a closure over it would read whatever it holds when `doctor` runs rather than the
        // subscriber this block is about — which is also why TypeScript refuses to narrow it here.
        const startedSubscriber = buzzMentionSubscriber;
        if (startedSubscriber && startedSubscriber.socketCount > 0) {
          daemon.setBuzzMentionReceipt({
            configuredIdentities: startedSubscriber.socketCount,
            counters: () => startedSubscriber.counters(),
          });
        }
        // The room the daemon *answers* in already has a name (`ACP_BUZZ_CHANNEL`, the outbound
        // adapter's own default-channel route — `buzz-adapter.ts`). The subscriber above now
        // carries its own, independently configured room list; a room in one and not the other is
        // silent on both sides — the reply lands somewhere real, and the mention that was never
        // subscribed to simply never wakes anything. So the two are cross-checked here, once, at
        // the one point in startup where both values are in hand: this module reads
        // `ACP_BUZZ_CHANNEL` for the canonical self-claim group above and the subscriber never
        // reads the environment at all, so the comparison belongs to the caller, not either side.
        assertBuzzChannelMatchesSubscriberRooms(
          process.env["ACP_BUZZ_CHANNEL"]?.trim(),
          buzzMentionSubscriber?.rooms ?? [],
        );
        // And per adopted CTO, against its own identity's rooms rather than the union: an entry may
        // name a room of its own, and the union cannot say which identity hears it.
        if (canonicalSessions !== null) {
          assertCanonicalRoomsAreSubscribed(canonicalSessions, canonicalBuzzChannelId, subscribedBuzzRooms);
        }
      }
    }
    // #1036 — the owner-reply consumer, next to the subscriber it publishes through. Started on
    // every deployment, subscriber or not: an item it cannot deliver is still recorded as such.
    ownerReplies = startDaemonOwnerReplyConsumer(cp, buzzMentionSubscriber);
    process.stdout.write("owner-reply consumer started\n");
    // #1068 finding 04 (acp-daemon-notice/v1): the CEO is told of each refused peer message by the
    // daemon itself, through its existing canonical conversation, whether or not a CTO holds the role.
    // The HMAC key is derived from the U4 lane secret; without the lane or the Gateway pin, the
    // notices stay owed to the role's next holder as before.
    const notices = startConfiguredPeerMessageNoticeDelivery(cp, {
      environment: process.env,
      hermesConfiguration: hermesAdoptionConfiguration,
      laneSecret: telegramExternalConfig?.sharedSecret ?? null,
      ports: { authorityHeld: () => daemon.lock.held() },
    });
    peerMessageNotices = notices.delivery;
    process.stdout.write(notices.delivery !== null
      ? "peer-message notice delivery started\n"
      : `peer-message notice delivery not started: ${notices.notStarted}\n`);
    void notices.probe?.then((probe) => {
      // Ids and outcomes only: the probe's report carries no secret and no message content.
      process.stdout.write(`daemon notice probe: ${JSON.stringify(probe)}\n`);
    }, (error: unknown) => {
      process.stderr.write(`daemon notice probe failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    if (telegramExternalConfig) {
      // U4: Hermes polls Telegram; ACP only admits, claims and dispatches what Hermes hands it.
      telegramExternal = await startTelegramExternalIngress(cp, stateDir, telegramExternalConfig);
      process.stdout.write("Telegram external consumer lane started for hermes\n");
    } else if (process.env["ACP_TELEGRAM_EXTERNAL_CONSUMER"]?.trim()) {
      process.stdout.write(
        "Telegram external consumer lane not started: ACP_TELEGRAM_EXTERNAL_SECRET is not configured\n",
      );
    }
    if (telegramConfig) {
      const telegramStartOptions = options.telegramStartOptions ?? {};
      const ceoConversation = listeners.ceoConversation;
      const outcome = await startDaemonTelegramListenerOrRefuse(cp, telegramConfig, daemon, {
        // §6.1 — ordinary conversation goes to the CEO. A test that supplies its own handler
        // keeps it; production has none, which is how this route stayed unreachable.
        onDirect: (input) => answerAsCeo(ceoConversation, input.text),
        ...telegramStartOptions,
        onError: (error) => {
          process.stderr.write(`telegram ingress error: ${error instanceof Error ? error.message : String(error)}\n`);
          telegramStartOptions.onError?.(error);
        },
      });
      telegram = outcome.listener;
      if (!outcome.listener) {
        daemon.setTelegramIngressStatus({
          configured: true,
          running: false,
          disabledReason: outcome.disabledReason,
          recoveryNonce: null,
        });
      }
    } else {
      process.stderr.write("Telegram ingress not configured; continuing without Telegram ingress\n");
      daemon.setTelegramIngressStatus({ configured: false, running: false, disabledReason: null });
    }
    // The last statement of startup, after every step that can still refuse it (PR1060-FU-01): the
    // subscriber is decided, its rooms are checked, and only now may a claim or correction open a room.
    settleCanonicalRooms();
  } catch (err) {
    if (hermesAutoAdoptionTimer) clearInterval(hermesAutoAdoptionTimer);
    await telegram?.close();
    await telegramExternal?.close();
    // Both Buzz listeners, which this teardown used to walk past: a startup that failed after
    // one of them bound left its socket file behind for the next daemon to find. The relay
    // subscriber joins them for the same reason: it holds outbound sockets, and a startup that
    // failed after it opened them would leave a daemon that exited still subscribed.
    ownerReplies?.close();
    peerMessageNotices?.close();
    buzzMentionSubscriber?.close();
    await buzzMessageIngress?.close();
    await buzzActorIngress?.close();
    await operator?.close();
    await canonicalSelfClaim?.close();
    await adoptedCeoTools?.close();
    await hermesBootstrap?.close();
    await listeners?.close();
    await sessionLaunch.close();
    await daemon.stop();
    cp.close();
    throw err;
  }

  process.stdout.write(`${JSON.stringify({ started: started.value }, null, 2)}\n`);

  const context: AgentcpdMainContext = {
    cp,
    daemon,
    telegram,
    ceoConversation: listeners?.ceoConversation ?? null,
  };

  // Keep the process alive; work arrives through authenticated local MCP sockets or timers.
  if (options.waitForShutdown) {
    await options.waitForShutdown(shutdown, context);
  } else {
    // The one existing internal tick, and the mention subscriber's periodic judgement rides it: a
    // session that stops, or whose room is rewritten, publishes no binding switch, and an admitted
    // identity would otherwise be judged again only when its next mention arrives. Judged first,
    // so the health written on the same tick reports the result.
    setInterval(() => {
      buzzMentionSubscriber?.rejudge();
      daemon.writeHealth(null);
    }, 30_000).unref();
    await new Promise<void>(() => undefined);
  }
};

const waitForBackoff = async (seconds: number): Promise<void> => {
  let remainingMs = seconds * 1000;
  while (remainingMs > 0) {
    const intervalMs = Math.min(60_000, remainingMs);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, intervalMs));
    remainingMs -= intervalMs;
  }
};

/** What a failed start hands to the supervisor, and what it leaves behind for the owner. */
export interface StartupDisposition {
  exitCode: number;
  body: Record<string, unknown>;
  /** The refusal report's path when one was written, so the stderr line can name it. */
  reportPath: string | null;
}

/**
 * Decides the exit code a failed start gives launchd (#738).
 *
 * `KeepAlive { SuccessfulExit = false }` is a conditional: launchd restarts this job when it
 * exits *un*successfully and leaves it alone when it exits 0. Every failure path here has
 * always exited 1, which is right for a crash — but a refusal is not a crash. A daemon that
 * refuses to migrate and exits 1 is restarted 30 seconds later (`ThrottleInterval`), refuses
 * again, and burns a restart every 30 seconds until someone notices. That is the crash loop
 * with a nicer message, and `DAEMON_CRASH_LOOP`'s 137 records are what it looks like.
 *
 * Exiting 0 is what makes the refusal durable: launchd stops, and the state is exactly one
 * refusal per boot rather than one every half minute. The cost is that a stopped job is quiet,
 * so the refusal report and the stderr line below are not decoration — during a refusal there
 * is no operator socket and no doctor, because both need the `ControlPlane` that could not open
 * the database. `agentctl daemon status` reads the report offline, which is the one observation
 * path that survives.
 *
 * Nothing else changes: a crash, a doctor block, a bad token still exit 1 and are still
 * retried.
 */
export const dispositionForStartupError = (err: unknown, databasePath: string): StartupDisposition => {
  const body = isAcpError(err)
    ? { reasonCode: err.reasonCode, message: err.message, evidence: err.evidence }
    : { message: (err as Error).message, stack: (err as Error).stack };
  if (!isAcpError(err) || err.reasonCode !== ReasonCode.SCHEMA_MIGRATION_NOT_APPROVED) {
    return { exitCode: 1, body, reportPath: null };
  }
  const report = { refusedAt: new Date().toISOString(), pid: process.pid, ...body };
  let reportPath: string | null = null;
  try {
    reportPath = recordMigrationRefusal(databasePath, report);
  } catch (writeError) {
    // A state directory this process cannot write is a different fault, and it must not turn a
    // decided refusal back into a restart loop. The stderr line still carries the whole plan.
    process.stderr.write(
      `${JSON.stringify({ migrationRefusalReportUnwritable: String(writeError) }, null, 2)}\n`,
    );
  }
  return { exitCode: 0, body: report, reportPath };
};

/**
 * Whether this module is the process entrypoint, not merely importable from one.
 *
 * `import.meta.url` is always the realpath Node resolved the module through, but
 * `process.argv[1]` is whatever path the caller passed — including a symlink, such as
 * `<state root>/current` (#1052). `resolve()` only normalizes a path; it does not follow
 * symlinks, so comparing it against the realpath never matched through that link and the daemon
 * silently did nothing. Resolving both sides with `realpathSync` keeps the check correct across
 * symlinks; a path that cannot be resolved (missing, unreadable, a dangling link) is treated as
 * "not main" rather than thrown.
 */
const isMainModule = (): boolean => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
};

if (isMainModule()) {
  void main().catch((err: unknown) => {
    const disposition = dispositionForStartupError(err, defaultConfig().databasePath);
    process.stderr.write(`${JSON.stringify(disposition.body, null, 2)}\n`);
    if (disposition.exitCode === 0) {
      process.stderr.write(
        "agentcpd refused to start: this build would migrate the live database and no approval " +
          "names that migration. The daemon is stopped and will not be restarted by launchd " +
          "until it is started again.\n" +
          (disposition.reportPath === null ? "" : `Refusal report: ${disposition.reportPath}\n`) +
          "Approve with: agentcpd-state approve-migration --approved-by <who> --confirm-migration\n" +
          "Inspect without approving: agentcpd-state migration-plan\n",
      );
    }
    process.exit(disposition.exitCode);
  });
}
