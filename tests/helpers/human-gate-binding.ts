import { digestOf } from "../../src/core/digest.ts";
import type { Harness } from "./harness.ts";

/** One required item's decision identity, as `ProductionGate.resolveHumanGate` binds it. */
export interface BoundItemDecision {
  item: string;
  source: "OWNER_DECISION" | "T3_APPROVAL";
  /** The canonical record's artifact digest, or the digest of the admitted T3 receipt. */
  decision: string;
}

/**
 * FIX-FINALIZER-DIGEST — the human-gate binding written out independently of the production gate: the
 * digest of the gate definition digest, the candidate and each item's decision identity. A test pins
 * the resolver to it (the value the finalizer names and the kernel compares must equal it), so dropping
 * any of the three from the resolver's digest is seen.
 */
export const humanGateBindingOf = (input: {
  items: readonly string[];
  candidateSnapshotDigest: string;
  decisions: readonly BoundItemDecision[];
}): string =>
  digestOf({
    humanGateDefinition: digestOf(input.items),
    candidateSnapshotDigest: input.candidateSnapshotDigest,
    decisions: input.decisions,
  });

/**
 * The binding the latest OWNER_DECISION record of every item would give if it counted, whatever its
 * label, receipt or bindings: what a payload names when it claims a forged, legacy or unbound record
 * decided the gate. The gate refusing that payload is then its own judgement of the record, not a
 * mismatch of digest forms. `override` names an item's decision identity directly, for a record that
 * was refused before it could be stored.
 */
export const bindingAsIfCounted = (
  harness: Harness,
  runId: string,
  items: readonly string[],
  override: Readonly<Record<string, string>> = {},
): string => {
  const candidateSnapshotDigest = harness.cp.runs.currentCandidate(runId);
  if (!candidateSnapshotDigest) throw new Error(`run ${runId} has no current candidate`);
  const records = harness.cp.artifacts
    .list<{ kind?: unknown; item?: unknown }>(runId, "APPROVAL")
    .filter((artifact) => artifact.content.kind === "OWNER_DECISION");
  const decisions = items.map((item): BoundItemDecision => {
    const decision = override[item] ?? records.filter((artifact) => artifact.content.item === item).at(-1)?.digest;
    if (!decision) throw new Error(`no OWNER_DECISION record of ${item} to bind`);
    return { item, source: "OWNER_DECISION", decision };
  });
  return humanGateBindingOf({ items, candidateSnapshotDigest, decisions });
};
