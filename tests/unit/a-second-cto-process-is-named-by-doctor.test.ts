import { realpathSync } from "node:fs";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { CtoProcess, CtoProcessReader } from "../../src/cto/one-cto-per-project.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { bindCeo, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const STARTED = "Fri Nov 14 12:10:15 2026";
const BOUND_PID = 90_001;
const uid = process.getuid?.() ?? 0;

interface Fake { pid: number; argv: string[]; cwd?: string }

/** One project with its PRIMARY_CTO bound to a session whose recorded process is `BOUND_PID`. */
const projectWithCto = async () => {
  const harness = makeHarness();
  bindCeo(harness);
  const { projectId } = await registerFixtureProject(harness);
  const session = harness.cp.sessions.create({ provider: "scripted", model: "scripted-cto", osPid: BOUND_PID });
  expect(harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test cto").allowed).toBe(true);
  const bound = harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, roleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId }), projectId, sessionId: session.sessionId });
  expect(bound.allowed).toBe(true);
  return { harness, projectId, checkout: realpathSync(harness.repoPath) };
};

const reader = (others: readonly Fake[], fails = false): CtoProcessReader => {
  const rows: CtoProcess[] = [
    { pid: process.pid, ppid: 1, uid, startedAt: STARTED, command: "node vitest" },
    ...others.map((one) => ({ pid: one.pid, ppid: 1, uid, startedAt: STARTED, command: one.argv.join(" ") })),
  ];
  return {
    table: async () => { if (fails) throw Object.assign(new Error("ps"), { code: "ETIMEDOUT" }); return rows; },
    argv: (pid) => others.find((one) => one.pid === pid)?.argv ?? ["node", "vitest"],
    cwds: async (pids) => new Map(others.filter((one) => pids.includes(one.pid) && one.cwd !== undefined).map((one) => [one.pid, one.cwd!])),
    tmuxPanes: async () => new Map(),
    alive: (pid) => rows.some((row) => row.pid === pid),
    startToken: () => null,
  };
};

const findings = async (harness: Awaited<ReturnType<typeof projectWithCto>>["harness"], scope: "system" | "project" = "system") =>
  (await harness.cp.doctor.run(scope)).findings.filter((finding) => finding.code.startsWith("CTO_PROCESSES_"));

describe("doctor names a project that has two CTO processes", () => {
  it("reports two live claude processes that match one CTO role, the bound one and one that only sits in the checkout", async () => {
    const { harness, projectId, checkout } = await projectWithCto();
    harness.cp.doctor.useCtoProcessReader(reader([
      { pid: BOUND_PID, argv: ["claude", "--remote-control", "p CTO"], cwd: "/elsewhere" },
      { pid: 90_002, argv: ["claude"], cwd: checkout },
    ]));
    const named = await findings(harness);
    expect(named).toEqual([expect.objectContaining({ code: "CTO_PROCESSES_DUPLICATED", severity: "ERROR", scope: `project:${projectId}`, blocking: false })]);
    expect(named[0]!.observedEvidence["processes"]).toEqual([
      expect.objectContaining({ pid: BOUND_PID, matchedBy: ["bound-pid"] }),
      expect.objectContaining({ pid: 90_002, matchedBy: ["cwd"] }),
    ]);
  });

  it("says nothing for one process, and for a process of another project", async () => {
    const { harness, checkout } = await projectWithCto();
    harness.cp.doctor.useCtoProcessReader(reader([
      { pid: BOUND_PID, argv: ["claude", "--remote-control", "p CTO"], cwd: checkout },
      { pid: 90_003, argv: ["claude", "--resume", "99999999-9999-4999-8999-999999999999"], cwd: "/another/project" },
    ]));
    expect(await findings(harness)).toEqual([]);
  });

  it("reports UNKNOWN, never a duplicate and never clean, when the process table cannot be read", async () => {
    const { harness } = await projectWithCto();
    harness.cp.doctor.useCtoProcessReader(reader([], true));
    const named = await findings(harness);
    // UNKNOWN names a read that failed; it does not degrade the project's status.
    expect(named).toEqual([expect.objectContaining({ code: "CTO_PROCESSES_UNKNOWN", severity: "INFO", blocking: false, confidence: "LOW" })]);
  });

  it("is part of the project report too, so an agent asking about one project is told", async () => {
    const { harness, projectId, checkout } = await projectWithCto();
    harness.cp.doctor.useCtoProcessReader(reader([
      { pid: BOUND_PID, argv: ["claude"], cwd: checkout },
      { pid: 90_004, argv: ["claude"], cwd: checkout },
    ]));
    const report = await harness.cp.doctor.run("project", projectId);
    expect(report.findings.map((finding) => finding.code)).toContain("CTO_PROCESSES_DUPLICATED");
  });

  it("looks at every registered project's checkout, whether or not a CTO was ever bound: two claudes there before the first attach are two CTOs", async () => {
    const harness = makeHarness();
    bindCeo(harness);
    const { projectId } = await registerFixtureProject(harness);
    const checkout = realpathSync(harness.repoPath);
    expect(harness.cp.db.get(`SELECT 1 FROM assignments WHERE project_id = ?`, [projectId])).toBeUndefined();
    harness.cp.doctor.useCtoProcessReader(reader([
      { pid: 90_010, argv: ["claude"], cwd: checkout },
      { pid: 90_011, argv: ["claude", "--model", "opus"], cwd: checkout },
    ]));
    const named = await findings(harness);
    expect(named).toEqual([expect.objectContaining({ code: "CTO_PROCESSES_DUPLICATED", scope: `project:${projectId}`, blocking: false })]);
    expect(named[0]!.observedEvidence["processes"]).toEqual([
      expect.objectContaining({ pid: 90_010, matchedBy: ["cwd"] }),
      expect.objectContaining({ pid: 90_011, matchedBy: ["cwd"] }),
    ]);
    // One claude in the checkout is not two.
    harness.cp.doctor.useCtoProcessReader(reader([{ pid: 90_010, argv: ["claude"], cwd: checkout }]));
    expect(await findings(harness)).toEqual([]);
  });

  it("reports UNKNOWN when the role's scope cannot be read, never a project with nothing to look at", async () => {
    const { harness, checkout } = await projectWithCto();
    harness.cp.doctor.useCtoProcessReader(reader([
      { pid: BOUND_PID, argv: ["claude"], cwd: checkout },
      { pid: 90_020, argv: ["claude"], cwd: checkout },
    ]));
    const all = harness.cp.db.all.bind(harness.cp.db);
    vi.spyOn(harness.cp.db, "all").mockImplementation(((sql: string, params?: unknown[]) => {
      if (/SELECT checkout_path AS path FROM repositories/.test(sql)) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      return all(sql, params);
    }) as typeof harness.cp.db.all);
    const named = await findings(harness);
    expect(named).toEqual([expect.objectContaining({ code: "CTO_PROCESSES_UNKNOWN", severity: "INFO", blocking: false, observedEvidence: { detail: "role scope: read failed (SQLITE_BUSY)" } })]);
  });
});
