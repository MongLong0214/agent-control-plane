import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, describe, expect, it, vi } from "vitest";

import { answerAsCeo, startDaemonTelegramListener } from "../../src/daemon/agentcpd.ts";
import { TelegramInterruption } from "../../src/ingress/telegram-router.ts";
import {
  configuredTelegramLongPollConfig,
  TelegramDeliveryError,
  type TelegramBotTransport,
  type TelegramLongPollService,
} from "../../src/ingress/telegram-polling.ts";
import type { TelegramUpdate } from "../../src/ingress/telegram.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { allow } from "../../src/core/errors.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ExecutionMode, Role, RunState, roleKeyFor } from "../../src/domain/types.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
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
  // Used through `startDaemonTelegramListener` / `startTelegramLongPollListener`, which now
  // derives IngressGuard's retention floor from this value (#682, round 8) — declared as the
  // real measured figure since this fake is standing in for ordinary Telegram behavior.
  readonly redeliveryRetentionMs = 24 * 60 * 60 * 1000;
  readonly sent: Array<{
    chatId: string;
    text: string;
    replyToMessageId?: number;
    correlationId: string;
  }> = [];
  readonly offsets: Array<number | undefined> = [];
  updates: TelegramUpdate[] = [];
  failSends = 0;
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
    if (this.failOwnerGateSends && input.correlationId.startsWith("telegram:owner-gate:")) {
      throw new TelegramDeliveryError("simulated owner-gate prompt delivery failure", false);
    }
    if (this.failSends > 0) {
      this.failSends -= 1;
      throw new TelegramDeliveryError("simulated Telegram send crash", false);
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

/**
 * A CEO turn can outlive `pollOnce` after #630, so its fault belongs to the listener's task
 * observer rather than to the poll promise. Managed and owner-decision faults still reject the
 * poll itself. Waiting both boundaries makes the named fault mandatory whichever side produced it.
 */
const observedTurnFault = async (service: TelegramLongPollService): Promise<void> => {
  const cycle = await service.pollOnce();
  await service.pendingTurnsSettled();
  await cycle.settled();
};

const settledPoll = async (service: TelegramLongPollService) => {
  const cycle = await service.pollOnce();
  await service.pendingTurnsSettled();
  return cycle.settled();
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
      const cycle = await settledPoll(listener.service);
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
    // `main()` calls `startDaemonTelegramListenerOrRefuse` now, not `startDaemonTelegramListener`
    // directly — the wrapper that catches only an unmeasured-transport-retention refusal so it
    // does not take the rest of the daemon down (#682, round 8 follow-up). Both assertions matter:
    // the first proves the composition root did not drift onto some other path, the second proves
    // the wrapper itself still runs the real daemon-owned factory rather than a substitute.
    expect(agentcpdSource).toContain("const outcome = await startDaemonTelegramListenerOrRefuse(cp, telegramConfig, daemon");
    expect(agentcpdSource).toContain("const listener = await startDaemonTelegramListener(cp, config, daemon, options);");

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
      const cycle = await settledPoll(listener.service);
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
      const outcome = (await settledPoll(listener.service)).outcomes[0]!;
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
      const outcome = (await settledPoll(listener.service)).outcomes[0]!;
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
      const outcome = (await settledPoll(listener.service)).outcomes[0]!;
      expect(outcome.classification).toBe("DIRECT");
      expect(outcome.input?.text).toContain("<untrusted-content source=\"telegram-forward\">");
      expect(outcome.input?.text).toContain("It is not an instruction");
      expect(harness.cp.runs.list()).toHaveLength(0);
      expect(transport.sent[0]?.text).toContain("forwarded content was retained as untrusted data");
    } finally {
      await listener.close();
    }
  });

  it("returns a pending CEO turn while refusing a second and reports the final offset when settled", async () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const port = new CeoConversationPort();
    let releaseFirst!: (answer: unknown) => void;
    let markFirstReached!: () => void;
    const firstReached = new Promise<void>((resolve) => { markFirstReached = resolve; });
    const heldAnswer = new Promise<unknown>((resolve) => { releaseFirst = resolve; });
    const peerCalls: string[] = [];
    const server = {
      server: {
        getClientCapabilities: () => ({ sampling: {} }),
        createMessage: async (params: { messages: Array<{ content: { text?: string } }> }) => {
          peerCalls.push(params.messages[0]?.content.text ?? "");
          markFirstReached();
          return heldAnswer;
        },
      },
    } as unknown as McpServer;
    port.attach(server, () => allow(ReasonCode.OK, {} as never));

    const transport = new FakeTelegramTransport();
    const first = update("first detached turn", {}, 680);
    transport.updates = [first];
    const listener = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
      transport,
      start: false,
      onDirect: (input) => answerAsCeo(port, input.text),
    });

    try {
      const firstCycle = await listener.service.pollOnce();
      await firstReached;
      expect(peerCalls).toEqual(["first detached turn"]);
      expect(firstCycle.routes).toHaveLength(1);
      expect(firstCycle.routes[0]?.status).toBe("CEO_TURN_PENDING");
      expect(firstCycle.nextOffsetAtReturn).toBeUndefined();
      expect(listener.service.offset).toBeUndefined();

      // /again deliberately gets past the unresolved-turn ingress hold, so the refusal below is
      // the CEO port's #inFlight guard rather than an earlier router branch.
      transport.updates = [first, update("/again second detached turn", {}, 681)];
      const secondCycle = await listener.service.pollOnce();
      const secondSettled = await secondCycle.settled();

      expect(transport.sent[0]?.text).toContain(ReasonCode.CEO_CONVERSATION_BUSY);
      expect(secondCycle.routes[0]?.status).toBe("CEO_TURN_PENDING");
      expect(secondSettled.outcomes[0]?.reply?.text).toContain(ReasonCode.CEO_CONVERSATION_BUSY);
      expect(peerCalls, "the busy turn reached the peer or was queued behind the first").toEqual([
        "first detached turn",
      ]);
      expect(listener.service.offset, "a later completion advanced past the running first turn").toBeUndefined();

      releaseFirst({ model: "fake", role: "assistant", content: { type: "text", text: "first answer" } });
      await listener.service.pendingTurnsSettled();
      const firstSettled = await firstCycle.settled();

      expect(peerCalls, "the refused second turn ran after the first finished").toEqual(["first detached turn"]);
      expect(firstSettled.outcomes[0]?.reply?.text).toContain("first answer");
      expect(firstSettled.nextOffset).toBe(682);
      expect(listener.service.offset).toBe(682);
    } finally {
      releaseFirst({ model: "fake", role: "assistant", content: { type: "text", text: "cleanup" } });
      await listener.close();
    }
  });

  it("keeps a managed route inside pollOnce until its dispatch checkpoint completes", async () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const registered = await registerFixtureProject(harness);
    const transport = new FakeTelegramTransport();
    transport.updates = [update(`/managed ${registered.projectId} wait at dispatch`, {}, 679)];
    let releaseDispatch!: () => void;
    let markDispatchReached!: () => void;
    const dispatchReached = new Promise<void>((resolve) => { markDispatchReached = resolve; });
    const heldDispatch = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    const listener = await startDaemonTelegramListener(
      harness.cp,
      { ...telegramConfig, defaultProjectId: registered.projectId },
      daemonStub,
      {
        transport,
        start: false,
        onInterrupt: async (point) => {
          if (point !== "after-dispatch") return;
          markDispatchReached();
          await heldDispatch;
        },
      },
    );

    try {
      let pollReturned = false;
      const polling = listener.service.pollOnce().then((cycle) => {
        pollReturned = true;
        return cycle;
      });
      await dispatchReached;
      await Promise.resolve();
      expect(pollReturned, "the managed route was detached with the CEO turn").toBe(false);

      releaseDispatch();
      const cycle = await polling;
      expect(cycle.routes).toHaveLength(1);
      expect(cycle.routes[0]?.status).toBe("COMPLETED");
      const settled = await cycle.settled();
      expect(settled.outcomes[0]?.classification).toBe("MANAGED");
      expect(settled.nextOffset).toBe(680);
    } finally {
      releaseDispatch();
      await listener.close();
    }
  });

  it("keeps an admitted owner decision refusal inside pollOnce until routing completes", async () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const transport = new FakeTelegramTransport();
    transport.updates = [update("/approve run_missing deploy", {
      reply_to_message: { message_id: 999_999 },
    }, 678)];
    let releaseAdmission!: () => void;
    let markAdmissionReached!: () => void;
    const admissionReached = new Promise<void>((resolve) => { markAdmissionReached = resolve; });
    const heldAdmission = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    const listener = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
      transport,
      start: false,
      onInterrupt: async (point) => {
        if (point !== "after-admission") return;
        markAdmissionReached();
        await heldAdmission;
      },
    });

    try {
      let pollReturned = false;
      const polling = listener.service.pollOnce().then((cycle) => {
        pollReturned = true;
        return cycle;
      });
      await admissionReached;
      await Promise.resolve();
      expect(pollReturned, "the owner decision route was detached with the CEO turn").toBe(false);

      releaseAdmission();
      const cycle = await polling;
      expect(cycle.routes).toHaveLength(1);
      expect(cycle.routes[0]?.status).toBe("COMPLETED");
      const settled = await cycle.settled();
      expect(settled.outcomes[0]?.classification).toBe("OWNER_DECISION");
      expect(settled.outcomes[0]?.reasonCode).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);
      expect(settled.nextOffset).toBe(679);
    } finally {
      releaseAdmission();
      await listener.close();
    }
  });

  it("close rejects a detached turn fault that no observer drained", async () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const transport = new FakeTelegramTransport();
    transport.updates = [update("unobserved fault", {}, 682)];
    const listener = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
      transport,
      start: false,
      onDirect: () => { throw new TelegramInterruption("after-dispatch"); },
    });

    await listener.service.pollOnce();
    await expect(listener.close()).rejects.toMatchObject({ point: "after-dispatch" });
    // The first close drained the fault before rejecting; a second call completes lifecycle
    // cleanup rather than reporting the same observed failure forever.
    await listener.close();
  });

  it("waits for retryDelayMs before a detached route is attempted again", async () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const retryDelayMs = 200;
    const failedUpdate = update("reply delivery keeps failing", {}, 683);
    const attemptTimes: number[] = [];
    const pollTimes: number[] = [];
    const offsets: Array<number | undefined> = [];
    let pollsAtSecondAttempt: number | undefined;
    let markSecondFailure!: () => void;
    const secondFailure = new Promise<void>((resolve) => { markSecondFailure = resolve; });
    const transport: TelegramBotTransport = {
      redeliveryRetentionMs: 24 * 60 * 60 * 1000,
      async getUpdates(options) {
        pollTimes.push(Date.now());
        offsets.push(options.offset);
        return [failedUpdate];
      },
      async sendMessage() {
        attemptTimes.push(Date.now());
        if (attemptTimes.length === 2) {
          pollsAtSecondAttempt = pollTimes.length;
        }
        throw new TelegramDeliveryError("continuous confirmed route failure", false);
      },
    };
    const errors: unknown[] = [];
    const listener = await startDaemonTelegramListener(
      harness.cp,
      { ...telegramConfig, retryDelayMs },
      daemonStub,
      {
        transport,
        start: false,
        onDirect: () => "reply that Telegram refuses",
        onError: (error) => {
          errors.push(error);
          if (errors.length === 2) markSecondFailure();
        },
      },
    );

    listener.service.start();
    try {
      await Promise.race([
        secondFailure,
        new Promise<never>((_resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("second route attempt never started")), 3_000);
          timeout.unref();
        }),
      ]);
    } finally {
      await listener.close();
    }

    expect(attemptTimes.length).toBeGreaterThanOrEqual(2);
    expect(attemptTimes.slice(1).every(
      (attemptedAt, index) => attemptedAt - attemptTimes[index]! >= retryDelayMs,
    )).toBe(true);
    expect(pollsAtSecondAttempt, "the poll loop spun on the retryable update during its backoff")
      .toBeLessThanOrEqual(4);
    expect(listener.service.offset).toBeUndefined();
    expect(offsets.every((offset) => offset === undefined)).toBe(true);
    expect(errors).toHaveLength(attemptTimes.length);
    expect(errors).toSatisfy((reported: unknown[]) => reported.every(
      (error) => error instanceof TelegramDeliveryError && error.message === "continuous confirmed route failure",
    ));
    expect(harness.cp.audit.byKind("INGRESS_ADMITTED")).toHaveLength(1);
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
      const cycle = await listener.service.pollOnce();
      expect(cycle.routes[0]?.status).toBe("COMPLETED");
      await listener.service.pendingTurnsSettled();
      const outcomes = (await cycle.settled()).outcomes;
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
      const outcome = (await settledPoll(listener.service)).outcomes[0]!;
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

      const outcome = (await settledPoll(listener.service)).outcomes[0]!;
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
      await settledPoll(firstListener.service);
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
      await settledPoll(firstListener.service);
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
      await settledPoll(restarted.service);
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
      const outcome = (await settledPoll(changed.service)).outcomes[0]!;
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
      const outcome = (await settledPoll(listener.service)).outcomes[0]!;
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
      await settledPoll(firstListener.service);
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
      const replay = (await settledPoll(secondListener.service)).outcomes[0]!;
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
      await expect(observedTurnFault(first.service)).rejects.toBeInstanceOf(TelegramInterruption);
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
      const resumed = await settledPoll(second.service);

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
      await expect(observedTurnFault(first.service)).rejects.toBeInstanceOf(TelegramInterruption);
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
      const outcome = await settledPoll(resendListener.service);

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
      await expect(observedTurnFault(first.service)).rejects.toBeInstanceOf(TelegramInterruption);
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
      const outcome = await settledPoll(otherListener.service);
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
      await expect(observedTurnFault(first.service)).rejects.toBeInstanceOf(TelegramInterruption);
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
      const outcome = await settledPoll(againListener.service);
      expect(turns).toEqual(["배포 다시 확인해줘", "배포 다시 확인해줘"]);
      expect(outcome.outcomes[0]?.reasonCode).toBe(ReasonCode.OK);

      const claimRow = harness.cp.db.get<{ turn_claim_json: string | null }>(
        `SELECT turn_claim_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
        ["update:721"],
      );
      const claim = claimRow?.turn_claim_json ? JSON.parse(claimRow.turn_claim_json) : null;
      expect(claim?.overriddenUnresolvedNonces, "the deliberate override was not recorded on the claim")
        .toEqual(["update:720"]);
    } finally {
      await againListener.close();
    }
  });

  it("#695: names both unresolved turns, not only the oldest, once a second one accumulates", async () => {
    // #680 built the park-before-claim mechanism and #695 is the gap a review found in it
    // afterward: both places the router reads `unresolvedTurns()` used only its first element.
    // Reproduction, entirely sequential — no concurrency required. A crashes; /again overrides A
    // to claim B, and B *also* crashes, so the conversation now carries two unresolved rows (A,
    // B) at once. An ordinary message C must then be parked with both named, not only A — and a
    // later /again for C must record both as overridden, not only A.
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const turns: string[] = [];
    const crashingTurn = async (input: { text: string }): Promise<string> => {
      turns.push(input.text);
      throw new TelegramInterruption("after-dispatch");
    };

    // A crashes.
    const firstTransport = new FakeTelegramTransport();
    const first = update("A 확인해줘", {}, 730);
    firstTransport.updates = [first];
    const firstListener = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
      transport: firstTransport,
      start: false,
      onDirect: crashingTurn,
    });
    try {
      await expect(observedTurnFault(firstListener.service)).rejects.toBeInstanceOf(TelegramInterruption);
    } finally {
      await firstListener.close();
    }

    // Advance the clock so A and B get distinct received_at values — otherwise a frozen
    // ManualClock would make them identical strings and the "names both" assertion below would
    // pass by coincidence rather than by the fix actually naming two distinct rows.
    harness.clock.advance(60_000);

    // /again claims B over A's override — and B also crashes, so it too stays unresolved.
    const againBTransport = new FakeTelegramTransport();
    const againB = update("/again B 확인해줘", {}, 731);
    againBTransport.updates = [againB];
    const againBListener = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
      transport: againBTransport,
      start: false,
      onDirect: crashingTurn,
    });
    try {
      await expect(observedTurnFault(againBListener.service)).rejects.toBeInstanceOf(TelegramInterruption);
    } finally {
      await againBListener.close();
    }
    expect(turns).toEqual(["A 확인해줘", "B 확인해줘"]);

    const rowsBefore = harness.cp.db.all<{ nonce: string; received_at: string }>(
      `SELECT nonce, received_at FROM inbound_messages WHERE channel = 'telegram' AND nonce IN (?, ?)`,
      ["update:730", "update:731"],
    );
    const receivedAtA = rowsBefore.find((r) => r.nonce === "update:730")!.received_at;
    const receivedAtB = rowsBefore.find((r) => r.nonce === "update:731")!.received_at;

    // C, an ordinary message with no /again, must be parked with BOTH A and B named — not only
    // the oldest (A). Before the fix, the reply names only A and B is never mentioned anywhere
    // the owner can see.
    const cTransport = new FakeTelegramTransport();
    const cUpdate = update("C 새 메시지", {}, 732);
    cTransport.updates = [cUpdate];
    const cListener = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
      transport: cTransport,
      start: false,
      onDirect: () => "실행되면 안 됨",
    });
    try {
      const outcome = await settledPoll(cListener.service);
      expect(outcome.outcomes[0]?.reasonCode).toBe(ReasonCode.INGRESS_TURN_UNRESOLVED_CONVERSATION);
      const replyText = outcome.outcomes[0]?.reply?.text ?? "";
      expect(replyText, "park reply must name A's received time").toContain(receivedAtA);
      expect(replyText, "park reply must name B's received time too, not only A's").toContain(receivedAtB);
    } finally {
      await cListener.close();
    }

    // Owner sends /again for C. The override record must capture BOTH A's and B's nonces — not
    // only A's, which is all index-0 code can ever see.
    const againCTransport = new FakeTelegramTransport();
    const againC = update("/again C 새 메시지", {}, 733);
    againCTransport.updates = [againC];
    const againCListener = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
      transport: againCTransport,
      start: false,
      onDirect: (input: { text: string }) => {
        turns.push(input.text);
        return "확인함";
      },
    });
    try {
      const outcome = await settledPoll(againCListener.service);
      expect(outcome.outcomes[0]?.reasonCode).toBe(ReasonCode.OK);

      const claimRow = harness.cp.db.get<{ turn_claim_json: string | null }>(
        `SELECT turn_claim_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
        ["update:733"],
      );
      const claim = claimRow?.turn_claim_json ? JSON.parse(claimRow.turn_claim_json) : null;
      expect(claim?.overriddenUnresolvedNonces, "the override must record every unresolved nonce, not only the oldest")
        .toEqual(["update:730", "update:731"]);
    } finally {
      await againCListener.close();
    }
  });

  it("#695: bounds the park reply's enumeration past the cap, and still records every overridden nonce", async () => {
    // Sol's BLOCK on the naive "name all of them" fix: `IngressGuard.prune` deliberately never
    // removes an unresolved claim (it needs a person, not a timer), so a conversation that keeps
    // crashing and keeps getting `/again`'d grows this list without bound. Measured directly:
    // 146 real unresolved rows already produce a 4,099-character joined line, past Telegram's
    // 4,096-character sendMessage limit, and relying on the generic `truncateTelegramText` slice
    // to save it cuts the reply off mid-list — carrying away the very instructions that tell the
    // owner `/again` exists. This drives MAX_NAMED_UNRESOLVED_TURNS(10) + 2 = 12 unresolved rows
    // through the real production path (impractical to reach the literal 146 that way — this
    // exercises the same cap-then-summarize mechanism at a size fast enough for a unit test) and
    // checks both halves of the fix: the *reply* stays short and still actionable, and the
    // *override record* — durable storage, not a wire message — still names every one of the 12.
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const turns: string[] = [];
    const crashingTurn = async (input: { text: string }): Promise<string> => {
      turns.push(input.text);
      throw new TelegramInterruption("after-dispatch");
    };

    const ROWS_BEYOND_CAP = 12;
    const baseUpdateId = 900;
    for (let i = 0; i < ROWS_BEYOND_CAP; i++) {
      const text = i === 0 ? `turn ${i}` : `/again turn ${i}`;
      const transport = new FakeTelegramTransport();
      transport.updates = [update(text, {}, baseUpdateId + i)];
      const listener = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
        transport,
        start: false,
        onDirect: crashingTurn,
      });
      try {
        await expect(observedTurnFault(listener.service)).rejects.toBeInstanceOf(TelegramInterruption);
      } finally {
        await listener.close();
      }
      // Distinct received_at per row: a frozen clock would make every row's timestamp identical
      // and SQLite's tie-break order is not a property this test should lean on.
      harness.clock.advance(60_000);
    }
    expect(turns).toHaveLength(ROWS_BEYOND_CAP);

    // An ordinary message, no /again: the reply must stay well under Telegram's 4,096-character
    // limit and must still contain the /again instructions — the point of a deliberate cap
    // instead of leaving it to a blind truncator that would cut them off.
    const cUpdateId = baseUpdateId + ROWS_BEYOND_CAP;
    const cTransport = new FakeTelegramTransport();
    cTransport.updates = [update("ordinary message", {}, cUpdateId)];
    const cListener = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
      transport: cTransport,
      start: false,
      onDirect: () => "실행되면 안 됨",
    });
    try {
      const outcome = await settledPoll(cListener.service);
      expect(outcome.outcomes[0]?.reasonCode).toBe(ReasonCode.INGRESS_TURN_UNRESOLVED_CONVERSATION);
      const replyText = outcome.outcomes[0]?.reply?.text ?? "";
      expect(
        replyText.length,
        "the park reply must stay well under Telegram's 4,096-char sendMessage limit",
      ).toBeLessThan(2000);
      expect(replyText, "a bounded reply must still tell the owner how to override").toContain("/again");
      expect(replyText, `must count all ${ROWS_BEYOND_CAP} unresolved turns, not only the named ones`).toContain(
        `${ROWS_BEYOND_CAP} earlier messages`,
      );
      expect(replyText, "must summarize the rows past the cap rather than enumerate all of them").toContain("more");
    } finally {
      await cListener.close();
    }

    // Owner overrides via /again. The durable record must capture every one of the 12 unresolved
    // nonces — not only the MAX_NAMED_UNRESOLVED_TURNS the reply named.
    const againUpdateId = cUpdateId + 1;
    const againTransport = new FakeTelegramTransport();
    againTransport.updates = [update("/again ordinary message", {}, againUpdateId)];
    const againListener = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
      transport: againTransport,
      start: false,
      onDirect: (input: { text: string }) => {
        turns.push(input.text);
        return "확인함";
      },
    });
    try {
      const outcome = await settledPoll(againListener.service);
      expect(outcome.outcomes[0]?.reasonCode).toBe(ReasonCode.OK);

      const claimRow = harness.cp.db.get<{ turn_claim_json: string | null }>(
        `SELECT turn_claim_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
        [`update:${againUpdateId}`],
      );
      const claim = claimRow?.turn_claim_json ? JSON.parse(claimRow.turn_claim_json) : null;
      const expectedNonces = Array.from({ length: ROWS_BEYOND_CAP }, (_, i) => `update:${baseUpdateId + i}`);
      expect(
        claim?.overriddenUnresolvedNonces,
        "the record must capture every unresolved nonce, not only the ones the reply named",
      ).toEqual(expectedNonces);
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
      const firstPass = await settledPoll(listener.service);
      expect(firstPass.outcomes[0]?.reasonCode).toBe(ReasonCode.OK);

      // A fresh listener, because the first one advanced its offset past this update and would
      // skip it — the replay this is about is one Telegram hands back after a restart.
      const replayTransport = new FakeTelegramTransport();
      replayTransport.updates = [answered];
      const replayListener = await startDaemonTelegramListener(
        harness.cp, telegramConfig, daemonStub,
        { transport: replayTransport, start: false, onDirect: () => "답" },
      );
      const replay = await settledPoll(replayListener.service);
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
        await expect(observedTurnFault(firstListener.service)).rejects.toMatchObject({ point });
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
        const resumed = await settledPoll(secondListener.service);
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
    firstTransport.failSends = 1;
    const firstListener = await startDaemonTelegramListener(
      harness.cp,
      telegramConfig,
      daemonStub,
      { transport: firstTransport, start: false },
    );
    try {
      await expect(observedTurnFault(firstListener.service)).rejects.toThrow("simulated Telegram send crash");
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
      const resumed = await settledPoll(secondListener.service);
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

  it("does not resend when Telegram accepts a reply before the completion checkpoint", async () => {
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
      await expect(observedTurnFault(firstListener.service)).rejects.toMatchObject({ point: "after-reply-send" });
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
      const resumed = (await settledPoll(secondListener.service)).outcomes[0]!;
      expect(resumed.replayed).toBe(true);
      expect(resumed.reply).toBeNull();
    } finally {
      await secondListener.close();
    }
    expect(secondTransport.sent).toHaveLength(0);
    expect(firstTransport.sent.length + secondTransport.sent.length).toBe(1);
  });

  it("#682: a claimed turn's PENDING reply survives a redelivery instead of becoming a false no-reply", async () => {
    // The claimed twin of the test above. That one uses `/managed`, which never calls
    // `claimTurn` — so its crash-and-restart sequence never reaches `completeNoReplyAndResolveTurn`
    // at all, and cannot prove anything about it. An ordinary DIRECT message does claim a turn,
    // and `route()`'s restart branch reports the exact same shape as `/managed`'s for the exact
    // same reason — a PENDING reservation is deliberately not retried, so `includeReply` is
    // false and `reply` comes back null — but this time #672's no-reply branch after routing is
    // reachable, and a real redelivery must not read that ambiguous, already-claimed outcome as a
    // fresh handler deciding not to reply.
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const firstTransport = new FakeTelegramTransport();
    const firstUpdate = update("what is the status", {}, 402);
    firstTransport.updates = [firstUpdate];
    const firstListener = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
      transport: firstTransport,
      start: false,
      onInterrupt: async (point) => {
        if (point === "after-reply-send") throw new TelegramInterruption(point);
      },
    });

    try {
      await expect(observedTurnFault(firstListener.service)).rejects.toMatchObject({ point: "after-reply-send" });
    } finally {
      await firstListener.close();
    }
    expect(firstTransport.sent).toHaveLength(1);

    const beforeRestart = harness.cp.db.get<{ result_json: string | null; turn_claim_json: string | null }>(
      `SELECT result_json, turn_claim_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
      ["update:402"],
    );
    expect(beforeRestart?.result_json).toContain('"deliveryStatus":"PENDING"');
    expect(beforeRestart?.turn_claim_json).not.toContain("repliedAt");

    const secondTransport = new FakeTelegramTransport();
    secondTransport.updates = [firstUpdate];
    const secondListener = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
      transport: secondTransport,
      start: false,
    });
    try {
      const resumed = (await settledPoll(secondListener.service)).outcomes[0]!;
      // The same observable shape the MANAGED test asserts — this is production reproducing
      // Sol's sequence, not a fixture standing in for it.
      expect(resumed.replayed).toBe(true);
      expect(resumed.reply).toBeNull();
    } finally {
      await secondListener.close();
    }
    expect(secondTransport.sent).toHaveLength(0);

    // The durable evidence that Telegram may already have accepted the reply must survive
    // untouched: still PENDING, still holding what the first attempt reserved, and the claim
    // still unresolved. An ambiguous send outcome stays ambiguous — it must not become a
    // confident "nothing was sent", because that is what tells the owner to resend a message
    // Telegram may have already delivered.
    const afterRestart = harness.cp.db.get<{ result_json: string | null; turn_claim_json: string | null }>(
      `SELECT result_json, turn_claim_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
      ["update:402"],
    );
    expect(afterRestart?.result_json).toBe(beforeRestart?.result_json);
    expect(afterRestart?.turn_claim_json).toBe(beforeRestart?.turn_claim_json);
    expect(afterRestart?.turn_claim_json).not.toContain("repliedAt");
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
      const refused = (await settledPoll(nonOwnerListener.service)).outcomes[0]!;
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
      const approved = (await settledPoll(ownerListener.service)).outcomes[0]!;
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
      const replay = (await settledPoll(replayListener.service)).outcomes[0]!;
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
      const cycle = await settledPoll(listener.service);
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
      await settledPoll(listener.service);
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
      const cycle = await settledPoll(listener.service);
      expect(cycle.outcomes).toHaveLength(1);
      expect(cycle.outcomes[0]?.admitted).toBe(true);
      // The delivery failure is surfaced rather than swallowed.
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      await listener.close();
    }
  });
});
