#!/usr/bin/env node
/**
 * Every direct `Db.run` call in `src` has inline SQL, and each one that names a turn-fence table
 * is in that table's declared application owner.
 *
 * This is deliberately an ownership check, not a JavaScript partial evaluator. `Db.run` is the
 * named application mutation surface. A call either supplies its final string literal right at
 * that surface, or the check fails closed without trying to compute identifiers, arrays,
 * `.concat()`, `String.raw`, imported constants, or any other JavaScript expression.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLAIM =
  "Every direct Db.run call in src has inline SQL, and each one that names a turn-fence table is in that table's declared application owner.";
const BOUNDARY =
  "Under src, this check covers direct property calls whose TypeScript symbol is Db.run, and " +
  "their first argument must be a string literal or no-substitution template literal at the " +
  "call site; schema.sql coverage is limited to INSERT, UPDATE, REPLACE, DELETE, and ALTER TABLE " +
  "RENAME TO after SQL comments are blanked; named migration rebuild functions are reported but " +
  "their SQL is not evaluated; casts to any, reflection, generated code, other SQL APIs, and code " +
  "outside src are not covered.";

process.stdout.write(`CHECK: ${CLAIM}\nBOUNDARY: ${BOUNDARY}\n`);

/** Blank SQL comments while preserving quoted SQL values and line positions. */
const stripSqlComments = (source) => {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "-" && next === "-") {
      out += "  ";
      i += 2;
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      let end = i + 2;
      while (end < source.length && !(source[end] === "*" && source[end + 1] === "/")) end++;
      if (end < source.length) end += 2;
      out += source.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      let end = i + 1;
      while (end < source.length) {
        if (source[end] === quote && source[end + 1] === quote) {
          end += 2;
          continue;
        }
        if (source[end] === quote) {
          end++;
          break;
        }
        end++;
      }
      out += source.slice(i, end);
      i = end;
      continue;
    }
    if (c === "[") {
      let end = i + 1;
      while (end < source.length && source[end] !== "]") end++;
      if (end < source.length) end++;
      out += source.slice(i, end);
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
};

const IDENT = String.raw`(?:[A-Za-z_]\w*|"(?:[^"]|"")*"|\`[^\`]*\`|\[[^\]]*\])`;
const unquoteIdent = (raw) => {
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1).replace(/""/g, '"');
  if (raw.startsWith("`") && raw.endsWith("`")) return raw.slice(1, -1);
  if (raw.startsWith("[") && raw.endsWith("]")) return raw.slice(1, -1);
  return raw;
};

const schema = readFileSync(join(ROOT, "src/db/schema.sql"), "utf8");
const strippedSchema = stripSqlComments(schema);
const CREATE_TABLE = new RegExp(
  String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:${IDENT}\s*\.\s*)?(${IDENT})\s*\(`,
  "gi",
);
const governedTables = [
  ...new Set(
    [...strippedSchema.matchAll(CREATE_TABLE)]
      .map((match) => unquoteIdent(match[1]))
      .filter((name) => /^(?:canonical_turn\w*|actor_target_\w+)$/i.test(name)),
  ),
].sort();

if (governedTables.length === 0) {
  process.stdout.write("RESULT: FAIL — found zero canonical_turn*/actor_target_* tables in the schema.\n");
  process.exit(1);
}

const APPLICATION_OWNERS = {
  canonical_turns: ["src/conversation/turn-coordinator.ts"],
  canonical_turn_sources: ["src/conversation/turn-coordinator.ts"],
  canonical_turn_observations: ["src/conversation/turn-coordinator.ts"],
  canonical_turn_dispatches: ["src/conversation/turn-coordinator.ts"],
  canonical_turn_adjudications: ["src/conversation/turn-coordinator.ts"],
  canonical_turn_adjudication_citations: ["src/conversation/turn-coordinator.ts"],
  actor_target_bindings: ["src/session/binding-registry.ts"],
  actor_target_attestations: [],
};

/** Migrations are an infrastructure owner through these named rebuild functions, not `Db.run`. */
const MIGRATION_REBUILD_SURFACES = {
  canonical_turns: "rebuildCanonicalTurnsIfStale",
  canonical_turn_observations: "rebuildObservationsIfStale",
};
const MIGRATIONS_FILE = "src/db/migrations.ts";

const unowned = governedTables.filter((table) => !(table in APPLICATION_OWNERS));
if (unowned.length > 0) {
  process.stdout.write(
    `RESULT: FAIL — the schema declares ${unowned.join(", ")} and this check has no application-owner entry for it.\n`,
  );
  process.exit(1);
}

const orphanedOwners = Object.keys(APPLICATION_OWNERS).filter(
  (table) => !governedTables.includes(table),
);
const orphanedRebuilds = Object.keys(MIGRATION_REBUILD_SURFACES).filter(
  (table) => !governedTables.includes(table),
);
if (orphanedOwners.length > 0 || orphanedRebuilds.length > 0) {
  process.stdout.write(
    `RESULT: FAIL — declared ownership names tables the schema no longer declares: ${[
      ...orphanedOwners,
      ...orphanedRebuilds,
    ].join(", ")}.\n`,
  );
  process.exit(1);
}

const configPath = join(ROOT, "tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error !== undefined) {
  process.stdout.write(`RESULT: FAIL — could not read tsconfig.json: ${config.error.messageText}.\n`);
  process.exit(1);
}
const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT, { noEmit: true });
if (parsedConfig.errors.length > 0) {
  process.stdout.write(
    `RESULT: FAIL — could not parse tsconfig.json: ${parsedConfig.errors[0].messageText}.\n`,
  );
  process.exit(1);
}
const program = ts.createProgram({ rootNames: parsedConfig.fileNames, options: parsedConfig.options });
const checker = program.getTypeChecker();
const databaseFile = program.getSourceFile(join(ROOT, "src/db/database.ts"));
let dbRunDeclaration;
if (databaseFile !== undefined) {
  for (const statement of databaseFile.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== "Db") continue;
    dbRunDeclaration = statement.members.find(
      (member) =>
        ts.isMethodDeclaration(member) &&
        ((ts.isIdentifier(member.name) && member.name.text === "run") ||
          (ts.isStringLiteral(member.name) && member.name.text === "run")),
    );
  }
}
if (dbRunDeclaration === undefined) {
  process.stdout.write("RESULT: FAIL — could not find the named Db.run mutation surface.\n");
  process.exit(1);
}

const sameDeclaration = (declaration) =>
  declaration !== undefined &&
  declaration.getSourceFile().fileName === dbRunDeclaration.getSourceFile().fileName &&
  declaration.pos === dbRunDeclaration.pos;
const symbolIsDbRun = (symbol) =>
  symbol !== undefined && symbol.declarations?.some((declaration) => sameDeclaration(declaration));

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tablePattern = new Map(
  governedTables.map((table) => [
    table,
    new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRegex(table)}(?![A-Za-z0-9_])`, "i"),
  ]),
);
const callsByTable = new Map(governedTables.map((table) => [table, []]));
const nonInlineCalls = [];
const escapedRunReferences = [];

const relativeSourceFile = (sourceFile) =>
  relative(ROOT, isAbsolute(sourceFile.fileName) ? sourceFile.fileName : resolve(ROOT, sourceFile.fileName));
const directLiteral = (expression) => {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current) ? current : undefined;
};
const locationOf = (sourceFile, node) => {
  const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file: relativeSourceFile(sourceFile), line: point.line + 1 };
};

const inspectRunCall = (sourceFile, call) => {
  const location = locationOf(sourceFile, call);
  const argument = call.arguments[0];
  const literal = argument === undefined ? undefined : directLiteral(argument);
  if (literal === undefined) {
    nonInlineCalls.push({
      ...location,
      shape: argument === undefined ? "missing argument" : ts.SyntaxKind[argument.kind],
      source: argument?.getText(sourceFile).replace(/\s+/g, " ").slice(0, 100) ?? "<none>",
    });
    return;
  }
  for (const [table, pattern] of tablePattern) {
    if (pattern.test(literal.text)) callsByTable.get(table).push(location);
  }
};

for (const sourceFile of program.getSourceFiles()) {
  const file = relativeSourceFile(sourceFile);
  if (sourceFile.isDeclarationFile || file.startsWith("..") || !file.startsWith("src/")) continue;
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && symbolIsDbRun(checker.getSymbolAtLocation(node.name))) {
      if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
        inspectRunCall(sourceFile, node.parent);
      } else {
        escapedRunReferences.push({ ...locationOf(sourceFile, node), source: node.getText(sourceFile) });
      }
      return;
    }
    if (ts.isElementAccessExpression(node)) {
      const member = checker.getTypeAtLocation(node.expression).getProperty("run");
      if (symbolIsDbRun(member)) {
        escapedRunReferences.push({ ...locationOf(sourceFile, node), source: node.getText(sourceFile) });
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/** Direct SQL in schema.sql is a separate, finite surface: no JavaScript values to evaluate. */
const WS = String.raw`\s+`;
const CONFLICT = String.raw`(?:OR${WS}(?:ABORT|FAIL|IGNORE|REPLACE|ROLLBACK)${WS})?`;
const TABLE_REF = String.raw`(?:${IDENT}\s*\.\s*)?(${IDENT})`;
const WRITE = new RegExp(
  String.raw`\b(?:` +
    String.raw`INSERT${WS}${CONFLICT}INTO${WS}${TABLE_REF}` +
    String.raw`|UPDATE${WS}${CONFLICT}${TABLE_REF}` +
    String.raw`|REPLACE${WS}INTO${WS}${TABLE_REF}` +
    String.raw`|DELETE${WS}FROM${WS}${TABLE_REF}` +
    String.raw`)`,
  "gi",
);
const RENAME = new RegExp(
  String.raw`\bALTER${WS}TABLE${WS}${TABLE_REF}${WS}RENAME${WS}TO${WS}${TABLE_REF}`,
  "gi",
);
const governedByLower = new Map(governedTables.map((table) => [table.toLowerCase(), table]));
const schemaWrites = [];
for (const match of strippedSchema.matchAll(WRITE)) {
  const captured = match[1] ?? match[2] ?? match[3] ?? match[4];
  const table = governedByLower.get(unquoteIdent(captured).toLowerCase());
  if (table !== undefined) schemaWrites.push({ table, file: "src/db/schema.sql" });
}
for (const match of strippedSchema.matchAll(RENAME)) {
  const table = governedByLower.get(unquoteIdent(match[2]).toLowerCase());
  if (table !== undefined) schemaWrites.push({ table, file: "src/db/schema.sql" });
}

const migrationsSource = program.getSourceFile(join(ROOT, MIGRATIONS_FILE));
const missingRebuildSurfaces = [];
for (const [table, surface] of Object.entries(MIGRATION_REBUILD_SURFACES)) {
  let declaration;
  if (migrationsSource !== undefined) {
    const visit = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === surface &&
        node.initializer !== undefined
      ) {
        declaration = node.initializer;
      }
      ts.forEachChild(node, visit);
    };
    visit(migrationsSource);
  }
  let hasExec = false;
  if (declaration !== undefined) {
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "exec"
      ) {
        hasExec = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration);
  }
  if (!hasExec) missingRebuildSurfaces.push({ table, surface });
}

const applicationResidual = [];
const staleOwners = [];
for (const table of governedTables) {
  const allowed = new Set(APPLICATION_OWNERS[table]);
  const seenFiles = new Set(callsByTable.get(table).map(({ file }) => file));
  for (const file of seenFiles) {
    if (!allowed.has(file)) applicationResidual.push({ table, file });
  }
  for (const owner of allowed) {
    if (!seenFiles.has(owner)) staleOwners.push({ table, owner });
  }
}

const applicationReport = governedTables
  .map((table) => {
    const calls = callsByTable.get(table);
    const details = calls.map(({ file, line }) => `${file}:${line}`).join(", ");
    return `  ${table}: ${calls.length} direct Db.run call(s)${details ? ` (${details})` : ""}`;
  })
  .join("\n");
const migrationReport = Object.entries(MIGRATION_REBUILD_SURFACES)
  .map(([table, surface]) => `  ${table}: ${MIGRATIONS_FILE}#${surface}`)
  .join("\n");
const report = `${applicationReport}\n\nDECLARED MIGRATION REBUILD SURFACES:\n${migrationReport}`;

if (escapedRunReferences.length > 0 || nonInlineCalls.length > 0) {
  const escaped = escapedRunReferences.map(
    ({ file, line, source }) => `  ${file}:${line}: Db.run escapes its direct call surface as \`${source}\`.\n`,
  );
  const nonInline = nonInlineCalls.map(
    ({ file, line, shape, source }) =>
      `  ${file}:${line}: Db.run receives ${shape} \`${source}\`, not inline SQL.\n`,
  );
  process.stdout.write(
    `${report}\n\n${[...escaped, ...nonInline].join("")}\n` +
      "Inline the final SQL string at Db.run; this check does not evaluate JavaScript expressions.\n" +
      `RESULT: FAIL — ${escapedRunReferences.length + nonInlineCalls.length} Db.run call or reference ` +
      "left the bounded direct-literal surface. residual: unmeasured.\n",
  );
  process.exit(1);
}

if (missingRebuildSurfaces.length > 0) {
  process.stdout.write(
    `${report}\n\n${missingRebuildSurfaces
      .map(
        ({ table, surface }) =>
          `  ${table}: ${MIGRATIONS_FILE}#${surface} is missing or no longer calls an exec surface.\n`,
      )
      .join("")}\nRESULT: FAIL — ${missingRebuildSurfaces.length} declared migration rebuild surface(s) are stale. residual: unmeasured.\n`,
  );
  process.exit(1);
}

if (staleOwners.length > 0) {
  process.stdout.write(
    `${report}\n\n${staleOwners
      .map(
        ({ table, owner }) =>
          `  ${table}: the declared application owner ${owner} has no inline Db.run call naming this table.\n`,
      )
      .join("")}\nRESULT: FAIL — ${staleOwners.length} application-owner entry(ies) are stale. residual: unmeasured.\n`,
  );
  process.exit(1);
}

const residual = [...applicationResidual, ...schemaWrites];
if (residual.length > 0) {
  process.stdout.write(
    `${report}\n\n${residual
      .map(({ table, file }) => {
        const owners = APPLICATION_OWNERS[table];
        return `  ${table}: ${file} is outside its declared application owner list (${owners.join(", ") || "none"}).\n`;
      })
      .join("")}\nRESULT: FAIL — ${residual.length} turn-fence table reference(s) are outside their declared application owners. residual != 0.\n`,
  );
  process.exit(1);
}

const totalCalls = governedTables.reduce((count, table) => count + callsByTable.get(table).length, 0);
process.stdout.write(
  `${report}\n\nRESULT: PASS — ${governedTables.length} governed table(s), ${totalCalls} direct inline ` +
    "Db.run call(s) naming them, every call in its declared application owner, 0 non-inline " +
    "Db.run calls, and 0 schema writer references. residual: 0.\n",
);
