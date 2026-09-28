/**
 * When the qualification harness decides the interactive client is at its prompt, and when it
 * must not.
 *
 * The only way a build enters `WAKE_TRANSPORT_QUALIFIED_CLIENTS` is by being measured by the
 * harness, and the measurement starts by typing into the client's prompt. A readiness check that
 * never fires makes every build it misreads unqualifiable; one that fires early types into
 * whatever is on screen, which on the workspace-trust dialog is an answer to that dialog.
 *
 * Every screen here is a real one. Each fixture under `wake-transport-qualification/first-screens/`
 * is the stdout of an installed build, started in `runQualificationProbe`'s interactive launch
 * shape through the harness's own pty allocator, stored read by read as the harness received it.
 * Nothing here spawns a client. The negatives are cuts of those same streams, and one real screen
 * that is not a prompt at all.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PTY_COLS,
  PTY_ROWS,
  describeReadiness,
  interactiveReadiness,
  strip,
  terminalTranscript,
} from "./wake-transport-qualification/harness.ts";

interface FirstScreen {
  readonly client: { readonly name: string; readonly version: string; readonly imageSha256: string };
  readonly streamSha256: string;
  readonly chunks: readonly { readonly atMs: number; readonly base64: string }[];
}

/** The builds installed on the host the fixtures were captured on, 2026-09-28. */
const BUILDS = ["2.1.268", "2.1.281", "2.1.282", "2.1.283"] as const;

const fixtureUrl = (name: string): URL => new URL(`./wake-transport-qualification/first-screens/${name}`, import.meta.url);

const loadFirstScreen = (name: string): { readonly fixture: FirstScreen; readonly reads: readonly Buffer[] } => {
  const fixture = JSON.parse(readFileSync(fixtureUrl(name), "utf8")) as FirstScreen;
  const reads = fixture.chunks.map((chunk) => Buffer.from(chunk.base64, "base64"));
  // The fixture names its own bytes, so an edit to a capture is a failure here and not a new truth.
  expect(createHash("sha256").update(Buffer.concat(reads)).digest("hex"), name).toBe(fixture.streamSha256);
  return { fixture, reads };
};

/** Feeds reads through the transcript the probe itself uses, in the order they arrived. */
const transcriptOf = (reads: readonly Buffer[]): string => {
  const transcript = terminalTranscript();
  for (const read of reads) transcript.push(read);
  return transcript.text();
};

describe("U6: the interactive client is at its prompt when its cursor rests on the caret it drew", () => {
  for (const version of BUILDS) {
    it(`the prompt is recognised on the first screen of claude-code@${version}`, () => {
      const { fixture, reads } = loadFirstScreen(`claude-code@${version}.json`);
      expect(fixture.client).toMatchObject({ name: "claude-code", version });

      const reading = interactiveReadiness(transcriptOf(reads));
      expect(reading.ready, describeReadiness(reading)).toBe(true);
      expect(reading.cursorOnCaret).toBe(true);
      // Exactly one caret, and it is the cell the cursor rests on: the signal names one place.
      expect(reading.carets).toEqual([reading.cursor]);
    });
  }

  it("the prompt is recognised at the end of the first frame 2.1.283 drew, before any shortcut hint was on screen", () => {
    const { reads } = loadFirstScreen("claude-code@2.1.283.json");
    const firstReady = reads.findIndex((_, index) => interactiveReadiness(transcriptOf(reads.slice(0, index + 1))).ready);
    expect(firstReady).toBeGreaterThanOrEqual(0);

    // The frame that first satisfies the signal carries "auto mode on (shift+tab to cycle)" in its
    // status line; the shortcut hint arrives one repaint later. So what fired was not the hint.
    const atFirstReady = interactiveReadiness(transcriptOf(reads.slice(0, firstReady + 1)));
    expect(atFirstReady.screen.join("\n")).not.toMatch(/for shortcuts/);
    expect(interactiveReadiness(transcriptOf(reads)).screen.join("\n")).toMatch(/for shortcuts/);
  });

  it("2.1.283's hint reads shortuts with escapes deleted and shortcuts with them applied", () => {
    const text = transcriptOf(loadFirstScreen("claude-code@2.1.283.json").reads);

    // The repaint from "(shift+tab to cycle)" to "? for shortcuts" skips the `c` already in that
    // cell with a cursor move. Deleting the move instead of applying it is what dropped the letter:
    // this is the text the old `/for shortcuts/` predicate read, and it never matched.
    expect(strip(text)).toMatch(/for shortuts/);
    expect(strip(text)).not.toMatch(/for shortcuts/);
    expect(interactiveReadiness(text).screen[PTY_ROWS - 1]).toMatch(/\? for shortcuts · ← for agents/);
  });

  it("an empty screen is not a ready prompt", () => {
    expect(interactiveReadiness("").ready).toBe(false);
    expect(interactiveReadiness(transcriptOf([])).ready).toBe(false);
  });

  it("no prefix of a first screen that ends before its input line is a ready prompt, the drawn banner included", () => {
    for (const version of BUILDS) {
      const text = transcriptOf(loadFirstScreen(`claude-code@${version}.json`).reads);
      const inputLine = text.indexOf("❯");
      expect(inputLine, version).toBeGreaterThan(0);

      for (let end = 0; end < inputLine; end += 1) {
        expect(interactiveReadiness(text.slice(0, end)).ready, `${version}, first ${end} characters`).toBe(false);
      }
      // The longest of those is a partial screen, not an empty one: the banner is drawn, the rule
      // above the input box is drawn, and there is no caret anywhere.
      const partial = interactiveReadiness(text.slice(0, inputLine));
      expect(partial.screen.join("\n"), version).toMatch(new RegExp(`Claude Code v${version.replaceAll(".", "\\.")}`));
      expect(partial.carets, version).toEqual([]);
    }
  });

  it("a caret drawn but not yet rested on is not a ready prompt", () => {
    for (const version of BUILDS) {
      const text = transcriptOf(loadFirstScreen(`claude-code@${version}.json`).reads);
      const caretDrawn = text.indexOf("\u001b[7m");
      let firstReady = -1;
      for (let end = 1; end <= text.length && firstReady === -1; end += 1) {
        if (interactiveReadiness(text.slice(0, end)).ready) firstReady = end;
      }
      expect(caretDrawn, version).toBeGreaterThan(0);
      expect(firstReady, version).toBeGreaterThan(caretDrawn);

      // Between the caret being painted and the cursor being parked on it, the frame is still being
      // drawn: the caret is on screen and the cursor is somewhere else.
      const midFrame = interactiveReadiness(text.slice(0, firstReady - 1));
      expect(midFrame.carets.length, version).toBe(1);
      expect(midFrame.ready, version).toBe(false);
    }
  });

  it("a menu pointer is not a caret: the workspace-trust dialog parks the cursor on ❯ and is not a ready prompt", () => {
    const reading = interactiveReadiness(transcriptOf(loadFirstScreen("claude-code@2.1.283.workspace-trust.json").reads));

    // The same glyph the input row starts with, with the cursor resting on it: a glyph match or a
    // "cursor on anything drawn" test would type an answer into this dialog.
    expect(reading.underCursor).toBe("❯");
    expect(reading.screen.join("\n")).toMatch(/❯ No, exit/);
    expect(reading.carets).toEqual([]);
    expect(reading.ready).toBe(false);
  });

  it("a glyph split across two reads is decoded whole, so the caret stays where the client parks the cursor", () => {
    const whole = Buffer.concat(loadFirstScreen("claude-code@2.1.283.json").reads);
    const marker = whole.indexOf(Buffer.from("❯", "utf8"));
    expect(marker).toBeGreaterThan(0);
    // Three of eleven captures split a three-byte glyph at a read boundary; this puts the split on
    // the one row where it decides readiness.
    const reads = [whole.subarray(0, marker + 1), whole.subarray(marker + 1)];

    const text = transcriptOf(reads);
    expect(text).not.toContain("�");
    expect(interactiveReadiness(text).ready).toBe(true);

    // The control: decoding each read on its own turns the split glyph into replacement characters,
    // which push the caret off the cell the client parks on. This is the failure the decoder prevents.
    const perRead = interactiveReadiness(reads.map((read) => read.toString("utf8")).join(""));
    expect(perRead.ready).toBe(false);
  });

  it("the screen model is the size of the pty the allocator opens", () => {
    const allocator = readFileSync(
      fileURLToPath(new URL("./wake-transport-qualification/pty-session.py", import.meta.url)),
      "utf8",
    );
    expect(allocator).toMatch(new RegExp(`^ROWS = ${PTY_ROWS}$`, "m"));
    expect(allocator).toMatch(new RegExp(`^COLS = ${PTY_COLS}$`, "m"));
  });

  it("a failed wait names the signal it looked for and what it saw", () => {
    const report = describeReadiness(
      interactiveReadiness(transcriptOf(loadFirstScreen("claude-code@2.1.283.workspace-trust.json").reads)),
    );
    expect(report).toContain("looked for: the cursor at rest on a caret the client drew");
    expect(report).toContain("cursor on a caret: no");
    expect(report).toContain('cursor: row 14, column 2, over "❯"');
    expect(report).toContain("carets drawn: none");
    expect(report).toContain("full-screen buffer entered: no");
    expect(report).toContain("14|  ❯ No, exit");

    expect(describeReadiness(interactiveReadiness(""))).toContain("(blank)");
  });
});
