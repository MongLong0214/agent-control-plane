import Database from "better-sqlite3";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { MIGRATIONS } from "../../src/db/migrations.ts";
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
const TRACE = JSON.parse(
  readFileSync(new URL("../fixtures/v25-owner-trace.json", import.meta.url), "utf8"),
) as {
  baselineVersion: number;
  baselineFixture: string;
  objects: Record<string, { type: string; owner: number }>;
};

/**
 * Migrations that replay a schema snapshot instead of introducing objects.
 *
 * Classified by what they call, not by version, and asserted below: an unclassified caller of
 * `replayDdlWithoutPostV12Columns()` fails rather than silently becoming an owner of everything
 * the snapshot contains — which is exactly how the second attempt broke.
 */
const DECLARED_SNAPSHOT_REPLAY = ["v12-migration-ledger-and-invariant-replay", "v13-finalization-state-machine"];

const MIGRATIONS_SOURCE = readFileSync(
  new URL("../../src/db/migrations.ts", import.meta.url),
  "utf8",
);

/** Every migration whose body calls the snapshot replay, read out of the source. */
const snapshotReplayCallers = (): string[] => {
  const callers: string[] = [];
  const ids = [...MIGRATIONS_SOURCE.matchAll(/^  id: "(v\d+-[a-z0-9-]+)",$/gm)];
  for (const [index, match] of ids.entries()) {
    const body = MIGRATIONS_SOURCE.slice(
      match.index!,
      ids[index + 1]?.index ?? MIGRATIONS_SOURCE.length,
    );
    if (body.includes("replayDdlWithoutPostV12Columns()")) callers.push(match[1]!);
  }
  return callers;
};

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

  it("keeps the sealed trace and the candidate's own CREATE census in both-way agreement", () => {
    // The drift gate. A sealed fixture is only truth for as long as it still describes the code:
    // this regenerates the census from the lineage run and compares it to the trace in both
    // directions, so a new object with no entry fails and a stale entry naming nothing fails too.
    const steps = incrementalSteps();
    expect(steps.filter((step) => step.failure)).toEqual([]);

    const baseline = baselineObjects();
    const census = new Map<string, number>();
    for (const step of steps) {
      for (const name of namesMatching(step.statements, CREATE_PATTERNS)) {
        if (baseline.has(name) || census.has(name)) continue;
        census.set(name, step.toVersion);
      }
    }

    const sealed = new Map(
      Object.entries(TRACE.objects).map(([name, entry]) => [name, entry.owner] as const),
    );
    const asRows = (map: ReadonlyMap<string, number>) =>
      [...map.entries()].map(([name, owner]) => `${name}@v${owner}`).sort();

    expect(asRows(census)).toEqual(asRows(sealed));
    expect(TRACE.baselineVersion).toBe(LINEAGE_VERSION);
    expect(TRACE.baselineFixture).toBe("tests/fixtures/schema-v25-lineage.sql");
  });

  it("keeps the replay steps outside the incremental chain entirely", () => {
    // Not "skipped by name" — they are below the lineage version, so the deployment's own chain
    // never reaches them and neither does this measurement.
    const ids = incrementalSteps().map((step) => step.id);
    for (const replay of DECLARED_SNAPSHOT_REPLAY) expect(ids).not.toContain(replay);
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
