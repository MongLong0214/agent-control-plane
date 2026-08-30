#!/usr/bin/env node
/**
 * #705 — `verify-reason-codes.mjs` was correct and reachable from nowhere: not a `pnpm`
 * script, not a CI step, not called by any other script. It had been reporting a real
 * defect into an empty room for as long as that defect existed. This check is what makes
 * that shape recur loudly instead of quietly: every file directly under `scripts/` must be
 * named — as a `pnpm` script in `package.json`, or in an actually-executed `run:` step of a
 * workflow under `.github/workflows/` — or it must be named in EXEMPT below, with a reason.
 *
 * `scripts/lib/` is out of scope by construction, not by exemption: this only reads the
 * direct children of `scripts/`, so a shared module imported by other scripts (not meant to
 * be invoked on its own) is never a candidate in the first place — the same way `src/`
 * helper modules are never asked to justify not being a CLI entry point.
 *
 * What "named" means here, narrowed after #709's review found the first cut too wide: a
 * plain substring search over an entire workflow file, or over every `package.json` field,
 * treats a YAML comment and a shell `echo scripts/x.mjs` the same as a real invocation — a
 * mention counted as a caller. Neither is one. So this only searches:
 *
 *   - the actual command text of `run:` steps in `.github/workflows/*.yml` (single-line and
 *     block-scalar `run: |` alike), with bash-style `#...` comments stripped first, and
 *   - the command strings under `package.json`'s `scripts`,
 *
 * and within that text, a mention counts only when it sits in a position that would
 * actually execute it: the first word of its shell segment (split on `&&`, `||`, `;`, `|`,
 * and newlines) is a known interpreter (`node`, `npx`, `tsx`, `sh`, `bash`, `python`,
 * `python3`) with the script named after it, or the segment's first word *is* the script
 * itself (a direct, executable invocation). `echo scripts/x.mjs`, a bare mention in a
 * comment, or the filename appearing only as an argument to something that does not run it
 * (`cat`, `grep`, a commit message) does not count. `tests/process/every-script-has-a-
 * caller.test.ts` proves both directions: a comment-only mention and a dead `echo` mention
 * are rejected, and a genuine invocation still passes.
 *
 * A second narrowing: a script named only inside a `package.json` command is wired, but
 * whether *that* `pnpm` entry itself ever runs in CI is a separate question this check
 * answers as far as it can and no further. It marks an entry `ciConfirmed` when a workflow
 * `run:` step actually invokes it (`pnpm <name>`, `pnpm run <name>`, or `npm run <name>`),
 * propagated one further step through any `package.json` script that itself invokes another
 * by name. Anything short of that — a step gated behind a dynamic `if:`, a reusable workflow
 * call, a name assembled at runtime from a shell variable — is not something a dependency-
 * free text scan can decide, so it is not claimed: those entries print as "package.json
 * entry only, CI-reachability not confirmed" rather than being asserted as run. A `pnpm`
 * script that only a human ever types by hand is still a caller in the sense #705's closing
 * conditions asked for ("`package.json` **or** `ci.yml` reaches it") — this just stops
 * saying more than that about it.
 *
 * EXEMPT is keyed by filename, not by file:line — a line number goes stale the moment
 * something above it grows, which is the exact failure this repository has already shipped
 * once (`scripts/verify-tx-denial-sites.mjs`'s own EXEMPT, before it was widened). An
 * exemption list nothing consults is the same defect one level up: the mutation proof in
 * `tests/process/every-script-has-a-caller.test.ts` requires that removing a script's only
 * caller fails this check, and that naming it in EXEMPT — with a reason — is what suppresses
 * that failure. Neither direction is assumed. Nor is a blank reason: an EXEMPT entry whose
 * reason is empty or whitespace records nothing a reviewer could later check, so it fails
 * the same way a stale entry does.
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
 * entry fails the same as a missing wire (see the census below). Every entry must also carry
 * a real, non-empty reason — an exemption nobody could explain if asked is the same trap.
 */
const EXEMPT = {
  // (currently empty — every script under scripts/ has a package.json entry; see #705's
  // report for the reachability of each, including the ones deliberately excluded from CI.)
};

const KNOWN_INTERPRETERS = new Set(["node", "npx", "tsx", "sh", "bash", "python", "python3"]);
const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn"]);

/** Strips a bash-style `#...` comment from one line: from a `#` that starts the line or is
 * preceded by whitespace, to end of line. Does not understand quoting, so a `#` inside a
 * quoted string could in principle be stripped in error — an accepted limit for a
 * dependency-free scan, and not a shape any script name in this repository takes. */
const stripBashComment = (line) => line.replace(/(^|\s)#.*$/, "$1").trimEnd();

const indentOf = (line) => (/^(\s*)/.exec(line) ?? ["", ""])[1].length;

/** Extracts the command text of every `run:` step in a workflow file — single-line
 * (`run: pnpm lint`) and block-scalar (`run: |` followed by more-indented lines) alike —
 * with comments stripped, so downstream matching never sees YAML prose or bash comments as
 * if they were commands. */
const extractRunCommands = (yamlText) => {
  const lines = yamlText.split(/\r?\n/);
  const commands = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = /^(\s*(?:-\s+)?)run:\s*(.*)$/.exec(line);
    if (!match) continue;
    const keyIndent = indentOf(line);
    const rest = match[2].trim();
    if (rest === "" || /^[|>][+-]?\d*$/.test(rest)) {
      // Block scalar: gather every following line indented past this `run:` line.
      const blockLines = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const next = lines[j];
        if (next.trim() === "") {
          blockLines.push("");
          continue;
        }
        if (indentOf(next) <= keyIndent) break;
        blockLines.push(stripBashComment(next));
      }
      commands.push(blockLines.join("\n"));
      i = j - 1;
    } else {
      commands.push(stripBashComment(rest));
    }
  }
  return commands;
};

/** Splits a command block into the shell segments an operator would actually separate at
 * execution time, so each segment can be checked for its own leading word. */
const splitSegments = (commandText) =>
  commandText
    .split(/\r?\n|&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Whether `segment` actually executes `needle` (e.g. `scripts/foo.mjs`) rather than merely
 * mentioning it — the leading word (past any `FOO=bar` env assignments) must be a known
 * interpreter with `needle` following, or `needle` itself must be the thing being run. */
const segmentInvokes = (segment, needle) => {
  if (!segment.includes(needle)) return false;
  const withoutEnv = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, "");
  const words = withoutEnv.split(/\s+/).filter(Boolean);
  const [first] = words;
  if (!first) return false;
  if (KNOWN_INTERPRETERS.has(first)) return words.slice(1).includes(needle);
  // Direct execution: the command *is* the script, optionally with a leading `./`.
  return first === needle || first === `./${needle}`;
};

/** Whether any segment in `commands` executes `needle`. */
const anyCommandInvokes = (commands, needle) =>
  commands.some((command) => splitSegments(command).some((segment) => segmentInvokes(segment, needle)));

const scriptsDir = join(repoRoot, "scripts");
const scriptFiles = readdirSync(scriptsDir)
  .filter((name) => statSync(join(scriptsDir, name)).isFile())
  .filter((name) => /\.(mjs|ts|js|cjs)$/.test(name))
  .sort();

const packageJsonRaw = readFileSync(join(repoRoot, "package.json"), "utf8");
const packageScripts = JSON.parse(packageJsonRaw).scripts ?? {};
const packageScriptEntries = Object.entries(packageScripts);
const packageScriptNames = new Set(Object.keys(packageScripts));

const workflowsDir = join(repoRoot, ".github", "workflows");
const workflowCommandsByFile = readdirSync(workflowsDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => extractRunCommands(readFileSync(join(workflowsDir, name), "utf8")));
const workflowCommands = workflowCommandsByFile.flat();

/** Package.json script names that a workflow `run:` step actually invokes — `pnpm <name>`,
 * `pnpm run <name>`, or `npm run <name>` — found directly, then propagated one further step
 * through any package.json script whose own command invokes another by the same shorthand.
 * Anything short of this (a dynamic `if:`, a reusable workflow call, a name assembled at
 * runtime) is outside what a dependency-free text scan can decide, so it is not claimed. */
const ciInvokedScriptNames = new Set();
for (const command of workflowCommands) {
  for (const segment of splitSegments(command)) {
    const words = segment.split(/\s+/).filter(Boolean);
    if (!PACKAGE_MANAGERS.has(words[0])) continue;
    const candidate = words[1] === "run" ? words[2] : words[1];
    if (candidate && packageScriptNames.has(candidate)) ciInvokedScriptNames.add(candidate);
  }
}
// Propagate one further step: a script not itself found in any workflow `run:` step may
// still be invoked by another package.json script's command (chaining), and that script's
// own runner (a human, or a further CI step) would then reach it transitively. Not the
// shape this repository's package.json uses today, but a script chained this way is
// exactly as reachable as the thing it chains to.
let grew = true;
while (grew) {
  grew = false;
  for (const [name, command] of packageScriptEntries) {
    if (ciInvokedScriptNames.has(name)) continue;
    const invokesReachable = splitSegments(command).some((segment) => {
      const words = segment.split(/\s+/).filter(Boolean);
      if (!PACKAGE_MANAGERS.has(words[0])) return false;
      const candidate = words[1] === "run" ? words[2] : words[1];
      return Boolean(candidate) && ciInvokedScriptNames.has(candidate);
    });
    if (invokesReachable) {
      ciInvokedScriptNames.add(name);
      grew = true;
    }
  }
}

/** Where (if anywhere) a script under `scripts/` is actually invoked. A script can be named
 * in `package.json` *and* run directly from a workflow (`node scripts/x.mjs`, bypassing the
 * `pnpm` entry entirely) — that direct call confirms it regardless of whether anything
 * invokes the `pnpm` shorthand by name, so it is checked independently of which one is
 * reported as the primary `via`. */
const wiredIn = (name) => {
  const needle = `scripts/${name}`;
  const directWorkflowInvocation = anyCommandInvokes(workflowCommands, needle);
  const viaPackageJson = packageScriptEntries.find(([, command]) => anyCommandInvokes([command], needle));
  if (viaPackageJson) {
    const [scriptName] = viaPackageJson;
    return {
      via: "package.json",
      ciConfirmed: directWorkflowInvocation || ciInvokedScriptNames.has(scriptName),
    };
  }
  if (directWorkflowInvocation) {
    return { via: ".github/workflows", ciConfirmed: true };
  }
  return null;
};

const failures = [];
const wired = [];
const exempted = [];

for (const name of scriptFiles) {
  const via = wiredIn(name);
  if (via) {
    wired.push({ name, ...via });
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

// An exemption with no real reason records nothing a reviewer could later check — the same
// "looks like coverage, checks nothing" trap as a stale entry.
const emptyReasonExemptions = Object.entries(EXEMPT)
  .filter(([name]) => scriptFileSet.has(name))
  .filter(([, reason]) => typeof reason !== "string" || reason.trim().length === 0)
  .map(([name]) => name);

const hasFailures = failures.length > 0 || staleExemptions.length > 0 || emptyReasonExemptions.length > 0;

if (asJson) {
  console.log(
    JSON.stringify({ wired, exempted, failures, staleExemptions, emptyReasonExemptions }, null, 2),
  );
} else if (hasFailures) {
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
  if (emptyReasonExemptions.length > 0) {
    console.error(
      `verify-every-script-has-a-caller: ${emptyReasonExemptions.length} EXEMPT entr(y/ies) with no reason`,
    );
    for (const name of emptyReasonExemptions) {
      console.error(`  EXEMPT["${name}"] has an empty reason — state why it is deliberately unreached`);
    }
  }
} else {
  const ciConfirmedCount = wired.filter((w) => w.ciConfirmed).length;
  const packageJsonOnlyCount = wired.length - ciConfirmedCount;
  console.log(
    `verify-every-script-has-a-caller: ${wired.length} script(s) wired ` +
      `(${ciConfirmedCount} confirmed run from a workflow step, ${packageJsonOnlyCount} package.json ` +
      `entry only — CI-reachability not confirmed), ${exempted.length} named exemption(s), 0 orphaned`,
  );
  for (const { name, via, ciConfirmed } of wired) {
    if (!ciConfirmed) console.log(`  package.json entry only, not confirmed CI-reachable: scripts/${name} (via ${via})`);
  }
  for (const { name, reason } of exempted) {
    console.log(`  exempt: scripts/${name} — ${reason}`);
  }
}

process.exit(hasFailures ? 1 : 0);
