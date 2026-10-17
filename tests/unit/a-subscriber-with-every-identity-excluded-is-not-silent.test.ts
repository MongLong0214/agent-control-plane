import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { BuzzMentionAdmissionSnapshot } from "../../src/buzz/buzz-mention-subscriber.ts";
import { Daemon, OPERATOR_METHOD, type AuthenticatedOperatorPeer } from "../../src/daemon/daemon.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * #1108. `BUZZ_MENTION_SUBSCRIBER_SILENT` says "no relay frame has reached this subscriber; check
 * the relay". With every configured identity excluded on purpose (every CTO paused, say) no socket
 * is open, so no frame can arrive, and health already reports admission NONE with each identity's
 * reason. The warning now reads that admission state: it reports no fault while nothing is
 * admitted, and still fires for an admitted identity that has received nothing.
 *
 * The grace window is aged by moving `Date.now` past it after the receipt is stamped, which is the
 * one clock both the stamp and the finding read.
 */
const PEER: AuthenticatedOperatorPeer = {
  channel: "cli",
  peerId: "cli:fixture-operator",
  actor: "fixture-operator",
  incarnation: "incarnation-1",
};
const SILENT = "BUZZ_MENTION_SUBSCRIBER_SILENT";
const PAST_GRACE_MS = 600_000 + 1;

const identity = (n: number, state: "ADMITTED" | "EXCLUDED") => ({
  identity: `cto-${n}`,
  identityPubkey: String(n).repeat(64).slice(0, 64),
  state,
  reason: state === "EXCLUDED" ? "BINDING_PAUSED" : null,
  roleKey: state === "ADMITTED" ? `PRIMARY_CTO:project-${n}` : null,
  bindingGeneration: state === "ADMITTED" ? 1 : null,
  excludedSinceSeconds: state === "EXCLUDED" ? 1 : null,
  notDelivered: [],
});

const admissionOf = (...states: Array<"ADMITTED" | "EXCLUDED">): BuzzMentionAdmissionSnapshot => {
  const identities = states.map((state, index) => identity(index + 1, state));
  const admittedIdentities = identities.filter((one) => one.state === "ADMITTED").length;
  return {
    continuity: admittedIdentities === identities.length ? "FULL" : admittedIdentities === 0 ? "NONE" : "PARTIAL",
    configuredIdentities: identities.length,
    admittedIdentities,
    identities,
  };
};

const silentFindings = async (
  label: string,
  admission: BuzzMentionAdmissionSnapshot | undefined,
  agedMs: number,
): Promise<Array<{ code: string; observedEvidence?: Record<string, unknown> }>> => {
  const harness = makeHarness();
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  const daemon = new Daemon(harness.cp, { stateDir: tempDir(`acp-silent-${label}-`) });
  expect((await daemon.start()).allowed).toBe(true);
  const configured = admission?.configuredIdentities ?? 1;
  daemon.setBuzzMentionReceipt({
    configuredIdentities: configured,
    counters: () => ({ framesHandled: 0, admitted: 0, rejections: {}, ...(admission ? { admission } : {}) }),
  });
  const stampedAt = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(stampedAt + agedMs);
  const response = await daemon.handleOperatorRequest(
    { requestId: `doctor-${label}`, method: OPERATOR_METHOD.DOCTOR_RUN, params: { scope: "system" } },
    PEER,
  );
  vi.restoreAllMocks();
  await daemon.stop();
  expect(response.allowed).toBe(true);
  return (response as { value: { findings: Array<{ code: string; observedEvidence?: Record<string, unknown> }> } })
    .value.findings.filter((finding) => finding.code === SILENT);
};

describe("the subscriber-silent warning reads admission (#1108)", () => {
  it("reports no fault when every configured identity is deliberately excluded", async () => {
    expect(await silentFindings("all-excluded", admissionOf("EXCLUDED", "EXCLUDED"), PAST_GRACE_MS)).toEqual([]);
  });

  it("still fires for an admitted identity that has received no frame past the grace window", async () => {
    const findings = await silentFindings("partial", admissionOf("ADMITTED", "EXCLUDED"), PAST_GRACE_MS);
    expect(findings).toEqual([expect.objectContaining({
      code: SILENT,
      observedEvidence: expect.objectContaining({ configuredIdentities: 2, admittedIdentities: 1, framesHandled: 0 }),
    })]);
  });

  it("still fires when every identity is admitted and nothing arrived", async () => {
    expect(await silentFindings("full", admissionOf("ADMITTED"), PAST_GRACE_MS)).toHaveLength(1);
  });

  it("keeps the old reading for a receipt that carries no admission", async () => {
    expect(await silentFindings("no-admission", undefined, PAST_GRACE_MS)).toHaveLength(1);
  });

  it("keeps the grace window for an admitted identity", async () => {
    expect(await silentFindings("in-grace", admissionOf("ADMITTED"), 1_000)).toEqual([]);
  });
});
