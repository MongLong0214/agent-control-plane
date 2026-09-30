/**
 * U6: every client build `WAKE_TRANSPORT_QUALIFIED_CLIENTS` names is a build somebody measured.
 *
 * The set's own comment states the contract -- "a newer client is *unqualified*, not *newer than
 * qualified*, until somebody measures it and adds it here" -- and that contract has two halves.
 * The refusal in `registerEndpoint` enforces the first. Nothing enforced the second until the C0
 * harness's successor kept its reading: C0 deleted its temp root on exit, so the constant recorded
 * a conclusion whose reading no longer existed anywhere. `evidence/u6-wake-transport-qualification/`
 * holds one reading per build, and the first row below is what makes a member unable to exist
 * without one.
 *
 * The rows split on purpose:
 *
 *   - The reading rows run everywhere, including where no client is installed. They are about
 *     agreement between artefacts in the repository and need nothing from the host.
 *   - The measurement rows re-take the reading, and skip -- naming why -- where it cannot be
 *     taken. A pass that required only the readings would let a hand-written file qualify a build,
 *     which is the one hole a response check cannot close; re-measuring is what closes it, and it
 *     can only close it on a machine that has the client.
 *
 * The agreement rules themselves are `qualificationDisagreements`, exercised against fixture sets
 * and fixture readings in `wake-transport-readings.test.ts`. Whenever this row passes, the committed
 * set and its readings agree, so a rule this row never trips here is still shown to trip there.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  BASELINE_PROMPT,
  MEASURED_CLIENT_NAME,
  QUALIFICATION_ID,
  RECEIPT_DIR,
  SUITE_CAPTURE_DIR,
  armPassed,
  baselineTurnBeforeBoundary,
  baselineTurnObserved,
  interactiveBlocker,
  REPO_ROOT,
  countsFrom,
  holdImage,
  modelInputTexts,
  modelRequestsIn,
  observationsFrom,
  pinClaudeImage,
  probeArgv,
  resolvePtyAllocator,
  spawnPlanFor,
  terminalOutput,
  qualificationDisagreements,
  readReadings,
  qualificationShortfalls,
  runQualificationProbe,
  wakeCarryingTurnsIn,
  withholdText,
  witnessCarryingTurns,
  ARM_WITNESS,
  type HeldImage,
  type PinnedClaudeImage,
  type ProbeRun,
} from "./wake-transport-qualification/harness.ts";
import { isInteractiveClaudeInvocation } from "../../src/registry/canonical-self-claim.ts";
import {
  ROLE_WAKE_FRAME,
  ROLE_WAKE_TOKEN,
  WAKE_TRANSPORT_QUALIFIED_CLIENTS,
  isWakeTransportQualified,
} from "../../src/mcp/role-conversation.ts";

/** Long, because each arm starts a real client and waits out a settle ceiling. */
const PROBE_TIMEOUT_MS = 300_000;

const blocker = interactiveBlocker();

describe("U6: the wake transport admits only builds a committed reading qualified", () => {
  it("every qualified build has a reading, every reading is a qualified build, and none rests on a failed one", () => {
    const readings = readReadings();
    expect(readings.length, `no qualification readings under ${RECEIPT_DIR}`).toBeGreaterThan(0);

    // The set and the readings are the two artefacts that have to agree. Adding a member without a
    // reading, or keeping one on a reading that failed, is the failure this row exists to make loud.
    expect(qualificationDisagreements(WAKE_TRANSPORT_QUALIFIED_CLIENTS, readings)).toEqual([]);
  });

  it("each reading is of the production frame, on a digested image, by this instrument", () => {
    for (const { file, reading } of readReadings()) {
      expect(reading.qualification, file).toBe(QUALIFICATION_ID);

      // The reading has to be of the bytes production sends. A reading that qualified some other
      // frame would qualify some other transport.
      expect(reading.frame.utf8, file).toBe(ROLE_WAKE_FRAME);
      expect(reading.frame.token, file).toBe(ROLE_WAKE_TOKEN);

      // An image without a digest is a filename, and a filename is not a build.
      expect(reading.client.imageSha256, file).toMatch(/^[0-9a-f]{64}$/);
      expect(reading.client.versionOutput, file).toContain(reading.client.version);
    }
  });

  it("each reading carries an interactive injection and its control, and both met the criterion", () => {
    const readings = readReadings();
    expect(readings.length).toBeGreaterThan(0);

    for (const { file, reading } of readings) {
      const interactive = reading.runs.filter((run) => run.shape === "interactive");
      const injection = interactive.find((run) => run.injected);
      const control = interactive.find((run) => !run.injected);

      // Interactive specifically. `isInteractiveClaudeInvocation` refuses the headless flags, so a
      // reading carrying only the headless arm would qualify a process that cannot hold the claim.
      expect(injection, `${file} has no interactive injection arm`).toBeDefined();
      expect(control, `${file} has no interactive control arm`).toBeDefined();
      if (!injection || !control) continue;

      // Not "the socket accepted it": the wake has to be in a body the CLI sent to be inferred on,
      // and it has to have caused a request the baseline had not already made.
      expect(injection.wakeCarryingModelRequests, file).toBeGreaterThan(0);
      expect(injection.followUpAfterInjection, file).toBe(true);
      expect(injection.modelRequests, file).toBeGreaterThan(injection.baselineModelRequests);

      // The control is only a control if it could have produced a positive: same harness, one
      // input removed, and a settle *ceiling* no shorter than the injection arm's.
      //
      // Ceiling, not observation. The injection arm returns the moment its follow-up request
      // appears, while the control sleeps the whole span, so equal values here say the two arms
      // had an equal maximum window -- never that they were watched for equally long. What the
      // control buys is that its absence was not measured over the shorter window; the arms'
      // actual observed spans are unequal and the instrument does not record them.
      expect(control.wakeCarryingModelRequests, file).toBe(0);
      expect(control.followUpAfterInjection, file).toBe(false);
      expect(
        control.settleCeilingMs,
        `${file}: the control's settle ceiling is not the injection arm's, so its absence was measured over a different maximum window`,
      ).toBe(injection.settleCeilingMs);

      // The old name for that field was `settleMs`, documented as "the wall clock both arms
      // waited" -- which is false for the injection arm. A reading that still spells it the old
      // way was written by an instrument that still makes the old claim, so this row fails rather
      // than reading a corrected field off an uncorrected file.
      for (const run of reading.runs) {
        expect(run.settleCeilingMs, `${file}: a run row carries no settle ceiling`).toBeGreaterThan(0);
        expect(Object.keys(run), `${file}: a run row still carries the pre-correction \`settleMs\``).not.toContain("settleMs");
      }

      // The interactive argv is what makes it interactive, so the reading has to show it.
      for (const flag of ["-p", "--print", "--output-format", "--input-format"]) {
        expect(injection.command, file).not.toContain(flag);
        expect(control.command, file).not.toContain(flag);
      }

      // Home-redacted, because this file is committed and a path under a home is a username.
      for (const argument of [...injection.command, ...control.command]) {
        expect(argument.startsWith("/Users/"), file).toBe(false);
        expect(argument.startsWith("/home/"), file).toBe(false);
      }
    }
  });
});

/**
 * How the baseline turn is started, and what counts as evidence that it happened.
 *
 * The harness used to type the prompt, which meant it had to know when the client would accept
 * typing, which meant rendering the client's terminal output. Six false-ready or false-refuse
 * defects were reproduced against that renderer in three review rounds; it is gone. The prompt is
 * now a positional argument -- `claude [options] [prompt]` -- and the two things that have to stay
 * true are the two rows below. Neither starts a client: the first is a predicate over an argv, the
 * second a predicate over a capture.
 */
describe("U6: the interactive arm keeps the shape the claim requires, and observes its baseline turn", () => {
  it("the interactive argv is an invocation the canonical-claim predicate accepts, positional prompt and all", () => {
    // The predicate production applies, called on the value the harness starts the client with --
    // not read and reasoned about. `isInteractiveClaudeInvocation` is what decides whether a
    // process may hold the canonical claim, so an arm it would refuse measures a process that
    // could not be the holder, whatever else the arm proves.
    const paths = { settingsPath: "/private/tmp/fixture/settings.json", socketPath: "/private/tmp/fixture/s/i.sock" };
    const interactive = ["/private/tmp/fixture/claude", ...probeArgv("interactive", paths)];
    expect(isInteractiveClaudeInvocation(interactive)).toBe(true);

    // The prompt is carried as an operand, which is exactly why the shape survives: the predicate
    // refuses flags, and this is not one. It is also the last element, so a reading's `command`
    // shows it.
    expect(interactive.at(-1)).toBe(BASELINE_PROMPT);
    expect(interactive.filter((argument) => argument === BASELINE_PROMPT)).toHaveLength(1);
    for (const flag of ["-p", "--print", "--output-format", "--input-format"]) {
      expect(interactive).not.toContain(flag);
    }

    // The control, so this row is not a predicate that says yes to everything: the headless arm
    // carries the four flags the predicate refuses, and it is refused.
    const headless = ["/private/tmp/fixture/claude", ...probeArgv("headless", paths)];
    expect(isInteractiveClaudeInvocation(headless)).toBe(false);
  });

  it("what an arm executes is the invocation its reading records, for both shapes", () => {
    // The row the last review asked for: the previous one stopped at `probeArgv`, a helper, while
    // the spawn a few lines down built its own second expression -- appending a flag there, or
    // starting the resolved launcher path instead of the held link, left every named test green.
    // The two are now one value, and this asks that value what it would start.
    const paths = { settingsPath: "/private/tmp/fixture/settings.json", socketPath: "/private/tmp/fixture/s/i.sock" };
    const image = { executable: "/private/tmp/fixture/held/claude" };
    const pty = { python: "/usr/bin/python3", script: "/private/tmp/fixture/pty-session.py" };

    // The headless arm starts the client itself, so what is spawned *is* the recorded command.
    const headless = spawnPlanFor("headless", image, paths, null);
    expect(headless.command).toEqual([image.executable, ...probeArgv("headless", paths)]);
    expect([headless.executable, ...headless.argv]).toEqual([...headless.command]);

    // The interactive arm starts the pty allocator, and the recorded command is the tail of its
    // argv -- so a reading describes a slice of what was executed rather than a parallel value.
    const interactive = spawnPlanFor("interactive", image, paths, pty);
    expect(interactive.command).toEqual([image.executable, ...probeArgv("interactive", paths)]);
    expect(interactive.executable).toBe(pty.python);
    expect(interactive.argv).toEqual([pty.script, ...interactive.command]);

    // The shape each plan would actually start is the shape it claims, judged by the production
    // predicate, and the executed argv carries nothing the recorded one does not.
    expect(isInteractiveClaudeInvocation([...interactive.command])).toBe(true);
    expect(isInteractiveClaudeInvocation([...interactive.argv])).toBe(true);
    expect(isInteractiveClaudeInvocation([...headless.command])).toBe(false);

    // Every arm executes the held hard link. The launcher path an updater re-points is not a field
    // this decision can reach.
    expect(interactive.command[0]).toBe(image.executable);
    expect(headless.executable).toBe(image.executable);

    // No terminal, no interactive arm: it fails rather than falling back to a shape the predicate
    // refuses, which is the same rule the baseline turn follows.
    expect(() => spawnPlanFor("interactive", image, paths, null)).toThrow(/pty/);
  });

  /**
   * A request body of the shape the measured builds send: one user message whose content is a list
   * of text blocks, the prompt a block of its own beside the reminders the client adds.
   *
   * Taken from the twelve real captures under `evidence/local/`, not invented -- a fixture that
   * differs from what the instrument actually reads would let a test agree with a defect, which is
   * exactly what the earlier one did.
   */
  const promptBody = (text: string): string =>
    JSON.stringify({
      model: "claude-sonnet-4-5",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "<system-reminder>\nToday's date is 2026-09-28.\n</system-reminder>" }, { type: "text", text }],
        },
      ],
    });

  /** One line of the capture the fake provider appends: the request as it arrived. */
  const captured = (url: string, body = promptBody(BASELINE_PROMPT), method = "POST"): string =>
    `${JSON.stringify({ at: "2026-09-28T00:00:00.000Z", method, url, headers: {}, body })}\n`;

  it("the baseline turn is a captured model request, and nothing short of one counts as having seen it", () => {
    // Passing the prompt is not evidence it was accepted. An arm that had seen nothing, or had seen
    // only traffic to some other endpoint, has not observed a turn -- and the harness fails rather
    // than proceeding, because a baseline it assumed is a baseline the wake's follow-up is measured
    // against for nothing.
    expect(baselineTurnObserved("", BASELINE_PROMPT)).toBe(false);
    expect(baselineTurnObserved("\n   \n", BASELINE_PROMPT)).toBe(false);
    expect(baselineTurnObserved(captured("/v1/models"), BASELINE_PROMPT)).toBe(false);
    expect(modelRequestsIn(captured("/v1/models"))).toEqual([]);

    // And what does count: a request the client sent to be inferred on, carrying the prompt the arm
    // was started with -- the same kind of evidence the wake itself is judged by. The path is the
    // one the measured builds use.
    expect(baselineTurnObserved(captured("/v1/messages?beta=true"), BASELINE_PROMPT)).toBe(true);

    const mixed = `${captured("/v1/models")}${captured("/v1/messages?beta=true")}`;
    const kept = modelRequestsIn(mixed);
    expect(kept).toHaveLength(1);
    // The body is carried through, because it is what the wake count is read from.
    expect(kept[0]).toMatchObject({ method: "POST", url: "/v1/messages?beta=true", body: promptBody(BASELINE_PROMPT) });
  });

  it("a request to that endpoint that is not this prompt's turn is not the baseline", () => {
    // The defect this row exists for: every case below reached the endpoint, and every one of them
    // was accepted as the baseline when the only question asked was whether *some* model request
    // existed. An arm that proceeds on one of these has a baseline that is not the prompt's turn,
    // and `followUpAfterInjection` then compares the wake against a number that never counted it.

    // An inference the client made for its own reasons, carrying someone else's user message.
    expect(baselineTurnObserved(captured("/v1/messages?beta=true", promptBody("summarise this session")), BASELINE_PROMPT)).toBe(false);

    // A body with no messages at all -- which the previous fixture in this file asserted was enough.
    expect(baselineTurnObserved(captured("/v1/messages?beta=true", '{"model":"claude-sonnet-4-5"}'), BASELINE_PROMPT)).toBe(false);

    // A request that asked for no inference: this provider answers a GET to the same path with a
    // 404, so it began no turn and is not one to count.
    expect(baselineTurnObserved(captured("/v1/messages?beta=true", "", "GET"), BASELINE_PROMPT)).toBe(false);
    expect(modelRequestsIn(captured("/v1/messages?beta=true", promptBody(BASELINE_PROMPT), "GET"))).toEqual([]);

    // A body this reader does not recognise contributes nothing rather than throwing: it reads a
    // foreign process's output, and an unparseable body is a baseline it has not seen, not a crash.
    expect(baselineTurnObserved(captured("/v1/messages?beta=true", "<html>502</html>"), BASELINE_PROMPT)).toBe(false);

    // The prompt in the assistant's turn rather than the user's is the model's text, not the arm's.
    const echoed = JSON.stringify({ messages: [{ role: "assistant", content: [{ type: "text", text: BASELINE_PROMPT }] }] });
    expect(baselineTurnObserved(captured("/v1/messages?beta=true", echoed), BASELINE_PROMPT)).toBe(false);

    // The controls, so this is a row about which request is the baseline and not one that refuses
    // everything: the real thing counts, a string `content` counts -- the shape of the frame the
    // headless arm writes on stdin -- and one real turn beside all the refused ones is still seen.
    const asString = JSON.stringify({ messages: [{ role: "user", content: BASELINE_PROMPT }] });
    expect(baselineTurnObserved(captured("/v1/messages?beta=true", asString), BASELINE_PROMPT)).toBe(true);
    const noise = captured("/v1/messages?beta=true", promptBody("summarise this session"));
    expect(baselineTurnObserved(`${noise}${captured("/v1/messages?beta=true")}`, BASELINE_PROMPT)).toBe(true);
    // Still two turns for the follow-up to count, though only one of them was the baseline: the
    // wake count and the baseline ask different questions of the same capture.
    expect(modelRequestsIn(`${noise}${captured("/v1/messages?beta=true")}`)).toHaveLength(2);
  });

  it("a count-tokens request is a request about a turn, and is not one", () => {
    // `/v1/messages/count_tokens` is beneath the endpoint, not the endpoint. A substring test says
    // yes to it, and a client can send one before it has asked for any inference -- so it would
    // stand in for the only evidence this harness has that its prompt was accepted, and the arm
    // would go on to measure the wake's follow-up against a baseline that never happened.
    const countTokens = captured("/v1/messages/count_tokens");
    expect(modelRequestsIn(countTokens)).toEqual([]);
    expect(baselineTurnObserved(countTokens, BASELINE_PROMPT)).toBe(false);
    expect(baselineTurnObserved(`${countTokens}${captured("/v1/messages/count_tokens?beta=true")}`, BASELINE_PROMPT)).toBe(false);

    // The control, so this is a row about the endpoint and not a row that refuses everything: the
    // endpoint itself counts, with a query string and without, and a count-tokens request beside a
    // real one does not inflate the count the follow-up is compared against.
    expect(baselineTurnObserved(captured("/v1/messages"), BASELINE_PROMPT)).toBe(true);
    expect(baselineTurnObserved(captured("/v1/messages?beta=true"), BASELINE_PROMPT)).toBe(true);
    expect(modelRequestsIn(`${countTokens}${captured("/v1/messages?beta=true")}`)).toHaveLength(1);
  });

  it("a wake is counted where the model reads, so metadata is not a delivery and an escape is", () => {
    // The live shape first, and it is the control for everything below: the runtime does not hand
    // the token to the model bare, it composes a peer-message preamble around it. So the test is
    // containment within model input -- an equality test would count zero on a working wake.
    const prose = `Another Claude session sent a message:\n${ROLE_WAKE_TOKEN}\nRead your inbox.`;
    expect(wakeCarryingTurnsIn(captured("/v1/messages?beta=true", promptBody(prose)))).toHaveLength(1);

    // The defect, reproduced by both reviewers: the request's messages say only `ping`, and the
    // token is in a field the client fills in for the provider. The model was never asked it. A
    // substring test over the serialized body counted this as a delivery -- and it is the count
    // that decides whether a build joins the set, with the control arm claiming it is zero.
    const inMetadata = JSON.stringify({
      model: "claude-sonnet-4-5",
      metadata: { user_id: `session_${ROLE_WAKE_TOKEN}_1` },
      messages: [{ role: "user", content: [{ type: "text", text: BASELINE_PROMPT }] }],
    });
    expect(inMetadata).toContain(ROLE_WAKE_TOKEN);
    expect(wakeCarryingTurnsIn(captured("/v1/messages?beta=true", inMetadata))).toEqual([]);

    // Same again for a header-shaped field: a request carries plenty the model never reads, and
    // every one of them was a way to satisfy the injection arm without the wake reaching the model.
    const inHeaderField = JSON.stringify({
      model: "claude-sonnet-4-5",
      headers: { "x-session-note": ROLE_WAKE_TOKEN },
      messages: [{ role: "user", content: [{ type: "text", text: BASELINE_PROMPT }] }],
    });
    expect(wakeCarryingTurnsIn(captured("/v1/messages?beta=true", inHeaderField))).toEqual([]);

    // The mirror defect, the second reviewer's: the token *is* in model input, and JSON escaped a
    // character of it on the way out. The text the model reads is the token; the bytes on the wire
    // are not, so a substring test over the body reported a delivery that happened as one that did
    // not. Parsing is what makes the question be about the text.
    const escaped = `{"messages":[{"role":"user","content":[{"type":"text","text":"ACP-ROLE-WAK\\u0045 arrived"}]}]}`;
    expect(escaped).not.toContain(ROLE_WAKE_TOKEN);
    expect(modelInputTexts(escaped)[0]?.text).toContain(ROLE_WAKE_TOKEN);
    expect(wakeCarryingTurnsIn(captured("/v1/messages?beta=true", escaped))).toHaveLength(1);

    // The system blocks are model input too, and the control arm's zero is a claim about them as
    // much as about the messages -- so they are searched, in a request whose messages are innocent.
    const inSystem = JSON.stringify({
      system: [{ type: "text", text: `You are Claude.\n${ROLE_WAKE_TOKEN}` }],
      messages: [{ role: "user", content: BASELINE_PROMPT }],
    });
    expect(wakeCarryingTurnsIn(captured("/v1/messages?beta=true", inSystem))).toHaveLength(1);

    // And it stays a count of *turns*: a count-tokens request or a body nothing can parse is not a
    // delivery however the token reached it, because neither is a turn the model took.
    expect(wakeCarryingTurnsIn(captured("/v1/messages/count_tokens", promptBody(prose)))).toEqual([]);
    expect(wakeCarryingTurnsIn(captured("/v1/messages?beta=true", `<html>${ROLE_WAKE_TOKEN}</html>`))).toEqual([]);
  });
});

/**
 * What a reading commits beside its counts, so that the counts stop being claims about nothing.
 *
 * The captures these are read from live under `evidence/local/`, which is gitignored, so before
 * this a reader of the repository had a file stating how many turns it saw and no way to check it.
 * These rows are about the record that closes that: it is derived by the instrument, it carries
 * what the acceptance rule reads, it refuses to carry an account's home directory, and it withholds
 * every text the rule does not read -- because this repository is public and most of a request's
 * model input is the client's own system prompt, which is not ours to republish.
 *
 * What it cannot establish is that a live client produced any of it -- an observation list written
 * by hand derives exactly as well as a measured one. That is #1012, not this.
 */
describe("U6: an arm's counts are derived from the observations committed with it", () => {
  const capture = (...bodies: readonly (readonly [string, string, string])[]): string =>
    bodies
      .map(([method, url, body]) =>
        `${JSON.stringify({ at: "2026-09-28T00:00:00.000Z", method, url, headers: { "x-api-key": "irrelevant" }, body })}\n`,
      )
      .join("");

  const digest = (text: string): string => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
  const withheld = (from: string, text: string): Record<string, unknown> => ({
    from,
    withheld: "not this arm's evidence",
    length: Buffer.byteLength(text, "utf8"),
    sha256: digest(text),
  });

  const turn = (text: string, role = "user"): string =>
    JSON.stringify({ model: "claude-sonnet-4-5", system: [{ type: "text", text: "You are Claude." }], messages: [{ role, content: [{ type: "text", text }] }] });

  /**
   * The boundary an arm records: where in its own request sequence the frame was written.
   *
   * Required by `observationsFrom` and given here explicitly in every fixture, because it is the
   * one fact about a capture that cannot be read back out of it -- and reconstructing it is the
   * defect these rows are about.
   */
  const frameAfter = (requestsBefore: number) => ({ frameWritten: true, requestsBefore });
  const noFrame = (requestsBefore: number) => ({ frameWritten: false, requestsBefore });

  /** An arm with everything but its counts, so a row can vary the counts and nothing else. */
  const ARM: ProbeRun = {
    shape: "headless",
    injected: true,
    command: ["/fixture/claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json"],
    imageSha256: "0".repeat(64),
    baselineModelRequests: 0,
    modelRequests: 0,
    wakeCarryingModelRequests: 0,
    followUpAfterInjection: false,
    settleCeilingMs: 20_000,
    rawCapturePath: "evidence/local/fixture/capture.jsonl",
    rawSessionLogPath: "evidence/local/fixture/session.log",
    tempRootRemoved: true,
  };

  it("keeps each request's time, method and URL, and digests the capture they came from", () => {
    const raw = capture(
      ["POST", "/v1/messages?beta=true", turn(BASELINE_PROMPT)],
      ["POST", "/v1/messages?beta=true", turn(`Another Claude session sent a message:\n${ROLE_WAKE_TOKEN}`)],
    );
    const observations = observationsFrom(raw, frameAfter(1));

    expect(observations.requests).toHaveLength(2);
    // The boundary travels with them, as the arm recorded it: one request existed when the frame
    // was written, and a frame was written at all.
    expect(observations.boundary).toEqual({ frameWritten: true, requestsBefore: 1 });
    expect(observations.requests[0]).toMatchObject({ at: "2026-09-28T00:00:00.000Z", method: "POST", url: "/v1/messages?beta=true" });
    // The model input, labelled by where it came from -- which is what lets one record answer both
    // questions: the baseline is a *user* text, and the wake is any model input at all. The prompt
    // is kept because the baseline is read from it; the system block is accounted for instead.
    expect(observations.requests[0]?.texts).toEqual([
      withheld("system", "You are Claude."),
      { from: "user", text: BASELINE_PROMPT },
    ]);
    // The headers are not in it. The capture keeps them; this is the part the model was asked, and
    // a committed file has no business carrying a request's credentials-shaped fields.
    expect(JSON.stringify(observations)).not.toContain("x-api-key");
    // Bound to the bytes it was read from, which are the bytes the run writes to its raw capture.
    expect(observations.rawCaptureSha256).toBe(createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex"));

    // And the four counts a reading states come out of it, by the calculation the reader repeats.
    expect(countsFrom(observations)).toEqual({
      baselineModelRequests: 1,
      modelRequests: 2,
      wakeCarryingModelRequests: 1,
      followUpAfterInjection: true,
    });
  });

  it("counts turns the way the rest of this file does, and splits them at the boundary the arm recorded", () => {
    // Everything that is not a turn is kept in the record and counted in none of the numbers: the
    // derivation applies the same POST-and-endpoint rule the live arm applies. The boundary is an
    // index into the *requests*, which is what the arm can count at the moment it writes the frame;
    // the count-tokens request and the GET are in that sequence and are turns in no count.
    const noisy = observationsFrom(
      capture(
        ["POST", "/v1/messages/count_tokens", turn(BASELINE_PROMPT)],
        ["GET", "/v1/messages?beta=true", ""],
        ["POST", "/v1/messages?beta=true", turn(BASELINE_PROMPT)],
        ["POST", "/v1/messages?beta=true", turn("summarise this session")],
      ),
      frameAfter(3),
    );
    expect(noisy.requests).toHaveLength(4);
    expect(countsFrom(noisy)).toEqual({
      // Three requests preceded the frame and one of them was a turn.
      baselineModelRequests: 1,
      modelRequests: 2,
      wakeCarryingModelRequests: 0,
      followUpAfterInjection: true,
    });

    // The prompt's own turn is asked for separately, because the baseline is a position now: the
    // turns before the boundary are counted whatever they carry, and this is what says one of them
    // was the turn this arm's prompt started.
    expect(baselineTurnBeforeBoundary(noisy)).toBe(true);
    const noPrompt = observationsFrom(
      capture(["POST", "/v1/messages?beta=true", turn("summarise this session")]),
      frameAfter(1),
    );
    expect(countsFrom(noPrompt).baselineModelRequests).toBe(1);
    expect(baselineTurnBeforeBoundary(noPrompt)).toBe(false);
    // And a turn carrying the prompt *after* the frame is not this arm's baseline either.
    expect(
      baselineTurnBeforeBoundary(
        observationsFrom(capture(["POST", "/v1/messages?beta=true", turn(BASELINE_PROMPT)]), frameAfter(0)),
      ),
    ).toBe(false);
  });

  it("a turn that preceded the frame is not the follow-up the frame caused", () => {
    // The session a reviewer built the defect out of, as a record: the prompt's turn, then a turn
    // carrying the wake token that the client took of its own accord, and then a frame this session
    // ignores. Reading the baseline off the prompt's position counts that second turn as the
    // follow-up the frame caused -- it comes after the prompt -- and admits an injection arm that
    // measured nothing. Against the boundary the arm recorded, both turns precede the frame.
    const raw = capture(
      ["POST", "/v1/messages?beta=true", turn(BASELINE_PROMPT)],
      ["POST", "/v1/messages?beta=true", turn(`Another Claude session sent a message:\n${ROLE_WAKE_TOKEN}`)],
    );
    const ignored = observationsFrom(raw, frameAfter(2));
    expect(countsFrom(ignored)).toEqual({
      baselineModelRequests: 2,
      modelRequests: 2,
      wakeCarryingModelRequests: 1,
      followUpAfterInjection: false,
    });
    expect(armPassed({ ...ARM, injected: true, ...countsFrom(ignored) })).toBe(false);

    // The mirror, out of the same bytes: the same two requests with the frame written between them
    // is the session that answered, and it passes. Nothing in the capture distinguishes the two --
    // which is the whole point of recording the boundary instead of deriving it.
    const answered = observationsFrom(raw, frameAfter(1));
    expect(countsFrom(answered)).toEqual({
      baselineModelRequests: 1,
      modelRequests: 2,
      wakeCarryingModelRequests: 1,
      followUpAfterInjection: true,
    });
    expect(armPassed({ ...ARM, injected: true, ...countsFrom(answered) })).toBe(true);
  });

  it("refuses a capture carrying a home-directory path rather than committing one", () => {
    // The receipt is committed, so a path under an account's home in it publishes a username to
    // every reader of the repository. `redactHome` replaces a prefix; prose carries one in the
    // middle, and macOS spells the same directory three ways. A shape this cannot redact stops the
    // arm -- the run is refused rather than the redaction being assumed complete.
    const leaked = capture(["POST", "/v1/messages?beta=true", turn("Working directory: /Users/someone-else/projects/acp")]);
    expect(() => observationsFrom(leaked, noFrame(1))).toThrow(/home-directory path/);

    // The control: the same capture without it goes through, so this is not a reader that refuses
    // everything. Measured across the twelve arms of the three committed readings: none carries one.
    expect(() =>
      observationsFrom(capture(["POST", "/v1/messages?beta=true", turn("Working directory: /private/tmp/acp-u6q-x/w")]), noFrame(1)),
    ).not.toThrow();
    // And a boundary that falls outside the requests observed divides them into nothing, so it
    // is refused here rather than clamped into a number that looks like a measurement.
    expect(() => observationsFrom(capture(["POST", "/v1/messages?beta=true", turn(BASELINE_PROMPT)]), frameAfter(2))).toThrow(
      /boundary is at request 2 of a capture holding 1/,
    );
  });

  it("keeps the texts its counts are read from, and withholds every other by kind, length and digest", () => {
    // Why: the readings are committed to a public repository, and a request's model input is mostly
    // the client's own system prompt -- vendor product text, and provider and model detail that has
    // no place in a public artefact. It is also 96% of the bytes. What the counts read is small and
    // is ours: the prompt this harness sent, and the prose the runtime composed around our token.
    const system = "You are Claude Code, a CLI. <the vendor's system prompt continues for pages>";
    const prose = `Another Claude session sent a message:\n${ROLE_WAKE_TOKEN}\nRead your inbox.`;
    const aside = "summarise this session";
    const raw = capture([
      "POST",
      "/v1/messages?beta=true",
      JSON.stringify({
        system: [{ type: "text", text: system }],
        messages: [{ role: "user", content: [{ type: "text", text: prose }, { type: "text", text: aside }] }],
      }),
    ]);
    const observations = observationsFrom(raw, frameAfter(1));

    // The wake-carrying text travels in full -- it is what the injection arm exists to show -- and
    // everything else is a kind, a length and a digest.
    expect(observations.requests[0]?.texts).toEqual([
      withheld("system", system),
      { from: "user", text: prose },
      withheld("user", aside),
    ]);
    // And the withheld texts are not in the file by any other route.
    const written = JSON.stringify(observations);
    expect(written).not.toContain("the vendor's system prompt");
    expect(written).not.toContain(aside);
    // The count is the same count: a text that is neither the prompt nor a carrier of the token was
    // counted nowhere before it was withheld either, so this is a publication decision and not a
    // measurement one.
    expect(countsFrom(observations).wakeCarryingModelRequests).toBe(1);
    expect(wakeCarryingTurnsIn(raw)).toHaveLength(1);

    // Evidence is judged on the text the model reads, so a token that was JSON-escaped on the wire
    // is kept -- the same question `wakeCarryingTurnsIn` asks, asked by the writer.
    const escaped = `{"messages":[{"role":"user","content":[{"type":"text","text":"ACP-ROLE-WAK\\u0045 arrived"}]}]}`;
    expect(observationsFrom(capture(["POST", "/v1/messages?beta=true", escaped]), frameAfter(0)).requests[0]?.texts).toEqual([
      { from: "user", text: `${ROLE_WAKE_TOKEN} arrived` },
    ]);
  });

  it("refuses to withhold a text carrying the token or equal to the prompt, rather than hiding it", () => {
    // The property that makes the control arm's zero mean anything. If a token-carrying text could
    // be recorded as "not evidence", that zero would be a statement about what was published rather
    // than about what was measured -- so the writer classifies, and being asked to withhold the
    // measurement stops the run. Nothing on the production path asks it to; this is the guard
    // against a later change to the classification quietly shrinking what a reading shows.
    const TURN = { method: "POST", url: "/v1/messages?beta=true" };
    expect(() => withholdText(TURN, { from: "system", text: `preamble ${ROLE_WAKE_TOKEN} tail` })).toThrow(
      /cannot be withheld/,
    );
    expect(() => withholdText(TURN, { from: "user", text: `  ${BASELINE_PROMPT}  ` })).toThrow(/cannot be withheld/);

    // The control: an ordinary text is withheld, and its record is what a reader gets -- the length
    // in UTF-8 bytes and the digest over those same bytes, so an operator holding the raw capture
    // can check both without guessing an encoding.
    expect(withholdText(TURN, { from: "system", text: "You are Claude." })).toEqual({
      from: "system",
      withheld: "not this arm's evidence",
      length: 15,
      sha256: digest("You are Claude."),
    });

    // And the same text in a request no count is derived from is not evidence at all, so
    // withholding it is what the rule asks for rather than what it refuses. Without the request in
    // the question, a count-tokens body carrying the token was kept verbatim in every arm.
    expect(withholdText({ method: "POST", url: "/v1/messages/count_tokens" }, { from: "user", text: `q: ${ROLE_WAKE_TOKEN}` })).toEqual({
      from: "user",
      withheld: "not this arm's evidence",
      length: Buffer.byteLength(`q: ${ROLE_WAKE_TOKEN}`, "utf8"),
      sha256: digest(`q: ${ROLE_WAKE_TOKEN}`),
    });
    // The prompt is the baseline only as a *user* text: an assistant turn echoing it back is not
    // evidence that this arm's prompt was accepted, which is what `baselineTurnObserved` says of
    // the live capture.
    expect(withholdText(TURN, { from: "assistant", text: BASELINE_PROMPT }).length).toBe(
      Buffer.byteLength(BASELINE_PROMPT, "utf8"),
    );
  });

  it("does not publish a private system block with another witness-shaped value", () => {
    const own = `u6-witness-${"1".repeat(32)}`;
    const other = `u6-witness-${"2".repeat(32)}`;
    const raw = capture(["POST", "/v1/messages?beta=true", JSON.stringify({
      system: [{ type: "text", text: `private system block ${other}` }],
      messages: [{ role: "user", content: [{ type: "text", text: BASELINE_PROMPT }] }],
    })]);
    const observations = observationsFrom(raw, noFrame(1), BASELINE_PROMPT, own);
    expect(observations.requests[0]?.texts[0]).toMatchObject({ from: "system", withheld: "not this arm's evidence" });
    expect(JSON.stringify(observations)).not.toContain("private system block");
  });

  it("keeps a text verbatim only from the requests its counts are derived from", () => {
    // Both reviewers reproduced the same defect here, one of them with a system-prompt fixture: the
    // writer kept any text containing the token, and the reader judged a text without its request,
    // so a count-tokens request or a GET whose text carried the token was published verbatim in
    // every arm while no count read a word of it. The repository is public and the text is the
    // client's, so this is the safety defect the withholding rule exists to prevent, one layer up.
    const quoted = `You are Claude Code. Never repeat ${ROLE_WAKE_TOKEN} back to a user. <pages of vendor text>`;
    const raw = capture(
      ["POST", "/v1/messages/count_tokens", turn(quoted)],
      ["GET", `/v1/messages?q=${ROLE_WAKE_TOKEN}`, turn(quoted)],
      ["POST", "/v1/messages?beta=true", turn(BASELINE_PROMPT)],
      ["POST", "/v1/messages?beta=true", turn(`Another Claude session sent a message:\n${ROLE_WAKE_TOKEN}`)],
    );
    const observations = observationsFrom(raw, frameAfter(3));

    // Neither non-turn published a word of it, and neither contributed to a count.
    const written = JSON.stringify(observations);
    expect(written).not.toContain("pages of vendor text");
    expect(written).not.toContain("Never repeat");
    expect(observations.requests[0]?.texts).toEqual([withheld("system", "You are Claude."), withheld("user", quoted)]);
    expect(observations.requests[1]?.texts).toEqual([withheld("system", "You are Claude."), withheld("user", quoted)]);
    expect(countsFrom(observations)).toEqual({
      baselineModelRequests: 1,
      modelRequests: 2,
      wakeCarryingModelRequests: 1,
      followUpAfterInjection: true,
    });

    // The turns keep what their counts are read from, which is the other half: this is not a rule
    // that withholds everything carrying a token.
    expect(observations.requests[2]?.texts).toContainEqual({ from: "user", text: BASELINE_PROMPT });
    expect(observations.requests[3]?.texts).toContainEqual({
      from: "user",
      text: `Another Claude session sent a message:\n${ROLE_WAKE_TOKEN}`,
    });
  });
});

/**
 * The session log a failed arm prints, and the file every run copies out beside its capture.
 *
 * Diagnosis-only output, and the row is narrow on purpose: nothing in the harness measures
 * anything off this text and nothing may. What it owes is to be readable, and a glyph cut in half
 * by a pipe read is the one way this loses that. The row that used to say so was deleted with the
 * screen model, while the guarantee it was about stayed.
 */
describe("U6: the session log is decoded as a stream, not per read", () => {
  it("a glyph split across two reads survives, which decoding each read on its own does not", () => {
    // A pipe read ends wherever the pipe was drained, not on a character boundary. `❯` is three
    // bytes and is the client's own prompt glyph, so this is the split that actually happened.
    const glyph = Buffer.from("❯", "utf8");
    expect(glyph).toHaveLength(3);

    for (const at of [1, 2]) {
      const output = terminalOutput();
      output.push(glyph.subarray(0, at));
      output.push(glyph.subarray(at));
      expect(output.text(), `split after ${at} byte(s)`).toBe("❯");
    }

    // The control, so this is a row about the boundary and not one any implementation passes:
    // decoding each read on its own is what turned each half into a replacement character.
    // Three replacement characters, not two: the first byte is one, and the two trailing bytes are
    // one each, which is what the reviewer who found this row missing measured.
    expect(glyph.subarray(0, 1).toString("utf8") + glyph.subarray(1).toString("utf8")).toBe("\uFFFD".repeat(3));

    // Byte by byte, and with the surrounding text a real read carries.
    const line = Buffer.from("│ ❯ ping │", "utf8");
    const byByte = terminalOutput();
    for (const byte of line) byByte.push(Buffer.from([byte]));
    expect(byByte.text()).toBe("│ ❯ ping │");

    // What is still possible, stated rather than papered over: a glyph the client had not finished
    // writing when the arm read its last chunk has no second half to join, and shows as U+FFFD.
    const truncated = terminalOutput();
    truncated.push(glyph.subarray(0, 2));
    expect(truncated.text()).toBe("\uFFFD");
  });
});

/**
 * The probe's own two decisions, driven where no client is installed.
 *
 * These rows exist because a reviewer refuted the reason the previous ones were narrowed. The
 * claim was that the `spawn` call and the `if (!baselineSeen)` refusal run only inside a live arm,
 * so no row that must die where no client is installed could be anchored at either; the reviewer
 * drove both through injected boundaries and showed a mutation at either site left all 24 selected
 * offline test bodies green. The branches are reachable, so the rows are anchored at them.
 *
 * One boundary is injected and no more: the function that starts the process. The temp root, the
 * fake provider, the unix socket, the production wake frame, the capture and the teardown are all
 * the real ones, so what these rows measure is the probe rather than a model of it. What stands in
 * for the client is `./wake-transport-qualification/fake-client.ts`, which is not evidence about any
 * client and is not used by `qualify()` -- it binds where its argv tells it to, takes the turns a
 * row's environment asks it for, and answers or ignores an arriving frame, which is exactly enough
 * for the probe's decisions to be observable.
 */
describe("U6: what the probe starts, and what it refuses to proceed without", () => {
  const CAPTURE_DIR = "evidence/local/u6-wake-transport-offline";
  const FAKE_CLIENT = fileURLToPath(new URL("./wake-transport-qualification/fake-client.ts", import.meta.url));

  let image: HeldImage | undefined;
  /**
   * A held image of a file that is not a client and carries no exec bit.
   *
   * `holdImage` links and digests; it does not require the file to be executable, and the row
   * injects the function that starts a process, so nothing here ever execs this inode. Writing it
   * without the exec bit is the honest form of that -- an exec bit would say an exec is intended --
   * and `confirmHeld` still re-reads the same bytes at the end of the run.
   */
  const stand = (): HeldImage => {
    if (image) return image;
    const scratch = mkdtempSync("/private/tmp/acp-u6q-stand-");
    const file = join(scratch, "claude");
    writeFileSync(file, "not a client: never executed, only linked and digested\n");
    return (image = holdImage(file));
  };
  afterAll(() => {
    image?.release();
    rmSync(join(REPO_ROOT, CAPTURE_DIR), { recursive: true, force: true });
  });

  /** Records what the probe asked to start, then starts the stand-in with exactly that argv. */
  const starter = (
    started: { executable: string; argv: readonly string[] }[],
    session: NodeJS.ProcessEnv = {},
  ) => (
    executable: string,
    argv: readonly string[],
    options: { readonly env: NodeJS.ProcessEnv; readonly cwd: string },
  ): ChildProcessWithoutNullStreams => {
    started.push({ executable, argv: [...argv] });
    return spawn(process.execPath, [FAKE_CLIENT, ...argv], {
      env: { ...options.env, ...session },
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
  };

  /**
   * Both shapes, through the same injected boundary.
   *
   * The rows below used to drive the headless shape only, and a reviewer showed that
   * interactive-only versions of these mutations survived that. The interactive plan starts a pty
   * allocator rather than the client directly (`spawnPlanFor`), so what the stand-in receives is a
   * different argv -- it finds its socket in it either way, which is the point of reading
   * `--messaging-socket-path` from argv the way the real client does.
   */
  const SHAPES = ["headless", "interactive"] as const;

  it.each(SHAPES)("%s: starts the invocation its reading records, and nothing beside it", async (shape) => {
    const started: { executable: string; argv: readonly string[] }[] = [];
    const run = await runQualificationProbe({
      shape,
      inject: true,
      captureDir: CAPTURE_DIR,
      image: stand(),
      settleCeilingMs: 3_000,
      baselineCeilingMs: 30_000,
      startProcess: starter(started),
    });

    // One start, of the held link, with the plan's argv -- and the reading's `command` is that same
    // invocation. A flag added at the spawn and not to the plan is the divergence a reader of the
    // reading could never detect, and it is what this equality refuses.
    expect(started).toHaveLength(1);
    const startedArgv = started[0]?.argv ?? [];
    if (shape === "interactive") {
      // The interactive plan starts a pty allocator, and the invocation the reading records is the
      // client's own -- the allocator's argv is its script followed by exactly that command. A
      // reading that recorded the allocator instead would describe a session no claim is about.
      expect(started[0]?.executable).toBe(resolvePtyAllocator()?.python);
      expect(startedArgv[0]).toMatch(/pty-session\.py$/);
      expect(startedArgv.slice(1)).toEqual(run.command);
    } else {
      expect(started[0]?.executable).toBe(stand().executable);
      expect([started[0]?.executable, ...startedArgv]).toEqual(run.command);
    }
    // Path-independent and exact about the part that decides the shape: the flags the process was
    // started with are the flags `probeArgv` builds for this shape, in that order.
    const flagsOf = (argv: readonly string[]): readonly string[] => argv.filter((word) => word.startsWith("-"));
    expect(flagsOf(startedArgv)).toEqual(
      flagsOf(probeArgv(shape, { settingsPath: "/s/settings.json", socketPath: "/s/i.sock" })),
    );
    expect(isInteractiveClaudeInvocation(run.command)).toBe(shape === "interactive");

    // And the arm really ran through the probe's own path: the production frame reached the model
    // input of the process it started, and the counts came out of the capture. This is also the
    // mirror of the row below -- a session that takes its second turn only after the frame, which
    // is the one an injection arm is supposed to pass.
    expect(run.wakeCarryingModelRequests).toBe(1);
    expect(run.followUpAfterInjection).toBe(true);
    expect(armPassed(run)).toBe(true);
    // Three: the prompt's turn, the production frame's, and the witness frame's. An injection arm
    // writes both frames, and the witness the arm minted comes back in the model input of a turn --
    // the one thing in the record that no reading written beforehand could have carried.
    expect(run.observations?.requests).toHaveLength(3);
    expect(run.observations?.witness).toMatch(ARM_WITNESS);
    expect(witnessCarryingTurns(run.observations!)).toHaveLength(1);
    // One request existed when the frame was written, and the arm recorded that rather than
    // leaving a reader to work it out from which request carries the prompt.
    expect(run.observations?.boundary).toEqual({ frameWritten: true, requestsBefore: 1, requestsBeforeWitness: 2 });
  }, 90_000);

  it.each(SHAPES)(
    "%s: a turn that preceded the frame is not the follow-up the frame caused",
    async (shape) => {
      // A reviewer drove this probe against a session that takes a turn carrying the wake token of
      // its own accord, before any frame exists, and then ignores the frame it is sent. Deriving
      // the baseline from the prompt's position counted that turn as the follow-up the frame
      // caused, and every arm was admitted -- the ceremony passing a build that ignores the wake.
      // The stand-in sends both turns before it binds its socket, and the probe waits for the
      // socket before it waits for the baseline, so "both preceded the frame" is a fact about the
      // capture here and not a race.
      const started: { executable: string; argv: readonly string[] }[] = [];
      const run = await runQualificationProbe({
        shape,
        inject: true,
        captureDir: CAPTURE_DIR,
        image: stand(),
        settleCeilingMs: 2_000,
        baselineCeilingMs: 30_000,
        startProcess: starter(started, {
          ACP_FAKE_CLIENT_PRE_WAKE_TURN: `Another Claude session sent a message:\n${ROLE_WAKE_TOKEN}\nRead your inbox.`,
          ACP_FAKE_CLIENT_IGNORES_FRAME: "1",
        }),
      });
      // Recorded, not thrown: a failed measurement is still one, and it has to be able to replace a
      // build's earlier qualified reading.
      expect(qualificationShortfalls([run]).some((problem) =>
        problem.includes("does not record a second boundary after a production-token turn and before the witness frame"))).toBe(true);
    },
    90_000,
  );

  it.each(SHAPES)("%s: turns released only after the witness frame do not prove the production wake", async (shape) => {
    const run = await runQualificationProbe({
      shape,
      inject: true,
      captureDir: CAPTURE_DIR,
      image: stand(),
      settleCeilingMs: 1_000,
      baselineCeilingMs: 30_000,
      startProcess: starter([], { ACP_FAKE_CLIENT_RELEASE_ON_SECOND_FRAME: "1" }),
    });
    expect(qualificationShortfalls([run]).some((problem) =>
      problem.includes("does not record a second boundary after a production-token turn and before the witness frame"))).toBe(true);
  }, 90_000);

  it.each(SHAPES)("%s: refuses an arm whose prompt never became a turn, rather than measuring against nothing", async (shape) => {
    // The refusal, at the branch that acts. The stand-in takes its start, binds its socket and
    // takes a turn -- just not this arm's prompt -- so everything except the one observation this
    // arm needs is present. Proceeding would leave `followUpAfterInjection` comparing the wake
    // against a count that never included the prompt, and the arm would report a pass for a session
    // that never accepted it.
    const started: { executable: string; argv: readonly string[] }[] = [];
    await expect(
      runQualificationProbe({
        shape,
        inject: true,
        captureDir: CAPTURE_DIR,
        image: stand(),
        settleCeilingMs: 1_000,
        baselineCeilingMs: 5_000,
        startProcess: starter(started, { ACP_FAKE_CLIENT_TURN: "some other turn entirely" }),
      }),
    ).rejects.toThrow(/sent no model request carrying "ping", the prompt it was started with/);
    expect(started).toHaveLength(1);
  }, 90_000);
});

describe.skipIf(blocker !== null)("U6: the reading, re-taken", () => {
  // Held once for both arms and every row, as `qualify()` holds it: an arm that resolved the client
  // for itself could run a build other than the one the rows below ask about.
  let held: PinnedClaudeImage | undefined;
  const image = (): PinnedClaudeImage => (held ??= pinClaudeImage());
  afterAll(() => held?.release());

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
    const started = runQualificationProbe({ shape: "interactive", inject, captureDir: SUITE_CAPTURE_DIR, image: image() });
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
    "the arm that ran was the interactive shape, and its baseline turn was one it was started with",
    async () => {
      const run = await probe(true);

      // The argv of a client that really started, redacted but argv-shaped, through the same
      // predicate. The row above checks what `probeArgv` returns; this checks what ran.
      expect(isInteractiveClaudeInvocation(run.command)).toBe(true);
      expect(run.command.at(-1)).toBe(BASELINE_PROMPT);

      // The positional prompt produced a turn, and it produced it before the frame was written:
      // the arm cannot reach this point otherwise, and the number says so rather than implying it.
      expect(run.baselineModelRequests).toBeGreaterThan(0);
    },
    PROBE_TIMEOUT_MS,
  );

  it(
    "the build it measured is a member of the qualified set",
    async () => {
      // The build the arm ran, not the one the launcher names now: the arm's own digest, read after
      // its measurement, is the held image's, and the version asked of is the one that image printed.
      const run = await probe(true);
      expect(run.imageSha256).toBe(image().sha256);
      expect(isWakeTransportQualified({ name: MEASURED_CLIENT_NAME, version: image().version })).toBe(true);
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
