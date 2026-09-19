import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { provisionReviewerCodexHome } from "../../src/runtime/reviewer-codex-home.ts";
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
 * These rows are about what the doctor reports, about the two things it must not do — open a
 * credential, or block — and about the trap this check was one revision away from becoming: a
 * second implementation of the capsule contract that reports healthy for a capsule the claim
 * refuses.
 */
const scopeFindings = async (harness: ReturnType<typeof makeHarness>) =>
  (await harness.cp.doctor.run("system")).findings.filter(
    (finding) => finding.code === ReasonCode.PACKET_REVIEWER_SCOPE_UNAVAILABLE,
  );

const capsules: string[] = [];
afterAll(() => { for (const root of capsules) rmSync(dirname(root), { recursive: true, force: true }); });

/**
 * A real capsule, made the only way one is ever made.
 *
 * Built by hand from `mkdtemp` at first, which is what let the first version of this check pass a
 * directory `claimReviewerCodexHome` refuses outright — the private namespace, the UUID capsule
 * name and the 0700 ancestors are all part of the contract, and a fixture that skips them tests a
 * capsule production never sees.
 */
const capsule = (parts: { claimed?: boolean; auth?: boolean }): string => {
  const root = provisionReviewerCodexHome();
  capsules.push(root);
  if (parts.claimed) mkdirSync(join(dirname(root), "claimed"), { mode: 0o700 });
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
    process.env["ACP_REVIEWER_CODEX_HOME"] = capsule({ claimed: true, auth: true });
    expect((await scopeFindings(makeHarness()))[0]?.observedEvidence)
      .toMatchObject({ state: "ALREADY_CLAIMED" });

    process.env["ACP_REVIEWER_CODEX_HOME"] = capsule({});
    expect((await scopeFindings(makeHarness()))[0]?.observedEvidence)
      .toMatchObject({ state: "NOT_AUTHENTICATED" });
  });

  it("does not call a capsule the claim would refuse a healthy one", async () => {
    // The failure this check exists to prevent, aimed at the check itself. Both of these are
    // shaped like a capsule and are refused by `claimReviewerCodexHome`, so a doctor that answered
    // from `existsSync` alone would report each as usable and the deployment would learn otherwise
    // at the review — which is #512 again, from inside the thing that was supposed to catch it.
    const outside = mkdtempSync(join(tmpdir(), "acp-reviewer-lookalike-"));
    const root = join(outside, "home");
    mkdirSync(root, { mode: 0o700 });
    writeFileSync(join(outside, "identity.json"), JSON.stringify({ root }), { mode: 0o600 });
    writeFileSync(join(root, "auth.json"), "{}", { mode: 0o600 });
    process.env["ACP_REVIEWER_CODEX_HOME"] = root;
    expect((await scopeFindings(makeHarness()))[0]?.observedEvidence)
      .toMatchObject({ state: "UNUSABLE_CAPSULE" });

    // A real capsule whose receipt was replaced with one that does not verify. The receipt is
    // present, so this is not "no login yet" — it is a capsule that cannot be used.
    const tampered = capsule({ auth: true });
    writeFileSync(join(dirname(tampered), "identity.json"), JSON.stringify({ root: tampered }), { mode: 0o600 });
    process.env["ACP_REVIEWER_CODEX_HOME"] = tampered;
    expect((await scopeFindings(makeHarness()))[0]?.observedEvidence)
      .toMatchObject({ state: "UNUSABLE_CAPSULE" });
  });

  it("says nothing when the scope is usable", async () => {
    process.env["ACP_REVIEWER_CODEX_HOME"] = capsule({ auth: true });

    expect(await scopeFindings(makeHarness())).toEqual([]);
  });

  it("never blocks, and never opens the credential", async () => {
    // Blocking on a missing thing is how a daemon ends up parked behind the very coordinator that
    // would fix it (#950, #958). And the check answers from directory state alone: an `auth.json`
    // whose bytes are not JSON still counts as present, which is the proof that nothing parsed it.
    const root = capsule({});
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
