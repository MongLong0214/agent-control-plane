import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * A stand-in for the Claude Code process the attach relay is spawned by.
 *
 * The relay proves its messaging socket is its claimed session's by reading the session registry Claude Code keeps
 * (`<home>/.claude/sessions/<pid>.json`) for its nearest ancestor that is Claude Code itself. A test that spawns the
 * real CLI directly would have the test runner as its parent, so it is spawned instead under a process whose binary is
 * named `claude` (a link to this node), which writes its own registry record and then runs the relay as its child:
 * the same shape as a session, a registry file and an MCP child. Nothing about the relay is stubbed.
 *
 * The relay is held until `start()`, so a test can first tell the daemon fixture its pid (`relayPid`). It is run by
 * `sh` with `exec`, so the pid that was waited for is the pid that connects.
 */
export interface ClaudeParent {
  /** The stand-in Claude Code. Its stdio is the relay's, and its exit code is the relay's. */
  readonly child: ChildProcess;
  /** The relay's pid, once it has been created (not yet running its command). */
  relayPid(): Promise<number>;
  /** Lets the relay run its command. */
  start(): void;
}

const LAUNCHER = `
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const cfg = JSON.parse(process.env.CLAUDE_PARENT_CONFIG);
const started = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", timeout: 5000 }).trim();
mkdirSync(cfg.home + "/.claude/sessions", { recursive: true });
writeFileSync(cfg.home + "/.claude/sessions/" + process.pid + ".json", JSON.stringify({
  pid: process.pid, sessionId: cfg.sessionId, messagingSocketPath: cfg.socketPath, procStart: started,
}));
const child = spawn("/bin/sh", ["-c", 'while [ ! -e "$1" ]; do sleep 0.02; done; shift; exec "$@"', "sh", cfg.goFile, ...cfg.argv], {
  stdio: "inherit", cwd: cfg.cwd,
});
writeFileSync(cfg.pidFile, String(child.pid));
child.on("exit", (code) => process.exit(code ?? 1));
`;

export const spawnUnderClaude = (options: {
  /** A directory this call may fill: the `claude` link, the launcher and its handshake files. */
  dir: string;
  /** The relay's `HOME`: where `.claude/sessions` is read. */
  home: string;
  sessionId: string;
  socketPath: string | null;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  autoStart?: boolean;
}): ClaudeParent => {
  mkdirSync(options.dir, { recursive: true });
  const claude = join(options.dir, "claude");
  if (!existsSync(claude)) symlinkSync(process.execPath, claude);
  const launcher = join(options.dir, "launcher.mjs");
  writeFileSync(launcher, LAUNCHER);
  const pidFile = join(options.dir, `relay-${Math.random().toString(36).slice(2)}.pid`);
  const goFile = `${pidFile}.go`;
  const child = spawn(claude, [launcher], {
    cwd: options.cwd,
    env: {
      ...options.env,
      CLAUDE_PARENT_CONFIG: JSON.stringify({
        home: options.home, sessionId: options.sessionId, socketPath: options.socketPath,
        argv: options.argv, cwd: options.cwd, pidFile, goFile,
      }),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const parent: ClaudeParent = {
    child,
    relayPid: async () => {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (existsSync(pidFile)) {
          const text = readFileSync(pidFile, "utf8").trim();
          if (text.length > 0) return Number(text);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("the stand-in Claude Code never started the relay");
    },
    start: () => writeFileSync(goFile, "go"),
  };
  if (options.autoStart !== false) parent.start();
  return parent;
};
