import { createConnection } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  startCanonicalSelfClaimListener,
  CANONICAL_SELF_CLAIM_METHOD,
  CANONICAL_SELF_CLAIM_SOCKET_FILENAME,
  MAX_SUN_PATH_BYTES,
  type AuthenticatedClaimPeer,
  type CanonicalSelfClaimListener,
} from "../../src/daemon/canonical-self-claim-listener.ts";
import { allow, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

/**
 * The claim socket's own request framing and dispatch, isolated from the claim it dispatches to.
 *
 * Every test here answers one question the census asks of this file (#833): which malformed
 * request shapes this listener refuses *before* a handler runs, and which of those refusals a
 * counterexample can distinguish from its neighbours. The handler is a recorder, not
 * `executeCanonicalSelfClaimOperator` — the property under test is that the handler is never
 * reached at all, and a real claim operator would answer a denial of its own that looks the same
 * on the wire once `publicClaimResponse` has stripped everything but the reason code. That
 * indistinguishability on the wire is the reason each test asserts the recorder's call count
 * rather than only the response.
 *
 * No spawned process and no database: the peer these tests present is this vitest worker
 * connecting to its own socket, which is a direct local peer at this daemon's own uid, so
 * `authenticateClaimPeer` admits it and every operand below is reached. The real-claimant
 * end-to-end coverage lives in `canonical-self-claim-listener-claim.test.ts`.
 */

const TEMP_BASE = "/tmp";
const SHORT_PREFIX = "asclrs-";

const roots: string[] = [];
const listeners: CanonicalSelfClaimListener[] = [];

afterEach(async () => {
  for (const listener of listeners.splice(0)) await listener.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  cleanupTempDirs();
});

/**
 * `/tmp` directly, never `os.tmpdir()`: on macOS `TMPDIR` is a long per-user sandboxed path that
 * leaves almost no margin before a joined `AF_UNIX` socket path exceeds Darwin's `sun_path`
 * limit. The margin is asserted rather than assumed, as in this feature's sibling test files.
 */
const tempRoot = (): string => {
  const dir = mkdtempSync(join(TEMP_BASE, SHORT_PREFIX));
  roots.push(dir);
  const socketPath = join(dir, CANONICAL_SELF_CLAIM_SOCKET_FILENAME);
  const bytes = Buffer.byteLength(socketPath, "utf8");
  if (bytes > MAX_SUN_PATH_BYTES) {
    throw new Error(
      `test fixture directory produces a socket path over the ${MAX_SUN_PATH_BYTES}-byte AF_UNIX ` +
        `sun_path limit (${bytes} bytes): ${socketPath}`,
    );
  }
  return dir;
};

interface Recorder {
  listener: CanonicalSelfClaimListener;
  calls: { peer: AuthenticatedClaimPeer; params: Record<string, unknown> }[];
}

/** A listener whose handler records every call and always allows, so reaching it is visible. */
const startRecordingListener = async (): Promise<Recorder> => {
  const calls: Recorder["calls"] = [];
  const listener = await startCanonicalSelfClaimListener(
    { lock: { held: () => true } },
    tempRoot(),
    async (peer, params) => {
      calls.push({ peer, params });
      return allow(ReasonCode.OK, { reached: true }) as Decision<unknown>;
    },
  );
  listeners.push(listener);
  return { listener, calls };
};

/**
 * One request line, one response line, on its own short budget.
 *
 * The budget is deliberately far below the file timeout: a mutation that removes one of the
 * shape guards below can leave a request with no answer at all, and a row that takes the whole
 * file budget to notice reports a timeout rather than a refusal.
 */
const sendRawLine = (socketPath: string, line: string): Promise<Decision<unknown>> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let received = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("the canonical self-claim socket sent no response line within 5s"));
    }, 5_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${line}\n`));
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (!received.includes("\n")) return;
      clearTimeout(timeout);
      socket.end();
      resolve(JSON.parse(received.trim()) as Decision<unknown>);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

const send = (socketPath: string, request: unknown): Promise<Decision<unknown>> =>
  sendRawLine(socketPath, JSON.stringify(request));

const expectInvalidArgument = (decision: Decision<unknown>): void => {
  expect(decision.allowed).toBe(false);
  if (decision.allowed) return;
  expect(decision.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
};

describe("the claim socket refuses a request line that is not a JSON object", () => {
  it("refuses a number request line as an invalid argument, never as an unrecognized method", async () => {
    const { listener, calls } = await startRecordingListener();
    // Without the `typeof value !== "object"` operand, `(42).method` is `undefined`, the method
    // check below refuses it, and the caller is told the *method* was wrong — a refusal that
    // names the wrong thing about a request that never had a method at all.
    expectInvalidArgument(await send(listener.socketPath, 42));
    expectInvalidArgument(await send(listener.socketPath, "actor.claimCanonicalCto"));
    expect(calls).toHaveLength(0);
  });

  it("refuses an array request line as an invalid argument, never as an unrecognized method", async () => {
    const { listener, calls } = await startRecordingListener();
    // `typeof [] === "object"`, so the operand beside this one cannot reach an array; without
    // `Array.isArray(value)` an array reaches the method check and is refused as a bad method.
    expectInvalidArgument(await send(listener.socketPath, [{ method: CANONICAL_SELF_CLAIM_METHOD }]));
    expect(calls).toHaveLength(0);
  });

  it("refuses a null request line rather than reading a method name off it", async () => {
    const { listener, calls } = await startRecordingListener();
    // `typeof null === "object"` and `Array.isArray(null)` is false, so neither operand beside
    // this one can catch `null`: without `!value` the next line reads `.method` off `null` and
    // the connection gets a thrown TypeError instead of a typed refusal.
    expectInvalidArgument(await send(listener.socketPath, null));
    expect(calls).toHaveLength(0);
  });
});

describe("the claim socket refuses params that are not a JSON object before the handler runs", () => {
  it("refuses a number params without ever calling the claim handler", async () => {
    const { listener, calls } = await startRecordingListener();
    expectInvalidArgument(
      await send(listener.socketPath, { method: CANONICAL_SELF_CLAIM_METHOD, params: 42 }),
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses an array params without ever calling the claim handler", async () => {
    const { listener, calls } = await startRecordingListener();
    expectInvalidArgument(
      await send(listener.socketPath, { method: CANONICAL_SELF_CLAIM_METHOD, params: [1, 2] }),
    );
    expect(calls).toHaveLength(0);
  });

  it("treats absent params as an empty object and reaches the handler", async () => {
    const { listener, calls } = await startRecordingListener();
    const decision = await send(listener.socketPath, { method: CANONICAL_SELF_CLAIM_METHOD });
    expect(decision.allowed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual({});
  });
});

describe("the claim socket's request-timeout budget is validated at construction", () => {
  /** Starts the listener and always closes whatever it got, so a surviving mutant cannot leak a handle. */
  const startWithTimeout = async (requestTimeoutMs: number): Promise<unknown> => {
    let started: CanonicalSelfClaimListener | null = null;
    let thrown: unknown = null;
    try {
      started = await startCanonicalSelfClaimListener(
        { lock: { held: () => true } },
        tempRoot(),
        async () => allow(ReasonCode.OK, {}) as Decision<unknown>,
        { requestTimeoutMs },
      );
    } catch (error) {
      thrown = error;
    }
    if (started) await started.close();
    return thrown;
  };

  it("refuses a fractional request timeout, which no comparison against zero can catch", async () => {
    // `1.5 <= 0` is false and `NaN <= 0` is false, so the operand beside this one admits both.
    expect(String(await startWithTimeout(1.5))).toContain("positive integer");
    expect(String(await startWithTimeout(Number.NaN))).toContain("positive integer");
  });

  it("refuses a zero and a negative request timeout, which an integer test admits", async () => {
    // `Number.isInteger(0)` and `Number.isInteger(-1)` are both true, so the operand beside this
    // one admits both: a zero budget times out every request the moment it is registered.
    expect(String(await startWithTimeout(0))).toContain("positive integer");
    expect(String(await startWithTimeout(-1))).toContain("positive integer");
  });
});
