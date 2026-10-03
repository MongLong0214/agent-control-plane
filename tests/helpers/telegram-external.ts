import { copyFileSync, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";

import { expect } from "vitest";

import { ControlPlane, type ControlPlaneConfig } from "../../src/app/control-plane.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { digestOf } from "../../src/core/digest.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import type { TelegramExternalAnswer, TelegramExternalTurnIdentity } from "../../src/ingress/telegram-external.ts";
import {
  configuredTelegramExternalConsumerConfig,
  type TelegramExternalConsumerConfig,
} from "../../src/ingress/telegram-polling.ts";
import { REVIEWER_PROVIDER_ENDPOINTS } from "../../src/runtime/provider.ts";
import type { HermesTargetBindResponse } from "../../src/runtime/hermes-target-bind.ts";
import { TestProductionAdapter } from "./production-adapter.ts";
import { tempDir } from "./fixtures.ts";

/**
 * U4 fixtures: a control plane whose CEO is a Hermes Gateway bound the way adoption binds one
 * (a `hermes.target-bind/v1` attestation carrying the executor's receipt), optionally beside
 * `PRIMARY_CTO` actors attested the way the live canonical self-claim attests them, and a fake
 * Gateway receipt API on an ephemeral loopback port.
 *
 * Every registry is the production one; only the Gateway's HTTP answers are stated by the test.
 */

export const OWNER_ID = 7_000_001;
export const CHAT_ID = 7_000_001;
export const SECRET = "u4-external-lane-fixture-secret";
export const GATEWAY_KEY = "u4-gateway-key-fixture";
export const HEAD = "20261003_070000_live";
export const LINEAGE = `sha256:${"c".repeat(64)}`;
const RUNTIME = "u4-fixture-runtime";
const GATEWAY_PID = 515_151;
const NOW = "2026-10-03T00:00:00.000Z";

export const LANE_ENV = {
  ACP_TELEGRAM_EXTERNAL_CONSUMER: "hermes",
  ACP_TELEGRAM_EXTERNAL_SECRET: SECRET,
  ACP_TELEGRAM_OWNER_ID: String(OWNER_ID),
  ACP_TELEGRAM_CHAT_ID: String(CHAT_ID),
} as const;

export interface ExternalLaneFixture {
  cp: ControlPlane;
  root: string;
  clock: ManualClock;
  /** Absent when the fixture was asked for no Hermes CEO. */
  ceoActorId: string | null;
  /** The parsed lane configuration, through the production parser. */
  laneConfig: TelegramExternalConsumerConfig;
  /**
   * A control plane over the database under `root` (this fixture's own by default), composed the
   * way the first one was: what a daemon restart opens. Close the one it replaces first.
   */
  open(root?: string): ControlPlane;
}

const baseConfig = (root: string, clock: ManualClock): ControlPlaneConfig => ({
  databasePath: join(root, "state.sqlite"),
  worktreeRoot: join(root, "worktrees"),
  capacityDir: join(root, "capacity"),
  secretsDir: join(root, "secrets"),
  clock,
  adapters: [new TestProductionAdapter(clock)],
  allowNonProductionAdapters: true,
  reviewerEgress: {
    profilePath: join(root, "test-reviewer.sb"),
    proxyPath: join(root, "test-allowlist-proxy.py"),
    runtimeDir: join(root, "test-egress-runs"),
    providerEndpoints: { ...REVIEWER_PROVIDER_ENDPOINTS, scripted: ["scripted.provider.test"] },
  },
  ownerIdentities: [{ channel: "telegram", actor: String(OWNER_ID) }],
  ctoPreference: { provider: "scripted", model: "scripted-cto", effort: null },
  reviewer: { preferred: { provider: "scripted", model: "scripted-reviewer", effort: "xhigh" }, fallbacks: [] },
});

interface HermesCeoTarget {
  pid: number;
  head: string;
  lineage: string;
}

const FIRST_CEO: HermesCeoTarget = { pid: GATEWAY_PID, head: HEAD, lineage: LINEAGE };

const bindHermesCeo = (cp: ControlPlane, target: HermesCeoTarget = FIRST_CEO): string => {
  const gateway = cp.sessions.create({
    provider: "hermes",
    model: "hermes-runtime",
    osPid: target.pid,
    osStartedAt: "Sat Oct  3 07:00:00 2026",
  });
  expect(cp.sessions.transition(gateway.sessionId, SessionLifecycle.READY).allowed).toBe(true);
  cp.sessions.pinNativeStart(gateway.sessionId, "darwin-tv:1790000000.000001");
  const claimed = { executorKind: "hermes", targetLocator: target.head, targetLocatorDigest: target.lineage };
  let receipt: HermesTargetBindResponse | null = null;
  const bound = cp.bindings.bind({
    role: Role.CEO,
    sessionId: gateway.sessionId,
    authenticatedTarget: {
      claimed,
      protocolVersion: "hermes.target-bind/v1",
      expectedExecutorRuntimeIdentity: RUNTIME,
      get targetBindReceipt() {
        return receipt;
      },
      get attestationDigest() {
        return receipt?.receipt_digest ?? "";
      },
      verify: (tuple) => {
        const fields = {
          domain: "hermes.target-bind" as const,
          version: 1 as const,
          actor_id: tuple.actorId,
          binding_generation: tuple.generation,
          executor_runtime_identity: RUNTIME,
          requested_session_id: target.head,
          lineage_root_digest: target.lineage,
        };
        receipt = { ...fields, receipt_digest: digestOf(fields) };
        return claimed;
      },
    },
  });
  expect(bound, JSON.stringify(bound)).toMatchObject({ allowed: true });
  return cp.db.get<{ actor_id: string }>(
    "SELECT actor_id FROM assignments WHERE role_key = ? AND status = 'ACTIVE'",
    [roleKeyFor(Role.CEO)],
  )!.actor_id;
};

/**
 * Binds the CEO role to another Hermes Gateway with a lineage of its own, which is a different
 * target actor: what replacing the CEO leaves behind. Returns the new CEO's actor id.
 */
export const replaceHermesCeo = (cp: ControlPlane, index: number): string => {
  expect(cp.bindings.revoke(roleKeyFor(Role.CEO), "u4 fixture: CEO replaced").reasonCode).toBe("OK");
  return bindHermesCeo(cp, {
    pid: GATEWAY_PID + index,
    head: `${HEAD}-replacement-${index}`,
    lineage: `sha256:${index.toString(16).padStart(64, "d")}`,
  });
};

/**
 * The database files exactly as they are on disk at this instant, copied under a fresh root: what a
 * process killed at this instant leaves for the next one to open. Nothing the open transaction has
 * not committed is in them, because SQLite's write-ahead log ignores frames no commit closed.
 */
export const crashImage = (fixture: Pick<ExternalLaneFixture, "root">): string => {
  const image = tempDir("acp-u4-crash-");
  for (const suffix of ["", "-wal"]) {
    const from = join(fixture.root, `state.sqlite${suffix}`);
    if (existsSync(from)) copyFileSync(from, join(image, `state.sqlite${suffix}`));
  }
  return image;
};

/**
 * A `PRIMARY_CTO` held by a `claude-cli` session with a current `acp.canonical-self-claim/v1`
 * attestation: the shape the live deployment has three of beside its CEO.
 */
const attestedCto = (cp: ControlPlane, index: number): void => {
  const db = cp.db;
  const id = `u4-cto-${index}`;
  db.run(`INSERT INTO conversational_actors (actor_id, kind, created_at) VALUES (?, 'PRIMARY_CTO', ?)`, [`actor:${id}`, NOW]);
  db.run(
    `INSERT INTO actor_target_bindings
       (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
     VALUES (?, ?, 'claude-cli', ?, ?, ?)`,
    [`bind:${id}`, `actor:${id}`, `root:${id}`, `digest:root:${id}`, NOW],
  );
  db.run(
    `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
     VALUES (?, 'inc-1', 'claude', 'opus', 'READY', ?, ?)`,
    [`ses:${id}`, NOW, NOW],
  );
  db.run(
    `UPDATE conversational_actors SET current_session_id = ?, current_session_incarnation = 'inc-1' WHERE actor_id = ?`,
    [`ses:${id}`, `actor:${id}`],
  );
  db.run(
    `INSERT INTO assignments
       (assignment_id, role_key, role, actor_id, session_id, session_incarnation,
        binding_generation, mode, status, created_at)
     VALUES (?, ?, 'PRIMARY_CTO', ?, ?, 'inc-1', 1, 'PREFERRED', 'ACTIVE', ?)`,
    [`asg:${id}`, `PRIMARY_CTO:prj-${id}`, `actor:${id}`, `ses:${id}`, NOW],
  );
  db.run(
    `INSERT INTO actor_target_attestations
       (target_attestation_id, target_binding_id, protocol_version, attestation_digest,
        executor_session_id, executor_session_incarnation, binding_generation, assignment_id, attested_at)
     VALUES (?, ?, 'acp.canonical-self-claim/v1', ?, ?, 'inc-1', 1, ?, ?)`,
    [`att:${id}`, `bind:${id}`, `att-digest:${id}`, `ses:${id}`, `asg:${id}`, NOW],
  );
};

export const externalLaneFixture = (options: {
  /** How the daemon would compose the config, given the fixture's base. */
  configure?: (config: ControlPlaneConfig) => ControlPlaneConfig;
  hermesCeo?: boolean;
  otherCtos?: number;
} = {}): ExternalLaneFixture => {
  const root = tempDir("acp-u4-");
  const clock = new ManualClock(NOW);
  const open = (at: string = root): ControlPlane => {
    const base = baseConfig(at, clock);
    return new ControlPlane(options.configure ? options.configure(base) : base);
  };
  const cp = open();
  const ceoActorId = options.hermesCeo === false ? null : bindHermesCeo(cp);
  for (let index = 0; index < (options.otherCtos ?? 0); index += 1) attestedCto(cp, index);
  const laneConfig = configuredTelegramExternalConsumerConfig(baseConfig(root, clock).ownerIdentities ?? [], {
    ...LANE_ENV,
  });
  if (!laneConfig) throw new Error("the fixture's lane environment did not configure a lane");
  return { cp, root, clock, ceoActorId, laneConfig, open };
};

/** One owner update, in the envelope Hermes sends. */
export const envelope = (
  updateId: number,
  text: string,
  overrides: {
    secret?: string;
    fromId?: number;
    chatId?: number;
    messageId?: number;
    message?: Record<string, unknown>;
  } = {},
): Record<string, unknown> => ({
  schema: "acp.telegram-external-update/v1",
  binding: "acp-canonical-ceo",
  secret: overrides.secret ?? SECRET,
  update: {
    update_id: updateId,
    message: {
      message_id: overrides.messageId ?? updateId + 100,
      from: { id: overrides.fromId ?? OWNER_ID },
      chat: { id: overrides.chatId ?? CHAT_ID, type: "private" },
      text,
      ...overrides.message,
    },
  },
});

const TABLES = [
  "sessions",
  "assignments",
  "conversational_actors",
  "actor_target_bindings",
  "actor_target_attestations",
  "audit_events",
  "inbound_messages",
  "outbox",
  "canonical_turns",
  "canonical_turn_sources",
  "canonical_turn_dispatches",
  "canonical_turn_observations",
] as const;

/** Every table the lane or a settlement could write, as sorted rows. */
export const snapshot = (cp: ControlPlane): Record<string, string[]> =>
  Object.fromEntries(
    TABLES.map((table) => [
      table,
      cp.db.all<Record<string, unknown>>(`SELECT * FROM ${table}`).map((row) => JSON.stringify(row)).sort(),
    ]),
  );

/** Writes one line to the lane's socket and reads its one answer, as Hermes would. */
export const sendOverSocket = (socketPath: string, value: unknown): Promise<TelegramExternalAnswer> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      try {
        const lines = buffer.split("\n").filter((line) => line.length > 0);
        if (lines.length !== 1) throw new Error(`expected one answer line, got ${lines.length}`);
        resolve(JSON.parse(lines[0]!) as TelegramExternalAnswer);
      } catch (error) {
        reject(error);
      }
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
    });
    socket.on("end", finish);
    // A request the daemon refused before reading all of it can reset the rest of the write; the
    // answer it sent first is still the answer.
    socket.on("error", (error) => {
      if (buffer.includes("\n")) return finish();
      if (settled) return;
      settled = true;
      reject(error);
    });
    socket.write(`${JSON.stringify(value)}\n`);
  });

export interface GatewayRequest {
  path: string;
  authorization: string | undefined;
}

export type GatewayAnswer =
  | { kind: "json"; status?: number; body: unknown; contentType?: string }
  | { kind: "raw"; status?: number; body: string; contentType?: string }
  | { kind: "hang" };

/** The Gateway's receipt API, answered by the test, on an ephemeral loopback port. */
export class FakeGateway {
  readonly requests: GatewayRequest[] = [];
  answer: (updateId: number) => GatewayAnswer = () => ({ kind: "json", body: { status: "NEVER_FOUND" } });
  #server: Server | null = null;
  #hanging: ServerResponse[] = [];

  async start(): Promise<number> {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      this.requests.push({ path: req.url ?? "", authorization: req.headers.authorization });
      const match = /^\/v1\/canonical-surface\/receipts\/telegram\/(\d+)$/.exec(req.url ?? "");
      const reply = match ? this.answer(Number(match[1])) : { kind: "json" as const, status: 404, body: {} };
      if (reply.kind === "hang") {
        this.#hanging.push(res);
        return;
      }
      const text = reply.kind === "json" ? JSON.stringify(reply.body) : reply.body;
      res.writeHead(reply.status ?? 200, { "content-type": reply.contentType ?? "application/json" });
      res.end(text);
    });
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fake gateway has no port");
    return address.port;
  }

  async close(): Promise<void> {
    for (const res of this.#hanging) res.destroy();
    this.#hanging = [];
    const server = this.#server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** The Gateway's terminal answer for a turn the lane returned, optionally with one field altered. */
export const gatewayReceipt = (
  updateId: number,
  turn: TelegramExternalTurnIdentity,
  options: {
    status?: "COMPLETED" | "ABORTED" | "PENDING" | "NEVER_FOUND";
    identity?: Partial<TelegramExternalTurnIdentity>;
    messageId?: number;
    receiptId?: string;
    reasonCode?: string;
    extra?: Record<string, unknown>;
  } = {},
): Record<string, unknown> => {
  const identity = { ...turn, ...options.identity };
  return {
    schema: "hermes.gateway-turn-receipt/v1",
    update_id: updateId,
    message_id: options.messageId ?? updateId + 100,
    status: options.status ?? "COMPLETED",
    turnRequestId: identity.turnRequestId,
    receiptIdentity: identity,
    receiptId: options.receiptId ?? `hermes-tg:obligation-${updateId}`,
    evidenceDigest: digestOf({ finalText: `answer to ${updateId}` }),
    reasonCode: options.reasonCode ?? "OK",
    delivery: {
      chat_id: String(CHAT_ID),
      reply_to_message_id: updateId + 100,
      message_ids: [9_000 + updateId],
      content_digest: digestOf(`answer to ${updateId}`),
      state: "delivered",
    },
    ...options.extra,
  };
};
