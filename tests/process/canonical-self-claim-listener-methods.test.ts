import { createConnection, createServer } from "node:net";
import { chmodSync, existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OPERATOR_METHOD, type Daemon } from "../../src/daemon/daemon.ts";
import {
  assertDirectPeer,
  startCanonicalSelfClaimListener,
  type CanonicalSelfClaimListener,
} from "../../src/daemon/canonical-self-claim-listener.ts";
import { executeCanonicalSelfClaimOperator, type CanonicalSelfClaimOperatorDeps } from "../../src/daemon/canonical-self-claim-operator.ts";
import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import { allow, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { makeDefaultTranscriptReader } from "../../src/registry/canonical-self-claim.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeStartedOperator, TEST_OPERATOR_TOKEN, type Harness, type StartedOperator } from "../helpers/harness.ts";

/**
 * #760 round 6 — the two rejection directions the CEO's ruling requires (requirement 4), plus
 * the mint method's explicit-boolean requirement (requirement 3) and the pure `peerPid !==
 * effectivePid` counterexample (correction B). None of these need a real spawned process — the
 * property under test is which method name a socket recognizes, or a pure function's own return
 * value — so they live in their own, lighter file, separate from
 * `canonical-self-claim-listener-claim.test.ts`'s real-process end-to-end tests. See that file's
 * docstring for why the split itself matters here (`vitest.config.ts`'s `pool: "forks"` comment).
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

const tempRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "acp-claim-listener-methods-"));
  roots.push(dir);
  return dir;
};

/**
 * Round 6 found `startCanonicalSelfClaimListener` occasionally not settling within a generous
 * bound when a real `Daemon` with its own already-live operator socket was in the same process.
 * That round's "environment syscall latency" explanation for it was checked directly (round 7)
 * and does not hold: a bare `listen()`+`chmodSync` with no daemon present is sub-millisecond, and
 * three other tests in this same file that never call `startCanonicalSelfClaimListener` complete
 * in ~100ms at the same moment the fourth — which does call it — exceeds this bound. The cause is
 * still open; see the diagnostic test below, which instruments the exact call to tell "the bind
 * itself is slow" apart from "the `listening` event is delivered late", rather than guessing.
 *
 * This wraps `startCanonicalSelfClaimListener`'s own promise, nothing inside it, with a named,
 * bounded deadline, and swallows the orphaned promise's eventual settlement so a run that hits
 * this produces one attributable failure ("listener startup exceeded Xs") instead of a generic
 * test timeout plus an unhandled `ENOENT` from a temp directory `afterEach` already deleted.
 */
const withNamedTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Swallow the orphaned promise's eventual settlement (success or failure) — it is no
      // longer this test's business once the named deadline below has already rejected, and an
      // unhandled rejection here would just be this same finding reported a second time.
      promise.catch(() => {});
      reject(new Error(`${label} exceeded ${ms}ms — cause not yet identified, see the diagnostic test in this file`));
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

let freshNonces = 0;
const TEST_SESSION_UUID = "99999999-9999-4999-8999-999999999999";
const BUZZ_ACTOR_ID = "buzz:canonical-cto";
const BUZZ_CHANNEL_ID = "channel:test-canonical";
const PEER_PROTOCOL = "acp.operator/v1";
const BUZZ_PURPOSE = "continuity:PRIMARY_CTO";

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
  const listener = await withNamedTimeout(
    startCanonicalSelfClaimListener(daemon, tempRoot(), (peer, params) =>
      executeCanonicalSelfClaimOperator(peer, params, depsFor(cp, root)),
    ),
    30_000,
    "startCanonicalSelfClaimListener",
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
    // that a decision arrives. The occasional slow settlement measured in this suite is isolated
    // to `startCanonicalSelfClaimListener` itself, called just above — see the diagnostic test
    // below for direct instrumentation of that call; this exchange and its close have not
    // reproduced a hang once the listener call above actually completes.
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
  }, 60_000);

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

/**
 * Round 7's own honest result, ahead of the individual tests below: **not conclusively
 * separated**, and reported as such rather than as a confident finding either way.
 *
 * What is measured and solid: the event loop is not blocked during a slow settlement (150,563
 * `setImmediate` ticks recorded across one 20-second wait); the underlying socket file is never
 * created on disk during that same wait, meaning the `bind(2)` call itself — not event delivery —
 * is what does not complete; a bare, single `listen()` is sub-millisecond regardless of whether a
 * real daemon/operator socket is present, measured at loads 7.95, 37.66 and 42.29; every call
 * shaped like `startCanonicalSelfClaimListener` (real handler, trivial handler, stand-in daemon
 * object, or an inline copy using its exact socket filename and `chmodSync` call) took 20+ seconds
 * whenever measured, at loads 60–118.
 *
 * What is **not** separated: this host's own `uptime` load average climbed monotonically and
 * substantially over the course of this exact diagnostic session — 6 → 9 → 27 → 37 → 42 → 60 → 77
 * → 118 across roughly fifteen minutes of wall clock, driven by other work on this shared host,
 * not by anything this file does. Every fast measurement above was taken *earlier* in that climb
 * and every slow one *later*. A bare, no-daemon control taken at the same *current* extreme load
 * (~100+) was not obtained before this round's time budget ran out, so "a live operator socket is
 * the discriminator" and "this host was simply more loaded by the time each later test ran" remain
 * both consistent with every number recorded here. Reported as an open question rather than closed
 * either way — see the individual tests' own `ROUND7_DIAGNOSTIC*` stdout lines for the exact
 * figures a follow-up (run with `uptime` held low, or on a quieter host) would need to compare
 * against.
 */
describe("round 7 diagnostic — bind latency vs. delayed listening-event delivery", () => {
  /**
   * Round 6's "environment syscall latency" explanation for the occasional slow settlement of
   * `startCanonicalSelfClaimListener` was withdrawn: a bare `listen()`+`chmodSync` with no daemon
   * present measures sub-millisecond, and three other tests in this file that never call
   * `startCanonicalSelfClaimListener` complete in ~100ms at the moment the fourth exceeds a 30s
   * bound. Loop starvation was also checked and withdrawn — a plain `setTimeout` fired on
   * schedule while `listen()` alone stayed pending, so the loop was processing timers normally.
   *
   * This measures, rather than assumes, which of two different owners a slow settlement would
   * belong to:
   *
   *   - **bind is slow**: the underlying `uv_pipe_bind`/`uv_listen` pair itself takes long to
   *     return. Node sets `server.listening = true` synchronously, inside that same call stack,
   *     before queuing the `'listening'` event on `process.nextTick` — so a fast poll of the
   *     public `.listening` property that only flips true after a long delay is evidence the
   *     syscall pair itself is what is slow.
   *   - **the event is delivered late**: `.listening` flips true quickly (the syscalls returned),
   *     but the queued `'listening'` event does not fire on the following tick the way
   *     `process.nextTick` promises — evidence of a scheduling-level delay between "the OS says
   *     this socket is bound" and "this process's JS heard about it", not the syscall pair itself.
   *
   * A tick counter, incrementing via a fresh `setImmediate` chain for the whole wait, is recorded
   * alongside both timestamps as the same falsifiable evidence the coordinator's own withdrawn
   * loop-starvation check used: if it stops counting, the loop is blocked; if it keeps counting
   * while the `.listening` flag and the event both wait, the loop is idle-but-unresponsive to this
   * one handle specifically, which is a third, more specific shape than either withdrawn guess.
   */
  it(
    "measures the real startCanonicalSelfClaimListener call against a real daemon with its own already-live operator socket",
    async () => {
      const started = await startMintOperator();
      const { cp } = started.harness;
      const root = tempRoot();
      // The exact minimal counterexample the CEO named: `startMintOperator()` (a real daemon whose
      // own operator socket is already bound and accepting) then `startCanonicalSelfClaimListener`
      // — the real function, the real handler, no wrapper timeout — so this measures the exact
      // call that has been slow, not a substitute for it.
      const listenerStateDir = tempRoot();
      const expectedSocketPath = join(listenerStateDir, "agentcpd.claim-canonical-cto.sock");
      if (existsSync(expectedSocketPath)) unlinkSync(expectedSocketPath);

      let ticks = 0;
      let tickHandle: NodeJS.Immediate | null = null;
      const tick = (): void => {
        ticks += 1;
        tickHandle = setImmediate(tick);
      };
      tickHandle = setImmediate(tick);

      // An `AF_UNIX` bind creates the socket's filesystem entry as part of the same synchronous
      // `bind()` libuv call `listen()` performs alongside it — before Node ever queues the
      // `'listening'` event on `process.nextTick`. Polling for the file's existence from outside
      // is therefore evidence of exactly the same moment `server.listening` would flip true
      // internally, without touching `startCanonicalSelfClaimListener`'s own source to get it.
      let fileAppearedAt: bigint | null = null;
      let ticksAtFileAppeared: number | null = null;
      const poll = setInterval(() => {
        if (fileAppearedAt === null && existsSync(expectedSocketPath)) {
          fileAppearedAt = process.hrtime.bigint();
          ticksAtFileAppeared = ticks;
        }
      }, 1);
      poll.unref?.();

      const t0 = process.hrtime.bigint();
      const rawPromise = startCanonicalSelfClaimListener(started.daemon, listenerStateDir, (peer, params) =>
        executeCanonicalSelfClaimOperator(peer, params, depsFor(cp, root)),
      );

      let outcome: { kind: "resolved"; at: bigint; listener: CanonicalSelfClaimListener } | { kind: "error"; error: unknown };
      try {
        const deadlineMs = 20_000;
        const listener = await Promise.race([
          rawPromise,
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error(`diagnostic: startCanonicalSelfClaimListener did not settle within ${deadlineMs}ms`)), deadlineMs);
          }),
        ]);
        outcome = { kind: "resolved", at: process.hrtime.bigint(), listener };
      } catch (error) {
        outcome = { kind: "error", error };
      }

      clearInterval(poll);
      if (tickHandle) clearImmediate(tickHandle);
      // The real promise may still be pending after the race above lost to the deadline —
      // swallow its eventual settlement so it does not surface as an unrelated unhandled
      // rejection once this test has already reported its own finding.
      rawPromise.catch(() => {});
      rawPromise.then((listener) => { listener.close().catch(() => {}); }).catch(() => {});

      const toMs = (t: bigint): number => Number(t - t0) / 1e6;
      const evidence = {
        outcome: outcome.kind,
        socketFileAppearedMs: fileAppearedAt ? toMs(fileAppearedAt) : null,
        promiseSettledMs: outcome.kind === "resolved" ? toMs(outcome.at) : null,
        fileToPromiseSettleMs:
          fileAppearedAt && outcome.kind === "resolved" ? Number(outcome.at - fileAppearedAt) / 1e6 : null,
        ticksAtFileAppeared,
        ticksTotal: ticks,
      };
      // Printed rather than only asserted: the numbers are the finding, and the next round needs
      // them verbatim, not just a pass/fail.
      process.stdout.write(`ROUND7_DIAGNOSTIC ${JSON.stringify(evidence)}\n`);

      if (outcome.kind === "error") {
        throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
      }
      await outcome.listener.close();

      // The loop must still be ticking throughout whenever the wait was long enough for a
      // `setImmediate` to plausibly fire — if it stayed at 0 while the wait ran into double-digit
      // milliseconds or more, the process was genuinely blocked and every other measurement here
      // is meaningless. A sub-millisecond settlement legitimately never yields a single tick.
      const waited = evidence.promiseSettledMs ?? 0;
      if (waited > 5) {
        expect(evidence.ticksTotal, `loop produced zero ticks across ${waited}ms — process was blocked`).toBeGreaterThan(0);
      }
    },
    25_000,
  );

  /**
   * The same exact counterexample, with one variable changed: a trivial handler in place of the
   * real `executeCanonicalSelfClaimOperator` closure. `startCanonicalSelfClaimListener` never
   * calls its handler before a connection arrives — none did here — so this isolates whether the
   * handler's own composition (which closes over the real `ControlPlane`'s `db`/`sessions`/
   * `bindings`/`ownerAuthority`, a new `IngressGuard`, and `CanonicalSelfClaimConfig`) has any
   * bearing on whether `listen()` itself settles, independent of anything the handler does when
   * invoked.
   */
  it(
    "measures the same real startCanonicalSelfClaimListener call with a trivial handler instead",
    async () => {
      const started = await startMintOperator();
      const listenerStateDir = tempRoot();
      const expectedSocketPath = join(listenerStateDir, "agentcpd.claim-canonical-cto.sock");
      if (existsSync(expectedSocketPath)) unlinkSync(expectedSocketPath);

      let ticks = 0;
      let tickHandle: NodeJS.Immediate | null = null;
      const tick = (): void => {
        ticks += 1;
        tickHandle = setImmediate(tick);
      };
      tickHandle = setImmediate(tick);

      let fileAppearedAt: bigint | null = null;
      const poll = setInterval(() => {
        if (fileAppearedAt === null && existsSync(expectedSocketPath)) {
          fileAppearedAt = process.hrtime.bigint();
        }
      }, 1);
      poll.unref?.();

      const t0 = process.hrtime.bigint();
      const rawPromise = startCanonicalSelfClaimListener(
        started.daemon,
        listenerStateDir,
        async () => ({ allowed: true, reasonCode: ReasonCode.OK, value: {} }) as unknown as Decision<unknown>,
      );

      let outcome: { kind: "resolved"; at: bigint; listener: CanonicalSelfClaimListener } | { kind: "error"; error: unknown };
      try {
        const deadlineMs = 20_000;
        const listener = await Promise.race([
          rawPromise,
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error(`diagnostic: startCanonicalSelfClaimListener (trivial handler) did not settle within ${deadlineMs}ms`)), deadlineMs);
          }),
        ]);
        outcome = { kind: "resolved", at: process.hrtime.bigint(), listener };
      } catch (error) {
        outcome = { kind: "error", error };
      }

      clearInterval(poll);
      if (tickHandle) clearImmediate(tickHandle);
      rawPromise.catch(() => {});
      rawPromise.then((listener) => { listener.close().catch(() => {}); }).catch(() => {});

      const toMs = (t: bigint): number => Number(t - t0) / 1e6;
      const evidence = {
        outcome: outcome.kind,
        socketFileAppearedMs: fileAppearedAt ? toMs(fileAppearedAt) : null,
        promiseSettledMs: outcome.kind === "resolved" ? toMs(outcome.at) : null,
        ticksTotal: ticks,
      };
      process.stdout.write(`ROUND7_DIAGNOSTIC_TRIVIAL_HANDLER ${JSON.stringify(evidence)}\n`);

      if (outcome.kind === "error") {
        throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
      }
      await outcome.listener.close();
    },
    25_000,
  );

  /**
   * Same real daemon and its own already-live operator socket, same trivial handler — the one
   * remaining variable is the `daemon` argument itself: a stand-in `{lock:{held:()=>true}}` object
   * instead of `started.daemon`. `startCanonicalSelfClaimListener` never reads this argument
   * before `listen()` settles either way, so if this one settles quickly while the identical call
   * above (real `started.daemon`) does not, the discriminator is specifically *passing the real
   * `Daemon` instance*, not "a real daemon merely existing somewhere in this process".
   */
  it(
    "measures the same call with a stand-in daemon object, real operator socket still live",
    async () => {
      await startMintOperator();
      const listenerStateDir = tempRoot();
      const expectedSocketPath = join(listenerStateDir, "agentcpd.claim-canonical-cto.sock");
      if (existsSync(expectedSocketPath)) unlinkSync(expectedSocketPath);

      const t0 = process.hrtime.bigint();
      const rawPromise = startCanonicalSelfClaimListener(
        { lock: { held: () => true } },
        listenerStateDir,
        async () => ({ allowed: true, reasonCode: ReasonCode.OK, value: {} }) as unknown as Decision<unknown>,
      );

      let outcome: { kind: "resolved"; at: bigint; listener: CanonicalSelfClaimListener } | { kind: "error"; error: unknown };
      try {
        const deadlineMs = 20_000;
        const listener = await Promise.race([
          rawPromise,
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error(`diagnostic: startCanonicalSelfClaimListener (stand-in daemon) did not settle within ${deadlineMs}ms`)), deadlineMs);
          }),
        ]);
        outcome = { kind: "resolved", at: process.hrtime.bigint(), listener };
      } catch (error) {
        outcome = { kind: "error", error };
      }
      rawPromise.catch(() => {});
      rawPromise.then((listener) => { listener.close().catch(() => {}); }).catch(() => {});

      const evidence = {
        outcome: outcome.kind,
        promiseSettledMs: outcome.kind === "resolved" ? Number(outcome.at - t0) / 1e6 : null,
      };
      process.stdout.write(`ROUND7_DIAGNOSTIC_STANDIN_DAEMON ${JSON.stringify(evidence)}\n`);

      if (outcome.kind === "error") {
        throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
      }
      await outcome.listener.close();
    },
    25_000,
  );

  /**
   * The same stand-in-daemon call, structured exactly like the bare-`listen()` controls in this
   * file: a direct `await`, no `Promise.race`, no separate deadline promise racing it. Every
   * measurement above that hung used `Promise.race([rawPromise, timeoutPromise])`; every bare
   * `net.createServer().listen()` control that stayed fast used a direct `await` instead. This
   * isolates whether that structural difference — not `startCanonicalSelfClaimListener`'s own
   * code — is what the previous measurements were actually observing.
   */
  it(
    "measures the same stand-in-daemon call with a direct await, no Promise.race",
    async () => {
      await startMintOperator();
      const listenerStateDir = tempRoot();
      const expectedSocketPath = join(listenerStateDir, "agentcpd.claim-canonical-cto.sock");
      if (existsSync(expectedSocketPath)) unlinkSync(expectedSocketPath);

      const t0 = process.hrtime.bigint();
      const listener = await startCanonicalSelfClaimListener(
        { lock: { held: () => true } },
        listenerStateDir,
        async () => ({ allowed: true, reasonCode: ReasonCode.OK, value: {} }) as unknown as Decision<unknown>,
      );
      const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
      process.stdout.write(`ROUND7_DIAGNOSTIC_DIRECT_AWAIT ${JSON.stringify({ elapsedMs })}\n`);
      await listener.close();
      expect(elapsedMs).toBeLessThan(20_000);
    },
    25_000,
  );

  /**
   * The control the two measurements above need: no `makeStartedOperator()` at all, run
   * immediately in the same file (same moment, same host state) — a bare `net.createServer()`
   * listening on its own fresh Unix socket path, nothing else running. If this is also slow right
   * now, the discriminator is this host's own load at the moment the test runs, not "a real
   * operator socket already live in this process"; if it stays fast while the two tests above (run
   * moments earlier, same file, same host) are not, the discriminator is the already-live socket.
   */
  it(
    "control: bare listen() with no daemon at all, run at the same moment as the two measurements above",
    async () => {
      const listenerStateDir = tempRoot();
      const socketPath = join(listenerStateDir, "bare-control.sock");
      if (existsSync(socketPath)) unlinkSync(socketPath);

      const t0 = process.hrtime.bigint();
      const server = createServer(() => {});
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
      process.stdout.write(`ROUND7_DIAGNOSTIC_BARE_CONTROL ${JSON.stringify({ elapsedMs })}\n`);
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      if (existsSync(socketPath)) unlinkSync(socketPath);
      expect(elapsedMs).toBeLessThan(20_000);
    },
    25_000,
  );

  /**
   * The narrowest form of the counterexample: `startMintOperator()`, then a **bare**
   * `net.createServer().listen()` on a fresh Unix socket path — none of this module's own code at
   * all. If this is also slow, the ownership edge is "a second live `AF_UNIX`-listening
   * `net.Server` in a process that already has one" as a general property of this host/Node
   * combination, not anything specific to `startCanonicalSelfClaimListener`.
   */
  it(
    "control: bare second listen() (no startCanonicalSelfClaimListener at all) after a real operator socket is already live",
    async () => {
      await startMintOperator();
      const listenerStateDir = tempRoot();
      const socketPath = join(listenerStateDir, "bare-second.sock");
      if (existsSync(socketPath)) unlinkSync(socketPath);

      const t0 = process.hrtime.bigint();
      const server = createServer(() => {});
      let outcome: { kind: "resolved" } | { kind: "error"; error: unknown };
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          const deadline = setTimeout(() => reject(new Error("bare second listen() did not settle within 20000ms")), 20_000);
          server.listen(socketPath, () => {
            clearTimeout(deadline);
            server.removeListener("error", reject);
            resolve();
          });
        });
        outcome = { kind: "resolved" };
      } catch (error) {
        outcome = { kind: "error", error };
      }
      const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
      process.stdout.write(`ROUND7_DIAGNOSTIC_BARE_SECOND ${JSON.stringify({ outcome: outcome.kind, elapsedMs })}\n`);

      try { server.close(); } catch { /* may already be unusable */ }
      if (existsSync(socketPath)) unlinkSync(socketPath);

      if (outcome.kind === "error") {
        throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
      }
    },
    25_000,
  );

  /**
   * The bare control above, byte-for-byte closer to `startCanonicalSelfClaimListener`'s own body:
   * the exact same socket filename (`agentcpd.claim-canonical-cto.sock`) and a `chmodSync` call
   * inside the `listen()` callback, in the same position. Everything else this module's real
   * function does (`removeStaleSocket`, the exported `async` wrapper, the returned `close`
   * object) is still absent. If this reproduces the hang, the remaining difference from the
   * bare-second control is one of these two; if it stays fast, the cause is specifically in
   * `startCanonicalSelfClaimListener`'s own wrapper (its `async` function shape, its default
   * parameter, or its `try`/`catch`), not the filename or `chmodSync`.
   */
  it(
    "control: bare listen() using the exact socket filename and chmodSync call this module uses",
    async () => {
      await startMintOperator();
      const listenerStateDir = tempRoot();
      const socketPath = join(listenerStateDir, "agentcpd.claim-canonical-cto.sock");
      if (existsSync(socketPath)) unlinkSync(socketPath);

      const t0 = process.hrtime.bigint();
      const server = createServer(() => {});
      let outcome: { kind: "resolved" } | { kind: "error"; error: unknown };
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          const deadline = setTimeout(() => reject(new Error("did not settle within 20000ms")), 20_000);
          server.listen(socketPath, () => {
            clearTimeout(deadline);
            server.removeListener("error", reject);
            chmodSync(socketPath, 0o600);
            resolve();
          });
        });
        outcome = { kind: "resolved" };
      } catch (error) {
        outcome = { kind: "error", error };
      }
      const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
      process.stdout.write(`ROUND7_DIAGNOSTIC_EXACT_SHAPE ${JSON.stringify({ outcome: outcome.kind, elapsedMs })}\n`);

      try { server.close(); } catch { /* may already be unusable */ }
      if (existsSync(socketPath)) unlinkSync(socketPath);

      if (outcome.kind === "error") {
        throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
      }
    },
    25_000,
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
