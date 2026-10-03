import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { HERMES_AUTO_ADOPTED, HERMES_AUTO_ADOPTION_REFUSED } from "../../src/bootstrap/hermes-auto-adoption.ts";
import {
  CONTINUITY_COVERAGE_REVOCATION_REASON,
  CONTINUITY_FAILOVER_REFUSED_REASON_PREFIX,
  CONTINUITY_INCOMPLETE_FAILOVER_REVOCATION_REASON,
} from "../../src/continuity/continuity-kernel.ts";
import { digestOf } from "../../src/core/digest.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { processStartedAt } from "../../src/core/process-identity.ts";
import {
  createConfiguredHermesAutoAdoption,
  createConfiguredHermesIncumbentAdoption,
  startHermesAutoAdoption,
} from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import type { HermesGatewayIdentity } from "../../src/runtime/hermes-gateway-identity.ts";
import type { HermesTargetBindResponse } from "../../src/runtime/hermes-target-bind.ts";
import { readHermesTargetHead, TARGET_HEAD_ADVANCED } from "../../src/session/hermes-target-head.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness, type Harness } from "../helpers/harness.ts";

/**
 * 2026-10-03: a Gateway redeploy changed its pid, continuity revoked CEO gen2, and the CEO stayed
 * unbound until the owner ran `agentctl adopt hermes` — which then refused, because the head had
 * rotated inside the lineage and the Keychain still pinned the old one. Here the daemon's own pass
 * adopts the redeployed Gateway with no head configured and no operator in the loop, against the
 * production adoption core, registries and target-bind protocol; only the Gateway's identity
 * readback is stated by the test, and it names this test process, whose pid and native start the
 * core reads from the kernel itself.
 */

afterAll(cleanupTempDirs);
const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cp.close();
});

const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;
const OLD_HEAD = "20260923_000000_gen2_head";
const NEW_HEAD = "20261001_120000_compressed_head";
const RUNTIME = "fixture-runtime";
const DEAD_PID = 2147483647;
/** The revocation the 2026-10-03 redeploy produced, written the way continuity writes it. */
const FAILOVER_REFUSED = `${CONTINUITY_FAILOVER_REFUSED_REASON_PREFIX}COVERAGE_NONE`;
const hermesExecutable = new URL("../fixtures/hermes-target-bind-producer.sh", import.meta.url).pathname;

const PRODUCER = `
import { createHash } from 'node:crypto';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const fields = {
  domain: 'hermes.target-bind', version: 1, actor_id: request.actor_id,
  binding_generation: request.binding_generation,
  executor_runtime_identity: request.executor_runtime_identity,
  requested_session_id: request.session_id,
  lineage_root_digest: request.expected_lineage_root_digest,
};
const canonical = JSON.stringify(Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))));
process.stdout.write(JSON.stringify({ ...fields, receipt_digest: 'sha256:' + createHash('sha256').update(canonical).digest('hex') }));
`;

const TABLES = ["sessions", "assignments", "conversational_actors", "actor_target_bindings",
  "actor_target_attestations", "audit_events", "outbox", "runs"] as const;
const snapshot = (h: Harness): Record<string, string[]> => Object.fromEntries(TABLES.map((table) =>
  [table, h.cp.db.all<Record<string, unknown>>(`SELECT * FROM ${table}`).map((row) => JSON.stringify(row)).sort()]));
const kinds = (rows: string[]): string[] => rows.map((row) => (JSON.parse(row) as { kind: string }).kind);
/** Every table but the audit log is as it was; the audit rows added are returned by kind. */
const auditOnlyDelta = (before: Record<string, string[]>, after: Record<string, string[]>): string[] => {
  for (const table of TABLES) if (table !== "audit_events") expect(after[table]).toEqual(before[table]);
  return kinds(after.audit_events!.filter((row) => !before.audit_events!.includes(row)));
};

interface Scene {
  h: Harness;
  actorId: string;
  revokedGeneration: number;
  gateway: { reads: number; answer: () => HermesGatewayIdentity };
  proof: HermesGatewayIdentity;
  /** The daemon's configuration: no ACP_HERMES_EXPECTED_LIVE_SESSION_ID, no ACP_HERMES_TARGET_SESSION_ID. */
  configuration: Record<string, string>;
  auto(): NonNullable<ReturnType<typeof createConfiguredHermesAutoAdoption>>;
}

/** Binds the CEO to `sessionId` with an authenticated target born at OLD_HEAD in DIGEST. */
const bindCeo = (h: Harness, sessionId: string) => {
  const claimed = { executorKind: "hermes", targetLocator: OLD_HEAD, targetLocatorDigest: DIGEST };
  let receipt: HermesTargetBindResponse | null = null;
  const bound = h.cp.bindings.bind({ role: Role.CEO, sessionId, authenticatedTarget: {
    claimed, protocolVersion: "hermes.target-bind/v1", expectedExecutorRuntimeIdentity: RUNTIME,
    get targetBindReceipt() { return receipt; },
    get attestationDigest() { return receipt?.receipt_digest ?? ""; },
    verify: (tuple) => {
      const fields = { domain: "hermes.target-bind" as const, version: 1 as const, actor_id: tuple.actorId,
        binding_generation: tuple.generation, executor_runtime_identity: RUNTIME,
        requested_session_id: OLD_HEAD, lineage_root_digest: DIGEST };
      receipt = { ...fields, receipt_digest: digestOf(fields) };
      return claimed;
    },
  } });
  expect(bound.allowed).toBe(true);
  if (!bound.allowed) throw new Error(bound.message);
  return bound;
};

/**
 * CEO gen1 bound to a Hermes runtime with an authenticated target (born at OLD_HEAD), then — unless
 * `revoke` is false — revoked with `revokeReason` (by default a continuity reason). Its process is
 * dead unless `incumbentAlive`, in which case the incumbent row records this live test process.
 */
const scene = (options: { revoke?: boolean; revokeReason?: string; incumbentAlive?: boolean } = {}): Scene => {
  const h = makeHarness();
  harnesses.push(h);
  const home = tempDir("acp-auto-adopt-");
  symlinkSync(process.execPath, join(home, "node"));
  writeFileSync(join(home, "producer.mjs"), PRODUCER);
  const incumbent = options.incumbentAlive
    ? h.cp.sessions.create({ provider: "hermes", model: "hermes-runtime", osPid: process.pid,
      osStartedAt: processStartedAt(process.pid)! })
    : h.cp.sessions.create({ provider: "hermes", model: "hermes-runtime", osPid: DEAD_PID });
  expect(h.cp.sessions.transition(incumbent.sessionId, SessionLifecycle.READY).allowed).toBe(true);
  const bound = bindCeo(h, incumbent.sessionId);
  const actorId = h.cp.db.get<{ actor_id: string }>("SELECT actor_id FROM assignments WHERE role_key = 'CEO'")!.actor_id;
  if (options.revoke !== false) {
    expect(h.cp.bindings.revoke("CEO", options.revokeReason ?? FAILOVER_REFUSED).allowed).toBe(true);
  }
  const token = readProcessStartToken(process.pid);
  expect(token).not.toBeNull();
  const proof: HermesGatewayIdentity = { session_id: NEW_HEAD, lineage_root_digest: DIGEST,
    process_pid: process.pid, process_started_at: token! };
  const gateway = { reads: 0, answer: () => proof };
  const configuration = {
    ACP_HERMES_LINEAGE_ROOT_DIGEST: DIGEST, ACP_HERMES_EXECUTABLE: hermesExecutable,
    ACP_HERMES_PROFILE: "fixture", ACP_HERMES_HOME: home, ACP_HERMES_EXECUTOR_RUNTIME_IDENTITY: RUNTIME,
    ACP_HERMES_GATEWAY_API_KEY: "fixture-gateway-key",
  };
  return {
    h, actorId, revokedGeneration: bound.value.bindingGeneration, gateway, proof, configuration,
    auto: () => createConfiguredHermesAutoAdoption(h.cp, configuration, {
      identityReader: () => async () => { gateway.reads++; return gateway.answer(); },
      authorityHeld: () => true,
      backoff: { baseMs: 1_000, maxMs: 4_000 },
    })!,
  };
};

describe("Hermes CEO auto-adoption — adopted with no person and no configured head", () => {
  it("adopts the redeployed Gateway: revoked by continuity, incumbent DEAD, same lineage, head rotated", async () => {
    const s = scene();
    expect(Object.keys(s.configuration)).not.toContain("ACP_HERMES_EXPECTED_LIVE_SESSION_ID");
    expect(Object.keys(s.configuration)).not.toContain("ACP_HERMES_TARGET_SESSION_ID");
    const outcome = await s.auto().tick("periodic");
    expect(outcome).toMatchObject({ attempted: true, decision: { allowed: true } });
    const active = s.h.cp.bindings.active("CEO");
    expect(active?.bindingGeneration).toBe(s.revokedGeneration + 1);
    const runtime = s.h.cp.sessions.get(active!.sessionId)!;
    expect(runtime).toMatchObject({ provider: "hermes", osPid: process.pid, lifecycle: SessionLifecycle.READY });
    // The native start ACP read itself is pinned for the adopted runtime.
    expect(s.h.cp.sessions.pinnedNativeStart(runtime.sessionId)).toBe(s.proof.process_started_at);
    // The same actor; its target follows the rotated head, recorded once by the adoption.
    expect(s.h.cp.db.get("SELECT actor_id FROM assignments WHERE assignment_id = ?", [active!.assignmentId]))
      .toEqual({ actor_id: s.actorId });
    expect(readHermesTargetHead(s.h.cp.db, s.actorId)).toMatchObject({ head: NEW_HEAD, bornLocator: OLD_HEAD,
      lineageRootDigest: DIGEST });
    expect(s.h.cp.audit.byKind(TARGET_HEAD_ADVANCED).map((row) => row.evidence)).toEqual([
      expect.objectContaining({ previousHead: OLD_HEAD, head: NEW_HEAD, path: "adoption",
        bindingGeneration: s.revokedGeneration + 1 }),
    ]);
    expect(s.h.cp.audit.byKind(HERMES_AUTO_ADOPTED).map((row) => row.evidence)).toEqual([
      { revokedGeneration: s.revokedGeneration, trigger: "periodic" },
    ]);
    expect(s.h.cp.bindings.currentHermesTargetBindReceipt({ roleKey: "CEO", sessionId: runtime.sessionId,
      sessionIncarnation: runtime.incarnation })).toMatchObject({ requested_session_id: NEW_HEAD });
  });

  it("mints one generation however many passes run, concurrent or repeated", async () => {
    const s = scene();
    const auto = s.auto();
    const concurrent = await Promise.all([auto.tick("periodic"), auto.tick("ceo_revoked"), auto.tick("periodic")]);
    expect(concurrent.filter((outcome) => outcome.attempted)).toHaveLength(1);
    expect(concurrent.filter((outcome) => !outcome.attempted)).toEqual([
      { attempted: false, skipped: "IN_FLIGHT" }, { attempted: false, skipped: "IN_FLIGHT" },
    ]);
    const adopted = snapshot(s.h);
    const reads = s.gateway.reads;
    for (let pass = 0; pass < 3; pass++) {
      s.h.clock.advance(60_000);
      expect(await auto.tick("periodic")).toEqual({ attempted: false, skipped: "CEO_ACTIVE" });
    }
    // A second auto-adoption over the same database answers the same way.
    expect(await s.auto().tick("startup")).toEqual({ attempted: false, skipped: "CEO_ACTIVE" });
    expect(snapshot(s.h)).toEqual(adopted);
    expect(s.gateway.reads).toBe(reads);
    expect(s.h.cp.db.all("SELECT binding_generation, status FROM assignments WHERE role_key = 'CEO' ORDER BY binding_generation"))
      .toEqual([{ binding_generation: 1, status: "REVOKED" }, { binding_generation: 2, status: "ACTIVE" }]);
  });
});

describe("Hermes CEO auto-adoption — only a revocation continuity wrote", () => {
  it.each([
    ["coverage", CONTINUITY_COVERAGE_REVOCATION_REASON],
    ["incomplete failover", CONTINUITY_INCOMPLETE_FAILOVER_REVOCATION_REASON],
    ["refused failover", FAILOVER_REFUSED],
  ])("adopts after a continuity revocation (%s)", async (_name, reason) => {
    const s = scene({ revokeReason: reason });
    expect(await s.auto().tick("periodic")).toMatchObject({ attempted: true, decision: { allowed: true } });
    expect(s.h.cp.bindings.active("CEO")?.bindingGeneration).toBe(s.revokedGeneration + 1);
  });

  it("does not attempt after an operator's or owner's revocation, and the operator can still adopt", async () => {
    for (const reason of ["operator stopped the CEO", "owner release"]) {
      const s = scene({ revokeReason: reason });
      const before = snapshot(s.h);
      expect(await s.auto().tick("periodic")).toEqual({ attempted: false, skipped: "REVOKED_BY_DECISION" });
      expect(await s.auto().tick("ceo_revoked")).toEqual({ attempted: false, skipped: "REVOKED_BY_DECISION" });
      expect(s.gateway.reads).toBe(0);
      expect(snapshot(s.h)).toEqual(before);
      // `agentctl adopt hermes` is the way back: the same core, asked by the operator.
      const operatorAdopt = createConfiguredHermesIncumbentAdoption(s.h.cp, s.configuration, {
        identityReader: () => async () => { s.gateway.reads++; return s.gateway.answer(); },
        authorityHeld: () => true,
      })!;
      expect(await operatorAdopt()).toMatchObject({ allowed: true });
      expect(s.h.cp.bindings.active("CEO")?.bindingGeneration).toBe(s.revokedGeneration + 1);
    }
  });

  it("does not attempt when the revocation's reason is absent or not one continuity writes (fail-closed)", async () => {
    for (const reason of [null, "", `${CONTINUITY_COVERAGE_REVOCATION_REASON} (edited)`,
      "Hermes bootstrap credential delivery failed"]) {
      const s = scene();
      s.h.cp.db.run("UPDATE assignments SET revoked_reason = ? WHERE role_key = 'CEO' AND binding_generation = ?",
        [reason, s.revokedGeneration]);
      const before = snapshot(s.h);
      expect(await s.auto().tick("periodic")).toEqual({ attempted: false, skipped: "REVOKED_BY_DECISION" });
      expect(s.gateway.reads).toBe(0);
      expect(snapshot(s.h)).toEqual(before);
    }
  });
});

describe("Hermes CEO auto-adoption — not attempted, nothing written", () => {
  it("does not attempt while the previous incumbent's process is alive", async () => {
    const s = scene({ incumbentAlive: true });
    const before = snapshot(s.h);
    expect(await s.auto().tick("periodic")).toEqual({ attempted: false, skipped: "INCUMBENT_NOT_DEAD" });
    expect(s.gateway.reads).toBe(0);
    expect(snapshot(s.h)).toEqual(before);
  });

  it("does not attempt while a CEO binding is active", async () => {
    const s = scene({ revoke: false });
    const before = snapshot(s.h);
    expect(await s.auto().tick("periodic")).toEqual({ attempted: false, skipped: "CEO_ACTIVE" });
    expect(s.gateway.reads).toBe(0);
    expect(snapshot(s.h)).toEqual(before);
  });
});

describe("Hermes CEO auto-adoption — refused, retried on a later pass, one row per refusal", () => {
  it("refuses another lineage, writing nothing but one refusal row however often it is retried", async () => {
    const s = scene();
    s.gateway.answer = () => ({ ...s.proof, lineage_root_digest: OTHER_DIGEST });
    const auto = s.auto();
    const before = snapshot(s.h);
    expect(await auto.tick("periodic")).toMatchObject({ attempted: true, decision: { allowed: false } });
    // Bounded: the next pass inside the backoff does not ask the Gateway again.
    const reads = s.gateway.reads;
    expect(await auto.tick("periodic")).toEqual({ attempted: false, skipped: "BACKING_OFF" });
    expect(s.gateway.reads).toBe(reads);
    for (let pass = 0; pass < 3; pass++) {
      s.h.clock.advance(10_000);
      expect(await auto.tick("periodic")).toMatchObject({ attempted: true, decision: { allowed: false } });
    }
    expect(auditOnlyDelta(before, snapshot(s.h))).toEqual([HERMES_AUTO_ADOPTION_REFUSED]);
    expect(s.h.cp.bindings.active("CEO")).toBeNull();
    expect(readHermesTargetHead(s.h.cp.db, s.actorId)?.head).toBe(OLD_HEAD);
  });

  it("refuses a Gateway whose pid or native start is not the process ACP reads", async () => {
    for (const wrong of [{ process_pid: DEAD_PID }, { process_started_at: "darwin-tv:0.000000" }]) {
      const s = scene();
      s.gateway.answer = () => ({ ...s.proof, ...wrong });
      const before = snapshot(s.h);
      expect(await s.auto().tick("periodic")).toMatchObject({ attempted: true, decision: { allowed: false } });
      expect(auditOnlyDelta(before, snapshot(s.h))).toEqual([HERMES_AUTO_ADOPTION_REFUSED]);
      expect(s.h.cp.bindings.active("CEO")).toBeNull();
    }
  });

  it("retries a Gateway that was down and adopts it once it answers", async () => {
    const s = scene();
    let up = false;
    s.gateway.answer = () => {
      if (!up) throw new Error("Gateway identity unavailable");
      return s.proof;
    };
    const auto = s.auto();
    const before = snapshot(s.h);
    expect(await auto.tick("periodic")).toMatchObject({ attempted: true, decision: { allowed: false } });
    s.h.clock.advance(10_000);
    expect(await auto.tick("periodic")).toMatchObject({ attempted: true, decision: { allowed: false } });
    expect(auditOnlyDelta(before, snapshot(s.h))).toEqual([HERMES_AUTO_ADOPTION_REFUSED]);
    up = true;
    s.h.clock.advance(10_000);
    expect(await auto.tick("periodic")).toMatchObject({ attempted: true, decision: { allowed: true } });
    expect(s.h.cp.bindings.active("CEO")?.bindingGeneration).toBe(s.revokedGeneration + 1);
  });
});

describe("Hermes CEO auto-adoption — wired to the revocation", () => {
  it("adopts when continuity revokes the CEO, with no operator command", async () => {
    const s = scene({ revoke: false });
    const timer = startHermesAutoAdoption(s.h.cp, s.auto(), 3_600_000);
    try {
      // The startup pass finds the CEO still bound and leaves it.
      await new Promise((resolve) => setImmediate(resolve));
      expect(s.gateway.reads).toBe(0);
      expect(s.h.cp.bindings.revoke("CEO", FAILOVER_REFUSED).allowed).toBe(true);
      for (let wait = 0; wait < 100 && s.h.cp.bindings.active("CEO") === null; wait++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(s.h.cp.bindings.active("CEO")?.bindingGeneration).toBe(s.revokedGeneration + 1);
      expect(s.h.cp.audit.byKind(HERMES_AUTO_ADOPTED).map((row) => row.evidence)).toEqual([
        { revokedGeneration: s.revokedGeneration, trigger: "ceo_revoked" },
      ]);
    } finally {
      clearInterval(timer);
    }
  });
});

describe("Hermes CEO auto-adoption — PR #1053 review counterexamples", () => {
  it("ACP1053-01: does not override an operator's revocation made while the Gateway identity was pending", async () => {
    const s = scene();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    const auto = createConfiguredHermesAutoAdoption(s.h.cp, s.configuration, {
      identityReader: () => async () => {
        s.gateway.reads++;
        if (!held) { held = true; await pending; }
        return s.gateway.answer();
      },
      authorityHeld: () => true,
      backoff: { baseMs: 1_000, maxMs: 4_000 },
    })!;
    // Generation 1 was revoked by continuity, so the pass is eligible and asks the Gateway.
    const pass = auto.tick("ceo_revoked");
    expect(s.gateway.reads).toBe(1);
    // While it waits, generation 2 is bound (its runtime dead too) and an operator stops the CEO.
    const second = s.h.cp.sessions.create({ provider: "hermes", model: "hermes-runtime", osPid: DEAD_PID });
    expect(s.h.cp.sessions.transition(second.sessionId, SessionLifecycle.READY).allowed).toBe(true);
    expect(bindCeo(s.h, second.sessionId).value.bindingGeneration).toBe(s.revokedGeneration + 1);
    expect(s.h.cp.bindings.revoke("CEO", "operator stopped the CEO").allowed).toBe(true);
    const before = snapshot(s.h);
    release();
    expect(await pass).toMatchObject({ attempted: true, decision: { allowed: false } });
    // The operator's decision stands: no generation 3, nothing written but one refusal row.
    expect(s.h.cp.bindings.active("CEO")).toBeNull();
    expect(auditOnlyDelta(before, snapshot(s.h))).toEqual([HERMES_AUTO_ADOPTION_REFUSED]);
    expect(s.h.cp.audit.byKind(HERMES_AUTO_ADOPTED)).toEqual([]);
    expect(await auto.tick("periodic")).toEqual({ attempted: false, skipped: "REVOKED_BY_DECISION" });
  });

  it("ACP1053-03: refuses a head the audit log would not store exactly, binding nothing", async () => {
    // A head the shared validator admits but AuditLog redacts as secret-shaped.
    const s = scene();
    s.gateway.answer = () => ({ ...s.proof, session_id: `sk-${"Z".repeat(25)}` });
    expect(await s.auto().tick("periodic")).toMatchObject({ attempted: true, decision: { allowed: false } });
    expect(s.h.cp.bindings.active("CEO")).toBeNull();
    expect(s.h.cp.db.all("SELECT binding_generation, status FROM assignments WHERE role_key = 'CEO'"))
      .toEqual([{ binding_generation: s.revokedGeneration, status: "REVOKED" }]);
    expect(s.h.cp.audit.byKind(TARGET_HEAD_ADVANCED)).toEqual([]);
    expect(readHermesTargetHead(s.h.cp.db, s.actorId)?.head).toBe(OLD_HEAD);
    expect(s.h.cp.audit.byKind(HERMES_AUTO_ADOPTION_REFUSED)).toHaveLength(1);
  });
});
