import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BuzzCliTransport } from "../../src/buzz/buzz-adapter.ts";

/**
 * #423 — the adapter is pinned against the surface the *installed* CLI exposes.
 *
 * The defect this file exists to prevent was invisible to every other test in the suite,
 * because those replace the transport with `InMemoryBuzzTransport`. A double agrees with
 * whatever the adapter believes. So the stub CLI below does the opposite: it is written
 * from `buzz --help` and **refuses** any argv the real CLI refuses, and it answers with
 * payloads captured from the live relay (`tests/fixtures/buzz-cli/`) rather than invented
 * ones. Passing here means the argv and the field names are the CLI's, not ours.
 */

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "buzz-cli");
const channelsList = readFileSync(join(FIXTURES, "channels-list.json"), "utf8");
const channelsGet = readFileSync(join(FIXTURES, "channels-get.json"), "utf8");
const messagesGet = readFileSync(join(FIXTURES, "messages-get.json"), "utf8");

/** The identities in the captured payload, so the assertions below quote the real relay. */
const LIVE = JSON.parse(channelsList) as Array<{ channel_id: string; name: string }>;
const ceo = LIVE.find((c) => c.name === "ceo")!;
const commitlore = LIVE.find((c) => c.name === "commitlore")!;
const GET_CHANNEL = (JSON.parse(channelsGet) as { channel_id: string }).channel_id;

interface Stub {
  binary: string;
  /** Every argv the transport invoked, in order. */
  calls(): string[][];
}

/**
 * A stand-in for the installed CLI that enforces its grammar:
 *
 *   - `channels list` accepts only `--visibility`, `--member`, `--limit`. `--json` is a
 *     hard error, exactly as the installed CLI reports it.
 *   - `channels get` requires `--channel`.
 *   - `messages get` requires `--channel`; there is no `messages list`.
 *   - `messages send` requires `--channel` and `--content`.
 *
 * Anything else exits non-zero with the CLI's JSON-on-stderr error form.
 */
const stubCli = (root: string): Stub => {
  const log = join(root, "argv.log");
  const binary = join(root, "buzz");
  writeFileSync(log, "", "utf8");
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");

const die = (message) => {
  process.stderr.write(JSON.stringify({ error: "user_error", message, retryable: false }));
  process.exit(1);
};
const flag = (name) => {
  const i = argv.indexOf(name);
  return i < 0 ? null : argv[i + 1] ?? null;
};
const rest = argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a);

if (argv[0] === "channels" && argv[1] === "list") {
  for (const f of rest) {
    if (!["--visibility", "--member", "--limit"].includes(f)) {
      die("error: unexpected argument '" + f + "' found\\n\\nUsage: buzz channels list [OPTIONS]");
    }
  }
  process.stdout.write(${JSON.stringify(channelsList)});
  process.exit(0);
}
if (argv[0] === "channels" && argv[1] === "get") {
  const requested = flag("--channel");
  if (!requested) die("error: the following required arguments were not provided:\\n  --channel <CHANNEL>");
  // The relay answers about the channel it was asked about. A stub that always returned the
  // same fixture would make the adapter's identity check unreachable.
  const known = JSON.parse(${JSON.stringify(channelsList)}).find((c) => c.channel_id === requested);
  const detail = JSON.parse(${JSON.stringify(channelsGet)});
  if (process.env.ACP_STUB_GET_REDIRECTS_TO) {
    process.stdout.write(JSON.stringify({ ...detail, channel_id: process.env.ACP_STUB_GET_REDIRECTS_TO }));
    process.exit(0);
  }
  if (!known && requested !== detail.channel_id) {
    die("error: channel not found: " + requested);
  }
  process.stdout.write(JSON.stringify({ ...detail, channel_id: requested }));
  process.exit(0);
}
if (argv[0] === "messages" && argv[1] === "get") {
  if (!flag("--channel")) die("error: the following required arguments were not provided:\\n  --channel <CHANNEL>");
  process.stdout.write(${JSON.stringify(messagesGet)});
  process.exit(0);
}
if (argv[0] === "messages" && argv[1] === "send") {
  if (!flag("--channel") || !flag("--content")) {
    die("error: the following required arguments were not provided:\\n  --channel <CHANNEL>\\n  --content <CONTENT>");
  }
  process.exit(0);
}
die("error: unrecognized subcommand '" + argv.join(" ") + "'");
`,
    "utf8",
  );
  chmodSync(binary, 0o755);
  return {
    binary,
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as string[]),
  };
};

describe("#423 BuzzCliTransport against the installed CLI surface", () => {
  let root: string;
  let stub: Stub;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "acp-buzz-surface-"));
    mkdirSync(root, { recursive: true });
    stub = stubCli(root);
    process.env["BUZZ_PRIVATE_KEY"] = "relay-credential-placeholder-not-a-key";
  });

  afterEach(() => {
    delete process.env["BUZZ_PRIVATE_KEY"];
  });

  it("lists channels without --json, which the CLI rejects", async () => {
    const channel = await new BuzzCliTransport(stub.binary).openChannel("cto:commitlore");

    expect(stub.calls()).toContainEqual(["channels", "list"]);
    expect(stub.calls().flat()).not.toContain("--json");
    expect(channel).toBe(commitlore.channel_id);
  });

  it("reads the channel identity from channel_id, the field the relay actually sends", async () => {
    // The captured payload has no `id` at all: reading one yields undefined, and an
    // undefined channel is what reached `messages send --channel` before this fix.
    const raw = JSON.parse(channelsList) as Array<Record<string, unknown>>;
    expect(raw[0]).not.toHaveProperty("id");
    expect(raw[0]).toHaveProperty("channel_id");

    const channel = await new BuzzCliTransport(stub.binary).openChannel("ceo");
    expect(channel).toBe(ceo.channel_id);
    expect(channel).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("matches a purpose segment, never a substring of one", async () => {
    const transport = new BuzzCliTransport(stub.binary);

    // `commitlore-alignment` contains the channel name `commitlore`. Substring matching
    // delivered there; segment matching refuses, because that room is not this purpose's.
    await expect(transport.openChannel("cto:commitlore-alignment")).rejects.toThrow(
      /no buzz channel matches purpose/,
    );
    await expect(transport.openChannel("cto:commitlore")).resolves.toBe(commitlore.channel_id);
  });

  it("refuses an unmatched purpose instead of falling back to the first channel", async () => {
    await expect(
      new BuzzCliTransport(stub.binary).openChannel("cto:no-such-project"),
    ).rejects.toThrow(/no buzz channel matches purpose cto:no-such-project/);

    // The old fallback returned `channels[0]` — here, the owner's direct room.
    expect(LIVE[0]!.name).toBe("ceo");
  });

  it("refuses a production-shaped purpose and says how to bind a channel", async () => {
    // `cto-lifecycle.ts:852` builds `${purpose}:${projectId}`, so a real purpose carries an
    // opaque id no room is named after. Under substring matching this fell through to
    // `channels[0]`; it must now refuse, and the refusal must name the remedy.
    await expect(
      new BuzzCliTransport(stub.binary).openChannel("cto:prj_fixture"),
    ).rejects.toThrow(/ACP_BUZZ_CHANNEL/);

    // Which is the path a deployment actually takes.
    await expect(
      new BuzzCliTransport(stub.binary, GET_CHANNEL).openChannel("cto:prj_fixture"),
    ).resolves.toBe(GET_CHANNEL);
  });

  it("verifies a configured default channel exists rather than returning it unchecked", async () => {
    const transport = new BuzzCliTransport(stub.binary, GET_CHANNEL);
    await expect(transport.openChannel("any:purpose")).resolves.toBe(GET_CHANNEL);
    expect(stub.calls()).toContainEqual(["channels", "get", "--channel", GET_CHANNEL]);
  });

  it("available() answers for the purpose it is given, with a real relay call", async () => {
    const transport = new BuzzCliTransport(stub.binary);
    await expect(transport.available("cto:commitlore")).resolves.toBe(true);

    const argv = stub.calls();
    expect(argv).toContainEqual(["channels", "list"]);
    expect(argv.some((c) => c[0] === "--help")).toBe(false);
  });

  it("available() is false for a purpose that cannot open a channel", async () => {
    // The #423 shape, restated: the relay is reachable and full of rooms, and the daemon
    // still cannot open one for `primary-cto:prj_7`. Reporting healthy here is what makes
    // the failure surface at dispatch instead of at startup.
    const transport = new BuzzCliTransport(stub.binary);
    await expect(transport.available("primary-cto:prj_7")).resolves.toBe(false);
    await expect(transport.openChannel("primary-cto:prj_7")).rejects.toThrow(/no buzz channel/);
  });

  it("available() with no purpose and no bound channel claims nothing", async () => {
    await expect(new BuzzCliTransport(stub.binary).available()).resolves.toBe(false);
    // With a channel bound it can answer, because that is the channel it would open.
    await expect(new BuzzCliTransport(stub.binary, GET_CHANNEL).available()).resolves.toBe(true);
  });

  it("never matches a role prefix against a room of the same name", async () => {
    // A relay whose members talk about their agents may well have a room called
    // `primary-cto`. Matching any segment would route every project's envelopes into it.
    const withRolePrefixRoom = [...LIVE, { channel_id: "11111111-2222-3333-4444-555555555555", name: "primary-cto" }];
    const alt = mkdtempSync(join(tmpdir(), "acp-buzz-prefix-"));
    const binary = join(alt, "buzz");
    writeFileSync(
      binary,
      `#!/usr/bin/env node\nconst a = process.argv.slice(2);\nif (a[0] === "channels" && a[1] === "list") { process.stdout.write(${JSON.stringify(JSON.stringify(withRolePrefixRoom))}); process.exit(0); }\nprocess.exit(1);\n`,
      "utf8",
    );
    chmodSync(binary, 0o755);

    await expect(new BuzzCliTransport(binary).openChannel("primary-cto:prj_7")).rejects.toThrow(
      /no buzz channel matches purpose/,
    );
    // The subject still resolves when a room really is named for it.
    await expect(new BuzzCliTransport(binary).openChannel("primary-cto:commitlore"))
      .resolves.toBe(commitlore.channel_id);
  });

  it("refuses a name match whose row carries no channel_id", async () => {
    // The pre-#423 field name, on a row that still matches by name. Casting the parse result
    // made this `undefined`, which `available()` reported as usable and delivery then sent
    // to — the original defect with the new field name missing instead of the old one.
    const alt = mkdtempSync(join(tmpdir(), "acp-buzz-noid-"));
    const binary = join(alt, "buzz");
    const rows = JSON.stringify([{ name: "ceo", id: ceo.channel_id }]);
    writeFileSync(
      binary,
      `#!/usr/bin/env node\nconst a = process.argv.slice(2);\nif (a[0] === "channels" && a[1] === "list") { process.stdout.write(${JSON.stringify(rows)}); process.exit(0); }\nprocess.exit(1);\n`,
      "utf8",
    );
    chmodSync(binary, 0o755);

    const transport = new BuzzCliTransport(binary);
    await expect(transport.openChannel("ceo")).rejects.toThrow(/without a channel_id/);
    // And the transport must not call itself usable for that purpose.
    await expect(transport.available("ceo")).resolves.toBe(false);
  });

  it("refuses a bound channel the relay answers about with a different identity", async () => {
    // `channels get --channel X` returning some other room must not silently redirect every
    // envelope this daemon sends.
    process.env["ACP_STUB_GET_REDIRECTS_TO"] = ceo.channel_id;
    try {
      const transport = new BuzzCliTransport(stub.binary, GET_CHANNEL);
      await expect(transport.openChannel("any:purpose")).rejects.toThrow(
        new RegExp(`buzz channel ${GET_CHANNEL} resolved to ${ceo.channel_id}`),
      );
      await expect(transport.available()).resolves.toBe(false);
    } finally {
      delete process.env["ACP_STUB_GET_REDIRECTS_TO"];
    }
  });

  it("available() is false when the relay call fails, even though --help would succeed", async () => {
    // A binary that answers --help and nothing else is precisely the state that reported
    // healthy and then failed at the first dispatch.
    const helpOnly = join(root, "buzz-help-only");
    writeFileSync(
      helpOnly,
      `#!/bin/sh\nif [ "$1" = "--help" ]; then echo usage; exit 0; fi\necho '{"error":"relay_error"}' >&2; exit 2\n`,
      "utf8",
    );
    chmodSync(helpOnly, 0o755);

    await expect(new BuzzCliTransport(helpOnly).available("cto:commitlore")).resolves.toBe(false);
  });

  it("available() is false without a credential and makes no relay call", async () => {
    delete process.env["BUZZ_PRIVATE_KEY"];
    await expect(new BuzzCliTransport(stub.binary).available("cto:commitlore")).resolves.toBe(false);
    expect(stub.calls()).toHaveLength(0);
  });

  it("reads messages back with `messages get`, the only read subcommand there is", async () => {
    const messages = await new BuzzCliTransport(stub.binary).readBack(ceo.channel_id, 2);

    expect(stub.calls()).toContainEqual([
      "messages",
      "get",
      "--channel",
      ceo.channel_id,
      "--limit",
      "2",
    ]);
    expect(stub.calls().flat()).not.toContain("list");
    expect(messages[0]).toHaveProperty("id");
    expect(messages[0]).toHaveProperty("pubkey");
  });

  /** #674 — the buzz mention watch's read side; same subcommand, one more declared option. */
  it("reads messages since a point in time with `messages get --since`", async () => {
    const messages = await new BuzzCliTransport(stub.binary).messagesSince(ceo.channel_id, 1786255000, 200);

    expect(stub.calls()).toContainEqual([
      "messages",
      "get",
      "--channel",
      ceo.channel_id,
      "--since",
      "1786255000",
      "--limit",
      "200",
    ]);
    expect(messages[0]).toHaveProperty("id");
    expect(messages[0]).toHaveProperty("created_at");
  });

  it("sends with the argv the CLI accepts and refuses unparseable output", async () => {
    await new BuzzCliTransport(stub.binary).send(ceo.channel_id, "body");
    expect(stub.calls()).toContainEqual([
      "messages",
      "send",
      "--channel",
      ceo.channel_id,
      "--content",
      "-",
    ]);

    // A zero exit whose stdout is not JSON must raise, not read as an empty channel list.
    const garbage = join(root, "buzz-garbage");
    writeFileSync(garbage, `#!/bin/sh\necho 'not json'\nexit 0\n`, "utf8");
    chmodSync(garbage, 0o755);
    await expect(new BuzzCliTransport(garbage).openChannel("ceo")).rejects.toThrow(
      /unparseable output/,
    );
  });
});
