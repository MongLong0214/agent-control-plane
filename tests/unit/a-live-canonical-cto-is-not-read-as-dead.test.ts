import { spawnSync } from "node:child_process";

import { afterAll, describe, expect, it } from "vitest";

import { digestOf, sha256 } from "../../src/core/digest.ts";
import { DARWIN_START_TOKEN, readProcessStartToken } from "../../src/core/process-argv.ts";
import { lstartSecondStartMs, processStartedAt } from "../../src/core/process-identity.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  parseDeadBindingRecoveryRequest,
  probeSessionLiveness,
  recoverDeadCanonicalBinding,
} from "../../src/daemon/dead-binding-recovery.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL } from "../../src/registry/canonical-self-claim.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * A session row records its process start in one of two formats: the canonical self-claim writes
 * the native `darwin-tv:<sec>.<usec>` token its inspector read, every other writer `ps -o lstart=`
 * text. `probeSessionLiveness`'s default reader was lstart only, so with no seam — the operator's
 * dead-binding door passes none — a live canonical CTO's native token never equalled the lstart
 * text read back, the mismatch was read as pid reuse, and the door revoked a live binding.
 *
 * Every probe here is the real syscall and the real start reader: no seam is injected anywhere.
 */

const CONVERSATION = "44444444-4444-4444-8444-444444444444";

/** This test process's own native start token, as the canonical self-claim records it. */
const liveNativeToken = (): string => {
  const token = readProcessStartToken(process.pid);
  if (token === null || !DARWIN_START_TOKEN.test(token)) {
    throw new Error(`this platform did not give a darwin-tv start token for the test process: ${String(token)}`);
  }
  return token;
};

/** A pid that answered once and is gone now: a child that ran to completion and was reaped. */
const exitedPid = (): number => {
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore", timeout: 10_000 });
  if (typeof child.pid !== "number") throw new Error("could not start a child process");
  return child.pid;
};

/**
 * A PRIMARY_CTO bound the way the canonical self-claim binds one: a `claude` / `claude-cli` row
 * carrying the recorded pid and start token, held for a `SELF_CLAIM_EXECUTOR_KIND` conversation.
 */
const canonicalBinding = async (recorded: { osPid: number; startedAt: string }) => {
  const h = makeHarness();
  const { projectId } = await registerFixtureProject(h);
  const session = h.cp.sessions.create({
    provider: "claude",
    model: "claude-cli",
    osPid: recorded.osPid,
    osStartedAt: recorded.startedAt,
  });
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "canonical self-claim").allowed).toBe(true);
  const claimed = {
    executorKind: SELF_CLAIM_EXECUTOR_KIND,
    targetLocator: CONVERSATION,
    targetLocatorDigest: sha256(CONVERSATION),
  };
  const bound = h.cp.bindings.bind({
    role: Role.PRIMARY_CTO,
    projectId,
    sessionId: session.sessionId,
    mode: "PREFERRED",
    authenticatedTarget: {
      claimed,
      protocolVersion: SELF_CLAIM_PROTOCOL,
      attestationDigest: digestOf({ fixture: "live-canonical-cto", sessionId: session.sessionId }),
      verify: () => claimed,
    },
  });
  if (!bound.allowed) throw new Error(bound.message);
  return { h, projectId, sessionId: session.sessionId, binding: bound.value, roleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId }) };
};

/** The operator door, as `Daemon.executeDeadBindingRecovery` drives it: parse, then recover with no seam. */
const operatorDoor = (h: Harness, params: Record<string, unknown>) => {
  const parsed = parseDeadBindingRecoveryRequest(params);
  if (!parsed.allowed) return parsed;
  return recoverDeadCanonicalBinding("operator", parsed.value, {
    db: h.cp.db,
    audit: h.cp.audit,
    sessions: h.cp.sessions,
    bindings: h.cp.bindings,
  });
};

const assignmentStatuses = (h: Harness, roleKey: string) =>
  h.cp.db.all<{ g: number; status: string }>(
    `SELECT binding_generation AS g, status FROM assignments WHERE role_key = ? ORDER BY binding_generation`,
    [roleKey],
  );

describe("a live canonical CTO is not read as dead", () => {
  it("(a) reads a darwin-tv recorded start natively: this live process is ALIVE with no reader injected", () => {
    expect(probeSessionLiveness(process.pid, liveNativeToken())).toBe("ALIVE");
  });

  it("(b) the operator door refuses to revoke a canonical binding whose recorded process is this running one", async () => {
    const f = await canonicalBinding({ osPid: process.pid, startedAt: liveNativeToken() });
    try {
      const released = operatorDoor(f.h, {
        projectId: f.projectId,
        role: Role.PRIMARY_CTO,
        sessionId: f.sessionId,
        sessionIncarnation: f.h.cp.sessions.require(f.sessionId).incarnation,
        expectedBindingGeneration: f.binding.bindingGeneration,
      });

      expect(released).toMatchObject({ allowed: false, reasonCode: ReasonCode.RECOVERY_TAKEOVER_REQUIRES_UNREACHABLE_OWNER });
      const held = f.h.cp.bindings.require(f.roleKey);
      expect(held.assignmentId).toBe(f.binding.assignmentId);
      expect(held.sessionId).toBe(f.sessionId);
      expect(held.bindingGeneration).toBe(f.binding.bindingGeneration);
      expect(assignmentStatuses(f.h, f.roleKey)).toEqual([{ g: f.binding.bindingGeneration, status: "ACTIVE" }]);
      expect(f.h.cp.audit.byKind("BINDING_REVOKED")).toHaveLength(0);
      expect(f.h.cp.audit.byKind("DEAD_BINDING_RECOVERED")).toHaveLength(0);
      expect(f.h.cp.sessions.require(f.sessionId).lifecycle).toBe(SessionLifecycle.READY);
    } finally {
      f.h.cp.close();
    }
  });

  it("(c) control: an lstart-recorded session (hermes/adapter style) for this live process is ALIVE", () => {
    const h = makeHarness();
    try {
      const session = h.cp.sessions.create({ provider: "hermes", model: "hermes-runtime", osPid: process.pid });
      const row = h.cp.sessions.require(session.sessionId);
      const recorded = row.osProcessStartedAt;
      if (recorded === null) throw new Error("the session row recorded no start for a live pid");
      expect(lstartSecondStartMs(recorded)).not.toBeNull();
      expect(recorded).toBe(processStartedAt(process.pid));
      expect(DARWIN_START_TOKEN.test(recorded)).toBe(false);
      expect(probeSessionLiveness(row.osPid, recorded)).toBe("ALIVE");
    } finally {
      h.cp.close();
    }
  });

  it("(d) recovery still works: a darwin-tv start for an exited pid, or for a pid now held by another process, is DEAD", async () => {
    expect(probeSessionLiveness(exitedPid(), "darwin-tv:1790000100.000001")).toBe("DEAD");
    expect(probeSessionLiveness(process.pid, "darwin-tv:1.000001")).toBe("DEAD");

    const f = await canonicalBinding({ osPid: exitedPid(), startedAt: "darwin-tv:1790000100.000001" });
    try {
      const released = operatorDoor(f.h, {
        projectId: f.projectId,
        role: Role.PRIMARY_CTO,
        sessionId: f.sessionId,
        sessionIncarnation: f.h.cp.sessions.require(f.sessionId).incarnation,
        expectedBindingGeneration: f.binding.bindingGeneration,
      });
      expect(released).toMatchObject({ allowed: true, value: { liveness: "DEAD" } });
      expect(f.h.cp.bindings.active(f.roleKey)).toBeNull();
      expect(f.h.cp.audit.byKind("DEAD_BINDING_RECOVERED")).toHaveLength(1);
    } finally {
      f.h.cp.close();
    }
  });

  it.each([
    ["an arbitrary string", "not-a-start-token"],
    ["a linux-clk token", "linux-clk:123456"],
    ["a darwin-tv token with the wrong precision", "darwin-tv:1791024432.38"],
    ["an ISO timestamp", "2026-10-03T17:23:36.000Z"],
  ])("(e) refuses a recorded start in neither format (%s) as UNKNOWN for a live pid, never DEAD", (_shape, recorded) => {
    expect(probeSessionLiveness(process.pid, recorded)).toBe("UNKNOWN");
    // An injected reader replaces the reader, not the format check: even a reader that hands
    // back the record itself, or a valid native token, cannot make an unrecognised record decide.
    expect(probeSessionLiveness(process.pid, recorded, { startedAt: () => recorded })).toBe("UNKNOWN");
    expect(probeSessionLiveness(process.pid, recorded, { startedAt: () => "darwin-tv:1791024432.380000" })).toBe("UNKNOWN");
  });

  it("(f) a live value in another format than the record is UNKNOWN, never DEAD, even through an injected reader", () => {
    const answers = () => undefined;
    const lstart = "Sat Oct  3 17:23:36 2026";
    const native = "darwin-tv:1791024432.383646";
    // An lstart record compared through a native reader (the claim's seam), and the reverse.
    expect(probeSessionLiveness(4242, lstart, { signal: answers, startedAt: () => native })).toBe("UNKNOWN");
    expect(probeSessionLiveness(4242, native, { signal: answers, startedAt: () => lstart })).toBe("UNKNOWN");
    // A live value in neither format is no answer either.
    expect(probeSessionLiveness(4242, native, { signal: answers, startedAt: () => "t2" })).toBe("UNKNOWN");
    // One format, different values: the pid-reuse case still reads DEAD, and an equal value ALIVE.
    expect(probeSessionLiveness(4242, native, { signal: answers, startedAt: () => "darwin-tv:1791024433.000001" })).toBe("DEAD");
    expect(probeSessionLiveness(4242, lstart, { signal: answers, startedAt: () => "Sat Oct  3 17:23:37 2026" })).toBe("DEAD");
    expect(probeSessionLiveness(4242, native, { signal: answers, startedAt: () => native })).toBe("ALIVE");
    expect(probeSessionLiveness(4242, lstart, { signal: answers, startedAt: () => lstart })).toBe("ALIVE");
  });
});
