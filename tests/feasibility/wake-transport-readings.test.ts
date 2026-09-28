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
  BASELINE_PROMPT,
  buildReceipt,
  countsFrom,
  observationsFrom,
  qualificationDisagreements,
  readReadings,
  readingFileName,
  recordReading,
  type ObservedText,
  type ProbeRun,
  type ProbeShape,
  type QualificationReceipt,
  type RecordedReading,
} from "./wake-transport-qualification/harness.ts";
import { ROLE_WAKE_TOKEN } from "../../src/mcp/role-conversation.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterEach(cleanupTempDirs);

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
 * A capture of the shape the fake provider writes: the prompt's turn, and the wake's turn after it
 * when the wake landed.
 *
 * Built and then read by the instrument's own `observationsFrom`, rather than an observation list
 * typed in here: a fixture whose observations were written by hand could disagree with what the
 * reader derives from a real one and nobody would find out from this file. The wake text is the
 * live shape -- the token inside the prose the runtime composes around it.
 */
const captureOf = (woke: boolean): string => {
  const turn = (text: string): string =>
    `${JSON.stringify({
      at: "2026-09-28T00:00:00.000Z",
      method: "POST",
      url: "/v1/messages?beta=true",
      headers: {},
      body: JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text }] }] }),
    })}\n`;
  return `${turn(BASELINE_PROMPT)}${woke ? turn(`Another Claude session sent a message:\n${ROLE_WAKE_TOKEN}`) : ""}`;
};

const arm = (shape: ProbeShape, injected: boolean, metCriterion = true): ProbeRun => {
  const woke = injected === metCriterion;
  const observations = observationsFrom(captureOf(woke));
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
const arms = (measurement: "met" | "missed" = "met"): ProbeRun[] => [
  arm("interactive", true, measurement === "met"),
  arm("interactive", false),
  arm("headless", true),
  arm("headless", false),
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
    runs: arms(measurement),
    limits: [],
    findings: [],
  });

const filed = (value: QualificationReceipt, file = readingFileName(value.client)): RecordedReading => ({
  file,
  reading: value,
});

/** A reading the instrument produced, with its runs replaced -- the shape a hand-edited file has. */
const withArms = (runs: readonly ProbeRun[], version = "2.1.268"): RecordedReading =>
  filed({ ...reading(version), runs });

const build = (version: string) => ({ name: "claude-code", version });

const resting = (version: string, shortfall: string): string =>
  `claude-code/${version} is a qualified member resting on claude-code@${version}.json, whose own runs do not qualify it: ${shortfall}`;

describe("the qualified set and its readings must agree", () => {
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
      resting("2.1.268", "arm 1 (interactive injection) states modelRequests as 1, and its own observations give 2"),
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
      resting("2.1.268", "arm 1 (interactive injection) states modelRequests as 1, and its own observations give 2"),
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
    // never saw one.
    expect(
      qualificationDisagreements(members, [
        withArms([{ ...interactiveInjection!, observations: interactiveControl!.observations }, ...others]),
      ]),
    ).toEqual([
      resting("2.1.268", "arm 1 (interactive injection) states modelRequests as 2, and its own observations give 1"),
      resting("2.1.268", "arm 1 (interactive injection) states wakeCarryingModelRequests as 1, and its own observations give 0"),
      resting("2.1.268", "arm 1 (interactive injection) states followUpAfterInjection as true, and its own observations give false"),
      'claude-code@2.1.268.json states the verdict "qualified", and its own runs recompute to not-qualified',
    ]);
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

    // The control: the texts the counts *are* read from stay verbatim, and an arm carrying only
    // those is admitted -- the prompt, and the prose the runtime composes around the token.
    expect(requests.flatMap((request) => request.texts.filter((entry) => "text" in entry).map((entry) => entry.from))).toEqual([
      "user",
      "user",
    ]);
    expect(qualificationDisagreements(members, [withArms([interactiveInjection!, ...others])])).toEqual([]);
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
