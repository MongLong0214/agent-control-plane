import { execFile, spawn, type ChildProcess } from "node:child_process";
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

const HERMES_RUNTIME = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const pidPath = process.argv[1];
const continuePath = process.argv[2];
const secretPath = process.argv[3];
const resultPath = process.argv[4];
fs.writeFileSync(pidPath, String(process.pid));

const waitForFile = (path) => new Promise((resolve) => {
  const timer = setInterval(() => {
    if (fs.existsSync(path)) {
      clearInterval(timer);
      resolve();
    }
  }, 25);
});

const oneLine = (socket, body) => socket.write(JSON.stringify(body) + "\n");
const bootstrap = () => new Promise((resolve, reject) => {
  const socketPath = process.env.ACP_HERMES_BOOTSTRAP_SOCKET;
  const token = process.env.ACP_HERMES_BOOTSTRAP_TOKEN;
  const nonce = "process-runtime-possession-nonce-123";
  const proof = crypto.createHmac("sha256", token).update(nonce).digest("hex");
  const socket = net.createConnection(socketPath, () => {
    oneLine(socket, { runtimeNonce: nonce, runtimeProof: proof });
  });
  let received = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    received += chunk;
    const boundary = received.indexOf("\n");
    if (boundary === -1) return;
    const response = JSON.parse(received.slice(0, boundary));
    if (!response.ok) return reject(new Error("bootstrap denied: " + response.reasonCode));
    resolve({ sessionId: response.sessionId, sessionSecret: response.sessionSecret });
  });
  socket.on("error", reject);
});

const mcp = (sessionId, sessionSecret) => new Promise((resolve, reject) => {
  const socket = net.createConnection(process.env.ACP_HERMES_MCP_SOCKET);
  const responses = new Map();
  let received = "";
  let finished = false;
  const finish = (value, error) => {
    if (finished) return;
    finished = true;
    if (error) reject(error);
    else resolve(value);
  };
  const timer = setTimeout(() => finish(null, new Error("MCP response timed out")), 30_000);
  const inspect = () => {
    for (const line of received.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        if (value && value.id !== undefined) responses.set(value.id, value);
      } catch {
        // The transport only emits JSON lines; incomplete chunks are handled below.
      }
    }
    if (responses.has(2) && responses.has(3)) {
      clearTimeout(timer);
      socket.end();
      finish({ project: responses.get(2), doctor: responses.get(3) });
    }
    if (received.includes("MCP_PEER_UNAUTHENTICATED")) {
      clearTimeout(timer);
      socket.destroy();
      finish(null, new Error("normal Hermes MCP authentication was refused"));
    }
  };
  socket.setEncoding("utf8");
  socket.on("connect", () => {
    oneLine(socket, {
      token: process.env.ACP_MCP_TOKEN,
      sessionId,
      sessionSecret,
    });
    oneLine(socket, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "hermes-bootstrap-process-test", version: "1" },
      },
    });
    oneLine(socket, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    oneLine(socket, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "project_get", arguments: { projectId: "fresh-install-project" } },
    });
    oneLine(socket, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "doctor_run", arguments: { scope: "system" } },
    });
  });
  socket.on("data", (chunk) => {
    received += chunk;
    inspect();
  });
  socket.on("error", (error) => {
    clearTimeout(timer);
    finish(null, error);
  });
  socket.on("close", () => {
    if (!finished) {
      clearTimeout(timer);
      finish(null, new Error("MCP socket closed before authenticated tool responses"));
    }
  });
});

// The handshake returns the secret before the daemon restart. The runtime retains it only
// in this process and never writes it to stdout, stderr, an audit record, or the result file.
bootstrap().then(async ({ sessionId, sessionSecret }) => {
  fs.writeFileSync(secretPath, sessionSecret, { mode: 0o600 });
  await waitForFile(continuePath);
  const result = await mcp(sessionId, sessionSecret);
  const projectText = JSON.stringify(result.project);
  const doctorText = JSON.stringify(result.doctor);
  fs.writeFileSync(resultPath, JSON.stringify({
    projectResponseId: result.project.id,
    doctorResponseId: result.doctor.id,
    projectAuthenticated: !projectText.includes("MCP_PEER_UNAUTHENTICATED"),
    doctorAuthenticated: !doctorText.includes("MCP_PEER_UNAUTHENTICATED"),
    projectNotFound: projectText.includes("NOT_FOUND"),
  }));
  process.exit(0);
}).catch((error) => {
  fs.writeFileSync(resultPath, JSON.stringify({ error: String(error).slice(0, 200) }));
  process.exit(2);
});
`;

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

    const stateDir = join(home, ".agent-control-plane");
    // A real daemon preflight also requires the independently provisioned GitHub gate
    // credential before startup. This is deployment configuration, not CP state or a
    // fixture/database shortcut; the Hermes CEO state below is still genuinely empty.
    const secretsDir = join(stateDir, "secrets");
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(secretsDir, "github-authority.token"), "fake-github-token\n", { mode: 0o600 });
    writeFileSync(join(secretsDir, "github-authority.identity"), "process-owner\n", { mode: 0o600 });
    chmodSync(secretsDir, 0o700);
    chmodSync(join(secretsDir, "github-authority.token"), 0o600);
    chmodSync(join(secretsDir, "github-authority.identity"), 0o600);
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
        "-e",
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
