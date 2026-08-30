#!/usr/bin/env node
/**
 * The turn-fence writer census resolves statically knowable SQL and fails when a governed table
 * is written or replaced outside its owner list, while reporting runtime-computed SQL it cannot
 * resolve.
 *
 * TypeScript source spelling is not SQL. JavaScript escapes and literal concatenation change the
 * value SQLite receives, so this check parses every source file and scans cooked string values
 * instead of matching the source text. Expressions with runtime-only pieces retain an unknown
 * marker: a statically visible write verb with an unknown target fails loudly, while the output
 * states on every run that wholly runtime-computed SQL is beyond a static census.
 *
 * SQLite migrations can replace a governed table without writing its canonical name directly:
 * populate a shadow table, drop the original, and rename the shadow. `ALTER TABLE … RENAME TO` is
 * therefore a writer surface and is attributed to the destination table.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const CLAIM =
  "The turn-fence writer census resolves statically knowable SQL and fails when a governed table is written or replaced outside its owner list, while reporting runtime-computed SQL it cannot resolve.";
const LIMIT =
  "Static analysis cannot see SQL or table names computed entirely at runtime; those constructions are outside this census unless a static fragment reveals an unresolved write.";
const HEADER = `CHECK: ${CLAIM}\nLIMIT: ${LIMIT}\n`;

process.stdout.write(HEADER);

/** Every `.ts` file under `src/`, depth-first, in the shape the other census scripts use. */
const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
};

/**
 * Blank SQL comments without changing line positions. Quoted values and identifiers are copied
 * intact, so comment markers inside them retain their SQL meaning as data rather than comments.
 */
const stripSqlComments = (source) => {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "-" && next === "-") {
      out += "  ";
      i += 2;
      while (i < n && source[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      let j = i + 2;
      while (j < n && !(source[j] === "*" && source[j + 1] === "/")) j++;
      if (j < n) j += 2;
      out += source.slice(i, j).replace(/[^\n]/g, " ");
      i = j;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (source[j] === "'" && source[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (source[j] === "'") {
          j++;
          break;
        }
        j++;
      }
      out += source.slice(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (source[j] === quote && source[j + 1] === quote) {
          j += 2;
          continue;
        }
        if (source[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      out += source.slice(i, j);
      i = j;
      continue;
    }
    if (c === "[") {
      let j = i + 1;
      while (j < n && source[j] !== "]") j++;
      if (j < n) j++;
      out += source.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
};

/** A SQL identifier: bare, double-quoted, backtick-quoted, or bracket-quoted. */
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

/** Case-insensitive lookup back to the schema's own casing, since SQLite folds identifier case. */
const governedByLower = new Map(governedTables.map((table) => [table.toLowerCase(), table]));

/**
 * The reviewed writer files for each table. Migrations own only the replacement paths that the
 * current production source actually contains; stale-owner checking makes those entries decay if
 * either rebuild disappears.
 */
const OWNERS = {
  canonical_turns: ["src/conversation/turn-coordinator.ts", "src/db/migrations.ts"],
  canonical_turn_sources: ["src/conversation/turn-coordinator.ts"],
  canonical_turn_observations: ["src/conversation/turn-coordinator.ts", "src/db/migrations.ts"],
  canonical_turn_dispatches: ["src/conversation/turn-coordinator.ts"],
  canonical_turn_adjudications: ["src/conversation/turn-coordinator.ts"],
  canonical_turn_adjudication_citations: ["src/conversation/turn-coordinator.ts"],
  actor_target_bindings: ["src/session/binding-registry.ts"],
  actor_target_attestations: [],
};

const unowned = governedTables.filter((table) => !(table in OWNERS));
if (unowned.length > 0) {
  process.stdout.write(
    `RESULT: FAIL — the schema declares ${unowned.join(", ")} and this census has no owner entry ` +
      "for it. A table this file has never heard of is a table nothing here is watching.\n",
  );
  process.exit(1);
}

const orphanedOwners = Object.keys(OWNERS).filter((table) => !governedTables.includes(table));
if (orphanedOwners.length > 0) {
  process.stdout.write(
    `RESULT: FAIL — OWNERS names ${orphanedOwners.join(", ")}, which the schema no longer declares. ` +
      "Delete the stale entry, or rename it to the table that replaced it.\n",
  );
  process.exit(1);
}

const WS = String.raw`\s+`;
const CONFLICT = String.raw`(?:OR${WS}(?:ABORT|FAIL|IGNORE|REPLACE|ROLLBACK)${WS})?`;
const TABLE_REF = String.raw`(?:${IDENT}\s*\.\s*)?(${IDENT})`;
const WRITE = new RegExp(
  String.raw`\b(?:` +
    String.raw`INSERT${WS}${CONFLICT}INTO(?:${WS}${TABLE_REF})?` +
    String.raw`|UPDATE${WS}${CONFLICT}(?:${TABLE_REF})?` +
    String.raw`|REPLACE${WS}INTO(?:${WS}${TABLE_REF})?` +
    String.raw`|DELETE${WS}FROM(?:${WS}${TABLE_REF})?` +
    String.raw`)`,
  "gi",
);
const RENAME = new RegExp(
  String.raw`\bALTER${WS}TABLE${WS}${TABLE_REF}${WS}RENAME${WS}TO${WS}${TABLE_REF}`,
  "gi",
);

const UNKNOWN = "\u0000";
const writesByTable = new Map(governedTables.map((table) => [table, []]));
const replacementsByTable = new Map(governedTables.map((table) => [table, []]));
const unresolvable = [];

/**
 * Resolve the value of a string-only expression. Literal nodes expose cooked `.text`, so `\n`,
 * `\x20`, Unicode escapes, and physical newlines become the same characters SQLite receives.
 * Binary `+` and template expressions are folded when their parts are static; an unknown marker
 * preserves the position of any runtime-only part for the write-target diagnostic below.
 */
const partialStaticString = (node) => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { text: node.text, complete: true };
  }
  if (ts.isParenthesizedExpression(node)) return partialStaticString(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = partialStaticString(node.left);
    const right = partialStaticString(node.right);
    return { text: left.text + right.text, complete: left.complete && right.complete };
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    let complete = true;
    for (const span of node.templateSpans) {
      const expression = partialStaticString(span.expression);
      text += expression.text + span.literal.text;
      complete &&= expression.complete;
    }
    return { text, complete };
  }
  return { text: UNKNOWN, complete: false };
};

const isStringExpression = (node) =>
  ts.isStringLiteral(node) ||
  ts.isNoSubstitutionTemplateLiteral(node) ||
  ts.isTemplateExpression(node) ||
  (ts.isParenthesizedExpression(node) && isStringExpression(node.expression)) ||
  (ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    (isStringExpression(node.left) || isStringExpression(node.right)));

/** Do not scan the pieces of a composition separately; its outer expression is the runtime value. */
const isNestedStringPart = (node) => {
  let current = node;
  let parent = node.parent;
  while (parent !== undefined && ts.isParenthesizedExpression(parent) && parent.expression === current) {
    current = parent;
    parent = parent.parent;
  }
  if (
    parent !== undefined &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    (parent.left === current || parent.right === current)
  ) {
    return true;
  }
  return parent !== undefined && ts.isTemplateSpan(parent) && parent.expression === current;
};

const scanSql = (file, sql) => {
  const content = stripSqlComments(sql);
  for (const match of content.matchAll(WRITE)) {
    const capturedTable = match[1] ?? match[2] ?? match[3] ?? match[4];
    const matchEnd = match.index + match[0].length;
    const truncatedByRuntimeValue =
      capturedTable !== undefined && content.slice(matchEnd, matchEnd + UNKNOWN.length) === UNKNOWN;
    if (capturedTable === undefined || truncatedByRuntimeValue) {
      const after = content
        .slice(matchEnd, matchEnd + 40)
        .replaceAll(UNKNOWN, "<runtime value>")
        .replace(/\s+/g, " ")
        .trim();
      unresolvable.push({ file, verb: match[0].trim(), after });
      continue;
    }
    const table = governedByLower.get(unquoteIdent(capturedTable).toLowerCase());
    if (table !== undefined) writesByTable.get(table).push(file);
  }

  for (const match of content.matchAll(RENAME)) {
    const destination = governedByLower.get(unquoteIdent(match[2]).toLowerCase());
    if (destination !== undefined) replacementsByTable.get(destination).push(file);
  }
};

/** Parse TypeScript and scan maximal string expressions as values rather than source spellings. */
const scanTypeScript = (file) => {
  const source = readFileSync(join(ROOT, file), "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node) => {
    if (isStringExpression(node) && !isNestedStringPart(node)) {
      scanSql(file, partialStaticString(node).text);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
};

const files = walk(SRC).map((file) => relative(ROOT, file));
for (const file of files) scanTypeScript(file);
scanSql("src/db/schema.sql", strippedSchema);

const filesForTable = (table) =>
  [...new Set([...writesByTable.get(table), ...replacementsByTable.get(table)])].sort();

const modesFor = (table, file) => {
  const writes = writesByTable.get(table).includes(file);
  const replaces = replacementsByTable.get(table).includes(file);
  if (writes && replaces) return "writes and replaces this table";
  if (replaces) return "replaces this table";
  return "writes this table";
};

const residual = [];
const staleOwners = [];
for (const table of governedTables) {
  const seenFiles = filesForTable(table);
  const allowed = new Set(OWNERS[table]);
  for (const file of seenFiles) {
    if (!allowed.has(file)) residual.push({ table, file });
  }
  for (const owner of OWNERS[table]) {
    if (!seenFiles.includes(owner)) staleOwners.push({ table, owner });
  }
}

const report = governedTables
  .map((table) => {
    const seenFiles = filesForTable(table);
    const details = seenFiles
      .map((file) => `${file}${replacementsByTable.get(table).includes(file) ? " [replacement]" : ""}`)
      .join(", ");
    return `  ${table}: ${seenFiles.length} writer file(s)${details.length > 0 ? ` (${details})` : ""}`;
  })
  .join("\n");

if (unresolvable.length > 0) {
  process.stdout.write(
    `${report}\n\n` +
      unresolvable
        .map(
          ({ file, verb, after }) =>
            `  ${file}: \`${verb}\` is followed by \`${after}…\`, not a static table name this ` +
            "census can read. It may or may not target a governed table.\n",
        )
        .join("") +
      `\nRESULT: FAIL — ${unresolvable.length} write(s) with a table name this census could not resolve. ` +
      "Unresolved is not the same as clean.\n",
  );
  process.exit(1);
}

if (staleOwners.length > 0) {
  process.stdout.write(
    `${report}\n\n` +
      staleOwners
        .map(
          ({ table, owner }) =>
            `  ${table}: the declared owner ${owner} writes or replaces nothing here anymore — ` +
            "an unused exemption, not a covered one.\n",
        )
        .join("") +
      `\nRESULT: FAIL — ${staleOwners.length} owner entry(ies) name a file that no longer writes or ` +
      "replaces its table.\n",
  );
  process.exit(1);
}

if (residual.length > 0) {
  process.stdout.write(
    `${report}\n\n` +
      residual
        .map(
          ({ table, file }) =>
            `  ${table}: ${file} ${modesFor(table, file)} and is not in its owner list (` +
            `${OWNERS[table].join(", ") || "none — expected zero writers"}).\n`,
        )
        .join("") +
      "\nRoute the write through an owner, or add the file to OWNERS with the reason it may hold " +
      "the pen too.\n" +
      `RESULT: FAIL — ${residual.length} write or replacement reference(s) from a file outside ` +
      "the table's owner list. residual != 0.\n",
  );
  process.exit(1);
}

const totalWriters = governedTables.reduce((count, table) => count + filesForTable(table).length, 0);
const totalReplacements = governedTables.reduce(
  (count, table) => count + new Set(replacementsByTable.get(table)).size,
  0,
);
process.stdout.write(
  `${report}\n\n` +
    `RESULT: PASS — ${governedTables.length} governed table(s), ${totalWriters} writer file ` +
    `reference(s), including ${totalReplacements} replacement reference(s), every one inside its ` +
    "table's owner list, 0 unresolved write(s). residual: 0.\n",
);
