import type { Db } from "../db/database.ts";
import { Role, roleKeyFor } from "../domain/types.ts";

/** The live CEO identity, falling back to the latest identified CEO binding's session. */
export const resolveCeoBuzzIdentity = (db: Pick<Db, "get">, sessionId: string): string | null => {
  const live = db.get<{ buzz_actor_id: string | null }>(
    `SELECT buzz_actor_id FROM sessions WHERE session_id = ? AND lifecycle IN ('READY','DRAINING')`,
    [sessionId],
  );
  return live?.buzz_actor_id ?? db.get<{ buzz_actor_id: string }>(
    `SELECT s.buzz_actor_id FROM assignments a JOIN sessions s ON s.session_id = a.session_id
      WHERE a.role_key = ? AND s.buzz_actor_id IS NOT NULL
      ORDER BY a.binding_generation DESC LIMIT 1`,
    [roleKeyFor(Role.CEO)],
  )?.buzz_actor_id ?? null;
};
