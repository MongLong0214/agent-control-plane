import { V52_ADDED_TRIGGERS, V53_ADDED_TRIGGERS } from "../helpers/released-v50-schema.ts";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { restoreDatabase } from "../../src/db/backup.ts";
import { Db } from "../../src/db/database.ts";
import { approveMigration, migrationApprovalPath } from "../../src/db/migration-approval.ts";
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  claimsUnvettedOwnerDecision,
  isOwnerDecisionContent,
  normalizedProducerLabel,
  ownerDecisionShapeSql,
} from "../../src/db/migrations.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { laterObjectsIn, releasedChainImage } from "../helpers/released-chain-image.ts";
import { digestOfSchemaRows, privateStatePath, schemaRowsOf } from "../helpers/released-v44-schema.ts";
import { V45_BASE_CHECKSUM, contentDigests } from "../helpers/released-v45-schema.ts";
import { V46_BASE_CHECKSUM, V46_SCHEMA_DIGEST_FROM_V11 } from "../helpers/released-v46-schema.ts";
import {
  V47_ADDED_TRIGGERS,
  V47_BASE_CHECKSUM,
  V47_CANDIDATE_CHECKSUM,
  V47_R2_CANDIDATE_CHECKSUM,
  asCandidateV47,
} from "../helpers/released-v47-schema.ts";
import { V48_ADDED_TRIGGERS } from "../helpers/released-v48-schema.ts";


afterAll(cleanupTempDirs);

/**
 * SEC-OD1 (v47) — `run_artifacts_owner_decision_authority_guard`. An APPROVAL that carries the canonical
 * owner-decision label, or OWNER_DECISION content, is inserted only while the connection-local evidence
 * marker returns exactly 1, which ACP sets for one statement of `putOwnerDecision`'s capability write.
 *
 *   G1  On ACP's connection, an ordinary `Db.run` of either shape is refused, typed
 *       OWNER_AUTHORITY_NOT_DELEGABLE; every other artifact kind and every other APPROVAL is admitted.
 *   G2  Fail-closed: on a connection whose marker function is missing, returns NULL, 0, 2, '1' or throws,
 *       the insert is refused. A connection that defines it to return 1 passes: the stated Limit
 *       (CEO 52c3b1e6 (b)), not a claim that every raw writer is stopped.
 *   G3  Each predicate is load-bearing (mutation checks).
 *   S1  v46 → v47 on the released v46 image keeps every row, OWNER_DECISION rows labelled "service"
 *       included, keeps the v45 and v46 receipts byte for byte, and adds only the trigger and its receipt.
 *   S2  The step refuses any other object holding the name, restoring the image; it never replaces one.
 *       An exact pre-existing definition is accepted, and a repeated application changes nothing.
 *   S3  Rollback: a fault after v47 commits restores the v46 image, and the pre-migration backup
 *       restores through the operator restore drill.
 *   S4  FIX-SEC-R2 (CEO 85eac6ef, option B): an APPROVAL that already carries the canonical label when
 *       the guard is first installed refuses the step, whoever wrote it, with OWNER_DECISION_LABEL_PREDATES_GUARD
 *       and the first artifact ids, cut short; nothing is installed, no receipt is written, the image is
 *       restored and no row is deleted, relabelled or promoted. Only the label clause is read, never
 *       "service" history. Once the guard is installed, canonical decisions never refuse v48 or a reopen.
 *
 * Pre-v47 and post-v47 are never mixed: what the released v46 image admits is measured on that image
 * before it is migrated, and every refusal is measured on the image v47 produced.
 */

const NOW = "2026-10-18T00:00:00.000Z";
const RUN = "run_v47";
const CANDIDATE = `sha256:${"c".repeat(64)}`;
const LABEL = "production-gate:owner-decision";
const SENTINEL = /OWNER_DECISION_WRITE_AUTHORITY_DENIED/;
const GUARD = V47_ADDED_TRIGGERS[0]!;

/** An OWNER_DECISION record's content, as `recordOwnerDecision` writes it (receipt elided). */
const decision = (item: string, approved: boolean): Record<string, unknown> => ({
  kind: "OWNER_DECISION",
  item,
  approved,
  note: `${approved ? "approve" : "refuse"} ${item}`,
  at: NOW,
  humanGateDigest: "sha256:gate",
  candidateSnapshotDigest: CANDIDATE,
});

interface Row {
  id: string;
  kind: string;
  content: string;
  producedBy: string;
  candidate?: string | null;
}

let rowSeq = 0;
const row = (kind: string, content: unknown, producedBy: string, candidate: string | null = CANDIDATE): Row => ({
  id: `art_v47_${(rowSeq += 1)}`,
  kind,
  content: typeof content === "string" ? content : JSON.stringify(content),
  producedBy,
  candidate,
});

const INSERT = `INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const params = (r: Row): unknown[] => [r.id, RUN, r.kind, `sha256:${r.id}`, r.candidate ?? null, r.content, r.producedBy, NOW];

/** A connection ACP did not open, whose marker function is whatever `marker` says (absent if undefined). */
const foreign = (path: string, marker?: () => unknown): Database.Database => {
  const raw = new Database(path);
  if (marker !== undefined) raw.function("acp_evidence_write_authorized", marker as () => number);
  return raw;
};

const tryInsert = (raw: Database.Database, r: Row, verb = "INSERT"): string => {
  try {
    raw.prepare(INSERT.replace("INSERT", verb)).run(...params(r));
    return "ADMITTED";
  } catch (error) {
    return String((error as Error).message);
  }
};

/** A run and its candidate snapshot, so evidence and approvals have something to name. */
const seedRun = (raw: Database.Database): void => {
  raw.prepare(
    `INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
     VALUES (?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'QUEUED', 'v47 witness', 'sha256:contract', ?)`,
  ).run(RUN, NOW);
  raw.prepare(INSERT).run(...params(row("CANDIDATE_SNAPSHOT", { candidateSnapshotDigest: CANDIDATE }, "candidate-pipeline")));
};

/** A fresh database at the current version (v47) with a run, through ACP's own connection. */
const freshWithRun = (prefix: string): string => {
  const path = privateStatePath(prefix);
  new Db(path).close();
  const raw = foreign(path, () => 0);
  try {
    seedRun(raw);
  } finally {
    raw.close();
  }
  return path;
};

/** The two shapes the guard covers, and the rows it must leave alone. */
const GUARDED: ReadonlyArray<{ name: string; row: () => Row }> = [
  { name: "the canonical label on OWNER_DECISION content", row: () => row("APPROVAL", decision("item a", true), LABEL) },
  { name: "the canonical label on other content", row: () => row("APPROVAL", { kind: "NOT_A_DECISION" }, LABEL) },
  { name: "OWNER_DECISION approval content labelled \"service\"", row: () => row("APPROVAL", decision("item a", true), "service") },
  { name: "OWNER_DECISION refusal content labelled \"service\"", row: () => row("APPROVAL", decision("item a", false), "service") },
  { name: "OWNER_DECISION content with no candidate", row: () => row("APPROVAL", decision("item a", true), "service", null) },
  {
    name: "a duplicate key that hides OWNER_DECISION from $.kind but not from JSON.parse",
    row: () => row("APPROVAL", `{"kind":"NOT_A_DECISION","kind":"OWNER_DECISION","item":"item a","approved":true}`, "service"),
  },
  { name: "an escaped key", row: () => row("APPROVAL", `{"k\\u0069nd":"OWNER_DECISION","item":"item a","approved":true}`, "service") },
];

const UNGUARDED: ReadonlyArray<{ name: string; row: () => Row }> = [
  { name: "a CTO approval", row: () => row("APPROVAL", { runId: RUN, resultSummary: "ok", recommendation: "merge" }, "service") },
  { name: "a repo-factory GitHub-write approval (bootstrap T3)", row: () => row("APPROVAL", { kind: "REPO_FACTORY_GITHUB_WRITE_APPROVAL", owner: "o" }, "service") },
  { name: "a CEO decision naming OWNER_DECISION_REQUIRED", row: () => row("APPROVAL", { kind: "CEO_DECISION", decision: "OWNER_DECISION_REQUIRED" }, "service") },
  { name: "OWNER_DECISION nested below the top level", row: () => row("APPROVAL", { kind: "CTO_APPROVAL", inner: { kind: "OWNER_DECISION" } }, "service") },
  { name: "an APPROVAL whose content is not JSON", row: () => row("APPROVAL", "not json", "service") },
  { name: "OWNER_DECISION content on a HANDOFF artifact", row: () => row("HANDOFF", decision("item a", true), "service") },
  { name: "a PLAN", row: () => row("PLAN", { tasks: [] }, "service") },
];

describe("G1: on ACP's own connection, an ordinary Db.run of an owner decision is refused", () => {
  it.each(GUARDED)("refuses $name, typed OWNER_AUTHORITY_NOT_DELEGABLE, and stores nothing", ({ row: make }) => {
    const path = freshWithRun("acp-v47-g1-");
    const db = new Db(path);
    try {
      const r = make();
      let refusal: unknown;
      try {
        db.run(INSERT, params(r));
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toMatchObject({
        reasonCode: ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        evidence: { sqlite: "OWNER_DECISION_WRITE_AUTHORITY_DENIED" },
      });
      for (const verb of ["INSERT OR REPLACE", "REPLACE", "INSERT OR IGNORE"]) {
        expect(() => db.run(INSERT.replace("INSERT", verb), params(make()))).toThrowError(SENTINEL);
      }
      expect(db.get("SELECT COUNT(*) AS n FROM run_artifacts WHERE kind <> 'CANDIDATE_SNAPSHOT'")).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it.each(UNGUARDED)("admits $name", ({ row: make }) => {
    const path = freshWithRun("acp-v47-g1-other-");
    const db = new Db(path);
    try {
      const r = make();
      db.run(INSERT, params(r));
      expect(db.get("SELECT produced_by FROM run_artifacts WHERE artifact_id = ?", [r.id])).toEqual({ produced_by: r.producedBy });
    } finally {
      db.close();
    }
  });
});

describe("G2: the authority check passes only when the marker is exactly 1", () => {
  const MARKERS: ReadonlyArray<{ name: string; marker?: () => unknown; refusal: RegExp }> = [
    { name: "missing", refusal: /no such function: acp_evidence_write_authorized/ },
    { name: "NULL", marker: () => null, refusal: SENTINEL },
    { name: "0", marker: () => 0, refusal: SENTINEL },
    { name: "2", marker: () => 2, refusal: SENTINEL },
    { name: "the text '1'", marker: () => "1", refusal: SENTINEL },
    { name: "an error", marker: () => { throw new Error("marker function failed"); }, refusal: /marker function failed/ },
  ];

  it.each(MARKERS)("a connection whose marker is $name refuses every guarded shape", ({ marker, refusal }) => {
    const path = freshWithRun("acp-v47-g2-");
    const raw = foreign(path, marker);
    try {
      for (const { row: make } of GUARDED) expect(tryInsert(raw, make())).toMatch(refusal);
      expect(raw.prepare("SELECT COUNT(*) FROM run_artifacts WHERE kind = 'APPROVAL'").pluck().get()).toBe(0);
    } finally {
      raw.close();
    }
  });

  it("LIMIT (CEO 52c3b1e6 (b)): a connection that defines the marker itself, to return 1, passes the guard", () => {
    const path = freshWithRun("acp-v47-g2-limit-");
    const raw = foreign(path, () => 1);
    try {
      for (const { row: make } of GUARDED) expect(tryInsert(raw, make())).toBe("ADMITTED");
    } finally {
      raw.close();
    }
  });
});

describe("G3 mutation checks: each predicate of the guard is load-bearing", () => {
  /** Replaces the stored guard's text, as an older or weakened definition would read. */
  const mutate = (path: string, from: string, to: string): void => {
    const raw = new Database(path);
    try {
      const sql = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").pluck().get(GUARD) as string;
      const mutated = sql.replace(from, to);
      expect(mutated).not.toBe(sql);
      raw.exec(`DROP TRIGGER ${GUARD}`);
      raw.exec(mutated);
    } finally {
      raw.close();
    }
  };
  const outcomeOn = (path: string, marker: () => unknown, r: Row): string => {
    const raw = foreign(path, marker);
    try {
      return tryInsert(raw, r);
    } finally {
      raw.close();
    }
  };

  it("without `IS NOT 1` (as `<> 1`, the evidence guard's form), a NULL marker admits a canonical label", () => {
    const r = () => row("APPROVAL", decision("item a", true), LABEL);
    const path = freshWithRun("acp-v47-mut-null-");
    expect(outcomeOn(path, () => null, r())).toMatch(SENTINEL);
    mutate(path, "acp_evidence_write_authorized() IS NOT 1", "acp_evidence_write_authorized() <> 1");
    expect(outcomeOn(path, () => null, r())).toBe("ADMITTED");
  });

  it("without the label clause, the canonical label on other content is admitted", () => {
    const r = () => row("APPROVAL", { kind: "NOT_A_DECISION" }, LABEL);
    const path = freshWithRun("acp-v47-mut-label-");
    expect(outcomeOn(path, () => 0, r())).toMatch(SENTINEL);
    mutate(path, "NEW.produced_by = 'production-gate:owner-decision'", "0");
    expect(outcomeOn(path, () => 0, r())).toBe("ADMITTED");
  });

  it("without the content clause, OWNER_DECISION content labelled \"service\" is admitted", () => {
    const r = () => row("APPROVAL", decision("item a", false), "service");
    const path = freshWithRun("acp-v47-mut-content-");
    expect(outcomeOn(path, () => 0, r())).toMatch(SENTINEL);
    mutate(path, "member.value = 'OWNER_DECISION'", "member.value = 'NEVER'");
    expect(outcomeOn(path, () => 0, r())).toBe("ADMITTED");
  });

  it("reading only $.kind instead of every member, a duplicate key is admitted", () => {
    const r = () => row("APPROVAL", `{"kind":"NOT_A_DECISION","kind":"OWNER_DECISION","item":"item a","approved":false}`, "service");
    expect(JSON.parse(r().content).kind).toBe("OWNER_DECISION");
    const path = freshWithRun("acp-v47-mut-dup-");
    expect(outcomeOn(path, () => 0, r())).toMatch(SENTINEL);
    const raw = new Database(path);
    let sql: string;
    try {
      sql = raw.prepare("SELECT sql FROM sqlite_master WHERE name = ?").pluck().get(GUARD) as string;
    } finally {
      raw.close();
    }
    const exists = /EXISTS \(\s*SELECT 1 FROM json_each\(NEW\.content_json\) member[\s\S]*?'OWNER_DECISION'\s*\)/.exec(sql)![0];
    mutate(path, exists, "json_extract(NEW.content_json, '$.kind') = 'OWNER_DECISION'");
    expect(outcomeOn(path, () => 0, r())).toBe("ADMITTED");
  });

  it("without json_valid first, an ordinary APPROVAL whose content is not JSON is refused as malformed (a regression the clause prevents)", () => {
    const r = () => row("APPROVAL", "not json", "service");
    const path = freshWithRun("acp-v47-mut-valid-");
    expect(outcomeOn(path, () => 0, r())).toBe("ADMITTED");
    mutate(path, "json_valid(NEW.content_json) = 1", "1");
    expect(outcomeOn(path, () => 0, r())).toMatch(/malformed JSON/);
  });
});

/** The released v46 image, built by running the released chain from the v11 fixture and stopping at v46. */
const releasedV46 = (prefix: string): string => {
  const path = releasedChainImage(privateStatePath(prefix), 46);
  expect(laterObjectsIn(path, 46)).toEqual([]);
  expect(digestOfSchemaRows(schemaRowsOf(path))).toBe(V46_SCHEMA_DIGEST_FROM_V11);
  return path;
};

/** Receipts at or below v46, every column. */
const receiptsThrough46 = (path: string): unknown[] => {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.prepare("SELECT * FROM schema_migrations WHERE version <= 46 ORDER BY version").all();
  } finally {
    raw.close();
  }
};

const triggersOf = (path: string): string[] => {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").pluck().all() as string[];
  } finally {
    raw.close();
  }
};

/**
 * Rows as the released v46 build left them: ACP's capability writes (marker 1, evidence) and its
 * ordinary writes (marker 0, the "service" label), OWNER_DECISION refusals and approvals of that era
 * among them. No released build before v47 wrote the canonical label, so none carries it.
 */
const seedAsV46 = (path: string): { legacy: Row[] } => {
  const capability = foreign(path, () => 1);
  try {
    seedRun(capability);
    capability.prepare(INSERT).run(...params(row("VERIFICATION", { candidateSnapshotDigest: CANDIDATE, passed: true }, "verification-engine")));
  } finally {
    capability.close();
  }
  const ordinary = foreign(path, () => 0);
  try {
    const legacy = [
      row("APPROVAL", decision("item b", true), "service"),
      row("APPROVAL", decision("item b", false), "service"),
      row("APPROVAL", { runId: RUN, resultSummary: "ok", recommendation: "merge" }, "service"),
      row("APPROVAL", { kind: "REPO_FACTORY_GITHUB_WRITE_APPROVAL", owner: "o" }, "service"),
    ];
    for (const r of legacy) expect(tryInsert(ordinary, r)).toBe("ADMITTED");
    return { legacy };
  } finally {
    ordinary.close();
  }
};

/**
 * The pre-v47 counterexample, measured on the v46 image before it is migrated: an ordinary write
 * (marker 0) of the canonical label is admitted there, or a write under the marker if `marker` says so.
 */
const writeAtV46 = (path: string, r: Row, marker: () => unknown = () => 0): Row => {
  const raw = foreign(path, marker);
  try {
    expect(tryInsert(raw, r)).toBe("ADMITTED");
  } finally {
    raw.close();
  }
  return r;
};

describe("S1: the v46 → v47 step on the released v46 image", () => {
  it("is the step from 46 to 47; the chain runs on past it when the current version is later (v48, SEC-OD1)", () => {
    expect(MIGRATIONS.find((step) => step.id === "v47-owner-decision-authority-guard")).toMatchObject({ fromVersion: 46, toVersion: 47 });
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(47);
  });

  it("keeps every row, the legacy \"service\" OWNER_DECISION rows included, and the v45 and v46 receipts byte for byte; adds only the guard and its receipt (and v48's, which follows); then refuses the same forgery", () => {
    const path = releasedV46("acp-v47-s1-");
    const { legacy } = seedAsV46(path);
    const before = contentDigests(path);
    const receiptsBefore = receiptsThrough46(path);
    const triggersBefore = triggersOf(path);
    expect(before.userVersion).toBe(46);
    expect(triggersBefore).not.toContain(GUARD);
    expect(receiptsBefore.filter((r) => (r as { version: number }).version >= 45).map((r) => {
      const { version, migration_id, checksum } = r as { version: number; migration_id: string; checksum: string };
      return { version, migration_id, checksum };
    })).toEqual([
      { version: 45, migration_id: "v45-first-manifest-activation", checksum: V45_BASE_CHECKSUM },
      { version: 46, migration_id: "v46-rowid-no-replace", checksum: V46_BASE_CHECKSUM },
    ]);

    approveMigration(path, "v47 S1 preservation witness");
    new Db(path).close();

    const after = contentDigests(path, before.userVersion);
    expect(after.userVersion).toBe(SCHEMA_VERSION);
    const { schema_migrations: receiptsDigestBefore, ...restBefore } = before.tables;
    const { schema_migrations: receiptsDigestAfter, ...restAfter } = after.tables;
    expect(Object.fromEntries(Object.keys(restBefore).map((name) => [name, restAfter[name]]))).toEqual(restBefore);
    expect(receiptsDigestAfter).not.toBe(receiptsDigestBefore);
    expect(receiptsThrough46(path)).toEqual(receiptsBefore);
    // v48 (SEC-OD1) follows on the same approved chain and adds its four triggers, no row.
    expect(triggersOf(path)).toEqual([...triggersBefore, GUARD, ...V48_ADDED_TRIGGERS, "buzz_events_no_replace", "buzz_events_immutable", "buzz_events_no_delete", "outbox_holder_message_terminal", "holder_message_terminals_immutable", "holder_message_terminals_no_delete", "holder_message_terminals_no_replace", ...V52_ADDED_TRIGGERS, ...V53_ADDED_TRIGGERS].sort());
    const raw = new Database(path, { readonly: true });
    try {
      expect(raw.prepare("SELECT version, migration_id, checksum FROM schema_migrations WHERE version = 47").get()).toEqual({
        version: 47,
        migration_id: "v47-owner-decision-authority-guard",
        checksum: MIGRATIONS.find((step) => step.toVersion === 47)!.checksum(),
      });
      for (const r of legacy) {
        expect(raw.prepare("SELECT produced_by, content_json FROM run_artifacts WHERE artifact_id = ?").get(r.id))
          .toEqual({ produced_by: r.producedBy, content_json: r.content });
      }
    } finally {
      raw.close();
    }

    // Post-v47, on the image v47 produced: the same ordinary writes are refused.
    const db = new Db(path);
    try {
      for (const r of [row("APPROVAL", decision("item c", true), LABEL), row("APPROVAL", decision("item b", false), "service")]) {
        expect(() => db.run(INSERT, params(r))).toThrowError(SENTINEL);
      }
    } finally {
      db.close();
    }
  });

  it("the released v46 image migrated to v47 differs at v47 by exactly the guard, whose stored definition is a fresh install's", () => {
    const fresh = privateStatePath("acp-v47-fresh-");
    new Db(fresh).close();
    const freshGuard = schemaRowsOf(fresh).filter((r) => r.name === GUARD);
    expect(freshGuard).toHaveLength(1);
    const path = releasedV46("acp-v47-m3-");
    const before = schemaRowsOf(path);
    approveMigration(path, "v47 M3 witness");
    let after: ReturnType<typeof schemaRowsOf> = [];
    new Db(path, { afterMigration: (migration) => {
      if (migration.toVersion === 47) after = schemaRowsOf(path);
    } }).close();
    expect(after.filter((r) => r.name !== GUARD)).toEqual(before);
    expect(after.filter((r) => r.name === GUARD)).toEqual(freshGuard);
  });
});

describe("S2: whatever already holds the v47 name must be the trigger schema.sql defines", () => {
  const exactDefinition = (): string => {
    const fresh = privateStatePath("acp-v47-exact-def-");
    new Db(fresh).close();
    return schemaRowsOf(fresh).find((r) => r.name === GUARD)!.sql!;
  };

  it("an image that already holds the exact definition is accepted, and a repeated application changes nothing", () => {
    const exact = exactDefinition();
    const path = releasedV46("acp-v47-s2-exact-");
    const raw = new Database(path);
    try {
      raw.exec(exact);
    } finally {
      raw.close();
    }
    approveMigration(path, "v47 exact pre-existing definition");
    new Db(path).close();
    const before = contentDigests(path);
    const repeat = new Database(path);
    try {
      MIGRATIONS.find((migration) => migration.toVersion === 47)!.apply(repeat);
    } finally {
      repeat.close();
    }
    expect(contentDigests(path)).toEqual(before);
  });

  const weakened = (as: string, timing: string, on: string): string =>
    `CREATE TRIGGER ${as} ${timing} ON ${on} WHEN 0 BEGIN SELECT RAISE(ABORT, 'OWNER_DECISION_WRITE_AUTHORITY_DENIED'); END;`;
  const VARIANTS: ReadonlyArray<{ name: string; ddl: (exact: string) => string }> = [
    { name: "weakened body", ddl: () => weakened(GUARD, "BEFORE INSERT", "run_artifacts") },
    { name: "the exact body after INSERT (another trigger type)", ddl: (exact) => exact.replace("BEFORE INSERT ON run_artifacts", "AFTER INSERT ON run_artifacts") },
    { name: "the exact body before UPDATE (another event)", ddl: (exact) => exact.replace("BEFORE INSERT ON run_artifacts", "BEFORE UPDATE ON run_artifacts") },
    { name: "wrong table", ddl: () => weakened(GUARD, "BEFORE INSERT", "projects") },
    { name: "index", ddl: () => `CREATE INDEX ${GUARD} ON run_artifacts(artifact_id)` },
    { name: "view", ddl: () => `CREATE VIEW ${GUARD} AS SELECT 1` },
    { name: "table", ddl: () => `CREATE TABLE ${GUARD} (x)` },
    { name: "upper-case name", ddl: () => weakened(GUARD.toUpperCase(), "BEFORE INSERT", "run_artifacts") },
    { name: "upper-case name with the exact body", ddl: (exact) => exact.replace(GUARD, GUARD.toUpperCase()) },
    { name: "exact name with `<> 1`", ddl: (exact) => exact.replace("IS NOT 1", "<> 1") },
  ];

  it.each(VARIANTS)("refuses a $name and restores the contaminated v46 image, with no v47 receipt", ({ ddl }) => {
    const exact = exactDefinition();
    const path = releasedV46("acp-v47-s2-contaminated-");
    const raw = new Database(path);
    try {
      raw.exec(ddl(exact));
    } finally {
      raw.close();
    }
    const contaminated = contentDigests(path);
    approveMigration(path, "v47 contamination witness");
    let refusal: unknown;
    try {
      new Db(path).close();
    } catch (error) {
      refusal = error;
    }
    expect(String(refusal)).toMatch(/original database was restored/);
    expect(String((refusal as { evidence?: { migrationError?: unknown } } | undefined)?.evidence?.migrationError))
      .toMatch(new RegExp(`^v47 refuses: ${GUARD} is held by the`));
    expect(contentDigests(path)).toEqual(contaminated);
    const probe = new Database(path, { readonly: true });
    try {
      expect(probe.prepare("SELECT COUNT(*) FROM schema_migrations WHERE version = 47").pluck().get()).toBe(0);
    } finally {
      probe.close();
    }
  });
});

describe("S3: rollback through the restore drill", () => {
  it("a fault injected after v47 commits restores the v46 image, and a fresh approval then migrates it", () => {
    const path = releasedV46("acp-v47-s3-fault-");
    seedAsV46(path);
    const before = contentDigests(path);
    approveMigration(path, "v47 fault witness");
    expect(() => new Db(path, {
      afterMigration: (migration) => {
        if (migration.toVersion === 47) throw new Error("injected after v47 commits");
      },
    })).toThrowError(/original database was restored/);
    expect(contentDigests(path)).toEqual(before);
    expect(triggersOf(path)).not.toContain(GUARD);
    approveMigration(path, "v47 fault witness, again");
    new Db(path).close();
    expect(contentDigests(path).userVersion).toBe(SCHEMA_VERSION);
    expect(existsSync(migrationApprovalPath(path))).toBe(false);
  });

  it("the pre-migration backup v47 recorded restores the v46 image through the operator restore", () => {
    const path = releasedV46("acp-v47-s3-restore-");
    seedAsV46(path);
    const before = contentDigests(path);
    approveMigration(path, "v47 restore witness");
    new Db(path).close();
    const raw = new Database(path, { readonly: true });
    let backupFile: string;
    try {
      backupFile = raw.prepare("SELECT backup_file FROM schema_migrations WHERE version = 47").pluck().get() as string;
    } finally {
      raw.close();
    }
    expect(backupFile).toBeTruthy();
    restoreDatabase(path, backupFile);
    expect(contentDigests(path)).toEqual(before);
    expect(triggersOf(path)).not.toContain(GUARD);
  });
});

/**
 * FIX-SEC-R2 (CEO 85eac6ef, option B), widened by FIX-SEC-R3 (CEO 80492af7). The review's counterexample: a
 * never-admitted approval written with the canonical label by an ordinary v46 write survived the upgrade and
 * overrode the owner's refusal; at cbb4bfaf, OWNER_DECISION content under an upper-case label upgraded too.
 * The guard cannot authenticate a row already stored, so its first install refuses while any APPROVAL claims
 * an owner decision: the canonical label once normalized, or OWNER_DECISION content under a label other than
 * exactly "service". The migrator's read-only preflight refuses before it backs anything up, so the file is
 * byte for byte what it was (R3-01). Literal strings only, so this file loads at the build before the fix.
 */
const PRE_GUARD_REFUSAL = /^v47 refuses: OWNER_DECISION_LABEL_PREDATES_GUARD — run_artifacts holds (\d+) APPROVAL row\(s\) that claim an owner decision from before the owner-decision guard existed \(/;

const bytesOf = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Approves and opens `path`; returns the refusal's message, or undefined when it migrated. A refusal must
 * be the preflight's: typed with its own code, and every byte of the file, taken before the approval, the
 * same after it.
 */
const upgradeRefusal = (path: string, why: string, code = "OWNER_DECISION_LABEL_PREDATES_GUARD"): string | undefined => {
  const bytes = bytesOf(path);
  approveMigration(path, why);
  try {
    new Db(path).close();
    return undefined;
  } catch (error) {
    expect(error).toMatchObject({ reasonCode: code });
    expect(bytesOf(path)).toBe(bytes);
    return (error as Error).message;
  }
};

const receiptAt = (path: string, version: number): unknown => {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.prepare("SELECT migration_id, checksum FROM schema_migrations WHERE version = ?").get(version);
  } finally {
    raw.close();
  }
};

const storedAs = (path: string, rows: readonly Row[]): unknown[] => {
  const raw = new Database(path, { readonly: true });
  try {
    return rows.map((r) => raw.prepare("SELECT kind, produced_by, content_json, superseded FROM run_artifacts WHERE artifact_id = ?").get(r.id));
  } finally {
    raw.close();
  }
};

describe("S4: an owner decision already claimed when the guard is first installed refuses v47, before anything is written (FIX-SEC-R2 option B, FIX-SEC-R3)", () => {
  it("SECR2 the review's counterexample, an ordinary v46 write of the label, refuses the step: the cause and the row are named, no guard, no receipt, the v46 image unchanged byte for byte", () => {
    const path = releasedV46("acp-v47-s4-forged-");
    const { legacy } = seedAsV46(path);
    const forged = writeAtV46(path, row("APPROVAL", { ...decision("item b", true), receipt: { actor: "not-the-owner", inboundNonce: "never-admitted" } }, LABEL));
    const before = contentDigests(path);
    const receipts = receiptsThrough46(path);
    const triggers = triggersOf(path);

    const refusal = upgradeRefusal(path, "v47 S4 forged label");
    expect(refusal).toMatch(PRE_GUARD_REFUSAL);
    expect(refusal).toContain(`holds 1 APPROVAL row(s)`);
    expect(refusal).toContain(JSON.stringify(forged.id));
    for (const r of legacy) expect(refusal).not.toContain(r.id);
    expect(refusal).toMatch(/no row was deleted, relabelled or promoted$/);

    expect(contentDigests(path)).toEqual(before);
    expect(before.userVersion).toBe(46);
    expect(receiptsThrough46(path)).toEqual(receipts);
    expect(receiptAt(path, 47)).toBeUndefined();
    expect(triggersOf(path)).toEqual(triggers);
    expect(triggersOf(path)).not.toContain(GUARD);
    expect(storedAs(path, [forged, ...legacy])).toEqual([forged, ...legacy].map((r) => ({
      kind: r.kind, produced_by: r.producedBy, content_json: r.content, superseded: 0,
    })));
  });

  const WRITTEN: ReadonlyArray<{ name: string; write: (path: string) => Row }> = [
    { name: "under the marker (a candidate build's capability write)", write: (path) => writeAtV46(path, row("APPROVAL", decision("item a", true), LABEL), () => 1) },
    { name: "on content that is not a decision", write: (path) => writeAtV46(path, row("APPROVAL", { kind: "NOT_A_DECISION" }, LABEL)) },
    { name: "as a refusal", write: (path) => writeAtV46(path, row("APPROVAL", decision("item a", false), LABEL)) },
    // FIX-SEC-R3 (R3-02): the review's shape forgery, and the label in other forms.
    { name: "in upper case on a decision (the review's shape forgery)", write: (path) => writeAtV46(path, row("APPROVAL", decision("item a", false), LABEL.toUpperCase())) },
    { name: "in upper case on content that is not a decision", write: (path) => writeAtV46(path, row("APPROVAL", { kind: "NOT_A_DECISION" }, LABEL.toUpperCase())) },
    { name: "with a trailing space", write: (path) => writeAtV46(path, row("APPROVAL", { kind: "NOT_A_DECISION" }, `${LABEL} `)) },
    { name: "in full width", write: (path) => writeAtV46(path, row("APPROVAL", { kind: "NOT_A_DECISION" }, "ｐｒｏｄｕｃｔｉｏｎ－ｇａｔｅ：ｏｗｎｅｒ－ｄｅｃｉｓｉｏｎ")) },
    { name: "as OWNER_DECISION content under \"Service\"", write: (path) => writeAtV46(path, row("APPROVAL", decision("item a", false), "Service")) },
    { name: "as OWNER_DECISION content under \"service \"", write: (path) => writeAtV46(path, row("APPROVAL", decision("item a", true), "service ")) },
    { name: "as OWNER_DECISION content under another component's label", write: (path) => writeAtV46(path, row("APPROVAL", decision("item a", false), "ceo")) },
    { name: "as OWNER_DECISION content under an empty label", write: (path) => writeAtV46(path, row("APPROVAL", decision("item a", true), "")) },
    {
      name: "as a duplicate key the reader's JSON.parse does not read but the guards do",
      write: (path) => writeAtV46(path, row("APPROVAL", `{"kind":"OWNER_DECISION","kind":"NOT_A_DECISION","item":"item a","approved":false}`, "ceo")),
    },
    {
      name: "as OWNER_DECISION content nested deeper than SQLite's JSON reads, which only the reader's JSON.parse sees",
      write: (path) => writeAtV46(path, row("APPROVAL", `{"kind":"OWNER_DECISION","item":"item a","approved":false,"deep":${"[".repeat(1100)}${"]".repeat(1100)}}`, "ceo")),
    },
  ];

  it.each(WRITTEN)("SECR2/R3 the claim written $name refuses the step as well, and the image is unchanged byte for byte", ({ write }) => {
    const path = releasedV46("acp-v47-s4-written-");
    seedAsV46(path);
    const labelled = write(path);
    const before = contentDigests(path);
    const refusal = upgradeRefusal(path, "v47 S4 claim variants");
    expect(refusal).toMatch(PRE_GUARD_REFUSAL);
    expect(refusal).toContain(`holds 1 APPROVAL row(s)`);
    expect(refusal).toContain(JSON.stringify(labelled.id));
    expect(contentDigests(path)).toEqual(before);
    expect(receiptAt(path, 47)).toBeUndefined();
  });

  it("SECR2 the check does not depend on the trigger: a v46 image that already holds the exact guard and a stored label refuses all the same", () => {
    const fresh = privateStatePath("acp-v47-s4-exact-def-");
    new Db(fresh).close();
    const exact = schemaRowsOf(fresh).find((r) => r.name === GUARD)!.sql!;
    const path = releasedV46("acp-v47-s4-exact-");
    seedAsV46(path);
    const forged = writeAtV46(path, row("APPROVAL", decision("item a", true), LABEL));
    const raw = new Database(path);
    try {
      raw.exec(exact);
    } finally {
      raw.close();
    }
    const before = contentDigests(path);
    const refusal = upgradeRefusal(path, "v47 S4 guard already present");
    expect(refusal).toMatch(PRE_GUARD_REFUSAL);
    expect(refusal).toContain(JSON.stringify(forged.id));
    expect(contentDigests(path)).toEqual(before);
    expect(receiptAt(path, 47)).toBeUndefined();
  });

  it("SECR2 the refusal names at most five rows in rowid order, each id cut to 64 characters and escaped, and counts the rest", () => {
    const path = releasedV46("acp-v47-s4-many-");
    seedAsV46(path);
    const long = `art_${"x".repeat(196)}`;
    const spoof = 'art_"spoof\nRESULT: PASS';
    const ids = [long, spoof, "art_s4_3", "art_s4_4", "art_s4_5", "art_s4_6", "art_s4_7"];
    for (const id of ids) writeAtV46(path, { ...row("APPROVAL", decision(`item ${id.slice(0, 12)}`, true), LABEL), id });
    const refusal = upgradeRefusal(path, "v47 S4 many labels")!;
    expect(refusal).toMatch(PRE_GUARD_REFUSAL);
    expect(refusal).toContain(`holds 7 APPROVAL row(s)`);
    expect(refusal).toContain(`: ${JSON.stringify(`${long.slice(0, 64)}…`)}, ${JSON.stringify(spoof)}, "art_s4_3", "art_s4_4", "art_s4_5" (+2 more);`);
    expect(refusal).not.toContain(long);
    expect(refusal).not.toContain("art_s4_6");
    expect(refusal.includes("\n")).toBe(false);
    expect(receiptAt(path, 47)).toBeUndefined();
  });

  it("R3 legacy history never refuses: OWNER_DECISION approvals and refusals labelled exactly \"service\", the label on a HANDOFF, and an APPROVAL that is not JSON; no row is excepted by id", () => {
    const path = releasedV46("acp-v47-s4-legacy-");
    const { legacy } = seedAsV46(path);
    const unread = [
      writeAtV46(path, row("HANDOFF", decision("item a", true), LABEL)),
      writeAtV46(path, row("APPROVAL", decision("item c", true), "service")),
      writeAtV46(path, row("APPROVAL", "not json", "ceo")),
      writeAtV46(path, row("APPROVAL", { kind: "CTO_APPROVAL", inner: { kind: "OWNER_DECISION" } }, "ceo")),
    ];
    const before = contentDigests(path);
    expect(upgradeRefusal(path, "v47 S4 legacy history")).toBeUndefined();
    const after = contentDigests(path, before.userVersion);
    expect(after.userVersion).toBe(SCHEMA_VERSION);
    const { schema_migrations: _receiptsBefore, ...restBefore } = before.tables;
    const { schema_migrations: _receiptsAfter, ...restAfter } = after.tables;
    expect(Object.fromEntries(Object.keys(restBefore).map((name) => [name, restAfter[name]]))).toEqual(restBefore);
    expect(triggersOf(path)).toContain(GUARD);
    expect(receiptAt(path, 47)).toEqual({ migration_id: "v47-owner-decision-authority-guard", checksum: V47_BASE_CHECKSUM });
    expect(storedAs(path, [...legacy, ...unread])).toEqual([...legacy, ...unread].map((r) => ({
      kind: r.kind, produced_by: r.producedBy, content_json: r.content, superseded: 0,
    })));
  });

  it("SECR2 a label stored at v45 refuses before v46 runs: the v45 image unchanged byte for byte, no v46 or v47 receipt", () => {
    const path = releasedChainImage(privateStatePath("acp-v47-s4-v45-"), 45);
    expect(laterObjectsIn(path, 45)).toEqual([]);
    seedAsV46(path);
    const forged = writeAtV46(path, row("APPROVAL", decision("item a", true), LABEL));
    const before = contentDigests(path);
    expect(before.userVersion).toBe(45);
    const refusal = upgradeRefusal(path, "v47 S4 from v45");
    expect(refusal).toMatch(PRE_GUARD_REFUSAL);
    expect(refusal).toContain(JSON.stringify(forged.id));
    expect(contentDigests(path)).toEqual(before);
    expect(receiptAt(path, 46)).toBeUndefined();
    expect(receiptAt(path, 47)).toBeUndefined();
  });

  it("SECR2 once the guard is installed the check is never repeated: canonical decisions written under it upgrade to v48 and reopen, every row unchanged", () => {
    const path = releasedChainImage(privateStatePath("acp-v47-s4-after-"), 47);
    expect(laterObjectsIn(path, 47)).toEqual([]);
    expect(receiptAt(path, 47)).toEqual({ migration_id: "v47-owner-decision-authority-guard", checksum: V47_BASE_CHECKSUM });
    const capability = foreign(path, () => 1);
    let canonical: Row[];
    try {
      seedRun(capability);
      canonical = [row("APPROVAL", decision("item a", true), LABEL), row("APPROVAL", decision("item b", false), LABEL)];
      for (const r of canonical) expect(tryInsert(capability, r)).toBe("ADMITTED");
    } finally {
      capability.close();
    }
    const before = contentDigests(path);
    expect(upgradeRefusal(path, "v47 S4 v48 after the guard")).toBeUndefined();
    const upgraded = contentDigests(path, before.userVersion);
    expect(upgraded.userVersion).toBe(SCHEMA_VERSION);
    const { schema_migrations: _receiptsBefore, ...restBefore } = before.tables;
    const { schema_migrations: _receiptsAfter, ...restAfter } = upgraded.tables;
    expect(Object.fromEntries(Object.keys(restBefore).map((name) => [name, restAfter[name]]))).toEqual(restBefore);
    new Db(path).close();
    expect(contentDigests(path, before.userVersion)).toEqual(upgraded);
    expect(receiptAt(path, 47)).toEqual({ migration_id: "v47-owner-decision-authority-guard", checksum: V47_BASE_CHECKSUM });
    expect(storedAs(path, canonical)).toEqual(canonical.map((r) => ({
      kind: r.kind, produced_by: r.producedBy, content_json: r.content, superseded: 0,
    })));
  });

  it("R3 the second line: inside v47's own transaction the step refuses the same claim, so a row written after the preflight is still refused (no guard, no receipt)", () => {
    const path = releasedV46("acp-v47-s4-second-");
    seedAsV46(path);
    const forged = writeAtV46(path, row("APPROVAL", decision("item a", true), LABEL.toUpperCase()));
    const raw = foreign(path, () => 0);
    raw.function("acp_schema_migration_authorized", () => 1);
    let refusal: unknown;
    try {
      raw.exec("BEGIN IMMEDIATE");
      try {
        MIGRATIONS.find((step) => step.toVersion === 47)!.apply(raw);
      } catch (error) {
        refusal = error;
      }
      raw.exec("ROLLBACK");
    } finally {
      raw.close();
    }
    expect(refusal).toMatchObject({ reasonCode: "OWNER_DECISION_LABEL_PREDATES_GUARD" });
    expect(String((refusal as Error).message)).toContain(JSON.stringify(forged.id));
    expect(triggersOf(path)).not.toContain(GUARD);
    expect(receiptAt(path, 47)).toBeUndefined();
  });
});

/**
 * FIX-SEC-R3 (R1-01). The review took a released v46 image to v47 with the candidate step from ccc4865f and
 * its genuine receipt (sha256:f9b23700…), then upgraded: the receipt passed the format check, and the
 * never-admitted approvals it carried published and merged once. A stored receipt from v47 on is now
 * compared with this build's step by value, read-only, before anything is written; v45 and v46 receipts
 * are not compared, so they behave as before.
 */
describe("S5: a v47 receipt another step wrote is refused at an upgrade and at an open, before anything is written (FIX-SEC-R3)", () => {
  const CANDIDATES = [
    { name: "the candidate v47 (faa829ec–ccc4865f, no pre-install check)", checksum: V47_CANDIDATE_CHECKSUM, by: /faa829ec–ccc4865f/ },
    { name: "the candidate v47 (cbb4bfaf, the exact label only)", checksum: V47_R2_CANDIDATE_CHECKSUM, by: /cbb4bfaf/ },
    { name: "a value no build wrote", checksum: `sha256:${"0".repeat(64)}`, by: null },
  ];

  it.each(CANDIDATES)("an upgrade of a database $name took to v47 refuses, the forgery in it never read: the image, its receipts and its version unchanged", ({ checksum, by }) => {
    const path = releasedV46("acp-v47-s5-upgrade-");
    seedAsV46(path);
    writeAtV46(path, row("APPROVAL", { ...decision("item b", true), receipt: { actor: "not-the-owner", inboundNonce: "never-admitted" } }, LABEL));
    asCandidateV47(path, checksum, NOW);
    const before = contentDigests(path);
    expect(before.userVersion).toBe(47);
    const refusal = upgradeRefusal(path, "v47 S5 candidate receipt", "MIGRATION_RECEIPT_MISMATCH");
    expect(refusal).toMatch(/^this build refuses a database whose migration receipt another step wrote: v47 "v47-owner-decision-authority-guard" holds /);
    if (by !== null) expect(refusal).toMatch(by);
    expect(refusal).toMatch(/nothing was changed and the receipt is not rewritten$/);
    expect(contentDigests(path)).toEqual(before);
    expect(receiptAt(path, 47)).toEqual({ migration_id: "v47-owner-decision-authority-guard", checksum });
    expect(receiptAt(path, 48)).toBeUndefined();
  });

  it("a database a candidate took to v47 and then to v48 is refused at an open, read-only", () => {
    const path = releasedV46("acp-v47-s5-open-");
    seedAsV46(path);
    asCandidateV47(path, V47_CANDIDATE_CHECKSUM, NOW);
    // Every later step, v48 and #512 S-PUSH's v49, so the database is at this build's version and the
    // open takes the same-version path that checks receipts.
    const later = MIGRATIONS.filter((step) => step.toVersion > 47);
    const raw = foreign(path, () => 0);
    try {
      raw.function("acp_schema_migration_authorized", () => 1);
      raw.exec("BEGIN IMMEDIATE");
      for (const step of later) {
        step.apply(raw);
        raw.prepare("INSERT INTO schema_migrations (version, migration_id, checksum, applied_at) VALUES (?, ?, ?, ?)").run(step.toVersion, step.id, step.checksum(), NOW);
        raw.pragma(`user_version = ${step.toVersion}`);
      }
      raw.exec("COMMIT");
    } finally {
      raw.close();
    }
    const bytes = bytesOf(path);
    let refusal: unknown;
    try {
      new Db(path).close();
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({
      reasonCode: "MIGRATION_RECEIPT_MISMATCH",
      evidence: { mismatches: [{ version: 47, migrationId: "v47-owner-decision-authority-guard", stored: V47_CANDIDATE_CHECKSUM, expected: V47_BASE_CHECKSUM }] },
    });
    expect(bytesOf(path)).toBe(bytes);
  });

  it("this build's own v47 receipt upgrades and reopens; released v45 and v46 receipts are not compared by value, so any well-formed one behaves exactly as before", () => {
    const path = releasedV46("acp-v47-s5-released-");
    seedAsV46(path);
    expect(receiptsThrough46(path).map((r) => (r as { version: number; checksum: string })).filter((r) => r.version >= 45).map((r) => r.checksum))
      .toEqual([V45_BASE_CHECKSUM, V46_BASE_CHECKSUM]);
    // A different well-formed v46 value: the format check is the only one before v47, as at cbb4bfaf.
    const other = releasedV46("acp-v47-s5-other46-");
    seedAsV46(other);
    const raw = new Database(other);
    try {
      raw.function("acp_schema_migration_authorized", () => 1);
      const triggers = raw.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'schema_migrations'").all() as Array<{ name: string; sql: string }>;
      raw.exec("BEGIN IMMEDIATE");
      for (const trigger of triggers) raw.exec(`DROP TRIGGER "${trigger.name}"`);
      raw.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 46").run(`sha256:${"4".repeat(64)}`);
      for (const trigger of triggers) raw.exec(trigger.sql);
      raw.exec("COMMIT");
    } finally {
      raw.close();
    }
    for (const image of [path, other]) {
      const receipts = receiptsThrough46(image);
      expect(upgradeRefusal(image, "v47 S5 released receipts")).toBeUndefined();
      expect(receiptsThrough46(image)).toEqual(receipts);
      expect(receiptAt(image, 47)).toEqual({ migration_id: "v47-owner-decision-authority-guard", checksum: V47_BASE_CHECKSUM });
      const upgraded = contentDigests(image);
      new Db(image).close();
      expect(contentDigests(image)).toEqual(upgraded);
    }
  });
});

/**
 * FIX-SEC-R3 (CEO 80492af7): one standard. The refusal reuses the reader's shape test and the guards' shape
 * clause rather than a third copy. The guards are SQL in frozen snapshots and cannot call a function, so
 * their clause is compared here with the shared one, token for token.
 */
describe("S6: the refusal, the reader and the guards test an owner decision the same way (FIX-SEC-R3)", () => {
  const squash = (sql: string): string => sql.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();

  it("the v47 insert guard and the v48 supersede guard carry the shared shape clause over NEW and OLD", () => {
    const fresh = privateStatePath("acp-v47-s6-");
    new Db(fresh).close();
    const bodies = Object.fromEntries(schemaRowsOf(fresh).filter((r) => r.type === "trigger").map((r) => [r.name, squash(r.sql ?? "")]));
    expect(bodies[GUARD]).toContain(squash(ownerDecisionShapeSql("NEW.content_json")));
    expect(bodies["run_artifacts_owner_decision_supersede_guard"]).toContain(squash(ownerDecisionShapeSql("OLD.content_json")));
    const snapshot = squash(readFileSync(new URL("../../src/db/schema-v47.sql", import.meta.url), "utf8"));
    expect(snapshot).toContain(squash(ownerDecisionShapeSql("NEW.content_json")));
  });

  it("a claim is the label once normalized, or either shape test under any label but exactly \"service\"", () => {
    const shaped = JSON.stringify(decision("item a", false));
    const claims = (producedBy: unknown, contentJson: unknown, guardShaped: unknown = 0): boolean =>
      claimsUnvettedOwnerDecision({ producedBy, contentJson, guardShaped });
    expect(isOwnerDecisionContent(JSON.parse(shaped))).toBe(true);
    for (const content of [null, [], "OWNER_DECISION", { kind: "CTO_APPROVAL" }]) expect(isOwnerDecisionContent(content)).toBe(false);
    expect(normalizedProducerLabel(" ＰＲＯＤＵＣＴＩＯＮ-gate:Owner-Decision\t")).toBe(LABEL);
    expect(claims(LABEL, "{}")).toBe(true);
    expect(claims(LABEL.toUpperCase(), "not json")).toBe(true);
    expect(claims("service", shaped, 1)).toBe(false);
    expect(claims("Service", shaped)).toBe(true);
    expect(claims("ceo", "{}", 1)).toBe(true);
    expect(claims("ceo", "{}", 0)).toBe(false);
    expect(claims(Buffer.from("service"), shaped)).toBe(true);
  });
});
