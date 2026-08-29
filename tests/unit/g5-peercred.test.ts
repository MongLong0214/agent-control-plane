import { type ChildProcess, spawn } from "node:child_process";
import { createConnection, createServer, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { getPeerCredentials } from "../../src/core/peercred.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/u, "");
const clientHelper = join(repositoryRoot, "tests/helpers/peercred-client.ts");

/**
 * Scope, stated rather than left for a reader to infer: this drives `getPeerCredentials`
 * directly against real sockets this test itself opens. It does not go through `agentcpd`, the
 * real daemon assembly point where a connection is actually accepted in production — that is
 * correct and deliberate here, not an oversight. #539's acceptance makes a live call site (in
 * `agentcpd` or anywhere else) a RED mutant: `scripts/verify-peercred-is-unreachable.mjs` fails
 * the build if one exists. So there is, on purpose, no integration test exercising this through
 * the daemon; what this file proves is narrower — that the primitive itself is correct against a
 * real kernel socket — and that narrower claim is what these tests are limited to.
 *
 * Two Darwin cases, and they prove different things. The same-process pair below exercises the
 * addon's wiring (a real fd reaches `getsockopt`, the fd-range guard, the wraparound guard) but
 * both ends of that pair are this test process — an implementation that validated the socket and
 * then just returned `getpid()`/`geteuid()`/`getegid()` without calling into the kernel at all
 * would pass every assertion there. That is the entire claim of the primitive — *is the peer on
 * this socket that process* — so it needs a peer that is provably a different process: the
 * second case spawns a real child and asserts the credentials name *it*, not the test runner.
 */

/**
 * Node exposes no public API for a socket's raw fd. `_handle.fd` is the same field Node's own
 * core test suite reads for exactly this reason — there is no other way to hand a real kernel fd
 * to `getsockopt`. A synthesized fd or a mocked syscall would not exercise the addon's actual
 * system call at all, which is the thing #539 is meant to prove works.
 */
const rawFd = (socket: Socket): number => {
  const handle = (socket as unknown as { _handle: { fd: number } | null })._handle;
  if (handle === null || typeof handle.fd !== "number") {
    throw new Error("socket has no native handle — cannot read its fd");
  }
  return handle.fd;
};

/**
 * A real, connected `AF_UNIX` socket pair: a Unix-domain server and a client dialed into it in
 * this same process. Resolves with the server-side accepted socket, which is the "peer" this
 * process's own credentials should describe.
 */
const connectedUnixPair = (socketPath: string): Promise<{ accepted: Socket; cleanup: () => void }> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.once("connection", (accepted) => {
      resolve({
        accepted,
        cleanup: () => {
          accepted.destroy();
          client.destroy();
          server.close();
          if (existsSync(socketPath)) unlinkSync(socketPath);
        },
      });
    });
    let client: Socket;
    server.listen(socketPath, () => {
      client = createConnection(socketPath);
      client.once("error", reject);
    });
  });

/**
 * A real, connected `AF_UNIX` socket pair whose client is a *separate OS process*: this test's
 * server accepts a connection dialed in by a spawned child (`tests/helpers/peercred-client.ts`),
 * so the "peer" the kernel records is provably not this test process. Resolves once the server
 * has accepted the connection and the child has confirmed it is connected, with the child's own
 * `pid` alongside so the test can assert the credentials name it specifically.
 */
const connectedUnixPairWithChildClient = (
  socketPath: string,
): Promise<{ accepted: Socket; childPid: number; cleanup: () => void }> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);

    let child: ChildProcess | undefined;
    let accepted: Socket | undefined;
    let childConnected = false;
    let settled = false;

    const maybeResolve = () => {
      if (settled || !accepted || !childConnected || child?.pid === undefined) return;
      settled = true;
      const acceptedSocket = accepted;
      const childProcess = child;
      resolve({
        accepted: acceptedSocket,
        childPid: childProcess.pid as number,
        cleanup: () => {
          acceptedSocket.destroy();
          childProcess.kill("SIGKILL");
          server.close();
          if (existsSync(socketPath)) unlinkSync(socketPath);
        },
      });
    };

    server.once("connection", (socket) => {
      accepted = socket;
      maybeResolve();
    });

    server.listen(socketPath, () => {
      const spawned = spawn(process.execPath, ["--import", "tsx", clientHelper, socketPath], {
        cwd: repositoryRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = spawned;
      spawned.once("error", reject);
      if (spawned.stdout === null) {
        reject(new Error("peercred-client child was spawned without a stdout pipe"));
        return;
      }
      spawned.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("peercred-client: connected")) {
          childConnected = true;
          maybeResolve();
        }
      });
    });
  });

describe("getPeerCredentials", () => {
  it("returns null for a negative or non-integer fd, on every platform", () => {
    expect(getPeerCredentials(-1)).toBeNull();
    expect(getPeerCredentials(1.5)).toBeNull();
    expect(getPeerCredentials(Number.NaN)).toBeNull();
  });

  it("returns null for a fd that is not a connected socket", () => {
    // A fd far outside the process's open range. On Darwin this fails the kernel call itself
    // (EBADF or similar), which the wrapper folds into the same null the other failure paths
    // produce — never a thrown surprise from a caller that just wants "not established".
    expect(getPeerCredentials(999_999)).toBeNull();
  });

  it("refuses a fd above int32 range rather than letting it wrap, on every platform", () => {
    // The addon reads fd with Napi::Number::Int32Value(), which is ECMAScript ToInt32 —
    // reduction mod 2^32, not a range check. `2**32 + 5` is a Number.isSafeInteger value that
    // would wrap to `5`, a small, possibly real fd. This must be refused before the addon ever
    // sees it, not merely "usually not a socket".
    expect(getPeerCredentials(2 ** 32 + 5)).toBeNull();
    expect(getPeerCredentials(0x7fffffff + 1)).toBeNull();
  });

  if (process.platform === "darwin") {
    it("wires a real fd to the kernel call and refuses fd wraparound", async () => {
      const dir = tempDir("g5-peercred-");
      const socketPath = join(dir, "peercred-test.sock");
      const { accepted, cleanup } = await connectedUnixPair(socketPath);
      try {
        const fd = rawFd(accepted);
        const credentials = getPeerCredentials(fd);
        expect(credentials).not.toBeNull();
        // Both ends of this pair are this same test process, so this only shows the addon's
        // wiring is intact (a real fd reaches getsockopt and comes back with something) — it
        // cannot show the result is the *peer's* identity rather than the caller's own, since
        // they are the same process here. That claim is what the child-process test below
        // proves; this test is scoped to wiring and to the wraparound guard below.
        expect(credentials?.peerPid).toBe(process.pid);
        expect(credentials?.effectivePid).toBe(process.pid);
        // xucred documents cr_uid as "effective user id", and cr_gid is literally defined as
        // cr_groups[0] off that same credential snapshot (<sys/ucred.h>) — the struct only ever
        // carries the effective identity, never the real one. Comparing against getuid/getgid
        // would happen to pass here (a plain test process has real === effective ids) while
        // asserting the wrong property; geteuid/getegid is what the struct actually returns.
        expect(credentials?.uid).toBe(process.geteuid?.());
        expect(credentials?.gid).toBe(process.getegid?.());

        // The wraparound this repository's own fd-range guard exists to close: without it,
        // `fd + 2**32` would reach the addon, ToInt32 would fold it right back down to `fd`,
        // and the caller would silently get this real socket's credentials back for a number
        // that looks nothing like a small fd. The guard must refuse it before that happens.
        const wrapped = fd + 2 ** 32;
        expect(getPeerCredentials(wrapped)).toBeNull();
      } finally {
        cleanup();
      }
    });

    it("reads a separate child process's own credentials, not the test runner's", async () => {
      const dir = tempDir("g5-peercred-child-");
      const socketPath = join(dir, "peercred-child-test.sock");
      const { accepted, childPid, cleanup } = await connectedUnixPairWithChildClient(socketPath);
      try {
        // If this ever equals process.pid, the child failed to spawn as a distinct process —
        // which would make the assertions below meaningless rather than merely weak.
        expect(childPid).not.toBe(process.pid);

        const fd = rawFd(accepted);
        const credentials = getPeerCredentials(fd);
        expect(credentials).not.toBeNull();
        // The one assertion the same-process test above cannot make: the kernel's record of the
        // peer names a pid that both differs from this test process and matches the specific
        // child that is actually on the other end of the wire. An implementation that merely
        // validated the fd and returned getpid()/geteuid()/getegid() would fail exactly here.
        expect(credentials?.peerPid).not.toBe(process.pid);
        expect(credentials?.peerPid).toBe(childPid);
        // No entitlement-checked proxy sits between the child and this socket, so its effective
        // identity is its own — distinct from peerPid only when one exists.
        expect(credentials?.effectivePid).toBe(childPid);
        // The child inherits this process's effective uid/gid (no setuid, no explicit override
        // in the spawn options), so its xucred-reported identity equals this process's own.
        expect(credentials?.uid).toBe(process.geteuid?.());
        expect(credentials?.gid).toBe(process.getegid?.());
      } finally {
        cleanup();
      }
    });
  } else {
    it("returns null on a non-Darwin platform without touching the native module", () => {
      // The addon is Darwin-only (LOCAL_PEERPID/LOCAL_PEEREPID/LOCAL_PEERCRED have no Linux
      // equivalent); this asserts the platform gate itself, not the kernel call, since CI's own
      // runner is macos-15 and this branch only exercises off that machine.
      expect(getPeerCredentials(0)).toBeNull();
    });
  }
});
