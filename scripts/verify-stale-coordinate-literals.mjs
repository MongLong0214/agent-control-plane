#!/usr/bin/env node
/**
 * Refuses four literal copies of mutable repository structure that failed today:
 *
 *   1. a test fixture quotes an existing `src/**:line` followed by source text
 *   2. a test discovers files with `git ls-files` and pins the result with `toHaveLength(number)`
 *   3. one Markdown paragraph names a measured SHA and gives a `node` reproduction command that
 *      does not consume that SHA through `--ref`
 *   4. Markdown states the current total number of jobs in a workflow
 *
 * This is deliberately narrower than every file:line mention. Historical measurement documents
 * use line citations, while a missing-path citation is also a durable negative control: moving
 * production cannot change the fact that `src/does/not/exist.ts:42` is absent. The four forms
 * above have syntactic boundaries the repository can enforce without an exemption list.
 *
 * sol-simplify: copied mutable coordinates caused four defects in one day; remove this check when
 * repository coordinates are represented by structured symbols and queries instead.
 *
 * Usage: node scripts/verify-stale-coordinate-literals.mjs [--json] [--root=<repository>]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootArg = process.argv.find((argument) => argument.startsWith("--root="));
const repoRoot = rootArg
  ? resolve(rootArg.slice("--root=".length))
  : fileURLToPath(new URL("..", import.meta.url));
const asJson = process.argv.includes("--json");
const unknownArguments = process.argv.slice(2).filter(
  (argument) => argument !== "--json" && !argument.startsWith("--root="),
);
if (unknownArguments.length > 0) {
  throw new Error(`unknown argument(s): ${unknownArguments.join(", ")}`);
}

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts"]);

const extensionOf = (path) => {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot);
};

const filesBelow = (directory, accepts, found = []) => {
  const absolute = join(repoRoot, directory);
  if (!existsSync(absolute)) return found;
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) filesBelow(relative, accepts, found);
    else if (entry.isFile() && accepts(relative)) found.push(relative);
  }
  return found;
};

const lineAt = (text, offset) => text.slice(0, offset).split("\n").length;
const finding = (kind, path, line, detail) => ({ kind, path, line, detail });

/**
 * Returns quoted contents plus code with comments and quotes blanked, preserving newlines and
 * offsets. The check needs two small syntactic facts — an exact `ls-files` argument and an actual
 * `toHaveLength(number)` call — without depending on installed packages in a disposable tree.
 */
const lexicalSource = (source) => {
  const code = [...source];
  const strings = [];
  let index = 0;
  const blank = (at) => {
    if (code[at] !== "\n" && code[at] !== "\r") code[at] = " ";
  };

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (current === "/" && next === "/") {
      blank(index);
      blank(index + 1);
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        blank(index);
        index += 1;
      }
      continue;
    }
    if (current === "/" && next === "*") {
      blank(index);
      blank(index + 1);
      index += 2;
      while (index < source.length) {
        const closes = source[index] === "*" && source[index + 1] === "/";
        blank(index);
        if (closes) {
          blank(index + 1);
          index += 2;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (current === '"' || current === "'" || current === "`") {
      const quote = current;
      const start = index;
      let value = "";
      blank(index);
      index += 1;
      let escaped = false;
      while (index < source.length) {
        const character = source[index];
        if (!escaped && character === quote) {
          blank(index);
          index += 1;
          break;
        }
        value += character;
        blank(index);
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        index += 1;
      }
      strings.push({ value, start: start + 1 });
      continue;
    }
    index += 1;
  }
  return { code: code.join(""), strings };
};

const mentionsIdentifier = (source, identifier) =>
  new RegExp(`(?:^|[^A-Za-z0-9_$])${identifier.replace(/[$]/g, "\\$")}(?:$|[^A-Za-z0-9_$])`).test(
    source,
  );

/**
 * Finds literal length assertions whose subject is derived, in the same file, from a command that
 * contains the exact `ls-files` argument. This deliberately small dataflow follows variable
 * initializers; merely putting an unrelated length assertion beside a git query is not enough.
 */
const discoveredFileCountPins = (lexical) => {
  const assignments = [...lexical.code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([^;]*);/g)].map(
    (match) => ({
      name: match[1],
      value: match[2],
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    }),
  );
  const discoveryPositions = lexical.strings
    .filter((literal) => literal.value === "ls-files")
    .map((literal) => literal.start);
  const derived = new Set(
    assignments
      .filter((assignment) =>
        discoveryPositions.some((position) => position >= assignment.start && position < assignment.end),
      )
      .map((assignment) => assignment.name),
  );

  let changed = true;
  while (changed) {
    changed = false;
    for (const assignment of assignments) {
      if (derived.has(assignment.name)) continue;
      if ([...derived].some((identifier) => mentionsIdentifier(assignment.value, identifier))) {
        derived.add(assignment.name);
        changed = true;
      }
    }
  }

  const pins = [];
  for (const match of lexical.code.matchAll(
    /\bexpect\s*\(([^;]*?)\)\s*\.toHaveLength\s*\(\s*(\d+)\s*\)/g,
  )) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const readsDiscoveredMembers =
      discoveryPositions.some((position) => position >= start && position < end) ||
      [...derived].some((identifier) => mentionsIdentifier(match[1], identifier));
    if (readsDiscoveredMembers) pins.push({ index: start, count: match[2] });
  }
  return pins;
};

const testFiles = filesBelow("tests", (path) => sourceExtensions.has(extensionOf(path)));
const documentFiles = filesBelow("docs", (path) => path.endsWith(".md"));

const testFindings = [];
for (const path of testFiles) {
  const text = readFileSync(join(repoRoot, path), "utf8");
  const lexical = lexicalSource(text);
  for (const literal of lexical.strings) {
    const coordinatePattern = /\b(src\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|mjs|cjs|mts)):(\d+)(?:-\d+)?[ \t]{2,}\S/g;
    for (const match of literal.value.matchAll(coordinatePattern)) {
      const productionPath = match[1];
      // A target that is absent is a stable negative control, not a coordinate that source
      // movement can invalidate. This semantic filter replaces an exemption list.
      if (!existsSync(join(repoRoot, productionPath))) continue;
      const start = literal.start + (match.index ?? 0);
      testFindings.push(
        finding(
          "test-source-line",
          path,
          lineAt(text, start),
          `${productionPath}:${match[2]} copies an existing production line into a test fixture`,
        ),
      );
    }
  }

  for (const pin of discoveredFileCountPins(lexical)) {
    testFindings.push(
      finding(
        "discovered-file-count",
        path,
        lineAt(text, pin.index),
        `a value derived from git ls-files is pinned with toHaveLength(${pin.count}); assert the discovered members instead of their moving total`,
      ),
    );
  }
}

const documentFindings = [];
for (const path of documentFiles) {
  const text = readFileSync(join(repoRoot, path), "utf8");
  let paragraphOffset = 0;
  for (const paragraph of text.split(/\n[ \t]*\n/)) {
    const measured = paragraph.match(/\bmeasured against\s+`([0-9a-f]{7,40})`/i);
    if (measured) {
      for (const command of paragraph.matchAll(/`(node\s+[^`\n]+)`/g)) {
        const sha = measured[1];
        const consumesMeasuredRef = new RegExp(`--ref(?:=|\\s+)${sha}(?:\\s|$)`).test(command[1]);
        if (!consumesMeasuredRef) {
          documentFindings.push(
            finding(
              "unbound-measured-ref",
              path,
              lineAt(text, paragraphOffset + (command.index ?? 0)),
              `the document says it measured ${sha}, but \`${command[1]}\` does not consume that ref`,
            ),
          );
        }
      }
    }
    paragraphOffset += paragraph.length + 2;
  }

  const jobTotalPattern = /\b(?:the\s+)?workflow\s+(?:now\s+)?has\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+jobs?\b/gi;
  for (const match of text.matchAll(jobTotalPattern)) {
    documentFindings.push(
      finding(
        "workflow-job-total",
        path,
        lineAt(text, match.index ?? 0),
        `${JSON.stringify(match[0])} copies a workflow total that changes when jobs are split or added`,
      ),
    );
  }
}

const findings = [...testFindings, ...documentFindings].sort(
  (left, right) =>
    left.path.localeCompare(right.path) || left.line - right.line || left.kind.localeCompare(right.kind),
);

if (asJson) {
  process.stdout.write(
    `${JSON.stringify(
      {
        scanned: { tests: testFiles.length, documents: documentFiles.length },
        findings,
        limitations: [
          "document file:line citations are not classified because historical snapshots and current loci have the same syntax",
          "a source coordinate in a test is classified only when it names an existing production file and quotes source text after the line",
          "a numeric test length is classified only when same-file initializer dataflow traces its subject to git ls-files",
        ],
      },
      null,
      2,
    )}\n`,
  );
} else if (findings.length > 0) {
  process.stderr.write(
    `verify-stale-coordinate-literals: ${findings.length} copied moving coordinate(s) in ${testFiles.length} test file(s) and ${documentFiles.length} document(s)\n`,
  );
  for (const item of findings) {
    process.stderr.write(`  ${item.path}:${item.line} [${item.kind}] ${item.detail}\n`);
  }
  process.stderr.write(
    "\nName production loci by symbol, derive discovered membership, and pass measured refs into reproduction commands.\n",
  );
} else {
  process.stdout.write(
    `verify-stale-coordinate-literals: checked ${testFiles.length} test file(s) and ${documentFiles.length} document(s); 0 copied moving coordinates\n`,
  );
}

process.exit(findings.length === 0 ? 0 : 1);
