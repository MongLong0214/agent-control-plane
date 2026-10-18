import { chmodSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";
import { finalizeEvent } from "nostr-tools/pure";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  REPO_FACTORY_GITHUB_WRITE_OPERATION,
  repoFactoryGitHubWriteParameters,
} from "../../src/bootstrap/repo-factory-bootstrap-run.ts";
import type { ProjectManifest } from "../../src/contracts/manifest.ts";
import { digestOf, sha256Hex } from "../../src/core/digest.ts";
import { buzzMessageSigningRequest, deliverBuzzMessage } from "../../src/ingress/buzz-message.ts";
import { IngressGuard, ingressSignature, ownerApprovalPayload } from "../../src/ingress/ingress-guard.ts";
import { admitRuntimeLineage } from "../../src/session/runtime-lineage.ts";

import type * as ApprovalModuleNamespace from "../../src/buzz/buzz-owner-approval.ts";
import type {
  BuzzOwnerApprovalRunnerPort,
  BuzzOwnerApprovals,
} from "../../src/buzz/buzz-owner-approval.ts";
import type { BuzzMentionEvent } from "../../src/buzz/buzz-mention-subscriber.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { OWNER_DECIDE_AGAIN_MESSAGE } from "../../src/db/artifacts.ts";
import * as productionGate from "../../src/ceo/production-gate.ts";
import * as daemonComposition from "../../src/daemon/agentcpd.ts";
import { startBuzzMessageIngressListener, startDaemonBuzzMentionSubscriber } from "../../src/daemon/agentcpd.ts";
import { ExecutionMode, Role, RunKind, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import {
  APPROVED_PROTECTION,
  bootstrapOperations,
  bootstrapPlan,
  cleanTreeManifest,
  replanBootstrap,
  reviewBootstrapPlan,
} from "../helpers/bootstrap-plan.ts";
import {
  type Operation,
  type PreparedBootstrapRun,
  ownerApprovalFor,
  prepareBootstrapRun,
  writesOf,
} from "../helpers/bootstrap-runner.ts";
import {
  type ChannelKey,
  type StoringRelay,
  channelKey,
  steppedClock,
  storingRelay,
  writeSubscriberConfig,
} from "../helpers/buzz-mention-relay.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { TEST_OWNER, dispatchBootstrapRun, ownerDecisionReceipt } from "../helpers/harness.ts";
import { OWNER_DECISION_WRITE_DENIED, writeOutsideTheGuard } from "../helpers/released-v47-schema.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * #246 T3 (CEO 1791605114; amendments CEO 1791605708) — the owner approves a bootstrap run's GitHub
 * writes with one Buzz reply whose Nostr signature ACP verifies itself, and C3 consumes the receipt
 * as it consumes a CLI one.
 *
 * Every witness drives the daemon's own composition over a real control plane: the bootstrap run is
 * reviewed to CEO review through the real `plan_submit` and pipeline, the repo-factory CTO's identity
 * X is admitted on a live PRIMARY_CTO binding, the subscriber and its sink are the daemon's, the relay
 * is the in-process storing one, and GitHub is the bare-repository double. Keys are real `nostr-tools`
 * keys generated per test. Nothing here touches a live relay, daemon, Keychain or GitHub.
 *
 * The approval module is loaded dynamically and the composition through a namespace, so this file
 * still loads on the head before this change and each witness fails there on its own assertion.
 */

const SECRET = "buzz-owner-approval-secret";
const ROOM_X = "room-repo-factory";
/**
 * The repo-factory project as the operator names it on `ACP_REPO_FACTORY_PROJECT_ID`: a project id
 * of the shape the live registry issues (`prj_` and 24 lowercase hex), never the word "repo-factory".
 * The fixture used to register the project under the literal id `repo-factory`, which is the one id
 * the daemon looked up and the one id no real deployment has.
 */
const REPO_FACTORY_PROJECT = "prj_5e1f0c2a9b7d4e3f8a6c1b2d";
const COMMITLORE_PROJECT = "commitlore";
const ROOM_Y = "room-commitlore";
const ROOM_OTHER = "room-elsewhere";
const PROMPT_HEADER = "ACP OWNER APPROVAL REQUEST";
const SECOND_CONTRACT = {
  goal: "bootstrap a second project",
  why: "a second prompt beside the first",
  scope: [],
  nonGoals: [],
  acceptance: ["verify"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};

type ApprovalModule = typeof ApprovalModuleNamespace;
const loadApprovalModule = async (): Promise<ApprovalModule | null> => {
  try {
    return await import("../../src/buzz/buzz-owner-approval.ts");
  } catch {
    return null;
  }
};

const composition = daemonComposition as unknown as Partial<{
  createDaemonBuzzOwnerApprovals: typeof daemonComposition.createDaemonBuzzOwnerApprovals;
  attachDaemonBuzzOwnerApprovals: typeof daemonComposition.attachDaemonBuzzOwnerApprovals;
}>;

const secondsOf = (ms: number): number => Math.floor(ms / 1000);

interface Keys {
  x: ChannelKey;
  y: ChannelKey;
  owner: ChannelKey;
  stranger: ChannelKey;
  ceo: ChannelKey;
}

interface World {
  prepared: PreparedBootstrapRun;
  keys: Keys;
  relay: StoringRelay;
  approvals: BuzzOwnerApprovals | null;
  module: ApprovalModule | null;
  ctoSessions: { x: string; y: string | null };
  subscriber: ReturnType<typeof startDaemonBuzzMentionSubscriber>;
  ingress: Awaited<ReturnType<typeof startBuzzMessageIngressListener>>;
  secret: string;
  tick(): Promise<void>;
  drain(): Promise<void>;
  /** The prompts the relay received from X, in order. */
  publishedPrompts(): BuzzMentionEvent[];
  /** The outcome replies the relay received. */
  publishedOutcomes(): BuzzMentionEvent[];
  promptCode(prompt: BuzzMentionEvent): string;
  reply(input: {
    author?: ChannelKey;
    prompt?: BuzzMentionEvent | null;
    content?: string;
    room?: string;
    tags?: string[][];
    mention?: string | null;
    createdAt?: number;
  }): BuzzMentionEvent;
  send(event: BuzzMentionEvent): Promise<void>;
  counts(): Counts;
  confirm(): ReturnType<PreparedBootstrapRun["runner"]["produceAndActivateApproved"]>;
  close(): Promise<void>;
}

interface Counts {
  prompts: number;
  answers: number;
  receipts: number;
  artifacts: number;
  consumptions: number;
  githubCalls: number;
  deliveries: number;
  admittedMessages: number;
  refusalRows: number;
}

/** A READY session answering in `room` and speaking as `key`. */
const liveSession = (prepared: PreparedBootstrapRun, key: ChannelKey, room: string): string => {
  const { cp } = prepared.harness;
  const session = cp.sessions.create({ provider: "scripted", model: "cto", buzzAddress: room });
  expect(cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").reasonCode).toBe(ReasonCode.OK);
  const bound = cp.sessions.bindBuzzActor(
    { sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: key.pubkey },
    { isAllowedActor: () => true },
  );
  if (!bound.allowed) throw new Error(`channel identity binding failed: ${bound.message}`);
  return session.sessionId;
};

const bindPrimaryCto = (prepared: PreparedBootstrapRun, projectId: string, key: ChannelKey, room: string): string => {
  const { cp } = prepared.harness;
  cp.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [projectId, projectId, cp.clock.nowIso()]);
  const sessionId = liveSession(prepared, key, room);
  const bound = cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId, projectId });
  if (!bound.allowed) throw new Error(`binding ${projectId} failed: ${bound.message}`);
  return sessionId;
};

const startWorld = async (
  options: {
    projectId?: string;
    xRooms?: readonly string[];
    withY?: boolean;
    /** The project X is PRIMARY_CTO of; the configured repo-factory project unless a case moves it. */
    xProjectId?: string;
    /** The project Y is PRIMARY_CTO of, when `withY`. */
    yProjectId?: string;
    /** `ACP_REPO_FACTORY_PROJECT_ID` as configured; `null` leaves it unset. */
    repoFactoryProjectId?: string | null;
    runner?: (real: BuzzOwnerApprovalRunnerPort) => BuzzOwnerApprovalRunnerPort;
    identity?: (keys: Keys) => string | undefined;
    /** S10 — the human-gate items the run's contract declares. */
    humanGate?: readonly string[];
  } = {},
): Promise<World> => {
  const dir = tempDir("acp-oa-");
  chmodSync(dir, 0o700);
  const keys: Keys = {
    x: channelKey(dir, "repo-factory.key"),
    y: channelKey(dir, "commitlore.key"),
    owner: channelKey(dir, "owner.key"),
    stranger: channelKey(dir, "stranger.key"),
    ceo: channelKey(dir, "ceo.key"),
  };
  const projectId = options.projectId ?? "oa-fixture";
  const prepared = await prepareBootstrapRun(projectId, {
    ops: bootstrapOperations() as Operation[],
    manifest: cleanTreeManifest(projectId),
    ownerIdentities: [TEST_OWNER, { channel: "buzz", actor: keys.owner.pubkey }],
    ...(options.humanGate === undefined ? {} : { humanGate: options.humanGate }),
  });
  const { cp } = prepared.harness;
  // The CEO speaks on Buzz as its own key, so its marker-carrying mention is a peer's, not the owner's.
  cp.db.run(`UPDATE sessions SET buzz_actor_id = ? WHERE session_id = ?`, [keys.ceo.pubkey, prepared.ceoSessionId]);
  const xSession = bindPrimaryCto(prepared, options.xProjectId ?? REPO_FACTORY_PROJECT, keys.x, ROOM_X);
  const ySession = options.withY ? bindPrimaryCto(prepared, options.yProjectId ?? COMMITLORE_PROJECT, keys.y, ROOM_Y) : null;
  const repoFactoryProjectId = options.repoFactoryProjectId === undefined ? REPO_FACTORY_PROJECT : options.repoFactoryProjectId;
  writeSubscriberConfig(dir, [
    { keyFile: keys.x.keyFile, rooms: options.xRooms ?? [ROOM_X] },
    ...(options.withY ? [{ keyFile: keys.y.keyFile, rooms: [ROOM_Y] }] : []),
  ]);
  const policy = { allowedActors: [keys.owner.pubkey, keys.ceo.pubkey], secret: SECRET };
  const ingress = await startBuzzMessageIngressListener(cp, dir, policy, {
    ceoConversation: new CeoConversationPort(),
    ownerActors: [keys.owner.pubkey],
  });
  const relay = storingRelay({ acceptPublishes: true });
  const clock = steppedClock(secondsOf(cp.clock.now().getTime()));
  const module = await loadApprovalModule();
  const approvals =
    composition.createDaemonBuzzOwnerApprovals?.(cp, {
      environment: {
        ACP_OWNER_APPROVAL_BUZZ_IDENTITY: options.identity ? options.identity(keys) : keys.x.pubkey,
        ...(repoFactoryProjectId === null ? {} : { ACP_REPO_FACTORY_PROJECT_ID: repoFactoryProjectId }),
      },
      ownerActors: [keys.owner.pubkey],
      policy,
      runner: options.runner ? options.runner(prepared.runner) : prepared.runner,
    }) ?? null;
  const subscriber = startDaemonBuzzMentionSubscriber(cp, dir, policy, ingress, {
    openSocket: relay.factory,
    scheduler: clock.scheduler,
    reportAdmission: () => undefined,
    ...(approvals === null ? {} : { ownerApprovals: approvals }),
  });
  if (approvals !== null) composition.attachDaemonBuzzOwnerApprovals?.(approvals, subscriber);
  const drain = (): Promise<void> => relay.drain(subscriber);
  await drain();

  const published = (header: string): BuzzMentionEvent[] => relay.published.filter((event) => event.content.startsWith(header));
  const count = (sql: string, params: unknown[] = []): number => cp.db.get<{ n: number }>(sql, params)?.n ?? 0;
  const world: World = {
    prepared,
    keys,
    relay,
    approvals,
    module,
    ctoSessions: { x: xSession, y: ySession },
    subscriber,
    ingress,
    secret: SECRET,
    tick: async () => {
      await approvals?.tick();
      await drain();
    },
    drain,
    publishedPrompts: () => published(PROMPT_HEADER),
    publishedOutcomes: () => published("ACP OWNER DECISION RECORDED"),
    promptCode: (prompt) => /acp-approve-write:([0-9a-f]{16})/.exec(prompt.content)?.[1] ?? "0000000000000000",
    reply: (input) => {
      const prompt = input.prompt === undefined ? world.publishedPrompts().at(-1) ?? null : input.prompt;
      const room = input.room ?? ROOM_X;
      const tags =
        input.tags ??
        [
          ["h", room],
          ...(prompt === null ? [] : [["e", prompt.id, "", "reply"]]),
          ...(input.mention === null ? [] : [["p", input.mention ?? keys.x.pubkey]]),
        ];
      return finalizeEvent(
        {
          kind: 9,
          created_at: input.createdAt ?? secondsOf(cp.clock.now().getTime()),
          tags,
          content: input.content ?? `acp-approve-write:${prompt === null ? "0000000000000000" : world.promptCode(prompt)}`,
        },
        (input.author ?? keys.owner).secretKey,
      ) as BuzzMentionEvent;
    },
    send: async (event) => {
      relay.publish(event);
      await drain();
    },
    counts: () => ({
      prompts: world.publishedPrompts().length,
      answers: count(`SELECT COUNT(*) AS n FROM inbound_messages WHERE channel = 'buzz-owner-approval-answer' AND json_extract(payload_json, '$.state') = 'ANSWERED'`),
      receipts: count(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'OWNER_APPROVAL_INGRESS' AND actor LIKE 'buzz:%'`),
      artifacts: cp.artifacts
        .list<Record<string, unknown>>(prepared.runId, "APPROVAL")
        .filter((artifact) => artifact.content["kind"] === "REPO_FACTORY_GITHUB_WRITE").length,
      consumptions: count(`SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'OWNER_APPROVAL_CONSUMED' AND run_id = ?`, [prepared.runId]),
      githubCalls: prepared.github.writes.length,
      deliveries: count(`SELECT COUNT(*) AS n FROM outbox WHERE kind IN (?, ?)`, [MessageKind.OWNER_MESSAGE, MessageKind.PEER_MESSAGE]),
      admittedMessages: count(`SELECT COUNT(*) AS n FROM inbound_messages WHERE channel = 'buzz' AND nonce LIKE 'buzz-message:%'`),
      refusalRows: count(`SELECT COUNT(*) AS n FROM inbound_messages WHERE channel = 'buzz-owner-approval-refusal'`),
    }),
    confirm: async () => {
      await cp.continuity.evaluate("bootstrap confirmation");
      return prepared.runner.produceAndActivateApproved({
        runId: prepared.runId,
        candidateSnapshotDigest: prepared.snapshotDigest,
        ceoSessionId: prepared.ceoSessionId,
      });
    },
    close: async () => {
      approvals?.close();
      subscriber.close();
      await ingress.close();
      cp.close();
    },
  };
  return world;
};

/** The world with its first prompt posted, and that prompt. */
const promptedWorld = async (options: Parameters<typeof startWorld>[0] = {}): Promise<{ w: World; prompt: BuzzMentionEvent }> => {
  const w = await startWorld(options);
  await w.tick();
  const prompt = w.publishedPrompts().at(-1);
  expect(prompt, "a prompt is published for the run at CEO review").toBeDefined();
  return { w, prompt: prompt! };
};

const NOTHING_MINTED = { answers: 0, receipts: 0, artifacts: 0, consumptions: 0, githubCalls: 0, deliveries: 0, admittedMessages: 0 };

describe("W1: normal approval, end to end — prompt → reply → receipt → C3 consumption", () => {
  it("publishes one prompt, mints one receipt from the reply, and C3 consumes it once and writes each operation once", async () => {
    const w = await startWorld();
    try {
      const { cp } = w.prepared.harness;
      expect(cp.runs.require(w.prepared.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      expect(cp.runs.currentCandidate(w.prepared.runId)).toBe(w.prepared.snapshotDigest);

      // Ticks 1–3: one prompt, signed by X, in X's room, binding exactly the run's scope.
      await w.tick();
      await w.tick();
      await w.tick();
      expect(w.counts().prompts).toBe(1);
      const prompt = w.publishedPrompts()[0]!;
      expect(prompt.pubkey).toBe(w.keys.x.pubkey);
      expect(prompt.tags).toEqual([["h", ROOM_X], ["p", w.keys.owner.pubkey]]);
      const scope = w.prepared.runner.approvalScopeOf(w.prepared.runId);
      if (!scope.allowed) throw new Error(scope.message);
      for (const field of [
        w.prepared.runId,
        "repository: github:acme/fixture",
        "visibility: public",
        "github owner: acme",
        `plan: ${scope.value.planDigest}`,
        `operations: ${scope.value.operationsDigest} (4)`,
        `scope: ${scope.value.parameterDigest}`,
      ]) {
        expect(prompt.content).toContain(field);
      }
      expect(scope.value.planDigest).toBe(w.prepared.planDigest);
      // The prompt row holds the identical signed event, stored before it was sent.
      const stored = cp.db.get<{ payload_json: string; received_at: string }>(
        `SELECT payload_json, received_at FROM inbound_messages WHERE channel = 'buzz-owner-approval-prompt' AND nonce = ?`,
        [prompt.id],
      );
      expect(JSON.parse(stored!.payload_json).event).toEqual(prompt);
      expect(w.counts()).toMatchObject({ ...NOTHING_MINTED });

      // The owner's reply: one answer, one receipt, one artifact, one outcome, no delivery.
      const reply = w.reply({});
      await w.send(reply);
      expect(w.counts()).toMatchObject({ prompts: 1, answers: 1, receipts: 1, artifacts: 1, consumptions: 0, githubCalls: 0, deliveries: 0, admittedMessages: 0 });
      const artifact = cp.artifacts.list<Record<string, unknown>>(w.prepared.runId, "APPROVAL").at(-1)!;
      expect(Object.keys(artifact.content).sort()).toEqual(["approvedManifest", "kind", "owner", "planDigest", "projectName", "receipt", "visibility"]);
      expect(artifact.content["receipt"]).toEqual({
        channel: "buzz",
        actor: w.keys.owner.pubkey,
        inboundNonce: `buzz-approval:${reply.id}`,
        runId: w.prepared.runId,
        candidateSnapshotDigest: w.prepared.snapshotDigest,
        operation: "repo_factory_github_write",
        parameterDigest: scope.value.parameterDigest,
        idempotencyKey: `buzz:repo-factory-github-write:${prompt.id}`,
        approved: true,
      });
      await w.tick();
      expect(w.publishedOutcomes()).toHaveLength(1);
      expect(w.publishedOutcomes()[0]!.tags).toEqual([["h", ROOM_X], ["e", reply.id, "", "reply"]]);
      expect(w.publishedOutcomes()[0]!.content).toContain("Approval receipt issued. GitHub execution has not started");

      // The CEO's CONFIRM through C3: consumed once, anchored on the Buzz receipt, each write once.
      const first = await w.confirm();
      expect(first.reasonCode, JSON.stringify(first)).toBe(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE);
      expect(writesOf(w.prepared.github)).toEqual(["createRepository", "pushBranch", "setDefaultBranch", "protectBranch"]);
      expect(w.counts()).toMatchObject({ consumptions: 1, githubCalls: 4 });
      const application = cp.bootstrapApplications.get(w.prepared.runId);
      expect(application?.phase).toBe("WRITTEN");

      // The relay redelivers the approval event, and the CEO re-CONFIRMs: nothing new.
      await w.send(reply);
      await w.tick();
      const again = await w.confirm();
      expect(again.reasonCode, JSON.stringify(again)).toBe(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE);
      expect(w.counts()).toMatchObject({ prompts: 1, answers: 1, receipts: 1, artifacts: 1, consumptions: 1, githubCalls: 4, deliveries: 0 });
      expect(w.publishedOutcomes()).toHaveLength(1);

      // Activation completes on the anchor: the handoff acknowledged, the CONFIRM, COMPLETED.
      const primary = cp.bindings.activePrimaryCto(w.prepared.manifest.projectId);
      expect(cp.bootstrap.acknowledgeActivationHandoff(first.evidence["pendingHandoffId"] as string, primary!.sessionId).allowed).toBe(true);
      const activated = await w.confirm();
      expect(activated.allowed, JSON.stringify(activated)).toBe(true);
      const confirmed = cp.ceo.submitCeoDecision({
        runId: w.prepared.runId,
        decision: "CONFIRM",
        candidateSnapshotDigest: w.prepared.snapshotDigest,
        ceoSessionId: w.prepared.ceoSessionId,
        rationale: "apply the bootstrap",
      });
      expect(confirmed.allowed, JSON.stringify(confirmed)).toBe(true);
      expect(cp.runs.require(w.prepared.runId).state).toBe(RunState.COMPLETED);
      expect(w.counts()).toMatchObject({ consumptions: 1, githubCalls: 4, deliveries: 0 });
    } finally {
      await w.close();
    }
  });
});


/** Runs `receive` on the store directly, as both of its routes do. */
const receiveDirect = (w: World, event: BuzzMentionEvent, identityPubkey = w.keys.x.pubkey, conversation = ROOM_X) =>
  w.approvals!.receive({ identityPubkey, conversation, event });

/** A seam envelope as the local relay socket presents one: the relay's actor, its HMAC, the event's text. */
const seamEnvelope = (w: World, input: { actor: string; text: string; addressedTo: string; mention?: string; conversation: string }) => {
  const envelope = {
    actor: input.actor,
    conversation: input.conversation,
    eventId: sha256Hex(`${input.actor}:${input.text}:${input.conversation}`),
    addressedTo: input.addressedTo,
    ...(input.mention === undefined ? {} : { mention: input.mention }),
    text: input.text,
  };
  return { ...envelope, signature: ingressSignature(w.secret, buzzMessageSigningRequest(envelope)) };
};

describe("W1b: the reply filter does not depend on a mention (CEO 1791605708)", () => {
  it("receives an owner reply that tags no one by the stored prompt's exact reference, and mints once", async () => {
    const { w } = await promptedWorld();
    try {
      const reply = w.reply({ mention: null });
      expect(reply.tags.some((tag) => tag[0] === "p")).toBe(false);
      await w.send(reply);
      expect(w.counts()).toMatchObject({ answers: 1, receipts: 1, artifacts: 1, deliveries: 0, admittedMessages: 0 });
      // The filter was a REQ on X's own connection, by the prompt's id, in X's rooms only.
      const asked = w.relay.requested.map((request) => request.filter).filter((filter) => Array.isArray(filter["#e"]));
      expect(asked.length).toBeGreaterThan(0);
      expect(asked[0]).toMatchObject({ kinds: [9], "#e": [w.publishedPrompts()[0]!.id], "#h": [ROOM_X] });
      expect(asked[0]!["#p"]).toBeUndefined();
    } finally {
      await w.close();
    }
  });

  it("asks for nothing once the prompt is answered: the filter is closed", async () => {
    const { w } = await promptedWorld();
    try {
      await w.send(w.reply({ mention: null }));
      await w.tick();
      expect(w.approvals!.replyFilter(w.keys.x.pubkey)).toBeNull();
      const open = w.relay.openFor(w.keys.x.pubkey)[0]!;
      expect([...open.subscriptions.values()].some((filter) => Array.isArray(filter["#e"]))).toBe(false);
    } finally {
      await w.close();
    }
  });
});

describe("W2: wrong key", () => {
  it("refuses a stranger's otherwise valid approval with nothing durable written", async () => {
    const { w } = await promptedWorld();
    try {
      const stranger = w.reply({ author: w.keys.stranger });
      await w.send(stranger);
      expect(w.counts()).toMatchObject({ ...NOTHING_MINTED, refusalRows: 0 });
      expect(receiveDirect(w, stranger)).toMatchObject({ allowed: false, reasonCode: ReasonCode.BUZZ_APPROVAL_NOT_OWNER });
      expect(w.approvals!.health().strangerRefusals).toBeGreaterThan(0);
    } finally {
      await w.close();
    }
  });

  it("refuses the CEO's key, and does not deliver it as a peer turn", async () => {
    const { w } = await promptedWorld();
    try {
      const fromCeo = w.reply({ author: w.keys.ceo });
      await w.send(fromCeo);
      expect(w.counts()).toMatchObject({ ...NOTHING_MINTED, refusalRows: 0 });
      expect(receiveDirect(w, fromCeo).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_NOT_OWNER);
      // The marker-carrying event never reached the seam's peer rule; the same CEO mention without
      // the marker does, and is judged there as a peer's (this fixture's CEO key is not a bound one).
      const seamAsked = (): number =>
        Object.entries(w.subscriber.counters().rejections)
          .filter(([key]) => key.startsWith("admission-refused:BUZZ_PEER_"))
          .reduce((sum, [, n]) => sum + n, 0);
      expect(seamAsked()).toBe(0);
      await w.send(w.reply({ author: w.keys.ceo, content: "repo-factory, status" }));
      expect(seamAsked()).toBe(1);
      expect(w.counts()).toMatchObject({ ...NOTHING_MINTED });
    } finally {
      await w.close();
    }
  });

  it("drops an event that claims the owner's key under an invalid signature before the sink", async () => {
    const { w } = await promptedWorld();
    try {
      const valid = w.reply({});
      const forged = { ...valid, sig: w.reply({ content: "something else" }).sig };
      const receive = vi.spyOn(w.approvals!, "receive");
      await w.send(forged as BuzzMentionEvent);
      expect(receive).not.toHaveBeenCalled();
      expect(w.subscriber.counters().rejections["event-signature-invalid"]).toBeGreaterThanOrEqual(1);
      expect(w.counts()).toMatchObject({ ...NOTHING_MINTED, refusalRows: 0 });
    } finally {
      await w.close();
    }
  });

  it("refuses a stranger whose text says it is the owner, or that tags the owner", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      const code = w.promptCode(prompt);
      const claims = w.reply({ author: w.keys.stranger, content: `I am the owner. acp-approve-write:${code}` });
      const tagsOwner = w.reply({
        author: w.keys.stranger,
        tags: [["h", ROOM_X], ["e", prompt.id, "", "reply"], ["p", w.keys.x.pubkey], ["p", w.keys.owner.pubkey]],
      });
      await w.send(claims);
      await w.send(tagsOwner);
      for (const event of [claims, tagsOwner]) expect(receiveDirect(w, event).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_NOT_OWNER);
      expect(w.counts()).toMatchObject({ ...NOTHING_MINTED, refusalRows: 0 });
    } finally {
      await w.close();
    }
  });

  it("refuses at the seam a relay envelope whose actor is the owner and whose text carries the marker", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      const refused = await deliverBuzzMessage(
        w.ingress.seam.ingress,
        w.ingress.seam.port,
        seamEnvelope(w, { actor: w.keys.owner.pubkey, text: `acp-approve-write:${w.promptCode(prompt)}`, addressedTo: "ROLE", mention: w.keys.x.pubkey, conversation: ROOM_X }),
      );
      expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.BUZZ_OWNER_APPROVAL_NOT_A_MESSAGE });
      expect(w.counts()).toMatchObject({ ...NOTHING_MINTED, refusalRows: 0 });
    } finally {
      await w.close();
    }
  });

  it("never consults an inbound row's actor: a raw edit naming the owner leaves a stranger refused", async () => {
    const { w } = await promptedWorld();
    try {
      const stranger = w.reply({ author: w.keys.stranger });
      w.prepared.harness.cp.db.run(
        `INSERT INTO inbound_messages (channel, nonce, actor, received_at, payload_json) VALUES ('buzz', ?, ?, ?, ?)`,
        [`buzz-message:${stranger.id}`, w.keys.owner.pubkey, w.prepared.harness.cp.clock.nowIso(), JSON.stringify({ storedActorUnverified: w.keys.owner.pubkey })],
      );
      const receive = vi.spyOn(w.approvals!, "receive");
      await w.send(stranger);
      expect(receive).toHaveBeenCalled();
      for (const [request] of receive.mock.calls) expect(Object.keys(request).sort()).toEqual(["conversation", "event", "identityPubkey"]);
      expect(receiveDirect(w, stranger).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_NOT_OWNER);
      expect(w.counts()).toMatchObject({ answers: 0, receipts: 0, artifacts: 0, deliveries: 0 });
    } finally {
      await w.close();
    }
  });
});

describe("W3: wrong room", () => {
  it("refuses the owner's reply in another of X's rooms", async () => {
    const { w } = await promptedWorld({ xRooms: [ROOM_X, ROOM_OTHER] });
    try {
      const elsewhere = w.reply({ room: ROOM_OTHER });
      await w.send(elsewhere);
      expect(w.counts()).toMatchObject({ ...NOTHING_MINTED, refusalRows: 1 });
      expect(receiveDirect(w, elsewhere, w.keys.x.pubkey, ROOM_OTHER).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_PROMPT_WRONG_ROOM);
    } finally {
      await w.close();
    }
  });

  it("refuses the owner's reply received by a second identity in its own room", async () => {
    const { w } = await promptedWorld({ withY: true });
    try {
      const toY = w.reply({ room: ROOM_Y, mention: w.keys.y.pubkey });
      await w.send(toY);
      expect(w.counts()).toMatchObject({ ...NOTHING_MINTED, refusalRows: 1 });
      expect(receiveDirect(w, toY, w.keys.y.pubkey, ROOM_Y).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_PROMPT_WRONG_ROOM);
    } finally {
      await w.close();
    }
  });
});

describe("W4: wrong prompt", () => {
  it("refuses a reply to prompt A carrying prompt B's code", async () => {
    const { w, prompt: promptA } = await promptedWorld();
    try {
      const { cp } = w.prepared.harness;
      const created = cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: ExecutionMode.STANDARD, contract: SECOND_CONTRACT });
      if (!created.allowed) throw new Error(created.message);
      await dispatchBootstrapRun(cp, w.prepared.harness.clock, created.value.runId);
      await reviewBootstrapPlan(w.prepared.harness, created.value.runId, bootstrapPlan(cleanTreeManifest("oa-second")));
      await w.tick();
      const prompts = w.publishedPrompts();
      expect(prompts).toHaveLength(2);
      const promptB = prompts.find((one) => one.id !== promptA.id)!;
      expect(promptB.content).toContain(created.value.runId);
      const crossed = w.reply({ prompt: promptA, content: `acp-approve-write:${w.promptCode(promptB)}` });
      await w.send(crossed);
      expect(w.counts()).toMatchObject({ answers: 0, receipts: 0, artifacts: 0, deliveries: 0, refusalRows: 1 });
      expect(cp.db.get<{ payload_json: string }>(
        `SELECT payload_json FROM inbound_messages WHERE channel = 'buzz-owner-approval-refusal' AND nonce = ?`, [crossed.id],
      )?.payload_json).toContain(ReasonCode.BUZZ_APPROVAL_PROMPT_CODE_MISMATCH);
    } finally {
      await w.close();
    }
  });

  // S10 (CEO c07863f8): a different thread alone is no reason to refuse, so a bare code under no
  // stored prompt is matched by its code (see the S10 witnesses). What stays refused is a token that
  // neither replies to a stored prompt nor stands alone as the code of exactly one.
  it("refuses a token with no reply reference, or one naming an event that is not a prompt, unless it is a bare code of one prompt", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      const code = w.promptCode(prompt);
      const noReference = w.reply({ prompt: null, content: `approve: acp-approve-write:${code}` });
      const notAPrompt = w.reply({ tags: [["h", ROOM_X], ["e", "f".repeat(64), "", "reply"], ["p", w.keys.x.pubkey]], content: `acp-approve-write:${"0".repeat(16)}` });
      const rootAndReply = w.reply({
        tags: [["h", ROOM_X], ["e", prompt.id, "", "root"], ["e", "e".repeat(64), "", "reply"], ["p", w.keys.x.pubkey]],
        content: `acp-approve-write:${code} thanks`,
      });
      for (const event of [noReference, notAPrompt, rootAndReply]) {
        await w.send(event);
        expect(receiveDirect(w, event).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_PROMPT_UNRESOLVED);
      }
      expect(w.counts()).toMatchObject({ ...NOTHING_MINTED, refusalRows: 3 });
    } finally {
      await w.close();
    }
  });
});

describe("W5: scope change between the prompt and the reply", () => {
  const changes: Array<[string, (manifest: ProjectManifest) => { manifest: ProjectManifest; operations: Operation[]; summary?: string }, string]> = [
    ["the PLAN", (manifest) => ({ manifest, operations: bootstrapOperations() as Operation[], summary: "a revised plan" }), "planDigest"],
    [
      "an operation's desired state",
      (manifest) => ({ manifest, operations: bootstrapOperations({ ...APPROVED_PROTECTION, requiredApprovingReviewCount: 2 }) as Operation[] }),
      "operationsDigest",
    ],
    [
      "the repository's name",
      (manifest) => ({
        manifest: { ...manifest, repositories: [{ role: "primary", remote: "github:acme/renamed", manifestRoot: "." }] },
        operations: bootstrapOperations(APPROVED_PROTECTION, "github:acme/renamed") as Operation[],
      }),
      "repositoryIdentity",
    ],
    [
      "the repository's visibility",
      (manifest) => ({
        manifest,
        operations: (bootstrapOperations() as Operation[]).map((operation) =>
          operation.resourceType === "repository" ? { ...operation, desiredState: { visibility: "private" } } : operation,
        ),
      }),
      "visibility",
    ],
  ];

  it.each(changes)("%s: the reply is PROMPT_STALE naming the field; the next tick cancels it and prompts once for the new scope", async (_name, change, field) => {
    const { w, prompt } = await promptedWorld();
    try {
      const { harness } = w.prepared;
      const changed = change(w.prepared.manifest);
      await replanBootstrap(
        harness,
        w.prepared.runId,
        { planDigest: w.prepared.planDigest, snapshotDigest: w.prepared.snapshotDigest, ceoSessionId: w.prepared.ceoSessionId },
        bootstrapPlan(changed.manifest, { operations: changed.operations, ...(changed.summary === undefined ? {} : { summary: changed.summary }) }),
      );
      const late = w.reply({ prompt });
      const refused = receiveDirect(w, late);
      expect(refused, JSON.stringify(refused)).toMatchObject({ allowed: false, reasonCode: ReasonCode.BUZZ_APPROVAL_PROMPT_STALE, evidence: { field } });
      expect(w.counts()).toMatchObject({ ...NOTHING_MINTED, refusalRows: 1 });

      await w.tick();
      expect(w.counts().prompts).toBe(2);
      const answer = harness.cp.db.get<{ payload_json: string }>(
        `SELECT payload_json FROM inbound_messages WHERE channel = 'buzz-owner-approval-answer' AND nonce = ?`, [prompt.id],
      );
      expect(JSON.parse(answer!.payload_json)).toMatchObject({ state: "CANCELLED" });
      const later = w.reply({ prompt, createdAt: late.created_at + 1 });
      expect(receiveDirect(w, later).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_PROMPT_CANCELLED);
      await w.tick();
      expect(w.counts()).toMatchObject({ prompts: 2, answers: 0, receipts: 0, artifacts: 0, deliveries: 0 });
    } finally {
      await w.close();
    }
  });

  it("the candidate pointer: a bootstrap candidate moves only with its PLAN, so a pointer moved by a raw edit is PROMPT_STALE and prompts nothing new", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      const { cp } = w.prepared.harness;
      cp.db.run(`UPDATE runs SET current_candidate_digest = ? WHERE run_id = ?`, [`sha256:${"9".repeat(64)}`, w.prepared.runId]);
      const late = w.reply({ prompt });
      expect(receiveDirect(w, late)).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.BUZZ_APPROVAL_PROMPT_STALE,
        evidence: { field: "candidateSnapshotDigest" },
      });
      await w.tick();
      // No passing review of the moved candidate exists, so nothing awaits the owner's decision.
      expect(w.counts()).toMatchObject({ prompts: 1, ...NOTHING_MINTED, refusalRows: 1 });
      expect(receiveDirect(w, w.reply({ prompt, createdAt: late.created_at + 1 })).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_PROMPT_CANCELLED);
    } finally {
      await w.close();
    }
  });
});

describe("W6: expiry and cancellation", () => {
  it("refuses an approval signed after the stored expiry", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      w.prepared.harness.clock.advance(25 * 60 * 60 * 1000);
      const late = w.reply({ prompt });
      expect(receiveDirect(w, late).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_PROMPT_EXPIRED);
      expect(w.counts()).toMatchObject({ ...NOTHING_MINTED, refusalRows: 1 });
    } finally {
      await w.close();
    }
  });

  it("O3: refuses an approval signed inside the window and delivered after it, judged on the stored expiry", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      const inside = w.reply({ prompt });
      w.prepared.harness.clock.advance(25 * 60 * 60 * 1000);
      expect(receiveDirect(w, inside).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_PROMPT_EXPIRED);
      // A backdated reply cannot pass by its signed time either.
      const backdated = w.reply({ prompt, createdAt: prompt.created_at + 10 });
      expect(receiveDirect(w, backdated).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_PROMPT_EXPIRED);
      expect(w.counts()).toMatchObject({ ...NOTHING_MINTED });
    } finally {
      await w.close();
    }
  });

  it("O3: refuses at consumption an approval whose prompt's stored window has closed, with nothing consumed or written", async () => {
    const { w } = await promptedWorld();
    try {
      await w.send(w.reply({}));
      expect(w.counts()).toMatchObject({ answers: 1, receipts: 1, artifacts: 1 });
      w.prepared.harness.clock.advance(25 * 60 * 60 * 1000);
      const refused = await w.confirm();
      expect(refused, JSON.stringify(refused)).toMatchObject({ allowed: false, evidence: { refusal: "APPROVAL_EXPIRED" } });
      expect(w.counts()).toMatchObject({ consumptions: 0, githubCalls: 0 });
      // A duplicate approval does not extend the window, and the receipt still cannot be consumed.
      expect(receiveDirect(w, w.reply({})).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_PROMPT_EXPIRED);
      expect(await w.confirm()).toMatchObject({ allowed: false, evidence: { refusal: "APPROVAL_EXPIRED" } });
      expect(w.counts()).toMatchObject({ answers: 1, receipts: 1, artifacts: 1, consumptions: 0, githubCalls: 0 });
    } finally {
      await w.close();
    }
  });

  it("cancels the prompt of a cancelled run, and a later reply is PROMPT_CANCELLED", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      const { cp } = w.prepared.harness;
      await cp.continuity.evaluate("bootstrap revision");
      const revised = cp.ceo.submitCeoDecision({
        runId: w.prepared.runId,
        decision: "FINAL_REVISE",
        candidateSnapshotDigest: w.prepared.snapshotDigest,
        ceoSessionId: w.prepared.ceoSessionId,
        rationale: "stop this bootstrap",
      });
      expect(revised.allowed, JSON.stringify(revised)).toBe(true);
      const cancelled = cp.runs.cancel(w.prepared.runId, "owner cancelled");
      expect(cancelled.allowed, JSON.stringify(cancelled)).toBe(true);
      await w.tick();
      expect(receiveDirect(w, w.reply({ prompt })).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_PROMPT_CANCELLED);
      expect(w.counts()).toMatchObject({ ...NOTHING_MINTED });
    } finally {
      await w.close();
    }
  });

  it("O2: after expiry, ticks publish no new prompt", async () => {
    const { w } = await promptedWorld();
    try {
      w.prepared.harness.clock.advance(25 * 60 * 60 * 1000);
      await w.tick();
      await w.tick();
      expect(w.counts().prompts).toBe(1);
    } finally {
      await w.close();
    }
  });
});

describe("W7: replay", () => {
  it("answers three redeliveries and a restart's replay from the recorded answer, writing nothing", async () => {
    const { w } = await promptedWorld();
    try {
      const reply = w.reply({});
      await w.send(reply);
      for (let round = 0; round < 3; round += 1) await w.send(reply);
      const module = w.module!;
      const restarted = composition.createDaemonBuzzOwnerApprovals!(w.prepared.harness.cp, {
        environment: { ACP_OWNER_APPROVAL_BUZZ_IDENTITY: w.keys.x.pubkey, ACP_REPO_FACTORY_PROJECT_ID: REPO_FACTORY_PROJECT },
        ownerActors: [w.keys.owner.pubkey],
        policy: { allowedActors: [w.keys.owner.pubkey], secret: SECRET },
        runner: w.prepared.runner,
      });
      expect(restarted).toBeInstanceOf(module.BuzzOwnerApprovals);
      expect(restarted.receive({ identityPubkey: w.keys.x.pubkey, conversation: ROOM_X, event: reply }).reasonCode).toBe(ReasonCode.INGRESS_REPLAY_IGNORED);
      expect(w.counts()).toMatchObject({ answers: 1, receipts: 1, artifacts: 1, consumptions: 0, githubCalls: 0, deliveries: 0 });
    } finally {
      await w.close();
    }
  });

  it("sends the outcome once after a crash between the commit and the reply", async () => {
    const { w } = await promptedWorld();
    try {
      const real = w.subscriber.replies;
      // The publish half fails as a process that died before its send would: nothing reaches the relay.
      w.approvals!.attach(
        { ...real, publishApprovalPublication: () => Promise.resolve({ status: "UNAVAILABLE" as const }) },
        { admitted: () => ({ excluded: "CRASHED" }), refreshReplies: () => undefined },
      );
      const reply = w.reply({});
      expect(receiveDirect(w, reply)).toMatchObject({ allowed: true, value: { result: "MINTED" } });
      await w.drain();
      expect(w.publishedOutcomes()).toHaveLength(0);
      composition.attachDaemonBuzzOwnerApprovals!(w.approvals!, w.subscriber);
      await w.send(reply);
      await w.tick();
      await w.tick();
      expect(w.publishedOutcomes()).toHaveLength(1);
      expect(w.counts()).toMatchObject({ answers: 1, receipts: 1, artifacts: 1 });
    } finally {
      await w.close();
    }
  });

  it("rolls back a crash inside the issuance transaction to zero rows, and the redelivery mints once", async () => {
    let fail = true;
    const { w } = await promptedWorld({
      runner: (real) => ({
        approvalScopeOf: (runId) => real.approvalScopeOf(runId),
        ownerApprovalNeed: (runId, scope) => real.ownerApprovalNeed(runId, scope),
        recordOwnerApproval: (runId, record) => {
          if (fail) throw new Error("crash between the answer row and the artifact");
          return real.recordOwnerApproval(runId, record);
        },
      }),
    });
    try {
      const reply = w.reply({});
      expect(() => receiveDirect(w, reply)).toThrow(/crash between/);
      const { cp } = w.prepared.harness;
      expect(w.counts()).toMatchObject({ ...NOTHING_MINTED, refusalRows: 0 });
      expect(cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM inbound_messages WHERE channel = 'buzz' AND nonce = ?`, [`buzz-approval:${reply.id}`])!.n).toBe(0);
      fail = false;
      await w.send(reply);
      expect(w.counts()).toMatchObject({ answers: 1, receipts: 1, artifacts: 1, deliveries: 0 });
    } finally {
      await w.close();
    }
  });
});

describe("W8: duplicate approval", () => {
  it("reuses the receipt for a second, different owner approval of the same prompt", async () => {
    const { w } = await promptedWorld();
    try {
      await w.send(w.reply({}));
      const before = w.prepared.harness.cp.artifacts.list(w.prepared.runId, "APPROVAL").map((artifact) => artifact.digest);
      const second = w.reply({ createdAt: secondsOf(w.prepared.harness.cp.clock.now().getTime()) + 1 });
      expect(receiveDirect(w, second)).toMatchObject({ allowed: true, value: { result: "REUSED" } });
      await w.send(second);
      expect(w.prepared.harness.cp.artifacts.list(w.prepared.runId, "APPROVAL").map((artifact) => artifact.digest)).toEqual(before);
      expect(w.counts()).toMatchObject({ answers: 1, receipts: 1, artifacts: 1 });
    } finally {
      await w.close();
    }
  });

  it("refuses a different duplicate event after the approved prompt's scope changes", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      await w.send(w.reply({ prompt }));
      const changed = { ...w.prepared.manifest, repositories: [{ role: "primary" as const, remote: "github:acme/changed", manifestRoot: "." }] };
      await replanBootstrap(
        w.prepared.harness,
        w.prepared.runId,
        { planDigest: w.prepared.planDigest, snapshotDigest: w.prepared.snapshotDigest, ceoSessionId: w.prepared.ceoSessionId },
        bootstrapPlan(changed, { operations: bootstrapOperations(APPROVED_PROTECTION, "github:acme/changed") as Operation[] }),
      );
      const duplicate = w.reply({ prompt, createdAt: secondsOf(w.prepared.harness.cp.clock.now().getTime()) + 1 });
      expect(receiveDirect(w, duplicate)).toMatchObject({ allowed: false, reasonCode: ReasonCode.BUZZ_APPROVAL_PROMPT_STALE });
      expect(w.counts()).toMatchObject({ answers: 1, receipts: 1, artifacts: 1, consumptions: 0, githubCalls: 0 });
    } finally {
      await w.close();
    }
  });

  it("reuses the receipt during an anchored execution: no APPROVAL_SUPERSEDED, no new write", async () => {
    const { w } = await promptedWorld();
    try {
      await w.send(w.reply({}));
      const first = await w.confirm();
      expect(first.reasonCode, JSON.stringify(first)).toBe(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE);
      expect(w.counts()).toMatchObject({ consumptions: 1, githubCalls: 4 });
      const duplicate = w.reply({ createdAt: secondsOf(w.prepared.harness.cp.clock.now().getTime()) + 2 });
      await w.send(duplicate);
      expect(receiveDirect(w, duplicate)).toMatchObject({ allowed: true, value: { result: "REUSED" } });
      expect(w.counts()).toMatchObject({ artifacts: 1, receipts: 1 });
      const resumed = await w.confirm();
      expect(JSON.stringify(resumed)).not.toContain("APPROVAL_SUPERSEDED");
      expect(resumed.reasonCode, JSON.stringify(resumed)).toBe(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE);
      expect(w.counts()).toMatchObject({ consumptions: 1, githubCalls: 4, artifacts: 1 });
    } finally {
      await w.close();
    }
  });

  it("refuses a decline after an approval on the same prompt", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      await w.send(w.reply({}));
      const decline = w.reply({ content: `acp-decline-write:${w.promptCode(prompt)}`, createdAt: prompt.created_at + 3 });
      expect(receiveDirect(w, decline).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_PROMPT_ALREADY_ANSWERED);
      expect(w.counts()).toMatchObject({ answers: 1, receipts: 1, artifacts: 1 });
    } finally {
      await w.close();
    }
  });

  it("records a decline as the CLI's --decline would, and C3 refuses CONFIRM before any consumption", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      await w.send(w.reply({ content: `acp-decline-write:${w.promptCode(prompt)}` }));
      expect(w.counts()).toMatchObject({ answers: 1, receipts: 1, artifacts: 1 });
      const refused = await w.confirm();
      expect(refused).toMatchObject({ allowed: false, evidence: { refusal: "APPROVAL_DECLINED" } });
      expect(w.counts()).toMatchObject({ consumptions: 0, githubCalls: 0 });
      await w.tick();
      expect(w.publishedOutcomes().at(-1)!.content).toContain("decision: DECLINED");
      // O2: a declined scope is not prompted again by the tick.
      await w.tick();
      expect(w.counts().prompts).toBe(1);
    } finally {
      await w.close();
    }
  });
});

describe("W9: an approval event is never executed as a work message", () => {
  const variants: Array<[string, (code: string) => string]> = [
    ["the marker spelled with spaces", () => "ACP approve write"],
    ["full-width letters", (code) => `ａｃｐ-approve-write:${code}`],
    ["a zero-width joiner", (code) => `acp-approve‍-write:${code}`],
    ["acp_decline_write", () => "acp_decline_write"],
    ["two tokens", (code) => `acp-approve-write:${code} acp-approve-write:${code}`],
    ["a token beside a mangled marker", (code) => `acp-approve-write:${code} and ACP approve write`],
    ["the marker beside the bind marker", (code) => `acp-approve-write:${code} acp-buzz-bind:${"a".repeat(32)}`],
  ];

  /** The world after its tick, without requiring a prompt, so the head before this change runs the same rows. */
  const tickedWorld = async (): Promise<{ w: World; prompt: BuzzMentionEvent | null; code: string }> => {
    const w = await startWorld();
    await w.tick();
    const prompt = w.publishedPrompts().at(-1) ?? null;
    return { w, prompt, code: prompt === null ? "0123456789abcdef" : w.promptCode(prompt) };
  };

  it.each(variants)("%s: refused and never delivered", async (_name, text) => {
    const { w, prompt, code } = await tickedWorld();
    try {
      await w.send(w.reply({ prompt, content: text(code) }));
      expect(w.counts()).toMatchObject({ ...NOTHING_MINTED });
      expect(w.counts().refusalRows).toBe(1);
    } finally {
      await w.close();
    }
  });

  it("the well-formed token itself, signed by the owner, is never delivered as a message either", async () => {
    const { w, prompt, code } = await tickedWorld();
    try {
      await w.send(w.reply({ prompt, content: `acp-approve-write:${code}` }));
      expect(w.counts()).toMatchObject({ deliveries: 0, admittedMessages: 0 });
    } finally {
      await w.close();
    }
  });

  it("marker text sent to the CEO room over the relay socket is refused at the seam", async () => {
    const { w, code } = await tickedWorld();
    try {
      const refused = await deliverBuzzMessage(
        w.ingress.seam.ingress,
        w.ingress.seam.port,
        seamEnvelope(w, { actor: w.keys.owner.pubkey, text: `ACP approve write ${code}`, addressedTo: "CEO", conversation: "room-ceo" }),
      );
      expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.BUZZ_OWNER_APPROVAL_NOT_A_MESSAGE });
      expect(w.counts()).toMatchObject({ ...NOTHING_MINTED });
    } finally {
      await w.close();
    }
  });

  it("control: the same event without the marker is delivered exactly as before", async () => {
    const { w } = await tickedWorld();
    try {
      await w.send(w.reply({ content: "repo-factory, what is the plan's status?" }));
      expect(w.counts()).toMatchObject({ deliveries: 1, admittedMessages: 1, answers: 0, receipts: 0, artifacts: 0, refusalRows: 0 });
    } finally {
      await w.close();
    }
  });
});

describe("W10: the evidence is kept and checked at consumption", () => {
  const sideWrite = (w: World, sql: string, params: unknown[]): void => {
    const side = new Database(w.prepared.harness.cp.config.databasePath);
    try {
      side.exec("DROP TRIGGER IF EXISTS inbound_messages_payload_immutable");
      side.prepare(sql).run(...params);
    } finally {
      side.close();
    }
  };
  const answerPayload = (w: World, promptId: string): Record<string, unknown> =>
    JSON.parse(w.prepared.harness.cp.db.get<{ payload_json: string }>(
      `SELECT payload_json FROM inbound_messages WHERE channel = 'buzz-owner-approval-answer' AND nonce = ?`, [promptId],
    )!.payload_json) as Record<string, unknown>;

  it.each([
    ["altered content", (event: Record<string, unknown>) => ({ ...event, content: `${String(event["content"])} ` })],
    ["an invalid signature", (event: Record<string, unknown>) => ({ ...event, sig: "0".repeat(128) })],
  ] as const)("refuses CONFIRM when the stored owner event has %s", async (_name, tamper) => {
    const { w, prompt } = await promptedWorld();
    try {
      await w.send(w.reply({}));
      const payload = answerPayload(w, prompt.id);
      sideWrite(w, `UPDATE inbound_messages SET payload_json = ? WHERE channel = 'buzz-owner-approval-answer' AND nonce = ?`, [
        JSON.stringify({ ...payload, approvalEvent: tamper(payload["approvalEvent"] as Record<string, unknown>) }),
        prompt.id,
      ]);
      const refused = await w.confirm();
      expect(refused, JSON.stringify(refused)).toMatchObject({ allowed: false, evidence: { refusal: "APPROVAL_EVIDENCE_UNVERIFIED" } });
      expect(w.counts()).toMatchObject({ consumptions: 0, githubCalls: 0 });
    } finally {
      await w.close();
    }
  });

  it("refuses a receipt whose answer row is missing, whose nonce differs, or whose prompt names another scope", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      await w.send(w.reply({}));
      const payload = answerPayload(w, prompt.id);
      const receipt = payload["receipt"] as Record<string, unknown>;
      const present = (presented: Record<string, unknown>) =>
        w.prepared.runner.produceAndActivate({ ...w.prepared.input, ownerApproval: { owner: "acme", visibility: "public", receipt: presented } });
      for (const presented of [
        { ...receipt, idempotencyKey: `buzz:repo-factory-github-write:${"d".repeat(64)}` },
        { ...receipt, inboundNonce: `buzz-approval:${"c".repeat(64)}` },
      ]) {
        const refused = await present(presented);
        expect(refused, JSON.stringify(refused)).toMatchObject({ allowed: false, evidence: { refusal: "APPROVAL_EVIDENCE_UNVERIFIED" } });
      }
      const stored = JSON.parse(w.prepared.harness.cp.db.get<{ payload_json: string }>(
        `SELECT payload_json FROM inbound_messages WHERE channel = 'buzz-owner-approval-prompt' AND nonce = ?`, [prompt.id],
      )!.payload_json) as Record<string, Record<string, unknown>>;
      sideWrite(w, `UPDATE inbound_messages SET payload_json = ? WHERE channel = 'buzz-owner-approval-prompt' AND nonce = ?`, [
        JSON.stringify({ ...stored, binding: { ...stored["binding"], parameterDigest: `sha256:${"b".repeat(64)}` } }),
        prompt.id,
      ]);
      const refused = await w.confirm();
      expect(refused, JSON.stringify(refused)).toMatchObject({ allowed: false, evidence: { refusal: "APPROVAL_EVIDENCE_UNVERIFIED" } });
      expect(w.counts()).toMatchObject({ consumptions: 0, githubCalls: 0 });
    } finally {
      await w.close();
    }
  });

  it("a raw sqlite3 connection cannot INSERT any of the four pseudo-channel rows", async () => {
    const w = await startWorld();
    try {
      const raw = new Database(w.prepared.harness.cp.config.databasePath);
      try {
        for (const channel of ["buzz-owner-approval-issue", "buzz-owner-approval-prompt", "buzz-owner-approval-answer", "buzz-owner-approval-refusal"]) {
          expect(() =>
            raw.prepare(`INSERT INTO inbound_messages (channel, nonce, actor, received_at, payload_json) VALUES (?, ?, ?, ?, ?)`)
              .run(channel, "f".repeat(64), "forger", new Date().toISOString(), "{}"),
          ).toThrow(/no such function/);
        }
      } finally {
        raw.close();
      }
    } finally {
      await w.close();
    }
  });
});

describe("W11: the channel rule is this operation's alone", () => {
  it.each(["telegram", "mcp"] as const)("refuses a repo_factory_github_write receipt on channel %s", async (channel) => {
    const w = await startWorld();
    try {
      const { harness, runId } = w.prepared;
      const parameters = repoFactoryGitHubWriteParameters({
        owner: "acme",
        visibility: "public",
        planDigest: w.prepared.planDigest,
        githubOperations: w.prepared.ops as never,
      });
      const approval = {
        runId,
        candidateSnapshotDigest: harness.cp.runs.currentCandidate(runId),
        operation: REPO_FACTORY_GITHUB_WRITE_OPERATION,
        parameters,
        idempotencyKey: `test-only:${channel}`,
        approved: true,
      };
      const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
        [channel]: { allowedActors: ["test-actor"], ...(channel === "telegram" ? { allowedConversations: ["1"] } : {}) },
      });
      const minted = guard.admitOwnerApproval(
        { channel, actor: "test-actor", conversation: "1", nonce: `test-only:${channel}`, payload: ownerApprovalPayload(approval) },
        approval,
      );
      if (!minted.allowed) throw new Error(minted.message);
      const refused = await w.prepared.runner.produceAndActivate({
        ...w.prepared.input,
        ownerApproval: { owner: "acme", visibility: "public", receipt: minted.value },
      });
      expect(refused).toMatchObject({ allowed: false, evidence: { refusal: "APPROVAL_CHANNEL_NOT_ACCEPTED" } });
      expect(w.counts()).toMatchObject({ consumptions: 0, githubCalls: 0 });
    } finally {
      await w.close();
    }
  });
});

describe("W12: the CLI path", () => {
  it("posts no prompt for a scope a recorded CLI approval satisfies", async () => {
    const w = await startWorld();
    try {
      const approval = ownerApprovalFor(w.prepared);
      const scope = w.prepared.runner.approvalScopeOf(w.prepared.runId);
      if (!scope.allowed) throw new Error(scope.message);
      expect(w.prepared.runner.recordOwnerApproval(w.prepared.runId, {
        owner: "acme",
        visibility: "public",
        planDigest: w.prepared.planDigest,
        approvedManifest: w.prepared.manifest,
        projectName: w.prepared.manifest.projectId,
        receipt: approval.receipt as never,
      }).allowed).toBe(true);
      expect(w.prepared.runner.ownerApprovalNeed(w.prepared.runId, scope.value).need).toBe("SATISFIED");
      await w.tick();
      await w.tick();
      expect(w.counts().prompts).toBe(0);
    } finally {
      await w.close();
    }
  });
});

describe("W13: the prompt is public-safe", () => {
  it("carries no path, session or incarnation id, secret or tool detail in its content or tags", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      const { cp } = w.prepared.harness;
      const text = JSON.stringify({ content: prompt.content, tags: prompt.tags });
      expect(text).not.toMatch(/(^|[\s"=:(])\/[A-Za-z]/u);
      expect(text).not.toContain("~");
      const sessions = cp.db.all<{ session_id: string; incarnation: string }>(`SELECT session_id, incarnation FROM sessions`);
      expect(sessions.length).toBeGreaterThan(2);
      for (const session of sessions) {
        expect(text).not.toContain(session.session_id);
        expect(text).not.toContain(session.incarnation);
      }
      for (const forbidden of [SECRET, w.prepared.workRoot, cp.config.databasePath, w.keys.x.keyFile, "plan_submit", "agentctl", "mcp", "PRIMARY_CTO", "claude"]) {
        expect(text).not.toContain(forbidden);
      }
    } finally {
      await w.close();
    }
  });

  it("omits a permitted free-text project ID from the public prompt", async () => {
    const privateProjectId = "/private/tmp/t3-private-owner-material";
    const { w, prompt } = await promptedWorld({ projectId: privateProjectId });
    try {
      expect(prompt.content).not.toContain(privateProjectId);
      const scope = w.prepared.runner.approvalScopeOf(w.prepared.runId);
      expect(scope.allowed).toBe(true);
      if (scope.allowed) expect(scope.value.approvedManifest.projectId).toBe(privateProjectId);
    } finally {
      await w.close();
    }
  });
});

describe("O2: the current CEO may ask for a prompt to be re-issued, and nothing else", () => {
  const admittedAs = (sessionId: string, incarnation: string) => {
    const admitted = admitRuntimeLineage(
      4242,
      { sessionId, incarnation, osPid: 4241, osProcessStartedAt: "darwin-tv:1.1" },
      { parentOf: (pid) => (pid === 4242 ? 4241 : null), startToken: () => "darwin-tv:1.1" },
      { pinnedNativeStart: () => null },
    );
    if (!admitted.allowed) throw new Error(admitted.message);
    return admitted.value.runtime;
  };

  it("re-issues after a decline, cancelling nothing answered, and refuses anyone but the current CEO", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      const { cp } = w.prepared.harness;
      await w.send(w.reply({ content: `acp-decline-write:${w.promptCode(prompt)}` }));
      const ceo = cp.sessions.require(w.prepared.ceoSessionId);
      const cto = cp.sessions.require(w.ctoSessions.x);
      expect(w.approvals!.reissue({ sessionId: ceo.sessionId, sessionIncarnation: ceo.incarnation }, w.prepared.runId).allowed).toBe(false);
      expect(w.approvals!.reissue(admittedAs(cto.sessionId, cto.incarnation), w.prepared.runId).reasonCode).toBe(ReasonCode.BINDING_GENERATION_STALE);
      const reissued = w.approvals!.reissue(admittedAs(ceo.sessionId, ceo.incarnation), w.prepared.runId);
      expect(reissued.allowed, JSON.stringify(reissued)).toBe(true);
      await w.drain();
      expect(w.counts().prompts).toBe(2);
      const second = w.publishedPrompts().at(-1)!;
      expect(w.promptCode(second)).not.toBe(w.promptCode(prompt));
      await w.send(w.reply({ prompt: second }));
      expect(w.counts()).toMatchObject({ answers: 2, receipts: 2, artifacts: 2 });
      const scope = w.prepared.runner.approvalScopeOf(w.prepared.runId);
      if (!scope.allowed) throw new Error(scope.message);
      expect(w.prepared.runner.ownerApprovalNeed(w.prepared.runId, scope.value).need).toBe("SATISFIED");
    } finally {
      await w.close();
    }
  });

  it("a re-issue cancels the previous open prompt in the same transaction", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      const { cp } = w.prepared.harness;
      const ceo = cp.sessions.require(w.prepared.ceoSessionId);
      expect(w.approvals!.reissue(admittedAs(ceo.sessionId, ceo.incarnation), w.prepared.runId).allowed).toBe(true);
      expect(receiveDirect(w, w.reply({ prompt })).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_PROMPT_CANCELLED);
    } finally {
      await w.close();
    }
  });
});

describe("O1 and O4: who posts, what is signed, and what health says", () => {
  it("posts nothing when the configured signer is another admitted project's CTO", async () => {
    const w = await startWorld({ withY: true, identity: (keys) => keys.y.pubkey });
    try {
      await w.tick();
      expect(w.counts().prompts).toBe(0);
      expect(w.approvals!.health().unavailable).toBe("REPO_FACTORY_AUTHORITY_MISMATCH");
    } finally {
      await w.close();
    }
  });

  it("posts nothing while X is not admitted, and health names why", async () => {
    const w = await startWorld();
    try {
      const { cp } = w.prepared.harness;
      expect(cp.bindings.revoke(roleKeyFor(Role.PRIMARY_CTO, { projectId: REPO_FACTORY_PROJECT }), "test revoke").allowed).toBe(true);
      w.subscriber.rejudge();
      await w.tick();
      expect(w.counts().prompts).toBe(0);
      expect(w.approvals!.health().unavailable).toMatch(/^IDENTITY_NOT_(ADMITTED|HELD|CONNECTED)/);
    } finally {
      await w.close();
    }
  });

  it("posts nothing for an approval identity that is not a key, and health says it is invalid", async () => {
    const w = await startWorld({ identity: () => "not-a-key" });
    try {
      await w.tick();
      expect(w.counts().prompts).toBe(0);
      expect(w.approvals!.health()).toMatchObject({ configured: false, unavailable: "IDENTITY_INVALID" });
    } finally {
      await w.close();
    }
  });

  it("signs and sends nothing for a publication it did not issue", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      const before = w.relay.published.length;
      const shaped = {
        basis: { kind: "OUTCOME", binding: {}, approved: true, room: ROOM_X, replyToEventId: prompt.id },
        signer: w.keys.x.pubkey,
        createdAt: prompt.created_at,
        intent: null,
        source: null,
      };
      expect(w.subscriber.replies.signApprovalPublication(shaped as never)).toBeNull();
      expect(await w.subscriber.replies.publishApprovalPublication({ ...shaped, intent: prompt } as never, 1_000)).toEqual({ status: "UNAUTHORIZED" });
      await w.drain();
      expect(w.relay.published.length).toBe(before);
    } finally {
      await w.close();
    }
  });

  it("writes the store's health into health.json beside the subscriber's counters", async () => {
    const { w } = await promptedWorld();
    try {
      const { Daemon } = await import("../../src/daemon/daemon.ts");
      const dir = tempDir("acp-oa-health-");
      const daemon = new Daemon(w.prepared.harness.cp, { stateDir: dir });
      const counters = (daemonComposition as unknown as { buzzMentionReceiptCounters?: typeof daemonComposition.buzzMentionReceiptCounters })
        .buzzMentionReceiptCounters?.(w.subscriber, w.approvals);
      expect(counters).toBeDefined();
      daemon.setBuzzMentionReceipt({ configuredIdentities: w.subscriber.socketCount, counters: counters! });
      const health = JSON.parse(readFileSync(join(dir, "health.json"), "utf8")) as { buzzMention: { buzzOwnerApproval: Record<string, unknown> } };
      expect(health.buzzMention.buzzOwnerApproval).toMatchObject({ configured: true, unavailable: null, openPrompts: 1 });
    } finally {
      await w.close();
    }
  });
});

/**
 * T3 — the repo-factory project is the one the operator names on `ACP_REPO_FACTORY_PROJECT_ID`, a
 * registered project id. Not a display name, not a literal, not an id pattern: the authority is
 * every one of the configured id, its registration, its ACTIVE PRIMARY_CTO binding, that binding's
 * live runtime carrying a Buzz identity and room, and that identity held by exactly one ACTIVE
 * PRIMARY_CTO binding. Any one missing posts nothing and health names which.
 */
describe("T3: the posting authority is the configured repo-factory project's CTO", () => {
  const unavailableFor = (cause: string): string => `REPO_FACTORY_AUTHORITY_UNAVAILABLE:${cause}`;
  const registerProject = (w: World, projectId: string): void => {
    const { cp } = w.prepared.harness;
    cp.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [projectId, "repo-factory", cp.clock.nowIso()]);
  };
  const ticksToNothing = async (w: World): Promise<string | null> => {
    w.subscriber.rejudge();
    await w.tick();
    expect(w.counts().prompts, "no owner-approval prompt is posted").toBe(0);
    expect(w.relay.published.filter((event) => event.content.startsWith(PROMPT_HEADER))).toEqual([]);
    return w.approvals!.health().unavailable;
  };

  describe("1: a real-format project id", () => {
    it("posts the prompt when the configured prj_ project's live CTO is X, and health is available", async () => {
      const w = await startWorld();
      try {
        expect(REPO_FACTORY_PROJECT).toMatch(/^prj_[0-9a-f]{24}$/);
        await w.tick();
        expect(w.approvals!.health()).toMatchObject({ configured: true, unavailable: null, openPrompts: 1 });
        expect(w.counts().prompts).toBe(1);
        expect(w.publishedPrompts()[0]!.pubkey).toBe(w.keys.x.pubkey);
      } finally {
        await w.close();
      }
    });
  });

  describe("2: only another project matches", () => {
    it("posts nothing when X is another project's CTO and the configured project's CTO is a different key", async () => {
      const w = await startWorld({ xProjectId: COMMITLORE_PROJECT, withY: true, yProjectId: REPO_FACTORY_PROJECT });
      try {
        expect(w.subscriber.admission().identities.find((one) => one.identityPubkey === w.keys.x.pubkey)?.state).toBe("ADMITTED");
        expect(await ticksToNothing(w)).toBe("REPO_FACTORY_AUTHORITY_MISMATCH");
      } finally {
        await w.close();
      }
    });

    it("posts nothing when X is another project's CTO and the configured project has no CTO", async () => {
      const w = await startWorld({ xProjectId: COMMITLORE_PROJECT });
      try {
        registerProject(w, REPO_FACTORY_PROJECT);
        expect(await ticksToNothing(w)).toBe(unavailableFor("NO_ACTIVE_REPO_FACTORY_CTO"));
      } finally {
        await w.close();
      }
    });
  });

  describe("3: zero or more than one", () => {
    it("posts nothing when ACP_REPO_FACTORY_PROJECT_ID is unset or blank", async () => {
      for (const configured of [null, "   "]) {
        const w = await startWorld({ repoFactoryProjectId: configured });
        try {
          expect(await ticksToNothing(w), JSON.stringify(configured)).toBe(unavailableFor("REPO_FACTORY_PROJECT_NOT_CONFIGURED"));
        } finally {
          await w.close();
        }
      }
    });

    it("posts nothing when the configured id names no registered project", async () => {
      const w = await startWorld({ repoFactoryProjectId: "prj_000000000000000000000000" });
      try {
        expect(await ticksToNothing(w)).toBe(unavailableFor("REPO_FACTORY_PROJECT_NOT_REGISTERED"));
      } finally {
        await w.close();
      }
    });

    it("posts nothing when X's Buzz identity is held by two ACTIVE PRIMARY_CTO bindings", async () => {
      const w = await startWorld();
      try {
        const { cp } = w.prepared.harness;
        // A second ACTIVE PRIMARY_CTO binding whose runtime carries X's key. The schema keeps a key on
        // one *live* session only, so the second holder is a stopped runtime its ACTIVE binding still
        // resolves to — written by raw SQL, since no API sets a key on a session after it has stopped.
        cp.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [COMMITLORE_PROJECT, COMMITLORE_PROJECT, cp.clock.nowIso()]);
        const second = cp.sessions.create({ provider: "scripted", model: "cto", buzzAddress: ROOM_Y });
        expect(cp.sessions.transition(second.sessionId, SessionLifecycle.READY, "test").reasonCode).toBe(ReasonCode.OK);
        expect(cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: second.sessionId, projectId: COMMITLORE_PROJECT }).allowed).toBe(true);
        cp.db.run(`UPDATE sessions SET lifecycle = 'STOPPED' WHERE session_id = ?`, [second.sessionId]);
        cp.db.run(`UPDATE sessions SET buzz_actor_id = ? WHERE session_id = ?`, [w.keys.x.pubkey, second.sessionId]);
        expect(cp.bindings.activePrimaryCto(COMMITLORE_PROJECT)?.sessionId).toBe(second.sessionId);
        expect(cp.bindings.activePrimaryCto(REPO_FACTORY_PROJECT)?.sessionId).toBe(w.ctoSessions.x);
        expect(await ticksToNothing(w)).toBe(unavailableFor("REPO_FACTORY_CTO_IDENTITY_AMBIGUOUS"));
      } finally {
        await w.close();
      }
    });
  });

  describe("4: a revoked or stale binding", () => {
    it("posts nothing once the configured project's binding is revoked", async () => {
      // X stays admitted as another project's CTO, so the refusal is the authority's own.
      const w = await startWorld({ xProjectId: COMMITLORE_PROJECT, withY: true, yProjectId: REPO_FACTORY_PROJECT });
      try {
        const { cp } = w.prepared.harness;
        expect(cp.bindings.revoke(roleKeyFor(Role.PRIMARY_CTO, { projectId: REPO_FACTORY_PROJECT }), "test revoke").allowed).toBe(true);
        expect(await ticksToNothing(w)).toBe(unavailableFor("NO_ACTIVE_REPO_FACTORY_CTO"));
      } finally {
        await w.close();
      }
    });

    it("posts nothing when the configured project's CTO runtime is no longer live", async () => {
      const w = await startWorld({ xProjectId: COMMITLORE_PROJECT, withY: true, yProjectId: REPO_FACTORY_PROJECT });
      try {
        const { cp } = w.prepared.harness;
        expect(cp.sessions.transition(w.ctoSessions.y!, SessionLifecycle.STOPPED, "test stop").reasonCode).toBe(ReasonCode.OK);
        expect(cp.bindings.activePrimaryCto(REPO_FACTORY_PROJECT)?.sessionId).toBe(w.ctoSessions.y);
        expect(await ticksToNothing(w)).toBe(unavailableFor("REPO_FACTORY_CTO_NOT_LIVE"));
      } finally {
        await w.close();
      }
    });

    it("posts nothing when X itself is the configured CTO and its runtime stops: admission refuses first", async () => {
      const w = await startWorld();
      try {
        const { cp } = w.prepared.harness;
        expect(cp.sessions.transition(w.ctoSessions.x, SessionLifecycle.STOPPED, "test stop").reasonCode).toBe(ReasonCode.OK);
        expect(await ticksToNothing(w)).toBe("IDENTITY_NOT_ADMITTED:NO_LIVE_SESSION");
      } finally {
        await w.close();
      }
    });

    /**
     * ACP1091-01 — a prompt issued under the authority whose first send did not reach the relay is
     * stored and retried by later ticks. The retry asks the authority again at the moment it sends,
     * so a prompt the authority no longer covers stays unsent.
     */
    const pendingPrompt = async (w: World): Promise<string> => {
      const firstSend = vi.spyOn(w.subscriber.replies, "publishApprovalPublication").mockResolvedValueOnce({ status: "UNAVAILABLE" });
      const initial = await w.approvals!.tick();
      await w.drain();
      firstSend.mockRestore();
      expect(initial.authority).toBeNull();
      expect(initial.issued).toHaveLength(1);
      expect(w.counts().prompts, "the first send did not reach the relay").toBe(0);
      expect(w.approvals!.health()).toMatchObject({ openPrompts: 1, unpublishedPrompts: 1 });
      return initial.issued[0]!;
    };

    it("does not send a pending prompt once the configured project's binding is revoked and X is another project's CTO", async () => {
      const w = await startWorld();
      try {
        const { cp } = w.prepared.harness;
        await pendingPrompt(w);
        expect(cp.bindings.revoke(roleKeyFor(Role.PRIMARY_CTO, { projectId: REPO_FACTORY_PROJECT }), "test revoke").allowed).toBe(true);
        cp.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [COMMITLORE_PROJECT, COMMITLORE_PROJECT, cp.clock.nowIso()]);
        expect(cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: w.ctoSessions.x, projectId: COMMITLORE_PROJECT }).allowed).toBe(true);
        w.subscriber.rejudge();
        await w.drain();
        expect(w.subscriber.admission().identities.find((one) => one.identityPubkey === w.keys.x.pubkey)?.state).toBe("ADMITTED");
        const retry = await w.approvals!.tick();
        await w.drain();
        expect(retry.authority).toBe(unavailableFor("NO_ACTIVE_REPO_FACTORY_CTO"));
        expect(retry.published).toEqual([]);
        expect(w.counts().prompts).toBe(0);
        expect(w.approvals!.health()).toMatchObject({ openPrompts: 1, unpublishedPrompts: 1 });
      } finally {
        await w.close();
      }
    });

    it("does not send a pending prompt from a store recreated with ACP_REPO_FACTORY_PROJECT_ID unset", async () => {
      const w = await startWorld();
      let restarted: BuzzOwnerApprovals | null = null;
      try {
        await pendingPrompt(w);
        w.approvals!.close();
        restarted = composition.createDaemonBuzzOwnerApprovals!(w.prepared.harness.cp, {
          environment: { ACP_OWNER_APPROVAL_BUZZ_IDENTITY: w.keys.x.pubkey },
          ownerActors: [w.keys.owner.pubkey],
          policy: { allowedActors: [w.keys.owner.pubkey, w.keys.ceo.pubkey], secret: SECRET },
          runner: w.prepared.runner,
        });
        composition.attachDaemonBuzzOwnerApprovals!(restarted, w.subscriber);
        const retry = await restarted.tick();
        await w.drain();
        expect(retry.authority).toBe(unavailableFor("REPO_FACTORY_PROJECT_NOT_CONFIGURED"));
        expect(retry.published).toEqual([]);
        expect(w.counts().prompts).toBe(0);
        expect(restarted.health()).toMatchObject({ openPrompts: 1, unpublishedPrompts: 1 });
      } finally {
        restarted?.close();
        await w.close();
      }
    });

    it("control: sends the same pending prompt on the retry tick while the authority still holds", async () => {
      const w = await startWorld();
      try {
        const promptEventId = await pendingPrompt(w);
        const retry = await w.approvals!.tick();
        await w.drain();
        expect(retry.authority).toBeNull();
        expect(retry.published).toEqual([promptEventId]);
        expect(w.publishedPrompts().map((event) => event.id)).toEqual([promptEventId]);
        expect(w.approvals!.health()).toMatchObject({ openPrompts: 1, unpublishedPrompts: 0, unavailable: null });
      } finally {
        await w.close();
      }
    });
  });
});

/* ------------------------------------------------------------------------------------------- S10 */

/** S10 — the repo-factory CTO's own message in X's room: the one the owner answered under in run_7717. */
const ctoMessage = (w: World, content = "repo-factory: the plan is reviewed and waits for your approval"): BuzzMentionEvent =>
  finalizeEvent(
    { kind: 9, created_at: secondsOf(w.prepared.harness.cp.clock.now().getTime()), tags: [["h", ROOM_X]], content },
    w.keys.x.secretKey,
  ) as BuzzMentionEvent;

/** S10 — an answer posted under `parent` instead of the prompt, tagged as a client tags a reply to it. */
const underMessage = (
  w: World,
  parent: BuzzMentionEvent,
  content: string,
  options: { author?: ChannelKey; createdAt?: number; room?: string } = {},
): BuzzMentionEvent =>
  w.reply({
    prompt: null,
    content,
    tags: [["h", options.room ?? ROOM_X], ["e", parent.id, "", "reply"], ["p", parent.pubkey]],
    ...(options.author === undefined ? {} : { author: options.author }),
    ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
  });

const answerPayload = (w: World, promptEventId: string): Record<string, unknown> | null => {
  const row = w.prepared.harness.cp.db.get<{ payload_json: string }>(
    `SELECT payload_json FROM inbound_messages WHERE channel = 'buzz-owner-approval-answer' AND nonce = ?`,
    [promptEventId],
  );
  return row === undefined ? null : (JSON.parse(row.payload_json) as Record<string, unknown>);
};

describe("S10 (#246 a): an owner-signed code answered under another message (CEO c07863f8)", () => {
  it("accepts the bare code under the CTO's message exactly once through the daemon's sink, and C3 consumes it once", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      const { cp } = w.prepared.harness;
      const scope = w.prepared.runner.approvalScopeOf(w.prepared.runId);
      if (!scope.allowed) throw new Error(scope.message);
      const answer = underMessage(w, ctoMessage(w), `acp-approve-write:${w.promptCode(prompt)}`);
      const receive = vi.spyOn(w.approvals!, "receive");
      await w.send(answer);
      expect(receive).toHaveBeenCalled();
      expect(w.counts()).toMatchObject({ answers: 1, receipts: 1, artifacts: 1, consumptions: 0, githubCalls: 0, deliveries: 0, admittedMessages: 0, refusalRows: 0 });
      const receipt = cp.artifacts.list<Record<string, unknown>>(w.prepared.runId, "APPROVAL").at(-1)!.content["receipt"];
      expect(receipt).toEqual({
        channel: "buzz",
        actor: w.keys.owner.pubkey,
        inboundNonce: `buzz-approval:${answer.id}`,
        runId: w.prepared.runId,
        candidateSnapshotDigest: w.prepared.snapshotDigest,
        operation: "repo_factory_github_write",
        parameterDigest: scope.value.parameterDigest,
        idempotencyKey: `buzz:repo-factory-github-write:${prompt.id}`,
        approved: true,
      });
      expect(answerPayload(w, prompt.id)).toMatchObject({ state: "ANSWERED", link: "CODE", approved: true });

      // Single consumption: the relay again is a replay, and a second event carrying the code is refused.
      await w.send(answer);
      expect(receiveDirect(w, answer).reasonCode).toBe(ReasonCode.INGRESS_REPLAY_IGNORED);
      const again = underMessage(w, ctoMessage(w, "status?"), `acp-approve-write:${w.promptCode(prompt)}`, { createdAt: answer.created_at + 1 });
      expect(receiveDirect(w, again).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_PROMPT_ALREADY_ANSWERED);
      expect(w.counts()).toMatchObject({ answers: 1, receipts: 1, artifacts: 1, refusalRows: 1 });

      // The outcome answers the owner's event where it was posted; C3 consumes the receipt once.
      await w.tick();
      expect(w.publishedOutcomes()).toHaveLength(1);
      expect(w.publishedOutcomes()[0]!.tags).toEqual([["h", ROOM_X], ["e", answer.id, "", "reply"]]);
      expect(w.module!.verifyBuzzApprovalEvidence(cp.db, receipt as never, { nowMs: cp.clock.now().getTime() }).allowed).toBe(true);
      const first = await w.confirm();
      expect(first.reasonCode, JSON.stringify(first)).toBe(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE);
      expect(w.counts()).toMatchObject({ answers: 1, receipts: 1, consumptions: 1, githubCalls: 4 });
      const resumed = await w.confirm();
      expect(resumed.reasonCode, JSON.stringify(resumed)).toBe(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE);
      expect(w.counts()).toMatchObject({ consumptions: 1, githubCalls: 4 });
    } finally {
      await w.close();
    }
  });

  it("refuses a stranger, the CEO, plain chat, a quoted token, an unknown code and another room; the bare code then mints once", async () => {
    const { w, prompt } = await promptedWorld({ xRooms: [ROOM_X, ROOM_OTHER] });
    try {
      const code = w.promptCode(prompt);
      const parent = ctoMessage(w);
      let at = prompt.created_at;
      const next = (content: string, options: { author?: ChannelKey; room?: string } = {}) =>
        underMessage(w, parent, content, { ...options, createdAt: (at += 1) });
      const stranger = next(`acp-approve-write:${code}`, { author: w.keys.stranger });
      const ceo = next(`acp-approve-write:${code}`, { author: w.keys.ceo });
      for (const event of [stranger, ceo]) {
        await w.send(event);
        expect(receiveDirect(w, event).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_NOT_OWNER);
      }
      expect(w.counts()).toMatchObject({ ...NOTHING_MINTED, refusalRows: 0 });
      // The owner's ordinary conversation under the CTO's message carries no token: never an answer.
      expect(receiveDirect(w, next("looks good to me, go ahead"))).toMatchObject({ allowed: false, reasonCode: ReasonCode.BUZZ_APPROVAL_MALFORMED });
      // A sentence that quotes the token is conversation too, and a bare code of no prompt names nothing.
      for (const content of [`ok, acp-approve-write:${code} once CI is green`, `acp-approve-write:${"0".repeat(16)}`]) {
        expect(receiveDirect(w, next(content)).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_PROMPT_UNRESOLVED);
      }
      const elsewhere = next(`acp-approve-write:${code}`, { room: ROOM_OTHER });
      expect(receiveDirect(w, elsewhere, w.keys.x.pubkey, ROOM_OTHER).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_PROMPT_WRONG_ROOM);
      expect(w.counts()).toMatchObject({ ...NOTHING_MINTED, refusalRows: 3 });

      const bare = next(`acp-approve-write:${code}`);
      expect(receiveDirect(w, bare)).toMatchObject({ allowed: true, value: { result: "MINTED", promptEventId: prompt.id } });
      expect(w.counts()).toMatchObject({ answers: 1, receipts: 1, artifacts: 1, deliveries: 0, admittedMessages: 0 });
    } finally {
      await w.close();
    }
  });

  it("wrong scope: the code of a prompt whose scope moved is PROMPT_STALE, then PROMPT_CANCELLED; the new prompt's code binds the new scope", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      const { harness } = w.prepared;
      await replanBootstrap(
        harness,
        w.prepared.runId,
        { planDigest: w.prepared.planDigest, snapshotDigest: w.prepared.snapshotDigest, ceoSessionId: w.prepared.ceoSessionId },
        bootstrapPlan(w.prepared.manifest, { operations: bootstrapOperations() as Operation[], summary: "a revised plan" }),
      );
      const parent = ctoMessage(w);
      const stale = underMessage(w, parent, `acp-approve-write:${w.promptCode(prompt)}`);
      expect(receiveDirect(w, stale)).toMatchObject({ allowed: false, reasonCode: ReasonCode.BUZZ_APPROVAL_PROMPT_STALE, evidence: { field: "planDigest" } });
      await w.tick();
      expect(w.counts().prompts).toBe(2);
      const cancelled = underMessage(w, parent, `acp-approve-write:${w.promptCode(prompt)}`, { createdAt: stale.created_at + 1 });
      expect(receiveDirect(w, cancelled).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_PROMPT_CANCELLED);
      expect(w.counts()).toMatchObject({ ...NOTHING_MINTED, refusalRows: 2 });

      const renewed = w.publishedPrompts().at(-1)!;
      const scope = w.prepared.runner.approvalScopeOf(w.prepared.runId);
      if (!scope.allowed) throw new Error(scope.message);
      const minted = receiveDirect(w, underMessage(w, parent, `acp-approve-write:${w.promptCode(renewed)}`, { createdAt: stale.created_at + 2 }));
      expect(minted).toMatchObject({ allowed: true, value: { promptEventId: renewed.id, receipt: { parameterDigest: scope.value.parameterDigest } } });
      expect(scope.value.planDigest).not.toBe(w.prepared.planDigest);
    } finally {
      await w.close();
    }
  });

  it("expired: the code delivered after its prompt's stored window is PROMPT_EXPIRED, however it is dated", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      const parent = ctoMessage(w);
      const inside = underMessage(w, parent, `acp-approve-write:${w.promptCode(prompt)}`);
      w.prepared.harness.clock.advance(25 * 60 * 60 * 1000);
      expect(receiveDirect(w, inside).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_PROMPT_EXPIRED);
      const late = underMessage(w, parent, `acp-approve-write:${w.promptCode(prompt)}`, { createdAt: secondsOf(w.prepared.harness.cp.clock.now().getTime()) });
      expect(receiveDirect(w, late).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_PROMPT_EXPIRED);
      expect(w.counts()).toMatchObject({ ...NOTHING_MINTED, refusalRows: 2 });
    } finally {
      await w.close();
    }
  });

  it("an explicit refusal is never overridden: a decline by code stands against a later approval by code or by reply, and C3 refuses", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      const code = w.promptCode(prompt);
      const parent = ctoMessage(w);
      const decline = underMessage(w, parent, `acp-decline-write:${code}`);
      expect(receiveDirect(w, decline)).toMatchObject({ allowed: true, value: { result: "MINTED", receipt: { approved: false } } });
      const approveByCode = underMessage(w, parent, `acp-approve-write:${code}`, { createdAt: decline.created_at + 1 });
      expect(receiveDirect(w, approveByCode).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_PROMPT_ALREADY_ANSWERED);
      const approveByReply = w.reply({ prompt, createdAt: decline.created_at + 2 });
      expect(receiveDirect(w, approveByReply).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_PROMPT_ALREADY_ANSWERED);
      // A refused event's refusal is its answer from then on.
      expect(receiveDirect(w, approveByCode).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_PROMPT_ALREADY_ANSWERED);
      expect(w.counts()).toMatchObject({ answers: 1, receipts: 1, artifacts: 1 });
      expect(await w.confirm()).toMatchObject({ allowed: false, evidence: { refusal: "APPROVAL_DECLINED" } });
      expect(w.counts()).toMatchObject({ consumptions: 0, githubCalls: 0 });
    } finally {
      await w.close();
    }
  });

  it("consumption asks the link again: a stored answer whose event quotes the code under another message is EVENT_NOT_A_REPLY", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      const { cp } = w.prepared.harness;
      const scope = w.prepared.runner.approvalScopeOf(w.prepared.runId);
      if (!scope.allowed) throw new Error(scope.message);
      // An answer row as #mint writes one, in ACP's own connection, for an event that quotes the token.
      const quoted = underMessage(w, ctoMessage(w), `ok, acp-approve-write:${w.promptCode(prompt)} once CI is green`);
      const idempotencyKey = `buzz:repo-factory-github-write:${prompt.id}`;
      const receipt = {
        channel: "buzz",
        actor: w.keys.owner.pubkey,
        inboundNonce: `buzz-approval:${quoted.id}`,
        runId: w.prepared.runId,
        candidateSnapshotDigest: scope.value.candidateSnapshotDigest,
        operation: scope.value.operation,
        parameterDigest: scope.value.parameterDigest,
        idempotencyKey,
        approved: true,
      };
      const envelope = ownerApprovalPayload({
        runId: w.prepared.runId,
        candidateSnapshotDigest: scope.value.candidateSnapshotDigest,
        operation: scope.value.operation,
        parameters: scope.value.parameters,
        idempotencyKey,
        approved: true,
      });
      cp.db.run(`INSERT INTO inbound_messages (channel, nonce, actor, received_at, payload_json) VALUES (?, ?, ?, ?, ?)`, [
        "buzz-owner-approval-answer",
        prompt.id,
        quoted.pubkey,
        cp.clock.nowIso(),
        JSON.stringify({
          schema: "acp.buzz-owner-approval.answer.v1",
          state: "ANSWERED",
          promptEventId: prompt.id,
          approvalEvent: quoted,
          approved: true,
          envelope,
          receipt,
          receiptDigest: digestOf(receipt),
          inboundNonce: receipt.inboundNonce,
          answeredAt: cp.clock.nowIso(),
          outcomeEvent: null,
          link: "CODE",
        }),
      ]);
      const verdict = w.module!.verifyBuzzApprovalEvidence(cp.db, receipt, { nowMs: cp.clock.now().getTime() });
      expect(verdict).toMatchObject({ allowed: false, evidence: { refusal: "EVENT_NOT_A_REPLY" } });
    } finally {
      await w.close();
    }
  });

  it("a code answered by reply first is a replayed code when it comes again under another message", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      await w.send(w.reply({ prompt }));
      expect(answerPayload(w, prompt.id)).toMatchObject({ state: "ANSWERED", link: "REPLY" });
      const again = underMessage(w, ctoMessage(w), `acp-approve-write:${w.promptCode(prompt)}`);
      expect(receiveDirect(w, again).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_PROMPT_ALREADY_ANSWERED);
      expect(w.counts()).toMatchObject({ answers: 1, receipts: 1, artifacts: 1 });
    } finally {
      await w.close();
    }
  });
});

/** S10 — the item a contract names to declare that the T3 approval is its owner decision. */
const T3_GATE_ITEM = "owner-approval:repo_factory_github_write";
/** The run_7717 item: the same approval described in prose, which declares no link. */
const PROSE_ITEM = "실제 create 전 run·PLAN·operations scope의 T3 owner 서명 승인";

const gateOf = (w: World) => w.prepared.harness.cp.ceo.humanGateStatus(w.prepared.runId);
const ownerDecision = (w: World, item: string, approved: boolean) =>
  w.prepared.harness.cp.ceo.recordOwnerDecision({
    runId: w.prepared.runId,
    item,
    approved,
    note: approved ? "approved" : "refused",
    receipt: ownerDecisionReceipt(w.prepared.harness, w.prepared.runId, item, approved, approved ? "approved" : "refused"),
  });

describe("S10 (#246 b): the T3 approval decides the human-gate item that declares the link, and only that item", () => {
  it("the linked item is satisfied by the owner's Buzz T3 approval, before and after C3 consumes it, and the CONFIRM completes", async () => {
    const { w, prompt } = await promptedWorld({ humanGate: [T3_GATE_ITEM] });
    try {
      const { cp } = w.prepared.harness;
      expect((productionGate as unknown as Record<string, unknown>)["REPO_FACTORY_GITHUB_WRITE_GATE_ITEM"]).toBe(T3_GATE_ITEM);
      expect(gateOf(w)).toEqual({ required: true, items: [T3_GATE_ITEM], satisfied: false });
      await w.send(underMessage(w, ctoMessage(w), `acp-approve-write:${w.promptCode(prompt)}`));
      expect(gateOf(w)).toEqual({ required: true, items: [T3_GATE_ITEM], satisfied: true });

      const first = await w.confirm();
      expect(first.reasonCode, JSON.stringify(first)).toBe(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE);
      expect(w.counts()).toMatchObject({ consumptions: 1, githubCalls: 4 });
      expect(gateOf(w).satisfied).toBe(true);
      const primary = cp.bindings.activePrimaryCto(w.prepared.manifest.projectId);
      expect(cp.bootstrap.acknowledgeActivationHandoff(first.evidence["pendingHandoffId"] as string, primary!.sessionId).allowed).toBe(true);
      const activated = await w.confirm();
      expect(activated.allowed, JSON.stringify(activated)).toBe(true);
      const confirmed = cp.ceo.submitCeoDecision({
        runId: w.prepared.runId,
        decision: "CONFIRM",
        candidateSnapshotDigest: w.prepared.snapshotDigest,
        ceoSessionId: w.prepared.ceoSessionId,
        rationale: "apply the bootstrap",
      });
      expect(confirmed.allowed, JSON.stringify(confirmed)).toBe(true);
      expect(cp.runs.require(w.prepared.runId).state).toBe(RunState.COMPLETED);
      expect(w.counts()).toMatchObject({ consumptions: 1, githubCalls: 4 });
      const decisions = cp.artifacts.list<Record<string, unknown>>(w.prepared.runId, "APPROVAL").filter((a) => a.content["kind"] === "OWNER_DECISION");
      expect(decisions).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it("an unrelated item, and the same approval described in prose, stay unsatisfied until their own OWNER_DECISION", async () => {
    const { w, prompt } = await promptedWorld({ humanGate: [T3_GATE_ITEM, PROSE_ITEM] });
    try {
      await w.send(w.reply({ prompt }));
      expect(gateOf(w)).toEqual({ required: true, items: [T3_GATE_ITEM, PROSE_ITEM], satisfied: false });
      const refused = await w.confirm();
      expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.HUMAN_GATE_UNSATISFIED });
      expect(w.counts()).toMatchObject({ consumptions: 0, githubCalls: 0 });
      expect(ownerDecision(w, PROSE_ITEM, true).allowed).toBe(true);
      expect(gateOf(w).satisfied).toBe(true);
    } finally {
      await w.close();
    }
  });

  it("an explicit OWNER_DECISION refusal of the linked item is never overridden by a T3 approval, earlier or later", async () => {
    const { w, prompt } = await promptedWorld({ humanGate: [T3_GATE_ITEM] });
    try {
      await w.send(w.reply({ prompt }));
      expect(gateOf(w).satisfied).toBe(true);
      expect(ownerDecision(w, T3_GATE_ITEM, false).allowed).toBe(true);
      expect(gateOf(w).satisfied).toBe(false);
      // A newer T3 approval, recorded through the CLI path, does not override the refusal either.
      const approval = ownerApprovalFor(w.prepared);
      expect(w.prepared.runner.recordOwnerApproval(w.prepared.runId, {
        owner: "acme",
        visibility: "public",
        planDigest: w.prepared.planDigest,
        approvedManifest: w.prepared.manifest,
        projectName: w.prepared.manifest.projectId,
        receipt: approval.receipt as never,
      }).allowed).toBe(true);
      expect(gateOf(w).satisfied).toBe(false);
      expect(await w.confirm()).toMatchObject({ allowed: false, reasonCode: ReasonCode.HUMAN_GATE_UNSATISFIED });
      // The one consumption is the refusal's own owner_decision_submit receipt; no T3 receipt was consumed.
      expect(w.counts()).toMatchObject({ consumptions: 1, githubCalls: 0 });
      expect(w.prepared.harness.cp.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'OWNER_APPROVAL_CONSUMED' AND run_id = ?
          AND json_extract(evidence_json, '$.operation') = 'repo_factory_github_write'`,
        [w.prepared.runId],
      )?.n).toBe(0);
    } finally {
      await w.close();
    }
  });

  it("the owner's T3 decline, newer than an approval, is an explicit refusal: the linked item reads unsatisfied", async () => {
    const { w, prompt } = await promptedWorld({ humanGate: [T3_GATE_ITEM] });
    try {
      const approval = ownerApprovalFor(w.prepared);
      expect(w.prepared.runner.recordOwnerApproval(w.prepared.runId, {
        owner: "acme",
        visibility: "public",
        planDigest: w.prepared.planDigest,
        approvedManifest: w.prepared.manifest,
        projectName: w.prepared.manifest.projectId,
        receipt: approval.receipt as never,
      }).allowed).toBe(true);
      expect(gateOf(w).satisfied).toBe(true);
      const declined = receiveDirect(w, w.reply({ prompt, content: `acp-decline-write:${w.promptCode(prompt)}` }));
      expect(declined).toMatchObject({ allowed: true, value: { result: "MINTED", receipt: { approved: false } } });
      expect(gateOf(w).satisfied).toBe(false);
      expect(await w.confirm()).toMatchObject({ allowed: false, reasonCode: ReasonCode.HUMAN_GATE_UNSATISFIED });
      expect(w.counts()).toMatchObject({ consumptions: 0, githubCalls: 0 });
    } finally {
      await w.close();
    }
  });

  it("a Buzz T3 approval past its prompt's stored window does not satisfy the linked item", async () => {
    const { w, prompt } = await promptedWorld({ humanGate: [T3_GATE_ITEM] });
    try {
      await w.send(w.reply({ prompt }));
      expect(gateOf(w).satisfied).toBe(true);
      w.prepared.harness.clock.advance(25 * 60 * 60 * 1000);
      expect(gateOf(w).satisfied).toBe(false);
      expect(await w.confirm()).toMatchObject({ allowed: false, reasonCode: ReasonCode.HUMAN_GATE_UNSATISFIED });
      expect(w.counts()).toMatchObject({ consumptions: 0, githubCalls: 0 });
    } finally {
      await w.close();
    }
  });

  it("a newer T3 record whose receipt names a key no owner ingress admitted does not satisfy the linked item", async () => {
    const { w, prompt } = await promptedWorld({ humanGate: [T3_GATE_ITEM] });
    try {
      const { cp } = w.prepared.harness;
      await w.send(w.reply({ prompt }));
      expect(gateOf(w).satisfied).toBe(true);
      const real = cp.artifacts.list<Record<string, unknown>>(w.prepared.runId, "APPROVAL").at(-1)!;
      const receipt = real.content["receipt"] as Record<string, unknown>;
      // A Buzz receipt naming a stranger's key, and a CLI receipt naming an actor no owner ingress admitted.
      for (const forged of [
        { ...receipt, actor: w.keys.stranger.pubkey },
        { ...receipt, channel: "cli", actor: "not-the-owner", inboundNonce: "cli-forged" },
      ]) {
        cp.artifacts.put(w.prepared.runId, "APPROVAL", { ...real.content, receipt: forged }, w.prepared.snapshotDigest);
        expect(gateOf(w).satisfied).toBe(false);
      }
      expect(await w.confirm()).toMatchObject({ allowed: false, reasonCode: ReasonCode.HUMAN_GATE_UNSATISFIED });
      expect(w.counts()).toMatchObject({ consumptions: 0, githubCalls: 0 });
    } finally {
      await w.close();
    }
  });

  it("a consumed Buzz T3 approval still satisfies the linked item only while its stored evidence verifies", async () => {
    const { w, prompt } = await promptedWorld({ humanGate: [T3_GATE_ITEM] });
    try {
      const { cp } = w.prepared.harness;
      await w.send(w.reply({ prompt }));
      const first = await w.confirm();
      expect(first.reasonCode, JSON.stringify(first)).toBe(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE);
      expect(w.counts()).toMatchObject({ consumptions: 1 });
      expect(gateOf(w).satisfied).toBe(true);
      const payload = answerPayload(w, prompt.id)!;
      const side = new Database(cp.config.databasePath);
      try {
        side.exec("DROP TRIGGER IF EXISTS inbound_messages_payload_immutable");
        side.prepare(`UPDATE inbound_messages SET payload_json = ? WHERE channel = 'buzz-owner-approval-answer' AND nonce = ?`).run(
          JSON.stringify({ ...payload, approvalEvent: { ...(payload["approvalEvent"] as Record<string, unknown>), sig: "0".repeat(128) } }),
          prompt.id,
        );
      } finally {
        side.close();
      }
      expect(gateOf(w).satisfied).toBe(false);
    } finally {
      await w.close();
    }
  });

  it("a T3 approval of a scope that has since moved does not satisfy the linked item", async () => {
    const { w, prompt } = await promptedWorld({ humanGate: [T3_GATE_ITEM] });
    try {
      await w.send(w.reply({ prompt }));
      expect(gateOf(w).satisfied).toBe(true);
      await replanBootstrap(
        w.prepared.harness,
        w.prepared.runId,
        { planDigest: w.prepared.planDigest, snapshotDigest: w.prepared.snapshotDigest, ceoSessionId: w.prepared.ceoSessionId },
        bootstrapPlan(w.prepared.manifest, { operations: bootstrapOperations() as Operation[], summary: "a revised plan" }),
      );
      expect(w.prepared.harness.cp.runs.require(w.prepared.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      expect(gateOf(w).satisfied).toBe(false);
    } finally {
      await w.close();
    }
  });

  it("a PLAN stored after the T3 approval, with the candidate unmoved, is another scope: the linked item reads unsatisfied", async () => {
    const { w, prompt } = await promptedWorld({ humanGate: [T3_GATE_ITEM] });
    try {
      const { cp } = w.prepared.harness;
      await w.send(w.reply({ prompt }));
      expect(gateOf(w).satisfied).toBe(true);
      cp.artifacts.put(w.prepared.runId, "PLAN", bootstrapPlan(w.prepared.manifest, { operations: bootstrapOperations() as Operation[], summary: "a plan stored afterwards" }));
      const scope = w.prepared.runner.approvalScopeOf(w.prepared.runId);
      expect(scope.allowed && scope.value.candidateSnapshotDigest === w.prepared.snapshotDigest && scope.value.planDigest !== w.prepared.planDigest).toBe(true);
      expect(gateOf(w).satisfied).toBe(false);
    } finally {
      await w.close();
    }
  });
});


/* eslint-disable no-console -- S10-R1: the review witnesses RV1142 W1–W8 are kept as written, observation logs included. */
describe("RV1142 concrete review witnesses", () => {
  it("RV1142-W1 only the exact declared item may use the T3 link", async () => {
    const { w, prompt } = await promptedWorld({ humanGate: [` ${T3_GATE_ITEM}\t`] });
    try {
      await w.send(w.reply({ prompt }));
      expect(gateOf(w).satisfied, JSON.stringify(gateOf(w))).toBe(false);
    } finally { await w.close(); }
  });

  it("RV1142-W2 a forged consumption audit row cannot authenticate a T3 owner decision", async () => {
    const { w } = await promptedWorld({ humanGate: [T3_GATE_ITEM] });
    try {
      const { cp } = w.prepared.harness;
      const scope = w.prepared.runner.approvalScopeOf(w.prepared.runId);
      if (!scope.allowed) throw new Error(scope.message);
      const receipt = {
        channel: "cli", actor: "not-the-owner", inboundNonce: "never-admitted",
        runId: w.prepared.runId, candidateSnapshotDigest: w.prepared.snapshotDigest,
        operation: scope.value.operation, parameterDigest: scope.value.parameterDigest,
        idempotencyKey: "forged-consumed-approval", approved: true,
      };
      const row = cp.artifacts.put(w.prepared.runId, "APPROVAL", {
        kind: "REPO_FACTORY_GITHUB_WRITE", owner: "acme", visibility: "public",
        planDigest: w.prepared.planDigest, approvedManifest: w.prepared.manifest,
        projectName: w.prepared.manifest.projectId, receipt,
      }, w.prepared.snapshotDigest);
      expect(gateOf(w).satisfied).toBe(false);
      const side = new Database(cp.config.databasePath);
      try {
        side.prepare(`INSERT INTO audit_events (at,kind,run_id,actor,evidence_json) VALUES (?, ?, ?, ?, ?)`)
          .run(cp.clock.nowIso(), "OWNER_APPROVAL_CONSUMED", w.prepared.runId, "cli:not-the-owner",
          JSON.stringify({receiptDigest: digestOf(receipt), candidateSnapshotDigest: w.prepared.snapshotDigest}));
      } finally { side.close(); }
      expect(cp.ownerAuthority.assertApproval(receipt).allowed).toBe(false);
      expect(cp.ownerAuthority.assertConsumedApproval(receipt, w.prepared.snapshotDigest).allowed).toBe(true);
      console.log("RV1142-W2 observed", JSON.stringify({ gate: gateOf(w), counts: w.counts(), artifact: row.digest, confirm: await w.confirm() }));
      expect(gateOf(w).satisfied).toBe(false);
    } finally { await w.close(); }
  });

  it("RV1142-W3 a quoted token cannot satisfy the linked gate or authorize writes", async () => {
    const { w, prompt } = await promptedWorld({humanGate: [T3_GATE_ITEM]});
    try {
      const event = w.reply({ prompt, content: `do not use acp-approve-write:${w.promptCode(prompt)} until CI passes` });
      const observed = receiveDirect(w, event);
      const confirm = await w.confirm();
      console.log("RV1142-W3 observed", JSON.stringify({ observed, gate: gateOf(w), confirm, counts: w.counts() }));
      expect(gateOf(w).satisfied).toBe(false);
      expect(w.counts().githubCalls).toBe(0);
    } finally { await w.close(); }
  });

  it("RV1142-W4 the merge-finalizer reader retains its distinct decision rule", async () => {
    const { w, prompt } = await promptedWorld({ humanGate: [T3_GATE_ITEM] });
    try {
      await w.send(w.reply({ prompt }));
      expect(gateOf(w).satisfied).toBe(true);
      expect(w.prepared.harness.cp.ceo.currentHumanGateDecisionDigest(w.prepared.runId).allowed).toBe(false);
    } finally { await w.close(); }
  });
});


describe("RV1142 anchored approval siblings", () => {
  it("RV1142-W5 a duplicate approval does not strand an already anchored execution after ingress pruning", async () => {
    const { w, prompt } = await promptedWorld({ humanGate: [T3_GATE_ITEM] });
    try {
      const { cp } = w.prepared.harness;
      await w.send(w.reply({prompt}));
      const first = await w.confirm();
      expect(first.reasonCode).toBe(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE);
      expect(gateOf(w).satisfied).toBe(true);
      const duplicate = ownerApprovalFor(w.prepared);
      expect(w.prepared.runner.recordOwnerApproval(w.prepared.runId, {
        owner: "acme", visibility: "public", planDigest: w.prepared.planDigest,
        approvedManifest: w.prepared.manifest, projectName: w.prepared.manifest.projectId,
        receipt: duplicate.receipt,
      }).allowed).toBe(true);
      expect(gateOf(w).satisfied).toBe(true);
      w.prepared.harness.clock.advance(25 * 60 * 60 * 1000);
      const guard = new IngressGuard(cp.db, cp.clock, cp.audit, { cli: {allowedActors: [TEST_OWNER.actor]} });
      expect(guard.admit({channel: "cli", actor: TEST_OWNER.actor, nonce: "after-retention", payload: null}).allowed).toBe(true);
      const scope = w.prepared.runner.approvalScopeOf(w.prepared.runId);
      if (!scope.allowed) throw new Error(scope.message);
      const need = w.prepared.runner.ownerApprovalNeed(w.prepared.runId, scope.value);
      const resumed = await w.confirm();
      console.log("RV1142-W5 observed", JSON.stringify({gate: gateOf(w), need, resumed, counts: w.counts()}));
      expect(need.need).toBe("EXECUTION_ANCHORED");
      expect(gateOf(w).satisfied).toBe(true);
    } finally { await w.close(); }
  });
});

describe("RV1142 delivery and item siblings", () => {
  it("RV1142-W6 a valid code under another author's message reaches the daemon without mentioning X", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      const parent = finalizeEvent({ kind: 9, created_at: prompt.created_at, tags: [["h", ROOM_X]], content: "CEO: please answer here" }, w.keys.ceo.secretKey) as BuzzMentionEvent;
      const event = underMessage(w, parent, `acp-approve-write:${w.promptCode(prompt)}`);
      const receive = vi.spyOn(w.approvals!, "receive");
      await w.send(event);
      const received = receive.mock.calls.length;
      const counts = w.counts();
      const filters = w.relay.requested.map(x => x.filter);
      const direct = receiveDirect(w, event);
      console.log("RV1142-W6 observed", JSON.stringify({ received, counts, filters, direct }));
      expect(received).toBeGreaterThan(0);
      expect(counts.answers).toBe(1);
    } finally { await w.close(); }
  });

  it.each([
    T3_GATE_ITEM.toUpperCase(),
    `${T3_GATE_ITEM}:extra`,
    `other:${T3_GATE_ITEM}`,
    'owner-approval:repo_factory_github_ write',
    PROSE_ITEM,
  ])("RV1142-W7 nonlinked declared item %s remains unsatisfied", async (item) => {
    const { w, prompt } = await promptedWorld({humanGate: [item]});
    try {
      await w.send(w.reply({prompt}));
      expect(gateOf(w).satisfied).toBe(false);
    } finally { await w.close(); }
  });

  it("RV1142-W8 two bare code events delivered together commit only one answer", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      const parent = ctoMessage(w);
      const a = underMessage(w, parent, `acp-approve-write:${w.promptCode(prompt)}`);
      const b = underMessage(w, parent, `acp-decline-write:${w.promptCode(prompt)}`, {createdAt: a.created_at + 1});
      w.relay.publish(a);
      w.relay.publish(b);
      await w.drain();
      expect(w.counts()).toMatchObject({ answers: 1, receipts: 1, artifacts: 1 });
      expect(receiveDirect(w, b).reasonCode).toBe(ReasonCode.BUZZ_APPROVAL_PROMPT_ALREADY_ANSWERED);
    } finally { await w.close(); }
  });
});
/* eslint-enable no-console */

describe("S10-R1: the fixes' own guards", () => {
  it("S10-R1-01 a PROJECT_BOOTSTRAP row bound to a project is not decided by the T3 approval; C3 refuses it RUN_NOT_PROJECTLESS", async () => {
    const { w, prompt } = await promptedWorld({ humanGate: [T3_GATE_ITEM] });
    try {
      const { cp } = w.prepared.harness;
      await w.send(w.reply({ prompt }));
      expect(gateOf(w).satisfied).toBe(true);
      // RunEngine.create refuses a project for PROJECT_BOOTSTRAP (BOOTSTRAP_PROJECT_SUPPLIED) and nothing sets one
      // later, so only a row written before that rule, or by a database writer, is bound to a project.
      cp.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, ["legacy-bound", "legacy", cp.clock.nowIso()]);
      cp.db.run(`UPDATE runs SET project_id = ? WHERE run_id = ?`, ["legacy-bound", w.prepared.runId]);
      expect(w.prepared.runner.ownerApprovalHolds(w.prepared.runId, w.prepared.snapshotDigest)).toMatchObject({
        allowed: false,
        evidence: { refusal: "RUN_NOT_PROJECTLESS" },
      });
      expect(gateOf(w).satisfied).toBe(false);
      expect(await w.confirm()).toMatchObject({ allowed: false, evidence: { refusal: "RUN_NOT_PROJECTLESS" } });
      expect(w.counts()).toMatchObject({ consumptions: 0, githubCalls: 0 });
    } finally {
      await w.close();
    }
  });

  it("S10-R1-01 the gate reads the predicate of the runner it is given: one with no work root admits no approval, as its CONFIRM would not", async () => {
    const { w, prompt } = await promptedWorld({ humanGate: [T3_GATE_ITEM] });
    try {
      const { cp } = w.prepared.harness;
      await w.send(w.reply({ prompt }));
      expect(gateOf(w).satisfied).toBe(true);
      expect(cp.bootstrapProducer.ownerApprovalHolds(w.prepared.runId, w.prepared.snapshotDigest)).toMatchObject({
        allowed: false,
        evidence: { refusal: "WORK_ROOT_UNCONFIGURED" },
      });
      cp.ceo.attach({ repoFactoryApprovals: cp.bootstrapProducer });
      expect(gateOf(w).satisfied).toBe(false);
    } finally {
      await w.close();
    }
  });

  it("S10-R1-01 an anchored execution holds only while the newest decision is its own or a duplicate: a different newer decision is APPROVAL_NOT_THIS_EXECUTION, as C3 refuses it", async () => {
    const { w, prompt } = await promptedWorld({ humanGate: [T3_GATE_ITEM] });
    try {
      const { cp } = w.prepared.harness;
      await w.send(w.reply({ prompt }));
      expect((await w.confirm()).reasonCode).toBe(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE);
      expect(gateOf(w).satisfied).toBe(true);
      // A newer record of the same scope that is not the same decision: it names no candidate.
      const anchored = cp.artifacts.list<Record<string, unknown>>(w.prepared.runId, "APPROVAL").at(-1)!;
      const receipt = { ...(anchored.content["receipt"] as Record<string, unknown>), channel: "cli", actor: TEST_OWNER.actor, inboundNonce: "cli-other-decision", candidateSnapshotDigest: null };
      cp.artifacts.put(w.prepared.runId, "APPROVAL", { ...anchored.content, receipt }, w.prepared.snapshotDigest);
      expect(w.prepared.runner.ownerApprovalHolds(w.prepared.runId, w.prepared.snapshotDigest)).toMatchObject({
        allowed: false,
        evidence: { refusal: "APPROVAL_NOT_THIS_EXECUTION" },
      });
      expect(gateOf(w).satisfied).toBe(false);
      expect(await w.confirm()).toMatchObject({ allowed: false });
      expect(w.counts()).toMatchObject({ consumptions: 1, githubCalls: 4 });
    } finally {
      await w.close();
    }
  });

  it("S10-R1-01 a WRITTEN execution whose approval anchor is gone is not held by a newer consumable duplicate, as C3 does not resume it", async () => {
    const { w, prompt } = await promptedWorld({ humanGate: [T3_GATE_ITEM] });
    try {
      const { cp } = w.prepared.harness;
      await w.send(w.reply({ prompt }));
      expect((await w.confirm()).reasonCode).toBe(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE);
      expect(cp.bootstrapApplications.get(w.prepared.runId)?.phase).toBe("WRITTEN");
      rmSync(join(w.prepared.workRoot, w.prepared.runId, "owner-approval"), { recursive: true, force: true });
      const duplicate = ownerApprovalFor(w.prepared);
      expect(w.prepared.runner.recordOwnerApproval(w.prepared.runId, {
        owner: "acme",
        visibility: "public",
        planDigest: w.prepared.planDigest,
        approvedManifest: w.prepared.manifest,
        projectName: w.prepared.manifest.projectId,
        receipt: duplicate.receipt,
      }).allowed).toBe(true);
      expect(w.prepared.runner.ownerApprovalHolds(w.prepared.runId, w.prepared.snapshotDigest).allowed).toBe(false);
      expect(gateOf(w).satisfied).toBe(false);
      expect(await w.confirm()).toMatchObject({ allowed: false });
      expect(w.counts()).toMatchObject({ consumptions: 1, githubCalls: 4 });
    } finally {
      await w.close();
    }
  });

  it("S10-R1-02 consumption asks the standalone rule again for the reply link: a stored threaded sentence is EVENT_NOT_STANDALONE", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      const { cp } = w.prepared.harness;
      const scope = w.prepared.runner.approvalScopeOf(w.prepared.runId);
      if (!scope.allowed) throw new Error(scope.message);
      // An answer row as #mint wrote one before this rule, for a reply to the prompt that quotes its token.
      const sentence = w.reply({ prompt, content: `do not use acp-approve-write:${w.promptCode(prompt)} until CI passes` });
      const idempotencyKey = `buzz:repo-factory-github-write:${prompt.id}`;
      const receipt = {
        channel: "buzz",
        actor: w.keys.owner.pubkey,
        inboundNonce: `buzz-approval:${sentence.id}`,
        runId: w.prepared.runId,
        candidateSnapshotDigest: scope.value.candidateSnapshotDigest,
        operation: scope.value.operation,
        parameterDigest: scope.value.parameterDigest,
        idempotencyKey,
        approved: true,
      };
      const envelope = ownerApprovalPayload({
        runId: w.prepared.runId,
        candidateSnapshotDigest: scope.value.candidateSnapshotDigest,
        operation: scope.value.operation,
        parameters: scope.value.parameters,
        idempotencyKey,
        approved: true,
      });
      cp.db.run(`INSERT INTO inbound_messages (channel, nonce, actor, received_at, payload_json) VALUES (?, ?, ?, ?, ?)`, [
        "buzz-owner-approval-answer",
        prompt.id,
        sentence.pubkey,
        cp.clock.nowIso(),
        JSON.stringify({
          schema: "acp.buzz-owner-approval.answer.v1",
          state: "ANSWERED",
          promptEventId: prompt.id,
          approvalEvent: sentence,
          approved: true,
          envelope,
          receipt,
          receiptDigest: digestOf(receipt),
          inboundNonce: receipt.inboundNonce,
          answeredAt: cp.clock.nowIso(),
          outcomeEvent: null,
          link: "REPLY",
        }),
      ]);
      const verdict = w.module!.verifyBuzzApprovalEvidence(cp.db, receipt, { nowMs: cp.clock.now().getTime() });
      expect(verdict).toMatchObject({ allowed: false, evidence: { refusal: "EVENT_NOT_STANDALONE" } });
    } finally {
      await w.close();
    }
  });

  it("S10-R1-02 the bare token in the prompt's thread, padded only by white space, still mints once", async () => {
    const { w, prompt } = await promptedWorld();
    try {
      await w.send(w.reply({ prompt, content: `\n acp-approve-write:${w.promptCode(prompt)}\t\n` }));
      expect(w.counts()).toMatchObject({ answers: 1, receipts: 1, artifacts: 1 });
    } finally {
      await w.close();
    }
  });

  it("S10-R1-03 the owner route asks only for the owner key's events in the prompt's room, and delivers none as a message", async () => {
    const { w, prompt } = await promptedWorld({ xRooms: [ROOM_X, ROOM_OTHER] });
    try {
      const filters = w.relay.requested.map((request) => request.filter);
      expect(filters.filter((filter) => Array.isArray(filter["authors"])).at(-1)).toEqual({
        kinds: [9],
        authors: [w.keys.owner.pubkey],
        "#h": [ROOM_X],
        since: expect.any(Number),
      });
      // The mention REQ is the one it was: X's `#p`, no author.
      expect(filters.filter((filter) => Array.isArray(filter["#p"])).every((filter) => !("authors" in filter))).toBe(true);
      const receive = vi.spyOn(w.approvals!, "receive");
      const parent = finalizeEvent({ kind: 9, created_at: prompt.created_at, tags: [["h", ROOM_X]], content: "CEO: status?" }, w.keys.ceo.secretKey) as BuzzMentionEvent;
      await w.send(underMessage(w, parent, "looks good to me", { createdAt: prompt.created_at + 1 }));
      await w.send(underMessage(w, parent, `acp-approve-write:${w.promptCode(prompt)}`, { author: w.keys.stranger, createdAt: prompt.created_at + 2 }));
      expect(receive.mock.calls.map(([request]) => request.event.pubkey)).toEqual([w.keys.owner.pubkey]);
      expect(w.counts()).toMatchObject({ ...NOTHING_MINTED, refusalRows: 0 });
    } finally {
      await w.close();
    }
  });

  it("S10-R1-04 an exact declaration beside a padded spelling of it links nothing: the noncanonical spelling is refused", async () => {
    const { w, prompt } = await promptedWorld({ humanGate: [T3_GATE_ITEM, `${T3_GATE_ITEM} `] });
    try {
      await w.send(w.reply({ prompt }));
      expect(gateOf(w)).toEqual({ required: true, items: [T3_GATE_ITEM], satisfied: false });
    } finally {
      await w.close();
    }
  });
});

/* eslint-disable no-console -- S10-R2: the review witness RV2-CANDIDATE is kept as written, observation log included. */
describe("RV2 bounded remediation checks", () => {
  it("RV2-CANDIDATE an anchored receipt cannot satisfy a different current candidate", async () => {
    const { w, prompt } = await promptedWorld({ humanGate: [T3_GATE_ITEM] });
    try {
      const { cp } = w.prepared.harness;
      await w.send(w.reply({ prompt }));
      expect((await w.confirm()).reasonCode).toBe(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE);
      expect(gateOf(w).satisfied).toBe(true);
      const candidate = `sha256:${"9".repeat(64)}`;
      cp.db.run(`UPDATE runs SET current_candidate_digest = ? WHERE run_id = ?`, [candidate, w.prepared.runId]);
      const confirm = await w.prepared.runner.produceAndActivateApproved({
        runId: w.prepared.runId, candidateSnapshotDigest: candidate, ceoSessionId: w.prepared.ceoSessionId,
      });
      console.log("RV2-CANDIDATE", JSON.stringify({ gate: gateOf(w), confirm, counts: w.counts() }));
      expect(confirm.allowed).toBe(false);
      expect(gateOf(w).satisfied).toBe(false);
    } finally { await w.close(); }
  });
});
/* eslint-enable no-console */

describe("S10-R2-01: an anchored execution's approval admits only the candidate its anchor names", () => {
  it("S10-R2-01 control: the same candidate, anchored and its ingress admission pruned, still holds for the predicate and the gate", async () => {
    const { w } = await promptedWorld({ humanGate: [T3_GATE_ITEM] });
    try {
      const { cp } = w.prepared.harness;
      // A CLI approval, so the anchored receipt's own ingress admission is in the channel pruned below.
      const approval = ownerApprovalFor(w.prepared);
      expect(w.prepared.runner.recordOwnerApproval(w.prepared.runId, {
        owner: "acme", visibility: "public", planDigest: w.prepared.planDigest,
        approvedManifest: w.prepared.manifest, projectName: w.prepared.manifest.projectId,
        receipt: approval.receipt,
      }).allowed).toBe(true);
      expect((await w.confirm()).reasonCode).toBe(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE);
      const scope = w.prepared.runner.approvalScopeOf(w.prepared.runId);
      if (!scope.allowed) throw new Error(scope.message);
      const anchored = w.prepared.runner.ownerApprovalNeed(w.prepared.runId, scope.value);
      expect(anchored).toMatchObject({ need: "EXECUTION_ANCHORED", receipt: { channel: "cli", candidateSnapshotDigest: w.prepared.snapshotDigest } });
      const receipt = anchored.receipt!;
      expect(digestOf(receipt)).toBe(digestOf(approval.receipt));
      expect(cp.ownerAuthority.assertApproval(receipt).allowed).toBe(true);
      expect(gateOf(w).satisfied).toBe(true);
      // Past the retention window, the next admission prunes the receipt's ingress admission.
      w.prepared.harness.clock.advance(25 * 60 * 60 * 1000);
      const guard = new IngressGuard(cp.db, cp.clock, cp.audit, { cli: { allowedActors: [TEST_OWNER.actor] } });
      expect(guard.admit({ channel: "cli", actor: TEST_OWNER.actor, nonce: "after-retention", payload: null }).allowed).toBe(true);
      expect(cp.ownerAuthority.assertApproval(receipt).allowed).toBe(false);
      expect(cp.runs.currentCandidate(w.prepared.runId)).toBe(w.prepared.snapshotDigest);
      expect(w.prepared.runner.ownerApprovalHolds(w.prepared.runId, w.prepared.snapshotDigest)).toMatchObject({ allowed: true });
      expect(gateOf(w).satisfied).toBe(true);
      expect(w.counts()).toMatchObject({ consumptions: 1, githubCalls: 4 });
    } finally {
      await w.close();
    }
  });

  it("S10-R2-01 control: another candidate is refused by the predicate, the gate and CONFIRM; the anchor's own candidate holds again", async () => {
    const { w, prompt } = await promptedWorld({ humanGate: [T3_GATE_ITEM] });
    try {
      const { cp } = w.prepared.harness;
      await w.send(w.reply({ prompt }));
      expect((await w.confirm()).reasonCode).toBe(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE);
      expect(gateOf(w).satisfied).toBe(true);
      const other = `sha256:${"9".repeat(64)}`;
      const refused = {
        allowed: false,
        evidence: { stage: "approval", refusal: "APPROVAL_NOT_THIS_CANDIDATE", anchoredCandidate: w.prepared.snapshotDigest, candidateSnapshotDigest: other },
      };
      // Asked about another candidate while the run's own is unmoved: the anchor's candidate decides, not the run's.
      expect(w.prepared.runner.ownerApprovalHolds(w.prepared.runId, other)).toMatchObject(refused);
      // The run's candidate moved by a raw edit, its PLAN kept: the gate reads unsatisfied and CONFIRM refuses.
      cp.db.run(`UPDATE runs SET current_candidate_digest = ? WHERE run_id = ?`, [other, w.prepared.runId]);
      expect(w.prepared.runner.ownerApprovalHolds(w.prepared.runId, other)).toMatchObject(refused);
      expect(gateOf(w).satisfied).toBe(false);
      expect(
        await w.prepared.runner.produceAndActivateApproved({ runId: w.prepared.runId, candidateSnapshotDigest: other, ceoSessionId: w.prepared.ceoSessionId }),
      ).toMatchObject({ allowed: false });
      expect(w.counts()).toMatchObject({ consumptions: 1, githubCalls: 4 });
      // The anchor's own candidate restored: the same anchor holds again, so the candidate alone was refused.
      cp.db.run(`UPDATE runs SET current_candidate_digest = ? WHERE run_id = ?`, [w.prepared.snapshotDigest, w.prepared.runId]);
      expect(gateOf(w).satisfied).toBe(true);
    } finally {
      await w.close();
    }
  });
});

/**
 * SEC-OD1-R1-02 — the owner's decisions as the code before SEC-OD1 recorded them: the same admission,
 * consumption and transaction, with the "service" label every decision of that era carries. Since v47
 * `put` refuses that row at the database, so the record is captured in the transaction and, once it
 * commits, written as it stands in a database upgraded from before v47: by a connection outside the
 * guard (`writeOutsideTheGuard`, v47's stated Limit). Restored after `record`, so nothing else in the
 * world is written this way.
 */
const asBeforeSecOd1 = <T>(w: World, record: () => T): T => {
  const { harness } = w.prepared;
  const store = harness.cp.artifacts;
  const canonical = store.putOwnerDecision;
  const captured: Array<{ runId: string; content: unknown; candidate: string }> = [];
  store.putOwnerDecision = ((_writer: unknown, runId: string, content: unknown, candidate: string) => {
    captured.push({ runId, content, candidate });
    // What the caller is handed is never read: recordOwnerDecision ignores the stored artifact.
    return undefined;
  }) as unknown as typeof store.putOwnerDecision;
  let recorded: T;
  try {
    recorded = record();
  } finally {
    store.putOwnerDecision = canonical;
  }
  for (const { runId, content, candidate } of captured) {
    expect(() => store.put(runId, "APPROVAL", content, candidate)).toThrowError(OWNER_DECISION_WRITE_DENIED);
    writeOutsideTheGuard(harness.cp.config.databasePath, runId, content, candidate, harness.clock.nowIso());
  }
  return recorded;
};

const ownerDecisionLabels = (w: World): Array<[unknown, unknown, string]> =>
  w.prepared.harness.cp.artifacts.list<Record<string, unknown>>(w.prepared.runId, "APPROVAL")
    .filter((artifact) => artifact.content["kind"] === "OWNER_DECISION")
    .map((artifact) => [artifact.content["item"], artifact.content["approved"], artifact.producedBy]);

describe("SEC-OD1-R1-02: owner decisions recorded before canonical provenance", () => {
  it("ODLEGACY-REFUSAL an exactly bound refusal recorded before SEC-OD1 still prevents the T3 CONFIRM, with no GitHub write", async () => {
    // The review's reproduction: refused with 0 GitHub calls before SEC-OD1, 4 FakeGitHub writes at 7dab783a.
    const { w, prompt } = await promptedWorld({ humanGate: [T3_GATE_ITEM] });
    try {
      await w.send(w.reply({ prompt }));
      expect(gateOf(w).satisfied).toBe(true);
      expect(asBeforeSecOd1(w, () => ownerDecision(w, T3_GATE_ITEM, false)).allowed).toBe(true);
      expect(ownerDecisionLabels(w)).toEqual([[T3_GATE_ITEM, false, "service"]]);
      const confirmed = await w.confirm();
      const { consumptions, githubCalls } = w.counts();
      // The one consumption is the refusal's own owner_decision_submit receipt; nothing reached GitHub.
      expect({ gate: gateOf(w), confirmed: confirmed.reasonCode, consumptions, githubCalls }).toEqual({
        gate: { required: true, items: [T3_GATE_ITEM], satisfied: false },
        confirmed: ReasonCode.HUMAN_GATE_UNSATISFIED,
        consumptions: 1,
        githubCalls: 0,
      });
    } finally {
      await w.close();
    }
  });

  it("ODLEGACY-CONFIRM an approval recorded before SEC-OD1 does not count, and CONFIRM says the owner must decide again", async () => {
    const { w, prompt } = await promptedWorld({ humanGate: [T3_GATE_ITEM, PROSE_ITEM] });
    try {
      await w.send(w.reply({ prompt }));
      expect(asBeforeSecOd1(w, () => ownerDecision(w, PROSE_ITEM, true)).allowed).toBe(true);
      expect(ownerDecisionLabels(w)).toEqual([[PROSE_ITEM, true, "service"]]);
      expect(gateOf(w)).toEqual({ required: true, items: [T3_GATE_ITEM, PROSE_ITEM], satisfied: false, decideAgain: [PROSE_ITEM] });
      expect(await w.confirm()).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.HUMAN_GATE_UNSATISFIED,
        message: OWNER_DECIDE_AGAIN_MESSAGE,
        evidence: { stage: "precondition", decideAgain: [PROSE_ITEM], remedy: "NEW_OWNER_DECISION" },
      });
      expect(w.counts()).toMatchObject({ consumptions: 1, githubCalls: 0 });
      // The owner decides again through the canonical path, and the item is decided.
      const { harness, runId } = w.prepared;
      const note = "decided again";
      expect(harness.cp.ceo.recordOwnerDecision({
        runId, item: PROSE_ITEM, approved: true, note, receipt: ownerDecisionReceipt(harness, runId, PROSE_ITEM, true, note),
      }).allowed).toBe(true);
      expect(gateOf(w)).toEqual({ required: true, items: [T3_GATE_ITEM, PROSE_ITEM], satisfied: true });
    } finally {
      await w.close();
    }
  });
});
