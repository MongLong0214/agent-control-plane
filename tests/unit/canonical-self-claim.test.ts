import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OwnerAuthority, type OwnerApprovalReceipt, type OwnerAuthorityPort } from "../../src/ceo/owner-authority.ts";
import { type Decision, allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { roleKeyFor, Role, SessionLifecycle } from "../../src/domain/types.ts";
import { IngressGuard, ownerApprovalPayload } from "../../src/ingress/ingress-guard.ts";
import type { BuzzActorAuthenticator } from "../../src/session/session-registry.ts";
import {
  CANONICAL_PROJECT_BUZZ_CHANNEL_ID,
  CANONICAL_SESSION_UUID,
  CanonicalSelfClaim,
  REQUIRED_EXECUTOR_VERSION,
  SELF_CLAIM_OPERATION,
  canonicalSelfClaimParameterDigest,
  deriveClaimantIdentity,
  extractSessionUuidFromCommand,
  isInteractiveClaudeInvocation,
  looksLikeClaudeInvocation,
  type CanonicalSelfClaimConfig,
  type CanonicalSelfClaimRequest,
  type ExecutingImageInspector,
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
const BUZZ_ADDRESS = "buzz://test-canonical-cto";

const FIVE_TABLES = [
  "sessions",
  "conversational_actors",
  "assignments",
  "actor_target_bindings",
  "actor_target_attestations",
] as const;

const rowCounts = (core: CoreHarness): Record<(typeof FIVE_TABLES)[number], number> =>
  Object.fromEntries(
    FIVE_TABLES.map((table) => [
      table,
      core.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)?.c ?? -1,
    ]),
  ) as Record<(typeof FIVE_TABLES)[number], number>;

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

const claudeAncestor = (overrides: Partial<ProcessSnapshot> = {}, sessionUuid = CANON): ProcessSnapshot => ({
  pid: 10,
  ppid: 1,
  command: `/usr/bin/node /opt/claude/claude --session-id ${sessionUuid}`,
  cwd: CWD,
  startedAt: "Fri Jan  1 00:00:00 2027",
  ...overrides,
});

const standardChain = (overrides: Partial<ProcessSnapshot> = {}, sessionUuid = CANON): ProcessSnapshot[] => [
  { pid: 100, ppid: 50, command: "/usr/bin/node /opt/acp/mcp-server.js", cwd: CWD, startedAt: "t1" },
  { pid: 50, ppid: 10, command: "/bin/zsh -c foo", cwd: CWD, startedAt: "t2" },
  claudeAncestor(overrides, sessionUuid),
];

const fakeImageInspector = (version = REQUIRED_EXECUTOR_VERSION): ExecutingImageInspector => ({
  resolve: () => ({ imagePath: "/fake/versions/current/claude", version }),
});

const fakeTranscriptReader = (present = true): TranscriptReader => ({
  locate: (sessionUuid) => (present ? { path: `/fake/transcripts/${sessionUuid}.jsonl`, sizeBytes: 42 } : null),
});

const baseConfig = (overrides: Partial<CanonicalSelfClaimConfig> = {}): CanonicalSelfClaimConfig => ({
  canonicalSessionUuid: CANON,
  requiredExecutorVersion: REQUIRED_EXECUTOR_VERSION,
  canonicalBuzzChannelId: CHANNEL,
  expectedCwd: CWD,
  expectedPeerProtocolVersion: PEER_PROTOCOL,
  expectedPeerIdentity: PEER_IDENTITY,
  ...overrides,
});

/**
 * The *real* `OwnerAuthority`, backed by the same test database. Not a hand-rolled fake: the real
 * class writes its consumption as an `audit_events` row inside `this.db.tx()`, which joins
 * `CanonicalSelfClaim`'s outer `txDecision` — so a later denial in the same claim genuinely rolls
 * the consumption back too, exactly as production does. An in-memory fake tracking "consumed" in
 * a plain `Map` would not roll back with the transaction, and would make the consume-once tests
 * below pass regardless of whether the real rollback wiring works.
 */
const OWNER_ACTOR = "isaac";
const realOwnerAuthority = (core: CoreHarness): OwnerAuthorityPort =>
  new OwnerAuthority(core.db, [{ channel: "cli", actor: OWNER_ACTOR }], core.clock);

const fakeBuzzActorAuthenticator = (allowed = true): BuzzActorAuthenticator => ({
  isAllowedActor: (channel) => allowed && channel === "buzz",
});

const fakeResolveBuzzAddress = (
  outcome: Decision<string> = allow(ReasonCode.OK, BUZZ_ADDRESS),
): ((purpose: string) => Promise<Decision<string>>) => async () => outcome;

let mintedNonces = 0;

/**
 * Mints a genuinely admitted `OwnerApprovalReceipt` through the same `IngressGuard` route the
 * daemon's own `admitCliOwnerApproval` uses (src/daemon/daemon.ts) — writing the real
 * `inbound_messages` row and `INGRESS_ADMITTED` audit event `OwnerAuthority.assertApproval` reads
 * back. `parameters` is exactly the shape `canonicalSelfClaimParameterDigest` hashes, so the
 * minted `parameterDigest` matches `claim()`'s own check whenever the scenario is meant to.
 */
const mintOwnerApproval = (
  core: CoreHarness,
  input: {
    projectId: string;
    claimedSessionUuid: string;
    expectedBindingGeneration: number;
    actor?: string;
  },
): OwnerApprovalReceipt => {
  const actor = input.actor ?? OWNER_ACTOR;
  const guard = new IngressGuard(core.db, core.clock, core.audit, { cli: { allowedActors: [actor] } });
  const approval = {
    runId: null,
    candidateSnapshotDigest: null,
    operation: SELF_CLAIM_OPERATION,
    parameters: {
      domain: SELF_CLAIM_OPERATION,
      projectId: input.projectId,
      claimedSessionUuid: input.claimedSessionUuid,
      role: "PRIMARY_CTO",
      expectedBindingGeneration: input.expectedBindingGeneration,
    },
    idempotencyKey: `claim:${input.projectId}:${input.expectedBindingGeneration}:${mintedNonces}`,
    approved: true,
  };
  const nonce = `nonce-${mintedNonces++}`;
  const admitted = guard.admitOwnerApproval(
    { channel: "cli", actor, nonce, payload: ownerApprovalPayload(approval) },
    approval,
  );
  if (!admitted.allowed) {
    throw new Error(`failed to mint a test owner approval: ${JSON.stringify(admitted)}`);
  }
  return admitted.value;
};

const baseRequest = (
  core: CoreHarness,
  projectId: string,
  overrides: Partial<CanonicalSelfClaimRequest> = {},
): CanonicalSelfClaimRequest => ({
  callerPid: 100,
  claimedSessionUuid: CANON,
  projectId,
  expectedBindingGeneration: 1,
  ownerApproval: mintOwnerApproval(core, { projectId, claimedSessionUuid: CANON, expectedBindingGeneration: 1 }),
  cwd: CWD,
  peerProtocolVersion: PEER_PROTOCOL,
  peerIdentity: PEER_IDENTITY,
  buzzChannelId: CHANNEL,
  buzzActorId: "buzz:canonical-cto",
  buzzPurpose: "continuity:PRIMARY_CTO",
  ...overrides,
});

const makeSubject = (
  core: CoreHarness,
  options: {
    configOverrides?: Partial<CanonicalSelfClaimConfig>;
    chain?: readonly ProcessSnapshot[];
    imageInspector?: ExecutingImageInspector;
    transcriptReader?: TranscriptReader;
    ownerAuthority?: OwnerAuthorityPort;
    buzzActorAuthenticator?: BuzzActorAuthenticator;
    resolveBuzzAddress?: (purpose: string) => Promise<Decision<string>>;
  } = {},
): CanonicalSelfClaim =>
  new CanonicalSelfClaim(
    core.db,
    core.clock,
    core.sessions,
    core.bindings,
    options.ownerAuthority ?? realOwnerAuthority(core),
    options.buzzActorAuthenticator ?? fakeBuzzActorAuthenticator(),
    options.resolveBuzzAddress ?? fakeResolveBuzzAddress(),
    baseConfig(options.configOverrides),
    {
      processInspector: chainInspector(options.chain ?? standardChain()),
      imageInspector: options.imageInspector ?? fakeImageInspector(),
      transcriptReader: options.transcriptReader ?? fakeTranscriptReader(),
    },
  );

describe("the two deployment facts the packet named", () => {
  it("exports the exact canonical session UUID and required executor version", () => {
    expect(CANONICAL_SESSION_UUID).toBe("dc54ab12-e2da-497a-a3c5-9a2a5f8f579a");
    expect(REQUIRED_EXECUTOR_VERSION).toBe("2.1.259");
    expect(CANONICAL_PROJECT_BUZZ_CHANNEL_ID).toBe("c37e88d0-8576-48aa-a69c-9cbd54d47be2");
  });
});

describe("pure identity-derivation helpers", () => {
  it("matches a directly executed binary and an interpreter-launched script alike", () => {
    expect(looksLikeClaudeInvocation("/usr/local/bin/claude --resume x")).toBe(true);
    expect(looksLikeClaudeInvocation("/usr/bin/node /opt/claude/claude --session-id x")).toBe(true);
    expect(looksLikeClaudeInvocation("/usr/bin/node /opt/claude/cli.js --session-id x")).toBe(false);
    expect(looksLikeClaudeInvocation("/usr/bin/node /opt/acp/mcp-server.js")).toBe(false);
  });

  it("extracts the session id from --session-id, never from a bare token", () => {
    expect(extractSessionUuidFromCommand(`claude --session-id ${CANON}`)).toBe(CANON);
    expect(extractSessionUuidFromCommand(`claude --resume ${CANON}`)).toBe(CANON);
    expect(extractSessionUuidFromCommand(`claude ${CANON}`)).toBeNull();
    expect(extractSessionUuidFromCommand("claude --print hello")).toBeNull();
  });

  it("reads interactivity from the absence of a headless flag", () => {
    expect(isInteractiveClaudeInvocation(`claude --session-id ${CANON}`)).toBe(true);
    expect(isInteractiveClaudeInvocation(`claude -p --session-id ${CANON}`)).toBe(false);
    expect(isInteractiveClaudeInvocation(`claude --output-format json --session-id ${CANON}`)).toBe(false);
  });

  it("walks a multi-hop ancestry to the claude process and derives its session id — RED for its own reason", () => {
    const found = deriveClaimantIdentity(100, chainInspector(standardChain()));
    expect(found).toMatchObject({ allowed: true, value: { pid: 10, sessionUuid: CANON } });

    const withoutClaude = deriveClaimantIdentity(
      100,
      chainInspector([
        { pid: 100, ppid: 50, command: "/usr/bin/node /opt/acp/mcp-server.js", cwd: CWD, startedAt: "t1" },
        { pid: 50, ppid: 1, command: "/bin/zsh -c foo", cwd: CWD, startedAt: "t2" },
      ]),
    );
    expect(withoutClaude.allowed).toBe(false);
    if (withoutClaude.allowed) throw new Error("unreachable");
    expect(withoutClaude.message).toContain("no claude ancestor exists");

    const noSessionId = deriveClaimantIdentity(
      100,
      chainInspector([{ pid: 100, ppid: 1, command: "/usr/local/bin/claude --print hi", cwd: CWD, startedAt: "t1" }]),
    );
    expect(noSessionId.allowed).toBe(false);
    if (noSessionId.allowed) throw new Error("unreachable");
    expect(noSessionId.message).toContain("names no session id");

    const cyclic = deriveClaimantIdentity(
      100,
      chainInspector([{ pid: 100, ppid: 100, command: "/usr/bin/node x.js", cwd: CWD, startedAt: "t1" }]),
    );
    expect(cyclic.allowed).toBe(false);
    if (cyclic.allowed) throw new Error("unreachable");
    expect(cyclic.message).toContain("no claude ancestor exists");
  });
});

describe("CanonicalSelfClaim — the six-clause contract", () => {
  it("claims the canonical session in one atomic mutation, writing exactly one row to each of the five tables", async () => {
    const core = makeCore();
    const projectId = "prj_canonical";
    insertProject(core, projectId);
    const subject = makeSubject(core);

    const before = rowCounts(core);
    const result = await subject.claim(baseRequest(core, projectId));

    expect(result.allowed, JSON.stringify(result)).toBe(true);
    if (!result.allowed) return;
    expect(result.value.binding.role).toBe("PRIMARY_CTO");
    expect(result.value.binding.projectId).toBe(projectId);
    expect(result.value.derivedSessionUuid).toBe(CANON);
    expect(result.value.executorImageVersion).toBe(REQUIRED_EXECUTOR_VERSION);
    expect(result.value.buzzAddress).toBe(BUZZ_ADDRESS);

    const after = rowCounts(core);
    for (const table of FIVE_TABLES) {
      expect(after[table], `table ${table}`).toBe((before[table] ?? 0) + 1);
    }

    const session = core.db.get<{ buzz_actor_id: string; buzz_address: string }>(
      `SELECT buzz_actor_id, buzz_address FROM sessions WHERE session_id = ?`,
      [result.value.sessionId],
    );
    expect(session).toMatchObject({ buzz_actor_id: "buzz:canonical-cto", buzz_address: BUZZ_ADDRESS });

    // Positive evidence that `OwnerAuthority.consumeApproval` genuinely ran and durably recorded
    // consumption inside this same transaction — compensating for the mutation test below, which
    // cannot isolate this call's contribution from the independent generation-CAS guard.
    const consumedAudit = core.db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM audit_events WHERE kind = 'OWNER_APPROVAL_CONSUMED'`,
    );
    expect(consumedAudit?.c).toBe(1);
  });

  it("clause 1 — a caller-supplied session UUID is checked against the derived one, never substituted", async () => {
    const core = makeCore();
    const projectId = "prj_uuid_mismatch";
    insertProject(core, projectId);
    const subject = makeSubject(core);
    const before = rowCounts(core);

    // The owner approval must itself bind `OTHER` too — otherwise correction 4's own
    // parameterDigest check fires first (a real, earlier, and correct refusal, but not the one
    // this test targets), and the derivation mismatch this test names never gets reached.
    const result = await subject.claim(baseRequest(core, projectId, {
      claimedSessionUuid: OTHER,
      ownerApproval: mintOwnerApproval(core, { projectId, claimedSessionUuid: OTHER, expectedBindingGeneration: 1 }),
    }));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.CONFLICT);
    expect(result.message).toContain("does not match the independently derived identity");
    expect(result.evidence).toMatchObject({ claimed: OTHER, derived: CANON });
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 1 — a caller-supplied pid is checked against the derived ancestor pid", async () => {
    const core = makeCore();
    const projectId = "prj_pid_mismatch";
    insertProject(core, projectId);
    const subject = makeSubject(core);
    const before = rowCounts(core);

    const result = await subject.claim(baseRequest(core, projectId, { claimedPid: 999 }));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.CONFLICT);
    expect(result.message).toContain("claimed pid does not match");
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 2 — pid and start time as a pair: an unresolvable start time refuses even though the pid matches", async () => {
    const core = makeCore();
    const projectId = "prj_no_start_time";
    insertProject(core, projectId);
    const subject = makeSubject(core, { chain: standardChain({ startedAt: null }) });
    const before = rowCounts(core);

    const result = await subject.claim(baseRequest(core, projectId));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("process start time could not be established");
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 2 — a headless invocation is refused as not interactive", async () => {
    const core = makeCore();
    const projectId = "prj_headless";
    insertProject(core, projectId);
    const subject = makeSubject(core, {
      chain: standardChain({ command: `/usr/local/bin/claude -p --session-id ${CANON}` }),
    });
    const before = rowCounts(core);

    const result = await subject.claim(baseRequest(core, projectId));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("not an interactive CLI invocation");
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 2 — cwd must match exactly", async () => {
    const core = makeCore();
    const projectId = "prj_cwd";
    insertProject(core, projectId);
    const subject = makeSubject(core, { chain: standardChain({ cwd: "/somewhere/else" }) });
    const before = rowCounts(core);

    const result = await subject.claim(baseRequest(core, projectId));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("working directory does not match");
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 2 — peer protocol version must match the deployment's expectation", async () => {
    const core = makeCore();
    const projectId = "prj_peer_protocol";
    insertProject(core, projectId);
    const subject = makeSubject(core);
    const before = rowCounts(core);

    const result = await subject.claim(baseRequest(core, projectId, { peerProtocolVersion: "mcp/2024-01-01" }));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("peer protocol version");
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 2 — target version exactly 2.1.259, from the executing image, not any other observed version", async () => {
    const core = makeCore();
    const projectId = "prj_version";
    insertProject(core, projectId);
    const subject = makeSubject(core, { imageInspector: fakeImageInspector("2.1.241") });
    const before = rowCounts(core);

    const result = await subject.claim(baseRequest(core, projectId));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("not the required version");
    expect(result.evidence).toMatchObject({ observedVersion: "2.1.241", requiredVersion: "2.1.259" });
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 2 — an unresolvable executing image refuses fail-closed", async () => {
    const core = makeCore();
    const projectId = "prj_no_image";
    insertProject(core, projectId);
    const subject = makeSubject(core, { imageInspector: { resolve: () => null } });
    const before = rowCounts(core);

    const result = await subject.claim(baseRequest(core, projectId));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("executing image could not be resolved");
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 2 — the transcript must exist on disk", async () => {
    const core = makeCore();
    const projectId = "prj_no_transcript";
    insertProject(core, projectId);
    const subject = makeSubject(core, { transcriptReader: fakeTranscriptReader(false) });
    const before = rowCounts(core);

    const result = await subject.claim(baseRequest(core, projectId));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.NOT_FOUND);
    expect(result.message).toContain("no transcript exists");
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 2 — the connected peer identity must match the deployment's expectation", async () => {
    const core = makeCore();
    const projectId = "prj_peer_identity";
    insertProject(core, projectId);
    const subject = makeSubject(core);
    const before = rowCounts(core);

    const result = await subject.claim(baseRequest(core, projectId, { peerIdentity: "someone-else" }));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("connected peer identity");
    expect(rowCounts(core)).toEqual(before);
  });

  it("the buzz channel check is real, not decorative: the wrong channel refuses exactly like the live PROBE_FAILED case", async () => {
    const core = makeCore();
    const projectId = "prj_channel";
    insertProject(core, projectId);
    const subject = makeSubject(core);
    const before = rowCounts(core);

    const result = await subject.claim(baseRequest(core, projectId, { buzzChannelId: "DM" }));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("not the canonical project channel");
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 4 — only the exact canonical session may be adopted; a different, otherwise-valid session is refused, not bootstrapped", async () => {
    const core = makeCore();
    const projectId = "prj_other_session";
    insertProject(core, projectId);
    const subject = makeSubject(core, { chain: standardChain({}, OTHER) });
    const before = rowCounts(core);

    const result = await subject.claim(baseRequest(core, projectId, {
      claimedSessionUuid: OTHER,
      ownerApproval: mintOwnerApproval(core, { projectId, claimedSessionUuid: OTHER, expectedBindingGeneration: 1 }),
    }));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("only the canonical session may be adopted");
    expect(rowCounts(core)).toEqual(before);
  });

  it("correction 4 — an owner approval for a different operation, project, session or generation is refused before any I/O", async () => {
    const core = makeCore();
    const projectId = "prj_wrong_approval";
    insertProject(core, projectId);
    const subject = makeSubject(core);
    const before = rowCounts(core);

    const validApproval = mintOwnerApproval(core, { projectId, claimedSessionUuid: CANON, expectedBindingGeneration: 1 });
    const wrongOperation = await subject.claim(
      baseRequest(core, projectId, { ownerApproval: { ...validApproval, operation: "something.else" } }),
    );
    expect(wrongOperation.allowed).toBe(false);
    if (!wrongOperation.allowed) expect(wrongOperation.reasonCode).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);

    const wrongProject = await subject.claim(
      baseRequest(core, projectId, {
        ownerApproval: mintOwnerApproval(core, {
          projectId: "some-other-project",
          claimedSessionUuid: CANON,
          expectedBindingGeneration: 1,
        }),
      }),
    );
    expect(wrongProject.allowed).toBe(false);
    if (!wrongProject.allowed) expect(wrongProject.message).toContain("does not bind the exact project");

    const wrongGeneration = await subject.claim(
      baseRequest(core, projectId, {
        ownerApproval: mintOwnerApproval(core, { projectId, claimedSessionUuid: CANON, expectedBindingGeneration: 99 }),
      }),
    );
    expect(wrongGeneration.allowed).toBe(false);

    expect(rowCounts(core)).toEqual(before);
  });

  it("correction 4 — an owner approval not currently admitted is refused before derivation writes anything", async () => {
    const core = makeCore();
    const projectId = "prj_not_admitted";
    insertProject(core, projectId);
    const subject = makeSubject(core);
    const before = rowCounts(core);

    // Shaped exactly like an admitted receipt (so it passes `claim()`'s own operation/project/
    // generation checks) but never actually admitted: no matching `inbound_messages` row exists
    // for this nonce, so the *real* `OwnerAuthority.assertApproval` denies it.
    const fabricated: OwnerApprovalReceipt = {
      channel: "cli",
      actor: OWNER_ACTOR,
      inboundNonce: "never-admitted-nonce",
      runId: null,
      candidateSnapshotDigest: null,
      operation: SELF_CLAIM_OPERATION,
      parameterDigest: canonicalSelfClaimParameterDigest({
        projectId,
        claimedSessionUuid: CANON,
        expectedBindingGeneration: 1,
      }),
      idempotencyKey: "claim:fabricated",
      approved: true,
    };

    const result = await subject.claim(baseRequest(core, projectId, { ownerApproval: fabricated }));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);
    expect(rowCounts(core)).toEqual(before);
  });

  it("correction 4 — a replayed owner approval is refused the second time, with zero additional rows", async () => {
    const core = makeCore();
    const projectId = "prj_replay";
    insertProject(core, projectId);
    const subject = makeSubject(core);
    const approval = mintOwnerApproval(core, { projectId, claimedSessionUuid: CANON, expectedBindingGeneration: 1 });

    const first = await subject.claim(baseRequest(core, projectId, { ownerApproval: approval }));
    expect(first.allowed, JSON.stringify(first)).toBe(true);
    const afterFirst = rowCounts(core);

    // The exact same admitted receipt, presented again for the exact same (project, session,
    // generation) it already authorised. The real `OwnerAuthority` denies this as an
    // already-consumed receipt before the transaction ever opens a second session row.
    const replay = await subject.claim(baseRequest(core, projectId, {
      ownerApproval: approval,
      expectedBindingGeneration: 1,
    }));
    expect(replay.allowed).toBe(false);
    expect(rowCounts(core)).toEqual(afterFirst);
  });

  it("clause 3 — a duplicate live actor is refused with zero additional rows, even though the session insert already ran inside the transaction", async () => {
    const core = makeCore();
    const projectId = "prj_duplicate";
    insertProject(core, projectId);
    const subject = makeSubject(core);

    const first = await subject.claim(baseRequest(core, projectId));
    expect(first.allowed).toBe(true);
    const afterFirst = rowCounts(core);

    const second = await subject.claim(baseRequest(core, projectId, {
      expectedBindingGeneration: 2,
      ownerApproval: mintOwnerApproval(core, { projectId, claimedSessionUuid: CANON, expectedBindingGeneration: 2 }),
      // A different Buzz identity than the first claim's, deliberately: the first session is
      // still live and holding "buzz:canonical-cto" (`sessions_buzz_actor`'s partial unique
      // index refuses a second live session the same identity), which would otherwise deny this
      // attempt at `bindBuzzActor` — a real, earlier guard, but not the one this test targets.
      buzzActorId: "buzz:canonical-cto-second-attempt",
    }));
    expect(second.allowed).toBe(false);
    if (second.allowed) return;
    expect(second.reasonCode).toBe(ReasonCode.BINDING_ALREADY_ACTIVE);

    // This is the assertion that matters: `sessions.create()` ran again inside `#mutate` before
    // `bindings.bind()` denied. If the outer transaction were `db.tx` instead of `db.txDecision`
    // (see the "atomicity" describe block below for the mutation that proves this), that second
    // session row would have been committed anyway. Reading the return value alone cannot see it.
    expect(rowCounts(core)).toEqual(afterFirst);
  });

  it("clause 4 restore — the same external session, reclaimed after a revoke, reuses the actor and target binding rather than minting a second owner", async () => {
    const core = makeCore();
    const projectId = "prj_restore";
    insertProject(core, projectId);
    const subject = makeSubject(core);

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

    const restoreSubject = makeSubject(core, {
      chain: standardChain({ startedAt: "Fri Jan  1 01:00:00 2027" }),
    });
    const before = rowCounts(core);
    const restored = await restoreSubject.claim(baseRequest(core, projectId, {
      expectedBindingGeneration: 2,
      ownerApproval: mintOwnerApproval(core, { projectId, claimedSessionUuid: CANON, expectedBindingGeneration: 2 }),
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
    const subject = makeSubject(core);

    const result = await subject.claim(baseRequest(core, projectId));
    expect(result.allowed).toBe(true);

    const kinds = core.db.all<{ kind: string }>(`SELECT kind FROM conversational_actors`);
    expect(kinds).toEqual([{ kind: "PRIMARY_CTO" }]);
    const ceoRows = core.db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM assignments WHERE role = 'CEO'`,
    );
    expect(ceoRows?.c).toBe(0);
  });

  it("correction 5 — an unresolvable buzz address refuses before the transaction ever opens", async () => {
    const core = makeCore();
    const projectId = "prj_no_buzz_address";
    insertProject(core, projectId);
    const subject = makeSubject(core, {
      resolveBuzzAddress: fakeResolveBuzzAddress(deny(ReasonCode.PROBE_FAILED, "buzz transport is not available", {})),
    });
    const before = rowCounts(core);

    const result = await subject.claim(baseRequest(core, projectId));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.PROBE_FAILED);
    expect(rowCounts(core)).toEqual(before);
  });

  it("correction 5 — an unauthenticated buzz actor id refuses with zero additional rows, even after the session was created", async () => {
    const core = makeCore();
    const projectId = "prj_bad_buzz_actor";
    insertProject(core, projectId);
    const subject = makeSubject(core, { buzzActorAuthenticator: fakeBuzzActorAuthenticator(false) });
    const before = rowCounts(core);

    const result = await subject.claim(baseRequest(core, projectId));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED);
    expect(rowCounts(core)).toEqual(before);
  });

  it("rejects a malformed claimed session UUID as an argument error, not a derivation mismatch", async () => {
    const core = makeCore();
    const projectId = "prj_malformed_uuid";
    insertProject(core, projectId);
    const subject = makeSubject(core);

    const result = await subject.claim(baseRequest(core, projectId, { claimedSessionUuid: "not-a-uuid" }));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
  });

  it("rejects a non-positive expected binding generation as an argument error", async () => {
    const core = makeCore();
    const projectId = "prj_bad_generation";
    insertProject(core, projectId);
    const subject = makeSubject(core);

    const result = await subject.claim(baseRequest(core, projectId, { expectedBindingGeneration: 0 }));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
  });
});

describe("adversarial mutations — each must kill its guard, not merely delete the string it greps for", () => {
  const MODULE_PATH = join(process.cwd(), "src", "registry", "canonical-self-claim.ts");
  // The real entry module, not `node_modules/.bin/vitest` — that shim is a `/bin/sh` script and
  // `execFileSync(process.execPath, [thatShim, ...])` fails with a node SyntaxError before any
  // test runs at all, which would make every mutation look "killed" for the wrong reason.
  const VITEST_ENTRY = join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
  const THIS_FILE = join(process.cwd(), "tests", "unit", "canonical-self-claim.test.ts");

  /**
   * Applies a source mutation, runs the one grep-named test in a fresh subprocess (so the
   * mutated `.ts` is actually re-read — an in-process `import()` cache would keep serving the
   * original module and make every mutation look killed for the wrong reason), asserts it fails,
   * then restores the exact original bytes and re-confirms green.
   */
  const proveMutationIsKilled = (mutate: (source: string) => string, testNameFragment: string): void => {
    const original = readFileSync(MODULE_PATH, "utf8");
    const mutated = mutate(original);
    expect(mutated, "mutation did not change anything — the target string was not found").not.toBe(original);
    writeFileSync(MODULE_PATH, mutated);
    let mutatedFailed = false;
    try {
      execFileSync(
        process.execPath,
        [VITEST_ENTRY, "run", THIS_FILE, "-t", testNameFragment],
        { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" },
      );
    } catch {
      mutatedFailed = true;
    } finally {
      writeFileSync(MODULE_PATH, original);
    }
    expect(mutatedFailed, "the mutated guard did not kill its own test").toBe(true);
    // Restored: the named test must be green again on the unmutated source.
    execFileSync(
      process.execPath,
      [VITEST_ENTRY, "run", THIS_FILE, "-t", testNameFragment],
      { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" },
    );
  };

  it(
    "atomicity: swapping the outer db.txDecision for db.tx lets a denied bind's session insert survive — the exact trap the packet named",
    () => {
      proveMutationIsKilled(
        (source) =>
          source.replace(
            "return this.db.txDecision((): Decision<CanonicalSelfClaimReceipt> => {",
            "return this.db.tx((): Decision<CanonicalSelfClaimReceipt> => {",
          ),
        "clause 3 — a duplicate live actor is refused with zero additional rows",
      );
    },
    30_000,
  );

  it(
    "identity substitution: trusting the caller's claimed UUID instead of the derived one un-kills the mismatch refusal",
    () => {
      proveMutationIsKilled(
        (source) =>
          source.replace(
            "if (identity.sessionUuid !== request.claimedSessionUuid.toLowerCase()) {",
            "if (false) {",
          ),
        "clause 1 — a caller-supplied session UUID is checked against the derived one",
      );
    },
    30_000,
  );

  it(
    "pid-without-start-time: deleting the start-time pairing check admits a caller whose process identity was never confirmed",
    () => {
      proveMutationIsKilled(
        (source) => source.replace("if (identity.startedAt === null) {", "if (false) {"),
        "clause 2 — pid and start time as a pair",
      );
    },
    30_000,
  );

  /**
   * Reported rather than forced (per the evidence bar: "if a mutation does not kill it, report
   * that rather than adjusting the test"). Removing the `consumeApproval` call does **not** kill
   * "correction 4 — a replayed owner approval is refused the second time": that test's replay is
   * for the *same generation* the first claim already committed, and the independent
   * generation-CAS check (`nextGeneration !== request.expectedBindingGeneration`, checked earlier
   * in `#mutate`, before consumption) already denies it for that reason alone. This is structural,
   * not a gap in this one test: `assignments_generation_monotonic` means any two attempts at the
   * same role key and generation can only ever differ by "the first committed and the second did
   * not", so an exact-receipt replay and an exhausted generation are the same observable event at
   * this call site. Consumption is still real and durable — the happy-path test above asserts the
   * `OWNER_APPROVAL_CONSUMED` audit row directly — this test only shows that *this one scenario*
   * cannot isolate the consume-once wiring's own contribution from the generation guard sitting in
   * front of it.
   */
  it(
    "consume-once bypass: removing the call does not kill the replay test, because the generation-CAS is a redundant, earlier guard for this exact scenario",
    () => {
      const original = readFileSync(join(process.cwd(), "src", "registry", "canonical-self-claim.ts"), "utf8");
      const mutated = original.replace(
        "const consumed = this.ownerAuthority.consumeApproval(request.ownerApproval, null);\n      if (!consumed.allowed) return consumed as Decision<CanonicalSelfClaimReceipt>;",
        "",
      );
      expect(mutated, "mutation did not change anything — the target string was not found").not.toBe(original);
      writeFileSync(join(process.cwd(), "src", "registry", "canonical-self-claim.ts"), mutated);
      let mutatedFailed = false;
      try {
        execFileSync(
          process.execPath,
          [
            join(process.cwd(), "node_modules", "vitest", "vitest.mjs"),
            "run",
            join(process.cwd(), "tests", "unit", "canonical-self-claim.test.ts"),
            "-t",
            "correction 4 — a replayed owner approval is refused the second time",
          ],
          { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" },
        );
      } catch {
        mutatedFailed = true;
      } finally {
        writeFileSync(join(process.cwd(), "src", "registry", "canonical-self-claim.ts"), original);
      }
      expect(
        mutatedFailed,
        "documented finding: this mutation is NOT killed by the replay test (see comment above) — " +
          "the generation-CAS guard denies the same scenario independently",
      ).toBe(false);
    },
    30_000,
  );
});
