import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { Daemon } from "../../src/daemon/daemon.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #674 / #841. The Buzz mention path's one operator-visible number was `socketCount` — the count
 * of *configured identities*, captured at startup. It moves for neither of the two states an
 * operator has to tell apart: a subscriber connected and receiving nothing, and one receiving and
 * refusing. #674 asks for a resolved mention to wake the bound session, and could not be closed
 * on any evidence, because a successful delivery changed no observable.
 *
 * `health.json` now carries receipt beside configuration. The point is that the two numbers can
 * disagree — configuration says the subscriber exists, receipt says nothing has arrived.
 */
describe("health.json reports what the mention subscriber received, not only what it was configured to be", () => {
  const readBuzz = (stateDir: string): unknown =>
    (JSON.parse(readFileSync(join(stateDir, "health.json"), "utf8")) as { buzzMention: unknown }).buzzMention;

  it("says null when no subscriber is configured, which is not the same as a silent one", () => {
    const harness = makeHarness();
    const stateDir = tempDir("acp-buzz-receipt-absent-");
    const daemon = new Daemon(harness.cp, { stateDir });

    daemon.writeHealth(null);

    // A deployment without a subscriber has nothing to be silent about. Reporting zeroes here
    // would make "not set up" and "set up and receiving nothing" render identically — the exact
    // conflation this surface exists to end.
    expect(readBuzz(stateDir)).toBeNull();
  });

  it("reports configured identities and zero frames at the same time", () => {
    const harness = makeHarness();
    const stateDir = tempDir("acp-buzz-receipt-silent-");
    const daemon = new Daemon(harness.cp, { stateDir });

    daemon.setBuzzMentionReceipt({
      configuredIdentities: 1,
      counters: () => ({ framesHandled: 0, admitted: 0, rejections: {} }),
    });

    // The shape of the defect, stated as one object: configuration 1, receipt 0.
    expect(readBuzz(stateDir)).toEqual({
      configuredIdentities: 1,
      framesHandled: 0,
      admitted: 0,
      rejections: {},
    });
  });

  it("reports refusals under their reasons, so receiving-and-refusing is distinguishable", () => {
    const harness = makeHarness();
    const stateDir = tempDir("acp-buzz-receipt-refusing-");
    const daemon = new Daemon(harness.cp, { stateDir });

    daemon.setBuzzMentionReceipt({
      configuredIdentities: 1,
      counters: () => ({ framesHandled: 3, admitted: 1, rejections: { "event-not-addressed": 2 } }),
    });

    // Not merely a non-zero total: which refusal, because "the relay stopped attaching p tags"
    // and "this runtime holds two roles" are different repairs and a bare count cannot separate
    // them.
    expect(readBuzz(stateDir)).toEqual({
      configuredIdentities: 1,
      framesHandled: 3,
      admitted: 1,
      rejections: { "event-not-addressed": 2 },
    });
  });

  it("reads the counters at write time rather than copying them once", () => {
    const harness = makeHarness();
    const stateDir = tempDir("acp-buzz-receipt-live-");
    const daemon = new Daemon(harness.cp, { stateDir });

    let handled = 0;
    daemon.setBuzzMentionReceipt({
      configuredIdentities: 1,
      counters: () => ({ framesHandled: handled, admitted: 0, rejections: {} }),
    });

    daemon.writeHealth(null);
    expect(readBuzz(stateDir)).toMatchObject({ framesHandled: 0 });

    // The whole failure this replaces was a number captured once and read as a live one. A
    // snapshot taken at `setBuzzMentionReceipt` would still say 0 here.
    handled = 7;
    daemon.writeHealth(null);
    expect(readBuzz(stateDir)).toMatchObject({ framesHandled: 7 });
  });
});
