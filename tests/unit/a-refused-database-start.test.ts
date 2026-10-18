import Database from "better-sqlite3";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { acpError } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { dispositionForStartupError } from "../../src/daemon/agentcpd.ts";
import { openDb } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { releasedChainImage } from "../helpers/released-chain-image.ts";
import { V47_CANDIDATE_CHECKSUM, asCandidateV47 } from "../helpers/released-v47-schema.ts";

/**
 * SEC-OD1 (FIX-SEC-R3 R3-01, CEO 80492af7; FIX-SEC-EXIT, CEO e620fb48 and e66caea6) — a daemon start that
 * would migrate a database this build refuses as it stands, run through the **production entry point** in
 * a child process under a disposable `HOME`, as the #738 restart test runs it.
 *
 * Review r3 measured the refusal of a forged owner-decision label going through the migrator's generic
 * backup and restore: the file was rewritten (872,448 → 860,160 bytes, a new inode), and the start
 * reported INTERNAL_ERROR and exited 1 with no refusal report. Now the migrator's read-only preflight
 * refuses before anything touches the file, and the start reports the refusal's own code and writes the
 * #738 refusal record.
 *
 * The exit is decided from the refusal this run confirmed, never from a record an earlier start left. Run
 * directly, every start exits 78. Under the rendered launchd plist (`ACP_DAEMON_SUPERVISOR=launchd`)
 * every start, the first included, delivers the #738 stop instead: the record, `agentctl daemon status`,
 * and exit 0, which `KeepAlive { SuccessfulExit = false }` takes as "leave the job stopped". A crash or
 * any other startup failure still exits 1 under that plist, the exit launchd retries.
 *
 * The approval stays on file and unspent: nothing was migrated, and a refusal is not a migration.
 */
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/u, "");
const agentcpd = join(repositoryRoot, "src/daemon/agentcpd.ts");
const agentctl = join(repositoryRoot, "src/cli/agentctl.ts");

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

const NOW = "2026-10-18T00:00:00.000Z";

/** A v46 database as the released chain leaves it, in a fresh `HOME`'s state root, with `contaminate` applied. */
const stateAtV46 = (contaminate: (path: string) => void): { home: string; path: string } => {
  const home = mkdtempSync(join(tmpdir(), "acp-r3-"));
  homes.push(home);
  const root = join(home, ".agent-control-plane");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const path = releasedChainImage(join(root, "state.sqlite"), 46);
  contaminate(path);
  chmodSync(path, 0o600);
  approveMigration(path, "FIX-SEC-R3 refused start");
  return { home, path };
};

/** An ordinary v46 write of the canonical label: no guard exists at v46, and nothing admitted it. */
const forgedLabel = (path: string): void => {
  const raw = new Database(path);
  try {
    raw.function("acp_evidence_write_authorized", () => 0);
    raw.prepare(
      `INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
       VALUES ('run_r3', 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'QUEUED', 'refused start', 'sha256:contract', ?)`,
    ).run(NOW);
    raw.prepare(
      `INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
       VALUES ('art_r3_forged', 'run_r3', 'APPROVAL', 'sha256:forged', NULL, ?, 'production-gate:owner-decision', ?)`,
    ).run(JSON.stringify({ kind: "OWNER_DECISION", item: "an item", approved: true }), NOW);
  } finally {
    raw.close();
  }
};

const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * The database image: the main file's bytes and its write-ahead log's, or `null` where none exists. The
 * header's two journal-mode bytes (18, 19) are read out so the image is shown to be a WAL one.
 */
const imageOf = (path: string): { main: string; wal: string | null; header: string } => ({
  main: sha(path),
  wal: existsSync(`${path}-wal`) ? sha(`${path}-wal`) : null,
  header: readFileSync(path).subarray(18, 20).toString("hex"),
});

type Supervisor = "direct" | "launchd";

const runNode = async (
  script: string,
  args: string[],
  home: string,
  supervisor: Supervisor,
): Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }> => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USER: "startup-owner",
    ACP_MCP_TOKEN: "startup-mcp-token",
    ACP_OPERATOR_TOKEN: "startup-operator-token",
    ACP_OPERATOR_ACTOR: "startup-owner",
  };
  delete env["ACP_DAEMON_SUPERVISOR"];
  if (supervisor === "launchd") env["ACP_DAEMON_SUPERVISOR"] = "launchd";
  const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: repositoryRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  return await new Promise((resolveResult, rejectResult) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 60_000);
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.once("error", rejectResult);
    child.once("exit", (status) => {
      clearTimeout(timer);
      resolveResult({ status, stdout, stderr, timedOut });
    });
  });
};

const startDaemon = (home: string, supervisor: Supervisor) => runNode(agentcpd, [], home, supervisor);

const recordOf = (home: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(home, ".agent-control-plane", "migration-refusal.json"), "utf8")) as Record<string, unknown>;

const CASES = [
  { name: "an owner-decision label written before the guard", contaminate: forgedLabel, code: "OWNER_DECISION_LABEL_PREDATES_GUARD" },
  {
    name: "a receipt the candidate v47 wrote",
    contaminate: (path: string) => {
      forgedLabel(path);
      asCandidateV47(path, V47_CANDIDATE_CHECKSUM, NOW);
    },
    code: "MIGRATION_RECEIPT_MISMATCH",
  },
];

describe("a daemon start that would migrate a database this build refuses as it stands", () => {
  it.each(CASES)("$name, run directly: exits 78 under its own code on every start, record or none; the WAL image is byte-identical", async ({ contaminate, code }) => {
    const { home, path } = stateAtV46(contaminate);
    const before = imageOf(path);
    expect(before.header, "the fixture is a WAL image").toBe("0202");

    for (const start of ["first, no record on file", "again, its own record on file"]) {
      const run = await startDaemon(home, "direct");
      expect({ start, status: run.status, timedOut: run.timedOut }, `stderr:\n${run.stderr}`).toEqual({ start, status: 78, timedOut: false });
      expect(run.stderr).toContain(`"reasonCode": "${code}"`);
      expect(run.stderr).toContain("Exit 78: this start failed");
      expect(run.stderr).not.toContain("INTERNAL_ERROR");
      expect(imageOf(path)).toEqual(before);
      const record = recordOf(home);
      expect(record).toMatchObject({ reasonCode: code, supervisor: null, exitCode: 78 });
      expect(record).not.toHaveProperty("standing");
    }
  }, 180_000);

  it.each(CASES)("$name, under the launchd plist: every start, the first included, delivers the #738 stop (record, status, exit 0); a direct run after it still exits 78", async ({ contaminate, code }) => {
    const { home, path } = stateAtV46(contaminate);
    const before = imageOf(path);

    for (const start of ["first, no record on file", "again, its own record on file"]) {
      const run = await startDaemon(home, "launchd");
      expect({ start, status: run.status, timedOut: run.timedOut }, `stderr:\n${run.stderr}`).toEqual({ start, status: 0, timedOut: false });
      expect(run.stderr).toContain(`"reasonCode": "${code}"`);
      expect(run.stderr).toContain("Exit 0 is the launchd stop signal (#738), not a successful start");
      expect(imageOf(path)).toEqual(before);
      expect(recordOf(home)).toMatchObject({ reasonCode: code, supervisor: "launchd", exitCode: 0 });
    }

    // The #738 offline observation: no socket and no doctor survive the refusal, and status still names it.
    const status = await runNode(agentctl, ["daemon", "status"], home, "direct");
    expect(status.status, `stderr:\n${status.stderr}`).toBe(0);
    const reported = JSON.parse(status.stdout) as { migrationRefusal: Record<string, unknown> | null };
    expect(reported.migrationRefusal).toMatchObject({ reasonCode: code, supervisor: "launchd", exitCode: 0 });

    const direct = await startDaemon(home, "direct");
    expect({ status: direct.status, timedOut: direct.timedOut }, `stderr:\n${direct.stderr}`).toEqual({ status: 78, timedOut: false });
    expect(imageOf(path)).toEqual(before);
  }, 240_000);

  it("a start that fails for any other reason under the launchd plist still exits 1, the exit launchd retries", async () => {
    const home = mkdtempSync(join(tmpdir(), "acp-r3-"));
    homes.push(home);
    const root = join(home, ".agent-control-plane");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    const databasePath = join(root, "state.sqlite");
    openDb(databasePath).close();

    // No GitHub App credential under this HOME, so the start fails its doctor: the #738 test's exit-1 row,
    // here under the plist's variable.
    const run = await startDaemon(home, "launchd");
    expect({ status: run.status, timedOut: run.timedOut }, `stderr:\n${run.stderr}`).toEqual({ status: 1, timedOut: false });
    expect(run.stderr).toContain('"reasonCode": "DOCTOR_BLOCKED"');
    expect(existsSync(join(root, "migration-refusal.json"))).toBe(false);

    const launchd = { ACP_DAEMON_SUPERVISOR: "launchd" };
    expect(dispositionForStartupError(new Error("uncaught"), databasePath, launchd)).toMatchObject({ exitCode: 1, reportPath: null });
    expect(dispositionForStartupError(acpError(ReasonCode.INTERNAL_ERROR, "crash"), databasePath, launchd))
      .toMatchObject({ exitCode: 1, reportPath: null });
  }, 120_000);

  it("only the rendered plist sets the variable, and its KeepAlive is unchanged", () => {
    const deploy = join(repositoryRoot, "deploy");
    const output = join(mkdtempSync(join(tmpdir(), "acp-r3-plist-")), "agentcpd.plist");
    homes.push(output.slice(0, output.lastIndexOf("/")));
    const rendered = spawnSync(process.execPath, [
      join(deploy, "render-launchd-plist.mjs"),
      join(deploy, "com.agentcontrolplane.agentcpd.plist.template"),
      output,
      "/Users/operator/.agent-control-plane/agentcpd-launch.sh",
      "/Users/operator/app",
      "/Users/operator/.agent-control-plane/agentcpd.out.log",
      "/Users/operator/.agent-control-plane/agentcpd.err.log",
      "/Users/operator",
      "/usr/bin:/bin",
    ], { encoding: "utf8", timeout: 30_000 });
    expect(rendered.status, rendered.stderr).toBe(0);
    const plutil = (key: string): unknown =>
      JSON.parse(spawnSync("/usr/bin/plutil", ["-extract", key, "json", "-o", "-", output], { encoding: "utf8", timeout: 30_000 }).stdout);
    expect(plutil("EnvironmentVariables")).toMatchObject({ ACP_DAEMON_SUPERVISOR: "launchd" });
    expect(plutil("KeepAlive")).toEqual({ SuccessfulExit: false });
    expect(readFileSync(join(deploy, "install-launchd.sh"), "utf8")).not.toContain("ACP_DAEMON_SUPERVISOR");
  });
});
