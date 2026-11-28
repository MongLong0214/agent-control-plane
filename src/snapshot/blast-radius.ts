import { z } from "zod";

import type { ExecutionMode } from "../domain/types.ts";

/**
 * #1453 — how far a frozen candidate reaches, read from what it changes rather than from what its goal says.
 * Pure: the freeze reads the candidate's paths and added lines (`candidate-snapshot.ts`) and hands them here.
 *
 * - IRREVERSIBLE: a destructive SQL statement added to a schema path, a touched declared `irreversible` path, a
 *   file deleted under a declared `migrations` path, or a destructive action the run's text states.
 * - WIDE: a touched declared `wide` path, or any other schema or migration change.
 * - CONTAINED: everything else. A plain file deletion is CONTAINED, because `git revert` restores it.
 */

/** Consent is required for destructive operations, independent of the run's mode. */
export const HUMAN_GATE_TRIGGERS = [
  "irreversible production action",
  "destructive data migration or delete",
  "project decommission",
] as const;

export interface HumanGateInput {
  executionMode: ExecutionMode;
  goal: string;
  scope: readonly string[];
  declaredItems: readonly string[];
}

export interface HumanGateDefinition {
  required: boolean;
  items: string[];
}

/** Classify stated actions, rather than benign keywords or arbitrary owner questions. */
export const deriveHumanGate = (input: HumanGateInput): HumanGateDefinition => {
  const actions = [input.goal, ...input.scope, ...input.declaredItems]
    .map((text) => text.trim().toLowerCase().replace(/\s+/g, " "));
  const items = new Set<string>();
  for (const text of actions) {
    const action = text.replace(/^(?:please|can you|could you|would you)\s+/, "");
    if (/^(?:document|describe|explain|test|review|discuss|prevent|avoid)\b/.test(action) ||
        /\b(?:do not|don't|never|without)\s+(?:delete|drop|truncate|wipe|destroy|decommission|perform|execute|apply|run)\b/.test(action)) continue;
    if (/^(?:(?:perform|execute|apply|run) (?:an? )?)?irreversible (?:production )?action\b/.test(action)) {
      items.add(HUMAN_GATE_TRIGGERS[0]);
    }
    if (/^(?:(?:perform|execute|apply|run) (?:a )?)?destructive (?:data )?migration\b/.test(action) ||
        /^(?:permanently )?(?:delete|drop|truncate|wipe|destroy)\s+(?:all\s+|the\s+|production\s+|user\s+)*(?:data|database|tables?|records?|files?|repositories|repository)\b/.test(action)) {
      items.add(HUMAN_GATE_TRIGGERS[1]);
    }
    if (/^(?:decommission (?:the )?project|project decommission)\b/.test(action)) items.add(HUMAN_GATE_TRIGGERS[2]);
  }
  return { required: items.size > 0, items: [...items] };
};

export const BlastRadiusLane = {
  CONTAINED: "CONTAINED",
  WIDE: "WIDE",
  IRREVERSIBLE: "IRREVERSIBLE",
} as const;
export type BlastRadiusLane = (typeof BlastRadiusLane)[keyof typeof BlastRadiusLane];

const DESTRUCTIVE_SQL_KINDS = [
  "DROP_TABLE", "DROP_COLUMN", "DROP_SCHEMA", "DROP_DATABASE", "ALTER_TABLE_DROP", "TRUNCATE", "DELETE_WITHOUT_WHERE",
] as const;
type DestructiveSqlKind = (typeof DESTRUCTIVE_SQL_KINDS)[number];

const blastRadiusPathItemSchema = z
  .object({
    kind: z.enum([...DESTRUCTIVE_SQL_KINDS, "IRREVERSIBLE_PATH", "MIGRATION_DELETED", "WIDE_PATH", "SCHEMA_CHANGE"]),
    repositoryRole: z.string().min(1),
    path: z.string().min(1),
    /** The line of the candidate's file the statement starts on. */
    line: z.number().int().positive().optional(),
    /** The object a statement drops, truncates or deletes from. */
    name: z.string().min(1).optional(),
  })
  .strict();
const blastRadiusTextItemSchema = z.object({ kind: z.literal("TEXT"), name: z.string().min(1) }).strict();

/**
 * The lane as the snapshot binds it (CP-HI-06). Absent means CONTAINED: a CONTAINED lane is never stored, so every
 * candidate that touches nothing schema-shaped or declared keeps the digest it always had.
 */
export const snapshotBlastRadiusSchema = z
  .object({
    lane: z.enum([BlastRadiusLane.WIDE, BlastRadiusLane.IRREVERSIBLE]),
    items: z.array(z.union([blastRadiusPathItemSchema, blastRadiusTextItemSchema])).min(1),
  })
  .strict();
export type SnapshotBlastRadius = z.infer<typeof snapshotBlastRadiusSchema>;
export type BlastRadiusItem = SnapshotBlastRadius["items"][number];
export interface BlastRadius {
  lane: BlastRadiusLane;
  /** Only the items of `lane`: what put the candidate there. */
  items: BlastRadiusItem[];
}

interface DeclaredPath {
  repositoryRole: string;
  path: string;
}
/** The manifest's `blastRadius` paths, each a prefix of repository-relative paths in one repository role. */
export interface BlastRadiusDeclaration {
  wide: readonly DeclaredPath[];
  irreversible: readonly DeclaredPath[];
  migrations: readonly DeclaredPath[];
}

/** Added lines that are contiguous in the candidate's file, `line` being the first one's number. */
export interface AddedBlock {
  line: number;
  text: string[];
}

export interface BlastRadiusRepositoryChange {
  repositoryRole: string;
  touchedPaths: readonly string[];
  /** Deleted paths, renames not detected: a renamed file's old path is a deletion. */
  deletedPaths: readonly string[];
  /** The added lines of each schema path (`isSchemaPath`); any other path given here is ignored. */
  addedLines: Readonly<Record<string, readonly AddedBlock[]>>;
}

/** `path` is `prefix` or lies beneath it, as write targets match (`isWithin`), in git's `/` separators. */
const within = (prefix: string, path: string): boolean => {
  const parent = prefix.replace(/\/+$/, "");
  return path === parent || path.startsWith(`${parent}/`);
};
const declares = (paths: readonly DeclaredPath[] | undefined, repositoryRole: string, path: string): boolean =>
  (paths ?? []).some((entry) => entry.repositoryRole === repositoryRole && within(entry.path, path));

/** A schema or migration path: a `*.sql` file, or a path under a declared `migrations` prefix of its role. */
export const isSchemaPath = (declared: BlastRadiusDeclaration | undefined, repositoryRole: string, path: string): boolean =>
  /\.sql$/i.test(path) || declares(declared?.migrations, repositoryRole, path);

/** The added blocks of a unified patch (read with `-U0`), numbered by the candidate's file. */
export const parseAddedBlocks = (patch: string): AddedBlock[] => {
  const blocks: AddedBlock[] = [];
  let next: number | null = null;
  let block: AddedBlock | null = null;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      next = Number(hunk[1]);
      block = null;
    } else if (raw.startsWith("diff --git ")) {
      next = null;
      block = null;
    } else if (next !== null && raw.startsWith("+")) {
      if (block === null) blocks.push((block = { line: next, text: [] }));
      block.text.push(raw.slice(1));
      next += 1;
    } else if (next !== null && raw.startsWith(" ")) {
      next += 1;
      block = null;
    }
  }
  return blocks;
};

const IDENT = String.raw`(?:"[^"\n]+"|\[[^\]\n]+\]|` + "`[^`\\n]+`" + String.raw`|\$\{[^}\n]+\}|[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)`;
const SPACE = String.raw`[ \t\r\n]+`;
/** A statement starts a line, or follows `;`, a quote or `(`: SQL embedded in code starts after its string's quote. */
const STATEMENT_START = new RegExp(
  String.raw`(^|[;"'` + "`" + String.raw`(])[ \t]*(DROP${SPACE}(?:TABLE|COLUMN|SCHEMA|DATABASE)|ALTER${SPACE}TABLE|TRUNCATE|DELETE${SPACE}FROM)\b`,
  "gim",
);
const NAMES = new RegExp(String.raw`^${SPACE}(?:IF${SPACE}EXISTS${SPACE})?(${IDENT}(?:[ \t\r\n]*,[ \t\r\n]*${IDENT})*)`, "i");
const TRUNCATED = new RegExp(String.raw`^${SPACE}(?:TABLE${SPACE})?(?:ONLY${SPACE})?(${IDENT})`, "i");
const TABLE = new RegExp(String.raw`^${SPACE}(?:IF${SPACE}EXISTS${SPACE})?(?:ONLY${SPACE})?(${IDENT})`, "i");
const DROPPED = new RegExp(String.raw`^${SPACE}(?:COLUMN${SPACE}|CONSTRAINT${SPACE})?(?:IF${SPACE}EXISTS${SPACE})?(${IDENT})`, "i");
const CREATED = new RegExp(
  String.raw`\b(?:CREATE${SPACE}(?:TEMP(?:ORARY)?${SPACE})?TABLE${SPACE}(?:IF${SPACE}NOT${SPACE}EXISTS${SPACE})?|RENAME${SPACE}TO${SPACE})(${IDENT})`,
  "gi",
);

const unquote = (name: string): string => (/^(?:"[^"]*"|\[[^\]]*\]|`[^`]*`)$/.test(name) ? name.slice(1, -1) : name);
const sameObject = (name: string): string => unquote(name).toLowerCase();
const namesIn = (list: string): string[] =>
  [...list.matchAll(new RegExp(IDENT, "g"))].map((match) => unquote(match[0]));

/** SQL comments blanked to spaces, so a commented-out WHERE qualifies nothing and offsets and lines stay put. */
const withoutComments = (text: string): string =>
  text.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
/** The text up to the end of its statement or of the string it is embedded in. */
const statementBody = (text: string, terminators: RegExp): string => {
  const end = text.search(terminators);
  return end === -1 ? text : text.slice(0, end);
};

interface Statement {
  kind: DestructiveSqlKind;
  /** Lines after the block's first. */
  offset: number;
  name: string;
}

const destructiveStatements = (text: string): Statement[] => {
  const found: Statement[] = [];
  let coveredUntil = 0;
  for (const match of text.matchAll(STATEMENT_START)) {
    const keyword = match[2]!;
    const start = match.index + match[0].length - keyword.length;
    if (start < coveredUntil) continue;
    const rest = text.slice(start + keyword.length);
    const offset = text.slice(0, start).split("\n").length - 1;
    const verb = keyword.toUpperCase().replace(/\s+/g, " ");
    if (verb.startsWith("DROP ")) {
      const names = NAMES.exec(rest);
      const kind = `DROP_${verb.slice(5)}` as DestructiveSqlKind;
      for (const name of names === null ? [] : namesIn(names[1]!)) found.push({ kind, offset, name });
      if (names !== null) coveredUntil = start + keyword.length + names[0].length;
    } else if (verb === "TRUNCATE") {
      const table = TRUNCATED.exec(rest);
      if (table !== null) found.push({ kind: "TRUNCATE", offset, name: unquote(table[1]!) });
    } else if (verb === "DELETE FROM") {
      const table = TABLE.exec(rest);
      if (table === null) continue;
      const body = statementBody(rest.slice(table[0].length), /[;"'`]/);
      if (!/\bWHERE\b/i.test(body)) found.push({ kind: "DELETE_WITHOUT_WHERE", offset, name: unquote(table[1]!) });
    } else {
      const table = TABLE.exec(rest);
      if (table === null) continue;
      const after = rest.slice(table[0].length);
      const body = statementBody(after, /[;"`]/);
      coveredUntil = start + keyword.length + table[0].length + body.length;
      const drop = /\bDROP\b/i.exec(body);
      if (drop === null) continue;
      const dropped = DROPPED.exec(after.slice(drop.index + drop[0].length));
      found.push({ kind: "ALTER_TABLE_DROP", offset, name: unquote(dropped?.[1] ?? table[1]!) });
    }
  }
  return found;
};

const itemOrder = (item: BlastRadiusItem): string =>
  "path" in item
    ? [item.repositoryRole, item.path, String(item.line ?? 0).padStart(9, "0"), item.kind, item.name ?? ""].join("\0")
    : ["", "", "", item.kind, item.name].join("\0");
const sortedUnique = (items: readonly BlastRadiusItem[]): BlastRadiusItem[] => {
  const byKey = new Map(items.map((item) => [itemOrder(item), item]));
  return [...byKey.keys()].sort().map((key) => byKey.get(key)!);
};

/** The candidate's lane and the items that put it there. `textItems` are the run's stated destructive actions. */
export const classifyBlastRadius = (input: {
  repositories: readonly BlastRadiusRepositoryChange[];
  declared?: BlastRadiusDeclaration | undefined;
  textItems: readonly string[];
}): BlastRadius => {
  const { declared } = input;
  const irreversible: BlastRadiusItem[] = [];
  const wide: BlastRadiusItem[] = [];
  for (const repository of input.repositories) {
    const repositoryRole = repository.repositoryRole;
    const created = new Set<string>();
    const statements: Array<Statement & { path: string; line: number }> = [];
    for (const [path, blocks] of Object.entries(repository.addedLines)) {
      if (!isSchemaPath(declared, repositoryRole, path)) continue;
      for (const block of blocks) {
        const text = withoutComments(block.text.join("\n"));
        for (const match of text.matchAll(CREATED)) created.add(sameObject(match[1]!));
        for (const statement of destructiveStatements(text)) statements.push({ ...statement, path, line: block.line + statement.offset });
      }
    }
    for (const statement of statements) {
      // A table dropped and created again by the same change is rebuilt, not lost.
      if (statement.kind === "DROP_TABLE" && created.has(sameObject(statement.name))) continue;
      irreversible.push({ kind: statement.kind, repositoryRole, path: statement.path, line: statement.line, name: statement.name });
    }
    for (const path of repository.touchedPaths) {
      if (declares(declared?.irreversible, repositoryRole, path)) irreversible.push({ kind: "IRREVERSIBLE_PATH", repositoryRole, path });
      if (declares(declared?.wide, repositoryRole, path)) wide.push({ kind: "WIDE_PATH", repositoryRole, path });
      if (isSchemaPath(declared, repositoryRole, path)) wide.push({ kind: "SCHEMA_CHANGE", repositoryRole, path });
    }
    for (const path of repository.deletedPaths) {
      if (declares(declared?.migrations, repositoryRole, path)) irreversible.push({ kind: "MIGRATION_DELETED", repositoryRole, path });
    }
  }
  for (const name of input.textItems) irreversible.push({ kind: "TEXT", name });
  if (irreversible.length > 0) return { lane: BlastRadiusLane.IRREVERSIBLE, items: sortedUnique(irreversible) };
  if (wide.length > 0) return { lane: BlastRadiusLane.WIDE, items: sortedUnique(wide) };
  return { lane: BlastRadiusLane.CONTAINED, items: [] };
};

/** What the snapshot stores: nothing for CONTAINED. */
export const snapshotBlastRadius = (radius: BlastRadius): SnapshotBlastRadius | undefined =>
  radius.lane === BlastRadiusLane.CONTAINED ? undefined : { lane: radius.lane, items: radius.items };

const isDestructiveSql = (kind: string): boolean => (DESTRUCTIVE_SQL_KINDS as readonly string[]).includes(kind);

/**
 * A destructive path change ships alone, as its own contract run: with a path-based IRREVERSIBLE item, every touched
 * path outside the declared `migrations` and `irreversible` paths and the `.sql` files a destructive statement was
 * found in. Empty for any other lane, and for a lane that only text items put there.
 */
export const pathsOutsideContract = (
  radius: BlastRadius | undefined,
  repositories: ReadonlyArray<{ repositoryRole: string; touchedPaths: readonly string[] }>,
  declared: BlastRadiusDeclaration | undefined,
): DeclaredPath[] => {
  if (radius?.lane !== BlastRadiusLane.IRREVERSIBLE) return [];
  const pathItems = radius.items.filter((item): item is Extract<BlastRadiusItem, { path: string }> => "path" in item);
  if (pathItems.length === 0) return [];
  const matched = new Set(pathItems.filter((item) => isDestructiveSql(item.kind)).map((item) => `${item.repositoryRole}\0${item.path}`));
  return repositories.flatMap(({ repositoryRole, touchedPaths }) =>
    touchedPaths
      .filter((path) => !declares(declared?.migrations, repositoryRole, path) && !declares(declared?.irreversible, repositoryRole, path) &&
        !matched.has(`${repositoryRole}\0${path}`))
      .map((path) => ({ repositoryRole, path })));
};
