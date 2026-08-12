import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

import { isoPlus } from "../../src/core/clock.ts";
import { canonicalJson, digestOf } from "../../src/core/digest.ts";
import { isAcpError } from "../../src/core/errors.ts";
import { newAssignmentId, normalizeRemoteIdentity } from "../../src/core/ids.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { canTransition, isTerminal } from "../../src/domain/run-state.ts";
import { RunState } from "../../src/domain/types.ts";
import { ManagedWriteGuard, ReadOperation, WriteOperation } from "../../src/guard/managed-write-guard.ts";
import { fakeWorkspaceProbe, realWorkspaceProbe } from "../../src/guard/workspace-probe.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import {
  buildCandidateSnapshot,
  candidateSnapshotDigest,
  verifySnapshotFreshness,
} from "../../src/snapshot/candidate-snapshot.ts";
import { parseVerificationCommand } from "../../src/contracts/verification-command.ts";
import { assertPortableManifest, PROJECT_MANIFEST_SCHEMA_ID } from "../../src/contracts/manifest.ts";
import { buildSandboxEnvironment, runSandboxed } from "../../src/verify/sandbox.ts";
import {
  cleanupTempDirs,
  commitAll,
  gitSync,
  makeCore,
  makeRepo,
  seedRun,
  tempDir,
  writeFiles,
} from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

describe("canonical digests (CP-HI-06)", () => {
  it("is key-order independent and undefined-stable", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(digestOf({ a: 1, b: undefined })).toBe(digestOf({ a: 1 }));
  });

  it("changes when any meaningful field changes", () => {
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }));
  });

  it("normalizes remote identities", () => {
    expect(normalizeRemoteIdentity("git@github.com:acme/repo.git")).toBe("github:acme/repo");
    expect(normalizeRemoteIdentity("https://github.com/acme/repo")).toBe("github:acme/repo");
    expect(normalizeRemoteIdentity("https://gitlab.com/acme/repo.git")).toBe("git:gitlab.com/acme/repo");
  });
});

describe("run state machine (PRD §29.2)", () => {
  it("permits exactly the documented transitions", () => {
    expect(canTransition(RunState.QUEUED, RunState.ACTIVE).allowed).toBe(true);
    expect(canTransition(RunState.ACTIVE, RunState.READY_FOR_CEO_REVIEW).allowed).toBe(true);
    expect(canTransition(RunState.READY_FOR_CEO_REVIEW, RunState.COMPLETED).allowed).toBe(true);
    expect(canTransition(RunState.REVISION_REQUIRED, RunState.ACTIVE).allowed).toBe(true);
  });

  it("rejects undocumented transitions and terminal mutation", () => {
    const illegal = canTransition(RunState.QUEUED, RunState.COMPLETED);
    expect(illegal.allowed).toBe(false);
    expect(illegal.reasonCode).toBe(ReasonCode.RUN_TRANSITION_ILLEGAL);

    const terminal = canTransition(RunState.COMPLETED, RunState.ACTIVE);
    expect(terminal.reasonCode).toBe(ReasonCode.RUN_ALREADY_TERMINAL);
    expect(isTerminal(RunState.CANCELLED)).toBe(true);
  });
});

describe("database hard constraints (PRD §30.2)", () => {
  it("allows only one active primary CTO binding per project", () => {
    const { db, clock } = makeCore();
    const repo = makeRepo();
    const seeded = seedRun({ db, clock, repoPath: repo });

    const second = db.run(
      `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
       VALUES ('ses_second', 'inc-2', 'claude', 'opus', 'READY', ?, ?)`,
      [clock.nowIso(), clock.nowIso()],
    );
    expect(second.changes).toBe(1);

    expect(() =>
      db.run(
        `INSERT INTO assignments (assignment_id, role_key, role, project_id, session_id,
                                  session_incarnation, binding_generation, mode, status, created_at)
         VALUES (?, ?, 'PRIMARY_CTO', ?, 'ses_second', 'inc-2', 2, 'PREFERRED', 'ACTIVE', ?)`,
        [newAssignmentId(), `PRIMARY_CTO:other-key`, seeded.projectId, clock.nowIso()],
      ),
    ).toThrowError(/active primary CTO/);
  });

  it("enforces monotonic binding generation per role key", () => {
    const { db, clock } = makeCore();
    const repo = makeRepo();
    const seeded = seedRun({ db, clock, repoPath: repo });

    db.run(`UPDATE assignments SET status = 'REVOKED' WHERE role_key = ?`, [seeded.roleKey]);
    expect(() =>
      db.run(
        `INSERT INTO assignments (assignment_id, role_key, role, project_id, session_id,
                                  session_incarnation, binding_generation, mode, status, created_at)
         VALUES (?, ?, 'PRIMARY_CTO', ?, ?, 'inc-1', 1, 'PREFERRED', 'ACTIVE', ?)`,
        [newAssignmentId(), seeded.roleKey, seeded.projectId, seeded.sessionId, clock.nowIso()],
      ),
    ).toThrowError(/BINDING_GENERATION_NOT_MONOTONIC/);
  });

  it("keeps session incarnation immutable", () => {
    const { db, clock } = makeCore();
    const repo = makeRepo();
    const seeded = seedRun({ db, clock, repoPath: repo });
    expect(() =>
      db.run(`UPDATE sessions SET incarnation = 'inc-9' WHERE session_id = ?`, [seeded.sessionId]),
    ).toThrowError(/SESSION_INCARNATION_IMMUTABLE/);
  });

  it("rejects a second holder of the same branch, worktree or exact path", () => {
    const { db, clock } = makeCore();
    const repo = makeRepo();
    const seeded = seedRun({ db, clock, repoPath: repo });
    const base = [seeded.identity, seeded.runId, seeded.sessionId, 1, clock.nowIso(), clock.nowIso()];

    db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, branch, run_id, owner_session_id,
                                    owner_binding_generation, acquired_at, expires_at, status)
       VALUES ('c1', ?, 'feature/x', ?, ?, ?, ?, ?, 'HELD')`,
      base,
    );
    expect(() =>
      db.run(
        `INSERT INTO resource_claims (claim_id, repository_identity, branch, run_id, owner_session_id,
                                      owner_binding_generation, acquired_at, expires_at, status)
         VALUES ('c2', ?, 'feature/x', ?, ?, ?, ?, ?, 'HELD')`,
        base,
      ),
    ).toThrowError(/branch already claimed/);
  });

  it("requires a candidate snapshot digest on verification and review artifacts", () => {
    const { db, clock } = makeCore();
    const repo = makeRepo();
    const seeded = seedRun({ db, clock, repoPath: repo });
    expect(() =>
      db.run(
        `INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, content_json, created_at)
         VALUES ('a1', ?, 'BLIND_REVIEW', 'sha256:x', '{}', ?)`,
        [seeded.runId, clock.nowIso()],
      ),
    ).toThrowError();
  });

  it("keeps artifacts and audit events immutable", () => {
    const { db, clock, audit } = makeCore();
    const repo = makeRepo();
    const seeded = seedRun({ db, clock, repoPath: repo });
    db.run(
      `INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, content_json, created_at)
       VALUES ('a1', ?, 'PLAN', 'sha256:x', '{}', ?)`,
      [seeded.runId, clock.nowIso()],
    );
    expect(() =>
      db.run(`UPDATE run_artifacts SET content_json = '{"tampered":true}' WHERE artifact_id = 'a1'`),
    ).toThrowError(/ARTIFACT_IMMUTABLE/);

    audit.record({ kind: "TEST", evidence: { ok: true } });
    expect(() => db.run(`UPDATE audit_events SET kind = 'CHANGED'`)).toThrowError(/AUDIT_APPEND_ONLY/);
  });
});

describe("audit redaction (PRD §31.5)", () => {
  it("removes secrets and refuses to store transcripts", () => {
    const { db, audit } = makeCore();
    audit.record({
      kind: "TEST",
      evidence: { githubToken: "ghp_secret", transcript: "long chat", nested: { apiKey: "sk-x" } },
    });
    const row = db.get<{ evidence_json: string }>(`SELECT evidence_json FROM audit_events`);
    const evidence = JSON.parse(row!.evidence_json) as Record<string, unknown>;
    expect(evidence["githubToken"]).toBe("[redacted]");
    expect(evidence["transcript"]).toBe("[not-stored]");
    expect((evidence["nested"] as Record<string, unknown>)["apiKey"]).toBe("[redacted]");
  });
});

describe("managed write guard (CP-HI-01)", () => {
  const setup = () => {
    const core = makeCore();
    const repo = makeRepo();
    const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: repo });
    const guard = new ManagedWriteGuard(core.db, realWorkspaceProbe, core.audit, core.clock);
    return { ...core, repo, seeded, guard };
  };

  it("CP-S01: read-only repository analysis stays DIRECT", () => {
    const { guard, repo } = setup();
    const decision = guard.evaluate({
      operation: ReadOperation.FILE_READ,
      targetPath: join(repo, "README.md"),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reasonCode).toBe(ReasonCode.DIRECT_READ_ONLY_ALLOWED);
  });

  it("CP-S02: a DIRECT-labelled mutation inside a repo is denied without a managed run", () => {
    const { guard, repo } = setup();
    const decision = guard.evaluate({
      operation: WriteOperation.FILE_MUTATION,
      targetPath: join(repo, "src/app.ts"),
      claimedClassification: "DIRECT",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.WRITE_REQUIRES_MANAGED_RUN);
  });

  it("CP-S03: the same mutation passes with a valid run identity", () => {
    const { guard, repo, seeded } = setup();
    const decision = guard.evaluate({
      operation: WriteOperation.FILE_MUTATION,
      targetPath: join(repo, "src/app.ts"),
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reasonCode).toBe(ReasonCode.WRITE_ALLOWED);
  });

  it("requires an explicit independent-artifact root outside any git work tree", () => {
    const { guard } = setup();
    const outside = join("/tmp", "acp-standalone-note.md");
    const decision = guard.evaluate({
      operation: WriteOperation.FILE_MUTATION,
      targetPath: outside,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.DIRECT_WRITE_ROOT_REQUIRED);
  });

  it("rejects a stale binding generation", () => {
    const { guard, repo, seeded } = setup();
    const decision = guard.evaluate({
      operation: WriteOperation.FILE_MUTATION,
      targetPath: join(repo, "src/app.ts"),
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: 99,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.WRITE_BINDING_GENERATION_STALE);
  });

  it("rejects a target outside the run's repositories", () => {
    const { guard, seeded } = setup();
    const other = makeRepo();
    const decision = guard.evaluate({
      operation: WriteOperation.FILE_MUTATION,
      targetPath: join(other, "x.txt"),
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE);
  });

  it("CP-S14: rejects an exact path already claimed by another run", () => {
    const { guard, repo, seeded, db, clock } = setup();
    db.run(
      `INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal,
                         contract_digest, created_at)
       VALUES ('run_other', ?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'ACTIVE', 'other', 'sha256:c', ?)`,
      [seeded.projectId, clock.nowIso()],
    );
    db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, declared_path, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES ('c9', ?, 'src/app.ts', 'run_other', ?, 1, ?, ?, 'HELD')`,
      // A live lease: a claim whose expiry has already passed must not block anyone.
      [seeded.identity, seeded.sessionId, clock.nowIso(), isoPlus(clock.nowIso(), 3_600_000)],
    );

    const decision = guard.evaluate({
      operation: WriteOperation.FILE_MUTATION,
      targetPath: join(repo, "src/app.ts"),
      runId: seeded.runId,
      sessionId: seeded.sessionId,
      bindingGeneration: seeded.generation,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.WRITE_PATH_NOT_CLAIMED);
  });

  it("classifies path-free github operations by repository participation", () => {
    const { guard, seeded } = setup();
    expect(
      guard.evaluate({
        operation: WriteOperation.GITHUB_PR,
        repositoryIdentity: seeded.identity,
        runId: seeded.runId,
        sessionId: seeded.sessionId,
        bindingGeneration: seeded.generation,
      }).allowed,
    ).toBe(true);

    expect(
      guard.evaluate({
        operation: WriteOperation.GITHUB_PR,
        repositoryIdentity: "github:acme/unrelated",
        runId: seeded.runId,
        sessionId: seeded.sessionId,
        bindingGeneration: seeded.generation,
      }).reasonCode,
    ).toBe(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE);
  });

  it("uses the injected probe rather than trusting the caller's label", () => {
    const core = makeCore();
    const guard = new ManagedWriteGuard(
      core.db,
      fakeWorkspaceProbe(["/synthetic/repo"]),
      core.audit,
      core.clock,
    );
    const decision = guard.evaluate({
      operation: WriteOperation.FILE_MUTATION,
      targetPath: "/synthetic/repo/a.ts",
      claimedClassification: "DIRECT",
    });
    expect(decision.reasonCode).toBe(ReasonCode.WRITE_REQUIRES_MANAGED_RUN);
  });
});

describe("outbox fencing (PRD §15.7, §27.5)", () => {
  const enqueue = (kind: MessageKind = MessageKind.RUN_DISPATCH) => {
    const core = makeCore();
    const repo = makeRepo();
    const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: repo });
    const message = core.outbox.enqueue({
      idempotencyKey: `dispatch:${seeded.runId}`,
      roleKey: seeded.roleKey,
      bindingGeneration: 1,
      targetSessionId: seeded.sessionId,
      runId: seeded.runId,
      kind,
      payload: { runId: seeded.runId },
    });
    return { ...core, seeded, message };
  };

  it("CP-S49: suppresses a replayed enqueue by idempotency key", () => {
    const { outbox, seeded, message } = enqueue();
    const replay = outbox.enqueue({
      idempotencyKey: `dispatch:${seeded.runId}`,
      roleKey: seeded.roleKey,
      bindingGeneration: 1,
      targetSessionId: seeded.sessionId,
      runId: seeded.runId,
      kind: MessageKind.RUN_DISPATCH,
      payload: { runId: seeded.runId },
    });
    expect(replay.reasonCode).toBe(ReasonCode.OUTBOX_DUPLICATE_SUPPRESSED);
    expect(replay.allowed && replay.value.messageId).toBe(message.allowed && message.value.messageId);
  });

  it("CP-S23: an ack from a superseded generation is audit-only", () => {
    const { outbox, seeded, message } = enqueue();
    const id = message.allowed ? message.value.messageId : "";
    const ack = outbox.acknowledge(id, seeded.sessionId, 99);
    expect(ack.allowed).toBe(false);
    expect(ack.reasonCode).toBe(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED);
    expect(outbox.get(id)?.status).toBe("PENDING");
  });

  it("retargets role-level messages and rejects incarnation-specific ones", () => {
    const retarget = enqueue(MessageKind.RUN_DISPATCH);
    const out1 = retarget.outbox.retargetOrReject(retarget.seeded.roleKey, 1, 2, "ses_new");
    expect(out1.retargeted).toHaveLength(1);
    expect(retarget.outbox.get(out1.retargeted[0]!)?.bindingGeneration).toBe(2);

    const handoff = enqueue(MessageKind.HANDOFF_PACKAGE);
    const out2 = handoff.outbox.retargetOrReject(handoff.seeded.roleKey, 1, 2, "ses_new");
    expect(out2.rejected).toHaveLength(1);
    expect(handoff.outbox.get(out2.rejected[0]!)?.status).toBe("REJECTED");
  });

  it("CP-S50: only messages matching the currently active generation are deliverable", () => {
    const { outbox, db, seeded, clock } = enqueue();
    expect(outbox.claimDeliverable()).toHaveLength(1);

    // Move the generation the way production does: revoke, then bind the successor.
    // Updating binding_generation in place is refused by the schema, precisely so a stale
    // generation cannot be reactivated.
    db.run(`UPDATE assignments SET status = 'REVOKED' WHERE role_key = ?`, [seeded.roleKey]);
    db.run(
      `INSERT INTO assignments (assignment_id, role_key, role, project_id, run_id, session_id,
                                session_incarnation, binding_generation, mode, status, created_at)
       VALUES (?, ?, 'PRIMARY_CTO', ?, ?, ?, 'inc-1', 2, 'PREFERRED', 'ACTIVE', ?)`,
      [
        newAssignmentId(),
        seeded.roleKey,
        seeded.projectId,
        seeded.runId,
        seeded.sessionId,
        clock.nowIso(),
      ],
    );
    expect(outbox.claimDeliverable()).toHaveLength(0);
  });

  it("expires overdue messages instead of delivering them late", () => {
    const { outbox, clock } = enqueue();
    clock.advance(31 * 60 * 1000);
    expect(outbox.expireOverdue()).toBe(1);
    expect(outbox.claimDeliverable()).toHaveLength(0);
  });
});

describe("verification command contract (PRD §17.2, Integration §12)", () => {
  it("RF-S07: accepts argv and rejects shell pipelines", () => {
    expect(() => parseVerificationCommand({ id: "test", argv: ["npm", "test"] })).not.toThrow();
    expect(() =>
      parseVerificationCommand({ id: "test", argv: ["sh", "-c", "npm test | tee out"] }),
    ).toThrow();
    expect(() =>
      parseVerificationCommand({ id: "test", argv: ["npm", "test", "&&", "rm -rf /"] }),
    ).toThrow();
  });

  it("rejects an absolute or escaping cwd", () => {
    expect(() => parseVerificationCommand({ id: "t", argv: ["ls"], cwd: "/etc" })).toThrow();
    expect(() => parseVerificationCommand({ id: "t", argv: ["ls"], cwd: "../.." })).toThrow();
  });
});

describe("portable project manifest (Integration §10.2)", () => {
  const base = {
    schema: PROJECT_MANIFEST_SCHEMA_ID,
    projectId: "example",
    repositories: [{ role: "primary", remote: "github:acme/example", manifestRoot: "." }],
    branchProfile: {
      longLived: ["main", "dev"],
      defaultBranch: "dev",
      updateStrategy: "rebase_before_review",
      mergeStrategy: "merge_commit",
      releaseTagPolicy: "semver",
      releaseBranchCleanup: "keep",
    },
    verificationProfiles: { simple: ["test"], standard: ["test"], guarded: ["test"] },
    verificationCommands: [
      {
        id: "test",
        argv: ["npm", "test"],
        repositoryRole: "primary",
        cwd: ".",
        timeoutSeconds: 600,
        envAllowlist: ["CI"],
        network: "deny",
        networkAllowlist: [],
        required: true,
        evidenceMode: "LOCAL_COMMAND",
        maxOutputBytes: 1048576,
        maxMemoryMb: 4096,
      },
    ],
    postMergeCommands: [],
    ciWorkflows: [],
    commitlore: { mode: "preferred" },
  };

  it("accepts a portable manifest", () => {
    expect(assertPortableManifest(base).allowed).toBe(true);
  });

  it("CP-S04 / RF-S05: rejects absolute paths and session identifiers", () => {
    const withPath = { ...base, repositories: [{ role: "primary", remote: "/Users/example/x", manifestRoot: "." }] };
    const decision = assertPortableManifest(withPath);
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.MANIFEST_NOT_PORTABLE);

    const withSession = { ...base, projectId: "ses_abcdefgh12345678" };
    expect(assertPortableManifest(withSession).allowed).toBe(false);
  });

  it("rejects a profile that references an unknown command", () => {
    const broken = { ...base, verificationProfiles: { simple: ["nope"], standard: [], guarded: [] } };
    expect(assertPortableManifest(broken).allowed).toBe(false);
  });
});

describe("candidate snapshot (PRD §16)", () => {
  it("CP-S25: freezes every repository and goes stale when one head moves", async () => {
    const { clock } = makeCore();
    const repoA = makeRepo({ "a.txt": "1\n" });
    const repoB = makeRepo({ "b.txt": "1\n" });
    // Work on a branch cut from the base, as the branch contract requires: committing on
    // the base itself would make baseBranch and the candidate the same commit, and the
    // freshness check compares the base branch against the frozen base head.
    gitSync(repoA, ["checkout", "-q", "-b", "task/T1-a"]);
    writeFiles(repoA, { "a.txt": "2\n" });
    commitAll(repoA, "change a");

    const snapshot = await buildCandidateSnapshot(
      {
        runId: "run_1",
        contractDigest: "sha256:contract",
        repositories: [
          { identity: "github:acme/a", repositoryRole: "primary", checkoutPath: repoA, baseBranch: "dev", baseRef: "dev" },
          { identity: "github:acme/b", repositoryRole: "secondary", checkoutPath: repoB, baseBranch: "dev", baseRef: "HEAD" },
        ],
      },
      clock,
    );

    expect(snapshot.repositories).toHaveLength(2);
    expect(snapshot.repositories.find((r) => r.identity === "github:acme/a")?.touchedPaths).toEqual([
      "a.txt",
    ]);

    const probes = [
      { identity: "github:acme/a", checkoutPath: repoA },
      { identity: "github:acme/b", checkoutPath: repoB },
    ];
    expect((await verifySnapshotFreshness(snapshot, probes)).allowed).toBe(true);

    writeFiles(repoB, { "b.txt": "moved\n" });
    commitAll(repoB, "move b");
    const stale = await verifySnapshotFreshness(snapshot, probes);
    expect(stale.allowed).toBe(false);
    expect(stale.reasonCode).toBe(ReasonCode.SNAPSHOT_STALE);
  });

  it("produces a stable digest for identical content and a different one after a change", async () => {
    const { clock } = makeCore();
    const repo = makeRepo({ "a.txt": "1\n" });
    const input = {
      runId: "run_1",
      contractDigest: "sha256:c",
      repositories: [
        { identity: "github:acme/a", repositoryRole: "primary", checkoutPath: repo, baseBranch: "dev", baseRef: "HEAD" },
      ],
    };
    const first = await buildCandidateSnapshot(input, clock);
    clock.advance(60_000);
    const second = await buildCandidateSnapshot(input, clock);
    expect(candidateSnapshotDigest(first)).toBe(candidateSnapshotDigest(second));

    writeFiles(repo, { "a.txt": "2\n" });
    commitAll(repo, "change");
    const third = await buildCandidateSnapshot(input, clock);
    expect(candidateSnapshotDigest(third)).not.toBe(candidateSnapshotDigest(first));
  });
});

describe("verification sandbox (PRD §17.4)", () => {
  it("CP-S27: a candidate command cannot read authority secrets from the environment", async () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, "probe.js"),
      `const leak = Object.keys(process.env).filter(k => /TOKEN|SECRET|BUZZ|ANTHROPIC/i.test(k));
       console.log(JSON.stringify({ leak, home: process.env.HOME }));`,
    );
    process.env["ACP_TRUSTED_GITHUB_TOKEN"] = "ghp_should_not_leak";
    process.env["BUZZ_PRIVATE_KEY"] = "nsec1shouldnotleak";

    const outcome = await runSandboxed({
      command: parseVerificationCommand({
        id: "probe",
        argv: ["node", "probe.js"],
        envAllowlist: ["CI", "ACP_TRUSTED_GITHUB_TOKEN"],
        timeoutSeconds: 60,
      }),
      worktreePath: repo,
    });

    delete process.env["ACP_TRUSTED_GITHUB_TOKEN"];
    delete process.env["BUZZ_PRIVATE_KEY"];

    expect(outcome.status).toBe("PASS");
    const parsed = JSON.parse(outcome.stdout) as { leak: string[]; home: string };
    expect(parsed.leak).toEqual([]);
    expect(parsed.home).not.toBe(process.env["HOME"]);
    expect(outcome.enforcement.secretsStripped).toBe(true);
  });

  it("#329 denies an attempted credential-store read made inside the command", async () => {
    const repo = makeRepo();
    const secrets = tempDir("acp-secrets-");
    const credentialPath = join(secrets, "github-authority.token");
    writeFileSync(credentialPath, "ghp_secret_value_here");
    writeFileSync(
      join(repo, "peek.js"),
      `const fs = require('fs');
       const credentialPath = ${JSON.stringify(credentialPath)};
       let errno = null;
       try { fs.readFileSync(credentialPath, 'utf8'); } catch (error) { errno = error.code ?? null; }
       console.log(JSON.stringify({ errno }));`,
    );

    const outcome = await runSandboxed({
      command: parseVerificationCommand({
        id: "peek",
        argv: ["node", "peek.js"],
        timeoutSeconds: 60,
      }),
      worktreePath: repo,
      denyReadPaths: [secrets],
    });

    expect(outcome).toMatchObject({
      status: "PASS",
      reasonCode: null,
      enforcement: { readConfinement: "sensitive-paths" },
    });
    expect(JSON.parse(outcome.stdout)).toEqual({ errno: "EPERM" });
  });

  it("#308 drops a credential-shaped value even through an allowlisted name", () => {
    const command = parseVerificationCommand({
      id: "env",
      argv: ["node", "-e", "process.exit(0)"],
      envAllowlist: ["TZ"],
    });
    const credential = buildSandboxEnvironment(
      command,
      tempDir("acp-env-"),
      { TZ: "ghp_abcdefghijklmnopqrstuvwxyz01" },
    );
    const safe = buildSandboxEnvironment(command, tempDir("acp-env-"), { TZ: "Etc/UTC" });
    expect(credential.TZ).toBeUndefined();
    expect(safe.TZ).toBe("Etc/UTC");
  });

  it("refuses network=allowlist rather than pretending to enforce it", async () => {
    const repo = makeRepo();
    const outcome = await runSandboxed({
      command: parseVerificationCommand({
        id: "net",
        argv: ["node", "-e", "console.log(1)"],
        network: "allowlist",
        networkAllowlist: ["registry.npmjs.org"],
        timeoutSeconds: 30,
      }),
      worktreePath: repo,
    });
    expect(outcome.status).toBe("ERROR");
    expect(outcome.reasonCode).toBe(ReasonCode.SANDBOX_NETWORK_DENIED);
    expect(outcome.enforcement.readConfinement).toBe("none");
  });

  it("#318 returns the kernel network-denial errno for a refused connection", async () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, "network.js"),
      `const net = require('node:net');
       const socket = net.connect({ host: '203.0.113.1', port: 443 });
       const timer = setTimeout(() => {
         socket.destroy();
         console.log(JSON.stringify({ event: 'timeout', errno: null }));
       }, 1_000);
       socket.once('connect', () => {
         clearTimeout(timer);
         socket.destroy();
         console.log(JSON.stringify({ event: 'connected', errno: null }));
       });
       socket.once('error', (error) => {
         clearTimeout(timer);
         console.log(JSON.stringify({ event: 'error', errno: error.code ?? null }));
       });`,
    );
    const outcome = await runSandboxed({
      command: parseVerificationCommand({
        id: "net",
        argv: ["node", "network.js"],
        network: "deny",
        timeoutSeconds: 30,
      }),
      worktreePath: repo,
    });
    expect(outcome).toMatchObject({
      status: "PASS",
      reasonCode: null,
      enforcement: { networkEnforced: true, networkPolicy: "deny" },
    });
    expect(JSON.parse(outcome.stdout)).toEqual({ event: "error", errno: "EPERM" });
  });

  it("confines writes to the worktree", async () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, "write.js"),
      `const fs = require('fs');
       let inside = false, outside = false;
       try { fs.writeFileSync('inside.txt', 'x'); inside = true; } catch {}
       try { fs.writeFileSync('/Users/shared-acp-escape.txt', 'x'); outside = true; } catch {}
       console.log(JSON.stringify({ inside, outside }));`,
    );
    const outcome = await runSandboxed({
      command: parseVerificationCommand({ id: "w", argv: ["node", "write.js"], timeoutSeconds: 60 }),
      worktreePath: repo,
    });
    expect(JSON.parse(outcome.stdout)).toEqual({ inside: true, outside: false });
    expect(outcome.enforcement.writeConfinement).toBe(true);
  });

  it("CP-S28: times out and reaps an in-group child when one can start", async () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, "hang.js"),
      `const { spawn } = require('child_process');
       const report = (childPid) => console.log(JSON.stringify({ childPid }));
       try {
         const child = spawn('sleep', ['120'], { stdio: 'ignore', detached: false });
         child.once('spawn', () => report(child.pid));
         child.once('error', () => report(null));
       } catch { report(null); }
       setInterval(() => {}, 1000);`,
    );
    const started = Date.now();
    const outcome = await runSandboxed({
      command: parseVerificationCommand({ id: "hang", argv: ["node", "hang.js"], timeoutSeconds: 2 }),
      worktreePath: repo,
    });
    expect(outcome.status).toBe("TIMEOUT");
    expect(outcome.reasonCode).toBe(ReasonCode.VERIFICATION_TIMEOUT);
    const child = JSON.parse(outcome.stdout) as { childPid: number | null };
    if (child.childPid !== null) {
      expect(() => process.kill(child.childPid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    }
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("truncates and flags oversized output rather than buffering it all", async () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo, "spam.js"),
      `const line = 'x'.repeat(1000); for (let i = 0; i < 5000; i++) console.log(line);`,
    );
    const outcome = await runSandboxed({
      command: parseVerificationCommand({
        id: "spam",
        argv: ["node", "spam.js"],
        timeoutSeconds: 60,
        maxOutputBytes: 10_000,
      }),
      worktreePath: repo,
    });
    expect(outcome.outputTruncated).toBe(true);
    expect(outcome.reasonCode).toBe(ReasonCode.VERIFICATION_OUTPUT_TRUNCATED);
  });
});

describe("error contract", () => {
  it("#317 translates a database CHECK failure into a stable reason code and evidence", () => {
    const { db } = makeCore();
    let caught: unknown;
    try {
      db.run(`INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
              VALUES ('s', 'i', 'p', 'm', 'NOPE', 'x', 'x')`);
    } catch (err) {
      caught = err;
    }
    expect(isAcpError(caught)).toBe(true);
    if (!isAcpError(caught)) return;
    expect(caught.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
    expect(caught.evidence).toHaveProperty("sqlite");
  });
});
