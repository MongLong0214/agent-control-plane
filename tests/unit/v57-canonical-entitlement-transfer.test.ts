import Database from "better-sqlite3";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { Db } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { MIGRATIONS } from "../../src/db/migrations.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { releasedChainImage } from "../helpers/released-chain-image.ts";
import { privateStatePath, schemaRowsOf } from "../helpers/released-v44-schema.ts";
import { contentDigests } from "../helpers/released-v45-schema.ts";

afterAll(cleanupTempDirs);

const V57_OBJECTS = [
  "canonical_entitlement_transfers",
  "canonical_entitlement_transfers_one_pending",
  "canonical_entitlement_transfers_no_replace",
  "canonical_entitlement_transfers_supersede_only",
  "canonical_entitlement_transfers_identity_immutable",
  "canonical_entitlement_transfers_no_delete",
  "canonical_session_entitlements_no_transferred_identity",
];
const REFUSED = /CANONICAL_ENTITLEMENT_TRANSFER_IMMUTABLE/;
const AT = "2026-11-14T00:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A fresh database with two projects, each with its canonical entitlement. */
const world = () => {
  const path = join(tempDir("acp-v57-guard-"), "state.sqlite");
  new Db(path).close();
  const raw = new Database(path);
  for (const [project, n] of [["p1", 1], ["p2", 2]] as const) {
    raw.prepare(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`).run(project, project, AT);
    raw.prepare(`INSERT INTO canonical_session_entitlements (session_uuid, project_id, buzz_actor_id, buzz_address) VALUES (?, ?, ?, 'room')`)
      .run(uuid(n), project, `actor-${project}`);
  }
  const revoke = (project: string) =>
    raw.prepare(`UPDATE canonical_session_entitlements SET revoked_at = ?, revision = revision + 1 WHERE project_id = ?`).run(AT, project);
  const transfer = (id: string, project: string, from: string, to: string, overrides: Record<string, unknown> = {}) => {
    const row = {
      transfer_id: id, project_id: project, from_session_uuid: from, to_session_uuid: to,
      buzz_actor_id: `actor-${project}`, buzz_address: "room", expected_binding_generation: 1,
      requested_by: "ceo", created_at: AT, ...overrides,
    };
    const columns = Object.keys(row);
    raw.prepare(`INSERT INTO canonical_entitlement_transfers (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
      .run(...Object.values(row));
  };
  /** The claim's two writes, as the successor's self-claim makes them: the predecessor revoked, then the transfer claimed. */
  const claim = (id: string, predecessor: () => void, generation = 2) => {
    predecessor();
    raw.prepare(`UPDATE canonical_entitlement_transfers SET claimed_at = ?, claimed_binding_generation = ?, revision = revision + 1 WHERE transfer_id = ?`)
      .run(AT, generation, id);
  };
  const revokeTransfer = (id: string) =>
    raw.prepare(`UPDATE canonical_entitlement_transfers SET revoked_at = ?, revision = revision + 1 WHERE transfer_id = ?`).run(AT, id);
  const row = (id: string) => raw.prepare(`SELECT * FROM canonical_entitlement_transfers WHERE transfer_id = ?`).get(id);
  return { raw, revoke, transfer, claim, revokeTransfer, row };
};

describe("v57 — a canonical entitlement transfer table beside the immutable entitlements", () => {
  it("v56 → v57 adds exactly its objects, keeps every row, and matches a fresh v57 database", () => {
    expect(MIGRATIONS.at(-1)).toMatchObject({ id: "v57-canonical-entitlement-transfer", fromVersion: 56, toVersion: 57 });
    const path = releasedChainImage(privateStatePath("acp-v57-from-v56-"), 56);
    const v56Rows = schemaRowsOf(path);
    const before = contentDigests(path, 56);
    expect(before.userVersion).toBe(56);
    approveMigration(path, "v56 → v57 witness");
    new Db(path).close();
    const after = contentDigests(path, 56);
    expect(after.userVersion).toBe(57);
    const { schema_migrations: _receiptsBefore, ...rowsBefore } = before.tables;
    const { schema_migrations: _receiptsAfter, ...rowsAfter } = after.tables;
    expect(rowsAfter).toEqual(rowsBefore);
    expect(Object.keys(contentDigests(path).tables)).toContain("canonical_entitlement_transfers");
    const upgraded = schemaRowsOf(path);
    // Additive: every v56 object is unchanged, and the new ones are exactly v57's.
    for (const row of v56Rows) expect(upgraded).toContainEqual(row);
    const added = upgraded.filter((row) => !v56Rows.some((old) => JSON.stringify(old) === JSON.stringify(row)));
    expect(added.map((row) => row.name).filter((name) => !name.startsWith("sqlite_autoindex")).sort()).toEqual([...V57_OBJECTS].sort());
    const freshPath = join(tempDir("acp-v57-fresh-"), "state.sqlite");
    new Db(freshPath).close();
    const fresh = schemaRowsOf(freshPath);
    expect(upgraded.filter((row) => V57_OBJECTS.includes(row.name)))
      .toEqual(fresh.filter((row) => V57_OBJECTS.includes(row.name)));
    // Every object a fresh v57 holds, the migrated one holds too, and nothing else. (Older objects keep the
    // whitespace their own releases wrote; v57 rewrites none of them.)
    expect(upgraded.map((row) => `${row.type} ${row.name}`).sort()).toEqual(fresh.map((row) => `${row.type} ${row.name}`).sort());
  });

  it("a transfer is born pending from exactly its project's live holder, with its identity, to a never-entitled conversation", () => {
    const { revoke, transfer } = world();
    // Another project's holder, another Buzz actor or room, a born-claimed or born-revoked row.
    expect(() => transfer("t1", "p2", uuid(1), uuid(11), { buzz_actor_id: "actor-p1" })).toThrow(REFUSED);
    expect(() => transfer("t1", "p1", uuid(1), uuid(11), { buzz_actor_id: "actor-x" })).toThrow(REFUSED);
    expect(() => transfer("t1", "p1", uuid(1), uuid(11), { buzz_address: "other" })).toThrow(REFUSED);
    expect(() => transfer("t1", "p1", uuid(1), uuid(11), { claimed_at: AT, claimed_binding_generation: 2 })).toThrow(REFUSED);
    expect(() => transfer("t1", "p1", uuid(1), uuid(11), { revoked_at: AT })).toThrow(REFUSED);
    // A conversation entitled anywhere is never a target.
    expect(() => transfer("t1", "p1", uuid(1), uuid(2))).toThrow(REFUSED);
    // The predecessor stays unrevoked: the transfer is only pending.
    transfer("t1", "p1", uuid(1), uuid(11));
    // One pending transfer per project.
    expect(() => transfer("t2", "p1", uuid(1), uuid(12))).toThrow();
    // A revoked holder supersedes nothing.
    revoke("p2");
    expect(() => transfer("t3", "p2", uuid(2), uuid(13))).toThrow(REFUSED);
  });

  it("a claim needs its predecessor revoked first, and a chain continues from the claimed transfer only", () => {
    const { raw, revoke, transfer, claim, revokeTransfer } = world();
    transfer("t1", "p1", uuid(1), uuid(11));
    // The predecessor still holds the project: no claim.
    expect(() => claim("t1", () => undefined)).toThrow(REFUSED);
    claim("t1", () => revoke("p1"));
    // A transfer from the superseded conversation, or back to it, is refused; from the claimed one it is pending.
    expect(() => transfer("t2", "p1", uuid(1), uuid(12))).toThrow(REFUSED);
    expect(() => transfer("t2", "p1", uuid(11), uuid(1))).toThrow(REFUSED);
    transfer("t2", "p1", uuid(11), uuid(12));
    expect(() => claim("t2", () => undefined)).toThrow(REFUSED);
    claim("t2", () => revokeTransfer("t1"), 3);
    expect(raw.prepare(`SELECT transfer_id FROM canonical_entitlement_transfers WHERE claimed_at IS NOT NULL AND revoked_at IS NULL`).all())
      .toEqual([{ transfer_id: "t2" }]);
  });

  it("a cancelled transfer frees its project for another, and its conversation for a later one", () => {
    const { transfer, revokeTransfer, row } = world();
    transfer("t1", "p1", uuid(1), uuid(11));
    revokeTransfer("t1");
    expect(row("t1")).toMatchObject({ claimed_at: null, revoked_at: AT });
    transfer("t2", "p1", uuid(1), uuid(11));
  });

  it("a retired project takes no transfer", () => {
    const { raw, transfer } = world();
    raw.prepare(`INSERT INTO project_retirements (project_id, requested_at, reason) VALUES ('p1', ?, 'retired')`).run(AT);
    expect(() => transfer("t1", "p1", uuid(1), uuid(11))).toThrow(REFUSED);
  });

  it("a transfer's identity never changes, it is claimed once and revoked once, and it is never deleted", () => {
    const { raw, revoke, transfer } = world();
    transfer("t1", "p1", uuid(1), uuid(11));
    revoke("p1");
    const update = (set: string) => () => raw.prepare(`UPDATE canonical_entitlement_transfers SET ${set} WHERE transfer_id = 't1'`).run();
    // Each beside an otherwise valid claim, so only the identity clause can refuse it.
    const claim = "claimed_at = 'now', claimed_binding_generation = 2, revision = revision + 1";
    expect(update(`to_session_uuid = 'x', ${claim}`)).toThrow(REFUSED);
    expect(update(`expected_binding_generation = 9, ${claim}`)).toThrow(REFUSED);
    expect(update(`buzz_actor_id = 'actor-x', ${claim}`)).toThrow(REFUSED);
    expect(update("claimed_at = 'now'")).toThrow(REFUSED);
    expect(update("claimed_at = 'now', revision = revision + 1")).toThrow(REFUSED);
    expect(update("revision = revision + 1")).toThrow(REFUSED);
    update(claim)();
    expect(update("claimed_at = 'later', claimed_binding_generation = 3, revision = revision + 1")).toThrow(REFUSED);
    update("revoked_at = 'gone', revision = revision + 1")();
    expect(update("revoked_at = 'again', revision = revision + 1")).toThrow(REFUSED);
    expect(() => raw.prepare(`DELETE FROM canonical_entitlement_transfers`).run()).toThrow(REFUSED);
  });

  it("INSERT OR REPLACE on a raw connection, recursive triggers off, cannot rewrite a claimed transfer", () => {
    const { raw, revoke, transfer, claim, row } = world();
    expect(raw.pragma("recursive_triggers", { simple: true })).toBe(0);
    transfer("t1", "p1", uuid(1), uuid(11));
    claim("t1", () => revoke("p1"));
    const before = row("t1");
    // Shaped to pass every other guard: pending, from the claimed holder, to a fresh conversation, with its identity.
    const replace = () => raw.prepare(
      `INSERT OR REPLACE INTO canonical_entitlement_transfers (transfer_id, project_id, from_session_uuid, to_session_uuid, buzz_actor_id, buzz_address, expected_binding_generation, requested_by, created_at)
       VALUES ('t1', 'p1', ?, ?, 'actor-p1', 'room', 2, 'forger', ?)`,
    ).run(uuid(11), uuid(12), AT);
    expect(replace).toThrow(REFUSED);
    expect(row("t1")).toEqual(before);
  });

  it("an entitlement is never granted to a transferred conversation or a held Buzz actor", () => {
    const { raw, revoke, transfer, claim } = world();
    transfer("t1", "p1", uuid(1), uuid(11));
    raw.prepare(`INSERT INTO projects (project_id, name, created_at) VALUES ('p3', 'p3', ?)`).run(AT);
    const grant = (session: string, actor: string) => () =>
      raw.prepare(`INSERT INTO canonical_session_entitlements (session_uuid, project_id, buzz_actor_id, buzz_address) VALUES (?, 'p3', ?, 'room')`)
        .run(session, actor);
    // Pending: its target is already spoken for.
    expect(grant(uuid(11), "actor-p3")).toThrow(REFUSED);
    claim("t1", () => revoke("p1"));
    expect(grant(uuid(11), "actor-p3")).toThrow(REFUSED);
    expect(grant(uuid(13), "actor-p1")).toThrow(REFUSED);
    grant(uuid(13), "actor-p3")();
  });
});
