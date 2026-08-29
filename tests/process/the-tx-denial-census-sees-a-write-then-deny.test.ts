import { describe, expect, it, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * #664 — `tx()` treats a denied `Decision` as an ordinary return value and commits it.
 * `scripts/verify-tx-denial-sites.mjs` is the check that a body writing and then denying
 * is either converted to `txDecision()` or named in that script's own EXEMPT list with a
 * reason. This is not a test of the primitive (see core-hardening.test.ts for that); it is
 * a test that the *census* can see the shape it exists to catch, and does not quietly
 * pass over a real instance of it — the same discipline this repo already holds its
 * REPLACE census to (tests/process/the-replace-census-sees-every-guard-form.test.ts).
 */
const ROOT = process.cwd();
const SCRIPT = "scripts/verify-tx-denial-sites.mjs";

/**
 * A copy of the working tree's `src/` and the census script itself, not a git clone — a
 * clone only carries committed history, and this has to measure the script and the call
 * sites as they stand right now, uncommitted included.
 */
const scratchRepo = (): string => {
  const dir = join(tempDir("acp-tx-census-"), "repo");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(join(ROOT, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(ROOT, SCRIPT), join(dir, SCRIPT));
  return dir;
};

const censusIn = (dir: string): { status: number | null; stdout: string } => {
  const done = spawnSync("node", [SCRIPT], { cwd: dir, encoding: "utf8" });
  return { status: done.status, stdout: done.stdout };
};

describe("the tx-denial census sees a plain tx() body that writes and can deny", () => {
  it("passes on the working tree as it stands", () => {
    const repo = scratchRepo();
    const done = censusIn(repo);

    expect(done.stdout).toContain("RESULT: PASS");
    expect(done.status).toBe(0);
  });

  it("fails on a new, undocumented write-then-deny tx() body", () => {
    const repo = scratchRepo();
    const path = join(repo, "src/daemon/finalizer.ts");
    const original = readFileSync(path, "utf8");
    // Inject a probe transaction with the exact shape #664 reported, using the same
    // `db` and `deny` this file already imports so the census's own patterns see it.
    const injected = `${original}
class CensusProbeDenialTrap {
  probe(db: import("../db/database.ts").Db) {
    return db.tx(() => {
      db.run("INSERT INTO census_probe_table (probe_id) VALUES ('x')");
      return deny(ReasonCode.CONFLICT, "probe");
    });
  }
}
`;
    writeFileSync(path, injected);
    const done = censusIn(repo);

    expect(done.stdout).toContain("daemon/finalizer.ts");
    expect(done.status).toBe(1);
  });

  it("fails when a converted call site regresses back to plain tx()", () => {
    const repo = scratchRepo();
    const path = join(repo, "src/session/binding-registry.ts");
    const original = readFileSync(path, "utf8");
    expect(original).toContain("this.db.txDecision(() => {");
    writeFileSync(path, original.replace("this.db.txDecision(() => {", "this.db.tx(() => {"));

    const done = censusIn(repo);

    expect(done.stdout).toContain("session/binding-registry.ts");
    expect(done.status).toBe(1);
  });

  it("fails when an EXEMPT entry names a body the census can no longer find", () => {
    // Drift the other direction: the marker in the script's own EXEMPT list stops
    // matching anything (as if the code it named had moved or been reworded), and
    // the census must say so rather than silently carrying a dead exemption forward —
    // "an exemption nothing consults is a place for the next reader to believe
    // something was decided" (this repo's own REPLACE census learned this once already).
    const repo = scratchRepo();
    const path = join(repo, SCRIPT);
    const original = readFileSync(path, "utf8");
    expect(original).toContain("UPDATE resource_claims SET status = 'EXPIRED'");
    writeFileSync(
      path,
      original.replace(
        "UPDATE resource_claims SET status = 'EXPIRED'",
        "UPDATE resource_claims SET status = 'A_MARKER_NOTHING_MATCHES'",
      ),
    );

    const done = censusIn(repo);

    expect(done.stdout).toContain("stale exemption");
    expect(done.status).toBe(1);
  });
});
