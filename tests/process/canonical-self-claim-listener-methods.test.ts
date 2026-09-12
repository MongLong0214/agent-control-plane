import { createConnection, createServer } from "node:net";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { main as agentctlMain } from "../../src/cli/agentctl.ts";
import { OPERATOR_METHOD, type Daemon } from "../../src/daemon/daemon.ts";
import {
  assertDirectPeer,
  authenticateClaimCredentials,
  startCanonicalSelfClaimListener,
  CANONICAL_SELF_CLAIM_SOCKET_FILENAME,
  MAX_SUN_PATH_BYTES,
  type CanonicalSelfClaimHandler,
  type CanonicalSelfClaimListener,
} from "../../src/daemon/canonical-self-claim-listener.ts";
import { executeCanonicalSelfClaimOperator, type CanonicalSelfClaimOperatorDeps } from "../../src/daemon/canonical-self-claim-operator.ts";
import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import { allow, deny, type Decision } from "../../src/core/errors.ts";
import { getPeerCredentials } from "../../src/core/peercred.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { makeDefaultTranscriptReader } from "../../src/registry/canonical-self-claim.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeStartedOperator, TEST_OPERATOR_TOKEN, type Harness, type StartedOperator } from "../helpers/harness.ts";

// Spies on `node:fs` while keeping every real implementation by default (`{ spy: true }`) — only
// the fault-injection test below overrides `chmodSync`, and only for its own single call
// (`mockImplementationOnce`, restored immediately after). Every other test in this file, and every
// other `node:fs` call in this one, is untouched. Declared at module scope so vitest's own hoisting
// applies — inside a `describe` callback it would not run before the imports it needs to intercept.
vi.mock("node:fs", { spy: true });

// Same discipline as the `node:fs` spy above, for the one production seam that can force the
// listener's own credential check to deny: every call keeps the real, kernel-backed
// `getPeerCredentials` by default, and only the one test below overrides it once, restored
// immediately after.
vi.mock("../../src/core/peercred.ts", { spy: true });

/**
 * The two rejection directions `actor.claimCanonicalCto`'s method table requires (#760), plus the
 * mint method's explicit-boolean requirement and the pure `peerPid !== effectivePid`
 * counterexample below. None of these need a real spawned process — the property under test is
 * which method name a socket recognizes, or a pure function's own return value — so they live in
 * their own, lighter file, separate from `canonical-self-claim-listener-claim.test.ts`'s
 * real-process end-to-end tests. See that file's docstring for why the split itself matters here
 * (`vitest.config.ts`'s `pool: "forks"` comment).
 *
 * `startCanonicalSelfClaimListener` has nothing to do with load, the daemon, or the event loop
 * for its startup latency: a state directory long enough pushes the joined socket path past
 * Darwin's 104-byte `AF_UNIX` `sun_path` limit, `bind(2)` silently truncates it, and `listen()`'s
 * callback then runs real, irreversible work (`chmodSync`) against a path the kernel never
 * created — a throw with nothing downstream to catch it, so the promise never settles. Fixed at
 * the source (`canonical-self-claim-listener.ts`): a byte-length check before any bind, and the
 * `listen` callback's own body wrapped so a fault there rejects instead of hanging. This file's
 * fixture helper (`tempRoot`) verifies its own margin below instead of assuming a short prefix is
 * enough.
 */

const roots: string[] = [];
const claimListeners: CanonicalSelfClaimListener[] = [];
const startedOperators: StartedOperator[] = [];

afterEach(async () => {
  for (const listener of claimListeners.splice(0)) await listener.close();
  for (const started of startedOperators.splice(0)) await started.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  cleanupTempDirs();
});

/**
 * `/tmp` directly, never `os.tmpdir()`: on macOS, `TMPDIR` resolves to a long, per-user sandboxed
 * path (`/var/folders/<hash>/<hash>/T/`, itself 50+ bytes on some hosts) that leaves almost no
 * margin before a joined `AF_UNIX` socket path exceeds Darwin's 104-byte `sun_path` limit (#760).
 * `/tmp` is short and stable across hosts; the assertion below verifies the margin actually holds
 * for this file's one fixed socket filename rather than assuming a short prefix is enough on
 * every machine this ever runs on.
 */
const TEMP_BASE = "/tmp";
const SHORT_PREFIX = "ascl-";

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

let freshNonces = 0;
const TEST_SESSION_UUID = "99999999-9999-4999-8999-999999999999";
const BUZZ_ACTOR_ID = "buzz:canonical-cto";
const BUZZ_CHANNEL_ID = "channel:test-canonical";
const PEER_PROTOCOL = "acp.operator/v1";
const BUZZ_PURPOSE = "continuity:PRIMARY_CTO";
const TRIVIAL_HANDLER = async (): Promise<Decision<unknown>> =>
  ({ allowed: true, reasonCode: ReasonCode.OK, value: {} }) as unknown as Decision<unknown>;

const operatorRequest = (
  socketPath: string,
  token: string,
  request: Record<string, unknown>,
): Promise<Decision<unknown>> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let received = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("operator socket test timed out"));
    }, 20_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ requestId: `test-req-${freshNonces++}`, token, ...request })}\n`);
    });
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

const claimRequest = (socketPath: string, request: Record<string, unknown>): Promise<Decision<unknown>> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let received = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("canonical self-claim socket test timed out"));
    }, 20_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
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

/**
 * The exact wire bytes, never `JSON.parse`'d — a shape-only assertion on the parsed object cannot
 * prove a field's raw text is absent from the transport itself (a substring check needs the actual
 * bytes that crossed the socket, not a reconstruction of them).
 */
const claimRequestRaw = (socketPath: string, request: Record<string, unknown>): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let received = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("canonical self-claim socket test timed out"));
    }, 20_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (!received.includes("\n")) return;
      clearTimeout(timeout);
      socket.end();
      resolve(received.trim());
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

/**
 * The same exchange as `claimRequest`, plus an explicit, separately-bounded observation of the
 * teardown itself: whether the client socket reaches Node's own `'close'` event (both directions
 * of the stream fully ended) after the response line arrives. `socket.end()` after the response
 * is present on both this client and the server's `finish()` — this only makes that already-real
 * behaviour into a named, checkable assertion rather than an implicit assumption.
 */
const claimRequestWithTeardownAssertion = (
  socketPath: string,
  request: Record<string, unknown>,
): Promise<{ decision: Decision<unknown>; closedWithinBudget: boolean }> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let received = "";
    let closed = false;
    socket.once("close", () => { closed = true; });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("canonical self-claim socket test timed out"));
    }, 20_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (!received.includes("\n")) return;
      clearTimeout(timeout);
      const decision = JSON.parse(received.trim()) as Decision<unknown>;
      socket.end();
      // A short, separately-named budget for the teardown itself, distinct from the
      // request/response budget above: this is asking "did the connection actually finish
      // closing", not "did an answer arrive".
      setTimeout(() => resolve({ decision, closedWithinBudget: closed }), 2_000);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

const startMintOperator = async (): Promise<StartedOperator> => {
  const started = await makeStartedOperator();
  startedOperators.push(started);
  return started;
};

const mintOwnerApprovalOverOperatorSocket = (
  started: StartedOperator,
  input: {
    projectId: string;
    claimedSessionUuid: string;
    expectedBindingGeneration: number;
    approved?: boolean | "omit" | "malformed";
    nonce?: string;
  },
): Promise<{ nonce: string; result: Decision<unknown> }> => {
  const nonce = input.nonce ?? `owner-preflight-${freshNonces++}`;
  const params: Record<string, unknown> = {
    projectId: input.projectId,
    claimedSessionUuid: input.claimedSessionUuid,
    expectedBindingGeneration: input.expectedBindingGeneration,
    nonce,
  };
  if (input.approved === "malformed") {
    params["approved"] = "yes";
  } else if (input.approved !== "omit") {
    params["approved"] = input.approved ?? true;
  }
  return operatorRequest(started.socketPath, TEST_OPERATOR_TOKEN, {
    method: OPERATOR_METHOD.OWNER_APPROVE_CLAIM_CANONICAL_CTO,
    params,
  }).then((result) => ({ nonce, result }));
};

const resolveBuzzAddressFixture = (
  outcome: Decision<string> = allow(ReasonCode.OK, "buzz://test-canonical-cto"),
) => async (): Promise<Decision<string>> => outcome;

const depsFor = (cp: Harness["cp"], root: string): CanonicalSelfClaimOperatorDeps => ({
  db: cp.db,
  clock: cp.clock,
  sessions: cp.sessions,
  bindings: cp.bindings,
  ownerAuthority: cp.ownerAuthority,
  buzzActorAuthenticator: new IngressGuard(cp.db, cp.clock, cp.audit, { buzz: { allowedActors: [BUZZ_ACTOR_ID] } }),
  resolveBuzzAddress: resolveBuzzAddressFixture(),
  config: {
    expectedCwd: root,
    expectedPeerProtocolVersion: PEER_PROTOCOL,
    expectedPeerIdentity: `uid:${process.geteuid?.() ?? -1}`,
    canonicalSessionUuid: TEST_SESSION_UUID,
    // Synthetic — no test in this file spawns a real claimant far enough to reach the image
    // check; every path here denies earlier, at the method/mint-validation layer these tests
    // actually exercise (see this file's own docstring).
    requiredExecutorVersion: "9.0.0-test",
    canonicalBuzzChannelId: BUZZ_CHANNEL_ID,
    expectedExecutorRealpath: "/fake/versions/current/claude",
    expectedExecutorSha256: `sha256:${"0".repeat(64)}`,
    peerProtocolVersion: PEER_PROTOCOL,
    buzzChannelId: BUZZ_CHANNEL_ID,
    buzzActorId: BUZZ_ACTOR_ID,
    buzzPurpose: BUZZ_PURPOSE,
  },
  claimDeps: { transcriptReader: makeDefaultTranscriptReader(join(root, "transcripts")) },
});

const startClaimListener = async (
  daemon: Pick<Daemon, "lock">,
  cp: Harness["cp"],
  root: string,
): Promise<CanonicalSelfClaimListener> => {
  const listener = await startCanonicalSelfClaimListener(daemon, tempRoot(), (peer, params) =>
    executeCanonicalSelfClaimOperator(peer, params, depsFor(cp, root)),
  );
  claimListeners.push(listener);
  return listener;
};

const insertProject = (cp: Harness["cp"], projectId: string): void => {
  cp.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [
    projectId, projectId, cp.clock.nowIso(),
  ]);
};

const ROLLBACK_TABLES = [
  "sessions",
  "conversational_actors",
  "assignments",
  "actor_target_bindings",
  "actor_target_attestations",
  "audit_events",
] as const;

const rowCounts = (cp: Harness["cp"]): Record<(typeof ROLLBACK_TABLES)[number], number> =>
  Object.fromEntries(
    ROLLBACK_TABLES.map((table) => [table, cp.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)?.c ?? -1]),
  ) as Record<(typeof ROLLBACK_TABLES)[number], number>;

describe("actor.claimCanonicalCto — method-level rejections and the mint method's own validation", () => {
  it("the self-claim listener rejects a generic operator/owner method, including its own bearer-authenticated sibling", async () => {
    const started = await startMintOperator();
    const { cp } = started.harness;
    const root = tempRoot();
    const listener = await startClaimListener(started.daemon, cp, root);

    // The exact request/response exchange this test names, with an explicit, separately-bounded
    // assertion that the connection actually finishes closing (deterministic teardown), not only
    // that a decision arrives.
    const { decision: daemonStatus, closedWithinBudget } = await claimRequestWithTeardownAssertion(
      listener.socketPath,
      { method: "daemon.status", params: {} },
    );
    expect(daemonStatus.allowed).toBe(false);
    if (!daemonStatus.allowed) expect(daemonStatus.reasonCode).toBe(ReasonCode.OPERATOR_METHOD_NOT_ALLOWED);
    expect(closedWithinBudget, "client socket did not reach 'close' within 2s of the response arriving").toBe(true);

    // Its own bearer-authenticated sibling, sent here without a token (this socket has no field
    // for one) — still refused as an unrecognized method, not as an authentication failure. This
    // listener does not almost-serve `owner.approveClaimCanonicalCto`; it does not know the name.
    const ownerApprove = await claimRequest(listener.socketPath, {
      method: "owner.approveClaimCanonicalCto",
      params: { projectId: "x", claimedSessionUuid: TEST_SESSION_UUID, expectedBindingGeneration: 1, nonce: "n", approved: true },
    });
    expect(ownerApprove.allowed).toBe(false);
    if (!ownerApprove.allowed) {
      expect(ownerApprove.reasonCode).toBe(ReasonCode.OPERATOR_METHOD_NOT_ALLOWED);
      // The wire carries only the reason class, never the internal message naming the one method
      // this socket serves — see the metadata-free response boundary tests below for why.
      expect((ownerApprove as Record<string, unknown>)["message"]).toBeUndefined();
    }
  }, 30_000);

  it("the operator socket refuses actor.claimCanonicalCto as an unrecognized method", async () => {
    const started = await startMintOperator();
    const result = await operatorRequest(started.socketPath, TEST_OPERATOR_TOKEN, {
      method: "actor.claimCanonicalCto",
      params: { claimedSessionUuid: TEST_SESSION_UUID, projectId: "x", expectedBindingGeneration: 1, ownerApprovalNonce: "n" },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reasonCode).toBe(ReasonCode.OPERATOR_METHOD_NOT_ALLOWED);
  });

  it("owner.approveClaimCanonicalCto requires an explicit boolean approved: omitted and malformed both deny before any admission", async () => {
    const started = await startMintOperator();
    const { cp } = started.harness;
    const projectId = "prj_operator_approved_required";
    insertProject(cp, projectId);
    const before = rowCounts(cp);

    const omitted = await mintOwnerApprovalOverOperatorSocket(started, {
      projectId,
      claimedSessionUuid: TEST_SESSION_UUID,
      expectedBindingGeneration: 1,
      approved: "omit",
    });
    expect(omitted.result.allowed).toBe(false);

    const malformed = await mintOwnerApprovalOverOperatorSocket(started, {
      projectId,
      claimedSessionUuid: TEST_SESSION_UUID,
      expectedBindingGeneration: 1,
      approved: "malformed",
    });
    expect(malformed.result.allowed).toBe(false);

    // Neither denial admitted anything: no `inbound_messages`/`INGRESS_ADMITTED` row landed for
    // either nonce, and the audit table (part of `ROLLBACK_TABLES`) is unchanged.
    expect(rowCounts(cp)).toEqual(before);
    const admitted = cp.db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM inbound_messages WHERE nonce IN (?, ?)`,
      [omitted.nonce, malformed.nonce],
    )?.c ?? -1;
    expect(admitted).toBe(0);
  });
});

describe("listener startup — the AF_UNIX sun_path limit (#760)", () => {
  it("a normal, under-limit socket path binds and closes cleanly", async () => {
    const stateDir = tempRoot();
    const socketPath = join(stateDir, CANONICAL_SELF_CLAIM_SOCKET_FILENAME);
    expect(Buffer.byteLength(socketPath, "utf8")).toBeLessThan(MAX_SUN_PATH_BYTES + 1);

    const listener = await startCanonicalSelfClaimListener({ lock: { held: () => true } }, stateDir, TRIVIAL_HANDLER);
    expect(listener.socketPath).toBe(socketPath);
    expect(existsSync(socketPath)).toBe(true);

    await listener.close();
    expect(existsSync(socketPath)).toBe(false);
  });

  it(
    "an overlong byte-length path is rejected before any bind, with no residue — a character-count check would wrongly allow it",
    async () => {
      // "文" is 3 bytes in UTF-8 and exactly one UTF-16 code unit: 30 of them add 90 bytes but
      // only 30 to `.length`. Combined with the fixed socket filename (ASCII, plus the path
      // separator `join` inserts), the resulting path's *character count* stays comfortably under
      // 104 while its *UTF-8 byte length* is well past the 103-byte limit — exactly the shape a
      // `.length`-based check would wrongly let through and a byte-length check must refuse.
      const overlongStateDir = join(TEMP_BASE, "文".repeat(30));
      const overlongSocketPath = join(overlongStateDir, CANONICAL_SELF_CLAIM_SOCKET_FILENAME);
      expect(overlongSocketPath.length, "test setup error: this path is not short in characters").toBeLessThan(104);
      expect(
        Buffer.byteLength(overlongSocketPath, "utf8"),
        "test setup error: this path is not long in UTF-8 bytes",
      ).toBeGreaterThan(MAX_SUN_PATH_BYTES);

      await expect(
        startCanonicalSelfClaimListener({ lock: { held: () => true } }, overlongStateDir, TRIVIAL_HANDLER),
      ).rejects.toThrow(/sun_path/);

      // No residue: rejected before `removeStaleSocket`/`createServer`/`listen()` ever ran, so
      // there is nothing to have created — not even the directory itself.
      expect(existsSync(overlongStateDir)).toBe(false);
      expect(existsSync(overlongSocketPath)).toBe(false);
    },
  );
});

describe("the listen callback's own fault handling (#760)", () => {
  it(
    "a fault inside the listen callback (chmodSync throwing) rejects promptly instead of hanging, with no residual handle or file",
    async () => {
      const stateDir = tempRoot();
      const socketPath = join(stateDir, CANONICAL_SELF_CLAIM_SOCKET_FILENAME);
      const chmod = vi.mocked(chmodSync);
      chmod.mockImplementationOnce(() => {
        throw new Error("simulated chmod failure for the listen-callback wrapper");
      });

      const t0 = Date.now();
      let rejection: unknown;
      try {
        await startCanonicalSelfClaimListener({ lock: { held: () => true } }, stateDir, TRIVIAL_HANDLER);
      } catch (error) {
        rejection = error;
      } finally {
        chmod.mockRestore();
      }
      const elapsedMs = Date.now() - t0;

      expect(rejection, "expected startCanonicalSelfClaimListener to reject, not hang").toBeInstanceOf(Error);
      expect(String(rejection)).toContain("simulated chmod failure");
      // A fault inside the listen callback rejects promptly and never hangs: the socket answers
      // with a refusal, not a dead listener.
      expect(elapsedMs).toBeLessThan(5_000);
      // No residual file: the fault-time cleanup unlinks whatever `bind()` created.
      expect(existsSync(socketPath)).toBe(false);
      // No residual handle: a fresh bind at the exact same path must succeed immediately — if the
      // old handle were still listening, this would fail with `EADDRINUSE` instead.
      const relisten = await startCanonicalSelfClaimListener({ lock: { held: () => true } }, stateDir, TRIVIAL_HANDLER);
      await relisten.close();
    },
    15_000,
  );
});

/**
 * #843. Two of the three refusals in `authenticateClaimCredentials` had no test at all, and
 * deleting either left the suite green. Both guard the claim socket's answer to "is this a
 * trustworthy direct local peer" — the one identity question the listener answers itself, before a
 * byte of the request is read.
 *
 * Neither was reachable through a real `Socket`: one needs kernel credential derivation to fail,
 * the other a peer at a different uid. That is the same argument `assertDirectPeer` already
 * carries for being a pure function, applied to the refusals either side of it.
 */
describe("the claim socket's own identity check refuses what it cannot vouch for", () => {
  const SAME_UID = 501;
  const OTHER_UID = 502;
  const ok = { peerPid: 100, effectivePid: 100, uid: SAME_UID, gid: 20 };

  it("admits a direct local peer at this daemon's own uid", () => {
    // The control. Without it every refusal row below is satisfied by an implementation that
    // refuses everything, and "the guard works" would be indistinguishable from "nothing passes".
    const decision = authenticateClaimCredentials(ok, SAME_UID);
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.value).toEqual({ peerPid: 100, uid: SAME_UID });
  });

  it("refuses a peer whose kernel credentials could not be established", () => {
    // `derivePeerCredentialsFromSocket` answers null when the socket has no raw fd or the kernel
    // refuses the lookup. Absence of an identity is not a weak identity — it is none.
    const decision = authenticateClaimCredentials(null, SAME_UID);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reasonCode).toBe(ReasonCode.OPERATOR_UNAUTHENTICATED);
  });

  it("refuses a peer at a different uid, even when it is a direct connection", () => {
    // Direct on every other axis: peerPid === effectivePid, so this is refused by the uid check
    // and by nothing else. Reusing one uid for both sides would let the row pass on a machine
    // where the suite and the fixture happen to share one.
    const decision = authenticateClaimCredentials({ ...ok, uid: OTHER_UID }, SAME_UID);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reasonCode).toBe(ReasonCode.OPERATOR_UNAUTHENTICATED);
    expect(decision.evidence).toMatchObject({ observedUid: OTHER_UID });
  });

  it("refuses when this daemon cannot read its own euid, rather than treating that as a match", () => {
    // `process.geteuid` is absent on some platforms, so `euid` is `undefined` there. A peer uid
    // can never equal it, and the refusal is the fail-closed reading — the alternative is a
    // platform where the uid check silently admits everyone.
    const decision = authenticateClaimCredentials(ok, undefined);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reasonCode).toBe(ReasonCode.OPERATOR_UNAUTHENTICATED);
  });
});

describe("a proxied peer identity is refused before any admission effect", () => {
  it("denies when peerPid !== effectivePid, a focused counterexample with no real proxy required", () => {
    const direct = assertDirectPeer({ peerPid: 100, effectivePid: 100, uid: 0, gid: 0 });
    expect(direct.allowed).toBe(true);

    const proxied = assertDirectPeer({ peerPid: 100, effectivePid: 200, uid: 0, gid: 0 });
    expect(proxied.allowed).toBe(false);
    if (proxied.allowed) return;
    expect(proxied.reasonCode).toBe(ReasonCode.OPERATOR_UNAUTHENTICATED);
    expect(proxied.evidence).toMatchObject({ peerPid: 100, effectivePid: 200 });
  });
});

describe("agentctl claim canonical-cto reaches only the dedicated claim socket, never the operator socket (#760)", () => {
  /**
   * A single Unix-socket connection: reads one JSON line, answers with the given decision,
   * closes. Resolves only once the socket is actually bound and listening — the client below
   * must never race a bind that has not happened yet.
   */
  const startOneShotPeer = (
    socketPath: string,
    respond: (request: unknown) => Decision<unknown>,
  ): Promise<{ requests: unknown[]; close: () => Promise<void> }> => {
    const requests: unknown[] = [];
    const server = createServer((socket) => {
      let received = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        received += chunk;
        const boundary = received.indexOf("\n");
        if (boundary === -1) return;
        const parsed = JSON.parse(received.slice(0, boundary)) as unknown;
        requests.push(parsed);
        socket.end(`${JSON.stringify(respond(parsed))}\n`);
      });
    });
    return new Promise((resolveStart) => {
      server.listen(socketPath, () => {
        resolveStart({
          requests,
          close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
        });
      });
    });
  };

  /**
   * Never reads or answers — only counts connections, so contact itself is the observation.
   * Resolves only once actually listening, for the same reason as `startOneShotPeer`.
   */
  const startContactTrap = (socketPath: string): Promise<{ state: { contacts: number }; close: () => Promise<void> }> => {
    const state = { contacts: 0 };
    const server = createServer((socket) => {
      state.contacts += 1;
      socket.destroy();
    });
    return new Promise((resolveStart) => {
      server.listen(socketPath, () => {
        resolveStart({
          state,
          close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
        });
      });
    });
  };

  it(
    "reaches the dedicated claim socket with no bearer token, and never contacts the operator socket",
    async () => {
      const root = tempRoot();
      const claimSocketPath = join(root, "c.sock");
      const operatorSocketPath = join(root, "o.sock");
      const claimDecision: Decision<unknown> = allow(ReasonCode.OK, {
        sessionId: "ses_cli_claim_seam_test",
      });

      const claimPeer = await startOneShotPeer(claimSocketPath, () => claimDecision);
      const operatorTrap = await startContactTrap(operatorSocketPath);

      // `ACP_OPERATOR_TOKEN` is deliberately absent for the whole call: the claim dispatch must
      // never need it, never read it, and never reach a code path that would.
      const savedEnv: Record<string, string | undefined> = {
        ACP_OPERATOR_TOKEN: process.env["ACP_OPERATOR_TOKEN"],
        ACP_OPERATOR_SOCKET: process.env["ACP_OPERATOR_SOCKET"],
        ACP_CLAIM_CANONICAL_CTO_SOCKET: process.env["ACP_CLAIM_CANONICAL_CTO_SOCKET"],
      };
      delete process.env["ACP_OPERATOR_TOKEN"];
      process.env["ACP_OPERATOR_SOCKET"] = operatorSocketPath;
      process.env["ACP_CLAIM_CANONICAL_CTO_SOCKET"] = claimSocketPath;

      // "Never contacts the operator socket" and "never reads the token" are different claims —
      // reading an absent value and constructing a client from it produce no operator contact on
      // their own. `process.env` itself rejects an accessor descriptor for one key (Node throws
      // "does not accept an accessor(getter/setter) descriptor"), so the read is observed by
      // wrapping the whole object in a `Proxy` instead: every trap but `get` is left unspecified,
      // which per the Proxy invariants forwards straight to the real `process.env`, so this
      // changes nothing about how any key reads or writes except that one counter.
      let operatorTokenReads = 0;
      const realEnv = process.env;
      process.env = new Proxy(realEnv, {
        get(target, prop, receiver) {
          if (prop === "ACP_OPERATOR_TOKEN") operatorTokenReads += 1;
          return Reflect.get(target, prop, receiver);
        },
      });

      // A direct, saved-and-restored reassignment of `process.stdout.write`, not `vi.spyOn`:
      // spying on this stream inside a forked worker interferes with Vitest's own use of it for
      // that worker's reporting. Reassigning the function directly captures the same bytes
      // without touching how Vitest itself uses the stream.
      let stdout = "";
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array) => {
        stdout += chunk.toString();
        return true;
      }) as typeof process.stdout.write;

      let exitCode: number | undefined;
      try {
        exitCode = await agentctlMain([
          "claim",
          "canonical-cto",
          "--claimed-session-id",
          TEST_SESSION_UUID,
          "--project-id",
          "prj_cli_claim_seam",
          "--expected-binding-generation",
          "1",
          "--owner-approval-nonce",
          "cli-claim-seam-nonce",
        ]);
      } finally {
        process.stdout.write = originalWrite;
        process.env = realEnv;
        for (const [key, value] of Object.entries(savedEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await claimPeer.close();
        await operatorTrap.close();
      }

      // The exact returned decision and exit code: zero contact or a missing response cannot
      // pass as success, because both would leave `exitCode` undefined or `stdout` empty rather
      // than matching this exact value.
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.trim())).toEqual(claimDecision.allowed ? claimDecision.value : claimDecision);

      expect(claimPeer.requests).toHaveLength(1);
      const request = claimPeer.requests[0] as Record<string, unknown>;
      expect(request).toEqual({
        method: "actor.claimCanonicalCto",
        params: {
          claimedSessionUuid: TEST_SESSION_UUID,
          projectId: "prj_cli_claim_seam",
          expectedBindingGeneration: 1,
          ownerApprovalNonce: "cli-claim-seam-nonce",
        },
      });
      // `toEqual` above already fails on any extra field; asserted directly too, since a missing
      // bearer field is exactly the property this row exists to prove.
      expect(Object.keys(request)).not.toContain("token");
      expect(JSON.stringify(request)).not.toContain("token");

      // The operator socket this same process could otherwise have reached: zero contact, not
      // merely zero successful requests.
      expect(operatorTrap.state.contacts).toBe(0);

      // Zero contact alone does not prove zero reads — constructing a client from an absent
      // token produces no contact either. This is the direct claim: the property itself was
      // never even accessed.
      expect(operatorTokenReads).toBe(0);
    },
    15_000,
  );
});

describe("the claim socket's wire responses carry only a stable reason class, never internal evidence (#760)", () => {
  const SENSITIVE_SESSION_UUID = "77777777-7777-4777-8777-777777777777";
  const SENSITIVE_PATH = "/private/var/acp-secret/transcripts/session.jsonl";
  const SENSITIVE_HASH = "sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const SENSITIVE_PEER_PID = 424242;
  const SENSITIVE_ROUTING_ID = "route-should-not-leak";
  const SENSITIVE_TRANSCRIPT_FACT = "transcript-has-42-lines";
  const SENSITIVE_MESSAGE_TEXT = "internal-diagnostic-message-should-not-leak";

  it("a handler denial carrying session, path, hash, peer, routing and transcript evidence reaches the wire as only a reason code", async () => {
    const root = tempRoot();
    const denyingHandler: CanonicalSelfClaimHandler = async () =>
      deny(ReasonCode.CONFLICT, SENSITIVE_MESSAGE_TEXT, {
        sessionUuid: SENSITIVE_SESSION_UUID,
        path: SENSITIVE_PATH,
        sha256: SENSITIVE_HASH,
        peerPid: SENSITIVE_PEER_PID,
        routingId: SENSITIVE_ROUTING_ID,
        transcriptFact: SENSITIVE_TRANSCRIPT_FACT,
      });
    const listener = await startCanonicalSelfClaimListener({ lock: { held: () => true } }, root, denyingHandler);
    claimListeners.push(listener);

    const raw = await claimRequestRaw(listener.socketPath, { method: "actor.claimCanonicalCto", params: {} });

    for (const secret of [
      SENSITIVE_SESSION_UUID,
      SENSITIVE_PATH,
      SENSITIVE_HASH,
      String(SENSITIVE_PEER_PID),
      SENSITIVE_ROUTING_ID,
      SENSITIVE_TRANSCRIPT_FACT,
      SENSITIVE_MESSAGE_TEXT,
    ]) {
      expect(raw).not.toContain(secret);
    }
    expect(JSON.parse(raw)).toEqual({ allowed: false, reasonCode: ReasonCode.CONFLICT });
  });

  it("a thrown handler exception's raw message never reaches the wire", async () => {
    const root = tempRoot();
    const throwingHandler: CanonicalSelfClaimHandler = async () => {
      throw new Error(SENSITIVE_MESSAGE_TEXT);
    };
    const listener = await startCanonicalSelfClaimListener({ lock: { held: () => true } }, root, throwingHandler);
    claimListeners.push(listener);

    const raw = await claimRequestRaw(listener.socketPath, { method: "actor.claimCanonicalCto", params: {} });

    expect(raw).not.toContain(SENSITIVE_MESSAGE_TEXT);
    expect(JSON.parse(raw)).toEqual({ allowed: false, reasonCode: ReasonCode.INTERNAL_ERROR });
  });

  it("a method-not-allowed denial carries only a reason code", async () => {
    const root = tempRoot();
    const listener = await startCanonicalSelfClaimListener({ lock: { held: () => true } }, root, TRIVIAL_HANDLER);
    claimListeners.push(listener);

    const methodRaw = await claimRequestRaw(listener.socketPath, { method: "not.a.real.method", params: {} });
    expect(JSON.parse(methodRaw)).toEqual({
      allowed: false,
      reasonCode: ReasonCode.OPERATOR_METHOD_NOT_ALLOWED,
    });
    expect(methodRaw).not.toContain("actor.claimCanonicalCto");
  });

  it("a real credential mismatch (a proxied peer) is refused before authentication, with no peer/uid/gid metadata on the wire", async () => {
    // A genuine local socket connection from this same test process is always a *direct* peer
    // (`peerPid === effectivePid`) — nothing about a plain `createConnection` can make the kernel
    // report a proxied identity. Forcing the actual denial branch this test needs means overriding
    // what the listener's own credential check observes, not what connects to it: `getPeerCredentials`
    // is the one production seam `authenticateClaimPeer` reads, mocked here for exactly one call and
    // restored immediately after, in the same `{ spy: true }` style already used for `node:fs` above.
    const root = tempRoot();
    const mismatchedPeerPid = 100;
    const mismatchedEffectivePid = 200;
    vi.mocked(getPeerCredentials).mockImplementationOnce(() => ({
      peerPid: mismatchedPeerPid,
      effectivePid: mismatchedEffectivePid,
      uid: process.geteuid?.() ?? 0,
      gid: 0,
    }));
    const listener = await startCanonicalSelfClaimListener({ lock: { held: () => true } }, root, TRIVIAL_HANDLER);
    claimListeners.push(listener);

    const raw = await claimRequestRaw(listener.socketPath, { method: "actor.claimCanonicalCto", params: {} });

    expect(JSON.parse(raw)).toEqual({ allowed: false, reasonCode: ReasonCode.OPERATOR_UNAUTHENTICATED });
    for (const secret of [
      String(mismatchedPeerPid),
      String(mismatchedEffectivePid),
      '"peerPid"',
      '"effectivePid"',
      '"uid"',
      '"gid"',
      '"message"',
      '"evidence"',
    ]) {
      expect(raw).not.toContain(secret);
    }
  });

  it("negative control: the same substring check would catch a raw peer-credential leak if sanitization were bypassed", () => {
    // Proves the check above has teeth on this exact data shape — the mismatched pid pair a real
    // `assertDirectPeer` denial's `evidence` carries — rather than passing only because that text
    // could never have appeared regardless of whether sanitization ran.
    const unsanitizedShape = JSON.stringify({
      allowed: false,
      reasonCode: ReasonCode.OPERATOR_UNAUTHENTICATED,
      message: "the connecting peer is not a direct connection; a proxied identity is not accepted",
      evidence: { peerPid: 100, effectivePid: 200 },
    });
    for (const secret of ["100", "200", '"peerPid"', '"effectivePid"', '"message"', '"evidence"']) {
      expect(unsanitizedShape).toContain(secret);
    }
  });
});
