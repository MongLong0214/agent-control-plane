#!/usr/bin/env node
/**
 * Fails when a file outside the reviewed writer set inserts, updates, or deletes a row in one of
 * the turn-fence-governed tables: `canonical_turns` and its five satellite tables, plus the two
 * `actor_target_*` tables the ledger cites for its authority checks.
 *
 * The schema already refuses a *bad* write to these tables from anywhere — the append-only,
 * no-replace, no-delete and materialization-authority triggers hold regardless of who issues the
 * statement (`tests/unit/canonical-ledger-immutability.test.ts`). What nothing checks is whether a
 * *second* file has started writing them at all. A new module that reconstructs one of the
 * coordinator's own INSERT/UPDATE statements — same shape, same columns, so it satisfies every
 * CHECK and every trigger precondition — passes the schema cleanly while going around the
 * coordinator's TypeScript-level sequencing (session-generation checks, retry-safety ordering)
 * that the schema cannot see and was never asked to enforce. That is a writer this repository has
 * no way to notice today; the schema would not object and nothing else looks.
 *
 * So this is a source-level count, in the shape of `verify-append-only-tables-are-closed.mjs`
 * next to it: derive the governed table set from the schema, derive the writer set from the
 * source, and require every writer to be one this file already names — printing the census either
 * way, not just on failure.
 *
 * v2 (post-review): the first version's SQL detector matched exactly one spelling of each
 * statement — uppercase `INSERT INTO`/`UPDATE`/`DELETE FROM` followed by a bare identifier. A
 * blind adversarial review fed it `INSERT OR ABORT INTO`, `INSERT OR IGNORE INTO`, a
 * double-quoted table name, a schema-qualified one, and lowercase SQL, and every one of them read
 * as MISSED — a writer only had to spell its statement slightly differently to become invisible,
 * which is the exact defect this file exists to catch, one level up. It also missed `REPLACE
 * INTO` outright, though `assertDataMutation` in `src/db/database.ts` names `REPLACE` beside
 * `INSERT` as an ordinary mutation this schema's own connection issues. See `WRITE` below for the
 * replacement, and `unresolvable` below for the one form no static regex can ever close.
 *
 * v3 (post-review, round 3): two more findings, both against a regex that required a keyword
 * boundary to be literal whitespace.
 *
 * Finding 1 — SQLite treats an SQL comment exactly like whitespace between two tokens, so
 * `INSERT/**\/INTO`, `UPDATE/**\/canonical_turns` and `DELETE/**\/FROM canonical_turns` all run as
 * ordinary writes (confirmed against system SQLite) while the old `\s+` at every keyword boundary
 * scored all three zero. `WS` below is what "whitespace" means to SQLite at a statement boundary —
 * real whitespace or a comment, one or more of either — so a comment inserted at any boundary the
 * old pattern required no longer hides the write.
 *
 * Finding 2 — `src/db/migrations.ts`'s `schemaDdl()` reads `src/db/schema.sql` whole and installs
 * it into the real database, so a trigger body in that file is a production write surface exactly
 * like a `.ts` module — and this census never read `schema.sql` for anything but `CREATE TABLE`
 * names. A second writer could sit in a trigger body forever and this file would never see it.
 * `schema.sql` is now scanned by the same `WRITE` regex as every other file, through
 * `stripSqlComments` first: this file's own trigger doc comments quote past defective SQL verbatim
 * (see `canonical_turns_settlement_authority`'s comment above it), the same shape
 * `stripComments`/`.ts` files already had to be protected from.
 *
 * `stripSqlComments` mirrors `stripSqlSource` in `scripts/lib/tracker-loci-strip.mjs` (`--` line
 * comments, non-nesting `/* *\/` block comments, `'...'` value strings escaping their own quote by
 * doubling it, `"`/`` ` ``/`[` identifier quoting left untouched) rather than importing it: that
 * file lives on branch `feat/597-tracker-loci-resolve` (PR #689), which is not merged to `main` and
 * so is not reachable from this branch without pulling in an unrelated, unmerged branch's full
 * history — out of scope for this fix. This is a local equivalent, not a sixth stripper solving a
 * new problem; if #689 lands first, importing it and deleting this copy is a one-line follow-up.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");

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
 * Strip `//` and block comments from TypeScript source while leaving string and template-literal
 * bodies untouched — the SQL this census has to see lives inside those strings, not the comments.
 *
 * Necessary because this file's own commit history is full of doc comments that quote *old*,
 * defective SQL as an example ("a plain `UPDATE canonical_turns SET outcome_kind='ABORTED'`…" in
 * `src/db/migrations.ts`). A regex over raw source text cannot tell a quoted illustration of a bug
 * from the bug; only a comment reads it, and only a comment should be discounted. This does not
 * parse JavaScript — it tracks quote/comment state character by character, which is enough to
 * keep `//` and a block comment inside a string from being mistaken for a comment, and enough to keep a
 * comment's own quotes from being mistaken for a real string.
 */
const stripComments = (source) => {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (source[i] === "\\") {
          out += source[i] + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
};

/**
 * SQL's own comment forms, stripped from a *pure SQL* source (`schema.sql`) before the `WRITE`
 * regex ever sees it — see the "Finding 2" note in the file header for why this exists and why it
 * is a local copy of `stripSqlSource` rather than an import.
 *
 * Blanks rather than deletes so a diagnostic slice of the file (line count, column offsets)
 * downstream stays meaningful; SQL's `'...'` value strings (doubling their own quote to escape,
 * not backslash) and `"`/`` ` ``/`[` identifier quoting are tracked so a `--`/`/* *\/` sequence
 * inside a real string value is never mistaken for a comment start — `schema.sql` has no such case
 * today (checked directly), but this does not assume that stays true.
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

/** A SQL identifier: bare, double-quoted, backtick-quoted, or bracket-quoted. Case is not folded here. */
const IDENT = String.raw`(?:[A-Za-z_]\w*|"(?:[^"]|"")*"|\`[^\`]*\`|\[[^\]]*\])`;

/** Strip whatever quoting an identifier carries, so it compares equal to the schema's bare name. */
const unquoteIdent = (raw) => {
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1).replace(/""/g, '"');
  if (raw.startsWith("`") && raw.endsWith("`")) return raw.slice(1, -1);
  if (raw.startsWith("[") && raw.endsWith("]")) return raw.slice(1, -1);
  return raw;
};

/**
 * The governed tables, derived from the schema rather than typed out here a second time.
 *
 * `canonical_turn*` and `actor_target_*` is the whole ledger: the turn and its five satellites,
 * plus the binding and the attestation the ledger's authority triggers reference. Deriving this
 * from `CREATE TABLE` statements means a ninth table in either family enters the census the day
 * it is declared, with no second edit here to remember — case, quoting, and whitespace around the
 * declaration do not exempt it, because the review that found the writer-side regex too narrow
 * asked this side the same question and a hand check of the real schema.sql found none of these
 * forms currently in use, which is exactly the situation a check that only recognises them by luck
 * is supposed to outlive.
 *
 * v4 (post-review, round 4): a blind review confirmed two declarations SQLite accepts and this
 * regex missed outright — `CREATE/**\/TABLE foo (` (a comment is whitespace to SQLite at *any*
 * keyword boundary, exactly the "Finding 1" lesson `WS` already encodes for writes, but this
 * regex still required literal `\s+`) and `CREATE TABLE main.foo (` (a schema-qualified name,
 * which `TABLE_REF` already tolerates on the write side). Either form used to declare a new
 * satellite meant that table entered nothing: not `governedTables`, not the `OWNERS` census, not
 * the writer scan — a silent blind spot one step upstream of the writer regex it took three
 * rounds to harden. Matched here against `stripSqlComments(schema)` (comments blanked to spaces,
 * so a literal `\s+` now sees what SQLite sees) with an optional schema qualifier before the name,
 * mirroring `TABLE_REF`.
 */
const schema = readFileSync(join(ROOT, "src/db/schema.sql"), "utf8");
const strippedSchema = stripSqlComments(schema);
const CREATE_TABLE = new RegExp(
  String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:${IDENT}\s*\.\s*)?(${IDENT})\s*\(`,
  "gi",
);
const governedTables = [
  ...new Set(
    [...strippedSchema.matchAll(CREATE_TABLE)]
      .map((m) => unquoteIdent(m[1]))
      .filter((name) => /^(?:canonical_turn\w*|actor_target_\w+)$/i.test(name)),
  ),
].sort();

if (governedTables.length === 0) {
  process.stdout.write("RESULT: FAIL — found zero canonical_turn*/actor_target_* tables in the schema.\n");
  process.exit(1);
}
/** Case-insensitive lookup back to the schema's own casing, since SQLite folds identifier case. */
const governedByLower = new Map(governedTables.map((t) => [t.toLowerCase(), t]));

/**
 * The reviewed writer for each table, or `[]` when this repository has never written it at all.
 *
 * `actor_target_attestations` is `[]` on purpose: the attestation is the target executor's own
 * proof that it holds the current binding generation, and ACP has never minted that row itself —
 * ownership belongs to the process being attested to, not to the process doing the attesting. Any
 * writer appearing here is new by definition, not merely unreviewed.
 *
 * An owner that stops matching anything is exactly the exemption the sibling schema census warned
 * about — "an exemption nothing consults is a place for the next reader to believe something was
 * decided" — so a stale entry here fails the same as an unclaimed one, not silently.
 */
const OWNERS = {
  canonical_turns: ["src/conversation/turn-coordinator.ts"],
  canonical_turn_sources: ["src/conversation/turn-coordinator.ts"],
  canonical_turn_observations: ["src/conversation/turn-coordinator.ts"],
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

/**
 * v4 (post-review, round 4), the other half of the same one-directional check the blind review
 * named: the loop below (`staleOwners`) only visits tables still in `governedTables`, so it can
 * only notice an owner that stopped writing a table the schema *still declares*. It never visits
 * an `OWNERS` key for a table the schema no longer declares at all — that key just sits here,
 * unexamined, for as long as nobody happens to delete it by hand. The risk that names is concrete:
 * if a table is dropped and the same name is reintroduced later (a rename undone, a satellite
 * rebuilt), this stale key would let the *previous* table's owner list stand as if it had already
 * been reviewed for the new table — no fresh review required, because nothing here ever asked
 * whether the key it was trusting still corresponded to a real table. So this checks the reverse
 * direction explicitly: every `OWNERS` key must name a table the schema currently declares, empty
 * writer list (`actor_target_attestations`) included, because an empty list is still a key someone
 * would have to have decided to keep.
 */
const orphanedOwners = Object.keys(OWNERS).filter((table) => !governedTables.includes(table));
if (orphanedOwners.length > 0) {
  process.stdout.write(
    `RESULT: FAIL — OWNERS names ${orphanedOwners.join(", ")}, which the schema no longer declares. ` +
      "An owner entry for a table that no longer exists is unreviewed cover for whatever table gets " +
      "that name next. Delete the entry, or rename it to the table that replaced it.\n",
  );
  process.exit(1);
}

/**
 * `src/db/migrations.ts` used to be excluded here on the claim that `pnpm schema:registry` and
 * `pnpm schema:denials` already score its one genuine data-moving statement. That claim was never
 * checked: `schema:registry` (`verify-every-trigger-is-required.mjs`) confirms every declared
 * trigger is named by a required-trigger registry, and `schema:denials`
 * (`verify-trigger-denials-are-typed.mjs`) confirms every trigger sentinel maps to a typed
 * `ReasonCode`. Both are about the schema's *triggers* — neither reads a single line of
 * `migrations.ts` and neither would notice a migration that inserted a row into a governed table
 * directly. An exclusion defended by a citation nobody had opened is the same exemption-nothing-
 * consults shape this file was written to catch, one file up.
 *
 * So `migrations.ts` is walked like every other file now. Its comments are not: this is the file
 * that documents this ledger's past defects by quoting the broken SQL verbatim ("a plain `UPDATE
 * canonical_turns SET outcome_kind='ABORTED'`…"), and without `stripComments` that quotation reads
 * as a live write. Its one real data-moving statement — the ALTER-emulation copy into a
 * `<table>_rebuilt` shadow table SQLite needs to change a column it cannot alter in place — targets
 * a *different* table name (`canonical_turns_rebuilt`, not `canonical_turns`), so it does not need
 * an OWNERS entry: a hand check of the current file found no INSERT/UPDATE/DELETE/REPLACE against
 * an exact governed table name outside a comment. If that ever changes, this census now says so.
 */
const files = walk(SRC).map((f) => relative(ROOT, f));

/**
 * What "whitespace" means to SQLite at a statement's keyword boundaries: real whitespace, or a
 * comment (`/* *\/`, non-nesting; `--` to end of line), one or more of either in any mix. A regex
 * that required literal `\s+` here scored `INSERT/**\/INTO` — a real write, confirmed against
 * system SQLite — as no write at all, because the scan never got past recognising the keyword
 * pair in the first place. See the "Finding 1" note in the file header.
 */
const SQL_COMMENT = String.raw`(?:/\*[\s\S]*?\*/|--[^\n]*)`;
const WS = String.raw`(?:\s|${SQL_COMMENT})+`;
/** `INSERT`/`UPDATE` accept an explicit conflict-resolution clause; `DELETE` does not. */
const CONFLICT = String.raw`(?:OR${WS}(?:ABORT|FAIL|IGNORE|REPLACE|ROLLBACK)${WS})?`;
/** An optional schema qualifier (`main.foo`, `temp."Foo"`, …) followed by the table name itself. */
const TABLE_REF = String.raw`(?:${IDENT}(?:${WS})?\.(?:${WS})?)?(${IDENT})`;
/**
 * Every write-statement opener this schema's own connection accepts (`assertDataMutation` in
 * `src/db/database.ts` names `INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `WITH` as data statements),
 * case-folded, with the table reference made optional so a write whose target this regex cannot
 * resolve — a template-interpolated or concatenated table name — still matches the verb and is
 * reported as unresolved rather than silently not matching at all.
 */
// Each branch owns its own optional table reference rather than sharing one trailing `(?:WS TABLE_REF)?`
// after the alternation: `CONFLICT` already swallows the separator before `INTO`/the table name when
// it matches, and the branches differ in whether a keyword (`INTO`/`FROM`) sits between the conflict
// clause and the table — collapsing them into one shared tail required a second separator that plain
// `UPDATE table SET …` (no conflict clause) does not have, which silently turned the fix into a
// regression: every ordinary UPDATE in this repository read as an unresolved dynamic table name.
const WRITE = new RegExp(
  String.raw`\b(?:` +
    String.raw`INSERT${WS}${CONFLICT}INTO(?:${WS}${TABLE_REF})?` +
    String.raw`|UPDATE${WS}${CONFLICT}(?:${TABLE_REF})?` +
    String.raw`|REPLACE${WS}INTO(?:${WS}${TABLE_REF})?` +
    String.raw`|DELETE${WS}FROM(?:${WS}${TABLE_REF})?` +
    String.raw`)`,
  "gi",
);

const writesByTable = new Map(governedTables.map((t) => [t, []]));
/**
 * A write verb this scan cannot resolve to a static table name at all — a dynamically built
 * identifier. No regex can name what was never written down; the honest response is to say so out
 * loud, the same way `verify-append-only-tables-are-closed.mjs` fails rather than passes silently
 * when it meets a trigger form it cannot read. Silence here would read as "checked, found nothing",
 * indistinguishable from a real zero.
 */
const unresolvable = [];
/**
 * Scans one file's already-comment-stripped content for `WRITE` matches and records them, shared
 * between the `.ts` walk below and `schema.sql` (Finding 2) so both go through one path rather
 * than two copies of the same match-handling logic drifting apart.
 *
 * v4 (post-review, round 4): `IDENT`'s bare-identifier alternative is `[A-Za-z_]\w*` — a character
 * class that does not, and cannot, include `$`. Fed a template literal whose table name has a
 * *static prefix* followed by an interpolation — `` `UPDATE canonical_turn_${suffix} SET …` `` —
 * the regex does not fail to match, the way it does for a name with no static prefix at all
 * (`` `${table}` ``, already routed to `unresolvable` below). It succeeds, greedily, capturing only
 * the prefix (`canonical_turn_`) and stopping exactly where `$` breaks the character class. That
 * prefix does not equal any governed table's name, so the write was previously dropped as a
 * resolved-but-unmatched reference — indistinguishable from a typo or an unrelated table — even
 * though `suffix === "s"` makes it a live write to `canonical_turns` in production
 * (`src/db/database.ts`'s `Db.run`). A blind review reproduced this and named it precisely: being
 * confidently wrong about a truncated name is worse than the honest "cannot resolve" this file
 * already prints for a name with no static part, because a wrong-but-plausible answer does not
 * look like a gap. So a captured identifier immediately followed by `${` is not a different,
 * smaller table name — it is the same truncation-at-`$`, one interpolation later than the
 * no-static-prefix case, and is routed to the same `unresolvable` path rather than resolved.
 */
const scanForWrites = (file, content) => {
  for (const match of content.matchAll(WRITE)) {
    // `TABLE_REF` is spliced into the pattern once per branch above, so each occurrence claims its
    // own group number (1-4) rather than sharing one — only the branch that actually matched has a
    // defined group, so the table name is whichever of the four is not `undefined`.
    const capturedTable = match[1] ?? match[2] ?? match[3] ?? match[4];
    const matchEnd = match.index + match[0].length;
    // `IDENT`'s bare alternative stops at `$` rather than failing outright, so a name like
    // `canonical_turn_${suffix}` reads as a complete match on the static prefix alone unless this
    // checks what comes right after it. No other legal SQL token follows a table reference with
    // `${` glued on with zero separating whitespace, so this is unambiguous, not a heuristic guess.
    const truncatedByInterpolation = capturedTable !== undefined && content.slice(matchEnd, matchEnd + 2) === "${";
    if (capturedTable === undefined || truncatedByInterpolation) {
      const after = content.slice(matchEnd, matchEnd + 40).replace(/\s+/g, " ").trim();
      unresolvable.push({ file, verb: match[0].trim(), after });
      continue;
    }
    const table = governedByLower.get(unquoteIdent(capturedTable).toLowerCase());
    if (table !== undefined) writesByTable.get(table).push(file);
  }
};

for (const file of files) {
  const raw = readFileSync(join(ROOT, file), "utf8");
  scanForWrites(file, stripComments(raw));
}

/**
 * Finding 2: `schema.sql` is not a `.ts` file, so the walk above never reads it — but
 * `schemaDdl()` in `migrations.ts` installs it whole into the real database, and a trigger body
 * writing a governed table would be exactly as live a writer as any TypeScript module. Scanned
 * here through `stripSqlComments` (SQL's own comment grammar, not JS's) rather than `stripComments`
 * so this file's own trigger doc comments — which quote past defective SQL verbatim — do not read
 * as a live write.
 */
scanForWrites("src/db/schema.sql", strippedSchema);

const residual = [];
const staleOwners = [];
for (const table of governedTables) {
  const seenFiles = [...new Set(writesByTable.get(table))].sort();
  const allowed = new Set(OWNERS[table]);
  for (const file of seenFiles) {
    if (!allowed.has(file)) residual.push({ table, file });
  }
  for (const owner of OWNERS[table]) {
    if (!seenFiles.includes(owner)) staleOwners.push({ table, owner });
  }
}

// What it inspected, beside what exists — a table this scan found zero writers for is reported as
// zero, not omitted, so a reader can tell "checked, empty" from "not checked".
const report = governedTables
  .map((table) => {
    const seenFiles = [...new Set(writesByTable.get(table))].sort();
    return `  ${table}: ${seenFiles.length} writer file(s)${seenFiles.length > 0 ? ` (${seenFiles.join(", ")})` : ""}`;
  })
  .join("\n");

/**
 * v4 (post-review, round 4): a blind review named a shape no static regex can close — a write
 * whose keyword is assembled at the source-text level rather than written contiguously, e.g.
 * `"UP" + "DATE canonical_turns "` (which SQLite still executes as `UPDATE canonical_turns …`
 * once the strings concatenate at runtime, but which never contains the contiguous substring
 * `UPDATE` for `WRITE` to match). This is a different defect shape from every fix above: those
 * were all cases where the *table name* could not be resolved even though the *statement* was
 * plainly visible as a write. This is a case where the statement itself is not visible as
 * contiguous SQL-shaped text at all, so `WRITE` never fires and nothing is added to `residual`,
 * `unresolvable`, or the counts above — a silent zero indistinguishable from a real one. Actually
 * catching it would mean evaluating string concatenation (and arbitrary computation feeding it),
 * which is not a regex problem and is explicitly out of scope for this fix. Printed on every run,
 * pass or fail, so "0 writes found" here is never read as "0 writes exist, in every shape a write
 * could take."
 */
const SCOPE_NOTE =
  "SCOPE: this census matches SQL keywords and table names as contiguous source text. A write " +
  'whose keyword is assembled from parts (e.g. `"UP" + "DATE " + table`) rather than written as ' +
  "one contiguous token is not visible to this scan and is not represented in the counts above — " +
  "this file finds zero writers for a statement built that way, not zero writers of that shape.";

if (unresolvable.length > 0) {
  process.stdout.write(
    `${report}\n${SCOPE_NOTE}\n\n` +
      unresolvable
        .map(
          ({ file, verb, after }) =>
            `  ${file}: \`${verb}\` is followed by \`${after}…\`, not a static table name this ` +
            "census can read. It may or may not target a governed table — a dynamically built " +
            "identifier cannot be resolved by any static scan.\n",
        )
        .join("") +
      "\nName the table statically, or move the construction somewhere this census's authors have " +
      "reviewed by hand and can vouch for out of band.\n" +
      `RESULT: FAIL — ${unresolvable.length} write(s) with a table name this census could not resolve. ` +
      "Unresolved is not the same as clean.\n",
  );
  process.exit(1);
}

if (staleOwners.length > 0) {
  process.stdout.write(
    `${report}\n${SCOPE_NOTE}\n\n` +
      staleOwners
        .map(
          ({ table, owner }) =>
            `  ${table}: the declared owner ${owner} writes nothing here anymore — an unused ` +
            `exemption, not a covered one.\n`,
        )
        .join("") +
      `\nRESULT: FAIL — ${staleOwners.length} owner entry(ies) name a file that no longer writes ` +
      "its table.\n",
  );
  process.exit(1);
}

if (residual.length > 0) {
  process.stdout.write(
    `${report}\n${SCOPE_NOTE}\n\n` +
      residual
        .map(
          ({ table, file }) =>
            `  ${table}: ${file} writes this table and is not in its owner list (${
              OWNERS[table].join(", ") || "none — expected zero writers"
            }).\n`,
        )
        .join("") +
      "\nA second writer of a turn-fence-governed table can satisfy every schema trigger while " +
      "going around the coordinator's own sequencing. Route the write through the owner above, or " +
      "add this file to OWNERS in this script with the reason it is allowed to hold the pen too.\n" +
      `RESULT: FAIL — ${residual.length} write(s) from a file outside the table's owner list. ` +
      "residual != 0.\n",
  );
  process.exit(1);
}

const totalWriters = governedTables.reduce((n, t) => n + new Set(writesByTable.get(t)).size, 0);
process.stdout.write(
  `${report}\n${SCOPE_NOTE}\n\n` +
    `RESULT: PASS — ${governedTables.length} governed table(s), ${totalWriters} writer file ` +
    "reference(s), every one inside its table's owner list, 0 unresolved write(s). residual: 0.\n",
);
