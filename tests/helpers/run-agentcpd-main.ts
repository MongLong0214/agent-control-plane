import { main, type AgentcpdMainContext } from "../../src/daemon/agentcpd.ts";
import { defaultConfig } from "../../src/app/control-plane.ts";
import { NotificationKind } from "../../src/ceo/production-gate.ts";
import { digestOf } from "../../src/core/digest.ts";
import { isAcpError } from "../../src/core/errors.ts";
import { systemClock } from "../../src/core/clock.ts";
import { ExecutionMode, Role, RunKind, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { ScriptedAdapter } from "../../src/runtime/scripted-adapter.ts";
import type { TelegramBotTransport } from "../../src/ingress/telegram-polling.ts";
import type { TelegramUpdate } from "../../src/ingress/telegram.ts";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

class StartupAdapter extends ScriptedAdapter {
  override readonly isProduction = true;
}

class StartupTelegramTransport implements TelegramBotTransport {
  polls = 0;
  promptObserved = false;
  approvalSent = false;
  /** Replies the router produced for an inbound message, as opposed to prompts it initiated. */
  routedReplies = 0;
  /** The text of the last reply the router produced for an inbound update. */
  lastRoutedReply = "";
  private nextMessageId = 1;
  private updates: TelegramUpdate[] = [];

  constructor(private readonly expectPromptFlow: boolean) {}

  async getUpdates(_options: { offset?: number; timeoutSeconds: number; signal?: AbortSignal }): Promise<readonly TelegramUpdate[]> {
    this.polls += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    const updates = this.updates;
    this.updates = [];
    return updates;
  }

  /** Queues one inbound update for the next poll. */
  enqueue(update: TelegramUpdate): void {
    this.updates.push(update);
  }

  async sendMessage(input: {
    chatId: string;
    text: string;
    replyToMessageId?: number;
    correlationId: string;
  }): Promise<{ messageId: number }> {
    const messageId = this.nextMessageId++;
    // correlationIdFor() stamps a routed reply as telegram:<update_id>:<message_id>. Owner
    // prompts use telegram:owner-gate:/owner-prompt:, so the numeric shape is what marks a
    // reply the router produced for an inbound update rather than one it initiated.
    if (/^telegram:\d+:/.test(input.correlationId)) {
      this.routedReplies += 1;
      this.lastRoutedReply = input.text;
    }
    if (input.replyToMessageId !== undefined) {
      this.approvalSent = true;
    } else if (this.expectPromptFlow && input.text.startsWith("OWNER DECISION REQUIRED")) {
      const runId = input.text.match(/^run: (.+)$/mu)?.[1]?.trim();
      const item = input.text.match(/^- (.+)$/mu)?.[1]?.trim();
      if (!runId || !item) throw new Error("startup test could not parse the owner prompt");
      this.promptObserved = true;
      this.updates.push({
        update_id: 900,
        message: {
          message_id: 901,
          date: 1_700_000_000,
          text: `/approve ${runId} ${item}`,
          from: { id: 424242 },
          chat: { id: -100999 },
          reply_to_message: { message_id: messageId },
        },
      });
    }
    return { messageId };
  }
}

const root = process.env["ACP_STARTUP_TEST_ROOT"];
if (!root) throw new Error("ACP_STARTUP_TEST_ROOT is required");

const adapters = [
  new StartupAdapter(systemClock, "claude"),
  new StartupAdapter(systemClock, "gpt"),
];
const config = {
  ...defaultConfig(join(root, ".agent-control-plane")),
  adapters,
  ctoPreference: { provider: "claude", model: "scripted-cto", effort: null },
};

if (process.env["ACP_STARTUP_TEST_SEED"] === "1") {
  // A real App credential pair on disk, not `TrustedCredentialStore.install`. That fixture
  // path keeps its identity in memory, so seeding it on one instance says nothing about the
  // store the daemon builds for itself — the doctor would still report
  // TRUSTED_GATE_CREDENTIAL_MISSING and refuse to start. `availability()` reads these two
  // files and checks their modes; it makes no network call, so this stays offline.
  const credentialsDir = join(root, ".agent-control-plane", "credentials");
  mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
  chmodSync(credentialsDir, 0o700);
  const privateKeyPath = join(credentialsDir, "github-app.private-key.pem");
  const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(privateKeyPath, keyPair.privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
  chmodSync(privateKeyPath, 0o600);
  const envFile = join(credentialsDir, "github-app.env");
  writeFileSync(
    envFile,
    [
      "GITHUB_APP_ID=4586878",
      "GITHUB_APP_INSTALLATION_ID=153553922",
      `GITHUB_APP_PRIVATE_KEY_PATH=${privateKeyPath}`,
    ].join("\n"),
    { mode: 0o600 },
  );
  chmodSync(envFile, 0o600);
}

if (process.env["ACP_STARTUP_TEST_PARK"] === "1") {
  // No routable quota from any provider, which is the host this bootstrap park exists for.
  // `isRoutableFor` rejects on `runtimeHealth === "UNAVAILABLE"` before it reads buckets, so
  // that field is what makes every required role uncovered here; the empty buckets would do it
  // on their own too. The ERROR sensor raises CAPACITY_SENSOR_FAILED, which is deliberately
  // non-blocking, so ROLE_COVERAGE_NO_VALID_COVERAGE is the only blocking finding and `start()`
  // parks instead of returning. The GitHub credential seed is load-bearing: without it
  // TRUSTED_GATE_CREDENTIAL_MISSING is also blocking and the daemon takes the exit path.
  for (const adapter of adapters) {
    adapter.setCapacity({
      provider: adapter.provider,
      sensorHealth: "ERROR",
      runtimeHealth: "UNAVAILABLE",
      observedAt: systemClock.nowIso(),
      source: "startup-test-no-usage-surface",
      buckets: [],
    });
  }
}

const expectTelegram = process.env["ACP_STARTUP_TEST_EXPECT_TELEGRAM"] === "1";
const expectPromptFlow = process.env["ACP_STARTUP_TEST_EXPECT_PROMPT_FLOW"] === "1";
const expectBuzzWatch = process.env["ACP_STARTUP_TEST_EXPECT_BUZZ_WATCH"] === "1";
const startupTransport = new StartupTelegramTransport(expectPromptFlow);

const exerciseBuzzWatch = async (
  shutdown: (signal: string) => Promise<void>,
  context: AgentcpdMainContext,
): Promise<void> => {
  const messagesPath = process.env["ACP_STARTUP_TEST_BUZZ_MESSAGES"];
  if (!messagesPath) throw new Error("ACP_STARTUP_TEST_BUZZ_MESSAGES is required");
  const connect = async (model: string): Promise<string> => {
    const session = context.cp.sessions.create({ provider: "claude", model });
    const connected = await context.buzz.connect(session.sessionId, `cto:${model}`);
    if (!connected.allowed) throw new Error(`${connected.reasonCode}: ${connected.message}`);
    const ready = context.cp.sessions.transition(
      session.sessionId,
      SessionLifecycle.READY,
      "agentcpd main Buzz watch composition test",
    );
    if (!ready.allowed) throw new Error(`${ready.reasonCode}: ${ready.message}`);
    return session.sessionId;
  };
  const sessionIds = await Promise.all([connect("shared-a"), connect("shared-b")]);
  const waitForRows = async (where: string, description: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const row = context.cp.db.get<{ measured: number }>(
        `SELECT COUNT(*) AS measured FROM buzz_channel_traffic_watch WHERE ${where}`,
      );
      if (row?.measured === sessionIds.length) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`startup test timed out waiting for ${description}`);
  };

  await waitForRows("last_read_success_at IS NOT NULL", "two main-composed Buzz baselines");
  const createdAt = Math.floor(Date.now() / 1000) + 1;
  writeFileSync(
    messagesPath,
    JSON.stringify([{
      id: "startup-main-shared-event",
      content: "<redacted>",
      pubkey: "startup-test-pubkey",
      created_at: createdAt,
      kind: 9,
      tags: [],
    }]),
    "utf8",
  );
  await waitForRows(
    "observed_count = 1 AND window_started_at IS NOT NULL",
    "two main-composed Buzz event windows",
  );

  const report = await context.cp.doctor.run("system");
  for (const sessionId of sessionIds) {
    const measured = report.findings.find(
      (finding) =>
        finding.code ===
          "BUZZ_RAW_CHANNEL_EVENT_IDS_RETURNED_BY_SINCE_ABSENT_FROM_PRECEDING_COMPLETED_READ" &&
        finding.observedEvidence["sessionId"] === sessionId,
    );
    if (
      measured?.observedEvidence[
        "rawChannelEventIdsReturnedBySinceAbsentFromPrecedingCompletedRead"
      ] !== 1
    ) {
      throw new Error(`startup test saw no raw Buzz event-id count for ${sessionId}`);
    }
  }
  process.stdout.write("startup test main composed the Buzz channel event watch\n");
  await shutdown("STARTUP_BUZZ_WATCH_TEST");
};

try {
  await main({
    config,
    telegramStartOptions: {
      transport: startupTransport,
      ...(expectPromptFlow ? { start: false } : {}),
    },
    ...(expectBuzzWatch
      ? { buzzChannelTrafficIntervalMs: 100, afterDaemonStart: exerciseBuzzWatch }
      : {}),
    waitForShutdown: async (shutdown, context) => {
      if (expectPromptFlow) {
        if (!context.telegram) throw new Error("Telegram startup test did not compose the listener");
        const gateItem = "owner confirms prompt";
        const ceoSession = context.cp.sessions.create({ provider: "claude", model: "startup-test-ceo" });
        const ceoReady = context.cp.sessions.transition(
          ceoSession.sessionId,
          SessionLifecycle.READY,
          "startup prompt-flow test",
        );
        if (!ceoReady.allowed) throw new Error(ceoReady.message);
        const ceoBinding = context.cp.bindings.bind({
          roleKey: roleKeyFor(Role.CEO),
          role: Role.CEO,
          sessionId: ceoSession.sessionId,
        });
        if (!ceoBinding.allowed) throw new Error(ceoBinding.message);

        const created = context.cp.runs.create({
          kind: RunKind.PROJECT_BOOTSTRAP,
          executionMode: ExecutionMode.GUARDED,
          contract: {
            goal: "owner prompt startup regression",
            why: "exercise production owner-response delivery",
            scope: [],
            nonGoals: [],
            acceptance: ["owner can resolve the gate"],
            priority: "NORMAL",
            humanGate: [gateItem],
            references: [],
          },
        });
        if (!created.allowed) throw new Error(created.message);
        const runId = created.value.runId;
        const bootstrapSession = context.cp.sessions.create({
          provider: "claude",
          model: "startup-test-bootstrap-cto",
        });
        const bootstrapReady = context.cp.sessions.transition(
          bootstrapSession.sessionId,
          SessionLifecycle.READY,
          "startup prompt-flow test",
        );
        if (!bootstrapReady.allowed) throw new Error(bootstrapReady.message);
        const bootstrapBinding = context.cp.bootstrap.bindBootstrapCto(runId, bootstrapSession.sessionId);
        if (!bootstrapBinding.allowed) throw new Error(bootstrapBinding.message);
        const dispatched = await context.cp.runs.dispatch(runId);
        if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
        const candidateSnapshotDigest = digestOf({ runId, candidate: "startup-owner-prompt" });
        context.cp.runs.promoteCandidate(runId, candidateSnapshotDigest);
        const awaiting = context.cp.runs.transition(
          runId,
          RunState.AWAITING_HUMAN,
          "startup prompt-flow test human gate",
          { candidateSnapshotDigest },
        );
        if (!awaiting.allowed) throw new Error(`${awaiting.reasonCode}: ${awaiting.message}`);
        const notified = context.cp.ceo.notify(NotificationKind.READY_FOR_CEO_REVIEW, runId, {
          goal: created.value.goal,
          candidateSnapshotDigest,
          humanGate: { required: true, items: [gateItem], satisfied: false },
        });
        if (!notified.allowed) throw new Error(`${notified.reasonCode}: ${notified.message}`);

        context.telegram.service.start();
        const deadline = Date.now() + 10_000;
        while (
          (!startupTransport.promptObserved ||
            !startupTransport.approvalSent ||
            !context.cp.ceo.humanGateStatus(runId).satisfied ||
            context.cp.runs.require(runId).state !== RunState.ACTIVE) &&
          Date.now() < deadline
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
        if (
          !startupTransport.promptObserved ||
          !startupTransport.approvalSent ||
          !context.cp.ceo.humanGateStatus(runId).satisfied ||
          context.cp.runs.require(runId).state !== RunState.ACTIVE
        ) {
          throw new Error(
            `startup prompt-flow test timed out: prompt=${startupTransport.promptObserved} ` +
              `approval=${startupTransport.approvalSent} ` +
              `gate=${context.cp.ceo.humanGateStatus(runId).satisfied} ` +
              `state=${context.cp.runs.require(runId).state}`,
          );
        }
        process.stdout.write("startup test owner prompt observed\n");
        process.stdout.write("startup test owner approval cleared gate\n");
      }
      if (expectTelegram) {
        // A polling cycle only shows the loop is turning. Seeding a real owner message and
        // requiring the router's reply is what shows an inbound update is carried through
        // routing — without it this passed even if route() never ran.
        startupTransport.enqueue({
          update_id: 800,
          message: {
            message_id: 801,
            date: 1_700_000_000,
            text: "startup routing probe",
            from: { id: 424242 },
            chat: { id: -100999 },
          },
        });
        const deadline = Date.now() + 15_000;
        while (
          (startupTransport.polls === 0 || startupTransport.routedReplies === 0) &&
          Date.now() < deadline
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
        if (startupTransport.polls === 0) throw new Error("Telegram startup test observed no polling cycle");
        if (startupTransport.routedReplies === 0) {
          throw new Error("Telegram startup test polled but never routed an inbound message");
        }
        // Routing alone does not show which handler answered. Production supplies `onDirect`
        // from the CEO conversation port; no CEO peer is connected here, so that port is the
        // only thing that can produce this reason code. Without the wiring the reply is the
        // router's own formatted string and this fails.
        if (!startupTransport.lastRoutedReply.includes("CEO_CONVERSATION_UNAVAILABLE")) {
          throw new Error(
            `Telegram startup test reply did not come from the CEO route: ${startupTransport.lastRoutedReply}`,
          );
        }
        process.stdout.write("startup test Telegram poll observed\n");
        process.stdout.write("startup test Telegram inbound routed\n");
        process.stdout.write("startup test DIRECT answered by the CEO route\n");
      }
      await shutdown("STARTUP_TEST");
    },
  });
} catch (error) {
  const body = isAcpError(error)
    ? { reasonCode: error.reasonCode, message: error.message, evidence: error.evidence }
    : { message: error instanceof Error ? error.message : String(error) };
  process.stderr.write(`${JSON.stringify(body, null, 2)}\n`);
  process.exit(1);
}
