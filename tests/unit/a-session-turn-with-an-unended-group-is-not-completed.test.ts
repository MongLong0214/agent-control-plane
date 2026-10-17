import { rmSync } from "node:fs";

import { afterAll, describe, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, RunKind, roleKeyFor } from "../../src/domain/types.ts";
import type { SessionTurnRequest, SessionTurnResult, UnendedProcessGroup } from "../../src/runtime/provider.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { bootstrapCtoProvider, dispatchBootstrapRun, makeHarness } from "../helpers/harness.ts";
import type { HeadlessRuntimeDouble } from "../helpers/headless-runtime.ts";

/**
 * #1104 (review R4) — a session turn whose own process group its cleanup could not confirm ended is
 * not a completed turn. The adapter answers `ok: false` naming the group; the session runtime refuses
 * the turn with the group in its refusal and its SESSION_TURN record, and it refuses a result that names
 * an unended group even when `ok` says otherwise, so no adapter can turn an unconfirmed cleanup into a
 * completion.
 *
 * HOME points at a private directory before anything is imported, so nothing here reaches the live
 * daemon's state.
 */
const isolatedHome = vi.hoisted(() => {
  const home = `${(process.env["TMPDIR"] ?? "/tmp").replace(/\/+$/, "")}/acp-unended-group-home-${process.pid}`;
  process.env["HOME"] = home;
  return home;
});
afterAll(() => {
  cleanupTempDirs();
  rmSync(isolatedHome, { recursive: true, force: true });
});

const UNENDED: UnendedProcessGroup = {
  pgid: 424242,
  ownership: "UNVERIFIABLE",
  detail: "the probe's holder (pid 424242) has no recorded exit but its start token was not read at spawn",
};

const dispatched = async () => {
  const harness = makeHarness();
  const claude = bootstrapCtoProvider(harness.cp, harness.clock) as HeadlessRuntimeDouble;
  const created = harness.cp.runs.create({
    kind: RunKind.PROJECT_BOOTSTRAP,
    executionMode: ExecutionMode.STANDARD,
    contract: {
      goal: "bootstrap", why: "fixture", scope: [], nonGoals: [], acceptance: ["done"],
      priority: "NORMAL", humanGate: [], references: [],
    },
  });
  if (!created.allowed) throw new Error(created.message);
  const run = await dispatchBootstrapRun(harness.cp, harness.clock, created.value.runId);
  return { harness, claude, run, roleKey: roleKeyFor(Role.BOOTSTRAP_CTO, { runId: run.runId }) };
};

describe("#1104 a session turn that left its own process group unconfirmed is refused, naming the group", () => {
  it.each([
    ["the adapter's not-ok answer", false],
    ["an answer that says ok but names an unended group", true],
  ])("%s is refused SESSION_TURN_FAILED with the group in its record", async (_label, okAnyway) => {
    const { harness, claude, roleKey, run } = await dispatched();
    const answered = claude.runSessionTurn.bind(claude);
    claude.runSessionTurn = async (request: SessionTurnRequest): Promise<SessionTurnResult> => {
      const result = await answered(request);
      return { ...result, ok: okAnyway, error: okAnyway ? null : "PROCESS_GROUP_UNCONFIRMED", processGroup: UNENDED };
    };
    expect(harness.cp.sessionRuntime.wake(roleKey, [{ id: "w1", kind: "test" }])).toMatchObject({ allowed: true });
    await vi.waitFor(() => expect(claude.turns).toHaveLength(2));
    const records = (): Array<{ reason_code: string | null; evidence_json: string }> => harness.cp.db.all(
      `SELECT reason_code, evidence_json FROM audit_events WHERE kind = 'SESSION_TURN' AND session_id = ? ORDER BY event_id`,
      [run.ownerSessionId],
    );
    await vi.waitFor(() => expect(records()).toHaveLength(2));
    const work = records()[1]!;
    console.error(`WITNESS unended-group-session-turn ${JSON.stringify({ okAnyway, work })}`);
    expect(work.reason_code).toBe(ReasonCode.SESSION_TURN_FAILED);
    expect(JSON.parse(work.evidence_json)).toMatchObject({ processGroup: UNENDED });
    // The turn is not completed: its trigger is released to the next wake, never counted as served.
    await vi.waitFor(() => expect(harness.cp.sessionRuntime.wake(roleKey, [{ id: "w1", kind: "test" }])).toMatchObject({ allowed: true }));
  });
});
