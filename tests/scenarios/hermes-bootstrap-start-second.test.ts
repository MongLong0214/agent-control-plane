import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHermesBootstrapAuthority } from "../../src/bootstrap/hermes-bootstrap.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { digestOf } from "../../src/core/digest.ts";
import type * as ProcessArgv from "../../src/core/process-argv.ts";
import type * as ProcessIdentity from "../../src/core/process-identity.ts";
import { COVERAGE_REVOCATION_GRACE_MS, Daemon } from "../../src/daemon/daemon.ts";
import { Role, roleKeyFor } from "../../src/domain/types.ts";
import { runHermesTargetBind } from "../../src/runtime/hermes-target-bind.ts";
import type * as HermesTargetBindModule from "../../src/runtime/hermes-target-bind.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness, type Harness } from "../helpers/harness.ts";

/**
 * A Hermes CEO whose runtime proves itself inside the second it started is a live incumbent.
 *
 * The bootstrap writes the CEO's session row as soon as the runtime's proof arrives. A runtime that
 * proves at once gets a row written inside its own `ps` lstart second, and such a row alone cannot
 * tell the runtime from a successor that took its pid later in that second. The bootstrap therefore
 * pins the runtime's native start beside the row, the way CTO launch and continuity provisioning do,
 * and the keep for an unread provider compares that pin exactly. Without the pin the CEO took the
 * coverage hold and was revoked when it ended, with its run paused.
 *
 * The process reads are faked for the runtime's pid only, because no real process can be placed
 * inside a chosen second; the runtime writes its pid and waits for the test to fake its reads before
 * it proves. The lstart text is rendered in this process's local time, the zone `ps` renders in and
 * the daemon parses in.
 */
const ids = vi.hoisted(() => {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  const lstartOf = (epochSecond: number): string => {
    const d = new Date(epochSecond * 1000);
    return `${days[d.getDay()]} ${months[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getFullYear()}`;
  };
  // 2026-09-30T14:50:30Z; the row is written 123 ms into it.
  const startSecond = 1_790_779_830;
  return {
    lstartOf,
    startSecond,
    rowWritten: "2026-09-30T14:50:30.123Z",
    native: new Map<number, string | null>(),
    lstart: new Map<number, string | null>(),
  };
});

vi.mock("../../src/core/process-argv.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessArgv>();
  return {
    ...actual,
    readProcessStartToken: (pid: number) =>
      ids.native.has(pid) ? ids.native.get(pid)! : actual.readProcessStartToken(pid),
  };
});

vi.mock("../../src/core/process-identity.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessIdentity>();
  return {
    ...actual,
    processStartedAt: (pid: number | null | undefined) =>
      typeof pid === "number" && ids.lstart.has(pid) ? ids.lstart.get(pid)! : actual.processStartedAt(pid),
  };
});

vi.mock("../../src/runtime/hermes-target-bind.ts", async (original) => ({
  ...(await original<typeof HermesTargetBindModule>()),
  runHermesTargetBind: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(runHermesTargetBind).mockImplementation((input) => {
    const receipt = {
      domain: "hermes.target-bind" as const, version: 1 as const, actor_id: input.actorId,
      binding_generation: input.bindingGeneration, executor_runtime_identity: input.executorRuntimeIdentity,
      requested_session_id: input.sessionId, lineage_root_digest: input.expectedLineageRootDigest,
    };
    return { allowed: true, value: { ...receipt, receipt_digest: digestOf(receipt) } };
  });
});

const runtimes: number[] = [];
afterEach(() => {
  for (const pid of runtimes.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  ids.native.clear();
  ids.lstart.clear();
});
afterAll(cleanupTempDirs);

const CEO_ROLE_KEY = roleKeyFor(Role.CEO);
const STARTED_TOKEN = `darwin-tv:${ids.startSecond}.050000`;

/**
 * Publishes its pid by rename, waits for the gate, proves, and stays alive as a CEO runtime does.
 */
const LIVE_RUNTIME = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const [pidPath, gatePath] = process.argv.slice(1);
fs.writeFileSync(pidPath + ".partial", String(process.pid));
fs.renameSync(pidPath + ".partial", pidPath);
const nonce = "start-second-runtime-possession-nonce-123";
const prove = () => {
  if (!fs.existsSync(gatePath)) return setTimeout(prove, 10);
  const socket = net.createConnection(process.env.ACP_HERMES_BOOTSTRAP_SOCKET, () => {
    const runtimeProof = crypto.createHmac("sha256", process.env.ACP_HERMES_BOOTSTRAP_TOKEN)
      .update(nonce).digest("hex");
    socket.write(JSON.stringify({ runtimeNonce: nonce, runtimeProof }) + "\n");
  });
  socket.on("data", () => socket.end());
  socket.on("error", () => process.exit(2));
};
prove();
setInterval(() => {}, 60_000);
`;

const waitForPath = async (path: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
};

/** Bootstraps a Hermes CEO whose runtime started in `ids.startSecond` and proved inside it. */
const bootstrapInsideStartSecond = async () => {
  const clock = new ManualClock(ids.rowWritten);
  const harness: Harness = makeHarness({ clock });
  const stateDir = tempDir("hb-start-second-");
  const pidPath = join(stateDir, "runtime.pid");
  const gatePath = join(stateDir, "prove");
  const authority = createHermesBootstrapAuthority(harness.cp, {
    stateDir,
    mcpSocketPath: join(stateDir, "hermes.mcp.sock"),
    mcpToken: "start-second-deployment-mcp-token",
    runtimeTimeoutMs: 5_000,
  });
  const pending = authority.bootstrap({
    command: [process.execPath, "-e", LIVE_RUNTIME, pidPath, gatePath],
    hermesExecutable: "/opt/hermes/bin/hermes", hermesProfile: "ceo-profile", hermesHome: "/opt/hermes/home",
    requestedSessionId: "hermes-ceo-session", expectedLineageRootDigest: digestOf({ root: "ceo" }),
    executorRuntimeIdentity: "acp-runtime:ceo",
  });
  await waitForPath(pidPath);
  const pid = Number(readFileSync(pidPath, "utf8"));
  runtimes.push(pid);
  ids.native.set(pid, STARTED_TOKEN);
  ids.lstart.set(pid, ids.lstartOf(ids.startSecond));
  writeFileSync(gatePath, "prove\n");
  const result = await pending;
  if (!result.allowed) throw new Error(result.message);
  const binding = harness.cp.bindings.active(CEO_ROLE_KEY);
  if (binding === null) throw new Error("no CEO binding after bootstrap");
  const session = harness.cp.sessions.require(binding.sessionId);
  // The premise: the row was written inside the second the runtime started.
  expect(session).toMatchObject({ osPid: pid, createdAt: ids.rowWritten, osProcessStartedAt: ids.lstartOf(ids.startSecond) });
  expect(harness.cp.capacity.current("hermes")).toBeNull();
  const daemon = new Daemon(harness.cp, { stateDir: join(stateDir, "daemon") });
  return { harness, clock, authority, daemon, pid, binding, session };
};

describe("a Hermes CEO proved inside its own start second", () => {
  it("is pinned at bootstrap and kept through an unread provider past the hold window", async () => {
    const fixture = await bootstrapInsideStartSecond();
    try {
      await fixture.daemon.reconcileContinuity("no hermes reading, runtime proved in its start second");
      fixture.clock.advance(COVERAGE_REVOCATION_GRACE_MS + 1_000);
      await fixture.daemon.reconcileContinuity("still no hermes reading, past the hold window");

      expect(fixture.harness.cp.bindings.active(CEO_ROLE_KEY)).toEqual(fixture.binding);
      expect(fixture.harness.cp.sessions.pinnedNativeStart(fixture.session.sessionId)).toBe(STARTED_TOKEN);
    } finally {
      await fixture.authority.close();
      fixture.harness.cp.close();
    }
  });

  it.each([
    ["a later", `darwin-tv:${ids.startSecond}.900000`],
    ["an earlier", `darwin-tv:${ids.startSecond}.010000`],
  ])("does not keep %s process start on the pid inside the same second", async (_label, other) => {
    const fixture = await bootstrapInsideStartSecond();
    try {
      // Same pid, same lstart second, different incarnation.
      ids.native.set(fixture.pid, other);

      await fixture.daemon.reconcileContinuity("no hermes reading, another process on the pid");
      fixture.clock.advance(COVERAGE_REVOCATION_GRACE_MS + 1_000);
      await fixture.daemon.reconcileContinuity("still no hermes reading, past the hold window");

      expect(fixture.harness.cp.bindings.active(CEO_ROLE_KEY)?.sessionId).not.toBe(fixture.session.sessionId);
      // Refused against the pin, which still names the runtime the bootstrap started.
      expect(fixture.harness.cp.sessions.pinnedNativeStart(fixture.session.sessionId)).toBe(STARTED_TOKEN);
    } finally {
      await fixture.authority.close();
      fixture.harness.cp.close();
    }
  });
});
