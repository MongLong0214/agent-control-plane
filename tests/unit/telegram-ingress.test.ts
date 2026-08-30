import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it, vi } from "vitest";

import { startDaemonTelegramListener } from "../../src/daemon/agentcpd.ts";
import { TelegramInterruption } from "../../src/ingress/telegram-router.ts";
import {
  configuredTelegramLongPollConfig,
  TelegramBotApi,
  TelegramDeliveryError,
  type TelegramBotTransport,
} from "../../src/ingress/telegram-polling.ts";
import type { TelegramUpdate } from "../../src/ingress/telegram.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ExecutionMode, Role, RunState, roleKeyFor } from "../../src/domain/types.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import {
  bindCeo,
  driveToReviewedCandidate,
  makeHarness,
  TEST_OWNER,
  registerFixtureProject,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const SECRET = "telegram-configured-secret";
const OWNER_ID = "424242";
const CHAT_ID = "-100999";
let nextFakeTelegramMessageId = 1_000;

const update = (text: string, over: Record<string, unknown> = {}, updateId = 100): TelegramUpdate => ({
  update_id: updateId,
  message: {
    message_id: 7,
    date: 1_700_000_000,
    text,
    from: { id: Number(OWNER_ID), username: "owner" },
    chat: { id: Number(CHAT_ID) },
    ...over,
  },
});

class FakeTelegramTransport implements TelegramBotTransport {
  readonly sendAttempts: Array<{
    chatId: string;
    text: string;
    replyToMessageId?: number;
    correlationId: string;
  }> = [];
  readonly sent: Array<{
    chatId: string;
    text: string;
    replyToMessageId?: number;
    correlationId: string;
  }> = [];
  readonly offsets: Array<number | undefined> = [];
  updates: TelegramUpdate[] = [];
  /** Simulates a known-not-sent server rejection that is safe to retry after backoff. */
  rejectSends = 0;
  /** Simulates an unknown outcome such as a network error or timeout. */
  failSendsAmbiguous = 0;
  /** Fails only owner-gate prompt sends, leaving the reply path working. */
  failOwnerGateSends = false;

  async getUpdates(options: { offset?: number; timeoutSeconds: number }): Promise<readonly TelegramUpdate[]> {
    this.offsets.push(options.offset);
    return this.updates;
  }

  async sendMessage(input: {
    chatId: string;
    text: string;
    replyToMessageId?: number;
    correlationId: string;
  }): Promise<{ messageId: number }> {
    this.sendAttempts.push(input);
    if (this.failOwnerGateSends && input.correlationId.startsWith("telegram:owner-gate:")) {
      throw new TelegramDeliveryError("simulated owner-gate prompt delivery failure", {
        kind: "PERMANENT_REJECTION",
        statusCode: 400,
        description: "Bad Request: owner-gate prompt is unacceptable",
        migrateToChatId: null,
        retryAfterSeconds: null,
      });
    }
    if (this.failSendsAmbiguous > 0) {
      this.failSendsAmbiguous -= 1;
      throw new TelegramDeliveryError("simulated Telegram outage (no response)", {
        kind: "UNKNOWN",
        statusCode: null,
        description: null,
        migrateToChatId: null,
        retryAfterSeconds: null,
      });
    }
    if (this.rejectSends > 0) {
      this.rejectSends -= 1;
      throw new TelegramDeliveryError("simulated Telegram service rejection", {
        kind: "RETRYABLE",
        statusCode: 503,
        description: "Service Unavailable",
        migrateToChatId: null,
        retryAfterSeconds: null,
      });
    }
    this.sent.push(input);
    return { messageId: nextFakeTelegramMessageId++ };
  }
}

const telegramConfig = {
  botToken: "fake-bot-token",
  allowedOwnerIds: [OWNER_ID],
  allowedChatIds: [CHAT_ID],
  webhookSecret: SECRET,
  pollTimeoutSeconds: 1,
  retryDelayMs: 1,
} as const;

const daemonStub = { finalizeApprovedRun: async (_runId: string): Promise<void> => undefined };

interface TelegramApiCall {
  method: "getUpdates" | "sendMessage";
  body: Record<string, unknown>;
}

const telegramBotApiFixture = (
  updates: readonly TelegramUpdate[],
  firstSendResponse: { status: number; body: Record<string, unknown> },
  options: { persistentlyRejectReplyToMessageId?: number } = {},
): { transport: TelegramBotApi; calls: TelegramApiCall[] } => {
  const calls: TelegramApiCall[] = [];
  let sendCount = 0;
  const fetcher: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = url.endsWith("/getUpdates") ? "getUpdates" : "sendMessage";
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ method, body });
    if (method === "getUpdates") {
      const offset = typeof body["offset"] === "number" ? body["offset"] : 0;
      const result = updates.filter((candidate) => candidate.update_id >= offset).slice(0, 100);
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    }
    sendCount += 1;
    if (
      sendCount === 1
      || body["reply_to_message_id"] === options.persistentlyRejectReplyToMessageId
    ) {
      return new Response(JSON.stringify(firstSendResponse.body), { status: firstSendResponse.status });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: nextFakeTelegramMessageId++ } }), {
      status: 200,
    });
  };
  return { transport: new TelegramBotApi("fixture-bot-token", { fetcher }), calls };
};

const createOwnerGateSignal = (
  harness: ReturnType<typeof makeHarness>,
  registered: Awaited<ReturnType<typeof registerFixtureProject>>,
  suffix: string,
) => {
  const parked = harness.cp.runs.create({
    projectId: registered.projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: {
      goal: `owner gate ${suffix}`,
      why: "Telegram batch continuation regression fixture",
      scope: ["telegram"],
      nonGoals: [],
      acceptance: ["the owner gate follows the batch delivery policy"],
      priority: "NORMAL",
      humanGate: [],
      references: [],
    },
    repositories: [
      { repositoryId: registered.repositoryId, repositoryRole: "primary", baseBranch: "dev" },
    ],
  });
  if (!parked.allowed) throw new Error(parked.message);
  const candidateSnapshotDigest = `sha256:${suffix.repeat(64).slice(0, 64)}`;
  harness.cp.runs.promoteCandidate(parked.value.runId, candidateSnapshotDigest);
  return {
    signalId: `signal-${suffix}`,
    runId: parked.value.runId,
    items: ["owner confirms"],
    candidateSnapshotDigest,
  };
};

describe("Telegram production ingress", () => {
  it("the daemon itself delivers the queued dispatch over Buzz", async () => {
    // The claim the previous test used to make by calling deliverPending() itself. Deleting
    // the daemon's entire buzz_delivery timer left all 820 tests passing, so CTO dispatch
    // could have stopped reaching Buzz with nothing to notice. This drives a real daemon and
    // waits for its own timer.
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    // The startup doctor refuses dispatch resume without these; makeStartedOperator does the
    // same two steps before starting a daemon.
    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    bindCeo(harness);
    const registered = await registerFixtureProject(harness);
    const transport = new FakeTelegramTransport();
    transport.updates = [update(`/managed ${registered.projectId} implement the requested change`)];
    const listener = await startDaemonTelegramListener(
      harness.cp,
      { ...telegramConfig, defaultProjectId: registered.projectId },
      daemonStub,
      { transport, start: false },
    );

    const daemon = new Daemon(harness.cp, {
      stateDir: tempDir("acp-buzz-delivery-"),
      buzz: harness.buzzAdapter,
      deliveryIntervalMs: 10,
    });

    try {
      const cycle = await listener.service.pollOnce();
      const runId = cycle.outcomes[0]?.runId;
      expect(runId).toBeTruthy();
      const pending = harness.cp.outbox
        .listByRun(runId!)
        .filter((message) => message.kind === "RUN_DISPATCH");
      expect(pending).toHaveLength(1);
      expect(harness.buzz.sent).toHaveLength(0);

      const started = await daemon.start();
      expect(started.allowed).toBe(true);

      const deadline = Date.now() + 10_000;
      while (harness.buzz.sent.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(harness.buzz.sent, "the daemon never delivered the queued dispatch").toHaveLength(1);
      expect(harness.buzz.sent[0]?.content).toContain(runId!);
    } finally {
      await daemon.stop();
      await listener.close();
    }
  }, 30_000);

  it("bootstraps through the daemon-owned Telegram factory and queues a Buzz dispatch", async () => {
    const agentcpdSource = readFileSync(
      fileURLToPath(new URL("../../src/daemon/agentcpd.ts", import.meta.url)),
      "utf8",
    );
    // This is a composition-root assertion only; the behavior below still runs the factory.
    expect(agentcpdSource).toContain("telegram = await startDaemonTelegramListener(cp, telegramConfig, daemon");

    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const registered = await registerFixtureProject(harness);
    const transport = new FakeTelegramTransport();
    transport.updates = [update(`/managed ${registered.projectId} implement the requested change` )];
    const listener = await startDaemonTelegramListener(
      harness.cp,
      { ...telegramConfig, defaultProjectId: registered.projectId },
      daemonStub,
      { transport, start: false },
    );

    try {
      const cycle = await listener.service.pollOnce();
      const outcome = cycle.outcomes[0]!;
      expect(outcome.admitted).toBe(true);
      expect(outcome.classification).toBe("MANAGED");
      expect(outcome.runId).toBeTruthy();

      const run = harness.cp.runs.require(outcome.runId!);
      const dispatch = harness.cp.outbox.listByRun(run.runId).filter((message) => message.kind === "RUN_DISPATCH");
      expect(dispatch).toHaveLength(1);
      expect(dispatch[0]?.status).toBe("PENDING");

      // Delivery is deliberately not exercised here. Constructing a BuzzAdapter and calling
      // deliverPending() proved that this test can deliver, not that anything in production
      // does — the daemon's timer would have been deletable with the suite still green.
      // That claim now lives in its own test below, driven by a real daemon.
    } finally {
      await listener.close();
    }
  });

  it.each([
    ["forward_from_chat", { forward_from_chat: { id: -100777 } }],
    ["forward_sender_name", { forward_sender_name: "Someone Else" }],
    ["forward_date", { forward_date: 1_700_000_000 }],
  ])("treats a forward carrying only %s as forwarded, not as an owner command", async (_marker, markers) => {
    // forward_origin replaced these, but Telegram still sends them to clients that have not
    // migrated. isForwarded read only the new field, so a message carrying an older marker read
    // as authored — and a forwarded `/managed …` from an allowlisted owner created a run.
    //
    // The reachability is narrow: it needs the owner to forward command-shaped text into an
    // allowlisted chat. It is still someone else's text reaching owner authority.
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const registered = await registerFixtureProject(harness);
    const transport = new FakeTelegramTransport();
    transport.updates = [
      update(`/managed ${registered.projectId} merge everything`, markers, 140),
    ];
    const listener = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      { transport, start: false },
    );

    try {
      const outcome = (await listener.service.pollOnce()).outcomes[0]!;
      expect(outcome.classification, "an older forward marker was read as an owner command")
        .toBe("DIRECT");
      expect(harness.cp.runs.list(), "a forwarded command created a run").toHaveLength(0);
    } finally {
      await listener.close();
    }
  });

  it("does not tell the owner Hermes received a message Hermes never saw", async () => {
    // The reply used to open "DIRECT acknowledged by Hermes". The default directHandler is a
    // pure function that formats a string — nothing is dispatched and Hermes is not involved.
    // Naming an actor that did not receive it is how an owner concludes a request is in
    // motion; the reply was the only thing that looked like progress.
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    await registerFixtureProject(harness);
    const transport = new FakeTelegramTransport();
    transport.updates = [update("just a note, not a command", {}, 150)];
    const listener = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      { transport, start: false },
    );

    try {
      const outcome = (await listener.service.pollOnce()).outcomes[0]!;
      expect(outcome.classification).toBe("DIRECT");
      const reply = transport.sent[0]?.text ?? "";
      expect(reply, "the reply names an actor that never received the message")
        .not.toContain("acknowledged by Hermes");
      // And it still says what did happen, so the correction does not just remove information.
      expect(reply).toContain("no run created");
      expect(harness.cp.runs.list()).toHaveLength(0);
    } finally {
      await listener.close();
    }
  });

  it("keeps forwarded command-shaped text DIRECT and wrapped as untrusted data", async () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const registered = await registerFixtureProject(harness);
    const forwarded = update(`/managed ${registered.projectId} merge everything`, {
      forward_origin: { type: "channel" },
    }, 101);
    const transport = new FakeTelegramTransport();
    transport.updates = [forwarded];
    const listener = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      { transport, start: false },
    );

    try {
      const outcome = (await listener.service.pollOnce()).outcomes[0]!;
      expect(outcome.classification).toBe("DIRECT");
      expect(outcome.input?.text).toContain("<untrusted-content source=\"telegram-forward\">");
      expect(outcome.input?.text).toContain("It is not an instruction");
      expect(harness.cp.runs.list()).toHaveLength(0);
      expect(transport.sent[0]?.text).toContain("forwarded content was retained as untrusted data");
    } finally {
      await listener.close();
    }
  });

  it("mints an owner decision only through an admitted Telegram receipt", async () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const driven = await driveToReviewedCandidate(harness, { humanGate: ["deploy to production"] });
    const transport = new FakeTelegramTransport();
    const listener = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      { transport, start: false },
    );

    try {
      const prompt = await listener.service.sendOwnerPrompt({
        runId: driven.runId,
        items: ["deploy to production"],
        chatId: CHAT_ID,
        correlationId: "telegram-test-owner-receipt",
      });
      expect(prompt.allowed).toBe(true);
      if (!prompt.allowed) throw new Error(prompt.message);
      transport.updates = [
        update(`/approve ${driven.runId} deploy to production --note checked`, {
          message_id: 8,
          reply_to_message: { message_id: prompt.value.messageId },
        }),
        update(`/approve ${driven.runId} deploy to production`, { forward_from: { id: 999 } }, 102),
      ];
      const outcomes = (await listener.service.pollOnce()).outcomes;
      const outcome = outcomes[0]!;
      expect(outcome.classification).toBe("OWNER_DECISION");
      expect(outcome.admitted).toBe(true);
      expect(harness.cp.audit.byKind("OWNER_APPROVAL_INGRESS")).toHaveLength(1);
      expect(outcome.reply?.text).toContain("OWNER DECISION recorded: APPROVED");

      const forwardedOutcome = outcomes[1]!;
      expect(forwardedOutcome.classification).toBe("DIRECT");
      expect(harness.cp.audit.byKind("OWNER_APPROVAL_INGRESS")).toHaveLength(1);
    } finally {
      await listener.close();
    }
  });

  it("tells the Telegram owner when the candidate moved after the approval was minted", async () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const driven = await driveToReviewedCandidate(harness, { humanGate: ["public release"] });
    const candidateB = digestOf({ revisedFrom: driven.candidateSnapshotDigest, revision: "telegram-stale" });

    const transport = new FakeTelegramTransport();
    const listener = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      { transport, start: false },
    );

    try {
      const prompt = await listener.service.sendOwnerPrompt({
        runId: driven.runId,
        items: ["public release"],
        chatId: CHAT_ID,
        correlationId: "telegram-test-candidate-moved",
      });
      expect(prompt.allowed).toBe(true);
      if (!prompt.allowed) throw new Error(prompt.message);
      expect(prompt.value.candidateSnapshotDigest).toBe(driven.candidateSnapshotDigest);
      harness.cp.runs.promoteCandidate(driven.runId, candidateB);
      transport.updates = [update(`/approve ${driven.runId} public release`, {
        message_id: 8,
        reply_to_message: { message_id: prompt.value.messageId },
      }, 103)];
      const outcome = (await listener.service.pollOnce()).outcomes[0]!;
      expect(outcome.admitted).toBe(true);
      expect(outcome.reasonCode).toBe(ReasonCode.EVIDENCE_STALE);
      expect(outcome.reply?.text).toContain("candidate moved");
      expect(harness.cp.artifacts.list(driven.runId, "APPROVAL")).toHaveLength(0);
    } finally {
      await listener.close();
    }
  });

  it("binds a Telegram reply to prompt candidate A after candidate B is promoted", async () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const driven = await driveToReviewedCandidate(harness, { humanGate: ["public release"] });
    await harness.cp.continuity.evaluate("telegram prompt candidate A");
    const packet = harness.cp.ceo.buildPacket({
      runId: driven.runId,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      approval: {
        runId: driven.runId,
        candidateSnapshotDigest: driven.candidateSnapshotDigest,
        resultSummary: "candidate verified",
        recommendation: "merge",
        residualRisk: [],
        approvedBySessionId: driven.ownerSessionId,
        approvedByGeneration: driven.ownerBindingGeneration,
        approvedAt: harness.clock.nowIso(),
      },
    });
    expect(packet.allowed).toBe(true);
    const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO));
    expect(ceo).toBeTruthy();
    const requested = harness.cp.ceo.submitCeoDecision({
      runId: driven.runId,
      decision: "OWNER_DECISION_REQUIRED",
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      ceoSessionId: ceo!.sessionId,
      rationale: "owner must decide on candidate A",
    });
    expect(requested.allowed).toBe(true);

    const originalCurrentCandidate = harness.cp.runs.currentCandidate.bind(harness.cp.runs);
    let currentCandidateReads = 0;
    vi.spyOn(harness.cp.runs, "currentCandidate").mockImplementation((runId) => {
      currentCandidateReads += 1;
      return originalCurrentCandidate(runId);
    });
    const transport = new FakeTelegramTransport();
    const listener = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      { transport, start: false, ownerGateSignals: () => [] },
    );

    try {
      const prompt = await listener.service.sendOwnerPrompt({
        runId: driven.runId,
        items: ["public release"],
        chatId: CHAT_ID,
        correlationId: "telegram-test-prompt-A",
      });
      expect(prompt.allowed).toBe(true);
      if (!prompt.allowed) throw new Error(prompt.message);
      expect(prompt.value.candidateSnapshotDigest).toBe(driven.candidateSnapshotDigest);
      expect(harness.cp.db.get<{ candidate_snapshot_digest: string }>(
        `SELECT candidate_snapshot_digest FROM telegram_owner_prompts
          WHERE chat_id = ? AND message_id = ?`,
        [CHAT_ID, prompt.value.messageId],
      )).toEqual({ candidate_snapshot_digest: driven.candidateSnapshotDigest });

      currentCandidateReads = 0;
      const candidateB = digestOf({ revisedFrom: driven.candidateSnapshotDigest, revision: "telegram-prompt-A" });
      harness.cp.runs.promoteCandidate(driven.runId, candidateB);
      transport.updates = [update(`/approve ${driven.runId} public release`, {
        message_id: 9,
        reply_to_message: { message_id: prompt.value.messageId },
      }, 104)];

      const outcome = (await listener.service.pollOnce()).outcomes[0]!;
      expect(outcome.reasonCode).toBe(ReasonCode.EVIDENCE_STALE);
      expect(outcome.reply?.text).toContain("candidate moved");
      expect(harness.cp.artifacts.list(driven.runId, "APPROVAL")
        .filter((artifact) => artifact.candidateSnapshotDigest === candidateB)).toHaveLength(0);
      expect(harness.cp.artifacts.list<{ kind?: string }>(driven.runId, "APPROVAL")
        .filter((artifact) => artifact.content.kind === "OWNER_DECISION")).toHaveLength(0);
      expect(harness.cp.audit.byKind("OWNER_APPROVAL_CONSUMED")).toHaveLength(0);
      // The reply resolves the durable prompt record; it never samples the current candidate.
      expect(currentCandidateReads).toBe(0);
    } finally {
      await listener.close();
    }
  });

  it("emits one production prompt per item across polls and restart, then re-prompts a new candidate", async () => {
    const gateItem = "public release";
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const driven = await driveToReviewedCandidate(harness, { humanGate: [gateItem] });
    await harness.cp.continuity.evaluate("telegram production prompt idempotency");
    const packet = harness.cp.ceo.buildPacket({
      runId: driven.runId,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      approval: {
        runId: driven.runId,
        candidateSnapshotDigest: driven.candidateSnapshotDigest,
        resultSummary: "candidate verified",
        recommendation: "merge",
        residualRisk: [],
        approvedBySessionId: driven.ownerSessionId,
        approvedByGeneration: driven.ownerBindingGeneration,
        approvedAt: harness.clock.nowIso(),
      },
    });
    expect(packet.allowed).toBe(true);
    const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO));
    expect(ceo).toBeTruthy();
    const parked = harness.cp.ceo.submitCeoDecision({
      runId: driven.runId,
      decision: "OWNER_DECISION_REQUIRED",
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      ceoSessionId: ceo!.sessionId,
      rationale: "owner must decide on the production candidate",
    });
    expect(parked.allowed).toBe(true);

    const firstTransport = new FakeTelegramTransport();
    const firstListener = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      { transport: firstTransport, start: false },
    );
    let promptA: { messageId: number; candidateSnapshotDigest: string } | null = null;
    try {
      await firstListener.service.pollOnce();
      expect(firstTransport.sent).toHaveLength(1);
      const promptRow = harness.cp.db.get<{ message_id: number; candidate_snapshot_digest: string }>(
        `SELECT message_id, candidate_snapshot_digest FROM telegram_owner_prompts
          WHERE run_id = ? ORDER BY created_at ASC LIMIT 1`,
        [driven.runId],
      );
      expect(promptRow).toBeTruthy();
      promptA = promptRow
        ? { messageId: promptRow.message_id, candidateSnapshotDigest: promptRow.candidate_snapshot_digest }
        : null;
      const reservation = harness.cp.db.get<{ result_json: string }>(
        `SELECT result_json FROM inbound_messages
          WHERE channel = 'telegram-owner-prompt'`,
      );
      expect(reservation).toBeTruthy();
      expect(JSON.parse(reservation!.result_json)).toMatchObject({
        kind: "TELEGRAM_OWNER_PROMPT",
        status: "APPLIED",
        candidateSnapshotDigest: driven.candidateSnapshotDigest,
      });
      await firstListener.service.pollOnce();
      expect(firstTransport.sent).toHaveLength(1);
    } finally {
      await firstListener.close();
    }
    expect(promptA?.candidateSnapshotDigest).toBe(driven.candidateSnapshotDigest);

    const restartTransport = new FakeTelegramTransport();
    const restarted = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      { transport: restartTransport, start: false },
    );
    try {
      await restarted.service.pollOnce();
      expect(restartTransport.sent).toHaveLength(0);
    } finally {
      await restarted.close();
    }

    const candidateB = digestOf({ revisedFrom: driven.candidateSnapshotDigest, revision: "telegram-new-prompt" });
    harness.cp.runs.promoteCandidate(driven.runId, candidateB);
    const changedTransport = new FakeTelegramTransport();
    const changed = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      { transport: changedTransport, start: false },
    );
    try {
      changedTransport.updates = [update(`/approve ${driven.runId} ${gateItem}`, {
        message_id: 12,
        reply_to_message: { message_id: promptA!.messageId },
      }, 106)];
      const outcome = (await changed.service.pollOnce()).outcomes[0]!;
      // By content, not by position. pollOnce now receives before it sends prompts, so the
      // reply to this update is the first send and the re-prompt follows it. What the test
      // means is that the new candidate was prompted during this poll, which is what this
      // asserts; the old index assumed a send order that outbound-first happened to produce.
      expect(changedTransport.sent.some((message) => message.text.includes(candidateB))).toBe(true);
      expect(outcome.reasonCode).toBe(ReasonCode.EVIDENCE_STALE);
      expect(outcome.reply?.text).toContain("candidate moved");
    } finally {
      await changed.close();
    }
    expect(harness.cp.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM telegram_owner_prompts
        WHERE run_id = ? AND candidate_snapshot_digest = ?`,
      [driven.runId, candidateB],
    )?.n).toBe(1);
  });

  it("refuses a Telegram approval that cannot resolve to a recorded prompt", async () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const driven = await driveToReviewedCandidate(harness, { humanGate: ["public release"] });
    const transport = new FakeTelegramTransport();
    transport.updates = [update(`/approve ${driven.runId} public release`, {
      message_id: 10,
      reply_to_message: { message_id: 999_999 },
    }, 105)];
    const listener = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      { transport, start: false },
    );

    try {
      const outcome = (await listener.service.pollOnce()).outcomes[0]!;
      expect(outcome.reasonCode).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);
      expect(outcome.reply?.text).toContain("does not identify a recorded gate prompt");
      expect(harness.cp.audit.byKind("OWNER_APPROVAL_INGRESS")).toHaveLength(0);
      expect(harness.cp.artifacts.list(driven.runId, "APPROVAL")).toHaveLength(0);
    } finally {
      await listener.close();
    }
  });

  it("does not send a second response or rerun Hermes when an update is replayed", async () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const registered = await registerFixtureProject(harness);
    const firstTransport = new FakeTelegramTransport();
    const firstUpdate = update(`/managed ${registered.projectId} inspect the project`, {}, 200);
    firstTransport.updates = [firstUpdate];
    const firstListener = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      { transport: firstTransport, start: false },
    );
    try {
      await firstListener.service.pollOnce();
    } finally {
      await firstListener.close();
    }
    expect(firstTransport.sent).toHaveLength(1);
    const stored = harness.cp.db.get<{ result_json: string | null }>(
      `SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
      ["update:200"],
    );
    expect(stored?.result_json).toContain("telegram:200:7");
    expect(stored?.result_json).toContain("\"sent\":true");

    // A restarted poller starts without an in-memory offset. The durable ingress nonce and
    // stored sent response suppress the replay, rather than creating a second run or reply.
    const secondTransport = new FakeTelegramTransport();
    secondTransport.updates = [firstUpdate];
    const secondListener = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      { transport: secondTransport, start: false },
    );
    try {
      const replay = (await secondListener.service.pollOnce()).outcomes[0]!;
      expect(replay.replayed).toBe(true);
      expect(replay.reply).toBeNull();
      expect(secondTransport.sent).toHaveLength(0);
      expect(harness.cp.runs.list()).toHaveLength(1);
    } finally {
      await secondListener.close();
    }
  });

  it("does not run the CEO turn a second time when the daemon dies after it and before the reply", async () => {
    // The recovery path re-admits an update whose workflow is still ADMITTED, which is right for
    // a handler that only formats a reply. The DIRECT handler is not that any more: in production
    // it reaches the CEO, whose reply command resumes the owner's own conversation. Running it
    // twice appends the same exchange twice to a transcript carried forward as context, and
    // neither the owner nor the CEO can tell it happened.
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const turns: string[] = [];
    const crashingTurn = async (input: { text: string }): Promise<string> => {
      // Ordered so the turn is recorded before the failure: this stands for the CEO having
      // already written to the canonical session when the process goes away.
      turns.push(input.text);
      throw new TelegramInterruption("after-dispatch");
    };

    const firstTransport = new FakeTelegramTransport();
    const owed = update("어떻게 돼가?", {}, 700);
    firstTransport.updates = [owed];
    const first = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
      transport: firstTransport,
      start: false,
      onDirect: crashingTurn,
    });
    try {
      await expect(first.service.pollOnce()).rejects.toBeInstanceOf(TelegramInterruption);
    } finally {
      await first.close();
    }
    expect(turns).toEqual(["어떻게 돼가?"]);

    const secondTransport = new FakeTelegramTransport();
    secondTransport.updates = [owed];
    const second = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
      transport: secondTransport,
      start: false,
      onDirect: crashingTurn,
    });
    try {
      const resumed = await second.service.pollOnce();

      // The assertion that matters is the handler count, not the reason code. A test that only
      // checked the code would pass against an implementation that refused *and* ran.
      expect(turns).toEqual(["어떻게 돼가?"]);
      expect(resumed.outcomes[0]?.reasonCode).toBe(ReasonCode.INGRESS_TURN_OUTCOME_UNKNOWN);
    } finally {
      await second.close();
    }
  });

  it("parks a resend instead of running a second CEO turn while the conversation's first is unresolved", async () => {
    // #641: the crash above leaves an unresolved turn, but the owner does not know that — Telegram
    // will not resend the lost update, so what arrives next is the owner typing the same words
    // again. That is a genuinely new update: its own nonce, its own turn id. Nothing about its
    // *identity* says it is a duplicate of the first — the duplication is that a person meant it
    // as one, and only a lookup by conversation (not by nonce) can see that.
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const turns: string[] = [];
    const crashingTurn = async (input: { text: string }): Promise<string> => {
      turns.push(input.text);
      throw new TelegramInterruption("after-dispatch");
    };

    const firstTransport = new FakeTelegramTransport();
    const lost = update("배포 상태 알려줘", {}, 710);
    firstTransport.updates = [lost];
    const first = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
      transport: firstTransport,
      start: false,
      onDirect: crashingTurn,
    });
    try {
      await expect(first.service.pollOnce()).rejects.toBeInstanceOf(TelegramInterruption);
    } finally {
      await first.close();
    }
    expect(turns).toEqual(["배포 상태 알려줘"]);

    // The resend: same words, a fresh Telegram update id — exactly what a person retyping (or
    // Telegram's client resending on "send again") produces.
    const resendTransport = new FakeTelegramTransport();
    const resent = update("배포 상태 알려줘", {}, 711);
    resendTransport.updates = [resent];
    const resendListener = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
      transport: resendTransport,
      start: false,
      onDirect: crashingTurn,
    });
    try {
      const outcome = await resendListener.service.pollOnce();

      // The assertion that matters, as above: the handler count. A fix that refused the resend's
      // *reply* while still invoking the CEO handler would pass a reason-code-only check and
      // still duplicate the transcript.
      expect(turns, "a second, honest CEO turn started for a conversation with an unresolved one")
        .toEqual(["배포 상태 알려줘"]);
      expect(outcome.outcomes[0]?.reasonCode).toBe(ReasonCode.INGRESS_TURN_UNRESOLVED_CONVERSATION);
      expect(outcome.outcomes[0]?.admitted).toBe(true);
      expect(outcome.outcomes[0]?.reply?.text).toContain("/again");

      // Parked, not silently swallowed: the row exists and was never claimed, so it remains
      // reachable — the owner's words were not dropped.
      const parkedRow = harness.cp.db.get<{ turn_claim_json: string | null }>(
        `SELECT turn_claim_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
        ["update:711"],
      );
      expect(parkedRow?.turn_claim_json).toBeNull();
    } finally {
      await resendListener.close();
    }
  });

  it("does not park a DIRECT message from an unrelated conversation", async () => {
    // The lookup is scoped by sessionDigest = digestOf({ channel, conversation }). An unresolved
    // turn in one chat must never hold up a different chat that happens to share nothing but a
    // poll cycle.
    const secondChat = "-100777";
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const turns: string[] = [];
    const crashingTurn = async (input: { text: string }): Promise<string> => {
      turns.push(input.text);
      throw new TelegramInterruption("after-dispatch");
    };
    const config = { ...telegramConfig, allowedChatIds: [CHAT_ID, secondChat] };

    const firstTransport = new FakeTelegramTransport();
    const lost = update("첫번째 대화", {}, 712);
    firstTransport.updates = [lost];
    const first = await startDaemonTelegramListener(harness.cp, config, daemonStub, {
      transport: firstTransport,
      start: false,
      onDirect: crashingTurn,
    });
    try {
      await expect(first.service.pollOnce()).rejects.toBeInstanceOf(TelegramInterruption);
    } finally {
      await first.close();
    }

    const otherTransport = new FakeTelegramTransport();
    const otherChat = update("다른 대화의 새 메시지", { chat: { id: Number(secondChat) } }, 713);
    otherTransport.updates = [otherChat];
    const otherListener = await startDaemonTelegramListener(harness.cp, config, daemonStub, {
      transport: otherTransport,
      start: false,
      onDirect: () => "답",
    });
    try {
      const outcome = await otherListener.service.pollOnce();
      expect(outcome.outcomes[0]?.reasonCode).toBe(ReasonCode.OK);
      expect(outcome.outcomes[0]?.reply?.text).not.toContain("parked");
    } finally {
      await otherListener.close();
    }
  });

  it("/again lets the owner deliberately run a second turn over an unresolved one, and records the choice", async () => {
    // A fix that only ever refuses would make an unresolved turn a lockout: #672 already
    // establishes that a claimed turn whose handler never replies stays unresolved with no
    // operator door today. This is the escape that does not depend on #672 landing first — the
    // owner chooses explicitly, and the choice is written onto the new claim itself.
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const turns: string[] = [];
    const crashingTurn = async (input: { text: string }): Promise<string> => {
      turns.push(input.text);
      throw new TelegramInterruption("after-dispatch");
    };

    const firstTransport = new FakeTelegramTransport();
    const lost = update("배포 다시 확인해줘", {}, 720);
    firstTransport.updates = [lost];
    const first = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
      transport: firstTransport,
      start: false,
      onDirect: crashingTurn,
    });
    try {
      await expect(first.service.pollOnce()).rejects.toBeInstanceOf(TelegramInterruption);
    } finally {
      await first.close();
    }
    expect(turns).toEqual(["배포 다시 확인해줘"]);

    const againTransport = new FakeTelegramTransport();
    const again = update("/again 배포 다시 확인해줘", {}, 721);
    againTransport.updates = [again];
    const againListener = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
      transport: againTransport,
      start: false,
      onDirect: (input: { text: string }) => {
        turns.push(input.text);
        return "확인함";
      },
    });
    try {
      const outcome = await againListener.service.pollOnce();
      expect(turns).toEqual(["배포 다시 확인해줘", "배포 다시 확인해줘"]);
      expect(outcome.outcomes[0]?.reasonCode).toBe(ReasonCode.OK);

      const claimRow = harness.cp.db.get<{ turn_claim_json: string | null }>(
        `SELECT turn_claim_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
        ["update:721"],
      );
      const claim = claimRow?.turn_claim_json ? JSON.parse(claimRow.turn_claim_json) : null;
      expect(claim?.overriddenUnresolvedNonce, "the deliberate override was not recorded on the claim")
        .toBe("update:720");
    } finally {
      await againListener.close();
    }
  });

  it("tells an unknown outcome apart from an ordinary replay", async () => {
    // Both are "this update came back". They need different responses: a replay means the work
    // was done and this copy is redundant, an unknown outcome means nobody knows whether it was.
    // One code for both would file every occurrence of the second inside the first.
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const transport = new FakeTelegramTransport();
    const answered = update("완료되는 메시지", {}, 701);
    transport.updates = [answered];
    const listener = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
      transport,
      start: false,
      onDirect: () => "답",
    });
    try {
      const firstPass = await listener.service.pollOnce();
      expect(firstPass.outcomes[0]?.reasonCode).toBe(ReasonCode.OK);

      // A fresh listener, because the first one advanced its offset past this update and would
      // skip it — the replay this is about is one Telegram hands back after a restart.
      const replayTransport = new FakeTelegramTransport();
      replayTransport.updates = [answered];
      const replayListener = await startDaemonTelegramListener(
        harness.cp, telegramConfig, daemonStub,
        { transport: replayTransport, start: false, onDirect: () => "답" },
      );
      const replay = await replayListener.service.pollOnce();
      await replayListener.close();

      expect(replay.outcomes[0]?.reasonCode).toBe(ReasonCode.INGRESS_REPLAY_IGNORED);
      expect(replay.outcomes[0]?.reasonCode).not.toBe(ReasonCode.INGRESS_TURN_OUTCOME_UNKNOWN);
    } finally {
      await listener.close();
    }
  });

  it("crashes after admission, Hermes create, dispatch, and before reply, then resumes exactly once", async () => {
    const interruptionPoints = ["after-admission", "after-hermes-create", "after-dispatch"] as const;

    for (const point of interruptionPoints) {
      const harness = makeHarness({
        ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
      });
      const registered = await registerFixtureProject(harness);
      const firstTransport = new FakeTelegramTransport();
      const firstUpdate = update(`/managed ${registered.projectId} inspect the project`, {}, 300);
      firstTransport.updates = [firstUpdate];
      let interrupted = false;
      const firstListener = await startDaemonTelegramListener(
        harness.cp,
        telegramConfig,
        daemonStub,
        {
          transport: firstTransport,
          start: false,
          onInterrupt: async (actualPoint) => {
            if (!interrupted && actualPoint === point) {
              interrupted = true;
              throw new TelegramInterruption(actualPoint);
            }
          },
        },
      );

      try {
        await expect(firstListener.service.pollOnce()).rejects.toMatchObject({ point });
      } finally {
        await firstListener.close();
      }

      const secondTransport = new FakeTelegramTransport();
      secondTransport.updates = [firstUpdate];
      const secondListener = await startDaemonTelegramListener(
        harness.cp,
        telegramConfig,
        daemonStub,
        { transport: secondTransport, start: false },
      );
      try {
        const resumed = await secondListener.service.pollOnce();
        expect(resumed.outcomes[0]?.admitted).toBe(true);
        expect(resumed.outcomes[0]?.reply).toBeTruthy();
      } finally {
        await secondListener.close();
      }

      const runs = harness.cp.runs.list();
      expect(runs).toHaveLength(1);
      const dispatches = harness.cp.outbox.listByRun(runs[0]!.runId)
        .filter((message) => message.kind === "RUN_DISPATCH");
      expect(dispatches).toHaveLength(1);
      expect(secondTransport.sent).toHaveLength(1);
    }

    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const registered = await registerFixtureProject(harness);
    const firstTransport = new FakeTelegramTransport();
    const firstUpdate = update(`/managed ${registered.projectId} inspect the project`, {}, 301);
    firstTransport.updates = [firstUpdate];
    firstTransport.rejectSends = 1;
    const firstListener = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      { transport: firstTransport, start: false },
    );
    try {
      await expect(firstListener.service.pollOnce()).rejects.toThrow("simulated Telegram service rejection");
    } finally {
      await firstListener.close();
    }

    const pending = harness.cp.db.get<{ result_json: string | null }>(
      `SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
      ["update:301"],
    );
    expect(pending?.result_json).toContain('"sent":false');

    const secondTransport = new FakeTelegramTransport();
    secondTransport.updates = [firstUpdate];
    const secondListener = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      { transport: secondTransport, start: false },
    );
    try {
      const resumed = await secondListener.service.pollOnce();
      expect(resumed.outcomes[0]?.replayed).toBe(true);
      expect(resumed.outcomes[0]?.reply).toBeTruthy();
    } finally {
      await secondListener.close();
    }

    const runs = harness.cp.runs.list();
    expect(runs).toHaveLength(1);
    expect(harness.cp.outbox.listByRun(runs[0]!.runId).filter((message) => message.kind === "RUN_DISPATCH"))
      .toHaveLength(1);
    expect(firstTransport.sent.length + secondTransport.sent.length).toBe(1);
    const completed = harness.cp.db.get<{ result_json: string | null }>(
      `SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
      ["update:301"],
    );
    expect(completed?.result_json).toContain('"sent":true');
  });

  it("a crash after send consumes the same bounded unknown retry policy", async () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const registered = await registerFixtureProject(harness);
    const firstTransport = new FakeTelegramTransport();
    const firstUpdate = update(`/managed ${registered.projectId} inspect the project`, {}, 302);
    firstTransport.updates = [firstUpdate];
    const firstListener = await startDaemonTelegramListener(
      harness.cp,
      { ...telegramConfig, defaultProjectId: registered.projectId },
      daemonStub,
      {
        transport: firstTransport,
        start: false,
        onInterrupt: async (point) => {
          if (point === "after-reply-send") throw new TelegramInterruption(point);
        },
      },
    );

    try {
      await expect(firstListener.service.pollOnce()).rejects.toMatchObject({ point: "after-reply-send" });
    } finally {
      await firstListener.close();
    }
    expect(firstTransport.sent).toHaveLength(1);
    const pending = harness.cp.db.get<{ result_json: string | null }>(
      `SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
      ["update:302"],
    );
    expect(pending?.result_json).toContain('"deliveryStatus":"PENDING"');
    expect(pending?.result_json).toContain('"sent":false');

    const secondTransport = new FakeTelegramTransport();
    secondTransport.updates = [firstUpdate];
    const secondListener = await startDaemonTelegramListener(
      harness.cp,
      { ...telegramConfig, defaultProjectId: registered.projectId },
      daemonStub,
      { transport: secondTransport, start: false },
    );
    try {
      const resumed = (await secondListener.service.pollOnce()).outcomes[0]!;
      expect(resumed.replayed).toBe(true);
      expect(resumed.reply).toBeTruthy();
    } finally {
      await secondListener.close();
    }
    expect(secondTransport.sendAttempts).toHaveLength(1);
    expect(firstTransport.sendAttempts.length + secondTransport.sendAttempts.length).toBe(2);
    const completed = harness.cp.db.get<{ result_json: string | null }>(
      `SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
      ["update:302"],
    );
    expect(completed?.result_json).toContain('"deliveryStatus":"APPLIED"');

    const doctor = await harness.cp.doctor.run("system");
    expect(doctor.findings).not.toContainEqual(expect.objectContaining({
      code: "TELEGRAM_REPLY_DELIVERY_UNKNOWN",
    }));
  });

  it("a lost response retries once then records unresolved and advances the offset", async () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const handled: string[] = [];
    const onDirect = (input: { text: string }): string => {
      handled.push(input.text);
      return `reply to ${input.text}`;
    };
    const firstUpdate = update("inspect the project", {}, 303);
    const firstTransport = new FakeTelegramTransport();
    const laterUpdate = update("inspect later", {}, 304);
    firstTransport.updates = [firstUpdate, laterUpdate];
    firstTransport.failSendsAmbiguous = 1;
    const firstListener = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      { transport: firstTransport, start: false, onDirect },
    );
    try {
      await expect(firstListener.service.pollOnce()).rejects.toThrow("simulated Telegram outage (no response)");
    } finally {
      await firstListener.close();
    }
    expect(firstListener.service.offset).toBeUndefined();
    expect(firstTransport.sendAttempts).toHaveLength(1);
    expect(harness.cp.db.get(
      `SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
      ["update:304"],
    )).toBeUndefined();
    const retryableUnknown = harness.cp.db.get<{ result_json: string | null }>(
      `SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
      ["update:303"],
    );
    expect(retryableUnknown?.result_json).toContain('"deliveryStatus":"UNKNOWN_RETRYABLE"');
    expect(retryableUnknown?.result_json).toContain('"unknownDeliveryAttempts":1');

    const secondTransport = new FakeTelegramTransport();
    secondTransport.updates = [firstUpdate, laterUpdate];
    secondTransport.failSendsAmbiguous = 1;
    const secondListener = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      { transport: secondTransport, start: false, onDirect },
    );
    try {
      const resumed = await secondListener.service.pollOnce();
      expect(resumed.outcomes[0]?.replayed).toBe(true);
      expect(resumed.outcomes[1]?.replayed).toBe(false);
      expect(resumed.nextOffset).toBe(305);
      expect(secondListener.service.offset).toBe(305);
    } finally {
      await secondListener.close();
    }
    expect(secondTransport.sendAttempts.filter((attempt) => attempt.correlationId.includes("303"))).toHaveLength(1);
    expect(secondTransport.sent[0]?.correlationId).toContain("304");
    expect(handled).toEqual(["inspect the project", "inspect later"]);
    const unresolved = harness.cp.db.get<{ result_json: string | null }>(
      `SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
      ["update:303"],
    );
    expect(unresolved?.result_json).toContain('"deliveryStatus":"UNRESOLVED"');
    expect(unresolved?.result_json).toContain('"unknownDeliveryAttempts":2');

    // A terminal unresolved fact must outlive the ordinary nonce TTL. This later production
    // admission drives IngressGuard.prune after 25 hours; it must not erase update 303 or its
    // doctor finding.
    harness.clock.advance(25 * 60 * 60 * 1_000);
    const laterTransport = new FakeTelegramTransport();
    laterTransport.updates = [update("inspect tomorrow", {}, 305)];
    const laterListener = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      { transport: laterTransport, start: false, onDirect },
    );
    try {
      await laterListener.service.pollOnce();
    } finally {
      await laterListener.close();
    }
    const preserved = harness.cp.db.get<{ result_json: string | null }>(
      `SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
      ["update:303"],
    );
    expect(preserved?.result_json).toContain('"deliveryStatus":"UNRESOLVED"');
    const doctor = await harness.cp.doctor.run("system");
    expect(doctor.findings).toContainEqual(expect.objectContaining({
      code: "TELEGRAM_REPLY_DELIVERY_UNKNOWN",
      observedEvidence: expect.objectContaining({
        outstanding: 1,
        oldest: expect.objectContaining({
          deliveryStatus: "UNRESOLVED",
          unknownDeliveryAttempts: 2,
        }),
      }),
    }));
    expect(doctor.findings).not.toContainEqual(expect.objectContaining({ code: "TURN_OUTCOME_UNKNOWN" }));
  });

  it("a permanent 400 records an unanswerable reply and advances past 101 later updates", async () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const stuckMessageId = 70_401;
    const stuck = update("permanently rejected direct reply", { message_id: stuckMessageId }, 401);
    const later = Array.from({ length: 101 }, (_, index) => update(
      `later direct message ${index + 1}`,
      { message_id: stuckMessageId + index + 1 },
      402 + index,
    ));
    const fixture = telegramBotApiFixture([stuck, ...later], {
      status: 400,
      body: {
        ok: false,
        error_code: 400,
        description: "Bad Request: group chat was migrated",
        parameters: { migrate_to_chat_id: -100_123_456_789 },
      },
    }, { persistentlyRejectReplyToMessageId: stuckMessageId });
    const listener = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      {
        transport: fixture.transport,
        start: false,
        onDirect: (input) => `reply to ${input.text}`,
        ownerGateSignals: () => [],
      },
    );
    try {
      const firstBatch = await listener.service.pollOnce();
      expect(firstBatch.outcomes).toHaveLength(100);
      expect(firstBatch.nextOffset).toBe(501);
      const secondBatch = await listener.service.pollOnce();
      expect(secondBatch.outcomes).toHaveLength(2);
      expect(secondBatch.nextOffset).toBe(503);
    } finally {
      await listener.close();
    }

    const stuckRow = harness.cp.db.get<{ result_json: string | null }>(
      `SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
      ["update:401"],
    );
    expect(stuckRow?.result_json).toContain('"deliveryStatus":"UNANSWERABLE"');
    expect(stuckRow?.result_json).toContain('"statusCode":400');
    expect(stuckRow?.result_json).toContain('"migrateToChatId":"-100123456789"');
    const settledTurn = harness.cp.db.get<{ turn_claim_json: string | null }>(
      `SELECT turn_claim_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
      ["update:401"],
    );
    expect(settledTurn?.turn_claim_json).toContain('"settlement":"UNANSWERABLE"');
    expect(settledTurn?.turn_claim_json).not.toContain('"repliedAt"');
    const laterRow = harness.cp.db.get<{ result_json: string | null }>(
      `SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
      ["update:502"],
    );
    expect(laterRow?.result_json).toContain('"sent":true');
    expect(fixture.calls.filter((call) =>
      call.method === "sendMessage" && call.body["reply_to_message_id"] === stuckMessageId
    )).toHaveLength(1);

    const doctor = await harness.cp.doctor.run("system");
    expect(doctor.findings).toContainEqual(expect.objectContaining({
      code: "TELEGRAM_REPLY_UNANSWERABLE",
      observedEvidence: expect.objectContaining({
        outstanding: 1,
        oldest: expect.objectContaining({
          deliveryStatus: "UNANSWERABLE",
          statusCode: 400,
          migrateToChatId: "-100123456789",
        }),
      }),
    }));
    expect(doctor.findings).not.toContainEqual(expect.objectContaining({ code: "TURN_OUTCOME_UNKNOWN" }));
  });

  it("a 429 rate limit stops the batch before later replies and owner gate prompts", async () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const registered = await registerFixtureProject(harness);
    const first = update("first direct message", {}, 451);
    const later = update("later direct message", {}, 452);
    const fixture = telegramBotApiFixture([first, later], {
      status: 429,
      body: { ok: false, parameters: { retry_after: 17 } },
    });
    const ownerGateSignal = createOwnerGateSignal(harness, registered, "c");
    const listener = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      {
        transport: fixture.transport,
        start: false,
        onDirect: (input) => `reply to ${input.text}`,
        ownerGateSignals: () => [ownerGateSignal],
      },
    );

    let deliveryError: unknown;
    try {
      await listener.service.pollOnce();
    } catch (error) {
      deliveryError = error;
    } finally {
      await listener.close();
    }

    expect(deliveryError).toMatchObject({
      failure: {
        kind: "RETRYABLE",
        statusCode: 429,
        retryAfterSeconds: 17,
      },
    });
    expect(listener.service.offset).toBeUndefined();
    expect(fixture.calls.map((call) => call.method)).toEqual(["getUpdates", "sendMessage"]);
    const firstRow = harness.cp.db.get<{ result_json: string | null }>(
      `SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
      ["update:451"],
    );
    expect(firstRow?.result_json).toContain('"deliveryStatus":"RETRYABLE"');
    const laterRow = harness.cp.db.get<{ result_json: string | null }>(
      `SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
      ["update:452"],
    );
    expect(laterRow).toBeUndefined();
  });

  it("a 5xx outage stops the batch before later replies and owner gate prompts", async () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const registered = await registerFixtureProject(harness);
    const first = update("first direct message", {}, 461);
    const later = update("later direct message", {}, 462);
    const fixture = telegramBotApiFixture([first, later], {
      status: 503,
      body: { ok: false },
    });
    const ownerGateSignal = createOwnerGateSignal(harness, registered, "d");
    const listener = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      {
        transport: fixture.transport,
        start: false,
        onDirect: (input) => `reply to ${input.text}`,
        ownerGateSignals: () => [ownerGateSignal],
      },
    );

    let deliveryError: unknown;
    try {
      await listener.service.pollOnce();
    } catch (error) {
      deliveryError = error;
    } finally {
      await listener.close();
    }

    expect(deliveryError).toMatchObject({
      failure: {
        kind: "RETRYABLE",
        statusCode: 503,
        retryAfterSeconds: null,
      },
    });
    expect(listener.service.offset).toBeUndefined();
    expect(fixture.calls.map((call) => call.method)).toEqual(["getUpdates", "sendMessage"]);
    const firstRow = harness.cp.db.get<{ result_json: string | null }>(
      `SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
      ["update:461"],
    );
    expect(firstRow?.result_json).toContain('"deliveryStatus":"RETRYABLE"');
    const laterRow = harness.cp.db.get<{ result_json: string | null }>(
      `SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
      ["update:462"],
    );
    expect(laterRow).toBeUndefined();
  });

  it("clears a human gate only through the real owner receipt path", async () => {
    const gateItem = "owner confirms the production scope";
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const driven = await driveToReviewedCandidate(harness, { humanGate: [gateItem] });
    await harness.cp.continuity.evaluate("owner receipt path test");

    const packet = harness.cp.ceo.buildPacket({
      runId: driven.runId,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      approval: {
        runId: driven.runId,
        candidateSnapshotDigest: driven.candidateSnapshotDigest,
        resultSummary: "candidate verified",
        recommendation: "merge",
        residualRisk: [],
        approvedBySessionId: driven.ownerSessionId,
        approvedByGeneration: driven.ownerBindingGeneration,
        approvedAt: harness.clock.nowIso(),
      },
    });
    expect(packet.allowed, packet.allowed ? undefined : `${packet.reasonCode}: ${packet.message}`).toBe(true);
    const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO));
    expect(ceo).toBeTruthy();
    const parked = harness.cp.ceo.submitCeoDecision({
      runId: driven.runId,
      decision: "OWNER_DECISION_REQUIRED",
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      ceoSessionId: ceo!.sessionId,
      rationale: "the configured owner must approve the production scope",
    });
    expect(parked.allowed).toBe(true);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.AWAITING_HUMAN);

    const forgedReceipt = harness.cp.ceo.recordOwnerDecision({
      runId: driven.runId,
      item: gateItem,
      approved: true,
      note: "forged",
      receipt: {
        channel: "telegram",
        actor: OWNER_ID,
        inboundNonce: "update:forged",
        runId: driven.runId,
        candidateSnapshotDigest: driven.candidateSnapshotDigest,
        operation: "owner_decision_submit",
        parameterDigest: digestOf({ item: gateItem, approved: true, note: "forged" }),
        idempotencyKey: "forged-receipt",
        approved: true,
      },
    });
    expect(forgedReceipt.allowed).toBe(false);
    expect(forgedReceipt.reasonCode).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);

    const nonOwnerTransport = new FakeTelegramTransport();
    nonOwnerTransport.updates = [update(`/approve ${driven.runId} ${gateItem}`, { from: { id: 999 } }, 401)];
    const nonOwnerListener = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      { transport: nonOwnerTransport, start: false, ownerGateSignals: () => [] },
    );
    try {
      const refused = (await nonOwnerListener.service.pollOnce()).outcomes[0]!;
      expect(refused.admitted).toBe(false);
      expect(refused.reasonCode).toBe(ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED);
      expect(nonOwnerTransport.sent).toHaveLength(0);
    } finally {
      await nonOwnerListener.close();
    }
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.AWAITING_HUMAN);

    const ownerTransport = new FakeTelegramTransport();
    const ownerListener = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      { transport: ownerTransport, start: false, ownerGateSignals: () => [] },
    );
    let ownerUpdate: TelegramUpdate | null = null;
    try {
      const prompt = await ownerListener.service.sendOwnerPrompt({
        runId: driven.runId,
        items: [gateItem],
        chatId: CHAT_ID,
        correlationId: "telegram-test-human-gate",
      });
      expect(prompt.allowed).toBe(true);
      if (!prompt.allowed) throw new Error(prompt.message);
      ownerUpdate = update(`/approve ${driven.runId} ${gateItem} --note checked`, {
        message_id: 8,
        reply_to_message: { message_id: prompt.value.messageId },
      }, 402);
      ownerTransport.updates = [ownerUpdate];
      const approved = (await ownerListener.service.pollOnce()).outcomes[0]!;
      expect(approved.classification).toBe("OWNER_DECISION");
      expect(approved.admitted).toBe(true);
      expect(approved.reply?.text).toContain("OWNER DECISION recorded: APPROVED");
    } finally {
      await ownerListener.close();
    }
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.ACTIVE);
    expect(harness.cp.ceo.humanGateStatus(driven.runId)).toMatchObject({ required: true, satisfied: true });
    expect(harness.cp.audit.byKind("OWNER_APPROVAL_INGRESS")).toHaveLength(1);
    expect(harness.cp.audit.byKind("OWNER_DECISION")).toHaveLength(1);

    const replayTransport = new FakeTelegramTransport();
    replayTransport.updates = [ownerUpdate!];
    const replayListener = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      { transport: replayTransport, start: false, ownerGateSignals: () => [] },
    );
    try {
      const replay = (await replayListener.service.pollOnce()).outcomes[0]!;
      expect(replay.replayed).toBe(true);
      expect(replay.admitted).toBe(false);
      expect(replay.reasonCode).toBe(ReasonCode.INGRESS_REPLAY_IGNORED);
      expect(replayTransport.sent).toHaveLength(0);
    } finally {
      await replayListener.close();
    }
    expect(harness.cp.audit.byKind("OWNER_APPROVAL_INGRESS")).toHaveLength(1);
    expect(harness.cp.audit.byKind("OWNER_DECISION")).toHaveLength(1);
  });

  it("refuses non-allowlisted actors and chats without replying", async () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const transport = new FakeTelegramTransport();
    transport.updates = [
      update("hello", { from: { id: 111 } }, 201),
      update("hello", { chat: { id: -1 } }, 202),
    ];
    const listener = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      { transport, start: false },
    );

    try {
      const cycle = await listener.service.pollOnce();
      expect(cycle.outcomes.map((outcome) => outcome.reasonCode)).toEqual([
        ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED,
        ReasonCode.INGRESS_CHAT_NOT_ALLOWLISTED,
      ]);
      expect(transport.sent).toHaveLength(0);
      expect(harness.cp.audit.byKind("INGRESS_REFUSED")).toHaveLength(2);
    } finally {
      await listener.close();
    }
  });
});

describe("Telegram startup configuration", () => {
  it("treats a deployment with no Telegram variables as an absent optional ingress", () => {
    const ownerIdentities = [{ channel: "telegram", actor: OWNER_ID }];
    expect(configuredTelegramLongPollConfig(ownerIdentities, {})).toBeNull();
    expect(() => configuredTelegramLongPollConfig(ownerIdentities, {
      ACP_TELEGRAM_BOT_TOKEN: "bot-token",
    })).toThrow(/OWNER_ID.*CHAT_ID.*WEBHOOK_SECRET/);
    expect(() => configuredTelegramLongPollConfig(ownerIdentities, {
      ACP_TELEGRAM_BOT_TOKEN: "bot-token",
      ACP_TELEGRAM_OWNER_ID: OWNER_ID,
    })).toThrow(/CHAT_ID.*WEBHOOK_SECRET/);
    expect(() => configuredTelegramLongPollConfig(ownerIdentities, {
      ACP_TELEGRAM_BOT_TOKEN: "bot-token",
      ACP_TELEGRAM_OWNER_ID: OWNER_ID,
      ACP_TELEGRAM_CHAT_ID: CHAT_ID,
    })).toThrow(/WEBHOOK_SECRET/);
  });

  it("requires the numeric Telegram owner to be declared as a configured owner identity", () => {
    expect(() => configuredTelegramLongPollConfig([], {
      ACP_TELEGRAM_BOT_TOKEN: "bot-token",
      ACP_TELEGRAM_OWNER_ID: OWNER_ID,
      ACP_TELEGRAM_CHAT_ID: CHAT_ID,
      ACP_TELEGRAM_WEBHOOK_SECRET: SECRET,
    })).toThrow(/owner-identities/);
  });

  it("prompts every allowlisted chat, not only the first", async () => {
    // A prompt record is keyed by chat and reply message id, so a prompt sent to chat A cannot
    // be resolved by a reply in chat B — that reply is refused OWNER_AUTHORITY_NOT_DELEGABLE.
    // With only allowedChatIds[0] prompted, an owner reading in their second allowlisted chat
    // had no way to answer at all: no prompt arrived there, and answering anyway was refused.
    const secondChat = "-100888";
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const registered = await registerFixtureProject(harness);

    const parked = harness.cp.runs.create({
      projectId: registered.projectId,
      executionMode: ExecutionMode.STANDARD,
      contract: {
        goal: "a run whose owner gate must reach both chats",
        why: "#442 regression fixture",
        scope: ["telegram"],
        nonGoals: [],
        acceptance: ["every allowlisted chat receives the prompt"],
        priority: "NORMAL",
        humanGate: [],
        references: [],
      },
      repositories: [
        { repositoryId: registered.repositoryId, repositoryRole: "primary", baseBranch: "dev" },
      ],
    });
    if (!parked.allowed) throw new Error(parked.message);
    harness.cp.runs.promoteCandidate(parked.value.runId, `sha256:${"b".repeat(64)}`);

    const transport = new FakeTelegramTransport();
    const listener = await startDaemonTelegramListener(
      harness.cp,
      { ...telegramConfig, allowedChatIds: [CHAT_ID, secondChat], defaultProjectId: registered.projectId },
      daemonStub,
      {
        transport,
        start: false,
        ownerGateSignals: () => [{
          signalId: "sig-two-chats",
          runId: parked.value.runId,
          items: ["owner confirms"],
          candidateSnapshotDigest: `sha256:${"b".repeat(64)}`,
        }],
      },
    );

    try {
      await listener.service.pollOnce();
      const prompted = transport.sent
        .filter((m) => m.correlationId.startsWith("telegram:owner-gate:"))
        .map((m) => m.chatId);
      expect(prompted, "the second allowlisted chat never received the prompt")
        .toEqual(expect.arrayContaining([CHAT_ID, secondChat]));
    } finally {
      await listener.close();
    }
  }, 30_000);

  it("P0-10 keeps receiving when an owner-gate prompt cannot be delivered", async () => {
    // One parked run whose prompt cannot be sent must not cost the owner their control path.
    // Before this, deliverOwnerGatePrompts ran first and threw, so getUpdates never ran and
    // every inbound command stopped — including the reply that would resolve that very run.
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const registered = await registerFixtureProject(harness);
    const transport = new FakeTelegramTransport();
    transport.updates = [update(`/managed ${registered.projectId} implement the requested change`)];
    // Only the owner-gate prompt fails. The reply path is left working, because a reply
    // failure belongs to the update being processed while a prompt failure does not.
    transport.failOwnerGateSends = true;

    // The signal must name a run that really has a current candidate. With a synthetic id,
    // prepareOwnerPrompt denies EVIDENCE_STALE before reaching transport.sendMessage — so
    // failOwnerGateSends was never read and this test passed on the deny path instead of on
    // the delivery failure it names. The candidate is promoted through the production API
    // rather than written into the row, so the fixture cannot drift from what a real run has.
    const parked = harness.cp.runs.create({
      projectId: registered.projectId,
      executionMode: ExecutionMode.STANDARD,
      contract: {
        goal: "parked run whose owner-gate prompt cannot be delivered",
        why: "P0-10 regression fixture",
        scope: ["telegram"],
        nonGoals: [],
        acceptance: ["the owner control path survives a prompt delivery failure"],
        priority: "NORMAL",
        humanGate: [],
        references: [],
      },
      repositories: [
        { repositoryId: registered.repositoryId, repositoryRole: "primary", baseBranch: "dev" },
      ],
    });
    if (!parked.allowed) throw new Error(parked.message);
    const parkedRunId = parked.value.runId;
    const parkedCandidate = `sha256:${"a".repeat(64)}`;
    harness.cp.runs.promoteCandidate(parkedRunId, parkedCandidate);
    expect(harness.cp.runs.currentCandidate(parkedRunId)).toBe(parkedCandidate);

    const errors: unknown[] = [];
    const listener = await startDaemonTelegramListener(
      harness.cp,
      { ...telegramConfig, defaultProjectId: registered.projectId },
      daemonStub,
      {
        transport,
        start: false,
        ownerGateSignals: () => [{
          signalId: "sig-undeliverable",
          runId: parkedRunId,
          items: ["owner confirms"],
          candidateSnapshotDigest: parkedCandidate,
        }],
        onError: (error: unknown) => { errors.push(error); },
      },
    );

    try {
      // The inbound batch is still received and routed, and pollOnce does not throw.
      const cycle = await listener.service.pollOnce();
      expect(cycle.outcomes).toHaveLength(1);
      expect(cycle.outcomes[0]?.admitted).toBe(true);
      // The delivery failure is surfaced rather than swallowed.
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      await listener.close();
    }
  });
});
