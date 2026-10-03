import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Server } from "node:net";
import { join } from "node:path";

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterAll, afterEach, expect, it, vi } from "vitest";

import { ControlPlane, defaultConfig } from "../../src/app/control-plane.ts";
import { BUZZ_SUBSCRIBER_CONFIG_FILENAME } from "../../src/buzz/buzz-mention-subscriber.ts";
import { systemClock } from "../../src/core/clock.ts";
import { main } from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
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

class StartupAdapter extends ScriptedAdapter {
  override readonly isProduction = true;
}

const DEFAULT_ROOM = "c37e88d0-0000-4000-8000-000000000001";
const ITS_ROOM = "6dcb2a67-0000-4000-8000-000000000002";
const PROJECT = "room-project";

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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A deployment whose canonical CTO holds its role live, with its subscriber listening in `rooms`. */
const deployment = (rooms: readonly string[]) => {
  const root = tempDir("acp-room-sub-");
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  const keyFile = join(root, "subscriber.key");
  writeFileSync(keyFile, Buffer.from(secretKey).toString("hex"), { mode: 0o600 });
  writeFileSync(join(root, BUZZ_SUBSCRIBER_CONFIG_FILENAME), JSON.stringify({
    relayUrl: "wss://relay.example.invalid/buzz",
    identities: [{ privateKeyFile: keyFile, encoding: "hex", rooms }],
  }));

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
    ownerIdentities: [{ channel: "buzz" as const, actor: "startup-owner" }],
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
    const session = seed.sessions.create({ provider: "claude", model: "startup-cto", buzzAddress: DEFAULT_ROOM });
    expect(seed.sessions.transition(session.sessionId, SessionLifecycle.READY, "startup test").allowed).toBe(true);
    expect(seed.sessions.bindBuzzActor({
      sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: pubkey,
    }, { isAllowedActor: () => true }).allowed).toBe(true);
    expect(seed.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: session.sessionId, projectId: PROJECT }).allowed)
      .toBe(true);
  } finally {
    seed.close();
  }

  // Only listening and the relay connection are substituted: the sandbox denies Unix socket binds,
  // and no test reaches a relay. The real main(), daemon, doctor and subscriber preflight all run.
  vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, ...args: unknown[]) {
    writeFileSync(args[0] as string, "");
    (args[1] as () => void)();
    return this;
  });
  vi.spyOn(Server.prototype, "close").mockImplementation(function (this: Server, callback) {
    callback?.();
    return this;
  });
  vi.stubGlobal("WebSocket", InertWebSocket);
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ACP_TELEGRAM_") || key.startsWith("ACP_CANONICAL_") || key === "BUZZ_PRIVATE_KEY") {
      vi.stubEnv(key, undefined);
    }
  }
  for (const [key, value] of Object.entries({
    ACP_MCP_TOKEN: "startup-mcp-token",
    ACP_OPERATOR_TOKEN: "startup-operator-token",
    ACP_OPERATOR_ACTOR: "startup-owner",
    ACP_BUZZ_INGRESS_SECRET: "startup-buzz-secret",
    ACP_BUZZ_ALLOWED_ACTORS: "startup-owner",
    ACP_BUZZ_CHANNEL: DEFAULT_ROOM,
    ACP_CANONICAL_SESSIONS_JSON: JSON.stringify([{
      sessionUuid: "99999999-9999-4999-8999-999999999999",
      projectId: PROJECT,
      buzzActorId: pubkey,
      buzzAddress: ITS_ROOM,
    }]),
    ACP_CANONICAL_CTO_PEER_PROTOCOL: "acp.startup-test/v9",
    ACP_CANONICAL_CTO_BUZZ_PURPOSE: "continuity:STARTUP_TEST_CTO",
  })) vi.stubEnv(key, value);
  const printed = (): string => stdout.mock.calls.map(([text]) => String(text)).join("");
  return { config, pubkey, printed };
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
