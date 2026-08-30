import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  REALM_EVIDENCE_CLAIM,
  type OwnedProcess,
} from "../../src/acceptance/disposable-realm.ts";
import {
  assertCleanupCandidatesOwned,
  runSyntheticDisposableRealmProbe,
} from "../../src/acceptance/disposable-realm-driver.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";

describe("the disposable realm driver", () => {
  it("has no live credential or Bot API path", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/acceptance/disposable-realm-driver.ts", import.meta.url)),
      "utf8",
    );

    expect(source).not.toMatch(/process\.env|ACP_TELEGRAM_|TelegramBotApi/);
  });

  it("runs two synthetic messages through the production Telegram entry and removes the realm", async () => {
    const result = await runSyntheticDisposableRealmProbe();

    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.value.mode).toBe("SYNTHETIC");
    expect(result.value.claim).toBe(REALM_EVIDENCE_CLAIM);
    expect(result.value.updateIds).toEqual([65_501, 65_502]);
    expect(result.value.replyCount).toBe(2);
    expect(result.value.targetTurnCount).toBe(2);
    expect(result.value.durableNonceCount).toBe(2);
    expect(result.value.disposableActorCount).toBe(1);
    expect(result.value.targetBindingCount).toBe(1);
    expect(result.value.syntheticBaselineUnchanged).toBe(true);
    expect(result.value.residue).toEqual([]);
  });

  it("refuses when the real polling entry returns only one message", async () => {
    const result = await runSyntheticDisposableRealmProbe({ fault: "ONE_MESSAGE_ONLY" });

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.ACCEPTANCE_PROBE_INCOMPLETE);
    expect(result.evidence).toMatchObject({ outcomes: 1, durableNonces: 1 });
  });

  it("refuses a derived realm path inside the fake production baseline", async () => {
    const result = await runSyntheticDisposableRealmProbe({
      fault: "REALM_POINTS_AT_FAKE_PRODUCTION",
    });

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.ACCEPTANCE_REALM_NOT_ISOLATED);
  });

  it("refuses a probe target equal to the synthetic canonical root", async () => {
    const result = await runSyntheticDisposableRealmProbe({
      fault: "PROBE_TARGET_IS_CANONICAL",
    });

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.ACCEPTANCE_PROBE_TARGET_IS_CANONICAL);
  });

  it("refuses a reply that the synthetic target did not author", async () => {
    const result = await runSyntheticDisposableRealmProbe({ fault: "FABRICATED_REPLY" });

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.ACCEPTANCE_PROBE_INCOMPLETE);
  });

  it("refuses two actors created through the binding lifecycle", async () => {
    const result = await runSyntheticDisposableRealmProbe({ fault: "SECOND_ACTOR" });

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.ACCEPTANCE_PROBE_INCOMPLETE);
    expect(result.evidence).toMatchObject({ actorIds: 2 });
  });

  it("treats an ambiguous send as terminal and never polls a second message", async () => {
    const result = await runSyntheticDisposableRealmProbe({ fault: "AMBIGUOUS_FIRST_SEND" });

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.ACCEPTANCE_PROBE_INCONCLUSIVE);
    expect(result.evidence).toMatchObject({ polls: 1, sends: 1, targetTurns: 1 });
  });

  it("refuses when the before census cannot be observed", async () => {
    const result = await runSyntheticDisposableRealmProbe({ fault: "BEFORE_CENSUS_UNOBSERVABLE" });

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.ACCEPTANCE_CENSUS_UNOBSERVABLE);
  });

  it("refuses when the synthetic baseline changes during the probe", async () => {
    const result = await runSyntheticDisposableRealmProbe({ fault: "SYNTHETIC_BASELINE_CHANGES" });

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.ACCEPTANCE_PRODUCTION_CHANGED);
  });

  it("refuses cleanup that leaves realm residue and then removes it with the janitor", async () => {
    const result = await runSyntheticDisposableRealmProbe({ fault: "LEAVE_REALM_RESIDUE" });

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.ACCEPTANCE_REALM_RESIDUE);
    expect(result.evidence).toMatchObject({ janitorRemovedResidue: true });
  });

  it("refuses a claim wider than the bounded disposable observation", async () => {
    const result = await runSyntheticDisposableRealmProbe({
      evidenceClaim: "the canonical CEO is safe and duplicate-free",
    });

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.ACCEPTANCE_EVIDENCE_OVERCLAIMED);
  });

  it("refuses to terminate a reused pid whose start time does not match", () => {
    const owned: OwnedProcess[] = [{ pid: 4242, startedAtMs: 1_700_000_000_000 }];

    const result = assertCleanupCandidatesOwned(owned, [
      { pid: 4242, startedAtMs: 1_700_000_001_000 },
    ]);

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.ACCEPTANCE_PROCESS_NOT_OWNED);
  });
});
