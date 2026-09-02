import { readFileSync } from "node:fs";

import ts from "typescript";

/**
 * Which registered migrations can reach the schema-snapshot replay (#762).
 *
 * Three versions of this have been wrong, each in a way the next review named:
 *
 *   1. a regular expression over `id: "…"` plus a text slice — a call moved into a helper was
 *      attributed to nothing, and a call between two literals to the earlier one;
 *   2. an AST walk that treated *any* object literal with a string `id` and an `apply` as a
 *      migration, so the answer described objects the registry never runs, and its controls
 *      asserted that an unregistered literal counts — the opposite of the contract;
 *   3. both of the above computed an `unresolved` set and returned `false` for those edges, so a
 *      call into an imported helper read as "does not reach" rather than "cannot tell".
 *
 * This one starts from the exported registry and fails closed. A call it cannot follow inside
 * this module is not evidence of absence, and the caller is told so rather than reassured.
 */
export const REPLAY_FUNCTION = "replayDdlWithoutPostV12Columns";

/** The name of the exported array the production code actually runs. */
const REGISTRY = "MIGRATIONS";

export interface ReplayReachability {
  /** Registered migration ids whose `apply` reaches the replay through module-local calls. */
  reaching: string[];
  /**
   * Call edges that leave this module: an imported function, or a method on an imported object.
   *
   * These are followable only in the sense that another module could route back here — and it
   * could only do so by importing the replay function, which is a fact about the import graph
   * rather than about this file. The consumer checks that separately; what matters here is that
   * the set is reported rather than silently read as "does not reach".
   */
  external: string[];
  /**
   * Bare calls to a name that is neither declared in this file nor imported by it.
   *
   * There is no sound reading of these, so a non-empty set is a failure: it means the walk lost
   * track of the program, and every answer above it is a guess.
   */
  unfollowable: string[];
  /** Registry entries whose declaration could not be found — same fail-closed reasoning. */
  unresolvedRegistryEntries: string[];
}

/**
 * Every function-ish declaration in the file, at any depth, by the name a call site would use.
 *
 * Top-level only was not enough: `names` and `normalise` are arrow constants declared inside other
 * functions, and treating them as unfollowable filled the fail-closed set with edges that are
 * plainly local — which is how a fail-closed set stops being read.
 */
const moduleFunctions = (source: ts.SourceFile): Map<string, ts.Node> => {
  const found = new Map<string, ts.Node>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) found.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        found.set(node.name.text, node.initializer);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

/** Module-local `const <name> = <object literal>` declarations, by name. */
const moduleObjects = (source: ts.SourceFile): Map<string, ts.ObjectLiteralExpression> => {
  const found = new Map<string, ts.ObjectLiteralExpression>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (ts.isObjectLiteralExpression(declaration.initializer)) {
        found.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return found;
};

/** Everything imported into this module — the names a call may not be followed through. */
const importedNames = (source: ts.SourceFile): Set<string> => {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const clause = statement.importClause;
    if (clause.name) names.add(clause.name.text);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) names.add(element.name.text);
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      names.add(clause.namedBindings.name.text);
    }
  }
  return names;
};

/**
 * Calls made inside `node`, split by what the call site can be followed through.
 *
 * `bare` is `foo()` — a name that must be a module-local function or an import, so an unfollowable
 * one is a hole. `viaImportedObject` is `helpers.foo()` where `helpers` is imported: the callee
 * lives in another module and is a hole for the same reason. Everything else is a method on a
 * value (`raw.exec`, `list.map`), which is not a route to another module function and would
 * otherwise fill the unresolved set with `push` and `map` until nobody read it.
 */
const calleesIn = (
  node: ts.Node,
  imported: ReadonlySet<string>,
): { bare: Set<string>; viaImportedObject: Set<string> } => {
  const bare = new Set<string>();
  const viaImportedObject = new Set<string>();
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child)) {
      const callee = child.expression;
      if (ts.isIdentifier(callee)) bare.add(callee.text);
      else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        imported.has(callee.expression.text)
      ) {
        viaImportedObject.add(`${callee.expression.text}.${callee.name.text}`);
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return { bare, viaImportedObject };
};

/** The identifiers listed in the exported registry array, in order. */
const registryEntryNames = (source: ts.SourceFile): string[] => {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== REGISTRY) continue;
      // `Object.freeze([...])` and a bare array literal are both spellings of the same list.
      let value: ts.Node | undefined = declaration.initializer;
      if (value && ts.isCallExpression(value) && value.arguments.length === 1) {
        value = value.arguments[0];
      }
      if (!value || !ts.isArrayLiteralExpression(value)) return [];
      return value.elements.flatMap((element) =>
        ts.isIdentifier(element) ? [element.text] : ["<non-identifier registry entry>"],
      );
    }
  }
  return [];
};

/** `{ id, apply }` read off a migration object literal. */
const migrationShape = (
  literal: ts.ObjectLiteralExpression,
): { id: string | null; apply: ts.Node | null } => {
  let id: string | null = null;
  let apply: ts.Node | null = null;
  for (const property of literal.properties) {
    const name =
      property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        ? property.name.text
        : null;
    if (name === "id" && ts.isPropertyAssignment(property) && ts.isStringLiteral(property.initializer)) {
      id = property.initializer.text;
    }
    if (name === "apply") {
      if (ts.isMethodDeclaration(property)) apply = property;
      else if (ts.isPropertyAssignment(property)) apply = property.initializer;
    }
  }
  return { id, apply };
};

/**
 * Reachability from the exported registry, fail-closed on every edge this file cannot follow.
 *
 * Only registry members are answered for: an object literal that is never listed is not something
 * production runs, and reporting it would describe a program that does not exist.
 */
export const migrationsReachingTheReplay = (sourcePath: string): ReplayReachability => {
  const text = readFileSync(sourcePath, "utf8");
  const source = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.ES2022, true);
  const functions = moduleFunctions(source);
  const objects = moduleObjects(source);
  const imported = importedNames(source);

  const external = new Set<string>();
  const unfollowable = new Set<string>();
  const cache = new Map<string, boolean>();

  const reaches = (name: string, seen: Set<string>): boolean => {
    if (name === REPLAY_FUNCTION) return true;
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
    if (seen.has(name)) return false;
    seen.add(name);
    const body = functions.get(name);
    if (!body) {
      // Imported, re-exported, or declared somewhere this walk does not see. Either way the
      // answer for this edge is unknown, and unknown is recorded rather than read as "no".
      if (imported.has(name)) external.add(name);
      else if (!objects.has(name)) unfollowable.add(name);
      return false;
    }
    const calls = calleesIn(body, imported);
    for (const escaped of calls.viaImportedObject) external.add(escaped);
    const result = [...calls.bare].some((callee) => reaches(callee, seen));
    cache.set(name, result);
    return result;
  };

  const reaching: string[] = [];
  const unresolvedRegistryEntries: string[] = [];
  for (const entry of registryEntryNames(source)) {
    const literal = objects.get(entry);
    if (!literal) {
      unresolvedRegistryEntries.push(entry);
      continue;
    }
    const { id, apply } = migrationShape(literal);
    if (id === null || apply === null) {
      unresolvedRegistryEntries.push(entry);
      continue;
    }
    const calls = calleesIn(apply, imported);
    for (const escaped of calls.viaImportedObject) external.add(escaped);
    if ([...calls.bare].some((callee) => reaches(callee, new Set()))) reaching.push(id);
  }

  return {
    reaching: reaching.sort(),
    external: [...external].filter((name) => name !== REPLAY_FUNCTION).sort(),
    unfollowable: [...unfollowable].sort(),
    unresolvedRegistryEntries: unresolvedRegistryEntries.sort(),
  };
};
