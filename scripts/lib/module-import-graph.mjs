/**
 * `file -> the repository-relative files it imports`, parsed rather than matched.
 *
 * #885. The affected closure takes this graph as a value so it can be handed a counterexample;
 * this is the part that reads the tree, kept separate for that reason.
 *
 * Only **relative** specifiers become edges. A bare specifier is a package, and a package this
 * repository does not edit cannot be the changed file a closure is looking for — while a `node:`
 * builtin cannot change at all. What that means for the caller is stated rather than assumed: a
 * file whose specifier this cannot resolve is reported in `undecidable`, and the closure turns any
 * non-empty `undecidable` into a full sweep. A graph that silently dropped an edge would make a
 * row look unaffected, which is the one direction that must not fail quietly.
 *
 * Extensions are resolved by trying the specifier as written first — this repository writes
 * `../foo.ts` explicitly, which is why that is the common case — then `.ts`, `.mjs`, `/index.ts`.
 * A specifier that resolves to nothing on disk is `undecidable`, not an absent edge.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import ts from "typescript";

const CANDIDATE_SUFFIXES = ["", ".ts", ".mjs", ".mts", "/index.ts", "/index.mjs"];

/** Every `.ts`/`.mjs` file under the given roots, repository-relative and sorted. */
export const moduleFilesUnder = (root, directories) => {
  const found = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|mts|mjs)$/.test(entry)) found.push(relative(root, path));
    }
  };
  for (const directory of directories) walk(join(root, directory));
  return found.sort();
};

/**
 * @returns `{ imports, undecidable }` — the graph, and every `file -> specifier` this could not
 *          resolve to a path on disk.
 */
export const buildImportGraph = (root, files) => {
  const imports = new Map();
  const undecidable = [];

  for (const file of files) {
    const absolute = join(root, file);
    const source = ts.createSourceFile(
      absolute,
      readFileSync(absolute, "utf8"),
      ts.ScriptTarget.ES2022,
      true,
    );
    const edges = [];
    const visit = (node) => {
      const specifier =
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : ts.isCallExpression(node) &&
              node.expression.kind === ts.SyntaxKind.ImportKeyword &&
              node.arguments[0] !== undefined &&
              ts.isStringLiteral(node.arguments[0])
            ? node.arguments[0].text
            : null;
      if (specifier !== null && specifier.startsWith(".")) {
        const from = resolve(dirname(absolute), specifier);
        const hit = CANDIDATE_SUFFIXES.map((suffix) => `${from}${suffix}`).find(
          (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
        );
        if (hit === undefined) undecidable.push(`${file} -> ${specifier}`);
        else edges.push(relative(root, hit));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    imports.set(file, [...new Set(edges)].sort());
  }

  return { imports, undecidable: undecidable.sort() };
};
