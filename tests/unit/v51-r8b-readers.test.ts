import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { digestOf } from "../../src/core/digest.ts";
import { Daemon, OPERATOR_METHOD } from "../../src/daemon/daemon.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { readReviewRoundSources, summarizeReviewRounds } from "../../src/review/review-round-summary.ts";
import { cleanupTempDirs, seedRun, tempDir } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
const UNKNOWN = "outcome unknown / delivery unconfirmed / automatic resend held";
const fixture = (outcome: "withheld" | "timeout" = "withheld") => {
  const h = makeHarness();
  const seeded = seedRun({ db: h.cp.db, clock: h.clock, repoPath: h.repoPath });
  const session = h.cp.sessions.require(seeded.sessionId);
  h.cp.sessions.setBuzzAddress(session.sessionId, "room");
  const binding = h.cp.bindings.active(`PRIMARY_CTO:${seeded.projectId}`)!;
  const enqueued = h.cp.outbox.enqueue({ roleKey: binding.roleKey, bindingGeneration: binding.bindingGeneration,
    targetSessionId: session.sessionId, runId: seeded.runId, kind: MessageKind.REVISION_REQUEST,
    idempotencyKey: `revision:${seeded.runId}:candidate:VERIFICATION_COMMAND_FAILED:attempt_111111111111111111111111`, payload: { candidateSnapshotDigest: "candidate", reasonCode: "VERIFICATION_COMMAND_FAILED", report: {} } });
  if (!enqueued.allowed) throw new Error(enqueued.message);
  const claim = h.cp.outbox.claimDeliverable().find(row => row.messageId === enqueued.value.messageId)!;
  if (!claim) throw new Error("no claim");
  const destination = { room: "room", recipient: "recipient" };
  h.cp.outbox.recordSendInFlight(claim.messageId, destination);
  const receipt = outcome === "withheld"
    ? h.cp.outbox.markAlreadySent(claim.messageId, claim.claimToken, "UNKNOWN", destination)
    : h.cp.outbox.markAttemptFailed(claim.messageId, claim.claimToken, {
      failureClass: "unknown_observed", retryable: false, error: "injected timeout", destination });
  return { h, seeded, session, claim, receipt };
};

it.each(["withheld", "timeout"] as const)("%s receipt: UNKNOWN is explicitly unconfirmed and never delivered/completed", (outcome) => {
  const f = fixture(outcome);
  try {
    expect(f.receipt.evidence).toMatchObject({ delivery: UNKNOWN, delivered: false, completed: false, automaticResendHeld: true });
    expect(f.h.cp.outbox.get(f.claim.messageId)).toMatchObject({ status: "SENT", failureClass: "unknown_observed" });
    expect(f.h.cp.outbox.claimDeliverable()).toEqual([]);
  } finally { f.h.cp.close(); }
});

it("operator run.show (agentctl run show) exposes the held outcome", async () => {
  const f = fixture();
  const daemon = new Daemon(f.h.cp, { stateDir: tempDir("r8b-operator-") });
  try {
    expect(daemon.lock.acquire(f.h.clock.nowIso()).allowed).toBe(true);
    const result = await daemon.handleOperatorRequest({ requestId: "read", method: OPERATOR_METHOD.RUN_SHOW,
      params: { runId: f.seeded.runId } }, { actor: "operator", channel: "cli", peerId: "test", incarnation: "test" });
    expect(result).toMatchObject({ allowed: true, value: { outbox: [{ status: "OUTCOME_UNKNOWN", delivery: UNKNOWN,
      delivered: false, completed: false }] } });
  } finally { daemon.lock.release(); f.h.cp.close(); }
});

it("doctor lists held rows and excludes them from confirmed counts", async () => {
  const f = fixture();
  try {
    const report = await f.h.cp.doctor.run("system");
    expect(report.findings.find(row => row.code === "OUTBOX_DELIVERY_UNCONFIRMED")).toMatchObject({
      observedEvidence: { delivered: 0, completed: 0, unconfirmed: [{ messageId: f.claim.messageId, delivery: UNKNOWN }] } });
  } finally { f.h.cp.close(); }
});

it("health and completion aggregation exclude held rows, then count an authenticated ACK", () => {
  const f = fixture();
  const stateDir = tempDir("r8b-health-");
  const daemon = new Daemon(f.h.cp, { stateDir });
  try {
    daemon.writeHealth(null);
    const health = JSON.parse(readFileSync(join(stateDir, "health.json"), "utf8"));
    expect(health.outbox).toMatchObject({ delivered: 0, completed: 0,
      unconfirmed: [{ messageId: f.claim.messageId, delivery: UNKNOWN, delivered: false, completed: false }] });
    expect(f.h.cp.outbox.acknowledge(f.claim.messageId, f.session.sessionId, 1, f.session.incarnation).allowed).toBe(true);
    daemon.writeHealth(null);
    expect(JSON.parse(readFileSync(join(stateDir, "health.json"), "utf8")).outbox).toMatchObject({ delivered: 1, completed: 1, unconfirmed: [] });
  } finally { f.h.cp.close(); }
});

it("MCP review-round summary delivery status describes UNKNOWN without reporting completion", () => {
  const f = fixture();
  try {
    const sources = readReviewRoundSources(f.h.cp, f.seeded.runId);
    sources.audit = [...sources.audit, { eventId: 99999, at: f.h.clock.nowIso(), kind: "CANDIDATE_FROZEN", reasonCode: null,
      runId: f.seeded.runId, projectId: f.seeded.projectId, sessionId: null, roleKey: null, actor: null,
      evidence: { candidateSnapshotDigest: "candidate", attemptId: "attempt_111111111111111111111111" } }, {
      eventId: 100000, at: f.h.clock.nowIso(), kind: "REVISION_RETURNED_TO_CTO", reasonCode: "VERIFICATION_COMMAND_FAILED",
      runId: f.seeded.runId, projectId: f.seeded.projectId, sessionId: null, roleKey: null, actor: null,
      evidence: { candidateSnapshotDigest: "candidate", stage: "verification", reportDigest: digestOf({}) } }];
    const result = summarizeReviewRounds(sources);
    expect(result.rounds[0]!.deliveries).toMatchObject([{ status: "OUTCOME_UNKNOWN", delivery: UNKNOWN,
      delivered: false, completed: false, acknowledged: false }]);
  } finally { f.h.cp.close(); }
});

it("MCP unattributed delivery readback also identifies held outcomes", () => {
  const f = fixture();
  try {
    const result = summarizeReviewRounds(readReviewRoundSources(f.h.cp, f.seeded.runId));
    expect(result.unattributedDeliveries).toMatchObject([{ messageId: f.claim.messageId, delivery: UNKNOWN,
      delivered: false, completed: false, automaticResendHeld: true }]);
  } finally { f.h.cp.close(); }
});

it("handoff denial receipt must not call SENT + unknown_observed delivered", async () => {
  const h = makeHarness();
  try {
    const { projectId } = await registerFixtureProject(h);
    await h.cp.cto.ensurePrimaryCto(projectId, "test");
    const prepared = await h.cp.cto.prepareSwitchover(projectId, { projectStatus: "new", activeManifestDigest: null,
      recentDecisions: [], openBlockers: [], queuedWork: [], repositoryFacts: [], knownRisks: [], recommendedNextAction: "verify" });
    if (!prepared.allowed) throw new Error(prepared.message);
    const envelope = h.cp.outbox.byIdempotencyKey(`handoff:${prepared.value.handoffId}`)!;
    h.cp.db.run("UPDATE outbox SET status = 'SENT', failure_class = 'unknown_observed' WHERE message_id = ?", [envelope.messageId]);
    const result = h.cp.cto.acknowledgeHandoff(prepared.value.handoffId, { sessionId: prepared.value.incomingSessionId,
      sessionIncarnation: "wrong", bindingGeneration: envelope.bindingGeneration, messageId: envelope.messageId,
      payloadDigest: envelope.payloadDigest, sessionSecret: "wrong" });
    expect(result.evidence).toMatchObject({ delivered: false, delivery: { delivery: UNKNOWN, completed: false } });
  } finally { h.cp.close(); }
});

// Census: lists external status readers and internal ACK-only completion readers.
it("reader census: every external outbox delivery/completion projection uses the shared interpretation", () => {
  const readers = ["daemon/daemon.ts", "doctor/doctor.ts", "review/review-round-summary.ts", "cto/cto-lifecycle.ts"];
  for (const path of readers) expect(/outboxDeliveryReadback|deliveryReadback/.test(
    readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8")), path).toBe(true);
  const files = readdirSync(new URL("../../src/", import.meta.url), { recursive: true, encoding: "utf8" })
    .filter(path => path.endsWith(".ts"));
  const sentReaders = files.filter(path => /\.status\s*===\s*"SENT"/.test(readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8")));
  expect(sentReaders.sort()).toEqual(["outbox/outbox.ts", "runtime/provisioned-session-runtime.ts"]);
  // These gate recovery on authenticated ACKs, not transport status. Telegram's owner-gate signal
  // reads payloads independently of delivery; MCP pendingInBandFor lists only PENDING instructions.
  const daemon = readFileSync(new URL("../../src/daemon/daemon.ts", import.meta.url), "utf8");
  expect(daemon.match(/dispatch\?\.status !== "ACKED"/g)).toHaveLength(2);
});
