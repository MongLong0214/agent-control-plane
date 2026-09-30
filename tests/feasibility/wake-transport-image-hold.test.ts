/**
 * A reading names the image its arms executed, and a run whose arms could have executed another one
 * does not produce a reading.
 *
 * Membership in the qualified set rests on one claim: the build is there because *its own reading*
 * says it qualified. Before 2026-09-28 the receipt resolved and digested the launcher once, and each
 * of the four arms resolved it again for itself. The launcher is a symlink the updater re-points, and
 * the file behind it is one the updater renames over and deletes, so a reading could name image A
 * while the arms that produced its verdict ran B -- a reading that cannot be falsified, because
 * nothing in it says which file ran.
 *
 * The repair has three parts and each has a row here: the image is held once, as a hard link no
 * updater can reach (`holdImage`); every arm executes that link and re-reads it after its
 * measurement (`confirmHeld`); and a receipt refuses an arm whose digest is not the one it names
 * (`buildReceipt`).
 *
 * Nothing here starts a client. The held files are data written by this test and never executed,
 * except in the last row, which holds a hard link to this process's own interpreter -- an inode
 * that has already run, so nothing new is assessed by the host (#817).
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BASELINE_PROMPT,
  buildReceipt,
  confirmHeld,
  countsFrom,
  holdImage,
  observationsFrom,
  pinClaudeImage,
  type ProbeRun,
  type ProbeShape,
} from "./wake-transport-qualification/harness.ts";
import { ROLE_WAKE_TOKEN } from "../../src/mcp/role-conversation.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterEach(cleanupTempDirs);

const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** A launcher symlink onto a versioned file, laid out the way the installer lays out the real one. */
const installed = (bytes: string) => {
  const root = tempDir("acp-u6q-hold-");
  const versions = join(root, "versions");
  mkdirSync(versions);
  const version = join(versions, "2.1.283");
  writeFileSync(version, bytes);
  const launcher = join(root, "claude");
  symlinkSync(version, launcher);
  return { root, versions, version, launcher };
};

describe("a qualification run holds one image for its whole length", () => {
  it("the held image outlives the updater re-pointing the launcher, renaming a new file over it, and deleting it", () => {
    const original = "the bytes every arm was started on\n";
    const { root, versions, version, launcher } = installed(original);

    const held = holdImage(launcher, root);
    try {
      expect(held.path).toBe(realpathSync(version));
      expect(held.executable).not.toBe(held.path);
      expect(held.sha256).toBe(sha256(original));

      // The updater's three moves, in the order it makes them. After each, the name the arms execute
      // still holds the bytes the reading will name.
      writeFileSync(join(versions, "2.1.284"), "the next build\n");
      rmSync(launcher);
      symlinkSync(join(versions, "2.1.284"), launcher);
      expect(confirmHeld(held)).toBe(sha256(original));

      const staged = join(versions, ".2.1.283.partial");
      writeFileSync(staged, "the same version number over other bytes\n");
      renameSync(staged, version);
      expect(confirmHeld(held)).toBe(sha256(original));

      rmSync(version);
      expect(confirmHeld(held)).toBe(sha256(original));
      expect(readFileSync(held.executable, "utf8")).toBe(original);
    } finally {
      held.release();
    }
    expect(existsSync(held.executable)).toBe(false);
  });

  it("a rewrite of the held inode in place fails the run, even one that keeps its size and modification time", () => {
    const { root, version, launcher } = installed("AAAAAAAAAAAAAAAA\n");
    // A whole-second modification time, so the rewrite below can put back exactly the value that was
    // held and only the bytes differ.
    utimesSync(version, 1_700_000_000, 1_700_000_000);

    const held = holdImage(launcher, root);
    try {
      // `writeFileSync` truncates and writes the existing inode, so this reaches the link too: the one
      // change the hold cannot keep out, and the one `confirmHeld` is there for.
      writeFileSync(version, "BBBBBBBBBBBBBBBB\n");
      utimesSync(version, 1_700_000_000, 1_700_000_000);

      expect(() => confirmHeld(held)).toThrow(/digests to [0-9a-f]{64}, not the [0-9a-f]{64} it was held at/);
    } finally {
      held.release();
    }
  });

  it("a reading cannot name an image one of its arms did not execute", () => {
    const named = "a".repeat(64);
    // Both shapes, because a reading qualifies a build only when it holds all four arms and each
    // one's argv is the shape it claims (`qualificationShortfalls`). The headless argv carries the
    // flags the canonical-claim predicate refuses, as `probeArgv` builds it.
    // A capture of the shape the fake provider writes, read by the instrument's own reader: an arm
    // in a receipt has to carry the observations its counts are derived from, and a fixture that
    // stated counts without them is a fixture of a reading the instrument will not accept.
    const captureOf = (injected: boolean, witness: string | null): string => {
      const turn = (text: string): string =>
        `${JSON.stringify({
          at: "2026-09-28T00:00:00.000Z",
          method: "POST",
          url: "/v1/messages?beta=true",
          headers: {},
          body: JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text }] }] }),
        })}\n`;
      return `${turn(BASELINE_PROMPT)}${injected ? turn(`a peer wrote: ${ROLE_WAKE_TOKEN}`) : ""}${
        witness === null ? "" : turn(`a peer wrote: ${witness}`)
      }`;
    };
    // A witness per arm, of the shape `mintArmWitness` produces and distinct across the four, because
    // an arm is admitted only if the value it recorded is echoed where it says the frame landed. These
    // rows are about the image an arm executed, so the witness is fixture scaffolding here.
    const witnessOf = (index: number): string => `u6-witness-${`${index}`.padEnd(32, "0")}`;
    const arm = (shape: ProbeShape, injected: boolean, imageSha256: string | undefined, index: number): ProbeRun => {
      const witness = witnessOf(index);
      const observations = {
        ...observationsFrom(captureOf(injected, injected ? witness : null), {
          frameWritten: injected,
          requestsBefore: 1,
        }),
        witness,
      };
      return {
        shape,
        injected,
        command: shape === "interactive"
          ? ["/private/tmp/acp-u6q-img-fixture/2.1.283", "--messaging-socket-path", "/private/tmp/fixture/s/i.sock", "ping"]
          : ["/private/tmp/acp-u6q-img-fixture/2.1.283", "-p", "--input-format", "stream-json", "--output-format", "stream-json"],
        ...(imageSha256 === undefined ? {} : { imageSha256 }),
        observations,
        ...countsFrom(observations),
        settleCeilingMs: 20_000,
        rawCapturePath: "evidence/local/fixture/capture.jsonl",
        rawSessionLogPath: "evidence/local/fixture/session.log",
        tempRootRemoved: true,
      };
    };
    const receiptOf = (runs: readonly ProbeRun[]) =>
      buildReceipt({
        image: { path: "/fixture/versions/2.1.283", sha256: named, versionOutput: "2.1.283 (Claude Code)", version: "2.1.283" },
        headSha: "0".repeat(40),
        runs,
        limits: [],
        findings: [],
      });

    const armsOn = (digests: readonly (string | undefined)[]): readonly ProbeRun[] => [
      arm("interactive", true, digests[0], 1),
      arm("interactive", false, digests[1], 2),
      arm("headless", true, digests[2], 3),
      arm("headless", false, digests[3], 4),
    ];

    // The control: every arm ran the named image and met its own criterion, so it qualifies.
    expect(receiptOf(armsOn([named, named, named, named])).verdict).toBe("qualified");

    // One arm ran another image. Every number in it is still a pass, which is exactly why the
    // verdict cannot be the place this is caught.
    expect(() => receiptOf(armsOn([named, "b".repeat(64), named, named]))).toThrow(
      `arm 2 (interactive, control) executed an image whose digest is ${"b".repeat(64)}, not the ${named} this reading would name`,
    );
    // An arm that cannot say what it ran is refused the same way.
    expect(() => receiptOf(armsOn([undefined, named, named, named]))).toThrow(
      `arm 1 (interactive, injection) executed an image whose digest is not recorded, not the ${named} this reading would name`,
    );
  });

  it("the version is asked of the held link, so the version, the digest and every exec are of one inode", () => {
    const root = tempDir("acp-u6q-pin-");
    const launcher = join(root, "interpreter");
    linkSync(process.execPath, launcher);

    const image = pinClaudeImage(launcher, root);
    try {
      expect(image.version).toBe(process.version);
      expect(image.sha256).toBe(sha256(readFileSync(process.execPath)));
      expect(image.executable.startsWith(root)).toBe(true);
      expect(confirmHeld(image)).toBe(image.sha256);
    } finally {
      image.release();
    }
    expect(existsSync(image.executable)).toBe(false);
  });
});
