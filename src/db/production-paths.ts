import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The production state root every deployment falls back to when nothing overrides it.
 *
 * Before #416 this was computed independently in three places — `defaultConfig()`'s `root`
 * parameter default (`src/app/control-plane.ts`), `defaultDatabasePath()`
 * (`src/db/state-admin.ts`), and nowhere else that read production's own database path. None of
 * this repository's production entry points (`agentctl`, `agentcpd`, `agentcpd-state`) ever
 * supplies an override, so all three read the same directory in practice; this module makes that
 * a fact of the code rather than three literals that could drift apart.
 *
 * `Db`'s constructor imports `PRODUCTION_DATABASE_PATH`/`PRODUCTION_STATE_ROOT` from here to
 * resolve production's coordinates for an experiment-isolation check on its own, rather than
 * accepting them as a caller-supplied argument that a caller opening an experiment could omit or
 * misstate.
 */
export const PRODUCTION_STATE_ROOT = join(homedir(), ".agent-control-plane");

/** The database file every production deployment opens by default. */
export const PRODUCTION_DATABASE_PATH = join(PRODUCTION_STATE_ROOT, "state.sqlite");
