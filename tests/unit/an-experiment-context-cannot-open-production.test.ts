import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";

import { isAcpError } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Db, openDb } from "../../src/db/database.ts";
import { PRODUCTION_DATABASE_PATH, PRODUCTION_STATE_ROOT } from "../../src/db/production-paths.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * #416: `validateExperimentIsolation` was a lexical path check nothing ever consumed. `Db`'s
 * constructor is the one place in this system a SQLite handle is opened, so it is the state-
 * opening runtime the old doc comment on `experiment-isolation.ts` said V1 did not have.
 *
 * These tests put a declared experiment context in front of that constructor and require the
 * isolation decision to stop the handle from ever being created — not merely to be computed and
 * ignored.
 */
describe("an experiment context cannot open production", () => {
  it("denies opening the literal production database path", () => {
    let thrown: unknown;
    try {
      new Db(PRODUCTION_DATABASE_PATH, {
        experimentContext: { experimentId: "acp2-holdout-1", experimentArtifactRoot: tempDir("acp-experiment-artifacts-") },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    if (!isAcpError(thrown)) throw new Error("expected an AcpError denial");
    expect(thrown.reasonCode).toBe(ReasonCode.CONFLICT);
  });

  it("denies an experiment artifact root nested inside the production state root", () => {
    const databasePath = join(tempDir("acp-experiment-db-"), "experiment.sqlite");
    let thrown: unknown;
    try {
      new Db(databasePath, {
        experimentContext: {
          experimentId: "acp2-holdout-2",
          experimentArtifactRoot: join(PRODUCTION_STATE_ROOT, "experiments", "acp2-holdout-2"),
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    if (!isAcpError(thrown)) throw new Error("expected an AcpError denial");
    expect(thrown.reasonCode).toBe(ReasonCode.CONFLICT);
  });

  it("opens normally when the experiment's database and artifact root are properly separated", () => {
    const databasePath = join(tempDir("acp-experiment-db-"), "experiment.sqlite");
    const artifactRoot = tempDir("acp-experiment-artifacts-");
    const db = new Db(databasePath, {
      experimentContext: { experimentId: "acp2-holdout-3", experimentArtifactRoot: artifactRoot },
    });
    try {
      expect(db.all("SELECT 1 AS one")).toEqual([{ one: 1 }]);
    } finally {
      db.close();
    }
  });

  it("denies an experiment context that omits its artifact root, rather than comparing against nothing", () => {
    const databasePath = join(tempDir("acp-experiment-db-"), "experiment.sqlite");
    let thrown: unknown;
    try {
      new Db(databasePath, {
        // Cast past the type system: the omission this guards against is a caller that reaches
        // this constructor without the compiler in the loop (a JS caller, or a loosely typed
        // config file), not merely a TypeScript compile error.
        experimentContext: { experimentId: "acp2-holdout-4" } as unknown as {
          experimentId: string;
          experimentArtifactRoot: string;
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    if (!isAcpError(thrown)) throw new Error("expected an AcpError denial");
    expect(thrown.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
  });

  it(":memory: is permitted under an experiment context, but its artifact-root check still runs", () => {
    let thrown: unknown;
    try {
      new Db(":memory:", {
        experimentContext: {
          experimentId: "acp2-holdout-5",
          experimentArtifactRoot: join(PRODUCTION_STATE_ROOT, "experiments", "acp2-holdout-5"),
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    if (!isAcpError(thrown)) throw new Error("expected an AcpError denial");
    expect(thrown.reasonCode).toBe(ReasonCode.CONFLICT);
  });

  it(":memory: with a properly separated artifact root opens normally under an experiment context", () => {
    const db = new Db(":memory:", {
      experimentContext: { experimentId: "acp2-holdout-6", experimentArtifactRoot: tempDir("acp-experiment-artifacts-") },
    });
    try {
      expect(db.all("SELECT 1 AS one")).toEqual([{ one: 1 }]);
    } finally {
      db.close();
    }
  });

  it("opens production exactly as before when no experiment context is declared", () => {
    const databasePath = join(tempDir("acp-production-like-db-"), "state.sqlite");
    const db = openDb(databasePath);
    try {
      expect(db.all("SELECT 1 AS one")).toEqual([{ one: 1 }]);
    } finally {
      db.close();
    }
  });
});
