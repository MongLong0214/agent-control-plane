import { createRequire } from "node:module";
import { join } from "node:path";

import { Role, roleKeyFor } from "../domain/types.ts";
import { buzzMessageEventId, ownerMessagePointerOf } from "../ingress/buzz-message.ts";
import { resolveCeoBuzzIdentity } from "../session/ceo-buzz-identity.ts";
import type { QueuedBuzzMessage, SignedEvent } from "./buzz-channel.ts";

/**
 * What a CTO's channel reads from the daemon's own database, read the way the daemon reads it. The channel server holds
 * no credential to the control plane: it opens `state.sqlite` read-only and writes nothing there (what it learns of
 * delivery goes back through the receipt files).
 *
 * It also holds nothing between reads. A deploy stops the daemon and then needs zero processes holding the database, and a
 * channel server lives as long as its CTO's session, so a handle opened once and kept (the file, its -wal and its -shm)
 * blocked every deploy while any CTO had a channel. A read opens the database, runs, and closes it in a `finally`.
 */
export interface DaemonReads {
  get<T>(sql: string, params?: unknown[]): T | undefined;
  all<T>(sql: string, params?: unknown[]): T[];
}

/** A read-only handle on the daemon's database that exists for one read: whoever opens it closes it. */
export interface OpenedDaemonDb {
  readonly reads: DaemonReads;
  close(): void;
}

/** Opens the daemon's database read-only, or `null` when it cannot be opened. Injected so a test can count handles. */
export type DaemonDbOpener = (stateDir: string) => OpenedDaemonDb | null;

export const openDaemonDb: DaemonDbOpener = (stateDir) => {
  try {
    const Database = createRequire(import.meta.url)("better-sqlite3") as new (
      path: string,
      options: { readonly: boolean; fileMustExist: boolean },
    ) => { prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] }; close(): void };
    const db = new Database(join(stateDir, "state.sqlite"), { readonly: true, fileMustExist: true });
    return {
      reads: {
        get: <T>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) as T | undefined,
        all: <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
      },
      close: () => db.close(),
    };
  } catch {
    return null;
  }
};

/**
 * Runs `read` over the daemon's database opened for it alone, and closes the database again whatever the read does: its
 * answer, an error it throws (which goes on to the caller) or a close that itself fails (which is not the read's business).
 * `null` when the database cannot be opened. This is the only place the channel opens the database.
 */
export const readDaemonDb = <T>(stateDir: string, read: (db: DaemonReads) => T, open: DaemonDbOpener = openDaemonDb): T | null => {
  const opened = open(stateDir);
  if (opened === null) return null;
  try {
    return read(opened.reads);
  } finally {
    try {
      opened.close();
    } catch {
      /* a handle that will not close has nothing left to read */
    }
  }
};

/** How long the bound CEO's key is remembered, as a value in memory, before the database is asked again. */
export const CEO_KEY_CACHE_MS = 5_000;

/**
 * The bound CEO's key as of the last time it was asked, at most five seconds old, and empty (nobody is heard) when the
 * database cannot be read. The cache is the key itself; no handle is kept to refresh it.
 */
export const ceoPubkeyResolver = (
  stateDir: string,
  options: { readonly open?: DaemonDbOpener; readonly now?: () => number } = {},
): (() => readonly string[]) => {
  const now = options.now ?? Date.now;
  let askedAt = Number.NEGATIVE_INFINITY;
  let cached: readonly string[] = [];
  return () => {
    const at = now();
    if (at - askedAt < CEO_KEY_CACHE_MS) return cached;
    askedAt = at;
    try {
      return (cached = readDaemonDb(stateDir, ceoPubkeysFromDb, options.open) ?? []);
    } catch {
      return (cached = []);
    }
  };
};

/** The queue's pending messages for this project's CTO, read with the database opened for that one read. */
export const backlogReader = (stateDir: string, projectId: string, open?: DaemonDbOpener): (() => QueuedBuzzMessage[]) =>
  () => readDaemonDb(stateDir, (db) => queuedBuzzBacklog(db, projectId), open) ?? [];

/**
 * When the oldest Buzz message still queued for this project's CTO (PENDING, or SENT and never completed) was admitted, in
 * whole seconds less an hour, since its event may have been signed before the daemon admitted it; `null` when none is. The
 * channel asks for the CTO's own replies from there, so a reply posted while no channel ran still completes what it answered.
 */
export const answeredSinceReader = (stateDir: string, projectId: string, open?: DaemonDbOpener): (() => number | null) =>
  () => readDaemonDb(stateDir, (db) => {
    const oldest = db.get<{ at: string | null }>(
      `SELECT MIN(created_at) AS at FROM outbox WHERE role_key = ? AND kind IN ('PEER_MESSAGE','OWNER_MESSAGE') AND status IN ('PENDING','SENT')`,
      [roleKeyFor(Role.PRIMARY_CTO, { projectId })],
    )?.at;
    const ms = oldest ? Date.parse(oldest) : Number.NaN;
    return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000) - 3600) : null;
  }, open) ?? null;

/**
 * The bound CEO's Buzz identity, by the daemon's own rule (`resolveCeoBuzzIdentity`): the live CEO session's identity, and
 * when that session has none, the latest identified CEO binding's. Reading only the live session heard nobody on a CEO
 * whose current session was never bound to an identity, while the daemon admitted that CEO's mail by the fallback.
 */
export const ceoPubkeysFromDb = (db: DaemonReads): readonly string[] => {
  const ceo = db.get<{ session_id: string }>(
    "SELECT session_id FROM assignments WHERE role_key = ? AND status = 'ACTIVE' ORDER BY binding_generation DESC LIMIT 1",
    [roleKeyFor(Role.CEO)],
  );
  if (!ceo) return [];
  const identity = resolveCeoBuzzIdentity(db, ceo.session_id);
  return identity !== null && /^[0-9a-f]{64}$/u.test(identity) ? [identity] : [];
};

interface OutboxRow {
  payload_json: string;
}

/**
 * The Buzz messages still PENDING in the queue for this project's CTO at its current binding, oldest first, each with the
 * signed event it was admitted from (`buzz_events`). A message is left out when its event was signed before the role's
 * known history in its room (the floor the daemon refuses an older mention by: `role_room_memberships.joined_at`, rounded up
 * to the next whole second because Buzz signs whole seconds, else the binding's own creation), when no signed event is
 * retained for it, or when it is not this binding's.
 */
export const queuedBuzzBacklog = (db: DaemonReads, projectId: string): QueuedBuzzMessage[] => {
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
  const binding = db.get<{ binding_generation: number; created_at: string }>(
    "SELECT binding_generation, created_at FROM assignments WHERE role_key = ? AND status = 'ACTIVE' ORDER BY binding_generation DESC LIMIT 1",
    [roleKey],
  );
  if (!binding) return [];
  const rows = db.all<OutboxRow>(
    `SELECT payload_json FROM outbox
      WHERE role_key = ? AND kind IN ('PEER_MESSAGE','OWNER_MESSAGE') AND status = 'PENDING' AND binding_generation = ?
      ORDER BY created_at, rowid`,
    [roleKey, binding.binding_generation],
  );
  const floors = new Map<string, number>();
  const floorOf = (room: string): number => {
    const known = floors.get(room);
    if (known !== undefined) return known;
    const joined = db.get<{ joined_at: string }>(
      "SELECT joined_at FROM role_room_memberships WHERE role_key = ? AND conversation = ?",
      [roleKey, room],
    )?.joined_at ?? binding.created_at;
    const floor = Math.ceil(Date.parse(joined) / 1000);
    floors.set(room, Number.isFinite(floor) ? floor : Number.POSITIVE_INFINITY);
    return floors.get(room)!;
  };
  const out: QueuedBuzzMessage[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    let pointer: ReturnType<typeof ownerMessagePointerOf>;
    try {
      pointer = ownerMessagePointerOf(JSON.parse(row.payload_json) as unknown);
    } catch {
      continue;
    }
    if (pointer === null) continue;
    const eventId = buzzMessageEventId(pointer.sourceNonce);
    if (seen.has(eventId)) continue;
    const retained = db.get<{ payload_json: string }>("SELECT payload_json FROM buzz_events WHERE event_id = ?", [eventId]);
    if (!retained) continue;
    let event: SignedEvent;
    try {
      event = JSON.parse(retained.payload_json) as SignedEvent;
    } catch {
      continue;
    }
    const rooms = Array.isArray(event.tags) ? event.tags.filter((tag) => tag[0] === "h").map((tag) => tag[1] ?? "") : [];
    const room = rooms.length === 1 ? rooms[0]! : "";
    if (room === "" || typeof event.created_at !== "number" || event.created_at < floorOf(room)) continue;
    seen.add(eventId);
    out.push({ eventId, event });
  }
  return out;
};
