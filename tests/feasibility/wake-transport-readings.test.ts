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
import { generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  BASELINE_PROMPT,
  buildReceipt,
  countsFrom,
  observationsFrom,
  qualificationDisagreements as admissionDisagreements,
  readReadings,
  readingFileName,
  recordReading,
  signReading,
  witnessCarryingTurns,
  type ArmObservations,
  type ObservedText,
  type ProbeRun,
  type ProbeShape,
  type QualificationReceipt,
  type RecordedReading,
} from "./wake-transport-qualification/harness.ts";
import { ROLE_WAKE_TOKEN } from "../../src/mcp/role-conversation.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterEach(cleanupTempDirs);

const fixtureKeys = generateKeyPairSync("ed25519");
const qualificationDisagreements = (
  members: Parameters<typeof admissionDisagreements>[0],
  readings: Parameters<typeof admissionDisagreements>[1],
): string[] => admissionDisagreements(members, readings, fixtureKeys.publicKey);

/**
 * The argv each shape is started with, as `probeArgv` builds it.
 *
 * Fixture-real rather than decorative: the interactive one is an invocation
 * `isInteractiveClaudeInvocation` accepts, positional prompt and all, and the headless one carries
 * the flags it refuses. The rule that an arm's argv must be the shape it claims is checked against
 * these, so a fixture that got them the wrong way round would fail here rather than pass quietly.
 */
const COMMAND: Record<ProbeShape, readonly string[]> = {
  interactive: ["~/fixture/claude", "--messaging-socket-path", "/private/tmp/fixture/s/inbox.sock", "ping"],
  headless: [
    "~/fixture/claude",
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--messaging-socket-path",
    "/private/tmp/fixture/s/inbox.sock",
  ],
};

/**
 * A witness for one arm of one fixture reading, of the shape `mintArmWitness` produces.
 *
 * Derived rather than minted, because a row that names a value in an expected sentence needs the
 * same value on every run. Distinct per arm *and* per build: a reading that records a witness
 * another reading records is refused, so fixtures sharing them would trip that rule in every row
 * that files two readings.
 */
const witnessOf = (version: string, index: number): string =>
  `u6-witness-${`${version.replace(/\D/g, "")}${index}`.padEnd(32, "0")}`;

/**
 * A capture of the shape the fake provider writes: the prompt's turn, the wake's turn after it when
 * the wake landed, and the witness frame's turn when the arm wrote one.
 *
 * Built and then read by the instrument's own `observationsFrom`, rather than an observation list
 * typed in here: a fixture whose observations were written by hand could disagree with what the
 * reader derives from a real one and nobody would find out from this file. The wake text is the
 * live shape -- the token inside the prose the runtime composes around it -- and the witness text is
 * the same shape around the value the arm's second frame carried.
 */
const captureOf = (woke: boolean, witness: string | null): string => {
  const turn = (text: string): string =>
    `${JSON.stringify({
      at: "2026-09-28T00:00:00.000Z",
      method: "POST",
      url: "/v1/messages?beta=true",
      headers: {},
      body: JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text }] }] }),
    })}\n`;
  return (
    `${turn(BASELINE_PROMPT)}` +
    `${woke ? turn(`Another Claude session sent a message:\n${ROLE_WAKE_TOKEN}`) : ""}` +
    `${witness === null ? "" : turn(`Another Claude session sent a message:\n${witness}`)}`
  );
};

const arm = (shape: ProbeShape, injected: boolean, witness: string, metCriterion = true): ProbeRun => {
  const woke = injected === metCriterion;
  // The boundary this arm recorded: the prompt's turn preceded the frame, and any turn after it
  // arrived after. The control writes no frame and says so, which is a different record from an
  // injection arm whose frame happened to land at the same position.
  //
  // The witness is recorded on every arm and echoed only where a frame was written, which is what
  // the instrument does: the control mints one and sends nothing, so the turn carrying it is absent
  // from its capture rather than the value being absent from its record.
  const observations: ArmObservations = {
    ...observationsFrom(captureOf(woke, injected ? witness : null), {
      frameWritten: injected, requestsBefore: 1,
      ...(injected ? { requestsBeforeWitness: woke ? 2 : 1 } : {}),
    }, BASELINE_PROMPT, witness),
    witness,
  };
  return {
    shape,
    injected,
    command: COMMAND[shape],
    // The digest of the fixture image below: every arm here ran the image its reading names.
    imageSha256: "0".repeat(64),
    observations,
    // Derived from the observations, as the probe derives them: a fixture that stated its counts
    // separately could drift from the observations beside it, which is the defect these rules are
    // about.
    ...countsFrom(observations),
    settleCeilingMs: 20_000,
    rawCapturePath: "evidence/local/fixture/capture.jsonl",
    rawSessionLogPath: "evidence/local/fixture/session.log",
    tempRootRemoved: true,
  };
};

/**
 * The four arms one reading is made of, in the order `qualify()` runs them.
 *
 * Four rather than two because that is what qualifies a build: injection against control, in both
 * shapes. A fixture of two would be a fixture of something the instrument will not accept.
 */
const arms = (measurement: "met" | "missed" = "met", version = "2.1.268"): ProbeRun[] => [
  arm("interactive", true, witnessOf(version, 1), measurement === "met"),
  arm("interactive", false, witnessOf(version, 2)),
  arm("headless", true, witnessOf(version, 3)),
  arm("headless", false, witnessOf(version, 4)),
];

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
    runs: arms(measurement, version),
    limits: [],
    findings: [],
  });

const filed = (value: QualificationReceipt, file = readingFileName(value.client)): RecordedReading => ({
  file,
  reading: value.signature === undefined ? signReading(value, fixtureKeys.privateKey) : value,
});

/** A reading the instrument produced, with its runs replaced -- the shape a hand-edited file has. */
const withArms = (runs: readonly ProbeRun[], version = "2.1.268"): RecordedReading =>
  filed({ ...reading(version), runs });

const build = (version: string) => ({ name: "claude-code", version });

const resting = (version: string, shortfall: string): string =>
  `claude-code/${version} is a qualified member resting on claude-code@${version}.json, whose own runs do not qualify it: ${shortfall}`;

describe("the qualified set and its readings must agree", () => {
  it("refuses an unsigned reading", () => {
    expect(qualificationDisagreements([build("2.1.268")], [{ file: "claude-code@2.1.268.json", reading: reading("2.1.268") }]))
      .toContain("claude-code@2.1.268.json has no valid ceremony signature");
  });

  it("refuses a replaced control witness even when every captured text stays unchanged", () => {
    const original = signReading(reading("2.1.268"), fixtureKeys.privateKey);
    const runs = original.runs.map((run, index) => index === 1
      ? { ...run, observations: { ...run.observations!, witness: witnessOf("2.1.268", 9) } }
      : run);
    expect(qualificationDisagreements([build("2.1.268")], [filed({ ...original, runs })]))
      .toContain("claude-code@2.1.268.json has no valid ceremony signature");
  });

  it("refuses a kept text edited after signing even if counts still agree", () => {
    const original = signReading(reading("2.1.268"), fixtureKeys.privateKey);
    const runs = original.runs.map((run, index) => index === 0 ? {
      ...run,
      observations: { ...run.observations!, requests: run.observations!.requests.map((request, at) => at === 1
        ? { ...request, texts: request.texts.map((entry) => "text" in entry
          ? { ...entry, text: `${entry.text} edited` } : entry) }
        : request) },
    } : run);
    expect(qualificationDisagreements([build("2.1.268")], [filed({ ...original, runs })]))
      .toContain("claude-code@2.1.268.json has no valid ceremony signature");
  });

  it("refuses a reading with a signature from another key", () => {
    const wrong = signReading(reading("2.1.268"), generateKeyPairSync("ed25519").privateKey);
    expect(qualificationDisagreements([build("2.1.268")], [filed(wrong)]))
      .toContain("claude-code@2.1.268.json has no valid ceremony signature");
  });

  it("production admission uses the committed key, not the fixture key", () => {
    expect(admissionDisagreements([build("2.1.268")], [filed(reading("2.1.268"))]))
      .toContain("claude-code@2.1.268.json has no valid ceremony signature");
  });

  it("the fixtures mean what they say", () => {
    expect(reading("2.1.268").verdict).toBe("qualified");
    expect(reading("2.1.268", "missed").verdict).toBe("not-qualified");
    // Four arms, one of each, because that is what the instrument requires of a reading. A fixture
    // that did not have them would make every row below a test of the wrong thing.
    expect(reading("2.1.268").runs.map((run) => `${run.shape} ${run.injected ? "injection" : "control"}`)).toEqual([
      "interactive injection",
      "interactive control",
      "headless injection",
      "headless control",
    ]);
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

  it("a member resting on a reading whose own runs do not qualify it is a failure", () => {
    // The reading exists and names the member exactly, so every other rule is satisfied: only the
    // measurement says this build was measured and failed. The report names the arm, because the
    // verdict is recomputed from the runs and the runs are where the answer is.
    const members = [build("2.1.268"), build("2.1.282")];
    const readings = [filed(reading("2.1.268")), filed(reading("2.1.282", "missed"))];

    expect(qualificationDisagreements(members, readings)).toEqual([
      resting("2.1.282", "arm 1 (interactive injection) did not meet the criterion for its own arm"),
      resting("2.1.282", "arm 1 (interactive injection) does not record a second boundary after a production-token turn and before the witness frame"),
    ]);
  });

  it("the stored verdict is an output that is checked, never the reason a reading is admitted", () => {
    // The defect this row exists for: the reader used to ask the file what its verdict was, so a
    // file whose runs said one thing and whose verdict said another was admitted on the verdict.
    // Both directions are reported, because a file that concluded the opposite of its own
    // observations is wrong whichever way it leans.
    const members = [build("2.1.268")];
    const failing = arms("missed");

    expect(qualificationDisagreements(members, [filed({ ...reading("2.1.268"), runs: failing })])).toEqual([
      resting("2.1.268", "arm 1 (interactive injection) did not meet the criterion for its own arm"),
      resting("2.1.268", "arm 1 (interactive injection) does not record a second boundary after a production-token turn and before the witness frame"),
      'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
    ]);

    expect(
      qualificationDisagreements(members, [filed({ ...reading("2.1.268"), verdict: "not-qualified" })]),
    ).toEqual([
      'claude-code@2.1.268.json states the verdict "not-qualified", and its own runs recompute to qualified',
    ]);
  });

  it("a qualification is four arms: injection against control, in both shapes", () => {
    // Reproduced on copies of all three committed readings before this rule existed: delete both
    // headless arms and every offline check still passed, because the file's verdict still said
    // qualified and nothing recomputed it. The ceremony's claim is a comparison; two of one shape
    // is not that comparison.
    const members = [build("2.1.268")];
    const [interactiveInjection, interactiveControl, headlessInjection, headlessControl] = arms();

    expect(qualificationDisagreements(members, [withArms([interactiveInjection!, interactiveControl!])])).toEqual([
      resting("2.1.268", "the reading holds 2 arms, and a qualification is made of exactly 4"),
      resting("2.1.268", "the reading holds 0 headless injection arms, not the one a qualification is made of"),
      resting("2.1.268", "the reading holds 0 headless control arms, not the one a qualification is made of"),
      'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
    ]);

    // Four arms, but the same one twice: a count alone would have admitted this.
    expect(
      qualificationDisagreements(members, [
        withArms([interactiveInjection!, interactiveControl!, headlessInjection!, headlessInjection!]),
      ]),
    ).toEqual([
      resting("2.1.268", "the reading holds 2 headless injection arms, not the one a qualification is made of"),
      resting("2.1.268", "the reading holds 0 headless control arms, not the one a qualification is made of"),
      // Caught twice, and the second catch is about the arms rather than the count of them: one arm
      // filed twice records one witness twice, and an arm's witness is minted for that arm alone.
      resting(
        "2.1.268",
        `2 arms record the witness ${witnessOf("2.1.268", 3)}, and an arm's witness is minted for that arm alone`,
      ),
      'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
    ]);

    // The control: the four the instrument produces are accepted.
    expect(
      qualificationDisagreements(members, [
        withArms([interactiveInjection!, interactiveControl!, headlessInjection!, headlessControl!]),
      ]),
    ).toEqual([]);
  });

  it("an arm is the shape it claims, judged by the predicate production judges by", () => {
    // `--output-format=json` on a purported interactive arm passed every check before this rule,
    // although `isInteractiveClaudeInvocation` refuses that argv -- so the reading qualified a
    // process that could never have held the canonical claim. The headless direction matters too:
    // an arm recorded as the headless control while carrying an argv the predicate accepts is not
    // the control the comparison needs.
    const members = [build("2.1.268")];
    const [interactiveInjection, interactiveControl, headlessInjection, headlessControl] = arms();

    expect(
      qualificationDisagreements(members, [
        withArms([
          { ...interactiveInjection!, command: [...COMMAND.interactive, "--output-format=json"] },
          interactiveControl!,
          headlessInjection!,
          headlessControl!,
        ]),
      ]),
    ).toEqual([
      resting(
        "2.1.268",
        "arm 1 (interactive injection) was started with an argv the canonical-claim predicate refuses, " +
          "so it did not measure a session that could hold the claim",
      ),
      'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
    ]);

    expect(
      qualificationDisagreements(members, [
        withArms([
          interactiveInjection!,
          interactiveControl!,
          headlessInjection!,
          { ...headlessControl!, command: COMMAND.interactive },
        ]),
      ]),
    ).toEqual([
      resting(
        "2.1.268",
        "arm 4 (headless control) was started with an argv the canonical-claim predicate accepts, " +
          "so it is not the headless arm it is recorded as",
      ),
      'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
    ]);
  });

  it("an arm's counts have to agree with each other and with a turn having happened", () => {
    const members = [build("2.1.268")];
    const [interactiveInjection, interactiveControl, headlessInjection, headlessControl] = arms();
    const others = [interactiveControl!, headlessInjection!, headlessControl!];

    // Zeroed baselines with the totals made consistent passed every check before this rule: the
    // wake's follow-up was then a comparison against a turn nobody observed.
    expect(
      qualificationDisagreements(members, [
        withArms([{ ...interactiveInjection!, baselineModelRequests: 0, modelRequests: 1 }, ...others]),
      ]),
    ).toEqual([
      resting(
        "2.1.268",
        "arm 1 (interactive injection) recorded no baseline turn, so its follow-up was measured against a turn that never happened",
      ),
      // Caught twice, and the second is the stronger catch: the counts were edited and the
      // observations they are derived from were not, so the file disagrees with its own evidence
      // rather than merely with itself.
      resting("2.1.268", "arm 1 (interactive injection) states baselineModelRequests as 0, and its own observations give 1"),
      resting("2.1.268", "arm 1 (interactive injection) states modelRequests as 1, and its own observations give 3"),
      'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
    ]);

    // A summary that disagrees with the numbers beneath it: `armPassed` reads the summary, so
    // without this the summary is the whole measurement.
    expect(
      qualificationDisagreements(members, [
        withArms([{ ...interactiveInjection!, modelRequests: 1, wakeCarryingModelRequests: 1 }, ...others]),
      ]),
    ).toEqual([
      resting(
        "2.1.268",
        "arm 1 (interactive injection) says a follow-up arrived, which its own counts (1 before, 1 in all) do not say",
      ),
      resting("2.1.268", "arm 1 (interactive injection) states modelRequests as 1, and its own observations give 3"),
      'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
    ]);

    // A count that is absent is not a count that passed. A comparison against a missing field is
    // false, so every rule beneath it would have been satisfied by its absence.
    const { baselineModelRequests: _dropped, ...countless } = interactiveInjection!;
    expect(qualificationDisagreements(members, [withArms([countless as ProbeRun, ...others])])).toEqual([
      resting("2.1.268", "arm 1 (interactive injection) does not record baselineModelRequests as a count"),
      resting("2.1.268", "arm 1 (interactive injection) states baselineModelRequests as undefined, and its own observations give 1"),
      'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
    ]);
  });

  it("an arm's counts have to come from the observations committed with it", () => {
    // The gap this rule closes: every count above is checked against the other counts in the same
    // file, and the captures they were read from are under `evidence/local/`, which is gitignored.
    // So a reading could state any four consistent numbers and nothing a reader of the repository
    // could see would contradict them.
    const members = [build("2.1.268")];
    const [interactiveInjection, interactiveControl, headlessInjection, headlessControl] = arms();
    const others = [interactiveControl!, headlessInjection!, headlessControl!];

    // Absence is refused, not skipped -- the case that slipped through every previous version of
    // this rule. A reading written before the observations existed is re-taken, not admitted.
    const { observations: _dropped, ...unobserved } = interactiveInjection!;
    expect(qualificationDisagreements(members, [withArms([unobserved as ProbeRun, ...others])])).toEqual([
      resting("2.1.268", "arm 1 (interactive injection) carries no observations, so its counts are claims this file makes about itself"),
      'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
    ]);

    // The observations have to name the capture they came from. It is a weak binding -- the file is
    // not committed, so a reader without it checks nothing -- and a missing one is still a reading
    // whose observations came from nowhere in particular.
    expect(
      qualificationDisagreements(members, [
        withArms([
          { ...interactiveInjection!, observations: { ...interactiveInjection!.observations!, rawCaptureSha256: "not-a-digest" } },
          ...others,
        ]),
      ]),
    ).toEqual([
      resting("2.1.268", "arm 1 (interactive injection) does not bind its observations to the digest of a raw capture"),
      'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
    ]);

    // And the numbers have to be the numbers those observations give. Here the injection arm keeps
    // its counts and carries the control's observations: a wake it says arrived, in a record that
    // never saw one. The control's record says no frame was written, which an injection arm's
    // observations cannot say, so the borrowing is named before the counts are even compared -- and
    // named twice over, because a borrowed record brings the other arm's witness with it, which is
    // what makes "one capture, filed as two arms" visible whatever the counts say.
    expect(
      qualificationDisagreements(members, [
        withArms([{ ...interactiveInjection!, observations: interactiveControl!.observations }, ...others]),
      ]),
    ).toEqual([
      resting(
        "2.1.268",
        "arm 1 (interactive injection) is recorded as an injection arm, and its observations say a frame was not written",
      ),
      resting("2.1.268", "arm 1 (interactive injection) does not record a second boundary after a production-token turn and before the witness frame"),
      resting(
        "2.1.268",
        `arm 1 (interactive injection) wrote a frame carrying the witness ${witnessOf("2.1.268", 2)} and shows no turn whose model input carries it`,
      ),
      resting("2.1.268", "arm 1 (interactive injection) states modelRequests as 3, and its own observations give 1"),
      resting("2.1.268", "arm 1 (interactive injection) states wakeCarryingModelRequests as 1, and its own observations give 0"),
      resting("2.1.268", "arm 1 (interactive injection) states followUpAfterInjection as true, and its own observations give false"),
      resting(
        "2.1.268",
        `2 arms record the witness ${witnessOf("2.1.268", 2)}, and an arm's witness is minted for that arm alone`,
      ),
      'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
    ]);
  });

  it("an arm that does not say where its frame went, or says it went somewhere its own arm did not, is refused", () => {
    // The boundary is the one fact about a capture that cannot be read back out of it, and the
    // version of this rule that reconstructed it -- baseline = the position of the prompt's turn --
    // admitted a session whose wake-carrying turn *preceded* the frame it then ignored. So a record
    // that does not carry the boundary is refused rather than read positionally.
    const members = [build("2.1.268")];
    const [interactiveInjection, interactiveControl, headlessInjection, headlessControl] = arms();
    const others = [interactiveControl!, headlessInjection!, headlessControl!];
    const observations = interactiveInjection!.observations!;
    const withBoundary = (boundary: ArmObservations["boundary"]): ProbeRun => {
      const moved = { ...observations, boundary };
      // Restated from the moved record, so the row measures the boundary rather than a
      // disagreement between the counts and the observations -- which the rule above already names.
      return { ...interactiveInjection!, observations: moved, ...countsFrom(moved) };
    };
    const unsaid = { ...observations };
    delete (unsaid as { boundary?: unknown }).boundary;

    expect(
      qualificationDisagreements(members, [
        withArms([{ ...interactiveInjection!, observations: unsaid, ...countsFrom(unsaid) }, ...others]),
      ]),
    ).toEqual([
      resting(
        "2.1.268",
        "arm 1 (interactive injection) did not meet the criterion for its own arm",
      ),
      resting(
        "2.1.268",
        "arm 1 (interactive injection) does not record where in the requests it observed the frame was written, so which of them preceded it is a guess",
      ),
      'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
    ]);

    // A boundary outside the requests observed splits nothing. The instrument refuses to write one
    // (`observationsFrom`); this is the same refusal applied to a file it did not write.
    expect(
      qualificationDisagreements(members, [withArms([withBoundary({ frameWritten: true, requestsBefore: 9 }), ...others])]),
    ).toEqual([
      resting(
        "2.1.268",
        "arm 1 (interactive injection) did not meet the criterion for its own arm",
      ),
      resting(
        "2.1.268",
        "arm 1 (interactive injection) does not record where in the requests it observed the frame was written, so which of them preceded it is a guess",
      ),
      'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
    ]);

    // The reviewer's session, as a committed record: every request this arm observed, with the frame
    // written after all of them. Every count agrees with the observations -- and the arm still fails,
    // because the wake-carrying turn is on the wrong side of the boundary and no follow-up exists.
    const ignoredTheFrame = withBoundary({ frameWritten: true, requestsBefore: observations.requests.length });
    expect(ignoredTheFrame.followUpAfterInjection).toBe(false);
    expect(ignoredTheFrame.wakeCarryingModelRequests).toBe(1);
    expect(qualificationDisagreements(members, [withArms([ignoredTheFrame, ...others])])).toEqual([
      resting("2.1.268", "arm 1 (interactive injection) did not meet the criterion for its own arm"),
      resting("2.1.268", "arm 1 (interactive injection) does not record a second boundary after a production-token turn and before the witness frame"),
      'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
    ]);

    // The mirror, out of the same bytes: the frame written between the two turns is the session
    // that answered it, and nothing is reported at all. So this is not a rule that refuses
    // everything -- it refuses the side of the boundary the turn is on.
    expect(
      qualificationDisagreements(members, [
        withArms([withBoundary({ frameWritten: true, requestsBefore: 1, requestsBeforeWitness: 2 }), ...others]),
      ]),
    ).toEqual([]);

    // And the turns before the boundary have to include the one this arm's prompt started. The
    // baseline is a position now, so without this an arm could count turns that are not the
    // prompt's and report a baseline it never observed.
    const wakeFirst = {
      ...observations,
      boundary: { frameWritten: true, requestsBefore: 1, requestsBeforeWitness: 2 },
      // The wake's turn and the prompt's, swapped; the witness turn stays where it was, so what this
      // row varies is which turn precedes the boundary and nothing else.
      requests: [observations.requests[1]!, observations.requests[0]!, ...observations.requests.slice(2)],
    };
    expect(
      qualificationDisagreements(members, [
        withArms([{ ...interactiveInjection!, observations: wakeFirst, ...countsFrom(wakeFirst) }, ...others]),
      ]),
    ).toEqual([
      resting(
        "2.1.268",
        "arm 1 (interactive injection) shows no turn carrying the prompt it was started with before that point, so its baseline counts turns that are not the prompt's",
      ),
      resting("2.1.268", "arm 1 (interactive injection) shows no production-token turn before the witness frame"),
      'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
    ]);
  });

  it("refuses wake and witness turns that both arrived after the witness-frame boundary", () => {
    const [injection, ...others] = arms();
    const observations = injection!.observations!;
    const delayed = { ...injection!, observations: {
      ...observations,
      boundary: { frameWritten: true, requestsBefore: 1, requestsBeforeWitness: 1 },
    } };
    expect(qualificationDisagreements([build("2.1.268")], [withArms([delayed, ...others])]))
      .toContain(resting("2.1.268", "arm 1 (interactive injection) does not record a second boundary after a production-token turn and before the witness frame"));
  });

  it("an arm's acceptance rests on the witness its own run minted, and the control shows no echo of it", () => {
    // Every other rule here is satisfied by text somebody could type: the frame's bytes, the token,
    // the prose around it, the prompt, the boundary and the four counts are all fixed or derived from
    // each other, so a reading can carry them all without a ceremony ever having run. The witness is
    // the one value in an arm that a run had to have produced to put it there -- and what it does not
    // establish is written where the rule is.
    const members = [build("2.1.268")];
    const [interactiveInjection, interactiveControl, headlessInjection, headlessControl] = arms();
    const others = [interactiveControl!, headlessInjection!, headlessControl!];
    const witness = witnessOf("2.1.268", 1);

    // The control, in both halves: the arm the instrument produced records the value and shows a turn
    // whose model input carried it, and the reading is admitted.
    expect(interactiveInjection!.observations?.witness).toBe(witness);
    expect(witnessCarryingTurns(interactiveInjection!.observations!)).toHaveLength(1);
    expect(qualificationDisagreements(members, [withArms([interactiveInjection!, ...others])])).toEqual([]);

    // An arm that claims the frame reached the model input, with the turn that carried its witness
    // taken out. Every count is restated from what is left, so the record still agrees with itself,
    // the wake-carrying turn is still there and the boundary still splits it the same way: this is a
    // reading whose remaining observations any run, or none, could have produced.
    const withoutTheEcho = (run: ProbeRun): ProbeRun => {
      const observations = run.observations!;
      const requests = observations.requests.filter(
        (request) => !request.texts.some((entry) => "text" in entry && entry.text.includes(observations.witness!)),
      );
      const stripped: ArmObservations = { ...observations, requests };
      return { ...run, observations: stripped, ...countsFrom(stripped) };
    };
    expect(qualificationDisagreements(members, [withArms([withoutTheEcho(interactiveInjection!), ...others])])).toEqual([
      resting("2.1.268", "arm 1 (interactive injection) shows no witness turn after the witness frame"),
      resting(
        "2.1.268",
        `arm 1 (interactive injection) wrote a frame carrying the witness ${witness} and shows no turn whose model input carries it`,
      ),
      'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
    ]);

    // The same arm with another run's value against this run's capture -- the shape a reading built
    // out of an earlier ceremony's observations takes. The texts are all there; none of them is this.
    const elsewhere = witnessOf("2.1.283", 1);
    expect(
      qualificationDisagreements(members, [
        withArms([
          { ...interactiveInjection!, observations: { ...interactiveInjection!.observations!, witness: elsewhere } },
          ...others,
        ]),
      ]),
    ).toEqual([
      resting("2.1.268", "arm 1 (interactive injection) shows no witness turn after the witness frame"),
      resting(
        "2.1.268",
        `arm 1 (interactive injection) wrote a frame carrying the witness ${elsewhere} and shows no turn whose model input carries it`,
      ),
      resting("2.1.268", "arm 1 (interactive injection) carries 1 model-input text(s) verbatim that none of its counts are read from"),
      'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
    ]);

    // Absence is refused rather than read as a zero -- an arm with no witness records exactly what an
    // arm nobody ran leaves behind -- and so is a value the mint could not have produced. The empty
    // string is the one that matters: every text contains it, so a record carrying one would report a
    // delivery in all four arms and turn both controls' zeroes into positives.
    const unwitnessed = { ...interactiveInjection!.observations! };
    delete (unwitnessed as { witness?: unknown }).witness;
    for (const observations of [
      unwitnessed,
      ...["", "ping", witness.slice(0, -1), witness.toUpperCase()].map((value) => ({
        ...interactiveInjection!.observations!,
        witness: value,
      })),
    ]) {
      expect(
        qualificationDisagreements(members, [withArms([{ ...interactiveInjection!, observations }, ...others])]),
        JSON.stringify(observations.witness),
      ).toEqual([
        resting("2.1.268", "arm 1 (interactive injection) shows no witness turn after the witness frame"),
        resting(
          "2.1.268",
          "arm 1 (interactive injection) records no witness minted by a run, so nothing in it had to be written after a ceremony started",
        ),
        resting("2.1.268", "arm 1 (interactive injection) carries 1 model-input text(s) verbatim that none of its counts are read from"),
        'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
      ]);
    }

    // And the control arm's criterion, in the same terms as its zero token count: it wrote no frame,
    // so no turn of its own may carry the value it minted. The echo sits before its boundary, so
    // every other count it states still passes -- what fails is this.
    const controlWitness = witnessOf("2.1.268", 2);
    const echoed: ArmObservations = {
      ...observationsFrom(captureOf(false, controlWitness), { frameWritten: false, requestsBefore: 2 }, BASELINE_PROMPT, controlWitness),
      witness: controlWitness,
    };
    const echoingControl: ProbeRun = { ...interactiveControl!, observations: echoed, ...countsFrom(echoed) };
    expect(
      qualificationDisagreements(members, [
        withArms([interactiveInjection!, echoingControl, headlessInjection!, headlessControl!]),
      ]),
    ).toEqual([
      resting(
        "2.1.268",
        `arm 2 (interactive control) wrote no frame, and 1 of the turns it observed carry the witness ${controlWitness} it minted`,
      ),
      'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
    ]);
  });

  it("a reading recording a witness another reading records is refused", () => {
    // Every rule inside a reading is satisfied by a copy of a reading that satisfies them, so without
    // this a second build could be admitted on the first build's measurement filed under its name --
    // and the copy would be the whole of what qualified it. A value is minted per arm per run, so two
    // files carrying one are two files describing one run.
    const members = [build("2.1.268"), build("2.1.282")];
    const borrowed = reading("2.1.268").runs[0]!.observations!;
    const reused = {
      ...reading("2.1.282"),
      runs: reading("2.1.282").runs.map((run, index) => (index === 0 ? { ...run, observations: borrowed } : run)),
    };

    // Nothing else in the copy is wrong: the arm's counts agree with the record it borrowed, its
    // boundary is that record's, its witness is echoed in that record's own texts, and the file is
    // named for the build it claims. Only the value says the two files rest on one run.
    expect(qualificationDisagreements(members, [filed(reading("2.1.268")), filed(reused)])).toEqual([
      `claude-code@2.1.282.json records the witness ${witnessOf("2.1.268", 1)}, which claude-code@2.1.268.json records too`,
    ]);

    // The control: the two readings as the instrument produced them, each arm on a value of its own.
    expect(qualificationDisagreements(members, [filed(reading("2.1.268")), filed(reading("2.1.282"))])).toEqual([]);
  });

  it("an arm carrying a text it neither records nor accounts for is refused", () => {
    // A committed observation shows verbatim only what the counts are read from: the arm's prompt
    // and any text carrying the wake token. Everything else -- most of it the client's own system
    // prompt, which a public repository has no business republishing -- travels as a length and a
    // digest. That leaves one way to drop content without a reader seeing it: an entry with neither
    // the text nor the account. This refuses that, so what a reader recomputes the counts over is
    // the whole of the model input and not the part that survived.
    const members = [build("2.1.268")];
    const [interactiveInjection, interactiveControl, headlessInjection, headlessControl] = arms();
    const others = [interactiveControl!, headlessInjection!, headlessControl!];
    const requests = interactiveInjection!.observations!.requests;
    const withTexts = (texts: readonly ObservedText[]): ProbeRun => ({
      ...interactiveInjection!,
      observations: {
        ...interactiveInjection!.observations!,
        requests: [{ ...requests[0]!, texts }, ...requests.slice(1)],
      },
    });

    // A digest that is not a digest accounts for nothing, and neither does a negative length. Both
    // are shapes a hand-written or edited record takes; the reading is refused rather than read.
    expect(
      qualificationDisagreements(members, [
        withArms([
          withTexts([
            ...requests[0]!.texts,
            { from: "system", withheld: "not this arm's evidence", length: 4096, sha256: "not-a-digest" },
          ]),
          ...others,
        ]),
      ]),
    ).toEqual([
      resting("2.1.268", "arm 1 (interactive injection) carries 1 model-input text(s) it neither records nor accounts for by a length and digest"),
      'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
    ]);
    expect(
      qualificationDisagreements(members, [
        withArms([
          withTexts([
            ...requests[0]!.texts,
            { from: "system", withheld: "not this arm's evidence", length: -1, sha256: "f".repeat(64) },
          ]),
          ...others,
        ]),
      ]),
    ).toEqual([
      resting("2.1.268", "arm 1 (interactive injection) carries 1 model-input text(s) it neither records nor accounts for by a length and digest"),
      'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
    ]);

    // The control: the arm as the instrument wrote it, whose texts are all kept or accounted for,
    // is admitted -- so this is not a rule that refuses every record.
    expect(qualificationDisagreements(members, [withArms([interactiveInjection!, ...others])])).toEqual([]);
  });

  it("an arm publishing a text none of its counts are read from is refused", () => {
    // The half of the withholding rule that is a property of the file rather than of the instrument
    // that wrote it. A reading goes into a public repository, and most of a request's model input is
    // the client's own system prompt -- vendor product text, and provider and model detail that has
    // no place in a public artefact. The instrument withholds it; this refuses a reading that does
    // not, so a record taken by some other instrument, or edited afterwards, cannot publish it on
    // the strength of every count agreeing.
    const members = [build("2.1.268")];
    const [interactiveInjection, interactiveControl, headlessInjection, headlessControl] = arms();
    const others = [interactiveControl!, headlessInjection!, headlessControl!];
    const requests = interactiveInjection!.observations!.requests;
    const published: ProbeRun = {
      ...interactiveInjection!,
      observations: {
        ...interactiveInjection!.observations!,
        requests: [
          {
            ...requests[0]!,
            texts: [...requests[0]!.texts, { from: "system", text: "You are Claude Code, a CLI. <pages of it>" }],
          },
          ...requests.slice(1),
        ],
      },
    };
    expect(qualificationDisagreements(members, [withArms([published, ...others])])).toEqual([
      resting("2.1.268", "arm 1 (interactive injection) carries 1 model-input text(s) verbatim that none of its counts are read from"),
      'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
    ]);

    // The control: the texts a rule *is* read from stay verbatim, and an arm carrying only those is
    // admitted -- the prompt, and the prose the runtime composes around the token and around the
    // witness.
    expect(requests.flatMap((request) => request.texts.filter((entry) => "text" in entry).map((entry) => entry.from))).toEqual([
      "user",
      "user",
      "user",
    ]);
    expect(qualificationDisagreements(members, [withArms([interactiveInjection!, ...others])])).toEqual([]);

    // And the text is judged against the request it arrived in. A reading that puts the client's
    // system prompt in a `count_tokens` request, or in a GET, carries a text no count of this arm
    // is derived from however the token reads -- the case both reviewers reproduced, where the
    // published text was kept because it contained the token and nothing asked which request it
    // came from. The counts are untouched by it, so nothing else here can notice.
    const elsewhere = (method: string, url: string): ProbeRun => ({
      ...interactiveInjection!,
      observations: {
        ...interactiveInjection!.observations!,
        requests: [
          ...requests,
          {
            at: "2026-09-28T00:00:00.000Z",
            method,
            url,
            texts: [{ from: "system", text: `You are Claude Code. Never repeat ${ROLE_WAKE_TOKEN}. <pages of it>` }],
          },
        ],
      },
    });
    for (const [method, url] of [
      ["POST", "/v1/messages/count_tokens"],
      ["GET", "/v1/messages?beta=true"],
    ] as const) {
      expect(qualificationDisagreements(members, [withArms([elsewhere(method, url), ...others])])).toEqual([
        resting("2.1.268", "arm 1 (interactive injection) carries 1 model-input text(s) verbatim that none of its counts are read from"),
        'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
      ]);
    }
  });

  it("refuses a reading that kept a different witness-shaped value from a private system block", () => {
    const first = arms()[0]!;
    const other = witnessOf("2.1.283", 9);
    const requests = first.observations!.requests.map((request, index) => index === 1 ? {
      ...request,
      texts: [{ from: "system", text: `private system block ${other}` }, ...request.texts],
    } : request);
    const patched = { ...first, observations: { ...first.observations!, requests } };
    const problems = qualificationDisagreements([build("2.1.268")], [withArms([patched, ...arms().slice(1)])]);
    expect(problems).toContain(resting("2.1.268", "arm 1 (interactive injection) carries 1 model-input text(s) verbatim that none of its counts are read from"));
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
    const members = [build("2.1.268")];
    const [interactiveInjection, interactiveControl, headlessInjection, headlessControl] = arms();

    // The control first: the reading the instrument produced, whose arms all ran the image it names.
    expect(qualificationDisagreements(members, [withArms(reading("2.1.268").runs)])).toEqual([]);

    const elsewhere = "b".repeat(64);
    expect(
      qualificationDisagreements(members, [
        withArms([
          interactiveInjection!,
          { ...interactiveControl!, imageSha256: elsewhere },
          headlessInjection!,
          headlessControl!,
        ]),
      ]),
    ).toEqual([
      `claude-code@2.1.268.json: arm 2 (interactive, control) executed ${elsewhere}, not the ${named} this reading names`,
    ]);

    // The state the committed readings were actually in until 2026-09-28: no per-arm digest at all,
    // and every other rule satisfied. This is the one that used to pass.
    const { imageSha256: _dropped, ...silent } = interactiveInjection!;
    expect(
      qualificationDisagreements(members, [withArms([silent, interactiveControl!, headlessInjection!, headlessControl!])]),
    ).toEqual([
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
