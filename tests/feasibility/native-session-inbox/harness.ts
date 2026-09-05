/**
 * C0 feasibility harness: can one opaque wake, posted to a running Claude Code
 * session's native unix-domain-socket inbox, reach that session's real model input?
 *
 * Everything here is disposable and offline. The harness owns a temp root that holds
 * the isolated CLAUDE_CONFIG_DIR, the per-invocation settings file, the socket
 * directory, and the fake provider's capture log; nothing outside that root is read
 * or written, and no request leaves loopback.
 *
 * Scope is deliberately narrow. This proves delivery only. There is no claim fence,
 * no subscriber, no durable state -- and the wake carries no payload, because the
 * only thing it is ever allowed to mean is "call the ACP claim tool".
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

import { startFakeAnthropic, type CapturedRequest, type FakeAnthropic } from "./fake-anthropic.ts";

/**
 * The wake. Constant, opaque, and the whole vocabulary of this channel.
 *
 * It is not a message: it carries no sender, no event, no instruction, and nothing
 * secret. A recipient that learns anything from it beyond "there is work to claim"
 * is reading something this slice does not send.
 */
export const ACP_WAKE = "ACP-WAKE-V1-c0a1f2b6";

/**
 * A dummy credential. Never a real key, and never read from the user's keychain or
 * OAuth store -- HOME and CLAUDE_CONFIG_DIR are both redirected into the temp root,
 * so the CLI has no reachable credential other than this one.
 */
const DUMMY_API_KEY = "sk-ant-c0-feasibility-dummy-not-a-real-credential";

/**
 * A closed port. Anything the CLI tries to send over a proxy lands here and fails at
 * connect. Loopback is excluded so the fake endpoint stays reachable. This turns
 * "nothing left the machine" from an absence into a containment we configured.
 */
const BLACKHOLE_PROXY = "http://127.0.0.1:9";

export interface HarnessResult {
  /** Every request the fake provider received, in arrival order. */
  readonly captured: readonly CapturedRequest[];
  /** Bodies of the requests that hit the model-input boundary. */
  readonly modelInputBodies: readonly string[];
  /** The CLI's stream-json stdout, line-parsed where possible. */
  readonly stdout: string;
  readonly stderr: string;
  /** The `system/init` frame the CLI emits at startup. */
  readonly init: Record<string, unknown> | undefined;
  readonly socketPath: string;
  readonly baseUrl: string;
}

export interface RunOptions {
  /**
   * When set, the harness opens the session's inbox socket and writes exactly one
   * `type: "user"` frame carrying this text. Omit it for the RED control.
   */
  readonly inject?: string;
  /** How long to wait for the post-injection turn to reach the provider. */
  readonly settleMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(100);
  }
  return predicate();
};

const readCapture = (path: string): CapturedRequest[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CapturedRequest);

/**
 * Posts one frame to the session inbox and closes.
 *
 * No auth line is sent. On macOS the runtime authenticates the peer by credentials
 * on the socket itself (it reports back a `verifiedPeerPid`), and the socket
 * directory is mode 0700 so only this uid can reach it. The auth-token path exists
 * for platforms without that protection; deliberately not used, and not stored.
 */
const injectWake = async (socketPath: string, text: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(socketPath, () => {
      socket.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
      socket.end();
    });
    socket.on("error", reject);
    socket.on("close", () => resolve());
  });
};

export const isClaudeCliAvailable = (): boolean => {
  const paths = (process.env.PATH ?? "").split(":");
  return paths.some((dir) => dir.length > 0 && existsSync(join(dir, "claude")));
};

/**
 * Runs one disposable session end to end and returns what the fake provider saw.
 *
 * The GREEN and RED runs differ in exactly one input -- whether `inject` is set --
 * so a difference in the capture is attributable to the injection and to nothing else.
 */
export const runInboxProbe = async (options: RunOptions = {}): Promise<HarnessResult> => {
  const settleMs = options.settleMs ?? 15_000;

  // Short root on purpose: a unix socket path is capped near 104 bytes, and a deep
  // nested path silently fails to bind rather than erroring somewhere legible.
  const root = mkdtempSync("/private/tmp/acp-c0-");
  chmodSync(root, 0o700);

  const configDir = join(root, "cfg");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });

  // The runtime refuses to bind unless this directory is 0700 -- anything looser and
  // another user or group could reach or replace the socket. mkdir honours umask, so
  // chmod after the fact rather than trusting the mode argument.
  const socketDir = join(root, "s");
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  chmodSync(socketDir, 0o700);
  const socketPath = join(socketDir, "i.sock");

  const capturePath = join(root, "capture.jsonl");
  writeFileSync(capturePath, "");

  const settingsPath = join(root, "settings.json");
  // Only this key. A disposable session opting in to peer delivery, and nothing else.
  writeFileSync(settingsPath, JSON.stringify({ crossSessionInbound: "accept" }));

  let fake: FakeAnthropic | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let stdout = "";
  let stderr = "";

  try {
    fake = await startFakeAnthropic(capturePath);

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      // HOME is redirected too: it is where OAuth credentials and the real settings
      // tree live, and an isolated CLAUDE_CONFIG_DIR alone does not move it.
      HOME: root,
      TMPDIR: root,
      CLAUDE_CONFIG_DIR: configDir,
      ANTHROPIC_BASE_URL: fake.baseUrl,
      ANTHROPIC_API_KEY: DUMMY_API_KEY,
      HTTPS_PROXY: BLACKHOLE_PROXY,
      HTTP_PROXY: BLACKHOLE_PROXY,
      NO_PROXY: "127.0.0.1,localhost",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_BUG_COMMAND: "1",
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };

    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "claude-sonnet-4-5",
      // Per-invocation settings, and no other source: not the user's, not the
      // project's. An empty --setting-sources is what makes that true.
      "--settings",
      settingsPath,
      "--setting-sources",
      "",
      "--messaging-socket-path",
      socketPath,
    ];

    child = spawn("claude", args, { env, cwd: root, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    // One ordinary turn first. stdin stays open afterwards, which is what keeps the
    // session alive and listening instead of exiting the moment the turn completes.
    child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: "ping" } })}\n`);

    const bound = await waitFor(() => existsSync(socketPath), 60_000);
    if (!bound) throw new Error(`inbox socket never appeared at ${socketPath}\n${stderr}`);

    const baselineSeen = await waitFor(
      () => readCapture(capturePath).some((r) => r.url.includes("/v1/messages")),
      60_000,
    );
    if (!baselineSeen) throw new Error(`no baseline model request reached the fake endpoint\n${stderr}`);
    const baselineCount = readCapture(capturePath).filter((r) => r.url.includes("/v1/messages")).length;

    if (options.inject !== undefined) {
      await injectWake(socketPath, options.inject);
      await waitFor(
        () => readCapture(capturePath).filter((r) => r.url.includes("/v1/messages")).length > baselineCount,
        settleMs,
      );
    } else {
      // The RED control waits the same wall-clock. An absence measured over a shorter
      // window than the presence would not be the same measurement.
      await sleep(settleMs);
    }

    const captured = readCapture(capturePath);
    const initLine = stdout
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .find((frame) => frame?.type === "system" && frame?.subtype === "init");

    return {
      captured,
      modelInputBodies: captured.filter((r) => r.url.includes("/v1/messages")).map((r) => r.body),
      stdout,
      stderr,
      init: initLine,
      socketPath,
      baseUrl: fake.baseUrl,
    };
  } finally {
    child?.kill("SIGKILL");
    await fake?.close();
  }
};
