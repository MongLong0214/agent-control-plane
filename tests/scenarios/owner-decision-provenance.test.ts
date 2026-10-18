import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

import type { OwnerApprovalReceipt } from "../../src/ceo/owner-authority.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { GatePayload } from "../../src/github/github-kernel.ts";
import { IngressGuard, ownerApprovalPayload } from "../../src/ingress/ingress-guard.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";
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
  payload: GatePayload;
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
 * A run driven to a reviewed candidate with the two-item gate. `approve` items are decided by the owner
 * first; when they cover the gate the CEO confirms for real, otherwise the fixture stages CEO_APPROVED
 * so the kernel's own re-check is what is exercised.
 */
const world = async (approve: readonly string[] = []): Promise<World> => {
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
  for (const item of approve) decide({ harness, runId: driven.runId }, item, true, `approve ${item}`);
  await approveReviewedCandidateForFinalization(harness, driven, {
    bypassCeoConfirmation: !ITEMS.every((item) => approve.includes(item)),
  });
  installDaemonFinalizerGitHubFixture(harness);
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
    payload: {
      runId: driven.runId,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      contractDigest: driven.contractDigest,
      verificationDigest: driven.verificationDigest,
      blindReviewDigest: driven.blindReviewDigest,
      humanGateDigest: digestOf(ITEMS),
      bindingGeneration: driven.ownerBindingGeneration,
      exactHead: driven.candidateHead,
      timestamp: "2026-08-12T00:00:00.000Z",
    },
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

/** The hand-written half of the probe: an OWNER_DECISION-shaped APPROVAL artifact put straight into the store. */
const handWrite = (w: World, item: string, note: string, receipt: OwnerApprovalReceipt, candidate = w.candidate) =>
  w.harness.cp.artifacts.put(w.runId, "APPROVAL", {
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

  it("ODWRITER recordOwnerDecision writes the canonical label; put of the same shape does not", async () => {
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
    // Exactly what recordOwnerDecision would write in this transaction, written first by `put`.
    w.harness.cp.artifacts.put(w.runId, "APPROVAL", {
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
