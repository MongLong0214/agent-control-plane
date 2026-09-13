import { afterAll, describe, expect, it } from "vitest";

import { Daemon, OPERATOR_METHOD, type AuthenticatedOperatorPeer } from "../../src/daemon/daemon.ts";
import { C0_QUALIFIED_CLIENT } from "../../src/mcp/role-conversation.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #886. Two pins gate the canonical end state and neither knows about the other:
 *
 *     claim  canonical-self-claim.ts clause 2, from ACP_CANONICAL_REQUIRED_EXECUTOR_VERSION
 *     wake   role-conversation.ts registerEndpoint, from C0_QUALIFIED_CLIENT
 *
 * A deployment where they name different builds admits no process: a claimant on the deployment
 * pin is refused `ROLE_PEER_UNSUPPORTED` when it registers, and one on the qualified build is
 * refused at the claim. Measured on 2026-09-13, the live deployment had exactly that — the source
 * moved to a newer build when #835 merged and the three Keychain values did not follow, for two
 * days, with no surface reporting it.
 *
 * The expectation is read out of the product rather than written here. A literal version in this
 * file would be a third authority on the same question, which is the shape #886 is about.
 */
const PEER: AuthenticatedOperatorPeer = {
  channel: "cli",
  peerId: "cli:fixture-operator",
  actor: "fixture-operator",
  incarnation: "incarnation-1",
};

const CODE = "CANONICAL_EXECUTOR_PIN_DISAGREES_WITH_WAKE_TRANSPORT";

const findingsAfter = async (
  label: string,
  install: (daemon: Daemon) => void,
): Promise<Array<{ code: string; observedEvidence?: Record<string, unknown> }>> => {
  const harness = makeHarness();
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  const daemon = new Daemon(harness.cp, { stateDir: tempDir(`acp-pin-${label}-`) });
  const started = await daemon.start();
  expect(started.allowed).toBe(true);
  install(daemon);
  const response = await daemon.handleOperatorRequest(
    { requestId: `doctor-${label}`, method: OPERATOR_METHOD.DOCTOR_RUN, params: { scope: "system" } },
    PEER,
  );
  expect(response.allowed).toBe(true);
  await daemon.stop();
  return (response as { value: { findings: Array<{ code: string; observedEvidence?: Record<string, unknown> }> } })
    .value.findings;
};

describe("the claim's executor pin and the wake transport's client pin must name one build (#886)", () => {
  it("reports the disagreement, naming both versions and both authorities", async () => {
    // A version that cannot equal the qualified one, derived from it rather than typed: a literal
    // here would pass today and silently stop being a disagreement the day the pin moves to it.
    const stale = `${C0_QUALIFIED_CLIENT.version}-stale`;
    const findings = await findingsAfter("disagree", (daemon) => daemon.setCanonicalExecutorVersion(stale));

    expect(findings).toContainEqual(expect.objectContaining({
      code: CODE,
      // Both sides and where each lives, because the repair is to move one of them and the
      // operator has to know which is configuration and which is the build.
      observedEvidence: expect.objectContaining({
        deploymentExecutorPin: stale,
        deploymentPinSource: "ACP_CANONICAL_REQUIRED_EXECUTOR_VERSION",
        wakeTransportQualifiedClient: `${C0_QUALIFIED_CLIENT.name}/${C0_QUALIFIED_CLIENT.version}`,
      }),
    }));
  });

  it("stays quiet when the deployment pin names the qualified build — the control", async () => {
    const findings = await findingsAfter("agree", (daemon) =>
      daemon.setCanonicalExecutorVersion(C0_QUALIFIED_CLIENT.version));

    expect(findings).not.toContainEqual(expect.objectContaining({ code: CODE }));
  });

  it("stays quiet when canonical self-claim was never activated, which is not a disagreement", async () => {
    // The composition root calls the setter only inside the activation block, so an unactivated
    // deployment leaves it null. Reporting here would make every deployment that has never heard
    // of canonical self-claim carry an ERROR about a pin it does not have.
    const findings = await findingsAfter("absent", () => {});

    expect(findings).not.toContainEqual(expect.objectContaining({ code: CODE }));
  });
});
