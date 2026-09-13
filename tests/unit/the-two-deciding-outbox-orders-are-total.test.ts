import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

/**
 * #858. Two of the thirteen orderings this series touched are `LIMIT` queries, and only those two
 * can answer with a *different row* when the order ties — the other eleven are `.all()` over
 * complete sets, where a tie reorders a list and omits nothing. Both are on `outbox`.
 *
 * The tie is reachable at the schema level. `message_id` is `TEXT PRIMARY KEY`, which in SQLite
 * carries no `NOT NULL`: two rows with a NULL id insert and `(created_at, message_id)` ties again.
 * That is not reachable from `src/` — every writer mints through `newMessageId()` and the column
 * is typed `string` — but "no current writer does it" is a statement about today's callers, and
 * these two queries decide which owner message is answered next.
 *
 * `idempotency_key` is the answer the existing schema already supplies: `TEXT NOT NULL` with a
 * full `UNIQUE` index. No migration, and `src/db/migrations.ts` is a frozen input this work may
 * not touch.
 *
 * These rows use raw SQL against the real DDL for the same reason the counterexample does: the
 * product's own writers cannot produce the state being excluded, so a test that goes through them
 * would be asserting the type system rather than the order.
 */
const DDL = `
CREATE TABLE outbox (
  message_id      TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX outbox_idempotency ON outbox(idempotency_key);
`;

const TIED_AT = "2026-01-01T00:00:00.000Z";

const withRows = (rows: ReadonlyArray<[string | null, string]>): DatabaseSync => {
  const db = new DatabaseSync(":memory:");
  db.exec(DDL);
  const insert = db.prepare("INSERT INTO outbox (message_id, idempotency_key, created_at) VALUES (?, ?, ?)");
  for (const [messageId, key] of rows) insert.run(messageId, key, TIED_AT);
  return db;
};

const firstBy = (db: DatabaseSync, term: string): unknown =>
  (db.prepare(`SELECT idempotency_key FROM outbox ORDER BY created_at, ${term} LIMIT 1`).get() as
    | { idempotency_key: string }
    | undefined)?.idempotency_key;

describe("the two deciding outbox orders are total", () => {
  it("ties under message_id when the schema's own permitted NULL is present", () => {
    // The counterexample, reproduced rather than described. SQLite accepts both rows: a
    // non-INTEGER PRIMARY KEY is not NOT NULL.
    const db = withRows([
      [null, "key-b"],
      [null, "key-a"],
    ]);
    const tied = db.prepare(
      "SELECT created_at, message_id, COUNT(*) AS n FROM outbox GROUP BY created_at, message_id HAVING COUNT(*) > 1",
    ).all();
    expect(tied).toHaveLength(1);
    db.close();
  });

  it("does not tie under idempotency_key, which the schema declares NOT NULL and UNIQUE", () => {
    const db = withRows([
      [null, "key-b"],
      [null, "key-a"],
    ]);
    const tied = db.prepare(
      "SELECT created_at, idempotency_key, COUNT(*) AS n FROM outbox GROUP BY created_at, idempotency_key HAVING COUNT(*) > 1",
    ).all();
    expect(tied).toHaveLength(0);
    expect(firstBy(db, "idempotency_key")).toBe("key-a");
    db.close();
  });

  it("answers the same first row whichever way the tied rows were written", () => {
    // Insertion order is what an untied `LIMIT 1` is free to follow. Both directions, so a green
    // run is not one arrangement happening to match.
    const forward = withRows([
      [null, "key-a"],
      [null, "key-b"],
    ]);
    const reverse = withRows([
      [null, "key-b"],
      [null, "key-a"],
    ]);
    expect(firstBy(forward, "idempotency_key")).toBe("key-a");
    expect(firstBy(reverse, "idempotency_key")).toBe("key-a");
    forward.close();
    reverse.close();
  });

  it("refuses a second row that would make the tiebreaker itself ambiguous", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(DDL);
    db.prepare("INSERT INTO outbox VALUES (?, ?, ?)").run("msg_1", "key-a", TIED_AT);
    expect(() =>
      db.prepare("INSERT INTO outbox VALUES (?, ?, ?)").run("msg_2", "key-a", TIED_AT),
    ).toThrowError(/UNIQUE/);
    db.close();
  });
});
