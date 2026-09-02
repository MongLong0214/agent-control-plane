import { readFileSync } from "node:fs";

import ts from "typescript";

/**
 * Which migrations can reach the schema-snapshot replay, resolved through the call graph (#762).
 *
 * The previous version of this matched `^  id: "…"` with a regular expression and attributed a
 * call to whichever id appeared above it in the file. Two ways that is wrong, both raised in
 * review: a call moved into a helper is attributed to nothing, and a call in a function declared
 * between two migration literals is attributed to the earlier one. Either way a new caller can
 * appear and the classification still reports the same two names — a check that answers with its
 * own past.
 *
 * So this walks the source. A migration is a reacher when its `apply` reaches the replay
 * function, directly or through any chain of module-local functions.
 */
export const REPLAY_FUNCTION = "replayDdlWithoutPostV12Columns";

interface FunctionBody {
  name: string;
  node: ts.Node;
}

/** Every module-local function-ish declaration, by the name a call site would use. */
const moduleFunctions = (source: ts.SourceFile): Map<string, ts.Node> => {
  const found = new Map<string, ts.Node>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      found.set(statement.name.text, statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (
        ts.isArrowFunction(declaration.initializer) ||
        ts.isFunctionExpression(declaration.initializer)
      ) {
        found.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return found;
};

/** Names called anywhere inside `node`, including through property access. */
const calleesIn = (node: ts.Node): Set<string> => {
  const called = new Set<string>();
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child)) {
      const callee = child.expression;
      if (ts.isIdentifier(callee)) called.add(callee.text);
      else if (ts.isPropertyAccessExpression(callee)) called.add(callee.name.text);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return called;
};

/** Each migration literal's `apply` body, keyed by the migration's own `id`. */
const migrationApplyBodies = (source: ts.SourceFile): FunctionBody[] => {
  const bodies: FunctionBody[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      let id: string | null = null;
      let apply: ts.Node | null = null;
      for (const property of node.properties) {
        const name =
          property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
            ? property.name.text
            : null;
        if (name === "id" && ts.isPropertyAssignment(property)) {
          if (ts.isStringLiteral(property.initializer)) id = property.initializer.text;
        }
        if (name === "apply") {
          if (ts.isMethodDeclaration(property)) apply = property;
          else if (ts.isPropertyAssignment(property)) apply = property.initializer;
        }
      }
      // Both, or it is not a migration: an object with an `id` and no `apply` is a trigger
      // descriptor, and one with an `apply` and no `id` is not something the registry runs.
      if (id !== null && apply !== null) bodies.push({ name: id, node: apply });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bodies;
};

/**
 * Migration ids whose `apply` reaches `REPLAY_FUNCTION` through any chain of module-local calls.
 *
 * The traversal is closed over the module's own functions, which is where a "moved to a helper"
 * call goes. A call that leaves the module entirely is out of reach of this file and is stated as
 * such rather than silently treated as non-reaching — `unresolved` carries those names.
 */
export const migrationsReachingTheReplay = (
  sourcePath: string,
): { reaching: string[]; unresolved: string[] } => {
  const text = readFileSync(sourcePath, "utf8");
  const source = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.ES2022, true);
  const functions = moduleFunctions(source);

  const reachesCache = new Map<string, boolean>();
  const unresolved = new Set<string>();

  const reaches = (name: string, seen: Set<string>): boolean => {
    if (name === REPLAY_FUNCTION) return true;
    const cached = reachesCache.get(name);
    if (cached !== undefined) return cached;
    if (seen.has(name)) return false;
    seen.add(name);
    const body = functions.get(name);
    if (!body) {
      // Not declared in this module. Recorded rather than assumed absent — an assumption here is
      // how a helper in another file would become an invisible replay caller.
      unresolved.add(name);
      return false;
    }
    const result = [...calleesIn(body)].some((callee) => reaches(callee, seen));
    reachesCache.set(name, result);
    return result;
  };

  const reaching: string[] = [];
  for (const migration of migrationApplyBodies(source)) {
    const callees = calleesIn(migration.node);
    if ([...callees].some((callee) => reaches(callee, new Set()))) reaching.push(migration.name);
  }
  return { reaching: reaching.sort(), unresolved: [...unresolved].sort() };
};
