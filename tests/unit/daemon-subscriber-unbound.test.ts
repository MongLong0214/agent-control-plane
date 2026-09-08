import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Server } from "node:net";
import { join } from "node:path";

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterAll, expect, it, vi } from "vitest";

import { ControlPlane, defaultConfig } from "../../src/app/control-plane.ts";
import { BUZZ_SUBSCRIBER_CONFIG_FILENAME } from "../../src/buzz/buzz-mention-subscriber.ts";
import { systemClock } from "../../src/core/clock.ts";
import { main } from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { ScriptedAdapter } from "../../src/runtime/scripted-adapter.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

class StartupAdapter extends ScriptedAdapter {
  override readonly isProduction = true;
}

it("completes daemon startup with a revoked PRIMARY_CTO binding and keeps the claim door open", async () => {
  const root = tempDir("acp-sub-");
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  const keyFile = join(root, "subscriber.key");
  writeFileSync(keyFile, Buffer.from(secretKey).toString("hex"), { mode: 0o600 });
  writeFileSync(join(root, BUZZ_SUBSCRIBER_CONFIG_FILENAME), JSON.stringify({
    relayUrl: "wss://relay.example.invalid/buzz",
    identities: [{ privateKeyFile: keyFile, encoding: "hex", rooms: ["startup-room"] }],
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
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: "startup-project" });
  const seed = new ControlPlane(config);
  try {
    seed.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [
      "startup-project", "startup revoked binding", systemClock.nowIso(),
    ]);
    const session = seed.sessions.create({ provider: "claude", model: "startup-cto" });
    expect(seed.sessions.transition(session.sessionId, SessionLifecycle.READY, "startup test").allowed).toBe(true);
    expect(seed.sessions.bindBuzzActor({
      sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: pubkey,
    }, { isAllowedActor: () => true }).allowed).toBe(true);
    expect(seed.bindings.bind({
      role: Role.PRIMARY_CTO, sessionId: session.sessionId, projectId: "startup-project",
    }).allowed).toBe(true);
    expect(seed.bindings.revoke(roleKey, "dead canonical binding recovery: startup fixture").allowed).toBe(true);
  } finally {
    seed.close();
  }

  // Only listening is substituted: the sandbox denies Unix socket binds. The real main(),
  // daemon, doctor, persisted assignments and subscriber preflight all run unchanged.
  const listening = new Map<Server, string>();
  vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, ...args: unknown[]) {
    const path = args[0] as string;
    writeFileSync(path, "");
    listening.set(this, path);
    (args[1] as () => void)();
    return this;
  });
  vi.spyOn(Server.prototype, "close").mockImplementation(function (this: Server, callback) {
    listening.delete(this);
    callback?.();
    return this;
  });
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const signals = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
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
    ACP_BUZZ_CHANNEL: "startup-room",
    ACP_CANONICAL_SESSION_UUID: "99999999-9999-4999-8999-999999999999",
    ACP_CANONICAL_REQUIRED_EXECUTOR_VERSION: "0.0.0-startup-test",
    ACP_CANONICAL_EXPECTED_EXECUTOR_REALPATH: join(root, "executor"),
    ACP_CANONICAL_EXPECTED_EXECUTOR_SHA256: `sha256:${"0".repeat(64)}`,
    ACP_CANONICAL_CTO_BUZZ_ACTOR_ID: pubkey,
    ACP_CANONICAL_CTO_WORKDIR: root,
    ACP_CANONICAL_CTO_PEER_PROTOCOL: "acp.startup-test/v9",
    ACP_CANONICAL_CTO_BUZZ_PURPOSE: "continuity:STARTUP_TEST_CTO",
  })) vi.stubEnv(key, value);

  let reachedShutdown = false;
  try {
    await main({
      config,
      waitForShutdown: async (shutdown, { cp, daemon }) => {
        try {
          expect(daemon.lock.held()).toBe(true);
          expect([...listening.values()]).toContain(join(root, "agentcpd.claim-canonical-cto.sock"));
          expect(cp.bindings.active(roleKey)).toBeNull();
          expect(cp.db.get(`SELECT status FROM assignments WHERE role_key = ?`, [roleKey]))
            .toEqual({ status: "REVOKED" });
          reachedShutdown = true;
        } finally {
          await shutdown("STARTUP_TEST");
        }
      },
    });
    expect(reachedShutdown).toBe(true);
    expect(exit).toHaveBeenCalledWith(0);
    expect(stderr.mock.calls.map(([text]) => String(text)).join(""))
      .toContain("does not currently hold a live PRIMARY_CTO binding; continuing without Buzz mention subscriber");
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      for (const listener of process.listeners(signal)) {
        if (!signals[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});
