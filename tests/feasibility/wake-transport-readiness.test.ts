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

/**
 * The cell under the cursor is only the terminal's cell if the model applied every sequence before
 * it the way a terminal would. Until 2026-09-28 an unknown sequence fell through a `default: break`:
 * an insert-line was dropped, the model kept a caret on the row the terminal had moved it off, and
 * a park on that row read as ready. None of the real first screens contains one, so no committed
 * reading fired early; what those rows could not show is a screen that did.
 *
 * So each sequence is applied, known to change no cell, or unmodelled -- and an unmodelled one
 * refuses the screen, by name. The cases below that refuse are chosen from outside what the model
 * names, because a check that fires only on the sequences its author listed is the same defect with
 * a smaller surface.
 */
describe("U6: the screen model applies a sequence that moves cells, or refuses the screen and names it", () => {
  /** An inverse blank at row 38, column 3, after `❯ `: 2.1.283's input row, drawn the way it draws it. */
  const caretAt38 = "\u001b[?1049h\u001b[?25l\u001b[38;1H❯ \u001b[7m \u001b[27m";

  it("an inserted line moves the caret down with it: a park on its old row is not ready, and on its new row is", () => {
    const inserted = `${caretAt38}\u001b[38;1H\u001b[L`;

    const onOldRow = interactiveReadiness(`${inserted}\u001b[38;3H`);
    expect(onOldRow.ready, describeReadiness(onOldRow)).toBe(false);
    expect(onOldRow.carets).toEqual([{ row: 39, column: 3 }]);

    const onNewRow = interactiveReadiness(`${inserted}\u001b[39;3H`);
    expect(onNewRow.ready, describeReadiness(onNewRow)).toBe(true);
    expect(onNewRow.unmodelled).toEqual([]);
  });

  it("an insert-line over a real first screen moves 2.1.283's caret off the row the client parks on", () => {
    const text = transcriptOf(loadFirstScreen("claude-code@2.1.283.json").reads);
    expect(interactiveReadiness(text).cursor).toEqual({ row: 38, column: 3 });

    expect(interactiveReadiness(`${text}\u001b[38;1H\u001b[L\u001b[38;3H`).ready).toBe(false);
    expect(interactiveReadiness(`${text}\u001b[38;1H\u001b[L\u001b[39;3H`).ready).toBe(true);
  });

  it("delete-line, scrolling and reverse index move the lines inside the scroll region and nothing outside it", () => {
    const readyAt = (stream: string, park: string): boolean => interactiveReadiness(`${stream}\u001b[${park}H`).ready;

    // Delete-line at row 37 pulls row 38 up to it.
    expect(readyAt(`${caretAt38}\u001b[37;1H\u001b[M`, "38;3")).toBe(false);
    expect(readyAt(`${caretAt38}\u001b[37;1H\u001b[M`, "37;3")).toBe(true);

    // Scroll up and down, and a reverse index at the top margin, move every line of the region.
    expect(readyAt(`${caretAt38}\u001b[S`, "37;3")).toBe(true);
    expect(readyAt(`${caretAt38}\u001b[T`, "39;3")).toBe(true);
    expect(readyAt(`${caretAt38}\u001b[H\u001bM`, "39;3")).toBe(true);

    // A region ending at row 37 leaves row 38 where it is, whatever is inserted above it, and an
    // insert-line on a row outside the region does nothing at all.
    expect(readyAt(`${caretAt38}\u001b[1;37r\u001b[30;1H\u001b[3L`, "38;3")).toBe(true);
    expect(readyAt(`${caretAt38}\u001b[1;37r\u001b[38;1H\u001b[L`, "38;3")).toBe(true);
    // Inside the region, a line feed on its bottom margin scrolls only the region.
    expect(readyAt(`${caretAt38}\u001b[1;37r\u001b[37;1H\n`, "38;3")).toBe(true);
  });

  it("every sequence on every real first screen is one the model applies or knows changes no cell", () => {
    for (const name of [...BUILDS.map((version) => `claude-code@${version}.json`), "claude-code@2.1.283.workspace-trust.json"]) {
      const reading = interactiveReadiness(transcriptOf(loadFirstScreen(name).reads));
      expect(reading.unmodelled, name).toEqual([]);
    }
  });

  it("a sequence that would move cells and is not modelled refuses the screen and is named", () => {
    const text = transcriptOf(loadFirstScreen("claude-code@2.1.283.json").reads);
    // The control: the same screen, the cursor sent elsewhere and parked back on the caret, with
    // sequences the model knows to be inert on the way. Ready -- so what refuses below is the sequence.
    const control = interactiveReadiness(
      `${text}\u001b[1;1H\u001b[?2026h\u001b]0;title\u0007\u001b[>1u\u001b[2 q\u001b[?2026l\u001b[38;3H`,
    );
    expect(control.ready, describeReadiness(control)).toBe(true);
    expect(control.unmodelled).toEqual([]);

    const cellMoving: readonly { readonly sequence: string; readonly name: string }[] = [
      // Insert mode: every glyph printed after it pushes the rest of its line right.
      { sequence: "\u001b[4h", name: "ESC[4h" },
      // Scroll left (ECMA-48 SL): every column of the screen moves.
      { sequence: "\u001b[2 @", name: "ESC[2 @" },
      // Character position backward (ECMA-48 HPB): a cursor move, and a final the model never names.
      { sequence: "\u001b[3j", name: "ESC[3j" },
      // Repeat the preceding glyph.
      { sequence: "x\u001b[3b", name: "ESC[3b" },
      // Copy a rectangle of cells to another place on the screen.
      { sequence: "\u001b[1;1;5;5;1;30;1$v", name: "ESC[1;1;5;5;1;30;1$v" },
      // Origin mode: every later absolute move is relative to the scroll region.
      { sequence: "\u001b[?6h", name: "ESC[?6h" },
      // Screen alignment: every cell becomes an E.
      { sequence: "\u001b#8", name: "ESC#8" },
      // An inline image and a kitty graphics placement: both draw, and both move the cursor.
      { sequence: "\u001b]1337;File=inline=1:AAAA\u0007", name: "ESC]1337;File=inline=1:AAAA\\x07" },
      { sequence: "\u001b_Ga=T;AAAA\u001b\\", name: "ESC_Ga=T;AAAAESC\\" },
      // A C1 control, which a UTF-8 terminal may read as CSI.
      { sequence: "\u009b", name: "\\x9b" },
    ];
    for (const { sequence, name } of cellMoving) {
      const reading = interactiveReadiness(`${text}\u001b[1;1H${sequence}\u001b[38;3H`);
      expect(reading.ready, name).toBe(false);
      expect(reading.unmodelled, name).toEqual([name]);
      expect(describeReadiness(reading), name).toContain(`every sequence applied: no -- not modelled: ${name}`);
    }
  });
});

/** 2.1.283's input row: `❯ ` and an inverse blank at row 38, column 3. The cursor is left after it. */
const inputRow = "\u001b[38;1H❯ \u001b[7m \u001b[27m";

/**
 * DEC save and restore are per buffer: xterm keeps one saved cursor for the main screen and one for
 * the alternate (`cursor.c`, `sc[whichBuf]`), and `CSI ?1049h/l` is save, switch, clear on the way
 * in and switch, restore on the way out. With one saved cursor shared between them, a save made on
 * the alternate screen replaced the one that leaving it restores, and a stream review built read
 * `ready: true` with the terminal's cursor on row 1.
 */
describe("U6: a saved cursor belongs to the buffer it was saved on", () => {
  const onMain = `\u001b[?25l${inputRow}`;

  it("a cursor saved on the alternate screen is not the one leaving it with 1049 restores", () => {
    // Review's stream: parked at row 1 on the main screen, the alternate entered, a save made there
    // on the caret's row, and the alternate left. The terminal puts back row 1.
    const reviewed = interactiveReadiness(`${onMain}\u001b[1;1H\u001b[?1049h\u001b[38;3H\u001b7\u001b[?1049l`);
    expect(reviewed.cursor).toEqual({ row: 1, column: 1 });
    expect(reviewed.ready, describeReadiness(reviewed)).toBe(false);
    expect(reviewed.unmodelled).toEqual([]);

    // The other way round: parked on the caret when the alternate is entered, and a save made on
    // row 1 there. Leaving puts the cursor back on the caret.
    const returned = interactiveReadiness(`${onMain}\u001b[38;3H\u001b[?1049h\u001b[1;1H\u001b7\u001b[?1049l`);
    expect(returned.cursor).toEqual({ row: 38, column: 3 });
    expect(returned.ready, describeReadiness(returned)).toBe(true);
  });

  it("a save and a restore on one screen still return to the saved cell, on either screen and by every form", () => {
    const forms = [["\u001b7", "\u001b8"], ["\u001b[s", "\u001b[u"], ["\u001b[?1048h", "\u001b[?1048l"]] as const;
    for (const enter of ["", "\u001b[?1049h"]) {
      for (const [save, restore] of forms) {
        const reading = interactiveReadiness(`${enter}${onMain}\u001b[38;3H${save}\u001b[1;1H${restore}`);
        expect(reading.ready, `${JSON.stringify(enter)} ${JSON.stringify(save)}\n${describeReadiness(reading)}`).toBe(true);
      }
    }
  });
});

/**
 * An unmodelled sequence used to refuse every later frame: the record was never cleared, so one
 * harmless sequence before the prompt failed the readiness wait, and no repaint could recover it.
 * Two repairs, which pull against each other.
 *
 * `OSC 1337` is judged by its command, because the number carries a navigation mark and an inline
 * image alike. And a sequence's doubt lasts as long as its effect can: a repaint overwrites cells
 * and the cursor, so it ends the doubt of a sequence confined to those, and it overwrites no mode,
 * so the doubt of a sequence the model cannot confine lasts the stream. Forgive that one at a
 * repaint and a screen the terminal moved reads as the one the model drew again.
 */
describe("U6: an unmodelled sequence keeps the screen in doubt for as long as its effect can last", () => {
  const image = "\u001b]1337;File=inline=1:AAAA\u0007";
  const imageName = "ESC]1337;File=inline=1:AAAA\\x07";
  // The same repaint for every case below: home, the whole screen erased, the input row drawn, and
  // the cursor parked on its caret.
  const repaint = `\u001b[H\u001b[2J${inputRow}\u001b[38;3H`;

  it("an OSC 1337 command is judged by what it does: a mark on the caret is ready, and an image or a command nobody classified is not", () => {
    const text = transcriptOf(loadFirstScreen("claude-code@2.1.283.json").reads);
    const parkedAfter = (sequence: string) => interactiveReadiness(`${text}\u001b[1;1H${sequence}\u001b[38;3H`);

    const inert = [
      "\u001b]1337;SetMark\u001b\\",
      "\u001b]1337;SetMark\u0007",
      "\u001b]1337;CurrentDir=/tmp\u0007",
      "\u001b]1337;SetUserVar=phase=cmVhZHk=\u0007",
      "\u001b]1337;RemoteHost=user@host\u0007",
      "\u001b]1337;ShellIntegrationVersion=17;zsh\u0007",
      "\u001b]1337;CursorShape=1\u0007",
    ];
    for (const sequence of inert) {
      const reading = parkedAfter(sequence);
      expect(reading.ready, `${JSON.stringify(sequence)}\n${describeReadiness(reading)}`).toBe(true);
      expect(reading.unmodelled, JSON.stringify(sequence)).toEqual([]);
    }

    // Review's second run: the mark, then the screen cleared and redrawn. It stayed refused.
    const redrawn = interactiveReadiness(
      `\u001b[?1049h\u001b[?25l${inputRow}\u001b]1337;SetMark\u001b\\\u001b[2J\u001b[H${inputRow}\u001b[38;3H`,
    );
    expect(redrawn.ready, describeReadiness(redrawn)).toBe(true);

    const refused = [
      // Draws at the cursor and moves it by a size the model cannot know.
      { sequence: image, name: imageName },
      // Changes how wide every later glyph is.
      { sequence: "\u001b]1337;UnicodeVersion=8\u0007", name: "ESC]1337;UnicodeVersion=8\\x07" },
      // Everything received after it goes to the pasteboard until EndCopy.
      { sequence: "\u001b]1337;CopyToClipboard=\u0007", name: "ESC]1337;CopyToClipboard=\\x07" },
      // Nobody has classified it, so nobody may assume it is inert.
      { sequence: "\u001b]1337;NotYetDefined=1\u0007", name: "ESC]1337;NotYetDefined=1\\x07" },
      { sequence: "\u001b]1337\u0007", name: "ESC]1337\\x07" },
    ];
    for (const { sequence, name } of refused) {
      const reading = parkedAfter(sequence);
      expect(reading.ready, name).toBe(false);
      expect(reading.untrusted, name).toEqual([name]);
    }
  });

  it("a repaint ends the doubt an inline image leaves, and not the doubt of a sequence that changes how later bytes land", () => {
    const text = transcriptOf(loadFirstScreen("claude-code@2.1.283.json").reads);

    // The image, and the cursor sent straight back to the caret: its cells are in doubt.
    const drawnOver = interactiveReadiness(`${text}\u001b[1;1H${image}\u001b[38;3H`);
    expect(drawnOver.ready, describeReadiness(drawnOver)).toBe(false);
    expect(drawnOver.untrusted).toEqual([imageName]);

    // The image, then the repaint: ready, with the image still on record.
    const repainted = interactiveReadiness(`${text}\u001b[1;1H${image}${repaint}`);
    expect(repainted.ready, describeReadiness(repainted)).toBe(true);
    expect(repainted.unmodelled).toEqual([imageName]);
    expect(repainted.untrusted).toEqual([]);
    expect(describeReadiness(repainted)).toContain(
      "screen in doubt: no -- each sequence not applied was confined to the screen and repainted over since",
    );
    const parts = "\u001b]1337;MultipartFile=inline=1\u0007\u001b]1337;FilePart=AAAA\u0007\u001b]1337;FileEnd\u0007";
    expect(interactiveReadiness(`${text}\u001b[1;1H${parts}${repaint}`).ready).toBe(true);

    // The other direction, across that same repaint.
    const lasting = [
      // Insert mode: every glyph of the redraw pushes the rest of its line right.
      { sequence: "\u001b[4h", name: "ESC[4h" },
      // Origin mode: the redraw's absolute moves land relative to the scroll region.
      { sequence: "\u001b[?6h", name: "ESC[?6h" },
      // A final the model never names, so nothing says what it left behind.
      { sequence: "\u001b[3j", name: "ESC[3j" },
      { sequence: "\u001b]1337;UnicodeVersion=8\u0007", name: "ESC]1337;UnicodeVersion=8\\x07" },
      { sequence: "\u001b]1337;NotYetDefined=1\u0007", name: "ESC]1337;NotYetDefined=1\\x07" },
    ];
    for (const { sequence, name } of lasting) {
      const reading = interactiveReadiness(`${text}\u001b[1;1H${sequence}${repaint}`);
      expect(reading.ready, name).toBe(false);
      expect(reading.untrusted, name).toEqual([name]);
      expect(describeReadiness(reading), name).toContain(`screen in doubt: yes -- after: ${name}`);
      // With the image before it, the repaint ends the image's doubt and not this one's.
      const both = interactiveReadiness(`${text}\u001b[1;1H${image}${sequence}${repaint}`);
      expect(both.unmodelled, name).toEqual([imageName, name]);
      expect(both.untrusted, name).toEqual([name]);
    }

    // Leaving the buffer the image was drawn on is the other boundary: 1049 restores the cursor
    // saved on the way in, and the main screen's cells were never in doubt. Entering again by 1049
    // clears the alternate, so a caret drawn there and parked on is ready.
    expect(interactiveReadiness(`${text}\u001b[1;1H${image}\u001b[?1049l`).untrusted).toEqual([]);
    const reentered = interactiveReadiness(`${text}\u001b[1;1H${image}\u001b[?1049l\u001b[?1049h${inputRow}\u001b[38;3H`);
    expect(reentered.ready, describeReadiness(reentered)).toBe(true);
  });

  it("a repaint that has not placed the cursor, or writes before placing it, leaves the screen in doubt", () => {
    // The caret on the main screen with the cursor on it; the alternate entered by 1047, which does
    // not clear it; an image drawn there; the alternate left by 1047, which does not restore the
    // cursor. The main screen's cells were never in doubt. Where the image left the cursor is.
    const onMain = `\u001b[?25l${inputRow}\u001b[38;3H`;
    const unplaced = interactiveReadiness(`${onMain}\u001b[?1047h${image}\u001b[?1047l`);
    expect(unplaced.cursorOnCaret).toBe(true);
    expect(unplaced.ready, describeReadiness(unplaced)).toBe(false);
    expect(unplaced.untrusted).toEqual([imageName]);
    const placed = interactiveReadiness(`${onMain}\u001b[?1047h${image}\u001b[?1047l\u001b[38;3H`);
    expect(placed.ready, describeReadiness(placed)).toBe(true);

    // The image drawn on row 37, the screen erased, and the input row written by a line feed and
    // text from wherever the cursor then was. The model has that as row 38 and the park lands on
    // its caret, but the terminal's cursor had moved past the image, so which row was written is
    // not known -- and a park by both coordinates afterwards does not make it known.
    const text = transcriptOf(loadFirstScreen("claude-code@2.1.283.json").reads);
    const writtenBlind = interactiveReadiness(`${text}\u001b[37;1H${image}\u001b[2J\n❯ \u001b[7m \u001b[27m\u001b[38;3H`);
    expect(writtenBlind.cursorOnCaret).toBe(true);
    expect(writtenBlind.ready, describeReadiness(writtenBlind)).toBe(false);
    expect(writtenBlind.untrusted).toEqual([imageName]);
    const thenRepainted = interactiveReadiness(
      `${text}\u001b[37;1H${image}\u001b[2J\n❯ \u001b[7m \u001b[27m\u001b[38;3H${repaint}`,
    );
    expect(thenRepainted.ready, describeReadiness(thenRepainted)).toBe(true);
  });
});
