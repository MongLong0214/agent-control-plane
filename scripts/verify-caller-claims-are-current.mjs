#!/usr/bin/env node
/**
 * Prose that says who calls a symbol must still be true.
 *
 * This repository writes long comments about reachability — "nothing in `src/` calls this",
 * "`claim()` has no production caller", "harmless today because the ledger has no writer". Each is
 * a claim about code in some other file, and the change that falsifies it edits neither the
 * comment nor anything a reviewer of that comment would open. So it rots in the one way nobody is
 * positioned to notice.
 *
 * Measured 2026-09-16: `ConversationTurnCoordinator.claim()` gained two production callers
 * (`telegram-polling.ts`, `agentcpd.ts`), and five comments across four files went on saying it had
 * none — including one in `migrations.ts` whose backfill obligation was explicitly conditioned on
 * that state, so the obligation came due silently.
 *
 * `scripts/lib/caller-claims.mjs` holds the searches those comments are making. This runs them.
 *
 * What this does not check: that the prose *around* the search says what the search found. A file
 * can satisfy its entry and still describe the result badly. This answers the prior question —
 * whether the sentence is about a world that still exists.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { CALLER_CLAIMS } from "./lib/caller-claims.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const sourceFiles = (directory) => {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (entry.endsWith(".ts")) found.push(path);
  }
  return found;
};

const files = sourceFiles(join(root, "src"));
const failures = [];

for (const claim of CALLER_CLAIMS) {
  const declaredIn = join(root, claim.declaredIn);
  if (!files.includes(declaredIn)) {
    failures.push(`${claim.id}: declaredIn names no file under src/ — ${claim.declaredIn}`);
    continue;
  }
  // Constructed per claim rather than reused: a shared `g`-flagged regex carries `lastIndex`
  // between tests and would skip lines depending on what the previous claim matched.
  const pattern = new RegExp(claim.pattern);
  const callers = [];
  for (const file of files) {
    if (file === declaredIn) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      if (pattern.test(line)) callers.push(`${relative(root, file)}:${index + 1}`);
    }
  }
  const found = callers.length > 0 ? "some" : "none";
  if (found !== claim.expect) {
    failures.push(
      `${claim.id}: prose says ${claim.expect}, search finds ${found}` +
        (callers.length > 0 ? ` (${callers.join(", ")})` : "") +
        `\n    ${claim.why}`,
    );
  }
}

if (failures.length > 0) {
  process.stderr.write(`caller-claims: ${failures.length} stale claim(s)\n\n`);
  for (const failure of failures) process.stderr.write(`  ${failure}\n\n`);
  process.exit(1);
}

process.stdout.write(
  `caller-claims: ${CALLER_CLAIMS.length} claim(s) re-searched against ${files.length} source file(s); ` +
    `each still finds what its prose says.\nRESULT: PASS\n`,
);
