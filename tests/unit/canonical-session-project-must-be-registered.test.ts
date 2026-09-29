import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Server } from "node:net";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { ControlPlane, defaultConfig } from "../../src/app/control-plane.ts";
import { systemClock } from "../../src/core/clock.ts";
import { main } from "../../src/daemon/agentcpd.ts";
import { ScriptedAdapter } from "../../src/runtime/scripted-adapter.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

class StartupAdapter extends ScriptedAdapter {
  override readonly isProduction = true;
}

/**
 * One configured entry. Synthetic throughout — no value here names a real deployment's session,
 * project or actor.
 */
interface CanonicalEntry {
  readonly sessionUuid: string;
  readonly projectId: string;
  readonly buzzActorId: string;
}

const FIRST: CanonicalEntry = {
  sessionUuid: "99999999-9999-4999-8999-999999999999",
  projectId: "registry-test-project-first",
  buzzActorId: "buzz:registry-test-first",
};
const SECOND: CanonicalEntry = {
  sessionUuid: "88888888-8888-4888-8888-888888888888",
  projectId: "registry-test-project-second",
  buzzActorId: "buzz:registry-test-second",
};

const CLAIM_SOCKET_FILENAME = "agentcpd.claim-canonical-cto.sock";

interface StartupOutcome {
  /** The error `main` threw, or null when startup completed and shut down cleanly. */
  readonly startupError: Error | null;
  /** Whether the canonical self-claim door was open when the daemon reached shutdown. */
  readonly claimDoorOpenAtShutdown: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Starts the daemon the way the deployed daemon starts: `main()` with a real `ControlPlane` config
 * and the activation group in the process environment, so the configured value is read by the same
 * startup block production reads it in rather than by a helper this test calls itself.
 *
 * Only `listen`/`close` are substituted, for the reason `daemon-subscriber-unbound.test.ts`
 * substitutes them: the sandbox denies Unix socket binds. Every decision under test — config,
 * database open, the registry lookup, the listener's own start — runs unchanged.
 */
const startDaemon = async (input: {
  readonly entries: readonly CanonicalEntry[];
  readonly registeredProjects: readonly string[];
}): Promise<StartupOutcome> => {
  // Short prefix deliberately: the claim socket lives directly under this root, and macOS refuses
  // an AF_UNIX path over 103 bytes. `acp-canonical-project-` put the socket at 111 and the daemon
  // refused it — which would have made the positive case below unreachable and left the two
  // refusals unfalsifiable, since a startup that cannot come up at all also never opens the door.
  const root = tempDir("acp-canon-");

  // The startup doctor reads these local files and makes no GitHub request. Without them
  // TRUSTED_GATE_CREDENTIAL_MISSING is blocking and startup never reaches the activation block,
  // which would make every case here green for the wrong reason.
  const credentials = join(root, "credentials");
  mkdirSync(credentials, { mode: 0o700 });
  const privateKeyPath = join(credentials, "github-app.private-key.pem");
  writeFileSync(
    privateKeyPath,
    generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(credentials, "github-app.env"),
    [
      "GITHUB_APP_ID=4586878",
      "GITHUB_APP_INSTALLATION_ID=153553922",
      `GITHUB_APP_PRIVATE_KEY_PATH=${privateKeyPath}`,
    ].join("\n"),
    { mode: 0o600 },
  );

  const config = {
    ...defaultConfig(root),
    adapters: [new StartupAdapter(systemClock, "claude"), new StartupAdapter(systemClock, "gpt")],
    ctoPreference: { provider: "claude", model: "scripted-cto", effort: null },
  };

  // The deployment's registry state, established through `projects.register` — the call an
  // operator's registration goes through — on a control plane closed before `main` opens its own.
  const seed = new ControlPlane(config);
  try {
    for (const projectId of input.registeredProjects) {
      const registered = seed.projects.register({ name: `registry test ${projectId}`, projectId });
      if (!registered.allowed) throw new Error(`${projectId}: ${registered.reasonCode}: ${registered.message}`);
    }
  } finally {
    seed.close();
  }

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
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((text) => {
    stdout.push(String(text));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((text) => {
    stderr.push(String(text));
    return true;
  });
  const signals = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ACP_TELEGRAM_") || key.startsWith("ACP_CANONICAL_") || key.startsWith("ACP_BUZZ_")) {
      vi.stubEnv(key, undefined);
    }
    if (key === "BUZZ_PRIVATE_KEY") vi.stubEnv(key, undefined);
  }
  for (const [key, value] of Object.entries({
    ACP_MCP_TOKEN: "registry-test-mcp-token",
    ACP_OPERATOR_TOKEN: "registry-test-operator-token",
    ACP_OPERATOR_ACTOR: "registry-test-owner",
    ACP_BUZZ_CHANNEL: "channel:registry-test-canonical",
    ACP_CANONICAL_SESSIONS_JSON: JSON.stringify(input.entries),
    ACP_CANONICAL_CTO_PEER_PROTOCOL: "acp.registry-test/v9",
    ACP_CANONICAL_CTO_BUZZ_PURPOSE: "continuity:REGISTRY_TEST_CTO",
  })) vi.stubEnv(key, value);

  let claimDoorOpenAtShutdown = false;
  let startupError: Error | null = null;
  try {
    await main({
      config,
      waitForShutdown: async (shutdown) => {
        try {
          claimDoorOpenAtShutdown = [...listening.values()].includes(join(root, CLAIM_SOCKET_FILENAME));
        } finally {
          await shutdown("CANONICAL_PROJECT_REGISTRY_TEST");
        }
      },
    });
  } catch (error) {
    startupError = error instanceof Error ? error : new Error(String(error));
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      for (const listener of process.listeners(signal)) {
        if (!signals[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
  return { startupError, claimDoorOpenAtShutdown, stdout: stdout.join(""), stderr: stderr.join("") };
};

/** Every configured value of every entry, which the refusal must not carry. */
const configuredValues = (entries: readonly CanonicalEntry[]): string[] =>
  entries.flatMap((entry) => [entry.sessionUuid, entry.projectId, entry.buzzActorId]);

describe("a configured canonical session's project must be registered before the claim door opens", () => {
  it("refuses startup when the only configured entry names a project the registry does not hold", async () => {
    const outcome = await startDaemon({ entries: [FIRST], registeredProjects: [] });

    const diagnostics = `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`;
    expect(outcome.startupError?.message, diagnostics).toBe(
      "ACP_CANONICAL_SESSIONS_JSON is invalid: entry 0 of 1 names a project that is not registered",
    );
    // The whole message, not merely the presence of the variable name: the point of this path's
    // refusal shape is that an operator learns which entry to fix without the daemon printing any
    // part of what they configured.
    for (const value of configuredValues([FIRST])) {
      expect(outcome.startupError?.message, `the refusal disclosed a configured value\n${diagnostics}`)
        .not.toContain(value);
    }
    expect(outcome.stdout, diagnostics).not.toContain("canonical self-claim listener started");
    expect(outcome.claimDoorOpenAtShutdown, diagnostics).toBe(false);
  }, 40_000);

  it("starts the daemon and opens the claim door when every configured entry names a registered project", async () => {
    const outcome = await startDaemon({
      entries: [FIRST, SECOND],
      registeredProjects: [FIRST.projectId, SECOND.projectId],
    });

    const diagnostics = `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`;
    expect(outcome.startupError, diagnostics).toBeNull();
    expect(outcome.stdout, diagnostics).toContain("canonical self-claim listener started");
    // Without this the refusals above would also pass against a daemon that never comes up at all.
    expect(outcome.claimDoorOpenAtShutdown, diagnostics).toBe(true);
  }, 40_000);

  it("refuses a set whose second entry alone is unregistered, and reports that entry's index", async () => {
    const outcome = await startDaemon({
      entries: [FIRST, SECOND],
      registeredProjects: [FIRST.projectId],
    });

    const diagnostics = `stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`;
    // The index is the entry's own position, not the first position: a refusal that always said
    // `entry 0` would send an operator to the entry that is correct.
    expect(outcome.startupError?.message, diagnostics).toBe(
      "ACP_CANONICAL_SESSIONS_JSON is invalid: entry 1 of 2 names a project that is not registered",
    );
    for (const value of configuredValues([FIRST, SECOND])) {
      expect(outcome.startupError?.message, `the refusal disclosed a configured value\n${diagnostics}`)
        .not.toContain(value);
    }
    expect(outcome.stdout, diagnostics).not.toContain("canonical self-claim listener started");
    expect(outcome.claimDoorOpenAtShutdown, diagnostics).toBe(false);
  }, 40_000);
});
