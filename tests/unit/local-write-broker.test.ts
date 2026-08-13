import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { isoPlus } from "../../src/core/clock.ts";
import { ManagedWriteGuard, WriteOperation } from "../../src/guard/managed-write-guard.ts";
import { realWorkspaceProbe } from "../../src/guard/workspace-probe.ts";
import { ClaudeCliAdapter } from "../../src/runtime/cli-adapters.ts";
import { GuardedInvocationWriteBroker } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, makeCore, makeRepo, seedRun } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const seatbeltCanApply = (): boolean =>
  process.platform === "darwin" &&
  existsSync("/usr/bin/sandbox-exec") &&
  spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)\n(allow default)", "/usr/bin/true"]).status === 0;

/** A provider stand-in which writes both inside and outside the authorised directory. */
const writeScopeProbe = (repository: string): string => {
  const binary = join(repository, "write-scope-probe.mjs");
  writeFileSync(binary, `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const allowed = join(process.cwd(), "allowed");
const outside = join(process.cwd(), "outside", "escaped.txt");
writeFileSync(join(allowed, "provider-started"), "started");
writeFileSync(join(allowed, "allowed.txt"), "authorised");
let outsideDenied = false;
try {
  writeFileSync(outside, "escaped");
} catch (error) {
  outsideDenied = error && (error.code === "EPERM" || error.code === "EACCES");
}
process.stdout.write(JSON.stringify({ outsideDenied }));
`);
  chmodSync(binary, 0o700);
  return binary;
};

describe("CP-HI-01 local runtime write broker", () => {
  it("#355 refuses an ungranted CLI write and actively denies a provider write outside its guarded target", async () => {
    const core = makeCore();
    const repository = makeRepo();
    const allowed = join(repository, "allowed");
    const outside = join(repository, "outside");
    mkdirSync(allowed);
    mkdirSync(outside);
    const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: repository });
    // The adapter receives a directory target, but the guard also observes the actual
    // checkout branch. A live claim for both resources makes this a valid managed write,
    // so a refusal below can only be the runtime target scope rather than test setup.
    core.db.run(
      `INSERT INTO resource_claims (claim_id, repository_identity, branch, run_id,
                                    owner_session_id, owner_binding_generation, acquired_at,
                                    expires_at, status)
       VALUES ('branch_claim', ?, 'dev', ?, ?, ?, ?, ?, 'HELD')`,
      [
        seeded.identity,
        seeded.runId,
        seeded.sessionId,
        seeded.generation,
        core.clock.nowIso(),
        isoPlus(core.clock.nowIso(), 3_600_000),
      ],
    );
    const guard = new ManagedWriteGuard(core.db, realWorkspaceProbe, core.audit, core.clock);
    const adapter = new ClaudeCliAdapter({
      clock: core.clock,
      capacityFile: join(repository, "capacity.json"),
      binary: writeScopeProbe(repository),
      managedWriteBroker: new GuardedInvocationWriteBroker(guard),
    });

    const withoutGrant = await adapter.invoke({
      prompt: "attempt a write without control-plane authority",
      workdir: repository,
      timeoutMs: 5_000,
      readOnly: false,
      correlationId: "local-write-without-grant",
    });
    expect(withoutGrant.ok).toBe(false);
    expect(withoutGrant.error).toBe(
      "WRITE_REQUIRES_MANAGED_RUN: writable runtime invocation lacks per-effect authorisation",
    );
    // The provider process is not even launched until the broker has admitted a live
    // guard request; a prompt cannot turn `readOnly: false` into checkout authority.
    expect(existsSync(join(allowed, "provider-started"))).toBe(false);

    const rejectedByGuard = await adapter.invoke({
      prompt: "attempt a write with a stale binding",
      workdir: repository,
      timeoutMs: 5_000,
      readOnly: false,
      correlationId: "local-write-stale-binding",
      managedWrite: {
        operation: WriteOperation.FILE_MUTATION,
        targetPath: allowed,
        repositoryIdentity: seeded.identity,
        runId: seeded.runId,
        sessionId: seeded.sessionId,
        bindingGeneration: seeded.generation + 1,
      },
    });
    expect(rejectedByGuard.ok).toBe(false);
    // A syntactically complete grant is not enough: deleting the broker's authorize call
    // launches this probe and creates provider-started before the valid grant below.
    expect(existsSync(join(allowed, "provider-started"))).toBe(false);

    const withGrant = await adapter.invoke({
      prompt: "write only inside the declared target",
      workdir: repository,
      timeoutMs: 5_000,
      readOnly: false,
      correlationId: "local-write-guarded-target",
      managedWrite: {
        operation: WriteOperation.FILE_MUTATION,
        targetPath: allowed,
        repositoryIdentity: seeded.identity,
        runId: seeded.runId,
        sessionId: seeded.sessionId,
        bindingGeneration: seeded.generation,
      },
    });

    if (!seatbeltCanApply()) {
      // No unconfined fallback is allowed. The assertion above still proves an ungranted
      // request cannot launch; the platform-specific denial is exercised where seatbelt runs.
      expect(withGrant.ok).toBe(false);
      expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
      return;
    }

    expect(withGrant.ok, JSON.stringify(withGrant)).toBe(true);
    expect(readFileSync(join(allowed, "allowed.txt"), "utf8")).toBe("authorised");
    expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
    expect(JSON.parse(withGrant.text)).toEqual({ outsideDenied: true });
    // Deleting the missing-grant branch changes its exact error above; deleting the broker
    // launches the stale-binding probe; restoring a workdir-wide profile allow creates
    // `escaped.txt`. Each change makes this test fail rather than merely weakening an audit.
  });
});
