import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
const buildProfileWithEgress = (home: string, packetRoot: string, egressPort: number): string => {
  const previous = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    return __testing.reviewerProfile(
      packetRoot,
      [],
      process.execPath,
      [join(home, ".acp-credentials")],
      [],
      egressPort,
    );
  } finally {
    if (previous === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previous;
  }
};

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

/**
 * The other two claims in the same withheld list. #360 said the packet advertised
 * `network: "provider-only"` and `tools: "none"` that the seatbelt did not implement; the
 * profile has since grown both, and — as with the transcript deny — nothing showed they bit.
 */
describe("the rest of the withheld list is enforced, not just declared (#360)", () => {
  const home = tempDir("reviewer-home-2");
  const packetRoot = tempDir("reviewer-packet-2");

  it("refuses to execute a shell under the no-tools profile", () => {
    // `tools: "none"` is `(deny process-exec*)` plus an allowlist of the provider binary and
    // node. A reviewer that can spawn /bin/sh is an ordinary local agent wearing the label.
    const result = spawnSync(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        buildProfile(home, packetRoot),
        process.execPath,
        "-e",
        'require("node:child_process").execFileSync("/bin/sh", ["-c", "echo tools-were-available"])',
      ],
      { encoding: "utf8", env: { ...process.env, HOME: home } },
    );
    expect(result.status, `the sandbox executed a shell: ${result.stdout}`).not.toBe(0);
    // stdout only: a failed execFileSync dumps the argv it attempted, so stderr necessarily
    // echoes the marker. Only stdout distinguishes "the shell ran" from "the shell was refused".
    expect(result.stdout).not.toContain("tools-were-available");
  });

  it("refuses outbound TCP to anywhere but the egress port", async () => {
    // `network: "provider-only"` is implemented by denying outbound and re-allowing exactly
    // one localhost port. This binds a real listener on a *different* port: reaching it means
    // the profile did not constrain the network, whatever the packet says.
    const server = createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    try {
      const profile = buildProfileWithEgress(home, packetRoot, port + 1);
      const result = spawnSync(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          profile,
          process.execPath,
          "-e",
          `const s=require("node:net").connect(${port},"127.0.0.1");` +
            `s.on("connect",()=>{console.log("network-was-open");process.exit(0)});` +
            `s.on("error",()=>process.exit(3));setTimeout(()=>process.exit(4),3000);`,
        ],
        { encoding: "utf8", env: { ...process.env, HOME: home } },
      );
      expect(`${result.stdout}${result.stderr}`).not.toContain("network-was-open");
    } finally {
      server.close();
    }
  });
});

/**
 * The per-user temp allowance, and the boundary that still holds around it (#489).
 *
 * Codex's in-process app-server writes into the per-user temp directory and ignores `TMPDIR`, so
 * it cannot be redirected — the narrow form was attempted first and failed. The allowance is only
 * safe because ACP no longer allocates there: packet roots and verification scratch moved to
 * `acpScratchDir`, which `scratch-root.test.ts` keeps outside this tree.
 *
 * These assert the kernel, not the profile text. A test that grepped for the allow line would
 * pass with the deny above it deleted.
 */
describe("the reviewer may write to the per-user temp directory and nowhere new (#489)", () => {
  const home = tempDir("reviewer-home-3");
  const packetRoot = tempDir("reviewer-packet-3");

  const writeUnderSandbox = (target: string) =>
    spawnSync(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        buildProfile(home, packetRoot),
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(target)}, "x")`,
      ],
      { encoding: "utf8", env: { ...process.env, HOME: home } },
    );

  it("permits a write into the per-user temp directory", () => {
    // Removing the allowance turns this red, and codex stops initialising for the same reason:
    // the app-server's first write is the one this covers.
    const result = writeUnderSandbox(join(realpathSync(tmpdir()), `acp-489-${process.pid}.tmp`));
    expect(result.status, `sandbox-exec refused the per-user temp write: ${result.stderr}`).toBe(0);
  });

  it("still refuses a write into daemon state", () => {
    // What the profile actually protects, and what the no-tools probe now targets for the same
    // reason: the packet's sibling directory was only ever incidentally refused.
    const result = writeUnderSandbox(
      join(realpathSync(homedir()), ".agent-control-plane", `acp-489-escape-${process.pid}.txt`),
    );
    expect(result.status, "the reviewer wrote into daemon state").not.toBe(0);
  });

  it("does not open the sibling per-user cache directory", () => {
    // `…/C` was measured as unnecessary. Opening the `<hash>` parent would have covered both,
    // which is why the parent was not used.
    const cache = join(dirname(realpathSync(tmpdir())), "C");
    const result = writeUnderSandbox(join(cache, `acp-489-${process.pid}.tmp`));
    expect(result.status, "the reviewer wrote into the per-user cache directory").not.toBe(0);
  });
});
