import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * #760 — the daemon's send path enforces the Buzz convention in `BuzzCliTransport`, and this
 * covers the other path: the one a human or an agent shell uses.
 *
 * A rule that holds on one of two paths makes the other path the way around it, and the shell
 * path is the one that actually broke. Four sends went out from it in one session; two named
 * nobody, and all four came back `accepted: true`.
 *
 * The stub relay here answers the way the installed CLI does — it resolves each `--mention` it
 * is given and reports what it resolved — so what these cases prove is that the script refuses
 * before ever reaching it, or refuses what it reports back.
 */
const script = fileURLToPath(new URL("../../scripts/buzz-send.mjs", import.meta.url));
const OWNER = "2adaf98f".padEnd(64, "0");
const CHANNEL = "c37e88d0-0000-0000-0000-000000000000";

/** A relay stub that logs argv and answers with the mentions it was asked to resolve. */
const stubRelay = (root: string, declined: readonly string[] = []): { binary: string; log: string } => {
  const log = join(root, "argv.log");
  const binary = join(root, "buzz");
  writeFileSync(log, "", "utf8");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");
const declined = ${JSON.stringify(declined)};
const asked = argv.flatMap((a, i) => (a === "--mention" ? [argv[i + 1]] : []));
process.stdout.write(JSON.stringify({
  accepted: true,
  event_id: "e".repeat(64),
  mention_pubkeys: asked.filter((p) => !declined.includes(p)),
}));
process.exit(0);
`,
    "utf8",
  );
  chmodSync(binary, 0o755);
  return { binary, log };
};

const run = (
  args: readonly string[],
  options: { body?: string; binary: string; key?: string | null },
) =>
  spawnSync(process.execPath, [script, ...args, "--binary", options.binary], {
    input: options.body ?? "hello\n",
    encoding: "utf8",
    env: {
      ...process.env,
      ...(options.key === null
        ? { BUZZ_PRIVATE_KEY: undefined }
        : { BUZZ_PRIVATE_KEY: options.key ?? "relay-credential-placeholder" }),
    } as NodeJS.ProcessEnv,
  });

describe("#760 the shell send path", () => {
  it("refuses a message that names no recipient, and never reaches the relay", () => {
    const root = tempDir("acp-buzz-send-unaddressed-");
    const relay = stubRelay(root);

    const result = run(["--channel", CHANNEL], { binary: relay.binary });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--to");
    // The refusal says what to do, not just that it failed: the fix is a pubkey, and the
    // sender's instinct is to add an @name to the body, which would not have helped.
    expect(result.stderr).toContain("pubkey");
    // Nothing was sent. A refusal after the send would leave the unaddressed message in the
    // room, which is the outcome, not a warning about it.
    expect(spawnSync("cat", [relay.log], { encoding: "utf8" }).stdout).toBe("");
  });

  it("refuses when the identity to sign with was not stated", () => {
    const root = tempDir("acp-buzz-send-nokey-");
    const relay = stubRelay(root);

    const result = run(["--channel", CHANNEL, "--to", OWNER], {
      binary: relay.binary,
      key: null,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("BUZZ_PRIVATE_KEY");
    expect(spawnSync("cat", [relay.log], { encoding: "utf8" }).stdout).toBe("");
  });

  it("fails when the relay accepted the event without resolving the recipient", () => {
    const root = tempDir("acp-buzz-send-unresolved-");
    const relay = stubRelay(root, [OWNER]);

    const result = run(["--channel", CHANNEL, "--to", OWNER], { binary: relay.binary });

    // The stub exits 0 and reports `accepted: true`. That is the exact shape of the sends
    // that went out addressing nobody, and it is not success here.
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did not resolve");
    expect(result.stderr).toContain(OWNER);
  });

  it("sends the body on stdin with an explicit mention, and reports what was resolved", () => {
    const root = tempDir("acp-buzz-send-ok-");
    const relay = stubRelay(root);

    const result = run(["--channel", CHANNEL, "--to", OWNER, "--reply-to", "abc"], {
      binary: relay.binary,
      body: "a body with `backticks` and $VARS that a shell would have eaten\n",
    });

    expect(result.status, result.stderr).toBe(0);
    const argv = JSON.parse(
      spawnSync("cat", [relay.log], { encoding: "utf8" }).stdout.trim(),
    ) as string[];
    expect(argv).toEqual([
      "messages",
      "send",
      "--channel",
      CHANNEL,
      "--content",
      "-",
      "--mention",
      OWNER,
      "--reply-to",
      "abc",
    ]);
    // The body is nowhere in argv — that is rule 3, and it is why the backticks above survive.
    expect(argv.join(" ")).not.toContain("backticks");
    expect(JSON.parse(result.stdout)).toMatchObject({ mentionPubkeys: [OWNER] });
  });

  it("refuses a body-only @name, because the relay may never resolve it", () => {
    const root = tempDir("acp-buzz-send-atname-");
    const relay = stubRelay(root);

    // The body reads as addressed to the CEO. Nothing in it is a recipient, and the CLI's own
    // help is explicit that unresolved `@Name` text is presentation-only. This is the case
    // that made two stop-order acknowledgements notify nobody.
    const result = run(["--channel", CHANNEL], {
      binary: relay.binary,
      body: "@ceo U5_MUTATION_PAUSED\n",
    });

    expect(result.status).not.toBe(0);
    expect(spawnSync("cat", [relay.log], { encoding: "utf8" }).stdout).toBe("");
  });
});
