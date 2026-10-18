/**
 * FIX-SEC-NEST (CEO 4170f7c5) — the owner gate counts a non-canonical owner decision only when SQLite
 * itself judges its content OWNER_DECISION-shaped, by the guards' own clause (`ownerDecisionShapeSql`).
 *
 * An ordinary `Db.run` on ACP's own connection could add an APPROVAL row the v47 guard admits because
 * SQLite cannot read it (content nested past json1's depth limit, or not JSON at all) while the reader's
 * `JSON.parse` could: the deep refusal was counted as an exactly bound refusal and blocked CONFIRM,
 * publish and merge, a future `created_at` made it outrank the owner's later decisions, and a row that is
 * not JSON made the reader throw. These run the real reader on the gate, CONFIRM, publish and merge
 * paths, with external writes to FakeGitHub only (the DIAG-NEST1000 scenarios as product witnesses).
 */
import { afterAll, describe, expect, it } from "vitest";

import type { OwnerApprovalReceipt } from "../../src/ceo/owner-authority.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, roleKeyFor } from "../../src/domain/types.ts";
import type { GatePayload } from "../../src/github/github-kernel.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";
import { writeOutsideTheGuard } from "../helpers/released-v47-schema.ts";
import {
  approveReviewedCandidateForFinalization,
  type Harness,
  driveToReviewedCandidate,
  installDaemonFinalizerGitHubFixture,
  makeHarness,
  ownerDecisionReceipt,
  TEST_OWNER,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const ITEMS = ["irreversible production action", "undelegated public release"] as const;
const [ITEM_A, ITEM_B] = ITEMS;
const CI_WORKFLOWS = [
  { path: ".github/workflows/ci.yml", checkName: "project-ci", approvedDigest: null, unapprovedFirstActivation: true, repositoryRole: "primary" },
];
const FUTURE = "9999-12-31T23:59:59.999Z";
const OTHER_CANDIDATE = `sha256:${"e".repeat(64)}`;
/** Past SQLite's json1 nesting limit (1000), which `JSON.parse` does not have. */
const DEPTH = 1100;
const nest = (n: number) => `${"[".repeat(n)}${"]".repeat(n)}`;
/** Splice a member nested `n` levels into a serialized object, keeping its top-level `kind`. */
const deepen = (content: Record<string, unknown>, n = DEPTH) => `${JSON.stringify(content).slice(0, -1)},"deep":${nest(n)}}`;

interface World {
  harness: Harness; github: FakeGitHub; runId: string; identity: string;
  caller: { ownerSessionId: string; ownerBindingGeneration: number };
  head: string; base: string; workBranch: string; candidate: string; payload: GatePayload;
}

const reflectMergedBase = (github: FakeGitHub): void => {
  const request = github.request.bind(github);
  github.request = async <T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> => {
    const response = await request<T>(method, path, body);
    if (method !== "PUT" || !/\/pulls\/\d+\/merge$/.test(path) || !response || typeof response !== "object") return response;
    const merge = response as { merged?: unknown; sha?: unknown };
    const pull = github.pulls.find((entry) => entry.number === Number(/\/pulls\/(\d+)\/merge$/.exec(path)?.[1]));
    if (merge.merged !== true || typeof merge.sha !== "string" || !pull) return response;
    (pull as typeof pull & { merge_commit_sha?: string }).merge_commit_sha = merge.sha;
    github.setBranch(pull.base.ref, merge.sha);
    return response;
  };
};

const decide = (w: Pick<World, "harness" | "runId">, item: string, approved: boolean, note: string) => {
  const receipt = ownerDecisionReceipt(w.harness, w.runId, item, approved, note);
  const recorded = w.harness.cp.ceo.recordOwnerDecision({ runId: w.runId, item, approved, note, receipt });
  if (!recorded.allowed) throw new Error(`${recorded.reasonCode}: ${recorded.message}`);
};

/**
 * A run driven to a reviewed candidate with the two-item gate; `approve` items are decided by the owner.
 * `packetOnly` stops at the production-ready packet, so CONFIRM is the CEO's own; otherwise the CEO has
 * confirmed (the fixture stages it when the gate is not yet satisfied).
 */
const world = async (approve: readonly string[], packetOnly = false): Promise<World> => {
  const github = new FakeGitHub();
  reflectMergedBase(github);
  const harness = makeHarness({ githubClient: github });
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
  const driven = await driveToReviewedCandidate(harness, { workBranch: "feature/F1-thing", humanGate: ITEMS, manifestOverrides: { ciWorkflows: CI_WORKFLOWS } });
  github.setBranch("dev", driven.baseHead);
  github.setBranch("main", "c".repeat(40));
  github.setBranch(driven.workBranch, driven.candidateHead);
  const claimed = harness.cp.claims.acquire({
    runId: driven.runId, ownerSessionId: driven.ownerSessionId, ownerBindingGeneration: driven.ownerBindingGeneration,
    ownerRoleKey: harness.cp.runs.require(driven.runId).ownerRoleKey!, repositoryIdentity: driven.identity,
    branch: driven.workBranch, ttlMs: 7 * 24 * 60 * 60 * 1000,
  });
  if (!claimed.allowed) throw new Error(claimed.message);
  for (const item of approve) decide({ harness, runId: driven.runId }, item, true, `approve ${item}`);
  if (packetOnly) {
    await harness.cp.continuity.evaluate("test finalization packet");
    const packet = harness.cp.ceo.buildPacket({
      runId: driven.runId, candidateSnapshotDigest: driven.candidateSnapshotDigest,
      approval: {
        runId: driven.runId, candidateSnapshotDigest: driven.candidateSnapshotDigest, resultSummary: "candidate verified",
        recommendation: "merge", residualRisk: [], approvedBySessionId: driven.ownerSessionId,
        approvedByGeneration: driven.ownerBindingGeneration, approvedAt: harness.clock.nowIso(),
      },
    });
    if (!packet.allowed) throw new Error(`${packet.reasonCode}: ${packet.message}`);
  } else {
    await approveReviewedCandidateForFinalization(harness, driven, { bypassCeoConfirmation: !ITEMS.every((item) => approve.includes(item)) });
  }
  installDaemonFinalizerGitHubFixture(harness);
  return {
    harness, github, runId: driven.runId, identity: driven.identity,
    caller: { ownerSessionId: driven.ownerSessionId, ownerBindingGeneration: driven.ownerBindingGeneration },
    head: driven.candidateHead, base: driven.baseHead, workBranch: driven.workBranch, candidate: driven.candidateSnapshotDigest,
    payload: {
      runId: driven.runId, candidateSnapshotDigest: driven.candidateSnapshotDigest, contractDigest: driven.contractDigest,
      verificationDigest: driven.verificationDigest, blindReviewDigest: driven.blindReviewDigest, humanGateDigest: digestOf(ITEMS),
      bindingGeneration: driven.ownerBindingGeneration, exactHead: driven.candidateHead, timestamp: "2026-08-12T00:00:00.000Z",
    },
  };
};

/** Every field typed by the writer: a nonce never admitted, an actor that is not the owner. */
const typedReceipt = (w: World, item: string, approved: boolean, note: string, over: Partial<OwnerApprovalReceipt> = {}): OwnerApprovalReceipt => ({
  channel: TEST_OWNER.channel, actor: "not-the-owner", inboundNonce: "never-admitted", runId: w.runId,
  candidateSnapshotDigest: w.candidate, operation: "owner_decision_submit",
  parameterDigest: digestOf({ item, approved, note }), idempotencyKey: `forged:${item}:${note}`, approved, ...over,
});

interface Bind { gate?: string; contentCandidate?: string; receipt?: Partial<OwnerApprovalReceipt>; approved?: boolean }
/** An OWNER_DECISION on ITEM_B bound exactly to `w` (a refusal unless `approved`), except for `b`. */
const decision = (w: World, note: string, b: Bind = {}) => {
  const approved = b.approved ?? false;
  return {
    kind: "OWNER_DECISION", item: ITEM_B, approved, note, at: w.harness.clock.nowIso(),
    humanGateDigest: b.gate ?? digestOf(ITEMS), candidateSnapshotDigest: b.contentCandidate ?? w.candidate,
    receipt: typedReceipt(w, ITEM_B, approved, note, b.receipt),
  };
};

/** An ordinary `Db.run` on ACP's own connection, labelled "service"; the v47 guard admits this content. */
const insert = (w: World, contentJson: string, createdAt = w.harness.clock.nowIso()): void => {
  w.harness.cp.db.run(
    `INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
     VALUES (?, ?, 'APPROVAL', ?, ?, ?, 'service', ?)`,
    [`art_nest_${digestOf({ contentJson, createdAt }).slice(7, 31)}`, w.runId, digestOf({ contentJson, createdAt }), w.candidate, contentJson, createdAt],
  );
};

const INVALID: ReadonlyArray<{ name: string; content: (w: World) => string; createdAt?: string }> = [
  { name: "a deep exactly bound refusal", content: (w) => deepen(decision(w, "deep refusal")) },
  { name: "a deep exactly bound refusal dated in the future", content: (w) => deepen(decision(w, "deep refusal future")), createdAt: FUTURE },
  { name: "a row that is not JSON", content: () => "{not json" },
  { name: "a row that is not JSON dated in the future", content: () => "{not json", createdAt: FUTURE },
];

const gate = (w: World) => {
  const status = w.harness.cp.ceo.humanGateStatus(w.runId);
  return { satisfied: status.satisfied, decideAgain: status.decideAgain ?? [], digest: w.harness.cp.ceo.currentHumanGateDecisionDigest(w.runId).allowed };
};
const outcome = (d: { allowed: boolean; reasonCode?: string }) => (d.allowed ? "ALLOWED" : d.reasonCode);
const confirm = (w: World) => {
  const ceo = w.harness.cp.bindings.active(roleKeyFor(Role.CEO));
  if (!ceo) throw new Error("fixture CEO binding missing");
  return outcome(w.harness.cp.ceo.submitCeoDecision({ runId: w.runId, decision: "CONFIRM", candidateSnapshotDigest: w.candidate, ceoSessionId: ceo.sessionId, rationale: "confirm" }));
};
const openPull = async (w: World): Promise<number> => {
  const prepared = await w.harness.cp.github.prPrepare({
    runId: w.runId, repositoryIdentity: w.identity, head: w.workBranch, base: "dev", title: "candidate", body: "",
    ownerSessionId: w.caller.ownerSessionId, ownerBindingGeneration: w.caller.ownerBindingGeneration, exactHeadSha: w.head,
  });
  if (!prepared.allowed) throw new Error(`${prepared.reasonCode}: ${prepared.message}`);
  return prepared.value.pullNumber;
};
const merge = async (w: World, pullNumber: number) => outcome(await w.harness.cp.github.mergeExecute({
  runId: w.runId, repositoryIdentity: w.identity, pullNumber, exactHeadSha: w.head, expectedBaseSha: w.base,
  mergeStrategy: "merge_commit" as const, ownerSessionId: w.caller.ownerSessionId, ownerBindingGeneration: w.caller.ownerBindingGeneration,
}));
const publish = async (w: World) => outcome(await w.harness.cp.github.gatePublish(w.payload, w.identity));
const SATISFIED = { satisfied: true, decideAgain: [], digest: true };
const UNSATISFIED = { satisfied: false, decideAgain: [], digest: false };

describe("FIX-SEC-NEST a row SQLite cannot read as an owner decision neither counts nor breaks the reader", () => {
  for (const row of INVALID) {
    it(`ODNEST ${row.name}, added after the owner approved, leaves CONFIRM and publish to the owner's approval`, async () => {
      const w = await world([ITEM_A], true);
      decide(w, ITEM_B, true, "approved");
      insert(w, row.content(w), row.createdAt);
      expect({ gate: gate(w), confirm: confirm(w), publish: await publish(w), checks: w.github.checkRuns.length > 0 }).toEqual({
        gate: SATISFIED, confirm: "ALLOWED", publish: "ALLOWED", checks: true,
      });
    });
  }

  it("ODNEST every such row together, added after publication, leaves the kernel merge to the owner's approval", async () => {
    const w = await world([ITEM_A, ITEM_B]);
    expect(await publish(w)).toBe("ALLOWED");
    const pullNumber = await openPull(w);
    for (const row of INVALID) insert(w, row.content(w), row.createdAt);
    expect({ gate: gate(w), merged: await merge(w, pullNumber), merges: w.github.mergeCount }).toEqual({ gate: SATISFIED, merged: "ALLOWED", merges: 1 });
  });

  it("ODNEST a deep exactly bound approval is not recognized: the item stays undecided and CONFIRM is refused", async () => {
    const w = await world([ITEM_A], true);
    insert(w, deepen(decision(w, "deep approve", { approved: true })));
    expect({ gate: gate(w), confirm: confirm(w) }).toEqual({ gate: UNSATISFIED, confirm: ReasonCode.HUMAN_GATE_UNSATISFIED });
  });
});

describe("FIX-SEC-NEST controls: what SQLite reads as an owner decision is judged as before", () => {
  it("ODNESTCONTROL a legitimate owner approval satisfies the gate, CONFIRMs, publishes and merges", async () => {
    const w = await world([ITEM_A], true);
    decide(w, ITEM_B, true, "approved");
    expect({ gate: gate(w), confirm: confirm(w), publish: await publish(w) }).toEqual({ gate: SATISFIED, confirm: "ALLOWED", publish: "ALLOWED" });
    const merged = await world([ITEM_A, ITEM_B]);
    expect(await publish(merged)).toBe("ALLOWED");
    expect(await merge(merged, await openPull(merged))).toBe("ALLOWED");
  });

  it("ODNESTCONTROL the owner's canonical refusal after an approval still blocks CONFIRM and publish", async () => {
    const w = await world([ITEM_A], true);
    decide(w, ITEM_B, true, "approved");
    decide(w, ITEM_B, false, "refused");
    expect({ gate: gate(w), confirm: confirm(w), publish: await publish(w), checks: w.github.checkRuns.length }).toEqual({
      gate: UNSATISFIED, confirm: ReasonCode.HUMAN_GATE_UNSATISFIED, publish: ReasonCode.HUMAN_GATE_UNSATISFIED, checks: 0,
    });
  });

  it("ODNESTCONTROL an exactly bound flat \"service\" refusal still blocks CONFIRM, publish and merge, and outranks a later approval when dated later", async () => {
    const w = await world([ITEM_A], true);
    decide(w, ITEM_B, true, "approved");
    writeOutsideTheGuard(w.harness.cp.config.databasePath, w.runId, decision(w, "flat refusal"), w.candidate, w.harness.clock.nowIso());
    expect({ gate: gate(w), confirm: confirm(w), publish: await publish(w) }).toEqual({
      gate: UNSATISFIED, confirm: ReasonCode.HUMAN_GATE_UNSATISFIED, publish: ReasonCode.HUMAN_GATE_UNSATISFIED,
    });
    const m = await world([ITEM_A, ITEM_B]);
    expect(await publish(m)).toBe("ALLOWED");
    const pullNumber = await openPull(m);
    writeOutsideTheGuard(m.harness.cp.config.databasePath, m.runId, decision(m, "flat refusal future"), m.candidate, FUTURE);
    decide(m, ITEM_B, true, "approved again");
    expect({ gate: gate(m), merged: await merge(m, pullNumber), merges: m.github.mergeCount }).toEqual({
      gate: UNSATISFIED, merged: ReasonCode.HUMAN_GATE_UNSATISFIED, merges: 0,
    });
  });

  it("ODNESTCONTROL a flat \"service\" refusal bound to another candidate, gate or receipt is ignored", async () => {
    const w = await world([ITEM_A], true);
    decide(w, ITEM_B, true, "approved");
    const path = w.harness.cp.config.databasePath;
    writeOutsideTheGuard(path, w.runId, decision(w, "other content candidate", { contentCandidate: OTHER_CANDIDATE }), w.candidate, FUTURE);
    writeOutsideTheGuard(path, w.runId, decision(w, "other gate", { gate: digestOf([ITEM_B]) }), w.candidate, FUTURE);
    writeOutsideTheGuard(path, w.runId, decision(w, "other receipt run", { receipt: { runId: "run_other" } }), w.candidate, FUTURE);
    writeOutsideTheGuard(path, w.runId, decision(w, "stored for another candidate"), OTHER_CANDIDATE, FUTURE);
    expect({ gate: gate(w), confirm: confirm(w), publish: await publish(w) }).toEqual({ gate: SATISFIED, confirm: "ALLOWED", publish: "ALLOWED" });
  });

  it("ODNESTCONTROL a flat \"service\" approval is never promoted: the item is named to decide again", async () => {
    const w = await world([ITEM_A], true);
    writeOutsideTheGuard(w.harness.cp.config.databasePath, w.runId, decision(w, "flat approve", { approved: true }), w.candidate, w.harness.clock.nowIso());
    expect({ gate: gate(w), confirm: confirm(w) }).toEqual({
      gate: { satisfied: false, decideAgain: [ITEM_B], digest: false }, confirm: ReasonCode.HUMAN_GATE_UNSATISFIED,
    });
  });
});
