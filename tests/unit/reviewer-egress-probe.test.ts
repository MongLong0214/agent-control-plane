import { createServer, type Socket } from "node:net";

import { afterAll, describe, expect, it } from "vitest";

import { __testing } from "../../src/runtime/cli-adapters.ts";
import type { ReviewerEgressLease } from "../../src/runtime/reviewer-egress.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * The provider-only network proof must fail when the provider is not actually reachable.
 *
 * #419 asks for "a positive provider-reachability proof". The mechanism was built — the probe
 * opens a CONNECT through the confined proxy and requires 200 — but nothing checked that it
 * ran: replacing `allowedEndpoint` with a hardcoded `{ connected: true, statusCode: 200 }`
 * left all 818 tests passing. That is the third instance today of an enforcement present in
 * the code and absent from the evidence.
 *
 * So these drive the real probe against a real proxy whose answers are chosen by the test.
 * A proxy that refuses the allowlisted host must not yield an enforced verdict, however
 * plausible the rest of the profile looks.
 */
const PROVIDER = "api.anthropic.com";

/** A CONNECT proxy that answers every tunnel request with `status`. */
const startProxy = async (
  status: number,
): Promise<{ port: number; stop: () => void }> => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("data", () => {
      socket.write(
        `HTTP/1.1 ${status} ${status === 200 ? "Connection Established" : "Forbidden"}\r\n\r\n`,
      );
      if (status !== 200) socket.end();
    });
    socket.on("close", () => sockets.delete(socket));
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  // Destroying live tunnels explicitly: close() alone waits on them and hangs the test.
  return {
    port,
    stop: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
};

const leaseOver = (port: number): ReviewerEgressLease => ({
  profilePath: "/dev/null",
  profileText: "(version 1)\n(allow default)\n",
  proxyUrl: `http://127.0.0.1:${port}`,
  port,
  provider: "claude",
  allowedEndpoints: [PROVIDER],
  died: () => false,
  onDeath: () => () => undefined,
  finalise: async () => {
    throw new Error("finalise is not part of this probe");
  },
  abandon: async () => undefined,
});

const runProbe = async (port: number) =>
  __testing.probeProviderOnlyNetwork(
    "(version 1)\n(allow default)\n",
    tempDir("egress-probe"),
    { ...process.env },
    15_000,
    leaseOver(port),
    undefined,
  );

describe("the provider-only egress proof requires the provider to answer (#419)", () => {
  it("refuses to attest when the proxy will not open the allowlisted host", async () => {
    // The case the hardcoded probe hid: the confinement is in place and the provider is
    // unreachable through it. That is not isolation achieved, it is a reviewer that cannot
    // work — and it must not attest.
    const { port, stop } = await startProxy(403);
    try {
      const result = await runProbe(port);
      expect(result.enforced).toBe(false);
      if (!result.enforced) {
        expect(result.reason).toContain(PROVIDER);
      }
    } finally {
      stop();
    }
  }, 30_000);

  it("refuses to attest when nothing is listening on the egress port at all", async () => {
    // A lease whose proxy has gone. `died()` is false here on purpose: this asserts the probe
    // reaches its own conclusion rather than depending on the liveness flag to be correct.
    const { port, stop } = await startProxy(200);
    stop();
    const result = await runProbe(port);
    expect(result.enforced).toBe(false);
    // Asserting the reason, not just the verdict. With the positive probe faked, this still
    // reaches `enforced: false` — the denied-endpoint probe fails too, for its own reason —
    // so a bare verdict check would pass the very regression this file exists to catch.
    if (!result.enforced) {
      expect(result.reason).toContain(PROVIDER);
    }
  }, 30_000);
});
