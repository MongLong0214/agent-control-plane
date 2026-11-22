import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { readCrashLoopFile } from "../../src/daemon/crash-loop.ts";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { type StartGateConfig, refuseStartBeforeOpening, takeStartLock } from "../../src/daemon/start-gate.ts";
import { DESTINATION_MISMATCH, refusalNoticeRouteFrom } from "../../src/daemon/start-refusal-notice.ts";
import { Db } from "../../src/db/database.ts";
import { DIGEST, LIVE, adoptedFixture } from "../helpers/adopted-ceo.ts";
import {
  type DaemonNoticeBody,
  type DaemonNoticeDestination,
  type DaemonNoticeSendOutcome,
  daemonNoticeCanonical,
  daemonNoticeKey,
  daemonNoticeSignature,
} from "../../src/runtime/acp-daemon-notice.ts";

/**
 * #1496 — a start the pre-open gate refused tells the CEO, through the CEO notice route's own transport and
 * never through the database or the outbox. The transport here is a fake; the route and signer are the real
 * ones (`start-refusal-notice.ts`), so what the fake receives is what the Gateway would.
 */
const LANE_SECRET = "refusal-notice-lane-secret";
const DESTINATION: DaemonNoticeDestination = {
  session_id: "hermes-session-live",
  lineage_root_digest: `sha256:${"a".repeat(64)}`,
  process_pid: 4242,
  process_started_at: "Mon Nov 23 09:00:00 2026",
};
const T0 = Date.parse("2026-11-23T10:00:00.000Z");

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const newState = (): { root: string; database: string; config: StartGateConfig } => {
  const root = mkdtempSync(join(tmpdir(), "acp-gate-ceo-notice-"));
  dirs.push(root);
  chmodSync(root, 0o700);
  const secretsDir = join(root, "secrets");
  mkdirSync(secretsDir, { mode: 0o700 });
  const database = join(root, "state.sqlite");
  new Db(database).close();
  return {
    root,
    database,
    config: { databasePath: database, worktreeRoot: join(root, "worktrees"), secretsDir, capacityDir: join(root, "capacity") },
  };
};

const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The database as files, plus its audit row count read from a private copy (the original is never opened). */
const imageOf = (root: string, database: string) => {
  const probe = join(root, "..", `probe-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
  copyFileSync(database, probe);
  const raw = new Database(probe, { readonly: true });
  const auditRows = (raw.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n;
  const outboxRows = (raw.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n;
  raw.close();
  rmSync(probe, { force: true });
  return {
    main: sha(database),
    sidecars: readdirSync(root).filter((name) => name.startsWith("state.sqlite-")),
    auditRows,
    outboxRows,
  };
};

const settled = (body: DaemonNoticeBody) => ({
  kind: "RESPONDED" as const,
  status: 200,
  body: {
    event_id: body.event_id,
    payload_digest: body.payload_digest,
    receipt: {
      receipt_id: "receipt-1",
      status: "completed",
      session_id: DESTINATION.session_id,
      lineage_root_digest: DESTINATION.lineage_root_digest,
    },
  },
});

interface Dispatch {
  begin(): boolean;
  signal: AbortSignal;
}

/**
 * A route whose transport is a fake. Like the real sender it asks `dispatch.begin()` right before the request
 * would leave and sends only when told yes; `sent` is what actually left.
 */
const fakeRoute = (
  answer: (body: DaemonNoticeBody, dispatch: Dispatch) => Promise<DaemonNoticeSendOutcome> = async (body) => settled(body),
  lookup: (signal: AbortSignal) => Promise<DaemonNoticeDestination> = async () => ({ ...DESTINATION }),
) => {
  const sent: DaemonNoticeBody[] = [];
  return {
    sent,
    route: {
      configured: true as const,
      laneSecret: LANE_SECRET,
      destination: lookup,
      send: async (body: DaemonNoticeBody, dispatch: Dispatch): Promise<DaemonNoticeSendOutcome> => {
        if (dispatch && !dispatch.begin()) return { kind: "NOT_SENT", reason: "STALE" };
        sent.push(body);
        return answer(body, dispatch);
      },
    },
  };
};

const clockAt = (offsetMs: number) => () => new Date(T0 + offsetMs).toISOString();

const noticePayload = (body: DaemonNoticeBody) => {
  const head = /^ACP notification (\S+) part 1\/1: /.exec(body.text);
  expect(head).not.toBeNull();
  const wrapped = JSON.parse(body.text.slice(head![0].length)) as { messageId: string; kind: string; payload: Record<string, unknown> };
  expect(wrapped.messageId).toBe(head![1]);
  expect(wrapped.kind).toBe("CEO_NOTIFICATION");
  return wrapped.payload;
};

describe("a gate-refused start tells the CEO outside the database (#1496)", () => {
  it("sends exactly one notice with the refusal's id, reason, findings, stage, host and time, and leaves the database alone", async () => {
    const { root, database, config } = newState();
    const before = imageOf(root, database);
    const { route, sent } = fakeRoute();

    const refused = await refuseStartBeforeOpening(config, clockAt(0), { route, host: "build-host-1" });

    expect(refused).not.toBeNull();
    expect(refused!.decision.reasonCode).toBe(ReasonCode.DOCTOR_BLOCKED);
    expect(sent).toHaveLength(1);
    const body = sent[0]!;
    expect(body.destination).toEqual(DESTINATION);
    expect(body.signature).toBe(daemonNoticeSignature(daemonNoticeKey(LANE_SECRET), daemonNoticeCanonical({
      protocol: body.protocol, principal: body.principal, binding: body.binding, event_id: body.event_id,
      destination: body.destination, text: body.text,
    })));
    const loop = readCrashLoopFile(root, clockAt(0)());
    const payload = noticePayload(body);
    expect(loop.lastRefusal?.refusalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload).toMatchObject({
      refusalId: loop.lastRefusal!.refusalId,
      reasonCode: ReasonCode.DOCTOR_BLOCKED,
      stage: "before-open",
      host: "build-host-1",
      at: "2026-11-23T10:00:00.000Z",
      databaseWritten: false,
    });
    expect((payload["blockingFindings"] as Array<{ code: string }>).map((finding) => finding.code)).toContain(
      "TRUSTED_GATE_CREDENTIAL_MISSING",
    );
    expect(payload["blockingFindings"]).toEqual(loop.lastRefusal!.blockingFindings);
    // The database: same bytes, no sidecar, no audit row, no outbox row.
    expect(imageOf(root, database)).toEqual(before);
  });

  it("records the refusalId and the delivery outcome in crash-loop.json", async () => {
    const { root, config } = newState();
    const { route, sent } = fakeRoute();

    const refused = await refuseStartBeforeOpening(config, clockAt(0), { route, host: "h" });

    const loop = readCrashLoopFile(root, clockAt(0)());
    expect(loop.failures).toBe(1);
    expect(loop.lastRefusal).toMatchObject({
      host: "h",
      notice: { outcome: "delivered", eventId: sent[0]!.event_id, receiptId: "receipt-1" },
    });
    expect(refused!.decision.evidence).toMatchObject({ refusalId: loop.lastRefusal!.refusalId });
  });

  it("does not resend on a retry inside the backoff, and a new refusal gets a new id and its own notice", async () => {
    const { root, config } = newState();
    const { route, sent } = fakeRoute();
    await refuseStartBeforeOpening(config, clockAt(0), { route, host: "h" });
    const first = readCrashLoopFile(root, clockAt(0)()).lastRefusal!;

    const retry = await refuseStartBeforeOpening(config, clockAt(1_000), { route, host: "h" });

    expect(retry!.decision.reasonCode).toBe(ReasonCode.DAEMON_BACKOFF_ACTIVE);
    expect(sent).toHaveLength(1);
    expect(readCrashLoopFile(root, clockAt(0)()).lastRefusal).toEqual(first);

    const later = await refuseStartBeforeOpening(config, clockAt(10 * 60_000), { route, host: "h" });

    expect(later!.decision.reasonCode).toBe(ReasonCode.DOCTOR_BLOCKED);
    expect(sent).toHaveLength(2);
    const second = readCrashLoopFile(root, clockAt(0)()).lastRefusal!;
    expect(second.refusalId).not.toBe(first.refusalId);
    expect(noticePayload(sent[1]!)["refusalId"]).toBe(second.refusalId);
    expect(sent[1]!.event_id).not.toBe(sent[0]!.event_id);
  });

  it.each([
    ["a transport answer that was never read", async (): Promise<DaemonNoticeSendOutcome> => ({ kind: "UNCERTAIN", reason: "TIMEOUT" }), "UNCERTAIN: TIMEOUT"],
    ["a request that never left", async (): Promise<DaemonNoticeSendOutcome> => ({ kind: "NOT_SENT", reason: "STALE" }), "NOT_SENT: STALE"],
    ["a Gateway refusal", async (): Promise<DaemonNoticeSendOutcome> => ({ kind: "RESPONDED", status: 401, body: { error: "daemon_notice_signature_invalid" } }), "not settled (status 401)"],
    ["a transport that throws", async (): Promise<DaemonNoticeSendOutcome> => { throw new Error("socket exploded"); }, "socket exploded"],
  ])("%s is recorded and does not change the refusal", async (_name, answer, reason) => {
    const baseline = newState();
    const ok = await refuseStartBeforeOpening(baseline.config, clockAt(0), { route: fakeRoute().route, host: "h" });
    const { root, database, config } = newState();
    const before = imageOf(root, database);
    const { route, sent } = fakeRoute(answer);

    const refused = await refuseStartBeforeOpening(config, clockAt(0), { route, host: "h" });

    expect(sent).toHaveLength(1);
    expect(refused!.decision.reasonCode).toBe(ok!.decision.reasonCode);
    expect({ failures: refused!.failures, backoffSeconds: refused!.backoffSeconds }).toEqual({
      failures: ok!.failures, backoffSeconds: ok!.backoffSeconds,
    });
    const notice = readCrashLoopFile(root, clockAt(0)()).lastRefusal?.notice;
    expect(notice).toMatchObject({ outcome: "failed" });
    expect((notice as { reason: string }).reason).toContain(reason);
    expect(imageOf(root, database)).toEqual(before);
  });

  it("(b) a POST that has started and stalls past the bound is unknown, not failed, and is aborted", async () => {
    const { root, config } = newState();
    let aborted = false;
    const { route, sent } = fakeRoute((_body, dispatch) => new Promise<DaemonNoticeSendOutcome>(() => {
      dispatch.signal.addEventListener("abort", () => { aborted = true; });
    }));

    const refused = await refuseStartBeforeOpening(config, clockAt(0), { route, host: "h", timeoutMs: 60 });

    expect(sent).toHaveLength(1);
    expect(refused!.decision.reasonCode).toBe(ReasonCode.DOCTOR_BLOCKED);
    const notice = readCrashLoopFile(root, clockAt(0)()).lastRefusal?.notice;
    expect(notice).toMatchObject({
      outcome: "unknown", eventId: sent[0]!.event_id,
      reason: "request in flight at timeout; receipt cannot be assumed either way",
    });
    expect(aborted).toBe(true);
  });

  it("(a) an identity lookup that resolves after the bound never lets a POST begin, and the outcome is a pre-send timeout", async () => {
    const { root, database, config } = newState();
    const before = imageOf(root, database);
    let release: (destination: DaemonNoticeDestination) => void = () => undefined;
    let lookupAborted = false;
    const { route, sent } = fakeRoute(undefined, (signal) => new Promise<DaemonNoticeDestination>((resolve) => {
      signal.addEventListener("abort", () => { lookupAborted = true; });
      release = resolve;
    }));

    const refused = await refuseStartBeforeOpening(config, clockAt(0), { route, host: "h", timeoutMs: 60 });

    expect(refused!.decision.reasonCode).toBe(ReasonCode.DOCTOR_BLOCKED);
    expect(readCrashLoopFile(root, clockAt(0)()).lastRefusal?.notice).toMatchObject({
      outcome: "failed", reason: "timeout after 60ms before the request began; nothing was sent",
    });
    expect(lookupAborted).toBe(true);
    // The lookup now finishes, late. Wait past it: no request is ever begun.
    release({ ...DESTINATION });
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 250));
    expect(sent).toHaveLength(0);
    expect(readCrashLoopFile(root, clockAt(0)()).lastRefusal?.notice).toMatchObject({ outcome: "failed" });
    expect(imageOf(root, database)).toEqual(before);
  });

  it("bounds a transport that never answers: the refusal waits no longer than the bound", async () => {
    const { root, config } = newState();
    const { route } = fakeRoute(() => new Promise<DaemonNoticeSendOutcome>(() => undefined));

    const started = Date.now();
    const refused = await refuseStartBeforeOpening(config, clockAt(0), { route, host: "h", timeoutMs: 80 });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(refused!.decision.reasonCode).toBe(ReasonCode.DOCTOR_BLOCKED);
    // The request was out when the bound expired: neither delivery nor failure is claimed.
    expect(readCrashLoopFile(root, clockAt(0)()).lastRefusal?.notice).toMatchObject({
      outcome: "unknown", reason: "request in flight at timeout; receipt cannot be assumed either way",
    });
  });

  it("an unconfigured route sends nothing and says so", async () => {
    const { root, config } = newState();
    let touched = false;
    const route = {
      configured: false as const,
      reason: "ACP_DAEMON_NOTICE_ENABLED is not 1",
      destination: async () => { touched = true; return DESTINATION; },
      send: async () => { touched = true; return { kind: "NOT_SENT" as const, reason: "x" }; },
    };

    const refused = await refuseStartBeforeOpening(config, clockAt(0), { route, host: "h" });

    expect(touched).toBe(false);
    expect(refused!.decision.reasonCode).toBe(ReasonCode.DOCTOR_BLOCKED);
    expect(readCrashLoopFile(root, clockAt(0)()).lastRefusal?.notice).toMatchObject({
      outcome: "route-unconfigured", reason: "ACP_DAEMON_NOTICE_ENABLED is not 1",
    });
    expect(existsSync(join(root, "state.sqlite-wal"))).toBe(false);
  });

  it("a start given no route at all records route-unconfigured", async () => {
    const { root, config } = newState();

    await refuseStartBeforeOpening(config, clockAt(0));

    expect(readCrashLoopFile(root, clockAt(0)()).lastRefusal?.notice).toMatchObject({ outcome: "route-unconfigured" });
  });
});

/** A loopback Gateway: the identity it reports, and every POST it was asked to take. */
const loopbackGateway = async (identity: DaemonNoticeDestination) => {
  const posts: DaemonNoticeBody[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET") return void res.end(JSON.stringify(identity));
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      const body = JSON.parse(raw) as DaemonNoticeBody;
      posts.push(body);
      res.end(JSON.stringify({
        event_id: body.event_id, payload_digest: body.payload_digest,
        receipt: { receipt_id: "rcpt", status: "completed", session_id: body.destination.session_id,
          lineage_root_digest: body.destination.lineage_root_digest },
      }));
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return {
    posts,
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolveClose) => { server.closeAllConnections(); server.close(() => resolveClose()); }),
  };
};

/** The state directory of a daemon whose CEO is the Hermes Gateway running as this very process. */
const adoptedState = (): { root: string; database: string; config: StartGateConfig; startToken: string } => {
  const root = mkdtempSync(join(tmpdir(), "acp-gate-ceo-bound-"));
  dirs.push(root);
  chmodSync(root, 0o700);
  const fixture = adoptedFixture({ root, livePid: process.pid });
  fixture.h.cp.close();
  const secretsDir = join(root, "secrets");
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const startToken = readProcessStartToken(process.pid)!;
  const database = join(root, "state.sqlite");
  return {
    root, database, startToken,
    config: { databasePath: database, worktreeRoot: join(root, "worktrees"), secretsDir, capacityDir: join(root, "capacity") },
  };
};

describe("the notice goes only to the Gateway the active CEO binding names (#1496 P1-a)", () => {
  const routeFor = (gateway: { port: number }, database: string, lineage = DIGEST) => refusalNoticeRouteFrom({
    noticeEnabled: true,
    adoption: { apiKey: "loopback-key", port: gateway.port, lineageRootDigest: lineage },
    laneSecret: LANE_SECRET,
    databasePath: database,
  });

  it("a loopback Gateway with the right lineage but another session and a pid that does not exist gets nothing, and no binding is recorded as the reason", async () => {
    const { root, database, config } = newState();
    const gateway = await loopbackGateway({ session_id: "some-other-session", lineage_root_digest: DIGEST,
      process_pid: 2_147_000_000, process_started_at: "darwin-tv:1790000000.000001" });
    try {
      const before = imageOf(root, database);

      const refused = await refuseStartBeforeOpening(config, clockAt(0), { route: routeFor(gateway, database), host: "h" });

      expect(refused!.decision.reasonCode).toBe(ReasonCode.DOCTOR_BLOCKED);
      expect(gateway.posts).toHaveLength(0);
      expect(readCrashLoopFile(root, clockAt(0)()).lastRefusal?.notice).toMatchObject({
        outcome: "failed", reason: DESTINATION_MISMATCH,
      });
      expect(imageOf(root, database)).toEqual(before);
    } finally {
      await gateway.close();
    }
  });

  it("with an active CEO binding, only the Gateway whose session, pid and start token are the binding's is told", async () => {
    const { root, database, config, startToken } = adoptedState();
    const mine = { session_id: LIVE, lineage_root_digest: DIGEST, process_pid: process.pid, process_started_at: startToken };
    const cases: Array<[string, DaemonNoticeDestination, boolean]> = [
      ["the bound process", mine, true],
      ["another pid", { ...mine, process_pid: 2_147_000_000 }, false],
      ["the bound pid with another start token", { ...mine, process_started_at: "darwin-tv:1790000000.000001" }, false],
      ["another lineage", { ...mine, lineage_root_digest: `sha256:${"e".repeat(64)}` }, false],
    ];
    for (const [name, identity, told] of cases) {
      const gateway = await loopbackGateway(identity);
      try {
        const before = imageOf(root, database);

        await refuseStartBeforeOpening(config, clockAt(0), { route: routeFor(gateway, database), host: "h" });

        expect(gateway.posts, name).toHaveLength(told ? 1 : 0);
        expect(readCrashLoopFile(root, clockAt(0)()).lastRefusal?.notice, name).toMatchObject(
          told ? { outcome: "delivered" } : { outcome: "failed", reason: DESTINATION_MISMATCH },
        );
        expect(imageOf(root, database), name).toEqual(before);
      } finally {
        await gateway.close();
      }
      // Each case is its own refusal, past the last one's backoff.
      rmSync(join(root, "crash-loop.json"), { force: true });
    }
  });
});

describe("a concurrent start cannot make the next one tell the CEO again (#1496 P1-b)", () => {
  it("A's refusal waits on its Gateway, B is refused by the lock, C starts inside the backoff: one notice, and A's id and outcome stand", async () => {
    const { root, database, config } = newState();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
    const { route, sent } = fakeRoute(async (body) => { await held; return settled(body); });

    const a = refuseStartBeforeOpening(config, clockAt(0), { route, host: "h" });
    const until = Date.now() + 5_000;
    while (sent.length === 0 && Date.now() < until) await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
    expect(sent).toHaveLength(1);
    const idA = readCrashLoopFile(root, clockAt(0)()).lastRefusal!.refusalId;

    // B: another daemon finds agentcpd.lock held and is refused by it; that refusal is counted.
    const holder = new SingleInstanceLock(join(root, "agentcpd.lock"));
    expect(holder.acquire(clockAt(0)()).allowed).toBe(true);
    const b = takeStartLock(database, clockAt(500));
    expect("refused" in b).toBe(true);
    holder.release();
    expect(readCrashLoopFile(root, clockAt(0)()).lastRefusal?.refusalId).toBe(idA);

    release();
    await a;

    // C: a start inside the backoff B's count set.
    const c = await refuseStartBeforeOpening(config, clockAt(1_000), { route, host: "h" });

    expect(c!.decision.reasonCode).toBe(ReasonCode.DAEMON_BACKOFF_ACTIVE);
    expect(sent).toHaveLength(1);
    const loop = readCrashLoopFile(root, clockAt(0)());
    expect(loop.failures).toBe(2);
    expect(loop.lastRefusal).toMatchObject({ refusalId: idA, notice: { outcome: "delivered" } });
  });
});
