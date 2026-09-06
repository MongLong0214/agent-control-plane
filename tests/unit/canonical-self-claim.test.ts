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
import { afterEach, describe, expect, it } from "vitest";

import { OwnerAuthority, type OwnerApprovalReceipt, type OwnerAuthorityPort } from "../../src/ceo/owner-authority.ts";
import { type Decision, allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { roleKeyFor, Role, SessionLifecycle } from "../../src/domain/types.ts";
import { IngressGuard, ownerApprovalPayload } from "../../src/ingress/ingress-guard.ts";
import type { BuzzActorAuthenticator } from "../../src/session/session-registry.ts";
import {
  CanonicalSelfClaim,
  SELF_CLAIM_OPERATION,
  canonicalSelfClaimParameterDigest,
  deriveClaimantIdentity,
  extractSessionUuidFromArgv,
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
 * `FIVE_TABLES` alone proves state rollback and says nothing about audit rollback, which the
 * contract names explicitly. `audit_events` is append-only and every writer
 * `#mutate` touches records to it (`OwnerAuthority.consumeApproval`, `SessionRegistry.create`,
 * `.transition`, `.bindBuzzActor`, `BindingRegistry.bind`), so a refusal that still lets a
 * "the claim was attempted" row land — including a *deliberately added* refusal-audit record
 * written after `#mutate` returns its denial, outside the transaction that rolled back — would
 * pass every `FIVE_TABLES`-only assertion and still be a real leak. Counting this table is what
 * makes that shape fail.
 */
const ROLLBACK_TABLES = [...FIVE_TABLES, "audit_events"] as const;

const rowCounts = (core: CoreHarness): Record<(typeof ROLLBACK_TABLES)[number], number> =>
  Object.fromEntries(
    ROLLBACK_TABLES.map((table) => [
      table,
      core.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)?.c ?? -1,
    ]),
  ) as Record<(typeof ROLLBACK_TABLES)[number], number>;

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
  // A direct binary invocation — argv[0]'s own basename is `claude`. Never an interpreter-launched
  // form (`node /path/to/claude ...`): `looksLikeClaudeInvocation` refuses that shape (see the
  // counterexample below), and this default fixture must exercise the exact shape production
  // requires. `command` mirrors `argv` only for readability in a failed assertion's output — it is
  // never read by any of the derivation logic under test.
  argv: ["/opt/claude/claude", "--session-id", sessionUuid],
  command: `/opt/claude/claude --session-id ${sessionUuid}`,
  cwd: CWD,
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
    startedAt: "t1",
  },
  { pid: 50, ppid: 10, argv: ["/bin/zsh", "-c", "foo"], command: "/bin/zsh -c foo", cwd: CWD, startedAt: "t2" },
  claudeAncestor(overrides, sessionUuid),
];

const fakeImageInspector = (
  version = TEST_REQUIRED_EXECUTOR_VERSION,
  imagePath = TEST_EXPECTED_EXECUTOR_REALPATH,
  sha256 = TEST_EXPECTED_EXECUTOR_SHA256,
): ExecutingImageInspector => ({
  resolve: () => ({ imagePath, version, sha256 }),
});

const fakeTranscriptReader = (present = true): TranscriptReader => ({
  locate: (sessionUuid) => (present ? { path: `/fake/transcripts/${sessionUuid}.jsonl`, sizeBytes: 42 } : null),
});

const baseConfig = (overrides: Partial<CanonicalSelfClaimConfig> = {}): CanonicalSelfClaimConfig => ({
  canonicalSessionUuid: CANON,
  requiredExecutorVersion: TEST_REQUIRED_EXECUTOR_VERSION,
  canonicalBuzzChannelId: CHANNEL,
  expectedExecutorRealpath: TEST_EXPECTED_EXECUTOR_REALPATH,
  expectedExecutorSha256: TEST_EXPECTED_EXECUTOR_SHA256,
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
const OWNER_ACTOR = "test-owner";
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
    /** Defaults to `true`. `false` mints a genuinely-admitted owner *rejection*. */
    approved?: boolean;
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
    approved: input.approved ?? true,
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
  // Lazy, and only when not overridden: an object-literal property is evaluated unconditionally
  // regardless of whether a later `...overrides` spread will replace it, so an unconditional
  // `mintOwnerApproval(...)` here would mint (and durably write `INGRESS_ADMITTED` /
  // `OWNER_APPROVAL_INGRESS` audit rows for) a throwaway default receipt on *every* call,
  // including ones that supply their own `ownerApproval` — an audit-counting assertion that sums
  // every row would then see two unexplained rows drift in from a mint whose result is discarded.
  ownerApproval:
    overrides.ownerApproval ??
    mintOwnerApproval(core, { projectId, claimedSessionUuid: CANON, expectedBindingGeneration: 1 }),
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

describe("deployment identity is required, deployment-private configuration (#760)", () => {
  it("fails closed, before any effect, when a required deployment value is missing or blank", () => {
    const core = makeCore();
    expect(() => makeSubject(core, { configOverrides: { canonicalSessionUuid: "" } })).toThrow(
      /canonicalSessionUuid/,
    );
    expect(() => makeSubject(core, { configOverrides: { requiredExecutorVersion: "" } })).toThrow(
      /requiredExecutorVersion/,
    );
    expect(() => makeSubject(core, { configOverrides: { canonicalBuzzChannelId: "   " } })).toThrow(
      /canonicalBuzzChannelId/,
    );
    expect(() => makeSubject(core, { configOverrides: { expectedExecutorRealpath: "" } })).toThrow(
      /expectedExecutorRealpath/,
    );
    expect(() => makeSubject(core, { configOverrides: { expectedExecutorSha256: "" } })).toThrow(
      /expectedExecutorSha256/,
    );
  });

  it("fails closed when the configured canonical session UUID is not a UUID", () => {
    const core = makeCore();
    expect(() => makeSubject(core, { configOverrides: { canonicalSessionUuid: "not-a-uuid" } })).toThrow(/UUID/);
  });

  it("never falls back to a hardcoded real value — no exported real-ID constant exists to fall back to", () => {
    // No exported real-ID constant exists for this module to fall back to (#760): every value the
    // primitive uses must come from the config this test constructs, never from a module-level
    // default.
    const core = makeCore();
    const subject = makeSubject(core);
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
          startedAt: "t1",
        },
        { pid: 50, ppid: 1, argv: ["/bin/zsh", "-c", "foo"], command: "/bin/zsh -c foo", cwd: CWD, startedAt: "t2" },
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
        { pid: 100, ppid: 100, argv: ["/usr/bin/node", "x.js"], command: "/usr/bin/node x.js", cwd: CWD, startedAt: "t1" },
      ]),
    );
    expect(cyclic.allowed).toBe(false);
    if (cyclic.allowed) throw new Error("unreachable");
    expect(cyclic.message).toContain("no claude ancestor exists");
  });

  it("a hop whose argv is unavailable refuses immediately, rather than being silently treated as 'not claude' and climbed past", () => {
    const unavailable = deriveClaimantIdentity(
      100,
      chainInspector([{ pid: 100, ppid: 1, argv: null, command: "/opt/claude/claude --session-id " + CANON, cwd: CWD, startedAt: "t1" }]),
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
    const subject = makeSubject(core);

    // Built — and its owner approval minted, via a real, already-committed `IngressGuard.admit`
    // — before `before` is captured. Minting is a genuine, separate write (`INGRESS_ADMITTED`);
    // folding it into "before" would make the refusal oracle blind to it on every other test.
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
    // below (`ROLLBACK_TABLES`) proves is absent on any denial. `audit_events` is append-only and
    // ordered by insertion, so skipping `before.audit_events` rows (the receipt's own
    // `INGRESS_ADMITTED`/`OWNER_APPROVAL_INGRESS` writes, minted before this snapshot) isolates
    // exactly what `claim()` itself wrote.
    const auditKinds = core.db
      .all<{ kind: string }>(`SELECT kind FROM audit_events ORDER BY event_id LIMIT -1 OFFSET ?`, [
        before.audit_events ?? 0,
      ])
      .map((row) => row.kind)
      .sort();
    expect(auditKinds).toEqual([
      "BINDING_CREATED",
      "OWNER_APPROVAL_CONSUMED",
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
    const subject = makeSubject(core);
    // The owner approval must itself bind `OTHER` too — otherwise the owner-approval
    // parameterDigest check fires first (a real, earlier, and correct refusal, but not the one
    // this test targets), and the derivation mismatch this test names never gets reached.
    const request = baseRequest(core, projectId, {
      claimedSessionUuid: OTHER,
      ownerApproval: mintOwnerApproval(core, { projectId, claimedSessionUuid: OTHER, expectedBindingGeneration: 1 }),
    });
    const before = rowCounts(core);
    const result = await subject.claim(request);

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
    const request = baseRequest(core, projectId, { claimedPid: 999 });
    const before = rowCounts(core);
    const result = await subject.claim(request);

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.CONFLICT);
    expect(result.message).toContain("claimed pid does not match");
    expect(rowCounts(core)).toEqual(before);
  });

  it(
    "production claim seam: Node interpreting an attacker-controlled script named claude is refused before any effect",
    async () => {
      const core = makeCore();
      const projectId = "prj_interpreter_bypass";
      insertProject(core, projectId);
      const ownerApproval = mintOwnerApproval(core, {
        projectId,
        claimedSessionUuid: CANON,
        expectedBindingGeneration: 1,
      });
      // The exact bypass this check closes: an attacker-controlled script, merely named `claude`,
      // launched through the real Node interpreter, at the same ancestry position a real claude
      // process would occupy. `looksLikeClaudeInvocation` only matches the first token's own
      // basename, so this pid is never recognized as the claimant — the ancestry walk keeps
      // climbing past it, finds nothing above it (`ppid: 1`), and denies at clause 1, before this
      // request's owner approval is ever presented for consumption, before any transaction opens,
      // and before Buzz resolution runs.
      const subject = makeSubject(core, {
        chain: standardChain({
          argv: ["/usr/bin/node", "/attacker-controlled/claude", "--session-id", CANON],
          command: `/usr/bin/node /attacker-controlled/claude --session-id ${CANON}`,
        }),
      });
      const request = baseRequest(core, projectId, { ownerApproval });
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
      expect(rowCounts(core)).toEqual(before);

      // The very same approval, presented again by the real claimant (a directly executed
      // `claude` binary, this file's default chain), must still succeed. If the attack attempt
      // had consumed it, this second, otherwise-identical claim would be refused as a replay
      // instead.
      const legitimateResult = await makeSubject(core).claim(baseRequest(core, projectId, { ownerApproval }));
      expect(legitimateResult.allowed, JSON.stringify(legitimateResult)).toBe(true);
    },
  );

  it(
    "production claim seam: a conflicting second selector on the claude ancestor's command line is refused before any effect, never resolved by trusting whichever selector this code happens to check first",
    async () => {
      const core = makeCore();
      const projectId = "prj_conflicting_selector";
      insertProject(core, projectId);
      const ownerApproval = mintOwnerApproval(core, {
        projectId,
        claimedSessionUuid: CANON,
        expectedBindingGeneration: 1,
      });
      // The claude ancestor's own argv carries two selectors naming two different sessions —
      // `--resume OTHER` ahead of an appended `--session-id CANON`. Resolving the ambiguity by
      // trusting whichever selector is checked first would silently treat CANON as this process's
      // one real session, when the same argv just as validly names OTHER via `--resume`. Exactness
      // means the ambiguity itself is the refusal, never a tiebreak between the two candidates.
      const subject = makeSubject(core, {
        chain: standardChain({
          argv: ["/opt/claude/claude", "--resume", OTHER, "--session-id", CANON],
          command: `/opt/claude/claude --resume ${OTHER} --session-id ${CANON}`,
        }),
      });
      const request = baseRequest(core, projectId, { ownerApproval });
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
      expect(rowCounts(core)).toEqual(before);

      // The very same approval, presented again by the real claimant (this file's default,
      // unambiguous chain), must still succeed — the conflicting-selector attempt above consumed
      // nothing.
      const legitimateResult = await makeSubject(core).claim(baseRequest(core, projectId, { ownerApproval }));
      expect(legitimateResult.allowed, JSON.stringify(legitimateResult)).toBe(true);
    },
  );

  it(
    "production claim seam: an empty --session-id= alongside a valid --resume is refused, never resolved by only counting the selector that has a value",
    async () => {
      const core = makeCore();
      const projectId = "prj_empty_selector_bypass";
      insertProject(core, projectId);
      const ownerApproval = mintOwnerApproval(core, {
        projectId,
        claimedSessionUuid: CANON,
        expectedBindingGeneration: 1,
      });
      // `--session-id=` (an attached selector with no value) still counts as one occurrence; with
      // `--resume CANON` also present, two occurrences means refusal, not a fallback to whichever
      // selector has a value.
      const subject = makeSubject(core, {
        chain: standardChain({
          argv: ["/opt/claude/claude", "--session-id=", "--resume", CANON],
          command: `/opt/claude/claude --session-id= --resume ${CANON}`,
        }),
      });
      const request = baseRequest(core, projectId, { ownerApproval });
      const before = rowCounts(core);

      const result = await subject.claim(request);

      expect(result.allowed, JSON.stringify(result)).toBe(false);
      if (result.allowed) return;
      expect(result.reasonCode).toBe(ReasonCode.NOT_FOUND);
      expect(result.message).toContain("names no session id");
      expect(rowCounts(core)).toEqual(before);

      const legitimateResult = await makeSubject(core).claim(baseRequest(core, projectId, { ownerApproval }));
      expect(legitimateResult.allowed, JSON.stringify(legitimateResult)).toBe(true);
    },
  );

  it("clause 2 — pid and start time as a pair: an unresolvable start time refuses even though the pid matches", async () => {
    const core = makeCore();
    const projectId = "prj_no_start_time";
    insertProject(core, projectId);
    const subject = makeSubject(core, { chain: standardChain({ startedAt: null }) });
    const request = baseRequest(core, projectId);
    const before = rowCounts(core);
    const result = await subject.claim(request);

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("process start time could not be established");
    expect(rowCounts(core)).toEqual(before);
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
        core.sessions,
        core.bindings,
        realOwnerAuthority(core),
        fakeBuzzActorAuthenticator(),
        fakeResolveBuzzAddress(),
        baseConfig(),
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
      expect(rowCounts(core)).toEqual(before);
    },
  );

  it("clause 2 — a headless invocation is refused as not interactive", async () => {
    const core = makeCore();
    const projectId = "prj_headless";
    insertProject(core, projectId);
    const subject = makeSubject(core, {
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
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 2 — cwd must match exactly", async () => {
    const core = makeCore();
    const projectId = "prj_cwd";
    insertProject(core, projectId);
    const subject = makeSubject(core, { chain: standardChain({ cwd: "/somewhere/else" }) });
    const request = baseRequest(core, projectId);
    const before = rowCounts(core);
    const result = await subject.claim(request);

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
    const request = baseRequest(core, projectId, { peerProtocolVersion: "mcp/2024-01-01" });
    const before = rowCounts(core);
    const result = await subject.claim(request);

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("peer protocol version");
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 2 — target version exactly the configured required version, from the executing image, not any other observed version", async () => {
    const core = makeCore();
    const projectId = "prj_version";
    insertProject(core, projectId);
    const observedVersion = "1.2.3-wrong";
    const subject = makeSubject(core, { imageInspector: fakeImageInspector(observedVersion) });
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
    expect(rowCounts(core)).toEqual(before);
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
      const subject = makeSubject(core, {
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
      expect(rowCounts(core)).toEqual(before);
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
      const subject = makeSubject(core, {
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
      expect(rowCounts(core)).toEqual(before);
    },
  );

  it("clause 2 — an unresolvable executing image refuses fail-closed", async () => {
    const core = makeCore();
    const projectId = "prj_no_image";
    insertProject(core, projectId);
    const subject = makeSubject(core, { imageInspector: { resolve: () => null } });
    const request = baseRequest(core, projectId);
    const before = rowCounts(core);
    const result = await subject.claim(request);

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
    const request = baseRequest(core, projectId);
    const before = rowCounts(core);
    const result = await subject.claim(request);

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
    const request = baseRequest(core, projectId, { peerIdentity: "someone-else" });
    const before = rowCounts(core);
    const result = await subject.claim(request);

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
    const request = baseRequest(core, projectId, { buzzChannelId: "DM" });
    const before = rowCounts(core);
    const result = await subject.claim(request);

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
    const request = baseRequest(core, projectId, {
      claimedSessionUuid: OTHER,
      ownerApproval: mintOwnerApproval(core, { projectId, claimedSessionUuid: OTHER, expectedBindingGeneration: 1 }),
    });
    const before = rowCounts(core);
    const result = await subject.claim(request);

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("only the canonical session may be adopted");
    expect(rowCounts(core)).toEqual(before);
  });

  it("an owner approval for a different operation, project, session or generation is refused before any I/O", async () => {
    const core = makeCore();
    const projectId = "prj_wrong_approval";
    insertProject(core, projectId);
    const subject = makeSubject(core);

    // All three receipts minted — each a real, separately-admitted write — before `before` is
    // captured, so the oracle below measures only what the three `claim()` calls themselves did.
    const wrongOperationRequest = baseRequest(core, projectId, {
      ownerApproval: {
        ...mintOwnerApproval(core, { projectId, claimedSessionUuid: CANON, expectedBindingGeneration: 1 }),
        operation: "something.else",
      },
    });
    const wrongProjectRequest = baseRequest(core, projectId, {
      ownerApproval: mintOwnerApproval(core, {
        projectId: "some-other-project",
        claimedSessionUuid: CANON,
        expectedBindingGeneration: 1,
      }),
    });
    const wrongGenerationRequest = baseRequest(core, projectId, {
      ownerApproval: mintOwnerApproval(core, { projectId, claimedSessionUuid: CANON, expectedBindingGeneration: 99 }),
    });
    const before = rowCounts(core);

    const wrongOperation = await subject.claim(wrongOperationRequest);
    expect(wrongOperation.allowed).toBe(false);
    if (!wrongOperation.allowed) expect(wrongOperation.reasonCode).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);

    const wrongProject = await subject.claim(wrongProjectRequest);
    expect(wrongProject.allowed).toBe(false);
    if (!wrongProject.allowed) expect(wrongProject.message).toContain("does not bind the exact project");

    const wrongGeneration = await subject.claim(wrongGenerationRequest);
    expect(wrongGeneration.allowed).toBe(false);

    expect(rowCounts(core)).toEqual(before);
  });

  it("an owner approval not currently admitted is refused before derivation writes anything", async () => {
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

  it("a replayed owner approval is refused the second time, with zero additional rows", async () => {
    const core = makeCore();
    const projectId = "prj_replay";
    insertProject(core, projectId);
    const subject = makeSubject(core);
    const approval = mintOwnerApproval(core, { projectId, claimedSessionUuid: CANON, expectedBindingGeneration: 1 });

    const first = await subject.claim(baseRequest(core, projectId, { ownerApproval: approval }));
    expect(first.allowed, JSON.stringify(first)).toBe(true);
    const afterFirst = rowCounts(core);

    // The exact same admitted receipt, presented again for the exact same (project, session,
    // generation) it already authorised, is refused by `#mutate`'s generation check
    // (`nextGeneration !== request.expectedBindingGeneration`), which runs before
    // `consumeApproval` — the first claim already committed generation 1 for this role key. This
    // refusal is the generation check's, not `OwnerAuthority`'s already-consumed check.
    const replay = await subject.claim(baseRequest(core, projectId, {
      ownerApproval: approval,
      expectedBindingGeneration: 1,
    }));
    expect(replay.allowed).toBe(false);
    if (!replay.allowed) expect(replay.reasonCode).toBe(ReasonCode.CONFLICT);
    expect(rowCounts(core)).toEqual(afterFirst);
  });

  it("an owner REJECTION (approved: false) must not authorise the claim it names", async () => {
    const core = makeCore();
    const projectId = "prj_owner_rejected";
    insertProject(core, projectId);
    const subject = makeSubject(core);

    // Otherwise perfectly valid: right operation, right project/session/generation, genuinely
    // admitted through the same `IngressGuard` route a real approval would use. The only thing
    // wrong is that the owner said no.
    const rejection = mintOwnerApproval(core, {
      projectId,
      claimedSessionUuid: CANON,
      expectedBindingGeneration: 1,
      approved: false,
    });
    const request = baseRequest(core, projectId, { ownerApproval: rejection });
    const before = rowCounts(core);
    const result = await subject.claim(request);

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);
    expect(result.message).toContain("not an approval");
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 3 — a duplicate live actor is refused with zero additional rows, even though the session insert already ran inside the transaction", async () => {
    const core = makeCore();
    const projectId = "prj_duplicate";
    insertProject(core, projectId);
    const subject = makeSubject(core);

    const first = await subject.claim(baseRequest(core, projectId));
    expect(first.allowed).toBe(true);

    // Built — and its owner approval minted — before `afterFirst` is captured, so the second
    // mint's own `INGRESS_ADMITTED` audit write does not show up as unexplained drift against it.
    const secondRequest = baseRequest(core, projectId, {
      expectedBindingGeneration: 2,
      ownerApproval: mintOwnerApproval(core, { projectId, claimedSessionUuid: CANON, expectedBindingGeneration: 2 }),
      // A different Buzz identity than the first claim's, deliberately: the first session is
      // still live and holding "buzz:canonical-cto" (`sessions_buzz_actor`'s partial unique
      // index refuses a second live session the same identity), which would otherwise deny this
      // attempt at `bindBuzzActor` — a real, earlier guard, but not the one this test targets.
      buzzActorId: "buzz:canonical-cto-second-attempt",
    });
    const afterFirst = rowCounts(core);

    const second = await subject.claim(secondRequest);
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

  it("an unresolvable buzz address refuses before the transaction ever opens", async () => {
    const core = makeCore();
    const projectId = "prj_no_buzz_address";
    insertProject(core, projectId);
    const subject = makeSubject(core, {
      resolveBuzzAddress: fakeResolveBuzzAddress(deny(ReasonCode.PROBE_FAILED, "buzz transport is not available", {})),
    });
    const request = baseRequest(core, projectId);
    const before = rowCounts(core);
    const result = await subject.claim(request);

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.PROBE_FAILED);
    expect(rowCounts(core)).toEqual(before);
  });

  it("an unauthenticated buzz actor id refuses with zero additional rows, even after the session was created", async () => {
    const core = makeCore();
    const projectId = "prj_bad_buzz_actor";
    insertProject(core, projectId);
    const subject = makeSubject(core, { buzzActorAuthenticator: fakeBuzzActorAuthenticator(false) });
    const request = baseRequest(core, projectId);
    const before = rowCounts(core);
    const result = await subject.claim(request);

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED);
    expect(rowCounts(core)).toEqual(before);
  });

  it(
    "the same receipt is genuinely reusable after a rollback: consumed once per COMMIT, not per presentation",
    async () => {
      const core = makeCore();
      const projectId = "prj_consume_per_commit";
      insertProject(core, projectId);
      const approval = mintOwnerApproval(core, {
        projectId,
        claimedSessionUuid: CANON,
        expectedBindingGeneration: 1,
      });
      const before = rowCounts(core);

      // First attempt: `consumeApproval` runs and tentatively records `OWNER_APPROVAL_CONSUMED`
      // inside the transaction, but `bindBuzzActor` denies right after — a real, independent
      // failure (`fakeBuzzActorAuthenticator(false)`), not a contrived one. The whole transaction,
      // including the tentative consumption, rolls back.
      const failingSubject = makeSubject(core, { buzzActorAuthenticator: fakeBuzzActorAuthenticator(false) });
      const failed = await failingSubject.claim(baseRequest(core, projectId, { ownerApproval: approval }));
      expect(failed.allowed).toBe(false);
      expect(rowCounts(core), "the failed attempt must roll back everything, including consumption").toEqual(before);

      // Second attempt: the EXACT SAME receipt object, same generation (nothing committed, so
      // generation 1 is still next), this time with a working authenticator. If consumption were
      // durable across the first, rolled-back attempt, `OwnerAuthority` would deny this as already
      // consumed. It does not — consumption is scoped
      // to a committed transaction, not to a presentation of the receipt.
      const workingSubject = makeSubject(core);
      const succeeded = await workingSubject.claim(baseRequest(core, projectId, { ownerApproval: approval }));
      expect(succeeded.allowed, JSON.stringify(succeeded)).toBe(true);
    },
  );

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
  const AUTHORITY_ROOT = process.cwd();
  const AUTHORITY_ROOT_REALPATH = realpathSync(AUTHORITY_ROOT);
  const AUTHORITY_MODULE_PATH = join(AUTHORITY_ROOT, "src", "registry", "canonical-self-claim.ts");
  const AUTHORITY_MODULE_REALPATH = realpathSync(AUTHORITY_MODULE_PATH);
  const TEST_RELATIVE_PATH = ["tests", "unit", "canonical-self-claim.test.ts"] as const;

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
  const proveMutationOutcome = (
    mutate: (source: string) => string,
    testNameFragment: string,
    expectKilled: boolean,
  ): void => {
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
      let failed = false;
      try {
        execFileSync(
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
          { cwd: scratchRoot, encoding: "utf8", stdio: "pipe" },
        );
      } catch {
        failed = true;
      }

      const resultJson = JSON.parse(readFileSync(resultPath, "utf8")) as { testResults: Array<{ name: string }> };
      expect(resultJson.testResults[0]?.name).toBe(scratchTestFile);

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
    () => {
      proveMutationOutcome(
        (source) =>
          source.replace(
            "return this.db.txDecision((): Decision<CanonicalSelfClaimReceipt> => {",
            "return this.db.tx((): Decision<CanonicalSelfClaimReceipt> => {",
          ),
        "clause 3 — a duplicate live actor is refused with zero additional rows",
        true,
      );
    },
    60_000,
  );

  it(
    "identity substitution: trusting the caller's claimed UUID instead of the derived one un-kills the mismatch refusal",
    () => {
      proveMutationOutcome(
        (source) =>
          source.replace(
            "if (identity.sessionUuid !== request.claimedSessionUuid.toLowerCase()) {",
            "if (false) {",
          ),
        "clause 1 — a caller-supplied session UUID is checked against the derived one",
        true,
      );
    },
    60_000,
  );

  it(
    "pid-without-start-time: deleting the start-time pairing check admits a caller whose process identity was never confirmed",
    () => {
      proveMutationOutcome(
        (source) => source.replace("if (identity.startedAt === null) {", "if (false) {"),
        "clause 2 — pid and start time as a pair",
        true,
      );
    },
    60_000,
  );

  it(
    "owner-rejection bypass: deleting the approved!==true check lets an explicit refusal authorise the claim it names",
    () => {
      proveMutationOutcome(
        (source) => source.replace("if (request.ownerApproval.approved !== true) {", "if (false) {"),
        // Not the parenthesised full title: `vitest -t` compiles its argument as a RegExp on this
        // node build, and a pattern containing literal `text (text)` fails to match that exact
        // literal text. A paren-free, still-unique substring of the title sidesteps it.
        "must not authorise the claim it names",
        true,
      );
    },
    60_000,
  );

  /**
   * Removing the `consumeApproval` call does not fail "a replayed owner approval is refused the
   * second time": that replay presents the same generation the first claim already committed, and
   * the independent generation check — earlier in the same transaction, before consumption —
   * denies it for that reason alone. Consumption is still real and durable; a separate test
   * asserts the audit row it produces directly.
   */
  it(
    "consume-once bypass: removing the call does not fail the replay test, because the generation check is a redundant, earlier guard for this exact scenario",
    () => {
      proveMutationOutcome(
        (source) =>
          source.replace(
            "const consumed = this.ownerAuthority.consumeApproval(request.ownerApproval, null);\n      if (!consumed.allowed) return consumed as Decision<CanonicalSelfClaimReceipt>;",
            "",
          ),
        "a replayed owner approval is refused the second time",
        false,
      );
    },
    60_000,
  );
});
