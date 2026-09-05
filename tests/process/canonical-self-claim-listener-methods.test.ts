import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OPERATOR_METHOD, type Daemon } from "../../src/daemon/daemon.ts";
import {
  assertDirectPeer,
  startCanonicalSelfClaimListener,
  CANONICAL_SELF_CLAIM_SOCKET_FILENAME,
  MAX_SUN_PATH_BYTES,
  type CanonicalSelfClaimListener,
} from "../../src/daemon/canonical-self-claim-listener.ts";
import { executeCanonicalSelfClaimOperator, type CanonicalSelfClaimOperatorDeps } from "../../src/daemon/canonical-self-claim-operator.ts";
import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import { allow, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { makeDefaultTranscriptReader } from "../../src/registry/canonical-self-claim.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeStartedOperator, TEST_OPERATOR_TOKEN, type Harness, type StartedOperator } from "../helpers/harness.ts";

// Spies on `node:fs` while keeping every real implementation by default (`{ spy: true }`) — only
// the one RED test below overrides `chmodSync`, and only for its own single call
// (`mockImplementationOnce`, restored immediately after). Every other test in this file, and every
// other `node:fs` call in this one, is untouched. Declared at module scope so vitest's own hoisting
// applies — inside a `describe` callback it would not run before the imports it needs to intercept.
vi.mock("node:fs", { spy: true });

/**
 * #760 round 6 — the two rejection directions the CEO's ruling requires (requirement 4), plus
 * the mint method's explicit-boolean requirement (requirement 3) and the pure `peerPid !==
 * effectivePid` counterexample (correction B). None of these need a real spawned process — the
 * property under test is which method name a socket recognizes, or a pure function's own return
 * value — so they live in their own, lighter file, separate from
 * `canonical-self-claim-listener-claim.test.ts`'s real-process end-to-end tests. See that file's
 * docstring for why the split itself matters here (`vitest.config.ts`'s `pool: "forks"` comment).
 *
 * #760 round 8 — what rounds 6 and 7 read as an unexplained, load-correlated 30-second hang in
 * `startCanonicalSelfClaimListener` had nothing to do with load, the daemon, or the event loop: a
 * state directory long enough pushed the joined socket path past Darwin's 104-byte `AF_UNIX`
 * `sun_path` limit, `bind(2)` silently truncated it, and `listen()`'s callback then ran real,
 * irreversible work (`chmodSync`) against a path the kernel never created — a throw with nothing
 * downstream to catch it, so the promise never settled. Fixed at the source
 * (`canonical-self-claim-listener.ts`): a byte-length check before any bind, and the `listen`
 * callback's own body wrapped so a fault there rejects instead of hanging. This file's fixture
 * helper (`tempRoot`) now verifies its own margin below instead of assuming a short prefix is
 * enough, and the two tests in `describe("listener startup...")` below replace every round-7
 * diagnostic test that used to live in this file.
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
 * path (`/var/folders/<hash>/<hash>/T/`, itself 50+ bytes on this host) that leaves almost no
 * margin before a joined `AF_UNIX` socket path exceeds Darwin's 104-byte `sun_path` limit — the
 * exact defect this file used to reproduce by accident (#760 round 8). `/tmp` is short and stable
 * across hosts; the assertion below verifies the margin actually holds for this file's one fixed
 * socket filename rather than assuming a short prefix is enough on every machine this ever runs on.
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
    canonicalBuzzChannelId: BUZZ_CHANNEL_ID,
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
      expect(ownerApprove.message).toContain("actor.claimCanonicalCto");
    }
  }, 30_000);

  it("the operator socket no longer dispatches actor.claimCanonicalCto", async () => {
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

describe("listener startup — the AF_UNIX sun_path limit (#760 round 8)", () => {
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

describe("the listen callback's own fault handling (#760 round 8)", () => {
  const MODULE_PATH = join(process.cwd(), "src", "daemon", "canonical-self-claim-listener.ts");
  // The real entry module, not `node_modules/.bin/vitest` — that shim is a `/bin/sh` script and
  // `execFileSync(process.execPath, [thatShim, ...])` fails before any test runs at all, which
  // would make the mutation look "killed" for the wrong reason.
  const VITEST_ENTRY = join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
  const THIS_FILE = join(process.cwd(), "tests", "process", "canonical-self-claim-listener-methods.test.ts");
  // No literal parentheses: on this node build, `vitest -t` compiles its argument as a RegExp,
  // and a pattern containing literal `text (text)` fails to match that exact literal text.
  const RED_TEST_FILTER = "rejects promptly instead of hanging";

  it(
    "a fault inside the listen callback (chmodSync throwing) rejects promptly instead of hanging, with no residual handle or file",
    async () => {
      const stateDir = tempRoot();
      const socketPath = join(stateDir, CANONICAL_SELF_CLAIM_SOCKET_FILENAME);
      const chmod = vi.mocked(chmodSync);
      chmod.mockImplementationOnce(() => {
        throw new Error("simulated chmod failure — round 8 RED for the listen-callback wrapper");
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
      // Promptly, not a hang: this is the exact property that used to cost 30 seconds and read as
      // a dead listener rather than a refusal.
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

  it(
    "the RED above is killed by removing the try/catch around chmodSync — restoring the exact hang this round found",
    () => {
      const original = readFileSync(MODULE_PATH, "utf8");
      const guarded = `      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        try {
          chmodSync(socketPath, 0o600);
        } catch (err) {
          // A throw inside this callback is not inside the promise executor's own call stack —
          // nothing here would otherwise catch it, and the promise above would never settle
          // (found the hard way: this is exactly what read as a 30-second hang). Bounded-close
          // the handle this call already opened, then reject — so a callback fault becomes a
          // refusal, never a wait with no answer.
          void boundedClose(server).then(() => {
            reject(err instanceof Error ? err : new Error(String(err)));
          });
          return;
        }
        resolveListen();
      });`;
      const unguarded = `      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        chmodSync(socketPath, 0o600);
        resolveListen();
      });`;
      expect(original, "the guarded block was not found verbatim — this mutation is stale").toContain(guarded);
      const mutated = original.replace(guarded, unguarded);
      expect(mutated, "mutation did not change anything — the target string was not found").not.toBe(original);

      writeFileSync(MODULE_PATH, mutated);
      let mutatedFailed = false;
      try {
        execFileSync(
          process.execPath,
          [VITEST_ENTRY, "run", THIS_FILE, "-t", RED_TEST_FILTER],
          { cwd: process.cwd(), encoding: "utf8", stdio: "pipe", timeout: 90_000 },
        );
      } catch {
        mutatedFailed = true;
      } finally {
        writeFileSync(MODULE_PATH, original);
      }
      expect(mutatedFailed, "removing the try/catch wrapper did not kill the RED test").toBe(true);

      // Restored: the RED test must be green again on the unmutated source.
      execFileSync(
        process.execPath,
        [VITEST_ENTRY, "run", THIS_FILE, "-t", RED_TEST_FILTER],
        { cwd: process.cwd(), encoding: "utf8", stdio: "pipe", timeout: 90_000 },
      );
    },
    120_000,
  );
});

describe("correction B — a proxied peer identity is refused before any admission effect", () => {
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
