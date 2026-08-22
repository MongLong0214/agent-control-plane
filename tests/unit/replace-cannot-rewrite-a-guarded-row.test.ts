import { afterAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { openDb } from "../../src/db/database.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * `INSERT OR REPLACE` is a delete and an insert, and the guards it walked past.
 *
 * Four of this schema's most load-bearing triggers are `BEFORE UPDATE OF <column>` — they refuse
 * an edit to a specific column and never see a REPLACE, because a REPLACE performs no UPDATE.
 * `recursive_triggers` does not help: it makes the implicit delete fire DELETE triggers, and these
 * tables have none. Measured on ACP's own connection, which sets that pragma ON:
 *
 * ```
 * UPDATE sessions SET session_secret_hash  -> refused
 * INSERT OR REPLACE INTO sessions          -> hash, incarnation, buzz actor, workdir all rewritten
 * ```
 *
 * The comment above `sessions_secret_hash_immutable` says a rewritable hash lets a local caller
 * mint itself a new credential. It was right, and the guard did not cover the statement that does
 * it. A census was supposed to find this class and could not see the `BEFORE UPDATE OF` form at
 * all — sixteen triggers were invisible to it while it printed PASS.
 */
const NOW = "2026-08-22T00:00:00.000Z";

const freshDatabase = (): string => {
  const dir = join(tempDir("acp-replace-guard-"), "state");
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  const path = join(dir, "state.sqlite");
  openDb(path).close();
  return path;
};

describe("a REPLACE cannot rewrite a row whose columns are guarded", () => {
  it("refuses to rewrite a session, which holds the credential a caller authenticates with", () => {
    const path = freshDatabase();
    const db = openDb(path);
    try {
      db.run(
        `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, buzz_actor_id,
           session_secret_hash, workdir, created_at, updated_at)
         VALUES ('s1','inc1','p','m','READY','actorA','HASH_ORIG','/w',?,?)`,
        [NOW, NOW],
      );

      // The guard that exists, doing its job.
      expect(() =>
        db.run(`UPDATE sessions SET session_secret_hash='FORGED' WHERE session_id='s1'`),
      ).toThrow();

      // The statement it never saw.
      expect(() =>
        db.run(
          `INSERT OR REPLACE INTO sessions (session_id, incarnation, provider, model, lifecycle,
             buzz_actor_id, session_secret_hash, workdir, created_at, updated_at)
           VALUES ('s1','inc_FORGED','p','m','READY','actorEVIL','HASH_FORGED','/forged',?,?)`,
          [NOW, NOW],
        ),
      ).toThrow(/SESSION_NO_REPLACE/);

      expect(
        db.get<{ session_secret_hash: string }>(
          `SELECT session_secret_hash FROM sessions WHERE session_id='s1'`,
        )!.session_secret_hash,
      ).toBe("HASH_ORIG");
    } finally {
      db.close();
    }
  });

  it("refuses on an external connection too, where recursive_triggers is off by default", () => {
    // The pragma is per-connection, and a connection ACP did not open has it off. Both paths have
    // to refuse, because the guard is the schema's and not the process's.
    const path = freshDatabase();
    const db = openDb(path);
    db.run(
      `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, buzz_actor_id,
         session_secret_hash, workdir, created_at, updated_at)
       VALUES ('s2','inc1','p','m','READY','actorA','HASH_ORIG','/w',?,?)`,
      [NOW, NOW],
    );
    db.close();

    const raw = new DatabaseSync(path);
    try {
      expect(raw.prepare("PRAGMA recursive_triggers").get()).toMatchObject({ recursive_triggers: 0 });
      expect(() =>
        raw
          .prepare(
            `INSERT OR REPLACE INTO sessions (session_id, incarnation, provider, model, lifecycle,
               buzz_actor_id, session_secret_hash, workdir, created_at, updated_at)
             VALUES ('s2','inc_FORGED','p','m','READY','actorEVIL','HASH_FORGED','/forged',?,?)`,
          )
          .run(NOW, NOW),
      ).toThrow(/SESSION_NO_REPLACE/);
    } finally {
      raw.close();
    }
  });

  it("still permits a registration to rotate, because the guard names the whole key", () => {
    // (actor_id, actor_generation) is the key, and a guard that named only the actor refused the
    // operation that registry exists to perform. A REPLACE guard naming less than the key refuses
    // legitimate inserts; naming more lets the collision through.
    const path = freshDatabase();
    const db = openDb(path);
    try {
      db.run(`INSERT INTO conversational_actors (actor_id, kind, created_at) VALUES ('a','CEO',?)`, [
        NOW,
      ]);
      db.run(
        `INSERT INTO conversational_actor_registrations
           (actor_id, actor_generation, registration_state, registered_at)
         VALUES ('a', 1, 'REGISTERED', ?)`,
        [NOW],
      );

      // Only one REGISTERED row per actor, so a rotation retires the old generation first. That
      // is the sequence the guard has to leave alone.
      db.run(
        `UPDATE conversational_actor_registrations
            SET registration_state = 'RETIRED', retired_at = ?, retired_reason = 'rotated'
          WHERE actor_id = 'a' AND actor_generation = 1`,
        [NOW],
      );
      expect(() =>
        db.run(
          `INSERT INTO conversational_actor_registrations
             (actor_id, actor_generation, registration_state, registered_at)
           VALUES ('a', 2, 'REGISTERED', ?)`,
          [NOW],
        ),
      ).not.toThrow();

      // And the collision it does have to catch: the same (actor, generation) written again.
      expect(() =>
        db.run(
          `INSERT OR REPLACE INTO conversational_actor_registrations
             (actor_id, actor_generation, registration_state, registered_at)
           VALUES ('a', 2, 'REGISTERED', ?)`,
          [NOW],
        ),
      ).toThrow(/CONVERSATIONAL_ACTOR_REGISTRATION_NO_REPLACE/);
    } finally {
      db.close();
    }
  });
});
