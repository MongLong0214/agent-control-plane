#!/usr/bin/env node
/**
 * #705 — a correct verification script was never invoked, so the defect it found reported
 * into an empty room. This dependency-free census makes one deliberately static claim:
 *
 * Every regular direct child of scripts/ has at least one statically plausible invocation site,
 * or a named exemption.
 *
 * Plausible sites are command-shaped workflow `run:` text, package.json commands, and recognized
 * child-process-shaped calls in tests selected by a statically recognized full Vitest command.
 * This does not prove that any site executes. In particular, the scan does not determine import
 * origin, `it.skip`, disabled suites such as `describe.runIf(false)`, unreachable branches,
 * dynamic test selection, dynamic shell, runtime-built paths, or unrecognized interpreter
 * options. Every detected test-spawn site is therefore labeled execution-unproven, and every run
 * prints this limit. Measuring which scripts CI actually enters remains dynamic work owned by
 * issue #705; this static census is not its substitute and cannot close that issue by itself.
 *
 * Every regular file directly under `scripts/` is a candidate, including `.sh`, `.py`, and
 * extensionless files. `scripts/lib/` remains out of scope because its files are not direct
 * children. Command matching is about a plausible entrypoint operand, not a filename appearing somewhere
 * after an interpreter: `node --eval 0 scripts/x`, `sh -c true scripts/x`, and
 * `npx echo scripts/x` are not plausible invocation sites.
 *
 * sol-simplify: this exists for #705's silent, user-visible verification gap; remove it when
 * `scripts/` stops being an entrypoint inventory or another caller graph supplies this evidence.
 *
 * Usage: node scripts/verify-every-script-has-a-plausible-caller.mjs [--json]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const asJson = process.argv.includes("--json");

/** Deliberately manual entrypoints may be named here. Stale entries and blank reasons fail. */
const EXEMPT = {
  // (currently empty)
};

const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn"]);
const NODE_NO_ENTRYPOINT = new Set(["-e", "--eval", "-p", "--print", "-c", "--check"]);
const NODE_OPTIONS_WITH_VALUE = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--conditions",
  "--input-type",
  "--inspect-port",
  "--redirect-warnings",
  "--test-name-pattern",
  "--test-reporter",
  "--test-reporter-destination",
]);
const NODE_OPTIONS_WITHOUT_VALUE = new Set([
  "--experimental-transform-types",
  "--no-warnings",
  "--enable-source-maps",
  "--trace-warnings",
  "--use-strict",
]);
const TSX_OPTIONS_WITH_VALUE = new Set(["--tsconfig"]);
const TSX_OPTIONS_WITHOUT_VALUE = new Set(["--no-cache"]);

const stripBashComment = (line) => line.replace(/(^|\s)#.*$/, "$1").trimEnd();
const indentOf = (line) => (/^(\s*)/.exec(line) ?? ["", ""])[1].length;

/** Extracts actual `run:` command text while retaining the workflow source for reporting. */
const extractRunCommands = (yamlText, source) => {
  const lines = yamlText.split(/\r?\n/);
  const runs = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = /^(\s*(?:-\s+)?)run:\s*(.*)$/.exec(line);
    if (!match) continue;
    const keyIndent = indentOf(line);
    const rest = match[2].trim();
    if (rest === "" || /^[|>][+-]?\d*$/.test(rest)) {
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
      runs.push({ source, command: blockLines.join("\n") });
      i = j - 1;
    } else {
      runs.push({ source, command: stripBashComment(rest) });
    }
  }
  return runs;
};

const splitSegments = (commandText) =>
  commandText
    .split(/\r?\n|&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter(Boolean);

/** Enough shell tokenization for repository commands; dynamic shell remains an admitted limit. */
const shellWords = (segment) =>
  (segment.match(/"(?:\\.|[^"])*"|'[^']*'|[^\s]+/g) ?? []).map((word) => {
    if ((word.startsWith('"') && word.endsWith('"')) || (word.startsWith("'") && word.endsWith("'"))) {
      return word.slice(1, -1);
    }
    return word;
  });

const withoutLeadingEnvironment = (words) => {
  let at = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at] ?? "")) at++;
  if (basename(words[at] ?? "") === "env") {
    at++;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at] ?? "")) at++;
  }
  return words.slice(at);
};

const isScriptOperand = (operand, needle) => operand === needle || operand === `./${needle}`;

/** Returns the file operand executed by node, or null when the command does not execute one. */
const nodeEntrypoint = (words, start) => {
  for (let at = start; at < words.length; at++) {
    const word = words[at];
    if (word === "--") return words[at + 1] ?? null;
    if (!word.startsWith("-")) return word;
    const option = word.split("=", 1)[0];
    if (NODE_NO_ENTRYPOINT.has(option)) return null;
    if (word.includes("=")) continue;
    if (NODE_OPTIONS_WITH_VALUE.has(option)) {
      at++;
      continue;
    }
    if (NODE_OPTIONS_WITHOUT_VALUE.has(option)) continue;
    return null;
  }
  return null;
};

const tsxEntrypoint = (words, start) => {
  for (let at = start; at < words.length; at++) {
    const word = words[at];
    if (word === "--") return words[at + 1] ?? null;
    if (!word.startsWith("-")) return word;
    if (word === "-e" || word === "--eval") return null;
    const option = word.split("=", 1)[0];
    if (word.includes("=")) continue;
    if (TSX_OPTIONS_WITH_VALUE.has(option)) {
      at++;
      continue;
    }
    if (TSX_OPTIONS_WITHOUT_VALUE.has(option)) continue;
    return null;
  }
  return null;
};

const shellEntrypoint = (words, start) => {
  for (let at = start; at < words.length; at++) {
    const word = words[at];
    if (word === "--") return words[at + 1] ?? null;
    if (!word.startsWith("-")) return word;
    // With `-c`, later operands become $0/$1; they are not files executed by the shell.
    if (/^-[^-]*c/.test(word) || word === "--command") return null;
    if (word === "-o") at++;
  }
  return null;
};

const pythonEntrypoint = (words, start) => {
  for (let at = start; at < words.length; at++) {
    const word = words[at];
    if (word === "--") return words[at + 1] ?? null;
    if (!word.startsWith("-")) return word;
    if (word === "-c" || word === "-m") return null;
  }
  return null;
};

const npxEntrypoint = (words, start) => {
  let at = start;
  while (at < words.length && words[at].startsWith("-")) {
    if (!["-y", "--yes", "--no-install"].includes(words[at]) && !words[at].includes("=")) return null;
    at++;
  }
  const runner = basename(words[at] ?? "");
  if (runner === "tsx") return tsxEntrypoint(words, at + 1);
  if (runner === "node") return nodeEntrypoint(words, at + 1);
  return null;
};

/** True only when the script is the command's entrypoint operand, not an arbitrary argument. */
const segmentInvokes = (segment, needle) => {
  if (!segment.includes(needle)) return false;
  const words = withoutLeadingEnvironment(shellWords(segment));
  const command = basename(words[0] ?? "");
  if (!command) return false;
  if (isScriptOperand(words[0], needle)) return true;
  let entrypoint = null;
  if (command === "node" || command === "node.exe") entrypoint = nodeEntrypoint(words, 1);
  else if (command === "tsx") entrypoint = tsxEntrypoint(words, 1);
  else if (command === "sh" || command === "bash") entrypoint = shellEntrypoint(words, 1);
  else if (command === "python" || command === "python3") entrypoint = pythonEntrypoint(words, 1);
  else if (command === "npx") entrypoint = npxEntrypoint(words, 1);
  return entrypoint !== null && isScriptOperand(entrypoint, needle);
};

const commandInvokes = (command, needle) =>
  splitSegments(command).some((segment) => segmentInvokes(segment, needle));

const packageCallsIn = (command, packageScriptNames) => {
  const called = new Set();
  for (const segment of splitSegments(command)) {
    const words = withoutLeadingEnvironment(shellWords(segment));
    const manager = basename(words[0] ?? "");
    if (!PACKAGE_MANAGERS.has(manager)) continue;
    let at = 1;
    if (words[at] === "run") at++;
    const candidate = words[at];
    if (candidate && packageScriptNames.has(candidate)) called.add(candidate);
  }
  return called;
};

const scriptsDir = join(repoRoot, "scripts");
const scriptFiles = readdirSync(scriptsDir)
  .filter((name) => statSync(join(scriptsDir, name)).isFile())
  .sort();
const scriptFileSet = new Set(scriptFiles);

const packageScripts = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts ?? {};
const packageScriptEntries = Object.entries(packageScripts);
const packageScriptNames = new Set(Object.keys(packageScripts));

const workflowsDir = join(repoRoot, ".github", "workflows");
const workflowRuns = readdirSync(workflowsDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .flatMap((name) =>
    extractRunCommands(readFileSync(join(workflowsDir, name), "utf8"), `.github/workflows/${name}`),
  );

/** Follow the plausible graph direction: workflow-named package script -> aliases its command names. */
const plausiblyCiRoutedPackageScripts = new Set();
for (const { command } of workflowRuns) {
  for (const called of packageCallsIn(command, packageScriptNames)) plausiblyCiRoutedPackageScripts.add(called);
}
const queue = [...plausiblyCiRoutedPackageScripts];
while (queue.length > 0) {
  const caller = queue.shift();
  for (const called of packageCallsIn(packageScripts[caller], packageScriptNames)) {
    if (plausiblyCiRoutedPackageScripts.has(called)) continue;
    plausiblyCiRoutedPackageScripts.add(called);
    queue.push(called);
  }
}

const commandRunsFullVitestSuite = (command) =>
  splitSegments(command).some((segment) => {
    const words = withoutLeadingEnvironment(shellWords(segment));
    if (basename(words[0] ?? "") === "vitest") {
      return words.length === 1 || (words.length === 2 && words[1] === "run");
    }
    return basename(words[0] ?? "") === "npx" && basename(words[1] ?? "") === "vitest" &&
      (words.length === 2 || (words.length === 3 && words[2] === "run"));
  });

const plausibleCiFullTestScripts = [...plausiblyCiRoutedPackageScripts].filter((name) =>
  commandRunsFullVitestSuite(packageScripts[name]),
);
const workflowPlausiblyRunsFullTests = workflowRuns.some(({ command }) => commandRunsFullVitestSuite(command));

/** Replaces strings and comments with spaces, preserving offsets for a small static call scan. */
const maskNonCode = (source) => {
  const chars = [...source];
  let state = "code";
  for (let i = 0; i < chars.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        chars[i] = chars[i + 1] = " ";
        i++;
        state = "line";
      } else if (char === "/" && next === "*") {
        chars[i] = chars[i + 1] = " ";
        i++;
        state = "block";
      } else if (char === "'" || char === '"' || char === "`") {
        chars[i] = " ";
        state = char;
      }
    } else if (state === "line") {
      if (char === "\n") state = "code";
      else chars[i] = " ";
    } else if (state === "block") {
      chars[i] = char === "\n" ? "\n" : " ";
      if (char === "*" && next === "/") {
        chars[i + 1] = " ";
        i++;
        state = "code";
      }
    } else {
      chars[i] = char === "\n" ? "\n" : " ";
      if (char === "\\") {
        if (i + 1 < chars.length) chars[++i] = " ";
      } else if (char === state) {
        state = "code";
      }
    }
  }
  return chars.join("");
};

const splitTopLevel = (source) => {
  const masked = maskNonCode(source);
  const parts = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === "(") round++;
    else if (masked[i] === ")") round--;
    else if (masked[i] === "[") square++;
    else if (masked[i] === "]") square--;
    else if (masked[i] === "{") curly++;
    else if (masked[i] === "}") curly--;
    else if (masked[i] === "," && round === 0 && square === 0 && curly === 0) {
      parts.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(source.slice(start).trim());
  return parts.filter(Boolean);
};

const findClosingParen = (masked, openAt) => {
  let depth = 0;
  for (let i = openAt; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")" && --depth === 0) return i;
  }
  return -1;
};

const constantsIn = (source, masked) => {
  const constants = new Map();
  const declaration = /\bconst\s+([A-Za-z_$][\w$]*)(?:\s*:[^=;\n]+)?\s*=/g;
  for (const match of masked.matchAll(declaration)) {
    const start = match.index + match[0].length;
    const end = masked.indexOf(";", start);
    if (end !== -1) constants.set(match[1], source.slice(start, end).trim());
  }
  return constants;
};

const literalValue = (expression) => {
  const match = /^(["'`])([^\n]*?)\1$/.exec(expression.trim());
  if (!match || (match[1] === "`" && match[2].includes("${"))) return null;
  return match[2].replace(/\\([\\"'])/g, "$1");
};

const expressionResolvesToScript = (expression, name, constants, seen = new Set()) => {
  const trimmed = expression.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    if (seen.has(trimmed) || !constants.has(trimmed)) return false;
    seen.add(trimmed);
    return expressionResolvesToScript(constants.get(trimmed), name, constants, seen);
  }
  const literal = literalValue(trimmed);
  if (literal !== null) {
    const normalized = literal.replaceAll("\\", "/").replace(/^\.\//, "");
    return normalized === `scripts/${name}` || normalized.endsWith(`/scripts/${name}`);
  }
  const isPathBuilder = /^(?:(?:[A-Za-z_$][\w$]*)\.)?(?:join|resolve)\s*\(/.test(trimmed);
  const isFileUrl = /^fileURLToPath\s*\(\s*new\s+URL\s*\(/.test(trimmed);
  if (!isPathBuilder && !isFileUrl) return false;
  const values = [...trimmed.matchAll(/(["'`])([^\n]*?)\1/g)].map((match) => match[2].replaceAll("\\", "/"));
  if (values.some((value) => value === `scripts/${name}` || value.endsWith(`/scripts/${name}`))) return true;
  return values.some((value, index) => value === "scripts" && values[index + 1] === name);
};

const arrayElements = (expression) => {
  const trimmed = expression.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  return splitTopLevel(trimmed.slice(1, -1));
};

const staticArgvEntrypoint = (executable, argv, name, constants) => {
  if (expressionResolvesToScript(executable, name, constants)) return true;
  const executableLiteral = literalValue(executable);
  const executableName = executable.trim() === "process.execPath" ? "node" : basename(executableLiteral ?? "");
  const elements = arrayElements(argv);
  if (!elements) return false;
  const values = elements.map((element) => literalValue(element));
  let entryAt = 0;
  if (executableName === "node" || executableName === "node.exe") {
    while (entryAt < elements.length) {
      const value = values[entryAt];
      if (value === null) break;
      if (value === "--") {
        entryAt++;
        break;
      }
      if (!value.startsWith("-")) break;
      const option = value.split("=", 1)[0];
      if (NODE_NO_ENTRYPOINT.has(option)) return false;
      if (value.includes("=")) entryAt++;
      else if (NODE_OPTIONS_WITH_VALUE.has(option)) entryAt += 2;
      else if (NODE_OPTIONS_WITHOUT_VALUE.has(option)) entryAt++;
      else return false;
    }
  } else if (executableName === "sh" || executableName === "bash") {
    while (entryAt < elements.length && values[entryAt]?.startsWith("-")) {
      if (/^-[^-]*c/.test(values[entryAt]) || values[entryAt] === "--command") return false;
      entryAt++;
    }
  } else if (executableName === "python" || executableName === "python3") {
    while (entryAt < elements.length && values[entryAt]?.startsWith("-")) {
      if (values[entryAt] === "-c" || values[entryAt] === "-m") return false;
      entryAt++;
    }
  } else if (executableName === "tsx") {
    while (entryAt < elements.length && values[entryAt]?.startsWith("-")) {
      if (values[entryAt] === "-e" || values[entryAt] === "--eval") return false;
      entryAt++;
    }
  } else if (executableName === "npx") {
    if (values[entryAt] === "tsx" || values[entryAt] === "node") entryAt++;
    else return false;
  } else {
    return false;
  }
  return Boolean(elements[entryAt]) && expressionResolvesToScript(elements[entryAt], name, constants);
};

const testFileHasPlausibleSpawn = (source, scriptName) => {
  const masked = maskNonCode(source);
  const constants = constantsIn(source, masked);
  const call = /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(/g;
  for (const match of masked.matchAll(call)) {
    const openAt = match.index + match[0].lastIndexOf("(");
    const closeAt = findClosingParen(masked, openAt);
    if (closeAt === -1) continue;
    const args = splitTopLevel(source.slice(openAt + 1, closeAt));
    if (args.length >= 2 && staticArgvEntrypoint(args[0], args[1], scriptName, constants)) return true;
  }
  return false;
};

const filesBelow = (dir) => {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesBelow(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
};

const vitestConfigPath = join(repoRoot, "vitest.config.ts");
const vitestConfig = readFileSync(vitestConfigPath, "utf8");
const staticTestSelectionKnown = /include\s*:\s*\[\s*["']tests\/\*\*\/\*\.test\.ts["']\s*\]/.test(vitestConfig);
const fullTestsHavePlausibleCiRoute = workflowPlausiblyRunsFullTests || plausibleCiFullTestScripts.length > 0;
const testFiles = staticTestSelectionKnown && fullTestsHavePlausibleCiRoute
  ? filesBelow(join(repoRoot, "tests")).filter((path) => /\.test\.ts$/.test(path))
  : [];
const testSources = testFiles.map((path) => ({
  source: relative(repoRoot, path).replaceAll("\\", "/"),
  text: readFileSync(path, "utf8"),
}));

const plausibleSitesFor = (name) => {
  const needle = `scripts/${name}`;
  const sites = [];
  for (const { source, command } of workflowRuns) {
    if (commandInvokes(command, needle)) {
      sites.push({ type: "workflow", file: source, plausibleCiRoute: true, execution: "unproven" });
    }
  }
  for (const [scriptName, command] of packageScriptEntries) {
    if (commandInvokes(command, needle)) {
      sites.push({
        type: "package.json",
        script: scriptName,
        plausibleCiRoute: plausiblyCiRoutedPackageScripts.has(scriptName),
        execution: "unproven",
      });
    }
  }
  for (const test of testSources) {
    if (testFileHasPlausibleSpawn(test.text, name)) {
      sites.push({ type: "test", file: test.source, plausibleCiRoute: true, execution: "unproven" });
    }
  }
  return sites;
};

const failures = [];
const withPlausibleSites = [];
const exempted = [];
for (const name of scriptFiles) {
  const plausibleSites = plausibleSitesFor(name);
  if (plausibleSites.length > 0) {
    withPlausibleSites.push({
      name,
      plausibleSites,
      plausibleCiRoute: plausibleSites.some((site) => site.plausibleCiRoute),
    });
  } else if (Object.prototype.hasOwnProperty.call(EXEMPT, name)) {
    exempted.push({ name, reason: EXEMPT[name] });
  } else {
    failures.push(name);
  }
}

const staleExemptions = Object.keys(EXEMPT).filter((name) => !scriptFileSet.has(name));
const emptyReasonExemptions = Object.entries(EXEMPT)
  .filter(([name]) => scriptFileSet.has(name))
  .filter(([, reason]) => typeof reason !== "string" || reason.trim().length === 0)
  .map(([name]) => name);
const hasFailures = failures.length > 0 || staleExemptions.length > 0 || emptyReasonExemptions.length > 0;
const claim =
  "Every regular direct child of scripts/ has at least one statically plausible invocation site, " +
  "or a named exemption.";
const staticLimit =
  "Static analysis does not prove execution: it cannot determine import origin, it.skip, disabled " +
  "suites such as describe.runIf(false), unreachable branches, dynamic test selection, dynamic shell, " +
  "runtime-built paths, or unrecognized interpreter options; every detected test-spawn site is " +
  "execution-unproven.";
const remainingWork =
  "Dynamic measurement of which scripts CI actually enters remains owned by issue #705; this static " +
  "census cannot close #705 by itself.";

if (asJson) {
  console.log(
    JSON.stringify(
      {
        claim,
        inspected: scriptFiles.length,
        withPlausibleSites,
        exempted,
        withoutPlausibleSite: failures,
        staleExemptions,
        emptyReasonExemptions,
        limitations: [staticLimit],
        remainingWork,
        testScan: {
          staticTestSelectionKnown,
          fullTestsHavePlausibleCiRoute,
          plausibleCiFullTestScripts,
          filesScanned: testFiles.length,
          limitation: staticLimit,
        },
      },
      null,
      2,
    ),
  );
} else {
  if (failures.length > 0) {
    console.error(
      `verify-every-script-has-a-plausible-caller: ${failures.length} script(s) with no statically plausible invocation site`,
    );
    for (const name of failures) {
      console.error(
        `  scripts/${name} — no plausible site in workflow command text, package.json, or a CI-selected test`,
      );
    }
    console.error("\nAdd a caller in a statically recognizable form, or name the deliberately manual file in EXEMPT with a reason.");
  }
  if (staleExemptions.length > 0) {
    console.error(`verify-every-script-has-a-plausible-caller: ${staleExemptions.length} stale EXEMPT entr(y/ies)`);
    for (const name of staleExemptions) {
      console.error(`  EXEMPT["${name}"] names no direct child of scripts/ — remove the entry`);
    }
  }
  if (emptyReasonExemptions.length > 0) {
    console.error(
      `verify-every-script-has-a-plausible-caller: ${emptyReasonExemptions.length} EXEMPT entr(y/ies) with no reason`,
    );
    for (const name of emptyReasonExemptions) {
      console.error(`  EXEMPT["${name}"] has an empty reason — state why it is deliberately unreached`);
    }
  }
  if (!hasFailures) {
    const plausibleCiRouteCount = withPlausibleSites.filter((entry) => entry.plausibleCiRoute).length;
    const packageOnlyCount = withPlausibleSites.length - plausibleCiRouteCount;
    const directWorkflowCount = withPlausibleSites.filter((entry) =>
      entry.plausibleSites.some((site) => site.type === "workflow"),
    ).length;
    const plausibleCiPackageCount = withPlausibleSites.filter((entry) =>
      entry.plausibleSites.some((site) => site.type === "package.json" && site.plausibleCiRoute),
    ).length;
    const plausibleTestSpawnCount = withPlausibleSites.filter((entry) =>
      entry.plausibleSites.some((site) => site.type === "test"),
    ).length;
    console.log(
      `verify-every-script-has-a-plausible-caller: ${withPlausibleSites.length} script(s) with plausible ` +
        `invocation site(s) (${plausibleCiRouteCount} with plausible CI routes, ${packageOnlyCount} package ` +
        `entry only), ${exempted.length} named exemption(s), 0 without a statically plausible site`,
    );
    console.log(
      `  plausible CI routes: ${directWorkflowCount} workflow command, ${plausibleCiPackageCount} package.json, ` +
        `${plausibleTestSpawnCount} execution-unproven test-spawn`,
    );
    for (const entry of withPlausibleSites.filter((candidate) => !candidate.plausibleCiRoute)) {
      const aliases = entry.plausibleSites
        .filter((site) => site.type === "package.json")
        .map((site) => site.script)
        .join(", ");
      console.log(`  package entry only, no plausible CI route detected: scripts/${entry.name} (via ${aliases})`);
    }
    for (const { name, reason } of exempted) console.log(`  exempt: scripts/${name} — ${reason}`);
  }
  console.log(`  claim: ${claim}`);
  console.log(`  limit: ${staticLimit}`);
  console.log(`  remaining work: ${remainingWork}`);
}

process.exit(hasFailures ? 1 : 0);
