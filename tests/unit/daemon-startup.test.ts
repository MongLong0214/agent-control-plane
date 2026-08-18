import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
] as const;

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
}): Promise<MainResult> => {
  // macOS sockaddr_un paths are short; the repository's temp worktree path is long enough
  // to make the operator socket exceed that OS limit and would test the wrong failure.
  const root = mkdtempSync(join("/tmp", "acp-main-startup-"));
  const stateRoot = join(root, ".agent-control-plane");
  if (input.ownerIdentity) {
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateRoot, "owner-identities"), `telegram:${OWNER_ID}\n`, { mode: 0o600 });
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
    ...(input.telegram ?? {}),
  };
  for (const name of TELEGRAM_VARIABLES) {
    if (!(name in (input.telegram ?? {}))) delete environment[name];
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

describe("#568: a parked daemon still answers a supervisor's stop", () => {
  it("releases the single-instance lock on SIGTERM while parked", async () => {
    // `install-launchd.sh upgrade` and `rollback` both wait for `agentcpd.lock` to disappear
    // before they will touch the database, and only `Daemon.stop()` removes it. Before the
    // signal handlers were installed ahead of `start()`, a parked daemon — which never returns
    // from `start()` — met a default kill and left that file behind, failing every deploy on
    // the host this park was written for.
    const root = mkdtempSync(join("/tmp", "acp-park-sigterm-"));
    const stateRoot = join(root, ".agent-control-plane");
    const child = spawn(process.execPath, ["--import", "tsx", mainRunner], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HOME: root,
        USER: "park-owner",
        ACP_MCP_TOKEN: "park-mcp-token",
        ACP_OPERATOR_TOKEN: "park-operator-token",
        ACP_OPERATOR_ACTOR: "park-owner",
        ACP_STARTUP_TEST_ROOT: root,
        ACP_STARTUP_TEST_SEED: "1",
        ACP_STARTUP_TEST_PARK: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

    try {
      // The door binding is the observable proof the daemon parked rather than exited.
      const doorPath = join(stateRoot, "agentcpd.operator.sock");
      const lockPath = join(stateRoot, "agentcpd.lock");
      await vi.waitFor(() => expect(existsSync(doorPath)).toBe(true), { timeout: 60_000, interval: 100 });
      expect(existsSync(lockPath)).toBe(true);

      child.kill("SIGTERM");
      await exited;

      // What the deploy script actually waits for.
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
