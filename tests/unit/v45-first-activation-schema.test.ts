import Database from "better-sqlite3";
import { copyFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { digestOf } from "../../src/core/digest.ts";
import { manifestDigest } from "../../src/contracts/manifest.ts";
import { Db } from "../../src/db/database.ts";
import { approveMigration, migrationApprovalPath } from "../../src/db/migration-approval.ts";
import { MIGRATIONS, SCHEMA_VERSION } from "../../src/db/migrations.ts";
import { Role, RunKind, roleKeyFor } from "../../src/domain/types.ts";
import { contractChangeRunsWithoutGrant } from "../../src/registry/manifest-activation-grants.ts";
import { boundedSpawnSync } from "../helpers/bounded-sync-child.ts";
import { cleanupTempDirs, makeRepo, tempDir } from "../helpers/fixtures.ts";
import {
  createRun,
  firstManifest,
  operatorRegisteredProject,
  rawFirstActivation,
  revisionsFor,
} from "../helpers/first-activation.ts";
import { fixtureManifest, makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";
import {
  V44_SCHEMA_DIGEST_FROM_V43,
  digestOfSchemaRows,
  privateStatePath,
  schemaRowsOf,
  v43Image,
} from "../helpers/released-v44-schema.ts";
import {
  V45_REPLACED_TRIGGERS,
  contentDigests,
  freshV45CreateFromSnapshot,
  toV44Image,
  v44TriggerBody,
} from "../helpers/released-v45-schema.ts";
import { stricter, dispatchRun } from "../helpers/contract-change.ts";
import { carryContractChange, decideThroughHermes } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #512 (v45) — the schema half: the first-activation grant table and its guards (A2–A5 and D1-a at the
 * raw-SQL level), a mutation check for each predicate those guards rest on, and the v44 → v45 step
 * itself (M1 preservation, M3 fresh = migrated, D4-a/D4-b restore, D5-a process kill).
 *
 * Raw SQL here is the attack or the precondition, never the path under test: a refusal is the
 * expectation, or, for a precondition, every guard still applies to the write.
 *
 * RED at A0's head: SCHEMA_VERSION is 44, there is no manifest_first_activation_grants table, and the
 * v44 pointer guard refuses every move from NULL.
 */

interface Seed {
  h: Harness;
  projectId: string;
  registrationEventId: number;
  /** A NULL-pinned CONTRACT_CHANGE run of the NULL project. */
  runId: string;
  m1: ReturnType<typeof firstManifest>;
}

/** Another project of the same harness, on its own checkout: NULL (operator) or registered with a manifest. */
const anotherProject = async (h: Harness, projectId: string, withManifest: boolean) => {
  const identity = `github:acme/${projectId}`;
  if (!withManifest) return operatorRegisteredProject(h, projectId, { identity, checkoutPath: makeRepo() });
  const manifest = { ...fixtureManifest(projectId), repositories: [{ role: "primary", remote: identity, manifestRoot: "." }] };
  const project = h.cp.projects.register({ projectId, name: "with a manifest", manifest, authorization: h.cp.manifestAuthorizationForTests(manifest) });
  if (!project.allowed) throw new Error(project.message);
  const repository = await h.cp.repositories.register({ checkoutPath: makeRepo(), projectId, repositoryRole: "primary", identity });
  if (!repository.allowed) throw new Error(repository.message);
  const registration = h.cp.db.get<{ event_id: number }>(`SELECT event_id FROM audit_events WHERE kind = 'PROJECT_REGISTERED' AND project_id = ?`, [projectId])!;
  return { projectId, repositoryId: repository.value.repositoryId, identity, registrationEventId: registration.event_id };
};

const seed = async (projectId: string): Promise<Seed> => {
  const h = makeHarness();
  const project = await operatorRegisteredProject(h, projectId);
  const run = await createRun(h, projectId, RunKind.CONTRACT_CHANGE);
  return { h, projectId, registrationEventId: project.registrationEventId, runId: run.runId, m1: firstManifest(projectId) };
};

/** A raw INSERT of a first grant, every column valid for `seed` unless overridden. */
const insertFirst = (s: Seed, overrides: Record<string, unknown> = {}, verb = "INSERT"): void => {
  const ceo = s.h.cp.bindings.active(roleKeyFor(Role.CEO))!;
  const revisions = revisionsFor(s.m1, "a".repeat(40));
  const row: Record<string, unknown> = {
    grant_id: `mfa_${digestOf({ overrides, runId: s.runId }).slice(7, 31)}`,
    run_id: s.runId,
    project_id: s.projectId,
    run_kind: "CONTRACT_CHANGE",
    registration_event_id: s.registrationEventId,
    manifest_digest: manifestDigest(s.m1),
    plan_digest: "sha256:plan",
    candidate_snapshot_digest: "sha256:candidate",
    packet_digest: "sha256:packet",
    review_digest: "sha256:review",
    workflow_revisions_json: JSON.stringify(revisions),
    workflow_revisions_digest: digestOf({ revisions }),
    ceo_assignment_id: ceo.assignmentId,
    ceo_actor_id: "actor",
    ceo_session_id: ceo.sessionId,
    ceo_session_incarnation: ceo.sessionIncarnation,
    ceo_binding_generation: ceo.bindingGeneration,
    issued_at: s.h.cp.clock.nowIso(),
    grant_digest: digestOf({ grant: overrides, runId: s.runId }),
    consumer_session_id: ceo.sessionId,
    consumer_session_incarnation: ceo.sessionIncarnation,
    consumer_bound_at: s.h.cp.clock.nowIso(),
    ...overrides,
  };
  const columns = Object.keys(row);
  s.h.cp.db.run(
    `${verb} INTO manifest_first_activation_grants (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    columns.map((column) => row[column]),
  );
};

const storeManifest = (s: Seed, manifest = s.m1): string => {
  const digest = manifestDigest(manifest);
  if (!s.h.cp.db.get(`SELECT 1 FROM manifests WHERE digest = ?`, [digest])) {
    s.h.cp.db.run(`INSERT INTO manifests (digest, schema_id, content_json, created_at) VALUES (?, ?, ?, ?)`, [
      digest, manifest.schema, JSON.stringify(manifest), s.h.cp.clock.nowIso(),
    ]);
  }
  return digest;
};

const consume = (s: Seed, runId = s.runId): void => {
  s.h.cp.db.run(`UPDATE manifest_first_activation_grants SET consumed_at = ?, consumed_attempt_id = 'attempt' WHERE run_id = ?`, [
    s.h.cp.clock.nowIso(), runId,
  ]);
};

const movePointer = (s: Seed, digest: string | null, projectId = s.projectId): void => {
  s.h.cp.db.run(`UPDATE projects SET active_manifest_digest = ? WHERE project_id = ?`, [digest, projectId]);
};

describe("v45 schema: a first-activation grant is born only on a NULL project, for its own NULL-pinned CONTRACT_CHANGE and NULL registration (A2, A3)", () => {
  it("a grant naming every fact correctly is born unconsumed; born consumed it is refused", async () => {
    const s = await seed("v45-born");
    expect(() => insertFirst(s, { consumed_at: "2026-10-18T00:00:00.000Z", consumed_attempt_id: "a" })).toThrow(/MANIFEST_GRANT_IMMUTABLE/);
    insertFirst(s);
    expect(s.h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM manifest_first_activation_grants WHERE consumed_at IS NULL`)?.n).toBe(1);
  });

  it("refused when the project is not NULL (A2: a project registered with a manifest is not operator-registered)", async () => {
    const s = await seed("v45-not-null");
    const other = await anotherProject(s.h, "v45-has-manifest", true);
    const queued = await createRun(s.h, other.projectId, RunKind.CONTRACT_CHANGE, { dispatch: false });
    expect(queued.pinnedManifestDigest).toBeNull();
    expect(() => insertFirst(s, { project_id: other.projectId, run_id: queued.runId, registration_event_id: other.registrationEventId }))
      .toThrow(/MANIFEST_FIRST_ACTIVATION_DENIED/);
  });

  it("refused for a run that is not the project's NULL-pinned CONTRACT_CHANGE", async () => {
    const s = await seed("v45-run");
    const ordinary = await createRun(s.h, s.projectId, RunKind.STANDARD_WORK);
    expect(() => insertFirst(s, { run_id: ordinary.runId })).toThrow(/MANIFEST_FIRST_ACTIVATION_DENIED/);
    const other = await anotherProject(s.h, "v45-run-other", false);
    const foreign = await createRun(s.h, other.projectId, RunKind.CONTRACT_CHANGE);
    expect(() => insertFirst(s, { run_id: foreign.runId })).toThrow(/MANIFEST_FIRST_ACTIVATION_DENIED/);
  });

  it("refused unless it names this project's PROJECT_REGISTERED row with a JSON-null manifest (A3: another project's registration)", async () => {
    const s = await seed("v45-registration");
    const other = await anotherProject(s.h, "v45-registration-other", false);
    expect(() => insertFirst(s, { registration_event_id: other.registrationEventId })).toThrow(/MANIFEST_FIRST_ACTIVATION_DENIED/);
    const withManifest = await anotherProject(s.h, "v45-registration-manifest", true);
    expect(() => insertFirst(s, { registration_event_id: withManifest.registrationEventId })).toThrow(/MANIFEST_FIRST_ACTIVATION_DENIED/);
    const notARegistration = s.h.cp.db.get<{ event_id: number }>(`SELECT event_id FROM audit_events WHERE kind <> 'PROJECT_REGISTERED' ORDER BY event_id DESC LIMIT 1`)!;
    expect(() => insertFirst(s, { registration_event_id: notARegistration.event_id })).toThrow(/MANIFEST_FIRST_ACTIVATION_DENIED/);
  });

  it("D1-a raw: workflow_revisions_json '[]', an object or malformed JSON fails the CHECK", async () => {
    const s = await seed("v45-check");
    for (const json of ["[]", "{}", "not json"]) {
      expect(() => insertFirst(s, { workflow_revisions_json: json }), json).toThrow(/CHECK constraint failed|malformed JSON|violates a database constraint/);
    }
  });
});

describe("v45 schema: one grant per run across both tables; fixed once written; consumed once, while NULL; never deleted (A4, A5)", () => {
  it("no second grant for the run, no REPLACE, and no v44 grant for a run holding a first grant, or the reverse", async () => {
    const s = await seed("v45-one");
    insertFirst(s);
    expect(() => insertFirst(s, { grant_id: "mfa_second", grant_digest: "sha256:second" })).toThrow(/MANIFEST_GRANT_NO_REPLACE/);
    expect(() => insertFirst(s, {}, "INSERT OR REPLACE")).toThrow(/MANIFEST_GRANT_NO_REPLACE/);
    const ceo = s.h.cp.bindings.active(roleKeyFor(Role.CEO))!;
    const v44Grant = (runId: string, grantId: string) =>
      s.h.cp.db.run(
        `INSERT INTO manifest_activation_grants
           (grant_id, run_id, project_id, run_kind, manifest_digest, from_manifest_digest, plan_digest,
            candidate_snapshot_digest, packet_digest, ceo_assignment_id, ceo_actor_id, ceo_session_id,
            ceo_session_incarnation, ceo_binding_generation, issued_at, grant_digest,
            consumer_session_id, consumer_session_incarnation, consumer_bound_at)
         VALUES (?, ?, ?, 'CONTRACT_CHANGE', ?, ?, 'p', 'c', 'k', ?, 'a', ?, ?, ?, 't', ?, ?, ?, 't')`,
        [grantId, runId, s.projectId, manifestDigest(s.m1), `sha256:${"b".repeat(64)}`, ceo.assignmentId, ceo.sessionId,
          ceo.sessionIncarnation, ceo.bindingGeneration, `sha256:${grantId}`, ceo.sessionId, ceo.sessionIncarnation],
      );
    expect(() => v44Grant(s.runId, "mag_over_first")).toThrow(/MANIFEST_GRANT_NO_REPLACE/);
    const second = await createRun(s.h, s.projectId, RunKind.CONTRACT_CHANGE);
    v44Grant(second.runId, "mag_first");
    expect(() => insertFirst(s, { run_id: second.runId, grant_id: "mfa_over_v44", grant_digest: "sha256:over" })).toThrow(/MANIFEST_GRANT_NO_REPLACE/);
  });

  it("identity columns are immutable, consumption is once and forward only, and a grant is never deleted", async () => {
    const s = await seed("v45-fixed");
    insertFirst(s);
    for (const [column, value] of [
      ["manifest_digest", `sha256:${"c".repeat(64)}`],
      ["registration_event_id", 999_999],
      ["review_digest", "sha256:other-review"],
      ["workflow_revisions_json", JSON.stringify(revisionsFor(s.m1, "d".repeat(40)))],
      ["workflow_revisions_digest", "sha256:other"],
    ] as const) {
      expect(() => s.h.cp.db.run(`UPDATE manifest_first_activation_grants SET ${column} = ? WHERE run_id = ?`, [value, s.runId]), column)
        .toThrow(/MANIFEST_GRANT_IMMUTABLE/);
    }
    expect(() => s.h.cp.db.run(`DELETE FROM manifest_first_activation_grants WHERE run_id = ?`, [s.runId])).toThrow(/MANIFEST_GRANT_IMMUTABLE/);
    consume(s);
    expect(() => consume(s)).toThrow(/MANIFEST_GRANT_CONSUMED/);
    expect(() => s.h.cp.db.run(`UPDATE manifest_first_activation_grants SET consumed_at = NULL, consumed_attempt_id = NULL WHERE run_id = ?`, [s.runId]))
      .toThrow(/MANIFEST_GRANT_CONSUMED/);
  });

  it("one consumed first grant per project, ever: a second consumption while still NULL fails the unique index", async () => {
    const s = await seed("v45-index");
    insertFirst(s);
    const second = await createRun(s.h, s.projectId, RunKind.CONTRACT_CHANGE);
    insertFirst(s, { run_id: second.runId, grant_id: "mfa_two", grant_digest: "sha256:two" });
    consume(s);
    expect(() => consume(s, second.runId)).toThrow(/UNIQUE constraint failed/);
  });
});

describe("v45 schema: the pointer leaves NULL once, by the project's own consumed first grant naming the target (A3, A4, A5)", () => {
  it("NULL → M1 is refused without a grant, with an unconsumed one, or with another project's; admitted with the project's consumed one", async () => {
    const s = await seed("v45-pointer");
    const m1 = storeManifest(s);
    expect(() => movePointer(s, m1)).toThrow(/MANIFEST_ACTIVATION_AUTHORITY_DENIED/);
    insertFirst(s);
    expect(() => movePointer(s, m1)).toThrow(/MANIFEST_ACTIVATION_AUTHORITY_DENIED/);
    // Another NULL project's consumed grant moves only that project.
    const other = await anotherProject(s.h, "v45-pointer-other", false);
    const otherRun = await createRun(s.h, other.projectId, RunKind.CONTRACT_CHANGE);
    const otherM1 = rawFirstActivation(s.h, { projectId: other.projectId, runId: otherRun.runId, registrationEventId: other.registrationEventId, manifest: firstManifest(other.projectId) });
    expect(s.h.cp.projects.require(other.projectId).activeManifestDigest).toBe(otherM1);
    expect(() => movePointer(s, m1)).toThrow(/MANIFEST_ACTIVATION_AUTHORITY_DENIED/);
    // A consumed grant naming M1 does not move the pointer anywhere else.
    consume(s);
    const m2 = storeManifest(s, firstManifest(s.projectId, undefined, { postMergeCommands: ["verify"] }));
    expect(() => movePointer(s, m2)).toThrow(/MANIFEST_ACTIVATION_AUTHORITY_DENIED/);
    movePointer(s, m1);
    expect(s.h.cp.projects.require(s.projectId).activeManifestDigest).toBe(m1);
  });

  it("after activation: no raw M1 → M2 or M1 → NULL, no new first grant, no consumption of a second one (A4, A5)", async () => {
    const s = await seed("v45-after");
    const second = await createRun(s.h, s.projectId, RunKind.CONTRACT_CHANGE);
    insertFirst(s, { run_id: second.runId, grant_id: "mfa_loser", grant_digest: "sha256:loser" });
    const m1 = rawFirstActivation(s.h, { projectId: s.projectId, runId: s.runId, registrationEventId: s.registrationEventId, manifest: s.m1 });
    const m2 = storeManifest(s, firstManifest(s.projectId, undefined, { postMergeCommands: ["verify"] }));
    expect(() => movePointer(s, m2)).toThrow(/MANIFEST_ACTIVATION_AUTHORITY_DENIED/);
    expect(() => movePointer(s, null)).toThrow(/MANIFEST_ACTIVATION_AUTHORITY_DENIED/);
    // The loser of two grants on one NULL project cannot consume (A5), and no new one is born (A4).
    expect(() => consume(s, second.runId)).toThrow(/MANIFEST_FIRST_ACTIVATION_DENIED/);
    const third = await createRun(s.h, s.projectId, RunKind.CONTRACT_CHANGE, { dispatch: false });
    expect(() => insertFirst(s, { run_id: third.runId, grant_id: "mfa_third", grant_digest: "sha256:third" })).toThrow(/MANIFEST_FIRST_ACTIVATION_DENIED|MANIFEST_GRANT_NO_REPLACE/);
    expect(s.h.cp.projects.require(s.projectId).activeManifestDigest).toBe(m1);
  });
});

describe("mutation checks: each predicate the guards rest on is load-bearing", () => {
  /**
   * Recreates `trigger` on a raw connection with `from` replaced by `to`, proves the body changed, runs
   * `attack` (which the unmutated guard refuses, as asserted above) and returns whether it got through.
   */
  let lastMutantRefusal = "";
  const underMutant = (s: Seed, trigger: string, from: string, to: string, attack: () => void): boolean => {
    lastMutantRefusal = "";
    const path = join(s.h.root, "state.sqlite");
    const raw = new Database(path);
    try {
      const sql = (raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(trigger) as { sql: string }).sql;
      const mutated = sql.replace(from, to);
      expect(mutated, `${trigger}: mutation applied`).not.toBe(sql);
      raw.exec(`DROP TRIGGER ${trigger}`);
      raw.exec(mutated);
    } finally {
      raw.close();
    }
    try {
      attack();
      return true;
    } catch (error) {
      lastMutantRefusal = (error as Error).message;
      return false;
    }
  };

  it("born_on_null: the NULL project, the run's kind and pin, and the registration each refuse alone", async () => {
    {
      const s = await seed("v45-mut-null");
      const withManifest = await anotherProject(s.h, "v45-mut-null-m", true);
      const projectId = withManifest.projectId;
      const queued = await createRun(s.h, projectId, RunKind.CONTRACT_CHANGE, { dispatch: false });
      const registration = { event_id: withManifest.registrationEventId };
      // Without the NULL-project fact, only the registration's JSON-null still refuses; name a NULL registration of the same project id to isolate it.
      s.h.cp.db.run(`INSERT INTO audit_events (at, kind, project_id, evidence_json) VALUES (?, 'PROJECT_REGISTERED', ?, ?)`, [
        s.h.cp.clock.nowIso(), projectId, JSON.stringify({ name: "forged", activeManifestDigest: null }),
      ]);
      const forged = s.h.cp.db.get<{ event_id: number }>(`SELECT MAX(event_id) AS event_id FROM audit_events`)!;
      const attack = () => insertFirst(s, { project_id: projectId, run_id: queued.runId, registration_event_id: forged.event_id });
      expect(attack).toThrow(/MANIFEST_FIRST_ACTIVATION_DENIED/);
      expect(registration.event_id).not.toBe(forged.event_id);
      expect(underMutant(s, "manifest_first_activation_grants_born_on_null", "p.active_manifest_digest IS NULL", "1", attack)).toBe(true);
      expect(lastMutantRefusal).toBe("");
    }
    {
      const s = await seed("v45-mut-kind");
      const ordinary = await createRun(s.h, s.projectId, RunKind.STANDARD_WORK);
      const attack = () => insertFirst(s, { run_id: ordinary.runId });
      expect(attack).toThrow(/MANIFEST_FIRST_ACTIVATION_DENIED/);
      expect(underMutant(s, "manifest_first_activation_grants_born_on_null", "r.kind = 'CONTRACT_CHANGE'", "1", attack)).toBe(true);
      expect(lastMutantRefusal).toBe("");
    }
    {
      const s = await seed("v45-mut-registration");
      const other = await anotherProject(s.h, "v45-mut-registration-o", false);
      const attack = () => insertFirst(s, { registration_event_id: other.registrationEventId });
      expect(attack).toThrow(/MANIFEST_FIRST_ACTIVATION_DENIED/);
      expect(underMutant(s, "manifest_first_activation_grants_born_on_null", "AND e.project_id = NEW.project_id", "", attack)).toBe(true);
      expect(lastMutantRefusal).toBe("");
    }
  });

  it("consumed_while_null and the pointer guard's first-activation clause are each load-bearing", async () => {
    {
      const s = await seed("v45-mut-consume");
      const second = await createRun(s.h, s.projectId, RunKind.CONTRACT_CHANGE);
      insertFirst(s, { run_id: second.runId, grant_id: "mfa_l", grant_digest: "sha256:l" });
      rawFirstActivation(s.h, { projectId: s.projectId, runId: s.runId, registrationEventId: s.registrationEventId, manifest: s.m1 });
      const attack = () => consume(s, second.runId);
      expect(attack).toThrow(/MANIFEST_FIRST_ACTIVATION_DENIED/);
      // Under the mutant the index would still refuse a second consumed grant; drop it so only the guard is measured.
      const raw = new Database(join(s.h.root, "state.sqlite"));
      raw.exec("DROP INDEX manifest_first_activation_grants_one_consumed_per_project");
      raw.close();
      expect(attack).toThrow(/MANIFEST_FIRST_ACTIVATION_DENIED/);
      expect(underMutant(s, "manifest_first_activation_grants_consumed_while_null", "p.active_manifest_digest IS NULL", "1", attack)).toBe(true);
      expect(lastMutantRefusal).toBe("");
    }
    {
      const s = await seed("v45-mut-pointer");
      const m1 = storeManifest(s);
      insertFirst(s);
      const attack = () => movePointer(s, m1);
      expect(attack).toThrow(/MANIFEST_ACTIVATION_AUTHORITY_DENIED/);
      expect(underMutant(s, "projects_active_manifest_moves_by_grant", "AND f.consumed_at IS NOT NULL", "", attack)).toBe(true);
      expect(lastMutantRefusal).toBe("");
    }
    {
      const s = await seed("v45-mut-pointer-project");
      const other = await anotherProject(s.h, "v45-mut-pointer-o", false);
      const otherRun = await createRun(s.h, other.projectId, RunKind.CONTRACT_CHANGE);
      const otherM1 = rawFirstActivation(s.h, { projectId: other.projectId, runId: otherRun.runId, registrationEventId: other.registrationEventId, manifest: firstManifest(other.projectId) });
      const attack = () => movePointer(s, otherM1);
      expect(attack).toThrow(/MANIFEST_ACTIVATION_AUTHORITY_DENIED/);
      expect(underMutant(s, "projects_active_manifest_moves_by_grant", "WHERE f.project_id = NEW.project_id\n     AND", "WHERE", attack)).toBe(true);
      expect(lastMutantRefusal).toBe("");
    }
    {
      // Two consumed first grants (the unique index dropped to allow it): A names M1, B names M2. The
      // pointer leaves NULL by A; only the guard's `OLD IS NULL` keeps B from moving it M1 → M2.
      const s = await seed("v45-mut-from-null");
      const second = await createRun(s.h, s.projectId, RunKind.CONTRACT_CHANGE);
      const m1 = storeManifest(s);
      const m2 = storeManifest(s, firstManifest(s.projectId, undefined, { postMergeCommands: ["verify"] }));
      insertFirst(s);
      insertFirst(s, { run_id: second.runId, grant_id: "mfa_m2", grant_digest: "sha256:m2", manifest_digest: m2 });
      const raw = new Database(join(s.h.root, "state.sqlite"));
      raw.exec("DROP INDEX manifest_first_activation_grants_one_consumed_per_project");
      raw.close();
      consume(s);
      consume(s, second.runId);
      movePointer(s, m1);
      const attack = () => movePointer(s, m2);
      expect(attack).toThrow(/MANIFEST_ACTIVATION_AUTHORITY_DENIED/);
      expect(underMutant(s, "projects_active_manifest_moves_by_grant", "OLD.active_manifest_digest IS NULL AND ", "", attack)).toBe(true);
      expect(lastMutantRefusal).toBe("");
    }
  });

  it("no_replace's v44 clause and not_first are each load-bearing", async () => {
    {
      const s = await seed("v45-mut-noreplace");
      const ceo = s.h.cp.bindings.active(roleKeyFor(Role.CEO))!;
      s.h.cp.db.run(
        `INSERT INTO manifest_activation_grants
           (grant_id, run_id, project_id, run_kind, manifest_digest, from_manifest_digest, plan_digest,
            candidate_snapshot_digest, packet_digest, ceo_assignment_id, ceo_actor_id, ceo_session_id,
            ceo_session_incarnation, ceo_binding_generation, issued_at, grant_digest,
            consumer_session_id, consumer_session_incarnation, consumer_bound_at)
         VALUES ('mag_v44', ?, ?, 'CONTRACT_CHANGE', ?, ?, 'p', 'c', 'k', ?, 'a', ?, ?, ?, 't', 'sha256:v44', ?, ?, 't')`,
        [s.runId, s.projectId, manifestDigest(s.m1), `sha256:${"b".repeat(64)}`, ceo.assignmentId, ceo.sessionId,
          ceo.sessionIncarnation, ceo.bindingGeneration, ceo.sessionId, ceo.sessionIncarnation],
      );
      const attack = () => insertFirst(s);
      expect(attack).toThrow(/MANIFEST_GRANT_NO_REPLACE/);
      expect(underMutant(s, "manifest_first_activation_grants_no_replace", "OR EXISTS (SELECT 1 FROM manifest_activation_grants g WHERE g.run_id = NEW.run_id)", "", attack)).toBe(true);
      expect(lastMutantRefusal).toBe("");
    }
    {
      const s = await seed("v45-mut-notfirst");
      insertFirst(s);
      const ceo = s.h.cp.bindings.active(roleKeyFor(Role.CEO))!;
      const attack = () =>
        s.h.cp.db.run(
          `INSERT INTO manifest_activation_grants
             (grant_id, run_id, project_id, run_kind, manifest_digest, from_manifest_digest, plan_digest,
              candidate_snapshot_digest, packet_digest, ceo_assignment_id, ceo_actor_id, ceo_session_id,
              ceo_session_incarnation, ceo_binding_generation, issued_at, grant_digest,
              consumer_session_id, consumer_session_incarnation, consumer_bound_at)
           VALUES ('mag_v44b', ?, ?, 'CONTRACT_CHANGE', ?, ?, 'p', 'c', 'k', ?, 'a', ?, ?, ?, 't', 'sha256:v44b', ?, ?, 't')`,
          [s.runId, s.projectId, manifestDigest(s.m1), `sha256:${"b".repeat(64)}`, ceo.assignmentId, ceo.sessionId,
            ceo.sessionIncarnation, ceo.bindingGeneration, ceo.sessionId, ceo.sessionIncarnation],
        );
      expect(attack).toThrow(/MANIFEST_GRANT_NO_REPLACE/);
      expect(underMutant(s, "manifest_activation_grants_not_first", "f.run_id = NEW.run_id", "0", attack)).toBe(true);
      expect(lastMutantRefusal).toBe("");
    }
  });
});

describe("the v44 → v45 step", () => {
  it("M3: a fresh v45 install equals a v44 image (and a v43 image) migrated to v45, apart from receipts; the v44 image is the v44 build's", () => {
    // The fresh v45 install from the frozen v45 snapshot, and each image's schema as v45 left it: the
    // chain runs on past v45 when the current version is later. At the chain's end, each equals a fresh
    // install at the current version.
    const freshV45 = digestOfSchemaRows(schemaRowsOf(freshV45CreateFromSnapshot(privateStatePath("acp-v45-fresh-"))));
    const fresh = privateStatePath("acp-v45-fresh-current-");
    new Db(fresh).close();
    const migrateRecordingV45 = (path: string, why: string): string => {
      approveMigration(path, why);
      const atV45: string[] = [];
      new Db(path, {
        afterMigration: (migration) => {
          if (migration.toVersion === 45) atV45.push(digestOfSchemaRows(schemaRowsOf(path)));
        },
      }).close();
      expect(atV45).toHaveLength(1);
      return atV45[0]!;
    };
    const path = privateStatePath("acp-v45-m3-");
    new Db(path).close();
    toV44Image(path);
    expect(digestOfSchemaRows(schemaRowsOf(path))).toBe(V44_SCHEMA_DIGEST_FROM_V43);
    expect(migrateRecordingV45(path, "V45 M3 witness")).toBe(freshV45);
    expect(digestOfSchemaRows(schemaRowsOf(path))).toBe(digestOfSchemaRows(schemaRowsOf(fresh)));

    const fromV43 = v43Image(privateStatePath("acp-v45-m3-v43-"));
    expect(migrateRecordingV45(fromV43, "V45 M3 witness from v43")).toBe(freshV45);
    expect(digestOfSchemaRows(schemaRowsOf(fromV43))).toBe(digestOfSchemaRows(schemaRowsOf(fresh)));
    expect(MIGRATIONS.find((step) => step.id === "v45-first-manifest-activation"))
      .toMatchObject({ fromVersion: 44, toVersion: 45 });
  });

  it("the replaced bodies decide exactly as v44's for every non-NULL old value (A8 pointer outcomes)", async () => {
    const h = makeHarness();
    const { projectId } = await registerFixtureProject(h, "v45-outcomes");
    const m0 = h.cp.projects.require(projectId).activeManifestDigest!;
    const stored = (overrides: object) => {
      const manifest = { ...h.cp.projects.manifest(m0)!, ...overrides };
      const written = h.cp.projects.storeManifest(manifest, h.cp.manifestAuthorizationForTests(manifest));
      if (!written.allowed) throw new Error(written.message);
      return written.value;
    };
    const m1 = stored({ commitlore: { mode: "required" } });
    const m2 = stored({ postMergeCommands: ["verify"] });
    const run = await createRun(h, projectId, RunKind.CONTRACT_CHANGE);
    const ceo = h.cp.bindings.active(roleKeyFor(Role.CEO))!;
    h.cp.db.run(
      `INSERT INTO manifest_activation_grants
         (grant_id, run_id, project_id, run_kind, manifest_digest, from_manifest_digest, plan_digest,
          candidate_snapshot_digest, packet_digest, ceo_assignment_id, ceo_actor_id, ceo_session_id,
          ceo_session_incarnation, ceo_binding_generation, issued_at, grant_digest,
          consumer_session_id, consumer_session_incarnation, consumer_bound_at, consumed_at, consumed_attempt_id)
       VALUES ('mag_o', ?, ?, 'CONTRACT_CHANGE', ?, ?, 'p', 'c', 'k', ?, 'a', ?, ?, ?, 't', 'sha256:o', ?, ?, 't', NULL, NULL)`,
      [run.runId, projectId, m1, m0, ceo.assignmentId, ceo.sessionId, ceo.sessionIncarnation, ceo.bindingGeneration, ceo.sessionId, ceo.sessionIncarnation],
    );
    h.cp.db.run(`UPDATE manifest_activation_grants SET consumed_at = 't', consumed_attempt_id = 'a' WHERE grant_id = 'mag_o'`);
    h.cp.close();
    const live = join(h.root, "state.sqlite");
    const v45Copy = join(tempDir("acp-v45-outcomes-"), "v45.sqlite");
    copyFileSync(live, v45Copy);
    const v44Copy = join(tempDir("acp-v45-outcomes-"), "v44.sqlite");
    copyFileSync(live, v44Copy);
    const raw44 = new Database(v44Copy);
    for (const name of V45_REPLACED_TRIGGERS) {
      raw44.exec(`DROP TRIGGER ${name}`);
      raw44.exec(v44TriggerBody(name));
    }
    raw44.close();
    const outcomes = (path: string) => {
      const raw = new Database(path);
      try {
        return [[m0, m2], [m0, m1], [m0, null], [m0, m0]].map(([from, to]) => {
          raw.exec("SAVEPOINT probe");
          try {
            raw.prepare(`UPDATE projects SET active_manifest_digest = ? WHERE project_id = ?`).run(from, projectId);
          } catch {
            // Only the starting point; a refusal to set it is itself an outcome of the guard below.
          }
          let outcome: string;
          try {
            raw.prepare(`UPDATE projects SET active_manifest_digest = ? WHERE project_id = ?`).run(to, projectId);
            outcome = "ADMITTED";
          } catch (error) {
            outcome = (error as Error).message;
          }
          raw.exec("ROLLBACK TO probe; RELEASE probe");
          return `${from === m0 ? "m0" : from}→${to === null ? "null" : to === m0 ? "m0" : to === m1 ? "m1" : "m2"}: ${outcome}`;
        });
      } finally {
        raw.close();
      }
    };
    const v44 = outcomes(v44Copy);
    expect(v44).toEqual(outcomes(v45Copy));
    expect(v44).toEqual([
      "m0→m2: MANIFEST_ACTIVATION_AUTHORITY_DENIED",
      "m0→m1: ADMITTED",
      "m0→null: MANIFEST_ACTIVATION_AUTHORITY_DENIED",
      "m0→m0: ADMITTED",
    ]);
  });

  it("M1: v44 → v45 preserves every pre-existing table byte for byte (hidden rowid included); only schema_migrations gains its row; grant, verify decision and doctor listing are unchanged", async () => {
    const h = makeHarness();
    const { projectId } = await registerFixtureProject(h, "v45-m1");
    // A confirmed v44 CONTRACT_CHANGE with its grant, and an operator NULL project with a NULL-pinned run.
    const run = await dispatchRun(h, projectId, RunKind.CONTRACT_CHANGE);
    carryContractChange(h, run.runId, stricter(run.base));
    await h.cp.continuity.evaluate("m1 fixture");
    const submitted = await h.cp.pipeline.submitResult({
      runId: run.runId,
      ownerSessionId: run.ownerSessionId,
      ownerBindingGeneration: run.ownerBindingGeneration,
      resultSummary: "the proposed manifest",
      recommendation: "activate",
      residualRisk: [],
    });
    if (!submitted.allowed) throw new Error(submitted.message);
    await h.cp.continuity.evaluate("confirm");
    const candidate = h.cp.runs.currentCandidate(run.runId)!;
    expect((await decideThroughHermes(h, { runId: run.runId, decision: "CONFIRM", candidateSnapshotDigest: candidate })).allowed).toBe(true);
    const nullProject = await operatorRegisteredProject(h, "v45-m1-null", { identity: "github:acme/null", checkoutPath: makeRepo() });
    await createRun(h, nullProject.projectId, RunKind.CONTRACT_CHANGE);
    const grant = h.cp.manifestGrants.get(run.runId)!;
    const consumer = h.cp.manifestGrants.consumerOf(run.runId);
    const decisionBefore = h.cp.manifestGrants.verify(run.runId, "PRE_MERGE", consumer);
    const doctorBefore = contractChangeRunsWithoutGrant(h.cp.db, null);
    expect(decisionBefore.allowed).toBe(true);
    h.cp.close();

    const path = toV44Image(join(h.root, "state.sqlite"));
    const before = contentDigests(path);
    expect(before.userVersion).toBe(44);
    approveMigration(path, "V45 M1 witness");
    new Db(path).close();
    const after = contentDigests(path);
    expect(after.userVersion).toBe(SCHEMA_VERSION);
    const { schema_migrations: receiptsBefore, ...restBefore } = before.tables;
    const { schema_migrations: receiptsAfter, manifest_first_activation_grants: added, ...restAfter } = after.tables;
    expect(Object.fromEntries(Object.keys(restBefore).map((name) => [name, restAfter[name]]))).toEqual(restBefore);
    expect(added).toBe(contentDigests(privateStatePathWithEmptyFirstGrants()).tables["manifest_first_activation_grants"]);
    expect(receiptsAfter).not.toBe(receiptsBefore);
    const raw = new Database(path, { readonly: true });
    try {
      const receipts = raw.prepare("SELECT version, migration_id FROM schema_migrations ORDER BY version").all() as Array<{ version: number; migration_id: string }>;
      expect(receipts.find((row) => row.version === 45)).toEqual({ version: 45, migration_id: "v45-first-manifest-activation" });
      expect(receipts.filter((row) => row.version <= 44)).toEqual([{ version: 44, migration_id: "bootstrap-v44" }]);
    } finally {
      raw.close();
    }

    const reopened = makeHarness({ root: h.root, repoPath: h.repoPath, clock: h.clock });
    expect(reopened.cp.manifestGrants.get(run.runId)).toEqual(grant);
    const decisionAfter = reopened.cp.manifestGrants.verify(run.runId, "PRE_MERGE", consumer);
    expect(decisionAfter.allowed).toBe(decisionBefore.allowed);
    expect(decisionAfter.allowed && decisionAfter.value.grant).toEqual(decisionBefore.allowed && decisionBefore.value.grant);
    expect(contractChangeRunsWithoutGrant(reopened.cp.db, null)).toEqual(doctorBefore);
    reopened.cp.close();
  });

  it("D4-a: a conflicting first-grant table planted in the image makes the step throw; the restore gives back the contaminated image, not a pristine one", () => {
    const path = privateStatePath("acp-v45-d4a-");
    new Db(path).close();
    toV44Image(path);
    const pristine = contentDigests(path);
    const raw = new Database(path);
    raw.exec("CREATE TABLE manifest_first_activation_grants (grant_id TEXT PRIMARY KEY, planted TEXT)");
    raw.exec("INSERT INTO manifest_first_activation_grants VALUES ('mfa_planted', 'x')");
    raw.close();
    const contaminated = contentDigests(path);
    expect(contaminated).not.toEqual(pristine);
    approveMigration(path, "V45 D4-a witness");
    expect(() => new Db(path)).toThrowError(/original database was restored/);
    expect(contentDigests(path)).toEqual(contaminated);
  });

  it("D4-a: an exact-shape table with a row is refused the same way", () => {
    const path = privateStatePath("acp-v45-d4a-row-");
    new Db(path).close();
    const reference = privateStatePath("acp-v45-d4a-ref-");
    new Db(reference).close();
    const tableSql = (new Database(reference, { readonly: true }).prepare("SELECT sql FROM sqlite_master WHERE name = 'manifest_first_activation_grants'").get() as { sql: string }).sql;
    toV44Image(path);
    const raw = new Database(path);
    raw.pragma("foreign_keys = OFF");
    raw.exec(tableSql);
    raw.prepare(
      `INSERT INTO manifest_first_activation_grants VALUES ('g','r','p','CONTRACT_CHANGE',1,'sha256:m','p','c','k','v',?, 'sha256:w','a','a','s','i',1,'t','d','s','i','t',NULL,NULL)`,
    ).run(JSON.stringify(revisionsFor(firstManifest("p"), "a".repeat(40))));
    raw.close();
    const contaminated = contentDigests(path);
    approveMigration(path, "V45 D4-a row witness");
    expect(() => new Db(path)).toThrowError(/original database was restored/);
    expect(contentDigests(path)).toEqual(contaminated);
  });

  it("D4-b: a throw after v45 commits restores the untouched image; the old approval no longer names it; a fresh one opens", () => {
    const path = privateStatePath("acp-v45-d4b-");
    new Db(path).close();
    toV44Image(path);
    const pristine = contentDigests(path);
    approveMigration(path, "V45 D4-b witness");
    expect(() => new Db(path, {
      afterMigration: (migration) => {
        if (migration.toVersion === 45) throw new Error("injected after v45 committed");
      },
    })).toThrowError(/original database was restored/);
    expect(contentDigests(path)).toEqual(pristine);
    expect(() => new Db(path)).toThrowError(/for a different database than the one being opened/);
    approveMigration(path, "V45 D4-b fresh approval");
    new Db(path).close();
    expect(contentDigests(path).userVersion).toBe(SCHEMA_VERSION);
  });

  it("D5-a: a process killed after v45 commits leaves v45 with its receipt, the same inode, no restore; reopening retires the approval", () => {
    const path = privateStatePath("acp-v45-d5a-");
    new Db(path).close();
    toV44Image(path);
    const before = contentDigests(path);
    const inode = statSync(path).ino;
    approveMigration(path, "V45 D5-a witness");
    const databaseModule = new URL("../../src/db/database.ts", import.meta.url).href;
    const child = boundedSpawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `const { Db } = await import(${JSON.stringify(databaseModule)});
         new Db(${JSON.stringify(path)}, { afterMigration: (m) => { if (m.toVersion === 45) process.kill(process.pid, "SIGKILL"); } });`,
      ],
      { encoding: "utf8" },
    );
    expect(child.signal).toBe("SIGKILL");
    expect(statSync(path).ino).toBe(inode);
    const killed = contentDigests(path);
    expect(killed.userVersion).toBe(45);
    const { schema_migrations: _r1, ...restBefore } = before.tables;
    const { schema_migrations: _r2, manifest_first_activation_grants: _added, ...restKilled } = killed.tables;
    expect(restKilled).toEqual(restBefore);
    expect(existsSync(migrationApprovalPath(path))).toBe(true);
    if (SCHEMA_VERSION > 45) {
      // A build with steps after v45 starts a migration here, not a same-version open: the approval
      // that named the chain from 44 does not name the one from 45, and a fresh approval does.
      expect(() => new Db(path)).toThrowError(/does not name the migration this start would perform/);
      expect(statSync(path).ino).toBe(inode);
      approveMigration(path, "V45 D5-a re-approval");
    }
    new Db(path).close();
    expect(statSync(path).ino).toBe(inode);
    expect(existsSync(migrationApprovalPath(path))).toBe(false);
    const raw = new Database(path, { readonly: true });
    try {
      expect(raw.prepare("SELECT migration_id FROM schema_migrations WHERE version = 45").pluck().get()).toBe("v45-first-manifest-activation");
    } finally {
      raw.close();
    }
  });
});

/** An empty first-grant table's content digest, from a fresh v45 database. */
const privateStatePathWithEmptyFirstGrants = (): string => {
  const path = privateStatePath("acp-v45-empty-");
  new Db(path).close();
  return path;
};
