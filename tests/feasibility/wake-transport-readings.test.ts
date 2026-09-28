/**
 * The rules that tie `WAKE_TRANSPORT_QUALIFIED_CLIENTS` to its committed readings, each shown to
 * trip on a fixture.
 *
 * `wake-transport-qualification.test.ts` applies these rules to the committed set and the committed
 * readings, where they agree — which says nothing about whether a rule could ever fail. A rule this
 * repository never trips is only a rule if some row can make it trip, so every rule is exercised
 * here against fixture sets and fixture readings: several builds, one missing its reading, one
 * resting on a failed measurement, one misfiled. Nothing here reads a build off the host, and
 * nothing spawns a client — the readings are built by the instrument's own `buildReceipt`, from
 * fixture runs, so their verdicts are derived the way a real one is rather than typed in.
 */
import { readFileSync, readdirSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildReceipt,
  qualificationDisagreements,
  readReadings,
  readingFileName,
  recordReading,
  type ProbeRun,
  type QualificationReceipt,
  type RecordedReading,
} from "./wake-transport-qualification/harness.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterEach(cleanupTempDirs);

const arm = (injected: boolean, metCriterion: boolean): ProbeRun => {
  const woke = injected === metCriterion;
  return {
    shape: "interactive",
    injected,
    command: ["~/fixture/claude", "--messaging-socket-path", "/private/tmp/fixture/s/inbox.sock"],
    // The digest of the fixture image below: every arm here ran the image its reading names.
    imageSha256: "0".repeat(64),
    baselineModelRequests: 1,
    modelRequests: woke ? 2 : 1,
    wakeCarryingModelRequests: woke ? 1 : 0,
    followUpAfterInjection: woke,
    settleCeilingMs: 20_000,
    rawCapturePath: "evidence/local/fixture/capture.jsonl",
    rawSessionLogPath: "evidence/local/fixture/session.log",
    tempRootRemoved: true,
  };
};

/** A reading of one fixture build, its verdict computed by the instrument from the arms it ran. */
const reading = (version: string, measurement: "met" | "missed" = "met"): QualificationReceipt =>
  buildReceipt({
    image: {
      path: `/fixture/versions/${version}`,
      sha256: "0".repeat(64),
      versionOutput: `${version} (Claude Code)`,
      version,
    },
    headSha: "0".repeat(40),
    runs: [arm(true, measurement === "met"), arm(false, true)],
    limits: [],
    findings: [],
  });

const filed = (value: QualificationReceipt, file = readingFileName(value.client)): RecordedReading => ({
  file,
  reading: value,
});

const build = (version: string) => ({ name: "claude-code", version });

describe("the qualified set and its readings must agree", () => {
  it("the fixtures mean what they say", () => {
    expect(reading("2.1.268").verdict).toBe("qualified");
    expect(reading("2.1.268", "missed").verdict).toBe("not-qualified");
  });

  it("agrees when every member has a qualified reading and every reading is a member — the control", () => {
    const members = [build("2.1.268"), build("2.1.282"), build("2.1.283")];
    const readings = [filed(reading("2.1.268")), filed(reading("2.1.282")), filed(reading("2.1.283"))];

    expect(qualificationDisagreements(members, readings)).toEqual([]);
  });

  it("a member with no reading is a failure, not a warning", () => {
    // Adding a member is a one-line edit to a constant; this is what stops it being the only edit.
    const members = [build("2.1.268"), build("2.1.282")];
    const readings = [filed(reading("2.1.268"))];

    expect(qualificationDisagreements(members, readings)).toEqual([
      "claude-code/2.1.282 is a qualified member with no reading",
    ]);
  });

  it("a member resting on a reading whose verdict is not qualified is a failure", () => {
    // The reading exists and names the member exactly, so every other rule is satisfied: only the
    // verdict says this build was measured and failed.
    const members = [build("2.1.268"), build("2.1.282")];
    const readings = [filed(reading("2.1.268")), filed(reading("2.1.282", "missed"))];

    expect(qualificationDisagreements(members, readings)).toEqual([
      'claude-code/2.1.282 is a qualified member resting on claude-code@2.1.282.json, whose verdict is "not-qualified"',
    ]);
  });

  it("a reading of a build outside the set is a failure, whatever its verdict", () => {
    const members = [build("2.1.268")];

    expect(qualificationDisagreements(members, [filed(reading("2.1.268")), filed(reading("2.1.283"))])).toEqual([
      "claude-code@2.1.283.json is a reading of claude-code/2.1.283, which is not a qualified member",
    ]);
    expect(
      qualificationDisagreements(members, [filed(reading("2.1.268")), filed(reading("2.1.283", "missed"))]),
    ).toEqual([
      "claude-code@2.1.283.json is a reading of claude-code/2.1.283, which is not a qualified member",
    ]);
  });

  it("membership is exact: a reading of a build near a member is not that member's reading", () => {
    const members = [build("2.1.268")];
    const readings = [filed(reading("2.1.268.1"))];

    expect(qualificationDisagreements(members, readings)).toEqual([
      "claude-code/2.1.268 is a qualified member with no reading",
      "claude-code@2.1.268.1.json is a reading of claude-code/2.1.268.1, which is not a qualified member",
    ]);
  });

  it("an arm that executed another image, or will not say which it executed, is a failure", () => {
    // `buildReceipt` cannot produce either of these -- it throws on an arm whose digest is not the
    // receipt's -- so both are built by replacing the runs of a reading it did produce. That is the
    // point: these rules read committed files, and a file can arrive hand-edited, from an older
    // instrument, or with its runs replaced, while every number in it still looks like a pass.
    const named = "0".repeat(64);
    const withArms = (runs: readonly ProbeRun[]): RecordedReading => filed({ ...reading("2.1.268"), runs });
    const members = [build("2.1.268")];

    // The control first: the reading the instrument produced, whose arms all ran the image it names.
    expect(qualificationDisagreements(members, [withArms(reading("2.1.268").runs)])).toEqual([]);

    const elsewhere = "b".repeat(64);
    expect(
      qualificationDisagreements(members, [withArms([arm(true, true), { ...arm(false, true), imageSha256: elsewhere }])]),
    ).toEqual([
      `claude-code@2.1.268.json: arm 2 (interactive, control) executed ${elsewhere}, not the ${named} this reading names`,
    ]);

    // The state the committed readings were actually in until 2026-09-28: no per-arm digest at all,
    // and every other rule satisfied. This is the one that used to pass.
    const { imageSha256: _dropped, ...silent } = arm(true, true);
    expect(qualificationDisagreements(members, [withArms([silent, arm(false, true)])])).toEqual([
      `claude-code@2.1.268.json: arm 1 (interactive, injection) does not say which image it executed, ` +
        `so nothing ties it to the ${named} this reading names`,
    ]);
  });

  it("a file holds the reading its name says, and a member is listed once", () => {
    expect(
      qualificationDisagreements([build("2.1.268")], [filed(reading("2.1.268"), "claude-code@2.1.282.json")]),
    ).toEqual([
      "claude-code@2.1.282.json holds the reading of claude-code/2.1.268, whose file is claude-code@2.1.268.json",
    ]);
    expect(qualificationDisagreements([build("2.1.268"), build("2.1.268")], [filed(reading("2.1.268"))])).toEqual([
      "claude-code/2.1.268 is listed in the qualified set more than once",
    ]);
  });
});

describe("qualifying one build records one file", () => {
  it("adds a build's reading, and a re-qualification replaces only that build's", () => {
    const directory = tempDir("acp-wq-readings-");
    const first = recordReading(reading("2.1.268"), directory);
    recordReading(reading("2.1.282"), directory);
    const untouched = readFileSync(first, "utf8");

    // The same build measured again, and failing this time: its reading is replaced, and the other
    // build's file is the same bytes it was before.
    const replaced = recordReading(reading("2.1.282", "missed"), directory);

    expect(readFileSync(first, "utf8")).toBe(untouched);
    expect(readdirSync(directory).sort()).toEqual(["claude-code@2.1.268.json", "claude-code@2.1.282.json"]);
    expect(readReadings(directory).map(({ file, reading: value }) => [file, value.verdict])).toEqual([
      ["claude-code@2.1.268.json", "qualified"],
      ["claude-code@2.1.282.json", "not-qualified"],
    ]);
    expect(replaced.endsWith("claude-code@2.1.282.json")).toBe(true);
  });

  it("an absent directory is no readings rather than an error", () => {
    expect(readReadings(`${tempDir("acp-wq-empty-")}/absent`)).toEqual([]);
  });

  it("a reading cannot be named after a part that is not a plain name", () => {
    for (const unsafe of ["../2.1.268", "2.1/268", "2.1@268", ".2.1.268", "-2.1.268", "", "2.1.268 "]) {
      expect(() => readingFileName({ name: "claude-code", version: unsafe }), JSON.stringify(unsafe)).toThrow();
      expect(() => readingFileName({ name: unsafe, version: "2.1.268" }), JSON.stringify(unsafe)).toThrow();
    }
    expect(readingFileName({ name: "claude-code", version: "2.1.268" })).toBe("claude-code@2.1.268.json");
  });
});
