#!/usr/bin/env node
/**
 * Verifies that the repository's version statements agree with each other.
 *
 * `package.json` said `1.3.0` from the commit that created it until #516, while every
 * document and the release goal said v1.0.0. Nothing reconciled the two because nothing
 * ever compared them — the number was a scaffold default sitting where people trust a
 * decision, and it survived because no process read it.
 *
 * Two properties, both mechanical:
 *
 *   1. `package.json` version equals the newest version heading in `CHANGELOG.md`.
 *   2. That version is plain semver, so a tag can be derived from it rather than typed.
 *
 * This deliberately does not check tags. Tags are published externally and this check
 * runs on a tree that may not have fetched them; a check that silently passes when it
 * cannot see its subject is worse than no check (CP-HI-08). What it does guarantee is
 * that when someone tags, there is exactly one version to tag with.
 *
 * Dependency-free on purpose, in the shape of `verify-reason-codes.mjs`: verification
 * runs in a disposable worktree with no installed packages and no network (PRD §17.4).
 */
import { readFileSync } from "node:fs";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const fail = (message, detail) => {
  process.stdout.write(`verify-release-version: ${message}\n`);
  if (detail) process.stdout.write(`${detail}\n`);
  process.exit(1);
};

const declared = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
if (typeof declared !== "string" || !SEMVER.test(declared)) {
  fail("package.json version is not plain semver", `  found: ${JSON.stringify(declared)}`);
}

const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
// The newest entry is the first `## <version>` heading. Anything before it is prose.
const headings = [...changelog.matchAll(/^## \[?(\d+\.\d+\.\d+)\]?/gm)].map((match) => match[1]);
if (headings.length === 0) {
  fail("CHANGELOG.md declares no version heading, so package.json has nothing to agree with");
}

const newest = headings[0];
if (newest !== declared) {
  fail(
    "package.json and CHANGELOG.md state different versions",
    `  package.json: ${declared}\n  CHANGELOG.md: ${newest} (newest heading)`,
  );
}

// Descending order matters: the first heading is taken as "newest" above, and that is only
// true if the file is ordered. An unordered changelog would make this check compare against
// an arbitrary entry while still passing.
const compare = (left, right) => {
  const [a, b] = [left.split(".").map(Number), right.split(".").map(Number)];
  for (let position = 0; position < 3; position += 1) {
    if (a[position] !== b[position]) return a[position] - b[position];
  }
  return 0;
};
for (let index = 1; index < headings.length; index += 1) {
  if (compare(headings[index - 1], headings[index]) <= 0) {
    fail(
      "CHANGELOG.md entries are not in descending version order",
      `  ${headings[index - 1]} is listed above ${headings[index]}`,
    );
  }
}

process.stdout.write(
  `verify-release-version: ${declared} — package.json and CHANGELOG.md agree, ${headings.length} release(s) recorded\n`,
);
process.stdout.write("Tags are not checked here; this only guarantees there is one version to tag with.\n");
