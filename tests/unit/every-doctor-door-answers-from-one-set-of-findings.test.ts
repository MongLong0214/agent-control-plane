import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startDaemonMcpListeners } from "../../src/daemon/agentcpd.ts";
import { Daemon, OPERATOR_METHOD, type AuthenticatedOperatorPeer } from "../../src/daemon/daemon.ts";
import type { DoctorReport, Finding } from "../../src/doctor/doctor.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { WAKE_TRANSPORT_QUALIFIED_CLIENTS } from "../../src/mcp/role-conversation.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { fixtureManifest, makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * Every door that answers "is the system healthy" answers from the same set of findings.
 *
 * The daemon's own status paths carried the unwakeable-binding finding and the two MCP `doctor_run`
 * tools did not: their ports call `cp.doctor.run(scope, target)` with no third argument, so an agent
 * asking the door agents actually use could be told `HEALTHY` while a binding it holds was
 * unwakeable and the wake it was waiting for was being stored rather than delivered (#1010).
 *
 * The repair is a supplier registered on the `Doctor` itself, so a door cannot forget what it never
 * has to remember. These rows ask through the doors, over the real sockets, with the production
 * listener composition — `startDaemonMcpListeners`, which is the call `main` makes. A row that
 * called `Doctor.run` with hand-made findings would measure the merge and not the wiring, and
 * deleting the registration would leave it green.
 */

const TOKEN = "one-set-of-findings-token";
const CODE = "ROLE_BINDING_CANNOT_RECEIVE_WAKES";

const PEER: AuthenticatedOperatorPeer = {
  channel: "cli",
  peerId: "cli:fixture-operator",
  actor: "fixture-operator",
  incarnation: "incarnation-1",
};

/** A build outside the committed set, derived from a member so it can never become one by a move. */
const NOT_A_MEMBER = {
  name: WAKE_TRANSPORT_QUALIFIED_CLIENTS[0].name,
  version: `${WAKE_TRANSPORT_QUALIFIED_CLIENTS[0].version}.9999-not-a-member`,
};

const MEMBER = { ...WAKE_TRANSPORT_QUALIFIED_CLIENTS[0] };

const valueOf = <T>(decision: Decision<T>): T => {
  if (!decision.allowed) throw new Error(JSON.stringify(decision));
  return decision.value;
};

/** The `ok(...)` envelope, as a peer reads it back off the wire. */
interface ToolBody {
  ok?: boolean;
  reasonCode?: string;
  message?: string;
  value?: unknown;
}

/**
 * One MCP peer on a real listener socket, through `initialize` — the point at which its build is
 * declared, and the point after which the connection is a live peer of the port that admitted it.
 */
const initializedPeer = async (
  socketPath: string,
  handshake: { token: string; sessionId: string; sessionSecret: string },
  clientInfo: { name: string; version: string },
): Promise<Socket> => {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const initialized = new Promise<void>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("no initialize response")), 10_000);
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, newline)) as { id?: number; ok?: boolean; error?: unknown };
        buffer = buffer.slice(newline + 1);
        if (message.ok === false || message.error !== undefined) {
          clearTimeout(timer);
          reject(new Error(JSON.stringify(message)));
        } else if (message.id === 1) {
          clearTimeout(timer);
          resolve();
        }
      }
    });
  });
  socket.write(`${JSON.stringify(handshake)}\n`);
  socket.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo },
  })}\n`);
  await initialized;
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return socket;
};

/**
 * One tool call on an already-initialized peer socket, answered with the body the tool put in it.
 *
 * The budget is generous because a `system` scope really does run every probe the doctor has; what
 * the rows are about is what the answer contains, not how fast it arrives.
 */
const callTool = async (socket: Socket, name: string, args: Record<string, unknown>): Promise<ToolBody> => {
  const id = 1_000 + Math.floor(Math.random() * 1_000_000);
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`no response to ${name}`)), 60_000);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: { id?: number; result?: { structuredContent?: ToolBody } };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.id !== id) continue;
        clearTimeout(timer);
        socket.off("data", onData);
        resolve(message.result?.structuredContent ?? { ok: false });
      }
    };
    socket.on("data", onData);
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
  });
};

const readySession = (harness: ReturnType<typeof makeHarness>, model: string) => {
  const session = harness.cp.sessions.create({ provider: "scripted", model });
  expect(harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "MCP peer").reasonCode)
    .toBe(ReasonCode.OK);
  if (!session.sessionSecret) throw new Error("test peer needs a session secret");
  return { sessionId: session.sessionId, sessionSecret: session.sessionSecret };
};

const unwakeableIn = (report: DoctorReport): Finding[] =>
  report.findings.filter((finding) => finding.code === CODE);

/**
 * A started daemon with the production listener composition, a CTO holder connected on a build the
 * wake transport was never qualified on, and a CEO holder connected beside it.
 *
 * The CTO holder is the unwakeable one: `registerEndpoint` refuses a peer whose declared build is
 * outside the set, and a binding with no registered endpoint gets no wakes. The CEO holder exists
 * only so the Hermes socket — which admits `Role.CEO` and nothing else — has an authenticated peer
 * to ask through, and it declares a member build so the deployment has exactly one unwakeable
 * holder and a count is a claim about the CTO one.
 */
const deploymentWithOneUnwakeableHolder = async (label: string) => {
  const harness = makeHarness();
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  const manifest = fixtureManifest(`one-set-${label}`);
  valueOf(harness.cp.projects.register({
    projectId: manifest.projectId, name: "fixture", manifest,
    authorization: harness.cp.manifestAuthorizationForTests(manifest),
  }));
  const cto = readySession(harness, "cto-peer");
  const ceo = readySession(harness, "ceo-peer");
  valueOf(harness.cp.bindings.bind({
    role: Role.PRIMARY_CTO, projectId: manifest.projectId, sessionId: cto.sessionId,
  }));
  valueOf(harness.cp.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId }));
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: manifest.projectId });

  const stateDir = tempDir(`acp-one-set-${label}-`);
  // The directory a wake endpoint would be registered in has to be owner-only before the daemon
  // accepts anything inside it, and it is the same directory the two MCP sockets live in.
  chmodSync(stateDir, 0o700);
  const daemon = new Daemon(harness.cp, { stateDir });
  expect((await daemon.start()).allowed).toBe(true);
  // The production composition: the call `main` makes, which is also what hands the CTO port to the
  // daemon's report. A test that installed the port itself would measure the port, not the wiring.
  const listeners = await startDaemonMcpListeners(harness.cp, stateDir, TOKEN, daemon);
  const [hermesPath, ctoPath] = listeners.socketPaths;
  if (!hermesPath || !ctoPath) throw new Error("the MCP listeners were not started");
  const ctoPeer = await initializedPeer(ctoPath, { token: TOKEN, ...cto }, NOT_A_MEMBER);
  const ceoPeer = await initializedPeer(hermesPath, { token: TOKEN, ...ceo }, MEMBER);

  /** The peers and the listeners, and not the daemon — what a handover closes before it stops. */
  const closeDoors = async (): Promise<void> => {
    ctoPeer.destroy();
    ceoPeer.destroy();
    await listeners.close();
  };
  const close = async (): Promise<void> => {
    await closeDoors();
    await daemon.stop();
  };
  return { harness, daemon, roleKey, stateDir, cto, ctoPeer, ceoPeer, closeDoors, close };
};

describe("every door that answers whether the system is healthy answers from one set of findings", () => {
  it("does not tell an agent on the CTO MCP door HEALTHY while a connected holder is unwakeable", async () => {
    const { roleKey, ctoPeer, close } = await deploymentWithOneUnwakeableHolder("cto-door");
    try {
      const body = await callTool(ctoPeer, "doctor_run", { scope: "system" });
      expect(body.ok, body.message).toBe(true);
      const report = body.value as DoctorReport;

      // The assertion #1010 names. `HEALTHY` is what this door used to answer with a holder in
      // exactly this state, because the finding was never in the set it drew from.
      expect(report.status).not.toBe("HEALTHY");
      const unwakeable = unwakeableIn(report);
      expect(unwakeable, "the CTO door's report carries no unwakeable-binding finding").toHaveLength(1);
      expect(unwakeable[0]?.observedEvidence).toMatchObject({
        roleKey,
        role: Role.PRIMARY_CTO,
        presentedClient: `${NOT_A_MEMBER.name}/${NOT_A_MEMBER.version}`,
        cause: "build-outside-the-qualified-set",
      });
      expect(unwakeable[0]?.recommendedAction).toContain("cannot receive wakes");
    } finally {
      await close();
    }
  }, 180_000);

  it("does not tell a caller on the Hermes MCP door HEALTHY while a connected holder is unwakeable", async () => {
    const { roleKey, ceoPeer, close } = await deploymentWithOneUnwakeableHolder("hermes-door");
    try {
      const body = await callTool(ceoPeer, "doctor_run", { scope: "system" });
      expect(body.ok, body.message).toBe(true);
      const report = body.value as DoctorReport;

      expect(report.status).not.toBe("HEALTHY");
      const unwakeable = unwakeableIn(report);
      expect(unwakeable, "the Hermes door's report carries no unwakeable-binding finding").toHaveLength(1);
      expect(unwakeable[0]?.observedEvidence).toMatchObject({
        roleKey,
        role: Role.PRIMARY_CTO,
        presentedClient: `${NOT_A_MEMBER.name}/${NOT_A_MEMBER.version}`,
        cause: "build-outside-the-qualified-set",
      });
    } finally {
      await close();
    }
  }, 180_000);

  it("reports each finding once on the daemon's own system path, and once through a door", async () => {
    // The doubling this rules out is the natural way to write the repair: leave the daemon's
    // explicit third argument in place *and* register the supplier, so the one holder is reported
    // twice to the operator and once to an agent. A count, not a presence check, is what sees it.
    const { daemon, ctoPeer, roleKey, close } = await deploymentWithOneUnwakeableHolder("no-doubles");
    try {
      const response = await daemon.handleOperatorRequest(
        { requestId: "doctor-no-doubles", method: OPERATOR_METHOD.DOCTOR_RUN, params: { scope: "system" } },
        PEER,
      );
      expect(response.allowed).toBe(true);
      const operatorReport = (response as { value: DoctorReport }).value;
      expect(unwakeableIn(operatorReport)).toHaveLength(1);
      expect(unwakeableIn(operatorReport)[0]?.observedEvidence).toMatchObject({ roleKey });

      // The same deployment, the same holder, asked through the door an agent uses: one finding
      // there too. Two doors reporting different *counts* for one holder is the same defect as two
      // doors reporting different statuses.
      const body = await callTool(ctoPeer, "doctor_run", { scope: "system" });
      expect(body.ok, body.message).toBe(true);
      expect(unwakeableIn(body.value as DoctorReport)).toHaveLength(1);
    } finally {
      await close();
    }
  }, 180_000);

  it("leaves a non-system scope out of it, at the door and at the operator socket alike", async () => {
    // The scope rule has one home now — the supplier the daemon registers. This is the row that
    // says so: the finding is about the deployment, and a `run` scope is answering about one run.
    // A supplier that ignored its scope argument would put a system finding in both of these.
    const { daemon, ctoPeer, close } = await deploymentWithOneUnwakeableHolder("scoped");
    try {
      const body = await callTool(ctoPeer, "doctor_run", { scope: "run" });
      expect(body.ok, body.message).toBe(true);
      expect(unwakeableIn(body.value as DoctorReport)).toHaveLength(0);

      const response = await daemon.handleOperatorRequest(
        { requestId: "doctor-scoped", method: OPERATOR_METHOD.DOCTOR_RUN, params: { scope: "run" } },
        PEER,
      );
      expect(response.allowed).toBe(true);
      expect(unwakeableIn((response as { value: DoctorReport }).value)).toHaveLength(0);
    } finally {
      await close();
    }
  }, 180_000);
});

/**
 * One automatic refresh — `reconcileContinuity`, the pass the capacity timer drives — and the report
 * it audited and persisted.
 *
 * `health.json` carries the status and no findings, so the findings are read from the one
 * `DOCTOR_REPORT` row the pass audited, and that row's status is tied to the persisted one so a row
 * from some other pass cannot stand in for it. The same reading the wake-transport rows take.
 */
const refreshedAutomatically = async (
  harness: ReturnType<typeof makeHarness>,
  daemon: Daemon,
  stateDir: string,
  label: string,
): Promise<{ persistedStatus: string | undefined; unwakeable: { code: string; observedEvidence?: unknown }[] }> => {
  const auditedBefore = harness.cp.audit.byKind("DOCTOR_REPORT").length;
  harness.clock.advance(10_000);
  await daemon.reconcileContinuity(`one-set test: an automatic refresh after ${label}`);
  const health = JSON.parse(readFileSync(join(stateDir, "health.json"), "utf8")) as {
    doctor?: { status: string; checkedAt: string | null };
  };
  expect(health.doctor?.checkedAt).toBe(harness.clock.nowIso());
  const audited = harness.cp.audit.byKind("DOCTOR_REPORT").slice(auditedBefore);
  expect(audited).toHaveLength(1);
  const report = audited[0]?.evidence as {
    scope?: string;
    status?: string;
    findings?: { code: string; observedEvidence?: unknown }[];
  };
  expect(report.scope).toBe("system");
  expect(report.status).toBe(health.doctor?.status);
  return {
    persistedStatus: health.doctor?.status,
    unwakeable: (report.findings ?? []).filter((finding) => finding.code === CODE),
  };
};

describe("only the daemon holding the lock supplies the findings every door answers from", () => {
  it("a second daemon refused the lock leaves the live daemon's doors carrying its holder's finding", async () => {
    // The registration used to run in the constructor, before `start()` takes the lock, so a
    // second daemon over the same control plane replaced the live daemon's supplier whether or not
    // it was then refused. It has no wake peers of its own, so from then on the live daemon's
    // doors answered from a set with none of its holders in it — `HEALTHY`, with this one
    // unwakeable.
    const { harness, daemon, roleKey, stateDir, ctoPeer, close } =
      await deploymentWithOneUnwakeableHolder("refused-second");
    try {
      // A competing instance, the way CP-S59 makes one in a single process: a live pid that is not
      // this one holds the lock file.
      writeFileSync(
        join(stateDir, "agentcpd.lock"),
        JSON.stringify({ pid: process.ppid, startedAt: harness.clock.nowIso(), path: "x" }),
      );
      const second = new Daemon(harness.cp, { stateDir });
      const refused = await second.start();
      expect(refused.allowed).toBe(false);
      expect(refused.reasonCode).toBe(ReasonCode.DAEMON_ALREADY_RUNNING);
      // What `main`'s shutdown handler does to a daemon whose start was refused: it is installed
      // before `start()` and calls `stop()` on a signal during the backoff wait. A refused daemon
      // registered nothing, so its stop must remove nothing either.
      await second.stop();

      // The door an agent asks, on the live daemon's own listener.
      const body = await callTool(ctoPeer, "doctor_run", { scope: "system" });
      expect(body.ok, body.message).toBe(true);
      const report = body.value as DoctorReport;
      expect(report.status).not.toBe("HEALTHY");
      const unwakeable = unwakeableIn(report);
      expect(unwakeable, "the live daemon's CTO door lost its holder's finding to a refused daemon")
        .toHaveLength(1);
      expect(unwakeable[0]?.observedEvidence).toMatchObject({ roleKey, role: Role.PRIMARY_CTO });

      // And the live daemon's automatic refresh, which is what reaches `health.json`.
      const refreshed = await refreshedAutomatically(harness, daemon, stateDir, "a refused second daemon");
      expect(refreshed.unwakeable, "the live daemon's persisted evaluation lost its holder's finding")
        .toHaveLength(1);
      expect(refreshed.persistedStatus).not.toBe("HEALTHY");
    } finally {
      await close();
    }
  }, 180_000);

  it("a successor that starts after its predecessor stops is the one the doors answer from", async () => {
    // A handover within one control plane: the predecessor closes its doors and stops, which
    // releases the lock and removes its own supplier; the successor then takes the lock and
    // registers. The predecessor's port has no peers left, so a holder's finding can only come
    // from the successor's supplier — a successor that never registered, or whose supplier the
    // predecessor's stop removed, would answer with none.
    const first = await deploymentWithOneUnwakeableHolder("handover");
    await first.closeDoors();
    await first.daemon.stop();

    const successor = new Daemon(first.harness.cp, { stateDir: first.stateDir });
    expect((await successor.start()).allowed).toBe(true);
    const listeners = await startDaemonMcpListeners(first.harness.cp, first.stateDir, TOKEN, successor);
    const [, ctoPath] = listeners.socketPaths;
    if (!ctoPath) throw new Error("the successor's MCP listeners were not started");
    const ctoPeer = await initializedPeer(ctoPath, { token: TOKEN, ...first.cto }, NOT_A_MEMBER);
    try {
      const body = await callTool(ctoPeer, "doctor_run", { scope: "system" });
      expect(body.ok, body.message).toBe(true);
      const unwakeable = unwakeableIn(body.value as DoctorReport);
      expect(unwakeable, "the successor's CTO door carries no finding for its holder").toHaveLength(1);
      expect(unwakeable[0]?.observedEvidence).toMatchObject({ roleKey: first.roleKey });

      const refreshed = await refreshedAutomatically(first.harness, successor, first.stateDir, "a handover");
      expect(refreshed.unwakeable, "the successor's persisted evaluation carries no finding for its holder")
        .toHaveLength(1);
    } finally {
      ctoPeer.destroy();
      await listeners.close();
      await successor.stop();
    }
  }, 180_000);
});
