import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { approveMigration } from "../../src/db/migration-approval.ts";
import { releasedChainImage } from "../helpers/released-chain-image.ts";
import { V47_CANDIDATE_CHECKSUM, asCandidateV47 } from "../helpers/released-v47-schema.ts";

/**
 * SEC-OD1 (FIX-SEC-R3, R3-01, CEO 80492af7) — a daemon start that would migrate a database this build
 * refuses as it stands, run through the **production entry point** in a child process under a disposable
 * `HOME`, as the #738 restart test runs it.
 *
 * Review r3 measured the refusal of a forged owner-decision label going through the migrator's generic
 * backup and restore: the file was rewritten (872,448 → 860,160 bytes, a new inode), and the start
 * reported INTERNAL_ERROR and exited 1 with no refusal report. Now the migrator's read-only preflight
 * refuses before anything touches the file; the start reports the refusal's own code, writes the report,
 * and exits non-zero. `KeepAlive { SuccessfulExit = false }` restarts that exit once; the restart is the
 * second start here, which finds the same refusal on record and exits 0, so launchd stops.
 *
 * The approval stays on file and unspent: nothing was migrated, and a refusal is not a migration.
 */
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/u, "");
const agentcpd = join(repositoryRoot, "src/daemon/agentcpd.ts");

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

const bytesOf = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const startDaemon = async (home: string): Promise<{ status: number | null; stderr: string; timedOut: boolean }> => {
  const child = spawn(process.execPath, ["--import", "tsx", agentcpd], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOME: home,
      USER: "startup-owner",
      ACP_MCP_TOKEN: "startup-mcp-token",
      ACP_OPERATOR_TOKEN: "startup-operator-token",
      ACP_OPERATOR_ACTOR: "startup-owner",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let timedOut = false;
  return await new Promise((resolveResult, rejectResult) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 30_000);
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdout.on("data", () => undefined);
    child.once("error", rejectResult);
    child.once("exit", (status) => {
      clearTimeout(timer);
      resolveResult({ status, stderr, timedOut });
    });
  });
};

describe("a daemon start that would migrate a database this build refuses as it stands", () => {
  it.each([
    { name: "an owner-decision label written before the guard", contaminate: forgedLabel, code: "OWNER_DECISION_LABEL_PREDATES_GUARD" },
    {
      name: "a receipt the candidate v47 wrote",
      contaminate: (path: string) => {
        forgedLabel(path);
        asCandidateV47(path, V47_CANDIDATE_CHECKSUM, NOW);
      },
      code: "MIGRATION_RECEIPT_MISMATCH",
    },
  ])("$name: exits non-zero under its own code with the file unchanged; the one restart that earns stays down", async ({ contaminate, code }) => {
    const { home, path } = stateAtV46(contaminate);
    const before = bytesOf(path);

    const first = await startDaemon(home);
    expect({ status: first.status, timedOut: first.timedOut }, `stderr:\n${first.stderr}`).toEqual({ status: 78, timedOut: false });
    expect(first.stderr).toContain(`"reasonCode": "${code}"`);
    expect(first.stderr).toContain("launchd restarts this once");
    expect(first.stderr).not.toContain("INTERNAL_ERROR");
    expect(bytesOf(path)).toBe(before);
    const report = JSON.parse(readFileSync(join(home, ".agent-control-plane", "migration-refusal.json"), "utf8")) as {
      reasonCode: string;
      standing: boolean;
    };
    expect(report).toMatchObject({ reasonCode: code, standing: false });

    const restart = await startDaemon(home);
    expect({ status: restart.status, timedOut: restart.timedOut }, `stderr:\n${restart.stderr}`).toEqual({ status: 0, timedOut: false });
    expect(restart.stderr).toContain(`"reasonCode": "${code}"`);
    expect(restart.stderr).toContain("already on record");
    expect(bytesOf(path)).toBe(before);
  }, 120_000);
});
