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
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ingressSignature } from "../../src/ingress/ingress-guard.ts";
import { buzzMessageSigningRequest } from "../../src/ingress/buzz-message.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

/**
 * Every live child of this process, read from the OS rather than from anything the daemon says
 * about itself.
 *
 * `ps -A -o pid=,ppid=` is the form both BSD and GNU `ps` accept. The whole point of #627 is
 * that the deployed Buzz path answers by starting `hermes acp` as a session child, so "no fork"
 * has to be measured as processes, not inferred from a delivery that succeeded.
 */
const childPids = (): string[] => {
  const listed = spawnSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" });
  if (listed.status !== 0) throw new Error(`could not list processes: ${listed.stderr}`);
  const children: string[] = [];
  for (const line of listed.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/u);
    if (parts.length < 3 || Number(parts[1]) !== process.pid) continue;
    const command = parts.slice(2).join(" ");
    // `ps` lists itself, and it is this reading's own child. Counting it would put a transient
    // in both numbers and make a real spawn harder to see rather than easier.
    if (/(^|\/)ps$/u.test(parts[2] ?? "")) continue;
    children.push(command.slice(0, 80));
  }
  return children;
};

/** Reads one newline-delimited response from a local ingress socket. */
const exchangeSocketLine = (socketPath: string, line: unknown): Promise<string> =>
  new Promise((resolveExchange, rejectExchange) => {
    const socket = createConnection(socketPath);
    let received = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) rejectExchange(error);
      else resolveExchange(received);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new Error("Buzz message socket response timed out"));
    }, 20_000);
    timer.unref();
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(line)}\n`));
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.includes("\n")) socket.end();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      finish(error);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      finish();
    });
  });

class StartupAdapter extends ScriptedAdapter {
  override readonly isProduction = true;
}

class StartupTelegramTransport implements TelegramBotTransport {
  // This transport runs through `main()` -> `startTelegramLongPollListener`, which now derives
  // IngressGuard's retention floor from this value (#682, round 8). Declared as the real
  // measured figure since this stand-in behaves like ordinary Telegram long-polling.
  readonly redeliveryRetentionMs = 24 * 60 * 60 * 1000;
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
// Off by default so this fake stands in for the transport, the same as every other startup
// scenario. Set to exercise the *real* `TelegramBotApi` composition — no fake transport at all —
// so `ACP_TELEGRAM_API_BASE_URL` actually reaches it and its `redeliveryRetentionMs` is computed
// from the real class rather than this fixture's own declared value.
const useRealTelegramTransport = process.env["ACP_STARTUP_TEST_REAL_TELEGRAM_TRANSPORT"] === "1";
const expectBuzzMessage = process.env["ACP_STARTUP_TEST_EXPECT_BUZZ_MESSAGE"] === "1";
const startupTransport = new StartupTelegramTransport(expectPromptFlow);

try {
  await main({
    config,
    telegramStartOptions: {
      ...(useRealTelegramTransport ? {} : { transport: startupTransport }),
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
      if (expectBuzzMessage) {
        // #627: an owner Buzz message reaches the CEO through the daemon's own socket, and no
        // session child is started to answer it. Everything here goes through the composition
        // `main` built — the socket it opened, the port it wired — because a test that called
        // the ingress class directly would not prove the socket path reaches it.
        if (!context.ceoConversation) throw new Error("Buzz startup test found no CEO conversation port");

        const ceoSession = context.cp.sessions.create({ provider: "claude", model: "startup-test-ceo" });
        const ceoReady = context.cp.sessions.transition(
          ceoSession.sessionId,
          SessionLifecycle.READY,
          "startup buzz-message test",
        );
        if (!ceoReady.allowed) throw new Error(ceoReady.message);
        const ceoBinding = context.cp.bindings.bind({
          roleKey: roleKeyFor(Role.CEO),
          role: Role.CEO,
          sessionId: ceoSession.sessionId,
        });
        if (!ceoBinding.allowed) throw new Error(ceoBinding.message);

        // The peer the CEO socket would attach: it answers sampling requests and is never
        // started by this path — it is already there, which is the entire mechanism.
        const asked: string[] = [];
        const peer = {
          server: {
            getClientCapabilities: () => ({ sampling: {} }),
            createMessage: async (params: { messages: { content: { text?: string } }[] }) => {
              asked.push(params.messages[0]?.content.text ?? "");
              return { model: "startup-test", role: "assistant", content: { type: "text", text: "CEO 응답" } };
            },
          },
        } as unknown as McpServer;
        context.ceoConversation.attach(peer, () =>
          allow(ReasonCode.OK, {
            sessionId: ceoSession.sessionId,
            sessionIncarnation: ceoSession.incarnation,
            sessionSecret: ceoSession.sessionSecret,
          } as never),
        );

        const sessionsBefore = context.cp.db
          .all<{ session_id: string }>(`SELECT session_id FROM sessions ORDER BY session_id`, [])
          .map((row) => row.session_id);
        const childrenBefore = childPids();

        const message = {
          actor: "npub-startup-owner",
          conversation: "buzz-startup-room",
          eventId: "startup-buzz-1",
          addressedTo: "CEO",
          text: "어떻게 돼가?",
        };
        const response = await exchangeSocketLine(
          join(root, ".agent-control-plane", "buzz-message.ingress.sock"),
          {
            ...message,
            signature: ingressSignature(
              process.env["ACP_BUZZ_INGRESS_SECRET"] ?? "",
              buzzMessageSigningRequest(message),
            ),
          },
        );
        const answered = JSON.parse(response.trim()) as {
          ok: boolean;
          reasonCode: string;
          answer: string | null;
          answeredByCeo: boolean;
        };
        if (!answered.ok || answered.reasonCode !== ReasonCode.OK || answered.answer !== "CEO 응답") {
          throw new Error(`Buzz startup test did not get the CEO's answer back: ${response.trim()}`);
        }
        if (!answered.answeredByCeo || asked.length !== 1 || asked[0] !== message.text) {
          throw new Error(`Buzz startup test did not reach the CEO peer: ${JSON.stringify(asked)}`);
        }

        const childrenAfter = childPids();
        const sessionsAfter = context.cp.db
          .all<{ session_id: string }>(`SELECT session_id FROM sessions ORDER BY session_id`, [])
          .map((row) => row.session_id);
        // Both halves of "no fork", and neither is inferred from the delivery having worked:
        // the OS's own child list, and the session registry the deployed path fills with
        // one-answer sessions titled "Configure Buzz platform sess".
        if (childrenAfter.length !== childrenBefore.length) {
          throw new Error(
            `Buzz startup test spawned a child process: before=${JSON.stringify(childrenBefore)} ` +
              `after=${JSON.stringify(childrenAfter)}`,
          );
        }
        if (sessionsAfter.join(",") !== sessionsBefore.join(",")) {
          throw new Error(
            `Buzz startup test created a session: before=${sessionsBefore.length} after=${sessionsAfter.length}`,
          );
        }
        const stillBound = context.cp.bindings.active(roleKeyFor(Role.CEO))?.boundSessionId;
        if (stillBound !== ceoSession.sessionId) {
          throw new Error(`Buzz startup test moved the CEO binding to ${String(stillBound)}`);
        }
        process.stdout.write("startup test Buzz message answered by the CEO route\n");
        // The counts are printed with the child commands behind them: "0 -> 0" and "1 -> 1" are
        // both passes, and only naming what the 1 is lets a reader see that it is the test
        // toolchain's own and not something the turn started.
        process.stdout.write(
          `startup test Buzz message spawned no session child (children ${childrenBefore.length} -> ` +
            `${childrenAfter.length} ${JSON.stringify(childrenAfter)}, sessions ` +
            `${sessionsBefore.length} -> ${sessionsAfter.length})\n`,
        );
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
