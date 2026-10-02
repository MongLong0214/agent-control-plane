import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, mkdtempSync, mkdirSync, openSync, readSync, renameSync, rmSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import * as claim from "../../src/registry/canonical-self-claim.ts";

const CANON = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const START = "darwin-tv:1790893367.707157";
const PROC_START = "Thu Oct  1 22:22:47 2026";
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

const fileOps = (overrides: Partial<claim.HostSessionRegistryFileOps> = {}): claim.HostSessionRegistryFileOps => ({
  open: openSync, fstat: fstatSync, read: readSync, close: closeSync, ...overrides,
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
        const stat = fstatSync(fd);
        if (!firstStat) return stat;
        firstStat = false;
        return Object.assign(Object.create(stat) as Stats, { isFile: () => false });
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
        return Object.assign(Object.create(fstatSync(fd)) as Stats, { size: 65537 });
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
        const stat = fstatSync(fd);
        if (!firstStat) return stat;
        firstStat = false;
        return Object.assign(Object.create(stat) as Stats, { uid: uid + 1 });
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
    const { reader } = fixture({ pid: 10, procStart: PROC_START, sessionId: CANON.toUpperCase(), kind: "interactive" });
    expect(derive(["claude"], reader)).toMatchObject({
      allowed: true, value: { sessionUuid: CANON, sessionSource: "host-session-registry" },
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

  it("does not treat an invalid registry as a disagreement with valid argv", () => {
    const reader: claim.HostSessionRegistryReader = {
      read: () => deny(ReasonCode.INVALID_ARGUMENT, "invalid registry entry"),
    };
    expect(derive(["claude", "--resume", CANON], reader)).toMatchObject({
      allowed: true, value: { sessionUuid: CANON, sessionSource: "argv" },
    });
  });

});
