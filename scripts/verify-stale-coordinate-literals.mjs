#!/usr/bin/env node
/**
 * Refuses four literal copies of mutable repository structure that failed today:
 *
 *   1. a test fixture quotes an existing `src/**:line` followed by source text
 *   2. a test discovers files with `git ls-files` and pins the result with `toHaveLength(number)`
 *   3. one Markdown paragraph names a measured SHA and explicitly labels an inline `node` command
 *      as its replay/reproduction command without passing that SHA through `--ref`
 *   4. Markdown explicitly says a workflow now/currently has a literal total number of jobs
 *
 * This is deliberately narrower than every file:line mention. Historical measurement documents
 * use line citations, while a missing-path citation is also a durable negative control: moving
 * production cannot change the fact that `src/does/not/exist.ts:42` is absent. Unlabelled `node`
 * commands and hypothetical job counts are outside this check: prose proximity alone does not
 * make a command a reproduction command or a number the current workflow total.
 *
 * sol-simplify: copied mutable coordinates caused four defects in one day; remove this check when
 * repository coordinates are represented by structured symbols and queries instead.
 *
 * Usage: node scripts/verify-stale-coordinate-literals.mjs [--json] [--root=<repository>]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

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
 * offsets. Source-coordinate fixtures need their string contents without mistaking comments for
 * code; TypeScript handles binding-aware analysis of discovered file counts below.
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

/**
 * Finds literal length assertions whose subject is derived through simple variable initializers
 * from an expression containing the exact `ls-files` string. TypeScript symbols make each lexical
 * binding distinct, so reusing a name in another function or block cannot inherit derivation.
 * Reassignments, returned values, parameter passing, properties written after initialization, and
 * inter-file flow are deliberately outside this check.
 */
const discoveredFileCountPins = (source, path) => {
  const compilerOptions = {
    allowJs: true,
    checkJs: false,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const defaultHost = ts.createCompilerHost(compilerOptions);
  const host = {
    ...defaultHost,
    fileExists: (candidate) => candidate === path,
    getSourceFile: (candidate) => (candidate === path ? sourceFile : undefined),
    readFile: (candidate) => (candidate === path ? source : undefined),
    writeFile: () => undefined,
  };
  const program = ts.createProgram({ rootNames: [path], options: compilerOptions, host });
  const checker = program.getTypeChecker();

  const anyNode = (node, accepts) => {
    if (accepts(node)) return true;
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && anyNode(child, accepts)) found = true;
    });
    return found;
  };
  const containsLsFiles = (node) =>
    anyNode(
      node,
      (candidate) =>
        (ts.isStringLiteral(candidate) || ts.isNoSubstitutionTemplateLiteral(candidate)) &&
        candidate.text === "ls-files",
    );

  const initializers = [];
  const collectInitializers = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol !== undefined) initializers.push({ symbol, value: node.initializer });
    }
    ts.forEachChild(node, collectInitializers);
  };
  collectInitializers(sourceFile);

  const derived = new Set(
    initializers.filter(({ value }) => containsLsFiles(value)).map(({ symbol }) => symbol),
  );
  const readsDerivedBinding = (node) =>
    anyNode(
      node,
      (candidate) =>
        ts.isIdentifier(candidate) && derived.has(checker.getSymbolAtLocation(candidate)),
    );

  let changed = true;
  while (changed) {
    changed = false;
    for (const initializer of initializers) {
      if (derived.has(initializer.symbol)) continue;
      if (readsDerivedBinding(initializer.value)) {
        derived.add(initializer.symbol);
        changed = true;
      }
    }
  }

  const pins = [];
  const unwrapParentheses = (node) => {
    let current = node;
    while (ts.isParenthesizedExpression(current)) current = current.expression;
    return current;
  };
  const collectPins = (node) => {
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isNumericLiteral(node.arguments[0])) {
      const property = unwrapParentheses(node.expression);
      if (ts.isPropertyAccessExpression(property) && property.name.text === "toHaveLength") {
        const expectCall = unwrapParentheses(property.expression);
        if (
          ts.isCallExpression(expectCall) &&
          ts.isIdentifier(unwrapParentheses(expectCall.expression)) &&
          unwrapParentheses(expectCall.expression).text === "expect" &&
          expectCall.arguments.length === 1
        ) {
          const subject = expectCall.arguments[0];
          const readsDiscoveredMembers = containsLsFiles(subject) || readsDerivedBinding(subject);
          if (readsDiscoveredMembers) pins.push({ index: node.getStart(sourceFile), count: node.arguments[0].text });
        }
      }
    }
    ts.forEachChild(node, collectPins);
  };
  collectPins(sourceFile);
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

  for (const pin of discoveredFileCountPins(text, path)) {
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
      const reproductionCommandPattern =
        /\b(?:replay|reproduce|reproducible)\s+with\s+`(node\s+[^`\n]+)`/gi;
      for (const command of paragraph.matchAll(reproductionCommandPattern)) {
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

  const jobTotalPattern = /\b(?:the\s+)?workflow\s+(?:now|currently)\s+has\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+jobs?\b/gi;
  for (const match of text.matchAll(jobTotalPattern)) {
    documentFindings.push(
      finding(
        "workflow-job-total",
        path,
        lineAt(text, match.index ?? 0),
        `${JSON.stringify(match[0])} states a current workflow total that changes when jobs are split or added`,
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
          "a numeric test length is classified only when TypeScript binding-aware initializer flow in that file traces its subject to an exact ls-files string; reassignments, calls, returns, and inter-file flow are not classified",
          "a measured SHA constrains only an inline node command explicitly introduced by replay with, reproduce with, or reproducible with in the same paragraph",
          "a workflow job total is classified only when the prose explicitly says the workflow now or currently has that total",
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
    "\nName production loci by symbol, derive discovered membership, and pass measured refs into explicitly labelled replay/reproduction commands.\n",
  );
} else {
  process.stdout.write(
    `verify-stale-coordinate-literals: checked ${testFiles.length} test file(s) and ${documentFiles.length} document(s); 0 copied moving coordinates\n`,
  );
}

process.exit(findings.length === 0 ? 0 : 1);
