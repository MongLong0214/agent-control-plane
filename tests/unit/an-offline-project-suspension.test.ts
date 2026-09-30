import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { afterAll, describe, expect, it, vi } from "vitest";

import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { SCHEMA_VERSION } from "../../src/db/migrations.ts";
import { main as stateAdmin } from "../../src/db/state-admin.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const setup = async () => {
  const harness = makeHarness();
  const { projectId } = await registerFixtureProject(harness);
  harness.cp.db.close();
  const databasePath = join(harness.root, "state.sqlite");
  const args = ["suspend-project", "--database", databasePath, "--project-id", projectId,
    "--approved-by", "owner", "--confirm-suspend"];
  return { databasePath, projectId, args };
};

const snapshot = (databasePath: string) =>
  new Map(readdirSync(dirname(databasePath))
    .filter((name) => name === "state.sqlite" || /^state\.sqlite-(?:wal|shm|journal)$/.test(name))
    .map((name) => [name, readFileSync(join(dirname(databasePath), name))]));

describe("#1032: offline project suspension", () => {
  it("refuses while a live agentcpd holds the state lock", async () => {
    const { databasePath, args } = await setup();
    const lock = new SingleInstanceLock(join(dirname(databasePath), "agentcpd.lock"));
    expect(lock.acquire(new Date().toISOString()).allowed).toBe(true);
    try {
      await expect(stateAdmin(args)).rejects.toThrow(/holds the state lock/);
    } finally {
      lock.release();
    }
  });

  it.each([
    ["approval", ["--approved-by", "owner"]],
    ["confirmation", ["--confirm-suspend"]],
  ])("refuses without %s", async (_label, omitted) => {
    const { args } = await setup();
    await expect(stateAdmin(args.filter((token) => !omitted.includes(token))))
      .rejects.toThrow(/--approved-by.*--confirm-suspend/);
  });

  it("refuses an unknown project id without writing an audit row", async () => {
    const { databasePath, args } = await setup();
    await expect(stateAdmin(args.map((token) => token === "fixture-project" ? "unknown-project" : token)))
      .rejects.toThrow(/unknown project/);
    const db = new Database(databasePath, { readonly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM audit_events WHERE kind = 'PROJECT_SUSPENDED'").get())
        .toMatchObject({ n: 0 });
    } finally {
      db.close();
    }
  });

  it.each([SCHEMA_VERSION - 1, SCHEMA_VERSION + 1])(
    "refuses schema version %s before changing database or sidecar bytes", async (version) => {
    const { databasePath, args } = await setup();
    const raw = new Database(databasePath);
    raw.pragma(`user_version = ${version}`);
    raw.close();
    const before = snapshot(databasePath);
    await expect(stateAdmin(args)).rejects.toThrow(/schema version/);
    const after = snapshot(databasePath);
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [name, bytes] of before) expect(after.get(name)).toEqual(bytes);
    },
  );

  it("suspends through the registry, audits the owner's approval, and leaves the schema version", async () => {
    const { databasePath, projectId, args } = await setup();
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await stateAdmin(args)).toBe(0);
      expect(JSON.parse(String(write.mock.calls.at(-1)?.[0]))).toMatchObject({
        projectId, suspended: true, approvedBy: "owner",
      });
    } finally {
      write.mockRestore();
    }
    const db = new Database(databasePath, { readonly: true });
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      expect(db.prepare("SELECT suspended FROM projects WHERE project_id = ?").get(projectId))
        .toMatchObject({ suspended: 1 });
      const rows = db.prepare("SELECT evidence_json FROM audit_events WHERE kind = 'PROJECT_SUSPENDED' AND project_id = ?")
        .all(projectId) as { evidence_json: string }[];
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.evidence_json)).toMatchObject({
        ownerApproved: true, approvedBy: "owner", source: "agentcpd-state",
      });
    } finally {
      db.close();
    }
  });
});
