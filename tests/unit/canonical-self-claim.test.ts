import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { roleKeyFor, Role } from "../../src/domain/types.ts";
import {
  CANONICAL_PROJECT_BUZZ_CHANNEL_ID,
  CANONICAL_SESSION_UUID,
  CanonicalSelfClaim,
  REQUIRED_EXECUTOR_VERSION,
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
const OWNER_DIRECTIVE = "owner-approved-canonical-cto-claim-2026-09-05";

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

const baseRequest = (
  core: CoreHarness,
  projectId: string,
  overrides: Partial<CanonicalSelfClaimRequest> = {},
): CanonicalSelfClaimRequest => ({
  callerPid: 100,
  claimedSessionUuid: CANON,
  projectId,
  ownerDirective: OWNER_DIRECTIVE,
  cwd: CWD,
  peerProtocolVersion: PEER_PROTOCOL,
  peerIdentity: PEER_IDENTITY,
  buzzChannelId: CHANNEL,
  ...overrides,
});

const makeSubject = (
  core: CoreHarness,
  options: {
    configOverrides?: Partial<CanonicalSelfClaimConfig>;
    chain?: readonly ProcessSnapshot[];
    imageInspector?: ExecutingImageInspector;
    transcriptReader?: TranscriptReader;
  } = {},
): CanonicalSelfClaim =>
  new CanonicalSelfClaim(
    core.db,
    core.clock,
    core.sessions,
    core.bindings,
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

    // RED: no claude ancestor exists anywhere in the chain up to pid 1.
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

    // RED for a different, distinguishable reason: a claude ancestor exists but names no session.
    const noSessionId = deriveClaimantIdentity(
      100,
      chainInspector([{ pid: 100, ppid: 1, command: "/usr/local/bin/claude --print hi", cwd: CWD, startedAt: "t1" }]),
    );
    expect(noSessionId.allowed).toBe(false);
    if (noSessionId.allowed) throw new Error("unreachable");
    expect(noSessionId.message).toContain("names no session id");

    // RED for a third reason: an ancestry cycle (a broken ps snapshot) never reaches pid 1.
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
  it("claims the canonical session in one atomic mutation, writing exactly one row to each of the five tables", () => {
    const core = makeCore();
    const projectId = "prj_canonical";
    insertProject(core, projectId);
    const subject = makeSubject(core);

    const before = rowCounts(core);
    const result = subject.claim(baseRequest(core, projectId));

    expect(result.allowed, JSON.stringify(result)).toBe(true);
    if (!result.allowed) return;
    expect(result.value.binding.role).toBe("PRIMARY_CTO");
    expect(result.value.binding.projectId).toBe(projectId);
    expect(result.value.derivedSessionUuid).toBe(CANON);
    expect(result.value.executorImageVersion).toBe(REQUIRED_EXECUTOR_VERSION);

    const after = rowCounts(core);
    for (const table of FIVE_TABLES) {
      expect(after[table], `table ${table}`).toBe((before[table] ?? 0) + 1);
    }
  });

  it("clause 1 — a caller-supplied session UUID is checked against the derived one, never substituted", () => {
    const core = makeCore();
    const projectId = "prj_uuid_mismatch";
    insertProject(core, projectId);
    const subject = makeSubject(core);
    const before = rowCounts(core);

    const result = subject.claim(baseRequest(core, projectId, { claimedSessionUuid: OTHER }));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.CONFLICT);
    expect(result.message).toContain("does not match the independently derived identity");
    expect(result.evidence).toMatchObject({ claimed: OTHER, derived: CANON });
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 1 — a caller-supplied pid is checked against the derived ancestor pid", () => {
    const core = makeCore();
    const projectId = "prj_pid_mismatch";
    insertProject(core, projectId);
    const subject = makeSubject(core);
    const before = rowCounts(core);

    const result = subject.claim(baseRequest(core, projectId, { claimedPid: 999 }));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.CONFLICT);
    expect(result.message).toContain("claimed pid does not match");
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 2 — pid and start time as a pair: an unresolvable start time refuses even though the pid matches", () => {
    const core = makeCore();
    const projectId = "prj_no_start_time";
    insertProject(core, projectId);
    const subject = makeSubject(core, { chain: standardChain({ startedAt: null }) });
    const before = rowCounts(core);

    const result = subject.claim(baseRequest(core, projectId));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("process start time could not be established");
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 2 — a headless invocation is refused as not interactive", () => {
    const core = makeCore();
    const projectId = "prj_headless";
    insertProject(core, projectId);
    const subject = makeSubject(core, {
      chain: standardChain({ command: `/usr/local/bin/claude -p --session-id ${CANON}` }),
    });
    const before = rowCounts(core);

    const result = subject.claim(baseRequest(core, projectId));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("not an interactive CLI invocation");
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 2 — cwd must match exactly", () => {
    const core = makeCore();
    const projectId = "prj_cwd";
    insertProject(core, projectId);
    const subject = makeSubject(core, { chain: standardChain({ cwd: "/somewhere/else" }) });
    const before = rowCounts(core);

    const result = subject.claim(baseRequest(core, projectId));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("working directory does not match");
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 2 — peer protocol version must match the deployment's expectation", () => {
    const core = makeCore();
    const projectId = "prj_peer_protocol";
    insertProject(core, projectId);
    const subject = makeSubject(core);
    const before = rowCounts(core);

    const result = subject.claim(baseRequest(core, projectId, { peerProtocolVersion: "mcp/2024-01-01" }));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("peer protocol version");
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 2 — target version exactly 2.1.259, from the executing image, not any other observed version", () => {
    const core = makeCore();
    const projectId = "prj_version";
    insertProject(core, projectId);
    const subject = makeSubject(core, { imageInspector: fakeImageInspector("2.1.241") });
    const before = rowCounts(core);

    const result = subject.claim(baseRequest(core, projectId));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("not the required version");
    expect(result.evidence).toMatchObject({ observedVersion: "2.1.241", requiredVersion: "2.1.259" });
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 2 — an unresolvable executing image refuses fail-closed", () => {
    const core = makeCore();
    const projectId = "prj_no_image";
    insertProject(core, projectId);
    const subject = makeSubject(core, { imageInspector: { resolve: () => null } });
    const before = rowCounts(core);

    const result = subject.claim(baseRequest(core, projectId));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("executing image could not be resolved");
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 2 — the transcript must exist on disk", () => {
    const core = makeCore();
    const projectId = "prj_no_transcript";
    insertProject(core, projectId);
    const subject = makeSubject(core, { transcriptReader: fakeTranscriptReader(false) });
    const before = rowCounts(core);

    const result = subject.claim(baseRequest(core, projectId));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.NOT_FOUND);
    expect(result.message).toContain("no transcript exists");
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 2 — the connected peer identity must match the deployment's expectation", () => {
    const core = makeCore();
    const projectId = "prj_peer_identity";
    insertProject(core, projectId);
    const subject = makeSubject(core);
    const before = rowCounts(core);

    const result = subject.claim(baseRequest(core, projectId, { peerIdentity: "someone-else" }));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("connected peer identity");
    expect(rowCounts(core)).toEqual(before);
  });

  it("the buzz channel check is real, not decorative: the wrong channel refuses exactly like the live PROBE_FAILED case", () => {
    const core = makeCore();
    const projectId = "prj_channel";
    insertProject(core, projectId);
    const subject = makeSubject(core);
    const before = rowCounts(core);

    const result = subject.claim(baseRequest(core, projectId, { buzzChannelId: "DM" }));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("not the canonical project channel");
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 4 — only the exact canonical session may be adopted; a different, otherwise-valid session is refused, not bootstrapped", () => {
    const core = makeCore();
    const projectId = "prj_other_session";
    insertProject(core, projectId);
    // Everything about this claim is otherwise perfect — it is a real, live, correctly versioned
    // interactive claude process with a real transcript. It simply is not the one canonical UUID.
    const subject = makeSubject(core, { chain: standardChain({}, OTHER) });
    const before = rowCounts(core);

    const result = subject.claim(baseRequest(core, projectId, { claimedSessionUuid: OTHER }));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.message).toContain("only the canonical session may be adopted");
    expect(rowCounts(core)).toEqual(before);
  });

  it("clause 3 — a duplicate live actor is refused with zero additional rows, even though the session insert already ran inside the transaction", () => {
    const core = makeCore();
    const projectId = "prj_duplicate";
    insertProject(core, projectId);
    const subject = makeSubject(core);

    const first = subject.claim(baseRequest(core, projectId));
    expect(first.allowed).toBe(true);
    const afterFirst = rowCounts(core);

    const second = subject.claim(baseRequest(core, projectId));
    expect(second.allowed).toBe(false);
    if (second.allowed) return;
    expect(second.reasonCode).toBe(ReasonCode.BINDING_ALREADY_ACTIVE);

    // This is the assertion that matters: `sessions.create()` ran again inside `#mutate` before
    // `bindings.bind()` denied. If the outer transaction were `db.tx` instead of `db.txDecision`
    // (see the "atomicity" describe block below for the mutation that proves this), that second
    // session row would have been committed anyway. Reading the return value alone cannot see it.
    expect(rowCounts(core)).toEqual(afterFirst);
  });

  it("clause 4 restore — the same external session, reclaimed after a revoke, reuses the actor and target binding rather than minting a second owner", () => {
    const core = makeCore();
    const projectId = "prj_restore";
    insertProject(core, projectId);
    const subject = makeSubject(core);

    const first = subject.claim(baseRequest(core, projectId));
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

    // A new process start time and a new session incarnation — the same external Claude session
    // UUID. (The pid itself is left unchanged: CP-HI-04's point is that a pid alone identifies
    // nothing, which is exactly why this restore is proven by a differing start time, not a
    // differing pid.)
    const restoreSubject = makeSubject(core, {
      chain: standardChain({ startedAt: "Fri Jan  1 01:00:00 2027" }),
    });
    const before = rowCounts(core);
    const restored = restoreSubject.claim(baseRequest(core, projectId));

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
    // Not a new actor and not a new target binding — the whole point of clause 4.
    expect(after.conversational_actors).toBe(before.conversational_actors);
    expect(after.actor_target_bindings).toBe(before.actor_target_bindings);
  });

  it("clause 5 — never creates or touches a Hermes/CEO actor; the resulting actor's kind is PRIMARY_CTO alone", () => {
    const core = makeCore();
    const projectId = "prj_no_hermes";
    insertProject(core, projectId);
    const subject = makeSubject(core);

    const result = subject.claim(baseRequest(core, projectId));
    expect(result.allowed).toBe(true);

    const kinds = core.db.all<{ kind: string }>(`SELECT kind FROM conversational_actors`);
    expect(kinds).toEqual([{ kind: "PRIMARY_CTO" }]);
    const ceoRows = core.db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM assignments WHERE role = 'CEO'`,
    );
    expect(ceoRows?.c).toBe(0);
  });

  it("rejects an owner directive that is empty or trivially short, before any derivation runs", () => {
    const core = makeCore();
    const projectId = "prj_directive";
    insertProject(core, projectId);
    const subject = makeSubject(core);
    const before = rowCounts(core);

    const result = subject.claim(baseRequest(core, projectId, { ownerDirective: "short" }));

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
    expect(rowCounts(core)).toEqual(before);
  });

  it("rejects a malformed claimed session UUID as an argument error, not a derivation mismatch", () => {
    const core = makeCore();
    const projectId = "prj_malformed_uuid";
    insertProject(core, projectId);
    const subject = makeSubject(core);

    const result = subject.claim(baseRequest(core, projectId, { claimedSessionUuid: "not-a-uuid" }));

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
});
