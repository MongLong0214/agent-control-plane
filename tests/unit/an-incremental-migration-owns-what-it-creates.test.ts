import Database from "better-sqlite3";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { MIGRATIONS } from "../../src/db/migrations.ts";
import {
  REPLAY_FUNCTION,
  migrationsReachingTheReplay,
} from "../helpers/migration-replay-reachability.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * #762 — object provenance derived from the lineage that actually shipped.
 *
 * Two earlier attempts at this had no denominator of their own. The first asked
 * `ledgerTriggerDdl(version)` which triggers belong to a version and then checked that function
 * against its own answer. The second derived ownership from "the first step that creates it" and
 * collapsed: `v12` and `v13` both replay the whole current `schema.sql`, so everything came out
 * owned by 13 and nothing was ever late — measured, with the mutation in place and the detector
 * silent.
 *
 * The fix for both is a baseline that is a fact rather than a derivation. The deployment's own
 * v25 (`tests/fixtures/schema-v25-lineage.sql`) is a database that really existed: whatever is in
 * it was owned at or before 25, no inference required. Ownership after that is the first
 * incremental step that creates something the baseline does not have, and the replay steps are
 * classified out structurally rather than skipped by name.
 *
 * Nothing here names a schema object. The one this issue is about is found by the same rule that
 * would find the next one.
 */

const LINEAGE = readFileSync(
  new URL("../fixtures/schema-v25-lineage.sql", import.meta.url),
  "utf8",
);
const LINEAGE_VERSION = 25;

/**
 * The sealed owner trace: object name, type, and the first incremental step that creates it,
 * captured from a completed 25→36 run of the real lineage and committed as a fixture.
 */
const TRACE_TEXT = readFileSync(
  new URL("../fixtures/v25-owner-trace.json", import.meta.url),
  "utf8",
);

/**
 * Duplicate keys are rejected before parsing, not after.
 *
 * `JSON.parse` keeps the last of two identical keys and drops the first silently, so a trace with
 * one name written twice loses an ownership and still parses into a plausible object. The raw
 * text is the only place that fact survives.
 */
const parseTraceRejectingDuplicates = (text: string): TraceShape => {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  JSON.parse(text, function reviver(this: unknown, key: string, value: unknown) {
    return value;
  });
  for (const match of text.matchAll(/^\s{4}"([^"]+)":\s*\{/gm)) {
    const name = match[1]!;
    if (seen.has(name)) duplicates.push(name);
    seen.add(name);
  }
  if (duplicates.length > 0) {
    throw new Error(`owner trace has duplicate object keys: ${duplicates.sort().join(", ")}`);
  }
  return JSON.parse(text) as TraceShape;
};

interface TraceShape {
  baselineVersion: number;
  baselineFixture: string;
  objects: Record<string, { type: string; owner: number }>;
}

const TRACE = parseTraceRejectingDuplicates(TRACE_TEXT);

/**
 * Migrations that replay a schema snapshot instead of introducing objects.
 *
 * Classified by what they call, not by version, and asserted below: an unclassified caller of
 * `replayDdlWithoutPostV12Columns()` fails rather than silently becoming an owner of everything
 * the snapshot contains — which is exactly how the second attempt broke.
 */
const DECLARED_SNAPSHOT_REPLAY = ["v12-migration-ledger-and-invariant-replay", "v13-finalization-state-machine"];

const MIGRATIONS_PATH = fileURLToPath(new URL("../../src/db/migrations.ts", import.meta.url));

/**
 * Migrations that can reach the snapshot replay, resolved through the call graph.
 *
 * Was a regular expression over `id: "…"` plus a text slice, which attributes a call to whichever
 * id happens to appear above it. Review named both failures: a call moved into a helper is
 * attributed to nothing, and a call in a function declared between two migration literals is
 * attributed to the earlier one — either way a new caller appears and the answer stays the same.
 */
const snapshotReplayCallers = (): string[] => migrationsReachingTheReplay(MIGRATIONS_PATH).reaching;

interface Step {
  id: string;
  toVersion: number;
  statements: string[];
  /** Set when the step could not run against the lineage — the deployment's own symptom. */
  failure?: string;
}

const CREATE_PATTERNS = [
  /\bCREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/gi,
  /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/gi,
  /\bCREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/gi,
];

const REFERENCE_PATTERNS = [
  /\bON\s+["`]?(\w+)/gi,
  /\bFROM\s+["`]?(\w+)/gi,
  /\bJOIN\s+["`]?(\w+)/gi,
  /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+["`]?(\w+)/gi,
  /\bUPDATE\s+["`]?(\w+)/gi,
  /\bALTER\s+TABLE\s+["`]?(\w+)/gi,
  /\bREFERENCES\s+["`]?(\w+)/gi,
];

const namesMatching = (statements: readonly string[], patterns: readonly RegExp[]): Set<string> => {
  const found = new Set<string>();
  for (const sql of statements) {
    for (const pattern of patterns) for (const match of sql.matchAll(pattern)) found.add(match[1]!);
  }
  return found;
};

/**
 * Owner of every object, read from the sealed trace rather than computed from the code under test.
 *
 * The previous version derived this from a run of the migrations themselves, which made the
 * answer move whenever the source moved — so a mutation changed both the code and the standard it
 * was being judged against, and the two agreed all the way down. Sealing the trace as a fixture
 * is what makes the mutation control mean something: the owner truth is the same file before and
 * after the edit.
 *
 * The baseline is a fact about a database that existed, not an inference: everything in
 * `schema-v25-lineage.sql` was owned at or before 25.
 */
export const sealedOwnership = (): Map<string, number> => {
  const owner = new Map<string, number>();
  for (const name of baselineObjects()) owner.set(name, TRACE.baselineVersion);
  for (const [name, entry] of Object.entries(TRACE.objects)) owner.set(name, entry.owner);
  return owner;
};

/** Ownership from an explicit map — the seam the synthetic controls below feed. */
export const ownership = (
  baseline: ReadonlySet<string>,
  baselineVersion: number,
  steps: readonly Step[],
): Map<string, number> => {
  const owner = new Map<string, number>();
  for (const name of baseline) owner.set(name, baselineVersion);
  for (const step of steps) {
    for (const name of namesMatching(step.statements, CREATE_PATTERNS)) {
      if (!owner.has(name)) owner.set(name, step.toVersion);
    }
  }
  return owner;
};

/** Every step that reads or writes an object a later step owns. */
export const futureObjectLeaks = (
  owner: ReadonlyMap<string, number>,
  steps: readonly Step[],
): string[] => {
  const leaks: string[] = [];
  for (const step of steps) {
    const creates = namesMatching(step.statements, CREATE_PATTERNS);
    for (const name of namesMatching(step.statements, REFERENCE_PATTERNS)) {
      if (creates.has(name)) continue;
      const ownedAt = owner.get(name);
      if (ownedAt !== undefined && ownedAt > step.toVersion) {
        leaks.push(`${step.id} references ${name}, owned by v${ownedAt}`);
      }
    }
  }
  return [...new Set(leaks)].sort();
};

/** The objects the deployment's own v25 already had. */
const baselineObjects = (): Set<string> => {
  const path = join(tempDir("acp-762-baseline-"), "state.sqlite");
  const raw = new Database(path);
  try {
    raw.function("acp_schema_migration_authorized", () => 1);
    raw.exec(LINEAGE);
    return new Set(
      (raw.prepare("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
  } finally {
    raw.close();
  }
};

/**
 * `name:type@vN` for every object the real lineage gains, by first appearance in `sqlite_master`.
 *
 * The authority is the database's own catalogue at each boundary. A statement can be issued and
 * change nothing (`CREATE … IF NOT EXISTS` against something already there), and counting that as
 * ownership is what the SQL-scraping version did.
 */
const schemaTransitionCensus = (): string[] => {
  const path = join(tempDir("acp-762-census-"), "state.sqlite");
  const raw = new Database(path);
  raw.function("acp_schema_migration_authorized", () => 1);
  raw.exec(LINEAGE);
  raw.pragma(`user_version = ${LINEAGE_VERSION}`);

  const snapshot = (): Map<string, string> =>
    new Map(
      (raw
        .prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string; type: string }>).map((row) => [row.name, row.type]),
    );

  const rows: string[] = [];
  const owned = new Set<string>();
  try {
    let previous = snapshot();
    for (const migration of MIGRATIONS) {
      if (migration.fromVersion < LINEAGE_VERSION) continue;
      migration.apply(raw);
      const now = snapshot();
      for (const [name, type] of now) {
        if (previous.has(name)) continue;
        // Duplicate ownership is impossible by construction here, and asserted anyway: two steps
        // both claiming to introduce one object would mean the snapshot lost it in between.
        if (owned.has(name)) throw new Error(`two steps introduce ${name}`);
        owned.add(name);
        rows.push(`${name}:${type}@v${migration.toVersion}`);
      }
      previous = now;
    }
  } finally {
    raw.close();
    chmodSync(path, 0o600);
  }
  return rows.sort();
};

/**
 * Runs the incremental steps above the lineage version and records the SQL each one issues.
 *
 * Against the lineage artifact, not a current bootstrap: these are the statements the deployment
 * would actually run, and a step that cannot run there is the failure this whole issue is.
 */
const incrementalSteps = (): Step[] => {
  const path = join(tempDir("acp-762-incremental-"), "state.sqlite");
  const raw = new Database(path);
  raw.function("acp_schema_migration_authorized", () => 1);
  raw.exec(LINEAGE);
  raw.pragma(`user_version = ${LINEAGE_VERSION}`);

  const realExec = raw.exec.bind(raw);
  const realPrepare = raw.prepare.bind(raw);
  let current: string[] = [];
  (raw as unknown as { exec: (sql: string) => unknown }).exec = (sql: string) => {
    current.push(sql);
    return realExec(sql);
  };
  (raw as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    current.push(sql);
    return realPrepare(sql);
  };

  const steps: Step[] = [];
  try {
    for (const migration of MIGRATIONS) {
      if (migration.fromVersion < LINEAGE_VERSION) continue;
      current = [];
      try {
        migration.apply(raw);
      } catch (error) {
        // A step that cannot run against the real v25 is the production failure itself, and it
        // stops the chain there exactly as it stopped the deployment. The statements it issued
        // before dying are kept, because those are what name *which* object it reached for —
        // without them the run reports only that something threw.
        steps.push({
          id: migration.id,
          toVersion: migration.toVersion,
          statements: current,
          failure: error instanceof Error ? error.message : String(error),
        });
        break;
      }
      steps.push({ id: migration.id, toVersion: migration.toVersion, statements: current });
    }
  } finally {
    raw.close();
    chmodSync(path, 0o600);
  }
  return steps;
};

describe("#762 snapshot replays are not object owners", () => {
  it("classifies every caller of the snapshot replay, and refuses a new one", () => {
    // The classification is the load-bearing part: an unclassified replay caller would own every
    // object in the snapshot and make the leak check below vacuous, which is what happened when
    // `v13` was not accounted for.
    expect(snapshotReplayCallers().sort()).toEqual([...DECLARED_SNAPSHOT_REPLAY].sort());
  });

  it("keeps the sealed trace and the candidate's own schema transitions in both-way agreement", () => {
    // The drift gate, and it compares **typed triples**: name alone let a type be rewritten in
    // the trace with nothing noticing. Derived from `sqlite_master` before and after each step
    // rather than from the SQL a step issued, because a conditional CREATE that changed nothing
    // is not an introduction — measured, that difference is two objects.
    const census = schemaTransitionCensus();
    const sealed = Object.entries(TRACE.objects)
      .map(([name, entry]) => `${name}:${entry.type}@v${entry.owner}`)
      .sort();
    expect(census).toEqual(sealed);
    expect(TRACE.baselineVersion).toBe(LINEAGE_VERSION);
    expect(TRACE.baselineFixture).toBe("tests/fixtures/schema-v25-lineage.sql");
  });

  it("still classifies a caller whose replay call moved into a helper", () => {
    // The discriminating case for the resolver. A text slice keyed on `id: "…"` attributes this
    // call to nothing — the helper is declared outside every migration literal — so the old
    // classification reported the same two names with a third caller present.
    const source = join(tempDir("acp-762-moved-"), "moved.ts");
    writeFileSync(
      source,
      [
        `const viaHelper = (raw: unknown): void => { ${REPLAY_FUNCTION}(); void raw; };`,
        `export const ${REPLAY_FUNCTION} = (): string => "";`,
        "const m = {",
        '  id: "v99-moved-into-a-helper",',
        "  fromVersion: 98,",
        "  toVersion: 99,",
        "  apply: (raw: unknown) => { viaHelper(raw); },",
        '  checksum: () => "",',
        "};",
        "void m;",
      ].join("\n"),
      "utf8",
    );
    expect(migrationsReachingTheReplay(source).reaching).toEqual(["v99-moved-into-a-helper"]);
  });

  it("does not attribute a replay call to a migration that merely precedes it in the file", () => {
    // The other half of the same defect: a slice attributes a call in a function declared between
    // two literals to the earlier one, so a migration that never calls anything is reported as a
    // replayer and the real caller is not.
    const source = join(tempDir("acp-762-adjacent-"), "adjacent.ts");
    writeFileSync(
      source,
      [
        `export const ${REPLAY_FUNCTION} = (): string => "";`,
        "const a = {",
        '  id: "v98-calls-nothing",',
        "  fromVersion: 97,",
        "  toVersion: 98,",
        "  apply: () => {},",
        '  checksum: () => "",',
        "};",
        `const between = (): void => { ${REPLAY_FUNCTION}(); };`,
        "const b = {",
        '  id: "v99-calls-between",',
        "  fromVersion: 98,",
        "  toVersion: 99,",
        "  apply: () => { between(); },",
        '  checksum: () => "",',
        "};",
        "void a; void b;",
      ].join("\n"),
      "utf8",
    );
    expect(migrationsReachingTheReplay(source).reaching).toEqual(["v99-calls-between"]);
  });

  it("keeps the replay steps outside the incremental chain entirely", () => {
    // Not "skipped by name" — they are below the lineage version, so the deployment's own chain
    // never reaches them and neither does this measurement.
    const ids = incrementalSteps().map((step) => step.id);
    for (const replay of DECLARED_SNAPSHOT_REPLAY) expect(ids).not.toContain(replay);
  });
});

describe("#762 the sealed trace refuses the ways it could quietly stop being true", () => {
  it("rejects a duplicate object key before parsing keeps only the last one", () => {
    // `JSON.parse` drops the first of two identical keys silently, so a trace with one name
    // written twice loses an ownership and still parses into a plausible object.
    const doubled = TRACE_TEXT.replace(
      /^(\s{4}"[^"]+":\s*\{\n(?:.*\n)*?\s{4}\},\n)/m,
      "$1$1",
    );
    expect(doubled).not.toBe(TRACE_TEXT);
    expect(() => parseTraceRejectingDuplicates(doubled)).toThrowError(/duplicate object keys/);
  });

  it("fails when an entry's type is rewritten", () => {
    // The comparison is on typed triples for this reason: keyed on name alone, a trigger
    // relabelled as a table matches and nothing says so.
    const [name, entry] = Object.entries(TRACE.objects)[0]!;
    const swapped = { ...TRACE.objects, [name]: { ...entry, type: `${entry.type}-rewritten` } };
    const sealed = Object.entries(swapped)
      .map(([n, e]) => `${n}:${e.type}@v${e.owner}`)
      .sort();
    expect(schemaTransitionCensus()).not.toEqual(sealed);
  });

  it("fails on an entry that names nothing, and on an object with no entry", () => {
    const census = schemaTransitionCensus();
    const rows = (objects: Record<string, { type: string; owner: number }>) =>
      Object.entries(objects)
        .map(([n, e]) => `${n}:${e.type}@v${e.owner}`)
        .sort();

    // Stale: an entry the candidate no longer produces.
    expect(census).not.toEqual(
      rows({ ...TRACE.objects, zzz_not_in_the_candidate: { type: "table", owner: 30 } }),
    );

    // Omitted: an object the candidate produces with no entry to describe it.
    const [dropped] = Object.keys(TRACE.objects);
    const withoutOne = { ...TRACE.objects };
    delete withoutOne[dropped!];
    expect(census).not.toEqual(rows(withoutOne));
  });

  it("reads identifiers the SQL text would have hidden", () => {
    // Bracketed, quoted, schema-qualified and multi-line identifiers are all valid SQLite and all
    // read differently by a regular expression over the statement. `sqlite_master` reports the
    // resolved name whatever the source looked like, which is why the census asks it and not the
    // SQL.
    const path = join(tempDir("acp-762-identifiers-"), "s.sqlite");
    const raw = new Database(path);
    try {
      raw.exec(`CREATE TABLE [bracketed name] (id INTEGER PRIMARY KEY)`);
      raw.exec(`CREATE TABLE "quoted-with-hyphen" (id INTEGER PRIMARY KEY)`);
      raw.exec(`CREATE TABLE main.qualified (id INTEGER PRIMARY KEY)`);
      raw.exec(`CREATE\n  TABLE\n  split_across_lines (id INTEGER PRIMARY KEY)`);
      const names = new Set(
        (raw
          .prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
          .all() as Array<{ name: string }>).map((row) => row.name),
      );
      expect([...names].sort()).toEqual([
        "bracketed name",
        "qualified",
        "quoted-with-hyphen",
        "split_across_lines",
      ]);
    } finally {
      raw.close();
    }
  });
});

describe("#762 no incremental migration references an object a later one owns", () => {
  it("measured a real chain from the lineage baseline", () => {
    const baseline = baselineObjects();
    const steps = incrementalSteps();
    // Vacuity guards, both directions: a baseline that read nothing would make every object look
    // new, and a chain that recorded nothing would make every check pass.
    expect(baseline.size).toBeGreaterThan(50);
    expect(steps).toHaveLength(MIGRATIONS.filter((m) => m.fromVersion >= LINEAGE_VERSION).length);
    expect(steps.filter((step) => step.statements.length === 0).map((step) => step.id)).toEqual([
      "v33-back-up-before-telegram-settlement-state",
    ]);
    // And the baseline has to be the historical one, or its objects are not facts about v25.
    expect(baseline.has("canonical_turns")).toBe(true);
    expect(baseline.has("canonical_turn_dispatches")).toBe(false);
  });

  it("finds no leak in the shipped chain, and every step runs", () => {
    const steps = incrementalSteps();
    // Both halves. The leak list is the diagnosis and the failure list is the symptom; a chain
    // that dies at v26 with a leak reported is the defect, and one that dies with no leak
    // reported is a different defect this file has not explained.
    // The sealed trace, not a run of the code being judged: under a mutation the owner truth has
    // to stay put or the control proves nothing.
    expect(futureObjectLeaks(sealedOwnership(), steps)).toEqual([]);
    expect(steps.filter((step) => step.failure).map((step) => `${step.id}: ${step.failure}`)).toEqual([]);
  });

  it("reports a later-owned object referenced by an earlier step, whatever it is called", () => {
    // The generic control. Two synthetic steps, an object this file has never heard of, and the
    // same functions the real chain runs through: the rule is what catches it, not a name.
    const synthetic: Step[] = [
      { id: "vX-early", toVersion: 26, statements: ["CREATE TRIGGER t BEFORE INSERT ON zzz_later_table BEGIN SELECT 1; END"] },
      { id: "vY-late", toVersion: 29, statements: ["CREATE TABLE zzz_later_table (id INTEGER PRIMARY KEY)"] },
    ];
    const owner = ownership(new Set(["already_here"]), LINEAGE_VERSION, synthetic);

    expect(owner.get("zzz_later_table")).toBe(29);
    expect(futureObjectLeaks(owner, synthetic)).toEqual([
      "vX-early references zzz_later_table, owned by v29",
    ]);
  });

  it("says nothing when the same object is owned early enough", () => {
    // The negative control for the control: move the creation before the reference and the rule
    // has to fall silent, or it reports every reference and means nothing.
    const synthetic: Step[] = [
      { id: "vY-early", toVersion: 26, statements: ["CREATE TABLE zzz_later_table (id INTEGER PRIMARY KEY)"] },
      { id: "vX-late", toVersion: 29, statements: ["CREATE TRIGGER t BEFORE INSERT ON zzz_later_table BEGIN SELECT 1; END"] },
    ];
    expect(futureObjectLeaks(ownership(new Set(), LINEAGE_VERSION, synthetic), synthetic)).toEqual(
      [],
    );
  });
});
