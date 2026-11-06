import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { basename, join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import type { ReviewerEgressConfig } from "../../src/runtime/provider.ts";
import { reapOrphanedReviewerEgress } from "../../src/runtime/reviewer-egress.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1344 D — a cut-off review's allowlist proxy survived a daemon restart with ppid 1, still listening on the fixed
 * reviewer port, and the next review failed ISOLATION_LOST. At start the daemon stops the proxies an earlier instance
 * recorded (their lease directory and exact argv), frees the port, and leaves alone what it cannot prove is its own.
 */

const PYTHON = "/usr/bin/python3";
const LISTENER = [
  "import socket, sys, time",
  "srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)",
  "srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
  "srv.bind(('127.0.0.1', int(sys.argv[1])))",
  "srv.listen(8)",
  "while True:",
  "    time.sleep(60)",
  "",
].join("\n");

/** Only the fixture processes this file started are ever signalled, by their exact pid. */
const started: number[] = [];
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
afterEach(() => {
  for (const pid of started.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
});

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port")));
  });
});

const listening = (port: number): Promise<boolean> => new Promise((resolve) => {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
});

const waitListening = async (port: number): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!(await listening(port))) {
    if (Date.now() > deadline) throw new Error(`nothing listened on ${port}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** Started through a shell that exits at once, so the process is an orphan (ppid 1) as the cut-off proxy was. */
const orphan = (args: readonly string[]): number => {
  const pid = Number(execFileSync("/bin/sh", ["-c", '"$0" "$@" </dev/null >/dev/null 2>&1 & echo $!', PYTHON, ...args], { encoding: "utf8" }).trim());
  started.push(pid);
  return pid;
};
const parentOf = (pid: number): number => Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());

/** A reviewer egress layout under a fresh state root, with a lease directory an earlier instance left behind. */
const layout = async (): Promise<{ config: ReviewerEgressConfig; port: number; lease: string }> => {
  const root = tempDir("acp-1344-egress-");
  const egress = join(root, "egress");
  mkdirSync(join(egress, "runs"), { recursive: true, mode: 0o700 });
  const proxyPath = join(egress, "allowlist-proxy.py");
  writeFileSync(proxyPath, LISTENER);
  const port = await freePort();
  const config: ReviewerEgressConfig = { profilePath: join(egress, "reviewer.sb"), proxyPath, runtimeDir: join(egress, "runs"), port };
  const lease = mkdtempSync(join(config.runtimeDir, "reviewer-egress-"));
  writeFileSync(join(lease, "allowlist.txt"), "api.anthropic.com\n", { mode: 0o600 });
  writeFileSync(join(lease, "egress.jsonl"), "", { mode: 0o600 });
  return { config, port, lease };
};

/** The proxy exactly as `acquireReviewerEgress` launches it for that lease. */
const recordedProxy = (config: ReviewerEgressConfig, port: number, lease: string): number =>
  orphan([config.proxyPath, String(port), join(lease, "allowlist.txt"), join(lease, "egress.jsonl")]);

describe("#1344 D: a daemon start reaps the reviewer egress proxy an earlier instance left running", () => {
  it("stops the recorded orphaned proxy by its exact pid, frees the port and removes its lease", async () => {
    const { config, port, lease } = await layout();
    const pid = recordedProxy(config, port, lease);
    await waitListening(port);
    expect(parentOf(pid)).toBe(1);

    const reaped = await reapOrphanedReviewerEgress(config);

    expect(reaped).toEqual({
      port,
      leases: [basename(lease)],
      stopped: [{ pid, lease: basename(lease) }],
      survived: [],
      portFree: true,
    });
    expect(alive(pid)).toBe(false);
    expect(await listening(port)).toBe(false);
    expect(existsSync(lease)).toBe(false);
  });

  it("does not kill an unrelated process on the port: the holder is left running and the port reported held", async () => {
    const { config, port, lease } = await layout();
    // Same interpreter, same port, same listening code: only its argv is not a recorded lease's.
    const unrelated = orphan(["-c", LISTENER, String(port)]);
    await waitListening(port);

    const reaped = await reapOrphanedReviewerEgress(config);

    expect(reaped).toEqual({ port, leases: [basename(lease)], stopped: [], survived: [], portFree: false });
    expect(alive(unrelated)).toBe(true);
    expect(await listening(port)).toBe(true);
  });

  it("a proxy of another state directory's lease is not this daemon's, and is left running", async () => {
    const { config, port } = await layout();
    const other = await layout();
    const foreign = recordedProxy(other.config, port, other.lease);
    await waitListening(port);

    const reaped = await reapOrphanedReviewerEgress(config);

    expect(reaped).toMatchObject({ stopped: [], survived: [], portFree: false });
    expect(alive(foreign)).toBe(true);
  });

  it("nothing is probed or signalled when no lease was left behind", async () => {
    const { config, port, lease } = await layout();
    execFileSync("rm", ["-rf", lease]);
    const unrelated = orphan(["-c", LISTENER, String(port)]);
    await waitListening(port);

    expect(await reapOrphanedReviewerEgress(config)).toBeNull();
    expect(alive(unrelated)).toBe(true);
  });

  it("the daemon's start reaps it before any review can start, and records what it found", async () => {
    const harness = makeHarness();
    const { config, port, lease } = await layout();
    // The harness's own reviewer egress, on a free port rather than the machine's fixed one.
    const egress = harness.cp.config.reviewerEgress!;
    egress.port = port;
    egress.proxyPath = config.proxyPath;
    egress.runtimeDir = config.runtimeDir;
    const pid = recordedProxy(egress, port, lease);
    await waitListening(port);

    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-1344-daemon-") });
    try {
      await daemon.start();
      const [record] = harness.cp.audit.byKind("REVIEWER_EGRESS_REAPED");
      expect(record).toMatchObject({
        reasonCode: ReasonCode.OK,
        evidence: { port, stopped: [{ pid, lease: basename(lease) }], survived: [], portFree: true },
      });
      expect(alive(pid)).toBe(false);
      expect(await listening(port)).toBe(false);
    } finally {
      await daemon.stop();
    }
  });
});
