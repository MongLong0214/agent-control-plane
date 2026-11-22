import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { readCrashLoopFile } from "../../src/daemon/crash-loop.ts";
import { type StartGateConfig, refuseStartBeforeOpening } from "../../src/daemon/start-gate.ts";
import { Db } from "../../src/db/database.ts";
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

const fakeRoute = (answer: (body: DaemonNoticeBody) => Promise<DaemonNoticeSendOutcome> = async (body) => settled(body)) => {
  const sent: DaemonNoticeBody[] = [];
  return {
    sent,
    route: {
      configured: true as const,
      laneSecret: LANE_SECRET,
      destination: async () => ({ ...DESTINATION }),
      send: async (body: DaemonNoticeBody) => {
        sent.push(body);
        return answer(body);
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

  it("bounds a transport that never answers: the refusal waits no longer than the bound", async () => {
    const { root, config } = newState();
    const { route } = fakeRoute(() => new Promise<DaemonNoticeSendOutcome>(() => undefined));

    const started = Date.now();
    const refused = await refuseStartBeforeOpening(config, clockAt(0), { route, host: "h", timeoutMs: 80 });

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(refused!.decision.reasonCode).toBe(ReasonCode.DOCTOR_BLOCKED);
    expect(readCrashLoopFile(root, clockAt(0)()).lastRefusal?.notice).toMatchObject({
      outcome: "failed", reason: "timeout after 80ms",
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
