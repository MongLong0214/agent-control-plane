import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterAll, expect, it } from "vitest";
import { Db } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { MIGRATIONS } from "../../src/db/migrations.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { releasedChainImage } from "../helpers/released-chain-image.ts";
import { privateStatePath } from "../helpers/released-v44-schema.ts";

afterAll(cleanupTempDirs);
it("v51 upgrades a released v50 image, preserves its receipt, and installs the immutable event and message-ID records", () => {
  const path = releasedChainImage(privateStatePath("acp-delivery-v50-"), 50);
  const before = new Database(path);
  const receipt = before.prepare("SELECT * FROM schema_migrations WHERE version = 50").get();
  expect(before.prepare("SELECT name FROM sqlite_schema WHERE name = 'buzz_events'").get()).toBeUndefined();
  before.close();
  approveMigration(path, "v51 recipient-delivery regression");
  const db = new Db(path);
  try {
    expect(db.get("SELECT * FROM schema_migrations WHERE version = 50")).toEqual(receipt);
    expect(db.get<{ migration_id: string }>("SELECT migration_id FROM schema_migrations WHERE version = 51")?.migration_id)
      .toBe("v51-durable-recipient-delivery");
    db.run("INSERT INTO buzz_events (event_id, payload_json) VALUES ('event', '{}')");
    expect(() => db.run("UPDATE buzz_events SET payload_json = '{\"changed\":true}'")).toThrow();
    expect(() => db.run("INSERT OR REPLACE INTO buzz_events (event_id, payload_json) VALUES ('event', '{}')")).toThrow();
    expect(() => db.run("DELETE FROM buzz_events")).toThrow();
    db.run("INSERT INTO holder_message_terminals (message_id) VALUES ('acked-message')");
    expect(() => db.run("DELETE FROM holder_message_terminals")).toThrow();
  } finally { db.close(); }
  const v50 = MIGRATIONS.find((step) => step.toVersion === 50)!;
  expect(v50.checksum()).toBe("sha256:d11a305c889c249e03b2fa480f9dada95d1bb20c427c675d6437d2a8b315c824");
  const frozen = readFileSync(new URL("../../src/db/schema-v50.sql", import.meta.url), "utf8");
  expect(frozen).not.toContain("CREATE TABLE IF NOT EXISTS buzz_events");
});

it("v51 revives expired actionable instructions and route failures while retaining explicit refusals", () => {
  const raw = new Database(":memory:");
  try {
    raw.exec(readFileSync(new URL("../../src/db/schema-v50.sql", import.meta.url), "utf8"));
    const insert = raw.prepare(`INSERT INTO outbox (message_id, idempotency_key, role_key, binding_generation,
      target_session_id, kind, payload_json, payload_digest, request_fingerprint, expires_at, created_at, status, last_error)
      VALUES (?, ?, 'CEO', 1, 'target', ?, '{}', 'digest', 'fingerprint', '2026-01-01', '2025-01-01', ?, ?)`);
    insert.run("unroutable", "key1", "CEO_NOTIFICATION", "REJECTED", "target session has no buzz address");
    insert.run("instruction", "key2", "ESCALATION_REPLY", "EXPIRED", null);
    insert.run("superseded", "key3", "CEO_NOTIFICATION", "REJECTED", "explicit refusal");
    MIGRATIONS.find((step) => step.toVersion === 51)!.apply(raw);
    expect(raw.prepare("SELECT status FROM outbox WHERE message_id = 'unroutable'").get()).toEqual({ status: "PENDING" });
    expect(raw.prepare("SELECT status FROM outbox WHERE message_id = 'instruction'").get()).toEqual({ status: "PENDING" });
    expect(raw.prepare("SELECT status FROM outbox WHERE message_id = 'superseded'").get()).toEqual({ status: "REJECTED" });
  } finally { raw.close(); }
});
