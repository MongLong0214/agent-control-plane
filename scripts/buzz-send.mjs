#!/usr/bin/env node
/**
 * The one way a human or an agent shell sends a Buzz message (#760).
 *
 * The daemon's own path enforces the convention in `BuzzCliTransport`. This is the same three
 * rules for the path that does not go through the daemon, because a rule that holds on one of
 * two paths makes the other path the way around it.
 *
 *   1. A recipient is required, and it is passed as an explicit `--mention` pubkey. A `@name`
 *      typed in the body is not a recipient: the CLI's own help says an explicit identity
 *      makes unresolved `@Name` text presentation-only, so a body can read as addressed while
 *      notifying nobody. The relay's `mention_pubkeys` is checked afterwards, because being
 *      accepted and having reached someone are two different facts.
 *   2. The body comes from stdin. There is no argument that takes it — a body passed through
 *      argv is subject to the shell that built it, and a backtick eaten by zsh still produces
 *      exit 0 and an accepted event, so that failure has no form the sender can see.
 *   3. `BUZZ_PRIVATE_KEY` must be set explicitly. Calling the CLI without one lets it fall
 *      back to a configured identity — which has signed messages as the CEO that were not the
 *      CEO's — and the fallback's warning is gated on a TTY, so an agent shell never sees it.
 *
 * Usage:
 *   node scripts/buzz-send.mjs --channel <id> --to <pubkey> [--to <pubkey>…] \
 *     [--reply-to <event-id>] [--binary <path>] < body.md
 *
 * Exit codes: 0 sent and every recipient resolved; 1 refused or failed. Errors go to stderr
 * naming what was missing, because "failed" without the missing piece is what makes an
 * operator guess.
 */
import { spawn } from "node:child_process";

/** Reads repeated `--flag value` pairs; a flag with no value is an error, not an empty string. */
const readArgs = (argv) => {
  const out = { channel: null, to: [], replyTo: null, binary: "buzz" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    const needsValue = () => {
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} needs a value`);
      }
      i += 1;
      return value;
    };
    if (flag === "--channel") out.channel = needsValue();
    else if (flag === "--to") out.to.push(needsValue());
    else if (flag === "--reply-to") out.replyTo = needsValue();
    else if (flag === "--binary") out.binary = needsValue();
    else throw new Error(`unknown argument: ${flag}`);
  }
  return out;
};

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const fail = (message) => {
  process.stderr.write(`buzz-send: ${message}\n`);
  process.exit(1);
};

const main = async () => {
  let args;
  try {
    args = readArgs(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
    return;
  }

  const recipients = [...new Set(args.to.map((v) => v.trim()).filter((v) => v.length > 0))];
  if (!args.channel) fail("--channel is required");
  if (recipients.length === 0) {
    fail(
      "--to <pubkey> is required: a message that names no recipient notifies nobody, however " +
        "it reads. An @name in the body does not count — pass the pubkey.",
    );
  }
  if (!process.env["BUZZ_PRIVATE_KEY"]) {
    fail(
      "BUZZ_PRIVATE_KEY is not set. Refusing rather than letting the CLI fall back to a " +
        "configured identity: that fallback has signed messages as the CEO that were not the " +
        "CEO's, and its warning is gated on a TTY an agent shell does not have.",
    );
  }

  const body = await readStdin();
  if (body.length === 0) fail("the message body is empty; it is read from stdin");

  const argv = [
    "messages",
    "send",
    "--channel",
    args.channel,
    "--content",
    "-",
    ...recipients.flatMap((pubkey) => ["--mention", pubkey]),
    ...(args.replyTo ? ["--reply-to", args.replyTo] : []),
  ];

  const { code, stdout, stderr } = await new Promise((resolve, reject) => {
    const child = spawn(args.binary, argv, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c.toString("utf8")));
    child.stderr.on("data", (c) => (err += c.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout: out, stderr: err }));
    child.stdin.end(body, "utf8");
  }).catch((error) => ({ code: 1, stdout: "", stderr: String(error.message ?? error) }));

  if (code !== 0) fail(`send failed (exit ${code})${stderr ? `: ${stderr.trim()}` : ""}`);

  let receipt;
  try {
    receipt = JSON.parse(stdout);
  } catch {
    fail(`send returned unparseable output: ${stdout.trim().slice(0, 200)}`);
    return;
  }
  const resolved = Array.isArray(receipt?.mention_pubkeys) ? receipt.mention_pubkeys : null;
  if (resolved === null) {
    fail("send did not report mention_pubkeys, so who was notified is unknown");
    return;
  }
  const unresolved = recipients.filter((pubkey) => !resolved.includes(pubkey));
  if (unresolved.length > 0) {
    fail(
      `the relay accepted the event but did not resolve ${unresolved.length} recipient(s): ` +
        `${unresolved.join(", ")} (resolved: ${resolved.join(", ") || "none"})`,
    );
  }

  process.stdout.write(
    `${JSON.stringify({ eventId: receipt.event_id ?? null, mentionPubkeys: resolved })}\n`,
  );
};

await main();
