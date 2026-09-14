#!/usr/bin/env node
/**
 * A bounded child's budget fires before the case that contains it times out.
 *
 * `tests/helpers/bounded-sync-child.ts` defaults to 55s because the repository's `testTimeout` is
 * 60s, so the bound is the thing that fires and names the command rather than a per-test timeout
 * landing on whichever test the stalled worker happened to be holding. That argument is only true
 * while the enclosing case actually allows 60s. A case that declares less — `it(name, fn, 20_000)`
 * — gets a default that **can never fire**, and the failure it was meant to name reappears exactly
 * as it was: a timeout reported against some other test.
 *
 * This is not hypothetical, and hand-reading did not close it. #872 converted a hundred call sites
 * and found two of these by reading every file — `the-database-backup-step-fails-closed.test.ts`
 * and `usage-collectors.test.ts`, both repaired with an explicit 10s. This check's **first run
 * found two more that the reading had missed**: `canonical-self-claim-identity.test.ts:479`
 * (`readlink`) and a *second* site in the backup file at `:486` (`sleep 1`), each taking the 55s
 * default inside a 20s case. Two of four, by the method that felt thorough at the time.
 *
 * The record left on the helper had already named this — *"nothing enforces the rule the docstring
 * now states … the original defect wearing the fix's clothes"*. A rule that lives only in a
 * docstring is a rule whose next violation belongs to whoever is unlucky.
 *
 * What it does **not** prove: that any budget is large enough. A bound below what a green run costs
 * is a performance assertion that fails first under load, and only measurement answers that — 30s
 * was once chosen here because it reads as generous and fired against a passing 39.4s child. This
 * check reads the two declared numbers and compares them; it runs nothing.
 *
 * Nor does it see a case whose timeout is not a numeric literal. `it(name, fn, someConst)` where
 * `someConst` is imported resolves to nothing here and is reported as unresolved rather than
 * assumed generous, because assuming would make the check quietly stop covering the shape it
 * exists for.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// `--root=<dir>` exists for the same reason the sibling census has one: without it, the only way
// to show this check can fail is to put a failing case into a real test file.
const rootArgument = process.argv.slice(2).find((argument) => argument.startsWith("--root="));
const FIXTURE_ROOT = rootArgument === undefined ? null : rootArgument.slice("--root=".length);
const SCAN_DIR = FIXTURE_ROOT === null ? join(ROOT, "tests") : FIXTURE_ROOT;
const BASE = FIXTURE_ROOT === null ? ROOT : FIXTURE_ROOT;

/**
 * The wrappers, resolved through the importing file rather than trusted by spelling.
 *
 * A review built the counterexample for the name-trusting version of the sibling inode guard: a
 * locally defined `boundedSpawnSync` with a different shape read as the real one. The same applies
 * here, and more sharply — this check asks what a call's *budget* is, so a different function
 * wearing the name would have its unrelated options read as a budget.
 */
const WRAPPER_MODULE = /(?:^|\/)tests\/helpers\/bounded-sync-child\.ts$|^\.{1,2}(?:\/\.\.)*\/helpers\/bounded-sync-child\.ts$/u;
const WRAPPER_EXPORTS = new Set(["boundedSpawnSync", "boundedExecFileSync"]);
const DEFAULT_BUDGET_EXPORT = "CHILD_BUDGET_MS";

/** Vitest's own default, read rather than remembered: the number is the whole argument. */
const configuredTestTimeout = () => {
  const config = join(ROOT, "vitest.config.ts");
  const match = /testTimeout\s*:\s*([0-9_]+)/u.exec(readFileSync(config, "utf8"));
  if (match === null) {
    throw new Error(`verify-child-budgets: no testTimeout in ${relative(ROOT, config)} — nothing to compare against`);
  }
  return Number(match[1].replaceAll("_", ""));
};

/** The helper's own default, read from the helper. Hardcoding it here is a second authority. */
const helperDefaultBudget = () => {
  const helper = join(ROOT, "tests", "helpers", "bounded-sync-child.ts");
  const match = new RegExp(String.raw`export const ${DEFAULT_BUDGET_EXPORT}\s*=\s*([0-9_]+)`, "u").exec(
    readFileSync(helper, "utf8"),
  );
  if (match === null) {
    throw new Error(`verify-child-budgets: no ${DEFAULT_BUDGET_EXPORT} in the helper — its default cannot be read`);
  }
  return Number(match[1].replaceAll("_", ""));
};

const filesUnder = (dir) => {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path));
    else if (statSync(path).isFile() && /\.[cm]?tsx?$/u.test(entry.name)) found.push(path);
  }
  return found;
};

/**
 * A numeric literal, or an arithmetic expression over them.
 *
 * `30 * 60 * 1000` is how the long cases in this repository spell half an hour, and reading that as
 * unresolved would have left the six e2e sites uncovered while the check reported itself healthy.
 * Folding is deliberately limited to `*`, `+` and `-` over things this function already resolves:
 * anything else stays unresolved and is reported, because a check that guesses at an expression it
 * cannot evaluate is worse than one that says it could not read it.
 */
const numericLiteral = (node) => {
  if (node === undefined) return null;
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll("_", ""));
  if (ts.isParenthesizedExpression(node)) return numericLiteral(node.expression);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const operand = numericLiteral(node.operand);
    return operand === null ? null : -operand;
  }
  if (ts.isBinaryExpression(node)) {
    const left = numericLiteral(node.left);
    const right = numericLiteral(node.right);
    if (left === null || right === null) return null;
    if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return left * right;
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return left + right;
    if (node.operatorToken.kind === ts.SyntaxKind.MinusToken) return left - right;
    return null;
  }
  return null;
};

/** `it`, `test`, and their chained forms (`it.skipIf(...)`, `it.each(...)`, `test.concurrent`). */
const caseCalleeName = (node) => {
  let walker = node.expression;
  for (;;) {
    if (ts.isIdentifier(walker)) return walker.text;
    if (ts.isPropertyAccessExpression(walker)) { walker = walker.expression; continue; }
    if (ts.isCallExpression(walker)) { walker = walker.expression; continue; }
    return null;
  }
};

const analyse = (file, text) => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);

  const wrapperNames = new Set();
  let defaultBudgetLocalName = null;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const from = statement.moduleSpecifier;
    if (!ts.isStringLiteralLike(from) || !WRAPPER_MODULE.test(from.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const exported = (element.propertyName ?? element.name).text;
      if (WRAPPER_EXPORTS.has(exported)) wrapperNames.add(element.name.text);
      if (exported === DEFAULT_BUDGET_EXPORT) defaultBudgetLocalName = element.name.text;
    }
  }
  if (wrapperNames.size === 0) return [];

  // File-scope numeric constants, so `QUICK_CHILD_BUDGET_MS` resolves without being special-cased.
  const constants = new Map();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const value = numericLiteral(declaration.initializer);
      if (value !== null) constants.set(declaration.name.text, value);
    }
  }
  const resolve = (node) => {
    const literal = numericLiteral(node);
    if (literal !== null) return literal;
    if (node !== undefined && ts.isIdentifier(node)) {
      if (node.text === defaultBudgetLocalName) return DEFAULT_BUDGET;
      if (constants.has(node.text)) return constants.get(node.text);
    }
    return null;
  };

  const declaredBudget = (call) => {
    for (const argument of call.arguments) {
      if (!ts.isObjectLiteralExpression(argument)) continue;
      for (const property of argument.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          property.name !== undefined &&
          ts.isIdentifier(property.name) &&
          property.name.text === "timeout"
        ) {
          return { stated: true, value: resolve(property.initializer) };
        }
      }
    }
    return { stated: false, value: DEFAULT_BUDGET };
  };

  /** The nearest enclosing `it`/`test`, and the timeout it declares. */
  const enclosingCase = (node) => {
    for (let walker = node.parent; walker !== undefined; walker = walker.parent) {
      if (!ts.isCallExpression(walker)) continue;
      const name = caseCalleeName(walker);
      if (name !== "it" && name !== "test") continue;
      // The timeout is the argument after the body. `it.each(table)(name, fn, ms)` keeps that
      // shape, which is why the callee walk above unwraps the chain rather than matching a name.
      const last = walker.arguments[walker.arguments.length - 1];
      const declared = walker.arguments.length >= 3 ? resolve(last) : null;
      return { found: true, declared, stated: walker.arguments.length >= 3 };
    }
    return { found: false, declared: null, stated: false };
  };

  const sites = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && wrapperNames.has(node.expression.text)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const budget = declaredBudget(node);
      const enclosing = enclosingCase(node);
      sites.push({
        at: `${relative(BASE, file)}:${line}`,
        callee: node.expression.text,
        budget,
        enclosing,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
};

const DEFAULT_BUDGET = helperDefaultBudget();
const TEST_TIMEOUT = configuredTestTimeout();

const sites = [];
for (const file of filesUnder(SCAN_DIR)) sites.push(...analyse(file, readFileSync(file, "utf8")));

const failures = [];
const unresolved = [];
let atModuleScope = 0;

for (const site of sites) {
  // A call outside any case has no per-test timeout to sit under, so there is nothing to compare.
  // It is counted rather than dropped: that is the position where *no* vitest timeout can fire, and
  // a reader should see how much of the tree is in it.
  if (!site.enclosing.found) { atModuleScope += 1; continue; }
  if (site.budget.value === null) { unresolved.push({ ...site, why: "budget is not a numeric literal this check can read" }); continue; }
  if (site.enclosing.stated && site.enclosing.declared === null) {
    unresolved.push({ ...site, why: "the case declares a timeout this check cannot read" });
    continue;
  }
  const ceiling = site.enclosing.declared ?? TEST_TIMEOUT;
  if (site.budget.value >= ceiling) {
    failures.push({ ...site, ceiling });
  }
}

process.stdout.write(
  `verify-child-budgets-fit-their-cases: ${sites.length} bounded child call(s); ` +
    `${sites.length - atModuleScope - unresolved.length - failures.length} fit their case, ` +
    `${failures.length} do not, ${unresolved.length} could not be read, ` +
    `${atModuleScope} are at module scope and have no case to fit.\n` +
    `  helper default ${DEFAULT_BUDGET}ms, config testTimeout ${TEST_TIMEOUT}ms\n`,
);

for (const site of unresolved) {
  process.stdout.write(`  UNREAD  ${site.at}  ${site.callee}  ${site.why}\n`);
}
for (const site of failures) {
  const stated = site.budget.stated ? "states" : "takes the default";
  process.stdout.write(
    `  FAIL    ${site.at}  ${site.callee} ${stated} ${site.budget.value}ms inside a case that allows ${site.ceiling}ms — ` +
      `the case times out first, so the bound can never fire and names nothing\n`,
  );
}

if (failures.length > 0) {
  process.stdout.write(
    "\nRESULT: FAIL — give the call its own shorter `timeout`, or raise the case's, so the bound is " +
      "the thing that fires.\n",
  );
  process.exit(1);
}

process.stdout.write(
  "\nRESULT: PASS — every bounded child's budget is below the timeout of the case containing it. " +
    "Fitting is not sufficiency: this compares two declared numbers and runs nothing, so a budget " +
    "below what a green run costs still passes here.\n",
);
