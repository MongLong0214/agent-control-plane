#!/usr/bin/env node
/**
 * Checks every buzz CLI invocation this repository makes against the installed CLI (#520).
 *
 * The CLI has no `--version` and no version subcommand, so a contract mismatch cannot be caught
 * at startup — it surfaces as an argument-parse error inside whatever operation was running.
 * #423 was exactly that: the adapter and the CLI disagreed, and nothing said so until a call.
 *
 * Argument parsing happens before authentication, so this needs no credentials and makes no
 * network calls. `--help` is read; nothing is invoked for effect.
 *
 * ## Written against the three ways these checks have shipped broken
 *
 * `docs/CONTRIBUTING.md` records them. Each is designed out here rather than hoped away:
 *
 *   **A check that never runs.** This one is honest about it: CI runners have no buzz CLI, so
 *   `ci.yml` does **not** run this. Wiring it there would fail every build; making it skip when
 *   the CLI is absent would be the third failure below. So it is `pnpm buzz:contract`, run on a
 *   host that has the CLI — before a release, and after any CLI upgrade. That is a weaker
 *   guarantee than a CI gate and is stated rather than disguised.
 *
 *   **A proxy reported as the measure.** It does not grep sources for flag spellings. It calls
 *   the exported builders in `BUZZ_CLI_INVOCATIONS`, so it sees the argv the adapter actually
 *   passes, and it parses the CLI's own `--help` rather than a list of options someone typed.
 *
 *   **Skipping what it cannot read.** If buzz is absent, or a subcommand's help cannot be
 *   parsed, that is reported and exits non-zero. A contract check that returns success because
 *   it could not look is the failure it exists to catch.
 *
 * Written in TypeScript rather than plain JS because it imports the adapter's own invocation
 * table. A copy of that table here would be a second source of truth and would drift — the exact
 * proxy failure this check is written against.
 */
import { execFileSync } from "node:child_process";

import { BUZZ_CLI_INVOCATIONS } from "../src/buzz/buzz-adapter.ts";

const binary = process.env["ACP_BUZZ_BINARY"] ?? "buzz";

/** Sample arguments. Values are irrelevant to parsing; only their shape reaches the CLI. */
const INVOCATIONS = [
  { name: "channelsList", argv: BUZZ_CLI_INVOCATIONS.channelsList() },
  { name: "channelsGet", argv: BUZZ_CLI_INVOCATIONS.channelsGet("00000000-0000-0000-0000-000000000000") },
  { name: "messagesGet", argv: BUZZ_CLI_INVOCATIONS.messagesGet("00000000-0000-0000-0000-000000000000", 10) },
  { name: "messagesSend", argv: BUZZ_CLI_INVOCATIONS.messagesSend("00000000-0000-0000-0000-000000000000") },
];

const helpFor = (argv: readonly string[]): string => {
  // `<group> <command> --help` prints that command's options. Failure here is a real answer,
  // not a reason to skip: it means the subcommand path itself is wrong.
  const [group, command] = argv;
  return execFileSync(binary, [group, command, "--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
};

/** Long options the invocation passes, e.g. `--channel`. */
const optionsUsed = (argv: readonly string[]): string[] => argv.filter((token) => token.startsWith("--"));

/** Long options the CLI declares for that subcommand, read from its own help text. */
const optionsDeclared = (help: string): Set<string> => {
  const declared = new Set<string>();
  for (const match of help.matchAll(/^\s+(?:-\w,\s+)?(--[a-z][a-z0-9-]*)/gim)) declared.add(match[1]);
  return declared;
};

let available = true;
try {
  execFileSync(binary, ["--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
} catch {
  available = false;
}

if (!available) {
  console.error(
    `verify-buzz-cli-contract: the buzz CLI (${binary}) is not runnable here, so no invocation ` +
      "could be checked.\n" +
      "This exits non-zero on purpose. The whole point of the check is that a contract mismatch " +
      "is invisible until call time, and reporting success without looking would reproduce that " +
      "exact failure. Set ACP_BUZZ_BINARY, or skip this step deliberately in an environment that " +
      "has no CLI.",
  );
  process.exit(1);
}

const failures: string[] = [];
for (const { name, argv } of INVOCATIONS) {
  let help: string;
  try {
    help = helpFor(argv);
  } catch (error) {
    const failure = error as { stderr?: Buffer; message?: string };
    const detail = failure.stderr?.toString().trim() || failure.message || String(error);
    failures.push(`${name}: \`${argv[0]} ${argv[1]}\` is not a subcommand the CLI accepts — ${detail}`);
    continue;
  }
  const declared = optionsDeclared(help);
  if (declared.size === 0) {
    failures.push(`${name}: could not read any options from \`${argv[0]} ${argv[1]} --help\``);
    continue;
  }
  for (const option of optionsUsed(argv)) {
    if (!declared.has(option)) {
      failures.push(
        `${name}: passes ${option}, which \`${argv[0]} ${argv[1]}\` does not declare ` +
          `(declares ${[...declared].sort().join(", ")})`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`verify-buzz-cli-contract: ${failures.length} mismatch(es) against the installed CLI\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    "\nThe CLI has no version to pin, so this is the only place drift can be caught before a " +
      "live call. #423 was this failure reaching production.",
  );
  process.exit(1);
}

console.log(
  `verify-buzz-cli-contract: ${INVOCATIONS.length} invocations checked against ${binary}, ` +
    "every option declared by the subcommand it is passed to",
);
