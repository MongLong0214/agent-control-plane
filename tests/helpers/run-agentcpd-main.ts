import { main } from "../../src/daemon/agentcpd.ts";
import { ControlPlane, defaultConfig } from "../../src/app/control-plane.ts";
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
import { IngressGuard, ingressSignature } from "../../src/ingress/ingress-guard.ts";
import { buzzMessageSigningRequest } from "../../src/ingress/buzz-message.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  // #872: bounded, because an unbounded `spawnSync` holds this worker's event loop and Vitest's
  // per-test timeout then fires against whichever test that worker was holding. A `ps` that
  // cannot answer is exactly the shape this repository has already measured — an `lsof` without
  // `-n` took 30s against a 5s budget and the refusal named the wrong thing.
  const listed = spawnSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8", timeout: 15_000 });
  // On a timeout `spawnSync` sets `error.code` to "ETIMEDOUT" and leaves `status` null, so the
  // status check below would report a budget expiry as a `ps` that answered with a failure.
  // `killed` is deliberately not consulted: it is not set on this path.
  if ((listed.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new Error("ps did not answer within 15000ms — this is the bound, not a process listing");
  }
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

/**
 * Which projects this deployment has registered before the daemon starts, as a comma-separated
 * list of project ids.
 *
 * A canonical entry naming a project the registry does not hold refuses startup, so a scenario
 * whose subject is activation has to register what its entries name. The list is supplied rather
 * than derived from `ACP_CANONICAL_SESSIONS_JSON`: deriving it would register whatever the
 * configured value happened to say, and then no case here — nor any future one — could reach that
 * refusal, because the fixture would have repaired every deployment before `main` ever read it.
 *
 * Registered through `projects.register`, the same call an operator's registration goes through,
 * on a control plane opened and closed before `main` opens its own.
 */
const registerProjectIds = (process.env["ACP_STARTUP_TEST_REGISTER_PROJECTS"] ?? "")
  .split(",")
  .map((projectId) => projectId.trim())
  .filter((projectId) => projectId.length > 0);
if (registerProjectIds.length > 0) {
  const seed = new ControlPlane(config);
  try {
    for (const projectId of registerProjectIds) {
      const registered = seed.projects.register({ name: `startup test ${projectId}`, projectId });
      if (!registered.allowed) throw new Error(`${registered.reasonCode}: ${registered.message}`);
    }
  } finally {
    seed.close();
  }
}

if (process.env["ACP_STARTUP_TEST_PARK"] === "1") {
  // A canonical turn two authorities disagree about: an integrity quarantine, still blocking, and
  // still one `start()` parks for, because the parked door can adjudicate it. This used to be "no
  // routable quota", but capacity is availability and no longer blocks startup, so a case that
  // needs a park has to stand on a real blocker. CANONICAL_TURN_CONTRADICTED is the only blocking
  // finding here, so `start()` parks instead of returning. The GitHub credential seed is
  // load-bearing: without it TRUSTED_GATE_CREDENTIAL_MISSING is also blocking and the daemon
  // takes the exit path. The rows are the ones `the-quarantine-has-an-operator-door.test.ts`
  // builds, written through the same ledger calls.
  const seed = new ControlPlane(config);
  try {
    const at = systemClock.nowIso();
    seed.db.run(
      `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
       VALUES ('runtime:park', 'inc', 'claude', 'opus', 'READY', ?, ?)`,
      [at, at],
    );
    seed.db.run(
      `INSERT INTO conversational_actors
         (actor_id, kind, current_session_id, current_session_incarnation, created_at)
       VALUES ('actor:park', 'CEO', 'runtime:park', 'inc', ?)`,
      [at],
    );
    seed.db.run(
      `INSERT INTO actor_target_bindings
         (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
       VALUES ('bind:park', 'actor:park', 'hermes', 'locator:park', 'digest:park', ?)`,
      [at],
    );
    seed.db.run(
      `INSERT INTO assignments
         (assignment_id, role_key, role, actor_id, session_id, session_incarnation,
          binding_generation, mode, status, created_at)
       VALUES ('asg:park', 'CEO:park', 'CEO', 'actor:park', 'runtime:park', 'inc', 1, 'PREFERRED', 'ACTIVE', ?)`,
      [at],
    );
    seed.db.run(
      `INSERT INTO actor_target_attestations
         (target_attestation_id, target_binding_id, protocol_version, attestation_digest,
          executor_session_id, executor_session_incarnation, binding_generation, assignment_id,
          attested_at)
       VALUES ('att:park', 'bind:park', 'v1', 'attd:park', 'runtime:park', 'inc', 1, 'asg:park', ?)`,
      [at],
    );
    const admitted = new IngressGuard(seed.db, seed.clock, seed.audit, {
      telegram: { allowedActors: ["owner"], allowedConversations: ["convo"] },
    }).admit({ channel: "telegram", actor: "owner", conversation: "convo", nonce: "park-m1", payload: {} });
    if (!admitted.allowed) throw new Error(`park fixture could not admit its source: ${admitted.reasonCode}`);
    const claimed = seed.conversation.claim({
      targetActorId: "actor:park",
      prompt: "park-m1",
      sources: [{ channel: "telegram", nonce: "park-m1", attempt: 1, payload: {} }],
    });
    if (!claimed.allowed) throw new Error(`park fixture claim refused: ${claimed.reasonCode}`);
    seed.conversation.ports.target.completed(claimed.value, {
      receiptId: "target:park-m1",
      evidenceDigest: "sha256:receipt",
      reasonCode: ReasonCode.OK,
    });
    seed.conversation.ports.preDispatch.neverAdmitted(claimed.value, {
      receiptId: "pre:park-m1",
      evidenceDigest: "sha256:pre",
      reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
    });
  } finally {
    seed.close();
  }
}

/**
 * Projects whose primary CTO is bound to a session that has died, as a comma-separated list. Each
 * is registered if it is not already, and its binding is left ACTIVE on an ERROR session, which is
 * what the startup doctor reads as CTO_BINDING_POINTS_AT_DEAD_SESSION.
 */
const deadCtoProjectIds = (process.env["ACP_STARTUP_TEST_DEAD_CTO"] ?? "")
  .split(",")
  .map((projectId) => projectId.trim())
  .filter((projectId) => projectId.length > 0);
if (deadCtoProjectIds.length > 0) {
  const seed = new ControlPlane(config);
  try {
    for (const projectId of deadCtoProjectIds) {
      if (!seed.projects.get(projectId)) {
        const registered = seed.projects.register({ name: `startup test ${projectId}`, projectId });
        if (!registered.allowed) throw new Error(`${registered.reasonCode}: ${registered.message}`);
      }
      const session = seed.sessions.create({ provider: "claude", model: "startup-test-dead-cto" });
      const ready = seed.sessions.transition(session.sessionId, SessionLifecycle.READY, "startup test cto");
      if (!ready.allowed) throw new Error(ready.message);
      const bound = seed.bindings.bind({
        role: Role.PRIMARY_CTO,
        roleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId }),
        projectId,
        sessionId: session.sessionId,
      });
      if (!bound.allowed) throw new Error(bound.message);
      const died = seed.sessions.transition(session.sessionId, SessionLifecycle.ERROR, "startup test: cto died");
      if (!died.allowed) throw new Error(died.message);
    }
  } finally {
    seed.close();
  }
}

if (process.env["ACP_STARTUP_TEST_NO_CAPACITY"] === "1") {
  // No routable quota from any provider. `isRoutableFor` rejects on `runtimeHealth ===
  // "UNAVAILABLE"` before it reads buckets, so every required role is uncovered: the startup
  // doctor reports ROLE_COVERAGE_NO_VALID_COVERAGE beside the non-blocking
  // CAPACITY_SENSOR_FAILED. Neither blocks startup; both are availability.
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
        // Dispatch staffs the run's BOOTSTRAP_CTO on the Claude adapter and pins it (#246). A CTO
        // is constituted only with a Buzz route, and this startup scenario runs with no Buzz
        // binary; the flow under test is Telegram's, so the CTO lifecycle gets an in-process route.
        context.cp.cto.attach({
          buzz: {
            connect: async (sessionId) => allow(ReasonCode.OK, `startup-test-room:${sessionId}`),
            disconnect: async () => undefined,
          },
        });
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
      if (process.env["ACP_STARTUP_TEST_REPORT_SOCKETS"] === "1") {
        // Read from the filesystem while the daemon is still up, not from anything it says about
        // itself: each name is a socket `main` binds only after `daemon.start()` returned.
        const stateRoot = join(root, ".agent-control-plane");
        const sockets = Object.fromEntries(
          ["agentcpd.claim-canonical-cto.sock", "cto.mcp.sock", "hermes.mcp.sock"].map((name) => {
            const path = join(stateRoot, name);
            return [name, existsSync(path) && statSync(path).isSocket()];
          }),
        );
        const mode = (JSON.parse(readFileSync(join(stateRoot, "health.json"), "utf8")) as { mode?: string }).mode;
        process.stdout.write(`startup test sockets ${JSON.stringify({ mode, sockets })}\n`);
        // What the startup doctor itself recorded, so a caller can see the findings were there.
        const startupReport = context.cp.audit
          .byKind("DOCTOR_REPORT")
          .map((event) => event.evidence as {
            scope: string;
            findings: Array<{ code: string; severity: string; blocking: boolean }>;
          })
          .find((evidence) => evidence.scope === "system");
        process.stdout.write(
          `startup test doctor findings ${JSON.stringify(
            (startupReport?.findings ?? []).map((f) => `${f.code}/${f.severity}/${f.blocking ? "blocking" : "nonblocking"}`),
          )}\n`,
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
