import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  BOOTSTRAP_OPERATOR_METHODS,
  canParkForBootstrap,
  Daemon,
  OPERATOR_METHOD,
} from "../../src/daemon/daemon.ts";
import { createOperatorClient, dispatch, main as cliMain } from "../../src/cli/agentctl.ts";
import { startBootstrapOperatorDoor } from "../../src/daemon/agentcpd.ts";
import type { Decision } from "../../src/core/errors.ts";
import type { AuthenticatedOperatorPeer } from "../../src/daemon/daemon.ts";
import type { DoctorReport, Finding } from "../../src/doctor/doctor.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness, TEST_MCP_TOKEN, TEST_OPERATOR_TOKEN } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const PEER: AuthenticatedOperatorPeer = {
  channel: "cli",
  peerId: "cli:fixture-operator",
  actor: "fixture-operator",
  incarnation: "incarnation-1",
};

const finding = (code: string, scope: string): Finding => ({
  code,
  severity: "CRITICAL",
  scope,
  blocking: true,
  confidence: "HIGH",
  observedEvidence: {},
  recommendedAction: "record a capacity observation",
});

const COVERAGE = finding("ROLE_COVERAGE_NO_VALID_COVERAGE", "continuity");
const CREDENTIAL = finding("TRUSTED_GATE_CREDENTIAL_MISSING", "github");

const report = (status: DoctorReport["status"], findings: readonly Finding[]): DoctorReport => ({
  scope: "system",
  target: null,
  status,
  findings: [...findings],
  ranAt: "2026-08-12T00:00:00.000Z",
});

/**
 * The doctor is stubbed rather than driven into a real uncovered state: what is under test is
 * which branch `start()` takes for a given finding set, so the finding set has to be the input.
 */
const makeDaemon = (
  statuses: readonly DoctorReport[],
  delayMsByCall: readonly number[] = [],
  daemonOptions: { bootstrapRecheckIntervalMs?: number } = {},
) => {
  const harness = makeHarness();
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  let call = 0;
  const doctor = vi.spyOn(harness.cp.doctor, "run").mockImplementation(async () => {
    const index = call++;
    const delay = delayMsByCall[index] ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    return statuses[Math.min(index, statuses.length - 1)]!;
  });
  const stateDir = tempDir("acp-bootstrap-door-");
  return { harness, daemon: new Daemon(harness.cp, { stateDir, ...daemonOptions }), stateDir, doctor };
};

/** A door that records its own lifecycle: the daemon must open exactly one and close it. */
const recordingDoor = () => {
  const opened: string[] = [];
  const closed: string[] = [];
  return {
    opened,
    closed,
    open: async () => {
      opened.push("open");
      return { close: async () => void closed.push("close") };
    },
  };
};

/**
 * `agentctl` attaches `idempotencyKey: operator:<digest of method+params>` to every mutation
 * (`cli/agentctl.ts:78-80`), so a request without one is a shape production never sends. The
 * key is derived from the payload here for the same reason: re-running the same documented
 * observation file is the same key.
 */
const observe = (daemon: Daemon, remainingPercent = 90) =>
  daemon.handleOperatorRequest(
    {
      requestId: `req-observe-${remainingPercent}`,
      idempotencyKey: `operator:capacity:${remainingPercent}`,
      method: OPERATOR_METHOD.CAPACITY_OBSERVE,
      params: {
        provider: "scripted",
        payload: {
          observedAt: "2026-08-12T00:00:00.000Z",
          buckets: [
            {
              id: "fixture-window",
              remainingPercent,
              resetAt: null,
              capabilities: ["ceo", "cto", "blind-review", "worker"],
            },
          ],
        },
      },
    },
    PEER,
  );

/** One request, one response, one connection — the operator protocol as the socket serves it. */
const operatorLine = (socketPath: string, request: Record<string, unknown>): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let received = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("operator socket test timed out"));
    }, 5_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (!received.includes("\n")) return;
      clearTimeout(timeout);
      socket.end();
      resolve(JSON.parse(received.trim()) as Record<string, unknown>);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

/** Narrows a decision at the point of use so a denial fails the test rather than the compiler. */
const allowedValue = (decision: Decision<unknown>): unknown => {
  if (!decision.allowed) throw new Error(`expected an allowed decision, got ${decision.reasonCode}`);
  return decision.value;
};

const status = (daemon: Daemon) =>
  daemon.handleOperatorRequest(
    { requestId: "req-status", method: OPERATOR_METHOD.DAEMON_STATUS, params: {} },
    PEER,
  );

describe("#568: the documented capacity remedy is reachable in the state that needs it", () => {
  it("parks with the lock still held instead of releasing it and exiting", async () => {
    const { daemon } = makeDaemon([report("BLOCKED", [COVERAGE]), report("HEALTHY", [])]);
    const door = recordingDoor();

    const starting = daemon.start({ bootstrapDoor: door.open });
    // The park is only useful if the door is reachable *while* it is parked, so the assertion
    // has to happen before start() settles rather than after.
    await vi.waitFor(() => expect(door.opened).toHaveLength(1));

    expect(daemon.lock.held()).toBe(true);
    expect(allowedValue(await status(daemon))).toMatchObject({
      mode: "BOOTSTRAP",
      blockingFindings: [{ code: "ROLE_COVERAGE_NO_VALID_COVERAGE" }],
    });

    expect((await observe(daemon)).allowed).toBe(true);
    const started = await starting;
    expect(started.allowed).toBe(true);
    // Closed before promotion returns: the real operator socket binds the same path.
    expect(door.closed).toHaveLength(1);
    expect(allowedValue(await status(daemon))).toMatchObject({ mode: "NORMAL", blockingFindings: [] });
    await daemon.stop();
  });

  it("refuses every method the parked door does not exist for", async () => {
    const { daemon } = makeDaemon([report("BLOCKED", [COVERAGE])]);
    const door = recordingDoor();
    const starting = daemon.start({ bootstrapDoor: door.open });
    await vi.waitFor(() => expect(door.opened).toHaveLength(1));

    // Owner approval is the human gate and repair execution is destructive. Reaching either in
    // the state the doctor has just refused to pass is a larger loss than the door is a gain.
    for (const method of [
      OPERATOR_METHOD.OWNER_APPROVE,
      OPERATOR_METHOD.REPAIR_EXECUTE,
      OPERATOR_METHOD.RUN_CANCEL,
      OPERATOR_METHOD.ACTOR_REGISTER,
      OPERATOR_METHOD.DOCTOR_RUN,
    ]) {
      const refused = await daemon.handleOperatorRequest(
        { requestId: `req-${method}`, method, params: {} },
        PEER,
      );
      expect(refused.allowed).toBe(false);
      expect(refused.reasonCode).toBe(ReasonCode.DAEMON_BOOTSTRAP_MODE);
      expect(refused.evidence).toMatchObject({
        mode: "BOOTSTRAP",
        admittedMethods: ["capacity.observe", "daemon.status"],
      });
    }
    expect([...BOOTSTRAP_OPERATOR_METHODS].sort()).toEqual(["capacity.observe", "daemon.status"]);

    await daemon.stop();
    await starting;
  });

  it("keeps release-and-exit for a blocking finding no observation could clear", async () => {
    const { daemon } = makeDaemon([report("BLOCKED", [COVERAGE, CREDENTIAL])]);
    const door = recordingDoor();

    const started = await daemon.start({ bootstrapDoor: door.open });

    expect(started.allowed).toBe(false);
    expect(started.reasonCode).toBe(ReasonCode.DOCTOR_BLOCKED);
    expect(door.opened).toHaveLength(0);
    expect(daemon.lock.held()).toBe(false);
  });

  it("stays parked, and says so, when the reading lands but coverage is still unroutable", async () => {
    const { daemon } = makeDaemon([
      report("BLOCKED", [COVERAGE]),
      report("BLOCKED", [COVERAGE]),
      report("HEALTHY", []),
    ]);
    const door = recordingDoor();
    const starting = daemon.start({ bootstrapDoor: door.open });
    await vi.waitFor(() => expect(door.opened).toHaveLength(1));

    // A write that succeeds is not evidence that dispatch will resume: observeCapacity takes
    // runtime health from the adapter, so a reading can persist and leave the role uncovered.
    expect((await observe(daemon)).allowed).toBe(true);
    await vi.waitFor(async () =>
      expect(allowedValue(await status(daemon))).toMatchObject({
        mode: "BOOTSTRAP",
        blockingFindings: [{ code: "ROLE_COVERAGE_NO_VALID_COVERAGE" }],
      }),
    );

    expect((await observe(daemon)).allowed).toBe(true);
    expect((await starting).allowed).toBe(true);
    await daemon.stop();
  });

  it("does not spend the park's wake-up on an observation that was refused", async () => {
    const { daemon, doctor } = makeDaemon([report("BLOCKED", [COVERAGE]), report("HEALTHY", [])]);
    const door = recordingDoor();
    const starting = daemon.start({ bootstrapDoor: door.open });
    await vi.waitFor(() => expect(door.opened).toHaveLength(1));
    expect(doctor).toHaveBeenCalledTimes(1);

    const refused = await daemon.handleOperatorRequest(
      {
        requestId: "req-unknown-provider",
        method: OPERATOR_METHOD.CAPACITY_OBSERVE,
        params: { provider: "not-registered", payload: { observedAt: "2026-08-12T00:00:00.000Z", buckets: [] } },
      },
      PEER,
    );
    expect(refused.allowed).toBe(false);

    // Nothing was persisted, so nothing could have changed the doctor's mind. The re-check is
    // counted rather than raced: waking here runs a second doctor pass, and every dependency in
    // this fixture is a resolved mock, so one settled macrotask is enough for it to show up.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(doctor).toHaveBeenCalledTimes(1);

    expect((await observe(daemon)).allowed).toBe(true);
    expect((await starting).allowed).toBe(true);
    // Three, not two: the park re-checks with the doctor alone, and the startup sweep is a
    // separate pass that only runs once, on promotion.
    expect(doctor).toHaveBeenCalledTimes(3);
    await daemon.stop();
  });

  it("leaves the continuity coordinator uninstalled for as long as it is parked", async () => {
    const { harness, daemon } = makeDaemon([report("BLOCKED", [COVERAGE]), report("HEALTHY", [])]);
    // Install and uninstall both re-attach; they differ in *where* a provider failure is routed.
    // So the test drives the attached callback rather than counting attachments.
    const wired: { route: ((reason: string) => unknown) | null } = { route: null };
    vi.spyOn(harness.cp.capacity, "attach").mockImplementation((wiring) => {
      wired.route = wiring.providerFailureContinuity?.evaluate ?? wired.route;
    });
    const reconcileContinuity = vi.spyOn(daemon, "reconcileContinuity").mockResolvedValue(null);
    const door = recordingDoor();
    const starting = daemon.start({ bootstrapDoor: door.open });
    await vi.waitFor(() => expect(door.opened).toHaveLength(1));

    // A daemon that has not passed its doctor must not be moving bindings in response to
    // capacity events. start() installs the coordinator before it reconciles, so the park has
    // to take it back off rather than merely decline to add it.
    // Without this the two assertions below would both hold for a route that was never wired.
    expect(wired.route).not.toBeNull();
    await wired.route?.("while parked");
    expect(reconcileContinuity).not.toHaveBeenCalled();

    expect((await observe(daemon)).allowed).toBe(true);
    expect((await starting).allowed).toBe(true);
    await wired.route?.("after promotion");
    expect(reconcileContinuity).toHaveBeenCalledWith("after promotion");
    await daemon.stop();
  });

  it("does not park when the caller supplies no door", async () => {
    const { daemon } = makeDaemon([report("BLOCKED", [COVERAGE])]);

    const started = await daemon.start();

    expect(started.allowed).toBe(false);
    expect(started.reasonCode).toBe(ReasonCode.DOCTOR_BLOCKED);
    expect(daemon.lock.held()).toBe(false);
  });

  it("withholds the Hermes bootstrap extension from the parked door", async () => {
    const { daemon, stateDir } = makeDaemon([report("HEALTHY", [])]);
    const listener = await startBootstrapOperatorDoor(
      daemon,
      stateDir,
      { token: TEST_OPERATOR_TOKEN, peerId: "cli:fixture-operator", actor: "fixture-operator" },
      { mcpToken: TEST_MCP_TOKEN },
    );
    try {
      // bootstrap.hermes constitutes CEO, so the socket a parked daemon serves must not carry it.
      const refused = await operatorLine(listener.socketPath, {
        token: TEST_OPERATOR_TOKEN,
        requestId: "req-hermes",
        method: "bootstrap.hermes",
        params: {},
      });
      expect(refused).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.OPERATOR_METHOD_NOT_ALLOWED,
      });
    } finally {
      await listener.close();
    }
  });

  it("re-checks on a repeated observation instead of replaying a cached OK", async () => {
    const { daemon, doctor } = makeDaemon([
      report("BLOCKED", [COVERAGE]),
      report("BLOCKED", [COVERAGE]),
      report("HEALTHY", []),
    ]);
    const door = recordingDoor();
    const starting = daemon.start({ bootstrapDoor: door.open });
    await vi.waitFor(() => expect(door.opened).toHaveLength(1));

    // The same payload is the same idempotency key. Replaying the cached result would skip
    // executeOperatorRequest entirely, and with it the re-check the park is waiting for —
    // observeCapacity also re-probes runtime health, so the same payload is not the same answer.
    expect((await observe(daemon)).allowed).toBe(true);
    await vi.waitFor(() => expect(doctor).toHaveBeenCalledTimes(2));
    expect((await observe(daemon)).allowed).toBe(true);

    expect((await starting).allowed).toBe(true);
    // Two blocked re-checks, then the promoting one, then the startup sweep it triggers.
    expect(doctor).toHaveBeenCalledTimes(4);
    await daemon.stop();
  });

  it("does not lose an observation that lands while the re-check is still running", async () => {
    const { daemon } = makeDaemon(
      [report("BLOCKED", [COVERAGE]), report("BLOCKED", [COVERAGE]), report("HEALTHY", [])],
      [0, 250],
    );
    const door = recordingDoor();
    const starting = daemon.start({ bootstrapDoor: door.open });
    await vi.waitFor(() => expect(door.opened).toHaveLength(1));

    expect((await observe(daemon, 90)).allowed).toBe(true);
    // The second lands mid-re-check, when a one-shot waiter would be unarmed and the signal
    // would be delivered to nobody. Nothing else will ever arrive to unstick it.
    expect((await observe(daemon, 91)).allowed).toBe(true);

    expect((await starting).allowed).toBe(true);
    await daemon.stop();
  });

  it("settles instead of wedging when stop() lands during the re-check", async () => {
    const { daemon } = makeDaemon([report("BLOCKED", [COVERAGE]), report("BLOCKED", [COVERAGE])], [0, 250]);
    const door = recordingDoor();
    const starting = daemon.start({ bootstrapDoor: door.open });
    await vi.waitFor(() => expect(door.opened).toHaveLength(1));

    expect((await observe(daemon)).allowed).toBe(true);
    // stop() releases the lock. If the abandon is not latched, the loop sleeps again behind a
    // released lock with the door still open — a live socket that no longer implies a held lock.
    await daemon.stop();

    const started = await starting;
    expect(started.allowed).toBe(false);
    expect(door.closed).toHaveLength(1);
    expect(daemon.lock.held()).toBe(false);
  });

  it("does not promote on a re-check that finished after stop() released the lock", async () => {
    const { harness, daemon } = makeDaemon([report("BLOCKED", [COVERAGE]), report("HEALTHY", [])], [0, 250]);
    const attach = vi.spyOn(harness.cp.continuity, "attach");
    const door = recordingDoor();
    const starting = daemon.start({ bootstrapDoor: door.open });
    await vi.waitFor(() => expect(door.opened).toHaveLength(1));

    expect((await observe(daemon)).allowed).toBe(true);
    // stop() lands while the re-check that would promote is still running. Reading the latch
    // only before the re-check lets this one through: start() would resume runs and start
    // timers on a daemon whose lock stop() has already released.
    await daemon.stop();

    const started = await starting;
    expect(started.allowed).toBe(false);
    expect(daemon.lock.held()).toBe(false);
    // Exactly the one install start() does before it reconciles — promotion would add a second,
    // re-arming a coordinator that stop() has already taken down.
    expect(attach).toHaveBeenCalledTimes(1);
    expect(door.closed).toHaveLength(1);
  });

  it("does not pin a parked refusal to a key the operator retries after promotion", async () => {
    const { daemon } = makeDaemon([report("BLOCKED", [COVERAGE]), report("HEALTHY", [])]);
    const door = recordingDoor();
    const starting = daemon.start({ bootstrapDoor: door.open });
    await vi.waitFor(() => expect(door.opened).toHaveLength(1));

    const approval = {
      requestId: "req-approve",
      idempotencyKey: "operator:approve-1",
      method: OPERATOR_METHOD.OWNER_APPROVE,
      params: {},
    };
    expect((await daemon.handleOperatorRequest(approval, PEER)).reasonCode).toBe(
      ReasonCode.DAEMON_BOOTSTRAP_MODE,
    );

    expect((await observe(daemon)).allowed).toBe(true);
    expect((await starting).allowed).toBe(true);

    // A refusal that existed only because the daemon was parked must not outlive the park.
    // Reaching INVALID_ARGUMENT means the request got past the cache and into the handler.
    const retried = await daemon.handleOperatorRequest(approval, PEER);
    expect(retried.reasonCode).not.toBe(ReasonCode.DAEMON_BOOTSTRAP_MODE);
    expect(retried.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
    await daemon.stop();
  });

  it("re-checks with the doctor alone instead of repeating the startup sweep", async () => {
    const { harness, daemon } = makeDaemon([
      report("BLOCKED", [COVERAGE]),
      report("BLOCKED", [COVERAGE]),
      report("HEALTHY", []),
    ]);
    // The sweep marks dead sessions ERROR, abandons orphaned executions and expires claims and
    // outbox rows. A healthy daemon does that once at start; running it on every operator
    // observation destroys state a started daemon would have kept.
    const expireClaims = vi.spyOn(harness.cp.claims, "expireOverdue");
    const door = recordingDoor();
    const starting = daemon.start({ bootstrapDoor: door.open });
    await vi.waitFor(() => expect(door.opened).toHaveLength(1));
    expect(expireClaims).toHaveBeenCalledTimes(1);

    expect((await observe(daemon)).allowed).toBe(true);
    await vi.waitFor(() => expect(daemon.lock.held()).toBe(true));
    expect(expireClaims).toHaveBeenCalledTimes(1);

    expect((await observe(daemon, 91)).allowed).toBe(true);
    expect((await starting).allowed).toBe(true);
    // Exactly two: the entry pass and the promoting one.
    expect(expireClaims).toHaveBeenCalledTimes(2);
    await daemon.stop();
  });

  it("stops parking when the block drifts into one no observation can clear", async () => {
    const { harness, daemon } = makeDaemon([
      report("BLOCKED", [COVERAGE]),
      report("ERROR", [finding("CTO_BINDING_POINTS_AT_DEAD_SESSION", "project:fixture")]),
    ]);
    const door = recordingDoor();
    const starting = daemon.start({ bootstrapDoor: door.open });
    await vi.waitFor(() => expect(door.opened).toHaveLength(1));

    // A session dying while parked raises a CRITICAL blocking finding the capacity door cannot
    // answer. Without re-reading its own precondition the daemon waits forever on a door that
    // cannot help, holding the lock, with the supervisor unable to restart it.
    expect((await observe(daemon)).allowed).toBe(true);

    const started = await starting;
    expect(started.allowed).toBe(false);
    expect(daemon.lock.held()).toBe(false);
    expect(door.closed).toHaveLength(1);
    expect(harness.cp.audit.byKind("DAEMON_BOOTSTRAP_ABANDONED")).toHaveLength(1);
  });

  it("re-reads its own sensors on an interval so the door is not the only way out", async () => {
    const { daemon } = makeDaemon([report("BLOCKED", [COVERAGE]), report("HEALTHY", [])], [], {
      bootstrapRecheckIntervalMs: 25,
    });
    const door = recordingDoor();
    const starting = daemon.start({ bootstrapDoor: door.open });
    await vi.waitFor(() => expect(door.opened).toHaveLength(1));

    // No observation is ever sent. A recovered automatic collector has to be noticed without a
    // human: release-and-exit got that from the supervisor restarting the process, and a park
    // that only wakes on the operator door would silently remove it.
    const started = await starting;
    expect(started.allowed).toBe(true);
    await daemon.stop();
  });

  it("stops parking when the sweep itself creates the unparkable finding", async () => {
    // The check exists for CTO_BINDING_POINTS_AT_DEAD_SESSION, which the doctor raises only
    // after a session's lifecycle is ERROR — and the thing that flips READY to ERROR is the
    // sweep. So the pass that can produce it is the promote attempt, not the doctor-only
    // re-check. A scope check placed only where the finding cannot appear is not a check.
    const { harness, daemon } = makeDaemon([
      report("BLOCKED", [COVERAGE]),
      report("HEALTHY", []),
      report("ERROR", [finding("CTO_BINDING_POINTS_AT_DEAD_SESSION", "project:fixture")]),
    ]);
    const door = recordingDoor();
    const starting = daemon.start({ bootstrapDoor: door.open });
    await vi.waitFor(() => expect(door.opened).toHaveLength(1));

    expect((await observe(daemon)).allowed).toBe(true);

    const started = await starting;
    expect(started.allowed).toBe(false);
    expect(daemon.lock.held()).toBe(false);
    expect(door.closed).toHaveLength(1);
    expect(harness.cp.audit.byKind("DAEMON_BOOTSTRAP_ABANDONED")).toHaveLength(1);
  });

  it("serves the documented CLI command over a real socket while parked", async () => {
    // Everything above calls handleOperatorRequest directly. The change exists so that
    // `agentctl capacity observe` works on a host whose /usage cannot be read automatically,
    // and that claim is about the socket and the token — neither of which those tests touch.
    // The observe here goes through the CLI's `dispatch`, which is what carries the payload
    // and idempotency key; the status goes through `main`, which is where the lock-file
    // short-circuit lived. Two entry points because the defect and the payload are in
    // different places.
    const { daemon, stateDir } = makeDaemon([
      report("BLOCKED", [COVERAGE]),
      report("BLOCKED", [COVERAGE]),
      report("HEALTHY", []),
    ]);
    const starting = daemon.start({
      bootstrapDoor: () =>
        startBootstrapOperatorDoor(
          daemon,
          stateDir,
          { token: TEST_OPERATOR_TOKEN, peerId: "cli:fixture-operator", actor: "fixture-operator" },
          { mcpToken: TEST_MCP_TOKEN },
        ),
    });
    const socketPath = join(stateDir, "agentcpd.operator.sock");
    await vi.waitFor(() => expect(existsSync(socketPath)).toBe(true));

    const client = createOperatorClient({ socketPath, token: TEST_OPERATOR_TOKEN });
    const observation = (remainingPercent: number): string =>
      JSON.stringify({
        observedAt: "2026-08-12T00:00:00.000Z",
        buckets: [
          {
            id: "fixture-window",
            remainingPercent,
            resetAt: null,
            capabilities: ["ceo", "cto", "blind-review", "worker"],
          },
        ],
      });

    const printed: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      printed.push(String(chunk));
      return true;
    });
    let observeCode: number;
    let statusCode: number;
    try {
      // The command an operator is told to run, with the payload capacity-source.md documents.
      observeCode = await dispatch(client, "capacity", ["observe", "scripted", observation(90)], false);
      // Still parked: this reading landed and left coverage unroutable, which is precisely the
      // case the daemon says an operator must be able to tell apart from success.
      // Through main(), not dispatch(): main() is where `daemon status` used to short-circuit
      // to a lock-file read, which made dispatch's socket branch unreachable from the CLI.
      process.env["ACP_OPERATOR_SOCKET"] = socketPath;
      process.env["ACP_OPERATOR_TOKEN"] = TEST_OPERATOR_TOKEN;
      statusCode = await cliMain(["daemon", "status"]);
      await dispatch(client, "capacity", ["observe", "scripted", observation(91)], false);
    } finally {
      stdout.mockRestore();
      delete process.env["ACP_OPERATOR_SOCKET"];
      delete process.env["ACP_OPERATOR_TOKEN"];
    }

    expect(observeCode).toBe(0);
    expect(statusCode).toBe(0);
    // The designed tell has to be reachable from the same CLI, or the failure has moved rather
    // than closed. `agentctl daemon status` read only the lock file before this change.
    expect(printed.join("")).toContain("BOOTSTRAP");
    expect((await starting).allowed).toBe(true);
    await daemon.stop();
  });

  it("does not report a daemon that refused as a daemon that could not be reached", async () => {
    const printed: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      printed.push(String(chunk));
      return true;
    });
    const previousToken = process.env["ACP_OPERATOR_TOKEN"];
    let code: number;
    try {
      process.env["ACP_OPERATOR_SOCKET"] = join(tempDir("acp-bootstrap-nosock-"), "absent.sock");
      delete process.env["ACP_OPERATOR_TOKEN"];
      code = await cliMain(["daemon", "status"]);
    } finally {
      stdout.mockRestore();
      delete process.env["ACP_OPERATOR_SOCKET"];
      if (previousToken !== undefined) process.env["ACP_OPERATOR_TOKEN"] = previousToken;
    }

    // The offline inspection must survive: no token still answers, and answers zero.
    expect(code).toBe(0);
    const answer = JSON.parse(printed.join("")) as Record<string, unknown>;
    // A missing token is the daemon refusing to be asked, not the daemon being unreachable,
    // and a wrong token is the daemon answering with a denial. Naming either "unreachable"
    // beside a lock file that says a process is live is three states under one label.
    expect(answer["daemonStatus"]).toMatchObject({
      answered: false,
      reasonCode: ReasonCode.OPERATOR_UNAUTHENTICATED,
    });
    expect(Object.keys(answer)).not.toContain("daemonUnreachable");
  });

  it("is decided by the finding codes, not by how many there are", () => {
    expect(canParkForBootstrap([COVERAGE])).toBe(true);
    expect(canParkForBootstrap([COVERAGE, finding("CAPACITY_SENSOR_FAILED", "capacity")])).toBe(true);
    expect(canParkForBootstrap([CREDENTIAL])).toBe(false);
    expect(canParkForBootstrap([COVERAGE, CREDENTIAL])).toBe(false);
    // A blocked doctor with no blocking finding is blocked for a reason this door cannot read.
    expect(canParkForBootstrap([])).toBe(false);
  });
});
