#!/usr/bin/env node
/**
 * Reproduce the candidate E and F measurements in 448-comparison-site-definition.md.
 *
 * This is a census, not a check: it has no baseline, never fails on a finding, and is not
 * called by package.json or CI. Run it with:
 *
 *   node docs/design/448-comparison-site-census.mjs [--json]
 */
import { readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE_ROOT = resolve(ROOT, "src");
const ERRORS_SOURCE = resolve(SOURCE_ROOT, "core", "errors.ts");
const REASON_CODES_SOURCE = resolve(SOURCE_ROOT, "core", "reason-codes.ts");
const asJson = process.argv.includes("--json");

const sourcesBelow = (directory) => {
  const found = [];
  for (const entry of readdirSync(directory).sort()) {
    const path = resolve(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) found.push(...sourcesBelow(path));
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) found.push(path);
  }
  return found;
};

const configPath = ts.findConfigFile(ROOT, ts.sys.fileExists, "tsconfig.json");
if (!configPath) throw new Error("tsconfig.json is missing");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error("tsconfig.json could not be read");
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
const sourceNames = sourcesBelow(SOURCE_ROOT);
const program = ts.createProgram({ rootNames: sourceNames, options: parsed.options });
const checker = program.getTypeChecker();

const resolvedSymbol = (node) => {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return null;
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
};

const declaredIn = (symbol, path, name) =>
  symbol?.declarations?.some((declaration) => {
    if (resolve(declaration.getSourceFile().fileName) !== path || !("name" in declaration)) return false;
    return declaration.name?.getText() === name;
  }) ?? false;

const reasonCodeName = (node) => {
  if (!ts.isPropertyAccessExpression(node)) return null;
  const symbol = resolvedSymbol(node.expression);
  return declaredIn(symbol, REASON_CODES_SOURCE, "ReasonCode") ? node.name.text : null;
};

const reasonSource = program.getSourceFile(REASON_CODES_SOURCE);
if (!reasonSource) throw new Error("reason-codes.ts is absent from the program");
const stalenessCodes = new Set();
const collectStalenessCodes = (node) => {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(reasonSource) === "STALENESS_REASON_CODES" &&
    node.initializer
  ) {
    const collect = (candidate) => {
      const name = reasonCodeName(candidate);
      if (name) stalenessCodes.add(name);
      ts.forEachChild(candidate, collect);
    };
    collect(node.initializer);
    return;
  }
  ts.forEachChild(node, collectStalenessCodes);
};
collectStalenessCodes(reasonSource);
if (stalenessCodes.size === 0) throw new Error("STALENESS_REASON_CODES parsed as empty");

const callable = (node) =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node);

const nearestCallable = (node) => {
  let current = node.parent;
  while (current && !callable(current)) current = current.parent;
  return current ?? null;
};

const callableName = (node, source) => {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.name
  ) {
    return node.name.getText(source);
  }
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (ts.isVariableDeclaration(node.parent)) return node.parent.name.getText(source);
    if (ts.isPropertyAssignment(node.parent) || ts.isMethodDeclaration(node.parent)) {
      return node.parent.name.getText(source);
    }
  }
  return "<anonymous>";
};

const ownerOf = (node, source) => {
  const parts = [];
  let current = node.parent;
  while (current) {
    if (callable(current)) parts.unshift(callableName(current, source));
    else if (ts.isClassDeclaration(current) && current.name) parts.unshift(current.name.text);
    current = current.parent;
  }
  return parts.join(".") || "<module>";
};

const siteOf = (node, source) => ({
  file: relative(ROOT, source.fileName),
  line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
  owner: ownerOf(node, source),
  expression: node.getText(source).replace(/\s+/g, " "),
});

const comparisonOperators = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

const unwrap = (candidate) => {
  let node = candidate;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    node = node.expression;
  }
  return node;
};

const literalBoundary = (candidate) => {
  const node = unwrap(candidate);
  return (
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    (ts.isIdentifier(node) && node.text === "undefined") ||
    ts.isTypeOfExpression(node)
  );
};

const controller = (boundary, call) => {
  let child = call;
  let current = call.parent;
  while (current && current !== boundary) {
    if (ts.isIfStatement(current) && (current.thenStatement === child || current.elseStatement === child)) {
      return current.expression;
    }
    if (ts.isConditionalExpression(current) && (current.whenTrue === child || current.whenFalse === child)) {
      return current.condition;
    }
    child = current;
    current = current.parent;
  }
  return null;
};

/** A trailing denial can be controlled by an immediately preceding successful return guard. */
const precedingGuard = (call) => {
  let statement = call;
  while (statement.parent && !ts.isBlock(statement.parent)) statement = statement.parent;
  if (!statement.parent || !ts.isBlock(statement.parent)) return null;
  const index = statement.parent.statements.indexOf(statement);
  if (index <= 0) return null;
  const previous = statement.parent.statements[index - 1];
  if (!ts.isIfStatement(previous) || previous.elseStatement) return null;
  const thenStatement = previous.thenStatement;
  const returns = ts.isReturnStatement(thenStatement)
    ? true
    : ts.isBlock(thenStatement) &&
      thenStatement.statements.length > 0 &&
      ts.isReturnStatement(thenStatement.statements[thenStatement.statements.length - 1]);
  return returns ? previous.expression : null;
};

const canonical = (node, source) =>
  node.getText(source).replace(/\s+/g, "").replace(/\?\./g, ".");

const comparisonsIn = (condition, source) => {
  const pairs = [];
  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      comparisonOperators.has(node.operatorToken.kind) &&
      !literalBoundary(node.left) &&
      !literalBoundary(node.right)
    ) {
      pairs.push({ left: canonical(node.left, source), right: canonical(node.right, source) });
    }
    ts.forEachChild(node, visit);
  };
  visit(condition);
  return pairs;
};

/** Property labels do not count as evidence values; shorthand properties do. */
const evidenceValues = (argument, source) => {
  const values = new Set();
  const visit = (node, parent = null) => {
    if (ts.isPropertyAssignment(node)) {
      visit(node.initializer, node);
      return;
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      values.add(canonical(node.name, source));
      return;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)) {
      values.add(canonical(node, source));
      visit(node.expression, node);
      return;
    }
    if (ts.isCallExpression(node)) {
      values.add(canonical(node, source));
      for (const value of node.arguments) visit(value, node);
      return;
    }
    if (ts.isIdentifier(node) && parent && ts.isPropertyAccessExpression(parent) && parent.name === node) return;
    if (ts.isExpression(node)) values.add(canonical(node, source));
    ts.forEachChild(node, (child) => visit(child, node));
  };
  visit(argument);
  return values;
};

const reasonNamesIn = (node) => {
  const names = new Set();
  const visit = (candidate) => {
    const name = reasonCodeName(candidate);
    if (name) names.add(name);
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return names;
};

const candidateESites = [];

const emptyRoots = () => ({ parameters: new Set(), ambient: new Set(), unknown: new Set() });
const addRoots = (target, source) => {
  for (const value of source.parameters) target.parameters.add(value);
  for (const value of source.ambient) target.ambient.add(value);
  for (const value of source.unknown) target.unknown.add(value);
  return target;
};

const enclosingVariableLike = (declaration) => {
  let current = declaration;
  while (current && ts.isBindingElement(current)) current = current.parent;
  return current;
};

const isModuleLevel = (declaration) => {
  let current = declaration.parent;
  while (current && !ts.isSourceFile(current)) {
    if (callable(current)) return false;
    current = current.parent;
  }
  return true;
};

const declarationLabel = (declaration, source) => {
  const at = source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1;
  const name = "name" in declaration && declaration.name ? declaration.name.getText(source) : declaration.kind;
  return `${relative(ROOT, source.fileName)}:${at}:${name}`;
};

const rootsOf = (candidate, boundary, seen = new Set()) => {
  const node = unwrap(candidate);
  const roots = emptyRoots();
  if (literalBoundary(node)) return roots;

  if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
    roots.ambient.add(node.kind === ts.SyntaxKind.ThisKeyword ? "this" : "super");
    return roots;
  }

  if (ts.isIdentifier(node)) {
    const symbol = resolvedSymbol(node);
    if (!symbol) {
      roots.ambient.add(`global:${node.text}`);
      return roots;
    }
    if (seen.has(symbol)) {
      roots.unknown.add(`cycle:${node.text}`);
      return roots;
    }
    const nextSeen = new Set(seen).add(symbol);
    const declarations = symbol.declarations ?? [];
    if (declarations.length === 0) {
      roots.ambient.add(`global:${node.text}`);
      return roots;
    }
    for (const rawDeclaration of declarations) {
      const declaration = enclosingVariableLike(rawDeclaration);
      const declarationSource = declaration.getSourceFile();
      const label = declarationLabel(declaration, declarationSource);
      if (ts.isParameter(declaration)) {
        roots.parameters.add(label);
      } else if (
        ts.isImportSpecifier(declaration) ||
        ts.isImportClause(declaration) ||
        ts.isNamespaceImport(declaration) ||
        ts.isImportEqualsDeclaration(declaration)
      ) {
        roots.ambient.add(label);
      } else if (ts.isVariableDeclaration(declaration)) {
        if (isModuleLevel(declaration)) {
          roots.ambient.add(label);
        } else if (declaration.initializer) {
          addRoots(roots, rootsOf(declaration.initializer, boundary, nextSeen));
        } else if (ts.isVariableDeclarationList(declaration.parent)) {
          const loop = declaration.parent.parent;
          if (ts.isForOfStatement(loop) || ts.isForInStatement(loop)) {
            addRoots(roots, rootsOf(loop.expression, boundary, nextSeen));
          } else {
            roots.unknown.add(label);
          }
        } else {
          roots.unknown.add(label);
        }
      } else if (ts.isPropertyDeclaration(declaration) || ts.isPropertySignature(declaration)) {
        roots.ambient.add(label);
      } else if (
        ts.isFunctionDeclaration(declaration) ||
        ts.isClassDeclaration(declaration) ||
        ts.isEnumDeclaration(declaration) ||
        ts.isEnumMember(declaration)
      ) {
        roots.ambient.add(label);
      } else {
        roots.unknown.add(label);
      }
    }
    return roots;
  }

  if (ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)) {
    return rootsOf(node.expression, boundary, seen);
  }
  if (ts.isElementAccessExpression(node)) {
    addRoots(roots, rootsOf(node.expression, boundary, seen));
    if (node.argumentExpression) addRoots(roots, rootsOf(node.argumentExpression, boundary, seen));
    return roots;
  }
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    for (const argument of node.arguments ?? []) addRoots(roots, rootsOf(argument, boundary, seen));
    if (ts.isPropertyAccessExpression(node.expression)) {
      addRoots(roots, rootsOf(node.expression.expression, boundary, seen));
    } else if (roots.parameters.size === 0 && roots.ambient.size === 0) {
      addRoots(roots, rootsOf(node.expression, boundary, seen));
    }
    return roots;
  }
  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) addRoots(roots, rootsOf(span.expression, boundary, seen));
    return roots;
  }
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    return rootsOf(node.operand, boundary, seen);
  }
  if (ts.isConditionalExpression(node)) {
    addRoots(roots, rootsOf(node.condition, boundary, seen));
    addRoots(roots, rootsOf(node.whenTrue, boundary, seen));
    addRoots(roots, rootsOf(node.whenFalse, boundary, seen));
    return roots;
  }

  ts.forEachChild(node, (child) => {
    if (ts.isExpression(child)) addRoots(roots, rootsOf(child, boundary, seen));
  });
  if (roots.parameters.size === 0 && roots.ambient.size === 0 && roots.unknown.size === 0) {
    roots.unknown.add(`syntax:${ts.SyntaxKind[node.kind]}`);
  }
  return roots;
};

const rootClass = (roots) => {
  const parameter = roots.parameters.size > 0;
  const ambient = roots.ambient.size > 0;
  if (parameter && ambient) return "mixed";
  if (parameter) return "parameter";
  if (ambient) return "ambient";
  return roots.unknown.size > 0 ? "unknown" : "literal";
};

const candidateFPredicates = [];
const recordCandidateF = (node, source, left, right, kind) => {
  const boundary = nearestCallable(node);
  if (!boundary) return;
  const leftRoots = rootsOf(left, boundary);
  const rightRoots = rootsOf(right, boundary);
  const leftClass = rootClass(leftRoots);
  const rightClass = rootClass(rightRoots);
  const classes = [leftClass, rightClass];
  if (!classes.includes("parameter")) return;
  if (classes.includes("literal")) return;
  candidateFPredicates.push({
    ...siteOf(node, source),
    kind,
    left: left.getText(source).replace(/\s+/g, " "),
    right: right.getText(source).replace(/\s+/g, " "),
    leftClass,
    rightClass,
    leftRoots: {
      parameters: [...leftRoots.parameters],
      ambient: [...leftRoots.ambient],
      unknown: [...leftRoots.unknown],
    },
    rightRoots: {
      parameters: [...rightRoots.parameters],
      ambient: [...rightRoots.ambient],
      unknown: [...rightRoots.unknown],
    },
  });
};

for (const path of sourceNames) {
  const source = program.getSourceFile(path);
  if (!source) continue;
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const symbol = resolvedSymbol(node.expression);
      const kind = declaredIn(symbol, ERRORS_SOURCE, "deny")
        ? "deny"
        : declaredIn(symbol, ERRORS_SOURCE, "fail")
          ? "fail"
          : null;
      if (kind && node.arguments[0]) {
        const reasons = [...reasonNamesIn(node.arguments[0])].filter((name) => stalenessCodes.has(name));
        if (reasons.length > 0) {
          const boundary = nearestCallable(node);
          const condition = boundary ? controller(boundary, node) : null;
          const guard = condition ? null : precedingGuard(node);
          const pairs = condition
            ? comparisonsIn(condition, source)
            : guard
              ? comparisonsIn(guard, source)
              : [];
          const values = node.arguments[2] ? evidenceValues(node.arguments[2], source) : new Set();
          candidateESites.push({
            ...siteOf(node, source),
            kind,
            reasonCodes: reasons,
            hasController: Boolean(condition),
            hasPrecedingGuard: Boolean(guard),
            exposesBothOperands: pairs.some(({ left, right }) => values.has(left) && values.has(right)),
          });
        }
      }

      if (
        ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === "has" || node.expression.name.text === "includes") &&
        node.arguments.length === 1
      ) {
        recordCandidateF(
          node,
          source,
          node.expression.expression,
          node.arguments[0],
          node.expression.name.text,
        );
      }
    }
    if (ts.isBinaryExpression(node) && comparisonOperators.has(node.operatorToken.kind)) {
      recordCandidateF(node, source, node.left, node.right, "binary");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

const eSummary = {
  sites: candidateESites.length,
  deny: candidateESites.filter(({ kind }) => kind === "deny").length,
  fail: candidateESites.filter(({ kind }) => kind === "fail").length,
  controllers: candidateESites.filter(({ hasController }) => hasController).length,
  exposesBothOperands: candidateESites.filter(({ exposesBothOperands }) => exposesBothOperands).length,
};

const candidateFAsymmetries = candidateFPredicates.filter(
  ({ leftClass, rightClass }) =>
    (leftClass === "parameter" && (rightClass === "ambient" || rightClass === "mixed")) ||
    ((leftClass === "ambient" || leftClass === "mixed") && rightClass === "parameter"),
);
const candidateFParameterPairs = candidateFPredicates.filter(
  ({ leftClass, rightClass }) => leftClass === "parameter" && rightClass === "parameter",
);
const candidateFUnresolved = candidateFPredicates.filter(
  ({ leftClass, rightClass }) =>
    !(
      (leftClass === "parameter" && rightClass === "ambient") ||
      (leftClass === "parameter" && rightClass === "mixed") ||
      (leftClass === "ambient" && rightClass === "parameter") ||
      (leftClass === "mixed" && rightClass === "parameter") ||
      (leftClass === "parameter" && rightClass === "parameter")
    ),
);
const validateChunkCoverage = candidateFPredicates.filter(
  ({ file, owner }) => file === "src/review/blind-review.ts" && owner.includes("validateChunkCoverage"),
);
const fSummary = {
  predicates: candidateFPredicates.length,
  parameterPairs: candidateFParameterPairs.length,
  asymmetries: candidateFAsymmetries.length,
  unresolved: candidateFUnresolved.length,
  validateChunkCoveragePredicates: validateChunkCoverage.length,
  validateChunkCoverageParameterPairs: validateChunkCoverage.filter(
    ({ leftClass, rightClass }) => leftClass === "parameter" && rightClass === "parameter",
  ).length,
};

const result = {
  measuredCommit: "working-tree",
  productionTypeScriptFiles: sourceNames.length,
  candidateE: { summary: eSummary, sites: candidateESites },
  candidateF: {
    summary: fSummary,
    parameterPairs: candidateFParameterPairs,
    asymmetries: candidateFAsymmetries,
    unresolved: candidateFUnresolved,
    validateChunkCoverage,
  },
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  console.log(`production TypeScript files: ${sourceNames.length}`);
  console.log(
    `candidate E: ${eSummary.sites} sites; ${eSummary.deny} deny; ${eSummary.fail} fail; ` +
      `${eSummary.controllers} controlled; ${eSummary.exposesBothOperands} expose both operands`,
  );
  console.log(
    `candidate F: ${fSummary.predicates} predicates; ${fSummary.parameterPairs} parameter pairs; ` +
      `${fSummary.asymmetries} parameter/ambient asymmetries; ${fSummary.unresolved} unresolved`,
  );
  console.log(
    `validateChunkCoverage: ${fSummary.validateChunkCoveragePredicates} predicates; ` +
      `${fSummary.validateChunkCoverageParameterPairs} parameter pairs`,
  );
  console.log("candidate F asymmetries:");
  for (const site of candidateFAsymmetries) {
    console.log(
      `  ${site.file}:${site.line} ${site.owner} [${site.leftClass}/${site.rightClass}] ${site.expression}`,
    );
  }
}
