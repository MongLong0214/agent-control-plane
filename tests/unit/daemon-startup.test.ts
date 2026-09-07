import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

import { main } from "../../src/daemon/agentcpd.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/u, "");
const mainRunner = join(repositoryRoot, "tests/helpers/run-agentcpd-main.ts");
const OWNER_ID = "424242";
const TELEGRAM_VARIABLES = [
  "ACP_TELEGRAM_BOT_TOKEN",
  "ACP_TELEGRAM_OWNER_ID",
  "ACP_TELEGRAM_ALLOWED_OWNER_IDS",
  "ACP_TELEGRAM_CHAT_ID",
  "ACP_TELEGRAM_ALLOWED_CHAT_IDS",
  "ACP_TELEGRAM_WEBHOOK_SECRET",
  "ACP_TELEGRAM_POLL_TIMEOUT_SECONDS",
  "ACP_TELEGRAM_RETRY_DELAY_MS",
  "ACP_TELEGRAM_DEFAULT_PROJECT_ID",
  "ACP_TELEGRAM_API_BASE_URL",
  "ACP_TELEGRAM_TRANSPORT_RETENTION_MS",
] as const;
/**
 * Deleted from the child's environment unless a case asks for them, for the same reason the
 * Telegram list is: a developer with these exported would otherwise start the Buzz listeners in
 * every scenario here, and the one case that is about them would stop being the one that
 * decides whether they run.
 */
const BUZZ_VARIABLES = ["ACP_BUZZ_INGRESS_SECRET", "ACP_BUZZ_ALLOWED_ACTORS", "BUZZ_PRIVATE_KEY"] as const;
const BUZZ_SECRET = "startup-test-buzz-secret";
const BUZZ_ACTOR = "npub-startup-owner";
/**
 * The exact eight-variable canonical self-claim activation group, separate from the pre-existing
 * shared `ACP_BUZZ_CHANNEL` transport setting this group also reads once fully configured.
 * Deleted from the child's environment unless a case asks for them, for the same reason
 * `TELEGRAM_VARIABLES` is: an inherited value from the parent process's own environment would
 * otherwise silently activate or partially activate the feature in every scenario here, and a
 * green "disabled" row would then be measuring the environment it happened to run in, not the
 * code.
 */
const CANONICAL_ACTIVATION_VARIABLES = [
  "ACP_CANONICAL_SESSION_UUID",
  "ACP_CANONICAL_REQUIRED_EXECUTOR_VERSION",
  "ACP_CANONICAL_EXPECTED_EXECUTOR_REALPATH",
  "ACP_CANONICAL_EXPECTED_EXECUTOR_SHA256",
  "ACP_CANONICAL_CTO_BUZZ_ACTOR_ID",
  "ACP_CANONICAL_CTO_WORKDIR",
  "ACP_CANONICAL_CTO_PEER_PROTOCOL",
  "ACP_CANONICAL_CTO_BUZZ_PURPOSE",
] as const;
const CANONICAL_ENVIRONMENT_VARIABLES = [
  ...CANONICAL_ACTIVATION_VARIABLES,
  "ACP_BUZZ_CHANNEL",
] as const;

/**
 * Every socket/lock filename the startup boundary this suite exercises could have opened, by the
 * time canonical self-claim activation is evaluated: the operator socket, the session-launch
 * channel, the single-instance lock, the canonical self-claim socket itself, and both Hermes/CTO
 * MCP listener sockets `startDaemonMcpListeners` binds. All live directly under `stateRoot`
 * (`join(root, ".agent-control-plane")`) — see `src/daemon/agentcpd.ts` and
 * `src/daemon/canonical-self-claim-listener.ts`'s `CANONICAL_SELF_CLAIM_SOCKET_FILENAME` for the
 * exact literals this list is copied from.
 *
 * A no-residue claim is worthless unless the filesystem is actually read for it (#760): asserting
 * only exit status and log text cannot distinguish a clean teardown from a leaked one, because
 * `runMain`'s own `finally` deletes `root` recursively before a caller can ever inspect it.
 * `runMain` takes this snapshot itself, synchronously, at the moment the child exits — before its
 * `finally` runs — so the observation is real and frozen into the returned result rather than
 * inferred from what the child chose to print.
 */
const RESIDUE_PATHS = [
  "agentcpd.operator.sock",
  "cto.launch.sock",
  "agentcpd.lock",
  "agentcpd.claim-canonical-cto.sock",
  "hermes.mcp.sock",
  "cto.mcp.sock",
] as const;

interface MainResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** `true` means that path still existed on disk at the moment the child process exited. */
  residue: Record<(typeof RESIDUE_PATHS)[number], boolean>;
}

const runMain = async (input: {
  telegram?: NodeJS.ProcessEnv;
  ownerIdentity?: boolean;
  seedState?: boolean;
  expectTelegram?: boolean;
  expectPromptFlow?: boolean;
  /** Uses the real `TelegramBotApi` composition instead of the runner's fake transport. */
  realTelegramTransport?: boolean;
  /** Configures the Buzz relay credential, which is what opens both Buzz ingress sockets. */
  buzz?: boolean;
  /** Declares the Buzz actor as an owner identity, which is what the message half also needs. */
  buzzOwnerIdentity?: boolean;
  /** Drives an owner Buzz message through the daemon's own socket (#627). */
  expectBuzzMessage?: boolean;
  /** Canonical self-claim activation-group overrides; see `CANONICAL_ACTIVATION_VARIABLES`. */
  canonical?: NodeJS.ProcessEnv;
}): Promise<MainResult> => {
  // macOS sockaddr_un paths are short; the repository's temp worktree path is long enough
  // to make the operator socket exceed that OS limit and would test the wrong failure.
  const root = mkdtempSync(join("/tmp", "acp-main-startup-"));
  const stateRoot = join(root, ".agent-control-plane");
  // The relay credential opens the sockets; this file says who the owner is. They are separate
  // inputs on purpose — `buzz: true, buzzOwnerIdentity: false` is the deployment where every
  // ACTIVE relay actor could speak as the owner, and it is a case below rather than a default.
  const declaredIdentities = [
    ...(input.ownerIdentity ? [`telegram:${OWNER_ID}`] : []),
    ...(input.buzzOwnerIdentity ? [`buzz:${BUZZ_ACTOR}`] : []),
  ];
  if (declaredIdentities.length > 0) {
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateRoot, "owner-identities"), `${declaredIdentities.join("\n")}\n`, {
      mode: 0o600,
    });
  }

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    USER: "startup-owner",
    ACP_MCP_TOKEN: "startup-mcp-token",
    ACP_OPERATOR_TOKEN: "startup-operator-token",
    ACP_OPERATOR_ACTOR: "startup-owner",
    ACP_STARTUP_TEST_ROOT: root,
    ...(input.seedState ? { ACP_STARTUP_TEST_SEED: "1" } : {}),
    ...(input.expectTelegram ? { ACP_STARTUP_TEST_EXPECT_TELEGRAM: "1" } : {}),
    ...(input.expectPromptFlow ? { ACP_STARTUP_TEST_EXPECT_PROMPT_FLOW: "1" } : {}),
    ...(input.realTelegramTransport ? { ACP_STARTUP_TEST_REAL_TELEGRAM_TRANSPORT: "1" } : {}),
    ...(input.expectBuzzMessage ? { ACP_STARTUP_TEST_EXPECT_BUZZ_MESSAGE: "1" } : {}),
    ...(input.telegram ?? {}),
    ...(input.canonical ?? {}),
  };
  for (const name of TELEGRAM_VARIABLES) {
    if (!(name in (input.telegram ?? {}))) delete environment[name];
  }
  for (const name of BUZZ_VARIABLES) delete environment[name];
  for (const name of CANONICAL_ENVIRONMENT_VARIABLES) {
    if (!(name in (input.canonical ?? {}))) delete environment[name];
  }
  if (input.buzz) {
    environment["ACP_BUZZ_INGRESS_SECRET"] = BUZZ_SECRET;
    environment["ACP_BUZZ_ALLOWED_ACTORS"] = BUZZ_ACTOR;
  }

  const child = spawn(process.execPath, ["--import", "tsx", mainRunner], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  try {
    return await new Promise<MainResult>((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        rejectResult(new Error(`agentcpd main startup test timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }, 30_000);
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.once("error", rejectResult);
      child.once("exit", (status, signal) => {
        clearTimeout(timer);
        // Read synchronously, right here, before this function returns: the outer `finally`
        // below deletes `root` recursively the moment this promise settles, so this is the one
        // and only point at which the real filesystem state is observable at all.
        const residue = Object.fromEntries(
          RESIDUE_PATHS.map((name) => [name, existsSync(join(stateRoot, name))]),
        ) as MainResult["residue"];
        resolveResult({ status, signal, stdout, stderr, residue });
      });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe("agentcpd main Telegram startup composition", () => {
  it("starts the daemon through main with no Telegram configuration and no ingress", async () => {
    const result = await runMain({ seedState: true });

    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stderr).toContain("Telegram ingress not configured");
    expect(result.stdout).not.toContain("Telegram ingress started");
  }, 40_000);

  it("refuses partial Telegram configuration through main and names every missing requirement", async () => {
    const result = await runMain({
      telegram: { ACP_TELEGRAM_BOT_TOKEN: "partial-token" },
    });

    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(1);
    expect(result.stderr).toContain('"reasonCode": "DAEMON_STARTUP_FAILED"');
    expect(result.stderr).toContain("ACP_TELEGRAM_OWNER_ID or ACP_TELEGRAM_ALLOWED_OWNER_IDS");
    expect(result.stderr).toContain("ACP_TELEGRAM_CHAT_ID or ACP_TELEGRAM_ALLOWED_CHAT_IDS");
    expect(result.stderr).toContain("ACP_TELEGRAM_WEBHOOK_SECRET");
  }, 40_000);

  it("starts the Telegram ingress through main with complete configuration", async () => {
    const result = await runMain({
      seedState: true,
      ownerIdentity: true,
      expectTelegram: true,
      telegram: {
        ACP_TELEGRAM_BOT_TOKEN: "startup-test-bot-token",
        ACP_TELEGRAM_OWNER_ID: OWNER_ID,
        ACP_TELEGRAM_CHAT_ID: "-100999",
        ACP_TELEGRAM_WEBHOOK_SECRET: "startup-test-webhook-secret",
        ACP_TELEGRAM_POLL_TIMEOUT_SECONDS: "1",
        ACP_TELEGRAM_RETRY_DELAY_MS: "100",
      },
    });

    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Telegram ingress started");
    expect(result.stdout).toContain("startup test Telegram poll observed");
    // Polling alone shows the loop turning. This is what shows an inbound update reaches the
    // router: without it the test passed even when route() never ran.
    expect(result.stdout).toContain("startup test Telegram inbound routed");
    // §6.1 DIRECT reaches the CEO conversation port rather than a formatted placeholder.
    expect(result.stdout).toContain("startup test DIRECT answered by the CEO route");
  }, 40_000);

  it("#682 round 8 follow-up: starts the daemon but refuses Telegram ingress when the transport's retention is unknown", async () => {
    // `ACP_TELEGRAM_API_BASE_URL` pointed at anything other than the official endpoint is a
    // supported, deliberately-configured deployment (a self-hosted Bot API server) whose
    // redelivery retention this repository has never measured — `TelegramBotApi` reports
    // `redeliveryRetentionMs: null` for it (see ingress-retention-derives-from-transport.test.ts),
    // and `IngressGuard` refuses to build a nonce floor it cannot bound. `realTelegramTransport`
    // is required here: without it the runner's fake transport (which declares a real 24h
    // retention) would stand in and this scenario could never be reached. No network call is
    // ever made — `IngressGuard`'s constructor throws before `service.start()` is reached.
    const result = await runMain({
      seedState: true,
      ownerIdentity: true,
      realTelegramTransport: true,
      telegram: {
        ACP_TELEGRAM_BOT_TOKEN: "startup-test-bot-token",
        ACP_TELEGRAM_OWNER_ID: OWNER_ID,
        ACP_TELEGRAM_CHAT_ID: "-100999",
        ACP_TELEGRAM_WEBHOOK_SECRET: "startup-test-webhook-secret",
        ACP_TELEGRAM_API_BASE_URL: "https://self-hosted-bot-api.internal.example",
      },
    });

    const diagnostics = `status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    // The daemon itself comes up — the whole point of this follow-up: an unmeasured Telegram
    // transport must not take MCP listeners, Buzz and the operator door down with it.
    expect(result.status, diagnostics).toBe(0);
    expect(result.stdout, diagnostics).not.toContain("Telegram ingress started");
    // Not "not configured" — the operator configured this deliberately, so the message has to
    // say *why* Telegram did not start rather than imply nothing was ever set up.
    expect(result.stderr, diagnostics).not.toContain("Telegram ingress not configured");
    expect(result.stderr, diagnostics).toContain("Telegram ingress refused");
    expect(result.stderr, diagnostics).toContain("redelivery retention is not known");
  }, 40_000);

  it("emits and resolves an owner prompt through main without a test-side send", async () => {
    const result = await runMain({
      ownerIdentity: true,
      seedState: true,
      expectPromptFlow: true,
      telegram: {
        ACP_TELEGRAM_BOT_TOKEN: "startup-test-bot-token",
        ACP_TELEGRAM_OWNER_ID: OWNER_ID,
        ACP_TELEGRAM_CHAT_ID: "-100999",
        ACP_TELEGRAM_WEBHOOK_SECRET: "startup-test-webhook-secret",
        ACP_TELEGRAM_POLL_TIMEOUT_SECONDS: "1",
        ACP_TELEGRAM_RETRY_DELAY_MS: "100",
      },
    });

    const diagnostics = `status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    expect(result.stdout, diagnostics).toContain("startup test owner prompt observed");
    expect(result.stdout, diagnostics).toContain("startup test owner approval cleared gate");
    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
  }, 40_000);
});

describe("canonical self-claim activation is an atomic pre-effect daemon contract", () => {
  // Synthetic throughout — never a value that names a real deployment's session, channel, path,
  // hash, or version.
  const COMPLETE_CANONICAL_ENV: NodeJS.ProcessEnv = {
    ACP_CANONICAL_SESSION_UUID: "99999999-9999-4999-8999-999999999999",
    ACP_CANONICAL_REQUIRED_EXECUTOR_VERSION: "0.0.0-startup-test",
    ACP_CANONICAL_EXPECTED_EXECUTOR_REALPATH: "/fake/versions/current/claude",
    ACP_CANONICAL_EXPECTED_EXECUTOR_SHA256: `sha256:${"0".repeat(64)}`,
    ACP_CANONICAL_CTO_BUZZ_ACTOR_ID: "buzz:startup-test-canonical-cto",
    ACP_CANONICAL_CTO_WORKDIR: "/synthetic/startup-test-canonical-workdir",
    ACP_CANONICAL_CTO_PEER_PROTOCOL: "acp.startup-test/v9",
    ACP_CANONICAL_CTO_BUZZ_PURPOSE: "continuity:STARTUP_TEST_CTO",
    ACP_BUZZ_CHANNEL: "channel:startup-test-canonical",
  };
  const COMPLETE_CANONICAL_GROUP = Object.fromEntries(
    CANONICAL_ACTIVATION_VARIABLES.map((name) => [name, COMPLETE_CANONICAL_ENV[name]!]),
  ) as Record<(typeof CANONICAL_ACTIVATION_VARIABLES)[number], string>;

  const withCanonicalProcessEnvironment = async (
    values: NodeJS.ProcessEnv,
    run: () => Promise<void>,
  ): Promise<void> => {
    const before = Object.fromEntries(
      CANONICAL_ENVIRONMENT_VARIABLES.map((name) => [name, process.env[name]]),
    ) as Record<(typeof CANONICAL_ENVIRONMENT_VARIABLES)[number], string | undefined>;
    try {
      for (const name of CANONICAL_ENVIRONMENT_VARIABLES) delete process.env[name];
      Object.assign(process.env, values);
      await run();
    } finally {
      for (const name of CANONICAL_ENVIRONMENT_VARIABLES) {
        const value = before[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };

  const poisonConfigOptions = (onRead: () => void): Parameters<typeof main>[0] =>
    Object.defineProperty({}, "config", {
      enumerable: true,
      get: () => {
        onRead();
        throw new Error("poison config getter was read");
      },
    }) as Parameters<typeof main>[0];

  it("starts the daemon with canonical self-claim disabled when all eight activation variables are absent", async () => {
    // This is the exact regression: a deployment carrying only the pre-existing MCP/operator
    // configuration (no canonical env vars at all) must reach a normal, running daemon — not
    // exit before `ControlPlane`, migration refusal, or the operator door can run.
    const result = await runMain({ seedState: true });

    const diagnostics = `status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    expect(result.status, diagnostics).toBe(0);
    expect(result.stdout, diagnostics).toContain("canonical self-claim disabled");
    expect(result.stdout, diagnostics).not.toContain("canonical self-claim listener started");
  }, 40_000);

  it("does not activate on ACP_BUZZ_CHANNEL alone — it is a pre-existing shared transport setting, not part of the activation group", async () => {
    const result = await runMain({
      seedState: true,
      canonical: { ACP_BUZZ_CHANNEL: "channel:startup-test-canonical" },
    });

    const diagnostics = `status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    expect(result.status, diagnostics).toBe(0);
    expect(result.stdout, diagnostics).toContain("canonical self-claim disabled");
    expect(result.stdout, diagnostics).not.toContain("canonical self-claim listener started");
  }, 40_000);

  /**
   * Direct filesystem assertions against `result.residue` (captured at child-exit time, before
   * `runMain`'s own cleanup — see `RESIDUE_PATHS`). Per-path, not a single blanket check: a
   * failure here names exactly which resource was left open, and a `toEqual` against an
   * all-false object would report the same generic diff no matter which one leaked.
   */
  const expectNoResidue = (result: MainResult, diagnostics: string): void => {
    for (const name of RESIDUE_PATHS) {
      expect(result.residue[name], `${name} was left on disk\n${diagnostics}`).toBe(false);
    }
  };

  it("rejects all 254 nonempty proper activation subsets before reading config", async () => {
    let rejectedSubsets = 0;
    for (let mask = 1; mask < (1 << CANONICAL_ACTIVATION_VARIABLES.length) - 1; mask += 1) {
      const subset: NodeJS.ProcessEnv = { ACP_BUZZ_CHANNEL: COMPLETE_CANONICAL_ENV["ACP_BUZZ_CHANNEL"] };
      for (const [index, name] of CANONICAL_ACTIVATION_VARIABLES.entries()) {
        if ((mask & (1 << index)) !== 0) subset[name] = COMPLETE_CANONICAL_GROUP[name];
      }
      let configReads = 0;
      await withCanonicalProcessEnvironment(subset, async () => {
        let rejection: unknown;
        try {
          await main(poisonConfigOptions(() => (configReads += 1)));
        } catch (error) {
          rejection = error;
        }
        const message = rejection instanceof Error ? rejection.message : String(rejection);
        const missing = CANONICAL_ACTIVATION_VARIABLES.filter((name) => !(name in subset));
        expect(message, `mask ${mask} did not fail as a partial activation group`).toBe(
          `canonical self-claim activation is partially configured; missing: ${missing.join(", ")}`,
        );
        for (const value of Object.values(subset)) {
          expect(message, `mask ${mask} disclosed an activation value`).not.toContain(value);
        }
      });
      expect(configReads, `mask ${mask} reached the config getter`).toBe(0);
      rejectedSubsets += 1;
    }
    expect(rejectedSubsets).toBe(254);
  });

  it("treats an entirely blank or whitespace-only activation group as disabled", async () => {
    for (const blank of ["", " \t "]) {
      let configReads = 0;
      await withCanonicalProcessEnvironment(
        Object.fromEntries(CANONICAL_ACTIVATION_VARIABLES.map((name) => [name, blank])),
        async () => {
          await expect(main(poisonConfigOptions(() => (configReads += 1)))).rejects.toThrow(
            "poison config getter was read",
          );
        },
      );
      expect(configReads).toBe(1);
    }
  });

  it("treats every blank or whitespace-only group member as partial before reading config", async () => {
    for (const name of CANONICAL_ACTIVATION_VARIABLES) {
      for (const blank of ["", " \t "]) {
        let configReads = 0;
        await withCanonicalProcessEnvironment(
          { ...COMPLETE_CANONICAL_ENV, [name]: blank },
          async () => {
            await expect(main(poisonConfigOptions(() => (configReads += 1)))).rejects.toThrow(
              "canonical self-claim activation is partially configured",
            );
          },
        );
        expect(configReads, `${name}=${JSON.stringify(blank)} reached the config getter`).toBe(0);
      }
    }
  });

  it("fails closed before config when all eight activation variables are set but ACP_BUZZ_CHANNEL is not", async () => {
    const { ACP_BUZZ_CHANNEL: _omit, ...withoutChannel } = COMPLETE_CANONICAL_ENV;
    for (const channel of [undefined, "", " \t "]) {
      let configReads = 0;
      await withCanonicalProcessEnvironment(
        { ...withoutChannel, ...(channel === undefined ? {} : { ACP_BUZZ_CHANNEL: channel }) },
        async () => {
          await expect(main(poisonConfigOptions(() => (configReads += 1)))).rejects.toThrow(
            "ACP_BUZZ_CHANNEL is required",
          );
        },
      );
      expect(configReads).toBe(0);
    }
  });

  it("refuses partial or channel-missing activation with no child-exit residue", async () => {
    const { ACP_BUZZ_CHANNEL: _omit, ...withoutChannel } = COMPLETE_CANONICAL_ENV;
    for (const canonical of [
      { ACP_CANONICAL_SESSION_UUID: COMPLETE_CANONICAL_GROUP.ACP_CANONICAL_SESSION_UUID },
      withoutChannel,
    ]) {
      const result = await runMain({ seedState: true, canonical });
      const diagnostics = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
      expect(result.status, diagnostics).toBe(1);
      expect(result.stderr, diagnostics).toContain(
        canonical === withoutChannel ? "ACP_BUZZ_CHANNEL is required" : "canonical self-claim activation is partially configured",
      );
      expect(result.stdout, diagnostics).not.toContain("canonical self-claim listener started");
      expectNoResidue(result, diagnostics);
    }
  }, 40_000);

  it("keeps full canonical activation alive with no subscriber config and zero subscriber sockets", async () => {
    const result = await runMain({
      seedState: true,
      buzz: true,
      buzzOwnerIdentity: true,
      canonical: COMPLETE_CANONICAL_ENV,
    });
    const diagnostics = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    expect(result.status, diagnostics).toBe(0);
    expect(result.stdout, diagnostics).toContain("canonical self-claim listener started");
    expect(result.stdout, diagnostics).toContain("Buzz mention subscriber sockets: 0");
    expect(result.stdout, diagnostics).not.toContain("Buzz mention subscriber sockets: 1");
    expectNoResidue(result, diagnostics);
  }, 40_000);

  it("starts the canonical self-claim listener when the full synthetic eight-variable group is configured", async () => {
    const result = await runMain({ seedState: true, canonical: COMPLETE_CANONICAL_ENV });

    const diagnostics =
      `status=${result.status}\nresidue=${JSON.stringify(result.residue)}\n` +
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    expect(result.status, diagnostics).toBe(0);
    expect(result.stdout, diagnostics).toContain("canonical self-claim listener started");
    expect(result.stdout, diagnostics).not.toContain("canonical self-claim disabled");
    expectNoResidue(result, diagnostics);
  }, 40_000);
});

describe("#627: an owner's Buzz message reaches the CEO without a session child", () => {
  it("answers a Buzz message on the daemon's own socket and spawns nothing to do it", async () => {
    // The deployed path answers a Buzz message by running `hermes acp` as a session child —
    // a new actor, a new session, an owner conversation split across dozens of them. This
    // scenario is the receiving half in the shape `ARCHITECTURE.md` accepts: the daemon hands
    // the message to a peer that is already connected and already holds the CEO binding.
    const result = await runMain({
      seedState: true,
      buzz: true,
      buzzOwnerIdentity: true,
      expectBuzzMessage: true,
    });

    const diagnostics = `status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    expect(result.stdout, diagnostics).toContain("Buzz message ingress started");
    expect(result.stdout, diagnostics).toContain("startup test Buzz message answered by the CEO route");
    // The no-fork property, measured rather than assumed: the runner reads the OS's own child
    // list and the session registry on both sides of the turn.
    expect(result.stdout, diagnostics).toContain("startup test Buzz message spawned no session child");
    expect(result.status, diagnostics).toBe(0);
  }, 60_000);

  it("opens no Buzz ingress socket at all when the relay credential is not configured", async () => {
    const result = await runMain({ seedState: true });

    const diagnostics = `status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    expect(result.status, diagnostics).toBe(0);
    expect(result.stdout, diagnostics).not.toContain("Buzz message ingress started");
  }, 40_000);

  it("keeps first boot alive with no subscriber config and reports zero subscriber sockets", async () => {
    // `runMain` gives every case a new state root. Declaring the Buzz owner opens the local ingress
    // composition, but nothing writes `buzz-nostr-subscriber.json`, so this reaches the real
    // config-absent subscriber boundary on first boot rather than a direct helper fixture.
    const result = await runMain({ seedState: true, buzz: true, buzzOwnerIdentity: true });

    const diagnostics = `status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    expect(result.status, diagnostics).toBe(0);
    expect(result.stdout, diagnostics).toContain("Buzz mention subscriber sockets: 0");
    expect(result.stdout, diagnostics).not.toContain("Buzz mention subscriber sockets: 1");
  }, 40_000);

  it("leaves the message socket closed when the relay credential names no declared owner", async () => {
    // The composition half of the same separation. The relay credential is configured, so the
    // binding socket opens exactly as before; what is missing is a `buzz:` line in
    // `owner-identities`. Reusing the relay allowlist here would make every ACTIVE Buzz actor
    // the owner, so the message half stays closed and says which file would open it.
    const result = await runMain({ seedState: true, buzz: true });

    const diagnostics = `status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    expect(result.status, diagnostics).toBe(0);
    expect(result.stdout, diagnostics).not.toContain("Buzz message ingress started");
    expect(result.stdout, diagnostics).toContain("Buzz message ingress not started");
    expect(result.stdout, diagnostics).toContain("owner-identities");
  }, 40_000);
});

describe("#568: a parked daemon still answers a supervisor's stop", () => {
  it("releases the single-instance lock on SIGTERM while parked", async () => {
    // `install-launchd.sh upgrade` and `rollback` both wait for `agentcpd.lock` to disappear
    // before they will touch the database, and only `Daemon.stop()` removes it. Before the
    // signal handlers were installed ahead of `start()`, a parked daemon — which never returns
    // from `start()` — met a default kill and left that file behind, failing every deploy on
    // the host this park was written for.
    const root = mkdtempSync(join("/tmp", "acp-park-sigterm-"));
    const stateRoot = join(root, ".agent-control-plane");
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USER: "park-owner",
      ACP_MCP_TOKEN: "park-mcp-token",
      ACP_OPERATOR_TOKEN: "park-operator-token",
      ACP_OPERATOR_ACTOR: "park-owner",
      ACP_STARTUP_TEST_ROOT: root,
      ACP_STARTUP_TEST_SEED: "1",
      ACP_STARTUP_TEST_PARK: "1",
    };
    // An inherited partial Telegram config takes the exit-1 path, and this test would then
    // time out waiting for a door that is never bound — for a reason unrelated to what it asks.
    for (const name of TELEGRAM_VARIABLES) delete environment[name];

    const child = spawn(process.execPath, ["--import", "tsx", mainRunner], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

    try {
      const doorPath = join(stateRoot, "agentcpd.operator.sock");
      const lockPath = join(stateRoot, "agentcpd.lock");
      const healthPath = join(stateRoot, "health.json");
      // The socket alone does not prove a park: a started daemon binds the same path. The
      // parked mode does, and it is the state the rest of this test is about.
      await vi.waitFor(
        () => {
          expect(existsSync(doorPath)).toBe(true);
          expect(JSON.parse(readFileSync(healthPath, "utf8")) as { mode?: string }).toMatchObject({
            mode: "BOOTSTRAP",
          });
        },
        { timeout: 60_000, interval: 100 },
      );
      expect(existsSync(lockPath)).toBe(true);

      child.kill("SIGTERM");
      const code = await exited;

      // What the deploy script waits for — and proof the handler is what released it, rather
      // than a crash or an ordinary exit that would satisfy the file check by accident.
      expect(existsSync(lockPath)).toBe(false);
      expect(stdout).toContain("shutting down on SIGTERM");
      expect(code).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
