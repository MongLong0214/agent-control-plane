import { spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { WriteOperation } from "../../src/guard/managed-write-guard.ts";
import { ClaudeCliAdapter, __testing } from "../../src/runtime/cli-adapters.ts";
import type { InvocationRequest, ManagedInvocationWriteBroker } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { requireSeatbelt } from "../helpers/seatbelt.ts";

/**
 * #1077 — once the probe can run, it runs as a WORKER turn does: the operator's hooks, plugins and
 * user MCP servers are not loaded. Measured on claude 2.1.283 before this change, with a HOME of its
 * own and no login: the CLI still starts a user-scope MCP server, runs user `SessionStart` and
 * `UserPromptSubmit` hooks, and runs an enabled plugin's hooks, before it answers "Not logged in".
 *
 * HOME points at a private directory before anything is imported. Every configuration below is
 * written there; the operator's own settings and login are never read, printed or changed.
 */
const isolatedHome = vi.hoisted(() => {
  const home = `${(process.env["TMPDIR"] ?? "/tmp").replace(/\/+$/, "")}/acp-probe-isolation-home-${process.pid}`;
  process.env["HOME"] = home;
  return home;
});

afterAll(() => {
  cleanupTempDirs();
  rmSync(isolatedHome, { recursive: true, force: true });
});
afterEach(() => __testing.setRunCli(null));

/* -------------------------------------------- argv -------------------------------------------- */

const SESSION = "11111111-1111-4111-8111-111111111111";

const captureArgv = async (run: (adapter: ClaudeCliAdapter) => Promise<unknown>): Promise<string[]> => {
  let seen: string[] = [];
  __testing.setRunCli(async (_file, args) => {
    seen = [...args];
    return {
      stdout: JSON.stringify({ session_id: SESSION, result: "ok" }),
      stderr: "",
      exitCode: 0,
      timedOut: false,
      isolationEnforced: false,
      processGroup: { pgid: 1, reaped: true, signalled: true, signals: ["sent"], ownership: "HELD", detail: null },
    };
  });
  const broker: ManagedInvocationWriteBroker = { authorize: async (_write, effect) => allow(ReasonCode.WRITE_ALLOWED, await effect()) };
  await run(new ClaudeCliAdapter({ clock: new ManualClock(), capacityFile: "/nonexistent/claude.json", binary: process.execPath, managedWriteBroker: broker }));
  return seen;
};

const valueAfter = (argv: readonly string[], flag: string): string | undefined => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};

const ISOLATION_FLAGS = ["--settings", "--setting-sources", "--mcp-config"] as const;

describe("the session probe's argv carries the WORKER turn's isolation (#1077)", () => {
  it("is the unchanged probe argv followed by the sanctioned settings, the worktree setting sources and a strict, empty MCP config", async () => {
    const argv = await captureArgv((adapter) => adapter.probeSession({
      externalSessionId: SESSION, provider: "claude", model: "opus", effort: null, pid: null,
    }));
    expect(argv).toEqual([
      "-p", "--output-format", "json", "--model", "opus", "--session-id", SESSION,
      "--settings", JSON.stringify({ hooks: {}, enabledPlugins: {} }),
      "--setting-sources", "project,local",
      "--mcp-config", JSON.stringify({ mcpServers: {} }),
      "--strict-mcp-config",
    ]);
  });

  it("matches a WORKER turn's isolation flags value for value", async () => {
    const probe = await captureArgv((adapter) => adapter.probeSession({
      externalSessionId: SESSION, provider: "claude", model: "opus", effort: null, pid: null,
    }));
    const cwd = process.cwd();
    const worker = await captureArgv((adapter) => adapter.invoke({
      prompt: "p",
      workdir: cwd,
      timeoutMs: 1_000,
      correlationId: "c",
      readOnly: false,
      model: "opus",
      externalSessionId: SESSION,
      managedWrite: {
        operation: WriteOperation.FILE_MUTATION,
        targetPath: cwd,
        taskId: "task_x",
        taskReceiptId: "task_x#1",
        assignedWorktreeId: cwd,
        runId: "run_x",
        sessionId: "ses_x",
        sessionIncarnation: `${SESSION}#t`,
        bindingGeneration: 1,
      },
    } as InvocationRequest));
    for (const flag of ISOLATION_FLAGS) {
      expect(valueAfter(probe, flag), flag).toBeDefined();
      expect(valueAfter(probe, flag), flag).toBe(valueAfter(worker, flag));
    }
    expect(probe).toContain("--strict-mcp-config");
    expect(worker).toContain("--strict-mcp-config");
  });
});

/* ------------------------------------- behaviour, real CLI ------------------------------------- */

/** The real `claude` on this host's PATH, if there is one. It is run logged out, under a HOME of its own. */
const realClaude = ((): string | null => {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "claude");
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      /* not here */
    }
  }
  return null;
})();

/** Every connection a marker makes, by tag. A marker that ran inside the probe's sandbox reports here. */
let listener: Server;
let port = 0;
const received: string[] = [];

beforeAll(async () => {
  listener = createServer((socket) => {
    let tag = "";
    socket.on("data", (chunk) => (tag += chunk.toString("utf8")));
    socket.on("end", () => received.push(tag));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  port = typeof address === "object" && address ? address.port : 0;
});
afterAll(() => new Promise<void>((resolve) => listener.close(() => resolve())));

const markerScript = (): string => {
  const script = join(tempDir("acp-probe-isolation-marker-"), "marker.cjs");
  writeFileSync(script, `const [port, tag, stay] = process.argv.slice(2);
const socket = require("node:net").connect(Number(port), "127.0.0.1", () => {
  socket.end(tag, () => { if (stay !== "stay") process.exit(0); });
});
socket.on("error", () => process.exit(0));
if (stay === "stay") { process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); }
`);
  chmodSync(script, 0o600);
  return script;
};

const command = (script: string, tag: string): string => `${process.execPath} ${script} ${port} ${tag}`;

/** One configuration surface at a time in the private HOME; whatever the previous test wrote is gone. */
const resetHome = (): void => {
  rmSync(join(isolatedHome, ".claude"), { recursive: true, force: true });
  rmSync(join(isolatedHome, ".claude.json"), { force: true });
  mkdirSync(join(isolatedHome, ".claude"), { recursive: true });
};

const writeJson = (path: string, value: unknown): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
};

const hooksFor = (script: string, origin: string) => ({
  SessionStart: [{ hooks: [{ type: "command", command: command(script, `${origin}:SessionStart`) }] }],
  UserPromptSubmit: [{ hooks: [{ type: "command", command: command(script, `${origin}:UserPromptSubmit`) }] }],
});

const surfaces = {
  /** A user-scope MCP server in `~/.claude.json`. */
  "user MCP server": (script: string): void => {
    writeJson(join(isolatedHome, ".claude.json"), {
      hasCompletedOnboarding: true,
      mcpServers: { marker: { type: "stdio", command: process.execPath, args: [script, String(port), "user-mcp", "stay"] } },
    });
  },
  /** User hooks in `~/.claude/settings.json`. */
  "user hook": (script: string): void => {
    writeJson(join(isolatedHome, ".claude.json"), { hasCompletedOnboarding: true });
    writeJson(join(isolatedHome, ".claude", "settings.json"), { hooks: hooksFor(script, "user-hook") });
  },
  /** An enabled plugin from a local marketplace, whose hooks report. */
  plugin: (script: string): Promise<void> => {
    const market = tempDir("acp-probe-isolation-market-");
    writeJson(join(market, ".claude-plugin", "marketplace.json"), {
      name: "acpwitness",
      owner: { name: "acp" },
      plugins: [{ name: "marker", source: "./plugins/marker", description: "marker" }],
    });
    writeJson(join(market, "plugins", "marker", ".claude-plugin", "plugin.json"), { name: "marker", version: "1.0.0", description: "marker" });
    writeJson(join(market, "plugins", "marker", "hooks", "hooks.json"), { hooks: hooksFor(script, "plugin-hook") });
    writeJson(join(isolatedHome, ".claude.json"), { hasCompletedOnboarding: true });
    writeJson(join(isolatedHome, ".claude", "settings.json"), {
      extraKnownMarketplaces: { acpwitness: { source: { source: "directory", path: market } } },
      enabledPlugins: { "marker@acpwitness": true },
    });
    // Installed the way an operator's plugin is: by one ordinary, unconfined run of the same CLI in
    // this HOME, before the probe. The probe's sandbox denies writes under HOME, so a plugin the CLI
    // has never installed could not be installed from inside it. Its markers are discarded below.
    return new Promise<void>((resolve) => {
      const install = spawnChild(realClaude!, ["-p", "--output-format", "json"], {
        cwd: tempDir("acp-probe-isolation-install-"),
        env: { HOME: isolatedHome, ...(process.env["USER"] ? { USER: process.env["USER"] } : {}), PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        stdio: ["pipe", "ignore", "ignore"],
      });
      const bound = setTimeout(() => install.kill("SIGKILL"), 30_000);
      install.on("close", () => {
        clearTimeout(bound);
        resolve();
      });
      install.stdin?.end("x");
    });
  },
} as const;

describe("a session probe on the real CLI starts no operator hook, plugin or user MCP server (#1077)", () => {
  for (const [surface, configure] of Object.entries(surfaces)) {
    it.skipIf(realClaude === null)(`${surface}: its marker never reports from inside the probe`, async (ctx) => {
      requireSeatbelt(ctx);
      resetHome();
      const script = markerScript();
      await configure(script);
      // Anything an installation run reported is not the probe's.
      await new Promise((resolve) => setTimeout(resolve, 500));
      received.length = 0;

      // Control: a process under the same runtime profile reaches the listener, so an absent marker
      // is the probe not starting it, not the sandbox stopping it from reporting.
      const control = await __testing.productionRunCli(process.execPath, [script, String(port), "control"], { cwd: undefined, timeoutMs: 10_000 });
      expect(control.exitCode, control.stderr).toBe(0);

      const adapter = new ClaudeCliAdapter({
        clock: { nowIso: () => "2026-10-10T00:00:00.000Z" } as never,
        capacityFile: join(isolatedHome, ".agent-control-plane", "capacity.fixture"),
        binary: realClaude!,
      });
      const health = await adapter.probeSession({
        externalSessionId: randomUUID(), provider: "claude", model: "opus", effort: null, pid: null,
      });
      // Late reporters get their chance before the verdict.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      console.error(`WITNESS isolation ${surface} ${JSON.stringify({ health, received })}`);

      expect(received).toContain("control");
      expect(received.filter((tag) => tag !== "control")).toEqual([]);
    });
  }
});
