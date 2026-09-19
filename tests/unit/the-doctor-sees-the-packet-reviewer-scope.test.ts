import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #512 — the packet reviewer's credential scope was unconfigured and nothing said so.
 *
 * The blind-review gate needs a private reviewer `CODEX_HOME` the moment a candidate reaches
 * review. `ACP_REVIEWER_CODEX_HOME` was set in neither the launcher nor the run harness while the
 * capsules sat on disk with nothing pointing at one, so the deployment read healthy right up to
 * the review that needed it.
 *
 * Late is not the whole cost. `claimReviewerCodexHome` writes a `claimed` marker with no
 * auto-release — deliberately, because "a lack of session bookkeeping is not proof that every
 * native descendant has exited" — so a run that fails *after* claiming still spends the capsule.
 * Discovering this at review time costs one capsule per discovery, and it cost the last free one
 * on 2026-09-19.
 *
 * These rows are about what the doctor reports, and about the two things it must not do: open a
 * credential, or block.
 */
const scopeFindings = async (harness: ReturnType<typeof makeHarness>) =>
  (await harness.cp.doctor.run("system")).findings.filter(
    (finding) => finding.code === ReasonCode.PACKET_REVIEWER_SCOPE_UNAVAILABLE,
  );

/** A capsule in the shape `claimReviewerCodexHome` expects, built piece by piece. */
const capsuleWith = (parts: { identity?: boolean; claimed?: boolean; auth?: boolean }): string => {
  const capsule = mkdtempSync(join(tmpdir(), "acp-reviewer-capsule-"));
  const root = join(capsule, "home");
  mkdirSync(root, { mode: 0o700 });
  if (parts.identity) writeFileSync(join(capsule, "identity.json"), JSON.stringify({ root }), { mode: 0o600 });
  if (parts.claimed) mkdirSync(join(capsule, "claimed"), { mode: 0o700 });
  if (parts.auth) writeFileSync(join(root, "auth.json"), "{}", { mode: 0o600 });
  return root;
};

describe("the doctor sees the packet reviewer's scope", () => {
  const original = process.env["ACP_REVIEWER_CODEX_HOME"];

  beforeEach(() => { delete process.env["ACP_REVIEWER_CODEX_HOME"]; });
  afterEach(() => {
    if (original === undefined) delete process.env["ACP_REVIEWER_CODEX_HOME"];
    else process.env["ACP_REVIEWER_CODEX_HOME"] = original;
  });

  it("reports the state this deployment was actually in: configured nowhere", async () => {
    // The exact shape of #512's first run. Nothing pointed at a capsule, and the only surface that
    // said so was a review failing 154 seconds in.
    const findings = await scopeFindings(makeHarness());

    expect(findings).toHaveLength(1);
    expect(findings[0]?.observedEvidence).toMatchObject({
      state: "UNCONFIGURED",
      variable: "ACP_REVIEWER_CODEX_HOME",
    });
  });

  it("distinguishes a spent capsule from an unauthenticated one", async () => {
    // Two different owner actions: a claimed capsule needs a new one provisioned, an
    // unauthenticated one needs a login into the capsule that already exists. One finding code for
    // both would leave the operator to guess which.
    process.env["ACP_REVIEWER_CODEX_HOME"] = capsuleWith({ identity: true, claimed: true, auth: true });
    expect((await scopeFindings(makeHarness()))[0]?.observedEvidence)
      .toMatchObject({ state: "ALREADY_CLAIMED" });

    process.env["ACP_REVIEWER_CODEX_HOME"] = capsuleWith({ identity: true });
    expect((await scopeFindings(makeHarness()))[0]?.observedEvidence)
      .toMatchObject({ state: "NOT_AUTHENTICATED" });

    process.env["ACP_REVIEWER_CODEX_HOME"] = capsuleWith({ auth: true });
    expect((await scopeFindings(makeHarness()))[0]?.observedEvidence)
      .toMatchObject({ state: "NO_IDENTITY_RECEIPT" });
  });

  it("says nothing when the scope is usable", async () => {
    process.env["ACP_REVIEWER_CODEX_HOME"] = capsuleWith({ identity: true, auth: true });

    expect(await scopeFindings(makeHarness())).toEqual([]);
  });

  it("never blocks, and never opens the credential", async () => {
    // Blocking on a missing thing is how a daemon ends up parked behind the very coordinator that
    // would fix it (#950, #958). And the check answers from directory state alone: an `auth.json`
    // whose bytes are not JSON still counts as present, which is the proof that nothing parsed it.
    const root = capsuleWith({ identity: true });
    writeFileSync(join(root, "auth.json"), "not json at all — if this is parsed, the check throws", { mode: 0o600 });
    process.env["ACP_REVIEWER_CODEX_HOME"] = root;

    const report = await makeHarness().cp.doctor.run("system");
    const findings = report.findings.filter(
      (finding) => finding.code === ReasonCode.PACKET_REVIEWER_SCOPE_UNAVAILABLE,
    );

    expect(findings).toEqual([]);
    expect(report.findings.filter((finding) => finding.blocking).map((finding) => finding.code))
      .not.toContain(ReasonCode.PACKET_REVIEWER_SCOPE_UNAVAILABLE);
  });
});
