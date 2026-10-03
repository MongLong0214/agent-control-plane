import { expect } from "vitest";

import {
  createAdoptedCeoToolAdmission,
  type AdoptedCeoAdmission,
  type AdoptedCeoToolAdmission,
  type AdoptedCeoToolAdmissionOptions,
} from "../../src/bootstrap/adopted-ceo-tool-admission.ts";
import type { GatewayIncumbentProof } from "../../src/bootstrap/hermes-incumbent-adoption.ts";
import { digestOf } from "../../src/core/digest.ts";
import type { Decision } from "../../src/core/errors.ts";
import type { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import type { HermesTargetBindResponse } from "../../src/runtime/hermes-target-bind.ts";
import type { ProcessLineageReader } from "../../src/session/runtime-lineage.ts";
import { makeHarness, type Harness } from "./harness.ts";

/**
 * An adopted Hermes CEO, for the tool channel #1037 opens. The process tree and the Gateway's
 * readback are values the test states; every registry behind them is the production one. The
 * caller owns the harness and closes it (`fixture.h.cp.close()`).
 */

export const GATEWAY = 424_242;
export const SHELL = 434_343;
export const RELAY = 444_444;
export const STRANGER = 454_545;
export const IMPOSTOR_GATEWAY = 464_646;
export const TOKEN = "darwin-tv:1790000000.000001";
export const LSTART = "Fri Oct  2 07:00:00 2026";
export const LIVE = "20261002_070000_live";
export const DIGEST = `sha256:${"a".repeat(64)}`;
export const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;
export const RUNTIME = "fixture-runtime";
export const CEO = roleKeyFor(Role.CEO);

const TABLES = [
  "sessions",
  "assignments",
  "conversational_actors",
  "actor_target_bindings",
  "actor_target_attestations",
  "outbox",
  "audit_events",
  "canonical_turns",
  "runs",
  "inbound_messages",
] as const;

/** Every table an admission or a tool call could write, as sorted rows. */
export const snapshot = (h: Harness): Record<string, string[]> =>
  Object.fromEntries(
    TABLES.map((table) => [
      table,
      h.cp.db.all<Record<string, unknown>>(`SELECT * FROM ${table}`).map((row) => JSON.stringify(row)).sort(),
    ]),
  );

export const count = (h: Harness, sql: string, params: unknown[] = []): number =>
  h.cp.db.get<{ n: number }>(sql, params)!.n;

const receiptFor = (tuple: {
  actorId: string;
  bindingGeneration: number;
  sessionId: string;
  lineageRootDigest: string;
}): HermesTargetBindResponse => {
  const fields = {
    domain: "hermes.target-bind" as const,
    version: 1 as const,
    actor_id: tuple.actorId,
    binding_generation: tuple.bindingGeneration,
    executor_runtime_identity: RUNTIME,
    requested_session_id: tuple.sessionId,
    lineage_root_digest: tuple.lineageRootDigest,
  };
  return { ...fields, receipt_digest: digestOf(fields) };
};

export interface AdoptedCeoFixture {
  h: Harness;
  parents: Map<number, number>;
  tokens: Map<number, string>;
  processes: ProcessLineageReader;
  proof: GatewayIncumbentProof;
  gatewaySessionId: string;
  actorId: string;
  admission(overrides?: Partial<AdoptedCeoToolAdmissionOptions>): AdoptedCeoToolAdmission;
  admit(peerPid?: number, overrides?: Partial<AdoptedCeoToolAdmissionOptions>): Promise<Decision<AdoptedCeoAdmission>>;
}

/**
 * The CEO bound the way incumbent adoption binds a live Gateway: a Hermes runtime row for the
 * Gateway's pid and recorded start, a CEO actor whose one target is the live head and lineage, and
 * the executor's receipt for that tuple. The relay descends from the Gateway through a shell; the
 * suite's own process can be added below the Gateway by a test that connects from it.
 */
export const adoptedFixture = (
  bound: {
    locator?: string;
    digest?: string;
    /**
     * A row written the way adoption wrote them before #1037: `ps` lstart only, recording `lstart`,
     * no native start pinned. Every admission refuses it; re-adoption is what pins it.
     */
    unpinned?: { lstart: string };
  } = {},
): AdoptedCeoFixture => {
  const h = makeHarness();
  const parents = new Map<number, number>([
    [RELAY, SHELL],
    [SHELL, GATEWAY],
    [GATEWAY, 1],
    [STRANGER, 1],
  ]);
  const tokens = new Map<number, string>([[GATEWAY, TOKEN]]);
  const processes: ProcessLineageReader = {
    parentOf: (pid) => parents.get(pid) ?? null,
    startToken: (pid) => tokens.get(pid) ?? null,
  };
  const gateway = h.cp.sessions.create({
    provider: "hermes",
    model: "hermes-runtime",
    osPid: GATEWAY,
    osStartedAt: bound.unpinned?.lstart ?? LSTART,
  });
  expect(h.cp.sessions.transition(gateway.sessionId, SessionLifecycle.READY).allowed).toBe(true);
  // What adoption does since #1037: the exact token beside the lstart the row keeps.
  if (bound.unpinned === undefined) h.cp.sessions.pinNativeStart(gateway.sessionId, TOKEN);
  const claimed = {
    executorKind: "hermes",
    targetLocator: bound.locator ?? LIVE,
    targetLocatorDigest: bound.digest ?? DIGEST,
  };
  let initial: HermesTargetBindResponse | null = null;
  const binding = h.cp.bindings.bind({
    role: Role.CEO,
    sessionId: gateway.sessionId,
    authenticatedTarget: {
      claimed,
      protocolVersion: "hermes.target-bind/v1",
      expectedExecutorRuntimeIdentity: RUNTIME,
      get targetBindReceipt() {
        return initial;
      },
      get attestationDigest() {
        return initial?.receipt_digest ?? "";
      },
      verify: (tuple) => {
        initial = receiptFor({
          actorId: tuple.actorId,
          bindingGeneration: tuple.generation,
          sessionId: claimed.targetLocator,
          lineageRootDigest: claimed.targetLocatorDigest,
        });
        return claimed;
      },
    },
  });
  expect(binding.allowed).toBe(true);
  const actor = h.cp.db.get<{ actor_id: string }>("SELECT actor_id FROM assignments WHERE role_key = ?", [CEO])!;
  const proof: GatewayIncumbentProof = {
    session_id: LIVE,
    lineage_root_digest: DIGEST,
    process_pid: GATEWAY,
    process_started_at: TOKEN,
  };
  const admission = (overrides: Partial<AdoptedCeoToolAdmissionOptions> = {}): AdoptedCeoToolAdmission =>
    createAdoptedCeoToolAdmission(h.cp, {
      gatewayOrigin: async () => ({ ...proof }),
      expectedLiveSessionId: LIVE,
      lineageRootDigest: DIGEST,
      processes,
      ...overrides,
    });
  return {
    h,
    parents,
    tokens,
    processes,
    proof,
    gatewaySessionId: gateway.sessionId,
    actorId: actor.actor_id,
    admission,
    admit: (peerPid = RELAY, overrides = {}) => admission(overrides).admit({ peerPid, uid: 501 }),
  };
};

/** A refusal is its code and nothing written. */
export const expectRefusedWithoutWrites = async <T>(
  fixture: AdoptedCeoFixture,
  run: () => Promise<Decision<T>>,
  reasonCode: ReasonCode,
): Promise<void> => {
  const before = snapshot(fixture.h);
  const decision = await run();
  expect(decision.allowed).toBe(false);
  expect(decision.reasonCode).toBe(reasonCode);
  expect(snapshot(fixture.h)).toEqual(before);
};
