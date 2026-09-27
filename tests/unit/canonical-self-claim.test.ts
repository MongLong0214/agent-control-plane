import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runBoundedChild } from "../helpers/bounded-child.ts";

import { type Decision, allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { roleKeyFor, Role, SessionLifecycle } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import type { BuzzActorAuthenticator } from "../../src/session/session-registry.ts";
import {
  CanonicalSelfClaim,
  deriveClaimantIdentity,
  extractSessionUuidFromArgv,
  isInteractiveClaudeInvocation,
  looksLikeClaudeInvocation,
  lsofScanArgv,
  probeFailureKind,
  MAX_CANONICAL_ADOPTABLE_SESSIONS,
  type CanonicalSelfClaimConfig,
  type CanonicalSelfClaimRequest,
  type ExecutingImageInspector,
  type LsofProbeFailure,
  type ProcessAncestryInspector,
  type ProcessSnapshot,
  type TranscriptReader,
} from "../../src/registry/canonical-self-claim.ts";
import { cleanupTempDirs, makeCore, type CoreHarness } from "../helpers/fixtures.ts";

afterEach(cleanupTempDirs);

const CANON = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CWD = "/work/repo-factory";
const PEER_PROTOCOL = "mcp/2025-06-18";
const PEER_IDENTITY = "claude-code-mcp-client";
const CHANNEL = "channel:test-canonical";
const CANONICAL_ACTOR = "buzz:canonical-cto";
const BUZZ_ADDRESS = "buzz://test-canonical-cto";
/** Synthetic — never a value that names a real deployment's version. */
const TEST_REQUIRED_EXECUTOR_VERSION = "0.0.0-test";
const TEST_EXPECTED_EXECUTOR_REALPATH = "/fake/versions/current/claude";
const TEST_EXPECTED_EXECUTOR_SHA256 = `sha256:${"0".repeat(64)}`;

/** The five tables clause 3's contract names as the mutation. */
const FIVE_TABLES = [
  "sessions",
  "conversational_actors",
  "assignments",
  "actor_target_bindings",
  "actor_target_attestations",
] as const;

/**
 * The two kinds `claim()` records at its return boundary, one row per decision it hands back.
 * Written after `#mutate` has committed or rolled back, so they are outside its transaction by
 * design, and a refusal is meant to leave exactly one of them and nothing else.
 */
const CLAIM_DECISION_KINDS = ["CANONICAL_SELF_CLAIM_ADMITTED", "CANONICAL_SELF_CLAIM_REFUSED"] as const;

/**
 * `FIVE_TABLES` alone proves state rollback and says nothing about audit rollback, which the
 * contract names explicitly. `audit_events` is append-only and every writer
 * `#mutate` touches records to it (`SessionRegistry.create`, `.transition`, `.bindBuzzActor`,
 * `BindingRegistry.bind`), so a refusal whose rollback still let one of those rows land would
 * pass every `FIVE_TABLES`-only assertion and still be a real leak. Counting this table is what
 * makes that shape fail.
 */
const ROLLBACK_TABLES = [...FIVE_TABLES, "audit_events"] as const;

const rowCounts = (core: CoreHarness): Record<(typeof ROLLBACK_TABLES)[number], number> =>
  Object.fromEntries(
    ROLLBACK_TABLES.map((table) => [table, core.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)?.c ?? -1]),
  ) as Record<(typeof ROLLBACK_TABLES)[number], number>;

/**
 * The audit delta a rollback case is allowed: the one refusal row `claim()` records for the
 * decision it returned, carrying that decision's reason code — or nothing at all for a claim that
 * threw, because a throw returns no decision and so records none.
 */
const allowedAuditDelta = (refusal: { allowed: boolean; reasonCode: string } | null) => {
  if (refusal === null) return [];
  expect(refusal.allowed, JSON.stringify(refusal)).toBe(false);
  return [{ kind: "CANONICAL_SELF_CLAIM_REFUSED", reason_code: refusal.reasonCode }];
};

/**
 * The rollback oracle over counts. The five mutation tables hold what they held before, and the
 * *whole* of what `audit_events` gained since `before` — every row, whatever its kind — is exactly
 * the delta `allowedAuditDelta` permits.
 *
 * It compares the full delta rather than leaving the decision kinds out of the count, which it
 * used to: then a leak written under either kind — a second refusal row, or an admission row the
 * rollback should have taken with it — passed every rollback case in this file. `audit_events`
 * is append-only and ordered by insertion, so offsetting by the earlier count isolates exactly
 * what was written after it.
 */
const expectRolledBack = (
  core: CoreHarness,
  before: Record<(typeof ROLLBACK_TABLES)[number], number>,
  refusal: { allowed: boolean; reasonCode: string } | null,
): void => {
  const allowed = allowedAuditDelta(refusal);
  expect(
    core.db.all<{ kind: string; reason_code: string | null }>(
      `SELECT kind, reason_code FROM audit_events ORDER BY event_id LIMIT -1 OFFSET ?`,
      [before.audit_events],
    ),
  ).toEqual(allowed);
  expect(rowCounts(core)).toEqual({ ...before, audit_events: before.audit_events + allowed.length });
};

/**
 * The rows `claim()` recorded for the decisions it handed back, read from the database rather
 * than observed through a spy: the claim of this suite is that the row is durable, not that a
 * method was called.
 */

const claimDecisionRows = (core: CoreHarness) =>
  core.db.all<{
    kind: string; reason_code: string | null; project_id: string | null; session_id: string | null;
    role_key: string | null; evidence_json: string;
  }>(
    `SELECT kind, reason_code, project_id, session_id, role_key, evidence_json FROM audit_events
      WHERE kind IN (?, ?) ORDER BY event_id`,
    [...CLAIM_DECISION_KINDS],
  ).map(({ evidence_json, ...row }) => ({ ...row, evidence: JSON.parse(evidence_json) as unknown }));

const auditTotal = (core: CoreHarness): number =>
  core.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM audit_events`)?.c ?? -1;

const insertProject = (core: CoreHarness, projectId: string): void => {
  core.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [
    projectId,
    projectId,
    core.clock.nowIso(),
  ]);
};

/** A `ppid`-linked chain of fake processes; `snapshot` looks a pid up by identity. */
const chainInspector = (chain: readonly ProcessSnapshot[]): ProcessAncestryInspector => ({
  snapshot: (pid) => chain.find((entry) => entry.pid === pid) ?? null,
});

/**
 * The existence probe that matches a synthetic ancestry: a pid in the chain answers, one outside
 * it raises `ESRCH`.
 *
 * Default rather than per-test, because before #842 existence was *inferred* from
 * `chainInspector.snapshot(pid) === null` and every test was written against that inference. This
 * keeps those tests saying what they always said. What changes is that they now say it — the
 * production path no longer reads a `null` snapshot as proof of death, so a test that wants
 * "gone" has to supply a probe that reports gone.
 *
 * Nothing here may fall through to the real `process.kill`: pids like 10 and 11 are live system
 * processes on a Darwin host, so a test that reached the kernel would answer `EPERM` and pass or
 * fail on what else happens to be running.
 */
const signalFromChain = (chain: readonly ProcessSnapshot[]) => (pid: number): void => {
  if (chain.some((entry) => entry.pid === pid)) return;
  throw Object.assign(new Error(`no such process: ${pid}`), { code: "ESRCH" });
};

const claudeAncestor = (overrides: Partial<ProcessSnapshot> = {}, sessionUuid = CANON): ProcessSnapshot => ({
  pid: 10,
  ppid: 1,
  // A direct binary invocation — argv[0]'s own basename is `claude`. Never an interpreter-launched
  // form (`node /path/to/claude ...`): `looksLikeClaudeInvocation` refuses that shape (see the
  // counterexample below), and this default fixture must exercise the exact shape production
  // requires. `command` mirrors `argv` only for readability in a failed assertion's output — it is
  // never read by any of the derivation logic under test.
  argv: ["/opt/claude/claude", "--session-id", sessionUuid],
  command: `/opt/claude/claude --session-id ${sessionUuid}`,
  cwd: CWD,
  cwdProbeFailure: null,
  startedAt: "Fri Jan  1 00:00:00 2027",
  ...overrides,
});

const standardChain = (overrides: Partial<ProcessSnapshot> = {}, sessionUuid = CANON): ProcessSnapshot[] => [
  {
    pid: 100,
    ppid: 50,
    argv: ["/usr/bin/node", "/opt/acp/mcp-server.js"],
    command: "/usr/bin/node /opt/acp/mcp-server.js",
    cwd: CWD,
    cwdProbeFailure: null,
    startedAt: "t1",
  },
  { pid: 50, ppid: 10, argv: ["/bin/zsh", "-c", "foo"], command: "/bin/zsh -c foo", cwd: CWD,
    cwdProbeFailure: null, startedAt: "t2" },
  claudeAncestor(overrides, sessionUuid),
];

const fakeImageInspector = (
  version = TEST_REQUIRED_EXECUTOR_VERSION,
  imagePath = TEST_EXPECTED_EXECUTOR_REALPATH,
  sha256 = TEST_EXPECTED_EXECUTOR_SHA256,
): ExecutingImageInspector => ({
  resolve: () => ({ imagePath, version, sha256 }),
});

/** The #834 signature: a scan killed by its own timeout, so it read nothing about the process. */
const TIMED_OUT_SCAN: LsofProbeFailure = {
  pid: 10,
  timeoutMs: 5_000,
  kind: "TIMED_OUT",
  errorCode: null,
  exitStatus: null,
};

/** An inspector whose one channel to the image — the lsof scan — never ran. */
const unscannableImageInspector = (): ExecutingImageInspector => ({
  resolve: () => ({ probeFailure: TIMED_OUT_SCAN }),
});

const fakeTranscriptReader = (present = true): TranscriptReader => ({
  locate: (sessionUuid) => (present ? { path: `/fake/transcripts/${sessionUuid}.jsonl`, sizeBytes: 42 } : null),
});

/**
 * The adoptable set this deployment is configured with, for a harness whose subject is entitled to
 * exactly one project. `projectId` is a parameter rather than a constant because it is now half of
 * what the subject is configured for: a harness that built the subject without naming the project
 * would be free to claim a different one, which is the defect this set exists to close.
 */
const baseConfig = (
  projectId: string,
  overrides: Partial<CanonicalSelfClaimConfig> = {},
): CanonicalSelfClaimConfig => ({
  canonicalSessions: [{ sessionUuid: CANON, projectId, buzzActorId: CANONICAL_ACTOR }],
  requiredExecutorVersion: TEST_REQUIRED_EXECUTOR_VERSION,
  canonicalBuzzChannelId: CHANNEL,
  expectedExecutorRealpath: TEST_EXPECTED_EXECUTOR_REALPATH,
  expectedExecutorSha256: TEST_EXPECTED_EXECUTOR_SHA256,
  expectedPeerProtocolVersion: PEER_PROTOCOL,
  expectedPeerIdentity: PEER_IDENTITY,
  ...overrides,
});

const fakeBuzzActorAuthenticator = (allowed = true): BuzzActorAuthenticator => ({
  isAllowedActor: (channel) => allowed && channel === "buzz",
});

const fakeResolveBuzzAddress = (
  outcome: Decision<string> = allow(ReasonCode.OK, BUZZ_ADDRESS),
): ((purpose: string) => Promise<Decision<string>>) => async () => outcome;

const baseRequest = (
  core: CoreHarness,
  projectId: string,
  overrides: Partial<CanonicalSelfClaimRequest> = {},
): CanonicalSelfClaimRequest => ({
  callerPid: 100,
  claimedSessionUuid: CANON,
  projectId,
  expectedBindingGeneration: 1,
  peerProtocolVersion: PEER_PROTOCOL,
  peerIdentity: PEER_IDENTITY,
  buzzPurpose: "continuity:PRIMARY_CTO",
  ...overrides,
});

const makeSubject = (
  core: CoreHarness,
  projectId: string,
  options: {
    configOverrides?: Partial<CanonicalSelfClaimConfig>;
    chain?: readonly ProcessSnapshot[];
    imageInspector?: ExecutingImageInspector;
    transcriptReader?: TranscriptReader;
    buzzActorAuthenticator?: BuzzActorAuthenticator;
    resolveBuzzAddress?: (purpose: string) => Promise<Decision<string>>;
    processSignal?: (pid: number) => void;
  } = {},
): CanonicalSelfClaim =>
  new CanonicalSelfClaim(
    core.db,
    core.clock,
    core.audit,
    core.sessions,
    core.bindings,
    options.buzzActorAuthenticator ?? fakeBuzzActorAuthenticator(),
    options.resolveBuzzAddress ?? fakeResolveBuzzAddress(),
    baseConfig(projectId, options.configOverrides),
    {
      processInspector: chainInspector(options.chain ?? standardChain()),
      imageInspector: options.imageInspector ?? fakeImageInspector(),
      transcriptReader: options.transcriptReader ?? fakeTranscriptReader(),
      processSignal: options.processSignal ?? signalFromChain(options.chain ?? standardChain()),
    },
  );

const successorFixture = async () => {
  const core = makeCore();
  const projectId = "prj_successor";
  insertProject(core, projectId);
  const subject = makeSubject(core, projectId);
  const first = await subject.claim(baseRequest(core, projectId));
  if (!first.allowed) throw new Error(JSON.stringify(first));
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
  // Admit against the original ACTIVE holder; revoke preserves bytes but terminally rejects delivery.
  const envelope = { idempotencyKey: "owner-late", roleKey, bindingGeneration: 1,
    targetSessionId: first.value.sessionId, kind: MessageKind.OWNER_MESSAGE,
    payload: { text: "original owner envelope", nonce: "original-nonce" },
  };
  const admitted = core.outbox.enqueue(envelope);
  expect(admitted.allowed, JSON.stringify(admitted)).toBe(true);
  const pendingBeforeRevoke = core.db.all<Record<string, unknown>>(`SELECT * FROM outbox`);
  expect(pendingBeforeRevoke).toEqual([expect.objectContaining({ status: "PENDING" })]);
  expect(core.bindings.revoke(roleKey, "lost attachment").allowed).toBe(true);
  // Recovery starts after revoke: preserve its terminal refusal, never resurrect PENDING.
  const beforeRecovery = core.db.all(`SELECT * FROM outbox`);
  expect(beforeRecovery).toEqual(pendingBeforeRevoke.map((row) => ({
    ...row, status: "REJECTED", reason_code: ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
  })));
  expect(core.outbox.enqueue({ ...envelope, idempotencyKey: "owner-after-revoke" })).toMatchObject({
    allowed: false, reasonCode: ReasonCode.OUTBOX_TARGET_NOT_CURRENT,
  });
  expect(core.db.all(`SELECT * FROM outbox`)).toEqual(beforeRecovery);
  const request = baseRequest(core, projectId, {
    expectedBindingGeneration: 2,
  });
  return { core, projectId, subject, first: first.value, request, roleKey };
};

// Full durable preimages, not counts: rollback must restore pointer, hash, approval and envelope bytes.
// `audit_events` is read whole and in insertion order, decision rows included.
const durableSnapshot = (core: CoreHarness): Record<string, Record<string, unknown>[]> => Object.fromEntries(
  core.db.all<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).map(({ name }) => [name, name === "audit_events"
    ? core.db.all<Record<string, unknown>>(`SELECT * FROM audit_events ORDER BY event_id`)
    : core.db.all<Record<string, unknown>>(`SELECT * FROM "${name.replaceAll('"', '""')}"`)]),
);

/**
 * The rollback oracle over full preimages, and the same rule as `expectRolledBack`: every table
 * byte for byte, and `audit_events` byte for byte up to what it already held, followed by exactly
 * the delta `allowedAuditDelta` permits and nothing else.
 */
const expectDurablyRolledBack = (
  core: CoreHarness,
  before: Record<string, Record<string, unknown>[]>,
  refusal: { allowed: boolean; reasonCode: string } | null,
): void => {
  const { audit_events: auditBefore = [], ...tablesBefore } = before;
  const { audit_events: auditAfter = [], ...tablesAfter } = durableSnapshot(core);
  expect(tablesAfter).toEqual(tablesBefore);
  expect(auditAfter.slice(0, auditBefore.length)).toEqual(auditBefore);
  expect(auditAfter.slice(auditBefore.length).map(({ kind, reason_code }) => ({ kind, reason_code })))
    .toEqual(allowedAuditDelta(refusal));
};

describe("same-live successor transaction", () => {
  it("same-live recovery concurrent claims have exactly one winner", async () => {
    const { core, subject, request, first } = await successorFixture();
    const envelopeBefore = core.db.all(`SELECT * FROM outbox`);
    expect(envelopeBefore).toHaveLength(1);
    const before = rowCounts(core);
    const results = await Promise.all([subject.claim(request), subject.claim(request)]);
    expect(core.db.all(`SELECT * FROM outbox`)).toEqual(envelopeBefore);
    expect(results.filter((r) => r.allowed)).toHaveLength(1);
    expect(results.filter((r) => !r.allowed)).toHaveLength(1);
    expect(rowCounts(core).sessions).toBe(before.sessions + 1);
    expect(core.db.all(`SELECT session_id FROM sessions WHERE buzz_actor_id = ? AND lifecycle NOT IN ('STOPPED','ERROR')`,
      ["buzz:canonical-cto"])).toHaveLength(1);
    expect(core.db.all(`SELECT assignment_id FROM assignments WHERE status = 'ACTIVE'`)).toHaveLength(1);
    expect(core.sessions.require(first.sessionId).lifecycle).toBe(SessionLifecycle.STOPPED);
  });

  it.each(["stop", "create", "ready", "buzz", "bind"] as const)(
    "same-live recovery rollback after real %s callee restores every table and approval", async (stage) => {
      const { core, subject, request } = await successorFixture();
      const before = durableSnapshot(core);
      const envelopeBefore = core.db.all(`SELECT * FROM outbox`);
      const refusal = deny<never>(ReasonCode.CONFLICT, "injected after real callee", {});
      let invoked = false;
      const transition = core.sessions.transition.bind(core.sessions);
      const create = core.sessions.create.bind(core.sessions);
      const buzz = core.sessions.bindBuzzActor.bind(core.sessions);
      const bind = core.bindings.bind.bind(core.bindings);
      const spies = [
        vi.spyOn(core.sessions, "transition").mockImplementation((...args) => {
          const result = transition(...args);
          if ((stage === "stop" && args[1] === SessionLifecycle.STOPPED) ||
              (stage === "ready" && args[1] === SessionLifecycle.READY)) {
            expect(result.allowed).toBe(true); invoked = true; return refusal;
          }
          return result;
        }),
        vi.spyOn(core.sessions, "create").mockImplementation((...args) => {
          const result = create(...args);
          if (stage === "create") { invoked = true; throw new Error("after real create"); }
          return result;
        }),
        vi.spyOn(core.sessions, "bindBuzzActor").mockImplementation((...args) => {
          const result = buzz(...args);
          if (stage === "buzz") { expect(result.allowed).toBe(true); invoked = true; return refusal; }
          return result;
        }),
        vi.spyOn(core.bindings, "bind").mockImplementation((...args) => {
          const result = bind(...args);
          if (stage === "bind") { expect(result.allowed).toBe(true); invoked = true; return refusal; }
          return result;
        }),
      ];
      try {
        // A claim that throws hands back no decision, so the only delta it is allowed is none.
        let refused: Decision<unknown> | null = null;
        if (stage === "create") await expect(subject.claim(request)).rejects.toThrow("after real create");
        else { refused = await subject.claim(request); expect(refused.allowed).toBe(false); }
        expect(invoked).toBe(true);
        expectDurablyRolledBack(core, before, refused);
      } finally { spies.forEach((spy) => spy.mockRestore()); }
      expect((await subject.claim(request)).allowed).toBe(true);
      expect(core.db.all(`SELECT * FROM outbox`)).toEqual(envelopeBefore);
    },
  );

  it.each(["execution", "pipeline", "resource", "other-live-holder"] as const)(
    "same-live recovery refuses outstanding %s after assignment revocation", async (kind) => {
      const { core, first, request, subject, projectId } = await successorFixture();
      const now = core.clock.nowIso();
      core.db.run(`INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
        VALUES ('run_other', ?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'ACTIVE', 'fixture', 'fixture', ?)`, [projectId, now]);
      if (kind === "execution") {
        core.db.run(`INSERT INTO tasks (task_id, run_id, title, category, state, spec_json, created_at, updated_at)
          VALUES ('task_live', 'run_other', 'fixture', 'test', 'RUNNING', '{}', ?, ?)`, [now, now]);
        expect(core.bindings.bind({ role: Role.WORKER, taskId: "task_live", runId: "run_other", sessionId: first.sessionId }).allowed).toBe(true);
        core.db.run(`INSERT INTO task_executions (execution_id, run_id, task_id, attempt, owner_binding_generation,
          worker_session_id, provider, model, started_at, status)
          VALUES ('exec_live', 'run_other', 'task_live', 1, 1, ?, 'fixture', 'fixture', ?, 'RUNNING')`, [first.sessionId, now]);
        expect(core.bindings.revoke("WORKER:task_live", "fixture revoked but executing").allowed).toBe(true);
      } else if (kind === "pipeline") {
        core.db.run(`INSERT INTO candidate_pipeline_attempts (run_id, attempt_id, owner_session_id, owner_binding_generation,
          state, started_at, deadline_at) VALUES ('run_other', 'pipeline_live', ?, 1, 'RUNNING', ?, ?)`, [first.sessionId, now, now]);
      } else if (kind === "resource") {
        core.db.run(`INSERT INTO resource_claims (claim_id, repository_identity, branch, run_id, owner_session_id,
          owner_binding_generation, acquired_at, expires_at, status)
          VALUES ('claim_live', 'fixture', 'fixture', 'run_other', ?, 1, ?, ?, 'HELD')`, [first.sessionId, now, now]);
      } else {
        const other = core.sessions.create({ provider: "fixture", model: "fixture" });
        expect(core.sessions.transition(other.sessionId, SessionLifecycle.READY).allowed).toBe(true);
        const bound = core.bindings.bind({ role: Role.CEO, sessionId: other.sessionId });
        if (!bound.allowed) throw new Error(JSON.stringify(bound));
        core.db.run(`UPDATE conversational_actors SET current_session_id = ?, current_session_incarnation = ?
          WHERE actor_id = (SELECT actor_id FROM assignments WHERE assignment_id = ?)`,
        [first.sessionId, core.sessions.require(first.sessionId).incarnation, bound.value.assignmentId]);
      }
      const before = durableSnapshot(core);
      const refused = await subject.claim(request);
      expect(refused.allowed).toBe(false);
      expectDurablyRolledBack(core, before, refused);
    },
  );

  /**
   * `pid` and `start` were rows in this table until #831. Both built a predecessor whose process
   * did not exist — `pid` left the recorded pid out of the ancestry entirely, `start` put a
   * differently-started process at it — and asserted a refusal. That is the restart case, not a
   * mismatch case: the refusal they pinned is the one that left the canonical role unclaimable on
   * production. What each was protecting still is, in a test that supplies the live predecessor
   * the name implies — "a predecessor whose process is alive under a pid the claimant does not
   * share stays refused" and "a recycled pid never lets the claimant inherit the predecessor's
   * runtime" below.
   */
  it.each(["buzz", "draining", "active", "work"] as const)(
    "same-live recovery refuses %s mismatch without effects", async (condition) => {
      const { core, first, request, roleKey, projectId } = await successorFixture();
      // The "buzz" condition used to mutate `request.buzzActorId`, which no longer exists: the
      // identity comes from the configured entry now, so the only way the predecessor's stored
      // actor can disagree is for the deployment's own entry to name a different one. That is a
      // stricter version of the same case — it proves the comparison reads the configured value
      // rather than anything the claimant can restate.
      const subject = makeSubject(core, projectId, condition === "buzz"
        ? {
          configOverrides: {
            canonicalSessions: [{ sessionUuid: CANON, projectId, buzzActorId: "buzz:other" }],
          },
        }
        : {});
      if (condition === "draining") expect(core.sessions.transition(first.sessionId, SessionLifecycle.DRAINING).allowed).toBe(true);
      if (condition === "active") expect(core.bindings.bind({ role: Role.CEO, sessionId: first.sessionId }).allowed).toBe(true);
      if (condition === "work") core.db.run(
        `INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal, contract_digest,
          owner_session_id, owner_session_incarnation, owner_binding_generation, owner_role_key, created_at)
         VALUES ('run_busy', ?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'BLOCKED_POST_MERGE', 'fixture', 'fixture', ?, ?, 1, ?, ?)`,
        [projectId, first.sessionId, core.sessions.require(first.sessionId).incarnation, roleKey, core.clock.nowIso()],
      );
      const before = durableSnapshot(core);
      const refused = await subject.claim(request);
      expect(refused.allowed).toBe(false);
      expectDurablyRolledBack(core, before, refused);
    },
  );
});

describe("deployment identity is required, deployment-private configuration (#760)", () => {
  const CONFIG_PROJECT = "prj_config_fixture";

  it("fails closed, before any effect, when a required deployment value is missing or blank", () => {
    const core = makeCore();
    expect(() => makeSubject(core, CONFIG_PROJECT, { configOverrides: { requiredExecutorVersion: "" } })).toThrow(
      /requiredExecutorVersion/,
    );
    expect(() => makeSubject(core, CONFIG_PROJECT, { configOverrides: { canonicalBuzzChannelId: "   " } })).toThrow(
      /canonicalBuzzChannelId/,
    );
    expect(() => makeSubject(core, CONFIG_PROJECT, { configOverrides: { expectedExecutorRealpath: "" } })).toThrow(
      /expectedExecutorRealpath/,
    );
    expect(() => makeSubject(core, CONFIG_PROJECT, { configOverrides: { expectedExecutorSha256: "" } })).toThrow(
      /expectedExecutorSha256/,
    );
  });

  it("fails closed on an empty adoptable set, which is an unsupplied configuration and not a choice", () => {
    const core = makeCore();
    expect(() => makeSubject(core, CONFIG_PROJECT, { configOverrides: { canonicalSessions: [] } })).toThrow(
      /canonicalSessions is required deployment configuration/,
    );
  });

  it("fails closed above the adoptable-set bound", () => {
    const core = makeCore();
    const oversized = Array.from({ length: MAX_CANONICAL_ADOPTABLE_SESSIONS + 1 }, (_unused, index) => ({
      sessionUuid: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      projectId: `prj_${index}`,
      buzzActorId: `buzz:actor-${index}`,
    }));
    expect(() => makeSubject(core, CONFIG_PROJECT, { configOverrides: { canonicalSessions: oversized } })).toThrow(
      new RegExp(`more than ${MAX_CANONICAL_ADOPTABLE_SESSIONS} entries`),
    );
    // The bound itself, not merely "some large number is refused": one entry fewer constructs.
    expect(
      makeSubject(core, CONFIG_PROJECT, { configOverrides: { canonicalSessions: oversized.slice(1) } }),
    ).toBeInstanceOf(CanonicalSelfClaim);
  });

  // Review #1006/sol: whitespace-only ("  ") is also refused by the padding check two lines
  // below, so those three cases alone kill `an-entry-field-is-not-blank` on wording (a different
  // thrown message), never on the constructor succeeding. A true empty string does not trip
  // padding (`"" === "".trim()`), so it isolates the operand — for projectId and buzzActorId,
  // which have no later check of their own. sessionUuid is left out of the empty-string cases:
  // an empty sessionUuid still throws after this operand is removed, from `UUID_PATTERN.test("")`
  // a few lines later, so it would not isolate this check either.
  it.each([
    ["sessionUuid", "whitespace-only", "  "],
    ["projectId", "whitespace-only", "  "],
    ["buzzActorId", "whitespace-only", "  "],
    ["projectId", "empty", ""],
    ["buzzActorId", "empty", ""],
  ] as const)(
    "fails closed on a blank %s in an entry (%s)", (field, _shape, value) => {
      const core = makeCore();
      const entry = { sessionUuid: CANON, projectId: CONFIG_PROJECT, buzzActorId: CANONICAL_ACTOR };
      expect(() =>
        makeSubject(core, CONFIG_PROJECT, {
          configOverrides: { canonicalSessions: [{ ...entry, [field]: value }] },
        }),
      ).toThrow(new RegExp(`canonicalSessions\\[\\].${field} is required deployment configuration`));
    },
  );

  it.each(["sessionUuid", "projectId", "buzzActorId"] as const)(
    "refuses a set that repeats a %s rather than resolving it by first match", (field) => {
      const core = makeCore();
      // Every field distinct except the one under test, so the refusal is attributable to that
      // field and not to whichever duplicate check happens to run first.
      const first = { sessionUuid: CANON, projectId: "prj_first", buzzActorId: "buzz:first" };
      const second = { sessionUuid: OTHER, projectId: "prj_second", buzzActorId: "buzz:second" };
      expect(() =>
        makeSubject(core, CONFIG_PROJECT, {
          configOverrides: { canonicalSessions: [first, { ...second, [field]: first[field] }] },
        }),
      ).toThrow(new RegExp(`canonicalSessions\\[\\].${field} must be unique across entries`));
    },
  );

  it("fails closed when a configured canonical session UUID is not a UUID", () => {
    const core = makeCore();
    expect(() =>
      makeSubject(core, CONFIG_PROJECT, {
        configOverrides: {
          canonicalSessions: [{ sessionUuid: "not-a-uuid", projectId: CONFIG_PROJECT, buzzActorId: CANONICAL_ACTOR }],
        },
      }),
    ).toThrow(/UUID/);
  });

  // Review #1006/sol ACP1006-R1-01. Uniqueness runs on the configured strings while
  // `SessionRegistry.bindBuzzActor` trims the actor id before the `sessions_buzz_actor` unique
  // index sees it, so `"a"` and `" a "` were two entitlements here and one Buzz identity there:
  // the second session bound the *first* entry's actor. Padding is refused rather than trimmed,
  // because trimming here would make this a second authority over the compared value.
  it.each(["sessionUuid", "projectId", "buzzActorId"] as const)(
    "fails closed on a %s padded with whitespace, which uniqueness would not have caught",
    (field) => {
      const core = makeCore();
      const entry = { sessionUuid: CANON, projectId: CONFIG_PROJECT, buzzActorId: CANONICAL_ACTOR };
      expect(() =>
        makeSubject(core, CONFIG_PROJECT, {
          configOverrides: { canonicalSessions: [{ ...entry, [field]: ` ${entry[field]} ` }] },
        }),
      ).toThrow(/whitespace/);
    },
  );

  // Review #1006/sol ACP1006-R1-01, second half. `UUID_PATTERN` admits `A-F`, but the uuid this
  // primitive resolves membership against is lowercased where it is read out of the ancestor's
  // argv. An upper-case entry parsed, started, and then refused its own session forever.
  it("fails closed on an upper-case configured sessionUuid, which can never match a derived one", () => {
    const core = makeCore();
    expect(() =>
      makeSubject(core, CONFIG_PROJECT, {
        configOverrides: {
          canonicalSessions: [
            // CANON is all digits, so `.toUpperCase()` on it is a no-op and would have made this
            // assertion vacuous. The case difference has to be in a hex letter to exist at all.
            { sessionUuid: "AAAAAAAA-1111-4111-8111-111111111111", projectId: CONFIG_PROJECT, buzzActorId: CANONICAL_ACTOR },
          ],
        },
      }),
    ).toThrow(/lower-case/);
  });

  // Review #1006/sol ACP1006-R1-02. The entitlement is compared before the Buzz-address await and
  // the transaction used to re-read `request.projectId` afterwards. A caller holding a reference to
  // its own request could therefore be entitled to one project and bound to another.
  it("binds the entitled project even when the request's projectId is mutated during the buzz await", async () => {
    const core = makeCore();
    insertProject(core, CONFIG_PROJECT);
    const request = baseRequest(core, CONFIG_PROJECT);
    const subject = makeSubject(core, CONFIG_PROJECT, {
      resolveBuzzAddress: async () => {
        // The window the await opens: control has left this primitive entirely.
        (request as { projectId: string }).projectId = "prj_a_project_this_session_may_not_hold";
        return allow(ReasonCode.OK, BUZZ_ADDRESS);
      },
    });

    const result = await subject.claim(request);

    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.value.binding.projectId).toBe(CONFIG_PROJECT);
    expect(result.value.binding.roleKey).toContain(CONFIG_PROJECT);
    expect(result.value.binding.roleKey).not.toContain("may_not_hold");
  });

  /**
   * The twin of the case above, at generation 2, because the role key the transaction assembles
   * decides one thing the binding row does not carry back: which role key's MAX(binding_generation)
   * the expected generation is counted against. At generation 1 the entitled key and a foreign key
   * both count zero assignments, so a role key naming the wrong project agrees by accident and the
   * case above cannot see it — its mutant survives. Here the entitled key already holds one revoked
   * generation and the foreign key holds none, so a request expecting 2 is admitted only if the
   * count was taken against the entitlement rather than against the request the await let move.
   */
  it("counts the expected generation against the entitled project's role key, not the request's", async () => {
    const core = makeCore();
    insertProject(core, CONFIG_PROJECT);
    const first = await makeSubject(core, CONFIG_PROJECT).claim(baseRequest(core, CONFIG_PROJECT));
    expect(first.allowed, JSON.stringify(first)).toBe(true);
    if (!first.allowed) return;
    const predecessor = core.sessions.require(first.value.sessionId);
    expect(
      core.bindings.revoke(roleKeyFor(Role.PRIMARY_CTO, { projectId: CONFIG_PROJECT }), "lost attachment").allowed,
    ).toBe(true);

    const restarted = [
      standardChain()[0]!,
      { ...standardChain()[1]!, ppid: 11 },
      claudeAncestor({ pid: 11, startedAt: "Fri Jan  1 02:00:00 2027" }),
    ];
    expect(chainInspector(restarted).snapshot(predecessor.osPid!)).toBeNull();

    const request = baseRequest(core, CONFIG_PROJECT, { expectedBindingGeneration: 2 });
    const claimed = await makeSubject(core, CONFIG_PROJECT, {
      chain: restarted,
      resolveBuzzAddress: async () => {
        (request as { projectId: string }).projectId = "prj_a_project_this_session_may_not_hold";
        return allow(ReasonCode.OK, BUZZ_ADDRESS);
      },
    }).claim(request);

    expect(claimed.allowed, JSON.stringify(claimed)).toBe(true);
    if (!claimed.allowed) return;
    expect(claimed.value.binding.bindingGeneration).toBe(2);
    expect(claimed.value.binding.roleKey).toContain(CONFIG_PROJECT);
    expect(claimed.value.binding.roleKey).not.toContain("may_not_hold");
  });

  it("never falls back to a hardcoded real value — no exported real-ID constant exists to fall back to", () => {
    // No exported real-ID constant exists for this module to fall back to (#760): every value the
    // primitive uses must come from the config this test constructs, never from a module-level
    // default.
    const core = makeCore();
    const subject = makeSubject(core, CONFIG_PROJECT);
    expect(subject).toBeInstanceOf(CanonicalSelfClaim);
  });
});

describe("pure identity-derivation helpers", () => {
  it("matches only a directly executed binary named claude — never an interpreter-launched script", () => {
    expect(looksLikeClaudeInvocation(["/usr/local/bin/claude", "--resume", "x"])).toBe(true);
    expect(looksLikeClaudeInvocation(["claude", "--resume", "x"])).toBe(true);
    // The exact bypass this file's own claim-seam counterexample proves end to end: naming a
    // script `claude` and launching it through a legitimate interpreter must not match, because
    // the executing-image check downstream authenticates the interpreter's own binary, never the
    // script argument sitting after it.
    expect(looksLikeClaudeInvocation(["/usr/bin/node", "/opt/claude/claude", "--session-id", "x"])).toBe(false);
    expect(looksLikeClaudeInvocation(["/usr/bin/node", "/attacker-controlled/claude", "--session-id", "x"])).toBe(
      false,
    );
    expect(looksLikeClaudeInvocation(["/usr/bin/node", "/opt/claude/cli.js", "--session-id", "x"])).toBe(false);
    expect(looksLikeClaudeInvocation(["/usr/bin/node", "/opt/acp/mcp-server.js"])).toBe(false);
  });

  it("extracts the session id from --session-id, never from a bare token, an embedded fragment, or a quoted value", () => {
    expect(extractSessionUuidFromArgv(["claude", "--session-id", CANON])).toBe(CANON);
    expect(extractSessionUuidFromArgv(["claude", "--resume", CANON])).toBe(CANON);
    expect(extractSessionUuidFromArgv(["claude", CANON])).toBeNull();
    expect(extractSessionUuidFromArgv(["claude", "--print", "hello"])).toBeNull();
    // Attached form, exact value.
    expect(extractSessionUuidFromArgv(["claude", `--session-id=${CANON}`])).toBe(CANON);
    // Embedded, not exact: the selector's own value must equal a UUID, never merely contain one.
    expect(extractSessionUuidFromArgv(["claude", "--session-id", `prefix-${CANON}`])).toBeNull();
    expect(extractSessionUuidFromArgv(["claude", "--session-id", `${CANON}-suffix`])).toBeNull();
    // Quoted, as one argv element carrying the quote characters: the surrounding quotes break the
    // exact match the same way a prefix does.
    expect(extractSessionUuidFromArgv(["claude", "--session-id", `"${CANON}"`])).toBeNull();
  });

  it("a selector with an empty attached value still counts as a selector, so a second, otherwise-valid selector does not win by default", () => {
    // `--session-id=` carries no value but is still one occurrence; with `--resume` also present,
    // two occurrences means refusal, never a fallback to whichever one has a value.
    expect(extractSessionUuidFromArgv(["claude", "--session-id=", "--resume", CANON])).toBeNull();
    expect(extractSessionUuidFromArgv(["claude", "--session-id", "--resume", CANON])).toBeNull();
  });

  it("selector-looking text inside one unrelated positional argv element is never a selector, even alongside a different real selector", () => {
    // A real argv vector already carries the element boundary a regex over rendered text cannot
    // recover: this is one argv element, not three, so it can never equal or start with a
    // recognized selector no matter what text it contains.
    expect(extractSessionUuidFromArgv(["claude", "-p", "please use --session-id", CANON])).toBeNull();
    // The same positional element, this time alongside a real, valid selector elsewhere: the real
    // selector still resolves correctly, because the positional text was never counted at all.
    expect(extractSessionUuidFromArgv(["claude", "-p", "please use --session-id", "--resume", CANON])).toBe(CANON);
  });

  it("duplicate and conflicting selectors both refuse", () => {
    expect(extractSessionUuidFromArgv(["claude", "--session-id", CANON, "--resume", CANON])).toBeNull();
    expect(extractSessionUuidFromArgv(["claude", "--resume", OTHER, "--session-id", CANON])).toBeNull();
  });

  it("a selector-looking token after -- is a positional argument being passed through, never a selector", () => {
    expect(extractSessionUuidFromArgv(["claude", "--", "--session-id", CANON])).toBeNull();
    // The one real selector, positioned before --, still resolves; only what follows -- is inert.
    expect(extractSessionUuidFromArgv(["claude", "--session-id", CANON, "--", "--resume", OTHER])).toBe(CANON);
  });

  it("reads interactivity from the absence of a headless flag, honoring the -- boundary", () => {
    expect(isInteractiveClaudeInvocation(["claude", "--session-id", CANON])).toBe(true);
    expect(isInteractiveClaudeInvocation(["claude", "-p", "--session-id", CANON])).toBe(false);
    expect(isInteractiveClaudeInvocation(["claude", "--output-format", "json", "--session-id", CANON])).toBe(false);
    // A headless-looking token after -- is a positional argument, not this process's own flag.
    expect(isInteractiveClaudeInvocation(["claude", "--session-id", CANON, "--", "-p"])).toBe(true);
  });

  it("rejects a headless flag in its attached form, not only its separated form", () => {
    expect(isInteractiveClaudeInvocation(["claude", "--output-format=json", "--session-id", CANON])).toBe(false);
    expect(isInteractiveClaudeInvocation(["claude", "--input-format=stream-json", "--session-id", CANON])).toBe(
      false,
    );
    // Still honors the -- boundary in attached form: after it, it is a positional argument.
    expect(isInteractiveClaudeInvocation(["claude", "--session-id", CANON, "--", "--output-format=json"])).toBe(
      true,
    );
  });

  it("walks a multi-hop ancestry to the claude process and derives its session id, refusing distinctly when no claude ancestor exists, no session id is named, or the ancestry cycles", () => {
    const found = deriveClaimantIdentity(100, chainInspector(standardChain()));
    expect(found).toMatchObject({ allowed: true, value: { pid: 10, sessionUuid: CANON } });

    const withoutClaude = deriveClaimantIdentity(
      100,
      chainInspector([
        {
          pid: 100,
          ppid: 50,
          argv: ["/usr/bin/node", "/opt/acp/mcp-server.js"],
          command: "/usr/bin/node /opt/acp/mcp-server.js",
          cwd: CWD,
          cwdProbeFailure: null,
          startedAt: "t1",
        },
        { pid: 50, ppid: 1, argv: ["/bin/zsh", "-c", "foo"], command: "/bin/zsh -c foo", cwd: CWD,
          cwdProbeFailure: null, startedAt: "t2" },
      ]),
    );
    expect(withoutClaude.allowed).toBe(false);
    if (withoutClaude.allowed) throw new Error("unreachable");
    expect(withoutClaude.message).toContain("no claude ancestor exists");

    const noSessionId = deriveClaimantIdentity(
      100,
      chainInspector([
        {
          pid: 100,
          ppid: 1,
          argv: ["/usr/local/bin/claude", "--print", "hi"],
          command: "/usr/local/bin/claude --print hi",
          cwd: CWD,
          cwdProbeFailure: null,
          startedAt: "t1",
        },
      ]),
    );
    expect(noSessionId.allowed).toBe(false);
    if (noSessionId.allowed) throw new Error("unreachable");
    expect(noSessionId.message).toContain("names no session id");

    const cyclic = deriveClaimantIdentity(
      100,
      chainInspector([
        { pid: 100, ppid: 100, argv: ["/usr/bin/node", "x.js"], command: "/usr/bin/node x.js", cwd: CWD,
          cwdProbeFailure: null, startedAt: "t1" },
      ]),
    );
    expect(cyclic.allowed).toBe(false);
    if (cyclic.allowed) throw new Error("unreachable");
    expect(cyclic.message).toContain("no claude ancestor exists");
  });

  it("a hop whose argv is unavailable refuses immediately, rather than being silently treated as 'not claude' and climbed past", () => {
    const unavailable = deriveClaimantIdentity(
      100,
      chainInspector([{ pid: 100, ppid: 1, argv: null, command: "/opt/claude/claude --session-id " + CANON,
        cwd: CWD, cwdProbeFailure: null, startedAt: "t1" }]),
    );
    expect(unavailable.allowed, JSON.stringify(unavailable)).toBe(false);
    if (unavailable.allowed) throw new Error("unreachable");
    expect(unavailable.message).toBe("process argv could not be established");
    expect(unavailable.evidence).toMatchObject({ pid: 100 });
  });
});

describe("CanonicalSelfClaim — the six-clause contract", () => {
  it("claims the canonical session in one atomic mutation, writing exactly one row to each of the five tables", async () => {
    const core = makeCore();
    const projectId = "prj_canonical";
    insertProject(core, projectId);
    const subject = makeSubject(core, projectId);

    const request = baseRequest(core, projectId);
    const before = rowCounts(core);
    const result = await subject.claim(request);

    expect(result.allowed, JSON.stringify(result)).toBe(true);
    if (!result.allowed) return;
    expect(result.value.binding.role).toBe("PRIMARY_CTO");
    expect(result.value.binding.projectId).toBe(projectId);
    expect(result.value.derivedSessionUuid).toBe(CANON);
    expect(result.value.executorImageVersion).toBe(TEST_REQUIRED_EXECUTOR_VERSION);
    expect(result.value.buzzAddress).toBe(BUZZ_ADDRESS);

    const after = rowCounts(core);
    for (const table of FIVE_TABLES) {
      expect(after[table], `table ${table}`).toBe((before[table] ?? 0) + 1);
    }

    const session = core.db.get<{ buzz_actor_id: string; buzz_address: string; os_process_started_at: string }>(
      `SELECT buzz_actor_id, buzz_address, os_process_started_at FROM sessions WHERE session_id = ?`,
      [result.value.sessionId],
    );
    expect(session).toMatchObject({ buzz_actor_id: "buzz:canonical-cto", buzz_address: BUZZ_ADDRESS });
    // The exact verified `startedAt` from `deriveClaimantIdentity` is what lands in the row
    // (#760), not a fresh `processStartedAt` read taken at write time. `claudeAncestor`'s own
    // fixture `startedAt` ("Fri Jan  1 00:00:00 2027") has no real corresponding OS process at
    // all; if `SessionRegistry.create` were still deriving its own value, this column would be
    // null (no real pid to `ps`-query), not this fixture's exact fake value.
    expect(session!.os_process_started_at).toBe("Fri Jan  1 00:00:00 2027");

    // Positive evidence that every writer `#mutate` composes recorded its own audit row, exactly
    // once each, inside the same committed transaction — the full footprint the refusal oracle
    // below (`ROLLBACK_TABLES`) proves is absent on any denial — plus the one admission row
    // `claim()` records on its way out. `audit_events` is append-only and ordered by insertion,
    // so skipping `before.audit_events` rows isolates exactly what `claim()` itself wrote.
    const auditKinds = core.db
      .all<{ kind: string }>(`SELECT kind FROM audit_events ORDER BY event_id LIMIT -1 OFFSET ?`, [
        before.audit_events ?? 0,
      ])
      .map((row) => row.kind)
      .sort();
    expect(auditKinds).toEqual([
      "BINDING_CREATED",
      "CANONICAL_SELF_CLAIM_ADMITTED",
      "SESSION_BUZZ_ACTOR_BOUND",
      "SESSION_CREATED",
      "SESSION_LIFECYCLE",
    ]);
    expect(after.audit_events).toBe((before.audit_events ?? 0) + 5);
  });

  it("clause 1 — a caller-supplied session UUID is checked against the derived one, never substituted", async () => {
    const core = makeCore();
    const projectId = "prj_uuid_mismatch";
    insertProject(core, projectId);
    const subject = makeSubject(core, projectId);
    // The owner approval must itself bind `OTHER` too — otherwise the owner-approval
    // parameterDigest check fires first (a real, earlier, and correct refusal, but not the one
    // this test targets), and the derivation mismatch this test names never gets reached.
    const request = baseRequest(core, projectId, {
      claimedSessionUuid: OTHER,
    });
    const before = rowCounts(core);
    const result = await subject.claim(request);

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.CONFLICT);
    expect(result.message).toContain("does not match the independently derived identity");
    expect(result.evidence).toMatchObject({ claimed: OTHER, derived: CANON });
    expectRolledBack(core, before, result);
  });

  it("clause 1 — a caller-supplied pid is checked against the derived ancestor pid", async () => {
    const core = makeCore();
    const projectId = "prj_pid_mismatch";
    insertProject(core, projectId);
    const subject = makeSubject(core, projectId);
    const request = baseRequest(core, projectId, { claimedPid: 999 });
    const before = rowCounts(core);
    const result = await subject.claim(request);

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.CONFLICT);
    expect(result.message).toContain("claimed pid does not match");
    expectRolledBack(core, before, result);
  });

  it(
    "production claim seam: Node interpreting an attacker-controlled script named claude is refused before any effect",
    async () => {
      const core = makeCore();
      const projectId = "prj_interpreter_bypass";
      insertProject(core, projectId);
      // The exact bypass this check closes: an attacker-controlled script, merely named `claude`,
      // launched through the real Node interpreter, at the same ancestry position a real claude
      // process would occupy. `looksLikeClaudeInvocation` only matches the first token's own
      // basename, so this pid is never recognized as the claimant — the ancestry walk keeps
      // climbing past it, finds nothing above it (`ppid: 1`), and denies at clause 1, before this
      // request's owner approval is ever presented for consumption, before any transaction opens,
      // and before Buzz resolution runs.
      const subject = makeSubject(core, projectId, {
        chain: standardChain({
          argv: ["/usr/bin/node", "/attacker-controlled/claude", "--session-id", CANON],
          command: `/usr/bin/node /attacker-controlled/claude --session-id ${CANON}`,
        }),
      });
      const request = baseRequest(core, projectId);
      const before = rowCounts(core);

      const result = await subject.claim(request);

      expect(result.allowed, JSON.stringify(result)).toBe(false);
      if (result.allowed) return;
      expect(result.reasonCode).toBe(ReasonCode.NOT_FOUND);
      expect(result.message).toContain("no claude ancestor exists");
      // No effect anywhere: zero new rows across every mutation table and audit_events. This
      // denial happens at clause 1's derivation — strictly before `#mutate` ever opens a
      // transaction, before the async Buzz-address resolution, and before the owner approval
      // this request carried is ever presented for consumption.
      expectRolledBack(core, before, result);

      // The very same approval, presented again by the real claimant (a directly executed
      // `claude` binary, this file's default chain), must still succeed. If the attack attempt
      // had consumed it, this second, otherwise-identical claim would be refused as a replay
      // instead.
      const legitimateResult = await makeSubject(core, projectId).claim(baseRequest(core, projectId));
      expect(legitimateResult.allowed, JSON.stringify(legitimateResult)).toBe(true);
    },
  );

  it(
    "production claim seam: a conflicting second selector on the claude ancestor's command line is refused before any effect, never resolved by trusting whichever selector this code happens to check first",
    async () => {
      const core = makeCore();
      const projectId = "prj_conflicting_selector";
      insertProject(core, projectId);
      // The claude ancestor's own argv carries two selectors naming two different sessions —
      // `--resume OTHER` ahead of an appended `--session-id CANON`. Resolving the ambiguity by
      // trusting whichever selector is checked first would silently treat CANON as this process's
      // one real session, when the same argv just as validly names OTHER via `--resume`. Exactness
      // means the ambiguity itself is the refusal, never a tiebreak between the two candidates.
      const subject = makeSubject(core, projectId, {
        chain: standardChain({
          argv: ["/opt/claude/claude", "--resume", OTHER, "--session-id", CANON],
          command: `/opt/claude/claude --resume ${OTHER} --session-id ${CANON}`,
        }),
      });
      const request = baseRequest(core, projectId);
      const before = rowCounts(core);

      const result = await subject.claim(request);

      expect(result.allowed, JSON.stringify(result)).toBe(false);
      if (result.allowed) return;
      expect(result.reasonCode).toBe(ReasonCode.NOT_FOUND);
      expect(result.message).toContain("names no session id");
      // No effect anywhere, for the same reason the row above checks it: this denial happens at
      // clause 1's derivation, strictly before `#mutate` ever opens a transaction, before the
      // async Buzz-address resolution, and before the owner approval this request carried is ever
      // presented for consumption.
      expectRolledBack(core, before, result);

      // The very same approval, presented again by the real claimant (this file's default,
      // unambiguous chain), must still succeed — the conflicting-selector attempt above consumed
      // nothing.
      const legitimateResult = await makeSubject(core, projectId).claim(baseRequest(core, projectId));
      expect(legitimateResult.allowed, JSON.stringify(legitimateResult)).toBe(true);
    },
  );

  it(
    "production claim seam: an empty --session-id= alongside a valid --resume is refused, never resolved by only counting the selector that has a value",
    async () => {
      const core = makeCore();
      const projectId = "prj_empty_selector_bypass";
      insertProject(core, projectId);
      // `--session-id=` (an attached selector with no value) still counts as one occurrence; with
      // `--resume CANON` also present, two occurrences means refusal, not a fallback to whichever
      // selector has a value.
      const subject = makeSubject(core, projectId, {
        chain: standardChain({
          argv: ["/opt/claude/claude", "--session-id=", "--resume", CANON],
          command: `/opt/claude/claude --session-id= --resume ${CANON}`,
        }),
      });
      const request = baseRequest(core, projectId);
      const before = rowCounts(core);

      const result = await subject.claim(request);

      expect(result.allowed, JSON.stringify(result)).toBe(false);
      if (result.allowed) return;
      expect(result.reasonCode).toBe(ReasonCode.NOT_FOUND);
      expect(result.message).toContain("names no session id");
      expectRolledBack(core, before, result);

      const legitimateResult = await makeSubject(core, projectId).claim(baseRequest(core, projectId));
      expect(legitimateResult.allowed, JSON.stringify(legitimateResult)).toBe(true);
    },
  );

  it("clause 2 — pid and start time as a pair: an unresolvable start time refuses even though the pid matches", async () => {
    const core = makeCore();
    const projectId = "prj_no_start_time";
    insertProject(core, projectId);
    const subject = makeSubject(core, projectId, { chain: standardChain({ startedAt: null }) });
    const request = baseRequest(core, projectId);
    const before = rowCounts(core);
    const result = await subject.claim(request);

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("process start time could not be established");
    expectRolledBack(core, before, result);
  });

  it(
    "clause 2 — A→B pid reuse: the claimant's pid is re-verified after derivation, and a start-time " +
      "mismatch (a different process now answering to that pid) refuses instead of adopting process B as process A",
    async () => {
      // `deriveClaimantIdentity` reads this inspector once per pid to establish the verified
      // identity. `reusablePidInspector` answers that first read with the real claimant (process
      // A, started at T1) and every later read — each of the re-verification checkpoints — with a
      // *different* process now occupying the same pid (process B, started at T2), exactly the
      // shape a pid-reuse race produces: A exits, the kernel reissues its pid to an unrelated
      // process B, and nothing about the pid number alone reveals the swap.
      const claudePid = 10;
      const startedAtA = "Fri Jan  1 00:00:00 2027";
      const startedAtB = "Sat Jan  2 00:00:00 2027";
      let claudePidReads = 0;
      const reusablePidInspector: ProcessAncestryInspector = {
        snapshot: (pid) => {
          const entry = standardChain().find((s) => s.pid === pid);
          if (!entry) return null;
          if (pid !== claudePid) return entry;
          claudePidReads += 1;
          // First read (clause 1's derivation): the real claimant, process A. Every subsequent
          // read (each later re-verification checkpoint): process B, a different start time at
          // the identical pid.
          return claudePidReads === 1 ? { ...entry, startedAt: startedAtA } : { ...entry, startedAt: startedAtB };
        },
      };

      const core = makeCore();
      const projectId = "prj_pid_reuse";
      insertProject(core, projectId);
      const subject = new CanonicalSelfClaim(
        core.db,
        core.clock,
        core.audit,
        core.sessions,
        core.bindings,
        fakeBuzzActorAuthenticator(),
        fakeResolveBuzzAddress(),
        baseConfig(projectId),
        {
          processInspector: reusablePidInspector,
          imageInspector: fakeImageInspector(),
          transcriptReader: fakeTranscriptReader(),
        },
      );
      const request = baseRequest(core, projectId);
      const before = rowCounts(core);
      const result = await subject.claim(request);

      expect(result.allowed, JSON.stringify(result)).toBe(false);
      if (result.allowed) return;
      expect(result.reasonCode).toBe(ReasonCode.CONFLICT);
      expect(result.message).toContain("pid may have been reused");
      expect(result.evidence).toMatchObject({ pid: claudePid, verifiedStartedAt: startedAtA, observedStartedAt: startedAtB });
      // Genuinely re-verified, not a single check reused across all four checkpoints: at least
      // one re-check after the original derivation read actually ran.
      expect(claudePidReads).toBeGreaterThan(1);
      expectRolledBack(core, before, result);
    },
  );

  it("clause 2 — a headless invocation is refused as not interactive", async () => {
    const core = makeCore();
    const projectId = "prj_headless";
    insertProject(core, projectId);
    const subject = makeSubject(core, projectId, {
      chain: standardChain({
        argv: ["/usr/local/bin/claude", "-p", "--session-id", CANON],
        command: `/usr/local/bin/claude -p --session-id ${CANON}`,
      }),
    });
    const request = baseRequest(core, projectId);
    const before = rowCounts(core);
    const result = await subject.claim(request);

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("not an interactive CLI invocation");
    expectRolledBack(core, before, result);
  });

  it(
    "clause 2 — a working directory the probe never read refuses as a failed probe, not as a mismatch",
    async () => {
      // #834, measured on the live deployment: `lsof -p <pid> -FfptDin` without `-n` does reverse
      // DNS on every IPv4 socket the claimant holds. Against the real canonical claude process
      // (53 descriptors, 7 of them IPv4) that scan took 30.07s, three runs, consistent, against a
      // `SUBPROCESS_TIMEOUT_MS` of 5_000. The scan was killed, `lsofEntries` returned `[]`, the
      // cwd resolved to null, and the claim refused with "the claude ancestor's working directory
      // does not match the expected canonical workdir" — while `lsof -a -p <pid> -d cwd` reported
      // exactly the directory that was then configured. It matched; the probe that would have
      // read it never ran, and the refusal named the wrong thing.
      //
      // A null cwd is what a probe that produced no answer looks like at this seam. It is not an
      // observation of a different directory, and it must not be reported as one.
      //
      // There is no configured directory left to mismatch — the comparison and the config field
      // that fed it are both gone. This refusal is not: `identity.cwd` is written as the
      // binding's `workdir` and compared against a predecessor's on an idempotent re-claim, so
      // admitting a null would record an absence as the claimant's directory.
      const core = makeCore();
      const projectId = "prj_cwd_probe_failed";
      insertProject(core, projectId);
      const subject = makeSubject(core, projectId, { chain: standardChain({ cwd: null }) });
      const request = baseRequest(core, projectId);
      const before = rowCounts(core);
      const result = await subject.claim(request);

      expect(result.allowed).toBe(false);
      if (result.allowed) return;
      expect(result.reasonCode).toBe(ReasonCode.PROBE_FAILED);
      expect(result.message).toContain("working directory could not be read");
      expect(result.message).not.toContain("does not match");
      expect(result.evidence).toMatchObject({ pid: 10 });
      expectRolledBack(core, before, result);
    },
  );

  it(
    "the lsof scan asks for numeric names, so a claimant's sockets cannot stall it past its own timeout",
    () => {
      // Asserted on the argv the module passes, never on how long a scan takes. A timing
      // assertion here would be flaky on a machine with no network entries to resolve, and it
      // would not say which flag it is about when it failed.
      //
      // The fields requested are `f p t D i n` — fd, pid, type, device, inode, and lsof's *name*
      // field. The only two entries this module reads are the `cwd` DIR entry and the `txt` REG
      // entry, whose name field is a filesystem path; `-n`/`-P` change nothing about those. They
      // suppress hostname and port-name resolution on the network entries nothing here consults,
      // which is the 30.07s → 0.05s the canonical claim's cwd lookup was losing.
      expect(lsofScanArgv(22828)).toEqual(["-n", "-P", "-p", "22828", "-FfptDin"]);
    },
  );

  it(
    "a probe killed by its own budget classifies as TIMED_OUT, and an exit status does not",
    () => {
      // The subject is the shape of the error object, not the speed of any scan, so this needs no
      // clock and no child. 239aa3d ruled out pinning a real scan with a timing assertion — flaky
      // on a host with nothing to resolve, and a failure would say "slow" rather than name the
      // defect — and that reasoning is why the classifier is a separate function to begin with.
      expect(probeFailureKind({ code: "ETIMEDOUT" })).toBe("TIMED_OUT");
      expect(probeFailureKind({ code: "ENOENT" })).toBe("SCAN_FAILED");
      expect(probeFailureKind({})).toBe("SCAN_FAILED");

      // The field the branch used to test. `killed` decides nothing now, and asserting that is the
      // point: a future edit that reinstates it would pass every other row in this file (#838).
      expect(probeFailureKind({ killed: true } as { code?: unknown })).toBe("SCAN_FAILED");
    },
  );

  it(
    "execFileSync reports a timeout as ETIMEDOUT and never sets killed",
    () => {
      // The assumption the classifier rests on, pinned against the library rather than restated in
      // a comment. This is the exact thing that was wrong: the previous code asserted in prose that
      // `execFileSync` sets `killed` on a timeout, so `TIMED_OUT` was unreachable on every path and
      // a review that read the justification found a reason rather than a bug.
      //
      // Not a timing assertion. `sleep 5` against a 200ms budget is a 25x margin, so a slow host
      // cannot flip it, and neither lsof nor name resolution is involved. It fails only if Node
      // changes which fields it puts on the error — which is precisely when the classifier breaks.
      let thrown: { killed?: unknown; code?: unknown; signal?: unknown } | null = null;
      try {
        execFileSync("sleep", ["5"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 200 });
      } catch (error) {
        thrown = error as { killed?: unknown; code?: unknown; signal?: unknown };
      }

      expect(thrown).not.toBeNull();
      expect(thrown?.code).toBe("ETIMEDOUT");
      expect(thrown?.killed).toBeUndefined();
      expect(probeFailureKind(thrown ?? {})).toBe("TIMED_OUT");
    },
  );

  it(
    "clause 2 — an executing image the scan never reached refuses as a failed probe, not as a conflict",
    async () => {
      // The second consumer of the same scan. On Darwin `lsof` is the only channel to the
      // executing image, so a timed-out or unreachable lsof resolves every image to nothing —
      // and that used to refuse a genuine canonical claim as CONFLICT, telling the operator the
      // running binary was wrong when nothing had looked at it.
      const core = makeCore();
      const projectId = "prj_image_probe_failed";
      insertProject(core, projectId);
      const subject = makeSubject(core, projectId, { imageInspector: unscannableImageInspector() });
      const request = baseRequest(core, projectId);
      const before = rowCounts(core);
      const result = await subject.claim(request);

      expect(result.allowed).toBe(false);
      if (result.allowed) return;
      expect(result.reasonCode).toBe(ReasonCode.PROBE_FAILED);
      expect(result.message).toContain("executing image could not be scanned");
      expect(result.evidence).toMatchObject({ pid: 10, probe: "lsof", probeFailure: TIMED_OUT_SCAN });
      expectRolledBack(core, before, result);
    },
  );

  it("clause 2 — peer protocol version must match the deployment's expectation", async () => {
    const core = makeCore();
    const projectId = "prj_peer_protocol";
    insertProject(core, projectId);
    const subject = makeSubject(core, projectId);
    const request = baseRequest(core, projectId, { peerProtocolVersion: "mcp/2024-01-01" });
    const before = rowCounts(core);
    const result = await subject.claim(request);

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("peer protocol version");
    expectRolledBack(core, before, result);
  });

  it("clause 2 — target version exactly the configured required version, from the executing image, not any other observed version", async () => {
    const core = makeCore();
    const projectId = "prj_version";
    insertProject(core, projectId);
    const observedVersion = "1.2.3-wrong";
    const subject = makeSubject(core, projectId, { imageInspector: fakeImageInspector(observedVersion) });
    const request = baseRequest(core, projectId);
    const before = rowCounts(core);
    const result = await subject.claim(request);

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("not the required version");
    expect(result.evidence).toMatchObject({
      observedVersion,
      requiredVersion: TEST_REQUIRED_EXECUTOR_VERSION,
    });
    expectRolledBack(core, before, result);
  });

  it(
    "clause 2 — a renamed binary with a forged adjacent manifest (right version, wrong realpath) is rejected",
    async () => {
      // The exact attack this check closes: a version string alone can be spoofed by placing any
      // file at any path with a `package.json` claiming the required version next to it. This
      // fake reports the required version, but at a path that is not the daemon-configured
      // expected realpath — proving the realpath comparison is what catches it, not the version
      // check (which this fake, deliberately, would otherwise satisfy).
      const core = makeCore();
      const projectId = "prj_forged_realpath";
      insertProject(core, projectId);
      const subject = makeSubject(core, projectId, {
        imageInspector: fakeImageInspector(
          TEST_REQUIRED_EXECUTOR_VERSION,
          "/tmp/attacker-controlled/renamed-node-binary",
          TEST_EXPECTED_EXECUTOR_SHA256,
        ),
      });
      const request = baseRequest(core, projectId);
      const before = rowCounts(core);
      const result = await subject.claim(request);

      expect(result.allowed).toBe(false);
      if (result.allowed) return;
      expect(result.message).toContain("not at the expected realpath");
      expectRolledBack(core, before, result);
    },
  );

  it(
    "clause 2 — right version and right realpath, wrong bytes (forged hash) is rejected",
    async () => {
      // The second half of the same attack: even a file placed at the *expected* path, reporting
      // the expected version, is rejected if its actual bytes do not hash to the daemon-configured
      // expected sha256 — the property a version string and a realpath alone cannot prove.
      const core = makeCore();
      const projectId = "prj_forged_hash";
      insertProject(core, projectId);
      const subject = makeSubject(core, projectId, {
        imageInspector: fakeImageInspector(
          TEST_REQUIRED_EXECUTOR_VERSION,
          TEST_EXPECTED_EXECUTOR_REALPATH,
          `sha256:${"f".repeat(64)}`,
        ),
      });
      const request = baseRequest(core, projectId);
      const before = rowCounts(core);
      const result = await subject.claim(request);

      expect(result.allowed).toBe(false);
      if (result.allowed) return;
      expect(result.message).toContain("does not hash to the expected sha256");
      expectRolledBack(core, before, result);
    },
  );

  it("clause 2 — an unresolvable executing image refuses fail-closed", async () => {
    const core = makeCore();
    const projectId = "prj_no_image";
    insertProject(core, projectId);
    const subject = makeSubject(core, projectId, { imageInspector: { resolve: () => null } });
    const request = baseRequest(core, projectId);
    const before = rowCounts(core);
    const result = await subject.claim(request);

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("executing image could not be resolved");
    expectRolledBack(core, before, result);
  });

  it("clause 2 — the transcript must exist on disk", async () => {
    const core = makeCore();
    const projectId = "prj_no_transcript";
    insertProject(core, projectId);
    const subject = makeSubject(core, projectId, { transcriptReader: fakeTranscriptReader(false) });
    const request = baseRequest(core, projectId);
    const before = rowCounts(core);
    const result = await subject.claim(request);

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.NOT_FOUND);
    expect(result.message).toContain("no transcript exists");
    expectRolledBack(core, before, result);
  });

  it("clause 2 — the connected peer identity must match the deployment's expectation", async () => {
    const core = makeCore();
    const projectId = "prj_peer_identity";
    insertProject(core, projectId);
    const subject = makeSubject(core, projectId);
    const request = baseRequest(core, projectId, { peerIdentity: "someone-else" });
    const before = rowCounts(core);
    const result = await subject.claim(request);

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("connected peer identity");
    expectRolledBack(core, before, result);
  });

  it("the buzz channel is the configured one and is load-bearing in the attestation, not a request field to get wrong", async () => {
    // This replaces a case that sent `buzzChannelId: "DM"` in the request and expected "not the
    // canonical project channel". The request cannot carry a channel any more — the deployment's
    // channel is the only one there is — so the guard that comparison provided has become the
    // absence of the field. What is left to check is that the configured value is still what the
    // claim is attested over: two deployments differing only in their channel must not produce the
    // same attestation, or the channel would be recorded without being covered.
    const digestFor = async (canonicalBuzzChannelId: string): Promise<string> => {
      const core = makeCore();
      const projectId = "prj_channel";
      insertProject(core, projectId);
      const subject = makeSubject(core, projectId, { configOverrides: { canonicalBuzzChannelId } });
      const result = await subject.claim(baseRequest(core, projectId));
      expect(result.allowed, JSON.stringify(result)).toBe(true);
      if (!result.allowed) throw new Error("unreachable");
      // From the durable row, not the return value: the point is what was recorded.
      const rows = core.db.all<{ attestation_digest: string }>(
        `SELECT attestation_digest FROM actor_target_attestations`,
      );
      expect(rows).toHaveLength(1);
      return rows[0]!.attestation_digest;
    };

    expect(await digestFor(CHANNEL)).not.toBe(await digestFor("channel:some-other-room"));
  });

  it("clause 4 — only a configured canonical session may be adopted; a different, otherwise-valid session is refused, not bootstrapped", async () => {
    const core = makeCore();
    const projectId = "prj_other_session";
    insertProject(core, projectId);
    const subject = makeSubject(core, projectId, { chain: standardChain({}, OTHER) });
    const request = baseRequest(core, projectId, {
      claimedSessionUuid: OTHER,
    });
    const before = rowCounts(core);
    const result = await subject.claim(request);

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("only a canonical session may be adopted");
    expectRolledBack(core, before, result);
  });

  it("clause 4 — the pin is membership, not the first entry: a second configured session is adopted on its own project", async () => {
    // The whole point of the set. Before #1005 the pin was `identity.sessionUuid !== config
    // .canonicalSessionUuid`, so this claim could not exist: a deployment could name exactly one
    // adoptable session, and `cto_start` — which spawns a new provider process — was the only
    // other way to give a second running session a CTO binding.
    const core = makeCore();
    const firstProject = "prj_first_cto";
    const secondProject = "prj_second_cto";
    insertProject(core, firstProject);
    insertProject(core, secondProject);
    const canonicalSessions = [
      { sessionUuid: CANON, projectId: firstProject, buzzActorId: CANONICAL_ACTOR },
      { sessionUuid: OTHER, projectId: secondProject, buzzActorId: "buzz:second-cto" },
    ];

    const first = await makeSubject(core, firstProject, { configOverrides: { canonicalSessions } })
      .claim(baseRequest(core, firstProject));
    expect(first.allowed, JSON.stringify(first)).toBe(true);
    if (!first.allowed) return;

    // A whole second ancestry, not the first one with a field swapped: two live CTOs are two
    // processes, so every pid in the chain differs as well as the session uuid.
    // `sessions_buzz_actor` is why the two entries must also carry different actor ids.
    const secondChain: ProcessSnapshot[] = [
      { pid: 200, ppid: 150, argv: ["/usr/bin/node", "/opt/acp/mcp-server.js"],
        command: "/usr/bin/node /opt/acp/mcp-server.js", cwd: CWD, cwdProbeFailure: null, startedAt: "t1" },
      { pid: 150, ppid: 11, argv: ["/bin/zsh", "-c", "foo"], command: "/bin/zsh -c foo", cwd: CWD,
        cwdProbeFailure: null, startedAt: "t2" },
      claudeAncestor({ pid: 11 }, OTHER),
    ];
    const second = await makeSubject(core, secondProject, {
      configOverrides: { canonicalSessions },
      chain: secondChain,
    }).claim(baseRequest(core, secondProject, { callerPid: 200, claimedSessionUuid: OTHER }));
    expect(second.allowed, JSON.stringify(second)).toBe(true);
    if (!second.allowed) return;

    expect(second.value.sessionId).not.toBe(first.value.sessionId);
    expect(first.value.binding.projectId).toBe(firstProject);
    expect(second.value.binding.projectId).toBe(secondProject);
    // Each speaks as its own configured identity — not one shared actor, and not a value either
    // claimant supplied.
    expect(core.sessions.require(first.value.sessionId).buzzActorId).toBe(CANONICAL_ACTOR);
    expect(core.sessions.require(second.value.sessionId).buzzActorId).toBe("buzz:second-cto");
  });

  it("clause 4 — an entitled session claiming another project is refused, on the derived UUID and before any row", async () => {
    // The defect the set closes on its own: the old pin established *that* the claimant was the
    // canonical session and nothing compared `request.projectId` to anything, so the one entitled
    // session could assemble `PRIMARY_CTO:<any registered project>` by naming it in the request.
    const core = makeCore();
    const entitled = "prj_entitled";
    const other = "prj_not_entitled";
    insertProject(core, entitled);
    insertProject(core, other);
    const subject = makeSubject(core, entitled);

    const before = rowCounts(core);
    const result = await subject.claim(baseRequest(core, other));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.CONFLICT);
    expect(result.message).toContain("not the canonical CTO for the requested project");
    expect(result.evidence).toMatchObject({ observed: other, entitled });
    expectRolledBack(core, before, result);

    // The control: the same subject, same process, same everything but the project, succeeds — so
    // the refusal above is attributable to the entitlement and not to a broken fixture.
    const allowed = await subject.claim(baseRequest(core, entitled));
    expect(allowed.allowed, JSON.stringify(allowed)).toBe(true);
  });



  it("clause 3 — a duplicate live actor is refused with zero additional rows, even though the session insert already ran inside the transaction", async () => {
    const core = makeCore();
    const projectId = "prj_duplicate";
    insertProject(core, projectId);
    const subject = makeSubject(core, projectId);

    const first = await subject.claim(baseRequest(core, projectId));
    expect(first.allowed).toBe(true);

    // Built — and its owner approval minted — before `afterFirst` is captured, so the second
    // mint's own `INGRESS_ADMITTED` audit write does not show up as unexplained drift against it.
    const secondRequest = baseRequest(core, projectId, { expectedBindingGeneration: 2 });
    // A second subject carrying a different Buzz identity in its entry, deliberately: the first
    // session is still live and holding "buzz:canonical-cto" (`sessions_buzz_actor`'s partial
    // unique index refuses a second live session the same identity), which would otherwise deny
    // this attempt at `bindBuzzActor` — a real, earlier guard, but not the one this test targets.
    // The identity used to be a request field the second attempt could vary on its own; it is
    // configuration now, so isolating this guard means configuring it.
    const secondSubject = makeSubject(core, projectId, {
      configOverrides: {
        canonicalSessions: [
          { sessionUuid: CANON, projectId, buzzActorId: "buzz:canonical-cto-second-attempt" },
        ],
      },
    });
    const afterFirst = rowCounts(core);

    const second = await secondSubject.claim(secondRequest);
    expect(second.allowed).toBe(false);
    if (second.allowed) return;
    expect(second.reasonCode).toBe(ReasonCode.BINDING_ALREADY_ACTIVE);

    // This is the assertion that matters: `sessions.create()` ran again inside `#mutate` before
    // `bindings.bind()` denied. If the outer transaction were `db.tx` instead of `db.txDecision`
    // (see the "atomicity" describe block below for the mutation that proves this), that second
    // session row would have been committed anyway. Reading the return value alone cannot see it.
    expectRolledBack(core, afterFirst, second);
  });

  it("same-live recovery replaces the runtime while preserving the live actor", async () => {
    const core = makeCore();
    const projectId = "prj_same_live";
    insertProject(core, projectId);
    const subject = makeSubject(core, projectId);
    const first = await subject.claim(baseRequest(core, projectId));
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;
    const session = core.sessions.require(first.value.sessionId);
    const oldHash = core.db.get(`SELECT session_secret_hash FROM sessions WHERE session_id = ?`, [session.sessionId]);
    const actorBefore = core.db.get<{ actor_id: string }>(`SELECT actor_id FROM assignments WHERE assignment_id = ?`,
      [first.value.binding.assignmentId]);
    const targetBefore = core.db.all(`SELECT * FROM actor_target_bindings`);
    expect(core.bindings.revoke(roleKeyFor(Role.PRIMARY_CTO, { projectId }), "recover").allowed).toBe(true);
    const request = baseRequest(core, projectId, {
      expectedBindingGeneration: 2,
    });
    const before = rowCounts(core);
    const recovered = await subject.claim(request);
    expect(recovered.allowed, JSON.stringify(recovered)).toBe(true);
    if (!recovered.allowed) return;
    // Actor identity is durable; an ACP session row is a replaceable runtime.
    expect(recovered.value.sessionId).not.toBe(first.value.sessionId);
    const successor = core.sessions.require(recovered.value.sessionId);
    expect(successor.incarnation).not.toBe(session.incarnation);
    expect(successor).toMatchObject({
      lifecycle: SessionLifecycle.READY, osPid: session.osPid,
      osProcessStartedAt: session.osProcessStartedAt, workdir: session.workdir,
      buzzActorId: session.buzzActorId, buzzAddress: session.buzzAddress,
    });
    expect(core.sessions.require(first.value.sessionId)).toMatchObject({
      ...session, lifecycle: SessionLifecycle.STOPPED, stoppedAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(recovered.value.binding.bindingGeneration).toBe(2);
    expect(recovered.value.derivedSessionUuid).toBe(first.value.derivedSessionUuid);
    expect(core.db.get(`SELECT session_secret_hash FROM sessions WHERE session_id = ?`, [session.sessionId])).toEqual(oldHash);
    expect(core.db.all(`SELECT * FROM actor_target_bindings`)).toEqual(targetBefore);
    expect(core.db.get(`SELECT actor_id FROM assignments WHERE assignment_id = ?`,
      [recovered.value.binding.assignmentId])).toEqual(actorBefore);
    expect(core.db.get(`SELECT current_session_id, current_session_incarnation FROM conversational_actors WHERE actor_id = ?`,
      [actorBefore!.actor_id])).toEqual({ current_session_id: successor.sessionId, current_session_incarnation: successor.incarnation });
    expect(core.db.all<{ evidence_json: string }>(`SELECT evidence_json FROM audit_events WHERE session_id = ? AND kind = 'SESSION_LIFECYCLE'`,
      [successor.sessionId]).some((event) => event.evidence_json.includes(session.sessionId))).toBe(true);
    expect(recovered.value.sessionSecret).not.toBe(first.value.sessionSecret);
    expect(first.value.sessionSecret).not.toBeNull();
    expect(recovered.value.sessionSecret).not.toBeNull();
    expect(core.sessions.verifySecret(first.value.sessionId, first.value.sessionSecret!).allowed).toBe(false);
    expect(core.sessions.verifySecret(recovered.value.sessionId, recovered.value.sessionSecret!).allowed).toBe(true);
    const after = rowCounts(core);
    expect(after.sessions).toBe(before.sessions + 1);
    expect(after.conversational_actors).toBe(before.conversational_actors);
    expect(after.actor_target_bindings).toBe(before.actor_target_bindings);
    expect(after.assignments).toBe(before.assignments + 1);
    expect(after.actor_target_attestations).toBe(before.actor_target_attestations + 1);
    const replayed = await subject.claim(request);
    expect(replayed.allowed).toBe(false);
    expectRolledBack(core, after, replayed);
  });

  /**
   * #831 — the ordinary case. A session row's `lifecycle` is a record this process wrote; a
   * process's liveness is a fact the kernel holds. The predecessor row below still says READY
   * because nothing transitioned it when its process died, and the restarted runtime is a
   * genuinely different OS process. Same-live recovery is about a *live* runtime replacing its own
   * revoked attachment, so it has nothing to say here and must not answer for this case.
   */
  it("a restarted canonical runtime claims the next generation when the predecessor row is READY and its process is gone", async () => {
    const core = makeCore();
    const projectId = "prj_dead_predecessor";
    insertProject(core, projectId);
    const first = await makeSubject(core, projectId).claim(baseRequest(core, projectId));
    expect(first.allowed, JSON.stringify(first)).toBe(true);
    if (!first.allowed) return;
    const predecessor = core.sessions.require(first.value.sessionId);
    // The exact production state: the row was never reconciled, so it still reads READY.
    expect(predecessor.lifecycle).toBe(SessionLifecycle.READY);
    expect(core.bindings.revoke(roleKeyFor(Role.PRIMARY_CTO, { projectId }), "lost attachment").allowed).toBe(true);

    // The restart: a different OS process, and the pid the row still names resolves to nothing.
    const restarted = [
      standardChain()[0]!,
      { ...standardChain()[1]!, ppid: 11 },
      claudeAncestor({ pid: 11, startedAt: "Fri Jan  1 02:00:00 2027" }),
    ];
    expect(chainInspector(restarted).snapshot(predecessor.osPid!)).toBeNull();

    const claimed = await makeSubject(core, projectId, { chain: restarted }).claim(baseRequest(core, projectId, {
      expectedBindingGeneration: 2,
    }));
    expect(claimed.allowed, JSON.stringify(claimed)).toBe(true);
    if (!claimed.allowed) return;
    expect(claimed.value.binding.bindingGeneration).toBe(2);
    expect(claimed.value.sessionId).not.toBe(first.value.sessionId);
    const successor = core.sessions.require(claimed.value.sessionId);
    // The successor is the new process, never the pair the dead row named.
    expect(successor).toMatchObject({ osPid: 11, osProcessStartedAt: "Fri Jan  1 02:00:00 2027" });
    // Exactly one live session speaks as the canonical Buzz identity; the dead row is terminal.
    expect(core.sessions.require(first.value.sessionId).lifecycle).toBe(SessionLifecycle.STOPPED);
    expect(core.db.all(
      `SELECT session_id FROM sessions WHERE buzz_actor_id = ? AND lifecycle NOT IN ('STOPPED','ERROR')`,
      ["buzz:canonical-cto"],
    )).toEqual([{ session_id: successor.sessionId }]);
  });

  /**
   * #842. The twin of the test above, differing in exactly one fact: the ancestry probe answers
   * `null` for the predecessor's pid — as it does when `ps` outlives `SUBPROCESS_TIMEOUT_MS` — but
   * the process is there and answers a signal.
   *
   * Until #842 a `null` snapshot *was* the death certificate, so this claim succeeded and the role
   * moved off a live incumbent because a probe was slow. The two tests share a chain and differ
   * only in `processSignal`, which is what makes the distinction the subject rather than a
   * side effect of some other difference.
   *
   * `EPERM` is the signal error used deliberately: it is the case where the kernel confirms the
   * pid exists and this process may not signal it, which is the strongest "alive" a failed signal
   * can report. A probe that cannot even decide (`UNKNOWN`) is the same refusal for a weaker
   * reason, and the branch treats both the same way on purpose.
   */
  it("a predecessor whose ancestry probe failed but whose process answers a signal keeps the role", async () => {
    const core = makeCore();
    const projectId = "prj_probe_failed_not_dead";
    insertProject(core, projectId);
    const first = await makeSubject(core, projectId).claim(baseRequest(core, projectId));
    expect(first.allowed, JSON.stringify(first)).toBe(true);
    if (!first.allowed) return;
    const predecessor = core.sessions.require(first.value.sessionId);
    expect(predecessor.lifecycle).toBe(SessionLifecycle.READY);
    expect(core.bindings.revoke(roleKeyFor(Role.PRIMARY_CTO, { projectId }), "lost attachment").allowed).toBe(true);

    // Byte-for-byte the chain from the test above: the predecessor's pid resolves to nothing.
    const restarted = [
      standardChain()[0]!,
      { ...standardChain()[1]!, ppid: 11 },
      claudeAncestor({ pid: 11, startedAt: "Fri Jan  1 02:00:00 2027" }),
    ];
    expect(chainInspector(restarted).snapshot(predecessor.osPid!)).toBeNull();

    const claimed = await makeSubject(core, projectId, {
      chain: restarted,
      // The one difference. The pid is not in the chain, so the default probe would raise ESRCH
      // and the claim would succeed; EPERM says the process is there.
      processSignal: (pid) => {
        if (pid === predecessor.osPid) {
          throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
        }
      },
    }).claim(baseRequest(core, projectId, {
      expectedBindingGeneration: 2,
    }));

    expect(claimed.allowed, JSON.stringify(claimed)).toBe(false);
    // The incumbent is untouched: still READY, still holding the canonical Buzz identity. A role
    // handed away and handed back would satisfy a bare "refused" assertion; this does not.
    expect(core.sessions.require(first.value.sessionId).lifecycle).toBe(SessionLifecycle.READY);
    expect(core.db.all(
      `SELECT session_id FROM sessions WHERE buzz_actor_id = ? AND lifecycle NOT IN ('STOPPED','ERROR')`,
      ["buzz:canonical-cto"],
    )).toEqual([{ session_id: first.value.sessionId }]);
  });

  /**
   * The door #831 must not open. A dead process is not a released role: the incumbent's assignment
   * is still ACTIVE, and reconciling its runtime row says nothing about that. Seizing a held
   * binding on the strength of a missing process is `binding recover-dead`'s operation, with its
   * own proof and its own audit record, not a side effect of claiming.
   */
  it("a dead predecessor whose assignment is still ACTIVE does not hand the role to the restarted claimant", async () => {
    const core = makeCore();
    const projectId = "prj_dead_but_held";
    insertProject(core, projectId);
    const first = await makeSubject(core, projectId).claim(baseRequest(core, projectId));
    expect(first.allowed, JSON.stringify(first)).toBe(true);
    if (!first.allowed) return;
    // Deliberately no revoke: the binding stays ACTIVE while the runtime behind it dies.
    expect(core.db.all(`SELECT assignment_id FROM assignments WHERE status = 'ACTIVE'`)).toHaveLength(1);

    const restarted = [
      standardChain()[0]!,
      { ...standardChain()[1]!, ppid: 11 },
      claudeAncestor({ pid: 11, startedAt: "Fri Jan  1 02:00:00 2027" }),
    ];
    const request = baseRequest(core, projectId, {
      expectedBindingGeneration: 2,
    });
    const before = durableSnapshot(core);
    const refused = await makeSubject(core, projectId, { chain: restarted }).claim(request);
    expect(refused.allowed).toBe(false);
    if (refused.allowed) return;
    expect(refused.reasonCode).toBe(ReasonCode.BINDING_ALREADY_ACTIVE);
    // Including the predecessor's lifecycle: the reconciliation rolls back with the refusal.
    expectDurablyRolledBack(core, before, refused);
  });

  /**
   * "Unknown is never gone" — the half of the liveness read that nothing else in this file
   * reaches. The sibling test below supplies a live predecessor with a readable token; this one
   * supplies a live predecessor whose token cannot be read, which is a real shape on the default
   * inspector (`ps` answers while `readProcessStartToken` returns null on a native or kernel
   * failure), not a contrived one.
   *
   * The consequence of reading it the other way is not a missed refusal, it is an eviction: an
   * unreadable token on a *live* pid would take the abandoned-runtime path, skip every #824
   * ownership guard, transition the live holder to STOPPED and hand the role to a stranger
   * whenever the assignment happens to be REVOKED. So the assertion is the reason code and the
   * message — the same-live branch answering — not merely that something refused.
   */
  it("a predecessor pid that is live but whose start token cannot be read is not gone", async () => {
    const core = makeCore();
    const projectId = "prj_unreadable_token";
    insertProject(core, projectId);
    const first = await makeSubject(core, projectId).claim(baseRequest(core, projectId));
    expect(first.allowed, JSON.stringify(first)).toBe(true);
    if (!first.allowed) return;
    const predecessor = core.sessions.require(first.value.sessionId);
    expect(predecessor.osProcessStartedAt).not.toBeNull();
    expect(core.bindings.revoke(roleKeyFor(Role.PRIMARY_CTO, { projectId }), "lost attachment").allowed).toBe(true);

    // pid 10 — the predecessor's own runtime — is still there; only its start token is unreadable.
    // The claimant is pid 11, a different process on the same ancestry.
    const unreadable = [
      standardChain()[0]!,
      { ...standardChain()[1]!, ppid: 11 },
      claudeAncestor({ pid: 11 }),
      claudeAncestor({ pid: 10, startedAt: null }),
    ];
    const observed = chainInspector(unreadable).snapshot(predecessor.osPid!);
    expect(observed).not.toBeNull();
    expect(observed?.startedAt).toBeNull();

    const request = baseRequest(core, projectId, {
      expectedBindingGeneration: 2,
    });
    const before = durableSnapshot(core);
    const refused = await makeSubject(core, projectId, { chain: unreadable }).claim(request);
    expect(refused.allowed).toBe(false);
    if (refused.allowed) return;
    expect(refused.reasonCode).toBe(ReasonCode.CONFLICT);
    // The same-live branch is what answered; an unreadable token did not route this to the
    // abandoned-runtime path and then refuse for some unrelated reason further down.
    expect(refused.message).toBe("same-live recovery requires the exact idle revoked runtime");
    expectDurablyRolledBack(core, before, refused);
    expect(core.sessions.require(predecessor.sessionId).lifecycle).toBe(SessionLifecycle.READY);
  });

  /**
   * #824's recycled-pid property, on the shape #831 leaves reachable. The claimant occupies the
   * predecessor's pid under a different start token, so the recorded process is gone and the claim
   * is the ordinary one. What must not happen is the claimant being credited with the
   * predecessor's runtime: the successor row records the claimant's own verified pair, so the two
   * rows stay distinguishable as different processes despite sharing a pid.
   */
  it("a recycled pid never lets the claimant inherit the predecessor's runtime", async () => {
    const core = makeCore();
    const projectId = "prj_recycled_pid";
    insertProject(core, projectId);
    const first = await makeSubject(core, projectId).claim(baseRequest(core, projectId));
    expect(first.allowed, JSON.stringify(first)).toBe(true);
    if (!first.allowed) return;
    const predecessor = core.sessions.require(first.value.sessionId);
    expect(core.bindings.revoke(roleKeyFor(Role.PRIMARY_CTO, { projectId }), "lost attachment").allowed).toBe(true);

    // Same pid, different lifetime: the process the row named is gone and another holds its number.
    const recycled = standardChain({ startedAt: "different lifetime" });
    expect(chainInspector(recycled).snapshot(predecessor.osPid!)?.startedAt).not.toBe(predecessor.osProcessStartedAt);

    const claimed = await makeSubject(core, projectId, { chain: recycled }).claim(baseRequest(core, projectId, {
      expectedBindingGeneration: 2,
    }));
    expect(claimed.allowed, JSON.stringify(claimed)).toBe(true);
    if (!claimed.allowed) return;
    const successor = core.sessions.require(claimed.value.sessionId);
    expect(successor.sessionId).not.toBe(predecessor.sessionId);
    // The claimant's own pair, never the predecessor's — a same-live recovery would have required
    // these two to be equal, which is exactly the claim a recycled pid may not make.
    expect(successor.osPid).toBe(predecessor.osPid);
    expect(successor.osProcessStartedAt).toBe("different lifetime");
    expect(successor.osProcessStartedAt).not.toBe(predecessor.osProcessStartedAt);
    expect(core.sessions.require(predecessor.sessionId).lifecycle).toBe(SessionLifecycle.STOPPED);
  });

  /**
   * The other half of the same question, and the one that must stay shut: the predecessor's
   * `(osPid, start token)` pair *does* resolve to a live process, and the claimant is a different
   * one. That is a foreign live holder, and #824 refuses it. Asserting the reason code — not just
   * refusal — is what separates this from the unrelated `bindBuzzActor` denial a deleted branch
   * would produce instead.
   */
  it("a predecessor whose process is alive under a pid the claimant does not share stays refused", async () => {
    const core = makeCore();
    const projectId = "prj_foreign_live";
    insertProject(core, projectId);
    const first = await makeSubject(core, projectId).claim(baseRequest(core, projectId));
    expect(first.allowed, JSON.stringify(first)).toBe(true);
    if (!first.allowed) return;
    const predecessor = core.sessions.require(first.value.sessionId);
    expect(core.bindings.revoke(roleKeyFor(Role.PRIMARY_CTO, { projectId }), "lost attachment").allowed).toBe(true);

    // pid 10 — the predecessor's own runtime — is still running, under the exact pair the row
    // recorded. The claimant is pid 11, a different process on the same ancestry.
    const foreign = [
      standardChain()[0]!,
      { ...standardChain()[1]!, ppid: 11 },
      claudeAncestor({ pid: 11 }),
      claudeAncestor({ pid: 10 }),
    ];
    expect(chainInspector(foreign).snapshot(predecessor.osPid!)?.startedAt).toBe(predecessor.osProcessStartedAt);

    // Built — and its approval minted — before the snapshot, so the mint's own ingress rows are
    // not read back as drift the refusal failed to roll back.
    const request = baseRequest(core, projectId, {
      expectedBindingGeneration: 2,
    });
    const before = durableSnapshot(core);
    const refused = await makeSubject(core, projectId, { chain: foreign }).claim(request);
    expect(refused.allowed).toBe(false);
    if (refused.allowed) return;
    expect(refused.reasonCode).toBe(ReasonCode.CONFLICT);
    expectDurablyRolledBack(core, before, refused);
  });

  it("clause 4 restore — the same external session, reclaimed after a revoke, reuses the actor and target binding rather than minting a second owner", async () => {
    const core = makeCore();
    const projectId = "prj_restore";
    insertProject(core, projectId);
    const subject = makeSubject(core, projectId);

    const first = await subject.claim(baseRequest(core, projectId));
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;
    const firstActorId = core.db.get<{ actor_id: string }>(
      `SELECT actor_id FROM assignments WHERE assignment_id = ?`,
      [first.value.binding.assignmentId],
    )?.actor_id;
    expect(firstActorId).toBeTruthy();

    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    const revoked = core.bindings.revoke(roleKey, "restart");
    expect(revoked.allowed).toBe(true);
    // The old runtime is actually gone, not merely revoked at the role layer: `sessions_buzz_actor`
    // is a partial unique index over *live* sessions only, so a still-READY first session would
    // otherwise keep "buzz:canonical-cto" and refuse the restore's own `bindBuzzActor` — a real
    // guard, correctly firing, but for a scenario ("both runtimes alive at once") this test is not
    // about. A genuine restart transitions the old session to a terminal state first.
    const stopped = core.sessions.transition(first.value.sessionId, SessionLifecycle.STOPPED, "restart");
    expect(stopped.allowed).toBe(true);

    const restoreSubject = makeSubject(core, projectId, {
      chain: standardChain({ startedAt: "Fri Jan  1 01:00:00 2027" }),
    });
    const before = rowCounts(core);
    const restored = await restoreSubject.claim(baseRequest(core, projectId, {
      expectedBindingGeneration: 2,
    }));

    expect(restored.allowed, JSON.stringify(restored)).toBe(true);
    if (!restored.allowed) return;
    expect(restored.value.sessionId).not.toBe(first.value.sessionId);

    const restoredActorId = core.db.get<{ actor_id: string }>(
      `SELECT actor_id FROM assignments WHERE assignment_id = ?`,
      [restored.value.binding.assignmentId],
    )?.actor_id;
    expect(restoredActorId).toBe(firstActorId);

    const after = rowCounts(core);
    expect(after.sessions).toBe(before.sessions + 1);
    expect(after.assignments).toBe(before.assignments + 1);
    expect(after.actor_target_attestations).toBe(before.actor_target_attestations + 1);
    expect(after.conversational_actors).toBe(before.conversational_actors);
    expect(after.actor_target_bindings).toBe(before.actor_target_bindings);
  });

  it("clause 5 — never creates or touches a Hermes/CEO actor; the resulting actor's kind is PRIMARY_CTO alone", async () => {
    const core = makeCore();
    const projectId = "prj_no_hermes";
    insertProject(core, projectId);
    const subject = makeSubject(core, projectId);

    const result = await subject.claim(baseRequest(core, projectId));
    expect(result.allowed).toBe(true);

    const kinds = core.db.all<{ kind: string }>(`SELECT kind FROM conversational_actors`);
    expect(kinds).toEqual([{ kind: "PRIMARY_CTO" }]);
    const ceoRows = core.db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM assignments WHERE role = 'CEO'`,
    );
    expect(ceoRows?.c).toBe(0);
  });

  it("an unresolvable buzz address refuses before the transaction ever opens", async () => {
    const core = makeCore();
    const projectId = "prj_no_buzz_address";
    insertProject(core, projectId);
    const subject = makeSubject(core, projectId, {
      resolveBuzzAddress: fakeResolveBuzzAddress(deny(ReasonCode.PROBE_FAILED, "buzz transport is not available", {})),
    });
    const request = baseRequest(core, projectId);
    const before = rowCounts(core);
    const result = await subject.claim(request);

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.PROBE_FAILED);
    expectRolledBack(core, before, result);
  });

  it("an unauthenticated buzz actor id refuses with zero additional rows, even after the session was created", async () => {
    const core = makeCore();
    const projectId = "prj_bad_buzz_actor";
    insertProject(core, projectId);
    const subject = makeSubject(core, projectId, { buzzActorAuthenticator: fakeBuzzActorAuthenticator(false) });
    const request = baseRequest(core, projectId);
    const before = rowCounts(core);
    const result = await subject.claim(request);

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED);
    expectRolledBack(core, before, result);
  });


  it("rejects a non-positive expected binding generation as an argument error", async () => {
    const core = makeCore();
    const projectId = "prj_bad_generation";
    insertProject(core, projectId);
    const subject = makeSubject(core, projectId);

    const result = await subject.claim(baseRequest(core, projectId, { expectedBindingGeneration: 0 }));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
  });
});

describe("every decision claim() hands back leaves exactly one audit row", () => {
  // The defect this pins: the primitive that adopts a running session wrote nothing to
  // `audit_events`, so a claim refused for weeks left no row saying so. Each case below reads the
  // decision rows back exactly, so a second row or a missing one fails; the refusal cases that
  // count the whole table as well also fail on a row the rolled-back mutation should not have left.

  it("a refusal of an unconfigured session leaves exactly one audit row carrying its reason code", async () => {
    const core = makeCore();
    const projectId = "prj_audit_unconfigured";
    insertProject(core, projectId);
    const subject = makeSubject(core, projectId, { chain: standardChain({}, OTHER) });
    const totalBefore = auditTotal(core);

    const result = await subject.claim(baseRequest(core, projectId, { claimedSessionUuid: OTHER }));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.CONFLICT);
    expect(claimDecisionRows(core)).toEqual([{
      kind: "CANONICAL_SELF_CLAIM_REFUSED",
      reason_code: ReasonCode.CONFLICT,
      project_id: projectId,
      session_id: null,
      role_key: null,
      evidence: { identity: OTHER },
    }]);
    expect(auditTotal(core)).toBe(totalBefore + 1);
  });

  it("a successful adoption leaves exactly one audit row naming the admitted session and its role key", async () => {
    const core = makeCore();
    const projectId = "prj_audit_admitted";
    insertProject(core, projectId);
    const subject = makeSubject(core, projectId);

    const result = await subject.claim(baseRequest(core, projectId));

    expect(result.allowed, JSON.stringify(result)).toBe(true);
    if (!result.allowed) return;
    expect(claimDecisionRows(core)).toEqual([{
      kind: "CANONICAL_SELF_CLAIM_ADMITTED",
      reason_code: ReasonCode.OK,
      project_id: projectId,
      session_id: result.value.sessionId,
      role_key: roleKeyFor(Role.PRIMARY_CTO, { projectId }),
      evidence: { identity: CANON, generation: 1 },
    }]);
    // The receipt carries the session secret back to the claimant; the durable record must not.
    const secret = result.value.sessionSecret;
    if (secret !== null) {
      expect(JSON.stringify(core.db.all(`SELECT * FROM audit_events`))).not.toContain(secret);
    }
  });

  it("a refusal from inside the rolled-back transaction still leaves its one row, and none of the mutation's own", async () => {
    const core = makeCore();
    const projectId = "prj_audit_generation";
    insertProject(core, projectId);
    const subject = makeSubject(core, projectId);
    const totalBefore = auditTotal(core);

    const result = await subject.claim(baseRequest(core, projectId, { expectedBindingGeneration: 2 }));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("expected binding generation does not match");
    expect(claimDecisionRows(core)).toEqual([expect.objectContaining({
      kind: "CANONICAL_SELF_CLAIM_REFUSED", reason_code: ReasonCode.CONFLICT, project_id: projectId,
    })]);
    expect(auditTotal(core)).toBe(totalBefore + 1);
  });

  it("a claimed session that is not a UUID is recorded by its reason code without storing the caller's text", async () => {
    const core = makeCore();
    const projectId = "prj_audit_not_a_uuid";
    insertProject(core, projectId);
    const subject = makeSubject(core, projectId);
    const callerText = "not-a-uuid: arbitrary caller text that must not become a durable record";

    const result = await subject.claim(baseRequest(core, projectId, { claimedSessionUuid: callerText }));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
    expect(claimDecisionRows(core)).toEqual([expect.objectContaining({
      kind: "CANONICAL_SELF_CLAIM_REFUSED", reason_code: ReasonCode.INVALID_ARGUMENT, evidence: { identity: null },
    })]);
    expect(JSON.stringify(core.db.all(`SELECT * FROM audit_events`))).not.toContain("arbitrary caller text");
  });

  it("a refusal handed back from the Buzz resolver is recorded with that resolver's reason code", async () => {
    const core = makeCore();
    const projectId = "prj_audit_buzz";
    insertProject(core, projectId);
    const subject = makeSubject(core, projectId, {
      resolveBuzzAddress: fakeResolveBuzzAddress(deny(ReasonCode.NOT_FOUND, "no such channel", {})),
    });
    const totalBefore = auditTotal(core);

    const result = await subject.claim(baseRequest(core, projectId));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.NOT_FOUND);
    expect(claimDecisionRows(core)).toEqual([expect.objectContaining({
      kind: "CANONICAL_SELF_CLAIM_REFUSED", reason_code: ReasonCode.NOT_FOUND, project_id: projectId,
    })]);
    expect(auditTotal(core)).toBe(totalBefore + 1);
  });

  // The request, the configured entry and the committed binding are three candidate sources for an
  // admission row's project and role key, and in an ordinary admission all three agree — so a row
  // built from the request cannot be told apart from one built from the binding. They disagree
  // only if the request changes under the claim, and `request` is the caller's object. Here the
  // first read, the one `claim()` snapshots as what was asked, names one registered project; every
  // read `#decide` makes before the Buzz await names the entitled one, so the claim is admitted on
  // the entitlement; and every read after that await names a third. The row must name the entitled
  // project whichever of the other two a regression reaches for, which is why there are two.
  it("an admission row names the project and role key the binding committed, not any the request carried", async () => {
    const core = makeCore();
    const entitled = "prj_audit_entitled";
    const snapshotted = "prj_audit_snapshotted_from_the_request";
    const afterAwait = "prj_audit_read_from_the_request_after_the_await";
    for (const projectId of [entitled, snapshotted, afterAwait]) insertProject(core, projectId);
    const request = baseRequest(core, entitled);
    let current = entitled;
    let reads = 0;
    Object.defineProperty(request, "projectId", {
      enumerable: true,
      get: () => (reads++ === 0 ? snapshotted : current),
    });
    const subject = makeSubject(core, entitled, {
      resolveBuzzAddress: async () => {
        current = afterAwait;
        return allow(ReasonCode.OK, BUZZ_ADDRESS);
      },
    });

    const result = await subject.claim(request);

    expect(result.allowed, JSON.stringify(result)).toBe(true);
    if (!result.allowed) return;
    expect(result.value.binding.projectId).toBe(entitled);
    // The fixture did what it says: the request did name all three, in that order.
    expect(reads).toBeGreaterThan(1);
    expect(request.projectId).toBe(afterAwait);
    expect(claimDecisionRows(core)).toEqual([{
      kind: "CANONICAL_SELF_CLAIM_ADMITTED",
      reason_code: ReasonCode.OK,
      project_id: entitled,
      session_id: result.value.sessionId,
      role_key: roleKeyFor(Role.PRIMARY_CTO, { projectId: entitled }),
      evidence: { identity: CANON, generation: 1 },
    }]);
  });

  // ACP-REVIEW-01. The operator accepts any nonempty string as `projectId`, so before this bound a
  // refusal copied caller text straight into a durable column `AuditLog.record` does not redact.
  // The token is assembled here rather than written out, so this file holds the shape of a
  // credential and nothing a scanner or a reader could take for one.
  it("a refusal naming a project the registry does not hold records a null project and keeps its reason code", async () => {
    const core = makeCore();
    const registered = "prj_audit_registered";
    insertProject(core, registered);
    const subject = makeSubject(core, registered);
    const privatePath = "/private/transcripts/session.txt";
    const token = ["Bearer", "fixture".padEnd(40, "0")].join(" ");
    const unregistered = `${privatePath} ${token}`;
    const totalBefore = auditTotal(core);

    const result = await subject.claim(baseRequest(core, unregistered, { expectedBindingGeneration: 0 }));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
    expect(claimDecisionRows(core)).toEqual([{
      kind: "CANONICAL_SELF_CLAIM_REFUSED",
      reason_code: ReasonCode.INVALID_ARGUMENT,
      project_id: null,
      session_id: null,
      role_key: null,
      evidence: { identity: CANON },
    }]);
    expect(auditTotal(core)).toBe(totalBefore + 1);
    const everyAuditRow = JSON.stringify(core.db.all(`SELECT * FROM audit_events`));
    expect(everyAuditRow).not.toContain(privatePath);
    expect(everyAuditRow).not.toContain(token);
  });

  it("a registry lookup that fails records a null project and changes nothing about the decision", async () => {
    const core = makeCore();
    const projectId = "prj_audit_lookup_fails";
    insertProject(core, projectId);
    const subject = makeSubject(core, projectId);
    const get = core.db.get.bind(core.db);
    const spy = vi.spyOn(core.db, "get").mockImplementation(((sql: string, params?: unknown[]) => {
      if (sql.includes("FROM projects")) throw new Error("injected projects lookup failure");
      return get(sql, params);
    }) as typeof core.db.get);

    let result: Decision<unknown>;
    try {
      result = await subject.claim(baseRequest(core, projectId, { expectedBindingGeneration: 0 }));
    } finally { spy.mockRestore(); }

    expect(result).toMatchObject({ allowed: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
    expect(claimDecisionRows(core)).toEqual([expect.objectContaining({
      kind: "CANONICAL_SELF_CLAIM_REFUSED", reason_code: ReasonCode.INVALID_ARGUMENT, project_id: null,
    })]);
  });
});

describe("adversarial mutations — each must kill its guard, not merely delete the string it greps for", () => {
  const AUTHORITY_ROOT = process.cwd();
  const AUTHORITY_ROOT_REALPATH = realpathSync(AUTHORITY_ROOT);
  const AUTHORITY_MODULE_PATH = join(AUTHORITY_ROOT, "src", "registry", "canonical-self-claim.ts");
  const AUTHORITY_MODULE_REALPATH = realpathSync(AUTHORITY_MODULE_PATH);
  const TEST_RELATIVE_PATH = ["tests", "unit", "canonical-self-claim.test.ts"] as const;

  /**
   * #872. Each nested run takes ~800ms on an idle host. This bound is not a performance
   * assertion — it is the point past which the child is a wedge rather than a slow answer, and
   * it must stay below the enclosing `it` timeout so the failure names this command instead of
   * being reported against whichever test the worker happened to hold. The measurement that
   * motivated it: one such run took 202,353ms under full-suite load while `execFileSync` blocked
   * the event loop, so the enclosing 60s timeout could not fire at all.
   */
  const NESTED_RUN_BUDGET_MS = 120_000;

  /**
   * Deliberately above `NESTED_RUN_BUDGET_MS` plus the scratch-tree copy that happens outside the
   * bound, so the bound is what fires on a wedged child. If this were the tighter of the two, the
   * failure would again be a bare per-test timeout that names no command and reaps no group.
   */
  const MUTATION_TEST_TIMEOUT_MS = 180_000;

  /**
   * A disposable, independent copy of this repository's `src/` and `tests/` trees under a fresh
   * temp directory outside every checked-out worktree. A mutation is applied only inside this
   * copy; the checked-out tree at `AUTHORITY_ROOT` is opened for reading here, never for writing.
   * `node_modules` is symlinked — large, shared, and never itself mutated — everything a mutation
   * could touch (`src/`, `tests/`, the relevant config files) is copied as real, independent
   * files, not links back into the checkout.
   */
  const buildScratchRepo = (): string => {
    const scratchRoot = mkdtempSync(join(tmpdir(), "acp-mutation-scratch-"));
    cpSync(join(AUTHORITY_ROOT, "src"), join(scratchRoot, "src"), { recursive: true });
    cpSync(join(AUTHORITY_ROOT, "tests"), join(scratchRoot, "tests"), { recursive: true });
    for (const config of ["package.json", "tsconfig.json", "tsconfig.build.json", "vitest.config.ts"]) {
      const source = join(AUTHORITY_ROOT, config);
      if (existsSync(source)) copyFileSync(source, join(scratchRoot, config));
    }
    // Narrowed to this one file, since this copy carries only `src/` and `tests/` — not the
    // sibling top-level directories the full repository's own `tests/**/*.test.ts` glob also
    // reaches.
    const scratchConfigPath = join(scratchRoot, "vitest.config.ts");
    const scratchConfig = readFileSync(scratchConfigPath, "utf8");
    const narrowedConfig = scratchConfig.replace(
      'include: ["tests/**/*.test.ts"],',
      `include: [${JSON.stringify(TEST_RELATIVE_PATH.join("/"))}],`,
    );
    if (narrowedConfig === scratchConfig) {
      throw new Error("scratch vitest config narrowing target not found — the config shape changed");
    }
    writeFileSync(scratchConfigPath, narrowedConfig);
    symlinkSync(join(AUTHORITY_ROOT, "node_modules"), join(scratchRoot, "node_modules"));
    return scratchRoot;
  };

  /** True only if `candidate` is strictly under `root` (never equal to it, never above it). */
  const isStrictlyUnder = (candidate: string, root: string): boolean => candidate.startsWith(`${root}${sep}`);

  it("the scratch harness copies real, independent files — never a symlink back into the checked-out tree", () => {
    const scratchRoot = buildScratchRepo();
    try {
      const scratchRootRealpath = realpathSync(scratchRoot);
      expect(lstatSync(join(scratchRoot, "src")).isSymbolicLink()).toBe(false);
      expect(lstatSync(join(scratchRoot, "tests")).isSymbolicLink()).toBe(false);
      const scratchModuleRealpath = realpathSync(join(scratchRoot, "src", "registry", "canonical-self-claim.ts"));
      expect(isStrictlyUnder(scratchModuleRealpath, scratchRootRealpath)).toBe(true);
      expect(scratchModuleRealpath).not.toBe(AUTHORITY_MODULE_REALPATH);
      expect(
        scratchModuleRealpath === AUTHORITY_ROOT_REALPATH || isStrictlyUnder(scratchModuleRealpath, AUTHORITY_ROOT_REALPATH),
      ).toBe(false);
      // A real, independent copy, not merely a differently-located one: identical bytes at this
      // instant, on two files that do not share an inode path.
      expect(readFileSync(scratchModuleRealpath, "utf8")).toBe(readFileSync(AUTHORITY_MODULE_PATH, "utf8"));
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  /**
   * Applies a source mutation inside a fresh scratch copy — never the checked-out tree — and runs
   * the one named test in a subprocess rooted at that copy. `expectKilled` states which outcome
   * this call requires; a mismatch is a real finding about the guard, not something this helper
   * reshapes to look right.
   *
   * Which file the child actually executed is read back from Vitest's own JSON reporter (its
   * `testResults[0].name`, an absolute path) rather than assumed from the arguments passed to it.
   * Combined with the containment checks below and `../../src/registry/canonical-self-claim.ts`
   * being a relative specifier resolved purely from the importing file's own location — a fact
   * about how a fresh OS process resolves ES module specifiers, not something either process
   * caches or shares — the module this run loaded can only be the scratch copy.
   */
  const proveMutationOutcome = async (
    mutate: (source: string) => string,
    testNameFragment: string,
    expectKilled: boolean,
  ): Promise<void> => {
    const authorityBytesBefore = readFileSync(AUTHORITY_MODULE_PATH, "utf8");
    const scratchRoot = buildScratchRepo();
    try {
      const scratchRootRealpath = realpathSync(scratchRoot);
      const scratchModulePath = join(scratchRoot, "src", "registry", "canonical-self-claim.ts");
      const scratchModuleRealpath = realpathSync(scratchModulePath);
      // Built from the realpath, not the raw `mkdtempSync` result: Vitest's own JSON reporter
      // reports the resolved form, and on macOS `/tmp` is itself a symlink to `/private/tmp`
      // (`/var` to `/private/var`).
      const scratchTestFile = join(scratchRootRealpath, ...TEST_RELATIVE_PATH);

      expect(isStrictlyUnder(scratchModuleRealpath, scratchRootRealpath)).toBe(true);
      expect(
        scratchModuleRealpath === AUTHORITY_ROOT_REALPATH || isStrictlyUnder(scratchModuleRealpath, AUTHORITY_ROOT_REALPATH),
      ).toBe(false);

      const original = readFileSync(scratchModulePath, "utf8");
      const mutated = mutate(original);
      expect(mutated, "mutation did not change anything — the target string was not found").not.toBe(original);
      writeFileSync(scratchModulePath, mutated);
      expect(readFileSync(AUTHORITY_MODULE_PATH, "utf8")).toBe(authorityBytesBefore);

      const resultPath = join(scratchRoot, "mutation-result.json");
      const nested = await runBoundedChild(
        process.execPath,
        [
          join(scratchRoot, "node_modules", "vitest", "vitest.mjs"),
          "run",
          // Relative to `cwd` (set to `scratchRoot` below), not `scratchTestFile`'s absolute
          // form: this Vitest build's file-filter matching does not resolve an absolute
          // positional argument against a narrowed `include` pattern the way it resolves a
          // relative one.
          TEST_RELATIVE_PATH.join("/"),
          "-t",
          testNameFragment,
          "--reporter=json",
          `--outputFile.json=${resultPath}`,
        ],
        { cwd: scratchRoot, budgetMs: NESTED_RUN_BUDGET_MS },
      );

      // The three ways this child can end are three different facts, and only the third is a
      // statement about the mutation. A child that never started, or that was reaped at its
      // budget, throws out of `runBoundedChild` naming the argv. A child that ran but produced no
      // report is named here, with its status and the tail of what it said. Only a child that ran
      // and wrote its report gets its exit status read as a verdict — which is what `expectKilled`
      // is about to assert on.
      if (!existsSync(resultPath)) {
        throw new Error(
          `the nested vitest run exited ${nested.status} without writing ${resultPath}, so it never ` +
            `reported on "${testNameFragment}" and its status is not evidence about the mutation. ` +
            `stderr tail: ${nested.stderr.slice(-800)}`,
        );
      }
      const report = JSON.parse(readFileSync(resultPath, "utf8")) as {
        numPassedTests: number;
        numFailedTests: number;
        testResults: Array<{ name: string }>;
      };
      expect(report.testResults[0]?.name).toBe(scratchTestFile);

      // `-t` compiles to a RegExp, so a retitled test, a typo, or a title whose punctuation the
      // pattern does not match selects nothing — and a run that selected nothing exits 0 with
      // every test skipped. Measured: replacing one fragment with an unmatchable string left the
      // `expectKilled: false` row green while no test had run, so the row's documented finding
      // was being reported as confirmed by a run that observed nothing.
      const executed = report.numPassedTests + report.numFailedTests;
      expect(
        executed,
        `the -t fragment ${JSON.stringify(testNameFragment)} selected no test in the scratch copy, ` +
          "so this run says nothing about the mutation",
      ).toBeGreaterThan(0);

      // The report is the authority on what the run found; the exit status is a second reading of
      // the same fact. When they disagree the child ended for a reason outside the mutation, and
      // neither number may be read as a verdict about it.
      const failed = report.numFailedTests > 0;
      expect(
        failed,
        `the nested run's report (${report.numFailedTests} failed of ${executed} executed) and its ` +
          `exit status (${nested.status}) disagree, so the run ended for a reason this harness did ` +
          `not ask about. stderr tail: ${nested.stderr.slice(-800)}`,
      ).toBe(nested.status !== 0);

      expect(
        failed,
        expectKilled
          ? "the mutated guard did not kill its own test"
          : "documented finding: expected this mutation to leave its named test passing, but it failed instead",
      ).toBe(expectKilled);
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
      expect(readFileSync(AUTHORITY_MODULE_PATH, "utf8")).toBe(authorityBytesBefore);
    }
  };

  it(
    "atomicity: swapping the outer db.txDecision for db.tx lets a denied bind's session insert survive",
    async () => {
      await proveMutationOutcome(
        (source) =>
          source.replace(
            "return this.db.txDecision((): Decision<CanonicalSelfClaimReceipt> => {",
            "return this.db.tx((): Decision<CanonicalSelfClaimReceipt> => {",
          ),
        "same-live recovery rollback after real bind callee",
        true,
      );
    },
    MUTATION_TEST_TIMEOUT_MS,
  );

  it(
    "identity substitution: trusting the caller's claimed UUID instead of the derived one un-kills the mismatch refusal",
    async () => {
      await proveMutationOutcome(
        (source) =>
          source.replace(
            "if (identity.sessionUuid !== request.claimedSessionUuid.toLowerCase()) {",
            "if (false) {",
          ),
        "clause 1 — a caller-supplied session UUID is checked against the derived one",
        true,
      );
    },
    MUTATION_TEST_TIMEOUT_MS,
  );

  it(
    "pid-without-start-time: deleting the start-time pairing check admits a caller whose process identity was never confirmed",
    async () => {
      await proveMutationOutcome(
        (source) => source.replace("if (identity.startedAt === null) {", "if (false) {"),
        "clause 2 — pid and start time as a pair",
        true,
      );
    },
    MUTATION_TEST_TIMEOUT_MS,
  );
});
