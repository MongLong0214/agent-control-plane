import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getPeerCredentials } from "../../src/core/peercred.ts";
import {
  CANONICAL_SELF_CLAIM_SOCKET_FILENAME,
  startAdoptedCeoToolListener,
  startCanonicalCtoToolListener,
  startCanonicalSelfClaimListener,
  type CanonicalSelfClaimListener,
} from "../../src/daemon/canonical-self-claim-listener.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

// Keeps the real kernel-backed credential read; one test call at a time is made to fail, as it does for a peer that has gone.
vi.mock("../../src/core/peercred.ts", { spy: true });

/**
 * deploy136: while the daemon's event loop was held for minutes, callers gave up and closed their sockets. The daemon then
 * accepted a connection whose peer was already gone, refused it, and wrote the refusal to a socket nobody held. That write
 * failed with EPIPE on a socket with no error handler, and the daemon died on an unhandled error.
 */

const roots: string[] = [];
const listeners: CanonicalSelfClaimListener[] = [];
const root = (): string => {
  const dir = mkdtempSync(join("/tmp", "ascl-gone-"));
  roots.push(dir);
  return dir;
};
const uncaught: unknown[] = [];
const record = (error: unknown): void => void uncaught.push(error);

afterEach(async () => {
  process.off("uncaughtException", record);
  for (const listener of listeners.splice(0)) await listener.close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.mocked(getPeerCredentials).mockRestore();
  cleanupTempDirs();
});

/** A peer that connects and is gone (its descriptor closed) by the moment the daemon reads who it is. */
const peerGoneWhenIdentified = async (socketPath: string): Promise<void> => {
  process.on("uncaughtException", record);
  let peer: Socket | null = null;
  uncaught.length = 0;
  vi.mocked(getPeerCredentials).mockImplementationOnce(() => {
    // `destroy` closes the descriptor now, so the daemon's refusal below is written to a socket whose peer has closed.
    peer?.destroy();
    return null;
  });
  peer = createConnection(socketPath);
  peer.on("error", () => undefined);
  await new Promise((resolve) => setTimeout(resolve, 300));
};

describe("a peer that closed before the daemon refused it", () => {
  it("does not kill the daemon on the canonical self-claim socket", async () => {
    const dir = root();
    listeners.push(await startCanonicalSelfClaimListener({ lock: { held: () => true } }, dir, async () => allow(ReasonCode.OK, {})));
    await peerGoneWhenIdentified(join(dir, CANONICAL_SELF_CLAIM_SOCKET_FILENAME));
    expect(uncaught).toEqual([]);
  });

  it("does not kill the daemon on the adopted CEO tool socket", async () => {
    const dir = root();
    const listener = await startAdoptedCeoToolListener({ lock: { held: () => true } }, dir, async () => allow(ReasonCode.OK, {} as never), () => undefined);
    listeners.push(listener);
    await peerGoneWhenIdentified(listener.socketPath);
    expect(uncaught).toEqual([]);
  });

  it("does not kill the daemon on the canonical CTO reattach socket", async () => {
    const dir = root();
    const listener = await startCanonicalCtoToolListener(
      { lock: { held: () => true } },
      dir,
      async () => allow(ReasonCode.OK, {} as never),
      () => undefined,
    );
    listeners.push(listener);
    await peerGoneWhenIdentified(listener.socketPath);
    expect(uncaught).toEqual([]);
  });
});
