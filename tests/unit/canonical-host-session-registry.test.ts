import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, mkdtempSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "../../src/core/clock.ts";
import { deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import * as claim from "../../src/registry/canonical-self-claim.ts";

const CANON = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const START = "darwin-tv:1790893367.707157";
const PROC_START = "Thu Oct  1 22:22:47 2026";
const HEX_LETTER_UUID = "abcdef12-3456-4789-8abc-def012345678";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const inspector = (argv: string[], startedAt: string | null = START) => ({
  snapshot: (pid: number) => pid === 10 ? {
    pid: 10, ppid: 1, argv, command: argv.join(" "), cwd: "/work", cwdProbeFailure: null, startedAt,
  } : null,
});

const fixture = (entry: unknown = { pid: 10, procStart: PROC_START, sessionId: CANON, kind: "interactive" }) => {
  const root = mkdtempSync(join(tmpdir(), "acp-1034-registry-"));
  tempDirs.push(root);
  const path = join(root, "10.json");
  writeFileSync(path, JSON.stringify(entry));
  return { root, path, reader: claim.makeDefaultHostSessionRegistryReader(root) };
};

const derive = (argv: string[], reader: claim.HostSessionRegistryReader, startedAt: string | null = START) =>
  claim.deriveClaimantIdentity(10, inspector(argv, startedAt), 8, reader);

/** The timestamp the reader treats as the file's creation: its native birth time, nothing else. */
const registryCreationNs = (path: string): bigint => statSync(path, { bigint: true }).birthtimeNs;
const darwinToken = (ns: bigint): string =>
  `darwin-tv:${ns / 1_000_000_000n}.${String((ns % 1_000_000_000n) / 1_000n).padStart(6, "0")}`;
/** The host's whole-second `TZ=UTC` ctime rendering of the second containing `ns`. */
const procStartOf = (ns: bigint): string => {
  const [weekday, day, month, year, clock] = new Date(Number(ns / 1_000_000_000n) * 1_000)
    .toUTCString().replace(",", "").split(" ");
  return `${weekday} ${month} ${day!.replace(/^0/, " ")} ${clock} ${year}`;
};

const statFd = (fd: number): BigIntStats => fstatSync(fd, { bigint: true });

const fileOps = (overrides: Partial<claim.HostSessionRegistryFileOps> = {}): claim.HostSessionRegistryFileOps => ({
  open: openSync, fstat: statFd, read: readSync, close: closeSync, ...overrides,
});

describe("canonical host session registry derivation", () => {
  it("allows --continue with a valid registry and records its source", () => {
    const { reader } = fixture();
    expect(derive(["claude", "--continue"], reader)).toMatchObject({
      allowed: true, value: { sessionUuid: CANON, sessionSource: "host-session-registry" },
    });
  });

  it("refuses a registry whose pid differs from the ancestor", () => {
    const { reader } = fixture({ pid: 11, procStart: PROC_START, sessionId: CANON, kind: "interactive" });
    expect(derive(["claude"], reader)).toMatchObject({ allowed: false, message: expect.stringContaining("pid") });
  });

  it("refuses a registry whose procStart is one second stale", () => {
    const { reader } = fixture({ pid: 10, procStart: "Thu Oct  1 22:22:46 2026", sessionId: CANON, kind: "interactive" });
    expect(derive(["claude"], reader)).toMatchObject({ allowed: false, message: expect.stringContaining("procStart") });
  });

  it("refuses a null process start token", () => {
    const { reader } = fixture();
    expect(derive(["claude"], reader, null)).toMatchObject({
      allowed: false, message: expect.stringContaining("start token"),
    });
  });

  it("refuses an unparseable process start token", () => {
    const { reader } = fixture();
    expect(derive(["claude"], reader, "t1")).toMatchObject({
      allowed: false, message: expect.stringContaining("start token"),
    });
  });

  it("refuses a symlinked registry file", () => {
    const { root, path, reader } = fixture();
    const target = join(root, "target.json");
    writeFileSync(target, JSON.stringify({ pid: 10, procStart: PROC_START, sessionId: CANON, kind: "interactive" }));
    rmSync(path);
    symlinkSync(target, path);
    expect(derive(["claude"], reader)).toMatchObject({ allowed: false, message: expect.stringContaining("symlink") });
  });

  it("opens the registry with O_RDONLY and O_NOFOLLOW and refuses a symlink swapped in at open", () => {
    const { root, path } = fixture();
    const target = join(root, "target.json");
    writeFileSync(target, JSON.stringify({ pid: 10, procStart: PROC_START, sessionId: CANON, kind: "interactive" }));
    const flags: number[] = [];
    let firstOpen = true;
    const reader = claim.makeDefaultHostSessionRegistryReader(root, fileOps({
      open(file, mode) {
        flags.push(mode);
        if (firstOpen) {
          rmSync(path);
          symlinkSync(target, path);
          firstOpen = false;
        }
        return openSync(file, mode);
      },
      read(fd, buffer, offset, length, position) {
        // If the first open follows the link, put that same inode at the checked path before
        // the second open. Only O_NOFOLLOW at the first open can refuse this replacement.
        renameSync(target, path);
        return readSync(fd, buffer, offset, length, position);
      },
    }));
    expect(derive(["claude", "--continue"], reader).allowed).toBe(false);
    expect(flags).toEqual([claim.HOST_SESSION_REGISTRY_OPEN_FLAGS]);
    expect(flags[0]! & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(flags[0]! & (constants.O_WRONLY | constants.O_RDWR)).toBe(0);
  });

  it("refuses a regular registry path replaced while its opened fd is read", () => {
    const { root, path } = fixture();
    const replacement = join(root, "replacement.json");
    writeFileSync(replacement, JSON.stringify({ pid: 10, procStart: PROC_START, sessionId: OTHER, kind: "interactive" }));
    let replaced = false;
    const reader = claim.makeDefaultHostSessionRegistryReader(root, fileOps({
      read(fd, buffer, offset, length, position) {
        if (!replaced) {
          renameSync(replacement, path);
          replaced = true;
        }
        return readSync(fd, buffer, offset, length, position);
      },
    }));
    expect(derive(["claude", "--continue"], reader)).toMatchObject({
      allowed: false, message: expect.stringContaining("changed"),
    });
    expect(replaced).toBe(true);
  });

  it("refuses a non-regular registry file", () => {
    const { path, reader } = fixture();
    rmSync(path);
    mkdirSync(path);
    expect(derive(["claude"], reader)).toMatchObject({ allowed: false, message: expect.stringContaining("regular") });
  });

  it("refuses a descriptor whose fstat says it is not regular", () => {
    const { root } = fixture();
    let firstStat = true;
    const reader = claim.makeDefaultHostSessionRegistryReader(root, fileOps({
      fstat(fd) {
        const stat = statFd(fd);
        if (!firstStat) return stat;
        firstStat = false;
        return Object.assign(Object.create(stat) as BigIntStats, { isFile: () => false });
      },
    }));
    expect(derive(["claude"], reader)).toMatchObject({ allowed: false, message: expect.stringContaining("regular") });
  });

  it("refuses an oversized registry file", () => {
    const { path, reader } = fixture();
    const entry = JSON.stringify({ pid: 10, procStart: PROC_START, sessionId: CANON, kind: "interactive" });
    writeFileSync(path, entry.padEnd(65537, " "));
    expect(derive(["claude"], reader)).toMatchObject({ allowed: false, message: expect.stringContaining("size") });
  });

  it("refuses an opened descriptor whose fstat size exceeds the bound", () => {
    const { root } = fixture();
    const reader = claim.makeDefaultHostSessionRegistryReader(root, fileOps({
      fstat(fd) {
        return Object.assign(Object.create(statFd(fd)) as BigIntStats, { size: 65537n });
      },
    }));
    expect(derive(["claude"], reader)).toMatchObject({ allowed: false, message: expect.stringContaining("size") });
  });

  it("refuses malformed registry JSON", () => {
    const { path, reader } = fixture();
    writeFileSync(path, "{");
    expect(derive(["claude"], reader)).toMatchObject({ allowed: false, message: expect.stringContaining("JSON") });
  });

  it("refuses registry JSON that is not an object", () => {
    const { reader } = fixture(null);
    expect(derive(["claude"], reader)).toMatchObject({ allowed: false, message: expect.stringContaining("object") });
  });

  it("refuses a registry file owned by another uid", () => {
    const { reader } = fixture();
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("this test requires a POSIX uid");
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      expect(derive(["claude"], reader)).toMatchObject({
        allowed: false, message: expect.stringContaining("daemon uid"),
      });
    } finally {
      getuid.mockRestore();
    }
  });

  it("refuses an opened descriptor whose fstat uid differs from the daemon", () => {
    const { root } = fixture();
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("this test requires a POSIX uid");
    let firstStat = true;
    const reader = claim.makeDefaultHostSessionRegistryReader(root, fileOps({
      fstat(fd) {
        const stat = statFd(fd);
        if (!firstStat) return stat;
        firstStat = false;
        return Object.assign(Object.create(stat) as BigIntStats, { uid: BigInt(uid + 1) });
      },
    }));
    expect(derive(["claude"], reader)).toMatchObject({ allowed: false, message: expect.stringContaining("daemon uid") });
  });

  it("refuses a registry when the ancestor kernel start token changes during its read", () => {
    const { root } = fixture();
    let fileWasRead = false;
    const reader = claim.makeDefaultHostSessionRegistryReader(root, fileOps({
      read(fd, buffer, offset, length, position) {
        fileWasRead = true;
        return readSync(fd, buffer, offset, length, position);
      },
    }));
    let rereads = 0;
    const changingInspector = {
      snapshot: inspector(["claude", "--continue"]).snapshot,
      readStartToken: (pid: number) => {
        expect(pid).toBe(10);
        expect(fileWasRead).toBe(true);
        rereads += 1;
        return "darwin-tv:1790893368.707157";
      },
    };
    expect(claim.deriveClaimantIdentity(10, changingInspector, 8, reader)).toMatchObject({
      allowed: false, message: expect.stringContaining("start token changed"),
    });
    expect(rereads).toBe(1);
  });

  it("refuses a non-UUID registry sessionId", () => {
    const { reader } = fixture({ pid: 10, procStart: PROC_START, sessionId: ` ${CANON}`, kind: "interactive" });
    expect(derive(["claude"], reader)).toMatchObject({ allowed: false, message: expect.stringContaining("sessionId") });
  });

  it("refuses a print-kind registry entry", () => {
    const { reader } = fixture({ pid: 10, procStart: PROC_START, sessionId: CANON, kind: "print" });
    expect(derive(["claude"], reader)).toMatchObject({ allowed: false, message: expect.stringContaining("kind") });
  });

  it("refuses disagreement between an argv selector and a valid registry", () => {
    const { reader } = fixture({ pid: 10, procStart: PROC_START, sessionId: OTHER, kind: "interactive" });
    expect(derive(["claude", "--resume", CANON], reader)).toMatchObject({
      allowed: false, message: expect.stringContaining("disagree"),
    });
  });

  it("allows a matching argv selector and registry with argv source", () => {
    const { reader } = fixture();
    expect(derive(["claude", "--resume", CANON], reader)).toMatchObject({
      allowed: true, value: { sessionUuid: CANON, sessionSource: "argv" },
    });
  });

  it("allows an argv selector when the registry file is absent", () => {
    const { path, reader } = fixture();
    rmSync(path);
    expect(derive(["claude", "--resume", CANON], reader)).toMatchObject({
      allowed: true, value: { sessionUuid: CANON, sessionSource: "argv" },
    });
  });

  it("names the checked registry path when no selector and no file exist", () => {
    const { path, reader } = fixture();
    rmSync(path);
    const derived = derive(["claude", "--continue"], reader);
    expect(derived).toMatchObject({ allowed: false, reasonCode: ReasonCode.NOT_FOUND, message: expect.stringContaining(path) });
    expect(derived).toMatchObject({ message: expect.stringContaining("names no session id") });
  });

  it("does not use the registry for a malformed or duplicate selector", () => {
    const { reader } = fixture();
    for (const argv of [["claude", "--resume="], ["claude", "--resume", CANON, "--session-id", CANON]]) {
      expect(derive(argv, reader)).toMatchObject({ allowed: false, message: expect.stringContaining("argv") });
    }
  });

  it("lowercases only a valid derived registry UUID", () => {
    // Hex letters, so the upper-case spelling differs from the lower-case one; an all-digit UUID
    // is its own upper case and could not tell a lowercasing reader from one that does nothing.
    expect(HEX_LETTER_UUID.toUpperCase()).not.toBe(HEX_LETTER_UUID);
    const { reader } = fixture({ pid: 10, procStart: PROC_START, sessionId: HEX_LETTER_UUID.toUpperCase(), kind: "interactive" });
    expect(derive(["claude"], reader)).toMatchObject({
      allowed: true, value: { sessionUuid: HEX_LETTER_UUID, sessionSource: "host-session-registry" },
    });
  });

  it("refuses a registry entry with kind omitted", () => {
    const { reader } = fixture({ pid: 10, procStart: PROC_START, sessionId: CANON });
    expect(derive(["claude"], reader)).toMatchObject({ allowed: false, message: expect.stringContaining("kind") });
  });

  it("opens the registry non-blocking so a FIFO planted at its path cannot stall the open", () => {
    const { root } = fixture();
    const flags: number[] = [];
    const reader = claim.makeDefaultHostSessionRegistryReader(root, fileOps({
      open(file, mode) {
        flags.push(mode);
        return openSync(file, mode);
      },
    }));
    expect(derive(["claude", "--continue"], reader).allowed).toBe(true);
    expect(flags.length).toBeGreaterThan(0);
    for (const mode of flags) expect(mode & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
  });

  it("refuses a FIFO at the registry path without blocking the open", () => {
    const { path, reader } = fixture();
    rmSync(path);
    execFileSync("mkfifo", [path], { timeout: 5_000 });
    expect(derive(["claude", "--continue"], reader)).toMatchObject({
      allowed: false, message: expect.stringContaining("regular"),
    });
  }, 10_000);

  it("refuses a valid argv selector when the registry entry fails verification", () => {
    const reader: claim.HostSessionRegistryReader = {
      read: () => deny(ReasonCode.INVALID_ARGUMENT, "invalid registry entry"),
    };
    expect(derive(["claude", "--resume", CANON], reader)).toMatchObject({
      allowed: false, reasonCode: ReasonCode.INVALID_ARGUMENT, message: expect.stringContaining("invalid registry entry"),
    });
  });

  it("names the missing selector, not the argv refusal, for an unverifiable registry without a selector", () => {
    const reader: claim.HostSessionRegistryReader = {
      read: () => deny(ReasonCode.INVALID_ARGUMENT, "invalid registry entry"),
    };
    const derived = derive(["claude", "--continue"], reader);
    expect(derived).toMatchObject({ allowed: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
    expect(derived).toMatchObject({ message: expect.stringContaining("names no session id") });
    expect(derived).not.toMatchObject({ message: expect.stringContaining("argv selector is not accepted") });
  });

  it("refuses a registry file whose birth time the kernel does not report, with no ctime fallback", () => {
    const { root } = fixture();
    // The real ctime is kept and is after the ancestor's start: only the missing birth time refuses.
    const reader = claim.makeDefaultHostSessionRegistryReader(root, fileOps({
      fstat(fd) {
        return Object.assign(Object.create(statFd(fd)) as BigIntStats, { birthtimeNs: 0n });
      },
    }));
    expect(derive(["claude", "--continue"], reader)).toMatchObject({
      allowed: false, reasonCode: ReasonCode.PROBE_FAILED, message: expect.stringContaining("creation time"),
    });
    expect(derive(["claude", "--resume", CANON], reader)).toMatchObject({
      allowed: false, reasonCode: ReasonCode.PROBE_FAILED, message: expect.stringContaining("creation time"),
    });
  });

  it("refuses a valid argv selector when the registry path is replaced while its opened fd is read", () => {
    const { root, path } = fixture();
    const replacement = join(root, "replacement.json");
    let replaced = false;
    const reader = claim.makeDefaultHostSessionRegistryReader(root, fileOps({
      read(fd, buffer, offset, length, position) {
        if (!replaced) {
          renameSync(replacement, path);
          replaced = true;
        }
        return readSync(fd, buffer, offset, length, position);
      },
    }));
    // Both argv selector forms name the same session the replacement does, so only the detected
    // replacement can refuse: a disagreement check has nothing to disagree with.
    for (const argv of [["claude", "--resume", CANON], ["claude", `--session-id=${CANON}`]]) {
      replaced = false;
      writeFileSync(replacement, JSON.stringify({ pid: 10, procStart: PROC_START, sessionId: CANON, kind: "interactive" }));
      expect(derive(argv, reader)).toMatchObject({
        allowed: false, reasonCode: ReasonCode.PROBE_FAILED, message: expect.stringContaining("changed"),
      });
      expect(replaced).toBe(true);
    }
  });

  it("refuses a registry file created before the ancestor's native start token within the same procStart second", () => {
    const { path, reader } = fixture();
    const createdNs = registryCreationNs(path);
    // A stale entry left at a reused pid: its file existed half a second before this process
    // instance started, and the whole-second procStart cannot tell the two instances apart.
    const startNs = createdNs + 500_000_000n;
    writeFileSync(path, JSON.stringify({ pid: 10, procStart: procStartOf(startNs), sessionId: CANON, kind: "interactive" }));
    expect(registryCreationNs(path)).toBe(createdNs);
    expect(derive(["claude", "--continue"], reader, darwinToken(startNs))).toMatchObject({
      allowed: false, reasonCode: ReasonCode.CONFLICT, message: expect.stringContaining("created before"),
    });
  });

  it("admits a registry file created after the ancestor's native start token within the same procStart second", () => {
    const { path, reader } = fixture();
    const createdNs = registryCreationNs(path);
    const startNs = createdNs - 500_000_000n;
    writeFileSync(path, JSON.stringify({ pid: 10, procStart: procStartOf(startNs), sessionId: CANON, kind: "interactive" }));
    expect(registryCreationNs(path)).toBe(createdNs);
    expect(derive(["claude", "--continue"], reader, darwinToken(startNs))).toMatchObject({
      allowed: true, value: { sessionUuid: CANON, sessionSource: "host-session-registry" },
    });
  });

  /**
   * A birth time later than the wall clock at the check means the clock stepped backward after
   * the file was written; a stale file from before the step could otherwise land after the new
   * process's start token. The clock is injected so the step is reproduced, not waited for.
   */
  const futureFixture = (clockOffsetMs: number) => {
    const { root, path } = fixture();
    const createdNs = registryCreationNs(path);
    const startNs = createdNs - 500_000_000n;
    writeFileSync(path, JSON.stringify({ pid: 10, procStart: procStartOf(startNs), sessionId: CANON, kind: "interactive" }));
    expect(registryCreationNs(path)).toBe(createdNs);
    const clock = new ManualClock(Number(createdNs / 1_000_000n) + clockOffsetMs);
    return { reader: claim.makeDefaultHostSessionRegistryReader(root, fileOps(), clock), token: darwinToken(startNs) };
  };

  it("refuses a registry file whose birth time is 0.5 s later than the injected wall clock, even under a matching argv selector", () => {
    const { reader, token } = futureFixture(-500);
    for (const argv of [["claude", "--continue"], ["claude", "--resume", CANON]]) {
      expect(derive(argv, reader, token)).toMatchObject({
        allowed: false, reasonCode: ReasonCode.PROBE_FAILED, message: expect.stringContaining("after the current wall clock"),
      });
    }
  });

  it("admits a registry file whose birth time is 0.5 s earlier than the injected wall clock", () => {
    const { reader, token } = futureFixture(500);
    expect(derive(["claude", "--continue"], reader, token)).toMatchObject({
      allowed: true, value: { sessionUuid: CANON, sessionSource: "host-session-registry" },
    });
  });
});
