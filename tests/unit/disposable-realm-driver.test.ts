import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  REALM_EVIDENCE_CLAIM,
  type OwnedProcess,
  productionRoot,
} from "../../src/acceptance/disposable-realm.ts";
import {
  assertCleanupCandidatesOwned,
  assertEvidenceStepsExecuted,
  createJanitorOwnedRealmWorkspace,
  runSyntheticDisposableRealmProbe,
} from "../../src/acceptance/disposable-realm-driver.ts";
import { disposableWorkspaceLocation } from "../../src/core/disposable-workspace-root.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";

describe("the disposable realm driver", () => {
  it("has no live credential or Bot API path", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/acceptance/disposable-realm-driver.ts", import.meta.url)),
      "utf8",
    );

    expect(source).not.toMatch(/process\.env|\b(?:tmpdir|homedir)\s*\(|ACP_TELEGRAM_|TelegramBotApi/);
  });

  it("establishes workspace placement without inherited HOME TMPDIR NODE_OPTIONS or cwd", async () => {
    const hostileRoot = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
    const inherited = {
      HOME: process.env["HOME"],
      TMPDIR: process.env["TMPDIR"],
      NODE_OPTIONS: process.env["NODE_OPTIONS"],
    };
    process.env["HOME"] = hostileRoot;
    process.env["TMPDIR"] = hostileRoot;
    process.env["NODE_OPTIONS"] = "--this-option-must-not-reach-the-janitor";

    let owned: Awaited<ReturnType<typeof createJanitorOwnedRealmWorkspace>> | null = null;
    try {
      owned = await createJanitorOwnedRealmWorkspace();
      expect(process.cwd()).toBe(hostileRoot);
      expect(owned.accountHome).toBe(userInfo().homedir);
      expect(owned.workspaceRoot).toBe(disposableWorkspaceLocation().workspaceRoot);
      expect(dirname(owned.workspace)).toBe(owned.workspaceRoot);
      expect(owned.workspace.startsWith(`${productionRoot(owned.accountHome)}/`)).toBe(false);
      expect(owned.workspace.startsWith(`${hostileRoot}/`)).toBe(false);
    } finally {
      if (owned) expect((await owned.janitor.release()).allowed).toBe(true);
      for (const [name, value] of Object.entries(inherited)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("runs two synthetic messages through the production Telegram entry and removes the realm", async () => {
    const result = await runSyntheticDisposableRealmProbe();

    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.value.mode).toBe("SYNTHETIC");
    expect(result.value.claim).toBe(REALM_EVIDENCE_CLAIM);
    expect(result.value.updateIds).toEqual([65_501, 65_502]);
    expect(result.value.replyCount).toBe(2);
    expect(result.value.driverHandledTurnCount).toBe(2);
    expect(result.value.ingressAppliedReplyCount).toBe(2);
    expect(result.value.createdActorCount).toBe(1);
    expect(result.value.createdTargetBindingCount).toBe(1);
    expect(result.value.syntheticBaselineUnchanged).toBe(true);
    expect(result.value.workspaceRemoved).toBe(true);
    expect(result.value.residue).toEqual([]);
    expect(result.value.steps).toContainEqual({
      id: "SQLITE_TEMPORARY_STORAGE_ESTABLISHED",
      status: "CHECKED_BY_RUN",
      statement:
        "Both synthetic control planes used in-memory SQLite temporary storage instead of native TMPDIR or SQLITE_TMPDIR file placement.",
    });
  });

  it("names every actor and durability gap as unproven in the artifact", async () => {
    const result = await runSyntheticDisposableRealmProbe();

    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.value.steps.filter((step) => step.status === "UNPROVEN")).toEqual([
      {
        id: "BOUND_ACTOR_HANDLED_PROBE",
        status: "UNPROVEN",
        statement:
          "The bound actor did not handle either probe message; the run used a driver-owned onDirect callback.",
      },
      {
        id: "PRODUCTION_CEO_PATH_ANSWERED",
        status: "UNPROVEN",
        statement:
          "The production CeoConversationPort and authenticated MCP peer were not connected or exercised.",
      },
      {
        id: "TARGET_AUTHORED_TRANSCRIPT",
        status: "UNPROVEN",
        statement:
          "No target process authored or persisted a transcript; the run did not observe target-owned state.",
      },
      {
        id: "CEO_DURABLE_COMMIT",
        status: "UNPROVEN",
        statement:
          "APPLIED is ingress reply-delivery state; the run did not prove a CEO-side durable commit.",
      },
      {
        id: "LIVE_CANONICAL_ACTIVATION",
        status: "UNPROVEN",
        statement:
          "Live Telegram, canonical state, actor reconstitution, duplicate freedom, the target fence and receipt, and activation were not exercised.",
      },
    ]);
  });

  it("labels each safety condition by what this successful run checked", async () => {
    const result = await runSyntheticDisposableRealmProbe();

    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.value.safetyConditions.map(({ condition, status }) => ({ condition, status })))
      .toEqual([
        {
          condition: "A realm that shares a path with production is not a realm",
          status: "CHECKED_BY_RUN",
        },
        {
          condition: "The probe may not address the canonical conversation",
          status: "ASSERTED_ONLY",
        },
        {
          condition: "Production has to be the same set of facts afterwards",
          status: "ASSERTED_ONLY",
        },
        {
          condition: "A failure to look is not an observation of absence",
          status: "CHECKED_BY_RUN",
        },
        {
          condition: "Disposable means observed to be gone",
          status: "CHECKED_BY_RUN",
        },
        {
          condition: "An unanswerable question is never followed by another message",
          status: "ASSERTED_ONLY",
        },
        {
          condition: "Cleanup terminates only what this run started",
          status: "ASSERTED_ONLY",
        },
        {
          condition: "The evidence claim is bounded in the code, not in the write-up",
          status: "CHECKED_BY_RUN",
        },
      ]);
  });

  it("refuses an artifact that marks an unexecuted step as checked by the run", () => {
    const result = assertEvidenceStepsExecuted([
      {
        id: "BOUND_ACTOR_HANDLED_PROBE",
        status: "CHECKED_BY_RUN",
        statement: "the bound actor handled the probe",
      },
    ], new Set());

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.ACCEPTANCE_EVIDENCE_OVERCLAIMED);
    expect(result.evidence).toMatchObject({ unsupportedSteps: ["BOUND_ACTOR_HANDLED_PROBE"] });
  });

  it("refuses when the real polling entry returns only one message", async () => {
    const result = await runSyntheticDisposableRealmProbe({ fault: "ONE_MESSAGE_ONLY" });

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.ACCEPTANCE_PROBE_INCOMPLETE);
    expect(result.evidence).toMatchObject({ outcomes: 1, ingressAppliedReplies: 1 });
  });

  it("refuses before the live transport fallback when synthetic injection is absent", async () => {
    const result = await runSyntheticDisposableRealmProbe({
      fault: "SYNTHETIC_TRANSPORT_NOT_INJECTED",
    });

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.ACCEPTANCE_PROBE_INCOMPLETE);
    expect(result.evidence).toMatchObject({
      configuredTransport: "DEFAULT_LIVE_FALLBACK",
      requiredTransport: "SYNTHETIC_INJECTED",
    });
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

  it("refuses a transport record that differs from the driver-owned callback reply", async () => {
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
    expect(result.evidence).toMatchObject({ polls: 1, sends: 1, driverHandledTurns: 1 });
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
