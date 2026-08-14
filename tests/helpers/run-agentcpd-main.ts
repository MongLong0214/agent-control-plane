import { main } from "../../src/daemon/agentcpd.ts";
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

  async sendMessage(input: {
    chatId: string;
    text: string;
    replyToMessageId?: number;
    correlationId: string;
  }): Promise<{ messageId: number }> {
    const messageId = this.nextMessageId++;
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

const expectTelegram = process.env["ACP_STARTUP_TEST_EXPECT_TELEGRAM"] === "1";
const expectPromptFlow = process.env["ACP_STARTUP_TEST_EXPECT_PROMPT_FLOW"] === "1";
const startupTransport = new StartupTelegramTransport(expectPromptFlow);

try {
  await main({
    config,
    telegramStartOptions: {
      transport: startupTransport,
      ...(expectPromptFlow ? { start: false } : {}),
    },
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
        const deadline = Date.now() + 5_000;
        while (startupTransport.polls === 0 && Date.now() < deadline) {
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
        if (startupTransport.polls === 0) throw new Error("Telegram startup test observed no polling cycle");
        process.stdout.write("startup test Telegram poll observed\n");
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
