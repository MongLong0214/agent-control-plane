/**
 * U6: the client build `C0_QUALIFIED_CLIENT` names is a build somebody measured.
 *
 * The pin's own comment states the contract -- "a newer client is *unqualified*, not *newer than
 * qualified*, until somebody measures it and moves this constant" -- and that contract has two
 * halves. The refusal in `registerEndpoint` enforces the first. Nothing enforced the second: the
 * C0 harness deleted its temp root on exit, so the constant recorded a conclusion whose reading no
 * longer existed anywhere. `evidence/u6-wake-transport-qualification.json` is that reading, and
 * the first row below is what makes the pin unable to move without one.
 *
 * The rows split on purpose:
 *
 *   - The receipt row runs everywhere, including where no client is installed. It is about
 *     agreement between two artefacts in the repository and needs nothing from the host.
 *   - The measurement rows re-take the reading, and skip -- naming why -- where it cannot be
 *     taken. A pass that required only the receipt would let a hand-written file qualify a build,
 *     which is the one hole a response check cannot close; re-measuring is what closes it, and it
 *     can only close it on a machine that has the client.
 */
import { describe, expect, it } from "vitest";

import {
  RECEIPT_PATH,
  QUALIFICATION_ID,
  SUITE_CAPTURE_DIR,
  armPassed,
  interactiveBlocker,
  readReceipt,
  resolveClaudeImage,
  runQualificationProbe,
  type ProbeRun,
} from "./wake-transport-qualification/harness.ts";
import { C0_QUALIFIED_CLIENT, ROLE_WAKE_FRAME, ROLE_WAKE_TOKEN } from "../../src/mcp/role-conversation.ts";

/** Long, because each arm starts a real client and waits out a settle ceiling. */
const PROBE_TIMEOUT_MS = 300_000;

const blocker = interactiveBlocker();

describe("U6: the wake transport is pinned to a build a receipt qualified", () => {
  it("the pinned client build is the one the committed receipt measured", () => {
    const receipt = readReceipt(RECEIPT_PATH);
    expect(receipt, `no qualification receipt at ${RECEIPT_PATH}`).not.toBeNull();
    if (receipt === null) return;

    expect(receipt.qualification).toBe(QUALIFICATION_ID);
    expect(receipt.verdict).toBe("qualified");

    // The pin and the receipt are the two artefacts that have to agree. Moving one without the
    // other is the failure this row exists to make loud.
    expect(receipt.client.name).toBe(C0_QUALIFIED_CLIENT.name);
    expect(receipt.client.version).toBe(C0_QUALIFIED_CLIENT.version);

    // And the reading has to be of the bytes production sends. A receipt that qualified some
    // other frame would qualify some other transport.
    expect(receipt.frame.utf8).toBe(ROLE_WAKE_FRAME);
    expect(receipt.frame.token).toBe(ROLE_WAKE_TOKEN);

    // An image without a digest is a filename, and a filename is not a build.
    expect(receipt.client.imageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.client.versionOutput).toContain(C0_QUALIFIED_CLIENT.version);
  });

  it("that receipt carries an interactive injection and its control, and both met the criterion", () => {
    const receipt = readReceipt(RECEIPT_PATH);
    expect(receipt).not.toBeNull();
    if (receipt === null) return;

    const interactive = receipt.runs.filter((run) => run.shape === "interactive");
    const injection = interactive.find((run) => run.injected);
    const control = interactive.find((run) => !run.injected);

    // Interactive specifically. `isInteractiveClaudeInvocation` refuses the headless flags, so a
    // receipt carrying only the headless arm would qualify a process that cannot hold the claim.
    expect(injection, "the receipt has no interactive injection arm").toBeDefined();
    expect(control, "the receipt has no interactive control arm").toBeDefined();
    if (!injection || !control) return;

    // Not "the socket accepted it": the wake has to be in a body the CLI sent to be inferred on,
    // and it has to have caused a request the baseline had not already made.
    expect(injection.wakeCarryingModelRequests).toBeGreaterThan(0);
    expect(injection.followUpAfterInjection).toBe(true);
    expect(injection.modelRequests).toBeGreaterThan(injection.baselineModelRequests);

    // The control is only a control if it could have produced a positive: same harness, one
    // input removed, and a settle *ceiling* no shorter than the injection arm's.
    //
    // Ceiling, not observation. The injection arm returns the moment its follow-up request
    // appears, while the control sleeps the whole span, so equal values here say the two arms
    // had an equal maximum window -- never that they were watched for equally long. What the
    // control buys is that its absence was not measured over the shorter window; the arms'
    // actual observed spans are unequal and the instrument does not record them.
    expect(control.wakeCarryingModelRequests).toBe(0);
    expect(control.followUpAfterInjection).toBe(false);
    expect(
      control.settleCeilingMs,
      "the control's settle ceiling is not the injection arm's, so its absence was measured over a different maximum window",
    ).toBe(injection.settleCeilingMs);

    // The old name for that field was `settleMs`, documented as "the wall clock both arms
    // waited" -- which is false for the injection arm. A receipt that still spells it the old
    // way was written by an instrument that still makes the old claim, so this row fails rather
    // than reading a corrected field off an uncorrected file.
    for (const run of receipt.runs) {
      expect(run.settleCeilingMs, "a run row carries no settle ceiling").toBeGreaterThan(0);
      expect(Object.keys(run), "a run row still carries the pre-correction `settleMs`").not.toContain("settleMs");
    }

    // The interactive argv is what makes it interactive, so the receipt has to show it.
    for (const flag of ["-p", "--print", "--output-format", "--input-format"]) {
      expect(injection.command).not.toContain(flag);
      expect(control.command).not.toContain(flag);
    }

    // Home-redacted, because this file is committed and a path under a home is a username.
    for (const argument of [...injection.command, ...control.command]) {
      expect(argument.startsWith("/Users/")).toBe(false);
      expect(argument.startsWith("/home/")).toBe(false);
    }
  });
});

describe.skipIf(blocker !== null)("U6: the reading, re-taken", () => {
  const measured = new Map<string, Promise<ProbeRun>>();
  const probe = (inject: boolean): Promise<ProbeRun> => {
    const key = inject ? "injection" : "control";
    const existing = measured.get(key);
    if (existing) return existing;
    // Started once and shared: each arm costs a real client start, and two rows asking the same
    // question twice would measure the same thing at twice the price.
    // SUITE_CAPTURE_DIR, never RAW_CAPTURE_DIR: this run is a check, not a qualification, and the
    // receipt's `rawCapturePath` rows must keep pointing at the run that produced the receipt
    // (#837). The parameter is required precisely so this line has to say which one it is.
    const started = runQualificationProbe({ shape: "interactive", inject, captureDir: SUITE_CAPTURE_DIR });
    measured.set(key, started);
    return started;
  };

  it(
    "GREEN: the production wake frame reaches an interactive session's model input and starts a turn",
    async () => {
      const run = await probe(true);
      expect(run.wakeCarryingModelRequests).toBeGreaterThan(0);
      expect(run.followUpAfterInjection).toBe(true);
      expect(armPassed(run)).toBe(true);
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    "the control, the same harness with the frame withheld, shows neither",
    async () => {
      const run = await probe(false);
      expect(run.wakeCarryingModelRequests).toBe(0);
      expect(run.followUpAfterInjection).toBe(false);

      // A control that could not have gone positive proves nothing about the arm it is a control
      // for. This is the same harness, and the injection arm above is the demonstration that it
      // goes positive when the one withheld input is supplied.
      // Equal ceilings, which is all `settleCeilingMs` can assert: the injected arm stops on its
      // follow-up request and the control does not, so their observed spans differ.
      const injected = await probe(true);
      expect(injected.settleCeilingMs).toBe(run.settleCeilingMs);
      expect(injected.baselineModelRequests).toBe(run.baselineModelRequests);
      expect(injected.followUpAfterInjection).not.toBe(run.followUpAfterInjection);
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    "the build it measured is the build the pin names",
    async () => {
      await probe(true);
      const image = resolveClaudeImage();
      expect(image).not.toBeNull();
      expect(image?.version).toBe(C0_QUALIFIED_CLIENT.version);
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    "the raw capture outlives the run that produced it",
    async () => {
      const run = await probe(true);

      // Stat'd, not believed from a flag the harness sets about itself: the probe has resolved,
      // so its teardown has run, and this is the difference between C0 and this slice.
      const { existsSync, readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { REPO_ROOT } = await import("./wake-transport-qualification/harness.ts");
      const raw = join(REPO_ROOT, run.rawCapturePath);
      expect(run.tempRootRemoved).toBe(true);
      expect(existsSync(raw)).toBe(true);
      expect(readFileSync(raw, "utf8")).toContain(ROLE_WAKE_TOKEN);
    },
    PROBE_TIMEOUT_MS,
  );
});

describe.skipIf(blocker === null)("U6: the reading cannot be taken here", () => {
  it("names what is missing rather than passing vacuously", () => {
    expect(interactiveBlocker()).toBe(blocker);
    expect(blocker).not.toBeNull();
  });
});
