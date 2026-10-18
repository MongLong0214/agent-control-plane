import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { OwnerApprovalReceipt } from "../../src/ceo/owner-authority.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { dispositionForStartupError } from "../../src/daemon/agentcpd.ts";
import { ApprovedRunFinalizer } from "../../src/daemon/finalizer.ts";
import { OWNER_DECIDE_AGAIN_MESSAGE } from "../../src/db/artifacts.ts";
import { Role, RunState, roleKeyFor } from "../../src/domain/types.ts";
import type { GatePayload } from "../../src/github/github-kernel.ts";
import { IngressGuard, ownerApprovalPayload } from "../../src/ingress/ingress-guard.ts";
import { createHermesMcpPort } from "../../src/mcp/hermes-server.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";
import { bindingAsIfCounted } from "../helpers/human-gate-binding.ts";
import { carryRows, laterObjectsIn, releasedChainImage } from "../helpers/released-chain-image.ts";
import { privateStatePath } from "../helpers/released-v44-schema.ts";
import { contentDigests } from "../helpers/released-v45-schema.ts";
import {
  V47_BASE_CHECKSUM,
  V47_CANDIDATE_CHECKSUM,
  V47_R2_CANDIDATE_CHECKSUM,
  asCandidateV47,
  writeOutsideTheGuard,
} from "../helpers/released-v47-schema.ts";
import {
  approveReviewedCandidateForFinalization,
  type Harness,
  driveToReviewedCandidate,
  installDaemonFinalizerGitHubFixture,
  makeHarness,
  ownerDecisionReceipt,
  TEST_OWNER,
} from "../helpers/harness.ts";

/**
 * SEC-OD1 — an owner decision counts only as the canonical record `recordOwnerDecision` writes in the
 * transaction that admits its receipt from live ingress and consumes it. A hand-written OWNER_DECISION
 * artifact plus an OWNER_APPROVAL_CONSUMED row from a connection ACP did not open (the S10-R1 probe)
 * used to satisfy the gate and reach the GitHub publish/merge gate. Every variant below is judged at
 * the gate (humanGateStatus, currentHumanGateDecisionDigest) and through the real kernel gatePublish
 * and mergeExecute against a fake GitHub; nothing is written to a real remote.
 */

afterAll(cleanupTempDirs);

/** The label `ArtifactStore.putOwnerDecision` writes; literal here so this file loads at 788cf9fe too. */
const OWNER_DECISION_LABEL = "production-gate:owner-decision";

const ITEMS = ["irreversible production action", "undelegated public release"] as const;
const [ITEM_A, ITEM_B] = ITEMS;
const OTHER_ACTOR = "someone-else";

const CI_WORKFLOWS = [
  { path: ".github/workflows/ci.yml", checkName: "project-ci", approvedDigest: null, unapprovedFirstActivation: true, repositoryRole: "primary" },
];

interface World {
  harness: Harness;
  github: FakeGitHub;
  runId: string;
  identity: string;
  caller: { ownerSessionId: string; ownerBindingGeneration: number };
  head: string;
  base: string;
  workBranch: string;
  candidate: string;
  /**
   * FIX-FINALIZER-DIGEST — the gate payload, naming the human-gate binding. A world whose gate is
   * satisfied when it is built names that binding, fixed then, so a later decision makes it stale. Any
   * other world names, when read, the binding its latest OWNER_DECISION records would give if they
   * counted (`bindingAsIfCounted`): a refusal is then the gate's judgement of those records.
   */
  readonly payload: GatePayload;
  /** The same payload naming `humanGateDigest`. */
  payloadWith(humanGateDigest: string): GatePayload;
}

/** GitHub's merged-PR snapshot plus its separately reread target ref (as github-hardening models it). */
const reflectMergedBase = (github: FakeGitHub): void => {
  const request = github.request.bind(github);
  github.request = async <T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const response = await request<T>(method, path, body);
    if (method !== "PUT" || !/\/pulls\/\d+\/merge$/.test(path) || !response || typeof response !== "object") {
      return response;
    }
    const merge = response as { merged?: unknown; sha?: unknown };
    const pullNumber = Number(/\/pulls\/(\d+)\/merge$/.exec(path)?.[1]);
    const pull = github.pulls.find((entry) => entry.number === pullNumber);
    if (merge.merged !== true || typeof merge.sha !== "string" || !pull) return response;
    (pull as typeof pull & { merge_commit_sha?: string }).merge_commit_sha = merge.sha;
    github.setBranch(pull.base.ref, merge.sha);
    return response;
  };
};

/** The owner's decision through the only path that records one: admitted ingress, then recordOwnerDecision. */
const decide = (w: Pick<World, "harness" | "runId">, item: string, approved: boolean, note: string): OwnerApprovalReceipt => {
  const receipt = ownerDecisionReceipt(w.harness, w.runId, item, approved, note);
  const recorded = w.harness.cp.ceo.recordOwnerDecision({ runId: w.runId, item, approved, note, receipt });
  if (!recorded.allowed) throw new Error(`${recorded.reasonCode}: ${recorded.message}`);
  return receipt;
};

/**
 * v47 — what `put` (the "service" label) does with an OWNER_DECISION-shaped record now: refuses it at
 * the database, typed as the capability refusal, and stores nothing. Then the same record is written
 * as it stands in a database upgraded from before v47, by a connection outside the guard
 * (`writeOutsideTheGuard`, v47's stated Limit), so the readers' own checks still face it.
 */
const putIsRefusedThenWrittenOutsideTheGuard = <T>(w: Pick<World, "harness">, runId: string, content: T, candidate: string) => {
  const before = w.harness.cp.artifacts.list(runId, "APPROVAL").length;
  let refusal: unknown;
  try {
    w.harness.cp.artifacts.put(runId, "APPROVAL", content, candidate);
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toMatchObject({
    reasonCode: ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
    evidence: { sqlite: "OWNER_DECISION_WRITE_AUTHORITY_DENIED" },
  });
  expect(w.harness.cp.artifacts.list(runId, "APPROVAL")).toHaveLength(before);
  return writeOutsideTheGuard(w.harness.cp.config.databasePath, runId, content, candidate, w.harness.clock.nowIso());
};

/**
 * SEC-OD1-R1-02 — `record` as the code before SEC-OD1 recorded an owner decision: the same admission,
 * consumption and transaction, with the "service" label every decision of that era carries. Since v47
 * `put` refuses that row, so the record is captured in the transaction and written once it commits,
 * as it stands in a database upgraded from before v47 (`putIsRefusedThenWrittenOutsideTheGuard`).
 * Restored afterwards, so nothing else is written this way.
 */
const asBeforeSecOd1 = <T>(w: Pick<World, "harness">, record: () => T): T => {
  const store = w.harness.cp.artifacts;
  const canonical = store.putOwnerDecision;
  const captured: Array<{ runId: string; content: unknown; candidate: string }> = [];
  store.putOwnerDecision = ((_writer: unknown, runId: string, content: unknown, candidate: string) => {
    captured.push({ runId, content, candidate });
    // What the caller is handed is never read: recordOwnerDecision ignores the stored artifact.
    return undefined;
  }) as unknown as typeof store.putOwnerDecision;
  let recorded: T;
  try {
    recorded = record();
  } finally {
    store.putOwnerDecision = canonical;
  }
  for (const { runId, content, candidate } of captured) putIsRefusedThenWrittenOutsideTheGuard(w, runId, content, candidate);
  return recorded;
};

/**
 * A run driven to a reviewed candidate with the two-item gate. `approve` items are decided by the owner
 * first (`before`: as the code before SEC-OD1 recorded them); when they count for the gate the CEO
 * confirms for real, otherwise the fixture stages CEO_APPROVED so the kernel's own re-check is what is
 * exercised.
 */
const world = async (approve: readonly string[] = [], options: { before?: boolean; packetOnly?: boolean } = {}): Promise<World> => {
  const github = new FakeGitHub();
  reflectMergedBase(github);
  const harness = makeHarness({ githubClient: github });
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
  const driven = await driveToReviewedCandidate(harness, {
    workBranch: "feature/F1-thing",
    humanGate: ITEMS,
    manifestOverrides: { ciWorkflows: CI_WORKFLOWS },
  });
  github.setBranch("dev", driven.baseHead);
  github.setBranch("main", "c".repeat(40));
  github.setBranch(driven.workBranch, driven.candidateHead);
  const claimed = harness.cp.claims.acquire({
    runId: driven.runId,
    ownerSessionId: driven.ownerSessionId,
    ownerBindingGeneration: driven.ownerBindingGeneration,
    ownerRoleKey: harness.cp.runs.require(driven.runId).ownerRoleKey!,
    repositoryIdentity: driven.identity,
    branch: driven.workBranch,
    // Outlives the prune control's 24h aging, which is about ingress rows, not this branch lease.
    ttlMs: 7 * 24 * 60 * 60 * 1000,
  });
  if (!claimed.allowed) throw new Error(claimed.message);
  for (const item of approve) {
    const record = () => decide({ harness, runId: driven.runId }, item, true, `approve ${item}`);
    if (options.before) asBeforeSecOd1({ harness }, record);
    else record();
  }
  if (options.packetOnly) {
    // The CTO packet is built and the run waits at CEO review: CONFIRM is left to the test.
    await harness.cp.continuity.evaluate("test finalization packet");
    const packet = harness.cp.ceo.buildPacket({
      runId: driven.runId,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      approval: {
        runId: driven.runId,
        candidateSnapshotDigest: driven.candidateSnapshotDigest,
        resultSummary: "candidate verified",
        recommendation: "merge",
        residualRisk: [],
        approvedBySessionId: driven.ownerSessionId,
        approvedByGeneration: driven.ownerBindingGeneration,
        approvedAt: harness.clock.nowIso(),
      },
    });
    if (!packet.allowed) throw new Error(`${packet.reasonCode}: ${packet.message}`);
  } else {
    await approveReviewedCandidateForFinalization(harness, driven, {
      bypassCeoConfirmation: options.before === true || !ITEMS.every((item) => approve.includes(item)),
    });
  }
  installDaemonFinalizerGitHubFixture(harness);
  const built = harness.cp.ceo.currentHumanGateDecisionDigest(driven.runId);
  const payloadWith = (humanGateDigest: string): GatePayload => ({
    runId: driven.runId,
    candidateSnapshotDigest: driven.candidateSnapshotDigest,
    contractDigest: driven.contractDigest,
    verificationDigest: driven.verificationDigest,
    blindReviewDigest: driven.blindReviewDigest,
    humanGateDigest,
    bindingGeneration: driven.ownerBindingGeneration,
    exactHead: driven.candidateHead,
    timestamp: "2026-08-12T00:00:00.000Z",
  });
  return {
    harness,
    github,
    runId: driven.runId,
    identity: driven.identity,
    caller: { ownerSessionId: driven.ownerSessionId, ownerBindingGeneration: driven.ownerBindingGeneration },
    head: driven.candidateHead,
    base: driven.baseHead,
    workBranch: driven.workBranch,
    candidate: driven.candidateSnapshotDigest,
    get payload(): GatePayload {
      return payloadWith(built.allowed ? built.value : bindingAsIfCounted(harness, driven.runId, ITEMS));
    },
    payloadWith,
  };
};

/** The receipt the owner's recorded decision on `item` carries (its first canonical record). */
const recordedReceipt = (w: World, item: string): OwnerApprovalReceipt => {
  const found = w.harness.cp.artifacts.list<{ kind?: string; item?: string; receipt?: OwnerApprovalReceipt }>(w.runId, "APPROVAL")
    .find((artifact) => artifact.content.kind === "OWNER_DECISION" && artifact.content.item === item);
  if (!found?.content.receipt) throw new Error(`no recorded owner decision for ${item}`);
  return found.content.receipt;
};

/** A receipt nobody admitted: every field is what its writer typed. */
const typedReceipt = (
  w: World,
  item: string,
  note: string,
  overrides: Partial<OwnerApprovalReceipt> = {},
): OwnerApprovalReceipt => ({
  channel: TEST_OWNER.channel,
  actor: TEST_OWNER.actor,
  inboundNonce: "never-admitted",
  runId: w.runId,
  candidateSnapshotDigest: w.candidate,
  operation: "owner_decision_submit",
  parameterDigest: digestOf({ item, approved: true, note }),
  idempotencyKey: `forged:${item}:${note}`,
  approved: true,
  ...overrides,
});

/** The owner's genuine receipt re-pointed at another item, run or candidate: its own bindings recomputed. */
const retarget = (genuine: OwnerApprovalReceipt, item: string, note: string, candidate: string): OwnerApprovalReceipt => ({
  ...genuine,
  candidateSnapshotDigest: candidate,
  parameterDigest: digestOf({ item, approved: true, note }),
  approved: true,
});

/** An owner approval genuinely admitted through ingress for `candidate`, never recorded as a decision. */
const admittedFor = (w: World, item: string, note: string, candidate: string): OwnerApprovalReceipt => {
  const guard = new IngressGuard(w.harness.cp.db, w.harness.cp.clock, w.harness.cp.audit, {
    cli: { allowedActors: [TEST_OWNER.actor] },
  });
  const approval = {
    runId: w.runId,
    candidateSnapshotDigest: candidate,
    operation: "owner_decision_submit",
    parameters: { item, approved: true, note },
    idempotencyKey: `admitted-for:${digestOf({ item, note, candidate })}`,
    approved: true,
  };
  const admitted = guard.admitOwnerApproval(
    { channel: "cli", actor: TEST_OWNER.actor, nonce: `admitted-for:${digestOf(approval)}`, payload: ownerApprovalPayload(approval) },
    approval,
  );
  if (!admitted.allowed) throw new Error(admitted.message);
  return admitted.value;
};

/**
 * The hand-written half of the probe: an OWNER_DECISION-shaped APPROVAL artifact put straight into the
 * store. Since v47 `put` refuses it; it is then written outside the guard, so the gate still faces it.
 */
const handWrite = (w: World, item: string, note: string, receipt: OwnerApprovalReceipt, candidate = w.candidate) =>
  putIsRefusedThenWrittenOutsideTheGuard(w, w.runId, {
    kind: "OWNER_DECISION",
    item,
    approved: true,
    note,
    at: w.harness.clock.nowIso(),
    humanGateDigest: digestOf(ITEMS),
    candidateSnapshotDigest: candidate,
    receipt,
  }, candidate);

/** The other half: an OWNER_APPROVAL_CONSUMED row inserted by a connection ACP did not open. */
const sideConsumption = (w: World, receipt: OwnerApprovalReceipt, candidate: string): void => {
  const side = new Database(w.harness.cp.config.databasePath);
  try {
    const at = w.harness.clock.nowIso();
    side.prepare(`INSERT INTO audit_events (at, kind, run_id, actor, evidence_json) VALUES (?, 'OWNER_APPROVAL_CONSUMED', ?, ?, ?)`)
      .run(at, receipt.runId, `${receipt.channel}:${receipt.actor}`, JSON.stringify({
        receiptDigest: digestOf(receipt),
        candidateSnapshotDigest: candidate,
        channel: receipt.channel,
        actor: receipt.actor,
        operation: receipt.operation,
        approved: receipt.approved,
        runId: receipt.runId,
        consumedAt: at,
      }));
  } finally {
    side.close();
  }
};

const forge = (w: World, item: string, note: string, receipt: OwnerApprovalReceipt, candidate = w.candidate): void => {
  handWrite(w, item, note, receipt, candidate);
  sideConsumption(w, receipt, candidate);
};

/**
 * Each variant forges an approval of ITEM_B on a world where the owner genuinely decided ITEM_A (and,
 * for the refusal variant, genuinely refused ITEM_B). `setup` runs before the forgery.
 */
interface Variant {
  name: string;
  setup?: (w: World) => void;
  forge: (w: World) => void;
}

const VARIANTS: readonly Variant[] = [
  {
    // The S10-R1 probe's shape: an actor who is not the owner and a nonce never admitted.
    name: "a hand-written record plus a fake consumption row (the S10-R1 probe)",
    forge: (w) => forge(w, ITEM_B, "forged", typedReceipt(w, ITEM_B, "forged", { channel: "cli", actor: "not-the-owner" })),
  },
  {
    name: "a hand-written record in the owner's own name, never admitted, plus a fake consumption row",
    forge: (w) => forge(w, ITEM_B, "forged in the owner's name", typedReceipt(w, ITEM_B, "forged in the owner's name")),
  },
  {
    // Genuinely admitted ingress, but from an actor this deployment does not hold as owner.
    name: "another actor: a genuinely admitted non-owner receipt plus a fake consumption row",
    forge: (w) => {
      const receipt = ownerDecisionReceipt(w.harness, w.runId, ITEM_B, true, "not the owner's", OTHER_ACTOR);
      const recorded = w.harness.cp.ceo.recordOwnerDecision({ runId: w.runId, item: ITEM_B, approved: true, note: "not the owner's", receipt });
      expect(recorded.reasonCode).toBe(ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED);
      forge(w, ITEM_B, "not the owner's", receipt);
    },
  },
  {
    // The owner's real decision on another item, re-pointed at this gate item.
    name: "another scope: the owner's recorded decision on another item, re-pointed at this item",
    forge: (w) => {
      const genuine = decide(w, "an item outside this gate", true, "scoped elsewhere");
      forge(w, ITEM_B, "scoped elsewhere", retarget(genuine, ITEM_B, "scoped elsewhere", w.candidate));
    },
  },
  {
    // The owner's real approval of another candidate, re-pointed at the current one.
    name: "another candidate: the owner's admitted approval of another candidate, re-pointed at this one",
    forge: (w) => {
      const other = `sha256:${"e".repeat(64)}`;
      const genuine = admittedFor(w, ITEM_B, "for another candidate", other);
      forge(w, ITEM_B, "for another candidate", retarget(genuine, ITEM_B, "for another candidate", w.candidate));
    },
  },
  {
    name: "overriding a refusal: the owner refused this item, then a forged approval is appended",
    setup: (w) => { decide(w, ITEM_B, false, "refused"); },
    forge: (w) => forge(w, ITEM_B, "override", typedReceipt(w, ITEM_B, "override")),
  },
];

/** "ALLOWED", or the refusal itself, so a red control names why. */
const outcome = (decision: { allowed: boolean; reasonCode?: string; message?: string }): string =>
  decision.allowed ? "ALLOWED" : `${decision.reasonCode}: ${decision.message}`;

const gateAccepts = (w: World): { satisfied: boolean; digest: boolean } => ({
  satisfied: w.harness.cp.ceo.humanGateStatus(w.runId).satisfied,
  digest: w.harness.cp.ceo.currentHumanGateDecisionDigest(w.runId).allowed,
});

const openPull = async (w: World): Promise<number> => {
  const prepared = await w.harness.cp.github.prPrepare({
    runId: w.runId,
    repositoryIdentity: w.identity,
    head: w.workBranch,
    base: "dev",
    title: "candidate",
    body: "",
    ownerSessionId: w.caller.ownerSessionId,
    ownerBindingGeneration: w.caller.ownerBindingGeneration,
    exactHeadSha: w.head,
  });
  if (!prepared.allowed) throw new Error(`${prepared.reasonCode}: ${prepared.message}`);
  return prepared.value.pullNumber;
};

const merge = (w: World, pullNumber: number) => w.harness.cp.github.mergeExecute({
  runId: w.runId,
  repositoryIdentity: w.identity,
  pullNumber,
  exactHeadSha: w.head,
  expectedBaseSha: w.base,
  mergeStrategy: "merge_commit" as const,
  ownerSessionId: w.caller.ownerSessionId,
  ownerBindingGeneration: w.caller.ownerBindingGeneration,
});

/** The real TTL prune: a later admission past the 24h replay window deletes the receipts' ingress rows. */
const pruneIngress = (w: World, receipts: readonly OwnerApprovalReceipt[]): void => {
  w.harness.clock.advance(24 * 60 * 60 * 1000 + 1);
  const guard = new IngressGuard(w.harness.cp.db, w.harness.cp.clock, w.harness.cp.audit, {
    cli: { allowedActors: [TEST_OWNER.actor] },
  });
  expect(guard.admit({ channel: "cli", actor: TEST_OWNER.actor, nonce: "after-the-window", payload: null }).allowed).toBe(true);
  for (const receipt of receipts) {
    expect(w.harness.cp.db.get(
      "SELECT 1 FROM inbound_messages WHERE channel = ? AND nonce = ?",
      [receipt.channel, receipt.inboundNonce],
    )).toBeUndefined();
  }
};

describe("SEC-OD1 the owner gate counts only the canonical owner decision (gate level)", () => {
  for (const variant of VARIANTS) {
    it(`ODGATE refuses ${variant.name}`, async () => {
      const w = await world([ITEM_A]);
      variant.setup?.(w);
      expect(gateAccepts(w)).toEqual({ satisfied: false, digest: false });
      variant.forge(w);
      expect(gateAccepts(w)).toEqual({ satisfied: false, digest: false });
    });
  }

  it("ODGATE refuses another candidate after promotion: approvals of A re-pointed at B", async () => {
    const w = await world([ITEM_A, ITEM_B]);
    expect(gateAccepts(w)).toEqual({ satisfied: true, digest: true });
    const genuine = ITEMS.map((item) => recordedReceipt(w, item));
    const promoted = digestOf({ revisedFrom: w.candidate, revision: 1 });
    w.harness.cp.runs.promoteCandidate(w.runId, promoted);
    expect(gateAccepts(w)).toEqual({ satisfied: false, digest: false });
    ITEMS.forEach((item, index) => {
      forge(w, item, `approve ${item}`, retarget(genuine[index]!, item, `approve ${item}`, promoted), promoted);
    });
    expect(gateAccepts(w)).toEqual({ satisfied: false, digest: false });
  });
});

describe("SEC-OD1 the forged variants stop at the real kernel publish and merge gate", () => {
  for (const variant of VARIANTS) {
    it(`ODPUBLISH refuses ${variant.name}`, async () => {
      const w = await world([ITEM_A]);
      variant.setup?.(w);
      variant.forge(w);
      const published = await w.harness.cp.github.gatePublish(w.payload, w.identity);
      expect(published.reasonCode).toBe(ReasonCode.HUMAN_GATE_UNSATISFIED);
      expect(w.github.checkRuns).toHaveLength(0);
    });

    it(`ODMERGE refuses ${variant.name} after the owner withdrew a published approval`, async () => {
      const w = await world([ITEM_A, ITEM_B]);
      const published = await w.harness.cp.github.gatePublish(w.payload, w.identity);
      if (!published.allowed) throw new Error(`${published.reasonCode}: ${published.message}`);
      const pullNumber = await openPull(w);
      decide(w, ITEM_B, false, "withdrawn");
      variant.setup?.(w);
      variant.forge(w);
      const merged = await merge(w, pullNumber);
      expect(merged.reasonCode).toBe(ReasonCode.HUMAN_GATE_UNSATISFIED);
      expect(w.github.mergeCount).toBe(0);
    });
  }
});

describe("SEC-OD1 controls: a legitimate owner approval passes, and still passes after pruning", () => {
  it("ODCONTROL a legitimate approval satisfies the gate, publishes and merges", async () => {
    const w = await world([ITEM_A, ITEM_B]);
    expect(gateAccepts(w)).toEqual({ satisfied: true, digest: true });
    const published = await w.harness.cp.github.gatePublish(w.payload, w.identity);
    expect(outcome(published)).toBe("ALLOWED");
    const merged = await merge(w, await openPull(w));
    expect(outcome(merged)).toBe("ALLOWED");
    expect(w.github.mergeCount).toBe(1);
  });

  it("ODCONTROL a legitimate approval still publishes and merges after its ingress rows are pruned", async () => {
    const w = await world([ITEM_A, ITEM_B]);
    pruneIngress(w, ITEMS.map((item) => recordedReceipt(w, item)));
    expect(gateAccepts(w)).toEqual({ satisfied: true, digest: true });
    const published = await w.harness.cp.github.gatePublish(w.payload, w.identity);
    expect(outcome(published)).toBe("ALLOWED");
    const merged = await merge(w, await openPull(w));
    expect(outcome(merged)).toBe("ALLOWED");
    expect(w.github.mergeCount).toBe(1);
  });

  it("ODCONTROL an owner's genuine change of mind after a refusal still decides the item", async () => {
    const w = await world([ITEM_A]);
    decide(w, ITEM_B, false, "not yet");
    expect(gateAccepts(w)).toEqual({ satisfied: false, digest: false });
    decide(w, ITEM_B, true, "now yes");
    expect(gateAccepts(w)).toEqual({ satisfied: true, digest: true });
  });
});

describe("SEC-OD1 the canonical record and its writer", () => {
  it("ODAUDIT a contradicting consumption row from another connection takes nothing away", async () => {
    const w = await world([ITEM_A, ITEM_B]);
    sideConsumption(w, recordedReceipt(w, ITEM_B), `sha256:${"d".repeat(64)}`);
    expect(gateAccepts(w)).toEqual({ satisfied: true, digest: true });
    const published = await w.harness.cp.github.gatePublish(w.payload, w.identity);
    expect(outcome(published)).toBe("ALLOWED");
  });

  it("ODWRITER recordOwnerDecision writes the canonical label; put of the same shape is refused (v47), and written outside the guard it carries \"service\"", async () => {
    const w = await world([ITEM_A]);
    const approvals = w.harness.cp.artifacts.list<{ kind?: string; item?: string }>(w.runId, "APPROVAL")
      .filter((artifact) => artifact.content.kind === "OWNER_DECISION");
    expect(approvals.map((artifact) => [artifact.content.item, artifact.producedBy])).toEqual([[ITEM_A, OWNER_DECISION_LABEL]]);
    const stored = handWrite(w, ITEM_B, "put", typedReceipt(w, ITEM_B, "put"));
    expect(stored.producedBy).toBe("service");
  });

  it("ODWRITER refuses a canonical write without the production gate's capability", async () => {
    const w = await world();
    const store = w.harness.cp.artifacts as unknown as {
      putOwnerDecision: (writer: unknown, runId: string, content: unknown, candidate: string) => unknown;
    };
    const content = { kind: "OWNER_DECISION", item: ITEM_A, approved: true, note: "no capability", candidateSnapshotDigest: w.candidate };
    const verification = w.harness.cp.evidenceWritersForTests().VERIFICATION;
    for (const writer of [{ kind: "PRODUCTION_READY_PACKET" }, verification, null]) {
      let refusal: unknown = null;
      try {
        store.putOwnerDecision(writer, w.runId, content, w.candidate);
      } catch (error) {
        refusal = error;
      }
      expect((refusal as { reasonCode?: unknown } | null)?.reasonCode).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);
    }
    expect(w.harness.cp.artifacts.list<{ kind?: string }>(w.runId, "APPROVAL")
      .filter((artifact) => artifact.content.kind === "OWNER_DECISION")).toHaveLength(0);
  });

  it("ODWRITER refuses the production gate's capability issued for another database", async () => {
    const w = await world();
    const elsewhere = makeHarness();
    const store = w.harness.cp.artifacts as unknown as {
      putOwnerDecision: (writer: unknown, runId: string, content: unknown, candidate: string) => unknown;
    };
    const content = { kind: "OWNER_DECISION", item: ITEM_A, approved: true, note: "foreign capability", candidateSnapshotDigest: w.candidate };
    expect(() => store.putOwnerDecision(
      elsewhere.cp.evidenceWritersForTests().PRODUCTION_READY_PACKET, w.runId, content, w.candidate,
    )).toThrowError(/writer capability|capability issued/);
    expect(w.harness.cp.artifacts.list<{ kind?: string }>(w.runId, "APPROVAL")
      .filter((artifact) => artifact.content.kind === "OWNER_DECISION")).toHaveLength(0);
  });

  it("ODWRITER refuses rather than reports recorded when an identical record was put first", async () => {
    const w = await world();
    const note = "pre-empted";
    const receipt = ownerDecisionReceipt(w.harness, w.runId, ITEM_A, true, note);
    // Exactly what recordOwnerDecision would write in this transaction, written first by another
    // writer: `put` is refused since v47, so outside the guard.
    putIsRefusedThenWrittenOutsideTheGuard(w, w.runId, {
      kind: "OWNER_DECISION",
      item: ITEM_A,
      approved: true,
      note,
      at: w.harness.clock.nowIso(),
      humanGateDigest: digestOf(ITEMS),
      candidateSnapshotDigest: w.candidate,
      receipt,
    }, w.candidate);
    const recorded = w.harness.cp.ceo.recordOwnerDecision({ runId: w.runId, item: ITEM_A, approved: true, note, receipt });
    expect(recorded.allowed).toBe(false);
    expect(recorded.reasonCode).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);
    expect(w.harness.cp.audit.byKind("OWNER_APPROVAL_CONSUMED")).toHaveLength(0);
  });

  it("ODBOUNDARY a connection ACP did not open cannot insert the canonical record", async () => {
    const w = await world();
    const side = new Database(w.harness.cp.config.databasePath);
    try {
      expect(() => side.prepare(
        `INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
         VALUES ('art_forged', ?, 'APPROVAL', ?, ?, '{}', ?, ?)`,
      ).run(w.runId, digestOf({}), w.candidate, OWNER_DECISION_LABEL, w.harness.clock.nowIso())).toThrowError(/no such function/);
    } finally {
      side.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// FIX-SEC-R1 (review r1 of PR #1144)

/** Every OWNER_DECISION APPROVAL of the run as [item, approved, producedBy], in durable order. */
const decisionLabels = (w: World): Array<[unknown, unknown, string]> =>
  w.harness.cp.artifacts.list<{ kind?: string; item?: unknown; approved?: unknown }>(w.runId, "APPROVAL")
    .filter((artifact) => artifact.content.kind === "OWNER_DECISION")
    .map((artifact) => [artifact.content.item, artifact.content.approved, artifact.producedBy]);

const OTHER_CANDIDATE = `sha256:${"e".repeat(64)}`;

/** One binding of a decision record changed from the current one; everything else is exact. */
interface Binding {
  item?: string;
  humanGateDigest?: string;
  artifactCandidate?: string;
  contentCandidate?: string;
  /** Overrides on the record's receipt; null writes no receipt at all. */
  receipt?: Partial<OwnerApprovalReceipt> | null;
}

/** The content of an OWNER_DECISION on `item` bound exactly to `w`, except for `binding`. */
const decisionContent = (w: World, approved: boolean, note: string, binding: Binding) => {
  const item = binding.item ?? ITEM_B;
  return {
    kind: "OWNER_DECISION",
    item,
    approved,
    note,
    at: w.harness.clock.nowIso(),
    humanGateDigest: binding.humanGateDigest ?? digestOf(ITEMS),
    candidateSnapshotDigest: binding.contentCandidate ?? w.candidate,
    ...(binding.receipt === null ? {} : {
      receipt: typedReceipt(w, item, note, {
        approved,
        parameterDigest: digestOf({ item, approved, note }),
        ...binding.receipt,
      }),
    }),
  };
};

/**
 * A refusal labelled "service" like every decision recorded before SEC-OD1. `put` refuses it since
 * v47, so it is written outside the guard, as it stands in a database upgraded from before v47.
 */
const putRefusal = (w: World, binding: Binding = {}) =>
  putIsRefusedThenWrittenOutsideTheGuard(w, w.runId, decisionContent(w, false, "refused", binding), binding.artifactCandidate ?? w.candidate);

/**
 * An approval written through the production gate's own capability, so with the canonical label, but
 * with no admission behind it: what only the retained-receipt and binding checks can still refuse.
 */
const putCanonicalApproval = (w: World, binding: Binding = {}) =>
  w.harness.cp.artifacts.putOwnerDecision(
    w.harness.cp.evidenceWritersForTests().PRODUCTION_READY_PACKET,
    w.runId,
    decisionContent(w, true, "approved", binding),
    binding.artifactCandidate ?? w.candidate,
  );

/**
 * Each changes exactly one binding of a record deciding `approved`, so removing the check for that
 * binding is what each one catches.
 */
const UNBOUND: ReadonlyArray<{ name: string; binding: (approved: boolean) => Binding }> = [
  { name: "whose receipt binds other parameters", binding: (approved) => ({ receipt: { parameterDigest: digestOf({ item: ITEM_B, approved, note: "another note" }) } }) },
  { name: "whose receipt binds another run", binding: () => ({ receipt: { runId: "run_another" } }) },
  { name: "whose receipt binds another operation", binding: () => ({ receipt: { operation: "repo_factory_github_write" } }) },
  { name: "whose receipt binds the other decision", binding: (approved) => ({ receipt: { approved: !approved } }) },
  { name: "whose receipt binds another candidate", binding: () => ({ receipt: { candidateSnapshotDigest: OTHER_CANDIDATE } }) },
  { name: "for another gate definition", binding: () => ({ humanGateDigest: digestOf([ITEM_B]) }) },
  { name: "stored for another candidate", binding: () => ({ artifactCandidate: OTHER_CANDIDATE }) },
  { name: "naming another candidate", binding: () => ({ contentCandidate: OTHER_CANDIDATE }) },
];

describe("SEC-OD1-R1-02 refusals: an exactly bound refusal counts whatever its label; any other never blocks", () => {
  it("ODREFUSAL an exactly bound refusal recorded before SEC-OD1 blocks the gate and the kernel publish, with no check run", async () => {
    const w = await world([ITEM_A, ITEM_B]);
    asBeforeSecOd1(w, () => decide(w, ITEM_B, false, "refused before SEC-OD1"));
    expect(decisionLabels(w)).toEqual([
      [ITEM_A, true, OWNER_DECISION_LABEL],
      [ITEM_B, true, OWNER_DECISION_LABEL],
      [ITEM_B, false, "service"],
    ]);
    const published = await w.harness.cp.github.gatePublish(w.payload, w.identity);
    expect({ gate: gateAccepts(w), published: published.reasonCode, checks: w.github.checkRuns.length }).toEqual({
      gate: { satisfied: false, digest: false },
      published: ReasonCode.HUMAN_GATE_UNSATISFIED,
      checks: 0,
    });
    expect(w.harness.cp.ceo.humanGateStatus(w.runId).decideAgain).toBeUndefined();
  });

  it("ODREFUSAL an exactly bound refusal recorded before SEC-OD1 blocks the kernel merge of a published candidate, with no merge", async () => {
    const w = await world([ITEM_A, ITEM_B]);
    expect(outcome(await w.harness.cp.github.gatePublish(w.payload, w.identity))).toBe("ALLOWED");
    const pullNumber = await openPull(w);
    asBeforeSecOd1(w, () => decide(w, ITEM_B, false, "withdrawn before SEC-OD1"));
    const merged = await merge(w, pullNumber);
    expect({ gate: gateAccepts(w), merged: merged.reasonCode, merges: w.github.mergeCount }).toEqual({
      gate: { satisfied: false, digest: false },
      merged: ReasonCode.HUMAN_GATE_UNSATISFIED,
      merges: 0,
    });
  });

  it("ODREFUSAL an exactly bound refusal written by hand blocks too: a refusal can only withhold", async () => {
    const w = await world([ITEM_A, ITEM_B]);
    expect(putRefusal(w).producedBy).toBe("service");
    expect(gateAccepts(w)).toEqual({ satisfied: false, digest: false });
  });

  it("ODREFUSAL the owner's canonical approval after a refusal recorded before SEC-OD1 decides the item again", async () => {
    const w = await world([ITEM_A]);
    asBeforeSecOd1(w, () => decide(w, ITEM_B, false, "not yet, before SEC-OD1"));
    expect(gateAccepts(w)).toEqual({ satisfied: false, digest: false });
    decide(w, ITEM_B, true, "now yes");
    expect(gateAccepts(w)).toEqual({ satisfied: true, digest: true });
  });

  it("ODREFUSAL a refusal of an item outside this gate never blocks", async () => {
    const w = await world([ITEM_A, ITEM_B]);
    expect(putRefusal(w, { item: "an item outside this gate" }).producedBy).toBe("service");
    expect(gateAccepts(w)).toEqual({ satisfied: true, digest: true });
  });

  for (const { name, binding } of UNBOUND) {
    it(`ODREFUSAL a refusal ${name} never blocks`, async () => {
      const w = await world([ITEM_A, ITEM_B]);
      expect(putRefusal(w, binding(false)).producedBy).toBe("service");
      expect(gateAccepts(w)).toEqual({ satisfied: true, digest: true });
      expect(w.harness.cp.ceo.humanGateStatus(w.runId).decideAgain).toBeUndefined();
    });
  }

  it("ODREFUSAL none of those refusals, written together, stops the kernel publish or merge", async () => {
    const w = await world([ITEM_A, ITEM_B]);
    putRefusal(w, { item: "an item outside this gate" });
    for (const { binding } of UNBOUND) putRefusal(w, binding(false));
    expect(outcome(await w.harness.cp.github.gatePublish(w.payload, w.identity))).toBe("ALLOWED");
    expect(outcome(await merge(w, await openPull(w)))).toBe("ALLOWED");
    expect(w.github.mergeCount).toBe(1);
  });
});

describe("SEC-OD1 retained receipt: a canonical record whose receipt or bindings are not this decision's decides nothing", () => {
  it("ODRECEIPT control: the same capability write, exactly bound, decides the item (so each refusal below is its binding's)", async () => {
    const w = await world([ITEM_A]);
    expect(putCanonicalApproval(w).producedBy).toBe(OWNER_DECISION_LABEL);
    expect(gateAccepts(w)).toEqual({ satisfied: true, digest: true });
  });

  it("ODRECEIPT a canonical record with no retained receipt decides nothing", async () => {
    const w = await world([ITEM_A]);
    expect(putCanonicalApproval(w, { receipt: null }).producedBy).toBe(OWNER_DECISION_LABEL);
    expect(gateAccepts(w)).toEqual({ satisfied: false, digest: false });
  });

  for (const { name, binding } of UNBOUND) {
    it(`ODRECEIPT a canonical record ${name} decides nothing`, async () => {
      const w = await world([ITEM_A]);
      expect(putCanonicalApproval(w, binding(true)).producedBy).toBe(OWNER_DECISION_LABEL);
      expect(gateAccepts(w)).toEqual({ satisfied: false, digest: false });
    });
  }
});

describe("SEC-OD1-R1-02 approvals recorded before SEC-OD1 do not count, and the refusal says to decide again", () => {
  for (const prune of [false, true]) {
    it(`ODLEGACY approvals recorded before SEC-OD1${prune ? ", their ingress pruned," : ""} are refused at the gate, the decision digest and the kernel publish, naming the items to decide again`, async () => {
      const w = await world([...ITEMS], { before: true });
      expect(decisionLabels(w)).toEqual([[ITEM_A, true, "service"], [ITEM_B, true, "service"]]);
      if (prune) pruneIngress(w, ITEMS.map((item) => recordedReceipt(w, item)));
      const decideAgain = { decideAgain: [...ITEMS], remedy: "NEW_OWNER_DECISION" };
      expect(w.harness.cp.ceo.humanGateStatus(w.runId)).toEqual({ required: true, items: [...ITEMS], satisfied: false, decideAgain: [...ITEMS] });
      expect(w.harness.cp.ceo.currentHumanGateDecisionDigest(w.runId)).toMatchObject({
        allowed: false, reasonCode: ReasonCode.HUMAN_GATE_UNSATISFIED, message: OWNER_DECIDE_AGAIN_MESSAGE, evidence: decideAgain,
      });
      expect(await w.harness.cp.github.gatePublish(w.payload, w.identity)).toMatchObject({
        allowed: false, reasonCode: ReasonCode.HUMAN_GATE_UNSATISFIED, message: OWNER_DECIDE_AGAIN_MESSAGE, evidence: decideAgain,
      });
      expect(w.github.checkRuns).toHaveLength(0);
      // The owner decides again through the canonical path, and a payload naming the new decisions
      // publishes (FIX-FINALIZER-DIGEST: the binding names each decision, so the legacy one is gone).
      const legacy = w.payload.humanGateDigest;
      for (const item of ITEMS) decide(w, item, true, `decided again: ${item}`);
      expect(w.harness.cp.ceo.humanGateStatus(w.runId)).toEqual({ required: true, items: [...ITEMS], satisfied: true });
      expect(w.payload.humanGateDigest).not.toBe(legacy);
      expect(w.harness.cp.ceo.currentHumanGateDecisionDigest(w.runId)).toMatchObject({ allowed: true, value: w.payload.humanGateDigest });
      expect(outcome(await w.harness.cp.github.gatePublish(w.payload, w.identity))).toBe("ALLOWED");
    });
  }

  it("ODLEGACY only an undecided item whose latest bound approval is not canonical is named, and a later canonical decision clears it", async () => {
    const w = await world([ITEM_A]);
    // ITEM_A keeps its canonical approval; a later approval without the label changes nothing for it.
    asBeforeSecOd1(w, () => decide(w, ITEM_A, true, "again, without the canonical label"));
    asBeforeSecOd1(w, () => decide(w, ITEM_B, true, "approved before SEC-OD1"));
    expect(w.harness.cp.ceo.humanGateStatus(w.runId)).toEqual({ required: true, items: [...ITEMS], satisfied: false, decideAgain: [ITEM_B] });
    expect(w.harness.cp.ceo.currentHumanGateDecisionDigest(w.runId).evidence).toMatchObject({ decideAgain: [ITEM_B] });
    // The owner's canonical refusal then decides ITEM_B: nothing is left to decide again.
    decide(w, ITEM_B, false, "refused");
    expect(w.harness.cp.ceo.humanGateStatus(w.runId)).toEqual({ required: true, items: [...ITEMS], satisfied: false });
    expect(w.harness.cp.ceo.currentHumanGateDecisionDigest(w.runId)).toMatchObject({
      allowed: false, message: "every current owner-gate item needs approval",
    });
  });

  it("ODCOMPLETED a run completed on approvals recorded before SEC-OD1 stays COMPLETED: its status and result read, and nothing is written again", async () => {
    const w = await world([...ITEMS], { before: true });
    // How such a run completed: the reader before SEC-OD1 counted these rows (the review's base run of
    // this fixture: satisfied, publish ALLOWED). That verdict is stood in for this drive only.
    // FIX-FINALIZER-DIGEST: the kernel reads the gate through `humanGateBinding`, so that is what stands in.
    const ceo = w.harness.cp.ceo;
    const named = w.payload.humanGateDigest;
    ceo.humanGateBinding = () => ({ required: true, items: [...ITEMS], satisfied: true, humanGateDigest: named });
    try {
      expect(outcome(await w.harness.cp.github.gatePublish(w.payload, w.identity))).toBe("ALLOWED");
      expect(outcome(await merge(w, await openPull(w)))).toBe("ALLOWED");
    } finally {
      Reflect.deleteProperty(ceo, "humanGateBinding");
    }
    const completion = w.harness.cp.completionAuthoritiesForTests().daemonFinalizer;
    expect(w.harness.cp.runs.transition(w.runId, RunState.MERGING, "completed before SEC-OD1").allowed).toBe(true);
    expect(w.harness.cp.runs.transition(w.runId, RunState.POST_MERGE_VERIFYING, "completed before SEC-OD1").allowed).toBe(true);
    expect(w.harness.cp.runs.transition(w.runId, RunState.COMPLETED, "completed before SEC-OD1", {}, completion).allowed).toBe(true);
    const external = () => ({
      writes: w.github.calls.filter((call) => call.method !== "GET").length,
      merges: w.github.mergeCount,
      checks: w.github.checkRuns.length,
    });
    const completed = external();
    expect(completed).toMatchObject({ merges: 1, checks: 1 });

    // Status (run_get, as RUN_SHOW): it reads, and says the approvals must be decided again.
    const view = createHermesMcpPort(w.harness.cp).runView(w.runId);
    expect(view?.run.state).toBe(RunState.COMPLETED);
    expect(view?.humanGate).toEqual({ required: true, items: [...ITEMS], satisfied: false, decideAgain: [...ITEMS] });
    // Result: the finalizer answers from its durable receipts and reopens nothing.
    const result = await new ApprovedRunFinalizer(w.harness.cp, "sec-od1-completed").finalizeApprovedRun(w.runId);
    expect(result).toMatchObject({
      allowed: true,
      reasonCode: ReasonCode.MERGE_IDEMPOTENT_REPLAY,
      value: { state: RunState.COMPLETED, repositories: [{ repositoryIdentity: w.identity }] },
    });
    expect(w.harness.cp.runs.require(w.runId).state).toBe(RunState.COMPLETED);
    expect(external()).toEqual(completed);
  });
});

/**
 * SEC-OD1-R1-01 — the review's counterexample: the canonical label written by an ordinary in-process
 * `Db.run`, with no capability, no admitted receipt and no allowlisted actor. Code alone could not refuse
 * it. Before v47 these two were expected failures (`it.fails`, never a security PASS); the v47 authority
 * guard (`run_artifacts_owner_decision_authority_guard`) refuses the insert itself, so each is now an
 * ordinary test: the write is refused, nothing is stored, and the gate, the kernel publish and the
 * kernel merge refuse with no GitHub write.
 */
const forgedDecision = (w: World, item: string, note: string) => ({
  kind: "OWNER_DECISION",
  item,
  approved: true,
  note,
  receipt: typedReceipt(w, item, note, { actor: "not-the-owner" }),
  humanGateDigest: digestOf(ITEMS),
  candidateSnapshotDigest: w.candidate,
});

/** The forgery as an ordinary `Db.run` on ACP's own connection; returns what it threw (nothing, if admitted). */
const viaDbRun = (w: World, content: Record<string, unknown>, label: string, verb = "INSERT"): unknown => {
  try {
    w.harness.cp.db.run(
      `${verb} INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
       VALUES (?, ?, 'APPROVAL', ?, ?, ?, ?, ?)`,
      [`art_v47_${digestOf({ content, label, verb }).slice(7, 31)}`, w.runId, digestOf(content), w.candidate, JSON.stringify(content), label, w.harness.clock.nowIso()],
    );
    return undefined;
  } catch (error) {
    return error;
  }
};

/** The v47 refusal, typed as the capability refusal and naming the trigger's sentinel. */
const V47_REFUSAL = { reasonCode: ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE, evidence: { sqlite: "OWNER_DECISION_WRITE_AUTHORITY_DENIED" } };

/** Every APPROVAL row of the run as [producedBy, content kind], so a stored forgery is visible. */
const approvalRows = (w: World): Array<[string, unknown]> =>
  w.harness.cp.artifacts.list<{ kind?: unknown }>(w.runId, "APPROVAL").map((artifact) => [artifact.producedBy, artifact.content.kind]);

/** The connection-local marker as ACP's own connection reads it outside any capability write. */
const markerNow = (w: World): unknown =>
  w.harness.cp.db.get<{ v: unknown }>("SELECT acp_evidence_write_authorized() AS v")?.v;

describe("SEC-OD1-R1-01 the v47 authority guard refuses an ordinary Db.run forgery (formerly ODV47-KNOWN-FAIL)", () => {
  it("ODV47 a Db.run of the canonical label, never admitted, is refused at write and does not publish", async () => {
    const w = await world([ITEM_A]);
    expect(gateAccepts(w)).toEqual({ satisfied: false, digest: false });
    const rows = approvalRows(w);
    const forged = forgedDecision(w, ITEM_B, "not admitted; ordinary Db.run");
    expect(viaDbRun(w, forged, OWNER_DECISION_LABEL)).toMatchObject(V47_REFUSAL);
    expect(approvalRows(w)).toEqual(rows);
    // The payload names the binding the refused row would have given had it been stored and counted.
    const payload = w.payloadWith(bindingAsIfCounted(w.harness, w.runId, ITEMS, { [ITEM_B]: digestOf(forged) }));
    const published = await w.harness.cp.github.gatePublish(payload, w.identity);
    const observed = { gate: gateAccepts(w), published: outcome(published), checks: w.github.checkRuns.length };
    expect(published.reasonCode, JSON.stringify(observed)).toBe(ReasonCode.HUMAN_GATE_UNSATISFIED);
    expect(w.github.checkRuns).toHaveLength(0);
  });

  it("ODV47 a Db.run of the canonical label is refused at write and does not override the owner's refusal at merge", async () => {
    const w = await world([ITEM_A, ITEM_B]);
    expect(outcome(await w.harness.cp.github.gatePublish(w.payload, w.identity))).toBe("ALLOWED");
    const pullNumber = await openPull(w);
    decide(w, ITEM_B, false, "owner refused");
    expect(gateAccepts(w)).toEqual({ satisfied: false, digest: false });
    const rows = approvalRows(w);
    expect(viaDbRun(w, forgedDecision(w, ITEM_B, "overriding the refusal; ordinary Db.run"), OWNER_DECISION_LABEL)).toMatchObject(V47_REFUSAL);
    expect(approvalRows(w)).toEqual(rows);
    const merged = await merge(w, pullNumber);
    const observed = { gate: gateAccepts(w), merged: outcome(merged), merges: w.github.mergeCount };
    expect(merged.reasonCode, JSON.stringify(observed)).toBe(ReasonCode.HUMAN_GATE_UNSATISFIED);
    expect(w.github.mergeCount).toBe(0);
  });

  it("ODV47 OWNER_DECISION content under the \"service\" label, the canonical label on other content, and INSERT OR REPLACE are each refused", async () => {
    const w = await world([ITEM_A]);
    const rows = approvalRows(w);
    const content = forgedDecision(w, ITEM_B, "legacy-looking");
    // A new legacy-looking approval or refusal can no longer be created by `Db.run`.
    expect(viaDbRun(w, content, "service")).toMatchObject(V47_REFUSAL);
    expect(viaDbRun(w, { ...content, approved: false }, "service")).toMatchObject(V47_REFUSAL);
    // The label alone is enough, whatever the content says.
    expect(viaDbRun(w, { kind: "NOT_A_DECISION", item: ITEM_B }, OWNER_DECISION_LABEL)).toMatchObject(V47_REFUSAL);
    // A duplicate key hides the kind from SQLite's `$.kind` and not from JSON.parse; the guard reads every member.
    const duplicated = (w2: World) => `{"kind":"NOT_A_DECISION","kind":"OWNER_DECISION","item":${JSON.stringify(ITEM_B)},"approved":true,"candidateSnapshotDigest":${JSON.stringify(w2.candidate)}}`;
    expect(JSON.parse(duplicated(w)).kind).toBe("OWNER_DECISION");
    let duplicateRefusal: unknown;
    try {
      w.harness.cp.db.run(
        `INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
         VALUES ('art_v47_duplicate_key', ?, 'APPROVAL', ?, ?, ?, 'service', ?)`,
        [w.runId, digestOf(duplicated(w)), w.candidate, duplicated(w), w.harness.clock.nowIso()],
      );
    } catch (error) {
      duplicateRefusal = error;
    }
    expect(duplicateRefusal).toMatchObject(V47_REFUSAL);
    for (const verb of ["INSERT OR REPLACE", "REPLACE", "INSERT OR IGNORE"]) {
      expect(viaDbRun(w, content, OWNER_DECISION_LABEL, verb)).toMatchObject(V47_REFUSAL);
    }
    expect(approvalRows(w)).toEqual(rows);
    expect(gateAccepts(w)).toEqual({ satisfied: false, digest: false });
  });

  it("ODV47 an UPDATE into the canonical shape, or of a written decision's content or bindings, stays refused by run_artifacts_content_immutable", async () => {
    const w = await world([ITEM_A]);
    const ordinary = w.harness.cp.artifacts.list<{ kind?: unknown }>(w.runId, "APPROVAL").find((artifact) => artifact.producedBy === "service");
    const decision = w.harness.cp.artifacts.list<{ kind?: unknown }>(w.runId, "APPROVAL").find((artifact) => artifact.producedBy === OWNER_DECISION_LABEL);
    expect(ordinary).toBeDefined();
    expect(decision).toBeDefined();
    const before = approvalRows(w);
    const refusedWith = (sql: string, params: unknown[]): unknown => {
      try {
        w.harness.cp.db.run(sql, params);
        return undefined;
      } catch (error) {
        return error;
      }
    };
    const immutable = { reasonCode: ReasonCode.CONFLICT, evidence: { sqlite: "ARTIFACT_IMMUTABLE" } };
    const forged = JSON.stringify(forgedDecision(w, ITEM_B, "updated into shape"));
    for (const [sql, params] of [
      ["UPDATE run_artifacts SET produced_by = ? WHERE artifact_id = ?", [OWNER_DECISION_LABEL, ordinary!.artifactId]],
      ["UPDATE run_artifacts SET content_json = ? WHERE artifact_id = ?", [forged, ordinary!.artifactId]],
      ["UPDATE run_artifacts SET content_json = ?, produced_by = ? WHERE artifact_id = ?", [forged, OWNER_DECISION_LABEL, ordinary!.artifactId]],
      ["UPDATE OR REPLACE run_artifacts SET produced_by = ? WHERE artifact_id = ?", [OWNER_DECISION_LABEL, ordinary!.artifactId]],
      ["UPDATE run_artifacts SET content_json = ? WHERE artifact_id = ?", [JSON.stringify({ ...decision!.content as object, item: ITEM_B }), decision!.artifactId]],
      ["UPDATE run_artifacts SET candidate_snapshot_digest = ? WHERE artifact_id = ?", [OTHER_CANDIDATE, decision!.artifactId]],
      ["UPDATE run_artifacts SET run_id = run_id, digest = ? WHERE artifact_id = ?", [digestOf("other"), decision!.artifactId]],
      ["UPDATE run_artifacts SET produced_by = 'service' WHERE artifact_id = ?", [decision!.artifactId]],
    ] as Array<[string, unknown[]]>) {
      expect(refusedWith(sql, params), sql).toMatchObject(immutable);
    }
    // REPLACE onto the written decision's own row id is refused before it can delete it.
    expect(refusedWith(
      `INSERT OR REPLACE INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
       VALUES (?, ?, 'APPROVAL', ?, ?, '{}', 'service', ?)`,
      [decision!.artifactId, w.runId, digestOf("replaced"), w.candidate, w.harness.clock.nowIso()],
    )).toMatchObject({ reasonCode: ReasonCode.CONFLICT, evidence: { sqlite: "RUN_ARTIFACT_NO_REPLACE" } });
    expect(approvalRows(w)).toEqual(before);
    expect(w.harness.cp.artifacts.list(w.runId, "APPROVAL").find((artifact) => artifact.artifactId === decision!.artifactId))
      .toEqual(decision);
  });
});

describe("SEC-OD1 v47 capability scope: the marker is held for one statement of the formal path and never reused", () => {
  it("ODSCOPE the formal path writes the canonical record; ordinary Db.run before, after and inside the same transaction is refused", async () => {
    const w = await world([ITEM_A]);
    expect(markerNow(w)).toBe(0);
    const rows = approvalRows(w);
    const writer = w.harness.cp.evidenceWritersForTests().PRODUCTION_READY_PACKET;
    let inside: unknown = "not reached";
    let threw: unknown;
    try {
      w.harness.cp.db.tx(() => {
        w.harness.cp.artifacts.putOwnerDecision(writer, w.runId, decisionContent(w, true, "inside a transaction", { item: ITEM_B }), w.candidate);
        inside = viaDbRun(w, forgedDecision(w, ITEM_B, "same transaction, after the capability write"), OWNER_DECISION_LABEL);
        throw new Error("the transaction fails after the capability write");
      });
    } catch (error) {
      threw = error;
    }
    expect(inside).toMatchObject(V47_REFUSAL);
    expect(String(threw)).toMatch(/the transaction fails after the capability write/);
    // The failed transaction kept nothing, and left no marker behind.
    expect(approvalRows(w)).toEqual(rows);
    expect(markerNow(w)).toBe(0);
    expect(viaDbRun(w, forgedDecision(w, ITEM_B, "after a failed transaction"), OWNER_DECISION_LABEL)).toMatchObject(V47_REFUSAL);
    // The formal path itself still writes, and leaves no marker behind either.
    expect(w.harness.cp.artifacts.putOwnerDecision(writer, w.runId, decisionContent(w, true, "formal", { item: ITEM_B }), w.candidate).producedBy)
      .toBe(OWNER_DECISION_LABEL);
    expect(markerNow(w)).toBe(0);
    expect(viaDbRun(w, forgedDecision(w, ITEM_B, "after a capability write"), OWNER_DECISION_LABEL)).toMatchObject(V47_REFUSAL);
  });

  it("ODSCOPE a capability write that throws inside its own statement leaves no marker; the next Db.run is refused", async () => {
    const w = await world([ITEM_A]);
    const writer = w.harness.cp.evidenceWritersForTests().PRODUCTION_READY_PACKET;
    // The insert itself fails (no such run: a foreign-key refusal) while the marker is held.
    expect(() => w.harness.cp.artifacts.putOwnerDecision(writer, "run_that_does_not_exist", decisionContent(w, true, "no run", { item: ITEM_B }), w.candidate))
      .toThrowError();
    expect(markerNow(w)).toBe(0);
    const rows = approvalRows(w);
    expect(viaDbRun(w, forgedDecision(w, ITEM_B, "after a failed capability write"), OWNER_DECISION_LABEL)).toMatchObject(V47_REFUSAL);
    expect(approvalRows(w)).toEqual(rows);
    expect(gateAccepts(w)).toEqual({ satisfied: false, digest: false });
  });
});

describe("SEC-OD1 v47: an exactly bound owner refusal blocks CONFIRM and the kernel publish with no GitHub write", () => {
  const confirm = (w: World) => {
    const ceo = w.harness.cp.bindings.active(roleKeyFor(Role.CEO));
    if (!ceo) throw new Error("fixture CEO binding missing");
    return w.harness.cp.ceo.submitCeoDecision({
      runId: w.runId,
      decision: "CONFIRM",
      candidateSnapshotDigest: w.candidate,
      ceoSessionId: ceo.sessionId,
      rationale: "confirm at CEO review",
    });
  };
  const githubWrites = (w: World): number => w.github.calls.filter((call) => call.method !== "GET").length;

  it("ODV47-REFUSAL control: with both items approved through the formal path, CONFIRM is allowed", async () => {
    const w = await world([ITEM_A], { packetOnly: true });
    decide(w, ITEM_B, true, "approved");
    expect(outcome(confirm(w))).toBe("ALLOWED");
  });

  it("ODV47-REFUSAL the owner refuses an item and a Db.run forgery of its approval is refused: CONFIRM and gatePublish refuse, 0 GitHub writes", async () => {
    const w = await world([ITEM_A], { packetOnly: true });
    decide(w, ITEM_B, false, "refused, exactly bound");
    expect(viaDbRun(w, forgedDecision(w, ITEM_B, "override attempt"), OWNER_DECISION_LABEL)).toMatchObject(V47_REFUSAL);
    expect(gateAccepts(w)).toEqual({ satisfied: false, digest: false });
    expect(confirm(w)).toMatchObject({ allowed: false, reasonCode: ReasonCode.HUMAN_GATE_UNSATISFIED });
    expect((await w.harness.cp.github.gatePublish(w.payload, w.identity)).reasonCode).toBe(ReasonCode.HUMAN_GATE_UNSATISFIED);
    expect({ writes: githubWrites(w), checks: w.github.checkRuns.length, merges: w.github.mergeCount })
      .toEqual({ writes: 0, checks: 0, merges: 0 });
  });
});

// ---------------------------------------------------------------------------------------------------
// SEC-OD1 v48 (CEO 072dbccb)

/**
 * The review's residual after v47 (followup-fix/v47-guard-evidence/residual-superseded-probe.log): the
 * owner refuses an item they had approved, an ordinary `Db.run` sets the one-way superseded mark on that
 * refusal (`run_artifacts_content_immutable` lets exactly that flag change), the earlier approval decides
 * the item again, and the kernel merges. v48's `run_artifacts_owner_decision_supersede_guard` refuses the
 * mark on an owner decision unless the connection-local marker is exactly 1, which only the run engine's
 * staleness marks hold, for their one statement. Every ODV48 counterexample here is RED at 05b46d76 (v47):
 * the withdrawal is admitted and the gate, the publish, CONFIRM or the merge is allowed.
 */
const V48_REFUSAL = { reasonCode: ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE, evidence: { sqlite: "OWNER_DECISION_SUPERSEDE_AUTHORITY_DENIED" } };

/** `sql` as an ordinary `Db.run` on ACP's own connection; what it threw, or undefined if admitted. */
const viaDb = (w: World, sql: string, params: unknown[] = []): unknown => {
  try {
    w.harness.cp.db.run(sql, params);
    return undefined;
  } catch (error) {
    return error;
  }
};

/** The record of the owner's latest refusal of `item`: what the counterexample withdraws. */
const refusalOf = (w: World, item: string) =>
  w.harness.cp.artifacts.list<{ kind?: string; item?: string; approved?: boolean }>(w.runId, "APPROVAL")
    .filter((artifact) => artifact.content.kind === "OWNER_DECISION" && artifact.content.item === item && artifact.content.approved === false)
    .at(-1)!;

/** The reviewer's write: the one-way mark on that refusal, by an ordinary `Db.run`. */
const withdraw = (w: World, artifactId: string): unknown =>
  viaDb(w, "UPDATE run_artifacts SET superseded = 1 WHERE artifact_id = ?", [artifactId]);

/** Every artifact of the run as [id, superseded], so a withdrawal that slipped through is visible. */
const supersededFlags = (w: World): Array<[string, boolean]> =>
  w.harness.cp.artifacts.list(w.runId).map((artifact) => [artifact.artifactId, artifact.superseded]);

const writesToGitHub = (w: World): number => w.github.calls.filter((call) => call.method !== "GET").length;

const ceoConfirm = (w: World) => {
  const ceo = w.harness.cp.bindings.active(roleKeyFor(Role.CEO));
  if (!ceo) throw new Error("fixture CEO binding missing");
  return w.harness.cp.ceo.submitCeoDecision({
    runId: w.runId,
    decision: "CONFIRM",
    candidateSnapshotDigest: w.candidate,
    ceoSessionId: ceo.sessionId,
    rationale: "confirm at CEO review",
  });
};

describe("SEC-OD1 v48: the owner's refusal cannot be withdrawn by an ordinary write (the review's counterexample)", () => {
  it("ODV48 at the kernel merge: approve, publish, refuse; a Db.run withdrawal of the refusal is refused, the approval does not revive, the merge is refused with 0 GitHub writes", async () => {
    const w = await world([ITEM_A, ITEM_B]);
    expect(outcome(await w.harness.cp.github.gatePublish(w.payload, w.identity))).toBe("ALLOWED");
    const pullNumber = await openPull(w);
    decide(w, ITEM_B, false, "owner refused after publish");
    expect(gateAccepts(w)).toEqual({ satisfied: false, digest: false });
    const flags = supersededFlags(w);
    const writes = writesToGitHub(w);
    const attempt = withdraw(w, refusalOf(w, ITEM_B).artifactId);
    const merged = await merge(w, pullNumber);
    const observed = { updateError: attempt === undefined ? null : String(attempt), gate: gateAccepts(w), merged: outcome(merged), merges: w.github.mergeCount };
    expect(attempt, JSON.stringify(observed)).toMatchObject(V48_REFUSAL);
    expect(supersededFlags(w)).toEqual(flags);
    expect(observed.gate).toEqual({ satisfied: false, digest: false });
    expect(merged.reasonCode, JSON.stringify(observed)).toBe(ReasonCode.HUMAN_GATE_UNSATISFIED);
    expect({ writes: writesToGitHub(w) - writes, merges: w.github.mergeCount }).toEqual({ writes: 0, merges: 0 });
  });

  it("ODV48 at the gate and the kernel publish: refused after approval, the withdrawal is refused and gatePublish refuses with 0 GitHub writes", async () => {
    const w = await world([ITEM_A, ITEM_B]);
    decide(w, ITEM_B, false, "owner refused before publish");
    const writes = writesToGitHub(w);
    const attempt = withdraw(w, refusalOf(w, ITEM_B).artifactId);
    const published = await w.harness.cp.github.gatePublish(w.payload, w.identity);
    const observed = { gate: gateAccepts(w), published: outcome(published), checks: w.github.checkRuns.length };
    expect(attempt, JSON.stringify(observed)).toMatchObject(V48_REFUSAL);
    expect(observed.gate).toEqual({ satisfied: false, digest: false });
    expect(published.reasonCode, JSON.stringify(observed)).toBe(ReasonCode.HUMAN_GATE_UNSATISFIED);
    expect({ writes: writesToGitHub(w) - writes, checks: w.github.checkRuns.length, merges: w.github.mergeCount })
      .toEqual({ writes: 0, checks: 0, merges: 0 });
  });

  it("ODV48 at CEO CONFIRM: approve, then refuse; the withdrawal is refused, and CONFIRM and gatePublish refuse with 0 GitHub writes", async () => {
    const w = await world([ITEM_A], { packetOnly: true });
    decide(w, ITEM_B, true, "approved first");
    decide(w, ITEM_B, false, "then refused");
    const attempt = withdraw(w, refusalOf(w, ITEM_B).artifactId);
    const confirmed = ceoConfirm(w);
    const observed = { gate: gateAccepts(w), confirmed: outcome(confirmed) };
    expect(attempt, JSON.stringify(observed)).toMatchObject(V48_REFUSAL);
    expect(confirmed, JSON.stringify(observed)).toMatchObject({ allowed: false, reasonCode: ReasonCode.HUMAN_GATE_UNSATISFIED });
    expect((await w.harness.cp.github.gatePublish(w.payload, w.identity)).reasonCode).toBe(ReasonCode.HUMAN_GATE_UNSATISFIED);
    expect({ writes: writesToGitHub(w), checks: w.github.checkRuns.length, merges: w.github.mergeCount })
      .toEqual({ writes: 0, checks: 0, merges: 0 });
  });

  it("ODV48 a refusal recorded before SEC-OD1 (labelled \"service\") cannot be withdrawn either: the merge is refused with 0 GitHub writes", async () => {
    const w = await world([ITEM_A, ITEM_B]);
    expect(outcome(await w.harness.cp.github.gatePublish(w.payload, w.identity))).toBe("ALLOWED");
    const pullNumber = await openPull(w);
    asBeforeSecOd1(w, () => decide(w, ITEM_B, false, "refused before SEC-OD1"));
    const legacy = refusalOf(w, ITEM_B);
    expect(legacy.producedBy).toBe("service");
    const writes = writesToGitHub(w);
    const attempt = withdraw(w, legacy.artifactId);
    const merged = await merge(w, pullNumber);
    const observed = { gate: gateAccepts(w), merged: outcome(merged), merges: w.github.mergeCount };
    expect(attempt, JSON.stringify(observed)).toMatchObject(V48_REFUSAL);
    expect(merged.reasonCode, JSON.stringify(observed)).toBe(ReasonCode.HUMAN_GATE_UNSATISFIED);
    expect({ writes: writesToGitHub(w) - writes, merges: w.github.mergeCount }).toEqual({ writes: 0, merges: 0 });
  });

  it("ODV48 the same withdrawal in every other write form on ACP's connection is refused, and the refusal still decides", async () => {
    const w = await world([ITEM_A, ITEM_B]);
    decide(w, ITEM_B, false, "owner refused");
    const refusal = refusalOf(w, ITEM_B);
    const other = w.harness.cp.artifacts.list(w.runId).find((artifact) => artifact.kind !== "APPROVAL" && !artifact.superseded)!;
    expect(other).toBeDefined();
    const rowid = w.harness.cp.db.get<{ r: number }>("SELECT rowid AS r FROM run_artifacts WHERE artifact_id = ?", [refusal.artifactId])!.r;
    const flags = supersededFlags(w);
    const now = w.harness.clock.nowIso();
    const forms: Array<[string, string, unknown[]]> = [
      ["UPDATE OR IGNORE", "UPDATE OR IGNORE run_artifacts SET superseded = 1 WHERE artifact_id = ?", [refusal.artifactId]],
      ["UPDATE OR REPLACE", "UPDATE OR REPLACE run_artifacts SET superseded = 1 WHERE artifact_id = ?", [refusal.artifactId]],
      ["the text '1'", "UPDATE run_artifacts SET superseded = '1' WHERE artifact_id = ?", [refusal.artifactId]],
      ["a CTE", "WITH target(id) AS (SELECT ?) UPDATE run_artifacts SET superseded = 1 WHERE artifact_id IN (SELECT id FROM target)", [refusal.artifactId]],
      ["every APPROVAL of the run", "UPDATE run_artifacts SET superseded = 1 WHERE run_id = ? AND kind = 'APPROVAL'", [w.runId]],
      ["DELETE", "DELETE FROM run_artifacts WHERE artifact_id = ?", [refusal.artifactId]],
      ["DELETE of the run (cascade)", "DELETE FROM runs WHERE run_id = ?", [w.runId]],
      ["INSERT OR REPLACE on its id", `INSERT OR REPLACE INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
        VALUES (?, ?, 'PLAN', ?, NULL, '{}', 'service', ?)`, [refusal.artifactId, w.runId, digestOf("replaced by id"), now]],
      ["INSERT OR REPLACE on its rowid", `INSERT OR REPLACE INTO run_artifacts (rowid, artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
        VALUES (?, 'art_v48_by_rowid', ?, 'PLAN', ?, NULL, '{}', 'service', ?)`, [rowid, w.runId, digestOf("replaced by rowid"), now]],
      ["UPDATE OR REPLACE … SET rowid onto it", "UPDATE OR REPLACE run_artifacts SET superseded = 1, rowid = ? WHERE artifact_id = ?", [rowid, other.artifactId]],
    ];
    const outcomes = forms.map(([name, sql, params]) => [name, viaDb(w, sql, params) === undefined ? "ADMITTED" : "refused"]);
    expect(outcomes).toEqual(forms.map(([name]) => [name, "refused"]));
    for (const [name, sql, params] of forms.slice(0, 5)) expect(viaDb(w, sql, params), name).toMatchObject(V48_REFUSAL);
    let reinserted: unknown;
    try {
      w.harness.cp.db.tx(() => {
        w.harness.cp.db.run("DELETE FROM run_artifacts WHERE artifact_id = ?", [refusal.artifactId]);
        w.harness.cp.db.run(
          `INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
           VALUES (?, ?, 'PLAN', ?, NULL, '{}', 'service', ?)`,
          [refusal.artifactId, w.runId, digestOf("reinserted"), now],
        );
      });
    } catch (error) {
      reinserted = error;
    }
    expect(reinserted).toMatchObject({ evidence: { sqlite: "ARTIFACT_IMMUTABLE" } });
    expect(supersededFlags(w)).toEqual(flags);
    expect(refusalOf(w, ITEM_B)).toEqual(refusal);
    expect(gateAccepts(w)).toEqual({ satisfied: false, digest: false });
  });

  it("ODV48-LIMIT (CEO 52c3b1e6 (b)): a connection that defines the marker itself, to return 1, withdraws the refusal and the earlier approval decides again", async () => {
    const w = await world([ITEM_A, ITEM_B]);
    decide(w, ITEM_B, false, "owner refused");
    expect(gateAccepts(w)).toEqual({ satisfied: false, digest: false });
    const side = new Database(w.harness.cp.config.databasePath);
    try {
      side.function("acp_evidence_write_authorized", () => 0);
      expect(() => side.prepare("UPDATE run_artifacts SET superseded = 1 WHERE artifact_id = ?").run(refusalOf(w, ITEM_B).artifactId))
        .toThrowError(/OWNER_DECISION_SUPERSEDE_AUTHORITY_DENIED/);
    } finally {
      side.close();
    }
    expect(gateAccepts(w)).toEqual({ satisfied: false, digest: false });
    const limit = new Database(w.harness.cp.config.databasePath);
    try {
      limit.function("acp_evidence_write_authorized", () => 1);
      limit.prepare("UPDATE run_artifacts SET superseded = 1 WHERE artifact_id = ?").run(refusalOf(w, ITEM_B).artifactId);
    } finally {
      limit.close();
    }
    // Stated, not closed: the guard is a boundary against ACP's own Db.run, not against a writer that supplies the marker.
    expect(gateAccepts(w)).toEqual({ satisfied: true, digest: true });
  });
});

describe("SEC-OD1 v48 controls: the legitimate paths that change an owner decision's effect still work", () => {
  it("ODV48-CONTROL the owner's own re-decision through the formal path (approve, refuse, approve) decides each time, never needs the mark, and the last approval publishes and merges", async () => {
    const w = await world([ITEM_A, ITEM_B]);
    expect(gateAccepts(w)).toEqual({ satisfied: true, digest: true });
    decide(w, ITEM_B, false, "not now");
    expect(gateAccepts(w)).toEqual({ satisfied: false, digest: false });
    decide(w, ITEM_B, true, "now yes");
    expect(gateAccepts(w)).toEqual({ satisfied: true, digest: true });
    expect(decisionLabels(w).filter(([item]) => item === ITEM_B)).toEqual([
      [ITEM_B, true, OWNER_DECISION_LABEL],
      [ITEM_B, false, OWNER_DECISION_LABEL],
      [ITEM_B, true, OWNER_DECISION_LABEL],
    ]);
    expect(w.harness.cp.artifacts.list(w.runId, "APPROVAL").filter((artifact) => artifact.superseded)).toEqual([]);
    expect(outcome(await w.harness.cp.github.gatePublish(w.payload, w.identity))).toBe("ALLOWED");
    expect(outcome(await merge(w, await openPull(w)))).toBe("ALLOWED");
    expect(w.github.mergeCount).toBe(1);
  });

  it("ODV48-CONTROL promoting a new candidate supersedes every owner decision of the old one, canonical and \"service\", and leaves no marker", async () => {
    const w = await world([ITEM_A, ITEM_B]);
    putRefusal(w, { item: ITEM_A });
    const decisions = () => w.harness.cp.artifacts.list<{ kind?: string }>(w.runId, "APPROVAL").filter((artifact) => artifact.content.kind === "OWNER_DECISION");
    expect(decisions().map((artifact) => [artifact.producedBy, artifact.superseded])).toEqual([
      [OWNER_DECISION_LABEL, false],
      [OWNER_DECISION_LABEL, false],
      ["service", false],
    ]);
    w.harness.cp.runs.promoteCandidate(w.runId, digestOf({ revisedFrom: w.candidate, revision: 1 }));
    expect(decisions().map((artifact) => artifact.superseded)).toEqual([true, true, true]);
    expect(markerNow(w)).toBe(0);
    expect(gateAccepts(w)).toEqual({ satisfied: false, digest: false });
  });

  it("ODV48-CONTROL invalidating the candidate supersedes every owner decision bound to it and leaves no marker", async () => {
    const w = await world([ITEM_A, ITEM_B]);
    decide(w, ITEM_B, false, "owner refused");
    const invalidated = w.harness.cp.runs.invalidateCandidate(w.runId, "v48 control: source changed");
    expect(outcome(invalidated)).toBe("ALLOWED");
    expect(w.harness.cp.artifacts.list<{ kind?: string }>(w.runId, "APPROVAL")
      .filter((artifact) => artifact.content.kind === "OWNER_DECISION")
      .map((artifact) => artifact.superseded)).toEqual([true, true, true]);
    expect(markerNow(w)).toBe(0);
  });
});

describe("SEC-OD1 v48 capability scope: the run engine holds the marker for its one staleness statement", () => {
  it("ODV48-SCOPE a staleness mark inside a transaction that then fails keeps nothing and leaves no marker; the next Db.run withdrawal is refused", async () => {
    const w = await world([ITEM_A, ITEM_B]);
    decide(w, ITEM_B, false, "owner refused");
    const flags = supersededFlags(w);
    let inside: unknown = "not reached";
    let threw: unknown;
    try {
      w.harness.cp.db.tx(() => {
        w.harness.cp.runs.promoteCandidate(w.runId, digestOf({ revisedFrom: w.candidate, revision: 2 }));
        inside = markerNow(w);
        throw new Error("the transaction fails after the staleness mark");
      });
    } catch (error) {
      threw = error;
    }
    expect(String(threw)).toMatch(/the transaction fails after the staleness mark/);
    expect(inside).toBe(0);
    expect(supersededFlags(w)).toEqual(flags);
    expect(markerNow(w)).toBe(0);
    expect(withdraw(w, refusalOf(w, ITEM_B).artifactId)).toMatchObject(V48_REFUSAL);
    expect(gateAccepts(w)).toEqual({ satisfied: false, digest: false });
  });

  it("ODV48-SCOPE a staleness statement that throws while the marker is held releases it; nothing is kept", async () => {
    const w = await world([ITEM_A, ITEM_B]);
    decide(w, ITEM_B, false, "owner refused");
    const flags = supersededFlags(w);
    const db = w.harness.cp.db;
    const run = db.run.bind(db);
    let during: unknown;
    const spy = vi.spyOn(db, "run").mockImplementation((sql: string, params?: unknown[]) => {
      if (/UPDATE run_artifacts SET superseded = 1/.test(sql)) {
        during = markerNow(w);
        throw new Error("the staleness statement fails");
      }
      return run(sql, params);
    });
    try {
      expect(() => w.harness.cp.runs.promoteCandidate(w.runId, digestOf({ revisedFrom: w.candidate, revision: 3 })))
        .toThrowError(/the staleness statement fails/);
    } finally {
      spy.mockRestore();
    }
    expect(during).toBe(1);
    expect(markerNow(w)).toBe(0);
    expect(supersededFlags(w)).toEqual(flags);
    expect(withdraw(w, refusalOf(w, ITEM_B).artifactId)).toMatchObject(V48_REFUSAL);
  });

  it("ODV48-SCOPE only the run engine's own capability marks superseded through the Db: none, a forged one, or the production gate's writer is refused", async () => {
    const w = await world([ITEM_A, ITEM_B]);
    decide(w, ITEM_B, false, "owner refused");
    const flags = supersededFlags(w);
    const db = w.harness.cp.db as unknown as { supersedeRunArtifacts?: (authority: unknown, runId: string, current: string | null) => unknown };
    for (const authority of [undefined, {}, w.harness.cp.evidenceWritersForTests().PRODUCTION_READY_PACKET]) {
      let refusal: unknown;
      try {
        db.supersedeRunArtifacts!(authority, w.runId, null);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toMatchObject({ reasonCode: ReasonCode.RUN_STATE_TRANSITION_AUTHORITY_DENIED });
    }
    expect(supersededFlags(w)).toEqual(flags);
    expect(markerNow(w)).toBe(0);
  });
});

/**
 * FIX-SEC-R2 (CEO 85eac6ef, option B) — the review's upgrade counterexample (sec-r2 upgrade-siblings :1366):
 * an approval nobody admitted, written with the canonical label by an ordinary write at v46 (ACP's v46
 * connection, whose marker returns 0), survived the upgrade and overrode the owner's refusal; publication
 * and merge each went through once. v47 now refuses its first install while any APPROVAL carries the label.
 *
 * Each world is taken back to the released v46 image the review's way: the run's rows carried into the
 * released chain's v46 schema (`carryRows`), with every decision as a database of that era holds it, the
 * "service" label. Pre-v47 writes are measured on that image, and everything after on what the upgrade
 * produced. Nothing here imports the refusal from the code, so this file loads at the build before it.
 */
const asReleasedV46 = (w: World): string => {
  const source = w.harness.cp.config.databasePath;
  const path = releasedChainImage(privateStatePath("acp-secr2-v46-"), 46);
  w.harness.cp.close();
  const image = new Database(path);
  try {
    image.pragma("foreign_keys = OFF");
    const triggers = image.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY rowid").all() as Array<{ name: string; sql: string }>;
    const tables = image.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'").pluck().all() as string[];
    image.exec("BEGIN IMMEDIATE");
    for (const trigger of triggers) image.exec(`DROP TRIGGER "${trigger.name}"`);
    for (const table of tables) image.exec(`DELETE FROM "${table}"`);
    for (const trigger of triggers) image.exec(trigger.sql);
    image.exec("COMMIT");
  } finally {
    image.close();
  }
  carryRows(source, path);
  expect(laterObjectsIn(path, 46)).toEqual([]);
  copyFileSync(path, source);
  return source;
};

/** An ordinary write at v46, on a connection whose marker returns 0 as ACP's v46 connection's did. */
const forgeAtV46 = (w: World, path: string, artifactId: string, item: string): void => {
  const content = forgedDecision(w, item, `pre-v47 forgery of ${item}`);
  const raw = new Database(path);
  try {
    expect(raw.pragma("user_version", { simple: true })).toBe(46);
    raw.function("acp_evidence_write_authorized", () => 0);
    raw.prepare(
      `INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
       VALUES (?, ?, 'APPROVAL', ?, ?, ?, ?, ?)`,
    ).run(artifactId, w.runId, digestOf(content), w.candidate, JSON.stringify(content), OWNER_DECISION_LABEL, w.harness.clock.nowIso());
  } finally {
    raw.close();
  }
  expect(content.receipt.actor).toBe("not-the-owner");
  sideConsumption(w, content.receipt, w.candidate);
};

/** The approved upgrade, as the daemon opens the database; the harness, or what the opening threw. */
const upgrade = (w: World, why: string): unknown => {
  approveMigration(w.harness.cp.config.databasePath, why);
  try {
    w.harness = makeHarness({ root: w.harness.root, repoPath: w.harness.repoPath, githubClient: w.github, clock: w.harness.clock });
  } catch (error) {
    return error;
  }
  installDaemonFinalizerGitHubFixture(w.harness);
  w.harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
  return undefined;
};

const receiptAt47 = (w: World): unknown =>
  w.harness.cp.db.get("SELECT migration_id, checksum FROM schema_migrations WHERE version = 47");

const external = (w: World) => ({
  writes: w.github.calls.filter((call) => call.method !== "GET").length,
  merges: w.github.mergeCount,
  checks: w.github.checkRuns.length,
});

/** The owner's history as a v46 database holds it: both items approved, then the refusal of ITEM_B, all "service". */
const v46History = async (): Promise<World> => {
  const w = await world([...ITEMS], { before: true });
  asBeforeSecOd1(w, () => decide(w, ITEM_B, false, "the owner refused, before SEC-OD1"));
  expect(decisionLabels(w)).toEqual([[ITEM_A, true, "service"], [ITEM_B, true, "service"], [ITEM_B, false, "service"]]);
  return w;
};

describe("FIX-SEC-R2 a canonical label written before the guard refuses the upgrade (option B)", () => {
  it("SECR2-UPGRADE never-admitted canonical approvals written by an ordinary v46 write refuse v47: no upgrade, 0 publications and 0 merges, the v46 database unchanged", async () => {
    const w = await v46History();
    const path = asReleasedV46(w);
    forgeAtV46(w, path, "art_secr2_forged_a", ITEM_A);
    forgeAtV46(w, path, "art_secr2_forged_b", ITEM_B);
    const before = contentDigests(path);
    expect(before.userVersion).toBe(46);

    const refusal = upgrade(w, "FIX-SEC-R2 forged label at v46");
    // Before option B the upgrade went through; what the forged rows then did is driven to the merge.
    let driven = "NOT_OPENED";
    if (refusal === undefined) {
      const published = await w.harness.cp.github.gatePublish(w.payload, w.identity);
      const merged = published.allowed ? await merge(w, await openPull(w)) : published;
      driven = JSON.stringify({ gate: gateAccepts(w), published: outcome(published), merged: outcome(merged) });
    }
    expect({ driven, ...external(w) }).toEqual({ driven: "NOT_OPENED", writes: 0, merges: 0, checks: 0 });
    // FIX-SEC-R3: refused by the migrator's read-only preflight, under its own code, before any backup.
    expect(refusal).toMatchObject({ reasonCode: "OWNER_DECISION_LABEL_PREDATES_GUARD" });
    const message = (refusal as Error).message;
    expect(message).toMatch(/^v47 refuses: OWNER_DECISION_LABEL_PREDATES_GUARD — run_artifacts holds 2 APPROVAL row\(s\) that claim an owner decision/);
    expect(message).toContain('"art_secr2_forged_a", "art_secr2_forged_b";');
    expect(contentDigests(path)).toEqual(before);
  });

  it("SECR2-CLEAN the same v46 history without the forgery upgrades: the corrected v47 receipt, the refusal recorded before SEC-OD1 still blocks, and the owner's new canonical approvals publish and merge", async () => {
    const w = await v46History();
    asReleasedV46(w);
    expect(upgrade(w, "FIX-SEC-R2 clean v46")).toBeUndefined();
    expect(w.harness.cp.db.raw.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(48);
    expect(receiptAt47(w)).toEqual({ migration_id: "v47-owner-decision-authority-guard", checksum: V47_BASE_CHECKSUM });
    expect(decisionLabels(w)).toEqual([[ITEM_A, true, "service"], [ITEM_B, true, "service"], [ITEM_B, false, "service"]]);

    expect(w.harness.cp.ceo.humanGateStatus(w.runId)).toEqual({ required: true, items: [...ITEMS], satisfied: false, decideAgain: [ITEM_A] });
    expect(await w.harness.cp.github.gatePublish(w.payload, w.identity)).toMatchObject({ allowed: false, reasonCode: ReasonCode.HUMAN_GATE_UNSATISFIED });
    expect(external(w)).toEqual({ writes: 0, merges: 0, checks: 0 });

    for (const item of ITEMS) decide(w, item, true, `decided again after the upgrade: ${item}`);
    expect(gateAccepts(w)).toEqual({ satisfied: true, digest: true });
    expect(outcome(await w.harness.cp.github.gatePublish(w.payload, w.identity))).toBe("ALLOWED");
    expect(outcome(await merge(w, await openPull(w)))).toBe("ALLOWED");
    expect(external(w)).toMatchObject({ merges: 1, checks: 1 });
  });

  it("SECR2-AFTER-GUARD canonical decisions written under the guard never refuse the v48 upgrade or a reopen: the gate reads them, and the merge goes through once", async () => {
    const w = await world([...ITEMS]);
    expect(decisionLabels(w)).toEqual([[ITEM_A, true, OWNER_DECISION_LABEL], [ITEM_B, true, OWNER_DECISION_LABEL]]);
    const source = w.harness.cp.config.databasePath;
    const path = releasedChainImage(privateStatePath("acp-secr2-v47-"), 47);
    w.harness.cp.close();
    const image = new Database(path);
    try {
      image.pragma("foreign_keys = OFF");
      const triggers = image.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY rowid").all() as Array<{ name: string; sql: string }>;
      const tables = image.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'").pluck().all() as string[];
      image.exec("BEGIN IMMEDIATE");
      for (const trigger of triggers) image.exec(`DROP TRIGGER "${trigger.name}"`);
      for (const table of tables) image.exec(`DELETE FROM "${table}"`);
      for (const trigger of triggers) image.exec(trigger.sql);
      image.exec("COMMIT");
      expect(image.prepare("SELECT migration_id, checksum FROM schema_migrations WHERE version = 47").get())
        .toEqual({ migration_id: "v47-owner-decision-authority-guard", checksum: V47_BASE_CHECKSUM });
    } finally {
      image.close();
    }
    carryRows(source, path);
    expect(laterObjectsIn(path, 47)).toEqual([]);
    copyFileSync(path, source);

    expect(upgrade(w, "FIX-SEC-R2 v47 to v48 after the guard")).toBeUndefined();
    expect(decisionLabels(w)).toEqual([[ITEM_A, true, OWNER_DECISION_LABEL], [ITEM_B, true, OWNER_DECISION_LABEL]]);
    expect(gateAccepts(w)).toEqual({ satisfied: true, digest: true });
    // A plain reopen at the current version runs no step and reads the same decisions.
    w.harness.cp.close();
    w.harness = makeHarness({ root: w.harness.root, repoPath: w.harness.repoPath, githubClient: w.github, clock: w.harness.clock });
    installDaemonFinalizerGitHubFixture(w.harness);
    w.harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
    expect(gateAccepts(w)).toEqual({ satisfied: true, digest: true });
    expect(outcome(await w.harness.cp.github.gatePublish(w.payload, w.identity))).toBe("ALLOWED");
    expect(outcome(await merge(w, await openPull(w)))).toBe("ALLOWED");
    expect(external(w)).toMatchObject({ merges: 1, checks: 1 });
    expect(receiptAt47(w)).toEqual({ migration_id: "v47-owner-decision-authority-guard", checksum: V47_BASE_CHECKSUM });
  });
});

/**
 * FIX-SEC-R3 (CEO 80492af7) — review r3's originals (rv3-final.log :84 and :96, startup-retry.log), rebuilt
 * on this file's harness. Each measures the security outcome first (refused or not; when not, what the
 * database then published and merged), so the file also loads at cbb4bfaf and shows the defect there.
 *
 *   RV3-CANDIDATE  a released v46 image with never-admitted approvals, taken to v47 by a candidate step
 *                  with its genuine receipt: the upgrade went through, and publication and merge each
 *                  happened once. Now the receipt's value refuses it.
 *   RV3-SHAPE      OWNER_DECISION content under an upper-case label, written at v46: it upgraded and its
 *                  bound refusal was then counted. Now the shape refuses it.
 *   RV3-REFUSAL    the refusal went through the generic backup and restore, which rewrote the file
 *                  (872,448 → 860,160 bytes) and reported INTERNAL_ERROR. Now nothing touches the file, the
 *                  start reports the refusal's own code and exits non-zero, and the restart that exit
 *                  earns finds the same refusal on record and exits 0, so it is not retried again.
 */
const fileBytes = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const receiptsOf = (path: string): unknown[] => {
  const raw = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return raw.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  } finally {
    raw.close();
  }
};

/** What the database did once it opened: the gate, then publication and merge, driven as far as they go. */
const drive = async (w: World): Promise<unknown> => {
  const published = await w.harness.cp.github.gatePublish(w.payload, w.identity);
  const merged = published.allowed ? await merge(w, await openPull(w)) : published;
  return { gate: gateAccepts(w), published: outcome(published), merged: outcome(merged) };
};

describe("FIX-SEC-R3 review r3's originals: a candidate receipt, a decision-shaped label and the refusal's image", () => {
  it.each([
    { name: "faa829ec–ccc4865f (the review's)", checksum: V47_CANDIDATE_CHECKSUM },
    { name: "cbb4bfaf", checksum: V47_R2_CANDIDATE_CHECKSUM },
  ])("RV3-CANDIDATE a database the candidate v47 of $name migrated is refused: 0 publications, 0 merges, the image untouched", async ({ checksum }) => {
    const w = await v46History();
    const path = asReleasedV46(w);
    forgeAtV46(w, path, "art_rv3_candidate_a", ITEM_A);
    forgeAtV46(w, path, "art_rv3_candidate_b", ITEM_B);
    asCandidateV47(path, checksum, w.harness.clock.nowIso());
    const bytes = fileBytes(path);
    const receipts = receiptsOf(path);
    const refusal = upgrade(w, "FIX-SEC-R3 candidate v47 receipt");
    const driven = refusal === undefined ? await drive(w) : "NOT_OPENED";
    expect({ driven, ...external(w) }).toEqual({ driven: "NOT_OPENED", writes: 0, merges: 0, checks: 0 });
    expect(refusal).toMatchObject({
      reasonCode: "MIGRATION_RECEIPT_MISMATCH",
      evidence: { mismatches: [{ version: 47, migrationId: "v47-owner-decision-authority-guard", stored: checksum, expected: V47_BASE_CHECKSUM }] },
    });
    expect(fileBytes(path)).toBe(bytes);
    expect(receiptsOf(path)).toEqual(receipts);
  });

  it("RV3-SHAPE OWNER_DECISION content under an upper-case label written at v46 refuses the upgrade; its refusal is never read", async () => {
    const w = await world([...ITEMS], { before: true });
    const path = asReleasedV46(w);
    const content = decisionContent(w, false, "pre-guard shape under label variant", {});
    const raw = new Database(path);
    try {
      raw.function("acp_evidence_write_authorized", () => 0);
      raw.prepare(
        `INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
         VALUES ('art_rv3_shape', ?, 'APPROVAL', ?, ?, ?, ?, ?)`,
      ).run(w.runId, digestOf(content), w.candidate, JSON.stringify(content), OWNER_DECISION_LABEL.toUpperCase(), w.harness.clock.nowIso());
    } finally {
      raw.close();
    }
    const bytes = fileBytes(path);
    const refusal = upgrade(w, "FIX-SEC-R3 pre-guard shape");
    const accepted = refusal === undefined ? w.harness.cp.ceo.humanGateStatus(w.runId) : null;
    expect({ accepted, refusal: (refusal as { reasonCode?: unknown } | undefined)?.reasonCode })
      .toEqual({ accepted: null, refusal: "OWNER_DECISION_LABEL_PREDATES_GUARD" });
    expect((refusal as Error).message).toContain('"art_rv3_shape"');
    expect(fileBytes(path)).toBe(bytes);
  });

  it("RV3-REFUSAL the file, its receipts and its version are unchanged byte for byte; every start exits non-zero under the refusal's code, and exits 0 only under the launchd plist", async () => {
    const w = await v46History();
    const path = asReleasedV46(w);
    forgeAtV46(w, path, "art_rv3_refusal", ITEM_B);
    const before = { bytes: fileBytes(path), receipts: receiptsOf(path), logical: contentDigests(path) };
    expect(before.logical.userVersion).toBe(46);

    const refusal = upgrade(w, "FIX-SEC-R3 startup refusal");
    expect({ bytes: fileBytes(path), receipts: receiptsOf(path), logical: contentDigests(path) }).toEqual(before);
    const first = dispositionForStartupError(refusal, path, {});
    expect(first).toMatchObject({ exitCode: 78, body: { reasonCode: "OWNER_DECISION_LABEL_PREDATES_GUARD", supervisor: null, exitCode: 78 } });
    expect(first.body).not.toHaveProperty("standing");
    expect(first.reportPath).not.toBeNull();
    expect(JSON.parse(readFileSync(first.reportPath!, "utf8"))).toMatchObject({ reasonCode: "OWNER_DECISION_LABEL_PREDATES_GUARD" });

    // A second start: the same refusal, read-only again, its own record on file. The record decides nothing.
    let retry: unknown;
    try {
      makeHarness({ root: w.harness.root, repoPath: w.harness.repoPath, githubClient: w.github, clock: w.harness.clock }).cp.close();
    } catch (error) {
      retry = error;
    }
    expect(retry).toMatchObject({ reasonCode: "OWNER_DECISION_LABEL_PREDATES_GUARD" });
    expect(dispositionForStartupError(retry, path, {})).toMatchObject({ exitCode: 78 });
    expect(dispositionForStartupError(retry, path, { ACP_DAEMON_SUPERVISOR: "launchd" }))
      .toMatchObject({ exitCode: 0, body: { reasonCode: "OWNER_DECISION_LABEL_PREDATES_GUARD", supervisor: "launchd", exitCode: 0 } });
    expect({ bytes: fileBytes(path), receipts: receiptsOf(path), logical: contentDigests(path) }).toEqual(before);
    expect(external(w)).toEqual({ writes: 0, merges: 0, checks: 0 });
  });
});
