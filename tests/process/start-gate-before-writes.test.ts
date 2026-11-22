import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { Db } from "../../src/db/database.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

/**
 * A start the doctor will refuse must refuse before it writes (migrate-before-start).
 *
 * An isolated rehearsal showed a start that applied an approved migration, then wrote audit events,
 * capacity snapshots, telemetry, an outbox notice and every repository's `last_observed_at`, and only
 * then refused with DOCTOR_BLOCKED. The official rollback to the pair sealed before the migration then
 * refused ROLLBACK_PAIR_STALE_DATABASE, because the database had moved for a start that never served.
 *
 * What is judged before the first write is every blocking finding whose answer no start write can
 * change: state-path security, the trusted gate's credential, and the repository and worktree probes
 * (read-only git). Everything else is judged where it always was, because it reads rows the start's own
 * reconcile settles.
 */
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/u, "");
const agentcpd = join(repositoryRoot, "src/daemon/agentcpd.ts");

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  cleanupTempDirs();
});

const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Every row of every table, in rowid order: the database's content, not its page layout. */
const contentDigest = (path: string): string => {
  const raw = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const hash = createHash("sha256");
    const tables = raw
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as Array<{ name: string }>;
    for (const { name } of tables) {
      hash.update(`table ${name}\n`);
      for (const row of raw.prepare(`SELECT * FROM "${name}"`).iterate()) hash.update(`${JSON.stringify(row)}\n`);
    }
    hash.update(`user_version ${String(raw.pragma("user_version", { simple: true }))}`);
    return hash.digest("hex");
  } finally {
    raw.close();
  }
};

const countOf = (path: string, sql: string): number => {
  const raw = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return (raw.prepare(sql).get() as { n: number }).n;
  } finally {
    raw.close();
  }
};

describe("a start the doctor will refuse writes nothing (migrate-before-start)", () => {
  it("(b) the production entry point, refused for a missing gate credential, leaves the database untouched and exits non-zero", () => {
    const home = mkdtempSync(join(tmpdir(), "acp-gate-before-writes-"));
    homes.push(home);
    const root = join(home, ".agent-control-plane");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    const database = join(root, "state.sqlite");
    new Db(database).close();
    const before = { main: sha(database), content: contentDigest(database), audit: countOf(database, "SELECT COUNT(*) AS n FROM audit_events") };

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USER: "startup-owner",
      ACP_MCP_TOKEN: "startup-mcp-token",
      ACP_OPERATOR_TOKEN: "startup-operator-token",
      ACP_OPERATOR_ACTOR: "startup-owner",
    };
    delete env["ACP_DAEMON_SUPERVISOR"];
    const result = spawnSync(process.execPath, ["--import", "tsx", agentcpd], {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
      timeout: 90_000,
    });

    expect(result.status).toBe(1);
    // The refusal is reported on stderr, naming the code and the finding.
    expect(result.stderr).toContain(ReasonCode.DOCTOR_BLOCKED);
    expect(result.stderr).toContain("TRUSTED_GATE_CREDENTIAL_MISSING");
    // The database is the same bytes, the same content, with no audit row added and no log left behind
    // (checked first: reading it below opens it, which can create a shared-memory index).
    expect(existsSync(`${database}-wal`) ? readFileSync(`${database}-wal`).length : 0).toBe(0);
    expect(sha(database)).toBe(before.main);
    expect(contentDigest(database)).toBe(before.content);
    expect(countOf(database, "SELECT COUNT(*) AS n FROM audit_events")).toBe(before.audit);
    // And the refusal is still on record, outside the database, in the crash-loop file.
    const crashLoop = JSON.parse(readFileSync(join(root, "crash-loop.json"), "utf8")) as {
      failures: number;
      retryNotBefore?: string;
      lastRefusal?: { reasonCode: string; blockingFindings: Array<{ code: string }>; databaseWritten: boolean };
    };
    expect(crashLoop.failures).toBe(1);
    expect(crashLoop.retryNotBefore).toBeTruthy();
    expect(crashLoop.lastRefusal).toMatchObject({ reasonCode: ReasonCode.DOCTOR_BLOCKED, databaseWritten: false });
    expect(crashLoop.lastRefusal?.blockingFindings.map((finding) => finding.code)).toContain(
      "TRUSTED_GATE_CREDENTIAL_MISSING",
    );
  }, 120_000);

  it("(b) in process: the refused start runs no post-gate step and the content digest does not move", async () => {
    const harness = makeHarness();
    // No credential installed: the trusted gate's finding blocks.
    const stateDir = tempDir("acp-gate-before-writes-state-");
    const database = join(harness.root, "state.sqlite");
    let afterGateRuns = 0;
    const daemon = new Daemon(harness.cp, { stateDir });
    const before = contentDigest(database);
    const auditBefore = countOf(database, "SELECT COUNT(*) AS n FROM audit_events");

    const started = await daemon.start({ afterGate: () => { afterGateRuns += 1; } });

    expect(started.allowed).toBe(false);
    if (started.allowed) return;
    expect(started.reasonCode).toBe(ReasonCode.DOCTOR_BLOCKED);
    expect(afterGateRuns).toBe(0);
    expect(contentDigest(database)).toBe(before);
    expect(countOf(database, "SELECT COUNT(*) AS n FROM audit_events")).toBe(auditBefore);
    expect(countOf(database, "SELECT COUNT(*) AS n FROM outbox")).toBe(0);
    expect(countOf(database, "SELECT COUNT(*) AS n FROM capacity_snapshots")).toBe(0);
    // The lock was given back, so the next attempt is not told a daemon runs.
    expect(daemon.lock.held()).toBe(false);
    expect(daemon.crashLoopState().failures).toBe(1);
  });

  it("(c) a normal start still writes its usual rows, after the gate and in the same order", async () => {
    const harness = makeHarness();
    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    const stateDir = tempDir("acp-gate-before-writes-state-");
    const database = join(harness.root, "state.sqlite");
    const daemon = new Daemon(harness.cp, { stateDir });
    const before = contentDigest(database);
    const auditBefore = countOf(database, "SELECT COUNT(*) AS n FROM audit_events");
    let auditAtGate: number | null = null;
    let contentAtGate: string | null = null;

    const started = await daemon.start({
      afterGate: () => {
        auditAtGate = countOf(database, "SELECT COUNT(*) AS n FROM audit_events");
        contentAtGate = contentDigest(database);
        // A write the production hook makes (the runtime observation) lands here, after the gate.
        harness.cp.audit.record({ kind: "DAEMON_RUNTIME_OBSERVED", evidence: { gate: "passed" } });
      },
    });

    expect(started.allowed).toBe(true);
    // The hook ran once the gate had passed and nothing had been written yet.
    expect(auditAtGate).toBe(auditBefore);
    expect(contentAtGate).toBe(before);
    const kinds = new Set(
      (new Database(database, { readonly: true }).prepare("SELECT DISTINCT kind FROM audit_events").all() as Array<{ kind: string }>)
        .map((row) => row.kind),
    );
    for (const kind of [
      "DAEMON_RUNTIME_OBSERVED",
      "CEO_NOTIFICATION_ATTEMPT_JOURNAL_STARTED",
      "DOCTOR_REPORT",
      "DAEMON_STARTED",
    ]) {
      expect(kinds, kind).toContain(kind);
    }
    expect(contentDigest(database)).not.toBe(before);
    expect(daemon.crashLoopState().failures).toBe(0);
    await daemon.stop();
  });
});
