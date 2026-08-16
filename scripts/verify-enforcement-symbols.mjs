#!/usr/bin/env node
/**
 * The enforcement symbols the Buzz-transition gate names must still exist.
 *
 * That gate's three proofs each declare an **enforcement locus** — the production symbol whose
 * behaviour the proof is about. Those loci were originally written as file:line pairs, which rot
 * silently: a line number keeps resolving after the code moves and points at whatever is there
 * now, so the reference looks fine while meaning something else. `docs/CONTRIBUTING.md` records
 * the same lesson from the #443 sweep, where every recorded line number had drifted.
 *
 * Symbols fail differently, and that is the whole reason to prefer them: rename or delete one and
 * the search returns nothing, which is a visible failure rather than a confident wrong answer.
 *
 * This check makes that failure land in CI. The list below mirrors the loci named in the gate
 * decision document, which lives outside this repository — so it is duplicated here deliberately
 * rather than read across, and this file is the copy CI can act on. If a name changes, both move
 * together or this goes red, which is the point.
 *
 * What this does **not** check: that each symbol still enforces what the proof claims. A symbol
 * existing is not a symbol working — the proofs' own RED/GREEN evidence covers that. This only
 * catches the reference rotting away underneath them.
 *
 * Dependency-free, in the shape of the other verify scripts (PRD §17.4).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** Locus symbol → the proof that names it, for a failure message that says why it matters. */
const LOCI = {
  BuzzTransport: "P1 delivery",
  channelsGet: "P1 delivery",
  messagesSend: "P1 delivery",
  configuredBuzzActorIngressPolicy: "P3 identity and allowlist",
  bindBuzzActor: "P3 identity and allowlist",
  assertCurrentCeo: "P3 identity and allowlist",
  finalizeApprovedRun: "P2 full lifecycle",
  postMergeVerify: "P2 full lifecycle",
  dependentMergeBlocked: "P2 full lifecycle",
};

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
  });

const sources = walk(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

const missing = [];
const found = [];
for (const [symbol, proof] of Object.entries(LOCI)) {
  // Word-boundary match: `postMergeVerify` must not be satisfied by `postMergeVerifyThing`.
  const pattern = new RegExp(`\\b${symbol}\\b`);
  const files = sources.filter((source) => pattern.test(source.text));
  if (files.length === 0) missing.push({ symbol, proof });
  else found.push({ symbol, proof, files: files.length });
}

if (missing.length > 0) {
  process.stdout.write(
    `verify-enforcement-symbols: ${missing.length} locus symbol(s) named by the transition gate no longer exist\n`,
  );
  for (const entry of missing) {
    process.stdout.write(`  ${entry.symbol}  (${entry.proof})\n`);
  }
  process.stdout.write(
    "\nA proof whose enforcement locus has vanished cannot be evaluated. Either restore the symbol,\n" +
      "or amend the gate decision and this list together — the two are a pair, and updating only one\n" +
      "is how a locus reference starts pointing at nothing.\n",
  );
  process.exit(1);
}

process.stdout.write(
  `verify-enforcement-symbols: ${found.length} locus symbol(s) present across src/\n`,
);
process.stdout.write("Presence is not enforcement; the proofs' own RED/GREEN evidence covers that.\n");
