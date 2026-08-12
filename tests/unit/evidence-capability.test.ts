import { afterAll, describe, expect, it } from "vitest";

import * as artifactModule from "../../src/db/artifacts.ts";
import {
  ArtifactStore,
  EVIDENCE_PRODUCERS,
  type EvidenceWriter,
} from "../../src/db/artifacts.ts";
import { isAcpError } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ArtifactKind } from "../../src/domain/types.ts";
import {
  CANDIDATE_SNAPSHOT_SCHEMA_ID,
  candidateSnapshotDigest,
  type CandidateSnapshot,
} from "../../src/snapshot/candidate-snapshot.ts";
import { cleanupTempDirs, makeCore } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * Regression suite for #70 — "any in-process caller can impersonate an evidence-producing
 * engine". Every test here is negative: it holds something that a name-checking store would
 * have accepted and shows the store refusing it.
 */

const setup = () => {
  const core = makeCore();
  const runId = "run_capability";
  core.db.run(
    `INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
     VALUES (?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'ACTIVE', 'fixture goal', 'sha256:contract', ?)`,
    [runId, core.clock.nowIso()],
  );
  const snapshot: CandidateSnapshot = {
    schema: CANDIDATE_SNAPSHOT_SCHEMA_ID,
    runId,
    contractDigest: "sha256:contract",
    repositories: [{
      identity: "github:acme/fixture",
      repositoryRole: "primary",
      baseBranch: "main",
      baseHead: "a".repeat(40),
      candidateHead: "b".repeat(40),
      treeDigest: "git-tree:fixture",
      diffDigest: "sha256:fixture",
      worktreeId: null,
      manifestDigest: null,
      touchedPaths: ["src/app.ts"],
    }],
    createdAt: core.clock.nowIso(),
  };
  const digest = candidateSnapshotDigest(snapshot);
  core.artifacts.put(runId, ArtifactKind.CANDIDATE_SNAPSHOT, snapshot, digest);
  const verification = {
    runId,
    candidateSnapshotDigest: digest,
    contractDigest: "sha256:contract",
    expectedInputs: 1,
    observedInputs: 1,
    results: [],
    status: "PASS" as const,
    reasonCode: "OK",
    gaps: [],
  };
  return { ...core, runId, digest, verification };
};

/** The reason code a refusal carried, so a test asserts the denial and not just a throw. */
const denialOf = (write: () => unknown): string => {
  try {
    write();
  } catch (error) {
    return isAcpError(error) ? error.reasonCode : `unstructured:${String(error)}`;
  }
  return "not-refused";
};

describe("writing evidence requires an unforgeable capability, not a producer name", () => {
  it("refuses a caller that supplies the producer name and holds no capability", () => {
    const { artifacts, runId, digest, verification } = setup();

    // Exactly the old attack: the caller knows the literal the row is labelled with.
    const nameOnly = EVIDENCE_PRODUCERS.VERIFICATION as unknown as EvidenceWriter<"VERIFICATION">;
    expect(
      denialOf(() =>
        artifacts.putEvidence(nameOnly, runId, ArtifactKind.VERIFICATION, verification, digest),
      ),
    ).toBe(ReasonCode.COMPLETION_AUTHORITY_DENIED);
    expect(artifacts.latest(runId, ArtifactKind.VERIFICATION)).toBeNull();
  });

  it("refuses a structural look-alike, a spread copy and a prototype clone", () => {
    const { artifacts, runId, digest, verification } = setup();
    const writers = artifacts.issueEvidenceWriters();

    // `#minted` is a real private field: it is absent from a literal, is not copied by
    // spread, and is not installed by Object.create because the constructor never ran.
    const forgeries: EvidenceWriter<"VERIFICATION">[] = [
      { kind: "VERIFICATION" } as unknown as EvidenceWriter<"VERIFICATION">,
      { ...writers.VERIFICATION } as unknown as EvidenceWriter<"VERIFICATION">,
      Object.create(
        Object.getPrototypeOf(writers.VERIFICATION) as object,
      ) as EvidenceWriter<"VERIFICATION">,
    ];

    for (const forged of forgeries) {
      expect(
        denialOf(() =>
          artifacts.putEvidence(forged, runId, ArtifactKind.VERIFICATION, verification, digest),
        ),
      ).toBe(ReasonCode.COMPLETION_AUTHORITY_DENIED);
    }
    expect(artifacts.latest(runId, ArtifactKind.VERIFICATION)).toBeNull();
  });

  it("refuses the token constructor smuggled out through an issued capability", () => {
    const { artifacts } = setup();
    const writers = artifacts.issueEvidenceWriters();

    // The class is reachable by prototype walk even though it is never exported; the mint
    // guard is what stops that route, and the guard compares symbol identity, so
    // re-creating a symbol with the same description does not help.
    const Smuggled = (Object.getPrototypeOf(writers.VERIFICATION) as { constructor: unknown })
      .constructor as new (mint: symbol, kind: string) => unknown;

    expect(() => new Smuggled(Symbol("evidence-writer-mint"), "VERIFICATION")).toThrowError(
      /cannot be constructed outside its issuer/,
    );
    expect(denialOf(() => new Smuggled(Symbol.iterator, "VERIFICATION"))).toBe(
      ReasonCode.COMPLETION_AUTHORITY_DENIED,
    );
  });

  it("refuses a VERIFICATION capability presented for BLIND_REVIEW", () => {
    const { artifacts, runId, digest } = setup();
    const writers = artifacts.issueEvidenceWriters();

    // tsc rejects this call without the cast: EvidenceWriter is invariant in its kind, so
    // a VERIFICATION capability is not assignable to EvidenceWriter<"BLIND_REVIEW">. The
    // cast strips the compile-time barrier to show the runtime one standing on its own.
    const crossKind = writers.VERIFICATION as unknown as EvidenceWriter<"BLIND_REVIEW">;
    expect(
      denialOf(() =>
        artifacts.putEvidence(
          crossKind,
          runId,
          ArtifactKind.BLIND_REVIEW,
          { verdict: "PASS" },
          digest,
        ),
      ),
    ).toBe(ReasonCode.COMPLETION_AUTHORITY_DENIED);
    expect(artifacts.latest(runId, ArtifactKind.BLIND_REVIEW)).toBeNull();
  });

  it("refuses a second issuance for the same database, including through a second store", () => {
    const { db, clock, artifacts } = setup();
    artifacts.issueEvidenceWriters();

    expect(denialOf(() => artifacts.issueEvidenceWriters())).toBe(
      ReasonCode.COMPLETION_AUTHORITY_DENIED,
    );
    // Issuance is keyed by the database, not the store instance, so wrapping the same
    // database in a fresh store is not a way to mint a second capability for its rows.
    const shadowStore = new ArtifactStore(db, clock);
    expect(denialOf(() => shadowStore.issueEvidenceWriters())).toBe(
      ReasonCode.COMPLETION_AUTHORITY_DENIED,
    );
  });

  it("refuses in-process code that reaches the live store, because the root claimed first", () => {
    const harness = makeHarness();

    // The composition root claims the set inside its constructor. Anything that later gets
    // hold of `cp.artifacts` — a tool handler, a service, a test — finds it spent.
    expect(denialOf(() => harness.cp.artifacts.issueEvidenceWriters())).toBe(
      ReasonCode.COMPLETION_AUTHORITY_DENIED,
    );
    harness.cp.db.close();
  });

  it("exports no value from which a capability can be constructed or reached", () => {
    const { artifacts } = setup();
    const writers = artifacts.issueEvidenceWriters();
    const tokenPrototype = Object.getPrototypeOf(writers.VERIFICATION) as object;

    const exportedNames = Object.keys(artifactModule);
    expect(exportedNames).not.toContain("EvidenceWriter");
    expect(exportedNames).not.toContain("EvidenceWriterToken");
    // Stronger than a name check: no exported value is the token class, and none of them is
    // a factory that hands one back for free.
    for (const exported of Object.values(artifactModule)) {
      if (typeof exported !== "function") continue;
      expect((exported as { prototype?: unknown }).prototype).not.toBe(tokenPrototype);
    }
  });

  it("writes, and labels the row with the producer, only for the capability's holder", () => {
    const { artifacts, runId, digest, verification } = setup();
    const writers = artifacts.issueEvidenceWriters();

    const written = artifacts.putEvidence(
      writers.VERIFICATION,
      runId,
      ArtifactKind.VERIFICATION,
      verification,
      digest,
    );
    expect(written.producedBy).toBe(EVIDENCE_PRODUCERS.VERIFICATION);

    // And the non-evidence door stays shut: `put` cannot write an evidence kind at all.
    expect(denialOf(() => artifacts.put(runId, ArtifactKind.VERIFICATION, verification, digest)))
      .toBe(ReasonCode.COMPLETION_AUTHORITY_DENIED);
  });
});
