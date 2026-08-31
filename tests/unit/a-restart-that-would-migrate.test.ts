import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { SCHEMA_VERSION, openDb } from "../../src/db/database.ts";
import { migrationChainFrom } from "../../src/db/migrations.ts";

/**
 * A restart is a migration, and nothing asked.
 *
 * `/Users/isaac/projects/agent-control-plane` is both this repository's checkout and the launchd
 * job's `WorkingDirectory`. Measured 2026-08-31: the running `dist` and the live database were
 * both at schema 25, the checkout at 30, `main` at 34 — so a `pnpm build` run in that tree for
 * an unrelated reason arms a migration that the next crash or reboot performs. `KeepAlive
 * { SuccessfulExit = false }` and `RunAtLoad` supply the restart. The ledger shows this has
 * already happened once: migrations 21..25 all landed inside the first 85ms of a daemon start.
 *
 * These run the **production entry point** in a child process under a disposable `HOME`, rather
 * than calling the guard. A guard-level test proves a function refuses; it cannot prove the
 * daemon's startup path reaches it, and the whole defect is about which code a restart runs.
 * Nothing here imports a symbol this change introduced, so the file also runs against the head
 * that has the defect — where it fails on the first assertion, because the database moved.
 *
 * The exit code is part of the subject, not decoration. `KeepAlive { SuccessfulExit = false }`
 * restarts an unsuccessful exit and leaves a successful one alone, so a refusal that exits 1 is
 * retried every `ThrottleInterval` (30s) forever — the crash loop with a nicer message.
 */
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/u, "");
const agentcpd = join(repositoryRoot, "src/daemon/agentcpd.ts");
const agentctl = join(repositoryRoot, "src/cli/agentctl.ts");
const V11_SCHEMA = readFileSync(
  fileURLToPath(new URL("../fixtures/schema-v11.sql", import.meta.url)),
  "utf8",
);

interface ChildResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

/** macOS `sockaddr_un` paths are short; the repository worktree path is long enough to break them. */
const takeHome = (): string => {
  const home = mkdtempSync(join("/tmp", "acp-738-"));
  homes.push(home);
  return home;
};

const stateRootOf = (home: string): string => {
  const root = join(home, ".agent-control-plane");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return root;
};

/** A database at the schema an older deployed build left behind, with no current DDL on it. */
const databaseAtV11 = (home: string): string => {
  const path = join(stateRootOf(home), "state.sqlite");
  const raw = new Database(path);
  try {
    raw.exec(V11_SCHEMA);
    raw.pragma("user_version = 11");
  } finally {
    raw.close();
  }
  // Explicit, because CI runs under `umask 022` where this would otherwise be 0644 and the
  // loader would refuse the file for a reason that has nothing to do with this test.
  chmodSync(path, 0o600);
  return path;
};

const schemaVersionOf = (path: string): number => {
  const raw = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return Number(raw.pragma("user_version", { simple: true }));
  } finally {
    raw.close();
  }
};

const runNode = async (
  script: string,
  args: string[],
  home: string,
  timeoutMs: number,
): Promise<ChildResult> => {
  const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
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
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  return await new Promise<ChildResult>((resolveResult, rejectResult) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", rejectResult);
    child.once("exit", (status, signal) => {
      clearTimeout(timer);
      resolveResult({ status, signal, stdout, stderr, timedOut });
    });
  });
};

const startDaemon = (home: string, timeoutMs = 30_000): Promise<ChildResult> =>
  runNode(agentcpd, [], home, timeoutMs);

describe("a daemon start that would migrate the live database", () => {
  it("refuses, leaves the database at its own version, and exits so the supervisor stops retrying", async () => {
    const home = takeHome();
    const databasePath = databaseAtV11(home);
    const chain = migrationChainFrom(11).map((migration) => migration.id);

    const result = await startDaemon(home);

    // The load-bearing assertion, and the one that fails on a head with the defect: the file is
    // untouched. Everything below is about how the refusal was reported.
    expect(
      schemaVersionOf(databasePath),
      `the database was migrated by a start nobody approved\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    ).toBe(11);

    // `KeepAlive { SuccessfulExit = false }`: exiting 0 is what makes the refusal durable.
    // Exit 1 here is the 30-second restart loop, and a kill means it started and parked.
    expect(
      { status: result.status, timedOut: result.timedOut },
      `stderr:\n${result.stderr}`,
    ).toEqual({ status: 0, timedOut: false });

    expect(result.stderr).toContain('"reasonCode": "SCHEMA_MIGRATION_NOT_APPROVED"');
    // Says exactly what it would have done: from-version, to-version, which migrations.
    expect(result.stderr).toContain('"fromVersion": 11');
    expect(result.stderr).toContain(`"toVersion": ${SCHEMA_VERSION}`);
    for (const id of chain) expect(result.stderr).toContain(id);

    const refusal = JSON.parse(
      readFileSync(join(home, ".agent-control-plane", "migration-refusal.json"), "utf8"),
    ) as { reasonCode: string; evidence: { migrations: string[] } };
    expect(refusal.reasonCode).toBe("SCHEMA_MIGRATION_NOT_APPROVED");
    expect(refusal.evidence.migrations).toEqual(chain);
  }, 90_000);

  it("still answers an offline observation with the refusal, because no socket and no doctor survive it", async () => {
    const home = takeHome();
    const databasePath = databaseAtV11(home);

    await startDaemon(home);
    const status = await runNode(agentctl, ["daemon", "status"], home, 30_000);

    expect(status.status, `stderr:\n${status.stderr}`).toBe(0);
    const reported = JSON.parse(status.stdout) as {
      migrationRefusal: { evidence: { fromVersion: number; toVersion: number } } | null;
    };
    expect(reported.migrationRefusal).not.toBeNull();
    expect(reported.migrationRefusal?.evidence.fromVersion).toBe(11);
    expect(reported.migrationRefusal?.evidence.toVersion).toBe(SCHEMA_VERSION);
    expect(schemaVersionOf(databasePath)).toBe(11);
  }, 90_000);

  it("is unaffected when the start does not migrate, so the gate does not fire on every boot", async () => {
    const home = takeHome();
    const databasePath = join(stateRootOf(home), "state.sqlite");
    openDb(databasePath).close();
    expect(schemaVersionOf(databasePath)).toBe(SCHEMA_VERSION);

    const result = await startDaemon(home);

    expect(result.stderr).not.toContain("SCHEMA_MIGRATION_NOT_APPROVED");
    expect(existsSync(join(home, ".agent-control-plane", "migration-refusal.json"))).toBe(false);
    expect(schemaVersionOf(databasePath)).toBe(SCHEMA_VERSION);
    // This host has no GitHub App credential, so the start fails its doctor and exits 1 — the
    // ordinary unsuccessful exit launchd is meant to retry. The refusal's exit 0 is scoped to
    // the refusal and did not become the exit code for everything.
    expect({ status: result.status, timedOut: result.timedOut }).toEqual({
      status: 1,
      timedOut: false,
    });
  }, 90_000);
});
