import { afterAll, describe, expect, it } from "vitest";

import { commitloreGoverned, commitloreRunMode, commitloreTaskMode } from "../../src/bootstrap/commitlore-mode.ts";
import { manifestDigest, projectManifestSchema } from "../../src/contracts/manifest.ts";
import { cleanupTempDirs, makeCore } from "../helpers/fixtures.ts";
import { fixtureManifest } from "../helpers/harness.ts";
import { seedWorkerWorld, type WorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * #1268 — CommitLore is used for every commit the control plane makes in a managed project. A manifest's
 * `commitlore.mode` once let a project opt out (`preferred`, `off`); every manifest stored in production said
 * `preferred`, so none of its runs was governed. The field is still read from old manifests and means nothing:
 * a run that pins a manifest is governed, whatever the manifest says or fails to say.
 */

afterAll(cleanupTempDirs);

/** Pins the world's run to a manifest stored as `content`, as dispatch pins a managed project's run. */
const pin = (world: WorkerWorld, content: unknown): void => {
  const manifest = projectManifestSchema.parse(fixtureManifest(world.projectId));
  const digest = manifestDigest(manifest);
  world.db.run(`INSERT INTO manifests (digest, schema_id, content_json, created_at) VALUES (?, ?, ?, ?)`, [
    digest,
    manifest.schema,
    typeof content === "string" ? content : JSON.stringify(content),
    world.clock.nowIso(),
  ]);
  world.db.run(`UPDATE runs SET pinned_manifest_digest = ? WHERE run_id = ?`, [digest, world.runId]);
};

describe("#1268: a manifest's commitlore.mode is ignored", () => {
  const stored = (mode: unknown) => ({ ...fixtureManifest("any-project"), commitlore: { mode } });

  it.each([
    ["required", stored("required")],
    ["preferred", stored("preferred")],
    ["off", stored("off")],
    ["an unsupported value", stored("sometimes")],
    ["no commitlore field (a manifest stored before the field existed)", (() => { const { commitlore: _gone, ...rest } = fixtureManifest("any-project"); return rest; })()],
    ["a manifest that cannot be read", "{not json"],
  ])("a run pinned to a manifest with %s is governed", (_name, content) => {
    const world = seedWorkerWorld(makeCore());
    pin(world, content);
    expect(commitloreRunMode(world.db, world.runId)).toBe("required");
    expect(commitloreGoverned(world.db, world.runId)).toBe(true);
    expect(commitloreTaskMode(world.db, world.runId, world.taskId)).toBe("required");
  });

  it("a run with no pinned manifest has no managed project's contract, and is not governed", () => {
    const world = seedWorkerWorld(makeCore());
    expect(commitloreRunMode(world.db, world.runId)).toBeNull();
    expect(commitloreGoverned(world.db, world.runId)).toBe(false);
  });
});
