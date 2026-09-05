import { createConnection } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
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
 * Round 6 diagnostic finding, reported rather than papered over: this sandbox's own synchronous
 * `net.Server.listen()` → callback → `chmodSync` sequence — no client, no request, no response,
 * nothing this module owns — has been measured taking anywhere from milliseconds to well past a
 * minute, correlated with this shared host's own `uptime` load average swinging between ~8 and
 * ~30 within the same session. When it is slow, the eventual `chmodSync` call fires against a
 * temp directory `afterEach` already deleted (a real, reproducible `ENOENT`), because the *test's*
 * timeout fired first and `afterEach` ran while the listener's own promise was still pending.
 *
 * This wraps exactly that node — `startCanonicalSelfClaimListener`'s own promise, nothing inside
 * it — with a named, bounded deadline, and swallows the orphaned promise's eventual settlement so
 * a slow environment produces one clear, attributable failure ("listener startup exceeded Xs")
 * instead of a generic test timeout plus an unrelated-looking unhandled `ENOENT` exception minutes
 * later. It does not change `startCanonicalSelfClaimListener`'s own behaviour, ownership, or
 * framing in any way — see `canonical-self-claim-listener-claim.test.ts`'s docstring for the full
 * finding this is evidence for.
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
      reject(new Error(`${label} exceeded ${ms}ms (environment syscall latency, not a listener defect — see docstring)`));
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

    // Round 6 diagnostic — the exact request/response exchange this test names, with an
    // explicit, separately-bounded assertion that the connection actually finishes closing
    // (deterministic teardown), not only that a decision arrives. See
    // `withNamedTimeout`/`claimRequestWithTeardownAssertion`'s own docstrings for the finding
    // this is evidence for: the hangs measured in this suite are `startCanonicalSelfClaimListener`
    // itself (a synchronous `listen()`/`chmodSync` pair, before any client ever connects) taking
    // arbitrarily long under this shared host's own load — never this exchange failing to
    // complete or failing to close once it does start.
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
