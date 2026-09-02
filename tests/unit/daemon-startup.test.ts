import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

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

interface MainResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
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
  };
  for (const name of TELEGRAM_VARIABLES) {
    if (!(name in (input.telegram ?? {}))) delete environment[name];
  }
  for (const name of BUZZ_VARIABLES) delete environment[name];
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
        resolveResult({ status, signal, stdout, stderr });
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
