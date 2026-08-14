import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { __testing } from "../../src/runtime/cli-adapters.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * A reviewer must not be able to read producer reasoning.
 *
 * #360 found that the packet claimed this and the seatbelt did not implement it. The profile
 * has since grown the deny and live probes, but nothing proved the boundary bit: the whole
 * suite passed with `~/.claude` and `~/.codex` removed from the deny list, which is the same
 * shape as the 26 tests this repository already found passing without their enforcement.
 *
 * So this runs the real `sandbox-exec` against the real profile and tries the read. It fails
 * if the deny is removed, because it asserts on what the kernel did rather than on what the
 * packet says was withheld.
 */
const SECRET = "producer reasoning that a reviewer must never see";

/**
 * The profile resolves the transcript roots from the *building* process's HOME, and the child
 * inherits the same HOME in production (the daemon builds it and spawns the reviewer). So the
 * build has to happen under the HOME the child will see — otherwise the profile denies the
 * real `~/.claude` while the child reads a different one, and the test proves nothing. An
 * earlier draft made exactly that mistake and reported a bypass that was its own fault.
 */
const buildProfile = (home: string, packetRoot: string): string => {
  const previous = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    return __testing.reviewerProfile(packetRoot, [], process.execPath, [
      join(home, ".acp-credentials"),
    ]);
  } finally {
    if (previous === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previous;
  }
};

/** Reads the target inside the sandbox. Exit 0 means the read succeeded. */
const readUnderSandbox = (profile: string, target: string, home: string) =>
  spawnSync(
    "/usr/bin/sandbox-exec",
    [
      "-p",
      profile,
      process.execPath,
      "-e",
      `require("node:fs").readFileSync(${JSON.stringify(target)}, "utf8")`,
    ],
    { encoding: "utf8", env: { ...process.env, HOME: home } },
  );

describe("a reviewer cannot read producer transcripts (CP-HI-04, #360)", () => {
  const home = tempDir("reviewer-home");
  const packetRoot = tempDir("reviewer-packet");
  const transcript = join(home, ".claude", "projects", "producer.jsonl");
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  writeFileSync(transcript, SECRET, { mode: 0o600 });

  it("is a real test: the same read succeeds without the sandbox", () => {
    // Without this, a profile that denied everything — or a target that never existed —
    // would make the refusal below meaningless.
    const plain = spawnSync(
      process.execPath,
      ["-e", `require("node:fs").readFileSync(${JSON.stringify(transcript)}, "utf8")`],
      { encoding: "utf8" },
    );
    expect(plain.status).toBe(0);
  });

  it("refuses a read of ~/.claude under the real seatbelt profile", () => {
    const result = readUnderSandbox(buildProfile(home, packetRoot), transcript, home);
    expect(result.status, `sandbox-exec allowed the read: ${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
  });

  it("refuses ~/.codex on the same profile", () => {
    const codex = join(home, ".codex", "history.jsonl");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(codex, SECRET, { mode: 0o600 });

    const result = readUnderSandbox(buildProfile(home, packetRoot), codex, home);
    expect(result.status, `sandbox-exec allowed the read: ${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
  });

  it("still allows the packet the reviewer is meant to read", () => {
    // The opposite failure: a boundary that also blocks the review's own input is not
    // isolation, it is a reviewer that cannot work.
    const packetFile = join(packetRoot, "packet.json");
    writeFileSync(packetFile, JSON.stringify({ candidate: "abc" }), { mode: 0o600 });

    const result = readUnderSandbox(buildProfile(home, packetRoot), packetFile, home);
    expect(result.status, `sandbox-exec denied the packet: ${result.stderr}`).toBe(0);
  });
});
