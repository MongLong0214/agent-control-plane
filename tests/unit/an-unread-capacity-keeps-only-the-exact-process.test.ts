import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlPlane } from "../../src/app/control-plane.ts";
import type * as ProcessArgv from "../../src/core/process-argv.ts";
import type * as ProcessIdentity from "../../src/core/process-identity.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { COVERAGE_REVOCATION_GRACE_MS, Daemon, recordedProcessIsRunning } from "../../src/daemon/daemon.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { fixtureManifest } from "../helpers/harness.ts";

/**
 * ACP1045-R1-01 — a reused pid must not satisfy the indefinite keep for an unread provider.
 *
 * The keep holds a binding for as long as the provider stays unread, so it may rest only on an
 * exact identity. The coverage hold's process test is not one: an lstart record is whole-second
 * text, and its native fallback compares at the millisecond `createdAt` is truncated to, so a
 * replacement that took the pid later inside the row's own millisecond passes it
 * (r-364403fc103a). That is an accepted limit for a hold that ends; it is not one for a keep that
 * does not.
 *
 * The process reads are injected because no real process can be placed inside a chosen
 * millisecond. Only the two pids below are answered by the fakes; every other pid reads the host.
 */
const ids = vi.hoisted(() => ({
  reusedPid: 4_194_301,
  unrecordedPid: 4_194_302,
  rowWritten: "2026-09-30T14:50:30.123Z",
  lstart: "Wed Sep 30 23:50:30 2026",
  // 900 µs into the row's millisecond: later than the process the row was written for, which had
  // to exit first, and inside the same whole second and the same truncated millisecond.
  replacement: "darwin-tv:1790779830.123900",
}));

vi.mock("../../src/core/process-argv.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessArgv>();
  return {
    ...actual,
    readProcessStartToken: (pid: number) =>
      pid === ids.reusedPid ? ids.replacement : pid === ids.unrecordedPid ? null : actual.readProcessStartToken(pid),
  };
});

vi.mock("../../src/core/process-identity.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessIdentity>();
  return {
    ...actual,
    processStartedAt: (pid: number | null | undefined) =>
      pid === ids.reusedPid ? ids.lstart : pid === ids.unrecordedPid ? null : actual.processStartedAt(pid),
  };
});

const planes: ControlPlane[] = [];
afterEach(() => {
  for (const cp of planes.splice(0)) cp.close();
  cleanupTempDirs();
});

/** One project whose primary CTO is bound to a READY session, and no provider with a reading. */
const incumbentWithoutReading = (osPid: number, osStartedAt: string | null) => {
  const root = tempDir("acp-exact-process-");
  const clock = new ManualClock(ids.rowWritten);
  const cp = new ControlPlane({
    databasePath: join(root, "state.sqlite"),
    worktreeRoot: join(root, "worktrees"),
    capacityDir: join(root, "capacity"),
    secretsDir: join(root, "secrets"),
    clock,
    adapters: [],
    capacity: { exhaustedPercent: 2 },
    allowTestEvidenceWriters: true,
  });
  planes.push(cp);
  const projectId = "exact-process";
  const manifest = fixtureManifest(projectId);
  const project = cp.projects.register({
    projectId,
    name: "Exact process regression",
    manifest,
    authorization: cp.manifestAuthorizationForTests(manifest),
  });
  if (!project.allowed) throw new Error(project.message);
  const session = cp.sessions.create({ provider: "claude", model: "opus", osPid, osStartedAt });
  const ready = cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "incumbent ready");
  if (!ready.allowed) throw new Error(ready.message);
  const bound = cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: session.sessionId });
  if (!bound.allowed) throw new Error(bound.message);
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
  const daemon = new Daemon(cp, { stateDir: join(root, "daemon") });
  const held = () =>
    cp.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'CONTINUITY_REVOCATION_HELD' AND role_key = ?`,
      [roleKey],
    )?.n;
  return { cp, clock, daemon, roleKey, session: cp.sessions.require(session.sessionId), held };
};

describe("ACP1045-R1-01: the keep for an unread provider needs the exact process", () => {
  it("does not keep a reused pid whose replacement started later inside the row's millisecond", async () => {
    const fixture = incumbentWithoutReading(ids.reusedPid, ids.lstart);
    expect(fixture.session).toMatchObject({ createdAt: ids.rowWritten, osProcessStartedAt: ids.lstart });
    expect(fixture.cp.capacity.current("claude")).toBeNull();
    // The premise: this is the input the hold's millisecond test cannot tell from the incumbent.
    expect(recordedProcessIsRunning(fixture.session)).toBe(true);

    const first = await fixture.daemon.reconcileContinuity("no reading, and a reused pid");

    expect(first?.unresolved).toEqual([{ roleKey: fixture.roleKey, reasonCode: ReasonCode.COVERAGE_NONE }]);
    // The finite hold is unchanged: it still accepts this record, and it still ends.
    expect(fixture.held()).toBe(1);
    expect(fixture.cp.bindings.active(fixture.roleKey)).not.toBeNull();

    fixture.clock.advance(COVERAGE_REVOCATION_GRACE_MS + 1_000);
    await fixture.daemon.reconcileContinuity("still no reading, past the hold window");

    expect(fixture.cp.bindings.active(fixture.roleKey)).toBeNull();
  });

  it("does not keep an incumbent whose start token was never recorded", async () => {
    const fixture = incumbentWithoutReading(ids.unrecordedPid, null);
    expect(fixture.session.osProcessStartedAt).toBeNull();

    const report = await fixture.daemon.reconcileContinuity("no reading, and no recorded start");

    expect(report?.unresolved).toEqual([{ roleKey: fixture.roleKey, reasonCode: ReasonCode.COVERAGE_NONE }]);
    expect(fixture.cp.bindings.active(fixture.roleKey)).toBeNull();
  });
});
