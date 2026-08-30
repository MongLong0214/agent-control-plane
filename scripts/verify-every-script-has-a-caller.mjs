#!/usr/bin/env node
/**
 * #705 — `verify-reason-codes.mjs` was correct and reachable from nowhere: not a `pnpm`
 * script, not a CI step, not called by any other script. It had been reporting a real
 * defect into an empty room for as long as that defect existed. This check is what makes
 * that shape recur loudly instead of quietly: every file directly under `scripts/` must be
 * named — as a `pnpm` script in `package.json`, or in a `run:` step of a workflow under
 * `.github/workflows/` — or it must be named in EXEMPT below, with a reason.
 *
 * `scripts/lib/` is out of scope by construction, not by exemption: this only reads the
 * direct children of `scripts/`, so a shared module imported by other scripts (not meant to
 * be invoked on its own) is never a candidate in the first place — the same way `src/`
 * helper modules are never asked to justify not being a CLI entry point.
 *
 * A script counts as reached if its own filename — `scripts/<name>` — appears as a
 * substring of some `pnpm` script's command in `package.json`, or inside a workflow file
 * under `.github/workflows/`. That is deliberately loose: it catches `node scripts/x.mjs`,
 * `npx tsx scripts/x.ts`, and a direct `run: node scripts/x.mjs` step alike, and it does not
 * care whether the invoking workflow step is one CI actually executes on every push — a
 * `pnpm` script that only a human ever types is still a caller, in exactly the sense #705's
 * closing conditions asked for ("`package.json` **or** `ci.yml` reaches it"). It is *not* a
 * check that the wiring runs; see the enumeration in #705's own report for that half.
 *
 * EXEMPT is keyed by filename, not by file:line — a line number goes stale the moment
 * something above it grows, which is the exact failure this repository has already shipped
 * once (`scripts/verify-tx-denial-sites.mjs`'s own EXEMPT, before it was widened). An
 * exemption list nothing consults is the same defect one level up: the mutation proof in
 * `tests/process/every-script-has-a-caller.test.ts` requires that removing a script's only
 * caller fails this check, and that naming it in EXEMPT — with a reason — is what suppresses
 * that failure. Neither direction is assumed.
 *
 * Usage: node scripts/verify-every-script-has-a-caller.mjs [--json]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const asJson = process.argv.includes("--json");

/**
 * Scripts with no caller in `package.json` or `.github/workflows/*.yml`, and the reason
 * each is deliberately left that way rather than wired. Every entry here must name a file
 * that actually exists in `scripts/` — an exemption for a script that was since deleted or
 * renamed is exactly the "nothing consults it" trap this file exists to avoid, so a stale
 * entry fails the same as a missing wire (see the check below the census itself).
 */
const EXEMPT = {
  // (currently empty — every script under scripts/ has a package.json entry; see #705's
  // report for the reachability of each, including the ones deliberately excluded from CI.)
};

const scriptsDir = join(repoRoot, "scripts");
const scriptFiles = readdirSync(scriptsDir)
  .filter((name) => statSync(join(scriptsDir, name)).isFile())
  .filter((name) => /\.(mjs|ts|js|cjs)$/.test(name))
  .sort();

const packageJsonRaw = readFileSync(join(repoRoot, "package.json"), "utf8");
const packageScripts = JSON.parse(packageJsonRaw).scripts ?? {};
const packageJsonHaystack = Object.values(packageScripts).join("\n");

const workflowsDir = join(repoRoot, ".github", "workflows");
const workflowHaystack = readdirSync(workflowsDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => readFileSync(join(workflowsDir, name), "utf8"))
  .join("\n");

const wiredIn = (name) => {
  const needle = `scripts/${name}`;
  if (packageJsonHaystack.includes(needle)) return "package.json";
  if (workflowHaystack.includes(needle)) return ".github/workflows";
  return null;
};

const failures = [];
const wired = [];
const exempted = [];

for (const name of scriptFiles) {
  const via = wiredIn(name);
  if (via) {
    wired.push({ name, via });
    continue;
  }
  if (Object.prototype.hasOwnProperty.call(EXEMPT, name)) {
    exempted.push({ name, reason: EXEMPT[name] });
    continue;
  }
  failures.push(name);
}

// A stale exemption — naming a script no longer in scripts/ — is silently unreachable code
// in the census itself: it looks like coverage and checks nothing. Fail on it the same as a
// missing wire, so EXEMPT cannot accumulate entries nobody can any longer verify.
const scriptFileSet = new Set(scriptFiles);
const staleExemptions = Object.keys(EXEMPT).filter((name) => !scriptFileSet.has(name));

if (asJson) {
  console.log(
    JSON.stringify({ wired, exempted, failures, staleExemptions }, null, 2),
  );
} else if (failures.length > 0 || staleExemptions.length > 0) {
  if (failures.length > 0) {
    console.error(`verify-every-script-has-a-caller: ${failures.length} script(s) with no caller`);
    for (const name of failures) {
      console.error(`  scripts/${name} — not a pnpm script, not named in any .github/workflows/*.yml step`);
    }
    console.error(
      "\nAdd a pnpm script or a workflow step that invokes it, or name it in EXEMPT above with a reason.",
    );
  }
  if (staleExemptions.length > 0) {
    console.error(`verify-every-script-has-a-caller: ${staleExemptions.length} stale EXEMPT entr(y/ies)`);
    for (const name of staleExemptions) {
      console.error(`  EXEMPT["${name}"] names a file that is not in scripts/ — remove the entry`);
    }
  }
} else {
  console.log(
    `verify-every-script-has-a-caller: ${wired.length} script(s) wired, ${exempted.length} named exemption(s), 0 orphaned`,
  );
  for (const { name, reason } of exempted) {
    console.log(`  exempt: scripts/${name} — ${reason}`);
  }
}

process.exit(failures.length > 0 || staleExemptions.length > 0 ? 1 : 0);
