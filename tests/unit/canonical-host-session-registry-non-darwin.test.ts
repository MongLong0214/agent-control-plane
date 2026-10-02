import type * as NodeChildProcess from "node:child_process";
import type * as NodeFs from "node:fs";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import * as claim from "../../src/registry/canonical-self-claim.ts";

/**
 * #1035 review round 2 (ACP1034-R2-01). A Linux start token is clock ticks since boot, and placing
 * it on the wall clock meant reading `/proc`, running `getconf CLK_TCK` and then sampling the wall
 * clock — so subprocess latency moved the estimated start later and flipped a valid entry to
 * "created before". ACP deploys only on Darwin; the registry is now refused outright for any start
 * token that is not a native Darwin token, and nothing is estimated.
 *
 * The host here is simulated: `/proc/stat`, `/proc/uptime` and `getconf` answer as a Linux host
 * would, and `getconf` can advance the wall clock to stand for a slow probe. Every other read goes
 * to the real module, so the registry file and its birth time are real.
 */
const probes = vi.hoisted(() => ({
  calls: [] as string[],
  delayMs: 0,
  clockOffsetMs: 0,
  procStat: "",
  procUptime: "",
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    if (path === "/proc/stat") { probes.calls.push("/proc/stat"); return probes.procStat; }
    if (path === "/proc/uptime") { probes.calls.push("/proc/uptime"); return probes.procUptime; }
    return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  const execFileSync = ((file: unknown, ...rest: unknown[]) => {
    if (file === "getconf") {
      probes.calls.push("getconf");
      probes.clockOffsetMs += probes.delayMs;
      return "100\n";
    }
    return (actual.execFileSync as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.execFileSync;
  return { ...actual, default: { ...actual, execFileSync }, execFileSync };
});

const CANON = "11111111-1111-4111-8111-111111111111";
const CLK_TCK = 100n;
/** 367.70 s after boot, the reviewer's token. */
const TICKS = 36_770n;
const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  probes.calls.length = 0;
  probes.delayMs = 0;
  probes.clockOffsetMs = 0;
});

/** The host's whole-second `TZ=UTC` ctime rendering of a second since the epoch. */
const procStartOfSecond = (seconds: bigint): string => {
  const [weekday, day, month, year, clock] = new Date(Number(seconds) * 1_000)
    .toUTCString().replace(",", "").split(" ");
  return `${weekday} ${month} ${day!.replace(/^0/, " ")} ${clock} ${year}`;
};

/**
 * A registry entry that a Linux host would have judged valid: its file was created 200 ms after
 * the process really started, and its procStart is the btime-derived second that host renders.
 */
const linuxFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "acp-1034-registry-linux-"));
  tempDirs.push(root);
  const path = join(root, "10.json");
  writeFileSync(path, "{}");
  const createdNs = statSync(path, { bigint: true }).birthtimeNs;
  expect(createdNs).toBeGreaterThan(0n);
  const startNs = createdNs - 200_000_000n;
  const bootNs = startNs - (TICKS * 1_000_000_000n) / CLK_TCK;
  const nowMs = Number(createdNs / 1_000_000n) + 1_000;
  const uptimeNs = BigInt(nowMs) * 1_000_000n - bootNs;
  const centiseconds = uptimeNs / 10_000_000n;
  probes.procUptime = `${centiseconds / 100n}.${String(centiseconds % 100n).padStart(2, "0")} 1.00\n`;
  const bootSeconds = bootNs / 1_000_000_000n;
  probes.procStat = `cpu  1 2 3 4\nbtime ${bootSeconds}\n`;
  const procStart = procStartOfSecond(bootSeconds + TICKS / CLK_TCK);
  writeFileSync(path, JSON.stringify({ pid: 10, procStart, sessionId: CANON, kind: "interactive" }));
  expect(statSync(path, { bigint: true }).birthtimeNs).toBe(createdNs);
  vi.spyOn(Date, "now").mockImplementation(() => nowMs + probes.clockOffsetMs);
  return { root, path, reader: claim.makeDefaultHostSessionRegistryReader(root) };
};

const inspector = (argv: string[]) => ({
  snapshot: (pid: number) => pid === 10 ? {
    pid: 10, ppid: 1, argv, command: argv.join(" "), cwd: "/work", cwdProbeFailure: null,
    startedAt: `linux-clk:${TICKS}`,
  } : null,
});

const derive = (argv: string[], reader: claim.HostSessionRegistryReader) =>
  claim.deriveClaimantIdentity(10, inspector(argv), 8, reader);

describe("the host session registry under a non-Darwin start token", () => {
  it("refuses a linux-clk registry entry under --continue and under a matching argv selector, consulting neither /proc nor getconf", () => {
    const { reader } = linuxFixture();
    for (const argv of [["claude", "--continue"], ["claude", "--resume", CANON], ["claude", `--session-id=${CANON}`]]) {
      expect(derive(argv, reader), argv.join(" ")).toMatchObject({
        allowed: false, reasonCode: ReasonCode.PROBE_FAILED, message: expect.stringContaining("not a native Darwin start token"),
      });
    }
    expect(probes.calls).toEqual([]);
  });

  it("a delayed Linux probe cannot flip a linux-clk entry: it is refused the same way with and without a 500 ms delay", () => {
    const { reader } = linuxFixture();
    const prompt = derive(["claude", "--continue"], reader);
    probes.clockOffsetMs = 0;
    probes.delayMs = 500;
    const delayed = derive(["claude", "--continue"], reader);
    expect(prompt).toMatchObject({ allowed: false, reasonCode: ReasonCode.PROBE_FAILED });
    expect(delayed).toEqual(prompt);
    expect(probes.calls).toEqual([]);
  });

  it("the delegated CTO verifier refuses a linux-clk registry entry under a valid argv selector", () => {
    const { reader } = linuxFixture();
    const checked = claim.verifyClaudeIdentity(
      { canonicalSessionUuids: [CANON] },
      { callerPid: 10, claimedPid: 10, claimedSessionUuid: CANON },
      {
        processInspector: inspector(["claude", "--session-id", CANON]),
        imageInspector: { resolve: () => ({ imagePath: "/fake/versions/current/claude", version: "0.0.0-test", sha256: `sha256:${"0".repeat(64)}` }) },
        transcriptReader: { locate: (sessionUuid) => ({ path: `/fake/transcripts/${sessionUuid}.jsonl`, sizeBytes: 42 }) },
        hostSessionRegistryReader: reader,
      },
    );
    expect(checked, JSON.stringify(checked)).toMatchObject({
      allowed: false, reasonCode: ReasonCode.PROBE_FAILED, message: expect.stringContaining("not a native Darwin start token"),
    });
  });

  it("leaves argv-only identity under a linux-clk token unchanged when no registry file exists", () => {
    const { path, reader } = linuxFixture();
    rmSync(path);
    expect(derive(["claude", "--resume", CANON], reader)).toMatchObject({
      allowed: true, value: { sessionUuid: CANON, sessionSource: "argv" },
    });
    expect(probes.calls).toEqual([]);
  });
});
