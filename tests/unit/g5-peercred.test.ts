import { createConnection, createServer, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { getPeerCredentials } from "../../src/core/peercred.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

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

  if (process.platform === "darwin") {
    it("reads the real peer credentials off a connected AF_UNIX socket pair", async () => {
      const dir = tempDir("g5-peercred-");
      const socketPath = join(dir, "peercred-test.sock");
      const { accepted, cleanup } = await connectedUnixPair(socketPath);
      try {
        const fd = rawFd(accepted);
        const credentials = getPeerCredentials(fd);
        expect(credentials).not.toBeNull();
        // Both ends of this pair are this same test process, so the kernel's record of the
        // peer is this process's own identity — the one thing a synthesized fd could not prove.
        expect(credentials?.peerPid).toBe(process.pid);
        expect(credentials?.effectivePid).toBe(process.pid);
        expect(credentials?.uid).toBe(process.getuid?.());
        expect(credentials?.gid).toBe(process.getgid?.());
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
