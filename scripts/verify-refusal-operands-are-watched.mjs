#!/usr/bin/env node
/**
 * Derive the census from source syntax, including files not yet tracked by git.
 * A deciding candidate contains a &&/|| expression. This conservatively includes predicates
 * whose caller refuses, validation, routing and value construction: refusal is not a syntax type.
 * Files without those expressions are not selected, not excluded. Named file exclusions are
 * an unanswered pre-existing backlog, not a claim that those files do not decide refusals.
 *
 * Each operand is counted, including chain tails, nested chains and single-line chains.
 * A row names an operand only if its unique find anchor in THAT file contains the entire operand.
 * Neighbouring anchors and rows for other files earn no credit. Named is not tested: this reads
 * declarations; only mutation runs establish test dependence. Usage: node <this script>
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { CASES_DIR } from "./lib/falsifiability-cases.mjs";
import { FILE_EXCLUSIONS } from "./lib/refusal-operand-exclusions.mjs";
import { UNANSWERED } from "./lib/refusal-operands-unanswered.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (file) => readFileSync(join(ROOT, file), "utf8");
const parse = (file, source) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const walk = (node, visit) => {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
};
const logical = (node) => ts.isBinaryExpression(node) &&
  (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    node.operatorToken.kind === ts.SyntaxKind.BarBarToken);
const unparen = (node) => ts.isParenthesizedExpression(node) ? unparen(node.expression) : node;

// Read declarations without executing the harness. Quoted keys, escapes, literal templates and
// concatenated literal anchors are syntax too; the previous regex silently dropped these forms.
const literal = (node) => {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literal(node.left), right = literal(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
};
const rows = [], problems = [];
const caseFiles = existsSync(join(ROOT, CASES_DIR))
  ? readdirSync(join(ROOT, CASES_DIR)).filter((name) => name.endsWith(".mjs"))
      .sort().map((name) => join(CASES_DIR, name))
  : [];
for (const file of ["scripts/verify-guards-are-falsifiable.mjs", ...caseFiles]) {
  const tree = parse(file, read(file));
  if (tree.parseDiagnostics.length) problems.push(`${file}: cannot parse row declarations`);
  const declarations = new Map();
  walk(tree, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      declarations.set(node.name.text, node.initializer);
    }
  });
  const exported = tree.statements.find(ts.isExportAssignment)?.expression;
  const subject = file.endsWith("/verify-guards-are-falsifiable.mjs")
    ? declarations.get("GUARDS")
    : exported && ts.isIdentifier(exported) ? declarations.get(exported.text) : exported;
  const objects = subject && ts.isArrayLiteralExpression(subject) ? [...subject.elements] : [subject];
  for (const node of objects) {
    if (!node || !ts.isObjectLiteralExpression(node)) {
      problems.push(`${file}: cannot read declared row object`);
      continue;
    }
    const properties = new Map(node.properties.filter(ts.isPropertyAssignment)
      .map((property) => [property.name.text, property.initializer]));
    if (properties.has("skip") && properties.get("skip").kind !== ts.SyntaxKind.FalseKeyword) continue;
    const target = literal(properties.get("file")), find = literal(properties.get("find"));
    if (target === undefined || find === undefined || !find.length) {
      problems.push(`${file}: file/find must be nonempty literals or literal concatenations`);
      continue;
    }
    rows.push({ file: target, find });
  }
}

const sourceFiles = (directory) => readdirSync(join(ROOT, directory), { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory() ? sourceFiles(join(directory, entry.name))
    : entry.isFile() && /\.(?:[cm]?ts|tsx)$/.test(entry.name) ? [join(directory, entry.name)] : [])
  .sort();
const files = sourceFiles("src"), candidates = [];
for (const file of files) {
  const source = read(file), tree = parse(file, source), operands = new Map();
  if (tree.parseDiagnostics.length) problems.push(`${file}: cannot parse source`);
  walk(tree, (node) => {
    if (!logical(node)) return;
    for (const side of [node.left, node.right]) {
      const operand = unparen(side);
      if (!logical(operand)) operands.set(operand.getStart(tree), operand);
    }
  });
  if (operands.size) candidates.push({ file, source, tree, operands });
}
const excluded = candidates.filter(({ file }) => FILE_EXCLUSIONS.has(file));
const selected = candidates.filter(({ file }) => !FILE_EXCLUSIONS.has(file));
for (const [file, reason] of FILE_EXCLUSIONS) {
  if (!candidates.some((candidate) => candidate.file === file) || !reason.trim()) {
    problems.push(`${file}: stale file exclusion or missing unanswered-backlog reason`);
  }
}
process.stdout.write(
  `CENSUS: scanned ${files.length} file(s); selected ${selected.length} deciding file(s); ` +
    `excluded ${excluded.length} deciding file(s) with unanswered operands; ` +
    `${files.length - candidates.length} file(s) contain no &&/|| operands.\n`,
);

let total = 0, named = 0, known = 0;
const missing = [], consumed = new Set();
for (const { file, source, tree, operands } of selected) {
  const ranges = rows.filter((row) => row.file === file).flatMap(({ find }) => {
    const start = source.indexOf(find);
    return start >= 0 && source.indexOf(find, start + 1) < 0 ? [{ start, end: start + find.length }] : [];
  });
  const occurrences = new Map();
  for (const [start, operand] of [...operands].sort(([a], [b]) => a - b)) {
    total += 1;
    const text = operand.getText(tree), occurrence = (occurrences.get(text) ?? 0) + 1;
    occurrences.set(text, occurrence);
    const key = `${file}::${text}::${occurrence}`;
    if (ranges.some((range) => start >= range.start && operand.end <= range.end)) {
      named += 1;
      continue;
    }
    const reason = UNANSWERED.get(key);
    if (reason) { known += 1; consumed.add(key); }
    missing.push({ file, line: tree.getLineAndCharacterOfPosition(start).line + 1, text, reason });
  }
}
// Each debt names one occurrence. A new repeated operand cannot silently inherit the old entry.
for (const key of UNANSWERED.keys()) {
  if (!consumed.has(key)) problems.push(`stale UNANSWERED entry: ${key}`);
}
for (const { file, line, text, reason } of missing) {
  process.stdout.write(`  ${file}:${line}${reason ? "  UNANSWERED" : "  UNNAMED"}\n    ${text}\n`);
  if (reason) process.stdout.write(`    ${reason}\n`);
}
for (const problem of problems) process.stdout.write(`  ERROR: ${problem}\n`);
const unknown = missing.length - known;
if (unknown || problems.length) {
  process.stdout.write(`RESULT: FAIL — ${unknown} of ${total} operand(s) have no row or UNANSWERED reason; ` +
    `${problems.length} declaration error(s); ${known} known and unanswered.\n`);
  process.exit(1);
}
process.stdout.write(`RESULT: PASS — ${named} of ${total} operand(s) in ${selected.length} file(s) ` +
  `are named by a falsifiability row; ${known} known and unanswered; ${excluded.length} excluded files' ` +
  `operands remain unanswered. Named is not tested; this is not complete coverage.\n`);
