import Database from "better-sqlite3";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import type { StartGateConfig } from "../../src/daemon/start-gate.ts";
import { Db } from "../../src/db/database.ts";
import { approveMigration, migrationApprovalPath } from "../../src/db/migration-approval.ts";
import { cleanupTempDirs, gitSync, makeRepo, tempDir } from "../helpers/fixtures.ts";
import { installGitHubAppCredential } from "../helpers/github-app-credential.ts";
import { makeHarness } from "../helpers/harness.ts";

/**
 * A start the doctor will refuse refuses before it opens the database (migrate-before-start).
 *
 * An isolated rehearsal showed a start that applied an approved migration, then wrote audit events,
 * capacity snapshots, telemetry, an outbox notice and every repository's `last_observed_at`, and only
 * then refused with DOCTOR_BLOCKED. The official rollback to the pair sealed before the migration then
 * refused ROLLBACK_PAIR_STALE_DATABASE, because the database had moved for a start that never served.
 *
 * Review round 1 found that the first answer still opened the database first: a refused start created
 * state.sqlite, switched a rollback-journal file to WAL, applied the approved migration and spent its
 * approval, and a 0755 worktree directory exited without a crash-loop record. So the gate now runs
 * before `ControlPlane` exists. Every row below runs the production entry point against a state
 * directory under a disposable `HOME`, with no GitHub credential, and shows the database untouched by its
 * file digest and by which sidecars exist.
 */
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/u, "");
const agentcpd = join(repositoryRoot, "src/daemon/agentcpd.ts");

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  cleanupTempDirs();
});

const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The database as a file: its bytes, and which of its sidecars exist. Nothing here opens it. */
const imageOf = (path: string) => ({
  exists: existsSync(path),
  main: existsSync(path) ? sha(path) : null,
  wal: existsSync(`${path}-wal`),
  shm: existsSync(`${path}-shm`),
  journal: existsSync(`${path}-journal`),
  header: existsSync(path) ? readFileSync(path).subarray(18, 20).toString("hex") : null,
});

/** `base` is short where the daemon will listen on sockets under it: a unix socket path is capped near 104 bytes. */
const newHome = (base = tmpdir()): { home: string; root: string; database: string } => {
  const home = mkdtempSync(join(base, "acp-gate-before-open-"));
  homes.push(home);
  const root = join(home, ".agent-control-plane");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return { home, root, database: join(root, "state.sqlite") };
};

/** A current-schema database at rest, as a stopped daemon leaves it. */
const currentDatabase = (database: string, journalMode: "WAL" | "DELETE" = "WAL"): void => {
  new Db(database).close();
  if (journalMode === "DELETE") {
    const raw = new Database(database);
    raw.pragma("journal_mode = DELETE");
    raw.close();
  }
};

interface Run {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<{ status: number | null; signal: NodeJS.Signals | null }>;
  waitFor: (text: string, ms?: number) => Promise<void>;
}

const startDaemon = (home: string, env: NodeJS.ProcessEnv = {}): Run => {
  const merged: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USER: "startup-owner",
    ACP_MCP_TOKEN: "startup-mcp-token",
    ACP_OPERATOR_TOKEN: "startup-operator-token",
    ACP_OPERATOR_ACTOR: "startup-owner",
    ...env,
  };
  delete merged["ACP_DAEMON_SUPERVISOR"];
  const child = spawn(process.execPath, ["--import", "tsx", agentcpd], {
    cwd: repositoryRoot,
    env: merged,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout!.on("data", (chunk: Buffer) => (out += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (err += chunk.toString()));
  const exited = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("exit", (status, signal) => resolveExit({ status, signal }));
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  void exited.then(() => clearTimeout(timer));
  const waitFor = async (text: string, ms = 90_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!(out + err).includes(text)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${JSON.stringify(text)}; stderr: ${err.slice(-600)}`);
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
    }
  };
  return { child, stdout: () => out, stderr: () => err, exited, waitFor };
};

/** Runs a start to its exit. A refused start waits out its backoff first, which is a couple of seconds. */
const runToExit = async (home: string, env: NodeJS.ProcessEnv = {}) => {
  const run = startDaemon(home, env);
  const exit = await run.exited;
  return { ...exit, stdout: run.stdout(), stderr: run.stderr() };
};

interface CrashLoop {
  failures: number;
  retryNotBefore?: string;
  lastRefusal?: {
    reasonCode: string;
    stage: string;
    databaseWritten: boolean;
    blockingFindings: Array<{ code: string }>;
  };
}
const crashLoopOf = (root: string): CrashLoop => JSON.parse(readFileSync(join(root, "crash-loop.json"), "utf8")) as CrashLoop;

const countOf = (path: string, sql: string): number => {
  const raw = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return (raw.prepare(sql).get() as { n: number }).n;
  } finally {
    raw.close();
  }
};

const V25_LINEAGE = readFileSync(new URL("../fixtures/schema-v25-lineage.sql", import.meta.url), "utf8");
const seedV25Database = (path: string): void => {
  const raw = new Database(path);
  try {
    raw.function("acp_schema_migration_authorized", () => 1);
    raw.exec(V25_LINEAGE);
    for (const [version, id] of [
      [20, "bootstrap-v20"],
      [21, "v21-canonical-turns"],
      [22, "v22-canonical-turn-ledger"],
      [23, "v23-turn-claimed-at"],
      [24, "v24-observation-ledger"],
      [25, "v25-sources-name-admitted-messages"],
    ] as const) {
      raw
        .prepare("INSERT INTO schema_migrations (version, migration_id, checksum, applied_at) VALUES (?, ?, ?, ?)")
        .run(version, id, `sha256:${"b".repeat(64)}`, "2026-08-23T02:39:31.318Z");
    }
    raw.pragma("user_version = 25");
  } finally {
    raw.close();
    chmodSync(path, 0o600);
  }
};

const registerCheckout = (database: string, checkoutPath: string): void => {
  const raw = new Database(database);
  try {
    raw
      .prepare(
        `INSERT INTO repositories (repository_id, identity, checkout_path, created_at)
         VALUES ('repo_gate', 'example/gate', ?, '2026-11-22T00:00:00.000Z')`,
      )
      .run(checkoutPath);
  } finally {
    raw.close();
  }
};

/** What a refused start leaves behind, in every row that follows. */
const expectRefusedUntouched = (
  result: { status: number | null; stderr: string },
  database: string,
  before: ReturnType<typeof imageOf>,
  code: string,
): void => {
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(code);
  expect(imageOf(database)).toEqual(before);
};

describe("a start the doctor will refuse leaves the database as it found it (migrate-before-start)", () => {
  it("item 1: a first start with no credential creates no database, and still records its refusal", async () => {
    const { home, root, database } = newHome();
    expect(existsSync(database)).toBe(false);

    const result = await runToExit(home);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(ReasonCode.DOCTOR_BLOCKED);
    expect(result.stderr).toContain("TRUSTED_GATE_CREDENTIAL_MISSING");
    expect(imageOf(database)).toMatchObject({ exists: false, wal: false, shm: false, journal: false });
    const loop = crashLoopOf(root);
    expect(loop.failures).toBe(1);
    expect(loop.lastRefusal).toMatchObject({ reasonCode: ReasonCode.DOCTOR_BLOCKED, stage: "before-open", databaseWritten: false });
    expect(loop.lastRefusal?.blockingFindings.map((finding) => finding.code)).toContain("TRUSTED_GATE_CREDENTIAL_MISSING");
  }, 120_000);

  it("item 1: a rollback-journal database stays a rollback-journal database", async () => {
    const { home, database } = newHome();
    currentDatabase(database, "DELETE");
    const before = imageOf(database);
    expect(before.header).toBe("0101");

    const result = await runToExit(home);

    expectRefusedUntouched(result, database, before, "TRUSTED_GATE_CREDENTIAL_MISSING");
    expect(imageOf(database).header).toBe("0101");
  }, 120_000);

  it("item 1: an approved migration is neither applied nor its approval spent by a refused start", async () => {
    const { home, root, database } = newHome();
    seedV25Database(database);
    const approval = approveMigration(database, "gate-before-open");
    const before = imageOf(database);
    expect(readFileSync(database).readUInt32BE(60)).toBe(25);

    const result = await runToExit(home);

    expectRefusedUntouched(result, database, before, "TRUSTED_GATE_CREDENTIAL_MISSING");
    expect(readFileSync(database).readUInt32BE(60)).toBe(25);
    // The approval is still the approval, spendable by the migration the owner chose to run.
    expect(existsSync(migrationApprovalPath(database))).toBe(true);
    expect(JSON.parse(readFileSync(migrationApprovalPath(database), "utf8")) as { approvedBy: string }).toMatchObject({
      approvedBy: approval.approvedBy,
    });
    expect(crashLoopOf(root).lastRefusal?.databaseWritten).toBe(false);
  }, 120_000);

  it("item 1: an insecure worktree directory is refused and recorded, and creates no database", async () => {
    const { home, root, database } = newHome();
    mkdirSync(join(root, "worktrees"), { mode: 0o755 });
    chmodSync(join(root, "worktrees"), 0o755);

    const result = await runToExit(home);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("STATE_PATH_INSECURE");
    expect(imageOf(database)).toMatchObject({ exists: false, wal: false, shm: false });
    const loop = crashLoopOf(root);
    expect(loop.lastRefusal?.databaseWritten).toBe(false);
    expect(loop.lastRefusal?.blockingFindings.map((finding) => finding.code)).toContain("STATE_PATH_INSECURE");
  }, 120_000);

  it("item 2: a malformed reviewer-preferences file is not refused into the audit log by a refused start", async () => {
    const { home, root, database } = newHome();
    currentDatabase(database);
    writeFileSync(join(root, "reviewer-preferences.json"), "{ this is not json", { mode: 0o600 });
    const before = imageOf(database);

    const result = await runToExit(home);

    expectRefusedUntouched(result, database, before, "TRUSTED_GATE_CREDENTIAL_MISSING");
  }, 120_000);

  it("item 2: a SIGTERM during the refusal's backoff writes nothing", async () => {
    const { home, database } = newHome();
    currentDatabase(database);
    const before = imageOf(database);

    const run = startDaemon(home);
    await run.waitFor("backoff:");
    run.child.kill("SIGTERM");
    const exit = await run.exited;

    expect(exit.status === 1 || exit.signal === "SIGTERM").toBe(true);
    expect(imageOf(database)).toEqual(before);
  }, 120_000);

  it("item 2: a retry inside the refusal's backoff is refused from crash-loop.json and writes nothing", async () => {
    const { home, root, database } = newHome();
    currentDatabase(database);
    const first = await runToExit(home);
    expect(first.status).toBe(1);
    // Hold the first refusal's record, with a backoff far longer than the retry takes to arrive.
    const held = crashLoopOf(root);
    writeFileSync(
      join(root, "crash-loop.json"),
      JSON.stringify({ ...held, failures: 5, firstAt: new Date().toISOString(), retryNotBefore: new Date(Date.now() + 600_000).toISOString() }),
      { mode: 0o600 },
    );
    const before = imageOf(database);

    const retry = startDaemon(home);
    await retry.waitFor("backoff:");
    retry.child.kill("SIGTERM");
    await retry.exited;

    expect(retry.stderr()).toContain(ReasonCode.DAEMON_BACKOFF_ACTIVE);
    expect(imageOf(database)).toEqual(before);
    // The retry is not another failure: the count the supervisor reads is the one the refusal wrote.
    expect(crashLoopOf(root).failures).toBe(5);
  }, 180_000);

  it("item 3: the repository probe leaves the checkout's index as it found it", async () => {
    const { home, database } = newHome();
    currentDatabase(database);
    const repo = makeRepo({ "README.md": "# gate\n", "src/app.js": "module.exports = 1;\n" });
    gitSync(repo, ["status", "--porcelain"]);
    registerCheckout(database, repo);
    // A tracked file whose stat changed and whose content did not: what `git status` rewrites the index for.
    const touched = join(repo, "README.md");
    const later = new Date(Date.now() + 5_000);
    utimesSync(touched, later, later);
    const index = join(repo, ".git", "index");
    const indexBefore = sha(index);
    const before = imageOf(database);

    const result = await runToExit(home);

    expectRefusedUntouched(result, database, before, "TRUSTED_GATE_CREDENTIAL_MISSING");
    expect(sha(index)).toBe(indexBefore);
  }, 120_000);

  it("a normal start still writes its usual rows, and a normal stop still records itself", async () => {
    const { home, root, database } = newHome("/tmp");
    installGitHubAppCredential(root);

    const run = startDaemon(home);
    try {
      // The database now exists; its first writes are the runtime observation and the doctor's report.
      const deadline = Date.now() + 90_000;
      let kinds = new Set<string>();
      while (Date.now() < deadline) {
        if (existsSync(database)) {
          try {
            const raw = new Database(database, { readonly: true });
            kinds = new Set((raw.prepare("SELECT DISTINCT kind FROM audit_events").all() as Array<{ kind: string }>).map((row) => row.kind));
            raw.close();
          } catch {
            // A table not yet created, or the file mid-write: try again.
          }
        }
        if (kinds.has("DAEMON_RUNTIME_OBSERVED") && kinds.has("DOCTOR_REPORT")) break;
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 250));
      }
      expect(kinds).toContain("DAEMON_RUNTIME_OBSERVED");
      expect(kinds).toContain("DOCTOR_REPORT");
      expect(run.stderr()).not.toContain("before it opened the database");
    } finally {
      run.child.kill("SIGTERM");
    }
    const exit = await run.exited;
    expect(exit.status).toBe(0);
    expect(countOf(database, "SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'DAEMON_STOPPED'")).toBe(1);
  }, 180_000);
});

describe("the gate before the database is opened (judgeStartBeforeOpening)", () => {
  const gateConfig = (root: string, database: string): StartGateConfig => ({
    databasePath: database,
    worktreeRoot: join(root, "worktrees"),
    secretsDir: join(root, "secrets"),
    capacityDir: join(root, "capacity"),
    githubAppEnvFile: join(root, "credentials", "github-app.env"),
  });

  it("finds a registered checkout that is gone, without opening the database", async () => {
    const { root, database } = newHome();
    currentDatabase(database);
    registerCheckout(database, join(root, "no-such-checkout"));
    const before = imageOf(database);

    const { judgeStartBeforeOpening } = await import("../../src/daemon/start-gate.ts");
    const judged = await judgeStartBeforeOpening(gateConfig(root, database));

    expect(judged.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["TRUSTED_GATE_CREDENTIAL_MISSING", "REPOSITORY_UNREADABLE", "WORKTREE_PROBE_FAILED"]),
    );
    expect(judged.status).toBe("BLOCKED");
    expect(imageOf(database)).toEqual(before);
  });

  it("does not read the checkouts from a database whose write-ahead log holds more than its file does", async () => {
    const { root, database } = newHome();
    currentDatabase(database);
    const writer = new Database(database);
    writer.pragma("wal_autocheckpoint = 0");
    writer
      .prepare(
        `INSERT INTO repositories (repository_id, identity, checkout_path, created_at)
         VALUES ('repo_wal', 'example/wal', ?, '2026-11-22T00:00:00.000Z')`,
      )
      .run(join(root, "no-such-checkout"));
    try {
      expect(statSync(`${database}-wal`).size).toBeGreaterThan(0);
      const { judgeStartBeforeOpening } = await import("../../src/daemon/start-gate.ts");
      const judged = await judgeStartBeforeOpening(gateConfig(root, database));
      expect(judged.notJudged.join(" ")).toContain("-wal");
      expect(judged.findings.map((finding) => finding.code)).not.toContain("REPOSITORY_UNREADABLE");
    } finally {
      writer.close();
    }
  });

  it("lets a start with a readable credential and sound paths go on, writing nothing", async () => {
    const { root, database } = newHome();
    currentDatabase(database);
    installGitHubAppCredential(root);
    const before = imageOf(database);

    const { refuseStartBeforeOpening } = await import("../../src/daemon/start-gate.ts");
    expect(await refuseStartBeforeOpening(gateConfig(root, database))).toBeNull();
    expect(imageOf(database)).toEqual(before);
    expect(existsSync(join(dirname(database), "crash-loop.json"))).toBe(false);
  });
});

describe("a start the daemon itself starts still writes as it did", () => {
  it("(c) a normal in-process start records its journal boundary, report and start", async () => {
    const harness = makeHarness();
    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    const database = join(harness.root, "state.sqlite");
    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-gate-before-open-state-") });

    const started = await daemon.start();

    expect(started.allowed).toBe(true);
    const kinds = new Set(
      (new Database(database, { readonly: true }).prepare("SELECT DISTINCT kind FROM audit_events").all() as Array<{ kind: string }>)
        .map((row) => row.kind),
    );
    for (const kind of ["CEO_NOTIFICATION_ATTEMPT_JOURNAL_STARTED", "DOCTOR_REPORT", "DAEMON_STARTED"]) {
      expect(kinds, kind).toContain(kind);
    }
    expect(daemon.crashLoopState().failures).toBe(0);
    await daemon.stop();
  });
});
