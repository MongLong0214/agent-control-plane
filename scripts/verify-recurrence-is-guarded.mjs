#!/usr/bin/env node
/**
 * A class this repository has met twice must be refused by something that runs.
 *
 * `src/quality/recurring-defects.ts` holds the classes and the places they were met. This reads
 * that list and fails on the one state the design exists to make loud: **recurred, and nothing
 * guards it**. A backlog entry, a commit trailer and a memory note are all prose, and prose is
 * consulted by whoever remembers to consult it — measured on 2026-09-15, one class was met four
 * times while its record existed and had been read each time.
 *
 * The `guard` field is never taken at its word. Naming a guard is the cheapest thing an entry can
 * do and the easiest to get wrong, so each one is resolved against something that actually exists:
 *
 *   package script     `pnpm <name>` present in package.json
 *   hook               an executable file under .githooks/
 *   falsifiability row a `what:` in scripts/verify-guards-are-falsifiable.mjs
 *
 * An entry naming a guard none of those can find fails exactly like an unguarded one. That is the
 * shape this file is most about: an exemption that names something nobody can run reads as a
 * decision, and the next person removes the producer rather than the entry.
 *
 * What this does not check: that the guard actually refuses the class. A name resolving is not a
 * guard working — `verify-guards-are-falsifiable.mjs` is what asks whether a guard can fail, and
 * it asks about mutations rather than about classes. This answers the prior question, which is
 * whether anything at all stands where a note used to.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Read out of the module rather than duplicated: a second copy of the list goes stale silently. */
const source = readFileSync(join(root, "src/quality/recurring-defects.ts"), "utf8");

const entries = [];
for (const block of source.split(/\n  \{\n/).slice(1)) {
  const id = /id: "([^"]+)"/.exec(block)?.[1];
  if (!id) continue;
  const guard = /guard: (?:"([^"]*)"|null)/.exec(block);
  entries.push({
    id,
    guard: guard === null ? undefined : (guard[1] ?? null),
    wheres: [...block.matchAll(/where:\s*\n?\s*"([^"]+)"/g)].map((match) => match[1]),
  });
}

const packageScripts = new Set(
  Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {}),
);
const falsifiabilityRows = readFileSync(join(root, "scripts/verify-guards-are-falsifiable.mjs"), "utf8");

const executable = (path) => {
  try {
    return (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

/** Resolved against the world, never against the entry's own claim. */
const guardExists = (guard) => {
  if (packageScripts.has(guard)) return `package script \`pnpm ${guard}\``;
  const hookPath = join(root, guard);
  if (guard.startsWith(".githooks/") && existsSync(hookPath) && executable(hookPath)) {
    return `executable hook ${guard}`;
  }
  if (falsifiabilityRows.includes(`what: "${guard}"`)) return "falsifiability row";
  return null;
};

const findings = [];
let guarded = 0;
let observedOnce = 0;

for (const entry of entries) {
  const independent = new Set(entry.wheres).size;
  if (entry.guard === null || entry.guard === undefined || entry.guard.trim().length === 0) {
    if (independent >= 2) {
      findings.push(
        `  ${entry.id}: met on ${independent} distinct surfaces and nothing guards it.\n` +
          `    Build the guard in the same change, then name it in \`guard\`. A note is not a guard.`,
      );
    } else {
      observedOnce += 1;
    }
    continue;
  }
  const resolved = guardExists(entry.guard);
  if (resolved === null) {
    findings.push(
      `  ${entry.id}: names guard \`${entry.guard}\`, which is not a package script, an executable\n` +
        `    hook under .githooks/, or a falsifiability row. A guard nobody can run is not a guard.`,
    );
    continue;
  }
  guarded += 1;
  process.stdout.write(`  ${entry.id}  ->  ${resolved}\n`);
}

process.stdout.write(
  `verify-recurrence-is-guarded: ${entries.length} class(es); ${guarded} guarded, ` +
    `${observedOnce} seen once, ${findings.length} unresolved.\n`,
);
if (findings.length > 0) {
  process.stdout.write(`${findings.join("\n")}\n`);
  process.stdout.write("RESULT: FAIL — a class met twice is guarded by code or it is not handled.\n");
  process.exitCode = 1;
} else {
  process.stdout.write(
    "RESULT: PASS — every recurred class names a guard that exists.\n" +
      "A name resolving is not a guard working: what it refuses is the falsifiability sweep's question.\n",
  );
}
