import Database from "better-sqlite3";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import type { StartGateConfig } from "../../src/daemon/start-gate.ts";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { Db } from "../../src/db/database.ts";
import { approveMigration, migrationApprovalPath } from "../../src/db/migration-approval.ts";
import { cleanupTempDirs, gitSync, makeRepo, tempDir } from "../helpers/fixtures.ts";
import { DIGEST, LIVE, adoptedFixture } from "../helpers/adopted-ceo.ts";
import { installGitHubAppCredential } from "../helpers/github-app-credential.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
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
  walBytes: existsSync(`${path}-wal`) ? sha(`${path}-wal`) : null,
  shm: existsSync(`${path}-shm`),
  journal: existsSync(`${path}-journal`),
  journalBytes: existsSync(`${path}-journal`) ? sha(`${path}-journal`) : null,
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

  it("#1496: a refused start tells the CEO through the Hermes Gateway, outside the database, and a backoff retry does not resend", async () => {
    const { home, root, database } = newHome();
    // The CEO the daemon's database names is the Hermes Gateway running as this test's own process.
    adoptedFixture({ root, livePid: process.pid }).h.cp.close();
    const lineage = DIGEST;
    const identity = { session_id: LIVE, lineage_root_digest: lineage, process_pid: process.pid,
      process_started_at: readProcessStartToken(process.pid)! };
    const posts: Array<{ path: string; auth: string | undefined; body: Record<string, unknown> }> = [];
    const gateway = createServer((req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET") return void res.end(JSON.stringify(identity));
      // The daemon-notice route is POST-only: the daemon's probe is a HEAD, answered 405 with Allow: POST.
      if (req.method === "HEAD") { res.statusCode = req.url === "/v1/canonical-surface/daemon-notices" ? 405 : 404; res.setHeader("Allow", "POST"); return void res.end(); }
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
      req.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        posts.push({ path: req.url ?? "", auth: req.headers.authorization, body });
        res.end(JSON.stringify({
          event_id: body["event_id"], payload_digest: body["payload_digest"],
          receipt: { receipt_id: "rcpt-1", status: "completed", session_id: identity.session_id, lineage_root_digest: lineage },
        }));
      });
    });
    await new Promise<void>((resolveListen) => gateway.listen(0, "127.0.0.1", resolveListen));
    const port = (gateway.address() as AddressInfo).port;
    const env = {
      ACP_DAEMON_NOTICE_ENABLED: "1",
      ACP_TELEGRAM_EXTERNAL_SECRET: "process-lane-secret",
      ACP_HERMES_GATEWAY_ENDPOINT: `127.0.0.1:${port}`,
      ACP_HERMES_GATEWAY_API_KEY: "process-gateway-key",
      ACP_HERMES_LINEAGE_ROOT_DIGEST: lineage,
      ACP_HERMES_EXECUTABLE: "/opt/hermes/bin/hermes",
      ACP_HERMES_PROFILE: "ceo",
      ACP_HERMES_HOME: join(home, ".hermes"),
      ACP_HERMES_EXECUTOR_RUNTIME_IDENTITY: "hermes-runtime",
    };
    try {
      const before = imageOf(database);
      const first = await runToExit(home, env);

      expectRefusedUntouched(first, database, before, "TRUSTED_GATE_CREDENTIAL_MISSING");
      expect(posts).toHaveLength(1);
      expect(posts[0]!.auth).toBe("Bearer process-gateway-key");
      expect(posts[0]!.path).toBe("/v1/canonical-surface/daemon-notices");
      const loop = crashLoopOf(root) as CrashLoop & { lastRefusal: { refusalId: string; notice: { outcome: string; receiptId: string } } };
      expect(loop.lastRefusal.notice).toMatchObject({ outcome: "delivered", receiptId: "rcpt-1" });
      expect(posts[0]!.body["text"]).toContain(loop.lastRefusal.refusalId);
      expect(first.stderr).toContain(loop.lastRefusal.refusalId);

      // Hold the refusal's record inside its backoff: the retry reads it and sends nothing.
      writeFileSync(join(root, "crash-loop.json"), JSON.stringify({ ...loop, retryNotBefore: new Date(Date.now() + 600_000).toISOString() }), { mode: 0o600 });
      const retry = startDaemon(home, env);
      await retry.waitFor("backoff:");
      retry.child.kill("SIGTERM");
      await retry.exited;
      expect(retry.stderr()).toContain(ReasonCode.DAEMON_BACKOFF_ACTIVE);
      expect(posts).toHaveLength(1);
      expect(imageOf(database)).toEqual(before);
    } finally {
      await new Promise<void>((resolveClose) => gateway.close(() => resolveClose()));
    }
  }, 180_000);

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

  it("round 2 item 1: a crash-loop.json that is a link to the database is replaced, never written through", async () => {
    const { home, root, database } = newHome();
    currentDatabase(database);
    symlinkSync(database, join(root, "crash-loop.json"));
    const before = imageOf(database);

    const result = await runToExit(home);

    expectRefusedUntouched(result, database, before, "TRUSTED_GATE_CREDENTIAL_MISSING");
    // The record is a file of its own now, and says what happened; the database is the bytes it was.
    expect(lstatSync(join(root, "crash-loop.json")).isSymbolicLink()).toBe(false);
    expect(crashLoopOf(root).lastRefusal?.databaseWritten).toBe(false);
    expect(readFileSync(database).subarray(0, 16).toString("latin1")).toBe("SQLite format 3\0");
  }, 120_000);

  it("round 2 item 2: a registration that is only in the write-ahead log is judged from a private copy, and the originals are untouched", async () => {
    const { home, root, database } = newHome();
    currentDatabase(database);
    installGitHubAppCredential(root);
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
      const before = imageOf(database);

      const result = await runToExit(home);

      // Only the missing checkout can have refused it: the credential is installed.
      expectRefusedUntouched(result, database, before, "REPOSITORY_UNREADABLE");
      expect(crashLoopOf(root).lastRefusal?.blockingFindings.map((finding) => finding.code)).toContain("REPOSITORY_UNREADABLE");
    } finally {
      writer.close();
    }
  }, 120_000);

  it("round 2 item 3: a malformed checkout registration refuses the start before the database is opened", async () => {
    const { home, root, database } = newHome();
    currentDatabase(database);
    installGitHubAppCredential(root);
    const repo = makeRepo({ "docs.md": "# gate\n" });
    registerCheckout(database, repo);
    const registry = join(root, "worktrees", ".verification-checkouts");
    mkdirSync(registry, { recursive: true, mode: 0o700 });
    chmodSync(join(root, "worktrees"), 0o700);
    chmodSync(registry, 0o700);
    writeFileSync(join(registry, "broken.json"), "{ not a registration", { mode: 0o600 });
    const before = imageOf(database);

    const result = await runToExit(home);

    expectRefusedUntouched(result, database, before, "WORKTREE_PROBE_FAILED");
  }, 120_000);

  it("final review A: a SIGTERM while a gate git probe is paused gives the lock back and writes nothing", async () => {
    const { home, root, database } = newHome();
    currentDatabase(database);
    const repo = makeRepo({ "docs.md": "# gate\n" });
    registerCheckout(database, repo);
    // A `git` that says it started and then waits: the gate's first probe, held open.
    const bin = mkdtempSync(join(tmpdir(), "acp-gate-slow-git-"));
    homes.push(bin);
    const marker = join(bin, "started");
    writeFileSync(join(bin, "git"), `#!/bin/sh\necho started > "${marker}"\nexec sleep 8\n`, { mode: 0o755 });
    const before = imageOf(database);

    const run = startDaemon(home, { PATH: `${bin}:${process.env["PATH"] ?? ""}` });
    const deadline = Date.now() + 60_000;
    while (!existsSync(marker)) {
      if (Date.now() > deadline) throw new Error(`the gate never reached its git probe; stderr: ${run.stderr().slice(-400)}`);
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
    }
    // The probe is paused with the lock held: this is the window the signal lands in.
    expect(existsSync(join(root, "agentcpd.lock"))).toBe(true);
    run.child.kill("SIGTERM");
    const exit = await run.exited;

    expect(exit.status === 0 || exit.signal === "SIGTERM").toBe(true);
    // Nothing is left for the installer to wait on, and the database is the file it was.
    expect(existsSync(join(root, "agentcpd.lock"))).toBe(false);
    expect(imageOf(database)).toEqual(before);
  }, 120_000);

  it("final review: a SIGTERM during the snapshot copy of a large database leaves before the live database is opened", async () => {
    const { home, root, database } = newHome();
    currentDatabase(database, "DELETE");
    installGitHubAppCredential(root);
    // 512 MiB: the copy is the longest stretch before anything is opened. A valid credential and no
    // registered checkouts, so the gate passes and a start that went on would open the file.
    const raw = new Database(database);
    raw.exec("CREATE TABLE gate_padding (b BLOB)");
    for (let row = 0; row < 4; row += 1) raw.prepare("INSERT INTO gate_padding VALUES (zeroblob(?))").run(128 * 1024 * 1024);
    raw.close();
    expect(statSync(database).size).toBeGreaterThan(512 * 1024 * 1024);
    const auditBefore = countOf(database, "SELECT COUNT(*) AS n FROM audit_events");
    const before = imageOf(database);
    expect(before.header).toBe("0101");
    const scratch = mkdtempSync(join(tmpdir(), "acp-gate-scratch-"));
    homes.push(scratch);

    const run = startDaemon(home, { TMPDIR: scratch });
    // As soon as the copy exists, which is while it is still being made.
    const deadline = Date.now() + 90_000;
    const copying = (): boolean =>
      readdirSync(scratch).some((name) => existsSync(join(scratch, name, "snapshot.sqlite")));
    while (!copying()) {
      if (Date.now() > deadline) throw new Error(`no snapshot copy appeared; stderr: ${run.stderr().slice(-400)}`);
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 2));
    }
    run.child.kill("SIGTERM");
    const exit = await run.exited;

    expect(exit.status === 0 || exit.signal === "SIGTERM").toBe(true);
    // Nothing of the live database moved: not its bytes, not its journal mode, no sidecar, no audit row.
    expect(existsSync(join(root, "agentcpd.lock"))).toBe(false);
    expect(imageOf(database)).toEqual(before);
    expect(countOf(database, "SELECT COUNT(*) AS n FROM audit_events")).toBe(auditBefore);
    // And the copy it was making is gone.
    expect(readdirSync(scratch).filter((name) => name.startsWith("acp-db-snapshot-"))).toEqual([]);
  }, 180_000);

  it("structural (a): a SIGTERM raised the instant the lock is published leaves no holder.json and writes nothing", async () => {
    const { home, root, database } = newHome();
    currentDatabase(database);
    const scratch = mkdtempSync(join(tmpdir(), "acp-gate-scratch-"));
    homes.push(scratch);
    const before = imageOf(database);

    // The process signals itself right after `takeStartLock` returns: holder.json is published, and in the
    // earlier order no handler existed yet, so the kernel's default action ended it with the record behind.
    const run = startDaemon(home, { ACP_TEST_RAISE_SIGTERM_AT: "after-lock", TMPDIR: scratch });
    const exit = await run.exited;

    expect(exit.status).toBe(0);
    expect(existsSync(join(root, "agentcpd.lock"))).toBe(false);
    expect(existsSync(join(root, "agentcpd.lock", "holder.json"))).toBe(false);
    expect(imageOf(database)).toEqual(before);
    expect(readdirSync(scratch).filter((name) => name.startsWith("acp-db-snapshot-"))).toEqual([]);
  }, 120_000);

  /**
   * The stop contract has two cases, and these rows keep them apart. A stop the process has seen at its last
   * check, immediately before the writable open, leaves the database exactly as it was and gives the lock
   * back. A stop that lands after that check cannot be kept from the open (the open is synchronous, and no
   * handler runs during it); it is handed to exactly one normal graceful shutdown, which lets the start in
   * flight settle and then runs the normal stop. Exit code 0 is not evidence for either: the database is read.
   */
  it("stop (i): a stop seen at the last check leaves the database unchanged and the lock released", async () => {
    const { home, root, database } = newHome("/tmp");
    currentDatabase(database);
    installGitHubAppCredential(root);
    const auditBefore = countOf(database, "SELECT COUNT(*) AS n FROM audit_events");
    // Reading it opened it, and a WAL database left its sidecars: they are the test's, not the file's.
    for (const suffix of ["-wal", "-shm"]) rmSync(`${database}${suffix}`, { force: true });
    const before = imageOf(database);

    const run = startDaemon(home, { ACP_TEST_RAISE_SIGTERM_AT: "before-check" });
    await run.exited;

    expect(imageOf(database)).toEqual(before);
    expect(existsSync(`${database}-wal`)).toBe(false);
    expect(existsSync(`${database}-shm`)).toBe(false);
    expect(countOf(database, "SELECT COUNT(*) AS n FROM audit_events")).toBe(auditBefore);
    expect(existsSync(join(root, "agentcpd.lock"))).toBe(false);
  }, 180_000);

  /** What a finished process left beside the database, read before anything here opens it (opening it makes sidecars). */
  const leftovers = (root: string, database: string) => ({
    wal: existsSync(`${database}-wal`),
    shm: existsSync(`${database}-shm`),
    lock: existsSync(join(root, "agentcpd.lock")),
  });
  const closedAndReleased = { wal: false, shm: false, lock: false };

  const auditCount = (database: string, kind: string): number =>
    countOf(database, `SELECT COUNT(*) AS n FROM audit_events WHERE kind = '${kind}'`);

  it("stop (ii): a stop handled after the last check is one normal start and one normal stop, the handle closed and the lock released", async () => {
    const { home, root, database } = newHome("/tmp");
    currentDatabase(database);
    installGitHubAppCredential(root);

    const run = startDaemon(home, { ACP_TEST_RAISE_SIGTERM_AT: "after-check" });
    await run.exited;
    const left = leftovers(root, database);

    // One start that settled, and one stop after it.
    expect(auditCount(database, "DAEMON_RUNTIME_OBSERVED")).toBe(1);
    expect(auditCount(database, "DAEMON_STARTED")).toBe(1);
    expect(auditCount(database, "DAEMON_STOPPED")).toBe(1);
    expect(run.stdout().match(/shutting down on/g)?.length).toBe(1);
    // The live handle was closed (a write-ahead log left behind is what a process that never closed leaves),
    // and the lock is given back.
    expect(left).toEqual(closedAndReleased);
  }, 180_000);

  it("stop (ii): SIGTERM and SIGINT together are one shutdown, and the handle is still closed and the lock still released", async () => {
    const { home, root, database } = newHome("/tmp");
    currentDatabase(database);
    installGitHubAppCredential(root);

    const run = startDaemon(home, { ACP_TEST_RAISE_SIGTERM_AT: "after-check" });
    // A second stop, a different signal, once the database is open.
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (existsSync(database) && existsSync(`${database}-wal`)) break;
      if (Date.now() > deadline) throw new Error(`the database was never opened; stderr: ${run.stderr().slice(-400)}`);
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
    }
    run.child.kill("SIGINT");
    await run.exited;
    const left = leftovers(root, database);

    expect(run.stdout().match(/shutting down on/g)?.length).toBe(1);
    expect(auditCount(database, "DAEMON_STOPPED")).toBe(1);
    expect(auditCount(database, "DAEMON_STARTED")).toBe(1);
    expect(left).toEqual(closedAndReleased);
  }, 180_000);

  /**
   * Samples, while the process runs, for the one thing the cleanup order forbids: the lock gone while the
   * database is still open (a write-ahead log standing beside it). Polling cannot prove an absence, but the
   * orders it is here to catch hold the wrong state for whole seconds.
   */
  const watchLockAgainstOpenHandle = (root: string, database: string) => {
    let violated = false;
    const timer = setInterval(() => {
      if (!existsSync(join(root, "agentcpd.lock")) && existsSync(`${database}-wal`)) violated = true;
    }, 5);
    return { stop: (): boolean => { clearInterval(timer); return violated; } };
  };

  /** A start the daemon itself refuses once the database is open: its own backoff is still running (2 s). */
  const refusedByBackoff = (root: string): void => {
    writeFileSync(
      join(root, "crash-loop.json"),
      JSON.stringify({ failures: 1, firstAt: new Date().toISOString(), retryNotBefore: new Date(Date.now() + 600_000).toISOString() }),
      { mode: 0o600 },
    );
  };

  it("stop (ii): a refused start goes through the one cleanup: the handle is closed first, the lock released after, and the stop is on record", async () => {
    const { home, root, database } = newHome("/tmp");
    currentDatabase(database);
    installGitHubAppCredential(root);
    refusedByBackoff(root);
    const watcher = watchLockAgainstOpenHandle(root, database);

    const run = startDaemon(home);
    const exit = await run.exited;
    const violated = watcher.stop();
    const left = leftovers(root, database);

    expect(exit.status).toBe(1);
    expect(violated).toBe(false);
    expect(left).toEqual(closedAndReleased);
    expect(auditCount(database, "DAEMON_START_REFUSED")).toBe(1);
    expect(auditCount(database, "DAEMON_STARTED")).toBe(0);
    expect(auditCount(database, "DAEMON_STOPPED")).toBe(1);
  }, 180_000);

  it("stop (ii): SIGTERM and SIGINT during a refusal's backoff, with the daemon's stop held, are not cut short by the refusal", async () => {
    const { home, root, database } = newHome("/tmp");
    currentDatabase(database);
    installGitHubAppCredential(root);
    refusedByBackoff(root);
    const watcher = watchLockAgainstOpenHandle(root, database);

    // The stop is held 2.5 s, longer than the 2 s backoff the refusal waits out.
    const run = startDaemon(home, { ACP_TEST_DELAY_STOP_MS: "2500" });
    await run.waitFor("backoff:");
    run.child.kill("SIGTERM");
    run.child.kill("SIGINT");
    await run.exited;
    const violated = watcher.stop();
    const left = leftovers(root, database);

    expect(violated).toBe(false);
    expect(left).toEqual(closedAndReleased);
    expect(run.stdout().match(/shutting down on/g)?.length).toBe(1);
    expect(auditCount(database, "DAEMON_STOPPED")).toBe(1);
  }, 180_000);

  it("stop (ii): a stop whose DAEMON_STOPPED write fails still closes the handle, and only then releases the lock", async () => {
    const { home, root, database } = newHome("/tmp");
    currentDatabase(database);
    installGitHubAppCredential(root);
    const raw = new Database(database);
    raw.exec(
      `CREATE TRIGGER zz_refuse_stop BEFORE INSERT ON audit_events WHEN NEW.kind = 'DAEMON_STOPPED'
       BEGIN SELECT RAISE(ABORT, 'the stop row is refused'); END`,
    );
    raw.close();
    const watcher = watchLockAgainstOpenHandle(root, database);

    const run = startDaemon(home, { ACP_TEST_RAISE_SIGTERM_AT: "after-check" });
    await run.exited;
    const violated = watcher.stop();
    const left = leftovers(root, database);

    expect(violated).toBe(false);
    expect(left).toEqual(closedAndReleased);
    expect(auditCount(database, "DAEMON_STARTED")).toBe(1);
    expect(auditCount(database, "DAEMON_STOPPED")).toBe(0);
    expect(run.stderr()).toContain("the stop did not complete cleanly");
  }, 180_000);

  it("stop (ii): a close that throws keeps the lock marker, exits non-zero, and the exit hook does not release it", async () => {
    const { home, root, database } = newHome("/tmp");
    currentDatabase(database);
    installGitHubAppCredential(root);

    // The close throws, as it does with a query still running on the handle.
    const run = startDaemon(home, { ACP_TEST_RAISE_SIGTERM_AT: "after-check", ACP_TEST_FAIL_DATABASE_CLOSE: "1" });
    const exit = await run.exited;

    expect(exit.status).toBe(1);
    expect(run.stderr()).toContain("the stop did not complete cleanly");
    // The marker stays: whoever finds it learns the handle may still have been open. The kernel releases
    // the process's own locks when it exits; the record is not the process's to delete after a failed close.
    expect(existsSync(join(root, "agentcpd.lock", "holder.json"))).toBe(true);
  }, 180_000);

  it("stop (ii): a start that fails is not recorded as a start, and the stop after it still closes the handle and releases the lock", async () => {
    const { home, root, database } = newHome("/tmp");
    currentDatabase(database);
    installGitHubAppCredential(root);
    // A start the daemon itself refuses once the database is open: its own backoff is still running.
    writeFileSync(
      join(root, "crash-loop.json"),
      JSON.stringify({ failures: 4, firstAt: new Date().toISOString(), retryNotBefore: new Date(Date.now() + 600_000).toISOString() }),
      { mode: 0o600 },
    );

    const run = startDaemon(home, { ACP_TEST_RAISE_SIGTERM_AT: "after-check" });
    await run.exited;
    const left = leftovers(root, database);

    expect(auditCount(database, "DAEMON_STARTED")).toBe(0);
    expect(auditCount(database, "DAEMON_START_REFUSED")).toBe(1);
    expect(auditCount(database, "DAEMON_STOPPED")).toBe(1);
    expect(run.stdout().match(/shutting down on/g)?.length).toBe(1);
    expect(left).toEqual(closedAndReleased);
  }, 180_000);

  it.each([
    ["without a signal", {}],
    ["with a stop recorded after the last check", { ACP_TEST_RAISE_SIGTERM_AT: "after-check" }],
  ] as const)("stop (ii): a start() that rejects, %s, runs the one cleanup before the process exits: handle closed, lock released", async (_label, env) => {
    const { home, root, database } = newHome("/tmp");
    currentDatabase(database);
    installGitHubAppCredential(root);
    // A crash-loop record that is a directory: the start runs to its end and then cannot replace the record
    // (EISDIR), in the start's own failure handling too, so `start()` rejects after it has written.
    mkdirSync(join(root, "crash-loop.json"), { mode: 0o700 });

    const run = startDaemon(home, { ...env });
    const exit = await run.exited;
    const left = leftovers(root, database);

    expect(exit.status).not.toBeNull();
    // The failed start is not a start; the cleanup that follows it is the normal stop, and it closed the handle.
    expect(auditCount(database, "DAEMON_STARTED")).toBe(0);
    expect(auditCount(database, "DAEMON_STOPPED")).toBe(1);
    expect(left).toEqual(closedAndReleased);
  }, 180_000);

  it("stop (ii): malformed canonical-session configuration with a recorded stop closes the handle, releases the lock, and writes nothing more", async () => {
    const { home, root, database } = newHome("/tmp");
    currentDatabase(database);
    installGitHubAppCredential(root);

    const run = startDaemon(home, {
      ACP_TEST_RAISE_SIGTERM_AT: "after-check",
      ACP_CANONICAL_SESSIONS_JSON: "[{bad",
      ACP_CANONICAL_CTO_PEER_PROTOCOL: "1",
      ACP_CANONICAL_CTO_BUZZ_PURPOSE: "purpose",
      ACP_BUZZ_CHANNEL: "room",
    });
    await run.exited;
    const left = leftovers(root, database);

    // The error path closes the handle and gives the lock back; no daemon was built, so there is no stop row,
    // and nothing beyond the runtime observation this path already wrote.
    expect(left).toEqual(closedAndReleased);
    expect(auditCount(database, "DAEMON_RUNTIME_OBSERVED")).toBe(1);
    expect(auditCount(database, "DAEMON_STARTED")).toBe(0);
    expect(auditCount(database, "DAEMON_STOPPED")).toBe(0);
    expect(countOf(database, "SELECT COUNT(*) AS n FROM audit_events")).toBe(1);
  }, 180_000);

  it("round 2 item 5: a start that finds agentcpd.lock held writes nothing and says so", async () => {
    const { home, root, database } = newHome();
    currentDatabase(database);
    // The gate passes, so what refuses this start is the lock and nothing else.
    installGitHubAppCredential(root);
    const before = imageOf(database);
    const holder = new SingleInstanceLock(join(root, "agentcpd.lock"));
    expect(holder.acquire(new Date().toISOString()).allowed).toBe(true);
    try {
      const result = await runToExit(home);

      expectRefusedUntouched(result, database, before, ReasonCode.DAEMON_ALREADY_RUNNING);
    } finally {
      holder.release();
    }
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

  it("reads a registration that is only in the write-ahead log, from a copy, and fails closed when it cannot", async () => {
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
      const before = imageOf(database);
      const { judgeStartBeforeOpening } = await import("../../src/daemon/start-gate.ts");
      const judged = await judgeStartBeforeOpening(gateConfig(root, database));
      expect(judged.findings.map((finding) => finding.code)).toContain("REPOSITORY_UNREADABLE");
      expect(imageOf(database)).toEqual(before);

      // A database file that is not one: the copy cannot be opened, and the gate refuses rather than skip.
      const broken = join(root, "broken.sqlite");
      writeFileSync(broken, "not a database", { mode: 0o600 });
      const refused = await judgeStartBeforeOpening(gateConfig(root, broken));
      expect(refused.findings.map((finding) => finding.code)).toContain("START_GATE_DATABASE_UNREADABLE");
      expect(refused.status).toBe("BLOCKED");
    } finally {
      writer.close();
    }
  });

  it("judges the probes of a database larger than the old in-memory cap, from an on-disk copy it removes", async () => {
    const { root, database } = newHome();
    currentDatabase(database);
    registerCheckout(database, join(root, "no-such-checkout"));
    const raw = new Database(database);
    raw.pragma("journal_mode = DELETE");
    raw.exec("CREATE TABLE gate_padding (b BLOB)");
    // 300 MiB, past the 256 MiB the gate once refused to copy into memory (and so skipped, on a live database).
    raw.prepare("INSERT INTO gate_padding VALUES (zeroblob(?))").run(300 * 1024 * 1024);
    raw.close();
    expect(statSync(database).size).toBeGreaterThan(256 * 1024 * 1024);
    const before = imageOf(database);
    const scratch = mkdtempSync(join(tmpdir(), "acp-gate-scratch-"));
    homes.push(scratch);
    const previous = process.env["TMPDIR"];
    process.env["TMPDIR"] = scratch;
    try {
      const { judgeStartBeforeOpening } = await import("../../src/daemon/start-gate.ts");
      const judged = await judgeStartBeforeOpening(gateConfig(root, database));

      expect(judged.notJudged).toEqual([]);
      expect(judged.findings.map((finding) => finding.code)).toContain("REPOSITORY_UNREADABLE");
      expect(imageOf(database)).toEqual(before);
      // The private copy lived in the scratch directory and is gone.
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previous;
    }
  }, 180_000);

  it("refuses, and does not skip, when the private copy cannot be made", async () => {
    const { root, database } = newHome();
    currentDatabase(database);
    const before = imageOf(database);
    const previous = process.env["TMPDIR"];
    // Nowhere to put a copy, as when the disk is full or the directory is gone.
    process.env["TMPDIR"] = join(root, "no-such-scratch-directory");
    try {
      const { judgeStartBeforeOpening } = await import("../../src/daemon/start-gate.ts");
      const judged = await judgeStartBeforeOpening(gateConfig(root, database));

      expect(judged.status).toBe("BLOCKED");
      expect(judged.findings.map((finding) => finding.code)).toContain("START_GATE_DATABASE_UNREADABLE");
      expect(judged.notJudged).toEqual([]);
      expect(imageOf(database)).toEqual(before);
    } finally {
      if (previous === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previous;
    }
  });

  it("final review B: a hot rollback journal is recovered in the copy, and the original is left exactly as it was", async () => {
    const { root, database } = newHome();
    currentDatabase(database, "DELETE");
    registerCheckout(database, join(root, "no-such-checkout"));
    // A transaction big enough to spill pages to the main file, caught mid-way: the file is changed, and
    // the journal holds the pages that undo it. That pair, copied elsewhere, is what a killed daemon leaves.
    const writer = new Database(database);
    writer.pragma("cache_size = 10");
    writer.exec("BEGIN");
    writer.exec("CREATE TABLE gate_pad (b BLOB)");
    writer.prepare("INSERT INTO gate_pad VALUES (zeroblob(?))").run(8 * 1024 * 1024);
    const hot = join(root, "hot.sqlite");
    copyFileSync(database, hot);
    copyFileSync(`${database}-journal`, `${hot}-journal`);
    chmodSync(hot, 0o600);
    chmodSync(`${hot}-journal`, 0o600);
    writer.exec("ROLLBACK");
    writer.close();
    expect(statSync(`${hot}-journal`).size).toBeGreaterThan(0);
    const before = imageOf(hot);
    expect(before.journal).toBe(true);

    const { judgeStartBeforeOpening } = await import("../../src/daemon/start-gate.ts");
    const judged = await judgeStartBeforeOpening(gateConfig(root, hot));

    // Judged as an ordinary database, not refused for being unreadable.
    expect(judged.findings.map((finding) => finding.code)).toContain("REPOSITORY_UNREADABLE");
    expect(judged.findings.map((finding) => finding.code)).not.toContain("START_GATE_DATABASE_UNREADABLE");
    expect(imageOf(hot)).toEqual(before);
  });

  it("structural (c): every way out of a snapshot, normal or not, leaves no snapshot directory", async () => {
    const { root, database } = newHome();
    currentDatabase(database);
    const scratch = mkdtempSync(join(tmpdir(), "acp-gate-scratch-"));
    homes.push(scratch);
    const previous = process.env["TMPDIR"];
    process.env["TMPDIR"] = scratch;
    const left = (): string[] => readdirSync(scratch).filter((name) => name.startsWith("acp-db-snapshot-"));
    try {
      const { withDatabaseSnapshot, withDatabaseSnapshotAsync } = await import("../../src/db/database-snapshot.ts");
      const user = (copy: Database.Database): number => Number(copy.pragma("user_version", { simple: true }));

      expect(withDatabaseSnapshot(database, user)).toBeGreaterThan(0);
      expect(left()).toEqual([]);
      expect(await withDatabaseSnapshotAsync(database, user)).toBeGreaterThan(0);
      expect(left()).toEqual([]);
      // A reader that throws, and a file that is not a database.
      expect(() => withDatabaseSnapshot(database, () => { throw new Error("reader failed"); })).toThrow("reader failed");
      await expect(withDatabaseSnapshotAsync(database, () => { throw new Error("reader failed"); })).rejects.toThrow("reader failed");
      const broken = join(root, "broken.sqlite");
      writeFileSync(broken, "not a database", { mode: 0o600 });
      expect(() => withDatabaseSnapshot(broken, user)).toThrow(/private copy/);
      await expect(withDatabaseSnapshotAsync(broken, user)).rejects.toThrow(/private copy/);
      expect(left()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previous;
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
