import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { Db, SCHEMA_VERSION } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { MIGRATIONS } from "../../src/db/migrations.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { releasedChainImage } from "../helpers/released-chain-image.ts";
import { privateStatePath, schemaRowsOf } from "../helpers/released-v44-schema.ts";
import { contentDigests } from "../helpers/released-v45-schema.ts";

afterAll(cleanupTempDirs);

const GUARD = "projects_active_manifest_moves_by_grant";
const DENIED = /MANIFEST_ACTIVATION_AUTHORITY_DENIED/;
const AT = "2026-10-30T00:00:00.000Z";

/** The guard's DDL as a schema file defines it, comment lines dropped. */
const guardIn = (file: string): string => {
  const text = readFileSync(new URL(`../../src/db/${file}`, import.meta.url), "utf8");
  const ddl = new RegExp(`CREATE TRIGGER IF NOT EXISTS ${GUARD}\\n[\\s\\S]*?\\nEND;`).exec(text)?.[0];
  if (!ddl) throw new Error(`${GUARD} is absent from ${file}`);
  return ddl;
};

interface Adoption {
  projectId?: unknown;
  sessionId?: unknown;
  bindingGeneration?: unknown;
  entitlementSessionUuid?: unknown;
  buzzActorId?: unknown;
}

/**
 * One fresh database and the rows the guard reads: a manifest-less project, its canonical entitlement,
 * the session holding it, a PROJECT_BOOTSTRAP run pinned to that session, the run's RUN_CREATED record
 * and its bootstrap application. Each piece can be bent to show the guard keys on it.
 */
const world = () => {
  const path = join(tempDir("acp-v56-guard-"), "state.sqlite");
  new Db(path).close();
  const raw = new Database(path);
  // The owner pin's assignment row is not what the guard reads; the fixture leaves it out.
  raw.pragma("foreign_keys = OFF");
  for (const digest of ["sha256:m1", "sha256:m2", "sha256:m3"]) {
    raw.prepare(`INSERT INTO manifests (digest, schema_id, content_json, created_at) VALUES (?, 'x', '{}', ?)`).run(digest, AT);
  }
  let n = 0;
  const idsOf = (i: number) => ({
    projectId: `project-${i}`, runId: `run-${i}`, sessionId: `ses-${i}`,
    sessionUuid: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, buzzActorId: String(i).padStart(64, "b"),
  });
  /** The identities the next `seed` will use. */
  const peek = () => idsOf(n + 1);
  const seed = (options: {
    adoption?: Adoption | boolean | null;
    evidenceKind?: string;
    entitlement?: { sessionUuid?: string; buzzActorId?: string; revoked?: boolean };
    owner?: { sessionId?: string; generation?: number };
    phase?: "RESERVED" | "WRITTEN";
    retired?: boolean;
    applicationDigest?: string;
    applicationRunCreatedOf?: string;
  } = {}) => {
    const { projectId, runId, sessionId, sessionUuid, buzzActorId } = idsOf(++n);
    raw.prepare(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`).run(projectId, projectId, AT);
    raw.prepare(`INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
      VALUES (?, 'inc', 'scripted', 'scripted', 'READY', ?, ?)`).run(sessionId, AT, AT);
    raw.prepare(`INSERT INTO canonical_session_entitlements (session_uuid, project_id, buzz_actor_id, buzz_address) VALUES (?, ?, ?, 'room')`)
      .run(options.entitlement?.sessionUuid ?? sessionUuid, projectId, options.entitlement?.buzzActorId ?? buzzActorId);
    if (options.entitlement?.revoked) {
      raw.prepare(`UPDATE canonical_session_entitlements SET revoked_at = ?, revision = revision + 1 WHERE project_id = ?`).run(AT, projectId);
    }
    raw.prepare(`INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at,
        owner_session_id, owner_binding_generation, owner_session_incarnation, owner_role_key)
      VALUES (?, 'PROJECT_BOOTSTRAP', 'STANDARD', 'NORMAL', 'QUEUED', 'boot', 'sha256:c', ?, ?, ?, 'inc', ?)`)
      .run(runId, AT, options.owner?.sessionId ?? sessionId, options.owner?.generation ?? 1, `PRIMARY_CTO:${projectId}`);
    const adoption = options.adoption === undefined
      ? { projectId, sessionId, bindingGeneration: 1, entitlementSessionUuid: sessionUuid, buzzActorId }
      : options.adoption;
    const evidence = { kind: "PROJECT_BOOTSTRAP", ...(adoption === null ? {} : { adoptCanonicalCto: adoption }) };
    raw.prepare(`INSERT INTO audit_events (at, kind, run_id, evidence_json) VALUES (?, ?, ?, ?)`)
      .run(AT, options.evidenceKind ?? "RUN_CREATED", options.applicationRunCreatedOf ?? runId, JSON.stringify(evidence));
    if (options.evidenceKind !== undefined && options.evidenceKind !== "RUN_CREATED") {
      raw.prepare(`INSERT INTO audit_events (at, kind, run_id, evidence_json) VALUES (?, 'RUN_CREATED', ?, ?)`).run(AT, runId, JSON.stringify({ kind: "PROJECT_BOOTSTRAP" }));
    }
    raw.prepare(`INSERT INTO bootstrap_applications (run_id, project_id, repository_identity, bootstrap_operation_id, plan_digest,
        manifest_digest, planned_outputs_digest, candidate_snapshot_digest, review_digest, approval_digest, phase, reserved_at)
      VALUES (?, ?, ?, 'op', 'sha256:p', ?, 'sha256:o', 'sha256:s', 'sha256:r', 'sha256:a', 'RESERVED', ?)`)
      .run(runId, projectId, `github:acme/${projectId}`, options.applicationDigest ?? "sha256:m1", AT);
    raw.prepare(`UPDATE bootstrap_applications SET attempts = 1 WHERE run_id = ?`).run(runId);
    if ((options.phase ?? "WRITTEN") === "WRITTEN") raw.prepare(`UPDATE bootstrap_applications SET phase = 'WRITTEN' WHERE run_id = ?`).run(runId);
    if (options.retired) raw.prepare(`UPDATE bootstrap_applications SET retired_at = ? WHERE run_id = ?`).run(AT, runId);
    return { projectId, runId, sessionId, sessionUuid, buzzActorId };
  };
  const move = (projectId: string, digest = "sha256:m1") => () =>
    raw.prepare(`UPDATE projects SET active_manifest_digest = ? WHERE project_id = ?`).run(digest, projectId);
  /** The control: the same world with the stored adoption intact moves its project from NULL. */
  const control = () => {
    const ok = seed();
    expect(move(ok.projectId)).not.toThrow();
    expect(raw.prepare(`SELECT active_manifest_digest AS d FROM projects WHERE project_id = ?`).get(ok.projectId)).toEqual({ d: "sha256:m1" });
  };
  return { raw, seed, peek, move, control, close: () => raw.close() };
};

describe("#1234 v56 — an adopting bootstrap's first manifest, and nothing else", () => {
  it("v55 → v56 replaces exactly the manifest-pointer guard, keeps every row, and matches a fresh v56 database", () => {
    expect(SCHEMA_VERSION).toBe(56);
    expect(MIGRATIONS.at(-1)).toMatchObject({ id: "v56-adopted-bootstrap-first-manifest", fromVersion: 55, toVersion: 56 });
    const path = releasedChainImage(privateStatePath("acp-v56-from-v55-"), 55);
    const v55Rows = schemaRowsOf(path);
    const before = contentDigests(path, 55);
    expect(before.userVersion).toBe(55);
    approveMigration(path, "v55 → v56 witness");
    new Db(path).close();
    const after = contentDigests(path, 55);
    expect(after.userVersion).toBe(56);
    const { schema_migrations: _receiptsBefore, ...rowsBefore } = before.tables;
    const { schema_migrations: _receiptsAfter, ...rowsAfter } = after.tables;
    expect(rowsAfter).toEqual(rowsBefore);
    const upgraded = schemaRowsOf(path);
    expect(upgraded.filter((row) => !v55Rows.some((old) => JSON.stringify(old) === JSON.stringify(row))).map((row) => row.name)).toEqual([GUARD]);
    expect(upgraded.map((row) => row.name).sort()).toEqual(v55Rows.map((row) => row.name).sort());
    const freshPath = join(tempDir("acp-v56-fresh-"), "state.sqlite");
    new Db(freshPath).close();
    expect(upgraded.filter((row) => row.name === GUARD)).toEqual(schemaRowsOf(freshPath).filter((row) => row.name === GUARD));
  });

  it("is v55's guard with one more clause, which applies only when the old value is NULL", () => {
    const strip = (ddl: string) => ddl.split("\n").filter((line) => !line.startsWith("--")).join("\n");
    const v55 = strip(guardIn("schema-v55.sql"));
    const v56 = strip(guardIn("schema.sql"));
    const [v55When, v55Body] = v55.split("\nBEGIN\n");
    const [v56When, v56Body] = v56.split("\nBEGIN\n");
    expect(v56Body).toBe(v55Body);
    expect(v56When!.startsWith(`${v55When}\n AND NOT (OLD.active_manifest_digest IS NULL AND EXISTS (`)).toBe(true);
    // Exactly one clause is added: the rest of the condition is the v55 text, unchanged.
    expect(v56When!.slice(v55When!.length).match(/\n AND NOT \(/g)).toHaveLength(1);
  });

  it("moves a NULL project to exactly the reserved digest, once; a non-NULL value moves as before", () => {
    const w = world();
    try {
      const a = w.seed();
      expect(w.move(a.projectId, "sha256:m2")).toThrow(DENIED);
      expect(w.move(a.projectId)).not.toThrow();
      expect(w.move(a.projectId, "sha256:m3")).toThrow(DENIED);
      expect(w.move(a.projectId, "sha256:m1")).not.toThrow(); // no change is no move
    } finally {
      w.close();
    }
  });

  it("a requester-supplied flag or a partial record never opens it", () => {
    const w = world();
    try {
      for (const adoption of [true, "yes", { projectId: "x" }] as const) {
        const flagged = w.seed({ adoption: adoption as Adoption | boolean });
        expect(w.move(flagged.projectId)).toThrow(DENIED);
      }
      const partial = w.seed({ adoption: {} });
      expect(w.move(partial.projectId)).toThrow(DENIED);
      // A full record appended after the run's creation record is not the creation record.
      const appended = w.seed({ adoption: null });
      w.raw.prepare(`INSERT INTO audit_events (at, kind, run_id, evidence_json) VALUES (?, 'RUN_CREATED', ?, ?)`).run(AT, appended.runId, JSON.stringify({
        adoptCanonicalCto: { projectId: appended.projectId, sessionId: appended.sessionId, bindingGeneration: 1, entitlementSessionUuid: appended.sessionUuid, buzzActorId: appended.buzzActorId },
      }));
      expect(w.move(appended.projectId)).toThrow(DENIED);
      for (const drop of ["sessionId", "bindingGeneration", "entitlementSessionUuid", "buzzActorId"] as const) {
        const next = w.peek();
        const full: Record<string, unknown> = { projectId: next.projectId, sessionId: next.sessionId, bindingGeneration: 1, entitlementSessionUuid: next.sessionUuid, buzzActorId: next.buzzActorId };
        delete full[drop];
        const partialRecord = w.seed({ adoption: full });
        expect(w.move(partialRecord.projectId), drop).toThrow(DENIED);
      }
      w.control();
    } finally {
      w.close();
    }
  });

  it("a WRITTEN application of a bootstrap created without the adoption is refused", () => {
    const w = world();
    try {
      const plain = w.seed({ adoption: null });
      expect(w.move(plain.projectId)).toThrow(DENIED);
      // The adoption written under any other record kind, or under another run's creation, is not the run's.
      const otherKind = w.seed({ evidenceKind: "RUN_DISPATCHED" });
      expect(w.move(otherKind.projectId)).toThrow(DENIED);
      const otherRun = w.seed({ applicationRunCreatedOf: "run-somewhere-else" });
      expect(w.move(otherRun.projectId)).toThrow(DENIED);
      w.control();
    } finally {
      w.close();
    }
  });

  it("keys on the project's live entitlement and the run's own owner pin", () => {
    const w = world();
    try {
      const otherConversation = w.seed({ entitlement: { sessionUuid: "99999999-9999-4999-8999-999999999999" } });
      expect(w.move(otherConversation.projectId)).toThrow(DENIED);
      const otherActor = w.seed({ entitlement: { buzzActorId: "c".repeat(64) } });
      expect(w.move(otherActor.projectId)).toThrow(DENIED);
      const revoked = w.seed({ entitlement: { revoked: true } });
      expect(w.move(revoked.projectId)).toThrow(DENIED);
      w.raw.prepare(`INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
        VALUES ('ses-other', 'inc', 'scripted', 'scripted', 'READY', ?, ?)`).run(AT, AT);
      const otherOwner = w.seed({ owner: { sessionId: "ses-other" } });
      expect(w.move(otherOwner.projectId)).toThrow(DENIED);
      const otherGeneration = w.seed({ owner: { generation: 2 } });
      expect(w.move(otherGeneration.projectId)).toThrow(DENIED);
      const foreignProject = w.seed({ adoption: { projectId: "project-elsewhere", sessionId: "ses-x", bindingGeneration: 1, entitlementSessionUuid: "u", buzzActorId: "b" } });
      expect(w.move(foreignProject.projectId)).toThrow(DENIED);
      w.control();
    } finally {
      w.close();
    }
  });

  it("an application not WRITTEN, retired, or reserved for another digest is refused", () => {
    const w = world();
    try {
      const reserved = w.seed({ phase: "RESERVED" });
      expect(w.move(reserved.projectId)).toThrow(DENIED);
      const retired = w.seed({ retired: true });
      expect(w.move(retired.projectId)).toThrow(DENIED);
      const otherDigest = w.seed({ applicationDigest: "sha256:m2" });
      expect(w.move(otherDigest.projectId)).toThrow(DENIED);
      w.control();
    } finally {
      w.close();
    }
  });

  describe("#1302 — the owner pin may be where the run's own takeover rows carried it, in shape, and nowhere else", () => {
    interface LinkOptions { toGeneration?: number; runId?: string; projectId?: string; roleKey?: string; sessionId?: string; evidence?: string }
    /** A CANONICAL_LIVE_RUNS_TAKEN_OVER row of `of`, shaped as the self-claim writes one; each part can be bent. */
    const link = (w: ReturnType<typeof world>, of: { runId: string; projectId: string }, from: number, fromSession: string, toSession: string, options: LinkOptions = {}) => {
      w.raw.prepare(`INSERT INTO audit_events (at, kind, run_id, project_id, session_id, role_key, evidence_json)
        VALUES (?, 'CANONICAL_LIVE_RUNS_TAKEN_OVER', ?, ?, ?, ?, ?)`).run(
        AT, options.runId ?? of.runId, options.projectId ?? of.projectId, options.sessionId ?? toSession, options.roleKey ?? `PRIMARY_CTO:${of.projectId}`,
        options.evidence ?? JSON.stringify({ fromGeneration: from, toGeneration: options.toGeneration ?? from + 1, fromSession, toSessionId: toSession }),
      );
    };
    /** A run whose pin is `owner`, adopted at generation 1 by the seeded session, with `links` written after it. */
    const pinnedAt = (w: ReturnType<typeof world>, owner: { sessionId: string; generation: number }, links: (seeded: { runId: string; projectId: string; sessionId: string }) => void = () => {}) => {
      if (owner.sessionId !== w.peek().sessionId) {
        w.raw.prepare(`INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
          SELECT ?, 'inc', 'scripted', 'scripted', 'READY', ?, ? WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE session_id = ?)`)
          .run(owner.sessionId, AT, AT, owner.sessionId);
      }
      const seeded = w.seed({ owner });
      links(seeded);
      return seeded;
    };

    it("a direct UPDATE with a hand-moved pin, and no takeover rows, is aborted", () => {
      const w = world();
      try {
        const sameSession = pinnedAt(w, { sessionId: w.peek().sessionId, generation: 2 });
        expect(w.move(sameSession.projectId)).toThrow(DENIED);
        const otherSession = pinnedAt(w, { sessionId: "ses-moved", generation: 2 });
        expect(w.move(otherSession.projectId)).toThrow(DENIED);
        w.control();
      } finally {
        w.close();
      }
    });

    it("admits the pin a contiguous chain of the run's takeover rows reaches, through one restart or two", () => {
      const w = world();
      try {
        const once = pinnedAt(w, { sessionId: "ses-b", generation: 2 }, (r) => link(w, r, 1, r.sessionId, "ses-b"));
        expect(w.move(once.projectId)).not.toThrow();
        const twice = pinnedAt(w, { sessionId: "ses-c", generation: 3 }, (r) => {
          link(w, r, 1, r.sessionId, "ses-b");
          link(w, r, 2, "ses-b", "ses-c");
        });
        expect(w.move(twice.projectId)).not.toThrow();
        // A row of no link's shape (unreadable evidence) is not a link, and does not break the chain.
        const noise = pinnedAt(w, { sessionId: "ses-b", generation: 2 }, (r) => {
          link(w, r, 1, r.sessionId, "ses-b", { evidence: "not json" });
          link(w, r, 1, r.sessionId, "ses-b");
        });
        expect(w.move(noise.projectId)).not.toThrow();
      } finally {
        w.close();
      }
    });

    it("refuses every chain out of shape: a lone row, a gap, a skip, a broken hop, a wrong first or last session, a duplicate, the wrong order", () => {
      const w = world();
      try {
        const cases: Array<[string, { sessionId: string; generation: number }, (r: { runId: string; projectId: string; sessionId: string }) => void]> = [
          ["a row that does not reach the pin", { sessionId: "ses-c", generation: 2 }, (r) => link(w, r, 1, r.sessionId, "ses-b")],
          ["a gap at the last generation", { sessionId: "ses-c", generation: 3 }, (r) => link(w, r, 1, r.sessionId, "ses-b")],
          ["a gap at the first generation", { sessionId: "ses-c", generation: 3 }, (r) => link(w, r, 2, "ses-b", "ses-c")],
          ["a row that skips a generation", { sessionId: "ses-c", generation: 3 }, (r) => link(w, r, 1, r.sessionId, "ses-c", { toGeneration: 3 })],
          ["a hop that leaves another session than the last one reached", { sessionId: "ses-c", generation: 3 }, (r) => {
            link(w, r, 1, r.sessionId, "ses-b");
            link(w, r, 2, "ses-x", "ses-c");
          }],
          ["a first hop from another session than the record's", { sessionId: "ses-b", generation: 2 }, (r) => link(w, r, 1, "ses-x", "ses-b")],
          ["two rows for one generation", { sessionId: "ses-b", generation: 2 }, (r) => {
            link(w, r, 1, r.sessionId, "ses-b");
            link(w, r, 1, r.sessionId, "ses-b");
          }],
          ["the links out of event order", { sessionId: "ses-c", generation: 3 }, (r) => {
            link(w, r, 2, "ses-b", "ses-c");
            link(w, r, 1, r.sessionId, "ses-b");
          }],
          ["a row whose to-session is not its own session", { sessionId: "ses-b", generation: 2 }, (r) => link(w, r, 1, r.sessionId, "ses-b", { sessionId: "ses-x" })],
          ["another run's row", { sessionId: "ses-b", generation: 2 }, (r) => link(w, r, 1, r.sessionId, "ses-b", { runId: "run-elsewhere" })],
          ["another project's row", { sessionId: "ses-b", generation: 2 }, (r) => link(w, r, 1, r.sessionId, "ses-b", { projectId: "project-elsewhere" })],
          ["another role's row", { sessionId: "ses-b", generation: 2 }, (r) => link(w, r, 1, r.sessionId, "ses-b", { roleKey: "PRIMARY_CTO:project-elsewhere" })],
          ["only an unreadable row", { sessionId: "ses-b", generation: 2 }, (r) => link(w, r, 1, r.sessionId, "ses-b", { evidence: "not json" })],
        ];
        for (const [name, owner, links] of cases) {
          const refused = pinnedAt(w, owner, links);
          expect(w.move(refused.projectId), name).toThrow(DENIED);
        }
        // A chain in shape under a pin that is not the project's PRIMARY_CTO.
        const relabelled = pinnedAt(w, { sessionId: "ses-b", generation: 2 }, (r) => link(w, r, 1, r.sessionId, "ses-b"));
        w.raw.prepare(`UPDATE runs SET owner_role_key = 'BOOTSTRAP_CTO:x' WHERE run_id = ?`).run(relabelled.runId);
        expect(w.move(relabelled.projectId)).toThrow(DENIED);
        w.control();
      } finally {
        w.close();
      }
    });
  });
});
