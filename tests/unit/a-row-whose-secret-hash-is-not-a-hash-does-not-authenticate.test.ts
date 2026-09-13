import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { SessionLifecycle } from "../../src/domain/types.ts";
import { cleanupTempDirs, makeCore } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * #833. `SessionRegistry.verifySecret` decides who may speak as a session, and two of its
 * operands guard the *shape* of the stored hash rather than its value:
 *
 *     const validStoredHash =
 *       typeof row.session_secret_hash === "string" && SESSION_SECRET_HASH.test(row.session_secret_hash);
 *
 * Neither had a witness. `trusted-core.test.ts` covers the immutability trigger — it asserts that
 * an *UPDATE* to null or to a wrong hash is refused — which is a statement about the database, not
 * about what `verifySecret` does when it reads such a row. The two are different claims, and the
 * trigger does not close the gap: its `WHEN OLD.session_secret_hash IS NOT NULL` clause means a
 * row that is *already* null is outside it, and a raw INSERT never enters it at all.
 *
 * A row like that is reachable in production, which is why these are rows and not reasons: the
 * `session_secret_hash` column was added by migration, so every session that existed before it ran
 * has NULL there, and `secretStorageAvailable()` becomes true for the whole table at once.
 *
 * Both cases assert the same refusal for different reasons, and that is deliberate: the point is
 * that a malformed hash is refused *as an authentication failure* rather than crashing
 * `Buffer.from(..., "hex")` or reaching `timingSafeEqual` with a short buffer.
 */
describe("a stored secret hash that is not a hash refuses authentication rather than throwing (#833)", () => {
  const insertPreMigrationRow = (
    db: ReturnType<typeof makeCore>["db"],
    sessionId: string,
    hash: string | null,
  ): void => {
    db.run(
      `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle,
                             created_at, updated_at, session_secret_hash)
       VALUES (?, ?, 'claude', 'fixture', ?, ?, ?, ?)`,
      [sessionId, `${sessionId}-inc`, SessionLifecycle.READY,
        "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", hash],
    );
  };

  it("refuses a row whose hash is NULL, the shape a pre-migration session has", () => {
    const { db, sessions } = makeCore();
    // A live session first, so `secretStorageAvailable()` is true and `verifySecret` reaches the
    // row read instead of refusing on storage. Without this the case would pass for the wrong
    // reason — SESSION_SECRET_STORAGE_UNAVAILABLE is a different refusal.
    const live = sessions.create({ provider: "claude", model: "fixture" });
    expect(sessions.verifySecret(live.sessionId, live.sessionSecret!).allowed).toBe(true);

    insertPreMigrationRow(db, "ses_null_hash_row", null);

    expect(sessions.verifySecret("ses_null_hash_row", live.sessionSecret!)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.SESSION_SECRET_INVALID,
    });
  });

  it("refuses a row whose hash is a string but not a hash", () => {
    const { db, sessions } = makeCore();
    const live = sessions.create({ provider: "claude", model: "fixture" });
    expect(sessions.verifySecret(live.sessionId, live.sessionSecret!).allowed).toBe(true);

    // Not hex, and not the right length: `Buffer.from("not-a-hash", "hex")` returns a short
    // buffer rather than throwing, and `timingSafeEqual` throws on a length mismatch. The shape
    // check is what keeps that from being an exception on an authentication path.
    insertPreMigrationRow(db, "ses_garbage_hash_row", "not-a-hash");

    expect(sessions.verifySecret("ses_garbage_hash_row", live.sessionSecret!)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.SESSION_SECRET_INVALID,
    });
  });
});
