import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Server } from "node:net";
import { dirname, join } from "node:path";

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { ControlPlane, defaultConfig } from "../../src/app/control-plane.ts";
import { BUZZ_SUBSCRIBER_CONFIG_FILENAME } from "../../src/buzz/buzz-mention-subscriber.ts";
import { systemClock } from "../../src/core/clock.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { type Decision, allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { main } from "../../src/daemon/agentcpd.ts";
import type * as ListenerModule from "../../src/daemon/canonical-self-claim-listener.ts";
import type * as OperatorModule from "../../src/daemon/canonical-self-claim-operator.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import type * as ReattachModule from "../../src/registry/canonical-cto-reattach.ts";
import {
  CANONICAL_CTO_BUZZ_ADDRESS_CORRECTED,
  type CanonicalCtoReattachOptions,
} from "../../src/registry/canonical-cto-reattach.ts";
import {
  hostSessionRegistryAbsent,
  SELF_CLAIM_EXECUTOR_KIND,
  SELF_CLAIM_PROTOCOL,
  type CanonicalSelfClaimDeps,
  type ProcessSnapshot,
} from "../../src/registry/canonical-self-claim.ts";
import { TELEGRAM_EXTERNAL_SOCKET_NAME } from "../../src/ingress/telegram-external.ts";
import { ScriptedAdapter } from "../../src/runtime/scripted-adapter.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

/**
 * PR1060-R2-01, through the real `main()`.
 *
 * The deployment's room is DEFAULT_ROOM and the canonical CTO's entry routes it to ITS_ROOM. Startup
 * compared `ACP_BUZZ_CHANNEL` with the union of the subscriber's rooms only, so a subscriber whose
 * identity listens in DEFAULT_ROOM alone started cleanly; the claim and the reattach's correction
 * then put the CTO's row in ITS_ROOM, where the CEO's mentions were never subscribed to. Startup now
 * refuses that configuration, and still starts the one whose identity listens in both.
 */

afterAll(cleanupTempDirs);

/**
 * What the canonical-startup cases below hand `main()`'s own claim and reattach. Only the process
 * evidence a test process cannot present and the room opener are replaced: the room check, the
 * subscriber lookup, the entries, the purpose, the listeners and every write are `main()`'s. The
 * opener stands in for the Buzz CLI, so each call to it is one Buzz call.
 */
interface CanonicalEvidence {
  claimDeps: CanonicalSelfClaimDeps;
  reattach: Pick<CanonicalCtoReattachOptions, "processes" | "inspector" | "registryReader">;
  resolveBuzzAddress: (purpose: string, channelId: string) => Promise<Decision<string>>;
}

const hooks = vi.hoisted(() => ({
  claim: null as ListenerModule.CanonicalSelfClaimHandler | null,
  reattach: null as ((peer: ListenerModule.AuthenticatedClaimPeer) => Promise<Decision<unknown>>) | null,
  evidence: null as CanonicalEvidence | null,
}));

// Pass-through unless a case set `hooks.evidence`: the two cases above run exactly as before.
vi.mock("../../src/daemon/canonical-self-claim-listener.ts", async (original) => {
  const actual = await original<typeof ListenerModule>();
  return {
    ...actual,
    startCanonicalSelfClaimListener: (...args: Parameters<typeof actual.startCanonicalSelfClaimListener>) => {
      hooks.claim = args[2];
      return actual.startCanonicalSelfClaimListener(...args);
    },
    startCanonicalCtoToolListener: (...args: Parameters<typeof actual.startCanonicalCtoToolListener>) => {
      hooks.reattach = args[2];
      return actual.startCanonicalCtoToolListener(...args);
    },
  };
});
vi.mock("../../src/daemon/canonical-self-claim-operator.ts", async (original) => {
  const actual = await original<typeof OperatorModule>();
  return {
    ...actual,
    executeCanonicalSelfClaimOperator: (...[peer, params, deps]: Parameters<typeof actual.executeCanonicalSelfClaimOperator>) =>
      actual.executeCanonicalSelfClaimOperator(peer, params, hooks.evidence === null ? deps : {
        ...deps,
        resolveBuzzAddress: hooks.evidence.resolveBuzzAddress,
        claimDeps: hooks.evidence.claimDeps,
      }),
  };
});
vi.mock("../../src/registry/canonical-cto-reattach.ts", async (original) => {
  const actual = await original<typeof ReattachModule>();
  return {
    ...actual,
    createCanonicalCtoReattach: (
      cp: Parameters<typeof actual.createCanonicalCtoReattach>[0],
      options: CanonicalCtoReattachOptions = {},
    ) => {
      const evidence = hooks.evidence;
      if (evidence === null || options.buzzAddress === undefined) return actual.createCanonicalCtoReattach(cp, options);
      return actual.createCanonicalCtoReattach(cp, {
        ...options,
        ...evidence.reattach,
        buzzAddress: { ...options.buzzAddress, resolveBuzzAddress: evidence.resolveBuzzAddress },
      });
    },
  };
});

class StartupAdapter extends ScriptedAdapter {
  override readonly isProduction = true;
}

const DEFAULT_ROOM = "c37e88d0-0000-4000-8000-000000000001";
const ITS_ROOM = "6dcb2a67-0000-4000-8000-000000000002";
const PROJECT = "room-project";

/** The bound CTO's conversation, and the one a fresh claim takes for a second project. */
const HOLDER = "11111111-1111-4111-8111-111111111111";
const FRESH = "22222222-2222-4222-8222-222222222222";
const FRESH_PROJECT = "fresh-room-project";
const FRESH_ACTOR = "buzz:fresh-room-cto";
const HOLDER_START = "darwin-tv:1790000100.000001";
const RELAY = 545_454;
const CLAIMANT = 100;

/** The subscriber's native factory opens `globalThis.WebSocket`; this one connects to nothing. */
const relaySockets: { url: string; closed: boolean }[] = [];
class InertWebSocket {
  readonly #record: { url: string; closed: boolean };
  constructor(url: string) {
    this.#record = { url, closed: false };
    relaySockets.push(this.#record);
  }
  send(): void {
    /* nothing is connected */
  }
  close(): void {
    this.#record.closed = true;
  }
  addEventListener(): void {
    /* no event ever arrives */
  }
  removeEventListener(): void {
    /* nothing was registered that matters */
  }
}

const signals = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
afterEach(() => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const listener of process.listeners(signal)) {
      if (!signals[signal].includes(listener)) process.removeListener(signal, listener);
    }
  }
  relaySockets.splice(0);
  hooks.claim = null;
  hooks.reattach = null;
  hooks.evidence = null;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/**
 * The bound CTO's `claude` is this test process, so the startup reconcile finds it alive and keeps
 * its row READY; its relay is a stated child. The fresh claimant is a stated chain of its own.
 */
const canonicalEvidence = (buzzCalls: string[]): CanonicalEvidence => {
  const holderTree = new Map<number, { ppid: number; startedAt: string; argv: readonly string[] }>([
    [process.pid, { ppid: 1, startedAt: HOLDER_START, argv: ["/Users/fixture/.local/bin/claude", "--resume", HOLDER] }],
    [RELAY, { ppid: process.pid, startedAt: "darwin-tv:1790000200.000002", argv: ["node", "agentctl", "attach"] }],
  ]);
  const snapshotOf = (pid: number, stated: { ppid: number; startedAt: string; argv: readonly string[] }): ProcessSnapshot => ({
    pid,
    ppid: stated.ppid,
    command: stated.argv.join(" "),
    cwd: "/Users/fixture/work",
    cwdProbeFailure: null,
    startedAt: stated.startedAt,
    argv: stated.argv,
  });
  const freshChain: ProcessSnapshot[] = [
    snapshotOf(CLAIMANT, { ppid: 50, startedAt: "t1", argv: ["/usr/bin/node", "/opt/acp/mcp-server.js"] }),
    snapshotOf(50, { ppid: 10, startedAt: "t2", argv: ["/bin/zsh", "-c", "claude"] }),
    snapshotOf(10, { ppid: 1, startedAt: "Fri Jan  1 00:00:00 2027", argv: ["/opt/claude/claude", "--session-id", FRESH] }),
  ];
  return {
    claimDeps: {
      processInspector: { snapshot: (pid) => freshChain.find((entry) => entry.pid === pid) ?? null },
      imageInspector: {
        resolve: () => ({ imagePath: "/fake/versions/current/claude", version: "0.0.0-test", sha256: `sha256:${"0".repeat(64)}` }),
      },
      transcriptReader: { locate: (uuid) => ({ path: `/fake/transcripts/${uuid}.jsonl`, sizeBytes: 42 }) },
      hostSessionRegistryReader: { read: (pid) => hostSessionRegistryAbsent(`/fake/claude/sessions/${pid}.json is absent`) },
      processSignal: (pid) => {
        if (freshChain.some((entry) => entry.pid === pid)) return;
        throw Object.assign(new Error(`no such process: ${pid}`), { code: "ESRCH" });
      },
    },
    reattach: {
      processes: {
        parentOf: (pid) => holderTree.get(pid)?.ppid ?? null,
        startToken: (pid) => holderTree.get(pid)?.startedAt ?? null,
      },
      inspector: {
        readStartToken: (pid) => holderTree.get(pid)?.startedAt ?? null,
        snapshot: (pid) => {
          const stated = holderTree.get(pid);
          return stated ? snapshotOf(pid, stated) : null;
        },
      },
      registryReader: { read: () => hostSessionRegistryAbsent("absent") },
    },
    resolveBuzzAddress: async (_purpose, channelId) => {
      buzzCalls.push(channelId);
      return allow(ReasonCode.OK, channelId);
    },
  };
};

interface DeploymentShape {
  /** The bound CTO's own key in `buzz-nostr-subscriber.json`, a key no session holds, or no file. */
  subscriber?: "bound" | "unbound" | "absent";
  /** Without a buzz owner no message ingress starts, and so no subscriber. */
  buzzOwner?: boolean;
  /**
   * The CTO bound the way the canonical claim binds one, a second entry nobody has claimed yet, and
   * `main()`'s own claim and reattach handed the evidence above.
   */
  canonical?: boolean;
  /** Called once, when startup reports the reattach socket open: before any subscriber exists. */
  onReattachOpened?: () => void;
  /**
   * Telegram's external lane configured for Hermes, with a regular file where its socket goes: that
   * start refuses on the production path, after the subscriber has been decided.
   */
  telegramExternalBlocked?: boolean;
}

const TELEGRAM_OWNER = "4242";

/** A deployment whose canonical CTO holds its role live, with its subscriber listening in `rooms`. */
const deployment = (rooms: readonly string[], shape: DeploymentShape = {}) => {
  const root = tempDir("acp-room-sub-");
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  const keyFile = join(root, "subscriber.key");
  const subscriberKey = shape.subscriber === "unbound" ? generateSecretKey() : secretKey;
  writeFileSync(keyFile, Buffer.from(subscriberKey).toString("hex"), { mode: 0o600 });
  if (shape.subscriber !== "absent") {
    writeFileSync(join(root, BUZZ_SUBSCRIBER_CONFIG_FILENAME), JSON.stringify({
      relayUrl: "wss://relay.example.invalid/buzz",
      identities: [{ privateKeyFile: keyFile, encoding: "hex", rooms }],
    }));
  }

  // The startup doctor reads these local files; no GitHub request is made.
  const credentials = join(root, "credentials");
  mkdirSync(credentials, { mode: 0o700 });
  const privateKeyPath = join(credentials, "github-app.private-key.pem");
  writeFileSync(privateKeyPath, generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
  writeFileSync(join(credentials, "github-app.env"), [
    "GITHUB_APP_ID=4586878", "GITHUB_APP_INSTALLATION_ID=153553922",
    `GITHUB_APP_PRIVATE_KEY_PATH=${privateKeyPath}`,
  ].join("\n"), { mode: 0o600 });
  const config = {
    ...defaultConfig(root),
    ownerIdentities: [
      ...(shape.buzzOwner === false ? [] : [{ channel: "buzz" as const, actor: "startup-owner" }]),
      ...(shape.telegramExternalBlocked ? [{ channel: "telegram" as const, actor: TELEGRAM_OWNER }] : []),
    ],
    adapters: [new StartupAdapter(systemClock, "claude"), new StartupAdapter(systemClock, "gpt")],
    ctoPreference: { provider: "claude", model: "scripted-cto", effort: null },
  };
  // The CTO holds its role live under its channel identity, so the subscriber's preflight admits
  // the identity and the subscriber actually starts: the configuration under test is reached.
  const seed = new ControlPlane(config);
  try {
    seed.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [
      PROJECT, "room cross-check", systemClock.nowIso(),
    ]);
    if (shape.canonical) {
      seed.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [
        FRESH_PROJECT, "fresh claim", systemClock.nowIso(),
      ]);
    }
    const session = shape.canonical
      ? seed.sessions.create({
        provider: "claude", model: "claude-cli", osPid: process.pid, osStartedAt: HOLDER_START, buzzAddress: DEFAULT_ROOM,
      })
      : seed.sessions.create({ provider: "claude", model: "startup-cto", buzzAddress: DEFAULT_ROOM });
    expect(seed.sessions.transition(session.sessionId, SessionLifecycle.READY, "startup test").allowed).toBe(true);
    expect(seed.sessions.bindBuzzActor({
      sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: pubkey,
    }, { isAllowedActor: () => true }).allowed).toBe(true);
    const claimed = { executorKind: SELF_CLAIM_EXECUTOR_KIND, targetLocator: HOLDER, targetLocatorDigest: sha256(HOLDER) };
    const bound = shape.canonical
      ? seed.bindings.bind({
        role: Role.PRIMARY_CTO,
        sessionId: session.sessionId,
        projectId: PROJECT,
        authenticatedTarget: {
          claimed,
          protocolVersion: SELF_CLAIM_PROTOCOL,
          attestationDigest: digestOf({ fixture: "room-subscribed", sessionId: session.sessionId }),
          verify: () => claimed,
        },
      })
      : seed.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: session.sessionId, projectId: PROJECT });
    expect(bound.allowed, JSON.stringify(bound)).toBe(true);
  } finally {
    seed.close();
  }

  // Only listening and the relay connection are substituted: the sandbox denies Unix socket binds,
  // and no test reaches a relay. The real main(), daemon, doctor and subscriber preflight all run.
  // A canonical case answers each listen on the next turn, as a real bind does, so whatever an early
  // connection started has run before startup goes on.
  vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, ...args: unknown[]) {
    writeFileSync(args[0] as string, "");
    if (shape.canonical) setImmediate(args[1] as () => void);
    else (args[1] as () => void)();
    return this;
  });
  vi.spyOn(Server.prototype, "close").mockImplementation(function (this: Server, callback) {
    callback?.();
    return this;
  });
  vi.stubGlobal("WebSocket", InertWebSocket);
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  let reattachOpened = false;
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((text: unknown) => {
    if (!reattachOpened && String(text) === "canonical CTO reattach socket started\n") {
      reattachOpened = true;
      shape.onReattachOpened?.();
    }
    return true;
  }) as typeof process.stdout.write);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ACP_TELEGRAM_") || key.startsWith("ACP_CANONICAL_") || key === "BUZZ_PRIVATE_KEY") {
      vi.stubEnv(key, undefined);
    }
  }
  const entries = shape.canonical
    ? [
      { sessionUuid: HOLDER, projectId: PROJECT, buzzActorId: pubkey, buzzAddress: ITS_ROOM },
      { sessionUuid: FRESH, projectId: FRESH_PROJECT, buzzActorId: FRESH_ACTOR, buzzAddress: ITS_ROOM },
    ]
    : [{ sessionUuid: "99999999-9999-4999-8999-999999999999", projectId: PROJECT, buzzActorId: pubkey, buzzAddress: ITS_ROOM }];
  for (const [key, value] of Object.entries({
    ACP_MCP_TOKEN: "startup-mcp-token",
    ACP_OPERATOR_TOKEN: "startup-operator-token",
    ACP_OPERATOR_ACTOR: "startup-owner",
    ACP_BUZZ_INGRESS_SECRET: "startup-buzz-secret",
    ACP_BUZZ_ALLOWED_ACTORS: "startup-owner",
    ACP_BUZZ_CHANNEL: DEFAULT_ROOM,
    ACP_CANONICAL_SESSIONS_JSON: JSON.stringify(entries),
    ACP_CANONICAL_CTO_PEER_PROTOCOL: "acp.startup-test/v9",
    ACP_CANONICAL_CTO_BUZZ_PURPOSE: "continuity:STARTUP_TEST_CTO",
  })) vi.stubEnv(key, value);
  const buzzCalls: string[] = [];
  if (shape.canonical) hooks.evidence = canonicalEvidence(buzzCalls);
  if (shape.telegramExternalBlocked) {
    for (const [key, value] of Object.entries({
      ACP_TELEGRAM_EXTERNAL_CONSUMER: "hermes",
      ACP_TELEGRAM_EXTERNAL_SECRET: "startup-telegram-external-secret",
      ACP_TELEGRAM_OWNER_ID: TELEGRAM_OWNER,
      ACP_TELEGRAM_CHAT_ID: TELEGRAM_OWNER,
    })) vi.stubEnv(key, value);
    // The daemon's state directory is the database's; a regular file there is no socket to replace.
    writeFileSync(join(root, TELEGRAM_EXTERNAL_SOCKET_NAME), "");
  }
  const printed = (): string => stdout.mock.calls.map(([text]) => String(text)).join("");
  return { config, pubkey, printed, buzzCalls };
};

it("refuses to start when the CTO's entry routes it to a room its subscriber identity does not listen in", async () => {
  // The union check alone passes here: ACP_BUZZ_CHANNEL is DEFAULT_ROOM, and the identity listens there.
  const { config, pubkey, printed } = deployment([DEFAULT_ROOM]);
  let reachedShutdown = false;
  const started = main({
    config,
    waitForShutdown: async (shutdown) => {
      reachedShutdown = true;
      await shutdown("STARTUP_TEST");
    },
  });

  await expect(started).rejects.toThrow(
    `ACP_CANONICAL_SESSIONS_JSON does not match the Buzz mention subscriber: the canonical CTO for project ${PROJECT} ` +
      `is routed to Buzz room ${ITS_ROOM}, but its mention subscriber identity listens only in ${DEFAULT_ROOM}`,
  );
  await expect(started).rejects.not.toThrow(pubkey);
  expect(reachedShutdown).toBe(false);
  // The subscriber did start (the configuration was reached, not refused earlier) and was closed.
  expect(printed()).toContain("Buzz mention subscriber configured identities: 1");
  expect(relaySockets).toHaveLength(1);
  expect(relaySockets[0]!.closed).toBe(true);
});

it("starts when the CTO's subscriber identity listens in its entry's room as well as the deployment's", async () => {
  const { config, printed } = deployment([DEFAULT_ROOM, ITS_ROOM]);
  let reachedShutdown = false;
  await main({
    config,
    waitForShutdown: async (shutdown) => {
      try {
        expect(printed()).toContain("Buzz mention subscriber configured identities: 1");
        expect(relaySockets).toHaveLength(1);
        reachedShutdown = true;
      } finally {
        await shutdown("STARTUP_TEST");
      }
    },
  });
  expect(reachedShutdown).toBe(true);
  expect(process.exit).toHaveBeenCalledWith(0);
});

/**
 * PR1060-R2-01, the connection that arrives during startup.
 *
 * The claim and reattach sockets open before the subscriber starts, and until it does the room
 * lookup answers `null`, which checks nothing. A claim or a reattach that reached the daemon in that
 * window opened its room and wrote its row, and only then did startup refuse the configuration.
 */
describe("a claim or a correction that reaches the daemon before its rooms are checked", () => {
  const peer = (peerPid: number) => ({ peerPid, uid: process.geteuid?.() ?? -1 });
  const claimFresh = () =>
    hooks.claim!(peer(CLAIMANT), { claimedSessionUuid: FRESH, projectId: FRESH_PROJECT, expectedBindingGeneration: 1 });
  const reattachHolder = () => hooks.reattach!(peer(RELAY));

  const count = (cp: ControlPlane, sql: string, params: unknown[] = []): number =>
    cp.db.get<{ n: number }>(sql, params)?.n ?? -1;
  const roomState = (cp: ControlPlane, holderActor: string) => ({
    sessions: count(cp, "SELECT COUNT(*) AS n FROM sessions"),
    freshSessionRooms: cp.db.all<{ buzz_address: string | null }>(
      "SELECT buzz_address FROM sessions WHERE buzz_actor_id = ?", [FRESH_ACTOR],
    ).map((row) => row.buzz_address),
    claimAuditRows: count(
      cp, "SELECT COUNT(*) AS n FROM audit_events WHERE kind IN ('CANONICAL_SELF_CLAIM_ADMITTED', 'CANONICAL_SELF_CLAIM_REFUSED')",
    ),
    correctionAuditRows: count(cp, "SELECT COUNT(*) AS n FROM audit_events WHERE kind = ?", [CANONICAL_CTO_BUZZ_ADDRESS_CORRECTED]),
    holderRoom: cp.db.get<{ buzz_address: string | null }>(
      "SELECT buzz_address FROM sessions WHERE buzz_actor_id = ?", [holderActor],
    )?.buzz_address ?? null,
  });
  /** The correction is fired after admission and not awaited by anyone; this waits for its row. */
  const correctionLanded = async (cp: ControlPlane): Promise<void> => {
    for (let turn = 0; turn < 200; turn += 1) {
      if (count(cp, "SELECT COUNT(*) AS n FROM audit_events WHERE kind = ?", [CANONICAL_CTO_BUZZ_ADDRESS_CORRECTED]) > 0) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  it("opens no room and writes nothing when the subscriber identity does not listen in the entry's room, and startup still refuses", async () => {
    const early: { claim?: Promise<Decision<unknown>>; reattach?: Promise<Decision<unknown>>; buzzCallsAtOnce?: number } = {};
    const { config, pubkey, printed, buzzCalls } = deployment([DEFAULT_ROOM], {
      canonical: true,
      onReattachOpened: () => {
        early.claim = claimFresh();
        early.reattach = reattachHolder();
        early.buzzCallsAtOnce = buzzCalls.length;
      },
    });
    let reachedShutdown = false;
    const started = main({
      config,
      waitForShutdown: async (shutdown) => {
        reachedShutdown = true;
        await shutdown("STARTUP_TEST");
      },
    });

    await expect(started).rejects.toThrow(
      `ACP_CANONICAL_SESSIONS_JSON does not match the Buzz mention subscriber: the canonical CTO for project ${PROJECT} ` +
        `is routed to Buzz room ${ITS_ROOM}, but its mention subscriber identity listens only in ${DEFAULT_ROOM}`,
    );
    expect(reachedShutdown).toBe(false);
    expect(printed()).toContain("Buzz mention subscriber configured identities: 1");
    // Both connections arrived before the subscriber existed.
    expect(early.buzzCallsAtOnce).toBe(0);
    // The claim was refused before anything was built; the reattach was still admitted.
    await expect(early.claim).resolves.toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
    await expect(early.reattach).resolves.toMatchObject({ allowed: true });
    expect(buzzCalls).toEqual([]);
    const after = new ControlPlane(config);
    try {
      expect(roomState(after, pubkey)).toEqual({
        sessions: 1,
        freshSessionRooms: [],
        claimAuditRows: 0,
        correctionAuditRows: 0,
        holderRoom: DEFAULT_ROOM,
      });
    } finally {
      after.close();
    }
  });

  it("refuses the early claim and applies the early correction once startup has checked the rooms", async () => {
    const early: { claim?: Promise<Decision<unknown>>; reattach?: Promise<Decision<unknown>>; buzzCallsAtOnce?: number } = {};
    const { config, pubkey, buzzCalls } = deployment([DEFAULT_ROOM, ITS_ROOM], {
      canonical: true,
      onReattachOpened: () => {
        early.claim = claimFresh();
        early.reattach = reattachHolder();
        early.buzzCallsAtOnce = buzzCalls.length;
      },
    });
    let state: ReturnType<typeof roomState> | null = null;
    await main({
      config,
      waitForShutdown: async (shutdown, context) => {
        try {
          await correctionLanded(context.cp);
          state = roomState(context.cp, pubkey);
        } finally {
          await shutdown("STARTUP_TEST");
        }
      },
    });
    expect(early.buzzCallsAtOnce).toBe(0);
    await expect(early.claim).resolves.toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
    await expect(early.reattach).resolves.toMatchObject({ allowed: true });
    // The correction waited for the check rather than being dropped: one room opened, one row moved.
    expect(buzzCalls).toEqual([ITS_ROOM]);
    expect(state).toEqual({
      sessions: 1,
      freshSessionRooms: [],
      claimAuditRows: 0,
      correctionAuditRows: 1,
      holderRoom: ITS_ROOM,
    });
  });

  it("holds the early correction when a startup step after the room check refuses the start", async () => {
    // PR1060-FU-01. The rooms match, so the room check passes; the Telegram external lane, started
    // after it, then refuses. A latch released at the room check let the held correction open its
    // room and move the row before that refusal.
    const early: { reattach?: Promise<Decision<unknown>>; buzzCallsAtOnce?: number } = {};
    const { config, pubkey, printed, buzzCalls } = deployment([DEFAULT_ROOM, ITS_ROOM], {
      canonical: true,
      telegramExternalBlocked: true,
      onReattachOpened: () => {
        early.reattach = reattachHolder();
        early.buzzCallsAtOnce = buzzCalls.length;
      },
    });
    let reachedShutdown = false;
    const started = main({
      config,
      waitForShutdown: async (shutdown) => {
        reachedShutdown = true;
        await shutdown("STARTUP_TEST");
      },
    });

    await expect(started).rejects.toThrow(`refusing to replace non-socket MCP path: ${join(dirname(config.databasePath), TELEGRAM_EXTERNAL_SOCKET_NAME)}`);
    expect(reachedShutdown).toBe(false);
    // The refusal came after the subscriber started and its rooms were checked.
    expect(printed()).toContain("Buzz mention subscriber configured identities: 1");
    expect(printed()).toContain("owner-reply consumer started");
    // Whatever a released correction would have done has had every turn it needs to do it.
    for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(early.buzzCallsAtOnce).toBe(0);
    await expect(early.reattach).resolves.toMatchObject({ allowed: true });
    expect(buzzCalls).toEqual([]);
    const after = new ControlPlane(config);
    try {
      expect(roomState(after, pubkey)).toEqual({
        sessions: 1,
        freshSessionRooms: [],
        claimAuditRows: 0,
        correctionAuditRows: 0,
        holderRoom: DEFAULT_ROOM,
      });
    } finally {
      after.close();
    }
  });

  it("claims and corrects as before once startup has finished with matching rooms", async () => {
    const { config, pubkey, buzzCalls } = deployment([DEFAULT_ROOM, ITS_ROOM], { canonical: true });
    let outcome: { claim: Decision<unknown>; reattach: Decision<unknown>; state: ReturnType<typeof roomState> } | null = null;
    await main({
      config,
      waitForShutdown: async (shutdown, context) => {
        try {
          const claim = await claimFresh();
          const reattach = await reattachHolder();
          await correctionLanded(context.cp);
          outcome = { claim, reattach, state: roomState(context.cp, pubkey) };
        } finally {
          await shutdown("STARTUP_TEST");
        }
      },
    });
    expect(outcome).toMatchObject({
      claim: { allowed: true, reasonCode: ReasonCode.OK },
      reattach: { allowed: true },
      state: { sessions: 2, freshSessionRooms: [ITS_ROOM], claimAuditRows: 1, correctionAuditRows: 1, holderRoom: ITS_ROOM },
    });
    expect(buzzCalls).toEqual([ITS_ROOM, ITS_ROOM]);
  });

  it.each([
    ["no buzz-nostr-subscriber.json is configured", { subscriber: "absent" } as const, "Buzz mention subscriber configured identities: 0"],
    ["no buzz owner identity is declared", { buzzOwner: false }, "Buzz message ingress not started"],
    ["the subscriber identity holds no live role", { subscriber: "unbound" } as const, "Buzz mention subscriber configured identities: 0"],
  ])("releases the claim and the correction when %s", async (_label, shape, line) => {
    // The subscriber identity listens in DEFAULT_ROOM alone, which would refuse ITS_ROOM if it ran.
    const { config, pubkey, printed, buzzCalls } = deployment([DEFAULT_ROOM], { canonical: true, ...shape });
    let outcome: { claim: Decision<unknown>; reattach: Decision<unknown>; state: ReturnType<typeof roomState> } | null = null;
    await main({
      config,
      waitForShutdown: async (shutdown, context) => {
        try {
          const claim = await claimFresh();
          const reattach = await reattachHolder();
          await correctionLanded(context.cp);
          outcome = { claim, reattach, state: roomState(context.cp, pubkey) };
        } finally {
          await shutdown("STARTUP_TEST");
        }
      },
    });
    expect(printed()).toContain(line);
    expect(relaySockets).toEqual([]);
    expect(outcome).toMatchObject({
      claim: { allowed: true, reasonCode: ReasonCode.OK },
      reattach: { allowed: true },
      state: { sessions: 2, freshSessionRooms: [ITS_ROOM], claimAuditRows: 1, correctionAuditRows: 1, holderRoom: ITS_ROOM },
    });
    expect(buzzCalls).toEqual([ITS_ROOM, ITS_ROOM]);
  });
});
