import { execFile, spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const TSX_ENTRY = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const DAEMON_ENTRY = join(process.cwd(), "src", "daemon", "agentcpd.ts");
const CLI_ENTRY = join(process.cwd(), "src", "cli", "agentctl.ts");

/**
 * The runtime this test spawns is a real file, not a literal here: whoever writes the Hermes
 * client needs to read it, and nobody looks for a wire protocol inside a process test. Spawning
 * the same file the reference documents is what stops the two from drifting.
 */
const HERMES_RUNTIME = join(process.cwd(), "docs", "reference", "hermes-ceo-runtime.cjs");

interface ManagedDaemon {
  child: ChildProcess;
  stdout: string;
  stderr: string;
}

const daemonOutput = (managed: ManagedDaemon): string => `${managed.stdout}\n${managed.stderr}`;

const logFilesUnder = (root: string): string[] => {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (
        entry.isFile() &&
        (/\.log(?:\.\d+)?$/i.test(entry.name) || /(?:^|[._-])logs?(?:[._-]|$)/i.test(entry.name))
      ) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files;
};

const launchDaemon = (env: NodeJS.ProcessEnv): ManagedDaemon => {
  const child = spawn(process.execPath, [TSX_ENTRY, DAEMON_ENTRY], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const managed: ManagedDaemon = { child, stdout: "", stderr: "" };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { managed.stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { managed.stderr += chunk; });
  return managed;
};

const waitUntil = async (
  predicate: () => boolean,
  description: string,
  timeoutMs = 60_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
};

const waitForDaemonStart = async (managed: ManagedDaemon, name: string): Promise<void> => {
  const deadline = Date.now() + 60_000;
  while (!managed.stdout.includes('"started"')) {
    if (managed.child.exitCode !== null) {
      throw new Error(`${name} exited with ${managed.child.exitCode}; stdout=${managed.stdout}; stderr=${managed.stderr}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`${name} did not report startup; stdout=${managed.stdout}; stderr=${managed.stderr}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
};

const stopDaemon = async (managed: ManagedDaemon | null): Promise<void> => {
  if (!managed || managed.child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => managed.child.once("exit", () => resolve()));
  managed.child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
  ]);
  if (managed.child.exitCode === null) {
    managed.child.kill("SIGKILL");
    await exited;
  }
};

const runAgentctl = async (
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> => {
  try {
    const result = await execFileAsync(process.execPath, [TSX_ENTRY, CLI_ENTRY, ...args], {
      cwd: process.cwd(),
      env,
      maxBuffer: 2_000_000,
      timeout: 60_000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? String(error),
    };
  }
};

describe("the reference CEO runtime", () => {
  it("declares sampling in its initialize request, on the MCP connection itself", () => {
    // A text check, and it says so. The behavioural path needs Telegram ingress configured, so
    // nothing here can drive an owner message through `Server.createMessage` — but a client
    // copied from a reference that omitted the capability looks correct while every ordinary
    // owner message is refused with CEO_CONVERSATION_UNSUPPORTED. This is a guard against the
    // declaration being dropped, not a proof that conversation works.
    const reference = readFileSync(HERMES_RUNTIME, "utf8");

    expect(reference).toContain("capabilities: { sampling: {} }");
    // And it answers what it declared. Declaring without answering is worse than not
    // declaring: the daemon holds the owner's turn until the budget expires.
    expect(reference).toContain('method === "sampling/createMessage"');
  });
});

describe("fresh-install Hermes bootstrap process acceptance", () => {
  it("bootstraps through agentctl, restarts agentcpd, and authenticates Hermes MCP tool calls", async () => {
    // Keep the Unix socket pathname below macOS's AF_UNIX limit. /tmp is an approved
    // system alias for the private temp root used by state-preflight.
    const root = mkdtempSync("/tmp/acp-hermes-process-");
    const home = join(root, "home");
    const fakeBin = join(root, "bin");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(fakeBin, { recursive: true, mode: 0o700 });
    const providerOutput: Record<string, string> = {
      claude: "5-hour limit: 80% remaining\\n",
      codex: "press enter to confirm\\n5-hour limit: 80% remaining\\n",
      grok: "5-hour limit: 80% remaining\\n",
    };
    for (const binary of ["claude", "codex", "grok"]) {
      const path = join(fakeBin, binary);
      writeFileSync(path, `#!/bin/sh\nprintf '%b' '${providerOutput[binary]}'\nexit 0\n`, { mode: 0o700 });
      chmodSync(path, 0o700);
    }
    // Claude and Codex no longer read quota from a terminal, so a stub that only prints a line
    // is not a stub of what they do. Claude is asked for a JSON envelope; Codex is asked over
    // the app-server's JSON-RPC. A stub that cannot answer leaves coverage as the only blocking
    // finding, which is precisely the state the bootstrap park exists for — so the daemon parks
    // and waits for an operator, and the test reads that silence as a daemon that never started.
    writeFileSync(
      join(fakeBin, "claude"),
      `#!/bin/sh\nprintf '%s' '{"is_error":false,"result":"Current session: 20% used"}'\nexit 0\n`,
      { mode: 0o700 },
    );
    chmodSync(join(fakeBin, "claude"), 0o700);
    writeFileSync(
      join(fakeBin, "codex"),
      [
        "#!/bin/sh",
        `printf '%s\\n' '{"id":0,"result":{}}'`,
        "while IFS= read -r _line; do",
        `  printf '%s\\n' '{"id":1,"result":{"rateLimits":{"primary":{"usedPercent":20,"windowDurationMins":10080,"resetsAt":1787196559}}}}'`,
        "done",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    chmodSync(join(fakeBin, "codex"), 0o700);

    const stateDir = join(home, ".agent-control-plane");
    // A real daemon preflight also requires the independently provisioned GitHub App
    // credential before startup. This is deployment configuration, not CP state or a
    // fixture/database shortcut; the Hermes CEO state below is still genuinely empty.
    const secretsDir = join(stateDir, "secrets");
    const credentialsDir = join(stateDir, "credentials");
    const appEnvFile = join(credentialsDir, "github-app.env");
    const appPrivateKey = join(credentialsDir, "github-app.private-key.pem");
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
    const appKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" });
    writeFileSync(appPrivateKey, appKey, { mode: 0o600 });
    writeFileSync(appEnvFile, [
      "GITHUB_APP_ID=4586878",
      "GITHUB_APP_INSTALLATION_ID=153553922",
      `GITHUB_APP_PRIVATE_KEY_PATH=${appPrivateKey}`,
    ].join("\n"), { mode: 0o600 });
    chmodSync(secretsDir, 0o700);
    chmodSync(credentialsDir, 0o700);
    chmodSync(appEnvFile, 0o600);
    chmodSync(appPrivateKey, 0o600);
    const pidPath = join(root, "hermes-runtime.pid");
    const continuePath = join(root, "continue-mcp");
    const secretPath = join(root, "runtime-secret");
    const resultPath = join(root, "mcp-result.json");
    const mcpToken = "process-mcp-token";
    const operatorToken = "process-operator-token";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      ACP_MCP_TOKEN: mcpToken,
      ACP_OPERATOR_TOKEN: operatorToken,
      ACP_OPERATOR_ACTOR: "process-owner",
      ACP_OPERATOR_SOCKET: join(stateDir, "agentcpd.operator.sock"),
    };
    let firstDaemon: ManagedDaemon | null = null;
    let secondDaemon: ManagedDaemon | null = null;
    let capturedDaemonOutput = "";
    let runtimePid: number | null = null;

    try {
      firstDaemon = launchDaemon(env);
      await waitForDaemonStart(firstDaemon, "initial agentcpd");

      const bootstrap = await runAgentctl(env, [
        "bootstrap",
        "hermes",
        "--",
        process.execPath,
        HERMES_RUNTIME,
        pidPath,
        continuePath,
        secretPath,
        resultPath,
      ]);
      expect(bootstrap.code, bootstrap.stderr || bootstrap.stdout).toBe(0);
      expect(bootstrap.stdout).toContain('"bindingGeneration": 1');
      expect(bootstrap.stdout).not.toContain("sessionSecret");
      await waitUntil(() => existsSync(pidPath), "Hermes runtime launch");
      await waitUntil(() => existsSync(secretPath), "session secret delivery");
      runtimePid = Number(readFileSync(pidPath, "utf8"));
      expect(Number.isInteger(runtimePid)).toBe(true);

      await stopDaemon(firstDaemon);
      if (firstDaemon) capturedDaemonOutput += daemonOutput(firstDaemon);
      firstDaemon = null;

      secondDaemon = launchDaemon(env);
      await waitForDaemonStart(secondDaemon, "agentcpd restart");

      writeFileSync(continuePath, "restart-complete\n", { mode: 0o600 });
      await waitUntil(() => existsSync(resultPath), "authenticated Hermes MCP result");
      const result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
      expect(result).toMatchObject({
        projectResponseId: 2,
        doctorResponseId: 3,
        projectAuthenticated: true,
        doctorAuthenticated: true,
        projectNotFound: true,
      });

      const rerun = await runAgentctl(env, [
        "bootstrap",
        "hermes",
        "--",
        process.execPath,
        "-e",
        "process.exit(0)",
      ]);
      expect(rerun.code).toBe(1);
      expect(rerun.stdout).toContain("BINDING_ALREADY_ACTIVE");

      const sessionSecret = readFileSync(secretPath, "utf8");
      await stopDaemon(secondDaemon);
      if (secondDaemon) capturedDaemonOutput += daemonOutput(secondDaemon);
      secondDaemon = null;
      const logFiles = logFilesUnder(root);
      const logOutput = logFiles.map((path) => readFileSync(path, "utf8")).join("\n");
      const capturedOutput = [
        capturedDaemonOutput,
        bootstrap.stdout,
        bootstrap.stderr,
        rerun.stdout,
        rerun.stderr,
        logOutput,
      ].join("\n");
      expect(capturedOutput).not.toContain(sessionSecret);
    } finally {
      writeFileSync(continuePath, "cleanup\n", { mode: 0o600 });
      await stopDaemon(secondDaemon);
      await stopDaemon(firstDaemon);
      if (runtimePid && Number.isInteger(runtimePid)) {
        try { process.kill(runtimePid, "SIGTERM"); } catch { /* already gone */ }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
