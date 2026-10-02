import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlPlane } from "../../src/app/control-plane.ts";
import type * as ProcessArgv from "../../src/core/process-argv.ts";
import type * as ProcessIdentity from "../../src/core/process-identity.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { COVERAGE_REVOCATION_GRACE_MS, Daemon, recordedProcessIsRunning } from "../../src/daemon/daemon.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { ScriptedAdapter } from "../../src/runtime/scripted-adapter.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { fixtureManifest, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

/**
 * Which process the keep for an unread provider may treat as the incumbent (ACP1045-R1-01, R2-01).
 *
 * The keep holds a binding for as long as the provider stays unread, so it needs a decisive
 * identity. A native token recorded on the row, or pinned beside it, is compared exactly. A legacy
 * row that recorded only `ps` lstart is decisive only when the live native start falls in the
 * recorded lstart second and the row was written after that second ended: the recorded process
 * was alive then, so anything that later took its pid started in a later second. A row written
 * inside its process's own start second is ambiguous and is not kept; it gets the coverage hold,
 * which is unchanged and still accepts it (r-364403fc103a), and is revoked when the hold ends.
 *
 * The process reads are injected because no real process can be placed inside a chosen second or
 * millisecond. Only the pids in `ids.native`/`ids.lstart` are answered by the fakes; every other
 * pid reads the host. The lstart text is rendered in this process's local time, the zone `ps`
 * renders in and the daemon parses in, so the cases mean the same thing in every zone.
 */
const ids = vi.hoisted(() => {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  /** `ps -o lstart=` for a process that started in this epoch second, in local time. */
  const lstartOf = (epochSecond: number): string => {
    const d = new Date(epochSecond * 1000);
    return `${days[d.getDay()]} ${months[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getFullYear()}`;
  };
  // 2026-09-30T14:50:30Z and 14:50:25Z.
  const rowSecond = 1_790_779_830;
  const earlierSecond = 1_790_779_825;
  return {
    lstartOf,
    rowSecond,
    earlierSecond,
    rowWritten: "2026-09-30T14:50:30.123Z",
    pid: {
      sameMillisecondReuse: 4_194_301,
      unrecorded: 4_194_302,
      ownStartSecond: 4_194_303,
      decisive: 4_194_304,
      laterSecondReuse: 4_194_305,
      contradictoryPin: 4_194_306,
      launchRace: 4_194_307,
      provisionRace: 4_194_308,
    },
    /** The live native token each faked pid answers with; a test may change one mid-case. */
    native: new Map<number, string | null>(),
    /** The live `ps` lstart each faked pid answers with. */
    lstart: new Map<number, string | null>(),
    /**
     * A successor that takes the pid the moment its lstart has been read: the next native read
     * answers with this token. That is the window ACP1045-R3-01 found, between the lstart a row
     * records and the token pinned beside it.
     */
    successor: new Map<number, string>(),
  };
});

vi.mock("../../src/core/process-argv.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessArgv>();
  return {
    ...actual,
    readProcessStartToken: (pid: number) =>
      ids.native.has(pid) ? ids.native.get(pid)! : actual.readProcessStartToken(pid),
  };
});

vi.mock("../../src/core/process-identity.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessIdentity>();
  return {
    ...actual,
    processStartedAt: (pid: number | null | undefined) => {
      if (typeof pid !== "number" || !ids.lstart.has(pid)) return actual.processStartedAt(pid);
      const lstart = ids.lstart.get(pid)!;
      const successor = ids.successor.get(pid);
      if (successor !== undefined) {
        ids.native.set(pid, successor);
        ids.successor.delete(pid);
      }
      return lstart;
    },
  };
});

const planes: ControlPlane[] = [];
afterEach(() => {
  for (const cp of planes.splice(0)) cp.close();
  ids.native.clear();
  ids.lstart.clear();
  ids.successor.clear();
  cleanupTempDirs();
});

/**
 * One project whose primary CTO is bound to a READY session, written at `ids.rowWritten` with the
 * given recorded start, and no provider with a reading.
 */
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
  return { cp, clock, daemon, roleKey, incumbent: bound.value, session: cp.sessions.require(session.sessionId), held };
};

const kept = (roleKey: string) => [{ roleKey, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE }];
const notKept = (roleKey: string) => [{ roleKey, reasonCode: ReasonCode.COVERAGE_NONE }];

describe("the keep for an unread provider needs a decisive identity for the incumbent", () => {
  it("does not keep a reused pid whose replacement started later inside the row's millisecond", async () => {
    // ACP1045-R1-01's witness. The row was written inside its process's start second, and a
    // replacement took the pid 900 µs into the row's own millisecond: same second, same lstart.
    const pid = ids.pid.sameMillisecondReuse;
    ids.native.set(pid, `darwin-tv:${ids.rowSecond}.123900`);
    ids.lstart.set(pid, ids.lstartOf(ids.rowSecond));
    const fixture = incumbentWithoutReading(pid, ids.lstartOf(ids.rowSecond));
    expect(fixture.session).toMatchObject({ createdAt: ids.rowWritten, osProcessStartedAt: ids.lstartOf(ids.rowSecond) });
    expect(fixture.cp.capacity.current("claude")).toBeNull();
    // The premise: this is the input the hold's millisecond test cannot tell from the incumbent.
    expect(recordedProcessIsRunning(fixture.session)).toBe(true);

    const first = await fixture.daemon.reconcileContinuity("no reading, and a reused pid");

    expect(first?.unresolved).toEqual(notKept(fixture.roleKey));
    // The finite hold is unchanged: it still accepts this record, and it still ends.
    expect(fixture.held()).toBe(1);
    expect(fixture.cp.bindings.active(fixture.roleKey)).not.toBeNull();
    expect(fixture.cp.sessions.pinnedNativeStart(fixture.session.sessionId)).toBeNull();

    fixture.clock.advance(COVERAGE_REVOCATION_GRACE_MS + 1_000);
    await fixture.daemon.reconcileContinuity("still no reading, past the hold window");

    expect(fixture.cp.bindings.active(fixture.roleKey)).toBeNull();
  });

  it("does not keep the recorded process itself when its row was written inside its start second", async () => {
    // The ambiguous case without a successor: the live process is the recorded one, but nothing on
    // the row can show it, because a successor in the same second would look the same.
    const pid = ids.pid.ownStartSecond;
    ids.native.set(pid, `darwin-tv:${ids.rowSecond}.050000`);
    ids.lstart.set(pid, ids.lstartOf(ids.rowSecond));
    const fixture = incumbentWithoutReading(pid, ids.lstartOf(ids.rowSecond));

    const report = await fixture.daemon.reconcileContinuity("no reading, row inside the start second");

    expect(report?.unresolved).toEqual(notKept(fixture.roleKey));
    expect(fixture.held()).toBe(1);
    expect(fixture.cp.sessions.pinnedNativeStart(fixture.session.sessionId)).toBeNull();
  });

  it("keeps a legacy lstart row written after its process's start second, pins the token, then compares the pin", async () => {
    // ACP1045-R2-01's replay: a stable native token in 14:50:25, the row written at 14:50:30.123.
    const pid = ids.pid.decisive;
    const token = `darwin-tv:${ids.earlierSecond}.000001`;
    ids.native.set(pid, token);
    ids.lstart.set(pid, ids.lstartOf(ids.earlierSecond));
    const fixture = incumbentWithoutReading(pid, ids.lstartOf(ids.earlierSecond));

    const first = await fixture.daemon.reconcileContinuity("no reading, decisive legacy row");
    fixture.clock.advance(COVERAGE_REVOCATION_GRACE_MS + 1_000);
    const later = await fixture.daemon.reconcileContinuity("still no reading, past the hold window");

    expect(first?.unresolved).toEqual(kept(fixture.roleKey));
    expect(later?.unresolved).toEqual(kept(fixture.roleKey));
    expect(fixture.cp.bindings.active(fixture.roleKey)).toEqual(fixture.incumbent);
    expect(fixture.held()).toBe(0);
    // The lstart column is left as written; the exact token is pinned beside it.
    expect(fixture.cp.sessions.require(fixture.session.sessionId).osProcessStartedAt).toBe(ids.lstartOf(ids.earlierSecond));
    expect(fixture.cp.sessions.pinnedNativeStart(fixture.session.sessionId)).toBe(token);

    // A successor inside the same second has the same lstart and would pass the legacy rule. The
    // pin is what refuses it.
    ids.native.set(pid, `darwin-tv:${ids.earlierSecond}.000900`);
    const replaced = await fixture.daemon.reconcileContinuity("same lstart, different process");

    expect(replaced?.unresolved).toEqual(notKept(fixture.roleKey));
  });

  it("does not keep a reused pid that started in a later second than the recorded one", async () => {
    const pid = ids.pid.laterSecondReuse;
    ids.native.set(pid, `darwin-tv:${ids.rowSecond}.200000`);
    ids.lstart.set(pid, ids.lstartOf(ids.rowSecond));
    const fixture = incumbentWithoutReading(pid, ids.lstartOf(ids.earlierSecond));

    const report = await fixture.daemon.reconcileContinuity("no reading, a later process on the pid");

    expect(report?.unresolved).toEqual(notKept(fixture.roleKey));
    // Not the recorded process at all, so not held either: revoked at once, as before.
    expect(fixture.held()).toBe(0);
    expect(fixture.cp.bindings.active(fixture.roleKey)).toBeNull();
  });

  it("does not keep an incumbent whose start token was never recorded", async () => {
    const pid = ids.pid.unrecorded;
    ids.native.set(pid, null);
    ids.lstart.set(pid, null);
    const fixture = incumbentWithoutReading(pid, null);
    expect(fixture.session.osProcessStartedAt).toBeNull();

    const report = await fixture.daemon.reconcileContinuity("no reading, and no recorded start");

    expect(report?.unresolved).toEqual(notKept(fixture.roleKey));
    expect(fixture.cp.bindings.active(fixture.roleKey)).toBeNull();
  });
});

describe("ACP1045-R3-01: a pin names the process whose lstart its row records", () => {
  /** [label, the launched process's token, the second it started in, the successor's token]. */
  const races = [
    ["a later second", `darwin-tv:${ids.earlierSecond}.000001`, ids.earlierSecond, `darwin-tv:${ids.rowSecond + 1}.000001`],
    ["the same second", `darwin-tv:${ids.rowSecond}.050000`, ids.rowSecond, `darwin-tv:${ids.rowSecond}.900000`],
  ] as const;

  const raceOn = (pid: number, original: string, second: number, successor: string) => {
    ids.native.set(pid, original);
    ids.lstart.set(pid, ids.lstartOf(second));
    ids.successor.set(pid, successor);
  };

  it.each(races)("does not pin a launched CTO whose pid a successor took in %s", async (_label, original, second, successor) => {
    const pid = ids.pid.launchRace;
    raceOn(pid, original, second, successor);
    const harness = makeHarness();
    const start = harness.scripted.startSession.bind(harness.scripted);
    harness.scripted.startSession = async (spec) => ({ ...(await start(spec)), pid });
    const { projectId } = await registerFixtureProject(harness);

    const bound = await harness.cp.cto.ensurePrimaryCto(projectId, "a successor takes the pid mid-registration");
    if (!bound.allowed) throw new Error(bound.message);

    const session = harness.cp.sessions.require(bound.value.sessionId);
    expect(session.osProcessStartedAt).toBe(ids.lstartOf(second));
    // The premise: the successor holds the pid by the time anything could pin it.
    expect(ids.native.get(pid)).toBe(successor);
    expect(harness.cp.sessions.pinnedNativeStart(session.sessionId)).toBeNull();
  });

  it.each(races)("does not pin a provisioned session whose pid a successor took in %s", async (_label, original, second, successor) => {
    const pid = ids.pid.provisionRace;
    raceOn(pid, original, second, successor);
    const root = tempDir("acp-provision-race-");
    const clock = new ManualClock(ids.rowWritten);
    class ProductionTestAdapter extends ScriptedAdapter {
      override readonly isProduction = true;
    }
    const gpt = new ProductionTestAdapter(clock, "gpt");
    const start = gpt.startSession.bind(gpt);
    gpt.startSession = async (spec) => ({ ...(await start(spec)), pid });
    const cp = new ControlPlane({
      databasePath: join(root, "state.sqlite"),
      worktreeRoot: join(root, "worktrees"),
      capacityDir: join(root, "capacity"),
      secretsDir: join(root, "secrets"),
      clock,
      adapters: [gpt],
      capacity: { exhaustedPercent: 2 },
      allowTestEvidenceWriters: true,
    });
    planes.push(cp);
    const projectId = "provision-race";
    const manifest = fixtureManifest(projectId);
    const project = cp.projects.register({
      projectId, name: "Provision race", manifest, authorization: cp.manifestAuthorizationForTests(manifest),
    });
    if (!project.allowed) throw new Error(project.message);
    // An incumbent with no recorded process cannot be kept, so the pass fails it over to gpt.
    const incumbent = cp.sessions.create({ provider: "claude", model: "opus" });
    expect(cp.sessions.transition(incumbent.sessionId, SessionLifecycle.READY, "incumbent ready").allowed).toBe(true);
    expect(cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: incumbent.sessionId }).allowed).toBe(true);
    cp.continuity.attach({
      readiness: { checkSession: async () => allow(ReasonCode.OK, undefined) },
      buzz: { connect: async (sessionId) => allow(ReasonCode.OK, `buzz:${sessionId}`) },
    });
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });

    const report = await new Daemon(cp, { stateDir: join(root, "daemon") }).reconcileContinuity("provision under a race");

    expect(report?.reassigned).toHaveLength(1);
    const provisioned = cp.sessions.require(cp.bindings.active(roleKey)!.sessionId);
    expect(provisioned).toMatchObject({ provider: "gpt", osPid: pid, osProcessStartedAt: ids.lstartOf(second) });
    expect(ids.native.get(pid)).toBe(successor);
    expect(cp.sessions.pinnedNativeStart(provisioned.sessionId)).toBeNull();
  });

  it("pins the launched CTO's token when the process holds its pid through registration", async () => {
    const pid = ids.pid.launchRace;
    const token = `darwin-tv:${ids.earlierSecond}.000001`;
    ids.native.set(pid, token);
    ids.lstart.set(pid, ids.lstartOf(ids.earlierSecond));
    const harness = makeHarness();
    const start = harness.scripted.startSession.bind(harness.scripted);
    harness.scripted.startSession = async (spec) => ({ ...(await start(spec)), pid });
    const { projectId } = await registerFixtureProject(harness);

    const bound = await harness.cp.cto.ensurePrimaryCto(projectId, "a stable process");
    if (!bound.allowed) throw new Error(bound.message);

    expect(harness.cp.sessions.pinnedNativeStart(bound.value.sessionId)).toBe(token);
  });

  it("does not pin a launched CTO when the lstart it reads names another second than its token", async () => {
    // Both native reads agree, but the text does not describe that start: an lstart rendered in
    // another zone reads this way. The row and a pin would then name different seconds.
    const pid = ids.pid.launchRace;
    ids.native.set(pid, `darwin-tv:${ids.earlierSecond}.000001`);
    ids.lstart.set(pid, ids.lstartOf(ids.rowSecond + 1));
    const harness = makeHarness();
    const start = harness.scripted.startSession.bind(harness.scripted);
    harness.scripted.startSession = async (spec) => ({ ...(await start(spec)), pid });
    const { projectId } = await registerFixtureProject(harness);

    const bound = await harness.cp.cto.ensurePrimaryCto(projectId, "a token outside the lstart's second");
    if (!bound.allowed) throw new Error(bound.message);

    expect(harness.cp.sessions.pinnedNativeStart(bound.value.sessionId)).toBeNull();
  });

  it("does not keep an lstart row whose pin contradicts its recorded second", async () => {
    // A pin for a successor beside the original's lstart: what the first writer could leave.
    const pid = ids.pid.contradictoryPin;
    const successor = `darwin-tv:${ids.rowSecond + 1}.000001`;
    ids.native.set(pid, successor);
    ids.lstart.set(pid, ids.lstartOf(ids.rowSecond + 1));
    const fixture = incumbentWithoutReading(pid, ids.lstartOf(ids.earlierSecond));
    fixture.cp.sessions.pinNativeStart(fixture.session.sessionId, successor);

    const report = await fixture.daemon.reconcileContinuity("no reading, and a pin for another process");

    expect(report?.unresolved).toEqual(notKept(fixture.roleKey));
    expect(fixture.cp.bindings.active(fixture.roleKey)).toBeNull();
  });
});
