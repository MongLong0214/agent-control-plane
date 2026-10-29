import Database from "better-sqlite3";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { parseVerificationCommand } from "../../src/contracts/verification-command.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Db, SCHEMA_VERSION } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { MIGRATIONS } from "../../src/db/migrations.ts";
import { ArtifactKind, ExecutionMode, RunKind } from "../../src/domain/types.ts";
import { candidateSnapshotDigest } from "../../src/snapshot/candidate-snapshot.ts";
import type { VerificationReport } from "../../src/verify/verification-engine.ts";
import {
  currentVerdictPasses,
  currentVerificationResults,
  verificationHistory,
} from "../../src/verify/verification-history.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { dispatchBootstrapRun, makeHarness } from "../helpers/harness.ts";
import { laterObjectsIn, releasedChainImage } from "../helpers/released-chain-image.ts";
import { privateStatePath, schemaRowsOf, userVersionOf } from "../helpers/released-v44-schema.ts";
import { contentDigests } from "../helpers/released-v45-schema.ts";

afterEach(cleanupTempDirs);

const contract = {
  goal: "verification history",
  why: "#1258",
  scope: [],
  nonGoals: [],
  acceptance: ["every execution is kept"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};

/**
 * A projectless §17.5 run whose one command passes only while a file outside the candidate exists: the
 * environment decides, as the sandbox exit did in #1258, and the candidate never changes.
 */
const environmentDependentCandidate = async () => {
  const harness = makeHarness();
  const created = harness.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: ExecutionMode.SIMPLE, contract });
  if (!created.allowed) throw new Error(created.message);
  const repository = await harness.cp.repositories.registerTemporary(harness.repoPath, created.value.runId);
  if (!repository.allowed) throw new Error(repository.message);
  const dispatched = await dispatchBootstrapRun(harness.cp, harness.clock, created.value.runId);
  const attached = harness.cp.runs.attachRepository(created.value.runId, {
    repositoryId: repository.value.repositoryId,
    repositoryRole: "primary",
    baseBranch: "dev",
    ownerSessionId: dispatched.ownerSessionId!,
    ownerBindingGeneration: dispatched.ownerBindingGeneration!,
  });
  if (!attached.allowed) throw new Error(attached.message);
  const frozen = await harness.cp.pipeline.freeze(created.value.runId);
  if (!frozen.allowed) throw new Error(frozen.message);

  const environment = join(tempDir("acp-1258-environment-"), "ready");
  const command = parseVerificationCommand({
    id: "environment-suite",
    argv: ["node", "-e", `process.exit(require("node:fs").existsSync(${JSON.stringify(environment)}) ? 0 : 1)`],
    timeoutSeconds: 20,
  });
  const snapshot = frozen.value;
  const verify = () => harness.cp.verification.verify({
    runId: dispatched.runId,
    snapshot,
    commands: [command],
    contractDigest: snapshot.contractDigest,
    runScoped: true,
  });
  return {
    harness,
    runId: dispatched.runId,
    digest: candidateSnapshotDigest(snapshot),
    verify,
    environmentReady: () => writeFileSync(environment, ""),
    environmentBroken: () => rmSync(environment, { force: true }),
  };
};

type Fixture = Awaited<ReturnType<typeof environmentDependentCandidate>>;

/** The table's rows for the candidate in the order they were written; no v53 column is named. */
const writtenRows = (fixture: Fixture) =>
  fixture.harness.cp.db.all<{
    command_id: string; status: string; exit_code: number | null; reason_code: string | null;
    output_digest: string; started_at: string; ended_at: string;
  }>(
    `SELECT command_id, status, exit_code, reason_code, output_digest, started_at, ended_at
       FROM verification_results WHERE run_id = ? AND candidate_snapshot_digest = ? ORDER BY rowid`,
    [fixture.runId, fixture.digest],
  );

/** What the engine said about each execution, in its report artifacts and audit rows. */
const reportsAndAudits = (fixture: Fixture) => ({
  reports: fixture.harness.cp.artifacts
    .list<VerificationReport>(fixture.runId, ArtifactKind.VERIFICATION)
    .filter((artifact) => artifact.candidateSnapshotDigest === fixture.digest)
    .map((artifact) => artifact.content.status),
  audits: fixture.harness.cp.audit
    .forRun(fixture.runId)
    .filter((entry) => entry.kind === "VERIFICATION_COMPLETED")
    .map((entry) => entry.evidence["status"]),
});

describe("#1258 a re-verification of the same candidate keeps every execution", () => {
  it("FAIL then PASS: both executions stay readable, and the later PASS is the current verdict", async () => {
    const fixture = await environmentDependentCandidate();
    fixture.environmentBroken();
    expect(await fixture.verify()).toMatchObject({ allowed: false, reasonCode: ReasonCode.VERIFICATION_COMMAND_FAILED });
    fixture.environmentReady();
    const passed = await fixture.verify();
    expect(passed.allowed).toBe(true);

    const rows = writtenRows(fixture);
    expect(rows.map((row) => [row.command_id, row.status, row.exit_code])).toEqual([
      ["environment-suite", "FAIL", 1],
      ["environment-suite", "PASS", 0],
    ]);
    for (const row of rows) {
      expect(row.output_digest).toMatch(/^sha256:/);
      expect(row.started_at <= row.ended_at).toBe(true);
    }
    expect(rows[1]!.reason_code).toBeNull();

    expect(verificationHistory(fixture.harness.cp.db, fixture.runId, fixture.digest).map((row) => [row.attempt, row.status]))
      .toEqual([[1, "FAIL"], [2, "PASS"]]);
    const current = currentVerificationResults(fixture.harness.cp.db, fixture.runId, fixture.digest);
    expect(current.map((row) => [row.command_id, row.attempt, row.status])).toEqual([["environment-suite", 2, "PASS"]]);
    expect(current.every(currentVerdictPasses)).toBe(true);

    // The FAIL's report artifact and audit row are still there, beside the PASS, and still say FAIL.
    expect(reportsAndAudits(fixture)).toEqual({ reports: ["FAIL", "PASS"], audits: ["FAIL", "PASS"] });
  });

  it("PASS then FAIL: both executions stay readable, and the later FAIL is the current verdict", async () => {
    const fixture = await environmentDependentCandidate();
    fixture.environmentReady();
    expect((await fixture.verify()).allowed).toBe(true);
    fixture.environmentBroken();
    expect(await fixture.verify()).toMatchObject({ allowed: false, reasonCode: ReasonCode.VERIFICATION_COMMAND_FAILED });

    expect(writtenRows(fixture).map((row) => [row.status, row.exit_code])).toEqual([["PASS", 0], ["FAIL", 1]]);
    expect(verificationHistory(fixture.harness.cp.db, fixture.runId, fixture.digest).map((row) => [row.attempt, row.status]))
      .toEqual([[1, "PASS"], [2, "FAIL"]]);
    const current = currentVerificationResults(fixture.harness.cp.db, fixture.runId, fixture.digest);
    expect(current.map((row) => [row.attempt, row.status])).toEqual([[2, "FAIL"]]);
    expect(current.every(currentVerdictPasses)).toBe(false);
    expect(reportsAndAudits(fixture)).toEqual({ reports: ["PASS", "FAIL"], audits: ["PASS", "FAIL"] });
  });

  it("a later execution that is not a PASS fails closed: no earlier PASS is consulted behind it", () => {
    const harness = makeHarness();
    const created = harness.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: ExecutionMode.SIMPLE, contract });
    if (!created.allowed) throw new Error(created.message);
    const runId = created.value.runId;
    const insert = (command: string, attempt: number, status: string) =>
      harness.cp.db.run(
        `INSERT INTO verification_results
           (result_id, run_id, candidate_snapshot_digest, command_id, repository_identity, source, attempt,
            exact_head, started_at, ended_at, exit_code, output_digest, output_truncated, status, reason_code)
         VALUES (?, ?, 'sha256:candidate', ?, 'github:acme/fixture', 'local', ?, 'head', 't', 't', NULL, 'sha256:o', 0, ?, NULL)`,
        [`${command}:${attempt}`, runId, command, attempt, status],
      );
    insert("suite", 1, "PASS");
    insert("suite", 2, "ERROR");
    insert("lint", 1, "PASS");
    insert("lint", 2, "TIMEOUT");
    insert("lint", 3, "PASS");
    const current = currentVerificationResults(harness.cp.db, runId, "sha256:candidate");
    expect(current.map((row) => [row.command_id, row.attempt, row.status, currentVerdictPasses(row)])).toEqual([
      ["lint", 3, "PASS", true],
      ["suite", 2, "ERROR", false],
    ]);
    // One execution per attempt: a second row at an attempt the input already has is refused, not replaced.
    expect(() => insert("suite", 2, "PASS")).toThrow(/duplicate verification result/);
    expect(verificationHistory(harness.cp.db, runId, "sha256:candidate")).toHaveLength(5);
  });
});

/** The rows a v52 database holds: one per input, as v52's key allowed. */
const seedV52 = (path: string): void => {
  const raw = new Database(path);
  try {
    raw.exec(`INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
        VALUES ('run-v52', 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'ACTIVE', 'v52 rows', 'sha256:c', '2026-01-01T00:00:00.000Z');
      INSERT INTO verification_results (rowid, result_id, run_id, candidate_snapshot_digest, command_id, repository_identity,
          source, exact_head, started_at, ended_at, exit_code, output_digest, output_truncated, status, reason_code)
        VALUES
        (7, 'sha256:s:test:github:acme/a:local', 'run-v52', 'sha256:s', 'test', 'github:acme/a', 'local', 'h1',
          '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:02.000Z', 1, 'sha256:o1', 0, 'FAIL', 'VERIFICATION_COMMAND_FAILED'),
        (9, 'sha256:s:lint:github:acme/a:local', 'run-v52', 'sha256:s', 'lint', 'github:acme/a', 'local', 'h1',
          '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:04.000Z', 0, 'sha256:o2', 1, 'PASS', NULL),
        (12, 'sha256:s:test:github:acme/a:ci', 'run-v52', 'sha256:s', 'test', 'github:acme/a', 'ci', 'h1',
          '2026-01-01T00:00:05.000Z', '2026-01-01T00:00:05.000Z', NULL, 'sha256:o3', 0, 'ERROR', 'EVIDENCE_MISSING');`);
  } finally {
    raw.close();
  }
};

const V52_COLUMNS = "rowid, result_id, run_id, candidate_snapshot_digest, command_id, repository_identity, source, " +
  "exact_head, started_at, ended_at, exit_code, output_digest, output_truncated, status, reason_code";

describe("#1258 v53 migrates a v52 database's verification rows without losing one", () => {
  it("chains v53 after v52 and leaves v52's released checksum where it was", () => {
    expect(SCHEMA_VERSION).toBe(53);
    expect(MIGRATIONS.slice(-2).map((step) => [step.id, step.fromVersion, step.toVersion])).toEqual([
      ["v52-resident-project-provisioning", 51, 52],
      ["v53-verification-result-history", 52, 53],
    ]);
    // What a v52 database's receipt holds: schema.sql as v52 was released.
    expect(MIGRATIONS.find((step) => step.toVersion === 52)!.checksum())
      .toBe("sha256:0845cd390419398556f771eb137242c82a18fe138bc04d8eb09767a3a9bbbc56");
  });

  it("carries every v52 row with its rowid and every column, as its input's attempt 1, and touches no other table", () => {
    const path = releasedChainImage(privateStatePath("acp-v53-from-v52-"), 52);
    expect(laterObjectsIn(path, 52)).toEqual([]);
    seedV52(path);
    const before = contentDigests(path, 52);
    const rowsBefore = (() => {
      const raw = new Database(path, { readonly: true });
      try { return raw.prepare(`SELECT ${V52_COLUMNS} FROM verification_results ORDER BY rowid`).all(); } finally { raw.close(); }
    })();
    expect(rowsBefore).toHaveLength(3);

    approveMigration(path, "v52 → v53 verification history witness");
    new Db(path).close();

    expect(userVersionOf(path)).toBe(53);
    // Every table, verification_results included, holds exactly what it held at v52 (the attempt column aside).
    const after = contentDigests(path, 52);
    const { schema_migrations: receiptsBefore, ...restBefore } = before.tables;
    const { schema_migrations: receiptsAfter, ...restAfter } = after.tables;
    expect(restAfter).toEqual(restBefore);
    expect(receiptsAfter).not.toBe(receiptsBefore);

    const raw = new Database(path, { readonly: true });
    try {
      expect(raw.prepare(`SELECT ${V52_COLUMNS} FROM verification_results ORDER BY rowid`).all()).toEqual(rowsBefore);
      expect(raw.prepare("SELECT rowid, attempt FROM verification_results ORDER BY rowid").raw(true).all())
        .toEqual([[7, 1], [9, 1], [12, 1]]);
      expect(raw.prepare("SELECT version, migration_id, checksum FROM schema_migrations WHERE version >= 52 ORDER BY version").all())
        .toEqual([
          { version: 52, migration_id: "v52-resident-project-provisioning", checksum: MIGRATIONS.find((step) => step.toVersion === 52)!.checksum() },
          { version: 53, migration_id: "v53-verification-result-history", checksum: MIGRATIONS.find((step) => step.toVersion === 53)!.checksum() },
        ]);
      expect(raw.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%_v53_prior'").all()).toEqual([]);
    } finally {
      raw.close();
    }

    // The upgraded table is a fresh v53 table: same definition and automatic indexes.
    const freshPath = join(tempDir("acp-v53-fresh-"), "state.sqlite");
    new Db(freshPath).close();
    const on = (path: string) => schemaRowsOf(path).filter((row) => row.tbl_name === "verification_results");
    expect(on(path)).toEqual(on(freshPath));

    // A migrated FAIL keeps its place in the history: the next execution of that input is attempt 2.
    const db = new Db(path);
    try {
      db.run(
        `INSERT INTO verification_results
           (result_id, run_id, candidate_snapshot_digest, command_id, repository_identity, source, attempt,
            exact_head, started_at, ended_at, exit_code, output_digest, output_truncated, status, reason_code)
         VALUES ('sha256:s:test:github:acme/a:local:2', 'run-v52', 'sha256:s', 'test', 'github:acme/a', 'local', 2,
            'h1', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:01.000Z', 0, 'sha256:o4', 0, 'PASS', NULL)`,
      );
      expect(verificationHistory(db, "run-v52", "sha256:s").map((row) => [row.command_id, row.source, row.attempt, row.status]))
        .toEqual([
          ["lint", "local", 1, "PASS"],
          ["test", "ci", 1, "ERROR"],
          ["test", "local", 1, "FAIL"],
          ["test", "local", 2, "PASS"],
        ]);
      expect(currentVerificationResults(db, "run-v52", "sha256:s").map((row) => [row.command_id, row.source, row.attempt, row.status]))
        .toEqual([
          ["lint", "local", 1, "PASS"],
          ["test", "ci", 1, "ERROR"],
          ["test", "local", 2, "PASS"],
        ]);
    } finally {
      db.close();
    }
  });
});
