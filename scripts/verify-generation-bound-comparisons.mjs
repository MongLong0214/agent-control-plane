#!/usr/bin/env node
/**
 * Verifies that a staleness comparison carries both compared generations.
 *
 * A comparison site is a call to the `deny` symbol exported by `src/core/errors.ts` whose
 * reason-code argument is a member of `STALENESS_REASON_CODES`. That AST shape is the exact
 * point where production turns a generation mismatch into a two-way Decision; it does not rely
 * on function prefixes, a hand-written source inventory, every Decision return, or `.allowed`
 * consumers.
 *
 * A site carries both generations when a non-literal comparison controlling that call passes
 * both exact operands in the evidence argument. Evidence property names do not count and are
 * never inspected. Optional property access is normalized with ordinary property access because
 * it is the same operand guarded by an existence check in the controlling condition.
 */
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_ROOT = resolve(ROOT, "src");
const ERRORS_SOURCE = resolve(SOURCE_ROOT, "core", "errors.ts");
const REASON_CODES_SOURCE = resolve(SOURCE_ROOT, "core", "reason-codes.ts");

/**
 * Structural ids, not line numbers. The condition hash makes an edited legacy comparison stale
 * while unrelated line insertions do not. Each legacy shape lacks a direct pair at this site;
 * new sites receive no exemption.
 */
const EXEMPTIONS = [
  {
    target: "src/ceo/production-gate.ts::ProductionGate.submitCeoDecision::EVIDENCE_STALE::1bc952b63184",
    why: "the legacy denial is selected by an absent packet, so there is no second generation operand in this branch",
  },
  {
    target: "src/ceo/production-gate.ts::ProductionGate.revalidateCandidateFreshness::SNAPSHOT_STALE::e083d2aa9d88",
    why: "the legacy site receives an aggregate drift list after repository generations were compared in a helper",
  },
  {
    target: "src/ceo/production-gate.ts::ProductionGate.recordOwnerDecision::EVIDENCE_STALE::5e1751f40924",
    why: "the legacy denial reports a missing candidate digest rather than a direct two-generation comparison",
  },
  {
    target: "src/conversation/turn-coordinator.ts::ConversationTurnCoordinator.claim::CONVERSATION_TARGET_ATTESTATION_STALE::119bd900019b",
    why: "the legacy denial reports an absent attestation, so only the target generation is available",
  },
  {
    target: "src/daemon/agentcpd.ts::authenticateSocketPeer::BINDING_GENERATION_STALE::c6492b072f37",
    why: "the legacy denial reports that no binding candidate exists instead of comparing two binding generations",
  },
  {
    target: "src/daemon/agentcpd.ts::currentPendingNormalHandoff::BINDING_GENERATION_STALE::74eed55db733",
    why: "the legacy denial is based on a handoff-row cardinality aggregate, not two generation operands",
  },
  {
    target: "src/daemon/agentcpd.ts::currentPendingNormalHandoff::BINDING_GENERATION_STALE::ff3fe026e861",
    why: "the legacy denial reports a missing outgoing handoff fence, leaving no second generation to pass",
  },
  {
    target: "src/daemon/agentcpd.ts::peerAuthenticator::BINDING_GENERATION_STALE::2289a96272b1",
    why: "the legacy combined predicate can fail before the pending handoff value and its generation exist",
  },
  {
    target: "src/daemon/finalizer.ts::ApprovedRunFinalizer.reconfirmAndPlan::EVIDENCE_STALE::2b4c3484046f",
    why: "the legacy denial reports an absent or superseded snapshot artifact rather than a direct pair",
  },
  {
    target: "src/github/confirmed-merge-operation.ts::deriveConfirmedMergePlan::EVIDENCE_STALE::a8e42bef75fb",
    why: "the legacy combined predicate can fail before a production packet supplies its candidate generation",
  },
  {
    target: "src/github/github-kernel.ts::GitHubKernel.finishPreparedPr::MERGE_HEAD_STALE::e5cc83e1ca82",
    why: "the legacy evidence groups the reread pull object instead of passing each compared ref operand",
  },
  {
    target: "src/github/github-kernel.ts::GitHubKernel.mergeExecute::MERGE_HEAD_STALE::88d170db66af",
    why: "the legacy denial translates GitHub's merged boolean and has no second head generation operand",
  },
  {
    target: "src/github/github-kernel.ts::GitHubKernel.assertExecutedMergeProof::MERGE_BASE_STALE::7b341505f55c",
    why: "the legacy denial is controlled by a derived ancestry boolean rather than the compared base pair",
  },
  {
    target: "src/github/github-kernel.ts::GitHubKernel.assertMergedOntoBase::MERGE_BASE_STALE::91b0be5308e0",
    why: "the legacy site translates a denial returned by the ancestry helper and has no direct controlling comparison",
  },
  {
    target: "src/guard/managed-write-guard.ts::ManagedWriteGuard.revalidate::WRITE_BINDING_GENERATION_STALE::663c2237045c",
    why: "the legacy site delegates its multi-field generation comparison to sameAuthorisationFacts",
  },
  {
    target: "src/guard/managed-write-guard.ts::ManagedWriteGuard.authorizeSession::WRITE_BINDING_GENERATION_STALE::b4d98e097c67",
    why: "the legacy denial reports that no claimed binding matches, so no matched generation pair exists",
  },
  {
    target: "src/ingress/telegram-router.ts::TelegramHermesRouter.prepareOwnerPrompt::EVIDENCE_STALE::5e1751f40924",
    why: "the legacy denial reports a missing candidate snapshot digest rather than comparing two digests",
  },
  {
    target: "src/mcp/ceo-conversation.ts::CeoConversationPort.ask::CEO_CONVERSATION_STALE::0a157e136d5c",
    why: "the legacy site translates a stale authenticator denial and cannot see the comparison operands it used",
  },
  {
    target: "src/mcp/cto-server.ts::assertCtoRunPeerFromSource::BINDING_GENERATION_STALE::fc654b35506d",
    why: "the legacy combined peer predicate records no identity or generation operands in its denial evidence",
  },
  {
    target: "src/outbox/outbox.ts::Outbox.markSent::OUTBOX_STALE_GENERATION_REJECTED::a36a1e9cd36b",
    why: "the legacy denial is derived from an update cardinality and no longer has both claim generations",
  },
  {
    target: "src/outbox/outbox.ts::Outbox.staleClaim::OUTBOX_STALE_GENERATION_REJECTED::72a17f2e3149",
    why: "the legacy helper is called after the claim comparison and has no direct controlling condition",
  },
  {
    target: "src/review/blind-review.ts::BlindReviewGate.review::BINDING_GENERATION_STALE::fd947c873610",
    why: "the legacy isCurrent predicate accepts one generation and hides the current generation lookup",
  },
  {
    target: "src/run/run-engine.ts::RunEngine.assertOwner::BINDING_GENERATION_STALE::0173bd2a2c3c",
    why: "the legacy evidence records pinned and current generations but omits the presented comparison operand",
  },
  {
    target: "src/session/binding-registry.ts::BindingRegistry.switchTo::BINDING_GENERATION_STALE::47caf6e969de",
    why: "the legacy denial is based on a SQL-produced stale-execution aggregate rather than a direct pair",
  },
  {
    target: "src/snapshot/candidate-snapshot.ts::verifySnapshotFreshness::SNAPSHOT_STALE::515b01d63a23",
    why: "the legacy site receives an aggregate drift list after each repository comparison has already run",
  },
];

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
if (!configPath) {
  console.error("verify-generation-bound-comparisons: tsconfig.json is missing");
  process.exit(2);
}
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) {
  console.error("verify-generation-bound-comparisons: tsconfig.json could not be read");
  process.exit(2);
}
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
const sourceNames = sourcesBelow(SOURCE_ROOT);
const program = ts.createProgram({ rootNames: sourceNames, options: parsed.options });
const checker = program.getTypeChecker();

const resolveSymbol = (node) => {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return null;
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
};

const declaredIn = (symbol, path, name) =>
  symbol?.declarations?.some((declaration) => {
    if (resolve(declaration.getSourceFile().fileName) !== path || !("name" in declaration)) return false;
    return declaration.name?.getText() === name;
  }) ?? false;

const isCoreDeny = (node) =>
  ts.isCallExpression(node) && declaredIn(resolveSymbol(node.expression), ERRORS_SOURCE, "deny");
const isReasonCodeObject = (node) =>
  declaredIn(resolveSymbol(node), REASON_CODES_SOURCE, "ReasonCode");
const reasonCodeName = (node) =>
  ts.isPropertyAccessExpression(node) && isReasonCodeObject(node.expression) ? node.name.text : null;

const reasonSource = program.getSourceFile(REASON_CODES_SOURCE);
if (!reasonSource) {
  console.error("verify-generation-bound-comparisons: reason-codes.ts is absent from the program");
  process.exit(2);
}
const stalenessCodes = new Set();
let foundStalenessSet = false;
const collectStalenessCodes = (node) => {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(reasonSource) === "STALENESS_REASON_CODES" &&
    node.initializer
  ) {
    foundStalenessSet = true;
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
if (!foundStalenessSet || stalenessCodes.size === 0) {
  console.error("verify-generation-bound-comparisons: STALENESS_REASON_CODES parsed as empty");
  process.exit(1);
}

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
const canonical = (node, source) =>
  node.getText(source).replace(/\s+/g, "").replace(/\?\./g, ".");
const literalBoundary = (candidate) => {
  let node = candidate;
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    node = node.expression;
  }
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

/** Property names are not values; shorthand names are. */
const valuesIn = (argument, source) => {
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

const callable = (node) =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node);
const nearestCallable = (node) => {
  let current = node.parent;
  while (current && !callable(current)) current = current.parent;
  return current ?? null;
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
const callableName = (node, source) => {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
    return node.name.getText(source);
  }
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (ts.isVariableDeclaration(node.parent)) return node.parent.name.getText(source);
    if (ts.isPropertyAssignment(node.parent)) return node.parent.name.getText(source);
  }
  return null;
};
const ownerOf = (call, source) => {
  const parts = [];
  let current = call.parent;
  while (current) {
    if (callable(current)) {
      const name = callableName(current, source);
      if (name) parts.unshift(name);
    } else if (ts.isClassDeclaration(current) && current.name) parts.unshift(current.name.text);
    current = current.parent;
  }
  return parts.join(".") || "<module>";
};
const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 12);

const discoverComparisonSites = () => {
  const sites = [];
  for (const path of sourceNames) {
    const source = program.getSourceFile(path);
    if (!source) continue;
    const visit = (node) => {
      if (isCoreDeny(node)) {
        const reasonCode = node.arguments[0] ? reasonCodeName(node.arguments[0]) : null;
        if (reasonCode && stalenessCodes.has(reasonCode)) {
          const boundary = nearestCallable(node);
          const condition = boundary ? controller(boundary, node) : null;
          const comparisons = condition ? comparisonsIn(condition, source) : [];
          const values = node.arguments[2] ? valuesIn(node.arguments[2], source) : new Set();
          const boundComparison = comparisons.find(
            ({ left, right }) => values.has(left) && values.has(right),
          );
          const owner = ownerOf(node, source);
          const signature = condition
            ? canonical(condition, source)
            : `${owner}:${canonical(node.arguments[1] ?? node, source)}`;
          sites.push({
            file: relative(ROOT, path),
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            owner,
            reasonCode,
            condition: condition?.getText(source).replace(/\s+/g, " ") ?? "<no direct condition>",
            boundComparison,
            target: `${relative(ROOT, path)}::${owner}::${reasonCode}::${hash(signature)}`,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
};

const sites = discoverComparisonSites();
if (sites.length === 0) {
  console.error("verify-generation-bound-comparisons: found zero comparison sites; refusing an unmeasured pass");
  process.exit(1);
}

const siteTargets = sites.map(({ target }) => target);
const duplicateSites = [...new Set(siteTargets)].filter(
  (target) => siteTargets.filter((candidate) => candidate === target).length !== 1,
);
if (duplicateSites.length > 0) {
  console.error("verify-generation-bound-comparisons: structural site ids are not unique");
  for (const target of duplicateSites) console.error(`  - ${target}`);
  process.exit(1);
}
const exemptionTargets = EXEMPTIONS.map(({ target }) => target);
const invalidExemptions = EXEMPTIONS.filter(
  ({ target, why }) => typeof target !== "string" || typeof why !== "string" || why.trim().length === 0,
);
if (invalidExemptions.length > 0 || new Set(exemptionTargets).size !== exemptionTargets.length) {
  console.error("verify-generation-bound-comparisons: every exemption needs one unique target and a reason");
  process.exit(1);
}

const unbound = sites.filter(({ boundComparison }) => !boundComparison);
const unboundTargets = new Set(unbound.map(({ target }) => target));
const staleExemptions = EXEMPTIONS.filter(({ target }) => !unboundTargets.has(target));
if (staleExemptions.length > 0) {
  console.error("verify-generation-bound-comparisons: stale exemption target(s)");
  for (const exemption of staleExemptions) console.error(`  - ${exemption.target}: ${exemption.why}`);
  process.exit(1);
}

const exemptTargets = new Set(exemptionTargets);
const failures = unbound.filter(({ target }) => !exemptTargets.has(target));
if (failures.length > 0) {
  console.error(`verify-generation-bound-comparisons: ${failures.length} unbound comparison site(s)`);
  for (const failure of failures) {
    console.error(`  - ${failure.target}`);
    console.error(`    ${failure.file}:${failure.line} ${failure.condition}`);
    console.error("    no controlling comparison passes both operands in the evidence argument");
  }
  process.exit(1);
}

console.log(
  `verify-generation-bound-comparisons: ${sites.length} comparison site(s), ` +
    `${sites.length - unbound.length} pass both generation operands, ${EXEMPTIONS.length} legacy exemption(s)`,
);
